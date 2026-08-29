/**
 * keymaster-guards.test.js — colored-key gated geography (map RPG layer, part A).
 * A Keymaster Tent grants the whole PLAYER a permanent colored key; a matching
 * Border Guard is a wall until that player holds the key, then an open doorway.
 * Engine: GameState.playerHasKey, actions.stepHero (keymaster grant / guard step),
 * Pathfinding.isWalkable (through-traffic gate). Pure rule-engine, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, playerHasKey, serialize, deserialize } from '../src/core/GameState.js';
import { stepHero, keyColorName } from '../src/core/actions.js';
import { isWalkable, findPath } from '../src/map/Pathfinding.js';
import { revealAround } from '../src/map/fog.js';
import { Rng } from '../src/core/rng.js';

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
}
function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    const t = m.tiles[y * m.w + x];
    t.obstacle = null; t.terrain = 'grass';
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
  }
  return { x: cx, y: cy };
}
const step = (s, hero, x, y) => stepHero(s, hero, { x, y, cost: 100 });
const COLOR = CONFIG.KEY_COLORS[0].id;

test('KEY_COLORS + keyColorName wire the internal id to a display name', () => {
  assert.ok(CONFIG.KEY_COLORS.length >= 2, 'a palette of colors exists');
  assert.equal(keyColorName(COLOR), CONFIG.KEY_COLORS[0].name);
  assert.equal(keyColorName('nonesuch'), 'nonesuch', 'unknown ids pass through');
});

test('a Keymaster Tent grants the whole player a permanent key; revisiting is a no-op', () => {
  const s = newGame({ seed: 5 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 22, 20, 2);
  const tent = putObj(s, spot.x, spot.y, { type: 'keymaster', color: COLOR });
  hero.x = spot.x - 1; hero.y = spot.y; hero.z = 0; hero.mp = 2000;

  assert.equal(playerHasKey(s, 0, COLOR), false, 'starts without the key');
  const ev = step(s, hero, tent.x, tent.y);
  assert.equal(ev.type, 'keymaster');
  assert.equal(ev.isNew, true);
  assert.equal(playerHasKey(s, 0, COLOR), true, 'the whole player now holds the key');
  assert.deepEqual(s.players[0].keys, [COLOR]);
  // The tent persists (it is not consumed) — revisit grants nothing new.
  hero.x = tent.x - 1; hero.y = tent.y; hero.mp = 2000;
  const again = step(s, hero, tent.x, tent.y);
  assert.equal(again.isNew, false);
  assert.deepEqual(s.players[0].keys, [COLOR], 'no duplicate key');
});

test('a Border Guard blocks a keyless hero (no move, no MP) and passes a keyed one', () => {
  const s = newGame({ seed: 6 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 22, 20, 2);
  const guard = putObj(s, spot.x, spot.y, { type: 'borderGuard', color: COLOR });
  hero.x = spot.x - 1; hero.y = spot.y; hero.z = 0; hero.mp = 2000;

  const mpBefore = hero.mp;
  const blocked = step(s, hero, guard.x, guard.y);
  assert.equal(blocked.type, 'borderGuard', 'keyless: halted at the guard');
  assert.equal(blocked.color, COLOR);
  assert.equal(hero.x, spot.x - 1, 'the hero did not move onto the guard');
  assert.equal(hero.mp, mpBefore, 'and spent no movement');

  // Grant the key → the guard becomes a plain passable tile.
  s.players[0].keys.push(COLOR);
  const passed = step(s, hero, guard.x, guard.y);
  assert.equal(passed.type, 'moved', 'keyed: strides onto the guard');
  assert.equal(hero.x, guard.x, 'now standing on the (open) guard tile');
});

test('pathing routes THROUGH a Border Guard only for a player who holds the key', () => {
  const s = newGame({ seed: 7 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 24, 20, 3);
  const guard = putObj(s, spot.x, spot.y, { type: 'borderGuard', color: COLOR });
  revealAround(s, 0, spot.x, spot.y, 5); // isWalkable gates on fog for a real player

  // Through-traffic: the guard tile is walkable ONLY with the key.
  assert.equal(isWalkable(s, guard.x, guard.y, 0), false, 'keyless: the guard blocks through-traffic');
  s.players[0].keys.push(COLOR);
  assert.equal(isWalkable(s, guard.x, guard.y, 0), true, 'keyed: the guard is passable');

  // And a keyed hero can path onto the guard tile.
  hero.x = spot.x - 2; hero.y = spot.y; hero.z = 0; hero.mp = 2000;
  const path = findPath(s, hero, guard.x, guard.y, 0);
  assert.ok(path && path.path.length, 'keyed hero finds a path to/through the guard');
});

test('keys survive a save/load round-trip', () => {
  const s = newGame({ seed: 8 });
  s.players[0].keys.push(COLOR);
  const back = deserialize(serialize(s));
  assert.deepEqual(back.players[0].keys, [COLOR]);
  assert.equal(playerHasKey(back, 0, COLOR), true);
});

test('generation: a reference-size map seats matched tents + guards, each guarding a dead-end', () => {
  // Vaults need a natural dead-end, so whether a given seed produces one is
  // luck. This used to pin seed 7, which made it a hostage: ANY change to the
  // order the generator draws from its rng — here, deferring an artifact draw
  // until a spot was actually found — moved seed 7 off a vault and failed a test
  // about Border Guards for a reason that had nothing to do with them. Sweep a
  // handful of seeds instead: guards must be produced SOMEWHERE (the feature is
  // alive), and every guard produced anywhere must be well-formed (the property
  // this test is actually about).
  const maps = [7, 12, 25, 41, 63, 88].map((seed) => newGame({ seed, mapW: 44, mapH: 36 }).map);
  const all = maps.flatMap((m) => Object.values(m.objects).map((o) => ({ o, m })));
  const guardsAll = all.filter((e) => e.o.type === 'borderGuard');
  assert.ok(guardsAll.length >= 1, 'Border Guards are placed on at least one of the sampled seeds');
  for (const { o: g, m } of guardsAll) {
    const tents = Object.values(m.objects).filter((o) => o.type === 'keymaster');
    // Every guard color has a matching tent (a key is always earnable).
    assert.ok(tents.some((t) => t.color === g.color), `a ${g.color} Keymaster Tent exists for the guard`);
    assert.ok(CONFIG.KEY_COLORS.some((k) => k.id === g.color), 'a real palette color');
  }
  // Each guard sits on the sole open approach to its reward: the guard's tile is
  // the only non-obstacle, walkable neighbour of a reward tile.
  for (const { o: g, m } of guardsAll) {
    const walkable = (x, y) => {
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) return false;
      const t = m.tiles[y * m.w + x];
      return t.terrain !== 'water' && !t.obstacle;
    };
    // The reward is the guard's neighbour that carries a pickup object.
    const reward = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => ({ x: g.x + dx, y: g.y + dy }))
      .map((n) => ({ n, o: m.tiles[n.y * m.w + n.x]?.objectId ? m.objects[m.tiles[n.y * m.w + n.x].objectId] : null }))
      .find((c) => c.o && (c.o.type === 'resource' || c.o.type === 'chest'));
    assert.ok(reward, `guard ${g.id} fronts a reward tile`);
    // That reward tile's only walkable, object-free neighbour is the guard itself.
    const openNbrs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => ({ x: reward.n.x + dx, y: reward.n.y + dy }))
      .filter((nn) => walkable(nn.x, nn.y) && !(m.tiles[nn.y * m.w + nn.x].objectId && m.objects[m.tiles[nn.y * m.w + nn.x].objectId].type !== 'borderGuard'));
    assert.deepEqual(openNbrs, [{ x: g.x, y: g.y }], 'the guard is the reward’s only opening (a true gate)');
  }
});

test('an old save without a keys array is treated as holding none (absent-safe)', () => {
  const s = newGame({ seed: 9 });
  delete s.players[0].keys; // simulate a pre-feature save
  assert.equal(playerHasKey(s, 0, COLOR), false, 'no crash, just no keys');
  const rng = new Rng(1); assert.ok(rng); // touch Rng so the import is used
});
