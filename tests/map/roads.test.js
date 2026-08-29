/**
 * roads.test.js — Roads (roadmap #8): fast highways connecting the towns.
 *
 * Engine: a `tile.road` overrides the terrain penalty and discounts the step
 * (CONFIG.ROAD_COST), so the A* routes a hero along a road when it's cheaper.
 * Generator: a deterministic MST over the surface towns paints a connected road
 * network onto already-open land only. All headless, fixed seeds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap } from '../../src/map/MapGenerator.js';
import { newGame, serialize, deserialize } from '../../src/core/GameState.js';
import { Rng } from '../../src/core/rng.js';
import { stepCost, findPath } from '../../src/map/Pathfinding.js';
import { CONFIG } from '../../src/config.js';

const SEEDS = [1, 7, 42, 999, 2024, 12345];

function buildMap(seed, w = 44, h = 36) {
  const towns = [];
  const map = generateMap({
    w, h, rng: new Rng(seed),
    players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  return { map, towns };
}

/** A minimal surface-only state for stepCost / findPath. */
function gridState(w, h) {
  const tiles = [];
  for (let i = 0; i < w * h; i++) tiles.push({ terrain: 'grass', obstacle: null, objectId: null, road: null });
  return { map: { w, h, tiles, objects: {}, nextOid: 1 }, heroes: {}, players: [] };
}
// Tower is native to snow, NOT to the grass/swamp these tests use — so terrain
// costs stay at their listed rate (no home bonus muddying the road comparison).
const knight = () => ({ x: 0, y: 0, z: 0, faction: 'tower', skills: {}, army: [], mp: 100000 });

// ---------------------------------------------------------------------------

test('stepCost: a road discounts the step, cheapest→dearest cobble < dirt < open', () => {
  const s = gridState(3, 1);
  const hero = knight();
  const cell = s.map.tiles[1]; // step from (0,0) onto (1,0)
  const cost = () => stepCost(s, hero, 0, 0, 1, 0);
  cell.road = null; const open = cost();
  cell.road = 'dirt'; const dirt = cost();
  cell.road = 'cobble'; const cobble = cost();
  assert.equal(open, CONFIG.MOVE_COST_STRAIGHT, 'open grass is the base cost');
  assert.equal(dirt, Math.round(100 * CONFIG.ROAD_COST.dirt));
  assert.ok(cobble < dirt && dirt < open, `ordered: ${cobble}<${dirt}<${open}`);
});

test('stepCost: a road OVERRIDES the terrain penalty (a road across swamp is still fast)', () => {
  const s = gridState(3, 1);
  const hero = knight();
  const cell = s.map.tiles[1];
  cell.terrain = 'swamp';
  const swampOpen = stepCost(s, hero, 0, 0, 1, 0);
  cell.road = 'cobble';
  const swampRoad = stepCost(s, hero, 0, 0, 1, 0);
  assert.equal(swampOpen, Math.round(100 * CONFIG.TERRAIN_COST.swamp), 'open swamp pays the full penalty');
  assert.equal(swampRoad, Math.round(100 * CONFIG.ROAD_COST.cobble), 'a road ignores the swamp penalty');
  assert.ok(swampRoad < swampOpen, 'the road is much faster than open swamp');
});

test('findPath: the hero detours onto a road when it beats a straight slog through swamp', () => {
  const s = gridState(6, 3);
  const T = (x, y) => s.map.tiles[y * 6 + x];
  for (let x = 1; x <= 4; x++) T(x, 1).terrain = 'swamp';  // costly straight line at y=1
  for (let x = 1; x <= 4; x++) T(x, 0).road = 'cobble';    // cheap road one row up
  const hero = { ...knight(), x: 0, y: 1 };
  const res = findPath(s, hero, 5, 1, -1);
  assert.ok(res && res.path.length, 'a path was found');
  const usedRoadRow = res.path.some((p) => p.y === 0 && p.x >= 1 && p.x <= 4);
  const usedSwamp = res.path.some((p) => p.y === 1 && p.x >= 1 && p.x <= 4);
  assert.ok(usedRoadRow, 'the route climbs onto the road');
  assert.ok(!usedSwamp, 'and avoids the swamp midline');
});

test('generator: a connected road network links every surface town, on open land only', () => {
  for (const seed of SEEDS) {
    const { map } = buildMap(seed);
    const { w, h, tiles } = map;
    const roadCells = [];
    for (let i = 0; i < tiles.length; i++) if (tiles[i].road) roadCells.push(i);
    assert.ok(roadCells.length > 0, `seed ${seed}: roads were laid`);

    // Roads only overlay already-open ground — never water or an obstacle.
    for (const i of roadCells) {
      assert.notEqual(tiles[i].terrain, 'water', `seed ${seed}: no road on water`);
      assert.equal(tiles[i].obstacle, null, `seed ${seed}: no road on an obstacle`);
    }

    // Every surface town sits on the road network, all in ONE connected component.
    const townCells = Object.values(map.objects)
      .filter((o) => o.type === 'town')
      .map((o) => o.y * w + o.x);
    for (const c of townCells) assert.ok(tiles[c].road, `seed ${seed}: a road reaches each town`);
    // Flood the road graph from the first town; it must cover every town.
    const seen = new Uint8Array(w * h);
    const stack = [townCells[0]];
    seen[townCells[0]] = 1;
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!seen[ni] && tiles[ni].road) { seen[ni] = 1; stack.push(ni); }
      }
    }
    for (const c of townCells) assert.ok(seen[c], `seed ${seed}: town at ${c % w},${(c / w) | 0} is road-connected`);
  }
});

test('v2: cobble highways between towns, dirt spurs branching out to the mines', () => {
  const { map } = buildMap(4242);
  const types = new Set(map.tiles.filter((t) => t.road).map((t) => t.road));
  assert.ok(types.has('cobble'), 'main town routes are the fast cobble tier');
  assert.ok(types.has('dirt'), 'mine spurs are the dirt tier');
  // Every town sits on the cobble highway — a spur never downgrades it.
  for (const o of Object.values(map.objects)) {
    if (o.type === 'town') {
      assert.equal(map.tiles[o.y * map.w + o.x].road, 'cobble', 'towns on the highway, not a spur');
    }
  }
  // Most mines within reach are wired into the network (the far-flung few stay
  // off-grid past MAX_SPUR, by design).
  const mines = Object.values(map.objects).filter((o) => o.type === 'mine');
  const connected = mines.filter((m) => map.tiles[m.y * map.w + m.x].road).length;
  assert.ok(connected >= Math.ceil(mines.length * 0.5),
    `most mines are road-connected (${connected}/${mines.length})`);
});

test('v2: the underground gets its own tiered network when the caverns hold 2+ towns', () => {
  const { map } = buildMap(4242, 64, 56); // a larger map yields multiple cavern towns
  const ug = map.underground;
  const ugTowns = Object.values(ug.objects).filter((o) => o.type === 'town').length;
  assert.ok(ugTowns >= 2, `the larger map has 2+ underground towns (${ugTowns})`);
  assert.ok(ug.tiles.some((t) => t.road === 'cobble'), 'cavern highways were laid');
  for (const t of ug.tiles) {
    if (t.road) {
      assert.notEqual(t.terrain, 'water', 'no cavern road on water');
      assert.equal(t.obstacle, null, 'no cavern road on an obstacle');
    }
  }
});

test('a real game lays roads, and tile.road round-trips through save/load', () => {
  const s = newGame({ seed: 4242 });
  const roads = s.map.tiles.filter((t) => t.road);
  assert.ok(roads.length > 0, 'newGame produced roads');
  const sampleIdx = s.map.tiles.findIndex((t) => t.road);
  const type = s.map.tiles[sampleIdx].road;
  const r = deserialize(serialize(s));
  assert.equal(r.map.tiles[sampleIdx].road, type, 'tile.road survives serialization');
});
