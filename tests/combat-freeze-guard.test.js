/**
 * combat-freeze-guard.test.js — a battle must never sit frozen and silent.
 *
 * Reported: "first battle, the computer froze, no errors in the console." The
 * rule engine resolves that exact fight in one or two rounds, so the fault is in
 * the view — and CombatScene has a stall watchdog that is supposed to catch a
 * stuck turn loop. The reason it can stay silent is a structural one:
 *
 *   update()  ->  if (this.awaitingHumanInput()) { markProgress(); return; }
 *
 * The watchdog is SUPPRESSED whenever the scene believes it is waiting for the
 * player. So any state that simultaneously looks like waiting and cannot receive
 * a click is a permanent freeze that logs nothing at all: no exception, no
 * warning, a battle that never moves again.
 *
 * Two ways in, both real:
 *   - liveModals is global across scenes, and AdventureScene *sleeps* AdvUI
 *     rather than stopping it before launching combat. A sleeping scene keeps its
 *     game objects, so an overlay still open there stays registered and gates
 *     every click on the battlefield for the whole fight.
 *   - resetModals() — the documented safety valve for exactly this — had zero
 *     callers anywhere in the codebase.
 *
 * Phaser scenes cannot be instantiated headlessly, so these are a mix of a live
 * check on the uikit gate and static assertions on the scene's source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { trackModal, modalOpen, resetModals, worldClicksBlocked } from '../src/ui/uikit.js';

const src = readFileSync(new URL('../src/scenes/CombatScene.js', import.meta.url), 'utf8');

/** Minimal stand-in for a Phaser container. */
function fakeRoot() {
  const handlers = [];
  return {
    scene: {}, active: true,
    once(ev, fn) { if (ev === 'destroy') handlers.push(fn); return this; },
    destroy() { this.active = false; for (const fn of handlers.splice(0)) fn(); },
  };
}

test('a modal left open by another scene keeps world clicks blocked', () => {
  // This is the mechanism, demonstrated: nobody destroys the overlay, because the
  // scene that owns it was slept rather than stopped.
  resetModals();
  trackModal(fakeRoot()); // never destroyed
  assert.equal(modalOpen(), true);
  assert.equal(worldClicksBlocked(), true, 'every battlefield click would be swallowed');
  resetModals();
  assert.equal(worldClicksBlocked(), false, 'and the valve is what clears it');
});

test('resetModals actually has callers now', () => {
  // It was a documented safety valve that nothing ever pulled.
  const scenes = ['CombatScene', 'AdventureScene', 'AdvUIScene', 'TownScene', 'HeroScene',
    'HeroMeetScene', 'SettingsScene', 'SaveLoadScene'];
  const callers = scenes.filter((n) => {
    const s = readFileSync(new URL(`../src/scenes/${n}.js`, import.meta.url), 'utf8');
    return /\bresetModals\(\)/.test(s);
  });
  assert.ok(callers.length >= 1, 'no scene pulls the safety valve — it is decoration');
  assert.ok(callers.includes('CombatScene'),
    'combat is the scene that inherits a leaked modal, so it must clear one on entry');
});

test('combat clears the input gate on entry, before it owns any modal', () => {
  const create = src.slice(src.indexOf('\n  create('));
  const head = create.slice(0, create.indexOf('this.computeLayout()'));
  assert.match(head, /resetModals\(\)/,
    'create() must clear a modal inherited from a slept scene before the fight starts');
});

test('a blocked input channel can no longer silence the stall watchdog', () => {
  // The whole point: awaitingHumanInput() gates the watchdog, so it must be false
  // when input is unreachable, or the freeze is unrecoverable AND unlogged.
  const fn = src.slice(src.indexOf('  awaitingHumanInput()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /worldClicksBlocked\(\)/,
    'awaitingHumanInput() must consider whether a click can actually arrive');

  // And update() must still consult it, or the guard is dead code.
  const upd = src.slice(src.indexOf('\n  update()'));
  assert.match(upd.slice(0, upd.indexOf('\n  }')), /awaitingHumanInput\(\)/);
});

test('the watchdog names a stuck gate and clears it, rather than only warning', () => {
  const upd = src.slice(src.indexOf('\n  update()'), src.indexOf('/** Advance the animation queue'));
  assert.match(upd, /worldClicksBlocked\(\)/, 'the recovery path checks the gate');
  // The call takes a guard length now (see modal-read-time.test.js): a close the
  // player did not ask for holds the world shut afterwards. Match either shape.
  assert.match(upd, /resetModals\(/, 'and clears it — a warning alone leaves the player stuck');
  assert.match(upd, /console\.warn/, 'and says so, so the next report is not silent');
});

test('the stall watchdog window is short enough to rescue a player', () => {
  const m = /const STUCK_MS = (\d+);/.exec(src);
  assert.ok(m, 'STUCK_MS is defined');
  const ms = Number(m[1]);
  assert.ok(ms >= 1000 && ms <= 10000, `${ms}ms — long enough to avoid false alarms, short enough to notice`);
});
