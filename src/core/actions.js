/**
 * actions.js — Every game verb, plus the day/week turn engine.
 *
 * All mutations of GameState go through functions in this file (the UI and
 * the AI both call these — nothing else writes state). Verbs return small
 * event objects that the caller (scene or AI driver) uses to show dialogs,
 * start combat, or animate. Keeping verbs headless makes the whole rule set
 * unit-testable (see tests/).
 */

import { CONFIG, RESOURCES, XP_TABLE } from '../config.js';
import { CREATURES, creaturesOfTier } from '../data/creatures.js';
import { armyPower, physicalModel } from './power.js';
import { bankDef, broodOf, BANK_TYPES, BOSS_LAIRS, BOSS_LAIR_TYPES } from '../data/creatureBanks.js';
import { MARKET_RATES } from './market.js';
import { rollPandoraReward, rollPandoraGuard } from '../data/pandora.js';
import { seerHutPayload } from '../data/seerHut.js';
import { dwellingDef } from '../data/dwellings.js';
import { buildingCatalog, GUILD_SPELL_SLOTS } from '../data/buildings.js';
import { SPELLS, spellsOfTier, wisdomRequiredForTier } from '../data/spells.js';
import { SKILLS } from '../data/skills.js';
import {
  parleyOffer, predictedFightLoss, predictedArmyLoss, fightSeed, fleeCheck, chaseCost,
} from './diplomacy.js';
import { ARTIFACTS, EQUIP_SOCKETS, artifactBandCost } from '../data/artifacts.js';
import { HERO_CLASSES, heroesOfFaction } from '../data/heroes.js';
import {
  currentPlayer, playerHeroes, playerTowns, tileAt, objectAt, heroAt,
  canAfford, pay, grant, logMsg, createHero, rollStartingArmy, weekOf, dayOfWeek, sameTeam, nextObjectId,
  levelObjects, getObject, playerHasKey, featureOn, adoptFeature, objectsWhere,
} from './GameState.js';
import { playerUpgrades, upgradeNodeBlockReason } from './upgrades.js';
import {
  roninReinforce, settleRoninBattle, contextDefenderHero, spawnRonins, marchRonins,
  roninStacks, roninHero,
} from './ronins.js';
import { recordHumanBattleMemory, pveSplitParts, tideBias, recordTideOutcome } from './aiMemory.js';
import { tickJobs, scheduleJob, townBuildLock, jobHoldingLock } from './jobs.js';
import { bindingConstraint, bindingKey } from './constraints.js';
import { UPGRADE_NODES } from '../data/upgradeNodes.js';

// Re-exported: the gate itself lives in core/upgrades.js so the constraint
// reader can use it without importing this module back (I13).
export { upgradeNodeBlockReason };
import {
  tickInvasions, invasionTruce, daysToNextWave, activeBands, initInvasions, assaultIsPlayable,
  settleAssault, noteBandBroken, settleWaves,
} from './invasions.js';
import { ageFloorSpec, ageFloorHeld, ageFloorText } from './ages.js';
import {
  heroMaxMovement, heroMaxMana, heroManaRegen, heroSightRadius,
  addToArmy, canAddToArmy, armyIsEmpty, armyValue, levelForXp, artifactBonus,
  heroPowerValue, effectiveForce,
} from './heroUtils.js';
import { createBattle } from './combat/CombatEngine.js';
import { autoResolve } from './combat/CombatAI.js';
import {
  tickPacts, corneredScore, canRecruitFrom, sovereignTeamOf, allRivalsSworn,
  pleaOffers, restoreRealm, allPacts,
} from './pacts.js';
import { tickPatronages } from './patrons.js';
import { tickUprisings } from './uprisings.js';
import { recordEconomy } from '../ai/adventureTelemetry.js';
import {
  tickInvaderPlanner, tickInvaderTempo, reinforceInvaders, wavePowerBase, bestHero,
  daysToNextNation,
} from './invaderPlanner.js';
import { recordDay, recordCombat, recordEvent } from './chronicle.js';
import { skillValue } from '../data/skills.js';
import { spellCost, adventureParam, viewAirSeesBothLevels } from './magic.js';
import { campaignById } from '../data/campaigns.js';
import {
  tideOfWar, wildStacksGrow, pveScalesToArmy, neutralHomeostasis,
  tideTargetLoss, tideWipeTolerance,
} from './pacing.js';
import {
  wildStacks, wildFloor, bandTarget, bandAnchor, isInvaderBand,
} from './neutrals.js';
import {
  isHolding, defenceOf, isDefended, garrisonCreature, garrisonUnitCost,
  captureGarrisonValue, defenceUpkeep, buyoutPrice,
} from './holdings.js';
import { Rng } from './rng.js';
import { revealAround, fogFor, isExplored } from '../map/fog.js';
import { monsterNear, findPath } from '../map/Pathfinding.js';

// ===========================================================================
// TURN / DAY / WEEK ENGINE
// ===========================================================================

/** End the current player's turn. Returns { newDay, newWeek } flags. */
export function endTurn(state) {
  const flags = { newDay: false, newWeek: false };
  // Track town starvation at the end of each player's own turn.
  const p = currentPlayer(state);
  if (playerTowns(state, p.index).length === 0) {
    p.daysWithoutTown++;
    if (p.daysWithoutTown > CONFIG.DAYS_PER_WEEK) defeatPlayer(state, p.index, 'lost all towns');
  } else {
    p.daysWithoutTown = 0;
  }

  // Mutual defeat guard: the turn just ended may have left NO undefeated
  // player (two realms can fall on the same day — e.g. the last starving
  // player expires while the other already had). There is then nobody to hand
  // the turn to; the search loop below would spin forever, ticking advanceDay
  // and the calendar without bound. Settle the outcome and bail.
  if (state.players.every((pl) => pl.defeated)) {
    checkVictory(state);
    return flags;
  }

  // Advance to the next undefeated player; wrap => new day.
  let next = state.currentPlayer;
  do {
    next = (next + 1) % state.players.length;
    if (next === 0) {
      advanceDay(state);
      flags.newDay = true;
      flags.newWeek = dayOfWeek(state.day) === 1;
    }
  } while (state.players[next].defeated && state.winner === null);
  state.currentPlayer = next;
  checkVictory(state);
  return flags;
}

function advanceDay(state) {
  state.day++;
  const newWeek = dayOfWeek(state.day) === 1;
  // Name the week (and its growth modifier) once, before any town grows.
  const event = newWeek ? rollWeekEvent(state) : null;

  for (const player of state.players) {
    if (player.defeated) continue;
    // ---- income ----
    // dailyIncome returns the NET ledger, and defence upkeep can drive its gold
    // negative — that pressure is the point (holding everything must be
    // unaffordable). But grant() has no floor, so applying the net directly let
    // a treasury walk unboundedly negative, at which point canAfford failed for
    // every build, recruit and hire with no recovery move — the one gold debit
    // in the codebase that skipped the Math.max(0, …) convention every other
    // debit follows (crew upkeep two lines down included). Split the bundle:
    // grant the earnings, then debit the shortfall with the same floor. A
    // bankruptcy rule with teeth (garrisons deserting when the bill cannot be
    // paid) was considered and deliberately not built here — it is a real
    // economic design with its own balance work, while an unbounded negative
    // number is simply a bug; the floor keeps the pressure (a broke realm still
    // cannot buy anything) without the permanent hole.
    const income = dailyIncome(state, player);
    const shortfall = income.gold < 0 ? -income.gold : 0;
    if (shortfall) income.gold = 0;
    grant(player, income);
    if (shortfall) player.resources.gold = Math.max(0, player.resources.gold - shortfall);
    // Crews raised above the starting allotment cost gold every day, idle or
    // not — so over-buying is punished. A player who hired none pays none, which
    // is why this cannot move the economy of an existing game.
    const upkeep = crewUpkeep(state, player);
    if (upkeep > 0) player.resources.gold = Math.max(0, player.resources.gold - upkeep);
    // ---- heroes refresh ----
    for (const hero of playerHeroes(state, player.index)) {
      // Weekly bonuses (Stables) expire BEFORE the MP refill, else the dead
      // bonus would leak into the new week's pool.
      if (newWeek) hero.weeklyMoveBonus = 0;
      hero.mp = heroMaxMovement(hero);
      // Daily regen tops up toward max but must never REDUCE the pool: the Magic
      // Spring fills to a multiple of max, and a plain min(max, …) clamp wiped
      // that over-max bonus at the very next dawn (before it bought a single
      // useful day). max(current, …) keeps the surplus; normal regen resumes
      // once the hero spends back down to max.
      hero.mana = Math.max(hero.mana, Math.min(heroMaxMana(hero), hero.mana + heroManaRegen(hero)));
      hero.dimDoorUsed = 0; // Dimension Door casts refresh each day
      // The travel/scouting spells all last exactly one day. Fly / Water Walk
      // may only END a move on land (isEnterable + the stepReserve look-ahead,
      // which refuses a water run that never lands), so at dawn a hero is on
      // solid ground and the flags clear. The one exception is the guard below:
      // a hero somehow standing on open water — a save from before the reserve
      // learned to refuse strandable crossings, or any future path this layer
      // has not thought of — KEEPS its travel spell, because clearing it there
      // converts a bug into a permanently immobilised hero. This bends the
      // "exactly one day" rule only in a state the rules say cannot be reached;
      // the moment the hero regains land the spell lapses at the next dawn.
      hero.disguised = false;
      const tile = tileAt(state, hero.x, hero.y, hero.z ?? 0);
      const marooned = !hero.onBoat && tile?.terrain === 'water';
      if (!marooned) {
        hero.flying = false;
        hero.waterWalk = false;
      }
      if (hero.inTownId) applyTownVisitPerks(state, state.towns[hero.inTownId], hero);
    }
    // ---- towns refresh ----
    for (const town of playerTowns(state, player.index)) {
      town.builtToday = false;
      if (newWeek) applyWeeklyGrowth(town, event);
    }
  }
  // Neutral towns also grow (so late captures aren't empty shells).
  if (newWeek) {
    for (const town of Object.values(state.towns)) {
      if (town.owner === -1) applyWeeklyGrowth(town, event);
    }
    // External creature dwellings accrue their creature each week (both levels),
    // so a dwelling left standing builds a stock worth marching for.
    growDwellings(state, event);
    // A cleared lair keeps breeding: an emptied Creature Bank / boss lair accrues
    // its own apex creature, so a Dragon Utopia is worth a standing road rather
    // than one visit. Feature-gated — no flag, no growth, no change.
    growLairBroods(state, event);
    // …and four weeks on, an emptied vault is reoccupied outright: new tenants,
    // a fresh prize, and a guard sized to the world as it stands now rather than
    // as it stood when the site was first drawn. Feature-gated; no flag, no
    // draw, no change.
    const reoccupied = respawnSites(state);
    if (reoccupied > 0) {
      logMsg(state, reoccupied === 1
        ? 'An emptied vault has new tenants.'
        : `${reoccupied} emptied vaults have new tenants.`);
    }
    // Tide of War (#7): unfought wild stacks swell each week too, so the map
    // stays a live, rising threat rather than a fixed set of walkovers (capped).
    // (#12): and every week breeds a fresh trickle of NEW stacks onto open
    // ground (a bigger surge at each month's dawn) — grow the existing ones
    // first, then seed this week's newcomers, so the world never goes quiet.
    // The stacks already out there swell (bounded at a multiple of their original
    // size). ON by default and independent of the pacing preset — see
    // pacing.wildStacksGrow: bundling it into a preset meant a game already in
    // progress could never adopt it, and a static map is a solved map. Draws no rng,
    // so a seed's every other roll is untouched.
    // With homeostasis on, this rule keeps the GUARDS (which gate content and so
    // must grow slowly and independently) while the wandering bands answer to
    // the crawling peg below.
    const peg = neutralHomeostasis(state);
    if (wildStacksGrow(state)) growMapCreatures(state, event, { guardsOnly: peg });
    // The crawling peg + the population floor: the wandering bands track the
    // leading realm's army at a rate limit, and are refilled when the map has
    // been cleared out (see core/neutrals.js). Draws only from the world stream.
    if (peg) { pegWildStacks(state, event); respawnWildStacks(state); }
    // Breeding BRAND-NEW stacks onto explored ground stays Tide of War's business.
    if (tideOfWar(state)) spawnMapCreatures(state, event);
    // Town Bank (#17): credit deposit interest on the week-ending gold FIRST, then
    // service loans — a depositor's interest can cover that week's installment,
    // which is exactly how the two halves of a bank should meet.
    payBankInterest(state);
    tickDebts(state); // service loans; a missed payment repossesses.
    // Pacts: tribute changes hands, loyalty moves, and an oath that has run out
    // ends. dailyIncome is injected because pacts.js is imported from here.
    // A game with no pacts returns nothing and costs nothing.
    // The husbandry clause, before the tribute settles: a vassal's stewards work
    // the weekly sites of their own lands and the suzerain takes their share.
    for (const ev of tendVassalSites(state)) {
      logMsg(state, ev.text);
      (state.eventToasts ||= []).push(ev.text);
      recordEvent(state, 'diplomacy', { text: ev.text, kind: ev.kind });
    }
    for (const ev of tickPacts(state, { dailyIncome, invasionAfoot: invasionTruce(state) })) {
      logMsg(state, ev.text);
      (state.eventToasts ||= []).push(ev.text);
      recordEvent(state, 'diplomacy', { text: ev.text, kind: ev.kind || null });
    }
    // Patronage: the other half of pacts. Where tickPacts settles the realms that
    // ACCEPTED terms, this settles the ones that were refused — a realm squeezed to
    // nothing and left there finds somebody who would rather fund a war on the
    // squeezer's flank than fight one on their own ground. Silent when nobody is
    // cornered; the one thing it ever announces names nobody.
    for (const ev of tickPatronages(state, { dailyIncome })) {
      logMsg(state, ev.text);
      (state.eventToasts ||= []).push(ev.text);
      recordEvent(state, 'diplomacy', { text: ev.text, kind: ev.kind || null });
    }
    // Uprisings: the third face of the same coin. Pacts settle the realms that took
    // terms, patronage the ones that were refused — and this settles the ones that took
    // terms and were then OUTBID. One, two or three sworn realms throw the banner off in
    // the same hour, each with a foreign war chest and a host already in the field, and a
    // rebel beaten back to nothing begs for one castle rather than dying. Costs a game
    // with no pacts nothing, and draws from its own stream so it moves no other roll.
    for (const ev of tickUprisings(state)) {
      logMsg(state, ev.text);
      (state.eventToasts ||= []).push(ev.text);
      recordEvent(state, 'diplomacy', { text: ev.text, kind: ev.kind || null });
    }
  }

  if (newWeek) logMsg(state, weekEventMessage(event));

  // Living campaign events: authored beats fire at scripted days. A no-op for
  // skirmishes (guarded on state.campaign), so plain games never pay for it.
  applyCampaignEvents(state);

  // In-transit caravans plod a day down the road toward their destination.
  if (state.caravans && state.caravans.length) advanceCaravans(state);

  // Multi-day work: crews are assigned, jobs advance a day, finished ones fire
  // their effect. The effects are INJECTED (core/jobs.js must not import this
  // module back, §2.4) and the whole tick is a no-op with an empty queue, so a
  // game that schedules nothing is untouched and draws no rng.
  for (const ev of tickJobs(state, { complete: JOB_EFFECTS })) {
    if (ev.type === 'jobDone') {
      const town = state.towns[ev.townId];
      logMsg(state, `${town?.name || 'A town'} finished ${ev.target || ev.kind}.`);
      (state.eventToasts ||= []).push(`${town?.name || 'A town'} finished ${ev.target || ev.kind}.`);
    }
  }

  // The binding constraint, ON THE TRANSITION rather than every dawn. The Gantt
  // carries the standing readout; a line repeated each morning stops being read,
  // and the same reasoning already governs `jobStalled`. Human seats only —
  // nobody is teaching the AI the Theory of Constraints.
  for (const player of state.players) {
    if (!player.isHuman || player.defeated) continue;
    const binding = bindingConstraint(state, player.index);
    const key = bindingKey(binding);
    if (key !== (player.lastBinding ?? 'none')) {
      player.lastBinding = key;
      if (binding.kind !== 'none') {
        logMsg(state, binding.text);
        (state.eventToasts ||= []).push(binding.text);
      }
    }
  }

  // How the LAST people went, before the next one is considered: a defence that came
  // through nearly whole has nothing to rebuild, so it does not get a season to do it
  // in (invaderPlanner.tickInvaderTempo). First, so a schedule pulled onto today is
  // still honoured by the landing tick below.
  for (const ev of tickInvaderTempo(state)) {
    logMsg(state, ev.text);
    (state.eventToasts ||= []).push(ev.text);
    recordEvent(state, 'note', { text: ev.text, kind: ev.kind || null });
  }
  // The peoples from outside the world (opt-in `invasions`): land the next nation
  // when one is due — a real realm with a treasury, named commanders and camps on
  // the border, which the ordinary AI then plays. Runs BEFORE the band tick so a
  // nation coming ashore stands the light raids down for the day.
  for (const ev of tickInvaderPlanner(state)) {
    logMsg(state, ev.text);
    (state.eventToasts ||= []).push(ev.text);
    recordEvent(state, 'note', { text: ev.text, kind: ev.kind || null });
  }
  // And every day a people still holds a camp, more of them arrive. Gated on the
  // foothold, so razing the camps is the off switch — the player's lever, and a thing on
  // the map rather than a timer.
  for (const ev of reinforceInvaders(state)) {
    logMsg(state, ev.text);
    (state.eventToasts ||= []).push(ev.text);
    recordEvent(state, 'note', { text: ev.text, kind: ev.kind || null });
  }

  // The lighter tier (opt-in `invasions`): land a war-band wave when one is due
  // and march every band already ashore one step toward its target town.
  // resolveBandAssault is injected so core/invasions.js need not import this
  // module back — and it is deliberately the ONLY town-taking verb handed in. A
  // captureTown dep used to ride along for sackTown's horde-capture branch, which
  // flipped towns the storm check had just refused (no battle, garrison intact,
  // last towns included); that branch is gone, so the dep went with it.
  // Both channels, on purpose. The log alone was not enough: the herald for the
  // biggest event in the game was written to a panel nobody has open, so a wave
  // landed in total silence and read as "invasions are broken". eventToasts is
  // what the view surfaces at dawn (see AdventureScene's new-day handler), which
  // is where an invasion belongs.
  for (const ev of tickInvasions(state, { resolveBandAssault: bandAssaultAtDawn })) {
    logMsg(state, ev.text);
    (state.eventToasts ||= []).push(ev.text);
    recordEvent(state, 'note', { text: ev.text, kind: ev.kind || null });
    // A band broken against a wall counts exactly like one broken in the field
    // (see noteInvasionRepelled) — the town's owner books it. `gone` is the
    // difference between "thrown back" and "finished": only the latter is one
    // fewer invasion in the world.
    if (ev.kind === 'assaultRepulsed' && ev.gone) {
      const town = state.towns[ev.townId];
      if (town && town.owner >= 0) {
        noteInvasionRepelled(state, town.owner, { invader: { peopleName: ev.peopleName, wave: ev.wave } });
      }
    }
  }
  // The freelance corps: a wandering band may stand up a captain, and every captain
  // already standing takes a step toward the nearest fighting. Both are quiet — a
  // ronin rising is one line in the log, and its march is not news — so neither
  // goes to eventToasts, which is reserved for things that change the player's day.
  for (const ev of spawnRonins(state)) {
    recordEvent(state, 'note', { text: `${ev.name} has taken command of a wandering band.`, kind: ev.kind });
  }
  marchRonins(state);
  // A wave can also END with nobody there to end it: its last bands ride home on
  // their own lifespan, or leave having sacked what they came for. Judge those
  // here, once a day, so a wave is never left half-open in the ledger (and so the
  // realm that broke most of it is still credited).
  settleInvasionWaves(state);

  // The day's position, into the chronicle, LAST — after every tick has settled, so the
  // line records the world the player wakes up to rather than a half-advanced one. The
  // gauges are passed in rather than imported, because they live in modules that import
  // this one and a cycle for a diagnostic would be a poor trade; advanceDay already has
  // every one of them in hand.
  // One economy row per living realm per day. The aggregate of these turns
  // "the AI cannot keep up on production" from an impression into a curve.
  recordEconomy(state, dailyIncome);

  recordDay(state, {
    wavePower: featureOn(state, 'invasions') ? wavePowerBase(state) : null,
    bestHeroStat: bestHero(state).statSum,
    bestHeroLevel: bestHero(state).level,
    nextNationIn: daysToNextNation(state),
    nextWaveIn: daysToNextWave(state),
    bands: activeBands(state).length || null,
    cornered: (state.players || [])
      .filter((p) => !p.defeated && !p.invader)
      .map((p) => ({ n: p.name, s: corneredScore(state, p.index) }))
      .filter((c) => c.s > 0.2),
  });
}

/**
 * Living campaign events (see data/campaigns.js `events`): an authored,
 * per-chapter script that fires at scripted days so a campaign feels alive
 * rather than a bare skirmish. Called once per day from advanceDay; a plain
 * skirmish (no state.campaign) is skipped entirely. Deterministic and
 * fire-once — the keys of fired events live on campaign.eventsFired, so they
 * round-trip saves and never double-apply. Fired flavor text is logged and
 * queued on state.eventToasts for the view to surface. Returns the events that
 * fired this day (for tests + callers).
 */
export function applyCampaignEvents(state) {
  const c = state.campaign;
  if (!c) return [];
  const camp = campaignById(c.id);
  const events = camp?.scenarios[c.scenarioIndex]?.events || [];
  if (!events.length) return [];
  c.eventsFired = c.eventsFired || [];
  const fired = [];
  events.forEach((ev, i) => {
    if (ev.day !== state.day) return;
    const key = `${c.scenarioIndex}:${i}`;
    if (c.eventsFired.includes(key)) return;
    c.eventsFired.push(key);
    applyCampaignEvent(state, ev);
    if (ev.text) {
      logMsg(state, ev.text);
      (state.eventToasts = state.eventToasts || []).push(ev.text);
    }
    fired.push(ev);
  });
  return fired;
}

/**
 * Enact one campaign event's mechanical effect; the flavor text is logged by
 * the caller. Kinds:
 *   reinforce — the strongest hero hostile to the human gains a creature stack
 *               (a rising threat, a scripted counterattack, or a sprung ambush)
 *   gift      — the human commander gains resources, a creature stack, and/or an
 *               ARTIFACT (a relic recovered mid-chapter)
 *   blessing  — a morale/luck surge on ALL the human's heroes for their next
 *               battle (the existing fountain-blessing mechanic — spent in one
 *               fight, so a beat placed on the eve of a decisive assault)
 *   message   — narrative only (no mechanical effect)
 */
function applyCampaignEvent(state, ev) {
  const human = state.players.find((p) => p.isHuman);
  if (ev.kind === 'reinforce') {
    const target = strongestEnemyHero(state, human);
    if (target && ev.creature && ev.count) addToArmy(target.army, ev.creature, ev.count);
  } else if (ev.kind === 'gift') {
    if (!human) return;
    if (ev.resources) grant(human, ev.resources);
    const hero = playerHeroes(state, human.index)[0];
    if (hero && ev.creature && ev.count) addToArmy(hero.army, ev.creature, ev.count);
    if (hero && ev.artifact && ARTIFACTS[ev.artifact]) giveArtifact(state, hero, ev.artifact);
  } else if (ev.kind === 'blessing') {
    if (!human) return;
    const cap = CONFIG.MORALE_LUCK_MAX;
    for (const hero of playerHeroes(state, human.index)) {
      if (ev.morale) hero.tempMorale = Math.min(cap, (hero.tempMorale || 0) + ev.morale);
      if (ev.luck) hero.tempLuck = Math.min(cap, (hero.tempLuck || 0) + ev.luck);
    }
  }
}

/** The strongest hero hostile to the human (by army value), or null. */
function strongestEnemyHero(state, human) {
  if (!human) return null;
  let best = null;
  for (const h of Object.values(state.heroes)) {
    if (sameTeam(state, h.owner, human.index)) continue; // allies + the human itself
    const v = armyValue(h.army);
    if (!best || v > best.v) best = { hero: h, v };
  }
  return best ? best.hero : null;
}

/** All daily income for a player: halls, silos, mines, hero perks, artifacts. */
export function dailyIncome(state, player) {
  const income = {};
  const add = (gain) => {
    for (const r of RESOURCES) if (gain[r]) income[r] = (income[r] || 0) + gain[r];
  };
  for (const town of playerTowns(state, player.index)) {
    const catalog = buildingCatalog(town.faction);
    // Only the highest hall in the upgrade line pays out.
    const halls = ['capitol', 'cityHall', 'townHall', 'villageHall'];
    const bestHall = halls.find((b) => town.buildings.includes(b));
    if (bestHall) add(catalog[bestHall].income);
    if (town.buildings.includes('resourceSilo')) {
      add(catalog.resourceSilo.factionIncome[town.faction] || {});
    }
    // A Grail structure can carry a signature daily gold bonus (Castle's
    // prosperous capital). Faction-specific — see CONFIG.FACTION_GRAIL.
    if (town.grail) {
      const grailGold = CONFIG.FACTION_GRAIL[town.faction]?.gold;
      if (grailGold) add({ gold: grailGold });
    }
  }
  // Mines pay wherever they stand — surface or underground.
  for (const objects of [state.map.objects, state.map.underground?.objects]) {
    if (!objects) continue;
    for (const obj of Object.values(objects)) {
      if (obj.type === 'mine' && obj.owner === player.index) {
        add(CONFIG.MINE_INCOME[obj.mineType]);
      }
    }
  }
  for (const hero of playerHeroes(state, player.index)) {
    const estates = skillValue(hero, 'estates');
    if (estates) add({ gold: estates });
    const purse = artifactBonus(hero, 'goldPerDay');
    if (purse) add({ gold: purse });
    // Resource-specialist heroes add a fixed daily trickle of their resource.
    const spec = hero.specialty;
    if (spec && spec.kind === 'resource' && spec.amount) add({ [spec.resource]: spec.amount });
  }
  // Difficulty handicap: the AI's daily take is scaled (harder → the AI earns
  // more). The human is never scaled here; their handicap is the smaller
  // starting pile set at newGame. Unknown/old-save difficulty → the default (×1).
  //
  // Applied BEFORE the defence upkeep is folded in, because the handicap's
  // contract is "the AI EARNS more", and every entry at this point is earnings.
  // When the upkeep debit rode inside the bundle first, the multiplier scaled
  // the NET — so an AI realm running a deficit had that deficit multiplied, and
  // a knob meant to help the AI hurt it more the harder the difficulty
  // (measured: the same holdings netted −20/day at ×1 and −30/day at ×1.5).
  if (!player.isHuman) {
    const diff = CONFIG.DIFFICULTIES[state.difficulty] || CONFIG.DIFFICULTIES[CONFIG.DEFAULT_DIFFICULTY];
    if (diff.aiIncome !== 1) {
      for (const r of RESOURCES) if (income[r]) income[r] = Math.round(income[r] * diff.aiIncome);
    }
  }
  // …and what it costs to KEEP the holdings. Upkeep is the balancing force
  // behind the defence layers: holding everything must be unaffordable, so a
  // realm has to choose what it defends (see core/holdings.js). Charged here so
  // it lands in the same ledger as the income it eats — the returned bundle is
  // the NET, and it may legitimately be negative (tests/territorial-defence
  // pins that). What may NOT go negative is the treasury: advanceDay splits
  // this bundle back into earnings and debit and floors the debit at zero.
  const upkeep = defenceUpkeep(state, player.index);
  if (upkeep > 0) add({ gold: -upkeep });
  return income;
}

// Plain "flavor" weeks get a whimsical name but change nothing in the rules.
const PLAIN_WEEK_NAMES = [
  'Squirrel', 'Rabbit', 'Dove', 'Butterfly', 'Fox', 'Owl', 'Hedgehog',
  'Sparrow', 'Toad', 'Newt', 'Badger', 'Otter', 'Mongoose', 'Ferret',
];

/** Every base (non-upgraded) creature with real weekly growth — the pool a
 *  "Week of the X" names. Excludes war machines and growth-0 neutrals, whose
 *  week would boost 0 population (a mechanically dead "Week of the First Aid
 *  Tent"). */
function baseCreatureIds() {
  return Object.keys(CREATURES).filter((id) => !CREATURES[id].upgraded && CREATURES[id].growth > 0);
}

/**
 * Roll the deterministic event that names the coming week. Most weeks are plain
 * flavor; some are a "Week of the <creature>" (that creature's weekly growth is
 * boosted in every town) or a "Week of the Plague" (all growth reduced). Stored
 * on state so the view can announce it; round-trips through the save spread.
 */
export function rollWeekEvent(state) {
  const week = weekOf(state.day);
  // Months are four weeks; from month 2 on (weeks 5, 9, 13, …) the dawn of a
  // new month can bring a stronger, rarer beat instead of a plain week. Week 1
  // never reaches here (no dawn is rolled on the opening day), so the first
  // monthly event lands at week 5.
  const monthStart = (week - 1) % 4 === 0;
  const plagueChance = monthStart ? CONFIG.MONTH_PLAGUE_CHANCE : CONFIG.WEEK_PLAGUE_CHANCE;
  const creatureChance = monthStart ? CONFIG.MONTH_CREATURE_CHANCE : CONFIG.WEEK_CREATURE_CHANCE;
  const r = state.rng.random();
  let event;
  if (r < plagueChance) {
    event = { kind: 'plague', name: 'Plague' };
  } else if (r < plagueChance + creatureChance) {
    const id = state.rng.pick(baseCreatureIds());
    event = { kind: 'creature', creature: id, name: CREATURES[id].name };
  } else {
    event = { kind: 'plain', name: state.rng.pick(PLAIN_WEEK_NAMES) };
  }
  if (monthStart) event.month = true;
  event.week = week;
  state.weekEvent = event;
  return event;
}

/** One-line announcement for a rolled week event (log + view toast share it). */
export function weekEventMessage(event) {
  if (!event) return '';
  // A monthly beat announces itself as a "Month of the …" and reads as the
  // dawn of a whole new month.
  if (event.month) {
    const mo = `Month ${Math.floor((event.week - 1) / 4) + 1}`;
    if (event.kind === 'creature') {
      return `${mo} dawns — Month of the ${event.name}! A bumper season swells ${event.name} dwellings.`;
    }
    if (event.kind === 'plague') {
      return `${mo} dawns — Month of the Plague. A deep blight cuts creature growth everywhere.`;
    }
    return `${mo} dawns — the Month of the ${event.name} begins.`;
  }
  const wk = `Week ${event.week}`;
  if (event.kind === 'creature') {
    return `${wk} — Week of the ${event.name}! ${event.name} populations surge in every town.`;
  }
  if (event.kind === 'plague') {
    return `${wk} — Week of the Plague. Creature growth is halved everywhere this week.`;
  }
  return `${wk} — Week of the ${event.name}. Creature populations have grown.`;
}

/**
 * Weekly stock added for one creature: the base growth ×fort multiplier, then
 * the week event's modifier (plague halves; a matching "Week of the X" doubles
 * and adds a flat bonus). Shared by applyWeeklyGrowth and the economy tests so
 * both read the same formula.
 */
export function weeklyCreatureGrowth(baseGrowth, fortMult, event, creatureId) {
  let g = Math.floor(baseGrowth * fortMult);
  // A monthly event (event.month) is a stronger variant of the same seam: a
  // Month of the Plague bites deeper, a Month of the <creature> multiplies harder.
  if (event && event.kind === 'plague') {
    return Math.floor(g * (event.month ? CONFIG.MONTH_PLAGUE_MULT : CONFIG.WEEK_PLAGUE_MULT));
  }
  if (event && event.kind === 'creature' && event.creature === creatureId) {
    const mult = event.month ? CONFIG.MONTH_CREATURE_MULT : CONFIG.WEEK_CREATURE_MULT;
    const bonus = event.month ? CONFIG.MONTH_CREATURE_BONUS : CONFIG.WEEK_CREATURE_BONUS;
    return Math.floor(g * mult) + bonus;
  }
  return g;
}

function applyWeeklyGrowth(town, event) {
  const catalog = buildingCatalog(town.faction);
  let mult = 1;
  if (town.buildings.includes('castle')) mult = CONFIG.GROWTH_CASTLE_MULT;
  else if (town.buildings.includes('citadel')) mult = CONFIG.GROWTH_CITADEL_MULT;
  if (town.grail) mult *= grailGrowthMult(town.faction); // the Grail structure's blessing (faction-flavoured)
  for (let tier = 1; tier <= 7; tier++) {
    const hasDwelling = town.buildings.some(
      (b) => catalog[b] && catalog[b].dwellingTier === tier,
    );
    if (!hasDwelling) continue;
    const { base } = creaturesOfTier(town.faction, tier);
    const growth = weeklyCreatureGrowth(CREATURES[base]?.growth || 0, mult, event, base);
    town.available[tier] = (town.available[tier] || 0) + growth;
  }
}

function defeatPlayer(state, playerIndex, reason) {
  const p = state.players[playerIndex];
  if (p.defeated) return;
  p.defeated = true;
  logMsg(state, `${p.name} has been vanquished (${reason}).`);
  // Remove their heroes from the map; a vanquished player keeps no re-hire pool.
  for (const hero of playerHeroes(state, playerIndex)) {
    removeHero(state, hero);
  }
  // A defeatHero champion waiting in this pool falls with its cause (otherwise
  // wiping the pool would make the objective silently uncompletable).
  if (state.victory?.targetHeroId
      && (p.heroPool || []).some((h) => h.id === state.victory.targetHeroId)) {
    state.victory.targetHeroDown = true;
  }
  p.heroPool = [];
  checkVictory(state);
}

/**
 * Book one repelled invasion for `owner`'s team, and say what it was.
 *
 * "Repelled" is deliberately narrow: the war-band is GONE — broken in the field
 * by a hero, or thrown back from a wall and destroyed doing it. A band that
 * sacks a town and rides on has not been repelled by anybody, and a band that
 * withdraws bloodied but intact is counted only once it is actually finished.
 *
 * The heavy tier books through here too: an invader NATION whose foothold is
 * broken (its last town taken — see captureTown) is one repelled invasion for
 * the team that broke it. Passed with a peopleName but no wave, so it takes the
 * one-for-one path below rather than the band-wave ledger, which only ever
 * described the light tier.
 *
 * Kept per team rather than per player because a vassal's army answering the
 * call IS your defence — that is the whole substance of the oath (pacts.js).
 */
export function noteInvasionRepelled(state, owner, obj = null) {
  if (owner == null || owner < 0) return null;
  const team = state.players?.[owner]?.team ?? owner;
  // AN INVASION IS A WAVE. The band is booked against the wave it came in with,
  // and the wave is tallied only once its last band is off the map and most of it
  // was broken (invasions.settleWaves). Counting bands instead ended a game on the
  // first raid of it — the report this pair of functions exists for.
  if (!noteBandBroken(state, team, obj)) {
    // No wave to book it against (a band from before the ledger existed, or a
    // direct call with nothing but an owner): the old behaviour, one for one.
    return bookInvasionRepelled(state, team, obj?.invader?.peopleName);
  }
  logMsg(state, `${obj.invader.peopleName || 'The invaders'} lose a war-band in the field.`);
  // The band is still on the map at this point (the caller removes it next), so it
  // must not count as one of its wave's survivors.
  settleInvasionWaves(state, { excludeBandId: obj.id ?? null });
  return invasionsRepelled(state, team);
}

/** Tally + announce ONE repelled invasion. The single place the counter moves. */
function bookInvasionRepelled(state, team, peopleName) {
  const tally = (state.invasionsRepelled ||= {});
  tally[team] = (tally[team] || 0) + 1;
  logMsg(state, `${peopleName || 'The invaders'} are broken and thrown back. `
    + `(${tally[team]} invasion${tally[team] === 1 ? '' : 's'} repelled.)`);
  (state.eventToasts ||= []).push(
    `⚔ ${peopleName || 'The invaders'} are thrown back — ${tally[team]} invasion${tally[team] === 1 ? '' : 's'} repelled.`,
  );
  return tally[team];
}

/**
 * Judge the waves that are finished and tally the ones a realm threw back.
 *
 * Called from both ends of a wave's life: right after a band is broken (so a win
 * settles the moment the last of them falls, not at the next dawn) and once a day
 * from advanceDay (so a wave whose survivors rode home on their own lifespan is
 * still judged, with nobody there to break them).
 *
 * Returns the caller's team tally if it moved, else null.
 */
function settleInvasionWaves(state, opts = {}) {
  let last = null;
  for (const w of settleWaves(state, opts)) last = bookInvasionRepelled(state, w.team, w.peopleName);
  return last;
}

/** How many invasions this team has repelled. */
export function invasionsRepelled(state, team) {
  return (state.invasionsRepelled || {})[team] || 0;
}

/**
 * Book one BATTLE against the invaders for whichever local team fought it.
 *
 * A different unit from the one above, for a reason the report states in its own
 * arithmetic: "the games finish too early — I fight off three waves, sometimes
 * it's just 3 bands, and the game is over. Ten bands in one big wave = ten
 * battles, two castles by four invader heroes are eight battles."
 *
 * `invasionsRepelled` counts a WAVE, and counts it narrowly on purpose — tallying
 * bands instead once ended a game on the first raid of it (see
 * noteInvasionRepelled). But that makes a ten-fight wave and a three-band raid
 * that rode home score exactly the same, so an age measured in waves cannot be
 * asked to be long. This counts what the player actually spends: turns at the
 * wall.
 *
 * WHAT COUNTS. Any battle with an invader on the other side of it, whichever way
 * round: their war-band met in the field, their commander met anywhere, their
 * beachhead camp stormed, and their commander storming one of yours. Wild stacks,
 * banks, rival realms and vassals are not invaders and never count.
 *
 * Booked per TEAM, like the repel tally and for the same reason: a vassal's army
 * answering the call is your defence.
 */
function invaderOwner(state, owner) {
  const p = owner >= 0 ? state.players?.[owner] : null;
  return !!p && !!p.invader;
}

export function noteInvaderBattle(state, ctx, attacker) {
  if (!state || !ctx) return null;
  const def = ctx.defender || {};
  const defHero = ctx.defenderHeroId ? state.heroes[ctx.defenderHeroId] : null;
  const defTown = def.kind === 'town' ? state.towns?.[def.townId] : null;
  // A war-band is a map object marked by the wave that landed it; everything else
  // is identified by whose realm owns it.
  const bandDefends = def.kind === 'monster' && !!getObject(state, def.objectId)?.invader;
  const theirs = bandDefends
    || (defHero && invaderOwner(state, defHero.owner))
    || (defTown && invaderOwner(state, defTown.owner));
  const oursAttacking = attacker && !invaderOwner(state, attacker.owner) ? attacker.owner : null;
  // …and the mirror: their commander assaulting one of ours. The defender is then
  // the local side, so the credit goes there.
  const oursDefending = attacker && invaderOwner(state, attacker.owner)
    ? (defHero && !invaderOwner(state, defHero.owner) ? defHero.owner
      : (defTown && defTown.owner >= 0 && !invaderOwner(state, defTown.owner) ? defTown.owner : null))
    : null;
  const owner = theirs ? oursAttacking : oursDefending;
  if (owner == null || owner < 0) return null;
  const team = state.players?.[owner]?.team ?? owner;
  const tally = (state.invaderBattles ||= {});
  tally[team] = (tally[team] || 0) + 1;
  return tally[team];
}

/** How many battles this team has fought against the invaders. */
export function invaderBattlesFought(state, team) {
  return (state.invaderBattles || {})[team] || 0;
}

/**
 * The Pax: every surviving rival has sworn to you, so there is nobody left to
 * conquer — and no conquest either, because an oath can be thrown off any week.
 *
 * The map does not end here; it CHANGES. The war between realms is over, so what
 * is left to survive is what comes from outside — and the run ends when you have
 * thrown back a set number of foreign invasions, or when one of them finishes
 * you. Asked for in exactly those words: "the game should stay and end after I
 * successfully defend against a set number of invasions, 3, 5, 15 etc".
 *
 * Fires once. It installs a `repelInvasions` objective (unless the game already
 * carries a special one, which is the player's own stated goal and outranks it)
 * and switches the invasions feature ON if it was off, because otherwise the
 * objective it just set could never be met. Returns true the turn it fires.
 */
export function enterPax(state) {
  if (state.pax) return false;
  const human = state.players.find((p) => p.isHuman && !p.defeated);
  if (!human) return false;
  if (!allRivalsSworn(state, human.index)) return false;

  const v = (state.victory ||= {});
  // THE UNIT THE PAX INSTALLS IS BATTLES, and the wave count is kept only for a
  // game that already chose it. Reported: "the games finish too early — I fight
  // off three waves, sometimes it's just 3 bands, and the game is over." The Pax
  // is the road most players reach this ending by, and a wave count cannot express
  // a long watch (see noteInvaderBattle). `repelInvasions` stays selectable in the
  // custom picker for anyone who wants the short one.
  const target = Math.max(1, (v.battleTarget | 0) || CONFIG.PAX_BATTLE_TARGET);
  state.pax = { day: state.day, target };
  // A player who set their own objective keeps it — the Pax only fills a void.
  const hadObjective = !!v.kind || !!v.grail;
  if (!hadObjective) {
    v.kind = 'invaderBattles';
    v.battleTarget = target;
    // Stamped as the Pax's OWN doing, because that changes what it means. A charge
    // the player chose outlasts a conquest (objectiveOutlastsConquest); this one IS
    // the substitute for a conquest that could not happen, so if the oaths later
    // break and the realms are actually finished, the conquest settles the map the
    // ordinary way rather than being held against an objective nobody asked for.
    v.fromPax = true;
  }
  const needsWaves = v.kind === 'repelInvasions' || v.kind === 'invaderBattles';
  if (needsWaves) {
    adoptFeature(state, 'invasions');
    // Materialise the schedule NOW rather than on the first tick. The horizon is
    // the thing the player is about to plan around ("I was due for the first
    // invasion in 16 days and wish to prepare"), so it has to be readable the
    // moment the objective becomes theirs — not a day later.
    if (!state.invasion) state.invasion = initInvasions(state);
    // Pull a distant first wave onto the Pax's own tempo. A wave already closer
    // than that is LEFT ALONE — a player counting down to one they can see must
    // not have it pushed away, and the peace should never delay the war it is
    // now about.
    const soonest = state.day + CONFIG.PAX_INVASION_PERIOD_DAYS;
    if (state.invasion.nextDay > soonest) state.invasion.nextDay = soonest;
  }
  const sworn = state.players.filter((p) => !p.defeated && p.index !== human.index).length;
  logMsg(state, `The last of the realms has sworn to ${human.name}. The wars between them are over — `
    + 'but the sea does not care whose banner flies.');
  (state.eventToasts ||= []).push(
    `⚖ A Pax settles over the realm — ${sworn} sworn ${sworn === 1 ? 'realm' : 'realms'} at your back. `
    + (needsWaves
      ? `Hold the coast: repel ${target} invasion${target === 1 ? '' : 's'} and the age is yours.`
      : 'Your standing objective still decides the age.'),
  );
  return true;
}

/**
 * Hear the envoys of the conquered: hand each fallen realm a town, take its oath,
 * and put the map back in play.
 *
 * Asked for after a conquest win — "can we allow the other opponents to plead, and
 * I give them one castle and a vassalage each so they can return… I was due for
 * the first invasion in 16 days and wish to prepare and see how the invasion would
 * go". Taking every town ends the WAR. This says it need not end the MAP.
 *
 * The three steps, in order, because each depends on the last:
 *   1. restoreRealm per offer — un-defeats them, hands over the town, musters a
 *      hero, and signs a `liberated` pact (the standing loyalty bonus that makes a
 *      realm you saved the most reliable vassal in the game).
 *   2. UN-SETTLE the game. `winner` is what freezes the world, and checkVictory
 *      returns early while it is set, so nothing downstream can clear it — this
 *      is the one place that may, and only because the board genuinely changed:
 *      there are living sovereign realms on it again.
 *   3. Let checkVictory run afresh. Every survivor is now sworn, so the Pax fires
 *      (enterPax) and the age is decided by the invasions instead.
 *
 * Returns { ok, restored: [...], reason? }. Refuses rather than half-applying: if
 * nobody can be seated, the win stands exactly as it did.
 */
export function acceptPleas(state, liberator, offers = null,
  { invasionTarget = null, battleTarget = null } = {}) {
  const list = offers || pleaOffers(state, liberator);
  if (!list.length) return { ok: false, reason: 'there is nobody left to restore', restored: [] };
  // How long a watch the player wants to stand — "a set number of invasions, 3, 5,
  // 15 etc". Recorded BEFORE the Pax fires, because enterPax reads it as the
  // target it installs. `battleTarget` is the same decision in the unit the Pax
  // now uses by default (see enterPax); both are recorded because a game that
  // already carries a `repelInvasions` objective keeps counting waves.
  if (invasionTarget != null) {
    (state.victory ||= {}).invasionTarget = Math.max(1, invasionTarget | 0);
  }
  if (battleTarget != null) {
    (state.victory ||= {}).battleTarget = Math.max(1, battleTarget | 0);
  }

  const restored = [];
  for (const offer of list) {
    const r = restoreRealm(state, liberator, offer.player, offer.townId, { pact: true });
    if (r.ok) restored.push({ ...offer, hero: r.hero?.name || null });
  }
  if (!restored.length) return { ok: false, reason: 'no town could be handed over', restored: [] };

  // The board changed under a settled result: put the game back in play.
  state.winner = null;
  state.winReason = null;
  // …and under a HELD one too (an age floor was holding the conquest — core/ages.js).
  // The note is re-derived by the checkVictory below; dropping it here is what stops
  // a stale "your crown is waiting" from surviving the very change that unwon it.
  if (state.pendingWin) state.pendingWin = null;
  // The Pax is a fresh judgement on a fresh board — it must be allowed to fire
  // for THIS peace even if an earlier one had already been recorded.
  state.pax = null;

  const names = restored.map((r) => r.name).join(', ');
  logMsg(state, `${state.players[liberator].name} hears the envoys of the conquered. `
    + `${names} rise again, sworn to the banner that beat them.`);
  (state.eventToasts ||= []).push(
    `⚖ You raise ${restored.length} fallen ${restored.length === 1 ? 'realm' : 'realms'} and take their oaths. `
    + 'The war between you is over — hold the coast now.',
  );
  checkVictory(state);
  return { ok: true, restored };
}

/**
 * Stamp a settled result — or HOLD it, when the age floor says the realm is not
 * grown yet. Every win in the game goes through this one door.
 *
 * Only the HUMAN's own victory can wait. A defeat, a draw and a rival's win settle
 * the instant they are true: a guardrail that held those would be a player kept in
 * a game they had already lost, which is the opposite of the thing that was asked
 * for. See core/ages.js for what a floor measures and why it can always be stepped
 * over.
 *
 * Returns the winning team, or null when the win was held.
 */
function awardWin(state, team, reason, msg) {
  const human = state.players.find((p) => p.isHuman);
  const humanTeam = human ? (human.team ?? human.index) : null;
  // One waiver covers every hold: a player who has said "enough" is not asked again
  // by the next condition to come true (see claimVictoryNow).
  if (human && !human.defeated && team === humanTeam && !state.victory?.crownWaived
      && (ageFloorHeld(state, team) || objectiveOutlastsConquest(state, team, reason))) {
    return holdWin(state, team, reason, msg);
  }
  state.winner = team;
  state.winReason = reason;
  // Only ever CLEARED, never created: a game with no floor never grows the field,
  // so its state (and its save) is exactly what it was before floors existed.
  if (state.pendingWin) state.pendingWin = null;
  if (msg) logMsg(state, msg);
  return team;
}

/**
 * Does the standing objective outlast a conquest?
 *
 * Some objectives are decided by the SEA rather than by the neighbours: rule N
 * towns (whose last dozen can only be beachhead camps), and repel N invasions.
 * Wiping out the realms you share a border with answers neither, and settling the
 * map on it would end the game with the objective untouched — the shape of the
 * original complaint one layer up: the war is not the age.
 *
 * So a conquest under one of those is HELD, exactly like a win under an age floor:
 * recorded, announced, awarded the day the objective is met, and claimable at any
 * time. Both force the `invasions` feature on at setup, so the thing that decides
 * the age is always actually running.
 */
function objectiveOutlastsConquest(state, team, reason) {
  if (reason !== 'conquest') return false;
  const v = state.victory || {};
  if (v.kind === 'holdTowns') return teamTownCount(state, team) < (v.townTarget || 0);
  if (v.kind === 'repelInvasions' && !v.fromPax) {
    const target = Math.max(1, (v.invasionTarget | 0) || CONFIG.PAX_INVASION_TARGET);
    return invasionsRepelled(state, team) < target;
  }
  if (v.kind === 'invaderBattles' && !v.fromPax) {
    const target = Math.max(1, (v.battleTarget | 0) || CONFIG.PAX_BATTLE_TARGET);
    return invaderBattlesFought(state, team) < target;
  }
  return false;
}

/**
 * Why a crown is waiting, in one line — the age floor's own summary, or the charge
 * the sea has still to decide. Shared by the log, the toast and the dialog, so all
 * three say the same thing.
 */
export function heldWinReason(state, team) {
  return ageFloorText(state, team) || `your charge stands — ${victoryObjectiveText(state)}`;
}

/**
 * Record a win the age is not ready for.
 *
 * `state.pendingWin` is a NOTE, never a promise: checkVictory re-derives every
 * condition on each pass, so a held win that stops being true (the conquered are
 * restored, the target town is lost again) simply stops being pending. The `stale`
 * flag is how that re-derivation works — checkVictory marks the note stale on the
 * way in and drops it on the way out unless something held a win again.
 *
 * Announced once per note, not once per turn: the log line and the toast fire when
 * the note is created or its reason changes, and the objective panel carries the
 * standing state after that.
 */
function holdWin(state, team, reason, msg) {
  const prev = state.pendingWin;
  // ONE note at a time, and it is the standing one: two conditions can be true at
  // once (a treasury objective met on the day the last rival falls), and a note
  // per condition would announce a crown every turn as they took turns holding it.
  // The live condition is written into the note so the dialog quotes something
  // that is still true; the announcement belongs to the note, not the condition.
  if (prev) {
    delete prev.stale;
    prev.team = team;
    prev.reason = reason;
    prev.msg = msg || null;
    return null;
  }
  state.pendingWin = { team, reason, msg: msg || null, since: state.day };
  const spec = ageFloorSpec(state);
  const seaDecided = state.victory?.kind === 'holdTowns' || state.victory?.kind === 'repelInvasions';
  // A held win with nothing left alive on the map is a held win with nothing to
  // do, so a floor that counts waves brings the waves on — the same move the Pax
  // makes for the same reason (see enterPax), and the "full fledge invasions" the
  // guardrail was asked for in the first place. An objective the sea decides needs
  // it even more: the towns it counts arrive as beachheads.
  if (seaDecided || (spec && spec.waves > 0)) {
    adoptFeature(state, 'invasions');
    if (!state.invasion) state.invasion = initInvasions(state);
  }
  const because = heldWinReason(state, team);
  logMsg(state, `${msg ? `${msg} ` : ''}The age is not finished with you — ${because}`);
  (state.eventToasts ||= []).push(`⏳ ${msg || 'The realm is won'} — but the crown waits. ${because}`);
  return null;
}

/**
 * Take the crown now, floor or no floor — the guardrail's own way out.
 *
 * Waiving is written into `state.victory` rather than being a one-off award, so a
 * player who says "enough" is not asked again by the next condition to come true.
 */
export function claimVictoryNow(state) {
  const held = state?.pendingWin;
  if (!held) return { ok: false, reason: 'no crown is waiting' };
  (state.victory ||= {}).crownWaived = true;
  const team = awardWin(state, held.team, held.reason, held.msg);
  return { ok: team !== null, team };
}

export function checkVictory(state) {
  if (state.winner !== null) return state.winner;
  // The held win (if any) is re-derived from live conditions on every pass, so
  // mark it stale now and drop it below unless something holds a win again.
  if (state.pendingWin) state.pendingWin.stale = true;
  // Peace by oath, checked before anything settles: it can only make the game
  // LONGER (it installs an objective), never end it.
  enterPax(state);
  // Special victory (opt-in per game): raising the Grail structure wins the
  // realm outright — a "race for the Grail". Checked BEFORE elimination, since
  // it can settle a game while every player is still alive. The instant a
  // Grail is enshrined (deliverGrail calls through here) its owner's team wins.
  if (state.victory?.grail && state.grailTownId) {
    const town = state.towns[state.grailTownId];
    if (town && town.owner >= 0 && !state.players[town.owner]?.defeated) {
      const owner = state.players[town.owner];
      const team = awardWin(state, owner.team ?? town.owner, 'grail',
        `${owner.name} has raised the Holy Grail — the realm is united under its light!`);
      if (team !== null) return team;
    }
  }
  // Other non-elimination objectives (opt-in), also settled before elimination.
  const won = checkObjective(state);
  if (won !== null) return won;
  // Immediate defeat: no towns AND no heroes.
  for (const p of state.players) {
    if (!p.defeated &&
        playerTowns(state, p.index).length === 0 &&
        playerHeroes(state, p.index).length === 0) {
      defeatPlayer(state, p.index, 'no towns or heroes remain');
    }
  }
  // defeatPlayer recursed into checkVictory; if that inner call already settled
  // the game, don't assign (and log the victory banner) a second time.
  if (state.winner !== null) return state.winner;
  const alive = state.players.filter((p) => !p.defeated);
  // SOVEREIGN teams, not fighting teams. A vassal is a whole realm that swore an
  // oath — it keeps its towns, its mines and its armies, its loyalty still moves
  // week by week, and either side can end the contract. Counting it as part of
  // its suzerain's team ended the game the instant the last rival signed, which
  // is not a conquest at all; the Pax below is what actually happens instead.
  const teams = new Set(alive.map((p) => sovereignTeamOf(state, p.index)));
  if (alive.length && teams.size === 1) {
    // One team (allies) is all that remains — they win. winner is the TEAM id;
    // by convention the human is team 0, so `winner === 0` reads as a human win.
    const names = alive.map((p) => p.name).join(' & ');
    awardWin(state, alive[0].team ?? [...teams][0], 'conquest', `${names} rule the realm!`);
  } else if (alive.length === 0) {
    // Mutual annihilation — no realm survives. End the game as a draw (winner
    // -1, a non-null "no victor" sentinel) so the turn engine stops instead of
    // hunting for a next player that does not exist. Consumers test
    // `winner !== null` for game-over and `winner === 0` for a human win, so a
    // draw reads correctly as "over, human did not win".
    awardWin(state, -1, 'draw', 'The realm lies in ruin — no victor remains.');
  }
  // Nothing held a win this pass ⇒ the note was about a condition that is no
  // longer true. Drop it, so the panel and the dialog stop offering a crown the
  // board no longer owes anybody.
  if (state.pendingWin?.stale) state.pendingWin = null;
  return state.winner;
}

/**
 * Settle a non-elimination objective — a special win path that belongs to the
 * PLAYER (matching HoMM3's per-map victory conditions): the human's team wins
 * by meeting it, while the AI still wins only by elimination. Returns the
 * winning team (and stamps winner/winReason) or null if unmet. Shares
 * checkVictory's "special conditions settle before elimination" ordering.
 */
function checkObjective(state) {
  const v = state.victory || {};
  const human = state.players.find((p) => p.isHuman && !p.defeated);
  if (!human) return null; // human fallen ⇒ standard elimination settles the loss
  const team = human.team ?? human.index;
  // SOVEREIGN team, not fighting team, for everything an objective counts as a
  // POSSESSION — the same rule teamTownCount and checkVictory's conquest test
  // already apply. A vassal's team field is rewritten to its suzerain's the day
  // the pact is signed (pacts.signPact), so reading the raw field here let one
  // signature win accumulateGold, flagMines and captureTown outright, with no
  // coin, mine or town changing hands — a diplomacy achievement wearing the
  // objective's clothes, and one an oath-break the very next week would unwin.
  // repelInvasions is the deliberate exception (per fighting team, below): that
  // one is a CONTRIBUTION counter, and a vassal's army answering the call is
  // exactly what the oath promises (tests/pax-and-endgame.test.js pins it).
  const onTeam = (t) => sovereignTeamOf(state, t) === team;
  // Through awardWin, like every other win: an objective met before the age floor
  // is grown is HELD rather than settled (core/ages.js), and awardWin returns null
  // when it holds one — which reads here exactly like an objective not yet met.
  const award = (reason, msg) => awardWin(state, team, reason, msg);

  if (v.kind === 'captureTown' && v.targetTownId) {
    const town = state.towns[v.targetTownId];
    if (town && town.owner >= 0 && onTeam(town.owner)) {
      return award('captureTown', `${town.name} is taken — the objective is yours!`);
    }
  } else if (v.kind === 'accumulateGold' && v.goldTarget > 0) {
    // onTeam (sovereign), not the raw team field: a vassal's treasury is its
    // own — the tribute share it actually sends is already in YOUR coffers.
    const gold = state.players
      .filter((p) => !p.defeated && onTeam(p.index))
      .reduce((n, p) => n + (p.resources?.gold || 0), 0);
    if (gold >= v.goldTarget) {
      return award('gold', `A treasury of ${v.goldTarget.toLocaleString()} gold is amassed — victory!`);
    }
  } else if (v.kind === 'surviveN' && v.surviveDays > 0) {
    if (state.day >= v.surviveDays) {
      return award('survive', `Day ${v.surviveDays} dawns and your banner still flies — you have endured!`);
    }
  } else if (v.kind === 'acquireArtifact' && v.targetArtifact) {
    if (teamHoldsArtifact(state, team, v.targetArtifact)) {
      return award('acquireArtifact', `The ${ARTIFACTS[v.targetArtifact]?.name || 'fabled artifact'} is yours — the objective is complete!`);
    }
  } else if (v.kind === 'defeatHero' && v.targetHeroId) {
    // The champion falls only when genuinely DEFEATED — a battle loss, capture
    // with a town, or its owner's elimination (stamped by heroLeavesWorld /
    // defeatPlayer). A retreat or surrender into the re-hire pool is an escape,
    // not a defeat, so merely being absent from state.heroes no longer counts.
    if (v.targetHeroDown) {
      return award('defeatHero', 'Your quarry has fallen — the objective is complete!');
    }
  } else if (v.kind === 'repelInvasions') {
    // The Pax endgame (see enterPax), and a victory condition in its own right:
    // hold the coast N times. Losing is unchanged — the invaders finishing you
    // is ordinary elimination, which settles below.
    const target = Math.max(1, (v.invasionTarget | 0) || CONFIG.PAX_INVASION_TARGET);
    const done = invasionsRepelled(state, team);
    if (done >= target) {
      return award('repelInvasions',
        `${done} invasion${done === 1 ? '' : 's'} thrown back into the sea — the age is yours!`);
    }
  } else if (v.kind === 'invaderBattles') {
    // The long watch: hold the coast for a set number of BATTLES rather than for a
    // set number of waves. See noteInvaderBattle for why the unit is the one the
    // player asked for — a wave that arrives as three bands and a wave that takes
    // ten fights are the same number under `repelInvasions`, and an age measured
    // that way cannot be asked to be long.
    const target = Math.max(1, (v.battleTarget | 0) || CONFIG.PAX_BATTLE_TARGET);
    const done = invaderBattlesFought(state, team);
    if (done >= target) {
      return award('invaderBattles',
        `${done} battles fought against the peoples of the sea — the long watch is ended, `
        + 'and the age is yours!');
    }
  } else if (v.kind === 'holdTowns' && v.townTarget > 0) {
    // Rule the realm: hold `townTarget` towns at once. The target is the map's own
    // towns plus a share that only an invasion can supply (its beachhead camps —
    // see GameState.holdTownsTarget), so this is a condition about outlasting the
    // peoples, not about beating the neighbours.
    const held = teamTownCount(state, team);
    if (held >= v.townTarget) {
      return award('holdTowns', `${held} towns fly your banner — the realm is ruled!`);
    }
  } else if (v.kind === 'flagMines') {
    // Economic domination: the team must control EVERY qualifying mine on the
    // map (both levels), and there must be at least one to hold. A single mine
    // in enemy or neutral hands keeps the objective open.
    const mines = allMines(state, v.mineType);
    if (mines.length && mines.every((m) => m.owner >= 0 && onTeam(m.owner))) {
      const what = v.mineType ? mineName(v.mineType) + 's' : 'the realm\'s mines';
      return award('mines', `Every one of ${what} flies your banner — the realm's wealth is yours!`);
    }
  }
  return null;
}

/**
 * How many towns a team RULES — its own, and its allies', but never a vassal's.
 *
 * The same rule checkVictory settles conquest by (sovereignTeamOf): an oath is not
 * a conquest, so a sworn realm's eight towns are its own and do not count toward
 * your forty-two. Otherwise "rule the realm" would be met by signing three pacts,
 * which is a diplomacy achievement wearing a conquest's clothes.
 */
export function teamTownCount(state, team) {
  let n = 0;
  for (const town of Object.values(state?.towns || {})) {
    if (town.owner < 0) continue;
    if (sovereignTeamOf(state, town.owner) === team) n++;
  }
  return n;
}

/** Every mine on the map (both levels), optionally filtered to one mineType. */
function allMines(state, mineType) {
  const out = [];
  for (const objects of [state.map.objects, state.map.underground?.objects]) {
    if (!objects) continue;
    for (const obj of Object.values(objects)) {
      if (obj.type === 'mine' && (!mineType || obj.mineType === mineType)) out.push(obj);
    }
  }
  return out;
}

/** Does any hero on `team` carry `artId` (equipped or in the backpack)?
 *  SOVEREIGN team, like every possession objective (see checkObjective's onTeam):
 *  an artifact in a vassal's saddlebag is theirs, and rides away with them the
 *  week the oath breaks. */
function teamHoldsArtifact(state, team, artId) {
  for (const h of Object.values(state.heroes)) {
    if (sovereignTeamOf(state, h.owner) !== team) continue;
    if (Object.values(h.equipment || {}).includes(artId)) return true;
    if ((h.backpack || []).includes(artId)) return true;
  }
  return false;
}

/** Describe a victory DESCRIPTOR (no live state) — for the custom-game preview
 *  and campaign intro, where the target town isn't generated yet. */
export function victoryObjectiveLabel(v = {}) {
  if (v.kind === 'captureTown') return 'Capture the target town';
  if (v.kind === 'surviveN') return `Survive to day ${v.surviveDays || 100}`;
  if (v.kind === 'accumulateGold') return `Amass ${(v.goldTarget || 0).toLocaleString()} gold`;
  if (v.kind === 'acquireArtifact') return 'Acquire the target artifact';
  if (v.kind === 'defeatHero') return 'Defeat the enemy champion';
  if (v.kind === 'repelInvasions') {
    const n = Math.max(1, (v.invasionTarget | 0) || CONFIG.PAX_INVASION_TARGET);
    return `Repel ${n} foreign invasion${n === 1 ? '' : 's'}`;
  }
  if (v.kind === 'invaderBattles') {
    const n = Math.max(1, (v.battleTarget | 0) || CONFIG.PAX_BATTLE_TARGET);
    return `Fight ${n} battle${n === 1 ? '' : 's'} against the invaders`;
  }
  if (v.kind === 'holdTowns') return `Rule ${v.townTarget || '?'} towns`;
  if (v.kind === 'flagMines') return v.mineType ? `Control every ${mineName(v.mineType)}` : 'Control every mine';
  if (v.grail) return 'Race for the Holy Grail';
  return 'Defeat all enemies';
}

/** One-line objective for a LIVE game (game-over, in-game reminder): names the
 *  concrete target town when there is one, else falls back to the descriptor. */
export function victoryObjectiveText(state) {
  const v = state?.victory || {};
  if (v.kind === 'captureTown' && v.targetTownId) {
    const t = state.towns[v.targetTownId];
    return `Capture ${t?.name || 'the target town'}`;
  }
  if (v.kind === 'acquireArtifact' && v.targetArtifact) {
    return `Acquire the ${ARTIFACTS[v.targetArtifact]?.name || 'target artifact'}`;
  }
  if (v.kind === 'defeatHero' && v.targetHeroId) {
    const h = state.heroes[v.targetHeroId];
    return `Defeat ${h?.name || 'the enemy champion'}`;
  }
  if (v.kind === 'repelInvasions') {
    // A count-up objective is only legible with the count in it.
    const n = Math.max(1, (v.invasionTarget | 0) || CONFIG.PAX_INVASION_TARGET);
    const human = state?.players?.find((p) => p.isHuman);
    const done = invasionsRepelled(state, human?.team ?? 0);
    return `Repel ${n} foreign invasion${n === 1 ? '' : 's'} (${Math.min(done, n)}/${n})`;
  }
  if (v.kind === 'invaderBattles') {
    const n = Math.max(1, (v.battleTarget | 0) || CONFIG.PAX_BATTLE_TARGET);
    const human = state?.players?.find((p) => p.isHuman);
    const done = invaderBattlesFought(state, human?.team ?? 0);
    return `Fight ${n} battles against the invaders (${Math.min(done, n)}/${n})`;
  }
  if (v.kind === 'holdTowns' && v.townTarget > 0) {
    const human = state?.players?.find((p) => p.isHuman);
    const held = teamTownCount(state, human?.team ?? 0);
    return `Rule ${v.townTarget} towns (${Math.min(held, v.townTarget)}/${v.townTarget})`;
  }
  return victoryObjectiveLabel(v);
}

/** One-line "how you lose" for the scenario-info panel. Loss is generic (be
 *  eliminated — no towns left to hold, no heroes left to rally) unless a
 *  surviveN deadline sharpens it. */
export function lossConditionText(state) {
  const v = state?.victory || {};
  if (v.kind === 'surviveN') return `Fall before day ${v.surviveDays || 100} — lose your last town and hero`;
  if (v.kind === 'repelInvasions') return 'Let the invaders finish you — lose your last town and hero';
  if (v.kind === 'holdTowns') return 'Let the peoples take what you have built — lose your last town and hero';
  return 'Lose your last town and hero';
}

function removeHero(state, hero) {
  if (hero.inTownId && state.towns[hero.inTownId]) {
    state.towns[hero.inTownId].visitingHeroId = null;
  }
  heroLeavesWorld(state, hero, { defeated: true });
  delete state.heroes[hero.id];
}

/**
 * Shared bookkeeping for a hero leaving the map (retired to the pool or removed
 * outright), so world-level invariants survive every exit path:
 * - The Grail never leaves the world. A victor takes it via lootHero BEFORE the
 *   loser retires; if nobody took it, it returns to the earth at its resting
 *   place (grailDug resets, the tile in map.grail is re-diggable) so a Grail
 *   race stays winnable.
 * - A `defeatHero` objective completes only on a genuine DEFEAT (battle loss,
 *   captured with a town, owner vanquished) — never on a retreat/surrender into
 *   the re-hire pool. The defeat is stamped here; checkObjective reads the flag.
 */
function heroLeavesWorld(state, hero, { defeated = false } = {}) {
  if (hero.carryingGrail) {
    hero.carryingGrail = false;
    if (state.map?.grail) {
      state.grailDug = false;
      logMsg(state, `The Holy Grail is lost with ${hero.name} — it lies buried once more.`);
    }
  }
  if (defeated && state.victory?.targetHeroId === hero.id) {
    state.victory.targetHeroDown = true;
  }
}

/**
 * Retire a hero into its OWNER's re-hire pool (#11/#12): removed from the map,
 * but its experience, level, stats, skills and spells are preserved for
 * re-hiring at any of that player's taverns. The caller has already set the
 * `defeated` marks a battle LOSS — the hero's army is destroyed and its
 * artifacts are gone (the victor already took them, see lootHero). A fled /
 * surrendered hero (defeated:false) keeps whatever army the caller left on it
 * (its survivors on surrender, none on retreat) and its artifacts. A pooled hero
 * is no longer in state.heroes, so it counts toward neither the map nor the
 * victory check (a townless player with only pooled heroes is still defeated —
 * they cannot re-hire without a tavern).
 */
function retireHero(state, hero, { defeated = false } = {}) {
  if (hero.inTownId && state.towns[hero.inTownId]) {
    state.towns[hero.inTownId].visitingHeroId = null;
  }
  if (defeated) {
    hero.equipment = {}; hero.backpack = [];
    hero.army = [null, null, null, null, null, null, null]; // wiped out in battle
  }
  heroLeavesWorld(state, hero, { defeated });
  // Shed all map / transient state; XP, level, stats, skills, spells, army stay.
  hero.x = undefined; hero.y = undefined; hero.z = 0;
  hero.inTownId = null; hero.onBoat = false;
  hero.mp = 0; hero.tempMorale = 0; hero.tempLuck = 0; hero.weeklyMoveBonus = 0;
  const p = state.players[hero.owner];
  if (p) (p.heroPool || (p.heroPool = [])).push(hero);
  delete state.heroes[hero.id];
}

// ===========================================================================
// HERO MOVEMENT & MAP INTERACTION
// ===========================================================================

/**
 * How much movement the hero must have IN HAND to legally BEGIN `path[i]`.
 *
 * Normally that is just the step's own cost. But a Water Walk / Fly hero may
 * never END a move on open water (see isEnterable) — the spells let you cross a
 * span of water, not camp on it. So a step ONTO water demands enough MP to
 * stride the whole contiguous water run and land on the far shore in the SAME
 * move; if that shore is out of reach this turn the executor stops the hero on
 * land at the water's edge (it never enters the water), and the crossing waits
 * until the hero's movement range can clear the span (boots, etc.).
 *
 * For every other hero — plain foot, or aboard a boat — each path tile is
 * already a legal stop, so this returns exactly `path[i].cost` and movement is
 * byte-identical to before.
 */
export function stepReserve(state, hero, path, i) {
  const step = path[i];
  const strider = (hero.waterWalk || hero.flying) && !hero.onBoat;
  const lvl = hero.z ?? 0;
  if (!strider || tileAt(state, step.x, step.y, lvl)?.terrain !== 'water') return step.cost;
  // Stepping onto water: reserve MP through to the first tile of the run the
  // hero can genuinely OCCUPY — land, or a waiting boat (embarking is a legal
  // water stop; a boat can only ever be the run's last tile, since isWalkable
  // refuses boats as through-traffic).
  //
  // The run is NOT guaranteed to end in a landing, which is what this function
  // used to assume: isEnterable also accepts a water tile HOLDING A HERO as a
  // destination (the naval-v2 strike), and a fight never enters the target's
  // tile — the attacker stops one short. For a whole-water approach "one short"
  // is open water, and advanceDay clears the travel spells at dawn on the
  // strength of the promise that a hero never stands there: reproduced, a
  // Water Walk hero attacking a mid-channel boat finished the day on open
  // water, and after dawn could not move at all. So a water run that reaches
  // the path's end without a landing is refused outright (Infinity — the
  // executor halts the hero on land at the water's edge, exactly as when MP
  // runs short). The adjacent strike is untouched: when the water target is
  // the very step being priced (k === i), the hero is still standing on its
  // own legal tile and fights from there. Dropping isEnterable's hero-on-water
  // allowance for striders instead was rejected — it would also refuse the
  // legitimate strike on a ship moored one tile off the shore the hero stands
  // on, a capability plain foot heroes keep.
  let cost = 0;
  for (let k = i; k < path.length; k++) {
    cost += path[k].cost;
    const tile = tileAt(state, path[k].x, path[k].y, lvl);
    if (tile?.terrain !== 'water') return cost; // landfall — a genuine stop
    const obj = objectAt(state, path[k].x, path[k].y, lvl);
    if (obj?.type === 'boat') return cost;      // boarding — also a genuine stop
    if (k === i && k === path.length - 1) return cost; // adjacent water target — fight from here
  }
  return Infinity; // the run never lands: entering it would strand the hero
}

/**
 * The one place a step decides "does this trigger a fight?", shared by BOTH the
 * foot and boat branches of stepHero — the near-duplicate trigger logic whose
 * drift let a boat sidestep a land engagement (the waterline bypass, fix 1.1).
 * Given the target tile's occupants it returns, MP already deducted and the hero
 * left standing:
 *   - a { type:'combat', context } for a DEFENDED enemy town (siege), an enemy
 *     hero, or a monster;
 *   - a { type:'blocked' } when an escort-less hero can't take that fight, or an
 *     own/allied hero occupies the tile;
 *   - null when nothing here demands battle — the caller proceeds (move, capture
 *     an undefended town, embark, disembark…).
 * A town returns EARLY either way (siege or null), matching both branches'
 * "towns first" order; the non-siege town, bank, Pandora and border-guard cases
 * stay per-branch because they diverge at the waterline (stormed from land only).
 */
function tryEngage(state, hero, obj, otherHero, cost) {
  const canFight = !armyIsEmpty(hero.army);
  const isEnemy = (owner) => owner !== hero.owner && !sameTeam(state, owner, hero.owner);
  if (obj && obj.type === 'town') {
    const town = state.towns[obj.townId];
    if (isEnemy(town.owner) && townHasDefenders(state, town)) {
      if (!canFight) return { type: 'blocked' };
      hero.mp -= cost;
      return { type: 'combat', context: combatContext(state, hero, { kind: 'town', townId: town.id }) };
    }
    return null; // undefended enemy / own / allied — the caller captures or enters
  }
  if (otherHero) {
    if (!isEnemy(otherHero.owner)) return { type: 'blocked' }; // own/ally holds the tile
    if (!canFight) return { type: 'blocked' };
    hero.mp -= cost;
    return { type: 'combat', context: combatContext(state, hero, { kind: 'hero', heroId: otherHero.id }) };
  }
  if (obj && obj.type === 'monster') {
    if (!canFight) return { type: 'blocked' };
    hero.mp -= cost;
    return { type: 'combat', context: combatContext(state, hero, { kind: 'monster', objectId: obj.id }) };
  }
  // Territorial defence: a garrisoned mine or dwelling is not walked onto, it is
  // taken. This belongs here, with the other things that must be fought for,
  // rather than in interactWithObject — by the time THAT runs the hero has
  // already spent the step and is standing on the tile.
  if (obj && isHolding(obj) && isDefended(obj) && isEnemy(obj.owner)) {
    if (!canFight) return { type: 'blocked' };
    hero.mp -= cost;
    return { type: 'combat', context: combatContext(state, hero, { kind: 'holding', objectId: obj.id }) };
  }
  return null;
}

/**
 * Execute ONE step of a path. Returns an event describing what happened:
 *   { type: 'blocked' | 'noMp' }                      — nothing happened
 *   { type: 'moved' }                                 — plain step taken
 *   { type: 'pickup', ... } etc.                      — moved + interaction
 *   { type: 'combat', context }                       — battle must be fought
 *   { type: 'chest', objectId }                       — caller shows a choice dialog
 *   { type: 'enterTown', townId }                     — caller may open town UI
 *   { type: 'whirlpool', from, to, lost }             — boat hero swept to a random
 *                                                       other whirlpool (see useWhirlpool)
 *   { type: 'levelUp', heroId }  (attached via events array on pickups that grant XP)
 */
export function stepHero(state, hero, step) {
  if (hero.mp < step.cost) return { type: 'noMp' };
  // An escort-less hero cannot pick fights (they would lose instantly).
  const canFight = !armyIsEmpty(hero.army);

  // Everything a step touches lives on the hero's OWN map level; crossing
  // levels happens only through the subterranean-gate interaction below.
  const lvl = hero.z ?? 0;
  const obj = objectAt(state, step.x, step.y, lvl);
  const otherHero = heroAt(state, step.x, step.y, lvl);
  const targetTile = tileAt(state, step.x, step.y, lvl);
  const targetIsWater = targetTile?.terrain === 'water';

  // ---- boats: naval combat / embark / sail / disembark -------------------
  if (hero.onBoat) {
    // NAVAL COMBAT (v1): a boat hero may END a move on an adjacent enemy —
    // an enemy boat hero (fleet clash on water), an enemy hero or town on the
    // shore (coastal raid / siege), or a land monster. Exactly like the foot
    // combat triggers below, the attacker NEVER enters the target tile: MP is
    // deducted, the combat context returned, and the hero fights from the
    // deck — still onBoat on its own water tile, win or lose (no disembark-on-
    // victory; applyCombatResult never moves the attacker). The reverse — a
    // LAND hero attacking a boat hero from the shore — is handled in the foot
    // branch below (naval v2); a defeated boat hero leaves a derelict boat.

    // Combat triggers first (towns/heroes/monsters), shared with the foot path so
    // a boat can never sidestep a land engagement — a defended town, an enemy
    // hero, or a monster is fought from the deck (still onBoat, hero stays put).
    const engaged = tryEngage(state, hero, obj, otherHero, step.cost);
    if (engaged) return engaged;
    // A non-siege enemy town is captured from the water exactly as on foot — any
    // armyless enemy visitor surrenders the keys — except the raider cannot ENTER
    // the town square (they stay aboard): MP is spent, the flag flips, the hero
    // does not move. The captured visitor is looted and retires DEFEATED to its
    // owner's pool — captured with the town, not erased from the world.
    if (obj && obj.type === 'town') {
      const town = state.towns[obj.townId];
      if (town.owner !== hero.owner && !sameTeam(state, town.owner, hero.owner)) {
        if (town.visitingHeroId && state.heroes[town.visitingHeroId]) {
          const captive = state.heroes[town.visitingHeroId];
          lootHero(state, hero, captive);
          retireHero(state, captive, { defeated: true });
        }
        hero.mp -= step.cost;
        captureTown(state, town, hero.owner);
        checkVictory(state);
        return { type: 'navalCapture', townId: town.id, captured: true, naval: true };
      }
      return { type: 'blocked' }; // own or allied town — no docking on the town square
    }
    if (targetIsWater) {
      // A whirlpool is water with an object on it: ENDING a move there is the
      // swirl (see useWhirlpool). It never blocks the combat/embark checks
      // above — they run first — and sailing THROUGH one is impossible only
      // because pathfinding refuses to route through it (isWalkable), exactly
      // like portals; a deliberate step onto it is always allowed.
      if (obj && obj.type === 'whirlpool') {
        enterTile(state, hero, step);
        return useWhirlpool(state, hero, obj);
      }
      if (obj) return { type: 'blocked' }; // another boat sits here
      enterTile(state, hero, step);
      return { type: 'moved' };
    }
    // Stepping onto clear land = disembark. Portals, subterranean gates and
    // guarded shores are off-limits (land on clear ground first, then
    // teleport/fight on foot). A pickup on the landing tile — e.g. an island
    // reward — is fine and is collected as you step ashore.
    if (targetTile?.obstacle) return { type: 'blocked' };
    if (obj && (obj.type === 'portal' || obj.type === 'subGate' || obj.type === 'monolith')) return { type: 'blocked' };
    // The locked-door and storm-the-guards rules hold at the waterline too:
    // a keyless Border Guard halts the landing (same contract as the foot
    // branch below), and an un-looted bank / guarded Pandora must be stormed
    // from land — never sidestepped by stepping ashore on top of it.
    if (obj && obj.type === 'borderGuard' && !playerHasKey(state, hero.owner, obj.color)) {
      return { type: 'borderGuard', color: obj.color };
    }
    if (obj && obj.type === 'creatureBank' && !obj.looted) return { type: 'blocked' };
    if (obj && obj.type === 'pandora' && !obj.looted && obj.guards && obj.guards.length) {
      return { type: 'blocked' };
    }
    if (monsterNear(state, step.x, step.y, null, lvl)) return { type: 'blocked' };
    const fromX = hero.x, fromY = hero.y; // the water tile we vacate keeps the boat
    enterTile(state, hero, step);
    hero.onBoat = false;
    placeBoat(state, fromX, fromY);
    const landed = obj ? interactWithObject(state, hero, obj) : { type: 'moved' };
    return { type: 'disembark', landed };
  }
  // On foot: a water step either boards a waiting boat, or (naval v2) strikes
  // an enemy boat hero moored alongside — a coastal raid in reverse. The land
  // hero fights from the shore and NEVER enters the water: MP is spent, the
  // combat context is returned (tagged naval via the defender's onBoat), and
  // the hero stays put exactly like every other attacker.
  if (targetIsWater) {
    if (otherHero) {
      if (otherHero.owner !== hero.owner && !sameTeam(state, otherHero.owner, hero.owner)) {
        if (!canFight) return { type: 'blocked' }; // escort-less: can't pick fights
        hero.mp -= step.cost;
        return { type: 'combat', context: combatContext(state, hero, { kind: 'hero', heroId: otherHero.id }) };
      }
      return { type: 'blocked' }; // own or allied boat hero — no fight
    }
    if (obj && obj.type === 'boat') {
      removeObject(state, obj);
      enterTile(state, hero, step);
      hero.onBoat = true;
      return { type: 'embark' };
    }
    // Water Walk / Fly: a foot hero strides across open water (no boat needed).
    // Never onto an object tile (a whirlpool) — pathfinding already routes off it.
    if ((hero.waterWalk || hero.flying) && !obj) {
      enterTile(state, hero, step);
      return { type: 'moved' };
    }
    return { type: 'blocked' }; // open water, no boat — can't swim
  }

  // ---- combat triggers first (towns/heroes/monsters), shared with the boat path;
  // the hero does NOT enter the tile on a fight ----
  const engaged = tryEngage(state, hero, obj, otherHero, step.cost);
  if (engaged) return engaged;

  // A non-siege town on foot: capture an undefended enemy (entering it), enter
  // your own, or bounce off an ally's.
  if (obj && obj.type === 'town') {
    const town = state.towns[obj.townId];
    if (town.owner !== hero.owner && !sameTeam(state, town.owner, hero.owner)) {
      // Undefended enemy: any armyless visitor inside surrenders the keys. The
      // captured visitor is looted and retires DEFEATED to its owner's pool.
      if (town.visitingHeroId && state.heroes[town.visitingHeroId]) {
        const captive = state.heroes[town.visitingHeroId];
        lootHero(state, hero, captive);
        retireHero(state, captive, { defeated: true });
      }
      captureTown(state, town, hero.owner);
      enterTile(state, hero, step);
      enterTown(state, town, hero);
      checkVictory(state);
      return { type: 'enterTown', townId: town.id, captured: true };
    }
    // An ally's town is off-limits (you don't hold its keys).
    if (town.owner !== hero.owner) return { type: 'blocked' };
    // Own town: only one visiting hero fits on the square.
    if (town.visitingHeroId && town.visitingHeroId !== hero.id) return { type: 'blocked' };
    enterTile(state, hero, step);
    enterTown(state, town, hero);
    return { type: 'enterTown', townId: town.id };
  }

  // A Border Guard: a locked door until the player has the matching key. Without
  // it the hero halts against the guard (no move, no MP spent); with it the guard
  // is a plain passable tile the hero strides onto/through.
  if (obj && obj.type === 'borderGuard' && !playerHasKey(state, hero.owner, obj.color)) {
    return { type: 'borderGuard', color: obj.color };
  }

  // A Creature Bank: stepping onto an un-looted bank storms its guards. Win and
  // applyCombatResult plunders the reward; a looted bank is an inert ruin.
  if (obj && obj.type === 'creatureBank' && !obj.looted) {
    if (!canFight) return { type: 'blocked' };
    hero.mp -= step.cost;
    return { type: 'combat', context: combatContext(state, hero, { kind: 'creatureBank', objectId: obj.id }) };
  }

  // A GUARDED Pandora's Box fights first (win → the reward, via applyCombatResult).
  // An unguarded box falls through to the plain move and opens in interactWithObject.
  if (obj && obj.type === 'pandora' && !obj.looted && obj.guards && obj.guards.length) {
    if (!canFight) return { type: 'blocked' };
    hero.mp -= step.cost;
    return { type: 'combat', context: combatContext(state, hero, { kind: 'pandora', objectId: obj.id }) };
  }

  // ---- plain move ----
  enterTile(state, hero, step);

  // Reaching an ENEMY caravan's tile scatters it (a raid) — an unescorted
  // supply run offers no battle, only spoils (XP). Checked before guards/loot,
  // so the raid resolves as the reason the hero stopped here.
  const cv = caravanAt(state, step.x, step.y, lvl);
  if (cv && !sameTeam(state, hero.owner, cv.owner)) {
    return interceptCaravan(state, hero, cv);
  }

  // Zone of control: entering a tile beside a guard means battle ("you have
  // been waylaid!"). The tile's own loot is claimed after victory
  // (applyCombatResult re-runs the interaction).
  const guard = monsterNear(state, step.x, step.y, null, lvl);
  if (guard && canFight) {
    const context = combatContext(state, hero, { kind: 'monster', objectId: guard.id });
    // The hero ENTERED this tile (enterTile ran above) before the guard forced
    // battle, so the tile's own interaction is genuinely DEFERRED until the
    // fight is won. This flag is what applyCombatResult reads to decide whether
    // to run it: every other monster fight starts via tryEngage, which leaves
    // the hero standing where it already was — and re-running THAT tile's
    // interaction is how a hero who won a fight while standing on a portal or
    // subterranean-gate exit got yanked back through a teleporter it never
    // asked to use. (Transient by design: the context lives only from stepHero
    // to applyCombatResult, in the human scene and the AI loop alike — it is
    // never serialized, so the flag needs no save migration.)
    context.tileEntered = true;
    return { type: 'combat', context };
  }

  if (!obj) return { type: 'moved' };
  return interactWithObject(state, hero, obj);
}

function enterTile(state, hero, step) {
  // Leaving a town?
  if (hero.inTownId && state.towns[hero.inTownId]) {
    state.towns[hero.inTownId].visitingHeroId = null;
    hero.inTownId = null;
  }
  hero.mp -= step.cost;
  hero.x = step.x;
  hero.y = step.y;
  revealAround(state, hero.owner, hero.x, hero.y, heroSightRadius(hero), hero.z ?? 0);
}

function enterTown(state, town, hero) {
  town.visitingHeroId = hero.id;
  hero.inTownId = town.id;
  applyTownVisitPerks(state, town, hero);
}

/** Guild spell learning + Stables bonus, on visit and on each dawn in town. */
function applyTownVisitPerks(state, town, hero) {
  learnGuildSpells(state, town, hero);
  const catalog = buildingCatalog(town.faction);
  for (const b of town.buildings) {
    if (catalog[b]?.special === 'stables' && !hero.weeklyMoveBonus) {
      hero.weeklyMoveBonus = CONFIG.STABLES_MOVE_BONUS;
      hero.mp += CONFIG.STABLES_MOVE_BONUS; // applies immediately the day it's granted
    }
  }
  // A NIGHT UNDER A MAGE GUILD REFILLS THE SPELL BOOK — HoMM3's rule, and the
  // one a player coming from that game most expects to find here. The guild is
  // where the hero's spells came from in the first place; sleeping beneath it
  // and waking still empty is the odd outcome, not the generous one.
  //
  // Full, not a top-up. Mysticism and the manaRegen artifacts already exist to
  // make mana come back FASTER IN THE FIELD, which is the interesting choice —
  // press on, or ride home. Making the guild a mere bonus trickle would blur
  // that decision without improving it; making it a full refill keeps the two
  // clearly different things: the field regen is a rate, the town is a reset.
  //
  // Any tier does it, because the guild's LEVEL already prices itself in what
  // it teaches. And it costs the day: the hero had to end a turn in the town,
  // which on a large map is a real detour rather than a free top-up.
  //
  // Ordered before the Grail check on purpose — the arcane-font Grail below is
  // a superset (it refills with no guild at all), so a town with both simply
  // arrives at the same place twice.
  if (town.buildings.some((b) => catalog[b]?.guildLevel)) {
    hero.mana = Math.max(hero.mana, heroMaxMana(hero));
  }
  // A Grail structure can be an arcane font (Tower): a hero waking in the town
  // wakes with full mana, like a permanent Magic Well. See CONFIG.FACTION_GRAIL.
  if (town.grail && CONFIG.FACTION_GRAIL[town.faction]?.fullMana) {
    hero.mana = heroMaxMana(hero);
  }
}

export function townHasDefenders(state, town) {
  if (!armyIsEmpty(town.garrison)) return true;
  const visiting = town.visitingHeroId ? state.heroes[town.visitingHeroId] : null;
  return !!(visiting && !armyIsEmpty(visiting.army));
}

export function captureTown(state, town, newOwner) {
  // Who took whose ground. One tally, kept because "the realm squeezing me" cannot
  // be read off a force ranking: the strongest army in the world may be a horde that
  // landed on the far coast this morning, while the realm actually taking your towns
  // is the neighbour you share a river with. Patronage needs the truthful answer —
  // it decides whose flank somebody else will pay to have burned (see patrons.js
  // oppressorOf). Only ever written when land actually changes hands, so a game
  // where nothing is conquered never grows the key.
  const lost = town.owner;
  if (lost >= 0 && newOwner >= 0 && lost !== newOwner) {
    const loser = state.players[lost];
    if (loser) {
      loser.takenBy ||= {};
      loser.takenBy[newOwner] = (loser.takenBy[newOwner] || 0) + 1;
    }
  }
  // Into the chronicle before the flag moves, so the line can name both sides.
  recordEvent(state, 'town', {
    name: town.name,
    from: lost >= 0 ? (state.players[lost]?.name || `#${lost}`) : 'neutral',
    to: newOwner >= 0 ? (state.players[newOwner]?.name || `#${newOwner}`) : 'neutral',
    how: town.beachhead ? 'camp taken' : 'captured',
    at: `${town.x},${town.y}`,
  });
  town.owner = newOwner;
  // BOTH ends of the visitor link. town.visitingHeroId and hero.inTownId are a
  // two-way pointer, and every battle path clears the hero's half by retiring the
  // commander before the flag moves — but captureTown must not depend on its
  // callers for its own invariants (invaderRealms.razeBeachhead already does this
  // clear by hand, which is the invariant admitting it exists). Clearing only the
  // town's half left a hero drawing dawn perks (Stables movement, guild spells)
  // from a town that no longer knew them, and silently orphaning the town's next
  // visitor when the stale hero's own next step nulled visitingHeroId again.
  const visitor = town.visitingHeroId ? state.heroes[town.visitingHeroId] : null;
  if (visitor && visitor.inTownId === town.id) visitor.inTownId = null;
  town.visitingHeroId = null;
  town.builtToday = false;
  // HoMM3 rule: a captured Capitol is razed down to the City Hall beneath it
  // (keeps "one Capitol per realm" true after conquest; City Hall is always
  // present because Capitol requires it).
  town.buildings = town.buildings.filter((b) => b !== 'capitol');
  if (newOwner >= 0) {
    // Reveal on the town's OWN level (an underground town lifts under-fog).
    revealAround(state, newOwner, town.x, town.y, CONFIG.CAPTURE_REVEAL, town.z ?? 0);
    logMsg(state, `${state.players[newOwner].name} captured ${town.name}!`);
  }
  // Breaking a NATION's foothold is a repelled invasion. The heavy tier
  // (invaderRealms.js) stands the band waves down while it holds the field, so a
  // repelInvasions objective — and the Pax it scores — used to freeze the moment
  // the first people came ashore: measured, 260 days under `invasionTarget: 5`
  // moved the tally not at all while three nations landed and were fought.
  // Destroying an entire invader nation is the largest defensive achievement the
  // feature offers, and it credited nothing. The foothold breaking is this
  // design's own definition of an invasion being over (invaderRealms.
  // footholdBroken, and tickInvaderTempo judges its tempo at exactly this
  // moment), and every route a nation dies by — withdrawal when spent,
  // daysWithoutTown, no-towns-no-heroes — passes through losing its last town
  // first, so this seam catches all of them. One nation, ONE invasion, booked to
  // the fighting team that took the last camp (a vassal's siege credits its
  // lord's tally, same as a band broken in the field) — weighting a nation
  // heavier than a band was rejected because "5 invasions repelled" should stay
  // five events the player can name. Booked at most once per landing, mirroring
  // the tempo watch: a nation that claws a town back and loses it again was
  // repelled the first time.
  const fallen = lost >= 0 ? state.players[lost] : null;
  if (fallen?.invader && !fallen.footholdRepelled
      && newOwner >= 0 && !state.players[newOwner]?.invader
      && playerTowns(state, lost).length === 0) {
    fallen.footholdRepelled = state.day;
    noteInvasionRepelled(state, newOwner, { invader: { peopleName: fallen.name } });
  }
  // Always settle victory here: a captureTown objective can target a NEUTRAL
  // hold, so a siege win over neutral garrisons must complete the objective at
  // the moment of capture, not a turn later. checkVictory is idempotent once
  // the winner is set, so callers that also check afterwards stay correct.
  checkVictory(state);
}

/**
 * A war-band storms a town: a battle with nobody's hero on the attacking side.
 *
 * This is the reported bug's fix. "They got to the town and sit at the gate, they do
 * not attack" was not a bug in the marching — it was that nothing in the band model
 * could attack a town. A band levied a toll on a cooldown and camped between tolls,
 * which is a tax collector, not an invasion.
 *
 * Lives here rather than in invasions.js because it needs this module's private
 * plumbing — mergedTownArmy for the defence, retireHero for a commander who loses
 * their town, writeBackArmy for the survivors — and invasions.js is imported FROM
 * here, so it is injected into tickInvasions as a plain function (no cycle). It
 * is the ONE verb by which a war-band takes a town; the sack path never captures.
 *
 * Outcomes, and both of them are real:
 *
 *   The walls fall. The town goes NEUTRAL rather than to the band's "owner" (a band is
 *   an object, not a player) — and the surviving warriors move in as its garrison. That
 *   last part matters: without it, taking the town back is a walk through an open gate,
 *   and the loss costs the realm nothing but a flag. A defending hero who loses their
 *   town is retired the same way losing any battle retires them.
 *
 *   The walls hold. The garrison keeps its survivors, and the band withdraws with
 *   whatever is left of it — destroyed outright if that is nothing. A repulse is not a
 *   stalemate: the band does not sit back down at the gate.
 *
 * Returns { stormed: true, taken, gone, bandLeft, townName, peopleName } for the log,
 * or null when the fight could not be built at all.
 */
export function resolveBandAssault(state, obj, town) {
  const ctx = bandAssaultContext(state, obj, town);
  if (!ctx) return null;
  return applyBandAssault(state, ctx, autoBandBattle(state, ctx));
}

/**
 * The assault fought without anybody watching. Exported because the view offers
 * exactly this as a choice — "let them fight it" — and it has to be the SAME battle
 * the dawn tick would have run, not a second one built beside it.
 */
export function autoBandBattle(state, ctx) {
  return autoResolve(createBattle({
    rng: state.rng,
    features: state.features || {},
    upgrades: playerUpgrades(state),
    attacker: {
      hero: null,
      army: ctx.attackerArmy,
      playerIndex: -1,
      discipline: ctx.attackerDiscipline,
    },
    defender: {
      hero: contextDefenderHero(state, ctx),
      army: ctx.defenderArmy,
      playerIndex: state.towns[ctx.bandAssault.townId]?.owner ?? -1,
    },
    siege: ctx.fortTier >= 1 ? { fortTier: ctx.fortTier } : null,
    defenseBonus: ctx.defenseBonus,
    pveSplitParts: pveSplitParts(state),
  }));
}

/**
 * An assault the PLAYER settled — outcome, bookkeeping, log line and repel tally,
 * in the order the dawn tick does them.
 *
 * The dawn tick gets all four from tickInvasions (applyBandAssault, then
 * settleAssault, then the event loop in advanceDay). A fight opened from the map has
 * no tick around it, so this is that same sequence with the loop unrolled — one door,
 * so a band the player threw back is despawned, tallied and logged exactly like one
 * thrown back at dawn instead of standing at the gate re-attacking every morning.
 */
export function settleBandAssault(state, ctx, result) {
  const obj = getObject(state, ctx.bandAssault.objectId);
  const town = state.towns[ctx.bandAssault.townId];
  const a = applyBandAssault(state, ctx, result);
  if (!a || !obj || !town) return a;
  const ev = settleAssault(state, obj, town, a);
  logMsg(state, ev.text);
  recordEvent(state, 'note', { text: ev.text, kind: ev.kind });
  if (ev.kind === 'assaultRepulsed' && ev.gone && town.owner >= 0) {
    noteInvasionRepelled(state, town.owner, { invader: { peopleName: ev.peopleName, wave: ev.wave } });
  }
  return a;
}

/**
 * What the daily tick does with an assault: settle it, or set it aside for the
 * player to fight.
 *
 * Reported as "when a band attacks a castle I don't get warning of a fight, and I
 * understand the castle was attacked and taken only when I check and see a decrease
 * in the towns held". The assault was real and the log line was written — but it was
 * written INSIDE endTurn, so the largest thing that happens in a game of this went
 * past as one line among the dawn's toasts, with your own garrison fighting without
 * you. A human's town now queues the fight instead; AdventureScene drains
 * `pendingAssaults` at dawn, announces who is at the gate, and opens the battle.
 *
 * Queued by ID, not by context: nothing else runs between the queue and the drain,
 * but a save taken with a band at the gate must restore to the same fight rather
 * than to a snapshot of a garrison.
 */
function bandAssaultAtDawn(state, obj, town) {
  if (!assaultIsPlayable(state, town)) return resolveBandAssault(state, obj, town);
  const q = (state.pendingAssaults ||= []);
  // A band that stands at the gate arrives again every dawn until the fight is
  // played. One entry per band.
  if (!q.some((p) => p.objectId === obj.id)) q.push({ objectId: obj.id, townId: town.id });
  return { deferred: true };
}

/**
 * The assault as a battle CONTEXT — everything the fight needs, and nothing about
 * how it is settled.
 *
 * Extracted so the same assault can be auto-resolved at dawn (resolveBandAssault,
 * unchanged) or handed to CombatScene and played by hand. The reported symptom was
 * the second case missing entirely: "I understand the castle was attacked and taken
 * only when I check and see a decrease in the towns held". A wave taking one of your
 * towns is the largest thing that happens in a game of this, and it happened inside a
 * tick, silently, with the player's own garrison fighting without them.
 *
 * Shaped like a `combatContext` so the view needs no second vocabulary, with two
 * fields a hero-led context never carries — `attackerArmy` and `attackerName`,
 * because there is no attacking hero to read them off — and `bandAssault`, which is
 * how the view knows to settle it through applyBandAssault rather than
 * applyCombatResult.
 */
export function bandAssaultContext(state, obj, town) {
  if (!obj || !town) return null;
  const merged = mergedTownArmy(state, town);
  const fortTier = town.buildings.includes('castle') ? 3
    : town.buildings.includes('citadel') ? 2
      : town.buildings.includes('fort') ? 1 : 0;
  const peopleName = obj.invader?.peopleName || 'The invaders';
  return {
    bandAssault: { objectId: obj.id, townId: town.id },
    attackerHeroId: null,
    attackerArmy: [{ creature: obj.creature, count: obj.count, hurt: 0 }],
    attackerDiscipline: obj.invader?.discipline || 0,
    attackerName: `${peopleName} — ${CREATURES[obj.creature]?.name || 'warriors'}`,
    peopleName,
    defender: { kind: 'town', townId: town.id },
    defenderArmy: merged.army,
    defenderReserve: merged.reserve,
    defenderHeroId: merged.heroId,
    defenderName: town.name,
    siege: true,
    fortTier,
    defenseBonus: [0, 2, 3, 4][fortTier],
    terrain: tileAt(state, town.x, town.y, town.z ?? 0)?.terrain || 'grass',
  };
}

/**
 * Settle an assault from a battle result — whoever produced it. `res` is the raw
 * engine result (`attackerWon`, `attackerArmy`, `defenderArmy`), so autoResolve at
 * dawn and a fight the player just won come through the same door and cannot drift
 * apart. Returns the same log record resolveBandAssault always returned.
 */
export function applyBandAssault(state, ctx, res) {
  const obj = getObject(state, ctx.bandAssault.objectId);
  const town = state.towns[ctx.bandAssault.townId];
  if (!obj || !town) return null;
  const defenderHero = ctx.defenderHeroId ? state.heroes[ctx.defenderHeroId] : null;
  const peopleName = ctx.peopleName;
  const merged = { army: ctx.defenderArmy, reserve: ctx.defenderReserve };
  const bandLeft = Math.max(0, (res.attackerArmy || []).reduce((n, s) => n + (s?.count || 0), 0));
  // battleResult reports `attackerWon`, not `winner` — reading the field that does not
  // exist made every assault in the game a repulse, including 320 crusaders against an
  // empty town with the gates open. Measured: 0 wins out of 45 undefended assaults.
  const taken = res.attackerWon === true;

  // The defending commander broke off — only reachable once the fight is PLAYED,
  // since autoResolve never escapes. They leave into the re-hire pool rather than
  // falling with the town (applyEscape's rule, kept identical here), and the walls
  // behind them are empty: the band takes the town as if it had won, which is what
  // the engine already recorded when it set the winner.
  const escape = res.escape?.side === 1 ? res.escape : null;
  if (escape && defenderHero) {
    const kept = escape.mode === 'surrender' ? (res.defenderArmy || []) : [];
    const cost = escape.mode === 'surrender' ? surrenderCost(kept, defenderHero) : 0;
    if (cost > 0 && defenderHero.owner >= 0) {
      const p = state.players[defenderHero.owner];
      p.resources.gold = Math.max(0, (p.resources.gold || 0) - cost);
    }
    writeBackArmy(defenderHero.army, kept);
    logMsg(state, escape.mode === 'surrender'
      ? `${defenderHero.name} surrendered ${town.name} to ${peopleName}.`
      : `${defenderHero.name} abandoned ${town.name} to ${peopleName}.`);
    leaveDerelictBoat(state, defenderHero);
    retireHero(state, defenderHero);
  }

  if (taken) {
    // The commander who lost the town goes with it — unless they got out (above).
    if (defenderHero && !escape) {
      logMsg(state, `${defenderHero.name} fell defending ${town.name}.`);
      retireHero(state, defenderHero, { defeated: true });
    }
    captureTown(state, town, -1);
    // The survivors are the new garrison. Reserve stacks that sat out are lost with
    // the town — they were inside it.
    town.garrison = [null, null, null, null, null, null, null];
    if (bandLeft > 0) town.garrison[0] = { creature: obj.creature, count: bandLeft, hurt: 0 };
    return { stormed: true, taken: true, gone: true, bandLeft, townName: town.name, peopleName };
  }

  // The defence held. Survivors return exactly the way applyCombatResult returns them
  // from a siege: the hero fills up first, the rest garrisons the town, and reserve
  // stacks that never fit on the battlefield come back untouched.
  const survivors = [...(res.defenderArmy || []), ...merged.reserve];
  town.garrison = [null, null, null, null, null, null, null];
  if (defenderHero) {
    writeBackArmy(defenderHero.army, []);
    for (const s of survivors) {
      if (s && s.count > 0 && !addToArmy(defenderHero.army, s.creature, s.count)) {
        addToArmy(town.garrison, s.creature, s.count);
      }
    }
  } else {
    for (const s of survivors) {
      if (s && s.count > 0) addToArmy(town.garrison, s.creature, s.count);
    }
  }
  if (bandLeft > 0) obj.count = bandLeft;
  return {
    stormed: true, taken: false, gone: bandLeft <= 0, bandLeft,
    townName: town.name, peopleName,
  };
}

function interactWithObject(state, hero, obj) {
  const player = state.players[hero.owner];
  switch (obj.type) {
    case 'resource': {
      grant(player, { [obj.resource]: obj.amount });
      removeObject(state, obj);
      return { type: 'pickup', resource: obj.resource, amount: obj.amount };
    }
    case 'chest': {
      // Roll contents once and STASH them on the object, so resolveChest grants
      // the engine's numbers — never a caller-supplied amount. The view only
      // chooses gold vs XP; it does not get to name the payout.
      if (!obj.chest) obj.chest = rollChestContents(state);
      return { type: 'chest', objectId: obj.id, gold: obj.chest.gold, xp: obj.chest.xp };
    }
    case 'artifact': {
      giveArtifact(state, hero, obj.artifact);
      removeObject(state, obj);
      return { type: 'artifact', artifact: obj.artifact };
    }
    case 'mine': {
      // Don't re-flag a mine an ally already holds (towns and heroes both honour
      // sameTeam; the mine case was the one that let you poach a teammate's mine).
      if (obj.owner !== hero.owner && !sameTeam(state, obj.owner, hero.owner)) {
        // A defended holding never reaches here — tryEngage turns it into a
        // battle before the step lands. Arriving means it was undefended, or the
        // assault was already won.
        claimHolding(state, obj, hero.owner);
        revealAround(state, hero.owner, obj.x, obj.y, CONFIG.MINE_REVEAL, hero.z ?? 0);
        logMsg(state, `${state.players[hero.owner].name} flagged a ${mineName(obj.mineType)}.`);
        return { type: 'mineFlagged', mineType: obj.mineType };
      }
      return { type: 'moved' };
    }
    case 'dwelling': {
      // Flag the site to the visitor (a map banner, like a mine — sameTeam-safe),
      // then OFFER recruitment: the event carries the stock so the view can open
      // a buy dialog (the AI calls recruitFromDwelling directly). Stepping here
      // never charges by itself.
      if (obj.owner !== hero.owner && !sameTeam(state, obj.owner, hero.owner)) {
        claimHolding(state, obj, hero.owner);
      }
      return {
        type: 'dwelling', objectId: obj.id, creature: dwellingCreature(obj),
        available: obj.available || 0, name: dwellingName(obj),
      };
    }
    case 'booster': {
      return applyBooster(state, hero, obj);
    }
    case 'seerHut': {
      return visitSeerHut(state, hero, obj);
    }
    case 'tradingPost': {
      return visitTradingPost(state, hero, obj);
    }
    case 'keymaster': {
      // A Keymaster Tent grants the whole player a permanent colored key; it is
      // not consumed, so revisiting is a no-op. The key opens every matching
      // Border Guard for that player from now on.
      const had = playerHasKey(state, hero.owner, obj.color);
      if (!had) {
        player.keys.push(obj.color);
        logMsg(state, `${player.name} received the ${keyColorName(obj.color)} Key.`);
      }
      return { type: 'keymaster', color: obj.color, isNew: !had };
    }
    case 'borderGuard': {
      // Reached here only when the player HAS the key (stepHero halts keyless
      // heroes before entry) — a plain, silent pass-through.
      return { type: 'moved' };
    }
    case 'creatureBank': {
      // Reached only for a LOOTED bank (an un-looted one triggers combat in
      // stepHero before entry) — an emptied ruin the hero walks over. Unless the
      // nest has bred since (the `lairBrood` feature): then the young are the
      // hero's for the taking, free, the fight for them long since won.
      const brood = obj.brood || 0;
      if (brood > 0) {
        const cr = broodOf(obj.bankType)?.creature;
        const name = bankDef(obj.bankType)?.name || 'lair';
        if (!cr) return { type: 'moved' };
        if (!addToArmy(hero.army, cr, brood)) {
          // No slot and no matching stack: leave the brood where it is rather
          // than silently destroying it, and say why.
          return { type: 'lairBrood', name, creature: cr, count: 0, available: brood, full: true };
        }
        obj.brood = 0;
        logMsg(state, `${hero.name} collected ${brood} ${CREATURES[cr]?.name || cr} from the ${name}.`);
        return { type: 'lairBrood', name, creature: cr, count: brood, available: 0, full: false };
      }
      return { type: 'moved' };
    }
    case 'pandora': {
      // A guarded box is handled by stepHero (combat first); a looted one is
      // spent. An unguarded, un-looted box opens right here on contact.
      if (obj.looted || (obj.guards && obj.guards.length)) return { type: 'moved' };
      const { got, levels } = grantPandoraReward(state, hero, obj);
      const ev = { type: 'pandora', reward: got, levels };
      if (levels > 0) ev.events = [{ type: 'levelUp', heroId: hero.id }];
      return ev;
    }
    case 'portal': {
      return usePortal(state, hero, obj);
    }
    case 'monolith': {
      return useMonolith(state, hero, obj);
    }
    case 'subGate': {
      return useSubGate(state, hero, obj);
    }
    case 'shipyard': {
      // Stepping onto a shipyard OFFERS a boat, it never charges by itself:
      // the caller shows "Build a boat? (cost)" and calls buildBoat on
      // confirm (the AI calls buildBoat directly). The event carries
      // everything the dialog needs, including why a build would fail.
      const check = shipyardBuildCheck(state, state.players[hero.owner], obj);
      return {
        type: 'shipyard',
        objectId: obj.id,
        cost: { ...CONFIG.BOAT_COST },
        canBuild: check.ok,
        reason: check.ok ? null : check.reason,
      };
    }
    default:
      return { type: 'moved' };
  }
}

/**
 * Step onto a portal → emerge from its partner (the other portal sharing this
 * channel). The hero has already been moved onto `obj`'s tile by enterTile, so
 * we relocate them to the partner and reveal the far side. Arriving on the exit
 * does NOT re-fire (this runs only from a fresh step, never on placement), so
 * there is no ping-pong. If the exit is blocked by another hero, or the portal
 * is orphaned, the step is a plain move (the hero simply stands on the portal).
 */
function usePortal(state, hero, obj) {
  const lvl = hero.z ?? 0; // portals teleport WITHIN a level
  const partner = Object.values(levelObjects(state, lvl)).find(
    (o) => o.type === 'portal' && o.channel === obj.channel && o.id !== obj.id,
  );
  if (!partner) return { type: 'moved' }; // lone portal — inert
  if (heroAt(state, partner.x, partner.y, lvl)) return { type: 'blockedExit' }; // exit occupied
  const from = { x: hero.x, y: hero.y };
  hero.x = partner.x;
  hero.y = partner.y;
  revealAround(state, hero.owner, hero.x, hero.y, heroSightRadius(hero), lvl);
  logMsg(state, `${hero.name} stepped through a portal.`);
  return { type: 'portal', from, to: { x: partner.x, y: partner.y }, channel: obj.channel };
}

/**
 * Step onto a one-way Monolith → if it is an ENTRANCE, sweep the hero to a
 * RANDOM exit of the same colour on this level (never back — exits are
 * one-directional). An EXIT is an inert landmark (a plain move). A colour with
 * no reachable/free exit cancels the transit (the hero simply stands on the
 * entrance). Modelled on usePortal; arriving on an inert exit never re-fires,
 * so there is no ping-pong. The destination is drawn from the gameplay RNG
 * (state.rng) so a replay is deterministic.
 */
function useMonolith(state, hero, obj) {
  if (obj.dir !== 'entrance') return { type: 'moved' }; // an exit is just a landmark
  const lvl = hero.z ?? 0;
  const exits = Object.values(levelObjects(state, lvl)).filter(
    (o) => o.type === 'monolith' && o.dir === 'exit' && o.color === obj.color,
  );
  if (!exits.length) return { type: 'moved' }; // orphan entrance — inert
  const free = exits.filter((o) => !heroAt(state, o.x, o.y, lvl));
  if (!free.length) return { type: 'blockedExit' }; // every exit is occupied
  const dest = free.length === 1 ? free[0] : free[state.rng.int(0, free.length - 1)];
  const from = { x: hero.x, y: hero.y };
  hero.x = dest.x;
  hero.y = dest.y;
  revealAround(state, hero.owner, hero.x, hero.y, heroSightRadius(hero), lvl);
  logMsg(state, `${hero.name} was swept through a one-way monolith.`);
  return { type: 'monolith', from, to: { x: dest.x, y: dest.y }, color: obj.color };
}

/**
 * Step onto a subterranean gate → emerge from its partner (the gate sharing
 * this channel ON THE OTHER LEVEL). Modeled exactly on usePortal: the hero has
 * already been moved onto `obj`'s tile by enterTile, so we relocate them —
 * setting hero.z — and reveal around the exit on the destination level.
 * Arriving on the exit does NOT re-fire (this runs only from a fresh step), so
 * there is no ping-pong. A lone gate is inert; an occupied exit cancels the
 * transit and the hero simply stands on the entry gate.
 */
function useSubGate(state, hero, obj) {
  const fromLevel = hero.z ?? 0;
  const toLevel = fromLevel === 0 ? 1 : 0;
  const partner = Object.values(levelObjects(state, toLevel)).find(
    (o) => o.type === 'subGate' && o.channel === obj.channel,
  );
  if (!partner) return { type: 'moved' }; // unpaired gate — inert
  if (heroAt(state, partner.x, partner.y, toLevel)) return { type: 'blockedExit' }; // exit occupied
  const from = { x: hero.x, y: hero.y, level: fromLevel };
  hero.z = toLevel;
  hero.x = partner.x;
  hero.y = partner.y;
  revealAround(state, hero.owner, hero.x, hero.y, heroSightRadius(hero), toLevel);
  logMsg(state, toLevel === 1
    ? `${hero.name} descended into the underworld.`
    : `${hero.name} emerged into daylight.`);
  return {
    type: 'subGate',
    from,
    to: { x: partner.x, y: partner.y, level: toLevel },
    channel: obj.channel,
  };
}

/**
 * Re-trigger the teleporter (portal / subterranean gate / whirlpool) the hero is
 * STANDING on — the HoMM3 "visit the object under you" action, bound to Space.
 * Unlike ARRIVING on an exit (which never re-fires, to stop ping-pong), this is
 * a DELIBERATE re-use: a hero who teleported onto a portal/gate exit hemmed in by
 * rock can always step back through the way they came. It costs no movement (the
 * hero is already on the tile). Returns the same event shape stepHero produces
 * for a portal/subGate/whirlpool (so the view animates it identically), or
 * { type: 'none' } when the hero isn't standing on a usable teleporter.
 */
export function useObjectUnderHero(state, hero) {
  if (!hero) return { type: 'none' };
  const lvl = hero.z ?? 0;
  const obj = objectAt(state, hero.x, hero.y, lvl);
  if (!obj) return { type: 'none' };
  if (obj.type === 'portal') return usePortal(state, hero, obj);
  if (obj.type === 'monolith' && obj.dir === 'entrance') return useMonolith(state, hero, obj);
  if (obj.type === 'subGate') return useSubGate(state, hero, obj);
  if (obj.type === 'whirlpool' && hero.onBoat) return useWhirlpool(state, hero, obj);
  return { type: 'none' };
}

/**
 * A boat hero ENDED a move on a whirlpool → swept to a RANDOM other whirlpool
 * on the same level (the deterministic, save-persisted state.rng picks the
 * exit — NOT a fixed channel pair; that randomness is what tells a whirlpool
 * apart from a portal), for a toll of army (see whirlpoolToll). Structurally a
 * usePortal twin: the hero has already been moved onto `obj`'s tile by
 * enterTile, so we relocate them — still onBoat, whirlpools sit on water — and
 * reveal fog around the exit. Arriving does NOT re-fire (this runs only from a
 * fresh step), so there is no ping-pong. A lone whirlpool is inert churn, and
 * an occupied exit calms the swirl: both are a plain move (the hero simply
 * bobs on the whirlpool tile, no toll taken). Never throws.
 * Returns { type: 'whirlpool', from, to, lost: { creature, count } | null }.
 */
function useWhirlpool(state, hero, obj) {
  const lvl = hero.z ?? 0; // surface-only in practice (the underground is dry)
  const exits = Object.values(levelObjects(state, lvl)).filter(
    (o) => o.type === 'whirlpool' && o.id !== obj.id,
  );
  if (!exits.length) return { type: 'moved' }; // lone whirlpool — just churning water
  const exit = exits[state.rng.int(0, exits.length - 1)];
  if (heroAt(state, exit.x, exit.y, lvl)) return { type: 'moved' }; // exit occupied — the swirl subsides
  const from = { x: hero.x, y: hero.y };
  hero.x = exit.x;
  hero.y = exit.y;
  revealAround(state, hero.owner, hero.x, hero.y, heroSightRadius(hero), lvl);
  const lost = whirlpoolToll(hero);
  logMsg(state, lost
    ? `${hero.name} was dragged through a whirlpool — ${lost.count} ${CREATURES[lost.creature]?.name || 'creature'}${lost.count === 1 ? '' : 's'} washed overboard!`
    : `${hero.name} was dragged through a whirlpool.`);
  return { type: 'whirlpool', from, to: { x: exit.x, y: exit.y }, lost };
}

/**
 * The whirlpool's price: HALF of the hero's weakest stack, rounded down,
 * minimum 1 creature ("weakest" = lowest total aiValue, lowest slot breaking
 * ties — deterministic). But the sea never takes a hero's LAST creature: a
 * one-creature stack is removed outright only when another stack survives;
 * a hero whose whole army is that single creature (or who sails escort-less)
 * pays nothing. Mutates hero.army; returns { creature, count } of what was
 * lost, or null when the toll was waived.
 */
function whirlpoolToll(hero) {
  let idx = -1;
  let weakest = Infinity;
  let stacks = 0;
  for (let i = 0; i < hero.army.length; i++) {
    const s = hero.army[i];
    if (!s || s.count <= 0) continue;
    stacks++;
    const v = (CREATURES[s.creature]?.aiValue || 0) * s.count;
    if (v < weakest) { weakest = v; idx = i; }
  }
  if (idx < 0) return null; // no army at all — nothing to take
  const stack = hero.army[idx];
  const toll = Math.max(1, Math.floor(stack.count / 2));
  if (toll >= stack.count) { // a single creature in the stack
    if (stacks <= 1) return null; // the hero's last creature is spared
    hero.army[idx] = null;
    return { creature: stack.creature, count: stack.count };
  }
  stack.count -= toll;
  return { creature: stack.creature, count: toll };
}

export function mineName(mineType) {
  return {
    sawmill: 'Sawmill', orePit: 'Ore Pit', goldMine: 'Gold Mine',
    alchemistLab: 'Alchemist Lab', sulfurMine: 'Sulfur Mine',
    crystalCavern: 'Crystal Cavern', gemPond: 'Gem Pond',
  }[mineType] || 'Mine';
}

/** Display name of a colored key / guard (from CONFIG.KEY_COLORS). */
export function keyColorName(color) {
  return CONFIG.KEY_COLORS.find((k) => k.id === color)?.name || color;
}

// Display names of every visitable "booster" type, keyed by boosterType. Exported
// as the canonical list so the sprite manifest (boost_<type>) and its drift guard
// stay in lockstep with the game's actual visitables — a new booster here surfaces
// in `assets:missing` instead of silently shipping procedural.
export const BOOSTER_NAMES = {
  attack: 'Mercenary Camp', defense: 'Marletto Tower', power: 'Star Axis',
  knowledge: 'Garden of Revelation', xp: 'Learning Stone',
  luck: 'Fountain of Fortune', morale: 'Temple', mana: 'Magic Well',
  move: "Wayfarer's Camp", obelisk: 'Obelisk',
  windmill: 'Windmill', waterWheel: 'Water Wheel', tradeFair: 'Trade Fair',
  observatory: 'Redwood Observatory', magicSpring: 'Magic Spring', hillFort: 'Hill Fort',
  witchHut: 'Witch Hut', shrine: 'Shrine of Magic',
  library: 'Library of Enlightenment', treeOfKnowledge: 'Tree of Knowledge',
};

/** Every booster/visitable type the game can place (the boost_<type> art keys). */
export const BOOSTER_TYPES = Object.keys(BOOSTER_NAMES);

export function boosterName(type) {
  return BOOSTER_NAMES[type] || 'Shrine';
}

/** Short description of what visiting a booster grants (for tooltips/dialogs). */
export function boosterEffect(type) {
  return {
    attack: '+1 Attack (permanent)', defense: '+1 Defense (permanent)',
    power: '+1 Power (permanent)', knowledge: '+1 Knowledge (permanent)',
    xp: '+1000 experience', luck: '+1 Luck until your next battle',
    morale: '+1 Morale until your next battle', mana: 'Restores your spell points',
    move: `+${CONFIG.MOVE_BOOST} movement today`,
    obelisk: 'Reveals the surrounding lands (+experience)',
    windmill: 'A few resources, replenished each week',
    waterWheel: `+${CONFIG.WATER_WHEEL_GOLD} gold each week`,
    tradeFair: `A mixed bundle — ${CONFIG.TRADE_FAIR_KINDS} goods and ${CONFIG.TRADE_FAIR_GOLD} gold, each week`,
    observatory: 'Charts a wide sweep of the surrounding map',
    magicSpring: `Refills mana to ${CONFIG.MAGIC_SPRING_MULT}× your maximum, once a week`,
    hillFort: 'Upgrades your army on the spot (low tiers free)',
    witchHut: 'Teaches a secondary skill',
    shrine: 'Teaches a spell',
    library: `+${CONFIG.LIBRARY_BONUS} to all four primary skills, level ${CONFIG.LIBRARY_MIN_LEVEL}+ (permanent)`,
    treeOfKnowledge: 'Grants your hero a full level',
  }[type] || 'A mysterious blessing';
}

/** Resources a Windmill can yield (anything but gold), like HoMM3. */
const WINDMILL_RESOURCES = RESOURCES.filter((r) => r !== 'gold');

/** The upgraded creature id for a base creature — independent of any town
 *  (a Hill Fort upgrades in the field), or null if there's no upgrade.
 *  Exported for the AI, which prices a Hill Fort by the army value the upgrade
 *  would actually add rather than by a flat "a booster is a booster". */
export function upgradeTargetOf(creatureId) {
  const c = CREATURES[creatureId];
  if (!c || c.upgraded) return null;
  return Object.keys(CREATURES).find((id) => CREATURES[id].upgradeOf === creatureId) || null;
}

/** True when this booster currently grants nothing to `hero` (already banked
 *  a one-shot, rested at a camp today, drained a weekly object this week, or a
 *  Hill Fort with nothing left to upgrade) — shared by applyBooster and the AI
 *  so both agree on "worth a visit". */
/**
 * HUSBANDRY (a pact term): each week, a vassal's stewards work the weekly sites
 * standing in their OWN lands, and the suzerain takes the pact's usual share.
 *
 * The clause exists because the map bleeds. Measured over eight weeks of real
 * play, **90% of weekly sites on a 72x60 map and larger were never visited by
 * anybody** — on a 96x80 that is 154 000 gold of water wheels alone left to rot.
 * A hero cannot be everywhere, and a realm sworn to you has heroes of its own
 * doing nothing with the countryside it still holds.
 *
 * Three bounds keep it from replacing the map rather than supplementing it:
 *
 *   OWN LANDS only. A site is the vassal's to tend when the nearest town on its
 *   own level is theirs. That is the "part of the kingdom" the clause hands
 *   over, it is land a suzerain's heroes would not have ridden to anyway, and it
 *   is contestable in the ordinary way — take the town and the stewards go with it.
 *
 *   A FRACTION of the yield (CONFIG.PACT_HUSBANDRY_YIELD). A steward is not a
 *   hero; riding out yourself is still the better take.
 *
 *   ONCE a week, through the site's own `harvestedWeek` stamp, so a steward and a
 *   hero can never both collect the same mill.
 *
 * The Magic Spring is deliberately excluded: it restores a hero's mana on the
 * spot, and there is nothing for a steward to carry home.
 */
const HUSBANDRY_SITES = new Set(['windmill', 'waterWheel', 'tradeFair']);

function tendVassalSites(state) {
  const pacts = allPacts(state).filter((p) => p.terms?.husbandry);
  if (!pacts.length) return [];
  const week = weekOf(state.day);
  const events = [];
  // Nearest town per level, once — the same answer for every site on that level.
  const townsOn = [];
  for (let level = 0; level < 2; level++) {
    townsOn[level] = Object.values(state.towns)
      .filter((t) => (t.z ?? 0) === level && t.owner >= 0);
  }
  for (const pact of pacts) {
    const vassal = state.players[pact.vassal];
    const suzerain = state.players[pact.suzerain];
    if (!vassal || !suzerain || vassal.defeated) continue;
    const share = Math.max(0, Math.min(1, pact.terms?.tributeShare || 0));
    const took = {}, cut = {};
    for (const objects of [state.map.objects, state.map.underground?.objects]) {
      if (!objects) continue;
      const level = objects === state.map.objects ? 0 : 1;
      for (const obj of Object.values(objects)) {
        if (obj.type !== 'booster' || !HUSBANDRY_SITES.has(obj.boosterType)) continue;
        if (obj.harvestedWeek === week) continue;
        // Whose land is this? The nearest town wins; a level with no towns at
        // all belongs to nobody and is left alone.
        let near = null, best = Infinity;
        for (const t of townsOn[level]) {
          const d = Math.max(Math.abs(t.x - obj.x), Math.abs(t.y - obj.y));
          if (d < best) { best = d; near = t; }
        }
        if (!near || near.owner !== pact.vassal) continue;
        obj.harvestedWeek = week;
        const full = weeklySiteYield(state, obj.boosterType);
        for (const [res, amount] of Object.entries(full)) {
          const worked = Math.floor(amount * CONFIG.PACT_HUSBANDRY_YIELD);
          if (worked <= 0) continue;
          const lords = Math.floor(worked * share);
          const keep = worked - lords;
          if (keep > 0) { vassal.resources[res] = (vassal.resources[res] || 0) + keep; took[res] = (took[res] || 0) + keep; }
          if (lords > 0) { suzerain.resources[res] = (suzerain.resources[res] || 0) + lords; cut[res] = (cut[res] || 0) + lords; }
        }
      }
    }
    const lordsCut = Object.entries(cut).map(([r, n]) => `${n} ${r}`);
    if (lordsCut.length) {
      events.push({ kind: 'husbandry', pactId: pact.id,
        text: `${vassal.name}'s stewards worked the mills and wheels; ${suzerain.name}'s share is ${lordsCut.join(', ')}.` });
    } else if (Object.keys(took).length) {
      events.push({ kind: 'husbandry', pactId: pact.id,
        text: `${vassal.name}'s stewards worked the mills and wheels of their own lands.` });
    }
  }
  return events;
}

/**
 * What a weekly site pays out, as a resource bundle. ONE definition, because a
 * hero riding up to a windmill and a vassal's steward working it under a
 * husbandry pact must not disagree about what a windmill is worth.
 *
 * Draws from `state.rng` for the two sites that roll (windmill, trade fair), so
 * it is called exactly once per harvest and never speculatively.
 */
export function weeklySiteYield(state, boosterType) {
  if (boosterType === 'waterWheel') return { gold: CONFIG.WATER_WHEEL_GOLD };
  if (boosterType === 'tradeFair') {
    // A BUNDLE: several distinct goods plus coin, so one visit resupplies a
    // build queue instead of topping up a single pile. Draw without repeats so
    // the bundle is genuinely mixed.
    const pool = [...WINDMILL_RESOURCES];
    const bundle = { gold: CONFIG.TRADE_FAIR_GOLD };
    const kinds = Math.min(CONFIG.TRADE_FAIR_KINDS, pool.length);
    for (let k = 0; k < kinds; k++) {
      const res = pool.splice(state.rng.int(0, pool.length - 1), 1)[0];
      bundle[res] = state.rng.int(CONFIG.TRADE_FAIR_MIN, CONFIG.TRADE_FAIR_MAX);
    }
    return bundle;
  }
  const res = state.rng.pick(WINDMILL_RESOURCES);
  return { [res]: state.rng.int(CONFIG.WINDMILL_MIN, CONFIG.WINDMILL_MAX) };
}

export function boosterSpent(state, hero, obj) {
  const t = obj.boosterType;
  if (t === 'move') return hero.boostDays?.[obj.id] === state.day;
  if (t === 'windmill' || t === 'waterWheel' || t === 'tradeFair' || t === 'magicSpring') {
    return obj.harvestedWeek === weekOf(state.day);
  }
  if (t === 'hillFort') {
    // Spent unless at least one stack has an upgrade the player could actually
    // take — mirrors applyBooster's per-stack test (free below HILL_FORT_FREE_TIER,
    // else the price difference must be affordable). Without the affordability
    // gate the AI eyed a fort it can't pay for and shuttled to it fruitlessly.
    const player = state.players[hero.owner];
    return !hero.army?.some((s) => {
      if (!s || s.count <= 0) return false;
      const to = upgradeTargetOf(s.creature);
      if (!to) return false;
      const tier = CREATURES[s.creature].tier || 0;
      const cost = tier <= CONFIG.HILL_FORT_FREE_TIER ? {} : upgradeUnitCost(s.creature, to, s.count);
      return canAfford(player, cost);
    });
  }
  // A Magic Well grants nothing to a hero already at full mana: without this it
  // read "always worth a look", so a full-mana hero priced it forever and could
  // shuttle between two wells across turns, invisible to the stuck detector.
  if (t === 'mana') return hero.mana >= heroMaxMana(hero);
  // A Witch Hut is the same shape, and for the same reason it cannot be answered
  // from `hero.visited` alone: her refusals no longer spend the visit (see
  // applyBooster), because a full skillset is a thing the Hall of Reflection can
  // undo. So ask the question she asks — is there a slot, and is the skill new? —
  // and the hut goes back to "worth a look" the day the answer changes.
  if (t === 'witchHut') {
    if (hero.skills?.[obj.skill]) return true;
    if (Object.keys(hero.skills || {}).length >= CONFIG.MAX_SECONDARY_SKILLS) return true;
    return !!hero.visited[obj.id];
  }
  return !!hero.visited[obj.id];
}

/**
 * The Grail puzzle for one player: how many DISTINCT obelisks they have
 * uncovered vs the total on the map (both levels). When seen === total (> 0)
 * the buried Grail's tile is known — see the obelisk visit in applyBooster.
 */
export function obeliskProgress(state, owner) {
  return { seen: (state.players[owner]?.obeliskIds || []).length, total: obeliskCount(state) };
}

/**
 * How many obelisks the map carries, across both levels.
 *
 * Indexed, because the AI prices every unread obelisk against the puzzle's
 * length and so asked this question a thousand times per hero's scan, each time
 * walking every object on both levels. An obelisk is placed at generation and
 * never removed, so the answer only ever changes when a map is loaded — which
 * the index detects on its own (see objectsWhere).
 */
function obeliskCount(state) {
  const isObelisk = (o) => o.type === 'booster' && o.boosterType === 'obelisk';
  return objectsWhere(state, 0, 'obelisks', isObelisk).length
    + (state.map.underground ? objectsWhere(state, 1, 'obelisks', isObelisk).length : 0);
}

/** True once `owner` has uncovered every obelisk (so they know the Grail tile). */
export function grailKnown(state, owner) {
  const { seen, total } = obeliskProgress(state, owner);
  return total > 0 && seen >= total;
}

/**
 * Dig for the Grail (HoMM3's dig): it takes a WHOLE day, so the hero must still
 * have full movement; the dig then spends it. On the buried tile the hero
 * unearths the Grail (carried until enshrined at a town); anywhere else the day
 * is lost for nothing. Digging is possible without solving the puzzle — but you
 * only find it on the one true tile.
 */
export function digForGrail(state, hero) {
  if (state.grailDug) return { type: 'grail', ok: false, text: 'The Grail has already been unearthed.' };
  if ((hero.z ?? 0) !== 0) return { type: 'grail', ok: false, text: 'You can only dig on the surface.' };
  if (hero.mp < heroMaxMovement(hero)) {
    return { type: 'grail', ok: false, text: 'Digging takes a full day — return at the start of a turn with all your movement.' };
  }
  hero.mp = 0; // the dig consumes the whole day
  const grail = state.map.grail;
  if (grail && hero.x === grail.x && hero.y === grail.y) {
    hero.carryingGrail = true;
    state.grailDug = true;
    return { type: 'grail', ok: true, found: true,
      text: 'You unearth the Holy Grail! Carry it to one of your towns to raise its Grail structure.' };
  }
  return { type: 'grail', ok: true, found: false, text: 'You dig and dig, but the earth holds nothing here.' };
}

/**
 * Enshrine a carried Grail at one of the hero's OWN towns: raises the town's
 * Grail structure (`town.grail`), a permanent +growth blessing (applyWeeklyGrowth).
 * Consumes the carried Grail. Returns { ok } — the caller confirms + toasts.
 */
export function deliverGrail(state, hero, town) {
  if (!hero.carryingGrail || !town || town.owner !== hero.owner) return { ok: false };
  town.grail = true;
  hero.carryingGrail = false;
  state.grailTownId = town.id;
  logMsg(state, `The Holy Grail is enshrined at ${town.name} — its Grail structure rises.`);
  // In a "race for the Grail" game, raising the structure wins outright — settle
  // it now (a no-op in a conquest game, where victory.grail is false).
  checkVictory(state);
  return { ok: true, town };
}

/**
 * The weekly creature-growth multiplier a faction's Grail structure applies.
 * Every Grail gives GRAIL_GROWTH_MULT; a faction may override it with its own
 * signature growthMult (Inferno's swelling legions). See CONFIG.FACTION_GRAIL.
 */
export function grailGrowthMult(faction) {
  return CONFIG.FACTION_GRAIL[faction]?.growthMult ?? CONFIG.GRAIL_GROWTH_MULT;
}

/**
 * One human-readable line describing a faction's Grail blessing: the universal
 * +growth, plus its signature perk (gold / stronger growth / full mana). Shared
 * by the deliver dialog and the town header so both read the same rules.
 */
export function grailPerkText(faction) {
  const perk = CONFIG.FACTION_GRAIL[faction] || {};
  const growthPct = Math.round((grailGrowthMult(faction) - 1) * 100);
  const parts = [`+${growthPct}% weekly creature growth`];
  if (perk.gold) parts.push(`+${perk.gold} gold each day`);
  if (perk.fullMana) parts.push('heroes here wake with full mana');
  return parts.join(', ');
}

function applyBooster(state, hero, obj) {
  const t = obj.boosterType;
  const name = boosterName(t);
  // Mana wells are reusable; wayfarer's camps are reusable but at most once
  // per hero per day; the rest are once per hero.
  if (t === 'mana') {
    const max = heroMaxMana(hero);
    if (hero.mana >= max) return { type: 'visited', name, text: 'Your mana is already full.', noBenefit: true };
    hero.mana = max;
    return { type: 'visited', name, text: 'Your mana has been restored.' };
  }
  if (t === 'move') {
    // Per-hero daily record: { [objectId]: dayLastUsed }. A plain object on
    // the hero, so it round-trips save/load through the generic spread with
    // no migration; lazily created for heroes from pre-feature saves.
    if (!hero.boostDays) hero.boostDays = {};
    if (hero.boostDays[obj.id] === state.day) {
      return { type: 'visited', name, text: 'You have already rested here today.', noBenefit: true };
    }
    // Prune stale (past-day) entries so the record never outgrows one day.
    for (const k of Object.keys(hero.boostDays)) {
      if (hero.boostDays[k] < state.day) delete hero.boostDays[k];
    }
    hero.boostDays[obj.id] = state.day;
    hero.mp += CONFIG.MOVE_BOOST;
    return { type: 'visited', name, text: `+${CONFIG.MOVE_BOOST} movement today.` };
  }
  if (t === 'windmill' || t === 'waterWheel' || t === 'tradeFair') {
    // Weekly resource generator: the claim is recorded ON THE OBJECT (the week
    // it was last drained), so the FIRST hero to reach it each week collects it
    // and it stays empty for everyone until the next week — round-trips through
    // the generic object spread with no migration.
    const week = weekOf(state.day);
    if (obj.harvestedWeek === week) {
      const spent = { windmill: "The windmill's sails hang still — come back next week.",
        waterWheel: 'The wheel turns but yields nothing more this week.',
        tradeFair: 'The stalls are packed away — the fair returns next week.' };
      return { type: 'visited', name, noBenefit: true, text: spent[t] };
    }
    obj.harvestedWeek = week;
    const yielded = weeklySiteYield(state, t);
    grant(state.players[hero.owner], yielded);
    if (t === 'waterWheel') {
      return { type: 'visited', name, text: `The water wheel yields ${yielded.gold} gold.` };
    }
    if (t === 'tradeFair') {
      const goods = Object.entries(yielded).filter(([r]) => r !== 'gold').map(([r, n]) => `${n} ${r}`);
      return { type: 'visited', name, text: `The fair yields ${goods.join(', ')} and ${yielded.gold} gold.` };
    }
    const [res, amount] = Object.entries(yielded)[0];
    return { type: 'visited', name, text: `The windmill yields ${amount} ${res}.` };
  }
  if (t === 'magicSpring') {
    // Weekly, per-object (like the windmill): the spring dries up for everyone
    // until the next week once a hero drinks. Fills to a MULTIPLE of max mana.
    const week = weekOf(state.day);
    if (obj.harvestedWeek === week) {
      return { type: 'visited', name, text: 'The spring has run dry — it will well up again next week.', noBenefit: true };
    }
    obj.harvestedWeek = week;
    hero.mana = heroMaxMana(hero) * CONFIG.MAGIC_SPRING_MULT;
    return { type: 'visited', name, text: `The magic spring floods you with power — mana surges to ${hero.mana}.` };
  }
  if (t === 'hillFort') {
    // Reusable: upgrades every upgradeable stack in the hero's army. Low tiers
    // are free; higher tiers cost the creature price difference (skipped if the
    // player can't afford them). Naturally idempotent — a re-visit finds nothing
    // left to upgrade.
    const player = state.players[hero.owner];
    let upgraded = 0;
    for (const stack of hero.army) {
      if (!stack || stack.count <= 0) continue;
      const to = upgradeTargetOf(stack.creature);
      if (!to) continue;
      const tier = CREATURES[stack.creature].tier || 0;
      const cost = tier <= CONFIG.HILL_FORT_FREE_TIER ? {} : upgradeUnitCost(stack.creature, to, stack.count);
      if (!canAfford(player, cost)) continue;
      pay(player, cost);
      stack.creature = to;
      stack.hurt = Math.min(stack.hurt || 0, CREATURES[to].health - 1);
      upgraded += 1;
    }
    if (!upgraded) return { type: 'visited', name, text: 'The Hill Fort has nothing left to upgrade in your army.', noBenefit: true };
    return { type: 'visited', name, text: `The Hill Fort veterans upgrade ${upgraded} of your stacks.` };
  }
  if (hero.visited[obj.id]) {
    return { type: 'visited', name, text: 'You have already benefited from this place.', noBenefit: true };
  }
  // Marked BEFORE the branches, and un-marked at the bottom for any visit that gave
  // nothing — see the `noBenefit` clause at the end of this function.
  hero.visited[obj.id] = true;
  const events = [];
  let text = '';
  // `benefited` stays true unless a once-per-hero site turns out to have nothing
  // to give THIS hero (skill already known, spell already learned, tree maxed):
  // the caller uses !benefited to toast-and-continue rather than halt the march.
  let benefited = true;
  // …and `reversible` marks the refusals that may not stand forever, which are the
  // ones that must not spend the visit. See the bottom of this function.
  let reversible = false;
  // Named on the RESULT as well as in the prose, so the view can react to a stat
  // gain without reading English out of `text`. It is what the map plays the
  // `statup` sound on — "when a hero collects +1 on any of the stats, to have a
  // distinct sound effect as feedback" — and a UI that had to regex a sentence to
  // know it happened would break the first time the sentence was reworded.
  let statGain = null;
  if (['attack', 'defense', 'power', 'knowledge'].includes(t)) {
    hero.stats[t] += 1;
    statGain = t;
    text = `+1 ${t[0].toUpperCase()}${t.slice(1)} (permanent).`;
  } else if (t === 'xp') {
    text = `+${CONFIG.LEARNING_STONE_XP} experience.`;
    const lvls = gainXp(state, hero, CONFIG.LEARNING_STONE_XP);
    if (lvls > 0) events.push({ type: 'levelUp', heroId: hero.id });
  } else if (t === 'obelisk') {
    // A landmark that scouts the countryside AND turns the Grail puzzle: reveal
    // a generous disc + a one-time XP award, and record THIS obelisk against the
    // player's tally. Uncover every obelisk and the buried Grail's tile is
    // revealed. Per-hero visit gate above; per-PLAYER dedup here (so a second
    // hero re-reading the same stone doesn't advance the puzzle twice).
    revealAround(state, hero.owner, hero.x, hero.y, CONFIG.OBELISK_REVEAL, hero.z ?? 0);
    const lvls = gainXp(state, hero, CONFIG.OBELISK_XP);
    if (lvls > 0) events.push({ type: 'levelUp', heroId: hero.id });
    const player = state.players[hero.owner];
    if (!player.obeliskIds) player.obeliskIds = [];
    if (!player.obeliskIds.includes(obj.id)) player.obeliskIds.push(obj.id);
    const { seen, total } = obeliskProgress(state, hero.owner);
    if (total > 0 && seen >= total && state.map.grail && !player.grailKnown) {
      player.grailKnown = true;
      revealAround(state, hero.owner, state.map.grail.x, state.map.grail.y, 1, 0);
      text = `Every obelisk uncovered! The Grail lies buried at (${state.map.grail.x}, ${state.map.grail.y}). `
        + 'Send a hero there and Dig with a full day\'s movement.';
      events.push({ type: 'grailRevealed', x: state.map.grail.x, y: state.map.grail.y });
    } else {
      text = `The obelisk's carvings chart the countryside (+${CONFIG.OBELISK_XP} XP). `
        + `Obelisks uncovered: ${seen} of ${total}.`;
    }
  } else if (t === 'observatory') {
    // Charts a wide sweep of the map around it (once per hero, no XP). Revealing
    // is the ENTIRE benefit, so when the sweep is already charted — a second
    // hero following the first, or a tower reached late — there is nothing to
    // show, and stopping the march to say so is pure friction. noBenefit sends
    // it to the toast-and-walk-on path instead.
    const lit = revealAround(state, hero.owner, hero.x, hero.y, CONFIG.OBSERVATORY_REVEAL, hero.z ?? 0);
    if (lit === 0) {
      text = 'The lands below are already charted on your maps.';
      benefited = false;
    } else {
      text = 'From the high tower you chart a wide sweep of the surrounding lands.';
    }
  } else if (t === 'witchHut') {
    // Teaches the hut's fixed skill at Basic — unless the hero already has it
    // or has no room left in their 8 skill slots. Neither refusal spends the
    // visit: reported as "I didn't have place for tactics, so I forgot a skill,
    // but visiting the hut does not help me as it was visited unsuccessfully in
    // the past". A full hero who later frees a slot (the Hall of Reflection) can
    // come back and be taught — see the un-marking at the end of this function.
    const skill = obj.skill;
    const sName = SKILLS[skill]?.name || skill;
    if (hero.skills[skill]) {
      text = `The witch senses the ${sName} already in you — there is nothing to teach.`;
      benefited = false;
      reversible = true;
    } else if (Object.keys(hero.skills).length >= CONFIG.MAX_SECONDARY_SKILLS) {
      text = `You have mastered all ${CONFIG.MAX_SECONDARY_SKILLS} skills you can hold — the witch `
        + 'turns you away. Free a slot and she will teach you yet.';
      benefited = false;
      reversible = true;
    } else {
      hero.skills[skill] = 1;
      text = `The witch teaches you ${sName} (Basic).`;
    }
  } else if (t === 'shrine') {
    // Reveals the shrine's spell into the hero's spellbook (if not already known).
    const spell = obj.spell;
    const spName = SPELLS[spell]?.name || spell;
    if ((hero.spells || []).includes(spell)) {
      text = `You already know ${spName}.`;
      benefited = false;
    } else {
      if (!hero.spells) hero.spells = [];
      hero.spells.push(spell);
      text = `The shrine reveals the secret of ${spName}.`;
    }
  } else if (t === 'luck') {
    hero.tempLuck = Math.min(CONFIG.MORALE_LUCK_MAX, hero.tempLuck + 1);
    text = '+1 Luck until your next battle.';
  } else if (t === 'morale') {
    hero.tempMorale = Math.min(CONFIG.MORALE_LUCK_MAX, hero.tempMorale + 1);
    text = '+1 Morale until your next battle.';
  } else if (t === 'library') {
    // Library of Enlightenment: +LIBRARY_BONUS to ALL FOUR primaries, once per hero —
    // and only to a hero worth teaching. The level gate is HoMM3's and it is the point
    // of the building: it makes a library a REASON to bring your veteran across the
    // map rather than a pickup for whichever scout wandered past first.
    if ((hero.level || 1) < CONFIG.LIBRARY_MIN_LEVEL) {
      // Un-mark the visit. `hero.visited[obj.id]` is set ABOVE, before any branch —
      // returning early without clearing it would lock this hero out of the library
      // for the rest of the game for the crime of walking past it at level 9.
      delete hero.visited[obj.id];
      return {
        type: 'visited',
        name,
        text: `The librarians turn ${hero.name} away — they teach no one below level `
          + `${CONFIG.LIBRARY_MIN_LEVEL}. Come back a veteran.`,
        noBenefit: true,
      };
    }
    for (const st of ['attack', 'defense', 'power', 'knowledge']) hero.stats[st] += CONFIG.LIBRARY_BONUS;
    text = `+${CONFIG.LIBRARY_BONUS} to Attack, Defense, Power and Knowledge (permanent).`;
  } else if (t === 'treeOfKnowledge') {
    // Tree of Knowledge: grants a full level, once per hero. Award exactly the
    // experience to the next level boundary (gainXp then rolls the level-up,
    // stat gain and skill choice). A hero already at the cap learns nothing.
    const nextXp = XP_TABLE[hero.level + 1];
    if (nextXp === undefined) {
      text = 'You have already learned all this ancient tree can teach.';
      benefited = false;
    } else {
      const lvls = gainXp(state, hero, Math.max(1, nextXp - hero.xp));
      if (lvls > 0) events.push({ type: 'levelUp', heroId: hero.id });
      text = `The Tree of Knowledge grants you wisdom — you rise to level ${hero.level}.`;
    }
  }
  // A REFUSAL THAT CAN BE REVERSED DOES NOT SPEND THE VISIT.
  //
  // `hero.visited[obj.id]` is stamped above, before any branch, so a hero the witch
  // turned away used to be locked out of that hut for the rest of the game — the
  // reported "I forgot a skill, but visiting does not help me as [it] was visited
  // unsuccessfully in the past". Both of her refusals are about a hero property
  // that CHANGES (a full skillset, and a skill already held — the Hall of
  // Reflection can undo either), and neither branch mutates anything on the way to
  // `benefited = false`, so re-running one costs nothing and starts being generous
  // the day the hero qualifies. The Library does the same by hand for its level
  // gate.
  //
  // Deliberately NOT the general rule for every no-benefit visit: a shrine's spell
  // cannot be unlearned, a level cap cannot be un-reached, and an observatory's
  // sweep cannot become uncharted, so those stay spent — and a site that reads
  // "worth a look" forever is how an AI hero ends up shuttling between two of them
  // (see the Magic Well note in boosterSpent).
  if (!benefited && reversible) delete hero.visited[obj.id];
  return { type: 'visited', name, text, events, statGain, noBenefit: !benefited };
}

/** Chest choice resolution (from the dialog). */
/** Roll a treasure chest's contents from CONFIG: a gold amount, or that gold
 *  minus a fixed penalty taken as experience instead. Shared by the on-foot
 *  pickup and the won-under-a-guard path so they can never drift apart. */
export function rollChestContents(state) {
  // Weighted tier, not a flat pick: mostly pocket change, rarely a hoard. See
  // CONFIG.CHEST_GOLD_TIERS for why the old 1000/1500/2000 read as one prize.
  const gold = rollWeightedGold(state.rng, CONFIG.CHEST_GOLD_TIERS);
  return { gold, xp: Math.round((gold - CONFIG.CHEST_XP_PENALTY) * CONFIG.XP_PER_GOLD) };
}

export function resolveChest(state, hero, objectId, choice) {
  const obj = getObject(state, objectId);
  if (!obj) return 0; // already claimed (e.g. resolved elsewhere) — no double payout
  // Read the contents STASHED at roll time; never trust a caller-supplied amount
  // (roll defensively if somehow unstashed, e.g. a hand-built object).
  const { gold, xp } = obj.chest || rollChestContents(state);
  removeObject(state, obj);
  if (choice === 'gold') {
    grant(state.players[hero.owner], { gold });
    return 0;
  }
  return gainXp(state, hero, xp);
}

// ---- Seer Huts (fetch-quest visitables) -----------------------------------
// A Seer Hut carries a fetch quest fixed at generation: bring the tribute it
// asks for and claim a one-time reward. The claim is GLOBAL — once any hero
// completes it (`obj.done`), the seer has nothing left to give. `quest`/`reward`
// are plain nested objects, so the whole thing round-trips through the generic
// object save spread with no version bump.
//
// v1 quests ask for RESOURCES (always fulfillable — the player can gather them);
// rewards are gold / experience / an artifact. Artifact-FETCH quests are a v2
// (they need the required artifact guaranteed-placed on the map to pair with).

/** Human-readable tribute a Seer Hut quest asks for (e.g. "10 ore"). */
export function seerQuestText(quest) {
  if (quest?.kind === 'resource') {
    return quest.res === 'gold' ? `${quest.amount} gold` : `${quest.amount} ${quest.res}`;
  }
  return 'nothing';
}

/** The sealed-promise line a Seer Hut shows BEFORE the tribute is paid — the
 *  actual reward stays hidden until then, so a hut is a gamble, never a visibly
 *  bad bargain. seerRewardText() reveals the real reward once it's claimed. */
export const SEER_REWARD_TEASER = 'a reward worthy of your tribute';

/** Human-readable reward a Seer Hut grants (revealed only after fulfilling). */
export function seerRewardText(reward) {
  if (reward?.kind === 'resource') {
    return reward.res === 'gold' ? `${reward.amount} gold` : `${reward.amount} ${reward.res}`;
  }
  if (reward?.kind === 'xp') return `${reward.amount} experience`;
  if (reward?.kind === 'artifact') return ARTIFACTS[reward.artifact]?.name || 'an artifact';
  if (reward?.kind === 'creatures') {
    const nm = CREATURES[reward.creature]?.name || reward.creature;
    return `${reward.count} ${nm}${reward.count === 1 ? '' : 's'}`;
  }
  return 'nothing';
}

/** Does this hero's player currently hold what a Seer Hut quest asks for?
 *  Exported so the AI's decision to march on a hut and the hut's own refusal
 *  cannot come to disagree about what "can pay" means. */
export function seerQuestMet(state, hero, quest) {
  if (quest?.kind === 'resource') {
    return canAfford(state.players[hero.owner], { [quest.res]: quest.amount });
  }
  return false;
}

/**
 * Visit a Seer Hut. Never resolves by itself — the caller shows the quest and,
 * when the tribute is in hand, a Fulfill button that calls fulfillSeerQuest.
 */
function visitSeerHut(state, hero, obj) {
  if (obj.done) return { type: 'seerHut', objectId: obj.id, done: true };
  return {
    type: 'seerHut',
    objectId: obj.id,
    done: false,
    canFulfill: seerQuestMet(state, hero, obj.quest),
    questText: seerQuestText(obj.quest),
    // The reward is a SEALED promise — revealed only when the tribute is paid
    // (fulfillSeerQuest returns the real reward for the reveal). Kept honest by
    // the generator, which always makes it worth clearly more than the tribute.
    rewardText: SEER_REWARD_TEASER,
  };
}

/**
 * Complete a Seer Hut quest (from the dialog): pay the tribute, grant the
 * reward, mark the hut done. Returns { ok, levels, reward } — `levels` is any
 * level-ups from an XP reward — or { ok:false } if it can no longer be met.
 */
export function fulfillSeerQuest(state, hero, objectId) {
  const obj = getObject(state, objectId);
  if (!obj || obj.type !== 'seerHut' || obj.done) return { ok: false };
  if (!seerQuestMet(state, hero, obj.quest)) return { ok: false };
  // A warband needs somewhere to stand, and this is the ONE reward path that
  // charges before it pays. It used to call addToArmy and discard the answer, so
  // a hero with seven full stacks paid the tribute, watched the hut close, and
  // received nothing. Refuse before taking anything; the hut stays open for a
  // hero with room. Checked here rather than in seerQuestMet on purpose — the
  // reward is a sealed promise until the tribute is offered, and gating the
  // button would tell the player it is creatures before they ever accept.
  if (obj.reward?.kind === 'creatures' && !canAddToArmy(hero.army, obj.reward.creature)) {
    return { ok: false, reason: 'armyFull' };
  }
  const player = state.players[hero.owner];
  if (obj.quest.kind === 'resource') pay(player, { [obj.quest.res]: obj.quest.amount });
  const r = obj.reward;
  let levels = 0;
  if (r.kind === 'resource') grant(player, { [r.res]: r.amount });
  else if (r.kind === 'xp') levels = gainXp(state, hero, r.amount);
  else if (r.kind === 'artifact') giveArtifact(state, hero, r.artifact);
  else if (r.kind === 'creatures') addToArmy(hero.army, r.creature, r.count); // guaranteed to fit, checked above
  obj.done = true;
  markForRespawn(state, obj);
  return { ok: true, levels, reward: r };
}

// ---- Trading Post (adventure-map visitable) -------------------------------
// A merchant's stall: SELL any of your artifacts for experience (HoMM3's Altar
// of Sacrifice), or BUY an artifact from the post's stock for resources. Reusable
// — no `done` flag: selling strips the item from the hero, buying removes it from
// the stock. All prices derive from ARTIFACTS[id].value (1..4). `stock` is an
// array of artifact ids rolled at generation, round-tripping through the save.
const TRADE_SELL_XP_PER_VALUE = 27000; // experience per artifact value point, sold [was 1500]

/** Experience a hero gains for selling `artifactId` at a trading post. */
export function tradingPostSellXp(artifactId) {
  return (ARTIFACTS[artifactId]?.value || 1) * TRADE_SELL_XP_PER_VALUE;
}

/** Resource cost to BUY `artifactId` from a trading post (gold + a little gems). */
export function tradingPostBuyCost(artifactId) {
  return artifactBandCost(ARTIFACTS[artifactId]?.value || 1);
}

/**
 * The same price quoted as a single gold-equivalent (rares at the market's base
 * rate). For valuing an artifact nobody has drawn yet — a creature bank's reward
 * is a BAND, not an id, so the AI cannot look one up. Routed through
 * artifactBandCost so the shop and the AI cannot come to disagree about what a
 * relic is worth.
 */
export function artifactBandValue(v) {
  const c = artifactBandCost(v);
  return c.gold + c.gems * (MARKET_RATES.sell.gems || 0);
}

/** Strip one artifact (by id) from a hero — worn socket or backpack — reclamping
 *  movement/mana pools. Returns true if it was held. */
function removeArtifactFromHero(hero, artifactId) {
  const before = heroPoolCaps(hero);
  for (const socket of Object.keys(hero.equipment || {})) {
    if (hero.equipment[socket] === artifactId) {
      hero.equipment[socket] = null;
      syncHeroPools(hero, before);
      return true;
    }
  }
  const bi = (hero.backpack || []).indexOf(artifactId);
  if (bi >= 0) { hero.backpack.splice(bi, 1); syncHeroPools(hero, before); return true; }
  return false;
}

/** Everything the hero could SELL here (worn + carried), each with its XP price. */
function heroSellableArtifacts(hero) {
  const ids = [...Object.values(hero.equipment || {}).filter(Boolean), ...(hero.backpack || [])];
  return ids.map((id) => ({ id, name: ARTIFACTS[id]?.name || id, xp: tradingPostSellXp(id) }));
}

/** Visit a Trading Post: hand the view the hero's sellable artifacts and the
 *  post's stock (with prices). Resolved by sellArtifactForXp / buyArtifactAt. */
function visitTradingPost(state, hero, obj) {
  return {
    type: 'tradingPost',
    objectId: obj.id,
    sellable: heroSellableArtifacts(hero),
    stock: (obj.stock || []).map((id) => ({
      id, name: ARTIFACTS[id]?.name || id, desc: ARTIFACTS[id]?.desc || '', cost: tradingPostBuyCost(id),
    })),
  };
}

/** Sell one of the hero's artifacts for experience. Returns { ok, xp, levels }. */
export function sellArtifactForXp(state, hero, artifactId) {
  if (!removeArtifactFromHero(hero, artifactId)) return { ok: false };
  const xp = tradingPostSellXp(artifactId);
  const levels = gainXp(state, hero, xp);
  logMsg(state, `${hero.name} traded ${ARTIFACTS[artifactId]?.name || 'an artifact'} for ${xp} experience.`);
  return { ok: true, xp, levels, artifact: artifactId };
}

/** Sell SEVERAL of the hero's artifacts in one act (the trading-post "altar":
 *  stage a set, then finalise with one button). `artifactIds` is a flat list —
 *  a repeated id sells that many instances (each removeArtifactFromHero strips
 *  one). XP is summed and awarded once so a batch that crosses a level boundary
 *  rolls the level-up cleanly. Returns { ok, xp, count, levels, sold }. */
export function sellArtifactsForXp(state, hero, artifactIds) {
  let xp = 0;
  const sold = [];
  for (const id of artifactIds || []) {
    if (removeArtifactFromHero(hero, id)) { xp += tradingPostSellXp(id); sold.push(id); }
  }
  if (!sold.length) return { ok: false, xp: 0, count: 0, levels: 0, sold };
  const levels = gainXp(state, hero, xp);
  logMsg(state, `${hero.name} sacrificed ${sold.length} artifact${sold.length > 1 ? 's' : ''} for ${xp} experience.`);
  return { ok: true, xp, count: sold.length, levels, sold };
}

/** Buy an artifact from a post's stock for resources. Returns { ok, cost } or a
 *  { ok:false, reason }. Removes the item from the stock on success. */
export function buyArtifactAt(state, hero, objectId, artifactId) {
  const obj = getObject(state, objectId);
  if (!obj || obj.type !== 'tradingPost') return { ok: false };
  const idx = (obj.stock || []).indexOf(artifactId);
  if (idx < 0) return { ok: false, reason: 'sold out' };
  const cost = tradingPostBuyCost(artifactId);
  const player = state.players[hero.owner];
  if (!canAfford(player, cost)) return { ok: false, reason: 'cannot afford' };
  pay(player, cost);
  giveArtifact(state, hero, artifactId);
  obj.stock.splice(idx, 1);
  logMsg(state, `${hero.name} bought ${ARTIFACTS[artifactId]?.name || 'an artifact'} from the trading post.`);
  return { ok: true, artifact: artifactId, cost };
}

/** Fresh { sellable, stock } for a post — the dialog re-reads this after each
 *  trade so prices and remaining stock stay live. */
export function tradingPostView(state, hero, objectId) {
  const obj = getObject(state, objectId);
  if (!obj || obj.type !== 'tradingPost') return { sellable: [], stock: [] };
  return visitTradingPost(state, hero, obj);
}

function removeObject(state, obj) {
  // Ids carry their level ('O…' surface, 'U…' underground — see mapgen's
  // placeObject), so the object names the tile grid and dictionary it lives in.
  const level = obj.id.startsWith('U') ? 1 : 0;
  const t = tileAt(state, obj.x, obj.y, level);
  if (t && t.objectId === obj.id) t.objectId = null;
  const m = level ? state.map.underground : state.map;
  if (m) delete m.objects[obj.id];
}

/** Drop a boat on a (water) tile — left behind when a hero disembarks. */
function placeBoat(state, x, y) {
  const t = tileAt(state, x, y);
  if (!t || t.objectId) return null; // never overwrite an existing object
  const id = nextObjectId(state);
  const boat = { id, x, y, type: 'boat' };
  state.map.objects[id] = boat;
  t.objectId = id;
  return boat;
}

/**
 * A defeated hero who was aboard a boat leaves it drifting where they sank —
 * an empty derelict any hero can later claim (naval v2). No-op for a land
 * hero, or if the tile is somehow occupied. Called just before removeHero (the
 * boat is carried as hero.onBoat, so the water tile itself holds no object yet).
 */
function leaveDerelictBoat(state, hero) {
  if (hero && hero.onBoat) placeBoat(state, hero.x, hero.y);
}

// ===========================================================================
// SHIPYARDS (build a boat on demand)
// ===========================================================================

/**
 * The shipyard's free dock: the first orthogonally adjacent water tile with no
 * object and no hero on it, in fixed E/W/S/N order (deterministic). A boat
 * spawned here is boardable from the shipyard tile in one straight step.
 * Returns { x, y } or null. Shipyards are surface-only, so this reads level 0.
 */
export function shipyardDockTile(state, shipyard) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = shipyard.x + dx, y = shipyard.y + dy;
    const t = tileAt(state, x, y);
    if (t && t.terrain === 'water' && !t.objectId && !heroAt(state, x, y, 0)) return { x, y };
  }
  return null;
}

/**
 * Can `player` have a boat built at `shipyard` right now?
 * Returns { ok: true, dock } or { ok: false, reason } with reason one of:
 *   'boatAtDock' — a boat already waits beside the yard (board it instead),
 *   'noDock'     — no adjacent free water tile to spawn on,
 *   'cost'       — the player cannot afford CONFIG.BOAT_COST.
 * Pure check, never throws; used by the shipyard step event, buildBoat and
 * the AI's valuation, so all three always agree.
 */
export function shipyardBuildCheck(state, player, shipyard) {
  // A boat already docked (any of the 8 neighbours) makes a build redundant.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const o = objectAt(state, shipyard.x + dx, shipyard.y + dy, 0);
      if (o && o.type === 'boat') return { ok: false, reason: 'boatAtDock' };
    }
  }
  const dock = shipyardDockTile(state, shipyard);
  if (!dock) return { ok: false, reason: 'noDock' };
  if (!canAfford(player, CONFIG.BOAT_COST)) return { ok: false, reason: 'cost' };
  return { ok: true, dock };
}

/**
 * Build a boat at a shipyard: pay CONFIG.BOAT_COST and place a boat on the
 * yard's free dock tile. The hero must be on foot, on the surface, standing on
 * or beside the shipyard (the UI calls this after the 'shipyard' step event;
 * the AI calls it directly on arrival). Every failure is a graceful event —
 * this never throws and never charges without delivering:
 *   { type: 'boatBuilt', shipyardId, x, y, cost }      — success
 *   { type: 'boatBuildFailed', reason }                — refusal
 * reason: 'noShipyard' | 'notHere' | 'boatAtDock' | 'noDock' | 'cost'.
 * `shipyardOrId` accepts the object or its id (as carried by the step event).
 */
export function buildBoat(state, hero, shipyardOrId) {
  const shipyard = typeof shipyardOrId === 'string' ? getObject(state, shipyardOrId) : shipyardOrId;
  if (!shipyard || shipyard.type !== 'shipyard') return { type: 'boatBuildFailed', reason: 'noShipyard' };
  const near = Math.max(Math.abs(hero.x - shipyard.x), Math.abs(hero.y - shipyard.y)) <= 1;
  if (hero.onBoat || (hero.z ?? 0) !== 0 || !near) return { type: 'boatBuildFailed', reason: 'notHere' };
  const player = state.players[hero.owner];
  const check = shipyardBuildCheck(state, player, shipyard);
  if (!check.ok) return { type: 'boatBuildFailed', reason: check.reason };
  pay(player, CONFIG.BOAT_COST);
  const boat = placeBoat(state, check.dock.x, check.dock.y);
  if (!boat) { // dock verified free above — pure defense; refund, never charge for nothing
    grant(player, CONFIG.BOAT_COST);
    return { type: 'boatBuildFailed', reason: 'noDock' };
  }
  logMsg(state, `${hero.name} had a boat built at the shipyard.`);
  return { type: 'boatBuilt', shipyardId: shipyard.id, x: boat.x, y: boat.y, cost: { ...CONFIG.BOAT_COST } };
}

// ===========================================================================
// TOWN SHIPYARD (the Shipyard BUILDING — build boats from the home port)
// ===========================================================================

/**
 * The fixed scan order for a town's waterfront: ring 1 then ring 2 around the
 * town square, each ring listing its orthogonals first in the same E/W/S/N
 * order as shipyardDockTile, then the remaining ring tiles row-major (top-left
 * to bottom-right). A town is a single-tile object but visually spans a
 * footprint, so "its coast" is anything within Chebyshev distance 2.
 * townIsCoastal, townDockTile and townShipyardBuildCheck all read THIS list,
 * so the three can never disagree about what counts as the town's water.
 */
const TOWN_COAST_SCAN = (() => {
  const scan = [];
  for (let r = 1; r <= 2; r++) {
    scan.push([r, 0], [-r, 0], [0, r], [0, -r]);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // this ring only
        if (dx === 0 || dy === 0) continue; // orthogonals already listed
        scan.push([dx, dy]);
      }
    }
  }
  return scan;
})();

/**
 * Does this town border water (Chebyshev distance ≤ 2 on its own level)?
 * Gates the Shipyard building (`coastal: true` in the catalog). Water exists
 * only on the surface, so underground towns never qualify — that falls out of
 * the terrain scan naturally rather than by a special case.
 */
export function townIsCoastal(state, town) {
  const z = town.z ?? 0;
  for (const [dx, dy] of TOWN_COAST_SCAN) {
    const t = tileAt(state, town.x + dx, town.y + dy, z);
    if (t && t.terrain === 'water') return true;
  }
  return false;
}

/**
 * The town's free dock: the first object-free, hero-free water tile in the
 * fixed TOWN_COAST_SCAN order — deterministic, like shipyardDockTile, just
 * widened to radius 2 because a town square need not touch water orthogonally.
 * Returns { x, y } or null (coastal towns can still dock-starve when every
 * near-water tile is occupied). Boats sail the surface only.
 */
export function townDockTile(state, town) {
  if ((town.z ?? 0) !== 0) return null; // no water underground, ever
  for (const [dx, dy] of TOWN_COAST_SCAN) {
    const x = town.x + dx, y = town.y + dy;
    const t = tileAt(state, x, y);
    if (t && t.terrain === 'water' && !t.objectId && !heroAt(state, x, y, 0)) return { x, y };
  }
  return null;
}

/**
 * Can a boat be built at `town`'s own Shipyard building right now?
 * Returns { ok: true, dock } or { ok: false, reason } with reason one of:
 *   'noShipyard' — the town has not built the Shipyard,
 *   'boatAtDock' — a boat already floats on the town's near-water (redundant),
 *   'noDock'     — no free water tile within the town's coast scan,
 *   'cost'       — the owner cannot afford CONFIG.BOAT_COST.
 * Pure check, never throws; backs buildBoatAtTown, the town screen's Build
 * Boat button and the AI's valuation, so all three always agree — the same
 * three-way contract as shipyardBuildCheck for map yards.
 */
export function townShipyardBuildCheck(state, town) {
  if (!town.buildings.includes('shipyard')) return { ok: false, reason: 'noShipyard' };
  for (const [dx, dy] of TOWN_COAST_SCAN) {
    const o = objectAt(state, town.x + dx, town.y + dy, 0);
    if (o && o.type === 'boat') return { ok: false, reason: 'boatAtDock' };
  }
  const dock = townDockTile(state, town);
  if (!dock) return { ok: false, reason: 'noDock' };
  const player = state.players[town.owner];
  if (!player || !canAfford(player, CONFIG.BOAT_COST)) return { ok: false, reason: 'cost' };
  return { ok: true, dock };
}

/**
 * Build a boat from a town's own Shipyard building: pay CONFIG.BOAT_COST and
 * place a boat on the town's free dock tile. Unlike a map yard no hero is
 * involved — the town itself launches the boat (any hero who walks to the
 * coast boards it via the ordinary embark path). Graceful exactly like
 * buildBoat — never throws, never charges without delivering:
 *   { type: 'boatBuilt', townId, x, y, cost }   — success
 *   { type: 'boatBuildFailed', reason }         — refusal (see
 *                                                 townShipyardBuildCheck)
 */
export function buildBoatAtTown(state, town) {
  const check = townShipyardBuildCheck(state, town);
  if (!check.ok) return { type: 'boatBuildFailed', reason: check.reason };
  const player = state.players[town.owner];
  pay(player, CONFIG.BOAT_COST);
  const boat = placeBoat(state, check.dock.x, check.dock.y);
  if (!boat) { // dock verified free above — pure defense; refund, never charge for nothing
    grant(player, CONFIG.BOAT_COST);
    return { type: 'boatBuildFailed', reason: 'noDock' };
  }
  logMsg(state, `${town.name} launched a boat from its shipyard.`);
  return { type: 'boatBuilt', townId: town.id, x: boat.x, y: boat.y, cost: { ...CONFIG.BOAT_COST } };
}

// ===========================================================================
// XP, LEVELS, SKILLS
// ===========================================================================

/**
 * Grant XP; for each level gained, raise a class-weighted primary stat and
 * queue a secondary-skill choice. Returns number of levels gained.
 */
export function gainXp(state, hero, xp) {
  hero.xp += Math.max(0, Math.round(xp));
  const target = levelForXp(hero.xp);
  let gained = 0;
  while (hero.level < target) {
    hero.level++;
    gained++;
    const cls = HERO_CLASSES[hero.class];
    const stat = weightedStat(state, cls.growth);
    hero.stats[stat] += 1;
    const choice = rollSkillChoice(state, hero);
    if (choice.options.length) {
      hero.pendingSkillChoices = hero.pendingSkillChoices || [];
      hero.pendingSkillChoices.push(choice);
    }
    // Queue the level for the player's level-up screen: which primary rose, and
    // whether a skill choice rides with it (so the view pairs them correctly even
    // when only SOME levels in a multi-level gain offered a skill). Recorded for
    // human heroes only — an AI hero would just accumulate unread entries in the
    // save. A skill-capped hero still gets an entry, so reaching a level is never
    // silent, which matters at a level cap of 74.
    if (state.players?.[hero.owner]?.isHuman) {
      hero.pendingLevelUps = hero.pendingLevelUps || [];
      hero.pendingLevelUps.push({ level: hero.level, stat, choice: choice.options.length > 0 });
    }
  }
  if (gained) logMsg(state, `${hero.name} reached level ${hero.level}!`);
  return gained;
}

function weightedStat(state, weights) {
  let roll = state.rng.random() * 100;
  for (const stat of ['attack', 'defense', 'power', 'knowledge']) {
    roll -= weights[stat];
    if (roll <= 0) return stat;
  }
  return 'knowledge';
}

/** Two options: upgrade an existing skill and/or learn a new one. */
function rollSkillChoice(state, hero) {
  const upgradable = Object.keys(hero.skills).filter((s) => hero.skills[s] < 3);
  const knownCount = Object.keys(hero.skills).length;
  const learnable = knownCount >= CONFIG.MAX_SECONDARY_SKILLS ? []
    : Object.keys(SKILLS).filter((s) => !hero.skills[s]);
  const options = [];
  if (upgradable.length) {
    const s = state.rng.pick(upgradable);
    options.push({ skill: s, toLevel: hero.skills[s] + 1 });
  }
  if (learnable.length) {
    let s = state.rng.pick(learnable);
    // Avoid offering the same skill twice.
    if (options.length && options[0].skill === s && learnable.length > 1) {
      s = state.rng.pick(learnable.filter((x) => x !== options[0].skill));
    }
    options.push({ skill: s, toLevel: 1 });
  }
  return { options };
}

/** Apply the player's (or AI's) pick for the oldest pending level-up.
 *
 * Re-validates against the CURRENT skills: a multi-level burst (e.g. a Pandora XP
 * dump) queues several choices rolled against the same stale snapshot, so an
 * earlier applied pick may have since learned a new skill or raised a level.
 * Without re-checking, a later pick could exceed the skill cap or re-set a level
 * it already holds. Take the requested option if it still helps, else the other,
 * else grant nothing — never break the cap. */
export function chooseSkill(state, hero, optionIndex) {
  const pending = hero.pendingSkillChoices?.shift();
  if (!pending) return;
  const atCap = Object.keys(hero.skills).length >= CONFIG.MAX_SECONDARY_SKILLS;
  const usable = (opt) => {
    if (!opt) return null;
    const cur = hero.skills[opt.skill] || 0;
    if (cur === 0) return atCap ? null : { skill: opt.skill, toLevel: 1 }; // new skill: only if there's room
    if (cur >= 3) return null;                                             // already mastered
    return { skill: opt.skill, toLevel: cur + 1 };                         // upgrade to the REAL next level
  };
  const chosen = pending.options[optionIndex] ?? pending.options[0];
  for (const opt of [chosen, ...pending.options.filter((o) => o !== chosen)]) {
    const v = usable(opt);
    if (v) { hero.skills[v.skill] = v.toLevel; return; }
  }
}

// ===========================================================================
// ARTIFACTS
// ===========================================================================

/** Snapshot the derived pool caps before an equipment change. */
function heroPoolCaps(hero) {
  return { mp: heroMaxMovement(hero), mana: heroMaxMana(hero) };
}

/**
 * Re-derive the hero's LIVE movement/mana after an equipment change so a
 * movement or mana artifact helps — and its removal costs — the same day, not
 * only after the next daily refresh: the SIGNED change in each cap is applied
 * to the current pool. Equipping Boots of Speed lengthens the remaining path
 * immediately (as the README promises), unequipping shortens it symmetrically,
 * so equip/unequip cycling nets exactly zero (no farming) — the two deltas
 * cancel by construction, which is the whole anti-farming argument, so no
 * clamp is needed to enforce it.
 *
 * NO upper clamp, and no touch at all when a cap did not move. The engine
 * deliberately pushes pools ABOVE their caps — the Magic Spring fills mana to
 * MAGIC_SPRING_MULT × max, a Wayfarer's Camp adds MOVE_BOOST movement, Stables
 * add their bonus — and advanceDay's regen goes out of its way to preserve
 * exactly those surpluses (see its max(current, …) comment). An earlier version
 * of this function clamped both pools to [0, newMax]: when the artifact touched
 * neither cap the expression degenerated to a plain min(cap, pool), so picking
 * up ANY artifact silently confiscated the over-cap bonus a site had just paid
 * out (a spring-filled hero came back to base mana; 1500 camp movement vanished
 * mid-march). With a surplus standing, even an equip/unequip cycle destroyed it
 * — the clamp bit on the way down, making the "symmetry" a one-way ratchet.
 * The only clamp that survives is the floor at 0 (a cap can drop below what
 * was already spent). Worked example, pinned by tests/core.test.js: mp 3600
 * over cap 2100, equip +300 boots → 3900, unequip → 3600 — net zero, surplus
 * intact, and nothing was farmed.
 */
function syncHeroPools(hero, before) {
  const dMp = heroMaxMovement(hero) - before.mp;
  const dMana = heroMaxMana(hero) - before.mana;
  // `?? before.*`: an unset pool reads as "was full", so applying the delta
  // lands it exactly at the new cap — the same answer the old code gave.
  if (dMp) hero.mp = Math.max(0, (hero.mp ?? before.mp) + dMp);
  if (dMana) hero.mana = Math.max(0, (hero.mana ?? before.mana) + dMana);
}

/** Auto-equip into a free matching socket, else backpack. */
export function giveArtifact(state, hero, artifactId) {
  const art = ARTIFACTS[artifactId];
  const before = heroPoolCaps(hero);
  for (const socket of Object.keys(EQUIP_SOCKETS)) {
    if (EQUIP_SOCKETS[socket] === art.slot && !hero.equipment[socket]) {
      hero.equipment[socket] = artifactId;
      syncHeroPools(hero, before); // a picked-up Boots/mana artifact helps today
      return socket;
    }
  }
  hero.backpack.push(artifactId);
  return null;
}

export function equipArtifact(state, hero, backpackIndex, socket) {
  const artifactId = hero.backpack[backpackIndex];
  if (!artifactId) return false;
  const art = ARTIFACTS[artifactId];
  if (EQUIP_SOCKETS[socket] !== art.slot) return false;
  const before = heroPoolCaps(hero);
  const prev = hero.equipment[socket];
  hero.equipment[socket] = artifactId;
  hero.backpack.splice(backpackIndex, 1);
  if (prev) hero.backpack.push(prev);
  syncHeroPools(hero, before);
  return true;
}

export function unequipArtifact(state, hero, socket) {
  const artifactId = hero.equipment[socket];
  if (!artifactId) return false;
  const before = heroPoolCaps(hero);
  hero.equipment[socket] = null;
  hero.backpack.push(artifactId);
  syncHeroPools(hero, before);
  return true;
}

/**
 * Trade an artifact from one hero to another when they meet. `source` is
 * `{ equip: socket }` (worn) or `{ backpack: index }` (carried). The artifact
 * leaves `from` — unequipped if worn, so its movement/mana caps reclamp — and
 * is handed to `to` via giveArtifact (auto-equipped into a free matching socket,
 * else dropped in their backpack, reclamping `to` too). Returns the artifactId
 * moved, or null if the source held nothing. `from` and `to` must differ.
 */
export function giveArtifactToHero(state, from, to, source) {
  if (!from || !to || from === to || !source) return null;
  let artifactId = null;
  if (source.equip != null) {
    artifactId = from.equipment[source.equip];
    if (!artifactId) return null;
    const before = heroPoolCaps(from);
    from.equipment[source.equip] = null;
    syncHeroPools(from, before); // losing a worn Boots/mana artifact costs today
  } else if (source.backpack != null) {
    artifactId = from.backpack[source.backpack];
    if (!artifactId) return null;
    from.backpack.splice(source.backpack, 1); // carried, not worn — caps unchanged
  } else {
    return null;
  }
  giveArtifact(state, to, artifactId);
  return artifactId;
}

// ===========================================================================
// TOWN: BUILDING
// ===========================================================================

/** Why can't `buildingId` be built right now? Returns null if it CAN. */
export function buildBlockReason(state, town, buildingId) {
  const catalog = buildingCatalog(town.faction);
  const b = catalog[buildingId];
  if (!b) return 'Unknown building';
  if (town.buildings.includes(buildingId)) return 'Already built';
  if (b.feature && !featureOn(state, b.feature)) return 'That feature is disabled for this game';
  if (town.builtToday) return 'Already built today';
  // The finer-grained successor, enforced at the SAME gate rather than bolted on
  // beside it later: `builtToday` bars a second build anywhere in the town for
  // the day, a write-lock bars only the building actually being worked on. No
  // build job exists yet — construction is still instant and still one per town
  // per day — so this is inert today. It is here now because a lock introduced
  // at a different choke point than the boolean it replaces is how two rules
  // that were meant to be one end up disagreeing.
  const underway = jobHoldingLock(state, townBuildLock(town.id, buildingId));
  if (underway) return 'Already under construction';
  for (const req of b.requires) {
    if (!town.buildings.includes(req)) return `Requires ${catalog[req]?.name || req}`;
  }
  // Before the affordability check, so a landlocked town reads the real
  // blocker ('Requires a coast'), not a misleading 'Not enough resources'.
  if (b.coastal && !townIsCoastal(state, town)) return 'Requires a coast';
  if (b.onePerPlayer) {
    const dupe = playerTowns(state, town.owner).some((t) => t.buildings.includes(buildingId));
    if (dupe) return 'Only one per realm';
  }
  const player = state.players[town.owner];
  if (!canAfford(player, b.cost)) return 'Not enough resources';
  return null;
}

export function buildStructure(state, town, buildingId) {
  if (buildBlockReason(state, town, buildingId)) return false;
  const catalog = buildingCatalog(town.faction);
  const b = catalog[buildingId];
  pay(state.players[town.owner], b.cost);
  town.buildings.push(buildingId);
  town.builtToday = true;

  // New base dwellings open with one week of stock.
  if (b.dwellingTier && !b.dwellingUpgrade) {
    const { base } = creaturesOfTier(town.faction, b.dwellingTier);
    town.available[b.dwellingTier] =
      (town.available[b.dwellingTier] || 0) + (CREATURES[base]?.growth || 0);
  }
  // Mage guilds roll their spells the moment they are built.
  if (b.guildLevel) {
    rollGuildSpells(state, town, b.guildLevel);
    const visiting = town.visitingHeroId ? state.heroes[town.visitingHeroId] : null;
    if (visiting) learnGuildSpells(state, town, visiting);
  }
  logMsg(state, `${town.name} built ${b.name}.`);
  return true;
}


/**
 * What FINISHES a job, by kind — the half of the job system that knows what a
 * job is for. Injected into `tickJobs` because core/jobs.js must not import this
 * module back (§2.4), and because a scheduler that knows what it is scheduling
 * is a scheduler you cannot add a second kind of work to.
 *
 * A handler runs exactly once, on the day the last crew-day lands, with the job
 * still in hand. It must not draw rng and must not fail: the cost was taken when
 * the job was queued, so there is nothing left to refuse.
 */
const JOB_EFFECTS = {
  upgradeNode: (state, job) => {
    const player = state.players[job.owner];
    if (!player) return;
    if (!(player.upgrades ?? []).includes(job.target)) {
      player.upgrades = [...(player.upgrades ?? []), job.target];
    }
  },
};

/**
 * Buy an upgrade node. Owned per PLAYER, not per town: the node retrains a line
 * of troops, and a player who trained the Wardens once should not have to pay
 * again in every town that has a Homestead.
 *
 * SCHEDULED, NOT INSTANT, as of Phase 7. The cost is taken now and the grant
 * lands when the crews finish — which is what makes the crew pools scarce and
 * queue order a decision rather than bookkeeping. Construction is deliberately
 * NOT routed this way: buildings are old content with a rhythm that has been
 * measured and tuned, while upgrade nodes are new content with no pacing to
 * disturb, so this costs nothing already balanced.
 *
 * Paying up front matches `dispatchCaravan`, which debits the garrison before
 * the caravan exists: a queued job that has not been paid for is a promise the
 * save cannot keep. Cancelling refunds nothing, which is what makes the queue a
 * commitment.
 *
 * Returns { ok, job } or { ok:false, reason }.
 */
export function buyUpgradeNode(state, town, nodeId) {
  const reason = upgradeNodeBlockReason(state, town, nodeId);
  if (reason) return { ok: false, reason };
  const n = UPGRADE_NODES[nodeId];
  const crew = n.crew || {};
  const scheduled = scheduleJob(state, {
    kind: 'upgradeNode',
    owner: town.owner,
    townId: town.id,
    target: nodeId,
    // Re-equipping a line of troops is workshop work, not construction — which
    // is what the second crew pool is for.
    crew: crew.pool || 'fletchers',
    crewCount: crew.count || 1,
    days: crew.days ?? CONFIG.JOBS.DEFAULT_DAYS,
    preemptible: n.preemptible !== false,
    // Keyed on the node and the owner: two towns must not both train the same
    // upgrade, and one town may train two different ones.
    lock: `upgrade:${town.owner}:${nodeId}`,
  });
  if (!scheduled.ok) return scheduled;
  pay(state.players[town.owner], n.cost);
  logMsg(state, `${town.name} begins training ${n.name}.`);
  return scheduled;
}

/**
 * Hire one more crew for a pool. Gold now, upkeep every day after.
 *
 * Expansion must sometimes be WORTHLESS: when the queue is blocked by a
 * dependency chain rather than by crew availability, another crew changes
 * nothing and its upkeep is pure loss. That is Amdahl's law, and it is meant to
 * be discoverable by buying one and watching nothing improve.
 */
export function hireCrew(state, playerIndex, pool) {
  const player = state.players[playerIndex];
  if (!player) return { ok: false, reason: 'no player' };
  if (!(pool in CONFIG.JOBS.CREWS)) return { ok: false, reason: `unknown crew "${pool}"` };
  const have = player.crews?.[pool] ?? CONFIG.JOBS.CREWS[pool];
  if (have >= CONFIG.JOBS.MAX_CREWS_PER_POOL) return { ok: false, reason: 'no more can be raised' };
  if (!canAfford(player, CONFIG.JOBS.CREW_HIRE)) return { ok: false, reason: 'Not enough resources' };
  pay(player, CONFIG.JOBS.CREW_HIRE);
  player.crews = { ...(player.crews || CONFIG.JOBS.CREWS), [pool]: have + 1 };
  logMsg(state, `A new ${pool.replace(/s$/, '')} crew is raised.`);
  return { ok: true, crews: player.crews[pool] };
}

/**
 * Daily upkeep for crews raised ABOVE the starting allotment.
 *
 * The starting crews are free on purpose. They are the realm's existing labour,
 * and levying upkeep on them would re-tune the economy of every game ever
 * played — including ones that never queue a job — which is exactly the kind of
 * silent, global balance change that a scheduler has no business making. A
 * player who hires nothing pays nothing and their game is untouched.
 */
export function crewUpkeep(state, player) {
  let extra = 0;
  for (const [pool, base] of Object.entries(CONFIG.JOBS.CREWS)) {
    const have = player.crews?.[pool] ?? base;
    extra += Math.max(0, have - base);
  }
  return extra * CONFIG.JOBS.CREW_UPKEEP_GOLD;
}

function rollGuildSpells(state, town, level) {
  town.guildSpells = town.guildSpells || {};
  const pool = spellsOfTier(level);
  const picked = state.rng.shuffle(pool).slice(0, GUILD_SPELL_SLOTS[level]);
  town.guildSpells[level] = picked;
}

export function learnGuildSpells(state, town, hero) {
  if (!town.guildSpells) return [];
  const learned = [];
  for (const level of Object.keys(town.guildSpells)) {
    for (const spellId of town.guildSpells[level]) {
      const spell = SPELLS[spellId];
      if (hero.spells.includes(spellId)) continue;
      const needWisdom = wisdomRequiredForTier(spell.tier);
      if ((hero.skills.wisdom || 0) < needWisdom) continue;
      hero.spells.push(spellId);
      learned.push(spellId);
    }
  }
  return learned;
}

// ===========================================================================
// TOWN: RECRUITING & GARRISON
// ===========================================================================

/** Highest recruitable creature id for a tier (upgraded if that dwelling exists). */
export function recruitableCreature(town, tier) {
  const catalog = buildingCatalog(town.faction);
  const hasBase = town.buildings.some((b) => catalog[b]?.dwellingTier === tier && !catalog[b].dwellingUpgrade);
  if (!hasBase) return null;
  const hasUpg = town.buildings.some((b) => catalog[b]?.dwellingTier === tier && catalog[b].dwellingUpgrade);
  const { base, upgraded } = creaturesOfTier(town.faction, tier);
  return hasUpg ? upgraded : base;
}

export function recruitCost(creatureId, count) {
  const cost = {};
  const c = CREATURES[creatureId];
  if (!c) return cost; // unknown id: degrade to "free/nothing" rather than throw
  for (const r of RESOURCES) {
    if (c.cost[r]) cost[r] = c.cost[r] * count;
  }
  return cost;
}

/**
 * Recruit `count` creatures of `tier` into the visiting hero's army if
 * possible, else the garrison. Returns count actually recruited.
 */
export function recruit(state, town, tier, count, buyer = null) {
  const creatureId = recruitableCreature(town, tier);
  if (!creatureId || count <= 0) return 0;
  const avail = town.available[tier] || 0;
  count = Math.min(count, avail);
  // Market rights: a suzerain may buy from a sworn realm's dwellings, and pays from
  // its OWN treasury. Without naming the buyer the vassal footed the bill for troops
  // it never saw, which is not a trade agreement — it is a requisition.
  const payerIndex = (buyer != null && buyer !== town.owner && canRecruitFrom(state, buyer, town))
    ? buyer : town.owner;
  const player = state.players[payerIndex];
  if (!player) return 0;
  // Clamp by what the player can afford.
  const c = CREATURES[creatureId];
  if (!c) return 0; // bad creature id — degrade instead of throwing
  for (const r of RESOURCES) {
    if (c.cost[r]) count = Math.min(count, Math.floor((player.resources[r] || 0) / c.cost[r]));
  }
  if (count <= 0) return 0;

  const visiting = town.visitingHeroId ? state.heroes[town.visitingHeroId] : null;
  // A buyer's own hero standing in the sworn town takes what it bought; a vassal's
  // garrison must never swallow troops the suzerain paid for.
  const hero = (visiting && visiting.owner === payerIndex) ? visiting : null;
  const foreign = payerIndex !== town.owner;
  const target = hero ? hero.army : (foreign ? null : town.garrison);
  if (!target || !addToArmy(target, creatureId, count)) {
    const alt = (hero && !foreign) ? town.garrison : null;
    if (!alt || !addToArmy(alt, creatureId, count)) return 0;
  }
  pay(player, recruitCost(creatureId, count));
  town.available[tier] -= count;
  return count;
}

// ---- External creature dwellings ------------------------------------------
// A recruitment site out on the map (see data/dwellings.js). Its object carries
// { type:'dwelling', dwellingType, available, owner }; a visiting hero flags it
// and may recruit the accrued stock into its army at the creature's normal cost.

/** The creature a dwelling object produces (its stamped id, or from the def). */
export function dwellingCreature(obj) {
  return obj?.creature || dwellingDef(obj?.dwellingType)?.creature || null;
}

/** Display name for a dwelling object. */
export function dwellingName(obj) {
  return dwellingDef(obj?.dwellingType)?.name
    || `${CREATURES[dwellingCreature(obj)]?.name || 'Creature'} Dwelling`;
}


// ---------------------------------------------------------------------------
// Reoccupied sites (the `siteRespawn` feature)
// ---------------------------------------------------------------------------

/**
 * Start the clock on an emptied one-shot reward site.
 *
 * Called at the exact moment a Pandora's Box, a Creature Bank / boss lair or a
 * Seer Hut is spent, and a no-op unless the feature is on — so a game without it
 * writes no field, draws no rng and behaves exactly as it always did. The stamp
 * is an ABSOLUTE day rather than a countdown: a save carries it unchanged, and a
 * mid-game config edit cannot strand a site half-way through its wait.
 */
function markForRespawn(state, obj) {
  if (!featureOn(state, 'siteRespawn')) return;
  obj.respawnAt = state.day + CONFIG.SITE_RESPAWN_WEEKS * CONFIG.DAYS_PER_WEEK;
}

/**
 * What a reoccupied site's guard must be worth.
 *
 * "Tide-sized from the start" is the point of the second visit. The ordinary
 * tide (tideScaleDefender) only inflates a defender when a HUMAN attacks it and
 * only at the moment of battle, which leaves the AI facing a four-week-old
 * guard table and leaves the site looking like a walkover on the map. Baking the
 * size in at reload fixes both: the object itself is a real fight, for whoever
 * comes.
 *
 * WHICH army it is sized against is the part that was wrong. It was the
 * strongest army in the world, on the reasoning that a site does not know who is
 * coming and that pegging it to the leader is what stops a runaway player
 * farming reloads. The first half is true; the second half was solved in the
 * wrong place. Sizing every vault on the map to the leader does stop the leader
 * farming, by the expedient of stopping everybody else playing: measured over six
 * AI games to day 56, a trailing realm met reloads at up to SEVEN TIMES its whole
 * army — including vaults in its own territory that it had cleared itself four
 * weeks earlier — and was locked out of the rule permanently, AI realms included
 * (the courage gate refuses a fight it cannot win, so it simply never went).
 *
 * The world had already met this exact failure and already answered it. The
 * wandering-stack peg found that "pegging every band to the strongest realm meant
 * the trailing realms could beat 0% of the map", and that widening the spread
 * does not reach them — only a different ANCHOR does, and the honest one is
 * geography (neutrals.bandAnchor). A reload is anchored the same way, so the map
 * speaks with one voice about what a fight in your own country is worth: your own
 * hinterland is priced against you, a contested frontier against whoever is
 * across the line, and open nobody's-country against the leader.
 *
 * Anti-farming then goes where the farming actually is. Farming is harvesting one
 * renewable tile over and over, not winning a hard fight once — so each reload of
 * THAT SITE raises its own guard, for whoever is doing it, capped so a sixty-week
 * game cannot drive a single tile to absurdity.
 *
 * Still never scaled DOWN (see tideSizeGuards): a site whose own table already
 * outweighs all of this keeps its teeth, and that is a floor no arithmetic here
 * can go under.
 */
function respawnGuardTarget(state, obj) {
  const level = obj.id && obj.id.startsWith('U') ? 1 : 0;
  const anchor = bandAnchor(state, obj.x, obj.y, level);
  const hardness = Number.isFinite(state.tideHardness) ? state.tideHardness : CONFIG.SITE_RESPAWN_TIDE;
  const reloads = Math.min(obj.reloads || 0, CONFIG.SITE_RESPAWN_RELOAD_CAP);
  return Math.round(anchor * hardness * (1 + CONFIG.SITE_RESPAWN_RELOAD_STEP * reloads));
}

/** Scale a guard array UP to `target` total POWER (src/core/power.js — a guard is
 *  a fight, and its size is what the fight costs, not what the creatures are
 *  worth). Never down: a site whose own table already outweighs the world keeps
 *  its teeth. */
function tideSizeGuards(guards, target, physical = false) {
  const worth = (g) => armyPower(g || [], physical);
  const have = worth(guards);
  if (!(have > 0) || have >= target) return guards;
  const mult = target / have;
  for (const st of guards) st.count = Math.max(st.count, Math.round(st.count * mult));
  return guards;
}

/**
 * Reoccupy every emptied site whose four weeks are up (the `siteRespawn`
 * feature). Runs once at each week's dawn.
 *
 * The content ROTATES rather than repeating: a box rolls a fresh reward and a
 * fresh guard, a Seer Hut a fresh quest, and a Creature Bank draws a new tenant
 * from its own tier — a plain bank from the plain banks, a boss lair from the
 * boss lairs. Keeping lairs in their own pool is what preserves "one apex prize
 * per map": a reload may turn a Dwarven Treasury into a Dragon Utopia, but it
 * can never mint a second Archangel Spire.
 *
 * Draws from `state.rng`, so it is gated on the feature twice over — once here
 * and once at the stamp — and a game without the feature never reaches the
 * draw at all.
 *
 * The guard target is computed PER SITE now rather than once for the whole pass:
 * it depends on whose ground the site stands on and on how many times that
 * particular tile has already been reloaded (see respawnGuardTarget).
 */
function respawnSites(state) {
  if (!featureOn(state, 'siteRespawn')) return 0;
  const physical = physicalModel(state);
  let n = 0;
  for (const objects of [state.map.objects, state.map.underground?.objects]) {
    if (!objects) continue;
    for (const obj of Object.values(objects)) {
      if (!(obj.respawnAt > 0) || state.day < obj.respawnAt) continue;
      obj.respawnAt = 0;
      // Priced against the reloads ALREADY behind this tile, so the first one
      // is the plain price and only a repeat visit pays the escalation.
      const target = respawnGuardTarget(state, obj);
      obj.reloads = (obj.reloads || 0) + 1;
      if (obj.type === 'pandora') {
        obj.reward = rollPandoraReward(state.rng);
        obj.guards = tideSizeGuards(rollPandoraGuard(state.rng, obj.reward, physical), target, physical);
        obj.looted = false;
      } else if (obj.type === 'creatureBank') {
        const pool = BOSS_LAIRS[obj.bankType] ? BOSS_LAIR_TYPES : BANK_TYPES;
        obj.bankType = state.rng.pick(pool);
        obj.guards = tideSizeGuards(bankDef(obj.bankType).guards.map((g) => ({ ...g })), target, physical);
        obj.looted = false;
        obj.brood = 0; // the new tenants have the nest; there is no old brood to collect
      } else if (obj.type === 'seerHut') {
        const payload = seerHutPayload(state.rng);
        obj.quest = payload.quest;
        obj.reward = payload.reward;
        obj.done = false;
      } else {
        continue;
      }
      n++;
    }
  }
  return n;
}

/** Weekly production: every dwelling accrues one week of its creature's growth
 *  (a plague week trims it, a matching creature week swells it — same seam as a
 *  town dwelling). Spans both map levels. */
function growDwellings(state, event) {
  for (const objects of [state.map.objects, state.map.underground?.objects]) {
    if (!objects) continue;
    for (const obj of Object.values(objects)) {
      if (obj.type !== 'dwelling') continue;
      const cr = dwellingCreature(obj);
      const base = CREATURES[cr]?.growth || 0;
      if (base > 0) obj.available = (obj.available || 0) + weeklyCreatureGrowth(base, 1, event, cr);
    }
  }
}

/**
 * Weekly brood in every LOOTED Creature Bank / boss lair (the `lairBrood`
 * feature): the guards are dead, but the nest is not — so the species that held
 * the place breeds on, and a hero who returns can take the young.
 *
 * Only looted banks breed: an unfought one still has its garrison and its prize,
 * and swelling that too would just move the goalposts. Routed through the same
 * `weeklyCreatureGrowth` seam the towns and dwellings use, so a plague week thins
 * a brood and a matching creature week swells it. Capped per broodOf().
 */
function growLairBroods(state, event) {
  if (!featureOn(state, 'lairBrood')) return;
  for (const objects of [state.map.objects, state.map.underground?.objects]) {
    if (!objects) continue;
    for (const obj of Object.values(objects)) {
      if (obj.type !== 'creatureBank' || !obj.looted) continue;
      const brood = broodOf(obj.bankType);
      if (!brood) continue;
      const step = weeklyCreatureGrowth(brood.perWeek, 1, event, brood.creature);
      obj.brood = Math.min(brood.cap, (obj.brood || 0) + Math.max(0, step));
    }
  }
}

/**
 * Tide of War (#7): unfought wild monster stacks on the map swell each week,
 * so the world stays a live, rising threat instead of a fixed set of walkovers
 * you outgrow. Each stack gains a fraction of its CURRENT size (at least 1) —
 * routed through the same `weeklyCreatureGrowth` seam the towns use, so a
 * matching "Week of the <creature>" surges wild stacks too and a plague thins
 * them — and is capped at a multiple of its ORIGINAL strength (recorded once
 * as `count0`), so a stack you keep avoiding gets meaner but never unbounded.
 * The caller preset-gates this; it's a no-op in Classic.
 */
export function growMapCreatures(state, event, { guardsOnly = false } = {}) {
  const PCT = CONFIG.TIDE_MAP_GROWTH_PCT;
  const CAP = CONFIG.TIDE_MAP_GROWTH_CAP;
  for (const objects of [state.map.objects, state.map.underground?.objects]) {
    if (!objects) continue;
    for (const obj of Object.values(objects)) {
      if (obj.type !== 'monster') continue;
      // A wave's war-bands are not wildlife (neutrals.isInvaderBand). They share
      // the 'monster' type, so with the peg OFF — the one arrangement where this
      // rule reaches beyond the guards — they were swelling 10% a week like a
      // warren of harpies while marching on a town.
      if (isInvaderBand(obj)) continue;
      // With the peg on, the wandering bands answer to it instead — two growth
      // rules on one stack would compound into exactly the runaway the cap here
      // exists to prevent.
      if (guardsOnly && !obj.guards) continue;
      const cr = CREATURES[obj.creature];
      if (!cr || !(cr.growth > 0)) continue;
      if (obj.count0 == null) obj.count0 = obj.count; // original strength — the cap's baseline
      const cap = Math.ceil(obj.count0 * CAP);
      if (obj.count >= cap) continue;
      const step = weeklyCreatureGrowth(Math.max(1, Math.round(obj.count * PCT)), 1, event, obj.creature);
      if (step > 0) obj.count = Math.min(cap, obj.count + step);
    }
  }
}

/** Roll a base (growable) creature + stack size whose combined aiValue lands in
 *  the [lo, hi] budget, sized to a readable, marchable count. Mirrors the
 *  map-generator's guard roll but stays self-contained here (and only ever picks
 *  a base creature with real weekly growth, so #7 can then swell it).
 *
 *  THE WINDOW IS A PREFERENCE, NOT A PRECONDITION. It used to be the latter: no
 *  creature in the catalog able to spend the budget on 3..80 bodies and this
 *  returned { creature: null }, on which respawnWildStacks returns out of its
 *  whole batch. The catalog's base creatures run from 46 (pixie) to 5,769
 *  (hydra) aiValue, so the expressible budget is 138..461,520 — and a band's
 *  budget is PEG_RATIO x its local anchor, which passes 461,520 in the ordinary
 *  late game. Past that the population floor silently stopped working: measured
 *  on seed 99, a map cleared of its wandering bands refilled to the full floor of
 *  29 under a leader of 936,600, reached 19 at 3,746,400, and stuck at 4 from
 *  14,049,000 up — no log, no error, the world simply emptied and stayed empty.
 *  That is the depletion failure this module exists to prevent, arriving from the
 *  top end instead of the bottom.
 *
 *  So an unmeetable budget now falls back to the closest the catalog can do —
 *  the strongest creature when the budget is too big (fewest bodies for it), the
 *  weakest when it is too small — rather than refusing to breed. The fallback
 *  pool still goes through rng.pick, so the stream costs exactly one draw either
 *  way and a seed's every other roll is where it was. */
function rollWildStack(rng, [lo, hi]) {
  const target = rng.int(lo, hi);
  const ids = baseCreatureIds();
  let pool = ids.filter((id) => {
    const minCount = Math.ceil(target / CREATURES[id].aiValue);
    return minCount >= 3 && minCount <= 80; // readable, marchable stack sizes
  });
  if (!pool.length) {
    // Which side of the window did it fall off? Too rich for 80 of anything ⇒
    // the strongest; too thin for 3 of anything ⇒ the weakest.
    const byValue = ids.slice().sort((a, b) => CREATURES[a].aiValue - CREATURES[b].aiValue);
    if (!byValue.length) return { creature: null, count: 0 };
    const strongest = byValue[byValue.length - 1];
    pool = [target > CREATURES[strongest].aiValue * 80 ? strongest : byValue[0]];
  }
  const creature = rng.pick(pool);
  const count = Math.max(1, Math.round(target / CREATURES[creature].aiValue));
  return { creature, count };
}

/** A runtime spot for a fresh wild stack on `level`: an open, non-water, un-
 *  obstructed, unoccupied land tile with a two-tile breathing ring clear of any
 *  other object (so a new band never spawns on a town's doorstep or interlocks
 *  an existing stack's zone of control) and no hero on it. Returns {x,y} or null
 *  after `tries` random probes. Uses state.rng, so it's deterministic. */
function findWildSpot(state, m, level, tries = 120, opts = {}) {
  const rng = opts.rng || state.rng;
  for (let i = 0; i < tries; i++) {
    const x = rng.int(2, m.w - 3);
    const y = rng.int(2, m.h - 3);
    const t = m.tiles[y * m.w + x];
    if (!t || t.terrain === 'water' || t.obstacle || t.objectId) continue;
    let crowded = false;
    for (let dy = -2; dy <= 2 && !crowded; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        if (m.tiles[ny * m.w + nx].objectId) { crowded = true; break; }
      }
    }
    if (crowded || heroAt(state, x, y, level)) continue;
    // Homeostasis respawns keep their distance: a band must never simply appear
    // in front of a hero that just cleared the ground, and by preference it
    // appears where nobody has looked at all.
    if (opts.heroClearance && nearAnyHero(state, x, y, level, opts.heroClearance)) continue;
    if (opts.unexploredOnly && exploredByAnyone(state, x, y, level)) continue;
    return { x, y };
  }
  return null;
}

/** Is any hero of any realm within `r` tiles of (x, y) on this level? */
function nearAnyHero(state, x, y, level, r) {
  for (const h of Object.values(state.heroes || {})) {
    if ((h.z ?? 0) !== level) continue;
    if (Math.max(Math.abs(h.x - x), Math.abs(h.y - y)) <= r) return true;
  }
  return false;
}

/** Has ANY player seen this tile? (Respawning into fog, not into someone's view.) */
function exploredByAnyone(state, x, y, level) {
  for (const p of state.players || []) {
    if (isExplored(state, p.index, x, y, level)) return true;
  }
  return false;
}

/**
 * The world-repopulation draw stream, minted from the game's seed on first use.
 *
 * Deliberately NOT state.rng. Respawn positions and stack rolls would otherwise
 * shift every subsequent gameplay draw, so switching homeostasis on (or having
 * it on at all) would change a seed's combat rolls, map events and wave sizes —
 * exactly the property that made unbundling the weekly growth safe. Mapgen has
 * always had its own stream for the same reason.
 */
export function wildStream(state) {
  if (!state.wildRng) state.wildRng = new Rng((state.seed ^ 0x5bf03635) | 0);
  else if (!(state.wildRng instanceof Rng)) state.wildRng = Rng.fromJSON(state.wildRng);
  return state.wildRng;
}

/**
 * The crawling peg (Phase C): each week, every WANDERING stack moves toward
 * PEG_RATIO x the leading realm's army — by at most PEG_CRAWL_PCT of its own
 * size, in either direction.
 *
 * The rate limit is the point. An instantaneous peg would re-scale the whole map
 * the same day a realm doubled its army (measured: 26,313 -> 81,388 on day 37 of
 * the reported campaign), so a burst of recruitment would buy nothing. Crawling,
 * the burst opens a window of a few weeks in which the world is genuinely soft,
 * and using that window is a strategy rather than an exploit.
 *
 * GUARDS are deliberately left to the old bounded growth. They are placed to
 * gate content, so pegging them would change what is reachable when — a
 * different promise from keeping the open country dangerous. Both distributions
 * are reported side by side (see scripts/sim/goal-audit.mjs).
 *
 * A pegged stack never shrinks below the size the map shipped it at: the world
 * may get harder relative to the leader, but the generator's own design is a
 * floor rather than a starting point to be rolled back.
 *
 * Pure arithmetic — no rng — so it is safe to have on by default. The growth
 * step still runs through weeklyCreatureGrowth, so a Week of the Plague thins the
 * world and a Week of the <creature> surges its kin, exactly as elsewhere.
 */
export function pegWildStacks(state, event) {
  let moved = 0;
  for (const { obj, guard, level } of wildStacks(state)) {
    if (guard) continue;
    const cr = CREATURES[obj.creature];
    if (!cr || !(cr.aiValue > 0)) continue;
    if (obj.count0 == null) obj.count0 = obj.count; // the generator's own design
    // Each band aims at ITS OWN target: its weight in the distribution (so the
    // shape survives, not merely the level) against the anchor its position
    // implies (so a realm's own country is priced against that realm, and only
    // the country nobody holds is priced against the leader).
    const aim = bandTarget(state, obj, level);
    if (!(aim > 0)) continue;
    const want = aim / cr.aiValue;
    // A share of the GAP, not of the stack: the anchor compounds, so a
    // fraction-of-current cap would either never catch up or amount to tracking
    // it exactly (see CONFIG.PEG_CRAWL_PCT for the arithmetic).
    const cap = Math.max(1, Math.round(Math.abs(want - obj.count) * CONFIG.PEG_CRAWL_PCT));
    let step;
    if (want > obj.count) {
      step = weeklyCreatureGrowth(Math.min(Math.round(want - obj.count), cap), 1, event, obj.creature);
    } else {
      // Shrinking back toward a fallen leader is not "growth": a plague week
      // must not make a receding stack swell.
      step = -Math.min(Math.round(obj.count - want), cap);
    }
    if (!step) continue;
    let next = Math.max(1, obj.count + step);
    if (CONFIG.PEG_FLOOR_AT_ORIGINAL) next = Math.max(next, obj.count0);
    if (next !== obj.count) { obj.count = next; moved++; }
  }
  return moved;
}

/**
 * The population floor (Phase C): when the wandering bands have been cleared
 * below a share of what the map shipped, a few ride in each week — sized at the
 * peg, placed in fog where possible, and never within sight of a hero.
 *
 * Gradual on purpose. An instant refill would mean clearing a region bought
 * nothing; a trickle means it buys a period of real quiet that then closes.
 * Draws from the world stream (see wildStream), never from gameplay's.
 */
export function respawnWildStacks(state) {
  if (!state?.map) return [];
  const floor = wildFloor(state);
  const have = wildStacks(state).filter((w) => !w.guard).length;
  if (have >= floor) return [];
  const rng = wildStream(state);
  const surface = state.map;
  const under = state.map.underground || null;
  const bred = [];
  const deficit = floor - have;
  const want = Math.min(deficit,
    Math.max(CONFIG.PEG_RESPAWN_PER_WEEK, Math.ceil(deficit * CONFIG.PEG_RESPAWN_CATCHUP)));
  for (let i = 0; i < want; i++) {
    let placed = null;
    for (const [m, level] of [[surface, 0], ...(under ? [[under, 1]] : [])]) {
      // Fog first, open ground away from every hero second — "at map edges or in
      // fog, never in sight of a hero", with the clearance as the hard rule.
      const spot = findWildSpot(state, m, level, 120, {
        rng, heroClearance: CONFIG.PEG_RESPAWN_CLEARANCE, unexploredOnly: true,
      }) || findWildSpot(state, m, level, 120, {
        rng, heroClearance: CONFIG.PEG_RESPAWN_CLEARANCE,
      });
      if (!spot) continue;
      // A fresh band draws its own place in the distribution — some skirmishes,
      // some problems — rather than arriving as another copy of the median.
      // LOGNORMAL: the weight is a multiplier, so it is centred multiplicatively
      // (median exactly 1) with a thin tail either side. A uniform draw over a
      // multiplicative range has median 1.45 and inflated the whole world by half
      // once the original bands had been cleared away — measured, and fixed here.
      const weight = Math.max(CONFIG.PEG_SPREAD_MIN, Math.min(CONFIG.PEG_SPREAD_MAX,
        Math.exp(CONFIG.PEG_SPREAD_SIGMA * rng.gauss())));
      // Priced where it LANDS: a band riding into a losing realm's country is
      // that realm's size, which is the whole point of the territorial anchor.
      const aim = CONFIG.PEG_RATIO * bandAnchor(state, spot.x, spot.y, level) * weight;
      const budget = aim > 0
        ? [Math.round(aim * 0.8), Math.round(aim * 1.2)]
        : CONFIG.TIDE_MONTH_SPAWN_BUDGET;
      const { creature, count } = rollWildStack(rng, budget);
      if (!creature) return bred;
      const id = `${m.oidPrefix || 'O'}${m.nextOid++}`;
      const obj = {
        id, x: spot.x, y: spot.y, type: 'monster', creature, count, count0: count, peg: weight,
      };
      m.objects[id] = obj;
      m.tiles[spot.y * m.w + spot.x].objectId = id;
      placed = obj;
      break;
    }
    if (placed) bred.push(placed);
  }
  if (bred.length) {
    logMsg(state, `The wilds fill in again — ${bred.length} fresh `
      + `${bred.length === 1 ? 'band is' : 'bands are'} abroad in the empty country.`);
  }
  return bred;
}

/**
 * Tide of War (#12): every week breeds a fresh batch of wild creature stacks
 * onto open ground, so the map keeps producing NEW quarry to fight rather than
 * only swelling (#7) the stacks it started with. Ordinary weeks trickle a stack
 * or two; the dawn of each new month surges a bigger batch — so the world never
 * goes quiet for weeks at a stretch. Batch sizes and each new stack's aiValue
 * budget scale with how far the game has run (a young world stays soft, an old
 * one breeds meaner), and every bred stack is stamped with `count0` so the
 * weekly #7 growth then caps it exactly like an original stack. Most surface on
 * the overworld (so the player actually sees them); a share dip underground when
 * that level exists. Deterministic (state.rng). The caller preset-gates this;
 * it's a no-op in Classic. Returns the bred objects (for the log + tests).
 */
export function spawnMapCreatures(state, event) {
  if (!state || !state.rng || !state.map) return [];
  const month = Math.floor((weekOf(state.day) - 1) / 4) + 1; // 1-based; monthly dawns begin at month 2
  const elapsed = Math.max(0, month - 2); // months since the first monthly dawn (0 at month 2)
  // A month dawn (event.month) surges a bigger batch; every other week trickles.
  const batch = (event && event.month)
    ? Math.min(
      CONFIG.TIDE_MONTH_SPAWN_MAX,
      CONFIG.TIDE_MONTH_SPAWN_BASE + CONFIG.TIDE_MONTH_SPAWN_PER_MONTH * elapsed,
    )
    : Math.min(
      CONFIG.TIDE_WEEK_SPAWN_MAX,
      CONFIG.TIDE_WEEK_SPAWN_BASE + Math.floor(CONFIG.TIDE_WEEK_SPAWN_PER_MONTH * elapsed),
    );
  const [lo, hi] = CONFIG.TIDE_MONTH_SPAWN_BUDGET;
  const scale = 1 + CONFIG.TIDE_MONTH_SPAWN_BUDGET_GROWTH * elapsed;
  const budget = [Math.round(lo * scale), Math.round(hi * scale)];
  const surface = state.map;
  const under = state.map.underground || null;
  const bred = [];
  for (let i = 0; i < batch; i++) {
    // Choose the level first (surface-dominant), then a spot on it; if that
    // level is somehow full this dawn, fall back to the other so a stack is
    // never silently dropped just because one level ran out of room.
    const wantUnder = under && state.rng.chance(CONFIG.TIDE_MONTH_SPAWN_UNDERGROUND);
    const order = wantUnder ? [[under, 1], [surface, 0]] : [[surface, 0], ...(under ? [[under, 1]] : [])];
    let placed = null;
    for (const [m, level] of order) {
      const spot = findWildSpot(state, m, level);
      if (!spot) continue;
      const { creature, count } = rollWildStack(state.rng, budget);
      if (!creature) return bred; // catalog can't fill the window — stop the batch
      const id = `${m.oidPrefix || 'O'}${m.nextOid++}`;
      // `peg: 1` — an ordinary band, at the middle of the distribution.
      //
      // Stamping it matters because bandWeight's fallback is to DERIVE the weight
      // from the stack's own value against `wildBandValue0`, which is the median
      // band the map shipped on day one. This batch's budget is
      // TIDE_MONTH_SPAWN_BUDGET x (1 + 0.5 x elapsed months), so it outgrows that
      // day-one median within a few months and the derived weight pins to
      // PEG_SPREAD_MAX from then on: every band Tide of War ever bred became a
      // maximum-spread band, priced at 0.375 of the anchor instead of 0.15,
      // silently and for the rest of the game. respawnWildStacks already draws a
      // weight rather than leaving it to be inferred; this is the same fix
      // without spending rng, so no other roll in a Tide seed moves.
      const obj = { id, x: spot.x, y: spot.y, type: 'monster', creature, count, count0: count, peg: 1 };
      m.objects[id] = obj;
      m.tiles[spot.y * m.w + spot.x].objectId = id;
      placed = obj;
      break;
    }
    if (placed) bred.push(placed);
  }
  if (bred.length) {
    const noun = bred.length === 1 ? 'warband takes' : 'warbands take';
    logMsg(state, `The tide of war stirs — ${bred.length} new wild ${noun} the field.`);
    (state.eventToasts = state.eventToasts || []).push(
      `${bred.length} new wild ${bred.length === 1 ? 'band emerges' : 'bands emerge'} across the land.`,
    );
  }
  return bred;
}

/**
 * Recruit up to `count` of a dwelling's creature straight into the hero's army,
 * clamped by the accrued stock AND what the player can afford, and paid at the
 * creature's normal cost. Returns the number actually recruited (0 if none fit,
 * nothing's affordable, or the army is full). Mirrors town recruit()'s clamps so
 * the two can never price a unit differently.
 */
export function recruitFromDwelling(state, hero, obj, count) {
  if (!obj || obj.type !== 'dwelling' || count <= 0) return 0;
  const cr = dwellingCreature(obj);
  const c = CREATURES[cr];
  if (!c) return 0;
  count = Math.min(count, obj.available || 0);
  const player = state.players[hero.owner];
  for (const r of RESOURCES) {
    if (c.cost[r]) count = Math.min(count, Math.floor((player.resources[r] || 0) / c.cost[r]));
  }
  if (count <= 0) return 0;
  if (!addToArmy(hero.army, cr, count)) return 0; // no free slot / matching stack
  pay(player, recruitCost(cr, count));
  obj.available -= count;
  return count;
}

// ---- Caravans -------------------------------------------------------------
// Dispatch a garrison stack from one owned town toward another of your team; it
// plods the road network CARAVAN_SPEED tiles a day and merges into the
// destination garrison on arrival. Unescorted — an enemy hero that reaches its
// tile scatters it (a raid). Caravans live in state.caravans (plain data →
// round-trips saves). See advanceCaravans (daily travel) and interceptCaravan.

/** Any caravan sitting on (x,y,level), or null. */
export function caravanAt(state, x, y, level = 0) {
  return (state.caravans || []).find((c) => c.x === x && c.y === y && (c.z ?? 0) === level) || null;
}

/**
 * Send `count` of the garrison stack in slot `slotIndex` from `fromTown` to the
 * team-mate town `toTownId`. Computes a road-preferring path; the troops leave
 * the garrison at once and travel over the coming days. Returns { ok, caravan }
 * or { ok:false, reason }.
 */
export function dispatchCaravan(state, fromTown, toTownId, slotIndex, count) {
  const to = state.towns[toTownId];
  if (!fromTown || !to) return { ok: false, reason: 'no town' };
  if (fromTown.id === toTownId) return { ok: false, reason: 'same town' };
  if (!sameTeam(state, fromTown.owner, to.owner)) return { ok: false, reason: 'not your town' };
  const stack = (fromTown.garrison || [])[slotIndex];
  if (!stack || !stack.creature || stack.count <= 0) return { ok: false, reason: 'empty slot' };
  count = Math.min(count | 0, stack.count);
  if (count <= 0) return { ok: false, reason: 'no troops' };
  const level = fromTown.z ?? 0;
  if ((to.z ?? 0) !== level) return { ok: false, reason: 'different level' }; // no cross-level roads
  const probe = { x: fromTown.x, y: fromTown.y, z: level, owner: fromTown.owner, onBoat: false };
  const found = findPath(state, probe, to.x, to.y, -1); // omniscient: it's your own supply line
  if (!found || !found.path.length) return { ok: false, reason: 'no route' };

  // Debit the garrison (empty the slot if drained).
  stack.count -= count;
  if (stack.count <= 0) fromTown.garrison[slotIndex] = null;

  const caravan = {
    id: `CV${state.nextCaravanId = (state.nextCaravanId || 0) + 1}`,
    owner: fromTown.owner, creature: stack.creature, count,
    toTownId, x: fromTown.x, y: fromTown.y, z: level,
    path: found.path.map((p) => ({ x: p.x, y: p.y })), cursor: 0,
  };
  state.caravans.push(caravan);
  logMsg(state, `A caravan of ${count} ${CREATURES[caravan.creature]?.name || caravan.creature} sets out for ${to.name}.`);
  return { ok: true, caravan };
}

/** Advance every caravan a day's travel; arrive, disband, or halt as needed.
 *  Returns the events (arrivals/disbands) for the view/log. */
export function advanceCaravans(state) {
  const events = [];
  const speed = CONFIG.CARAVAN.SPEED;
  const survivors = [];
  for (const c of state.caravans || []) {
    const to = state.towns[c.toTownId];
    // Destination gone or no longer ours ⇒ the supply run is lost.
    if (!to || !sameTeam(state, c.owner, to.owner)) {
      logMsg(state, `A caravan bound for a lost town scatters — ${c.count} ${CREATURES[c.creature]?.name || c.creature} are gone.`);
      events.push({ type: 'caravanLost', owner: c.owner });
      continue;
    }
    // Plod up to `speed` tiles, halting before any tile an enemy hero occupies
    // (an unescorted caravan won't walk into a raider).
    let steps = 0;
    while (steps < speed && c.cursor < c.path.length) {
      const next = c.path[c.cursor];
      const occ = heroAt(state, next.x, next.y, c.z ?? 0);
      if (occ && !sameTeam(state, c.owner, occ.owner)) break; // blocked by an enemy — wait
      c.x = next.x; c.y = next.y; c.cursor++; steps++;
    }
    if (c.cursor >= c.path.length) {
      // Arrived: merge into the destination garrison (drop what won't fit).
      if (!addToArmy(to.garrison, c.creature, c.count)) {
        logMsg(state, `A caravan reached ${to.name}, but its garrison had no room for ${c.count} ${CREATURES[c.creature]?.name || c.creature}.`);
      } else {
        logMsg(state, `A caravan of ${c.count} ${CREATURES[c.creature]?.name || c.creature} reaches ${to.name} and joins its garrison.`);
      }
      events.push({ type: 'caravanArrived', owner: c.owner, townId: to.id });
      continue;
    }
    survivors.push(c);
  }
  state.caravans = survivors;
  return events;
}

/**
 * An enemy hero reaches a caravan's tile and scatters it: the caravan is
 * removed, its owner loses the troops, and the raider pockets XP scaled by the
 * lost stack's army value. Returns the raid event (with any level-ups).
 */
export function interceptCaravan(state, hero, caravan) {
  state.caravans = (state.caravans || []).filter((c) => c !== caravan);
  const value = armyValue([{ creature: caravan.creature, count: caravan.count }]);
  const xp = Math.round(value * CONFIG.CARAVAN.RAID_XP_PER_VALUE);
  const levels = gainXp(state, hero, xp);
  logMsg(state, `${hero.name} intercepts and scatters a caravan of ${caravan.count} ${CREATURES[caravan.creature]?.name || caravan.creature} (+${xp} XP).`);
  const ev = { type: 'caravanRaided', creature: caravan.creature, count: caravan.count, xp };
  if (levels > 0) ev.events = [{ type: 'levelUp', heroId: hero.id }];
  return ev;
}

/**
 * Buy a war machine at a town Blacksmith for the visiting hero. Machines are
 * hero-carried (hero.warMachines) and one of each per hero, so the Blacksmith
 * needs a hero standing in the town to hand it to. The machine is deployed at
 * the start of every battle that hero fights (CombatEngine.deployWarMachines).
 * Returns { ok, reason } — the view messages the reason on failure.
 */
export function buyWarMachine(state, town, machineId) {
  const spec = CONFIG.WAR_MACHINES[machineId];
  if (!spec) return { ok: false, reason: 'unknown machine' };
  if (!town.buildings.includes('blacksmith')) return { ok: false, reason: 'no blacksmith' };
  const hero = town.visitingHeroId ? state.heroes[town.visitingHeroId] : null;
  if (!hero) return { ok: false, reason: 'no hero' };
  if (!hero.warMachines) hero.warMachines = {};
  if (hero.warMachines[machineId]) return { ok: false, reason: 'owned' };
  const player = state.players[town.owner];
  if (!canAfford(player, spec.cost)) return { ok: false, reason: 'cost' };
  pay(player, spec.cost);
  hero.warMachines[machineId] = true;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// TOWN: UPGRADING OWNED STACKS
// ---------------------------------------------------------------------------

/**
 * If `creatureId` can be upgraded in `town` (it's a base unit of the town's
 * faction whose upgraded dwelling for that tier is built), return { to } with
 * the upgraded creature id; otherwise null.
 */
export function upgradeInfo(town, creatureId) {
  const c = CREATURES[creatureId];
  if (!c || c.upgraded || c.faction !== town.faction) return null;
  const { upgraded } = creaturesOfTier(town.faction, c.tier);
  if (!upgraded || CREATURES[upgraded]?.upgradeOf !== creatureId) return null;
  const catalog = buildingCatalog(town.faction);
  const hasUpgDwelling = town.buildings.some(
    (b) => catalog[b]?.dwellingTier === c.tier && catalog[b].dwellingUpgrade,
  );
  return hasUpgDwelling ? { to: upgraded } : null;
}

/** Gold/resource surcharge to upgrade `count` of `fromId` into `toId` (cost diff). */
export function upgradeUnitCost(fromId, toId, count) {
  const from = CREATURES[fromId], to = CREATURES[toId];
  const cost = {};
  if (!from || !to) return cost;
  for (const r of RESOURCES) {
    const d = ((to.cost[r] || 0) - (from.cost[r] || 0)) * count;
    if (d > 0) cost[r] = d;
  }
  return cost;
}

/**
 * Upgrade the stack at `army[index]` to its dwelling's upgraded creature,
 * charging the cost difference. Returns true on success. `army` is the garrison
 * or a visiting hero's army; both are valid to upgrade from a town.
 */
// ===========================================================================
// TOWN BANK (#17) — collateralized loans to rush a big-ticket building.
// Debts live on state.debts (plain data → round-trips saves); installments are
// ticked weekly (tickDebts, from endTurn) and a missed payment repossesses the
// financed building.
// ===========================================================================

/** The loan terms to finance `buildingId`: principal (its gold cost), total owed
 *  (principal + interest), and the equal weekly installment. */
export function loanQuote(town, buildingId) {
  const b = buildingCatalog(town.faction)[buildingId];
  const principal = b?.cost?.gold || 0;
  const owed = Math.round(principal * (1 + CONFIG.BANK_INTEREST));
  const weekly = Math.ceil(owed / CONFIG.BANK_WEEKS);
  return { principal, owed, weekly, weeks: CONFIG.BANK_WEEKS };
}

/** The town's outstanding financed building ids (so the UI can flag them). */
export function townDebts(state, townId) {
  return (state.debts || []).filter((d) => d.collateralTownId === townId);
}

/** Non-gold materials a build needs (the loan only covers the gold). */
function nonGoldCost(b) {
  const c = {};
  for (const r of RESOURCES) if (r !== 'gold' && b.cost[r]) c[r] = b.cost[r];
  return c;
}

/**
 * Big-ticket buildings this town could finance right now: the Bank is built, the
 * feature is on, the build's prerequisites are met, it isn't built (or being
 * financed) already, its gold cost clears BANK_MIN_PRINCIPAL, and its non-gold
 * materials are affordable (the loan covers only gold). Returns building ids.
 */
export function loanableBuildings(state, town) {
  if (!featureOn(state, 'townBank') || !(town.buildings || []).includes('bank')) return [];
  const player = state.players[town.owner];
  const catalog = buildingCatalog(town.faction);
  const financed = new Set(townDebts(state, town.id).map((d) => d.collateralBuilding));
  const out = [];
  for (const [id, b] of Object.entries(catalog)) {
    if (town.buildings.includes(id) || financed.has(id)) continue;
    if ((b.cost?.gold || 0) < CONFIG.BANK_MIN_PRINCIPAL) continue;
    if ((b.requires || []).some((r) => !town.buildings.includes(r))) continue;
    if (b.feature && !featureOn(state, b.feature)) continue;
    if (b.onePerPlayer && playerTowns(state, town.owner).some((t) => t.buildings.includes(id))) continue;
    if (!canAfford(player, nonGoldCost(b))) continue;
    out.push(id);
  }
  return out;
}

/**
 * Take a Town Bank loan to raise `buildingId` now: pay its non-gold materials, put
 * the building up on the bank's gold, and record a secured debt against it. Fails
 * (no change) when the town can't finance it. Returns { ok, ...quote } / { ok:false }.
 */
export function takeLoan(state, town, buildingId) {
  if (!loanableBuildings(state, town).includes(buildingId)) return { ok: false, reason: 'not financable' };
  if (town.builtToday) return { ok: false, reason: 'already built here today' };
  const player = state.players[town.owner];
  const b = buildingCatalog(town.faction)[buildingId];
  const q = loanQuote(town, buildingId);
  pay(player, nonGoldCost(b));
  town.buildings.push(buildingId);
  town.builtToday = true;
  (state.debts = state.debts || []).push({
    player: town.owner, owed: q.owed, weekly: q.weekly,
    collateralTownId: town.id, collateralBuilding: buildingId,
  });
  logMsg(state, `${town.name} borrows ${q.principal} gold to raise the ${b.name} — ${q.owed} owed over ${q.weeks} weeks.`);
  return { ok: true, ...q };
}

/**
 * Weekly loan servicing (called from endTurn on a new week): each debt takes its
 * installment from the borrower's gold; a fully-repaid loan clears; a MISSED
 * payment defaults — the bank repossesses the financed building and the debt is
 * wiped (the collateral settled it). A defeated borrower's debts simply lapse.
 */
/** How many Town Banks a player holds, across every town they own. */
export function bankCount(state, playerIndex) {
  return playerTowns(state, playerIndex).filter((t) => t.buildings.includes('bank')).length;
}

/**
 * The weekly deposit rate a player's banks pay, as a fraction.
 *
 * The first CONFIG.BANK_DEPOSIT_STACK banks pay the full rate each — so a second
 * and third bank are worth real gold — and every bank beyond that pays the
 * reduced rate, because five towns each carrying a bank is already most of a map.
 */
export function bankDepositRate(state, playerIndex) {
  const n = bankCount(state, playerIndex);
  if (n <= 0) return 0;
  const full = Math.min(n, CONFIG.BANK_DEPOSIT_STACK);
  const extra = Math.max(0, n - CONFIG.BANK_DEPOSIT_STACK);
  return full * CONFIG.BANK_DEPOSIT_RATE + extra * CONFIG.BANK_DEPOSIT_EXTRA_RATE;
}

/**
 * What a player's banks would pay right now, on the gold they are holding.
 *
 * Interest is paid on the first CONFIG.BANK_DEPOSIT_CAP gold only — see the
 * constant for why an uncapped rate cannot stand. Rounded down: a bank never
 * invents a coin.
 */
export function bankInterestDue(state, playerIndex) {
  const rate = bankDepositRate(state, playerIndex);
  if (rate <= 0) return 0;
  const gold = Math.max(0, state.players[playerIndex]?.resources?.gold || 0);
  return Math.floor(Math.min(gold, CONFIG.BANK_DEPOSIT_CAP) * rate);
}

/**
 * Pay every player's deposit interest at the turn of the week (Town Bank, #17).
 *
 * Gold still in the treasury when the week turns earns its keep, which gives
 * hoarding a purpose and makes a second bank a build worth considering. Applies to
 * the AI on the same terms — a rival that banks its gold gets the same return.
 */
function payBankInterest(state) {
  if (!featureOn(state, 'townBank')) return;
  for (const player of state.players) {
    if (player.defeated) continue;
    const due = bankInterestDue(state, player.index);
    if (due <= 0) continue;
    grant(player, { gold: due });
    const n = bankCount(state, player.index);
    logMsg(state, `${player.name}'s ${n === 1 ? 'bank pays' : `${n} banks pay`} ${due} gold in interest.`);
  }
}

export function tickDebts(state) {
  if (!state.debts || !state.debts.length) return;
  const kept = [];
  for (const d of state.debts) {
    const player = state.players[d.player];
    if (!player || player.defeated) continue;
    const due = Math.min(d.weekly, d.owed);
    if ((player.resources.gold || 0) >= due) {
      player.resources.gold -= due;
      d.owed -= due;
      if (d.owed > 0) kept.push(d);
      else logMsg(state, `${state.towns[d.collateralTownId]?.name || 'A town'} clears its loan on the ${buildingName(state, d)}.`);
    } else {
      const town = state.towns[d.collateralTownId];
      if (town && town.buildings.includes(d.collateralBuilding)) {
        town.buildings = town.buildings.filter((x) => x !== d.collateralBuilding);
        logMsg(state, `${town.name} defaults — the bank repossesses the ${buildingName(state, d)}.`);
      }
      // debt cancelled: the collateral cleared it
    }
  }
  state.debts = kept;
}

/** Display name of a debt's collateral building. */
function buildingName(state, d) {
  const town = state.towns[d.collateralTownId];
  return (town && buildingCatalog(town.faction)[d.collateralBuilding]?.name) || 'building';
}

/** Gold to forget one secondary skill at the Hall of Reflection (scales with level). */
export function forgetSkillCost(hero) {
  return CONFIG.REFLECTION_DROP_COST * Math.max(1, hero?.level || 1);
}

/**
 * Hall of Reflection (#15): a visiting hero forgets one secondary skill for a
 * level-scaled fee, freeing the slot (a future level-up can fill it). Stats, XP
 * and artifacts are untouched. Requires the town to hold the Hall and the hero to
 * actually know the skill. Returns { ok, skillId, cost } or { ok:false, reason }.
 */
export function forgetSkill(state, town, hero, skillId) {
  if (!town || !(town.buildings || []).includes('hallOfReflection')) return { ok: false, reason: 'no hall' };
  if (!hero || !hero.skills || !hero.skills[skillId]) return { ok: false, reason: 'skill not known' };
  const player = state.players[town.owner];
  const cost = { gold: forgetSkillCost(hero) };
  if (!canAfford(player, cost)) return { ok: false, reason: 'not enough gold' };
  pay(player, cost);
  delete hero.skills[skillId];
  logMsg(state, `${hero.name} sheds ${SKILLS[skillId]?.name || skillId} at the Hall of Reflection.`);
  return { ok: true, skillId, cost: cost.gold };
}

export function upgradeStack(state, town, army, index) {
  const stack = army[index];
  if (!stack || stack.count <= 0) return false;
  const info = upgradeInfo(town, stack.creature);
  if (!info) return false;
  const player = state.players[town.owner];
  const cost = upgradeUnitCost(stack.creature, info.to, stack.count);
  if (!canAfford(player, cost)) return false;
  pay(player, cost);
  stack.creature = info.to;
  stack.hurt = Math.min(stack.hurt || 0, CREATURES[info.to].health - 1);
  return true;
}

// ===========================================================================
// TOWN: MARKETPLACE — implemented in ./market.js, re-exported so the actions.js
// public API (and every importer) is unchanged. A first, self-contained slice
// of the town-economy split.
// ===========================================================================
export {
  MARKET_RATES, marketplaceCount, marketSellRate, marketBuyRate,
  marketQuote, marketGiveForGet, marketExchange, marketTrade,
} from './market.js';

// TOWN: ALTAR OF TRANSMUTATION — implemented in ./transmute.js, re-exported so
// the actions.js public API is unchanged (like the marketplace slice above).
export {
  townHasAltar, transmuteTargets, transmuteQuote, transmuteMinInput, transmuteInputFor, transmuteStack,
} from './transmute.js';

// DIPLOMACY (#16) — the pure offer/price logic lives in ./diplomacy.js; the
// world-mutating `parley` / `letThemGo` / `chaseThem` actions (below) use it.
// Re-exported so the UI imports everything from actions.js as usual.
export { parleyOffer, predictedFightLoss, fleeCheck, chaseCost };

/**
 * Diplomacy (#16): pay a neutral stack to JOIN `hero` instead of fighting it.
 * Fails (no change) when the stack won't bargain (too strong / refused), the
 * treasury can't cover the price, or the army has no room. Returns
 * { ok, price, creature, count } or { ok:false, reason }.
 */
export function parley(state, hero, monster) {
  const offer = parleyOffer(state, hero, monster);
  if (!offer.offered) return { ok: false, reason: 'no offer' };
  if (offer.refused) return { ok: false, reason: 'refused' };
  const player = state.players[hero.owner];
  if (!canAfford(player, { gold: offer.price })) return { ok: false, reason: 'not enough gold' };
  if (!addToArmy(hero.army, monster.creature, monster.count)) return { ok: false, reason: 'no room in the army' };
  pay(player, { gold: offer.price });
  removeObject(state, monster);
  const what = `${monster.count} ${CREATURES[monster.creature]?.name || 'neutrals'}`;
  logMsg(state, offer.free
    ? `${hero.name} is joined by ${what} — kin, and they ask nothing.`
    : `${hero.name} persuades ${what} to join for ${offer.price} gold.`);
  return { ok: true, price: offer.price, free: offer.free, creature: monster.creature, count: monster.count };
}

/**
 * Did the band the hero is about to fight break and run?
 *
 * Takes the ENCOUNTER rather than the map object so the scene has one call for
 * the question, and so the rule stays in one place: see diplomacy.fleeCheck for
 * what it weighs (the stack as it stands) and who never runs (guards, ronin-led
 * bands, invaders). A chase then fights ctx's OWN defender army — the full,
 * tide-sized battle — which is what the experience is being paid for.
 */
export function encounterFlees(state, ctx) {
  if (!ctx || ctx.defender?.kind !== 'monster') return { flees: false, reason: 'no encounter' };
  const hero = state.heroes[ctx.attackerHeroId];
  const monster = getObject(state, ctx.defender.objectId);
  if (!hero || !monster) return { flees: false, reason: 'no encounter' };
  return fleeCheck(state, hero, monster);
}

/**
 * The band ran, and the hero let them: no battle, no experience, no spoils.
 *
 * The tile clears through the same `clearWildStack` the victory path uses, so the
 * two ways a wild stack leaves the map can never drift apart. What is NOT paid is
 * everything the fight would have: no XP, no level, no necromancy raise, no
 * creature spoils. That is the whole trade the player is making.
 *
 * No prize changes hands here in practice, and that is by construction rather
 * than by omission: a band posted on a mine or an artifact never runs
 * (diplomacy.fleeCheck), precisely because clearing its tile would hand the prize
 * over for nothing. The gate below is the other half of that — without it this
 * would be a free "clear any stack on the map" button.
 *
 * Returns the same `events` shape applyCombatResult does, so the caller settles
 * a claimed prize (a chest, an artifact, a mine) with the code it already has.
 */
export function letThemGo(state, ctx) {
  if (!encounterFlees(state, ctx).flees) return { ok: false, reason: 'they did not run' };
  const hero = state.heroes[ctx.attackerHeroId];
  const monster = getObject(state, ctx.defender.objectId);
  const events = [];
  const what = `${monster.count} ${CREATURES[monster.creature]?.name || 'neutrals'}`;
  clearWildStack(state, hero, monster, events, { tileEntered: ctx.tileEntered });
  logMsg(state, `${what} scatter rather than face ${hero.name}, and are let go.`);
  return { ok: true, events, creature: monster.creature, count: monster.count };
}

/**
 * Run a fleeing band to ground. Spends CONFIG.CHASE_MOVE_COST of the day's
 * movement and returns { ok, spent } — the CALLER then opens the battle, which
 * is fought and settled exactly like any other. The movement is what makes the
 * fork a decision instead of a free yes: the experience is real, and so is the
 * afternoon it costs you.
 *
 * Never blocked by a short allowance — a hero with nothing left simply spends
 * what it has. Refusing the chase at dusk would strand a player who stepped into
 * contact with their last point of movement.
 */
export function chaseThem(state, ctx) {
  if (!encounterFlees(state, ctx).flees) return { ok: false, reason: 'they did not run' };
  const hero = state.heroes[ctx.attackerHeroId];
  const spent = Math.min(hero.mp || 0, chaseCost(hero));
  hero.mp = Math.max(0, (hero.mp || 0) - spent);
  return { ok: true, spent };
}

// ===========================================================================
// TOWN: TAVERN (hero hiring)
// ===========================================================================

export function hireableHeroes(state, town) {
  const onMap = new Set(Object.values(state.heroes).map((h) => h.rosterId));
  const pool = state.players[town.owner]?.heroPool || [];
  // A roster hero waiting in ANY player's pool is off the fresh-recruit table —
  // otherwise a rival's tavern could mint a level-1 clone of someone else's
  // retired veteran, and two copies of one hero would share the map.
  const pooledAnywhere = new Set(
    state.players.flatMap((p) => (p.heroPool || []).map((h) => h.rosterId)),
  );
  // A masterless captain in the field holds its roster identity too. It is in
  // neither state.heroes nor anyone's pool — that is the whole point of a ronin —
  // so without this a tavern would happily mint a level-1 clone of a captain the
  // player can currently see walking around, which is exactly the two-copies-of-one-
  // hero failure the paragraph above exists to prevent.
  for (const { obj } of roninStacks(state)) pooledAnywhere.add(obj.ronin.hero.rosterId);
  // Fresh recruits of the town's faction (not already on the map, and not one of
  // this player's returning veterans — those are offered from the pool instead).
  const fresh = heroesOfFaction(town.faction).filter((id) => !onMap.has(id) && !pooledAnywhere.has(id));
  // Returning veterans re-hire at ANY of the player's taverns, faction aside.
  return [...fresh, ...pool.map((h) => h.rosterId)];
}

/** The player's pooled (retired) hero for `rosterId`, or null — used by the tavern. */
export function pooledHero(state, owner, rosterId) {
  return (state.players[owner]?.heroPool || []).find((h) => h.rosterId === rosterId) || null;
}

/** Gold to re-hire a retired veteran: base price + a premium per experience level. */
export function rehireCost(hero) {
  return CONFIG.HERO_COST + Math.max(0, (hero.level || 1) - 1) * CONFIG.HERO_REHIRE_LEVEL_PREMIUM;
}

/** Cost to hire `rosterId` at this town: a re-hire premium for a veteran, else base. */
export function hireCost(state, town, rosterId) {
  const vet = pooledHero(state, town.owner, rosterId);
  return vet ? rehireCost(vet) : CONFIG.HERO_COST;
}

export function hireHero(state, town, rosterId) {
  const player = state.players[town.owner];
  if (!town.buildings.includes('tavern')) return null;
  if (town.visitingHeroId) return null; // the town square is occupied
  if (!hireableHeroes(state, town).includes(rosterId)) return null;
  const vet = pooledHero(state, town.owner, rosterId);
  const cost = vet ? rehireCost(vet) : CONFIG.HERO_COST;
  if (!canAfford(player, { gold: cost })) return null;
  pay(player, { gold: cost });
  const hero = vet ? rehirePooledHero(state, town, vet) : createHero(state, rosterId, town.owner, town.x, town.y);
  // The recruit reports to the town's own level (a tavern in a captured
  // cavern town produces an underground hero, not a surface ghost).
  hero.z = town.z ?? 0;
  enterTown(state, town, hero);
  revealAround(state, hero.owner, hero.x, hero.y, heroSightRadius(hero), hero.z);
  logMsg(state, vet
    ? `${hero.name} returns to ${state.players[town.owner].name}'s service at ${town.name}.`
    : `${hero.name} joined ${state.players[town.owner].name} at ${town.name}.`);
  return hero;
}

/**
 * Re-hire a retired veteran from the owner's pool: it keeps its XP, level,
 * stats, skills, spells (and its army if it surrendered). A hero that lost its
 * army (retreat / defeat) draws a fresh roster starting army. Returns it to the
 * map, back in state.heroes with its original id.
 */
function rehirePooledHero(state, town, hero) {
  const pool = state.players[town.owner].heroPool;
  const i = pool.indexOf(hero);
  if (i >= 0) pool.splice(i, 1);
  hero.owner = town.owner;
  hero.x = town.x; hero.y = town.y; hero.onBoat = false; hero.inTownId = null;
  if (hero.army.every((s) => !s)) rollStartingArmy(state, hero); // lost its army → a fresh one
  hero.mana = heroMaxMana(hero);
  hero.mp = heroMaxMovement(hero);
  state.heroes[hero.id] = hero;
  return hero;
}

// ===========================================================================
// COMBAT BRIDGE (contexts consumed by CombatScene / auto-resolver)
// ===========================================================================

/**
 * Plunder a beaten Creature Bank: pay the reward to the victor and empty it.
 * Returns a summary of what was granted (for the debrief). Reward creatures with
 * no free slot / matching stack are lost (the hero's army was full).
 */
/**
 * The artifact a plundered bank or boss lair pays out, drawn from the rarity
 * BAND the bank earned (`reward.artifact` is that band) rather than from the
 * catalog at large.
 *
 * It used to be `rng.pick(Object.keys(ARTIFACTS))` — a flat draw over everything
 * — which meant an Archangel Spire, the hardest fight the generator seats and
 * five times the guard standing over the map's own grand prize, paid out a +1
 * Luck charm about one time in seven. It could also hand you a First Vow
 * campaign relic on a skirmish map, the same leak that was closed on the
 * treasure-placement side but never here.
 *
 * ONE rng draw, exactly as before: a bank's reward is rolled when it is
 * plundered, off the shared state stream, so spending a second draw would shift
 * every subsequent roll in the game.
 */
function rollBankArtifact(state, band) {
  const usable = Object.keys(ARTIFACTS).filter((id) => !ARTIFACTS[id].campaign);
  const pool = usable.filter((id) => ARTIFACTS[id].value === band);
  return state.rng.pick(pool.length ? pool : usable);
}

/**
 * Battle XP with the tide's inflation divided back out.
 *
 * `result.xp` is `battle.valueLost[loser]` — the armyValue of the corpses — and on a
 * scaled PvE fight those corpses are the per-attacker fiction, not what the map placed.
 * The creature prize and the necromancy raise were both un-inflated for exactly this
 * reason; XP is the third payout off the same pile and was missed.
 *
 * It matters more than it looks, because the sizer now READS the commander: inflated XP
 * buys levels faster, a higher-level commander is met with a bigger scaled guard, and a
 * bigger guard leaves a bigger corpse pile. That is the same compounding loop the bank
 * prize had, running through the progression track instead of the army.
 */
function trueBattleXp(ctx, xp) {
  const mult = ctx?.tideScaled && ctx.tideScaleMult > 1 ? ctx.tideScaleMult : 1;
  return mult === 1 ? xp : Math.max(0, Math.round((xp || 0) / mult));
}

/**
 * The defender as the MAP holds it, not as it was massed for THIS attacker.
 *
 * tideScaleDefender inflates a PvE garrison per-attacker, and the repel path already
 * divides that back out before storing survivors, on the stated grounds that the
 * inflation "must NOT persist". Anything that PAYS OUT off the defender owes the same
 * division, and for the same reason: a prize computed from the inflated count is a
 * prize for a fight that only ever existed in one hero's private copy of the map.
 */
function trueDefenderArmy(ctx) {
  const army = (ctx?.defenderArmy || []).filter(Boolean);
  const mult = ctx?.tideScaled && ctx.tideScaleMult > 1 ? ctx.tideScaleMult : 1;
  if (mult === 1) return army;
  return army.map((st) => ({ ...st, count: Math.max(1, Math.round(st.count / mult)) }));
}

/**
 * `guardArmy` is the garrison the MAP placed — `bank.guards` — not the one
 * tideScaleDefender massed for this particular hero. The creature prize is a share of
 * it (CONFIG.BANK_REWARD_SHARE), floored at the table value.
 *
 * WHY IT IS A SHARE. The tables pay a fixed prize against a fixed guard, which is a
 * sensible ratio right up until the guard stops being fixed: weekly growth, the
 * crawling peg and site respawn all move a real garrison, and a prize that ignores
 * them collapses. So a genuinely big guard still pays proportionally.
 *
 * WHY IT IS NOT A SHARE OF THE FIGHT. It was, and that closed a loop the chronicle
 * caught: the share was taken from the TIDE-INFLATED count while the difficulty that
 * count bought was clamped and measured at 0% attacker cost, so every bank paid ~10%
 * of the hero's own army back in creatures, and the next bank was then sized against
 * the bigger hero. Measured over one half-game: 24 bank and lair fights, 38.6M of
 * inflated guard value beaten, ~3.9M of free creatures against ~5.3M of total army
 * growth — three quarters of the army arrived as a refund on fights that cost nothing.
 * The tell was that the repel path already un-inflated the same number: the inflation
 * was a fiction when it would make the map harder and a fact when it paid the player.
 *
 * A HARD FIGHT STILL PAYS A PREMIUM, in gold — `cost` is what the battle actually took
 * out of the attacker (armyValue before minus after), which is the only reading of
 * "hard" the engine can defend, and gold does not size the next fight the way
 * creatures do. This is what keeps the docblock's original complaint answered now that
 * the sizer produces fights with a real price.
 *
 * The share is split across the reward's creature stacks rather than paid per stack,
 * so a two-stack prize is not quietly twice as valuable as a one-stack prize guarded
 * by the same army. The floor means an unscaled bank is untouched: 14 dwarves × 10% is
 * 1.4, which loses to the table's 4.
 *
 * Resources and the artifact roll are deliberately NOT scaled by anything.
 */
function grantBankReward(state, hero, bank, guardArmy = null, { cost = 0 } = {}) {
  const r = (bankDef(bank.bankType)?.reward) || {};
  const player = state.players[hero.owner];
  const got = { gold: 0, resources: {}, creatures: [], artifact: null };
  if (r.gold) { grant(player, { gold: r.gold }); got.gold = r.gold; }
  if (r.resources) { grant(player, r.resources); got.resources = { ...r.resources }; }
  // The premium for a hard fight, denominated in what the fight cost and paid in a
  // currency that cannot size the next one.
  // Bounded by the SITE, not by the attacker. The sizer now guarantees a scaled PvE
  // fight costs its attacker a target share of its own army, so an uncapped share of
  // that cost is not "a hard fight pays extra" — it is a payout that scales with the
  // army, which is the shape of the loop this whole change exists to close, wearing
  // gold instead of creatures. Measured uncapped, a 400-Archangel hero minted 187,320
  // gold at a treasury whose table pays 3,000. The ceiling is a multiple of what the
  // table already pays, so a bank's worth stays a property of the bank.
  const premiumCap = Math.round((r.gold || 0) * CONFIG.BANK_PREMIUM_MAX);
  const premium = Math.min(premiumCap, Math.max(0, Math.round((cost || 0) * CONFIG.BANK_COST_GOLD_SHARE)));
  if (premium > 0) { grant(player, { gold: premium }); got.gold += premium; }
  const rewardStacks = (r.creatures || []).length;
  const guarded = (guardArmy || []).reduce((n, st) => n + (st?.count || 0), 0);
  const share = rewardStacks > 0
    ? Math.round((guarded * CONFIG.BANK_REWARD_SHARE) / rewardStacks)
    : 0;
  for (const c of (r.creatures || [])) {
    const count = Math.max(c.count, share);
    if (addToArmy(hero.army, c.creature, count)) got.creatures.push({ ...c, count });
  }
  if (r.artifact) {
    const artId = rollBankArtifact(state, r.artifact);
    giveArtifact(state, hero, artId);
    got.artifact = artId;
  }
  bank.looted = true;
  markForRespawn(state, bank);
  return got;
}

/** Open a Pandora's Box: pay its rolled reward to the hero and spend it. Returns
 *  { got: summary, levels } (XP rewards may level the hero up). */
function grantPandoraReward(state, hero, box, { cost = 0 } = {}) {
  const r = box.reward || {};
  const player = state.players[hero.owner];
  const got = { kind: r.kind };
  let levels = 0;
  // THE HARD-FIGHT PREMIUM, the same one a creature bank pays and for the same
  // reason. A box's guard is rolled from the prize it stands over and then sized
  // UP against the world (tideSizeGuards at generation and at every respawn), and
  // massed again for the attacker at the moment of the fight — while the prize
  // itself stayed exactly what the table rolled. So the richer the world got, the
  // worse a box paid for what it cost to open. Reported together with the banks:
  // "these become very low as the guards grow… let's allow a prorated reward."
  //
  // Paid only on a GOLD box, and only in gold: an experience or artifact box is
  // not an economy prize and turning one into a gold fountain would be a
  // different mechanic wearing this one's name. Bounded exactly as the bank's is
  // — a multiple of what this box itself rolled — so a 2,000-gold box and a
  // 25,000-gold hoard still differ by what they are.
  if (r.kind === 'resource' && r.resource === 'gold' && cost > 0) {
    const cap = Math.round((r.amount || 0) * CONFIG.BANK_PREMIUM_MAX);
    const premium = Math.min(cap, Math.max(0, Math.round(cost * CONFIG.BANK_COST_GOLD_SHARE)));
    if (premium > 0) { grant(player, { gold: premium }); got.premium = premium; }
  }
  switch (r.kind) {
    case 'xp': levels = gainXp(state, hero, r.amount); got.amount = r.amount; break;
    // Report what was RESTORED, not what was offered: a hero already near their
    // pool takes only the top-up, and the toast used to claim the whole lump.
    case 'mana': {
      const was = hero.mana || 0;
      hero.mana = Math.min(heroMaxMana(hero), was + r.amount);
      got.amount = hero.mana - was;
      break;
    }
    case 'resource': grant(player, { [r.resource]: r.amount }); got.resource = r.resource; got.amount = r.amount; break;
    case 'artifact': giveArtifact(state, hero, r.artifact); got.artifact = r.artifact; break;
    // Report only what was actually GIVEN. `got.spell` was set unconditionally,
    // so a box whose spell the hero already knew still toasted "Pandora's Box
    // yields the Haste spell!" and handed over nothing — the one reward kind
    // that can silently be a no-op and the one that claimed otherwise.
    case 'spell':
      if (hero.spells.includes(r.spell)) got.knewSpell = r.spell;
      else { hero.spells.push(r.spell); got.spell = r.spell; }
      break;
    case 'creatures': for (const c of (r.creatures || [])) if (addToArmy(hero.army, c.creature, c.count)) (got.creatures ||= []).push({ ...c }); break;
    default: break;
  }
  box.looted = true;
  markForRespawn(state, box);
  return { got, levels };
}

/** One-line description of a Pandora's Box reward (for tooltips + toasts). */
export function pandoraRewardText(reward) {
  if (!reward) return 'a mystery';
  switch (reward.kind) {
    case 'xp': return `${reward.amount} experience`;
    case 'mana': return `${reward.amount} spell points`;
    case 'resource': return `${reward.amount} ${reward.resource}`;
    case 'artifact': return ARTIFACTS[reward.artifact]?.name || 'an artifact';
    case 'spell':
      if (reward.knewSpell) return `nothing — ${SPELLS[reward.knewSpell]?.name || 'that spell'} was already in the book`;
      return `the ${SPELLS[reward.spell]?.name || 'unknown'} spell`;
    case 'creatures': return (reward.creatures || []).map((c) => `${c.count} ${CREATURES[c.creature]?.name || c.creature}`).join(' + ');
    default: return 'a reward';
  }
}

/**
 * Tide of War (#8): keep PvE fights honest. When a player hero attacks a
 * neutral/world defender (wild stack, creature bank, Pandora guard) that is
 * weaker than `hardness × the hero's army value`, scale the defender's stacks
 * UP to that floor — never down, so a genuinely tough fight is left alone and
 * you simply cannot outgrow the map into walkovers. `hardness` is the player's
 * Settings choice (state.tideHardness). Deterministic (no RNG). A no-op in
 * Classic, for a neutral attacker, or against another player's hero/town —
 * those are real PvP, balanced by the ZPD intervention (#9) instead.
 *
 * `preview` (threaded from combatContext): compute EXACTLY the same scaled
 * defender — the hover card's whole purpose is to show the army the hero would
 * actually meet — but record nothing. pveScaleLog is the instrument that
 * answers "what were real encounters multiplied by", and before this flag every
 * pointermove over a monster appended a row, so the 400-entry ring filled with
 * hovers and the question it exists to answer became unanswerable.
 */
/**
 * Would this encounter be SIZED against the hero, without pricing it?
 *
 * The gate tideScaleDefender opens with, and nothing after it: the setting, a
 * human attacker, a kind that scales. All three are lookups, so the view can ask
 * this of every token on screen every frame, which the sizing itself could never
 * survive being asked.
 *
 * WHY THE VIEW NEEDS IT. "We have 5 griffins guarding a mine, I attack them and
 * they turn to 12k — other users may be too surprised." The number under a token
 * is `obj.count`, which is the truth about the object and a lie about the fight
 * the moment this returns true. A map that prints one and delivers the other is
 * not a map you can plan on, and the surprise is the whole complaint.
 */
export function pveWouldScale(state, attackerHero, obj) {
  if (!pveScalesToArmy(state)) return false;
  if (!attackerHero || attackerHero.owner < 0) return false;
  if (!state.players?.[attackerHero.owner]?.isHuman) return false;
  return obj?.type === 'monster' || obj?.type === 'creatureBank' || obj?.type === 'pandora';
}

export function tideScaleDefender(state, attackerHero, ctx, defender, { preview = false } = {}) {
  if (!pveScalesToArmy(state)) return;
  if (!attackerHero || attackerHero.owner < 0) return;
  // A HUMAN attacker only, and this is a correction to the older preset behaviour
  // rather than a carve-out for the new switch.
  //
  // The mechanic exists so a player cannot outgrow the map into walkovers. Nobody is
  // bored on the AI's behalf, and applying it to AI attackers actively breaks it: the
  // AI's courage gate prices a wild stack at its TRUE value (guardValueNear), then
  // fights something scaled to ~85% of its own army, so a gate reading "three to one in
  // my favour, attack" produces a near-even battle. Measured when this was first
  // switched on by default: ten test failures, all of them AI heroes dying on neutrals
  // they had correctly judged safe, including one the turtle logic then looked for and
  // could not find. Teaching the gate about the scaling does not help either — a
  // defender pinned at a fraction of YOUR army can never satisfy a superiority margin,
  // so the AI would simply stop clearing the map at all.
  if (!state.players?.[attackerHero.owner]?.isHuman) return;
  const scalable = defender.kind === 'monster'
    || defender.kind === 'creatureBank'
    || defender.kind === 'pandora';
  if (!scalable) return;
  // A stack that is standing there with a live, ACCEPTABLE offer to join is a
  // recruitment offer, not a fight, and must not be sized as one. This is the
  // reported defect: a band that would have joined was inflated to 220 Monks and
  // cost 52% of an army, because the offer and the scaling never consulted each
  // other. The gate is on ACCEPTABLE rather than merely offered — no room in the
  // army, no gold, or a refusal, and it IS a fight, so it scales like one.
  let offer = null;
  if (defender.kind === 'monster' && state.map && defender.objectId) {
    const stack = getObject(state, defender.objectId);
    if (stack) offer = parleyOffer(state, attackerHero, stack);
    // The offer is priced with a full auto-resolved battle (predictedFightLoss),
    // which is the single most expensive computation on this path — so hand it to
    // the caller on the context. The hover card needs the same offer for its
    // "would join for N gold" line, and before this it recomputed it from scratch:
    // two simulated battles per pointermove in a Diplomacy game.
    if (offer) ctx.parleyOffer = offer;
    if (offer?.acceptable) {
      ctx.joinOffered = true;
      if (!preview) recordPveScaling(state, ctx, 1, true, 'accepted');
      return;
    }
  }
  // WHY there was no offer, carried into the record. "Was this stack ever a join
  // candidate?" decides whether a x20 multiplier is the scaling misbehaving or
  // one branch of it misbehaving, and a bare false cannot answer that.
  const why = !offer ? 'not a wild stack'
    : (offer.offered ? (offer.refused ? 'refused' : 'cannot pay') : (offer.reason || 'no offer'));
  const army = ctx.defenderArmy;
  if (!army || !army.length) return;
  if (!(armyValue(attackerHero.army) > 0)) return;
  const hardness = Number.isFinite(state.tideHardness) ? state.tideHardness : CONFIG.TIDE_HARDNESS_DEFAULT;
  const mult = tideMultiplier(state, attackerHero, ctx, defender, hardness);
  if (!(mult > 1)) {
    // Already a real fight — never weakened. Recorded at x1 all the same: a
    // distribution of realized multipliers that only samples the fights that
    // WERE scaled would answer a different question than the one asked.
    if (!preview) recordPveScaling(state, ctx, 1, false, why);
    return;
  }
  for (const s of army) {
    if (s) s.count = Math.max(s.count, Math.round(s.count * mult));
  }
  ctx.tideScaled = true;    // the view can flag "the enemy has massed against you"
  ctx.tideScaleMult = mult; // (#8) so a repelled assault un-inflates on write-back
  if (!preview) recordPveScaling(state, ctx, mult, false, why);
}

/**
 * Derived, deterministic, and expensive to recompute: the hover card and the battle
 * that follows it must agree, and the card is rebuilt on every pointermove. Keyed on
 * everything the search reads, so a stale entry is not reachable; module-level rather
 * than on the state because it is a pure function of the key and must never ride a
 * save. Bounded — this is a cache, not a ledger.
 */
const TIDE_MULT_CACHE = new Map();

/** Returned by a probe that threw. Sorts as "no cost", so every comparison in the
 *  search reads it as "this is not a fight", and the search settles at x1. */
const TIDE_SEARCH_FAILED = Object.freeze([]);

/** The two DISJOINT probe-seed families. The search SELECTS on one and the guard
 *  VALIDATES on the other, so the guard judges the choice rather than confirming the
 *  same draws that produced it. Module constants, not CONFIG keys: they are an
 *  implementation detail of the search, and a CONFIG key that was never written is
 *  exactly how this separation was silently lost once already. */
const SEED_FAMILY_SEARCH = 0;
const SEED_FAMILY_GUARD = 1000;

/**
 * Everything the search reads about the WORLD — deliberately not the hardness dial.
 * The seed is drawn from this, so every dial position searches the same world and the
 * multipliers it returns are comparable across the dial: seeding on hardness too made
 * Relaxed and Brutal sample different battles, and the dial came out unordered.
 * Hardness still keys the CACHE, because it changes the answer.
 */
const armyBrief = (a) => (a || []).filter((s) => s && s.count > 0)
  .map((s) => `${s.creature}:${s.count}`).join(',');

/**
 * EVERYTHING about a commander that a simulated battle reads.
 *
 * `predictedArmyLoss` builds a REAL battle, so the sim sees the hero's artifacts
 * (heroStat adds artifactBonus), secondary skills, spellbook, war machines and
 * specialty — none of which the first version of the tide cache's key carried.
 * Equipping a weapon or learning a nuke between two visits to the same stack has
 * to re-price the fight.
 *
 * Its own function because TWO caches key on it now — the sizer's, and the hover
 * card's (monsterPreviewKey). Two hand-maintained copies of "what a battle reads"
 * would drift, and the way a cache key drifts is that it stops noticing a change:
 * silently, and only in the answers.
 */
function heroSimKey(hero) {
  if (!hero) return '';
  const stats = ['attack', 'defense', 'power', 'knowledge'].map((k) => hero.stats?.[k] || 0).join('/');
  const arts = Object.entries(hero.equipment || {}).sort().map(([k, v]) => `${k}:${v}`).join(',');
  const skills = Object.entries(hero.skills || {}).sort().map(([k, v]) => `${k}:${v}`).join(',');
  const spells = [...(hero.spells || [])].sort().join(',');
  const machines = Object.keys(hero.warMachines || {}).sort().join(',');
  const spec = hero.specialty
    ? `${hero.specialty.kind}:${hero.specialty.stat || hero.specialty.creature || ''}` : '';
  return `${armyBrief(hero.army)}|${stats}|${hero.mana ?? 0}|${hero.level ?? 1}`
    + `|${arts}|${skills}|${spells}|${machines}|${spec}`;
}

/**
 * The RULES a simulated battle runs under: the map's seed, the feature flags and
 * the realm's upgrade nodes. Two games alive in one tab on the same map seed but
 * different rules must not share an answer.
 */
function worldRulesKey(state) {
  const feats = Object.entries(state.features || {}).filter(([, v]) => v).map(([k]) => k).sort().join(',');
  const ups = [...(playerUpgrades(state) || [])].sort().join(',');
  return `${state.seed}|${feats}|${ups}`;
}

function tideWorldKey(state, hero, ctx, defender) {
  return `${worldRulesKey(state)}|${defender.kind}|${defender.objectId ?? ''}`
    + `|${armyBrief(ctx.defenderArmy)}|${heroSimKey(hero)}|${ctx.defenderDiscipline || 0}`;
}

/**
 * The identity of the hover card's answer for one encounter — everything that
 * answer is a function of, in one string.
 *
 * WHY THE ENGINE OWNS THIS. Hovering a monster prices a full auto-resolved battle
 * (combatContext under `preview`, which runs the tide sizer's ~100 sims and the
 * parley), so the view caches the result. It was building its own key from the
 * handful of fields that seemed to matter — the stack, the hero's army, stats,
 * mana and gold — and that key was missing most of what the answer actually reads:
 * the hero's artifacts, skills, spells, war machines and specialty, the feature
 * flags, the realm's upgrades, and the LEARNED TIDE BIAS, which moves after every
 * scaled fight. With a one-entry memo those gaps were nearly unreachable, because
 * the next hover of anything else evicted the entry. Widening the cache is exactly
 * what makes them reachable, so the key had to become honest first.
 *
 * The three extras the sizer's own key does not need:
 *
 *   THE TREASURY, because `offer.acceptable` is "can you afford them", and a card
 *   that says you can when you no longer can is a lie about the only actionable
 *   thing on it.
 *
 *   THE DAY, and the hero's tile. A nearby ronin joins the defence
 *   (ronins.interveningRonin, measured from the defender's ground), and ronins
 *   march at dawn — so the same stack really is a different fight tomorrow, and a
 *   different fight from two tiles further away.
 *
 *   THE CAPTAIN, through the same heroSimKey as any other commander: a band that
 *   takes one, or one that levels on somebody else's battle, is a harder fight
 *   with nothing else about the stack changed.
 */
export function encounterPreviewKey(state, hero, obj) {
  // WHAT THE HERO WOULD FACE, whatever shape the object keeps it in: a wild stack
  // carries its own creatures, a Pandora's Box and a creature bank carry a list of
  // guards. Both are priced by the same sizer through the same combatContext, so
  // both belong in the same key — and a bank that has been looted (or reloaded, or
  // re-rolled to another bankType by siteRespawn) is a different fight.
  //
  // `obj.guards` IS OVERLOADED, which is why the branch is on type and not on the
  // field: on a box or a bank it is the list of guard stacks, but on a wild stack
  // it is the ID OF THE PRIZE that stack protects (actions.GUARD_PRIZE_SKIP). Read
  // as a list there it would silently contribute nothing and key every guard alike.
  const defenders = obj.type === 'monster'
    ? `${obj.creature}:${obj.count}`
    : (obj.guards || []).map((g) => `${g.creature}:${g.count}`).join(',');
  return `${worldRulesKey(state)}|${heroSimKey(hero)}|${heroSimKey(roninHero(obj))}`
    + `|${hero.id}|${hero.x},${hero.y},${hero.z ?? 0}`
    + `|${obj.id}|${obj.type}|${obj.bankType || ''}|${obj.looted ? 1 : 0}|${defenders}`
    + `|${state.players?.[hero.owner]?.resources?.gold || 0}`
    // The scaling knobs are live-tunable mid-game (SettingsScene's applyLiveTuning)
    // and the bias is learned from outcomes (aiMemory.tideBias) — a slider move or
    // a lesson has to re-quote the massed count, not serve yesterday's.
    + `|${state.tideHardness}|${state.pveScaling}|${state.pacing}`
    + `|${tideBias(state).toFixed(3)}|${state.day || 0}`;
}

/**
 * How much to multiply this PvE defender by, found by SEARCHING the outcome instead
 * of computing a price ratio.
 *
 * The rule this replaces sized both sides with `armyValue` — Σ aiValue × count — and
 * asked for `hardness × the attacker's army`. It hit that target exactly and it did
 * not work, and the chronicle says why in one line: across 100 scaled battles of one
 * half-game the defender was built to a mean 1.093× the attacker's army value and the
 * attacker's mean loss was 0.46%, with 90 of the 100 costing literally nothing.
 * Printed multipliers spanned ×1.11 to ×1924.77 and every one of them landed in the
 * same [0.85, 1.25] band and died 100-0.
 *
 * Three separate blindnesses, all of them the same blindness:
 *   · `armyValue` carries no commander term, and the neutral it sizes against has no
 *     commander at all — so a scaled fight was (your stacks + a level-58 hero) against
 *     (1.09 × your stacks + nobody). In the physical damage model the commander enters
 *     multiplicatively on EVERY stack, so no additive proxy can track it.
 *   · aiValue is a price fitted for trades and rewards (see power.js), not a
 *     prediction of a fight; `reachFactor` and TIDE_TARGET_ABS_MAX were both patches
 *     on that gap, and the measured ×1924.77 says by how much they fell short.
 *   · bodies are the only lever, and a scaled guard is one stack on one hex, so
 *     overkill against it is free (CombatEngine skips retaliation when the target
 *     dies). Multiplying it buys progressively less.
 *
 * So ask the engine. `predictedArmyLoss` runs the same auto-resolve the fight will
 * run, under the same features and upgrades, with the real commander on the attacking
 * side — the only function guaranteed to agree with the one that decides the battle is
 * that function itself. Bracket upward, then bisect geometrically for the smallest
 * multiplier whose predicted cost reaches the target, holding the seed FIXED across
 * every probe so the search climbs army size rather than rng noise.
 *
 * Bounded on purpose. TIDE_MULT_MAX caps the search, and reaching it without hitting
 * the target is a real answer, not a failure: a single stack of peasants cannot be
 * made into a real fight for a millions-strong hero at any count, and recording the
 * capped multiplier says so, where the old rule quietly asked for 1,924× and reported
 * a hard fight that cost nothing.
 */
function tideMultiplier(state, hero, ctx, defender, hardness) {
  const worldKey = tideWorldKey(state, hero, ctx, defender);
  // The learned bias is IN THE KEY. It is an input to the search exactly like
  // hardness, and a cached answer from before the last battle taught the sizer
  // something would silently outlive the lesson — the cache is keyed on everything
  // the search reads precisely so a stale entry is unreachable.
  const bias = tideBias(state);
  // …and so is the whole SEARCH BUDGET, for the same reason. How many rounds a
  // probe simulates, how many seeds the median is taken over, how many the wipe
  // rate is taken over, how far the bracket reaches and how many times each
  // bisection halves — every one of them changes the answer the search arrives at,
  // so an answer found under one budget must not be served under another.
  //
  // They are constants in play, which is exactly what makes them easy to leave out
  // and hard to notice: omitting them costs nothing until an instrument sweeps one
  // to measure what it is worth, and then it does not merely fail to help — it
  // reports that every setting gives the identical answer in identical time,
  // because every setting after the first is a cache hit. That happened here,
  // twice, and both times the instrument was the thing that broke rather than the
  // game. Anything the search READS belongs in this key.
  const budget = [CONFIG.TIDE_PROBE_ROUNDS, CONFIG.TIDE_SEARCH_SEEDS, CONFIG.TIDE_GUARD_SEEDS,
    CONFIG.TIDE_SEARCH_BRACKET, CONFIG.TIDE_SEARCH_STEPS, CONFIG.TIDE_GUARD_STEPS].join(',');
  const key = `${worldKey}|${hardness}|${bias.toFixed(3)}|${budget}`;
  const hit = TIDE_MULT_CACHE.get(key);
  if (hit !== undefined) return hit;

  const before = armyValue(hero.army);
  // What this fight is aimed to cost — the difficulty dial, corrected by how far
  // the last several fights of this kind actually missed (aiMemory.tideBias). The
  // dial still decides the shape; this only closes the gap between the simulated
  // hero the search prices against and the person actually playing.
  // Deliberately allowed ABOVE the dial's own ceiling (TIDE_LOSS_MAX): a player
  // walking through Brutal is already aimed at its top, so clamping there would
  // make the correction dead precisely where it is needed. The wipe guard below is
  // what keeps the answer survivable — it rejects any multiplier that annihilates
  // the attacker too often — and that is a better safety than an aim cap, because
  // it measures the outcome rather than the intent.
  const target = Math.min(CONFIG.TIDE_BIAS_TARGET_MAX, tideTargetLoss(hardness) * bias);
  const wipeTol = tideWipeTolerance(hardness);
  const baseSeed = fightSeed(state, worldKey);
  const discipline = ctx.defenderDiscipline || 0;
  const base = (ctx.defenderArmy || []).filter((st) => st && st.count > 0);

  /** Sorted loss fractions over `k` seeds at multiplier `m`. Every seed derives from
   *  one base so the whole search reads the same world, and probing the same point
   *  twice is free. */
  /**
   * One probe seed per sample index, MIXED rather than strided.
   *
   * These were `baseSeed + i * 2654435761` — an arithmetic progression — and that
   * quietly broke the estimator: mulberry32's early output is correlated across seeds
   * a fixed stride apart, the first few draws of a battle (initiative, stack order)
   * dominate its outcome, and so all thirteen "independent" samples landed on the same
   * side of the cliff. Measured, a week-1 pikeman fight read as safe to the search and
   * as a 43%-lethal fight to any other seed family. A murmur3 finalizer over
   * (baseSeed, i) avalanches properly, so the samples are actually a sample.
   */
  const probeSeed = (i) => {
    // LOUD, never defaulted. `undefined + n` is NaN and Math.imul(NaN, k) is 0, so a
    // missing family silently collapses every sample onto a single draw. That happened
    // twice here — once from a call site that omitted the argument, once from a
    // `family = 0` default added to be safe, which then absorbed a CONFIG key that had
    // never been written. A default that swallows a missing dependency is worse than
    // the crash: this throws into the fail-safe, which scales nothing, which the
    // contract tests fail on immediately.
    if (!Number.isFinite(i)) throw new Error('tideMultiplier: non-finite probe index');
    let h = (baseSeed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  };
  let failed = false;
  // Losses per (multiplier, seed family), held in SEED ORDER so a later, wider read
  // EXTENDS an earlier narrow one instead of repeating it. Keying this on (m, k) meant
  // every guard probe re-ran the bisection's first simulations verbatim.
  //
  // FAIL SAFE on the probe. This search sits on the path every battle passes through
  // and reaches deep into the combat engine (heroStat dereferences hero.stats
  // unguarded, deployArmy touches creature data, spells touch the book). A malformed
  // hero or any future throw there must not take the fight down with it: `failed`
  // forces the whole search to x1, which is exactly the switch turned off.
  const memo = new Map();
  const at = (m, k, family) => {
    const mk = `${m.toFixed(4)}|${family}`;
    let losses = memo.get(mk);
    if (!losses) { losses = []; memo.set(mk, losses); }
    if (losses.length < k) {
      const army = base.map((st) => ({
        creature: st.creature, count: Math.max(st.count, Math.round(st.count * m)),
      }));
      for (let n = losses.length; n < k; n++) {
        try {
          losses.push(predictedArmyLoss(state, hero, army,
            { seed: probeSeed(family + n), discipline, rounds: CONFIG.TIDE_PROBE_ROUNDS }) / before);
        } catch { failed = true; return TIDE_SEARCH_FAILED; }
      }
    }
    return losses.slice(0, k).sort((a, b) => a - b);
  };
  const K = CONFIG.TIDE_SEARCH_SEEDS;
  const median = (m) => { const a = at(m, K, SEED_FAMILY_SEARCH); return a.length ? a[a.length >> 1] : 0; };
  /** Share of sampled seeds in which the army is destroyed outright. */
  const wipeRate = (m) => {
    const a = at(m, CONFIG.TIDE_GUARD_SEEDS, SEED_FAMILY_GUARD);
    if (!a.length) return 1; // a search that cannot measure must not be trusted to risk you
    return a.filter((v) => v >= CONFIG.TIDE_WIPE_AT).length / a.length;
  };

  let mult = 1;
  if (median(1) < target) {
    // Bracket on ONE seed: this only locates the order of magnitude, and a wrong guess
    // costs a bisection step rather than a wrong answer.
    let lo = 1, hi = 1, reached = false;
    for (let i = 0; i < CONFIG.TIDE_SEARCH_BRACKET; i++) {
      hi = Math.min(hi * CONFIG.TIDE_SEARCH_STRIDE, CONFIG.TIDE_MULT_MAX);
      if ((at(hi, 1, SEED_FAMILY_SEARCH)[0] ?? 0) >= target) { reached = true; break; }
      if (hi >= CONFIG.TIDE_MULT_MAX) break;
      lo = hi;
    }
    // The bracket's single seed can disagree with the median the bisection reads. With
    // no interval to bisect, the top of the bracket is the honest answer.
    if (reached && median(hi) < target) reached = false;

    if (!reached) {
      // Either the cap was reached without the fight ever biting, or the requested
      // cost is more than this defender can deliver at any count. Both are real
      // answers: one stack on one hex cannot threaten a large enough hero, because
      // overkill against a single stack costs the attacker nothing.
      mult = Math.max(1, hi);
    } else {
      // Bisect in LOG space — the search variable is a multiplier, so its midpoint is
      // geometric. `hi` always clears the target, so the invariant survives a cost
      // curve that is not perfectly monotone in the defender's own count.
      for (let i = 0; i < CONFIG.TIDE_SEARCH_STEPS; i++) {
        const mid = Math.sqrt(lo * hi);
        if (median(mid) >= target) hi = mid; else lo = mid;
      }
      // Take the bracket end NEAREST the target rather than the smallest one above it.
      // The cost curve is closer to a cliff than a slope — measured on a mid-game
      // pairing, x181 costs a median 1%, x206 costs 12% and x256 costs 100% — so where
      // the requested cost falls inside a step, "smallest at or above target" lands on
      // the far side of it. Choosing the nearer end keeps the dial ordered and errs
      // toward the fight that is too easy over the one that is catastrophic.
      mult = Math.max(1, Math.abs(median(lo) - target) <= Math.abs(median(hi) - target) ? lo : hi);

      // The wipe guard. Past the cliff the MEDIAN is still moderate while the tail is
      // already total: at x220 the median cost is 27% and one fight in seven kills the
      // army outright. Losing the commander is a different KIND of outcome, not a
      // worse roll of the same one, so it is bounded separately from the cost — and
      // bounded by the dial, because a player who asked for Brutal is asking for
      // exactly this risk and a player who asked for Relaxed is not.
      // ONE guard, two ways a fight can be worse than the one that was asked for: it
      // can cost far more than the dial said, or it can kill you far more often than
      // the dial said. They are not the same failure and neither implies the other —
      // measured at week 1, a x20 pikeman fight ran a median cost of 78% against a 20%
      // target, while a x15 troglodyte fight sat near its target cost and still wiped
      // the army one time in five.
      const tooHard = (m) => median(m) > target * CONFIG.TIDE_OVERSHOOT_MAX || wipeRate(m) > wipeTol;
      if (tooHard(mult)) {
        // Bisect DOWNWARD within a bounded window rather than searching back to 1. An
        // unbounded floor lets one unlucky sample at the bottom of the window collapse
        // the whole answer — measured, that turned a Relaxed x206 into x106 and a
        // Brutal x235 into x119, which is how the guard, not the search, made the dial
        // come out unordered. A bounded window can only soften the fight, and only by
        // a bounded amount.
        let risky = mult, safe = Math.max(1, mult / CONFIG.TIDE_GUARD_MAX_BACKOFF);
        for (let i = 0; i < CONFIG.TIDE_GUARD_STEPS; i++) {
          const mid = Math.sqrt(safe * risky);
          if (tooHard(mid)) risky = mid; else safe = mid;
        }
        mult = Math.max(1, safe);
      }
    }
  }

  // A search that could not measure must scale NOTHING. Without this the failure mode
  // is inverted: `median` reads a failed probe as zero cost, the bracket therefore
  // never clears the target, `reached` stays false, and the "best effort" branch hands
  // back TIDE_MULT_MAX — so a thrown sim would multiply the defender by 4,096 instead
  // of leaving the fight alone. Not caching the failure is deliberate too: it is a
  // property of a broken call, not of this encounter, and a later correct call must
  // not inherit it.
  if (failed) return 1;

  if (TIDE_MULT_CACHE.size >= CONFIG.TIDE_MULT_CACHE_MAX) {
    TIDE_MULT_CACHE.delete(TIDE_MULT_CACHE.keys().next().value);
  }
  TIDE_MULT_CACHE.set(key, mult);
  return mult;
}

/** How many realized-multiplier samples the ring holds. */
export const PVE_SCALE_LOG_MAX = 400;

/**
 * Record what a PvE defender was actually multiplied by, and whether a join
 * offer stood at the time.
 *
 * The question this exists to answer, asked in the brief: if x20-and-up only
 * ever happened on stacks that were sized as unaccepted recruitment offers, then
 * neutral scaling was never broken and one branch was. That is not answerable by
 * reading the code — the multiplier depends on the attacker, the stack and the
 * reach correction — so it is recorded. Bounded ring of plain data on the state,
 * like state.aiLog; nothing reads it back, and it draws no rng.
 */
export function recordPveScaling(state, ctx, mult, joinOffered, why = null) {
  const log = (state.pveScaleLog ||= []);
  log.push({
    day: state.day,
    mult: Math.round(mult * 100) / 100,
    joinOffered: !!joinOffered,
    why,
    kind: ctx?.defender?.kind || 'monster',
  });
  while (log.length > PVE_SCALE_LOG_MAX) log.shift();
}

/** The gift ladder (#9), strongest→weakest, filtered to creatures that exist and
 *  sorted by value so the intervention can MATCH a small gap with a smaller unit
 *  instead of a full archangel. Falls back to the single configured gift, then the
 *  strongest creature in the catalog, so it never returns empty. */
function tideGiftLadder() {
  const ladder = (CONFIG.TIDE_GIFT_LADDER?.length ? CONFIG.TIDE_GIFT_LADDER : [CONFIG.TIDE_GIFT_CREATURE])
    .filter((id) => CREATURES[id]);
  if (!ladder.length) {
    const strongest = Object.keys(CREATURES).reduce(
      (best, id) => ((CREATURES[id].aiValue || 0) > (CREATURES[best]?.aiValue || 0) ? id : best),
      Object.keys(CREATURES)[0],
    );
    if (strongest) ladder.push(strongest);
  }
  return ladder.sort((a, b) => (CREATURES[b].aiValue || 0) - (CREATURES[a].aiValue || 0));
}

/** The STRONGEST gift creature whose single-unit value fits `budget` (so at least
 *  one can be gifted without overshooting parity), or null if even the smallest
 *  exceeds it — in which case the underdog is close enough that any gift would
 *  overshoot, so the gods stay their hand. */
function tideGiftForBudget(budget) {
  if (!(budget > 0)) return null;
  for (const id of tideGiftLadder()) {
    if ((CREATURES[id].aiValue || Infinity) <= budget) return id;
  }
  return null;
}

/**
 * Tide of War (#9): divine ZPD intervention. In a lopsided battle, if the
 * weaker side is a HERO we can bolster — the attacker, or the defender in PvP —
 * and it sits below TIDE_INTERVENTION_THRESHOLD × the opponent, roll the level's
 * chance; on a hit, gift that hero elite creatures until it reaches ~TARGET ×
 * the opponent. Neutral PvE stacks are the obstacle, not a beneficiary (a weak
 * one is instead lifted by #8). Aggregate-fair, not telegraphed: a predictable
 * rate + magnitude that makes skill decide, and it helps whichever side is the
 * underdog — the AI included. One seeded rng draw per qualifying battle, so it
 * stays reproducible from state. A no-op in Classic.
 */
export function tideDivineIntervention(state, attackerHero, ctx, defender) {
  if (!tideOfWar(state) || !state.rng) return;
  // Never against a defender #8 just built. The gods relieve a player who walked into
  // something too big for them; a tide-scaled guard is not that — it is lopsided BY
  // CONSTRUCTION, sized to cost the attacker a target share of its army, and gifting
  // against it is one Tide system undoing the other's whole job.
  //
  // This could not fire before and now can, which is why the guard is new rather than
  // original. The old sizer pinned a scaled defender at =<1.25x the attacker's army
  // VALUE while `atkVal` below counts the commander too, so the ratio was never
  // lopsided and the branch was unreachable for a scaled PvE fight. Sizing by outcome
  // buys real bodies, the ratio inverts, and the mercy starts firing on every
  // deliberately-hard fight. Unscaled encounters — a guard genuinely bigger than the
  // floor, and every PvP battle — are untouched.
  if (ctx.tideScaled) return;
  const chance = CONFIG.TIDE_INTERVENTION_CHANCE[state.tideIntervention] || 0;
  if (chance <= 0) return;
  const power = Number.isFinite(state.tideInterventionPower)
    ? state.tideInterventionPower : CONFIG.TIDE_INTERVENTION_POWER_DEFAULT;
  if (power <= 0) return;                     // magnitude turned all the way down
  // "Force" counts the COMMANDER, not just the stacks: a hero with a small army
  // but big attack/defense and a full mana bar of nukes isn't the underdog its
  // armyValue suggests. The hero-power weight (Settings slider) scales that in;
  // 0 falls back to armies only. So a spell-heavy hero is neither over-gifted nor
  // under-rated as a threat.
  const hpw = Number.isFinite(state.heroPowerWeight) ? state.heroPowerWeight : CONFIG.HERO_POWER_WEIGHT_DEFAULT;
  const defHero = defender.kind === 'hero' ? state.heroes[defender.heroId] : null;
  const atkVal = effectiveForce(attackerHero.army, attackerHero, hpw);
  const defVal = armyValue(ctx.defenderArmy) + (defHero ? hpw * heroPowerValue(defHero) : 0);
  // The weaker side — but only if it's a hero we can reinforce.
  let hero, ownVal, oppVal, isDefender = false;
  if (atkVal <= defVal) { hero = attackerHero; ownVal = atkVal; oppVal = defVal; }
  else if (defHero) { hero = defHero; ownVal = defVal; oppVal = atkVal; isDefender = true; }
  if (!hero || oppVal <= 0) return;
  if (ownVal >= CONFIG.TIDE_INTERVENTION_THRESHOLD * oppVal) return; // not lopsided enough
  // TWO seeded rolls, in order (reproducible from state):
  //   1) IF it fires — the level's chance.
  //   2) HOW BIG — a random target multiple in [FLOOR, power] of the foe. The
  //      slider (power) can reach 2.0, so a fired rescue may lift the underdog to
  //      anywhere from ~half the foe up to DOUBLE it — variety, not a fixed cap.
  if (state.rng.random() >= chance) return;
  const floor = Math.min(CONFIG.TIDE_INTERVENTION_TARGET_FLOOR, power);
  const target = floor + state.rng.random() * (power - floor);
  const budget = target * oppVal - ownVal;
  const gift = tideGiftForBudget(budget);
  if (!gift) return;                          // too close for any gift without overshooting
  const per = CREATURES[gift]?.aiValue || 1;
  let n = Math.floor(budget / per);
  if (n < 1) return;
  if (!addToArmy(hero.army, gift, n)) {
    // Army full (all 7 slots, no matching stack): rather than shrug — the bug
    // where a full-but-weak army got NOTHING while an emptier one got 3k
    // archangels — EVICT the weakest stack and take its slot. "Weakest" is total
    // aiValue × count, which already blends attack/defense/health/damage and
    // shooter status (range) into one number, scaled by the stack size. Re-size
    // the gift to also REPLACE the evicted value so parity still lands near
    // target, and only swap when it's a genuine net gain (never weaken the army).
    const slot = weakestStackSlot(hero.army);
    if (slot < 0) return;
    const ev = hero.army[slot];
    const evVal = (CREATURES[ev.creature]?.aiValue || 0) * ev.count;
    n = Math.floor((budget + evVal) / per);
    if (n < 1 || n * per <= evVal) return;    // no net gain — the gods shrug
    hero.army[slot] = { creature: gift, count: n, hurt: 0 };
  }
  // A gifted DEFENDER needs its battle force rebuilt from the reinforced army;
  // the attacker fights its own real army directly, so no rebuild there.
  if (isDefender) ctx.defenderArmy = hero.army.map((s) => (s ? { ...s } : null)).filter(Boolean);
  ctx.divineGift = { heroId: hero.id, creature: gift, count: n };
  logMsg(state, `Divine intervention! The heavens send ${n} ${CREATURES[gift]?.name || gift} to bolster ${hero.name}.`);
}


/** Index of the army's WEAKEST occupied slot by total aiValue × count (−1 if the
 *  army is empty). Used to make room for a divine gift when all slots are full. */
function weakestStackSlot(army) {
  let idx = -1, low = Infinity;
  for (let i = 0; i < army.length; i++) {
    const s = army[i];
    if (!s) continue;
    const v = (CREATURES[s.creature]?.aiValue || 0) * s.count;
    if (v < low) { low = v; idx = i; }
  }
  return idx;
}

/**
 * Draw an amount from a weighted [{ weight, min, max }] table. One rng draw picks
 * the tier and a second the amount inside it, so a table's shape is independent of
 * how many tiers it has.
 */
export function rollWeightedGold(rng, tiers) {
  // ONE draw, not two. A chest's contents are rolled from state.rng, and every
  // extra draw shifts the shared stream for everything downstream — a first
  // attempt spent two and broke unrelated map-layout and AI tests. So draw a
  // single fine-grained uniform, use it to select the tier, and reuse the leftover
  // position WITHIN that tier to pick the amount.
  const total = tiers.reduce((n, t) => n + t.weight, 0);
  const GRAIN = 100000;
  const draw = rng.int(0, GRAIN - 1);
  let acc = 0;
  for (const t of tiers) {
    const span = Math.round((t.weight / total) * GRAIN);
    if (draw < acc + span || t === tiers[tiers.length - 1]) {
      const within = span > 1 ? (draw - acc) / (span - 1) : 0;
      const frac = Math.min(1, Math.max(0, within));
      return t.min + Math.round(frac * (t.max - t.min));
    }
    acc += span;
  }
  const last = tiers[tiers.length - 1];
  return last.min;
}

// ===========================================================================
// TERRITORIAL DEFENCE (see core/holdings.js for the costs and the reasoning)
// ===========================================================================

/**
 * Take a holding, and post a WATCH on it.
 *
 * The watch is free and automatic, which is the point: "unguarded" stops being
 * the default state of the world. It buys no combat — the next hero still walks
 * in — but the seizure is announced and dated to its owner, and an unannounced
 * seizure is the part that made ownership feel weightless. Any garrison that was
 * standing here is gone (it lost, or there was none); masonry STAYS, because a
 * wall does not fall down when the flag above it changes.
 */
/**
 * Detach a garrison from the army that just took a town: the weakest stacks
 * first, up to a share of the taker's value, so the conqueror keeps its punch
 * and the town keeps a real defence. Moves troops, never mints them.
 *
 * A HUMAN'S ARMY IS NEVER MOVED FOR THEM. Reported as "when taking a town, a
 * portion of my army is automatically relocated to the town — I want this not to
 * happen, and if I have to leave army in the town it to be my choice", and that is
 * the right call: the rule exists to stop a town changing hands five times in four
 * days by making the SECOND capture cost something, and a player standing in the
 * town screen can price that for themselves stack by stack. An AI realm cannot —
 * it has no screen to stand in and no way to be asked — so it keeps the automatic
 * detachment, which is also where the anti-ping-pong pressure was needed: it is
 * the rival's towns that used to be free to take back the next morning.
 *
 * Returns the value actually left behind (0 when the taker is human).
 */
export function leaveCaptureGarrison(state, town, attacker) {
  if (state?.players?.[attacker?.owner]?.isHuman) {
    logMsg(state, `${town.name} stands without a garrison — leave one from the town screen if you mean to hold it.`);
    return 0;
  }
  const want = captureGarrisonValue(armyValue(attacker.army));
  let left = want;
  const order = attacker.army
    .map((st, i) => ({ st, i }))
    .filter(({ st }) => st && st.count > 0)
    .sort((x, y) => armyValue([x.st]) - armyValue([y.st]));
  for (const { st, i } of order) {
    if (left <= 0) break;
    // Never strip the attacker to nothing: a hero must march out of the town it
    // just took with an army, or the capture is a suicide.
    if (attacker.army.filter((x) => x && x.count > 0).length <= 1) break;
    const per = armyValue([{ creature: st.creature, count: 1 }]);
    if (per <= 0) continue;
    const take = Math.min(st.count - 1, Math.ceil(left / per));
    if (take <= 0) continue;
    if (!addToArmy(town.garrison, st.creature, take)) break;
    st.count -= take;
    if (st.count <= 0) attacker.army[i] = null;
    left -= take * per;
  }
  return want - Math.max(0, left);
}

export function claimHolding(state, obj, newOwner) {
  const old = obj.owner;
  const d = obj.defence || (obj.defence = {});
  if (old >= 0 && old !== newOwner && d.watch) {
    const what = obj.type === 'mine' ? mineName(obj.mineType) : dwellingName(obj);
    logMsg(state, `Day ${state.day}: ${state.players[newOwner]?.name || 'Someone'} `
      + `seized your ${what} at ${obj.x},${obj.y}.`, old);
    recordEvent(state, 'holding', {
      what, from: state.players[old]?.name || 'neutral',
      to: state.players[newOwner]?.name || 'neutral', at: `${obj.x},${obj.y}`,
    });
  }
  obj.owner = newOwner;
  d.garrison = [];
  d.watch = true;
  d.since = state.day;
  // How often this ground has actually been fought over. The AI reads it to
  // decide what earns masonry — a holding nobody contests does not need walls.
  if (old >= 0 && old !== newOwner) d.contested = (d.contested || 0) + 1;
  return obj;
}

/**
 * Buy `bodies` more garrison for a holding you own. Returns what was actually
 * bought (gold may run short, and a holding has a maximum it can billet).
 */
export function garrisonHolding(state, obj, bodies) {
  if (!isHolding(obj) || obj.owner < 0 || !(bodies > 0)) return 0;
  const player = state.players[obj.owner];
  const d = obj.defence || (obj.defence = { watch: true, since: state.day });
  d.garrison = d.garrison || [];
  const creature = garrisonCreature(state, obj.owner);
  const unit = garrisonUnitCost(state, obj.owner);
  const standing = d.garrison.reduce((n, st) => n + (st ? st.count : 0), 0);
  const room = Math.max(0, CONFIG.DEFENCE_GARRISON_MAX - standing);
  const afford = Math.floor((player.resources.gold || 0) / unit);
  const take = Math.min(bodies, room, afford);
  if (take <= 0) return 0;
  pay(player, { gold: take * unit });
  const existing = d.garrison.find((st) => st && st.creature === creature);
  if (existing) existing.count += take;
  else d.garrison.push({ creature, count: take, hurt: 0 });
  return take;
}

/** Raise a permanent fortification over a holding you own. One-off gold. */
export function fortifyHolding(state, obj) {
  if (!isHolding(obj) || obj.owner < 0) return false;
  const player = state.players[obj.owner];
  const d = obj.defence || (obj.defence = { watch: true, since: state.day });
  if (d.fortified) return false;
  if (!canAfford(player, { gold: CONFIG.DEFENCE_FORTIFY_COST })) return false;
  pay(player, { gold: CONFIG.DEFENCE_FORTIFY_COST });
  d.fortified = true;
  return true;
}

/**
 * Pay a holding's garrison to stand down instead of fighting it.
 *
 * Ownership changes without a battle, the defenders disperse, and the gold goes
 * to the DEFENDER — so being bought out of your frontier is a transfer, not a
 * deletion, and the loser can spend what they were paid. Returns the price paid,
 * or 0 when the offer could not be made.
 */
export function buyoutHolding(state, hero, obj) {
  if (!isHolding(obj) || !isDefended(obj)) return 0;
  if (obj.owner === hero.owner || sameTeam(state, obj.owner, hero.owner)) return 0;
  const buyer = state.players[hero.owner];
  const price = buyoutPrice(state, obj);
  if (!price || !canAfford(buyer, { gold: price })) return 0;
  pay(buyer, { gold: price });
  const seller = state.players[obj.owner];
  if (seller) seller.resources.gold = (seller.resources.gold || 0) + price;
  const what = obj.type === 'mine' ? mineName(obj.mineType) : dwellingName(obj);
  logMsg(state, `${hero.name} paid ${price} gold; the garrison of the ${what} marched away.`);
  claimHolding(state, obj, hero.owner);
  return price;
}

/**
 * Build a combat context for the encounter `attackerHero` vs `defender`
 * (defender: { kind: 'monster'|'creatureBank'|'pandora'|'holding'|'hero'|'town', … }).
 * The actual battle runs in core/combat/CombatEngine.js; when it ends, call
 * applyCombatResult with the engine's result.
 *
 * This is an ACTION, not a query: its tail applies the Tide of War effects, and
 * one of them (tideDivineIntervention) draws from the seeded gameplay RNG and
 * writes creatures into a hero's army. Callers that only want to DESCRIBE the
 * encounter — the hover card, any future preview UI — must pass
 * `{ preview: true }`:
 *
 *   · tideScaleDefender still runs in full, because it is deterministic and
 *     writes only into the context's own defender copy — the card's stated
 *     purpose is to show the army the hero would actually meet, and the preview
 *     produces byte-identical numbers to the real encounter;
 *   · but it records nothing (pveScaleLog is for real encounters only), and
 *   · tideDivineIntervention is skipped entirely. That is not the card lying:
 *     the intervention is rolled when the battle actually starts, is documented
 *     as "aggregate-fair, not telegraphed", and bolsters the UNDERDOG HERO —
 *     nothing the defender-facing card displays. Running it from a preview was
 *     the reported CRITICAL defect: hovering a monster under Tide of War gifted
 *     the hero a free army and burned seeded RNG draws, so two players on the
 *     same seed diverged based on where they moved the pointer.
 *
 * A full split into a pure builder plus an explicit applyTideEffects() was
 * considered and rejected: it would touch every real caller (stepHero,
 * tryEngage, the AI) and twenty-odd test call sites to express exactly the same
 * two-mode behaviour, and the default here keeps every existing caller an
 * action, so nobody can forget to apply the effects before a real battle.
 */
export function combatContext(state, attackerHero, defender, { preview = false } = {}) {
  // WHAT THIS COST, stamped on the answer. Building an encounter is the most
  // expensive thing a click can ask for — the Tide of War sizer runs a bracket, a
  // bisection and a wipe guard, each probe a full auto-resolved battle — and it
  // is the one cost a player experiences as the game stopping. Measured on a real
  // day-57 game it is 15-180ms for every kind of defender, so a reading far above
  // that is a fact worth having rather than a thing to reason about: the view
  // reports it (AdventureScene._doLaunchCombat) when it crosses
  // CONFIG.SLOW_ENCOUNTER_MS, naming the defender, so a report of "attacking X
  // takes several seconds" can be answered from the console instead of guessed at.
  const t0 = performance.now();
  const ctx = { attackerHeroId: attackerHero.id, defender };
  if (defender.kind === 'monster') {
    const obj = getObject(state, defender.objectId);
    ctx.defenderArmy = [{ creature: obj.creature, count: obj.count, hurt: 0 }];
    ctx.defenderName = `${CREATURES[obj.creature]?.name || 'Creature'}s`;
    // An invader war-band fights with better weapons and harder drill than the
    // same creatures found wild — and is named for its people, not its species.
    if (obj.invader) {
      ctx.defenderDiscipline = obj.invader.discipline || 0;
      // No trailing "s": the creature names are already the form we want, and
      // gluing one on produced "Pikemans" on the battle banner.
      ctx.defenderName = `${obj.invader.peopleName} — ${CREATURES[obj.creature]?.name || 'warriors'}`;
    }
  } else if (defender.kind === 'creatureBank') {
    const bank = getObject(state, defender.objectId);
    ctx.defenderArmy = (bank?.guards || []).map((s) => ({ creature: s.creature, count: s.count, hurt: 0 }));
    ctx.defenderName = bankDef(bank?.bankType)?.name || 'Creature Bank';
  } else if (defender.kind === 'holding') {
    const obj = getObject(state, defender.objectId);
    const d = defenceOf(obj) || {};
    ctx.defenderArmy = (d.garrison || []).map((st) => ({ creature: st.creature, count: st.count, hurt: 0 }));
    ctx.defenderName = obj?.type === 'mine' ? mineName(obj.mineType) : dwellingName(obj);
    if (d.fortified) ctx.defenseBonus = CONFIG.DEFENCE_FORTIFY_BONUS;
  } else if (defender.kind === 'pandora') {
    const box = getObject(state, defender.objectId);
    ctx.defenderArmy = (box?.guards || []).map((s) => ({ creature: s.creature, count: s.count, hurt: 0 }));
    ctx.defenderName = "Pandora's Box";
  } else if (defender.kind === 'hero') {
    const enemy = state.heroes[defender.heroId];
    ctx.defenderArmy = enemy.army.map((s) => (s ? { ...s } : null)).filter(Boolean);
    ctx.defenderHeroId = enemy.id;
    ctx.defenderName = enemy.name;
  } else if (defender.kind === 'town') {
    const town = state.towns[defender.townId];
    const merged = mergedTownArmy(state, town);
    ctx.defenderArmy = merged.army;
    ctx.defenderReserve = merged.reserve;
    ctx.defenderHeroId = merged.heroId;
    ctx.defenderName = town.name;
    ctx.siege = true;
    // Real fortifications: the Fort tier raises a destructible wall + moat and
    // hands the attacker a Catapult (CombatEngine.buildFortifications). The old
    // flat defense bonus still applies on top (defenders on the walls are harder
    // to hit), so this is additive, not a rebalance.
    ctx.fortTier = town.buildings.includes('castle') ? 3
      : town.buildings.includes('citadel') ? 2
      : town.buildings.includes('fort') ? 1 : 0;
    ctx.defenseBonus = [0, 2, 3, 4][ctx.fortTier];
  }
  // A masterless captain standing near the fight joins whoever was ATTACKED, which
  // in this engine is always `defender` — the attacker is the side that moved. Done
  // BEFORE the Tide sizer, so the sizer prices the fight the player will actually
  // walk into rather than the one that existed before the ronin stepped in.
  roninReinforce(state, attackerHero, ctx);
  // Tide of War (#8): scale a too-easy PvE defender up to the challenge floor.
  // Runs in preview too (deterministic, ctx-local) so the card shows the true
  // massed defender; only the pveScaleLog record is suppressed.
  tideScaleDefender(state, attackerHero, ctx, defender, { preview });
  // Tide of War (#9): in a lopsided battle, the gods may gift the underdog.
  // NEVER from a preview — it draws seeded rng and mutates a hero's army.
  if (!preview) tideDivineIntervention(state, attackerHero, ctx, defender);
  // ---- naval tagging ----
  // A battle joined from (or against) a boat is fought at sea. The battle
  // "happens" on the ATTACKER's tile — attackers never enter the defender's
  // tile (see applyCombatResult) — so a boat attacker, a boat defender, or an
  // attacker standing on water all make the battle naval. The view reads
  // `ctx.naval` (or `ctx.terrain === 'water'`) to pick a sea battlefield
  // backdrop; land battles carry neither field, exactly as before. The combat
  // engine itself treats terrain as visual-only (createBattle stores it and
  // applies no terrain bonus), so 'water' needs no engine handling.
  const defBoatHero = defender.kind === 'hero' ? state.heroes[defender.heroId] : null;
  const attackerTile = tileAt(state, attackerHero.x, attackerHero.y, attackerHero.z ?? 0);
  if (attackerHero.onBoat || defBoatHero?.onBoat || attackerTile?.terrain === 'water') {
    ctx.naval = true;
    ctx.terrain = 'water';
  }
  ctx.builtMs = Math.round(performance.now() - t0);
  return ctx;
}

/**
 * Garrison + visiting hero merged into up to 7 stacks (siege defense).
 * Stacks that don't fit stay home as `reserve` — they sit out the battle but
 * are NOT lost if the defense holds (see applyCombatResult).
 */
function mergedTownArmy(state, town) {
  const hero = town.visitingHeroId ? state.heroes[town.visitingHeroId] : null;
  const army = [];
  const reserve = [];
  const push = (stack) => {
    if (!stack || stack.count <= 0) return;
    const same = army.find((s) => s.creature === stack.creature);
    if (same) same.count += stack.count;
    else if (army.length < CONFIG.ARMY_SLOTS) army.push({ ...stack });
    else reserve.push({ ...stack });
  };
  if (hero) for (const s of hero.army) push(s);
  for (const s of town.garrison) push(s);
  return { army, reserve, heroId: hero ? hero.id : null };
}

/**
 * Necromancy: after a victory, reanimate a fraction of the slain enemy as
 * skeletons and fold them into the victor's army. Only the MORTAL fallen count
 * — the already-dead (other undead) and mindless war machines cannot be raised.
 * HoMM3-style: a `necromancy%` slice of the fallen HP becomes skeletons, capped
 * at the number of creatures actually slain. Returns how many were raised.
 */
function raiseSkeletons(state, hero, deadArmy) {
  const pct = skillValue(hero, 'necromancy');
  if (!pct || !deadArmy || !deadArmy.length) return 0;
  let deadHP = 0, deadCount = 0;
  for (const s of deadArmy) {
    const c = CREATURES[s?.creature];
    if (!c || c.undead || c.faction === 'machine') continue;
    deadHP += (s.count || 0) * (c.health || 1);
    deadCount += (s.count || 0);
  }
  if (deadCount <= 0) return 0;
  const raised = Math.min(deadCount, Math.floor((pct * deadHP) / CREATURES.skeleton.health));
  if (raised <= 0) return 0;
  if (!addToArmy(hero.army, 'skeleton', raised)) return 0; // no room in the army
  logMsg(state, `${hero.name} raised ${raised} skeleton${raised === 1 ? '' : 's'} from the fallen.`);
  return raised;
}

/**
 * Apply a finished battle to the world.
 * result: {
 *   attackerWon: bool,
 *   attackerArmy: [stacks], defenderArmy: [stacks],  // survivors
 *   xp: number (for the winner's hero),
 * }
 * Returns events for the UI ({ type:'levelUp' } etc.).
 *
 * Naval battles (ctx.naval) need no special casing for movement here: the
 * attacker never moved onto the defender's tile (stepHero deducts MP and leaves
 * the hero in place), so a boat attacker simply remains onBoat at its own water
 * tile — a won siege flips the town's owner WITHOUT the raider entering it, and
 * a slain enemy/monster is removed as usual (the attacker's own water tile holds
 * no object, so the prize-under-guard sweep is a no-op). The one naval-specific
 * touch (v2): a defeated boat hero — attacker OR defender — leaves a drifting
 * derelict boat where they sank (leaveDerelictBoat), so the wreck can be
 * reclaimed rather than the boat vanishing with its captain.
 */
/** A guaranteed nemesis-bounty artifact: a mid-tier (value 2–3) relic, rolled
 *  deterministically off the shared rng. */
function rollBountyArtifact(state) {
  const pool = Object.keys(ARTIFACTS).filter((id) => ARTIFACTS[id].value >= 2 && ARTIFACTS[id].value <= 3);
  return state.rng.pick(pool.length ? pool : Object.keys(ARTIFACTS));
}

/**
 * Brand `winner` a NEMESIS of the player whose hero (`loser`) it just slew: it
 * remembers how many of that player's heroes it has killed (driving both its
 * anti-that-player battle edge and the bounty it carries) and takes a title
 * named for its latest victim. Enemies only — an ally's death brands nobody.
 */
function brandNemesis(state, winner, loser) {
  if (!winner || !loser) return;
  if (winner.owner === loser.owner || sameTeam(state, winner.owner, loser.owner)) return;
  winner.nemesisOf = winner.nemesisOf || {};
  winner.nemesisOf[loser.owner] = (winner.nemesisOf[loser.owner] || 0) + 1;
  const total = Object.values(winner.nemesisOf).reduce((n, k) => n + k, 0);
  winner.nemesisTitle = total >= 3 ? `Dread Bane of ${loser.name}` : `Bane of ${loser.name}`;
}

/**
 * If `fallen` was a nemesis of `victor`'s player, claim the bounty for finally
 * putting it down: bonus XP (scaled by how many of your heroes it had slain) and
 * a guaranteed mid-tier artifact. Returns the award (for the debrief), or null.
 */
function nemesisBounty(state, victor, fallen) {
  if (!victor || !fallen?.nemesisOf) return null;
  const kills = fallen.nemesisOf[victor.owner] || 0;
  if (kills <= 0) return null;
  const xp = kills * CONFIG.NEMESIS.BOUNTY_XP;
  const levels = gainXp(state, victor, xp);
  const artifact = rollBountyArtifact(state);
  giveArtifact(state, victor, artifact);
  return { xp, artifact, kills, levels };
}

/**
 * Resolve a hero-vs-hero kill for the nemesis system: FIRST pay the victor any
 * bounty owed for slaying its own nemesis, THEN brand the victor a nemesis of the
 * fallen hero's player. (Bounty first, so the fallen's brand is still readable.)
 */
function resolveHeroDuel(state, winner, loser, events) {
  if (!winner || !loser) return;
  const bounty = nemesisBounty(state, winner, loser);
  if (bounty) {
    logMsg(state, `${winner.name} slew the nemesis ${loser.name} — a bounty of ${bounty.xp} XP and an artifact!`);
    events.push({ type: 'nemesisBounty', heroId: winner.id, ...bounty });
  }
  brandNemesis(state, winner, loser);
  if (winner.nemesisTitle) events.push({ type: 'nemesisBrand', heroId: winner.id, title: winner.nemesisTitle });
}

/**
 * Sunk-Cost Siege (#14): the decayed memory of army value player `owner` has
 * lost in FAILED assaults on `town` — fades linearly to 0 over SUNK_COST_DECAY_DAYS.
 * Exported so the AI can read it when weighing another attack on the same town.
 */
export function decayedSiegeLoss(town, owner, day) {
  const mem = town?.aiSiegeLosses?.[owner];
  if (!mem) return 0;
  const age = day - mem.day;
  if (age >= CONFIG.SUNK_COST_DECAY_DAYS) return 0;
  return mem.value * (1 - age / CONFIG.SUNK_COST_DECAY_DAYS);
}

/** Record an AI attacker's loss in a failed assault on `town` (bounded + decayed). */
function recordSiegeLoss(state, town, attacker, lostValue) {
  if (!town || !attacker || lostValue <= 0 || !featureOn(state, 'sunkCostSiege')) return;
  const owner = attacker.owner;
  const p = state.players[owner];
  if (!p || p.isHuman) return; // an AI foible — the human's own losses never bias it
  town.aiSiegeLosses = town.aiSiegeLosses || {};
  const prev = decayedSiegeLoss(town, owner, state.day);
  town.aiSiegeLosses[owner] = { value: Math.min(CONFIG.SUNK_COST_CAP, prev + lostValue), day: state.day };
}

export function applyCombatResult(state, ctx, result) {
  const events = [];
  const attacker = state.heroes[ctx.attackerHeroId];
  const defenderHero = ctx.defenderHeroId ? state.heroes[ctx.defenderHeroId] : null;
  // Army value the attacker committed (pre-writeback), for Sunk-Cost Siege (#14).
  const attackerCommitted = attacker ? armyValue(attacker.army) : 0;

  // Blessings from fountains/temples are spent, win or lose.
  if (attacker) { attacker.tempLuck = 0; attacker.tempMorale = 0; }
  if (defenderHero) { defenderHero.tempLuck = 0; defenderHero.tempMorale = 0; }

  // AI learning (#): note the human's tactics (did they Blind us?) so the AI
  // adapts. Runs for every human-fought battle — win, loss, or flight.
  recordHumanBattleMemory(state, result);
  // …and grade the SIZER on the same battle: it aimed this fight at a cost, and
  // this is the only place that knows what the fight actually cost. Restricted to
  // the case the sizer actually prices — a human attacker against a PvE defender —
  // because grading it on a battle it did not aim would be teaching it from
  // somebody else's homework. See aiMemory.recordTideOutcome.
  gradeTideAim(state, ctx, result, attackerCommitted);

  // The long watch's counter (see noteInvaderBattle). Booked HERE for the same
  // reason the chronicle below is: this is the one choke point every battle in the
  // game passes through, so an age measured in battles cannot miss one. Booked on
  // the FIGHT, not on the win — surviving a wall you did not hold is still a turn
  // spent on the coast, and an objective that only counted victories would ask a
  // losing realm to win its way to the end of a war it is losing.
  noteInvaderBattle(state, ctx, attacker);

  // The chronicle. Written HERE because this is the one choke point every battle in the
  // game passes through — interactive, autoFight, auto-resolved — so nothing can be
  // fought without being written down, and BEFORE the write-backs below mutate either
  // side. Both armies priced before and after is the single most useful line in the log:
  // "one hero, five commanders, twenty marksmen lost" is a sentence a log states in
  // numbers, and it took a simulator to establish the first time.
  const ownerName = (i) => (i >= 0 ? state.players?.[i]?.name : null) || 'neutral';
  recordCombat(state, {
    atk: `${attacker?.name || 'someone'} (${ownerName(attacker?.owner ?? -1)})`,
    def: `${ctx.defenderName || ctx.defender?.kind || 'someone'}`
      + `${ctx.defender?.kind === 'town' ? ' [town]' : ''}`
      + ` (${ownerName(defenderHero ? defenderHero.owner
        : (ctx.defender?.kind === 'town' ? state.towns?.[ctx.defender.townId]?.owner ?? -1 : -1))})`,
    at: attacker ? `${attacker.x},${attacker.y}${(attacker.z ?? 0) ? 'u' : ''}` : null,
    // The same two sides as NUMBERS. The display strings above are for a reader;
    // "did any AI realm ever attack the human" is a question about seats, and
    // parsing it back out of a rendered name is the kind of instrument that
    // quietly disagrees with the engine. -1 is neutral.
    atkOwner: attacker?.owner ?? -1,
    defOwner: defenderHero ? defenderHero.owner
      : (ctx.defender?.kind === 'town' ? state.towns?.[ctx.defender.townId]?.owner ?? -1
        : (ctx.defender?.kind === 'holding' ? getObject(state, ctx.defender.objectId)?.owner ?? -1 : -1)),
    defKind: ctx.defender?.kind || null,
    won: result.attackerWon ? 'atk' : 'def',
    atkBefore: Math.round(attackerCommitted),
    atkAfter: Math.round(armyValue(result.attackerArmy || [])),
    defBefore: Math.round(armyValue(ctx.defenderArmy || [])),
    defAfter: Math.round(armyValue(result.defenderArmy || [])),
    scaled: ctx.tideScaled ? (ctx.tideScaleMult || 1) : null,
    escape: result.escape?.mode || null,
    // The rng state the fight started from, so one battle out of a long game can be
    // replayed on its own instead of reproduced by re-running the game from turn
    // zero. `ctx.battleSeed` is the same number taken at createBattle (the scenes
    // and the AI stamp it on the context so a live battle can be replayed before it
    // ends); `result.seed` is the engine's own copy, and they agree.
    seed: result.seed || ctx.battleSeed || null,
  });

  // A hero that retreated or surrendered flees the field instead of dying.
  if (result.escape) return applyEscape(state, ctx, result);

  if (result.attackerWon) {
    if (attacker) {
      writeBackArmy(attacker.army, result.attackerArmy);
      // Necromancy: reanimate the enemy's mortal dead as skeletons (the whole
      // defender army fell, since the attacker won). Added to the winning army.
      const raised = raiseSkeletons(state, attacker, trueDefenderArmy(ctx));
      if (raised > 0) events.push({ type: 'skeletonsRaised', heroId: attacker.id, count: raised });
      const lvls = gainXp(state, attacker, trueBattleXp(ctx, result.xp));
      if (lvls > 0) events.push({ type: 'levelUp', heroId: attacker.id });
    }
    // Defender consequences.
    if (ctx.defender.kind === 'monster') {
      clearWildStack(state, attacker, getObject(state, ctx.defender.objectId), events,
        { tileEntered: ctx.tileEntered });
    } else if (ctx.defender.kind === 'creatureBank') {
      const bank = getObject(state, ctx.defender.objectId);
      if (bank && !bank.looted && attacker) {
        // The garrison the MAP placed, not the one massed for this attacker. The
        // creature prize is a share of that — see grantBankReward.
        const reward = grantBankReward(state, attacker, bank, bank.guards, {
          cost: attackerCommitted - armyValue(result.attackerArmy || []),
        });
        logMsg(state, `${attacker.name} plundered the ${bankDef(bank.bankType)?.name || 'bank'}!`);
        events.push({ type: 'bankLooted', heroId: attacker.id, bankType: bank.bankType, reward });
      }
    } else if (ctx.defender.kind === 'pandora') {
      const box = getObject(state, ctx.defender.objectId);
      if (box && !box.looted && attacker) {
        const { got } = grantPandoraReward(state, attacker, box, {
          cost: attackerCommitted - armyValue(result.attackerArmy || []),
        });
        logMsg(state, `${attacker.name} opened Pandora's Box!`);
        events.push({ type: 'pandoraOpened', heroId: attacker.id, reward: got });
      }
    } else if (ctx.defender.kind === 'holding') {
      const obj = getObject(state, ctx.defender.objectId);
      if (obj && attacker) {
        const fortified = !!defenceOf(obj)?.fortified;
        claimHolding(state, obj, attacker.owner);
        const what = obj.type === 'mine' ? mineName(obj.mineType) : dwellingName(obj);
        logMsg(state, `${attacker.name} stormed the ${what}.`);
        // Walls are paid for in blood as well as gold: even the winner leaves
        // men on them. Without this a strong hero farms defended ground for
        // free and the layer buys its owner only a delay.
        if (fortified) {
          let lost = 0;
          for (const st of attacker.army) {
            if (!st || st.count <= 0) continue;
            const toll = Math.floor(st.count * CONFIG.DEFENCE_FORTIFY_ATTRITION);
            if (toll > 0) { st.count -= toll; lost += toll; }
          }
          if (lost > 0) logMsg(state, `The walls cost ${attacker.name} ${lost} more of the fallen.`);
        }
        events.push({ type: 'holdingTaken', objectId: obj.id });
      }
    } else if (ctx.defender.kind === 'hero' && defenderHero) {
      const spoils = lootHero(state, attacker, defenderHero);
      if (attacker && spoils.length) events.push({ type: 'artifactsLooted', heroId: attacker.id, fromName: defenderHero.name, artifacts: spoils });
      logMsg(state, `${defenderHero.name} was defeated by ${attacker?.name || 'the enemy'}.`);
      leaveDerelictBoat(state, defenderHero);
      resolveHeroDuel(state, attacker, defenderHero, events); // bounty + nemesis brand
      learnFromDefeat(state, defenderHero, result, events);
      // Defeated: army + artifacts lost (looted above), but XP/stats persist in
      // the owner's pool for re-hire (#11/#12).
      retireHero(state, defenderHero, { defeated: true });
      checkVictory(state);
    } else if (ctx.defender.kind === 'town') {
      const town = state.towns[ctx.defender.townId];
      if (defenderHero) {
        const spoils = lootHero(state, attacker, defenderHero);
        if (attacker && spoils.length) events.push({ type: 'artifactsLooted', heroId: attacker.id, fromName: defenderHero.name, artifacts: spoils });
        resolveHeroDuel(state, attacker, defenderHero, events); // the fallen defender counts
        learnFromDefeat(state, defenderHero, result, events);
        retireHero(state, defenderHero, { defeated: true });
      }
      town.garrison = [null, null, null, null, null, null, null];
      captureTown(state, town, attacker ? attacker.owner : -1);
      // The taken town is not left naked for whoever walks past tomorrow. A
      // share of the army that took it stays as its garrison — the single clause
      // that ends five-changes-in-four-days, because the SECOND capture now has
      // to be paid for as well.
      if (attacker) leaveCaptureGarrison(state, town, attacker);
      events.push({ type: 'townCaptured', townId: town.id });
    }
  } else {
    // Attacker lost (or died to the last stack).
    if (attacker) {
      logMsg(state, `${attacker.name} was defeated.`);
      leaveDerelictBoat(state, attacker);
      const spoils = lootHero(state, defenderHero, attacker); // the defending victor (if any) takes the artifacts
      if (defenderHero && spoils.length) events.push({ type: 'artifactsLooted', heroId: defenderHero.id, fromName: attacker.name, artifacts: spoils });
      resolveHeroDuel(state, defenderHero, attacker, events); // a defending HERO earns the brand/bounty
      learnFromDefeat(state, attacker, result, events);
      retireHero(state, attacker, { defeated: true });
    }
    defenderKeepsField(state, ctx, result, events);
    // The assault failed: if it was a town, remember what the AI threw away there.
    if (ctx.defender.kind === 'town') {
      const lost = attackerCommitted - armyValue(result.attackerArmy || []);
      recordSiegeLoss(state, state.towns[ctx.defender.townId], attacker, lost);
    }
    checkVictory(state);
  }
  // A ronin that stood with the defender takes its survivors, its experience and
  // (if the band was wiped out) its removal from the map. Last, so it reads the
  // same result every other consequence above was settled from — and outside the
  // won/lost branches, because a captain that fought is paid either way.
  const settled = settleRoninBattle(state, ctx, result, {
    defenderWon: !result.attackerWon, gainXp,
  });
  if (settled) events.push({ type: 'roninFought', ...settled });
  return events;
}

/**
 * Tell the PvE sizer how its last aim turned out.
 *
 * The sizer prices a fight by simulating it against a COPY of the attacking hero
 * played by the computer brain. A human who plays that hero better than the proxy —
 * which is most of them, and by a wide margin at the top of the dial — is quoted a
 * fight that costs a fraction of what was intended. Nothing ever told it so.
 *
 * `PVE_KINDS` is the set the sizer actually acts on. Grading it on a hero duel or a
 * siege would move the aim using battles it never aimed, and those are precisely the
 * fights where the cost says most about the opponent and least about the estimate.
 */
const PVE_KINDS = new Set(['monster', 'creatureBank', 'pandora', 'holding']);

function gradeTideAim(state, ctx, result, committed) {
  if (!(committed > 0) || result?.escape) return;
  if (!PVE_KINDS.has(ctx?.defender?.kind)) return;
  const attacker = state.heroes[ctx.attackerHeroId];
  if (!attacker || !state.players?.[attacker.owner]?.isHuman) return;
  if (!pveScalesToArmy(state)) return;
  const hardness = Number.isFinite(state.tideHardness) ? state.tideHardness : CONFIG.TIDE_HARDNESS_DEFAULT;
  const realised = Math.max(0, (committed - armyValue(result.attackerArmy || [])) / committed);
  recordTideOutcome(state, { target: tideTargetLoss(hardness), realised });
}

/**
 * The wild stack is gone from the tile — settle everything that follows from
 * THAT, and nothing that follows from a battle.
 *
 * Extracted because the stack can now leave the map two ways: beaten
 * (applyCombatResult, below) or simply let go after it broke and ran
 * (`letThemGo`). Those two must claim the same ground, or "let them go" becomes
 * a trap that clears the guard and leaves the mine unflagged — the exact defect
 * the guarded-prize claim was written to fix. One function, both callers; the
 * spoils (XP, skeletons, bank rewards) stay with the caller that earned them.
 *
 * `tileEntered` is the zone-of-control flag from stepHero; see the note below on
 * why a direct attack must not re-run the tile the hero was already standing on.
 */
function clearWildStack(state, attacker, obj, events, { tileEntered = false } = {}) {
  // A war-band of a foreign people broken in the field is an invasion
  // repelled — the same thing as throwing one back from a wall, just met
  // before it got there. Counted for whoever's team did it (see
  // noteInvasionRepelled), which is what the Pax endgame is scored on.
  if (obj?.invader && attacker) noteInvasionRepelled(state, attacker.owner, obj);
  if (obj) removeObject(state, obj);
  // A guard's battle may have been triggered by stepping onto the very
  // tile it was protecting — claim that tile's prize now. But ONLY when the
  // hero actually entered the tile as part of the step that started this
  // fight (ctx.tileEntered — the zone-of-control branch in stepHero). A
  // DIRECT attack (tryEngage) never moves the attacker, so `under` is then
  // whatever the hero was already standing on — typically the teleporter
  // exit it arrived on earlier — and re-running that interaction re-fired
  // portals and subterranean gates after a won battle, contradicting the
  // documented arrival rule in usePortal/useSubGate. The chest branch stays
  // ungated on purpose: a chest is inert until resolveChest consumes it, so
  // re-surfacing one the hero is genuinely standing on can never teleport,
  // pay double, or otherwise act — and the engine contract tests build the
  // context directly (without stepHero) and rely on exactly that.
  if (!attacker) return;
  const under = objectAt(state, attacker.x, attacker.y, attacker.z ?? 0);
  if (under && under.type === 'chest') {
    // A guarded tile can hide a chest. interactWithObject deliberately
    // does NOT auto-open chests (they need the caller's gold-vs-XP
    // dialog), so a chest won under Zone-of-Control used to be dropped
    // on the floor — no event, no prize. Surface it with pre-rolled
    // contents so the caller can resolveChest() it exactly like a chest
    // reached by a normal step.
    if (!under.chest) under.chest = rollChestContents(state);
    events.push({ type: 'chestUnderGuard', heroId: attacker.id, objectId: under.id, gold: under.chest.gold, xp: under.chest.xp });
  } else if (under && tileEntered && !['town', 'monster'].includes(under.type)) {
    const ev = interactWithObject(state, attacker, under);
    if (ev.type !== 'moved') events.push({ type: 'interact', heroId: attacker.id, event: ev });
    if (ev.events) events.push(...ev.events);
  }
  // THE PRIZE THE GUARD WAS STANDING OVER. A guard stack names what it
  // protects (`obj.guards` — mapgen sets it, neutrals.isGuardStack reads
  // it), and it stands BESIDE that object rather than on it. So beating it
  // used to leave the mine unflagged and the artifact on the ground: you had
  // to step onto the tile afterwards, which usually meant next turn.
  // Reported as "if we stop on a mine to carry a battle for the mine, to get
  // the mine after the battle — not to have to move and return, as it often
  // happens with structures and towers, artifacts and obelisks now".
  //
  // Claimed WITHOUT moving the hero. Walking it onto the tile would cost
  // movement it did not spend and would re-run that tile's own interaction,
  // which is how a hero standing on a portal got yanked through a teleporter
  // it never asked to use (see stepHero's note on tileEntered). Acting on the
  // object alone has neither problem: interactWithObject reads `obj`, not the
  // hero's position.
  const guarded = obj?.guards ? getObject(state, obj.guards) : null;
  if (guarded && !GUARD_PRIZE_SKIP.has(guarded.type)) {
    const ev = interactWithObject(state, attacker, guarded);
    if (ev.type !== 'moved') events.push({ type: 'interact', heroId: attacker.id, event: ev });
    if (ev.events) events.push(...ev.events);
  }
}

/**
 * Object types a fallen guard's prize is NOT auto-claimed for.
 *
 * Measured on seed 4242: guards protect mines, artifacts and boosters, and all
 * three are things you simply take. The list is what must never be taken FOR the
 * player — a town is captured by entering it with an army, a chest needs the
 * caller's gold-or-experience question, and anything that moves a hero must be
 * walked into deliberately rather than triggered from a tile away.
 */
const GUARD_PRIZE_SKIP = new Set([
  'town', 'monster', 'chest', 'boat',
  'portal', 'gate', 'whirlpool', 'subterraneanGate',
]);

/**
 * A beaten hero takes its lesson off the field.
 *
 * Before this, losing was the one outcome that taught nothing: the army is gone,
 * the artifacts are looted, and the entire battle vanished from the hero's own
 * history — so the hardest fights in the game, the ones a player actually learns
 * from, were the only ones that paid no experience at all.
 *
 * `result.defeatXp` is a share of what this hero DESTROYED before it fell (see
 * CombatEngine.battleResult), never a share of what it faced. A hero crushed
 * without landing a blow learns nothing; a hero that nearly won learns a great
 * deal. Paid BEFORE retireHero so the level lands while the hero is still in the
 * world and the log reads in the right order — the pool preserves it either way.
 */
function learnFromDefeat(state, hero, result, events) {
  const xp = Math.max(0, Math.round(result?.defeatXp || 0));
  if (!hero || xp <= 0) return;
  const levels = gainXp(state, hero, xp);
  logMsg(state, `${hero.name} learns from the defeat — ${xp} experience.`);
  events.push({ type: 'defeatLesson', heroId: hero.id, xp, levels });
}

/**
 * The defender held the field (attacker lost or fled): write survivors back to
 * the defending monster / hero / town and grant the defender's hero the win XP.
 * Shared by a normal attacker defeat and an attacker retreat/surrender.
 */
function defenderKeepsField(state, ctx, result, events) {
  const defenderHero = ctx.defenderHeroId ? state.heroes[ctx.defenderHeroId] : null;
  // The defender's OWN survivors. A ronin that stood with them fought in the same
  // line and its stack comes back in the same list, tagged `retinue` — but those
  // creatures are its, not the defender's, and every branch below writes this list
  // into somebody's army, garrison or guard. `result` itself is left untouched:
  // settleRoninBattle reads the tagged stacks out of it afterwards to give the
  // captain its band back.
  const ownArmy = (result.defenderArmy || []).filter((s) => s && !s.retinue);
  // Tide of War (#8): the PvE defender was inflated to challenge THIS attacker
  // (combatContext → tideScaleDefender). That inflation is per-attacker and must
  // NOT persist: writing the scaled survivors straight back would bake the army
  // massed for this hero into the map, so the next — possibly weaker — hero would
  // face a too-strong stack that tide-scaling can only ever grow, never shrink.
  // Divide the survivors back down by the same multiplier so the stored stack
  // returns to its OWN true scale, thinned only by the real casualty fraction it
  // actually suffered. A no-op (mult 1) for an unscaled/Classic fight.
  const tideMult = ctx.tideScaled && ctx.tideScaleMult > 0 ? ctx.tideScaleMult : 1;
  const unscale = (n) => Math.round(n / tideMult);
  if (ctx.defender.kind === 'monster') {
    const obj = getObject(state, ctx.defender.objectId);
    if (obj) {
      const left = unscale(ownArmy.reduce((n, s) => n + (s ? s.count : 0), 0));
      obj.count = Math.max(1, left);
    }
  } else if (ctx.defender.kind === 'holding') {
    // A repelled assault thins the garrison to its survivors: the holding stays,
    // weaker, so a second attempt is cheaper than the first was.
    const obj = getObject(state, ctx.defender.objectId);
    const d = obj ? defenceOf(obj) : null;
    if (d) {
      d.garrison = ownArmy
        .map((st) => (st && st.count > 0
          ? { creature: st.creature, count: Math.max(1, unscale(st.count)), hurt: 0 } : null))
        .filter(Boolean);
    }
  } else if (ctx.defender.kind === 'creatureBank') {
    // A repelled assault thins the bank's guard to the survivors — at the stack's
    // own scale, not the attacker's — so a later hero faces a weaker garrison;
    // the reward is still there until someone wins.
    const bank = getObject(state, ctx.defender.objectId);
    if (bank) {
      // Floor a surviving stack at 1 (like the monster path's Math.max(1,…)): a
      // stack that actually lived must never be un-inflated down to zero and
      // silently deleted — only a stack the battle truly wiped (count 0) drops.
      const left = ownArmy
        .map((s) => (s && s.count > 0 ? { creature: s.creature, count: Math.max(1, unscale(s.count)) } : null))
        .filter(Boolean);
      if (left.length) bank.guards = left;
    }
  } else if (ctx.defender.kind === 'pandora') {
    const box = getObject(state, ctx.defender.objectId);
    if (box) {
      const left = ownArmy
        .map((s) => (s && s.count > 0 ? { creature: s.creature, count: Math.max(1, unscale(s.count)) } : null))
        .filter(Boolean);
      if (left.length) box.guards = left;
    }
  } else if (ctx.defender.kind === 'hero' && defenderHero) {
    writeBackArmy(defenderHero.army, ownArmy);
    const lvls = gainXp(state, defenderHero, result.xp);
    if (lvls > 0) events.push({ type: 'levelUp', heroId: defenderHero.id });
  } else if (ctx.defender.kind === 'town') {
    const town = state.towns[ctx.defender.townId];
    // Surviving defenders return: hero keeps their share, rest (including
    // reserve stacks that never fit on the battlefield) to the garrison.
    const survivors = [...ownArmy, ...(ctx.defenderReserve || [])];
    if (defenderHero) {
      writeBackArmy(defenderHero.army, []);
      town.garrison = [null, null, null, null, null, null, null];
      for (const s of survivors) {
        if (s && s.count > 0 && !addToArmy(defenderHero.army, s.creature, s.count)) {
          addToArmy(town.garrison, s.creature, s.count);
        }
      }
      const lvls = gainXp(state, defenderHero, result.xp);
      if (lvls > 0) events.push({ type: 'levelUp', heroId: defenderHero.id });
    } else {
      town.garrison = [null, null, null, null, null, null, null];
      for (const s of survivors) {
        if (s && s.count > 0) addToArmy(town.garrison, s.creature, s.count);
      }
    }
  }
}

// ===========================================================================
// ADVENTURE-MAP SPELLS  (cast outside combat; SPELLS[id].adventure === true)
// ===========================================================================

/** Nearest open tile around (cx,cy) on `lvl`: land (default) or water. */
function nearestOpenTile(state, cx, cy, lvl, wantWater = false, radius = 4) {
  const { w, h } = state.map;
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const t = tileAt(state, x, y, lvl);
        if (!t || t.obstacle || t.objectId) continue;
        if (wantWater ? t.terrain !== 'water' : t.terrain === 'water') continue;
        if (heroAt(state, x, y, lvl)) continue;
        if (!wantWater && monsterNear(state, x, y, null, lvl)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

function leaveCurrentTown(state, hero) {
  if (hero.inTownId && state.towns[hero.inTownId]) state.towns[hero.inTownId].visitingHeroId = null;
  hero.inTownId = null;
}

/**
 * Cast an adventure-map spell. Validates knowledge, mana and per-spell rules,
 * applies the effect, spends mana (and movement where the spell demands), and
 * returns { ok, type, ... } for the view — or { ok:false, reason } to toast.
 */
export function castAdventureSpell(state, hero, spellId, target) {
  const spell = SPELLS[spellId];
  if (!spell || !spell.adventure) return { ok: false, reason: 'Not an adventure spell.' };
  if (!(hero.spells || []).includes(spellId)) return { ok: false, reason: `${hero.name} does not know that spell.` };
  // The MASTERED price: Air Magic makes View Air and Fly cheaper exactly as it
  // makes Haste cheaper, and the quote the spellbook showed is this one.
  const cost = spellCost(hero, spellId);
  if ((hero.mana || 0) < cost) return { ok: false, reason: `Not enough mana (need ${cost}).` };
  const handler = ADVENTURE_CASTS[spell.cast];
  if (!handler) return { ok: false, reason: 'That spell has no effect yet.' };
  const res = handler(state, hero, target || null);
  if (!res.ok) return res;
  hero.mana -= cost;
  logMsg(state, `${hero.name} cast ${spell.name}.`);
  return res;
}

/**
 * Can `hero` land a Dimension Door on (x,y)? Returns { ok, reason } — the single
 * source of truth for both the cast (ADVENTURE_CASTS.dimensionDoor) and the UI
 * targeting overlay, so the green/red markers the player sees can never disagree
 * with what a click actually does. Tile-level only (range + explored + standable);
 * the per-day use and MP gates live on the cast itself.
 */
function dimDoorLandingCheck(state, hero, x, y) {
  const lvl = hero.z ?? 0;
  const d = Math.max(Math.abs(x - hero.x), Math.abs(y - hero.y));
  if (d === 0) return { ok: false, reason: 'You are already there.' };
  const reach = adventureParam(hero, 'dimensionDoor', CONFIG.DIM_DOOR_RANGE_BY_SCHOOL);
  if (d > reach) return { ok: false, reason: `Beyond Dimension Door range (${reach} tiles).` };
  if (!isExplored(state, hero.owner, x, y, lvl)) return { ok: false, reason: 'You can only blink to explored ground.' };
  const t = tileAt(state, x, y, lvl);
  if (!t || t.obstacle || t.terrain === 'water' || t.objectId
      || heroAt(state, x, y, lvl) || monsterNear(state, x, y, null, lvl)) {
    return { ok: false, reason: 'You cannot land there.' };
  }
  return { ok: true };
}

/** UI predicate: is (x,y) a legal Dimension Door landing for `hero`? */
export function dimDoorLandable(state, hero, x, y) {
  return dimDoorLandingCheck(state, hero, x, y).ok;
}

/**
 * May this hero AIM a Town Portal (pick the destination from a list) rather than
 * snap to the nearest town? Any Earth Magic mastery grants the choice; a hero
 * with none is always recalled to the nearest town. Exported so the UI's town
 * chooser and the cast itself agree on who may pick.
 */
export function townPortalCanChoose(hero) {
  return (hero.skills?.earthMagic || 0) >= 1;
}

/** Every town this hero owns — Town Portal spans BOTH map levels now, so the
 *  chooser (and the cast) can offer surface and underground towns alike. */
export function townPortalTowns(state, hero) {
  return Object.values(state.towns).filter((t) => t.owner === hero.owner);
}

const ADVENTURE_CASTS = {
  // Reveal the whole level the hero stands on.
  view(state, hero) {
    // An EXPERT of Air lifts the fog from the underworld too — the one map
    // effect that turns a tier-2 scrying into the tier-3 one (see View Earth).
    const both = viewAirSeesBothLevels(hero) && state.map.underground;
    const levels = both ? [0, 1] : [hero.z ?? 0];
    let any = false;
    for (const lvl of levels) {
      const fog = fogFor(state, hero.owner, lvl);
      if (fog) { fog.fill(1); any = true; }
    }
    if (!any) return { ok: false, reason: 'Nothing to scry here.' };
    return { ok: true, type: 'view', levels };
  },

  // Summon a boat onto the nearest open water beside the hero.
  summonBoat(state, hero) {
    if (hero.onBoat) return { ok: false, reason: 'You are already aboard a boat.' };
    const lvl = hero.z ?? 0;
    const reach = adventureParam(hero, 'summonBoat', CONFIG.SUMMON_BOAT_RANGE_BY_SCHOOL);
    const spot = nearestOpenTile(state, hero.x, hero.y, lvl, true, reach);
    if (!spot) return { ok: false, reason: 'No open water nearby to summon a boat.' };
    placeBoat(state, spot.x, spot.y);
    return { ok: true, type: 'summonBoat', at: spot };
  },

  // Recall to an owned town on EITHER map level. Costs a couple of tiles' worth
  // of march (CONFIG.TOWN_PORTAL_MP), not the whole day; an Earth mage may aim it
  // at a chosen town (any level), everyone else snaps to the nearest.
  townPortal(state, hero, target) {
    const fromLvl = hero.z ?? 0;
    const towns = townPortalTowns(state, hero);
    if (!towns.length) return { ok: false, reason: 'You have no town to recall to.' };
    // Prorated movement toll — refuse when the hero can't even spare that much.
    // Earth mastery reduces it, and an Expert recalls for nothing (see
    // CONFIG.TOWN_PORTAL_MP_BY_SCHOOL); mana is then the only limit.
    const toll = adventureParam(hero, 'townPortal', CONFIG.TOWN_PORTAL_MP_BY_SCHOOL);
    if ((hero.mp || 0) < toll) {
      return { ok: false, reason: 'Not enough movement left to cast this spell.' };
    }
    const nearest = (list) => list.reduce((best, t) => {
      const d = Math.max(Math.abs(t.x - hero.x), Math.abs(t.y - hero.y));
      return !best || d < best.d ? { t, d } : best;
    }, null)?.t;
    // Only an Earth mage may choose the destination; others snap to the nearest on
    // their own level (or, if they hold none there, the nearest anywhere).
    let town = (townPortalCanChoose(hero) && target && target.townId
      && towns.find((t) => t.id === target.townId)) || null;
    if (!town) town = nearest(towns.filter((t) => (t.z ?? 0) === fromLvl)) || nearest(towns);

    const toLvl = town.z ?? 0;
    let dest;
    if (!town.visitingHeroId || town.visitingHeroId === hero.id) {
      dest = { x: town.x, y: town.y, enter: true };
    } else {
      const spot = nearestOpenTile(state, town.x, town.y, toLvl, false, 3);
      if (!spot) return { ok: false, reason: 'No room to arrive at that town.' };
      dest = { ...spot, enter: false };
    }
    leaveCurrentTown(state, hero);
    // A hero teleporting off a boat leaves the vessel moored where they stood
    // (mirrors disembark/leaveDerelictBoat — the boat is an asset, not clothing).
    if (hero.onBoat) placeBoat(state, hero.x, hero.y);
    hero.onBoat = false;
    hero.x = dest.x; hero.y = dest.y; hero.z = toLvl; // may cross to the other level
    if (dest.enter) {
      town.visitingHeroId = hero.id; hero.inTownId = town.id;
      applyTownVisitPerks(state, town, hero);
    }
    hero.mp = Math.max(0, (hero.mp || 0) - toll);
    revealAround(state, hero.owner, hero.x, hero.y, heroSightRadius(hero), toLvl);
    return { ok: true, type: 'townPortal', to: { x: hero.x, y: hero.y }, z: toLvl, townId: town.id, entered: dest.enter };
  },

  // Blink to a nearby explored, standable tile. Limited casts per day.
  dimensionDoor(state, hero, target) {
    const uses = adventureParam(hero, 'dimensionDoor', CONFIG.DIM_DOOR_USES_BY_SCHOOL);
    const jumpMp = adventureParam(hero, 'dimensionDoor', CONFIG.DIM_DOOR_MP_BY_SCHOOL);
    if ((hero.dimDoorUsed || 0) >= uses) {
      return { ok: false, reason: 'Dimension Door: no casts left today.' };
    }
    if ((hero.mp || 0) < jumpMp) {
      return { ok: false, reason: 'Not enough movement left for Dimension Door.' };
    }
    if (!target || target.x == null) return { ok: false, reason: 'Pick a destination tile.' };
    const chk = dimDoorLandingCheck(state, hero, target.x, target.y);
    if (!chk.ok) return chk;
    const lvl = hero.z ?? 0;
    leaveCurrentTown(state, hero);
    // Same boat-preservation rule as townPortal: the vessel stays moored.
    if (hero.onBoat) placeBoat(state, hero.x, hero.y);
    hero.onBoat = false;
    hero.x = target.x; hero.y = target.y;
    hero.mp -= jumpMp;
    hero.dimDoorUsed = (hero.dimDoorUsed || 0) + 1;
    revealAround(state, hero.owner, hero.x, hero.y, heroSightRadius(hero), lvl);
    return { ok: true, type: 'dimensionDoor', to: { x: hero.x, y: hero.y } };
  },

  // Scout the country around you: reveal a wide disc (cheap, repeatable).
  visions(state, hero) {
    revealAround(state, hero.owner, hero.x, hero.y,
      adventureParam(hero, 'visions', CONFIG.VISIONS_RANGE_BY_SCHOOL), hero.z ?? 0);
    return { ok: true, type: 'visions' };
  },

  // Sink the nearest empty boat within range on this level (boats on the map
  // are always empty — an occupied boat rides on the hero as hero.onBoat).
  scuttleBoat(state, hero) {
    const lvl = hero.z ?? 0;
    const range = adventureParam(hero, 'scuttleBoat', CONFIG.SCUTTLE_RANGE_BY_SCHOOL);
    let best = null;
    for (const obj of Object.values(levelObjects(state, lvl))) {
      if (obj.type !== 'boat') continue;
      const d = Math.max(Math.abs(obj.x - hero.x), Math.abs(obj.y - hero.y));
      if (d <= range && (!best || d < best.d)) best = { obj, d };
    }
    if (!best) return { ok: false, reason: `No boat within ${range} tiles to scuttle.` };
    const at = { x: best.obj.x, y: best.obj.y };
    removeObject(state, best.obj);
    return { ok: true, type: 'scuttleBoat', at };
  },

  /**
   * SCRY the powers of the world: where every castle and every commander stands,
   * on both levels — and nothing else.
   *
   * It used to be `fog.fill(1)` on every level: the entire map, terrain and all,
   * revealed permanently for twelve mana. That is the strongest possible effect in
   * the game and it ends the map as a thing to be explored — reported as "it is
   * just revealing the whole world forever", and the fix asked for is the HoMM3
   * one: "all black, and show the castle locations with flags and heroes with
   * shields in the respective colour… this way it preserves some unknown while
   * helping with general direction and location".
   *
   * So the fog is not touched at all. What the spell writes is a dated SIGHTING —
   * a snapshot of who was where at the moment of casting — which the map paints
   * over the dark. Three consequences, all of them the point:
   *
   *   The land stays unknown. You learn where the powers are, not what lies
   *   between you and them, so the march is still a thing you have to scout.
   *
   *   It goes STALE. Armies move; the snapshot does not. After
   *   CONFIG.VIEW_EARTH_DAYS it lapses entirely, and the view fades as it ages, so
   *   an old sighting reads as the rumour it is.
   *
   *   It is intelligence rather than cartography, which is also what distinguishes
   *   it from View Air. That spell still maps the ground of the level you stand
   *   on; this one tells you who is on it. Air sees the land, Earth senses the
   *   powers — the tier-3 spell is no longer simply the tier-2 one twice over.
   */
  viewEarth(state, hero) {
    const marks = [];
    for (const t of Object.values(state.towns || {})) {
      marks.push({ kind: 'town', x: t.x, y: t.y, z: t.z ?? 0, owner: t.owner ?? -1 });
    }
    for (const h of Object.values(state.heroes || {})) {
      if (h.id === hero.id) continue; // you know where you are
      marks.push({ kind: 'hero', x: h.x, y: h.y, z: h.z ?? 0, owner: h.owner ?? -1 });
    }
    const p = state.players?.[hero.owner];
    if (!p) return { ok: false, reason: 'Nobody to scry for.' };
    p.scry = { day: state.day, marks };
    return { ok: true, type: 'viewEarth', marks: marks.length };
  },

  // Water Walk: the hero may stride over water on foot for the rest of the day.
  waterWalk(state, hero) {
    if (hero.onBoat) return { ok: false, reason: 'You cannot Water Walk from aboard a boat.' };
    if (hero.waterWalk) return { ok: false, reason: 'You are already walking on water.' };
    hero.waterWalk = true;
    return { ok: true, type: 'waterWalk' };
  },

  // Fly: cross water AND obstacles freely for the rest of the day.
  fly(state, hero) {
    if (hero.onBoat) return { ok: false, reason: 'You cannot take flight from a boat.' };
    if (hero.flying) return { ok: false, reason: 'You are already in flight.' };
    hero.flying = true;
    return { ok: true, type: 'fly' };
  },

  // Disguise: hides this hero's army strength from enemy scouting for the day.
  disguise(state, hero) {
    if (hero.disguised) return { ok: false, reason: 'You are already disguised.' };
    hero.disguised = true;
    return { ok: true, type: 'disguise' };
  },
};

/**
 * Gold price to surrender an army you keep (see CONFIG.SURRENDER_COST_MULT).
 *
 * `hero` is optional and only discounts: a commander with Diplomacy talks the
 * price down (CONFIG.SURRENDER_DIPLOMACY_CUT), which is the other half of the
 * skill in HoMM3 and the half that works in games with the parley feature off.
 * Omitting the hero prices the army alone, exactly as before.
 */
export function surrenderCost(army, hero = null) {
  let gold = 0;
  for (const s of army || []) {
    if (!s || s.count <= 0) continue;
    gold += (CREATURES[s.creature]?.cost?.gold || 0) * s.count;
  }
  const cut = hero ? skillValue(hero, 'diplomacy') * CONFIG.SURRENDER_DIPLOMACY_CUT : 0;
  return Math.round(gold * CONFIG.SURRENDER_COST_MULT * (1 - cut));
}

/**
 * A retreated/surrendered hero flees the field instead of dying. Retreat wipes
 * the army (free); surrender keeps the survivors for a gold price already
 * validated by the view. The opponent takes the contested location exactly as a
 * normal winner would (a besieged town falls; a routed guard/hero survivor set
 * is written back), and the fleeing hero is relocated clear of the victor when
 * its tile is taken.
 */
function applyEscape(state, ctx, result) {
  const events = [];
  const attacker = state.heroes[ctx.attackerHeroId];
  const defenderHero = ctx.defenderHeroId ? state.heroes[ctx.defenderHeroId] : null;
  const { side, mode } = result.escape;
  const keep = mode === 'surrender';
  const fleeing = side === 0 ? attacker : defenderHero;
  const keptArmy = side === 0 ? result.attackerArmy : result.defenderArmy;
  // Recompute the surrender price from the ACTUAL kept army — the caller-supplied
  // goldPaid was only affordability-checked in the UI. Clamp so a mispriced or
  // hostile caller can never drive the treasury negative.
  const cost = keep ? surrenderCost(keptArmy, fleeing) : 0;
  if (cost > 0 && fleeing && fleeing.owner >= 0) {
    const p = state.players[fleeing.owner];
    p.resources.gold = Math.max(0, (p.resources.gold || 0) - cost);
  }
  if (fleeing) {
    writeBackArmy(fleeing.army, keep ? keptArmy : []);
    logMsg(state, keep
      ? `${fleeing.name} surrendered and withdrew from the battle.`
      : `${fleeing.name} retreated, abandoning the army.`);
    // The fleeing hero LEAVES the map into its owner's re-hire pool (#12),
    // keeping its XP/stats (and, on surrender, its army); artifacts are kept.
    // Retire before the field/town hand-off so its tile + town-visit ref clear.
    leaveDerelictBoat(state, fleeing);
    retireHero(state, fleeing);
  }

  if (side === 0) {
    // Attacker fled: it never took the target tile; the defender keeps the field,
    // its survivors and the XP.
    defenderKeepsField(state, ctx, result, events);
    // The victor's owner sees WHY there was no loot: a fled hero keeps its gear.
    if (defenderHero && fleeing) events.push({ type: 'heroFled', heroId: defenderHero.id, fromName: fleeing.name });
  } else {
    // Defender fled: the attacker takes the location like a normal victory.
    if (attacker) {
      writeBackArmy(attacker.army, result.attackerArmy);
      const lvls = gainXp(state, attacker, trueBattleXp(ctx, result.xp));
      if (lvls > 0) events.push({ type: 'levelUp', heroId: attacker.id });
      if (fleeing) events.push({ type: 'heroFled', heroId: attacker.id, fromName: fleeing.name });
    }
    if (ctx.defender.kind === 'town') {
      const town = state.towns[ctx.defender.townId];
      town.garrison = [null, null, null, null, null, null, null];
      captureTown(state, town, attacker ? attacker.owner : -1);
      // The taken town is not left naked for whoever walks past tomorrow. A
      // share of the army that took it stays as its garrison — the single clause
      // that ends five-changes-in-four-days, because the SECOND capture now has
      // to be paid for as well.
      if (attacker) leaveCaptureGarrison(state, town, attacker);
      events.push({ type: 'townCaptured', townId: town.id });
    }
  }
  checkVictory(state);
  return events;
}

/**
 * A hero's army as a deploy list: only the occupied slots, each tagged with the
 * slot it came from.
 *
 * The battle needs a compacted list (deployArmy walks it against seven fixed
 * rows), but compacting throws away which slot each stack lived in — and that is
 * the player's arrangement. Tagging it here lets writeBackArmy put every survivor
 * back exactly where it started.
 */
export function armyForDeploy(army) {
  return (army || [])
    .map((s, i) => (s && s.count > 0 ? { ...s, origin: i } : null))
    .filter(Boolean);
}

/**
 * Survivor stacks written back into the hero's 7 slots.
 *
 * By ORIGIN when the deploy list carried one (armyForDeploy): each survivor
 * returns to the slot it marched out of, and several units sharing an origin —
 * the pieces of a deploy-time split — add back together into that one slot. So a
 * player who deliberately keeps three separate stacks of archers still has three
 * after the battle, while an AI_SPLIT force still re-consolidates. Reported as
 * "after a battle the same-kind stacks combine themselves; I want to keep the
 * arrangement".
 *
 * Without origins (auto-resolved previews, engine tests, a battle built by an
 * older caller) it falls back to the historical behaviour: pack from slot 0,
 * merging same-creature stacks.
 */
function writeBackArmy(army, survivors) {
  const list = (survivors || []).filter((s) => s && s.count > 0);
  for (let i = 0; i < army.length; i++) army[i] = null;
  const placed = list.every((s) => Number.isInteger(s.origin) && s.origin >= 0 && s.origin < army.length);
  if (placed) {
    for (const s of list) {
      const at = army[s.origin];
      if (at && at.creature === s.creature) at.count += s.count;
      else if (at) leftover(army, s); // two creatures claiming one slot: never seen, but never lose a stack
      else army[s.origin] = { creature: s.creature, count: s.count, hurt: s.hurt || 0 };
    }
    return;
  }
  // Merge same-creature survivors back into one stack each, so a force that was
  // SPLIT for deploy (AI_SPLIT) re-consolidates in storage instead of fragmenting
  // the army into several slots of the same creature over successive battles.
  let i = 0;
  for (const s of list) {
    const at = army.findIndex((x) => x && x.creature === s.creature);
    if (at >= 0) { army[at].count += s.count; continue; }
    if (i < army.length) army[i++] = { creature: s.creature, count: s.count, hurt: s.hurt || 0 };
  }
}

/** Last resort for a survivor whose own slot is taken: merge with a matching
 *  stack anywhere, else the first free slot. Only a stack with nowhere at all to
 *  go is dropped, and a full army cannot have gained one. */
function leftover(army, s) {
  const same = army.findIndex((x) => x && x.creature === s.creature);
  if (same >= 0) { army[same].count += s.count; return; }
  const free = army.findIndex((x) => !x);
  if (free >= 0) army[free] = { creature: s.creature, count: s.count, hurt: s.hurt || 0 };
}

/** Winner takes the loser's artifacts — and the Holy Grail, if carried. Runs
 *  BEFORE the loser retires, so heroLeavesWorld only re-buries an untaken Grail. */
function lootHero(state, winner, loser) {
  if (!winner) return [];
  const loot = [...Object.values(loser.equipment).filter(Boolean), ...loser.backpack];
  for (const artifactId of loot) giveArtifact(null, winner, artifactId);
  if (loser.carryingGrail) {
    loser.carryingGrail = false;
    winner.carryingGrail = true;
    if (state) logMsg(state, `${winner.name} seizes the Holy Grail from ${loser.name}!`);
  }
  return loot; // the ids that changed hands — so the caller can surface the spoils
}

// ===========================================================================
// ARMY MANAGEMENT (drag between slots / garrison)
// ===========================================================================

/** Swap or merge stacks between two army arrays (may be the same array). */
export function moveStack(fromArmy, fromIdx, toArmy, toIdx) {
  const a = fromArmy[fromIdx];
  if (!a) return;
  const b = toArmy[toIdx];
  if (b && b.creature === a.creature && !(fromArmy === toArmy && fromIdx === toIdx)) {
    b.count += a.count;
    fromArmy[fromIdx] = null;
  } else {
    fromArmy[fromIdx] = b || null;
    toArmy[toIdx] = a;
  }
}

/** Split half of a stack into an empty slot. */
/**
 * Disband a stack: the creatures are dismissed, not moved anywhere. Returns
 * true if it happened, false if the rule below refused it.
 *
 * `allowEmpty` is the whole rule. A town GARRISON may be emptied — an empty
 * garrison is an ordinary state of the world. A HERO may not disband its last
 * stack: an army-less hero cannot fight, marches at the speed of a man on foot,
 * and is one wandering monster from being deleted. The refusal lives here rather
 * than in the two screens that offer the button, so both cannot disagree about
 * when a hero is stranded (the same reason moveStack's stranding rule is not
 * duplicated per scene).
 */
export function disbandStack(army, idx, { allowEmpty = false } = {}) {
  const stack = army?.[idx];
  if (!stack || stack.count <= 0) return false;
  if (!allowEmpty && army.filter((s) => s && s.count > 0).length <= 1) return false;
  army[idx] = null;
  return true;
}

export function splitStack(fromArmy, fromIdx, toArmy, toIdx) {
  const a = fromArmy[fromIdx];
  if (!a || a.count < 2 || toArmy[toIdx]) return;
  const half = Math.floor(a.count / 2);
  a.count -= half;
  toArmy[toIdx] = { creature: a.creature, count: half, hurt: 0 };
}
