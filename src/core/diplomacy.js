/**
 * diplomacy.js — Diplomacy (#16): parley with a neutral stack instead of fighting.
 *
 * A self-contained slice (like market.js / transmute.js): the PURE offer/price
 * logic lives here — it imports the combat sim to price a parley off the fight the
 * hero would otherwise have, but never imports back through actions.js (no cycle;
 * the `parley` ACTION that mutates the world lives in actions.js and calls these).
 *
 * The teaching is Coasean: a battle against a neutral guard is pure deadweight
 * loss a side-payment could avert — but only when the two sides can strike a deal.
 * So some stacks REFUSE, and the quoted price can exceed the cost of just fighting;
 * the transferable insight lives precisely where no settlement is reached.
 *
 * The file has since grown the OTHER way an encounter ends without a battle: a
 * band far weaker than the hero breaks and runs (`fleeCheck`). It lives here
 * rather than in a file of its own because it is the same question asked from the
 * other side of the table — how does this band read the host in front of it — and
 * it shares this module's seeding rule, so neither the price nor the flight can be
 * re-rolled by a reload.
 */

import { CONFIG } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { Rng } from './rng.js';
import { armyValue, heroMaxMovement } from './heroUtils.js';
import { skillValue } from '../data/skills.js';
import { isRonin } from './ronins.js';
import { isGuardStack, isInvaderBand } from './neutrals.js';
import { featureOn } from './GameState.js';
import { playerUpgrades } from './upgrades.js';
import { pveSplitParts } from './aiMemory.js';
import { createBattle } from './combat/CombatEngine.js';
import { autoResolve } from './combat/CombatAI.js';

/** A stable 32-bit seed for one simulated fight (map seed + a caller's key), so a
 *  quote never changes on a reload/retry. Exported because tideScaleDefender sizes a
 *  defender by SEARCHING over candidate armies, and every probe of that search has to
 *  run on the same seed — otherwise the search is climbing rng noise rather than the
 *  army size, and the result stops being monotone in the multiplier. */
export function fightSeed(state, key) {
  let h = 2166136261 >>> 0;
  const s = `${state?.seed ?? 0}|${key}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A stable 32-bit seed for THIS encounter (map seed + the monster's identity),
 *  so the refusal roll and the loss estimate never change on a reload/retry. */
function encounterSeed(state, monster) {
  return fightSeed(state, `${monster.id}|${monster.creature}|${monster.count}`);
}

/** What this stack would cost to RECRUIT at a dwelling, in gold. Creatures with no
 *  price (never bought — e.g. a battle remnant) fall back to their power value, so
 *  nothing is ever free. */
export function stackRecruitCost(monster) {
  const c = CREATURES[monster.creature];
  if (!c) return 0;
  const each = c.cost?.gold || c.aiValue || 0;
  return Math.max(0, each * (monster.count || 0));
}

/**
 * The army value the sim predicts `hero` would LOSE fighting `defArmy`.
 *
 * This is the only function in the codebase that answers "what will this fight cost
 * me" with the function that actually decides the fight, rather than with a price
 * index standing in for it — which is why both the parley quote and the PvE sizer
 * are built on it. `armyValue` and `armyPower` are proxies fitted for trades and for
 * rewards; neither carries the commander, and in the physical damage model the
 * commander enters MULTIPLICATIVELY on every stack, so no additive proxy can track
 * it. A simulated battle carries it for free, along with reach, spells, morale,
 * upgrades and every feature flag.
 *
 * `seed` must be supplied by the caller and held FIXED across a search (see
 * `fightSeed`). `discipline` is the invader-band drill bonus, so a war-band is
 * quoted as the war-band it is.
 *
 * `rounds` bounds the simulation. Omitted, it is the engine's own limit and the
 * estimate is the whole fight — which is what a ONE-OFF quote (a parley price)
 * wants. A SEARCH runs dozens of these to price one encounter and pays for every
 * round of every probe, so the tide sizer passes a shorter bound; see
 * CONFIG.TIDE_PROBE_ROUNDS for what that costs and what it was measured to move.
 */
export function predictedArmyLoss(state, hero, defArmy, { seed, discipline = 0, rounds } = {}) {
  const army = (defArmy || []).filter((s) => s && s.count > 0)
    .map((s) => ({ creature: s.creature, count: s.count }));
  if (!army.length) return 0;
  const rng = new Rng(seed >>> 0);
  const battle = createBattle({
    rng, terrain: 'grass', simulated: true, // a price estimate must not spend the hero's real mana
    // A price for a fight has to be quoted under the rules that fight would be
    // run under. This threaded NEITHER features nor upgrades, so with any opt-in
    // rule active the parley quote was priced by a different game than the one
    // the hero would walk into — and once upgrade nodes reached the damage model,
    // a player who had trained their troops was quoted as if they had not.
    features: state.features || {},
    upgrades: playerUpgrades(state),
    attacker: { hero, army: (hero.army || []).filter(Boolean), playerIndex: hero.owner },
    defender: { hero: null, army, playerIndex: -1, discipline },
    // The heroless defender deploys SPLIT, and by however many pieces the country
    // has learned to use against this player. The quote has to be for the fight
    // they will actually walk into, so this reads the same helper the real battle
    // does — see CombatEngine.deployArmyOf.
    pveSplitParts: pveSplitParts(state),
  });
  const before = armyValue(hero.army || []);
  const res = rounds > 0 ? autoResolve(battle, rounds) : autoResolve(battle);
  return Math.max(0, before - armyValue(res.attackerArmy || []));
}

/** The army value the sim predicts `hero` would LOSE fighting this monster stack. */
export function predictedFightLoss(state, hero, monster) {
  return predictedArmyLoss(state, hero, [{ creature: monster.creature, count: monster.count }],
    { seed: encounterSeed(state, monster) });
}

/**
 * Could this hero actually TAKE these creatures if they agreed to join?
 *
 * Seven slots: `addToArmy` merges into a matching stack or claims a free one, and
 * otherwise fails. An offer the hero cannot accept is not an offer, and quoting
 * one is the same defect this project has now hit four times — an action offered
 * on the strength of a reward the actor cannot receive (see
 * docs/DESIGN_DECISIONS.md). The check has to happen where the offer is MADE,
 * not where it is taken up, because in between the player has already been told
 * a price and made a plan.
 */
export function joinFeasible(hero, monster) {
  const army = hero?.army || [];
  if (army.some((s) => s && s.count > 0 && s.creature === monster.creature)) return true;
  return army.some((s) => !s || s.count <= 0);
}

/**
 * This band's temper toward this hero, 0..1 — 0 hard-nosed, 1 eager to follow.
 *
 * Seeded off the encounter (not the clock, not a global rng), so the price a
 * stack asks is a fact about that stack rather than something a reload can
 * re-roll, and two identical bands on one map ask different prices. It is what
 * makes "some were at a bargain" true without making every bargain the same one.
 */
export function parleyMood(state, monster) {
  return new Rng(encounterSeed(state, monster) ^ 0x27d4eb2f).random();
}

/** Does the hero already field these creatures? Kin bargain differently — it is
 *  the one case where a band joins for nothing (see CONFIG.PARLEY_FREE_RATIO). */
function fieldsKin(hero, monster) {
  return (hero?.army || []).some((s) => s && s.count > 0 && s.creature === monster.creature);
}

/**
 * Would this neutral stack consider joining `hero` for gold, and at what price?
 * Returns { offered, refused, acceptable, free, price, creature, count }.
 * `offered` is false when Diplomacy is off, the stack is too strong (past
 * PARLEY_MAX_RATIO, widened by the hero's Diplomacy skill), or the data is bad.
 * When offered, `refused` (a seeded per-encounter roll) means they won't deal at
 * any price — the hero must fight.
 *
 * The hero's Diplomacy SKILL is the whole difference between a band that mostly
 * shrugs you off and one that mostly signs on: it widens the band, cuts the
 * refusal, discounts the price, and lets kin join free. Without it a flat
 * PARLEY_REFUSE_BASE means a deal is the exception — which is the point, since
 * measured without one a developed hero was offered terms by 100% of the map.
 */
export function parleyOffer(state, hero, monster) {
  const no = { offered: false };
  // The reasons are load-bearing, not decoration: "was this stack ever a join
  // candidate?" is the question that decides whether a x20 multiplier is the
  // scaling misbehaving or one branch of it, and it cannot be answered from a
  // bare false.
  if (!featureOn(state, 'diplomacy')) return { ...no, reason: 'diplomacy off' };
  if (!hero || !monster) return { ...no, reason: 'no encounter' };
  const cr = CREATURES[monster.creature];
  if (!cr || !(monster.count > 0)) return { ...no, reason: 'no encounter' };
  const stackVal = (cr.aiValue || 0) * monster.count;
  const heroVal = armyValue(hero.army || []);
  if (stackVal <= 0 || heroVal <= 0) return { ...no, reason: 'no encounter' };
  const ratio = stackVal / heroVal;
  const dip = skillValue(hero, 'diplomacy');
  // Too strong to bargain with — never a join candidate at any price. A trained
  // diplomat talks to bigger bands than an untrained one can.
  const maxRatio = CONFIG.PARLEY_MAX_RATIO * (1 + dip * CONFIG.PARLEY_BAND_BONUS);
  if (ratio > maxRatio) return { ...no, reason: 'too strong' };
  // No room in the army, no offer. Priced at selection time, not at arrival.
  if (!joinFeasible(hero, monster)) return { ...no, reason: 'no room' };
  // Two anchors, whichever is dearer: what the fight would cost you, and what the
  // creatures themselves are worth. The second is what stops a strong hero
  // recruiting the whole map for a gold a stack (see CONFIG.PARLEY_COST_SHARE).
  const loss = predictedFightLoss(state, hero, monster);
  const avoided = loss * CONFIG.PARLEY_PRICE_MULT;
  const goods = stackRecruitCost(monster) * CONFIG.PARLEY_COST_SHARE;
  // The bargain: what the training and their mood knock off the asking price.
  // An untrained hero has nothing to bargain with, so dip = 0 pays it in full
  // however friendly the band — the discount is the SKILL, not the weather.
  const mood = parleyMood(state, monster);
  const bargain = dip * (CONFIG.PARLEY_BARGAIN_BASE + CONFIG.PARLEY_BARGAIN_MOOD * mood);
  // Kin, and a rounding error next to your host: they simply fall in. This is
  // the only zero the formula can produce, and it is bounded by what you already
  // carry, by the band being trivial, and by seven slots — see PARLEY_FREE_RATIO.
  const free = dip > 0 && fieldsKin(hero, monster) && ratio <= CONFIG.PARLEY_FREE_RATIO * dip;
  const price = free ? 0 : Math.max(1, Math.round(Math.max(avoided, goods) * (1 - bargain)));
  const refuseChance = Math.min(CONFIG.PARLEY_REFUSE_MAX,
    CONFIG.PARLEY_REFUSE_BASE + ratio * CONFIG.PARLEY_REFUSE_SLOPE) * (1 - dip);
  const refused = new Rng(encounterSeed(state, monster) ^ 0x5bd1e995).random() < refuseChance;
  // `acceptable` is the whole offer, not half of it: they will deal, the hero has
  // room, and the treasury can cover it. It is what the scaling branch reads to
  // decide whether this stack is a recruitment offer or a fight.
  const acceptable = !refused
    && (state.players?.[hero.owner]?.resources?.gold || 0) >= price;
  return {
    offered: true, refused, acceptable, free, price,
    // The predicted cost of the fight this price is an alternative to. Returned
    // because it is the single most expensive thing on this path (one fully
    // auto-resolved battle) and every caller that has to DECIDE — rather than
    // merely display — wants it: AIPlayer.maybeParleyStack weighs the price
    // against it, and without this it would run the same simulation a second time
    // on every encounter of the computer's turn.
    loss,
    creature: monster.creature, count: monster.count,
  };
}

/**
 * Would this band BREAK AND RUN rather than face `hero`?
 *
 * The mirror of a parley, and it belongs in the same file for the same reason:
 * both are ways an encounter ends without a battle, both are decided by how this
 * band reads the host in front of it, and both are seeded per-encounter so a
 * reload cannot re-roll the outcome. Reported as "a weak stack may flee, and a
 * user may decide to chase if they need the experience, or to let them go and
 * save time" — so this answers only whether they RAN. What happens next is the
 * player's (see CONFIG.CHASE_MOVE_COST and actions.letThemGo / chaseThem).
 *
 * WEIGHED ON THE STACK AS IT STANDS, not on what the tide sizer would mass it
 * into. That is a decision, and the measurement behind it: with PvE scaling on,
 * every wild stack is sized to roughly half the attacker's army, so weighing the
 * massed army meant 0 flights in 114 encounters on four maps — the feature was
 * dead in every game with scaling on, which is the default. The band cannot see
 * the sizer; it sees the host in front of it, and a hundred gnolls looking at an
 * archangel host runs. The massing is what a cornered band does when the fight
 * actually happens, and it is exactly what the CHASE still pays for: run them
 * down and you fight the full, sized battle for its full experience.
 *
 * WHO NEVER RUNS, and why each one matters:
 *   a GUARD posted on a prize holds its post. This is the load-bearing one —
 *     letting a band go clears its tile, so a fleeing guard would hand over the
 *     mine, artifact or booster it was standing over for nothing. Guards are the
 *     encounters the map put there to be paid for.
 *   a RONIN-led band has a captain holding it together.
 *   an INVADER war-band is on an errand, not squatting on a tile.
 *
 * Returns { flees, chance, ratio, reason }. `reason` is load-bearing the same way
 * parleyOffer's is: "did this stack ever consider running?" cannot be answered
 * from a bare false.
 */
export function fleeCheck(state, hero, monster) {
  const no = { flees: false, chance: 0, ratio: 0 };
  if (!hero || !monster || monster.type !== 'monster') return { ...no, reason: 'no encounter' };
  const cr = CREATURES[monster.creature];
  if (!cr || !(monster.count > 0)) return { ...no, reason: 'no encounter' };
  if (isGuardStack(monster)) return { ...no, reason: 'guarding' };
  if (isRonin(monster)) return { ...no, reason: 'commanded' };
  if (isInvaderBand(monster)) return { ...no, reason: 'invader' };
  const stackVal = (cr.aiValue || 0) * monster.count;
  const heroVal = armyValue(hero.army || []);
  if (stackVal <= 0 || heroVal <= 0) return { ...no, reason: 'no encounter' };
  const ratio = stackVal / heroVal;
  if (ratio >= CONFIG.FLEE_MAX_RATIO) return { ...no, ratio, reason: 'stands its ground' };
  // Terror falls off with the odds: hopeless at ratio 0, gone by FLEE_MAX_RATIO.
  const chance = CONFIG.FLEE_CHANCE_MAX * (1 - ratio / CONFIG.FLEE_MAX_RATIO);
  const flees = new Rng(encounterSeed(state, monster) ^ 0x7f4a7c15).random() < chance;
  return { flees, chance, ratio, reason: flees ? 'routed on sight' : 'held' };
}

/** Movement the hero spends running a fleeing band to ground (CONFIG.CHASE_MOVE_COST).
 *  A fraction of the DAY's allowance, not of what is left — so the chase costs the
 *  same whether it is the first move of the morning or the last of the evening. */
export function chaseCost(hero) {
  return Math.round(heroMaxMovement(hero) * CONFIG.CHASE_MOVE_COST);
}
