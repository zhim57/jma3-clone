/**
 * underground-towns.test.js — neutral, capturable towns in the underground.
 *
 * v3 of the underground turns the lower level from a loot pile into a real
 * strategic objective: the generator seats a small, area-scaled number of
 * NEUTRAL towns down there (owner -1, z: 1), each behind a genuine defending
 * garrison, registered through the SAME registerTown callback as the surface
 * start towns — so they live in state.towns and every owner-keyed system
 * counts them automatically. Contracts pinned here:
 *   - generation: neutral, garrisoned, faction-valid towns with z: 1, solid on
 *     the underground grid, area-scaled in number, reachable from EVERY gate;
 *   - capture: a garrisoned cavern town is a siege; winning transfers
 *     ownership, clears the garrison and lifts under-fog around it;
 *   - economy: a captured underground town pays daily hall income and grows
 *     its dwellings weekly, exactly like a surface town;
 *   - defeat/victory: a player whose ONLY town is underground is neither
 *     starved out (daysWithoutTown stays 0) nor instantly defeated, and a team
 *     only wins when it holds every surviving realm across BOTH levels;
 *   - taverns: a hero hired in a cavern town spawns UNDERGROUND (z: 1);
 *   - save v2 round-trips a captured underground town byte-for-byte;
 *   - AI: a reachable underground town is a top-tier goal — the AI besieges
 *     one it stands near, and descends through a gate to take one it can only
 *     reach from the surface, without violating any anti-oscillation cap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import {
  newGame, serialize, deserialize, playerHeroes, playerTowns,
} from '../src/core/GameState.js';
import {
  stepHero, endTurn, dailyIncome, checkVictory, captureTown, hireHero,
  hireableHeroes, townHasDefenders,
} from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { isExplored } from '../src/map/fog.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { Rng } from '../src/core/rng.js';
import { CREATURES } from '../src/data/creatures.js';
import { FACTIONS } from '../src/data/factions.js';
import { armyValue } from '../src/core/heroUtils.js';

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

/** 4-dir flood over one level; towns/portals/gates are solid landmarks. */
function flood(level, w, h, seeds) {
  const SOLID = new Set(['town', 'portal', 'subGate']);
  const seen = new Uint8Array(w * h);
  const stack = [];
  const open = (i) => {
    const t = level.tiles[i];
    if (t.terrain === 'water' || t.obstacle) return false;
    const o = t.objectId && level.objects[t.objectId];
    return !(o && SOLID.has(o.type));
  };
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
    if (town.owner !== aiIndex && town.owner !== -1) {
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

/** Force a clean (r*2+1)² block of open ground around (cx, cy) on `level`. */
function clearBlock(state, level, cx, cy, r = 2) {
  const m = level ? state.map.underground : state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= state.map.w || y >= state.map.h) continue;
      const t = m.tiles[y * state.map.w + x];
      t.obstacle = null;
      t.terrain = level ? 'rough' : 'grass';
      if (t.objectId) {
        if (m.objects[t.objectId]?.type === 'town') continue; // never delete a town
        delete m.objects[t.objectId];
        t.objectId = null;
      }
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

const ugTownsOf = (s) => Object.values(s.towns).filter((t) => (t.z ?? 0) === 1);

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

test('generator: neutral, garrisoned underground towns with z:1, area-scaled and solid', () => {
  const seen = [];
  for (const [w, h] of [[36, 30], [44, 36], [56, 46], [88, 72]]) {
    const { map, towns } = buildMap(7, w, h);
    const ug = map.underground;
    const ugTowns = towns.filter((t) => (t.z ?? 0) === 1);
    const expected = Math.max(1, Math.min(3, Math.round((w * h) / (44 * 36))));
    assert.equal(ugTowns.length, expected, `${w}x${h}: area-scaled town count`);
    seen.push(ugTowns.length);
    for (const t of ugTowns) {
      assert.equal(t.owner, -1, 'neutral until captured');
      assert.equal(t.z, 1, 'lives underground');
      assert.ok(FACTIONS[t.faction], 'a real faction');
      assert.ok(t.buildings.includes('villageHall') && t.buildings.includes('fort'),
        'modest baseline buildings');
      assert.ok(!t.buildings.includes('capitol') && !t.buildings.includes('cityHall'),
        'a foothold, not an instant capital');
      const gv = t.garrison.reduce(
        (v, st) => v + (st ? (CREATURES[st.creature]?.aiValue || 0) * st.count : 0), 0,
      );
      assert.ok(gv >= 2000, `a genuine defending garrison (value ${gv})`);
      for (const st of t.garrison) {
        if (st) assert.equal(CREATURES[st.creature].faction, t.faction, 'garrison from its own roster');
      }
      // Solid landmark on the underground grid, referencing the registered town.
      const objId = ug.tiles[t.y * map.w + t.x].objectId;
      const obj = ug.objects[objId];
      assert.ok(obj && obj.type === 'town' && obj.townId === t.id, 'town object on its tile');
      assert.ok(obj.id.startsWith('U'), 'underground ids are U-prefixed');
    }
  }
  assert.ok(seen[0] < seen[seen.length - 1], 'bigger maps seat more cavern towns');
});

test('generator: every underground town is reachable from EVERY gate (flood)', () => {
  for (const seed of [1, 7, 42, 999, 2024]) {
    const { map, towns } = buildMap(seed);
    const ug = map.underground;
    const ugTowns = towns.filter((t) => (t.z ?? 0) === 1);
    assert.ok(ugTowns.length >= 1, `seed ${seed}: at least one cavern town`);
    const gates = Object.values(ug.objects).filter((o) => o.type === 'subGate');
    assert.ok(gates.length >= 1);
    for (const g of gates) {
      const seen = flood(ug, map.w, map.h, [{ x: g.x, y: g.y }]);
      for (const t of ugTowns) {
        let ok = false;
        for (let dy = -1; dy <= 1 && !ok; dy++) {
          for (let dx = -1; dx <= 1 && !ok; dx++) {
            const nx = t.x + dx, ny = t.y + dy;
            if (nx >= 0 && ny >= 0 && nx < map.w && ny < map.h && seen[ny * map.w + nx]) ok = true;
          }
        }
        assert.ok(ok, `seed ${seed}: town ${t.id} reachable from gate ${g.id}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Capture (rules engine)
// ---------------------------------------------------------------------------

test('a garrisoned cavern town is a siege; winning it transfers ownership + reveals under-fog', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const town = ugTownsOf(s)[0];
  assert.ok(town, 'a cavern town exists');
  assert.ok(townHasDefenders(s, town), 'the garrison defends it');

  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, 1, town.x - 1, town.y, 1); // an open doorstep beside the town
  hero.z = 1;
  hero.x = town.x - 1;
  hero.y = town.y;
  hero.mp = 1000;
  hero.army = [{ creature: 'archangel', count: 60, hurt: 0 }, null, null, null, null, null, null];

  const ev = stepHero(s, hero, { x: town.x, y: town.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'attacking the neutral town starts a siege');
  assert.equal(ev.context.defender.kind, 'town');
  assert.ok(ev.context.siege, 'flagged as a siege');
  assert.ok(ev.context.defenseBonus >= 2, 'the fort fortifies the defenders');

  // Resolve the battle with the engine's own auto-resolver (via the AI bridge).
  const ai = new AITurnController(s, 0);
  ai.autoFight(ev.context);

  assert.equal(town.owner, 0, 'ownership transferred to the attacker');
  assert.ok(!town.garrison.some((st) => st && st.count > 0), 'the garrison fell');
  assert.ok(isExplored(s, 0, town.x, town.y, 1), 'under-fog lifted around the prize');
  assert.equal(isExplored(s, 1, town.x, town.y, 1), false, "the enemy's under-fog untouched");
  assert.equal(s.winner, null, 'capturing a neutral town ends no game');
});

test('economy: a captured underground town pays income and grows weekly', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const town = ugTownsOf(s)[0];
  const p0 = s.players[0];

  const before = dailyIncome(s, p0);
  captureTown(s, town, 0);
  const after = dailyIncome(s, p0);
  assert.ok((after.gold || 0) > (before.gold || 0), 'the cavern hall pays daily gold once owned');

  // A week passes: the captured town's dwelling stock grows like any other.
  const stock0 = town.available[1];
  let guard = 40;
  while (((s.day - 1) % CONFIG.DAYS_PER_WEEK) + 1 !== 1 || s.day === 1) {
    endTurn(s);
    if (guard-- <= 0) throw new Error('week never turned');
  }
  assert.ok(town.available[1] > stock0, 'weekly growth reached the underground');
});

// ---------------------------------------------------------------------------
// Defeat / victory across levels
// ---------------------------------------------------------------------------

test('starvation: a player whose ONLY town is underground is NOT starved out', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const p0 = s.players[0];
  const ugTown = ugTownsOf(s)[0];
  captureTown(s, ugTown, 0);
  // Hand every surface town of player 0 to the enemy: only the cavern remains.
  for (const t of playerTowns(s, 0).filter((t2) => (t2.z ?? 0) === 0)) captureTown(s, t, 1);
  assert.equal(playerTowns(s, 0).length, 1, 'exactly one town left — underground');

  for (let i = 0; i < 2 * (CONFIG.DAYS_PER_WEEK + 2); i++) endTurn(s);
  assert.equal(p0.daysWithoutTown, 0, 'the underground town feeds the clock');
  assert.equal(p0.defeated, false, 'not starved out');
  assert.equal(s.winner, null, 'the game goes on');
});

test('victory: underground realms count — a team wins only when it holds BOTH levels', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const ugTown = ugTownsOf(s)[0];
  captureTown(s, ugTown, 0);
  for (const t of playerTowns(s, 0).filter((t2) => (t2.z ?? 0) === 0)) captureTown(s, t, 1);
  // Player 0 keeps no heroes: without the cavern town this would be defeat.
  for (const h of playerHeroes(s, 0)) delete s.heroes[h.id];

  assert.equal(checkVictory(s), null, 'holding only an underground town still holds the realm');
  assert.equal(s.players[0].defeated, false);

  // The enemy takes the cavern too — now nothing survives anywhere: defeat.
  captureTown(s, ugTown, 1);
  assert.equal(checkVictory(s), s.players[1].team, 'the enemy team now rules both levels');
  assert.equal(s.players[0].defeated, true);
});

// ---------------------------------------------------------------------------
// Taverns below ground
// ---------------------------------------------------------------------------

test('a hero hired in a captured cavern town spawns UNDERGROUND (z: 1)', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const town = ugTownsOf(s)[0];
  captureTown(s, town, 0);
  assert.ok(town.buildings.includes('tavern'), 'the baseline includes a tavern');
  s.players[0].resources.gold = 10000;
  const pool = hireableHeroes(s, town);
  assert.ok(pool.length > 0, 'the tavern offers recruits');
  const hero = hireHero(s, town, pool[0]);
  assert.ok(hero, 'the hire succeeded');
  assert.equal(hero.z, 1, 'the recruit reports underground, not as a surface ghost');
  assert.equal(hero.x, town.x);
  assert.equal(hero.y, town.y);
  assert.equal(hero.inTownId, town.id, 'visiting the cavern town');
  assert.ok(isExplored(s, 0, town.x, town.y, 1), 'their arrival lifts under-fog');
});

// ---------------------------------------------------------------------------
// Save round-trip
// ---------------------------------------------------------------------------

test('save v2 round-trips a captured underground town (owner/level/garrison/buildings)', () => {
  const s = newGame({ seed: 12345 });
  const town = ugTownsOf(s)[0];
  captureTown(s, town, 0);
  town.garrison[0] = { creature: 'pikeman', count: 9, hurt: 0 };
  town.buildings.push('marketplace');

  const json = serialize(s);
  const s2 = deserialize(json);
  const t2 = s2.towns[town.id];
  assert.ok(t2, 'the town survives the trip');
  assert.equal(t2.owner, 0, 'owner survives');
  assert.equal(t2.z, 1, 'map level survives');
  assert.deepEqual(t2.garrison, town.garrison, 'garrison survives');
  assert.deepEqual(t2.buildings, town.buildings, 'buildings survive');
  // The underground map object still references it.
  const obj = Object.values(s2.map.underground.objects)
    .find((o) => o.type === 'town' && o.townId === town.id);
  assert.ok(obj && obj.x === town.x && obj.y === town.y, 'town object intact underground');
  assert.equal(serialize(deserialize(json)), json, 'round-trip is a fixed point');
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

test('AI: besieges and captures a neutral cavern town it stands near', () => {
  const s = newGame({ seed: 4242 });
  fortifyEnemies(s);
  impoverish(s);
  const town = ugTownsOf(s)[0];
  const hero = playerHeroes(s, AI)[0];
  // Open staging ground on whichever side of the town has room.
  const sy = town.y <= s.map.h / 2 ? 3 : -3;
  clearBlock(s, 1, town.x, town.y + sy, 2);
  hero.z = 1;
  hero.x = town.x;
  hero.y = town.y + sy;
  hero.mp = 3000;
  hero.army = [{ creature: 'archangel', count: 60, hurt: 0 }, null, null, null, null, null, null];
  assert.ok(armyValue(hero.army) > armyValue(town.garrison) * 2, 'clearly beats the garrison');

  runTurn(s);

  assert.equal(town.owner, AI, 'the AI captured the cavern town');
});

test('AI: descends through a gate to capture an underground town (no ping-pong)', () => {
  const s = newGame({ seed: 4242 });
  stripObjects(s, 0);
  fortifyEnemies(s);
  impoverish(s);
  const hero = playerHeroes(s, AI)[0];
  const town = ugTownsOf(s)[0];

  // Stage: hero — staged gate on the surface; partner gate 3 tiles from the
  // cavern town below, on whichever side of it has room. The vault's own loot
  // still exists; the town outranks it.
  const a = clearBlock(s, 0, 30, 12, 2);
  const gx = town.x + (town.x <= s.map.w / 2 ? 3 : -3);
  clearBlock(s, 1, gx, town.y, 2);
  putObj(s, 0, a.x, a.y, { type: 'subGate', channel: 99, color: 0 });
  putObj(s, 1, gx, town.y, { type: 'subGate', channel: 99, color: 0 });
  hero.x = a.x;
  hero.y = a.y + 1;
  hero.mp = 5000;
  hero.army = [{ creature: 'archangel', count: 80, hurt: 0 }, null, null, null, null, null, null];

  const ai = runTurn(s);

  assert.ok(ai.metrics.transits.subGate >= 1, 'the hero descended through the gate');
  assert.equal(hero.z, 1, 'and stayed below (used pair cools down this turn)');
  assert.equal(town.owner, AI, 'the cavern town was captured');
  // Anti-oscillation guarantees hold: no same-channel repeat in one turn.
  const perChannel = new Map();
  for (const t of ai.transitLog) {
    if (t.type !== 'subGate' && t.type !== 'portal') continue;
    const key = `${t.heroId}|${t.type}|${t.channel}`;
    perChannel.set(key, (perChannel.get(key) || 0) + 1);
    assert.ok(perChannel.get(key) <= 1, `no repeat transit of ${t.type} ${t.channel}`);
  }
});
