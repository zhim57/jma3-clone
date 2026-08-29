/**
 * ai-parley.test.js — the rival half of Diplomacy.
 *
 * `parley` used to be reachable only from the human's Fight/Parley dialog, so a
 * rival hero that learned Diplomacy got one of the skill's four effects and the
 * human had an army-for-gold converter the AI could not answer — measured with
 * the feature on, an Expert diplomat turns 87% of the map's encounters into
 * recruitment. AIPlayer.maybeParleyStack closes that.
 *
 * WHERE IT HOOKS, and why it is not before the step. The AI's combat branch is
 * the one place that sees every way a hero comes to blows with a wild stack:
 * walking onto its tile, attacking it directly, and being waylaid by its zone of
 * control. It also arrives holding the encounter the battle would actually run.
 *
 * WHAT IT COSTS. combatContext stamps ctx.parleyOffer only for a HUMAN attacker
 * — the whole PvE-scaling block returns early for the AI, deliberately (see
 * tideScaleDefender). So a rival hero prices its own offer: one auto-resolved
 * battle per monster encounter. parleyOffer now returns the `loss` it computed
 * so that does not become two.
 *
 * WHAT IT DOES, measured over four 45-day games with the feature on. AI heroes
 * met 668 neutral bands:
 *
 *              no skill   every hero Expert Diplomacy
 *   refused         157   35     (the ×(1-dip) cut, working)
 *   no room         308   408    ← seven full slots, the real ceiling
 *   cannot pay      111   135
 *   bought           22   35     (+59%)
 *
 * The skill is worth real but bounded value to a rival, which is what
 * SKILL_WEIGHTS.diplomacy is now priced on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, levelObjects } from '../src/core/GameState.js';
import { combatContext } from '../src/core/actions.js';
import { parleyOffer, predictedFightLoss } from '../src/core/diplomacy.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { skillOptionScore, SKILL_WEIGHTS } from '../src/core/skillPolicy.js';
import { armyValue } from '../src/core/heroUtils.js';

/** A world where player 1 is the computer, with a hero worth bargaining with. */
function world({ diplomacy = true, gold = 1_000_000, army = null } = {}) {
  const s = newGame({
    seed: 4242,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    mapW: 44, mapH: 36, features: diplomacy ? { diplomacy: true } : {},
  });
  const hero = playerHeroes(s, 1)[0];
  hero.army = army || [{ creature: 'imp', count: 60, hurt: 0 }, { creature: 'gog', count: 30, hurt: 0 },
    null, null, null, null, null];
  s.players[1].resources.gold = gold;
  return { s, hero, ai: new AITurnController(s, 1) };
}
const wild = (s) => Object.values(levelObjects(s, 0)).filter((o) => o.type === 'monster');
const ctxFor = (s, hero, m) => combatContext(s, hero, { kind: 'monster', objectId: m.id });

/** The first band this AI hero would actually buy. */
function findBuyable({ s, hero }) {
  for (const m of wild(s)) {
    const o = parleyOffer(s, hero, m);
    if (o.offered && o.acceptable) return m;
  }
  return null;
}

test('the offer carries the loss it computed, so nobody simulates the fight twice', () => {
  const { s, hero } = world();
  let checked = 0;
  for (const m of wild(s).slice(0, 10)) {
    const o = parleyOffer(s, hero, m);
    if (!o.offered) continue;
    checked++;
    assert.equal(o.loss, predictedFightLoss(s, hero, m),
      `${m.creature}: the offer's loss must be the same number the sim returns`);
  }
  assert.ok(checked > 0, 'no offers to check');
});

test('a rival hero buys a band it can afford and has room for', () => {
  const w = world();
  const m = findBuyable(w);
  assert.ok(m, 'no band on this map would deal with the computer');
  const gold0 = w.s.players[1].resources.gold;
  const val0 = armyValue(w.hero.army);
  const ctx = ctxFor(w.s, w.hero, m);
  // The AI must price its OWN offer: combatContext does not stamp one for a
  // non-human attacker, and that is the whole reason this can go wrong quietly.
  assert.equal(ctx.parleyOffer, undefined, 'the AI is not handed a priced offer');

  assert.equal(w.ai.maybeParleyStack(w.hero, ctx), true);
  assert.ok(!w.s.map.objects[m.id], 'the band is still on the map');
  assert.ok(armyValue(w.hero.army) > val0, 'the band did not join');
  assert.ok(w.s.players[1].resources.gold < gold0, 'no gold changed hands');
  assert.equal(w.ai.metrics.parleys, 1);
  assert.ok(w.ai.metrics.parleyGold > 0);
});

test('a rival never parleys with the feature off — it is opt-in for both sides', () => {
  const on = world();
  const m = findBuyable(on);
  assert.ok(m);
  const off = world({ diplomacy: false });
  const same = wild(off.s).find((o) => o.id === m.id);
  assert.equal(off.ai.maybeParleyStack(off.hero, ctxFor(off.s, off.hero, same)), false);
  assert.ok(off.s.map.objects[same.id], 'the band was cleared with diplomacy off');
});

test('a rival will not spend the last of the treasury on recruits', () => {
  const w = world();
  const m = findBuyable(w);
  assert.ok(m);
  const price = parleyOffer(w.s, w.hero, m).price;
  // Exactly one gold short of the floor — the offer is still affordable, so this
  // isolates the floor from `acceptable`.
  w.s.players[1].resources.gold = price + CONFIG.AI_DEFENCE_GOLD_FLOOR - 1;
  assert.equal(w.ai.maybeParleyStack(w.hero, ctxFor(w.s, w.hero, m)), false);
  assert.ok(w.s.map.objects[m.id]);
  w.s.players[1].resources.gold = price + CONFIG.AI_DEFENCE_GOLD_FLOOR;
  assert.equal(w.ai.maybeParleyStack(w.hero, ctxFor(w.s, w.hero, m)), true);
});

// Seven occupied slots with a weak tail — the shape that makes the trade real:
// the Imps are worth less than several bands standing on this map, and less than
// half of some, so both sides of the AI_PARLEY_EVICT_MARGIN gate get exercised.
const FULL = [
  { creature: 'imp', count: 20, hurt: 0 }, { creature: 'gog', count: 30, hurt: 0 },
  { creature: 'hellHound', count: 20, hurt: 0 }, { creature: 'demon', count: 20, hurt: 0 },
  { creature: 'pitFiend', count: 10, hurt: 0 }, { creature: 'efreeti', count: 8, hurt: 0 },
  { creature: 'devil', count: 4, hurt: 0 },
];

test('seven full slots: a rival clears one for a band worth clearing it for', () => {
  // Full slots WERE the ceiling — 408 of 666 encounters in the first sweep, more
  // than gold. A hero now dismisses its weakest stack, the same trade a human
  // makes by hand on the hero sheet.
  const w = world({ army: FULL.map((st) => ({ ...st })) });
  const weakest = w.hero.army.reduce((lo, st, i) =>
    (armyValue([st]) < armyValue([w.hero.army[lo]]) ? i : lo), 0);
  const target = wild(w.s).find((m) => {
    if (w.hero.army.some((st) => st && st.creature === m.creature)) return false;
    return w.ai.evictionForParley(w.hero, m) >= 0;
  });
  assert.ok(target, 'no band on this map was worth clearing a slot for');
  assert.equal(w.ai.evictionForParley(w.hero, target), weakest,
    'it must give up the least valuable stack, the same ranking consolidateInto uses');
  // Nothing has been thrown away yet — the eviction is only a proposal here.
  assert.ok(w.hero.army[weakest], 'evictionForParley must not mutate the army');
  assert.equal(parleyOffer(w.s, w.hero, target).reason, 'no room',
    'and the offer itself still refuses, so the invariant is never bent');
});

test('a cleared slot is only ever spent on a real upgrade', () => {
  const w = world({ army: FULL.map((st) => ({ ...st })) });
  const weakVal = Math.min(...w.hero.army.filter(Boolean).map((st) => armyValue([st])));
  let refused = 0, allowed = 0;
  for (const m of wild(w.s)) {
    if (w.hero.army.some((st) => st && st.creature === m.creature)) continue;
    const coming = armyValue([{ creature: m.creature, count: m.count }]);
    const evict = w.ai.evictionForParley(w.hero, m);
    if (coming < weakVal * CONFIG.AI_PARLEY_EVICT_MARGIN) {
      refused++;
      assert.equal(evict, -1, `${m.count} ${m.creature} (${Math.round(coming)}) is not worth `
        + `dismissing ${Math.round(weakVal)} of army`);
    } else {
      allowed++;
      assert.ok(evict >= 0, `${m.count} ${m.creature} is a clear upgrade and was refused`);
    }
  }
  // Both sides of the gate, or this proves only that one branch exists.
  assert.ok(refused > 0 && allowed > 0, `gate exercised one-sided: ${allowed} allowed, ${refused} refused`);
});

test('a hero with room, or with kin, never proposes an eviction', () => {
  const w = world(); // two stacks, five free slots
  for (const m of wild(w.s).slice(0, 15)) {
    assert.equal(w.ai.evictionForParley(w.hero, m), -1, 'there is a free slot');
  }
  // Kin count as room even with every slot full.
  const full = world({ army: FULL.map((st) => ({ ...st })) });
  const kin = wild(full.s).find((m) => full.hero.army.some((st) => st && st.creature === m.creature));
  if (kin) assert.equal(full.ai.evictionForParley(full.hero, kin), -1, 'they merge into their own kind');
});

test('the dismissal happens only once the deal is agreed, and is undone if it is not', () => {
  // Ask the REAL decision which band it would take, one fresh world per
  // candidate — replicating the price gate here to pick a fixture would be the
  // instrument reimplementing the engine, which is how a test comes to pass
  // against a rule the game does not actually follow.
  let closed = false;
  for (const id of wild(world({ army: FULL.map((st) => ({ ...st })) }).s).map((m) => m.id)) {
    const w = world({ army: FULL.map((st) => ({ ...st })) });
    const m = wild(w.s).find((o) => o.id === id);
    if (w.ai.evictionForParley(w.hero, m) < 0) continue;
    const dropped = w.hero.army[w.ai.evictionForParley(w.hero, m)];
    if (!w.ai.maybeParleyStack(w.hero, ctxFor(w.s, w.hero, m))) {
      // Declined — then nothing may have been thrown away for it.
      assert.ok(w.hero.army.includes(dropped), `${m.creature}: declined, but the stack is gone`);
      assert.equal(w.ai.metrics.parleyEvictions, 0);
      continue;
    }
    closed = true;
    assert.equal(w.ai.metrics.parleyEvictions, 1);
    assert.ok(!w.hero.army.includes(dropped), 'the dismissed stack is still there');
    assert.ok(w.hero.army.some((st) => st && st.creature === m.creature), 'the band did not join');
    assert.ok(!w.s.map.objects[m.id]);
    break;
  }
  assert.ok(closed, 'no band was ever taken by clearing a slot — the path is unreachable');
  // A deal that CANNOT close must leave the army exactly as it was — a refused
  // parley may never cost a stack for nothing.
  const poor = world({ army: FULL.map((st) => ({ ...st })), gold: 0 });
  const before = poor.hero.army.map((st) => (st ? `${st.creature}:${st.count}` : null)).join('|');
  for (const m of wild(poor.s)) poor.ai.maybeParleyStack(poor.hero, ctxFor(poor.s, poor.hero, m));
  assert.equal(poor.hero.army.map((st) => (st ? `${st.creature}:${st.count}` : null)).join('|'), before,
    'a broke realm dismissed a stack and got nothing for it');
  assert.equal(poor.ai.metrics.parleyEvictions, 0);
});

test('the AI declines a price worth more than the band and the fight it avoids', () => {
  const w = world();
  const m = findBuyable(w);
  assert.ok(m);
  // Nothing is worth anything: both anchors go to zero, so the rule must refuse.
  const rate = CONFIG.AI_PARLEY_GOODS_RATE;
  CONFIG.AI_PARLEY_GOODS_RATE = 0;
  try {
    const o = parleyOffer(w.s, w.hero, m);
    if (o.loss * CONFIG.PARLEY_PRICE_MULT >= o.price) return; // a fight it truly fears: paying is right
    assert.equal(w.ai.maybeParleyStack(w.hero, ctxFor(w.s, w.hero, m)), false);
    assert.ok(w.s.map.objects[m.id], 'bought a band it had priced as not worth buying');
  } finally { CONFIG.AI_PARLEY_GOODS_RATE = rate; }
});

test('a rival values Diplomacy only in a game that has it', () => {
  const hero = { class: 'knight', skills: {}, army: [] };
  const opt = { skill: 'diplomacy', toLevel: 1 };
  const on = skillOptionScore(hero, opt, (id) => id === 'diplomacy');
  const off = skillOptionScore(hero, opt, () => false);
  assert.equal(on, SKILL_WEIGHTS.diplomacy[0], 'with the rule on it is worth its weight');
  assert.ok(off < on, 'with the rule off it must not be scored as if it could act');
  // Omitted entirely, the conservative answer: a caller that does not know must
  // not have its hero spend one of eight slots on a skill that cannot act.
  assert.equal(skillOptionScore(hero, opt), off);
  // An ungated skill is untouched by any of this.
  assert.equal(skillOptionScore(hero, { skill: 'logistics', toLevel: 1 }, () => false),
    SKILL_WEIGHTS.logistics[0]);
  // And the later-rank discount still applies on both sides of the gate.
  assert.ok(skillOptionScore(hero, { skill: 'diplomacy', toLevel: 3 }, (id) => id === 'diplomacy') < on);
  assert.ok(skillOptionScore(hero, { skill: 'diplomacy', toLevel: 3 }, () => false) < off);
});
