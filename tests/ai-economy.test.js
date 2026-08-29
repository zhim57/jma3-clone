/**
 * ai-economy.test.js — the rivals' economy: boosters and the collector hero.
 *
 * Reported: "the AI players do not flag mines and collect resources, and don't
 * have on their side the waypoints to boost range, or the wells to give them
 * mana, or the forts to upgrade creatures — they should have the same boosters
 * as me. If they do not flag mines they cannot keep up with production and
 * economy, and they cannot gain experience."
 *
 * Two causes, pinned separately:
 *
 *   1. Every booster was priced at a flat 800. A Hill Fort that would upgrade a
 *      hero's whole army, a Magic Well that refills a caster's book and a
 *      Wayfarer's Camp worth a third of a day's march all scored the same as a
 *      +1 morale shrine, so they lost every contest against a 2,500 mine and the
 *      AI never walked to one. They are now priced by what they actually give.
 *
 *   2. Force concentration (AI_MASS_RATIO) stopped the AI hiring the moment the
 *      player's army pulled ahead — permanently, since the gate reads the same
 *      comparison every turn. Its remaining heroes turtle, nothing flags a mine,
 *      the income never arrives, and it can never catch up. Concentration is a
 *      military argument; it now stands down while the realm is ALSO losing the
 *      economy, capped at AI_ECON_HEROES.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, playerTowns, levelObjects } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { heroMaxMana } from '../src/core/heroUtils.js';

const SEED = 4242;
const AI = 1;

/** A controller bound to the AI realm, ready to price things. */
const ctl = (s) => new AITurnController(s, AI);

/** The AI's first hero. */
const lead = (s) => playerHeroes(s, AI)[0];

// ---------------------------------------------------------------------------
// 1. Boosters priced by what they give
// ---------------------------------------------------------------------------

test('a Magic Well is worth the mana it would restore — and nothing to a hero with no book', () => {
  const s = newGame({ seed: SEED });
  const ai = ctl(s);
  const hero = lead(s);
  const well = { type: 'booster', boosterType: 'mana', id: 'B1', x: 0, y: 0 };

  hero.spells = [];
  hero.mana = 0;
  assert.equal(ai.boosterScore(well, hero), 0, 'a hero with no spells has nothing to spend it on');

  hero.spells = ['haste'];
  hero.mana = 0;
  const empty = ai.boosterScore(well, hero);
  hero.mana = Math.floor(heroMaxMana(hero) * 0.9);
  const nearlyFull = ai.boosterScore(well, hero);
  assert.ok(empty > nearlyFull, 'a drained caster wants it more than a nearly-full one');
  assert.ok(nearlyFull > 0, 'but a partial refill is still worth something');
});

test('a Magic Spring outbids a plain Well, because it overfills past the cap', () => {
  const s = newGame({ seed: SEED });
  const ai = ctl(s);
  const hero = lead(s);
  hero.spells = ['haste'];
  hero.mana = Math.floor(heroMaxMana(hero) * 0.5);
  const well = ai.boosterScore({ type: 'booster', boosterType: 'mana', id: 'B1', x: 0, y: 0 }, hero);
  const spring = ai.boosterScore({ type: 'booster', boosterType: 'magicSpring', id: 'B2', x: 0, y: 0 }, hero);
  assert.ok(spring > well, `the spring is the bigger prize (${spring} vs ${well})`);
});

test('a Hill Fort is worth the army value its upgrades would ADD', () => {
  const s = newGame({ seed: SEED });
  const ai = ctl(s);
  const hero = lead(s);
  const fort = { type: 'booster', boosterType: 'hillFort', id: 'B1', x: 0, y: 0 };

  // Nothing upgradeable in hand → nothing to march for.
  hero.army = [null, null, null, null, null, null, null];
  assert.equal(ai.boosterScore(fort, hero), 0, 'an empty army gets nothing from a fort');

  // A big stack of a low-tier (free-to-upgrade) creature is a real prize, and a
  // BIGGER stack is a bigger one — that is what "priced by what it gives" means.
  hero.army = [{ creature: 'pikeman', count: 30, hurt: 0 }, null, null, null, null, null, null];
  const small = ai.boosterScore(fort, hero);
  hero.army = [{ creature: 'pikeman', count: 300, hurt: 0 }, null, null, null, null, null, null];
  const big = ai.boosterScore(fort, hero);
  assert.ok(small > 0, 'a fort with work to do is worth marching for');
  assert.ok(big > small, `a bigger army makes a bigger prize (${big} vs ${small})`);
});

test('a Wayfarer\'s Camp is priced against the hero\'s own daily march', () => {
  const s = newGame({ seed: SEED });
  const ai = ctl(s);
  const hero = lead(s);
  const camp = { type: 'booster', boosterType: 'move', id: 'B1', x: 0, y: 0 };
  const score = ai.boosterScore(camp, hero);
  assert.ok(score > 0, 'more road today is worth something');
  // A slow army needs the camp more than a fast one, so it must be worth more.
  hero.army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  const slow = ai.boosterScore(camp, hero);
  hero.army = [{ creature: 'cavalier', count: 10, hurt: 0 }, null, null, null, null, null, null];
  const fast = ai.boosterScore(camp, hero);
  assert.ok(slow >= fast, `the slower army values the camp at least as highly (${slow} vs ${fast})`);
});

test('weekly yield sites are worth their goods, not a flat token', () => {
  const s = newGame({ seed: SEED });
  const ai = ctl(s);
  const hero = lead(s);
  const at = (boosterType) => ai.boosterScore({ type: 'booster', boosterType, id: 'B1', x: 0, y: 0 }, hero);
  assert.ok(at('waterWheel') >= CONFIG.WATER_WHEEL_GOLD, 'a water wheel is worth its gold');
  assert.ok(at('tradeFair') > at('waterWheel'), 'a fair hands over a whole bundle, so it outbids the wheel');
  assert.ok(at('windmill') > 0);
});

test('the premium and puzzle sites keep the pricing they already had', () => {
  const s = newGame({ seed: SEED });
  const ai = ctl(s);
  const hero = lead(s);
  const at = (boosterType) => ai.boosterScore({ type: 'booster', boosterType, id: 'B1', x: 0, y: 0 }, hero);
  assert.ok(at('library') > at('treeOfKnowledge'), 'four stat points beats one level');
  assert.ok(at('treeOfKnowledge') > at('attack'), 'and one level beats one stat point');
});

test('priced without a hero, a booster falls back to the flat value — never to a wrong one', () => {
  // A through-connector scan has no hero to price against; a low estimate is
  // correct there, an invented one is not.
  const s = newGame({ seed: SEED });
  const ai = ctl(s);
  for (const t of ['hillFort', 'mana', 'move', 'waterWheel']) {
    const v = ai.boosterScore({ type: 'booster', boosterType: t, id: 'B1', x: 0, y: 0 });
    assert.ok(v > 0 && Number.isFinite(v), `${t} still prices to something sane without a hero`);
  }
});

// ---------------------------------------------------------------------------
// 2. Force concentration must not strangle the economy
// ---------------------------------------------------------------------------

test('economyStarving is true only while the realm holds under its fair share of mines', () => {
  const s = newGame({ seed: SEED });
  const ai = ctl(s);
  const mines = Object.values(levelObjects(s, 0)).filter((o) => o.type === 'mine');
  assert.ok(mines.length > 0, 'the map has mines');

  for (const m of mines) m.owner = -1;
  assert.equal(ai.economyStarving(), true, 'holding none of them is starving');

  for (const m of mines) m.owner = AI;
  assert.equal(ai.economyStarving(), false, 'holding all of them is not');
});

test('a losing realm still hires ONE collector, instead of shutting the economy down', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  if (!town.buildings.includes('tavern')) town.buildings.push('tavern');
  town.visitingHeroId = null;
  s.players[AI].resources.gold = 40000;
  // The human's army massively outclasses the AI's: the force-concentration gate
  // reads this every turn and used to latch shut on it forever.
  playerHeroes(s, 0)[0].army = [{ creature: 'archangel', count: 500, hurt: 0 }];
  // …and the AI holds no mines at all, so its economy is the thing actually failing.
  for (const m of Object.values(levelObjects(s, 0))) if (m.type === 'mine') m.owner = -1;

  const before = playerHeroes(s, AI).length;
  const ai = ctl(s);
  ai.maybeHireHero(town);
  const after = playerHeroes(s, AI).length;
  assert.equal(after, before + 1, 'the realm hired a hero to go and work the map');

  // …but the exception is CAPPED. Past AI_ECON_HEROES, concentration wins again.
  while (playerHeroes(s, AI).length < CONFIG.AI_ECON_HEROES) {
    const h = JSON.parse(JSON.stringify(playerHeroes(s, AI)[0]));
    h.id = `H_pad_${playerHeroes(s, AI).length}`;
    s.heroes[h.id] = h;
  }
  const capped = playerHeroes(s, AI).length;
  town.visitingHeroId = null;
  ctl(s).maybeHireHero(town);
  assert.equal(playerHeroes(s, AI).length, capped, 'one collector, not an army split');
});

test('a realm that already holds its share concentrates force exactly as before', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  if (!town.buildings.includes('tavern')) town.buildings.push('tavern');
  town.visitingHeroId = null;
  s.players[AI].resources.gold = 40000;
  playerHeroes(s, 0)[0].army = [{ creature: 'archangel', count: 500, hurt: 0 }];
  // Every mine on the map is already theirs — the economy is fine, so the only
  // question left is military, and the old answer stands.
  for (const m of Object.values(levelObjects(s, 0))) if (m.type === 'mine') m.owner = AI;
  if (s.map.underground) {
    for (const m of Object.values(levelObjects(s, 1))) if (m.type === 'mine') m.owner = AI;
  }
  while (playerHeroes(s, AI).length < CONFIG.AI_MIN_HEROES) {
    const h = JSON.parse(JSON.stringify(playerHeroes(s, AI)[0]));
    h.id = `H_pad_${playerHeroes(s, AI).length}`;
    s.heroes[h.id] = h;
  }
  const before = playerHeroes(s, AI).length;
  ctl(s).maybeHireHero(town);
  assert.equal(playerHeroes(s, AI).length, before, 'no hire — the recruits go into one fist');
});

test('every hire decision leaves a reason in the brain log', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  if (!town.buildings.includes('tavern')) town.buildings.push('tavern');
  town.visitingHeroId = null;
  s.players[AI].resources.gold = 10; // nowhere near enough
  const ai = ctl(s);
  ai.maybeHireHero(town);
  ai.flushTurnLog();
  const notes = (s.aiLog || []).filter((e) => e.kind === 'town');
  assert.ok(notes.length > 0, 'a refused hire says why');
  assert.match(notes[0].what, /gold/, 'and the reason names the actual gate');
});
