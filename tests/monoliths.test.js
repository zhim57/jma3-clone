/**
 * monoliths.test.js — One-way Monoliths: a colour-coded network of 1 entrance +
 * N exits. Stepping onto an entrance sweeps the hero to a RANDOM same-colour
 * exit (never back); an exit is an inert landmark. Engine + generation, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { stepHero, useObjectUnderHero } from '../src/core/actions.js';
import { isWalkable } from '../src/map/Pathfinding.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { Rng } from '../src/core/rng.js';
import { revealAround } from '../src/map/fog.js';

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, ...data };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}
function clearBlock(state, cx, cy, r = 1) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    const t = m.tiles[y * m.w + x];
    t.obstacle = null; t.terrain = 'grass';
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
  }
}
/** Remove the generator's own monoliths so a test controls the whole network. */
function stripMonoliths(state) {
  const m = state.map;
  for (const o of Object.values(m.objects)) {
    if (o.type === 'monolith') { m.tiles[o.y * m.w + o.x].objectId = null; delete m.objects[o.id]; }
  }
}

test('an entrance sweeps the hero to a same-colour exit; the exit is inert', () => {
  const s = newGame({ seed: 3 });
  stripMonoliths(s);
  const hero = playerHeroes(s, 0)[0];
  const ex = 24, ey = 20, enx = 20, eny = 20;
  clearBlock(s, enx, eny, 1); clearBlock(s, ex, ey, 1);
  const exit = putObj(s, ex, ey, { type: 'monolith', dir: 'exit', color: 0 });
  const entrance = putObj(s, enx, eny, { type: 'monolith', dir: 'entrance', color: 0 });
  revealAround(s, 0, enx, eny, 5); revealAround(s, 0, ex, ey, 5);
  hero.x = enx - 1; hero.y = eny; hero.z = 0; hero.mp = 2000;

  const ev = stepHero(s, hero, { x: enx, y: eny, cost: 100 });
  assert.equal(ev.type, 'monolith', 'stepping onto the entrance teleports');
  assert.deepEqual(ev.to, { x: ex, y: ey }, 'arrives at the matching exit');
  assert.equal(hero.x, ex); assert.equal(hero.y, ey);

  // Standing on the exit and re-triggering it does nothing (an exit is inert).
  assert.equal(useObjectUnderHero(s, hero).type, 'none', 'an exit cannot be used');
  void entrance; void exit;
});

test('colours are matched: an entrance never leads to a different-colour exit', () => {
  const s = newGame({ seed: 4 });
  stripMonoliths(s);
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, 20, 20, 1); clearBlock(s, 24, 20, 1); clearBlock(s, 28, 20, 1);
  putObj(s, 24, 20, { type: 'monolith', dir: 'exit', color: 0 });   // right colour
  putObj(s, 28, 20, { type: 'monolith', dir: 'exit', color: 9 });   // wrong colour — must be ignored
  putObj(s, 20, 20, { type: 'monolith', dir: 'entrance', color: 0 });
  revealAround(s, 0, 20, 20, 8);
  hero.x = 19; hero.y = 20; hero.z = 0; hero.mp = 2000;
  const ev = stepHero(s, hero, { x: 20, y: 20, cost: 100 });
  assert.deepEqual(ev.to, { x: 24, y: 20 }, 'only the same-colour exit is a destination');
});

test('a multi-exit network picks a colour-matched exit (many rolls stay in-set)', () => {
  const s = newGame({ seed: 5 });
  stripMonoliths(s);
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, 20, 20, 1); clearBlock(s, 24, 20, 1); clearBlock(s, 20, 24, 1);
  putObj(s, 24, 20, { type: 'monolith', dir: 'exit', color: 0 });
  putObj(s, 20, 24, { type: 'monolith', dir: 'exit', color: 0 });
  const entrance = putObj(s, 20, 20, { type: 'monolith', dir: 'entrance', color: 0 });
  revealAround(s, 0, 20, 20, 8);
  const dests = new Set();
  for (let i = 0; i < 25; i++) {
    hero.x = 19; hero.y = 20; hero.z = 0; hero.mp = 2000;
    const ev = stepHero(s, hero, { x: 20, y: 20, cost: 100 });
    dests.add(`${ev.to.x},${ev.to.y}`);
  }
  for (const d of dests) assert.ok(['24,20', '20,24'].includes(d), `${d} is one of the two exits`);
  void entrance;
});

test('a lone entrance (no exit of its colour) is inert', () => {
  const s = newGame({ seed: 6 });
  stripMonoliths(s);
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, 20, 20, 1);
  putObj(s, 20, 20, { type: 'monolith', dir: 'entrance', color: 3 });
  revealAround(s, 0, 20, 20, 5);
  hero.x = 19; hero.y = 20; hero.z = 0; hero.mp = 2000;
  const ev = stepHero(s, hero, { x: 20, y: 20, cost: 100 });
  assert.equal(ev.type, 'moved', 'an orphan entrance is a plain move');
  assert.equal(hero.x, 20, 'the hero simply stands on it');
});

test('an occupied exit cancels the transit', () => {
  const s = newGame({ seed: 7 });
  stripMonoliths(s);
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, 20, 20, 1); clearBlock(s, 24, 20, 1);
  putObj(s, 24, 20, { type: 'monolith', dir: 'exit', color: 0 });
  putObj(s, 20, 20, { type: 'monolith', dir: 'entrance', color: 0 });
  revealAround(s, 0, 20, 20, 8);
  // Park a second hero on the only exit.
  s.heroes.Hblk = { id: 'Hblk', owner: 0, x: 24, y: 20, z: 0, army: [] };
  hero.x = 19; hero.y = 20; hero.z = 0; hero.mp = 2000;
  const ev = stepHero(s, hero, { x: 20, y: 20, cost: 100 });
  assert.equal(ev.type, 'blockedExit', 'no free exit → the transit is cancelled');
});

test('an un-looted monolith blocks through-traffic but is a valid destination', () => {
  const s = newGame({ seed: 8 });
  stripMonoliths(s);
  clearBlock(s, 20, 20, 1);
  putObj(s, 20, 20, { type: 'monolith', dir: 'entrance', color: 0 });
  revealAround(s, 0, 20, 20, 5);
  assert.equal(isWalkable(s, 20, 20, 0), false, 'auto-pathing never routes through a monolith');
});

test('monoliths round-trip a save (type/dir/color persist)', () => {
  const s = newGame({ seed: 9 });
  stripMonoliths(s);
  clearBlock(s, 20, 20, 1); clearBlock(s, 24, 20, 1);
  putObj(s, 20, 20, { type: 'monolith', dir: 'entrance', color: 2 });
  const exit = putObj(s, 24, 20, { type: 'monolith', dir: 'exit', color: 2 });
  const back = deserialize(serialize(s));
  const e2 = back.map.objects[exit.id];
  assert.equal(e2.type, 'monolith');
  assert.equal(e2.dir, 'exit');
  assert.equal(e2.color, 2);
});

test('generation seats one-way monolith networks, each 1 entrance + ≥1 same-colour exit', () => {
  for (const [w, h] of [[44, 36], [56, 46], [72, 60]]) {
    const towns = [];
    const map = generateMap({ w, h, rng: new Rng(2024),
      players: [{ faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; } });
    const monos = Object.values(map.objects).filter((o) => o.type === 'monolith');
    assert.ok(monos.length >= 2, `${w}x${h}: at least one network (${monos.length} monoliths)`);
    const byColor = {};
    for (const m of monos) (byColor[m.color] ??= { entr: 0, exit: 0 })[m.dir === 'entrance' ? 'entr' : 'exit']++;
    for (const [color, n] of Object.entries(byColor)) {
      assert.equal(n.entr, 1, `${w}x${h} colour ${color}: exactly one entrance`);
      assert.ok(n.exit >= 1, `${w}x${h} colour ${color}: at least one exit`);
    }
  }
});
