/**
 * ai-consolidation.test.js — the AI concentrates the army it already has.
 *
 * Measured across six headless campaigns: a third to a half of an AI realm's
 * whole army value sat in town garrisons no hero was standing in, and the
 * reported campaign's day 47 had Red holding 81,840 in the realm against 17,713
 * in its best hero. Under square-law attrition that is most of a realm's
 * strength doing nothing. Nothing here recruits: the troops already exist.
 *
 *   1. Pickup on pass — a hero standing in, or walking past, its own town takes
 *      the garrison, keeping the best seven stacks between them. The old rule
 *      took "whatever fits", so a hero with seven slots of militia walked out of
 *      a town full of angels exactly as strong as it walked in.
 *   2. A consolidation goal — once the realm is worth more than
 *      CONSOLIDATE_TRIGGER times its best hero, that hero goes and fetches the
 *      biggest stock it can actually carry.
 *   3. Merge on meeting — a hero worth under a fifth of an adjacent friend's
 *      army hands its troops over and rides on as a scout.
 *
 * All headless and deterministic (fixed seed, hand-shaped state).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { hireHero, hireableHeroes } from '../src/core/actions.js';
import { armyValue } from '../src/core/heroUtils.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const SEED = 4242;
const AI = 1;

const slots = (...stacks) => {
  const a = stacks.map(([creature, count]) => ({ creature, count, hurt: 0 }));
  while (a.length < 7) a.push(null);
  return a;
};

function setup() {
  const s = newGame({ seed: SEED });
  const ai = new AITurnController(s, AI);
  const hero = playerHeroes(s, AI)[0];
  const town = playerTowns(s, AI)[0];
  hero.inTownId = null;
  town.visitingHeroId = null;
  return { s, ai, hero, town };
}

/** A second hero for this realm, hired through the engine's own tavern path. */
function secondHero(s, town) {
  if (!town.buildings.includes('tavern')) town.buildings.push('tavern');
  town.visitingHeroId = null;
  s.players[AI].resources.gold = 100000;
  const hero = hireHero(s, town, hireableHeroes(s, town)[0]);
  town.visitingHeroId = null;
  hero.inTownId = null;
  return hero;
}

/** Stand the hero one tile off the town's square. */
function beside(hero, town) {
  hero.x = town.x + 1;
  hero.y = town.y;
  hero.z = town.z ?? 0;
  hero.inTownId = null;
}

// ---------------------------------------------------------------------------

test('consolidation: a full army swaps its worst stacks for the garrison\'s best', () => {
  const { ai, hero, town } = setup();
  // Seven slots of militia — under the old rule addToArmy had no free slot and
  // no matching creature, so this hero took nothing at all.
  hero.army = slots(['pikeman', 10], ['archer', 10], ['griffin', 2], ['swordsman', 5],
    ['monk', 3], ['cavalier', 1], ['imp', 20]);
  town.garrison = slots(['angel', 12], ['archangel', 3]);
  const before = armyValue(hero.army) + armyValue(town.garrison);
  beside(hero, town);

  ai.pickupOnPass(hero);

  const after = armyValue(hero.army) + armyValue(town.garrison);
  assert.equal(Math.round(after), Math.round(before), 'no troops are created or lost');
  const carried = hero.army.filter(Boolean).map((st) => st.creature);
  assert.ok(carried.includes('angel') && carried.includes('archangel'),
    'the hero leaves with the best troops on the field');
  assert.ok(armyValue(hero.army) > armyValue(town.garrison),
    'and the town keeps the remainder, not nothing');
  assert.equal(hero.army.filter(Boolean).length, 7, 'still seven slots, differently spent');
});

test('consolidation: pickup on pass reaches a town the hero merely walks past', () => {
  const { ai, hero, town } = setup();
  hero.army = slots(['pikeman', 5]);
  town.garrison = slots(['angel', 10]);
  beside(hero, town);

  ai.pickupOnPass(hero);

  assert.ok(hero.army.some((st) => st && st.creature === 'angel'), 'collected in passing');
  assert.equal(ai.metrics.pickups, 1, 'and counted');
});

test('consolidation: a town another hero holds, or one under threat, is not raided', () => {
  const { s, ai, hero, town } = setup();
  hero.army = slots(['pikeman', 5]);
  town.garrison = slots(['angel', 10]);
  beside(hero, town);
  town.visitingHeroId = 'HOTHER';

  ai.pickupOnPass(hero);
  assert.ok(!hero.army.some((st) => st && st.creature === 'angel'),
    'another hero\'s garrison is its own business');

  town.visitingHeroId = null;
  town.aiThreat = { value: 999999, day: s.day };
  ai.pickupOnPass(hero);
  assert.ok(!hero.army.some((st) => st && st.creature === 'angel'),
    'a threatened town is not stripped by someone walking past');

  // Standing IN it is the turtle case, which the hold rule governs — allowed.
  hero.x = town.x; hero.y = town.y; hero.inTownId = town.id;
  ai.pickupOnPass(hero);
  assert.ok(hero.army.some((st) => st && st.creature === 'angel'),
    'a hero actually defending the town may take the garrison');
});

test('consolidation: the strongest hero is sent for the biggest stock, above the trigger', () => {
  const { s, ai, hero, town } = setup();
  hero.army = slots(['pikeman', 10]);
  hero.inTownId = null;
  ai.mainHeroId = hero.id;
  town.garrison = slots();

  assert.equal(ai.consolidationTarget(hero), null,
    'a realm holding nothing back has nothing to consolidate');

  // Now park several times the hero's value in the town.
  town.garrison = slots(['angel', 30]);
  const target = ai.consolidationTarget(hero);
  assert.ok(target && target.town.id === town.id, 'the biggest stock is the errand');
  assert.ok(target.value > 0, 'priced at what this hero could actually carry');

  // And it reaches goal selection as a top-priority goal.
  const goals = [];
  ai.pickGoal(hero);
  goals.push(...ai._lastGoals);
  const g = goals.find((c) => c.what === 'consolidate');
  assert.ok(g && g.id === town.id, 'the consolidation errand is on the board');
  assert.ok(goals.filter((c) => c.what !== 'consolidate').every((c) => c.score <= g.score),
    'and outranks the ordinary prizes');
  assert.ok(s.day >= 1);
});

test('consolidation: a token hero beside a strong one hands over its troops', () => {
  const { s, ai, hero, town } = setup();
  const other = secondHero(s, town);
  hero.army = slots(['angel', 30]);
  other.army = slots(['pikeman', 4]);
  other.x = hero.x + 1; other.y = hero.y; other.z = hero.z ?? 0;
  const total = armyValue(hero.army) + armyValue(other.army);

  ai.mergeAdjacentHeroes(hero);

  assert.equal(Math.round(armyValue(hero.army) + armyValue(other.army)), Math.round(total),
    'troops are moved, not minted');
  assert.ok(armyValue(other.army) === 0, 'the weaker rides on as a scout');
  assert.ok(hero.army.some((st) => st && st.creature === 'pikeman'), 'the stronger carries them');
  assert.ok(s.heroes[other.id], 'and the scout is still a hero on the map');
  assert.equal(ai.metrics.merges, 1);
});

test('consolidation: two comparable heroes are left alone', () => {
  const { s, ai, hero, town } = setup();
  const other = secondHero(s, town);
  hero.army = slots(['angel', 30]);
  other.army = slots(['angel', 20]); // well over a fifth — two real armies
  other.x = hero.x + 1; other.y = hero.y; other.z = hero.z ?? 0;
  const mine = armyValue(hero.army);

  ai.mergeAdjacentHeroes(hero);

  assert.equal(armyValue(hero.army), mine, 'no merge');
  assert.equal(ai.metrics.merges, 0);
});

test('consolidation: a pickup that changes nothing leaves both armies untouched', () => {
  const { ai, hero, town } = setup();
  // Seven full slots, every one of them worth more than what the town holds —
  // so the right answer is to walk on by.
  hero.army = slots(['angel', 10], ['archangel', 2], ['cavalier', 20], ['monk', 20],
    ['griffin', 20], ['swordsman', 20], ['marksman', 20]);
  town.garrison = slots(['pikeman', 3]);
  beside(hero, town);
  const heroSlots = hero.army.map((st) => (st ? `${st.creature}:${st.count}` : '-'));
  const townSlots = town.garrison.map((st) => (st ? `${st.creature}:${st.count}` : '-'));

  ai.pickupOnPass(hero);

  // Slot ORDER matters (deployment reads it), and this runs on every step a
  // hero takes near one of its towns — so a no-op must really be a no-op.
  assert.deepEqual(hero.army.map((st) => (st ? `${st.creature}:${st.count}` : '-')), heroSlots);
  assert.deepEqual(town.garrison.map((st) => (st ? `${st.creature}:${st.count}` : '-')), townSlots);
  assert.equal(ai.metrics.pickups, 0, 'and nothing is counted as a pickup');
});

test('consolidation: same-creature stacks merge instead of taking a second slot', () => {
  const { ai, hero, town } = setup();
  hero.army = slots(['angel', 5]);
  town.garrison = slots(['angel', 7], ['pikeman', 2]);
  beside(hero, town);

  ai.pickupOnPass(hero);

  const angels = hero.army.filter((st) => st && st.creature === 'angel');
  assert.equal(angels.length, 1, 'one stack, not two');
  assert.equal(angels[0].count, 12, 'and it carries both lots');
  assert.ok(hero.army.some((st) => st && st.creature === 'pikeman'), 'the spare slot took the rest');
});

test('consolidation: a collector does not empty the town the main hero rides for', () => {
  const { s, ai, hero, town } = setup();
  const collector = secondHero(s, town);
  ai.mainHeroId = hero.id;
  hero.army = slots(['pikeman', 10]);
  town.garrison = slots(['angel', 30]);
  town.visitingHeroId = null;

  // The main hero commits to the errand…
  ai.pickGoal(hero);
  assert.equal(hero.aiGoal.type, 'consolidate', 'the errand is committed');

  // …and the collector, passing the same town, leaves the stock alone.
  collector.army = slots(['pikeman', 2]);
  beside(collector, town);
  ai.pickupOnPass(collector);
  assert.ok(!collector.army.some((st) => st && st.creature === 'angel'),
    'the collector walks past');

  // The main hero itself, of course, takes it.
  beside(hero, town);
  ai.pickupOnPass(hero);
  assert.ok(hero.army.some((st) => st && st.creature === 'angel'), 'the errand pays off');
});

test('merge on meeting: a strong hero beside its OWN scout logs nothing (audit S33)', () => {
  // The state mergeAdjacentHeroes itself creates — a commander next to the
  // armyless courier that just handed everything over — used to fall back
  // through the merge every turn: small = 0 skipped no guard (the guard needs
  // BOTH sides empty), consolidateInto moved nothing, and metrics.merges++
  // plus a fresh "hands its command (0 into N)" note ran anyway, ~2 spurious
  // rows per adjacent pair per turn into the bounded aiLog. Gated now on the
  // army value actually gained — not on consolidateInto's return value, which
  // counts only stacks that changed OWNERSHIP and reads 0 for a genuine
  // same-creature transfer (that case is pinned below).
  const { s, ai, hero, town } = setup();
  const scout = secondHero(s, town);
  hero.army = slots(['angel', 30]);
  scout.army = slots(); // the courier state: empty
  scout.x = hero.x + 1; scout.y = hero.y; scout.z = hero.z ?? 0;
  const logBefore = (s.aiLog || []).length;

  for (let i = 0; i < 5; i++) ai.mergeAdjacentHeroes(hero);

  assert.equal(ai.metrics.merges, 0, 'nothing moved, nothing counted');
  assert.equal((s.aiLog || []).length, logBefore, 'and nothing was logged');

  // A genuine same-creature hand-over still counts exactly once.
  scout.army = slots(['angel', 2]);
  ai.mergeAdjacentHeroes(hero);
  assert.equal(ai.metrics.merges, 1, 'the real transfer is the one that counts');
  assert.equal(hero.army[0].count, 32, 'and it actually moved the troops');
  ai.mergeAdjacentHeroes(hero);
  assert.equal(ai.metrics.merges, 1, 'the now-empty scout goes back to costing nothing');
});
