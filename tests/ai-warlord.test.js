/**
 * ai-warlord.test.js — AI Warlord personalities.
 *
 * Each AI player is dealt a named temperament at game start (see CONFIG.WARLORDS):
 * a pure tuning profile of three multipliers the controller folds into goal
 * scoring — `aggression` (how much it covets enemy towns/heroes), `economy`
 * (its pull toward resource prizes) and `exploration` (its pull toward
 * boosters/obelisks). The assignment is a deterministic hash of (seed, index)
 * that draws NO rng, so a seed's map stays byte-identical; the profile is plain
 * data, so it round-trips a save; and — critically — the safety gate is
 * untouched, so even a Conqueror only attacks from a winning position.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { CONFIG } from '../src/config.js';

const HUMAN = 0;
const AI = 1;
const threeWay = (seed) => newGame({ seed, players: [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
  { faction: 'inferno', isHuman: false, team: 2 },
] });

test('every AI player is dealt a real warlord profile; a human gets none', () => {
  const s = threeWay(100);
  assert.equal(s.players[HUMAN].warlord, null, 'the human has no AI temperament');
  for (const i of [1, 2]) {
    assert.ok(CONFIG.WARLORDS[s.players[i].warlord],
      `AI ${i} carries a warlord key that names a real profile`);
  }
});

test('a warlord depends only on (seed, index) — no rng, no roster coupling', () => {
  // The SAME index on the SAME seed gets the SAME temperament whether it shares
  // the game with one rival or two: the hash never touches state.rng or the
  // map-gen stream, so adding personalities cannot perturb a seed's world.
  const duo = newGame({ seed: 77, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const trio = threeWay(77);
  assert.equal(trio.players[1].warlord, duo.players[1].warlord,
    'AI at index 1 keeps its temperament regardless of who else joined');
  // Same seed twice ⇒ identical assignment AND identical map.
  const again = threeWay(77);
  assert.deepEqual(trio.players.map((p) => p.warlord), again.players.map((p) => p.warlord));
  assert.deepEqual(trio.map.tiles, again.map.tiles, 'the seed still yields the same map');
});

test('across seeds the dealt temperament varies (the hash is not degenerate)', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) seen.add(threeWay(seed).players[1].warlord);
  assert.ok(seen.size >= 3, `at least 3 distinct temperaments across 40 seeds (saw ${seen.size})`);
});

test('a warlord survives a save round-trip', () => {
  const s = threeWay(5);
  const before = s.players[1].warlord;
  const restored = deserialize(serialize(s));
  assert.equal(restored.players[1].warlord, before, 'the AI temperament round-trips a save');
});

test('an unknown/absent warlord falls back to the neutral Tactician (old saves unchanged)', () => {
  const s = threeWay(6);
  s.players[AI].warlord = undefined;              // an old save has no field
  const ai = new AITurnController(s, AI);
  assert.equal(ai.warlord, CONFIG.WARLORDS.tactician, 'missing profile ⇒ neutral Tactician');
  // The neutral profile is a true no-op: every multiplier is exactly 1.
  const t = CONFIG.WARLORDS.tactician;
  assert.deepEqual([t.aggression, t.economy, t.exploration], [1, 1, 1]);
});

// Strip the board to a controlled goal choice. Every tile is provably reachable
// (pickGoal with reach=null accepts all), the AI fields a crushing army so every
// candidate clears the safety gate, and the enemy hero is removed so nothing
// threatens or distracts — only the warlord's appetite decides. Returns pickGoal
// for `profile`, with `objects` on the map and the AI hero at (20,20).
function goalUnderProfile(seed, objects, profile, { keepEnemyTown = false } = {}) {
  const s = newGame({ seed, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const hero = playerHeroes(s, AI)[0];
  hero.x = 20; hero.y = 20; hero.z = 0; hero.inTownId = null;
  hero.army = [{ creature: 'archangel', count: 60, hurt: 0 }, null, null, null, null, null, null];
  delete s.heroes[playerHeroes(s, HUMAN)[0].id];

  const ownTown = Object.values(s.towns).find((t) => t.owner === AI);
  ownTown.x = 2; ownTown.y = 2; ownTown.z = 0; ownTown.visitingHeroId = null;
  const towns = { [ownTown.id]: ownTown };
  if (keepEnemyTown) {
    const enemyTown = Object.values(s.towns).find((t) => t.owner === HUMAN);
    enemyTown.x = 29; enemyTown.y = 20; enemyTown.z = 0;
    enemyTown.garrison = [null, null, null, null, null, null, null];
    enemyTown.visitingHeroId = null;
    towns[enemyTown.id] = enemyTown;
  }
  s.towns = towns;
  s.map.objects = objects;

  const ai = new AITurnController(s, AI);
  ai.mainHeroId = hero.id; // main hero ⇒ eco base 1, aggroMargin = courage
  ai.warlord = CONFIG.WARLORDS[profile];
  return ai.pickGoal(hero);
}

test('aggression steers the goal: a Conqueror storms the town a Steward skips for a mine', () => {
  // A FAR enemy town (distance 9) vs a NEAR gold mine (distance 2).
  const objects = { GM: { id: 'GM', type: 'mine', mineType: 'goldMine', x: 22, y: 20, z: 0 } };
  const conqueror = goalUnderProfile(21, objects, 'warmonger', { keepEnemyTown: true });
  const steward = goalUnderProfile(21, objects, 'industrialist', { keepEnemyTown: true });
  assert.deepEqual([conqueror.x, conqueror.y], [29, 20], 'the Conqueror marches on the enemy town');
  assert.deepEqual([steward.x, steward.y], [22, 20], 'the Steward takes the nearer gold mine instead');
});

test('exploration steers the goal: a Wayfarer detours for a booster a Steward skips for a mine', () => {
  // A NEAR booster (distance 1) vs a FAR gold mine (distance 9). A plain booster
  // is worth little, so only a high exploration appetite tips the near one over
  // the fat-but-distant mine — while the economy-minded Steward banks the gold.
  const objects = {
    LB: { id: 'LB', type: 'booster', boosterType: 'xp', x: 21, y: 20, z: 0 },
    GM: { id: 'GM', type: 'mine', mineType: 'goldMine', x: 29, y: 20, z: 0 },
  };
  const wanderer = goalUnderProfile(22, objects, 'wayfarer');
  const steward = goalUnderProfile(22, objects, 'industrialist');
  assert.deepEqual([wanderer.x, wanderer.y], [21, 20], 'the Wayfarer detours for the booster');
  assert.deepEqual([steward.x, steward.y], [29, 20], 'the Steward banks the gold mine instead');
});
