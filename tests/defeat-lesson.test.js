/**
 * defeat-lesson.test.js — a beaten hero learns from the battle it lost.
 *
 * Losing already costs a hero its army and its artifacts. Before this it also
 * erased the fight from the hero's own history, which made the hardest battles in
 * the game — the ones a player actually learns from — the only ones that paid no
 * experience at all.
 *
 * The lesson is denominated in what the loser DESTROYED, never in what it faced.
 * That is what keeps it honest: it cannot be farmed by throwing fights, because
 * winning the same battle always pays more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { combatContext, applyCombatResult, pooledHero } from '../src/core/actions.js';
import { createBattle, battleResult } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';

const HUMAN = 0;
const AI = 1;
const stack = (creature, count) => [{ creature, count, hurt: 0 }, null, null, null, null, null, null];

/** The AI attacks the human. Returns everything the assertions need. */
function fight(seed, attackerArmy, defenderArmy) {
  const s = newGame({ seed, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const ai = playerHeroes(s, AI)[0];
  const human = playerHeroes(s, HUMAN)[0];
  ai.army = attackerArmy;
  human.army = defenderArmy;
  const beforeXp = human.xp || 0;
  const ctx = combatContext(s, ai, { kind: 'hero', heroId: human.id });
  const battle = createBattle({
    rng: new Rng(1),
    attacker: { hero: ai, army: ai.army, playerIndex: ai.owner },
    defender: { hero: human, army: ctx.defenderArmy, playerIndex: human.owner },
  });
  const result = autoResolve(battle);
  const events = applyCombatResult(s, ctx, result);
  return { s, ai, human, result, events, beforeXp };
}

// ── the quantity itself ─────────────────────────────────────────────────────

test('a rout teaches the loser nothing — destroy nothing, learn nothing', () => {
  const b = createBattle({
    rng: new Rng(9), terrain: 'grass', simulated: true,
    attacker: { hero: null, army: [{ creature: 'angel', count: 60 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 5 }], playerIndex: 1 },
  });
  autoResolve(b);
  const r = battleResult(b);
  assert.equal(r.flawless, true, 'fixture: the winner lost not one creature');
  assert.equal(r.defeatXp, 0, 'and so the loser took away nothing');
});

test('a close defeat teaches a great deal — but never more than winning it would', () => {
  const b = createBattle({
    rng: new Rng(9), terrain: 'grass', simulated: true,
    attacker: { hero: null, army: [{ creature: 'swordsman', count: 60 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 95 }], playerIndex: 1 },
  });
  autoResolve(b);
  const r = battleResult(b);
  assert.ok(r.defeatXp > 0, `the loser bloodied the winner and learned from it (${r.defeatXp})`);
  // THE PROPERTY THAT MAKES THIS SAFE. A victory pays the enemy's whole army,
  // because the enemy was annihilated; a defeat pays a share of the part of the
  // victor you took with you. Losing on purpose can therefore never out-earn
  // winning the same fight.
  assert.ok(r.defeatXp < r.xp,
    `losing (${r.defeatXp}) is worth less than winning the same battle (${r.xp})`);
});

test('the lesson is a share of what the loser destroyed, not of what it faced', () => {
  const b = createBattle({
    rng: new Rng(4), terrain: 'grass', simulated: true,
    attacker: { hero: null, army: [{ creature: 'swordsman', count: 60 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 95 }], playerIndex: 1 },
  });
  autoResolve(b);
  const r = battleResult(b);
  const winnerSide = b.winner;
  assert.equal(r.defeatXp, Math.round(b.valueLost[winnerSide] * CONFIG.DEFEAT_XP_SHARE),
    'exactly the mirror of the winner XP line');
});

// ── it reaches the hero ─────────────────────────────────────────────────────

test('the beaten hero actually banks the experience, and carries it into the pool', () => {
  const { human, result, events, s } = fight(3,
    stack('swordsman', 60), stack('pikeman', 95));
  assert.equal(result.attackerWon, true, 'fixture: the defender lost');
  assert.ok(result.defeatXp > 0, 'fixture: it was not a rout');

  const lesson = events.find((e) => e.type === 'defeatLesson');
  assert.ok(lesson, 'the defeat is reported as a lesson');
  assert.equal(lesson.heroId, human.id);
  assert.equal(lesson.xp, result.defeatXp);

  // A defeated hero is retired to its owner's pool, keeping level and XP — so the
  // lesson has to be readable THERE, not on a hero that no longer exists.
  const pooled = pooledHero(s, HUMAN, human.rosterId);
  assert.ok(pooled, 'the beaten hero waits in the pool');
  assert.ok((pooled.xp || 0) >= result.defeatXp,
    `and it took the lesson with it (${pooled.xp} >= ${result.defeatXp})`);
});

test('a beaten ATTACKER learns too — the rule is about losing, not about which side', () => {
  const { ai, result, events } = fight(11, stack('peasant', 12), stack('archangel', 40));
  assert.equal(result.attackerWon, false, 'fixture: the attacker lost');
  const lesson = events.find((e) => e.type === 'defeatLesson');
  if (result.defeatXp > 0) {
    assert.ok(lesson, 'the fallen attacker is taught as readily as a fallen defender');
    assert.equal(lesson.heroId, ai.id);
  } else {
    assert.equal(lesson, undefined, 'it was a rout, so there was nothing to learn');
  }
});

test('the winner is unaffected — this adds a loser path, it does not move the win', () => {
  const b = createBattle({
    rng: new Rng(9), terrain: 'grass', simulated: true,
    attacker: { hero: null, army: [{ creature: 'swordsman', count: 60 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 95 }], playerIndex: 1 },
  });
  autoResolve(b);
  const r = battleResult(b);
  const winnerSide = b.winner;
  const baseline = b.valueLost[winnerSide === 0 ? 1 : 0];
  assert.equal(r.baseXp, baseline, 'victory XP is still the value the winner destroyed');
});

test('the dial can turn the lesson off entirely', () => {
  const saved = CONFIG.DEFEAT_XP_SHARE;
  try {
    CONFIG.DEFEAT_XP_SHARE = 0;
    const b = createBattle({
      rng: new Rng(9), terrain: 'grass', simulated: true,
      attacker: { hero: null, army: [{ creature: 'swordsman', count: 60 }], playerIndex: 0 },
      defender: { hero: null, army: [{ creature: 'pikeman', count: 95 }], playerIndex: 1 },
    });
    autoResolve(b);
    assert.equal(battleResult(b).defeatXp, 0);
  } finally {
    CONFIG.DEFEAT_XP_SHARE = saved;
  }
});
