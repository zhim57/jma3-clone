/**
 * hover-text.test.js — hover text must be readable, and must follow the cursor.
 *
 * Playtest report: "generally the text on the hover is very small, could be bigger."
 * It was a hard-coded 13px, which cannot suit every display, so the size is now the
 * player's knob (Settings -> Hover text size), defaulting to 1.25x = 16px.
 *
 * Found while fixing it: the tooltip was ALSO positioned in world space, the same
 * defect that put dialogs off-view. Its x/y come from the pointer and are therefore
 * already screen pixels, so on the adventure map the scrolling camera dragged the
 * tooltip away from the cursor by the whole scroll offset — which would make it
 * hard to read for a reason no font size could fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_SETTINGS, getSetting, setSetting } from '../src/game/settings.js';

const uikit = readFileSync(new URL('../src/ui/uikit.js', import.meta.url), 'utf8');

test('hover text defaults BIGGER than the 13px that was reported as too small', () => {
  const scale = DEFAULT_SETTINGS.uiTextScale;
  assert.ok(scale > 1, `default scale ${scale} would not change anything`);
  assert.ok(Math.round(13 * scale) >= 15, `${Math.round(13 * scale)}px is still small`);
});

test('the scale is clamped to a usable band', () => {
  const before = getSetting('uiTextScale');
  setSetting('uiTextScale', 99);
  assert.ok(getSetting('uiTextScale') <= 2, 'an absurd value must clamp');
  setSetting('uiTextScale', 0);
  assert.ok(getSetting('uiTextScale') >= 0.8, 'zero would make it invisible');
  setSetting('uiTextScale', before);
});

test('the tooltip reads the setting rather than a fixed size', () => {
  const cls = uikit.slice(uikit.indexOf('export class Tooltip'));
  const show = cls.slice(0, cls.indexOf('\n  hide()'));
  assert.match(show, /getSetting\('uiTextScale'\)/, 'the size must come from settings');
  assert.doesNotMatch(show, /fontSize: '13px'/, 'the hard-coded size must be gone');
  // The wrap width has to scale too, or a bigger font just makes a narrow column.
  assert.match(show, /wordWrap: \{ width: Math\.round\(260 \* scale\)/);
});

test('the tooltip is pinned to the SCREEN, like every other overlay', () => {
  const cls = uikit.slice(uikit.indexOf('export class Tooltip'));
  const show = cls.slice(0, cls.indexOf('\n  hide()'));
  assert.match(show, /pinToScreen\(this\.root\)/,
    'unpinned, the scrolling map camera drags the tooltip off the cursor');
});

test('Settings exposes the knob to the player', async () => {
  // Reads the row TABLE, not the scene's source: the screen renders
  // SETTINGS_PAGES rather than declaring its own rows, so the table is where a
  // knob is or is not reachable.
  const { offeredKeys } = await import('../src/ui/settingsRows.js');
  assert.ok(offeredKeys().includes('uiTextScale'), 'a knob nobody can reach is not a fix');
});
