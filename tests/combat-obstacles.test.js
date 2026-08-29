/**
 * combat-obstacles.test.js — the battlefield's obstacles are scenery, not markers.
 *
 * Every land obstacle used to draw the same `decor_rock_0` decal: one boulder, one
 * size, one facing, on every blocked hex of every battlefield. The art was never the
 * problem — the adventure map draws from the same sheet and reads fine — the problem
 * was that it never varied, so a field of them read as a diagram of blocked cells.
 *
 * What is testable here is the CHOICE, which is a pure function of the hex and the
 * ground. The drawing itself is a browser concern and is covered by the combat
 * smokes; what those cannot check is that the choice is stable, varied, and fits the
 * terrain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { combatObstacleFor, decorTextureFor } from '../src/gfx/terrain.js';

const field = (terrain, n = 15) => {
  const out = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out.push(combatObstacleFor(x, y, terrain));
  return out;
};

test('the same hex always yields the same obstacle — a resize must not reshape the field', () => {
  // THE FAILURE THIS PREVENTS. The battlefield is redrawn on every relayout. Drawing
  // from an rng would give variety and would also mean the boulder you planned your
  // charge around became a tree when the window was dragged.
  for (const t of ['grass', 'snow', 'lava', 'swamp']) {
    for (let i = 0; i < 40; i++) {
      const x = i % 7, y = (i * 3) % 11;
      assert.deepEqual(combatObstacleFor(x, y, t), combatObstacleFor(x, y, t));
    }
  }
});

test('neighbours differ — the point is variety, and (x+y) would stripe the field', () => {
  // A plain sum hashes (0,1) and (1,0) alike, which lays identical rocks along every
  // diagonal. Count how many hexes differ from the one to their right.
  const n = 15;
  let differs = 0, pairs = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n - 1; x++) {
      const a = combatObstacleFor(x, y, 'grass');
      const b = combatObstacleFor(x + 1, y, 'grass');
      pairs++;
      if (a.seed !== b.seed) differs++;
    }
  }
  assert.equal(differs, pairs, 'every neighbouring pair draws a different seed');
});

test('a whole field is not one kind of thing', () => {
  const kinds = new Set(field('grass').map((o) => o.kind));
  assert.ok(kinds.size >= 2, `grass fields more than one kind of obstacle (${[...kinds]})`);
});

test('nothing stands on lava or sand — those fields are all stone', () => {
  for (const t of ['lava', 'sand']) {
    const kinds = new Set(field(t).map((o) => o.kind));
    assert.ok(!kinds.has('tree'), `${t} grows no thickets (${[...kinds]})`);
  }
});

test('snow and swamp field thickets as readily as stone', () => {
  for (const t of ['snow', 'swamp']) {
    const all = field(t);
    const trees = all.filter((o) => o.kind === 'tree').length;
    assert.ok(trees > all.length * 0.3, `${t} is wooded (${trees}/${all.length})`);
  }
});

test('no mountains — that is map-scale art and the wrong fiction for one hex', () => {
  // The first cut included them. Looked at on screen, decor_mountain drew a flat
  // grey cutout whose peak overhung the hex above it. A battle is fought around a
  // boulder or a thicket; a mountain does not fit on a hex of it.
  for (const t of ['grass', 'snow', 'lava', 'sand', 'swamp', 'dirt', 'rough']) {
    const kinds = new Set(field(t, 20).map((o) => o.kind));
    assert.ok(!kinds.has('mountain'), `${t} raises no mountains (${[...kinds]})`);
  }
});

test('every kind resolves to a decor texture that exists in the sheet', () => {
  // The scene guards on textures.exists, so a bad key is a silently missing
  // obstacle rather than a crash — which is exactly the kind of thing to pin here.
  const KEYS = new Set([
    'decor_lavarock',
    'decor_tree_0', 'decor_tree_1', 'decor_tree_2',
    'decor_rock_0', 'decor_rock_1',
  ]);
  for (const t of ['grass', 'snow', 'lava', 'sand', 'swamp', 'dirt', 'rough']) {
    for (const o of field(t, 12)) {
      const key = decorTextureFor(o.kind, t, o.seed);
      assert.ok(KEYS.has(key), `${t}/${o.kind} -> ${key} is not a decor texture`);
    }
  }
});
