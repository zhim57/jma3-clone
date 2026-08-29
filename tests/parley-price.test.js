/**
 * parley-price.test.js — a parley buys an army; it must cost like one.
 *
 * Playtest report: "most creatures joined for $1, so most of the reward was the
 * cheap creatures; i converted a lot to marksmen" — flagged under the
 * trivially-cheat heading, and it scored risk-vs-reward 20 out of 100.
 *
 * The cause was the price formula pricing ONLY the avoided battle:
 *
 *     price = max(1, predictedFightLoss * PARLEY_PRICE_MULT)
 *
 * A developed hero loses nothing beating a wild stack, so predictedFightLoss is 0
 * and the price floors at the literal 1. Measured against a 139,872-value hero:
 *
 *     swordsman x20   recruit cost 6000   price 1   =  0.01% of value
 *     orc x25         recruit cost 3750   price 1   =  0.02%
 *     gnoll x30       recruit cost 1500   price 1   =  0.06%
 *
 * i.e. every stack on the map, free — then laundered through the Altar into
 * marksmen. The Coasean teaching survives; the goods now set the floor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { parleyOffer, stackRecruitCost, predictedFightLoss } from '../src/core/diplomacy.js';

const mkState = () => newGame({
  seed: 376709956,
  players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  mapW: 44, mapH: 36, features: { diplomacy: true },
});
const mon = (creature, count) => ({ type: 'monster', id: 'M1', creature, count, x: 5, y: 5 });
/** A hero strong enough that every wild stack is a walkover — the exploit case. */
function bigHero(state) {
  const h = playerHeroes(state, 0)[0];
  // A real army is SEVEN slots — the shape createHero produces and the shape
  // addToArmy iterates. A three-element literal is a hero with no room at all,
  // which now (correctly) means no join offer can be made to it.
  h.army = [
    { creature: 'archangel', count: 12 }, { creature: 'crusader', count: 40 },
    { creature: 'marksman', count: 60 }, null, null, null, null,
  ];
  return h;
}

test('stackRecruitCost prices a stack at what a dwelling would charge', () => {
  assert.equal(stackRecruitCost(mon('swordsman', 20)), CREATURES.swordsman.cost.gold * 20);
  assert.equal(stackRecruitCost(mon('pixie', 0)), 0);
  assert.equal(stackRecruitCost({ creature: 'nonesuch', count: 5 }), 0, 'unknown creature is not a crash');
});

test('a creature with NO purchase price still is not free', () => {
  // A battle remnant (no cost, never bought) must fall back to its power value,
  // or it would reopen the same hole from a different direction.
  const ghost = Object.entries(CREATURES).find(([, c]) => !c.cost?.gold && c.aiValue > 0);
  if (!ghost) return;
  assert.ok(stackRecruitCost(mon(ghost[0], 4)) > 0, `${ghost[0]} priced at zero`);
});

test('THE EXPLOIT: a walkover stack no longer costs one gold', () => {
  const s = mkState();
  const hero = bigHero(s);
  for (const [creature, count] of [['pixie', 9], ['gnoll', 30], ['orc', 25], ['griffin', 14], ['swordsman', 20]]) {
    const m = mon(creature, count);
    const offer = parleyOffer(s, hero, m);
    if (!offer || !offer.offered) continue;   // `refused` is not a key parleyOffer returns
    assert.equal(predictedFightLoss(s, hero, m), 0, `${creature} should be a walkover for this hero`);
    const recruit = stackRecruitCost(m);
    assert.ok(offer.price > 1, `${creature} x${count} still costs ${offer.price} gold`);
    const share = offer.price / recruit;
    assert.ok(share >= CONFIG.PARLEY_COST_SHARE - 0.02 && share <= CONFIG.PARLEY_COST_SHARE + 0.02,
      `${creature} x${count}: paid ${offer.price} for ${recruit} of goods (${(share * 100).toFixed(0)}%)`);
  }
});

test('the discount is real but bounded — never free, never a rip-off', () => {
  assert.ok(CONFIG.PARLEY_COST_SHARE > 0.4, 'too cheap and the map is still a free army');
  assert.ok(CONFIG.PARLEY_COST_SHARE <= 1, 'paying MORE than recruiting makes parley pointless');
});

test('a costly fight still dominates the price — the Coasean point survives', () => {
  // When the battle would genuinely hurt, the avoided-loss term must lead, so the
  // lesson (a side-payment beats deadweight loss) still lands.
  const s = mkState();
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'pikeman', count: 12 }]; // weak: a real fight
  // WITHIN THE BARGAINING BAND. Ten Griffins against twelve Pikemen is 2.5x the
  // hero's army — past PARLEY_MAX_RATIO, so no offer is ever made and the test
  // was asserting against `{ offered: false }`. It passed only because the guard
  // below named `refused`, a key parleyOffer does not return, and the arithmetic
  // it guards happened to come out false. Both were wrong; a re-pricing made the
  // arithmetic come out true and showed it.
  const m = mon('griffin', 2);
  const loss = predictedFightLoss(s, hero, m);
  const offer = parleyOffer(s, hero, m);
  if (!offer || !offer.offered) return; // refusal is a legitimate outcome
  if (loss * CONFIG.PARLEY_PRICE_MULT > stackRecruitCost(m) * CONFIG.PARLEY_COST_SHARE) {
    assert.ok(offer.price > stackRecruitCost(m) * CONFIG.PARLEY_COST_SHARE,
      'a bloody fight should price above the bare cost of the goods');
  }
});

test('diplomacy stays opt-in — no offer at all with the feature off', () => {
  const s = newGame({
    seed: 376709956,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    mapW: 44, mapH: 36, features: {},
  });
  const offer = parleyOffer(s, bigHero(s), mon('orc', 25));
  assert.equal(offer.offered, false, 'parley must not be offered when the feature is off');
});
