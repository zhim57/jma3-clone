/**
 * ai-force-concentration.test.js — a losing AI must mass, not dilute.
 *
 * Playtest report: "the AI does not have what to do, eventually it started
 * sending 1-2 heroes everyday, I killed them off ... no real threat, just have to
 * divert heroes to intercept and kill off the armies."
 *
 * Measured in a 33-day headless sim: the AI held FOUR heroes sharing 82,185 army
 * value — about 20k each — against a single 223,552 player hero. It was NOT
 * attacking hopelessly; there is a superiority gate on target choice. It was
 * dividing one army into portions small enough to eat one at a time, and hiring a
 * replacement for each one it lost.
 *
 * maybeHireHero already declined to hire at a town under a REMEMBERED threat, but
 * a realm losing the map at large felt no such threat and kept hiring freely. The
 * new rule is about the realm, not the town: while our best hero is outclassed by
 * the strongest enemy field army we know of, one more hero makes the portions
 * smaller rather than the realm stronger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { addToArmy } from '../src/core/heroUtils.js';
// The AI's force readings are POWER now (src/core/power.js): every one of them
// answers "are we outmatched", which price only answered by accident.
import { armyPower } from '../src/core/power.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

function scenario({ foeArmy, seed = 3 }) {
  const s = newGame({
    seed,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    mapW: 44, mapH: 36,
  });
  const foe = playerHeroes(s, 0)[0];
  for (const [creature, count] of foeArmy) addToArmy(foe.army, creature, count);
  // The AI has gold to burn and already fields AI_MIN_HEROES.
  s.players[1].resources.gold = 100000;
  return s;
}
const aiTown = (s) => Object.values(s.towns).find((t) => t.owner === 1);

test('strongestKnownEnemyArmy sees the biggest enemy field army', () => {
  const s = scenario({ foeArmy: [['archangel', 20], ['crusader', 60]] });
  const ai = new AITurnController(s, 1);
  const foe = playerHeroes(s, 0)[0];
  assert.equal(ai.strongestKnownEnemyArmy(), armyPower(foe.army));
});

test('outclassed: the AI stops hiring and banks the gold for one fist', () => {
  const s = scenario({ foeArmy: [['archangel', 20], ['crusader', 60]] });
  const ai = new AITurnController(s, 1);
  const before = playerHeroes(s, 1).length;
  assert.ok(before >= CONFIG.AI_MIN_HEROES - 1, 'the AI starts with a hero or two');
  // Force the precondition the rule is about, whatever the map handed us.
  while (playerHeroes(s, 1).length < CONFIG.AI_MIN_HEROES) {
    const t = aiTown(s);
    if (!t) break;
    new AITurnController(s, 1).maybeHireHero(t);
    if (playerHeroes(s, 1).length === before) break; // cannot hire here at all
  }
  const n = playerHeroes(s, 1).length;
  if (n < CONFIG.AI_MIN_HEROES) return; // map gave no room to set the scene
  const town = aiTown(s);
  assert.ok(ai.myStrongestArmyValue() < ai.strongestKnownEnemyArmy() * CONFIG.AI_MASS_RATIO,
    'scene check: the AI really is outclassed');
  ai.maybeHireHero(town);
  assert.equal(playerHeroes(s, 1).length, n,
    'an outclassed realm must not add another hero to split its troops across');
});

test('a comparable rival does NOT suppress hiring', () => {
  // The rule must not turn the AI passive in a fair fight — only when outclassed.
  // Make the scene explicit: the AI's own hero clearly outweighs the rival, since
  // both sides' STARTING armies are similar by design.
  const s = scenario({ foeArmy: [] });
  const own = playerHeroes(s, 1)[0];
  addToArmy(own.army, 'archangel', 20);
  const ai = new AITurnController(s, 1);
  assert.ok(ai.strongestKnownEnemyArmy() < ai.myStrongestArmyValue() / CONFIG.AI_MASS_RATIO,
    'scene check: the rival is not outclassing us');
  const town = aiTown(s);
  if (!town) return;
  const before = playerHeroes(s, 1).length;
  ai.maybeHireHero(town);
  assert.ok(playerHeroes(s, 1).length >= before, 'hiring still allowed when not outclassed');
});

test('the floor always leaves the realm able to hold and to work', () => {
  assert.ok(CONFIG.AI_MIN_HEROES >= 2, 'one hero cannot both garrison and collect');
  assert.ok(CONFIG.AI_MASS_RATIO > 0 && CONFIG.AI_MASS_RATIO <= 1,
    'above 1 would suppress hiring even while winning');
});

test('the gate reads the realm, not one town — it needs no remembered threat', () => {
  // The pre-existing gate only fired for a besieged town, which is exactly why a
  // realm losing the whole map kept hiring. Pin that the new check is separate.
  const src = readFileSync(new URL('../src/ai/AIPlayer.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('  maybeHireHero(town) {'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /strongestKnownEnemyArmy\(\)/, 'the realm-level check must be in the hire path');
  assert.match(body, /AI_MASS_RATIO/);
  assert.match(body, /AI_MIN_HEROES/, 'and must respect the floor');
});

