/**
 * clickable-slots.test.js — the whole slot answers the mouse, not just its art.
 *
 * Reported: "on the hero meet screen, only the corner with the number is
 * responsive — make the whole creature rectangle clickable."
 *
 * Cause: Phaser's `input.topOnly` defaults to TRUE, so only the topmost
 * interactive object under the pointer is given the event. HeroMeetScene drew the
 * creature icon over the slot rectangle and made the ICON interactive — for a
 * tooltip, with no pointerup of its own. The icon therefore swallowed every press
 * that landed on it and the slot's own handler only ran on the border strip
 * around the art, which in a 48px slot is essentially the bottom corner where the
 * count sits. Exactly the reported symptom.
 *
 * The rule, applied to every stacked slot: the FRAME owns the input; art drawn on
 * top of it stays inert. TownScene's army row already did this (and comments the
 * topOnly reason), so it is included here as the reference the others follow.
 *
 * Phaser scenes cannot be instantiated headlessly, so these are static guards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (n) => readFileSync(new URL(`../src/scenes/${n}.js`, import.meta.url), 'utf8');

test('no scene makes a unitIcon interactive', () => {
  // An icon that answers the pointer is an icon that steals the slot's click.
  // The count text is never interactive either, which is why the corner it sits
  // in was the one place the slot still worked.
  for (const name of ['HeroMeetScene', 'HeroScene', 'TownScene', 'AdvUIScene']) {
    const src = read(name);
    for (const [, receiver] of src.matchAll(/const (\w+) = unitIcon\(/g)) {
      assert.doesNotMatch(src, new RegExp(`\\b${receiver}\\.setInteractive`),
        `${name}: the icon "${receiver}" must not take input — the frame under it does`);
    }
  }
});

test('HeroMeetScene army slots: the cell owns click AND hover', () => {
  const src = read('HeroMeetScene');
  const fn = src.slice(src.indexOf('  heroColumn('), src.indexOf('  artifactRow('));
  assert.match(fn, /const cell = this\.add\.rectangle\([^)]*\)\s*\n\s*\.setStrokeStyle\([^)]*\)\s*\n\s*\.setInteractive\(\{ useHandCursor: true \}\)/,
    'the slot rectangle itself must be the interactive object');
  assert.match(fn, /cell\.on\('pointerover'/, 'and carry the tooltip for the whole rectangle');
  assert.match(fn, /cell\.on\('pointerup'/, 'and the click for the whole rectangle');
  assert.doesNotMatch(fn, /const img = unitIcon\(/,
    'nothing should need a handle on the icon any more');
});

test('HeroMeetScene artifact squares: the frame owns the input', () => {
  const src = read('HeroMeetScene');
  const fn = src.slice(src.indexOf('  artifactRow('));
  assert.match(fn, /const frame = this\.add\.rectangle\(/, 'the square is the input target');
  assert.match(fn, /frame\.setInteractive\(\{ useHandCursor: true \}\)/);
  assert.match(fn, /artifactIcon\(this, it\.id, cx, cy, size - 6\);/,
    'the artifact art is drawn but takes no input');
});

test('HeroScene army slots show their stats over the whole slot', () => {
  const src = read('HeroScene');
  assert.match(src, /const cell = inset\(this, x, ay, 56, 68\);/,
    'the inset frame must be kept so it can take the hover');
  assert.match(src, /cell\.setInteractive\(\)\s*\n\s*\.on\('pointerover'/,
    'hovering anywhere in the slot should show the creature, not just the 44px icon');
});

test('a town recruit card recruits from anywhere on the card', () => {
  // The icon is 52px inside an 84x96 card, so with the icon as the input target
  // clicking the creature's NAME — printed under it, on the card — did nothing.
  const src = read('TownScene');
  assert.match(src, /const card = inset\(this, x, y, 84, 96\);/,
    'the card frame must be kept so it can take the input');
  assert.match(src, /card\.setInteractive\(\{ useHandCursor: true \}\)\s*\n\s*\.on\('pointerup', \(\) => \{ this\.tooltip\.hide\(\); this\.recruitDialog\(/,
    'the card, not the icon, opens the recruit dialog');
});

test('the tooltip is dismissed when a slot is actually clicked', () => {
  // A rebuild happens on click (buildAll destroys everything); a tooltip left
  // showing would be orphaned over the new layout.
  const src = read('HeroMeetScene');
  const fn = src.slice(src.indexOf('  heroColumn('), src.indexOf('  artifactRow('));
  const up = fn.slice(fn.indexOf("cell.on('pointerup'"));
  assert.match(up, /this\.tooltip\.hide\(\)/, 'hide the tooltip before rebuilding under it');
});
