/**
 * autosave-resume.test.js — a half-played single-map game must be there when you
 * come back, and findable where you started it.
 *
 * Reported: "custom games do not autosave — add autosave so a half-played custom
 * game can be resumed."
 *
 * Measured in a real Chromium before changing anything: a custom game DID
 * autosave, 257 KB into the shared skirmish slot — but only from the first End
 * Turn onwards, and its only resume button lived in Play → Quick Conquest, under
 * a heading a player who came in through Custom Game has no reason to open. So it
 * was two gaps, neither of them the save format:
 *
 *   1. Nothing at all until the first day ENDED. On a 44x36 map day one is an
 *      hour of exploring, fighting and building.
 *   2. Nowhere to click. Resuming was reachable only from another mode's card.
 *
 * Fixed by saving the instant a game is created, flushing again when the player
 * leaves the page, and offering the resume on the Custom Game screen and the main
 * menu. Verified in Chromium afterwards: 256942 bytes with day: 1 and
 * kind: 'custom' before any turn ended, "▶ Resume: your custom game — Wk 1, day 1"
 * on the menu, "▶ Continue your custom game — Week 1, Day 1 · 44×36" on the
 * Custom Game screen, and the beforeunload flush persisting a mid-day change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A minimal localStorage before session.js is imported (node has none).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};

const {
  startNewGame, getState, saveGame, hasSave, savedGameSummary, clearSession, installExitSave,
} = await import('../src/game/session.js');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const fresh = (over = {}) => startNewGame({
  seed: 5,
  players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  ...over,
});

test('a new game is saved the moment it exists, not at the first dawn', async () => {
  mem.clear();
  assert.equal(hasSave(), false, 'clean slate');
  const s = fresh({ kind: 'custom' });
  assert.equal(hasSave(), true,
    'quitting during day one must not cost the whole day');
  assert.equal(savedGameSummary().day, 1);
  assert.equal(s.day, 1);
});

test('the save records which front door the game came through', async () => {
  mem.clear();
  fresh({ kind: 'custom' });
  assert.equal(getState().setupKind, 'custom');
  assert.equal(savedGameSummary().kind, 'custom',
    'the menu needs this to say "your custom game" — one slot serves both modes');

  mem.clear();
  fresh({ kind: 'conquest' });
  assert.equal(savedGameSummary().kind, 'conquest');

  mem.clear();
  fresh();
  assert.equal(getState().setupKind, null, 'an unlabelled game is still valid');
  assert.equal(savedGameSummary().kind, null, 'and old saves without the field read as null');
});

test('the summary carries the map size, so a resume button can identify the realm', async () => {
  mem.clear();
  fresh({ mapW: 40, mapH: 30, kind: 'custom' });
  const sum = savedGameSummary();
  assert.equal(sum.mapW, 40);
  assert.equal(sum.mapH, 30);
});

test('saving survives a storage that is absent or blocked', async () => {
  // Private browsing throws on access; a headless run has none at all. A save
  // must report failure, never throw into a scene.
  // Now that saving is asynchronous, "never throws" means the promise RESOLVES
  // false rather than rejecting — a rejection would surface as an unhandled
  // rejection in the browser, which is the same class of failure it always was.
  const real = globalThis.localStorage;
  mem.clear();
  await fresh();
  globalThis.localStorage = undefined;
  assert.equal(await saveGame(), false, 'no storage ⇒ reports failure, does not reject');
  globalThis.localStorage = real;
  assert.equal(await saveGame(), true, 'and works again once storage is back');
});

test('saveGame with no live session is a no-op, not a crash', async () => {
  mem.clear();
  clearSession();
  assert.equal(await saveGame(), false);
  assert.equal(hasSave(), false, 'and writes nothing');
});

test('installExitSave registers once and needs no window', async () => {
  // Node has no window: the call must be inert rather than throwing at import.
  assert.equal(installExitSave(), false, 'no window, nothing to hook');
});

test('the exit flush hooks BOTH leave events', async () => {
  const src = read('../src/game/session.js');
  const fn = src.slice(src.indexOf('export function installExitSave'));
  assert.match(fn, /beforeunload/, 'the desktop signal');
  assert.match(fn, /visibilitychange/,
    'mobile browsers kill a backgrounded tab without firing beforeunload');
  assert.match(fn, /document\.visibilityState === 'hidden'/,
    'only save on the way OUT — visibilitychange also fires on the way back in');
  assert.match(fn, /if \(exitSaveInstalled/, 'installing twice would double every write');
});

test('every front door labels its games, and the resume is offered at each', async () => {
  const custom = read('../src/scenes/CustomScenarioScene.js');
  assert.match(custom, /kind: 'custom'/, 'Custom Game must label its games');
  assert.match(custom, /Continue your \$\{what\}/, 'and offer the resume on its own screen');
  assert.match(custom, /continueSaved\(\) \{[\s\S]*loadGame\(\)/, 'which actually loads');

  // CLONE: the CampaignScene front door is not shipped (src/main.js registers 13
  // scenes, not 17), so only the Menu and Custom Game doors are checked here.

  const menu = read('../src/scenes/MenuScene.js');
  assert.match(menu, /savedGameSummary\(\)/, 'the main menu must offer the single-map resume');
  // This used to pin the literal line `if (camp || skirmish) y += 44;`, which was
  // the old screen's way of keeping both resumes on ONE row so that a second row
  // could not push Load Saved Game off an 800px window. The screen has since been
  // regrouped — Load Saved Game moved behind "More ways to play" and the resumes
  // became one Continue row at the TOP — so that exact line is gone while the
  // concern behind it is not. The concern is now structural rather than
  // arithmetic: the action block is anchored to the bottom of the viewport as
  // well as to a fraction of it, so nothing can walk off a short window whatever
  // rows are present.
  assert.match(menu, /Math\.min\(H \* 0\.72, H - 52 - lead\)/,
    'the action block must stay anchored to the bottom, or a short window clips it');
  // That both resumes share one row, and that Continue sits above Play, is
  // checked where it is actually true or false: tests/smoke/menu-smoke.mjs, in a
  // browser, against the drawn positions.
});

test('main.js installs the exit flush', async () => {
  const main = read('../src/main.js');
  assert.match(main, /import \{ installExitSave \} from '\.\/game\/session\.js';/);
  assert.match(main, /^installExitSave\(\);$/m, 'once, at boot — not per scene');
});
