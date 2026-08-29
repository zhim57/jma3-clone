/**
 * hero-backpack.test.js — the backpack pages; it never silently truncates.
 *
 * HeroScene is the game's ONLY equip surface, and the backpack has no cap on
 * the write side (loot, unequips and endless-realm rewards all push freely) —
 * so when buildBackpack rendered `backpack.slice(0, 12)` bare, artifact #13
 * onward could not be seen or equipped from any screen, and unequipping to
 * make room pushed the worn item to the END of the list where it could itself
 * vanish past the cut (C16). The repo's stated policy for exactly this mistake
 * lives on uikit.fitGrid ("three vanished with no hint they existed" — page,
 * don't truncate); SaveLoadScene pages the same way.
 *
 * Phaser scenes don't run headlessly, so like tests/combat-relayout.test.js
 * these are static guards on the source; the behaviour itself is driven in a
 * real browser by tests/smoke/hero-backpack-pager-smoke.mjs (pager renders,
 * flips, and equips the formerly unreachable 13th artifact).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/scenes/HeroScene.js', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('  buildBackpack(hero, bx, by) {'));
const body = fn.slice(0, fn.indexOf('\n  }\n'));

test('the backpack renders a PAGE window, not a truncating prefix', () => {
  assert.match(body, /backpack\.slice\(start, start \+ PER_PAGE\)/,
    'the grid must window on the current page');
  assert.doesNotMatch(body, /slice\(0,\s*\d/,
    'a bare slice(0, n) is the truncation that made artifact #13 unreachable');
});

test('the page index is clamped against the live list, never trusted stale', () => {
  // Equipping from a full last page shrinks the list; a stale index would point
  // past the end and render an empty grid with no way back.
  assert.match(body, /this\.packPage = Math\.min\(Math\.max\(0, this\.packPage\), pages - 1\)/,
    'clamp packPage into [0, pages-1] on every build');
});

test('equip uses the true backpack index, not indexOf', () => {
  // indexOf found the FIRST copy of a duplicated artifact — possibly on another
  // page — so equipping a duplicate from page 2 would splice the wrong entry.
  assert.match(body, /equipArtifact\(this\.state, hero, start \+ i,/,
    'the engine index must be page start + cell index');
  assert.doesNotMatch(body, /indexOf\(artId\)/);
});

test('an overflowing backpack gets pager controls; a small one stays clean', () => {
  assert.match(body, /if \(pages > 1\)/,
    'the pager row must exist only when there is an overflow to reach');
  for (const glyph of ['◀', '▶']) {
    assert.ok(body.includes(glyph), `pager needs the ${glyph} control`);
  }
  assert.match(body, /Page \$\{this\.packPage \+ 1\}\/\$\{pages\}/,
    'the label must say where you are, like SaveLoadScene');
});
