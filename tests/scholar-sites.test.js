/**
 * scholar-sites.test.js — the premium "scholar" visitables (HoMM3 parity):
 *   Library of Enlightenment — +2 to all four primary skills, once per hero, and only
 *                              to a hero of LIBRARY_MIN_LEVEL or better
 *   Tree of Knowledge        — grants a full level, once per hero
 * Both are `booster` map objects resolved by actions.applyBooster, placed on the
 * surface by MapGenerator's scholar pass (a Tree on most maps, a Library too on
 * medium-and-larger ones) and valued above a plain shrine by the AI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { stepHero, boosterName, boosterEffect } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
}
function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    const t = m.tiles[y * m.w + x];
    t.obstacle = null; t.terrain = 'grass';
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
  }
  return { x: cx, y: cy };
}
/** Walk `hero` onto (spot) and return the visit event. */
function visit(state, hero, spot) {
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 3000;
  return stepHero(state, hero, { x: spot.x, y: spot.y, cost: 100 });
}

const PRIMARIES = ['attack', 'defense', 'power', 'knowledge'];

test('Library of Enlightenment: +2 to all four primaries, once per hero', () => {
  assert.equal(boosterName('library'), 'Library of Enlightenment');
  assert.match(boosterEffect('library'), /four/i);
  assert.match(boosterEffect('library'), new RegExp(`level ${CONFIG.LIBRARY_MIN_LEVEL}`, 'i'));

  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.level = CONFIG.LIBRARY_MIN_LEVEL;          // a hero worth teaching
  const spot = clearBlock(s, 20, 20, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'library' });
  const before = { ...hero.stats };

  const ev = visit(s, hero, spot);
  assert.equal(ev.type, 'visited');
  for (const st of PRIMARIES) {
    assert.equal(hero.stats[st], before[st] + CONFIG.LIBRARY_BONUS, `+${CONFIG.LIBRARY_BONUS} ${st}`);
  }
  // Once per hero: a second visit changes nothing.
  visit(s, hero, spot);
  for (const st of PRIMARIES) {
    assert.equal(hero.stats[st], before[st] + CONFIG.LIBRARY_BONUS, `${st} not doubled`);
  }
});

test('the librarians turn away an apprentice — and remember nothing about it', () => {
  // The gate is the point of the building: it makes a library a reason to bring your
  // VETERAN across the map. But a level-9 hero walking past must not be locked out
  // forever — applyBooster marks `visited` before it branches, so the refusal has to
  // clear it or the crime of arriving early costs the gift permanently.
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.level = CONFIG.LIBRARY_MIN_LEVEL - 1;
  const spot = clearBlock(s, 20, 20, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'library' });
  const before = { ...hero.stats };

  const ev = visit(s, hero, spot);
  assert.equal(ev.noBenefit, true, 'turned away');
  assert.match(ev.text, new RegExp(`level ${CONFIG.LIBRARY_MIN_LEVEL}`));
  for (const st of PRIMARIES) assert.equal(hero.stats[st], before[st], `${st} unchanged`);

  // Come back a veteran, and it teaches.
  hero.level = CONFIG.LIBRARY_MIN_LEVEL;
  visit(s, hero, spot);
  for (const st of PRIMARIES) {
    assert.equal(hero.stats[st], before[st] + CONFIG.LIBRARY_BONUS, `${st} taught on the return`);
  }
});

test('more libraries on the larger maps', () => {
  const libs = (w, h) => {
    const s = newGame({ seed: 11, mapW: w, mapH: h });
    return [0, 1]
      .flatMap((l) => Object.values(l ? (s.map.underground?.objects || {}) : s.map.objects))
      .filter((o) => o.type === 'booster' && o.boosterType === 'library').length;
  };
  const small = libs(56, 46);
  const huge = libs(144, 120);
  assert.ok(small >= 1, 'a medium map still seats one');
  assert.ok(huge > small, `a 2.25x map should teach more than a small one (${huge} vs ${small})`);
});

test('Tree of Knowledge: grants a full level, once per hero', () => {
  assert.equal(boosterName('treeOfKnowledge'), 'Tree of Knowledge');
  assert.match(boosterEffect('treeOfKnowledge'), /level/i);

  const s = newGame({ seed: 4 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 18, 18, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'treeOfKnowledge' });
  const beforeLevel = hero.level;

  const ev = visit(s, hero, spot);
  assert.equal(ev.type, 'visited');
  assert.equal(hero.level, beforeLevel + 1, 'exactly one level gained');
  assert.ok(ev.events?.some((e) => e.type === 'levelUp'), 'a levelUp event is surfaced');

  // Once per hero: no second level.
  visit(s, hero, spot);
  assert.equal(hero.level, beforeLevel + 1, 'no second level from a re-visit');
});

test('map generation places a Tree on most maps, and a Library too on medium+ maps', () => {
  const count = (state, bt) => Object.values(state.map.objects)
    .filter((o) => o.type === 'booster' && o.boosterType === bt).length;

  const medium = newGame({ seed: 1, mapW: 44, mapH: 36 });
  assert.equal(count(medium, 'treeOfKnowledge'), 1, 'a Tree on the medium map');
  assert.equal(count(medium, 'library'), 1, 'a Library too on the medium map');

  const small = newGame({ seed: 1, mapW: 36, mapH: 30 });
  assert.equal(count(small, 'treeOfKnowledge'), 1, 'a Tree on the small map');
  assert.equal(count(small, 'library'), 0, 'no Library on the small map');

  // Whatever is placed sits on a real, correctly-linked tile.
  for (const o of Object.values(medium.map.objects)) {
    if (o.type === 'booster' && (o.boosterType === 'library' || o.boosterType === 'treeOfKnowledge')) {
      assert.equal(medium.map.tiles[o.y * medium.map.w + o.x].objectId, o.id, 'tile links back to the object');
    }
  }
});

test('the AI values a scholar site above a plain shrine', () => {
  const s = newGame({ seed: 5 });
  const ai = new AITurnController(s, 1);
  const plain = { id: 'P', type: 'booster', boosterType: 'attack', x: 5, y: 5 };
  const library = { id: 'L', type: 'booster', boosterType: 'library', x: 6, y: 6 };
  const tree = { id: 'T', type: 'booster', boosterType: 'treeOfKnowledge', x: 7, y: 7 };
  assert.ok(ai.boosterScore(library) > ai.boosterScore(plain), 'the Library outvalues a single-stat shrine');
  assert.ok(ai.boosterScore(tree) > ai.boosterScore(plain), 'the Tree outvalues a single-stat shrine');
});
