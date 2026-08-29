/**
 * cunning-ai.test.js — #12 (opt-in): a human-facing combat AI that mixes.
 *
 * cunningActive gates the mixing to AI stacks facing a human; cunningPick usually
 * returns the argmax but sometimes softmax-samples a NEAR-best option (never a
 * dominated one), off the seeded battle rng. And when inactive it draws no rng,
 * so Classic and every auto-resolve stay byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/core/rng.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve, cunningActive, cunningPick, maybeCastAISpell } from '../src/core/combat/CombatAI.js';

const OPTIONS = [
  { score: 100, action: { type: 'attack', targetId: 'A' } },
  { score: 95, action: { type: 'attack', targetId: 'B' } }, // near-best (>= 85)
  { score: 50, action: { type: 'attack', targetId: 'C' } }, // dominated (< 85)
];
const best = OPTIONS[0];
const mkBattle = (features, humanSide, seed) => ({ features, humanSide, rng: new Rng(seed) });

test('cunningActive: only an AI stack facing a human, with the feature on', () => {
  assert.equal(cunningActive({ features: {}, humanSide: 0 }, { side: 1 }), false, 'feature off');
  assert.equal(cunningActive({ features: { cunningAI: true }, humanSide: -1 }, { side: 1 }), false, 'no human');
  assert.equal(cunningActive({ features: { cunningAI: true }, humanSide: 0 }, { side: 0 }), false, "the human's own side");
  assert.equal(cunningActive({ features: { cunningAI: true }, humanSide: 0 }, { side: 1 }), true, 'AI vs human');
});

test('cunningPick: inactive is a pure no-op — returns best and draws no rng', () => {
  const b = mkBattle({}, 0, 5);
  const before = JSON.stringify(b.rng.toJSON());
  const pick = cunningPick(b, { side: 1 }, OPTIONS, best);
  assert.equal(pick, best);
  assert.equal(JSON.stringify(b.rng.toJSON()), before, 'no rng consumed when inactive');
});

test('cunningPick: active — mixes among near-best, never a dominated move', () => {
  const seen = new Set();
  for (let s = 1; s <= 200; s++) {
    const b = mkBattle({ cunningAI: true }, 0, s);
    const pick = cunningPick(b, { side: 1 }, OPTIONS, best);
    seen.add(pick.action.targetId);
    assert.notEqual(pick.action.targetId, 'C', 'a dominated option must never be picked');
  }
  assert.ok(seen.has('A') && seen.has('B'), `should mix between the near-best options, saw ${[...seen]}`);
});

// ---------------------------------------------------------------------------
// Spellcasting mixes too: the hero sometimes casts a NEAR-best option, so the
// human can't perfectly predict (and pre-counter) the one spell it always cast.
// ---------------------------------------------------------------------------

/** Minimal plain-object hero that satisfies heroUtils + castSpell. */
function makeHero(opts = {}) {
  return {
    stats: { attack: 0, defense: 0, power: opts.power ?? 0, knowledge: 0 },
    skills: {}, equipment: {}, army: [],
    spells: opts.spells || [], mana: opts.mana ?? 0,
    tempMorale: 0, tempLuck: 0,
  };
}

/** An AI hero (side 0) facing two IDENTICAL champion stacks (near-equal spell
 *  targets) plus one token imp stack (a dominated target). */
function spellBattle(features, humanSide, seed) {
  return createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(seed), terrain: 'grass', features, humanSide,
    attacker: {
      // Power 30 → a 310-damage arrow: 3 champion kills, comfortably past the
      // cast floor (2% of the enemy's total value), so the hero always casts.
      hero: makeHero({ spells: ['magicArrow'], mana: 40, power: 30 }),
      army: [{ creature: 'pikeman', count: 10 }], playerIndex: 0,
    },
    defender: {
      hero: null,
      army: [
        { creature: 'champion', count: 20 },
        { creature: 'champion', count: 20 },
        { creature: 'imp', count: 1 },
      ],
      playerIndex: 1,
    },
  });
}

const castTarget = (b) => maybeCastAISpell(b, 0).find((e) => e.type === 'spellHit')?.targetId;

test('cunning spellcasting: mixes among near-equal targets, never a dominated one', () => {
  const seen = new Set();
  for (let s = 1; s <= 120; s++) {
    const t = castTarget(spellBattle({ cunningAI: true }, 1, s));
    assert.ok(t === 'u1_0' || t === 'u1_1', `only the near-best champion stacks (got ${t})`);
    seen.add(t);
  }
  assert.ok(seen.has('u1_0') && seen.has('u1_1'),
    `should mix between the equal champion stacks, saw ${[...seen]}`);
});

test('cunning spellcasting: strict argmax when the feature is off or no human is at the table', () => {
  for (let s = 1; s <= 60; s++) {
    assert.equal(castTarget(spellBattle({}, 1, s)), 'u1_0', 'feature off → always the argmax');
    assert.equal(castTarget(spellBattle({ cunningAI: true }, -1, s)), 'u1_0', 'no human → always the argmax');
  }
});

test('cunning spellcasting: inactive is byte-identical — same events, same rng stream', () => {
  const run = (features) => {
    const b = spellBattle(features, -1, 99);
    const events = maybeCastAISpell(b, 0);
    return JSON.stringify({ events, rng: b.rng.toJSON() });
  };
  assert.equal(run({ cunningAI: true }), run({}),
    'cunningAI without a human must not shift the cast or the rng stream');
});

test('auto-resolve is byte-identical with cunningAI on vs off (no human at the table)', () => {
  const fight = (features) => {
    const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
      rng: new Rng(42), terrain: 'grass', features, // humanSide defaults to -1
      attacker: { hero: null, army: [{ creature: 'pikeman', count: 30 }], playerIndex: 0 },
      defender: { hero: null, army: [{ creature: 'archer', count: 12 }], playerIndex: 1 },
    });
    autoResolve(battle);
    return { winner: battle.winner, hpLost: battle.hpLost.join(',') };
  };
  assert.deepEqual(fight({ cunningAI: true }), fight({}), 'cunning must not touch AI-vs-AI resolution');
});
