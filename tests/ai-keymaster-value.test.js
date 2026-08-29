/**
 * ai-keymaster-value.test.js — the AI values a Keymaster Tent by what its key
 * would actually UNLOCK (the caches behind matching Border Guards), not a flat
 * guess (2026-07 repo review, backlog B16).
 *
 * Every colored key opens the matching Border Guards, each of which gates one
 * adjacent dead-end reward. keymasterUnlockValue sums those rewards for the
 * guard color, so the tent scales with what's provably behind it — and is worth
 * 0 when it opens nothing (the old flat 1000*eco valued a useless key).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1;
// Register the object on its tile too. keymasterUnlockValue reads the vault
// beside each guard through the tile registry (tileAt → objectId — the same
// live lookup guardValueNear uses, and the reason a looted cache stops being
// counted the moment it is removed), so a staged world has to keep the
// tile↔object linkage every generated map maintains. An object dictionary
// alone is a world no engine code ever sees.
const addObj = (state, id, o) => {
  state.map.objects[id] = { id, ...o };
  state.map.tiles[o.y * state.map.w + o.x].objectId = id;
};

test('B16: a Keymaster Tent is valued by the caches behind its matching guards', () => {
  const state = newGame({
    seed: 11,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const ai = new AITurnController(state, AI);

  // A known object set: a RED key opens two guards (a chest vault + a 5000-gold
  // vault); a BLUE guard gates an artifact under a different key.
  state.map.objects = {};
  addObj(state, 'Ored', { type: 'keymaster', color: 'red', x: 10, y: 10 });
  addObj(state, 'Gred1', { type: 'borderGuard', color: 'red', x: 20, y: 20 });
  addObj(state, 'Rchest', { type: 'chest', x: 21, y: 20 });        // gated by Gred1
  addObj(state, 'Gred2', { type: 'borderGuard', color: 'red', x: 30, y: 30 });
  addObj(state, 'Rgold', { type: 'resource', resource: 'gold', amount: 5000, x: 30, y: 31 }); // gated by Gred2
  // In bounds of the default 44×36 map — a tile-registered object has to have
  // a tile (the old dictionary-only staging let (40,40) float off a 36-high map).
  addObj(state, 'Gblue', { type: 'borderGuard', color: 'blue', x: 40, y: 30 });
  addObj(state, 'Bart', { type: 'artifact', x: 41, y: 30 });       // gated by Gblue

  assert.equal(ai.keymasterUnlockValue(state, 'red', 0), 1500 + 5000,
    'the red key = the chest (1500) + the 5000-gold pile behind its two guards');
  assert.equal(ai.keymasterUnlockValue(state, 'blue', 0), 2000, 'the blue key = the artifact (2000)');

  // A key that opens nothing on the map is worth nothing (was a flat 1000).
  assert.equal(ai.keymasterUnlockValue(state, 'green', 0), 0, 'a key with no matching guards unlocks nothing');

  // More/bigger vaults ⇒ a strictly more valuable key.
  assert.ok(ai.keymasterUnlockValue(state, 'red', 0) > ai.keymasterUnlockValue(state, 'blue', 0),
    'the two-vault red key outvalues the single-vault blue key');
});
