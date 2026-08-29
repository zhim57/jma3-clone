/**
 * victory-flag-mines.test.js — the "control every mine" victory condition
 * (HoMM3 parity). The human's team wins by flagging every mine on the map (or
 * every mine of a chosen type); a single mine in enemy or neutral hands keeps
 * the objective open, and the AI still wins only by elimination.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame } from '../src/core/GameState.js';
import { checkVictory, victoryObjectiveLabel, mineName } from '../src/core/actions.js';

const HUMAN_TEAM = 0;
// Build a game and take full control of the mine set: the generator seeds mines
// on BOTH levels (the objective spans both by design), so we clear the
// underground so each test's injected surface mines are the whole story.
const game = (victory) => {
  const s = newGame({ seed: 3, victory, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  if (s.map.underground) s.map.underground.objects = {};
  return s;
};
const mine = (id, mineType, owner) => ({ id, type: 'mine', mineType, x: 5, y: 5, owner });

test('the objective opens while any mine is unowned and settles once all are held', () => {
  const s = game({ kind: 'flagMines' });
  s.map.objects = { M1: mine('M1', 'goldMine', 0), M2: mine('M2', 'oreMine', 1) };
  assert.equal(checkVictory(s), null, 'an enemy-held mine keeps the objective open');

  s.map.objects.M2.owner = 0; // the human flags the last mine
  assert.equal(checkVictory(s), HUMAN_TEAM, 'holding every mine wins for the human team');
  assert.equal(s.winReason, 'mines');
});

test('a neutral (unflagged) mine also keeps the objective open', () => {
  const s = game({ kind: 'flagMines' });
  s.map.objects = { M1: mine('M1', 'goldMine', 0), M2: mine('M2', 'sawmill', -1) };
  assert.equal(checkVictory(s), null, 'a neutral mine is not yet yours');
});

test('the mineType filter counts only mines of that type', () => {
  const s = game({ kind: 'flagMines', mineType: 'goldMine' });
  // Both gold mines are the human's; an enemy ore mine is irrelevant to the goal.
  s.map.objects = {
    G1: mine('G1', 'goldMine', 0), G2: mine('G2', 'goldMine', 0),
    O1: mine('O1', 'oreMine', 1),
  };
  assert.equal(checkVictory(s), HUMAN_TEAM, 'controlling every GOLD mine suffices');
});

test('the AI controlling every mine does NOT win by this objective (elimination only)', () => {
  const s = game({ kind: 'flagMines' });
  s.map.objects = { M1: mine('M1', 'goldMine', 1), M2: mine('M2', 'oreMine', 1) };
  assert.equal(checkVictory(s), null, 'the enemy owning all mines is not a special win');
});

test('a map with no qualifying mines never awards the objective', () => {
  const s = game({ kind: 'flagMines', mineType: 'crystalCavern' });
  s.map.objects = { M1: mine('M1', 'goldMine', 0) }; // no crystal caverns exist
  assert.equal(checkVictory(s), null, 'no qualifying mines ⇒ nothing to win');
});

test('the objective label reads naturally, with and without a type filter', () => {
  assert.equal(victoryObjectiveLabel({ kind: 'flagMines' }), 'Control every mine');
  assert.equal(victoryObjectiveLabel({ kind: 'flagMines', mineType: 'goldMine' }),
    `Control every ${mineName('goldMine')}`);
});
