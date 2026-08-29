/**
 * GameState.js — The single source of truth for a running game.
 *
 * DESIGN: the whole game is a tree of plain serializable objects (state).
 * Scenes/UI never own game data — they render state and call verbs from
 * actions.js. This separation gives us trivial save/load, headless testing
 * and AI simulation. See docs/ARCHITECTURE.md.
 */

import { CONFIG, RESOURCES } from '../config.js';
import { Rng } from './rng.js';
import { PLAYER_COLOR_NAMES } from '../data/factions.js';
import { HERO_ROSTER, HERO_CLASSES } from '../data/heroes.js';
import { generateMap } from '../map/MapGenerator.js';
import { revealAround, createFog } from '../map/fog.js';
import { heroMaxMovement, heroMaxMana } from './heroUtils.js';
import { wildStacks, medianBandValue } from './neutrals.js';
import { telemetryForSave } from '../ai/telemetry.js';

/**
 * Fresh hero/town id, minted from the STATE's own counter (save v3+). A
 * module-global counter here used to bleed across games in one process: the
 * second same-seed game minted T6… instead of T1…, so object iteration order
 * (and thus AI hero processing order) diverged between two "identical" runs —
 * breaking same-seed determinism and any snapshot comparison.
 */
function uid(state, prefix) {
  if (typeof state.nextUid !== 'number') state.nextUid = 1;
  return `${prefix}${state.nextUid++}`;
}

// How many nudged-seed layouts to try before giving up when the connectivity
// carve can't link a map. ~0.2% of seeds fail once; the chance that 8 independent
// layouts all fail is negligible (~1e-22).
const MAP_GEN_ATTEMPTS = 8;

// Deal an AI player its warlord temperament (see CONFIG.WARLORDS). A pure
// integer hash of (seed, index) — deterministic per seed, and crucially it
// touches NEITHER state.rng NOR the map-gen stream, so adding personalities
// leaves every seed's map byte-identical. A single-AI game and a many-AI game
// on the same seed each get a stable, reproducible spread of temperaments.
export function warlordFor(seed, index) {
  // The DEALT pool, not every profile in the table: an assigned-only temperament
  // (an invader's) must never enter the hash, or adding one reshuffles every seed.
  const keys = CONFIG.WARLORD_POOL || Object.keys(CONFIG.WARLORDS);
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = (h + Math.imul(index + 1, 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return keys[h % keys.length];
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Create a fresh game.
 * setup: { seed, playerFaction, aiFaction, mapW, mapH, playerName }
 */
export function newGame(setup = {}) {
  const seed = setup.seed ?? ((Math.random() * 2 ** 31) | 0);
  const state = {
    version: SAVE_VERSION,
    seed,
    nextUid: 1,                      // hero/town id counter (lives in the save — see uid)
    rng: new Rng(seed ^ 0x9e3779b9), // gameplay stream (separate from mapgen)
    day: 1,                          // absolute day, 1-based; week = floor((day-1)/7)+1
    currentPlayer: 0,
    players: [],
    heroes: {},
    towns: {},
    caravans: [],                    // in-transit troop caravans (see actions.dispatchCaravan)
    jobs: [],                        // multi-day work in progress (see core/jobs.js)
    map: null,
    fog: [],                         // per-player surface fog (level 0)
    fogUnder: [],                    // per-player underground fog (level 1)
    log: [],                         // rolling message log (day-stamped)
    winner: null,                    // winning TEAM once the game ends (-1 = draw)
    winReason: null,                 // how it ended: 'grail'|'conquest'|'draw'|'captureTown'|'survive'|'gold'|'mines'
    // Victory conditions BEYOND standard elimination (which always applies, so a
    // special objective is an ADDITIONAL win path). Plain data → round-trips
    // saves. `grail` (the Grail race) stays its own flag for back-compat; the
    // other objectives ride a `kind`:
    //   captureTown   — first team to hold `targetTownId` (chosen at gen) wins
    //   surviveN      — the human's team wins by outlasting `surviveDays`
    //   accumulateGold— first team to amass `goldTarget` (summed) wins
    //   flagMines     — the human's team wins by controlling every mine (of
    //                   `mineType`, or all of them)
    victory: normalizeVictory(setup.victory),
  };

  // Player roster: an explicit setup.players list — each { faction, isHuman,
  // team, name? } — or the classic 1-human-vs-1-AI pair. The human is
  // conventionally on team 0, so a "team 0 wins" outcome reads as a human win.
  const roster = setup.players || [
    { faction: setup.playerFaction || 'castle', isHuman: true, team: 0 },
    { faction: setup.aiFaction || 'inferno', isHuman: false, team: 1 },
  ];
  // Difficulty: scales each side's starting pile (and, via dailyIncome, the AI's
  // daily take). Unknown/absent → the default. Stored on state so it round-trips.
  state.difficulty = CONFIG.DIFFICULTIES[setup.difficulty] ? setup.difficulty : CONFIG.DEFAULT_DIFFICULTY;
  // Which front door this game came through: 'custom' | 'conquest' | 'saga' | …
  // Purely a label, for the menus — a skirmish and a custom game share one save
  // slot, and a resume button that says "your custom game" has to know it is one.
  // Absent on older saves, which read as an unnamed skirmish.
  state.setupKind = typeof setup.kind === 'string' ? setup.kind : null;
  // Pacing preset — see CONFIG.PACING. OFF by default ('classic' = base game),
  // so an absent/unknown value reads as classic and old saves are unaffected.
  state.pacing = CONFIG.PACING[setup.pacing] ? setup.pacing : CONFIG.DEFAULT_PACING;
  // Do the wild stacks already on the map swell week by week? ON unless explicitly
  // turned off — see pacing.wildStacksGrow for why this is NOT part of the pacing
  // preset: a preset is snapshotted here and can never be adopted by a game already
  // running, which left a nine-week save with a frozen, solved map.
  state.wildGrowth = setup.wildGrowth !== false;
  // And whether a PvE fight is scaled up to a fraction of the attacking hero's army
  // when it would otherwise be a walkover (see pacing.pveScalesToArmy). ON unless
  // turned off, and unbundled from the preset for the same reason: growth alone is
  // bounded by each stack's original size and so can be outgrown; this cannot.
  state.pveScaling = setup.pveScaling !== false;
  // Tide of War challenge floor (see CONFIG.TIDE_HARDNESS_*): the fraction of
  // your army the world's PvE defenders are scaled up to (#8), so combat stays
  // a real fight as you grow. Seeded from setup — the menu passes the player's
  // Settings value — clamped, and round-tripped through the save spread.
  state.tideHardness = Math.max(CONFIG.TIDE_HARDNESS_MIN, Math.min(CONFIG.TIDE_HARDNESS_MAX,
    Number.isFinite(setup.tideHardness) ? setup.tideHardness : CONFIG.TIDE_HARDNESS_DEFAULT));
  // Tide of War divine-intervention level (#9): how often the gods bolster a
  // lopsided battle's underdog. Seeded from setup (the menu passes the Settings
  // value); coerced to a known level; round-trips the save spread.
  state.tideIntervention = CONFIG.TIDE_INTERVENTION_LEVELS.includes(setup.tideIntervention)
    ? setup.tideIntervention : CONFIG.TIDE_INTERVENTION_DEFAULT;
  // Divine-intervention POWER (#9): the magnitude ceiling (Settings slider). Seeded
  // from setup, clamped [MIN, MAX], round-tripped; absent ⇒ the default (old cap).
  state.tideInterventionPower = Math.max(CONFIG.TIDE_INTERVENTION_POWER_MIN, Math.min(CONFIG.TIDE_INTERVENTION_POWER_MAX,
    Number.isFinite(setup.tideInterventionPower) ? setup.tideInterventionPower : CONFIG.TIDE_INTERVENTION_POWER_DEFAULT));
  // Hero-strength weight (Settings slider): how much a commander's attack/defense +
  // spell-power × mana counts toward "force" in balance comparisons. Clamped, round-tripped.
  state.heroPowerWeight = Math.max(CONFIG.HERO_POWER_WEIGHT_MIN, Math.min(CONFIG.HERO_POWER_WEIGHT_MAX,
    Number.isFinite(setup.heroPowerWeight) ? setup.heroPowerWeight : CONFIG.HERO_POWER_WEIGHT_DEFAULT));
  // AI learning memory (#): a running read of the human's tactics that adapts AI
  // behavior (see actions.recordHumanBattleMemory). Round-trips the save.
  state.aiMemory = { disableRate: 0, battles: 0, courageMult: 1 };
  // Optional rule-engine features — a plain { key: bool } map (from the player's
  // Settings, via gameFeatureFlags), coerced to booleans. Absent ⇒ all off, so
  // old saves and the headless tests read as Classic. Round-trips the save spread.
  state.features = Object.fromEntries(
    Object.entries(setup.features || {}).map(([k, v]) => [k, !!v]),
  );
  // An age floor that counts foreign waves needs the waves to be running, or the
  // realm could never grow into its own ending. Same move the Pax makes when it
  // installs a `repelInvasions` objective (actions.enterPax) — read from CONFIG
  // rather than through core/ages.js, so this module keeps importing nothing.
  if ((CONFIG.AGE_FLOORS?.[state.victory.ageFloor]?.waves || 0) > 0) state.features.invasions = true;
  // …and so does an objective the sea decides: a `holdTowns` target counts towns
  // that only an invasion can put on the map (its beachhead camps), and a
  // `repelInvasions` target counts the invasions themselves.
  if (state.victory.kind === 'holdTowns' || state.victory.kind === 'repelInvasions'
    || state.victory.kind === 'invaderBattles') {
    state.features.invasions = true;
  }
  const diff = CONFIG.DIFFICULTIES[state.difficulty];
  const startResources = (mult) => {
    const r = {};
    for (const res of RESOURCES) r[res] = Math.round((CONFIG.STARTING_RESOURCES[res] || 0) * mult);
    return r;
  };
  roster.forEach((pc, i) => {
    state.players.push({
      index: i,
      name: pc.name || (pc.isHuman ? (setup.playerName || 'Player') : `${PLAYER_COLOR_NAMES[i % PLAYER_COLOR_NAMES.length]} Warlord`),
      colorName: PLAYER_COLOR_NAMES[i % PLAYER_COLOR_NAMES.length],
      faction: pc.faction,
      isHuman: !!pc.isHuman,
      team: pc.team ?? i,
      // AI temperament: a named tuning profile the controller reads (see
      // AIPlayer). Dealt deterministically from (seed, index) via a pure hash —
      // it does NOT draw from the map-gen rng, so a given seed keeps producing
      // a byte-identical map. Humans have no controller, so they get none.
      warlord: pc.isHuman ? null : (pc.warlord || warlordFor(seed, i)),
      resources: startResources(pc.isHuman ? diff.human : diff.ai),
      daysWithoutTown: 0,
      defeated: false,
      heroPool: [],           // retired heroes (fled/surrendered/defeated) awaiting re-hire
      obeliskIds: [],         // distinct obelisks this player has uncovered (the Grail puzzle)
      keys: [],               // colored keys collected from Keymaster Tents (open matching Border Guards)
      // Upgrade nodes bought at a dwelling (src/data/upgradeNodes.js). Plain
      // string ids, so serialize's {...state} round-trips them with no migration
      // and no SAVE_VERSION bump; every reader takes `p.upgrades ?? []`, which is
      // the §2.2 escape that lets a save written before this field adopt it.
      upgrades: [],
      // Work crews per pool, above which hiring costs gold and daily upkeep.
      // Read as `?? CONFIG.JOBS.CREWS[pool]` everywhere, so a save written
      // before crews existed reads as the starting allotment (I12).
      crews: { ...CONFIG.JOBS.CREWS },
    });
  });

  // Map + towns + starting objects (mapgen registers towns via callbacks).
  // A small fraction of seeds (~0.2%) produce a layout whose connectivity carve
  // cannot link every object without breaching the mountain ridge; generateMap
  // throws rather than ship an unreachable objective (see MapGenerator). Retry
  // with a nudged mapgen seed instead of crashing New Game. Attempt 0 uses the
  // exact seed, so every already-working seed yields an identical map; only the
  // rare failing seeds fall through, and the outcome stays deterministic per seed.
  state.map = null;
  let mapErr = null;
  for (let attempt = 0; attempt < MAP_GEN_ATTEMPTS; attempt++) {
    state.towns = {};
    state.nextUid = 1; // a discarded layout's town ids don't leave gaps
    const mapRng = new Rng((seed + attempt * 0x1000193) | 0);
    try {
      state.map = generateMap({
        w: setup.mapW || 44,
        h: setup.mapH || 36,
        rng: mapRng,
        players: state.players,
        registerTown: (town) => {
          const id = uid(state, 'T');
          town.id = id;
          state.towns[id] = town;
          return id;
        },
        // state.features is set above, so the generator can read the opt-in.
        richLands: !!state.features.richLands,
        // Guards and garrisons are sized in POWER, and power is measured per
        // damage model (src/core/power.js).
        physicalDamage: !!state.features.physicalDamage,
      });
      mapErr = null;
      break;
    } catch (err) {
      mapErr = err; // connectivity carve failed for this layout — try the next
    }
  }
  if (mapErr) throw mapErr; // exhausted all attempts: surface the last failure

  // World homeostasis (the crawling peg + the population floor). ON unless the
  // setup turns it off — see pacing.neutralHomeostasis, and note that asking for
  // frozen wild stacks (wildGrowth: false) turns it off too, because that is one
  // intent and not two.
  if (setup.neutralPeg === false) state.neutralPeg = false;
  // The world's own population baseline: how many WANDERING bands this map
  // shipped with. The floor that keeps the mid-game from emptying out is a share
  // of this (see core/neutrals.wildFloor) rather than an absolute count, because
  // map size sets the population — a 72x60 map generates 47 wandering bands, a
  // large one twice that. Recorded here, before a single one has been cleared.
  state.wildBaseline = wildStacks(state).filter((w) => !w.guard).length;
  // …and what the median band among them was worth, which is the yardstick each
  // band's own weight is measured against (see neutrals.bandWeight). Recorded
  // now because it must be the value the GENERATOR chose, not one the peg has
  // since moved.
  state.wildBandValue0 = medianBandValue(state);
  // A SEPARATE draw stream for repopulating the world. Respawn positions and
  // stack rolls must not shift the gameplay stream, or turning homeostasis on
  // would change every combat roll, map event and wave size in a seed. Same
  // reason mapgen has always had its own stream.
  state.wildRng = new Rng((seed ^ 0x5bf03635) | 0);

  // Fog of war per player, one layer per map level.
  for (let i = 0; i < state.players.length; i++) {
    state.fog.push(createFog(state.map.w, state.map.h));
    state.fogUnder.push(createFog(state.map.w, state.map.h));
  }

  // Starting hero for each player, next to their first town
  for (const player of state.players) {
    const town = playerTowns(state, player.index)[0];
    if (!town) continue; // defensive: every player is seeded a town by the generator
    const rosterId = firstHeroFor(state, player.faction);
    const hero = createHero(state, rosterId, player.index, town.x, town.y + 1);
    hero.inTownId = null;
    revealAround(state, player.index, hero.x, hero.y, 6);
    revealAround(state, player.index, town.x, town.y, 6);
  }

  // Objectives that name a concrete map entity need one chosen + flagged now;
  // if none is available (a tiny map with no artifacts, say) fall back to
  // conquest rather than ship an unwinnable game.
  if (state.victory.kind === 'captureTown') {
    // Prefer a neutral hold to race for, else an enemy start town.
    const target = pickTargetTown(state);
    if (target) { target.objective = true; state.victory.targetTownId = target.id; }
    else state.victory.kind = 'conquest';
  } else if (state.victory.kind === 'acquireArtifact') {
    const target = pickTargetArtifact(state);
    if (target) { target.objective = true; state.victory.targetArtifact = target.artifact; }
    else state.victory.kind = 'conquest';
  } else if (state.victory.kind === 'defeatHero') {
    const target = pickTargetHero(state);
    if (target) { target.objective = true; state.victory.targetHeroId = target.id; }
    else state.victory.kind = 'conquest';
  } else if (state.victory.kind === 'holdTowns') {
    // Counted from the map that was actually generated, not from the size that was
    // asked for: the objective is "every town here, and this many more from the
    // sea", and only the finished map knows the first half.
    state.victory.townTarget ||= holdTownsTarget(Object.keys(state.towns).length);
  }

  logMsg(state, 'A new conquest begins. Day 1 of Week 1.');
  return state;
}

/**
 * The town target for a `holdTowns` game: every town on the map, plus a share
 * that can only come from the sea.
 *
 * Two anchors and a straight line between them, and both anchors are the numbers
 * the request named: the smallest map seats 3 towns and asks for 5 more, the
 * biggest seats 22 and asks for 20. A map bigger than any we ship extrapolates up
 * the same line; nothing clamps at the top, because a map with more land has more
 * border for camps to land on. See CONFIG.HOLD_TOWNS_* for the measured ladder.
 */
export function holdTownsTarget(mapTowns) {
  const lo = CONFIG.HOLD_TOWNS_ANCHOR_LOW, hi = CONFIG.HOLD_TOWNS_ANCHOR_HIGH;
  const bLo = CONFIG.HOLD_TOWNS_BONUS_MIN, bHi = CONFIG.HOLD_TOWNS_BONUS_MAX;
  const n = Math.max(0, mapTowns | 0);
  const slope = hi > lo ? (bHi - bLo) / (hi - lo) : 0;
  const bonus = Math.max(bLo, Math.round(bLo + (n - lo) * slope));
  return Math.max(CONFIG.HOLD_TOWNS_MIN, n + bonus);
}

/**
 * Sanitise a setup.victory descriptor into the stored `state.victory`. The
 * Grail race stays its own flag; the new objectives ride a `kind` with bounded
 * parameters (so a hand-typed/loaded value can't produce an unwinnable game).
 */
function normalizeVictory(v = {}) {
  const out = { grail: !!v.grail };
  if (v.kind === 'captureTown') { out.kind = 'captureTown'; if (v.enemyTown) out.enemyTown = true; }
  else if (v.kind === 'surviveN') { out.kind = 'surviveN'; out.surviveDays = Math.max(7, (v.surviveDays | 0) || 100); }
  else if (v.kind === 'accumulateGold') { out.kind = 'accumulateGold'; out.goldTarget = Math.max(1000, (v.goldTarget | 0) || 50000); }
  else if (v.kind === 'acquireArtifact') out.kind = 'acquireArtifact';
  else if (v.kind === 'defeatHero') out.kind = 'defeatHero';
  else if (v.kind === 'repelInvasions') {
    // Hold the coast N times. Bounded like every other target so a hand-typed or
    // loaded value can't produce an unwinnable game; the Pax installs the same
    // kind on its own when every rival swears (see actions.enterPax).
    out.kind = 'repelInvasions';
    out.invasionTarget = Math.max(1, (v.invasionTarget | 0) || CONFIG.PAX_INVASION_TARGET);
  } else if (v.kind === 'invaderBattles') {
    // The long watch: an age measured in BATTLES against the invaders rather than
    // in waves thrown back (actions.noteInvaderBattle says why the unit matters).
    // Bounded like every other target, and generously — the point of this ending is
    // that it can be asked to be long.
    out.kind = 'invaderBattles';
    out.battleTarget = Math.max(1, (v.battleTarget | 0) || CONFIG.PAX_BATTLE_TARGET);
  } else if (v.kind === 'holdTowns') {
    // Rule the realm: hold this many towns at once. The target is normally left
    // for newGame to derive from the map that was actually generated (see
    // holdTownsTarget), because "42" is only the right number for a map that
    // seats 22 of its own; an explicit one is honoured and bounded.
    out.kind = 'holdTowns';
    if (v.townTarget) out.townTarget = Math.max(CONFIG.HOLD_TOWNS_MIN, v.townTarget | 0);
  } else if (v.kind === 'flagMines') {
    out.kind = 'flagMines';
    // Optional filter: flag every mine of ONE type (e.g. all gold mines). A bad
    // or absent mineType means "every mine on the map".
    if (typeof v.mineType === 'string') out.mineType = v.mineType;
  }
  // The AGE FLOOR (core/ages.js) rides alongside, not inside, the objective: it
  // never changes what wins, only how grown the realm must be before a win may
  // settle. An unknown id reads as 'swift' — no floor — so a hand-typed or older
  // save is exactly the game it was.
  if (typeof v.ageFloor === 'string' && CONFIG.AGE_FLOORS?.[v.ageFloor] && v.ageFloor !== 'swift') {
    out.ageFloor = v.ageFloor;
  }
  // The crown taken early (actions.claimVictoryNow) waives EVERY hold — the age
  // floor and the charge the sea decides alike — because it is one decision by the
  // player, not a per-condition one. `ageFloorWaived` is the name the first build
  // of this wrote; read it, so a save from that build still knows.
  if (v.crownWaived || v.ageFloorWaived) out.crownWaived = true;
  return out;
}

/** Choose the town a captureTown objective targets. By default a neutral hold is
 *  preferred (a race to plant your flag first); an ENEMY start town is the
 *  fallback. A scenario can flip that with `victory.enemyTown` — then an enemy
 *  fortress is the prize (a garrisoned siege, not a footrace), and a neutral is
 *  only the fallback. Either way the target is never one the human's team owns,
 *  and among the candidates the FARTHEST from the human's home is taken, so the
 *  objective is a genuine march away (mirroring pickTargetArtifact) rather than a
 *  town the opening move can seize — a captured-on-day-1 objective is no campaign
 *  at all. Deterministic (no rng draw). Surface only. */
function pickTargetTown(state) {
  const humanIdx = state.players.findIndex((p) => p.isHuman);
  const humanTeam = state.players[humanIdx]?.team ?? 0;
  const teamOf = (owner) => (owner >= 0 ? (state.players[owner]?.team ?? owner) : -1);
  const towns = Object.values(state.towns).filter((t) => (t.z ?? 0) === 0);
  const home = playerTowns(state, humanIdx)[0];
  const farthest = (pool) => {
    if (!pool.length || !home) return pool[0] || null;
    let best = pool[0], bestD = -1;
    for (const t of pool) {
      const d = Math.hypot(t.x - home.x, t.y - home.y);
      if (d > bestD) { bestD = d; best = t; }
    }
    return best;
  };
  const neutral = towns.filter((t) => t.owner < 0);
  const enemy = towns.filter((t) => t.owner >= 0 && teamOf(t.owner) !== humanTeam);
  const order = state.victory?.enemyTown ? [enemy, neutral] : [neutral, enemy];
  for (const pool of order) if (pool.length) return farthest(pool);
  return null;
}

/** All map artifact objects across both levels, each tagged with its level `z`
 *  (map objects don't carry a z field themselves). Returns [{ o, z }]. */
function allArtifactObjects(state) {
  const out = [];
  for (const [lvl, z] of [[state.map, 0], [state.map.underground, 1]]) {
    if (!lvl?.objects) continue;
    for (const o of Object.values(lvl.objects)) if (o.type === 'artifact' && o.artifact) out.push({ o, z });
  }
  return out;
}

/** Choose the artifact an acquireArtifact objective targets: the FARTHEST placed
 *  artifact on the human's home level (a real overland quest, reachable on foot),
 *  falling back to the other level only if the home level seats none.
 *  Deterministic (no rng draw). Null if the map seats no artifacts at all. */
function pickTargetArtifact(state) {
  const arts = allArtifactObjects(state);
  if (!arts.length) return null;
  const humanIdx = state.players.findIndex((p) => p.isHuman);
  const home = playerTowns(state, humanIdx)[0];
  if (!home) return arts[0].o;
  const homeZ = home.z ?? 0;
  const sameLevel = arts.filter((a) => a.z === homeZ);
  const pool = sameLevel.length ? sameLevel : arts;
  let best = pool[0], bestD = -1;
  for (const a of pool) {
    const d = Math.hypot(a.o.x - home.x, a.o.y - home.y);
    if (d > bestD) { bestD = d; best = a; }
  }
  return best.o;
}

/** Choose the hero a defeatHero objective targets: an enemy champion (a hero on
 *  a team other than the human's). The starting hero exists at gen. Null if the
 *  human somehow faces no enemy hero. */
function pickTargetHero(state) {
  const humanTeam = state.players.find((p) => p.isHuman)?.team ?? 0;
  return Object.values(state.heroes).find(
    (h) => (state.players[h.owner]?.team ?? h.owner) !== humanTeam,
  ) || null;
}

function firstHeroFor(state, factionId) {
  const taken = new Set(Object.values(state.heroes).map((h) => h.rosterId));
  return Object.keys(HERO_ROSTER).find(
    (id) => HERO_ROSTER[id].faction === factionId && !taken.has(id),
  );
}

/** Instantiate a roster hero for a player at (x, y). */
export function createHero(state, rosterId, owner, x, y) {
  const def = HERO_ROSTER[rosterId];
  const cls = HERO_CLASSES[def.class];
  const hero = {
    id: uid(state, 'H'),
    rosterId,
    name: def.name,
    className: cls.name,
    class: def.class,
    faction: def.faction,
    portrait: def.portrait,
    owner,
    x, y,
    z: 0,                  // map level: 0 = surface, 1 = underground
    level: 1,              // EXPERIENCE level (not the map level — that is z)
    xp: 0,
    stats: { ...cls.start },
    skills: { ...def.skills },
    spells: [...def.spells],
    specialty: def.specialty || null, // permanent hero perk (see heroes.specialtyText)
    mana: 0,
    mp: 0,
    army: [null, null, null, null, null, null, null],
    equipment: {},
    backpack: [],
    warMachines: {},       // Blacksmith purchases: { ballista|firstAidTent|ammoCart: true }
    visited: {},           // one-shot map boosters already used, by object id
    boostDays: {},         // daily-reusable boosters: object id -> day last used
    weeklyMoveBonus: 0,    // stables etc., cleared on new week
    tempMorale: 0,         // fountain-type blessings, cleared after combat
    tempLuck: 0,
    inTownId: null,
    onBoat: false,         // aboard a boat → moves over water, not land
  };
  rollStartingArmy(state, hero);
  hero.mana = heroMaxMana(hero);
  hero.mp = heroMaxMovement(hero);
  state.heroes[hero.id] = hero;
  return hero;
}

/**
 * Roll a hero's roster starting army into its empty slots. Used by createHero
 * and when re-hiring a pooled hero that lost its army (flee / defeat).
 */
export function rollStartingArmy(state, hero) {
  for (const [creatureId, min, max] of HERO_ROSTER[hero.rosterId].army) {
    const count = state.rng.int(min, max);
    const slot = hero.army.findIndex((s) => !s);
    if (slot >= 0) hero.army[slot] = { creature: creatureId, count, hurt: 0 };
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function currentPlayer(state) {
  return state.players[state.currentPlayer];
}

export function playerHeroes(state, playerIndex) {
  return Object.values(state.heroes).filter((h) => h.owner === playerIndex);
}

/**
 * Which banner colour slot a player flies (see factions.BANNER_COLORS).
 *
 * Local players fly their own index, so an ordinary game is unchanged. An invader
 * realm carries an explicit slot past the local four, because indexing by player
 * index would hand the first invader in a two-player game the third LOCAL colour.
 */
export function bannerSlot(state, playerIndex) {
  if (playerIndex < 0) return 0;
  const p = state.players?.[playerIndex];
  return Number.isInteger(p?.bannerSlot) ? p.bannerSlot : playerIndex;
}

export function playerTowns(state, playerIndex) {
  return Object.values(state.towns).filter((t) => t.owner === playerIndex);
}

/**
 * Do two owners share a team? Neutral (-1) is on nobody's team. A player is
 * always on their own team, so this reads false for identical owners' callers
 * that want strictly-allied — check `a !== b` first if you need that.
 */
export function sameTeam(state, a, b) {
  if (a < 0 || b < 0) return false;
  const ta = state.players[a]?.team ?? a;
  const tb = state.players[b]?.team ?? b;
  return ta === tb;
}

export function weekOf(day) {
  return Math.floor((day - 1) / CONFIG.DAYS_PER_WEEK) + 1;
}

export function dayOfWeek(day) {
  return ((day - 1) % CONFIG.DAYS_PER_WEEK) + 1;
}

/**
 * The map layer for one level: 0 = surface (state.map itself), 1 = the
 * underground (state.map.underground, sharing the surface's w/h). Both expose
 * { w, h, tiles, objects, nextOid }. Returns null for a level that does not
 * exist (e.g. a migrated single-level save).
 */
export function levelMap(state, level = 0) {
  return (level ? state.map.underground : state.map) || null;
}

/** The object dictionary for one level (empty when the level is absent). */
export function levelObjects(state, level = 0) {
  return levelMap(state, level)?.objects || {};
}

// Derived indices over a level's object dictionary, keyed by the dictionary
// itself so nothing here is ever serialized and a reloaded save starts empty.
const OBJECT_INDEX = new WeakMap();

/**
 * Every object on `level` satisfying `test`, cached until that level's object
 * dictionary changes.
 *
 * The AI's goal scan asks the same standing questions — "where are the invader
 * war-bands", "how many obelisks does this map carry" — once per candidate, and
 * each answer used to walk the whole dictionary. On a 144×120 map (~1,400
 * surface objects) a single hero's scan spent ten million iterations rebuilding
 * lists that had not changed, which was most of the two seconds a player waited
 * between ordering a march and seeing it start.
 *
 * Validity is exact and asks no discipline of the code that mutates the map:
 *   · an object ADDED always mints its id from the level's `nextOid`, so the
 *     stamp moves and the entry is rebuilt;
 *   · an object REMOVED breaks the identity check below, which costs O(hits)
 *     rather than O(map) — and in most games the band list is empty;
 *   · a loaded save brings a fresh dictionary, so there is no entry to go stale.
 *
 * `test` must therefore read only fields that are fixed at creation (an
 * object's `type`, an invader band's `invader` flag). A predicate over mutable
 * state — `looted`, `owner` — would be cached past the change that matters.
 */
export function objectsWhere(state, level, key, test) {
  const m = levelMap(state, level);
  if (!m) return [];
  const objects = m.objects || {};
  const stamp = m.nextOid ?? 0;
  let entry = OBJECT_INDEX.get(objects);
  if (!entry) { entry = new Map(); OBJECT_INDEX.set(objects, entry); }
  const hit = entry.get(key);
  if (hit && hit.stamp === stamp && hit.list.every((o) => objects[o.id] === o)) return hit.list;
  const list = [];
  for (const id in objects) {
    const o = objects[id];
    if (o && test(o)) list.push(o);
  }
  entry.set(key, { stamp, list });
  return list;
}

/**
 * Look an object up by id regardless of level. Ids are unique across the whole
 * world (surface objects are 'O…', underground 'U…'), so this is unambiguous.
 */
export function getObject(state, id) {
  return state.map.objects[id] || state.map.underground?.objects?.[id] || null;
}

export function tileAt(state, x, y, level = 0) {
  if (x < 0 || y < 0 || x >= state.map.w || y >= state.map.h) return null;
  const m = levelMap(state, level);
  return m ? m.tiles[y * state.map.w + x] : null;
}

export function objectAt(state, x, y, level = 0) {
  const t = tileAt(state, x, y, level);
  if (!t || !t.objectId) return null;
  return levelObjects(state, level)[t.objectId] || null;
}

// Walked with `for…in` rather than Object.values().find(): A* asks "is anyone
// standing here" for every tile it touches and the AI's scan asks tens of
// thousands of times per hero, and each of those calls used to allocate a fresh
// array of every hero in the world before looking at one of them. Iteration
// order over string keys is insertion order either way, so the hero returned
// when two somehow share a tile is the same one as before.
export function heroAt(state, x, y, level = 0) {
  const heroes = state.heroes;
  for (const id in heroes) {
    const h = heroes[id];
    if (h.x === x && h.y === y && (h.z ?? 0) === level) return h;
  }
  return null;
}

export function townAt(state, x, y, level = 0) {
  return Object.values(state.towns).find(
    (t) => t.x === x && t.y === y && (t.z ?? 0) === level,
  ) || null;
}

/** Does this player hold the given colored key (from a Keymaster Tent)? Used to
 *  decide whether a matching Border Guard lets them pass. */
export function playerHasKey(state, playerIndex, color) {
  return playerIndex >= 0 && !!state.players?.[playerIndex]?.keys?.includes(color);
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export function canAfford(player, cost) {
  return RESOURCES.every((r) => (player.resources[r] || 0) >= (cost[r] || 0));
}

export function pay(player, cost) {
  for (const r of RESOURCES) {
    if (cost[r]) player.resources[r] -= cost[r];
  }
}

export function grant(player, gain) {
  for (const r of RESOURCES) {
    if (gain[r]) player.resources[r] = (player.resources[r] || 0) + gain[r];
  }
}

/**
 * Features that are ON unless a game says otherwise.
 *
 * The default for a features key is OFF — absent means Classic, which is what
 * keeps old saves and the headless engine reading as the game they were written
 * against. A key listed here inverts that: absent means ON.
 *
 * The list exists so the SHIPPED default and the ENGINE default cannot drift
 * apart. Flipping only the Settings toggle would give menu-started games one
 * ruleset and every headless game — the balance probes, the AI benchmarks, any
 * programmatic `newGame` — another, so a measurement would quietly describe a
 * game nobody plays. An explicit `false` still wins: turning the toggle off in
 * Settings writes the key through gameFeatureFlags and it is honoured.
 *
 * Turning one on is not retroactive. `siteRespawn` only reloads sites that were
 * stamped when they were emptied, so an in-progress save picks the rule up from
 * the next site it clears rather than resurrecting everything already looted.
 */
export const DEFAULT_ON_FEATURES = new Set(['siteRespawn']);

/** True when an optional rule-engine feature is toggled on for this game. */
export function featureOn(state, key) {
  const explicit = state && state.features ? state.features[key] : undefined;
  if (explicit === undefined) return DEFAULT_ON_FEATURES.has(key);
  return !!explicit;
}

/**
 * Turn an optional rule on for the GAME ALREADY IN PROGRESS.
 *
 * WHY THIS HAS TO EXIST. A game snapshots its feature flags at New Game
 * (gameFeatureFlags → newGame) and they round-trip the save, so the Settings
 * screen governs the NEXT game and not this one. That is the right default —
 * rules should not change under a running campaign because a menu was touched —
 * but it left one real dead end: the Physical Damage Model is off by default,
 * every upgrade node in the game is a patch against it, and a player who wanted
 * the improvement tree had no way to reach it except to abandon the campaign
 * they were in. The Town screen offered them a panel of nodes and a line telling
 * them to go and change a setting that could not affect the game they were
 * looking at.
 *
 * NOT RETROACTIVE, and the same caveat DEFAULT_ON_FEATURES carries: a rule
 * adopted on day 40 governs day 40 onward. `siteRespawn` reloads only sites
 * stamped after it; `physicalDamage` changes the next battle, not the last one.
 *
 * There was already one caller doing this by hand — the Pax objective writes
 * `invasions` on when it needs waves (core/actions) — so this is the second use
 * of a move the engine had already made, given a name and a validation.
 */
export function adoptFeature(state, key) {
  if (!state) return { ok: false, reason: 'no game' };
  if (typeof key !== 'string' || !key) return { ok: false, reason: 'no feature named' };
  if (featureOn(state, key)) return { ok: false, reason: 'already in force' };
  (state.features ||= {})[key] = true;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

export function logMsg(state, text) {
  state.log.push({ day: state.day, text });
  if (state.log.length > 200) state.log.shift();
}

// ---------------------------------------------------------------------------
// Serialization (save/load)
// ---------------------------------------------------------------------------

/** Current on-disk save format. Bump when a change needs a migration below. */
export const SAVE_VERSION = 4;

/**
 * Version-lift steps. MIGRATIONS[v] transforms a save from version v-1 to v.
 */
const MIGRATIONS = {
  // v2: the underground level. A v1 save predates it and loads as a
  // single-level game: no underground map, empty under-fog layers, and every
  // hero/town pinned to the surface (z = 0). Such a game simply has no
  // subterranean gates, so nothing can ever route to the missing level.
  2: (raw) => {
    if (raw.map && raw.map.underground === undefined) raw.map.underground = null;
    if (!Array.isArray(raw.fogUnder)) raw.fogUnder = (raw.players || []).map(() => []);
    for (const h of Object.values(raw.heroes || {})) h.z ??= 0;
    for (const t of Object.values(raw.towns || {})) t.z ??= 0;
    return raw;
  },
  // v3: the hero/town id counter moves into the save (state.nextUid) — it was
  // a module global, which broke same-seed determinism across games in one
  // process. Derived one past the highest H…/T… id (map objects run on their
  // OWN counter, map.nextOid — a different namespace).
  3: (raw) => {
    let maxId = 0;
    for (const id of [
      ...Object.keys(raw.heroes || {}),
      ...(raw.players || []).flatMap((p) => (p.heroPool || []).map((hh) => hh.id)),
      ...Object.keys(raw.towns || {}),
    ]) {
      const n = parseInt(String(id).slice(1), 10);
      if (!Number.isNaN(n) && n > maxId) maxId = n;
    }
    raw.nextUid = maxId + 1;
    return raw;
  },
  // v4: unstick `siteRespawn`. The feature shipped OFF and was turned ON two
  // days later, but a game snapshots its feature flags at New Game and a flag
  // written as `false` beats the engine default forever (featureOn). Every save
  // begun in that window therefore carries an explicit `siteRespawn: false` that
  // nothing could ever lift — the vaults in those games were never going to
  // reload, whatever the build or the Settings screen said afterwards.
  //
  // Only a `false` is cleared, and only on the way up from v3, so it lands once:
  // a player who turns the rule off from here on writes a v4 save and keeps it
  // off. `true` is left alone, as is a save that never named the key.
  4: (raw) => {
    if (raw.features && raw.features.siteRespawn === false) delete raw.features.siteRespawn;
    return raw;
  },
};

function migrate(raw) {
  let v = raw.version || 1;
  while (v < SAVE_VERSION) {
    const step = MIGRATIONS[v + 1];
    if (!step) throw new Error(`No migration path from save version ${v} to ${v + 1}`);
    raw = step(raw);
    v += 1;
    raw.version = v;
  }
  return raw;
}

/** Structural sanity check: the essential shape every version shares. */
function validateSave(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return ['not an object'];
  if (typeof raw.day !== 'number') problems.push('missing/invalid day');
  if (!Array.isArray(raw.players) || raw.players.length < 1) problems.push('missing players');
  if (!raw.heroes || typeof raw.heroes !== 'object') problems.push('missing heroes');
  if (!raw.towns || typeof raw.towns !== 'object') problems.push('missing towns');
  if (!raw.map || !Array.isArray(raw.map.tiles) || !raw.map.objects) problems.push('missing map');
  if (!Array.isArray(raw.fog)) problems.push('missing fog');
  if (!raw.rng || typeof raw.rng.seed !== 'number') problems.push('missing rng');
  // v2 additions (validated pre-migration, so only demanded of v2+ saves).
  if ((raw.version || 1) >= 2) {
    if (!Array.isArray(raw.fogUnder)) problems.push('missing fogUnder');
    if (raw.map && raw.map.underground
        && (!Array.isArray(raw.map.underground.tiles) || !raw.map.underground.objects)) {
      problems.push('invalid underground map');
    }
  }
  // v3 addition: the hero/town id counter lives in the save.
  if ((raw.version || 1) >= 3 && typeof raw.nextUid !== 'number') {
    problems.push('missing nextUid');
  }
  return problems;
}

export function serialize(state) {
  return JSON.stringify({
    ...state,
    version: SAVE_VERSION,
    // A fact about the SESSION, not about the world: `interactive` means a player is
    // at the keyboard and a battle screen can be opened for them (see
    // invasions.assaultIsPlayable). AdventureScene sets it on every create, so it is
    // never needed in a save — and persisting it would tell a headless loader to set
    // assaults aside for a player who is not there to fight them.
    interactive: undefined,
    // The AI flight recorder rides the save WINDOWED — the most recent
    // TELEMETRY_SAVE_BYTES of it, not the whole session ring. Unwindowed it was
    // measured at 92% of a long game's save and was the only part that grew
    // without bound (~15 MB raw by day 200, gzipped on the main thread at every
    // dawn); the world itself gzips to a flat ~111 KB. The import is safe here:
    // telemetry.js is a dependency-free plain-data module, so no cycle — and the
    // windowing lives THERE, beside the budget it enforces, not in this file.
    // A state with no `telemetry` key returns undefined and keeps no key, and a
    // window that already fits is passed through untouched, so saves that never
    // recorded (or never overflowed) are byte-identical to what this wrote
    // before the cap existed — no migration, no version bump.
    telemetry: telemetryForSave(state),
    rng: state.rng.toJSON(),
    // The world-repopulation stream, when this game has one (see wildStream).
    wildRng: state.wildRng ? state.wildRng.toJSON() : undefined,
    fog: state.fog.map((f) => Array.from(f)),
    fogUnder: (state.fogUnder || []).map((f) => Array.from(f)),
  });
}

export function deserialize(json) {
  const raw = JSON.parse(json);
  // Refuse a save written by a newer build — its shape may not be one we can
  // safely interpret (better a clean "can't load" than silent corruption).
  const version = raw.version || 1;
  if (version > SAVE_VERSION) {
    throw new Error(`Save version ${version} is newer than this build supports (${SAVE_VERSION}).`);
  }
  // Reject a partial/foreign blob that happens to be valid JSON.
  const problems = validateSave(raw);
  if (problems.length) throw new Error(`Corrupt or incompatible save: ${problems.join('; ')}`);

  const state = migrate(raw);
  state.rng = Rng.fromJSON(state.rng);
  // A save written before world repopulation existed simply has no stream; one
  // is minted from the seed on first use (see actions.wildStream), so an old
  // game adopts homeostasis at its next weekly dawn instead of staying frozen.
  if (state.wildRng) state.wildRng = Rng.fromJSON(state.wildRng);
  state.fog = state.fog.map((arr) => Uint8Array.from(arr));
  // Under-fog gets the same array↔Uint8Array treatment as the surface fog. A
  // migrated v1 save carries empty layers, which read as fully unexplored.
  state.fogUnder = (state.fogUnder || []).map((arr) => Uint8Array.from(arr));
  // Safety clamp: whatever the save (or a migration) says, the counter must
  // sit past every hero/town id actually present, so new ids can never collide
  // even with a hand-edited nextUid. (Map objects run on map.nextOid — a
  // separate namespace — so they are deliberately NOT scanned: folding their
  // ids in would move nextUid on load and break round-trip idempotency.)
  let maxId = 0;
  for (const id of [
    ...Object.keys(state.heroes),
    ...state.players.flatMap((p) => (p.heroPool || []).map((h) => h.id)), // retired heroes keep their ids
    ...Object.keys(state.towns),
  ]) {
    const n = parseInt(id.slice(1), 10);
    if (!Number.isNaN(n) && n > maxId) maxId = n;
  }
  state.nextUid = Math.max(state.nextUid || 1, maxId + 1);
  // Caravans are a late addition; an older save simply has none in transit.
  if (!Array.isArray(state.caravans)) state.caravans = [];
  // Same guard, same reason: a save written before jobs existed loads with none
  // rather than undefined, so no migration and no SAVE_VERSION bump (§2.2).
  if (!Array.isArray(state.jobs)) state.jobs = [];
  return state;
}

/** Fresh map-object id (mapgen owns the counter; it lives in the save). */
export function nextObjectId(state) {
  return `O${state.map.nextOid++}`;
}

/** Fresh id for heroes hired mid-game. */
export { uid };
