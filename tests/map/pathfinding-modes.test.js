/**
 * pathfinding-modes.test.js — travel modes and the Pathfinding skill in findPath
 * / stepCost (2026-07 repo review, backlog item F54).
 *
 * Covers what roads.test.js did not: a Fly hero crossing an obstacle a walker
 * cannot, a Water-Walk hero striding over water a walker cannot, and the
 * Pathfinding skill discounting a penalty-terrain step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findPath, stepCost } from '../../src/map/Pathfinding.js';
import { CONFIG } from '../../src/config.js';

function gridState(w, h) {
  const tiles = [];
  for (let i = 0; i < w * h; i++) tiles.push({ terrain: 'grass', obstacle: null, objectId: null, road: null });
  return { map: { w, h, tiles, objects: {}, nextOid: 1 }, heroes: {}, players: [] };
}
const T = (s, x, y) => s.map.tiles[y * s.map.w + x];
// Tower is native to snow, not the grass/swamp used here, so terrain costs stay
// at their listed rate (no home-terrain bonus muddying the comparisons).
const hero = (extra = {}) => ({ x: 0, y: 0, z: 0, faction: 'tower', skills: {}, army: [], mp: 100000, ...extra });

test('findPath: a flying hero crosses an obstacle wall a walker cannot (F54)', () => {
  const s = gridState(3, 1);
  T(s, 1, 0).obstacle = 'rock'; // the only route (single row) is blocked

  assert.equal(findPath(s, hero(), 2, 0, -1), null, 'a walker is stopped by the obstacle');
  const flown = findPath(s, hero({ flying: true }), 2, 0, -1);
  assert.ok(flown && flown.path.length, 'a flying hero paths straight through');
});

test('findPath: a water-walking hero strides over water a walker cannot (F54)', () => {
  const s = gridState(3, 1);
  T(s, 1, 0).terrain = 'water';

  assert.equal(findPath(s, hero(), 2, 0, -1), null, 'a walker cannot enter water on foot');
  const walked = findPath(s, hero({ waterWalk: true }), 2, 0, -1);
  assert.ok(walked && walked.path.length, 'Water Walk crosses the water tile');
});

test('stepCost: the Pathfinding skill discounts a penalty-terrain step (F54)', () => {
  const s = gridState(2, 1);
  T(s, 1, 0).terrain = 'swamp'; // a terrain with a movement penalty
  assert.ok(CONFIG.TERRAIN_COST.swamp > 1, 'swamp is a penalty terrain');

  const plain = stepCost(s, hero(), 0, 0, 1, 0);
  const skilled = stepCost(s, hero({ skills: { pathfinding: 3 } }), 0, 0, 1, 0);
  assert.ok(skilled < plain, `Pathfinding cuts the penalty (${skilled} < ${plain})`);
  // …but never below the base straight-step cost (a road/native bonus aside).
  assert.ok(skilled >= CONFIG.MOVE_COST_STRAIGHT, 'the discount does not undercut the base step');
});
