/**
 * ai-spell-estimate.test.js — the AI combat-spell estimator honours magic-school
 * mastery, matching the engine (2026-07 repo review, backlog item A5).
 *
 * The estimator computed damage as round(amount * sorcery) and healing with
 * sorcery too — but the ENGINE multiplies both by the spell's magic-school bonus
 * (Air/Earth/Fire/Water Magic → up to +35%) and applies sorcery to damage ONLY.
 * So the AI under-priced its own school-boosted nukes by up to 35% and skipped
 * casts that would actually win. These tests pin the fix through spell SELECTION:
 * a lower-base bolt on the hero's mastered school must now out-score a
 * higher-base bolt on an unmastered one — exactly as the engine would deal them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle } from '../src/core/combat/CombatEngine.js';
import { maybeCastAISpell } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

function heroWith(skills) {
  return {
    stats: { attack: 0, defense: 0, power: 5, knowledge: 10 },
    skills, equipment: {}, army: [],
    spells: ['iceBolt', 'lightningBolt'], // iceBolt=water, lightningBolt=air
    mana: 50, tempMorale: 0, tempLuck: 0,
  };
}

function makeBattle(skills) {
  return createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng: new Rng(3),
    attacker: { hero: heroWith(skills), army: [{ creature: 'pikeman', count: 10 }], playerIndex: 0 },
    // 500 one-HP peasants: a deep pool so neither bolt caps and each point of
    // damage maps to one kill — the 149-vs-135 damage gap becomes a value gap.
    defender: { hero: null, army: [{ creature: 'peasant', count: 500 }], playerIndex: 1 },
  });
}

const castChoice = (b) => maybeCastAISpell(b, 0).find((e) => e.type === 'spellHit')?.spellId;

test('with no school mastery the higher-base bolt (Lightning) wins (A5)', () => {
  // power 5: Lightning = 10 + 25·5 = 135; Ice Bolt = 10 + 20·5 = 110.
  assert.equal(castChoice(makeBattle({})), 'lightningBolt');
});

test('Expert Water mastery correctly lifts Ice Bolt above Lightning (A5)', () => {
  // +35% Water makes Ice Bolt land 149 (110·1.35) vs Lightning's still-135 — the
  // engine deals exactly that, so the mastered bolt is genuinely the harder hit.
  // The old estimator omitted the school bonus and kept picking Lightning.
  assert.equal(castChoice(makeBattle({ waterMagic: 3 })), 'iceBolt');
});
