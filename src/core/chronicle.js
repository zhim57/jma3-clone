/**
 * chronicle.js — the game's log book, written for a reader who was not there.
 *
 * Asked for as "a log that will give you what we have, castles heroes armies, then we
 * have the invaders stats and movements, my heroes movements and stats, armies, combats
 * outcomes and other stuff you think may be of help to see a whole picture … like a
 * chess game log, so you can figure all out."
 *
 * So the audience is diagnosis, not flavour. Everything in here exists because at some
 * point this session a question could only be answered by rebuilding the position from
 * scratch in a simulator: what was the wave actually sized against, how big was the army
 * that met it, who was cornered and since when, what did the fight cost each side. A
 * chronicle answers those from the save instead of from a reconstruction.
 *
 * Three kinds of line, and the mix is the point:
 *
 *   POSITION — one entry per day per realm: towns, gold, every hero with its level, stat
 *   sum, army value and where it stands. This is the "what we have", and its diff from
 *   day to day is the "movements" without storing a path per hero.
 *
 *   GAUGES — the numbers the systems actually read: the wave's power base, the best
 *   commander in the world, days to the next people, each realm's cornered score. Every
 *   calibration argument this session turned on one of these, and none of them were
 *   visible from inside a game.
 *
 *   EVENTS — battles with both sides' values before and after, landings with each
 *   commander's order of battle, reinforcements against the reserve, towns changing
 *   hands, and the diplomacy (envoys, oaths, purses, bills). A battle line is the single
 *   highest-value record in here: "one hero, five commanders, twenty marksmen lost" is a
 *   sentence a log states in numbers.
 *
 * Bounded on purpose. A long game on a big map would otherwise put megabytes into
 * localStorage, so the journal is a ring buffer (CHRONICLE_MAX) that drops its oldest
 * entries. It rides the save like any other plain data.
 *
 * Pure rule-engine: no Phaser, no view imports, no rng. Recording must never be able to
 * change what it records.
 */

import { CONFIG } from '../config.js';
import { playerTowns, playerHeroes, weekOf } from './GameState.js';
import { armyValue, effectiveForce } from './heroUtils.js';
import { CREATURES } from '../data/creatures.js';

const STATS = ['attack', 'defense', 'power', 'knowledge'];
const statSum = (h) => STATS.reduce((n, k) => n + (h?.stats?.[k] || 0), 0);

/** The journal, created on first use. Absent on a save written before this existed. */
function book(state) {
  if (!state.chronicle) state.chronicle = { entries: [], dropped: 0 };
  return state.chronicle;
}

/** Every entry currently held. */
export const chronicleEntries = (state) => state?.chronicle?.entries || [];

/** Append one entry, dropping the oldest when the ring is full. */
function push(state, entry) {
  if (!state || state.chronicleOff) return null;
  const b = book(state);
  b.entries.push(entry);
  const max = CONFIG.CHRONICLE_MAX;
  if (b.entries.length > max) {
    b.dropped += b.entries.length - max;
    b.entries.splice(0, b.entries.length - max);
  }
  return entry;
}

/** A compact stack list: "186 Bone Dragon + 68 Ghost Dragon". */
export function armyBrief(army) {
  return (army || [])
    .filter((s) => s && s.count > 0)
    .map((s) => `${s.count} ${CREATURES[s.creature]?.name || s.creature}`)
    .join(' + ');
}

/**
 * One realm's position right now: what it holds, what it can field, and every commander
 * with the four numbers that decide a battle.
 */
export function realmSnapshot(state, player) {
  const weight = Number.isFinite(state.heroPowerWeight) ? state.heroPowerWeight : 0;
  const heroes = playerHeroes(state, player.index).map((h) => ({
    n: h.name,
    lv: h.level || 1,
    st: statSum(h),
    a: Math.round(armyValue(h.army)),
    f: Math.round(effectiveForce(h.army, h, weight)),
    at: `${h.x},${h.y}${(h.z ?? 0) ? 'u' : ''}`,
    mv: h.movement ?? null,
    army: armyBrief(h.army),
  }));
  const towns = playerTowns(state, player.index);
  return {
    i: player.index,
    n: player.name,
    inv: player.invader || null,
    team: player.team,
    towns: towns.length,
    forts: towns.filter((t) => (t.buildings || []).includes('castle')).length,
    camps: towns.filter((t) => t.beachhead).length,
    gold: Math.round(player.resources?.gold || 0),
    army: Math.round(heroes.reduce((n, h) => n + h.a, 0)
      + towns.reduce((n, t) => n + armyValue(t.garrison), 0)),
    best: heroes.reduce((n, h) => Math.max(n, h.f), 0),
    heroes,
  };
}

/**
 * The gauges: the numbers the engine's own decisions are made from.
 *
 * Injected rather than imported, because the interesting ones live in modules that
 * import this one's callers (invaderPlanner, pacts) and a cycle for a diagnostic would
 * be a poor trade. `advanceDay` passes what it already has in hand.
 */
export function recordDay(state, gauges = {}) {
  if (!state || state.chronicleOff) return null;
  const realms = (state.players || [])
    .filter((p) => !p.defeated)
    .map((p) => realmSnapshot(state, p));
  return push(state, {
    t: 'day', d: state.day, w: weekOf(state.day), realms, g: gauges,
  });
}

/**
 * A battle, with both sides priced BEFORE and AFTER.
 *
 * Called from applyCombatResult — the one choke point every battle in the game passes
 * through, interactive or auto-resolved — so nothing can be fought without being
 * written down. `pre` must be captured before the write-backs mutate anything.
 *
 * `rec.seed` is the rng state the fight began at (CombatEngine.createBattle), which is
 * what makes this an entry you can re-run rather than only read: an outcome log says a
 * battle was lost, a seed says which battle, and one save plus one seed replays it.
 */
export function recordCombat(state, rec) {
  if (!state || state.chronicleOff) return null;
  return push(state, { t: 'fight', d: state.day, ...rec });
}

/** Anything else worth a line: a landing, a capture, an oath, a bill, a note. */
export function recordEvent(state, kind, data = {}) {
  if (!state || state.chronicleOff) return null;
  return push(state, { t: kind, d: state.day, ...data });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? ''));

/** One realm's position, as a line plus one indented line per commander. */
function realmLines(r) {
  const out = [];
  const tag = r.inv ? ` [INVADER ${r.inv}]` : '';
  out.push(`  ${r.n}${tag} — ${r.towns} towns (${r.forts} castled${r.camps ? `, ${r.camps} camps` : ''}), `
    + `${n(r.gold)}g, realm army ${n(r.army)}, best ${n(r.best)}`);
  for (const h of r.heroes) {
    out.push(`      ${h.n} lv${h.lv} stats ${h.st} @${h.at}`
      + `${h.mv != null ? ` mv${h.mv}` : ''} — ${n(h.f)} (${h.army || 'empty'})`);
  }
  return out;
}

/** The gauge line: only the gauges actually present, so an old entry renders. */
function gaugeLine(g) {
  if (!g || !Object.keys(g).length) return null;
  const bits = [];
  if (g.wavePower != null) bits.push(`wave base ${n(Math.round(g.wavePower))}`);
  if (g.bestHeroStat != null) bits.push(`best hero ${g.bestHeroStat}/lv${g.bestHeroLevel ?? '?'}`);
  if (g.nextNationIn != null) bits.push(`next people in ${g.nextNationIn}d`);
  if (g.nextWaveIn != null) bits.push(`next band in ${g.nextWaveIn}d`);
  if (g.bands != null) bits.push(`${g.bands} bands afoot`);
  if (g.cornered?.length) {
    bits.push(`cornered: ${g.cornered.map((c) => `${c.n} ${c.s.toFixed(2)}`).join(', ')}`);
  }
  return bits.length ? `  gauges: ${bits.join(' · ')}` : null;
}

/** One event, as a single readable line. */
function eventLine(e) {
  switch (e.t) {
    case 'fight': {
      const won = e.won === 'atk' ? 'ATTACKER WINS' : 'DEFENDER HOLDS';
      const cost = (side) => {
        const before = side === 'atk' ? e.atkBefore : e.defBefore;
        const after = side === 'atk' ? e.atkAfter : e.defAfter;
        if (before == null || after == null) return '?';
        const pct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
        return `${n(before)}→${n(after)} (−${pct}%)`;
      };
      return `  FIGHT ${e.atk} vs ${e.def}${e.at ? ` at ${e.at}` : ''} — ${won}`
        + `\n        attacker ${cost('atk')}`
        + `\n        defender ${cost('def')}`
        + (e.scaled ? `\n        (defender was scaled to the attacker's army ×${e.scaled.toFixed(2)})` : '')
        // The rng state this fight started from. It is what turns "it went wrong in
        // that battle" into a battle somebody can re-run, so it belongs in the text
        // a bug report is pasted from, not only in the JSON.
        + (e.seed ? `\n        seed ${e.seed.state} @${e.seed.calls} draws` : '');
    }
    case 'landing':
      return `  ** ${e.nation} COMES ASHORE ** ${e.commanders?.length || 0} commanders, `
        + `${e.camps?.length || 0} camps, wave total ${n(e.total)}\n`
        + (e.commanders || []).map((c) => `        ${c.n} lv${c.lv} stats ${c.st} — ${n(c.a)} (${c.army})`).join('\n')
        + (e.camps || []).map((c) => `\n        camp ${c.n} @${c.at}, ${c.b} buildings`).join('');
    case 'reinforce':
      return `  ${e.nation} reinforced +${n(e.value)} (reserve ${n(e.spent)}/${n(e.reserve)})`;
    case 'town':
      return `  TOWN ${e.name}: ${e.from} → ${e.to} (${e.how})`;
    case 'study': {
      // The study break used to leave no trace at all: not offered, not refused, not
      // taken, not graded. A chronicle whose brief was "so you can figure all out"
      // could not answer whether a single break had ever happened.
      const score = (e.total > 0) ? ` ${e.correct}/${e.total}` : '';
      const paid = Object.entries(e.reward || {}).filter(([, a]) => a > 0)
        .map(([r, a]) => `${a} ${r}`).join(' + ');
      if (e.kind === 'declined') return `  STUDY declined after rung ${e.step} (streak ended)`;
      return `  STUDY ${e.act || 'session'}${score} — rung ${e.step} x${e.mult}`
        + `${e.auto ? ' (opened)' : ''}${paid ? ` → ${paid}` : ''}`;
    }
    case 'diplomacy':
      return `  DIPLOMACY ${e.text}`;
    case 'note':
      return `  ${e.text}`;
    default:
      return `  ${e.t} ${JSON.stringify(e)}`;
  }
}

/**
 * The whole book as plain text, newest last — the thing to hand to somebody who was not
 * at the table. Grouped by day so a position and the events that followed it read
 * together, the way a chess score does.
 */
export function chronicleText(state) {
  const entries = chronicleEntries(state);
  const out = [];
  out.push(`JMA3 chronicle — seed ${state.seed}, day ${state.day}, week ${weekOf(state.day)}`);
  const feats = Object.entries(state.features || {}).filter(([, v]) => v).map(([k]) => k);
  out.push(`setup: ${state.players?.length || 0} realms, map ${state.map?.w}x${state.map?.h}, `
    + `pacing ${state.pacing || 'classic'}, wildGrowth ${state.wildGrowth !== false}, `
    + `pveScaling ${state.pveScaling !== false} @${state.tideHardness}`);
  out.push(`features: ${feats.length ? feats.join(', ') : 'none'}`);
  if (state.chronicle?.dropped) {
    out.push(`(${state.chronicle.dropped} earlier entries rolled off the ring buffer)`);
  }
  out.push('');

  let day = null;
  for (const e of entries) {
    if (e.d !== day) { day = e.d; out.push(`── day ${day} (week ${Math.floor((day - 1) / CONFIG.DAYS_PER_WEEK) + 1}) ──`); }
    if (e.t === 'day') {
      for (const r of e.realms) out.push(...realmLines(r));
      const g = gaugeLine(e.g);
      if (g) out.push(g);
    } else {
      out.push(eventLine(e));
    }
  }
  return out.join('\n');
}

/** The raw entries, for anything that would rather parse than read. */
export function chronicleJson(state) {
  return JSON.stringify({
    seed: state.seed,
    day: state.day,
    setup: {
      realms: state.players?.length || 0,
      map: [state.map?.w, state.map?.h],
      pacing: state.pacing || 'classic',
      wildGrowth: state.wildGrowth !== false,
      pveScaling: state.pveScaling !== false,
      tideHardness: state.tideHardness,
      features: state.features || {},
    },
    dropped: state.chronicle?.dropped || 0,
    entries: chronicleEntries(state),
  }, null, 1);
}
