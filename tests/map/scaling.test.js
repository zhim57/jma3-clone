/**
 * scaling.test.js — MapGenerator across the size ladder.
 *
 * The generator promises the same contract at EVERY size, not just the 44x36
 * default: clean generation (no unreachable-object throw), two towns, every
 * object reachable from BOTH town starts, a guarded top-tier grand prize, and
 * object density that scales with map area so big maps aren't sparse deserts.
 * These tests sweep many seeds per rung of a small→large ladder and re-derive
 * reachability independently with a 4-directional flood — stricter than the
 * game's diagonal A*, so anything certified here is reachable in play.
 * Pure rule-engine, no Phaser. Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap } from '../../src/map/MapGenerator.js';
import { ARTIFACTS } from '../../src/data/artifacts.js';
import { Rng } from '../../src/core/rng.js';

// Small → large. 56x46+ is where the old fixed-thickness-blind ridge sealed
// the map shut on ~every seed, so the upper rungs are the regression teeth.
const SIZES = [[36, 30], [44, 36], [56, 46], [72, 60], [88, 72]];
const SEEDS_PER_SIZE = 60;

/** Spread seeds around per size so rungs don't all sample the same streams. */
function seedsFor(w, h) {
  const seeds = [];
  for (let k = 1; k <= SEEDS_PER_SIZE; k++) seeds.push(k * 7919 + w * 131 + h);
  return seeds;
}

/** Build a map the way GameState.newGame does, minus the rest of the state. */
function buildMap(seed, w, h) {
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

for (const [w, h] of SIZES) {
  test(`${w}x${h}: generates cleanly with 2 towns, all objects reachable from BOTH towns`, () => {
    for (const seed of seedsFor(w, h)) {
      // generateMap self-certifies from both towns and throws loudly
      // otherwise, so a clean return is itself the first assertion.
      let built;
      assert.doesNotThrow(() => { built = buildMap(seed, w, h); }, `seed ${seed} generated cleanly`);
      const { map, towns: allTowns } = built;
      // The callback also registers the underground's neutral (z: 1) towns
      // and — from 56x46 up — the surface's neutral (owner -1) freeholds;
      // the start-town contract concerns the two OWNED z: 0 towns. Every
      // neutral surface town still faces the full reachability certification
      // below (a town is an object like any other).
      const towns = allTowns.filter((t) => (t.z ?? 0) === 0 && t.owner >= 0);
      assert.equal(towns.length, 2, `seed ${seed}: two surface start towns registered`);

      // Re-derive the reachability guarantee independently, per town.
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

      // The guarded grand prize: exactly the marquee reward every scenario owes.
      const prize = Object.values(map.objects).some(
        (o) => o.type === 'artifact' && ARTIFACTS[o.artifact] && ARTIFACTS[o.artifact].value === 4,
      );
      assert.ok(prize, `seed ${seed}: a top-tier (value-4) artifact is placed`);
    }
  });
}

test('same seed and size twice → identical object layout and terrain', () => {
  for (const [w, h] of SIZES) {
    const seed = seedsFor(w, h)[0];
    const a = buildMap(seed, w, h);
    const b = buildMap(seed, w, h);
    const ids = Object.keys(a.map.objects);
    assert.equal(ids.length, Object.keys(b.map.objects).length, `${w}x${h}: same object count`);
    for (const id of ids) {
      const oa = a.map.objects[id], ob = b.map.objects[id];
      assert.ok(ob, `${w}x${h}: object ${id} present in both`);
      assert.equal(`${oa.type}@${oa.x},${oa.y}`, `${ob.type}@${ob.x},${ob.y}`, `${w}x${h}: ${id} matches`);
    }
    // Terrain/obstacle fields must line up tile for tile, not just objects.
    for (let i = 0; i < w * h; i++) {
      const ta = a.map.tiles[i], tb = b.map.tiles[i];
      if (ta.terrain !== tb.terrain || ta.obstacle !== tb.obstacle) {
        assert.fail(`${w}x${h}: tile ${i % w},${(i / w) | 0} differs between runs`);
      }
    }
  }
});

test('object count grows with map area (bigger maps are proportionally richer)', () => {
  // Average across a handful of seeds so one crowded/roomy outlier can't
  // flip the ordering; the density design leaves a wide margin anyway.
  const PROBE_SEEDS = 8;
  const avgCount = (w, h) => {
    let sum = 0;
    for (const seed of seedsFor(w, h).slice(0, PROBE_SEEDS)) {
      sum += Object.keys(buildMap(seed, w, h).map.objects).length;
    }
    return sum / PROBE_SEEDS;
  };
  const counts = SIZES.map(([w, h]) => avgCount(w, h));
  for (let i = 1; i < counts.length; i++) {
    assert.ok(
      counts[i] > counts[i - 1],
      `avg objects at ${SIZES[i][0]}x${SIZES[i][1]} (${counts[i]}) > at ${SIZES[i - 1][0]}x${SIZES[i - 1][1]} (${counts[i - 1]})`,
    );
  }
  // The largest rung has ~4x the area of the smallest — demand a material
  // richness gap, not a rounding artifact.
  assert.ok(
    counts[counts.length - 1] >= 2 * counts[0],
    `88x72 (${counts[counts.length - 1]}) at least doubles 36x30 (${counts[0]})`,
  );
});
