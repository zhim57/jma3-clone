/**
 * MapGenerator.js — Seeded scenario generator.
 *
 * Layout contract (deterministic per seed AND size):
 *   - Player 0's zone (bottom-left) uses their faction's native terrain;
 *     player 1's (top-right) likewise. A neutral dirt/rough band lies
 *     between them, split by a mountain ridge crossed only at guarded pass
 *     corridors (a pass stays clear so its guard's zone of control seals
 *     the crossing until the guard is beaten).
 *   - Each zone gets a town, wood/ore/gold mines, resource piles and light
 *     guards. The neutral band holds rare-resource mines, artifacts, stat
 *     boosters and one top-tier "grand prize" artifact behind heavy guards.
 *   - Bigger maps additionally seat an area-scaled number of NEUTRAL,
 *     garrisoned, capturable towns on the surface (none at the 44x36
 *     reference and below, up to 6 — see neutralSurfaceTownCount), and every
 *     map gets a generous, area-scaled scattering of landmark visitables:
 *     obelisks (fog-scouts + one-time XP) and wayfarer's camps (daily
 *     movement boost) — see placeLandmarks.
 *   - Everything scales with map area: a longer ridge gets more passes, and
 *     lakes, terrain patches and every object class grow proportionally, so
 *     a large map feels as rich per screen as the default 44x36.
 *   - A connectivity pass carves through scatter obstacles — never the
 *     ridge — so every object is provably reachable from BOTH towns.
 *   - The seas get their payload after the carve: boats, sea-locked islet
 *     rewards, shipyards on the coasts, and (deep-water only, ≥ 2 or none)
 *     whirlpools — random-destination boat teleporters joining the water
 *     bodies (see placeWhirlpools / actions.useWhirlpool).
 *   - An underground level (see generateUnderground) hangs beneath it all:
 *     a treasure vault anchored by neutral, garrisoned, capturable towns
 *     (z: 1), joined to the surface by paired subterranean gates and
 *     short-cut internally by its own intra-level portal pairs.
 *
 * HOW TO ADD A SCENARIO: call generateMap with different sizes/seeds, or
 * write an authored generator that returns the same shape:
 *   { w, h, tiles[], objects{}, nextOid }
 * Tile: { terrain, obstacle|null, objectId|null, decor }.
 * See docs/EXTENDING.md → "Scenarios".
 */

import { CONFIG } from '../config.js';
import { FACTIONS } from '../data/factions.js';
import { CREATURES, fieldableCreatureIds } from '../data/creatures.js';
import { creaturePower } from '../core/power.js';
import { DWELLINGS, DWELLING_TYPES } from '../data/dwellings.js';
import { CREATURE_BANKS, BOSS_LAIRS, BOSS_LAIR_TYPES } from '../data/creatureBanks.js';
import { rollPandoraReward, rollPandoraGuard } from '../data/pandora.js';
import { SEER_SET_PIECES, seerHutPayload } from '../data/seerHut.js';
import { ARTIFACTS } from '../data/artifacts.js';
import { SKILLS } from '../data/skills.js';
import { SPELLS } from '../data/spells.js';
import { Rng } from '../core/rng.js';

// Payload pools for the learning visitables (fixed at generation so the object
// can advertise WHAT it teaches). Shrines hold combat spells up to tier 3.
const WITCH_HUT_SKILLS = Object.keys(SKILLS);
const SHRINE_SPELLS = Object.keys(SPELLS).filter((id) => !SPELLS[id].adventure && SPELLS[id].tier <= 3);

// The solid sets for the shared walk flood below. A "solid" object is a landmark
// a hero visits from an adjacent tile but never walks THROUGH — so the flood must
// route around it. Towns/portals/subGates block through-traffic in play; the two
// early sea placers (boats/shipyards) predate subGates and use the smaller set,
// which townWalkFlood preserves so their output stays byte-identical.
const WALK_SOLID_LANDMARKS = new Set(['town', 'portal', 'subGate']);
const WALK_SOLID_TOWN_PORTAL = new Set(['town', 'portal']);

/**
 * The one 4-directional, multi-source walk flood every placer used to hand-copy
 * (nine near-identical loops differing only in their solid set). Marks every
 * open-land tile foot-reachable from any of `starts` ({x,y}[]); a tile is blocked
 * by water, an obstacle, or an object whose type is in `solidTypes` (a Set).
 * Returns a Uint8Array `seen` over the grid, read live from map.tiles. The marked
 * SET is independent of traversal order, so this reproduces each former copy
 * byte-for-byte.
 */
function townWalkFlood(map, starts, solidTypes) {
  const { w, h } = map;
  const size = w * h;
  const open = (i) => {
    const tl = map.tiles[i];
    if (tl.terrain === 'water' || tl.obstacle) return false;
    const id = tl.objectId;
    return !id || !solidTypes.has(map.objects[id].type);
  };
  const seen = new Uint8Array(size);
  const stack = [];
  for (const s of starts) {
    const i = s.y * w + s.x;
    if (!seen[i]) { seen[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0 && !seen[i - 1] && open(i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !seen[i + 1] && open(i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
    if (i >= w && !seen[i - w] && open(i - w)) { seen[i - w] = 1; stack.push(i - w); }
    if (i < size - w && !seen[i + w] && open(i + w)) { seen[i + w] = 1; stack.push(i + w); }
  }
  return seen;
}


// A Trading Post's stock: 3–4 UNIQUE artifacts (any real gear, never a story-relic
// / set piece), rolled at generation. The hero buys these for resources; they can
// also sell their own artifacts here for XP (no stock needed for that).
//
// The `campaign` test is belt and braces beside the set-piece one: today every
// campaign relic happens to also be a piece of the Panoply of the First Dawn, so
// the set filter covers them by coincidence. A story relic that is not part of a
// set would walk straight into a roadside shop, and this is the fourth reward
// path where that had to be closed.
const TRADE_STOCK_ARTIFACTS = Object.keys(ARTIFACTS)
  .filter((id) => !SEER_SET_PIECES.has(id) && !ARTIFACTS[id].campaign);

/**
 * `alreadyPlaced` is the map's own artifact ledger (the placer's usedArtifacts).
 * A shop that mostly sells what is already lying under a guard somewhere on the
 * same map is a shop with nothing to say: measured, 86% of stock at 96×80 and
 * above duplicated placed treasure, which at those sizes is simple arithmetic —
 * the catalog is nearly exhausted by placement alone. Prefer the artifacts the
 * map did NOT seat, and fall back to the full pool when there are too few, so a
 * small map's posts sell things you cannot otherwise find and a large map's
 * behave exactly as before.
 *
 * Draw count is unchanged — one for the size, one per item — so the layout of
 * every map is untouched; only what is on the shelves differs.
 */
function tradingPostStock(rng, alreadyPlaced = null) {
  const fresh = alreadyPlaced
    ? TRADE_STOCK_ARTIFACTS.filter((id) => !alreadyPlaced.has(id))
    : TRADE_STOCK_ARTIFACTS;
  const n = Math.min(rng.int(3, 4), TRADE_STOCK_ARTIFACTS.length);
  const pool = [...(fresh.length >= n ? fresh : TRADE_STOCK_ARTIFACTS)];
  const stock = [];
  for (let i = 0; i < n; i++) stock.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
  return stock;
}

const TOWN_NAMES = {
  // CLONE: two playable factions, so two name pools. rng.pick falls back to
  // ['Freehold'] for any faction without a row (see the town-naming call below),
  // so adding a faction back needs no edit here.
  castle: ['Whitestone', 'Alderhall', 'Brightwater'],
  inferno: ['Ashenfell', 'Charnel Keep', 'Brimstone Gate'],
};

// Guard budgets in creature aiValue points.
const GUARD_LIGHT = [400, 900];
const GUARD_MEDIUM = [1400, 2400];
const GUARD_HEAVY = [3200, 5200];

// The 44x36 default is the hand-tuned density reference: object/feature
// counts scale by area relative to it.
const REFERENCE_AREA = 44 * 36;

// Mountain band half-thickness in RAW TILES (not map-relative). Pass
// corridors have to punch through the band, so its thickness must stay
// constant while the ridge only grows LONGER with the map — the old
// map-relative band (|zoneT| < 0.035) thickened with size until no fixed
// gap could cross it, which is exactly what sealed large maps shut.
const RIDGE_HALF = 2.0;

// The contested rare-resource mine set, shared by the surface's neutral band
// and the underground vault.
const RARE_MINES = ['alchemistLab', 'sulfurMine', 'crystalCavern', 'gemPond'];

// Underground towns: neutral, garrisoned strategic prizes of the lower level.
// The dark faction claims the caverns (its native lava runs down here), and
// each town's defenders are tuned like a heavily-guarded prize — capturing one
// is a genuine fight, and the reward a foothold, not an instant capital.
const UNDERGROUND_TOWN_FACTION = 'inferno';
const UNDERGROUND_TOWN_NAMES = [
  'Gloomhold', 'Deepwarren', 'Embervault', 'Nightfane', 'Hollowdeep', 'Cinderhall',
];

// Surface neutral towns: unaligned, garrisoned freeholds of the contested
// countryside — capturable footholds that give big maps their "many castles"
// feel. Factions cycle through the roster so the countryside is mixed, never
// all one banner; names are faction-agnostic frontier settlements.
const NEUTRAL_TOWN_NAMES = [
  'Freehold', 'Crossroads', 'Stonebridge', 'Ravenmoor', 'Goldenfield',
  'Thornwall', 'Mistford', 'Windmere', 'Harrowgate',
  // Enough names for the largest board: World's Edge is 2.25x the land of any other
  // map, and a ladder that caps at six freeholds would have left it feeling emptier
  // per mile than the map half its size.
  'Ashgrove', 'Saltmarch', 'Duncairn', 'Highfen', 'Redwater', 'Elmspire',
];

/**
 * How many neutral surface towns an area seats: 0 at the 44x36 reference and
 * below (compact duels keep their classic feel), growing with area.
 *
 * The cap rose from 6 with World's Edge: at 2.25x the land of the next map down, the
 * old ceiling meant the biggest board had exactly as many castles as one less than
 * half its size, so it read as emptier per mile rather than grander. Bounded by the
 * name list, which is why that list grew too.
 * Exported for tests (the generator and the suite must agree on the ladder).
 */
export function neutralSurfaceTownCount(w, h) {
  const scale = (w * h) / REFERENCE_AREA;
  return Math.max(0, Math.min(NEUTRAL_TOWN_NAMES.length, Math.round(1.6 * (scale - 1))));
}

/** How many neutral towns the underground seats: one to three, by area. */
export function undergroundTownCount(w, h) {
  return Math.max(1, Math.min(3, Math.round((w * h) / REFERENCE_AREA)));
}

/**
 * How many towns a map of this size will seat, before a single one is generated:
 * one per player, plus the countryside's freeholds, plus the caverns' holds.
 *
 * Exported because a menu has to be able to say the number BEFORE the map exists —
 * the `holdTowns` objective's target is derived from the town count, and "Rule 42
 * towns" is not a thing to discover after pressing Generate. Kept next to the two
 * ladders it adds up, so it cannot drift from them.
 */
export function expectedTownCount(w, h, players = 2) {
  return Math.max(1, players | 0) + neutralSurfaceTownCount(w, h) + undergroundTownCount(w, h);
}

export function generateMap({
  w, h, rng, players, registerTown, underground = true, richLands = false,
  // WHICH DAMAGE MODEL this game runs. Guards and garrisons are sized in POWER
  // (src/core/power.js) and power is measured per model, so a map generated for a
  // physical-model game must roll its opposition off the physical table. Passed
  // as a plain flag rather than read from state, like `richLands`: the generator
  // has no state and importing GameState here would close a cycle.
  physicalDamage = false,
}) {
  const map = {
    w, h,
    tiles: new Array(w * h),
    objects: {},
    nextOid: 1,
  };
  const idx = (x, y) => y * w + x;
  // Two-team layout: the team of players[0] holds the bottom-left zone, the
  // other team the top-right. N-player games split their players across these
  // two zones (a plain 1v1 is one player per zone). A `players` entry without a
  // team falls back to its ARRAY POSITION (which equals player.index in a real
  // game), reproducing the classic 2-player map. Positions are carried through
  // so the town owner is that same index.
  const roster = players.map((p, i) => ({ p, i, team: p.team ?? i }));
  const teamAId = roster[0].team;
  const teamAList = roster.filter((e) => e.team === teamAId);
  const teamBList = roster.filter((e) => e.team !== teamAId);
  // CLONE: `?.` + a fallback, matching the guarded lookup further down this file.
  // Upstream these two were bare, so a roster naming a faction that is not in the
  // registry threw "Cannot read properties of undefined (reading 'nativeTerrain')"
  // inside map generation — i.e. the game failed to start rather than reporting a
  // bad roster. With a two-faction registry that is a much easier mistake to make,
  // so the zone falls back to grass instead of exploding.
  const terrainA = FACTIONS[teamAList[0].p.faction]?.nativeTerrain || 'grass'; // bottom-left
  const terrainB = FACTIONS[(teamBList[0] || teamAList[0]).p.faction]?.nativeTerrain || 'grass'; // top-right

  // Density scaler: proportional to area, floored at 1 so every object class
  // still shows up on a small map.
  const scale = (w * h) / REFERENCE_AREA;
  const scaled = (base) => Math.max(1, Math.round(base * scale));
  // Artifact seats use a CLAMPED scale (CONFIG.ARTIFACT_DENSITY_CAP_AREA): the
  // catalog holds finitely many distinct artifacts, so past the size it can fill
  // an extra seat can only repeat one. Identical to `scaled` at or below the cap.
  const artScale = Math.min(scale, CONFIG.ARTIFACT_DENSITY_CAP_AREA / REFERENCE_AREA);
  const scaledArt = (base) => Math.max(1, Math.round(base * artScale));

  // ---- 1. Base terrain zones ------------------------------------------
  // zoneS in raw tiles: negative = closer to the bottom-left corner,
  // positive = top-right. zoneT normalizes by the diagonal so ZONE
  // PROPORTIONS hold on any size, while ridge geometry uses zoneS so its
  // THICKNESS stays size-independent.
  const diag = Math.hypot(w, h);
  const zoneS = (x, y) => Math.hypot(x, (h - 1) - y) - Math.hypot((w - 1) - x, y);
  const zoneT = (x, y) => zoneS(x, y) / diag;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = zoneT(x, y) + (rng.random() - 0.5) * 0.08; // wobble the border
      let terrain;
      if (t < -0.06) terrain = terrainA;
      else if (t > 0.06) terrain = terrainB;
      else terrain = rng.chance(0.5) ? 'dirt' : 'rough';
      map.tiles[idx(x, y)] = {
        terrain, obstacle: null, objectId: null,
        decor: rng.int(0, 1e9),
      };
    }
  }

  // Small terrain patches for variety (dirt meadows in zones, rough pockets).
  const patchCount = Math.max(4, Math.round(8 * scale));
  for (let i = 0; i < patchCount; i++) {
    const cx = rng.int(3, w - 4), cy = rng.int(3, h - 4);
    const r = rng.int(2, 4);
    const patch = rng.pick(['dirt', 'rough']);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (Math.hypot(x - cx, y - cy) <= r && rng.chance(0.8)) {
          map.tiles[idx(x, y)].terrain = patch;
        }
      }
    }
  }

  // ---- 2. Mountain ridge with guarded pass corridors ---------------------
  // Ridge follows zoneS ≈ 0 at constant thickness. Passes are corridors we
  // keep mountain-free and later guard; a longer ridge gets more of them so
  // the two realms always stay linkable.
  const ridgeTiles = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(zoneS(x, y)) < RIDGE_HALF) ridgeTiles.push({ x, y });
    }
  }
  const passCount = Math.max(2, Math.min(5, Math.round(diag / 26)));
  const passes = [];
  const corridorTiles = new Set();
  {
    // Order candidates along the ridge (projection on the ridge axis, which
    // runs perpendicular to the corner-to-corner diagonal), kept off the
    // border so a corridor and its guard always fit.
    const along = (p) => p.x * (h - 1) + p.y * (w - 1);
    const interior = ridgeTiles.filter(
      (p) => p.x >= 3 && p.y >= 3 && p.x <= w - 4 && p.y <= h - 4,
    );
    const sorted = (interior.length ? interior : ridgeTiles.slice())
      .sort((a, b) => along(a) - along(b));
    const chosen = [];
    for (let p = 0; p < passCount && sorted.length; p++) {
      const k = Math.floor(((p + 1) / (passCount + 1)) * sorted.length);
      const tile = sorted[Math.max(0, Math.min(sorted.length - 1, k))];
      // A short ridge can make the evenly-spread picks coincide — keep the
      // crossings genuinely apart so their corridors never merge into one
      // unguardable gap.
      if (tile && !chosen.some((pp) => Math.abs(pp.x - tile.x) < 8 && Math.abs(pp.y - tile.y) < 8)) {
        chosen.push(tile);
      }
    }
    // A candidate only becomes a pass if its corridor verifiably crosses the
    // band. Near the ridge tips the distance field flattens and a tunnel can
    // dead-end against the border — such a pick is dropped rather than left
    // as a sealed pocket that would trap its own guard.
    for (const c of chosen) {
      const corridor = passCorridor(w, h, zoneS, c.x, c.y);
      if (!corridor) continue;
      passes.push({ x: c.x, y: c.y });
      for (const i of corridor) corridorTiles.add(i);
    }
    // Belt and braces: the ridge midpoint always punches through (the field
    // is steepest at the map center) — force it if every spread pick failed,
    // so the realms ALWAYS get at least one guarded crossing.
    if (!passes.length && sorted.length) {
      const mid = sorted[(sorted.length / 2) | 0];
      const corridor = passCorridor(w, h, zoneS, mid.x, mid.y);
      if (corridor) {
        passes.push({ x: mid.x, y: mid.y });
        for (const i of corridor) corridorTiles.add(i);
      }
    }
  }
  for (const { x, y } of ridgeTiles) {
    if (!corridorTiles.has(idx(x, y))) map.tiles[idx(x, y)].obstacle = 'mountain';
  }

  // ---- 3. Lakes ---------------------------------------------------------
  // Every other lake is a big *navigable* body (worth a boat — a hero can sail
  // across instead of trekking around); the rest are small decorative pools.
  const lakeCount = Math.max(2, Math.round(4 * scale));
  const bigLakes = []; // centres of the navigable bodies (boats land here later)
  for (let i = 0; i < lakeCount; i++) {
    const cx = rng.int(4, w - 5), cy = rng.int(4, h - 5);
    if (Math.abs(zoneT(cx, cy)) < 0.12) continue; // keep the pass band clear
    const big = i % 2 === 0;
    const r = (big ? rng.int(3, 4) : rng.int(1, 2)) + rng.random();
    let painted = 0;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        if (Math.hypot(x - cx, y - cy) > r) continue;
        const tl = map.tiles[idx(x, y)];
        // Water never dissolves the ridge wall: a flooded gap would later be
        // carvable (water → dirt), silently breaching the guarded-pass rule.
        if (tl.obstacle === 'mountain') continue;
        tl.terrain = 'water'; tl.obstacle = null;
        painted++;
      }
    }
    if (big && painted >= 6) bigLakes.push({ x: cx, y: cy, r: Math.ceil(r) });
  }

  // ---- 4. Obstacle scatter ----------------------------------------------
  const OBSTACLE_BY_TERRAIN = {
    grass: 'tree', dirt: 'tree', rough: 'rock', lava: 'rock', snow: 'tree', sand: 'rock',
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = map.tiles[idx(x, y)];
      if (tl.terrain === 'water' || tl.obstacle) continue;
      const density = tl.terrain === 'grass' ? 0.10 : 0.08;
      if (rng.chance(density)) tl.obstacle = OBSTACLE_BY_TERRAIN[tl.terrain] || 'rock';
    }
  }

  // ---- 5. Towns -----------------------------------------------------------
  // Inset scales with the short side so towns hug their corners on any size
  // (a fixed 6/7 offset drifts toward mid-map on tiny maps); at the 44x36
  // reference it lands on the classic (6, h-7) / (w-7, 6) spots.
  const inset = Math.max(4, Math.min(8, Math.round(Math.min(w, h) * 0.18)));
  // Up to two start towns per zone (a team can field up to two players). The
  // second town hugs the same corner, offset along the edges so it stays firmly
  // inside its own zone rather than drifting into the contested band.
  const spread = Math.max(5, Math.round(Math.min(w, h) * 0.22));
  // THREE spots per zone: with four seats a team can field up to three
  // players (the shipped "1 vs 3" match). The old 2-spot table silently
  // reused spot [1] for a third teammate, stacking two towns (and their
  // starting heroes) on one tile — the tile grid then pointed at only one of
  // them, so the orphaned town could never be attacked and conquest became
  // unwinnable. The third spot climbs the corner's other edge.
  const zoneSpots = {
    A: [
      { x: inset, y: h - 1 - inset },
      { x: inset + spread, y: h - 1 - inset - (spread >> 1) },
      { x: inset + (spread >> 1), y: h - 1 - inset - spread },
    ],
    B: [
      { x: w - 1 - inset, y: inset },
      { x: w - 1 - inset - spread, y: inset + (spread >> 1) },
      { x: w - 1 - inset - (spread >> 1), y: inset + spread },
    ],
  };
  const townSpots = [];
  teamAList.forEach((e, k) => townSpots.push({ ...zoneSpots.A[Math.min(k, zoneSpots.A.length - 1)], player: e.i, sign: -1 }));
  teamBList.forEach((e, k) => townSpots.push({ ...zoneSpots.B[Math.min(k, zoneSpots.B.length - 1)], player: e.i, sign: 1 }));
  // Belt-and-braces: no two start towns may ever share (or crowd) a tile. If a
  // future roster exceeds the table, nudge the collider along a deterministic
  // spiral (no rng draws — existing layouts stay byte-identical) to the nearest
  // clear, spaced tile; throw rather than ship a stacked, unwinnable map.
  for (let s = 0; s < townSpots.length; s++) {
    const spot = townSpots[s];
    const clashes = (x, y) => townSpots.some(
      (o, j) => j < s && Math.max(Math.abs(o.x - x), Math.abs(o.y - y)) < 4,
    );
    const fits = (x, y) => {
      if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3 || clashes(x, y)) return false;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const tl = map.tiles[idx(x + dx, y + dy)];
        if (tl.terrain === 'water' || tl.obstacle === 'mountain' || tl.objectId) return false;
      }
      return true;
    };
    if (!clashes(spot.x, spot.y)) continue;
    let placedSpot = false;
    for (let r = 1; r <= 12 && !placedSpot; r++) {
      for (let dy = -r; dy <= r && !placedSpot; dy++) for (let dx = -r; dx <= r && !placedSpot; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (fits(spot.x + dx, spot.y + dy)) { spot.x += dx; spot.y += dy; placedSpot = true; }
      }
    }
    if (!placedSpot) throw new Error(`No distinct start-town spot for player ${spot.player}`);
  }
  const keyPoints = []; // used for connectivity carving
  for (const spot of townSpots) {
    clearArea(map, spot.x, spot.y, 2);
    const player = players[spot.player];
    const town = {
      name: rng.pick(TOWN_NAMES[player.faction] || ['Freehold']),
      faction: player.faction,
      owner: spot.player,
      x: spot.x, y: spot.y,
      z: 0, // map level: start towns live on the surface (cavern towns carry z: 1)
      buildings: ['villageHall', 'fort', 'tavern', 'dwelling1'],
      builtToday: false,
      available: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
      garrison: [null, null, null, null, null, null, null],
      visitingHeroId: null,
      guildSpells: null,
    };
    // Week-1 population for tier 1 so the first days have recruits.
    town.available[1] = baseGrowthFor(player.faction, 1);
    const townId = registerTown(town);
    placeObject(map, spot.x, spot.y, { type: 'town', townId });
    keyPoints.push({ x: spot.x, y: spot.y });
  }

  // ---- 5b. Neutral surface towns -----------------------------------------
  // An area-scaled number of NEUTRAL, garrisoned, capturable towns dot the
  // countryside of bigger maps (none at the 44x36 reference and below, up to
  // 6 on the largest presets — with 3 start towns that is a ~9-castle map).
  // They mirror the underground's neutral towns, on the surface: owner -1, a
  // real defending garrison from their own faction's roster, the same modest
  // building baseline as a start town, and registration through registerTown
  // so every owner-keyed system (income, growth, starvation, victory) already
  // handles them. Seated BEFORE the carve, like start towns: each is a solid
  // landmark the carve routes around and links via its doorstep, so step 7's
  // certification proves every one reachable from every start town. Strictly
  // best-effort — a crowded layout seats fewer, and NEVER throws (only start
  // towns and the underground lifeline are load-bearing). When the count is
  // 0 the block draws NO rng, so small maps keep their exact classic layouts
  // seed for seed.
  const neutralTownCount = neutralSurfaceTownCount(w, h);
  const neutralTownSpots = [];
  if (neutralTownCount > 0) {
    const factionIds = Object.keys(FACTIONS);
    const townSpacing = Math.max(10, Math.round(Math.min(w, h) * 0.2));
    for (let k = 0; k < neutralTownCount; k++) {
      let spot = null;
      for (let tries = 0; tries < 240 && !spot; tries++) {
        const x = rng.int(4, w - 5), y = rng.int(4, h - 5);
        // The 5x5 the town clears must not touch a mountain (the ridge stays
        // sealed — clearArea would dissolve it), a pass corridor (its guard
        // keeps the bottleneck), water (lakes stay navigable) or any object.
        let ok = true;
        for (let dy = -2; dy <= 2 && ok; dy++) {
          for (let dx = -2; dx <= 2 && ok; dx++) {
            const i = (y + dy) * w + (x + dx);
            const tl = map.tiles[i];
            if (tl.obstacle === 'mountain' || tl.terrain === 'water'
                || tl.objectId || corridorTiles.has(i)) ok = false;
          }
        }
        if (!ok) continue;
        // Clear of the pass mouths, and apart from every other town.
        if (passes.some((p) => Math.hypot(p.x - x, p.y - y) < 6)) continue;
        if (townSpots.some((s) => Math.hypot(s.x - x, s.y - y) < townSpacing)) continue;
        if (neutralTownSpots.some((s) => Math.hypot(s.x - x, s.y - y) < townSpacing)) continue;
        spot = { x, y };
      }
      if (!spot) break; // best-effort: a crowded map simply seats fewer
      clearArea(map, spot.x, spot.y, 2);
      const faction = factionIds[k % factionIds.length];
      const town = {
        name: NEUTRAL_TOWN_NAMES[k % NEUTRAL_TOWN_NAMES.length],
        faction,
        owner: -1, // neutral until besieged and captured
        x: spot.x, y: spot.y,
        z: 0, // map level: these live on the surface (cavern towns carry z: 1)
        buildings: ['villageHall', 'fort', 'tavern', 'dwelling1'],
        builtToday: false,
        available: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
        garrison: rollTownGarrison(rng, faction, GUARD_MEDIUM, physicalDamage),
        visitingHeroId: null,
        guildSpells: null,
      };
      // Week-1 population for tier 1, like every town (neutral towns keep
      // growing weekly, so a late capture is not an empty shell).
      town.available[1] = baseGrowthFor(faction, 1);
      const townId = registerTown(town);
      placeObject(map, spot.x, spot.y, { type: 'town', townId });
      neutralTownSpots.push(spot);
    }
  }

  // ---- 6. Mines, treasure, guards ---------------------------------------
  const placer = new ObjectPlacer(map, rng, physicalDamage);
  // Nothing may spawn in or beside a pass corridor — the guard needs its
  // bottleneck free and its zone of control unobstructed.
  const forbid = new Uint8Array(w * h);
  const markForbid = (x, y, r) => {
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
      for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
        forbid[yy * w + xx] = 1;
      }
    }
  };
  for (const i of corridorTiles) markForbid(i % w, (i / w) | 0, 1);
  for (const pass of passes) markForbid(pass.x, pass.y, 2);
  placer.forbidden = forbid;

  // Reserve the grand prize FIRST: smaller draws fall back to "any unused
  // artifact" when their value pool runs dry (possible with scaled counts),
  // and must never swallow the map's one top-tier reward.
  const grandPrize = placer.artifactOfValue(4);

  for (const spot of townSpots) {
    const sign = spot.sign;
    const inZone = (x, y) => zoneT(x, y) * sign > 0.10;
    // Economy backbone near each town; a bigger zone supports more industry.
    const basicMines = Math.max(1, Math.round(0.8 * scale));
    const goldMines = Math.max(1, Math.round(0.5 * scale));
    for (let i = 0; i < basicMines; i++) {
      placer.place('mine', { mineType: 'sawmill', owner: -1 }, inZone, GUARD_LIGHT, spot);
      placer.place('mine', { mineType: 'orePit', owner: -1 }, inZone, GUARD_LIGHT, spot);
    }
    for (let i = 0; i < goldMines; i++) {
      placer.place('mine', { mineType: 'goldMine', owner: -1 }, inZone, GUARD_MEDIUM, spot);
    }
    // Rich Lands: every zone gets one mine of EVERY resource, so a town can be
    // self-sufficient on its own ground and the rares are not all locked in the
    // contested band. Guarded so Classic draws no extra rng and stays identical.
    if (richLands) {
      for (let i = 0; i < CONFIG.RICH_LANDS_ZONE_SET; i++) {
        for (const mineType of RARE_MINES) {
          placer.place('mine', { mineType, owner: -1 }, inZone, GUARD_MEDIUM, spot);
        }
      }
    }
    // Loose resources & chests.
    for (let i = 0; i < scaled(5); i++) {
      const r = rng.pick(['gold', 'wood', 'ore']);
      placer.place('resource', {
        resource: r,
        amount: r === 'gold' ? rng.int(500, 1200) : rng.int(4, 9),
      }, inZone, null, spot);
    }
    for (let i = 0; i < scaled(2); i++) placer.place('chest', {}, inZone, null, spot);
    // Light artifacts and boosters, one class per loop so each zone keeps the
    // same mix at any size.
    for (let i = 0; i < scaledArt(1); i++) {
      placer.place('artifact', () => ({ artifact: placer.artifactOfValue(1) }), inZone, GUARD_LIGHT, spot);
    }
    for (let i = 0; i < scaled(1); i++) {
      placer.place('booster', { boosterType: rng.pick(['attack', 'defense']) }, inZone, GUARD_LIGHT, spot);
    }
    for (let i = 0; i < scaled(1); i++) {
      placer.place('booster', { boosterType: 'mana' }, inZone, null, spot);
    }
    for (let i = 0; i < scaled(1); i++) {
      placer.place('booster', { boosterType: rng.pick(['luck', 'morale']) }, inZone, null, spot);
    }
    // Neutral wandering guards to grind XP on.
    for (let i = 0; i < scaled(3); i++) {
      placer.placeMonster(inZone, [300, 900], spot);
    }
  }

  // ---- Portals: intra-zone two-way teleport pairs -----------------------
  // Shortcuts that stay inside one realm (both ends same side of the ridge, so
  // the guarded-crossing contract is untouched). Pathfinding treats a portal as
  // a through-wall, so the AI never routes onto one — for now they are a human's
  // tool. One pair per zone, a second per zone on large maps.
  const inZoneA = (x, y) => zoneT(x, y) < -0.10;
  const inZoneB = (x, y) => zoneT(x, y) > 0.10;
  const anchorA = townSpots.find((s) => s.sign < 0) || null;
  const anchorB = townSpots.find((s) => s.sign > 0) || null;
  const portalMinD = Math.min(14, Math.max(6, Math.round(w * 0.18)));
  let portalCh = 0;
  placer.placePortalPair(inZoneA, anchorA, portalCh, portalCh, portalMinD); portalCh++;
  placer.placePortalPair(inZoneB, anchorB, portalCh, portalCh, portalMinD); portalCh++;
  if (scale >= 2.5) {
    placer.placePortalPair(inZoneA, null, portalCh, portalCh, portalMinD); portalCh++;
    placer.placePortalPair(inZoneB, null, portalCh, portalCh, portalMinD); portalCh++;
  }

  // Neutral band: the contested middle.
  const inBand = (x, y) => Math.abs(zoneT(x, y)) <= 0.10;
  const bandAnchor = { x: (w / 2) | 0, y: (h / 2) | 0 };
  // The grand prize goes in first (roomiest pick of the band). If the band is
  // somehow too crowded, fall back to anywhere open — a scenario must never
  // generate without its marquee reward.
  const prizeObj = placer.place('artifact', { artifact: grandPrize }, inBand, GUARD_HEAVY, bandAnchor)
    || placer.place('artifact', { artifact: grandPrize }, () => true, GUARD_HEAVY, null);
  for (const mineType of RARE_MINES) {
    placer.place('mine', { mineType, owner: -1 }, inBand, GUARD_MEDIUM, bandAnchor);
  }
  if (richLands) {
    // A spare of every resource in the middle — the reason to push out, on top of
    // what your own zone already yields.
    for (let i = 0; i < CONFIG.RICH_LANDS_BAND_SPARE; i++) {
      for (const mineType of [...RARE_MINES, 'sawmill', 'orePit']) {
        placer.place('mine', { mineType, owner: -1 }, inBand, GUARD_MEDIUM, bandAnchor);
      }
    }
  }
  const extraRare = Math.max(0, Math.round(2 * (scale - 1)));
  for (let i = 0; i < extraRare; i++) {
    placer.place('mine', { mineType: rng.pick(RARE_MINES), owner: -1 }, inBand, GUARD_MEDIUM, bandAnchor);
  }
  const bandGold = scale >= 2.5 ? 2 : 1;
  for (let i = 0; i < bandGold; i++) {
    placer.place('mine', { mineType: 'goldMine', owner: -1 }, inBand, GUARD_HEAVY, bandAnchor);
  }
  // FAIRNESS: the band straddles the seam, and the audit (like a player) reads
  // each artifact as belonging to whichever REALM's half it lands on — so
  // side-blind band seating can pile the map's mid-tier relics onto one
  // player's approach. On a small map that is most of the artifact ledger
  // (FAIR.art dipped to ~43% there). Alternate the seats across the seam,
  // leading with the side the grand prize did NOT take, so the band's riches
  // face both realms about evenly; a side too crowded to seat falls back to
  // anywhere in the band — the relic always ships.
  const bandSide = (x, y) => (zoneT(x, y) < 0 ? 0 : 1);
  const artLead = prizeObj ? 1 - bandSide(prizeObj.x, prizeObj.y) : 0;
  for (let i = 0; i < scaledArt(3); i++) {
    const want = (artLead + i) % 2;
    // A thunk, so a band seat that finds no room does not burn an artifact —
    // and the fallback attempt below draws for the first time rather than a
    // second time, because a failed place() never evaluates it.
    const art = () => ({ artifact: placer.artifactOfValue(rng.int(2, 3)) });
    const sided = (x, y) => inBand(x, y) && bandSide(x, y) === want;
    if (!placer.place('artifact', art, sided, GUARD_MEDIUM, bandAnchor)) {
      placer.place('artifact', art, inBand, GUARD_MEDIUM, bandAnchor);
    }
  }
  for (let i = 0; i < scaled(2); i++) {
    placer.place('booster', { boosterType: rng.pick(['power', 'knowledge', 'xp']) }, inBand, GUARD_LIGHT, bandAnchor);
  }
  for (let i = 0; i < scaled(4); i++) {
    const r = rng.pick(['mercury', 'sulfur', 'crystal', 'gems', 'gold']);
    placer.place('resource', {
      resource: r,
      amount: r === 'gold' ? rng.int(800, 1500) : rng.int(3, 6),
    }, inBand, null, bandAnchor);
  }
  for (let i = 0; i < scaled(2); i++) placer.place('chest', {}, inBand, null, bandAnchor);

  // Guards on the mountain passes (the walls between realms). Lakes and the
  // obstacle scatter may have littered the corridors after the ridge was
  // laid — sweep every corridor tile so each pass is genuinely crossable and
  // its guard always spawns.
  for (const i of corridorTiles) {
    const tl = map.tiles[i];
    tl.obstacle = null; // never 'mountain': corridors were exempted above
    if (tl.terrain === 'water') tl.terrain = 'dirt';
  }
  for (const pass of passes) {
    placer.placeMonsterAt(pass.x, pass.y, GUARD_MEDIUM);
  }

  // ---- 7. Connectivity: carve paths from towns to every object ----------
  // Certify from BOTH town starts, not just town0.
  carveConnectivity(map, keyPoints);

  // ---- 8. Boats + islands: navigable-lake payload ----------------------
  // Placed AFTER the carve so a drained channel can't strand a boat, and so the
  // sea-locked island rewards are never subjected to the on-foot certification
  // (they are reachable by BOAT, guaranteed by construction below, not on foot).
  placeBoatsAndIslands(map, bigLakes, keyPoints, rng);

  // ---- 8b. Shipyards: build-a-boat docks on navigable coasts ------------
  // One neutral shipyard per big lake (area-scaled for free, like the boats):
  // a walkable coast tile, foot-reachable from both towns by construction, with
  // an orthogonally adjacent free water tile where a bought boat can spawn.
  // Placed after the boats so the pre-placed boat never steals the dock, and
  // before the underground so surfaceStillLinked certifies gates around them.
  placeShipyards(map, bigLakes, keyPoints);

  // ---- 8c. Whirlpools: random-destination sea teleporters ----------------
  // Deep-water hazards joining the seas: a BOAT hero ending a move on one is
  // swept to a random other whirlpool for a toll of army (actions.js →
  // useWhirlpool). Placed after the boats/islands/shipyards so the deep-water
  // rule can see every water object, and before the underground so gate
  // placement's surfaceStillLinked (which skips sea objects) already knows
  // them. Deterministic: a pure scan, no rng draws — everything placed before
  // this line is byte-identical to pre-whirlpool output.
  placeWhirlpools(map);

  // ---- 8d. Landmark visitables: obelisks + wayfarer's camps --------------
  // Placed AFTER the carve/sea passes — so nothing seated before this line
  // moves — and BEFORE the underground, so the "surface = baseline + only the
  // gates" contract (underground: false) still holds. Both are NON-SOLID
  // visitables (a hero steps onto them), so seating one can never re-strand
  // an object the carve linked; each spot is drawn from the towns' own walk
  // flood, which certifies the landmark itself foot-reachable from every
  // start town.
  placeLandmarks(map, rng, keyPoints, forbid, richLands);

  // ---- 8d2. Key vaults: Keymaster Tents + Border Guards ------------------
  // Colored-key gated caches. Placed AFTER the carve (like the boats/grail) so
  // the sealed reward is never subjected to the on-foot certification, and each
  // seal is verified not to strand an existing object before it commits. Draws
  // from `rng` deterministically, and BEFORE the underground step (whose stream
  // is seed-derived, not rng-state-derived), so the surface stays reproducible.
  placeKeyVaults(map, rng, keyPoints, forbid);

  // ---- 8d3. Creature Banks: guarded one-time reward sites ----------------
  // Blocking only at runtime (a deliberate attack target); passable in every
  // generation reachability check, so — like a mine — one can never strand an
  // object. Post-carve + before the underground (seed-derived stream), so the
  // surface stays reproducible.
  placeCreatureBanks(map, rng, keyPoints, forbid);

  // ---- 8d4. Pandora's Boxes: one-time varied-reward objects --------------
  // Same connectivity-safe seating as the banks; post-carve + before the
  // underground so the surface stays reproducible.
  placePandoraBoxes(map, rng, keyPoints, forbid, physicalDamage);

  // ---- 8d5. One-way Monoliths: enter → random same-colour exit -----------
  // A one-directional shortcut (you can't come back the way you came). Seated
  // like the banks: post-carve on reachable, uncrowded open land, PASSABLE in
  // every generation reachability check (it only blocks through-traffic at
  // runtime, like a portal), so it can never strand an object or plug a
  // corridor. Reference-size maps and up.
  placeMonoliths(map, rng, keyPoints, forbid);

  // ---- 8e. Roads: cobble highways between towns + dirt spurs to mines ----
  // Deterministic (an MST over the towns, then a short branch from each mine to
  // the nearest road), painted onto tile.road (stepCost discounts them). Pure
  // geometry — NO rng draws — so all placement above stays byte-identical, and
  // it never blocks a tile (roads only overlay already-open ground).
  layRoads(map);

  // ---- 8f. The buried Grail: one hidden tile the obelisk puzzle reveals ---
  // Deterministic (no rng): the object-free land tile nearest map centre that
  // is foot-reachable from a start town, so a hero can always dig it up.
  placeGrail(map, keyPoints);

  // ---- 8g. Scholar sites: the premium Tree of Knowledge / Library visitables.
  // Placed LAST on the surface, so it draws only the TAIL of the main rng and
  // shifts no already-placed object; the underground step below runs on its own
  // seed-derived stream, so it is untouched too.
  placeScholarSites(map, rng, keyPoints);

  // ---- 8h. Boss lairs: a rare, single-apex-guarded prize (see BOSS_LAIRS).
  // Same tail-of-the-rng discipline as the scholar sites, so it shifts nothing
  // already placed. Reuses the creatureBank object + combat + reward path.
  placeBossLairs(map, rng, keyPoints, forbid);

  // ---- 8i. External creature dwellings: recruit outside a town (see DWELLINGS).
  // A few per map, on reachable open land — same tail-rng discipline, so it
  // shifts nothing already placed.
  placeDwellings(map, rng, keyPoints, forbid);

  // ---- 8j. Trading Posts: sell artifacts for XP / buy them for resources.
  // Tail-rng discipline (after every object above), so it shifts nothing already
  // placed; the underground below runs on its own seed-derived stream, untouched.
  placeTradingPosts(map, rng, keyPoints, forbid, placer.usedArtifacts);

  // ---- 9. Underground level + subterranean gates ------------------------
  // A SEPARATE deterministic step on its OWN rng stream (derived from the
  // mapgen seed, no draws taken from `rng`): for any seed the surface above is
  // exactly what the pre-underground generator produced — same terrain, same
  // objects, same ids — and the only surface addition is the gate entrances,
  // each verified not to plug a carved corridor. `underground: false` skips
  // the step entirely, reproducing that byte-for-byte baseline (used by tests).
  if (underground) {
    const ugRng = new Rng((Math.imul(rng.seed | 0, 0x85ebca6b) ^ 0x2545f491) | 0);
    generateUnderground(map, ugRng, keyPoints, placer.usedArtifacts, registerTown, forbid, physicalDamage);
    // Roads on the caverns too, by the same rules: a highway joining the
    // level's towns AND its gate mouths (see layRoads — a hero descending at
    // any gate lands on the network), plus spurs to the mines. The gates are
    // termini, so even a lone cavern town gets its highway instead of
    // standing trackless.
    if (map.underground) layRoads(map.underground);
  }

  return map;
}

/**
 * Choose the buried Grail tile (the obelisk puzzle → dig → Grail structure).
 * Deterministic, no rng: flood the walkable land from the first town, then take
 * the reachable, object-free tile nearest map centre — so the Grail is always
 * foot-reachable and never lands on another object. Stored as `map.grail =
 * {x, y}` (surface), secret until a player uncovers every obelisk.
 */
function placeGrail(map, keyPoints) {
  if (!keyPoints || !keyPoints.length) return;
  const { w, h, tiles } = map;
  const at = (x, y) => y * w + x;
  const walk = (x, y) => x >= 0 && y >= 0 && x < w && y < h
    && tiles[at(x, y)].terrain !== 'water' && !tiles[at(x, y)].obstacle;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const seen = new Uint8Array(w * h);
  const q = [at(keyPoints[0].x, keyPoints[0].y)];
  seen[q[0]] = 1;
  for (let head = 0; head < q.length; head++) {
    const ci = q[head], cx = ci % w, cy = (ci / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!walk(nx, ny)) continue;
      if (dx && dy && !(walk(cx + dx, cy) || walk(cx, cy + dy))) continue; // no corner cut
      const ni = at(nx, ny);
      if (!seen[ni]) { seen[ni] = 1; q.push(ni); }
    }
  }
  const ccx = w / 2, ccy = h / 2;
  let best = null, bestD = Infinity;
  for (let i = 0; i < w * h; i++) {
    if (!seen[i] || tiles[i].objectId) continue;
    const x = i % w, y = (i / w) | 0;
    const d = (x - ccx) ** 2 + (y - ccy) ** 2;
    if (d < bestD) { bestD = d; best = { x, y }; }
  }
  if (best) map.grail = best;
}

/**
 * Place the premium "scholar" visitables — a Tree of Knowledge (grants a hero a
 * full level) on most maps, and a Library of Enlightenment (+1 to every primary
 * skill) as well on medium-and-larger maps. Sites go on reachable, object-free
 * land a healthy walk from any town, so they're a deliberate detour rather than
 * a doorstep freebie. Runs after every other surface placer (see 8g), so the
 * draws it takes never move an already-placed object.
 */
/** Any placed object within Chebyshev `r` of (x, y)? The breathing-ring test. */
function hasNeighbourWithin(map, x, y, r) {
  const { w, h, tiles } = map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (tiles[ny * w + nx].objectId) return true;
    }
  }
  return false;
}

function placeScholarSites(map, rng, keyPoints) {
  if (!keyPoints || !keyPoints.length) return;
  const { w, h, tiles } = map;
  const at = (x, y) => y * w + x;
  const walk = (x, y) => x >= 0 && y >= 0 && x < w && y < h
    && tiles[at(x, y)].terrain !== 'water' && !tiles[at(x, y)].obstacle;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  // Flood the walkable land from a start town (same reachability rule as the
  // Grail), so a site is always foot-reachable.
  const seen = new Uint8Array(w * h);
  const q = [at(keyPoints[0].x, keyPoints[0].y)];
  seen[q[0]] = 1;
  for (let head = 0; head < q.length; head++) {
    const ci = q[head], cx = ci % w, cy = (ci / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!walk(nx, ny)) continue;
      if (dx && dy && !(walk(cx + dx, cy) || walk(cx, cy + dy))) continue; // no corner cut
      const ni = at(nx, ny);
      if (!seen[ni]) { seen[ni] = 1; q.push(ni); }
    }
  }
  const MIN_TOWN_DIST = 6;
  const candidates = [];
  for (let i = 0; i < w * h; i++) {
    if (!seen[i] || tiles[i].objectId) continue;
    const x = i % w, y = (i / w) | 0;
    if (map.grail && map.grail.x === x && map.grail.y === y) continue;
    if (keyPoints.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) < MIN_TOWN_DIST)) continue;
    // ROOM TO BREATHE — but ONE tile of it, not the two every sibling asks for,
    // and the difference was measured rather than assumed.
    //
    // This was the only placer with no clearance test at all: 13.3% of Trees and
    // Libraries over 60 maps of 44x36 had a monster standing on one of their
    // eight neighbours. The site stays collectable (the post-victory re-run
    // grants it), so it is not a soft-lock — it is an accidentally GUARDED prize
    // the generator never sized a guard for.
    //
    // The obvious fix is the Chebyshev 2 ring `fits` and ObjectPlacer.findSpot
    // use, and it is wrong HERE. Scholar sites are placed LAST on the surface, so
    // by the time this runs the interior is already dense; demanding a clear 5x5
    // starves the candidate pool of inland tiles and pins the prizes to the rim:
    //
    //     ring   monster-adjacent   within 1 tile of the border   mean border dist
    //       0         13.3%                   20.0%                     5.8
    //       1          0.0%                   41.7%                     4.7
    //       2          0.0%                   80.8%                     1.3
    //
    // Ring 2 trades a 13% blemish for four fifths of the prizes hugging the map
    // edge, which is precisely the "cluster in one corner" the comment below
    // says a library must not be. Ring 1 removes the defect outright — nothing is
    // adjacent to a scholar site any more — and costs a fifth of the inland
    // spread rather than three quarters of it.
    if (hasNeighbourWithin(map, x, y, 1)) continue;
    candidates.push({ x, y });
  }
  if (!candidates.length) return;
  const take = () => candidates.splice(rng.int(0, candidates.length - 1), 1)[0];

  const tree = take();
  placeObject(map, tree.x, tree.y, { type: 'booster', boosterType: 'treeOfKnowledge' });
  // Libraries: one on medium-and-up maps, and MORE as the land grows — "more
  // libraries on the larger maps". A great map should be worth crossing for what it
  // teaches, not only for what it holds, and one library on a 144x120 board is a
  // rounding error. Each is kept well clear of the Tree and of its own kind, so they
  // are a reason to travel rather than a cluster in one corner.
  if (w * h >= 44 * 36) {
    const want = 1 + Math.floor((w * h) / CONFIG.LIBRARY_PER_TILES);
    const placed = [tree];
    for (let i = 0; i < want; i++) {
      const far = candidates.filter((c) => placed
        .every((p) => Math.abs(c.x - p.x) + Math.abs(c.y - p.y) >= 8));
      if (!far.length) break;
      const lib = far[rng.int(0, far.length - 1)];
      placeObject(map, lib.x, lib.y, { type: 'booster', boosterType: 'library' });
      placed.push(lib);
      const at = candidates.indexOf(lib);
      if (at >= 0) candidates.splice(at, 1);
    }
  }
}

/**
 * Seat a single BOSS LAIR (see BOSS_LAIRS) on medium-and-larger maps: reachable
 * open land, off the certified pass corridors, with room to breathe — exactly
 * the creatureBank seating rule, but rare (one apex prize per map). A boss lair
 * IS a creatureBank object (a boss-typed bankType), so combat/reward/view all
 * treat it like any bank. Runs in the tail-rng surface pass (see 8h), so it
 * shifts nothing already placed.
 */
function placeBossLairs(map, rng, starts, forbid = null) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  if (w * h < REFERENCE_AREA) return []; // bosses only on reference-size maps and up
  const seen = townWalkFlood(map, starts, WALK_SOLID_LANDMARKS);
  for (let attempt = 0; attempt < 600; attempt++) {
    const x = rng.int(2, w - 3), y = rng.int(2, h - 3), i = idx(x, y);
    if (!seen[i] || map.tiles[i].objectId) continue;
    if (forbid && forbid[i]) continue;
    let crowded = false;
    for (let dy = -2; dy <= 2 && !crowded; dy++) for (let dx = -2; dx <= 2 && !crowded; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (map.tiles[idx(nx, ny)].objectId) crowded = true;
    }
    if (crowded) continue;
    const bankType = rng.pick(BOSS_LAIR_TYPES);
    return [placeObject(map, x, y, {
      type: 'creatureBank', bankType, looted: false,
      guards: BOSS_LAIRS[bankType].guards.map((gg) => ({ ...gg })),
    })];
  }
  return [];
}

/**
 * Scatter a few external creature dwellings (see DWELLINGS) on reachable open
 * land, each seeded with one week of its creature's growth so it's useful from
 * day one. Same seating rule + tail-rng discipline as the boss/scholar passes,
 * so it shifts nothing already placed. Non-blocking (a hero stands on one to
 * recruit), so unlike a bank they never wall off a corridor.
 *
 * FAIRNESS: a dwelling is permanent recruitment industry, so unlike one-shot
 * loot the two starting realms must get comparable counts — side-blind seating
 * drifted to a 2-3 dwelling swing on large maps, a real weekly-army edge for
 * one player. Seats therefore ALTERNATE sides of the zone seam (the same split
 * the mine/artifact balance uses), holding the gap to at most one; a single
 * rng draw picks which side leads, so neither player is systematically the
 * one to get the odd extra. A side too crowded to seat falls back to anywhere
 * reachable — shipping the content beats a perfect ledger.
 */
function placeDwellings(map, rng, starts, forbid = null) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const scale = (w * h) / REFERENCE_AREA;
  const count = Math.max(1, Math.round(2.5 * Math.max(scale, 0.6)));
  const seen = townWalkFlood(map, starts, WALK_SOLID_LANDMARKS);
  // The generator's own zone split (see generateMap's zoneS): 0 = the
  // bottom-left realm, 1 = the top-right.
  const sideOf = (x, y) => (Math.hypot(x, (h - 1) - y) - Math.hypot((w - 1) - x, y) < 0 ? 0 : 1);
  const lead = rng.int(0, 1);
  const placed = [];
  for (let k = 0; k < count; k++) {
    const want = (k + lead) % 2;
    let spot = null;
    for (let attempt = 0; attempt < 800 && !spot; attempt++) {
      const x = rng.int(2, w - 3), y = rng.int(2, h - 3), i = idx(x, y);
      // First half of the budget insists on the balancing side; the second
      // half takes any side rather than dropping the dwelling altogether.
      if (attempt < 400 && sideOf(x, y) !== want) continue;
      if (!seen[i] || map.tiles[i].objectId) continue;
      if (forbid && forbid[i]) continue;
      let crowded = false;
      for (let dy = -1; dy <= 1 && !crowded; dy++) for (let dx = -1; dx <= 1 && !crowded; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (map.tiles[idx(nx, ny)].objectId) crowded = true;
      }
      if (crowded) continue;
      spot = { x, y };
    }
    if (!spot) continue; // best-effort, like every tail placer
    const dwellingType = rng.pick(DWELLING_TYPES);
    const growth = CREATURES[DWELLINGS[dwellingType].creature]?.growth || 0;
    placed.push(placeObject(map, spot.x, spot.y, {
      type: 'dwelling', dwellingType, available: growth, owner: -1,
    }));
  }
  return placed;
}

/**
 * Trading Posts: a merchant stall or two (reference size and up) where a hero
 * sells artifacts for XP or buys them for resources. Seated in the TAIL of the
 * main rng (like scholar sites / boss lairs / dwellings), so it shifts NOTHING
 * already placed — reachable, uncrowded open land inside the towns' walk flood.
 */
function placeTradingPosts(map, rng, starts, forbid = null, alreadyPlaced = null) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const scale = (w * h) / REFERENCE_AREA;
  if (scale < 1) return []; // small maps stay lean, like seer huts
  const count = Math.max(1, Math.round(TRADING_POSTS_BASE * scale));
  const seen = townWalkFlood(map, starts, WALK_SOLID_LANDMARKS);
  const placed = [];
  for (let attempt = 0; attempt < 800 && placed.length < count; attempt++) {
    const x = rng.int(2, w - 3), y = rng.int(2, h - 3), i = idx(x, y);
    if (!seen[i] || map.tiles[i].objectId) continue;
    if (forbid && forbid[i]) continue;
    let crowded = false;
    for (let dy = -1; dy <= 1 && !crowded; dy++) for (let dx = -1; dx <= 1 && !crowded; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (map.tiles[idx(nx, ny)].objectId) crowded = true;
    }
    if (crowded) continue;
    placed.push(placeObject(map, x, y, { type: 'tradingPost', stock: tradingPostStock(rng, alreadyPlaced) }));
  }
  return placed;
}

// A spur to a mine gives up if the nearest highway is farther than this many
// tiles — a mine out in the deep wilds stays off the grid rather than trailing
// an absurd cross-map path.
const MAX_SPUR = 10;

/**
 * Lay a deterministic road network over ONE map level. Two tiers:
 *   1. main highways (`opts.main`, default cobble — the fastest road): a
 *      minimum spanning tree connecting every road TERMINUS on this level —
 *      its towns AND its subterranean gate mouths — each edge the shortest
 *      LAND path (8-dir BFS, no obstacle-corner cutting). Gates count because
 *      they are where a hero ENTERS a level: descending drops you straight
 *      onto the network, and a cavern level with a single town still gets a
 *      real highway (town ↔ gates) instead of standing trackless — every
 *      town, on either level, touches a road. (On the surface this pass runs
 *      BEFORE the underground exists, so no gates are present yet and the
 *      surface network is exactly the towns-only MST it always was.)
 *   2. spurs (`opts.spur`, default dirt): each mine is joined to the nearest
 *      existing road by a short branch, so economy runs ride the network too.
 * Roads discount movement (stepCost → CONFIG.ROAD_COST). Pure geometry, no rng
 * draws, so every other placement is byte-identical with or without it; roads
 * only overlay already-open ground and never downgrade a better road, so they
 * can neither strand an object nor overwrite a highway with a spur.
 */
function layRoads(map, { main = 'cobble', spur = 'dirt' } = {}) {
  const { w, h, tiles } = map;
  const at = (x, y) => y * w + x;
  const open = (x, y) => x >= 0 && y >= 0 && x < w && y < h
    && tiles[at(x, y)].terrain !== 'water' && !tiles[at(x, y)].obstacle;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const neighbors = (ci, visit) => {
    const cx = ci % w, cy = (ci / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!open(nx, ny)) continue;
      if (dx && dy && !(open(cx + dx, cy) || open(cx, cy + dy))) continue; // no corner cut
      visit(at(nx, ny));
    }
  };
  /** Shortest land path (tile indices, goal→…→start) to the FIRST tile passing
   *  `stop`, or null. `stop(i)` receives a tile index (start excluded). */
  const bfsTo = (sx, sy, stop) => {
    const prev = new Int32Array(w * h).fill(-1);
    const seen = new Uint8Array(w * h);
    const start = at(sx, sy);
    const q = [start];
    seen[start] = 1;
    for (let head = 0; head < q.length; head++) {
      const ci = q[head];
      if (ci !== start && stop(ci)) {
        const path = [];
        for (let i = ci; i !== -1; i = prev[i]) path.push(i);
        return path;
      }
      neighbors(ci, (ni) => { if (!seen[ni]) { seen[ni] = 1; prev[ni] = ci; q.push(ni); } });
    }
    return null;
  };

  // ---- 1. Main highways: a Prim MST over the termini — this level's towns
  // and subterranean gate mouths (nearest wins, ties by array order —
  // deterministic). Painted `main`, overriding any spur below.
  const nodes = Object.values(map.objects).filter(
    (o) => o.type === 'town' || o.type === 'subGate',
  );
  const n = nodes.length;
  const inTree = new Array(n).fill(false);
  inTree[0] = true;
  const d2 = (a, b) => (nodes[a].x - nodes[b].x) ** 2 + (nodes[a].y - nodes[b].y) ** 2;
  for (let added = 1; added < n; added++) {
    let from = -1, to = -1, best = Infinity;
    for (let a = 0; a < n; a++) {
      if (!inTree[a]) continue;
      for (let b = 0; b < n; b++) {
        if (inTree[b]) continue;
        const dd = d2(a, b);
        if (dd < best) { best = dd; from = a; to = b; }
      }
    }
    if (to < 0) break;
    inTree[to] = true;
    const t = nodes[to];
    const path = bfsTo(t.x, t.y, (i) => i === at(nodes[from].x, nodes[from].y));
    if (path) for (const i of path) tiles[i].road = main;
  }

  // ---- 2. Spurs: branch each mine to the nearest existing road (`spur`), so a
  // hero flagging mines rides the network. Only paints roadless tiles, so it
  // never downgrades the highway it joins, and gives up past MAX_SPUR tiles.
  const hasRoad = (i) => !!tiles[i].road;
  for (const obj of Object.values(map.objects)) {
    if (obj.type !== 'mine') continue;
    const path = bfsTo(obj.x, obj.y, hasRoad);
    if (!path || path.length - 1 > MAX_SPUR) continue;
    for (const i of path) if (!tiles[i].road) tiles[i].road = spur;
  }
}

/**
 * For each big lake: a boat at a foot-reachable shore, plus a sea-locked islet
 * (a lone land tile ringed entirely by water) holding a reward, raised from a
 * water tile the boat can reach. Foot heroes can never touch the islet (all its
 * neighbours are water); a boarded hero sails over and disembarks onto it.
 */
function placeBoatsAndIslands(map, bigLakes, starts, rng) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const isWater = (x, y) => { const t = map.tiles[idx(x, y)]; return !!t && t.terrain === 'water'; };
  // Land foot-reachable from the towns (boats/shipyards predate subGates, so the
  // smaller solid set — see townWalkFlood).
  const seen = townWalkFlood(map, starts, WALK_SOLID_TOWN_PORTAL);

  for (const lake of bigLakes) {
    // 1) Boat at a foot-reachable shore.
    let boatTile = null;
    for (let rad = 1; rad <= lake.r + 1 && !boatTile; rad++) {
      for (let dy = -rad; dy <= rad && !boatTile; dy++) {
        for (let dx = -rad; dx <= rad && !boatTile; dx++) {
          const x = lake.x + dx, y = lake.y + dy;
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          const tl = map.tiles[idx(x, y)];
          if (tl.terrain !== 'water' || tl.objectId) continue;
          let shore = false;
          for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = map.tiles[idx(x + ex, y + ey)];
            if (n && n.terrain !== 'water' && !n.obstacle && !n.objectId && seen[idx(x + ex, y + ey)]) { shore = true; break; }
          }
          if (!shore) continue;
          placeObject(map, x, y, { type: 'boat' });
          boatTile = { x, y };
        }
      }
    }
    if (!boatTile) continue;

    // 2) The water the boat can reach (4-dir over water tiles).
    const comp = new Uint8Array(w * h);
    const q = [idx(boatTile.x, boatTile.y)]; comp[q[0]] = 1;
    while (q.length) {
      const i = q.pop(), x = i % w, y = (i / w) | 0;
      for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ex, ny = y + ey;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = idx(nx, ny);
        if (!comp[j] && isWater(nx, ny)) { comp[j] = 1; q.push(j); }
      }
    }

    // 3) An interior water tile (all 8 neighbours water, no object) the boat can
    //    reach, nearest the lake centre — raising it leaves a docked islet.
    let best = null, bestD = Infinity;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = idx(x, y);
        if (!comp[i] || map.tiles[i].objectId) continue;
        let interior = true;
        for (let ny = y - 1; ny <= y + 1 && interior; ny++) {
          for (let nx = x - 1; nx <= x + 1 && interior; nx++) {
            if (nx === x && ny === y) continue;
            if (!isWater(nx, ny)) interior = false;
          }
        }
        if (!interior) continue;
        const d = Math.hypot(x - lake.x, y - lake.y);
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
    }
    if (!best) continue;

    // 4) Raise the islet and drop a sea-locked reward on it.
    const tl = map.tiles[idx(best.x, best.y)];
    tl.terrain = 'sand'; tl.obstacle = null;
    placeObject(map, best.x, best.y, islandReward(rng));
  }
}

/**
 * One neutral shipyard per big lake: `{ type: 'shipyard', x, y }`, usable by
 * ANY visiting hero (no owner) to have a boat built for CONFIG.BOAT_COST (see
 * actions.buildBoat). Surface only — the underground has no water. The tile is
 * WALKABLE-THROUGH like a mine (never added to the solid/blocking type lists),
 * so pathing, the connectivity carve and surfaceStillLinked all treat it as
 * open ground; stepping onto it is what offers the build.
 *
 * Placement contract, re-verified by tests/shipyards.test.js:
 *   - a land tile, no obstacle/object, FOOT-REACHABLE from both towns (chosen
 *     inside the towns' walk flood, which the carve has already connected);
 *   - an orthogonally adjacent, object-free water tile — the dock a new boat
 *     spawns on, boardable in one straight step (no corner-cut subtleties);
 *   - a clear 8-ring (no neighbouring object), so the dock starts unclogged;
 *   - deterministic: a pure expanding scan around each lake, no rng draws, so
 *     the boats/islands placed before it are byte-identical to pre-shipyard
 *     output and two runs of one seed agree.
 * Best-effort per lake: a coast with no qualifying tile simply gets no yard.
 */
function placeShipyards(map, bigLakes, starts) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  // Land foot-reachable from the towns (same small solid set as the boats — see
  // townWalkFlood).
  const seen = townWalkFlood(map, starts, WALK_SOLID_TOWN_PORTAL);

  const placed = [];
  for (const lake of bigLakes) {
    let spot = null;
    for (let rad = 1; rad <= lake.r + 2 && !spot; rad++) {
      for (let dy = -rad; dy <= rad && !spot; dy++) {
        for (let dx = -rad; dx <= rad && !spot; dx++) {
          const x = lake.x + dx, y = lake.y + dy;
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          const i = idx(x, y);
          const tl = map.tiles[i];
          // Open, foot-reachable coast land only.
          if (tl.terrain === 'water' || tl.obstacle || tl.objectId || !seen[i]) continue;
          // Breathing ring: no object beside the yard (keeps the dock clear
          // and no guard's zone of control swallows the doorstep).
          let crowded = false;
          for (let ny = y - 1; ny <= y + 1 && !crowded; ny++) {
            for (let nx = x - 1; nx <= x + 1 && !crowded; nx++) {
              if (map.tiles[idx(nx, ny)].objectId) crowded = true;
            }
          }
          if (crowded) continue;
          // The dock: an orthogonally adjacent free water tile.
          let dock = false;
          for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = map.tiles[idx(x + ex, y + ey)];
            if (n && n.terrain === 'water' && !n.objectId) { dock = true; break; }
          }
          if (!dock) continue;
          // Overlapping lakes merge into one body — keep yards genuinely apart
          // so a single body never sprouts a marina.
          if (placed.some((p) => Math.abs(p.x - x) < 8 && Math.abs(p.y - y) < 8)) continue;
          spot = { x, y };
        }
      }
    }
    if (!spot) continue;
    placeObject(map, spot.x, spot.y, { type: 'shipyard' });
    placed.push(spot);
  }
}

// Whirlpool placement tuning: a water body must be at least this many tiles
// to host a whirlpool (small ponds churn nothing)…
const WHIRLPOOL_MIN_BODY = 12;
// …and two whirlpools never sit closer than this (a swirl is a JOURNEY, and
// spacing keeps the pair from reading as one blob on the map).
const WHIRLPOOL_SPACING = 8;

/**
 * Whirlpools: the sea's random-destination teleporters (see actions.js →
 * useWhirlpool — a boat hero ending a move on one is swept to a random OTHER
 * whirlpool and loses part of its weakest stack). Placement contract, pinned
 * by tests/whirlpools.test.js:
 *   - SURFACE ONLY (the underground is dry), and only on DEEP water: the tile
 *     and all 8 of its neighbours are object-free water. The full water ring
 *     means a whirlpool can never block a channel (a boat always sails around
 *     it — it is a through-wall for pathing), never sits on a boat, a
 *     shipyard dock or an islet shore, and never touches the land carve;
 *   - an area-scaled count (2 at the 44x36 reference, capped at 4), seated on
 *     DIFFERENT water bodies first — the whole point is jumping between
 *     separate seas — then second helpings on the biggest bodies, always
 *     ≥ WHIRLPOOL_SPACING apart;
 *   - all-or-nothing: fewer than 2 seatable spots means NONE are placed. A
 *     lone whirlpool is inert churn (useWhirlpool needs a partner), so a
 *     water-poor or landlocked map simply goes without;
 *   - deterministic: a pure row-major scan, no rng draws, so one surface
 *     always seats the same whirlpools and two runs of a seed agree.
 * Exported for direct unit-testing on synthetic seas; returns the placed
 * whirlpool objects (possibly an empty array).
 */
export function placeWhirlpools(map) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const isWater = (x, y) => x >= 0 && y >= 0 && x < w && y < h
    && map.tiles[idx(x, y)].terrain === 'water';

  // 1. Label the water bodies (4-dir flood, row-major seeds — deterministic).
  const label = new Int32Array(w * h).fill(-1);
  const bodies = []; // { id, size, candidates[] } in first-seen order
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (label[i] !== -1 || map.tiles[i].terrain !== 'water') continue;
      const id = bodies.length;
      let size = 0;
      const stack = [i];
      label[i] = id;
      while (stack.length) {
        const j = stack.pop();
        size++;
        const jx = j % w, jy = (j / w) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!isWater(jx + dx, jy + dy)) continue;
          const k = idx(jx + dx, jy + dy);
          if (label[k] === -1) { label[k] = id; stack.push(k); }
        }
      }
      bodies.push({ id, size, candidates: [] });
    }
  }

  // 2. Deep-water candidates per body, in scan order: the tile and its whole
  //    8-ring are object-free water. The ring is 4-connected around the
  //    centre, so seating a (through-blocking) whirlpool here provably never
  //    splits its water body — any route through the tile reroutes around it.
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y);
      if (map.tiles[i].terrain !== 'water' || map.tiles[i].objectId) continue;
      let deep = true;
      for (let dy = -1; dy <= 1 && deep; dy++) {
        for (let dx = -1; dx <= 1 && deep; dx++) {
          if (!dx && !dy) continue;
          if (!isWater(x + dx, y + dy) || map.tiles[idx(x + dx, y + dy)].objectId) deep = false;
        }
      }
      if (deep) bodies[label[i]].candidates.push({ x, y });
    }
  }

  // 3. Pick the spots: one per qualifying body, biggest seas first, then a
  //    second round of helpings on the same ranking until the target count is
  //    met. Spacing is enforced across ALL picks (round two included).
  const target = Math.max(2, Math.min(4, Math.round(2 * (w * h) / REFERENCE_AREA)));
  const ranked = bodies
    .filter((b) => b.size >= WHIRLPOOL_MIN_BODY && b.candidates.length)
    .sort((a, b) => b.size - a.size || a.id - b.id);
  const spots = [];
  const farEnough = (c) => spots.every(
    (s) => Math.hypot(s.x - c.x, s.y - c.y) >= WHIRLPOOL_SPACING,
  );
  for (let round = 0; round < 2 && spots.length < target; round++) {
    for (const b of ranked) {
      if (spots.length >= target) break;
      const c = b.candidates.find(farEnough);
      if (c) spots.push(c);
    }
  }

  // 4. All-or-nothing: a lone whirlpool would be dead content.
  if (spots.length < 2) return [];
  return spots.map((s) => placeObject(map, s.x, s.y, { type: 'whirlpool' }));
}

// Landmark densities at the 44x36 reference (both scale with area). Obelisks
// are the signature landmark of big scenario maps — deliberately the most
// numerous booster class on any size.
const OBELISKS_BASE = 6;
const MOVE_CAMPS_BASE = 2;
const WINDMILLS_BASE = 2;    // weekly random-resource visitable (any land)
const WATER_WHEELS_BASE = 1; // weekly gold visitable (must border water)
const OBSERVATORIES_BASE = 1; // wide fog-reveal (any land)
const HILL_FORTS_BASE = 1;    // in-field army upgrade (any land)
const MAGIC_SPRINGS_BASE = 1; // weekly double-mana (any land)
const WITCH_HUTS_BASE = 1.5;  // teaches a fixed secondary skill (any land)
const SHRINES_BASE = 1.5;     // teaches a fixed combat spell (any land)
const SEER_HUTS_BASE = 1.5;   // fetch-quest visitable — tribute for a reward (any land)
const TRADING_POSTS_BASE = 1; // merchant stall — sell artifacts for XP, buy them for resources

/**
 * Obelisks + wayfarer's camps: the surface's unguarded landmark visitables
 * (see actions.applyBooster — an obelisk scouts a CONFIG.OBELISK_REVEAL disc
 * and pays one-time XP; a camp grants CONFIG.MOVE_BOOST movement once per
 * hero per day). Placement contract, pinned by tests/scenario-epic.test.js:
 *   - only on open land INSIDE the towns' walk flood (the same strict 4-dir
 *     discipline as the carve's certification, so every landmark is provably
 *     foot-reachable from every start town);
 *   - never in a pass corridor (`forbid` — the guard keeps its bottleneck
 *     clear) and never within 2 tiles of another object (the placer's usual
 *     breathing ring);
 *   - non-solid and zero terrain edits: nothing placed before this pass
 *     moves, so per-seed output up to here is byte-identical to pre-landmark
 *     builds — whirlpool/shipyard/boat seating included.
 * Area-scaled counts (OBELISKS_BASE / MOVE_CAMPS_BASE at the reference),
 * best-effort: a crowded map seats fewer, never throws. Returns the placed
 * objects.
 */
function placeLandmarks(map, rng, starts, forbid, richLands = false) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const scale = (w * h) / REFERENCE_AREA;
  // Land foot-reachable from the towns (see townWalkFlood).
  const seen = townWalkFlood(map, starts, WALK_SOLID_LANDMARKS);

  // Rich Lands: a wheel may stand a short leat from the water, which is what
  // makes three of them seatable on a small, mostly-dry map.
  const nearWater = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (map.tiles[idx(nx, ny)].terrain === 'water') return true;
      }
    }
    return false;
  };
  // A Water Wheel must sit beside water (it needs a stream to turn).
  const bordersWater = (x, y) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (map.tiles[idx(nx, ny)].terrain === 'water') return true;
    }
    return false;
  };

  const placed = [];
  // Is (x,y) a qualifying seat? Reachable, free, off the corridors, passing the
  // caller's `extra` predicate, with the usual 2-tile breathing ring.
  const fits = (x, y, extra) => {
    const i = idx(x, y);
    if (!seen[i] || map.tiles[i].objectId || (forbid && forbid[i])) return false;
    if (extra && !extra(x, y)) return false;
    // Breathing ring: no other object within 2 tiles (matches findSpot).
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (map.tiles[idx(nx, ny)].objectId) return false;
      }
    }
    return true;
  };
  // Find a free, uncrowded land spot (or null when NO tile qualifies). `extra`
  // is an optional per-tile predicate (e.g. must border water). Shared by
  // drop() and dropObjects() so both consume the rng stream identically.
  // Random tries first, so landmarks stay scattered; when all 200 lapse on a
  // crowded map, a deterministic row-major sweep takes the first qualifying
  // tile instead of silently dropping the landmark — exact-quota contracts
  // (Rich Lands' weekly circuit) hold whenever qualifying land exists at all.
  // The sweep draws no rng, so the stream is identical either way.
  const findDropSpot = (extra) => {
    for (let tries = 0; tries < 200; tries++) {
      const x = rng.int(2, w - 3), y = rng.int(2, h - 3);
      if (fits(x, y, extra)) return { x, y };
    }
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (fits(x, y, extra)) return { x, y };
      }
    }
    return null; // genuinely full map: fewer landmarks, never a failure
  };
  // Drop `count` booster-type visitables. `props` an optional () =>
  // extra-object-fields (e.g. the skill/spell a hut teaches).
  const drop = (count, boosterType, extra = null, props = null) => {
    for (let k = 0; k < count; k++) {
      const spot = findDropSpot(extra);
      if (!spot) return;
      placed.push(placeObject(map, spot.x, spot.y, { type: 'booster', boosterType, ...(props ? props() : {}) }));
    }
  };
  // Drop `count` boosters, walking a list of seating predicates from strictest to
  // loosest and stopping as soon as the quota is met. Returns how many landed.
  const dropRelaxed = (count, boosterType, predicates) => {
    let placedN = 0;
    for (const pred of predicates) {
      while (placedN < count) {
        const spot = findDropSpot(pred);
        if (!spot) break; // this predicate is exhausted — try a looser one
        placed.push(placeObject(map, spot.x, spot.y, { type: 'booster', boosterType }));
        placedN++;
      }
      if (placedN >= count) break;
    }
    return placedN;
  };
  // Drop `count` weekly sites so they form a CIRCUIT rather than a cluster:
  // alternating zones so neither realm is starved, and never on a town's doorstep.
  // Relaxes in steps (side + far -> far -> anywhere) so a cramped map still meets
  // its quota rather than silently seating fewer.
  const dropSpread = (count, boosterType) => {
    const diag = Math.hypot(w, h);
    const sideOf = (x, y) => ((Math.hypot(x, (h - 1) - y) - Math.hypot((w - 1) - x, y)) / diag < 0 ? 0 : 1);
    const farFromTowns = (x, y) => !starts.some((t) =>
      Math.abs(t.x - x) + Math.abs(t.y - y) < CONFIG.WEEKLY_MIN_TOWN_DIST);
    const lead = rng.int(0, 1); // so neither side systematically gets the odd one
    let placedN = 0;
    for (let k = 0; k < count; k++) {
      const want = (k + lead) % 2;
      const preds = [
        (x, y) => farFromTowns(x, y) && sideOf(x, y) === want,
        farFromTowns,
        null,
      ];
      let spot = null;
      for (const pred of preds) { spot = findDropSpot(pred); if (spot) break; }
      if (!spot) break;
      placed.push(placeObject(map, spot.x, spot.y, { type: 'booster', boosterType }));
      placedN++;
    }
    return placedN;
  };
  // Drop `count` arbitrary objects; `make()` returns the object's fields (type +
  // payload) — for visitables that are their own object type, not boosters.
  const dropObjects = (count, make, extra = null) => {
    for (let k = 0; k < count; k++) {
      const spot = findDropSpot(extra);
      if (!spot) return;
      placed.push(placeObject(map, spot.x, spot.y, make()));
    }
  };
  // Rich Lands seats the weekly sites FIRST. The stock Water Wheel drop runs
  // last, by which point a small map's few shore tiles are taken or crowded —
  // which is why small and medium maps reliably ended up with none at all.
  let wheelsSeated = 0;
  if (richLands) {
    // Progressive relaxation. Strict shore adjacency is why a small map ends up
    // with no wheel at all: its water sits in a few pockets that are either
    // unreachable or already crowded. Try beside the water, then a short leat
    // away, then anywhere reachable — a mill without a visible stream is a small
    // flavour cost against the mechanic not existing on the map.
    // A stop on a town's doorstep is not a circuit stop, so each ladder rung now
    // prefers ground away from any town before it settles for one beside it.
    const farFromTowns = (x, y) => !starts.some((t) =>
      Math.abs(t.x - x) + Math.abs(t.y - y) < CONFIG.WEEKLY_MIN_TOWN_DIST);
    wheelsSeated = dropRelaxed(CONFIG.RICH_LANDS_WATER_WHEELS, 'waterWheel', [
      (x, y) => bordersWater(x, y) && farFromTowns(x, y),
      (x, y) => nearWater(x, y) && farFromTowns(x, y),
      bordersWater, nearWater, null,
    ]);
    dropSpread(CONFIG.RICH_LANDS_TRADE_FAIRS, 'tradeFair');
    dropSpread(CONFIG.RICH_LANDS_WINDMILLS, 'windmill');
  }
  drop(Math.max(3, Math.round(OBELISKS_BASE * scale)), 'obelisk');
  drop(Math.max(1, Math.round(MOVE_CAMPS_BASE * scale)), 'move');
  dropSpread(Math.max(1, Math.round(WINDMILLS_BASE * scale)), 'windmill');
  drop(Math.max(1, Math.round(OBSERVATORIES_BASE * scale)), 'observatory');
  drop(Math.max(1, Math.round(HILL_FORTS_BASE * scale)), 'hillFort');
  drop(Math.max(1, Math.round(MAGIC_SPRINGS_BASE * scale)), 'magicSpring');
  // Learning visitables only from the 44x36 reference size up — small maps stay
  // lean (and byte-identical to the pre-feature baseline), so a cramped tiny map
  // can't run the underground-gate placement out of room.
  if (scale >= 1) {
    drop(Math.max(1, Math.round(WITCH_HUTS_BASE * scale)), 'witchHut', null, () => ({ skill: rng.pick(WITCH_HUT_SKILLS) }));
    if (SHRINE_SPELLS.length) {
      drop(Math.max(1, Math.round(SHRINES_BASE * scale)), 'shrine', null, () => ({ spell: rng.pick(SHRINE_SPELLS) }));
    }
    dropObjects(Math.max(1, Math.round(SEER_HUTS_BASE * scale)), () => ({ type: 'seerHut', done: false, ...seerHutPayload(rng) }));
  }
  // Water Wheels only land where the map offers a coastline; a water-poor map
  // simply gets none (findDropSpot exhausts the shore gracefully). Rich Lands
  // seated its exact wheel quota up front, so its stock ration covers only any
  // SHORTFALL beyond that — otherwise the guaranteed sweep would overfill the
  // weekly circuit past the feature's pinned count.
  dropRelaxed(Math.max(richLands ? 0 : 1, Math.round(WATER_WHEELS_BASE * scale) - wheelsSeated), 'waterWheel', [
    (x, y) => bordersWater(x, y) && !starts.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) < CONFIG.WEEKLY_MIN_TOWN_DIST),
    bordersWater,
  ]);
  return placed;
}

/** The prize behind a Border Guard — worth the detour to fetch the key. */
function keyVaultReward(rng) {
  const roll = rng.random();
  if (roll < 0.4) return { type: 'resource', resource: 'gold', amount: rng.int(3500, 6000) };
  if (roll < 0.7) return { type: 'chest' };
  const r = rng.pick(['gems', 'crystal', 'mercury', 'sulfur']);
  return { type: 'resource', resource: r, amount: rng.int(8, 16) };
}

/** Seat a Keymaster Tent on reachable, uncrowded open land; returns it or null. */
function placeKeymaster(map, rng, reachSeen, color) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  for (let tries = 0; tries < 300; tries++) {
    const x = rng.int(2, w - 3), y = rng.int(2, h - 3), i = idx(x, y);
    if (!reachSeen[i] || map.tiles[i].objectId) continue;
    let crowded = false;
    for (let dy = -2; dy <= 2 && !crowded; dy++) for (let dx = -2; dx <= 2 && !crowded; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (map.tiles[idx(nx, ny)].objectId) crowded = true;
    }
    if (crowded) continue;
    return placeObject(map, x, y, { type: 'keymaster', color });
  }
  return null;
}

/**
 * Colored-key gated caches (HoMM3's Keymaster Tent + Border Guard). Each vault
 * uses a NATURAL dead-end: a reward tile whose only open, object-free neighbour
 * becomes the Border Guard's tile — so the reward is reachable ONLY by a hero who
 * first earns the matching key at the Keymaster Tent, and NO terrain is edited
 * (zero risk to the carve / underground-gate placement; the guard is walkable-
 * through in every reachability check, exactly like a mine). Placed AFTER the
 * carve (like the boats/grail). Reference-size maps and up only, so small maps
 * stay byte-identical to baseline. `starts` are the town seeds.
 */
function placeKeyVaults(map, rng, starts, forbid = null) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const scale = (w * h) / REFERENCE_AREA;
  if (scale < 1) return [];
  const colors = CONFIG.KEY_COLORS;
  const target = Math.min(colors.length, Math.max(1, Math.round(2 * scale)));

  const solidTile = (i) => {
    const id = map.tiles[i].objectId;
    if (!id) return false;
    const ty = map.objects[id].type;
    return ty === 'town' || ty === 'portal' || ty === 'subGate';
  };
  const openLand = (i) => {
    const tl = map.tiles[i];
    return tl.terrain !== 'water' && !tl.obstacle && !solidTile(i);
  };
  // Town-reachable open land (guards read as passable — they never seal the map).
  // openLand above is reused below for the dead-end check, so keep it.
  const seen = townWalkFlood(map, starts, WALK_SOLID_LANDMARKS);
  const nbs4 = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy, i: idx(x + dx, y + dy) }))
    .filter((n) => n.x >= 1 && n.y >= 1 && n.x < w - 1 && n.y < h - 1);

  const placed = [];
  for (let attempt = 0; attempt < 800 && placed.length < target; attempt++) {
    const px = rng.int(3, w - 4), py = rng.int(3, h - 4), pi = idx(px, py);
    if (!seen[pi] || map.tiles[pi].objectId) continue;
    // Never seat on a pass corridor: the reward + guard pair blocks runtime
    // through-traffic, and a 1-wide pass with a Border Guard in it is a wall.
    if (forbid && forbid[pi]) continue;
    // A genuine dead-end: exactly ONE reachable, object-free, open-land neighbour
    // — the only way in, where the guard will stand.
    const open = nbs4(px, py).filter((n) => openLand(n.i) && !map.tiles[n.i].objectId && seen[n.i]);
    if (open.length !== 1) continue;
    const entrance = open[0];
    if (map.tiles[entrance.i].objectId) continue;
    if (forbid && forbid[entrance.i]) continue; // the guard tile itself must stay off corridors
    // Breathing room around both tiles (no other object touching them).
    let crowded = false;
    for (const c of [{ x: px, y: py }, entrance]) {
      for (let dy = -1; dy <= 1 && !crowded; dy++) for (let dx = -1; dx <= 1 && !crowded; dx++) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const oid = map.tiles[idx(nx, ny)].objectId;
        if (oid && map.objects[oid]?.type !== 'town') crowded = true;
      }
    }
    if (crowded) continue;

    const color = colors[placed.length % colors.length].id;
    // Seat the tent on freely-reachable land FIRST — a guard with no findable key
    // is worse than no vault. (The reward tile is a dead-end, so a tent can never
    // land in a gated pocket.)
    const tent = placeKeymaster(map, rng, seen, color);
    if (!tent) continue;
    seen[tent.i ?? idx(tent.x, tent.y)] = 1;
    placeObject(map, entrance.x, entrance.y, { type: 'borderGuard', color });
    placeObject(map, px, py, keyVaultReward(rng));
    placed.push({ color, guard: entrance, reward: { x: px, y: py }, tent: { x: tent.x, y: tent.y } });
  }
  return placed;
}

/**
 * Creature Banks: guarded one-time reward sites. Seated on reachable, uncrowded
 * open land (post-carve, like the vaults). A bank blocks through-traffic only at
 * runtime (it's a deliberate attack target); every generation reachability check
 * treats it as passable — like a mine — so it never strands an object or plugs a
 * corridor. The pool is weighted so easy banks are common and the Dragon Utopia
 * rare. Reference-size maps and up, so small maps stay byte-identical.
 */
function placeCreatureBanks(map, rng, starts, forbid = null) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const scale = (w * h) / REFERENCE_AREA;
  if (scale < 1) return [];
  const count = Math.max(1, Math.round(2.5 * scale));
  const pool = ['dwarvenTreasury', 'dwarvenTreasury', 'griffinConservatory', 'griffinConservatory', 'nagaBank', 'cyclopsStockpile', 'dragonUtopia'];
  // Land foot-reachable from the towns (see townWalkFlood).
  const seen = townWalkFlood(map, starts, WALK_SOLID_LANDMARKS);
  const placed = [];
  for (let attempt = 0; attempt < 600 && placed.length < count; attempt++) {
    const x = rng.int(2, w - 3), y = rng.int(2, h - 3), i = idx(x, y);
    if (!seen[i] || map.tiles[i].objectId) continue;
    // A bank blocks runtime through-traffic until beaten — keep it (and every
    // placer below) off the 1-wide pass corridors the carve certified open.
    if (forbid && forbid[i]) continue;
    let crowded = false;
    for (let dy = -2; dy <= 2 && !crowded; dy++) for (let dx = -2; dx <= 2 && !crowded; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (map.tiles[idx(nx, ny)].objectId) crowded = true;
    }
    if (crowded) continue;
    const bankType = rng.pick(pool);
    placed.push(placeObject(map, x, y, {
      type: 'creatureBank', bankType, looted: false,
      guards: CREATURE_BANKS[bankType].guards.map((gg) => ({ ...gg })),
    }));
  }
  return placed;
}

/**
 * Pandora's Boxes: one-time varied-reward objects. Same connectivity-safe seating
 * as the banks (reachable open land, post-carve, passable in every generation
 * check). Each box rolls a reward + guard (sometimes empty — a free find) that
 * are stamped on the object so they persist/replay. Reference-size maps and up.
 */
function placePandoraBoxes(map, rng, starts, forbid = null, physical = false) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const scale = (w * h) / REFERENCE_AREA;
  if (scale < 1) return [];
  const count = Math.max(1, Math.round(1.5 * scale));
  // Land foot-reachable from the towns (see townWalkFlood).
  const seen = townWalkFlood(map, starts, WALK_SOLID_LANDMARKS);
  const placed = [];
  // Boxes seat after the banks, so on a reward-dense surface the roomy 2-tile
  // ring can be starved. Degrade to a 1-tile ring on a second pass rather than
  // give up — a box tucked closer to a neighbour still plays fine, and the
  // intent (at least one box per reference map) is worth keeping.
  for (let ring = 2; ring >= 1 && placed.length < count; ring--) {
    for (let attempt = 0; attempt < 600 && placed.length < count; attempt++) {
      const x = rng.int(2, w - 3), y = rng.int(2, h - 3), i = idx(x, y);
      if (!seen[i] || map.tiles[i].objectId) continue;
      if (forbid && forbid[i]) continue; // a guarded box in a 1-wide pass seals it
      let crowded = false;
      for (let dy = -ring; dy <= ring && !crowded; dy++) for (let dx = -ring; dx <= ring && !crowded; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (map.tiles[idx(nx, ny)].objectId) crowded = true;
      }
      if (crowded) continue;
      // Roll reward first, then guard — a fixed draw order per box (deterministic).
      const reward = rollPandoraReward(rng);
      const guards = rollPandoraGuard(rng, reward, physical); // the guard is sized by the prize
      placed.push(placeObject(map, x, y, { type: 'pandora', looted: false, reward, guards }));
    }
  }
  return placed;
}

/**
 * One-way Monoliths: a network of 1 entrance + 1–2 same-colour exits. Stepping
 * on the entrance sweeps a hero to a RANDOM same-colour exit (never back);
 * exits are inert landmarks. Seated connectivity-safely (post-carve, on
 * reachable uncrowded open land, PASSABLE in every generation check — it only
 * blocks through-traffic at runtime, like a portal, so it never strands an
 * object). Reference-size maps and up, so small maps stay byte-identical.
 */
function placeMonoliths(map, rng, starts, forbid = null) {
  const { w, h } = map;
  const idx = (x, y) => y * w + x;
  const scale = (w * h) / REFERENCE_AREA;
  if (scale < 1) return [];
  const networks = Math.max(1, Math.round(scale));                  // 1 small → 2–3 large
  const exitsPer = scale >= 2 ? 2 : 1;                              // more destinations on big maps
  const minD = Math.min(16, Math.max(8, Math.round(w * 0.22)));     // a real one-way shortcut
  // Land foot-reachable from the towns (see townWalkFlood).
  const seen = townWalkFlood(map, starts, WALK_SOLID_LANDMARKS);
  // A random reachable, object-free, uncrowded (2-tile ring) tile — or null.
  const spot = () => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const x = rng.int(2, w - 3), y = rng.int(2, h - 3), i = idx(x, y);
      if (!seen[i] || map.tiles[i].objectId) continue;
      // A monolith ENTRANCE mid-corridor teleports every crosser away — the
      // pass would be uncrossable on foot. Keep all monoliths off corridors.
      if (forbid && forbid[i]) continue;
      let crowded = false;
      for (let dy = -2; dy <= 2 && !crowded; dy++) for (let dx = -2; dx <= 2 && !crowded; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (map.tiles[idx(nx, ny)].objectId) crowded = true;
      }
      if (!crowded) return { x, y };
    }
    return null;
  };
  const placed = [];
  for (let c = 0; c < networks; c++) {
    const entry = spot();
    if (!entry) break;
    const objE = placeObject(map, entry.x, entry.y, { type: 'monolith', dir: 'entrance', color: c });
    const exits = [];
    for (let e = 0; e < exitsPer; e++) {
      // The farthest uncrowded spot from the entrance over a few tries — a real trip.
      let best = null, bestD = minD;
      for (let t = 0; t < 12; t++) {
        const s = spot();
        if (!s) continue;
        const d = Math.hypot(s.x - entry.x, s.y - entry.y);
        if (d > bestD) { bestD = d; best = s; }
      }
      if (best) exits.push(placeObject(map, best.x, best.y, { type: 'monolith', dir: 'exit', color: c }));
    }
    if (!exits.length) { // no far exit → drop the orphan (a lone monolith is inert)
      map.tiles[entry.y * w + entry.x].objectId = null;
      delete map.objects[objE.id];
      continue;
    }
    placed.push({ entry: objE, exits });
  }
  return placed;
}

/** A worthwhile reward for a sea-locked islet (tagged so it is boat-only). */
function islandReward(rng) {
  const roll = rng.random();
  if (roll < 0.34) return { type: 'chest', seaLocked: true };
  if (roll < 0.67) {
    const r = rng.pick(['gold', 'gems', 'crystal', 'mercury', 'sulfur']);
    return { type: 'resource', resource: r, amount: r === 'gold' ? rng.int(1500, 2500) : rng.int(6, 12), seaLocked: true };
  }
  return { type: 'booster', boosterType: rng.pick(['attack', 'defense', 'power', 'knowledge']), seaLocked: true };
}

// ---------------------------------------------------------------------------
// Underground level
// ---------------------------------------------------------------------------

/**
 * Generate the underground: a w×h cavern layer under the surface, joined to it
 * by paired `subGate` objects (step on one → emerge on the other level's
 * partner, see actions.useSubGate). Layout contract:
 *   - The cavern is subterranean terrain (rough/dirt/lava) under a heavy rock
 *     scatter, hollowed into open chambers; the connectivity carve then links
 *     the chambers with tunnels, so the layer reads as caves, not fields.
 *   - No water down here. The underground is a contested treasure vault —
 *     rare-resource mines, high-value artifacts and stat boosters behind
 *     strong guards — anchored by a small, area-scaled number of NEUTRAL,
 *     capturable towns: each sits behind a genuine defending garrison and is
 *     registered through the same `registerTown` callback as the surface
 *     towns, so it lands in state.towns with z: 1 and every owner-keyed
 *     system (income, growth, starvation, victory) counts it automatically.
 *   - An area-scaled handful of intra-level portal pairs (1 small → 3 large,
 *     channels 100+, fresh underground counter) short-cut the caverns,
 *     exactly like the surface's pairs — see step 5 below.
 *   - Every gate's SURFACE end lands on open ground and is verified not to
 *     break the surface certification (a gate is solid, like a portal), so it
 *     stays reachable from BOTH towns. Every underground object — the towns,
 *     each gate's underground end, every prize — is then carved reachable
 *     from EVERY gate, with the same throw-on-failure discipline as the
 *     surface carve, so a hero can descend at any gate and reach everything.
 *   - Deterministic: driven entirely by `rng`, a stream derived from the
 *     mapgen seed; it never draws from the surface generator's stream. Town
 *     placement draws strictly AFTER the gate placement, so for a given seed
 *     the surface (including its gate entrances) is byte-for-byte what the
 *     town-less underground generator produced.
 */
function generateUnderground(map, rng, keyPoints, usedArtifacts, registerTown, forbid = null, physical = false) {
  const { w, h } = map;
  const scale = (w * h) / REFERENCE_AREA;
  const scaled = (base) => Math.max(1, Math.round(base * scale));
  // …and the same clamp on artifact seats as the surface (see generateMap).
  const artScale = Math.min(scale, CONFIG.ARTIFACT_DENSITY_CAP_AREA / REFERENCE_AREA);
  const scaledArt = (base) => Math.max(1, Math.round(base * artScale));
  const idx = (x, y) => y * w + x;

  const ug = { w, h, oidPrefix: 'U', tiles: new Array(w * h), objects: {}, nextOid: 1 };
  map.underground = ug;

  // ---- 1. Cavern shell ---------------------------------------------------
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = rng.random();
      const terrain = r < 0.55 ? 'rough' : r < 0.88 ? 'dirt' : 'lava';
      ug.tiles[idx(x, y)] = {
        terrain,
        // Ambient cavern rock. Kept SPARSE (was 0.5, which walled ~20% of the
        // open floor into unreachable pockets behind diagonal pinches — see
        // ug-reach harness): the chamber-hollowing + connectivity carve below
        // still shape rooms and corridors, but the floor between them stays
        // navigable rather than a misleading half-tile maze.
        obstacle: rng.chance(0.22) ? 'rock' : null,
        objectId: null,
        decor: rng.int(0, 1e9),
      };
    }
  }
  // Hollow out open chambers — the rooms treasure and guards live in.
  const chambers = Math.max(6, Math.round(12 * scale));
  for (let i = 0; i < chambers; i++) {
    const cx = rng.int(3, w - 4), cy = rng.int(3, h - 4);
    const r = rng.int(2, 4);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        if (Math.hypot(x - cx, y - cy) <= r && rng.chance(0.85)) {
          ug.tiles[idx(x, y)].obstacle = null;
        }
      }
    }
  }
  // A few molten pools for flavor (lava is walkable terrain, not a wall).
  for (let i = 0; i < scaled(3); i++) {
    const cx = rng.int(2, w - 3), cy = rng.int(2, h - 3);
    const r = rng.int(1, 2);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        if (Math.hypot(x - cx, y - cy) <= r) ug.tiles[idx(x, y)].terrain = 'lava';
      }
    }
  }

  // ---- 2. Gates ------------------------------------------------------------
  const pairs = Math.max(1, Math.min(4, Math.round(2 * scale)));
  const placer = new ObjectPlacer(ug, rng, physical);
  placer.usedArtifacts = usedArtifacts; // one artifact pool across both levels
  const gatesUp = [];   // surface ends
  const gatesDown = []; // underground ends — the carve's start points
  for (let k = 0; k < pairs; k++) {
    const sGate = placeSurfaceGate(map, rng, keyPoints, k, gatesUp, forbid);
    if (!sGate) {
      // The FIRST pair is the underground's lifeline and must exist; further
      // pairs are best-effort riches on roomy maps.
      if (k === 0) {
        throw new Error(
          'MapGenerator: could not place a subterranean gate on the surface '
          + 'without breaking object reachability.',
        );
      }
      break;
    }
    gatesUp.push({ x: sGate.x, y: sGate.y });
    // Underground end: an uncrowded open spot away from other gates; fall back
    // to any object-free tile (the carve links it regardless).
    let uSpot = null;
    for (let tries = 0; tries < 40 && !uSpot; tries++) {
      const spot = placer.findSpot(() => true, null);
      if (!spot) break;
      if (gatesDown.some((g) => Math.hypot(g.x - spot.x, g.y - spot.y) < 8)) continue;
      uSpot = spot;
    }
    if (!uSpot) {
      outer:
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          if (!ug.tiles[idx(x, y)].objectId
              && !gatesDown.some((g) => Math.abs(g.x - x) < 4 && Math.abs(g.y - y) < 4)) {
            uSpot = { x, y };
            break outer;
          }
        }
      }
    }
    if (!uSpot) { // a full grid of objects — cannot happen, but never orphan a gate
      map.tiles[sGate.y * w + sGate.x].objectId = null;
      delete map.objects[sGate.id];
      if (k === 0) throw new Error('MapGenerator: no room for an underground gate end.');
      gatesUp.pop();
      break;
    }
    clearArea(ug, uSpot.x, uSpot.y, 1); // the exit opens onto real ground
    placeObject(ug, uSpot.x, uSpot.y, { type: 'subGate', channel: k, color: k });
    gatesDown.push(uSpot);
  }

  // ---- 3. Neutral towns: the vault's strategic anchors --------------------
  // A small, area-scaled number of capturable towns makes the lower level a
  // real objective, not just a loot pile. Each is NEUTRAL (owner -1) behind a
  // heavy-budget garrison rolled from its faction's roster, and starts at the
  // same modest baseline as a surface start town. Towns are placed BEFORE the
  // loose treasure so they claim the roomy spots, and are solid landmarks for
  // the carve below (isSolidTile covers 'town'), whose per-gate certification
  // therefore guarantees every one of them is reachable from every gate — an
  // underground town can never generate walled-off.
  const townCount = undergroundTownCount(w, h);
  const ugTownSpots = [];
  for (let k = 0; k < townCount; k++) {
    let spot = null;
    for (let tries = 0; tries < 60 && !spot; tries++) {
      const s = placer.findSpot(() => true, null);
      if (!s) break;
      // Never crowd a gate mouth, and keep the towns themselves spread out.
      if (gatesDown.some((g) => Math.hypot(g.x - s.x, g.y - s.y) < 7)) continue;
      if (ugTownSpots.some((t) => Math.hypot(t.x - s.x, t.y - s.y) < 12)) continue;
      spot = s;
    }
    if (!spot) {
      // The FIRST town is the level's objective and must exist; later ones
      // are riches for roomy maps. Failing to seat it is a layout defect —
      // throw, and newGame's nudged-seed retry finds a workable layout (the
      // same contract as the gate lifeline above).
      if (k === 0) throw new Error('MapGenerator: no room for an underground town.');
      break;
    }
    clearArea(ug, spot.x, spot.y, 2);
    const town = {
      name: UNDERGROUND_TOWN_NAMES[k % UNDERGROUND_TOWN_NAMES.length],
      faction: UNDERGROUND_TOWN_FACTION,
      owner: -1, // neutral until besieged and captured
      x: spot.x, y: spot.y,
      z: 1, // map level: this town lives underground
      buildings: ['villageHall', 'fort', 'tavern', 'dwelling1'],
      builtToday: false,
      available: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 },
      garrison: rollTownGarrison(rng, UNDERGROUND_TOWN_FACTION, GUARD_HEAVY, physical),
      visitingHeroId: null,
      guildSpells: null,
    };
    // Week-1 population for tier 1, like a surface town (neutral towns keep
    // growing weekly, so a late capture is not an empty shell).
    town.available[1] = baseGrowthFor(town.faction, 1);
    const townId = registerTown(town);
    placeObject(ug, spot.x, spot.y, { type: 'town', townId });
    ugTownSpots.push(spot);
  }

  // ---- 4. The vault: rare industry + prizes behind heavy guards ----------
  const anywhere = () => true;
  for (const mineType of RARE_MINES) {
    placer.place('mine', { mineType, owner: -1 }, anywhere, GUARD_HEAVY, null);
  }
  for (let i = 0; i < Math.max(1, Math.round(scale)); i++) {
    placer.place('mine', { mineType: 'goldMine', owner: -1 }, anywhere, GUARD_HEAVY, null);
  }
  placer.place('artifact', () => ({ artifact: placer.artifactOfValue(3) }), anywhere, GUARD_HEAVY, null);
  // The vault's loot budget, multiplied: the caverns ran at barely a third of the
  // surface's density and played as empty ground (CONFIG.UNDERGROUND_RICHNESS).
  const rich = (n) => Math.max(1, Math.round(scaled(n) * CONFIG.UNDERGROUND_RICHNESS));
  // The caverns hold nearly half of a big map's artifacts, so the clamp reaches
  // here too — throttling only the surface would just move the repeats down.
  const richArt = (n) => Math.max(1, Math.round(scaledArt(n) * CONFIG.UNDERGROUND_RICHNESS));
  for (let i = 0; i < richArt(2); i++) {
    placer.place('artifact', () => ({ artifact: placer.artifactOfValue(rng.int(2, 3)) }), anywhere, GUARD_MEDIUM, null);
  }
  for (let i = 0; i < rich(2); i++) {
    placer.place('booster', { boosterType: rng.pick(['attack', 'defense', 'power', 'knowledge']) }, anywhere, GUARD_MEDIUM, null);
  }
  for (let i = 0; i < rich(1); i++) {
    placer.place('booster', { boosterType: 'xp' }, anywhere, GUARD_LIGHT, null);
  }
  for (let i = 0; i < rich(5); i++) {
    const r = rng.pick(['mercury', 'sulfur', 'crystal', 'gems', 'gold']);
    placer.place('resource', {
      resource: r,
      amount: r === 'gold' ? rng.int(1000, 2000) : rng.int(4, 8),
    }, anywhere, null, null);
  }
  for (let i = 0; i < rich(3); i++) placer.place('chest', {}, anywhere, null, null);
  for (let i = 0; i < rich(3); i++) placer.placeMonster(anywhere, [900, 2200], null);

  // Things worth COMING BACK for. One-shot loot makes the lower level a single
  // errand; a dwelling that accrues recruits and a weekly site give it standing
  // value, which is the same complaint as the late game having nothing to do.
  for (let i = 0; i < Math.max(1, Math.round(scaled(CONFIG.UNDERGROUND_DWELLINGS))); i++) {
    const dwellingType = rng.pick(DWELLING_TYPES);
    const growth = CREATURES[DWELLINGS[dwellingType].creature]?.growth || 0;
    placer.place('dwelling', { dwellingType, available: growth, owner: -1 }, anywhere, GUARD_MEDIUM, null);
  }
  for (let i = 0; i < Math.max(1, Math.round(scaled(CONFIG.UNDERGROUND_WEEKLY))); i++) {
    // A deep market and a wheel on an underground river — both read underground,
    // and both are a reason to send a hero down every week rather than once.
    placer.place('booster', { boosterType: rng.pick(['tradeFair', 'waterWheel']) }, anywhere, GUARD_LIGHT, null);
  }

  // ---- 5. Portals: cavern shortcut pairs -----------------------------------
  // Intra-level teleport pairs, the underground twin of the surface's
  // (actions.usePortal matches partners within the hero's OWN level, so a
  // cavern pair can never cross-talk with a surface pair). Placed AFTER the
  // gates, towns and treasure so they claim leftover open ground, and BEFORE
  // the carve so the per-gate certification below proves both ends reachable:
  // a portal is a solid landmark (isSolidTile) the carve routes around and
  // links via its doorstep, exactly like the surface pairs. Channels come
  // from a fresh underground counter offset to 100+ — matching is per-level
  // so collisions would be harmless, but channel-keyed bookkeeping (the AI's
  // cross-turn `portal|channel` cooldowns carry no level) must never conflate
  // a cavern pair with a surface pair. Colors restart at 0: they only tell
  // pairs apart within one level's palette. Best-effort like placePortalPair
  // everywhere: a pair that cannot seat both ends leaves nothing behind (a
  // lone portal is inert), and fewer pairs on a crowded map is fine.
  const portalPairs = Math.max(1, Math.min(3, Math.round(scale)));
  const portalMinD = Math.min(14, Math.max(6, Math.round(w * 0.18)));
  for (let k = 0; k < portalPairs; k++) {
    placer.placePortalPair(anywhere, null, 100 + k, k, portalMinD, 1);
  }

  // ---- 6. Connectivity: tunnels from the gates to every prize ------------
  // Same machinery, same discipline as the surface: link the gates into one
  // web, hook up every stranded object — towns included, as solid landmarks
  // reached via their doorstep tiles — certify from EACH gate and throw
  // loudly otherwise. Nothing underground is uncarvable rock-wise (no
  // mountains down here) and towns only occupy single tiles in open clearings,
  // so the carve always succeeds by construction.
  carveConnectivity(ug, gatesDown);
}

/**
 * Roll a town's defending garrison worth a `budget` of creature POWER points
 * (src/core/power.js — a guard's job is to be a fight of a given size, and price
 * only answers that where price and strength agree, which they do not)
 * from `factionId`'s base roster: three stacks, heaviest share first, each
 * drawn from the tiers whose per-stack count stays readable (mirroring
 * ObjectPlacer.rollGuard's 3..60 discipline). Deterministic per rng stream.
 */
function rollTownGarrison(rng, factionId, budget, physical = false) {
  const target = rng.int(budget[0], budget[1]);
  const roster = fieldableCreatureIds()
    .filter((id) => CREATURES[id].faction === factionId && !CREATURES[id].upgraded)
    .sort((a, b) => CREATURES[a].tier - CREATURES[b].tier);
  const garrison = [null, null, null, null, null, null, null];
  const shares = [0.5, 0.3, 0.2];
  shares.forEach((share, slot) => {
    const part = target * share;
    const fits = roster.filter((id) => {
      const n = Math.round(part / creaturePower(id, physical));
      return n >= 2 && n <= 40;
    });
    const id = fits.length ? rng.pick(fits) : roster[0];
    const count = Math.max(1, Math.round(part / creaturePower(id, physical)));
    garrison[slot] = { creature: id, count, hurt: 0 };
  });
  return garrison;
}

/**
 * Drop one gate entrance on the surface: an open, uncrowded tile that KEEPS
 * the surface certification intact once the (solid) gate stands on it — a gate
 * placed on a carved corridor's only thread could re-strand an object the
 * carve had linked, so every candidate is re-verified with a flood before it
 * is accepted. Returns the placed object or null.
 *
 * The breathing ring degrades gracefully: we first want a generous 2-tile
 * clearance around the mouth, but on a reward-dense surface (banks, boxes,
 * dwellings and mines can eat every roomy tile) a smaller ring — down to just
 * the gate tile itself — is far better than throwing. The reachability flood
 * is enforced at every ring, so even a tight gate is always usable; only the
 * cosmetic elbow-room relaxes. Passing seeds keep ring 2 and their exact tile,
 * so this only changes maps that would otherwise have crashed.
 */
function placeSurfaceGate(map, rng, starts, channel, existingGates, forbid = null) {
  const { w, h } = map;
  for (let ring = 2; ring >= 0; ring--) {
    for (let tries = 0; tries < 300; tries++) {
      const x = rng.int(2, w - 3), y = rng.int(2, h - 3);
      const tl = map.tiles[y * w + x];
      if (tl.terrain === 'water' || tl.obstacle || tl.objectId) continue;
      // Off the pass corridors (a gate mid-pass consumes one of the map's few
      // crossings even when surfaceStillLinked passes on a multi-pass layout)…
      if (forbid && forbid[y * w + x]) continue;
      // …and NEVER on the buried Grail tile: digForGrail needs a hero to STAND
      // there, but stepping onto a gate teleports it below — the Grail (and a
      // Grail-race game) would be effectively unwinnable for that seed.
      if (map.grail && map.grail.x === x && map.grail.y === y) continue;
      // Breathing ring, matching ObjectPlacer.findSpot: no neighbour object
      // within `ring` tiles (also keeps monster zones of control off the mouth).
      let crowded = false;
      for (let dy = -ring; dy <= ring && !crowded; dy++) {
        for (let dx = -ring; dx <= ring && !crowded; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (map.tiles[ny * w + nx].objectId) crowded = true;
        }
      }
      if (crowded) continue;
      if (existingGates.some((g) => Math.hypot(g.x - x, g.y - y) < 8)) continue;
      const obj = placeObject(map, x, y, { type: 'subGate', channel, color: channel });
      if (surfaceStillLinked(map, starts)) return obj;
      // The gate would plug a corridor — undo and try elsewhere. Rolling back
      // nextOid keeps gate ids dense and deterministic (nothing else was minted
      // in between).
      map.tiles[y * w + x].objectId = null;
      delete map.objects[obj.id];
      map.nextOid--;
    }
  }
  return null;
}

/**
 * Re-run the surface reachability certification (the same 4-directional flood
 * discipline as carveConnectivity's step 3, from the first town): every object
 * except boats, whirlpools and sea-locked islet rewards — all of which are
 * boat-reached (or boat-triggered) by design — must still be visitable. Both
 * towns are objects themselves, so one flood settles "reachable from both
 * towns" (the carve already linked them). "Visitable" is the carve's own
 * orthogonal rule (own tile or a 4-neighbour in the flood): accepting a
 * diagonal-only touch here would let a gate legally squeeze an object down to
 * a corner contact the no-corner-cut mover can never enter.
 */
function surfaceStillLinked(map, starts) {
  const { w, h } = map;
  // Reachability from the FIRST town only (single-source): this certifies the
  // surface stays linked, so it must not multi-source past a break. See townWalkFlood.
  const seen = townWalkFlood(map, [starts[0]], WALK_SOLID_LANDMARKS);
  for (const obj of Object.values(map.objects)) {
    if (obj.type === 'boat' || obj.type === 'whirlpool' || obj.seaLocked) continue;
    let ok = seen[obj.y * w + obj.x] === 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (ok) break;
      const nx = obj.x + dx, ny = obj.y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && seen[ny * w + nx]) ok = true;
    }
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------

/**
 * The mountain-free tile set for one pass: a 3x3 guard chamber on the ridge
 * plus a single-file, 4-connected tunnel straight across the band on each
 * side (out to where zoneS says the mountains have ended, with a tile of
 * clearance so the mouth opens onto real ground). The whole corridor sits in
 * the guard's chokehold — chamber tiles are all adjacent to the guard and
 * tunnel tiles are single-file — so the pass stays sealed until the guard is
 * beaten, on any map size. Returns null when either tunnel fails to cross
 * (flat field near a ridge tip, or the map border) so the caller can reject
 * the candidate instead of shipping a sealed pocket.
 */
function passCorridor(w, h, zoneS, cx, cy) {
  const tiles = new Set();
  const add = (x, y) => tiles.add(y * w + x);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) add(cx + dx, cy + dy);
  }
  // Crossing axis: the corner-to-corner diagonal — the direction zoneS grows.
  const len = Math.hypot(w - 1, h - 1);
  const ux = (w - 1) / len, uy = -(h - 1) / len;
  for (const dir of [1, -1]) {
    let px = cx, py = cy, exited = false;
    for (let t = 0.5; t <= 12; t += 0.5) {
      const x = Math.round(cx + dir * t * ux);
      const y = Math.round(cy + dir * t * uy);
      if (x === px && y === py) continue;
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) break; // hit the border inside the band
      // Stitch diagonal jumps with an orthogonal step so the tunnel is
      // walkable by the game's no-corner-cutting A* and our 4-dir floods.
      if (x !== px && y !== py) add(px, y);
      add(x, y);
      px = x; py = y;
      if (Math.abs(zoneS(x, y)) > RIDGE_HALF + 1.2) { exited = true; break; }
    }
    if (!exited) return null;
  }
  return tiles;
}

function clearArea(map, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
      const tl = map.tiles[y * map.w + x];
      tl.obstacle = null;
      if (tl.terrain === 'water') tl.terrain = 'dirt';
    }
  }
}

function placeObject(map, x, y, data) {
  // Each level mints from its own prefix ('O' surface, 'U' underground) so an
  // object id is unique across the whole world and names its level.
  const id = `${map.oidPrefix || 'O'}${map.nextOid++}`;
  const obj = { id, x, y, ...data };
  map.objects[id] = obj;
  map.tiles[y * map.w + x].objectId = id;
  return obj;
}

function baseGrowthFor(factionId, tier) {
  const base = Object.values(CREATURES).find(
    (c) => c.faction === factionId && c.tier === tier && !c.upgraded,
  );
  return base ? base.growth : 0;
}

/** Helper that finds free spots matching a zone predicate and drops objects+guards. */
class ObjectPlacer {
  // NO zoneT / avoidPoints. They were stored and never read once, in a
  // 2,700-line file, which made them worse than absent: the surface call site
  // passed the zone field and the towns' key points, so a reader reasonably
  // concluded the placer keeps objects clear of towns — and that the underground
  // placer, which passed nulls for both, had lost that protection. Neither was
  // ever true. Zone filtering is done by the caller-supplied zonePred closures
  // and spacing by findSpot's 5x5 ring plus the per-call anchor. eslint cannot
  // see a dead field assigned to `this`, so only reading for it finds this.
  constructor(map, rng, physical = false) {
    this.map = map;
    this.rng = rng;
    this.physical = physical; // which power table sizes a guard (see rollGuard)
    this.usedArtifacts = new Set();
    this.forbidden = null; // Uint8Array mask of no-spawn tiles (pass corridors)
  }

  findSpot(zonePred, anchor) {
    const { map, rng } = this;
    for (let tries = 0; tries < 400; tries++) {
      const x = rng.int(2, map.w - 3);
      const y = rng.int(2, map.h - 3);
      if (!zonePred(x, y)) continue;
      if (this.forbidden && this.forbidden[y * map.w + x]) continue;
      const tl = map.tiles[y * map.w + x];
      if (tl.terrain === 'water' || tl.obstacle || tl.objectId) continue;
      // Keep a breathing ring: no other object/town within 2 tiles.
      let crowded = false;
      for (let dy = -2; dy <= 2 && !crowded; dy++) {
        for (let dx = -2; dx <= 2 && !crowded; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
          if (map.tiles[ny * map.w + nx].objectId) crowded = true;
        }
      }
      if (crowded) continue;
      if (anchor && Math.hypot(x - anchor.x, y - anchor.y) < 4) continue;
      return { x, y };
    }
    return null;
  }

  /**
   * `data` may be an object or a THUNK returning one. A thunk is evaluated only
   * once a spot has been found, which matters whenever building the data costs a
   * limited resource: an artifact id was drawn *before* findSpot could fail, so
   * a crowded map burned roughly two artifacts out of the catalog for every one
   * it actually seated (77 draws against 40 placements on a huge map). The
   * catalog then ran dry halfway through and every later treasure came out of
   * the fallback path.
   */
  place(type, data, zonePred, guardBudget, anchor) {
    const spot = this.findSpot(zonePred, anchor);
    if (!spot) return null;
    const obj = placeObject(this.map, spot.x, spot.y, { type, ...(typeof data === 'function' ? data() : data) });
    if (guardBudget) {
      // Guard sits adjacent, between the object and open ground.
      const g = this.findGuardTile(spot.x, spot.y);
      if (g) this.placeMonsterAt(g.x, g.y, guardBudget, obj.id);
    }
    return obj;
  }

  /** True if a monster stack sits within Chebyshev `r` of (x,y). Two guards this
   *  close can interlock zones of control across a 1-wide passage — neither can
   *  be engaged without standing in the other's ZoC. */
  monsterNear(x, y, r) {
    const { map } = this;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
        const id = map.tiles[ny * map.w + nx].objectId;
        if (id && map.objects[id]?.type === 'monster') return true;
      }
    }
    return false;
  }

  findGuardTile(x, y) {
    const { map } = this;
    const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    const valid = [];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= map.w - 1 || ny >= map.h - 1) continue;
      const tl = map.tiles[ny * map.w + nx];
      if (tl.terrain !== 'water' && !tl.obstacle && !tl.objectId) valid.push({ x: nx, y: ny });
    }
    // Prefer a guard tile clear of any other monster within Chebyshev 2 (keeps
    // zones of control from interlocking); fall back to any valid tile so an
    // object is never left unguarded just because space is tight. No rng — the
    // choice shifts only the guard's own tile among its object's neighbours.
    return valid.find((s) => !this.monsterNear(s.x, s.y, 2)) || valid[0] || null;
  }

  /**
   * Pick a creature and count whose total POWER hits the budget (see
   * src/core/power.js: the budget buys a fight of a size, not a price). `terrain` is
   * the tile the stack will stand on: with CONFIG.WILD_NATIVE_CHANCE the draw
   * narrows to creatures whose faction is native to that terrain — a swamp
   * tends to hold Fortress broods, lava Inferno, snow Tower — so the wildlife
   * reads as belonging to the land instead of a uniform random soup. Only a
   * tendency: the complement draw keeps the FULL pool, so every faction's
   * creatures still roam everywhere and a stack can still surprise. The bias
   * roll is taken unconditionally (one draw per stack, terrain or not), so the
   * rng stream never forks on WHERE a stack happens to sit.
   */
  rollGuard(budget, terrain = null) {
    const [lo, hi] = budget;
    const target = this.rng.int(lo, hi);
    // fieldableCreatureIds, not every key: a battle-remnant creature (the Lizard
    // Ghost) is cheap enough to fit any budget and was observed guarding a sawmill
    // on a map whose lizardGhosts feature was off.
    const pool = fieldableCreatureIds().filter((id) => {
      const c = CREATURES[id];
      if (c.upgraded) return false;
      const minCount = Math.ceil(target / creaturePower(id, this.physical));
      return minCount >= 3 && minCount <= 60; // readable stack sizes
    });
    let candidates = pool;
    const wantNative = this.rng.random() < CONFIG.WILD_NATIVE_CHANCE;
    if (wantNative && terrain) {
      const locals = pool.filter(
        (id) => FACTIONS[CREATURES[id].faction]?.nativeTerrain === terrain,
      );
      // No local fits the budget readably (or the terrain has no native
      // faction, e.g. sand): any drifter will do — content over purity.
      if (locals.length) candidates = locals;
    }
    const creature = candidates.length ? this.rng.pick(candidates) : 'rogue';
    const count = Math.max(1, Math.round(target / creaturePower(creature, this.physical)));
    return { creature, count };
  }

  placeMonsterAt(x, y, budget, guardsObjectId = null) {
    const tl = this.map.tiles[y * this.map.w + x];
    if (tl.objectId || tl.obstacle || tl.terrain === 'water') return null;
    // Pass the tile's terrain so the stack tends to be a local (see rollGuard).
    const { creature, count } = this.rollGuard(budget, tl.terrain);
    return placeObject(this.map, x, y, {
      type: 'monster', creature, count, guards: guardsObjectId,
    });
  }

  placeMonster(zonePred, budget, anchor) {
    const spot = this.findSpot(zonePred, anchor);
    if (!spot) return null;
    return this.placeMonsterAt(spot.x, spot.y, budget);
  }

  /**
   * Drop a linked pair of two-way portals in one zone. Both ends stay in the
   * same realm (never bridging the ridge, so the guarded-pass contract holds);
   * the second end is chosen as the farthest of several candidates, at least
   * `minD` apart, so the pair is a real shortcut. Returns true on success; on
   * failure it leaves no lone portal behind (a solo portal would be inert).
   */
  placePortalPair(zonePred, anchor, channel, color, minD, clearR = 0) {
    const a = this.findSpot(zonePred, anchor);
    if (!a) return false;
    const objA = placeObject(this.map, a.x, a.y, { type: 'portal', channel, color });
    let b = null, bestD = minD;
    for (let tries = 0; tries < 40; tries++) {
      const s = this.findSpot(zonePred, anchor);
      if (!s) continue;
      const d = Math.hypot(s.x - a.x, s.y - a.y);
      if (d > bestD) { bestD = d; b = s; }
    }
    if (!b) { // no far-enough second end — undo the first so no orphan ships
      this.map.tiles[a.y * this.map.w + a.x].objectId = null;
      delete this.map.objects[objA.id];
      return false;
    }
    placeObject(this.map, b.x, b.y, { type: 'portal', channel, color });
    // Open a rock-free ring around BOTH ends so a hero can always approach and
    // (critically) step OFF the exit — underground, half the tiles are rock, so
    // a portal could otherwise strand a teleported hero. Obstacles only: terrain
    // and water are untouched, so surface coastlines/passes stay intact. Surface
    // pairs pass clearR=0 (byte-identical to before); the cavern pairs pass 1.
    if (clearR > 0) {
      this.clearObstaclesAround(a.x, a.y, clearR);
      this.clearObstaclesAround(b.x, b.y, clearR);
    }
    return true;
  }

  /** Strip rock obstacles from an (2r+1)² block, leaving terrain (incl. water) as-is. */
  clearObstaclesAround(cx, cy, r) {
    const { map } = this;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
        const tl = map.tiles[y * map.w + x];
        if (tl.terrain !== 'water') tl.obstacle = null;
      }
    }
  }

  /**
   * Draw an unused artifact from the `value` rarity band.
   *
   * `value` is the band the CALLER earned — it is what decides how hard a guard
   * stands in front of the treasure — so the draw has to respect it. It used to
   * fall back to "any unused artifact" the moment a band ran dry, which is not a
   * near miss but a collapse of the whole contract: measured over 25 maps a side,
   * 18 of 25 LARGE maps and every huge one seated a top-band relic behind a
   * LIGHT guard (seven per huge map), so the +6 Attack Gladius was routinely a
   * day-three pickup off a peasant stack.
   *
   * A dry band now steps to the NEAREST band, preferring the poorer one on a
   * tie. A mismatch is bounded at one rung and errs downward: a treasure a
   * little too cheap for its guard is a disappointment, one far too rich for it
   * is a broken map.
   *
   * Campaign relics are never drawn — a scenario grants those (see the
   * `campaign` flag in data/artifacts.js).
   */
  artifactOfValue(value) {
    const usable = Object.keys(ARTIFACTS).filter((id) => !ARTIFACTS[id].campaign);
    const free = usable.filter((id) => !this.usedArtifacts.has(id));
    const inBand = (list, v) => list.filter((id) => ARTIFACTS[id].value === v);
    let pool = inBand(free, value);
    if (!pool.length) {
      // Step DOWN only — the richest band still below the request. Never up.
      // Direction is the whole point: a treasure a rung too cheap for its guard
      // is a disappointment, one three rungs too rich is a broken map. And on
      // the largest maps the mid bands exhaust while the TOP band sits nearly
      // untouched (it is asked for exactly once per map), so a "nearest band"
      // rule drains the grand-prize band into ordinary loot — measured at 6.7
      // value-4 relics per huge map behind medium guards.
      const below = [...new Set(free.map((id) => ARTIFACTS[id].value))].filter((v) => v < value);
      if (below.length) pool = inBand(free, Math.max(...below));
    }
    // Nothing fresh at or below the band — the largest maps ask for more
    // artifacts than the catalog holds, and value-1 has nothing beneath it to
    // borrow from. Reach up by EXACTLY one rung before repeating: a value-2
    // trinket behind a light guard is a small overshoot, and the hard ceiling
    // is what keeps this from walking all the way to the grand-prize band.
    // …but never up INTO the top band. That band is the map's marquee reward,
    // deliberately asked for once and reserved before anything else is seated;
    // letting a dry value-3 request borrow from it put 3.3 grand-prize relics
    // per huge map behind ordinary medium guards, which is the very leak this
    // whole function exists to close.
    const top = Math.max(...usable.map((id) => ARTIFACTS[id].value));
    if (!pool.length && value + 1 < top) pool = inBand(free, value + 1);
    if (!pool.length) {
      // Still nothing. REPEAT within the requested band rather than reach
      // further up: a second Boots of Speed is a dull prize, a second Gladius
      // behind a light guard is a broken map.
      pool = inBand(usable, value);
      if (!pool.length) pool = usable;
    }
    const pick = this.rng.pick(pool);
    this.usedArtifacts.add(pick);
    return pick;
  }
}

/**
 * Guarantee, by construction, that every object is reachable from BOTH towns.
 *
 * Three steps, all on a 4-directional grid strictly harsher than the game's
 * A* (which additionally allows diagonals but forbids corner-cutting), so
 * anything certified here really is reachable in play:
 *   1. Link the towns: flood from town 0; carve the cheapest corridor from
 *      any still-isolated town's doorstep to the flooded region.
 *   2. Link every stranded object (scatter pockets, lake rings) to the — now
 *      single — town component the same way.
 *   3. Certify from each town independently and fail loudly otherwise.
 *
 * Carving runs a 0-1 BFS where open ground costs 0 and scatter obstacles or
 * water cost 1, so a carve threads existing clearings and only fells the few
 * trees it must. Mountains and town tiles are hard walls: the ridge is NEVER
 * breached, which forces any cross-zone route through a pass corridor — and
 * the generator keeps at least one corridor open, so a route always exists.
 * That is what makes step 3 a certainty instead of a hope, at any map size.
 */
function carveConnectivity(map, starts) {
  const { w, h } = map;
  const size = w * h;
  const idx = (x, y) => y * w + x;

  // Solid landmarks you visit from an adjacent tile, never walk through: towns,
  // portals and subterranean gates (all three block through-traffic in-game, so
  // the carve must not certify a route THROUGH one — it routes around, keeping
  // every object reachable without relying on a teleport).
  const isSolidTile = (i) => {
    const id = map.tiles[i].objectId;
    if (!id) return false;
    const ty = map.objects[id].type;
    return ty === 'town' || ty === 'portal' || ty === 'subGate';
  };
  // Walkable as-is.
  const open = (i) => {
    const tl = map.tiles[i];
    return tl.terrain !== 'water' && !tl.obstacle && !isSolidTile(i);
  };
  // May be opened by carving. Mountains keep the guarded-crossing contract;
  // towns and portals are permanent landmarks.
  const carvable = (i) => map.tiles[i].obstacle !== 'mountain' && !isSolidTile(i);

  // 4-directional flood from every seed (multi-source). The carve's `open`
  // (water/obstacle/town/portal/subGate) is exactly WALK_SOLID_LANDMARKS, so this
  // is the shared walk flood; `open` itself is still used by the 0-1 BFS below.
  const reachFrom = (seeds) => townWalkFlood(map, seeds, WALK_SOLID_LANDMARKS);

  // Reachable if we can stand ON the spot or any ORTHOGONAL neighbour.
  // Diagonal-only contact is NOT enough: the game's A* forbids corner-cutting,
  // so a tile whose four orthogonal flanks are all blocked can never be
  // entered even when open ground touches its corner. Certifying via all 8
  // neighbours used to accept exactly that — about one object in five maps
  // shipped stranded behind a diagonal pinch of scatter rock (audit
  // PATH.reach). An orthogonal link is also precisely what the 4-directional
  // floods here can prove, so certification and flood now agree.
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const nearReachable = (obj, seen) => {
    if (seen[idx(obj.x, obj.y)]) return true;
    for (const [dx, dy] of ORTH) {
      const nx = obj.x + dx, ny = obj.y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && seen[idx(nx, ny)]) return true;
    }
    return false;
  };

  // Scratch shared across carves (a handful per map at most). The deque grows
  // both ways from the middle; total pushes are bounded by one per successful
  // relaxation — at most 4 per finalized node — so 8*size+16 can never overflow.
  const dist = new Int32Array(size);
  const parent = new Int32Array(size);
  const done = new Uint8Array(size);
  const deque = new Int32Array(8 * size + 16);

  /**
   * Carve the cheapest corridor from any seed index to the `seen` region and
   * open it (water → dirt, scatter felled). Returns false only when mountains
   * or towns truly wall the seeds off — certification then reports it loudly.
   */
  const carveTo = (seedIdxs, seen) => {
    dist.fill(-1); parent.fill(-1); done.fill(0);
    let head = 4 * size + 8, tail = head;
    for (const i of seedIdxs) {
      if (!carvable(i)) continue;
      dist[i] = open(i) ? 0 : 1;
      parent[i] = -2; // root marker for the back-walk
      if (dist[i] === 0) deque[--head] = i; else deque[tail++] = i;
    }
    let goal = -1;
    while (head < tail) {
      const i = deque[head++];
      if (done[i]) continue;
      done[i] = 1;
      if (seen[i]) { goal = i; break; }
      const x = i % w, d = dist[i];
      const step = (j) => {
        if (done[j] || !carvable(j)) return;
        const nd = d + (open(j) ? 0 : 1);
        if (dist[j] !== -1 && dist[j] <= nd) return;
        dist[j] = nd; parent[j] = i;
        if (nd === d) deque[--head] = j; else deque[tail++] = j;
      };
      if (x > 0) step(i - 1);
      if (x < w - 1) step(i + 1);
      if (i >= w) step(i - w);
      if (i < size - w) step(i + w);
    }
    if (goal === -1) return false;
    for (let i = goal; i !== -2; i = parent[i]) {
      const tl = map.tiles[i];
      if (tl.terrain === 'water') tl.terrain = 'dirt';
      if (tl.obstacle) tl.obstacle = null; // never 'mountain' — not carvable above
    }
    return true;
  };

  // Step 1: one component containing every town. Carve from each isolated
  // town's doorstep to the region flooded from town 0 — the only mountain-free
  // route between the realms runs through a pass corridor, so this is exactly
  // "connect the towns via the guarded passes".
  let seen = reachFrom([starts[0]]);
  for (let s = 1; s < starts.length; s++) {
    if (nearReachable(starts[s], seen)) continue;
    const t = starts[s];
    const seeds = [];
    for (const [dx, dy] of ORTH) {
      const nx = t.x + dx, ny = t.y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) seeds.push(idx(nx, ny));
    }
    carveTo(seeds, seen);
    seen = reachFrom([starts[0]]); // refresh: later fixes may reuse the new corridor
  }

  // Step 2: hook up every stranded object. With the towns linked, the union
  // flood below equals each town's own flood, so one carve per stray pocket
  // settles reachability from both sides at once. Carving only ever OPENS
  // tiles, so earlier links are never undone. Seed the carve from the object's
  // tile AND its ORTHOGONAL neighbours: a SOLID object (town/portal) sits on a
  // non-carvable tile, so seeding only that tile could never rescue it — but a
  // neighbour (even a water tile, carvable to a dirt causeway) always can.
  // Diagonal seeds are deliberately excluded: a corridor rooted at a corner
  // leaves the object un-enterable under the no-corner-cut rule (the exact
  // stranding nearReachable above now rejects), so only links the certification
  // will accept are ever carved.
  seen = reachFrom(starts);
  for (const obj of Object.values(map.objects)) {
    if (nearReachable(obj, seen)) continue;
    const seeds = [idx(obj.x, obj.y)];
    for (const [dx, dy] of ORTH) {
      const nx = obj.x + dx, ny = obj.y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) seeds.push(idx(nx, ny));
    }
    carveTo(seeds, seen);
  }

  // Step 3: certify from EVERY start independently (towns on the surface,
  // gate exits underground). Mapgen runs before any battle and is off the
  // combat path, so failing loudly here is safe — and far better than a
  // silently unreachable objective discovered mid-game. Steps 1-2 carve
  // against hard guarantees, so this should never fire.
  for (let s = 0; s < starts.length; s++) {
    const certSeen = reachFrom([starts[s]]);
    for (const obj of Object.values(map.objects)) {
      if (!nearReachable(obj, certSeen)) {
        throw new Error(
          `MapGenerator: object ${obj.id} (${obj.type}) at ${obj.x},${obj.y} `
          + `is unreachable from start ${s} — connectivity carve could not link `
          + 'it without breaching the mountain ridge.',
        );
      }
    }
  }
}
