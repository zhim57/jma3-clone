/**
 * hero-persistence.test.js — retired heroes (fled / surrendered / defeated) go
 * into their OWNER's re-hire pool keeping XP + stats (and army if surrendered);
 * a defeated hero's artifacts go to the victor; re-hiring at a tavern brings the
 * veteran back. Roadmap #11 + #12. Escape/pool mechanics also live in
 * combat-escape.test.js; this covers the defeat-loot, re-hire and cost paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns, serialize, deserialize, nextObjectId } from '../src/core/GameState.js';
import { applyCombatResult, hireHero, hireableHeroes, rehireCost, hireCost, pooledHero } from '../src/core/actions.js';
import { CONFIG } from '../src/config.js';

const nStacks = (army) => army.filter((s) => s && s.count > 0).length;
/** Keep a player in the game (so losing a town+hero doesn't clear their pool). */
function keepAlive(s, owner) { s.heroes[`HKEEP_${owner}`] = { id: `HKEEP_${owner}`, owner, x: 2, y: 2, z: 0 }; }
/** A player's town with a working tavern and a free square. */
function tavernTown(s, owner) {
  const town = playerTowns(s, owner)[0];
  if (!town.buildings.includes('tavern')) town.buildings.push('tavern');
  town.visitingHeroId = null;
  return town;
}

test('defeat: hero retires to the pool; XP/stats kept; artifacts looted to the victor', () => {
  const s = newGame({ seed: 3 });
  const attacker = playerHeroes(s, 0)[0];
  const defender = playerHeroes(s, 1)[0];
  keepAlive(s, 1);
  defender.xp = 4200; defender.level = 4; defender.stats.attack = 9;
  defender.backpack = ['centaurAxe'];
  defender.army = [{ creature: 'pikeman', count: 5, hurt: 0 }, null, null, null, null, null, null];
  const ctx = { attackerHeroId: attacker.id, defenderHeroId: defender.id, defender: { kind: 'hero', heroId: defender.id } };
  applyCombatResult(s, ctx, { attackerWon: true, attackerArmy: [{ creature: 'archangel', count: 9 }], defenderArmy: [], xp: 0 });

  assert.equal(s.heroes[defender.id], undefined, 'defeated hero left the map');
  const pooled = s.players[1].heroPool.find((h) => h.id === defender.id);
  assert.ok(pooled, 'retired into its OWN owner\'s pool');
  assert.equal(pooled.xp, 4200, 'experience persists');
  assert.equal(pooled.level, 4, 'level persists');
  assert.equal(pooled.stats.attack, 9, 'stats persist');
  assert.equal(nStacks(pooled.army), 0, 'army lost');
  assert.equal(pooled.backpack.length, 0, 'artifacts stripped from the fallen hero');
  const attackerHas = Object.values(attacker.equipment).includes('centaurAxe') || attacker.backpack.includes('centaurAxe');
  assert.ok(attackerHas, 'the victor took the artifact');
});

test('re-hire: a pooled veteran returns with its XP/level/skills; armyless → a fresh army; costs rehireCost', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.xp = 6000; hero.level = 5; hero.skills = { ...hero.skills, wisdom: 2 }; hero.spells = ['bless'];
  const rosterId = hero.rosterId;
  const mid = nextObjectId(s);
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 99, x: hero.x + 2, y: hero.y };
  // Retreat into the pool (army lost). Player 0 still owns a town → not defeated.
  applyCombatResult(s, { attackerHeroId: hero.id, defender: { kind: 'monster', objectId: mid } },
    { attackerWon: false, attackerArmy: [], defenderArmy: [{ creature: 'peasant', count: 80 }], xp: 0,
      escape: { side: 0, mode: 'retreat', goldPaid: 0 } });
  assert.ok(s.players[0].heroPool.some((h) => h.id === hero.id), 'pooled after retreat');

  const town = tavernTown(s, 0);
  s.players[0].resources.gold = 100000;
  assert.ok(hireableHeroes(s, town).includes(rosterId), 'the veteran is offered at the tavern');
  assert.equal(hireCost(s, town, rosterId), rehireCost(hero), 'tavern quotes the re-hire price');
  const goldBefore = s.players[0].resources.gold;

  const back = hireHero(s, town, rosterId);
  assert.ok(back && s.heroes[back.id], 'the veteran is back on the map');
  assert.equal(back.id, hero.id, 'same hero (same id)');
  assert.equal(back.xp, 6000, 'XP restored');
  assert.equal(back.level, 5, 'level restored');
  assert.equal(back.skills.wisdom, 2, 'skills restored');
  assert.ok(back.spells.includes('bless'), 'spells restored');
  assert.ok(nStacks(back.army) > 0, 'lost army replaced with a fresh starting army');
  assert.equal(back.x, town.x, 'placed at the town');
  assert.equal(s.players[0].resources.gold, goldBefore - rehireCost(hero), 'paid the re-hire cost');
  assert.equal(s.players[0].heroPool.some((h) => h.id === hero.id), false, 'removed from the pool');
});

test('surrender then re-hire: the KEPT army is restored, not re-rolled', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const kept = [{ creature: 'pikeman', count: 7 }];
  s.players[0].resources.gold = 100000;
  const mid = nextObjectId(s);
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 99, x: hero.x + 2, y: hero.y };
  applyCombatResult(s, { attackerHeroId: hero.id, defender: { kind: 'monster', objectId: mid } },
    { attackerWon: false, attackerArmy: kept, defenderArmy: [{ creature: 'peasant', count: 80 }], xp: 0,
      escape: { side: 0, mode: 'surrender', goldPaid: 0 } });
  const town = tavernTown(s, 0);
  const back = hireHero(s, town, hero.rosterId);
  assert.equal(nStacks(back.army), 1, 'kept exactly the surrendered army');
  assert.equal(back.army.find((a) => a && a.count > 0).creature, 'pikeman');
  assert.equal(back.army.find((a) => a && a.count > 0).count, 7);
});

test('rehireCost scales with level (base at level 1, + premium per level)', () => {
  assert.equal(rehireCost({ level: 1 }), CONFIG.HERO_COST);
  assert.equal(rehireCost({ level: 5 }), CONFIG.HERO_COST + 4 * CONFIG.HERO_REHIRE_LEVEL_PREMIUM);
  assert.equal(rehireCost({}), CONFIG.HERO_COST, 'missing level treated as 1');
});

test('a fallen hero returns only to ITS OWN pool — the enemy cannot re-hire it', () => {
  const s = newGame({ seed: 3 });
  const attacker = playerHeroes(s, 0)[0];
  const defender = playerHeroes(s, 1)[0];
  keepAlive(s, 1);
  const rosterId = defender.rosterId;
  applyCombatResult(s, { attackerHeroId: attacker.id, defenderHeroId: defender.id, defender: { kind: 'hero', heroId: defender.id } },
    { attackerWon: true, attackerArmy: [{ creature: 'archangel', count: 9 }], defenderArmy: [], xp: 0 });

  assert.ok(pooledHero(s, 1, rosterId), 'in the loser\'s pool');
  assert.equal(pooledHero(s, 0, rosterId), null, 'NOT in the victor\'s pool');
  const enemyTown = tavernTown(s, 0);
  assert.equal(hireableHeroes(s, enemyTown).includes(rosterId), false, 'not offered at the enemy tavern');
});

test('the re-hire pool round-trips through save/load with XP + stats', () => {
  const s = newGame({ seed: 3 });
  const defender = playerHeroes(s, 1)[0];
  keepAlive(s, 1);
  defender.xp = 3300; defender.level = 3;
  applyCombatResult(s, { attackerHeroId: playerHeroes(s, 0)[0].id, defenderHeroId: defender.id, defender: { kind: 'hero', heroId: defender.id } },
    { attackerWon: true, attackerArmy: [{ creature: 'archangel', count: 9 }], defenderArmy: [], xp: 0 });
  const r = deserialize(serialize(s));
  const pooled = r.players[1].heroPool.find((h) => h.id === defender.id);
  assert.ok(pooled, 'pool survives the round-trip');
  assert.equal(pooled.xp, 3300);
  assert.equal(pooled.level, 3);
});

test('victory: a townless player whose last hero flees is defeated (a pooled hero cannot save them)', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 1)[0];
  // Strip player 1 of towns so the fleeing hero is their last asset.
  for (const t of playerTowns(s, 1)) t.owner = -1;
  const mid = nextObjectId(s);
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 99, x: hero.x + 2, y: hero.y };
  applyCombatResult(s, { attackerHeroId: playerHeroes(s, 0)[0].id, defenderHeroId: hero.id, defender: { kind: 'hero', heroId: hero.id } },
    { attackerWon: true, attackerArmy: [{ creature: 'archangel', count: 9 }], defenderArmy: [], xp: 0,
      escape: { side: 1, mode: 'retreat', goldPaid: 0 } });
  assert.equal(s.players[1].defeated, true, 'no town + no on-map hero → defeated');
  assert.equal(s.players[1].heroPool.length, 0, 'a vanquished player keeps no pool');
});
