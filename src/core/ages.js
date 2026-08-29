/**
 * ages.js — the age floor: how grown a realm must be before a win may settle.
 *
 * Reported, after a game ended on day sixty-something: "this game finished after
 * I beat up the first rogue band attacking me — can we set up some guardrails so
 * I can play enough time in developing [the] game, in medium developed and a fully
 * developed? I could not finish and try my castle units improvements nor to face
 * some full fledge invasions from enemy hordes."
 *
 * The complaint is not about which condition won. It is that the CONDITION AND THE
 * AGE ARE THE SAME CLOCK: whatever you set out to do, the map is over the instant
 * you do it, and on a fast map that can be before a capitol is standing, before a
 * dwelling has been upgraded, and before the sea has sent anything worth the name.
 *
 * So an age floor is a second clock, and it changes NO victory condition. It says
 * only when the realm is grown enough for a win to settle. A win earned earlier is
 * HELD — announced, recorded, and awarded the day the floor is met (actions.
 * checkVictory re-derives it every turn, so a win that stops being true simply
 * stops being pending). Three properties make that safe to switch on:
 *
 *   · Nothing holds a DEFEAT. Only the human's own victory waits.
 *   · `patience` lifts the floor by the calendar alone, so a realm that CANNOT
 *     meet a requirement — its capital razed, its masons dead — is never trapped
 *     in a game it has already won.
 *   · The crown can always be taken early (actions.claimVictoryNow), which waives
 *     every hold at once. A guardrail
 *     the player cannot step over is a cage.
 *
 * The floors themselves are CONFIG.AGE_FLOORS. What is measured lives here, and
 * it is measured off things the player does rather than off a timer alone: a seat
 * of power (one town carrying that hall behind that wall), the dwellings standing
 * in that same town and how many are upgraded, and the waves that have come
 * ashore. "Medium developed" and "fully developed" in the words of the report.
 *
 * Pure rule-engine: no Phaser, no view imports, and nothing here mutates state.
 */

import { CONFIG } from '../config.js';
import { playerTowns } from './GameState.js';
import { buildingCatalog } from '../data/buildings.js';

/** The floor this game runs under, or null for none (the default, 'swift'). */
export function ageFloorSpec(state) {
  const id = state?.victory?.ageFloor;
  const spec = id ? CONFIG.AGE_FLOORS?.[id] : null;
  if (!spec || spec.id === 'swift') return null;
  return spec;
}

/** Does this floor need the waves to be running? (The setup switches them on.) */
export function ageFloorNeedsWaves(spec) {
  return !!(spec && spec.waves > 0);
}

/** How developed one town is: its hall, its wall, its dwellings and its upgrades. */
export function townDevelopment(town) {
  const built = new Set(town?.buildings || []);
  const catalog = buildingCatalog(town?.faction);
  let dwellings = 0, upgrades = 0;
  for (const id of built) {
    const b = catalog?.[id];
    if (!b?.dwellingTier) continue;
    if (b.dwellingUpgrade) upgrades++; else dwellings++;
  }
  return { built, dwellings, upgrades };
}

/**
 * The team's SEAT OF POWER for a given floor: the one town that comes closest to
 * carrying it.
 *
 * One town, deliberately. A capitol in the north and a castle in the south is two
 * half-built towns, and "fully developed" in the report plainly means a capital
 * you could point at. Scored by how many of the floor's four town requirements a
 * town meets, then by masonry, so the reading is stable as the realm grows.
 */
export function seatOfPower(state, team, spec) {
  let best = null, bestScore = -1;
  for (const p of state?.players || []) {
    if ((p.team ?? p.index) !== team || p.defeated) continue;
    for (const town of playerTowns(state, p.index)) {
      const dev = townDevelopment(town);
      const score = (spec.hall && dev.built.has(spec.hall) ? 1 : 0)
        + (spec.fort && dev.built.has(spec.fort) ? 1 : 0)
        + (dev.dwellings >= (spec.dwellings || 0) ? 1 : 0)
        + (dev.upgrades >= (spec.upgrades || 0) ? 1 : 0);
      const rank = score * 1000 + dev.dwellings * 10 + dev.upgrades;
      if (rank > bestScore) { bestScore = rank; best = { town, ...dev }; }
    }
  }
  return best;
}

/** How many foreign waves have come ashore in this realm (landed, not repelled —
 *  the report asked to FACE them).
 *
 *  BOTH tiers of invasion count. The light tier's war-band waves write
 *  `invasion.history` (invasions.landWave); the heavy tier's nations write
 *  `invaderPlan.history` (invaderPlanner.tickInvaderPlanner) — and the heavy tier
 *  deliberately stands the band waves DOWN while a people holds the field
 *  (invasions.tickInvasions), so a tally read off the band ledger alone froze the
 *  day the first nation came ashore. Measured under {ageFloor: 'golden'}: one
 *  band wave in 461 days, the waves-faced requirement met only by the day-448
 *  patience backstop — a guardrail reduced to a timer. A nation with camps and
 *  commanders is if anything MORE of a wave than three stacks of wolf riders;
 *  counting it is what the report's "face some full fledge invasions" plainly
 *  means. The alternative — a separate 'nations faced' floor term — was rejected:
 *  the floor's question is "has the sea sent anything worth the name", and the
 *  answer should not depend on which tier's clock happened to fire. */
export function wavesFaced(state) {
  return (state?.invasion?.history || []).length
    + (state?.invaderPlan?.history || []).length;
}

/**
 * The floor, item by item: what it asks, what the realm has, and whether the age
 * is grown. `met` is the whole answer; `needs` is what the player is shown.
 *
 * `lifted` says the floor stopped holding for a reason other than being met — the
 * patience backstop ran out, or the crown was claimed early — which is a different
 * sentence to write on a screen than "you have done it".
 */
export function ageProgress(state, team) {
  const spec = ageFloorSpec(state);
  if (!spec) return { floor: null, met: true, lifted: false, needs: [] };
  const day = state?.day || 1;
  const seat = seatOfPower(state, team, spec);
  const needs = [];
  // `count` separates the two kinds of requirement, because they are READ
  // differently: a tally wants its progress printed next to it ("2/5"), a
  // building is a yes or a no and printing "0/1" beside it only adds noise.
  const tally = (id, label, have, need) => needs.push({ id, label, have, need, count: true, done: have >= need });
  const standing = (id, label, built) => needs.push({ id, label, have: built ? 1 : 0, need: 1, count: false, done: !!built });

  if (spec.days > 0) tally('days', 'The realm has stood', day, spec.days);
  if (spec.hall) standing('hall', `A ${buildingName(seat?.town, spec.hall)} in your capital`, seat?.built.has(spec.hall));
  if (spec.fort) standing('fort', `That capital behind a ${buildingName(seat?.town, spec.fort)}`, seat?.built.has(spec.fort));
  if (spec.dwellings > 0) tally('dwellings', 'Dwellings raised there', seat?.dwellings || 0, spec.dwellings);
  if (spec.upgrades > 0) tally('upgrades', 'Of those, upgraded', seat?.upgrades || 0, spec.upgrades);
  if (spec.waves > 0) tally('waves', 'Foreign waves weathered', wavesFaced(state), spec.waves);

  const met = needs.every((n) => n.done);
  const waived = !!state?.victory?.crownWaived;
  const patienceOut = spec.patience > 0 && day >= spec.patience;
  return {
    floor: spec,
    met: met || waived || patienceOut,
    lifted: !met && (waived || patienceOut),
    waived,
    patienceOut,
    needs,
    daysLeft: Math.max(0, (spec.days || 0) - day),
  };
}

/** The catalogue's own name for a building, so the floor reads in the language of
 *  the town screen ("a Capitol", "a Castle") whatever the faction calls it. */
function buildingName(town, id) {
  return buildingCatalog(town?.faction)?.[id]?.name || id;
}

/**
 * Must a win for `team` wait? The one question actions.checkVictory asks.
 *
 * True only while a floor is set, unmet, unwaived and inside its patience. Every
 * other case — no floor, floor met, backstop passed, crown claimed — is false,
 * which is what makes this safe to consult from the victory path unconditionally.
 */
export function ageFloorHeld(state, team) {
  if (!ageFloorSpec(state)) return false;
  return !ageProgress(state, team).met;
}

/** One line for the HUD and the scenario panel: the floor and what is left of it. */
export function ageFloorText(state, team = null) {
  const spec = ageFloorSpec(state);
  if (!spec) return null;
  const t = team ?? (state?.players?.find((p) => p.isHuman)?.team ?? 0);
  const prog = ageProgress(state, t);
  if (prog.waived) return `${spec.name} — set aside; the crown was claimed early.`;
  if (prog.patienceOut) return `${spec.name} — the age has run its course; a win settles now.`;
  if (prog.met) return `${spec.name} — the realm is grown; a win settles now.`;
  const left = prog.needs.filter((n) => !n.done)
    .map((n) => (n.count ? `${n.label} ${n.have}/${n.need}` : n.label));
  return `${spec.name} — still wanted: ${left.join(' · ')}`;
}

/** The floor's own headline, for menus and the setup screen. */
export function ageFloorLabel(id) {
  const spec = CONFIG.AGE_FLOORS?.[id];
  return spec ? spec.name : CONFIG.AGE_FLOORS.swift.name;
}
