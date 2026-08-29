/**
 * ai-retreat.test.js — the AI hero retreat/flee behavior (2026-07 repo review,
 * backlog G63).
 *
 * The AI had no flee goal: a collector caught in the open by a superior enemy
 * stood and died (or chased loot it couldn't safely reach). pickGoal now adds a
 * high-priority "run for the nearest own town" goal when a hero out in the field
 * is outmatched by an enemy that can reach it — the survival counterpart to the
 * town-turtle (which defends a threatened TOWN, not a threatened hero). This test
 * isolates the new behavior by keeping the menace OUTSIDE the town's threat
 * radius, so the turtle logic can't fire and only the retreat can.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { armyValue } from '../src/core/heroUtils.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const HUMAN = 0;
const AI = 1;
const stack = (creature, count) => [{ creature, count, hurt: 0 }, null, null, null, null, null, null];

function clearTile(state, x, y) {
  const t = state.map.tiles[y * state.map.w + x];
  if (t.objectId && state.map.objects[t.objectId]?.type !== 'town') { delete state.map.objects[t.objectId]; t.objectId = null; }
  t.obstacle = null;
  t.terrain = 'grass';
}

function runTurn(state) {
  const ai = new AITurnController(state, AI);
  const combats = [];
  let guard = 200, r;
  do {
    r = ai.next();
    if (r.type === 'combat') { combats.push(r.context); ai.autoFight(r.context); }
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return combats;
}

test('G63: a cornered weak hero flees toward its own town instead of standing to die', () => {
  const s = newGame({ seed: 4242 });
  const town = playerTowns(s, AI)[0];
  const dir = town.x < s.map.w / 2 ? 1 : -1;

  // Clear a long open corridor from the town outward and stand the AI hero far
  // down it — 10 tiles out, well past the town's 8-tile threat radius.
  for (let k = 0; k <= 13; k++) {
    for (let dy = -1; dy <= 1; dy++) clearTile(s, town.x + k * dir, town.y + dy);
  }
  const hero = playerHeroes(s, AI)[0];
  if (hero.inTownId) { s.towns[hero.inTownId].visitingHeroId = null; hero.inTownId = null; }
  hero.x = town.x + 10 * dir; hero.y = town.y; hero.z = 0;
  hero.army = stack('pikeman', 5);      // weak
  const startDist = Math.abs(hero.x - town.x);

  // A vastly superior enemy hero ADJACENT to our hero, but 11 tiles from the town
  // (outside its threat radius) — so the town-turtle can't fire, only the retreat.
  const enemy = playerHeroes(s, HUMAN)[0];
  enemy.x = town.x + 11 * dir; enemy.y = town.y; enemy.z = 0;
  enemy.army = stack('archangel', 100);

  const ai = new AITurnController(s, AI);
  assert.equal(ai.townThreat(town), 0, 'the menace is outside the town threat radius (turtle cannot fire)');
  assert.ok(ai.threatNear(hero.x, hero.y, 0) > armyValue(hero.army),
    'the adjacent enemy outmatches our hero (it is genuinely in danger)');

  const combats = runTurn(s);
  assert.equal(combats.length, 0, 'it did not throw itself at the superior enemy');

  // What G63 is about is the DECISION, so it is asserted from the goal recorder
  // rather than from where the hero happens to stand at the end of the turn.
  //
  // The distinction is not pedantry — it was found the hard way. This block used
  // to require the hero to still be alive after runTurn(), which is a whole AI
  // turn: retreat, then a chest, then a dwelling, then whatever else the day
  // affords. When the combat XP currency changed (HP -> creature value, 2026-08)
  // this test failed on its seed while the retreat itself was working perfectly —
  // the recorder showed `retreat to refuge` chosen first at score 1455 and
  // reported `achieved`, after which the hero went shopping and died to a
  // creature bank eleven tiles away. That death says nothing about G63. Any
  // change that shifts the rng stream (gainXp draws for the stat roll and the
  // skill offer) can move an unrelated fight into range, so the survival
  // assertion was measuring the rest of the turn, not the flee.
  const goals = (s.aiLog || []).filter((e) => e.kind === 'goal' && e.heroId === hero.id);
  assert.ok(goals.length, 'the goal recorder saw this hero');
  assert.match(goals[0].to, /retreat/i,
    `the FIRST goal it picked was the retreat (got "${goals[0].to}")`);
  assert.ok(goals[0].toScore > 0 && goals[0].dist === startDist,
    'aimed at the refuge from where it stood');

  // If it is still on the map, it must also have physically closed on the town
  // and opened distance from the menace. When a later, unrelated goal kills it,
  // the recorder above is the evidence and this is skipped rather than faked.
  const survivor = s.heroes[hero.id];
  if (survivor) {
    assert.ok(Math.abs(survivor.x - town.x) < startDist,
      `it fled toward the refuge (dist ${startDist} → ${Math.abs(survivor.x - town.x)})`);
    assert.ok(Math.abs(survivor.x - enemy.x) > 1, 'it opened distance from the menace');
  } else {
    assert.ok(goals.length > 1 && goals[1].from === goals[0].to && goals[1].reason === 'achieved',
      'it reached the refuge before anything else in the turn could finish it');
  }
});

test('G63: the retreat is gated on being OUTMATCHED — a strong hero turns and fights', () => {
  const s = newGame({ seed: 4242 });
  const town = playerTowns(s, AI)[0];
  const dir = town.x < s.map.w / 2 ? 1 : -1;
  for (let k = 0; k <= 13; k++) {
    for (let dy = -1; dy <= 1; dy++) clearTile(s, town.x + k * dir, town.y + dy);
  }
  const hero = playerHeroes(s, AI)[0];
  if (hero.inTownId) { s.towns[hero.inTownId].visitingHeroId = null; hero.inTownId = null; }
  hero.x = town.x + 10 * dir; hero.y = town.y; hero.z = 0;
  hero.army = stack('archangel', 200);   // overwhelming — NOT in danger

  // The same nearby enemy as the flee case, but now far weaker than our hero.
  const enemy = playerHeroes(s, HUMAN)[0];
  enemy.x = town.x + 11 * dir; enemy.y = town.y; enemy.z = 0;
  enemy.army = stack('pikeman', 5);

  const ai = new AITurnController(s, AI);
  assert.ok(ai.threatNear(hero.x, hero.y, 0) < armyValue(hero.army),
    'our hero outmatches the neighbour — it is not in danger, so the retreat must not fire');
  const startDist = Math.abs(hero.x - town.x);
  const combats = runTurn(s);
  const h = s.heroes[hero.id];
  // It engaged the enemy it can beat, and did NOT flee home to a phantom refuge.
  const fought = combats.length > 0 || !s.heroes[enemy.id];
  assert.ok(fought || Math.abs(h.x - town.x) >= startDist,
    'a superior hero turns on the beatable enemy rather than retreating');
});

test('G63: the retreat refuses a step that walks INTO the menace', () => {
  // The mechanism, pinned on its own rather than through a whole AI turn. The
  // integration test above depends on everything else the AI does that turn —
  // hiring, building, neutral fights — and every one of those consumes
  // state.rng, so it re-rolls whenever anything upstream changes. (It did: the
  // 2026-08 experience-currency fix altered how many levels are gained, and
  // gainXp draws for the stat roll and the skill offer.) This test asks the
  // question directly and cannot drift.
  const s = newGame({ seed: 4242 });
  const hero = playerHeroes(s, AI)[0];
  const enemy = playerHeroes(s, HUMAN)[0];
  hero.z = 0; enemy.z = 0;
  hero.army = stack('pikeman', 5);
  enemy.army = stack('archangel', 100);
  hero.x = 20; hero.y = 20;
  enemy.x = 24; enemy.y = 20;              // four tiles east, well inside THREAT_RADIUS
  const ai = new AITurnController(s, AI);

  // Not retreating: the guard is inert, whatever the step.
  hero.aiGoal = { key: 'artifact|A1' };
  assert.equal(ai.isRetreating(hero), false);

  hero.aiGoal = { key: 'retreat to refuge|T1' };
  assert.equal(ai.isRetreating(hero), true);

  // Stepping AWAY (west) is always allowed.
  assert.equal(ai.stepEntersReach(hero, { x: 19, y: 20 }), false, 'fleeing west is fine');
  // Stepping east closes the gap but not into contact — still allowed, because a
  // refuge can lie past the menace and the flight has to be able to round it.
  assert.equal(ai.stepEntersReach(hero, { x: 21, y: 20 }), false, '4 -> 3 tiles is not contact');
  // Stepping to the enemy's shoulder is refused: that is how a retreat dies.
  hero.x = 22;
  assert.equal(ai.stepEntersReach(hero, { x: 23, y: 20 }), true, '2 -> 1 tile is contact');
  // Already in contact, any step is permitted — the hero still has to move.
  hero.x = 23;
  assert.equal(ai.stepEntersReach(hero, { x: 23, y: 21 }), false, 'already adjacent, keep moving');
  // No menace in range at all: nothing to refuse.
  enemy.x = 60; enemy.y = 60;
  hero.x = 20;
  assert.equal(ai.stepEntersReach(hero, { x: 21, y: 20 }), false, 'no menace, no veto');
});
