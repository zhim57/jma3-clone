/**
 * settings.js — Persistent user preferences (volumes, animation speed, …).
 *
 * A tiny observable key/value store backed by localStorage. Anything the player
 * can tune lives here so scenes read one source of truth and a settings screen
 * writes it. Pure and dependency-free; safe to import from the rule engine's
 * view layer or the audio module. Never throws (localStorage may be blocked).
 */

const KEY = 'jma3_settings_v1';

/** Defaults double as the schema — every tunable is listed here with its value. */
export const DEFAULT_SETTINGS = {
  masterVolume: 0.7, // 0..1
  musicVolume: 0.5,  // 0..1 (scaled by master)
  sfxVolume: 0.8,    // 0..1 (scaled by master)
  muted: false,
  // Hover/tooltip text scale. Reported from play: "generally the text on the hover
  // is very small, could be bigger". A fixed pixel size cannot suit every display,
  // so this is the player's knob rather than a guess. Clamped [0.8, 2.0].
  uiTextScale: 1.25,
  // Movement animation pace: multiplier on the base per-step duration.
  // 1 = normal, <1 = slower (more watchable), >1 = faster. Clamped [0.4, 2.5].
  animSpeed: 0.8,
  // Adventure-map camera zoom, persisted so it carries across games. Clamped
  // [0.3, 4] here (the scene enforces the tighter CONFIG.ZOOM_MIN/MAX).
  zoom: 1.0,
  // Strict asset mode (dev/QA): draw a loud "MISSING" placeholder instead of the
  // pretty procedural fallback wherever a generated sprite is absent, and audit
  // the gap at boot. Off by default — procedural stays the shipping floor.
  strictAssets: false,
  // Adventure-map corner vignette (the soft darkening at the screen edges). Some
  // prefer the flat, unobscured map — toggleable, on by default.
  vignette: true,
  // Count which controls get drawn and which get pressed, so the UI can be
  // simplified on evidence instead of taste (see game/uiTelemetry.js). LOCAL
  // ONLY — it writes to this browser's localStorage and nothing sends it
  // anywhere; exporting is a deliberate click on Settings > Advanced. On by
  // default because the whole point is the DENOMINATOR: a control nobody
  // presses is indistinguishable from one that does not exist unless the draw
  // is counted too, and a sample that only covers people who opted in tells you
  // about them rather than about the screen.
  uiTelemetry: true,
  // Watch your VASSALS march during the computer's turn. Off by default, and the
  // default is the point: a sworn realm is on your team and cannot attack you, so
  // its trail is the one part of an enemy turn carrying no information — you are
  // not deciding anything about it and you cannot be surprised by it. Reported
  // from play: "the vassals are no threat, I do not follow them". Enemies and
  // neutral rivals are unaffected and always animate; this is only about the
  // realms sworn to you.
  showVassalMoves: false,
  // AI stack-splitting: spread an AI army's strongest stack across empty slots at
  // deploy so a single Blind/Paralyze can't disable its whole force. ON by default
  // — it closes a real exploit (one mass-disable neutralising a 20M-strong army).
  aiStackSplit: true,
  // AI Battle Formations: the AI picks its OWN pre-battle stance from the odds —
  // all-in (max variance) as a clear underdog, hold (zero variance) as a clear
  // favorite, the classic press when contested — instead of always fighting at
  // 'press'. Read live at battle creation (like aiStackSplit). ON by default: the
  // stances are EV-neutral by construction and this measurably closes the "the AI
  // never plays the odds" gap (see CONFIG.AI_STANCE_*). Off ⇒ byte-identical
  // classic behavior.
  aiBattleFormations: true,
  // AI dusk economy: after its heroes finish marching, the AI's towns take a
  // second shopping trip so the DAY'S loot buys builds/recruits the same day
  // instead of idling overnight (measured: 9-17% of idle town-days were
  // "affordable by dusk"). Read live where the AI turn ends (like aiStackSplit).
  // ON by default: a pure intelligence fix — the AI gets no free resources.
  aiDuskEconomy: true,
  // AI front caravans: in peacetime, rear-town garrisons caravan toward the
  // AI's main hero (each hop strictly closer) instead of sitting home forever
  // (measured: 25-55% of the AI's army value sat parked in rear garrisons).
  // Threat-driven caravans and the never-strip-a-threatened-town rule are
  // unchanged. Read live in the AI's town pass.
  // OFF by default — MEASURED NET-NEGATIVE. A/B over 3 faction pairs x 8 seeds x
  // 45 days (army value per game, both AIs): baseline 32,555; dusk+capitol only
  // 34,792 (+6.9%); adding THIS on top 34,053 (+4.6%) — i.e. turning it on costs
  // ~2% army and a fraction of a town held (2.67 -> 2.63) versus leaving it off.
  // Town churn and eliminations were unchanged, so it is not the catastrophe an
  // early read suggested; it simply does not pay. The leak it targets is real
  // (25-55% of the AI's army parked in rear garrisons), so the code is kept and
  // toggleable for a better future attempt — routing to where the fighting will
  // BE rather than where the main hero is now.
  aiFrontCaravans: false,
  // AI capitol rush: the AI's build order pulls the Capitol (the catalog's
  // best gold-per-day return) up to right after its Castle prerequisite and
  // demotes the slow-payback Resource Silo (measured: the AI is income-bound
  // — 42-60% of its idle town-days are gold-blocked). Read live in buildBest.
  aiCapitolRush: true,
  // Pacing preset — 'classic' or 'tideOfWar' (the growing-world challenge system,
  // #7–#11). Persisted here (not chosen per-game in the menu); New Game and each
  // Campaign/Saga read it. Matches CONFIG.DEFAULT_PACING; the two tide knobs below
  // only bite under 'tideOfWar'.
  pacing: 'classic',
  // Do the wild stacks already on the map swell week by week? ON by default, and
  // deliberately NOT part of the pacing preset above — a preset is snapshotted into
  // state at New Game and can never be adopted by a game already running, which left
  // an in-progress save with a frozen, solved map. Read at New Game into
  // state.wildGrowth; a save with no such field reads as ON, so an existing game
  // picks it up at the next week's dawn. Off reproduces HoMM3-faithful static stacks.
  wildGrowth: true,
  // Are PvE fights (wild stacks, creature banks, Pandora guards) scaled UP to a
  // fraction of the attacking hero's army when they would otherwise be a walkover?
  // ON by default, and like wildGrowth deliberately NOT part of the pacing preset — a
  // preset cannot be adopted by a game already running. Read at New Game into
  // state.pveScaling; an absent field reads as ON, so an existing save gets it at its
  // very next fight. The MAGNITUDE is the Challenge slider below. Never scales down.
  pveScaling: true,
  // Tide of War challenge dial (#8), read as an OUTCOME: how much of your own army a
  // wild fight should COST you. The world's PvE defenders are sized by simulating the
  // fight until it bites that hard (actions.tideMultiplier), not by pricing it — the
  // old reading was "the fraction of your army value they are lifted to", which it hit
  // exactly while the fights it built still cost 0%. Read at New Game into
  // state.tideHardness. Clamped [0.5, 1.3] (see CONFIG.TIDE_HARDNESS_* and
  // CONFIG.TIDE_LOSS_MIN/MAX for the loss band the ends of the dial map onto).
  tideHardness: 0.85,
  // Siege arrow-tower damage multiplier (see CONFIG.SIEGE_TOWER_DAMAGE_*). Read
  // live when a battle is built, so tuning it applies to your very next siege —
  // no new game needed. Clamped [0.5, 6]; 1.0 = the raw creature stat.
  siegeTowerDamage: 2.5,
  // Tide of War divine-intervention level (#9): how often the gods bolster a
  // lopsided battle's underdog — 'off' | 'easy' | 'normal' | 'hard'. Only bites
  // under the preset; read at New Game into state.tideIntervention.
  tideIntervention: 'normal',
  // Divine-intervention POWER (#9): the ceiling on how big a fired gift can be —
  // the underdog is lifted to a RANDOM fraction of the foe up to this. 0.9 ≈ the
  // old ~90% cap; 1.0 = parity; up to 2.0 = 200% (an overwhelming rescue). Read
  // at New Game into state.tideInterventionPower. Clamped [0, 2].
  tideInterventionPower: 0.9,
  // Hero-strength weight (#): how much a commander's attack/defense + spell-power×
  // mana counts toward "force" in balance comparisons (divine intervention, …).
  // 1.0 = the full estimate; 0 = ignore heroes (armies only); up to 3.0. A slider
  // so a bad guess is never frozen in. Read at New Game into state.heroPowerWeight.
  heroPowerWeight: 1.0,
  // Study-break module (#10) — the load-bearing edutainment layer, off by
  // default and opt-in. Work length (minutes), the starting math level (the
  // "progression" knob), and the AI's share of your haul.
  // CLONE: every study-module setting is removed here. Upstream they configure a
  // Pomodoro "study break" that pays in-game resources for solved math problems or
  // a scored reading recall — an edutainment feature, off by default, and nothing
  // to do with what this tree is for.
  //
  // Two of them were launch URLs for private third-party apps. That is why this
  // scrub matters beyond weight: this tree is meant to be public, and those URLs
  // (together with some personal notes in parent-repo documentation that is not
  // carried here) were the only things in the source that could not be.

  // ---- Optional rule-engine features (each OFF by default so Classic play is
  // byte-identical). Boolean toggles surfaced in Settings; read at New Game into
  // state.features (see gameFeatureFlags + GameState.newGame) so the headless
  // engine and saves respect them. Add a key here + to GAME_FEATURE_KEYS + a
  // Settings toggle when a feature lands. ----
  balanceOfPower: false,   // #9 — rivals league against a runaway military leader
  cohesionRout: false,     // #11 — bloodied stacks waver then rout before annihilation
  cunningAI: false,        // #12 — human-facing combat AI mixes its near-best moves
  aiTownPortal: false,     // #13 — the AI recalls home to defend via Town Portal
  sunkCostSiege: false,    // #14 — the AI over-commits at a town where it took losses
  hallOfReflection: false, // #15 — a building to forget a hero skill for a fee
  learningMode: false,     // #19 — end-of-game "what you learned" concept debrief
  diplomacy: false,        // #16 — parley: buy off a weak neutral stack instead of fighting
  townBank: false,         // #17 — collateralized loans to rush a big-ticket building
  // Listed in GAME_FEATURE_KEYS and offered in the Settings screen, but never
  // given a default here — so setSetting() refused it (it rejects any key not in
  // this object) and the toggle could not be switched on by anyone. The engine
  // side of the feature works; nothing could ever ask for it.
  lizardGhosts: false,     // a slain lizard stack may leave a shade behind
  richLands: false,        // a husbandry economy: a full mine set per zone + weekly sites
  invasions: false,        // the waves of history: periodic foreign incursions
  lairBrood: false,        // a cleared dragon/behemoth lair keeps breeding, week by week
  siteRespawn: true,       // emptied banks/boxes/huts are reoccupied 4 weeks on, tide-sized (ON by default)
  physicalDamage: false,   // damage from mass, speed and armour instead of the attack ladder
  ronins: false,           // masterless captains walk the open country and side with whoever is attacked
  // CLONE-ONLY FLAG. Upstream, a cornered realm can swear vassalage to a stronger
  // one and the two then fight as ONE banner. Measured on this engine: in a plain
  // 2-player castle-vs-inferno AI-vs-AI game, the two realms merged onto one team
  // in 6 of 8 seeds by day 45 — so the default AI testbed was quietly measuring an
  // alliance rather than a contest. This clone exists to study AI play, so the
  // behaviour is kept but moved behind a flag that is OFF for the baseline.
  // Turn it ON to study the diplomacy arc itself. Gate lives in core/pacts.js
  // (wouldSeekTerms) so ai/AIPlayer.js stays byte-identical to upstream.
  vassalage: false,        // a cornered AI realm may swear to a stronger one
};

/**
 * The optional-feature toggles that get threaded into a new game's state.
 * gameFeatureFlags() snapshots them for the New Game / Campaign setup so the
 * headless engine reads a plain { key: bool } off state.features. Extend both
 * when a new toggle-gated feature ships.
 */
export const GAME_FEATURE_KEYS = ['balanceOfPower', 'cohesionRout', 'cunningAI', 'aiTownPortal', 'sunkCostSiege', 'hallOfReflection', 'diplomacy', 'townBank', 'lizardGhosts', 'richLands', 'invasions', 'lairBrood', 'siteRespawn', 'physicalDamage', 'ronins', 'vassalage'];

export function gameFeatureFlags() {
  return Object.fromEntries(GAME_FEATURE_KEYS.map((k) => [k, !!getSetting(k)]));
}

/**
 * WHEN a key is read — the field this store spent three incidents not having.
 *
 * The keys above have three different lifetimes and the Settings screen used to
 * render all three identically, which is the single cause behind every settings
 * failure in the ledger:
 *
 *   'device' — read continuously; presentation only. Takes effect as you drag it.
 *   'live'   — read by the RUNNING game every time it matters. Takes effect at
 *              the next battle / dusk / study break, in the game you are playing.
 *   'game'   — snapshotted into state at New Game and carried by the save. A
 *              change CANNOT reach the game in front of you.
 *
 * `siteRespawn` x3 was a 'game' rule persisted through a 'device' mechanism (a
 * default flipped after players' stores had frozen the old one). `lizardGhosts`
 * was offered on a screen that could not affect the game being played. And
 * applyLiveTuning() in SettingsScene exists because three 'game' magnitudes were
 * reasonably expected to be 'live'. None of that was visible in the data.
 *
 * Guarded in tests/settings-schema.test.js: every key declares exactly one scope,
 * every 'game' key is one the New Game path actually reads, and every 'live' key
 * has a reader outside the Settings screen.
 */
export const SETTING_SCOPES = {
  // ---- device: presentation, immediate ----
  masterVolume: 'device', musicVolume: 'device', sfxVolume: 'device', muted: 'device',
  uiTextScale: 'device', animSpeed: 'device', zoom: 'device', strictAssets: 'device',
  vignette: 'device', showVassalMoves: 'device', uiTelemetry: 'device',
  // ---- live: the running game re-reads these ----
  aiStackSplit: 'live', aiBattleFormations: 'live', aiDuskEconomy: 'live',
  aiFrontCaravans: 'live', aiCapitolRush: 'live', siegeTowerDamage: 'live',
  // ---- game: snapshotted at New Game ----
  pacing: 'game', wildGrowth: 'game', pveScaling: 'game', tideHardness: 'game',
  tideIntervention: 'game', tideInterventionPower: 'game', heroPowerWeight: 'game',
  balanceOfPower: 'game', cohesionRout: 'game', cunningAI: 'game', aiTownPortal: 'game',
  sunkCostSiege: 'game', hallOfReflection: 'game', diplomacy: 'game', townBank: 'game',
  lizardGhosts: 'game', richLands: 'game', invasions: 'game', lairBrood: 'game',
  siteRespawn: 'game', physicalDamage: 'game', ronins: 'game',
};

/**
 * The 'game' keys that are ALSO adopted by a running game.
 *
 * These three are genuinely two-scope: their birth value is snapshotted at New
 * Game (a save must replay the difficulty it was played at), and SettingsScene
 * pushes them back onto the live state when it closes, because they are pure
 * magnitude — turning on scaled fights mid-game and then being locked at
 * whatever floor the save was born with is a switch with no dial. The pacing
 * preset is deliberately NOT here: it changes what systems exist, not how hard
 * they bite.
 */
export const LIVE_TUNABLE = ['tideHardness', 'tideInterventionPower', 'heroPowerWeight'];

/**
 * The 'game'-scope keys that reach a new game as explicit setup PARAMETERS
 * rather than through state.features — CampaignScene reads each as
 * `data.X ?? getSetting('X')` and passes it to startNewGame.
 *
 * Together with GAME_FEATURE_KEYS this is the complete set of keys a New Game
 * consumes, which is what makes "every 'game'-scope key is actually read at
 * birth" a checkable statement rather than a claim.
 */
export const NEW_GAME_PARAM_KEYS = ['pacing', 'wildGrowth', 'pveScaling', 'tideHardness',
  'tideIntervention', 'tideInterventionPower', 'heroPowerWeight'];

/**
 * One player-facing sentence per key, sourced from the comments above — because
 * a comment is not runtime data, and "Sunk-Cost Siege" tells a player nothing.
 * The Settings screen shows these in a detail strip (readable on touch, unlike a
 * hover tooltip). Where a value was MEASURED, the number is the sentence: a
 * knob whose own A/B says it does not pay should say so on the screen.
 *
 * Guarded: every key the Settings screen offers has an entry here.
 */
export const SETTING_RATIONALE = {
  masterVolume: 'Overall loudness. Music and effects are scaled by this.',
  musicVolume: 'Background score, on top of the master level.',
  sfxVolume: 'Clicks, combat and coin sounds, on top of the master level.',
  muted: 'Silence everything without losing your volume levels.',
  uiTextScale: 'Size of hover text. A fixed size cannot suit every display — reported from play as "the text on the hover is very small".',
  animSpeed: 'How fast heroes march. Lower is more watchable, higher gets the turn over with.',
  vignette: 'The soft darkening at the map edges. Off gives a flat, unobscured map.',
  showVassalMoves: 'Watch your sworn realms march during the computer turn. Off by default: a vassal cannot attack you, so its trail carries no information.',
  strictAssets: 'Dev/QA: draw a loud MISSING placeholder wherever generated art is absent, instead of the procedural fallback. The ?strict URL flag does the same without saving it.',
  uiTelemetry: 'Count which buttons get drawn and which get pressed, so unused parts of the UI can be found and removed. Stays on this device — nothing is sent anywhere, and exporting it is a click you make.',
  pacing: 'Classic is the base game. Tide of War grows the world with you — the challenge knobs below only bite under it.',
  wildGrowth: 'Wild stacks already on the map swell week by week. Off reproduces HoMM3-faithful static stacks.',
  pveScaling: 'Wild fights, banks and Pandora guards are scaled UP toward your army when they would otherwise be a walkover. Never scales down.',
  tideHardness: 'Roughly how much of your army a wild fight should cost you. Defenders are sized by simulating the battle until it bites that hard. Off disables the scaling entirely.',
  tideIntervention: 'How often the gods bolster a lopsided battle\'s underdog.',
  tideInterventionPower: 'The ceiling on a divine gift: 90% ≈ near-parity, 200% an overwhelming rescue.',
  heroPowerWeight: 'How much a commander\'s own attack, defense and spell power count toward "force" in balance comparisons. 0 compares armies only.',
  siegeTowerDamage: 'Arrow-tower damage multiplier. 1.0 is the raw creature stat; read live, so it applies to your very next siege.',
  aiStackSplit: 'The AI spreads its strongest stack at deploy. ON closes a real exploit — one mass-disable neutralising a 20M-strong army.',
  aiBattleFormations: 'The AI picks its own pre-battle stance from the odds instead of always pressing. EV-neutral by construction.',
  aiDuskEconomy: 'The AI\'s towns shop again after its heroes march, so the day\'s loot buys the same day. A pure intelligence fix — no free resources.',
  aiFrontCaravans: 'Rear garrisons caravan toward the AI\'s main hero. MEASURED NET-NEGATIVE: costs ~2% army value, so it is off. Kept for a better future attempt.',
  aiCapitolRush: 'The AI builds its Capitol earlier. It is income-bound — 42-60% of its idle town-days are gold-blocked.',
  balanceOfPower: 'Rival realms league together against a runaway military leader — including you.',
  cohesionRout: 'Bloodied stacks waver and rout instead of fighting to the last figure.',
  cunningAI: 'The combat AI mixes its near-best moves, so it stops being predictable.',
  aiTownPortal: 'The AI recalls home to defend a threatened town.',
  sunkCostSiege: 'The AI over-commits at a town where it has already taken losses.',
  hallOfReflection: 'A building that lets a hero forget a skill for a fee.',
  diplomacy: 'Parley with a weak neutral stack and buy it off instead of fighting.',
  townBank: 'Collateralized loans, to rush a big-ticket building.',
  lizardGhosts: 'A slain lizard stack may leave a shade behind.',
  richLands: 'A husbandry economy: a full mine set per zone, plus weekly sites.',
  invasions: 'The waves of history — periodic foreign incursions on everyone.',
  lairBrood: 'A cleared dragon or behemoth lair keeps breeding, week by week.',
  siteRespawn: 'An emptied bank, box or hut is reoccupied 4 weeks on, tide-sized, rotating its tenant within its own tier.',
  physicalDamage: 'Damage from mass, speed and armour instead of the attack ladder.',
  ronins: 'Masterless captains walk the open country and join whichever side is attacked — including against you. A captain that survives can be hired out of any tavern, priced by the experience you watched it earn.',
};

/**
 * The keys whose current value differs from what this build ships.
 *
 * The whole `siteRespawn` archaeology — three incidents, a schema revision and a
 * save migration — happened inside a store nobody could look at. The Settings
 * screen marks these rows and counts them in its title, so "what have I changed"
 * is a glance rather than a forensic exercise.
 */
export function changedFromDefaults() {
  return Object.keys(DEFAULT_SETTINGS).filter((k) => current[k] !== DEFAULT_SETTINGS[k]);
}

/** Restore a key to this build's shipped default. */
export function resetSetting(key) {
  if (key in DEFAULT_SETTINGS) setSetting(key, DEFAULT_SETTINGS[key]);
}

const listeners = new Set();

/**
 * Settings whose SHIPPED default changed after they had already been written to
 * players' machines, keyed by the schema revision that changed them.
 *
 * The store persists the whole merged object, so the first time anybody touches
 * any preference, every default freezes into their localStorage. Flipping a
 * default in this file then reaches nobody who has ever opened the Settings
 * screen — which is how `siteRespawn` shipped off, was turned on two days later,
 * and stayed off for existing players: their stored `false` outranked the new
 * default forever, and their emptied vaults never reloaded.
 *
 * Each entry re-applies its key's CURRENT default once, when a store written
 * before that revision is read. A choice made after the migration is a real
 * choice and is kept, because the store is rewritten at revision `SCHEMA` the
 * moment anything is saved.
 */
const SCHEMA = 3;
const RESET_ON_UPGRADE = {
  2: ['siteRespawn'], // shipped false, then turned on by default
};

/**
 * Keys that were REPLACED rather than re-defaulted, keyed by the revision that
 * replaced them: a function that reads the stored object and carries the old
 * choice onto the new key.
 *
 * RESET_ON_UPGRADE could not do this. It restores a default, which is exactly
 * wrong when the value is a choice the player made under a different name —
 * dropping `adaptiveStudy: true` on the floor would silently move the one player
 * who had turned the in-app math ramp on to a provider they did not pick, and
 * "their stored value quietly stopped being honoured" is the failure the schema
 * revision exists to prevent, not one it may cause.
 */
const REWRITE_ON_UPGRADE = {
  // 3: adaptiveStudy (bool: in-app math vs the external app) -> studySource (3-way).
  3: (out, raw) => { if (raw.adaptiveStudy === true) out.studySource = 'local'; },
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    // Merge over defaults so a new tunable always has a value and stray keys
    // in an old save are ignored.
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof raw[k] === typeof DEFAULT_SETTINGS[k]) out[k] = raw[k];
    }
    // A store with no `schema` predates every revision below (revision 1).
    const was = Number.isInteger(raw.schema) ? raw.schema : 1;
    for (let v = was + 1; v <= SCHEMA; v++) {
      for (const k of RESET_ON_UPGRADE[v] || []) out[k] = DEFAULT_SETTINGS[k];
      REWRITE_ON_UPGRADE[v]?.(out, raw);
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let current = load();

function persist() {
  // Stamped with the schema revision, so a default flipped in a later build
  // reaches this player exactly once and never fights a deliberate choice.
  try { localStorage.setItem(KEY, JSON.stringify({ ...current, schema: SCHEMA })); } catch { /* storage blocked */ }
}

export function getSetting(key) {
  return current[key];
}

export function allSettings() {
  return { ...current };
}

/**
 * CLONE-ONLY: apply an in-memory settings patch for ONE experimental run.
 *
 * WHY THIS EXISTS. Six knobs that materially change how the AI plays —
 * aiStackSplit, aiBattleFormations, aiDuskEconomy, aiFrontCaravans, aiCapitolRush
 * and siegeTowerDamage — are read through getSetting() at call time, not off
 * `state`. They live in this module singleton, which means they do NOT serialize
 * into a save and are NOT part of the seed. Upstream that is fine, because a
 * player sets them once in a menu. Here it is a measurement bug: (seed, save) does
 * not determine a run, so two runs of "the same" experiment can differ for a reason
 * nothing recorded.
 *
 * This is the seam that fixes it without moving the keys into GameState (which
 * would fork settings.js and GameState.js — two files every scene reads). The
 * batch runner calls this before each run and records the returned snapshot
 * alongside the result, so every row in an output file carries the exact
 * configuration that produced it.
 *
 * Differences from setSetting(), all deliberate:
 *   - does NOT persist (never touches localStorage — a sim must not rewrite the
 *     player's preferences),
 *   - does NOT notify listeners (no UI is watching in a headless run),
 *   - does NOT clamp (an experiment may want a value outside the UI's range).
 * Unknown keys are ignored, exactly like setSetting.
 *
 * Returns the full effective settings snapshot AFTER the patch — record it.
 */
export function applyRunConfig(patch = {}) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) current[k] = v;
  }
  return { ...current };
}

/** CLONE-ONLY: drop back to the stored defaults. Call between unrelated batches. */
export function resetRunConfig() {
  current = load();
  return { ...current };
}

/** Set a value (clamped for the numeric ones), persist, and notify listeners. */
export function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) return;
  if (typeof DEFAULT_SETTINGS[key] === 'number') {
    value = Number(value);
    if (!Number.isFinite(value)) return;
    if (key === 'animSpeed') value = Math.max(0.4, Math.min(2.5, value));
    else if (key === 'uiTextScale') value = Math.max(0.8, Math.min(2.0, value));
    else if (key === 'zoom') value = Math.max(0.3, Math.min(4, value));
    else if (key === 'tideHardness') value = Math.max(0.5, Math.min(1.3, value)); // CONFIG.TIDE_HARDNESS_MIN/MAX
    else if (key === 'siegeTowerDamage') value = Math.max(0.5, Math.min(6, value)); // CONFIG.SIEGE_TOWER_DAMAGE_MIN/MAX
    else if (key === 'tideInterventionPower') value = Math.max(0, Math.min(2, value)); // CONFIG.TIDE_INTERVENTION_POWER_MIN/MAX
    else if (key === 'heroPowerWeight') value = Math.max(0, Math.min(3, value)); // CONFIG.HERO_POWER_WEIGHT_MIN/MAX
    else value = Math.max(0, Math.min(1, value)); // volumes + studyAiShare are 0..1
  }
  if (current[key] === value) return;
  current[key] = value;
  persist();
  for (const fn of [...listeners]) fn(key, value);
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Effective duration for a `base`-ms animation, scaled by the movement pace.
 * A slower animSpeed lengthens it; never returns less than a visible minimum.
 */
export function scaledDuration(baseMs) {
  return Math.max(24, Math.round(baseMs / getSetting('animSpeed')));
}
