/**
 * combat-legality.test.js — the engine's reject-without-applying contract for
 * SPELLS and WAIT (2026-07 repo review, "combat legality cluster").
 *
 * castSpell used to trust its callers: a hostile buff, a friendly nuke, an
 * adventure-book spell, or a cast after battle.over all went through — and the
 * mana + the round's one cast were consumed before the kind-dispatch even ran.
 * Now castSpell validates like act(): an illegal cast returns [] with NO state
 * change. `wait` likewise enforces its once-per-round rule in the engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle, act, castSpell, canCast } from '../src/core/combat/CombatEngine.js';
import { Rng } from '../src/core/rng.js';

function makeHero(opts = {}) {
  return {
    stats: { attack: 0, defense: 0, power: opts.power ?? 5, knowledge: 5 },
    skills: opts.skills || {},
    equipment: {},
    army: [],
    spells: opts.spells || [],
    mana: opts.mana ?? 50,
    tempMorale: 0, tempLuck: 0,
  };
}

function makeBattle(spells) {
  return createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng: new Rng(42),
    attacker: {
      hero: makeHero({ spells }),
      army: [{ creature: 'pikeman', count: 10 }],
      playerIndex: 0,
    },
    defender: {
      hero: null,
      army: [{ creature: 'archer', count: 10 }],
      playerIndex: 1,
    },
  });
}

const mine = (b) => b.units.find((u) => u.side === 0);
const theirs = (b) => b.units.find((u) => u.side === 1);

test('a buff cast on an ENEMY stack is refused — no mana, no cast consumed', () => {
  const b = makeBattle(['bless']);
  const hero = b.sides[0].hero;
  const before = hero.mana;
  const evs = castSpell(b, 0, 'bless', { unitId: theirs(b).id });
  assert.deepEqual(evs, [], 'rejected outright');
  assert.equal(hero.mana, before, 'no mana spent');
  assert.equal(b.sides[0].castThisRound, false, 'the round’s cast is still available');
  assert.equal(theirs(b).effects.length, 0, 'no effect landed');
});

test('a debuff or single-target nuke on a FRIENDLY stack is refused', () => {
  const b = makeBattle(['blind', 'magicArrow']);
  const hero = b.sides[0].hero;
  const before = hero.mana;
  assert.deepEqual(castSpell(b, 0, 'blind', { unitId: mine(b).id }), []);
  assert.deepEqual(castSpell(b, 0, 'magicArrow', { unitId: mine(b).id }), []);
  assert.equal(hero.mana, before);
  assert.equal(mine(b).effects.length, 0);
  assert.equal(mine(b).hp, mine(b).maxHp, 'no friendly fire');
  // The same casts at the legal side go through.
  const evs = castSpell(b, 0, 'magicArrow', { unitId: theirs(b).id });
  assert.ok(evs.some((e) => e.type === 'spellHit'), 'legal cast lands');
});

test('a heal cast on an ENEMY stack is refused (no topping up the other side)', () => {
  const b = makeBattle(['cure']);
  theirs(b).hp = 1;
  const before = b.sides[0].hero.mana;
  assert.deepEqual(castSpell(b, 0, 'cure', { unitId: theirs(b).id }), []);
  assert.equal(theirs(b).hp, 1);
  assert.equal(b.sides[0].hero.mana, before);
});

test('an adventure-book spell can never fire in combat', () => {
  const b = makeBattle(['townPortal']);
  const hero = b.sides[0].hero;
  assert.equal(canCast(b, 0, 'townPortal'), false);
  assert.deepEqual(castSpell(b, 0, 'townPortal', {}), []);
  assert.equal(hero.mana, 50, 'no mana burnt on a spell with no combat effect');
  assert.equal(b.sides[0].castThisRound, false);
});

test('a unit-targeted cast with a missing/unknown target is refused, not a paid no-op', () => {
  const b = makeBattle(['magicArrow', 'bless']);
  const hero = b.sides[0].hero;
  assert.deepEqual(castSpell(b, 0, 'magicArrow', null), []);
  assert.deepEqual(castSpell(b, 0, 'bless', { unitId: 'nonesuch' }), []);
  assert.equal(hero.mana, 50);
  assert.equal(b.sides[0].castThisRound, false);
});

test('no casting once the battle is over', () => {
  const b = makeBattle(['magicArrow']);
  b.over = true;
  assert.equal(canCast(b, 0, 'magicArrow'), false);
  assert.deepEqual(castSpell(b, 0, 'magicArrow', { unitId: theirs(b).id }), []);
});

test('wait is once per round: the second wait is rejected and the queue is untouched', () => {
  const b = makeBattle([]);
  const u = b.units.find((x) => x.id === b.queue[b.queueIndex]);
  const evs1 = act(b, u, { type: 'wait' });
  assert.ok(evs1.some((e) => e.type === 'wait'), 'first wait is honored');
  const queueBefore = [...b.queue];
  const idxBefore = b.queueIndex;
  const evs2 = act(b, u, { type: 'wait' });
  assert.deepEqual(evs2, [], 'second wait this round is refused');
  assert.deepEqual(b.queue, queueBefore, 'queue not reshuffled');
  assert.equal(b.queueIndex, idxBefore);
});
