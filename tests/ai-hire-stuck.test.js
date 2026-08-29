/**
 * ai-hire-stuck.test.js — two adventure-AI upgrades:
 *
 *  1. Veteran preference. hireableHeroes offers returning veterans from the
 *     re-hire pool alongside fresh recruits; the AI now scores a veteran's
 *     accumulated levels, skills, kept army and artifacts (veteranValue) on top
 *     of the roster's starting kit, so a proven hero always outbids a green one
 *     — but only when the treasury can actually cover its level premium.
 *
 *  2. Cross-turn stuck detection. A blacklist lasts one turn, so the old AI
 *     could re-pick the same unreachable prize forever and shuffle between two
 *     or three tiles for weeks. A hero that neither strays beyond STUCK_RADIUS
 *     nor grows its army for STUCK_TURNS days now gets an aiAvoid zone that
 *     steers goal selection elsewhere. A hero turtling in a threatened town is
 *     doing its job, not stuck, and is exempt.
 *
 * All headless and deterministic (fixed seed, hand-shaped state).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, playerHeroes, playerTowns, serialize, deserialize,
} from '../src/core/GameState.js';
import { endTurn, hireableHeroes, pooledHero } from '../src/core/actions.js';
import { armyValue } from '../src/core/heroUtils.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const SEED = 4242;
const AI = 1;

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

// Mirror of the private stuck-detection constants in AIPlayer.js.
const STUCK_TURNS = 6;
const STUCK_AVOID_RADIUS = 3;

const stack = (creature, count) => [{ creature, count, hurt: 0 }, null, null, null, null, null, null];

/** A tavern-equipped, unoccupied own town with a fat treasury. */
function readyTavern(s, gold = 100000) {
  const town = playerTowns(s, AI)[0];
  if (!town.buildings.includes('tavern')) town.buildings.push('tavern');
  town.visitingHeroId = null;
  s.players[AI].resources.gold = gold;
  return town;
}

/** Push a returning veteran onto the AI's re-hire pool for a fresh roster slot. */
function poolVeteran(s, town, over = {}) {
  const rosterId = hireableHeroes(s, town).find((id) => !pooledHero(s, AI, id));
  const vet = {
    id: 'HVET', rosterId, owner: AI, name: 'Vet', class: 'knight', className: 'Knight',
    level: 6, xp: 8000, stats: { attack: 12, defense: 8, power: 3, knowledge: 3 },
    skills: { logistics: 2, wisdom: 1 }, spells: [],
    army: stack('pikeman', 20), equipment: { weapon: 'centaurAxe' }, backpack: [],
    mana: 0, mp: 0, ...over,
  };
  s.players[AI].heroPool.push(vet);
  return vet;
}

// ---------------------------------------------------------------------------

test('hiring: the AI prefers a proven veteran in the pool over a fresh recruit', () => {
  const s = newGame({ seed: SEED });
  const town = readyTavern(s);
  const vet = poolVeteran(s, town);
  // Sanity: the vet is genuinely one option among several fresh recruits.
  const offered = hireableHeroes(s, town);
  assert.ok(offered.includes(vet.rosterId), 'the veteran is on the tavern menu');
  assert.ok(offered.length > 1, 'fresh recruits are on offer too');

  new AITurnController(s, AI).maybeHireHero(town);

  assert.ok(s.heroes.HVET, 'the veteran was re-hired back onto the map');
  assert.equal(s.heroes.HVET.level, 6, 'and returned with its experience');
  assert.equal(pooledHero(s, AI, vet.rosterId), null, 'it left the pool');
});

test('hiring: a veteran too expensive for the treasury is passed over for an affordable fresh hero', () => {
  const s = newGame({ seed: SEED });
  const town = readyTavern(s);
  // A level-40 veteran carries a steep re-hire premium. Fund only a fresh hire
  // plus the two-hero reserve (1500) — the veteran must be unaffordable.
  const vet = poolVeteran(s, town, { level: 40 });
  s.players[AI].resources.gold = 2500 + 1500; // HERO_COST + reserve, no premium room

  new AITurnController(s, AI).maybeHireHero(town);

  assert.equal(s.heroes.HVET, undefined, 'the unaffordable veteran stayed in the pool');
  assert.ok(pooledHero(s, AI, vet.rosterId), 'still pooled, awaiting a fatter treasury');
  assert.equal(playerHeroes(s, AI).length, 2, 'a fresh, affordable hero was hired instead');
});

test('stuck: a hero pinned in place for STUCK_TURNS days gets a bounded avoid-zone', () => {
  const s = newGame({ seed: SEED });
  const ai = new AITurnController(s, AI);
  const hero = playerHeroes(s, AI)[0];
  hero.inTownId = null; // not defending anything → eligible to be judged stuck
  hero.army = stack('pikeman', 5);
  const gx = hero.x, gy = hero.y;

  // Days 1..STUCK_TURNS: never moves, army never grows — but the clock only
  // arms on the day the span reaches STUCK_TURNS.
  for (let day = 1; day <= STUCK_TURNS; day++) { s.day = day; ai.updateStuck(hero); }
  assert.equal(hero.aiAvoid, undefined, 'not flagged before the full span elapses');

  s.day = STUCK_TURNS + 1;
  ai.updateStuck(hero);
  assert.ok(hero.aiAvoid, 'an avoid-zone is planted after the idle span');
  assert.ok(ai.isAvoided(hero, gx + 1, gy), 'the pocket it was stuck in is now avoided');
  assert.ok(!ai.isAvoided(hero, gx + STUCK_AVOID_RADIUS + 2, gy), 'the zone is bounded, not global');
});

test('stuck: real progress (moving away, or growing the army) keeps a hero un-flagged', () => {
  const s = newGame({ seed: SEED });
  const ai = new AITurnController(s, AI);
  const hero = playerHeroes(s, AI)[0];
  hero.inTownId = null;
  hero.army = stack('pikeman', 5);

  for (let day = 1; day <= STUCK_TURNS; day++) {
    s.day = day;
    if (day === 3) hero.x += 5; // marched off — resets the anchor
    if (day === 5) hero.army[0].count += 30; // absorbed recruits — resets the anchor
    ai.updateStuck(hero);
  }
  s.day = STUCK_TURNS + 1;
  ai.updateStuck(hero);
  assert.equal(hero.aiAvoid, undefined, 'a hero that keeps making progress is never judged stuck');
});

test('stuck: a hero turtling in a threatened home town is exempt (defending, not stuck)', () => {
  const s = newGame({ seed: SEED });
  const ai = new AITurnController(s, AI);
  const hero = playerHeroes(s, AI)[0];
  const town = playerTowns(s, AI)[0];
  hero.x = town.x; hero.y = town.y; hero.z = town.z ?? 0;
  hero.inTownId = town.id;
  town.visitingHeroId = hero.id;
  hero.army = stack('pikeman', 5);

  for (let day = 1; day <= STUCK_TURNS + 2; day++) {
    s.day = day;
    // A live, remembered menace on the town keeps townThreat > 0 every day.
    town.aiThreat = { value: 999999, x: town.x, y: town.y, z: 0, day };
    ai.updateStuck(hero);
  }
  assert.equal(hero.aiAvoid, undefined, 'a defender holding the walls is never marked stuck');
});

test('stuck: avoid-zone steers pickGoal away from the pocket, and round-trips save/load', () => {
  const s = newGame({ seed: SEED });
  // Creature Banks and Pandora's Boxes are rich, reachable prizes an archangel
  // army can dare — strip them so ONLY the planted adjacent prize competes in
  // this controlled arena.
  for (const o of Object.values(s.map.objects)) {
    if (o.type === 'creatureBank' || o.type === 'pandora') { s.map.tiles[o.y * s.map.w + o.x].objectId = null; delete s.map.objects[o.id]; }
  }
  // Carve a quiet arena far from every town so nothing else competes.
  const towns = Object.values(s.towns).filter((t) => (t.z ?? 0) === 0);
  let spot = null;
  for (let y = 6; y < s.map.h - 6 && !spot; y++) {
    for (let x = 6; x < s.map.w - 6 && !spot; x++) {
      if (towns.every((t) => Math.hypot(t.x - x, t.y - y) > 16)) spot = { x, y };
    }
  }
  assert.ok(spot, 'found a spot far from all towns');
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const t = s.map.tiles[(spot.y + dy) * s.map.w + (spot.x + dx)];
      if (t.objectId) { delete s.map.objects[t.objectId]; t.objectId = null; }
      t.obstacle = null; t.terrain = 'grass';
    }
  }
  const hero = playerHeroes(s, AI)[0];
  hero.x = spot.x; hero.y = spot.y; hero.z = 0; hero.inTownId = null;
  hero.army = stack('archangel', 100); // strong: nothing is out of its courage league
  // One adjacent resource is the clear best nearby prize.
  const rid = `O${s.map.nextOid++}`;
  const rx = spot.x + 1, ry = spot.y;
  s.map.objects[rid] = { id: rid, x: rx, y: ry, type: 'resource', resource: 'gold', amount: 1000 };
  s.map.tiles[ry * s.map.w + rx].objectId = rid;

  const ai = new AITurnController(s, AI);
  ai._reachCache = new Map(); ai._throughCache = new Map();
  const reach = ai.floodCached(hero.x, hero.y, 0, false);
  const g1 = ai.pickGoal(hero, reach);
  assert.ok(g1 && g1.x === rx && g1.y === ry, 'baseline: the adjacent prize is the chosen goal');

  // Plant an avoid-zone over the prize: it must no longer be chosen.
  hero.aiAvoid = { x: rx, y: ry, z: 0, until: s.day + 8 };
  ai._reachCache = new Map(); ai._throughCache = new Map();
  const g2 = ai.pickGoal(hero, ai.floodCached(hero.x, hero.y, 0, false));
  assert.ok(!(g2 && g2.x === rx && g2.y === ry), 'the avoided prize is skipped for something else');

  // The avoid + anchor fields are plain data: they survive a save/load.
  hero.aiAnchor = { x: hero.x, y: hero.y, z: 0, day: s.day, val: armyValue(hero.army) };
  const r = deserialize(serialize(s));
  const rHero = r.heroes[hero.id];
  assert.deepEqual(rHero.aiAvoid, hero.aiAvoid, 'aiAvoid round-trips serialization');
  assert.deepEqual(rHero.aiAnchor, hero.aiAnchor, 'aiAnchor round-trips serialization');
});

test('stuck (end to end): a boxed hero acquires an avoid-zone through real AI turns', () => {
  const s = newGame({ seed: SEED });
  const hero = playerHeroes(s, AI)[0];
  // Wall the hero into a single tile far from its town: every neighbour is an
  // obstacle, so it literally cannot make progress day after day — the exact
  // "bounces in place for weeks" the fix targets, driven through advanceHero.
  if (hero.inTownId) { s.towns[hero.inTownId].visitingHeroId = null; hero.inTownId = null; }
  // Genuinely far from its town, which the hero starts standing on: a hero
  // boxed in NEXT to a town of its own collects the garrison every day (pickup
  // on pass), its army grows, and a hero whose army grows is by definition not
  // the idle-in-place case this detector is for.
  {
    const towns = playerTowns(s, AI);
    const clear = (x, y) => {
      const t = s.map.tiles[y * s.map.w + x];
      return t && !t.obstacle && !t.objectId && t.terrain !== 'water'
        && towns.every((tn) => Math.max(Math.abs(tn.x - x), Math.abs(tn.y - y)) > 2);
    };
    let spot = null;
    for (let r = 3; r < 12 && !spot; r++) {
      for (let dy = -r; dy <= r && !spot; dy++) {
        for (let dx = -r; dx <= r && !spot; dx++) {
          const x = hero.x + dx, y = hero.y + dy;
          if (x < 1 || y < 1 || x >= s.map.w - 1 || y >= s.map.h - 1) continue;
          if (clear(x, y)) spot = { x, y };
        }
      }
    }
    assert.ok(spot, 'the map has open ground away from the towns');
    hero.x = spot.x; hero.y = spot.y;
  }
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const t = s.map.tiles[(hero.y + dy) * s.map.w + (hero.x + dx)];
      if (t.objectId) { delete s.map.objects[t.objectId]; t.objectId = null; }
      t.obstacle = 'rock';
    }
  }
  const px = hero.x, py = hero.y;

  for (let day = 1; day <= 8; day++) {
    assert.equal(s.day, day);
    endTurn(s); // human
    runTurn(s); // AI — advanceHero runs updateStuck on the boxed hero
    assert.equal(hero.x, px, 'the boxed hero never moves in x');
    assert.equal(hero.y, py, 'the boxed hero never moves in y');
    endTurn(s); // AI ends
  }

  assert.ok(hero.aiAvoid, 'the detector fired through the real turn loop');
  assert.ok(hero.aiAvoid.until > s.day - 8, 'and the avoid-zone is live');
});
