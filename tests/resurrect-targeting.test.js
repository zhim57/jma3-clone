/**
 * resurrect-targeting.test.js — Resurrection / Archangel targeting of a FALLEN
 * friendly stack (2026-07 repo review, backlog item A1).
 *
 * The engine resolves a spell/ability target by id over ALL units (dead
 * included) and revives a fully-wiped friendly stack. The human UI, however,
 * resolved every click through unitAt() (alive-only), so a player could never
 * aim Resurrection or the Archangel at a corpse while the AI could. These tests
 * pin the contract the CombatScene fix relies on: a dead stack keeps its last
 * hex, and casting by that id raises it — but only for a FRIENDLY corpse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle, castSpell, unitAt } from '../src/core/combat/CombatEngine.js';
import { Rng } from '../src/core/rng.js';

function makeHero() {
  return {
    stats: { attack: 0, defense: 0, power: 5, knowledge: 5 },
    skills: {}, equipment: {}, army: [],
    spells: ['resurrection'], mana: 50, tempMorale: 0, tempLuck: 0,
  };
}

function makeBattle() {
  return createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng: new Rng(7),
    attacker: {
      hero: makeHero(),
      army: [{ creature: 'pikeman', count: 10 }, { creature: 'archer', count: 8 }],
      playerIndex: 0,
    },
    defender: {
      hero: null,
      army: [{ creature: 'pikeman', count: 5 }],
      playerIndex: 1,
    },
  });
}

test('Resurrection raises a fully-dead FRIENDLY stack by id — the path the AI already had', () => {
  const b = makeBattle();
  const victim = b.units.find((u) => u.side === 0 && u.creature === 'archer');
  const { x, y } = victim;
  // Emulate a lethal blow (applyDamage's kill branch).
  victim.count = 0; victim.hp = 0; victim.alive = false;

  // The exact bug: the alive-only hex lookup the UI used can no longer find it…
  assert.equal(unitAt(b, x, y), null, 'unitAt (alive-only) hides the corpse');
  // …but the corpse keeps its hex, so a dead-aware hex→corpse lookup resolves it.
  assert.ok(
    b.units.some((u) => !u.alive && u.side === 0 && u.x === x && u.y === y),
    'the corpse retains its last hex for a UI hex→corpse lookup',
  );

  const evs = castSpell(b, 0, 'resurrection', { unitId: victim.id });
  assert.ok(evs.some((e) => e.type === 'heal' && e.revived > 0), 'the stack is revived');
  assert.ok(victim.alive && victim.count > 0, 'the fallen stack stands again');
  assert.equal(victim.x, x, 'position preserved across the raise');
  assert.equal(victim.y, y);
});

test('Resurrection on an ENEMY corpse is still refused (no reviving the other side)', () => {
  const b = makeBattle();
  const foe = b.units.find((u) => u.side === 1);
  foe.count = 0; foe.hp = 0; foe.alive = false;
  const before = b.sides[0].hero.mana;
  assert.deepEqual(castSpell(b, 0, 'resurrection', { unitId: foe.id }), [], 'refused outright');
  assert.equal(foe.alive, false, 'enemy corpse stays down');
  assert.equal(b.sides[0].hero.mana, before, 'no mana spent on the illegal cast');
});
