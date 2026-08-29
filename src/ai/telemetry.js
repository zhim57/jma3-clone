/**
 * telemetry.js — the flight recorder, for BOTH sides.
 *
 * The brain log (ai/aiLog.js) answers "what did the AI decide". This answers the
 * harder question: "what was it choosing BETWEEN, and why did the winner win".
 *
 * The framing that produced it: the AI is a square wheel. It does not roll badly
 * at random — it fails at four specific corners, and a log of MOVES cannot find
 * them. A move tells you what happened; a scored candidate SET tells you what the
 * alternatives were worth, and a wrong choice then decomposes into exactly one of
 * three defects:
 *
 *   · a MISSING CANDIDATE   — the right move was never in the list
 *   · a MIS-WEIGHTED TERM   — it was in the list and scored too low
 *   · a TERM READING THE WRONG QUANTITY — the score is right but the input isn't
 *
 * Only the decomposition distinguishes those, so every decision carries its
 * candidates, each candidate carries its term breakdown, and each carries the
 * softmax probability it was sampled at. That last one separates two failures
 * that look identical from outside: "scored the third-best option highest" is a
 * weighting bug; "picked the third-best option at 22% probability" is deliberate
 * exploration noise doing damage.
 *
 * SYMMETRY is the point. The human's moves are logged through the SAME evaluator,
 * because a rival's choice cannot be called bad without knowing what a good one
 * looked like in that position. Every human action carries the rank the AI's own
 * scoring gave it — so when a player reliably picks what the AI scored fifth, the
 * defect is in the evaluation, not in the play. `humanRank` is the headline
 * number of the whole system.
 *
 * Three read-outs, and the third is what actually finds corners:
 *   1. per-decision candidate scoring        → diagnosis of a single choice
 *   2. per-battle summary                    → which battles went wrong
 *   3. aggregate across many battles         → a corner seen once is noise; one
 *                                              seen in 30% of engagements is real
 *
 * Storage: a bounded ring on `state.telemetry`, plain data, so it round-trips a
 * save with no version bump. Exported as JSONL — one object per line, so it is
 * greppable, streamable, and survives being truncated. Nothing in the rule engine
 * ever reads it back and it draws no rng: recording never changes play.
 *
 * What the SAVE carries is smaller than what the session holds — see
 * TELEMETRY_SAVE_BYTES. In memory the ring keeps the whole session (up to
 * TELEMETRY_MAX entries) so the in-game export and the headless harnesses see
 * everything; the save file gets only the most recent TELEMETRY_SAVE_BYTES of
 * it, because the save is the one place this log's size is a cost every player
 * pays at every dawn, diagnosing or not.
 */

/** Ring size — the ENTRY bound, which is really a bound on the O(n) readers
 *  (events/aggregate scan the whole ring). The bound that protects the SAVE is
 *  TELEMETRY_SAVE_BYTES below: this count alone let the save grow to ~15 MB raw
 *  (20,000 × ~780 bytes), which is why entries were the wrong unit to cap in. */
export const TELEMETRY_MAX = 20000;

/**
 * How much of the log a SAVE carries: the most recent ~512 KiB of entries,
 * measured as serialized JSON. This is the third size lesson this module has
 * had to learn, and the one that states the property actually wanted: a long
 * run must not grow the save without limit — in BYTES, because bytes are what
 * localStorage quotas, IndexedDB writes and the dawn autosave's main-thread
 * gzip are paid in. TELEMETRY_MAX bounded the entry count and CANDIDATE_MAX
 * bounded one entry's width, but their product still reached ~15 MB raw
 * (~1.3 MB gzipped) around day 200 of a large 4-realm game — 92% of the save
 * file spent on a diagnostic the rule engine never reads back, handed to a
 * localStorage fallback whose whole-origin ceiling is ~5 MB.
 *
 * WHY THE CAP IS AT SERIALIZE TIME, NOT AT RECORD TIME. Trimming inside
 * record() would bound memory too, but it silently truncates every in-process
 * reader: the telemetry harness (scripts/telemetry/battles.mjs) aggregates
 * across a whole run, and the in-game export exists to hand over EVERYTHING
 * the session saw. Neither pays the save's cost, so neither should pay its
 * bound. The session keeps its full ring; only the copy that rides the save is
 * windowed — which is exactly where the measured problem lived, and it makes
 * the persisted log deterministic across a save/reload (the window is a pure
 * suffix, so a resumed game and a never-saved game converge on the same bytes).
 *
 * WHY 512 KiB. Measured on the largest shipped preset (88×72, 4 realms, 2v2):
 * entries run ~780 bytes and ~98 land per day, so the window holds ~670
 * entries ≈ the last game week — battle.start seeds included, so every
 * decision in it is still replayable from the save alone. It gzips to ~45 KB
 * against the world's flat ~111 KB, and it keeps the worst-case plain-text
 * localStorage rung (which stores UTF-16, so ~2× raw) as viable as it was
 * before this log existed. 256 KiB was rejected as too tight a window for a
 * packed map (~3½ days); 1 MiB gzips to ~90 KB, letting debug data approach
 * parity with the world again. Dropping the log from the save entirely was
 * rejected because a bug report that arrives as a save is the log's whole
 * reason to be persisted; recording opt-in was rejected for the reason the
 * opt-out exists: nobody turns a flight recorder on before the crash, and at a
 * bounded ~40 KB (CPU measured free — 116.0s recording vs 116.9s not, over 160
 * turns) the default-on cost is now one a save can afford.
 */
export const TELEMETRY_SAVE_BYTES = 512 * 1024;

/**
 * The slice of the log a save carries: the longest SUFFIX of the ring that fits
 * TELEMETRY_SAVE_BYTES. Newest entries win because a save is attached to a bug
 * report about what just happened; the aggregate over a loaded save covers this
 * window (the full-session aggregate belongs to the session that recorded it).
 *
 * Called by GameState.serialize. Costs one JSON.stringify per entry over the
 * window only — the walk is from the back and stops at the budget, so a huge
 * ring does not make saving O(ring). Returns the array untouched when it
 * already fits (no copy on the common path), and `undefined` stays `undefined`
 * so a state that never recorded keeps no `telemetry` key in its save.
 *
 * Entry cost is measured as the JSONL cost (entry JSON + 1 for the separator),
 * which tracks the in-save array form to within a byte per entry — this is a
 * bound on growth, not a quota to fill exactly.
 */
export function telemetryForSave(state) {
  const log = state?.telemetry;
  if (!log || !log.length) return log;
  let bytes = 0;
  let i = log.length;
  while (i > 0) {
    const cost = JSON.stringify(log[i - 1]).length + 1;
    if (bytes + cost > TELEMETRY_SAVE_BYTES) break;
    bytes += cost;
    i -= 1;
  }
  return i === 0 ? log : log.slice(i);
}

/**
 * How many scored candidates one decision stores.
 *
 * The ring bounds the number of ENTRIES but said nothing about their size, and
 * an adventure-goal scan on a large map ranks five hundred candidates — 33 KiB
 * per entry, in a log that rides inside the save file and is gzipped into
 * IndexedDB at every dawn. A sixty-week game therefore autosaved a
 * hundred-megabyte blob, which is a slow game long before it is a failed write.
 *
 * The headline numbers are all computed over the FULL set before this cap
 * applies — `n` is the true candidate count, and `chosenRank`, `regret` and
 * `bestScore` are measured against every option that was on the table. What the
 * cap drops is the long tail of the ranking, which no read-out consults; the
 * top of the ranking and the chosen option are always kept, and `truncated`
 * says so, so a short list is never mistaken for a short scan.
 */
export const CANDIDATE_MAX = 16;

/** Recording is ON unless a game explicitly turned it off (`state.telemetryOff`).
 *  Opt-OUT rather than opt-in: the whole point is to have the log when something
 *  odd happens, and nobody turns it on beforehand. */
export function telemetryEnabled(state) {
  return !!state && state.telemetryOff !== true;
}

export function setTelemetry(state, on) {
  if (state) state.telemetryOff = !on;
  return telemetryEnabled(state);
}

/**
 * Append one event. Stamps a monotonic sequence number and the day, so a JSONL
 * file re-orders correctly however it was concatenated.
 */
export function record(state, entry) {
  if (!telemetryEnabled(state) || !entry) return null;
  const log = (state.telemetry ||= []);
  const e = { seq: (state.telemetrySeq = (state.telemetrySeq || 0) + 1), day: state.day, ...entry };
  log.push(e);
  // Trimmed in one splice rather than a shift per push: shifting a 20,000-entry
  // array re-indexes the whole thing on every single recorded decision.
  if (log.length > TELEMETRY_MAX) log.splice(0, log.length - TELEMETRY_MAX);
  return e;
}

/** Events, optionally narrowed. `phase`: adventure | combat | economy. */
export function events(state, { phase = null, kind = null, actor = null, battleId = null } = {}) {
  let out = state?.telemetry || [];
  if (phase) out = out.filter((e) => e.phase === phase);
  if (kind) out = out.filter((e) => e.kind === kind);
  if (actor != null) out = out.filter((e) => e.actor === actor);
  if (battleId) out = out.filter((e) => e.battleId === battleId);
  return out;
}

/**
 * Build a decision event from a scored candidate set.
 *
 * `candidates` are `{ label, score, terms }`; `chosenIndex` is what was actually
 * taken. Everything derived — rank, regret, the softmax probabilities — is
 * computed HERE rather than at the call sites, so every decision in the file is
 * comparable no matter which subsystem emitted it.
 *
 * `temperature` (when the caller uses a softmax) turns the scores into the
 * probabilities the sampler actually saw; without it the probability fields are
 * omitted rather than invented.
 */
export function decision({
  phase, channel, actor, human = false, unit = null, subject = null, battleId = null,
  candidates = [], chosenIndex = 0, temperature = null, nearFloor = null,
  fallback = null, note = null, extra = null,
}) {
  const cands = candidates.map((c) => ({
    label: c.label,
    score: round4(c.score),
    ...(c.terms ? { terms: roundTerms(c.terms) } : {}),
  }));
  // Rank by score, so `chosenRank` reads "the Nth best thing on the table".
  const order = cands.map((c, i) => i).sort((a, b) => cands[b].score - cands[a].score);
  const rankOf = new Map(order.map((idx, rank) => [idx, rank]));
  const bestScore = cands.length ? cands[order[0]].score : 0;
  const chosen = cands[chosenIndex] || null;

  // Softmax probabilities, when the caller sampled. Mirrors CombatAI's
  // softmaxNearBest exactly (same floor, same temperature) so a logged
  // probability is the one the sampler really used, not a re-derivation.
  if (temperature != null && cands.length > 1 && bestScore > 0) {
    const floor = nearFloor != null ? nearFloor : -Infinity;
    const pool = cands.filter((c) => c.score > 0 && c.score >= floor);
    if (pool.length > 1) {
      const T = Math.max(1e-6, temperature);
      const w = pool.map((c) => Math.exp((c.score - bestScore) / T));
      const total = w.reduce((a, b) => a + b, 0) || 1;
      pool.forEach((c, i) => { c.p = round4(w[i] / total); });
    }
  }

  // Everything above is measured over the whole candidate set; only what is
  // STORED is capped (see CANDIDATE_MAX). Keep the top of the ranking, and the
  // chosen option whatever its rank — a decision whose own candidate had been
  // dropped would be unreadable, which is the one thing the log must never be.
  const keep = new Set(order.slice(0, CANDIDATE_MAX));
  if (chosen) keep.add(chosenIndex);
  const keptCandidates = cands.filter((_, i) => keep.has(i));

  return {
    phase,
    kind: 'decision',
    channel,
    actor,
    human: !!human,
    // Explicitly threaded, not spread: an unlisted field passed to a destructuring
    // signature is silently dropped, and dropping THIS one severs every combat
    // decision from the battle it belongs to. (The aggregate caught it — battles
    // reported zero casts while the decision stream showed 180.)
    ...(battleId ? { battleId } : {}),
    ...(unit ? { unit } : {}),
    ...(subject ? { subject } : {}),
    chosen: chosen ? chosen.label : null,
    chosenScore: chosen ? chosen.score : null,
    chosenRank: chosen ? rankOf.get(chosenIndex) : null,
    chosenP: chosen && chosen.p != null ? chosen.p : null,
    // How much score the choice gave up against the argmax. Zero for a plain
    // argmax pick; positive means either sampling noise or a human doing
    // something the evaluator does not rate — and those two are told apart by
    // the `human` flag, which is the whole reason both sides are logged.
    regret: chosen ? round4(bestScore - chosen.score) : null,
    bestScore: round4(bestScore),
    n: cands.length,
    candidates: keptCandidates,
    ...(keptCandidates.length < cands.length ? { truncated: cands.length - keptCandidates.length } : {}),
    ...(fallback ? { fallback } : {}),
    ...(note ? { note } : {}),
    ...(extra || {}),
  };
}

const round4 = (n) => (Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : n);
function roundTerms(t) {
  const out = {};
  for (const [k, v] of Object.entries(t)) out[k] = typeof v === 'number' ? round4(v) : v;
  return out;
}

/** JSONL — one object per line. Greppable, streamable, truncation-tolerant. */
export function toJSONL(state, filter = {}) {
  return events(state, filter).map((e) => JSON.stringify(e)).join('\n');
}

/**
 * The corner-finder: roll the whole log up into the handful of numbers that say
 * where the wheel is flat. A corner that appears once is noise; one that appears
 * in a third of engagements is a corner.
 */
export function aggregate(state) {
  const all = state?.telemetry || [];
  const decisions = all.filter((e) => e.kind === 'decision');
  const battles = all.filter((e) => e.kind === 'battle.end');

  const byChannel = {};
  for (const d of decisions) {
    const c = (byChannel[d.channel] ||= {
      n: 0, human: 0, ai: 0,
      // The three shapes of a missing candidate, which is the failure a move log
      // can never show: nothing scored at all, exactly one option, or a set whose
      // best option was worth nothing and the code fell through to a hard-coded
      // fallback (hold / wait / defend / nearest-enemy).
      empty: 0, single: 0, fellThrough: 0,
      offArgmax: 0, regretSum: 0, regretMax: 0,
      rank: {},
    });
    c.n++;
    if (d.human) c.human++; else c.ai++;
    if (!d.n) c.empty++;
    else if (d.n === 1) c.single++;
    if (d.fallback) c.fellThrough++;
    if (d.chosenRank > 0) {
      c.offArgmax++;
      c.regretSum += d.regret || 0;
      c.regretMax = Math.max(c.regretMax, d.regret || 0);
    }
    c.rank[d.chosenRank ?? 'na'] = (c.rank[d.chosenRank ?? 'na'] || 0) + 1;
  }
  for (const c of Object.values(byChannel)) {
    c.regretMean = c.offArgmax ? round4(c.regretSum / c.offArgmax) : 0;
    delete c.regretSum;
  }

  // THE headline. Where the human's actual move landed in the AI's own ranking.
  // A human who reliably picks what the evaluator scored fifth is not playing
  // badly — the evaluator is wrong, and this is the number that says so.
  const humanDecisions = decisions.filter((d) => d.human && d.chosenRank != null);
  const humanRank = {};
  let humanRegret = 0, humanUnscored = 0;
  for (const d of humanDecisions) {
    const bucket = d.chosenRank >= 5 ? '5+' : String(d.chosenRank);
    humanRank[bucket] = (humanRank[bucket] || 0) + 1;
    humanRegret += d.regret || 0;
    if (d.note === 'not-in-candidate-set') humanUnscored++;
  }

  const spellDecisions = decisions.filter((d) => d.channel === 'spell');
  const spellsCast = spellDecisions.filter((d) => d.chosen && d.chosen !== 'no-cast').length;

  return {
    events: all.length,
    decisions: decisions.length,
    battles: battles.length,
    byChannel,
    human: {
      decisions: humanDecisions.length,
      rank: humanRank,
      regretMean: humanDecisions.length ? round4(humanRegret / humanDecisions.length) : 0,
      // A human move the AI never even generated as an option is the single
      // strongest evidence of a missing candidate — it is a move the AI CANNOT
      // make, not one it chose against.
      notInCandidateSet: humanUnscored,
    },
    spells: {
      opportunities: spellDecisions.length,
      cast: spellsCast,
      castRate: spellDecisions.length ? round4(spellsCast / spellDecisions.length) : 0,
    },
    battleSummary: summariseBattles(battles),
  };
}

function summariseBattles(battles) {
  if (!battles.length) return null;
  const n = battles.length;
  const sum = (f) => battles.reduce((a, b) => a + (f(b) || 0), 0);
  return {
    n,
    humanWins: battles.filter((b) => b.humanWon).length,
    roundsMean: round4(sum((b) => b.rounds) / n),
    // Value traded, both directions. A side that wins every battle while losing
    // more value than it destroys is winning on army size, not on play.
    valueLostMean: [round4(sum((b) => b.valueLost?.[0]) / n), round4(sum((b) => b.valueLost?.[1]) / n)],
    spellsCastMean: [round4(sum((b) => b.spellsCast?.[0]) / n), round4(sum((b) => b.spellsCast?.[1]) / n)],
  };
}

/** A short human-readable read-out of aggregate() — what the terminal prints. */
export function aggregateLines(state) {
  const a = aggregate(state);
  const L = [];
  L.push(`events ${a.events} · decisions ${a.decisions} · battles ${a.battles}`);
  for (const [ch, c] of Object.entries(a.byChannel)) {
    L.push(`  ${ch}: ${c.n} (${c.ai} ai / ${c.human} human)`
      + `  off-argmax ${c.offArgmax} (mean regret ${c.regretMean}, max ${round4(c.regretMax)})`
      + `  empty ${c.empty} · single ${c.single} · fell-through ${c.fellThrough}`);
  }
  if (a.human.decisions) {
    const r = Object.entries(a.human.rank).sort().map(([k, v]) => `#${k}:${v}`).join(' ');
    L.push(`  HUMAN moves as ranked by the AI's own scorer — ${r}`
      + `  · mean regret ${a.human.regretMean} · not in candidate set ${a.human.notInCandidateSet}`);
  }
  if (a.spells.opportunities) {
    L.push(`  spells: cast ${a.spells.cast}/${a.spells.opportunities} (${Math.round(a.spells.castRate * 100)}%)`);
  }
  if (a.battleSummary) {
    const b = a.battleSummary;
    L.push(`  battles: ${b.n}, human won ${b.humanWins}, mean ${b.roundsMean} rounds, `
      + `value lost ${b.valueLostMean[0]} vs ${b.valueLostMean[1]}, spells ${b.spellsCastMean[0]} vs ${b.spellsCastMean[1]}`);
  }
  return L;
}
