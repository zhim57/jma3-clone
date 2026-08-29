/**
 * battle-formations.test.js — #10 (opt-in): EV-neutral pre-battle stances.
 *
 * The three stances share the same MEAN damage and differ only in variance:
 *   hold  = fixed mean (zero variance, no luck/morale swing)
 *   press = classic uniform roll
 *   allin = bimodal min/max + amplified swing
 * Plus the Monte-Carlo win-probability estimator that powers the picker, and the
 * teaching claim it exists to make legible: variance helps an underdog.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/core/rng.js';
import { CONFIG } from '../src/config.js';
import { stanceBaseRoll, stanceSwing, normStance } from '../src/core/combat/CombatEngine.js';
import { estimateStanceWinProb } from '../src/core/combat/CombatAI.js';
import { newGame } from '../src/core/GameState.js';

function stats(samples) {
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, variance };
}

test('normStance / stanceSwing: press is the neutral default', () => {
  assert.equal(normStance('press'), 'press');
  assert.equal(normStance('garbage'), 'press');
  assert.equal(normStance(undefined), 'press');
  assert.equal(stanceSwing('press'), 1);
  assert.equal(stanceSwing('hold'), 0);
  assert.equal(stanceSwing('allin'), CONFIG.BF_ALLIN_SWING);
});

test('stanceBaseRoll: all three stances share the same mean (EV-neutral)', () => {
  const dmin = 2, dmax = 8, mid = (dmin + dmax) / 2; // 5
  const rng = new Rng(12345);
  const N = 20000;
  const hold = [], press = [], allin = [];
  for (let i = 0; i < N; i++) hold.push(stanceBaseRoll(rng, dmin, dmax, 'hold'));
  for (let i = 0; i < N; i++) press.push(stanceBaseRoll(rng, dmin, dmax, 'press'));
  for (let i = 0; i < N; i++) allin.push(stanceBaseRoll(rng, dmin, dmax, 'allin'));

  const h = stats(hold), p = stats(press), a = stats(allin);
  assert.equal(h.mean, mid, 'hold is exactly the mean');
  assert.ok(Math.abs(p.mean - mid) < 0.1, `press mean ${p.mean} ~ ${mid}`);
  assert.ok(Math.abs(a.mean - mid) < 0.1, `allin mean ${a.mean} ~ ${mid}`);
});

test('stanceBaseRoll: variance strictly increases hold < press < allin', () => {
  const dmin = 2, dmax = 8;
  const rng = new Rng(999);
  const N = 20000;
  const draw = (s) => { const out = []; for (let i = 0; i < N; i++) out.push(stanceBaseRoll(rng, dmin, dmax, s)); return stats(out).variance; };
  const vHold = draw('hold'), vPress = draw('press'), vAllin = draw('allin');
  assert.equal(vHold, 0, 'hold has zero variance');
  assert.ok(vPress > vHold, 'press > hold');
  assert.ok(vAllin > vPress, `allin (${vAllin.toFixed(2)}) > press (${vPress.toFixed(2)})`);
});

test('estimateStanceWinProb: returns valid probabilities and a favorite wins under any stance', () => {
  // A crushing human favourite (side 0): many pikemen vs a token defender.
  const cfg = {
    terrain: 'grass',
    attacker: { hero: null, army: [{ creature: 'pikeman', count: 60 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 3 }], playerIndex: 1 },
  };
  for (const stance of ['hold', 'press', 'allin']) {
    const p = estimateStanceWinProb(cfg, 0, stance, 24, 7);
    assert.ok(p >= 0 && p <= 1, 'a probability');
    assert.ok(p > 0.9, `favourite wins ~always under ${stance} (got ${p})`);
  }
  assert.equal(estimateStanceWinProb(cfg, -1, 'press', 4), null, 'no human side → null');
});

test('estimateStanceWinProb: the win-% preview NEVER spends the real hero\'s mana', () => {
  // Regression: the picker's Monte-Carlo used to auto-resolve on the LIVE hero by
  // reference — every simulated cast decremented real mana, draining a spellcaster
  // to 0 just by opening the pre-battle stance/tactics screen. The sim must fight
  // a clone (createBattle `simulated: true`); the source hero is left untouched.
  const s = newGame({ seed: 7, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const hero = Object.values(s.heroes).find((h) => h.owner === 0);
  const foe = Object.values(s.heroes).find((h) => h.owner === 1);
  hero.mana = 430;
  for (const id of ['lightningBolt', 'magicArrow']) if (!hero.spells.includes(id)) hero.spells.push(id);
  hero.army = [{ creature: 'pikeman', count: 80 }, null, null, null, null, null, null];
  const cfg = {
    terrain: 'grass',
    attacker: { hero, army: hero.army.filter(Boolean), playerIndex: 0 },
    defender: { hero: foe, army: [{ creature: 'imp', count: 60 }], playerIndex: 1 },
    features: { battleFormations: true },
    humanSide: 0,
  };
  for (const stance of ['hold', 'press', 'allin']) estimateStanceWinProb(cfg, 0, stance, 24, 1);
  assert.equal(hero.mana, 430, 'the live hero kept every point of mana through the preview');
});

test('estimateStanceWinProb: variance helps the underdog (all-in ≥ hold)', () => {
  // A near-even fight the human (side 0) slightly trails, where variance should
  // help: all-in must not do WORSE than the zero-variance hold.
  const cfg = {
    terrain: 'grass',
    attacker: { hero: null, army: [{ creature: 'pikeman', count: 10 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 13 }], playerIndex: 1 },
  };
  const hold = estimateStanceWinProb(cfg, 0, 'hold', 80, 3);
  const allin = estimateStanceWinProb(cfg, 0, 'allin', 80, 3);
  assert.ok(allin >= hold, `all-in (${allin}) should not trail hold (${hold}) for an underdog`);
});
