/**
 * xp-resurrection.test.js — the winner's XP is the enemy's STARTING army VALUE,
 * invariant to how much the enemy resurrected mid-fight (2026-07 repo review,
 * backlog item A9 — assessed as a NON-bug and pinned here).
 *
 * The review suggested tracking "actual deltas" for XP, on the theory that the
 * casualty tally drifts in resurrection-heavy fights. It does not: every kill
 * credits the creature and every revive refunds it, so at a decisive win
 * valueLost[loser] nets out to exactly the loser's starting army value — the
 * HoMM3 model (you earn the full worth of the army you defeated, regardless of
 * its healing). A delta model would instead award MORE XP for fighting a
 * healer, which is wrong. This test locks the correct invariant so it cannot be
 * "fixed" into a regression.
 *
 * The UNIT changed in 2026-08 (HP -> aiValue, see docs/GAME_RULES.md); the
 * invariant this file exists to protect did not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';

import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { CREATURES } from '../src/data/creatures.js';
import { Rng } from '../src/core/rng.js';

function makeHero(spells) {
  return {
    stats: { attack: 0, defense: 0, power: 5, knowledge: 10 },
    skills: {}, equipment: {}, army: [], spells, mana: 50, tempMorale: 0, tempLuck: 0,
  };
}

function fight(defenderSpells) {
  const b = createBattle({
    rng: new Rng(3),
    attacker: { hero: makeHero([]), army: [{ creature: 'archangel', count: 20 }], playerIndex: 0 },
    defender: { hero: makeHero(defenderSpells), army: [{ creature: 'pikeman', count: 10 }], playerIndex: 1 },
  });
  return autoResolve(b);
}

test('winner XP equals the enemy starting army HP, with or without resurrection (A9)', () => {
  const startValue = 10 * CREATURES.pikeman.aiValue; // the defender's full starting army value

  const noRevive = fight([]);
  const withRevive = fight(['resurrection']); // the defender AI raises its own fallen pikemen

  assert.equal(noRevive.attackerWon, true);
  assert.equal(withRevive.attackerWon, true);
  // baseXp is the raw award; `xp` additionally carries the flawless premium when
  // the winner lost nothing, so the no-drift invariant is asserted on the base.
  assert.equal(noRevive.baseXp, startValue, 'XP is the full starting enemy army value');
  assert.equal(withRevive.baseXp, startValue, 'and it does NOT drift when the enemy resurrects mid-fight');
  for (const r of [noRevive, withRevive]) {
    const expected = r.flawless ? Math.round(r.baseXp * (1 + CONFIG.FLAWLESS_XP_BONUS)) : r.baseXp;
    assert.equal(r.xp, expected, 'awarded xp = base (+10% only when flawless)');
  }
});
