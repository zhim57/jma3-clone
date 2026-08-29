/**
 * scenario-epic.test.js — the "Clash of Kingdoms" epic scenario package:
 * neutral surface towns, the obelisk and wayfarer's-camp landmark visitables,
 * and the new 96×80 three-player preset.
 *
 * Contracts pinned here:
 *   - preset: SCENARIOS gains a 96×80 'clash' entry carrying a default
 *     3-player roster (1 human vs 2 allied AI), without disturbing the five
 *     classic presets or the default index;
 *   - generator, neutral surface towns: an area-scaled number of NEUTRAL
 *     (owner -1, z 0), garrisoned, capturable towns — none at 44×36 and
 *     below (small presets keep their classic feel), 6 on the epic size, so
 *     a 3-player epic map seats 9 surface castles. Each is spaced away from
 *     the start towns, garrisoned from its own faction's roster, starts at
 *     the start-town building baseline, and is provably foot-reachable from
 *     EVERY start town (strict 4-dir flood, harsher than the game's A*);
 *   - generator, landmarks: a generous, area-scaled scattering of obelisks
 *     (the most numerous booster class on the map) and some wayfarer's
 *     camps, all foot-reachable, none inside a pass corridor;
 *   - engine, 'move' booster: grants CONFIG.MOVE_BOOST movement, at most
 *     once per hero per day, resets at dawn, and its per-hero record
 *     (hero.boostDays) round-trips save/load byte-for-byte;
 *   - engine, 'obelisk' booster: reveals a CONFIG.OBELISK_REVEAL disc of fog
 *     and pays CONFIG.OBELISK_XP experience once per hero; a second visit is
 *     a no-op;
 *   - robustness: a 300-seed sweep of the 3-player epic size generates with
 *     0 crashes, every town reachable; same seed → identical map twice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { SCENARIOS, DEFAULT_SCENARIO } from '../src/data/scenarios.js';
import { FACTIONS } from '../src/data/factions.js';
import { CREATURES } from '../src/data/creatures.js';
import {
  newGame, serialize, deserialize, playerHeroes, playerTowns,
} from '../src/core/GameState.js';
import { stepHero, endTurn, boosterName, boosterEffect } from '../src/core/actions.js';
import { generateMap, neutralSurfaceTownCount } from '../src/map/MapGenerator.js';
import { isExplored } from '../src/map/fog.js';
import { heroMaxMovement } from '../src/core/heroUtils.js';
import { Rng } from '../src/core/rng.js';

const EPIC = SCENARIOS.find((s) => s.id === 'clash');
const PLAYERS_3 = [
  { faction: 'castle', team: 0 },
  { faction: 'inferno', team: 1 },
  { faction: 'inferno', team: 1 },
];

/** Build a map the way GameState.newGame does, minus the rest of the state. */
function buildMap(seed, w = 44, h = 36, players = [{ faction: 'castle' }, { faction: 'inferno' }]) {
  const towns = [];
  const map = generateMap({
    w, h, rng: new Rng(seed), players,
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  return { map, towns };
}

/** Strict 4-dir foot flood; towns/portals/gates are solid landmarks. */
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
  const stack = [];
  for (const s of seeds) { const i = s.y * w + s.x; if (!seen[i]) { seen[i] = 1; stack.push(i); } }
  while (stack.length) {
    const i = stack.pop(); const x = i % w;
    if (x > 0 && !seen[i - 1] && open(i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !seen[i + 1] && open(i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
    if (i >= w && !seen[i - w] && open(i - w)) { seen[i - w] = 1; stack.push(i - w); }
    if (i < w * h - w && !seen[i + w] && open(i + w)) { seen[i + w] = 1; stack.push(i + w); }
  }
  return seen;
}

/** Reachable = we can stand on the spot or any of its 8 neighbours. */
function nearReachable(map, seen, obj) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = obj.x + dx, ny = obj.y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.w && ny < map.h && seen[ny * map.w + nx]) return true;
    }
  }
  return false;
}

/** Force a clean (r*2+1)² block of surface grass around (cx, cy). */
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
        if (m.objects[t.objectId]?.type === 'town') continue; // never delete a town
        delete m.objects[t.objectId];
        t.objectId = null;
      }
    }
  }
  return { x: cx, y: cy };
}

/** Drop an object onto the live surface at (x, y); returns it. */
function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
}

/** End turns until the day rolls over. */
function nextDay(state) {
  const d0 = state.day;
  let guard = 10;
  while (state.day === d0 && guard-- > 0) endTurn(state);
  assert.equal(state.day, d0 + 1, 'the day advanced');
}

const surfaceNeutrals = (towns) => towns.filter((t) => (t.z ?? 0) === 0 && t.owner === -1);
const startTowns = (towns) => towns.filter((t) => (t.z ?? 0) === 0 && t.owner >= 0);

// ---------------------------------------------------------------------------
// The preset
// ---------------------------------------------------------------------------

test('SCENARIOS: the epic preset exists; the classic ladder is untouched', () => {
  const classics = [
    ['skirmish', 36, 30], ['duel', 44, 36], ['frontier', 56, 46],
    ['realms', 72, 60], ['empire', 88, 72],
  ];
  for (let i = 0; i < classics.length; i++) {
    const [id, w, h] = classics[i];
    assert.equal(SCENARIOS[i].id, id, `preset ${i} keeps its id`);
    assert.equal(SCENARIOS[i].mapW, w, `${id} keeps its width`);
    assert.equal(SCENARIOS[i].mapH, h, `${id} keeps its height`);
  }
  assert.equal(SCENARIOS[DEFAULT_SCENARIO].id, 'duel', 'the default preset is unchanged');

  assert.ok(EPIC, "the 'clash' preset exists");
  assert.ok(EPIC.mapW * EPIC.mapH > 88 * 72, 'bigger than the previous largest preset');
  assert.equal(EPIC.mapW, 96);
  assert.equal(EPIC.mapH, 80);

  // The default roster: 3 players, entry 0 human, a 1v2 team split (the
  // two-zone map splits every match into two sides), all factions real.
  assert.equal(EPIC.players.length, 3, 'carries a default 3-player roster');
  assert.equal(EPIC.players[0].isHuman, true, 'entry 0 is the human');
  assert.ok(EPIC.players.slice(1).every((p) => !p.isHuman), 'the rest are AI');
  const teams = new Set(EPIC.players.map((p) => p.team));
  assert.equal(teams.size, 2, 'two sides (the map is a two-zone layout)');
  for (const p of EPIC.players) assert.ok(FACTIONS[p.faction], `${p.faction} is a real faction`);
});

test('newGame accepts the preset roster: 3 players, each with a town and a hero', () => {
  const s = newGame({ seed: 11, mapW: EPIC.mapW, mapH: EPIC.mapH, players: EPIC.players });
  assert.equal(s.players.length, 3);
  for (const p of s.players) {
    assert.equal(playerTowns(s, p.index).length, 1, `player ${p.index} starts with one town`);
    assert.equal(playerHeroes(s, p.index).length, 1, `player ${p.index} starts with a hero`);
  }
  const surface = Object.values(s.towns).filter((t) => (t.z ?? 0) === 0);
  assert.equal(surface.length, 9, '3 start towns + 6 neutral holds = 9 surface castles');
  // A couple of days must simply tick over (income, AI-facing state intact).
  endTurn(s); endTurn(s); endTurn(s);
  assert.equal(s.winner, null, 'nobody won by sitting still');
});

// ---------------------------------------------------------------------------
// Generator: neutral surface towns
// ---------------------------------------------------------------------------

test('generator: the neutral-surface-town ladder — none on small maps, 6 on the epic size', () => {
  const expected = new Map([
    ['36x30', 0], ['44x36', 0], ['56x46', 1], ['72x60', 3], ['88x72', 5], ['96x80', 6],
  ]);
  for (const [key, want] of expected) {
    const [w, h] = key.split('x').map(Number);
    assert.equal(neutralSurfaceTownCount(w, h), want, `${key}: ladder formula`);
    const { towns } = buildMap(7, w, h);
    assert.equal(surfaceNeutrals(towns).length, want, `${key}: seats the full count (seed 7)`);
  }
});

test('generator: epic neutral towns are garrisoned, varied, spaced, baseline-built', () => {
  for (const seed of [7, 42, 2024]) {
    const { map, towns } = buildMap(seed, EPIC.mapW, EPIC.mapH, PLAYERS_3);
    const starts = startTowns(towns);
    const neutrals = surfaceNeutrals(towns);
    assert.equal(starts.length, 3, `seed ${seed}: three start towns`);
    assert.equal(neutrals.length, 6, `seed ${seed}: six neutral surface towns`);

    const factionsSeen = new Set();
    for (const t of neutrals) {
      assert.equal(t.owner, -1, 'neutral until captured');
      assert.equal(t.z, 0, 'lives on the surface');
      assert.ok(FACTIONS[t.faction], 'a real faction');
      factionsSeen.add(t.faction);
      assert.ok(t.buildings.includes('villageHall') && t.buildings.includes('fort')
        && t.buildings.includes('tavern') && t.buildings.includes('dwelling1'),
      'the start-town building baseline');
      assert.ok(!t.buildings.includes('capitol') && !t.buildings.includes('cityHall'),
        'a foothold, not an instant capital');
      assert.ok(t.available[1] > 0, 'week-1 recruits in stock');
      // A genuine defending garrison from its OWN faction's roster.
      const gv = t.garrison.reduce(
        (v, st) => v + (st ? (CREATURES[st.creature]?.aiValue || 0) * st.count : 0), 0,
      );
      assert.ok(gv >= 1000, `a real garrison (value ${gv})`);
      for (const st of t.garrison) {
        if (st) assert.equal(CREATURES[st.creature].faction, t.faction, 'garrison from its own roster');
      }
      // A solid town object stands on its tile and references the town.
      const obj = map.objects[map.tiles[t.y * map.w + t.x].objectId];
      assert.ok(obj && obj.type === 'town' && obj.townId === t.id, 'town object on its tile');
      // Spaced away from every start town and every other neutral hold.
      for (const st of starts) {
        assert.ok(Math.hypot(st.x - t.x, st.y - t.y) >= 10, 'clear of the start towns');
      }
      for (const ot of neutrals) {
        if (ot === t) continue;
        assert.ok(Math.hypot(ot.x - t.x, ot.y - t.y) >= 10, 'clear of its neutral neighbours');
      }
    }
    assert.ok(factionsSeen.size >= 2, `seed ${seed}: factions vary (${[...factionsSeen]})`);
  }
});

test('generator: every surface town (and object) reachable from EVERY start town', () => {
  for (const seed of [7, 42, 2024]) {
    const { map, towns } = buildMap(seed, EPIC.mapW, EPIC.mapH, PLAYERS_3);
    for (const start of startTowns(towns)) {
      const seen = flood(map, [{ x: start.x, y: start.y }]);
      for (const t of towns.filter((tt) => (tt.z ?? 0) === 0)) {
        assert.ok(nearReachable(map, seen, t),
          `seed ${seed}: town ${t.name} reachable from start at ${start.x},${start.y}`);
      }
      for (const obj of Object.values(map.objects)) {
        if (obj.seaLocked || obj.type === 'boat' || obj.type === 'whirlpool') continue;
        assert.ok(nearReachable(map, seen, obj),
          `seed ${seed}: ${obj.type} ${obj.id} reachable from ${start.x},${start.y}`);
      }
    }
  }
});

test('generator: 300-seed epic sweep — 0 crashes, full neutral seating, towns reachable', () => {
  for (let k = 1; k <= 300; k++) {
    const seed = k * 7919 + EPIC.mapW * 131 + EPIC.mapH;
    let built;
    // generateMap self-certifies every object from every start town and
    // throws loudly otherwise, so a clean return IS the reachability proof;
    // the flood below re-derives the town half of it independently.
    assert.doesNotThrow(() => { built = buildMap(seed, EPIC.mapW, EPIC.mapH, PLAYERS_3); },
      `seed ${seed} generated cleanly`);
    const { map, towns } = built;
    const neutrals = surfaceNeutrals(towns);
    assert.equal(neutrals.length, 6, `seed ${seed}: all six neutral holds seated`);
    const s0 = startTowns(towns)[0];
    const seen = flood(map, [{ x: s0.x, y: s0.y }]);
    for (const t of towns.filter((tt) => (tt.z ?? 0) === 0)) {
      assert.ok(nearReachable(map, seen, t), `seed ${seed}: town ${t.name} reachable`);
    }
  }
});

test('generator: same seed twice → identical towns and objects (epic, 3 players)', () => {
  const a = buildMap(4242, EPIC.mapW, EPIC.mapH, PLAYERS_3);
  const b = buildMap(4242, EPIC.mapW, EPIC.mapH, PLAYERS_3);
  assert.equal(JSON.stringify(a.towns), JSON.stringify(b.towns), 'towns identical (garrisons included)');
  assert.equal(JSON.stringify(a.map.objects), JSON.stringify(b.map.objects), 'surface objects identical');
  assert.equal(JSON.stringify(a.map.tiles), JSON.stringify(b.map.tiles), 'surface tiles identical');
});

// ---------------------------------------------------------------------------
// Generator: landmark visitables (obelisks + wayfarer's camps)
// ---------------------------------------------------------------------------

test('generator: obelisks are generous and the most numerous booster; camps scale too', () => {
  // Small maps get a handful; the epic size gets a countryside of them.
  const count = (map, type) => Object.values(map.objects)
    .filter((o) => o.type === 'booster' && o.boosterType === type).length;
  const small = buildMap(7, 44, 36).map;
  assert.ok(count(small, 'obelisk') >= 3, `44x36 has obelisks (${count(small, 'obelisk')})`);
  assert.ok(count(small, 'move') >= 1, `44x36 has a wayfarer's camp (${count(small, 'move')})`);

  for (const seed of [7, 42, 2024]) {
    const { map } = buildMap(seed, EPIC.mapW, EPIC.mapH, PLAYERS_3);
    const obelisks = count(map, 'obelisk');
    const camps = count(map, 'move');
    assert.ok(obelisks >= 20, `seed ${seed}: a generous obelisk count (${obelisks})`);
    assert.ok(camps >= 6, `seed ${seed}: wayfarer's camps scale (${camps})`);
    // The signature landmark: more obelisks than ANY other booster type.
    const byType = {};
    for (const o of Object.values(map.objects)) {
      if (o.type === 'booster') byType[o.boosterType] = (byType[o.boosterType] || 0) + 1;
    }
    for (const [type, n] of Object.entries(byType)) {
      if (type !== 'obelisk') assert.ok(obelisks > n, `obelisks (${obelisks}) outnumber ${type} (${n})`);
    }
  }
});

test('generator: landmarks sit on open, unforbidden, foot-reachable ground', () => {
  for (const seed of [7, 2024]) {
    const { map, towns } = buildMap(seed, EPIC.mapW, EPIC.mapH, PLAYERS_3);
    const landmarks = Object.values(map.objects).filter(
      (o) => o.type === 'booster' && (o.boosterType === 'obelisk' || o.boosterType === 'move'),
    );
    assert.ok(landmarks.length >= 26, `seed ${seed}: landmarks placed`);
    const starts = startTowns(towns);
    const seen = flood(map, starts.map((t) => ({ x: t.x, y: t.y })));
    for (const o of landmarks) {
      const tl = map.tiles[o.y * map.w + o.x];
      assert.notEqual(tl.terrain, 'water', 'on land');
      assert.equal(tl.obstacle, null, 'on clear ground');
      assert.equal(tl.objectId, o.id, 'owns its tile');
      // The landmark TILE itself lies in the towns' walk component (stronger
      // than near-reachable: a hero must STAND on a booster to use it).
      assert.ok(seen[o.y * map.w + o.x], `${o.id} at ${o.x},${o.y} is foot-reachable`);
    }
  }
});

// ---------------------------------------------------------------------------
// Engine: the 'move' booster (Wayfarer's Camp)
// ---------------------------------------------------------------------------

test("'move' booster: +MOVE_BOOST once per day per hero, again the next day", () => {
  assert.equal(boosterName('move'), "Wayfarer's Camp");
  assert.match(boosterEffect('move'), new RegExp(`\\+${CONFIG.MOVE_BOOST} movement`));

  const s = newGame({ seed: 1 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 20, 20, 2);
  const camp = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'move' });

  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 500;

  // First visit today: the full boost, minus the step's cost.
  const ev1 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev1.type, 'visited');
  assert.equal(ev1.name, "Wayfarer's Camp");
  assert.equal(hero.mp, 500 - 100 + CONFIG.MOVE_BOOST, 'the boost landed');
  assert.equal(hero.boostDays[camp.id], s.day, 'the visit is recorded for today');
  assert.ok(!hero.visited[camp.id], 'NOT burned as a once-per-hero booster');

  // Step off and back on the same day: politely refused, no second boost.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  const mpBefore = hero.mp;
  const ev2 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev2.type, 'visited');
  assert.match(ev2.text, /already rested/i);
  assert.equal(hero.mp, mpBefore - 100, 'only the step cost was paid');

  // The next dawn: MP refills to the normal max (no leak), and the camp works again.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  nextDay(s);
  assert.equal(hero.mp, heroMaxMovement(s.heroes[hero.id]), 'dawn resets MP to the normal pool');
  const mpDawn = hero.mp;
  const ev3 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev3.type, 'visited');
  assert.equal(hero.mp, mpDawn - 100 + CONFIG.MOVE_BOOST, 'a fresh day, a fresh boost');
  assert.equal(hero.boostDays[camp.id], s.day, 'the record moved to the new day');
  assert.equal(Object.keys(hero.boostDays).length, 1, 'stale entries are pruned');
});

test("'move' booster: hero.boostDays round-trips save/load with no migration", () => {
  const s = newGame({ seed: 2 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 22, 18, 2);
  const camp = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'move' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 300;
  stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });

  const json = serialize(s);
  const s2 = deserialize(json);
  const h2 = s2.heroes[hero.id];
  assert.deepEqual(h2.boostDays, { [camp.id]: s.day }, 'the daily record survives');
  assert.equal(serialize(deserialize(json)), json, 'round-trip is a fixed point');

  // The loaded hero is still refused a second boost today…
  h2.x = spot.x - 1; h2.y = spot.y;
  const mp0 = h2.mp;
  const ev = stepHero(s2, h2, { x: spot.x, y: spot.y, cost: 100 });
  assert.match(ev.text, /already rested/i);
  assert.equal(h2.mp, mp0 - 100, 'no double boost after a reload');

  // …and a PRE-FEATURE hero (no boostDays field at all) lazily gains one.
  delete h2.boostDays;
  h2.x = spot.x - 1;
  nextDay(s2);
  const mp1 = h2.mp;
  const ev2 = stepHero(s2, h2, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev2.type, 'visited');
  assert.equal(h2.mp, mp1 - 100 + CONFIG.MOVE_BOOST, 'an old-save hero gets the boost');
  assert.deepEqual(h2.boostDays, { [camp.id]: s2.day }, 'the record was created lazily');
});

// ---------------------------------------------------------------------------
// Engine: the obelisk
// ---------------------------------------------------------------------------

test('obelisk: reveals a fog disc and pays XP once per hero; second visit is a no-op', () => {
  assert.equal(boosterName('obelisk'), 'Obelisk');
  assert.match(boosterEffect('obelisk'), /reveals/i);

  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  // Stage the obelisk far from the start so its reveal disc is genuinely dark.
  const spot = clearBlock(s, 30, 12, 2);
  const obelisk = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'obelisk' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 1000;

  // A probe tile inside the obelisk's disc but OUTSIDE the hero's own sight
  // (sight is 5 + scouting; the obelisk reveals CONFIG.OBELISK_REVEAL = 10).
  const probe = { x: spot.x, y: spot.y + 9 };
  assert.ok(!isExplored(s, 0, probe.x, probe.y, 0), 'the probe tile starts unexplored');

  const xp0 = hero.xp;
  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'visited');
  assert.equal(ev.name, 'Obelisk');
  assert.ok(isExplored(s, 0, probe.x, probe.y, 0), 'the obelisk revealed the far tile');
  assert.ok(!isExplored(s, 1, probe.x, probe.y, 0), "the enemy's fog is untouched");
  assert.equal(hero.xp, xp0 + CONFIG.OBELISK_XP, 'the experience award landed');
  assert.equal(hero.visited[obelisk.id], true, 'burned as a once-per-hero visit');

  // Second visit: nothing more to gain.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  const ev2 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev2.type, 'visited');
  assert.match(ev2.text, /already benefited/i);
  assert.equal(hero.xp, xp0 + CONFIG.OBELISK_XP, 'no double XP');
});

test('obelisk underground: the reveal lands on the HERO’s own level', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = playerHeroes(s, 0)[0];
  // Stage an obelisk below ground: clear a cavern block by hand.
  const ug = s.map.underground;
  const cx = 28, cy = 20;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const t = ug.tiles[(cy + dy) * s.map.w + (cx + dx)];
      t.obstacle = null; t.terrain = 'rough';
      if (t.objectId && ug.objects[t.objectId]?.type !== 'town') {
        delete ug.objects[t.objectId]; t.objectId = null;
      }
    }
  }
  const id = `U${ug.nextOid++}`;
  ug.objects[id] = { id, x: cx, y: cy, type: 'booster', boosterType: 'obelisk' };
  ug.tiles[cy * s.map.w + cx].objectId = id;

  hero.z = 1; hero.x = cx - 1; hero.y = cy; hero.mp = 1000;
  const probe = { x: cx, y: cy + 8 };
  assert.ok(!isExplored(s, 0, probe.x, probe.y, 1), 'under-fog starts dark');
  const ev = stepHero(s, hero, { x: cx, y: cy, cost: 100 });
  assert.equal(ev.type, 'visited');
  assert.ok(isExplored(s, 0, probe.x, probe.y, 1), 'the under-level was revealed');
});

// ---------------------------------------------------------------------------
// Non-regression: the classic presets
// ---------------------------------------------------------------------------

test('non-regression: every preset generates deterministically; small ones stay neutral-free', () => {
  for (const sc of SCENARIOS) {
    const a = buildMap(97, sc.mapW, sc.mapH);
    const b = buildMap(97, sc.mapW, sc.mapH);
    const digest = (m) => JSON.stringify({ t: m.map.tiles, o: m.map.objects, towns: m.towns });
    assert.equal(digest(a), digest(b), `${sc.id}: identical across two runs`);
    assert.equal(startTowns(a.towns).length, 2, `${sc.id}: two start towns in a 2-player game`);
    assert.equal(surfaceNeutrals(a.towns).length, neutralSurfaceTownCount(sc.mapW, sc.mapH),
      `${sc.id}: neutral seating matches the ladder`);
  }
  // The two smallest presets keep their classic feel: no neutral holds.
  assert.equal(neutralSurfaceTownCount(36, 30), 0);
  assert.equal(neutralSurfaceTownCount(44, 36), 0);
});
