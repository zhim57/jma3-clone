/**
 * caravans.test.js — Caravans (HoMM3/HotA parity). Dispatch a garrison stack
 * from one owned town toward another of your team; it plods the road network
 * CARAVAN_SPEED tiles a day and merges into the destination garrison on arrival.
 * Unescorted: an enemy hero that reaches its tile scatters it (a raid). Engine +
 * AI only, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import {
  dispatchCaravan, advanceCaravans, caravanAt, stepHero, endTurn,
} from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { armyValue } from '../src/core/heroUtils.js';
import { revealAround } from '../src/map/fog.js';

const stack = (creature, count) => ({ creature, count, hurt: 0 });

/** Give player 0 a real home town plus a synthesized second town `dist` tiles
 *  east, with the corridor between them cleared so a caravan can walk it. */
function twoTowns(seed, dist = 10) {
  const s = newGame({ seed });
  const m = s.map;
  const home = Object.values(s.towns).find((t) => t.owner === 0);
  const y = home.y, x1 = Math.min(m.w - 3, home.x + dist);
  for (let x = home.x; x <= x1; x++) {
    const t = m.tiles[y * m.w + x];
    t.obstacle = null; if (t.terrain === 'water') t.terrain = 'grass';
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
  }
  const east = { id: 'Teast', name: 'Eastwatch', x: x1, y, z: 0, owner: 0, faction: 'castle',
    garrison: [null, null, null, null, null, null, null], buildings: ['villageHall'], available: {} };
  if (m.tiles[y * m.w + x1].objectId) delete m.objects[m.tiles[y * m.w + x1].objectId];
  m.tiles[y * m.w + x1].objectId = null; // the town lives in state.towns, not map.objects
  s.towns.Teast = east;
  return { s, home, east };
}

test('dispatch debits the garrison and lays a road path; bad requests are refused', () => {
  const { s, home, east } = twoTowns(5);
  home.garrison[0] = stack('pikeman', 20);

  assert.equal(dispatchCaravan(s, home, home.id, 0, 5).ok, false, 'same town refused');
  assert.equal(dispatchCaravan(s, home, east.id, 3, 5).ok, false, 'empty slot refused');

  const r = dispatchCaravan(s, home, east.id, 0, 12);
  assert.ok(r.ok, 'dispatch succeeds along the corridor');
  assert.ok(r.caravan.path.length > 0, 'a route was found');
  assert.equal(home.garrison[0].count, 8, 'the garrison was debited');
  assert.equal(s.caravans.length, 1);
  assert.equal(caravanAt(s, home.x, home.y, 0), r.caravan, 'it starts at the source town');
});

test('an enemy destination is refused', () => {
  const { s, home } = twoTowns(6);
  home.garrison[0] = stack('pikeman', 10);
  const enemyTown = Object.values(s.towns).find((t) => t.owner === 1);
  assert.equal(dispatchCaravan(s, home, enemyTown.id, 0, 5).ok, false, 'cannot supply an enemy town');
});

test('the caravan travels the road and merges into the destination garrison', () => {
  const { s, home, east } = twoTowns(5);
  home.garrison[0] = stack('pikeman', 20);
  dispatchCaravan(s, home, east.id, 0, 12);
  let days = 0;
  while (s.caravans.length && days < 40) { endTurn(s); days++; }
  assert.equal(s.caravans.length, 0, 'the caravan arrived');
  const pikemen = east.garrison.reduce((n, a) => n + (a && a.creature === 'pikeman' ? a.count : 0), 0);
  assert.equal(pikemen, 12, 'its troops joined the destination garrison');
});

test('a caravan halts before a tile an enemy hero occupies', () => {
  const { s, home, east } = twoTowns(5);
  home.garrison[0] = stack('pikeman', 20);
  const r = dispatchCaravan(s, home, east.id, 0, 12);
  // Park an enemy hero one tile ahead on the path.
  const block = r.caravan.path[0];
  const foe = playerHeroes(s, 1)[0];
  foe.x = block.x; foe.y = block.y; foe.z = 0;
  advanceCaravans(s);
  assert.equal(s.caravans[0].cursor, 0, 'it did not step into the enemy hero');
  assert.deepEqual([s.caravans[0].x, s.caravans[0].y], [home.x, home.y], 'it waited at the source');
});

test('a caravan whose destination is lost scatters', () => {
  const { s, home, east } = twoTowns(5);
  home.garrison[0] = stack('pikeman', 20);
  dispatchCaravan(s, home, east.id, 0, 12);
  east.owner = 1; // the destination falls to the enemy
  const evs = advanceCaravans(s);
  assert.equal(s.caravans.length, 0, 'the run is lost');
  assert.ok(evs.some((e) => e.type === 'caravanLost'));
});

test('an enemy hero reaching a caravan scatters it for XP', () => {
  const s = newGame({ seed: 7 });
  const hero = playerHeroes(s, 0)[0];
  const c = { id: 'CV1', owner: 1, creature: 'griffin', count: 10, toTownId: 'X', x: 20, y: 20, z: 0, path: [], cursor: 0 };
  s.caravans.push(c);
  const t = s.map.tiles[20 * s.map.w + 20];
  t.obstacle = null; if (t.terrain === 'water') t.terrain = 'grass';
  if (t.objectId) { delete s.map.objects[t.objectId]; t.objectId = null; }
  hero.x = 19; hero.y = 20; hero.z = 0; hero.mp = 2000;
  const xpBefore = hero.xp || 0;
  const ev = stepHero(s, hero, { x: 20, y: 20, cost: 100 });
  assert.equal(ev.type, 'caravanRaided');
  assert.equal(ev.count, 10);
  assert.equal(s.caravans.length, 0, 'the caravan is gone');
  const expected = Math.round(armyValue([{ creature: 'griffin', count: 10 }]) * CONFIG.CARAVAN.RAID_XP_PER_VALUE);
  assert.equal(ev.xp, expected, 'XP scales with the scattered stack');
  assert.ok((hero.xp || 0) >= xpBefore + expected, 'the raider actually gained it');
});

test('an ALLY never scatters a caravan, and never intercepts it', () => {
  const s = newGame({ seed: 11, players: [
    { faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 0 },
  ] });
  const ally = playerHeroes(s, 1)[0]; // same team 0
  const c = { id: 'CV1', owner: 0, creature: 'griffin', count: 8, toTownId: 'X', x: 15, y: 15, z: 0, path: [], cursor: 0 };
  s.caravans.push(c);
  const t = s.map.tiles[15 * s.map.w + 15];
  t.obstacle = null; if (t.terrain === 'water') t.terrain = 'grass';
  if (t.objectId) { delete s.map.objects[t.objectId]; t.objectId = null; }
  ally.x = 14; ally.y = 15; ally.z = 0; ally.mp = 2000;
  const ev = stepHero(s, ally, { x: 15, y: 15, cost: 100 });
  assert.notEqual(ev.type, 'caravanRaided', 'an ally does not raid a friendly caravan');
  assert.equal(s.caravans.length, 1, 'and it survives');
});

test('caravans round-trip a save', () => {
  const { s, home, east } = twoTowns(5);
  home.garrison[0] = stack('pikeman', 20);
  dispatchCaravan(s, home, east.id, 0, 12);
  const before = s.caravans[0];
  const restored = deserialize(serialize(s));
  assert.equal(restored.caravans.length, 1);
  assert.deepEqual(
    { creature: restored.caravans[0].creature, count: restored.caravans[0].count, cursor: restored.caravans[0].cursor },
    { creature: before.creature, count: before.count, cursor: before.cursor },
    'the in-transit caravan survives serialization');
});

test('the AI marches to an enemy caravan and scatters it', () => {
  const s = newGame({ seed: 9 });
  const ai = playerHeroes(s, 1)[0];
  const cx = Math.min(s.map.w - 3, ai.x + 2), cy = ai.y;
  const t = s.map.tiles[cy * s.map.w + cx];
  t.obstacle = null; if (t.terrain === 'water') t.terrain = 'grass';
  if (t.objectId) { delete s.map.objects[t.objectId]; t.objectId = null; }
  // A human (enemy of the AI) caravan sitting there.
  s.caravans.push({ id: 'CV1', owner: 0, creature: 'archangel', count: 6, toTownId: 'X', x: cx, y: cy, z: 0, path: [], cursor: 0 });
  revealAround(s, 1, cx, cy, 6, 0);
  const ctrl = new AITurnController(s, 1);
  let guard = 300, r;
  do { r = ctrl.next(); if (r.type === 'combat') ctrl.autoFight(r.context); } while (r.type !== 'done' && guard-- > 0);
  assert.equal(s.caravans.length, 0, 'the AI raided the enemy caravan');
});

test('the AI caravans a safe rear town\'s garrison to a threatened front', () => {
  const { s, home, east } = twoTowns(5);
  // Make BOTH towns the AI\'s (player 1); the rear (home) is safe, the front
  // (east) is threatened by a nearby human hero.
  home.owner = 1; east.owner = 1;
  home.garrison[0] = stack('griffin', 10); // a rear garrison worth sending
  home.visitingHeroId = null;
  s.players[1].resources.gold = 0; // no gold to hire a ferry hero — the caravan is the tool
  s.players[1].heroPool = [];
  const foe = playerHeroes(s, 0)[0]; // human near the front town
  foe.x = east.x + 1; foe.y = east.y; foe.z = 0; foe.army = [stack('archangel', 30), null, null, null, null, null, null];
  const ctrl = new AITurnController(s, 1);
  ctrl.manageTowns();
  assert.ok(s.caravans.some((c) => c.owner === 1 && c.toTownId === east.id),
    'a caravan set out from the safe rear toward the threatened front');
});
