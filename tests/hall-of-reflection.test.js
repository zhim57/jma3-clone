/**
 * hall-of-reflection.test.js — #15 (opt-in): forget a hero skill for a fee.
 *
 * A level-scaled cost, the forget itself (frees the slot, leaves stats/XP alone),
 * its fail-closed guards, and the feature-gated buildability of the Hall.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerTowns } from '../src/core/GameState.js';
import { forgetSkill, forgetSkillCost, buildBlockReason } from '../src/core/actions.js';

const mkState = (gold = 100000) => ({ day: 1, log: [], players: [{ index: 0, resources: { gold } }] });
const mkHero = () => ({ name: 'Isra', level: 5, xp: 12000, stats: { attack: 6 }, skills: { logistics: 2, luck: 1 } });

test('forgetSkillCost scales with level', () => {
  assert.equal(forgetSkillCost({ level: 1 }), CONFIG.REFLECTION_DROP_COST);
  assert.equal(forgetSkillCost({ level: 5 }), 5 * CONFIG.REFLECTION_DROP_COST);
  assert.equal(forgetSkillCost({}), CONFIG.REFLECTION_DROP_COST, 'defaults to level 1');
});

test('forgetSkill: drops the chosen skill, charges the fee, leaves stats/XP alone', () => {
  const s = mkState(100000);
  const town = { owner: 0, buildings: ['hallOfReflection'] };
  const hero = mkHero();
  const res = forgetSkill(s, town, hero, 'logistics');
  assert.equal(res.ok, true);
  assert.equal(hero.skills.logistics, undefined, 'skill forgotten (slot freed)');
  assert.equal(hero.skills.luck, 1, 'other skills kept');
  assert.equal(hero.level, 5); assert.equal(hero.xp, 12000); assert.equal(hero.stats.attack, 6, 'stats/XP untouched');
  assert.equal(s.players[0].resources.gold, 100000 - 5 * CONFIG.REFLECTION_DROP_COST);
});

test('forgetSkill: fail-closed — no hall, unknown skill, or too poor → no change', () => {
  const hero = mkHero();
  assert.equal(forgetSkill(mkState(), { owner: 0, buildings: [] }, hero, 'logistics').ok, false, 'no hall');
  assert.equal(forgetSkill(mkState(), { owner: 0, buildings: ['hallOfReflection'] }, hero, 'wisdom').ok, false, 'skill not known');

  const poor = mkState(100);
  const town = { owner: 0, buildings: ['hallOfReflection'] };
  const res = forgetSkill(poor, town, hero, 'logistics');
  assert.equal(res.ok, false);
  assert.equal(hero.skills.logistics, 2, 'skill kept');
  assert.equal(poor.players[0].resources.gold, 100, 'no gold spent');
});

test('the Hall is only buildable when the feature is on', () => {
  const off = newGame({ seed: 4242, features: {} });
  const town = playerTowns(off, 0)[0];
  assert.match(buildBlockReason(off, town, 'hallOfReflection') || '', /disabled/, 'blocked when feature off');

  const on = newGame({ seed: 4242, features: { hallOfReflection: true } });
  const town2 = playerTowns(on, 0)[0];
  const reason = buildBlockReason(on, town2, 'hallOfReflection') || '';
  assert.doesNotMatch(reason, /disabled/, 'not feature-blocked when on (may still need prereqs/gold)');
});
