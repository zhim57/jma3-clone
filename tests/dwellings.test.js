/**
 * dwellings.test.js — External creature dwellings (HoMM3 parity). A recruitment
 * site on the adventure map: it accrues one creature weekly (like a town's
 * dwelling); a visiting hero flags it and recruits the accrued stock straight
 * into its army at the creature's normal cost. Engine + AI only, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CREATURES } from '../src/data/creatures.js';
import { DWELLINGS, DWELLING_TYPES, dwellingDef } from '../src/data/dwellings.js';
import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { stepHero, endTurn, recruitFromDwelling, dwellingCreature, dwellingName } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { revealAround } from '../src/map/fog.js';

function putDwelling(state, x, y, dwellingType, available, owner = -1) {
  const m = state.map;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const t = m.tiles[(y + dy) * m.w + (x + dx)];
    if (!t) continue;
    t.obstacle = null; if (t.terrain === 'water') t.terrain = 'grass';
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
  }
  const id = `OD${m.nextOid++}`;
  m.objects[id] = { id, x, y, type: 'dwelling', dwellingType, available, owner };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}

test('every dwelling names a real creature with real weekly growth; DWELLING_TYPES covers them', () => {
  assert.deepEqual([...DWELLING_TYPES].sort(), Object.keys(DWELLINGS).sort());
  for (const [id, d] of Object.entries(DWELLINGS)) {
    assert.ok(d.name, `${id} has a name`);
    const c = CREATURES[d.creature];
    assert.ok(c, `${id} creature ${d.creature} is real`);
    assert.ok(c.growth > 0, `${id} creature ${d.creature} actually breeds`);
  }
});

test('stepping onto a dwelling flags it and offers recruitment', () => {
  const s = newGame({ seed: 5 });
  const hero = playerHeroes(s, 0)[0];
  const d = putDwelling(s, hero.x + 1, hero.y, 'griffinTower', 20);
  hero.mp = 3000;
  const ev = stepHero(s, hero, { x: d.x, y: d.y, cost: 100 });
  assert.equal(ev.type, 'dwelling');
  assert.equal(ev.creature, 'griffin');
  assert.equal(ev.available, 20);
  assert.equal(d.owner, 0, 'the visiting realm flags the site');
  assert.equal(dwellingName(d), 'Griffin Tower');
});

test('recruitFromDwelling: clamps to stock AND affordability, pays, and fills the army', () => {
  const s = newGame({ seed: 6 });
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = 100000;
  const d = putDwelling(s, hero.x + 1, hero.y, 'griffinTower', 20);
  const each = CREATURES.griffin.cost.gold;

  const got = recruitFromDwelling(s, hero, d, 15);
  assert.equal(got, 15, 'recruited the requested count');
  assert.equal(d.available, 5, 'stock decremented');
  assert.equal(s.players[0].resources.gold, 100000 - 15 * each, 'paid the cost');
  assert.ok(hero.army.some((st) => st && st.creature === 'griffin' && st.count >= 15), 'creatures joined the army');

  // Clamp to remaining stock even when more is requested.
  assert.equal(recruitFromDwelling(s, hero, d, 999), 5, 'cannot recruit past the stock');
  assert.equal(d.available, 0);

  // Broke ⇒ nothing.
  const d2 = putDwelling(s, hero.x - 1, hero.y, 'pegasusVale', 10);
  s.players[0].resources.gold = 0;
  assert.equal(recruitFromDwelling(s, hero, d2, 5), 0, 'no gold, no recruits');
  assert.equal(d2.available, 10, 'and the stock is untouched');
});

test('a full army blocks the recruit (stock preserved, no overspend)', () => {
  const s = newGame({ seed: 6 });
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = 100000;
  // Fill all 7 slots with distinct creatures the dwelling's griffin can't merge into.
  hero.army = ['pikeman', 'archer', 'swordsman', 'monk', 'cavalier', 'angel', 'peasant']
    .map((creature) => ({ creature, count: 1, hurt: 0 }));
  const d = putDwelling(s, hero.x + 1, hero.y, 'griffinTower', 10);
  const goldBefore = s.players[0].resources.gold;
  assert.equal(recruitFromDwelling(s, hero, d, 5), 0, 'no free slot ⇒ no recruit');
  assert.equal(d.available, 10, 'stock preserved');
  assert.equal(s.players[0].resources.gold, goldBefore, 'no gold spent');
});

test('a dwelling accrues its creature each new week', () => {
  const s = newGame({ seed: 7 });
  const d = putDwelling(s, 20, 20, 'griffinTower', 3); // griffin growth 7
  while (s.day < 8) endTurn(s); // roll into week 2
  assert.equal(d.available, 3 + CREATURES.griffin.growth, 'one week of growth accrued');
});

test('a dwelling round-trips a save', () => {
  const s = newGame({ seed: 8 });
  const d = putDwelling(s, 18, 18, 'houndKennel', 12, 0);
  const restored = deserialize(serialize(s));
  const r = restored.map.objects[d.id];
  assert.equal(r.type, 'dwelling');
  assert.equal(r.dwellingType, 'houndKennel');
  assert.equal(r.available, 12);
  assert.equal(r.owner, 0);
  assert.equal(dwellingCreature(r), 'hellHound');
});

test('the AI prices a dwelling by the affordable stock, and 0 when broke', () => {
  const s = newGame({ seed: 9 });
  const ai = new AITurnController(s, 1);
  const d = putDwelling(s, 20, 20, 'griffinTower', 10);
  s.players[1].resources.gold = 100000;
  assert.equal(ai.dwellingValue(d), CREATURES.griffin.aiValue * 10, 'full stock priced at army value');
  s.players[1].resources.gold = CREATURES.griffin.cost.gold * 3; // only 3 affordable
  assert.equal(ai.dwellingValue(d), CREATURES.griffin.aiValue * 3, 'clamped to what we can buy');
  s.players[1].resources.gold = 0;
  assert.equal(ai.dwellingValue(d), 0, 'broke ⇒ worth nothing');
});

test('the AI marches to a rich dwelling and recruits its stock', () => {
  const s = newGame({ seed: 9 });
  const ai = playerHeroes(s, 1)[0];
  s.players[1].resources.gold = 100000;
  const d = putDwelling(s, Math.min(s.map.w - 3, ai.x + 2), ai.y, 'griffinTower', 40);
  revealAround(s, 1, d.x, d.y, 6, 0);
  const ctrl = new AITurnController(s, 1);
  let guard = 300, r;
  do { r = ctrl.next(); if (r.type === 'combat') ctrl.autoFight(r.context); } while (r.type !== 'done' && guard-- > 0);
  assert.ok(d.available < 40, 'the AI recruited from the dwelling');
  assert.equal(d.owner, 1, 'and flagged it');
  const totalGriffins = playerHeroes(s, 1).reduce(
    (n, h) => n + h.army.reduce((k, a) => k + (a && a.creature === 'griffin' ? a.count : 0), 0), 0);
  assert.ok(totalGriffins > 0, 'the recruited griffins are in the AI army');
});

test('generation seats a few dwellings on reachable land, each seeded with a week of stock', () => {
  const s = newGame({ seed: 3, mapW: 44, mapH: 36 });
  const dw = Object.values(s.map.objects).filter((o) => o.type === 'dwelling');
  assert.ok(dw.length >= 1, 'at least one dwelling generated');
  for (const d of dw) {
    assert.ok(dwellingDef(d.dwellingType), `${d.dwellingType} is a real dwelling`);
    assert.equal(d.available, CREATURES[dwellingCreature(d)].growth, 'seeded with one week of stock');
    assert.equal(s.map.tiles[d.y * s.map.w + d.x].objectId, d.id, 'tile links to the dwelling');
  }
});
