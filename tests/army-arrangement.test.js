/**
 * army-arrangement.test.js — the army you packed is the army you get back.
 *
 * Asked for: "the hero stat screen creature arrangement, with the possibility to
 * keep the arrangement — right now after a battle the same-kind stacks combine
 * themselves; I want multiple stacks that do not combine by themselves over time."
 *
 * Splitting one creature across several slots is a real tactic: each stack takes
 * its own turn and soaks its own retaliation. But writeBackArmy used to pack
 * survivors from slot 0, merging every same-creature stack on the way — so three
 * deliberate stacks of archers came home as one, and no arrangement could outlive
 * a single fight.
 *
 * The fix is an ORIGIN on every deployed stack: the slot it marched out of.
 * Survivors return to their own slot, and several units sharing one origin — the
 * pieces of an AI deploy-time split — add back together into that slot. Both
 * behaviours from one rule, instead of one at the cost of the other.
 *
 * Tested through the real engine: build a battle, resolve it, apply the result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../src/config.js';
import { Rng } from '../src/core/rng.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { armyForDeploy, applyCombatResult, combatContext, moveStack, splitStack } from '../src/core/actions.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';

const shape = (army) => army.map((s) => (s && s.count > 0 ? `${s.creature}x${s.count}` : '-')).join(' ');
const slotsOf = (army, creature) => army.filter((s) => s && s.creature === creature && s.count > 0).length;

/** A hero with `parts` separate stacks of one creature, and a weak wild stack to
 *  fight. Returns the state, the hero and the monster object. */
function field({ creature = 'archer', parts = 3, per = 20, foe = 'peasant', foeCount = 2 } = {}) {
  const s = newGame({
    seed: 4711,
    // pveScaling OFF. These tests are about where stacks LIVE in the seven slots, and
    // they use a battle only as the thing that writes an army back. The tide sizer
    // (on by default) sizes a PvE defender to cost the attacker a target share of its
    // army, so "two peasants" becomes whatever it takes to actually hurt 90 archers —
    // and a fixture that means "a trivial fight" stops being one. Leaving it on made
    // these assertions measure combat difficulty instead of slot bookkeeping, which is
    // how they broke when the sizer started buying real bodies.
    pveScaling: false,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  const hero = playerHeroes(s, 0)[0];
  hero.army = new Array(CONFIG.ARMY_SLOTS).fill(null);
  for (let i = 0; i < parts; i++) hero.army[i] = { creature, count: per, hurt: 0 };

  const m = s.map;
  const x = hero.x + 1, y = hero.y;
  const t = m.tiles[y * m.w + x];
  t.obstacle = null; t.terrain = 'grass';
  if (t.objectId) { delete m.objects[t.objectId]; t.objectId = null; }
  const id = `M${m.nextOid++}`;
  m.objects[id] = { id, x, y, type: 'monster', creature: foe, count: foeCount };
  t.objectId = id;
  return { s, hero, monster: m.objects[id] };
}

/** Fight the monster to a finish the way the AI's autoFight does, and apply it. */
function fight(s, hero, monster, { aiStackSplit = false } = {}) {
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: monster.id });
  const battle = createBattle({
    rng: s.rng,
    attacker: { hero, army: armyForDeploy(hero.army), playerIndex: hero.owner },
    defender: { hero: null, army: ctx.defenderArmy, playerIndex: -1 },
    features: s.features,
    humanSide: 0,
    aiStackSplit,
  });
  const result = autoResolve(battle);
  applyCombatResult(s, ctx, result);
  return result;
}

test('armyForDeploy compacts the army but remembers where each stack lived', () => {
  const army = [null, { creature: 'archer', count: 5, hurt: 0 }, null, { creature: 'pikeman', count: 9, hurt: 0 }];
  const out = armyForDeploy(army);
  assert.equal(out.length, 2, 'empty slots are not deployed');
  assert.deepEqual(out.map((s) => s.origin), [1, 3], 'and the real slot indices ride along');
  assert.equal(out[0].creature, 'archer');
  assert.notEqual(out[0], army[1], 'copies, so the battle cannot mutate the stored stack');
});

test('armyForDeploy drops emptied stacks, not just nulls', () => {
  const out = armyForDeploy([{ creature: 'archer', count: 0, hurt: 0 }, { creature: 'archer', count: 3, hurt: 0 }]);
  assert.deepEqual(out.map((s) => s.origin), [1]);
});

test('three deliberate stacks of one creature survive a battle as three', () => {
  const { s, hero, monster } = field({ parts: 3 });
  const before = shape(hero.army);
  const res = fight(s, hero, monster);
  assert.equal(res.attackerWon, true, 'the hero should win this handily');
  assert.equal(slotsOf(hero.army, 'archer'), 3,
    `the arrangement collapsed: ${before} became ${shape(hero.army)}`);
});

test('and they come back in the SAME slots, not merely as three stacks', () => {
  const { s, hero, monster } = field({ parts: 2, per: 15 });
  // Put them at the ends, so a "pack from slot 0" write-back is visibly wrong.
  hero.army = new Array(CONFIG.ARMY_SLOTS).fill(null);
  hero.army[1] = { creature: 'archer', count: 15, hurt: 0 };
  hero.army[5] = { creature: 'archer', count: 15, hurt: 0 };
  fight(s, hero, monster);
  assert.ok(hero.army[1] && hero.army[1].creature === 'archer', 'slot 1 kept its stack');
  assert.ok(hero.army[5] && hero.army[5].creature === 'archer', 'slot 5 kept its stack');
  assert.equal(hero.army[0], null, 'and nothing shuffled down to slot 0');
});

test('the arrangement survives battle after battle, not just the first', () => {
  const { s, hero } = field({ parts: 3, per: 30 });
  const m = s.map;
  for (let i = 0; i < 4; i++) {
    // A beaten guard is removed from the map, so each round needs a fresh one.
    const x = hero.x + 1, y = hero.y;
    const t = m.tiles[y * m.w + x];
    const id = `M${m.nextOid++}`;
    m.objects[id] = { id, x, y, type: 'monster', creature: 'peasant', count: 2 };
    t.objectId = id;
    fight(s, hero, m.objects[id]);
    assert.equal(slotsOf(hero.army, 'archer'), 3, `stacks merged after battle ${i + 1}`);
  }
});

test('a stack wiped out frees its slot and leaves the others where they are', () => {
  const { s, hero, monster } = field({ parts: 3, per: 1 });
  // One archer per stack against something that kills: whoever dies vacates.
  monster.creature = 'griffin';
  monster.count = 8;
  fight(s, hero, monster);
  const alive = hero.army.filter(Boolean).length;
  assert.ok(alive < 3, 'this fight was meant to cost stacks');
  // Whatever lived is still in one of the original three slots, never past them.
  hero.army.forEach((st, i) => {
    if (st) assert.ok(i < 3, `a survivor appeared in slot ${i}, outside where the army started`);
  });
});

test('a lizard ghost survivor does not collapse the rest of the army (origin rides along)', () => {
  // The one survivor path that minted units mid-battle without an origin:
  // spawnGhostRemnants. writeBackArmy's slot-preserving path is all-or-nothing —
  // `list.every(s => Number.isInteger(s.origin))` — so a single origin-less
  // shade used to demote the ENTIRE army to the pack-and-merge fallback:
  // archer/-/-/archer/-/-/lizardman came home as archerx35|lizardGhostx1|-|...,
  // the exact collapse origin was introduced to prevent. The shade now inherits
  // the fallen stack's slot. The ghost is a chance event, so search battle
  // seeds until one rises (the style lizard-ghost.test.js already uses).
  const s = newGame({
    seed: 4711,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    features: { lizardGhosts: true },
  });
  const hero = playerHeroes(s, 0)[0];
  const m = s.map;
  const x = hero.x + 1, y = hero.y;
  const t = m.tiles[y * m.w + x];
  t.obstacle = null; t.terrain = 'grass';
  if (t.objectId) { delete m.objects[t.objectId]; t.objectId = null; }
  const id = `M${m.nextOid++}`;
  m.objects[id] = { id, x, y, type: 'monster', creature: 'hellHound', count: 8 };
  t.objectId = id;

  for (let seed = 1; seed <= 100; seed++) {
    hero.army = new Array(CONFIG.ARMY_SLOTS).fill(null);
    hero.army[0] = { creature: 'archer', count: 20, hurt: 0 };
    hero.army[3] = { creature: 'archer', count: 20, hurt: 0 };
    hero.army[6] = { creature: 'lizardman', count: 1, hurt: 0 }; // one lizard: it WILL die
    const ctx = combatContext(s, hero, { kind: 'monster', objectId: id });
    const battle = createBattle({
      rng: new Rng(seed),
      attacker: { hero, army: armyForDeploy(hero.army), playerIndex: hero.owner },
      defender: { hero: null, army: ctx.defenderArmy, playerIndex: -1 },
      features: s.features,
      humanSide: 0,
    });
    const result = autoResolve(battle);
    const ghost = (result.attackerArmy || []).find((u) => u.creature === CONFIG.GHOST_REMNANT_CREATURE);
    if (!result.attackerWon || !ghost) continue; // no shade this seed — roll again
    assert.equal(ghost.origin, 6, 'the shade carries the fallen stack\'s slot');
    applyCombatResult(s, ctx, result);
    assert.ok(hero.army[0]?.creature === 'archer' && hero.army[3]?.creature === 'archer',
      `the archers kept their slots: ${shape(hero.army)}`);
    assert.equal(slotsOf(hero.army, 'archer'), 2,
      `two deliberate archer stacks came home as two: ${shape(hero.army)}`);
    assert.equal(hero.army[6]?.creature, CONFIG.GHOST_REMNANT_CREATURE,
      'and the shade stands in the slot its lizards marched out of');
    return;
  }
  assert.fail('no shade rose in 100 battle seeds — at 25% per wiped stack that is not chance');
});

test('an AI deploy-time split still re-consolidates instead of fragmenting', () => {
  // The behaviour the merge existed for: splitArmyForDeploy cuts one stack into
  // pieces so a single Blind cannot disable the whole army. Those pieces share an
  // origin, so they add back together into that one slot.
  const { s, hero, monster } = field({ parts: 1, per: 40 });
  fight(s, hero, monster, { aiStackSplit: true });
  assert.equal(slotsOf(hero.army, 'archer'), 1,
    `a deploy split leaked into storage: ${shape(hero.army)}`);
  assert.ok(hero.army[0] && hero.army[0].count > 0, 'and back in its own slot');
});

test('the write-back still works for a battle built without origins', () => {
  // Auto-resolve previews, the AI's own simulations and every engine test build
  // battles straight from a plain army. Those must keep the historical behaviour
  // rather than losing survivors to an undefined slot.
  const { s, hero, monster } = field({ parts: 2, per: 12 });
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: monster.id });
  const battle = createBattle({
    rng: s.rng,
    attacker: { hero, army: hero.army.filter(Boolean), playerIndex: hero.owner }, // no origins
    defender: { hero: null, army: ctx.defenderArmy, playerIndex: -1 },
    features: s.features,
    humanSide: 0,
  });
  const result = autoResolve(battle);
  applyCombatResult(s, ctx, result);
  const total = hero.army.filter(Boolean).reduce((n, st) => n + st.count, 0);
  assert.ok(total > 0, 'the survivors must not vanish');
  assert.equal(slotsOf(hero.army, 'archer'), 1, 'and merge, as they always did');
});

// ---- arranging it in the first place ----------------------------------------

test('moveStack and splitStack are enough to build any arrangement', () => {
  const army = new Array(CONFIG.ARMY_SLOTS).fill(null);
  army[0] = { creature: 'archer', count: 40, hurt: 0 };
  splitStack(army, 0, army, 1);
  assert.equal(shape(army).startsWith('archerx20 archerx20'), true, 'halves into the free slot');
  splitStack(army, 1, army, 2);
  assert.equal(slotsOf(army, 'archer'), 3, 'and again, for three stacks');
  moveStack(army, 2, army, 6);
  assert.equal(army[2], null);
  assert.ok(army[6] && army[6].creature === 'archer', 'and they can be placed anywhere');
});

test('the hero sheet can arrange the army, with the same gestures as the town', () => {
  // Phaser scenes cannot run headlessly, so this is a static guard on the wiring.
  const src = readFileSync(new URL('../src/scenes/HeroScene.js', import.meta.url), 'utf8');
  assert.match(src, /^ {2}onSlotClick\(hero, i\) \{/m,
    'the sheet is the one place a commander in the field can reach their own army');
  const fn = src.slice(src.indexOf('  onSlotClick(hero, i) {'), src.indexOf('  buildAll() {'));
  assert.match(fn, /this\.picked = i;/, 'pick a stack up');
  assert.match(fn, /splitStack\(hero\.army, i, hero\.army, free\)/, 'same slot twice splits');
  assert.match(fn, /moveStack\(hero\.army, this\.picked, hero\.army, i\)/, 'another slot moves');
  assert.match(fn, /this\.buildAll\(\);/, 'and the sheet redraws so the result is visible');
  // The handler is attached OUTSIDE the `if (stack)` branch, so empty slots
  // answer too — you must be able to put a stack down. Asserted on the shape of
  // the wiring rather than on one exact line, because the same handler now also
  // routes the shift-click disband and a literal match broke the moment it did.
  assert.match(src, /cell\.on\('pointerup', \(p\) => \{/, 'every slot answers, empty ones included');
  assert.match(src, /else this\.onSlotClick\(hero, i\);/, 'a plain click still arranges');
  assert.match(src, /if \(p\?\.event\?\.shiftKey\) this\.onSlotDisband\(hero, i\);/,
    'and shift-click dismisses — a separate gesture, because a misclick must never cost an army');
  const dis = src.slice(src.indexOf('  onSlotDisband(hero, i) {'), src.indexOf('  onSlotClick(hero, i) {'));
  assert.match(dis, /showDialog\(/, 'it asks before it destroys');
  assert.match(dis, /disbandStack\(hero\.army, i\)/, 'and the engine owns the last-stack rule');
});
