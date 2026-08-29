/**
 * sunk-cost-siege.test.js — #14 (opt-in): the AI over-commits where it bled.
 *
 * decayedSiegeLoss remembers (and fades) the army value the AI threw away in a
 * failed assault; recording happens through applyCombatResult on a lost town
 * assault (only when ON, only for an AI attacker); and siegeMargin turns that
 * memory into a lower — but bounded, never-below-floor — attack threshold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { applyCombatResult, decayedSiegeLoss } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1;

test('decayedSiegeLoss: fades linearly to zero over the decay window', () => {
  const town = { aiSiegeLosses: { 1: { value: 1400, day: 10 } } };
  assert.equal(decayedSiegeLoss(town, 1, 10), 1400, 'fresh: full value');
  assert.equal(decayedSiegeLoss(town, 1, 10 + CONFIG.SUNK_COST_DECAY_DAYS / 2), 700, 'half-life: half value');
  assert.equal(decayedSiegeLoss(town, 1, 10 + CONFIG.SUNK_COST_DECAY_DAYS), 0, 'expired');
  assert.equal(decayedSiegeLoss(town, 0, 10), 0, 'a different player has no memory here');
  assert.equal(decayedSiegeLoss({}, 1, 10), 0, 'no memory at all');
});

test('siegeMargin: unchanged without a loss; cut but floored with one', () => {
  const ai = new AITurnController({ day: 5, players: [{}, {}] }, AI);
  const clean = { };
  assert.equal(ai.siegeMargin(clean, 1.3, 5000), 1.3, 'no memory → base margin');

  const bled = { aiSiegeLosses: { [AI]: { value: 4000, day: 5 } } };
  const m = ai.siegeMargin(bled, 1.3, 8000);
  assert.ok(m < 1.3, 'a remembered loss lowers the demanded margin');
  assert.ok(m >= CONFIG.SUNK_COST_FLOOR, 'never below the floor');

  // A huge loss vs a small army is clamped to the floor, not negative.
  const gutted = { aiSiegeLosses: { [AI]: { value: CONFIG.SUNK_COST_CAP, day: 5 } } };
  assert.equal(ai.siegeMargin(gutted, 1.3, 100), CONFIG.SUNK_COST_FLOOR);
});

test('recording: a lost AI assault on a town is remembered (ON) / ignored (OFF)', () => {
  const run = (features) => {
    const s = newGame({ seed: 4242, features });
    const town = playerTowns(s, 0)[0]; // the human's town
    const hero = playerHeroes(s, AI)[0]; // the AI attacker
    hero.army = [{ creature: 'pikeman', count: 50, hurt: 0 }]; // committed ~4000
    const ctx = { attackerHeroId: hero.id, defenderHeroId: null, defender: { kind: 'town', townId: town.id }, defenderArmy: [] };
    const result = { attackerWon: false, attackerArmy: [], defenderArmy: [], xp: 0 };
    applyCombatResult(s, ctx, result);
    return town;
  };
  const on = run({ sunkCostSiege: true });
  assert.ok(on.aiSiegeLosses && on.aiSiegeLosses[AI] && on.aiSiegeLosses[AI].value > 0, 'recorded when ON');

  const off = run({});
  assert.ok(!off.aiSiegeLosses, 'nothing recorded when OFF');
});
