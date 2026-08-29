/**
 * tactics-stall.test.js — the Tactics phase is a wait, not a freeze.
 *
 * Reported as "attacking a Pandora's Box or a Griffin Conservatory takes several
 * seconds before proceeding", and confirmed from the player's own console:
 *
 *     [combat] START build … defender=pandora obj=O789
 *     [combat] progression stalled — force-advancing the turn loop
 *     [combat] battle over — opening recap
 *
 * CombatScene's watchdog force-advances the turn loop after STUCK_MS of no
 * progress, suppressed while `awaitingHumanInput()` is true. That function needs
 * an ACTIVE UNIT — and the Tactics placement phase runs before the turn loop
 * starts, so there is none. Four seconds after the battlefield appeared, the
 * watchdog called the phase a freeze, tore it down and took the turn.
 *
 * The delay was the smaller half of it. A hero with Tactics ALWAYS wins the phase
 * against a leaderless defender, because the reach is the DIFFERENCE of the two
 * heroes' skill and a pandora's guards, a bank's guards and a wild stack have no
 * hero at all — so a secondary skill the player spent a level-up on destroyed
 * itself four seconds in, on every PvE fight in the game.
 *
 * Two halves, tested separately: the engine's rule for who wins the phase (why it
 * is every such fight), and the scene's rule for what counts as waiting (why it
 * was torn down). The live proof — sitting still through the phase and coming out
 * the other side with it intact — is tests/smoke/tactics-stall-smoke.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createBattle } from '../src/core/combat/CombatEngine.js';
import { Rng } from '../src/core/rng.js';

const COMBAT = readFileSync(fileURLToPath(new URL('../src/scenes/CombatScene.js', import.meta.url)), 'utf8');
const method = (name) => {
  const at = COMBAT.indexOf(`\n  ${name}(`);
  assert.notEqual(at, -1, `${name} not found`);
  return COMBAT.slice(at, COMBAT.indexOf('\n  }\n', at));
};

const hero = (skills = {}) => ({
  id: 'H1', name: 'Test', level: 10, owner: 0, skills,
  stats: { attack: 8, defense: 6, power: 5, knowledge: 5 }, mana: 20, spells: [],
  army: [{ creature: 'pikeman', count: 40, hurt: 0 }, null, null, null, null, null, null],
  equipment: {}, warMachines: {},
});
const battleAgainstGuards = (attackerHero) => createBattle({
  rng: new Rng(4), terrain: 'grass',
  attacker: { hero: attackerHero, army: [{ creature: 'pikeman', count: 40, hurt: 0 }], playerIndex: 0 },
  // A pandora's guards, a bank's guards and a wild stack are all this: an army
  // with NOBODY commanding it.
  defender: { hero: null, army: [{ creature: 'archer', count: 20, hurt: 0 }], playerIndex: -1 },
  humanSide: 0,
});

// ---------------------------------------------------------------------------
// Why it was every PvE fight
// ---------------------------------------------------------------------------

test('a hero with Tactics always wins the phase against a leaderless defender', () => {
  const b = battleAgainstGuards(hero({ tactics: 2 }));
  assert.ok(b.tactics, 'the phase happens');
  assert.equal(b.tactics.side, 0, 'and it is the human\'s');
  assert.ok(b.tactics.reach > 0);
  assert.equal(b.tactics.done, false, 'open, waiting for placements');
});

test('…and without the skill there is no phase at all — which is why it looked intermittent', () => {
  const b = battleAgainstGuards(hero({}));
  assert.equal(b.tactics, null,
    'equal Tactics cancels out, so a hero without it never enters the phase and never stalled');
});

// ---------------------------------------------------------------------------
// Why it was torn down
// ---------------------------------------------------------------------------

test('the placement phase counts as waiting for the human', () => {
  const body = method('awaitingHumanInput');
  assert.match(body, /if \(this\.tacticsMode\) return !worldClicksBlocked\(\);/,
    'tacticsMode is a wait — it is what the phase IS');
  // Before the activeUnit test, which is the one that could not see it.
  assert.ok(body.indexOf('this.tacticsMode') < body.indexOf('this.humanTurn()'));
});

test('and it is a wait only while the player can actually reach the field', () => {
  // The function's own warning: a state that looks like waiting and cannot take a
  // click is a permanent freeze with nothing logged. So the tactics branch carries
  // the same guard as the rest — a modal leaking over the phase is still a stall,
  // and update() still recovers that by clearing the gate rather than taking the turn.
  const body = method('awaitingHumanInput');
  const branch = body.slice(body.indexOf('this.tacticsMode'));
  assert.match(branch.split('\n')[0], /!worldClicksBlocked\(\)/);
  assert.match(COMBAT, /console\.warn\('\[combat\] input gate stuck shut/,
    'the leaked-modal recovery is still there');
});

test('acting during the phase marks progress, so the loop cannot be called stuck', () => {
  // Belt and braces: even if the guard above were ever narrowed again, a player
  // placing stacks keeps the watchdog quiet.
  assert.match(method('cycleTacticsSelection'), /this\.markProgress\(\)/);
  const click = COMBAT.slice(COMBAT.indexOf('// Pre-battle Tactics placement intercepts clicks'));
  assert.match(click.slice(0, 400), /this\.markProgress\(\)/);
});

test('the watchdog still exists, and still force-advances a real stall', () => {
  // The fix must not have quietened the thing that catches genuine soft-locks.
  assert.match(COMBAT, /const STUCK_MS = \d+;/);
  assert.match(method('update'), /progression stalled — force-advancing the turn loop/);
});

test('a recovery during the phase closes it, instead of leaving it live over the battle', () => {
  // `tacticsMode` is what onPointerDown routes clicks by, so a force-advance that
  // left it set sent every order the player gave to the placement handler for the
  // rest of the fight. Unreachable now that the phase counts as a wait — which is
  // the reason to close it off: nothing else would ever have found it.
  const body = method('recoverFromStall');
  assert.match(body, /if \(this\.tacticsMode\) \{ this\.finishTactics\(\); return; \}/);
  assert.ok(body.indexOf('this.tacticsMode') < body.indexOf('this.nextTurn()'),
    'and closes it BEFORE taking a turn, since finishTactics takes that turn itself');
  assert.match(method('finishTactics'), /this\.tacticsMode = false/);
  assert.match(method('finishTactics'), /this\.nextTurn\(\)/);
});
