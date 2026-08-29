/**
 * weekly-resources.test.js — the Windmill and Water Wheel visitables.
 *
 * Both are "booster" map objects with a NEW persistence axis: the weekly claim
 * lives on the OBJECT (obj.harvestedWeek), so the first hero to reach it each
 * week collects it and it stays empty for everyone until the next week. Covers
 * the engine grant + weekly lock/reset, the shared boosterSpent predicate (used
 * by the AI), save round-tripping, and generator placement (windmills on land,
 * water wheels only beside water, everything foot-reachable). No Phaser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, RESOURCES } from '../src/config.js';
import { newGame, serialize, deserialize, playerHeroes, weekOf } from '../src/core/GameState.js';
import {
  stepHero, endTurn, boosterName, boosterEffect, boosterSpent,
} from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { Rng } from '../src/core/rng.js';

// --- local helpers (mirroring tests/scenario-epic.test.js) -----------------

function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const t = m.tiles[y * m.w + x];
      t.obstacle = null;
      t.terrain = 'grass';
      if (t.objectId) {
        if (m.objects[t.objectId]?.type === 'town') continue;
        delete m.objects[t.objectId];
        t.objectId = null;
      }
    }
  }
  return { x: cx, y: cy };
}

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
}

function nextWeek(state) {
  const w0 = weekOf(state.day);
  let guard = 60;
  while (weekOf(state.day) === w0 && guard-- > 0) endTurn(state);
  assert.equal(weekOf(state.day), w0 + 1, 'advanced exactly one week');
}

function bordersWater(map, o) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
    const nx = o.x + dx, ny = o.y + dy;
    return nx >= 0 && ny >= 0 && nx < map.w && ny < map.h
      && map.tiles[ny * map.w + nx].terrain === 'water';
  });
}

function buildMap(seed, w, h) {
  const towns = [];
  const map = generateMap({
    w, h, rng: new Rng(seed), players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  return { map, towns };
}

/** 4-dir foot flood from the towns; towns/portals/gates are solid landmarks. */
function flood(map, seeds) {
  const { w, h } = map;
  const SOLID = new Set(['town', 'portal', 'subGate']);
  const seen = new Uint8Array(w * h);
  const open = (i) => {
    const t = map.tiles[i];
    if (t.terrain === 'water' || t.obstacle) return false;
    const o = t.objectId && map.objects[t.objectId];
    return !(o && SOLID.has(o.type));
  };
  const st = [];
  for (const s of seeds) { const i = s.y * w + s.x; if (!seen[i]) { seen[i] = 1; st.push(i); } }
  while (st.length) {
    const i = st.pop(), x = i % w;
    if (x > 0 && !seen[i - 1] && open(i - 1)) { seen[i - 1] = 1; st.push(i - 1); }
    if (x < w - 1 && !seen[i + 1] && open(i + 1)) { seen[i + 1] = 1; st.push(i + 1); }
    if (i >= w && !seen[i - w] && open(i - w)) { seen[i - w] = 1; st.push(i - w); }
    if (i < w * h - w && !seen[i + w] && open(i + w)) { seen[i + w] = 1; st.push(i + w); }
  }
  return seen;
}

const nearReachable = (map, seen, o) => {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = o.x + dx, ny = o.y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.w && ny < map.h && seen[ny * map.w + nx]) return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------

test('windmill: yields a non-gold resource once per week, refreshes next week', () => {
  assert.equal(boosterName('windmill'), 'Windmill');
  assert.match(boosterEffect('windmill'), /week/i);

  const s = newGame({ seed: 5 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 20, 20, 2);
  const mill = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'windmill' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000;

  const before = { ...s.players[0].resources };
  const ev1 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev1.type, 'visited');
  assert.equal(ev1.name, 'Windmill');
  assert.equal(mill.harvestedWeek, weekOf(s.day), 'claim recorded ON THE OBJECT this week');
  const gained = RESOURCES.filter((r) => s.players[0].resources[r] > (before[r] || 0));
  assert.equal(gained.length, 1, 'exactly one resource type gained');
  assert.notEqual(gained[0], 'gold', 'a windmill never gives gold');
  const amt = s.players[0].resources[gained[0]] - before[gained[0]];
  assert.ok(amt >= CONFIG.WINDMILL_MIN && amt <= CONFIG.WINDMILL_MAX,
    `amount ${amt} within [${CONFIG.WINDMILL_MIN}, ${CONFIG.WINDMILL_MAX}]`);

  // Same week, a second visit: politely refused, nothing more produced.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  const mid = { ...s.players[0].resources };
  const ev2 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev2.type, 'visited');
  assert.match(ev2.text, /still|next week/i);
  assert.deepEqual(s.players[0].resources, mid, 'no second harvest the same week');

  // Next week: the sails turn again.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  nextWeek(s);
  hero.mp = 4000;
  const beforeWk2 = { ...s.players[0].resources };
  const ev3 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev3.type, 'visited');
  assert.equal(mill.harvestedWeek, weekOf(s.day), 'reclaimed for the new week');
  const gained2 = RESOURCES.filter((r) => s.players[0].resources[r] > (beforeWk2[r] || 0));
  assert.equal(gained2.length, 1, 'produced again next week');
});

test('water wheel: yields gold once per week, refreshes next week', () => {
  assert.equal(boosterName('waterWheel'), 'Water Wheel');
  assert.match(boosterEffect('waterWheel'), new RegExp(`${CONFIG.WATER_WHEEL_GOLD}`));

  const s = newGame({ seed: 6 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 18, 22, 2);
  const wheel = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'waterWheel' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000;

  const g0 = s.players[0].resources.gold;
  const ev1 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev1.type, 'visited');
  assert.equal(s.players[0].resources.gold, g0 + CONFIG.WATER_WHEEL_GOLD, 'gold granted');
  assert.equal(wheel.harvestedWeek, weekOf(s.day));

  // Same week again: no more gold.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  const g1 = s.players[0].resources.gold;
  const ev2 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.match(ev2.text, /nothing more|week/i);
  assert.equal(s.players[0].resources.gold, g1, 'no second payout the same week');

  // Next week: pays again.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  nextWeek(s);
  hero.mp = 4000;
  const g2 = s.players[0].resources.gold;
  stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(s.players[0].resources.gold, g2 + CONFIG.WATER_WHEEL_GOLD, 'pays again next week');
});

test('boosterSpent: move / weekly / once-per-hero / mana all agree with the engine', () => {
  const s = newGame({ seed: 7 });
  const hero = playerHeroes(s, 0)[0];
  // A Magic Well is "spent" for a hero already at full mana (createHero starts
  // heroes full) and worth a visit only once mana has been spent — this stops the
  // full-mana shuttle the AI used to run between two wells.
  const fullMana = hero.mana;
  assert.equal(boosterSpent(s, hero, { boosterType: 'mana', id: 'X' }), true, 'full mana → nothing to gain');
  hero.mana = 0;
  assert.equal(boosterSpent(s, hero, { boosterType: 'mana', id: 'X' }), false, 'spent mana → worth a visit');
  hero.mana = fullMana;
  // A once-per-hero shrine is spent once banked.
  const shrine = { boosterType: 'attack', id: 'A' };
  assert.equal(boosterSpent(s, hero, shrine), false);
  hero.visited[shrine.id] = true;
  assert.equal(boosterSpent(s, hero, shrine), true);
  // A camp is spent for the day once rested at today.
  const camp = { boosterType: 'move', id: 'M' };
  assert.equal(boosterSpent(s, hero, camp), false);
  hero.boostDays = { M: s.day };
  assert.equal(boosterSpent(s, hero, camp), true);
  // A weekly object tracks its claim on the OBJECT, not the hero.
  const mill = { boosterType: 'windmill', id: 'W' };
  assert.equal(boosterSpent(s, hero, mill), false);
  mill.harvestedWeek = weekOf(s.day);
  assert.equal(boosterSpent(s, hero, mill), true);
  mill.harvestedWeek = weekOf(s.day) - 1; // a stale claim from last week
  assert.equal(boosterSpent(s, hero, mill), false, 'a new week reopens it');
});

test('a drained weekly object round-trips through save/load', () => {
  const s = newGame({ seed: 8 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 24, 20, 2);
  const mill = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'windmill' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000;
  stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(mill.harvestedWeek, weekOf(s.day));

  const json = serialize(s);
  const s2 = deserialize(json);
  assert.equal(s2.map.objects[mill.id].harvestedWeek, weekOf(s2.day), 'the claim survives a reload');
  assert.equal(serialize(deserialize(json)), json, 'round-trip is a fixed point');

  // The reloaded windmill is still empty this week.
  const h2 = s2.heroes[hero.id];
  h2.x = spot.x - 1; h2.y = spot.y; h2.mp = 4000;
  const res0 = { ...s2.players[0].resources };
  const ev = stepHero(s2, h2, { x: spot.x, y: spot.y, cost: 100 });
  assert.match(ev.text, /still|next week/i);
  assert.deepEqual(s2.players[0].resources, res0, 'no harvest after reload, same week');
});

test('generator: windmills on land, every water wheel borders water, all reachable', () => {
  let sawMill = false, sawWheel = false;
  for (const seed of [101, 202, 303, 404, 505, 606]) {
    const { map, towns } = buildMap(seed, 56, 46);
    const boosters = Object.values(map.objects).filter((o) => o.type === 'booster');
    const mills = boosters.filter((o) => o.boosterType === 'windmill');
    const wheels = boosters.filter((o) => o.boosterType === 'waterWheel');
    if (mills.length) sawMill = true;
    if (wheels.length) sawWheel = true;
    const seen = flood(map, towns.map((t) => ({ x: t.x, y: t.y })));
    for (const wheel of wheels) {
      assert.ok(bordersWater(map, wheel), `seed ${seed}: a water wheel borders water`);
      assert.ok(nearReachable(map, seen, wheel), `seed ${seed}: water wheel foot-reachable`);
    }
    for (const mill of mills) {
      assert.ok(nearReachable(map, seen, mill), `seed ${seed}: windmill foot-reachable`);
    }
  }
  assert.ok(sawMill, 'windmills appear on generated maps');
  assert.ok(sawWheel, 'at least one water wheel placed across the watery seeds');
});
