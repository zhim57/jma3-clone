/**
 * flee-chase.test.js — a weak band runs, and the player decides what that is worth.
 *
 * Reported: "we also need the flee and chase options — for example a weak stack
 * may flee, and a user may decide to chase if they need the experience, or to let
 * them go and save time."
 *
 * Two measurements shaped the rule, and both are pinned here.
 *
 * WHAT IT IS WEIGHED ON. The first build weighed the flight against
 * ctx.defenderArmy — what the band would actually field. With PvE scaling on
 * (the default) the tide sizer masses every wild stack to roughly half the
 * attacker's army, so nothing was ever weak: 0 flights in 114 encounters across
 * four maps, at every army size. The feature was dead in the default game. It is
 * weighed on the stack AS IT STANDS instead — the band cannot see the sizer — and
 * the chase still fights the full, sized battle for its full experience.
 *
 * WHO NEVER RUNS. Letting a band go clears its tile, so a fleeing GUARD would
 * hand over the mine or artifact it was posted on for nothing. Exempting guards
 * (with ronin-led bands and invader war-bands) took the rate from 26-36% of
 * encounters to 15-18% — that difference IS the map's guarded prizes, and it is
 * the whole reason the exemption exists.
 *
 * After: a green starting column sees no flights at all (nothing on the map is
 * trivial to it); a grown army 14.9%; an overwhelming one 17.5%. Flight is
 * something you earn by outgrowing the countryside.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { combatContext, encounterFlees, letThemGo, chaseThem, chaseCost } from '../src/core/actions.js';
import { fleeCheck } from '../src/core/diplomacy.js';
import { armyValue, heroMaxMovement } from '../src/core/heroUtils.js';

const SEEDS = [4242, 376709956, 99001, 13371337];
const GROWN = [{ creature: 'swordsman', count: 40 }, { creature: 'marksman', count: 30 },
  { creature: 'griffin', count: 20 }];

function world(seed = 4242, features = {}) {
  return newGame({
    seed,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    mapW: 44, mapH: 36, features,
  });
}
function heroWith(s, army) {
  const h = playerHeroes(s, 0)[0];
  h.army = [...army, null, null, null, null, null, null, null].slice(0, 7);
  h.mp = heroMaxMovement(h);
  s.players[0].resources.gold = 1_000_000;
  return h;
}
const monstersOf = (s) => Object.values(s.map.objects).filter((o) => o.type === 'monster');
const ctxFor = (s, hero, m) => combatContext(s, hero, { kind: 'monster', objectId: m.id });
const stackVal = (m) => (CREATURES[m.creature]?.aiValue || 0) * m.count;

/** The first encounter on these maps where the band actually broke and ran. */
function findFlight(army = GROWN) {
  for (const seed of SEEDS) {
    const s = world(seed);
    const hero = heroWith(s, army);
    for (const m of monstersOf(s)) {
      const ctx = ctxFor(s, hero, m);
      if (encounterFlees(s, ctx).flees) return { s, hero, m, ctx };
    }
  }
  return null;
}

test('a weak band runs, and a starting column never sees it', () => {
  let grownFled = 0, greenFled = 0, seen = 0;
  for (const seed of SEEDS) {
    for (const [army, tally] of [[GROWN, 'grown'], [[{ creature: 'pikeman', count: 20 }], 'green']]) {
      const s = world(seed);
      const hero = heroWith(s, army);
      for (const m of monstersOf(s)) {
        if (tally === 'grown') seen++;
        if (!fleeCheck(s, hero, m).flees) continue;
        if (tally === 'grown') grownFled++; else greenFled++;
      }
    }
  }
  assert.ok(grownFled > 0, 'nothing ever ran from a developed army — the fork is unreachable');
  assert.ok(grownFled / seen < 0.4, `${grownFled}/${seen} ran — a rout should not be the usual encounter`);
  assert.equal(greenFled, 0, 'a starting column should frighten nobody');
});

test('THE LOAD-BEARING EXEMPTION: a guard posted on a prize never runs', () => {
  // Letting them go clears the tile, so a fleeing guard hands over what it was
  // standing on. Prove the exemption is what stops it, not the odds: find a guard
  // weak enough to be inside the flee band and check it still holds.
  let checked = 0;
  for (const seed of SEEDS) {
    const s = world(seed);
    const hero = heroWith(s, GROWN);
    const heroVal = armyValue(hero.army);
    for (const m of monstersOf(s)) {
      if (!m.guards) continue;
      if (stackVal(m) / heroVal >= CONFIG.FLEE_MAX_RATIO) continue; // outside the band anyway
      checked++;
      const r = fleeCheck(s, hero, m);
      assert.equal(r.flees, false, `${m.creature} x${m.count} abandoned the prize it guards`);
      assert.equal(r.reason, 'guarding');
    }
  }
  assert.ok(checked > 0, 'no weak guard on any sample map — this test proved nothing');
});

test('a ronin-led band and an invading war-band hold their ground', () => {
  const s = world();
  const hero = heroWith(s, GROWN);
  const weak = monstersOf(s).find((m) => !m.guards
    && stackVal(m) / armyValue(hero.army) < CONFIG.FLEE_MAX_RATIO * 0.2);
  assert.ok(weak, 'no trivially weak wild stack on this map');
  assert.ok(fleeCheck(s, hero, weak).flees || fleeCheck(s, hero, weak).chance > 0.5,
    'the fixture stack should be inside the flee band');
  assert.equal(fleeCheck(s, hero, { ...weak, ronin: { hero: { name: 'X' } } }).reason, 'commanded');
  assert.equal(fleeCheck(s, hero, { ...weak, invader: { nation: 'x' } }).reason, 'invader');
});

test('the odds decide it: past FLEE_MAX_RATIO nobody runs, and the chance falls to meet it', () => {
  const s = world();
  const hero = heroWith(s, GROWN);
  const heroVal = armyValue(hero.army);
  let lastChance = Infinity;
  const rows = monstersOf(s).filter((m) => !m.guards)
    .map((m) => fleeCheck(s, hero, m))
    .sort((a, b) => a.ratio - b.ratio);
  for (const r of rows) {
    if (r.ratio >= CONFIG.FLEE_MAX_RATIO) {
      assert.equal(r.flees, false, `a band at ${r.ratio.toFixed(2)} of the army ran`);
      assert.equal(r.reason, 'stands its ground');
      assert.equal(r.chance, 0);
    } else {
      assert.ok(r.chance <= lastChance + 1e-9, 'terror must fall as the odds even out');
      assert.ok(r.chance <= CONFIG.FLEE_CHANCE_MAX);
      lastChance = r.chance;
    }
  }
  assert.ok(heroVal > 0);
});

test('the roll is seeded — a reload cannot turn a flight into a fight', () => {
  const s = world();
  const hero = heroWith(s, GROWN);
  for (const m of monstersOf(s).slice(0, 20)) {
    assert.deepEqual(fleeCheck(s, hero, m), fleeCheck(s, hero, m));
  }
});

test('LET THEM GO: the road clears, and nothing else is paid or claimed', () => {
  const found = findFlight();
  assert.ok(found, 'no band ran on any sample map');
  const { s, hero, m, ctx } = found;
  const xp = hero.xp || 0;
  const army = armyValue(hero.army);
  const mp = hero.mp;
  const res = letThemGo(s, ctx);
  assert.equal(res.ok, true);
  assert.ok(!s.map.objects[m.id], 'the band is still standing on the road');
  assert.equal(hero.xp || 0, xp, 'letting them go must pay no experience');
  assert.equal(armyValue(hero.army), army, 'and cost no army');
  assert.equal(hero.mp, mp, 'and no movement — that is the whole point of it');
});

test('CHASE: it costs a slice of the day, and then you fight the battle you came for', () => {
  const found = findFlight();
  assert.ok(found);
  const { s, hero, m, ctx } = found;
  const before = hero.mp;
  const res = chaseThem(s, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.spent, chaseCost(hero));
  assert.equal(hero.mp, before - chaseCost(hero));
  assert.ok(chaseCost(hero) > 0, 'a free chase is not a fork');
  // The band is untouched — the caller opens the ordinary battle next.
  assert.ok(s.map.objects[m.id], 'chasing must not clear the tile by itself');
  // And that battle is the FULL sized encounter, not the marker's headcount:
  // the experience is what the player is spending the afternoon on.
  const massed = (ctx.defenderArmy || []).reduce((n, st) => n + (st ? st.count : 0), 0);
  assert.ok(massed >= m.count, `chased ${massed} where ${m.count} stood`);
});

test('CHASE at dusk spends what is left rather than refusing', () => {
  const found = findFlight();
  const { s, hero, ctx } = found;
  hero.mp = 3;
  assert.deepEqual(chaseThem(s, ctx), { ok: true, spent: 3 });
  assert.equal(hero.mp, 0);
});

test('both forks are fail-closed: a band that stood its ground cannot be waved away', () => {
  // Without this, "let them go" is a free button that clears any stack on the map.
  const s = world();
  const hero = heroWith(s, GROWN);
  const stood = monstersOf(s).find((m) => !fleeCheck(s, hero, m).flees);
  assert.ok(stood, 'every stack on this map ran');
  const ctx = ctxFor(s, hero, stood);
  const mp = hero.mp;
  assert.deepEqual(letThemGo(s, ctx), { ok: false, reason: 'they did not run' });
  assert.deepEqual(chaseThem(s, ctx), { ok: false, reason: 'they did not run' });
  assert.ok(s.map.objects[stood.id], 'the stack was cleared anyway');
  assert.equal(hero.mp, mp, 'and movement was spent on a chase that never happened');
});

test('flight does not depend on the opt-in diplomacy feature', () => {
  // Flee is its own mechanic. It was briefly weighed on the encounter army, which
  // made it fire ONLY in diplomacy games (a joinable stack is the one the sizer
  // leaves at resting size) — 0% with the feature off, 26% with it on.
  const counts = [false, true].map((on) => {
    let n = 0;
    for (const seed of SEEDS) {
      const s = world(seed, on ? { diplomacy: true } : {});
      const hero = heroWith(s, GROWN);
      for (const m of monstersOf(s)) if (fleeCheck(s, hero, m).flees) n++;
    }
    return n;
  });
  assert.equal(counts[0], counts[1], `flights: ${counts[0]} without diplomacy, ${counts[1]} with`);
  assert.ok(counts[0] > 0);
});
