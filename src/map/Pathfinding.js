/**
 * Pathfinding.js — A* over the adventure map with movement-point costs.
 *
 * Cost model (see docs/GAME_RULES.md):
 *   straight step = 100 * terrainMult, diagonal = 141 * terrainMult
 *   terrainMult   = TERRAIN_COST[terrain], reduced toward 1.0 by the
 *                   Pathfinding skill and ignored entirely on the hero
 *                   faction's native terrain.
 *
 * Tiles are blocked by: water, obstacles, monsters (their tile is only
 * enterable as the *destination*, which triggers combat), enemy heroes and
 * towns (also enterable only as destination). Fog: the player can only path
 * through explored tiles.
 */

import { CONFIG } from '../config.js';
import { FACTIONS } from '../data/factions.js';
import { skillValue } from '../data/skills.js';
import { tileAt, heroAt, levelObjects, levelMap, playerHasKey } from '../core/GameState.js';
import { seasonTerrainMult } from '../core/seasons.js';
import { isExplored } from './fog.js';

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Effective multiplier for a hero stepping onto a terrain type. */
export function terrainMultFor(hero, terrain) {
  const native = FACTIONS[hero.faction]?.nativeTerrain;
  // On its faction's home terrain a hero gets a small speed bonus (a multiplier
  // BELOW 1.0), symmetric across factions — see CONFIG.NATIVE_TERRAIN_MULT.
  if (terrain === native) return CONFIG.NATIVE_TERRAIN_MULT;
  const raw = CONFIG.TERRAIN_COST[terrain] ?? 1.0;
  const penalty = Math.max(0, raw - 1.0);
  const reduction = skillValue(hero, 'pathfinding') || 0;
  return 1.0 + penalty * (1 - reduction);
}

/** The cheapest step multiplier any tile can offer (a cobbled road, or a home-
 *  terrain bonus if that's ever set lower), for the admissible A* heuristic. */
export const MIN_STEP_MULT = Math.min(1, CONFIG.NATIVE_TERRAIN_MULT, ...Object.values(CONFIG.ROAD_COST));

/** MP cost for one step from (x0,y0) to adjacent (x1,y1), on the hero's level. */
export function stepCost(state, hero, x0, y0, x1, y1) {
  const t = tileAt(state, x1, y1, hero.z ?? 0);
  const diagonal = x0 !== x1 && y0 !== y1;
  const base = diagonal ? CONFIG.MOVE_COST_DIAGONAL : CONFIG.MOVE_COST_STRAIGHT;
  // A road on the destination tile OVERRIDES the terrain penalty (a road across
  // swamp is still fast) and applies its own discount; otherwise the terrain
  // multiplier (native bonus / rough penalty, reduced by Pathfinding) stands,
  // scaled by the SEASON (winter snow slows off-road land; roads stay plowed).
  const mult = t.road
    ? (CONFIG.ROAD_COST[t.road] ?? 1.0)
    : terrainMultFor(hero, t.terrain) * seasonTerrainMult(state.day, t.terrain);
  return Math.round(base * mult);
}

/**
 * First monster adjacent to (x,y) on `level` — monsters project a HoMM3-style
 * zone of control over their 8 neighbors: you cannot slip past a guard, and
 * entering its zone means battle (see actions.stepHero).
 */
export function monsterNear(state, x, y, exemptId = null, level = 0) {
  // Indexed straight off the level's tile array rather than through tileAt():
  // this runs for every tile A* touches and for every tile of every AI
  // reachability flood, so nine bounds-checked accessor calls per probe (each
  // re-resolving the level's map and object dictionary) was the single hottest
  // line in the whole engine. Same eight neighbours, same answer.
  const m = levelMap(state, level);
  if (!m) return null;
  const { w, h } = state.map;
  const tiles = m.tiles, objects = m.objects;
  const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
  const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
  for (let ny = y0; ny <= y1; ny++) {
    const row = ny * w;
    for (let nx = x0; nx <= x1; nx++) {
      if (nx === x && ny === y) continue;
      const t = tiles[row + nx];
      if (!t || !t.objectId) continue;
      const obj = objects[t.objectId];
      if (obj && obj.type === 'monster' && obj.id !== exemptId) return obj;
    }
  }
  return null;
}

/**
 * Occupancy masks for one bulk pathing run: which tiles hold a hero, and which
 * sit inside a monster's zone of control (its 8 neighbors, `exemptMonsterId`'s
 * excluded — the same exemption findPath grants a path whose destination IS
 * that monster).
 *
 * WHY THIS EXISTS: isWalkable answers "is anyone standing here / is this a
 * guard's zone" by scanning — every hero in the world, then nine tiles around
 * the probe. Asked once, that is nothing. Asked the way A* and the AI's
 * reachability floods ask it — once per tile of an 88×72 map, ~180 floods per
 * AI turn late-game — those two scans were 44% of the ENTIRE engine cost of a
 * computer turn (26.1s of heroAt + a comparable share of monsterNear inside
 * isWalkable's 13.6s, out of 89.7s profiled over 120 turns; see the CPU
 * profile behind docs/PROGRESS.md's AI-turn-freeze entry). The answers never
 * change during one search — nothing moves while A* or a flood runs — so both
 * scans can be done ONCE, up front, in O(heroes + 9·monsters), and every probe
 * becomes two array reads.
 *
 * Strictly an accelerator: isWalkable with a context returns bit-for-bit what
 * it returns without one (guaranteed by tests/ai-slicing.test.js), because the
 * callers only ever consume monsterNear/heroAt as booleans. Build one per
 * search and drop it; a context held across a mutation is a stale cache.
 */
export function makeWalkContext(state, level = 0, exemptMonsterId = null) {
  const { w, h } = state.map;
  const heroOcc = new Uint8Array(w * h);
  const heroes = state.heroes;
  for (const id in heroes) {
    const hh = heroes[id];
    if ((hh.z ?? 0) === level && hh.x >= 0 && hh.y >= 0 && hh.x < w && hh.y < h) {
      heroOcc[hh.y * w + hh.x] = 1;
    }
  }
  const zoc = new Uint8Array(w * h);
  const objects = levelObjects(state, level);
  for (const oid in objects) {
    const o = objects[oid];
    if (!o || o.type !== 'monster' || o.id === exemptMonsterId) continue;
    // Stamp the 8 neighbors — exactly the tiles for which monsterNear() would
    // report this monster (it skips the probe tile itself, so a monster's own
    // square carries no self-ZoC; neither does the stamp).
    const y0 = o.y > 0 ? o.y - 1 : 0, y1 = o.y < h - 1 ? o.y + 1 : h - 1;
    const x0 = o.x > 0 ? o.x - 1 : 0, x1 = o.x < w - 1 ? o.x + 1 : w - 1;
    for (let ny = y0; ny <= y1; ny++) {
      for (let nx = x0; nx <= x1; nx++) {
        if (nx === o.x && ny === o.y) continue;
        zoc[ny * w + nx] = 1;
      }
    }
  }
  return { level, exemptMonsterId, heroOcc, zoc };
}

/**
 * Is (x,y) passable for pathing *through* (not as destination)?
 * `forPlayer` limits pathing to explored tiles for that player (-1 = omniscient).
 * `exemptMonsterId` ignores one monster's zone of control (used when the
 * path's destination IS that monster, so you can walk up to attack it).
 * `level` selects the map level (0 = surface, 1 = underground).
 * `keyOwner` resolves Border-Guard keys — it defaults to `forPlayer`, but the
 * AI paths fog-omniscient (`forPlayer = -1`) while still OWNING keys, so it
 * passes its real player index here (otherwise every guard is a permanent
 * wall to the AI and the whole Keymaster subsystem is human-only content).
 * `ctx` (optional) is a makeWalkContext() for this same level/exemption: bulk
 * callers (A*, the AI's floods) pass one so the hero/zone-of-control checks
 * are O(1) lookups instead of per-probe scans. Single probes omit it.
 */
export function isWalkable(state, x, y, forPlayer = -1, exemptMonsterId = null, move = false, level = 0, keyOwner = forPlayer, ctx = null) {
  const t = tileAt(state, x, y, level);
  if (!t) return false;
  // `move` is a boolean (legacy: false = foot, true = boat) OR a travel-mode
  // object { boat | waterWalk | fly } for the adventure spells. Fly crosses
  // obstacles; Water Walk / Fly also stride over water; a boat sails water only.
  const boat = move === true || (move && move.boat);
  const fly = !!(move && move.fly);
  const waterWalk = !!(move && move.waterWalk);
  if (t.obstacle && !fly) return false;
  const water = t.terrain === 'water';
  if (boat) { if (!water) return false; }        // aboard: water only, never land
  else if (water && !waterWalk && !fly) return false; // on foot: land only
  if (forPlayer >= 0 && !isExplored(state, forPlayer, x, y, level)) return false;
  if (t.objectId) {
    const obj = levelObjects(state, level)[t.objectId];
    // Monsters and towns block through-traffic; so do portals, subterranean
    // gates and whirlpools — you may end a move on one (to teleport/descend/
    // be swept away) but auto-pathing never routes *through* one, which also
    // keeps the AI from ever stepping onto (and teleporting via) a portal,
    // gate or whirlpool it didn't intend to. Boats block through-traffic too
    // (you board one as a destination). Pickups/mines stay walkable.
    if (obj && (obj.type === 'monster' || obj.type === 'town' || obj.type === 'portal' || obj.type === 'monolith' || obj.type === 'subGate' || obj.type === 'whirlpool' || obj.type === 'boat')) return false;
    // A Border Guard is a wall to a player without the matching key, and an open
    // doorway to one who holds it — so pathing routes THROUGH it only once the
    // Keymaster Tent has been visited. Keys resolve against `keyOwner` (see above).
    if (obj && obj.type === 'borderGuard' && !playerHasKey(state, keyOwner, obj.color)) return false;
    // An un-looted Creature Bank blocks through-traffic (you reach it only as a
    // deliberate attack target); a looted one is an inert ruin you can walk over.
    if (obj && obj.type === 'creatureBank' && !obj.looted) return false;
    // A GUARDED Pandora's Box blocks the same way; an unguarded (or looted) box
    // is walkable — you step onto it to open it, like a chest.
    if (obj && obj.type === 'pandora' && !obj.looted && obj.guards && obj.guards.length) return false;
  }
  // Guard zones of control block through-traffic too; so does a hero standing
  // on the tile. With a context both are single array reads (see
  // makeWalkContext); without one, the original scans.
  if (ctx) {
    const i = y * state.map.w + x;
    if (ctx.zoc[i]) return false;
    if (ctx.heroOcc[i]) return false;
  } else {
    if (monsterNear(state, x, y, exemptMonsterId, level)) return false;
    if (heroAt(state, x, y, level)) return false;
  }
  return true;
}

/** May the hero *end* a move on (x,y)? (also true for interaction targets) */
export function isEnterable(state, x, y, forPlayer = -1, move = false, level = 0) {
  const t = tileAt(state, x, y, level);
  if (!t) return false;
  if (t.obstacle) return false; // even flying, you LAND on clear ground
  if (forPlayer >= 0 && !isExplored(state, forPlayer, x, y, level)) return false;
  const boat = move === true || (move && move.boat);
  if (boat) return true; // aboard: sail onto water, or disembark onto land
  // On foot — INCLUDING Fly / Water Walk: those spells stride ACROSS water as
  // through-traffic (see isWalkable), but may only END a move where a plain foot
  // hero could — on clear land, or a water tile to board a waiting boat / strike
  // an enemy boat hero. A strider therefore never STOPS on open water: if the
  // far shore is out of movement reach this turn it halts at the water's edge on
  // land (executeMove / AIPlayer look ahead before entering the water) and
  // crosses once its movement range is large enough to clear the whole span.
  if (t.terrain === 'water') {
    const o = t.objectId ? levelObjects(state, level)[t.objectId] : null;
    if (o && o.type === 'boat') return true;
    return !!heroAt(state, x, y, level);
  }
  return true;
}

/**
 * A* from (sx,sy) to (tx,ty) for `hero`.
 * Returns { path: [{x, y, cost}], totalCost } — path EXCLUDES the start tile —
 * or null if unreachable. Costs are per-step MP amounts.
 */
export function findPath(state, hero, tx, ty, forPlayer = hero.owner) {
  const { w, h } = state.map;
  const onBoat = !!hero.onBoat;
  // Travel mode: Fly and Water Walk (adventure spells) override the boat/foot
  // terrain rules for THIS hero; otherwise it's the plain onBoat boolean, so a
  // hero with neither flag paths exactly as before.
  const move = hero.flying ? { fly: true } : hero.waterWalk ? { waterWalk: true } : onBoat;
  // A hero paths strictly within its OWN level (like the onBoat movement
  // mode); crossing levels happens only by stepping onto a subterranean gate.
  const level = hero.z ?? 0;
  // Border-Guard keys always belong to the hero's OWNER, even when the caller
  // paths fog-omniscient (forPlayer = -1, the AI's mode).
  const keyOwner = hero.owner ?? forPlayer;
  const sx = hero.x, sy = hero.y;
  if (sx === tx && sy === ty) return null;
  if (!isEnterable(state, tx, ty, forPlayer, move, level)) return null;

  // Attacking a guard: its own zone of control must not block the approach.
  const targetTile = tileAt(state, tx, ty, level);
  const targetObj = targetTile?.objectId ? levelObjects(state, level)[targetTile.objectId] : null;
  const exempt = targetObj?.type === 'monster' ? targetObj.id : null;
  // Boarding a boat on foot is the reverse of a disembark, which could have
  // landed diagonally onto a 1-tile island (water between-tiles are passable
  // while aboard). Foot corner-cutting would then strand the hero, unable to
  // reach the boat diagonally across two water corners — so exempt the final
  // step onto the boat from that rule.
  const boardingBoat = !onBoat && targetObj?.type === 'boat';

  const idx = (x, y) => y * w + x;

  // One occupancy context for the whole search (both astar passes below —
  // nothing moves between them). Turns the per-probe hero scan and 9-tile
  // zone-of-control scan into two array reads; answers are identical.
  const wctx = makeWalkContext(state, level, exempt);

  // Octile-distance heuristic. Its constants are derived from the movement-cost
  // config (not hardcoded) so it stays admissible — never exceeding the true
  // minimum cost — if those costs are retuned. The cheapest straight step is
  // MOVE_COST_STRAIGHT × MIN_STEP_MULT (a cobbled road is the cheapest tile any
  // step can land on), and each of the min(dx,dy) diagonal steps adds
  // (MOVE_COST_DIAGONAL - MOVE_COST_STRAIGHT) over a straight one.
  const H_STRAIGHT = CONFIG.MOVE_COST_STRAIGHT * MIN_STEP_MULT;
  const H_DIAG_EXTRA = (CONFIG.MOVE_COST_DIAGONAL - CONFIG.MOVE_COST_STRAIGHT) / CONFIG.MOVE_COST_STRAIGHT;
  const heurist = (x, y) => {
    const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
    return (Math.max(dx, dy) + H_DIAG_EXTRA * Math.min(dx, dy)) * H_STRAIGHT;
  };

  // Front-gate rule: a hero ON FOOT (not flying, not aboard a boat) may only
  // step INTO a town from the row of tiles in front of its gate — the town
  // sprite faces south, so its entrance is approached from below — which forces
  // an approach from the sides or behind to walk AROUND to the front. Flying
  // heroes (Fly spell / winged boots set hero.flying) and boat heroes (a coastal
  // assault straight off the water) are exempt. If none of the front tiles are
  // passable for this hero (a town hemmed against water or the map edge), the
  // gate is dropped (gate stays null) so a town is never made unreachable.
  let gate = null;
  if (targetObj?.type === 'town' && !hero.flying && !onBoat) {
    const fronts = [[tx - 1, ty + 1], [tx, ty + 1], [tx + 1, ty + 1]]
      // A front tile qualifies if the hero could stand on it — or is already
      // standing on it (its own start reads as "occupied" to isWalkable, so
      // exempt it, else a hero on the front couldn't step straight into the gate).
      .filter(([fx, fy]) => fx >= 0 && fy >= 0 && fx < w && fy < h
        && ((fx === sx && fy === sy) || isWalkable(state, fx, fy, forPlayer, exempt, move, level, keyOwner, wctx)));
    if (fronts.length) gate = new Set(fronts.map(([fx, fy]) => idx(fx, fy)));
  }

  // One A* run. `gateFrom` (a Set of tile indices, or null) restricts which
  // tiles the FINAL step into the target may come from — used for the town
  // front-gate above; null everywhere else preserves the original search.
  const astar = (gateFrom) => {
    const gScore = new Float64Array(w * h).fill(Infinity);
    const cameFrom = new Int32Array(w * h).fill(-1);
    const closed = new Uint8Array(w * h);
    gScore[idx(sx, sy)] = 0;

    // Walkability is fixed for the whole run (`forPlayer`, `exempt`, `move`,
    // `level` and `keyOwner` are all constants here), and each tile is asked
    // about up to three times — once as a neighbour, twice more as a corner a
    // diagonal step would cut past. Memoize it, exactly as the AI's flood
    // already does: 0 unknown, 1 walkable, 2 blocked.
    const walkMemo = new Uint8Array(w * h);
    const walk = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      const i = idx(x, y);
      if (walkMemo[i] === 0) {
        walkMemo[i] = isWalkable(state, x, y, forPlayer, exempt, move, level, keyOwner, wctx) ? 1 : 2;
      }
      return walkMemo[i] === 1;
    };

    // Binary min-heap of open nodes, ordered by f and then by insertion order
    // (seq). The seq tiebreaker reproduces the old linear scan's behaviour of
    // picking the earliest-inserted node among equal f, so when several paths
    // tie on cost the identical route is reconstructed as before. Stale entries
    // (a node re-pushed at a lower f after relaxation) are simply skipped via the
    // `closed` set when they surface — no in-place decrease-key needed.
    const heap = [];
    let seq = 0;
    const less = (a, b) => a.f < b.f || (a.f === b.f && a.seq < b.seq);
    const heapPush = (node) => {
      node.seq = seq++;
      heap.push(node);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[i], heap[p])) break;
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      }
    };
    const heapPop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        const n = heap.length;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < n && less(heap[l], heap[m])) m = l;
          if (r < n && less(heap[r], heap[m])) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      return top;
    };

    heapPush({ x: sx, y: sy, f: 0 });

    while (heap.length) {
      // Pop the lowest-f node (ties broken by insertion order — see heap above).
      const cur = heapPop();
      const ci = idx(cur.x, cur.y);
      if (closed[ci]) continue;
      closed[ci] = 1;

      if (cur.x === tx && cur.y === ty) {
        // Reconstruct.
        const path = [];
        let i = ci;
        while (i !== idx(sx, sy)) {
          const x = i % w, y = (i / w) | 0;
          path.push({ x, y });
          i = cameFrom[i];
        }
        path.reverse();
        // Attach per-step costs.
        let px = sx, py = sy, total = 0;
        for (const step of path) {
          step.cost = stepCost(state, hero, px, py, step.x, step.y);
          total += step.cost;
          px = step.x; py = step.y;
        }
        return { path, totalCost: total };
      }

      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = idx(nx, ny);
        if (closed[ni]) continue;
        const isTarget = nx === tx && ny === ty;
        // The final step into a front-gated town must come from a front tile.
        if (isTarget && gateFrom && !gateFrom.has(ci)) continue;
        // Intermediate tiles must be fully walkable; the target only enterable.
        if (isTarget ? !isEnterable(state, nx, ny, forPlayer, move, level) : !walk(nx, ny)) continue;
        // No cutting corners diagonally past blocked tiles — except the last step
        // onto a boat (see boardingBoat above), so an island hero can re-embark.
        if (dx !== 0 && dy !== 0 && !(isTarget && boardingBoat)) {
          if (!walk(cur.x + dx, cur.y) && !walk(cur.x, cur.y + dy)) continue;
        }
        const g = gScore[ci] + stepCost(state, hero, cur.x, cur.y, nx, ny);
        if (g < gScore[ni]) {
          gScore[ni] = g;
          cameFrom[ni] = ci;
          heapPush({ x: nx, y: ny, f: g + heurist(nx, ny) });
        }
      }
    }
    return null;
  };

  // Front-gated search first; if the front is walkable but unreachable this turn,
  // fall back to an unconstrained search so the town is never made unreachable.
  let res = astar(gate);
  if (!res && gate) res = astar(null);
  return res;
}
