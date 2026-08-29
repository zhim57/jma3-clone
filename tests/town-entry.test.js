/**
 * town-entry.test.js — the front-gate rule: a hero ON FOOT may only enter a
 * town by stepping in from the row of tiles in front of its (south-facing) gate,
 * so an approach from the sides or behind must walk AROUND to the front. Flying
 * and boat heroes are exempt, and a town whose whole front is impassable falls
 * back to being enterable from any side (never unreachable).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns, tileAt } from '../src/core/GameState.js';
import { findPath } from '../src/map/Pathfinding.js';

function clearPatch(s, cx, cy, r) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const t = tileAt(s, cx + dx, cy + dy);
      if (!t) continue;
      t.terrain = 'grass';
      t.obstacle = null;
      if (!(dx === 0 && dy === 0)) t.objectId = null; // keep the town's own objectId
    }
  }
  s.fog[0].fill(1); // whole patch explored
}

function setup() {
  const s = newGame({ seed: 3 });
  const town = playerTowns(s, 0)[0];
  town.visitingHeroId = null;
  clearPatch(s, town.x, town.y, 5);
  const hero = playerHeroes(s, 0)[0];
  hero.mp = 100000; hero.z = 0; hero.onBoat = false; hero.flying = false;
  return { s, town, hero };
}

test('a foot hero approaching from behind routes around to the front tile', () => {
  const { s, town, hero } = setup();
  hero.x = town.x; hero.y = town.y - 3; // due north, behind the gate
  const r = findPath(s, hero, town.x, town.y);
  assert.ok(r, 'a path to the town exists');
  const last = r.path[r.path.length - 1];
  const approach = r.path[r.path.length - 2]; // the tile stepped in FROM
  assert.deepEqual({ x: last.x, y: last.y }, { x: town.x, y: town.y }, 'ends on the town');
  assert.equal(approach.y, town.y + 1, 'the final step comes from a front (south) tile');
  // And it genuinely walked around — more than the 3 straight steps a cheat would take.
  assert.ok(r.path.length > 3, 'the route is longer than a straight drop through the town');
});

test('a foot hero already on the front tile enters in one step', () => {
  const { s, town, hero } = setup();
  hero.x = town.x; hero.y = town.y + 1; // directly in front of the gate
  const r = findPath(s, hero, town.x, town.y);
  assert.ok(r);
  assert.equal(r.path.length, 1, 'one step straight into the gate');
});

test('a foot hero cannot enter straight from a side — it must be the front', () => {
  const { s, town, hero } = setup();
  hero.x = town.x - 1; hero.y = town.y; // due west, beside the gate
  const r = findPath(s, hero, town.x, town.y);
  assert.ok(r);
  const approach = r.path[r.path.length - 2];
  assert.equal(approach.y, town.y + 1, 'still enters from the front row, not the side');
  assert.ok(r.path.length > 1, 'so it takes more than the single side-step');
});

test('a FLYING hero enters straight from behind (no front-gate)', () => {
  const { s, town, hero } = setup();
  hero.flying = true;
  hero.x = town.x; hero.y = town.y - 1; // directly behind
  const r = findPath(s, hero, town.x, town.y);
  assert.ok(r);
  assert.equal(r.path.length, 1, 'flight drops straight onto the gate from any side');
});

test('when the whole front is impassable, the town is still reachable (fallback)', () => {
  const { s, town, hero } = setup();
  for (const dx of [-1, 0, 1]) tileAt(s, town.x + dx, town.y + 1).obstacle = { kind: 'rock' };
  hero.x = town.x; hero.y = town.y - 1; // behind; the front is walled off
  const r = findPath(s, hero, town.x, town.y);
  assert.ok(r, 'a hemmed-in town is not made unreachable');
  assert.equal(r.path.length, 1, 'entered from the only open side');
});
