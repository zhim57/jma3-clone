/**
 * whirlpools.test.js — random-destination boat teleporters of the open sea.
 *
 * A NEW surface-water mechanic (HoMM3-canonical): a hero ABOARD A BOAT who
 * ENDS a move on a whirlpool is swept to a random OTHER whirlpool — picked by
 * the deterministic, save-persisted state.rng, NOT a fixed channel pair — and
 * pays a toll: HALF of the weakest stack (rounded down, min 1), but never the
 * hero's last creature. Contracts pinned here:
 *   - engine: the swirl relocates the hero (still onBoat), reveals fog at the
 *     exit, returns { type:'whirlpool', from, to, lost }; a lone whirlpool or
 *     an occupied exit is a plain move; the toll never empties an army;
 *   - pathfinding: a whirlpool is a through-wall (isWalkable blocks routing
 *     THROUGH it) yet a legal destination for a boat (isEnterable) — and
 *     water-borne, so a foot hero can never end on one;
 *   - generator: placeWhirlpools seats an area-scaled count (2..4) on deep
 *     water, different seas first, all-or-nothing (never a lone whirlpool),
 *     surface only, no rng draws — fully deterministic;
 *   - AI: a whirlpool's destination is unpriceable, so the AI NEVER rides one
 *     voluntarily — it sails around (through-wall) and never values one as a
 *     goal; metrics.transits.whirlpool proves it stays 0;
 *   - save: an ordinary map object + a deterministic rng — round-trips with
 *     no version bump, and a loaded game swirls identically.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, serialize, deserialize, playerHeroes, tileAt, heroAt, levelObjects,
} from '../src/core/GameState.js';
import { stepHero, endTurn } from '../src/core/actions.js';
import { generateMap, placeWhirlpools } from '../src/map/MapGenerator.js';
import { findPath, isWalkable, isEnterable } from '../src/map/Pathfinding.js';
import { isExplored } from '../src/map/fog.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { Rng } from '../src/core/rng.js';

const AI = 1; // player index of the AI opponent in a fresh game

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a map the way GameState.newGame does, minus the rest of the state. */
function buildMap(seed, w = 44, h = 36) {
  const towns = [];
  const map = generateMap({
    w, h,
    rng: new Rng(seed),
    players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  return { map, towns };
}

/** A synthetic all-grass surface for unit-testing placeWhirlpools directly. */
function blankMap(w = 44, h = 36) {
  return {
    w, h, oidPrefix: 'O', nextOid: 1, objects: {},
    tiles: Array.from({ length: w * h }, () => ({ terrain: 'grass', obstacle: null, objectId: null, decor: 0 })),
  };
}

function paintLake(map, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x >= 0 && y >= 0 && x < map.w && y < map.h && Math.hypot(x - cx, y - cy) <= r) {
        map.tiles[y * map.w + x].terrain = 'water';
      }
    }
  }
}

/** Find a clean horizontal run (no objects/heroes, with a 1-tile apron). */
function cleanStrip(state, len, avoid = []) {
  const { w, h } = state.map;
  for (let y = 4; y < h - 4; y++) {
    for (let x0 = 4; x0 < w - len - 4; x0++) {
      if (avoid.some((a) => Math.abs(a.y - y) <= 4 && Math.abs(a.x0 - x0) <= len + 6)) continue;
      let ok = true;
      for (let dx = -1; dx <= len && ok; dx++) {
        for (let dy = -1; dy <= 1 && ok; dy++) {
          const t = tileAt(state, x0 + dx, y + dy);
          if (!t || t.objectId || heroAt(state, x0 + dx, y + dy)) ok = false;
        }
      }
      if (ok) return { x0, y };
    }
  }
  throw new Error('no clean strip');
}

/** Reset a strip (and its apron) to bare grass. */
function clearApron(state, strip, len) {
  for (let dx = -1; dx <= len; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const t = tileAt(state, strip.x0 + dx, strip.y + dy);
      t.terrain = 'grass'; t.obstacle = null; t.objectId = null;
    }
  }
}

/** Drop an object onto a live state at (x, y) on the surface; returns it. */
function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
}

/** Remove every GENERATED whirlpool so staged scenes control the exit set. */
function removeWhirlpools(state) {
  for (const [id, obj] of Object.entries(state.map.objects)) {
    if (obj.type !== 'whirlpool') continue;
    const t = state.map.tiles[obj.y * state.map.w + obj.x];
    if (t.objectId === id) t.objectId = null;
    delete state.map.objects[id];
  }
}

/**
 * Stage two separate hand-painted ponds on a live state (any whirlpools the
 * generator seeded are removed first, so the staged ones are the exit set):
 *   pond A: [land (hero)] [water+boat] [water] [water+whirl A]
 *   pond B: [water] [water+whirl B] [water]     (a distinct sea)
 * Returns every coordinate plus the two whirlpool objects.
 */
function stageSeas(state, { withB = true } = {}) {
  removeWhirlpools(state);
  const A = cleanStrip(state, 4);
  clearApron(state, A, 4);
  for (let dx = 1; dx <= 3; dx++) tileAt(state, A.x0 + dx, A.y).terrain = 'water';
  const boat = putObj(state, A.x0 + 1, A.y, { type: 'boat' });
  const whirlA = putObj(state, A.x0 + 3, A.y, { type: 'whirlpool' });

  let whirlB = null;
  let B = null;
  if (withB) {
    B = cleanStrip(state, 4, [A]);
    clearApron(state, B, 4);
    for (let dx = 1; dx <= 3; dx++) tileAt(state, B.x0 + dx, B.y).terrain = 'water';
    whirlB = putObj(state, B.x0 + 2, B.y, { type: 'whirlpool' });
  }
  return {
    hero: { x: A.x0, y: A.y },
    boat: { x: A.x0 + 1, y: A.y },
    open: { x: A.x0 + 2, y: A.y },
    whirlA, whirlB, boatObj: boat, A, B,
  };
}

function readyHero(state, army, playerIndex = 0) {
  const hero = playerHeroes(state, playerIndex)[0];
  hero.army = [...army];
  while (hero.army.length < 7) hero.army.push(null);
  hero.mp = 5000;
  return hero;
}

// ---------------------------------------------------------------------------
// Engine: the swirl
// ---------------------------------------------------------------------------

test('a boat hero ending a move on a whirlpool is swept to the other one and pays the toll', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = stageSeas(s);
  const hero = readyHero(s, [
    { creature: 'archangel', count: 2, hurt: 0 },
    { creature: 'pikeman', count: 10, hurt: 0 },
  ]);
  hero.x = L.hero.x; hero.y = L.hero.y;

  assert.equal(stepHero(s, hero, { x: L.boat.x, y: L.boat.y, cost: 100 }).type, 'embark');
  assert.equal(stepHero(s, hero, { x: L.open.x, y: L.open.y, cost: 100 }).type, 'moved');
  const ev = stepHero(s, hero, { x: L.whirlA.x, y: L.whirlA.y, cost: 100 });

  assert.equal(ev.type, 'whirlpool', 'the swirl fired');
  assert.deepEqual(ev.from, { x: L.whirlA.x, y: L.whirlA.y }, 'from = the entry whirlpool');
  assert.deepEqual(ev.to, { x: L.whirlB.x, y: L.whirlB.y }, 'to = the only other whirlpool');
  assert.equal(hero.x, L.whirlB.x, 'hero relocated to the exit');
  assert.equal(hero.y, L.whirlB.y);
  assert.equal(hero.onBoat, true, 'still aboard — whirlpools sit on water');
  assert.equal(tileAt(s, hero.x, hero.y).terrain, 'water');
  assert.equal(hero.z ?? 0, 0, 'surface stays surface');

  // The toll: half the WEAKEST stack (10 pikemen at 80 pts outrank nothing —
  // 2 archangels are worth far more), rounded down, minimum 1.
  assert.deepEqual(ev.lost, { creature: 'pikeman', count: 5 }, 'lost half the weakest stack');
  assert.equal(hero.army[1].count, 5, 'pikemen halved');
  assert.equal(hero.army[0].count, 2, 'archangels untouched');

  assert.ok(isExplored(s, 0, L.whirlB.x, L.whirlB.y), 'fog revealed around the exit');
  assert.equal(hero.mp, 5000 - 300, 'three plain step costs, no teleport surcharge');
});

test('a lone whirlpool is a plain move — no teleport, no toll', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = stageSeas(s, { withB: false });
  const hero = readyHero(s, [{ creature: 'pikeman', count: 10, hurt: 0 }]);
  hero.x = L.hero.x; hero.y = L.hero.y;

  stepHero(s, hero, { x: L.boat.x, y: L.boat.y, cost: 100 });
  stepHero(s, hero, { x: L.open.x, y: L.open.y, cost: 100 });
  const ev = stepHero(s, hero, { x: L.whirlA.x, y: L.whirlA.y, cost: 100 });
  assert.equal(ev.type, 'moved', 'no partner → calm water');
  assert.equal(hero.x, L.whirlA.x, 'the hero simply bobs on the whirlpool');
  assert.equal(hero.onBoat, true);
  assert.equal(hero.army[0].count, 10, 'no toll taken');
});

test('an occupied exit calms the swirl: plain move, no toll', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = stageSeas(s);
  const hero = readyHero(s, [{ creature: 'pikeman', count: 10, hurt: 0 }]);
  const other = playerHeroes(s, 1)[0];
  other.x = L.whirlB.x; other.y = L.whirlB.y; other.onBoat = true; // camps on the exit

  hero.x = L.hero.x; hero.y = L.hero.y;
  stepHero(s, hero, { x: L.boat.x, y: L.boat.y, cost: 100 });
  stepHero(s, hero, { x: L.open.x, y: L.open.y, cost: 100 });
  const ev = stepHero(s, hero, { x: L.whirlA.x, y: L.whirlA.y, cost: 100 });
  assert.equal(ev.type, 'moved', 'occupied exit → the swirl subsides');
  assert.equal(hero.x, L.whirlA.x, 'hero stays on the entry whirlpool');
  assert.equal(hero.army[0].count, 10, 'no toll taken');
});

test('the toll never destroys a hero: last-stack and edge-case armies survive', () => {
  const cases = [
    { // a single creature in a single stack: the toll is waived entirely
      army: [{ creature: 'pikeman', count: 1, hurt: 0 }],
      lost: null,
      after: (hero) => hero.army[0].count === 1,
    },
    { // a 2-creature only stack: pays 1, keeps 1 — reduced, never emptied
      army: [{ creature: 'pikeman', count: 2, hurt: 0 }],
      lost: { creature: 'pikeman', count: 1 },
      after: (hero) => hero.army[0].count === 1,
    },
    { // a 1-creature stack beside a healthy one: the weak stack is lost whole
      army: [{ creature: 'archangel', count: 5, hurt: 0 }, { creature: 'pikeman', count: 1, hurt: 0 }],
      lost: { creature: 'pikeman', count: 1 },
      after: (hero) => hero.army[1] === null && hero.army[0].count === 5,
    },
    { // an escort-less hero: nothing to take, nobody deleted
      army: [],
      lost: null,
      after: (hero) => hero.army.every((st) => !st),
    },
  ];
  for (const c of cases) {
    const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
    const L = stageSeas(s);
    const hero = readyHero(s, c.army);
    hero.x = L.open.x; hero.y = L.open.y; hero.onBoat = true; // already at sea
    const ev = stepHero(s, hero, { x: L.whirlA.x, y: L.whirlA.y, cost: 100 });
    assert.equal(ev.type, 'whirlpool', 'the swirl fired');
    assert.deepEqual(ev.lost, c.lost);
    assert.ok(s.heroes[hero.id], 'the hero survived the trip');
    assert.ok(c.after(hero), 'the army came through as specified');
    assert.equal(hero.x, L.whirlB.x, 'and was genuinely teleported');
  }
});

test('determinism: same seed → same destination and same loss, twice (and across save/load)', () => {
  const run = () => {
    const s = newGame({ seed: 5, mapW: 56, mapH: 46 });
    const L = stageSeas(s);
    // A THIRD whirlpool so the rng pick genuinely chooses among 2 exits.
    const C = cleanStrip(s, 4, [L.A, L.B]);
    clearApron(s, C, 4);
    for (let dx = 1; dx <= 3; dx++) tileAt(s, C.x0 + dx, C.y).terrain = 'water';
    putObj(s, C.x0 + 2, C.y, { type: 'whirlpool' });

    const hero = readyHero(s, [{ creature: 'pikeman', count: 9, hurt: 0 }]);
    hero.x = L.open.x; hero.y = L.open.y; hero.onBoat = true;
    return { s, L, hero };
  };

  const a = run();
  const b = run();
  // Save/load a third copy BEFORE the swirl: the persisted rng must swirl the same.
  const json = serialize(b.s);
  const c = deserialize(json);
  const cHero = c.heroes[b.hero.id];

  const evA = stepHero(a.s, a.hero, { x: a.L.whirlA.x, y: a.L.whirlA.y, cost: 100 });
  const evB = stepHero(b.s, b.hero, { x: b.L.whirlA.x, y: b.L.whirlA.y, cost: 100 });
  const evC = stepHero(c, cHero, { x: b.L.whirlA.x, y: b.L.whirlA.y, cost: 100 });
  assert.equal(evA.type, 'whirlpool');
  assert.deepEqual(evA.to, evB.to, 'same destination across two fresh runs');
  assert.deepEqual(evA.lost, evB.lost, 'same loss across two fresh runs');
  assert.deepEqual(evC.to, evB.to, 'a loaded game swirls to the same place');
  assert.deepEqual(evC.lost, evB.lost, 'and takes the same toll');
});

// ---------------------------------------------------------------------------
// Pathfinding
// ---------------------------------------------------------------------------

test('pathfinding: a whirlpool blocks through-routing but a boat may END on it', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  // One long pond: [land] [water] [water] [whirl] [water]; the apron rows are
  // grass, so the ONLY route past the whirlpool would be through it.
  const A = cleanStrip(s, 6);
  clearApron(s, A, 6);
  for (let dx = 1; dx <= 5; dx++) tileAt(s, A.x0 + dx, A.y).terrain = 'water';
  const whirl = putObj(s, A.x0 + 3, A.y, { type: 'whirlpool' });

  assert.equal(isWalkable(s, whirl.x, whirl.y, -1, null, true), false,
    'a boat never routes THROUGH a whirlpool');
  assert.equal(isEnterable(s, whirl.x, whirl.y, -1, true), true,
    'but may deliberately end a move on one');
  assert.equal(isEnterable(s, whirl.x, whirl.y, -1, false), false,
    'a foot hero cannot end on one (it is open water)');
  assert.equal(isWalkable(s, whirl.x, whirl.y, -1, null, false), false,
    'nor walk through it');

  const hero = readyHero(s, [{ creature: 'pikeman', count: 10, hurt: 0 }]);
  hero.x = A.x0 + 1; hero.y = A.y; hero.onBoat = true;
  assert.equal(findPath(s, hero, A.x0 + 5, A.y, -1), null,
    'auto-path refuses to cross the whirlpool (no way around in a 1-wide pond)');
  const onto = findPath(s, hero, whirl.x, whirl.y, -1);
  assert.ok(onto, 'the whirlpool itself is a reachable destination');
  const last = onto.path[onto.path.length - 1];
  assert.deepEqual({ x: last.x, y: last.y }, { x: whirl.x, y: whirl.y });
});

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

test('placeWhirlpools: two seas get one each — deep water, spaced, deterministic', () => {
  const make = () => {
    const m = blankMap();
    paintLake(m, 10, 10, 4);
    paintLake(m, 32, 26, 4);
    return m;
  };
  const m = make();
  const placed = placeWhirlpools(m);
  assert.equal(placed.length, 2, 'the 44x36 reference count is 2');
  for (const o of placed) {
    assert.equal(o.type, 'whirlpool');
    assert.equal(m.tiles[o.y * m.w + o.x].objectId, o.id, 'tile back-reference set');
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        assert.equal(m.tiles[(o.y + dy) * m.w + (o.x + dx)].terrain, 'water',
          `deep water only: neighbour ${dx},${dy} of ${o.x},${o.y} is water`);
      }
    }
  }
  const d = Math.hypot(placed[0].x - placed[1].x, placed[0].y - placed[1].y);
  assert.ok(d >= 8, `spaced apart (${d.toFixed(1)})`);
  const near = (o, cx, cy) => Math.hypot(o.x - cx, o.y - cy) <= 5;
  assert.ok(placed.some((o) => near(o, 10, 10)) && placed.some((o) => near(o, 32, 26)),
    'different seas — one whirlpool per lake');

  const again = placeWhirlpools(make());
  assert.deepEqual(again.map((o) => [o.x, o.y]), placed.map((o) => [o.x, o.y]),
    'a pure scan: two runs agree exactly');
});

test('placeWhirlpools: all-or-nothing — water-poor maps get NONE, one big sea gets a spaced pair', () => {
  // No water at all.
  assert.equal(placeWhirlpools(blankMap()).length, 0, 'landlocked → none');
  // A pond too small to host anything.
  let m = blankMap();
  paintLake(m, 20, 18, 1);
  assert.equal(placeWhirlpools(m).length, 0, 'tiny pond → none');
  // One medium lake: room for ONE whirlpool but not two spaced ones — a lone
  // whirlpool is inert, so none may be placed.
  m = blankMap();
  paintLake(m, 20, 18, 3);
  assert.equal(placeWhirlpools(m).length, 0, 'one medium lake → none (never a lone whirlpool)');
  assert.ok(Object.keys(m.objects).length === 0, 'no orphan object left behind');
  // One genuinely big sea: two whirlpools in the SAME body, still ≥ 8 apart.
  m = blankMap();
  paintLake(m, 20, 18, 8);
  const pair = placeWhirlpools(m);
  assert.equal(pair.length, 2, 'a big single sea hosts a pair');
  const d = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  assert.ok(d >= 8, `same-sea pair still spaced (${d.toFixed(1)})`);
});

test('generator: real maps hold 0 or 2..4 whirlpools — deep surface water only, never underground', () => {
  for (const seed of [1, 3, 7, 42, 999, 2024, 4242, 12345]) {
    const { map } = buildMap(seed);
    const wp = Object.values(map.objects).filter((o) => o.type === 'whirlpool');
    assert.ok(wp.length === 0 || (wp.length >= 2 && wp.length <= 4),
      `seed ${seed}: count is 0 or 2..4 (got ${wp.length})`);
    for (const o of wp) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          assert.equal(map.tiles[(o.y + dy) * map.w + (o.x + dx)].terrain, 'water',
            `seed ${seed}: whirlpool ${o.id} sits in deep water`);
        }
      }
    }
    assert.ok(!Object.values(map.underground.objects).some((o) => o.type === 'whirlpool'),
      `seed ${seed}: the underground is dry — no whirlpools below`);
  }
  // Known layouts: a water-rich seed seats a pair, a water-poor one goes without.
  assert.equal(Object.values(buildMap(12345).map.objects).filter((o) => o.type === 'whirlpool').length,
    2, 'seed 12345 (water-rich 44x36) seats exactly 2');
  assert.equal(Object.values(buildMap(7).map.objects).filter((o) => o.type === 'whirlpool').length,
    0, 'seed 7 (water-poor 44x36) seats none');
  // A big map spreads its (capped) four across at least two distinct seas.
  const big = buildMap(7, 88, 72).map;
  const wp = Object.values(big.objects).filter((o) => o.type === 'whirlpool');
  assert.equal(wp.length, 4, '88x72 caps at 4');
  const label = new Int32Array(big.w * big.h).fill(-1);
  let bodies = 0;
  const isWater = (x, y) => x >= 0 && y >= 0 && x < big.w && y < big.h
    && big.tiles[y * big.w + x].terrain === 'water';
  for (let y = 0; y < big.h; y++) {
    for (let x = 0; x < big.w; x++) {
      if (!isWater(x, y) || label[y * big.w + x] !== -1) continue;
      const stack = [[x, y]];
      label[y * big.w + x] = bodies;
      while (stack.length) {
        const [px, py] = stack.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (isWater(px + dx, py + dy) && label[(py + dy) * big.w + px + dx] === -1) {
            label[(py + dy) * big.w + px + dx] = bodies;
            stack.push([px + dx, py + dy]);
          }
        }
      }
      bodies++;
    }
  }
  const seas = new Set(wp.map((o) => label[o.y * big.w + o.x]));
  assert.ok(seas.size >= 2, `whirlpools join DIFFERENT seas (${seas.size} bodies)`);
});

test('generator: whirlpool maps are deterministic — full two-level digest identical across runs', () => {
  for (const seed of [12345, 3]) {
    const a = buildMap(seed, 56, 46).map;
    const b = buildMap(seed, 56, 46).map;
    const digest = (m) => JSON.stringify({
      tiles: m.tiles, objects: m.objects,
      ugTiles: m.underground.tiles, ugObjects: m.underground.objects,
    });
    assert.equal(digest(a), digest(b), `seed ${seed}: byte-identical across two runs`);
    assert.ok(Object.values(a.objects).some((o) => o.type === 'whirlpool'),
      `seed ${seed}: the digest actually covers whirlpools`);
  }
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/** Drive a full AI turn; auto-resolve any interactive battles. */
function runTurn(state, playerIndex = AI) {
  const ai = new AITurnController(state, playerIndex);
  let guard = 200;
  let r;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return ai;
}

/** Remove every object except towns from the surface. */
function stripObjects(state) {
  const m = state.map;
  for (const [id, obj] of Object.entries(m.objects)) {
    if (obj.type === 'town') continue;
    const t = m.tiles[obj.y * state.map.w + obj.x];
    if (t.objectId === id) t.objectId = null;
    delete m.objects[id];
  }
}

/** Make every non-AI army unbeatable so courage gates all combat goals off. */
function fortifyEnemies(state, aiIndex = AI) {
  for (const town of Object.values(state.towns)) {
    if (town.owner !== aiIndex) {
      town.garrison[0] = { creature: 'archangel', count: 500, hurt: 0 };
    }
  }
  for (const h of Object.values(state.heroes)) {
    if (h.owner !== aiIndex) {
      h.army = [{ creature: 'archangel', count: 500, hurt: 0 }, null, null, null, null, null, null];
    }
  }
}

/** Zero the AI's treasury so towns neither hire, build nor recruit. */
function impoverish(state, aiIndex = AI) {
  state.players[aiIndex].resources = {
    gold: 0, wood: 0, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 0,
  };
}

/** Force a clean (r*2+1)² block of open grass around (cx, cy) on the surface. */
function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const t = m.tiles[(cy + dy) * state.map.w + (cx + dx)];
      t.obstacle = null;
      t.terrain = 'grass';
      if (t.objectId) { delete m.objects[t.objectId]; t.objectId = null; }
    }
  }
  return { x: cx, y: cy };
}

test('AI: a boat hero sails AROUND a whirlpool to its islet prize — never rides one', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  stripObjects(s);
  fortifyEnemies(s);
  impoverish(s);
  const hero = playerHeroes(s, AI)[0];
  hero.army = [{ creature: 'pikeman', count: 20, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 3000;

  // A 3-row lake with a sea-locked islet prize — and a whirlpool squarely on
  // the straight line from the boat to the islet, so the cheapest naive route
  // would ride it. A second whirlpool in the far corner arms the pair.
  const x0 = 24, y = 20;
  clearBlock(s, x0 - 5, y, 4);
  clearBlock(s, x0 + 1, y, 4);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = 1; dx <= 5; dx++) {
      const t = tileAt(s, x0 + dx, y + dy);
      t.terrain = 'water';
      t.obstacle = null;
    }
  }
  tileAt(s, x0 + 3, y).terrain = 'sand'; // the islet
  putObj(s, x0 + 1, y, { type: 'boat' });
  const prize = putObj(s, x0 + 3, y, { type: 'resource', resource: 'gems', amount: 10, seaLocked: true });
  const w1 = putObj(s, x0 + 2, y, { type: 'whirlpool' });
  const w2 = putObj(s, x0 + 5, y - 1, { type: 'whirlpool' });
  putObj(s, x0 - 9, y, { type: 'resource', resource: 'crystal', amount: 7 }); // mainland work
  hero.x = x0; hero.y = y;

  const gems0 = s.players[AI].resources.gems;
  const ai = runTurn(s);

  assert.equal(s.players[AI].resources.gems, gems0 + 10, 'the islet prize was still looted');
  assert.equal(levelObjects(s, 0)[prize.id], undefined, 'the prize object was consumed');
  assert.equal(ai.metrics.transits.whirlpool, 0, 'the AI NEVER rode a whirlpool');
  assert.ok(!ai.transitLog.some((t) => t.type === 'whirlpool'), 'no swirl in the transit trail');
  assert.ok(ai.metrics.transits.embark >= 1 && ai.metrics.transits.disembark >= 1,
    'the boat trip really happened (around the hazard)');
  for (const o of [w1, w2]) {
    assert.ok(levelObjects(s, 0)[o.id], `whirlpool ${o.id} still on the map`);
  }
  const under = tileAt(s, hero.x, hero.y, hero.z ?? 0);
  const on = under?.objectId ? levelObjects(s, hero.z ?? 0)[under.objectId] : null;
  assert.ok(!(on && on.type === 'whirlpool'), 'the hero never ends up parked on a whirlpool');
});

test('AI: full days on a whirlpool-rich generated map — zero swirls, no loops, hazards intact', () => {
  const s = newGame({ seed: 12345 }); // 44x36: the generator seats 2 whirlpools
  const before = Object.values(s.map.objects)
    .filter((o) => o.type === 'whirlpool').map((o) => [o.x, o.y]);
  assert.ok(before.length >= 2, 'the map is whirlpool-rich');

  let guard = 60;
  while (s.winner === null && s.day <= 6 && guard-- > 0) {
    const ai = new AITurnController(s, s.currentPlayer);
    let r, g2 = 100;
    do {
      r = ai.next();
      if (r.type === 'combat') ai.autoFight(r.context);
    } while (r.type !== 'done' && g2-- > 0);
    assert.equal(r.type, 'done', 'every AI turn terminates');
    assert.equal(ai.metrics.transits.whirlpool, 0, 'no voluntary swirl, ever');
    for (const h of Object.values(s.heroes)) {
      const t = tileAt(s, h.x, h.y, h.z ?? 0);
      const o = t?.objectId ? levelObjects(s, h.z ?? 0)[t.objectId] : null;
      assert.ok(!(o && o.type === 'whirlpool'), 'no hero ends a turn parked on a whirlpool');
    }
    endTurn(s);
  }
  assert.ok(guard > 0, 'no infinite loop across the simulated days');
  const after = Object.values(s.map.objects)
    .filter((o) => o.type === 'whirlpool').map((o) => [o.x, o.y]);
  assert.deepEqual(after, before, 'the hazards are untouched, exactly where they were');
});

// ---------------------------------------------------------------------------
// Save format & non-regression
// ---------------------------------------------------------------------------

test('save/load: whirlpools are ordinary map objects — no version bump, byte-identical round-trip', () => {
  const s = newGame({ seed: 12345 });
  const before = Object.values(s.map.objects).filter((o) => o.type === 'whirlpool');
  assert.ok(before.length >= 2);

  const json = serialize(s);
  const s2 = deserialize(json);
  const after = Object.values(s2.map.objects).filter((o) => o.type === 'whirlpool');
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'whirlpool objects survive identically');
  assert.equal(serialize(deserialize(json)), json, 'round-trip is a fixed point');
});

test('non-regression: a water-poor map simply has no whirlpools and plays as before', () => {
  const s = newGame({ seed: 7 }); // 44x36: too little deep water — none seated
  assert.equal(Object.values(s.map.objects).filter((o) => o.type === 'whirlpool').length, 0);
  // The game runs: an AI turn and the day cycle behave normally.
  const ai = runTurn(s, s.currentPlayer);
  assert.equal(ai.metrics.transits.whirlpool, 0);
  endTurn(s);
  endTurn(s);
  assert.equal(s.day, 2, 'the calendar advanced');
});
