/**
 * warMachines.test.js — Ballista / First Aid Tent / Ammo Cart in the tactical
 * engine. These are `noncombatant` units a hero brings to a fight (hero.warMachines):
 * they act, but they never win or lose a battle on their own. The critical
 * property under guard is the SOFT-LOCK one: a side whose real army is dead but
 * whose war machine still stands must be declared defeated, or finish()'s
 * end-detection would loop forever (the same class of bug the `combatant`
 * predicate exists to prevent). Pure rule-engine, no Phaser.
 * Run: node --test tests/warMachines.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { createBattle, act } from '../src/core/combat/CombatEngine.js';
import { autoResolve, chooseAction } from '../src/core/combat/CombatAI.js';
import { newGame, playerTowns, playerHeroes } from '../src/core/GameState.js';
import { buyWarMachine } from '../src/core/actions.js';
import { Rng } from '../src/core/rng.js';

const SEED = 24680;

/** Minimal plain-object hero (heroUtils-compatible) that owns war machines. */
function makeHero(warMachines = {}) {
  return {
    stats: { attack: 0, defense: 0, power: 0, knowledge: 0 },
    skills: {}, equipment: {}, army: [], spells: [], mana: 0,
    tempMorale: 0, tempLuck: 0,
    warMachines,
  };
}

function makeBattle(attackerArmy, defenderArmy, opts = {}) {
  return createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng: new Rng(opts.seed ?? SEED),
    attacker: { hero: opts.attackerHero || null, army: attackerArmy, playerIndex: 0 },
    defender: { hero: opts.defenderHero || null, army: defenderArmy, playerIndex: 1 },
  });
}

function hpPool(u) { return u.alive ? (u.count - 1) * u.maxHp + u.hp : 0; }
const ALL = { ballista: true, firstAidTent: true, ammoCart: true };

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

test('deployWarMachines: only the machines the hero owns are placed, flagged noncombatant', () => {
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'peasant', count: 10 }],
    { attackerHero: makeHero({ ballista: true, ammoCart: true }) }); // no tent
  const machines = battle.units.filter((u) => u.machine);
  assert.equal(machines.length, 2, 'only owned machines deploy');
  assert.deepEqual(machines.map((m) => m.machine).sort(), ['ammoCart', 'ballista']);
  for (const m of machines) {
    assert.equal(m.side, 0, 'attacker machines on side 0');
    assert.equal(m.noncombatant, true, 'flagged noncombatant');
    assert.equal(m.x, 0, 'on the attacker edge column');
    assert.ok(m.alive && m.count === 1);
  }
  // No machine ever lands on an army stack's hex.
  const army = battle.units.filter((u) => !u.machine);
  for (const m of machines) {
    assert.ok(!army.some((a) => a.x === m.x && a.y === m.y), 'no collision with a stack');
  }
});

// ---------------------------------------------------------------------------
// Soft-lock: the whole reason war machines are `noncombatant`
// ---------------------------------------------------------------------------

test('a side left with ONLY a war machine is defeated — finish() never soft-locks', () => {
  const battle = makeBattle(
    [{ creature: 'archangel', count: 20 }],
    [{ creature: 'peasant', count: 1 }],
    { defenderHero: makeHero(ALL) }); // defender fields all 3 machines

  // Wipe the defender's real army; only its machines remain on side 1.
  for (const u of battle.units) if (u.side === 1 && !u.machine) { u.alive = false; u.count = 0; }
  assert.ok(battle.units.some((u) => u.side === 1 && u.machine && u.alive), 'a defender machine still stands');

  // ANY action re-runs finish(); with the combatant predicate the battle must end.
  const attacker = battle.units.find((u) => u.side === 0 && u.alive);
  act(battle, attacker, { type: 'defend' });
  assert.equal(battle.over, true, 'battle ends despite a live enemy machine');
  assert.equal(battle.winner, 0, 'the side with real troops wins');
});

test('autoResolve terminates and is deterministic with machines on both sides', () => {
  const fight = (seed) => {
    const battle = makeBattle(
      [{ creature: 'pikeman', count: 20 }, { creature: 'archer', count: 20 }],
      [{ creature: 'nomad', count: 20 }, { creature: 'rogue', count: 20 }],
      { seed, attackerHero: makeHero(ALL), defenderHero: makeHero(ALL) });
    return autoResolve(battle);
  };
  const a = fight(1234);
  const b = fight(1234);
  assert.equal(typeof a.attackerWon, 'boolean', 'resolved to a winner');
  assert.deepEqual(a, b, 'same seed → identical result');
  // The hero keeps his machines: they never ride off in the surviving army.
  for (const stack of [...a.attackerArmy, ...a.defenderArmy]) {
    assert.equal(CREATURES[stack.creature].faction !== 'machine', true, 'no machine among survivors');
  }
});

// ---------------------------------------------------------------------------
// Ballista
// ---------------------------------------------------------------------------

test('Ballista shells an enemy stack for real damage, ignoring adjacency', () => {
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'peasant', count: 50 }],
    { attackerHero: makeHero({ ballista: true }) });
  const ballista = battle.units.find((u) => u.machine === 'ballista');
  const peasant = battle.units.find((u) => u.creature === 'peasant');
  // Park an enemy right next to the ballista: a normal shooter would be blocked,
  // the fixed engine fires anyway.
  peasant.x = ballista.x + 1; peasant.y = ballista.y;
  const before = hpPool(peasant);
  const ev = act(battle, ballista, { type: 'shoot', targetId: peasant.id });
  const shot = ev.find((e) => e.kind === 'ranged');
  assert.ok(shot && shot.damage > 0, 'the bolt lands for damage');
  assert.ok(hpPool(peasant) < before, 'the target stack is thinned');
});

// ---------------------------------------------------------------------------
// First Aid Tent
// ---------------------------------------------------------------------------

test('First Aid Tent mends a wounded friendly stack (never a machine, never resurrects)', () => {
  const battle = makeBattle(
    [{ creature: 'griffin', count: 10 }],
    [{ creature: 'peasant', count: 10 }],
    { attackerHero: makeHero({ firstAidTent: true }) });
  const tent = battle.units.find((u) => u.machine === 'firstAidTent');
  const griffin = battle.units.find((u) => u.creature === 'griffin');
  griffin.hp = 1; // wound the lead creature
  const before = hpPool(griffin);
  const ev = act(battle, tent, { type: 'firstAid', targetId: griffin.id });
  const heal = ev.find((e) => e.type === 'heal');
  assert.ok(heal && heal.healed > 0, 'the tent restores HP');
  assert.equal(heal.revived, 0, 'a tent heals wounds, it does not raise the dead');
  assert.equal(hpPool(griffin) - before, heal.healed, 'HP pool grows by exactly the heal');
  assert.ok(hpPool(griffin) <= griffin.startCount * griffin.maxHp, 'never over-heals');
});

// ---------------------------------------------------------------------------
// Ammo Cart
// ---------------------------------------------------------------------------

test('Ammo Cart gives the side unlimited shots; without one, shots deplete', () => {
  const shootOnce = (withCart) => {
    const battle = makeBattle(
      [{ creature: 'archer', count: 10 }],
      [{ creature: 'peasant', count: 999 }],
      { attackerHero: makeHero(withCart ? { ammoCart: true } : {}) });
    const archer = battle.units.find((u) => u.creature === 'archer');
    act(battle, archer, { type: 'shoot', targetId: battle.units.find((u) => u.side === 1).id });
    return archer.shots;
  };
  assert.equal(shootOnce(true), CREATURES.archer.shots, 'with an Ammo Cart the shooter keeps every shot');
  assert.equal(shootOnce(false), CREATURES.archer.shots - 1, 'without one it spends a shot');
});

test('Ammo Cart covers the Marksman SECOND bolt, not just the first (A2)', () => {
  const bolts = (battle, shooter, foeId) =>
    act(battle, shooter, { type: 'shoot', targetId: foeId }).filter((e) => e.kind === 'ranged').length;
  const setup = (hero) => {
    const battle = makeBattle(
      [{ creature: 'marksman', count: 10 }],
      [{ creature: 'peasant', count: 9999 }],
      { attackerHero: hero });
    return { battle, marksman: battle.units.find((u) => u.creature === 'marksman'),
      foeId: battle.units.find((u) => u.side === 1).id };
  };

  // The bug: with a cart but the base ammo spent, the double shot used to vanish
  // (its guard read `unit.shots > 0`). The cart must still supply BOTH bolts.
  {
    const { battle, marksman, foeId } = setup(makeHero({ ammoCart: true }));
    marksman.shots = 0; // base ammo exhausted — the cart is the only supply
    assert.equal(bolts(battle, marksman, foeId), 2, 'cart supplies both bolts at 0 base ammo');
    assert.equal(marksman.shots, 0, 'the cart never spends ammo');
  }

  // With a cart at full ammo: both bolts fire and no shot is ever spent.
  {
    const { battle, marksman, foeId } = setup(makeHero({ ammoCart: true }));
    assert.equal(bolts(battle, marksman, foeId), 2, 'both bolts fire');
    assert.equal(marksman.shots, CREATURES.marksman.shots, 'cart preserves every shot');
  }

  // Without a cart the double shot spends two ammo; a lone last shot fires once.
  {
    const { battle, marksman, foeId } = setup(makeHero());
    marksman.shots = 3;
    assert.equal(bolts(battle, marksman, foeId), 2, 'a normal double shot spends two ammo');
    assert.equal(marksman.shots, 1);
    assert.equal(bolts(battle, marksman, foeId), 1, 'with one ammo only the first bolt fires');
    assert.equal(marksman.shots, 0);
  }
});

// ---------------------------------------------------------------------------
// The AI drives immobile machines without stalling the queue
// ---------------------------------------------------------------------------

test('chooseAction always returns a queue-advancing action for each machine', () => {
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'peasant', count: 10 }],
    { attackerHero: makeHero(ALL) });
  // Wound the pikeman so the tent has a real target.
  const pike = battle.units.find((u) => u.creature === 'pikeman');
  pike.hp = 1;
  const kinds = {};
  for (const m of battle.units.filter((u) => u.machine)) {
    kinds[m.machine] = chooseAction(battle, m).type;
  }
  assert.equal(kinds.ballista, 'shoot', 'the ballista fires');
  assert.equal(kinds.firstAidTent, 'firstAid', 'the tent mends the wounded pikeman');
  assert.equal(kinds.ammoCart, 'defend', 'the cart digs in');

  // With no wounded ally the tent falls back to defend (still advances the queue).
  pike.hp = pike.maxHp;
  assert.equal(chooseAction(battle, battle.units.find((u) => u.machine === 'firstAidTent')).type, 'defend');
});

test('First Aid Tent targets the WOUNDED top creature, not a depleted-but-full stack (A3)', () => {
  const battle = makeBattle(
    [{ creature: 'griffin', count: 10 }, { creature: 'pikeman', count: 10 }],
    [{ creature: 'peasant', count: 10 }],
    { attackerHero: makeHero({ firstAidTent: true }) });
  const tent = battle.units.find((u) => u.machine === 'firstAidTent');
  const griffin = battle.units.find((u) => u.creature === 'griffin');
  const pike = battle.units.find((u) => u.creature === 'pikeman');

  // Griffin: many creatures dead but its top creature is at FULL hp — a huge
  // whole-pool deficit the tent can heal for exactly 0 (it never resurrects).
  griffin.count = 3; griffin.hp = griffin.maxHp;
  // Pikeman: full count, a genuinely wounded top creature — the real, mendable wound.
  pike.hp = 1;

  const action = chooseAction(battle, tent);
  assert.equal(action.type, 'firstAid');
  assert.equal(action.targetId, pike.id, 'mends the wounded top creature, not the depleted-but-full stack');
  const ev = act(battle, tent, action);
  const heal = ev.find((e) => e.type === 'heal');
  assert.ok(heal && heal.healed > 0, 'the mend lands for real HP, not the old 0-heal');
});

test('First Aid Tent digs in rather than waste a 0-heal on a merely depleted stack (A3)', () => {
  const battle = makeBattle(
    [{ creature: 'griffin', count: 10 }],
    [{ creature: 'peasant', count: 10 }],
    { attackerHero: makeHero({ firstAidTent: true }) });
  const tent = battle.units.find((u) => u.machine === 'firstAidTent');
  const griffin = battle.units.find((u) => u.creature === 'griffin');
  griffin.count = 2; griffin.hp = griffin.maxHp; // depleted, but the top creature is full
  assert.equal(chooseAction(battle, tent).type, 'defend', 'no wasted 0-heal — the tent defends');
});

// ---------------------------------------------------------------------------
// Acquisition: the Blacksmith sells one of each to the visiting hero
// ---------------------------------------------------------------------------

test('buyWarMachine: Blacksmith sells to a visiting hero, once each, priced from config', () => {
  const s = newGame({ seed: 99, players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }] });
  const town = playerTowns(s, 0)[0];
  const hero = playerHeroes(s, 0)[0];
  town.visitingHeroId = hero.id;
  if (!town.buildings.includes('blacksmith')) town.buildings.push('blacksmith');
  const player = s.players[0];
  player.resources.gold = 100000;

  // Fresh heroes own no machines.
  assert.deepEqual(hero.warMachines, {});

  const goldBefore = player.resources.gold;
  const r = buyWarMachine(s, town, 'ballista');
  assert.equal(r.ok, true, 'purchase succeeds');
  assert.equal(hero.warMachines.ballista, true, 'the hero now owns a ballista');
  assert.equal(goldBefore - player.resources.gold, CONFIG.WAR_MACHINES.ballista.cost.gold, 'charged the config price');

  // Can't buy the same machine twice.
  assert.equal(buyWarMachine(s, town, 'ballista').ok, false, 'no duplicate ballista');

  // No blacksmith → no sale.
  town.buildings = town.buildings.filter((b) => b !== 'blacksmith');
  assert.equal(buyWarMachine(s, town, 'ammoCart').reason, 'no blacksmith');
  town.buildings.push('blacksmith');

  // No visiting hero → nobody to hand it to.
  town.visitingHeroId = null;
  assert.equal(buyWarMachine(s, town, 'ammoCart').reason, 'no hero');
  town.visitingHeroId = hero.id;

  // Too poor → no sale, no charge.
  player.resources.gold = 0;
  assert.equal(buyWarMachine(s, town, 'ammoCart').reason, 'cost');
  assert.equal(hero.warMachines.ammoCart, undefined, 'nothing granted when it fails');

  // A machine the hero bought really deploys in his next battle.
  const battle = createBattle({
    rng: new Rng(7), attacker: { hero, army: [{ creature: 'pikeman', count: 5 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'peasant', count: 5 }], playerIndex: 1 },
  });
  assert.ok(battle.units.some((u) => u.machine === 'ballista' && u.side === 0), 'the bought ballista is on the field');
});

test('FIRST_AID_HEAL is a sane positive constant and every machine creature exists', () => {
  assert.ok(Number.isFinite(CONFIG.FIRST_AID_HEAL) && CONFIG.FIRST_AID_HEAL > 0);
  for (const id of Object.keys(CONFIG.WAR_MACHINES)) {
    assert.ok(CREATURES[id], `${id} is a defined creature`);
    assert.equal(CREATURES[id].faction, 'machine', `${id} is faction 'machine'`);
    assert.equal(CREATURES[id].aiValue, 0, `${id} has aiValue 0 (mapgen guards skip it)`);
  }
});
