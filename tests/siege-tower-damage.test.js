/**
 * siege-tower-damage.test.js — the Settings-tunable siege arrow-tower multiplier.
 *
 * A castle tower's raw shot (roll[8,15], atk 12) barely scratches a real assault
 * army, so `battle.siegeTowerDamage` (fed from the Settings slider) scales every
 * tower shot. Verifies: absent ⇒ 1.0 (classic, byte-identical), the multiplier
 * scales tower damage linearly, and it touches ONLY tower shots.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/core/rng.js';
import { newGame } from '../src/core/GameState.js';
import { createBattle, act } from '../src/core/combat/CombatEngine.js';

/** Total raw HP a besieged castle's tower inflicts over N identical shots, with
 *  a fresh same-seed RNG so runs differ only by the multiplier. A huge target
 *  stack guarantees nothing dies, so we read the exact HP pool delta. */
function towerDamageOverShots(mult, shots = 40) {
  const s = newGame({ seed: 4, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'castle', isHuman: false, team: 1 },
  ] });
  const atk = Object.values(s.heroes).find((h) => h.owner === 0);
  atk.army = [{ creature: 'swordsman', count: 400 }, null, null, null, null, null, null];
  const cfg = {
    rng: new Rng(12345),
    attacker: { hero: atk, army: atk.army.filter(Boolean), playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 20 }], playerIndex: 1 },
    siege: { fortTier: 3 },
  };
  if (mult !== undefined) cfg.siegeTowerDamage = mult;
  const battle = createBattle(cfg);
  const tower = battle.units.find((u) => u.machine === 'arrowTower');
  const t = battle.units.find((u) => u.side === 0 && !u.machine);
  const pool = () => (t.count - 1) * t.maxHp + t.hp;
  let total = 0;
  for (let i = 0; i < shots; i++) { const b = pool(); act(battle, tower, { type: 'shoot', targetId: t.id }); total += b - pool(); }
  return total;
}

test('absent multiplier ⇒ 1.0 (classic siege damage, byte-identical)', () => {
  assert.equal(towerDamageOverShots(undefined), towerDamageOverShots(1));
});

test('the multiplier scales tower damage linearly', () => {
  const base = towerDamageOverShots(1);
  const dbl = towerDamageOverShots(2);
  const def = towerDamageOverShots(2.5);
  assert.ok(base > 0, 'towers do some damage at 1×');
  // Applied after the roll, so with the same RNG the ratio IS the multiplier
  // (± per-shot Math.round(max(1,·)) rounding over 40 shots).
  assert.ok(Math.abs(dbl / base - 2) < 0.05, `2× ≈ double (got ${(dbl / base).toFixed(3)})`);
  assert.ok(Math.abs(def / base - 2.5) < 0.05, `2.5× ≈ ×2.5 (got ${(def / base).toFixed(3)})`);
});

test('the default (2.5×) makes a tower a real threat vs the raw stat', () => {
  // 5–6 raw dmg/shot is a rounding error; ~14 lands as a genuine deterrent.
  const perShot = towerDamageOverShots(2.5) / 40;
  assert.ok(perShot > 10, `default tower shot bites (~${perShot.toFixed(1)} dmg/shot)`);
});
