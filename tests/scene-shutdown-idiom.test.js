/**
 * scene-shutdown-idiom.test.js — a Scene method named `shutdown` is a trap.
 *
 * Phaser never calls it: a scene's lifecycle methods are init / preload /
 * create (update is wired via sys.sceneUpdate), and teardown ends at
 * `events.emit(Events.SHUTDOWN, ...)` — no method lookup of that name, ever.
 * So `shutdown() { ... }` LOOKS like the teardown hook and silently is not:
 * whatever is put in it never runs. ArenaScene and GanttScene both carried one,
 * harmless only because Phaser's DisplayList destroys the children anyway —
 * but the next line added to such a method (killing a tween, an off() on the
 * global ScaleManager) would leak without a symptom pointing here.
 *
 * The repo idiom is the EVENT form, subscribed in create():
 *   this.events.once('shutdown', () => { ... });
 * This guard fails the build if the method form ever comes back. Static,
 * because Phaser scenes cannot be constructed headlessly (no DOM, no WebGL).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('no scene defines a shutdown() METHOD — Phaser only honours the event', () => {
  const dir = new URL('../src/scenes/', import.meta.url);
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    src.split('\n').forEach((line, i) => {
      // A class-body method definition: `shutdown(` at member indentation,
      // not a call (`.shutdown`), not a comment, not a string mention.
      if (/^\s{2}shutdown\s*\(/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    `these scenes define a shutdown() method Phaser will never call — use `
    + `this.events.once('shutdown', ...) in create() instead:\n  ${offenders.join('\n  ')}`);
});

// CLONE: the second test here checked that ArenaScene and GanttScene subscribe to
// the shutdown event instead of carrying a dead `shutdown()` method. Neither scene is
// shipped in this tree (see src/main.js), so there is nothing left to assert. The
// first test — that no scene in the tree carries the dead method — still runs and
// still covers every scene this clone does ship.
