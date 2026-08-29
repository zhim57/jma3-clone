/**
 * morale-undead.test.js — morale spells fizzle on the undead / mindless, and the
 * AI stops paying for them (2026-07 repo review, backlog item A6).
 *
 * sideMorale locks undead and mindless stacks to 0 morale, but the buff/debuff
 * branch happily pinned Mirth / Sorrow on them anyway (a do-nothing icon), and
 * the AI's effectValue priced the swing at face value — so it cast Sorrow on
 * Dread Knights every battle for no benefit. Now the engine fizzles a
 * morale-ONLY effect on such stacks, and effectValue zeroes their morale term.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle, castSpell } from '../src/core/combat/CombatEngine.js';
import { maybeCastAISpell } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

function makeHero(spells) {
  return {
    stats: { attack: 0, defense: 0, power: 5, knowledge: 10 },
    skills: {}, equipment: {}, army: [], spells, mana: 50, tempMorale: 0, tempLuck: 0,
  };
}

function battle(spells, enemy) {
  return createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(9),
    attacker: { hero: makeHero(spells), army: [{ creature: 'skeleton', count: 6 }, { creature: 'pikeman', count: 10 }], playerIndex: 0 },
    defender: { hero: null, army: [enemy], playerIndex: 1 },
  });
}

// --- engine: fizzle on the undead, land on the living ----------------------

test('Sorrow fizzles on an undead enemy — no hex pinned (A6)', () => {
  const b = battle(['sorrow'], { creature: 'skeleton', count: 20 });
  const foe = b.units.find((u) => u.side === 1);
  const evs = castSpell(b, 0, 'sorrow', { unitId: foe.id });
  assert.ok(evs.some((e) => e.type === 'spellFizzle'), 'the cast fizzles');
  assert.ok(!evs.some((e) => e.type === 'spellEffect'), 'no effect event');
  assert.equal(foe.effects.length, 0, 'nothing pinned on the undead');
});

test('Mirth fizzles on a FRIENDLY undead stack too (buff path) (A6)', () => {
  const b = battle(['mirth'], { creature: 'pikeman', count: 10 });
  const skel = b.units.find((u) => u.side === 0 && u.creature === 'skeleton');
  const evs = castSpell(b, 0, 'mirth', { unitId: skel.id });
  assert.ok(evs.some((e) => e.type === 'spellFizzle'), 'the buff fizzles on the undead');
  assert.equal(skel.effects.length, 0, 'no morale buff pinned');
});

test('Sorrow still LANDS on a living enemy (morale spells are not broken)', () => {
  const b = battle(['sorrow'], { creature: 'pikeman', count: 20 });
  const foe = b.units.find((u) => u.side === 1);
  const evs = castSpell(b, 0, 'sorrow', { unitId: foe.id });
  assert.ok(evs.some((e) => e.type === 'spellEffect'), 'the hex lands');
  assert.ok(foe.effects.some((e) => e.spellId === 'sorrow'), 'effect pinned on the living');
});

// --- AI: won't waste a morale hex on the undead ----------------------------

const castsSorrow = (b) => maybeCastAISpell(b, 0).some((e) => e.type === 'spellEffect' && e.spellId === 'sorrow');

test('AI does not cast Sorrow on an all-undead enemy, but does on a living one (A6)', () => {
  assert.equal(castsSorrow(battle(['sorrow'], { creature: 'skeleton', count: 40 })), false,
    'no morale hex worth casting on the undead');
  assert.equal(castsSorrow(battle(['sorrow'], { creature: 'pikeman', count: 40 })), true,
    'the same hex is worth casting on a living stack of comparable value');
});
