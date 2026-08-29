/**
 * site-reward-proration.test.js — a prize worth what the fight cost.
 *
 * Reported: "we have the reward paying structures like Naga banks, Pandora boxes
 * etc fixed, which becomes very low as the guards grow — for example a Dwarven
 * Treasury pays $3000 if kept by 100 creatures or 100k creatures. Let's allow a
 * prorated reward, this way a hit may bring 300k."
 *
 * The mechanism for that already existed and was simply held shut. A bank pays
 * its table gold plus a premium off what the battle actually cost the attacker
 * (CONFIG.BANK_COST_GOLD_SHARE) — but capped at BANK_PREMIUM_MAX times the
 * table, which was TWO. So a Griffin Conservatory paid 7,500 whether the fight
 * cost 65,564 of army or 250,346 of it. Measured end to end, at 2 and at 100:
 *
 *   Cyclops Stockpile     guard 6→954    cost  77,633   15,000 → 25,747
 *   Griffin Conservatory  guard 12→2474  cost  65,564    7,500 → 19,525
 *   Griffin Conservatory  guard 12→2817  cost 250,346    7,500 → 65,721
 *   Cyclops Stockpile     guard 6→838    cost 208,367   15,000 → 58,431
 *
 * WHY GOLD AND NOT CREATURES, which is the part that must not drift: the creature
 * prize is deliberately a share of the garrison the MAP placed, never of the one
 * massed for this attacker, because that fed a loop — a bigger army buys a bigger
 * scaled guard, which pays a bigger creature prize, which buys a bigger army
 * (measured: 3.9M of free creatures against 5.3M of army growth over one
 * half-game). Gold cannot close that loop: it is spent on the economy, not on the
 * next fight's difficulty. See CONFIG.BANK_REWARD_SHARE for the full argument.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, levelObjects } from '../src/core/GameState.js';
import { combatContext, bankInterestDue } from '../src/core/actions.js';
import { AITurnController, BUILD_ORDER, BUILD_ORDER_CAPITOL } from '../src/ai/AIPlayer.js';
import { armyValue } from '../src/core/heroUtils.js';
import { bankDef } from '../src/data/creatureBanks.js';

function bigHeroWorld(seed) {
  const s = newGame({
    seed, mapW: 72, mapH: 60,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 60, hurt: 0 }, { creature: 'crusader', count: 200, hurt: 0 },
    { creature: 'marksman', count: 300, hurt: 0 }, { creature: 'monk', count: 200, hurt: 0 },
    { creature: 'cavalier', count: 120, hurt: 0 }, null, null];
  hero.level = 25;
  hero.stats = { attack: 18, defense: 15, power: 12, knowledge: 10 };
  return { s, hero };
}

/** Storm the first creature bank on the surface; return what it paid and cost. */
function plunder(seed) {
  const { s, hero } = bigHeroWorld(seed);
  const bank = Object.values(levelObjects(s, 0)).find((o) => o.type === 'creatureBank' && !o.looted);
  if (!bank) return null;
  const def = bankDef(bank.bankType);
  const gold0 = s.players[0].resources.gold || 0;
  const ctx = combatContext(s, hero, { kind: 'creatureBank', objectId: bank.id });
  const before = armyValue(hero.army);
  // The engine's own resolver, through the controller the computer's turn uses —
  // autoFight applies the result itself.
  new AITurnController(s, 0).autoFight(ctx);
  return {
    name: def?.name, table: def?.reward?.gold || 0,
    placed: (bank.guards || []).reduce((n, st) => n + (st?.count || 0), 0),
    massed: (ctx.defenderArmy || []).reduce((n, st) => n + (st?.count || 0), 0),
    cost: Math.round(before - armyValue(hero.army)),
    paid: (s.players[0].resources.gold || 0) - gold0,
  };
}

test('THE COMPLAINT: a bank no longer pays the same for a fight ten times harder', () => {
  const was = CONFIG.BANK_PREMIUM_MAX;
  try {
    // Two seeds whose banks mass to very different fights (measured: 65,564 and
    // 250,346 of army). At the old ceiling both paid the table's 7,500.
    CONFIG.BANK_PREMIUM_MAX = 2;
    const cheapOld = plunder(99001), dearOld = plunder(20260729);
    CONFIG.BANK_PREMIUM_MAX = was;
    const cheapNew = plunder(99001), dearNew = plunder(20260729);
    for (const r of [cheapOld, dearOld, cheapNew, dearNew]) assert.ok(r, 'no creature bank on the surface');

    assert.ok(dearOld.cost > cheapOld.cost * 2, 'fixture: the two fights must differ in cost');
    assert.equal(dearOld.paid, cheapOld.paid, 'the old ceiling paid the same for both — the reported defect');
    assert.ok(dearNew.paid > cheapNew.paid, 'the dearer fight must now pay more');
    assert.ok(dearNew.paid > dearOld.paid * 2, `a quarter-million-cost fight still paid ${dearNew.paid}`);
    // And the prize is a share of what the battle took, not a number pulled out
    // of the air: the premium is cost x BANK_COST_GOLD_SHARE on top of the table.
    const premium = dearNew.paid - dearOld.paid + (dearOld.paid - dearOld.table);
    assert.ok(premium > 0);
    assert.ok(dearNew.paid <= dearNew.table * (1 + CONFIG.BANK_PREMIUM_MAX) + 10_000,
      'the payout must still be bounded by the site');
  } finally { CONFIG.BANK_PREMIUM_MAX = was; }
});

test('the ceiling is still a property of the SITE, not of the attacker', () => {
  // Removing the bound entirely was rejected when this was first built: the sizer
  // guarantees a scaled fight costs a fixed share of the attacker's army, so an
  // uncapped share of that cost is a payout that scales with the army. A hundred
  // is headroom for a hard fight; it is not "no ceiling".
  assert.ok(Number.isFinite(CONFIG.BANK_PREMIUM_MAX), 'the premium must stay bounded');
  assert.ok(CONFIG.BANK_PREMIUM_MAX > 2, 'the whole point was that two was too tight');
  const dear = plunder(20260729);
  assert.ok(dear);
  assert.ok(dear.paid <= dear.table * (1 + CONFIG.BANK_PREMIUM_MAX) + 10_000,
    `paid ${dear.paid} against a table of ${dear.table}`);
});

test('the creature prize is untouched — it is the half that could feed the loop', () => {
  // A guard that MASSES for this attacker must not enlarge the creature prize.
  // This is the one line of defence for that, and it is worth a test of its own.
  const src = readFileSync(new URL('../src/core/actions.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function grantBankReward'), src.indexOf('function grantPandoraReward'));
  assert.ok(/const guarded = \(guardArmy \|\| \[\]\)/.test(fn),
    'the creature share must come from the guardArmy the caller passes (bank.guards, the placed garrison)');
  assert.ok(!/defenderArmy/.test(fn), 'grantBankReward must never read the massed fight army');
});

test('a GOLD Pandora box pays the same hard-fight premium; other kinds do not', () => {
  const src = readFileSync(new URL('../src/core/actions.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function grantPandoraReward'), src.indexOf('function grantPandoraReward') + 4000);
  assert.ok(/r\.kind === 'resource' && r\.resource === 'gold'/.test(fn),
    'the box premium must be gated on a gold reward — an experience or artifact box is not an economy prize');
  assert.ok(/CONFIG\.BANK_COST_GOLD_SHARE/.test(fn), 'and priced by the same share a bank uses');
  assert.ok(/CONFIG\.BANK_PREMIUM_MAX/.test(fn), 'and bounded by the same multiple of what the box itself rolled');
});

test('the deposit cap reaches a reserve worth holding', () => {
  assert.equal(CONFIG.BANK_DEPOSIT_CAP, 900000);
  const s = newGame({
    seed: 4242,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    features: { townBank: true },
  });
  const town = Object.values(s.towns).find((t) => t.owner === 0);
  if (!town.buildings.includes('bank')) town.buildings.push('bank');
  // Half a million held now earns on all of it, where the old cap reached a fifth.
  s.players[0].resources.gold = 500_000;
  const due = bankInterestDue(s, 0);
  assert.ok(due > 0);
  assert.equal(due, Math.floor(500_000 * CONFIG.BANK_DEPOSIT_RATE),
    'a held half-million must earn on the whole of it');
  // And the cap still binds above itself.
  s.players[0].resources.gold = 2_000_000;
  assert.equal(bankInterestDue(s, 0), Math.floor(CONFIG.BANK_DEPOSIT_CAP * CONFIG.BANK_DEPOSIT_RATE));
});

test('the Altar is available to a rival realm, and cannot displace the Capitol', () => {
  // Asked for as available, not necessarily used: "it is not necessary for them
  // to use it, until such a time when their logic sees a benefit." Placed last so
  // it cannot take a day or 4,000 gold from the Castle or the Capitol — which is
  // exactly what an earlier, earlier placement did, and two existing tests caught
  // it by finding the Shipyard and the Capitol pushed down the order.
  for (const [name, order] of [['BUILD_ORDER', BUILD_ORDER], ['BUILD_ORDER_CAPITOL', BUILD_ORDER_CAPITOL]]) {
    assert.ok(order.includes('altar'), `${name} can never raise an Altar`);
    assert.ok(order.indexOf('marketplace') < order.indexOf('altar'), `${name}: Altar before its prerequisite`);
    for (const key of ['castle', 'capitol', 'shipyard']) {
      if (order.includes(key)) {
        assert.ok(order.indexOf(key) < order.indexOf('altar'),
          `${name} would build the Altar before the ${key}`);
      }
    }
  }
});
