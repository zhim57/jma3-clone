/**
 * uiTelemetry.js — what the player actually clicks, so the UI can be cut on
 * evidence instead of taste.
 *
 * The question it exists to answer: the title screen offers nine doors and the
 * Play hub offers three more, and nobody knows which of them anyone uses. A
 * simplification argued from taste removes whatever the arguer personally does
 * not use; a simplification argued from counts removes what nothing touches.
 *
 * LOCAL ONLY. This writes to localStorage on the player's own machine and
 * nothing sends it anywhere — there is no network call in this file and none
 * anywhere that reads it. Getting the data out is a deliberate act: the Export
 * button on Settings ▸ Advanced, or `jma3Usage()` in the console. A player who
 * wants none of it turns off Settings ▸ Advanced ▸ "Count what I click".
 *
 * THE DENOMINATOR IS THE POINT. Counting clicks alone cannot find an unused
 * control — a button nobody presses produces no rows, and reads identically to a
 * button that does not exist. So every control REGISTERS itself when it is
 * drawn, and the report subtracts: `rendered - clicked` is the list of doors
 * nobody opens, which is the actual deliverable.
 *
 * Bounded on both axes, because this rides in localStorage next to the settings
 * and must not grow without limit: counters are one small integer per control,
 * and the session paths are a ring of the last SESSION_RING journeys, each
 * capped at PATH_MAX steps.
 *
 * `summarize()` is PURE over a snapshot, so the same function serves the in-game
 * readout, the unit tests, and `scripts/ui-telemetry-report.mjs` run over an
 * exported file.
 */

import { getSetting } from './settings.js';

const KEY = 'jma3_ui_usage_v1';
const VERSION = 1;

/** How many session journeys to keep, and how many steps of each. */
export const SESSION_RING = 30;
export const PATH_MAX = 60;

/** A fresh, empty document. */
function empty() {
  return {
    v: VERSION,
    since: null,        // ISO date of the first recorded event
    sessions: 0,        // how many times the game has been opened
    counts: {},         // controlId -> times clicked
    firstClick: {},     // controlId -> times it was the FIRST click of a session
    rendered: {},       // controlId -> times drawn (the denominator)
    scenes: {},         // scene key -> times entered
    paths: [],          // ring of { at, ms, steps: [...] }
  };
}

const canStore = () => {
  try { return typeof localStorage !== 'undefined' && !!localStorage; } catch { return false; }
};

function read() {
  if (!canStore()) return empty();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.v !== VERSION) return empty();
    return { ...empty(), ...raw };
  } catch {
    return empty();
  }
}

let doc = read();
let session = null;      // { at, startedMs, steps: [] }
let dirty = false;
let flushTimer = null;

/** Recording is on unless the player turned it off. Never throws. */
function enabled() {
  try { return getSetting('uiTelemetry') !== false; } catch { return false; }
}

const nowMs = () => ((typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Date.now());

/**
 * Persist, debounced. A render draws a dozen buttons at once and each registers
 * itself; writing localStorage twelve times for one screen would be the only
 * expensive thing in here.
 */
function schedulePersist() {
  dirty = true;
  if (flushTimer || typeof setTimeout !== 'function') return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 1000);
}

export function flush() {
  if (!dirty || !canStore()) return;
  dirty = false;
  try { localStorage.setItem(KEY, JSON.stringify(doc)); } catch { /* storage full or blocked */ }
}

function stamp() {
  if (!doc.since) doc.since = new Date().toISOString().slice(0, 10);
}

function step(entry) {
  if (!session) return;
  if (session.steps.length < PATH_MAX) session.steps.push(entry);
}

/**
 * Open a journey. Called once at boot; the previous session's path is already
 * in the ring, so nothing is lost if the tab is closed without warning.
 */
export function beginSession() {
  if (!enabled()) return;
  session = { at: new Date().toISOString(), startedMs: nowMs(), steps: [] };
  doc.sessions = (doc.sessions || 0) + 1;
  doc.paths.push(session);
  while (doc.paths.length > SESSION_RING) doc.paths.shift();
  stamp();
  schedulePersist();
}

/**
 * Hard ceiling on distinct control ids per counter table. The id derivation in
 * uikit.controlId collapses value-bearing labels, but this store must stay
 * bounded even against a call site the derivation misses (it rides in
 * localStorage next to the settings). Past the cap, the LOWEST-COUNT entry is
 * evicted for the newcomer: what this module exists to find is the difference
 * between heavily-used and never-used controls, and a one-hit wonder is the
 * entry whose loss distorts that report least. Rejected: refusing new keys —
 * that silently blinds the report to every control shipped after the cap hit.
 */
export const CONTROL_KEY_CAP = 400;

/** Make room for `id` in counter table `store`, evicting if at the cap. */
function admitKey(store, id) {
  if (store[id] !== undefined) return;
  const keys = Object.keys(store);
  if (keys.length < CONTROL_KEY_CAP) return;
  let low = keys[0];
  for (const k of keys) if (store[k] < store[low]) low = k;
  delete store[low];
}

/**
 * Record that a control EXISTS, whether or not it is ever pressed. Idempotent
 * per draw — a scene that re-renders on every resize would otherwise inflate
 * this into a second, meaningless click count.
 */
export function registerControl(id) {
  if (!enabled() || !id) return;
  admitKey(doc.rendered, id);
  doc.rendered[id] = (doc.rendered[id] || 0) + 1;
  stamp();
  schedulePersist();
}

/** Record a press. `id` is `SceneKey:Label` unless a call site names its own. */
export function trackClick(id) {
  if (!enabled() || !id) return;
  admitKey(doc.counts, id);
  doc.counts[id] = (doc.counts[id] || 0) + 1;
  if (session && !session.steps.some((s) => s.startsWith('!'))) {
    // The first click of a session is the strongest signal on the screen: it is
    // what the player came for, before any of the layout has had a chance to
    // push them somewhere.
    admitKey(doc.firstClick, id);
    doc.firstClick[id] = (doc.firstClick[id] || 0) + 1;
  }
  step(`!${id}`);
  stamp();
  schedulePersist();
}

/** Record arriving at a scene, so a path reads as a journey and not a click list. */
export function trackScene(key) {
  if (!enabled() || !key) return;
  // Consecutive repeats are an artifact, not a journey: the manager wrapper and
  // the initial seed both see whatever is already on screen, and Phaser restarts
  // a scene on itself in places. Entering the same scene AGAIN later is real and
  // still counts — only back-to-back is dropped.
  if (session && session.steps[session.steps.length - 1] === `@${key}`) return;
  doc.scenes[key] = (doc.scenes[key] || 0) + 1;
  step(`@${key}`);
  if (key === 'Adventure' && session && session.toPlayMs == null) {
    // Time from opening the game to being on a map — the number that says
    // whether the front door is a doorway or a maze.
    session.toPlayMs = Math.round(nowMs() - session.startedMs);
  }
  stamp();
  schedulePersist();
}

/** The raw document, for export and for summarize(). */
export function snapshot() {
  return JSON.parse(JSON.stringify(doc));
}

export function resetUsage() {
  doc = empty();
  session = null;
  dirty = true;
  flush();
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/**
 * Turn a snapshot into the five read-outs that answer "what can we cut".
 *
 * PURE — no storage, no clock, no Phaser — so the in-game readout, the unit
 * tests and the offline report script all agree by construction.
 */
export function summarize(snap, { top = 12 } = {}) {
  const s = { ...empty(), ...(snap || {}) };
  const clicked = Object.entries(s.counts).sort((a, b) => b[1] - a[1]);
  const totalClicks = clicked.reduce((n, [, c]) => n + c, 0);

  // The deliverable: drawn at least once, never pressed. Sorted by how often it
  // was put in front of somebody, so the most-shown dead control leads.
  const unused = Object.entries(s.rendered)
    .filter(([id]) => !s.counts[id])
    .sort((a, b) => b[1] - a[1])
    .map(([id, shown]) => ({ id, shown }));

  // Where sessions actually begin.
  const firstClicks = Object.entries(s.firstClick).sort((a, b) => b[1] - a[1]);

  // The commonest journeys, collapsed to their first few steps so near-identical
  // routes group instead of each being unique.
  const routes = new Map();
  for (const p of s.paths || []) {
    const key = (p.steps || []).slice(0, 6).join(' → ') || '(nothing)';
    routes.set(key, (routes.get(key) || 0) + 1);
  }
  const commonRoutes = [...routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([route, n]) => ({ route, n }));

  // How long it takes to get from the title screen onto a map.
  const times = (s.paths || []).map((p) => p.toPlayMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const pct = (q) => (times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))] : null);
  const reachedPlay = times.length;

  return {
    since: s.since,
    sessions: s.sessions || 0,
    totalClicks,
    controlsSeen: Object.keys(s.rendered).length,
    controlsUsed: clicked.length,
    topControls: clicked.slice(0, top).map(([id, n]) => ({ id, n, share: totalClicks ? n / totalClicks : 0 })),
    unused,
    firstClicks: firstClicks.slice(0, top).map(([id, n]) => ({ id, n })),
    commonRoutes,
    scenes: Object.entries(s.scenes).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n })),
    timeToPlay: { reached: reachedPlay, of: s.sessions || 0, p50: pct(0.5), p90: pct(0.9) },
  };
}

/** The summary as plain text — the console door and the report script share it. */
export function formatSummary(sum) {
  const pctOf = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  const out = [];
  out.push(`Usage since ${sum.since || '—'} · ${sum.sessions} session(s) · ${sum.totalClicks} click(s)`);
  out.push(`Controls drawn ${sum.controlsSeen}, of which ${sum.controlsUsed} were ever pressed`);
  out.push('');
  out.push('MOST USED');
  for (const c of sum.topControls) out.push(`  ${String(c.n).padStart(5)}  ${pctOf(c.n, sum.totalClicks).padStart(4)}  ${c.id}`);
  out.push('');
  out.push('NEVER PRESSED (drawn, but never used — the cut list)');
  if (!sum.unused.length) out.push('  (none)');
  for (const c of sum.unused) out.push(`  shown ${String(c.shown).padStart(4)}×  ${c.id}`);
  out.push('');
  out.push('FIRST CLICK OF A SESSION (what people come for)');
  for (const c of sum.firstClicks) out.push(`  ${String(c.n).padStart(5)}  ${pctOf(c.n, sum.sessions).padStart(4)}  ${c.id}`);
  out.push('');
  out.push('COMMONEST ROUTES (@scene, !click)');
  for (const r of sum.commonRoutes) out.push(`  ${String(r.n).padStart(4)}×  ${r.route}`);
  out.push('');
  const t = sum.timeToPlay;
  out.push(`REACHED A MAP in ${t.reached}/${t.of} sessions`
    + (t.p50 != null ? ` · median ${(t.p50 / 1000).toFixed(1)}s, p90 ${(t.p90 / 1000).toFixed(1)}s` : ''));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Attach to the running game: one session, one listener per scene, and a flush
 * when the tab goes away.
 *
 * Scene entry is hooked here rather than in each scene because there are sixteen
 * of them and a path with a hole in it is worse than no path — a route that
 * skips the scene nobody remembered to instrument reads as a shorter journey
 * than it was.
 */
export function installUiTelemetry(game) {
  beginSession();

  // Hook the SCENE MANAGER, not each scene.
  //
  // The first cut attached a `start` listener per scene in game.scene.scenes at
  // install time, which is a race: Phaser fills that array over its first ticks,
  // so whichever scenes existed at that instant got listeners and the rest never
  // did. It looked like it worked — Boot and Menu were recorded, because they
  // were the two already up — and every later scene was silently missing, which
  // is the worst shape for this to fail in: a path with holes reads as a shorter
  // journey than the player actually walked.
  //
  // Every route into a scene goes through one of these three manager methods
  // (ScenePlugin.start/launch/run queue ops that call them), so wrapping them
  // catches all of it with no dependence on when anything was constructed.
  const mgr = game.scene;
  for (const method of ['start', 'launch', 'run']) {
    const original = mgr[method];
    if (typeof original !== 'function') continue;
    mgr[method] = function wrapped(key, ...rest) {
      if (typeof key === 'string') trackScene(key);
      return original.call(this, key, ...rest);
    };
  }
  // ...and whatever is already on screen, which the wrappers cannot have seen.
  const seed = () => {
    for (const sc of mgr.scenes || []) {
      const key = sc.scene?.key || sc.sys?.settings?.key;
      if (key && sc.scene?.isActive?.(key)) trackScene(key);
    }
  };
  if (mgr.scenes?.length) seed();
  else game.events.once('ready', seed);

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    // The console door, beside jma3Log(): print the report, and return the
    // structured summary for anyone who would rather poke at the object.
    window.jma3Usage = () => {
      const sum = summarize(snapshot());
      console.log(formatSummary(sum));
      return sum;
    };
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

/** Download the raw document, for reading with scripts/ui-telemetry-report.mjs. */
export function downloadUsage() {
  const snap = snapshot();
  if (!snap.sessions) return { ok: false, reason: 'Nothing recorded yet' };
  try {
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jma3-usage-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true, sessions: snap.sessions, clicks: Object.values(snap.counts).reduce((n, c) => n + c, 0) };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}
