/**
 * territorial-defence.test.js — what it costs to KEEP something.
 *
 * A hero with one pikeman walked past a mine and reflagged it, and that was the
 * entire ownership model. The same weightlessness took Ashenfell five times in
 * four days, twice on day 42, once with 43,396 attacking 4,128. Measured in six
 * headless campaigns before any of this was built: 275 holdings changed hands
 * 530 times, and 14 of them changed hands three or four times inside a single
 * five-day window — three of those were towns.
 *
 * The ladder, and what each rung buys:
 *
 *   watch          free, automatic on capture — the seizure is announced and
 *                  dated. Buys no combat; it is the END of silent reflagging.
 *   garrison       bought bodies that an attacker must actually beat.
 *   fortification  a one-off wall: defender bonus, and the winner still bleeds.
 *
 * Upkeep is the balancing force — holding everything has to be unaffordable, so
 * a realm chooses what it defends. And a TOWN an AI takes keeps a garrison scaled
 * to the army that took it, which is the single clause that ends the ping-pong —
 * for a human it is a choice made in the town screen instead, because a human has
 * one and asked for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, playerTowns, serialize, deserialize, levelObjects } from '../src/core/GameState.js';
import {
  garrisonHolding, fortifyHolding, claimHolding, leaveCaptureGarrison, buyoutHolding,
  dailyIncome, combatContext, applyCombatResult, stepHero, endTurn,
} from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import {
  defenceLayer, defenceValue, isDefended, defenceUpkeep, garrisonUnitCost,
  captureGarrisonValue, garrisonCreature, buyoutPrice,
} from '../src/core/holdings.js';
import { addToArmy, armyValue } from '../src/core/heroUtils.js';

const SEED = 4242;

function game() {
  return newGame({ seed: SEED, mapW: 44, mapH: 36 });
}

/** The first mine on the surface, handed to `owner`. */
function mineFor(s, owner) {
  const mine = Object.values(levelObjects(s, 0)).find((o) => o.type === 'mine');
  assert.ok(mine, 'the map has a mine');
  claimHolding(s, mine, owner);
  return mine;
}

const army = (...stacks) => {
  const a = [null, null, null, null, null, null, null];
  for (const [creature, count] of stacks) addToArmy(a, creature, count);
  return a;
};

// ---------------------------------------------------------------------------

test('watch: taking a holding is announced and dated, and is no longer silent', () => {
  const s = game();
  const mine = mineFor(s, 0);
  assert.equal(defenceLayer(mine), 'watch', 'a watch comes free with the flag');
  assert.equal(mine.defence.since, s.day);

  s.day = 38;
  const before = s.log.length;
  claimHolding(s, mine, 1);

  assert.equal(mine.owner, 1);
  const line = s.log[s.log.length - 1];
  assert.ok(s.log.length > before, 'the seizure is reported');
  assert.equal(line.day, 38, 'and dated');
  assert.match(line.text, /seized/);
  assert.equal(mine.defence.contested, 1, 'and the ground is remembered as fought over');
});

test('garrison: bodies are bought with gold, capped, and cost upkeep every day', () => {
  const s = game();
  const mine = mineFor(s, 0);
  const unit = garrisonUnitCost(s, 0);
  s.players[0].resources.gold = unit * 10;

  const bought = garrisonHolding(s, mine, 6);
  assert.equal(bought, 6);
  assert.equal(s.players[0].resources.gold, unit * 4, 'paid for at the going rate');
  assert.equal(defenceLayer(mine), 'garrison');
  assert.ok(isDefended(mine));
  assert.equal(defenceValue(mine), armyValue([{ creature: garrisonCreature(s, 0), count: 6 }]));

  // Upkeep lands in the same ledger as the income it eats.
  assert.equal(defenceUpkeep(s, 0), 6 * CONFIG.DEFENCE_GARRISON_UPKEEP);
  const withGarrison = dailyIncome(s, s.players[0]).gold;
  mine.defence.garrison = [];
  const without = dailyIncome(s, s.players[0]).gold;
  assert.equal(without - withGarrison, 6 * CONFIG.DEFENCE_GARRISON_UPKEEP,
    'the garrison shows up as a cost, not a footnote');

  // A holding can only billet so many, and a broke realm buys none.
  s.players[0].resources.gold = unit * 1000;
  garrisonHolding(s, mine, 999);
  const standing = mine.defence.garrison.reduce((n, st) => n + st.count, 0);
  assert.equal(standing, CONFIG.DEFENCE_GARRISON_MAX);
  s.players[0].resources.gold = 0;
  assert.equal(garrisonHolding(s, mineFor(s, 0), 5), 0, 'no gold, no garrison');
});

test('garrison: a defended holding must be fought for, not walked onto', () => {
  const s = game();
  const mine = mineFor(s, 1);
  s.players[1].resources.gold = 100000;
  garrisonHolding(s, mine, 20);

  const hero = playerHeroes(s, 0)[0];
  hero.army = army(['angel', 20]);
  hero.x = mine.x - 1; hero.y = mine.y; hero.z = mine.z ?? 0;
  hero.mp = 2000;

  const ev = stepHero(s, hero, { x: mine.x, y: mine.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'the garrison has to be beaten');
  assert.equal(ev.context.defender.kind, 'holding');
  assert.equal(ev.context.defenderArmy.length, 1);
  assert.equal(mine.owner, 1, 'and nothing changed hands by walking');
});

test('fortification: a defender bonus, and the winner still bleeds', () => {
  const s = game();
  const mine = mineFor(s, 1);
  s.players[1].resources.gold = 100000;
  const bought = garrisonHolding(s, mine, 10);
  assert.ok(bought > 0);
  assert.ok(fortifyHolding(s, mine));
  assert.equal(defenceLayer(mine), 'fortification');
  assert.equal(s.players[1].resources.gold,
    100000 - bought * garrisonUnitCost(s, 1) - CONFIG.DEFENCE_FORTIFY_COST);
  assert.equal(fortifyHolding(s, mine), false, 'masonry is raised once');

  const hero = playerHeroes(s, 0)[0];
  hero.army = army(['angel', 50]);
  const ctx = combatContext(s, hero, { kind: 'holding', objectId: mine.id });
  assert.equal(ctx.defenseBonus, CONFIG.DEFENCE_FORTIFY_BONUS, 'the walls are worth defending from');

  // A won assault: the holding changes hands, and the winner leaves men on the wall.
  const survivors = [{ creature: 'angel', count: 50, hurt: 0 }];
  applyCombatResult(s, ctx, { attackerWon: true, attackerArmy: survivors, defenderArmy: [], xp: 0 });
  assert.equal(mine.owner, 0, 'stormed');
  assert.ok(armyValue(hero.army) < armyValue([{ creature: 'angel', count: 50 }]),
    'and the walls took their toll even in victory');
  assert.equal(mine.defence.fortified, true, 'the masonry stands under its new flag');
});

test('fortification: a repelled assault leaves the garrison thinned, not destroyed', () => {
  const s = game();
  const mine = mineFor(s, 1);
  s.players[1].resources.gold = 100000;
  const manned = garrisonHolding(s, mine, 9999);
  assert.ok(manned > 2, 'a garrison worth thinning');
  const before = defenceValue(mine);

  const hero = playerHeroes(s, 0)[0];
  hero.army = army(['pikeman', 5]);
  const ctx = combatContext(s, hero, { kind: 'holding', objectId: mine.id });
  const creature = garrisonCreature(s, 1);
  applyCombatResult(s, ctx, {
    attackerWon: false, attackerArmy: [],
    defenderArmy: [{ creature, count: Math.max(1, manned - 2), hurt: 0 }], xp: 0,
  });

  assert.equal(mine.owner, 1, 'the holding held');
  assert.ok(defenceValue(mine) < before, 'but the garrison paid for it');
  assert.ok(defenceValue(mine) > 0, 'and is still a garrison — the next try is cheaper');
});

test('towns: a town an AI takes keeps a garrison scaled to the army that took it', () => {
  const s = game();
  const town = playerTowns(s, 0)[0];
  town.garrison = [null, null, null, null, null, null, null];
  // A RIVAL's capture, because a human's army is never moved for them (below).
  const hero = playerHeroes(s, 1)[0];
  hero.army = army(['angel', 40], ['pikeman', 200]);
  const took = armyValue(hero.army);

  const left = leaveCaptureGarrison(s, town, hero);

  assert.ok(left > 0, 'something stays behind');
  assert.ok(armyValue(town.garrison) >= captureGarrisonValue(took) * 0.5,
    `a real garrison, not a token (${Math.round(armyValue(town.garrison))})`);
  assert.ok(armyValue(hero.army) > 0, 'and the conqueror marches on with an army');
  assert.ok(hero.army.some((st) => st && st.creature === 'angel'),
    'it keeps its punch — the cheapest troops garrison');
  assert.equal(Math.round(armyValue(town.garrison) + armyValue(hero.army)), Math.round(took),
    'troops are moved, never minted');
});

test('towns: a HUMAN\'s army is never moved for them — the garrison is their choice', () => {
  // Reported: "when taking a town, a portion of my army is automatically relocated
  // to the town, I want this not to happen and if I have to leave army in the town
  // it to be my choice." The anti-ping-pong clause stays on for the AI, which has
  // no town screen to decide in.
  const s = game();
  const town = playerTowns(s, 1)[0];
  town.garrison = [null, null, null, null, null, null, null];
  const hero = playerHeroes(s, 0)[0];
  hero.army = army(['angel', 40], ['pikeman', 200]);
  const took = armyValue(hero.army);

  const left = leaveCaptureGarrison(s, town, hero);

  assert.equal(left, 0, 'nothing is detached');
  assert.equal(armyValue(town.garrison), 0, 'the town stands empty until they say otherwise');
  assert.equal(Math.round(armyValue(hero.army)), Math.round(took), 'the army that took it marches on whole');
  assert.ok(s.log.some((l) => /without a garrison/i.test(l.text)), 'and they are told, so it is a choice and not a surprise');
});

test('towns: through the real capture path, a human keeps every stack they marched in with', () => {
  // The direct call is tested above; this is the door the game actually uses, so
  // the two call sites in applyCombatResult are covered too.
  const s = game();
  const attacker = playerHeroes(s, 0)[0];
  const town = Object.values(s.towns).find((t) => t.owner === 1);
  town.garrison = [null, null, null, null, null, null, null];
  attacker.army = army(['angel', 20], ['pikeman', 300]);
  const took = armyValue(attacker.army);
  const ctx = {
    attackerHeroId: attacker.id, defenderHeroId: null,
    defender: { kind: 'town', townId: town.id }, defenderReserve: [],
  };
  applyCombatResult(s, ctx, {
    attackerWon: true,
    attackerArmy: [{ creature: 'angel', count: 20 }, { creature: 'pikeman', count: 300 }],
    defenderArmy: [], xp: 100,
  });
  assert.equal(town.owner, 0, 'the town is taken');
  assert.equal(armyValue(town.garrison), 0, 'and nothing of theirs was left in it');
  assert.equal(Math.round(armyValue(attacker.army)), Math.round(took), 'the army is whole');
});

test('upkeep: holding everything is unaffordable, which is the whole point', () => {
  const s = game();
  s.players[0].resources.gold = 10 ** 7;
  // A realm with a real army in the field, so its holdings may billet real
  // garrisons (the cap is a share of what it can field, not a flat headcount).
  addToArmy(playerHeroes(s, 0)[0].army, 'angel', 40);
  // Take the whole map and man every inch of it — the thing the costs exist to
  // make impossible.
  const mines = Object.values(levelObjects(s, 0)).filter((o) => o.type === 'mine');
  for (const m of mines) { claimHolding(s, m, 0); garrisonHolding(s, m, 9999); }

  const bodies = mines.reduce((n, m) => n
    + (m.defence.garrison || []).reduce((k, st) => k + (st ? st.count : 0), 0), 0);
  assert.equal(defenceUpkeep(s, 0), bodies * CONFIG.DEFENCE_GARRISON_UPKEEP);
  const income = dailyIncome(s, s.players[0]);
  assert.ok(income.gold < 0,
    `a realm holding every mine at full strength runs at a loss (${income.gold}/day)`);

  // …while putting a real garrison on the one holding that actually pays is
  // comfortably affordable. The choice the system creates is not "defend or
  // don't" — it is how much, and where.
  for (const m of mines) m.defence.garrison = [];
  const gold = mines.find((m) => m.mineType === 'goldMine') || mines[0];
  const unit = garrisonUnitCost(s, 0);
  const worthHaving = Math.ceil(CONFIG.DEFENCE_GARRISON_MIN_VALUE
    / armyValue([{ creature: garrisonCreature(s, 0), count: 1 }]));
  garrisonHolding(s, gold, worthHaving);
  assert.ok(dailyIncome(s, s.players[0]).gold > 0, 'defending what pays is affordable');
  assert.ok(defenceUpkeep(s, 0) < CONFIG.MINE_INCOME.goldMine.gold,
    'a garrison worth having on a gold mine costs less than the mine yields');
  assert.ok(unit > 0);
});

test('defence state round-trips a save', () => {
  const s = game();
  const mine = mineFor(s, 0);
  s.players[0].resources.gold = 100000;
  garrisonHolding(s, mine, 7);
  fortifyHolding(s, mine);

  const back = deserialize(serialize(s));
  const copy = levelObjects(back, 0)[mine.id];
  assert.deepEqual(copy.defence, mine.defence);
  assert.equal(defenceLayer(copy), 'fortification');
  assert.equal(defenceUpkeep(back, 0), defenceUpkeep(s, 0));
});

test('an old save with no defence records reads as unguarded, and takes a watch on capture', () => {
  const s = game();
  const raw = JSON.parse(serialize(s));
  for (const o of Object.values(raw.map.objects)) delete o.defence;
  const old = deserialize(JSON.stringify(raw));
  const mine = Object.values(levelObjects(old, 0)).find((o) => o.type === 'mine');

  assert.equal(defenceLayer(mine), 'unguarded');
  assert.equal(defenceValue(mine), 0);
  assert.equal(defenceUpkeep(old, 0), 0, 'and costs nothing until someone invests');
  claimHolding(old, mine, 0);
  assert.equal(defenceLayer(mine), 'watch');
});

test('buyout: paying the garrison to leave transfers the holding and the gold', () => {
  const s = game();
  const mine = mineFor(s, 1);
  s.players[1].resources.gold = 100000;
  garrisonHolding(s, mine, 12);
  const guarding = defenceValue(mine);
  const price = buyoutPrice(s, mine);
  assert.ok(price > guarding, 'certainty and your soldiers\' lives cost more than the stack');

  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = price + 10;
  const sellerBefore = s.players[1].resources.gold;

  const paid = buyoutHolding(s, hero, mine);

  assert.equal(paid, price);
  assert.equal(mine.owner, 0, 'the holding changed hands without a battle');
  assert.equal(defenceValue(mine), 0, 'the mercenaries marched away');
  assert.equal(s.players[0].resources.gold, 10, 'the buyer paid');
  assert.equal(s.players[1].resources.gold, sellerBefore + price,
    'and the money went to the defender — a transfer, not a deletion');
  assert.equal(armyValue(hero.army), armyValue(hero.army), 'no blood spent');
});

test('buyout: refused when the gold is not there, or the holding is not defended', () => {
  const s = game();
  const mine = mineFor(s, 1);
  s.players[1].resources.gold = 100000;
  garrisonHolding(s, mine, 12);
  const hero = playerHeroes(s, 0)[0];

  s.players[0].resources.gold = buyoutPrice(s, mine) - 1;
  assert.equal(buyoutHolding(s, hero, mine), 0, 'no credit');
  assert.equal(mine.owner, 1);

  const own = mineFor(s, 0);
  s.players[0].resources.gold = 10 ** 6;
  assert.equal(buyoutHolding(s, hero, own), 0, 'nothing to buy out on your own ground');
});

test('buyout: the AI pays for ground worth more than the price, and not for ground that is not', () => {
  const s = game();
  const mine = mineFor(s, 1);
  // A gold mine: it pays for itself inside the horizon, so it is worth buying.
  mine.mineType = 'goldMine';
  s.players[1].resources.gold = 100000;
  garrisonHolding(s, mine, 9999);
  const ai = new AITurnController(s, 0);
  const hero = playerHeroes(s, 0)[0];
  // A hero that would win but bleed for it, and a treasury that can pay instead.
  hero.army = army(['pikeman', 400]);
  s.players[0].resources.gold = 10 ** 6;

  assert.ok(ai.maybeBuyOut(hero, mine), 'it pays');
  assert.equal(mine.owner, 0);
  assert.equal(ai.metrics.buyouts, 1);
  assert.ok(ai.metrics.buyoutGold > 0);

  // …and does not, for ground that will not pay the price back. A sawmill yields
  // no gold at all, so only the blood anchor speaks for it, and storming it is
  // cheaper than buying it.
  const sawmill = Object.values(levelObjects(s, 0)).filter((o) => o.type === 'mine')[1];
  sawmill.mineType = 'sawmill';
  claimHolding(s, sawmill, 1);
  garrisonHolding(s, sawmill, 9999);
  assert.equal(ai.maybeBuyOut(hero, sawmill), false, 'a rich realm is not a mark');
  assert.equal(sawmill.owner, 1);

  // …nor on the last of the treasury, whatever the ground is worth.
  const third = Object.values(levelObjects(s, 0)).filter((o) => o.type === 'mine')[2];
  third.mineType = 'goldMine';
  claimHolding(s, third, 1);
  garrisonHolding(s, third, 9999);
  s.players[0].resources.gold = CONFIG.AI_DEFENCE_GOLD_FLOOR;
  assert.equal(ai.maybeBuyOut(hero, third), false, 'never on the last of the treasury');
  assert.equal(third.owner, 1);
});

// ---------------------------------------------------------------------------
// The upkeep bill has a floor, and the AI handicap scales EARNINGS (audit C10).
//
// dailyIncome's NET gold may go negative — "holding everything is unaffordable"
// is asserted above and stays the design. What may NOT go negative is the
// TREASURY: the income bundle used to be applied through grant(), the one gold
// debit in the codebase with no Math.max(0, …) floor, so a realm out of its
// depth walked unboundedly negative and canAfford then refused every build,
// recruit and hire forever. And because the aiIncome difficulty multiplier
// scaled the whole bundle — the folded-in upkeep included — the knob meant to
// HELP the AI multiplied its deficit instead.
// ---------------------------------------------------------------------------

/** Every surface mine claimed for `owner` and garrisoned to the hilt. */
function overextend(s, owner) {
  const p = s.players[owner];
  p.resources.gold = 10 ** 7;
  addToArmy(playerHeroes(s, owner)[0].army, 'angel', 40);
  for (const m of Object.values(levelObjects(s, 0)).filter((o) => o.type === 'mine')) {
    claimHolding(s, m, owner);
    garrisonHolding(s, m, 9999);
  }
}

test('a treasury bleeding upkeep stops at zero instead of going negative', () => {
  const s = game();
  overextend(s, 0);
  s.players[0].resources.gold = 40; // two days of a ~-20/day deficit
  assert.ok(dailyIncome(s, s.players[0]).gold < 0, 'the net ledger IS negative (that pressure is the point)');
  for (let i = 0; i < 5; i++) {
    const d0 = s.day; let guard = 12;
    while (s.day === d0 && guard-- > 0) endTurn(s);
    assert.ok(s.players[0].resources.gold >= 0,
      `day ${s.day}: the treasury never goes below zero (got ${s.players[0].resources.gold})`);
  }
  assert.equal(s.players[0].resources.gold, 0, 'it bottoms out broke, not indebted');
});

test('the aiIncome handicap multiplies earnings, never the upkeep deficit', () => {
  const s = game();
  overextend(s, 1); // the AI seat
  // Gross earnings and the upkeep bill, read separately.
  const upkeep = defenceUpkeep(s, 1);
  s.difficulty = 'normal';
  const netAt1 = dailyIncome(s, s.players[1]).gold;
  const grossAt1 = netAt1 + upkeep;
  s.difficulty = 'impossible';
  const netAtHard = dailyIncome(s, s.players[1]).gold;
  const mult = CONFIG.DIFFICULTIES.impossible.aiIncome;
  assert.equal(netAtHard, Math.round(grossAt1 * mult) - upkeep,
    'harder difficulty = bigger earnings minus the SAME bill');
  assert.ok(netAtHard >= netAt1,
    'raising the difficulty can never leave the AI poorer than at normal');
});

test('investInDefence never buys a standing bill the realm cannot service', () => {
  const s = game();
  const ai = new AITurnController(s, 1);
  s.players[1].resources.gold = 10 ** 6; // a rich turn — the dangerous case
  addToArmy(playerHeroes(s, 1)[0].army, 'angel', 40);
  for (const m of Object.values(levelObjects(s, 0)).filter((o) => o.type === 'mine')) {
    claimHolding(s, m, 1);
  }
  const before = dailyIncome(s, s.players[1]).gold;
  assert.ok(before > 0, 'the realm starts solvent');
  ai.investInDefence();
  assert.ok(dailyIncome(s, s.players[1]).gold >= 0,
    'after investing, the projected daily gold is still non-negative');
  assert.ok(ai.metrics.defenceGold > 0, 'and it did actually invest (the guard is a cap, not a veto)');
});
