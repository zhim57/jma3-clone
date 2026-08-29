/**
 * neutrals.js — the world's own population: how many wild stacks there are, what
 * they are worth, and what they OUGHT to be worth.
 *
 * Two failures were reported together, and they are opposite ends of the same
 * missing feedback loop:
 *
 *   Depletion. A map ships a fixed set of guards and wandering bands. They are
 *   cleared, nothing replaces them (breeding new ones was bundled into the
 *   opt-in Tide of War preset, so the base game never did it), and the mid-game
 *   has nothing left to fight.
 *
 *   Staleness. Growth was a flat weekly increment against a cap of 2.5x the
 *   stack's original size, while everything else in the economy compounds. Two
 *   harpies on day 1 become twelve by week 6 — an obstacle that started
 *   meaningful and became litter.
 *
 * The fix is a crawling peg, in the currency-board sense: a wandering stack's
 * value tracks the leading realm's army at a fixed ratio, and may move only so
 * far per week toward that target. The rate limit is the important half. Without
 * it, a realm that doubles its army in a day (measured: 26,313 -> 81,388 on day
 * 37 of the reported campaign) instantly re-scales every stack on the map. With
 * it, a burst of recruitment buys a real window in which the world is soft, and
 * exploiting that window is a strategy rather than an exploit.
 *
 * This module is pure arithmetic over the state — no rng, no mutation. The
 * weekly application lives with the other weekly growth in actions.js.
 */

import { CONFIG } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { levelObjects } from './GameState.js';
import { armyValue } from './heroUtils.js';

/** The aiValue of one wild stack object. */
export function stackValue(obj) {
  return (CREATURES[obj.creature]?.aiValue || 0) * (obj.count || 0);
}

/**
 * A wild stack is a GUARD when the generator tied it to an object it protects
 * (`obj.guards` holds that object's id), and WANDERING otherwise. The
 * distinction matters because guards are placed to gate content: pegging them
 * changes what is reachable when, which is a different promise from keeping the
 * open country dangerous.
 */
export function isGuardStack(obj) {
  return obj.type === 'monster' && !!obj.guards;
}

/**
 * An invasion's war-band, which is NOT wildlife.
 *
 * invasions.placeBand writes `{ type: 'monster', invader: {...} }` straight into
 * map.objects, because a war-band fights and is fought exactly like a wild stack
 * and there was no reason to give it a second object type. That is fine
 * everywhere except here: this module's whole subject is the population the
 * world grows and keeps for itself, and a war-band is none of that. It is sized
 * by the wave that landed it (invasions.bandBudget), it has an errand, and it
 * leaves.
 *
 * Left unmarked it was picked up as a WANDERING BAND — the one population the
 * crawling peg owns — with three consequences, all measured:
 *   · pegWildStacks stamped it with count0 and a peg weight and then re-priced a
 *     wave's carefully-sized bands against the leading realm, week after week;
 *   · it counted toward the wandering population, so wildFloor read a map as
 *     full while a wave stood on it and repopulation stalled — then over-fired
 *     the week the wave was broken;
 *   · it entered medianBandValue and the census, so every instrument reading
 *     "how dangerous is the open country" answered with the invasion in it.
 */
export function isInvaderBand(obj) {
  return obj?.type === 'monster' && !!obj.invader;
}

/** Every wild stack on both levels, tagged by role. Invasion war-bands excluded
 *  (see isInvaderBand) — they are an event on the map, not part of it. */
export function wildStacks(state) {
  const out = [];
  if (!state?.map) return out;
  for (const level of state.map.underground ? [0, 1] : [0]) {
    for (const obj of Object.values(levelObjects(state, level))) {
      if (obj.type !== 'monster' || isInvaderBand(obj)) continue;
      out.push({ obj, level, guard: isGuardStack(obj), value: stackValue(obj) });
    }
  }
  return out;
}

/**
 * A realm the world is priced against: one of the powers actually playing for
 * the map, which an invading nation is not.
 *
 * invaderRealms.foundInvaderRealm adds a landing nation to `state.players` as an
 * ordinary undefeated realm — it has to, because it holds towns, hires heroes and
 * takes AI turns. Everything in this module then read it as another realm, and
 * since invaderPlanner sizes a nation's commanders at INVADER_WAVE_PER_MIN..MAX
 * (one to two times) of the strongest army in the world, the anchor the entire
 * wandering population is priced against jumped by that multiple the day a wave
 * came ashore, and stayed there for as long as the nation held a camp. Measured
 * on seed 4242 at day 120: the anchor went from the player's 3,746,400 to the
 * Sea-Kings' 6,021,869, a 1.61x step applied to every band on the map at once.
 *
 * The two functions that ask the same question on the invasion side —
 * invaderPlanner.wavePowerBase and .bestHero, "the greatest power of the age" —
 * both already skip invader realms, and both carry a comment saying why. This is
 * that rule, applied to the third reader of it.
 *
 * The peg's promise is that the open country stays as dangerous, RELATIVE TO THE
 * REALMS PLAYING, as it was the morning the game began. An invasion is a thing
 * that happens to those realms; letting it re-scale the wildlife means throwing
 * back a wave leaves the whole map permanently harder, which is the opposite of
 * what beating one should buy.
 */
function pricedRealm(p) {
  return !!p && !p.defeated && !p.invader;
}

/**
 * Each undefeated realm's fielded military — hero armies plus town garrisons,
 * treasury excluded. The single definition of "how big is that realm", so the
 * neutral peg and the AI's balance-of-power read the same number.
 * Returns Map(playerIndex -> value).
 */
export function realmArmyValues(state) {
  const by = new Map();
  const add = (owner, v) => {
    if (owner == null || owner < 0 || !v) return;
    if (!pricedRealm(state.players?.[owner])) return;
    by.set(owner, (by.get(owner) || 0) + v);
  };
  for (const h of Object.values(state?.heroes || {})) add(h.owner, armyValue(h.army || []));
  for (const t of Object.values(state?.towns || {})) add(t.owner, armyValue(t.garrison || []));
  return by;
}

/**
 * What a realm can put into ONE fight: its best hero, or the biggest garrison it
 * could walk a hero into and carry away (Phase B's pickup-on-pass made that
 * literal — a hero passing its own town leaves with the best seven stacks).
 *
 * This, and not the realm's total army, is the quantity the peg belongs against.
 * A battle is one hero against one stack; a realm's total is spread across
 * heroes and towns and never appears on a battlefield. Pricing the world against
 * it was measured to lock a spread-thin realm out of its own country: a home band
 * reaches PEG_RATIO x PEG_SPREAD_MAX = 0.375 of the anchor, the courage margin
 * asks 1.3x that — 0.49 of the anchor — from a single hero, and Phase B measured
 * realm / best hero at a median of 2.09, i.e. the median best hero IS 0.48 of its
 * realm. The median realm sat exactly on the line and anything thinner fell under.
 *
 * Anchored here instead, the same arithmetic reads 0.49 of what the realm can
 * actually field, which its own best hero clears by construction.
 *
 * Note that this is not a difficulty change dressed up as a fix: on day 1 a realm
 * is one hero and an empty garrison, so the two quantities are identical and the
 * generator's own calibration (PEG_RATIO, measured) is untouched. They diverge
 * only as a realm spreads out — which is exactly when the old anchor started
 * pricing the map against something no hero could bring to it.
 */
export function fieldableArmy(state, playerIndex) {
  if (!pricedRealm(state?.players?.[playerIndex])) return 0;
  let best = 0;
  for (const h of Object.values(state.heroes || {})) {
    if (h.owner !== playerIndex) continue;
    best = Math.max(best, armyValue(h.army || []));
  }
  for (const t of Object.values(state.towns || {})) {
    if (t.owner !== playerIndex) continue;
    best = Math.max(best, armyValue(t.garrison || []));
  }
  return best;
}

/** Every undefeated realm's fieldable force. Map(playerIndex -> value). */
export function fieldableArmyValues(state) {
  const by = new Map();
  for (const p of state?.players || []) {
    if (!pricedRealm(p)) continue;
    const v = fieldableArmy(state, p.index);
    if (v > 0) by.set(p.index, v);
  }
  return by;
}

/** The strongest single force on the board — the peg's global anchor. */
export function leadingFieldableArmy(state) {
  const values = [...fieldableArmyValues(state).values()];
  if (!values.length) return 0;
  if (CONFIG.PEG_ANCHOR === 'mean') return values.reduce((n, v) => n + v, 0) / values.length;
  return Math.max(...values);
}

/**
 * The anchor the peg tracks: by default the STRONGEST realm on the board.
 *
 * The alternative is the mean, and the choice is a real one. The maximum means
 * the leader sets the difficulty for everyone, including trailing AI realms that
 * then face stacks scaled to the human — which is how a hegemon's arms race
 * prices out smaller powers, and is also an accelerant for a runaway. The mean
 * is gentler on the trailing realms but lets a leader outgrow the world entirely,
 * which is the failure being fixed. We start at the maximum and measure; the
 * switch is `CONFIG.PEG_ANCHOR`.
 */
export function leadingRealmArmy(state) {
  const values = [...realmArmyValues(state).values()];
  if (!values.length) return 0;
  if (CONFIG.PEG_ANCHOR === 'mean') return values.reduce((n, v) => n + v, 0) / values.length;
  return Math.max(...values);
}

/**
 * Whose country is (x, y) in, and how deep? There is no ownership map in this
 * engine — territory is INFERRED from the nearest owned town, the same way the
 * AI's own `nearestOwnTown` reads it — so this returns the nearest town's owner
 * and the Chebyshev distance to it (Chebyshev because movement is 8-directional,
 * so it is the honest travel distance). Null when no realm holds a town on this
 * level at all.
 */
export function nearestTownOwner(state, x, y, level = 0) {
  let owner = -1, dist = Infinity, rival = Infinity;
  for (const t of Object.values(state?.towns || {})) {
    if (t.owner == null || t.owner < 0) continue;
    // A beachhead is not a country. Counting one made the ground around a
    // landing "the invader's own", which under the territorial blend priced the
    // wildlife there against the nation that had just come ashore — the same
    // error as the anchor above, arriving by the geography half instead.
    if (!pricedRealm(state.players?.[t.owner])) continue;
    if ((t.z ?? 0) !== level) continue;
    const d = Math.max(Math.abs(t.x - x), Math.abs(t.y - y));
    if (d < dist) {
      // The old nearest becomes the rival only if it belonged to someone else.
      if (owner >= 0 && owner !== t.owner) rival = Math.min(rival, dist);
      dist = d;
      owner = t.owner;
    } else if (t.owner !== owner && d < rival) {
      rival = d;
    }
  }
  return owner >= 0 ? { owner, dist, rival } : null;
}

/**
 * The army a band at (x, y) is priced against: its host realm's at the doorstep,
 * the leader's out in nobody's country, and a blend in between.
 *
 * This is the answer to a measured failure of the global peg. Pegging every band
 * to the strongest realm meant the trailing realms could beat 0 % of the map —
 * not "fewer bands", none — because a stack at a fifth of a hegemon's army is
 * still an order of magnitude past what a losing realm can field. Widening the
 * distribution does not reach them: a band at 65 % of a target set by someone
 * 30x your size is not a soft target. Only a different ANCHOR is, and the one
 * that fits both the fiction and the arithmetic is geography — your own country
 * is priced against you, the frontier against whoever leads.
 *
 * The blend is geometric (see CONFIG.PEG_TERRITORY_GEOMETRIC): a linear one is
 * swamped by the leader's term the moment the two realms differ by 30x, which is
 * exactly the case it exists to serve.
 */
export function bandAnchor(state, x, y, level = 0) {
  const leader = leadingFieldableArmy(state);
  if (!(leader > 0)) return 0;
  const near = nearestTownOwner(state, x, y, level);
  if (!near) return leader;
  const armies = fieldableArmyValues(state);
  const own = armies.get(near.owner) || 0;
  if (!(own > 0)) return leader;
  // How CONTESTED is this ground, rather than how far from a town it is. A fixed
  // radius was tried first and measured wrong: a realm reduced to two towns has a
  // hinterland far wider than any radius, so most of its own country was priced
  // against the leader and it stayed locked out — 0 % of the bands at home.
  //
  // The share below is scale-free and needs no magic number. Deep inside one
  // realm's country the nearest rival is far away and exposure tends to 0; on the
  // line between two realms it is 0.5 and the band is the geometric mean of them,
  // which reads as a fair fight on the frontier. It cannot exceed 0.5, because the
  // host is by definition the nearest — so the expensive country is the CONTESTED
  // country, which is better fiction than "anywhere far from a town".
  const exposure = Number.isFinite(near.rival)
    ? near.dist / Math.max(1e-9, near.dist + near.rival)
    : 0;
  // Against whoever is actually across the line, not always the map's leader:
  // two weak neighbours contest their border at their own scale.
  const other = Number.isFinite(near.rival)
    ? Math.max(own, ...[...armies.entries()]
      .filter(([who]) => who !== near.owner).map(([, v]) => v), 0)
    : own;
  const rivalArmy = Math.max(own, Math.min(other, leader));
  if (!CONFIG.PEG_TERRITORY_GEOMETRIC) return own + (rivalArmy - own) * exposure;
  return Math.exp((1 - exposure) * Math.log(own) + exposure * Math.log(rivalArmy));
}

/** What a specific band should be worth: its own weight against its own anchor. */
export function bandTarget(state, obj, level = 0) {
  return CONFIG.PEG_RATIO * bandAnchor(state, obj.x, obj.y, level) * bandWeight(state, obj);
}

/**
 * What a wandering stack should be worth today: a fixed share of the leading
 * realm's army.
 *
 * PEG_RATIO is not a new difficulty knob — it is calibrated to the ratio the map
 * generator already ships on day 1 (median wandering stack ≈ a fifth of a
 * starting realm), so the peg's promise is "the open country stays as dangerous,
 * relative to the leader, as it was the morning the game began".
 */
export function pegTarget(state) {
  return CONFIG.PEG_RATIO * leadingFieldableArmy(state);
}

/**
 * A band's own weight in the world's distribution: where it sat relative to the
 * median band the map shipped. Recorded once on the object (`obj.peg`) so it
 * survives its own growth — the value it has TODAY is the peg's doing, and using
 * that would be circular. Respawned bands are given a rolled weight instead.
 *
 * Without this the peg holds the level of the distribution and destroys its
 * shape: every band converges on one number and the map stops having easy
 * corners and dangerous ones.
 */
export function bandWeight(state, obj) {
  if (obj.peg != null) return obj.peg;
  const base = state?.wildBandValue0 || medianBandValue(state) || 0;
  const own = (CREATURES[obj.creature]?.aiValue || 0) * (obj.count0 ?? obj.count ?? 0);
  const rel = base > 0 && own > 0 ? own / base : 1;
  obj.peg = Math.max(CONFIG.PEG_SPREAD_MIN, Math.min(CONFIG.PEG_SPREAD_MAX, rel));
  return obj.peg;
}

/** Median ORIGINAL value of the wandering bands currently on the map. */
export function medianBandValue(state) {
  const vals = wildStacks(state)
    .filter((w) => !w.guard)
    .map((w) => (CREATURES[w.obj.creature]?.aiValue || 0) * (w.obj.count0 ?? w.obj.count))
    .sort((a, b) => a - b);
  return vals.length ? vals[vals.length >> 1] : 0;
}

/**
 * The counts and value distribution of the world's wild population — the thing
 * the acceptance criteria are stated in, and what the sim harness reports at
 * days 20 / 50 / 80 / 100. Pure; safe to call as often as you like.
 */
export function neutralCensus(state) {
  const stacks = wildStacks(state);
  const split = (which) => {
    const values = stacks.filter((s) => s.guard === which).map((s) => s.value).sort((a, b) => a - b);
    const at = (q) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * q))] : 0);
    return {
      count: values.length,
      total: values.reduce((n, v) => n + v, 0),
      min: values[0] || 0,
      p25: at(0.25),
      median: at(0.5),
      p75: at(0.75),
      p90: at(0.9),
      max: values[values.length - 1] || 0,
    };
  };
  const leading = leadingRealmArmy(state);
  const fieldable = leadingFieldableArmy(state);
  // Each band is priced against its own anchor now, so "is the peg holding" is a
  // question about value / OWN target, not about the global one.
  const local = stacks.filter((s) => !s.guard).map((s) => {
    const t = bandTarget(state, s.obj, s.level);
    return t > 0 ? s.value / t : null;
  }).filter((v) => v != null).sort((a, b) => a - b);
  return {
    day: state.day,
    leading,
    fieldable,
    target: CONFIG.PEG_RATIO * fieldable,
    localRatio: local.length ? {
      p10: local[Math.floor(local.length * 0.1)],
      median: local[local.length >> 1],
      p90: local[Math.floor(local.length * 0.9)],
    } : null,
    wandering: split(false),
    guards: split(true),
  };
}

/**
 * The floor the wandering population is kept at: a share of what the map shipped
 * with. Stated as a fraction rather than an absolute count because map size sets
 * the population — a 72x60 map generates 47 wandering bands and 111 guards, not
 * the 100/200 of a large one, and a fixed floor of 100 would have bred a swarm.
 */
export function wildFloor(state) {
  const baseline = state?.wildBaseline
    ?? wildStacks(state).filter((s) => !s.guard).length;
  return Math.floor(baseline * CONFIG.PEG_FLOOR_SHARE);
}
