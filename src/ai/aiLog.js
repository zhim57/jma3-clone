/**
 * aiLog.js — the AI's flight recorder.
 *
 * Asked for in as many words: "you should implement a log of what the AI brain is
 * doing and why it stops flagging mines, so we can fix the issue". The point is
 * not prettier logging — it is that the AI's economy failures are INVISIBLE.
 * When a rival stops taking mines there are at least eight different reasons it
 * could be, and every one of them looks identical from the outside: a hero that
 * does nothing.
 *
 * So the recorder answers three questions, and nothing else:
 *
 *   1. WHAT did each hero decide this turn?      → one `hero` entry per hero
 *   2. WHY was every prize it did NOT take out?  → the veto tally on that entry
 *   3. WHAT did the realm do with its towns?     → `town` entries
 *
 * The veto tally is the whole design. Goal scoring rejects a candidate at one of
 * a handful of gates (see AIPlayer.pickGoal), and each gate has a name:
 *
 *   menaced      — inside a superior enemy army's strike range: "safe loot only"
 *   guarded      — a monster/hero guard we cannot beat by the courage margin
 *   unreachable  — no walkable route (a far-side pocket, a sea, a wall)
 *   blacklisted  — a path was already tried and failed this turn
 *   avoided      — inside this hero's stuck-avoidance zone
 *   spent        — a booster with nothing left to give this hero
 *
 * "Every mine on the map was vetoed as `menaced` for nine straight days" is a
 * diagnosis. "The AI is not flagging mines" is not.
 *
 * Storage: a bounded ring on `state.aiLog`, so it round-trips a save like any
 * other plain data (no version bump — every reader takes `state.aiLog ?? []`).
 * It is pure diagnostics: nothing in the rule engine ever reads it back, and it
 * draws no rng, so a game plays byte-identically whether or not it is recording.
 */

/** How many entries the ring holds. ~3 turns of a busy 4-realm map. */
export const AI_LOG_MAX = 600;

/** Append one entry. `state.day` is stamped here so callers never have to. */
export function aiLog(state, entry) {
  if (!state) return null;
  const log = (state.aiLog ||= []);
  log.push({ day: state.day, ...entry });
  while (log.length > AI_LOG_MAX) log.shift();
  return log[log.length - 1];
}

/** Every entry, newest last. Optionally narrowed to one realm and/or one day. */
export function aiLogEntries(state, { player = null, day = null, kind = null } = {}) {
  let out = state?.aiLog || [];
  if (player != null) out = out.filter((e) => e.player === player);
  if (day != null) out = out.filter((e) => e.day === day);
  if (kind != null) out = out.filter((e) => e.kind === kind);
  return out;
}

/** The most recent day this realm was recorded acting on, or null. */
export function lastAiDay(state, player) {
  const mine = aiLogEntries(state, { player });
  return mine.length ? mine[mine.length - 1].day : null;
}

const VETO_WORDS = {
  menaced: 'in an enemy army\'s reach',
  guarded: 'guarded too heavily',
  unreachable: 'no route',
  blacklisted: 'path already failed today',
  avoided: 'inside a stuck-avoidance zone',
  gaveUp: 'shelved after making no progress',
  noRoom: 'no room in the army for it',
  spent: 'nothing left to give',
  owned: 'already ours',
  worthless: 'priced at nothing',
};

/** Why a hero changed its goal (see AIPlayer.noteGoal). */
const GOAL_WORDS = {
  first: 'first goal',
  achieved: 'goal achieved',
  gone: 'old goal off the board',
  outbid: 'outbid by the margin',
  stalled: 'no progress — gave up',
  hold: 'holding the town instead',
};

/** A veto tally → "menaced ×7, guarded ×2", biggest first. Empty string if none. */
export function vetoText(vetoes = {}) {
  return Object.entries(vetoes)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${VETO_WORDS[why] || why} ×${n}`)
    .join(', ');
}

/**
 * Render the log as flat, human-readable lines — what the in-game viewer shows
 * and what a headless sim prints. Newest FIRST, because the last turn is the one
 * being diagnosed. `limit` bounds the output; pass a `player` to isolate a realm.
 */
export function aiLogLines(state, { player = null, limit = 60 } = {}) {
  const entries = aiLogEntries(state, { player });
  const lines = [];
  for (let i = entries.length - 1; i >= 0 && lines.length < limit; i--) {
    const e = entries[i];
    const who = e.name || `P${e.player}`;
    if (e.kind === 'turn') {
      lines.push(`── Day ${e.day} · ${who} · ${e.towns}t ${e.heroes}h · ${e.gold}g · `
        + `army ${e.bestArmy} vs strongest foe ${e.strongestFoe} · mines held ${e.minesHeld}/${e.minesOnMap}`);
      if (e.minesFlagged) lines.push(`   ✔ flagged ${e.minesFlagged} mine${e.minesFlagged === 1 ? '' : 's'} this turn`);
    } else if (e.kind === 'hero') {
      const goal = e.goal ? `→ ${e.goal.what} (score ${e.goal.score}, ${e.goal.dist} tiles)` : `→ ${e.decision}`;
      lines.push(`   ${e.hero} [army ${e.army}] ${goal}`);
      const v = vetoText(e.vetoes);
      if (v) lines.push(`      passed over ${e.vetoed} prize${e.vetoed === 1 ? '' : 's'}: ${v}`);
      if (e.mines) {
        lines.push(`      mines in view: ${e.mines.seen} unclaimed, ${e.mines.considered} viable`
          + (e.mines.seen && !e.mines.considered ? '  ← NONE viable' : ''));
      }
    } else if (e.kind === 'goal') {
      // A goal CHANGE. The pair of scores is the point: a switch where the old
      // goal's live score is within a whisker of the new one's is an oscillation
      // in the making, and that is exactly what "outbid" days look like.
      const from = e.from ? `${e.from} (${e.fromScore})` : 'nothing';
      lines.push(`   ${e.hero} goal: ${from} → ${e.to} (${e.toScore}, ${e.dist} tiles) · ${GOAL_WORDS[e.reason] || e.reason}`);
    } else if (e.kind === 'town') {
      lines.push(`   ⌂ ${e.town}: ${e.what}`);
    } else if (e.kind === 'note') {
      lines.push(`   · ${e.text}`);
    }
  }
  return lines;
}

/**
 * The one-line verdict a player actually wants: is this realm's economy moving,
 * and if not, what is stopping it? Reads the most recent recorded turn.
 */
export function aiDiagnosis(state, player) {
  const day = lastAiDay(state, player);
  if (day == null) return 'No AI turn has been recorded yet.';
  const turn = aiLogEntries(state, { player, day, kind: 'turn' }).pop();
  const heroes = aiLogEntries(state, { player, day, kind: 'hero' });
  if (!turn) return 'No AI turn has been recorded yet.';
  if (turn.minesFlagged > 0) return `Economy moving: ${turn.minesFlagged} mine(s) flagged on day ${day}.`;
  if (!turn.heroes) return `No heroes in the field on day ${day} — nothing can flag anything.`;

  // Which gate rejected the most mines across every hero this turn? That is the
  // answer to "why did it stop", and it is nearly always exactly one gate.
  const tally = {};
  let sawMines = 0;
  for (const h of heroes) {
    sawMines += h.mines?.seen || 0;
    for (const [why, n] of Object.entries(h.mineVetoes || {})) tally[why] = (tally[why] || 0) + n;
  }
  if (!sawMines) return `No unclaimed mine was in view on day ${day} — the map is flagged out.`;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (!top) return `Mines were in view on day ${day} but something outranked them.`;
  return `Day ${day}: ${sawMines} unclaimed mine(s) in view, none taken — mostly `
    + `${VETO_WORDS[top[0]] || top[0]} (${top[1]}).`;
}
