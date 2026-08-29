/**
 * diplomacy-skill.test.js — the Diplomacy secondary skill, and what a join costs.
 *
 * Reported: "when a stack joins us we need to have a better price — in HoMM3 some
 * were at a bargain and some were free. Also we need the Diplomacy hero skill that
 * would increase the chances of creatures joining, and for the heroes without the
 * skill [they] would be more rare."
 *
 * The measurement that motivated it, over six 44x36 maps (172 neutral stacks
 * each), BEFORE this change:
 *
 *   green column   offered 72.1%   joined 58.7%   price 0.805 x recruit cost
 *   grown army     offered  100%   joined 97.1%   price 0.800 x
 *   overwhelming   offered  100%   joined  100%   price 0.800 x
 *
 * i.e. a developed hero was offered terms by every stack on the map, 97-100% of
 * them signed, and every one asked the same flat price. That is not a Coasean
 * fork — it is a shop. The refusal roll was `ratio x SLOPE` alone, and a
 * developed hero's ratio against a wild stack is ~0, so it never fired.
 *
 * AFTER, same maps and heroes:
 *
 *   grown, no skill    joined 58.1%   price 0.800 x
 *   grown, Expert      joined 86.0%   price 0.418 x   (3 of 172 free)
 *
 * These tests pin the SHAPE of that — rarer without the skill, likelier and
 * cheaper with it, free only for kin — and that the one-gold hole the goods
 * floor was built to close (see parley-price.test.js) stays closed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { SKILLS, skillValue } from '../src/data/skills.js';
import { SKILL_WEIGHTS } from '../src/core/skillPolicy.js';
import { CREATURES } from '../src/data/creatures.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { parleyOffer, parley, surrenderCost } from '../src/core/actions.js';
import { stackRecruitCost, parleyMood } from '../src/core/diplomacy.js';
import { armyValue } from '../src/core/heroUtils.js';

const SEEDS = [4242, 376709956, 99001, 13371337];

function world(seed = 4242) {
  return newGame({
    seed,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    mapW: 44, mapH: 36, features: { diplomacy: true },
  });
}
/** A hero whose army is a real seven slots (addToArmy's shape) at `dip` skill. */
function heroAt(state, dip, army) {
  const h = playerHeroes(state, 0)[0];
  h.army = [...army, null, null, null, null, null, null, null].slice(0, 7);
  h.skills = dip ? { diplomacy: dip } : {};
  state.players[0].resources.gold = 1_000_000;
  return h;
}
const GROWN = [{ creature: 'swordsman', count: 40 }, { creature: 'marksman', count: 30 },
  { creature: 'griffin', count: 20 }];
const HUGE = [{ creature: 'archangel', count: 12 }, { creature: 'crusader', count: 40 },
  { creature: 'marksman', count: 60 }];
const monstersOf = (s) => Object.values(s.map.objects).filter((o) => o.type === 'monster');

/** Join rate + mean price share for one army shape at one skill level. */
function sweep(dip, army) {
  let seen = 0, offered = 0, joined = 0, free = 0, share = 0, shareN = 0;
  for (const seed of SEEDS) {
    const s = world(seed);
    const hero = heroAt(s, dip, army);
    for (const m of monstersOf(s)) {
      seen++;
      const o = parleyOffer(s, hero, m);
      if (!o.offered) continue;
      offered++;
      if (o.refused) continue;
      joined++;
      if (o.free) free++;
      const rc = stackRecruitCost(m);
      if (rc > 0) { share += o.price / rc; shareN++; }
    }
  }
  return { seen, offered, joined, free, share: shareN ? share / shareN : 0 };
}

test('the skill exists, ladders in three ranks, and the AI knows what it is worth', () => {
  assert.ok(SKILLS.diplomacy, 'no diplomacy skill');
  assert.equal(SKILLS.diplomacy.levels.length, 3);
  for (let i = 1; i < 3; i++) {
    assert.ok(SKILLS.diplomacy.levels[i] > SKILLS.diplomacy.levels[i - 1], 'ranks must climb');
  }
  assert.ok(SKILLS.diplomacy.levels[2] < 1, 'a rank must never zero the refusal outright');
  assert.ok(SKILL_WEIGHTS.diplomacy, 'unweighted, the AI values it at the 20-point default');
  assert.equal(skillValue({ skills: {} }, 'diplomacy'), 0, 'no skill, no magnitude');
  assert.equal(skillValue({ skills: { diplomacy: 3 } }, 'diplomacy'), SKILLS.diplomacy.levels[2]);
});

test('WITHOUT the skill a join is the exception, not the rule', () => {
  // The reported defect: 97-100% of the map signing on. A hero with no training
  // must be turned down often enough that parley is a fork, not a shopping trip.
  const r = sweep(0, GROWN);
  const rate = r.joined / r.offered;
  assert.ok(rate < 0.7, `an untrained hero still recruits ${(rate * 100).toFixed(1)}% of every stack offered`);
});

test('WITH the skill they join far more often — that is what it buys', () => {
  const none = sweep(0, GROWN);
  const expert = sweep(3, GROWN);
  assert.ok(expert.joined > none.joined * 1.3,
    `Expert joined ${expert.joined} vs ${none.joined} untrained — not worth a skill slot`);
  // And it must climb with the rank, not jump at Expert.
  const basic = sweep(1, GROWN);
  const adv = sweep(2, GROWN);
  assert.ok(basic.joined > none.joined && adv.joined > basic.joined && expert.joined > adv.joined,
    `join counts must climb with the rank: ${none.joined} ${basic.joined} ${adv.joined} ${expert.joined}`);
});

test('the price falls with the rank, and an untrained hero gets no discount at all', () => {
  const shares = [0, 1, 2, 3].map((d) => sweep(d, GROWN).share);
  for (let i = 1; i < shares.length; i++) {
    assert.ok(shares[i] < shares[i - 1], `rank ${i} did not undercut rank ${i - 1}: ${shares.join(' ')}`);
  }
  // Untrained is the undiscounted goods share — the mood is the SKILL's lever,
  // not the weather's, or a hero with no training would be handed bargains.
  assert.ok(Math.abs(shares[0] - CONFIG.PARLEY_COST_SHARE) < 0.02,
    `untrained paid ${shares[0].toFixed(3)} of recruit cost, expected ${CONFIG.PARLEY_COST_SHARE}`);
});

test('"some at a bargain": one map quotes a SPREAD of prices, not one number', () => {
  const s = world();
  const hero = heroAt(s, 3, GROWN);
  const asked = [];
  for (const m of monstersOf(s)) {
    const o = parleyOffer(s, hero, m);
    const rc = stackRecruitCost(m);
    if (o.offered && !o.refused && !o.free && rc > 0) asked.push(o.price / rc);
  }
  assert.ok(asked.length > 8, 'not enough quotes to judge a spread');
  const lo = Math.min(...asked), hi = Math.max(...asked);
  assert.ok(hi - lo > 0.2, `every band asked the same share (${lo.toFixed(2)}..${hi.toFixed(2)})`);
  // An untrained hero sees no spread at all — same map, same stacks.
  const plain = heroAt(world(), 0, GROWN);
  const s2 = world();
  const flat = new Set(monstersOf(s2).map((m) => {
    const o = parleyOffer(s2, plain, m);
    const rc = stackRecruitCost(m);
    return o.offered && rc > 0 && !o.free ? (o.price / rc).toFixed(2) : null;
  }).filter(Boolean));
  assert.ok(flat.size <= 3, `untrained quotes should be the flat goods share, saw ${[...flat].join(' ')}`);
});

test('a quote cannot be reload-scummed — same encounter, same price and same refusal', () => {
  const s = world();
  const hero = heroAt(s, 2, GROWN);
  for (const m of monstersOf(s).slice(0, 12)) {
    const a = parleyOffer(s, hero, m);
    const b = parleyOffer(s, hero, m);
    assert.deepEqual(a, b, `${m.creature} quoted differently on a second look`);
    assert.equal(parleyMood(s, m), parleyMood(s, m), 'the mood must be seeded, not rolled');
  }
});

test('the bargaining band widens with the skill', () => {
  const val = (m) => (CREATURES[m.creature]?.aiValue || 0) * m.count;
  let checked = 0;
  for (const seed of SEEDS) {
    const s = world(seed);
    const hero = heroAt(s, 0, [{ creature: 'pikeman', count: 60 }]);
    const heroVal = armyValue(hero.army);
    // A stack past the untrained band but inside the Expert one.
    const target = monstersOf(s).find((m) => {
      const r = val(m) / heroVal;
      return r > CONFIG.PARLEY_MAX_RATIO
        && r <= CONFIG.PARLEY_MAX_RATIO * (1 + SKILLS.diplomacy.levels[2] * CONFIG.PARLEY_BAND_BONUS);
    });
    if (!target) continue;
    checked++;
    assert.equal(parleyOffer(s, hero, target).reason, 'too strong', 'untrained should not reach it');
    hero.skills = { diplomacy: 3 };
    assert.equal(parleyOffer(s, hero, target).offered, true, 'an Expert diplomat should reach it');
  }
  assert.ok(checked > 0, 'no stack landed in the widened band — this test proved nothing');
});

test('FREE joins are kin only, trivial only, and never without the skill', () => {
  let sawFree = 0;
  for (const seed of SEEDS) {
    const s = world(seed);
    const hero = heroAt(s, 3, GROWN);
    const kin = new Set(hero.army.filter(Boolean).map((st) => st.creature));
    const heroVal = armyValue(hero.army);
    for (const m of monstersOf(s)) {
      const o = parleyOffer(s, hero, m);
      if (!o.offered || !o.free) continue;
      sawFree++;
      assert.ok(kin.has(m.creature), `${m.creature} joined free without being kin`);
      const ratio = (CREATURES[m.creature].aiValue || 0) * m.count / heroVal;
      assert.ok(ratio <= CONFIG.PARLEY_FREE_RATIO * SKILLS.diplomacy.levels[2],
        `${m.creature} x${m.count} was ${(ratio * 100).toFixed(1)}% of the host and still free`);
      assert.equal(o.price, 0);
    }
    // The same hero WITHOUT the skill is never given anything.
    hero.skills = {};
    for (const m of monstersOf(s)) {
      const o = parleyOffer(s, hero, m);
      assert.ok(!o.free, `${m.creature} joined an untrained hero for nothing`);
      if (o.offered) assert.ok(o.price > 0, 'an untrained hero must always be quoted a price');
    }
  }
  assert.ok(sawFree > 0, 'no kin joined free on any sample map — the free branch went untested');
});

test('a free join is a real join: the army grows, the tile clears, no gold moves', () => {
  // Scan the maps for an actual free offer rather than constructing one — a
  // fixture that never occurs in play would prove nothing about play.
  for (const seed of SEEDS) {
    const s = world(seed);
    const hero = heroAt(s, 3, GROWN);
    const target = monstersOf(s).find((m) => {
      const o = parleyOffer(s, hero, m);
      return o.offered && o.free && !o.refused;
    });
    if (!target) continue;
    const gold = s.players[0].resources.gold;
    const before = armyValue(hero.army);
    const res = parley(s, hero, target);
    assert.equal(res.ok, true);
    assert.equal(res.price, 0);
    assert.equal(s.players[0].resources.gold, gold, 'a free join must cost nothing');
    assert.ok(armyValue(hero.army) > before, 'they did not actually join');
    assert.ok(!s.map.objects[target.id], 'the band is still on the map');
    return;
  }
  assert.fail('no free join occurred on any of the sample maps — the branch is unreachable in play');
});

test('THE EXPLOIT STAYS CLOSED: even an Expert diplomat pays for an army', () => {
  // parley-price.test.js pins the untrained case. The skill discounts, but a
  // discount is not the one-gold hole coming back: an overwhelming hero with the
  // skill maxed must still hand over a real share of what the goods cost.
  const r = sweep(3, HUGE);
  assert.ok(r.share > 0.25,
    `an Expert diplomat bought the map at ${r.share.toFixed(3)} of recruit cost`);
  assert.equal(r.free, 0, 'a hero fielding nothing wild should never be given a free stack');
  const s = world();
  const hero = heroAt(s, 3, HUGE);
  for (const m of monstersOf(s)) {
    const o = parleyOffer(s, hero, m);
    if (!o.offered) continue;
    const rc = stackRecruitCost(m);
    if (rc > 0) assert.ok(o.price > rc * 0.15, `${m.creature} x${m.count}: ${o.price} for ${rc} of goods`);
  }
});

test('Diplomacy also cuts what your OWN surrender costs — and the hero is optional', () => {
  const army = [{ creature: 'swordsman', count: 20 }, { creature: 'marksman', count: 10 }];
  const plain = surrenderCost(army);
  assert.equal(surrenderCost(army, { skills: {} }), plain, 'no skill, no discount');
  assert.equal(surrenderCost(army, null), plain, 'the hero stays optional (old call sites)');
  const expert = surrenderCost(army, { skills: { diplomacy: 3 } });
  assert.ok(expert < plain, `Expert paid ${expert}, untrained ${plain}`);
  const cut = SKILLS.diplomacy.levels[2] * CONFIG.SURRENDER_DIPLOMACY_CUT;
  assert.equal(expert, Math.round(plain / CONFIG.SURRENDER_COST_MULT * CONFIG.SURRENDER_COST_MULT * (1 - cut)));
  assert.ok(expert > 0, 'surrender must never become free');
});
