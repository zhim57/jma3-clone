/**
 * ai-reachability.test.js — the AI's pathing keys + reachability-gated goals
 * (2026-07 repo review, "AI reachability cluster").
 *
 * Two structural holes closed:
 * - The AI paths fog-omnisciently (forPlayer = -1), which also stripped its
 *   KEY ownership — every Border Guard was a permanent wall to it, making the
 *   whole Keymaster subsystem human-only content while the AI still paid MP
 *   to collect useless keys. findPath/flood now resolve keys against the
 *   hero's owner.
 * - pickGoal priced prizes with no reachability check: a hero whose zone was
 *   looted burned all 24 plan retries (24 failed full-map A* searches) on
 *   far-side jackpots and stalled with FULL movement, every day, forever.
 *   consider() now gates every direct goal on the plan's reach flood.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { findPath, isWalkable } from '../src/map/Pathfinding.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const COLOR = CONFIG.KEY_COLORS[0].id;

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
}

/** Clear a rectangle to open grass (keeps towns). */
function clearRect(state, x0, y0, x1, y1) {
  const m = state.map;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    const t = m.tiles[y * m.w + x];
    t.terrain = 'grass'; t.obstacle = null; t.road = null;
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') {
      delete m.objects[t.objectId]; t.objectId = null;
    }
  }
}

function wallColumn(state, x, y0, y1, gapY = null) {
  const m = state.map;
  for (let y = y0; y <= y1; y++) {
    if (y === gapY) continue;
    m.tiles[y * m.w + x].obstacle = 'mountain';
  }
}

test('the AI paths through a Border Guard once ITS owner holds the key (fog-omniscient)', () => {
  const s = newGame({ seed: 31 });
  const hero = playerHeroes(s, 1)[0]; // the AI's hero
  // A fully enclosed room split by an inner wall whose only doorway holds the
  // guard — the outside world cannot offer a detour.
  clearRect(s, 8, 8, 18, 16);
  const m = s.map;
  for (let x = 8; x <= 18; x++) {
    m.tiles[8 * m.w + x].obstacle = 'mountain';
    m.tiles[16 * m.w + x].obstacle = 'mountain';
  }
  for (let y = 8; y <= 16; y++) {
    m.tiles[y * m.w + 8].obstacle = 'mountain';
    m.tiles[y * m.w + 18].obstacle = 'mountain';
  }
  wallColumn(s, 13, 9, 15, 12);
  const guard = putObj(s, 13, 12, { type: 'borderGuard', color: COLOR });
  hero.x = 10; hero.y = 12; hero.z = 0; hero.inTownId = null; hero.onBoat = false;

  // Keyless: fog-omniscient pathing must STILL respect the locked door.
  assert.equal(findPath(s, hero, 16, 12, -1), null, 'keyless AI cannot route through');
  // The plain omniscient probe (no key owner) still blocks — unchanged contract.
  assert.equal(isWalkable(s, guard.x, guard.y, -1), false);

  // With the key, the same fog-omniscient call routes through the doorway.
  s.players[1].keys.push(COLOR);
  const path = findPath(s, hero, 16, 12, -1);
  assert.ok(path, 'keyed AI routes through its unlocked door');
  assert.ok(path.path.some((st) => st.x === guard.x && st.y === guard.y),
    'the route passes THROUGH the guard tile');
});

test('a walled-in hero does not burn plan retries on unreachable jackpots (full-MP stall)', () => {
  const s = newGame({ seed: 31 });
  const hero = playerHeroes(s, 1)[0];
  // Seal the hero in a 5×5 pocket with nothing of value inside…
  clearRect(s, 20, 20, 24, 24);
  const m = s.map;
  for (let x = 19; x <= 25; x++) {
    m.tiles[19 * m.w + x].obstacle = 'mountain';
    m.tiles[25 * m.w + x].obstacle = 'mountain';
  }
  for (let y = 19; y <= 25; y++) {
    m.tiles[y * m.w + 19].obstacle = 'mountain';
    m.tiles[y * m.w + 25].obstacle = 'mountain';
  }
  hero.x = 22; hero.y = 22; hero.z = 0; hero.inTownId = null; hero.onBoat = false;
  hero.mp = 2000;

  const ai = new AITurnController(s, 1);
  const plan = ai.makePlan(hero);
  // The whole outside world (towns, mines, chests…) is out of reach: the goal
  // scan must come up (nearly) empty WITHOUT pathfinding at every jackpot on
  // the map. Ring-2 tolerance admits a few boundary-adjacent objects — the
  // bound is "a handful", not the old behavior of burning all 24 retries.
  assert.ok(ai.metrics.pathfinds <= 8,
    `unreachable prizes must not consume plan retries (ran ${ai.metrics.pathfinds} A*)`);
  if (plan && plan.goal) {
    assert.ok(Math.abs(plan.goal.x - 22) <= 3 && Math.abs(plan.goal.y - 22) <= 3,
      `any plan must stay inside the pocket, got ${plan.goal.x},${plan.goal.y}`);
  }
});
