/**
 * ai-siege-value.test.js — the fort-aware siege gate (2026-07 repo review, G62).
 *
 * townDefenseValue is the AI's siege gate: it besieges a town only when its army
 * value clears it (courage-scaled). It used to be the bare garrison + visitor
 * army value, blind to the FORT and the defending HERO, so late-game the AI
 * charged walled, hero-held towns and died. It now folds in the fort tier and
 * the defending hero's attack/defense, both calibrated by autoResolving sieges.
 *
 * Part 1 pins the shape (a fort and a hero each raise the figure). Part 2 is the
 * autoResolve win-rate check the review asks for: townDefenseValue lands right at
 * the winnable/unwinnable boundary of a real siege — a besieger comfortably below
 * it is turned away, one comfortably above it takes the town.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { armyValue } from '../src/core/heroUtils.js';
import { CREATURES } from '../src/data/creatures.js';
import { Rng } from '../src/core/rng.js';

const twoPlayers = [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
];
const GARRISON = () => [
  { creature: 'pikeman', count: 30 }, { creature: 'archer', count: 18 },
  { creature: 'swordsman', count: 14 }, { creature: 'griffin', count: 8 },
];

test('G62: a fort and a defending hero both raise townDefenseValue', () => {
  const state = newGame({ seed: 33, players: twoPlayers });
  const ai = new AITurnController(state, 1);
  const bare = { garrison: GARRISON(), buildings: [], visitingHeroId: null };
  const walled = { garrison: GARRISON(), buildings: ['fort', 'citadel', 'castle'], visitingHeroId: null };
  assert.ok(ai.townDefenseValue(walled) > ai.townDefenseValue(bare),
    'a Castle town defends harder than an open one with the same garrison');

  state.heroes.HDEF = { id: 'HDEF', army: [], stats: { attack: 9, defense: 9, power: 0, knowledge: 0 }, skills: {}, equipment: {} };
  const held = { garrison: GARRISON(), buildings: ['fort', 'citadel', 'castle'], visitingHeroId: 'HDEF' };
  assert.ok(ai.townDefenseValue(held) > ai.townDefenseValue(walled),
    'a hero on the walls stiffens the defense further');
});

test('G62: townDefenseValue marks the winnable/unwinnable boundary of a real siege', () => {
  const state = newGame({ seed: 34, players: twoPlayers });
  const ai = new AITurnController(state, 1);
  const town = { garrison: GARRISON(), buildings: ['fort', 'citadel', 'castle'], visitingHeroId: null }; // Castle
  const tdv = ai.townDefenseValue(town);
  const garrisonValue = armyValue(GARRISON());

  // Attacker army = the garrison composition scaled so its value is `ratio × tdv`.
  const attackerArmy = (ratioOfTdv) => {
    const scale = (ratioOfTdv * tdv) / garrisonValue;
    return GARRISON().map((s) => ({ creature: s.creature, count: Math.max(1, Math.round(s.count * scale)) }));
  };
  const siegeWinRate = (ratioOfTdv, seeds) => {
    let wins = 0;
    for (let s = 0; s < seeds; s++) {
      const battle = createBattle({
        rng: new Rng(500 + s * 17),
        attacker: { army: attackerArmy(ratioOfTdv), playerIndex: 0 },
        defender: { army: GARRISON(), playerIndex: 1 },
        siege: { fortTier: 3 },      // Castle
        defenseBonus: 4,             // [0,2,3,4][3]
      });
      if (autoResolve(battle).attackerWon) wins++;
    }
    return wins / seeds;
  };

  // The win-rate curve is a sharp step around the gate: a besieger well BELOW
  // townDefenseValue is turned away, one well ABOVE it storms the town. That the
  // step sits at townDefenseValue (not far above or below) is the calibration.
  const below = siegeWinRate(0.7, 50);
  const above = siegeWinRate(1.3, 50);
  assert.ok(below < 0.35, `a besieger at 0.7× townDefenseValue mostly fails (got ${below.toFixed(2)})`);
  assert.ok(above > 0.65, `a besieger at 1.3× townDefenseValue mostly wins (got ${above.toFixed(2)})`);
  assert.ok(above - below > 0.4, 'townDefenseValue cleanly separates winnable from hopeless sieges');
});

// A sanity peg that the aiValue-weighted composition is non-degenerate.
test('G62: the test garrison has a real, positive army value', () => {
  assert.ok(GARRISON().every((s) => CREATURES[s.creature]), 'all creatures exist');
  assert.ok(armyValue(GARRISON()) > 1000, 'the garrison is a meaningful force');
});
