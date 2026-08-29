/**
 * necromancy.test.js — Necromancy: the undead tag (morale immunity) and the
 * raise-skeletons-after-victory mechanic. Engine only, no Phaser. The full
 * Necropolis faction is a separate slice; this tests the mechanic against the
 * undead creatures (the Necropolis skeleton and the neutral mummy).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILLS } from '../src/data/skills.js';
import { CREATURES } from '../src/data/creatures.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { combatContext, applyCombatResult } from '../src/core/actions.js';
import { createBattle, act, beginTurn } from '../src/core/combat/CombatEngine.js';
import { chooseAction } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

function putMonster(state, x, y, creature, count) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, type: 'monster', creature, count };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}
const win = (hero, xp = 500) => ({ attackerWon: true, attackerArmy: hero.army.filter(Boolean).map((s) => ({ ...s })), defenderArmy: [], xp });
const skelCount = (hero) => hero.army.filter(Boolean).filter((s) => s.creature === 'skeleton').reduce((n, s) => n + s.count, 0);

test('the Necromancy skill exists with three levels + undead neutrals are tagged', () => {
  assert.ok(SKILLS.necromancy && SKILLS.necromancy.levels.length === 3, 'Necromancy is a 3-level skill');
  assert.equal(CREATURES.skeleton.undead, true, 'skeletons are undead');
  assert.equal(CREATURES.mummy.undead, true, 'mummies are undead');
  assert.ok(!CREATURES.pikeman.undead, 'living creatures are not undead');
});

test('a necromancer raises skeletons from the mortal dead on a victory', () => {
  const s = newGame({ seed: 21 });
  const hero = playerHeroes(s, 0)[0];
  hero.skills = { ...hero.skills, necromancy: 3 }; // Expert = 30%
  const before = skelCount(hero);
  const mon = putMonster(s, hero.x + 3, hero.y, 'griffin', 20); // a mortal host
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: mon.id });
  const events = applyCombatResult(s, ctx, win(hero));
  const raised = skelCount(hero) - before;
  assert.ok(raised > 0, 'some of the fallen rose as skeletons');
  assert.ok(raised <= 20, 'never more skeletons than creatures slain');
  const ev = events.find((e) => e.type === 'skeletonsRaised');
  assert.ok(ev && ev.count === raised, 'a skeletonsRaised event reports the count');
});

test('more Necromancy raises more skeletons; none without the skill', () => {
  const raiseWith = (level) => {
    const s = newGame({ seed: 22 });
    const hero = playerHeroes(s, 0)[0];
    if (level) hero.skills = { ...hero.skills, necromancy: level };
    const before = skelCount(hero);
    // A low-HP swarm so the skill %, not the "≤ creatures slain" cap, decides.
    const mon = putMonster(s, hero.x + 3, hero.y, 'peasant', 120);
    const ctx = combatContext(s, hero, { kind: 'monster', objectId: mon.id });
    applyCombatResult(s, ctx, win(hero));
    return skelCount(hero) - before;
  };
  assert.equal(raiseWith(0), 0, 'no skill → no raising');
  const basic = raiseWith(1), expert = raiseWith(3);
  assert.ok(basic > 0, 'Basic raises some');
  assert.ok(expert > basic, 'Expert raises strictly more than Basic');
});

test('you cannot reanimate the already-dead (an undead enemy raises nothing)', () => {
  const s = newGame({ seed: 23 });
  const hero = playerHeroes(s, 0)[0];
  hero.skills = { ...hero.skills, necromancy: 3 };
  const before = skelCount(hero);
  const mon = putMonster(s, hero.x + 3, hero.y, 'skeleton', 40); // an undead host
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: mon.id });
  const events = applyCombatResult(s, ctx, win(hero));
  assert.equal(skelCount(hero) - before, 0, 'the undead cannot be raised again');
  assert.ok(!events.some((e) => e.type === 'skeletonsRaised'));
});

// ---- undead morale immunity (combat engine) -------------------------------

function heroWith(skills) {
  return { id: 'H', name: 'Necro', owner: 0, level: 5, stats: { attack: 3, defense: 3, power: 3, knowledge: 3 }, skills, spells: [], mana: 0, army: [], specialty: null };
}
/** Drive a full battle with the AI on both sides, collecting every event. */
function runBattle(battle) {
  const evs = [];
  let guard = 0;
  while (!battle.over && guard++ < 5000) {
    const { unit } = beginTurn(battle);
    if (!unit) break;
    const events = act(battle, unit, chooseAction(battle, unit));
    if (events) evs.push(...events);
  }
  return evs;
}

test('undead are immune to morale — a +morale hero never grants skeletons an extra turn', () => {
  const battle = createBattle({
    rng: new Rng(7),
    attacker: { hero: heroWith({ leadership: 3 }), army: [{ creature: 'skeleton', count: 40 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'peasant', count: 40 }], playerIndex: 1 },
  });
  assert.ok(battle.sides[0].morale > 0, 'the leader DOES raise side morale (so the immunity is doing work)');
  const skelIds = new Set(battle.units.filter((u) => u.side === 0).map((u) => u.id));
  const events = runBattle(battle);
  const skelMorale = events.filter((e) => e.type === 'morale' && skelIds.has(e.unitId));
  assert.equal(skelMorale.length, 0, 'skeletons never roll a lucky extra turn despite the morale bonus');
});
