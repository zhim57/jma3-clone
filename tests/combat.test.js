/**
 * combat.test.js — Fixed-seed regression suite for the tactical battle engine.
 *
 * Each mechanic gets its own test. Randomness flows from a seeded Rng (see
 * src/core/rng.js), so a fixed seed makes every run reproducible. Where a test
 * hinges on a probabilistic branch (morale, luck), the seeded rng's `chance`
 * hook is pinned so the branch is forced deterministically — the stream is
 * still the game's real seeded stream, only the single roll under test is
 * decided. Pure rule-engine, no Phaser. Run with: node --test tests/combat.test.js
 *
 * All expected numbers are read from the same data the engine reads (config /
 * creatures / spells), so the assertions track any future retune.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { SPELLS } from '../src/data/spells.js';
import {
  createBattle, act, castSpell, beginTurn,
  reachableHexes, hexNeighbors, unitSpeed, effectDelta, hasFlag,
} from '../src/core/combat/CombatEngine.js';
import { Rng } from '../src/core/rng.js';

const SEED = 12345;

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** Minimal plain-object hero that satisfies heroUtils + castSpell. */
function makeHero(opts = {}) {
  return {
    stats: { attack: 0, defense: 0, power: opts.power ?? 0, knowledge: 0 },
    skills: opts.skills || {},
    equipment: {},
    army: [],
    spells: opts.spells || [],
    mana: opts.mana ?? 0,
    tempMorale: 0, tempLuck: 0,
  };
}

function makeBattle(attackerArmy, defenderArmy, opts = {}) {
  const rng = new Rng(opts.seed ?? SEED);
  return createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng,
    attacker: { hero: opts.attackerHero || null, army: attackerArmy, playerIndex: 0 },
    defender: { hero: opts.defenderHero || null, army: defenderArmy, playerIndex: 1 },
  });
}

function place(u, x, y) { u.x = x; u.y = y; }

/** Roll the battle forward to a target round by having everyone defend (no rng). */
function advanceToRound(battle, target) {
  let guard = 0;
  while (battle.round < target && !battle.over && guard++ < 2000) {
    const { unit: u } = beginTurn(battle);
    if (!u) break;
    act(battle, u, { type: 'defend' });
  }
}

// ---------------------------------------------------------------------------
// Spell durations
// ---------------------------------------------------------------------------

test('spells: buff/debuff durations tick down and expire', () => {
  const hero = makeHero({ spells: ['haste', 'slow'], mana: 999, power: 0 });
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'nomad', count: 10 }],
    { attackerHero: hero });
  const pike = battle.units.find((u) => u.side === 0);
  const nomad = battle.units.find((u) => u.side === 1);
  const pikeBase = unitSpeed(battle, pike);
  const nomadBase = unitSpeed(battle, nomad);

  // Haste (buff) on our stack, Slow (debuff) on the enemy. Only one cast per
  // round per side, so drop the round guard between casts (test convenience).
  castSpell(battle, 0, 'haste', { unitId: pike.id });
  battle.sides[0].castThisRound = false;
  castSpell(battle, 0, 'slow', { unitId: nomad.id });

  assert.equal(effectDelta(pike, 'speed'), 3);
  assert.equal(unitSpeed(battle, pike), pikeBase + 3);
  assert.equal(unitSpeed(battle, nomad), Math.max(1, nomadBase - 3));

  // duration + power(0) rounds counting the cast round; still up on its last
  // round, gone the round after.
  const dur = SPELLS.haste.duration;
  advanceToRound(battle, dur);
  assert.ok(pike.effects.some((e) => e.spellId === 'haste'), 'still active on its last round');
  advanceToRound(battle, dur + 1);
  assert.equal(pike.effects.length, 0, 'haste expired');
  assert.equal(nomad.effects.length, 0, 'slow expired');
  assert.equal(unitSpeed(battle, pike), pikeBase);
  assert.equal(unitSpeed(battle, nomad), nomadBase);
});

test('spells: high Power extends duration only within a bounded cap', () => {
  // A power-15 hero used to Blind for duration+power = 18 rounds (whole battle).
  // Power now adds min(3, floor(power/3)) rounds, so Blind (base 3) tops out at 6.
  const hero = makeHero({ spells: ['blind'], mana: 999, power: 15 });
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'nomad', count: 10 }],
    { attackerHero: hero });
  const nomad = battle.units.find((u) => u.side === 1);
  castSpell(battle, 0, 'blind', { unitId: nomad.id });
  const eff = nomad.effects.find((e) => e.spellId === 'blind');
  const cap = SPELLS.blind.duration + Math.min(CONFIG.SPELL_DURATION_POWER_CAP,
    Math.floor(hero.stats.power / CONFIG.SPELL_DURATION_POWER_DIV));
  assert.equal(eff.rounds, cap, 'duration is bounded, not duration+power');
  assert.ok(eff.rounds <= SPELLS.blind.duration + CONFIG.SPELL_DURATION_POWER_CAP,
    'never exceeds base + the power cap');
});

// ---------------------------------------------------------------------------
// Morale
// ---------------------------------------------------------------------------

test('morale: positive morale grants an extra action this round', () => {
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'peasant', count: 10 }],
    { seed: 101 });
  battle.obstacles = [];
  const u = battle.units.find((x) => x.id === battle.queue[battle.queueIndex]);
  battle.sides[u.side].morale = 3;
  battle.rng.chance = () => true; // force the morale roll
  const dest = reachableHexes(battle, u)[0];
  const events = act(battle, u, { type: 'move', x: dest.x, y: dest.y });
  assert.ok(events.some((e) => e.type === 'morale'), 'morale event emitted');
  assert.equal(battle.queue[battle.queueIndex], u.id, 're-queued to act again immediately');
  assert.equal(u.moraleUsed, true, 'only one morale event per unit per round');
});

test('morale: negative morale can freeze a unit for the round', () => {
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'peasant', count: 10 }],
    { seed: 202 });
  const frozen = battle.units.find((u) => u.side === 1);
  const other = battle.units.find((u) => u.side === 0);
  battle.sides[1].morale = -3;
  battle.queue = [frozen.id, other.id];
  battle.queueIndex = 0;
  battle.rng.chance = () => true; // force the bad-morale roll
  const { unit: acting, events } = beginTurn(battle);
  assert.ok(events.some((e) => e.type === 'badMorale' && e.unitId === frozen.id));
  assert.equal(frozen.moraleUsed, true);
  assert.equal(acting.id, other.id, 'turn passes to the next unit');
});

// ---------------------------------------------------------------------------
// Luck
// ---------------------------------------------------------------------------

test('luck: a lucky strike doubles damage', () => {
  const run = (lucky) => {
    const battle = makeBattle(
      [{ creature: 'angel', count: 20 }],
      [{ creature: 'peasant', count: 999 }],
      { seed: 303 });
    battle.obstacles = [];
    const angel = battle.units.find((u) => u.side === 0);
    const peasant = battle.units.find((u) => u.side === 1);
    place(peasant, 7, 5);
    const [nx, ny] = hexNeighbors(7, 5)[0];
    place(angel, nx, ny);
    // Bless pins per-creature damage to its max, so the luck roll is the only
    // rng draw in the strike and the expected number is exact.
    angel.effects.push({ spellId: 'bless', effects: { blessed: 1 }, rounds: 9 });
    battle.sides[0].luck = 3;
    battle.rng.chance = () => lucky; // force the luck roll one way
    const events = act(battle, angel, { type: 'attack', targetId: peasant.id });
    return events.find((e) => e.type === 'attack' && e.kind === 'melee');
  };

  // Bless forces max per-creature damage and the luck roll is forced, so the
  // strike is fully deterministic — PIN the exact number rather than re-deriving
  // the engine's own formula here (a re-derivation silently tracks a formula
  // change and masks the very bug this should catch). Golden value:
  //   angel ×20, dmg 50, attack 20 vs peasant defense 1
  //   → 50 × 20 × (1 + min(cap 3.0, 19 × 0.05)) = 50 × 20 × 1.95 = 1950.
  const base = 1950;

  const plain = run(false);
  assert.equal(plain.luck, 0);
  assert.equal(plain.damage, base);

  const lucky = run(true);
  assert.equal(lucky.luck, 1);
  assert.equal(lucky.damage, base * 2, 'lucky strike doubles the damage');
});

// ---------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------

test('wait re-queues the unit later in the round', () => {
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }, { creature: 'archer', count: 10 }],
    [{ creature: 'imp', count: 10 }],
    { seed: 404 });
  const idx = battle.queueIndex;
  const waiter = battle.units.find((u) => u.id === battle.queue[idx]);
  const events = act(battle, waiter, { type: 'wait' });
  assert.ok(events.some((e) => e.type === 'wait'));
  assert.equal(waiter.hasWaitedFlag, true);
  assert.notEqual(battle.queue[idx], waiter.id, 'no longer at the front');
  assert.ok(battle.queue.indexOf(waiter.id) > idx, 'moved later in the queue');
});

// ---------------------------------------------------------------------------
// Spell targeting
// ---------------------------------------------------------------------------

test('spell targeting: fireball area, chain lightning, armageddon hitsAll', () => {
  // --- Area (fireball): the target hex and every adjacent stack ---
  {
    const hero = makeHero({ spells: ['fireball'], mana: 999, power: 3 });
    const battle = makeBattle(
      [{ creature: 'pikeman', count: 10 }],
      [{ creature: 'peasant', count: 10 }, { creature: 'rogue', count: 10 }, { creature: 'nomad', count: 10 }],
      { attackerHero: hero });
    const pike = battle.units.find((u) => u.creature === 'pikeman');
    const peasant = battle.units.find((u) => u.creature === 'peasant');
    const rogue = battle.units.find((u) => u.creature === 'rogue');
    const nomad = battle.units.find((u) => u.creature === 'nomad');
    place(pike, 1, 1);      // far from the blast
    place(peasant, 7, 5);   // target
    place(rogue, 8, 5);     // adjacent to (7,5)
    place(nomad, 6, 5);     // adjacent to (7,5)
    const ev = castSpell(battle, 0, 'fireball', { unitId: peasant.id });
    const hit = ev.filter((e) => e.type === 'spellHit').map((e) => e.targetId).sort();
    assert.deepEqual(hit, [peasant.id, rogue.id, nomad.id].sort(), 'target + both neighbors burn');
  }

  // --- Chain (chain lightning): target then 3 nearest leaps, halving each hop ---
  {
    const hero = makeHero({ spells: ['chainLightning'], mana: 999, power: 3 });
    const battle = makeBattle(
      [{ creature: 'pikeman', count: 10 }],
      [{ creature: 'peasant', count: 10 }, { creature: 'rogue', count: 10 },
        { creature: 'nomad', count: 10 }, { creature: 'goldGolem', count: 10 }],
      { attackerHero: hero });
    const pike = battle.units.find((u) => u.creature === 'pikeman');
    const peasant = battle.units.find((u) => u.creature === 'peasant');
    const rogue = battle.units.find((u) => u.creature === 'rogue');
    const nomad = battle.units.find((u) => u.creature === 'nomad');
    const golem = battle.units.find((u) => u.creature === 'goldGolem');
    place(pike, 0, 0);      // beyond the chain's reach
    place(peasant, 5, 5);
    place(rogue, 6, 5);
    place(nomad, 7, 5);
    place(golem, 8, 5);
    const ev = castSpell(battle, 0, 'chainLightning', { unitId: peasant.id });
    const hits = ev.filter((e) => e.type === 'spellHit');
    assert.equal(hits.length, SPELLS.chainLightning.chain + 1, 'target + 3 leaps');
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i].damage < hits[i - 1].damage, 'each leap deals less');
    }
    assert.ok(!hits.some((h) => h.targetId === pike.id), 'the far stack is never reached');
  }

  // --- hitsAll (armageddon): every stack on the field ---
  {
    const hero = makeHero({ spells: ['armageddon'], mana: 999, power: 3 });
    const battle = makeBattle(
      [{ creature: 'pikeman', count: 10 }],
      [{ creature: 'peasant', count: 10 }, { creature: 'rogue', count: 10 }],
      { attackerHero: hero });
    const aliveIds = battle.units.filter((u) => u.alive).map((u) => u.id).sort();
    const ev = castSpell(battle, 0, 'armageddon', {});
    const hit = ev.filter((e) => e.type === 'spellHit').map((e) => e.targetId).sort();
    assert.deepEqual(hit, aliveIds, 'every stack on the field is hit, friend and foe');
  }
});

// ---------------------------------------------------------------------------
// Heal & resurrect
// ---------------------------------------------------------------------------

test('heal & resurrect: archangel restores a stack without granting negative XP', () => {
  const hero = makeHero({ spells: ['cure', 'resurrection'], mana: 999, power: 3 });
  const battle = makeBattle(
    [{ creature: 'archangel', count: 1 }, { creature: 'pikeman', count: 5 }],
    [{ creature: 'peasant', count: 10 }],
    { attackerHero: hero });
  const arch = battle.units.find((u) => u.creature === 'archangel');
  const pike = battle.units.find((u) => u.creature === 'pikeman');

  // The stack has lost 3 of its 5 pikemen; a small, already-credited casualty
  // tally lets us prove resurrect never drives hpLost (the XP source) below 0.
  pike.count = 2;
  pike.hp = pike.maxHp;
  battle.hpLost[0] = 10;
  const rev = act(battle, arch, { type: 'resurrect', targetId: pike.id });
  const heal = rev.find((e) => e.type === 'heal');
  assert.equal(heal.revived, 3, 'all three pikemen return');
  assert.equal(pike.count, 5, 'stack restored to full');
  assert.ok(pike.alive);
  assert.equal(battle.hpLost[0], 0, 'casualty tally clamps at zero, never negative');

  // Cure tops up a wounded (but living) stack's lead creature; it cannot revive.
  battle.sides[0].castThisRound = false;
  pike.count = 5;
  pike.hp = 3;
  castSpell(battle, 0, 'cure', { unitId: pike.id });
  assert.equal(pike.hp, pike.maxHp, 'wounds mended, no over-heal');

  // Resurrection raises a slain stack outright.
  battle.sides[0].castThisRound = false;
  pike.count = 0;
  pike.hp = 0;
  pike.alive = false;
  const ev = castSpell(battle, 0, 'resurrection', { unitId: pike.id });
  const rez = ev.find((e) => e.type === 'heal');
  assert.ok(rez.revived >= 5, 'the fallen stack is raised');
  assert.ok(pike.alive);
  assert.equal(pike.count, 5);
});

test('heal: Sorcery boosts damage only, never healing', () => {
  // Expert Sorcery (+15% spell DAMAGE) must not amplify a heal — Cure restores
  // the Power-scaled base amount and nothing more.
  const hero = makeHero({ spells: ['cure'], mana: 999, power: 4, skills: { sorcery: 3 } });
  const battle = makeBattle(
    [{ creature: 'swordsman', count: 5 }],
    [{ creature: 'pikeman', count: 1 }],
    { attackerHero: hero });
  const sword = battle.units.find((u) => u.side === 0);
  sword.hp = 1; // wound the lead creature so the heal has clear room to work
  const healAmount = SPELLS.cure.base + SPELLS.cure.perPower * hero.stats.power; // 10 + 5*4 = 30
  castSpell(battle, 0, 'cure', { unitId: sword.id });
  assert.equal(sword.hp, 1 + healAmount, 'heal scales with Power alone (Sorcery excluded)');
});

// ---------------------------------------------------------------------------
// Creature abilities
// ---------------------------------------------------------------------------

test('fireShield: melee attackers are burned in return', () => {
  const battle = makeBattle(
    [{ creature: 'angel', count: 1 }],
    [{ creature: 'efreetSultan', count: 1 }],
    { seed: 707 });
  battle.obstacles = [];
  const angel = battle.units.find((u) => u.side === 0);
  const efreet = battle.units.find((u) => u.side === 1);
  place(efreet, 7, 4);
  const [nx, ny] = hexNeighbors(7, 4)[0];
  place(angel, nx, ny);
  const ev = act(battle, angel, { type: 'attack', targetId: efreet.id });
  const atk = ev.find((e) => e.type === 'attack' && e.kind === 'melee');
  const fire = ev.find((e) => e.type === 'fireShield');
  assert.ok(fire, 'fire shield reflected onto the attacker');
  assert.equal(fire.attackerId, efreet.id);
  assert.equal(fire.targetId, angel.id);
  assert.equal(fire.damage, Math.max(1, Math.round(atk.damage * 0.2)));
});

test('areaBlast: ranged splash hits stacks adjacent to the target', () => {
  const battle = makeBattle(
    [{ creature: 'magog', count: 5 }],
    [{ creature: 'peasant', count: 50 }, { creature: 'rogue', count: 10 }, { creature: 'nomad', count: 10 }],
    { seed: 505 });
  const magog = battle.units.find((u) => u.creature === 'magog');
  const peasant = battle.units.find((u) => u.creature === 'peasant');
  const rogue = battle.units.find((u) => u.creature === 'rogue');
  const nomad = battle.units.find((u) => u.creature === 'nomad');
  place(magog, 2, 5);     // isolated, so it may shoot
  place(peasant, 11, 5);  // target
  place(rogue, 12, 5);    // adjacent to (11,5)
  place(nomad, 10, 5);    // adjacent to (11,5)
  const ev = act(battle, magog, { type: 'shoot', targetId: peasant.id });
  const splash = ev.filter((e) => e.type === 'splash').map((e) => e.targetId).sort();
  assert.deepEqual(splash, [rogue.id, nomad.id].sort(), 'both neighbors splashed');
  assert.equal(magog.shots, CREATURES.magog.shots - 1, 'one shot spent');
});

test('shootsTwice: a marksman looses two bolts per ranged attack', () => {
  const battle = makeBattle(
    [{ creature: 'marksman', count: 10 }],
    [{ creature: 'peasant', count: 999 }],
    { seed: 606 });
  const marks = battle.units.find((u) => u.side === 0);
  const peasant = battle.units.find((u) => u.side === 1);
  place(marks, 0, 5);
  place(peasant, 14, 5);
  const ev = act(battle, marks, { type: 'shoot', targetId: peasant.id });
  const shots = ev.filter((e) => e.type === 'attack' && e.kind === 'ranged');
  assert.equal(shots.length, 2, 'two bolts fired');
  assert.equal(marks.shots, CREATURES.marksman.shots - 2, 'two shots spent');
});

test('blind: a blinded unit loses its turn', () => {
  const hero = makeHero({ spells: ['blind'], mana: 999, power: 3 });
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'peasant', count: 10 }],
    { attackerHero: hero });
  const pike = battle.units.find((u) => u.side === 0);
  const peasant = battle.units.find((u) => u.side === 1);
  castSpell(battle, 0, 'blind', { unitId: peasant.id });
  assert.ok(hasFlag(peasant, 'blinded'), 'blind applied');
  // Put the blinded stack at the front of the queue and step the turn engine.
  battle.queue = [peasant.id, pike.id];
  battle.queueIndex = 0;
  const { unit: acting, events } = beginTurn(battle);
  assert.ok(events.some((e) => e.type === 'skip' && e.reason === 'blinded' && e.unitId === peasant.id));
  assert.equal(acting.id, pike.id, 'the turn skips to the next unit');
});
