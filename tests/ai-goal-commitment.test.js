/**
 * ai-goal-commitment.test.js — the adventure AI keeps the goal it picked.
 *
 * Every goal is priced value / distance and re-priced from the hero's CURRENT
 * position whenever it needs a plan, which makes the ranking unstable in a very
 * specific way: walk a day toward a far prize and the one behind you gains score
 * purely by receding. A 35-day campaign log caught the consequence — four of
 * seven AI heroes spent the whole game pacing between two tiles with a frozen
 * army, one of them the strongest force on the map.
 *
 * So a chosen goal is now REMEMBERED on the hero (hero.aiGoal) and defended:
 *
 *   1. it is kept while it stays a live candidate,
 *   2. a challenger must beat it by GOAL_TUNING.hysteresis to take over,
 *   3. it must earn its keep — no new closest approach in progressDays and it
 *      is shelved (hero.aiGoalBans) for banDays,
 *   4. and a target whose path fails on failStrikes separate DAYS is shelved
 *      the same way, because the old per-turn blacklist forgot every failure at
 *      dusk and the hero re-picked the same impossible prize each dawn.
 *
 * Every change is logged (old goal, new goal, both scores, reason) — without
 * that the next oscillation is as hard to find as this one was.
 *
 * All headless and deterministic (fixed seed, hand-built candidate lists).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, playerHeroes, playerTowns, serialize, deserialize,
} from '../src/core/GameState.js';
import { AITurnController, GOAL_TUNING } from '../src/ai/AIPlayer.js';
import { aiLogEntries } from '../src/ai/aiLog.js';

const SEED = 4242;
const AI = 1;

/** A controller and one of its heroes, standing in the open. */
function setup() {
  const s = newGame({ seed: SEED });
  const ai = new AITurnController(s, AI);
  const hero = playerHeroes(s, AI)[0];
  hero.inTownId = null;
  return { s, ai, hero };
}

/** A candidate goal in pickGoal's shape. */
const goal = (hero, dx, dy, score, id, what = 'mine') => ({
  x: hero.x + dx, y: hero.y + dy, z: hero.z ?? 0, score, what, id,
});

// ---------------------------------------------------------------------------

test('commitment: a near-tie challenger cannot displace the incumbent', () => {
  const { ai, hero } = setup();
  const incumbent = goal(hero, 10, 0, 100, 'O1');
  ai.noteGoal(hero, incumbent, [incumbent]);
  assert.equal(hero.aiGoal.key, 'mine|O1', 'the goal is remembered on the hero');

  // Sorted as pickGoal sorts them: the challenger leads, but only by 20%.
  const challenger = goal(hero, -2, 0, 120, 'O2');
  const kept = ai.commitGoal(hero, [challenger, incumbent]);

  assert.equal(kept.id, 'O1', 'the incumbent holds inside the hysteresis band');
});

test('commitment: a decisively better challenger takes over', () => {
  const { ai, hero } = setup();
  const incumbent = goal(hero, 10, 0, 100, 'O1');
  ai.noteGoal(hero, incumbent, [incumbent]);

  const challenger = goal(hero, -2, 0, 100 * GOAL_TUNING.hysteresis, 'O2');
  const kept = ai.commitGoal(hero, [challenger, incumbent]);

  assert.equal(kept.id, 'O2', 'beating the incumbent by the full margin wins');
});

test('commitment: an incumbent that has left the board is dropped', () => {
  const { ai, hero } = setup();
  const incumbent = goal(hero, 10, 0, 100, 'O1');
  ai.noteGoal(hero, incumbent, [incumbent]);

  const other = goal(hero, -4, 0, 10, 'O2'); // far worse, but it is all there is
  const kept = ai.commitGoal(hero, [other]);

  assert.equal(kept.id, 'O2', 'a goal that is no longer a candidate cannot be held');
});

test('commitment: a goal that never gets closer is shelved, and stays shelved', () => {
  const { s, ai, hero } = setup();
  const stuck = goal(hero, 10, 0, 100, 'O1');
  const spare = goal(hero, -3, 0, 40, 'O2');
  ai.noteGoal(hero, stuck, [stuck, spare]);
  const day0 = s.day;

  // The hero never moves, so it never comes closer than it already was.
  for (let i = 1; i < GOAL_TUNING.progressDays; i++) {
    s.day = day0 + i;
    assert.equal(ai.commitGoal(hero, [stuck, spare]).id, 'O1', 'still trying on day ' + s.day);
  }
  s.day = day0 + GOAL_TUNING.progressDays;
  const kept = ai.commitGoal(hero, [stuck, spare]);

  assert.equal(kept.id, 'O2', 'the stalled goal is abandoned for the next best');
  assert.ok(ai.isGoalBanned(hero, 'mine', 'O1', stuck.x, stuck.y, 0), 'and shelved');
  // The shelf outlasts the turn — that is the whole point of it living on the hero.
  s.day = day0 + GOAL_TUNING.progressDays + GOAL_TUNING.banDays - 1;
  assert.ok(ai.isGoalBanned(hero, 'mine', 'O1', stuck.x, stuck.y, 0), 'still shelved days later');
  s.day = day0 + GOAL_TUNING.progressDays + GOAL_TUNING.banDays + 1;
  assert.ok(!ai.isGoalBanned(hero, 'mine', 'O1', stuck.x, stuck.y, 0), 'and then lapses');
});

test('commitment: progress is remembered per TARGET, so A→B→A cannot reset the clock', () => {
  const { s, ai, hero } = setup();
  const a = goal(hero, 10, 0, 100, 'O1');
  const b = goal(hero, -10, 0, 100, 'O2', 'chest');
  const day0 = s.day;

  // The classic cycle: the hero trades between two goals on alternate days.
  ai.noteGoal(hero, a, [a, b]);
  s.day = day0 + 1;
  ai.noteGoal(hero, b, [a, b]);
  s.day = day0 + 2;
  ai.noteGoal(hero, a, [a, b]);

  assert.equal(hero.aiGoal.bestDistDay, day0,
    're-committing to a goal inherits the day it last came closest — not today');

  // So the progress clock, which has been running against O1 all along, rings.
  s.day = day0 + GOAL_TUNING.progressDays;
  const kept = ai.commitGoal(hero, [a, b]);
  assert.equal(kept.id, 'O2', 'the goal it never approached is dropped');
  assert.ok(ai.isGoalBanned(hero, 'mine', 'O1', a.x, a.y, 0), 'and shelved');
});

test('commitment: a target whose path fails on repeated DAYS is shelved', () => {
  const { s, ai, hero } = setup();
  const unreachable = goal(hero, 1, 0, 100, 'O9');
  const day0 = s.day;

  // Retries within one turn are one strike: a single turn's failed pathfinds
  // must not condemn a target that is merely blocked for a moment.
  for (let i = 0; i < 5; i++) ai.noteGoalFailure(hero, unreachable);
  assert.ok(!ai.isGoalBanned(hero, 'mine', 'O9', unreachable.x, unreachable.y, 0),
    'one day of failures is not a verdict');

  for (let d = 1; d < GOAL_TUNING.failStrikes; d++) {
    s.day = day0 + d;
    ai.noteGoalFailure(hero, unreachable);
  }
  assert.ok(ai.isGoalBanned(hero, 'mine', 'O9', unreachable.x, unreachable.y, 0),
    'failing on separate days is');
});

test('commitment: every goal change is logged with both scores and a reason', () => {
  const { s, ai, hero } = setup();
  const first = goal(hero, 10, 0, 100, 'O1');
  ai.noteGoal(hero, first, [first]);
  const better = goal(hero, -2, 0, 1000, 'O2');
  ai.noteGoal(hero, better, [better, first]);

  const entries = aiLogEntries(s, { kind: 'goal' });
  assert.equal(entries.length, 2, 'one entry per change');
  assert.equal(entries[0].reason, 'first');
  const swap = entries[1];
  assert.equal(swap.fromKey, 'mine|O1');
  assert.equal(swap.toKey, 'mine|O2');
  assert.equal(swap.reason, 'outbid', 'the old goal was still on the board');
  assert.equal(swap.fromScore, 100, 'the incumbent is quoted at its LIVE score');
  assert.equal(swap.toScore, 1000);
  assert.equal(ai.metrics.goalChanges, 1, 'the first goal is not a change');
});

test('commitment: reaching the target reads as achieved, not as churn', () => {
  const { s, ai, hero } = setup();
  const tile = { x: hero.x + 3, y: hero.y, z: hero.z ?? 0, score: 100, what: 'scout' };
  ai.noteGoal(hero, tile, [tile]);
  hero.x += 3; // arrived

  const next = goal(hero, 5, 0, 50, 'O2');
  ai.noteGoal(hero, next, [next]);

  const last = aiLogEntries(s, { kind: 'goal' }).pop();
  assert.equal(last.reason, 'achieved');
});

test('commitment: goal state round-trips a save', () => {
  const { s, ai, hero } = setup();
  const g = goal(hero, 6, 0, 100, 'O1');
  ai.noteGoal(hero, g, [g]);
  ai.banGoal(hero, { targetId: 'O7', x: 3, y: 4, z: 0 });
  ai.noteGoalFailure(hero, goal(hero, 2, 2, 10, 'O8'));

  const back = deserialize(serialize(s));
  const rHero = back.heroes[hero.id];
  assert.deepEqual(rHero.aiGoal, hero.aiGoal, 'aiGoal round-trips');
  assert.deepEqual(rHero.aiGoalBans, hero.aiGoalBans, 'the shelf round-trips');
  assert.deepEqual(rHero.aiGoalMemory, hero.aiGoalMemory, 'the progress memory round-trips');
  assert.deepEqual(rHero.aiGoalFails, hero.aiGoalFails, 'the strike record round-trips');
});

test('commitment: a shelved prize is vetoed by the real goal scan', () => {
  const { s, ai, hero } = setup();
  const first = ai.pickGoal(hero);
  assert.ok(first && first.x != null, 'the hero has something to do');

  // Shelve exactly what it chose, then ask a FRESH controller (a new turn).
  ai.banGoal(hero, { targetId: first.id ?? null, x: first.x, y: first.y, z: first.z ?? 0 });
  const ai2 = new AITurnController(s, AI);
  const second = ai2.pickGoal(hero);

  assert.ok(!second || second.x !== first.x || second.y !== first.y,
    'the shelved goal is not re-picked at dawn');
  const scan = ai2._firstScan.get(hero.id);
  assert.ok(scan, 'the scan was recorded');
});

test('commitment: a hero is never shelved out of defending its own town', () => {
  const { s, ai, hero } = setup();
  const home = { x: hero.x + 12, y: hero.y, z: 0, score: 9000, what: 'defend town', id: 'T1' };
  ai.noteGoal(hero, home, [home]);
  const day0 = s.day;

  // Days of no progress — the same evidence that shelves an ordinary prize.
  for (let i = 1; i <= GOAL_TUNING.progressDays + 1; i++) {
    s.day = day0 + i;
    ai.commitGoal(hero, [home]);
  }
  ai.noteGoalFailure(hero, home);
  s.day = day0 + GOAL_TUNING.progressDays + 2;
  ai.noteGoalFailure(hero, home);

  assert.ok(!ai.isGoalBanned(hero, 'defend town', 'T1', home.x, home.y, 0),
    'the town it must defend stays on the menu');
  assert.equal(ai.commitGoal(hero, [home]).id, 'T1', 'and it keeps riding home');
});

test('commitment: a full army is not sent home for a garrison it cannot carry', () => {
  const s = newGame({ seed: SEED });
  const hero = playerHeroes(s, AI)[0];
  const town = playerTowns(s, AI)[0];
  hero.inTownId = null;
  town.visitingHeroId = null;
  // Seven slots, seven different creatures: addToArmy has nowhere to put an
  // eighth kind, so absorbing this garrison would move exactly nothing.
  hero.army = ['pikeman', 'archer', 'griffin', 'swordsman', 'monk', 'cavalier', 'imp']
    .map((creature) => ({ creature, count: 1, hurt: 0 }));
  town.garrison = [{ creature: 'angel', count: 60, hurt: 0 }, null, null, null, null, null, null];

  const ai = new AITurnController(s, AI);
  ai.pickGoal(hero);
  assert.ok(!ai._lastGoals.some((g) => g.what === 'garrison pickup'),
    'a pickup that cannot be performed is not a goal');
  assert.equal(ai._firstScan.get(hero.id).vetoes.noRoom, 1, 'and the log says why');

  // Free one slot and the same garrison becomes worth the march.
  hero.army[6] = null;
  const ai2 = new AITurnController(s, AI);
  ai2.pickGoal(hero);
  assert.ok(ai2._lastGoals.some((g) => g.what === 'garrison pickup' && g.id === town.id),
    'with room for it, the pickup is priced as before');
});
