/**
 * grail-v2.test.js — the Grail quest, second pass:
 *
 *  1. Per-faction Grail structures. Every Grail gives the universal +growth;
 *     on top of that each faction carries a signature blessing — Castle a daily
 *     gold bonus, Inferno a STRONGER growth multiplier, Tower full mana for a
 *     hero waking in the town. Driven by CONFIG.FACTION_GRAIL.
 *
 *  2. AI grail-seeking. Once the obelisk puzzle is solved the AI's main hero
 *     rides to the buried tile and digs it (a full-day action), then carries
 *     the Grail home to raise the structure — all gated on safety.
 *
 * Headless and deterministic (fixed seed, hand-shaped state).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import {
  endTurn, dailyIncome, grailGrowthMult, grailPerkText, grailKnown,
} from '../src/core/actions.js';
import { heroMaxMana } from '../src/core/heroUtils.js';
import { CONFIG, validateConfig } from '../src/config.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const SEED = 4242;
const AI = 1;

const bigArmy = () => [{ creature: 'archangel', count: 50, hurt: 0 }, null, null, null, null, null, null];

/** Drive a full AI turn to completion, auto-resolving any battles. */
function runTurn(state, playerIndex = AI) {
  const ai = new AITurnController(state, playerIndex);
  let r, guard = 400;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return ai;
}

/** Advance the calendar until the week ticks over (mirrors the growth tests). */
function runToNextWeek(s) {
  const w0 = s.day;
  const week = (d) => Math.floor((d - 1) / CONFIG.DAYS_PER_WEEK);
  let guard = 40;
  while (week(s.day) === week(w0) && guard-- > 0) endTurn(s);
}

/** Clear an open corridor of grass between two surface points (inclusive box). */
function clearBox(s, x0, y0, x1, y1) {
  const m = s.map;
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const t = m.tiles[y * m.w + x];
      t.obstacle = null; t.terrain = 'grass';
      if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
    }
  }
}

/** Mark every obelisk on the map uncovered for `owner` (solves the puzzle). */
function solvePuzzle(s, owner) {
  const ids = [];
  for (const lvl of [s.map, s.map.underground]) {
    if (!lvl) continue;
    for (const o of Object.values(lvl.objects)) {
      if (o.type === 'booster' && o.boosterType === 'obelisk') ids.push(o.id);
    }
  }
  s.players[owner].obeliskIds = ids;
  return ids.length;
}

// ===========================================================================
// 1. Per-faction Grail structures
// ===========================================================================

test('grailGrowthMult: Inferno swells harder than the default blessing; others use the default', () => {
  assert.equal(grailGrowthMult('inferno'), CONFIG.FACTION_GRAIL.inferno.growthMult);
  assert.ok(grailGrowthMult('inferno') > CONFIG.GRAIL_GROWTH_MULT, 'Inferno grows more than the +50% default');
  assert.equal(grailGrowthMult('castle'), CONFIG.GRAIL_GROWTH_MULT, 'Castle uses the default multiplier');
  assert.equal(grailGrowthMult('tower'), CONFIG.GRAIL_GROWTH_MULT, 'Tower uses the default multiplier');
  assert.equal(grailGrowthMult('nosuchfaction'), CONFIG.GRAIL_GROWTH_MULT, 'unknown faction falls back to the default');
});

test('grailPerkText spells out the universal growth plus each faction signature', () => {
  for (const f of ['castle', 'inferno', 'tower']) {
    assert.match(grailPerkText(f), /growth/i, `${f}: mentions the growth blessing`);
  }
  assert.match(grailPerkText('castle'), /gold/i, 'Castle names its daily gold');
  assert.match(grailPerkText('tower'), /mana/i, 'Tower names its mana font');
  assert.match(grailPerkText('inferno'), /100% weekly creature growth/, 'Inferno reads as +100% (×2.0)');
});

test("Castle's Grail pays a signature daily gold bonus", () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, 0)[0];
  town.faction = 'castle';
  const before = dailyIncome(s, s.players[0]).gold || 0;
  town.grail = true;
  const after = dailyIncome(s, s.players[0]).gold || 0;
  assert.equal(after - before, CONFIG.FACTION_GRAIL.castle.gold, 'the Grail adds exactly its gold bonus');
});

test("Inferno's Grail out-grows a plain Inferno town (its stronger multiplier)", () => {
  const s = newGame({ seed: SEED });
  const towns = Object.values(s.towns);
  const a = towns[0], b = towns.find((t) => t.id !== a.id);
  for (const t of [a, b]) { t.owner = 0; t.faction = 'inferno'; t.buildings = ['dwelling1']; t.available = {}; }
  a.grail = true; // ×2.0
  runToNextWeek(s);
  assert.ok((a.available[1] || 0) > (b.available[1] || 0),
    `the Inferno Grail town grew tier-1 more (${a.available[1]} vs ${b.available[1]})`);
});

test("Tower's Grail is an arcane font: a hero waking there restores all its mana", () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, 0)[0];
  town.faction = 'tower'; town.grail = true;
  const hero = playerHeroes(s, 0)[0];
  hero.x = town.x; hero.y = town.y; hero.z = town.z ?? 0;
  hero.inTownId = town.id; town.visitingHeroId = hero.id;
  hero.stats.knowledge = 10; hero.mana = 0;
  const max = heroMaxMana(hero);
  assert.ok(max > CONFIG.BASE_MANA_REGEN, 'max mana exceeds a plain day of regen (so the refill is observable)');

  let guard = 12;
  while (guard-- > 0) { if (endTurn(s).newDay) break; }
  assert.equal(hero.mana, max, 'the Tower Grail town tops the waking hero to full mana');
});

test('a Castle Grail town does NOT refill mana (the font is Tower-only)', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, 0)[0];
  town.faction = 'castle'; town.grail = true;
  const hero = playerHeroes(s, 0)[0];
  hero.x = town.x; hero.y = town.y; hero.z = town.z ?? 0;
  hero.inTownId = town.id; town.visitingHeroId = hero.id;
  hero.stats.knowledge = 10; hero.mana = 0;

  let guard = 12;
  while (guard-- > 0) { if (endTurn(s).newDay) break; }
  assert.ok(hero.mana < heroMaxMana(hero), 'without the arcane font, only ordinary regen applies');
});

test('config validation accepts FACTION_GRAIL', () => {
  assert.ok(!validateConfig().some((p) => /FACTION_GRAIL/.test(p)), 'no FACTION_GRAIL problems reported');
});

// ===========================================================================
// 2. AI grail-seeking
// ===========================================================================

test('AI: the main hero fetches and digs the Grail once the puzzle is solved', () => {
  const s = newGame({ seed: SEED });
  const hero = playerHeroes(s, AI)[0];
  hero.army = bigArmy();            // strong: no threat ever gates the tile
  hero.z = 0;
  if (hero.inTownId) { s.towns[hero.inTownId].visitingHeroId = null; hero.inTownId = null; }
  assert.ok(solvePuzzle(s, AI) > 0, 'the map has obelisks to solve');
  assert.ok(grailKnown(s, AI), 'the puzzle is solved for the AI');

  // Bury the Grail two tiles from the hero, on a cleared corridor.
  const dir = hero.x < s.map.w - 4 ? 1 : -1;
  const gx = hero.x + 2 * dir, gy = hero.y;
  clearBox(s, hero.x, hero.y - 1, gx + dir, hero.y + 1);
  s.map.grail = { x: gx, y: gy };

  let guard = 8;
  while (guard-- > 0 && !s.grailDug) {
    endTurn(s);  // human
    runTurn(s);  // AI acts
    endTurn(s);  // AI ends → new day, full movement restored
  }
  assert.ok(s.grailDug, 'the AI rode to the buried tile and dug the Grail up');
  assert.ok(hero.carryingGrail, 'and its hero now carries it');
});

test('AI: a hero carrying the Grail enshrines it at its own town', () => {
  const s = newGame({ seed: SEED });
  const hero = playerHeroes(s, AI)[0];
  hero.army = bigArmy();
  hero.carryingGrail = true;
  const town = playerTowns(s, AI)[0];
  hero.z = town.z ?? 0;
  if (hero.inTownId) { s.towns[hero.inTownId].visitingHeroId = null; hero.inTownId = null; }

  // Stand the hero two tiles from its own town with a clear path in.
  const dir = town.x > 2 ? -1 : 1;
  hero.x = town.x + 2 * dir; hero.y = town.y;
  clearBox(s, town.x, town.y - 1, hero.x, town.y + 1);

  let guard = 6;
  while (guard-- > 0 && !town.grail) {
    endTurn(s);
    runTurn(s);
    endTurn(s);
  }
  assert.ok(town.grail, 'the AI carried the Grail home and raised its structure');
  assert.equal(hero.carryingGrail, false, 'the Grail was consumed into the town');
  assert.equal(s.grailTownId, town.id, 'and the Grail town is recorded');
});

test('AI: with the puzzle UNSOLVED, a hero on the buried tile does not dig', () => {
  const s = newGame({ seed: SEED });
  const hero = playerHeroes(s, AI)[0];
  hero.army = bigArmy();
  hero.z = 0;
  if (hero.inTownId) { s.towns[hero.inTownId].visitingHeroId = null; hero.inTownId = null; }
  s.players[AI].obeliskIds = []; // puzzle NOT solved
  s.map.grail = { x: hero.x, y: hero.y }; // literally standing on it
  clearBox(s, hero.x - 1, hero.y - 1, hero.x + 1, hero.y + 1);

  const ai = new AITurnController(s, AI);
  assert.equal(ai.tryGrailDig(hero), false, 'no dig without the solved puzzle');
  runTurn(s);
  assert.ok(!s.grailDug, 'the Grail stays buried while obelisks remain');
});
