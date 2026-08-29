/**
 * ai-disguise.test.js — the Disguise spell actually deceives the AI (2026-07 repo
 * review, backlog item B15).
 *
 * The AI read exact enemy army values (armyValue(h.army)) everywhere it sized a
 * threat or an attack, so Disguise — which hides a hero's true army from scouting
 * — did nothing against the game's only opponent. The AI now values a DISGUISED
 * enemy pessimistically (at least as strong as its own best hero), so a disguised
 * weak raider reads as a credible threat and a disguised hero deters attacks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1;
const HUMAN = 0;

function setup() {
  const state = newGame({
    seed: 4242,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const aiHero = playerHeroes(state, AI)[0];
  aiHero.army = [{ creature: 'archangel', count: 20 }, null, null, null, null, null, null]; // a strong AI
  const enemy = playerHeroes(state, HUMAN)[0];
  enemy.army = [{ creature: 'peasant', count: 1 }, null, null, null, null, null, null]; // truly weak
  return { state, ai: new AITurnController(state, AI), enemy };
}

test('a disguised enemy is valued pessimistically, not by its true (weak) army (B15)', () => {
  const { ai, enemy } = setup();

  enemy.disguised = false;
  const seen = ai.enemyHeroValue(enemy); // the AI reads the weak army
  enemy.disguised = true;
  const hidden = ai.enemyHeroValue(enemy); // now it can't

  assert.ok(seen > 0 && seen < 1000, 'a lone peasant is genuinely weak when visible');
  assert.equal(hidden, ai.myStrongestArmyValue(), 'a disguised hero is priced at our own best army');
  assert.ok(hidden > seen, 'disguise raises the AI\'s estimate far above the true army');
});

test('a disguised weak raider next to our town registers as a real threat (B15)', () => {
  const { state, ai, enemy } = setup();
  const town = playerTowns(state, AI)[0];
  enemy.x = town.x + 1; enemy.y = town.y; enemy.z = town.z ?? 0;
  enemy.disguised = true;

  assert.equal(ai.threatNear(town.x, town.y, town.z ?? 0), ai.myStrongestArmyValue(),
    'the disguised raider is the strongest apparent menace, not a dismissible peasant');
  assert.equal(ai.heroMenacesUs(enemy), true, 'and it credibly threatens the town');
});
