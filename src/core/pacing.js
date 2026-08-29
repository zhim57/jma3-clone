/**
 * pacing.js — the opt-in "Tide of War" pacing preset (Phase C).
 *
 * A single seam every Phase-C growth-system feature branches on, so the base
 * game ('classic') stays byte-identical when the preset is off. The chosen
 * preset lives on `state.pacing` (set in newGame, round-tripped through saves);
 * this module resolves it into simple predicates the engine can read.
 */
import { CONFIG } from '../config.js';

/** The resolved pacing-preset descriptor for a game (never null — unknown or
 *  absent values fall back to the default 'classic' preset). */
export function pacingPreset(state) {
  const id = state && state.pacing;
  return CONFIG.PACING[id] || CONFIG.PACING[CONFIG.DEFAULT_PACING];
}

/** Is the opt-in "Tide of War" growth system active for this game? */
export function tideOfWar(state) {
  return pacingPreset(state).tideOfWar === true;
}

/**
 * Do the wild stacks already on the map get bigger week by week?
 *
 * ON BY DEFAULT, and deliberately NOT read off the pacing preset alone.
 *
 * Reported as: "the random creatures on the map do not increase numbers with time."
 * They did not, because weekly growth was bundled into the Tide of War preset — and a
 * preset is snapshotted onto `state.pacing` at newGame, so a game already in progress
 * could never adopt it. A nine-week save was frozen for its whole life, and a static
 * map is a solved map.
 *
 * `?? true` is the whole trick: a save written before this field existed has no
 * `wildGrowth`, reads as true, and starts growing at the next week's dawn. New games
 * seed it from Settings, so anyone who wants HoMM3-faithful frozen stacks can still
 * have them — `wildGrowth: false` reproduces the old Classic behaviour exactly.
 *
 * Safe to unbundle precisely because growMapCreatures draws NO rng (weeklyCreatureGrowth
 * is pure arithmetic): turning it on shifts no other draw in the game, so a seed's
 * combat rolls, map events and wave sizes are all untouched. The growth is bounded at
 * TIDE_MAP_GROWTH_CAP × each stack's ORIGINAL size, so a stack you keep avoiding gets
 * meaner and never becomes impossible.
 *
 * Breeding BRAND-NEW stacks (spawnMapCreatures, #12) stays Tide-only. That one puts new
 * objects on ground the player has already explored and cleared, which is a different
 * promise from "the ones that are there get bigger".
 */
export function wildStacksGrow(state) {
  if (tideOfWar(state)) return true;
  return (state?.wildGrowth ?? true) !== false;
}

/**
 * Does the world keep its own population — wandering stacks pegged to the leading
 * realm's army at a rate limit, and refilled to a floor when they are cleared out?
 *
 * ON BY DEFAULT, and for the same reason wildStacksGrow is: breeding new stacks was
 * bundled into the Tide of War preset, a preset is snapshotted onto `state.pacing` at
 * newGame, and so a game already in progress could never adopt it. The base game
 * therefore emptied out — a map ships its guards and bands, they are cleared, and the
 * mid-game has nothing left to fight.
 *
 * `?? true` again: a save written before this existed reads as on and starts breathing
 * at the next week's dawn. Safe to switch on mid-game because the peg is pure arithmetic
 * and repopulation draws from its OWN stream (state.wildRng), so no other roll in a seed
 * moves — the property that made unbundling wildStacksGrow safe, kept deliberately.
 */
export function neutralHomeostasis(state) {
  if (state?.neutralPeg === false) return false;
  // "Frozen stacks" is one intent, not two. A player who asked for the
  // HoMM3-faithful static map (wildGrowth: false) is asking for the world not to
  // move, and a crawling peg that quietly re-scaled it — or bands riding in to
  // refill it — would be answering a question they did not ask. Under the Tide of
  // War preset wildStacksGrow is forced on, so the peg follows it there too.
  return wildStacksGrow(state);
}

/**
 * Are the world's PvE defenders scaled UP to a fraction of the attacking hero's army
 * when they would otherwise be a walkover?
 *
 * The other half of "the random creatures do not increase numbers with time OR IF THE
 * HERO'S ARMY IS STRONGER", and the half that actually answers a solved map. Weekly
 * growth is bounded at a multiple of each stack's ORIGINAL size — measured, 2.5x, which
 * takes the biggest stack on a large map from about 4,500 to 11,000 — so against an army
 * worth two hundred thousand the map stays alive and stays trivial. Scaling is measured
 * against YOU instead, so it cannot be outgrown.
 *
 * Same shape and the same `?? true` trick as wildStacksGrow, for the same reason: it was
 * bundled into a preset that a running game could never adopt. It also draws no rng
 * (pure arithmetic on the battle's defender copy), so switching it on shifts no other
 * roll in a seed.
 *
 * Three properties keep it fair, and all three are older than this switch:
 *   It never scales DOWN, so a genuinely hard fight is left exactly as it is.
 *   The inflation is per-attacker and is un-inflated on write-back, so a repelled
 *     assault never bakes one hero's massed enemy into the map for the next one.
 *   It applies to every realm's heroes, not just the player's — the AI's map-clearing
 *     gets the same treatment.
 */
export function pveScalesToArmy(state) {
  if (tideOfWar(state)) return true;
  return (state?.pveScaling ?? true) !== false;
}

/**
 * The hardness dial, read as an OUTCOME: the share of its own army the fight should
 * cost the attacker. Linear across the dial's own range, so "Relaxed" and "Brutal"
 * keep their ends and only their units change.
 */
export function tideTargetLoss(hardness) {
  const lo = CONFIG.TIDE_HARDNESS_MIN, hi = CONFIG.TIDE_HARDNESS_MAX;
  const h = Math.max(lo, Math.min(hi, Number.isFinite(hardness) ? hardness : CONFIG.TIDE_HARDNESS_DEFAULT));
  const t = hi > lo ? (h - lo) / (hi - lo) : 0;
  return CONFIG.TIDE_LOSS_MIN + t * (CONFIG.TIDE_LOSS_MAX - CONFIG.TIDE_LOSS_MIN);
}

/**
 * The same dial, read as RISK: how often a wild fight is allowed to end with the army
 * destroyed outright. Separate from the cost target because past the cliff the two
 * come apart — a fight whose median cost is a quarter of your army can already be
 * killing you one time in seven — and because they are not the same promise. Relaxed
 * means "this will hurt"; Brutal means "this can end you".
 */
export function tideWipeTolerance(hardness) {
  const lo = CONFIG.TIDE_HARDNESS_MIN, hi = CONFIG.TIDE_HARDNESS_MAX;
  const h = Math.max(lo, Math.min(hi, Number.isFinite(hardness) ? hardness : CONFIG.TIDE_HARDNESS_DEFAULT));
  const t = hi > lo ? (h - lo) / (hi - lo) : 0;
  return CONFIG.TIDE_WIPE_TOL_MIN + t * (CONFIG.TIDE_WIPE_TOL_MAX - CONFIG.TIDE_WIPE_TOL_MIN);
}
