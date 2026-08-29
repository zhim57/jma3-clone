/**
 * combat-escape.test.js — Retreat & Surrender (and the quick-resolve engine path).
 *
 * Retreat: the fleeing hero survives but loses its whole army (free).
 * Surrender: the fleeing hero survives and KEEPS its surviving army, for gold.
 * Either way the opponent takes the contested location like a normal winner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, tileAt, nextObjectId } from '../src/core/GameState.js';
import { applyCombatResult, surrenderCost } from '../src/core/actions.js';
import { escapeBattle, battleResult } from '../src/core/combat/CombatEngine.js';
import { CREATURES } from '../src/data/creatures.js';
import { CONFIG } from '../src/config.js';

const A = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
function clearPatch(s, cx, cy, r = 4) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const t = tileAt(s, cx + dx, cy + dy);
    if (t) { t.terrain = 'grass'; t.obstacle = null; t.objectId = null; }
  }
}
function nStacks(army) { return army.filter((a) => a && a.count > 0).length; }

test('escapeBattle: fleeing side loses; battleResult carries the escape tag + victor XP', () => {
  const battle = {
    over: false, winner: null, escape: null,
    units: [{ side: 0, alive: true, count: 5, creature: 'pikeman' },
      { side: 1, alive: true, count: 3, creature: 'archer' }],
    hpLost: [40, 15],
    valueLost: [400, 150],   // experience is denominated in creature value, not HP
  };
  escapeBattle(battle, 0, 'surrender', 500);
  assert.equal(battle.over, true);
  assert.equal(battle.winner, 1, 'attacker fled → defender is the winner');
  const r = battleResult(battle);
  assert.equal(r.attackerWon, false);
  assert.deepEqual(r.escape, { side: 0, mode: 'surrender', goldPaid: 500 });
  assert.equal(r.xp, battle.valueLost[0], 'the winner earns XP for the VALUE of what it killed');
  // A second escape call is a no-op (battle already over).
  escapeBattle(battle, 1, 'retreat');
  assert.equal(battle.winner, 1);
});

test('surrenderCost = CONFIG.SURRENDER_COST_MULT × army gold value', () => {
  const army = [{ creature: 'pikeman', count: 6 }, { creature: 'archer', count: 4 }];
  const raw = CREATURES.pikeman.cost.gold * 6 + CREATURES.archer.cost.gold * 4;
  assert.equal(surrenderCost(army), Math.round(raw * CONFIG.SURRENDER_COST_MULT));
  assert.equal(surrenderCost([]), 0);
});

test('attacker retreat: hero retires to the pool with NO army; the guard lives on; free', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.army = A.map((x) => (x ? { ...x } : null));
  const goldBefore = s.players[0].resources.gold;
  const mid = nextObjectId(s);
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 50, x: hero.x + 2, y: hero.y };
  const ctx = { attackerHeroId: hero.id, defender: { kind: 'monster', objectId: mid } };
  const result = {
    attackerWon: false, attackerArmy: [{ creature: 'pikeman', count: 6 }],
    defenderArmy: [{ creature: 'peasant', count: 40 }], xp: 0,
    escape: { side: 0, mode: 'retreat', goldPaid: 0 },
  };
  applyCombatResult(s, ctx, result);
  assert.equal(s.heroes[hero.id], undefined, 'fled hero left the map (#12)');
  const pooled = s.players[0].heroPool.find((h) => h.id === hero.id);
  assert.ok(pooled, 'retired into the owner\'s re-hire pool');
  assert.equal(nStacks(pooled.army), 0, 'army abandoned');
  assert.equal(s.map.objects[mid].count, 40, 'guard keeps its survivors');
  assert.equal(s.players[0].resources.gold, goldBefore, 'retreat is free');
});

test('attacker surrender: hero retires to the pool KEEPING its army and pays the gold price', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.army = A.map((x) => (x ? { ...x } : null));
  const kept = [{ creature: 'pikeman', count: 6 }];
  const cost = surrenderCost(kept);
  s.players[0].resources.gold = cost + 1000;
  const mid = nextObjectId(s);
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 50, x: hero.x + 2, y: hero.y };
  const ctx = { attackerHeroId: hero.id, defender: { kind: 'monster', objectId: mid } };
  applyCombatResult(s, ctx, {
    attackerWon: false, attackerArmy: kept, defenderArmy: [{ creature: 'peasant', count: 40 }], xp: 0,
    escape: { side: 0, mode: 'surrender', goldPaid: cost },
  });
  assert.equal(s.heroes[hero.id], undefined, 'left the map');
  const pooled = s.players[0].heroPool.find((h) => h.id === hero.id);
  assert.ok(pooled);
  assert.equal(nStacks(pooled.army), 1, 'army kept');
  assert.equal(pooled.army.find((a) => a && a.count > 0).count, 6);
  assert.equal(s.players[0].resources.gold, 1000, 'paid exactly the surrender cost');
});

test('surrender cost is recomputed from the kept army, not the caller-supplied goldPaid (E46)', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.army = A.map((x) => (x ? { ...x } : null));
  const kept = [{ creature: 'pikeman', count: 6 }];
  const realCost = surrenderCost(kept);
  s.players[0].resources.gold = realCost + 1000;
  const mid = nextObjectId(s);
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 50, x: hero.x + 2, y: hero.y };
  const ctx = { attackerHeroId: hero.id, defender: { kind: 'monster', objectId: mid } };
  applyCombatResult(s, ctx, {
    attackerWon: false, attackerArmy: kept, defenderArmy: [{ creature: 'peasant', count: 40 }], xp: 0,
    escape: { side: 0, mode: 'surrender', goldPaid: 0 }, // the view LIES: claims it's free
  });
  assert.equal(s.players[0].resources.gold, 1000,
    'the engine charged the real surrender cost, ignoring goldPaid: 0');
});

test('defender retreat (hero vs hero): the defender retires to ITS OWN pool; attacker wins + XP', () => {
  const s = newGame({ seed: 3 });
  const attacker = playerHeroes(s, 0)[0];
  const defender = playerHeroes(s, 1)[0];
  clearPatch(s, attacker.x, attacker.y, 5);
  defender.z = attacker.z ?? 0; defender.x = attacker.x + 1; defender.y = attacker.y;
  attacker.army = [{ creature: 'archangel', count: 50, hurt: 0 }, null, null, null, null, null, null];
  defender.army = [{ creature: 'pikeman', count: 8, hurt: 0 }, null, null, null, null, null, null];
  const xpBefore = attacker.xp;
  const ctx = { attackerHeroId: attacker.id, defenderHeroId: defender.id, defender: { kind: 'hero', heroId: defender.id } };
  applyCombatResult(s, ctx, {
    attackerWon: true, attackerArmy: [{ creature: 'archangel', count: 50 }],
    defenderArmy: [{ creature: 'pikeman', count: 3 }], xp: 200,
    escape: { side: 1, mode: 'retreat', goldPaid: 0 },
  });
  assert.equal(s.heroes[defender.id], undefined, 'the fleeing defender left the map');
  const pooled = s.players[1].heroPool.find((h) => h.id === defender.id);
  assert.ok(pooled, 'defender retired into its OWN owner\'s pool (enemy can\'t claim it)');
  assert.equal(nStacks(pooled.army), 0, 'defender army abandoned on retreat');
  assert.ok(attacker.xp > xpBefore, 'attacker earned the win XP');
});

test('defender surrender (town siege): town falls, defending hero retires with its army for gold', () => {
  const s = newGame({ seed: 3 });
  const attacker = playerHeroes(s, 0)[0];
  const town = playerTownForOwner(s, 1);
  assert.ok(town, 'AI town exists');
  clearPatch(s, town.x, town.y, 5);
  attacker.z = town.z ?? 0; attacker.x = town.x + 1; attacker.y = town.y;
  attacker.army = [{ creature: 'archangel', count: 50, hurt: 0 }, null, null, null, null, null, null];
  const defender = playerHeroes(s, 1)[0];
  defender.z = town.z ?? 0; defender.x = town.x; defender.y = town.y;
  town.visitingHeroId = defender.id;
  defender.army = [{ creature: 'pikeman', count: 8, hurt: 0 }, null, null, null, null, null, null];
  // Keep player 1 in the game (another hero elsewhere) so losing this town+hero
  // doesn't eliminate them — a vanquished player keeps no re-hire pool.
  s.heroes.HKEEP = { id: 'HKEEP', owner: 1, x: 2, y: 2, z: 0 };
  const kept = [{ creature: 'pikeman', count: 5 }];
  const cost = surrenderCost(kept);
  s.players[1].resources.gold = cost + 500;
  const ctx = {
    attackerHeroId: attacker.id, defenderHeroId: defender.id,
    defender: { kind: 'town', townId: town.id }, defenderReserve: [],
  };
  applyCombatResult(s, ctx, {
    attackerWon: true, attackerArmy: [{ creature: 'archangel', count: 50 }],
    defenderArmy: kept, xp: 200, escape: { side: 1, mode: 'surrender', goldPaid: cost },
  });
  assert.equal(town.owner, attacker.owner, 'the town was captured');
  assert.equal(s.heroes[defender.id], undefined, 'the defending hero left the map');
  const pooled = s.players[1].heroPool.find((h) => h.id === defender.id);
  assert.ok(pooled, 'defender retired into its pool');
  assert.equal(nStacks(pooled.army), 1, 'defender kept its army');
  assert.equal(s.players[1].resources.gold, 500, 'defender paid the surrender cost');
});

function playerTownForOwner(s, owner) {
  return Object.values(s.towns).find((t) => t.owner === owner);
}
