/**
 * feature-toggle-wiring.test.js — every optional rule reaches the engine from
 * the checkbox that claims to control it.
 *
 * A feature has to be listed in three places to work end to end: a default in
 * DEFAULT_SETTINGS (the store's schema — setSetting REFUSES any key that is not
 * there), a row in GAME_FEATURE_KEYS (what a New Game snapshots into
 * state.features), and a row in the Settings screen (how a player asks for it).
 * Miss one and there is no error anywhere: the build passes, the tests pass, and
 * the game quietly does not have the feature.
 *
 * Both halves of that have already happened. `lizardGhosts` was offered in
 * Settings and threaded into GAME_FEATURE_KEYS but never given a default, so
 * setSetting rejected every click and the toggle could not be switched on at
 * all. `siteRespawn` had all three and still did not reach players, because its
 * default flipped after their store had frozen the old one — which is the same
 * class of failure one layer down, and is why the store now carries a schema
 * revision.
 *
 * These are cheap static guards. They cost nothing and they close the whole
 * class.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_SETTINGS, GAME_FEATURE_KEYS, NEW_GAME_PARAM_KEYS, SETTING_SCOPES } from '../src/game/settings.js';
import { offeredKeys } from '../src/ui/settingsRows.js';
import { DEFAULT_ON_FEATURES, featureOn, adoptFeature } from '../src/core/GameState.js';

/**
 * The keys the Settings screen offers, read from its own table.
 *
 * This used to scrape a `FEATURE_TOGGLES` array out of the scene's source. The
 * screen now RENDERS a declarative table (src/ui/settingsRows.js) that the layout
 * replay and the layout guard read too, so the table can be imported directly —
 * and there is no longer a hand-kept copy of the row list anywhere to disagree
 * with the screen.
 */
function settingsScreenKeys() {
  return offeredKeys();
}

test('every game-feature key has a default, or the store silently refuses to set it', () => {
  const missing = GAME_FEATURE_KEYS.filter((k) => !(k in DEFAULT_SETTINGS));
  assert.deepEqual(missing, [],
    `feature key(s) with no DEFAULT_SETTINGS entry: ${missing.join(', ')} — `
    + 'setSetting() rejects unknown keys, so these toggles do nothing at all');
});

test('every toggle the Settings screen offers is a real, settable preference', () => {
  const offered = settingsScreenKeys();
  assert.ok(offered.length > 10, 'the toggle table was not read — this guard is not guarding anything');
  const dead = offered.filter((k) => !(k in DEFAULT_SETTINGS));
  assert.deepEqual(dead, [], `Settings offers toggle(s) nothing can store: ${dead.join(', ')}`);
});

test('every rule-engine toggle the screen offers is threaded into a new game', () => {
  // Scoped to the 'game'-lifetime keys, which is what this guard always meant.
  // It used to say "every key the screen offers", which was the same set only
  // because the screen's table happened to list nothing else; now the table
  // carries all 43 rows, so the set is named rather than assumed.
  //
  // Two escape hatches, both principled: NEW_GAME_PARAM_KEYS reach a new game as
  // explicit startNewGame parameters rather than through state.features, and
  // studySource / learningMode are app behaviour that the engine never reads
  // off state.features at all.
  const APP_ONLY = new Set(['studySource', 'learningMode']);
  const stranded = settingsScreenKeys()
    .filter((k) => SETTING_SCOPES[k] === 'game')
    .filter((k) => !APP_ONLY.has(k) && !NEW_GAME_PARAM_KEYS.includes(k) && !GAME_FEATURE_KEYS.includes(k));
  assert.deepEqual(stranded, [],
    `toggle(s) a player can set that no game ever reads: ${stranded.join(', ')} — `
    + 'add them to GAME_FEATURE_KEYS or the flag never reaches state.features');
});

test('a feature that is ON by default in the engine is ON by default in the menus', () => {
  // The two defaults are read by different code paths — the engine's by every
  // headless probe and programmatic newGame, the menu's by everything a player
  // starts — and if they disagree, a measurement describes a game nobody plays.
  for (const key of DEFAULT_ON_FEATURES) {
    assert.equal(DEFAULT_SETTINGS[key], true,
      `"${key}" is ON by default in the engine but ${DEFAULT_SETTINGS[key]} in the settings schema`);
  }
});

// ---------------------------------------------------------------------------
// Adopting a rule mid-campaign
// ---------------------------------------------------------------------------

test('a running game can adopt an optional rule, because Settings cannot reach it', () => {
  // THE DEAD END THIS CLOSES. A game snapshots its flags at New Game and they
  // round-trip the save, so the Settings screen governs the NEXT game. That is
  // right — a menu should not change the rules under a running campaign — but it
  // left the Physical Damage Model unreachable: it ships off, every upgrade node
  // in the game is a patch against it, and the Town screen told the player to go
  // and change a setting that could not affect the game they were looking at.
  const state = { features: {} };
  assert.equal(featureOn(state, 'physicalDamage'), false);

  assert.deepEqual(adoptFeature(state, 'physicalDamage'), { ok: true });
  assert.equal(featureOn(state, 'physicalDamage'), true, 'the engine must read it immediately');
  assert.equal(state.features.physicalDamage, true, 'and it must be written where the save will carry it');

  // Idempotent, and it says so rather than silently re-writing: the Town screen
  // offers the switch only while the rule is off, and a second call is a bug
  // somewhere else that should not look like success.
  assert.equal(adoptFeature(state, 'physicalDamage').ok, false);

  // A rule already on by engine default is likewise not "adopted" — nothing to do.
  assert.equal(adoptFeature({ features: {} }, 'siteRespawn').ok, false,
    'siteRespawn is DEFAULT_ON, so there is nothing to adopt');

  // Refusals are answers, not throws — the callers are UI handlers.
  assert.equal(adoptFeature(null, 'physicalDamage').ok, false);
  assert.equal(adoptFeature({ features: {} }, '').ok, false);

  // A state that never carried a features map at all still works, which is what
  // an old save and every headless fixture look like.
  const bare = {};
  assert.equal(adoptFeature(bare, 'invasions').ok, true);
  assert.equal(featureOn(bare, 'invasions'), true);
});

test('the Town screen offers the adoption switch, and offers it where the model is read', () => {
  // A static guard on the wiring, in the spirit of the rest of this file: the
  // engine call exists and passes its own test above, and this is the half that
  // says a player can reach it. The old line pointed at Settings and was the
  // whole defect.
  const raw = readFileSync(new URL('../src/scenes/TownScene.js', import.meta.url), 'utf8');
  // CODE, NOT PROSE. The first cut of this guard searched the whole file for the
  // old wording and tripped on the comment that explains why the wording went —
  // a test that cannot tell a quotation from a live string is a test that
  // punishes writing down what happened. Comments come out first.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(/adoptFeature\s*\(\s*s\s*,\s*'physicalDamage'\s*\)/.test(src),
    'the improvements dialog must be able to adopt the model for the running game');
  assert.ok(!/until it is on \(Settings\)/.test(src),
    'the line that sent players to a screen which could not help them is back');
});
