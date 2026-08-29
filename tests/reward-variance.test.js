/**
 * reward-variance.test.js — a treasure find must sometimes be memorable.
 *
 * Playtest report on chests and Pandora boxes: "need higher amplitudes, so
 * sometime we get 15k 20k others 4k-5k".
 *
 * Measured before: chest gold was rng.pick([1000, 1500, 2000]) — a 2x spread with
 * no tail, so every chest on the map paid about the same and none was worth
 * remembering. A Pandora box paid 3000-6000 gold every single time, and 2000/3500/
 * 5000 xp, which made a box a known quantity before you opened it.
 *
 * Both now carry a long tail: mostly pocket change, rarely a hoard. Measured after,
 * over 20,000 chest rolls: p50 966, p90 3086, p99 18309, max ~20k, 4.3% at or above
 * 12k, mean 1902 against the old flat 1500. The FELT range goes from 2x to 40x for
 * about a quarter more chest income.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { rollWeightedGold } from '../src/core/actions.js';
import { rollPandoraReward } from '../src/data/pandora.js';

const sample = (fn, n = 20000) => {
  const rng = new Rng(7);
  return Array.from({ length: n }, () => fn(rng));
};
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.floor(s.length * p)];
  return { min: s[0], p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1],
    mean: xs.reduce((a, b) => a + b, 0) / xs.length };
};

test('the chest tier table is well formed', () => {
  const t = CONFIG.CHEST_GOLD_TIERS;
  assert.ok(Array.isArray(t) && t.length >= 2, 'a single tier is the old flat pick');
  for (const tier of t) {
    assert.ok(tier.weight > 0, 'a zero-weight tier is dead content');
    assert.ok(tier.min > 0 && tier.max >= tier.min, `bad band ${tier.min}-${tier.max}`);
  }
  // Ordered by value, so the table reads as everyday / good / hoard.
  for (let i = 1; i < t.length; i++) assert.ok(t[i].min > t[i - 1].min, 'tiers ascend');
  // The rare tier must actually be rare, and must actually be big.
  const last = t[t.length - 1], first = t[0];
  assert.ok(last.weight < first.weight / 4, 'the hoard tier must be rare');
  assert.ok(last.min >= first.max * 6, 'the hoard must dwarf the everyday find');
});

test('chest gold has a long tail, not a flat band', () => {
  const s = stats(sample((rng) => rollWeightedGold(rng, CONFIG.CHEST_GOLD_TIERS)));
  assert.ok(s.p50 <= 2000, `p50 ${s.p50}: most finds should be modest`);
  assert.ok(s.p99 >= 10000, `p99 ${s.p99}: the tail must reach a real hoard`);
  assert.ok(s.max / s.min >= 15, `range ${s.min}-${s.max} is only ${(s.max / s.min).toFixed(1)}x`);
  // And the mean must not run away — variance was the ask, not inflation.
  assert.ok(s.mean < 3000, `mean ${s.mean.toFixed(0)} inflates chest income too far`);
});

test('rollWeightedGold respects the weights and stays in band', () => {
  const tiers = [{ weight: 90, min: 10, max: 20 }, { weight: 10, min: 1000, max: 2000 }];
  const xs = sample((rng) => rollWeightedGold(rng, tiers), 8000);
  const rare = xs.filter((v) => v >= 1000).length / xs.length;
  assert.ok(rare > 0.06 && rare < 0.15, `rare tier hit ${(rare * 100).toFixed(1)}%, expected ~10%`);
  for (const v of xs) {
    assert.ok((v >= 10 && v <= 20) || (v >= 1000 && v <= 2000), `${v} outside every band`);
  }
  // A single-tier table must still work (no off-by-one falling through).
  assert.equal(rollWeightedGold(new Rng(1), [{ weight: 1, min: 5, max: 5 }]), 5);
});

test('a Pandora box is no longer a known quantity', () => {
  const rng = new Rng(11);
  const golds = [], xps = [];
  for (let i = 0; i < 40000; i++) {
    const r = rollPandoraReward(rng);
    if (r.kind === 'resource' && r.resource === 'gold') golds.push(r.amount);
    if (r.kind === 'xp') xps.push(r.amount);
  }
  assert.ok(golds.length > 100 && xps.length > 100, 'both reward kinds occur');
  const g = stats(golds), x = stats(xps);
  assert.ok(g.max >= 15000, `gold max ${g.max}: a box should sometimes be a hoard`);
  assert.ok(g.p50 <= 6000, `gold p50 ${g.p50}: most boxes stay modest`);
  // The XP claims are stated as SHAPE, not as absolute numbers. They used to read
  // `max >= 12000` and `p50 <= 6000`, which silently encoded the hit-point
  // currency combat XP used before 2026-08; when experience moved to creature
  // value and the box band scaled with it, this test failed while the property it
  // exists to protect — mostly modest, occasionally a jackpot — was untouched.
  // Ratios survive a change of currency; thresholds do not.
  assert.ok(x.max >= x.p50 * 3, `xp max ${x.max} vs p50 ${x.p50}: the tail should be a real jackpot`);
  assert.ok(x.p50 <= x.max * 0.25, `xp p50 ${x.p50} of max ${x.max}: most boxes stay modest`);
  // …and an absolute floor that moves WITH the currency, so a box can never
  // quietly decay into being worth less than a roadside Learning Stone.
  assert.ok(x.p50 >= CONFIG.LEARNING_STONE_XP,
    `xp p50 ${x.p50} is below a Learning Stone (${CONFIG.LEARNING_STONE_XP})`);
});

test('rewards stay deterministic per seed', () => {
  const a = sample((rng) => rollWeightedGold(rng, CONFIG.CHEST_GOLD_TIERS), 200);
  const b = sample((rng) => rollWeightedGold(rng, CONFIG.CHEST_GOLD_TIERS), 200);
  assert.deepEqual(a, b, 'same seed must replay the same finds');
});
