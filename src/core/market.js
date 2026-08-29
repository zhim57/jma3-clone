/**
 * market.js — the town Marketplace: resource↔resource and resource↔gold trading,
 * with rates that improve as a player owns more marketplaces. A self-contained
 * slice of the town-economy layer split out of actions.js (which re-exports it,
 * so every importer is unchanged); it depends only on the game state, nothing
 * back in actions.js. Resource↔resource routes through gold value, paying both
 * spreads (like HoMM3).
 */

/**
 * Base (one-marketplace) exchange rates. Owning MORE marketplaces narrows the
 * spread in both directions (see marketSellRate/marketBuyRate), so the base is
 * the worst case. Kept as the AI's planning baseline. Simplified vs HoMM3.
 */
export const MARKET_RATES = {
  sell: { wood: 50, ore: 50, mercury: 150, sulfur: 150, crystal: 150, gems: 150 },
  buy: { wood: 200, ore: 200, mercury: 400, sulfur: 400, crystal: 400, gems: 400 },
};

/** Marketplaces this player owns — more of them mean better rates. */
export function marketplaceCount(state, player) {
  const idx = state.players.indexOf(player);
  return Object.values(state.towns)
    .filter((t) => t.owner === idx && (t.buildings || []).includes('marketplace')).length;
}

// Rate scaling with M = max(1, marketplaces): base at 1, approaching 2× better
// (in both directions) as M grows. sellMult 1→2, buyMult 1→0.5.
const sellMult = (M) => (2 * M) / (M + 1);
const buyMult = (M) => (M + 1) / (2 * M);

/** Gold received per unit of `res` sold (gold trades 1:1). */
export function marketSellRate(state, player, res) {
  if (res === 'gold') return 1;
  const M = Math.max(1, marketplaceCount(state, player));
  return Math.max(1, Math.round((MARKET_RATES.sell[res] || 0) * sellMult(M)));
}

/** Gold paid per unit of `res` bought (gold trades 1:1). */
export function marketBuyRate(state, player, res) {
  if (res === 'gold') return 1;
  const M = Math.max(1, marketplaceCount(state, player));
  return Math.max(1, Math.round((MARKET_RATES.buy[res] || 0) * buyMult(M)));
}

/** How many `getRes` you'd receive for `giveAmt` of `giveRes` (pure preview). */
export function marketQuote(state, player, giveRes, giveAmt, getRes) {
  if (giveRes === getRes || giveAmt <= 0) return 0;
  const gold = giveAmt * marketSellRate(state, player, giveRes);
  return Math.floor(gold / marketBuyRate(state, player, getRes));
}

/**
 * The MINIMUM `giveRes` you must spend to receive exactly `wantGet` units of
 * `getRes` — the inverse of marketQuote. Lets the marketplace UI step in whole
 * units of the pricier resource (each +1 buys one more `getRes`) rather than
 * nudging the cheaper side many times. When `getRes` is the dearer good (the
 * only case the UI uses this), spending exactly this much yields exactly
 * `wantGet` back with no overpay. Returns 0 for a non-trade.
 */
export function marketGiveForGet(state, player, giveRes, getRes, wantGet) {
  if (giveRes === getRes || wantGet <= 0) return 0;
  const S = marketSellRate(state, player, giveRes);
  const B = marketBuyRate(state, player, getRes);
  return Math.ceil((wantGet * B) / Math.max(1, S));
}

/**
 * Trade `giveAmt` of `giveRes` for as much `getRes` as the rate allows — any
 * resource or gold for any other (resource↔resource routes through gold value,
 * so it pays both spreads, like HoMM3). Returns { ok, given, received }.
 */
export function marketExchange(state, player, giveRes, giveAmt, getRes) {
  if (giveRes === getRes || giveAmt <= 0) return { ok: false };
  if ((player.resources[giveRes] || 0) < giveAmt) return { ok: false, reason: 'not enough to trade' };
  const received = marketQuote(state, player, giveRes, giveAmt, getRes);
  if (received <= 0) return { ok: false, reason: 'trade too small for a single unit' };
  player.resources[giveRes] -= giveAmt;
  player.resources[getRes] = (player.resources[getRes] || 0) + received;
  return { ok: true, given: giveAmt, received };
}

/** Back-compat helper (used by the AI): sell/buy `amount` of a resource for gold. */
export function marketTrade(state, player, mode, resource, amount) {
  if (resource === 'gold' || amount <= 0) return false;
  if (mode === 'sell') return marketExchange(state, player, resource, amount, 'gold').ok;
  const cost = marketBuyRate(state, player, resource) * amount;
  return marketExchange(state, player, 'gold', cost, resource).ok;
}
