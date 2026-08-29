/**
 * goal-audit.mjs — does the adventure AI actually GO anywhere?
 *
 * The campaign log that motivated this read like a police report: four of seven
 * AI heroes spent the whole game pacing between two tiles with a frozen army.
 * The evidence was a hand-read of a day-by-day position table, which is no way
 * to find the next one. This is that reading, mechanised.
 *
 * It stands up a free-for-all skirmish, drives EVERY seat with the game's own
 * AITurnController (instruments call the engine's functions — they never
 * reimplement them), and records, per hero per day: position, army value, the
 * committed goal and the distance to it. From that it reports:
 *
 *   · goal changes per hero per day        (a working hero should be well under 1)
 *   · the longest 2-tile alternation run    (the oscillation itself)
 *   · the longest army-value freeze         (a hero that fights/recruits nothing)
 *   · distance-to-goal monotonicity         (does a held goal actually get closer?)
 *   · realm_army / best_hero per player     (Phase B's consolidation measure)
 *
 * Usage:  node scripts/sim/goal-audit.mjs [days] [seeds] [--json out.json] [--log]
 */

import { CONFIG } from '../../src/config.js';
import { newGame, playerHeroes, playerTowns, levelObjects } from '../../src/core/GameState.js';
import { CREATURES } from '../../src/data/creatures.js';
import {
  neutralCensus, wildFloor, wildStacks, nearestTownOwner,
} from '../../src/core/neutrals.js';
import { endTurn, dailyIncome } from '../../src/core/actions.js';
import { armyValue } from '../../src/core/heroUtils.js';
import { AITurnController, GOAL_TUNING, COURAGE } from '../../src/ai/AIPlayer.js';
import { aiLogEntries } from '../../src/ai/aiLog.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
/**
 * Flags that consume the NEXT argv entry. Every one of these has to be listed, or
 * its value falls through into `positional` and is read as DAYS.
 *
 * This list used to be just '--json', which meant `--anchor mean` put "mean" in
 * positional[0], DAYS became NaN, the day loop never ran, and the instrument
 * printed a complete, confident, entirely empty report — 0 hero-days, NaN rates —
 * and exited 0. `--w 96 --h 80` was quieter and worse: it silently ran 80 seeds
 * instead of 3. Since this script's output is cited in five docs, a mis-parse that
 * presents itself as a measurement is the worst failure mode available to it, so
 * the guard below refuses to run at all rather than report nothing convincingly.
 */
const VALUE_FLAGS = new Set(['--json', '--w', '--h', '--anchor', '--only']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
const DAYS = Number(positional[0] || 51);
const SEEDS = Number(positional[1] || 3);
if (!Number.isFinite(DAYS) || DAYS <= 0 || !Number.isFinite(SEEDS) || SEEDS <= 0) {
  console.error(`goal-audit: bad arguments — days=${positional[0]} seeds=${positional[1]}`);
  console.error('usage: node scripts/sim/goal-audit.mjs [days] [seeds] '
    + '[--json FILE] [--w N] [--h N] [--anchor mean|max] [--only N] [--log] [--nopeg] [--physical]');
  process.exit(2);
}
const JSON_OUT = opt('--json', null);
const MAP_W = Number(opt('--w', 72));
const MAP_H = Number(opt('--h', 60));
const SHOW_LOG = flag('--log');
// The control arm: neutralise goal commitment (margin 1, no progress clock, no
// strikes) and the AI is bit-for-bit the one that produced the campaign log —
// same seeds, same rng draws, so before/after is a PAIRED comparison.
// Phase C arms: --nopeg reproduces the pre-homeostasis world (no crawling peg,
// no population floor); --anchor mean pegs to the AVERAGE realm instead of the
// strongest one, which is the decision the design brief asked to be measured
// rather than argued.
const NOPEG = flag('--nopeg');
// Diplomacy is an opt-in feature, and the join branch only exists when it is on.
// The realized-multiplier question ("does x20+ only ever land on offers nobody
// could accept?") is a question ABOUT that branch, so it has to be measured with
// the feature on rather than in the default game where it cannot fire.
const DIPLOMACY = flag('--diplomacy');
// The physicalDamage model is opt-in, and it is where the AI's power-vs-price
// split does its real work: the two currencies diverge by up to 1.70x per army
// there, against ±12% under classic. The C13 fix (both sides of every courage
// gate read POWER — see AIPlayer's `physical` getter) changes decisions most
// under this model, so its goal behaviour has to be observable with the same
// instrument that watches the default game, not inferred from classic runs.
const PHYSICAL = flag('--physical');
CONFIG.PEG_ANCHOR = opt('--anchor', CONFIG.PEG_ANCHOR);
const CONTROL = flag('--control');
if (CONTROL) {
  GOAL_TUNING.hysteresis = 1;
  GOAL_TUNING.progressDays = Infinity;
  GOAL_TUNING.failStrikes = Infinity;
}

const FACTIONS = ['castle', 'rampart', 'inferno', 'necropolis'];
const COLOURS = ['Blue', 'Red', 'Green', 'Gold'];

/** One skirmish: four realms, every seat driven by the AI. */
function buildGame(seed) {
  const players = FACTIONS.map((faction, i) => ({
    faction, isHuman: i === 0, team: i, name: COLOURS[i],
  }));
  // Feature flags compose into ONE object — two spreads each carrying their
  // own `features` key would silently drop whichever came first.
  const features = {
    ...(DIPLOMACY ? { diplomacy: true } : {}),
    ...(PHYSICAL ? { physicalDamage: true } : {}),
  };
  return newGame({
    seed, players, mapW: MAP_W, mapH: MAP_H, difficulty: 'normal',
    ...(NOPEG ? { neutralPeg: false } : {}),
    ...(Object.keys(features).length ? { features } : {}),
  });
}

/**
 * Play `days` days. Returns the per-day record plus the goal-change tallies the
 * AI itself counted (metrics.goalChanges), which catch INTRA-turn churn a
 * once-a-day snapshot cannot see.
 */
function play(seed, days) {
  const tag = `s${seed}`;
  const state = buildGame(seed);
  const rows = [];        // one per hero per day
  const realms = [];      // one per PLAYER per day (the consolidation picture)
  const census = [];      // one per day (the world's own population — Phase C)
  // Who holds what, sampled daily, so ownership CHURN can be counted per object
  // (Phase D: "no object changes hands more than twice in any 5-day window").
  const flips = new Map(); // objectId -> [days it changed hands]
  let held = null;
  const churn = new Map(); // heroId -> goal changes counted inside AI turns
  const goalLog = [];      // every goal CHANGE, drained per turn (the ring is bounded)
  const scaleLog = [];    // realized PvE multipliers, drained per turn (Phase E)
  const fights = [];      // every battle, from the chronicle's own choke point
  const work = {
    pickups: 0, pickedUp: 0, merges: 0,
    defenceGold: 0, defenceBought: 0, fortified: 0, income: 0, buyouts: 0, buyoutGold: 0,
  };
  const daysSeen = new Set();
  let guard = days * (state.players.length + 1) + 50;

  while (state.winner === null && state.day <= days && guard-- > 0) {
    const pi = state.currentPlayer;
    if (!state.players[pi].defeated) {
      const ai = new AITurnController(state, pi);
      const before = new Map(playerHeroes(state, pi).map((h) => [h.id, h]));
      let r, g = 2000;
      do { r = ai.next(); if (r.type === 'combat') ai.autoFight(r.context); } while (r.type !== 'done' && g-- > 0);
      // metrics.goalChanges is realm-wide; attribute it to the realm, not a hero.
      churn.set(`P${pi}`, (churn.get(`P${pi}`) || 0) + ai.metrics.goalChanges);
      work.pickups += ai.metrics.pickups;
      work.pickedUp += ai.metrics.pickedUp;
      work.merges += ai.metrics.merges;
      work.defenceGold += ai.metrics.defenceGold;
      work.defenceBought += ai.metrics.defenceBought;
      work.fortified += ai.metrics.fortified;
      work.buyouts += ai.metrics.buyouts;
      work.buyoutGold += ai.metrics.buyoutGold;
      // What the realm earned today, so defence spending can be read as a share
      // of income rather than as a bare number.
      const inc = dailyIncome(state, state.players[pi]);
      work.income += Math.max(0, inc.gold || 0);
      // Every battle in the game passes through recordCombat, so the chronicle is
      // the honest place to ask who attacked whom. Bounded, so drained per turn.
      const book = state.chronicle;
      if (book?.entries?.length) {
        for (const e of book.entries) if (e.t === 'fight') fights.push(e);
        book.entries.length = 0;
      }
      // Same reason as the goal log: state.pveScaleLog is a bounded ring.
      if (state.pveScaleLog?.length) {
        scaleLog.push(...state.pveScaleLog.splice(0, state.pveScaleLog.length));
      }
      // Drain this turn's goal changes: state.aiLog is a bounded ring, so a
      // 100-day audit would otherwise keep only the last few turns of them.
      for (const e of aiLogEntries(state, { player: pi, day: state.day, kind: 'goal' })) goalLog.push(e);
      before.clear();
    }
    const flags = endTurn(state);
    if (flags.newDay || !daysSeen.size) {
      const day = state.day;
      if (daysSeen.has(day)) continue;
      daysSeen.add(day);
      // Ownership churn: one sample a day, diffed against yesterday.
      const now = new Map();
      for (const t of Object.values(state.towns)) now.set(t.id, t.owner);
      for (const lvl of state.map.underground ? [0, 1] : [0]) {
        for (const o of Object.values(levelObjects(state, lvl))) {
          if (o.type === 'mine' || o.type === 'dwelling') now.set(o.id, o.owner ?? -1);
        }
      }
      if (held) {
        for (const [id, owner] of now) {
          if (held.has(id) && held.get(id) !== owner) {
            if (!flips.has(id)) flips.set(id, []);
            flips.get(id).push(day);
          }
        }
      }
      held = now;
      // The world's population, read through the engine's own census — plus how
      // much of it each realm can actually take. If pegging to the LEADER prices
      // the trailing realms out of the map entirely, this is where it shows.
      const all = wildStacks(state).filter((w) => !w.guard);
      const bands = all.map((w) => w.value);
      // Whose country each band stands in — the question the territorial peg is
      // answering, and therefore the one worth measuring. A realm's share of the
      // WHOLE map is the wrong instrument once bands are priced by position:
      // most of the map is somebody else's country and is meant to be expensive.
      const homeOf = all.map((w) => nearestTownOwner(state, w.obj.x, w.obj.y, w.level)?.owner ?? -1);
      const openness = {};
      const opennessHome = {};
      for (const p of state.players) {
        if (p.defeated) continue;
        const best = playerHeroes(state, p.index)
          .reduce((n, h) => Math.max(n, armyValue(h.army)), 0);
        const who = p.name || `P${p.index}`;
        openness[who] = bands.length
          ? bands.filter((v) => best >= v * COURAGE).length / bands.length : null;
        const mine = bands.filter((_, i) => homeOf[i] === p.index);
        opennessHome[who] = mine.length
          ? { share: mine.filter((v) => best >= v * COURAGE).length / mine.length, n: mine.length }
          : null;
      }
      census.push({ ...neutralCensus(state), floor: wildFloor(state), openness, opennessHome });
      for (const p of state.players) {
        if (p.defeated) continue;
        const heroes = playerHeroes(state, p.index);
        const towns = playerTowns(state, p.index);
        const heroArmy = heroes.reduce((n, h) => n + armyValue(h.army), 0);
        const townArmy = towns.reduce((n, t) => n + armyValue(t.garrison), 0);
        const realm = heroArmy + townArmy;
        const best = heroes.reduce((n, h) => Math.max(n, armyValue(h.army)), 0);
        realms.push(realmSnapshot(state, p, day, heroes, towns, heroArmy, townArmy, best));
        for (const h of heroes) {
          const g = h.aiGoal || null;
          rows.push({
            seed: tag,
            day,
            player: p.index,
            colour: p.name || `P${p.index}`,
            heroId: h.id,
            hero: h.name || h.id,
            x: h.x,
            y: h.y,
            z: h.z ?? 0,
            army: Math.round(armyValue(h.army)),
            goal: g ? g.key : null,
            goalType: g ? g.type : null,
            goalDist: g && g.x != null && (g.z ?? 0) === (h.z ?? 0)
              ? Math.round(Math.hypot(g.x - h.x, g.y - h.y) * 10) / 10 : null,
            realm: Math.round(realm),
            best: Math.round(best),
          });
        }
      }
    }
  }
  return { state, rows, realms, census, churn, goalLog, work, flips, scaleLog, fights };
}

/** Value of one stack, on the same scale the AI prices armies with. */
const stackValue = (st) => (st && st.count > 0 ? (CREATURES[st.creature]?.aiValue || 0) * st.count : 0);

/**
 * The consolidation picture for one realm on one day, plus the two counterfactuals
 * that say whether the acceptance bar is even reachable.
 *
 * A hero has SEVEN slots. `bestIfTopTown` is what the strongest hero would be
 * worth standing in the town with the largest stock and keeping the seven best
 * stacks between them; `bestIfEverything` is the same with every own garrison in
 * the realm pooled — the absolute ceiling perfect consolidation could reach. If
 * `realm / bestIfEverything` is still above 2.0, no amount of marching fixes the
 * ratio and the slot cap is the binding constraint, not the AI's intent.
 */
function realmSnapshot(state, p, day, heroes, towns, heroArmy, townArmy, best) {
  const strongest = heroes.reduce((b, h) => (!b || armyValue(h.army) > armyValue(b.army) ? h : b), null);
  const pool = (stacks) => {
    // Merge same-creature stacks (addToArmy merges), then keep the seven best.
    const byKind = new Map();
    for (const st of stacks) {
      if (!st || st.count <= 0) continue;
      byKind.set(st.creature, (byKind.get(st.creature) || 0) + st.count);
    }
    return [...byKind.entries()]
      .map(([creature, count]) => stackValue({ creature, count }))
      .sort((a, b2) => b2 - a).slice(0, 7)
      .reduce((n, v) => n + v, 0);
  };
  const mine = strongest ? strongest.army.filter(Boolean) : [];
  const topTown = towns.reduce((b, t) => (!b || armyValue(t.garrison) > armyValue(b.garrison) ? t : b), null);
  const bestIfTopTown = strongest ? pool([...mine, ...((topTown?.garrison) || []).filter(Boolean)]) : 0;
  const bestIfEverything = strongest
    ? pool([...mine, ...towns.flatMap((t) => (t.garrison || []).filter(Boolean))]) : 0;
  // Merge opportunities: own heroes within one tile, the weaker under a fifth
  // of the stronger — the pairs the "merge on meeting" rule would act on.
  let mergePairs = 0;
  for (let i = 0; i < heroes.length; i++) {
    for (let j = i + 1; j < heroes.length; j++) {
      const a = heroes[i], b2 = heroes[j];
      if ((a.z ?? 0) !== (b2.z ?? 0)) continue;
      if (Math.max(Math.abs(a.x - b2.x), Math.abs(a.y - b2.y)) > 1) continue;
      const va = armyValue(a.army), vb = armyValue(b2.army);
      if (Math.min(va, vb) <= 0.2 * Math.max(va, vb)) mergePairs++;
    }
  }
  return {
    day,
    colour: p.name || `P${p.index}`,
    heroes: heroes.length,
    towns: towns.length,
    realm: Math.round(realm0(heroArmy, townArmy)),
    heroArmy: Math.round(heroArmy),
    townArmy: Math.round(townArmy),
    best: Math.round(best),
    freeSlots: strongest ? strongest.army.filter((st) => !st || st.count <= 0).length : 0,
    bestIfTopTown: Math.round(bestIfTopTown),
    bestIfEverything: Math.round(bestIfEverything),
    mergePairs,
    // Garrison value sitting in towns no hero is standing in.
    idleTownArmy: Math.round(towns.filter((t) => !t.visitingHeroId)
      .reduce((n, t) => n + armyValue(t.garrison), 0)),
  };
}
const realm0 = (a, b) => a + b;

// ---- Measures ------------------------------------------------------------

/** Position key of one day's record. */
function tileKey(p) { return `${p.x},${p.y},${p.z}`; }

/**
 * Longest run of consecutive days whose positions alternate between exactly two
 * distinct tiles (A B A B …) — the oscillation signature itself.
 */
function longestAlternation(series) {
  let best = 0;
  for (let i = 0; i + 1 < series.length; i++) {
    if (series[i + 1].day !== series[i].day + 1) continue;
    const a = tileKey(series[i]), b = tileKey(series[i + 1]);
    if (a === b) continue;
    let len = 2, j = i + 2;
    while (j < series.length && series[j].day === series[j - 1].day + 1
      && tileKey(series[j]) === (len % 2 === 0 ? a : b)) { len++; j++; }
    if (len > best) best = len;
  }
  return best;
}

/** Longest run of consecutive days spent on ONE tile (a hero that never moves). */
function longestStill(series) {
  let best = 1, run = 1;
  for (let i = 1; i < series.length; i++) {
    if (series[i].day !== series[i - 1].day + 1) { run = 1; continue; }
    run = tileKey(series[i]) === tileKey(series[i - 1]) ? run + 1 : 1;
    if (run > best) best = run;
  }
  return series.length ? best : 0;
}

/** Longest span of consecutive days over which the army value never changed. */
function longestFreeze(series) {
  let best = 0, run = 1;
  for (let i = 1; i < series.length; i++) {
    if (series[i].day !== series[i - 1].day + 1) { run = 1; continue; }
    run = series[i].army === series[i - 1].army ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Within each unbroken spell of one goal, what fraction of day-to-day steps
 * moved the hero CLOSER to it? A working hero's spells are near-monotone.
 */
function approachFraction(series) {
  let closer = 0, steps = 0;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (b.day !== a.day + 1 || !a.goal || a.goal !== b.goal) continue;
    if (a.goalDist == null || b.goalDist == null) continue;
    steps++;
    if (b.goalDist < a.goalDist - 0.01) closer++;
  }
  return { closer, steps, frac: steps ? closer / steps : null };
}

function summarise(runs) {
  const perHero = new Map();
  for (const { rows } of runs) {
    for (const r of rows) {
      const k = `${r.seed}|${r.colour}/${r.hero}#${r.heroId}`;
      if (!perHero.has(k)) perHero.set(k, []);
      perHero.get(k).push(r);
    }
  }
  const out = [];
  for (const [key, all] of perHero) {
    const who = key.split('|')[1].replace(/#.*$/, '');
    const series = all.sort((a, b) => a.day - b.day);
    let changes = 0, spans = 0;
    for (let i = 1; i < series.length; i++) {
      if (series[i].day !== series[i - 1].day + 1) continue;
      spans++;
      if (series[i].goal !== series[i - 1].goal) changes++;
    }
    const ap = approachFraction(series);
    out.push({
      who,
      days: series.length,
      changesPerDay: spans ? changes / spans : 0,
      alternation: longestAlternation(series),
      still: longestStill(series),
      freeze: longestFreeze(series),
      approach: ap.frac,
      approachSteps: ap.steps,
      armyStart: series[0]?.army ?? 0,
      armyEnd: series[series.length - 1]?.army ?? 0,
    });
  }
  return out.sort((a, b) => b.alternation - a.alternation || b.changesPerDay - a.changesPerDay);
}

function ratioReport(runs) {
  const perPlayer = new Map();
  for (const { rows } of runs) {
    for (const r of rows) {
      const k = r.colour;
      if (!perPlayer.has(k)) perPlayer.set(k, new Map());
      perPlayer.get(k).set(`${r.day}`, r.best ? r.realm / r.best : null);
    }
  }
  const out = [];
  for (const [colour, byDay] of perPlayer) {
    const vals = [...byDay.values()].filter((v) => v != null);
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    out.push({
      colour,
      median: vals[Math.floor(vals.length / 2)],
      p90: vals[Math.floor(vals.length * 0.9)],
      under2: vals.filter((v) => v < 2).length / vals.length,
    });
  }
  return out;
}

// ---- Run -----------------------------------------------------------------

const ONLY = Number(opt('--only', 0)); // run just this seed index (debugging one game)
const runs = [];
for (let s = ONLY || 1; s <= (ONLY || SEEDS); s++) {
  const t0 = Date.now();
  const run = play(1000 * s, DAYS);
  runs.push(run);
  const realmChurn = [...run.churn.entries()].map(([p, n]) => `${p}:${n}`).join(' ');
  const standings = run.state.players.map((p) => `${p.name || p.index}${p.defeated ? '✝' : ''}:`
    + `${playerTowns(run.state, p.index).length}t/${playerHeroes(run.state, p.index).length}h`).join(' ');
  console.log(`seed ${s}: day ${run.state.day}, winner ${run.state.winner ?? 'none'}, ${standings}, `
    + `${run.rows.length} hero-days, in-turn goal changes ${realmChurn}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (SHOW_LOG) {
    for (const e of aiLogEntries(run.state, { kind: 'goal' }).slice(-40)) {
      console.log(`   d${e.day} ${e.hero}: ${e.from ?? 'nothing'} (${e.fromScore ?? '—'}) → ${e.to} (${e.toScore}) · ${e.reason}`);
    }
  }
}

const rowsAll = runs.flatMap((r) => r.rows);
console.log(`\n=== Per-hero goal behaviour — ${CONTROL ? 'CONTROL (no commitment)' : 'goal commitment on'} `
  + `(${DAYS} days × ${SEEDS} seeds, ${MAP_W}×${MAP_H}) ===`);
console.log('hero                         days  chg/day  alt-run  still  army-freeze  approach%  army start→end');
for (const h of summarise(runs)) {
  console.log(`${h.who.padEnd(28)} ${String(h.days).padStart(4)}  `
    + `${h.changesPerDay.toFixed(2).padStart(7)}  ${String(h.alternation).padStart(7)}  ${String(h.still).padStart(5)}  `
    + `${String(h.freeze).padStart(11)}  `
    + `${(h.approach == null ? '  —  ' : (100 * h.approach).toFixed(0).padStart(5))}    `
    + `${h.armyStart} → ${h.armyEnd}`);
}

// ---- Consolidation (Phase B) --------------------------------------------
const realmsAll = runs.flatMap((r) => r.realms);
console.log('\n=== Army consolidation ===');
// The ratio decomposes: realm/best = 1 + (other heroes + garrisons) / best. So
// "in towns" is the leak this phase is about, and "other heroes" is a floor the
// slot cap puts under the acceptance bar — seven slots cannot hold a realm.
console.log('realm      days  heroes  realm/best med  under 2.0  in towns  other heroes  '
  + 'ceiling: top town  everything  merge pairs/day');
const byColour = new Map();
for (const r of realmsAll) {
  if (!byColour.has(r.colour)) byColour.set(r.colour, []);
  byColour.get(r.colour).push(r);
}
for (const [colour, list] of byColour) {
  const live = list.filter((r) => r.best > 0);
  if (!live.length) continue;
  const ratios = live.map((r) => r.realm / r.best).sort((a, b) => a - b);
  const share = (f) => live.reduce((n, r) => n + f(r), 0) / live.reduce((n, r) => n + r.realm, 0);
  // The ceilings are ratios too: realm / (what perfect consolidation could hold).
  const ceil = (key) => {
    const v = live.filter((r) => r[key] > 0).map((r) => r.realm / r[key]).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : NaN;
  };
  const heroesMed = live.map((r) => r.heroes).sort((a, b) => a - b)[live.length >> 1];
  console.log(`${colour.padEnd(8)} ${String(live.length).padStart(5)}  `
    + `${String(heroesMed).padStart(6)}  `
    + `${ratios[ratios.length >> 1].toFixed(2).padStart(13)}  `
    + `${(100 * ratios.filter((v) => v < 2).length / ratios.length).toFixed(0).padStart(8)}%  `
    + `${(100 * share((r) => r.townArmy)).toFixed(0).padStart(7)}%  `
    + `${(100 * share((r) => r.heroArmy - r.best)).toFixed(0).padStart(11)}%  `
    + `${ceil('bestIfTopTown').toFixed(2).padStart(16)}  `
    + `${ceil('bestIfEverything').toFixed(2).padStart(10)}  `
    + `${(live.reduce((n, r) => n + r.mergePairs, 0) / live.length).toFixed(2).padStart(14)}`);
}

const work = runs.reduce((n, r) => ({
  pickups: n.pickups + r.work.pickups,
  pickedUp: n.pickedUp + r.work.pickedUp,
  merges: n.merges + r.work.merges,
  defenceGold: n.defenceGold + r.work.defenceGold,
  defenceBought: n.defenceBought + r.work.defenceBought,
  fortified: n.fortified + r.work.fortified,
  income: n.income + r.work.income,
  buyouts: n.buyouts + r.work.buyouts,
  buyoutGold: n.buyoutGold + r.work.buyoutGold,
}), {
  pickups: 0, pickedUp: 0, merges: 0, defenceGold: 0, defenceBought: 0, fortified: 0,
  income: 0, buyouts: 0, buyoutGold: 0,
});
console.log(`consolidation performed: ${work.pickups} garrison pickups moving `
  + `${Math.round(work.pickedUp).toLocaleString()} of army value into the field, ${work.merges} hero merges`);

// ---- The world's population (Phase C) -----------------------------------
console.log(`\n=== Neutral population — ${NOPEG ? 'no peg' : `peg ${CONFIG.PEG_RATIO} of the ${CONFIG.PEG_ANCHOR} realm, `
  + `crawl ${CONFIG.PEG_CRAWL_PCT} of the gap/week`} ===`);
// "vs peg" is each band against ITS OWN target now (position sets the anchor),
// which is the only ratio that means anything once the peg is territorial.
console.log('day   wandering  (floor)   median   p90   vs peg   guards  median   p90   '
  + 'leading realm   fieldable');
for (const day of [1, 20, 50, 80, 100]) {
  const rows2 = runs.flatMap((r) => r.census).filter((c) => c.day === day);
  if (!rows2.length) continue;
  const med = (f) => {
    const v = rows2.map(f).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  console.log(`${String(day).padStart(3)}   ${String(med((c) => c.wandering.count)).padStart(9)}  `
    + `${String(med((c) => c.floor)).padStart(7)}   ${String(Math.round(med((c) => c.wandering.median))).padStart(6)}  `
    + `${String(Math.round(med((c) => c.wandering.p90))).padStart(5)}  `
    + `${(med((c) => (c.localRatio ? c.localRatio.median : 0)) || 0).toFixed(2).padStart(6)}   `
    + `${String(med((c) => c.guards.count)).padStart(6)}  ${String(Math.round(med((c) => c.guards.median))).padStart(6)}  `
    + `${String(Math.round(med((c) => c.guards.p90))).padStart(5)}  `
    + `${String(Math.round(med((c) => c.leading))).padStart(13)}   `
    + `${String(Math.round(med((c) => c.fieldable || 0))).padStart(9)}`);
}
{
  // How much of the wild population each realm's best hero can beat at the AI's
  // own courage margin — the "does pegging to the leader freeze everyone else
  // out" question, measured rather than argued.
  console.log('\nshare of bands IN ITS OWN COUNTRY each realm could beat (best hero, courage margin):');
  for (const day of [20, 50, 80, 100]) {
    const rows2 = runs.flatMap((r) => r.census).filter((c) => c.day === day);
    if (!rows2.length) continue;
    const per = {};
    for (const c of rows2) {
      for (const [who, v] of Object.entries(c.opennessHome || {})) {
        if (!v) continue;
        (per[who] = per[who] || []).push(v.share);
      }
    }
    const parts = Object.entries(per).map(([who, vs]) => {
      vs.sort((a, b) => a - b);
      return `${who} ${(100 * vs[vs.length >> 1]).toFixed(0)}%`;
    });
    console.log(`  day ${String(day).padStart(3)}: ${parts.join('   ')}`);
  }
  console.log('\nshare of ALL wandering bands each realm could beat (most of the map is somebody else\'s):');
  for (const day of [20, 50, 80, 100]) {
    const rows2 = runs.flatMap((r) => r.census).filter((c) => c.day === day);
    if (!rows2.length) continue;
    const per = {};
    for (const c of rows2) {
      for (const [who, v] of Object.entries(c.openness || {})) {
        if (v == null) continue;
        (per[who] = per[who] || []).push(v);
      }
    }
    const parts = Object.entries(per).map(([who, vs]) => {
      vs.sort((a, b) => a - b);
      return `${who} ${(100 * vs[vs.length >> 1]).toFixed(0)}%`;
    });
    console.log(`  day ${String(day).padStart(3)}: ${parts.join('   ')}`);
  }
  const all = runs.flatMap((r) => r.census);
  const below = all.filter((c) => c.wandering.count < c.floor).length;
  console.log(`day-observations with the wandering population below its floor: ${below}/${all.length}`
    + `  (${(100 * below / Math.max(1, all.length)).toFixed(0)}%)`);
}

// ---- Ownership churn (Phase D) ------------------------------------------
console.log('\n=== Ownership churn ===');
{
  let everFlipped = 0, worst = 0, over = 0, totalFlips = 0;
  const worstList = [];
  for (const run of runs) {
    for (const [id, days] of run.flips) {
      if (!days.length) continue;
      everFlipped++;
      totalFlips += days.length;
      // Widest 5-day window: how many times did this change hands inside one?
      let peak = 0;
      for (let i = 0; i < days.length; i++) {
        let n = 0;
        for (let j = i; j < days.length && days[j] < days[i] + 5; j++) n++;
        if (n > peak) peak = n;
      }
      if (peak > worst) worst = peak;
      if (peak > 2) { over++; worstList.push({ id, peak, days: days.length }); }
    }
  }
  console.log(`objects that changed hands at least once: ${everFlipped} (${totalFlips} changes in all)`);
  console.log(`worst 5-day window, any object:           ${worst} changes`);
  console.log(`objects exceeding 2 changes in a 5-day window: ${over}`
    + `  (${everFlipped ? (100 * over / everFlipped).toFixed(0) : 0}% of those that ever moved)`);
  worstList.sort((a, b) => b.peak - a.peak);
  for (const w of worstList.slice(0, 5)) {
    console.log(`   ${w.id}: ${w.peak} in five days, ${w.days} over the campaign`);
  }
}

console.log(`defence: ${Math.round(work.defenceGold).toLocaleString()} gold committed `
  + `(${work.defenceBought} garrison purchases, ${work.fortified} fortifications) — `
  + `${work.income > 0 ? (100 * work.defenceGold / work.income).toFixed(1) : '—'}% of AI gold income`);
console.log(`buyouts: ${work.buyouts} garrisons paid to march away, `
  + `${Math.round(work.buyoutGold).toLocaleString()} gold transferred to their owners`);

// ---- Realized neutral multipliers (Phase E) ------------------------------
{
  const all = runs.flatMap((r) => r.scaleLog);
  console.log('\n=== Realized neutral multipliers ===');
  if (!all.length) console.log('  (no PvE encounters were priced — scaling applies to human-seat attackers)');
  else {
    const show = (label, rows2) => {
      if (!rows2.length) { console.log(`  ${label.padEnd(26)} —`); return; }
      const v = rows2.map((e) => e.mult).sort((a, b) => a - b);
      const at = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))];
      const big = rows2.filter((e) => e.mult >= 20).length;
      console.log(`  ${label.padEnd(26)} n=${String(rows2.length).padStart(5)}  `
        + `median ${at(0.5).toFixed(2).padStart(7)}  p90 ${at(0.9).toFixed(2).padStart(8)}  `
        + `max ${v[v.length - 1].toFixed(2).padStart(9)}   x20+ ${big}`);
    };
    show('all encounters', all);
    show('a join offer stood', all.filter((e) => e.joinOffered));
    show('no offer — a fight', all.filter((e) => !e.joinOffered));
    // The brief's actual question: are the huge multipliers landing on stacks
    // that were never join candidates, or on offers nobody could accept?
    const big = all.filter((e) => e.mult >= 20);
    const by = {};
    for (const e of big) by[e.why || '—'] = (by[e.why || '—'] || 0) + 1;
    console.log(`  x20+ encounters by why-no-offer: ${
      Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  }
}

// ---- Who fought whom (Phase F) -------------------------------------------
{
  const all = runs.flatMap((r) => r.fights);
  // Seat 0 is the human seat in this harness (driven by the AI, but flagged
  // isHuman, so every rule that reads isHuman behaves as it would in a real game).
  const HUMAN = 0;
  const pvp = all.filter((f) => f.atkOwner >= 0 && f.defOwner >= 0 && f.atkOwner !== f.defOwner);
  const aiOnHuman = pvp.filter((f) => f.atkOwner !== HUMAN && f.defOwner === HUMAN);
  const humanOnAi = pvp.filter((f) => f.atkOwner === HUMAN && f.defOwner !== HUMAN);
  const wipe = (f) => f.defAfter === 0 || f.atkAfter === 0;
  console.log('\n=== Who attacked whom ===');
  console.log(`battles in all: ${all.length}   realm-vs-realm: ${pvp.length}`);
  console.log(`  AI realms attacking the human seat: ${aiOnHuman.length}`
    + (aiOnHuman.length ? `  (attacker won ${aiOnHuman.filter((f) => f.won === 'atk').length})` : '  <-- the defensive half is still inert'));
  console.log(`  the human seat attacking AI realms: ${humanOnAi.length}`
    + (humanOnAi.length ? `  (attacker won ${humanOnAi.filter((f) => f.won === 'atk').length})` : ''));
  if (pvp.length) {
    console.log(`  attacker won: ${(100 * pvp.filter((f) => f.won === 'atk').length / pvp.length).toFixed(0)}%`
      + `   one side wiped out: ${(100 * pvp.filter(wipe).length / pvp.length).toFixed(0)}%`);
  }
}

console.log('\n=== realm_army / best_hero ===');
for (const r of ratioReport(runs)) {
  console.log(`${r.colour.padEnd(8)} median ${r.median.toFixed(2)}  p90 ${r.p90.toFixed(2)}  days under 2.0: ${(100 * r.under2).toFixed(0)}%`);
}

const worst = summarise(runs);
const oscillating = worst.filter((h) => h.alternation > 3);
const frozen = worst.filter((h) => h.freeze >= 10);
// Rates, not counts: a decisive AI ends its campaigns sooner, and a shorter
// game gives a hero less room to misbehave. Per hero-day is the honest unit.
const heroDays = rowsAll.length;
const changes = worst.reduce((n, h) => n + h.changesPerDay * (h.days - 1), 0);
console.log(`\nhero-days observed:                               ${heroDays}`);
console.log(`goal changes per hero-day:                        ${(changes / heroDays).toFixed(3)}`);
// Split by REASON, because the aggregate conflates a hero abandoning a goal with
// a hero finishing one — and only the first is churn. Reported, not footnoted.
const reasons = {};
for (const r of runs) for (const e of r.goalLog) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
const per = (k) => ((reasons[k] || 0) / heroDays).toFixed(3);
console.log(`  · abandoned (outbid+stalled) /hero-day:          ${(((reasons.outbid || 0) + (reasons.stalled || 0)) / heroDays).toFixed(3)}`
  + `   [outbid ${per('outbid')}, stalled ${per('stalled')}]`);
console.log(`  · completed (achieved) /hero-day:                ${per('achieved')}`);
console.log(`  · target left the board (gone) /hero-day:        ${per('gone')}`);
console.log(`longest 2-tile alternation seen (days):           ${Math.max(...worst.map((h) => h.alternation))}`);
console.log(`heroes alternating between two tiles for >3 days: ${oscillating.length}/${worst.length}`
  + `  (${(100 * oscillating.length / worst.length).toFixed(0)}%)`);
console.log(`heroes whose army never changed for >=10 days:     ${frozen.length}/${worst.length}`
  + `  (${(100 * frozen.length / worst.length).toFixed(0)}%)`);
const idle = worst.filter((h) => h.still > 3);
console.log(`heroes parked on one tile for >3 days:             ${idle.length}/${worst.length}`);
const ap = worst.map((h) => h.approach).filter((v) => v != null).sort((a, b) => a - b);
console.log(`median approach fraction within a held goal:      ${ap.length ? (100 * ap[ap.length >> 1]).toFixed(0) + '%' : '—'}`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    days: DAYS, seeds: SEEDS, rows: rowsAll, summary: worst,
    realms: runs.flatMap((r, i) => r.realms.map((x) => ({ seed: `s${1000 * (i + 1)}`, ...x }))),
    census: runs.flatMap((r, i) => r.census.map((x) => ({ seed: `s${1000 * (i + 1)}`, ...x }))),
    goalLog: runs.flatMap((r, i) => r.goalLog.map((e) => ({ seed: `s${1000 * (i + 1)}`, ...e }))),
  }, null, 1));
  console.log(`\nwrote ${JSON_OUT}`);
}
