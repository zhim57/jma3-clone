/**
 * pacing.test.js — the opt-in "Tide of War" pacing preset scaffold (Phase C).
 *
 * The preset is stored on state.pacing (set in newGame, round-tripped through
 * saves) and resolved by src/core/pacing.js into predicates the growth-system
 * features branch on. 'classic' is the base game and the DEFAULT, so every
 * pre-existing setup (which never passes a pacing) and every old save reads as
 * classic with the system off. Covers table integrity, newGame storage,
 * defaults/unknown coercion, the helpers, and save round-trip incl. a legacy
 * (no-field) save.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, serialize, deserialize } from '../src/core/GameState.js';
import { pacingPreset, tideOfWar } from '../src/core/pacing.js';

const SEED = 7;

test('pacing table: the default exists, classic is the base (off) preset, tideOfWar is on', () => {
  assert.ok(CONFIG.PACING[CONFIG.DEFAULT_PACING], 'the default pacing preset exists');
  assert.equal(CONFIG.DEFAULT_PACING, 'classic', 'the base game is the default');
  for (const id of CONFIG.PACING_ORDER) {
    const p = CONFIG.PACING[id];
    assert.ok(p, `${id} is defined`);
    assert.equal(typeof p.label, 'string', `${id}.label`);
    assert.equal(typeof p.tideOfWar, 'boolean', `${id}.tideOfWar`);
  }
  assert.equal(CONFIG.PACING.classic.tideOfWar, false, 'classic leaves the system off');
  assert.equal(CONFIG.PACING.tideOfWar.tideOfWar, true, 'the Tide of War preset turns it on');
});

test('newGame: default pacing is classic and the system is off', () => {
  const def = newGame({ seed: SEED });
  assert.equal(def.pacing, 'classic', 'default game is classic');
  assert.equal(tideOfWar(def), false, 'the growth system is off by default');
  assert.equal(pacingPreset(def).label, 'Classic');
});

test('newGame: an explicit Tide of War preset is stored and turns the system on', () => {
  const s = newGame({ seed: SEED, pacing: 'tideOfWar' });
  assert.equal(s.pacing, 'tideOfWar');
  assert.equal(tideOfWar(s), true, 'the growth system is active');
});

test('newGame: an unknown pacing value is coerced to the default (classic)', () => {
  const bad = newGame({ seed: SEED, pacing: 'apocalypse' });
  assert.equal(bad.pacing, 'classic', 'garbage pacing is coerced to the default');
  assert.equal(tideOfWar(bad), false);
});

test('pacing helpers tolerate missing/garbage state (fall back to classic)', () => {
  assert.equal(tideOfWar(null), false);
  assert.equal(tideOfWar(undefined), false);
  assert.equal(tideOfWar({}), false, 'a state with no pacing field reads as classic');
  assert.equal(pacingPreset({ pacing: 'nonsense' }).label, 'Classic');
});

test('pacing round-trips through save/load; a legacy (no-field) save reads as classic', () => {
  const s = newGame({ seed: SEED, pacing: 'tideOfWar' });
  const r = deserialize(serialize(s));
  assert.equal(r.pacing, 'tideOfWar', 'the preset survives a save round-trip');
  assert.equal(tideOfWar(r), true);

  // A pre-pacing save (no field) still loads and reads as classic (system off).
  const json = JSON.parse(serialize(s));
  delete json.pacing;
  const legacy = deserialize(JSON.stringify(json));
  assert.equal(tideOfWar(legacy), false, 'an old save is classic, not Tide of War');
});
