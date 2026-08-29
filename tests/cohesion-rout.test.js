/**
 * cohesion-rout.test.js — #11 (opt-in): bloodied stacks waver then rout.
 *
 * The break-chance curve (clamped, steadier with morale), plus integration
 * through createBattle + autoResolve: with the feature ON a badly-bloodied stack
 * can rout (survivors flee, marked routed); with it OFF nothing ever wavers or
 * routs (Classic path — no rng drawn); and the undead are fearless.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { createBattle, beginTurn, act, routBreakChance } from '../src/core/combat/CombatEngine.js';
import { autoResolve, chooseAction } from '../src/core/combat/CombatAI.js';

function fight(features, seed, defenderCreature = 'pikeman') {
  const battle = createBattle({
    rng: new Rng(seed), terrain: 'grass', features,
    attacker: { hero: null, army: [{ creature: 'pikeman', count: 60 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: defenderCreature, count: 18 }], playerIndex: 1 },
  });
  autoResolve(battle);
  return battle;
}
const anyRouted = (b) => b.units.some((u) => u.routed);

test('routBreakChance: clamped to [MIN,MAX] and decreasing in morale', () => {
  assert.equal(routBreakChance(0), CONFIG.ROUT_BASE);
  assert.ok(routBreakChance(-100) === CONFIG.ROUT_MAX, 'terror caps at MAX');
  assert.ok(routBreakChance(100) === CONFIG.ROUT_MIN, 'iron nerve floors at MIN');
  assert.ok(routBreakChance(1) < routBreakChance(0), 'higher morale steadies the stack');
  assert.ok(CONFIG.ROUT_MAX < 0.9, 'cap sits well below certainty (no one-roll wipe)');
});

test('cohesionRout ON: a bloodied loser routs on at least some seeds', () => {
  let routed = 0;
  for (let s = 1; s <= 40; s++) if (anyRouted(fight({ cohesionRout: true }, s))) routed++;
  assert.ok(routed > 0, `expected some routs across 40 seeds, got ${routed}`);
});

test('cohesionRout OFF: nothing wavers, routs, or accrues break strikes', () => {
  for (let s = 1; s <= 40; s++) {
    const b = fight({}, s);
    assert.ok(!b.units.some((u) => u.routed || u.wavered || u.breakFails),
      `seed ${s} should have no cohesion effects when the feature is off`);
  }
});

test('the undead are fearless — a skeleton stack never routs', () => {
  for (let s = 1; s <= 40; s++) {
    const b = fight({ cohesionRout: true }, s, 'skeleton');
    assert.ok(!b.units.some((u) => u.routed && u.creature === 'skeleton'),
      `seed ${s}: skeletons must not rout`);
  }
});

test('a rout event carries the fled-survivor count, matching the hpLost booking (S8)', () => {
  // The debrief is a reducer over the EVENT STREAM (battleDigest), and a rout
  // is the one loss with no `kills` on any event — without `count` the fled
  // troops were reported as having survived a battle their army left without
  // them. Drive battles manually (autoResolve discards events) until a rout
  // fires, then check the event's count against the engine's own casualty
  // arithmetic: hpLost must have grown by exactly count * maxHp on that event.
  let seen = 0;
  for (let seed = 1; seed <= 60 && seen < 3; seed++) {
    const b = createBattle({
      rng: new Rng(seed), terrain: 'grass', features: { cohesionRout: true },
      attacker: { hero: null, army: [{ creature: 'pikeman', count: 60 }], playerIndex: 0 },
      defender: { hero: null, army: [{ creature: 'wyvern', count: 6 }], playerIndex: 1 },
    });
    for (let guard = 0; guard < 3000 && !b.over; guard++) {
      const { unit, events } = beginTurn(b);
      if (!unit) break;
      const before = [...b.hpLost];
      events.push(...act(b, unit, chooseAction(b, unit)));
      const rout = events.find((e) => e.type === 'rout');
      if (!rout) continue;
      const u = b.units.find((x) => x.id === rout.unitId);
      assert.ok(Number.isInteger(rout.count) && rout.count > 0,
        `seed ${seed}: the rout event must say how many fled`);
      assert.ok(b.hpLost[u.side] - before[u.side] >= rout.count * u.maxHp,
        `seed ${seed}: the fled were booked as casualties at count * maxHp`);
      assert.equal(u.count, 0, 'the routed stack is emptied');
      seen++;
      break;
    }
  }
  assert.ok(seen > 0, 'expected at least one rout across 60 seeds');
});
