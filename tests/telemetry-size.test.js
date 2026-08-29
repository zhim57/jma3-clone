/**
 * telemetry-size.test.js — the flight recorder is bounded in BYTES, not only in
 * entries, and a player's move does not wait on it.
 *
 * The ring caps how many entries the log holds and said nothing about how big
 * one is. An adventure-goal scan on a large map ranks five hundred candidates,
 * so one recorded human move weighed 33 KiB — and this log rides inside the save
 * file, which is gzipped into IndexedDB at every dawn. A sixty-week game was on
 * course to autosave a hundred megabytes, which is a slow game long before it is
 * a failed write.
 *
 * The cap is on what is STORED. Every headline number the read-outs are built on
 * — `n`, `chosenRank`, `regret`, `bestScore` — is measured over the whole
 * candidate set first, so capping the tail costs the diagnosis nothing; that is
 * what these tests pin, alongside the size itself.
 *
 * The other half is cost. recordHumanMove runs the AI's own scorer on the human's
 * board — that symmetry is the point of the whole module — and it runs
 * SYNCHRONOUSLY, between the click and the first step of the walk. It has to
 * stay cheap, and it used to clear the reach cache it had just filled, which is
 * the one thing guaranteed to make it expensive.
 *
 * And the third round of the same lesson: CANDIDATE_MAX bounded one entry and
 * TELEMETRY_MAX bounded the count, but their PRODUCT still put ~15 MB of raw
 * telemetry into a day-200 save — 92% of the file. So the save now carries only
 * the newest TELEMETRY_SAVE_BYTES of the ring (telemetryForSave, applied by
 * GameState.serialize), while the session keeps everything for the in-game
 * export and the headless harnesses. The window tests below pin that split.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  decision, record, CANDIDATE_MAX, TELEMETRY_MAX, TELEMETRY_SAVE_BYTES, telemetryForSave,
} from '../src/ai/telemetry.js';
import { newGame, serialize, deserialize } from '../src/core/GameState.js';

/** A scan of `n` candidates, best first by construction (score = n - i). */
function scan(n, chosenIndex) {
  return decision({
    phase: 'adventure',
    channel: 'goal',
    actor: 0,
    human: true,
    candidates: Array.from({ length: n }, (_, i) => ({
      label: `goal @${i},${i}`, score: n - i, terms: { x: i, y: i },
    })),
    chosenIndex,
  });
}

test('a decision stores a bounded slice of a huge candidate set', () => {
  const e = scan(500, 0);
  assert.ok(e.candidates.length <= CANDIDATE_MAX + 1,
    `stored ${e.candidates.length} candidates; the cap is ${CANDIDATE_MAX} (+ the chosen one)`);
  assert.equal(e.n, 500, 'the true size of the scan is still reported');
  assert.equal(e.truncated, 500 - e.candidates.length, 'and the drop is stated, not silent');
});

test('a small scan is stored whole, with no truncation marker', () => {
  const e = scan(5, 2);
  assert.equal(e.candidates.length, 5);
  assert.equal(e.n, 5);
  assert.equal(e.truncated, undefined);
});

test('the ranking that is kept is the TOP of the ranking', () => {
  const e = scan(200, 0);
  const kept = e.candidates.map((c) => c.score);
  const sorted = [...kept].sort((a, b) => b - a);
  assert.deepEqual(kept.filter((s) => s !== undefined), kept, 'no holes');
  assert.equal(sorted[0], 200, 'the best candidate survives');
  // Everything kept outscores everything dropped (the chosen one aside).
  const floor = Math.min(...kept);
  assert.ok(floor >= 200 - CANDIDATE_MAX, `kept a candidate scoring ${floor}, below the top ${CANDIDATE_MAX}`);
});

test('the chosen candidate is kept however far down the ranking it sat', () => {
  // A human walking somewhere the AI rated 400th is the single most interesting
  // row in the file — humanRank is the headline number of the whole system — and
  // an entry whose own choice had been dropped would be unreadable.
  const e = scan(500, 480);
  assert.equal(e.chosen, 'goal @480,480');
  assert.ok(e.candidates.some((c) => c.label === 'goal @480,480'), 'the chosen row is stored');
  assert.equal(e.chosenRank, 480, 'and its rank is measured against the whole scan');
});

test('rank, regret and best score are measured over the whole scan, not the stored slice', () => {
  const e = scan(500, 300);
  assert.equal(e.bestScore, 500, 'best is the best of 500, not of the kept slice');
  assert.equal(e.chosenScore, 200);
  assert.equal(e.regret, 300, 'regret is against the true argmax');
  assert.equal(e.chosenRank, 300);
});

test('a long game\'s log stays a sane size', () => {
  const state = { day: 1, telemetry: [] };
  for (let i = 0; i < 400; i++) record(state, scan(500, i % 500));
  const bytes = JSON.stringify(state.telemetry).length;
  const perEntry = bytes / state.telemetry.length;
  assert.ok(perEntry < 3000,
    `${Math.round(perEntry)} bytes per recorded decision — the log rides inside the save`);
});

test('the ring still bounds the entry count, and trims from the front', () => {
  const state = { day: 1, telemetry: [] };
  for (let i = 0; i < TELEMETRY_MAX + 50; i++) record(state, { phase: 'economy', kind: 'economy', i });
  assert.equal(state.telemetry.length, TELEMETRY_MAX);
  assert.equal(state.telemetry[0].i, 50, 'the OLDEST entries are the ones dropped');
  assert.equal(state.telemetry[state.telemetry.length - 1].i, TELEMETRY_MAX + 49);
});

test('scoring the human\'s move keeps the reach cache it just built', () => {
  // Clearing _reachCache after seeding it made every reachability question
  // inside the scan recompute from scratch, so the diagnostic cost several
  // times the decision it was measuring — and the player waited for it,
  // between clicking a destination and their hero taking a step.
  const src = readFileSync(new URL('../src/ai/adventureTelemetry.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function recordHumanMove'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/_reachCache\s*=\s*new Map\(\)/.test(body),
    'recordHumanMove must not clear the reach cache (the controller starts with a fresh one)');
  assert.ok(!/_throughCache\s*=\s*new Map\(\)/.test(body),
    'recordHumanMove must not clear the connector cache either');
  assert.ok(/floodCached/.test(body) && /pickGoal/.test(body),
    'it still floods and still runs the AI\'s own scorer — the symmetry is the point');
});

// ---------------------------------------------------------------------------
// The save window — the byte bound that was actually wanted
// ---------------------------------------------------------------------------

test('a save carries at most TELEMETRY_SAVE_BYTES of the log — the newest suffix of it', () => {
  const state = newGame({ seed: 31 });
  // Enough wide entries to overflow the window several times over.
  for (let i = 0; i < 700; i++) record(state, scan(500, i % 500));
  const inMemory = state.telemetry.length;
  assert.equal(inMemory, 700, 'the session ring is NOT trimmed — export and harnesses see everything');

  const saved = JSON.parse(serialize(state)).telemetry;
  // The per-entry accounting (entry JSON + 1 separator) tracks the in-save
  // array form to within its two brackets.
  assert.ok(JSON.stringify(saved).length <= TELEMETRY_SAVE_BYTES + 2,
    `the saved log weighs ${JSON.stringify(saved).length} bytes against a ${TELEMETRY_SAVE_BYTES} budget`);
  assert.ok(saved.length < inMemory, 'so the oldest entries stayed behind');
  assert.equal(saved[saved.length - 1].seq, state.telemetry[inMemory - 1].seq,
    'and the newest entry is always the one that rides — a save diagnoses what JUST happened');
  // A pure suffix, nothing reordered or rewritten: what is saved is exactly the
  // tail of what was recorded, so a loaded log reads like a truncated JSONL file.
  assert.deepEqual(saved, JSON.parse(JSON.stringify(state.telemetry.slice(-saved.length))));
});

test('a trimmed save still round-trips byte-stably', () => {
  // The property the whole save layer leans on: serialize → deserialize →
  // serialize is a fixed point. A window that already fits is passed through
  // untouched, so the second serialize must not trim again.
  const state = newGame({ seed: 32 });
  for (let i = 0; i < 700; i++) record(state, scan(500, i % 500));
  const s1 = serialize(state);
  const s2 = serialize(deserialize(s1));
  assert.equal(s1, s2, 'loading a windowed save and saving again changes nothing');
});

test('a log that fits rides whole, and a game that never recorded saves no log at all', () => {
  const state = newGame({ seed: 33 });
  assert.ok(!('telemetry' in JSON.parse(serialize(state))),
    'no recording, no key — byte-identical to what serialize wrote before the window existed');
  for (let i = 0; i < 3; i++) record(state, scan(5, 0));
  const saved = JSON.parse(serialize(state)).telemetry;
  assert.deepEqual(saved, JSON.parse(JSON.stringify(state.telemetry)), 'under budget, nothing is dropped');
});

test('the window function itself: absent stays absent, oversized never busts the budget', () => {
  assert.equal(telemetryForSave(null), undefined);
  assert.equal(telemetryForSave({}), undefined);
  const empty = { telemetry: [] };
  assert.equal(telemetryForSave(empty), empty.telemetry, 'an empty ring is returned as-is, not copied');
  // A single entry wider than the whole budget cannot happen under CANDIDATE_MAX,
  // but if one ever does, the bound wins over the entry: the save gets an empty
  // window rather than an unbounded one.
  const huge = { telemetry: [{ blob: 'x'.repeat(TELEMETRY_SAVE_BYTES + 1) }] };
  assert.deepEqual(telemetryForSave(huge), []);
});
