/**
 * town-bank.test.js — #17 (opt-in): collateralized loans to rush a build.
 *
 * loanQuote (principal + interest split weekly), takeLoan (build now on the bank's
 * gold, record a secured debt), and tickDebts — installments that repay a loan or,
 * on a missed payment, DEFAULT by repossessing the very building it financed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerTowns } from '../src/core/GameState.js';
import { loanQuote, loanableBuildings, takeLoan, tickDebts } from '../src/core/actions.js';

// A castle town with the whole hall/fort spine + a Bank, so the Capitol (10000
// gold, onePerPlayer) is buildable except for the gold.
function bankTown(features = { townBank: true }) {
  const s = newGame({ seed: 4242, features });
  const town = playerTowns(s, 0)[0];
  town.buildings = ['villageHall', 'tavern', 'townHall', 'marketplace', 'blacksmith', 'mageGuild1', 'cityHall', 'fort', 'citadel', 'castle', 'bank'];
  town.builtToday = false;
  s.players[0].resources.gold = 500; // can't afford the 10000-gold Capitol outright
  return { s, town };
}

test('loanQuote: principal + interest, split into weekly installments', () => {
  const { town } = bankTown();
  const q = loanQuote(town, 'capitol');
  assert.equal(q.principal, 10000);
  assert.equal(q.owed, Math.round(10000 * (1 + CONFIG.BANK_INTEREST)));
  assert.equal(q.weekly, Math.ceil(q.owed / CONFIG.BANK_WEEKS));
});

test('takeLoan: finances the Capitol now and records a secured debt', () => {
  const { s, town } = bankTown();
  assert.ok(loanableBuildings(s, town).includes('capitol'));
  const res = takeLoan(s, town, 'capitol');
  assert.equal(res.ok, true);
  assert.ok(town.buildings.includes('capitol'), 'raised now on the loan');
  assert.equal(town.builtToday, true, 'counts as the town\'s build for the day');
  assert.equal(s.debts.length, 1);
  assert.equal(s.debts[0].collateralBuilding, 'capitol');
});

test('takeLoan: blocked without the feature (or the bank)', () => {
  const off = bankTown({});
  assert.equal(takeLoan(off.s, off.town, 'capitol').ok, false);
  assert.equal(loanableBuildings(off.s, off.town).length, 0);
});

test('tickDebts: installments repay the loan, then it clears (building kept)', () => {
  const { s, town } = bankTown();
  takeLoan(s, town, 'capitol');
  s.players[0].resources.gold = 100000;
  for (let i = 0; i < CONFIG.BANK_WEEKS; i++) tickDebts(s);
  assert.equal(s.debts.length, 0, 'loan fully repaid and cleared');
  assert.ok(town.buildings.includes('capitol'), 'the building stays yours');
});

test('tickDebts: a missed payment defaults — the bank repossesses the building', () => {
  const { s, town } = bankTown();
  takeLoan(s, town, 'capitol');
  s.players[0].resources.gold = 0; // can't make the installment
  tickDebts(s);
  assert.equal(s.debts.length, 0, 'debt cancelled on default');
  assert.ok(!town.buildings.includes('capitol'), 'the Capitol is repossessed');
});

/**
 * The AI's side of the bank. For the whole of #17 the lending half was live
 * only for the human — AIPlayer never called takeLoan, so half the feature was
 * dead code from the AI's point of view. It now borrows toward its Capitol.
 */
test('the AI finances a blocked priority build, but only until it has a Capitol', async () => {
  const { AITurnController } = await import('../src/ai/AIPlayer.js');
  const { s, town } = bankTown();
  town.owner = 1;                       // an AI realm
  // The AI raises ONE building a day and works down its priority order, so the
  // Capitol only comes up for financing once the cheaper entries above it are
  // standing. Put them up, which is where a real realm is by the time this
  // matters.
  town.buildings.push('dwelling1', 'dwelling2', 'dwelling3', 'dwelling4', 'dwelling5',
    'dwelling6', 'stables', 'shipyard', 'resourceSilo', 'dwelling2u', 'dwelling4u');
  s.players[1].resources.gold = 500;    // nowhere near the Capitol's 10,000
  const ai = new AITurnController(s, 1);

  ai.buildBest(town);
  assert.ok(town.buildings.includes('capitol'), 'it borrowed to raise the Capitol');
  const debt = (s.debts || []).find((d) => d.collateralBuilding === 'capitol');
  assert.ok(debt, 'and recorded the secured debt against it');
  assert.equal(debt.player, 1);
  assert.equal(debt.weekly, Math.ceil(debt.owed / CONFIG.BANK_WEEKS));

  // Having the Capitol, it stops borrowing — measured: borrowing beyond it
  // doubled the interest bill and bought no day-150 army value at all.
  town.builtToday = false;
  const before = (s.debts || []).length;
  ai.buildBest(town);
  assert.equal((s.debts || []).length, before, 'no further loans once the Capitol stands');
});

test('the AI does not borrow when the bank feature is off', async () => {
  // Byte-identity discipline: a game without townBank must behave exactly as
  // before, drawing nothing and taking no loans.
  const { AITurnController } = await import('../src/ai/AIPlayer.js');
  const { s, town } = bankTown({ townBank: false });
  town.owner = 1;
  s.players[1].resources.gold = 500;
  new AITurnController(s, 1).buildBest(town);
  assert.equal((s.debts || []).length, 0, 'no debt without the feature');
  assert.ok(!town.buildings.includes('capitol'), 'and the Capitol stays unaffordable');
});

test('a longer term shrinks the installment without changing what is owed', async () => {
  // The fix for the Capitol-repossession failure mode: same total, smaller bite.
  const { town } = bankTown();
  const q = loanQuote(town, 'capitol');
  assert.equal(q.owed, Math.round(10000 * (1 + CONFIG.BANK_INTEREST)), 'total owed is the interest rule, not the term');
  assert.equal(q.weeks, CONFIG.BANK_WEEKS);
  assert.ok(q.weekly * CONFIG.BANK_WEEKS >= q.owed, 'the installments cover the debt');
  assert.ok(CONFIG.BANK_WEEKS >= 8, 'and the term is long enough that servicing it is not a coin flip');
});
