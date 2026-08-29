/**
 * manathief-cap.test.js — the Imp mana siphon is clamped to the thief hero's max
 * mana (2026-07 repo review, backlog item A7).
 *
 * manaThief adds a fifth of the caster's mana cost to the ENEMY hero's pool, but
 * did so with no ceiling — a full-mana hero could be pushed past max. Now it
 * clamps and reports only the actual gain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle, castSpell } from '../src/core/combat/CombatEngine.js';
import { heroMaxMana } from '../src/core/heroUtils.js';
import { Rng } from '../src/core/rng.js';

function makeHero(opts = {}) {
  return {
    stats: { attack: 0, defense: 0, power: 5, knowledge: opts.knowledge ?? 5 },
    skills: {}, equipment: {}, army: [], spells: opts.spells || [],
    mana: opts.mana ?? 50, tempMorale: 0, tempLuck: 0,
  };
}

function battleWithThief() {
  return createBattle({
    rng: new Rng(1),
    attacker: { hero: makeHero({ spells: ['implosion'], mana: 50 }), army: [{ creature: 'pikeman', count: 10 }], playerIndex: 0 },
    defender: { hero: makeHero(), army: [{ creature: 'imp', count: 100 }], playerIndex: 1 }, // imp = manaThief
  });
}

const STEAL = Math.floor(30 * 0.2); // implosion costs 30 → siphon 6

test('a full-mana thief hero gains nothing and emits no steal event (A7)', () => {
  const b = battleWithThief();
  const thief = b.sides[1].hero;
  const max = heroMaxMana(thief);
  thief.mana = max;
  const evs = castSpell(b, 0, 'implosion', { unitId: b.units.find((u) => u.side === 1).id });
  assert.equal(thief.mana, max, 'the pool is not overfilled past max');
  assert.ok(!evs.some((e) => e.type === 'manaSteal'), 'no steal event when the gain is 0');
});

test('a nearly-full thief hero gains only up to max, reported accurately (A7)', () => {
  const b = battleWithThief();
  const thief = b.sides[1].hero;
  const max = heroMaxMana(thief);
  thief.mana = max - 2; // only room for 2 of the 6 siphoned
  const evs = castSpell(b, 0, 'implosion', { unitId: b.units.find((u) => u.side === 1).id });
  assert.equal(thief.mana, max, 'clamped exactly to max');
  const steal = evs.find((e) => e.type === 'manaSteal');
  assert.ok(steal && steal.amount === 2, 'the event reports the ACTUAL gain (2), not the nominal 6');
});

test('a low-mana thief hero receives the full siphon (A7)', () => {
  const b = battleWithThief();
  const thief = b.sides[1].hero;
  const max = heroMaxMana(thief);
  thief.mana = max - 10;
  const evs = castSpell(b, 0, 'implosion', { unitId: b.units.find((u) => u.side === 1).id });
  assert.equal(thief.mana, max - 10 + STEAL, 'the full siphon lands when there is room');
  assert.ok(evs.some((e) => e.type === 'manaSteal' && e.amount === STEAL));
});
