/**
 * level-up-screen.test.js — every level a HUMAN hero reaches queues a level-up
 * record (which primary rose, and whether a skill choice rides with it), so the
 * view can always show a statistics screen — including for a skill-capped hero,
 * which previously consumed its level silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, XP_TABLE } from '../src/config.js';
import { SKILLS } from '../src/data/skills.js';
import { newGame, serialize, deserialize } from '../src/core/GameState.js';
import { gainXp } from '../src/core/actions.js';

const PRIMARIES = ['attack', 'defense', 'power', 'knowledge'];

function game() {
  return newGame({ seed: 9, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
}
const humanHero = (s) => Object.values(s.heroes).find((h) => h.owner === 0);
const aiHero = (s) => Object.values(s.heroes).find((h) => h.owner === 1);

test('a level queues a record naming the primary that rose', () => {
  const s = game();
  const h = humanHero(s);
  const before = { ...h.stats };
  const gained = gainXp(s, h, 5000);
  assert.ok(gained >= 1, 'the hero levelled');
  assert.equal(h.pendingLevelUps.length, gained, 'one screen per level');
  const up = h.pendingLevelUps[0];
  assert.ok(PRIMARIES.includes(up.stat), `names a real primary (${up.stat})`);
  assert.equal(up.level, 2, 'stamped with the level reached');
  assert.equal(h.stats[up.stat], before[up.stat] + 1, 'and that primary really went up');
});

test('a MULTI-level gain queues every level, in order', () => {
  const s = game();
  const h = humanHero(s);
  gainXp(s, h, 500000);
  const levels = h.pendingLevelUps.map((u) => u.level);
  assert.ok(levels.length >= 3, 'several levels at once');
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'ascending, no gaps in order');
  assert.equal(levels[levels.length - 1], h.level, 'the last record is the current level');
});

test('a SKILL-CAPPED hero still queues a level — no more silent level-ups', () => {
  const s = game();
  const h = humanHero(s);
  // Fill every secondary slot so rollSkillChoice can offer nothing new, and max
  // each one so there is nothing to upgrade either.
  const ids = Object.keys(SKILLS).slice(0, CONFIG.MAX_SECONDARY_SKILLS);
  h.skills = {};
  for (const id of ids) h.skills[id] = SKILLS[id].levels.length;
  gainXp(s, h, 5000);
  assert.ok(h.pendingLevelUps.length >= 1, 'the level still reports itself');
  assert.equal(h.pendingLevelUps[0].choice, false, 'flagged as offering no skill choice');
  assert.ok(!h.pendingSkillChoices?.length, 'and no empty skill choice was queued');
});

test('the record flags whether a skill choice accompanies the level', () => {
  const s = game();
  const h = humanHero(s);
  h.skills = {}; // wide open — a choice should be offered
  gainXp(s, h, 5000);
  assert.ok(h.pendingLevelUps.every((u) => u.choice === true), 'every level offered a skill');
  assert.equal(h.pendingSkillChoices.length, h.pendingLevelUps.length,
    'one real choice queued per level, so the screen pairs them 1:1');
});

test('AI heroes queue NOTHING — no unread screens bloating the save', () => {
  const s = game();
  const ai = aiHero(s);
  gainXp(s, ai, 500000);
  assert.ok(ai.level > 1, 'the AI hero did level');
  assert.ok(!ai.pendingLevelUps, 'but queued no level-up screens');
});

test('queued level-ups round-trip through a save', () => {
  const s = game();
  const h = humanHero(s);
  gainXp(s, h, 5000);
  const back = deserialize(serialize(s));
  const bh = back.heroes[h.id];
  assert.deepEqual(bh.pendingLevelUps, h.pendingLevelUps, 'survives save/load');
});

test('XP_TABLE gives a next-level target mid-career and none at the cap', () => {
  // The screen reads XP_TABLE[level + 1] for "N to next level", and shows
  // "maximum level reached" when that is absent.
  assert.ok(XP_TABLE[2] > 0, 'level 2 has a threshold');
  assert.equal(XP_TABLE[CONFIG.HERO_MAX_LEVEL + 1], undefined, 'nothing beyond the cap');
});
