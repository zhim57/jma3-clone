/**
 * ai-stance.test.js — AI Battle Formations: the AI picks its stance by the odds.
 *
 * The game's Battle Formations teach that variance helps the underdog and hurts
 * the favorite. chooseAIStances applies that teaching to the AI itself: one
 * baseline odds estimate (an army-value ratio for routs, a fixed-seed Monte-Carlo
 * when contested) mapped through stanceForOdds — all-in at or below the underdog
 * threshold, hold at or above the favorite one, classic press between. The human
 * side is never assigned a stance (its picker owns that), no live rng is drawn,
 * and with the aiBattleFormations Setting off nothing is set at all — callers
 * simply skip the helper, so classic battles stay byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { stanceForOdds, chooseAIStances, estimateStanceWinProb } from '../src/core/combat/CombatAI.js';

const cfg = (na, nd, extra = {}) => ({
  terrain: 'grass',
  // Both sides heroless, so both would now split by rule (CONFIG.PVE_STACK_SPLIT).
  // These tests are about STANCE — how variance-seeking a side is at given odds —
  // and they state their premises in exact head counts ("10-v-13 pikemen"). A split
  // turns each side into three smaller stacks and prices a different fight.
  pveStackSplit: false,
  attacker: { hero: null, army: [{ creature: 'pikeman', count: na }], playerIndex: 0 },
  defender: { hero: null, army: [{ creature: 'pikeman', count: nd }], playerIndex: 1 },
  ...extra,
});

test('stanceForOdds: underdog seeks variance, favorite kills it, contested keeps press', () => {
  assert.equal(stanceForOdds(0), 'allin');
  assert.equal(stanceForOdds(CONFIG.AI_STANCE_UNDERDOG), 'allin', 'threshold inclusive');
  assert.equal(stanceForOdds(0.5), 'press');
  assert.equal(stanceForOdds(CONFIG.AI_STANCE_FAVORITE), 'hold', 'threshold inclusive');
  assert.equal(stanceForOdds(1), 'hold');
  assert.equal(stanceForOdds(null), 'press', 'no estimate → classic press');
  assert.equal(stanceForOdds(NaN), 'press');
});

test('chooseAIStances: a rout is read off the value ratio — favorite holds, underdog goes all-in', () => {
  // 60 vs 3 pikemen is beyond AI_STANCE_SKIP_RATIO — no Monte-Carlo needed.
  assert.deepEqual(chooseAIStances(cfg(60, 3)), { attacker: 'hold', defender: 'allin' });
  assert.deepEqual(chooseAIStances(cfg(3, 60)), { attacker: 'allin', defender: 'hold' });
});

test('chooseAIStances: a contested fight is Monte-Carloed and mapped the same way', () => {
  // 10 vs 13 pikemen (ratio 1.3, inside the MC band): the attacker almost never
  // wins (see battle-formations.test.js) → all-in; the defender is a clear
  // favorite → hold. Deterministic — the MC runs on fixed seeds.
  assert.deepEqual(chooseAIStances(cfg(10, 13)), { attacker: 'allin', defender: 'hold' });
  const again = chooseAIStances(cfg(10, 13));
  assert.deepEqual(again, { attacker: 'allin', defender: 'hold' }, 'same cfg → same stances');
});

test('chooseAIStances: the human side is never assigned a stance', () => {
  const st = chooseAIStances(cfg(10, 13, { humanSide: 0 }));
  assert.equal(st.attacker, null, "the human's own picker owns that choice");
  assert.equal(st.defender, 'hold');
  const st2 = chooseAIStances(cfg(10, 13, { humanSide: 1 }));
  assert.equal(st2.attacker, 'allin');
  assert.equal(st2.defender, null);
});

test('chooseAIStances: an empty army yields no stances (nothing to estimate)', () => {
  assert.deepEqual(chooseAIStances(cfg(10, 0)), { attacker: null, defender: null });
  assert.deepEqual(chooseAIStances({ attacker: {}, defender: {} }), { attacker: null, defender: null });
});

test('chooseAIStances: winBias shades a contested favorite toward variance, never a rout', () => {
  // 13 vs 10 (MC band): the attacker is a clear favorite → hold. An AI that has
  // learned the human beats its simulations (winBias < 1) stops trusting those
  // odds: at 0.5 the same fight reads contested (press), at 0.3 it reaches for
  // variance (all-in).
  assert.equal(chooseAIStances(cfg(13, 10)).attacker, 'hold');
  assert.equal(chooseAIStances(cfg(13, 10), { winBias: 0.5 }).attacker, 'press');
  assert.equal(chooseAIStances(cfg(13, 10), { winBias: 0.3 }).attacker, 'allin');
  // A 20× rout is beyond doubt — no amount of respect for the human shades it.
  assert.deepEqual(chooseAIStances(cfg(60, 3), { winBias: 0.3 }),
    { attacker: 'hold', defender: 'allin' });
});

test('chooseAIStances: draws nothing from any live rng (fixed-seed MC only)', () => {
  const live = new Rng(777);
  const before = JSON.stringify(live.toJSON());
  chooseAIStances(cfg(10, 13)); // contested → runs the Monte-Carlo
  assert.equal(JSON.stringify(live.toJSON()), before, 'a live rng is never consulted');
});

test('createBattle: a cfg stance lands on the side; absent → classic press', () => {
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(5), terrain: 'grass',
    attacker: { hero: null, army: [{ creature: 'pikeman', count: 5 }], stance: 'allin', playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 5 }], playerIndex: 1 },
  });
  assert.equal(battle.sides[0].stance, 'allin');
  assert.equal(battle.sides[1].stance, 'press', 'no stance in cfg → press, byte-identical classic');
});

test('estimateStanceWinProb: honors a cfg-frozen stance on the OTHER side', () => {
  // The human's win-% preview must price the stance the AI will actually fight
  // under. 10-v-13 pikemen: against a defender locked to zero-variance 'hold'
  // the attacker's only path to victory (lucky swings) is gone.
  const vsHold = cfg(10, 13); vsHold.defender.stance = 'hold';
  const pHold = estimateStanceWinProb(vsHold, 0, 'press', 200, 3);
  const pPress = estimateStanceWinProb(cfg(10, 13), 0, 'press', 200, 3);
  assert.ok(pHold < pPress,
    `a hold defender blanks the underdog (${pHold} < ${pPress})`);
});
