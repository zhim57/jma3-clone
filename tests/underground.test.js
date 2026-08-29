/**
 * underground.test.js — the underground level + subterranean gates.
 *
 * The generator adds a second w×h map level (state.map.underground) joined to
 * the surface by paired `subGate` objects: stepping onto a gate moves the hero
 * to its partner on the other level, exactly like a same-level portal but
 * cross-level. Contracts pinned here:
 *   - the surface stays byte-for-byte the pre-underground baseline (the gates
 *     are the only addition, generated from a separate derived RNG stream);
 *   - gates pair across levels and never break surface reachability;
 *   - every underground object is reachable from EVERY gate's underground end,
 *     so a hero can descend at any gate and clear the vault;
 *   - heroes/towns carry a map level (z) defaulting to 0; fog is per-level;
 *   - v2 saves round-trip the underground, v1 saves migrate to a playable
 *     single-level game;
 *   - the AI may now use gates deliberately (see ai-connectors.test.js), with
 *     a hard per-hero per-turn transit cap, and never crashes or loops.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import {
  newGame, serialize, deserialize, playerHeroes, tileAt, objectAt,
  heroAt, createHero, levelMap, levelObjects, getObject, SAVE_VERSION,
} from '../src/core/GameState.js';
import { stepHero, endTurn, dailyIncome } from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { findPath, isWalkable, isEnterable } from '../src/map/Pathfinding.js';
import { isExplored } from '../src/map/fog.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { Rng } from '../src/core/rng.js';

const SEEDS = [1, 7, 42, 999, 2024];
const UNDER_TERRAINS = new Set(['rough', 'dirt', 'lava']);

/** Build a map the way GameState.newGame does, minus the rest of the state. */
function buildMap(seed, w = 44, h = 36, opts = {}) {
  const towns = [];
  const map = generateMap({
    w, h,
    rng: new Rng(seed),
    players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    ...opts,
  });
  return { map, towns };
}

/** 4-dir flood over one level. `solidTypes` block through-traffic. */
function flood(level, seeds, solidTypes) {
  const { w, h } = level;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const open = (i) => {
    const t = level.tiles[i];
    if (t.terrain === 'water' || t.obstacle) return false;
    const o = t.objectId && level.objects[t.objectId];
    return !(o && solidTypes.has(o.type));
  };
  for (const s of seeds) {
    const i = s.y * w + s.x;
    if (!seen[i]) { seen[i] = 1; stack.push(i); } // seeds count even if solid (gate/town tile)
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0 && !seen[i - 1] && open(i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !seen[i + 1] && open(i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
    if (i >= w && !seen[i - w] && open(i - w)) { seen[i - w] = 1; stack.push(i - w); }
    if (i < w * h - w && !seen[i + w] && open(i + w)) { seen[i + w] = 1; stack.push(i + w); }
  }
  return seen;
}

/** Reachable if we can STAND on the object's tile or any of its 8 neighbours. */
function nearReachable(level, seen, obj) {
  const { w, h } = level;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = obj.x + dx, ny = obj.y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && seen[ny * w + nx]) return true;
    }
  }
  return false;
}

// ---- live-state helpers (mirroring portals.test.js patterns) ---------------

/** Centre of a clean 5×5 surface block: no obstacle/object/water/hero near. */
function openTile(state, avoid = []) {
  const { w, h } = state.map;
  const oob = (x, y) => x < 0 || y < 0 || x >= w || y >= h;
  const skip = (x, y) => avoid.some((a) => Math.abs(a.x - x) <= 3 && Math.abs(a.y - y) <= 3);
  const clean = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (oob(x, y)) return false;
        const t = tileAt(state, x, y);
        if (!t || t.obstacle || t.objectId || t.terrain === 'water') return false;
        if (heroAt(state, x, y)) return false;
      }
    }
    return true;
  };
  // Prefer a naturally-clean block (identical behaviour on roomy maps).
  for (let y = 3; y < h - 3; y++)
    for (let x = 3; x < w - 3; x++)
      if (!skip(x, y) && clean(x, y)) return { x, y };
  // Dense map with no natural 5×5 gap: CLEAR a surface block (never a town or a
  // hero) so the gate-mechanics tests never hostage on incidental free space.
  const townOrHero = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, y = cy + dy;
      if (oob(x, y)) return true;
      const t = tileAt(state, x, y);
      const o = t?.objectId ? state.map.objects[t.objectId] : null;
      if ((o && o.type === 'town') || heroAt(state, x, y)) return true;
    }
    return false;
  };
  for (let y = 3; y < h - 3; y++)
    for (let x = 3; x < w - 3; x++) {
      if (skip(x, y) || townOrHero(x, y)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const t = tileAt(state, x + dx, y + dy);
        t.obstacle = null; t.terrain = 'grass';
        if (t.objectId) { delete state.map.objects[t.objectId]; t.objectId = null; }
      }
      return { x, y };
    }
  throw new Error('no clean surface tile');
}

/** Force a clean 7×7 underground block around (cx, cy); returns its centre. */
function clearUnderBlock(state, cx, cy) {
  const ug = state.map.underground;
  const { w } = state.map;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const t = ug.tiles[(cy + dy) * w + (cx + dx)];
      t.obstacle = null;
      t.terrain = 'rough';
      if (t.objectId) { delete ug.objects[t.objectId]; t.objectId = null; }
    }
  }
  return { x: cx, y: cy };
}

/** Drop a subGate object onto a live state at (x, y) on `level`. */
function putGate(state, level, x, y, channel) {
  const m = level ? state.map.underground : state.map;
  const id = `${level ? 'U' : 'O'}${m.nextOid++}`;
  const obj = { id, x, y, type: 'subGate', channel, color: 0 };
  m.objects[id] = obj;
  m.tiles[y * state.map.w + x].objectId = id;
  return obj;
}

function readyHero(state) {
  const hero = playerHeroes(state, 0)[0];
  hero.army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 5000;
  return hero;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

test('generator: an underground level exists — full grid, cavern terrain, treasure vault', () => {
  for (const seed of SEEDS) {
    const { map } = buildMap(seed);
    const ug = map.underground;
    assert.ok(ug, `seed ${seed}: underground generated`);
    assert.equal(ug.w, map.w);
    assert.equal(ug.h, map.h);
    assert.equal(ug.tiles.length, map.w * map.h, 'full w×h grid');
    for (const t of ug.tiles) {
      assert.ok(UNDER_TERRAINS.has(t.terrain), `subterranean terrain only (got ${t.terrain})`);
      assert.notEqual(t.terrain, 'water', 'no water underground');
    }
    const objs = Object.values(ug.objects);
    assert.ok(objs.length > 0, 'the vault holds objects');
    for (const o of objs) assert.ok(o.id.startsWith('U'), `underground ids are U-prefixed (${o.id})`);
    assert.ok(objs.some((o) => o.type === 'mine'), 'rare-resource mines below');
    assert.ok(objs.some((o) => o.type === 'artifact'), 'artifacts below');
    assert.ok(objs.some((o) => o.type === 'monster'), 'guards below');
    assert.ok(objs.some((o) => o.type === 'town'), 'neutral capturable towns below (v3)');
    assert.ok(!objs.some((o) => o.type === 'boat'), 'no boats underground');
  }
});

test('generator: subterranean gates come in cross-level pairs sharing a channel', () => {
  for (const [w, h] of [[44, 36], [56, 46], [88, 72]]) {
    const { map } = buildMap(7, w, h);
    const up = Object.values(map.objects).filter((o) => o.type === 'subGate');
    const down = Object.values(map.underground.objects).filter((o) => o.type === 'subGate');
    assert.ok(up.length >= 1, `${w}x${h}: at least one gate pair`);
    assert.equal(up.length, down.length, 'one underground end per surface end');
    const downByChannel = new Map(down.map((g) => [g.channel, g]));
    assert.equal(downByChannel.size, down.length, 'channels unique underground');
    for (const g of up) {
      assert.ok(downByChannel.has(g.channel), `surface gate channel ${g.channel} has a partner below`);
    }
    const upChannels = new Set(up.map((g) => g.channel));
    assert.equal(upChannels.size, up.length, 'channels unique on the surface');
  }
});

test('generator: the surface is byte-for-byte the pre-underground baseline, plus only the gates', () => {
  for (const seed of SEEDS) {
    const base = buildMap(seed, 44, 36, { underground: false }).map;
    const full = buildMap(seed, 44, 36).map;
    assert.equal(base.underground, undefined, 'baseline has no underground');
    assert.ok(full.underground, 'full build has one');

    // Tiles: terrain/obstacle/decor identical everywhere; objectId identical
    // except where the full build stands a gate.
    for (let i = 0; i < base.tiles.length; i++) {
      const a = base.tiles[i], b = full.tiles[i];
      assert.equal(a.terrain, b.terrain, `tile ${i} terrain unchanged`);
      assert.equal(a.obstacle, b.obstacle, `tile ${i} obstacle unchanged`);
      assert.equal(a.decor, b.decor, `tile ${i} decor unchanged`);
      if (a.objectId !== b.objectId) {
        assert.equal(a.objectId, null, `tile ${i}: baseline tile was empty`);
        assert.equal(full.objects[b.objectId]?.type, 'subGate', `tile ${i}: the addition is a gate`);
      }
    }
    // Objects: every baseline object survives identically; every extra is a gate.
    for (const [id, oa] of Object.entries(base.objects)) {
      const ob = full.objects[id];
      assert.ok(ob, `seed ${seed}: baseline object ${id} still present`);
      assert.equal(JSON.stringify(oa), JSON.stringify(ob), `seed ${seed}: object ${id} unchanged`);
    }
    for (const [id, ob] of Object.entries(full.objects)) {
      if (!base.objects[id]) assert.equal(ob.type, 'subGate', `seed ${seed}: extra object ${id} is a gate`);
    }
  }
});

test('generator: deterministic — same seed ⇒ identical underground', () => {
  for (const seed of [12345, 7]) {
    const a = buildMap(seed).map.underground;
    const b = buildMap(seed).map.underground;
    assert.equal(JSON.stringify(a.tiles), JSON.stringify(b.tiles), 'tiles identical');
    assert.deepEqual(Object.keys(a.objects), Object.keys(b.objects), 'same object ids');
    for (const id of Object.keys(a.objects)) {
      assert.equal(JSON.stringify(a.objects[id]), JSON.stringify(b.objects[id]), `object ${id} identical`);
    }
    assert.equal(a.nextOid, b.nextOid);
  }
});

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

test('connectivity: gates reachable from BOTH towns; the whole vault reachable from EVERY gate', () => {
  const SOLID = new Set(['town', 'portal', 'subGate']);
  for (const seed of SEEDS) {
    const { map, towns } = buildMap(seed);
    const up = Object.values(map.objects).filter((o) => o.type === 'subGate');
    // Surface ends: near-reachable from each SURFACE town independently (a
    // hero from either realm can march to a gate and descend). Underground
    // towns register through the same callback but live on level 1.
    for (const town of towns.filter((t) => (t.z ?? 0) === 0)) {
      const seen = flood(map, [{ x: town.x, y: town.y }], SOLID);
      for (const g of up) {
        assert.ok(nearReachable(map, seen, g),
          `seed ${seed}: gate ${g.id} unreachable from town at ${town.x},${town.y}`);
      }
    }
    // Underground: every object (mines, prizes, guards, the other gates)
    // near-reachable from EACH gate's underground end independently.
    const ug = map.underground;
    const down = Object.values(ug.objects).filter((o) => o.type === 'subGate');
    assert.ok(down.length >= 1);
    for (const g of down) {
      const seen = flood(ug, [{ x: g.x, y: g.y }], SOLID);
      for (const obj of Object.values(ug.objects)) {
        assert.ok(nearReachable(ug, seen, obj),
          `seed ${seed}: ${obj.type} ${obj.id} unreachable from gate ${g.id}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Movement through gates
// ---------------------------------------------------------------------------

test('stepHero: a surface gate descends to its partner; the partner gate returns', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = readyHero(s);

  const a = openTile(s);
  const b = clearUnderBlock(s, 20, 20);
  putGate(s, 0, a.x, a.y, 77);
  putGate(s, 1, b.x, b.y, 77);

  // Descend.
  hero.x = a.x; hero.y = a.y + 1;
  const down = stepHero(s, hero, { x: a.x, y: a.y, cost: 100 });
  assert.equal(down.type, 'subGate', 'a gate event fired');
  assert.deepEqual(down.from, { x: a.x, y: a.y, level: 0 });
  assert.deepEqual(down.to, { x: b.x, y: b.y, level: 1 });
  assert.equal(hero.z, 1, 'hero is underground');
  assert.equal(hero.x, b.x);
  assert.equal(hero.y, b.y);
  assert.ok(isExplored(s, 0, b.x, b.y, 1), 'under-fog revealed around the exit');
  assert.ok(isExplored(s, 0, b.x + 2, b.y, 1), '...as a disc, not a point');
  assert.equal(isExplored(s, 1, b.x, b.y, 1), false, "the OTHER player's under-fog untouched");

  // Walk off, walk back on → ascend (no ping-pong: arriving never re-fires).
  const off = stepHero(s, hero, { x: b.x + 1, y: b.y, cost: 100 });
  assert.equal(off.type, 'moved', 'stepping off the exit gate is a plain move');
  assert.equal(hero.z, 1, 'still underground');
  const upEv = stepHero(s, hero, { x: b.x, y: b.y, cost: 100 });
  assert.equal(upEv.type, 'subGate');
  assert.equal(hero.z, 0, 'back on the surface');
  assert.equal(hero.x, a.x);
  assert.equal(hero.y, a.y);
});

test('stepHero: a lone gate is inert; an occupied exit cancels the transit', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = readyHero(s);

  // Unpaired gate → plain move, hero stays on the surface standing on it.
  const lone = openTile(s);
  putGate(s, 0, lone.x, lone.y, 500);
  hero.x = lone.x; hero.y = lone.y + 1;
  const ev = stepHero(s, hero, { x: lone.x, y: lone.y, cost: 100 });
  assert.equal(ev.type, 'moved');
  assert.equal(hero.z ?? 0, 0);
  assert.equal(hero.x, lone.x);

  // Occupied exit: another hero camps on the underground partner.
  const a = openTile(s, [lone]);
  const b = clearUnderBlock(s, 30, 30);
  putGate(s, 0, a.x, a.y, 501);
  putGate(s, 1, b.x, b.y, 501);
  const other = playerHeroes(s, 1)[0];
  other.z = 1; other.x = b.x; other.y = b.y;
  hero.x = a.x; hero.y = a.y + 1; hero.mp = 5000;
  const blocked = stepHero(s, hero, { x: a.x, y: a.y, cost: 100 });
  assert.equal(blocked.type, 'blockedExit', 'occupied exit → no teleport');
  assert.equal(hero.z ?? 0, 0, 'hero stays on the surface');
  assert.equal(hero.x, a.x, 'standing on the entry gate');
  assert.equal(hero.y, a.y);
});

test('pathfinding: a gate blocks through-traffic but is enterable as a destination', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const p = openTile(s);
  putGate(s, 0, p.x, p.y, 90);
  assert.equal(isWalkable(s, p.x, p.y, -1), false, 'auto-path never routes THROUGH a gate');
  assert.equal(isEnterable(s, p.x, p.y, -1), true, 'but a hero may end a move on one');
});

test('pathfinding: a hero paths within its OWN level only', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = readyHero(s);
  const c = clearUnderBlock(s, 24, 24);

  // Wall off the SAME coordinates on the surface — it must not matter below.
  for (let dx = -2; dx <= 2; dx++) {
    const t = tileAt(s, c.x + dx, c.y);
    t.obstacle = 'rock';
    if (t.objectId) { delete s.map.objects[t.objectId]; t.objectId = null; }
  }

  hero.z = 1; hero.x = c.x - 2; hero.y = c.y;
  const res = findPath(s, hero, c.x + 2, c.y, -1);
  assert.ok(res, 'underground hero crosses ground that is walled on the surface');
  for (const step of res.path) {
    const t = tileAt(s, step.x, step.y, 1);
    assert.ok(t && !t.obstacle && t.terrain !== 'water', 'every step lands on open UNDERGROUND tiles');
  }

  // The same walk on the surface is blocked (the rocks are real up there),
  // proving the two levels' grids are independent.
  hero.z = 0;
  assert.equal(findPath(s, hero, c.x, c.y, -1)?.path.some((st) => st.x === c.x && st.y === c.y) || null,
    null, 'surface target inside the rock wall is not enterable');
});

// ---------------------------------------------------------------------------
// Levels on entities, underground play
// ---------------------------------------------------------------------------

test('heroes and towns default to the surface (z = 0); selectors are level-aware', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  for (const h of Object.values(s.heroes)) assert.equal(h.z, 0, 'hero starts on the surface');
  for (const t of Object.values(s.towns)) {
    // Player start towns sit on the surface. Neutral towns live on the level
    // that seated them — the underground's vault anchors carry z: 1, while
    // (from 56x46 up) the countryside's neutral freeholds carry z: 0 — and
    // each town's z must name the level whose grid actually holds its object.
    if (t.owner >= 0) assert.equal(t.z, 0, `start town ${t.name} is on the surface`);
    const m = t.z ? s.map.underground : s.map;
    const obj = m.objects[m.tiles[t.y * s.map.w + t.x].objectId];
    assert.ok(obj && obj.type === 'town' && obj.townId === t.id,
      `town ${t.name} stands on its own level's grid`);
  }
  assert.ok(Object.values(s.towns).some((t) => t.owner === -1 && t.z === 1),
    'the underground still anchors neutral cavern towns');
  const fresh = createHero(s, 'valeska', 0, 5, 5);
  assert.equal(fresh.z, 0, 'newly created heroes default to the surface');

  // A hero underground is invisible to surface-level lookups, and vice versa.
  fresh.z = 1;
  assert.equal(heroAt(s, 5, 5), null, 'not found on the surface');
  assert.equal(heroAt(s, 5, 5, 1), fresh, 'found on level 1');
  delete s.heroes[fresh.id];

  // levelMap/levelObjects/getObject address the two layers.
  assert.equal(levelMap(s, 0), s.map);
  assert.equal(levelMap(s, 1), s.map.underground);
  const uid0 = Object.keys(levelObjects(s, 1))[0];
  assert.ok(uid0.startsWith('U'));
  assert.equal(getObject(s, uid0), s.map.underground.objects[uid0], 'getObject finds underground ids');
});

test('underground play: pickups, mine flagging and income work on level 1', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const ug = s.map.underground;
  const hero = readyHero(s);
  const c = clearUnderBlock(s, 40, 20);
  hero.z = 1; hero.x = c.x; hero.y = c.y;

  // Pickup: a resource pile placed beside the hero.
  const rid = `U${ug.nextOid++}`;
  ug.objects[rid] = { id: rid, x: c.x + 1, y: c.y, type: 'resource', resource: 'gems', amount: 7 };
  ug.tiles[c.y * s.map.w + (c.x + 1)].objectId = rid;
  const gems0 = s.players[0].resources.gems;
  const ev = stepHero(s, hero, { x: c.x + 1, y: c.y, cost: 100 });
  assert.equal(ev.type, 'pickup');
  assert.equal(s.players[0].resources.gems, gems0 + 7, 'gems credited');
  assert.equal(ug.objects[rid], undefined, 'consumed from the UNDERGROUND dict');
  assert.equal(objectAt(s, c.x + 1, c.y, 1), null, 'tile reference cleaned');

  // Mine flagging: pull a real underground mine next to the hero. Clear the block
  // FIRST and only then choose the mine — clearUnderBlock deletes whatever it
  // covers, and with a well-stocked underworld the first mine in the dict can
  // itself sit inside that block, leaving this test re-pointing a tile at an
  // already-deleted object.
  const m = clearUnderBlock(s, 40, 26); // fresh clean block for the mine
  const mine = Object.values(ug.objects).find((o) => o.type === 'mine');
  assert.ok(mine, 'the vault holds a mine');
  ug.tiles[mine.y * s.map.w + mine.x].objectId = null;
  mine.x = m.x + 1; mine.y = m.y;
  ug.tiles[m.y * s.map.w + (m.x + 1)].objectId = mine.id;
  hero.x = m.x; hero.y = m.y; hero.mp = 5000;
  const flag = stepHero(s, hero, { x: mine.x, y: mine.y, cost: 100 });
  assert.equal(flag.type, 'mineFlagged');
  assert.equal(mine.owner, 0);
  const income = dailyIncome(s, s.players[0]);
  const [resName, amount] = Object.entries(CONFIG.MINE_INCOME[mine.mineType])[0];
  assert.ok((income[resName] || 0) >= amount, 'an underground mine pays daily income');
});

// ---------------------------------------------------------------------------
// Save format
// ---------------------------------------------------------------------------

test('save/load: v2 round-trips the underground, under-fog and hero levels', () => {
  const s = newGame({ seed: 12345 });
  const hero = playerHeroes(s, 0)[0];
  hero.z = 1; hero.x = 10; hero.y = 10;
  s.fogUnder[0][10 * s.map.w + 10] = 1;

  const json = serialize(s);
  const s2 = deserialize(json);
  assert.equal(s2.version, SAVE_VERSION);
  assert.equal(JSON.stringify(s2.map.underground.tiles), JSON.stringify(s.map.underground.tiles));
  assert.deepEqual(Object.keys(s2.map.underground.objects), Object.keys(s.map.underground.objects));
  assert.equal(s2.heroes[hero.id].z, 1, 'hero map level survives');
  assert.equal(s2.fogUnder.length, s.fogUnder.length);
  for (let i = 0; i < s.fogUnder.length; i++) {
    assert.ok(s2.fogUnder[i] instanceof Uint8Array, 'under-fog restored as Uint8Array');
    assert.deepEqual(Array.from(s2.fogUnder[i]), Array.from(s.fogUnder[i]));
  }
  // Round-trip is a fixed point with the new fields aboard.
  assert.equal(serialize(deserialize(json)), json, 'idempotent');
});

test('save/load: a v1 save (no underground) migrates and still plays', () => {
  // Fabricate a faithful v1 save from a fresh game: strip everything the
  // underground added, exactly as a pre-underground build would have written.
  const raw = JSON.parse(serialize(newGame({ seed: 12345 })));
  raw.version = 1;
  delete raw.map.underground;
  delete raw.fogUnder;
  for (const t of raw.map.tiles) {
    if (t.objectId && raw.map.objects[t.objectId]?.type === 'subGate') t.objectId = null;
  }
  for (const [id, o] of Object.entries(raw.map.objects)) {
    if (o.type === 'subGate') delete raw.map.objects[id];
  }
  for (const h of Object.values(raw.heroes)) delete h.z;
  for (const t of Object.values(raw.towns)) delete t.z;

  const s = deserialize(JSON.stringify(raw));
  assert.equal(s.version, SAVE_VERSION, 'lifted to the current version');
  assert.equal(s.map.underground, null, 'no underground — a single-level game');
  assert.equal(s.fogUnder.length, s.players.length, 'an under-fog slot per player');
  for (const f of s.fogUnder) assert.ok(f instanceof Uint8Array, 'typed, empty layers');
  for (const h of Object.values(s.heroes)) assert.equal(h.z, 0, 'heroes lifted to the surface');
  for (const t of Object.values(s.towns)) assert.equal(t.z, 0, 'towns lifted to the surface');

  // The migrated game runs: selectors, fog and the turn engine all hold.
  assert.equal(tileAt(s, 5, 5, 1), null, 'level-1 lookups degrade to null');
  assert.equal(isExplored(s, 0, 5, 5, 1), false, 'level-1 fog reads unexplored');
  const hero = playerHeroes(s, 0)[0];
  assert.ok(findPath(s, hero, hero.x + 2, hero.y, -1), 'pathfinding still works');
  endTurn(s); endTurn(s);
  assert.equal(s.day, 2, 'the turn engine advanced a day');
  // And it re-saves cleanly as v2.
  const again = deserialize(serialize(s));
  assert.equal(again.map.underground, null);
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

test('AI: full turns with the underground present — bounded transits, no loops', () => {
  const s = newGame({ seed: 4242 });
  let guard = 300;
  while (s.winner === null && s.day <= 8 && guard-- > 0) {
    const ai = new AITurnController(s, s.currentPlayer);
    let r, g2 = 80;
    do {
      r = ai.next();
      if (r.type === 'combat') ai.autoFight(r.context);
    } while (r.type !== 'done' && g2-- > 0);
    assert.equal(r.type, 'done', 'every AI turn terminates');
    // v2 contract: heroes MAY descend on purpose, but connector use is hard
    // capped per hero per turn and a used gate pair cools down for the turn,
    // so no hero can ping-pong through a gate.
    const perHero = new Map();
    for (const t of ai.transitLog) {
      if (t.type === 'disembark') continue; // completion of a boat trip, uncapped
      perHero.set(t.heroId, (perHero.get(t.heroId) || 0) + 1);
      const key = `${t.heroId}|${t.type}|${t.channel}`;
      perHero.set(key, (perHero.get(key) || 0) + 1);
      if (t.type === 'subGate' || t.type === 'portal') {
        assert.ok(perHero.get(key) <= 1, `no repeat transit of ${t.type} ${t.channel} in one turn`);
      }
    }
    for (const h of Object.values(s.heroes)) {
      const n = perHero.get(h.id) || 0;
      assert.ok(n <= 4, `per-hero per-turn transit cap holds (${n})`);
      assert.ok((h.z ?? 0) === 0 || (h.z ?? 0) === 1, 'heroes stay on a real map level');
    }
    endTurn(s);
  }
  assert.ok(guard > 0, 'no infinite loop across a week of play');
});

test('AI: a hero starting a turn underground acts safely (no crash, no loop)', () => {
  const s = newGame({ seed: 4242 });
  endTurn(s); // AI's turn
  const aiHero = playerHeroes(s, 1)[0];
  const c = clearUnderBlock(s, 22, 22);
  aiHero.z = 1; aiHero.x = c.x; aiHero.y = c.y;

  const ai = new AITurnController(s, 1);
  let r, guard = 80;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'the turn terminates');
  assert.ok(guard > 0, 'no loop');
  // v2: the hero is no longer forced to hold — it may clear the vault or
  // surface through a gate — but it must remain a valid, live hero on a real
  // level with non-negative movement.
  assert.ok(s.heroes[aiHero.id], 'the hero survived its own turn');
  assert.ok((aiHero.z ?? 0) === 0 || (aiHero.z ?? 0) === 1, 'on a real map level');
  assert.ok(aiHero.mp >= 0, 'movement points never negative');
});
