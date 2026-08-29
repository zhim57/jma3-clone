/**
 * transmute.js — the town "Altar of Transmutation": convert an army stack into
 * another creature the town can build, paying a power tax + a gold fee.
 *
 * A self-contained slice of the town-economy layer, split out like market.js:
 * actions.js re-exports it, so every importer is unchanged, and it depends only
 * on the game state, the creature data, config, and the GameState pay helpers —
 * never back on actions.js (no import cycle).
 *
 * The mechanic values creatures by their `aiValue` power score:
 *
 *     outCount = floor(inCount × aiValue(from) × EFFICIENCY / aiValue(to))
 *
 * EFFICIENCY < 1 (the "transmutation tax") guarantees you can never gain total
 * power, so the Altar reshapes an army's COMPOSITION — turning a horde of cheap
 * units into a few elites, or vice-versa — rather than minting strength. A gold
 * fee scaled by the output's power is charged on top. Only creatures the town
 * can currently recruit (its built dwellings) are valid targets, so an army's
 * ceiling still tracks the towns you develop.
 */

import { CONFIG } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { buildingCatalog } from '../data/buildings.js';
import { canAfford, pay } from './GameState.js';

/** True when the town has built the Altar of Transmutation. */
export function townHasAltar(town) {
  return !!town && (town.buildings || []).includes('altar');
}

/** The base / upgraded creature ids for a faction's tier (data-derived). */
function tierCreatures(faction, tier) {
  let base = null, upgraded = null;
  for (const [id, c] of Object.entries(CREATURES)) {
    if (c.faction !== faction || c.tier !== tier) continue;
    if (c.upgraded) upgraded = id; else base = id;
  }
  return { base, upgraded };
}

/**
 * The creature ids a town can transmute INTO: its TIER-2 creature, and nothing
 * else — Castle turns everything into Archers, Inferno into Gogs, and so on.
 * The upgraded form (Marksman, Magog) is offered only where that dwelling is
 * built, so the Altar can never hand out something the town cannot recruit.
 *
 * Deliberately narrow. Allowing any built dwelling's creature made the Altar a
 * universal converter — funnel a horde of peasants and out came Archangels,
 * which turned every surplus stack into top-tier troops and flattened the whole
 * recruitment economy. Fixing the output at tier 2 keeps the useful part (junk
 * and obsolete low-tier stacks become a usable, massable shooter) without letting
 * it mint elites. Empty if there is no Altar, or the tier-2 dwelling isn't built.
 */
export function transmuteTargets(town) {
  if (!townHasAltar(town)) return [];
  const catalog = buildingCatalog(town.faction);
  const { base, upgraded } = tierCreatures(town.faction, CONFIG.TRANSMUTE_TARGET_TIER);
  const out = [];
  for (const bid of town.buildings || []) {
    const b = catalog[bid];
    if (!b || b.dwellingTier !== CONFIG.TRANSMUTE_TARGET_TIER) continue;
    if (base && !out.includes(base)) out.push(base);
    if (b.dwellingUpgrade && upgraded && !out.includes(upgraded)) out.push(upgraded);
  }
  return out;
}

/**
 * Pure quote for transmuting `count` of `fromId` into `toId`. Returns
 * { ok, outCount, goldFee, inValue, outValue } — or { ok:false, reason } when
 * the trade can't produce even one target creature (or the ids are bad).
 * No state, no mutation: safe for previews.
 */
export function transmuteQuote(fromId, toId, count, have = count) {
  const from = CREATURES[fromId], to = CREATURES[toId];
  if (!from || !to) return { ok: false, reason: 'unknown creature' };
  if (fromId === toId) return { ok: false, reason: 'same creature' };
  const asked = Math.floor(count);
  if (!(asked > 0)) return { ok: false, reason: 'nothing to transmute' };
  const fromVal = (from.aiValue || 0), toVal = (to.aiValue || 0);
  if (!(fromVal > 0) || !(toVal > 0)) return { ok: false, reason: 'creature has no power value' };
  // THE ALTAR NEVER LEAVES A REMAINDER IT COULD NOT TRADE AGAIN.
  //
  // Reported: "331 creatures make 256 of the new ones, 334 make 257, and we have
  // 332 — so one remains". It came from asking the right question badly. The
  // dialog steps in whole units of the OUTPUT (transmuteInputFor), so "forge the
  // most you can" asks for the FEWEST source creatures that yield 256 — 331 of
  // your 332 — and the odd one is left behind in an army slot it can never leave,
  // because a single creature can never fund another target.
  //
  // So a leftover too small to ever be traded again is swept into the trade
  // instead, and the output is recomputed from what is actually consumed: if the
  // sweep happens to complete another whole target creature the player gets it,
  // and if it does not they get the slot back, which is what the remainder was
  // costing them. A leftover that CAN still be traded is never touched — asking
  // for half your stack still gives you half your stack.
  const n = sweptCount(fromId, toId, asked, have);
  const inValue = fromVal * n;
  const outCount = Math.floor((inValue * CONFIG.TRANSMUTE_EFFICIENCY) / toVal);
  if (outCount < 1) return { ok: false, reason: 'stack too small to transmute into even one' };
  const outValue = outCount * toVal;
  const goldFee = Math.ceil(outValue * CONFIG.TRANSMUTE_GOLD_PER_VALUE);
  return { ok: true, outCount, goldFee, inValue, outValue, consumed: n, swept: n - asked };
}

/**
 * The source count a trade actually takes: what was asked for, plus any leftover
 * too small to ever be traded again.
 *
 * `have` is the whole stack. Defaulting it to `count` makes a quote with no stack
 * behind it — a pure "what would N of these fetch" — behave exactly as it did.
 */
function sweptCount(fromId, toId, asked, have) {
  const stack = Math.floor(have);
  if (!(stack > asked)) return asked;
  const left = stack - asked;
  return left < transmuteMinInput(fromId, toId) ? stack : asked;
}

/**
 * Fewest source creatures needed to yield at least one `toId` (so the UI can
 * clamp/stepper sensibly and explain a too-small stack). Returns Infinity if
 * either creature is invalid.
 */
export function transmuteMinInput(fromId, toId) {
  return transmuteInputFor(fromId, toId, 1);
}

/**
 * Fewest source creatures whose transmute yields at least `outWant` of `toId` —
 * the inverse of the quote. Lets the UI step in whole units of the (pricier)
 * OUTPUT creature so a +1/+10 actually changes the result when many cheap units
 * fund each expensive one. Returns Infinity if either creature is invalid.
 */
export function transmuteInputFor(fromId, toId, outWant) {
  const from = CREATURES[fromId], to = CREATURES[toId];
  if (!from?.aiValue || !to?.aiValue) return Infinity;
  if (outWant <= 0) return 0;
  return Math.ceil((outWant * to.aiValue) / (from.aiValue * CONFIG.TRANSMUTE_EFFICIENCY));
}

/**
 * Transmute `count` (default: the whole stack) of the creature at `army[index]`
 * into `toId`, charging the gold fee. `army` is the garrison or a visiting
 * hero's army; both are valid from a town with an Altar. Fails (no mutation)
 * when: no Altar, an invalid target, a too-small stack, not enough gold, or no
 * army room for the result. Returns { ok, outCount, goldFee, from, to, consumed }.
 */
export function transmuteStack(state, town, army, index, toId, count) {
  if (!townHasAltar(town)) return { ok: false, reason: 'no altar' };
  const stack = army?.[index];
  if (!stack || stack.count <= 0) return { ok: false, reason: 'no stack' };
  if (!transmuteTargets(town).includes(toId)) return { ok: false, reason: 'town cannot build that creature' };

  const want = count == null ? stack.count : Math.min(Math.floor(count), stack.count);
  // The stack is passed so the quote can sweep a dead remainder in (see above);
  // `quote.consumed` is what actually leaves the slot, which is `want` or all of it.
  const quote = transmuteQuote(stack.creature, toId, want, stack.count);
  if (!quote.ok) return { ok: false, reason: quote.reason };

  const player = state.players[town.owner];
  const fee = { gold: quote.goldFee };
  if (!canAfford(player, fee)) return { ok: false, reason: 'not enough gold' };

  const fromId = stack.creature;
  // Free the source FIRST so a fully-consumed slot is available to the result,
  // then add. If the army has no room (partial consume, all slots full, no
  // matching target stack), roll the source back and bail — no gold spent.
  const before = stack.count;
  stack.count -= quote.consumed;
  if (stack.count <= 0) army[index] = null;
  if (!addToArmyLocal(army, toId, quote.outCount)) {
    army[index] = stack;          // restore the slot object …
    stack.count = before;         // … and its full count
    return { ok: false, reason: 'no room in the army for the result' };
  }
  pay(player, fee);
  return {
    ok: true, outCount: quote.outCount, goldFee: quote.goldFee,
    from: fromId, to: toId, consumed: quote.consumed, swept: quote.swept,
  };
}

// A local copy of the army-insert contract (heroUtils.addToArmy) kept here so
// this module stays a leaf that doesn't import back through the engine. Merges
// into a matching stack, else fills the first empty slot; false when full.
function addToArmyLocal(army, creatureId, count) {
  if (count <= 0) return true;
  for (const s of army) if (s && s.creature === creatureId) { s.count += count; return true; }
  for (let i = 0; i < army.length; i++) {
    if (!army[i] || army[i].count <= 0) { army[i] = { creature: creatureId, count, hurt: 0 }; return true; }
  }
  return false;
}
