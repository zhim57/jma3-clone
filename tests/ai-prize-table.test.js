/**
 * ai-prize-table.test.js — the unified AI prize table + obelisk drift fix
 * (2026-07 repo review, backlog G64).
 *
 * pickGoal, bestThrough and pickBoatGoal used to price prizes three different
 * ways. The visible drift: only pickGoal valued an unread Obelisk by grail-puzzle
 * progress (up to ~4000) — bestThrough and pickBoatGoal flat-priced every booster
 * at 800, so a through-connector or boat hero sailed past an obelisk a land hero
 * would ride for. All three now call boosterScore(), tested here at the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1;
const twoPlayers = [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
];

test('G64: an unread obelisk mid-grail-hunt outvalues a plain booster (was flat 800)', () => {
  const state = newGame({ seed: 21, players: twoPlayers });
  const ai = new AITurnController(state, AI);
  // A known obelisk set: two on the map, one already read (seen 1 / total 2),
  // grail not yet solved.
  state.map.underground = null;
  state.map.objects = {
    OB1: { id: 'OB1', type: 'booster', boosterType: 'obelisk', x: 5, y: 5 },
    OB2: { id: 'OB2', type: 'booster', boosterType: 'obelisk', x: 9, y: 9 },
  };
  state.players[AI].obeliskIds = ['OB1'];

  const plainCamp = { id: 'C1', type: 'booster', boosterType: 'move', x: 3, y: 3 };
  const plain = ai.boosterScore(plainCamp);
  assert.equal(plain, 800, 'a plain booster is the flat base value');
  assert.ok(ai.boosterScore(state.map.objects.OB2) > plain, 'an unread obelisk mid-hunt is worth more');
  assert.equal(ai.boosterScore(state.map.objects.OB2), 1500 + 2500 * (1 / 2),
    'scaled by puzzle progress (seen/total)');
  assert.equal(ai.boosterScore(state.map.objects.OB1), plain,
    'an obelisk already read carries no puzzle bonus');
});

test('G64: once the Grail is known, obelisks fall back to the base value', () => {
  const state = newGame({ seed: 22, players: twoPlayers });
  const ai = new AITurnController(state, AI);
  state.map.underground = null;
  state.map.objects = { OB1: { id: 'OB1', type: 'booster', boosterType: 'obelisk', x: 5, y: 5 } };
  state.players[AI].obeliskIds = ['OB1']; // seen 1 / total 1 → grail known
  const another = { id: 'OB9', type: 'booster', boosterType: 'obelisk', x: 8, y: 8 };
  assert.equal(ai.boosterScore(another), 800, 'grail known → no obelisk bonus');
});
