/**
 * difficulty.test.js — the HoMM3-style difficulty handicap.
 *
 * On harder settings the human starts with a smaller resource pile while the AI
 * starts richer AND earns more each day (dailyIncome). Normal is the neutral ×1
 * baseline, so every pre-existing test (which never passes a difficulty) is
 * unaffected. Covers the starting-pile scaling, the AI daily-income scaling
 * (human income never touched), defaults/unknown handling, and save round-trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, RESOURCES } from '../src/config.js';
import { newGame, serialize, deserialize } from '../src/core/GameState.js';
import { dailyIncome } from '../src/core/actions.js';

const SEED = 3;

test('difficulty table: every ordered id is fully defined; Normal is the ×1 baseline', () => {
  assert.ok(CONFIG.DIFFICULTIES[CONFIG.DEFAULT_DIFFICULTY], 'the default difficulty exists');
  for (const id of CONFIG.DIFFICULTY_ORDER) {
    const d = CONFIG.DIFFICULTIES[id];
    assert.ok(d, `${id} is defined`);
    for (const k of ['label', 'human', 'ai', 'aiIncome']) {
      assert.equal(typeof d[k] === (k === 'label' ? 'string' : 'number'), true, `${id}.${k}`);
    }
  }
  assert.deepEqual(CONFIG.DIFFICULTIES.normal, { label: 'Normal', human: 1, ai: 1, aiIncome: 1 });
});

test('starting resources: harder shrinks the human pile and swells the AI pile', () => {
  const easy = newGame({ seed: SEED, difficulty: 'easy' });
  const norm = newGame({ seed: SEED, difficulty: 'normal' });
  const imp = newGame({ seed: SEED, difficulty: 'impossible' });

  // Human (player 0): easy > normal > impossible.
  assert.ok(easy.players[0].resources.gold > norm.players[0].resources.gold, 'easy gives more');
  assert.ok(imp.players[0].resources.gold < norm.players[0].resources.gold, 'impossible gives less');
  assert.equal(
    easy.players[0].resources.gold,
    Math.round(CONFIG.STARTING_RESOURCES.gold * CONFIG.DIFFICULTIES.easy.human),
    'exact human easy scaling',
  );
  // Normal ×1 is byte-identical to the base pile (no regression for old tests).
  assert.deepEqual(norm.players[0].resources, CONFIG.STARTING_RESOURCES);

  // AI (player 1): the opposite handicap — harder means a richer AI.
  assert.ok(imp.players[1].resources.gold > norm.players[1].resources.gold, 'AI richer on impossible');
  assert.ok(easy.players[1].resources.gold < norm.players[1].resources.gold, 'AI poorer on easy');
  assert.equal(
    imp.players[1].resources.gold,
    Math.round(CONFIG.STARTING_RESOURCES.gold * CONFIG.DIFFICULTIES.impossible.ai),
    'exact AI impossible scaling',
  );
});

test('dailyIncome: the AI take is scaled by difficulty; the human take never is', () => {
  const norm = newGame({ seed: SEED, difficulty: 'normal' });
  const imp = newGame({ seed: SEED, difficulty: 'impossible' });
  const mult = CONFIG.DIFFICULTIES.impossible.aiIncome;

  // AI (player 1): impossible income == round(baseline × aiIncome), per resource.
  const aiNorm = dailyIncome(norm, norm.players[1]);
  const aiImp = dailyIncome(imp, imp.players[1]);
  for (const r of RESOURCES) {
    assert.equal(aiImp[r] || 0, Math.round((aiNorm[r] || 0) * mult), `AI ${r} scaled`);
  }
  assert.ok((aiImp.gold || 0) > (aiNorm.gold || 0), 'the AI really does earn more');

  // Human (player 0): identical regardless of difficulty.
  assert.deepEqual(
    dailyIncome(imp, imp.players[0]),
    dailyIncome(norm, norm.players[0]),
    'human income is never handicapped',
  );
});

test('difficulty: default is Normal; an unknown value falls back to Normal', () => {
  const def = newGame({ seed: SEED });
  assert.equal(def.difficulty, 'normal');
  assert.deepEqual(def.players[0].resources, CONFIG.STARTING_RESOURCES);

  const bad = newGame({ seed: SEED, difficulty: 'lunatic' });
  assert.equal(bad.difficulty, 'normal', 'garbage difficulty is coerced to the default');
  assert.deepEqual(bad.players[0].resources, CONFIG.STARTING_RESOURCES);
});

test('difficulty round-trips through save/load', () => {
  const s = newGame({ seed: SEED, difficulty: 'hard' });
  const r = deserialize(serialize(s));
  assert.equal(r.difficulty, 'hard');
  // A pre-difficulty save (no field) still loads and reads as Normal in dailyIncome.
  const json = JSON.parse(serialize(s));
  delete json.difficulty;
  const legacy = deserialize(JSON.stringify(json));
  assert.doesNotThrow(() => dailyIncome(legacy, legacy.players[1]), 'old save still computes income');
});
