/**
 * adventure-spells.test.js — spells cast OUTSIDE combat from the adventure map:
 * View Air (scry), Summon Boat, Town Portal, Dimension Door. Learned like any
 * spell; dispatched by actions.castAdventureSpell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns, tileAt } from '../src/core/GameState.js';
import { castAdventureSpell, endTurn, dimDoorLandable, townPortalTowns } from '../src/core/actions.js';
import { isExplored } from '../src/map/fog.js';
import { CONFIG } from '../src/config.js';

function clearPatch(s, cx, cy, r = 10) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const t = tileAt(s, cx + dx, cy + dy);
    if (t) { t.terrain = 'grass'; t.obstacle = null; t.objectId = null; }
  }
}

test('View Air: reveals the whole level and spends mana', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  s.fog[0].fill(0); // dark
  hero.spells = ['viewAir']; hero.mana = 30;
  const r = castAdventureSpell(s, hero, 'viewAir', null);
  assert.equal(r.ok, true);
  assert.equal(r.type, 'view');
  assert.equal(hero.mana, 30 - 8, 'mana spent');
  // A far corner is now explored.
  assert.ok(isExplored(s, 0, s.map.w - 1, s.map.h - 1, 0), 'the level is fully revealed');
});

test('Summon Boat: drops a boat on nearby water; refused if already aboard', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  clearPatch(s, hero.x, hero.y, 3);
  const wx = hero.x + 1, wy = hero.y;
  const wt = tileAt(s, wx, wy); wt.terrain = 'water'; wt.obstacle = null; wt.objectId = null;
  hero.spells = ['summonBoat']; hero.mana = 30; hero.onBoat = false;
  const r = castAdventureSpell(s, hero, 'summonBoat', null);
  assert.equal(r.ok, true);
  const boat = Object.values(s.map.objects).find((o) => o.type === 'boat');
  assert.ok(boat, 'a boat was summoned');
  assert.equal(hero.mana, 22);
  // Already aboard → refused.
  hero.onBoat = true; hero.mana = 30;
  const r2 = castAdventureSpell(s, hero, 'summonBoat', null);
  assert.equal(r2.ok, false);
  assert.equal(hero.mana, 30, 'a refused cast costs no mana');
});

test('Town Portal: recalls the hero to its town, spending a prorated slice of movement', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const town = playerTowns(s, 0)[0];
  town.z = hero.z ?? 0; town.visitingHeroId = null;
  hero.x = Math.min(s.map.w - 2, town.x + 12); hero.y = town.y; hero.mp = 5000;
  hero.spells = ['townPortal']; hero.mana = 30;
  const r = castAdventureSpell(s, hero, 'townPortal', null);
  assert.equal(r.ok, true);
  assert.equal(hero.x, town.x, 'landed on the town');
  assert.equal(hero.y, town.y);
  assert.equal(hero.mp, 5000 - CONFIG.TOWN_PORTAL_MP, 'only a couple of tiles of movement is spent, not the whole day');
  assert.equal(town.visitingHeroId, hero.id, 'the hero now garrisons the town');
  assert.equal(hero.mana, 30 - 12);
});

test('Town Portal: refused when less than one cast of movement remains', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const town = playerTowns(s, 0)[0];
  town.z = hero.z ?? 0; town.visitingHeroId = null;
  hero.x = Math.min(s.map.w - 2, town.x + 12); hero.y = town.y;
  hero.spells = ['townPortal']; hero.mana = 30;
  const startX = hero.x;
  hero.mp = CONFIG.TOWN_PORTAL_MP - 1; // a hair under one cast (≈ a single tile left)
  const r = castAdventureSpell(s, hero, 'townPortal', null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not enough movement left/i);
  assert.equal(hero.x, startX, 'the hero did not move');
  assert.equal(hero.mana, 30, 'no mana spent on a refused cast');
  // Exactly one cast's worth is enough.
  hero.mp = CONFIG.TOWN_PORTAL_MP;
  assert.equal(castAdventureSpell(s, hero, 'townPortal', null).ok, true);
});

test('Town Portal: destination choice is gated on Earth Magic mastery', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const towns = playerTowns(s, 0);
  // Need at least two towns on the level to prove "chosen vs nearest".
  const near = towns[0];
  near.z = hero.z ?? 0; near.visitingHeroId = null;
  hero.x = near.x + 2; hero.y = near.y; hero.z = near.z;
  hero.spells = ['townPortal'];
  // A second, far town — placed within map bounds, on the same level.
  const far = towns[1] || { ...near, id: 'tp-far-town', x: Math.min(s.map.w - 2, near.x + 8) };
  far.z = hero.z; far.owner = hero.owner; far.visitingHeroId = null;
  far.x = Math.min(s.map.w - 2, Math.max(near.x + 8, far.x)); far.y = near.y;
  s.towns[far.id] = far;

  // Without Earth Magic: aiming at the far town is ignored → nearest wins.
  hero.skills = {}; hero.mana = 30; hero.mp = 5000;
  const r0 = castAdventureSpell(s, hero, 'townPortal', { townId: far.id });
  assert.equal(r0.ok, true);
  assert.equal(r0.townId, near.id, 'no Earth Magic → snaps to the nearest town');

  // With Basic Earth Magic: the chosen town is honored.
  hero.skills = { earthMagic: 1 };
  hero.x = near.x + 2; hero.y = near.y; hero.mana = 30; hero.mp = 5000;
  near.visitingHeroId = null; far.visitingHeroId = null;
  const r1 = castAdventureSpell(s, hero, 'townPortal', { townId: far.id });
  assert.equal(r1.ok, true);
  assert.equal(r1.townId, far.id, 'any Earth Magic → the chosen town is honored');
});

test('Town Portal spans both levels: an Earth mage may recall to an underground town', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const home = playerTowns(s, 0)[0];
  home.z = 0; home.visitingHeroId = null;
  hero.x = home.x + 3; hero.y = home.y; hero.z = 0;
  hero.spells = ['townPortal']; hero.skills = { earthMagic: 1 }; hero.mana = 30; hero.mp = 5000;
  // A second town on the OTHER level (underground).
  const under = { ...home, id: 'tp-under', name: 'Deephold', x: home.x, y: home.y, z: 1, visitingHeroId: null };
  s.towns[under.id] = under;

  // The candidate list spans both levels now.
  const ids = townPortalTowns(s, hero).map((t) => t.id);
  assert.ok(ids.includes(home.id) && ids.includes(under.id), 'both levels offered');

  const r = castAdventureSpell(s, hero, 'townPortal', { townId: under.id });
  assert.equal(r.ok, true);
  assert.equal(r.z, 1, 'the result reports the destination level');
  assert.equal(hero.z, 1, 'the hero crossed to the underground level');
  assert.equal(hero.x, under.x); assert.equal(hero.y, under.y);
  assert.equal(under.visitingHeroId, hero.id, 'now garrisons the underground town');
});

test('Dimension Door: blinks within range, spends mp + a daily use; capped per day', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  s.fog[0].fill(1);
  clearPatch(s, hero.x, hero.y, 12);
  hero.spells = ['dimensionDoor']; hero.mana = 200; hero.mp = 6000; hero.dimDoorUsed = 0;
  const mp0 = hero.mp;

  const r1 = castAdventureSpell(s, hero, 'dimensionDoor', { x: hero.x + 3, y: hero.y });
  assert.equal(r1.ok, true);
  assert.equal(hero.dimDoorUsed, 1);
  assert.equal(hero.mp, mp0 - CONFIG.DIM_DOOR_MP, 'movement spent');

  const r2 = castAdventureSpell(s, hero, 'dimensionDoor', { x: hero.x + 2, y: hero.y });
  assert.equal(r2.ok, true);
  assert.equal(hero.dimDoorUsed, 2);

  // Third exceeds the per-day cap.
  const r3 = castAdventureSpell(s, hero, 'dimensionDoor', { x: hero.x + 1, y: hero.y });
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /no casts left/i);

  // Out of range is refused.
  hero.dimDoorUsed = 0;
  const far = castAdventureSpell(s, hero, 'dimensionDoor', { x: hero.x + CONFIG.DIM_DOOR_RANGE + 2, y: hero.y });
  assert.equal(far.ok, false);
  assert.match(far.reason, /range/i);
});

test('dimDoorLandable (the targeting overlay predicate) agrees with the cast', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  s.fog[0].fill(1);
  clearPatch(s, hero.x, hero.y, 12);
  hero.spells = ['dimensionDoor']; hero.mana = 200; hero.mp = 6000; hero.dimDoorUsed = 0;

  // A cleared, in-range tile is landable — and actually casting there succeeds.
  const gx = hero.x + 2, gy = hero.y;
  assert.equal(dimDoorLandable(s, hero, gx, gy), true, 'green tile is landable');
  assert.equal(castAdventureSpell(s, hero, 'dimensionDoor', { x: gx, y: gy }).ok, true, 'and the cast lands');

  // The predicate rejects the same things the cast does: self, out of range,
  // unexplored, water, obstacle, an object tile.
  const h2 = playerHeroes(s, 0)[0];
  assert.equal(dimDoorLandable(s, h2, h2.x, h2.y), false, 'own tile (distance 0)');
  assert.equal(dimDoorLandable(s, h2, h2.x + CONFIG.DIM_DOOR_RANGE + 1, h2.y), false, 'out of range');
  const wx = h2.x + 1, wy = h2.y;
  const wt = tileAt(s, wx, wy, h2.z ?? 0);
  wt.terrain = 'water'; wt.obstacle = null; wt.objectId = null;
  assert.equal(dimDoorLandable(s, h2, wx, wy), false, 'water');
  wt.terrain = 'grass'; wt.obstacle = { kind: 'rock' };
  assert.equal(dimDoorLandable(s, h2, wx, wy), false, 'obstacle');
});

test('guards: unknown spell and insufficient mana are refused with no effect', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  // The knowledge + mana guards live in castAdventureSpell's dispatch, so they
  // hold identically for EVERY adventure spell — v1 and v2 alike. Assert the
  // generic contract once here (covering one spell from each wave) rather than
  // re-testing it per spell family.
  hero.spells = []; hero.mana = 100;
  for (const id of ['townPortal', 'viewEarth']) {
    assert.equal(castAdventureSpell(s, hero, id, null).ok, false, `${id}: must know the spell`);
  }
  hero.spells = ['townPortal']; hero.mana = 3;
  const r = castAdventureSpell(s, hero, 'townPortal', null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /mana/i);
  assert.equal(hero.mana, 3, 'no mana spent on a failed cast');
});

test('daily refresh resets Dimension Door uses', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.dimDoorUsed = 2;
  endTurn(s); // hand to AI (player 1)
  endTurn(s); // back to player 0 on a new day → refresh
  assert.equal(hero.dimDoorUsed, 0, 'casts refreshed with the new day');
});
