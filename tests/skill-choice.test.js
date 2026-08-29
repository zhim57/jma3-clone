/**
 * skill-choice.test.js — chooseSkill re-validates a stale multi-level burst
 * (2026-07 repo review, backlog item E47).
 *
 * A multi-level XP dump (a Pandora's Box) queues several pending skill choices,
 * all rolled against the SAME snapshot. chooseSkill used to apply each blindly,
 * so a later pick could push past the 8-skill cap or re-set a level it already
 * held. It now re-checks against the hero's current skills.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { SKILLS } from '../src/data/skills.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { chooseSkill } from '../src/core/actions.js';

const SKILL_IDS = Object.keys(SKILLS);

test('chooseSkill never exceeds the skill cap across a stale multi-level burst (E47)', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  // One below the cap, all at level 1.
  hero.skills = {};
  for (let i = 0; i < CONFIG.MAX_SECONDARY_SKILLS - 1; i++) hero.skills[SKILL_IDS[i]] = 1;

  const newA = SKILL_IDS[CONFIG.MAX_SECONDARY_SKILLS - 1];
  const newB = SKILL_IDS[CONFIG.MAX_SECONDARY_SKILLS];
  // Two choices rolled against the 7-skill snapshot, each learning a NEW skill.
  hero.pendingSkillChoices = [
    { options: [{ skill: newA, toLevel: 1 }] },
    { options: [{ skill: newB, toLevel: 1 }] },
  ];

  chooseSkill(s, hero, 0);
  assert.equal(Object.keys(hero.skills).length, CONFIG.MAX_SECONDARY_SKILLS, 'the first fills to the cap');
  assert.equal(hero.skills[newA], 1);

  chooseSkill(s, hero, 0); // this one would push to 9
  assert.equal(Object.keys(hero.skills).length, CONFIG.MAX_SECONDARY_SKILLS, 'the cap is not exceeded');
  assert.ok(!hero.skills[newB], 'the over-cap new skill was dropped');
});

test('chooseSkill turns a now-duplicate "learn" pick into an upgrade, not a wasted level (E47)', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.skills = {}; // room to learn
  const dup = SKILL_IDS[0];
  // Both choices were rolled to LEARN `dup` (it was unknown at snapshot time).
  hero.pendingSkillChoices = [
    { options: [{ skill: dup, toLevel: 1 }] },
    { options: [{ skill: dup, toLevel: 1 }] },
  ];
  chooseSkill(s, hero, 0);
  assert.equal(hero.skills[dup], 1, 'first learns it');
  chooseSkill(s, hero, 0);
  assert.equal(hero.skills[dup], 2, 'second upgrades it to the real next level — not a wasted re-set to 1');
});

test('chooseSkill falls back to the other option when the requested one is now invalid (E47)', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.skills = { [SKILL_IDS[0]]: 3 }; // one mastered skill
  // Option 0 (upgrade the mastered skill) is now impossible; option 1 (a new
  // skill) is still valid — the pick must fall through to it.
  hero.pendingSkillChoices = [
    { options: [{ skill: SKILL_IDS[0], toLevel: 3 }, { skill: SKILL_IDS[1], toLevel: 1 }] },
  ];
  chooseSkill(s, hero, 0);
  assert.equal(hero.skills[SKILL_IDS[0]], 3, 'the maxed skill is untouched');
  assert.equal(hero.skills[SKILL_IDS[1]], 1, 'fell back to the still-valid new skill');
});
