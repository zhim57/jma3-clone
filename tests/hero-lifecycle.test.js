/**
 * hero-lifecycle.test.js — world invariants across every way a hero leaves the
 * map (defeat, retreat/surrender, capture-with-a-town, owner vanquished).
 *
 * The seams under test (2026-07 repo review, "lifecycle cluster"):
 * - The Holy Grail never leaves the world: a victor seizes it from a defeated
 *   carrier; with no taker it returns to the earth (re-diggable).
 * - A `defeatHero` objective completes only on a genuine DEFEAT — never when
 *   the champion retreats/surrenders into the re-hire pool.
 * - Capturing an undefended town POOLS (and loots) the armyless visitor
 *   instead of erasing it from the world.
 * - captureTown settles a captureTown objective even for a NEUTRAL hold.
 * - checkVictory logs the conquest banner exactly once.
 * - Town Portal / Dimension Door off a boat moor the vessel instead of
 *   deleting it; disembarking cannot bypass a keyless Border Guard.
 * - A roster hero pooled by ANY player cannot be re-minted fresh by a rival.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns, tileAt, objectAt } from '../src/core/GameState.js';
import {
  applyCombatResult, stepHero, castAdventureSpell, checkVictory, digForGrail,
  hireableHeroes,
} from '../src/core/actions.js';
import { heroMaxMovement } from '../src/core/heroUtils.js';
import { HERO_ROSTER } from '../src/data/heroes.js';
import { ARTIFACTS } from '../src/data/artifacts.js';
import { CONFIG } from '../src/config.js';

const ARMY = () => [{ creature: 'pikeman', count: 20, hurt: 0 }, null, null, null, null, null, null];
const EMPTY_ARMY = () => [null, null, null, null, null, null, null];

function clearPatch(s, cx, cy, r = 3) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const t = tileAt(s, cx + dx, cy + dy);
    if (t) {
      t.terrain = 'grass'; t.obstacle = null;
      if (t.objectId && s.map.objects[t.objectId]?.type !== 'town') {
        delete s.map.objects[t.objectId]; t.objectId = null;
      }
    }
  }
}

function heroVsHeroCtx(attacker, defender) {
  return {
    attackerHeroId: attacker.id,
    defenderHeroId: defender.id,
    defender: { kind: 'hero', heroId: defender.id },
  };
}

test('Grail: the victor seizes it from a defeated carrier (never lost on a takedown)', () => {
  const s = newGame({ seed: 11 });
  const winner = playerHeroes(s, 0)[0];
  const carrier = playerHeroes(s, 1)[0];
  s.map.grail = { x: 5, y: 5 };
  s.grailDug = true;
  carrier.carryingGrail = true;

  applyCombatResult(s, heroVsHeroCtx(winner, carrier), {
    attackerWon: true, attackerArmy: ARMY(), defenderArmy: [], xp: 100,
  });

  assert.equal(winner.carryingGrail, true, 'the victor now carries the Grail');
  const pooled = s.players[1].heroPool.find((h) => h.id === carrier.id);
  assert.ok(pooled, 'the carrier retired to its pool');
  assert.equal(!!pooled.carryingGrail, false, 'the pooled hero does not smuggle the Grail off-map');
  assert.equal(s.grailDug, true, 'the Grail is still above ground, in the victor’s hands');
});

test('Grail: with no taker it returns to the earth and can be dug again', () => {
  const s = newGame({ seed: 11 });
  const carrier = playerHeroes(s, 0)[0];
  clearPatch(s, carrier.x, carrier.y, 4);
  s.map.grail = { x: carrier.x, y: carrier.y };
  s.grailDug = true;
  carrier.carryingGrail = true;

  // The carrier retreats from a monster — nobody looted it.
  const mid = `O${s.map.nextOid++}`;
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 50, x: carrier.x + 2, y: carrier.y };
  applyCombatResult(s, { attackerHeroId: carrier.id, defender: { kind: 'monster', objectId: mid } }, {
    attackerWon: false, attackerArmy: [], defenderArmy: [{ creature: 'peasant', count: 50 }],
    xp: 0, escape: { side: 0, mode: 'retreat', goldPaid: 0 },
  });

  assert.equal(s.grailDug, false, 'the Grail lies buried once more');
  const pooled = s.players[0].heroPool.find((h) => h.id === carrier.id);
  assert.equal(!!pooled.carryingGrail, false);
  assert.ok(s.log.some((l) => l.text.includes('buried once more')), 'the loss is logged');

  // Another hero can complete the race: re-dig at the same resting place.
  const digger = playerHeroes(s, 1)[0];
  digger.z = 0; digger.x = s.map.grail.x; digger.y = s.map.grail.y;
  digger.mp = heroMaxMovement(digger);
  const dig = digForGrail(s, digger);
  assert.equal(dig.found, true, 'the re-buried Grail is diggable again');
});

test('defeatHero objective: a retreat is an escape, not a defeat; a battle loss completes it', () => {
  const s = newGame({ seed: 7, victory: { kind: 'defeatHero' } });
  const targetId = s.victory.targetHeroId;
  assert.ok(targetId, 'an enemy champion was flagged at generation');
  const champion = s.heroes[targetId];
  const human = playerHeroes(s, 0)[0];

  // 1) The champion retreats from a neutral fight → still alive in the pool, no win.
  const mid = `O${s.map.nextOid++}`;
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 50, x: 3, y: 3 };
  applyCombatResult(s, { attackerHeroId: champion.id, defender: { kind: 'monster', objectId: mid } }, {
    attackerWon: false, attackerArmy: [], defenderArmy: [{ creature: 'peasant', count: 50 }],
    xp: 0, escape: { side: 0, mode: 'retreat', goldPaid: 0 },
  });
  assert.equal(s.winner, null, 'a fled champion has NOT fallen');

  // 2) Re-hired and genuinely defeated → objective completes.
  const pooled = s.players[champion.owner].heroPool.find((h) => h.id === targetId);
  s.heroes[targetId] = pooled; // back on the map (re-hire, minimal fixture)
  s.players[champion.owner].heroPool = [];
  pooled.x = human.x + 1; pooled.y = human.y; pooled.z = 0; pooled.army = EMPTY_ARMY();
  applyCombatResult(s, heroVsHeroCtx(human, pooled), {
    attackerWon: true, attackerArmy: ARMY(), defenderArmy: [], xp: 50,
  });
  assert.equal(s.winner, s.players[0].team ?? 0, 'the quarry has fallen — objective complete');
  assert.equal(s.winReason, 'defeatHero');
});

test('defeatHero objective: a champion pooled when its owner is vanquished counts as fallen', () => {
  const s = newGame({ seed: 7, victory: { kind: 'defeatHero' } });
  const targetId = s.victory.targetHeroId;
  const champion = s.heroes[targetId];
  const owner = s.players[champion.owner];

  // Champion escapes to the pool first (not a defeat)…
  const mid = `O${s.map.nextOid++}`;
  s.map.objects[mid] = { id: mid, type: 'monster', creature: 'peasant', count: 50, x: 3, y: 3 };
  applyCombatResult(s, { attackerHeroId: champion.id, defender: { kind: 'monster', objectId: mid } }, {
    attackerWon: false, attackerArmy: [], defenderArmy: [{ creature: 'peasant', count: 50 }],
    xp: 0, escape: { side: 0, mode: 'retreat', goldPaid: 0 },
  });
  assert.equal(s.winner, null);

  // …then its owner is starved out: towns lost, no heroes on the map.
  for (const t of playerTowns(s, owner.index)) t.owner = -1;
  for (const h of playerHeroes(s, owner.index)) delete s.heroes[h.id];
  checkVictory(s);
  assert.equal(owner.defeated, true, 'the owner was vanquished');
  assert.equal(s.victory.targetHeroDown, true, 'the pooled champion fell with its cause');
});

test('undefended-town capture: the armyless visitor is looted and pooled, not erased', () => {
  const s = newGame({ seed: 13 });
  const raider = playerHeroes(s, 0)[0];
  const town = playerTowns(s, 1)[0];
  const visitor = playerHeroes(s, 1)[0];
  const artifact = Object.keys(ARTIFACTS)[0];
  // Keep the defender alive after losing this town (otherwise defeatPlayer
  // correctly wipes its pool and the captive with it — a different rule).
  const spareTown = Object.values(s.towns).find((t) => t.owner < 0);
  assert.ok(spareTown, 'a neutral town exists to keep P1 alive');
  spareTown.owner = 1;

  town.garrison = EMPTY_ARMY();
  visitor.army = EMPTY_ARMY();
  visitor.backpack = [artifact];
  visitor.x = town.x; visitor.y = town.y; visitor.z = town.z ?? 0;
  visitor.inTownId = town.id; town.visitingHeroId = visitor.id;

  raider.army = ARMY();
  raider.x = town.x + 1; raider.y = town.y; raider.z = town.z ?? 0; raider.mp = 2000;
  const ev = stepHero(s, raider, { x: town.x, y: town.y, cost: 100 });

  assert.equal(ev.type, 'enterTown');
  assert.equal(ev.captured, true);
  assert.equal(town.owner, 0, 'the town changed hands');
  assert.equal(s.heroes[visitor.id], undefined, 'the captive left the map');
  const pooled = s.players[1].heroPool.find((h) => h.id === visitor.id);
  assert.ok(pooled, '…into its owner’s re-hire pool (captured, not vaporized)');
  assert.equal(pooled.backpack.length, 0, 'the captive was stripped');
  assert.ok(
    raider.backpack.includes(artifact) || Object.values(raider.equipment).includes(artifact),
    'the captor took the trappings',
  );
});

test('captureTown objective: seizing the NEUTRAL objective hold wins at the moment of capture', () => {
  const s = newGame({ seed: 21, victory: { kind: 'captureTown' } });
  const town = s.towns[s.victory.targetTownId];
  assert.ok(town, 'an objective town was flagged at generation');
  if (town.owner >= 0) {
    // The generator preferred an enemy town on this seed; force the neutral case.
    town.owner = -1;
  }
  const raider = playerHeroes(s, 0)[0];
  town.garrison = EMPTY_ARMY();
  town.visitingHeroId = null;
  raider.army = ARMY();
  raider.x = town.x + 1; raider.y = town.y; raider.z = town.z ?? 0; raider.mp = 2000;
  stepHero(s, raider, { x: town.x, y: town.y, cost: 100 });

  assert.equal(s.winner, s.players[0].team ?? 0, 'neutral objective hold → immediate victory');
  assert.equal(s.winReason, 'captureTown');
});

test('checkVictory: the conquest banner is logged exactly once', () => {
  const s = newGame({ seed: 5 });
  for (const t of playerTowns(s, 1)) t.owner = -1;
  for (const h of playerHeroes(s, 1)) delete s.heroes[h.id];
  checkVictory(s);
  assert.equal(s.winner, s.players[0].team ?? 0);
  const banners = s.log.filter((l) => l.text.includes('rule the realm')).length;
  assert.equal(banners, 1, 'no duplicate victory banner');
});

test('Town Portal off a boat moors the vessel on the vacated water tile', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const town = playerTowns(s, 0)[0];
  town.z = 0; town.visitingHeroId = null;
  clearPatch(s, town.x + 6, town.y, 2);
  const wx = town.x + 6, wy = town.y;
  tileAt(s, wx, wy).terrain = 'water';
  hero.x = wx; hero.y = wy; hero.z = 0; hero.onBoat = true;
  hero.spells = ['townPortal']; hero.mana = 30; hero.mp = 5000;

  const r = castAdventureSpell(s, hero, 'townPortal', null);
  assert.equal(r.ok, true);
  assert.equal(hero.onBoat, false);
  const boat = objectAt(s, wx, wy, 0);
  assert.ok(boat && boat.type === 'boat', 'the boat stays moored where the hero vanished');
});

test('disembark cannot bypass a keyless Border Guard', () => {
  const s = newGame({ seed: 9 });
  const hero = playerHeroes(s, 0)[0];
  clearPatch(s, 20, 20, 3);
  const wx = 20, wy = 20;
  tileAt(s, wx, wy).terrain = 'water';
  hero.x = wx; hero.y = wy; hero.z = 0; hero.onBoat = true; hero.mp = 2000;
  const gid = `O${s.map.nextOid++}`;
  const color = CONFIG.KEY_COLORS[0].id;
  s.map.objects[gid] = { id: gid, type: 'borderGuard', color, x: wx + 1, y: wy };
  tileAt(s, wx + 1, wy).objectId = gid;

  const ev = stepHero(s, hero, { x: wx + 1, y: wy, cost: 100 });
  assert.equal(ev.type, 'borderGuard', 'the landing is halted at the locked door');
  assert.equal(hero.onBoat, true, 'the hero stays aboard');
  assert.equal(hero.x, wx, 'no movement happened');

  // With the key, the same landing goes through.
  s.players[0].keys.push(color);
  const ev2 = stepHero(s, hero, { x: wx + 1, y: wy, cost: 100 });
  assert.equal(ev2.type, 'disembark', 'a key-holder lands normally');
});

test('a roster hero pooled by ANY player cannot be re-minted fresh by a rival tavern', () => {
  const s = newGame({ seed: 3 });
  const myTown = playerTowns(s, 0)[0];
  const onMap = new Set(Object.values(s.heroes).map((h) => h.rosterId));
  const spare = Object.keys(HERO_ROSTER).find(
    (id) => HERO_ROSTER[id].faction === myTown.faction && !onMap.has(id),
  );
  assert.ok(spare, 'a spare same-faction roster hero exists');
  assert.ok(hireableHeroes(s, myTown).includes(spare), 'normally offered fresh');

  // The rival retires that hero into ITS pool → my tavern may not clone it.
  s.players[1].heroPool.push({ id: 'H999', rosterId: spare, owner: 1, level: 3 });
  assert.ok(!hireableHeroes(s, myTown).includes(spare),
    'a veteran waiting in a rival pool is off the fresh-recruit table');
});
