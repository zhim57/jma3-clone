/**
 * adventure-ai.test.js — Pins the strategic adventure-map AI improvements.
 *
 * Each test here asserts behavior the old naive controller did NOT have:
 * market-unblocked builds, scored skill picks, earlier second-hero hires,
 * backpack artifacts actually worn, goal/path caching, and holding a
 * threatened home town. All tests are headless and deterministic: they build
 * a real game with a fixed seed, hand-shape the relevant state, then drive a
 * full AI turn through the public controller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const SEED = 4242;
const AI = 1; // player index of the AI opponent in a fresh game

/** Drive a full AI turn; auto-resolve any interactive battles. */
function runTurn(state, playerIndex = AI) {
  const ai = new AITurnController(state, playerIndex);
  let guard = 200;
  let r;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return ai;
}

/** Zero out movement so a test exercises ONLY town/level-up/equipment logic. */
function freezeHeroes(state, playerIndex = AI) {
  for (const h of playerHeroes(state, playerIndex)) h.mp = 0;
}

/** Make (x, y) an empty walkable tile (for hand-placing heroes). */
function clearTile(state, x, y) {
  const t = state.map.tiles[y * state.map.w + x];
  if (t.objectId) {
    delete state.map.objects[t.objectId];
    t.objectId = null;
  }
  t.obstacle = null;
  t.terrain = 'grass';
}

// ---------------------------------------------------------------------------

test('marketplace: sells surplus to unblock a resource-blocked priority build', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  town.buildings.push('marketplace');
  const res = s.players[AI].resources;
  // Town Hall (2500 gold) is the top build priority but gold is short, while
  // wood piles up unused. The old AI skipped it and built a dwelling instead.
  res.gold = 2000;
  res.wood = 40;
  res.ore = 20;
  freezeHeroes(s);

  runTurn(s);

  assert.ok(town.buildings.includes('townHall'), 'sold surplus to build the Town Hall');
  assert.ok(res.wood < 40, 'surplus wood was actually sold');
  assert.ok(res.wood >= 5, 'kept a working buffer of wood');
});

test('level-up: picks the highest-value offered skill, not blindly option 0', () => {
  const s = newGame({ seed: SEED });
  freezeHeroes(s);
  const hero = playerHeroes(s, AI)[0];
  // Option 0 is a dud for a might hero; option 1 is the tempo king.
  hero.pendingSkillChoices = [{
    options: [
      { skill: 'mysticism', toLevel: 1 },
      { skill: 'logistics', toLevel: 1 },
    ],
  }];

  runTurn(s);

  assert.equal(hero.skills.logistics, 1, 'took Logistics');
  assert.ok(!hero.skills.mysticism, 'did not take option 0 by default');
  assert.equal(hero.pendingSkillChoices.length, 0, 'no level-ups left pending');
});

test('hires a second hero when gold clearly allows (below the old 6000 bar)', () => {
  const s = newGame({ seed: SEED });
  // 5000 gold: comfortably covers the 2500 hire plus a build, but the old
  // controller demanded > 6000 AFTER build+recruit spending and never hired.
  s.players[AI].resources.gold = 5000;
  freezeHeroes(s);

  runTurn(s);

  assert.equal(playerHeroes(s, AI).length, 2, 'second hero fielded');
});

test('equips the strongest backpack artifact, displacing weaker gear', () => {
  const s = newGame({ seed: SEED });
  freezeHeroes(s);
  const hero = playerHeroes(s, AI)[0];
  hero.equipment.weapon = 'centaurAxe'; // +2 attack, value 1
  hero.backpack.push('titansGladius'); // +6 attack, value 4 — was never worn

  runTurn(s);

  assert.equal(hero.equipment.weapon, 'titansGladius', 'best weapon worn');
  assert.ok(hero.backpack.includes('centaurAxe'), 'displaced weapon kept in backpack');
});

test('move trail: the AI records each tile-step so the scene can replay movement', () => {
  const s = newGame({ seed: SEED });
  const ai = runTurn(s);
  assert.ok(Array.isArray(ai.moveLog), 'a view-only move trail is exposed');
  assert.ok(ai.moveLog.length > 0, 'the AI moved and logged it');
  for (const m of ai.moveLog) {
    assert.equal(typeof m.heroId, 'string');
    const dx = Math.abs(m.to.x - m.from.x);
    const dy = Math.abs(m.to.y - m.from.y);
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0, 'each trail entry is a single adjacent tile hop');
  }
});

test('path caching: goals and paths computed per plan, not per tile', () => {
  const s = newGame({ seed: SEED });
  const ai = runTurn(s);

  // Heroes actually marched...
  assert.ok(ai.metrics.steps >= 8, `heroes marched (${ai.metrics.steps} steps)`);
  // ...but the whole-map goal scan and the full A* ran far less than once per
  // tile. The old controller re-ran BOTH for every single step.
  assert.ok(
    ai.metrics.pathfinds <= ai.metrics.steps / 2,
    `A* runs (${ai.metrics.pathfinds}) far fewer than steps (${ai.metrics.steps})`,
  );
  assert.ok(
    ai.metrics.goalPicks <= ai.metrics.steps / 2,
    `goal scans (${ai.metrics.goalPicks}) far fewer than steps (${ai.metrics.steps})`,
  );
});

test('defense: a hero holds its threatened home town instead of wandering off', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  const hero = playerHeroes(s, AI)[0];
  // Park the AI hero inside its own town...
  hero.x = town.x;
  hero.y = town.y;
  hero.inTownId = town.id;
  town.visitingHeroId = hero.id;
  // ...with an overwhelming human army camped just outside the walls.
  const enemy = playerHeroes(s, 0)[0];
  clearTile(s, town.x - 3, town.y);
  enemy.x = town.x - 3;
  enemy.y = town.y;
  enemy.army = [{ creature: 'archangel', count: 200, hurt: 0 }, null, null, null, null, null, null];

  runTurn(s);

  assert.equal(hero.inTownId, town.id, 'stayed in the town');
  assert.equal(hero.x, town.x);
  assert.equal(hero.y, town.y);
});
