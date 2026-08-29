/**
 * hud-and-depth.test.js — two reported UI defects, pinned structurally.
 *
 * Both are invisible to the rule-engine tests because they live in Phaser scene
 * code, so they are pinned by reading the source. That is the same discipline
 * the other view guards in this suite use (see ui-fit, invader-planner).
 *
 *   1. "When I get a dialog it shows UNDER THE TREES." AdventureScene paints the
 *      world with a painter's sort whose depth is the sprite's world y in PIXELS
 *      — 7,680 on the bottom row of the largest map. Overlays raised in that same
 *      scene at a hardcoded 5,000 were therefore drawn beneath the lower half of
 *      any map taller than ~78 tiles. Every overlay depth now comes from one
 *      named ladder (uikit DEPTH) that starts well above the world ceiling.
 *
 *   2. "With more than 12 towns I get a button that hides the selected hero
 *      stats, army and cast-spell button." The town carousel `return`ed out of
 *      refreshHUD entirely, so everything drawn after the town strip — the whole
 *      selected-hero card — stopped being drawn.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { CONFIG } from '../src/config.js';
import { DEPTH } from '../src/ui/uikit.js';
import { SCENARIOS } from '../src/data/scenarios.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 1. The depth ladder
// ---------------------------------------------------------------------------

test('the ladder clears the tallest world sprite any shipped map can produce', () => {
  // World depth == world y in pixels (AdventureScene.buildDecor), so the ceiling
  // is the tallest map times the tile size.
  const tallest = Math.max(...SCENARIOS.map((s) => s.mapH));
  const worldCeiling = tallest * CONFIG.TILE;
  assert.ok(worldCeiling > 5000,
    `the old hardcoded 5000 really was below the world ceiling (${worldCeiling}) — that was the bug`);
  assert.ok(DEPTH.FOG > worldCeiling, 'fog draws over the world');
  assert.ok(DEPTH.MODAL > worldCeiling, 'and a dialog draws over the trees');
  assert.ok(DEPTH.MODAL > DEPTH.FOG, 'a dialog also clears the fog it is raised over');
});

test('the ladder is strictly ordered — chrome, dialog, second dialog, tooltip, curtain', () => {
  const rungs = ['HUD', 'MODAL', 'MODAL_TOP', 'TOOLTIP', 'CURTAIN'];
  for (let i = 1; i < rungs.length; i++) {
    assert.ok(DEPTH[rungs[i]] > DEPTH[rungs[i - 1]],
      `${rungs[i]} must sit above ${rungs[i - 1]}`);
  }
  assert.ok(DEPTH.HUD > DEPTH.WORLD_MAX);
});

test('no scene raises an overlay on a magic number any more', () => {
  // Any four-plus digit literal depth is a hand-tuned number that will drift out
  // of order with the world. They must all come from the ladder.
  const dirs = ['../src/scenes/', '../src/ui/'];
  const offenders = [];
  for (const dir of dirs) {
    const url = new URL(dir, import.meta.url);
    for (const file of readdirSync(url).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(new URL(file, url), 'utf8');
      src.split('\n').forEach((line, i) => {
        const m = line.match(/setDepth\((\d{4,})\)/);
        if (m) offenders.push(`${file}:${i + 1}  setDepth(${m[1]})`);
      });
    }
  }
  assert.deepEqual(offenders, [],
    `these depths would fall under the world art on a tall map:\n  ${offenders.join('\n  ')}`);
});

test('showDialog and the tooltip are raised on named rungs', () => {
  const uikit = read('../src/ui/uikit.js');
  assert.match(uikit, /trackModal\(scene\.add\.container\(0, 0\)\.setDepth\(DEPTH\.MODAL\)\)/,
    'a dialog is raised at DEPTH.MODAL');
  assert.match(uikit, /setDepth\(DEPTH\.TOOLTIP\)/,
    'a tooltip clears even a dialog');
});

test('AdventureScene fog and preview are raised on the ladder, above the world', () => {
  const adv = read('../src/scenes/AdventureScene.js');
  assert.match(adv, /this\.fogG = this\.add\.graphics\(\)\.setDepth\(DEPTH\.FOG\)/);
  assert.match(adv, /this\.previewG = this\.add\.graphics\(\)\.setDepth\(DEPTH\.FOG \+ 1\)/);
  // The hover cards are screen-space map annotations: above the fog, BELOW a
  // dialog (a dialog must be able to cover them).
  const cards = [...adv.matchAll(/setScrollFactor\(0\)\.setDepth\(DEPTH\.HUD \+ (\d+)\)/g)];
  assert.ok(cards.length >= 2, 'the hero and object hover cards both sit in the HUD band');
});

// ---------------------------------------------------------------------------
// 2. The town carousel must not swallow the hero card
// ---------------------------------------------------------------------------

test('the town carousel replaces the STRIP, not the rest of refreshHUD', () => {
  const src = read('../src/scenes/AdvUIScene.js');
  const start = src.indexOf('  refreshHUD() {');
  assert.ok(start > 0, 'refreshHUD exists');
  const body = src.slice(start, src.indexOf('\n  /** Confirm enshrining', start));

  const carousel = body.indexOf('this.drawTownCarousel(');
  assert.ok(carousel > 0, 'the carousel is still drawn past the threshold');
  // THE regression: a bare `return` on the carousel branch. Everything after the
  // town strip — the selected-hero card, its army, Cast Spell, Dig — is drawn
  // later in this same function, so returning here deletes all of it.
  const branch = body.slice(carousel, carousel + 200);
  assert.ok(!/\breturn\b/.test(branch),
    'drawing the carousel must FALL THROUGH to the hero card, never return out of refreshHUD');

  // And the hero card really is downstream of the carousel branch.
  const card = body.indexOf('// selected hero card');
  assert.ok(card > carousel, 'the hero card is drawn after the town section');
  assert.ok(body.indexOf("'\u2726 Cast Spell") > carousel, 'and so is the Cast Spell button');
});

test('the carousel chip fits the vertical slot the town strip reserved', () => {
  // townListY += 56 before the hero card's y is taken, so a 34px chip centred at
  // +20 (spanning +3..+37) must not run into it.
  const src = read('../src/scenes/AdvUIScene.js');
  const fn = src.slice(src.indexOf('  drawTownCarousel('));
  const m = fn.match(/button\(this, sx \+ \d+, y \+ (\d+), \d+, (\d+),/);
  assert.ok(m, 'the chip is a button at a known offset');
  const [, offset, height] = m.map(Number);
  assert.ok(offset + height / 2 <= 56, `chip bottom (${offset + height / 2}) stays inside the 56px town slot`);
});

test('the carousel threshold is a config value, not a literal', () => {
  const src = read('../src/scenes/AdvUIScene.js');
  assert.match(src, /list\.length > CONFIG\.TOWN_CAROUSEL_FROM/);
  assert.ok(CONFIG.TOWN_CAROUSEL_FROM > 0 && CONFIG.TOWN_CAROUSEL_VISIBLE > 0);
});
