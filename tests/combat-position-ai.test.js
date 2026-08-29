/**
 * combat-position-ai.test.js — position-aware combat AI + the untargetable
 * Catapult (2026-07 repo review, "combat position cluster").
 *
 * - The Catapult is `untargetable` (HoMM3 rule): no shot, strike or spell can
 *   touch it, so a defender can never snipe it and leave an all-walker
 *   besieger permanently unable to breach (the unbounded-stalemate hole).
 * - meleeScore is approach-hex-aware for attacksAround (Hydra): the real blow
 *   savages EVERY adjacent enemy with no retaliation, so the AI now sees a
 *   profit where the single-target + retaliation model saw suicide.
 * - Walkers no longer END a move in the moat when an equal-progress dry hex
 *   exists (the moat bite is priced); crossing through stays free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle, act, castSpell } from '../src/core/combat/CombatEngine.js';
import { chooseAction } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

function makeHero(spells = []) {
  return {
    stats: { attack: 0, defense: 0, power: 5, knowledge: 5 },
    skills: {}, equipment: {}, army: [], spells, mana: 50,
    tempMorale: 0, tempLuck: 0,
  };
}

function makeBattle(attackerArmy, defenderArmy, opts = {}) {
  return createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng: new Rng(opts.seed ?? 99),
    attacker: { hero: opts.attackerHero || null, army: attackerArmy, playerIndex: 0 },
    defender: { hero: opts.defenderHero || null, army: defenderArmy, playerIndex: 1 },
  });
}

const bySide = (b, side, creature) =>
  b.units.find((u) => u.side === side && u.creature === creature);

test('the Catapult can be neither shot, struck, nor spelled', () => {
  const b = makeBattle(
    [{ creature: 'catapult', count: 1 }, { creature: 'pikeman', count: 5 }],
    [{ creature: 'archer', count: 10 }, { creature: 'crusader', count: 5 }],
    { defenderHero: makeHero(['magicArrow']) },
  );
  const cat = bySide(b, 0, 'catapult');
  const archer = bySide(b, 1, 'archer');
  const crusader = bySide(b, 1, 'crusader');

  assert.deepEqual(act(b, archer, { type: 'shoot', targetId: cat.id }), [], 'no shooting it');
  crusader.x = cat.x + 1; crusader.y = cat.y; // stand adjacent
  assert.deepEqual(act(b, crusader, { type: 'attack', targetId: cat.id }), [], 'no striking it');
  assert.deepEqual(castSpell(b, 1, 'magicArrow', { unitId: cat.id }), [], 'no spelling it');
  assert.equal(cat.alive, true);
  assert.equal(cat.hp, cat.maxHp);
});

test('the combat AI never wastes a turn targeting the Catapult', () => {
  const b = makeBattle(
    [{ creature: 'catapult', count: 1 }],
    [{ creature: 'archer', count: 10 }],
  );
  const archer = bySide(b, 1, 'archer');
  const action = chooseAction(b, archer);
  // The only "enemy" is untargetable → the archer must not shoot at it.
  assert.notEqual(action.type, 'shoot', `got ${JSON.stringify(action)}`);
});

test('Hydra charges a wall of pikemen the single-target model would refuse', () => {
  // 2 Chaos Hydras vs 60 pikemen: for a normal melee stack this trade is
  // suicide (massive retaliation); the hydra strikes free of retaliation, so
  // the position-aware score turns positive and it attacks.
  const bH = makeBattle(
    [{ creature: 'chaosHydra', count: 2 }],
    [{ creature: 'pikeman', count: 60 }],
  );
  const hydra = bySide(bH, 0, 'chaosHydra');
  const pikeH = bySide(bH, 1, 'pikeman');
  hydra.x = 3; hydra.y = 5; pikeH.x = 6; pikeH.y = 5;
  const a = chooseAction(bH, hydra);
  assert.equal(a.type, 'attack', `hydra should charge, got ${JSON.stringify(a)}`);

  // Control: crusaders (double strike, but retaliation applies) refuse the
  // same charge from the same spot — they close distance instead.
  const bC = makeBattle(
    [{ creature: 'crusader', count: 2 }],
    [{ creature: 'pikeman', count: 60 }],
  );
  const crus = bySide(bC, 0, 'crusader');
  const pikeC = bySide(bC, 1, 'pikeman');
  crus.x = 3; crus.y = 5; pikeC.x = 6; pikeC.y = 5;
  const c = chooseAction(bC, crus);
  assert.notEqual(c.type, 'attack', `crusaders should not suicide, got ${JSON.stringify(c)}`);
});

test('a walker does not END its move in the moat when a dry hex makes the same progress', () => {
  const b = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'crusader', count: 10 }],
  );
  // Fabricate a moat column at x=7 (what buildFortifications does in a siege).
  b.moat = Array.from({ length: 11 }, (_, y) => ({ x: 7, y }));
  const pike = bySide(b, 0, 'pikeman');
  const foe = bySide(b, 1, 'crusader');
  pike.x = 3; pike.y = 5;   // speed 4 → farthest reachable column is exactly the moat
  foe.x = 12; foe.y = 5;    // far beyond reach this turn
  const a = chooseAction(b, pike);
  assert.equal(a.type, 'move', `expected a closing move, got ${JSON.stringify(a)}`);
  assert.ok(!b.moat.some((m) => m.x === a.x && m.y === a.y),
    `must not end the move in the moat (moved to ${a.x},${a.y})`);
});
