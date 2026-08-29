/**
 * scene-render-wiring.test.js — a scene that calls `this.render()` MUST define a
 * render() method. TownScene once called this.render() from its Study-break toggle
 * and close handler even though its redraw method is buildAll(), so clicking either
 * threw "this.render is not a function" (a hard runtime crash the type checker and
 * unit tests never saw). This cheap static guard turns that class of redraw-method
 * typo into a failing test instead of a shipped crash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCENES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scenes');

test('every scene that calls this.render() also defines a render() method', () => {
  const offenders = [];
  for (const file of fs.readdirSync(SCENES).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SCENES, file), 'utf8');
    if (!/\bthis\.render\s*\(/.test(src)) continue; // never calls this.render()
    if (/^\s{2}render\s*\(/m.test(src)) continue;   // ...and defines render()
    offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    `scene(s) call this.render() without defining render() (use the scene's real redraw method): ${offenders.join(', ')}`);
});
