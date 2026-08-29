/**
 * AIPlayer.js — Adventure-map AI opponent.
 *
 * The AI turn is a resumable controller: AdventureScene calls next() until
 * it returns { type: 'done' }. When the AI attacks something owned by the
 * HUMAN player, next() returns { type: 'combat', context } so the human can
 * fight the battle interactively; the scene applies the result and calls
 * next() again.
 *
 * next() also takes an optional TIME BUDGET (milliseconds). Without one it
 * runs the whole turn in a single call, which is what every headless caller
 * wants — sims, tests, autoResolve-driven games. With one, it returns
 * { type: 'paused' } as soon as the budget is spent, at one of two safe
 * checkpoints (between heroes; between steps of a march), and the next call
 * picks up exactly where it left off. That is what lets AdventureScene hand
 * a frame back to the browser mid-turn: measured at the largest shipped map
 * (88×72, scripts/sim/aiperf.mjs 60 88 72), a computer turn peaked at 2.8
 * seconds of continuous main-thread work — the tab visibly froze — and the
 * budget turns that one block into dozens of bounded slices. Slicing is pure
 * control flow: it never changes WHAT the turn computes (a paused-and-resumed
 * turn is byte-identical to an uninterrupted one — tests/ai-slicing.test.js
 * proves it on serialized states), so determinism and the seeded RNG stream
 * are untouched no matter where the wall clock lands.
 *
 * Strategy (deliberately transparent — see docs/EXTENDING.md to deepen it):
 *   Towns: hire heroes first while gold clearly allows (a hero pays for
 *   itself in loot and tempo), follow a build order — using the marketplace
 *   to close a small resource gap on the priority build instead of stalling —
 *   then recruit everything affordable.
 *   Heroes: every goal is priced in ONE currency, value / distance, gated by
 *   a courage margin against its defenders (mirroring the combat AI's single
 *   expected-value scale). Two DIFFERENT questions hide in that sentence and
 *   they are read in two different units (src/core/power.js): what a prize is
 *   WORTH is a PRICE (aiValue — gold-equivalent desirability), while every
 *   can-I-win gate — courage margins, guard values, threat and town-defense
 *   readings — is read in POWER, the currency the running damage model's own
 *   battles agree with. The strongest hero (the "main") pushes for towns,
 *   kills and artifacts; the others ("collectors") sweep the economy and
 *   ferry garrisons forward. A goal and its A* path are computed ONCE and
 *   followed step by step; re-planning happens only when the plan completes,
 *   combat interrupts it, a step is blocked — not on every tile — or a
 *   connector transit moves the hero to a new level / movement mode.
 *   Connectors: portals, subterranean gates, boats and shipyards are valued
 *   as goals in the same currency — a connector is worth the best courage-
 *   gated prize reachable THROUGH it, discounted by the distance to the
 *   connector plus a crossing cost, and damped by a hysteresis margin so a
 *   hero only crosses when the far side clearly beats its direct options.
 *   A shipyard is a boat that must first be BOUGHT: it is priced only when
 *   the build would succeed right now (affordable, dock free) and no already-
 *   reachable boat serves the same water, carries extra build friction, and
 *   builds are capped at one per hero per turn with a per-yard cross-day
 *   cooldown — so the AI buys a boat only for real, unserved water value and
 *   can never churn build→sail→build. An OWN coastal town with the Shipyard
 *   BUILDING is priced exactly like a map yard (same friction, caps and
 *   cooldowns) with the town square as the goal — entering it launches the
 *   boat at the town's dock and the normal embark path boards it. Towns count among
 *   those prizes on EITHER level — a neutral or enemy cavern town seen
 *   through a gate is a top-tier goal, so heroes descend to capture the
 *   underground's towns, not just to loot its vault. A hero scans and
 *   pursues goals on ITS OWN level (an underground hero clears the vault);
 *   stepping through a gate/portal or embarking simply drops the cached plan
 *   and re-plans from the new position, so the normal per-level scan takes
 *   over after every transit. Anti-ping-pong: a per-hero, per-turn transit
 *   cap, plus both endpoints of a just-used gate/portal are blacklisted for
 *   the rest of the turn.
 *   Whirlpools are the one connector the AI NEVER uses: their destination is
 *   random (unpriceable in a value/distance currency), so they are not valued
 *   as goals, and the through-wall pathing rule means no cached route ever
 *   crosses one — the AI simply sails around them.
 *   Defense (turtle & build-up): enemy heroes count as GUARDS — one standing
 *   on or beside a prize gates a weak hero off it exactly like a monster
 *   would, and no loot inside a superior enemy field army's strike range is
 *   ever chased. When a superior enemy menaces a town the AI cannot beat, it
 *   does not chip-feed heroes at it: field heroes consolidate INTO the town,
 *   the defender absorbs every week's recruits and HOLDS, hiring at that town
 *   is suspended, and the PEAK threat is remembered on the town (decaying
 *   over days, surviving save/load) so a briefly-retreating besieger doesn't
 *   bait a premature sally. Once the town's defense beats the remembered
 *   threat by the courage margin, the hold lifts and the ordinary enemy-hero
 *   goal — now passing its courage gate — sends the consolidated army out.
 *
 * NOTE: the AI paths with full map knowledge (no fog) — a common, documented
 * simplification (docs/DESIGN_DECISIONS.md) that keeps early AI competent.
 */

import { CONFIG, RESOURCES } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { bankDef, broodOf } from '../data/creatureBanks.js';
import { pandoraRewardValue } from '../data/pandora.js';
import { buildingCatalog } from '../data/buildings.js';
import { ARTIFACTS, EQUIP_SOCKETS } from '../data/artifacts.js';
import { HERO_ROSTER } from '../data/heroes.js';
import {
  playerHeroes, playerTowns, canAfford, levelObjects, objectsWhere, tileAt, heroAt, playerHasKey, weekOf,
  featureOn, logMsg, getObject,
} from '../core/GameState.js';
import { playerUpgrades } from '../core/upgrades.js';
import { SPELLS } from '../data/spells.js';
import { tideOfWar } from '../core/pacing.js';
import { invasionTruce, activeBands, bandForce } from '../core/invasions.js';
import {
  wouldSeekTerms, wouldTakeVassal, signPact, realmForce, offerVassalage, suzerainPact,
} from '../core/pacts.js';
import { warBias, refuseTerms } from '../core/patrons.js';
import { uprisingBias } from '../core/uprisings.js';
import {
  buildBlockReason, buildStructure, recruit, recruitableCreature,
  stepHero, stepReserve, resolveChest, chooseSkill, applyCombatResult,
  hireableHeroes, hireHero, pooledHero, hireCost, marketTrade, marketSellRate, marketBuyRate, equipArtifact,
  artifactBandValue, tradingPostSellXp, tradingPostBuyCost, sellArtifactsForXp, buyArtifactAt,
  fulfillSeerQuest, seerQuestMet,
  buildBoat, shipyardBuildCheck, shipyardDockTile,
  buildBoatAtTown, townShipyardBuildCheck, townDockTile, boosterSpent, upgradeTargetOf, upgradeUnitCost,
  digForGrail, deliverGrail, grailKnown, obeliskProgress, buyWarMachine,
  dwellingCreature, recruitFromDwelling, dispatchCaravan, castAdventureSpell, decayedSiegeLoss,
  armyForDeploy,
  loanableBuildings, takeLoan,
  garrisonHolding, fortifyHolding, buyoutHolding, townPortalCanChoose,
  dailyIncome, parley, disbandStack, dimDoorLandable, learnGuildSpells,
} from '../core/actions.js';
import { armyValue, heroStat, heroMaxMana, heroMaxMovement } from '../core/heroUtils.js';
import { armyPower, creaturePower, physicalModel } from '../core/power.js';
import {
  isHolding, defenceOf, defenceValue, defenceLayer, isDefended, garrisonUnitCost, buyoutPrice,
} from '../core/holdings.js';
import { predictedFightLoss, parleyOffer, joinFeasible } from '../core/diplomacy.js';
import { bestSkillOption } from '../core/skillPolicy.js';
import { contextDefenderHero } from '../core/ronins.js';
import { aiLearnedSplitParts, aiCourageMult, pveSplitParts } from '../core/aiMemory.js';
import { aiLog } from './aiLog.js';
import { attachBattleTelemetry, recordBattleEnd } from './battleTelemetry.js';
import { findPath, isWalkable, makeWalkContext, monsterNear } from '../map/Pathfinding.js';
import { nearestTownOwner } from '../core/neutrals.js';
import { spellCost, adventureParam } from '../core/magic.js';
import { isExplored } from '../map/fog.js';
import { createBattle } from '../core/combat/CombatEngine.js';
import { autoResolve, chooseAIStances } from '../core/combat/CombatAI.js';
import { getSetting } from '../game/settings.js';

/** Build order per faction: first match that can be built wins the day. */
export const BUILD_ORDER = [
  'townHall', 'dwelling1', 'dwelling2', 'marketplace', 'blacksmith',
  'dwelling3', 'mageGuild1', 'cityHall', 'bank', 'citadel', 'dwelling4',
  'stables', 'shipyard', 'dwelling5', 'castle', 'dwelling6', 'resourceSilo',
  'dwelling2u', 'dwelling4u', 'capitol', 'dwelling7', 'dwelling3u',
  'dwelling1u', 'dwelling5u', 'dwelling6u', 'mageGuild2', 'dwelling7u',
  // The Altar is HERE, at the tail, and nothing in the AI uses it yet. That is on
  // purpose and on request: "the altar is an existing building in every town, I
  // would like it available for the AI players, but it is not necessary for them
  // to use it, until such a time when their logic sees a benefit." So a rival
  // realm can raise one — parity with the human's town — and it is placed last,
  // where it cannot take a day or 4,000 gold from the Castle or the Capitol. The
  // three transmuting rules that were built for it, and what each measured, are
  // recorded beside CONFIG.TRANSMUTE_EFFICIENCY.
  'altar',
  // The guild chain runs to FIVE. It used to stop at three, and mageGuild4/5 were
  // absent from this list altogether — so a tier-4 or tier-5 spell was
  // unreachable by construction, however the AI levelled. Measured over four
  // 90-day games before this line existed: 19 of 30 rival heroes held EXPERT
  // WISDOM, and not one town in any game ever raised a guild above tier 1, so
  // Dimension Door was never learned and never cast. The magic schools were
  // correctly worth the unlisted default to a realm that could not cast.
  'mageGuild3', 'mageGuild4', 'mageGuild5',
];

/**
 * Income-first variant (the `aiCapitolRush` setting): identical list, but the
 * Capitol (10000g → +2000 gold/day, a 5-day payback — the best ROI in the
 * catalog) moves up to right after its Castle prerequisite, and the Resource
 * Silo (5000g → ~250g/day equivalent, a ~20-day payback) drops below the
 * tier-7 dwelling. Measured motivation: the AI is income-bound — 42-60% of
 * its idle town-days are gold-blocked and 10-29% of weekly growth goes
 * unbought for want of gold, so pulling the realm's biggest income step a few
 * days earlier compounds. Off ⇒ the classic order above, unchanged.
 */
export const BUILD_ORDER_CAPITOL = [
  'townHall', 'dwelling1', 'dwelling2', 'marketplace', 'blacksmith',
  'dwelling3', 'mageGuild1', 'cityHall', 'bank', 'citadel', 'dwelling4',
  'stables', 'shipyard', 'dwelling5', 'castle', 'capitol', 'dwelling6',
  'dwelling2u', 'dwelling4u', 'dwelling7', 'resourceSilo', 'dwelling3u',
  'dwelling1u', 'dwelling5u', 'dwelling6u', 'mageGuild2', 'dwelling7u',
  // The Altar is HERE, at the tail, and nothing in the AI uses it yet. That is on
  // purpose and on request: "the altar is an existing building in every town, I
  // would like it available for the AI players, but it is not necessary for them
  // to use it, until such a time when their logic sees a benefit." So a rival
  // realm can raise one — parity with the human's town — and it is placed last,
  // where it cannot take a day or 4,000 gold from the Castle or the Capitol. The
  // three transmuting rules that were built for it, and what each measured, are
  // recorded beside CONFIG.TRANSMUTE_EFFICIENCY.
  'altar',
  // The guild chain runs to FIVE. It used to stop at three, and mageGuild4/5 were
  // absent from this list altogether — so a tier-4 or tier-5 spell was
  // unreachable by construction, however the AI levelled. Measured over four
  // 90-day games before this line existed: 19 of 30 rival heroes held EXPERT
  // WISDOM, and not one town in any game ever raised a guild above tier 1, so
  // Dimension Door was never learned and never cast. The magic schools were
  // correctly worth the unlisted default to a realm that could not cast.
  'mageGuild3', 'mageGuild4', 'mageGuild5',
];

// Attack only if own strength >= enemy * COURAGE. Exported so instruments can
// ask "how much of this map is open to that realm" with the AI's own bar rather
// than a copy of the number that can drift from it.
export const COURAGE = 1.3;
// Long sieges must end: the margin decays each week so late-game AIs commit
// instead of staring across the mountains forever.
function courageAt(day) {
  const week = weekOf(day);
  return Math.max(1.05, COURAGE - 0.05 * (week - 1));
}

/**
 * Tide of War (#11): during an opening grace period, damp the AI's appetite for
 * the player's towns/heroes (a multiplier on their desirability) so it explores
 * and develops instead of blitzing you early — room to build (and study). The
 * army-superiority gate (aggroMargin) is untouched, so the AI still won't walk
 * into a fight it can't win, and this lifts to 1 once the grace period ends, so
 * late-game aggression is unchanged. 1 in Classic.
 */
export function tideNoRushFactor(state) {
  if (!tideOfWar(state)) return 1;
  return weekOf(state.day) <= CONFIG.TIDE_NO_RUSH_WEEKS ? CONFIG.TIDE_NO_RUSH_AGGR : 1;
}

/**
 * Balance of Power (#9): each TEAM's share of the world's fielded MILITARY — the
 * summed armyValue of every non-defeated player's heroes and town garrisons
 * (treasury is deliberately excluded, so a rich-but-thin "paper lead" draws no
 * coalition). Pure. Returns { byTeam:Map, total, leaderTeam, leaderShare };
 * leaderTeam is -1 and leaderShare 0 when no military is on the board.
 */
export function militaryStandings(state) {
  const byTeam = new Map();
  const add = (owner, v) => {
    if (owner == null || owner < 0 || !v) return;
    const p = state.players?.[owner];
    if (!p || p.defeated) return;
    const team = p.team ?? owner;
    byTeam.set(team, (byTeam.get(team) || 0) + v);
  };
  for (const h of Object.values(state.heroes || {})) add(h.owner, armyValue(h.army || []));
  for (const t of Object.values(state.towns || {})) add(t.owner, armyValue(t.garrison || []));
  let total = 0, leaderTeam = -1, leaderVal = 0;
  for (const [team, v] of byTeam) {
    total += v;
    if (v > leaderVal) { leaderVal = v; leaderTeam = team; }
  }
  return { byTeam, total, leaderTeam, leaderShare: total > 0 ? leaderVal / total : 0 };
}

/**
 * The Balance-of-Power desirability bias for AI `playerIndex`, or null when the
 * feature is off, the board carries no military, no hegemon has emerged, or this
 * player's OWN team leads (a leader plays normally — it's the one ganged up on).
 * Otherwise returns (targetOwner) => multiplier: the leading team's holdings are
 * coveted (BOP_LEADER_BIAS), other rivals eased off (BOP_TRUCE_DAMP). This scales
 * DESIRABILITY only; callers keep the army-superiority gate, so no unwinnable pile-on.
 */
export function balanceOfPowerBias(state, playerIndex) {
  if (!featureOn(state, 'balanceOfPower')) return null;
  const st = militaryStandings(state);
  if (st.leaderTeam < 0 || st.leaderShare < CONFIG.BOP_HEGEMON_THRESHOLD) return null;
  const myTeam = state.players?.[playerIndex]?.team ?? playerIndex;
  if (st.leaderTeam === myTeam) return null; // (on) the leading team — no coalition bias
  return (owner) => {
    const team = state.players?.[owner]?.team ?? owner;
    return team === st.leaderTeam ? CONFIG.BOP_LEADER_BIAS : CONFIG.BOP_TRUCE_DAMP;
  };
}

// Enemy field armies within this many tiles of a town count as a threat to it.
const THREAT_RADIUS = 8;
// Threat memory: the PEAK enemy army value seen menacing a town is remembered
// on the town itself (town.aiThreat — plain serializable data, so it
// round-trips through save/load like hero.aiCooldowns) and fades linearly to
// zero over this many days once the menace is no longer seen at that
// strength. The memory is what turns defense into a real BUILD-UP: a
// besieger stepping just outside the radius for a day must not trick a
// turtling town into sallying into a fight it still cannot win — and once
// the enemy is gone for good, the memory decays and the AI goes back to work.
const THREAT_MEMORY_DAYS = 7;
// ---- Connector tuning (portals / subterranean gates / boats) --------------
// Flat crossing friction, in tiles, added to every via-connector route: it
// prices the transit step itself plus the risk of the unknown far side.
const CONNECTOR_CROSS = 3;
// Hysteresis: a connector's value is divided by this, so the far side must
// CLEARLY beat the hero's direct options before it crosses — the margin (and
// the fact that collected prizes are consumed) is what keeps a hero from
// flip-flopping through a gate whose two sides both look tasty.
const CONNECTOR_DAMP = 1.15;
// Per-hero, per-turn cap on connector transits (gate + portal + embark): a
// hard bound on how often a single hero may teleport/board in one turn, so no
// value oscillation can ever turn into a loop.
const MAX_TRANSITS_PER_TURN = 4;
// Shipyards: a hero buys at most ONE boat per turn, and only when real water
// value exists that no already-reachable boat serves (see considerConnectors).
// With the per-yard cross-day cooldown this makes build→sail→build churn
// impossible: builds are bounded by uncollected sea prizes, not by gold.
const MAX_BOAT_BUILDS_PER_TURN = 1;
// Extra route friction (in tiles) charged when the boat must first be BUILT:
// a free boat already afloat on the same water always outbids the shipyard.
const SHIPYARD_BUILD_FRICTION = 4;
// A hero counts as MAROONED (connectors become lifelines) only when it is
// genuinely stuck: nothing reachable AND its whole walkable pocket is tiny
// (a looted islet, a sealed chamber). A bored hero in open country must not
// get lifeline privileges — that would defeat the connector cooldowns.
const MAROONED_MAX_COMPONENT = 25;
// ---- Stuck / oscillation detection ----------------------------------------
// A hero that neither strays beyond STUCK_RADIUS of where it settled nor grows
// its army for STUCK_TURNS days is judged to be oscillating in place (the
// reported "bounces between 2-3 tiles for 20 turns"). We then plant an aiAvoid
// zone (STUCK_AVOID_RADIUS tiles) around that spot for STUCK_AVOID_DAYS days,
// so goal selection stops re-choosing the prize it provably can't reach and the
// hero looks elsewhere (or scouts). A hero turtling in a threatened town is
// doing its job, not stuck, and is exempt. Both aiAnchor and aiAvoid are plain
// serializable fields — they round-trip through save/load like hero.aiCooldowns.
const STUCK_TURNS = 6;
const STUCK_RADIUS = 2;
const STUCK_AVOID_RADIUS = 3;
const STUCK_AVOID_DAYS = 8;
// ---- Goal commitment ------------------------------------------------------
// Every goal is priced value / distance and RE-priced from scratch whenever the
// hero needs a plan. That formula has a period-2 limit cycle built into it: the
// goal a hero just walked away from grows in score as it recedes, so two prizes
// of comparable worth on opposite sides of a hero trade the lead every day and
// it paces between them forever, army unchanged, achieving nothing. (Measured:
// four of seven AI heroes across a 35-day campaign, one of them the map's
// strongest force.) The cure is commitment: a chosen goal is REMEMBERED on the
// hero (hero.aiGoal — plain serializable data, round-trips like aiCooldowns)
// and kept until it is achieved, invalidated, or beaten by a clear margin.
//
// The four numbers are gathered in one exported object because the only honest
// way to justify them is to run the campaign twice — see scripts/sim/goal-audit
// --control, which reproduces the pre-commitment AI exactly by neutralising
// them (margin 1, no progress clock, no strikes) and so measures the same seeds
// both ways. Nothing in the game mutates it; the defaults ARE the behaviour.
export const GOAL_TUNING = {
  // A challenger must out-score the incumbent by this factor to displace it, so
  // ties and near-ties always go to the incumbent and the re-score can never
  // flip on distance drift alone.
  hysteresis: 1.25,
  // Hold a goal this long without ever setting a new closest approach and it is
  // judged unreachable-in-practice, whatever the reason (a blocked approach, an
  // unenterable tile, a target that keeps moving). Deliberately reason-blind —
  // the failure is observable, the cause need not be.
  progressDays: 4,
  // A prize whose A* fails is blacklisted only for the CURRENT turn, so a hero
  // re-picked the same unreachable mine at dawn every day for a week — one tile
  // away, behind a guard's zone of control, forever "one more try". Fail on this
  // many separate days (retries within one turn count once) and it is shelved
  // like a stalled goal. Two, because three still leaves a 4-day pace-about,
  // and the acceptance bar for this work is three.
  failStrikes: 2,
  // How long a shelved goal stays off THIS hero's menu (hero.aiGoalBans — the
  // cross-turn cousin of the per-turn blacklist, which dies with the controller).
  banDays: 10,
};
// Strikes lapse if the target hasn't failed in this long — the world moves, and
// a route blocked last week may be open now.
const GOAL_FAIL_WINDOW = 6;
// How long a hero remembers how close it ever came to a given target. Without
// this the progress requirement is toothless against the commonest cycle: a
// hero that alternates A -> B -> A -> B re-commits to A fresh each time, so the
// "no progress in N days" clock restarts every other day and never rings. The
// clock has to run against the TARGET, not against one spell of pursuing it.
const GOAL_MEMORY_DAYS = 8;
// Cap on that memory, so a long game cannot grow it without bound.
const GOAL_MEMORY_MAX = 12;
// ---- Army consolidation ---------------------------------------------------
// The AI recruits well and concentrates badly. Measured across six campaigns:
// a third to a half of a realm's whole army value sits in town garrisons no
// hero is standing in — day 47 of the reported campaign, Red held 81,840 in the
// realm and 17,713 in its best hero. Under square-law attrition one 80k hero is
// worth far more than four 20k heroes, and nothing in the AI ever made that
// conversion. Three mechanisms, none of which recruits anything new:
//
//   · pickup on pass  — a hero standing in, or walking past, its own town takes
//     the garrison with it (and leaves its own worst stacks behind — seven slots
//     are the binding constraint, so what matters is WHICH seven it carries)
//   · a consolidation goal — when the realm is worth more than this multiple of
//     its best hero, that hero's job becomes fetching the biggest stock
//   · merge on meeting — a hero worth less than this share of an adjacent
//     friend's army hands its troops over and scouts instead
//
// A previous attempt at the same leak (`aiFrontCaravans`) moved the TROOPS to
// the hero and measured net-negative: the caravans cost tempo and arrived where
// the fighting had been. These move the HERO to the troops, or cost nothing at
// all because they happen where the hero already stands.
const CONSOLIDATE_TRIGGER = 2.0;
// What the fetch-the-garrison goal is worth: above ordinary loot, below the
// defensive goals (a town under siege still outranks a payday).
const CONSOLIDATE_SCORE = 10000;
const MERGE_SHARE = 0.2;
// THE CLAIM BOARD. What a target is worth to a hero when one of its own realm's heroes
// is already committed to it. There is one brain per realm and it orders its heroes
// strictly one at a time (see next()), so a later hero can always see what an earlier
// one chose — the information was there all along and the scoring simply never asked.
// A damp rather than an exclusion, because two heroes on one target is sometimes right:
// a town neither can take alone still wants both. Swept before it was chosen; see the
// ledger for the table.
const CLAIM_DAMP = 0.4;
// How far the fight that justifies a merge may be. A merge is only worth its cost if
// the thing it unlocks is close enough that the combined hero can actually go and take
// it before the board changes underneath them.
const CONCENTRATE_RADIUS = 14;
// Goals no hero may ever be shelved out of. Everything else on the board is a
// prize, and giving up on a prize costs nothing; riding home to a town under
// siege is the job, and a hero that failed to reach it twice (blocked road, a
// friend on the square) must be free to try again tomorrow.
const UNSHELVABLE_GOALS = new Set(['defend town', 'retreat to refuge', 'enshrine the Grail']);
// 8-neighbourhood, for the reachability floods (matches the A*'s directions).
const FLOOD_DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
// Wall clock for the next() time budget — performance.now() where it exists
// (browser and modern Node alike), Date.now() otherwise, the same guard the
// scenes use. Only ever read when a budget was actually passed.
const nowMs = () => ((typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Date.now());

// Market trading never drains the treasury below this — tomorrow needs gold too.
const GOLD_RESERVE = 1000;
// How far down a plan to look for a Dimension Door landing. The jump's own
// Chebyshev reach is at most sixteen tiles, but a path that bends can spend far
// more steps covering them; this only stops a very long plan from making the
// scan the expensive part of a turn.
const BLINK_SCAN = 64;
// Never sell a resource down to zero: future dwellings want wood and ore.
const RESOURCE_BUFFER = { wood: 5, ore: 5, mercury: 2, sulfur: 2, crystal: 2, gems: 2 };

/**
 * The stable identity of a goal, so "is this the same goal I had yesterday?" is
 * a string compare. A real target (town, hero, map object) is keyed by its id —
 * position alone would call a moving enemy hero a different goal every day. A
 * tile goal (scouting, a connector crossing, a Grail dig) is keyed by its tile.
 */
function goalKey(goal) {
  if (!goal) return null;
  if (goal.hold) return 'hold';
  const kind = goal.connector ? `${goal.connector} crossing` : (goal.what || 'scout');
  return `${kind}|${goal.id ?? `${goal.x},${goal.y},${goal.z ?? 0}`}`;
}

/** Human-readable name of a goal, for the log. */
function goalName(goal) {
  if (!goal) return 'nothing';
  if (goal.hold) return 'hold the town';
  return goal.connector ? `${goal.connector} crossing` : (goal.what || 'scout');
}

/** Rough worth of a tavern candidate: starting troops + useful starting skills. */
function hireScore(rosterId) {
  const def = HERO_ROSTER[rosterId];
  let v = 0;
  for (const [creatureId, min, max] of def.army) {
    v += ((CREATURES[creatureId]?.aiValue || 0) * (min + max)) / 2;
  }
  const bonus = { logistics: 400, estates: 300, offense: 150, armorer: 150, archery: 120, wisdom: 100 };
  for (const skillId of Object.keys(def.skills)) v += bonus[skillId] || 50;
  return v;
}

/**
 * Extra worth of re-hiring a SPECIFIC pooled veteran over a fresh recruit of
 * the same roster slot: its accumulated levels, learned skills, kept army and
 * carried artifacts. Added on top of hireScore so an experienced hero always
 * outbids a green one — the AI now prefers bringing a proven veteran back
 * (roadmap follow-up to the hero-persistence pool).
 */
function veteranValue(vet) {
  if (!vet) return 0;
  let v = 2000 * Math.max(0, (vet.level || 1) - 1);
  v += 800 * Object.keys(vet.skills || {}).length;
  v += armyValue(vet.army || []);
  v += 1500 * (Object.keys(vet.equipment || {}).length + (vet.backpack || []).length);
  return v;
}

/**
 * The fighting FORCE a just-hired candidate would actually bring to a besieged
 * town: a veteran's kept army if it has one, otherwise the fresh starting army
 * its roster rolls (which a re-hired armyless veteran also receives).
 *
 * POWER, not price: the one caller adds this to townDefenseValue and holds both
 * against townThreat, which reads in power (see the `physical` getter's
 * invariant note). veteranValue above stays a price on purpose — it ranks how
 * much a candidate is WORTH hiring, not whether a garrison can hold.
 */
function hireArmyForce(rosterId, vet, physical) {
  if (vet && (vet.army || []).some((s) => s && s.count > 0)) return armyPower(vet.army, physical);
  let v = 0;
  for (const [creatureId, min, max] of HERO_ROSTER[rosterId].army) {
    v += (creaturePower(creatureId, physical) * (min + max)) / 2;
  }
  return v;
}

/**
 * The garrison value this hero could ACTUALLY take, which is not the same thing
 * as the garrison's value. `addToArmy` merges into a matching stack or takes a
 * free slot; with seven slots full of seven different creatures a hero can
 * absorb nothing at all. Pricing the whole garrison anyway produced the exact
 * failure the goal-commitment work was chasing: a hero riding home for a pickup
 * it could not perform, every day for nine days, army frozen the whole time —
 * a goal it could reach and still never achieve. Same principle as gating
 * join-scaling on join feasibility: value the offer only if it can be accepted.
 */
function takeableGarrisonValue(town, hero) {
  const free = (hero.army || []).filter((s) => !s || s.count <= 0).length;
  const mine = new Set((hero.army || []).filter((s) => s && s.count > 0).map((s) => s.creature));
  let value = 0, slots = free;
  for (const stack of town.garrison || []) {
    if (!stack || stack.count <= 0) continue;
    if (mine.has(stack.creature)) { value += armyValue([stack]); continue; }
    if (slots > 0) { slots--; value += armyValue([stack]); }
  }
  return value;
}

/**
 * Deal two armies' troops out so `receiver` keeps the most valuable stacks it
 * has room for and `donor` keeps the rest. Value-preserving: every creature
 * ends up somewhere, nothing is created, nothing is destroyed.
 *
 * This replaces "take whatever happens to fit", which was the quiet half of the
 * concentration problem. A hero with seven slots of militia walking into a town
 * holding angels used to take NOTHING — `addToArmy` had no free slot and no
 * matching stack — and walk out again exactly as strong as it arrived. Seven
 * slots is the binding constraint on a realm's army, so the only question worth
 * asking at a town is WHICH seven the hero carries out.
 *
 * Same-creature stacks merge on the receiving stack's terms, exactly as
 * `addToArmy` does it (counts add, the target keeps its wound state), so no new
 * rule about damage is invented here.
 */
function consolidateInto(receiver, donor) {
  // Pool by creature kind, WITHOUT touching either array yet: this runs on
  // every step a hero takes near one of its towns, and an army quietly
  // re-sorted by value each time would be a systemic change to deployment
  // order that nobody asked for.
  const pooled = [];
  const byKind = new Map();
  const gather = (arr, home) => {
    for (let i = 0; i < arr.length; i++) {
      const st = arr[i];
      if (!st || st.count <= 0) continue;
      const seen = byKind.get(st.creature);
      if (seen) { seen.merged.push({ st, arr }); continue; }
      const entry = { st, home, slot: i, merged: [] };
      byKind.set(st.creature, entry);
      pooled.push(entry);
    }
  };
  gather(receiver, true);
  gather(donor, false);
  const worthOf = (e) => armyValue([e.st])
    + e.merged.reduce((n, m) => n + armyValue([m.st]), 0);
  pooled.sort((a, b) => worthOf(b) - worthOf(a)
    || (a.st.creature < b.st.creature ? -1 : 1)); // deterministic on exact ties
  const keep = pooled.slice(0, receiver.length);
  const leave = pooled.slice(receiver.length);
  // Nothing to do when the receiver already holds exactly these stacks and no
  // two stacks of the same creature need merging.
  if (!pooled.some((e) => e.merged.length)
      && keep.every((e) => e.home) && leave.every((e) => !e.home)) return 0;
  // Merge same-creature stacks on the surviving stack's terms — counts add and
  // the kept stack keeps its wound state, exactly as addToArmy does it.
  for (const e of pooled) {
    for (const m of e.merged) { e.st.count += m.st.count; m.arr[m.arr.indexOf(m.st)] = null; }
    e.merged.length = 0;
  }
  // Deal them out, leaving every stack in the slot it already occupied where it
  // can (so only what actually moved is disturbed).
  const deal = (arr, entries) => {
    const stay = new Set(entries.filter((e) => arr[e.slot] === e.st).map((e) => e.st));
    for (let i = 0; i < arr.length; i++) if (!stay.has(arr[i])) arr[i] = null;
    let cursor = 0;
    for (const e of entries) {
      if (stay.has(e.st)) continue;
      while (cursor < arr.length && arr[cursor]) cursor++;
      if (cursor < arr.length) arr[cursor++] = e.st;
    }
  };
  // The receiver's array is cleared of departures first, so a stack moving the
  // other way always finds a slot.
  for (let i = 0; i < receiver.length; i++) {
    if (receiver[i] && !keep.some((e) => e.st === receiver[i])) receiver[i] = null;
  }
  for (let i = 0; i < donor.length; i++) {
    if (donor[i] && !leave.some((e) => e.st === donor[i])) donor[i] = null;
  }
  deal(receiver, keep);
  deal(donor, leave);
  return keep.filter((e) => !e.home).length;
}

/**
 * Hand a town's garrison to a hero standing there — keeping the best seven
 * stacks between them and leaving the remainder in the town, which is strictly
 * better for the town than the old all-or-nothing sweep.
 */
function absorbGarrison(town, hero) {
  if (!hero || !town) return 0;
  const before = armyValue(hero.army);
  consolidateInto(hero.army, town.garrison);
  return armyValue(hero.army) - before;
}

/**
 * The single AI prize table (was three diverging copies across pickGoal,
 * bestThrough and pickBoatGoal, plus inline literals). Base worth of each map
 * prize before the ×eco collector weighting; obelisk* prices the grail-puzzle
 * bonus (see boosterScore). One table so a boat / through-connector hero can
 * never drift from a land hero's valuation again — and the natural seam for a
 * future per-difficulty override (difficulty currently touches only resources).
 */
/**
 * Effective-defense multiplier a town's fort tier (0 none · 1 Fort · 2 Citadel ·
 * 3 Castle) adds against a besieger. CALIBRATED by autoResolving sieges across
 * many seeds + army compositions: a bare Fort's walls merely REPLACE the open
 * field's obstacles (and the besieger always brings a Catapult), so it's ~even;
 * only a Citadel's moat/tower and a Castle's tougher walls + three towers move
 * the needle (a Castle needs ~1.2× the attacker value). See G62.
 */
const FORT_MULT = [1.0, 1.0, 1.05, 1.2];

// A safe rear town caravans its garrison to the front once it's worth at least
// this much army value (below it, the troops are better left to keep growing).
const CARAVAN_MIN_VALUE = 1500;

const PRIZE = {
  goldMine: 4000,
  mine: 2500,      // non-gold mine
  resource: 1200,
  chest: 1500,
  artifact: 2000,
  booster: 800,    // a plain booster, or a used/irrelevant obelisk
  obeliskBase: 1500, // an unread obelisk mid-grail-hunt: base …
  obeliskLead: 2500, // … + this × (obelisks seen / total), so the AI finishes the puzzle
  monster: 900,    // a beatable guard: free XP + opens the passes
  // A war-band that has NAMED one of our towns — a BASE, to which half the band's
  // force is added, exactly like 'defend town' (9000 + danger/2). A flat score was
  // tried first at 12000 and lost to a creature bank, because a bank is scored on its
  // reward and a good one is worth tens of thousands: pricing an emergency as a
  // constant puts it in the wrong league entirely. One rung UNDER 'defend town', so a
  // hero that can reach the walls in time prefers to fight behind them.
  bandAtOurGate: 8000,
};

export class AITurnController {
  /**
   * `observer: true` builds a controller that may only ASK, never TELL: pickGoal
   * scores the board and returns its ranking, but writes none of the goal
   * bookkeeping back (hero.aiGoal / aiGoalMemory / aiGoalBans, the aiLog rows,
   * goal commitment). It exists for exactly one caller — ai/adventureTelemetry
   * runs the scorer on the HUMAN's seat to rank the player's chosen destination
   * — and before it existed that diagnostic branded the human's heroes with AI
   * goal state on every move order, which then fed back through claimedTargets
   * into its own later answers. An observer's answer is a pure function of the
   * board, which is the only kind a reference class is allowed to be.
   */
  constructor(state, playerIndex, { observer = false } = {}) {
    this.state = state;
    this.playerIndex = playerIndex;
    this.observer = observer;
    this.townsDone = false;
    this.duskDone = false;
    this.heroQueue = null;
    this.currentHeroId = null;
    this.mainHeroId = null;
    this.stepsLeft = 0; // per-hero safety valve
    // Time-slicing (see next()): the current slice's deadline (0 = no budget,
    // never pause), and the hero whose march a pause interrupted — that hero's
    // per-turn preamble (updateStuck / merges / equipment / grail / portal)
    // must NOT run again on resume, because nothing happened in between and
    // running it twice is what would make a sliced turn diverge from an
    // unsliced one (updateStuck re-anchors on the mid-march position; a merge
    // could fire that the uninterrupted turn never saw).
    this._deadline = 0;
    this._resumeHeroId = null;
    this._sliceWork = 0; // units of work done in the current budgeted call
    this._slicePaused = false; // the previous next() ended in a slice pause
    this._plans = new Map(); // heroId -> { goal, path, cursor, z, onBoat }
    this._black = new Set(); // per-hero blacklisted goals, "heroId|x,y,z"
    this._transits = new Map(); // heroId -> connector transits this turn (capped)
    this._boatBuilds = new Map(); // heroId -> boats built this turn (capped at 1)
    this._used = new Map(); // heroId -> [{x,y,z}] endpoints of gates/portals used this turn
    this._reachCache = new Map(); // per-makePlan flood cache, "level|mode|x,y"
    this._throughCache = new Map(); // per-makePlan bestThrough cache, by connector id
    this._walkMasks = new Map(); // per-makePlan walkability grids, "level|mode" (see walkMaskCached)
    // Diagnostics (pinned by tests): proves goals/paths are cached, not
    // recomputed per tile. steps counts stepHero calls; transits counts
    // connector uses (portal/subGate teleports, boat embark/disembark).
    this.metrics = {
      goalPicks: 0, goalChanges: 0, pathfinds: 0, steps: 0, boatsBuilt: 0,
      // Consolidation: garrison pickups performed, value they moved into the
      // field, and hero-to-hero merges (see pickupOnPass / mergeAdjacentHeroes).
      pickups: 0, pickedUp: 0, merges: 0, concentrations: 0,
      // Territorial defence: gold committed to holding ground, and what it bought.
      defenceGold: 0, defenceBought: 0, fortified: 0, buyouts: 0, buyoutGold: 0,
      // Diplomacy: neutral bands enlisted for gold rather than fought.
      parleys: 0, parleyGold: 0, parleyEvictions: 0,
      // Dimension Door: jumps taken, and the movement they saved.
      blinks: 0, blinkSaved: 0, spellsLearned: 0,
      // whirlpool stays 0 by policy: a random destination is unpriceable, so
      // the AI never values one as a goal and never routes through one (see
      // considerConnectors + isWalkable). Counted anyway so sims can PROVE it.
      transits: { portal: 0, subGate: 0, embark: 0, disembark: 0, whirlpool: 0 },
    };
    // Diagnostic trail of connector transits this turn (pure data, like
    // moveLog): { heroId, type, channel, day }. Sims use it to prove no hero
    // ping-pongs through a gate/portal or re-boards in a loop.
    this.transitLog = [];
    // Diagnostic trail of shipyard boat builds this turn (a build is NOT a
    // transit — it has its own cap): { heroId, shipyardId, x, y, day }.
    this.buildLog = [];
    // ---- Flight recorder (src/ai/aiLog.js) ---------------------------------
    // The FIRST goal scan each hero makes this turn, keyed by hero id: what it
    // saw, what it chose, and the named gate that rejected everything it did
    // not. The first scan is the honest one — later retries are polluted by the
    // blacklist this turn's own failed pathfinds wrote.
    this._firstScan = new Map();
    this._lastGoals = [];   // the ranked candidate list from the most recent pickGoal
    // Mines this realm flagged during THIS turn (stepHero reports mineFlagged).
    this._minesFlagged = 0;
    // Town decisions worth recording, drained into the log at turn end.
    this._townNotes = [];
    // View-only trail of every hero tile-move this turn, so the scene can
    // replay AI movement as animation (drained between next() calls). Pure
    // data — the engine never reads it; it does not affect play or determinism.
    this.moveLog = [];
    // Team allegiance, so the AI never marches on an allied realm.
    this.myTeam = state.players[playerIndex]?.team ?? playerIndex;
    // Warlord temperament (see CONFIG.WARLORDS): three multipliers this
    // controller folds into goal scoring — `aggression` scales the raw
    // desirability of enemy towns/heroes, `economy` scales the eco weight on
    // resource prizes, `exploration` scales booster/obelisk pull. Missing or
    // unknown profile falls back to the neutral Tactician, so an old save (no
    // warlord field) plays exactly as before.
    const wl = state.players[playerIndex]?.warlord;
    this.warlord = (wl && CONFIG.WARLORDS[wl]) || CONFIG.WARLORDS.tactician;
  }

  teamOf(owner) {
    return owner >= 0 ? (this.state.players[owner]?.team ?? owner) : -1;
  }

  /** A hostile owner: a player on a different team (never self, never an ally).
   *
   *  While an apex horde is loose (Invasions), NO realm counts as an enemy. This
   *  is the "unite against the invader" clause, and it is deliberately routed
   *  through the one predicate every target choice already consults — heroes,
   *  towns, mines and threat assessment all stand down together, with no separate
   *  truce logic to fall out of sync. The war-bands are monsters, not players, so
   *  fighting THEM is untouched; and a human may break the peace, which the AI
   *  simply endures until the horde is gone. */
  /**
   * Is `town` a vassal's that I have sworn to defend?
   *
   * `terms.protect` is the half of the contract the suzerain owes, and until now
   * it was a promise with no behaviour behind it: the term was written into
   * every pact, read out to the player as "in exchange they expect to be
   * defended", and consulted by NOTHING in the codebase. Meanwhile the vassal
   * docks loyalty every week it loses a town under your banner — so the oath
   * punished a lord for failing an obligation the engine gave it no way to keep.
   * Measured over four three-player games with a pact standing: three vassal
   * towns lost, none of the suzerain's, and not one suzerain hero ever moved to
   * help.
   */
  protectedTown(town) {
    if (!town || town.owner < 0 || town.owner === this.playerIndex) return false;
    const pact = suzerainPact(this.state, town.owner);
    return !!(pact && pact.suzerain === this.playerIndex && pact.terms?.protect);
  }

  isEnemy(owner) {
    if (owner < 0 || owner === this.playerIndex) return false;
    // The truce is "unite against the invader", so it can never shelter or blind one.
    // Applied to every realm alike it inverted itself twice over: a people that came
    // ashore during a band truce saw no enemies at all and sat on its camps until the
    // window closed, and every local realm politely spared the invader it was
    // supposedly uniting against. A truce between two realms of this world only.
    const inv = this.state.players?.[this.playerIndex]?.invader
      || this.state.players?.[owner]?.invader;
    if (!inv && invasionTruce(this.state)) return false;
    return this.teamOf(owner) !== this.myTeam;
  }

  /** An allied owner: a different player on the same team. */
  isAlly(owner) {
    return owner >= 0 && owner !== this.playerIndex && this.teamOf(owner) === this.myTeam;
  }

  /**
   * Run until the turn ends, an interactive battle is needed, or (only when a
   * `budgetMs` is given) the slice's time is up — then { type: 'paused' },
   * and the next call resumes at the same spot. No budget means no clock is
   * ever read: headless callers keep the exact old contract.
   */
  next(budgetMs = 0) {
    const state = this.state;
    this._deadline = budgetMs > 0 ? nowMs() + budgetMs : 0;
    // Progress guard: a budgeted call must finish at least one unit of work
    // (one march iteration, or one hero wrapped up) before it may pause, or a
    // budget smaller than the smallest unit would pause forever without the
    // turn ever advancing. The checkpoints below all test this counter first.
    this._sliceWork = 0;
    // The early-out below is for a game decided BEFORE this turn (or in an
    // interactive battle the scene just resolved). It must NOT fire on a
    // slice resume: an uninterrupted turn keeps marching its remaining heroes
    // even after one of its own auto-battles decides the game mid-turn (that
    // is long-standing behavior every seeded game's rng stream depends on),
    // so a resumed turn has to do exactly the same or the sliced and unsliced
    // games diverge — caught by tests/ai-slicing.test.js on a seed where the
    // main hero's last fight finished the war and the second hero still had
    // its march to make.
    const sliceResume = this._slicePaused;
    this._slicePaused = false;
    if (!sliceResume && state.winner !== null) return { type: 'done' };

    if (!this.townsDone) {
      // Refresh each town's persistent threat memory FIRST: hiring, holding
      // and goal pricing below all read the same townThreat picture.
      this.updateThreatMemory();
      // Diplomacy before hero orders: a realm that is finished has a second verb, and
      // it has to be used before it spends another turn feeding heroes into a line it
      // cannot hold. Costs nothing in a game where nobody is cornered.
      this.maybeSeekTerms();
      this.manageTowns();
      this.townsDone = true;
      // Strongest army leads (and is the "main" for goal weighting); the
      // rest follow as collectors. Deterministic tie-break by hero id.
      const mine = playerHeroes(state, this.playerIndex);
      mine.sort((a, b) => armyValue(b.army) - armyValue(a.army)
        || (parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10))); // numeric: H9 before H10
      this.mainHeroId = mine.length ? mine[0].id : null;
      this.heroQueue = mine.map((h) => h.id);
    }

    while (true) {
      // Slice checkpoint: between heroes (and on re-entry after a mid-march
      // pause, before resuming that hero). Placed at the loop top so a resume
      // call re-evaluates nothing — the queue, the current hero and its plan
      // all sit exactly where the pause left them.
      if (this._deadline && this._sliceWork && nowMs() > this._deadline) {
        this._slicePaused = true;
        return { type: 'paused' };
      }
      if (!this.currentHeroId) {
        this.currentHeroId = this.heroQueue.shift();
        this.stepsLeft = 300;
        if (!this.currentHeroId) {
          this.duskEconomy();
          this.flushTurnLog();
          return { type: 'done' };
        }
      }
      const hero = state.heroes[this.currentHeroId];
      if (!hero) { this.currentHeroId = null; continue; } // died in interactive combat

      // Not on a slice resume: a level-up earned MID-march (a chest taken as
      // XP) stays pending until the turn's own later resolution points, and
      // resolving it here on every resume is exactly the kind of extra work
      // that made a sliced turn diverge from an unsliced one (caught by the
      // A/B in tests/ai-slicing.test.js: the sliced hero came out with four
      // skills where the uninterrupted one had two). After an interactive
      // battle the flag is not set, so the re-entry resolves as it always did.
      if (this._resumeHeroId !== hero.id) this.resolvePendingSkills(hero);

      const outcome = this.advanceHero(hero);
      if (outcome === 'heroDone') {
        this._sliceWork++; // a wrapped-up hero counts as progress (see above)
        this.flushHeroLog(hero); this.currentHeroId = null; continue;
      }
      if (outcome === 'paused') { // budget spent mid-march
        this._slicePaused = true;
        return { type: 'paused' };
      }
      if (outcome.type === 'combat') return outcome; // interactive battle vs human
    }
  }

  // ---- Flight recorder (see ai/aiLog.js) -----------------------------------

  /** Write this hero's turn — its decision and every gate that rejected a prize. */
  flushHeroLog(hero) {
    const scan = this._firstScan.get(hero.id);
    if (!scan) return;
    this._firstScan.delete(hero.id); // one entry per hero per turn
    aiLog(this.state, { kind: 'hero', player: this.playerIndex, ...scan });
  }

  /** Note a town decision worth reading back (built / blocked / hired / withheld). */
  noteTown(town, what) {
    this._townNotes.push({ town: town?.name || town?.id || 'a town', what });
  }

  /**
   * The realm's turn header, written LAST so it carries the day's outcome: how
   * many mines it actually flagged against how many exist. That single pair is
   * the headline — everything else in the log exists to explain it.
   */
  flushTurnLog() {
    const state = this.state;
    const me = state.players[this.playerIndex];
    const mines = this.mineCensus();
    // Town notes go in BEFORE the header. The viewer reads newest-first, so
    // last-written prints first — writing the header last is what puts it above
    // the turn it summarises instead of below it.
    for (const n of this._townNotes) {
      aiLog(state, { kind: 'town', player: this.playerIndex, ...n });
    }
    this._townNotes = [];
    aiLog(state, {
      kind: 'turn',
      player: this.playerIndex,
      name: me?.name || `P${this.playerIndex}`,
      towns: playerTowns(state, this.playerIndex).length,
      heroes: playerHeroes(state, this.playerIndex).length,
      gold: Math.round(me?.resources?.gold || 0),
      bestArmy: Math.round(this.myStrongestArmyValue()),
      strongestFoe: Math.round(this.strongestKnownEnemyArmy()),
      minesHeld: mines.mine,
      minesOnMap: mines.total,
      minesFlagged: this._minesFlagged,
    });
  }

  /** How many mines exist on both levels, and how many this realm holds. */
  mineCensus() {
    const state = this.state;
    let total = 0, mine = 0;
    for (const lvl of state.map.underground ? [0, 1] : [0]) {
      for (const obj of Object.values(levelObjects(state, lvl))) {
        if (obj.type !== 'mine') continue;
        total++;
        if (obj.owner === this.playerIndex) mine++;
      }
    }
    return { total, mine };
  }

  // ---- Diplomacy ---------------------------------------------------------

  /**
   * The second verb. A realm ground down to nothing has always had exactly one thing
   * to do with its turn — send another hero at the wall — and that is why suffocating
   * the AI to one town is the strongest play in the game. A realm that can read its
   * own position asks for terms instead.
   *
   * It asks the strongest realms first, because the deal it wants is protection and
   * only the strong can sell it. An AI lord that could actually back the oath takes it
   * on the spot, and the map gains a coalition without a line of scripting.
   *
   * The human is skipped in that loop for one reason: there is no channel yet for a
   * player to answer envoys, and signing a human's name to a contract they were never
   * shown is worse than any refusal. So if nobody will have them, the ask is recorded
   * against the strongest realm — the one that could have saved them and did not — and
   * the silence IS the refusal (see patrons.js: refuseTerms spends the patience clock,
   * and a fortnight later the money arrives from somewhere else). When the offer UI
   * exists, the human simply gets to answer instead, and nothing else changes.
   *
   * Announced either way. The player should get to watch a cornered realm go looking
   * for a lord and find none, because that is the foreshadowing that makes foreign
   * troops in its line an inference rather than a surprise.
   */
  maybeSeekTerms() {
    const state = this.state;
    const me = state.players[this.playerIndex];
    if (!me || me.defeated || me.isHuman) return null;
    // A people from outside the world does not ask anyone for terms.
    if (me.invader) return null;
    if (me.askedTermsDay != null && state.day - me.askedTermsDay < CONFIG.PACT_ASK_COOLDOWN_DAYS) {
      return null;
    }
    // A realm with nothing left to rule is a conquest, not a contract (wouldSeekTerms
    // carries the same clause, for the same measured reason).
    if (!playerTowns(state, this.playerIndex).length) return null;
    if (!wouldSeekTerms(state, this.playerIndex)) return null;

    const lords = state.players
      .filter((p) => !p.defeated && p.index !== this.playerIndex && (p.team ?? p.index) !== this.myTeam)
      .sort((a, b) => realmForce(state, b.index) - realmForce(state, a.index) || a.index - b.index);
    if (!lords.length) return null;
    me.askedTermsDay = state.day;

    // Strongest first, whoever they are — the deal it wants is protection, and only the
    // strong can sell it.
    for (const lord of lords) {
      // Never a people from outside the world. Handing your nation to the Huns is not a
      // thing you do because they are nearby and strong — it is what happens after they
      // have already ground you down and bought you, which is exactly the route
      // patrons.js settleDebt builds. Left open, an invader ashore is the strongest
      // realm on the map by an order of magnitude and would collect the banner of every
      // cornered realm within a week of landing, skipping the whole arc.
      if (lord.invader) continue;
      if (!wouldTakeVassal(state, lord.index, this.playerIndex).ok) continue;

      // A HUMAN is ASKED, and the offer waits on the table for an answer. There used to
      // be no channel to ask through, so the silence was read as a refusal — and a
      // chronicle showed what that cost: a rival at 0.96 cornered for twenty-three
      // straight days, 217,000 of troops locked in a garrison it could not move, no
      // possible patron on the board, just sitting there dying.
      if (lord.isHuman) {
        const offer = offerVassalage(state, this.playerIndex, lord.index);
        if (!offer) continue;
        logMsg(state, `${me.name} sends envoys to ${lord.name} asking for terms.`);
        (state.eventToasts ||= []).push(
          `${me.name} sends envoys asking to rule in your name — they keep their lands `
          + 'and send you a share of the proceeds. An answer is expected.',
        );
        return { asked: lord.index, answer: 'offered' };
      }

      const res = signPact(state, lord.index, this.playerIndex);
      if (!res.ok) continue;
      // signPact already logs the oath; the toast is what the player actually sees.
      (state.eventToasts ||= []).push(
        `${me.name} has sworn to ${lord.name} rather than be finished. They fight as one banner now.`,
      );
      return { asked: lord.index, answer: 'sworn' };
    }

    const strongest = lords[0];
    refuseTerms(state, strongest.index, this.playerIndex);
    logMsg(state, `${me.name} sends envoys to ${strongest.name} asking for terms.`);
    // Announced once per realm. The ask repeats on a cooldown for as long as they are
    // cornered — that is what keeps the refusal fresh — but the news is the same news,
    // and a toast every week from every squeezed realm buries the thing worth reading.
    if (!me.askedTermsSaid) {
      me.askedTermsSaid = true;
      (state.eventToasts ||= []).push(
        `${me.name} sends envoys asking for terms, and is given no answer. They will look elsewhere.`,
      );
    }
    return { asked: strongest.index, answer: 'silence' };
  }

  // ---- Towns -------------------------------------------------------------

  manageTowns() {
    const state = this.state;
    const towns = playerTowns(state, this.playerIndex);
    // Heroes before buildings: a second hero collects loot and ferries
    // recruits all week — it out-earns any single day's construction.
    for (const town of towns) this.maybeHireHero(town);
    // Holding what we have is part of managing the realm, not an afterthought.
    this.investInDefence();
    for (const town of towns) {
      // 1. Build (market-unblocking the priority build if resources allow).
      this.buildBest(town);
      // 2. Recruit everything we can afford, top tiers first. Deliberately NOT
      // less a banking reserve — see CONFIG's Town Bank block for the sweep that
      // killed that idea. The realm still earns interest on what it genuinely
      // cannot spend, which is the honest version of hoarding.
      for (let tier = 7; tier >= 1; tier--) {
        if (recruitableCreature(town, tier)) recruit(state, town, tier, town.available[tier] || 0);
      }
      // 3. Hand the garrison to a visiting hero about to march out. (If the
      // town is threatened, the hold rule in pickGoal keeps that hero — and
      // therefore these troops — home, so this never strips a besieged town.)
      if (town.visitingHeroId) {
        absorbGarrison(town, state.heroes[town.visitingHeroId]);
        this.buyMachinesFor(town);
      } else {
        // 4. No hero here to carry the troops out — caravan the idle garrison of
        // a SAFE rear town to the front instead of letting it sit (the old
        // ferry-hero yo-yo). Never strips a threatened town.
        this.maybeDispatchCaravan(town, towns);
      }
    }
  }

  /**
   * Buy a neutral band into the army instead of fighting it.
   *
   * The rival half of Diplomacy (#16). Until now `parley` was reached only from
   * the human's Fight/Parley dialog, so a rival hero that learned the skill got
   * one of its four effects and the human had a converter the AI could not
   * answer: measured with the feature on, an Expert diplomat turns 87% of the
   * map's encounters into recruitment.
   *
   * Priced with the SAME two anchors as maybeBuyOut, for the same reason — one
   * valuation of "what would this fight cost me", not two that can disagree:
   *
   *   BLOOD  `predictedFightLoss` runs the fight as a simulation and returns the
   *          army value this hero would actually lose, x PARLEY_PRICE_MULT (the
   *          rate at which gold buys lives).
   *   GOODS  what walks into the army if we pay. Blood alone is not enough,
   *          because against a walkover the predicted loss is 0 — and a walkover
   *          you can absorb whole is exactly the bargain worth taking. It is the
   *          same argument CONFIG.PARLEY_COST_SHARE makes from the seller's side.
   *
   * A rival prices its own offer — combatContext stamps ctx.parleyOffer only for
   * a human attacker — which is one auto-resolved battle per encounter. See the
   * note on that call below for what it was measured to cost.
   */
  /**
   * The army slot this hero would dismiss to make room for `monster`, or -1.
   *
   * Seven full slots is the real ceiling on a rival's parleying — 408 of 666
   * encounters in the sweep, against 135 stopped by an empty treasury. A human
   * clears a slot by hand on the hero sheet (HeroScene's shift-click disband);
   * this is the same trade, made by the same rule the AI already uses to decide
   * which of its stacks it values least (`armyValue` per stack, deterministic on
   * ties — see consolidateInto, which leaves the tail behind in a garrison).
   *
   * Refuses unless the band is a REAL upgrade — worth AI_PARLEY_EVICT_MARGIN
   * times what is thrown away. Dismissing creatures is irreversible, so a rival
   * that would trade forty Pikemen for forty-one is churning its army for
   * nothing, and doing it at every stack on the map.
   */
  evictionForParley(hero, monster) {
    const army = hero.army || [];
    if (joinFeasible(hero, monster)) return -1;   // kin, or an empty slot already
    // A hero may not dismiss its last stack (actions.disbandStack), and with
    // seven full slots that cannot bite — but the rule is the engine's, not this
    // caller's assumption about it.
    if (army.filter((st) => st && st.count > 0).length <= 1) return -1;
    let worst = -1, worstVal = Infinity;
    for (let i = 0; i < army.length; i++) {
      const st = army[i];
      if (!st || st.count <= 0) continue;
      const v = armyValue([st]);
      if (v < worstVal || (v === worstVal && worst >= 0 && st.creature < army[worst].creature)) {
        worst = i; worstVal = v;
      }
    }
    if (worst < 0) return -1;
    const coming = armyValue([{ creature: monster.creature, count: monster.count }]);
    if (coming < worstVal * CONFIG.AI_PARLEY_EVICT_MARGIN) return -1;
    return worst;
  }

  maybeParleyStack(hero, ctx) {
    const state = this.state;
    if (!featureOn(state, 'diplomacy')) return false;
    if (ctx?.defender?.kind !== 'monster') return false;
    const monster = getObject(state, ctx.defender.objectId);
    if (!monster) return false;
    // No room? Decide what we would give up FIRST, and bid as the army that would
    // then exist — a hero-shaped probe with the slot already free, rather than a
    // flag telling parleyOffer to pretend. The offer is then computed by exactly
    // the rules that will apply when it is taken up, and the invariant parleyOffer
    // is built on ("an offer the hero cannot accept is not an offer") is never
    // bent. Nothing is dismissed until the deal is agreed, far below.
    const evictIdx = this.evictionForParley(hero, monster);
    const bidder = evictIdx < 0 ? hero
      : { ...hero, army: hero.army.map((st, i) => (i === evictIdx ? null : st)) };
    // Priced HERE, not read off the context. combatContext stamps ctx.parleyOffer
    // only for a human attacker — the whole PvE-scaling block returns early for
    // the AI, deliberately and for measured reasons (see tideScaleDefender). So a
    // rival hero has to ask for itself. That is one auto-resolved battle per
    // monster encounter, and the offer carries its own `loss` back precisely so
    // it does not become two. Measured at 0.62ms an offer: an AI turn meeting
    // four wild bands pays 2.5ms against an 85ms mean, and a whole 45-day game
    // pays 0.10s. In a game without the feature it costs nothing at all — the
    // featureOn gate above returns before any of this.
    const offer = (evictIdx < 0 && ctx.parleyOffer) || parleyOffer(state, bidder, monster);
    // `acceptable` is the whole offer: they will deal, there is room, the
    // treasury covers it.
    if (!offer?.acceptable) return false;
    const me = state.players[this.playerIndex];
    // Never spend the last of the treasury on recruits: what is left has to
    // still buy troops and buildings tomorrow (the maybeBuyOut rule).
    if ((me.resources.gold || 0) - offer.price < CONFIG.AI_DEFENCE_GOLD_FLOOR) return false;
    // The alternative to paying is fighting with the army we have NOW, not with
    // the one an eviction would leave — two different armies, two different
    // numbers, and the whole decision is which of them is cheaper. The offer's
    // own `loss` is the probe's, so on the eviction path this asks again.
    const blood = (evictIdx < 0 ? (offer.loss || 0) : predictedFightLoss(state, hero, monster))
      * CONFIG.PARLEY_PRICE_MULT;
    const dropped = evictIdx < 0 ? 0 : armyValue([hero.army[evictIdx]]);
    const goods = (armyValue([{ creature: monster.creature, count: monster.count }]) - dropped)
      * CONFIG.AI_PARLEY_GOODS_RATE;
    if (offer.price > Math.max(blood, goods)) return false;
    // Now, and only now, clear the slot — and put it back if the deal somehow
    // does not close, so a refused parley can never cost a stack for nothing.
    const evicted = evictIdx < 0 ? null : hero.army[evictIdx];
    if (evicted && !disbandStack(hero.army, evictIdx)) return false;
    const res = parley(state, hero, monster);
    if (!res.ok) {
      if (evicted) hero.army[evictIdx] = evicted;
      return false;
    }
    if (evicted) this.metrics.parleyEvictions++;
    this.metrics.parleys++;
    this.metrics.parleyGold += res.price;
    aiLog(state, {
      kind: 'note',
      player: this.playerIndex,
      text: `${hero.name} paid ${res.price} gold to enlist ${res.count} ${monster.creature} `
        + `rather than fight them — the battle would have cost ${Math.round(offer.loss || 0)}`
        + (evicted ? `, and dismissed ${evicted.count} ${evicted.creature} to make room` : ''),
    });
    return true;
  }

  /**
   * Pay a garrison to march away instead of fighting it.
   *
   * The decision is priced in the currency the engine already uses for exactly
   * this question: `predictedFightLoss` runs the fight as a simulation and
   * returns the army value this hero would actually lose — the same function
   * that quotes a parley — and the buyout is worth it when the gold price is
   * under what that blood is worth. One valuation of "what would this fight
   * cost me", not two that can disagree.
   *
   * Gold is the resource a winning realm has too much of, so this is also where
   * a treasury turns back into tempo: a hero that pays keeps its army and its
   * week. The money goes to the DEFENDER, which is what makes it a transfer.
   */
  maybeBuyOut(hero, obj) {
    const state = this.state;
    if (!isHolding(obj) || !isDefended(obj)) return false;
    if (!this.isEnemy(obj.owner)) return false;
    const me = state.players[this.playerIndex];
    const price = buyoutPrice(state, obj);
    if (!price) return false;
    // Never spend the war chest on convenience: what is left has to still buy
    // troops and buildings tomorrow.
    if ((me.resources.gold || 0) - price < CONFIG.AI_DEFENCE_GOLD_FLOOR) return false;
    const stack = (obj.defence?.garrison || []).find((st) => st && st.count > 0);
    if (!stack) return false;
    const loss = predictedFightLoss(state, hero, {
      id: obj.id, creature: stack.creature, count: stack.count,
    });
    // Two anchors, and it pays at whichever is dearer.
    //
    // BLOOD — the same one a parley uses: what this fight would actually cost,
    // simulated, times the rate at which gold buys lives.
    //
    // YIELD — what the holding pays back over a horizon. The blood anchor alone
    // is not enough, because predictedFightLoss caps at the attacker's whole
    // army: a fight it would LOSE quotes the same number as one it would barely
    // survive, so a rich realm facing a garrison it cannot beat would refuse to
    // pay. That is backwards — buying what you cannot storm is precisely the
    // move this mechanism exists to sell, and it is where a treasury with
    // nothing to spend itself on turns back into ground.
    const yields = obj.type === 'mine' ? (CONFIG.MINE_INCOME[obj.mineType]?.gold || 0) : 0;
    const worth = Math.max(loss * CONFIG.PARLEY_PRICE_MULT, yields * CONFIG.DEFENCE_BUYOUT_HORIZON);
    if (price > worth) return false;
    const paid = buyoutHolding(state, hero, obj);
    if (!paid) return false;
    this.metrics.buyouts++;
    this.metrics.buyoutGold += paid;
    aiLog(state, {
      kind: 'note',
      player: this.playerIndex,
      text: `${hero.name} paid ${paid} gold rather than storm a garrison worth `
        + `${Math.round(defenceValue(obj))} — the fight would have cost ${Math.round(loss)}`,
    });
    return true;
  }

  /**
   * Put money into HOLDING what this realm has taken.
   *
   * Deliberately a policy rather than a script: the AI does not "defend the
   * mine at 12,7". It ranks its holdings by what they are worth to it — a gold
   * mine over a wood pit, a frontier holding over one deep behind the lines —
   * and spends a bounded share of spare gold down that list, garrison first,
   * walls only where a holding has already been fought over. Upkeep does the
   * rest: it cannot afford to defend everything, so it defends what pays.
   *
   * The frontier test reuses the same contested-ground reading the neutral peg
   * uses (neutrals.nearestTownOwner) — one definition of "how exposed is this
   * ground", not two that can disagree.
   */
  investInDefence() {
    const state = this.state;
    const me = state.players[this.playerIndex];
    if (!me) return;
    const budget = Math.floor(Math.max(0,
      (me.resources.gold || 0) - CONFIG.AI_DEFENCE_GOLD_FLOOR) * CONFIG.AI_DEFENCE_BUDGET_SHARE);
    if (budget <= 0) return;
    // Never buy a bill the realm cannot service. The one-off price above is
    // bounded by the treasury, but every body bought is also a STANDING daily
    // upkeep, and nothing here used to project it: a rich turn could commit the
    // realm to a deficit it then paid every dawn for the rest of the game (and
    // gold parked at zero buys no heroes, no buildings, no troops). dailyIncome
    // is the projection — its gold already nets the existing upkeep — so the
    // net headroom, in gold per day, is exactly how much MORE standing upkeep
    // this realm can afford to carry. A realm already at or below zero net adds
    // none. Deterministic (dailyIncome draws no rng), so this only moves which
    // purchases happen, never any seeded roll.
    let headroom = dailyIncome(state, me).gold || 0;
    if (headroom < CONFIG.DEFENCE_GARRISON_UPKEEP) return;
    const unit = garrisonUnitCost(state, this.playerIndex);
    const mine = [];
    for (const lvl of state.map.underground ? [0, 1] : [0]) {
      for (const obj of Object.values(levelObjects(state, lvl))) {
        if (!isHolding(obj) || obj.owner !== this.playerIndex) continue;
        // Worth defending in proportion to what it pays and how exposed it is.
        const income = obj.type === 'mine'
          ? (obj.mineType === 'goldMine' ? PRIZE.goldMine : PRIZE.mine)
          : PRIZE.mine * 0.6;
        const near = nearestTownOwner(state, obj.x, obj.y, lvl);
        const exposed = !near || near.owner !== this.playerIndex
          ? 1.5
          : 1 / (1 + (near.dist || 0) / 8);
        mine.push({ obj, lvl, worth: income * exposed, held: defenceValue(obj) });
      }
    }
    if (!mine.length) return;
    mine.sort((a, b) => (b.worth - b.held / 50) - (a.worth - a.held / 50));
    let spent = 0;
    for (const { obj } of mine) {
      if (spent + unit > budget) break;
      // A holding somebody has already fought over earns walls; the rest earn
      // bodies. (obj.defence.since is set every time it changes hands.) Bought
      // down to whichever runs out first: the one-off budget, or the daily
      // headroom the new bodies' upkeep will consume.
      const bodies = Math.min(
        Math.floor((budget - spent) / unit),
        Math.floor(headroom / CONFIG.DEFENCE_GARRISON_UPKEEP),
        Math.max(1, Math.round(CONFIG.DEFENCE_GARRISON_MAX / 4)),
      );
      if (bodies <= 0) break;
      const bought = garrisonHolding(state, obj, bodies);
      spent += bought * unit;
      headroom -= bought * CONFIG.DEFENCE_GARRISON_UPKEEP;
      this.metrics.defenceGold += bought * unit;
      if (bought > 0) this.metrics.defenceBought++;
      // Walls carry a daily maintenance line too (DEFENCE_FORTIFY_UPKEEP), so
      // they are gated on the same headroom as the bodies.
      if (defenceLayer(obj) === 'garrison' && budget - spent >= CONFIG.DEFENCE_FORTIFY_COST
          && headroom >= CONFIG.DEFENCE_FORTIFY_UPKEEP
          && (obj.defence?.contested || 0) > 0 && fortifyHolding(state, obj)) {
        spent += CONFIG.DEFENCE_FORTIFY_COST;
        headroom -= CONFIG.DEFENCE_FORTIFY_UPKEEP;
        this.metrics.defenceGold += CONFIG.DEFENCE_FORTIFY_COST;
        this.metrics.fortified++;
      }
    }
  }

  /**
   * The dusk economy pass — spend the day's loot before sleeping. Towns are
   * managed at DAWN (before the heroes march), so every chest, resource pile
   * and freshly-flagged mine the heroes collect during the day used to sit
   * idle overnight: measured across 8 factions × 12 seeds, 9–17% of all idle
   * town-days were "affordable by dusk, but the shops had closed" — a full
   * day of compounding lost on each. Re-running manageTowns after the LAST
   * hero finishes converts the day's loot into same-day builds, recruits and
   * hires. builtToday still caps construction at one per town per day, and
   * every purchase gate (reserves, courage holds) applies unchanged — this
   * adds a second shopping trip, never a second budget. Gated by the
   * `aiDuskEconomy` setting (read live, like aiStackSplit); off ⇒ classic
   * dawn-only behavior, byte-identical.
   */
  duskEconomy() {
    if (this.duskDone || !this.townsDone) return;
    this.duskDone = true;
    if (!getSetting('aiDuskEconomy')) return;
    this.manageTowns();
  }

  /**
   * Send a safe rear town's idle garrison overland to the most-threatened front
   * town. Gated hard: only when this town has no visiting hero AND is itself
   * unthreatened, so a besieged town's defenders are never marched away.
   * Peacetime (no front under threat): with the `aiFrontCaravans` setting on,
   * the garrison flows toward the MAIN hero's theatre instead of sitting home
   * — measured, 25–55% of the AI's fielded army value sat parked in rear
   * garrisons because troops only reach a hero through a town it passes, and
   * caravans only rolled when something was already threatened. Each hop must
   * bring the troops STRICTLY closer to the main hero (see frontTownFor), so
   * flows converge and never cycle. Off ⇒ classic threat-only caravans.
   */
  maybeDispatchCaravan(town, towns) {
    const state = this.state;
    if (this.townThreat(town) > 0) return;             // never strip a threatened town
    if (armyValue(town.garrison) < CARAVAN_MIN_VALUE) return; // not worth a caravan
    const level = town.z ?? 0;
    let dest = null, bestThreat = 0;
    for (const t of towns) {
      if (t.id === town.id || (t.z ?? 0) !== level) continue;
      const th = this.townThreat(t);
      if (th > bestThreat) { bestThreat = th; dest = t; }
    }
    // No front to reinforce — peacetime logistics (gated): route the idle
    // garrison toward the main hero so the week's growth actually fights.
    if (!dest && getSetting('aiFrontCaravans')) dest = this.frontTownFor(town, towns);
    if (!dest) return;
    // Send the most valuable garrison stack (others can follow on later turns).
    let slot = -1, best = 0;
    (town.garrison || []).forEach((st, i) => {
      if (!st || st.count <= 0) return;
      const v = (CREATURES[st.creature]?.aiValue || 0) * st.count;
      if (v > best) { best = v; slot = i; }
    });
    if (slot >= 0) dispatchCaravan(state, town, dest.id, slot, town.garrison[slot].count);
  }

  /** Our strongest field hero (armyValue, numeric-id tie-break — the same
   *  ordering next() uses to crown the main), or null with no heroes. */
  mainFieldHero() {
    let best = null, bestVal = -1;
    for (const h of playerHeroes(this.state, this.playerIndex)) {
      const v = armyValue(h.army);
      if (v > bestVal
          || (v === bestVal && best && parseInt(h.id.slice(1), 10) < parseInt(best.id.slice(1), 10))) {
        best = h; bestVal = v;
      }
    }
    return best;
  }

  /**
   * The peacetime caravan destination for `town`: the own town (same level —
   * caravans cannot cross levels) STRICTLY closer to the main hero than the
   * source is. Strict improvement makes every dispatch a step down the
   * distance gradient, so garrisons pool at the front and two towns can never
   * ping-pong a stack between them. Returns null when this town IS the front
   * (nothing closer), when no hero exists, or when no same-level sibling
   * qualifies — then the garrison stays home exactly as before.
   */
  frontTownFor(town, towns) {
    const main = this.mainFieldHero();
    if (!main) return null;
    const dist = (t) => Math.hypot(t.x - main.x, t.y - main.y);
    const level = town.z ?? 0;
    const dHome = dist(town);
    let best = null, bestD = Infinity;
    for (const t of towns) {
      if (t.id === town.id || (t.z ?? 0) !== level) continue;
      const d = dist(t);
      if (d < dHome && d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /**
   * Blink along the plan with Dimension Door instead of walking it.
   *
   * The AI cast exactly one adventure spell — Town Portal, and only in a panic,
   * to rush a hero home to a town about to fall. Dimension Door it never cast at
   * all, which is most of what Air Magic is for: at Expert it is four jumps a day
   * of up to sixteen tiles for two hundred movement each, against the roughly
   * sixteen hundred those tiles would cost on foot.
   *
   * The rule is simply "jump when it is cheaper than walking". Movement saved is
   * monotone in how far down the path the landing is, so the FURTHEST legal
   * landing is the best one, and a jump is only taken once walking there would
   * have cost more than the jump does. Landing legality is the engine's own
   * (`dimDoorLandable`, the same predicate that draws the human's targeting
   * overlay), so a rival can never blink somewhere a player could not — including
   * onto an object, into a guard's zone of control, or onto unexplored ground.
   */
  maybeBlink(hero, plan) {
    const state = this.state;
    if (!(hero.spells || []).includes('dimensionDoor')) return false;
    if ((hero.dimDoorUsed || 0) >= adventureParam(hero, 'dimensionDoor', CONFIG.DIM_DOOR_USES_BY_SCHOOL)) return false;
    const jumpMp = adventureParam(hero, 'dimensionDoor', CONFIG.DIM_DOOR_MP_BY_SCHOOL);
    if ((hero.mp || 0) < jumpMp) return false;
    if ((hero.mana || 0) < spellCost(hero, 'dimensionDoor')) return false;
    let walk = 0, best = -1;
    // A path may wander, so a tile far along it can still be inside the jump's
    // Chebyshev reach; the scan is bounded only so a very long plan cannot make
    // this the expensive part of a turn.
    const limit = Math.min(plan.path.length, plan.cursor + BLINK_SCAN);
    for (let i = plan.cursor; i < limit; i++) {
      walk += plan.path[i].cost || 0;
      if (walk <= jumpMp) continue;                 // no saving yet
      if (dimDoorLandable(state, hero, plan.path[i].x, plan.path[i].y)) best = i;
    }
    if (best < 0) return false;
    const to = plan.path[best];
    const res = castAdventureSpell(state, hero, 'dimensionDoor', { x: to.x, y: to.y });
    if (!res || !res.ok) return false;
    plan.cursor = best + 1;
    this.metrics.blinks++;
    this.metrics.blinkSaved += walk - jumpMp;
    return true;
  }

  /**
   * Kit a visiting hero with war machines at a Blacksmith — a cheap one-time
   * combat upgrade. Keeps a working gold reserve so it never starves the week's
   * recruiting, and buys the highest-impact machine (the Ballista) first.
   */
  buyMachinesFor(town) {
    const state = this.state;
    const player = state.players[this.playerIndex];
    if (!town.buildings.includes('blacksmith')) return;
    const hero = state.heroes[town.visitingHeroId];
    if (!hero) return;
    const RESERVE = 3000;
    for (const id of ['ballista', 'ammoCart', 'firstAidTent']) {
      if (hero.warMachines?.[id]) continue;
      const cost = CONFIG.WAR_MACHINES[id]?.cost.gold || 0;
      if (player.resources.gold - cost < RESERVE) continue;
      buyWarMachine(state, town, id);
    }
  }

  maybeHireHero(town) {
    const state = this.state;
    const player = state.players[this.playerIndex];
    if (!town.buildings.includes('tavern') || town.visitingHeroId) return;
    const heroes = playerHeroes(state, this.playerIndex);
    // One field army plus one collector per town is plenty; more heroes than
    // that just splits the week's recruits thin.
    const cap = 1 + playerTowns(state, this.playerIndex).length;
    if (heroes.length >= cap) return;
    // The hire must clearly fit the budget: keep enough gold behind to still
    // build today. A third-plus hero needs a fatter treasury to justify it.
    const reserve = heroes.length < 2 ? 1500 : 6500;
    if (player.resources.gold < CONFIG.HERO_COST + reserve) {
      this.noteTown(town, `no hire — gold ${Math.round(player.resources.gold)} under ${CONFIG.HERO_COST + reserve}`);
      return;
    }
    const pool = hireableHeroes(state, town);
    if (!pool.length) { this.noteTown(town, 'no hire — the tavern is empty'); return; }
    // Only weigh candidates we can still afford while keeping the reserve — a
    // high-level veteran costs a level premium (rehireCost), so it must fit.
    const affordable = pool.filter((id) => player.resources.gold - reserve >= hireCost(state, town, id));
    if (!affordable.length) { this.noteTown(town, 'no hire — nobody in the tavern fits the reserve'); return; }
    // Prefer a proven veteran (XP / skills / kept army / artifacts) over a fresh
    // recruit: hireScore prices the roster's starting kit, veteranValue adds
    // everything a returning hero brings on top.
    const scoreOf = (id) => hireScore(id) + veteranValue(pooledHero(state, this.playerIndex, id));
    let best = affordable[0];
    for (const id of affordable) if (scoreOf(id) > scoreOf(best)) best = id;
    // A town menaced by a superior force it cannot beat — even WITH this
    // hire's starting troops — is BUILDING UP, not sortieing: a fresh hero
    // hired here would only feed the besieger one week of cheap recruits at
    // a time. Pool the gold and the recruits into the garrison instead;
    // hiring resumes the moment the combined defense would clear the courage
    // bar (the new hero then absorbs the garrison and leads the sally).
    // Towns with no remembered threat hire exactly as before.
    const danger = this.townThreat(town);
    if (danger > 0) {
      const hireArmy = hireArmyForce(best, pooledHero(state, this.playerIndex, best), this.physical);
      if (this.townDefenseValue(town) + hireArmy < danger * courageAt(state.day)) {
        this.noteTown(town, `no hire — besieged (defence ${Math.round(this.townDefenseValue(town))} `
          + `vs threat ${Math.round(danger)}); banking the recruits into the garrison`);
        return;
      }
    }
    // FORCE CONCENTRATION. The gate above only fires for a town with a remembered
    // threat, so a realm losing the map at large kept hiring freely: it split one
    // army across four heroes of ~20k against a single 223k enemy and fed them out
    // one a day. While our best hero is outclassed by the strongest enemy field
    // army we know of, another hero makes the portions smaller, not the realm
    // stronger — bank the gold so the recruits go into one fist instead.
    const foe = this.strongestKnownEnemyArmy();
    if (foe > 0 && this.myStrongestArmyValue() < foe * CONFIG.AI_MASS_RATIO
        && playerHeroes(state, this.playerIndex).length >= CONFIG.AI_MIN_HEROES) {
      // …UNLESS that is also strangling the economy, which is the failure this
      // gate turned out to cause. Concentration is a military argument, and it
      // has nothing to say about a hero whose whole job is walking to a mine.
      // Once the player's army pulls ahead the gate latches on permanently, the
      // realm stops hiring collectors, its remaining heroes turtle in their
      // towns, and NOTHING flags a mine ever again — so it never earns the
      // income that would let it catch up. Reported exactly that way: "if they
      // do not flag mines they cannot keep up with production and economy".
      //
      // The exception is deliberately narrow: only while the realm holds less
      // than its fair share of the map's mines, only up to AI_ECON_HEROES, and
      // never at a town the besieger gate above already closed. One collector,
      // not an army split.
      if (!this.economyStarving()) {
        this.noteTown(town, `no hire — concentrating force (best ${Math.round(this.myStrongestArmyValue())} `
          + `vs foe ${Math.round(foe)})`);
        return;
      }
      if (playerHeroes(state, this.playerIndex).length >= CONFIG.AI_ECON_HEROES) {
        this.noteTown(town, `no hire — concentrating force; already fielding ${playerHeroes(state, this.playerIndex).length} `
          + `for the economy exception (cap ${CONFIG.AI_ECON_HEROES})`);
        return;
      }
      this.noteTown(town, 'hiring a collector anyway — the realm is losing the economy, not just the war');
    }
    hireHero(state, town, best);
    this.noteTown(town, `hired ${best}`);
  }

  /**
   * Is this realm's economy going backwards? True when unclaimed mines are still
   * out there AND we hold less than our fair share of the map's mines — "fair
   * share" being an even split among the realms still standing.
   *
   * The one question the force-concentration gate above needs an answer to: it
   * knows whether we are losing the WAR, and had no way to ask whether we were
   * also losing the ECONOMY, which is the thing that decides the war later.
   */
  economyStarving() {
    const { total, mine } = this.mineCensus();
    if (!total) return false;
    const realms = Math.max(1, (this.state.players || []).filter((p) => !p.defeated).length);
    const fairShare = total / realms;
    return mine < fairShare;
  }

  /**
   * Build the best available structure. The first BUILD_ORDER entry blocked
   * ONLY by resources is the build we actually want — try to close its gap on
   * the market before settling for something further down the list.
   */
  buildBest(town) {
    const state = this.state;
    const catalog = buildingCatalog(town.faction);
    let marketTried = false;
    const order = getSetting('aiCapitolRush') ? BUILD_ORDER_CAPITOL : BUILD_ORDER;
    for (const bid of order) {
      if (!catalog[bid]) continue;
      const reason = buildBlockReason(state, town, bid);
      if (!reason) {
        buildStructure(state, town, bid);
        return;
      }
      if (reason === 'Already built today') return;
      if (reason !== 'Not enough resources' || marketTried) continue;
      // Only the top priority earns a (lossy) market trade; anything lower
      // just waits its turn rather than bleeding the stockpile.
      marketTried = true;
      if (this.tryCoverCost(catalog[bid].cost)) {
        buildStructure(state, town, bid);
        return;
      }
      // Neither the treasury nor the market can raise it today — so borrow, if
      // the realm is still climbing toward its Capitol.
      if (this.tryFinance(town, bid)) return;
    }
  }

  /**
   * Finance the blocked priority build with a Town Bank loan (#17), but only
   * until the realm holds a Capitol.
   *
   * The bank's lending half existed for the whole of #17 and the AI never once
   * called it — half a feature, live only for the human. It should: measured
   * over 24 unmolested one-town realms, borrowing toward the Capitol reaches it
   * on day 28 instead of 33, earlier in 23 of 24 seeds, for a median 5,000 of
   * interest.
   *
   * TWO limits, both measured rather than guessed.
   *
   * It stops at the CAPITOL. Borrowing for everything afterwards financed
   * upgraded dwellings and resource silos, doubled the interest bill (10,750
   * against 5,000) and bought nothing: day-150 army value is the same either
   * way, because a realm's army is bounded by weekly creature growth, not by
   * gold. The Capitol is different — it is the one build whose income increment
   * (+2,000/day over a City Hall) repays a 10,000 principal in about a week.
   *
   * And it leans on the loan TERM, not on a cleverness check here. At the old
   * four weekly installments even this conservative policy defaulted once in 24
   * runs — and what the bank repossessed was the Capitol itself, which is a
   * catastrophic outcome for a realm that borrowed to build it. At eight (see
   * CONFIG.BANK_WEEKS) the same policy defaulted zero times in 24, and the
   * reckless borrow-everything policy also went from four repossessions to
   * none. Smaller installments, same total owed.
   *
   * Inert unless the townBank feature is on AND the town has built a Bank, so a
   * game without it draws nothing and behaves exactly as before.
   */
  tryFinance(town, buildingId) {
    const state = this.state;
    if (playerTowns(state, this.playerIndex).some((t) => (t.buildings || []).includes('capitol'))) return false;
    if (!loanableBuildings(state, town).includes(buildingId)) return false;
    return takeLoan(state, town, buildingId).ok === true;
  }

  /**
   * PURE feasibility of covering `cost` at the market — trades nothing, so
   * valuation can ask "could we afford this with a trade?" without side
   * effects. Conservative: needs a built marketplace, keeps a per-resource
   * buffer and a gold reserve, and only reports feasible when the WHOLE gap
   * closes (rates are lossy — a partial trade would just burn value). Returns
   * a { missing, surplus, goldShort } plan, or null when it can't be covered.
   */
  planCoverCost(cost) {
    const state = this.state;
    const player = state.players[this.playerIndex];
    const hasMarket = playerTowns(state, this.playerIndex)
      .some((t) => t.buildings.includes('marketplace'));
    if (!hasMarket) return null;

    const res = player.resources;
    let buyGold = 0;
    const missing = {};
    for (const r of RESOURCES) {
      if (r === 'gold') continue;
      const gap = (cost[r] || 0) - (res[r] || 0);
      // Rates scale with marketplace count, and marketTrade EXECUTES at the
      // scaled rate — so the planner must too, else it under-values its own
      // sells and dumps up to 2× the resources actually needed.
      if (gap > 0) { missing[r] = gap; buyGold += gap * marketBuyRate(state, player, r); }
    }
    // Gold needed to pay the cost AND the purchases AND keep the reserve.
    const goldShort = Math.max(0, (cost.gold || 0) + buyGold + GOLD_RESERVE - res.gold);
    let sellable = 0;
    const surplus = {};
    for (const r of RESOURCES) {
      if (r === 'gold' || missing[r]) continue;
      const spare = (res[r] || 0) - (cost[r] || 0) - (RESOURCE_BUFFER[r] || 0);
      if (spare > 0) { surplus[r] = spare; sellable += spare * marketSellRate(state, player, r); }
    }
    if (sellable < goldShort) return null;
    return { missing, surplus, goldShort };
  }

  /** Pure: would tryCoverCost succeed for `cost`? (no trades executed) */
  canCoverCost(cost) {
    return this.planCoverCost(cost) !== null;
  }

  /**
   * Make `cost` affordable via marketplace trades: sell surplus to fund the
   * gold shortfall, then buy the missing resources. Executes the plan from
   * planCoverCost (same conservative gates); returns true when cost is covered.
   */
  tryCoverCost(cost) {
    const plan = this.planCoverCost(cost);
    if (!plan) return false;
    const state = this.state;
    const player = state.players[this.playerIndex];

    // Sell just enough (fixed resource order), then buy.
    let need = plan.goldShort;
    for (const r of RESOURCES) {
      if (need <= 0) break;
      if (!plan.surplus[r]) continue;
      const rate = marketSellRate(state, player, r);
      const amount = Math.min(plan.surplus[r], Math.ceil(need / rate));
      if (marketTrade(state, player, 'sell', r, amount)) need -= amount * rate;
    }
    for (const r of Object.keys(plan.missing)) {
      if (!marketTrade(state, player, 'buy', r, plan.missing[r])) return false;
    }
    return canAfford(player, cost);
  }

  // ---- Heroes ------------------------------------------------------------

  /**
   * Move the current hero along its cached plan, re-planning only when the
   * plan completes, combat interrupts it, or a step is blocked.
   * Returns 'heroDone' or { type:'combat', context } for interactive fights.
   */
  advanceHero(hero) {
    const state = this.state;
    // The per-turn preamble runs when a hero's march BEGINS — and again after
    // an interactive battle re-enters here (the loot/army just changed, and
    // that re-run predates slicing). It must NOT run after a time-slice pause:
    // nothing happened in between, and re-running it is exactly what would
    // make a sliced turn diverge from an unsliced one (updateStuck would
    // re-anchor on the mid-march position; mergeAdjacentHeroes could fire a
    // merge the uninterrupted turn never saw).
    const sliceResumed = this._resumeHeroId === hero.id;
    this._resumeHeroId = null;
    if (!sliceResumed) {
      // Notice a hero that has been oscillating in place for days and plant an
      // avoid-zone so it stops re-chasing an unreachable prize (see updateStuck).
      this.updateStuck(hero);
      // Concentrate before marching: a friend standing next to this hero with a
      // token army hands it over (see mergeAdjacentHeroes).
      this.mergeAdjacentHeroes(hero);
      // Wear the best gear we carry before marching (and again after combat
      // loot below) — an artifact in the backpack helps nobody.
      this.optimizeEquipment(hero);

      // Grail: a hero standing on the buried tile ends its turn there — digging
      // it up when a full day remains (the dig costs the whole day), else standing
      // fast so it can dig at next dawn. Whoever reaches it does this, not just the
      // main hero (the pursuit is main-only; the dig-in-place is universal).
      if (this.tryGrailDig(hero)) return 'heroDone';

      // AI Town Portal (#13, opt-in): recall home to defend a town under threat the
      // hero couldn't otherwise reach in time — the strategic-spell edge the human
      // has always had, now the AI's too. Casting it (and defending) spends the turn.
      if (this.maybeTownPortalHome(hero)) return 'heroDone';
    }

    while (hero.mp > 0 && this.stepsLeft-- > 0) {
      // Slice checkpoint: between steps, before this iteration does anything —
      // so a march that re-plans repeatedly (blocked path, transit chains)
      // still yields every iteration, and the worst uninterrupted block is one
      // plan + one step + one auto-battle. The loop condition above already
      // took this iteration's tick off the stepsLeft valve; pausing means the
      // iteration never happened, so the tick is refunded — the resumed run
      // re-enters the condition exactly once, as the uninterrupted run did.
      if (this._deadline && this._sliceWork && nowMs() > this._deadline) {
        this.stepsLeft++;
        this._resumeHeroId = hero.id;
        return 'paused';
      }
      this._sliceWork++; // this iteration is now committed — it is the progress
      // Passing through — or beside — one of our own towns? Take the garrison
      // along, and leave the stacks we value less in its place.
      this.pickupOnPass(hero);

      let plan = this._plans.get(hero.id);
      // A transit (gate/portal/boat) or interactive combat can leave the hero
      // on another level or movement mode than the cached path was computed
      // for — such a plan is stale, never resumable.
      if (plan && (plan.z !== (hero.z ?? 0) || plan.onBoat !== !!hero.onBoat)) {
        this._plans.delete(hero.id);
        plan = null;
      }
      if (!plan || plan.cursor >= plan.path.length) {
        plan = this.makePlan(hero);
        if (!plan) return 'heroDone';
        if (plan.hold) return 'heroDone'; // standing guard IS this turn's job
        this._plans.set(hero.id, plan);
      }
      // Cheaper than walking? Then do not walk (see maybeBlink). The plan is
      // advanced past the tiles the jump covered, so the next iteration simply
      // carries on from where the hero landed.
      if (this.maybeBlink(hero, plan)) continue;
      const step = plan.path[plan.cursor];
      // A defended holding on the next tile: pay it off if that is cheaper than
      // the fight (see maybeBuyOut). Costs no movement — paying IS faster than
      // storming — and the hero simply walks in next iteration.
      {
        const ahead = levelObjects(state, hero.z ?? 0)[
          tileAt(state, step.x, step.y, hero.z ?? 0)?.objectId];
        if (ahead && this.maybeBuyOut(hero, ahead)) continue;
      }
      // A retreat must not walk into the arms of what it is fleeing (see
      // stepEntersReach). Stopping short leaves movement unspent, which is the
      // right trade: the hero is running because it loses the fight.
      if (this.isRetreating(hero) && this.stepEntersReach(hero, step)) return 'heroDone';
      // Water Walk / Fly heroes may only stop on land, so entering water needs
      // enough MP to reach the far shore this move (stepReserve); inert for
      // every other hero (returns the plain step cost).
      if (hero.mp < stepReserve(state, hero, plan.path, plan.cursor)) return 'heroDone';

      const fx = hero.x, fy = hero.y, fz = hero.z ?? 0;
      const ev = stepHero(state, hero, step);
      this.metrics.steps++;
      // View-only trail: single-tile SURFACE hops only (the scene replays
      // these as tile glides; a portal/gate teleport is not an animatable hop
      // and underground marches are not on the surface view).
      const mdx = Math.abs(hero.x - fx), mdy = Math.abs(hero.y - fy);
      if ((mdx || mdy) && mdx <= 1 && mdy <= 1 && fz === 0 && (hero.z ?? 0) === 0) {
        this.moveLog.push({ heroId: hero.id, from: { x: fx, y: fy }, to: { x: hero.x, y: hero.y } });
      }
      switch (ev.type) {
        case 'noMp':
          return 'heroDone';
        case 'blocked':
          // Something moved into the cached path (or sits on the goal).
          // Drop the plan and blacklist the goal so a fresh plan doesn't
          // immediately re-pick an unreachable prize.
          this._plans.delete(hero.id);
          this.blacklist(hero, plan.goal);
          continue;
        case 'blockedExit':
          // The connector fired but its far end is occupied — the hero stands
          // on the entry. Cool the connector down for this turn and re-plan.
          this._plans.delete(hero.id);
          this.blacklist(hero, { x: hero.x, y: hero.y, z: fz });
          continue;
        case 'embark':
          // Aboard: the cached (foot) plan is void — re-plan in boat mode
          // from the water, in this same turn. Blacklists encode "unreachable
          // from where I stood"; the mode change makes them stale.
          this.noteTransit(hero, 'embark', `${hero.x},${hero.y}`);
          this.clearHeroBlacklist(hero);
          this._plans.delete(hero.id);
          continue;
        case 'disembark': {
          this.metrics.transits.disembark++;
          this.transitLog.push({ heroId: hero.id, type: 'disembark', channel: `${hero.x},${hero.y}`, day: state.day });
          // Landing auto-claims the tile's prize (e.g. an islet reward); a
          // chest needs the AI's gold-vs-XP policy applied by hand.
          if (ev.landed?.type === 'chest') {
            resolveChest(state, hero, ev.landed.objectId, state.day < 14 ? 'gold' : 'xp');
          }
          this.clearHeroBlacklist(hero);
          this._plans.delete(hero.id);
          continue;
        }
        case 'whirlpool': {
          // Never chosen on purpose: a random destination is unpriceable, so
          // whirlpools are not connector goals (considerConnectors skips
          // them) and auto-path never routes a boat through one (isWalkable).
          // Pure defense should a swirl ever fire anyway: the hero has been
          // relocated, so the cached plan is void — book the transit (the
          // per-turn cap bounds even a pathological chain of swirls, and
          // metrics.transits.whirlpool lets sims prove the policy holds) and
          // re-plan from wherever the sea spat us out.
          this.noteTransit(hero, 'whirlpool', `${ev.from.x},${ev.from.y}`);
          this.clearHeroBlacklist(hero);
          this._plans.delete(hero.id);
          continue;
        }
        case 'portal':
        case 'subGate': {
          // Teleported: drop the stale plan and re-plan from the far side in
          // this same turn. Stale position-bound blacklists are wiped, but
          // BOTH endpoints of every gate/portal pair used this turn stay
          // cooled down — the classic A→B→A ping-pong is impossible. A short
          // CROSS-turn cooldown (stored on the hero, so it survives the
          // per-turn controller) also stops the slow variant: shuttling back
          // through the same pair day after day while nothing is gained.
          this.noteTransit(hero, ev.type, ev.channel);
          const used = this._used.get(hero.id) || [];
          used.push({ x: ev.from.x, y: ev.from.y, z: ev.from.level ?? fz });
          used.push({ x: ev.to.x, y: ev.to.y, z: ev.to.level ?? (hero.z ?? 0) });
          this._used.set(hero.id, used);
          const cds = hero.aiCooldowns || (hero.aiCooldowns = {});
          for (const k of Object.keys(cds)) if (cds[k] < state.day) delete cds[k];
          cds[`${ev.type}|${ev.channel}`] = state.day + 1; // blocked through tomorrow
          this.clearHeroBlacklist(hero);
          this._plans.delete(hero.id);
          continue;
        }
        case 'shipyard': {
          // Standing on a shipyard. Build ONLY when this yard was the plan's
          // destination (a priced boat-build goal) and the hero still has its
          // one build of the turn — then re-plan: the fresh boat is now an
          // adjacent connector and the normal embark path boards it. A yard
          // merely walked across is just a tile.
          const g = plan.goal;
          if (g.connector === 'shipyard' && hero.x === g.x && hero.y === g.y
              && (this._boatBuilds.get(hero.id) || 0) < MAX_BOAT_BUILDS_PER_TURN) {
            let built = buildBoat(state, hero, ev.objectId);
            // Wood/gold short on arrival? The valuation only priced this yard
            // because the market could cover BOAT_COST — so trade for the
            // shortfall now (buy the 10 wood, fund it from surplus) and retry.
            // buildBoat never charges on failure, and tryCoverCost only trades
            // when it fully closes the gap, so a refused trade just falls
            // through to the blacklist below (no half-spent stockpile).
            if (built.type === 'boatBuildFailed' && built.reason === 'cost'
                && this.tryCoverCost(CONFIG.BOAT_COST)) {
              built = buildBoat(state, hero, ev.objectId);
            }
            this._plans.delete(hero.id);
            if (built.type === 'boatBuilt') {
              this.metrics.boatsBuilt++;
              this._boatBuilds.set(hero.id, (this._boatBuilds.get(hero.id) || 0) + 1);
              this.buildLog.push({ heroId: hero.id, shipyardId: ev.objectId, x: built.x, y: built.y, day: state.day });
              // Cross-day cooldown, exactly like a used gate: the yard is off
              // the menu through tomorrow, so no build→sail→build shuttling.
              const cds = hero.aiCooldowns || (hero.aiCooldowns = {});
              for (const k of Object.keys(cds)) if (cds[k] < state.day) delete cds[k];
              cds[`shipyard|${ev.objectId}`] = state.day + 1;
            } else {
              // The world moved since valuation (dock clogged, treasury spent
              // on a town build): cool the yard off and pick something else.
              this.blacklist(hero, g);
            }
            continue;
          }
          plan.cursor++;
          break;
        }
        case 'enterTown': {
          // Entered a town. When this square was a townShipyard goal (a
          // home-port boat build priced by considerConnectors), build now and
          // re-plan — the fresh boat at the town's dock is an ordinary boat
          // connector and the normal embark path boards it. Any other town
          // entry is just a step along the path.
          const g = plan.goal;
          if (g.connector === 'townShipyard' && hero.x === g.x && hero.y === g.y) {
            this._plans.delete(hero.id);
            // The world can move between valuation and arrival (dock clogged,
            // treasury spent): a refused build cools the goal off instead.
            if (!this.buildTownBoat(hero, state.towns[ev.townId])) this.blacklist(hero, g);
            continue;
          }
          // Carrying the Grail into an OWN town enshrines it (raises the
          // Grail structure) — the deliver half of the fetch quest.
          if (hero.carryingGrail) {
            const town = state.towns[ev.townId];
            if (town && town.owner === this.playerIndex) deliverGrail(state, hero, town);
          }
          plan.cursor++;
          break;
        }
        case 'chest':
          // Money early, XP once an economy exists.
          resolveChest(state, hero, ev.objectId, state.day < 14 ? 'gold' : 'xp');
          plan.cursor++;
          break;
        case 'seerHut':
          // Pay and collect. The hut refuses on its own if the world moved
          // between valuation and arrival (another hero spent the resource, or a
          // warband has nowhere to stand) — take the refusal and walk on rather
          // than blacklisting, since it may well be payable next turn.
          if (!ev.done && ev.canFulfill) {
            const got = fulfillSeerQuest(state, hero, ev.objectId);
            if (got.ok) { this.resolvePendingSkills(hero); this.optimizeEquipment(hero); }
          }
          plan.cursor++;
          break;
        case 'tradingPost':
          this.tradeAtPost(hero, ev.objectId);
          plan.cursor++;
          break;
        case 'dwelling': {
          // Flagged the site on arrival; now buy every creature we can afford
          // and fit — free army is the whole reason we marched here.
          const dw = levelObjects(state, hero.z ?? 0)[ev.objectId];
          if (dw) recruitFromDwelling(state, hero, dw, dw.available || 0);
          plan.cursor++;
          break;
        }
        case 'combat': {
          // Combat invalidates the plan either way: armies, loot and the map
          // may all have changed before we act again.
          this._plans.delete(hero.id);
          const defenderOwner = this.combatDefenderOwner(ev.context);
          if (defenderOwner >= 0 && state.players[defenderOwner].isHuman) {
            return { type: 'combat', context: ev.context }; // human defends interactively
          }
          // A neutral guard may be BOUGHT rather than fought — the same fork the
          // human is offered. Hooked HERE rather than before the step, because
          // this is the one place that sees every way a hero comes to blows with
          // a wild stack: walking onto its tile, attacking it directly, and being
          // waylaid by its zone of control. It also arrives holding the encounter
          // the battle would actually run, offer already priced on it.
          //
          // The plan is already deleted above, so the cleared tile is re-planned
          // and walked next iteration exactly as it is after a won fight.
          if (this.maybeParleyStack(hero, ev.context)) break;
          this.autoFight(ev.context);
          if (!state.heroes[hero.id]) return 'heroDone'; // hero fell
          this.resolvePendingSkills(hero);
          this.optimizeEquipment(hero); // wear fresh loot immediately
          break;
        }
        default:
          // The one outcome the flight recorder exists to count.
          if (ev.type === 'mineFlagged') this._minesFlagged++;
          plan.cursor++;
          break; // moved / pickup / mineFlagged / enterTown / visited
      }
      if (state.winner !== null) return 'heroDone';
    }
    return 'heroDone';
  }

  /**
   * Pick a goal and compute its full path ONCE. Unreachable goals are
   * blacklisted and the next-best tried, a bounded number of times.
   * Returns { goal, path, cursor, z, onBoat } | { hold: true } | null.
   */
  makePlan(hero) {
    const state = this.state;
    // One reachability flood per plan: which tiles this hero can actually
    // walk/sail to right now. It prices connectors honestly (only prizes the
    // far side really reaches count) and spots a marooned hero. Both caches
    // hold for the whole plan — the world cannot change between goal retries.
    this._reachCache = new Map();
    this._throughCache = new Map();
    this._walkMasks = new Map();
    const reach = this.floodCached(hero.x, hero.y, hero.z ?? 0, !!hero.onBoat);
    for (let tries = 0; tries < 24; tries++) {
      const goal = hero.onBoat ? this.pickBoatGoal(hero, reach) : this.pickGoal(hero, reach);
      if (!goal) return null;
      if (goal.hold) return goal;
      // A hero that BEGAN the turn on its own town square cannot path to a
      // townShipyard goal there (findPath rejects start === goal): build
      // right here instead, then retry — the fresh boat prices as a plain
      // boat connector on the next pick and the embark path boards it.
      // (Cooldown + per-turn cap + boatAtDock keep the port off the retries.)
      if (goal.connector === 'townShipyard' && goal.x === hero.x && goal.y === hero.y) {
        if (!this.buildTownBoat(hero, this.state.towns[goal.townId])) this.blacklist(hero, goal);
        continue;
      }
      this.metrics.pathfinds++;
      const found = findPath(state, hero, goal.x, goal.y, -1);
      if (!found || !found.path.length) {
        this.noteGoalFailure(hero, goal);
        this.blacklist(hero, goal);
        continue;
      }
      return { goal, path: found.path, cursor: 0, z: hero.z ?? 0, onBoat: !!hero.onBoat };
    }
    return null;
  }

  /**
   * Execute a value-priced boat build at an own town's Shipyard building —
   * the arrival half of a 'townShipyard' goal (see considerConnectors), also
   * reached directly when the hero already stands at home (makePlan). Applies
   * the SAME guards as the map-yard build: one boat per hero per turn, a
   * market trade to close a gold/wood shortfall the valuation already priced
   * (canCoverCost), metrics/buildLog bookkeeping, and a cross-day per-town
   * cooldown so no build→sail→build shuttling is possible. Returns true when
   * a boat was actually launched; the caller re-plans so the normal embark
   * path boards it.
   */
  buildTownBoat(hero, town) {
    const state = this.state;
    if (!town) return false;
    if ((this._boatBuilds.get(hero.id) || 0) >= MAX_BOAT_BUILDS_PER_TURN) return false;
    let built = buildBoatAtTown(state, town);
    // Gold/wood short on arrival? The valuation only priced this port because
    // the market could cover BOAT_COST — trade the gap closed and retry.
    // buildBoatAtTown never charges on failure and tryCoverCost only trades
    // when it fully closes the gap, so a refused trade costs nothing.
    if (built.type === 'boatBuildFailed' && built.reason === 'cost'
        && this.tryCoverCost(CONFIG.BOAT_COST)) {
      built = buildBoatAtTown(state, town);
    }
    if (built.type !== 'boatBuilt') return false;
    this.metrics.boatsBuilt++;
    this._boatBuilds.set(hero.id, (this._boatBuilds.get(hero.id) || 0) + 1);
    this.buildLog.push({ heroId: hero.id, townId: town.id, x: built.x, y: built.y, day: state.day });
    // Cross-day cooldown, exactly like a used map yard: this home port is off
    // the menu through tomorrow, so no build→sail→build shuttling.
    const cds = hero.aiCooldowns || (hero.aiCooldowns = {});
    for (const k of Object.keys(cds)) if (cds[k] < state.day) delete cds[k];
    cds[`townShipyard|${town.id}`] = state.day + 1;
    return true;
  }

  /** Record one connector transit (drives the per-turn cap and diagnostics). */
  noteTransit(hero, type, channel) {
    this.metrics.transits[type]++;
    this._transits.set(hero.id, (this._transits.get(hero.id) || 0) + 1);
    this.transitLog.push({ heroId: hero.id, type, channel, day: this.state.day });
  }

  /** Resolve pending level-ups by scoring the offered options (see weights). */
  resolvePendingSkills(hero) {
    const state = this.state;
    while (hero.pendingSkillChoices?.length) {
      chooseSkill(state, hero, bestSkillOption(hero, hero.pendingSkillChoices[0].options,
        (id) => featureOn(state, id)));
    }
  }

  /**
   * Equip the best available artifact into every socket. giveArtifact only
   * auto-equips into FREE sockets, so combat loot and upgrades pile up in the
   * backpack — sweep them on. `value` (treasure tier) is the one scale all
   * artifacts share. Strictly-better swaps only, so this is churn-free and
   * terminates (each swap raises a socket's value; the guard is a backstop).
   */
  optimizeEquipment(hero) {
    const state = this.state;
    let changed = true;
    let guard = 24;
    while (changed && guard-- > 0) {
      changed = false;
      for (const socket of Object.keys(EQUIP_SOCKETS)) {
        const slot = EQUIP_SOCKETS[socket];
        const curId = hero.equipment[socket];
        const curVal = curId ? (ARTIFACTS[curId]?.value || 0) : -1;
        let bestIdx = -1, bestVal = curVal;
        for (let i = 0; i < hero.backpack.length; i++) {
          const art = ARTIFACTS[hero.backpack[i]];
          if (!art || art.slot !== slot) continue;
          if (art.value > bestVal) { bestVal = art.value; bestIdx = i; }
        }
        if (bestIdx >= 0 && equipArtifact(state, hero, bestIdx, socket)) changed = true;
      }
    }
  }

  /**
   * Do business at a Trading Post: buy the upgrades, sell the surplus.
   *
   * The order is the whole method. Wear what we already carry FIRST, so the
   * backpack afterwards holds only gear this hero has declined; then buy, in
   * descending rarity, anything that beats a socket and we can pay for, wearing
   * each purchase before pricing the next (two shields on the shelf must not
   * both read as upgrades); then wear once more, and only then sell whatever is
   * still in the pack. Selling before buying would hand over a relic and buy it
   * back at a loss, and selling before the final wear would sell the thing we
   * just bought.
   *
   * A sale is experience, so it can level the hero — hence resolvePendingSkills
   * afterwards, exactly as a won battle does.
   */
  tradeAtPost(hero, objectId) {
    const state = this.state;
    const obj = getObject(state, objectId);
    if (!obj || obj.type !== 'tradingPost') return;
    const player = state.players[this.playerIndex];
    this.optimizeEquipment(hero);

    // Buy: richest band first, re-reading the sockets after each purchase.
    const wanted = [...(obj.stock || [])]
      .filter((id) => ARTIFACTS[id])
      .sort((a, b) => (ARTIFACTS[b].value || 0) - (ARTIFACTS[a].value || 0));
    for (const id of wanted) {
      const art = ARTIFACTS[id];
      const worst = Object.keys(EQUIP_SOCKETS)
        .filter((sk) => EQUIP_SOCKETS[sk] === art.slot)
        .reduce((n, sk) => Math.min(n, ARTIFACTS[hero.equipment[sk]]?.value ?? -1), Infinity);
      if (!(art.value > worst)) continue;
      if (!canAfford(player, tradingPostBuyCost(id))) continue;
      if (buyArtifactAt(state, hero, objectId, id).ok) this.optimizeEquipment(hero);
    }

    // Sell: whatever the hero still refuses to wear.
    const surplus = [...(hero.backpack || [])];
    if (surplus.length) {
      const sold = sellArtifactsForXp(state, hero, surplus);
      if (sold.ok && sold.levels > 0) this.resolvePendingSkills(hero);
    }
  }

  combatDefenderOwner(ctx) {
    const state = this.state;
    if (ctx.defender.kind === 'hero') return state.heroes[ctx.defender.heroId]?.owner ?? -1;
    if (ctx.defender.kind === 'town') return state.towns[ctx.defender.townId]?.owner ?? -1;
    return -1; // neutral monster
  }

  autoFight(ctx) {
    const state = this.state;
    const attacker = state.heroes[ctx.attackerHeroId];
    const cfg = {
      attacker: { hero: attacker, army: armyForDeploy(attacker.army), playerIndex: attacker.owner },
      defender: {
        // A ronin standing with the defender commands an otherwise leaderless side,
        // and is deliberately not in state.heroes (it is nobody's).
        hero: contextDefenderHero(state, ctx),
        army: ctx.defenderArmy,
        playerIndex: this.combatDefenderOwner(ctx),
      },
      defenseBonus: ctx.defenseBonus || 0,
      features: state.features,
      upgrades: playerUpgrades(state),
      siegeTowerDamage: getSetting('siegeTowerDamage'),
      aiStackSplit: getSetting('aiStackSplit'),
      aiSplitParts: aiLearnedSplitParts(state),
      pveSplitParts: pveSplitParts(state),
      humanSide: -1, // AI-vs-AI/neutral: no human seat, so both sides may split
    };
    // AI Battle Formations: both sides here are computer-run, so each picks the
    // stance its odds call for (all-in as underdog, hold as favorite). The odds
    // come off fixed-seed simulations — state.rng is only consumed by the real
    // battle below, and with the setting off no stance is set (classic press).
    if (getSetting('aiBattleFormations')) {
      const st = chooseAIStances(cfg);
      if (st.attacker) cfg.attacker.stance = st.attacker;
      if (st.defender) cfg.defender.stance = st.defender;
    }
    const battle = createBattle({ rng: state.rng, ...cfg });
    ctx.battleSeed = battle.seed;   // replayable on its own (see createBattle)
    // An auto-resolved fight is the one nobody watches, which makes it the one
    // most worth recording: every decision in it is the AI's alone, so the
    // candidate sets here are the cleanest read on the evaluator there is.
    const battleId = attachBattleTelemetry(battle, state, {
      humanSide: -1,
      owners: [cfg.attacker?.playerIndex ?? -1, cfg.defender?.playerIndex ?? -1],
      context: 'autoresolve',
    });
    const result = autoResolve(battle);
    recordBattleEnd(battle, state, battleId, { attackerWon: result.attackerWon ?? null, humanWon: null });
    const events = applyCombatResult(state, ctx, result);
    // A chest won under a guard's zone of control surfaces a chestUnderGuard
    // event for a caller to resolve. There is no scene here to offer the
    // gold-vs-XP dialog, so apply the AI's own chest policy (gold early to
    // build an economy, XP once one exists) — otherwise the prize is dropped.
    for (const ev of events) {
      if (ev.type === 'chestUnderGuard') {
        const h = state.heroes[ev.heroId];
        if (h) resolveChest(state, h, ev.objectId, state.day < 14 ? 'gold' : 'xp');
      }
    }
  }

  // ---- Goal selection ------------------------------------------------------

  // ---- Army consolidation (Phase B) ---------------------------------------

  /**
   * Pickup on pass. A hero standing in — or walking past — one of its own towns
   * takes the garrison with it, keeping the best seven stacks between them.
   *
   * The old rule fired only on the town SQUARE, so a hero that marched around a
   * town it owns left the week's recruits sitting there, and a realm's army
   * quietly settled into its garrisons: a third to a half of it, measured. This
   * costs no movement — it happens where the hero already is — so unlike a
   * caravan it cannot lose the realm tempo. Note that adjacency is an AI-side
   * affordance: a human must enter the town to trade troops.
   *
   * Two guards. A town another friendly hero is holding is not raided (that
   * hero's garrison is its business), and a town under threat is not stripped by
   * someone merely walking past — only by a hero actually standing in it, which
   * is the turtle case the hold rule already governs.
   */
  pickupOnPass(hero) {
    const state = this.state;
    const z = hero.z ?? 0;
    for (const town of playerTowns(state, this.playerIndex)) {
      if ((town.z ?? 0) !== z) continue;
      const inside = hero.inTownId === town.id;
      if (!inside && Math.max(Math.abs(town.x - hero.x), Math.abs(town.y - hero.y)) > 1) continue;
      if (town.visitingHeroId && town.visitingHeroId !== hero.id) continue;
      if (!inside && this.townThreat(town) > 0) continue;
      // Don't empty the town the main hero was sent to empty. A collector that
      // hoovers up the stock on its way past turns the consolidation errand into
      // a wasted march and scatters the realm's army again, one wagon at a time.
      if (hero.id !== this.mainHeroId && this.isConsolidationTarget(town)) continue;
      const gained = absorbGarrison(town, hero);
      if (gained > 0) {
        this.metrics.pickups++;
        this.metrics.pickedUp += gained;
      }
      // AND THE SPELLBOOK. This loop already counts a hero ADJACENT to its own
      // town as being at it — that is how it hands over the garrison — but it
      // only ever took the troops, and a hero standing at its own guild's gate
      // rode off without reading a page. Measured over four 90-day games: two
      // towns held Dimension Door in their guilds and eighteen rival heroes had
      // the Expert Wisdom to learn it, and not one ever did, so the spell was
      // never cast and Air Magic was worth nothing to the AI. A hero already
      // INSIDE has been taught by enterTown; this is the one beside the wall.
      const learned = learnGuildSpells(state, town, hero);
      if (learned.length) this.metrics.spellsLearned += learned.length;
    }
  }

  /**
   * The targets this realm's OTHER heroes are already committed to.
   *
   * Read straight off `hero.aiGoal.key` — the same identity `goalKey` mints for the
   * goal list — so there is no new state, nothing to serialize and nothing that can
   * disagree with what the heroes are actually doing. It covers both a hero that
   * committed days ago and is still marching and one that committed a moment ago in
   * this same turn, because heroes are ordered one at a time and the queue is sorted
   * strongest-army-first: the main hero claims, and the collectors plan around it.
   */
  claimedTargets(self) {
    const out = new Set();
    for (const h of playerHeroes(this.state, this.playerIndex)) {
      if (self && h.id === self.id) continue;
      if (h.aiGoal?.key) out.add(h.aiGoal.key);
    }
    return out;
  }

  /**
   * Is this town the errand the main hero is currently riding for? Read off the
   * committed goal itself (hero.aiGoal), so there is one source of truth about
   * what the realm is trying to do rather than two that can disagree.
   */
  isConsolidationTarget(town) {
    const main = this.mainHeroId ? this.state.heroes[this.mainHeroId] : null;
    const goal = main?.aiGoal;
    return !!goal && goal.type === 'consolidate' && goal.targetId === town.id;
  }

  /**
   * Merge on meeting. Two friendly heroes standing next to each other, one worth
   * under MERGE_SHARE of the other, are one strong hero and one courier pretending
   * to be two armies. The weaker hands its troops over and carries on as a scout
   * — the engine already supports an escort-less hero (it simply cannot start a
   * fight), which is exactly what a scout is.
   *
   * Only ever weaker → stronger, so this is monotone and cannot ping-pong.
   */
  mergeAdjacentHeroes(hero) {
    const state = this.state;
    const z = hero.z ?? 0;
    for (const other of playerHeroes(state, this.playerIndex)) {
      if (other.id === hero.id || (other.z ?? 0) !== z) continue;
      if (Math.max(Math.abs(other.x - hero.x), Math.abs(other.y - hero.y)) > 1) continue;
      const mine = armyValue(hero.army), theirs = armyValue(other.army);
      if (mine <= 0 && theirs <= 0) continue;
      const [strong, weak] = mine >= theirs ? [hero, other] : [other, hero];
      const small = Math.min(mine, theirs), big = Math.max(mine, theirs);
      // Two COMPARABLE heroes normally stay two armies — that is the collector economy
      // and it pays. The exception is a fight standing in front of them that neither
      // can take alone and both together can. `consider` vetoes any goal whose guard
      // beats the hero's own army (AIPlayer's guard gate), so such a target is not
      // contested between them — it is INVISIBLE TO BOTH, and no amount of goal
      // deconfliction can reveal it. Concentrating is the only way the realm can ever
      // express "together we could take that".
      const forWhat = small > big * MERGE_SHARE ? this.worthConcentratingFor(strong, weak) : null;
      if (small > big * MERGE_SHARE && !forWhat) continue;
      // Count and log only when troops actually MOVED. The guard above skips
      // only when BOTH sides are empty, so a strong hero standing beside the
      // armyless scout this very function created fell through here every turn
      // — small = 0, consolidateInto moved nothing, and merges++ plus a fresh
      // "hands its command" note ran anyway, ~2 spurious rows per adjacent pair
      // per turn into the bounded aiLog. Gated on the value gained, the same
      // way pickupOnPass gates on absorbGarrison's gain — NOT on
      // consolidateInto's return value, which counts only stacks that changed
      // OWNERSHIP and so reads 0 for a genuine same-creature transfer.
      const beforeVal = armyValue(strong.army);
      consolidateInto(strong.army, weak.army);
      if (armyValue(strong.army) <= beforeVal) continue;
      this.metrics.merges++;
      if (forWhat) this.metrics.concentrations++;
      aiLog(state, {
        kind: 'note',
        player: this.playerIndex,
        text: forWhat
          ? `${weak.name || weak.id} reinforces ${strong.name || strong.id} `
            + `(${Math.round(small)} into ${Math.round(big)}) — together they can take ${forWhat}`
          : `${weak.name || weak.id} hands its command to ${strong.name || strong.id} `
            + `(${Math.round(small)} into ${Math.round(big)}) and rides on as a scout`,
      });
    }
  }

  /**
   * Is there a fight beside these two that NEITHER can take alone and BOTH could?
   *
   * This is the whole justification for concentrating comparable heroes, and it has to
   * be a SPECIFIC target rather than a policy: "always mass up" would dismantle the
   * collector economy, which is real income. Returns a short description of what the
   * merge unlocks (for the log), or null.
   *
   * Only fights, never loot: a prize does not need concentration, it needs a walk. The
   * things listed here are the ones the guard gate refuses — an enemy or neutral town,
   * an enemy hero, a war-band at our own gate, a creature bank.
   */
  worthConcentratingFor(a, b) {
    const state = this.state;
    // POWER on both sides: `unlocks` holds these against townDefenseValue,
    // enemyHeroValue, bandForce and bankValue().guard, all of which read in
    // power. (mergeAdjacentHeroes' own MERGE_SHARE test stays a price — it
    // compares the two OWN armies to each other, where any one currency is
    // consistent and price is the ledger the merge log reports in.)
    const va = armyPower(a.army, this.physical), vb = armyPower(b.army, this.physical);
    const best = Math.max(va, vb), combined = va + vb;
    if (combined <= best) return null;
    const margin = courageAt(state.day) * aiCourageMult(state);
    const z = a.z ?? 0;
    const near = (x, y) => Math.hypot(x - a.x, y - a.y) <= CONCENTRATE_RADIUS;
    // Neither alone, both together — anything else is not a reason to merge.
    const unlocks = (guard) => guard > 0 && best < guard * margin && combined >= guard * margin;

    for (const town of Object.values(state.towns)) {
      if ((town.z ?? 0) !== z || town.owner === this.playerIndex || this.isAlly(town.owner)) continue;
      if (!near(town.x, town.y)) continue;
      if (unlocks(this.townDefenseValue(town))) return town.name || town.id;
    }
    for (const h of Object.values(state.heroes)) {
      if ((h.z ?? 0) !== z || !this.isEnemy(h.owner)) continue;
      if (!near(h.x, h.y)) continue;
      if (unlocks(this.enemyHeroValue(h))) return h.name || h.id;
    }
    for (const obj of Object.values(levelObjects(state, z))) {
      if (!near(obj.x, obj.y)) continue;
      if (obj.invader) {
        if (this.bandMenacesUs(obj) && unlocks(bandForce(obj, this.physical))) return obj.invader.peopleName || 'the invaders';
        continue;
      }
      if (obj.type === 'creatureBank' && !obj.looted && unlocks(this.bankValue(obj).guard)) {
        return bankDef(obj.bankType)?.name || 'the bank';
      }
    }
    return null;
  }

  /**
   * The town this hero should go and empty, when the realm is holding its
   * strength in the wrong hands: the biggest stock this hero could actually
   * carry (feasibility priced at selection time — see takeableGarrisonValue),
   * and only once the realm is worth more than CONSOLIDATE_TRIGGER times its
   * best hero. Returns { town, value } or null.
   */
  consolidationTarget(hero) {
    const state = this.state;
    const heroes = playerHeroes(state, this.playerIndex);
    const towns = playerTowns(state, this.playerIndex);
    let best = 0, realm = 0;
    for (const h of heroes) { const v = armyValue(h.army); realm += v; if (v > best) best = v; }
    for (const t of towns) realm += armyValue(t.garrison);
    if (best <= 0 || realm <= best * CONSOLIDATE_TRIGGER) return null;
    let target = null, value = 0;
    for (const t of towns) {
      if ((t.z ?? 0) !== (hero.z ?? 0) || hero.inTownId === t.id) continue;
      if (t.visitingHeroId && t.visitingHeroId !== hero.id) continue;
      const v = takeableGarrisonValue(t, hero);
      if (v > value) { value = v; target = t; }
    }
    return target ? { town: target, value } : null;
  }

  /**
   * Cross-turn stuck detection. A blacklist lives for a single turn (the
   * controller is rebuilt every turn), so nothing stops a hero re-picking the
   * same out-of-reach prize day after day and shuffling between the same two
   * or three tiles. This notices that: a hero that neither strays beyond
   * STUCK_RADIUS of where it settled nor grows its army for STUCK_TURNS days is
   * oscillating in place. We plant an aiAvoid zone around that spot (consulted
   * by pickGoal via isAvoided) so goal selection looks elsewhere, and reset the
   * clock. A hero turtling in a threatened home town is doing its job, not
   * stuck — its anchor just resets, and defensive goals bypass the zone anyway.
   * aiAnchor/aiAvoid are plain serializable fields (round-trip like aiCooldowns).
   */
  updateStuck(hero) {
    const state = this.state;
    const z = hero.z ?? 0;
    const val = armyValue(hero.army);
    const a = hero.aiAnchor;
    const town = hero.inTownId ? state.towns[hero.inTownId] : null;
    const defending = town && town.owner === this.playerIndex && this.townThreat(town) > 0;
    const moved = a && (a.z !== z || Math.hypot(hero.x - a.x, hero.y - a.y) > STUCK_RADIUS);
    const grew = a && val > a.val;
    if (!a || defending || moved || grew) {
      hero.aiAnchor = { x: hero.x, y: hero.y, z, day: state.day, val };
      return;
    }
    if (state.day - a.day >= STUCK_TURNS) {
      hero.aiAvoid = { x: a.x, y: a.y, z, until: state.day + STUCK_AVOID_DAYS };
      hero.aiAnchor = { x: hero.x, y: hero.y, z, day: state.day, val };
    }
  }

  // ---- Goal commitment -----------------------------------------------------

  /**
   * How far this hero still is from a remembered goal. Infinity across map
   * levels — a surface hero has made no progress toward an underground tile,
   * whatever the plane coordinates say.
   */
  goalDistance(hero, g) {
    if (!g || g.x == null) return Infinity;
    if ((g.z ?? 0) !== (hero.z ?? 0)) return Infinity;
    return Math.hypot(g.x - hero.x, g.y - hero.y);
  }

  /**
   * Has this hero's remembered goal been ACHIEVED? Distinguishing "I took it"
   * from "it left the board" is the difference between healthy goal turnover
   * and the churn this whole mechanism exists to stop, so the log has to be
   * able to tell them apart. Ids carry their own namespace: T… town, H… hero,
   * CV… caravan, O…/U… map object.
   */
  goalAchieved(hero, g) {
    const state = this.state;
    const id = g.targetId;
    if (id) {
      if (id[0] === 'T') {
        const t = state.towns[id];
        return !!t && hero.x === t.x && hero.y === t.y && (hero.z ?? 0) === (t.z ?? 0);
      }
      if (id[0] === 'H') return !state.heroes[id];
      if (id.startsWith('CV')) return !(state.caravans || []).some((c) => c.id === id);
      const obj = getObject(state, id);
      if (!obj) return true;
      return obj.owner === this.playerIndex || !!obj.looted;
    }
    return g.x != null && hero.x === g.x && hero.y === g.y && (hero.z ?? 0) === (g.z ?? 0);
  }

  /**
   * Goal commitment — the rule that turns a ranking into a decision.
   *
   * pickGoal re-prices every candidate from the hero's CURRENT position, so the
   * ranking is not a stable preference: walk a day toward a far prize and the
   * one behind you gains score purely by receding. Left alone that is a
   * period-2 limit cycle, and it is the one the campaign log caught — heroes
   * pacing between two tiles for days with a frozen army.
   *
   * So the incumbent goal is defended, three ways:
   *   · it is KEPT while it remains a live candidate,
   *   · a challenger must beat its CURRENT score by GOAL_TUNING.hysteresis to displace
   *     it, so ties and near-ties always go to the incumbent,
   *   · and it must earn its keep: a goal that has not set a new closest
   *     approach in GOAL_TUNING.progressDays is abandoned and shelved, whatever the
   *     reason it could not be reached.
   * Returns the candidate this hero should pursue (or null when the board is
   * empty). May drop a shelved incumbent from `candidates` in passing.
   */
  commitGoal(hero, candidates) {
    const state = this.state;
    const prev = hero.aiGoal;
    const top = candidates[0] || null;
    if (!prev || prev.key === 'hold') return top;
    const live = candidates.find((c) => goalKey(c) === prev.key) || null;
    if (!live) return top; // achieved, taken, newly guarded or out of reach
    // Progress. bestDistDay is the last day this hero came closer to the goal
    // than it ever had before; if that was long enough ago the goal is not
    // being approached, whatever the map says about why.
    const dist = this.goalDistance(hero, prev);
    if (dist < (prev.bestDist ?? Infinity)) {
      prev.bestDist = dist;
      prev.bestDistDay = state.day;
      this.rememberGoalProgress(hero, prev.key, dist, state.day);
    }
    if (state.day - (prev.bestDistDay ?? prev.committedDay) >= GOAL_TUNING.progressDays
        && !UNSHELVABLE_GOALS.has(prev.type)) {
      this.banGoal(hero, prev);
      prev.stale = 'stalled';
      const i = candidates.indexOf(live);
      if (i >= 0) candidates.splice(i, 1);
      return candidates[0] || null;
    }
    if (top && goalKey(top) !== prev.key && (top.score || 0) >= live.score * GOAL_TUNING.hysteresis) return top;
    return live; // the incumbent holds
  }

  /**
   * A goal whose path could not be computed. `_black` forgets this at dusk (it
   * dies with the controller), so nothing stopped a hero re-picking the same
   * unreachable prize every dawn — measured: a mine ONE tile away, behind a
   * guard's zone of control, re-chosen daily for a week. Strikes are counted per
   * DAY (a turn's retries count once) and lapse after GOAL_FAIL_WINDOW days.
   */
  noteGoalFailure(hero, goal) {
    const state = this.state;
    if (UNSHELVABLE_GOALS.has(goal.what)) return; // riding home is never given up on
    const z = goal.z ?? (hero.z ?? 0);
    const key = goal.id ? `#${goal.id}` : `@${goal.x},${goal.y},${z}`;
    const fails = hero.aiGoalFails || (hero.aiGoalFails = {});
    for (const k of Object.keys(fails)) {
      if (state.day - fails[k].day > GOAL_FAIL_WINDOW) delete fails[k];
    }
    const rec = fails[key];
    if (rec && rec.day === state.day) return; // one strike per day, not per retry
    const n = (rec ? rec.n : 0) + 1;
    if (n >= GOAL_TUNING.failStrikes) {
      delete fails[key];
      this.banGoal(hero, { targetId: goal.id, x: goal.x, y: goal.y, z });
      return;
    }
    fails[key] = { n, day: state.day };
  }

  /**
   * How close this hero has ever come to `key`, and when — carried across goal
   * SWITCHES, which is the whole point. A hero shuttling A → B → A re-commits to
   * A every other day; without a per-target memory each re-commitment resets the
   * progress clock and a goal that is never approached looks brand new forever.
   */
  goalProgressMemory(hero, key) {
    const mem = hero.aiGoalMemory;
    const rec = mem && mem[key];
    if (!rec || this.state.day - rec.day > GOAL_MEMORY_DAYS) return null;
    return rec;
  }

  /** Write back the closest approach to `key`, pruning stale/overflowing entries. */
  rememberGoalProgress(hero, key, bestDist, bestDistDay) {
    const mem = hero.aiGoalMemory || (hero.aiGoalMemory = {});
    for (const k of Object.keys(mem)) {
      if (this.state.day - mem[k].day > GOAL_MEMORY_DAYS) delete mem[k];
    }
    mem[key] = { dist: bestDist, day: bestDistDay };
    const keys = Object.keys(mem);
    // Oldest out first if the memory is somehow still crowded.
    if (keys.length > GOAL_MEMORY_MAX) {
      keys.sort((a2, b2) => mem[a2].day - mem[b2].day);
      for (const k of keys.slice(0, keys.length - GOAL_MEMORY_MAX)) delete mem[k];
    }
  }

  /**
   * Record the goal this hero just chose, and log every CHANGE — old goal, new
   * goal, both scores, and the reason. Goal churn is invisible from the outside
   * (a hero pacing between two tiles looks exactly like a hero doing anything
   * else), and it took a hand-read of a 35-day position table to find the last
   * one. This makes the next one a query.
   *
   * `reason` names the gate the change came through:
   *   first    — the hero had no goal
   *   gone     — the old goal is no longer a candidate (taken, guarded, unreachable)
   *   outbid   — the old goal is still on the board and something out-scored it
   *   stalled  — abandoned for want of progress (see commitGoal)
   *   hold     — superseded by standing guard in a threatened town
   * Pure bookkeeping: no rng, and nothing in the rule engine reads it back.
   */
  noteGoal(hero, chosen, candidates = []) {
    const state = this.state;
    const prev = hero.aiGoal || null;
    const key = goalKey(chosen);
    if (prev && prev.key === key) {
      // Same goal as before: refresh its progress record. bestDist is the
      // closest this hero has ever come to it, and the day it got there — the
      // pair the progress requirement is measured against.
      prev.revalidatedDay = state.day;
      const d = this.goalDistance(hero, prev);
      if (d < (prev.bestDist ?? Infinity)) {
        prev.bestDist = d;
        prev.bestDistDay = state.day;
        this.rememberGoalProgress(hero, prev.key, d, state.day);
      }
      return chosen;
    }
    // A change. Was the old goal still on the board (outbid) or has it vanished
    // (taken by someone, newly guarded, newly unreachable)? The distinction is
    // the whole diagnosis: one is a scoring problem, the other a target problem.
    const live = prev && !prev.stale
      ? candidates.find((c) => goalKey(c) === prev.key) || null
      : null;
    const reason = prev?.stale ? prev.stale
      : (!prev ? 'first'
        : (chosen?.hold ? 'hold'
          : (live ? 'outbid' : (this.goalAchieved(hero, prev) ? 'achieved' : 'gone'))));
    if (prev) this.metrics.goalChanges++;
    const dist = chosen && chosen.x != null
      ? Math.round(Math.hypot(chosen.x - hero.x, chosen.y - hero.y)) : 0;
    aiLog(state, {
      kind: 'goal',
      player: this.playerIndex,
      hero: hero.name || hero.id,
      heroId: hero.id,
      from: prev ? prev.type : null,
      fromKey: prev ? prev.key : null,
      toKey: key,
      fromScore: prev ? Math.round(live ? live.score : prev.score) : null,
      fromDays: prev ? state.day - prev.committedDay : null,
      to: goalName(chosen),
      toScore: Math.round(chosen?.score || 0),
      dist,
      reason,
    });
    if (!chosen) { hero.aiGoal = null; return chosen; }
    // A goal this hero has chased before keeps its progress record: the clock on
    // "never gets any closer" runs against the target, not against this spell of
    // pursuing it (see goalProgressMemory).
    const here = this.goalDistance(hero, chosen);
    const mem = this.goalProgressMemory(hero, key);
    const bestDist = mem ? Math.min(mem.dist, here) : here;
    const bestDistDay = mem && mem.dist <= here ? mem.day : state.day;
    hero.aiGoal = {
      key,
      type: goalName(chosen),
      targetId: chosen.id ?? null,
      x: chosen.x ?? null,
      y: chosen.y ?? null,
      z: chosen.z ?? (hero.z ?? 0),
      score: chosen.score || 0,
      committedDay: state.day,
      revalidatedDay: state.day,
      bestDist,
      bestDistDay,
    };
    this.rememberGoalProgress(hero, key, bestDist, bestDistDay);
    return chosen;
  }

  /** Shelve a goal this hero has proved it cannot reach, for GOAL_TUNING.banDays. */
  banGoal(hero, g) {
    if (!g || UNSHELVABLE_GOALS.has(g.type) || UNSHELVABLE_GOALS.has(g.what)) return;
    const bans = hero.aiGoalBans || (hero.aiGoalBans = {});
    for (const k of Object.keys(bans)) if (bans[k] <= this.state.day) delete bans[k];
    bans[g.targetId ? `#${g.targetId}` : `@${g.x},${g.y},${g.z ?? 0}`] = this.state.day + GOAL_TUNING.banDays;
  }

  /**
   * True while a goal this hero gave up on is still shelved. Keyed by target id
   * when there is one (so a moving hero stays banned wherever it goes) and by
   * tile otherwise. The per-turn `_black` set cannot do this job: it dies with
   * the controller, so a hero re-picked the same impossible prize every dawn.
   */
  isGoalBanned(hero, tag, id, x, y, z) {
    const bans = hero.aiGoalBans;
    if (!bans) return false;
    const day = this.state.day;
    return (bans[`#${id}`] ?? -1) > day || (bans[`@${x},${y},${z}`] ?? -1) > day;
  }

  /** True while a stuck hero's avoid-zone is live and covers (x, y, z). */
  isAvoided(hero, x, y, z = hero.z ?? 0) {
    const av = hero.aiAvoid;
    if (!av || av.z !== z || this.state.day >= av.until) return false;
    return Math.hypot(x - av.x, y - av.y) <= STUCK_AVOID_RADIUS;
  }

  // Blacklists are per hero: one hero failing to reach a prize (its approach
  // blocked by a friend, say) must not hide that prize from the others. Keys
  // carry the map level so an underground goal never shadows a surface one.
  blacklist(hero, goal) {
    this._black.add(`${hero.id}|${goal.x},${goal.y},${goal.z ?? (hero.z ?? 0)}`);
  }

  isBlack(hero, x, y, z = hero.z ?? 0) {
    return this._black.has(`${hero.id}|${x},${y},${z}`);
  }

  /**
   * Wipe one hero's blacklist after a connector transit: entries encode
   * "unreachable from where I stood", which the crossing just falsified.
   * The endpoints of every gate/portal pair the hero used this turn are
   * re-applied, so a used pair stays cooled down for the whole turn.
   */
  clearHeroBlacklist(hero) {
    const prefix = `${hero.id}|`;
    for (const key of [...this._black]) {
      if (key.startsWith(prefix)) this._black.delete(key);
    }
    for (const c of this._used.get(hero.id) || []) {
      this._black.add(`${hero.id}|${c.x},${c.y},${c.z}`);
    }
  }

  // ---- The Holy Grail ------------------------------------------------------

  /**
   * A hero standing on the buried Grail tile (puzzle solved) ends its turn
   * there: it DIGS when a full day of movement remains (digForGrail spends the
   * whole day and yields the Grail), else it simply holds so it can dig at the
   * next dawn. Returns true when the hero is on the tile (so advanceHero ends
   * its turn); false otherwise. Universal — whichever hero reaches the tile
   * digs, not only the main (the pursuit is main-only; see pickGoal).
   */
  tryGrailDig(hero) {
    const state = this.state;
    const g = state.map.grail;
    if (!g || state.grailDug || hero.carryingGrail) return false;
    if ((hero.z ?? 0) !== 0 || hero.x !== g.x || hero.y !== g.y) return false;
    if (!grailKnown(state, hero.owner)) return false;
    digForGrail(state, hero); // digs on a full day; a no-op (nothing spent) otherwise
    return true;
  }

  /** Nearest own town on the hero's level (for carrying the Grail home). */
  nearestOwnTown(hero, z) {
    let best = null, bestD = Infinity;
    for (const t of playerTowns(this.state, this.playerIndex)) {
      if ((t.z ?? 0) !== z) continue;
      const d = Math.hypot(t.x - hero.x, t.y - hero.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /**
   * Sunk-Cost Siege (#14): the superiority margin to demand before assaulting a
   * town — the base `aggroMargin`, cut (bounded, never below the courage floor) in
   * proportion to the army value already thrown away here. Returns aggroMargin
   * unchanged in Classic (no remembered loss). Desirability gate only.
   *
   * `myWorth` is a PRICE, deliberately: recordSiegeLoss books the losses in
   * armyValue, so the sunk/army ratio only means "share of my army already
   * spent here" when both sides stay on that ledger. The margin this returns
   * is then applied to a POWER comparison — a ratio is unitless, so no
   * currency leaks across.
   */
  siegeMargin(town, aggroMargin, myWorth) {
    const sunk = decayedSiegeLoss(town, this.playerIndex, this.state.day);
    if (sunk <= 0 || myWorth <= 0) return aggroMargin;
    const cut = Math.min(CONFIG.SUNK_COST_MAX_REDUCTION, CONFIG.SUNK_COST_SLOPE * (sunk / myWorth));
    return Math.max(CONFIG.SUNK_COST_FLOOR, aggroMargin - cut);
  }

  /** True while any of our towns is under a live or remembered threat. */
  anyTownThreatened() {
    return playerTowns(this.state, this.playerIndex).some((t) => this.townThreat(t) > 0);
  }

  /** Do we own a town with a Mage Guild of at least `level` — the tech that
   *  teaches Town Portal (tier 3)? Gates the AI's adoption of the spell. */
  ownsGuildAtLeast(level) {
    return playerTowns(this.state, this.playerIndex).some((t) => {
      const catalog = buildingCatalog(t.faction);
      return (t.buildings || []).some((b) => (catalog[b]?.guildLevel || 0) >= level);
    });
  }

  /**
   * AI Town Portal (#13): if a town is under a threat its garrison can't hold and
   * this hero — recalled there — could turn the fight, teleport home to defend.
   * Adoption is gated on the realm actually holding the Mage Guild that teaches it
   * (tier 3); once it does, the hero is guaranteed to know the spell. Returns true
   * (turn spent) on a successful cast. Off unless features.aiTownPortal.
   */
  maybeTownPortalHome(hero) {
    const state = this.state;
    if (!featureOn(state, 'aiTownPortal')) return false;
    const tp = SPELLS.townPortal;
    const toll = adventureParam(hero, 'townPortal', CONFIG.TOWN_PORTAL_MP_BY_SCHOOL);
    if ((hero.mana || 0) < spellCost(hero, 'townPortal') || (hero.mp || 0) < toll) return false;
    if (!this.ownsGuildAtLeast(tp.tier)) return false; // the tech hasn't diffused here yet
    // A town the hero + walls could actually save, and isn't already standing
    // in. armyPower, not armyValue: townThreat reads in power, so the recall
    // decision must weigh the hero in the same currency (the same comparison
    // pickGoal's 'defend town' goal makes).
    const savable = (t) => this.townThreat(t) > this.townDefenseValue(t)
      && !(hero.x === t.x && hero.y === t.y && (hero.z ?? 0) === (t.z ?? 0))
      && armyPower(hero.army, this.physical) + this.townDefenseValue(t) >= this.townThreat(t) * courageAt(state.day);
    // Where the cast would actually land: an Earth mage aims at the worst town;
    // everyone else snaps to the nearest owned town, so only recall then if THAT
    // town is the one in danger (otherwise the portal would strand us elsewhere).
    const owned = playerTowns(state, this.playerIndex);
    // The engine's own answer to "may this hero pick the destination?" — the AI
    // used to carry a second copy of the rule, which is how a UI and an engine
    // end up disagreeing about what a spell does.
    const canAim = townPortalCanChoose(hero);
    let dest = null, target = null;
    if (canAim) {
      dest = owned.filter(savable).sort((a, b) => this.townThreat(b) - this.townThreat(a))[0] || null;
      if (dest) target = { townId: dest.id };
    } else {
      const near = (list) => list.reduce((best, t) => {
        const d = Math.max(Math.abs(t.x - hero.x), Math.abs(t.y - hero.y));
        return !best || d < best.d ? { t, d } : best;
      }, null)?.t;
      const nearest = near(owned.filter((t) => (t.z ?? 0) === (hero.z ?? 0))) || near(owned);
      if (nearest && savable(nearest)) dest = nearest;
    }
    if (!dest) return false;
    // Guarantee adoption once the realm holds the guild (the "learned the trick").
    if (!(hero.spells || []).includes('townPortal')) (hero.spells = hero.spells || []).push('townPortal');
    const res = castAdventureSpell(state, hero, 'townPortal', target);
    if (res && res.ok) {
      logMsg(state, `${hero.name} invokes a Town Portal, rushing to defend ${dest.name || 'a beleaguered town'}.`);
      return true;
    }
    return false;
  }

  /**
   * Best goal for this hero, all priced as value / distance and gated by a
   * courage margin vs defenders. The main hero hunts towns, heroes and
   * artifacts at the normal margin; collectors weight the economy up and only
   * pick fights with players from clear superiority. The scan is LEVEL-AWARE:
   * a hero weighs the prizes of its own map level, plus any connector (gate /
   * portal / boat) priced by the best prize behind it. May return
   * { hold:true } when standing guard in a threatened home town beats
   * everything reachable.
   */
  pickGoal(hero, reach = null) {
    const state = this.state;
    this.metrics.goalPicks++;
    const z = hero.z ?? 0;
    // Two readings of the same army, because two different questions get asked
    // of it. `myForce` (POWER) answers every can-I-win gate below — guard
    // values, threat vetoes, rescue arithmetic all read in power, so the own
    // side must too or the courage margin silently drifts (under the shipped
    // classic table by ±12%, under physicalDamage an army can read 1.70× its
    // real strength — an AI attacking its own mirror believing it outnumbers
    // it). `myWorth` (PRICE) answers the two economic questions that compare
    // this army against OWN property: the garrison-pickup bar (takeable stock
    // is priced in aiValue) and the sunk-cost ratio (losses are booked in
    // aiValue). Converting those to power was rejected — it would churn every
    // price-side consumer for no gate it could make more honest.
    const myForce = armyPower(hero.army, this.physical);
    const myWorth = armyValue(hero.army);
    // Learned overkill: after losses/pyrrhic wins the AI demands MORE force before
    // it attacks (Sun Tzu — win cheaply), and amasses until it has it.
    const courage = courageAt(state.day) * aiCourageMult(state);
    const isMain = hero.id === this.mainHeroId;
    const aggroMargin = isMain ? courage : courage * 1.6;
    const eco = (isMain ? 1 : 1.6) * this.warlord.economy; // collectors chase the economy harder (× warlord)
    // Conquest appetite: scales how much this warlord COVETS enemy towns/heroes
    // — the desirability only. The army-superiority gate (aggroMargin) is
    // untouched, so even a Conqueror only strikes when it can win. Tide of War
    // (#11) damps it during the opening grace period so the AI doesn't rush you.
    const aggr = this.warlord.aggression * tideNoRushFactor(state);
    const explore = this.warlord.exploration; // pull toward boosters/obelisks
    // Balance of Power (#9, opt-in): bias desirability toward a runaway hegemon's
    // holdings and ease off other rivals. Multiplies the enemy-target scores only;
    // the aggroMargin superiority gate below is untouched (never an unwinnable rush).
    const bopBias = balanceOfPowerBias(state, this.playerIndex);
    // Patronage: money buys a front. A realm paying for a war on somebody's flank —
    // or being paid to fight one — covets that realm's holdings and eases off the
    // party across the table from it. Same shape as the coalition bias above, and
    // composed with it, because a realm can be inside both stories at once.
    const war = warBias(state, this.playerIndex);
    // An uprising is the sharpest of the three: a realm that broke its oath this week
    // marches on the lord it served, and that lord marches back. Same shape again, so
    // all three compose — a realm can be inside every one of these stories at once.
    const rising = uprisingBias(state, this.playerIndex);
    const bop = (owner) => (bopBias ? bopBias(owner) : 1) * (war ? war(owner) : 1)
      * (rising ? rising(owner) : 1);

    // Consolidation (Phase B): once the realm is worth more than
    // CONSOLIDATE_TRIGGER times its best hero, that hero's first job is to go
    // and collect the biggest stock it can carry. Main hero only — a realm
    // concentrates into ONE fist, and sending collectors to do it would just
    // move the dispersal around.
    const consolidate = isMain ? this.consolidationTarget(hero) : null;

    const goals = [];
    // Flight recorder for this scan (see ai/aiLog.js). Every rejection below is
    // attributed to the gate that made it, so "why did the AI stop flagging
    // mines" is a question the log can answer instead of one we guess at.
    const scan = { vetoes: {}, mineVetoes: {}, minesSeen: 0, minesConsidered: 0, considered: 0 };
    const veto = (tag, why) => {
      scan.vetoes[why] = (scan.vetoes[why] || 0) + 1;
      if (tag === 'mine') scan.mineVetoes[why] = (scan.mineVetoes[why] || 0) + 1;
    };
    // `avoidable` defaults true: a stuck hero's avoid-zone suppresses ordinary
    // prizes, but NOT defending/reinforcing its own town (those pass false).
    // `urgent` marks a goal with a DEADLINE rather than a price. See the distance
    // discount below for why that needs its own arithmetic.
    const claimed = this.claimedTargets(hero);
    const consider = (x, y, score, guardValue = 0, margin = courage, avoidable = true, tag = null, id = null,
      urgent = false) => {
      if (this.isBlack(hero, x, y, z)) return veto(tag, 'blacklisted');
      if (!UNSHELVABLE_GOALS.has(tag) && this.isGoalBanned(hero, tag, id, x, y, z)) {
        return veto(tag, 'gaveUp');
      }
      if (avoidable && this.isAvoided(hero, x, y, z)) return veto(tag, 'avoided');
      if (guardValue > 0 && myForce < guardValue * margin) return veto(tag, 'guarded');
      // Reachability gate: a prize this hero provably cannot walk to must not
      // enter the goal list at all — the old flow burned all 24 plan retries
      // on far-side jackpots (each one a failed full-map A*) and then stalled
      // with FULL MP, every day, forever. Ring 2 accepts combat/interaction
      // targets whose own tile (and, for monsters, whose zone of control)
      // blocks the flood — the same convention bestThrough uses.
      if (!this.nearReach(reach, x, y, 2)) return veto(tag, 'unreachable');
      const d = Math.hypot(x - hero.x, y - hero.y) + 1;
      scan.considered++;
      if (tag === 'mine') scan.minesConsidered++;
      // Somebody is already riding for this. Worth less to me — not nothing, because
      // two heroes on one target is sometimes exactly right. Same key `goalKey` mints,
      // so a claim and a goal are the same identity rather than two that can drift.
      const claimKey = `${tag}|${id ?? `${x},${y},${z}`}`;
      if (claimed.has(claimKey)) { score *= CLAIM_DAMP; scan.vetoes.claimed = (scan.vetoes.claimed || 0) + 1; }
      // score/d is value PER STEP, which is the right question for a prize: a chest
      // twice as far pays the same for twice the walking, and it will still be there
      // next week. A siege is not that. Arriving late at a town that has fallen is
      // worth nothing at all, so the honest discount for an urgent goal is much
      // shallower — sqrt(d), not d. Measured on the goal lists this decides: an
      // 'intercept band' raw 24,926 three steps away scores 7,703 while a creature
      // bank raw 20,879 three steps away scores 6,960, so the two are within 10% and
      // whichever is nearer simply wins. That is a fair contest between two PRIZES and
      // the wrong contest between a prize and a deadline.
      goals.push({ x, y, z, score: score / (urgent ? Math.sqrt(d) : d), what: tag || 'goal', id });
      return undefined;
    };

    let hold = false;

    // The Holy Grail. A carried Grail is worthless until enshrined, so ANY
    // hero carrying it beelines home to raise the structure. Otherwise, once
    // the obelisk puzzle is solved, the MAIN hero fetches it — ride to the
    // buried tile (the dig itself is a full-day action in advanceHero). Both
    // are gated on safety: the AI never abandons a threatened town to chase it.
    if (hero.carryingGrail) {
      const home = this.nearestOwnTown(hero, z);
      if (home && hero.x === home.x && hero.y === home.y) {
        deliverGrail(state, hero, home); // already home — enshrine now, then work on
      } else if (home) {
        consider(home.x, home.y, 20000, 0, courage, false, 'enshrine the Grail', home.id);
      }
    } else if (isMain && state.map.grail && !state.grailDug
        && (state.map.grail.z ?? 0) === z && grailKnown(state, this.playerIndex)
        && !this.anyTownThreatened()) {
      const g = state.map.grail;
      // Already standing on the buried tile? Hold here — the hero cannot path
      // to a tile it occupies, and advanceHero digs it at the next full day.
      if (hero.x === g.x && hero.y === g.y) return { hold: true };
      if (myForce >= this.threatNear(g.x, g.y, z) * courage) {
        consider(g.x, g.y, 15000, 0, courage, false, 'dig for the Grail');
      }
    }

    // SELF-PRESERVATION (retreat): a hero out in the field that a superior enemy
    // can reach AND beat runs for the nearest refuge — its own town, behind the
    // walls and onto the garrison — instead of standing to be caught or chasing
    // loot it can't safely reach. Distinct from the town-turtle below (that
    // defends a threatened TOWN; this saves a threatened HERO). Only fires in the
    // open — a hero already in a town is turtling — and only when genuinely
    // outmatched. Scored above ordinary loot (survival first), ungated by guards
    // (we run FROM the fight) and immune to the avoid-zone; consider() still drops
    // it if no refuge is reachable this turn (then the hero does its safest else).
    if (!hero.inTownId) {
      const menace = this.threatNear(hero.x, hero.y, z);
      if (menace > 0 && myForce < menace * courage) {
        const refuge = this.nearestOwnTown(hero, z);
        if (refuge && !(refuge.x === hero.x && refuge.y === hero.y)) {
          consider(refuge.x, refuge.y, 16000, 0, courage, false, 'retreat to refuge', refuge.id);
        }
      }
    }

    // Towns: defend our own, raid enemy AND neutral ones (a garrisoned
    // neutral cavern town is a top-tier prize like any other). A hero weighs
    // the towns of its OWN level; towns on the other level are seen through
    // a gate (considerConnectors below).
    for (const town of Object.values(state.towns)) {
      if ((town.z ?? 0) !== z) continue;
      if (town.owner === this.playerIndex) {
        // Two readings again: the garrison's POWER is held against the danger
        // (townThreat is a power), its PRICE against the pickup bar below
        // (takeable stock is priced in aiValue).
        const garrisonForce = armyPower(town.garrison, this.physical);
        const garrisonValue = armyValue(town.garrison);
        // Live menace or the decaying memory of one (see updateThreatMemory):
        // a besieger stepping briefly out of radius keeps the town in
        // build-up mode instead of luring the defender out prematurely.
        const danger = this.townThreat(town);
        if (danger > garrisonForce) {
          // The standing garrison alone can't hold. A hero already inside
          // TURTLES: it stands fast, absorbing every week's recruits, until
          // the town's whole defense (garrison + hero) beats the remembered
          // threat by the courage margin — only then does the hold lift, and
          // the enemy-hero goal below (now passing its own courage gate)
          // sends the consolidated army out after the menace.
          if (hero.inTownId === town.id) {
            if (this.townDefenseValue(town) < danger * courage) hold = true;
          } else if (danger > this.townDefenseValue(town)
              && (!town.visitingHeroId || town.visitingHeroId === hero.id)
              && myForce < danger * courage) {
            // Nobody adequate is home and this hero cannot simply hunt the
            // menace down (that case is the gated enemy-hero goal below).
            // Ride for OUR OWN town square — to the rescue when hero + walls
            // can turn the fight, or to consolidate INTO the garrison and
            // turtle when they can't. The goal is never the enemy itself: a
            // hero that cannot win must not path toward the menace. With the
            // square already defended by someone else, this hero stays away
            // entirely and collects safe loot instead (the strike-range veto
            // below keeps it out of the besieger's reach).
            //
            // KNOWN AND MEASURED, not fixed: `9000 + danger/2` is monotone in the
            // threat, and nothing here consults what another hero already chose, so
            // heroes converge on the worst-threatened town. Over 16 constructed
            // three-front situations that leaves a front uncovered every time.
            // Scoring the SHORTFALL instead — subtracting the relief already pledged
            // by other heroes' committed goals — was built and measured and changed
            // NOTHING at any hero strength (60 to 600 crusaders), because in practice
            // the heroes near a threatened town are already inside it and turtling,
            // and the free ones are lost to the loot race below, not to each other.
            // Reverted rather than shipped unmeasurable. The real gap is that this
            // score is a flat base plus half the danger while a creature bank is
            // scored on its REWARD, and both are divided by distance.
            // Urgent when the danger is an INVADER: a band arrives on a schedule it
            // declared at landfall. A rival hero may or may not press the siege, so
            // that case keeps the ordinary discount.
            // NOT urgent, though a band's arrival IS on a schedule: making it so was
            // measured and it pulled heroes OUT of the towns they were turtling in,
            // because a shallow-discounted rescue at a neighbouring gate outbids
            // standing fast. Coverage of every front went 19% -> 0% at the strength
            // where turtling is the whole defence. The deadline is real; a hero that
            // is already home is the wrong one to sell it to.
            consider(town.x, town.y, 9000 + danger / 2, 0, courage, false, 'defend town', town.id);
          }
          continue;
        }
        // The consolidation errand outranks ordinary loot: the realm is holding
        // its army in the wrong hands and this is the hero that can fix it.
        if (consolidate && consolidate.town.id === town.id) {
          consider(town.x, town.y, CONSOLIDATE_SCORE + consolidate.value / 2, 0,
            courage, false, 'consolidate', town.id);
          continue;
        }
        // Garrison pickup: only when it substantially grows the field army.
        // The old 0.5x bar made the main hero yo-yo home for every batch of
        // recruits; now it returns only for a force-doubling garrison, while
        // collectors ferry smaller batches forward. Priced on what this hero
        // could actually carry away (takeableGarrisonValue) — a full seven-slot
        // army marching home for troops it cannot hold is a wasted week.
        const pickupBar = isMain ? 1.0 : 0.4;
        const takeable = takeableGarrisonValue(town, hero);
        if (hero.inTownId !== town.id && takeable > myWorth * pickupBar) {
          consider(town.x, town.y, 2000 + takeable / 3, 0, courage, false, 'garrison pickup', town.id);
        } else if (garrisonValue > myWorth * pickupBar && takeable <= 0) {
          veto('garrison pickup', 'noRoom');
        }
        continue;
      }
      if (this.isAlly(town.owner)) {
        // Never raid an allied realm — but a vassal we swore to PROTECT is a
        // different matter: honour the term. Same gate as our own rescue, one
        // rung cheaper so our own towns always come first, and only when the
        // hero can actually turn the fight.
        if (this.protectedTown(town)) {
          const danger = this.townThreat(town);
          const held = this.townDefenseValue(town);
          if (danger > held && myForce + held >= danger * courage) {
            consider(town.x, town.y, 7000 + danger / 2, 0, courage, true, 'defend vassal', town.id);
          } else if (danger > held) veto('defend vassal', 'guarded');
        }
        continue;
      }
      consider(town.x, town.y, 12000 * aggr * bop(town.owner), this.townDefenseValue(town),
        this.siegeMargin(town, aggroMargin, myWorth), true, 'enemy town', town.id);
    }

    // Enemy heroes: worth more when they menace our towns (finishing a
    // weakened raider near home is both defense and offense). Allies skipped,
    // as are heroes on another map level (unreachable by same-level pathing).
    for (const h of Object.values(state.heroes)) {
      if (!this.isEnemy(h.owner)) continue;
      if ((h.z ?? 0) !== z) continue;
      const menace = this.heroMenacesUs(h) ? 6000 : 0;
      consider(h.x, h.y, (6000 + menace) * aggr * bop(h.owner), this.enemyHeroValue(h), aggroMargin, true, 'enemy hero', h.id);
    }

    // Enemy caravans: undefended supply runs. Raiding one denies the troops and
    // pays XP — worth the value of the stack it carries (no guard, so any hero
    // can take it; aggression scales the appetite).
    for (const c of (state.caravans || [])) {
      if ((c.z ?? 0) !== z || !this.isEnemy(c.owner)) continue;
      consider(c.x, c.y, armyValue([{ creature: c.creature, count: c.count }]) * aggr * bop(c.owner), 0, aggroMargin, true, 'caravan raid', c.id);
    }

    // Map objects — the hero's OWN level. Sea-locked islet prizes are boat
    // business (they are unreachable on foot; see the boat connector below).
    for (const obj of Object.values(levelObjects(state, z))) {
      if (obj.seaLocked) continue;
      const unclaimedMine = obj.type === 'mine' && !this.isAlly(obj.owner) && obj.owner !== this.playerIndex;
      if (unclaimedMine) scan.minesSeen++;
      // Safe loot only: a prize inside the strike range of a superior enemy
      // field army is bait, not income — grabbing it parks this hero where
      // the menace kills it next turn. (An enemy hero standing ON or NEXT TO
      // the prize is additionally priced as a guard — see guardValueNear.)
      //
      // This is by far the likeliest gate to shut an AI's whole economy down:
      // once the player's field army outclasses the realm, EVERY prize in reach
      // is inside somebody's strike range and the scan comes back empty. That is
      // why it is the one veto recorded even before the type switch.
      // NB a war-band is its own menace here — threatNear counts bands since they
      // entered the threat model, so a band's own force can veto the band itself. That
      // was chased as a bug and MEASURED as a no-op: this gate uses `courage` (~1.15)
      // while consider()'s guard gate below uses `aggroMargin` (1.3-2.08), so every
      // band this would hide is one the stricter gate refuses anyway. Exempting bands
      // here changed not one goal at any hero strength from 60 to 600 crusaders.
      if (myForce < this.threatNear(obj.x, obj.y, z) * courage) {
        veto(unclaimedMine ? 'mine' : obj.type, 'menaced');
        continue;
      }
      const guard = this.guardValueNear(obj, z);
      switch (obj.type) {
        case 'mine':
          // An ALLY's mine is not a prize — `visitObject` refuses to re-flag a
          // holding a teammate owns (and a vassal is on the suzerain's team, so
          // this covers a sworn realm's mines too). The march was legal, the
          // arrival was a no-op, and the hero had spent its day: measured over
          // four three-player games with a pact standing, 73 of the 77 hero-turns
          // that ended on a mine changed nothing at all. `unclaimedMine` eighteen
          // lines above already asked exactly this question for the scan counter
          // — the prize gate simply never used the answer.
          if (unclaimedMine) {
            // A garrisoned holding must be BEATEN, so its defence counts as a
            // guard — otherwise the AI marches a courier at a mine it cannot
            // take and feeds it to the garrison. Same gate as any other guard,
            // so the same currency: holdingDefenceForce, not defenceValue.
            consider(obj.x, obj.y, (obj.mineType === 'goldMine' ? PRIZE.goldMine : PRIZE.mine) * eco,
              Math.max(guard, this.holdingDefenceForce(obj)), courage, true, 'mine', obj.id);
          } else veto('mine', 'owned');
          break;
        case 'resource': consider(obj.x, obj.y, PRIZE.resource * eco, guard, courage, true, 'resource', obj.id); break;
        case 'chest': consider(obj.x, obj.y, PRIZE.chest * eco, guard, courage, true, 'chest', obj.id); break;
        case 'artifact': consider(obj.x, obj.y, PRIZE.artifact, guard, courage, true, 'artifact', obj.id); break;
        // A Keymaster Tent's key unlocks matching Border Guards (and the caches
        // behind them, which then become reachable and priced normally). Worth a
        // detour only while the key is still missing.
        case 'keymaster':
          if (!playerHasKey(state, this.playerIndex, obj.color)) {
            const worth = this.keymasterUnlockValue(state, obj.color, z);
            if (worth > 0) consider(obj.x, obj.y, worth * eco, guard, courage, true, 'keymaster', obj.id);
          }
          break;
        // A Creature Bank is a guarded cache: its own garrison gates whether we
        // dare it (the guard value), and consider() skips it unless our army wins.
        case 'creatureBank':
          if (!obj.looted) { const bv = this.bankValue(obj); consider(obj.x, obj.y, bv.reward * eco, bv.guard, courage, true, 'creature bank', obj.id); }
          // A CLEARED lair that has bred since (lairBrood): free, unguarded army,
          // so it is worth a march exactly like a dwelling's accrued stock.
          else { const bd = this.broodValue(obj); if (bd > 0) consider(obj.x, obj.y, bd, guard, courage, true, 'lair brood', obj.id); }
          break;
        // A Pandora's Box: a guarded (or free) one-time treasure. Its guard gates
        // winnability like a bank; the reward is the gold-equivalent of its roll.
        case 'pandora':
          if (!obj.looted) { const pv = this.pandoraValue(obj); consider(obj.x, obj.y, pv.reward * eco, pv.guard, courage, true, 'pandora', obj.id); }
          break;
        // A Seer Hut: a tribute we can already pay, for a reward the generator
        // guarantees is worth twice it. Priced off that guarantee, never by
        // reading the sealed reward — see seerValue.
        case 'seerHut': {
          const sv = this.seerValue(hero, obj);
          if (sv > 0) consider(obj.x, obj.y, sv * eco, guard, courage, true, 'seer hut', obj.id);
          else veto('seerHut', obj.done ? 'spent' : 'unaffordable');
          break;
        }
        // A Trading Post: surplus gear becomes experience, and an upgrade on the
        // shelf becomes an upgrade. Both halves are priced in postValue.
        case 'tradingPost': {
          const pv = this.postValue(hero, obj);
          if (pv > 0) consider(obj.x, obj.y, pv, guard, courage, true, 'trading post', obj.id);
          else veto('tradingPost', 'worthless');
          break;
        }
        case 'booster': {
          // Banked one-shots, a 'move' camp used today, and a weekly Windmill/
          // Water Wheel already drained this week are all worth nothing now.
          if (boosterSpent(state, hero, obj)) { veto('booster', 'spent'); break; }
          consider(obj.x, obj.y, this.boosterScore(obj, hero) * explore, guard, courage, true, 'booster', obj.id);
          break;
        }
        case 'dwelling': {
          // Free army: the accrued stock we can afford, priced as army value.
          const dv = this.dwellingValue(obj);
          if (dv > 0) {
            consider(obj.x, obj.y, dv, Math.max(guard, this.holdingDefenceForce(obj)), courage, true, 'dwelling', obj.id);
          }
          else veto('dwelling', 'worthless');
          break;
        }
        case 'monster': {
          // A WAR-BAND marching on one of our towns is not a guard, and pricing it as
          // one is why an AI realm walks past an army besieging its city to go and
          // flag a mine. PRIZE.monster is 900; a mine is 2500 and a chest 1500, so a
          // horde at the gate lost to the scenery. It never showed while a wave put
          // every band on ONE town — the hero already inside turtled and that was the
          // whole defence — and it started mattering the day a wave learned to arrive
          // on several fronts (invasions.marchTarget): the heroes NOT in a town have
          // no reason to ride at the ones nobody is holding. Priced like an enemy hero
          // that menaces us, which is exactly what it is.
          if (this.bandMenacesUs(obj)) {
            // `courage`, NOT aggroMargin. A collector's margin is courage x 1.6, and
            // 'defend town' only offers itself while myForce < danger x courage — so a
            // non-main hero between 1.0x and 1.6x a band was too strong to be sent to
            // the walls and too weak to be allowed at the band: an evenly-matched
            // invader was engaged by nobody. The main hero never had the gap (its
            // aggroMargin IS courage); this closes it for the rest. The gate is still a
            // real one — a hero that cannot win still does not go.
            consider(obj.x, obj.y, PRIZE.bandAtOurGate + bandForce(obj, this.physical) / 2, bandForce(obj, this.physical),
              courage, false, 'intercept band', obj.id, true);
            break;
          }
          // Clearing weak guards = free XP (and opens the mountain passes).
          const v = creaturePower(obj.creature, this.physical) * obj.count;
          if (myForce >= v * courage) consider(obj.x, obj.y, PRIZE.monster, 0, courage, true, 'monster', obj.id);
          else veto('monster', 'guarded');
          break;
        }
        default: break;
      }
    }

    // Connectors: gates, portals and boats, each valued by the best prize
    // reachable through it on the same value/distance/courage scale. Marooned
    // = not one direct goal is reachable AND the hero's walkable pocket is
    // tiny (classic case: standing on a looted islet) — then connectors are
    // lifelines, valued undamped and free of cooldowns. (consider() now gates
    // every direct goal on nearReach, so "no reachable direct goal" is simply
    // an empty list.)
    const marooned = (reach?.size ?? Infinity) <= MAROONED_MAX_COMPONENT && !goals.length;
    const added = this.considerConnectors(hero, z, reach, goals,
      { myForce, courage, aggroMargin, eco, aggr, explore }, marooned);
    let candidates = goals;
    if (marooned && added > 0) {
      // Every direct goal is provably out of reach — don't burn plan tries on
      // them, ride a connector out instead. (Without connectors the old flow
      // stands, so connector-less maps behave exactly as before.)
      candidates = goals.filter((g) => g.connector);
    }

    // Deterministic ordering: score, then position breaks exact ties.
    candidates.sort((a, b) => (b.score - a.score) || (a.y - b.y) || (a.x - b.x));
    // Holding the fort competes on the same scale (it "costs" no travel):
    // only a killable nearby threat or an adjacent jackpot outranks it.
    const HOLD_SCORE = 4000;
    // Commitment: yesterday's goal is defended against today's re-score (see
    // commitGoal). It may shelve a stalled incumbent, which drops it from
    // `candidates` — so read the winner from here, not from candidates[0].
    //
    // An OBSERVER takes the raw ranking instead: commitment is written history
    // (it reads and mutates hero.aiGoal, and can ban goals), and an observer's
    // subject is a human hero that never legitimately carried any — a stale
    // aiGoal from a save written before observers existed must not shape, or be
    // reshaped by, a diagnostic. Same result as commitGoal with no incumbent.
    const kept = this.observer ? (candidates[0] || null) : this.commitGoal(hero, candidates);
    const chosen = (hold && (!kept || kept.score <= HOLD_SCORE))
      ? { hold: true }
      : (kept || this.exploreGoal(hero, reach));
    // The ranked list itself, kept for one caller: ai/adventureTelemetry scores a
    // HUMAN's chosen destination against it. pickGoal returns only its winner,
    // and a reference class needs the whole board of alternatives.
    this._lastGoals = candidates;
    // noteGoal is the write half — hero.aiGoal, goal memory, the aiLog row. An
    // observer records only onto itself (recordScan fills the controller-local
    // _firstScan the telemetry reads; it touches no state).
    if (!this.observer) this.noteGoal(hero, chosen, candidates);
    this.recordScan(hero, scan, chosen, myForce);
    return chosen;
  }

  /**
   * Bank the FIRST goal scan a hero makes each turn (see ai/aiLog.js).
   *
   * The first is the one worth keeping: every later retry runs against a
   * blacklist this turn's own failed pathfinds wrote, so its veto tally would
   * blame "path already failed today" for rejections that really happened at an
   * earlier gate. Pure bookkeeping — no rng, nothing the engine reads back.
   *
   * `army` records the POWER reading — the number the vetoes in this very
   * record were actually decided against, so "army 63,012 / vetoed: guarded"
   * stays arithmetic a reader can check rather than two currencies in one row.
   */
  recordScan(hero, scan, chosen, myForce) {
    if (this._firstScan.has(hero.id)) return;
    const vetoed = Object.values(scan.vetoes).reduce((n, v) => n + v, 0);
    this._firstScan.set(hero.id, {
      hero: hero.name || hero.id,
      army: Math.round(myForce),
      vetoes: scan.vetoes,
      mineVetoes: scan.mineVetoes,
      vetoed,
      mines: { seen: scan.minesSeen, considered: scan.minesConsidered },
      decision: chosen?.hold ? 'hold the town' : (chosen ? 'march' : 'idle — nothing in reach'),
      goal: chosen && !chosen.hold && chosen.x != null
        ? {
          what: chosen.what || (chosen.connector ? `${chosen.connector} crossing` : 'scout'),
          score: Math.round(chosen.score || 0),
          dist: Math.round(Math.hypot(chosen.x - hero.x, chosen.y - hero.y)),
        }
        : null,
    });
  }

  /**
   * Fallback for a weak or boxed-in hero: nothing cleared the value/courage bar
   * in pickGoal (every remaining prize is guarded beyond its strength). Rather
   * than idle away the turn, send it to scout — the nearest still-dark tile OF
   * ITS OWN LEVEL it can stand on WITHOUT being dragged into a guard's zone of
   * control (and, when the reach flood is available, one it can actually walk
   * to). Strong AIs almost always have a real goal and never reach here, so
   * their strategy contract is untouched; this only fills the do-nothing gap.
   */
  exploreGoal(hero, reach = null) {
    const state = this.state;
    const { w, h } = state.map;
    const z = hero.z ?? 0;
    const myForce = armyPower(hero.army, this.physical); // vs threatNear — power vs power
    const courage = courageAt(state.day);
    // One occupancy context for the whole-map scan below (same accelerator as
    // the floods — see makeWalkContext); answers are identical.
    const wctx = makeWalkContext(state, z, null);
    let best = null, bestD = Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (isExplored(state, this.playerIndex, x, y, z)) continue;
        if (this.isBlack(hero, x, y, z)) continue;
        if (this.isAvoided(hero, x, y, z)) continue; // scout OUT of a stuck pocket
        // Never scout into the strike range of a superior enemy field army.
        if (myForce < this.threatNear(x, y, z) * courage) continue;
        // isWalkable (omniscient, with our keys) rejects obstacles, water,
        // occupied tiles and guard zones of control, so stepping here never
        // forces an unwanted fight.
        if (!isWalkable(state, x, y, -1, null, !!hero.onBoat, z, this.playerIndex, wctx)) continue;
        if (reach && !reach[y * w + x]) continue;
        const d = Math.hypot(x - hero.x, y - hero.y);
        if (d < bestD) { bestD = d; best = { x, y, z }; }
      }
    }
    return best;
  }

  // ---- Connectors (portals / subterranean gates / boats) -------------------

  /**
   * Add one goal per usable connector on the hero's level, each priced by the
   * best courage-gated prize reachable THROUGH it: value / (distance to the
   * connector + a crossing cost + distance from its far end to the prize),
   * then damped by CONNECTOR_DAMP so a crossing must clearly beat staying.
   * Far-side prizes only count when the far end's own reachability flood
   * touches them — a gate into a walled-off pocket is worth nothing.
   *
   * Marooned mode (`marooned` = no direct goal is reachable; classic case:
   * the hero collected a sea-locked islet and stands ringed by water):
   * connectors turn into lifelines — valued undamped, portals skip the
   * "must-be-a-shortcut" rule, and a boat is also priced as a ferry toward
   * the best prize ashore, so the hero always finds its way back to work.
   * Returns the number of connector goals added.
   */
  considerConnectors(hero, z, reach, goals, ctx, marooned = false) {
    const state = this.state;
    if ((this._transits.get(hero.id) || 0) >= MAX_TRANSITS_PER_TURN) return 0;
    const damp = marooned ? 1 : CONNECTOR_DAMP;
    let added = 0;

    for (const obj of Object.values(levelObjects(state, z))) {
      // A town object counts as a connector too when it is OUR town with a
      // BUILT Shipyard building — a boat that can be bought at the home port.
      let town = null;
      if (obj.type === 'town') {
        town = state.towns[obj.townId];
        if (!town || town.owner !== this.playerIndex
            || !town.buildings.includes('shipyard')) continue;
        // Another friendly visitor on the square makes the goal un-enterable.
        if (town.visitingHeroId && town.visitingHeroId !== hero.id) continue;
      } else if (obj.type !== 'subGate' && obj.type !== 'portal' && obj.type !== 'boat'
          && obj.type !== 'shipyard') continue;
      const connector = town ? 'townShipyard' : obj.type;
      if (this.isBlack(hero, obj.x, obj.y, z)) continue;
      if (this.isGoalBanned(hero, connector, obj.id, obj.x, obj.y, z)) continue;
      if (!this.nearReach(reach, obj.x, obj.y, 1)) continue; // can't even get there
      // Cross-turn cooldown: a gate/portal channel (or a shipyard / town
      // shipyard, keyed by its id — yards have no channel) used today or
      // yesterday is off the menu (no day-after-day shuttling) — unless the
      // hero is marooned, when riding it out beats standing still.
      const cdKey = town ? `townShipyard|${town.id}`
        : obj.type === 'shipyard' ? `shipyard|${obj.id}` : `${obj.type}|${obj.channel}`;
      if (!marooned && (hero.aiCooldowns?.[cdKey] ?? -1) >= state.day) continue;
      // One boat build per hero per turn, however tasty the water looks.
      if ((town || obj.type === 'shipyard')
          && (this._boatBuilds.get(hero.id) || 0) >= MAX_BOAT_BUILDS_PER_TURN) continue;
      const entry = Math.hypot(obj.x - hero.x, obj.y - hero.y) + CONNECTOR_CROSS;
      // bestThrough ignores the blacklist and the hero stands still during a
      // plan, so its verdict per connector holds across every goal retry.
      const cacheKey = `${obj.id}|${marooned ? 1 : 0}`;
      if (this._throughCache.has(cacheKey)) {
        const cached = this._throughCache.get(cacheKey);
        if (cached && cached.score > 0) {
          goals.push({ x: obj.x, y: obj.y, z, score: cached.score / damp, connector, townId: town?.id, id: obj.id });
          added++;
        }
        continue;
      }
      let best = null;

      if (obj.type === 'subGate') {
        const other = z === 0 ? 1 : 0;
        const partner = Object.values(levelObjects(state, other)).find(
          (o) => o.type === 'subGate' && o.channel === obj.channel,
        );
        if (!partner) continue; // lone gate — inert
        const far = this.floodCached(partner.x, partner.y, other, false);
        best = this.bestThrough(hero, other, far, partner.x, partner.y, entry, ctx, {});
      } else if (obj.type === 'portal') {
        const partner = Object.values(levelObjects(state, z)).find(
          (o) => o.type === 'portal' && o.channel === obj.channel && o.id !== obj.id,
        );
        if (!partner) continue; // lone portal — inert
        const far = this.floodCached(partner.x, partner.y, z, false);
        // A portal is only worth prizes it genuinely brings closer (unless
        // marooned — then any way out beats standing still).
        best = this.bestThrough(hero, z, far, partner.x, partner.y, entry, ctx,
          { closerThanDirect: !marooned });
      } else if (obj.type === 'boat') { // boats sail the surface only
        if (hero.onBoat) continue;
        const water = this.floodCached(obj.x, obj.y, z, true);
        best = this.bestThrough(hero, z, water, obj.x, obj.y, entry, ctx, { seaLockedOnly: true });
        if (marooned) {
          // Lifeline ferry: sail toward the best prize ashore and walk on
          // from the far shore. Valued independently of the per-position
          // blacklist — the crossing is exactly what falsifies it.
          const ferry = this.bestThrough(hero, z, null, obj.x, obj.y, entry, ctx, {});
          if (ferry && (!best || ferry.score > best.score)) best = ferry;
        }
      } else if (obj.type === 'shipyard') { // a boat that must first be BOUGHT (surface only)
        if (hero.onBoat) continue;
        // Only worth pricing when a build would succeed on arrival: dock free
        // and no boat already waiting there. The gold+wood BOAT_COST may be met
        // outright OR closed at the marketplace when the hero arrives — a pure
        // wood/gold shortfall is not a reason to skip a yard when the market
        // can cover it (canCoverCost trades nothing here; tryCoverCost does the
        // actual trade on arrival, in the shipyard step handler).
        const check = shipyardBuildCheck(state, state.players[this.playerIndex], obj);
        let dock = check.dock;
        if (!check.ok) {
          if (check.reason !== 'cost' || !this.canCoverCost(CONFIG.BOAT_COST)) continue;
          dock = shipyardDockTile(state, obj); // 'cost' ⇒ dock is free (checked first)
          if (!dock) continue;
        }
        const water = this.floodCached(dock.x, dock.y, z, true);
        // A boat this hero can already WALK to on the same water body makes
        // the build pure waste — the free boat's own connector goal (above)
        // prices that route, so the yard bows out entirely.
        let served = false;
        for (const b of Object.values(levelObjects(state, z))) {
          if (b.type !== 'boat') continue;
          if (this.nearReach(reach, b.x, b.y, 1) && water[b.y * state.map.w + b.x]) { served = true; break; }
        }
        if (served) continue;
        // Same currency as a boat, plus a build friction so buying never beats
        // boarding: worth the best sea-locked prize on the dock's water body
        // (and, marooned, a ferry ashore — the paid way off a sealed pocket).
        best = this.bestThrough(hero, z, water, dock.x, dock.y,
          entry + SHIPYARD_BUILD_FRICTION, ctx, { seaLockedOnly: true });
        if (marooned) {
          const ferry = this.bestThrough(hero, z, null, dock.x, dock.y,
            entry + SHIPYARD_BUILD_FRICTION, ctx, {});
          if (ferry && (!best || ferry.score > best.score)) best = ferry;
        }
      } else { // townShipyard: our town's built Shipyard — a boat bought at home port
        if (hero.onBoat) continue;
        // Same contract as a map yard: only priced when a build would succeed
        // on arrival (townShipyardBuildCheck), a pure gold/wood shortfall the
        // market can close notwithstanding (canCoverCost trades nothing here;
        // buildTownBoat does the actual trade on arrival).
        const check = townShipyardBuildCheck(state, town);
        let dock = check.dock;
        if (!check.ok) {
          if (check.reason !== 'cost' || !this.canCoverCost(CONFIG.BOAT_COST)) continue;
          dock = townDockTile(state, town); // 'cost' ⇒ dock is free (checked first)
          if (!dock) continue;
        }
        // The town dock may sit up to 2 tiles out — the hero must be able to
        // walk to the dock's shore, or the launched boat could never be boarded.
        if (!this.nearReach(reach, dock.x, dock.y, 1)) continue;
        const water = this.floodCached(dock.x, dock.y, z, true);
        // A boat this hero can already WALK to on the same water body makes
        // the build pure waste — the free boat's own connector goal prices
        // that route, so the home port bows out entirely.
        let served = false;
        for (const b of Object.values(levelObjects(state, z))) {
          if (b.type !== 'boat') continue;
          if (this.nearReach(reach, b.x, b.y, 1) && water[b.y * state.map.w + b.x]) { served = true; break; }
        }
        if (served) continue;
        // Same currency as a map yard: the best sea-locked prize on the
        // dock's water body, plus the build friction so buying never beats
        // boarding a free boat. No marooned ferry pricing here — a hero
        // standing in its own town is never sealed in (conservative on purpose).
        best = this.bestThrough(hero, z, water, dock.x, dock.y,
          entry + SHIPYARD_BUILD_FRICTION, ctx, { seaLockedOnly: true });
      }
      this._throughCache.set(cacheKey, best);
      if (best && best.score > 0) {
        goals.push({ x: obj.x, y: obj.y, z, score: best.score / damp, connector, townId: town?.id, id: obj.id });
        added++;
      }
    }
    return added;
  }

  /**
   * Best value/distance score among the prizes of `level`, as seen through a
   * connector whose far end stands at (px, py) and already costs `baseDist`
   * to reach and cross. Prizes must be near-reachable per the far-side flood
   * `far` (null = skip that check) and pass the same courage gates as
   * pickGoal. Returns { score, x, y } of the best prize, or null.
   * opts.seaLockedOnly: only islet rewards (boats). opts.closerThanDirect:
   * only prizes the via-route brings closer than the crow flies (portals).
   */
  bestThrough(hero, level, far, px, py, baseDist, ctx, opts = {}) {
    const state = this.state;
    const { myForce, courage, aggroMargin, eco, aggr, explore } = ctx;
    let best = null;
    const tally = (x, y, value, guardValue = 0, margin = courage, ring = 1) => {
      if (guardValue > 0 && myForce < guardValue * margin) return;
      if (far && !this.nearReach(far, x, y, ring)) return;
      const via = baseDist + Math.hypot(x - px, y - py);
      if (opts.closerThanDirect && via >= Math.hypot(x - hero.x, y - hero.y)) return;
      const score = value / (via + 1);
      if (!best || score > best.score) best = { score, x, y };
    };

    if (!opts.seaLockedOnly) {
      // Towns are the far level's top prize — enemy and neutral alike (a
      // capturable cavern town is what makes descending genuinely worth it),
      // including rushing home when a town of ours on that level is menaced.
      for (const town of Object.values(state.towns)) {
        if ((town.z ?? 0) !== level) continue;
        if (town.owner === this.playerIndex) {
          // Rushing home through a gate only makes sense if the hero can
          // actually garrison the town — a friendly visitor already on the
          // square makes the rescue un-executable (and valuing it anyway
          // is what would yank a vault-clearing hero up through its gate
          // every single day).
          if (town.visitingHeroId && town.visitingHeroId !== hero.id) continue;
          // Same rescue/consolidation gate as pickGoal: ride home (through
          // the connector) only when home lacks a garrison and this hero
          // cannot simply hunt the menace down. townThreat folds in the
          // decaying memory of a besieger that stepped out of radius.
          const danger = this.townThreat(town);
          if (danger > this.townDefenseValue(town) && myForce < danger * courage) {
            tally(town.x, town.y, 9000 + danger / 2);
          }
          continue;
        }
        if (this.isAlly(town.owner)) {
          // Same protect rule as pickGoal, so a vassal on the other level is
          // worth the gate trip exactly when one on our own level is worth a march.
          if (this.protectedTown(town)) {
            const danger = this.townThreat(town);
            const held = this.townDefenseValue(town);
            if (danger > held && myForce + held >= danger * courage) tally(town.x, town.y, 7000 + danger / 2);
          }
          continue;
        }
        tally(town.x, town.y, 12000 * aggr, this.townDefenseValue(town), aggroMargin);
      }
      for (const h of Object.values(state.heroes)) {
        if (!this.isEnemy(h.owner)) continue;
        if ((h.z ?? 0) !== level) continue;
        const menace = this.heroMenacesUs(h) ? 6000 : 0;
        tally(h.x, h.y, (6000 + menace) * aggr, this.enemyHeroValue(h), aggroMargin);
      }
    }
    for (const obj of Object.values(levelObjects(state, level))) {
      if (!!opts.seaLockedOnly !== !!obj.seaLocked) continue;
      // Same safe-loot rule as pickGoal: no prize inside the strike range of
      // a superior enemy field army, however tempting the far side looks.
      if (myForce < this.threatNear(obj.x, obj.y, level) * courage) continue;
      const guard = this.guardValueNear(obj, level);
      switch (obj.type) {
        case 'mine':
          // Same rule as pickGoal: a teammate's (or vassal's) mine cannot change
          // hands, so it is not worth a connector trip either.
          if (obj.owner !== this.playerIndex && !this.isAlly(obj.owner)) {
            tally(obj.x, obj.y, (obj.mineType === 'goldMine' ? PRIZE.goldMine : PRIZE.mine) * eco, guard);
          }
          break;
        case 'resource': tally(obj.x, obj.y, PRIZE.resource * eco, guard); break;
        case 'chest': tally(obj.x, obj.y, PRIZE.chest * eco, guard); break;
        case 'artifact': tally(obj.x, obj.y, PRIZE.artifact, guard); break;
        case 'keymaster':
          if (!playerHasKey(state, this.playerIndex, obj.color)) {
            const worth = this.keymasterUnlockValue(state, obj.color, level);
            if (worth > 0) tally(obj.x, obj.y, worth * eco, guard);
          }
          break;
        case 'creatureBank':
          if (!obj.looted) { const bv = this.bankValue(obj); tally(obj.x, obj.y, bv.reward * eco, bv.guard); }
          else { const bd = this.broodValue(obj); if (bd > 0) tally(obj.x, obj.y, bd, guard); }
          break;
        case 'pandora':
          if (!obj.looted) { const pv = this.pandoraValue(obj); tally(obj.x, obj.y, pv.reward * eco, pv.guard); }
          break;
        // Same pricing as pickGoal, through the same two methods — a hut or a
        // post reached through a portal is worth exactly what one reached on
        // foot is worth.
        case 'seerHut': {
          const sv = this.seerValue(hero, obj);
          if (sv > 0) tally(obj.x, obj.y, sv * eco, guard);
          break;
        }
        case 'tradingPost': {
          const pv = this.postValue(hero, obj);
          if (pv > 0) tally(obj.x, obj.y, pv, guard);
          break;
        }
        case 'booster':
          // Same booster pricing as pickGoal — now literally the same code, so an
          // obelisk mid-grail-hunt is valued identically whether reached on foot
          // or through this connector (was flat 800 here: the shipped drift).
          if (!boosterSpent(state, hero, obj)) {
            tally(obj.x, obj.y, this.boosterScore(obj, hero) * explore, guard);
          }
          break;
        case 'dwelling': {
          const dv = this.dwellingValue(obj);
          if (dv > 0) tally(obj.x, obj.y, dv, guard);
          break;
        }
        case 'monster': {
          const v = creaturePower(obj.creature, this.physical) * obj.count;
          // Ring 2: a guard's zone of control keeps the flood a tile away.
          if (myForce >= v * courage) tally(obj.x, obj.y, PRIZE.monster, 0, courage, 2);
          break;
        }
        default: break;
      }
    }
    return best;
  }

  /**
   * Goal for a hero ABOARD A BOAT: sail to a sea-locked islet reward
   * (stepping ashore collects it), attack an enemy this water body reaches —
   * an enemy boat hero (fleet clash) or a coastal enemy hero / town / weak
   * guard (naval raid; stepHero resolves the fight from the deck, the hero
   * stays aboard) — or land at the shore tile that best serves its strongest
   * land goal and resume life on foot. `reach` is the water flood from the
   * hero's tile — only this body of water is sailable.
   */
  pickBoatGoal(hero, reach) {
    const state = this.state;
    this.metrics.goalPicks++;
    const z = hero.z ?? 0;
    const myForce = armyPower(hero.army, this.physical); // gates only — see pickGoal
    const courage = courageAt(state.day) * aiCourageMult(state);
    const isMain = hero.id === this.mainHeroId;
    const aggroMargin = isMain ? courage : courage * 1.6;
    const eco = (isMain ? 1 : 1.6) * this.warlord.economy;
    const aggr = this.warlord.aggression * tideNoRushFactor(state); // conquest appetite (desirability only; gate untouched; #11 early damp)
    const explore = this.warlord.exploration; // pull toward boosters/obelisks
    const ctx = { myForce, courage, aggroMargin, eco, aggr, explore };

    // Prizes at sea: islet rewards plus naval-combat targets, one list, one
    // deterministic ordering. When no combat target borders this water the
    // list is exactly the old islet list — connector-less behavior unchanged.
    const prizes = [];

    // Islet rewards in this water body (disembarking onto one collects it).
    for (const obj of Object.values(levelObjects(state, z))) {
      if (!obj.seaLocked) continue;
      if (this.isBlack(hero, obj.x, obj.y, z)) continue;
      if (obj.type === 'booster' && boosterSpent(state, hero, obj)) continue;
      if (!this.nearReach(reach, obj.x, obj.y, 1)) continue;
      // Safe loot only (same rule as the land scans): skip prizes inside a
      // superior enemy field army's strike range.
      if (myForce < this.threatNear(obj.x, obj.y, z) * courage) continue;
      const guard = this.guardValueNear(obj, z);
      if (guard > 0 && myForce < guard * courage) continue;
      // Priced from the shared PRIZE table, so an islet obelisk mid-grail-hunt is
      // worth what it is ashore (was flat 800: the boat half of the shipped drift).
      const value = obj.type === 'booster'
        ? this.boosterScore(obj, hero) * explore
        : ({ chest: PRIZE.chest * eco, resource: PRIZE.resource * eco, artifact: PRIZE.artifact }[obj.type] ?? PRIZE.booster);
      const d = Math.hypot(obj.x - hero.x, obj.y - hero.y) + 1;
      prizes.push({ x: obj.x, y: obj.y, z, score: value / d });
    }

    // Naval combat: fleet clashes and coastal raids, priced and courage-gated
    // exactly like their land equivalents in pickGoal. A target qualifies when
    // it floats on (or borders) this water body. No oscillation is possible:
    // a won fight removes/captures the target (the goal disappears), a lost
    // one removes the hero, and an unreachable or blocked target is
    // blacklisted for the turn like any other goal.
    const fight = (x, y, score, guardValue = 0, margin = courage) => {
      if (this.isBlack(hero, x, y, z)) return;
      if (guardValue > 0 && myForce < guardValue * margin) return;
      if (!this.nearReach(reach, x, y, 1)) return;
      const d = Math.hypot(x - hero.x, y - hero.y) + 1;
      prizes.push({ x, y, z, score: score / d });
    };
    for (const town of Object.values(state.towns)) {
      if ((town.z ?? 0) !== z) continue;
      if (town.owner === this.playerIndex || this.isAlly(town.owner)) continue;
      fight(town.x, town.y, 12000 * aggr, this.townDefenseValue(town), aggroMargin);
    }
    for (const h of Object.values(state.heroes)) {
      if (!this.isEnemy(h.owner)) continue;
      if ((h.z ?? 0) !== z) continue;
      const menace = this.heroMenacesUs(h) ? 6000 : 0;
      fight(h.x, h.y, (6000 + menace) * aggr, this.enemyHeroValue(h), aggroMargin);
    }
    for (const obj of Object.values(levelObjects(state, z))) {
      if (obj.type !== 'monster' || obj.seaLocked) continue;
      // Never brawl with a shore guard inside a superior enemy's strike range.
      if (myForce < this.threatNear(obj.x, obj.y, z) * courage) continue;
      // Clearing a weak shore guard = free XP (and often unlocks a landing).
      const v = creaturePower(obj.creature, this.physical) * obj.count;
      if (myForce >= v * courage) fight(obj.x, obj.y, 900);
    }

    prizes.sort((a, b) => (b.score - a.score) || (a.y - b.y) || (a.x - b.x));

    // Life ashore: the best land prize, valued as the crow flies from here.
    const land = this.bestThrough(hero, z, null, hero.x, hero.y, 0, ctx, {});
    const bestPrize = prizes[0] || null;
    if (bestPrize && (!land || bestPrize.score >= land.score)) return bestPrize;
    if (land) {
      const spot = this.findLanding(hero, reach, land.x, land.y);
      if (spot) return spot;
    }
    if (bestPrize) return bestPrize;
    // Nothing anywhere: at least get back ashore, nearest safe landing first.
    return this.findLanding(hero, reach, hero.x, hero.y);
  }

  /**
   * Best tile for a boat hero to step ashore on, heading for (tx, ty): a
   * clear land tile bordering this water body that stepHero's disembark rules
   * accept (no obstacle, no monster/town/portal/gate, no guard's zone of
   * control, unoccupied), minimizing sail distance + remaining march.
   */
  findLanding(hero, reach, tx, ty) {
    const state = this.state;
    const { w, h } = state.map;
    const z = hero.z ?? 0;
    let best = null, bestD = Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = tileAt(state, x, y, z);
        if (!t || t.terrain === 'water' || t.obstacle) continue;
        if (!this.nearReach(reach, x, y, 1)) continue; // must border our water
        if (this.isBlack(hero, x, y, z)) continue;
        const o = t.objectId ? levelObjects(state, z)[t.objectId] : null;
        if (o && (o.type === 'monster' || o.type === 'town' || o.type === 'portal' || o.type === 'subGate')) continue;
        if (heroAt(state, x, y, z)) continue;
        if (monsterNear(state, x, y, null, z)) continue;
        const d = Math.hypot(x - hero.x, y - hero.y) + Math.hypot(tx - x, ty - y);
        if (d < bestD) { bestD = d; best = { x, y, z, landing: true }; }
      }
    }
    return best;
  }

  // ---- Reachability floods --------------------------------------------------

  /**
   * 8-directional flood of the tiles walkable in the given level/mode from
   * (x0, y0), honoring the A*'s own rules (isWalkable + no corner-cutting),
   * seeded even when the start tile itself is solid (a gate/portal exit, the
   * hero's own tile). Returns a Uint8Array mask over the w×h grid.
   */
  flood(x0, y0, level, onBoat, mask = null) {
    const state = this.state;
    const { w, h } = state.map;
    const seen = new Uint8Array(w * h);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return seen;
    // isWalkable is costly (zone-of-control + hero scans) and each tile is
    // probed as the neighbour of up to eight others — memoize per tile, and
    // hand it a walk context so those two scans are done ONCE for the whole
    // flood instead of once per tile. The floods are where the AI turn's time
    // went at 88×72 (~180 per turn late-game, 74% of the engine's cost), and
    // the per-tile hero scan alone was 29% of the whole profile.
    //
    // `mask` (optional) goes one better for the plan-scoped callers: a fully
    // prefilled memo from walkMaskCached, shared by every flood of the same
    // level/mode within one plan — the world cannot change between goal
    // retries, so ~13 floods per plan were each re-answering the identical
    // per-tile question. Same encoding as the memo (1 walkable, 2 blocked),
    // already complete, so the lazy branch below simply never fires.
    const memo = mask || new Uint8Array(w * h); // 0 unknown, 1 walkable, 2 blocked
    const wctx = mask ? null : makeWalkContext(state, level, null);
    const walk = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      const i = y * w + x;
      // Fog-omniscient (-1) but with THIS player's keys, so a Border Guard we
      // hold the key for reads as the open doorway it really is (see findPath).
      if (memo[i] === 0) memo[i] = isWalkable(state, x, y, -1, null, onBoat, level, this.playerIndex, wctx) ? 1 : 2;
      return memo[i] === 1;
    };
    const stack = [y0 * w + x0];
    seen[y0 * w + x0] = 1;
    let size = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of FLOOD_DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (seen[j] || !walk(nx, ny)) continue;
        // No cutting corners diagonally past blocked tiles (mirrors findPath).
        if (dx !== 0 && dy !== 0 && !walk(x + dx, y) && !walk(x, y + dy)) continue;
        seen[j] = 1;
        size++;
        stack.push(j);
      }
    }
    seen.size = size; // component size, for the marooned (stranded) test
    return seen;
  }

  /** flood() with a per-plan cache (cleared at the top of every makePlan). */
  floodCached(x, y, level, onBoat) {
    const key = `${level}|${onBoat ? 1 : 0}|${x},${y}`;
    let f = this._reachCache.get(key);
    if (!f) {
      f = this.flood(x, y, level, onBoat, this.walkMaskCached(level, onBoat));
      this._reachCache.set(key, f);
    }
    return f;
  }

  /**
   * The full per-tile walkability grid for one level/mode, cached per plan
   * (cleared beside _reachCache at the top of every makePlan, for the same
   * reason: the world cannot change between goal retries). One plan runs a
   * dozen-plus floods — the hero's own reach plus one per connector exit and
   * dock — and they differ only in their SEED tile; the per-tile verdicts are
   * identical. Answering them once per level/mode instead of once per flood
   * took the 88×72 benchmark from 40.0s to 30.2s over 120 turns (measured via
   * scripts/sim/aiperf.mjs 60 88 72, byte-identical game either way).
   * Encoding matches flood()'s memo: 1 walkable, 2 blocked, no zeros left.
   */
  walkMaskCached(level, onBoat) {
    const key = `${level}|${onBoat ? 1 : 0}`;
    let mask = this._walkMasks.get(key);
    if (!mask) {
      const state = this.state;
      const { w, h } = state.map;
      const wctx = makeWalkContext(state, level, null);
      mask = new Uint8Array(w * h);
      let i = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i++) {
          mask[i] = isWalkable(state, x, y, -1, null, onBoat, level, this.playerIndex, wctx) ? 1 : 2;
        }
      }
      this._walkMasks.set(key, mask);
    }
    return mask;
  }

  /** Is any tile within `ring` of (x, y) in the flood mask? (null = yes) */
  nearReach(reach, x, y, ring = 1) {
    if (!reach) return true;
    const { w, h } = this.state.map;
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && reach[ny * w + nx]) return true;
      }
    }
    return false;
  }

  /**
   * Which damage model this game is running.
   *
   * Every force comparison in this class — what a band is worth, whether a hero
   * can take a town, how frightening a disguised enemy is — is read in POWER, and
   * power is measured per model (src/core/power.js). A physical-model game whose
   * AI judged threats off the classic table would be reading a strength claim its
   * own battles disagree with.
   *
   * That first sentence is an INVARIANT, and it was broken for a while: the
   * opposition side (enemyHeroValue, bandForce, everything threatNear/townThreat
   * derive from them) was converted to power and the AI's OWN side — myForce in
   * the goal scans, townDefenseValue, guardValueNear's monster term, bank and
   * Pandora guards — stayed a price, so every courage margin silently drifted
   * (±12% under the shipped classic table; up to 1.70× under physicalDamage,
   * where an AI attacked its own mirror image believing it outnumbered it).
   * Both sides of every can-I-win gate now read power. The alternative —
   * converting the opposition BACK to price — was rejected: bandForce must
   * stay in power (invasions.js budgets and sells bands in it), fight outcomes
   * under either model track power rather than price, and two tests pin the
   * enemy side as power (ai-turtle, ai-force-concentration).
   *
   * PRICE (aiValue / armyValue) deliberately remains the unit of WORTH: prize
   * scores, pickup/consolidation economics, hire and buyout ledgers, and
   * militaryStandings' share-of-world-military — comparisons where both sides
   * are the same designed ledger and no battle is being predicted.
   */
  get physical() { return physicalModel(this.state); }

  /** Army value of our strongest own hero — the pessimistic stand-in for a
   *  disguised enemy (see enemyHeroValue). */
  myStrongestArmyValue() {
    // POWER, not price: every caller is asking "can we take this / are we
    // outmatched", and it is compared against enemyHeroValue and bandForce, both
    // of which are now in power. See src/core/power.js.
    let best = 0;
    for (const h of playerHeroes(this.state, this.playerIndex)) best = Math.max(best, armyPower(h.army, this.physical));
    return best;
  }

  /** The army value the AI should ASSUME for an enemy hero. A hero under Disguise
   *  hides its true army from scouting, so the AI must not read armyValue(h.army)
   *  — otherwise the spell does nothing against the game's only opponent. Estimate
   *  pessimistically (at least as strong as our own best hero) so a disguised
   *  hero deters attacks and registers as a credible town threat. */
  enemyHeroValue(h) {
    if (!h) return 0;
    if (!h.disguised) return armyPower(h.army, this.physical);
    // A cloak is only as good as the caster: Air mastery inflates what the
    // cloak makes us fear (CONFIG.DISGUISE_BLUFF_BY_SCHOOL), so an Expert's
    // Disguise deters rather than merely withholding.
    return this.myStrongestArmyValue()
      * adventureParam(h, 'disguise', CONFIG.DISGUISE_BLUFF_BY_SCHOOL);
  }

  /** The biggest enemy field army this realm knows of, anywhere on any level.
   *  Used to decide whether to mass rather than dilute (CONFIG.AI_MASS_RATIO). */
  strongestKnownEnemyArmy() {
    let best = 0;
    for (const h of Object.values(this.state.heroes)) {
      if (!this.isEnemy(h.owner)) continue;
      best = Math.max(best, this.enemyHeroValue(h));
    }
    return best;
  }

  /** Strongest enemy hero within striking distance of (x, y) — or null. */
  /**
   * What a menace is worth, whoever it is. A war-band is a `monster` map object
   * rather than a hero (see core/invasions.js), so `enemyHeroValue` would read
   * an army it does not have and price the whole invasion at zero.
   */
  menaceValue(entity) {
    if (!entity) return 0;
    return entity.invader ? bandForce(entity, this.physical) : this.enemyHeroValue(entity);
  }

  menaceNear(x, y, level = 0) {
    let worst = null, worstValue = 0;
    const heroes = this.state.heroes;
    for (const id in heroes) {
      const h = heroes[id];
      if (!this.isEnemy(h.owner)) continue; // allies (and self) are no threat
      if ((h.z ?? 0) !== level) continue; // striking range never crosses levels
      if (Math.hypot(h.x - x, h.y - y) > THREAT_RADIUS) continue;
      const v = this.enemyHeroValue(h);
      if (v > worstValue) { worst = h; worstValue = v; }
    }
    // War-bands too. A band is a map object, not a hero, so the whole threat
    // system was blind to an invasion: measured over 168 player-turns, not ONE
    // town on the board ever carried a threat memory, because the only thing
    // that had been marching on towns was a thing menaceNear could not see.
    // Every consumer downstream — the turtle-in-town hold, the rescue march, the
    // no-hire-while-besieged gate, the safe-loot veto, a suzerain's duty to a
    // vassal — was therefore switched off for exactly the attacks that come
    // without a declaration of war.
    if (level === 0) {
      for (const band of activeBands(this.state)) {
        if (Math.hypot(band.x - x, band.y - y) > THREAT_RADIUS) continue;
        const v = bandForce(band, this.physical);
        if (v > worstValue) { worst = band; worstValue = v; }
      }
    }
    return worst;
  }

  /**
   * A band that has NAMED this town as its target threatens it from wherever it
   * stands — the whole map away if need be.
   *
   * This is the early warning. A band declares `invader.targetTownId` the day it
   * comes ashore and marches at it for days; waiting for it to close inside the
   * eight-tile strike radius means the alarm sounds when it is already at the
   * gate, which is exactly what a player described: a HUD line, and then a lost
   * town. A hero can cross a map in the time a band takes to; a garrison can be
   * bought in a week. Both need the warning early to be worth anything.
   */
  committedBand(town) {
    if (!town) return null;
    let worst = null, worstValue = 0;
    for (const band of activeBands(this.state)) {
      if (band.invader?.targetTownId !== town.id) continue;
      const v = bandForce(band, this.physical);
      if (v > worstValue) { worst = band; worstValue = v; }
    }
    return worst;
  }

  /** What the committed band is worth, or 0 when none has named this town. */
  committedBandThreat(town) {
    return bandForce(this.committedBand(town), this.physical) || 0;
  }

  /** Is this hero's committed goal the flight to a refuge? */
  isRetreating(hero) {
    return typeof hero.aiGoal?.key === 'string' && hero.aiGoal.key.startsWith('retreat to refuge|');
  }

  /**
   * Would this step put a fleeing hero INTO contact it is not already in?
   *
   * The retreat goal is pathed with the avoid-zone switched off — it has to be,
   * or a hero could not route home past the very thing chasing it — so nothing
   * else stops a flight that walks straight at the menace. Ending a turn two
   * tiles out is survivable; ending it adjacent is how a retreat becomes a
   * death. A hero already in contact is not blocked: it still needs to move.
   */
  stepEntersReach(hero, step) {
    const z = hero.z ?? 0;
    const menace = this.menaceNear(step.x, step.y, z);
    if (!menace) return false;
    const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
    const now = cheb(menace.x, menace.y, hero.x, hero.y);
    const after = cheb(menace.x, menace.y, step.x, step.y);
    return after <= 1 && after < now;
  }

  /** Strongest enemy field army within striking distance of (x, y) on `level`. */
  threatNear(x, y, level = 0) {
    return this.menaceValue(this.menaceNear(x, y, level));
  }

  /**
   * The remembered (decayed) threat for a town — town.aiThreat's PEAK army
   * value, fading linearly to zero over THREAT_MEMORY_DAYS since it was last
   * SEEN at that strength. 0 when no memory exists or it has fully expired.
   */
  /**
   * Is this war-band coming for one of OUR towns?
   *
   * A band carries `invader.targetTownId` from the day it lands, so this is a fact it
   * has already declared rather than a guess from proximity — the same field the
   * threat model reads (committedBand). A band marching on somebody else's realm is
   * not our business and stays priced as ordinary loot.
   */
  bandMenacesUs(obj) {
    if (!obj?.invader) return false;
    const town = this.state.towns[obj.invader.targetTownId];
    return !!town && town.owner === this.playerIndex;
  }

  rememberedThreat(town) {
    const mem = town.aiThreat;
    if (!mem) return 0;
    const age = this.state.day - mem.day;
    if (age >= THREAT_MEMORY_DAYS) return 0;
    return mem.value * (1 - age / THREAT_MEMORY_DAYS);
  }

  /** Effective danger to a town: the live menace or the decayed memory of one. */
  townThreat(town) {
    return Math.max(
      this.threatNear(town.x, town.y, town.z ?? 0),
      this.rememberedThreat(town),
      this.committedBandThreat(town),
    );
  }

  /**
   * Refresh each own town's persistent threat memory (once, at the top of the
   * AI turn). town.aiThreat = { value, x, y, z, day } is plain data on the
   * town, so it serializes with the save and round-trips load like
   * hero.aiCooldowns. Semantics: the strongest LIVE menace overwrites the
   * memory whenever it meets or beats the decayed remembrance (so the peak is
   * held while the besieger camps, and a weakened enemy lets it fade); an
   * absent menace leaves the memory decaying in place; a fully-decayed memory
   * is dropped so the town returns to normal economy play.
   */
  updateThreatMemory() {
    const state = this.state;
    for (const town of playerTowns(state, this.playerIndex)) {
      // The worst of what stands nearby and what has NAMED this town — a band
      // marching from the far edge is a real threat with a real position, so the
      // memory has to be able to record something that is not within the strike
      // radius yet. Taking `menaceNear`'s object unconditionally is what made a
      // first cut of this throw on a committed band a map away.
      const near = this.menaceNear(town.x, town.y, town.z ?? 0);
      const committed = this.committedBand(town);
      const nearVal = this.menaceValue(near);
      const commVal = bandForce(committed, this.physical) || 0;
      const menace = commVal > nearVal ? committed : near;
      const live = Math.max(nearVal, commVal);
      const remembered = this.rememberedThreat(town);
      if (live > 0 && menace && live >= remembered) {
        town.aiThreat = {
          value: live, x: menace.x, y: menace.y, z: menace.z ?? 0, day: state.day,
        };
      } else if (town.aiThreat && remembered <= 0) {
        delete town.aiThreat;
      }
    }
  }

  /** Does this enemy hero credibly threaten one of our towns right now? */
  heroMenacesUs(h) {
    const v = this.enemyHeroValue(h);
    for (const town of playerTowns(this.state, this.playerIndex)) {
      if ((h.z ?? 0) !== (town.z ?? 0)) continue; // a menace stands on the town's level
      if (Math.hypot(h.x - town.x, h.y - town.y) <= THREAT_RADIUS &&
          v > this.townDefenseValue(town)) {
        return true;
      }
    }
    return false;
  }

  /**
   * How much attacker FORCE it really takes to storm this town — the AI's
   * siege gate. Was the bare garrison + visitor army value, blind to the fort AND
   * the defending hero, so late-game (as courage decays) the AI launched suicide
   * sieges into walled, hero-held towns. Now the fort tier and the defending
   * hero's attack/defense both stiffen the figure, both autoResolve-calibrated
   * (~2% more effective value per combined hero stat-point). See G62.
   *
   * Read in POWER: every consumer holds this against a power — myForce at the
   * enemy-town gate, townThreat in the rescue/turtle/hire arithmetic,
   * enemyHeroValue in heroMenacesUs — and invasions.js's own townDefense (the
   * band's mirror-image of this figure) already reads armyPower. The G62
   * calibration was made under classic, where the index table sits within
   * 0.885–1.009 of 1, so the calibration survives the currency (±1.5%);
   * under physicalDamage the figure now agrees with the battles it predicts.
   */
  townDefenseValue(town) {
    const state = this.state;
    const hero = town.visitingHeroId ? state.heroes[town.visitingHeroId] : null;
    let v = armyPower(town.garrison, this.physical)
      + (hero ? armyPower(hero.army || [], this.physical) : 0);
    const fortTier = (town.buildings || []).includes('castle') ? 3
      : (town.buildings || []).includes('citadel') ? 2
      : (town.buildings || []).includes('fort') ? 1 : 0;
    v *= FORT_MULT[fortTier];
    if (hero) v *= 1 + (heroStat(hero, 'attack') + heroStat(hero, 'defense')) * 0.02;
    return Math.round(v);
  }

  /**
   * The fighting force garrisoned on a holding, in POWER — the gate-side twin
   * of holdings.defenceValue (a price). The goal scans hold this against
   * myForce, so it must read the same currency; defenceValue keeps pricing the
   * SPENDING questions (investInDefence's ranking, the buyout log), where the
   * ledger is gold and price is the honest unit.
   */
  holdingDefenceForce(obj) {
    const d = defenceOf(obj);
    return d ? armyPower(d.garrison || [], this.physical) : 0;
  }

  /**
   * Guard stacks adjacent to (or on) an object's tile, on the object's own
   * level (underground ids are 'U…'-prefixed, which names their level).
   * Enemy HEROES standing on or beside the object count as guards exactly
   * like monsters do: a superior hero squatting on a mine gates a weak hero
   * off the prize instead of luring it into a hopeless fight.
   */
  /** { guard, reward } estimate for an un-looted Creature Bank: the garrison's
   *  POWER (gates winnability in consider/tally, against myForce) and the
   *  prize's PRICE (gold-equivalent desirability). Two currencies on purpose —
   *  one answers "can we", the other "should we bother". */
  /** Army value an external dwelling offers THIS player right now: the accrued
   *  stock, clamped to what we can afford, priced at the creature's aiValue.
   *  0 when broke or empty — so a cash-poor AI never detours for a dwelling it
   *  cannot buy from. */
  dwellingValue(obj) {
    const cr = dwellingCreature(obj);
    const c = CREATURES[cr];
    const stock = obj.available || 0;
    if (!c || stock <= 0) return 0;
    const res = this.state.players[this.playerIndex].resources || {};
    let affordable = stock;
    for (const r of RESOURCES) if (c.cost[r]) affordable = Math.min(affordable, Math.floor((res[r] || 0) / c.cost[r]));
    return (c.aiValue || 0) * Math.max(0, affordable);
  }

  bankValue(obj) {
    const guard = (obj.guards || []).reduce((n, g) => n + creaturePower(g.creature, this.physical) * g.count, 0);
    const r = bankDef(obj.bankType)?.reward || {};
    let reward = r.gold || 0;
    for (const amt of Object.values(r.resources || {})) reward += amt * 120;
    for (const c of (r.creatures || [])) reward += (CREATURES[c.creature]?.aiValue || 0) * c.count;
    // `reward.artifact` is a rarity BAND, so price it as one rather than at a
    // flat 3000 — a boss lair's top-band relic is worth three times a value-1
    // trinket and the AI was pricing every lair the same. Through
    // artifactBandValue so the AI and the trading post cannot disagree.
    if (r.artifact) reward += artifactBandValue(r.artifact);
    return { guard, reward };
  }

  /** What a LOOTED lair's accrued brood is worth (the `lairBrood` feature): free
   *  army, undefended, so it prices exactly like a dwelling's stock and needs no
   *  guard check. 0 when the nest is empty or the feature is off. */
  broodValue(obj) {
    const n = obj.brood || 0;
    if (n <= 0) return 0;
    const cr = broodOf(obj.bankType)?.creature;
    return (CREATURES[cr]?.aiValue || 0) * n;
  }

  /** { guard, reward } estimate for an un-opened Pandora's Box — its stamped
   *  guard (0 for a free find) and the gold-equivalent of its rolled reward. */
  /**
   * What a Seer Hut is worth to us — WITHOUT peeking at the sealed reward.
   *
   * The hut's reward is hidden from the player until the tribute is offered, and
   * the generator's contract is that it is always worth at least TWICE the
   * tribute (pinned by tests/seer-huts). So the AI values a hut by that
   * guarantee rather than by reading `obj.reward`: pay X, receive at least 2X,
   * net at least X. It plays by exactly the promise the player is asked to
   * trust, which also means a hut that is a good deal for a human is a good deal
   * for the AI, computed the same way.
   *
   * Zero when we cannot pay — through `seerQuestMet`, the same predicate the
   * hut itself uses to refuse, so the march and the arrival cannot disagree.
   */
  seerValue(hero, obj) {
    if (obj.done || !obj.quest) return 0;
    if (!seerQuestMet(this.state, hero, obj.quest)) return 0;
    const q = obj.quest;
    // The AI's own resource pricing (as bankValue and pandoraValue use).
    const tribute = q.res === 'gold' ? q.amount : q.amount * 120;
    return tribute; // the guaranteed NET: 2x back, minus the 1x paid
  }

  /**
   * What a Trading Post is worth to us. Two separate businesses under one roof.
   *
   * SELLING is the reliable half: everything still in the backpack after
   * `optimizeEquipment` has had its pass is gear this hero has already declined
   * to wear, and the post turns it into experience at `value x 27 000`. Quoted
   * back in gold through CONFIG.XP_PER_GOLD so it lands on the same scale as
   * every other prize the goal picker weighs.
   *
   * BUYING is the conditional half: an item is only worth anything if its rarity
   * band beats what is in that socket now — the same comparison
   * `optimizeEquipment` makes — and if we can actually afford it.
   */
  postValue(hero, obj) {
    const state = this.state;
    const player = state.players[this.playerIndex];
    let worth = 0;
    // Surplus in the pack: what the hero would not wear anyway.
    for (const id of hero.backpack || []) {
      const art = ARTIFACTS[id];
      if (!art) continue;
      const socket = Object.keys(EQUIP_SOCKETS).find((sk) => EQUIP_SOCKETS[sk] === art.slot
        && (!hero.equipment[sk] || (ARTIFACTS[hero.equipment[sk]]?.value || 0) < art.value));
      if (socket) continue; // it is an upgrade, not surplus — it will be worn
      worth += tradingPostSellXp(id) / (CONFIG.XP_PER_GOLD || 1);
    }
    // Upgrades on the shelf we can pay for.
    for (const id of obj.stock || []) {
      const art = ARTIFACTS[id];
      if (!art || !canAfford(player, tradingPostBuyCost(id))) continue;
      const best = Object.keys(EQUIP_SOCKETS)
        .filter((sk) => EQUIP_SOCKETS[sk] === art.slot)
        .reduce((n, sk) => Math.min(n, ARTIFACTS[hero.equipment[sk]]?.value ?? -1), Infinity);
      if (art.value > best) worth += PRIZE.artifact;
    }
    return worth;
  }

  pandoraValue(obj) {
    // guard in POWER, reward in PRICE — same split as bankValue, same reasons.
    const guard = (obj.guards || []).reduce((n, g) => n + creaturePower(g.creature, this.physical) * g.count, 0);
    return { guard, reward: pandoraRewardValue(obj.reward) };
  }

  /**
   * What a Keymaster Tent's key is actually worth: the sum of the caches it would
   * unlock. Every still-locked Border Guard of the matching color on this level
   * gates one adjacent dead-end reward (MapGenerator.placeKeyVaults leaves the
   * guard touching nothing but its vault), and those rewards are unreachable
   * until the key is earned — so the tent scales with what's PROVABLY behind it,
   * and is worth 0 when it opens nothing, instead of a flat guess.
   *
   * Runs inside the per-object goal scan (and again per connector in
   * bestThrough), so it must not re-materialise the level. It used to:
   * Object.values + a fresh Map of EVERY object on the level per call came to
   * 4,673 calls / 423ms / 2.9% of the AI budget on a 72×60 run, scaling with
   * map size. Now the guard list comes from the objectsWhere index (`type` is
   * fixed at creation, exactly the predicate contract that cache documents —
   * an unlocked guard's removal breaks its identity check, so the list can
   * never go stale), and the vault beside each guard is read through
   * tileAt→objectId, the same live lookup guardValueNear uses — which also
   * sees a cache a hero already looted as the removed object it is, where the
   * rebuilt Map only happened to. A memo keyed on (color, level) was rejected
   * for exactly that staleness.
   */
  keymasterUnlockValue(state, color, level) {
    const guards = objectsWhere(state, level, 'borderGuards', (o) => o.type === 'borderGuard');
    const objects = levelObjects(state, level);
    let total = 0;
    for (const g of guards) {
      if (g.color !== color) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = tileAt(state, g.x + dx, g.y + dy, level);
        const r = t && t.objectId ? objects[t.objectId] : null;
        if (r) total += this.gatedRewardValue(r);
      }
    }
    return total;
  }

  /** The object-loop's price for a single cache gated behind a Border Guard. */
  gatedRewardValue(obj) {
    switch (obj.type) {
      case 'resource': return obj.resource === 'gold' ? (obj.amount || 3500) : 1200;
      case 'chest': return 1500;
      case 'artifact': return 2000;
      default: return 1000; // an unrecognised cache — keep the old flat worth
    }
  }

  /**
   * The single valuation for a booster/obelisk, used by every goal picker. A
   * plain booster is worth PRIZE.booster; an UNREAD Obelisk advances the Grail
   * puzzle, worth more — and MORE as the puzzle nears completion — so the AI
   * finishes what it starts. Only pickGoal knew this; bestThrough and pickBoatGoal
   * flat-priced every booster at 800, so a through-connector or boat hero would
   * sail past an obelisk a land hero rode 4000 for. Callers still gate on
   * boosterSpent() first (a used/weekly-drained booster is worth nothing now).
   */
  boosterScore(obj, hero = null) {
    const state = this.state;
    const t = obj.boosterType;
    if (t === 'obelisk' && !(state.players[this.playerIndex].obeliskIds || []).includes(obj.id)) {
      // One progress read, not two: grailKnown() is obeliskProgress() with a
      // comparison on it, so asking both counted every obelisk on both levels
      // twice for every obelisk the scan priced.
      const { seen, total } = obeliskProgress(state, this.playerIndex);
      if (total > 0 && seen < total) return PRIZE.obeliskBase + PRIZE.obeliskLead * (seen / total);
    }
    // Premium scholar sites are worth more than a single-stat shrine: the
    // Library grants four stat points at once, the Tree a whole level.
    if (t === 'library') return PRIZE.booster * 3;
    if (t === 'treeOfKnowledge') return PRIZE.booster * 2;

    // Everything below is priced by WHAT IT ACTUALLY GIVES THIS HERO, which is
    // the whole reason the AI used to walk past the three boosters that matter
    // most. A flat 800 put a Hill Fort that would upgrade a hero's entire army,
    // a Magic Well that refills a caster's book, and a Wayfarer's Camp worth a
    // third of a day's march all on exactly the same footing as a +1 morale
    // shrine — so they lost every scoring contest and the AI never went. The
    // report was blunt about it: rivals "don't have on their side the waypoints
    // to boost range, the wells to give them mana, or the forts to upgrade
    // creatures — they should have the same boosters as me".
    //
    // Without a hero to price against (a through-connector scan), fall back to
    // the flat value: better a low estimate than a wrong one.
    if (!hero) return PRIZE.booster;

    // A Hill Fort: literally free army. Worth the value the upgrades would ADD,
    // counting only the stacks the realm can actually pay to upgrade (the same
    // affordability test boosterSpent uses, so the two never disagree).
    if (t === 'hillFort') {
      const player = state.players[this.playerIndex];
      let gain = 0;
      for (const s of hero.army || []) {
        if (!s || !(s.count > 0)) continue;
        const to = upgradeTargetOf(s.creature);
        if (!to) continue;
        const tier = CREATURES[s.creature].tier || 0;
        const cost = tier <= CONFIG.HILL_FORT_FREE_TIER ? {} : upgradeUnitCost(s.creature, to, s.count);
        if (!canAfford(player, cost)) continue;
        gain += Math.max(0, (CREATURES[to].aiValue - CREATURES[s.creature].aiValue) * s.count);
      }
      return gain > 0 ? Math.max(PRIZE.booster, gain) : 0;
    }

    // Mana: worth the DEFICIT it fills, and only to a hero with spells to spend
    // it on. A well is a full refill; a spring overfills past the cap.
    if (t === 'mana' || t === 'magicSpring') {
      const max = heroMaxMana(hero);
      if (!max || !(hero.spells || []).length) return 0;
      const fill = t === 'magicSpring'
        ? max * CONFIG.MAGIC_SPRING_MULT - (hero.mana || 0)
        : max - (hero.mana || 0);
      if (fill <= 0) return 0;
      return PRIZE.booster * (0.5 + 1.5 * Math.min(1, fill / max));
    }

    // A Wayfarer's Camp: more road today. Priced against the hero's own daily
    // pool, so a slow army (which needs it most) values it most.
    if (t === 'move') {
      const max = heroMaxMovement(hero) || CONFIG.MOVE_BOOST;
      return PRIZE.booster * (0.5 + 1.5 * Math.min(1.5, CONFIG.MOVE_BOOST / max));
    }

    // Weekly yields, priced as the goods they hand over (gold ≈ 1, a unit of a
    // solid resource ≈ 100g, which is the market's own rough footing).
    if (t === 'waterWheel') return Math.max(PRIZE.booster, CONFIG.WATER_WHEEL_GOLD);
    if (t === 'tradeFair') {
      return Math.max(PRIZE.booster,
        CONFIG.TRADE_FAIR_GOLD + CONFIG.TRADE_FAIR_KINDS * CONFIG.TRADE_FAIR_MAX * 100);
    }
    if (t === 'windmill') return Math.max(PRIZE.booster, CONFIG.WINDMILL_MAX * 100);

    return PRIZE.booster;
  }

  guardValueNear(obj, level = obj.id && obj.id.startsWith('U') ? 1 : 0) {
    const state = this.state;
    const { w, h } = state.map;
    const objects = levelObjects(state, level);
    let v = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = obj.x + dx, ny = obj.y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; // no edge wrap
        const t = tileAt(state, nx, ny, level);
        if (!t || !t.objectId) continue;
        const o = objects[t.objectId];
        // POWER, like the hero term below: this sum is one guard figure and a
        // figure cannot be in two currencies. Summing monsters at aiValue while
        // heroes read armyPower left a mine guarded by monsters AND a hero
        // priced in a unit that was neither.
        if (o && o.type === 'monster') v += creaturePower(o.creature, this.physical) * o.count;
      }
    }
    const heroes = state.heroes;
    for (const hid in heroes) {
      const h2 = heroes[hid];
      if (!this.isEnemy(h2.owner)) continue;
      if ((h2.z ?? 0) !== level) continue;
      if (Math.abs(h2.x - obj.x) <= 1 && Math.abs(h2.y - obj.y) <= 1) v += this.enemyHeroValue(h2);
    }
    return v;
  }
}
