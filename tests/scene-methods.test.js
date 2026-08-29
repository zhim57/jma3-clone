/**
 * scene-methods.test.js — every `this.foo(...)` a scene calls must exist.
 *
 * Phaser scenes cannot be instantiated headlessly, so nothing in the suite
 * executes their bodies: a scene can reference a method that does not exist and
 * every test still passes, lint still passes, the build still succeeds — and the
 * game throws "this.foo is not a function" the moment that code path runs.
 *
 * That happened: removing the pre-battle stance picker from CombatScene took
 * `proceedBattle()` with it, and EVERY battle crashed on start. This is a cheap
 * static guard against exactly that — parse each scene, collect what it defines
 * and assigns, and assert every method it calls on `this` is one of them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../src/scenes/', import.meta.url);

// Members Phaser.Scene itself provides that code may CALL directly on `this`.
// Property chains (this.add.image, this.scene.start) never match the call regex,
// so this list only needs directly-invoked inherited methods.
const PHASER_CALLABLE = new Set(['update', 'preload', 'init', 'create', 'shutdown']);

/** Names the class defines (methods, class fields) or assigns to `this`. */
function definedNames(src) {
  const names = new Set();
  // class methods:  "  foo(...) {"  /  "  async foo(" / "  *foo("
  for (const m of src.matchAll(/^\s{2}(?:async\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1]);
  // class fields and any `this.foo = ...` assignment (handlers passed in via init)
  for (const m of src.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*=/gm)) names.add(m[1]);
  for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*(?:=|\|\|=|\?\?=|\+=)/g)) names.add(m[1]);
  // destructured onto this via Object.assign(this, {...}) — rare, be permissive
  for (const m of src.matchAll(/Object\.assign\(this,\s*\{([^}]*)\}/g)) {
    for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) names.add(k[1]);
  }
  return names;
}

/** Names invoked as `this.foo(` or `this.foo?.(`. */
function calledNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\?\.\s*\(/g)) names.add(m[1]);
  return names;
}

const sceneFiles = readdirSync(DIR).filter((f) => f.endsWith('.js'));

test('scenes exist to check', () => {
  assert.ok(sceneFiles.length >= 8, `found ${sceneFiles.length} scene files`);
});

for (const file of sceneFiles) {
  test(`${file}: every this.method() it calls is defined`, () => {
    const src = readFileSync(new URL(file, DIR), 'utf8');
    const defined = definedNames(src);
    const missing = [...calledNames(src)]
      .filter((n) => !defined.has(n) && !PHASER_CALLABLE.has(n))
      .sort();
    assert.deepEqual(missing, [],
      `${file} calls this.${missing.join('(), this.')}() but never defines it`);
  });
}
