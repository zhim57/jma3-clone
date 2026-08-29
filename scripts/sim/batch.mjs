/**
 * batch.mjs — run N seeded AI-vs-AI games and write one record per game.
 *
 * THIS IS THE INSTRUMENT THIS CLONE EXISTS FOR. Everything else here is the game
 * it measures. If you change AI logic, this is how you find out whether it helped.
 *
 * The parent repo has four separate headless drivers (aiperf, goal-audit,
 * sim-campaign, tests/ai-slicing) and each re-implements the same eight-line pump
 * ad hoc, so there was no way to say "play these 40 seeds under configuration A,
 * then under B, and diff them". That is all this does.
 *
 * WHAT MAKES A RUN REPRODUCIBLE
 * -----------------------------
 * Two things determine a game, and BOTH are recorded on every row:
 *   1. `seed` — the map, and the gameplay rng stream. core/rng.js is mulberry32
 *      with separate mapgen / gameplay / repopulation streams and no Math.random
 *      anywhere in core, ai, map or data, so a seed replays exactly.
 *   2. the CONFIGURATION — and this splits in two, which is the trap:
 *      • `features` (state.features) is game-scoped and lives IN the save;
 *      • six AI knobs (aiStackSplit, aiBattleFormations, aiDuskEconomy,
 *        aiFrontCaravans, aiCapitolRush, siegeTowerDamage) are read through
 *        getSetting() out of a module singleton and are NOT in the save.
 *      The second group is why `settings.applyRunConfig()` exists: it is set here,
 *      per run, and the resulting snapshot is written into the output. A row you
 *      can replay is a row that carries both halves.
 *
 * BASELINE, AND WHY IT IS NOT "THE DEFAULTS"
 * -----------------------------------------
 * Several AI behaviours ship OFF upstream (cunningAI, aiTownPortal, sunkCostSiege,
 * balanceOfPower, diplomacy), so running at bare defaults measures a partially
 * disabled AI. BASELINE_FEATURES below states an explicit, frozen starting point
 * instead of inheriting whatever the defaults happen to be — pick yours, write it
 * down, and change it deliberately. `vassalage` is off for the reason in
 * core/pacts.js: with it on, two AI realms merge onto one team in most seeds and
 * the run stops being a contest.
 *
 * USAGE
 *   node scripts/sim/batch.mjs                          # 10 seeds, 60 days, 44x38
 *   node scripts/sim/batch.mjs --runs 40 --days 120     # a real sample
 *   node scripts/sim/batch.mjs --w 88 --h 72            # the big map
 *   node scripts/sim/batch.mjs --set cunningAI=true     # flip a game feature
 *   node scripts/sim/batch.mjs --set aiCapitolRush=false --json out/a.json
 *   node scripts/sim/batch.mjs --csv out/a.csv --quiet
 *
 * A/B in two commands, which is the point:
 *   node scripts/sim/batch.mjs --runs 40 --json out/base.json
 *   node scripts/sim/batch.mjs --runs 40 --set cunningAI=true --json out/cunning.json
 * Same seeds both times (they are 1..N unless you pass --seed0), so the pairs are
 * directly comparable.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG } from '../../src/config.js';
import { newGame, currentPlayer, playerTowns } from '../../src/core/GameState.js';
import { endTurn } from '../../src/core/actions.js';
import { AITurnController } from '../../src/ai/AIPlayer.js';
import { armyPower } from '../../src/core/power.js';
import { applyRunConfig } from '../../src/game/settings.js';

// ---- the frozen baseline -----------------------------------------------------
// Explicit on purpose: every key this clone can toggle, with the value the
// baseline uses. Change one HERE to move the baseline for every future run;
// change one with --set to make a single experiment.
const BASELINE_FEATURES = {
  // AI behaviours — off upstream, so "defaults" would understate the AI.
  cunningAI: false,        // combat AI mixes its near-best moves instead of always taking the best
  aiTownPortal: false,     // the AI recalls home to defend a threatened town
  sunkCostSiege: false,    // the AI over-commits where it has already taken losses
  balanceOfPower: false,   // rivals league against a runaway military leader
  diplomacy: false,        // parley: buy off a weak neutral stack instead of fighting it
  // Kept off so a two-realm game stays a war — see core/pacts.js.
  vassalage: false,
  // World rules. physicalDamage swaps the whole damage model; leave it off unless
  // that IS the experiment, or results stop comparing to anything.
  physicalDamage: false,
  invasions: false,        // inert in this clone anyway (core/invasions.js is a stub)
  ronins: false,           // likewise (core/ronins.js is a stub)
  cohesionRout: false,
  townBank: false,
  lairBrood: false,
  richLands: false,
  lizardGhosts: false,
  hallOfReflection: false,
  siteRespawn: true,       // ON upstream by default; kept, so cleared sites refill
};

// The live (non-serialized) AI knobs. Stated explicitly for the same reason.
const BASELINE_RUN_CONFIG = {
  aiStackSplit: true,
  aiBattleFormations: true,
  aiDuskEconomy: true,
  aiFrontCaravans: true,
  aiCapitolRush: true,
};

// ---- argv --------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    runs: 10, days: 60, w: 44, h: 38, seed0: 1,
    factions: ['castle', 'inferno'], json: null, csv: null, quiet: false,
    set: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--runs') o.runs = Number(next());
    else if (a === '--days') o.days = Number(next());
    else if (a === '--w') o.w = Number(next());
    else if (a === '--h') o.h = Number(next());
    else if (a === '--seed0') o.seed0 = Number(next());
    else if (a === '--factions') o.factions = next().split(',');
    else if (a === '--json') o.json = next();
    else if (a === '--csv') o.csv = next();
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--set') {
      const [k, v] = next().split('=');
      o.set[k] = v === undefined ? true : v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v);
    } else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

const HELP = `batch.mjs — N seeded AI-vs-AI games, one record each

  --runs N        games to play (default 10)
  --days N        stop a game after this many days (default 60)
  --w N --h N     map size (default 44x38)
  --seed0 N       first seed; seeds are seed0..seed0+runs-1 (default 1)
  --factions a,b  player factions (default castle,inferno)
  --set k=v       override a feature flag or AI knob; repeatable
  --json PATH     write the full records
  --csv PATH      write one row per game
  --quiet         suppress the per-game lines`;

// ---- one game ----------------------------------------------------------------
/**
 * Play one seeded AI-vs-AI game to a winner or to `days`, and return its record.
 *
 * The pump is the canonical one (see also scripts/sim/aiperf.mjs): build a
 * controller for the seat whose turn it is, call next() until it says 'done',
 * auto-resolve any battle it hands back, then endTurn. next() with no time budget
 * runs the whole turn in one call, which is what a headless caller wants.
 */
function playOne(seed, opts) {
  const state = newGame({
    seed,
    mapW: opts.w,
    mapH: opts.h,
    // BOTH SEATS AI, and isHuman stays FALSE on both. That flag is a RULES flag,
    // not a label: a seat marked human gets no warlord personality (every AI would
    // collapse to the neutral 'tactician' profile), takes the human starting pile,
    // and loses the AI income handicap. Marking these seats human to mean "an
    // ordinary player slot" would silently change the game being measured.
    players: opts.factions.map((faction, i) => ({ faction, isHuman: false, team: i })),
    features: { ...BASELINE_FEATURES, ...opts.set },
  });

  const t0 = performance.now();
  const metrics = { pathfinds: 0, goalPicks: 0, steps: 0, battles: 0 };
  let turns = 0;
  // endTurn advances ONE SEAT, not one day, and can decline to advance at all
  // (a defeated seat, a finished game) — so the loop needs a runaway backstop.
  let guard = opts.days * (state.players.length + 4) + 60;

  while (state.winner === null && state.day <= opts.days && guard-- > 0) {
    const pi = currentPlayer(state).index;
    const seat = state.players[pi];
    if (!seat.isHuman && !seat.defeated) {
      const ai = new AITurnController(state, pi);
      let r; let g = 200000;
      do {
        r = ai.next();
        if (r.type === 'combat') { ai.autoFight(r.context); metrics.battles += 1; }
      } while (r.type !== 'done' && g-- > 0);
      if (g <= 0) throw new Error(`seed ${seed}: AI turn never reached 'done'`);
      metrics.pathfinds += ai.metrics.pathfinds || 0;
      metrics.goalPicks += ai.metrics.goalPicks || 0;
      metrics.steps += ai.metrics.steps || 0;
      turns += 1;
    }
    endTurn(state);
  }

  // Per-seat end state. `army` is read in POWER (the currency the damage model
  // agrees with), not gold value — the same unit the AI's own courage gates use.
  const seats = state.players.map((p) => {
    const towns = playerTowns(state, p.index).length;
    const heroes = Object.values(state.heroes).filter((h) => h.owner === p.index && !h.dead);
    return {
      index: p.index,
      faction: p.faction,
      team: p.team ?? p.index,
      defeated: !!p.defeated,
      towns,
      heroes: heroes.length,
      army: Math.round(heroes.reduce((a, h) => a + armyPower(h.army, false), 0)),
      gold: p.resources?.gold ?? 0,
      level: Math.max(0, ...heroes.map((h) => h.level || 1)),
    };
  });

  // Did the realms end up on the same team WITHOUT one of them being conquered?
  // That is the vassalage regime, and with the flag off it should never happen —
  // it is recorded anyway, because it is exactly the kind of silent regime change
  // that made the upstream default testbed measure an alliance instead of a war.
  //
  // Note the `alive.length > 1` guard: an ordinary conquest also leaves one team
  // standing, so testing "one distinct team" alone reports every decisive game as
  // merged. Merged means two realms still holding, flying one banner.
  const alive = seats.filter((s) => !s.defeated);
  const merged = alive.length > 1 && new Set(alive.map((s) => s.team)).size === 1;

  return {
    seed,
    days: state.day,
    ms: Math.round(performance.now() - t0),
    winner: state.winner,                       // winning TEAM, or null if the day cap was hit
    decided: state.winner !== null,
    merged,
    turns,
    rngCalls: state.rng?.calls ?? null,          // a cheap divergence fingerprint
    metrics,
    seats,
  };
}

// ---- main --------------------------------------------------------------------
const opts = parseArgs(process.argv.slice(2));

// Apply the live AI knobs ONCE for the whole batch and keep the snapshot: these
// are process-global, so they cannot vary per run inside one process — which is
// precisely why they are recorded rather than assumed.
const runConfig = applyRunConfig({ ...BASELINE_RUN_CONFIG, ...opts.set });
const knobs = Object.fromEntries(
  Object.keys(BASELINE_RUN_CONFIG).map((k) => [k, runConfig[k]]),
);

const records = [];
for (let i = 0; i < opts.runs; i += 1) {
  const seed = opts.seed0 + i;
  const rec = playOne(seed, opts);
  records.push(rec);
  if (!opts.quiet) {
    const w = rec.winner === null ? 'undecided' : `team ${rec.winner}`;
    console.log(
      `  seed ${String(seed).padStart(4)}  day ${String(rec.days).padStart(3)}  `
      + `${w.padEnd(10)}  ${String(rec.turns).padStart(4)} turns  `
      + `${String(rec.ms).padStart(6)}ms  `
      + rec.seats.map((s) => `${s.faction[0].toUpperCase()}:${s.towns}t/${s.army}p`).join('  ')
      + (rec.merged ? '  [MERGED]' : ''),
    );
  }
}

// ---- summary -----------------------------------------------------------------
const decided = records.filter((r) => r.decided);
const wins = {};
for (const r of decided) wins[r.winner] = (wins[r.winner] || 0) + 1;
const med = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`\n${records.length} games · ${opts.w}x${opts.h} · day cap ${opts.days} · seeds ${opts.seed0}..${opts.seed0 + opts.runs - 1}`);
console.log(`  decided      ${decided.length}/${records.length}`
  + (decided.length ? `  (median day ${med(decided.map((r) => r.days))})` : ''));
for (const [team, n] of Object.entries(wins).sort()) {
  const f = records[0].seats.find((s) => String(s.team) === team)?.faction ?? '?';
  console.log(`  team ${team} (${f}) won  ${n}  (${Math.round((n / records.length) * 100)}%)`);
}
const mergedN = records.filter((r) => r.merged).length;
if (mergedN) console.log(`  MERGED onto one team  ${mergedN}/${records.length} — the run is not a contest; check the vassalage flag`);
console.log(`  median wall  ${med(records.map((r) => r.ms))}ms per game`
  + `   total ${(records.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)}s`);

// ---- output ------------------------------------------------------------------
const features = { ...BASELINE_FEATURES, ...opts.set };
const payload = {
  // Everything needed to reproduce this batch, in the file with its results.
  config: {
    runs: opts.runs, days: opts.days, w: opts.w, h: opts.h, seed0: opts.seed0,
    factions: opts.factions, features, knobs, aiSliceMs: CONFIG.AI_SLICE_MS,
  },
  records,
};

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`  wrote ${path}`);
}

if (opts.json) write(opts.json, `${JSON.stringify(payload, null, 2)}\n`);
if (opts.csv) {
  const head = 'seed,days,decided,winner,merged,turns,ms,rngCalls,'
    + records[0].seats.map((s) => `p${s.index}_towns,p${s.index}_army,p${s.index}_heroes,p${s.index}_defeated`).join(',');
  const rows = records.map((r) => [
    r.seed, r.days, r.decided, r.winner ?? '', r.merged, r.turns, r.ms, r.rngCalls,
    ...r.seats.flatMap((s) => [s.towns, s.army, s.heroes, s.defeated]),
  ].join(','));
  write(opts.csv, `${[head, ...rows].join('\n')}\n`);
}
