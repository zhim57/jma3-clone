/**
 * ai-concentration.test.js — "together we could take that".
 *
 * The player asked for two converging heroes to be able to lend an army to each other.
 * The premise needed correcting first: `consider` vetoes any goal whose guard beats the
 * hero's own army (the guard gate in pickGoal), so a hero NEVER commits to a fight it
 * cannot win alone — and therefore two heroes never converge on one. Such a target is
 * not contested between them, it is INVISIBLE TO BOTH, and no amount of goal
 * deconfliction can reveal it. Concentrating the two armies is the only way a realm can
 * express the thought at all.
 *
 * So `mergeAdjacentHeroes` keeps its ordinary rule — a token army (under MERGE_SHARE)
 * folds into a real one — and gains one exception: two COMPARABLE heroes merge when
 * there is a SPECIFIC fight beside them that neither can take alone and both together
 * can. A policy ("always mass up") would dismantle the collector economy, which is real
 * income; a named target cannot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns, createHero } from '../src/core/GameState.js';
import { HERO_ROSTER } from '../src/data/heroes.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { armyValue } from '../src/core/heroUtils.js';

const AI = 1;

/** Two comparable heroes of `count` crusaders each, standing side by side. */
function twoHeroes(s, at, count) {
  const heroes = playerHeroes(s, AI);
  while (heroes.length < 2) {
    const h = createHero(s, Object.keys(HERO_ROSTER)[heroes.length], AI, at.x, at.y);
    if (!h) break;
    heroes.push(h);
  }
  const spots = [{ x: at.x, y: at.y }, { x: at.x + 1, y: at.y }];
  heroes.slice(0, 2).forEach((h, i) => {
    h.army = [{ creature: 'crusader', count, hurt: 0 }];
    h.inTownId = null; h.aiGoal = null;
    h.x = spots[i].x; h.y = spots[i].y;
  });
  return heroes.slice(0, 2);
}

/**
 * A rival town in range whose DEFENCE — not its garrison — is worth `value`.
 *
 * townDefenseValue multiplies the garrison by the town's wall factor, so sizing the
 * garrison directly overshoots: a first draft asked for 1.4x a hero, the walls doubled
 * it, and the fight was correctly judged unwinnable. Solve for the count instead.
 */
function rivalTown(s, ai, from, value) {
  // SAME LEVEL. A first draft forgot this and picked a subterranean town ten tiles
  // away in map coordinates — correctly refused by the level check, and it looked
  // exactly like the rule failing.
  const sameLevel = (t) => (t.z ?? 0) === (from.z ?? 0);
  let town = Object.values(s.towns).find((t) => t.owner !== AI && sameLevel(t)
    && Math.hypot(t.x - from.x, t.y - from.y) <= 13);
  // Not every seed puts a rival town within reach. MOVE one rather than skip: a test
  // that quietly returns when its setup fails is a test that proves nothing, and this
  // file already had three of them.
  if (!town) {
    town = Object.values(s.towns).find((t) => t.owner !== AI && sameLevel(t))
      || Object.values(s.towns).find((t) => t.owner !== AI);
    if (!town) return null;
    town.z = from.z ?? 0;
    const spot = [[8, 0], [-8, 0], [0, 8], [0, -8], [6, 6]]
      .map(([dx, dy]) => ({ x: from.x + dx, y: from.y + dy }))
      .find((q) => {
        const t = s.map.tiles[q.y * s.map.w + q.x];
        return t && !t.obstacle && t.terrain !== 'water';
      });
    if (!spot) return null;
    town.x = spot.x; town.y = spot.y;
  }
  town.owner = 0;
  town.visitingHeroId = null;
  const probe = 100;
  town.garrison = [null, null, null, null, null, null, null];
  town.garrison[0] = { creature: 'swordsman', count: probe, hurt: 0 };
  const perUnit = ai.townDefenseValue(town) / probe;
  town.garrison[0] = { creature: 'swordsman', count: Math.max(1, Math.round(value / perUnit)), hurt: 0 };
  return town;
}

test('two comparable heroes merge for a fight neither can take alone', () => {
  const s = newGame({
    seed: 5501, mapW: 72, mapH: 60,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  const home = playerTowns(s, AI)[0];
  const [a, b] = twoHeroes(s, { x: home.x, y: home.y + 2 }, 40);
  assert.ok(a && b, 'this test needs two heroes');
  const each = armyValue(a.army);

  // A rival town whose DEFENCE is 1.2x ONE hero: out of reach for either alone, inside
  // reach for the two together. 1.2 rather than a rounder number because the gate
  // compares against `guard * courage`, and courage runs high in the opening days — at
  // 1.4x the window closes once courage passes 1.43 and the test fails for arithmetic
  // reasons that have nothing to do with the rule.
  const ai = new AITurnController(s, AI);
  const town = rivalTown(s, ai, a, each * 1.2);
  assert.ok(town, 'this seed must have a rival town in range, or the test proves nothing');
  const why = ai.worthConcentratingFor(a, b);
  assert.ok(why, `a town whose defence is ${Math.round(ai.townDefenseValue(town))} beside two ${Math.round(each)} heroes should be worth massing for`);

  ai.mergeAdjacentHeroes(a);
  const after = [armyValue(a.army), armyValue(b.army)].sort((x, y) => y - x);
  assert.ok(after[0] > each * 1.8, `the armies did not combine: ${after.join(' / ')}`);
  assert.ok(after[1] < each * 0.05, 'and the donor rides on as a scout');
});

test('comparable heroes do NOT merge when there is nothing to mass for', () => {
  // The collector economy is real income. Massing on principle would dismantle it, so
  // the exception has to be a NAMED target and nothing weaker.
  const s = newGame({
    seed: 5502, mapW: 72, mapH: 60,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  const home = playerTowns(s, AI)[0];
  const [a, b] = twoHeroes(s, { x: home.x, y: home.y + 2 }, 40);
  const each = armyValue(a.army);
  // Every rival town within reach is left EMPTY, and no band is ashore, so nothing
  // nearby needs two heroes.
  for (const t of Object.values(s.towns)) {
    if (t.owner === AI) continue;
    t.garrison = [null, null, null, null, null, null, null];
    t.visitingHeroId = null;
  }
  for (const h of Object.values(s.heroes)) if (h.owner !== AI) h.army = [{ creature: 'peasant', count: 1, hurt: 0 }];
  for (const o of Object.values(s.map.objects)) if (o.type === 'creatureBank') o.looted = true;

  const ai = new AITurnController(s, AI);
  assert.equal(ai.worthConcentratingFor(a, b), null, 'nothing here needs two heroes');
  ai.mergeAdjacentHeroes(a);
  assert.ok(armyValue(a.army) > each * 0.9 && armyValue(b.army) > each * 0.9,
    'two collectors with nothing to fight should still be two collectors');
});

test('a target one hero can already take is not a reason to mass', () => {
  // "Neither alone, both together" — both halves matter. Massing for something one
  // hero could already handle just parks a second army where it earns nothing.
  const s = newGame({
    seed: 5503, mapW: 72, mapH: 60,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  const home = playerTowns(s, AI)[0];
  const [a, b] = twoHeroes(s, { x: home.x, y: home.y + 2 }, 40);
  const each = armyValue(a.army);
  for (const o of Object.values(s.map.objects)) if (o.type === 'creatureBank') o.looted = true;
  for (const h of Object.values(s.heroes)) if (h.owner !== AI) h.army = [{ creature: 'peasant', count: 1, hurt: 0 }];
  for (const t of Object.values(s.towns)) {
    if (t.owner === AI) continue;
    t.garrison = [null, null, null, null, null, null, null];
    t.visitingHeroId = null;
  }
  // A feeble garrison: one hero beats it, so two are not needed.
  const ai = new AITurnController(s, AI);
  const town = rivalTown(s, ai, a, each * 0.1);
  assert.ok(town, 'this seed must have a rival town in range, or the test proves nothing');
  assert.equal(ai.worthConcentratingFor(a, b), null,
    'one hero can already take this; massing buys nothing');
});

test('and an unwinnable fight is not a reason either', () => {
  // The other half of the gate: if the two together STILL cannot take it, merging just
  // hands the enemy one big army instead of two small ones.
  const s = newGame({
    seed: 5504, mapW: 72, mapH: 60,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  const home = playerTowns(s, AI)[0];
  const [a, b] = twoHeroes(s, { x: home.x, y: home.y + 2 }, 40);
  const each = armyValue(a.army);
  for (const o of Object.values(s.map.objects)) if (o.type === 'creatureBank') o.looted = true;
  for (const h of Object.values(s.heroes)) if (h.owner !== AI) h.army = [{ creature: 'peasant', count: 1, hurt: 0 }];
  for (const t of Object.values(s.towns)) {
    if (t.owner === AI) continue;
    t.garrison = [null, null, null, null, null, null, null];
    t.visitingHeroId = null;
  }
  const ai = new AITurnController(s, AI);
  const town = rivalTown(s, ai, a, each * 20);
  assert.ok(town, 'this seed must have a rival town in range, or the test proves nothing');
  assert.equal(ai.worthConcentratingFor(a, b), null,
    'twenty times either hero is not a fight two of them can take');
});
