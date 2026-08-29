/**
 * endless.js — the never-ending run: win a realm, march into the next one.
 *
 * Asked for: "when finishing a custom game, offer to continue into a newly
 * generated custom game carrying the top 3 heroes; scale all the creatures and
 * opponents and give them artifacts to be on par with the player; if possible
 * transfer the buildings built in the previous game."
 *
 * A campaign is a fixed chain of authored chapters. An endless RUN is the same
 * carry-forward machinery with no last chapter: each realm is freshly generated
 * from the setup that made the first one, and the escalation is symmetric — you
 * bring your veterans and the masonry you left behind, and so does everyone else.
 *
 * What carries:
 *   · Your top three heroes, by experience — the commander plus two lieutenants,
 *     reusing the campaign's own capture/carry functions so the two flows cannot
 *     drift. Level, stats, skills, spells and artifacts all come; the army does
 *     NOT (each realm raises a fresh force, as chapters do).
 *   · The town legacy: every building your towns held. Granted to EVERY player's
 *     starting town, not only yours. That is what "on par" means here — the age
 *     itself has advanced, so a rival's capital is as developed as the one you
 *     left, in their own faction's buildings. It also answers the older complaint
 *     that a late-game AI has nothing to do: in realm three it starts with a
 *     built capital and an army to match.
 *   · An escalating floor under the world: rival heroes' armies are multiplied,
 *     each is handed artifacts, and the Tide of War hardness rises a step, which
 *     is the engine's existing lever for "wild stacks scale to your army".
 *
 * `state.endless = { realm, setup, buildings }` — plain data, so it round-trips a
 * save with no version bump (like `state.campaign` and `state.victory`). An
 * endless run carries no `state.campaign`, so it saves to the ordinary single-map
 * slot and resumes through the same Continue button.
 */

import { CONFIG } from '../config.js';
import { newGame, playerTowns, playerHeroes, featureOn, logMsg } from './GameState.js';
import { buildingCatalog } from '../data/buildings.js';
import { ARTIFACTS } from '../data/artifacts.js';
import { giveArtifact } from './actions.js';
import {
  captureCommander, captureSidekicks, applyCommanderCarry, applySidekickCarry,
  matchRivalProgression,
} from './campaign.js';

/** Is this state part of an endless run? */
export function isEndless(state) {
  return !!(state && state.endless);
}

/** Which realm of the run this is (1 = the first, generated normally). */
export function endlessRealm(state) {
  return state?.endless?.realm || 1;
}

/**
 * Mark a freshly created game as realm 1 of an endless run, remembering the setup
 * that made it so every later realm can be cut from the same cloth.
 *
 * Called when a game is STARTED, not when one is won: the setup is only fully
 * known at the front door (map size, roster, victory condition, feature flags),
 * and reconstructing it from a finished state would be guesswork.
 */
export function beginEndless(state, setup) {
  state.endless = { realm: 1, setup: { ...setup }, buildings: [] };
  return state;
}

/**
 * Every building the player's towns hold, deduplicated — the masonry that
 * carries. Auto-built starters are in here too, harmlessly: the next realm's
 * towns already have them, and granting a building twice is a no-op.
 */
export function captureTownLegacy(state, playerIndex) {
  const out = new Set();
  for (const town of playerTowns(state, playerIndex)) {
    for (const b of town.buildings || []) out.add(b);
  }
  return [...out].sort();
}

/**
 * Grant a legacy list to one town, skipping anything that cannot stand there.
 *
 * Deliberately NOT a call to buildStructure: nobody is paying for these and no
 * prerequisite chain is being walked — the buildings already exist, in the sense
 * that they existed in the realm before. What is still checked is what would be
 * incoherent rather than merely unpaid: a building this faction does not have, a
 * shipyard inland, a feature switched off for this game, and a one-per-realm
 * structure a sibling town already carries.
 *
 * Returns the ids actually raised.
 */
export function applyTownLegacy(state, town, legacy, isCoastal) {
  const catalog = buildingCatalog(town.faction);
  const raised = [];
  for (const id of legacy || []) {
    const b = catalog[id];
    if (!b) continue;                                        // not in this faction's catalog
    if (town.buildings.includes(id)) continue;               // already standing
    if (b.feature && !featureOn(state, b.feature)) continue; // that feature is off this game
    if (b.coastal && !isCoastal) continue;                   // a dock needs water
    if (b.onePerPlayer && playerTowns(state, town.owner).some((t) => t !== town && t.buildings.includes(id))) continue;
    town.buildings.push(id);
    raised.push(id);
  }
  return raised;
}

/**
 * Scale one rival to the age: multiply every stack in their heroes' armies, and
 * hand each hero artifacts. `realm` 1 changes nothing, so this is safe to call
 * unconditionally.
 */
export function scaleRival(state, playerIndex, realm) {
  const steps = Math.max(0, realm - 1);
  if (steps > 0) {
    const mult = CONFIG.ENDLESS_ARMY_MULT ** steps;
    const artifactIds = Object.keys(ARTIFACTS).filter((id) => !ARTIFACTS[id].campaign); // story relics are granted, never rolled
    for (const hero of playerHeroes(state, playerIndex)) {
      for (const stack of hero.army) {
        if (!stack || !(stack.count > 0)) continue;
        stack.count = Math.max(stack.count, Math.round(stack.count * mult));
      }
      // Artifacts, so a rival's hero is a real duel and not just a bigger pile of
      // creatures. Drawn from state.rng, so a realm is reproducible from its seed.
      const n = CONFIG.ENDLESS_FOE_ARTIFACTS * steps;
      for (let i = 0; i < n && artifactIds.length; i++) {
        giveArtifact(state, hero, state.rng.pick(artifactIds));
      }
    }
  }

  // Parity LAST, and OUTSIDE the per-realm gate above. Last because it measures
  // EFFECTIVE stats, so it has to see the artifacts this function just handed out —
  // matched first and equipped afterwards would leave the rival above its peer by
  // exactly the artifacts. Outside because the army multiplier is a per-realm
  // escalation while being a real opponent is not: realm 1 simply has nothing to
  // match, and every realm after it does.
  //
  // This is the defect the day-56 chronicle opened with. The carry hands the player
  // three veteran commanders and this function used to hand rivals nothing but
  // bigger stacks and artifacts, so day one was a level-58 hero with a stat sum of
  // 151 against a level-11 hero with a stat sum of 15. The one player-vs-AI battle
  // of that whole game was fought at 1.05:1 in ARMY and ended 100-3, because the
  // commander is what decides a battle and the commander was the one thing the
  // rival never received. See docs/REVIEW-2026-08-halfgame.md section 3.
  matchRivalProgression(state, playerIndex);
}

/**
 * Build the next realm of an endless run from a won one.
 *
 * Returns a fresh GameState, or null when `state` is not an endless run. The
 * caller installs it (session.setState) and re-enters the adventure map — the
 * same shape as campaign.advanceCampaign, minus the "done" case, because there
 * is no last realm.
 */
export function advanceEndless(state) {
  if (!isEndless(state)) return null;
  const human = state.players.find((p) => p.isHuman);
  if (!human) return null;

  const realm = endlessRealm(state) + 1;
  const commander = captureCommander(state);
  const sidekicks = captureSidekicks(state, Math.max(0, CONFIG.ENDLESS_CARRY_HEROES - 1));
  // The masonry of the realm just won, plus whatever earlier realms contributed:
  // a run's towns get taller as it goes, they never regress.
  const legacy = [...new Set([...(state.endless.buildings || []), ...captureTownLegacy(state, human.index)])].sort();

  // A fresh map from the SAME setup, with a seed drawn from the finished game's
  // stream so the whole run is reproducible from the first seed alone.
  const setup = { ...state.endless.setup, seed: state.rng.int(1, 2 ** 30) };
  // A BIGGER realm, not just a harder one. The run's map grows a step on both
  // axes each time, until it reaches the largest the generator ships — past that
  // the size holds and only the hardness below keeps climbing, which is the
  // "if none available, same size map, just dial the monsters up" case. Sizes
  // are derived from the ORIGINAL setup and the realm number rather than
  // accumulated, so the whole run stays reproducible from the first seed.
  const grow = CONFIG.ENDLESS_MAP_STEP * (realm - 1);
  setup.mapW = Math.min(CONFIG.ENDLESS_MAP_MAX_W, (state.endless.setup.mapW || 44) + grow);
  setup.mapH = Math.min(CONFIG.ENDLESS_MAP_MAX_H, (state.endless.setup.mapH || 36) + grow);
  // Wild stacks scale to your army through the Tide of War floor — the engine's
  // existing lever for exactly this, so a veteran army does not walk over realm 4.
  setup.tideHardness = Math.min(
    CONFIG.TIDE_HARDNESS_MAX,
    (Number.isFinite(state.tideHardness) ? state.tideHardness : CONFIG.TIDE_HARDNESS_DEFAULT)
      + CONFIG.ENDLESS_TIDE_STEP,
  );
  const next = newGame(setup);
  next.endless = { realm, setup: { ...state.endless.setup }, buildings: legacy };

  // Your veterans: the commander overwrites the starting hero, the lieutenants
  // muster beside the town. Both raise a fresh army, as in a campaign chapter.
  applyCommanderCarry(next, commander);
  applySidekickCarry(next, sidekicks);

  // The age has advanced for everyone: every capital starts as developed as the
  // one you left behind, and every rival's field army is scaled to the realm.
  for (const player of next.players) {
    const town = playerTowns(next, player.index)[0];
    if (town) applyTownLegacy(next, town, legacy, townHasCoast(next, town));
    if (!player.isHuman) scaleRival(next, player.index, realm);
  }

  const bigger = setup.mapW > (state.map?.w || 0) || setup.mapH > (state.map?.h || 0);
  logMsg(next, `Realm ${realm}. Your veterans march into a ${bigger ? 'wider' : 'harder'} land that has heard of them.`);
  return next;
}

/** Is any tile orthogonally or diagonally adjacent to this town open water? The
 *  shipyard test, kept local so this module needs nothing from actions.js. */
function townHasCoast(state, town) {
  const { w, h } = state.map;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = town.x + dx, y = town.y + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (state.map.tiles[y * w + x]?.terrain === 'water') return true;
    }
  }
  return false;
}
