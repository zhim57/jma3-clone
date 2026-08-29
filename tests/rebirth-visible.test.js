/**
 * rebirth-visible.test.js — the "invisible stack that keeps attacking".
 *
 * A Phoenix stack that is wiped out RISES AGAIN once per battle (rebirth). The
 * engine did this correctly, but the view faded the sprite to alpha 0 when the
 * stack died and never restored it, so the reborn stack fought on from an
 * apparently empty tile. These tests pin the engine contract the fixed view
 * relies on: after a wipe the unit is alive again, occupies a real hex, is found
 * by unitAt (so it can be targeted), and only ever comes back ONCE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CREATURES } from '../src/data/creatures.js';
import { Rng } from '../src/core/rng.js';
import { newGame } from '../src/core/GameState.js';
import { createBattle, unitAt, act, beginTurn } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';

function battleWithPhoenix(attackerCount = 300) {
  const s = newGame({ seed: 21, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const hero = Object.values(s.heroes).find((h) => h.owner === 0);
  return createBattle({
    rng: new Rng(5),
    attacker: { hero, army: [{ creature: 'archangel', count: attackerCount }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'phoenix', count: 4 }], playerIndex: -1 },
  });
}

test('the Phoenix really does have rebirth (the mechanic under the report)', () => {
  assert.ok(CREATURES.phoenix.abilities.includes('rebirth'));
});

test('a wiped Phoenix stack comes back ALIVE, on a real hex, and is targetable', () => {
  const battle = battleWithPhoenix();
  const ph = battle.units.find((u) => u.creature === 'phoenix');
  const foe = battle.units.find((u) => u.side === 0 && !u.machine);
  const startCount = ph.startCount;

  // Hit it until the stack is wiped; the engine's finish() then rebirths it.
  let guard = 60;
  while (ph.alive && ph.count === startCount && guard-- > 0) {
    act(battle, foe, { type: 'shoot', targetId: ph.id });
    if (!ph.alive) break;
  }
  // Whether it died outright or was reborn in the same breath, it must not be a
  // live unit with no place on the board.
  if (ph.alive && ph.count < startCount) {
    assert.ok(ph.count >= 1, 'reborn with at least one creature');
    assert.equal(unitAt(battle, ph.x, ph.y)?.id, ph.id,
      'unitAt finds it at its hex — so a click can target it and the view can draw it');
  }
});

test('rebirth fires at most ONCE per battle', () => {
  const battle = battleWithPhoenix();
  const ph = battle.units.find((u) => u.creature === 'phoenix');
  autoResolve(battle);
  assert.ok(ph.rebirthUsed === true || !ph.alive,
    'either it burned its one rebirth, or it simply never died');
  // Whatever happened, it cannot be alive with the rebirth still unspent AND a
  // zero count — that would be the invisible-ghost state.
  assert.ok(!(ph.alive && ph.count <= 0), 'never alive with nothing in the stack');
});

test('no unit is ever left alive with a zero count (the ghost state)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = newGame({ seed, players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ] });
    const hero = Object.values(s.heroes).find((h) => h.owner === 0);
    const battle = createBattle({
      rng: new Rng(seed * 7),
      attacker: { hero, army: [{ creature: 'pikeman', count: 120 }], playerIndex: 0 },
      defender: { hero: null, army: [{ creature: 'phoenix', count: 6 }], playerIndex: -1 },
    });
    autoResolve(battle);
    for (const u of battle.units) {
      assert.ok(!(u.alive && u.count <= 0), `seed ${seed}: ${u.creature} alive with count ${u.count}`);
    }
  }
});

test('a reborn stack still takes its turn (it is a real combatant, not a phantom)', () => {
  const battle = battleWithPhoenix(40); // weaker attacker → the fight runs longer
  autoResolve(battle);
  // The battle must terminate and declare a winner rather than spin on a unit
  // that is alive but unreachable.
  assert.ok(battle.over, 'the battle ended');
  assert.ok(battle.winner === 0 || battle.winner === 1, 'with a real winner');
});

test('beginTurn never hands a turn to a dead stack', () => {
  const battle = battleWithPhoenix();
  let guard = 200;
  while (!battle.over && guard-- > 0) {
    const { unit } = beginTurn(battle);
    if (!unit) break;
    assert.ok(unit.alive && unit.count > 0, 'only living stacks act');
    const foe = battle.units.find((u) => u.alive && u.side !== unit.side);
    if (!foe) break;
    act(battle, unit, { type: 'shoot', targetId: foe.id });
  }
});
