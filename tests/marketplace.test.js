/**
 * marketplace.test.js — resource↔resource trading + marketplace-count rate scaling.
 * The one-marketplace rates stay identical to the old fixed table (no regression);
 * owning more marketplaces narrows the spread in both directions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerTowns } from '../src/core/GameState.js';
import {
  marketplaceCount, marketSellRate, marketBuyRate, marketQuote, marketGiveForGet,
  marketExchange, marketTrade, MARKET_RATES,
} from '../src/core/actions.js';

function giveMarkets(s, owner, n) {
  const towns = Object.values(s.towns).filter((t) => t.owner === owner);
  for (let i = 0; i < n && i < towns.length; i++) {
    if (!towns[i].buildings.includes('marketplace')) towns[i].buildings.push('marketplace');
  }
}

test('marketplaceCount reflects built marketplaces', () => {
  const s = newGame({ seed: 3 });
  const p = s.players[0];
  assert.equal(marketplaceCount(s, p), 0);
  playerTowns(s, 0)[0].buildings.push('marketplace');
  assert.equal(marketplaceCount(s, p), 1);
});

test('one marketplace = the classic fixed rates (no regression)', () => {
  const s = newGame({ seed: 3 });
  const p = s.players[0];
  giveMarkets(s, 0, 1);
  for (const r of ['wood', 'ore', 'mercury', 'sulfur', 'crystal', 'gems']) {
    assert.equal(marketSellRate(s, p, r), MARKET_RATES.sell[r], `${r} sell @1`);
    assert.equal(marketBuyRate(s, p, r), MARKET_RATES.buy[r], `${r} buy @1`);
  }
  assert.equal(marketSellRate(s, p, 'gold'), 1);
  assert.equal(marketBuyRate(s, p, 'gold'), 1);
});

test('more marketplaces narrow the spread (better sell + buy)', () => {
  const s = newGame({ seed: 3, mapW: 96, mapH: 80 }); // a big map has spare towns
  const p = s.players[0];
  // Flag a few neutral towns to player 0 so it owns several marketplaces.
  const towns = Object.values(s.towns);
  let owned = towns.filter((t) => t.owner === 0);
  for (const t of towns) { if (owned.length >= 3) break; if (t.owner !== 0) { t.owner = 0; owned.push(t); } }
  giveMarkets(s, 0, 3);
  assert.equal(marketplaceCount(s, p), 3);
  assert.ok(marketSellRate(s, p, 'wood') > MARKET_RATES.sell.wood, 'sell improves');
  assert.ok(marketBuyRate(s, p, 'wood') < MARKET_RATES.buy.wood, 'buy improves');
});

test('marketExchange: resource → resource routes through gold value', () => {
  const s = newGame({ seed: 3 });
  const p = s.players[0];
  giveMarkets(s, 0, 1);
  p.resources.wood = 300; p.resources.gems = 0;
  const quote = marketQuote(s, p, 'wood', 200, 'gems'); // 200*50 / 400 = 25
  assert.equal(quote, 25);
  const r = marketExchange(s, p, 'wood', 200, 'gems');
  assert.equal(r.ok, true);
  assert.equal(r.received, 25);
  assert.equal(p.resources.wood, 100, 'gave 200 wood');
  assert.equal(p.resources.gems, 25, 'got 25 gems');
});

test('marketExchange: gold↔resource both directions; guards', () => {
  const s = newGame({ seed: 3 });
  const p = s.players[0];
  giveMarkets(s, 0, 1);
  p.resources.gold = 1000; p.resources.ore = 0;
  // buy ore with gold: 400 gold → 2 ore (200 each)
  const buy = marketExchange(s, p, 'gold', 400, 'ore');
  assert.equal(buy.ok, true); assert.equal(buy.received, 2);
  assert.equal(p.resources.gold, 600); assert.equal(p.resources.ore, 2);
  // sell ore for gold
  const sell = marketExchange(s, p, 'ore', 2, 'gold');
  assert.equal(sell.ok, true); assert.equal(sell.received, 2 * 50);
  // guards
  assert.equal(marketExchange(s, p, 'wood', 0, 'gold').ok, false, 'zero amount');
  assert.equal(marketExchange(s, p, 'wood', 5, 'wood').ok, false, 'same resource');
  p.resources.wood = 1;
  assert.equal(marketExchange(s, p, 'wood', 5, 'gold').ok, false, 'not enough to give');
});

test('marketGiveForGet: minimal give buys EXACTLY n of the pricier resource', () => {
  // The stepper counts the dearer good; each +1 must buy one more unit with no
  // overpay. Cover 1 & 3 marketplaces (different spreads) across cheap→dear pairs.
  const s = newGame({ seed: 3, mapW: 96, mapH: 80 });
  const p = s.players[0];
  const towns = Object.values(s.towns);
  let owned = towns.filter((t) => t.owner === 0);
  for (const t of towns) { if (owned.length >= 3) break; if (t.owner !== 0) { t.owner = 0; owned.push(t); } }
  for (const t of owned) if (!t.buildings.includes('marketplace')) t.buildings.push('marketplace');

  for (const M of [1, 3]) {
    // Rebuild marketplace ownership to hit exactly M.
    for (const t of owned) t.buildings = t.buildings.filter((b) => b !== 'marketplace');
    for (let i = 0; i < M; i++) owned[i].buildings.push('marketplace');
    assert.equal(marketplaceCount(s, p), M);
    for (const [give, get] of [['gold', 'gems'], ['ore', 'gems'], ['wood', 'crystal'], ['gold', 'ore']]) {
      for (const want of [1, 2, 5, 13]) {
        const g = marketGiveForGet(s, p, give, get, want);
        assert.equal(marketQuote(s, p, give, g, get), want,
          `M=${M} ${g} ${give} → exactly ${want} ${get}`);
        // Minimality: one less unit of give must fall short of `want`.
        assert.ok(marketQuote(s, p, give, g - 1, get) < want,
          `M=${M} ${give}→${get}: ${g} is the minimum for ${want}`);
      }
    }
  }
});

test('marketGiveForGet: guards (same resource, non-positive want) return 0', () => {
  const s = newGame({ seed: 3 });
  const p = s.players[0];
  playerTowns(s, 0)[0].buildings.push('marketplace');
  assert.equal(marketGiveForGet(s, p, 'gems', 'gems', 4), 0, 'same resource');
  assert.equal(marketGiveForGet(s, p, 'gold', 'gems', 0), 0, 'zero want');
  assert.equal(marketGiveForGet(s, p, 'gold', 'gems', -3), 0, 'negative want');
});

test('marketTrade back-compat: sell/buy for gold still works at base rates', () => {
  const s = newGame({ seed: 3 });
  const p = s.players[0];
  giveMarkets(s, 0, 1);
  p.resources.wood = 10; p.resources.gold = 1000;
  assert.equal(marketTrade(s, p, 'sell', 'wood', 5), true);
  assert.equal(p.resources.gold, 1000 + 5 * 50);
  assert.equal(marketTrade(s, p, 'buy', 'ore', 1), true);
});
