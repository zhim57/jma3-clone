/**
 * economy.test.js — Headless tests for the daily/weekly economy engine.
 *
 * Covers daily income (halls, resource silo, mines, hero estates), weekly
 * creature growth (with the Citadel/Castle multipliers) and the "lost all
 * towns" starvation defeat. Pure rule-engine — no Phaser. Run with: npm test
 *
 * All expected numbers are read from the same data the engine reads (config /
 * buildings / creatures / skills), so the assertions track any future retune.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { COMMON_BUILDINGS, buildingCatalog } from '../src/data/buildings.js';
import { skillValue } from '../src/data/skills.js';
import { newGame, playerTowns, playerHeroes, pay } from '../src/core/GameState.js';
import { endTurn, dailyIncome, weeklyCreatureGrowth } from '../src/core/actions.js';

const SEED = 12345;

function freshGame() {
  return newGame({ seed: SEED });
}

/** Two endTurns advance one day (2 players); a full week is 2*DAYS_PER_WEEK. */
function runWeek(state) {
  for (let i = 0; i < 2 * CONFIG.DAYS_PER_WEEK; i++) endTurn(state);
}

// ---------------------------------------------------------------------------

test('economy: only the highest hall in the line pays daily gold', () => {
  const s = freshGame();
  const town = playerTowns(s, 0)[0];
  // Starting hero (Orrin) has no Estates and no gold artifacts, and the map's
  // mines start neutral — so hall income is the whole gold figure at day 1.
  assert.deepEqual(town.buildings.filter((b) => b === 'townHall'), []);
  assert.equal(dailyIncome(s, s.players[0]).gold, COMMON_BUILDINGS.villageHall.income.gold);

  // Building up the hall line: dailyIncome takes ONLY the best hall, never a sum.
  town.buildings.push('townHall');
  assert.equal(dailyIncome(s, s.players[0]).gold, COMMON_BUILDINGS.townHall.income.gold);
  town.buildings.push('cityHall');
  assert.equal(dailyIncome(s, s.players[0]).gold, COMMON_BUILDINGS.cityHall.income.gold);
  town.buildings.push('capitol');
  assert.equal(dailyIncome(s, s.players[0]).gold, COMMON_BUILDINGS.capitol.income.gold);
});

test('economy: resource silo adds the faction-specific resources', () => {
  const s = freshGame();
  const town = playerTowns(s, 0)[0];
  const before = dailyIncome(s, s.players[0]);
  town.buildings.push('resourceSilo');
  const after = dailyIncome(s, s.players[0]);
  const silo = buildingCatalog(town.faction).resourceSilo.factionIncome[town.faction]; // castle: {wood:1, ore:1}
  for (const [res, amt] of Object.entries(silo)) {
    assert.equal((after[res] || 0) - (before[res] || 0), amt, `silo grants ${res}`);
  }
});

test('economy: a flagged mine contributes exactly its MINE_INCOME', () => {
  const s = freshGame();
  // Map mines start neutral (owner -1); pin that so the baseline has no mine gold.
  for (const o of Object.values(s.map.objects)) if (o.type === 'mine') o.owner = -1;
  const base = dailyIncome(s, s.players[0]);

  const goldMine = Object.values(s.map.objects).find((o) => o.type === 'mine' && o.mineType === 'goldMine');
  assert.ok(goldMine, 'map has a gold mine to flag');
  goldMine.owner = 0;
  const withGold = dailyIncome(s, s.players[0]);
  assert.equal((withGold.gold || 0) - (base.gold || 0), CONFIG.MINE_INCOME.goldMine.gold);

  // A raw-resource mine feeds its own resource channel, not gold.
  const sawmill = Object.values(s.map.objects).find((o) => o.type === 'mine' && o.mineType === 'sawmill');
  assert.ok(sawmill, 'map has a sawmill to flag');
  const beforeWood = withGold.wood || 0;
  sawmill.owner = 0;
  const withWood = dailyIncome(s, s.players[0]);
  assert.equal((withWood.wood || 0) - beforeWood, CONFIG.MINE_INCOME.sawmill.wood);
});

test('economy: hero Estates skill pays gold into the treasury daily', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  const before = dailyIncome(s, s.players[0]).gold || 0;
  hero.skills.estates = 2; // Advanced Estates
  const after = dailyIncome(s, s.players[0]).gold || 0;
  assert.equal(after - before, skillValue(hero, 'estates'));

  // Pin the per-level values to the HoMM3 curve (regression: Expert was 500).
  hero.skills.estates = 1;
  assert.equal(skillValue(hero, 'estates'), 125, 'Basic Estates');
  hero.skills.estates = 2;
  assert.equal(skillValue(hero, 'estates'), 250, 'Advanced Estates');
  hero.skills.estates = 3;
  assert.equal(skillValue(hero, 'estates'), 350, 'Expert Estates');
});

test('economy: weekly creature growth scales with Citadel/Castle', () => {
  const base = CREATURES.pikeman.growth; // castle tier-1 base dwelling stock
  // Growth also depends on the week event rolled at the rollover; fold that in
  // via the same helper the engine uses so the multiplier assertion is exact.
  const expected = (fortMult, ev) => weeklyCreatureGrowth(base, fortMult, ev, 'pikeman');

  // No fort-upgrade multiplier: the starting town has only Fort → x1.
  const plain = freshGame();
  const pt = playerTowns(plain, 0)[0];
  const p0 = pt.available[1];
  runWeek(plain);
  assert.equal(plain.day, 1 + CONFIG.DAYS_PER_WEEK, 'exactly one week elapsed');
  assert.equal(pt.available[1] - p0, expected(1, plain.weekEvent), 'x1 weekly growth');

  // Citadel → x1.5 (floored).
  const cita = freshGame();
  const ct = playerTowns(cita, 0)[0];
  ct.buildings.push('citadel');
  const c0 = ct.available[1];
  runWeek(cita);
  assert.equal(ct.available[1] - c0, expected(CONFIG.GROWTH_CITADEL_MULT, cita.weekEvent));

  // Castle → x2 (takes priority over Citadel if both are present).
  const cas = freshGame();
  const at = playerTowns(cas, 0)[0];
  at.buildings.push('castle');
  const a0 = at.available[1];
  runWeek(cas);
  assert.equal(at.available[1] - a0, expected(CONFIG.GROWTH_CASTLE_MULT, cas.weekEvent));
});

test('economy: losing every town starves a player into defeat after a full week', () => {
  const s = freshGame();
  const p0 = s.players[0];
  // Strip player 0's towns; their hero keeps them alive (no instant defeat)
  // while the daysWithoutTown clock runs.
  for (const t of playerTowns(s, 0)) delete s.towns[t.id];
  assert.ok(playerHeroes(s, 0).length > 0, 'still has a hero, so not instantly defeated');
  assert.equal(s.currentPlayer, 0);

  let guard = 100;
  let survivedFullWeek = false;
  while (s.winner === null && guard-- > 0) {
    endTurn(s);
    // A whole week (DAYS_PER_WEEK) without a town is tolerated; defeat is strictly after.
    if (!p0.defeated && p0.daysWithoutTown === CONFIG.DAYS_PER_WEEK) survivedFullWeek = true;
  }
  assert.ok(guard > 0, 'no infinite loop');
  assert.ok(survivedFullWeek, 'player is alive at exactly a full week without a town');
  assert.equal(p0.defeated, true);
  assert.equal(p0.daysWithoutTown, CONFIG.DAYS_PER_WEEK + 1, 'defeat fires the day the clock passes a week');
  assert.equal(s.winner, 1, 'the surviving player wins');
});

test('economy: spending past your reserves is not clamped (no negative-gold rule)', () => {
  // There is no "bankruptcy" penalty in the engine — pay() just subtracts.
  // Overspend is prevented upstream by canAfford guards, never by pay() itself.
  const s = freshGame();
  const p = s.players[0];
  p.resources.gold = 100;
  pay(p, { gold: 250 });
  assert.equal(p.resources.gold, -150);
});
