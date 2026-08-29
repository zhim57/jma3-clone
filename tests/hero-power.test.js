/**
 * hero-power.test.js — the hero-strength estimate that folds a commander's
 * attack/defense + spell-power×mana into an army-equivalent "force", and its
 * effect on divine intervention (a spell-heavy hero isn't over-gifted).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { newGame, serialize, deserialize } from '../src/core/GameState.js';
import { heroPowerValue, effectiveForce, armyValue } from '../src/core/heroUtils.js';
import { tideDivineIntervention } from '../src/core/actions.js';

// A hero whose stats/mana we control directly (heroStat reads hero.stats).
const mkHero = (id, owner, { atk = 0, def = 0, pow = 0, mana = 0, army = [] }) => ({
  id, owner, name: `H${id}`,
  stats: { attack: atk, defense: def, power: pow, knowledge: 0 },
  mana, equipment: {}, backpack: [], army,
});

test('heroPowerValue blends combat stats and spell burst; 0 for no hero', () => {
  assert.equal(heroPowerValue(null), 0);
  const h = mkHero(1, 0, { atk: 5, def: 3, pow: 10, mana: 100 });
  const expect = (5 + 3) * CONFIG.HERO_STAT_VALUE + 10 * 100 * CONFIG.HERO_SPELL_VALUE;
  assert.equal(heroPowerValue(h), expect);
});

test('a big mana bar of nukes is worth more than an empty one', () => {
  const loaded = mkHero(1, 0, { pow: 12, mana: 200 });
  const spent = mkHero(2, 0, { pow: 12, mana: 0 });
  assert.ok(heroPowerValue(loaded) > heroPowerValue(spent), 'full mana reads as more force');
});

test('effectiveForce = armyValue + weight × hero power (weight 0 ⇒ armies only)', () => {
  const army = [{ creature: 'pikeman', count: 10 }];
  const h = mkHero(1, 0, { atk: 4, def: 4, army });
  assert.equal(effectiveForce(army, h, 0), armyValue(army), 'weight 0 ignores the hero');
  assert.equal(effectiveForce(army, h, 1), armyValue(army) + heroPowerValue(h));
});

test('divine intervention SEES a spell-heavy hero — no over-gift when weight is on', () => {
  // A modest creature, so the commander's power is meaningful next to the army.
  const CR = 'pikeman';
  const foeVal = CREATURES[CR].aiValue * 100;
  // A hero with a MODEST army but a huge commander — army alone looks lopsided,
  // but with hero power counted it's comfortably above the 0.6 threshold.
  const bigHero = () => mkHero(1, 0, { atk: 30, def: 30, pow: 30, mana: 400,
    army: [{ creature: CR, count: 40 }] });
  const ctxFor = () => ({ defenderArmy: [{ creature: CR, count: 100 }] });
  const HIT = () => ({ random: () => 0 });

  // Weight 0: hero ignored → armyValue 40% of foe → lopsided → gifted.
  const withoutHero = ctxFor();
  tideDivineIntervention({ pacing: 'tideOfWar', tideIntervention: 'normal', rng: HIT(), heroPowerWeight: 0, heroes: {}, log: [] },
    bigHero(), withoutHero, { kind: 'monster' });
  assert.ok(withoutHero.divineGift, 'ignoring the hero, the small army looks like an underdog');

  // Weight 1: hero counted → force well over 0.6 × foe → NOT lopsided → no gift.
  const h = bigHero();
  assert.ok(effectiveForce(h.army, h, 1) >= CONFIG.TIDE_INTERVENTION_THRESHOLD * foeVal, 'precondition: hero lifts it past the threshold');
  const withHero = ctxFor();
  tideDivineIntervention({ pacing: 'tideOfWar', tideIntervention: 'normal', rng: HIT(), heroPowerWeight: 1, heroes: {}, log: [] },
    h, withHero, { kind: 'monster' });
  assert.ok(!withHero.divineGift, 'counting the commander, it is no underdog — no gift');
});

test('newGame stores heroPowerWeight (default, clamp, round-trip)', () => {
  assert.equal(newGame({ seed: 1 }).heroPowerWeight, CONFIG.HERO_POWER_WEIGHT_DEFAULT, 'default');
  assert.equal(newGame({ seed: 1, heroPowerWeight: 2 }).heroPowerWeight, 2, 'set');
  assert.equal(newGame({ seed: 1, heroPowerWeight: 9 }).heroPowerWeight, CONFIG.HERO_POWER_WEIGHT_MAX, 'clamped');
  assert.equal(deserialize(serialize(newGame({ seed: 1, heroPowerWeight: 1.5 }))).heroPowerWeight, 1.5, 'round-trips');
});
