/**
 * ui-telemetry-bounds.test.js — the usage store cannot grow without bound (S29).
 *
 * Two layers keep it finite, and both are exercised here BY EXECUTION:
 *
 *   1. uikit.controlId collapses digit runs in derived labels, so a
 *      value-bearing button ("⚱ Sacrifice for 3,050 XP", "Parley — 480g",
 *      "▶ Continue (Wk 3 Day 4)") counts as ONE control across every value it
 *      ever shows. Before this, each value minted a permanent localStorage key
 *      AND polluted summarize().unused — every one-shot label read as a control
 *      nobody presses, which is the exact report the module exists to produce.
 *   2. uiTelemetry itself caps distinct ids per counter table, evicting the
 *      lowest-count entry past CONTROL_KEY_CAP — the backstop for any call
 *      site the derivation misses (labels that vary by NAME want `track:`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { controlId } from '../src/ui/uikit.js';
import { registerControl, trackClick, snapshot, resetUsage, CONTROL_KEY_CAP } from '../src/game/uiTelemetry.js';

const scene = { scene: { key: 'Town' } };

test('controlId collapses every digit run, separators included', () => {
  assert.equal(controlId(scene, '⚱ Sacrifice for 3,050 XP', {}), 'Town:⚱ Sacrifice for # XP');
  assert.equal(controlId(scene, 'Parley — 480g', {}), 'Town:Parley — #g');
  assert.equal(controlId(scene, '▶ Continue (Wk 3 Day 4)', {}), 'Town:▶ Continue (Wk # Day #)');
  assert.equal(controlId(scene, 'Hire Roderick (1200g)', {}), 'Town:Hire Roderick (#g)');
  // The two sides of the same button on different days agree — the whole point.
  assert.equal(
    controlId(scene, '▶ Continue (Wk 1 Day 2)', {}),
    controlId(scene, '▶ Continue (Wk 11 Day 6)', {}),
  );
});

test('controlId leaves non-numeric labels alone — punctuation is not a digit run', () => {
  assert.equal(controlId(scene, 'Yes, disband', {}), 'Town:Yes, disband');
  assert.equal(controlId(scene, '◀', {}), 'Town:◀');
  assert.equal(controlId(scene, 'End Turn…', {}), 'Town:End Turn…');
});

test('controlId precedence is unchanged: track wins, false opts out', () => {
  assert.equal(controlId(scene, 'Hire Roderick (1200g)', { track: 'HireHero' }), 'Town:HireHero');
  assert.equal(controlId(scene, 'anything', { track: false }), null);
});

test('the counter tables stop at CONTROL_KEY_CAP, evicting the least-used', () => {
  resetUsage();
  // A heavily-used control, then a flood of distinct ids well past the cap.
  for (let i = 0; i < 50; i++) registerControl('Menu:Play');
  for (let i = 0; i < CONTROL_KEY_CAP + 100; i++) registerControl(`Menu:junk-${i}`);
  const snap = snapshot();
  assert.ok(Object.keys(snap.rendered).length <= CONTROL_KEY_CAP,
    `rendered holds ${Object.keys(snap.rendered).length} keys — the cap did not hold`);
  assert.equal(snap.rendered['Menu:Play'], 50,
    'the heavily-used entry must survive the flood — eviction takes the least-used');
  resetUsage();
});

test('clicks are capped by the same rule', () => {
  resetUsage();
  for (let i = 0; i < 20; i++) trackClick('Menu:Play');
  for (let i = 0; i < CONTROL_KEY_CAP + 50; i++) trackClick(`Menu:junk-${i}`);
  const snap = snapshot();
  assert.ok(Object.keys(snap.counts).length <= CONTROL_KEY_CAP);
  assert.equal(snap.counts['Menu:Play'], 20);
  resetUsage();
});
