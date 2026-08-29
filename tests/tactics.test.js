/**
 * tactics.test.js — the Tactics secondary skill + its pre-battle placement phase.
 * A hero with more Tactics than the enemy may reposition its stacks within a band
 * of columns near its edge before the first turn (Basic 3 / Advanced 5 / Expert 7,
 * minus the enemy's Tactics). Pure rule-engine, no Phaser.
 * Run: node --test tests/tactics.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILLS, skillValue } from '../src/data/skills.js';
import {
  createBattle, tacticsBand, canPlaceTactics, placeTactics, endTactics, BF_W,
} from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

function hero(tacticsLevel) {
  return {
    stats: { attack: 0, defense: 0, power: 0, knowledge: 0 },
    skills: tacticsLevel ? { tactics: tacticsLevel } : {},
    equipment: {}, army: [], spells: [], mana: 0, tempMorale: 0, tempLuck: 0,
  };
}
function battle(aTac, dTac, opts = {}) {
  return createBattle({
    rng: new Rng(opts.seed ?? 77),
    siege: opts.siege || null,
    attacker: { hero: hero(aTac), army: opts.attacker || [{ creature: 'pikeman', count: 10 }, { creature: 'archer', count: 10 }], playerIndex: 0 },
    defender: { hero: hero(dTac), army: opts.defender || [{ creature: 'pikeman', count: 10 }], playerIndex: 1 },
  });
}

test('Tactics is a registered secondary skill worth 3 / 5 / 7 columns', () => {
  assert.ok(SKILLS.tactics, 'the skill exists');
  assert.deepEqual(SKILLS.tactics.levels, [3, 5, 7]);
  assert.equal(skillValue(hero(1), 'tactics'), 3);
  assert.equal(skillValue(hero(3), 'tactics'), 7);
  assert.equal(skillValue(hero(0), 'tactics'), 0);
});

test('setupTactics: the higher-Tactics side gets the phase, reach = the difference', () => {
  assert.deepEqual(battle(1, 0).tactics, { side: 0, reach: 3, done: false }, 'Basic vs none → attacker, 3');
  assert.equal(battle(2, 2).tactics, null, 'equal Tactics cancels — no phase');
  assert.equal(battle(0, 0).tactics, null, 'neither has it → no phase');
  assert.deepEqual(battle(3, 1).tactics, { side: 0, reach: 4, done: false }, 'Expert vs Basic → reach 4');
  assert.deepEqual(battle(1, 3).tactics, { side: 1, reach: 4, done: false }, 'the defender can win the phase too');
});

test('tacticsBand: the attacker places near column 0, the defender near the far edge', () => {
  const b = battle(2, 0); // reach 5, attacker
  assert.deepEqual(tacticsBand(b, 0), { min: 0, max: 5 });
  assert.equal(tacticsBand(b, 1), null, 'the side without the phase has no band');
  const d = battle(0, 2); // reach 5, defender
  assert.deepEqual(tacticsBand(d, 1), { min: BF_W - 1 - 5, max: BF_W - 1 });
});

test('placeTactics honours the band, occupancy, ownership, machines and the phase close', () => {
  const b = battle(1, 0); // attacker, reach 3
  const pike = b.units.find((u) => u.creature === 'pikeman' && u.side === 0);
  const archer = b.units.find((u) => u.creature === 'archer' && u.side === 0);

  assert.equal(placeTactics(b, pike.id, 3, 6), true, 'a hex inside the band is legal');
  assert.equal(pike.x, 3); assert.equal(pike.y, 6);
  assert.equal(placeTactics(b, pike.id, 4, 6), false, 'one column past the band is rejected');
  assert.equal(placeTactics(b, archer.id, 3, 6), false, 'cannot stack onto an occupied hex');

  const enemy = b.units.find((u) => u.side === 1);
  assert.equal(placeTactics(b, enemy.id, 1, 5), false, 'the other side cannot move during your phase');

  endTactics(b);
  assert.equal(placeTactics(b, pike.id, 0, 0), false, 'once the phase is closed, nothing moves');
});

test('war machines are fixed — Tactics cannot reposition them', () => {
  const b = battle(3, 0, { attacker: [{ creature: 'pikeman', count: 10 }] });
  b.units.push({ id: 'm', side: 0, creature: 'ballista', machine: 'ballista', noncombatant: true, count: 1, startCount: 1, hp: 250, maxHp: 250, x: 0, y: 4, shots: 999, effects: [], alive: true });
  assert.equal(canPlaceTactics(b, b.units.find((u) => u.id === 'm'), 2, 4), false, 'a machine is never a tactics target');
});

test('in a siege the defender cannot place a stack onto a standing wall', () => {
  const b = battle(0, 3, { siege: { fortTier: 3 }, defender: [{ creature: 'pikeman', count: 10 }] });
  // Expert reach 7 → defender band reaches column 7..14, which spans the wall (col 12).
  const pike = b.units.find((u) => u.creature === 'pikeman' && u.side === 1);
  assert.equal(canPlaceTactics(b, pike, 12, 0), false, 'the wall column is blocked');
  assert.equal(canPlaceTactics(b, pike, 13, 0), true, 'a clear hex behind the wall is fine');
});

test('repositioning then fighting still resolves cleanly', () => {
  const b = battle(2, 0);
  const pike = b.units.find((u) => u.creature === 'pikeman' && u.side === 0);
  placeTactics(b, pike.id, 4, 5);
  endTactics(b);
  const r = autoResolve(b);
  assert.equal(typeof r.attackerWon, 'boolean', 'the battle still terminates after a tactics move');
});
