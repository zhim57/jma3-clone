/**
 * holdings.js — what it costs to KEEP something.
 *
 * The reported failure, in one sentence: a hero with one pikeman walks past a
 * mine and reflags it, and that is the entire ownership model. The same
 * weightlessness took Ashenfell five times in four days, twice on day 42, once
 * with 43,396 attacking 4,128.
 *
 * In the world, property is defended in layers — title, police, private
 * security, alarms, surveillance, insurance — and taking someone's is difficult
 * in proportion to what they have invested in holding it. This is that, priced:
 *
 *   unguarded     free            reflag on pass, as before
 *   watch         free, automatic the owner is told, and the capture is dated
 *   garrison      moderate        a real defending stack that must be beaten
 *   fortification expensive       defender bonus, and the winner still bleeds
 *   patrol        upkeep only     NOT BUILT — see the note at the end
 *
 * Two design points carry most of the weight.
 *
 * **Watch is free and automatic**, so "unguarded" stops being the default state
 * of the world. It buys no combat — a hero still walks in — but an unannounced
 * seizure is the part that made the model feel weightless, and a dated line in
 * the log is what turns "my mines keep vanishing" into "Red took the sulfur pit
 * on day 38".
 *
 * **Upkeep is the balancing force.** Defending everything must be unaffordable,
 * so the owner chooses what to defend — which is the decision the whole system
 * exists to create. Costs are charged daily against gold, through the same
 * income path everything else uses.
 *
 * Pure data and arithmetic: no rng, no mutation of the world, no import of
 * actions.js. The engine calls in.
 */

import { CONFIG } from '../config.js';
import { CREATURES, creaturesOfTier } from '../data/creatures.js';
import { armyValue } from './heroUtils.js';

/** The ordered ladder. A holding sits at exactly one rung. */
export const DEFENCE_LAYERS = ['unguarded', 'watch', 'garrison', 'fortification'];

/** Which object types can be held, and so defended. */
export function isHolding(obj) {
  return !!obj && (obj.type === 'mine' || obj.type === 'dwelling');
}

/** A holding's defence record, defaulted — additive on the object, no migration. */
export function defenceOf(obj) {
  return obj?.defence || null;
}

/** The rung this holding sits at right now. */
export function defenceLayer(obj) {
  const d = defenceOf(obj);
  if (!d) return 'unguarded';
  if (d.fortified) return 'fortification';
  if ((d.garrison || []).some((s) => s && s.count > 0)) return 'garrison';
  return d.watch ? 'watch' : 'unguarded';
}

/** The fighting value standing on a holding, or 0. */
export function defenceValue(obj) {
  const d = defenceOf(obj);
  return d ? armyValue(d.garrison || []) : 0;
}

/** Does this holding have to be FOUGHT for, rather than walked onto? */
export function isDefended(obj) {
  return defenceValue(obj) > 0;
}

/**
 * The creature a realm garrisons with: its faction's tier-2 line, which is cheap
 * enough to buy in bulk and real enough to cost an attacker something. Chosen
 * deterministically from the faction, so garrisoning draws no rng.
 */
export function garrisonCreature(state, playerIndex) {
  const faction = state?.players?.[playerIndex]?.faction;
  const pick = creaturesOfTier(faction, CONFIG.DEFENCE_GARRISON_TIER)?.base
    || creaturesOfTier(faction, 1)?.base;
  return CREATURES[pick] ? pick : 'pikeman';
}

/**
 * What one more step of garrison costs, and what it buys. Priced per unit of the
 * garrison creature, so a realm with an expensive tier-2 pays more for the same
 * headcount — its stack is also worth more.
 */
export function garrisonUnitCost(state, playerIndex) {
  const c = CREATURES[garrisonCreature(state, playerIndex)];
  return Math.max(1, Math.round((c?.cost?.gold || 100) * CONFIG.DEFENCE_GARRISON_MARKUP));
}

/** Gold to raise this holding's fortification (a one-off; masonry is permanent). */
export function fortifyCost() {
  return CONFIG.DEFENCE_FORTIFY_COST;
}

/**
 * A realm's DAILY upkeep for everything it is holding. This is the force that
 * makes the player choose: garrisons are charged per unit standing, fortified
 * holdings carry a maintenance line, and a watch costs nothing at all (it is a
 * pair of eyes, not a payroll).
 */
export function defenceUpkeep(state, playerIndex) {
  let gold = 0;
  for (const level of state?.map?.underground ? [0, 1] : [0]) {
    const objects = level === 0 ? state.map.objects : state.map.underground?.objects;
    for (const obj of Object.values(objects || {})) {
      if (!isHolding(obj) || obj.owner !== playerIndex) continue;
      const d = defenceOf(obj);
      if (!d) continue;
      const bodies = (d.garrison || []).reduce((n, s) => n + (s ? s.count : 0), 0);
      gold += bodies * CONFIG.DEFENCE_GARRISON_UPKEEP;
      if (d.fortified) gold += CONFIG.DEFENCE_FORTIFY_UPKEEP;
    }
  }
  return Math.round(gold);
}

/**
 * What it costs to buy a garrison OUT rather than fight it.
 *
 * Mercenaries have a price, and gold is the resource a winning realm has too
 * much of (day 50 of the reported campaign: 60,244 gold and nothing to spend it
 * on). Paying is deliberately expensive relative to the stack — you are buying
 * certainty and your own troops' lives — and the money goes to the DEFENDER,
 * which makes losing a holding this way a genuine transfer rather than a
 * deletion. That is the interesting part: a realm being bought out of its
 * frontier is being paid to retreat, and can spend it.
 */
export function buyoutPrice(state, obj) {
  const value = defenceValue(obj);
  if (!(value > 0)) return 0;
  const fort = defenceOf(obj)?.fortified ? CONFIG.DEFENCE_BUYOUT_FORT_MULT : 1;
  return Math.round(value * CONFIG.DEFENCE_BUYOUT_RATE * fort);
}

/**
 * The garrison a town keeps when it changes hands: a share of what the capturing
 * army was worth, floored so even a small taking leaves something behind.
 *
 * This is the clause that ends the ping-pong on its own. A town taken by 43,396
 * used to be defended by nothing the following morning, so the next hero to pass
 * took it back for free, and the one after that took it again. Leaving a real
 * garrison means the second capture has to be paid for.
 */
export function captureGarrisonValue(attackerValue) {
  return Math.max(CONFIG.DEFENCE_CAPTURE_FLOOR,
    Math.round(attackerValue * CONFIG.DEFENCE_CAPTURE_SHARE));
}
