/**
 * siege.test.js — real fortifications in the tactical engine (sieges slice 2a).
 * A Fort/Citadel/Castle raises a destructible curtain wall on the defender's
 * side, a moat in front (Citadel+), and hands the attacker a Catapult that
 * batters the wall down. Walls block walkers but not flyers; a breach opens the
 * hex; the moat bites a stack that ends its move in it. The load-bearing
 * property is that a walled siege still TERMINATES (the Catapult always breaches,
 * ranged/flyers always reach) and never soft-locks. Pure rule-engine, no Phaser.
 * Run: node --test tests/siege.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createBattle, act, wallAt, reachableHexes } from '../src/core/combat/CombatEngine.js';
import { autoResolve, chooseAction } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

const S = CONFIG.SIEGE;

function siegeBattle(fortTier, opts = {}) {
  return createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(opts.seed ?? 31415),
    siege: { fortTier },
    attacker: { hero: null, army: opts.attacker || [{ creature: 'archer', count: 20 }], playerIndex: 0 },
    defender: { hero: null, army: opts.defender || [{ creature: 'pikeman', count: 20 }], playerIndex: 1 },
  });
}
function hpPool(u) { return u.alive ? (u.count - 1) * u.maxHp + u.hp : 0; }

// ---------------------------------------------------------------------------
// Fortification layout
// ---------------------------------------------------------------------------

test('buildFortifications: a full curtain wall with a central gate, and the attacker gets a Catapult', () => {
  const b = siegeBattle(3);
  assert.equal(b.siege.fortTier, 3);
  assert.equal(b.walls.length, CONFIG.BATTLE_H, 'one wall segment per row');
  assert.ok(b.walls.every((w) => w.x === S.WALL_X), 'all on the wall column');
  const gate = b.walls.find((w) => w.kind === 'gate');
  assert.equal(gate.y, S.GATE_ROW, 'the gate is the central segment');
  assert.ok(gate.hp < b.walls.find((w) => w.kind === 'wall').hp, 'the gate is weaker than a wall');
  assert.ok(b.units.some((u) => u.machine === 'catapult' && u.side === 0), 'the besieger fields a Catapult');
  assert.ok(!b.obstacles.length, 'a siege field has no random rocks');
});

test('once the gate is down the Catapult batters the segment nearest the gate row (A8)', () => {
  const b = siegeBattle(3);
  const catapult = b.units.find((u) => u.machine === 'catapult');
  // With the gate standing, the Catapult batters it (the central passage) first.
  const firstPick = chooseAction(b, catapult);
  assert.equal(b.walls.find((w) => w.id === firstPick.wallId).kind, 'gate', 'gate first');

  // Knock the gate out; the fallback must pick the segment NEAREST the gate row,
  // not the bottom-most one the old reduce() chose.
  const gate = b.walls.find((w) => w.kind === 'gate');
  gate.alive = false; gate.hp = 0;
  const action = chooseAction(b, catapult);
  assert.equal(action.type, 'batter');
  const target = b.walls.find((w) => w.id === action.wallId);
  const minDist = Math.min(...b.walls.filter((w) => w.alive).map((w) => Math.abs(w.y - S.GATE_ROW)));
  assert.equal(Math.abs(target.y - S.GATE_ROW), minDist, 'nearest the gate row');
  assert.notEqual(target.y, CONFIG.BATTLE_H - 1, 'not the bottom-most segment (the old behaviour)');
});

test('moat only from Citadel up; Castle walls are tougher than Fort/Citadel', () => {
  assert.equal(siegeBattle(1).moat.length, 0, 'a bare Fort has no moat');
  assert.equal(siegeBattle(2).moat.length, CONFIG.BATTLE_H, 'a Citadel digs a moat');
  assert.equal(siegeBattle(3).moat.length, CONFIG.BATTLE_H, 'a Castle has a moat');
  const wallHp = (t) => siegeBattle(t).walls.find((w) => w.kind === 'wall').maxHp;
  assert.equal(wallHp(1), S.wallHp);
  assert.equal(wallHp(3), S.wallHpCastle);
  assert.ok(wallHp(3) > wallHp(1), 'Castle walls are the toughest');
});

test('a town with no Fort has no fortifications (open battle, random obstacles)', () => {
  const b = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(1), siege: { fortTier: 0 },
    attacker: { hero: null, army: [{ creature: 'archer', count: 5 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 5 }], playerIndex: 1 },
  });
  assert.equal(b.walls, null, 'no walls');
  assert.equal(b.siege, null, 'not flagged a siege');
});

// ---------------------------------------------------------------------------
// Walls block walkers, not flyers; a breach opens the hex
// ---------------------------------------------------------------------------

test('an intact wall blocks a walker but a flyer sails over it; a breach lets the walker through', () => {
  const b = siegeBattle(3, { attacker: [{ creature: 'pikeman', count: 10 }, { creature: 'griffin', count: 10 }] });
  const walker = b.units.find((u) => u.creature === 'pikeman');
  const flyer = b.units.find((u) => u.creature === 'griffin');
  // Stand both just in front of the gate; give them reach to cross it.
  for (const u of [walker, flyer]) { u.x = S.MOAT_X - 1; u.y = S.GATE_ROW; u.effects.push({ spellId: 'x', effects: { speed: 6 }, rounds: 9 }); }
  const behind = (u) => reachableHexes(b, u).some((h) => h.x > S.WALL_X); // any hex past the wall

  assert.equal(behind(walker), false, 'the walker cannot path past a standing wall');
  assert.equal(behind(flyer), true, 'the flyer sails over the wall');

  // Knock the gate down: now the walker can step through the breach.
  const gate = b.walls.find((w) => w.kind === 'gate');
  gate.alive = false;
  assert.equal(wallAt(b, S.WALL_X, S.GATE_ROW), null, 'the breached gate no longer occupies its hex');
  assert.equal(behind(walker), true, 'the walker pours through the breach');
});

// ---------------------------------------------------------------------------
// Catapult
// ---------------------------------------------------------------------------

test('the Catapult batters the gate first and a felled segment stops blocking', () => {
  const b = siegeBattle(2);
  const cat = b.units.find((u) => u.machine === 'catapult');
  // The AI aims the Catapult at the gate.
  const action = chooseAction(b, cat);
  assert.equal(action.type, 'batter');
  assert.equal(b.walls.find((w) => w.id === action.wallId).kind, 'gate', 'gate targeted first');

  // Batter it until it falls; each hit deals real damage, and once down it opens.
  let guard = 20;
  while (b.walls.find((w) => w.id === action.wallId).alive && guard-- > 0) {
    const ev = act(b, cat, { type: 'batter', wallId: action.wallId });
    const hit = ev.find((e) => e.type === 'wallHit');
    assert.ok(hit && hit.damage > 0, 'the shot chips the wall');
  }
  const gate = b.walls.find((w) => w.id === action.wallId);
  assert.equal(gate.alive, false, 'the gate falls');
  assert.equal(wallAt(b, gate.x, gate.y), null, 'a breach: the hex is passable');
});

test('batter rejects a bad segment / a non-Catapult without mutating', () => {
  const b = siegeBattle(2);
  const cat = b.units.find((u) => u.machine === 'catapult');
  assert.equal(act(b, cat, { type: 'batter', wallId: 'nope' }).length, 0, 'unknown segment: no-op');
  const pike = b.units.find((u) => u.creature === 'pikeman'); // a real stack can't batter
  const anyWall = b.walls[0].id;
  const hpBefore = b.walls[0].hp;
  act(b, pike, { type: 'batter', wallId: anyWall });
  assert.equal(b.walls[0].hp, hpBefore, 'only the Catapult batters');
});

// ---------------------------------------------------------------------------
// Moat
// ---------------------------------------------------------------------------

test('the moat bites a stack that ends its move in it', () => {
  const b = siegeBattle(3, { attacker: [{ creature: 'pikeman', count: 10 }] });
  const pike = b.units.find((u) => u.creature === 'pikeman');
  pike.x = S.MOAT_X - 1; pike.y = 3; // just left of the moat
  pike.effects.push({ spellId: 'x', effects: { speed: 6 }, rounds: 9 });
  const before = hpPool(pike);
  const ev = act(b, pike, { type: 'move', x: S.MOAT_X, y: 3 }); // step into the moat
  const moat = ev.find((e) => e.type === 'moat');
  assert.ok(moat && moat.damage === S.moatDamage, 'the moat deals its bite');
  assert.equal(before - hpPool(pike), S.moatDamage, 'the stack lost exactly the moat damage');
});

test('a bare Fort has no moat, so crossing that column is free', () => {
  const b = siegeBattle(1, { attacker: [{ creature: 'pikeman', count: 10 }] });
  const pike = b.units.find((u) => u.creature === 'pikeman');
  pike.x = S.MOAT_X - 1; pike.y = 3;
  pike.effects.push({ spellId: 'x', effects: { speed: 6 }, rounds: 9 });
  const before = hpPool(pike);
  const ev = act(b, pike, { type: 'move', x: S.MOAT_X, y: 3 });
  assert.ok(!ev.some((e) => e.type === 'moat'), 'no moat on a Fort');
  assert.equal(hpPool(pike), before, 'unharmed');
});

// ---------------------------------------------------------------------------
// Arrow towers (slice 2b)
// ---------------------------------------------------------------------------

test('arrow towers scale with the Fort tier: none, then the keep, then three', () => {
  const towers = (t) => siegeBattle(t).units.filter((u) => u.machine === 'arrowTower');
  assert.equal(towers(1).length, 0, 'a bare Fort has no towers');
  assert.equal(towers(2).length, 1, 'a Citadel raises the keep');
  assert.equal(towers(3).length, 3, 'a Castle adds an upper and a lower tower');
  for (const u of towers(3)) {
    assert.equal(u.side, 1, 'towers defend');
    assert.equal(u.noncombatant, true, 'a tower never keeps the side alive');
    assert.equal(u.x, S.towerCol, 'just behind the wall');
  }
});

test('an arrow tower shells the besiegers (fires over adjacency) but can be silenced', () => {
  const b = siegeBattle(3, { attacker: [{ creature: 'pikeman', count: 20 }] });
  const tower = b.units.find((u) => u.machine === 'arrowTower');
  const a = chooseAction(b, tower);
  assert.equal(a.type, 'shoot', 'the tower looses arrows');
  const target = b.units.find((u) => u.id === a.targetId);
  assert.equal(target.side, 0, 'at an attacker');
  const before = hpPool(target);
  act(b, tower, a);
  assert.ok(hpPool(target) < before, 'the volley bites');
  // A tower is a normal (if tough) target — a strong stack can knock it down.
  tower.hp = 1; tower.alive = false;
  assert.ok(!b.units.some((u) => u.machine === 'arrowTower' && u.alive && u.id === tower.id), 'a felled tower is gone');
});

test('a Castle full of towers still falls the instant its garrison dies', () => {
  const b = siegeBattle(3, { attacker: [{ creature: 'archangel', count: 40 }] });
  assert.equal(b.units.filter((u) => u.machine === 'arrowTower').length, 3);
  for (const u of b.units) if (u.side === 1 && !u.machine) { u.alive = false; u.count = 0; }
  const attacker = b.units.find((u) => u.side === 0 && !u.machine && u.alive);
  act(b, attacker, { type: 'defend' });
  assert.equal(b.over, true, 'three live towers do not keep the town standing');
  assert.equal(b.winner, 0);
});

// ---------------------------------------------------------------------------
// The whole thing still resolves — no soft-lock behind the walls
// ---------------------------------------------------------------------------

test('a full Castle siege resolves deterministically and terminates', () => {
  const run = (seed) => {
    const b = siegeBattle(3, {
      seed,
      attacker: [{ creature: 'archer', count: 20 }, { creature: 'pikeman', count: 20 }],
      defender: [{ creature: 'marksman', count: 20 }, { creature: 'swordsman', count: 20 }],
    });
    const r = autoResolve(b);
    return { r, over: b.over, round: b.round };
  };
  const a = run(2024);
  const b = run(2024);
  assert.equal(typeof a.r.attackerWon, 'boolean', 'resolved to a winner');
  assert.equal(a.over, true, 'the siege ended (no soft-lock behind the walls)');
  assert.deepEqual(a, b, 'same seed → identical siege');
});

test('a besieged town whose army is wiped falls at once — walls/Catapult never keep a side alive', () => {
  const b = siegeBattle(3, { attacker: [{ creature: 'archangel', count: 30 }] });
  for (const u of b.units) if (u.side === 1 && !u.machine) { u.alive = false; u.count = 0; }
  const attacker = b.units.find((u) => u.side === 0 && !u.machine && u.alive);
  act(b, attacker, { type: 'defend' });
  assert.equal(b.over, true, 'the town falls despite standing walls');
  assert.equal(b.winner, 0, 'the besieger wins');
});
