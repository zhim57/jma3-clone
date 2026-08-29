/**
 * campaign.js — The campaign engine: start a campaign, capture a commander's
 * progression when a chapter is won, and build the next chapter with that
 * commander carried forward (fresh army, kept level/skills/spells/artifacts).
 *
 * Progress lives in `state.campaign`:
 *   { id, scenarioIndex, carry, bonusId, seed, playerName, completed }
 * — all plain data, so it round-trips saves with no version bump (like
 * `state.victory`). The VIEW drives the flow: start via `startCampaign`, and on
 * a human win of a campaign game call `advanceCampaign` to get the next
 * chapter's state (or a { done:true } when the final chapter falls).
 *
 * Design note: a chapter is a PROCEDURAL map with authored parameters (size,
 * difficulty, enemies) — we have no hand-drawn maps — so `buildScenarioState`
 * just parameterises `newGame`. The commander's IDENTITY and progression are
 * what carry; the map and the starting army are freshly generated each chapter.
 */

import { CONFIG, XP_TABLE } from '../config.js';
import { newGame, playerHeroes, playerTowns, createHero, tileAt, heroAt, featureOn } from './GameState.js';
import { HERO_ROSTER, HERO_CLASSES } from '../data/heroes.js';
import { addToArmy, heroMaxMana, heroMaxMovement, heroStat } from './heroUtils.js';
import { giveArtifact, gainXp, chooseSkill } from './actions.js';
import { bestSkillOption } from './skillPolicy.js';
import { ARTIFACTS } from '../data/artifacts.js';
import { campaignById } from '../data/campaigns.js';
import { generateSaga } from '../data/sagas.js';

/** The default carry rule when a scenario omits one (chapters after the first). */
const DEFAULT_CARRY = { skills: true, spells: true, artifacts: 'all' };

/** How many SIDEKICK heroes (beyond the commander) carry between chapters. */
const MAX_SIDEKICKS = 2;

/** A portable snapshot of a hero's IDENTITY + progression — everything that
 *  carries between chapters. The army is deliberately NOT captured (each chapter
 *  raises a fresh force). Shared by the commander and the sidekicks. */
function heroPayload(h) {
  return {
    rosterId: h.rosterId,
    name: h.name,
    level: h.level,
    xp: h.xp,
    stats: { ...h.stats },
    skills: { ...h.skills },
    spells: [...h.spells],
    specialty: h.specialty || null,
    equipment: JSON.parse(JSON.stringify(h.equipment || {})),
    backpack: JSON.parse(JSON.stringify(h.backpack || [])),
  };
}

/**
 * Resolve a `state.campaign` descriptor to its campaign definition. A saga is
 * regenerated deterministically from its tiny stored descriptor (so saves stay
 * small and reproducible); a hand-authored campaign is looked up by id.
 */
function campDef(c) {
  return c && c.sagaOpts ? generateSaga(c.sagaOpts) : campaignById(c && c.id);
}

/** Build one chapter's GameState from its authored parameters. The pacing keys
 *  (undefined for hand-authored campaigns → Classic) let a saga run under the
 *  Tide of War preset, carried across every chapter. wildGrowth / pveScaling
 *  ride the same rails: they are deliberately NOT part of the pacing preset
 *  (see game/settings.js), so if they were dropped here newGame's `!== false`
 *  defaults would silently force them back ON for every chapter — which is
 *  exactly the bug this list once had (CampaignScene passed both; this
 *  destructure discarded them, while CustomScenarioScene worked). */
function buildScenarioState(camp, idx, { seed, playerName, pacing, wildGrowth, pveScaling, tideHardness, tideIntervention, tideInterventionPower, heroPowerWeight, features }) {
  const scn = camp.scenarios[idx];
  // A campaign may REQUIRE its own mechanics: a Migration Age saga cannot be
  // played with invasions switched off, since the invasions are the premise. The
  // player's own flags still apply — this only adds what the chain depends on.
  const effective = camp.forceFeatures ? { ...(features || {}), ...camp.forceFeatures } : features;
  const players = [
    { faction: camp.faction, isHuman: true, team: 0, name: playerName },
    ...(scn.enemies || []).map((e) => ({ faction: e.faction, isHuman: false, team: e.team ?? 1 })),
  ];
  return newGame({
    seed: (seed | 0) + (scn.seedOffset ?? idx * 101),
    players,
    mapW: scn.mapW,
    mapH: scn.mapH,
    difficulty: scn.difficulty,
    victory: scn.victory || {},
    playerName,
    pacing,
    wildGrowth,
    pveScaling,
    tideHardness,
    tideIntervention,
    tideInterventionPower,
    heroPowerWeight,
    features: effective,
  });
}

/** The human player of a (campaign) state. */
function humanPlayer(state) {
  return state.players.find((p) => p.isHuman) || state.players[0] || null;
}

/**
 * Snapshot the human's commander (their highest-XP hero) into a portable
 * payload — the progression that carries between chapters. The army is
 * deliberately NOT captured: each chapter raises a fresh force.
 */
export function captureCommander(state) {
  const human = humanPlayer(state);
  if (!human) return null;
  const heroes = playerHeroes(state, human.index);
  if (!heroes.length) return null;
  const cmdr = heroes.reduce((best, h) => (h.xp > best.xp ? h : best), heroes[0]);
  return heroPayload(cmdr);
}

/**
 * Snapshot up to MAX_SIDEKICKS of the human's OTHER heroes (the next strongest
 * after the commander), so a retinue carries forward — not just the lead hero.
 * Each keeps its level / skills / spells / kept artifacts (a fresh army each
 * chapter, like the commander). Returns [] when the player fielded only one hero.
 */
export function captureSidekicks(state, max = MAX_SIDEKICKS) {
  const human = humanPlayer(state);
  if (!human) return [];
  const heroes = [...playerHeroes(state, human.index)].sort((a, b) => b.xp - a.xp);
  return heroes.slice(1, 1 + max).map(heroPayload); // skip [0], the commander
}

/**
 * Overwrite a fresh chapter's starting hero with the carried commander:
 * identity + progression become the commander's, honoring the chapter's carry
 * rule for skills / spells / artifacts. The map position and the freshly-rolled
 * army are KEPT (a new army each chapter). Returns the hero (or null).
 */
/** Stamp a carried payload's identity + progression onto `hero`, honoring the
 *  chapter's carry rule. The map position and freshly-rolled army are KEPT.
 *  Shared by the commander (overwrites the starting hero) and each sidekick. */
function applyCarryToHero(hero, payload, carryRule) {
  const def = HERO_ROSTER[payload.rosterId];
  if (def) {
    const cls = HERO_CLASSES[def.class];
    hero.rosterId = payload.rosterId;
    hero.name = payload.name;
    hero.class = def.class;
    hero.className = cls?.name || hero.className;
    hero.faction = def.faction;
    hero.portrait = def.portrait;
    hero.specialty = def.specialty || null;
  }
  hero.level = payload.level;
  hero.xp = payload.xp;
  hero.stats = { ...payload.stats };
  if (carryRule.skills !== false) hero.skills = { ...payload.skills };
  if (carryRule.spells !== false) hero.spells = [...payload.spells];
  if (carryRule.artifacts === 'all') {
    hero.equipment = JSON.parse(JSON.stringify(payload.equipment || {}));
    hero.backpack = JSON.parse(JSON.stringify(payload.backpack || []));
  }
  // Recompute derived pools now that stats / skills / army may have changed.
  hero.mana = heroMaxMana(hero);
  hero.mp = heroMaxMovement(hero);
  return hero;
}

export function applyCommanderCarry(state, payload, carryRule = DEFAULT_CARRY) {
  if (!payload) return null;
  const human = humanPlayer(state);
  const hero = human ? playerHeroes(state, human.index)[0] : null;
  if (!hero) return null;
  return applyCarryToHero(hero, payload, carryRule);
}

/** The nearest open, walkable land tile around (cx,cy) on the surface, not
 *  occupied by a hero/object/obstacle/water — where a carried sidekick musters. */
function openTileNear(state, cx, cy) {
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        const t = tileAt(state, x, y, 0);
        if (!t || t.obstacle || t.objectId || t.terrain === 'water') continue;
        if (heroAt(state, x, y, 0)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * Muster the carried SIDEKICKS into a fresh chapter: each becomes a new hero
 * next to the human's starting town, keeping its carried identity + progression
 * (per the chapter's carry rule) but raising a fresh army — exactly like the
 * commander. Skips any that can't be placed (no open ground). Returns the heroes.
 */
export function applySidekickCarry(state, payloads, carryRule = DEFAULT_CARRY) {
  const human = humanPlayer(state);
  if (!human || !payloads || !payloads.length) return [];
  const town = playerTowns(state, human.index)[0];
  if (!town) return [];
  const placed = [];
  for (const payload of payloads) {
    const spot = openTileNear(state, town.x, town.y);
    if (!spot) break; // no room left — the rest stay in reserve (dropped this chapter)
    const hero = createHero(state, payload.rosterId, human.index, spot.x, spot.y);
    hero.inTownId = null;
    applyCarryToHero(hero, payload, carryRule);
    placed.push(hero);
  }
  return placed;
}

/**
 * The carry's COUNTERWEIGHT.
 *
 * Everything above hands the player's veteran forward into a freshly generated
 * land. Nothing handed the rivals anything, and a fresh land generates its heroes at
 * level 1 — so the second chapter of a campaign and the second realm of an endless
 * run both open with a veteran commander against heroes that have just been born.
 * Measured on the day-56 chronicle, whose rivals had climbed to level 11 by the day-2
 * snapshot and were still 47 levels behind: stat sum 151 against 15, armies at
 * 1.05 : 1, and the one player-vs-AI battle of the entire game ended 100 to 3. The
 * commander is what decides a battle, and the commander was the one thing the rival
 * never received.
 *
 * So parity is applied wherever a carry is applied. It lives HERE, beside the carry
 * it answers, so that the next person to make veterans carry harder sees in the same
 * file what has to keep pace. Endless imports it; see docs/REVIEW-2026-08-halfgame.md
 * section 3.
 *
 * A fresh, uncarried game needs no call: everyone is level 1 and every branch below
 * is a no-op. That is why this is safe to call unconditionally.
 */
export function matchRivalProgression(state, playerIndex) {
  const human = state.players?.find((p) => p.isHuman);
  if (!human) return;
  // Rank both sides by level and pair them off, so a retinue is met by a retinue
  // rather than by one champion and two recruits. A rival with more heroes than the
  // human has pairs its surplus against the human's weakest — the point is that no
  // rival hero is a bystander, not that the rosters are the same shape.
  const mine = playerHeroes(state, human.index).map((h) => h.level || 1).sort((a, b) => b - a);
  if (!mine.length) return;
  const theirs = playerHeroes(state, playerIndex).sort((a, b) => (b.level || 1) - (a.level || 1));
  for (let i = 0; i < theirs.length; i++) {
    const hero = theirs[i];
    const peer = mine[Math.min(i, mine.length - 1)];
    const want = Math.max(1, Math.min(CONFIG.HERO_MAX_LEVEL,
      Math.round(peer * CONFIG.RIVAL_LEVEL_MATCH)));
    if ((hero.level || 1) >= want) continue;
    // Levelled through the REAL progression, never by writing numbers onto the hero:
    // gainXp runs the same loop a hero's own victories run, so the primaries rise on
    // the hero's own class growth and every level offers its skill choice.
    const need = (XP_TABLE[want] || 0) - (hero.xp || 0);
    if (need > 0) gainXp(state, hero, need);
    // …and TAKE those choices. gainXp only QUEUES them; a human resolves the queue at
    // the level-up screen and the AI resolves it on its own turn, so a rival levelled
    // here would otherwise stand on day one with 57 unread choices and the two skills
    // it was born with — measured. Skills are most of what a commander contributes, so
    // that rival would have parity in every number and still not be an opponent.
    // Scored with the AI's own picker, so a rival built by parity is the same
    // commander the AI would have grown (see core/skillPolicy.js).
    while (hero.pendingSkillChoices?.length) {
      chooseSkill(state, hero, bestSkillOption(hero, hero.pendingSkillChoices[0].options,
        (id) => featureOn(state, id)));
    }
  }
  matchRivalStats(state, playerIndex, human.index);
}

const PRIMARIES = ['attack', 'defense', 'power', 'knowledge'];
// EFFECTIVE stats, not base. `hero.stats` is the raw ledger; heroStat adds artifacts
// and a stat specialty on top, and BOTH sides bring those — the carry forwards the
// player's equipment and backpack intact, and scaleRival hands each rival artifacts of
// its own. Matching base against base would therefore compare the two ledgers and
// leave everything both sides have EQUIPPED out of the comparison entirely.
// Measured: a player carrying one relic reads 144 base / 152 effective; the rival this
// matches lands on 152 effective from 141 base, its own relics carrying the remainder.
// Adding a point to `stats` raises effective by exactly one, so the arithmetic below is
// unchanged either way — only the measure it aims at moves.
const statSum = (h) => (h?.stats ? PRIMARIES.reduce((n, k) => n + heroStat(h, k), 0) : 0);

/**
 * Close whatever stat gap the LEVELS did not, rank for rank.
 *
 * Levelling a rival to its peer's level is most of the fix and not all of it,
 * because most of a veteran's stats never came from levelling. Measured over the
 * day-56 chronicle: the player's commander gained 2 levels across 192 victories
 * while her stat sum went 144 to 209 — 63 of those 65 points came from map boosters
 * and artifacts, sources a freshly-generated rival has never had a chance to visit.
 * Matching level alone therefore lands a rival at a stat sum around 63 against a
 * carried commander's 151, which is closer than 15 and still not an opponent.
 *
 * So the remainder is granted. That is symmetric rather than generous: the player's
 * points were granted too, by a map they walked over, and a rival that starts on a
 * fresh map has no equivalent walk available before the first battle.
 *
 * Spread round-robin across the four primaries rather than poured into attack. A
 * lopsided rival is a puzzle with one answer; an even one has to be fought.
 */
export function matchRivalStats(state, playerIndex, humanIndex) {
  const mine = playerHeroes(state, humanIndex).map(statSum).sort((a, b) => b - a);
  if (!mine.length) return;
  const theirs = playerHeroes(state, playerIndex).sort((a, b) => statSum(b) - statSum(a));
  for (let i = 0; i < theirs.length; i++) {
    const hero = theirs[i];
    const peer = mine[Math.min(i, mine.length - 1)];
    const want = Math.round(peer * CONFIG.RIVAL_STAT_MATCH);
    let gap = want - statSum(hero);
    if (gap <= 0) continue;
    hero.stats = hero.stats || {};
    for (let k = 0; gap > 0; k++, gap--) {
      const stat = PRIMARIES[k % PRIMARIES.length];
      hero.stats[stat] = (hero.stats[stat] || 0) + 1;
    }
  }
}

/**
 * Apply a chosen start-of-chapter bonus (or the first offered, or none) to the
 * human commander. Declarative kinds keep this data-driven. Records the applied
 * id on `state.campaign.bonusId`.
 */
export function applyScenarioBonus(state, scn, bonusId) {
  const list = scn.bonuses || [];
  if (!list.length) return null;
  const bonus = list.find((b) => b.id === bonusId) || list[0];
  const human = humanPlayer(state);
  const hero = human ? playerHeroes(state, human.index)[0] : null;
  if (bonus.kind === 'resource' && human) {
    for (const [res, amt] of Object.entries(bonus.resources || {})) {
      human.resources[res] = (human.resources[res] || 0) + amt;
    }
  } else if (bonus.kind === 'creatures' && hero) {
    addToArmy(hero.army, bonus.creature, bonus.count);
  } else if (bonus.kind === 'artifact' && hero && ARTIFACTS[bonus.artifact]) {
    // Story relics (e.g. the saga's three Panoply pieces) are handed to the
    // commander at chapter start — auto-equipped into their slot if free, else
    // dropped in the backpack. carry.artifacts:'all' keeps them thereafter, so a
    // relic granted in Chapter 6 is still worn in Chapter 20.
    giveArtifact(state, hero, bonus.artifact);
  }
  if (state.campaign) state.campaign.bonusId = bonus.id;
  return bonus;
}

/**
 * Start a campaign at chapter 1. `opts`: { bonusId, seed, playerName }.
 * Returns the first chapter's GameState with `state.campaign` set.
 */
export function startCampaign(campaignId, opts = {}) {
  const camp = campaignById(campaignId);
  if (!camp) throw new Error(`Unknown campaign: ${campaignId}`);
  const seed = (opts.seed ?? ((Math.random() * 2 ** 31) | 0)) | 0;
  const { playerName, pacing, wildGrowth, pveScaling, tideHardness, tideIntervention, tideInterventionPower, heroPowerWeight, features } = opts;
  const state = buildScenarioState(camp, 0, { seed, playerName, pacing, wildGrowth, pveScaling, tideHardness, tideIntervention, tideInterventionPower, heroPowerWeight, features });
  state.campaign = {
    id: camp.id, scenarioIndex: 0, carry: null,
    bonusId: null, seed, playerName: playerName || null, completed: false,
    // Carry the pacing preset across chapters (advanceCampaign reads these), so
    // a hand-authored campaign started under Tide of War stays under it — just
    // like a saga. Undefined ⇒ Classic (the prior behaviour). Optional features
    // ride along the same way, and so do wildGrowth / pveScaling — a player who
    // turned those off in Settings must not get them back on in chapter 2.
    pacing, wildGrowth, pveScaling, tideHardness, tideIntervention, tideInterventionPower, heroPowerWeight, features,
  };
  applyScenarioBonus(state, camp.scenarios[0], opts.bonusId);
  return state;
}

/**
 * Start a procedural SAGA (#4) at chapter 1. `opts`: { length, faction, seed,
 * playerName, bonusId, pacing, tideHardness, tideIntervention }. The saga is a
 * generated N-chapter campaign; its descriptor (seed/length/faction) is stored
 * on state.campaign so every chapter regenerates the same chain, and the pacing
 * keys carry the Tide of War preset across the whole saga. Returns the first
 * chapter's GameState.
 */
export function startSaga(opts = {}) {
  const seed = (opts.seed ?? ((Math.random() * 2 ** 31) | 0)) | 0;
  const sagaOpts = { seed, length: opts.length ?? 10, faction: opts.faction || 'castle',
    archetype: opts.archetype || 'classic' };
  const camp = generateSaga(sagaOpts);
  const { playerName, pacing, wildGrowth, pveScaling, tideHardness, tideIntervention, tideInterventionPower, heroPowerWeight, features } = opts;
  const state = buildScenarioState(camp, 0, { seed, playerName, pacing, wildGrowth, pveScaling, tideHardness, tideIntervention, tideInterventionPower, heroPowerWeight, features });
  state.campaign = {
    id: camp.id, sagaOpts, scenarioIndex: 0, carry: null, bonusId: null,
    seed, playerName: playerName || null, completed: false,
    pacing, wildGrowth, pveScaling, tideHardness, tideIntervention, tideInterventionPower, heroPowerWeight, features,
  };
  applyScenarioBonus(state, camp.scenarios[0], opts.bonusId);
  return state;
}

/**
 * The human has WON the current chapter — build the next one with the commander
 * carried forward, or finish the campaign. `opts`: { bonusId }.
 * Returns { done, state }: done=true (with the same state, `campaign.completed`
 * set) when the final chapter was the last; else the next chapter's fresh state.
 */
export function advanceCampaign(state, opts = {}) {
  const c = state.campaign;
  if (!c) throw new Error('advanceCampaign: not a campaign game');
  const camp = campDef(c);
  if (!camp) throw new Error(`advanceCampaign: unknown campaign ${c.id}`);
  const nextIdx = c.scenarioIndex + 1;
  if (nextIdx >= camp.scenarios.length) {
    c.completed = true;
    return { done: true, state };
  }
  const payload = captureCommander(state);
  const sidekicks = captureSidekicks(state); // the retinue carries too (#sidekicks)
  const next = buildScenarioState(camp, nextIdx, {
    seed: c.seed, playerName: c.playerName,
    pacing: c.pacing, wildGrowth: c.wildGrowth, pveScaling: c.pveScaling, tideHardness: c.tideHardness, tideIntervention: c.tideIntervention, tideInterventionPower: c.tideInterventionPower, heroPowerWeight: c.heroPowerWeight, features: c.features,
  });
  next.campaign = {
    id: c.id, sagaOpts: c.sagaOpts, scenarioIndex: nextIdx, carry: payload, sidekicks,
    bonusId: null, seed: c.seed, playerName: c.playerName, completed: false,
    pacing: c.pacing, wildGrowth: c.wildGrowth, pveScaling: c.pveScaling, tideHardness: c.tideHardness, tideIntervention: c.tideIntervention, tideInterventionPower: c.tideInterventionPower, heroPowerWeight: c.heroPowerWeight, features: c.features,
  };
  const scn = camp.scenarios[nextIdx];
  const rule = scn.carry || DEFAULT_CARRY;
  applyCommanderCarry(next, payload, rule);
  applySidekickCarry(next, sidekicks, rule); // muster the retinue beside the town
  applyScenarioBonus(next, scn, opts.bonusId);
  // …and bring every rival up to the veteran who just walked in. AFTER the carry and
  // the bonus, because parity is measured against what the player actually fields on
  // day one — a chapter bonus of +2 to all stats is part of that. A chapter is an
  // authored map, but its heroes are not authored: scenarios set size, difficulty and
  // seed, never hero levels, so without this the rivals of chapter 2 are whatever
  // newGame makes at level 1.
  for (const player of next.players) {
    if (!player.isHuman) matchRivalProgression(next, player.index);
  }
  return { done: false, state: next };
}

/** Is this state a campaign game? */
export function isCampaign(state) {
  return !!(state && state.campaign);
}

/** The definition of the chapter currently being played (or null). */
export function currentScenario(state) {
  if (!isCampaign(state)) return null;
  const camp = campDef(state.campaign);
  return camp?.scenarios[state.campaign.scenarioIndex] || null;
}

/** The bonus options for a given campaign chapter (for the intro screen). */
export function scenarioBonuses(campaignId, scenarioIndex) {
  const camp = campaignById(campaignId);
  return camp?.scenarios[scenarioIndex]?.bonuses || [];
}
