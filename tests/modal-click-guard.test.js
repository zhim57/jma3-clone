/**
 * modal-click-guard.test.js — closing a modal must not also click the world.
 *
 * Closing a modal takes a pointerup. That press destroys the overlay, which
 * flips modalOpen() to false, and then the SAME pointerup dispatch continues to
 * the scene's own scene-level `input.on('pointerup')` — where the gate is now
 * open. The click lands on the world: closing the combat spellbook marched the
 * active stack onto the hex under the ✕ button.
 *
 * modalOpen() alone cannot prevent this; a short guard window after close is
 * what does. Two things went wrong before this suite existed:
 *   1. the guard was armed per call site, so the spellbook — which builds its own
 *      overlay — was tracked but unguarded;
 *   2. the guard was then stored on the modal's OWN scene, which is routinely not
 *      the scene that receives the leak (the AdvUI HUD owns the Town Portal
 *      chooser; the ungated pointerup belongs to the Adventure map beneath).
 * So it lives in trackModal, and it is global. These tests lock both in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  trackModal, modalOpen, resetModals, worldClicksBlocked, blockWorldClicks, MODAL_CLICK_GUARD_MS,
} from '../src/ui/uikit.js';

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** A stand-in for a Phaser container: `scene`, `once('destroy')`, `destroy()`.
 *  It clears `scene` BEFORE running the destroy handlers, which is the hostile
 *  ordering Phaser actually uses — nothing here may depend on reading it late. */
function fakeRoot(scene = {}) {
  const handlers = [];
  return {
    scene,
    active: true,
    once(ev, fn) { if (ev === 'destroy') handlers.push(fn); return this; },
    destroy() {
      this.active = false;
      this.scene = undefined;
      for (const fn of handlers.splice(0)) fn();
    },
  };
}

/** Let the guard window lapse, as it does between two real player clicks. */
const waitOutGuard = () => new Promise((r) => setTimeout(r, MODAL_CLICK_GUARD_MS + 20));

test('a tracked modal opens and closes the input gate', () => {
  resetModals();
  assert.equal(modalOpen(), false, 'clean slate');
  const root = trackModal(fakeRoot());
  assert.equal(modalOpen(), true, 'world input is gated while it is up');
  root.destroy();
  assert.equal(modalOpen(), false, 'and released when it closes');
});

test('closing a modal blocks world clicks for a beat', async () => {
  resetModals();
  const root = trackModal(fakeRoot());
  root.destroy();
  assert.equal(modalOpen(), false, 'the modal really is gone');
  assert.equal(worldClicksBlocked(), true,
    'but the pointerup that closed it must still not reach the world');
  await waitOutGuard();
  assert.equal(worldClicksBlocked(), false, 'and the next real click gets through');
});

test('the guard does not care which scene owned the modal', () => {
  // The bug this pins: AdvUI (the HUD) builds the Town Portal chooser, while the
  // ungated scene-level pointerup belongs to the Adventure map underneath. A guard
  // stored on the owning scene is armed on the wrong object and protects nothing.
  resetModals();
  const hud = {}, map = {};
  const root = trackModal(fakeRoot(hud));
  root.destroy();
  assert.equal(worldClicksBlocked(), true,
    'the map scene is protected by a modal it never owned');
  assert.deepEqual([hud, map], [{}, {}],
    'and the guard is global, not smuggled onto a scene object');
});

test('worldClicksBlocked() is true while a modal is merely open', () => {
  resetModals();
  const root = trackModal(fakeRoot());
  assert.equal(worldClicksBlocked(), true, 'covers presses landing ON the modal');
  root.destroy();
});

test('blockWorldClicks only ever extends the window', async () => {
  resetModals();
  blockWorldClicks(10_000);
  blockWorldClicks(1); // a later short block must not cut the long one short
  assert.equal(worldClicksBlocked(), true);
  resetModals();
  assert.equal(worldClicksBlocked(), false, 'reset clears it');
  await Promise.resolve();
});

test('a modal with no scene does not throw on close', () => {
  resetModals();
  const root = trackModal(fakeRoot(undefined));
  assert.doesNotThrow(() => root.destroy());
  assert.equal(modalOpen(), false);
});

test('nested modals keep the gate shut until the last one closes', () => {
  resetModals();
  const a = trackModal(fakeRoot());
  const b = trackModal(fakeRoot());
  a.destroy();
  assert.equal(modalOpen(), true, 'the second modal still holds the gate');
  b.destroy();
  assert.equal(modalOpen(), false);
});

test('resetModals is a real safety valve and leaves no stale guard', () => {
  resetModals();
  trackModal(fakeRoot());
  trackModal(fakeRoot());
  assert.equal(modalOpen(), true);
  resetModals();
  assert.equal(modalOpen(), false, 'the gate cannot get stuck shut');
  assert.equal(worldClicksBlocked(), false,
    'and a torn-down scene does not hand the next one a guard it never armed');
});

test('the guard window is long enough to catch a same-dispatch pointerup', () => {
  assert.ok(MODAL_CLICK_GUARD_MS >= 100 && MODAL_CLICK_GUARD_MS <= 400,
    `${MODAL_CLICK_GUARD_MS}ms — long enough for the trailing press, short enough to feel instant`);
});

// ---- structural guards: the choke point must stay the only door -------------

test('every modal registers through trackModal — no bypass in uikit', () => {
  const uikit = src('../src/ui/uikit.js');
  // liveModals is a Map (root -> when it opened, for modalAgeMs), so registration
  // is a .set(); either way there must be exactly one place that does it.
  assert.equal([...uikit.matchAll(/liveModals\.(add|set)\(/g)].length, 1,
    'only trackModal may add to liveModals; a second call site bypasses the click-guard');
  assert.match(uikit, /const root = trackModal\(scene\.add\.container/,
    'showDialog must build its root through trackModal');
});

test('the hand-built spellbook overlay is tracked', () => {
  // This is the overlay that caused the bug: shared by the town Mage Guild, the
  // combat spellbook and the adventure spellbook.
  assert.match(src('../src/ui/spellbook.js'), /\btrackModal\(root\)/);
});

test('every scene-level pointerup gates on worldClicksBlocked(), not modalOpen()', () => {
  // Scene-level handlers fire regardless of what sits on top, so these are the
  // only two places a leaked click can land — and both must use the full gate.
  const combat = src('../src/scenes/CombatScene.js');
  const onClick = combat.slice(combat.indexOf('\n  onClick(p) {'));
  assert.match(onClick.slice(0, onClick.indexOf('\n  }\n')), /if \(worldClicksBlocked\(\)\) return;/,
    'CombatScene.onClick');

  const adv = src('../src/scenes/AdventureScene.js');
  const onWorld = adv.slice(adv.indexOf('\n  onWorldClick(pointer) {'));
  assert.match(onWorld.slice(0, onWorld.indexOf('\n  }\n')), /if \(worldClicksBlocked\(\)\) return;/,
    'AdventureScene.onWorldClick');
});

test('no scene keeps a private per-scene click guard', () => {
  // A leftover `this.clickGuardUntil` would be a second, weaker mechanism that
  // looks like protection while covering only its own scene.
  for (const f of ['../src/scenes/CombatScene.js', '../src/scenes/AdventureScene.js']) {
    assert.doesNotMatch(src(f), /clickGuardUntil/, `${f} should defer to uikit's global guard`);
  }
});

test('adventure map pan and zoom are gated too', () => {
  const adv = src('../src/scenes/AdventureScene.js');
  const bind = adv.slice(adv.indexOf('  bindInput() {'), adv.indexOf('  onWorldClick(pointer) {'));
  const wheel = bind.slice(bind.indexOf("this.input.on('wheel'"));
  assert.match(wheel.slice(0, 220), /if \(modalOpen\(\)\) return;/, 'wheel zoom');
  const down = bind.slice(bind.indexOf("this.input.on('pointerdown'"));
  assert.match(down.slice(0, 220), /if \(modalOpen\(\)\) return;/, 'drag-pan');
});

/**
 * Every hand-built modal overlay must be tracked, or modalOpen() lies about it.
 *
 * The signal for "this is a modal" is precise: a high-depth container PLUS a
 * fullscreen interactive blocker. That distinguishes an in-scene overlay from a
 * HUD card (container, no blocker) and from a full screen like Settings, which
 * pauses the world instead of layering over it (blocker, no overlay container).
 *
 * This is what found the dwelling recruit dialog, which sat over a LIVE map —
 * unlike the town screens, Adventure is not paused behind it — so every press in
 * it also reached AdventureScene's scene-level pointerup.
 */
test('every hand-built modal overlay calls trackModal', () => {
  const files = [
    'CombatScene', 'AdventureScene', 'AdvUIScene', 'TownScene', 'HeroScene',
    'HeroMeetScene', 'SettingsScene', 'SaveLoadScene',
  ].map((n) => `../src/scenes/${n}.js`).concat(['../src/ui/uikit.js', '../src/ui/spellbook.js']);

  // A class method at two-space indent, or a module-level function.
  const BLOCK_START = /^(?:\x20\x20(?:async\x20)?[A-Za-z_$][\w$]*\(|(?:export\x20)?function\x20[A-Za-z_$])/;
  const untracked = [];

  for (const f of files) {
    const lines = src(f).split('\n');
    let start = 0;
    const blocks = [];
    lines.forEach((ln, i) => {
      if (BLOCK_START.test(ln) && i > start) { blocks.push({ start, body: lines.slice(start, i) }); start = i; }
    });
    blocks.push({ start, body: lines.slice(start) });

    for (const b of blocks) {
      const text = b.body.join('\n');
      const overlay = /add\.container\([^\n]*\.setDepth\((\d{4,})\)/.exec(text);
      const blocker = /W \* 2, H \* 2/.test(text) && /setInteractive\(/.test(text);
      if (!overlay || Number(overlay[1]) < 5000 || !blocker) continue;
      if (!/trackModal/.test(text)) {
        const name = (b.body.find((l) => BLOCK_START.test(l)) || '?').trim();
        untracked.push(`${f.replace('../src/', '')}:${b.start + 1}  ${name}`);
      }
    }
  }

  assert.deepEqual(untracked, [],
    `these overlays gate nothing — modalOpen() stays false while they are up:\n  ${untracked.join('\n  ')}`);
});

test('every adventure hotkey respects the modal gate — including ESC', () => {
  const adv = src('../src/scenes/AdventureScene.js');
  const bind = adv.slice(adv.indexOf('  bindInput() {'), adv.indexOf('  onWorldClick(pointer) {'));
  const keys = [...bind.matchAll(/this\.input\.keyboard\.on\('keydown-([A-Z]+)', \(\) => \{?([^;]*)/g)];
  assert.ok(keys.length >= 8, `found ${keys.length} hotkeys`);
  for (const [, key, body] of keys) {
    assert.match(body, /modalOpen\(\)/, `keydown-${key} must not fire under an open dialog`);
  }
});
