/**
 * rich-lands.test.js — the husbandry economy (opt-in `richLands`) + Trade Fairs.
 *
 * Classic maps put every RARE mine in the contested middle band, so a small map
 * has exactly one crystal cavern and one gem pond for all three towns, and no
 * reason to tour your own ground. Measured before building this: a 36x30 map
 * carries 11 mines, and — the real crack — a Water Wheel appeared on only 1 seed
 * in 12, because wheels are seated LAST and need shore adjacency, by which point
 * a small map's few reachable shore tiles are taken or crowded.
 *
 * Rich Lands gives each town's zone a full set of all seven mines, a spare of
 * every resource in the band, and seats the weekly sites FIRST with progressive
 * relaxation so three wheels land on every seed. Trade Fairs are new: a weekly
 * bundle of several goods plus coin, so a circuit of the realm is worth a hero's
 * days rather than an afterthought.
 *
 * Off by default and drawing no extra rng when off, so Classic is unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, RESOURCES } from '../src/config.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { stepHero, boosterName, boosterEffect, BOOSTER_TYPES } from '../src/core/actions.js';

const P = [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }];
const MINE_KINDS = Object.keys(CONFIG.MINE_INCOME);

function build(seed, { rich = false, w = 44, h = 38 } = {}) {
  return newGame({ seed, players: P, mapW: w, mapH: h, features: rich ? { richLands: true } : {} });
}
function census(state) {
  const mines = {}, boosters = {};
  for (const o of Object.values(state.map.objects || {})) {
    if (o.type === 'mine') mines[o.mineType] = (mines[o.mineType] || 0) + 1;
    if (o.type === 'booster') boosters[o.boosterType] = (boosters[o.boosterType] || 0) + 1;
  }
  return { mines, boosters, mineTotal: Object.values(mines).reduce((a, b) => a + b, 0) };
}
/** A layout fingerprint: every object's tile and kind, order-independent. */
const fingerprint = (state) => Object.values(state.map.objects)
  .map((o) => `${o.x},${o.y},${o.type},${o.mineType || o.boosterType || o.creature || ''}`)
  .sort().join('|');

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, ...data };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
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
const visit = (state, hero, spot) => {
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 3000;
  return stepHero(state, hero, { x: spot.x, y: spot.y, cost: 100 });
};

// ---- the feature is genuinely optional -------------------------------------

test('OFF by default: no Trade Fairs, and the map is byte-identical', () => {
  const a = build(7);
  assert.equal(census(a).boosters.tradeFair || 0, 0, 'a fair is Rich-Lands-only content');

  // Absent vs explicitly false must produce the SAME map: the feature draws no
  // rng when off, so every later placement lands on the same tile.
  const b = newGame({ seed: 7, players: P, mapW: 44, mapH: 38, features: {} });
  const c = newGame({ seed: 7, players: P, mapW: 44, mapH: 38, features: { richLands: false } });
  assert.equal(fingerprint(b), fingerprint(c), 'identical layout — the feature drew nothing');
});

test('ON changes the map (and is therefore actually wired to the generator)', () => {
  assert.notEqual(fingerprint(build(7)), fingerprint(build(7, { rich: true })));
});

// ---- what the husbandry economy actually yields ----------------------------

test('every resource is minable in the home zones, not just the contested band', () => {
  // Classic leaves exactly one of each rare on the whole map; Rich Lands seats a
  // set per zone plus a band spare, so no rare is a single point of failure.
  for (const seed of [1, 4, 9]) {
    const rich = census(build(seed, { rich: true })).mines;
    for (const kind of MINE_KINDS) {
      assert.ok((rich[kind] || 0) >= 2,
        `seed ${seed}: only ${rich[kind] || 0} ${kind} — a lone rare mine decides the map`);
    }
  }
});

test('a small map carries far more industry than Classic', () => {
  let classic = 0, rich = 0;
  const N = 8;
  for (let seed = 1; seed <= N; seed++) {
    classic += census(build(seed, { w: 36, h: 30 })).mineTotal;
    rich += census(build(seed, { rich: true, w: 36, h: 30 })).mineTotal;
  }
  const [c, r] = [classic / N, rich / N];
  assert.ok(r > c * 1.5, `${r.toFixed(1)} mines vs Classic's ${c.toFixed(1)} — not a meaningful uplift`);
  assert.ok(r >= 17, `${r.toFixed(1)} mines on a 36x30 — the smallest map should still be rich`);
});

test('the weekly circuit exists on EVERY seed — wheels no longer go missing', () => {
  // The crack this closes: Classic seated wheels last, needing shore adjacency,
  // and a 36x30 came up empty on 11 of 12 seeds.
  for (const [w, h] of [[36, 30], [44, 38], [52, 46]]) {
    for (let seed = 1; seed <= 8; seed++) {
      const b = census(build(seed, { rich: true, w, h })).boosters;
      // Wheels and fairs are exact: both are seated first, and wheels relax their
      // predicate until the quota is met.
      assert.equal(b.waterWheel || 0, CONFIG.RICH_LANDS_WATER_WHEELS,
        `${w}x${h} seed ${seed}: ${b.waterWheel || 0} water wheels`);
      assert.equal(b.tradeFair || 0, CONFIG.RICH_LANDS_TRADE_FAIRS, `${w}x${h} seed ${seed}: trade fairs`);
      // Windmills are best-effort — on a 36x30 the land genuinely runs out, and a
      // measured 1 is the floor. What must hold is the size of the CIRCUIT: enough
      // weekly stops that touring the realm is a standing job, whatever the mix.
      const stops = (b.waterWheel || 0) + (b.windmill || 0) + (b.tradeFair || 0);
      assert.ok(stops >= 7, `${w}x${h} seed ${seed}: only ${stops} weekly stops`);
    }
  }
});

// ---- the Trade Fair itself --------------------------------------------------

test('the Trade Fair is a registered visitable with a name and an effect', () => {
  assert.ok(BOOSTER_TYPES.includes('tradeFair'), 'listed, so its art key is generated and guarded');
  assert.equal(boosterName('tradeFair'), 'Trade Fair');
  assert.match(boosterEffect('tradeFair'), /week/i);
});

test('a Trade Fair pays a MIXED bundle — several goods plus coin', () => {
  const s = build(3, { rich: true });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, hero.x + 4, hero.y);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'tradeFair' });

  const before = { ...s.players[0].resources };
  const ev = visit(s, hero, spot);
  assert.equal(ev?.type, 'visited');
  assert.ok(!ev.noBenefit, 'a fresh fair pays out');

  const gained = RESOURCES.filter((r) => (s.players[0].resources[r] || 0) > (before[r] || 0));
  assert.ok(gained.includes('gold'), 'coin is part of the bundle');
  const goods = gained.filter((r) => r !== 'gold');
  assert.equal(goods.length, CONFIG.TRADE_FAIR_KINDS, `mixed: ${goods.length} goods (${goods.join(', ')})`);
  for (const g of goods) {
    const n = s.players[0].resources[g] - (before[g] || 0);
    assert.ok(n >= CONFIG.TRADE_FAIR_MIN && n <= CONFIG.TRADE_FAIR_MAX, `${g} +${n} within band`);
  }
  assert.equal(s.players[0].resources.gold - (before.gold || 0), CONFIG.TRADE_FAIR_GOLD);
});

test('a fair is drained for the WEEK, by whoever gets there first', () => {
  const s = build(3, { rich: true });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, hero.x + 4, hero.y);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'tradeFair' });

  visit(s, hero, spot);
  const after = { ...s.players[0].resources };
  const second = visit(s, hero, spot);
  assert.equal(second?.noBenefit, true, 'the stalls are packed away');
  assert.match(second.text, /next week/i);
  for (const r of RESOURCES) assert.equal(s.players[0].resources[r], after[r], `${r} unchanged on a dry visit`);

  // Next week it pays again — this is the standing job, not a one-shot.
  s.day += 7;
  assert.ok(!visit(s, hero, spot)?.noBenefit, 'the fair returns next week');
});

test('a fair beats a windmill on a single visit — worth the detour', () => {
  const s = build(3, { rich: true });
  const hero = playerHeroes(s, 0)[0];
  const goodsFrom = (boosterType, dx) => {
    const spot = clearBlock(s, hero.x + dx, hero.y);
    putObj(s, spot.x, spot.y, { type: 'booster', boosterType });
    const before = { ...s.players[0].resources };
    visit(s, hero, spot);
    return RESOURCES.filter((r) => (s.players[0].resources[r] || 0) > (before[r] || 0)).length;
  };
  assert.ok(goodsFrom('tradeFair', 4) > goodsFrom('windmill', 8),
    'a fair must pay more kinds than the mill it stands beside');
});
