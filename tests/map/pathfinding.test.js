/**
 * pathfinding.test.js — Headless tests for the adventure-map A*.
 *
 * Drives the REAL findPath (its binary min-heap open set, octile heuristic and
 * no-corner-cutting rule) over small hand-built grids where the optimum is easy
 * to reason about. On flat "grass" every step costs MOVE_COST_STRAIGHT and every
 * diagonal MOVE_COST_DIAGONAL, so exact costs are checked, plus the structural
 * invariants (adjacent steps, no blocked tiles, start excluded). Pure rule
 * engine, no Phaser. Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../../src/config.js';
import { findPath, terrainMultFor } from '../../src/map/Pathfinding.js';

const S = CONFIG.MOVE_COST_STRAIGHT;   // 100
const D = CONFIG.MOVE_COST_DIAGONAL;   // 141

/**
 * Build a minimal headless state from an ASCII map. Legend:
 *   '.' open (grass, cost 1.0)   '#' obstacle (rock)   '~' water
 * Rows are equal length; row 0 is y=0.
 */
function makeState(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const tiles = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      tiles[y * w + x] = {
        terrain: c === '~' ? 'water' : 'grass',
        obstacle: c === '#' ? 'rock' : null,
        objectId: null,
      };
    }
  }
  return { map: { w, h, tiles, objects: {} }, heroes: {} };
}

/** A hero NOT native to grass (Tower = snow): grass carries no penalty and no
 *  home bonus, so terrainMult stays 1.0 and costs are pure S/D on these grids. */
function makeHero(x, y) {
  return { faction: 'tower', x, y, owner: 0, skills: {} };
}

/** Assert a returned path is well-formed and its per-step costs sum correctly. */
function assertValidPath(state, sx, sy, result) {
  assert.ok(result, 'path exists');
  assert.ok(result.path.length > 0, 'path has steps');
  let px = sx, py = sy, sum = 0;
  for (const step of result.path) {
    const dx = Math.abs(step.x - px), dy = Math.abs(step.y - py);
    assert.ok(dx <= 1 && dy <= 1 && (dx || dy), `step ${step.x},${step.y} adjacent to ${px},${py}`);
    const tile = state.map.tiles[step.y * state.map.w + step.x];
    assert.ok(!tile.obstacle && tile.terrain !== 'water', 'step never lands on a blocked tile');
    assert.equal(step.cost, dx && dy ? D : S, 'step cost matches straight/diagonal on flat grass');
    sum += step.cost;
    px = step.x; py = step.y;
  }
  assert.equal(sum, result.totalCost, 'per-step costs sum to totalCost');
  // The path excludes the start tile (documented contract).
  assert.ok(!(result.path[0].x === sx && result.path[0].y === sy), 'start tile excluded');
}

// ---------------------------------------------------------------------------

test('straight line: optimal cost and one step per tile', () => {
  const state = makeState(['......']);
  const res = findPath(state, makeHero(0, 0), 5, 0, -1);
  assertValidPath(state, 0, 0, res);
  assert.equal(res.path.length, 5);
  assert.equal(res.totalCost, 5 * S);
});

test('open diagonal: takes the diagonal, not a staircase of straights', () => {
  const state = makeState(['......', '......', '......', '......', '......', '......']);
  const res = findPath(state, makeHero(0, 0), 5, 5, -1);
  assertValidPath(state, 0, 0, res);
  assert.equal(res.path.length, 5, 'five diagonal steps, not ten straights');
  assert.equal(res.totalCost, 5 * D);
});

test('single diagonal beats two straights', () => {
  const state = makeState(['..', '..']);
  const res = findPath(state, makeHero(0, 0), 1, 1, -1);
  assertValidPath(state, 0, 0, res);
  assert.equal(res.path.length, 1);
  assert.equal(res.totalCost, D); // 141 < 2*100
});

test('mixed dx/dy: min(dx,dy) diagonals then the straight remainder', () => {
  // (0,0) -> (4,2): 2 diagonals + 2 straights is optimal (482), the heap must
  // not settle for an all-straight 6-step route (600).
  const state = makeState(['.....', '.....', '.....', '.....', '.....']);
  const res = findPath(state, makeHero(0, 0), 4, 2, -1);
  assertValidPath(state, 0, 0, res);
  assert.equal(res.path.length, 4);
  assert.equal(res.totalCost, 2 * D + 2 * S);
});

test('detour: routes around a lone obstacle at the optimal cost', () => {
  // Center blocked forces one straight + one diagonal + one straight = 341.
  const state = makeState(['...', '.#.', '...']);
  const res = findPath(state, makeHero(0, 0), 2, 2, -1);
  assertValidPath(state, 0, 0, res);
  assert.equal(res.totalCost, S + D + S);
});

test('no corner cutting: cannot squeeze diagonally between two blocks', () => {
  // Both orthogonal neighbours of the diagonal are walls, so the move is illegal
  // and the target is unreachable.
  const state = makeState(['.#', '#.']);
  const res = findPath(state, makeHero(0, 0), 1, 1, -1);
  assert.equal(res, null);
});

test('blocked destination is unreachable (obstacle)', () => {
  const state = makeState(['..', '.#']);
  const res = findPath(state, makeHero(0, 0), 1, 1, -1);
  assert.equal(res, null);
});

test('water destination is unreachable', () => {
  const state = makeState(['..', '.~']);
  const res = findPath(state, makeHero(0, 0), 1, 1, -1);
  assert.equal(res, null);
});

test('a full wall with no gap strands the far side', () => {
  const state = makeState(['...', '###', '...']);
  const res = findPath(state, makeHero(0, 0), 0, 2, -1);
  assert.equal(res, null);
});

test('a one-tile gap in the wall is found and used', () => {
  // Gap at (1,1): the only crossing, reached via a diagonal from either side.
  const state = makeState(['...', '#.#', '...']);
  const res = findPath(state, makeHero(0, 0), 0, 2, -1);
  assertValidPath(state, 0, 0, res);
  assert.ok(res.path.some((s) => s.x === 1 && s.y === 1), 'route passes through the gap');
});

test('edge cases: out-of-bounds target and zero-length request return null', () => {
  const state = makeState(['...', '...', '...']);
  assert.equal(findPath(state, makeHero(0, 0), 5, 5, -1), null, 'off-map target');
  assert.equal(findPath(state, makeHero(0, 0), -1, 0, -1), null, 'negative target');
  assert.equal(findPath(state, makeHero(2, 2), 2, 2, -1), null, 'start === target');
});

test('native terrain: a symmetric ~10% home-turf bonus, foreign penalties intact', () => {
  // CLONE: upstream also uses a TOWER hero here, for the case "a faction is native to
  // a terrain that PENALISES everyone else" (snow, 1.5x). Tower is not a playable
  // faction in this tree, and terrainMultFor reads nativeTerrain out of the FACTIONS
  // registry, so an unregistered faction is native to nothing and the assertion could
  // only pass by accident. Every property the test checks still gets checked below,
  // using the two factions this clone registers — the one thing lost is that snow is
  // now nobody's home ground, so it appears only as a foreign penalty.
  const castle = { faction: 'castle', skills: {} };   // native grass
  const inferno = { faction: 'inferno', skills: {} }; // native lava
  const B = CONFIG.NATIVE_TERRAIN_MULT;
  // Each faction strides its OWN terrain at the bonus rate...
  assert.equal(terrainMultFor(castle, 'grass'), B, 'castle at home on grass');
  assert.equal(terrainMultFor(inferno, 'lava'), B, 'inferno at home on lava');
  // ...while a foreigner pays the terrain's normal rate (no bonus, full penalty).
  assert.equal(terrainMultFor(inferno, 'grass'), 1.0, 'foreign but penalty-free terrain');
  assert.equal(terrainMultFor(castle, 'lava'), CONFIG.TERRAIN_COST.lava,
    'a foreigner gets no bonus on someone else\'s home ground');
  assert.equal(terrainMultFor(castle, 'snow'), CONFIG.TERRAIN_COST.snow, 'foreign penalty terrain stands');
  assert.ok(B < 1.0 && terrainMultFor(castle, 'grass') < terrainMultFor(inferno, 'grass'),
    'locals are strictly faster on their home ground');
});
