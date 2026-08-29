/**
 * battle-spoils.test.js — post-battle "spoils of war" feedback.
 *
 * Defeating an enemy hero already transfers its worn + carried artifacts to the
 * victor (lootHero → giveArtifact); this covers the EVENTS that surface it so the
 * UI can show what was claimed — and that a hero which FLED yields no loot but
 * still tells the victor why. Engine only, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { applyCombatResult } from '../src/core/actions.js';

const evOf = (events, type) => events.find((e) => e.type === type);
const keptArmy = (h) => h.army.filter(Boolean).map((x) => ({ ...x }));

test('defeating an enemy hero emits artifactsLooted with the transferred artifacts', () => {
  const s = newGame({ seed: 3 });
  const attacker = playerHeroes(s, 0)[0];
  const enemy = playerHeroes(s, 1)[0];
  enemy.equipment = { weapon: 'centaurAxe' };
  enemy.backpack = ['bootsOfSpeed'];
  const ctx = { attackerHeroId: attacker.id, defenderHeroId: enemy.id, defender: { kind: 'hero', heroId: enemy.id } };

  const events = applyCombatResult(s, ctx, {
    attackerWon: true, attackerArmy: keptArmy(attacker), defenderArmy: [], xp: 100, escape: null,
  });

  const ev = evOf(events, 'artifactsLooted');
  assert.ok(ev, 'emitted artifactsLooted');
  assert.equal(ev.heroId, attacker.id, 'the winning attacker is named as the looter');
  assert.deepEqual([...ev.artifacts].sort(), ['bootsOfSpeed', 'centaurAxe'], 'lists worn + carried artifacts');
  // The transfer really happened (equipped into free slots or stowed).
  const owned = new Set([...Object.values(attacker.equipment).filter(Boolean), ...attacker.backpack]);
  assert.ok(owned.has('centaurAxe') && owned.has('bootsOfSpeed'), 'the artifacts moved to the victor');
});

test('the DEFENDING victor is named when a player hero repels and kills the attacker', () => {
  const s = newGame({ seed: 3 });
  const defender = playerHeroes(s, 0)[0];       // the human defends
  const attacker = playerHeroes(s, 1)[0];       // AI attacked and will lose
  attacker.equipment = { weapon: 'centaurAxe' };
  const ctx = { attackerHeroId: attacker.id, defenderHeroId: defender.id, defender: { kind: 'hero', heroId: defender.id } };

  const events = applyCombatResult(s, ctx, {
    attackerWon: false, attackerArmy: [], defenderArmy: keptArmy(defender), xp: 100, escape: null,
  });

  const ev = evOf(events, 'artifactsLooted');
  assert.ok(ev, 'emitted artifactsLooted on a successful defense');
  assert.equal(ev.heroId, defender.id, 'the defending victor is the looter, not the attacker');
  assert.deepEqual(ev.artifacts, ['centaurAxe']);
});

test('defeating a bare enemy hero emits NO spoils event', () => {
  const s = newGame({ seed: 3 });
  const attacker = playerHeroes(s, 0)[0];
  const enemy = playerHeroes(s, 1)[0];
  enemy.equipment = {}; enemy.backpack = [];
  const ctx = { attackerHeroId: attacker.id, defenderHeroId: enemy.id, defender: { kind: 'hero', heroId: enemy.id } };

  const events = applyCombatResult(s, ctx, {
    attackerWon: true, attackerArmy: keptArmy(attacker), defenderArmy: [], xp: 50, escape: null,
  });
  assert.ok(!evOf(events, 'artifactsLooted'), 'no artifacts carried → no spoils event');
});

test('a fled enemy hero yields no loot but emits heroFled to the victor', () => {
  const s = newGame({ seed: 3 });
  const attacker = playerHeroes(s, 0)[0];       // the human attacks
  const enemy = playerHeroes(s, 1)[0];          // AI defends and flees
  enemy.equipment = { weapon: 'centaurAxe' };
  const ctx = { attackerHeroId: attacker.id, defenderHeroId: enemy.id, defender: { kind: 'hero', heroId: enemy.id } };

  const events = applyCombatResult(s, ctx, {
    attackerWon: true, attackerArmy: keptArmy(attacker),
    defenderArmy: [{ creature: 'pikeman', count: 1 }], xp: 0,
    escape: { side: 1, mode: 'retreat', goldPaid: 0 },
  });

  const fled = evOf(events, 'heroFled');
  assert.ok(fled, 'emitted heroFled');
  assert.equal(fled.heroId, attacker.id, 'the victor (attacker) is told');
  assert.ok(!evOf(events, 'artifactsLooted'), 'a fled hero keeps its gear — no spoils');
});
