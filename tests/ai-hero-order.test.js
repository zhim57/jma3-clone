/**
 * ai-hero-order.test.js — the AI orders its heroes by NUMERIC id on an
 * army-value tie, not lexicographically (2026-07 repo review, backlog item B14).
 *
 * The tie-break was `a.id < b.id`, a string compare, so "H10" sorted before "H9"
 * — surprising (and, pre-save-v3, non-deterministic) leadership. It now compares
 * the numeric part, so H5 leads H10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1;

function clearTile(state, x, y) {
  const m = state.map;
  const t = m.tiles[y * m.w + x];
  t.obstacle = null; t.terrain = 'grass';
  if (t.objectId) { delete m.objects[t.objectId]; t.objectId = null; }
}

function runTurn(state) {
  const ai = new AITurnController(state, AI);
  let guard = 300, r;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return ai;
}

test('hero turn order tie-break is numeric: H5 leads H10 on equal armies (B14)', () => {
  const state = newGame({
    seed: 4242,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const h5 = playerHeroes(state, AI)[0]; // 'H5' at this seed
  const bigArmy = () => [{ creature: 'archangel', count: 20 }, null, null, null, null, null, null];
  h5.army = bigArmy();

  // A second AI hero whose id is lexicographically SMALLER but numerically LARGER
  // than H5 ("H10" < "H5" as strings), with an identical army so the id tie-break
  // alone decides who leads.
  const clone = JSON.parse(JSON.stringify(h5));
  clone.id = 'H10';
  clearTile(state, h5.x - 2, h5.y);
  clone.x = h5.x - 2; clone.y = h5.y;
  clone.army = bigArmy();
  state.heroes.H10 = clone;

  for (const h of playerHeroes(state, AI)) h.mp = 0; // freeze movement

  const ai = runTurn(state);
  assert.equal(ai.mainHeroId, 'H5', 'the numerically-first hero leads (old code picked "H10")');
});
