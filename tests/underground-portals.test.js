/**
 * underground-portals.test.js — linked cavern teleporter pairs (map level 1).
 *
 * The generator now seats an area-scaled number of intra-level portal pairs in
 * the underground (1 pair at the 44x36 reference, up to 3 on large maps),
 * AFTER the gates/towns/treasure and BEFORE the carve, so the per-gate
 * certification proves both ends reachable. Contracts pinned here:
 *   - pairs are exact (two ends per channel), channels 100+ (a fresh
 *     underground counter, disjoint from the surface's 0..3 so channel-keyed
 *     AI cooldowns never conflate levels), real shortcuts (ends apart);
 *   - usePortal teleports a z:1 hero between the ends WITHIN the underground —
 *     the existing engine, unchanged: partners are matched per level, so a
 *     same-channel surface portal is invisible to a cavern transit;
 *   - a seed sweep of full games: 0 crashes, 0 stranded objects — every
 *     underground object (portals included) stays near-reachable from EVERY
 *     gate's underground end;
 *   - the AI prices cavern portals through the ordinary connector machinery
 *     and rides one toward distant vault value — exactly once, no ping-pong;
 *   - save/load round-trips the pairs and a post-load transit still works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, serialize, deserialize, playerHeroes, levelObjects,
} from '../src/core/GameState.js';
import { stepHero, endTurn, useObjectUnderHero } from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { isExplored } from '../src/map/fog.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { Rng } from '../src/core/rng.js';

const AI = 1; // player index of the AI opponent in a fresh game

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

/** 4-dir flood over one level; `solidTypes` block through-traffic. */
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
    if (!seen[i]) { seen[i] = 1; stack.push(i); } // seeds count even if solid
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

// ---- live-state helpers (mirroring underground.test.js patterns) -----------

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

/** Drop an object onto a live state at (x, y) on `level`; returns it. */
function putObj(state, level, x, y, data) {
  const m = level ? state.map.underground : state.map;
  const id = `${level ? 'U' : 'O'}${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * state.map.w + x].objectId = id;
  return obj;
}

function readyHero(state, playerIndex = 0) {
  const hero = playerHeroes(state, playerIndex)[0];
  hero.army = [{ creature: 'pikeman', count: 20, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 5000;
  return hero;
}

/** Portal objects of the underground level, grouped by channel. */
function ugPortalPairs(map) {
  const portals = Object.values(map.underground.objects).filter((o) => o.type === 'portal');
  const byChannel = {};
  for (const p of portals) (byChannel[p.channel] ??= []).push(p);
  return { portals, byChannel };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

test('generator: the underground holds linked portal pairs — channels 100+, real shortcuts', () => {
  // Pair count scales with area: 1 at 44x36, 2 at 56x46, 3 (capped) at 88x72.
  for (const [w, h, minPortals] of [[44, 36, 2], [56, 46, 4], [88, 72, 6]]) {
    for (const seed of [3, 7]) {
      const { map } = buildMap(seed, w, h);
      const { portals, byChannel } = ugPortalPairs(map);
      assert.ok(portals.length >= minPortals,
        `${w}x${h} seed ${seed}: at least ${minPortals / 2} pair(s) seated (got ${portals.length} portals)`);
      assert.equal(portals.length % 2, 0, 'portals come in pairs');
      for (const p of portals) {
        assert.ok(p.id.startsWith('U'), `underground ids are U-prefixed (${p.id})`);
        assert.ok(p.channel >= 100, `fresh underground channel counter (100+), got ${p.channel}`);
      }
      for (const [ch, pair] of Object.entries(byChannel)) {
        assert.equal(pair.length, 2, `channel ${ch} is exactly a pair`);
        assert.equal(pair[0].color, pair[1].color, 'a pair shares its colour');
        const d = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        assert.ok(d >= 6, `pair ${ch} is a real shortcut (${d.toFixed(1)} tiles apart)`);
      }
      // Channel namespaces never overlap across levels (the AI's cross-turn
      // cooldowns key on `portal|channel` with no level qualifier).
      const surfaceCh = new Set(Object.values(map.objects)
        .filter((o) => o.type === 'portal').map((o) => o.channel));
      for (const p of portals) {
        assert.ok(!surfaceCh.has(p.channel), `channel ${p.channel} unused on the surface`);
      }
    }
  }
});

test('generator: every underground portal opens onto walkable ground (no rock-boxed exits)', () => {
  // clearObstaclesAround(r=1) strips the 3×3 around both ends, and findSpot keeps
  // a 2-tile ring free of other objects — so all 8 neighbours are open cavern
  // floor. A hero teleported onto an exit can always step off (or Space back).
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [w, h] of [[44, 36], [56, 46], [88, 72]]) {
    for (const seed of [3, 7, 42, 99]) {
      const { map } = buildMap(seed, w, h);
      const ug = map.underground;
      for (const p of Object.values(ug.objects).filter((o) => o.type === 'portal')) {
        let walk = 0;
        for (const [dx, dy] of NB) {
          const nx = p.x + dx, ny = p.y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const t = ug.tiles[ny * w + nx];
          if (t && !t.obstacle && t.terrain !== 'water' && !t.objectId) walk++;
        }
        assert.ok(walk >= 8, `${w}x${h} seed ${seed}: portal ${p.id} hemmed in (walkable neighbours=${walk})`);
      }
    }
  }
});

test('fuzz: a seed sweep of full games — 0 crashes, pairs exact, vault still gate-certified', () => {
  // newGame retries nudged seeds on the rare carve failure, so a clean return
  // per seed is itself the no-crash half; the flood re-derives "nothing is
  // stranded" (portals included) from every gate independently.
  const SOLID = new Set(['town', 'portal', 'subGate']);
  for (let seed = 0; seed < 300; seed++) {
    let s;
    assert.doesNotThrow(() => { s = newGame({ seed }); }, `seed ${seed} crashed New Game`);
    const ug = s.map.underground;
    const { portals, byChannel } = ugPortalPairs(s.map);
    assert.ok(portals.length >= 2, `seed ${seed}: at least one underground pair`);
    for (const pair of Object.values(byChannel)) {
      assert.equal(pair.length, 2, `seed ${seed}: exact pairs only (no orphan portal)`);
    }
    const gates = Object.values(ug.objects).filter((o) => o.type === 'subGate');
    assert.ok(gates.length >= 1, `seed ${seed}: the underground has a gate`);
    for (const g of gates) {
      const seen = flood(ug, [{ x: g.x, y: g.y }], SOLID);
      for (const obj of Object.values(ug.objects)) {
        assert.ok(nearReachable(ug, seen, obj),
          `seed ${seed}: ${obj.type} ${obj.id} stranded from gate ${g.id}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Engine (usePortal — no changes needed, pinned as level-aware)
// ---------------------------------------------------------------------------

test('usePortal: an underground pair teleports a z:1 hero; channels never cross levels', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = readyHero(s);

  const a = clearUnderBlock(s, 20, 20);
  const b = clearUnderBlock(s, 36, 30);
  putObj(s, 1, a.x, a.y, { type: 'portal', channel: 777, color: 0 });
  putObj(s, 1, b.x, b.y, { type: 'portal', channel: 777, color: 0 });
  // A SURFACE portal on the same channel must be invisible to a cavern
  // transit (partners are matched within the hero's own level).
  putObj(s, 0, 5, 5, { type: 'portal', channel: 777, color: 0 });

  hero.z = 1; hero.x = a.x; hero.y = a.y + 1;
  const ev = stepHero(s, hero, { x: a.x, y: a.y, cost: 100 });
  assert.equal(ev.type, 'portal', 'a portal event fired');
  assert.deepEqual(ev.to, { x: b.x, y: b.y }, 'emerged at the UNDERGROUND partner');
  assert.equal(hero.z, 1, 'the hero stayed underground');
  assert.equal(hero.x, b.x);
  assert.equal(hero.y, b.y);
  assert.ok(isExplored(s, 0, b.x, b.y, 1), 'under-fog revealed around the exit');

  // Walk off, walk back on → returns (arriving never re-fires, so no ping-pong).
  const off = stepHero(s, hero, { x: b.x + 1, y: b.y, cost: 100 });
  assert.equal(off.type, 'moved');
  const back = stepHero(s, hero, { x: b.x, y: b.y, cost: 100 });
  assert.equal(back.type, 'portal');
  assert.equal(hero.x, a.x, 'returned through the pair');
  assert.equal(hero.z, 1, 'still underground');
});

test('useObjectUnderHero: Space re-enters the portal you are standing on (escape a boxed-in exit)', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = readyHero(s);
  const a = clearUnderBlock(s, 20, 20);
  const b = clearUnderBlock(s, 36, 30);
  putObj(s, 1, a.x, a.y, { type: 'portal', channel: 555, color: 0 });
  putObj(s, 1, b.x, b.y, { type: 'portal', channel: 555, color: 0 });
  // The hero is STANDING ON end A (as if just teleported here) — no fresh step.
  hero.z = 1; hero.x = a.x; hero.y = a.y;
  const ev = useObjectUnderHero(s, hero);
  assert.equal(ev.type, 'portal', 're-use fires without stepping');
  assert.equal(hero.x, b.x); assert.equal(hero.y, b.y);
  assert.equal(hero.z, 1, 'stayed underground');
  assert.ok(isExplored(s, 0, b.x, b.y, 1), 'the far exit is revealed');
  // Off a teleporter → nothing happens (and the hero does not move).
  hero.x = b.x + 1;
  const t = s.map.underground.tiles[hero.y * s.map.w + hero.x];
  if (t.objectId) { delete s.map.underground.objects[t.objectId]; t.objectId = null; }
  assert.equal(useObjectUnderHero(s, hero).type, 'none');
  assert.equal(hero.x, b.x + 1, 'no move off a plain tile');
});

test('useObjectUnderHero: Space re-enters a subterranean gate (step back across levels)', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = readyHero(s);
  const u = clearUnderBlock(s, 24, 24);
  putObj(s, 1, u.x, u.y, { type: 'subGate', channel: 9, color: 9 });
  const sx = 10, sy = 10;
  const st = s.map.tiles[sy * s.map.w + sx];
  st.obstacle = null; st.terrain = 'grass';
  if (st.objectId) { delete s.map.objects[st.objectId]; st.objectId = null; }
  putObj(s, 0, sx, sy, { type: 'subGate', channel: 9, color: 9 });
  hero.z = 1; hero.x = u.x; hero.y = u.y;
  const ev = useObjectUnderHero(s, hero);
  assert.equal(ev.type, 'subGate');
  assert.equal(hero.z, 0, 'emerged to the surface');
  assert.equal(hero.x, sx); assert.equal(hero.y, sy);
});

test('usePortal: a lone underground portal is inert — a plain move', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = readyHero(s);
  const a = clearUnderBlock(s, 20, 20);
  putObj(s, 1, a.x, a.y, { type: 'portal', channel: 888, color: 0 }); // no partner below
  putObj(s, 0, 5, 5, { type: 'portal', channel: 888, color: 0 }); // a surface twin is no partner
  hero.z = 1; hero.x = a.x; hero.y = a.y + 1;
  const ev = stepHero(s, hero, { x: a.x, y: a.y, cost: 100 });
  assert.equal(ev.type, 'moved', 'no same-level partner → no teleport');
  assert.equal(hero.x, a.x, 'hero simply stands on the portal');
  assert.equal(hero.z, 1);
});

test('end to end: a GENERATED underground pair teleports a hero between its ends', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const ug = s.map.underground;
  const { byChannel } = ugPortalPairs(s.map);
  const pair = Object.values(byChannel).find((p) => p.length === 2);
  assert.ok(pair, 'the generator seated a pair on this seed');
  const [pa, pb] = pair;

  // Clear wandering guards near both ends so the approach cannot be hijacked
  // into combat, and open a doorstep beside the entry.
  for (const p of [pa, pb]) {
    for (const o of Object.values(ug.objects)) {
      if (o.type === 'monster' && Math.max(Math.abs(o.x - p.x), Math.abs(o.y - p.y)) <= 2) {
        ug.tiles[o.y * s.map.w + o.x].objectId = null;
        delete ug.objects[o.id];
      }
    }
  }
  const door = ug.tiles[(pa.y + 1) * s.map.w + pa.x];
  door.obstacle = null;
  if (door.objectId) { delete ug.objects[door.objectId]; door.objectId = null; }

  const hero = readyHero(s);
  hero.z = 1; hero.x = pa.x; hero.y = pa.y + 1;
  const ev = stepHero(s, hero, { x: pa.x, y: pa.y, cost: 100 });
  assert.equal(ev.type, 'portal', 'the generated pair fires');
  assert.equal(ev.channel, pa.channel);
  assert.equal(hero.x, pb.x, 'emerged at the far end');
  assert.equal(hero.y, pb.y);
  assert.equal(hero.z, 1, 'still underground');
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

/** Remove every object except towns from one level (0 surface, 1 under). */
function stripObjects(state, level = 0) {
  const m = level ? state.map.underground : state.map;
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

test('AI: an underground hero rides a cavern portal to distant vault value — exactly once', () => {
  const s = newGame({ seed: 4242 });
  stripObjects(s, 0);
  stripObjects(s, 1);
  fortifyEnemies(s);
  impoverish(s);

  const hero = playerHeroes(s, AI)[0];
  hero.army = [{ creature: 'pikeman', count: 20, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 3000;

  const a = clearUnderBlock(s, 12, 30); // near end, beside the hero
  const b = clearUnderBlock(s, 36, 10); // far end, beside the prize
  putObj(s, 1, a.x, a.y, { type: 'portal', channel: 142, color: 0 });
  putObj(s, 1, b.x, b.y, { type: 'portal', channel: 142, color: 0 });
  const prize = putObj(s, 1, b.x + 1, b.y, { type: 'artifact', artifact: 'titansGladius' });
  hero.z = 1;
  hero.x = a.x;
  hero.y = a.y + 1;

  const ai = runTurn(s);

  assert.equal(ai.metrics.transits.portal, 1, 'rode the cavern portal exactly once — no ping-pong');
  assert.equal(levelObjects(s, 1)[prize.id], undefined, 'the far vault prize was collected');
  assert.equal(hero.z, 1, 'the transit stayed within the underground');
  assert.ok(hero.mp >= 0, 'movement points never negative');
  // The transit trail shows no repeat of the pair within the turn.
  const portalTransits = ai.transitLog.filter((t) => t.type === 'portal');
  assert.equal(portalTransits.length, 1);
  assert.equal(portalTransits[0].channel, 142);
});

test('AI: full turns on a map with generated cavern portals — bounded transits, no loops', () => {
  // seed 3 at 56x46 generates two underground pairs; play both realms for a
  // few in-game days and hold the anti-oscillation contract underground too.
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  // Start one AI hero underground so cavern portals are genuinely in play.
  const aiH = playerHeroes(s, AI)[0];
  const c = clearUnderBlock(s, 22, 22);
  aiH.z = 1; aiH.x = c.x; aiH.y = c.y;

  let guard = 60;
  while (s.winner === null && s.day <= 6 && guard-- > 0) {
    const ai = new AITurnController(s, s.currentPlayer);
    let r, g2 = 100;
    do {
      r = ai.next();
      if (r.type === 'combat') ai.autoFight(r.context);
    } while (r.type !== 'done' && g2-- > 0);
    assert.equal(r.type, 'done', 'every AI turn terminates');
    // No portal/gate pair is ridden twice by one hero in one turn.
    const seen = new Map();
    for (const t of ai.transitLog) {
      if (t.type !== 'portal' && t.type !== 'subGate') continue;
      const key = `${t.heroId}|${t.type}|${t.channel}`;
      seen.set(key, (seen.get(key) || 0) + 1);
      assert.ok(seen.get(key) <= 1, `no repeat transit of ${t.type} ${t.channel} in one turn`);
    }
    endTurn(s);
  }
  assert.ok(guard > 0, 'no infinite loop across the simulated days');
});

// ---------------------------------------------------------------------------
// Save format
// ---------------------------------------------------------------------------

test('save/load: underground portal pairs round-trip and still teleport', () => {
  const s = newGame({ seed: 12345 });
  const before = ugPortalPairs(s.map).portals;
  assert.ok(before.length >= 2, 'the seed generates at least one pair');

  const json = serialize(s);
  const s2 = deserialize(json);
  const after = ugPortalPairs(s2.map).portals;
  assert.equal(JSON.stringify(after), JSON.stringify(before), 'portal objects survive byte-identically');
  assert.equal(serialize(deserialize(json)), json, 'round-trip is a fixed point');

  // A transit still works on the LOADED state.
  const pair = Object.values(ugPortalPairs(s2.map).byChannel).find((p) => p.length === 2);
  const [pa, pb] = pair;
  const ug = s2.map.underground;
  for (const p of [pa, pb]) {
    for (const o of Object.values(ug.objects)) {
      if (o.type === 'monster' && Math.max(Math.abs(o.x - p.x), Math.abs(o.y - p.y)) <= 2) {
        ug.tiles[o.y * s2.map.w + o.x].objectId = null;
        delete ug.objects[o.id];
      }
    }
  }
  const door = ug.tiles[(pa.y + 1) * s2.map.w + pa.x];
  door.obstacle = null;
  if (door.objectId) { delete ug.objects[door.objectId]; door.objectId = null; }
  const hero = readyHero(s2);
  hero.z = 1; hero.x = pa.x; hero.y = pa.y + 1;
  const ev = stepHero(s2, hero, { x: pa.x, y: pa.y, cost: 100 });
  assert.equal(ev.type, 'portal', 'a loaded pair still fires');
  assert.equal(hero.x, pb.x);
  assert.equal(hero.y, pb.y);
});
