/**
 * screen-pinned-ui.test.js — dialogs live on the SCREEN, not in the world.
 *
 * Reported as: attacking a creature turns half the screen dark, nothing animates,
 * Escape clears it, and afterwards the hero cannot walk away while every click
 * burns movement. The decisive detail was "the modal appears somewhere but not in
 * my view area".
 *
 * Measured in a real Chromium with the camera centred on the hero, before any fix:
 *
 *     dialog scrollFactor : 1          (it scrolls with the world)
 *     placed at world     : 640, 400   (screen-centre coords used as WORLD coords)
 *     rendered at screen  : 768, -1152  -> 1152px above the top of the window
 *     onScreen            : false
 *
 * And uikit.js contained ZERO setScrollFactor calls, so every dialog it built was
 * world-positioned. Most scenes never scroll, which is why this hid for so long —
 * but AdventureScene's camera pans and zooms across the map, so a dialog raised
 * there is carried off into the world while its oversized backdrop still darkens
 * part of the view. The modal stays open and unseen, so world input remains gated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pinToScreen } from '../src/ui/uikit.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** A stub game object tree: records what scroll factor was applied. */
function node(children = []) {
  return { sf: null, list: children, setScrollFactor(x, y) { this.sf = [x, y]; return this; } };
}

test('pinToScreen pins the object AND everything nested inside it', () => {
  const leaf1 = node(), leaf2 = node(), inner = node([leaf1, leaf2]);
  const root = node([inner, node()]);
  pinToScreen(root);
  for (const n of [root, inner, leaf1, leaf2]) {
    assert.deepEqual(n.sf, [0, 0], 'every descendant must ignore camera scroll');
  }
});

test('pinToScreen survives the odd shapes a UI tree really contains', () => {
  // Objects without setScrollFactor (plain data), null children, no list at all.
  const weird = { list: [null, {}, node()] };
  assert.doesNotThrow(() => pinToScreen(weird));
  assert.doesNotThrow(() => pinToScreen(null));
  assert.doesNotThrow(() => pinToScreen(undefined));
});

test('scroll factor zero is what makes x/y mean SCREEN pixels', () => {
  // The bug in one line: with factor 1 the camera's scroll is subtracted, so a
  // dialog at (640, 400) with the camera at scrollY 1552 renders at y = -1152.
  const screenY = (y, scrollY, factor) => y - scrollY * factor;
  assert.equal(screenY(400, 1552, 1), -1152, 'the measured failure');
  assert.equal(screenY(400, 1552, 0), 400, 'and the fix');
});

test('showDialog pins the finished dialog', () => {
  const uikit = read('../src/ui/uikit.js');
  const fn = uikit.slice(uikit.indexOf('export function showDialog'));
  const body = fn.slice(0, fn.indexOf('\n  return root;'));
  assert.match(body, /pinToScreen\(root\)/,
    'a dialog built at screen-centre coords must be pinned, or the map camera carries it away');
});

test('the spellbook pins itself, including on rebuild', () => {
  const sb = read('../src/ui/spellbook.js');
  assert.match(sb, /pinToScreen\(root\)/, 'the overlay root');
  assert.match(sb, /pinToScreen\(content\)/,
    'the grid is rebuilt on tab/selection change — the new children need pinning too');
});

test('the hand-built overlay on the scrolling scene is pinned', () => {
  // openTownPortalChooser draws on `this.ui || this`, and that fallback IS the
  // scene whose camera moves.
  assert.match(read('../src/scenes/AdventureScene.js'), /pinToScreen\(root\)/);
});

test('uikit no longer builds world-positioned UI', () => {
  const uikit = read('../src/ui/uikit.js');
  assert.ok(/setScrollFactor/.test(uikit),
    'uikit had zero setScrollFactor calls — that was the whole defect');
});
