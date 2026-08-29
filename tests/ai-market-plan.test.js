/**
 * ai-market-plan.test.js — the AI's market planner prices trades at the SAME
 * (marketplace-scaled) rate the engine executes at (2026-07 repo review, B13).
 *
 * planCoverCost / tryCoverCost sized their sells with the static base
 * MARKET_RATES, but marketTrade executes at a rate that improves with the number
 * of marketplaces owned (up to 2× at high count). So the planner under-valued
 * its own sells and dumped up to 2× the resources actually needed. This test
 * gives the AI two marketplaces and checks it sells the MINIMAL amount at the
 * scaled rate, not the larger base-rate amount.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerTowns } from '../src/core/GameState.js';
import { marketSellRate } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1;

test('market planner sells the minimal amount at the marketplace-scaled rate (B13)', () => {
  const state = newGame({
    seed: 4242,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  // Two AI marketplaces → sellMult(2) = 4/3, so wood sells at round(50·4/3)=67.
  const town = playerTowns(state, AI)[0];
  if (!town.buildings.includes('marketplace')) town.buildings.push('marketplace');
  state.towns.Tmkt = { id: 'Tmkt', owner: AI, buildings: ['marketplace'] };

  const player = state.players[AI];
  player.resources = { gold: 0, wood: 1000, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 0 };

  const rate = marketSellRate(state, player, 'wood');
  assert.equal(rate, 67, 'two marketplaces lift the wood sell rate above the base 50');

  const ai = new AITurnController(state, AI);
  const cost = { gold: 1000 }; // goldShort = cost.gold + GOLD_RESERVE(1000) = 2000
  assert.equal(ai.canCoverCost(cost), true, 'the plan is feasible');

  const woodBefore = player.resources.wood;
  assert.equal(ai.tryCoverCost(cost), true, 'the cost is covered');
  const woodSpent = woodBefore - player.resources.wood;

  const goldShort = cost.gold + 1000; // + GOLD_RESERVE
  assert.ok(woodSpent * rate >= goldShort, 'raised enough to cover cost + reserve');
  // The killer: at the SCALED rate the minimal sell is ceil(2000/67)=30 units;
  // the old base-rate planner sold ceil(2000/50)=40 and over-raised. Require the
  // proceeds to land within one wood-unit of the target — 40 units (2680 gold)
  // fails this, 30 units (2010 gold) passes.
  assert.ok(woodSpent * rate < goldShort + rate, 'no oversell: sold the minimal amount, not the base-rate amount');
  assert.equal(woodSpent, 30, 'exactly ceil(2000 / 67) units');
});
