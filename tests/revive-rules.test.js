/**
 * revive-rules.test.js — what a revive may and may not do (2026-08 audit,
 * findings C5 / S10 / S24).
 *
 * Three rules, each pinned against a defect that was reproduced in play:
 *
 *  1. ONE HEX, ONE STACK (C5). A corpse keeps its last hex, but unitAt() and
 *     reachableHexes() are alive-only, so a living stack may legally walk onto
 *     it. Every revive path — Resurrection, the Archangel's gift, the
 *     Phoenix's rebirth — must therefore refuse to re-form a stack under a
 *     hex a live stack now occupies; raising it anyway produced two live
 *     stacks on one hex (the buried one untargetable and splash-immune, yet
 *     still attacking). Refusal, not relocation, is the chosen rule because it
 *     is what the CombatScene targeting UI already showed the player
 *     (deadTargetAt and the revive-highlight loop both skip an occupied corpse
 *     hex). The AI's candidate generation must mirror the refusal, or it
 *     would burn casts and the Archangel's once-per-battle gift on no-ops.
 *
 *  2. DEATH DISPELS (S10). startRound's duration tick skips the dead, so an
 *     effect on a corpse froze at its at-death value — a stack Slowed in
 *     round 1 and raised in round 12 came back at speed 1 with the full
 *     remaining duration. Revival clears effects and spent-this-round flags
 *     and re-anchors the cohesion baseline to the revived count.
 *
 *  3. ONLY A REVIVING SPELL RAISES THE DEAD (S24). healUnit's no-revive clamp
 *     keyed on `unit.alive`, so a dead target fell through into the full
 *     resurrection path: Cure — "cannot revive the dead", by its own
 *     description — returned a wiped stack to the field. Unreachable from
 *     today's callers, but castSpell is the documented enforcement point
 *     precisely so a future caller cannot do this.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle, castSpell, act, beginTurn, unitAt, unitSpeed } from '../src/core/combat/CombatEngine.js';
import { candidateActions, maybeCastAISpell } from '../src/core/combat/CombatAI.js';
import { CREATURES } from '../src/data/creatures.js';
import { Rng } from '../src/core/rng.js';

function makeHero(spells, power = 5) {
  return {
    stats: { attack: 0, defense: 0, power, knowledge: 5 },
    skills: {}, equipment: {}, army: [],
    spells, mana: 99, tempMorale: 0, tempLuck: 0,
  };
}

function makeBattle({ attackerHero = null, defenderHero = null, attackerArmy, defenderArmy, features } = {}) {
  return createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng: new Rng(7),
    features,
    attacker: { hero: attackerHero, army: attackerArmy, playerIndex: 0 },
    defender: { hero: defenderHero, army: defenderArmy, playerIndex: 1 },
  });
}

/** Slay a stack the way applyDamage's kill branch leaves it. */
function slay(u) { u.count = 0; u.hp = 0; u.alive = false; }

// ---------------------------------------------------------------------------
// 1. One hex, one stack
// ---------------------------------------------------------------------------

test('C5: Resurrection is refused when a live stack stands on the corpse hex — no mana spent', () => {
  const b = makeBattle({
    attackerHero: makeHero(['resurrection']),
    attackerArmy: [{ creature: 'pikeman', count: 10 }, { creature: 'archer', count: 8 }],
    defenderArmy: [{ creature: 'pikeman', count: 5 }],
  });
  const archer = b.units.find((u) => u.side === 0 && u.creature === 'archer');
  const pike = b.units.find((u) => u.side === 0 && u.creature === 'pikeman');
  const { x, y } = archer;
  slay(archer);
  pike.x = x; pike.y = y; // a living stack claims the hex, as movement legally can

  const manaBefore = b.sides[0].hero.mana;
  assert.deepEqual(castSpell(b, 0, 'resurrection', { unitId: archer.id }), [], 'refused outright');
  assert.equal(b.sides[0].hero.mana, manaBefore, 'no mana spent on the impossible cast');
  assert.equal(archer.alive, false, 'the buried corpse stays down');
  assert.equal(b.units.filter((u) => u.alive && u.x === x && u.y === y).length, 1,
    'one hex, one stack');
});

test('C5: the Archangel refusal does not burn its once-per-battle gift', () => {
  const b = makeBattle({
    attackerArmy: [{ creature: 'archangel', count: 2 }, { creature: 'archer', count: 8 },
      { creature: 'pikeman', count: 10 }],
    defenderArmy: [{ creature: 'pikeman', count: 5 }],
  });
  const arch = b.units.find((u) => u.creature === 'archangel');
  const archer = b.units.find((u) => u.creature === 'archer');
  const pike = b.units.find((u) => u.side === 0 && u.creature === 'pikeman');
  slay(archer);
  pike.x = archer.x; pike.y = archer.y;

  assert.deepEqual(act(b, arch, { type: 'resurrect', targetId: archer.id }), [], 'refused outright');
  assert.equal(arch.resurrectUsed, false, 'the gift is not consumed by a refusal');
  assert.equal(archer.alive, false);

  // Free the hex and the same action succeeds — the corpse itself was never invalid.
  pike.x = archer.x + 2;
  const evs = act(b, arch, { type: 'resurrect', targetId: archer.id });
  assert.ok(evs.some((e) => e.type === 'heal' && e.revived > 0), 'raised once the hex is free');
  assert.ok(archer.alive);
});

test('C5: a Phoenix does not rise into an occupied hex — the ashes wait for it to free', () => {
  const b = makeBattle({
    attackerArmy: [{ creature: 'phoenix', count: 4 }, { creature: 'pikeman', count: 10 }],
    defenderArmy: [{ creature: 'pikeman', count: 5 }],
  });
  const phoenix = b.units.find((u) => u.creature === 'phoenix');
  const pike = b.units.find((u) => u.side === 0 && u.creature === 'pikeman');
  slay(phoenix);
  pike.x = phoenix.x; pike.y = phoenix.y; // manufactured: nothing can move in
  // between a death and its finish() today, but a future death path could.

  // Any action runs finish(), which is where rebirth fires.
  const { unit } = beginTurn(b);
  act(b, unit, { type: 'defend' });
  assert.equal(phoenix.alive, false, 'no rebirth under a standing stack');
  assert.equal(phoenix.rebirthUsed, undefined, 'the once-per-battle rebirth is not consumed');

  pike.x = phoenix.x + 2; // the squatter moves off
  const { unit: next } = beginTurn(b);
  act(b, next, { type: 'defend' });
  assert.equal(phoenix.alive, true, 'the ashes rise once the hex frees');
  assert.equal(phoenix.rebirthUsed, true);
  assert.equal(unitAt(b, phoenix.x, phoenix.y), phoenix);
});

test('C5: the AI neither prices nor casts a revive at a buried corpse', () => {
  const b = makeBattle({
    attackerHero: makeHero(['resurrection']),
    attackerArmy: [{ creature: 'archangel', count: 2 }, { creature: 'archer', count: 8 },
      { creature: 'pikeman', count: 10 }],
    defenderArmy: [{ creature: 'pikeman', count: 5 }],
  });
  const arch = b.units.find((u) => u.creature === 'archangel');
  const archer = b.units.find((u) => u.creature === 'archer');
  const pike = b.units.find((u) => u.side === 0 && u.creature === 'pikeman');
  slay(archer);
  pike.x = archer.x; pike.y = archer.y;

  const { options } = candidateActions(b, arch);
  assert.ok(!options.some((o) => o.action.type === 'resurrect' && o.action.targetId === archer.id),
    'the Archangel never bids on a target the engine would refuse');

  // The hero's only spell is Resurrection and its only corpse is buried: the
  // round must pass with no cast at all rather than a refused (wasted) attempt.
  const manaBefore = b.sides[0].hero.mana;
  assert.deepEqual(maybeCastAISpell(b, 0), [], 'no cast offered');
  assert.equal(b.sides[0].hero.mana, manaBefore);
  assert.equal(b.sides[0].castThisRound, false, "the round's cast is still available");
});

// ---------------------------------------------------------------------------
// 2. Death dispels
// ---------------------------------------------------------------------------

test('S10: a resurrected stack returns clean — no frozen enchantments, full speed, fresh flags', () => {
  const b = makeBattle({
    attackerHero: makeHero(['slow']),
    defenderHero: makeHero(['resurrection']),
    attackerArmy: [{ creature: 'pikeman', count: 10 }],
    defenderArmy: [{ creature: 'archer', count: 8 }, { creature: 'pikeman', count: 10 }],
  });
  const archer = b.units.find((u) => u.side === 1 && u.creature === 'archer');
  castSpell(b, 0, 'slow', { unitId: archer.id });
  assert.ok(archer.effects.some((e) => e.spellId === 'slow'), 'slowed while alive');
  archer.retaliated = true;
  archer.hasWaitedFlag = true;
  slay(archer); // startRound skips the dead, so the effect freezes here…

  // …across far more rounds than its duration was ever worth.
  for (let i = 0; i < 60 && !b.over; i++) {
    const { unit } = beginTurn(b);
    if (!unit) break;
    act(b, unit, { type: 'defend' });
  }
  assert.ok(b.round > 10, 'the battle has advanced well past any spell duration');
  b.sides[1].castThisRound = false;
  const evs = castSpell(b, 1, 'resurrection', { unitId: archer.id });
  assert.ok(evs.some((e) => e.type === 'heal' && e.revived > 0), 'the stack is raised');
  assert.deepEqual(archer.effects, [], 'death dispelled the enchantment');
  assert.equal(unitSpeed(b, archer), CREATURES.archer.speed, 'no ghost of the old Slow');
  assert.equal(archer.retaliated, false, 'per-round flags belong to the body that died');
  assert.equal(archer.hasWaitedFlag, false);
  assert.equal(archer.roundStartCount, archer.count,
    'the cohesion baseline is the revived number, not the pre-death one');
});

test('S10: a reborn Phoenix rises free of the effects it died under', () => {
  const b = makeBattle({
    attackerHero: makeHero(['slow']),
    attackerArmy: [{ creature: 'pikeman', count: 10 }],
    defenderArmy: [{ creature: 'phoenix', count: 4 }, { creature: 'pikeman', count: 10 }],
  });
  const phoenix = b.units.find((u) => u.creature === 'phoenix');
  castSpell(b, 0, 'slow', { unitId: phoenix.id });
  assert.ok(phoenix.effects.length > 0);
  slay(phoenix);
  const { unit } = beginTurn(b); // finish() on any action triggers the rebirth
  act(b, unit, { type: 'defend' });
  assert.equal(phoenix.alive, true, 'rose from its ashes');
  assert.deepEqual(phoenix.effects, [], 'new flesh carries no old enchantment');
});

// ---------------------------------------------------------------------------
// 3. Only a reviving spell raises the dead
// ---------------------------------------------------------------------------

test('S24: Cure on a corpse is refused at castSpell — no mana, no revival', () => {
  const b = makeBattle({
    attackerHero: makeHero(['cure'], 10),
    attackerArmy: [{ creature: 'pikeman', count: 10 }, { creature: 'archer', count: 8 }],
    defenderArmy: [{ creature: 'pikeman', count: 5 }],
  });
  const archer = b.units.find((u) => u.side === 0 && u.creature === 'archer');
  slay(archer);
  const manaBefore = b.sides[0].hero.mana;
  assert.deepEqual(castSpell(b, 0, 'cure', { unitId: archer.id }), [], 'refused outright');
  assert.equal(b.sides[0].hero.mana, manaBefore, 'no mana spent');
  assert.equal(archer.alive, false, 'Cure kept its word: it cannot revive the dead');
});
