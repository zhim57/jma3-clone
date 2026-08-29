/**
 * pool-surplus.test.js — over-cap pools survive equipment changes (audit C9).
 *
 * The engine deliberately pushes pools ABOVE their derived caps: the Magic
 * Spring fills mana to MAGIC_SPRING_MULT × max, a Wayfarer's Camp adds
 * MOVE_BOOST movement, Stables add STABLES_MOVE_BONUS — and advanceDay's regen
 * goes out of its way never to reduce a standing surplus (its own comment says
 * a plain min() clamp once wiped it at the very next dawn). syncHeroPools is
 * the other place a pool gets recomputed, on every artifact touch, and it had
 * the same disease in a subtler form: it applied the cap delta and then
 * clamped to [0, newCap], which degenerates to min(cap, pool) whenever the
 * artifact does not move the relevant cap — so picking up ANY artifact
 * confiscated the site's payout, and even an equip/unequip cycle with a
 * surplus standing was a one-way ratchet down to the cap.
 *
 * The rule now: apply the SIGNED cap delta, floor at 0, and leave a pool alone
 * when its cap did not move. The anti-farming property the clamp was defending
 * is pinned below: equip-then-unequip nets exactly zero, surplus or not,
 * because the two deltas cancel by construction.
 *
 * The older suites never caught this because they reset pools to exactly the
 * cap before acting (tests/core.test.js) — these start over-cap on purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { giveArtifact, unequipArtifact, giveArtifactToHero } from '../src/core/actions.js';
import { heroMaxMana, heroMaxMovement } from '../src/core/heroUtils.js';
import { CONFIG } from '../src/config.js';

/** A hero with both pools over cap — spring mana, camp movement. */
function overfilled() {
  const s = newGame({ seed: 11 });
  const hero = playerHeroes(s, 0)[0];
  hero.equipment = {}; hero.backpack = [];
  hero.mana = heroMaxMana(hero) * CONFIG.MAGIC_SPRING_MULT;
  hero.mp = heroMaxMovement(hero) + CONFIG.MOVE_BOOST;
  return { s, hero };
}

test('an artifact that moves neither cap leaves both surpluses untouched', () => {
  const { s, hero } = overfilled();
  const { mp, mana } = hero;
  giveArtifact(s, hero, 'centaurAxe'); // attack only — neither cap moves
  assert.equal(hero.mp, mp, 'the camp movement bonus survives the pickup');
  assert.equal(hero.mana, mana, 'the spring over-fill survives the pickup');
});

test('a cap-raising artifact rides the surplus on top; removal takes back exactly its delta', () => {
  const { s, hero } = overfilled();
  const mp0 = hero.mp;
  const cap0 = heroMaxMovement(hero);
  const socket = giveArtifact(s, hero, 'sevenLeagueBoots');
  assert.ok(socket, 'the boots equipped');
  const delta = heroMaxMovement(hero) - cap0;
  assert.ok(delta > 0, 'the boots raise the movement cap');
  assert.equal(hero.mp, mp0 + delta, 'equipping helps today, ON TOP of the surplus');
  unequipArtifact(s, hero, socket);
  assert.equal(hero.mp, mp0,
    'unequipping gives back exactly what equipping took — net zero, nothing farmed, surplus intact');
});

test('with the pool AT cap the delta arithmetic matches the old behaviour', () => {
  // The case the old clamp was written for must be byte-identical: no surplus,
  // equip raises pool by the cap delta, unequip lowers it back, floor at 0.
  const s = newGame({ seed: 11 });
  const hero = playerHeroes(s, 0)[0];
  hero.equipment = {}; hero.backpack = [];
  hero.mp = heroMaxMovement(hero);
  const cap0 = heroMaxMovement(hero);
  const socket = giveArtifact(s, hero, 'sevenLeagueBoots');
  const delta = heroMaxMovement(hero) - cap0;
  assert.equal(hero.mp, cap0 + delta);
  hero.mp = 10; // nearly spent: removal must floor at 0, never go negative
  unequipArtifact(s, hero, socket);
  assert.equal(hero.mp, Math.max(0, 10 - delta));
});

test('removing a BACKPACK artifact (caps unchanged) is a no-op on the pools', () => {
  // removeArtifactFromHero syncs on backpack removals too; with the
  // delta-of-zero rule that sync is now honestly a no-op instead of a clamp.
  const { s, hero } = overfilled();
  hero.backpack.push('sevenLeagueBoots'); // carried, not worn — no cap effect
  const other = playerHeroes(s, 1)[0];
  const { mp, mana } = hero;
  giveArtifactToHero(s, hero, other, { backpack: hero.backpack.length - 1 });
  assert.equal(hero.mp, mp, 'handing over a carried artifact costs no movement');
  assert.equal(hero.mana, mana, 'and no mana');
});
