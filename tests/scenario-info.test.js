/**
 * scenario-info.test.js — the text the scenario-info panel & chapter intro show:
 * victory objective and loss condition, derived from state.victory. Engine only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { victoryObjectiveLabel, victoryObjectiveText, lossConditionText } from '../src/core/actions.js';

test('victoryObjectiveLabel covers every authored victory kind', () => {
  assert.match(victoryObjectiveLabel({}), /Defeat all enemies/);
  assert.match(victoryObjectiveLabel({ kind: 'defeatHero' }), /champion/i);
  assert.match(victoryObjectiveLabel({ kind: 'flagMines' }), /every mine/i);
  assert.match(victoryObjectiveLabel({ kind: 'accumulateGold', goldTarget: 35000 }), /35,?000 gold/);
  assert.match(victoryObjectiveLabel({ kind: 'surviveN', surviveDays: 120 }), /day 120/);
  assert.match(victoryObjectiveLabel({ grail: true }), /Grail/);
});

test('victoryObjectiveText names a concrete target when the live state has one', () => {
  const state = {
    victory: { kind: 'defeatHero', targetHeroId: 'H9' },
    heroes: { H9: { id: 'H9', name: 'The Herald of Ash' } }, towns: {},
  };
  assert.equal(victoryObjectiveText(state), 'Defeat The Herald of Ash');
  // Falls back to the generic label when no target is resolved.
  assert.match(victoryObjectiveText({ victory: { kind: 'flagMines', mineType: 'gold' } }), /every/i);
});

test('lossConditionText is generic, sharpened by a survive deadline', () => {
  assert.match(lossConditionText({ victory: {} }), /lose your last town and hero/i);
  assert.match(lossConditionText({ victory: { kind: 'surviveN', surviveDays: 100 } }), /before day 100/);
});
