/**
 * connectivity.test.js — Headless tests for MapGenerator reachability.
 *
 * The two-zone generator promises (MapGenerator.carveConnectivity) that every
 * placed object is reachable from BOTH town starts, so no mine/artifact/guard
 * ever ends up walled off and no hero goal is stranded. These tests exercise the
 * REAL generator across fixed seeds and re-derive that guarantee independently
 * with a 4-directional flood — stricter than the game's diagonal A*, so anything
 * certified here is reachable in play. Pure rule-engine, no Phaser. Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap } from '../../src/map/MapGenerator.js';
import { ARTIFACTS } from '../../src/data/artifacts.js';
import { newGame } from '../../src/core/GameState.js';
import { Rng } from '../../src/core/rng.js';

const SEEDS = [1, 7, 42, 999, 2024, 12345, 55555, 314159];

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

/** Can a hero stand and walk THROUGH (x,y)? Mirrors carveConnectivity.passable. */
function passable(map, x, y) {
  const t = map.tiles[y * map.w + x];
  if (t.terrain === 'water' || t.obstacle) return false;
  // Towns are solid — visited from an adjacent tile, never walked through.
  const occ = t.objectId && map.objects[t.objectId];
  if (occ && occ.type === 'town') return false;
  return true;
}

/** 4-directional multi-source flood; returns a seen[] over the whole grid. */
function flood(map, seeds) {
  const { w, h } = map;
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
      if (seen[ni] || !passable(map, nx, ny)) continue;
      seen[ni] = 1;
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/** Reachable if we can STAND on the object's tile or any of its 8 neighbours. */
function nearReachable(map, seen, obj) {
  const { w, h } = map;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = obj.x + dx, ny = obj.y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (seen[ny * w + nx]) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------

test('mapgen never throws its unreachable-object guard for standard seeds', () => {
  // generateMap self-certifies from both towns and throws loudly otherwise, so
  // a clean return is itself the first connectivity assertion.
  for (const seed of SEEDS) {
    assert.doesNotThrow(() => buildMap(seed), `seed ${seed} generated cleanly`);
  }
});

test('every object is reachable from EACH town start (independently)', () => {
  for (const seed of SEEDS) {
    const { map, towns: allTowns } = buildMap(seed);
    // The same callback now also registers the underground's neutral towns
    // (z: 1); the surface contract concerns the two z: 0 start towns.
    const towns = allTowns.filter((t) => (t.z ?? 0) === 0);
    assert.equal(towns.length, 2, 'two surface towns registered');
    assert.ok(allTowns.length > towns.length, 'plus at least one underground town');
    for (const town of towns) {
      const seen = flood(map, [{ x: town.x, y: town.y }]);
      for (const obj of Object.values(map.objects)) {
        if (obj.seaLocked) continue; // island reward — reachable by boat, not on foot
        if (obj.type === 'whirlpool') continue; // deep-water hazard — boat-only by design
        assert.ok(
          nearReachable(map, seen, obj),
          `seed ${seed}: ${obj.type} ${obj.id} at ${obj.x},${obj.y} unreachable from town at ${town.x},${town.y}`,
        );
      }
    }
  }
});

test('the two zones connect: each town is reachable from the other', () => {
  // The guarded pass gaps must actually link the realms — otherwise the enemy
  // town (an object) would fail the check above, but assert it head-on too.
  for (const seed of SEEDS) {
    const { map, towns: allTowns } = buildMap(seed);
    const towns = allTowns.filter((t) => (t.z ?? 0) === 0);
    const fromA = flood(map, [{ x: towns[0].x, y: towns[0].y }]);
    assert.ok(nearReachable(map, fromA, towns[1]), `seed ${seed}: town1 reachable from town0`);
    const fromB = flood(map, [{ x: towns[1].x, y: towns[1].y }]);
    assert.ok(nearReachable(map, fromB, towns[0]), `seed ${seed}: town0 reachable from town1`);
  }
});

test('no isolated pocket hides an object (nothing that could strand a hero)', () => {
  // Cosmetic dead-ends (a stray clearing behind rocks) may exist, but they must
  // be empty: every OBJECT tile has to sit in the main component reachable from
  // the towns, so a hero can never be sent to — or spawned onto — a stranded goal.
  for (const seed of SEEDS) {
    const { map, towns: allTowns } = buildMap(seed);
    const towns = allTowns.filter((t) => (t.z ?? 0) === 0);
    const seen = flood(map, towns.map((t) => ({ x: t.x, y: t.y })));
    for (const obj of Object.values(map.objects)) {
      if (obj.type === 'town') continue; // solid: certified via neighbours above
      if (obj.seaLocked) continue; // island reward — sits in the sea on purpose, boat-only
      if (obj.type === 'whirlpool') continue; // sits in DEEP water on purpose, boat-only
      const onTile = seen[obj.y * map.w + obj.x];
      const reachable = onTile || nearReachable(map, seen, obj);
      assert.ok(reachable, `seed ${seed}: object ${obj.id} sits in an isolated pocket`);
    }
  }
});

test('a top-tier (value-4) artifact is placed, and every artifact is real', () => {
  // The best artifacts (only Titan's Gladius at value 4) were never placed — dead
  // content. The generator now seeds one value-4 grand prize; the surrounding
  // reachability tests already prove it is obtainable from both towns.
  for (const seed of SEEDS) {
    const { map } = buildMap(seed);
    const arts = Object.values(map.objects).filter((o) => o.type === 'artifact');
    assert.ok(arts.length > 0, `seed ${seed}: artifacts placed`);
    for (const a of arts) assert.ok(ARTIFACTS[a.artifact], `seed ${seed}: ${a.artifact} is a real artifact`);
    assert.ok(arts.some((a) => ARTIFACTS[a.artifact].value === 4), `seed ${seed}: a value-4 artifact is placed`);
  }
});

test('New Game never crashes on a connectivity-carve failure', () => {
  // ~0.2% of seeds produce a layout the carve cannot fully link; generateMap
  // throws rather than ship an unreachable objective. newGame must retry with a
  // nudged seed instead of hard-crashing. These specific seeds throw on the first
  // (unnudged) attempt — they are the exact regression this guards.
  for (const seed of [524, 923, 1073, 1789, 2967]) {
    let game;
    assert.doesNotThrow(() => { game = newGame({ seed }); }, `seed ${seed} must not crash New Game`);
    const all = Object.values(game.towns);
    assert.equal(all.filter((t) => (t.z ?? 0) === 0).length, 2, `seed ${seed}: two surface towns`);
    assert.ok(all.some((t) => (t.z ?? 0) === 1 && t.owner === -1),
      `seed ${seed}: a neutral underground town`);
    assert.ok(game.map && game.map.w > 0, `seed ${seed}: a map was built`);
  }
  // And a broad sweep: no seed in the range may crash, whatever the layout.
  for (let seed = 0; seed < 1200; seed++) {
    assert.doesNotThrow(() => newGame({ seed }), `seed ${seed} crashed New Game`);
  }
});

test('New Game is deterministic per seed even after a carve retry', () => {
  // 1073 needs a retry; the rescued layout must still be identical run to run.
  const a = newGame({ seed: 1073 });
  const b = newGame({ seed: 1073 });
  assert.equal(Object.keys(a.map.objects).length, Object.keys(b.map.objects).length);
  for (const id of Object.keys(a.map.objects)) {
    const oa = a.map.objects[id];
    const ob = b.map.objects[id];
    assert.ok(ob, `object ${id} present in both runs`);
    assert.equal(`${oa.type}@${oa.x},${oa.y}`, `${ob.type}@${ob.x},${ob.y}`);
  }
});

test('generation is deterministic per seed', () => {
  const a = buildMap(12345);
  const b = buildMap(12345);
  assert.equal(Object.keys(a.map.objects).length, Object.keys(b.map.objects).length);
  // Same seed → identical object layout (positions and types line up).
  for (const id of Object.keys(a.map.objects)) {
    const oa = a.map.objects[id], ob = b.map.objects[id];
    assert.ok(ob, `object ${id} present in both`);
    assert.equal(`${oa.type}@${oa.x},${oa.y}`, `${ob.type}@${ob.x},${ob.y}`);
  }
});
