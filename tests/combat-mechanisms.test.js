/**
 * combat-mechanisms.test.js — the HoMM3-defining battle mechanics that the
 * existing combat.test.js didn't reach (2026-07 repo review, backlog F52).
 *
 * Covers: noEnemyRetaliation, unlimitedRetaliation, doubleAttack, noMeleePenalty,
 * regenerate, the curse spell (min-damage pin), per-stack morale/luck spells,
 * creature-aura fade-on-death (moraleAura / curseAura), and effect assertions for
 * the damage / buff / debuff combat spells that previously had none.
 *
 * (manaThief has its own file — manathief-cap.test.js; attacksAround, shootsTwice,
 * areaBlast and fireShield are in combat.test.js — so they're not repeated here.)
 *
 * Same discipline as combat.test.js: seeded Rng, and where a probabilistic branch
 * is under test its `chance`/`int` hook is pinned so the single roll is decided
 * while the stream stays the game's real seeded stream. Expected numbers are read
 * from the same data the engine reads, or compared engine-output-to-engine-output
 * so a formula retune never silently passes. Pure rule-engine, no Phaser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { SPELLS } from '../src/data/spells.js';
import {
  createBattle, act, castSpell, beginTurn,
  hexNeighbors, effectDelta, hasFlag, ability,
} from '../src/core/combat/CombatEngine.js';
import { Rng } from '../src/core/rng.js';

const SEED = 900;

function makeHero(opts = {}) {
  return {
    stats: { attack: 0, defense: 0, power: opts.power ?? 0, knowledge: 0 },
    skills: opts.skills || {}, equipment: {}, army: [],
    spells: opts.spells || [], mana: opts.mana ?? 0, tempMorale: 0, tempLuck: 0,
  };
}

function makeBattle(attackerArmy, defenderArmy, opts = {}) {
  const battle = createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng: new Rng(opts.seed ?? SEED),
    attacker: { hero: opts.attackerHero || null, army: attackerArmy, playerIndex: 0 },
    defender: { hero: opts.defenderHero || null, army: defenderArmy, playerIndex: 1 },
  });
  battle.obstacles = []; // an empty field: any two hexes are freely reachable
  return battle;
}

const place = (u, x, y) => { u.x = x; u.y = y; };

/** Stand `attacker` next to `target` and return the resulting event list. */
function adjacentAttack(battle, attacker, target, tx = 7, ty = 5) {
  place(target, tx, ty);
  const [nx, ny] = hexNeighbors(tx, ty)[0];
  place(attacker, nx, ny);
  return act(battle, attacker, { type: 'attack', targetId: target.id });
}

function advanceToRound(battle, target) {
  let guard = 0;
  while (battle.round < target && !battle.over && guard++ < 2000) {
    const { unit: u } = beginTurn(battle);
    if (!u) break;
    act(battle, u, { type: 'defend' });
  }
}

// ---------------------------------------------------------------------------
// Retaliation & multi-strike
// ---------------------------------------------------------------------------

test('noEnemyRetaliation: a Devil strikes without reprisal; a Swordsman draws one', () => {
  const drewRetaliation = (attackerCreature) => {
    const battle = makeBattle([{ creature: attackerCreature, count: 5 }], [{ creature: 'pikeman', count: 30 }]);
    const atk = battle.units.find((u) => u.side === 0);
    const pike = battle.units.find((u) => u.side === 1);
    const ev = adjacentAttack(battle, atk, pike);
    assert.ok(pike.alive, 'the target survives to be able to retaliate');
    return ev.some((e) => e.type === 'retaliate' && e.attackerId === pike.id);
  };
  assert.equal(drewRetaliation('swordsman'), true, 'an ordinary attacker eats a retaliation');
  assert.equal(drewRetaliation('devil'), false, 'the Devil suffers none (noEnemyRetaliation)');
});

test('unlimitedRetaliation: a Royal Griffin answers every attacker; a Pikeman only the first', () => {
  const answers = (defenderCreature) => {
    const battle = makeBattle(
      [{ creature: 'pikeman', count: 5 }, { creature: 'swordsman', count: 5 }],
      [{ creature: defenderCreature, count: 40 }]);
    const a = battle.units.find((u) => u.creature === 'pikeman');
    const b = battle.units.find((u) => u.creature === 'swordsman');
    const def = battle.units.find((u) => u.side === 1);
    place(def, 7, 5);
    const ns = hexNeighbors(7, 5);
    place(a, ns[0][0], ns[0][1]);
    place(b, ns[1][0], ns[1][1]);
    const ev1 = act(battle, a, { type: 'attack', targetId: def.id });
    const ev2 = act(battle, b, { type: 'attack', targetId: def.id });
    assert.ok(def.alive, 'the defender survives both attacks');
    return [
      ev1.some((e) => e.type === 'retaliate' && e.attackerId === def.id),
      ev2.some((e) => e.type === 'retaliate' && e.attackerId === def.id),
    ];
  };
  assert.deepEqual(answers('royalGriffin'), [true, true], 'the Griffin retaliates against both attackers');
  assert.deepEqual(answers('pikeman'), [true, false], 'an ordinary stack retaliates only once per round');
});

test('doubleAttack: a Crusader lands two blows in one strike; a Swordsman one', () => {
  const blows = (attackerCreature) => {
    const battle = makeBattle([{ creature: attackerCreature, count: 5 }], [{ creature: 'pikeman', count: 99 }]);
    const atk = battle.units.find((u) => u.side === 0);
    const pike = battle.units.find((u) => u.side === 1);
    const ev = adjacentAttack(battle, atk, pike);
    assert.ok(pike.alive, 'the target survives the first blow so a second is possible');
    return ev.filter((e) => e.type === 'attack' && e.kind === 'melee' && e.attackerId === atk.id).length;
  };
  assert.equal(blows('crusader'), 2, 'the Crusader strikes twice (doubleAttack)');
  assert.equal(blows('swordsman'), 1, 'an ordinary attacker strikes once');
});

test('noMeleePenalty: a Mage hits as hard in melee as at range; an Archer is halved', () => {
  // Bless pins per-creature damage to its max, so a strike is deterministic (no
  // luck at side-luck 0). Compare a creature's melee blow to its own ranged shot.
  const shot = (creature, kind) => {
    const battle = makeBattle([{ creature, count: 100 }], [{ creature: 'pikeman', count: 999 }]);
    const atk = battle.units.find((u) => u.side === 0);
    const tgt = battle.units.find((u) => u.side === 1);
    atk.effects.push({ spellId: 'bless', effects: { blessed: 1 }, rounds: 9 });
    if (kind === 'ranged') {
      place(atk, 2, 5); place(tgt, 8, 5); // 6 hexes apart: in range, no adjacency
      const ev = act(battle, atk, { type: 'shoot', targetId: tgt.id });
      return ev.find((e) => e.type === 'attack' && e.kind === 'ranged').damage;
    }
    const ev = adjacentAttack(battle, atk, tgt);
    return ev.find((e) => e.type === 'attack' && e.kind === 'melee').damage;
  };
  const mageMelee = shot('mage', 'melee'), mageRanged = shot('mage', 'ranged');
  assert.equal(mageMelee, mageRanged, 'the Mage takes no melee penalty (noMeleePenalty)');

  const archerMelee = shot('archer', 'melee'), archerRanged = shot('archer', 'ranged');
  assert.ok(archerMelee < archerRanged, 'the Archer is penalised in melee');
  assert.ok(Math.abs(archerMelee * 2 - archerRanged) <= 1, 'the melee penalty is one-half');
});

// ---------------------------------------------------------------------------
// Regeneration
// ---------------------------------------------------------------------------

test('regenerate: a Troll knits its lead creature whole each round; a Pikeman stays wounded', () => {
  const battle = makeBattle(
    [{ creature: 'troll', count: 5 }, { creature: 'pikeman', count: 5 }],
    [{ creature: 'peasant', count: 10 }]);
  const troll = battle.units.find((u) => u.creature === 'troll');
  const pike = battle.units.find((u) => u.creature === 'pikeman');
  assert.ok(ability(troll, 'regenerate') && !ability(pike, 'regenerate'));
  troll.hp = 1; troll.count = 3; // wounded lead creature and thinned ranks
  pike.hp = 1;
  advanceToRound(battle, 2);      // startRound(2) runs regeneration
  assert.equal(troll.hp, troll.maxHp, 'the Troll lead creature is mended to full');
  assert.equal(troll.count, 3, 'regeneration restores health, never the dead');
  assert.equal(pike.hp, 1, 'a non-regenerating stack stays wounded');
});

// ---------------------------------------------------------------------------
// Creature auras fade when their source dies
// ---------------------------------------------------------------------------

test('aura fade: a Devil curses the enemy side’s luck until it is slain (curseAura)', () => {
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 50 }],
    [{ creature: 'devil', count: 5 }, { creature: 'peasant', count: 50 }]);
  const pike = battle.units.find((u) => u.creature === 'pikeman');
  const peasant = battle.units.find((u) => u.creature === 'peasant');
  const devil = battle.units.find((u) => u.creature === 'devil');
  battle.rng.chance = () => true; // force the (bad) luck roll to actually fire

  const ev1 = adjacentAttack(battle, pike, peasant);
  assert.equal(ev1.find((e) => e.type === 'attack' && e.kind === 'melee').luck, -1,
    'the live Devil drags our luck to −1');

  devil.alive = false; devil.count = 0;                 // slay the aura's source
  peasant.hp = peasant.maxHp; peasant.count = 50; peasant.alive = true; // fresh target
  const ev2 = adjacentAttack(battle, pike, peasant);
  assert.equal(ev2.find((e) => e.type === 'attack' && e.kind === 'melee').luck, 0,
    'with the Devil dead the curse lifts');
});

test('aura fade: an Angel lifts the side’s morale until it is slain (moraleAura)', () => {
  const battle = makeBattle(
    [{ creature: 'angel', count: 1 }, { creature: 'pikeman', count: 10 }],
    [{ creature: 'peasant', count: 20 }]);
  const angel = battle.units.find((u) => u.creature === 'angel');
  const pike = battle.units.find((u) => u.creature === 'pikeman');
  const peasant = battle.units.find((u) => u.creature === 'peasant');
  battle.rng.chance = () => true; // force the good-morale roll

  const ev1 = adjacentAttack(battle, pike, peasant);
  assert.ok(ev1.some((e) => e.type === 'morale' && e.unitId === pike.id),
    'the live Angel grants the stack a second wind');

  angel.alive = false; angel.count = 0;   // slay the aura's source
  pike.moraleUsed = false;                // clear the once-per-round flag
  peasant.hp = peasant.maxHp; peasant.count = 20; peasant.alive = true;
  const ev2 = adjacentAttack(battle, pike, peasant);
  assert.ok(!ev2.some((e) => e.type === 'morale'),
    'with the Angel dead there is no morale aura');
});

// ---------------------------------------------------------------------------
// Curse + per-stack morale / luck spells
// ---------------------------------------------------------------------------

test('curse: a cursed stack deals its MINIMUM damage', () => {
  // Compare engine output to engine output — a cursed strike equals a min-rolled
  // one and falls below a max-rolled one — so no damage formula is re-derived.
  const strikeDamage = ({ cursed = false, force = null } = {}) => {
    const battle = makeBattle([{ creature: 'pikeman', count: 20 }], [{ creature: 'swordsman', count: 20 }]);
    const pike = battle.units.find((u) => u.side === 0);
    const sword = battle.units.find((u) => u.side === 1); // damage spread [6,9]
    if (cursed) sword.effects.push({ spellId: 'curse', effects: { cursed: 1 }, rounds: 9 });
    if (force === 'min') battle.rng.int = (a) => a;
    if (force === 'max') battle.rng.int = (a, b) => b;
    const ev = adjacentAttack(battle, sword, pike);
    return ev.find((e) => e.type === 'attack' && e.kind === 'melee' && e.attackerId === sword.id).damage;
  };
  const min = strikeDamage({ force: 'min' });
  const max = strikeDamage({ force: 'max' });
  assert.ok(min < max, 'the creature really does have a damage spread');
  assert.equal(strikeDamage({ cursed: true }), min, 'curse pins the roll to the minimum');
});

test('luck spells: Fortune buys a lucky strike, Misfortune an unlucky one — per stack', () => {
  // Fortune (buff) lands on OUR stack → our blow rolls lucky.
  {
    const hero = makeHero({ spells: ['fortune'], mana: 999, power: 3 });
    const battle = makeBattle([{ creature: 'pikeman', count: 20 }], [{ creature: 'peasant', count: 99 }],
      { attackerHero: hero });
    const pike = battle.units.find((u) => u.side === 0);
    const peasant = battle.units.find((u) => u.side === 1);
    castSpell(battle, 0, 'fortune', { unitId: pike.id });
    assert.equal(effectDelta(pike, 'luck'), SPELLS.fortune.effects.luck, 'Fortune adds its +luck to the stack');
    battle.rng.chance = () => true; // force the luck roll to fire
    const ev = adjacentAttack(battle, pike, peasant);
    assert.equal(ev.find((e) => e.type === 'attack' && e.kind === 'melee' && e.attackerId === pike.id).luck, 1,
      'Fortune yields a doubling lucky strike');
  }
  // Misfortune (debuff) lands on the ENEMY stack → THEIR blow rolls unlucky.
  {
    const hero = makeHero({ spells: ['misfortune'], mana: 999, power: 3 });
    const battle = makeBattle([{ creature: 'pikeman', count: 99 }], [{ creature: 'peasant', count: 20 }],
      { attackerHero: hero });
    const pike = battle.units.find((u) => u.side === 0);
    const peasant = battle.units.find((u) => u.side === 1);
    castSpell(battle, 0, 'misfortune', { unitId: peasant.id });
    assert.equal(effectDelta(peasant, 'luck'), SPELLS.misfortune.effects.luck, 'Misfortune adds its −luck to the stack');
    battle.rng.chance = () => true;
    const ev = adjacentAttack(battle, peasant, pike);
    assert.equal(ev.find((e) => e.type === 'attack' && e.kind === 'melee' && e.attackerId === peasant.id).luck, -1,
      'Misfortune yields a halving unlucky strike');
  }
  // A plain stack rolls neither way, even with the roll forced.
  {
    const battle = makeBattle([{ creature: 'pikeman', count: 20 }], [{ creature: 'peasant', count: 99 }]);
    const pike = battle.units.find((u) => u.side === 0);
    const peasant = battle.units.find((u) => u.side === 1);
    battle.rng.chance = () => true;
    const ev = adjacentAttack(battle, pike, peasant);
    assert.equal(ev.find((e) => e.type === 'attack' && e.kind === 'melee' && e.attackerId === pike.id).luck, 0,
      'a plain stack rolls neither lucky nor unlucky');
  }
});

test('morale spells: Mirth grants +2 morale and a second wind; Sorrow imposes −2', () => {
  const hero = makeHero({ spells: ['mirth', 'sorrow'], mana: 999, power: 3 });
  const battle = makeBattle([{ creature: 'pikeman', count: 20 }], [{ creature: 'peasant', count: 20 }],
    { attackerHero: hero });
  const pike = battle.units.find((u) => u.side === 0);
  const peasant = battle.units.find((u) => u.side === 1);

  castSpell(battle, 0, 'mirth', { unitId: pike.id });
  assert.equal(effectDelta(pike, 'morale'), SPELLS.mirth.effects.morale, 'Mirth adds its +morale to the stack');
  battle.sides[0].castThisRound = false;
  castSpell(battle, 0, 'sorrow', { unitId: peasant.id });
  assert.equal(effectDelta(peasant, 'morale'), SPELLS.sorrow.effects.morale, 'Sorrow adds its −morale to the stack');

  // The +morale actually produces the extra action when the roll is forced.
  battle.rng.chance = () => true;
  const ev = adjacentAttack(battle, pike, peasant);
  assert.ok(ev.some((e) => e.type === 'morale' && e.unitId === pike.id), 'Mirth’s morale drives a second wind');
});

// ---------------------------------------------------------------------------
// Combat spell effects — the ones that previously had no assertion
// ---------------------------------------------------------------------------

test('damage spells: every bolt/blast deals base + perPower×Power to its target', () => {
  const POWER = 4;
  const CASES = ['magicArrow', 'lightningBolt', 'iceBolt', 'implosion', 'titanBolt',
    'fireball', 'meteorShower', 'inferno', 'chainLightning', 'armageddon'];
  for (const id of CASES) {
    const sp = SPELLS[id];
    const hero = makeHero({ spells: [id], mana: 999, power: POWER });
    const battle = makeBattle([{ creature: 'pikeman', count: 10 }], [{ creature: 'peasant', count: 999 }],
      { attackerHero: hero });
    const pike = battle.units.find((u) => u.side === 0);
    const target = battle.units.find((u) => u.side === 1);
    place(pike, 1, 1);      // out of any splash so only `target` is the primary hit
    place(target, 8, 5);
    const arg = sp.hitsAll ? {} : { unitId: target.id };
    const ev = castSpell(battle, 0, id, arg);
    const expected = sp.base + sp.perPower * POWER; // sorcery 1, no school skill → exact
    const primary = ev.filter((e) => e.type === 'spellHit' && e.targetId === target.id)
      .sort((a, b) => b.damage - a.damage)[0]; // chain: the first (largest) hit
    assert.ok(primary, `${id}: the target was hit`);
    assert.equal(primary.damage, expected, `${id}: damage is base + perPower×Power`);
  }
});

test('buff/debuff spells: each applies exactly its declared effects to the target', () => {
  const combat = Object.entries(SPELLS).filter(([, s]) => !s.adventure && (s.kind === 'buff' || s.kind === 'debuff'));
  assert.ok(combat.length >= 14, 'the sweep spans the whole buff/debuff roster');
  for (const [id, sp] of combat) {
    const hero = makeHero({ spells: [id], mana: 999, power: 3 });
    const battle = makeBattle([{ creature: 'pikeman', count: 10 }], [{ creature: 'peasant', count: 10 }],
      { attackerHero: hero });
    const mine = battle.units.find((u) => u.side === 0);
    const foe = battle.units.find((u) => u.side === 1);
    const target = sp.kind === 'buff' ? mine : foe; // buffs land on friends, hexes on foes
    const ev = castSpell(battle, 0, id, { unitId: target.id });
    assert.ok(ev.some((e) => e.type === 'spellEffect' && e.spellId === id && e.hostile === (sp.kind === 'debuff')),
      `${id}: a ${sp.kind} effect event is emitted`);
    const applied = target.effects.find((e) => e.spellId === id);
    assert.ok(applied, `${id}: the effect is on the target`);
    assert.deepEqual(applied.effects, sp.effects, `${id}: the applied effects match the spell data`);
  }
});

// A defining flag spell whose application (not just its skip behaviour, tested in
// combat.test.js) is worth pinning: Blind stamps the `blinded` flag on its target.
test('blind: the target carries the blinded flag after the cast', () => {
  const hero = makeHero({ spells: ['blind'], mana: 999, power: 3 });
  const battle = makeBattle([{ creature: 'pikeman', count: 10 }], [{ creature: 'peasant', count: 10 }],
    { attackerHero: hero });
  const peasant = battle.units.find((u) => u.side === 1);
  castSpell(battle, 0, 'blind', { unitId: peasant.id });
  assert.ok(hasFlag(peasant, 'blinded'), 'blind stamps the flag rollDamage/beginTurn read');
  assert.ok(peasant.effects.some((e) => e.spellId === 'blind' && e.rounds >= SPELLS.blind.duration),
    'the effect carries at least its base duration');
});

// A sanity peg for the shared clamp the aura/spell tests lean on.
test('config: morale/luck clamp is the shared MORALE_LUCK_MAX', () => {
  assert.equal(CONFIG.MORALE_LUCK_MAX, 3, 'the ±3 cap the engine clamps morale and luck to');
});
