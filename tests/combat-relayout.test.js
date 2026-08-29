/**
 * combat-relayout.test.js — the battlefield must follow the canvas.
 *
 * Reported as "when I attack a creature half the screen becomes dark and no
 * animation happens; it can stay like that for hours; Escape clears it and I can
 * play on". Reproduced in a real Chromium on the reported seed: the battle was
 * running perfectly — round 1, three units, an archer waiting on input — but
 * CombatScene had no resize handler, so it kept the geometry it was built with.
 * Measured content coverage of the canvas:
 *
 *     built at 1280x800, then resized      3440x1440 -> 56% x 57%
 *     opened directly at 3440x1440                  -> 150% x 101%
 *
 * The same battle fills the canvas when opened at that size and occupies a corner
 * of it when the window changed afterwards. Everything else — map, town, hero,
 * HUD, menu — already re-laid out on resize; only the battlefield did not.
 *
 * The first fix redrew in place and leaked: 32 game objects grew to 188 over six
 * size changes, because every draw pass creates a fresh set without clearing the
 * last. So the relayout destroys and rebuilds, which is what TownScene does.
 *
 * Phaser scenes cannot run headlessly, so these are static guards on the source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (n) => readFileSync(new URL(`../src/scenes/${n}.js`, import.meta.url), 'utf8');
const src = read('CombatScene');

test('CombatScene listens for resize and lets go on shutdown', () => {
  assert.match(src, /this\.scale\.on\('resize', this\.relayout, this\)/,
    'without this the battlefield keeps the size it was born at');
  assert.match(src, /this\.scale\.off\('resize', this\.relayout, this\)/,
    'a listener that outlives the scene leaks and fires into a dead scene');
});

test('relayout REBUILDS rather than redrawing over the top', () => {
  const fn = src.slice(src.indexOf('  relayout() {'));
  const body = fn.slice(0, fn.indexOf('\n  /**', 1));
  assert.match(body, /destroyAllChildren\(this\)/,
    'redrawing in place leaked 26 objects per resize');
  assert.match(body, /this\.unitSprites = new Map\(\)/,
    'the sprite map must be cleared with the sprites it points at, or it holds dead refs');
  // The rebuild must be complete: geometry, art, units and chrome.
  for (const step of ['computeLayout', 'drawBackdrop', 'drawGrid', 'spawnUnits', 'buildHUD', 'refreshUnits']) {
    assert.match(body, new RegExp(`this\\.${step}\\(`), `relayout must re-run ${step}()`);
  }
});

test('relayout rebuilds the field AS IT IS: no dead stacks, no breached walls (S11/S25)', () => {
  // Both builders run mid-battle from relayout(), over engine state that keeps
  // its dead: battle.units holds every corpse on the hex it fell on, and a
  // breached wall segment stays in battle.walls with alive=false (the engine
  // only flags it). Without an alive filter a resize popped every destroyed
  // stack back at full alpha (count label 0, possibly under a live stack that
  // had since taken the hex) for refreshUnits to fade out all over again, and
  // rebuilt full-opacity masonry over a breach the attackers then appeared to
  // walk straight through — contradicting the log's own "smashes the gate to
  // rubble". refreshUnits always had the filter for mid-battle arrivals; these
  // two builders are pinned here so they cannot lose theirs again.
  const spawn = src.slice(src.indexOf('  spawnUnits() {'));
  const spawnBody = spawn.slice(0, spawn.indexOf('\n  }'));
  assert.match(spawnBody, /if \(!u\.alive\) continue;/,
    'spawnUnits must spawn the living only — the dead have no sprite to resurrect on resize');
  const forts = src.slice(src.indexOf('  drawFortifications() {'));
  const fortsBody = forts.slice(0, forts.indexOf('\n  }\n'));
  assert.match(fortsBody, /if \(!w\.alive\) continue;/,
    'drawFortifications must skip breached segments — the engine treats them as rubble');
});

test('relayout never disturbs a battle it cannot safely rebuild', () => {
  const fn = src.slice(src.indexOf('  relayout() {'));
  const body = fn.slice(0, fn.indexOf('\n  /**', 1));
  assert.match(body, /if \(!this\.battle \|\| this\.finished\) return;/,
    'no battle, or an ended one, has nothing to lay out');
  assert.match(body, /if \(modalOpen\(\)\) return;/,
    'a dialog is anchored to the old geometry — rebuilding under it strands it');
  assert.match(body, /catch/, 'a failed relayout must not take the battle down');
});

test('the scenes that own a full-screen layout all follow the canvas', () => {
  // Combat was the odd one out. These are the scenes a player sits inside for a
  // long time, where a resize mid-session is plausible and leaves dead space.
  for (const name of ['CombatScene', 'AdventureScene', 'AdvUIScene', 'TownScene', 'HeroScene', 'MenuScene']) {
    assert.match(read(name), /scale\.on\('resize'/, `${name} does not re-layout on resize`);
  }
});

test('relayout is a real method, not a dangling reference', () => {
  // scene-methods.test.js covers this generally; named here because the handler
  // is registered by reference and a typo would fail silently until a resize.
  assert.match(src, /^ {2}relayout\(\) \{/m, 'relayout() must be defined on the class');
});
