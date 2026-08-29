/**
 * ui-telemetry.test.js — the usage counters, and the report read off them.
 *
 * The recording half is deliberately thin (bump an integer, push a string), so
 * what these guard is the part that would quietly mislead: the summary. A
 * simplification is going to be argued FROM this output, and a report that
 * silently drops the denominator, or mistakes "never drawn" for "never pressed",
 * would delete a control somebody uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { summarize, formatSummary, SESSION_RING, PATH_MAX } from '../src/game/uiTelemetry.js';
import { mergeDocs } from '../scripts/ui-telemetry-report.mjs';

const doc = () => ({
  v: 1,
  since: '2026-08-01',
  sessions: 10,
  rendered: { 'Menu:Play': 10, 'Menu:Battle Gym': 10, 'Menu:Sandbox Arena': 10, 'Menu:Settings': 10 },
  counts: { 'Menu:Play': 9, 'Menu:Settings': 2 },
  firstClick: { 'Menu:Play': 8, 'Menu:Settings': 1 },
  scenes: { Menu: 10, Campaign: 9, Adventure: 7 },
  paths: [
    { at: 'x', steps: ['@Menu', '!Menu:Play', '@Campaign'], toPlayMs: 4000 },
    { at: 'x', steps: ['@Menu', '!Menu:Play', '@Campaign'], toPlayMs: 6000 },
    { at: 'x', steps: ['@Menu', '!Menu:Settings'] },
  ],
});

test('a control drawn but never pressed is reported — that is the whole point', () => {
  // Clicks alone cannot find an unused control: it produces no rows, and reads
  // exactly like a control that does not exist. Only rendered-minus-clicked can.
  const s = summarize(doc());
  const ids = s.unused.map((u) => u.id);
  assert.deepEqual(ids.sort(), ['Menu:Battle Gym', 'Menu:Sandbox Arena'],
    'the cut list must contain exactly the drawn-but-never-pressed controls');
  for (const u of s.unused) assert.ok(u.shown > 0, 'an unused entry must carry how often it was shown');
});

test('a control that was never drawn is not reported as unused', () => {
  // The inverse error, and the dangerous one: a screen nobody opened during the
  // sample would otherwise list every control on it as dead weight.
  const d = doc();
  d.counts['Town:Build'] = 0; // present with a zero count, never rendered
  delete d.rendered['Town:Build'];
  const s = summarize(d);
  assert.ok(!s.unused.some((u) => u.id === 'Town:Build'),
    'never drawn is not evidence of never wanted');
});

test('the top list is ordered, shares sum to one, and totals agree', () => {
  const s = summarize(doc());
  assert.equal(s.totalClicks, 11);
  assert.equal(s.topControls[0].id, 'Menu:Play');
  const shares = s.topControls.reduce((n, c) => n + c.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9, `shares summed to ${shares}`);
  assert.equal(s.controlsSeen, 4);
  assert.equal(s.controlsUsed, 2);
});

test('first clicks are counted per session, not per press', () => {
  const s = summarize(doc());
  assert.deepEqual(s.firstClicks, [{ id: 'Menu:Play', n: 8 }, { id: 'Menu:Settings', n: 1 }]);
  assert.ok(s.firstClicks[0].n <= s.sessions, 'more first-clicks than sessions is impossible');
});

test('identical journeys group into one route', () => {
  const s = summarize(doc());
  assert.equal(s.commonRoutes[0].n, 2, 'the two identical paths must collapse');
  assert.match(s.commonRoutes[0].route, /@Menu → !Menu:Play → @Campaign/);
});

test('time-to-play reports only the sessions that reached a map', () => {
  const s = summarize(doc());
  assert.equal(s.timeToPlay.of, 10);
  assert.equal(s.timeToPlay.reached, 2, 'only two paths carry a toPlayMs');
  assert.ok(s.timeToPlay.p50 >= 4000 && s.timeToPlay.p50 <= 6000);
});

test('an empty or absent document summarises without throwing', () => {
  for (const input of [null, undefined, {}, { counts: {} }]) {
    const s = summarize(input);
    assert.equal(s.totalClicks, 0);
    assert.deepEqual(s.unused, []);
    assert.equal(s.timeToPlay.p50, null);
    assert.ok(typeof formatSummary(s) === 'string', 'the text report must survive an empty sample');
  }
});

test('merging several exports adds counters and keeps the earliest start', () => {
  const a = doc();
  const b = { ...doc(), since: '2026-07-01', counts: { 'Menu:Battle Gym': 3 } };
  const m = mergeDocs([a, b]);
  assert.equal(m.since, '2026-07-01');
  assert.equal(m.sessions, 20);
  assert.equal(m.counts['Menu:Play'], 9, 'a control only one file used keeps its count');
  assert.equal(m.counts['Menu:Battle Gym'], 3);
  assert.equal(m.paths.length, 6);
  // And the merge changes the answer, which is why it exists: one player's dead
  // control is another's favourite.
  assert.ok(!summarize(m).unused.some((u) => u.id === 'Menu:Battle Gym'),
    'a control used in ANY merged sample is not dead');
});

test('a scene entered twice in a row counts once, but twice apart counts twice', () => {
  // The seed and the SceneManager wrapper both see whatever is already up, so
  // back-to-back repeats are an artifact. Re-entering later is a real journey
  // step — a player who bounces Menu → Play → Back → Play must not read as one
  // visit to the hub.
  const d = {
    v: 1, sessions: 2, counts: {}, firstClick: {}, rendered: {}, scenes: { Menu: 2, Campaign: 2 },
    paths: [{ steps: ['@Menu', '@Campaign', '@Menu', '@Campaign'] }],
  };
  const s = summarize(d);
  assert.equal(s.scenes.find((x) => x.key === 'Menu').n, 2);
  assert.match(s.commonRoutes[0].route, /@Menu → @Campaign → @Menu/);
});

test('the store is bounded on both axes', () => {
  assert.ok(SESSION_RING > 0 && SESSION_RING <= 100, `SESSION_RING is ${SESSION_RING}`);
  assert.ok(PATH_MAX > 0 && PATH_MAX <= 200, `PATH_MAX is ${PATH_MAX}`);
});

test('nothing in the telemetry path can send data anywhere', () => {
  // The promise made to the player in settings.js and in the module header. It
  // is one grep, and it is the difference between a local counter and analytics.
  const src = readFileSync(new URL('../src/game/uiTelemetry.js', import.meta.url), 'utf8');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'navigator.sendBeacon', 'import(']) {
    assert.ok(!src.includes(bad), `uiTelemetry.js must not contain ${bad} — it is local-only`);
  }
  // The only export door is the deliberate one.
  assert.match(src, /function downloadUsage\(/);
});

test('every control the report names carries a scene prefix', () => {
  // `SceneKey:Label` is what makes a merged report readable and what the
  // start-screen section of the report script filters on.
  const s = summarize(doc());
  for (const c of [...s.topControls, ...s.unused, ...s.firstClicks]) {
    assert.match(c.id, /^[A-Za-z]+:/, `"${c.id}" has no scene prefix`);
  }
});
