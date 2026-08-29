/**
 * ai-stack-split.test.js — an AI side's strongest stack is spread across its
 * empty slots at deploy, so one mass-disable (Blind/Paralyze) can't neutralize
 * the whole army. Deploy-only: survivors merge back so storage stays consolidated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/core/rng.js';
import { CONFIG } from '../src/config.js';
import { newGame } from '../src/core/GameState.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';

const S = newGame({ seed: 7, players: [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
] });
const HERO = Object.values(S.heroes)[0];
function battle(extra = {}) {
  return createBattle({
    rng: new Rng(7),
    attacker: { hero: HERO, army: [{ creature: 'angel', count: 30 }], playerIndex: 0 },
    defender: { hero: HERO, army: [{ creature: 'devil', count: 30 }], playerIndex: 1 },
    ...extra,
  });
}
const unitsOf = (b, side, creature) => b.units.filter((u) => u.side === side && u.creature === creature && !u.machine);

test('OFF by default (absent flag) — one unit per stack, byte-identical', () => {
  const b = battle();
  assert.equal(unitsOf(b, 0, 'angel').length, 1);
  assert.equal(unitsOf(b, 1, 'devil').length, 1);
});

test('an AI side (side 1 here, human is side 0) splits its strongest stack', () => {
  const b = battle({ aiStackSplit: true, humanSide: 0 });
  assert.equal(unitsOf(b, 0, 'angel').length, 1, 'the human side is NOT split');
  assert.ok(unitsOf(b, 1, 'devil').length >= 2, 'the AI side is split into several stacks');
});

test('the split conserves the total count exactly', () => {
  const b = battle({ aiStackSplit: true, humanSide: 0 });
  const total = unitsOf(b, 1, 'devil').reduce((n, u) => n + u.count, 0);
  assert.equal(total, 30, 'no creatures lost or duplicated by the split');
});

test('a full 7-slot army has no room to split — left as-is', () => {
  const seven = Array.from({ length: CONFIG.ARMY_SLOTS }, () => ({ creature: 'devil', count: 5 }));
  const b = createBattle({
    rng: new Rng(7),
    attacker: { hero: HERO, army: [{ creature: 'angel', count: 30 }], playerIndex: 0 },
    defender: { hero: HERO, army: seven, playerIndex: 1 },
    aiStackSplit: true, humanSide: 0,
  });
  // Still 7 devil stacks (each slot already taken — nothing to split into).
  assert.equal(unitsOf(b, 1, 'devil').length, CONFIG.ARMY_SLOTS);
});

test('a heroless PvE guardian splits too — by RULE, not by the AI setting', () => {
  // This assertion used to read the other way: "a heroless neutral stack is not
  // split". That pinned the feature's SCOPE rather than a decision — the split was
  // built for the AI's own army, and heroless sides were simply never in it.
  //
  // But the reason the feature exists applies to them exactly as much. The setting's
  // own description calls it "a real exploit — one mass-disable neutralising a
  // 20M-strong army", and a wild stack deploying as one blob is that same exploit
  // with nobody holding the leash: Blind it, kill it unretaliated, repeat. The same
  // one-stack-one-hex shape is also why overkill against a tide-scaled guard was
  // free, since the engine skips retaliation when the target dies and a lone stack
  // can only be struck once per attacker.
  //
  // So it is a RULE (CONFIG.PVE_STACK_SPLIT), not a dial: the AI setting is a
  // statement about how cleverly a commander plays and is the player's to switch
  // off; a guard that cannot be cheesed is a property of the game. Reading it from
  // CONFIG rather than from cfg is also what keeps the PvE sizer honest — it prices
  // a fight by simulating it through this same function, and a simulation that
  // deployed differently from the real battle would price a fight nobody fights.
  const b = createBattle({
    rng: new Rng(7),
    attacker: { hero: HERO, army: [{ creature: 'angel', count: 30 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'devil', count: 30 }], playerIndex: -1 },
    humanSide: 0, // note: NO aiStackSplit — the PvE rule does not consult it
  });
  const stacks = unitsOf(b, 1, 'devil');
  assert.ok(stacks.length > 1, `the guard deployed across ${stacks.length} hexes`);
  assert.equal(stacks.reduce((n, u) => n + u.count, 0), 30, 'and conserves the count exactly');
});

test('…and a caller that needs a known deployment can still say so', () => {
  const b = createBattle({
    rng: new Rng(7),
    attacker: { hero: HERO, army: [{ creature: 'angel', count: 30 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'devil', count: 30 }], playerIndex: -1 },
    humanSide: 0, pveStackSplit: false,
  });
  assert.equal(unitsOf(b, 1, 'devil').length, 1, 'the explicit override wins over the rule');
});
