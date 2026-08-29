/**
 * disband.test.js — dismissing a stack from a hero's army or a town garrison.
 *
 * The only rule worth having is asymmetric, and it is the reason the check lives
 * in the engine rather than in the two screens that offer the button:
 *
 *   A town GARRISON may be emptied. An empty garrison is an ordinary state of
 *   the world — a town with no defenders is a town you are about to lose, not an
 *   illegal board.
 *
 *   A HERO may not disband its last stack. An army-less hero cannot fight,
 *   marches at the speed of a man on foot, and is one wandering monster from
 *   being deleted. A UI that offers that button strands the player's hero.
 *
 * Two screens (HeroScene, TownScene) call this, and if each carried its own copy
 * of the rule they would eventually disagree — the defect class this repo has
 * hit four times (docs/DESIGN_DECISIONS.md). No Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { disbandStack } from '../src/core/actions.js';

const st = (creature, count) => ({ creature, count, hurt: 0 });
const army = (...stacks) => {
  const a = [null, null, null, null, null, null, null];
  stacks.forEach((s, i) => { a[i] = s; });
  return a;
};

test('a stack is dismissed, not moved — nothing else in the army shifts', () => {
  const a = army(st('pikeman', 10), st('archer', 5), st('griffin', 3));
  assert.equal(disbandStack(a, 1), true);
  assert.equal(a[1], null, 'the slot is emptied');
  assert.deepEqual(a[0], st('pikeman', 10), 'its neighbours are untouched');
  assert.deepEqual(a[2], st('griffin', 3), 'and nothing slides down to fill the gap');
});

test('a hero may not disband its LAST stack', () => {
  const a = army(st('pikeman', 10));
  assert.equal(disbandStack(a, 0), false, 'refused');
  assert.deepEqual(a[0], st('pikeman', 10), 'and the board is unchanged');

  // With a second stack present the same call succeeds…
  a[3] = st('archer', 1);
  assert.equal(disbandStack(a, 0), true);
  // …and now THAT one is the last, so it is protected in turn.
  assert.equal(disbandStack(a, 3), false, 'the survivor becomes the protected one');
  assert.deepEqual(a[3], st('archer', 1));
});

test('a town garrison MAY be emptied — allowEmpty is the whole difference', () => {
  const g = army(st('pikeman', 10));
  assert.equal(disbandStack(g, 0, { allowEmpty: true }), true);
  assert.deepEqual(g, army(), 'an empty garrison is a legal board');
});

test('refusals and no-ops never mutate', () => {
  const a = army(st('pikeman', 10), st('archer', 5));
  assert.equal(disbandStack(a, 4), false, 'an empty slot');
  assert.equal(disbandStack(a, 99), false, 'out of range');
  assert.equal(disbandStack(null, 0), false, 'no army at all');
  assert.equal(disbandStack(a, 0, { allowEmpty: false }), true);
  // A zero-count ghost stack is not a stack.
  const ghost = army(st('pikeman', 0), st('archer', 5));
  assert.equal(disbandStack(ghost, 0), false, 'a 0-count slot holds nothing to dismiss');
  assert.equal(disbandStack(ghost, 1), false, 'and it does not count toward the survivor rule either');
});
