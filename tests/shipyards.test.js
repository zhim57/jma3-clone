/**
 * shipyards.test.js — neutral shipyards: a hero pays CONFIG.BOAT_COST to have
 * a boat built on the yard's free dock tile.
 *
 * Pinned here:
 *   - generator: shipyards land on navigable coasts (walkable land tile, an
 *     orthogonally adjacent object-free water tile), surface only, are
 *     foot-reachable from BOTH towns, deterministic per seed, area-scaled;
 *   - the shipyard tile is WALKABLE-THROUGH (like a mine) — stepping onto it
 *     returns the 'shipyard' offer event the UI turns into a dialog;
 *   - buildBoat charges the cost and spawns a boat that the existing embark
 *     path boards in one step; every refusal (cost / clogged dock / no water /
 *     out of range) is a graceful event, never a throw or a silent charge;
 *   - save v2 round-trips a map with a shipyard and a boat built from it;
 *   - the AI routes to a shipyard, builds ONCE, boards the boat and collects
 *     sea-locked value it could not otherwise reach — and never spams builds:
 *     no build when a reachable boat already serves the water, when there is
 *     no water value, or when the cost is unaffordable; no rebuild while the
 *     yard cools down; shipyard-less maps behave exactly as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, tileAt, heroAt, playerHeroes, playerTowns, nextObjectId,
  serialize, deserialize, levelObjects,
} from '../src/core/GameState.js';
import { stepHero, buildBoat, shipyardDockTile, endTurn } from '../src/core/actions.js';
import { isWalkable, isEnterable, findPath } from '../src/map/Pathfinding.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { Rng } from '../src/core/rng.js';
import { CONFIG } from '../src/config.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1; // player index of the AI opponent in a fresh game

// ---------------------------------------------------------------------------
// Shared helpers (same idioms as water.test.js / ai-connectors.test.js)
// ---------------------------------------------------------------------------

/** Build a map the way GameState.newGame does, minus the rest of the state. */
function buildMap(seed, w = 44, h = 36) {
  const players = [{ faction: 'castle' }, { faction: 'inferno' }];
  const towns = [];
  const map = generateMap({
    w, h,
    rng: new Rng(seed),
    players,
    registerTown: (town) => {
      const id = `T${towns.length}`;
      town.id = id;
      towns.push(town);
      return id;
    },
  });
  return { map, towns };
}

/**
 * 4-directional foot flood, STRICTER than in-game pathing: towns, portals and
 * subterranean gates are solid, water and obstacles block. Anything this
 * flood reaches is provably reachable in play.
 */
function flood(map, seeds) {
  const { w, h } = map;
  const solid = (x, y) => {
    const t = map.tiles[y * w + x];
    const occ = t.objectId && map.objects[t.objectId];
    return !!(occ && (occ.type === 'town' || occ.type === 'portal' || occ.type === 'subGate'));
  };
  const open = (x, y) => {
    const t = map.tiles[y * w + x];
    return t.terrain !== 'water' && !t.obstacle && !solid(x, y);
  };
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (const s of seeds) {
    const i = s.y * w + s.x;
    if (!seen[i]) { seen[i] = 1; stack.push(s); }
  }
  while (stack.length) {
    const { x, y } = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (seen[ni] || !open(nx, ny)) continue;
      seen[ni] = 1;
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/** Find a clean horizontal strip and return its left-edge coords at row y. */
function waterStrip(state) {
  const { w, h } = state.map;
  for (let y = 4; y < h - 4; y++) {
    for (let x0 = 4; x0 < w - 8; x0++) {
      let ok = true;
      for (let dx = -1; dx <= 6 && ok; dx++) {
        for (let dy = -1; dy <= 1 && ok; dy++) {
          const t = tileAt(state, x0 + dx, y + dy);
          if (!t || t.objectId || heroAt(state, x0 + dx, y + dy)) ok = false;
        }
      }
      if (ok) return { x0, y };
    }
  }
  throw new Error('no clean strip');
}

/** land0 | yard | water(dock) | water | land1 on one clean row. */
function stageYard(state) {
  const { x0, y } = waterStrip(state);
  for (let dx = -1; dx <= 6; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const t = tileAt(state, x0 + dx, y + dy);
      t.terrain = 'grass'; t.obstacle = null; t.objectId = null;
    }
  }
  tileAt(state, x0 + 2, y).terrain = 'water';
  tileAt(state, x0 + 3, y).terrain = 'water';
  const id = nextObjectId(state);
  state.map.objects[id] = { id, x: x0 + 1, y, type: 'shipyard' };
  tileAt(state, x0 + 1, y).objectId = id;
  return {
    land0: { x: x0, y }, yard: { x: x0 + 1, y }, dock: { x: x0 + 2, y },
    water2: { x: x0 + 3, y }, land1: { x: x0 + 4, y }, yardId: id,
  };
}

function readyHero(state, owner = 0) {
  const hero = playerHeroes(state, owner)[0];
  hero.army = [{ creature: 'pikeman', count: 20, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 5000;
  return hero;
}

/** Drive a full AI turn; auto-resolve any interactive battles. */
function runTurn(state, playerIndex = AI) {
  const ai = new AITurnController(state, playerIndex);
  let guard = 200;
  let r;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return ai;
}

/** Remove every surface object except towns. */
function stripObjects(state) {
  const m = state.map;
  for (const [id, obj] of Object.entries(m.objects)) {
    if (obj.type === 'town') continue;
    const t = m.tiles[obj.y * state.map.w + obj.x];
    if (t.objectId === id) t.objectId = null;
    delete m.objects[id];
  }
}

/** Make every non-AI army unbeatable so courage gates all combat goals off. */
function fortifyEnemies(state, aiIndex = AI) {
  for (const town of Object.values(state.towns)) {
    if (town.owner !== aiIndex) {
      town.garrison[0] = { creature: 'archangel', count: 500, hurt: 0 };
    }
  }
  for (const h of Object.values(state.heroes)) {
    if (h.owner !== aiIndex) {
      h.army = [{ creature: 'archangel', count: 500, hurt: 0 }, null, null, null, null, null, null];
    }
  }
}

/**
 * Stop the AI's towns from spending (build/hire/recruit), so the treasury we
 * hand it is spent on exactly one thing: boats.
 */
function freezeAiEconomy(state, aiIndex = AI) {
  for (const town of Object.values(state.towns)) {
    if (town.owner !== aiIndex) continue;
    town.builtToday = true;
    town.available = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    town.buildings = town.buildings.filter((b) => b !== 'tavern');
  }
}

function giveResources(state, playerIndex, gold, wood) {
  state.players[playerIndex].resources = {
    gold, wood, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 0,
  };
}

/** Force a clean block of open ground around (cx, cy) on the surface. */
function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const t = m.tiles[(cy + dy) * state.map.w + (cx + dx)];
      t.obstacle = null;
      t.terrain = 'grass';
      if (t.objectId) {
        delete m.objects[t.objectId];
        t.objectId = null;
      }
    }
  }
  return { x: cx, y: cy };
}

/** Drop an object onto a live state at (x, y) on the surface; returns it. */
function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * state.map.w + x].objectId = id;
  return obj;
}

/**
 * The AI stage used across the shipyard AI tests: a hand-painted lake with a
 * sea-locked islet reward, a coastal shipyard (no boat unless a test adds
 * one), a mainland crystal pile as "work to return to", and the AI hero on
 * the shore. Surface stripped, enemies fortified, AI town spending frozen.
 */
function stageAiLake(state, { islet = true } = {}) {
  stripObjects(state);
  fortifyEnemies(state);
  freezeAiEconomy(state);
  const hero = playerHeroes(state, AI)[0];
  hero.army = [{ creature: 'pikeman', count: 20, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 4000;
  const x0 = 24, y = 20;
  clearBlock(state, x0 - 5, y, 4);
  clearBlock(state, x0 + 1, y, 4);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = 1; dx <= 5; dx++) {
      const t = tileAt(state, x0 + dx, y + dy);
      t.terrain = 'water';
      t.obstacle = null;
    }
  }
  let isletObj = null;
  if (islet) {
    tileAt(state, x0 + 3, y).terrain = 'sand';
    isletObj = putObj(state, x0 + 3, y, { type: 'artifact', artifact: 'titansGladius', seaLocked: true });
  }
  const yard = putObj(state, x0, y, { type: 'shipyard' });
  putObj(state, x0 - 9, y, { type: 'resource', resource: 'crystal', amount: 7 });
  hero.x = x0 - 1;
  hero.y = y;
  return { hero, yard, isletObj, x0, y };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

test('generator: shipyards stand on walkable coast with a free dock, reachable from both towns', () => {
  const cases = [[1, 44, 36], [7, 44, 36], [42, 44, 36], [999, 44, 36], [2024, 44, 36], [7, 88, 72]];
  let total = 0;
  for (const [seed, w, h] of cases) {
    const { map, towns: allTowns } = buildMap(seed, w, h);
    const towns = allTowns.filter((t) => (t.z ?? 0) === 0);
    const yards = Object.values(map.objects).filter((o) => o.type === 'shipyard');
    total += yards.length;

    // Surface only: the underground holds no water, so no shipyards below.
    const below = Object.values(map.underground.objects).filter((o) => o.type === 'shipyard');
    assert.equal(below.length, 0, `seed ${seed}: no shipyards underground`);

    const floods = towns.map((t) => flood(map, [{ x: t.x, y: t.y }]));
    for (const yard of yards) {
      const tl = map.tiles[yard.y * w + yard.x];
      assert.notEqual(tl.terrain, 'water', `yard ${yard.id} stands on land`);
      assert.equal(tl.obstacle, null, `yard ${yard.id} tile is clear`);
      assert.equal(tl.objectId, yard.id, `yard ${yard.id} owns its tile`);
      // A free dock: an orthogonally adjacent, object-free water tile.
      const dock = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const n = map.tiles[(yard.y + dy) * w + (yard.x + dx)];
        return n && n.terrain === 'water' && !n.objectId;
      });
      assert.ok(dock, `seed ${seed}: yard ${yard.id} at ${yard.x},${yard.y} has a free dock`);
      // The yard TILE itself is foot-reachable from EACH town (a hero must
      // stand on it to build) — by the strict 4-dir flood.
      for (let i = 0; i < towns.length; i++) {
        assert.ok(floods[i][yard.y * w + yard.x],
          `seed ${seed}: yard ${yard.id} reachable on foot from town ${i}`);
      }
    }
  }
  assert.ok(total >= 1, `shipyards were actually placed across the sweep (${total})`);
  // The proven-navigable big map (water.test.js expects boats here) gets yards.
  const big = buildMap(7, 88, 72);
  assert.ok(Object.values(big.map.objects).some((o) => o.type === 'shipyard'),
    '88x72 seed 7 carries at least one shipyard');
});

test('generator: shipyard count is area-scaled and deterministic per seed', () => {
  const avg = (w, h) => {
    let sum = 0;
    const seeds = [1, 2, 3, 4, 5, 6].map((k) => k * 7919 + w * 131 + h);
    for (const seed of seeds) {
      sum += Object.values(buildMap(seed, w, h).map.objects)
        .filter((o) => o.type === 'shipyard').length;
    }
    return sum / seeds.length;
  };
  const small = avg(36, 30);
  const large = avg(88, 72);
  assert.ok(large > small, `88x72 average (${large}) exceeds 36x30 average (${small})`);

  // Determinism: same seed & size twice → identical yard positions.
  const a = Object.values(buildMap(7, 88, 72).map.objects)
    .filter((o) => o.type === 'shipyard').map((o) => `${o.id}@${o.x},${o.y}`).sort();
  const b = Object.values(buildMap(7, 88, 72).map.objects)
    .filter((o) => o.type === 'shipyard').map((o) => `${o.id}@${o.x},${o.y}`).sort();
  assert.deepEqual(a, b, 'two runs of one seed place identical shipyards');
});

// ---------------------------------------------------------------------------
// Stepping onto a shipyard (the UI contract) & pathing semantics
// ---------------------------------------------------------------------------

test('stepping onto a shipyard returns the build-offer event with cost and feasibility', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = stageYard(s);
  const hero = readyHero(s);
  hero.x = L.land0.x; hero.y = L.land0.y;

  const ev = stepHero(s, hero, { x: L.yard.x, y: L.yard.y, cost: 100 });
  assert.equal(ev.type, 'shipyard');
  assert.equal(ev.objectId, L.yardId);
  assert.deepEqual(ev.cost, CONFIG.BOAT_COST, 'the event carries the price for the dialog');
  assert.equal(ev.canBuild, true);
  assert.equal(ev.reason, null);
  assert.equal(hero.x, L.yard.x, 'the hero stands on the yard (walkable tile)');
});

test('a shipyard tile is walkable-through, like a mine (pathing semantics)', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = stageYard(s);
  assert.equal(isWalkable(s, L.yard.x, L.yard.y, -1, null, false, 0), true, 'walkable through on foot');
  assert.equal(isEnterable(s, L.yard.x, L.yard.y, -1, false, 0), true, 'enterable as a destination');
  const hero = readyHero(s);
  hero.x = L.land0.x; hero.y = L.land0.y;
  assert.ok(findPath(s, hero, L.yard.x, L.yard.y, -1), 'a path onto the yard exists');
});

// ---------------------------------------------------------------------------
// buildBoat
// ---------------------------------------------------------------------------

test('buildBoat: charges BOAT_COST, places a boat on the free dock, boardable in one step', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = stageYard(s);
  const hero = readyHero(s);
  giveResources(s, 0, 2000, 15);
  hero.x = L.land0.x; hero.y = L.land0.y;
  stepHero(s, hero, { x: L.yard.x, y: L.yard.y, cost: 100 });

  const dockPreview = shipyardDockTile(s, s.map.objects[L.yardId]);
  assert.deepEqual(dockPreview, { x: L.dock.x, y: L.dock.y }, 'the dock is the adjacent free water tile');

  const ev = buildBoat(s, hero, L.yardId);
  assert.equal(ev.type, 'boatBuilt');
  assert.equal(ev.x, L.dock.x);
  assert.equal(ev.y, L.dock.y);
  assert.equal(s.players[0].resources.gold, 2000 - CONFIG.BOAT_COST.gold, 'gold charged');
  assert.equal(s.players[0].resources.wood, 15 - CONFIG.BOAT_COST.wood, 'wood charged');
  const t = tileAt(s, L.dock.x, L.dock.y);
  assert.ok(t.objectId && s.map.objects[t.objectId]?.type === 'boat', 'a boat sits on the dock');

  // The existing embark path boards the new boat immediately.
  const board = stepHero(s, hero, { x: L.dock.x, y: L.dock.y, cost: 100 });
  assert.equal(board.type, 'embark');
  assert.equal(hero.onBoat, true);
});

test('buildBoat refuses gracefully: cost, docked boat, no free water, out of range', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = stageYard(s);
  const hero = readyHero(s);
  hero.x = L.land0.x; hero.y = L.land0.y;

  // Unaffordable: the offer event says so, and the build refuses untouched.
  giveResources(s, 0, 0, 0);
  const offer = stepHero(s, hero, { x: L.yard.x, y: L.yard.y, cost: 100 });
  assert.equal(offer.type, 'shipyard');
  assert.equal(offer.canBuild, false);
  assert.equal(offer.reason, 'cost');
  let ev = buildBoat(s, hero, L.yardId);
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'cost' });
  assert.equal(s.players[0].resources.gold, 0, 'nothing was charged');
  assert.equal(tileAt(s, L.dock.x, L.dock.y).objectId, null, 'no boat appeared');

  // A boat already at the dock: build is redundant, refuse.
  giveResources(s, 0, 5000, 50);
  const bid = nextObjectId(s);
  s.map.objects[bid] = { id: bid, x: L.dock.x, y: L.dock.y, type: 'boat' };
  tileAt(s, L.dock.x, L.dock.y).objectId = bid;
  ev = buildBoat(s, hero, L.yardId);
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'boatAtDock' });
  delete s.map.objects[bid];
  tileAt(s, L.dock.x, L.dock.y).objectId = null;

  // No adjacent free water at all: refuse.
  tileAt(s, L.dock.x, L.dock.y).terrain = 'grass';
  ev = buildBoat(s, hero, L.yardId);
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'noDock' });
  tileAt(s, L.dock.x, L.dock.y).terrain = 'water';

  // Out of range (not on or beside the yard): refuse.
  hero.x = L.yard.x - 3;
  ev = buildBoat(s, hero, L.yardId);
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'notHere' });

  // A bogus id: refuse, never throw.
  ev = buildBoat(s, hero, 'O999999');
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'noShipyard' });
  assert.equal(s.players[0].resources.gold, 5000, 'no refusal ever charged anything');
});

// ---------------------------------------------------------------------------
// Save round-trip
// ---------------------------------------------------------------------------

test('save v2 round-trips a shipyard and a boat built from it', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = stageYard(s);
  const hero = readyHero(s);
  giveResources(s, 0, 2000, 15);
  hero.x = L.land0.x; hero.y = L.land0.y;
  stepHero(s, hero, { x: L.yard.x, y: L.yard.y, cost: 100 });
  const built = buildBoat(s, hero, L.yardId);
  assert.equal(built.type, 'boatBuilt');

  const j1 = serialize(s);
  const s2 = deserialize(j1);
  const yard2 = s2.map.objects[L.yardId];
  assert.ok(yard2 && yard2.type === 'shipyard', 'the shipyard survives the round-trip');
  assert.equal(yard2.x, L.yard.x);
  assert.equal(yard2.y, L.yard.y);
  const dockTile = s2.map.tiles[L.dock.y * s2.map.w + L.dock.x];
  assert.ok(dockTile.objectId && s2.map.objects[dockTile.objectId]?.type === 'boat',
    'the built boat survives on its dock tile');
  assert.equal(serialize(s2), j1, 'round-trip is byte-idempotent');

  // A restored game keeps playing: the loaded boat is boardable.
  const hero2 = s2.heroes[hero.id];
  const board = stepHero(s2, hero2, { x: L.dock.x, y: L.dock.y, cost: 100 });
  assert.equal(board.type, 'embark');
});

test('a freshly generated water map (with shipyards) round-trips idempotently', () => {
  const s = newGame({ seed: 7, mapW: 88, mapH: 72 });
  assert.ok(Object.values(s.map.objects).some((o) => o.type === 'shipyard'),
    'the map actually contains shipyards');
  const j1 = serialize(s);
  assert.equal(serialize(deserialize(j1)), j1, 'byte-idempotent round-trip');
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

test('AI: routes to a shipyard, builds ONE boat, and loots the sea-locked islet', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { hero, isletObj, x0, y } = stageAiLake(s);
  giveResources(s, AI, 5000, 50);

  const crystal0 = s.players[AI].resources.crystal;
  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 1, 'exactly one boat built (per-turn cap)');
  assert.equal(ai.buildLog.length, 1, 'the build is logged once');
  assert.equal(s.players[AI].resources.gold, 5000 - CONFIG.BOAT_COST.gold, 'gold paid once');
  assert.equal(s.players[AI].resources.wood, 50 - CONFIG.BOAT_COST.wood, 'wood paid once');
  assert.equal(levelObjects(s, 0)[isletObj.id], undefined, 'the islet reward was collected');
  const loot = [...Object.values(hero.equipment).filter(Boolean), ...hero.backpack];
  assert.ok(loot.includes('titansGladius'), 'the hero carries the sea-locked artifact');
  assert.ok(ai.metrics.transits.embark >= 1, 'the built boat was actually boarded');
  assert.ok(!(hero.x === x0 + 3 && hero.y === y), 'not marooned on the islet');
  assert.equal(hero.onBoat, false, 'ends the turn ashore');
  assert.equal(s.players[AI].resources.crystal, crystal0 + 7, 'resumed mainland work after the trip');
  const boats = Object.values(s.map.objects).filter((o) => o.type === 'boat');
  assert.equal(boats.length, 1, 'one boat exists — built once, reused, never duplicated');
});

test('AI: no rebuild the next day — cooldown, consumed value and the docked boat all hold', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  stageAiLake(s);
  giveResources(s, AI, 5000, 50);
  runTurn(s);
  endTurn(s); // human
  endTurn(s); // AI -> day 2
  assert.equal(s.day, 2, 'a new day dawned');
  const hero = playerHeroes(s, AI)[0];
  hero.mp = 3000;

  const ai2 = runTurn(s);
  assert.equal(ai2.metrics.boatsBuilt, 0, 'no second boat: value is gone and the yard cools down');
  const boats = Object.values(s.map.objects).filter((o) => o.type === 'boat');
  assert.equal(boats.length, 1, 'still exactly one boat on the map');
});

test('AI: does not build when a reachable boat already serves the same water', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { isletObj, x0, y } = stageAiLake(s);
  giveResources(s, AI, 5000, 50);
  // A free boat afloat on the same body, boardable from the shore — not beside
  // the yard (that would trip the boatAtDock refusal instead of the valuation).
  putObj(s, x0 + 2, y - 1, { type: 'boat' });

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 0, 'the free boat made the build pure waste');
  assert.equal(s.players[AI].resources.gold, 5000, 'no gold spent on boats');
  assert.equal(levelObjects(s, 0)[isletObj.id], undefined, 'the islet was still looted — by the free boat');
});

test('AI: does not build without real water value, even when rich', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  stageAiLake(s, { islet: false }); // a lake with nothing on it
  giveResources(s, AI, 20000, 100);

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 0, 'an empty lake is worth no boat');
  assert.equal(s.players[AI].resources.gold, 20000, 'not a coin spent');
});

test('AI: ignores a shipyard it cannot afford', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { isletObj } = stageAiLake(s);
  giveResources(s, AI, 0, 0);

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 0, 'no funds, no boat');
  assert.ok(levelObjects(s, 0)[isletObj.id], 'the islet reward stays out of reach');
});

test('AI (tuning): trades for the wood it lacks at the market, then builds', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { hero, isletObj } = stageAiLake(s);
  // A marketplace lets the AI convert gold into the wood it is short. Without
  // this wiring the yard would be skipped outright — gold-rich but wood-broke.
  for (const t of playerTowns(s, AI)) {
    if (!t.buildings.includes('marketplace')) t.buildings.push('marketplace');
  }
  giveResources(s, AI, 8000, 0); // plenty of gold, ZERO wood

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 1, 'the AI bought the 10 wood and built the boat');
  assert.equal(s.players[AI].resources.wood, 0, 'the bought wood was spent on the boat (net zero)');
  assert.ok(s.players[AI].resources.gold < 8000 - CONFIG.BOAT_COST.gold,
    'gold paid for the boat AND the market purchase of wood');
  assert.ok(s.players[AI].resources.gold >= 1000, 'the gold reserve was respected');
  assert.equal(levelObjects(s, 0)[isletObj.id], undefined, 'and the sea-locked reward was collected');
  const loot = [...Object.values(hero.equipment).filter(Boolean), ...hero.backpack];
  assert.ok(loot.includes('titansGladius'), 'the artifact ended up on the hero');
});

test('AI (tuning): without a marketplace, a wood-short AI still cannot build (unchanged)', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { isletObj } = stageAiLake(s);
  for (const t of playerTowns(s, AI)) {
    t.buildings = t.buildings.filter((b) => b !== 'marketplace');
  }
  giveResources(s, AI, 8000, 0); // rich in gold, but no way to make wood

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 0, 'no market ⇒ gold cannot become wood ⇒ no boat');
  assert.equal(s.players[AI].resources.gold, 8000, 'nothing was traded or spent');
  assert.ok(levelObjects(s, 0)[isletObj.id], 'the reward stays unreachable');
});

test('AI: shipyard-less maps behave as before — turns terminate, zero builds', () => {
  const s = newGame({ seed: 4242 });
  for (const [id, obj] of Object.entries(s.map.objects)) {
    if (obj.type !== 'shipyard') continue;
    const t = s.map.tiles[obj.y * s.map.w + obj.x];
    if (t.objectId === id) t.objectId = null;
    delete s.map.objects[id];
  }
  let guard = 40;
  while (s.winner === null && s.day <= 4 && guard-- > 0) {
    const ai = runTurn(s, s.currentPlayer);
    assert.equal(ai.metrics.boatsBuilt, 0, 'nothing to build from');
    endTurn(s);
  }
  assert.ok(guard > 0, 'no runaway');
});

test('AI: shipyard decisions are deterministic — same seed, identical game', () => {
  const play = () => {
    const s = newGame({
      seed: 31337, mapW: 56, mapH: 46,
      players: [
        { faction: 'castle', isHuman: false, team: 0 },
        { faction: 'inferno', isHuman: false, team: 1 },
      ],
    });
    let guard = 40;
    while (s.winner === null && s.day <= 4 && guard-- > 0) {
      const ai = new AITurnController(s, s.currentPlayer);
      let r, g2 = 100;
      do {
        r = ai.next();
        if (r.type === 'combat') ai.autoFight(r.context);
      } while (r.type !== 'done' && g2-- > 0);
      endTurn(s);
    }
    return s;
  };
  const digest = (s) => JSON.stringify({
    day: s.day,
    rng: s.rng.toJSON(),
    players: s.players.map((p) => [p.resources, p.defeated]),
    heroes: Object.values(s.heroes).map((h) => [
      h.rosterId, h.owner, h.x, h.y, h.z, h.onBoat, h.level, h.xp, h.mp, h.army,
    ]),
    boats: Object.values(s.map.objects).filter((o) => o.type === 'boat')
      .map((o) => `${o.x},${o.y}`).sort(),
    yards: Object.values(s.map.objects).filter((o) => o.type === 'shipyard')
      .map((o) => `${o.x},${o.y}`).sort(),
  });
  assert.equal(digest(play()), digest(play()), 'two runs of one seed are identical');
});
