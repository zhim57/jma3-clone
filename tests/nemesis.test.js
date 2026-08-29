/**
 * nemesis.test.js — the Nemesis heroes feature.
 *
 * When an enemy hero defeats one of yours it's branded your NEMESIS: it fights
 * your heroes with an escalating attack+defense edge, carries a title named for
 * its victim, and drops a bounty (bonus XP + a guaranteed artifact) to whoever
 * finally takes it down. Reuses the hero pool (identity across defeats), the
 * data-driven stat model, and the existing combat-result path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { combatContext, applyCombatResult } from '../src/core/actions.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';

const HUMAN = 0;
const AI = 1;
const stack = (creature, count) => [{ creature, count, hurt: 0 }, null, null, null, null, null, null];

function twoHeroesFighting(seed, { attackerArmy, defenderArmy, defenderPrep }) {
  const s = newGame({ seed, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const ai = playerHeroes(s, AI)[0];       // attacker (player 1)
  const human = playerHeroes(s, HUMAN)[0]; // defender (player 0)
  ai.army = attackerArmy;
  human.army = defenderArmy;
  defenderPrep?.(human, ai, s);
  const ctx = combatContext(s, ai, { kind: 'hero', heroId: human.id });
  const battle = createBattle({
    rng: new Rng(1),
    attacker: { hero: ai, army: ai.army, playerIndex: ai.owner },
    defender: { hero: human, army: ctx.defenderArmy, playerIndex: human.owner },
  });
  const result = autoResolve(battle);
  const events = applyCombatResult(s, ctx, result);
  return { s, ai, human, result, events };
}

test('an enemy hero that slays yours is branded your nemesis, titled for its victim', () => {
  const { ai, human, result } = twoHeroesFighting(7, {
    attackerArmy: stack('archangel', 50),
    defenderArmy: stack('peasant', 20),
  });
  assert.equal(result.attackerWon, true, 'the strong attacker wins');
  assert.equal(ai.nemesisOf[HUMAN], 1, 'it remembers slaying a hero of player 0');
  assert.equal(ai.nemesisTitle, `Bane of ${human.name}`, 'and takes a title named for its victim');
});

test('nemesis battle edge: it fights its victim with +attack/+defense, capped, and no one else', () => {
  const s = newGame({ seed: 8, players: [
    { faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const villain = playerHeroes(s, AI)[0];
  villain.stats.attack = 5; villain.stats.defense = 4;
  villain.nemesisOf = { [HUMAN]: 2 }; // has slain two of player 0's heroes

  const build = (foePlayerIndex) => createBattle({
    rng: new Rng(1),
    attacker: { hero: villain, army: stack('pikeman', 10), playerIndex: AI },
    defender: { army: stack('peasant', 10), playerIndex: foePlayerIndex },
  }).sides[0];

  const edge = Math.min(CONFIG.NEMESIS.EDGE_CAP, 2 * CONFIG.NEMESIS.EDGE_PER_KILL);
  const vsVictim = build(HUMAN);
  assert.equal(vsVictim.attackBonus, 5 + edge, 'attack edge vs its victim');
  assert.equal(vsVictim.defenseBonusHero, 4 + edge, 'defense edge vs its victim');

  const vsOther = build(2); // a different player it has never fought
  assert.equal(vsOther.attackBonus, 5, 'no edge against anyone else');
  assert.equal(vsOther.defenseBonusHero, 4, 'no edge against anyone else');
});

test('nemesis battle edge is capped no matter how many it has slain', () => {
  const s = newGame({ seed: 9 });
  const villain = playerHeroes(s, AI)[0];
  villain.stats.attack = 0;
  villain.nemesisOf = { [HUMAN]: 99 };
  const side = createBattle({
    rng: new Rng(1),
    attacker: { hero: villain, army: stack('pikeman', 10), playerIndex: AI },
    defender: { army: stack('peasant', 10), playerIndex: HUMAN },
  }).sides[0];
  assert.equal(side.attackBonus, CONFIG.NEMESIS.EDGE_CAP, 'the edge tops out at EDGE_CAP');
});

test('bounty: putting down your nemesis pays bonus XP + a guaranteed artifact', () => {
  // The player-0 hero is the attacker here (it hunts down the AI nemesis).
  const s = newGame({ seed: 10, players: [
    { faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const hunter = playerHeroes(s, HUMAN)[0];     // attacker (player 0)
  const nemesis = playerHeroes(s, AI)[0];       // defender (player 1) — a nemesis of player 0
  hunter.army = stack('archangel', 50);
  nemesis.army = stack('peasant', 20);
  nemesis.nemesisOf = { [HUMAN]: 2 };           // it had slain two of the hunter's heroes
  const xpBefore = hunter.xp || 0;
  const artsBefore = Object.keys(hunter.equipment).length + hunter.backpack.length;

  const ctx = combatContext(s, hunter, { kind: 'hero', heroId: nemesis.id });
  const battle = createBattle({
    rng: new Rng(2),
    attacker: { hero: hunter, army: hunter.army, playerIndex: hunter.owner },
    defender: { hero: nemesis, army: ctx.defenderArmy, playerIndex: nemesis.owner },
  });
  const result = autoResolve(battle);
  const events = applyCombatResult(s, ctx, result);

  assert.equal(result.attackerWon, true, 'the hunter wins');
  const bounty = events.find((e) => e.type === 'nemesisBounty');
  assert.ok(bounty, 'a nemesis bounty is awarded');
  assert.equal(bounty.xp, 2 * CONFIG.NEMESIS.BOUNTY_XP, 'XP scales with the kills it owed');
  assert.ok((hunter.xp || 0) >= xpBefore + bounty.xp, 'the hunter actually gained the bounty XP');
  assert.ok(Object.keys(hunter.equipment).length + hunter.backpack.length > artsBefore,
    'and a guaranteed artifact');
});

test('a slain ALLY brands no nemesis (enemies only)', () => {
  const s = newGame({ seed: 11, players: [
    { faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 0 },
  ] });
  // Both players share team 0 — even if one somehow beats the other, no brand.
  const a = playerHeroes(s, 0)[0];
  const b = playerHeroes(s, 1)[0];
  a.army = stack('archangel', 50); b.army = stack('peasant', 20);
  const ctx = combatContext(s, a, { kind: 'hero', heroId: b.id });
  const battle = createBattle({ rng: new Rng(1),
    attacker: { hero: a, army: a.army, playerIndex: a.owner },
    defender: { hero: b, army: ctx.defenderArmy, playerIndex: b.owner } });
  applyCombatResult(s, ctx, autoResolve(battle));
  assert.ok(!a.nemesisOf || !a.nemesisOf[b.owner], 'no nemesis brand between allies');
});

test('the nemesis brand + title round-trip a save', () => {
  const { s, ai } = twoHeroesFighting(12, {
    attackerArmy: stack('archangel', 50), defenderArmy: stack('peasant', 20),
  });
  assert.ok(ai.nemesisOf[HUMAN] >= 1);
  const restored = deserialize(serialize(s));
  const villain = restored.heroes[ai.id];
  assert.equal(villain.nemesisOf[HUMAN], ai.nemesisOf[HUMAN], 'nemesisOf survives serialization');
  assert.equal(villain.nemesisTitle, ai.nemesisTitle, 'the title survives too');
});
