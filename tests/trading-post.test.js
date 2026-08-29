/**
 * trading-post.test.js — the Trading Post (adventure-map visitable): sell any
 * artifact for experience, or buy one from the post's stock for resources.
 * Reusable (no `done`). Prices derive from ARTIFACTS[id].value. Engine only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, tileAt, serialize, deserialize } from '../src/core/GameState.js';
import { stepHero, sellArtifactForXp, sellArtifactsForXp, buyArtifactAt, tradingPostSellXp, tradingPostBuyCost } from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { ARTIFACTS, ARTIFACT_SETS } from '../src/data/artifacts.js';
import { Rng } from '../src/core/rng.js';
import { CONFIG } from '../src/config.js';

const SET_PIECES = new Set(Object.values(ARTIFACT_SETS).flatMap((s) => s.components || []));

const byVal = (v) => Object.keys(ARTIFACTS).find((id) => ARTIFACTS[id].value === v);
const V1 = byVal(1), V4 = byVal(4);

function seatPost(s, hero, stock) {
  // clear a patch and stand the hero left of a post
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const t = tileAt(s, 22 + dx, 20 + dy);
    if (t) { t.terrain = 'grass'; t.obstacle = null; t.objectId = null; }
  }
  const id = `O${s.map.nextOid++}`;
  const post = { id, x: 22, y: 20, type: 'tradingPost', stock };
  s.map.objects[id] = post;
  s.map.tiles[20 * s.map.w + 22].objectId = id;
  hero.x = 21; hero.y = 20; hero.z = 0; hero.mp = 2000;
  return post;
}

test('prices scale with artifact value', () => {
  assert.ok(tradingPostSellXp(V4) > tradingPostSellXp(V1), 'higher-value artifacts sell for more XP');
  assert.ok(tradingPostBuyCost(V4).gold > tradingPostBuyCost(V1).gold, 'and cost more to buy');
});

test('selling an artifact strips it from the hero and grants experience', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.equipment = { weapon: 'centaurAxe' }; hero.backpack = ['bootsOfSpeed'];
  const xp0 = hero.xp;
  const r = sellArtifactForXp(s, hero, 'centaurAxe');
  assert.ok(r.ok);
  assert.equal(hero.xp, xp0 + tradingPostSellXp('centaurAxe'), 'XP granted by value');
  assert.ok(!Object.values(hero.equipment).includes('centaurAxe'), 'worn artifact removed');
  // A backpack artifact sells too.
  assert.ok(sellArtifactForXp(s, hero, 'bootsOfSpeed').ok);
  assert.ok(!hero.backpack.includes('bootsOfSpeed'), 'carried artifact removed');
});

test('cannot sell an artifact the hero does not hold', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.equipment = {}; hero.backpack = [];
  assert.equal(sellArtifactForXp(s, hero, 'centaurAxe').ok, false);
});

test('the altar sacrifices a whole batch at once — sums XP, strips each piece', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.equipment = { weapon: 'centaurAxe' };
  hero.backpack = ['bootsOfSpeed', 'titansGladius'];
  const xp0 = hero.xp;
  const ids = ['centaurAxe', 'bootsOfSpeed', 'titansGladius'];
  const expected = ids.reduce((sum, id) => sum + tradingPostSellXp(id), 0);
  const r = sellArtifactsForXp(s, hero, ids);
  assert.ok(r.ok);
  assert.equal(r.count, 3, 'reports how many were sacrificed');
  assert.equal(r.xp, expected, 'sums the XP of every piece');
  assert.equal(hero.xp, xp0 + expected, 'grants the summed XP once');
  assert.ok(!Object.values(hero.equipment).includes('centaurAxe'), 'worn piece stripped');
  assert.deepEqual(hero.backpack, [], 'both carried pieces stripped');
});

test('sacrificing a duplicate id strips one instance per occurrence', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.equipment = {}; hero.backpack = ['bootsOfSpeed', 'bootsOfSpeed'];
  const r = sellArtifactsForXp(s, hero, ['bootsOfSpeed', 'bootsOfSpeed']);
  assert.equal(r.count, 2, 'both instances sold');
  assert.deepEqual(hero.backpack, [], 'both stripped');
});

test('an empty altar is a no-op', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const xp0 = hero.xp;
  const r = sellArtifactsForXp(s, hero, []);
  assert.equal(r.ok, false);
  assert.equal(hero.xp, xp0, 'no XP for an empty sacrifice');
});

test('buying from stock costs resources, hands the artifact over, and empties the slot', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const post = seatPost(s, hero, ['centaurAxe', 'bootsOfSpeed']);
  const cost = tradingPostBuyCost('centaurAxe');
  s.players[0].resources.gold = cost.gold + 100;
  s.players[0].resources.gems = cost.gems + 5;

  const r = buyArtifactAt(s, hero, post.id, 'centaurAxe');
  assert.ok(r.ok);
  const held = Object.values(hero.equipment).includes('centaurAxe') || hero.backpack.includes('centaurAxe');
  assert.ok(held, 'the artifact was handed to the hero');
  assert.ok(!post.stock.includes('centaurAxe'), 'and removed from the post stock');
  assert.equal(s.players[0].resources.gold, 100, 'gold spent');
  assert.equal(s.players[0].resources.gems, 5, 'gems spent');
});

test('cannot buy when too poor, or an item not in stock', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const post = seatPost(s, hero, ['titansGladius']);
  s.players[0].resources.gold = 0; s.players[0].resources.gems = 0;
  assert.equal(buyArtifactAt(s, hero, post.id, 'titansGladius').ok, false, 'too poor → no buy');
  assert.ok(post.stock.includes('titansGladius'), 'stock untouched');
  assert.equal(buyArtifactAt(s, hero, post.id, 'centaurAxe').ok, false, 'item not in stock');
});

test('stepping onto a trading post surfaces the hero\'s sellable artifacts and the stock', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.equipment = { weapon: 'centaurAxe' };
  const post = seatPost(s, hero, ['bootsOfSpeed', 'titansGladius']);
  const ev = stepHero(s, hero, { x: post.x, y: post.y, cost: 100 });
  assert.equal(ev.type, 'tradingPost');
  assert.ok(ev.sellable.some((a) => a.id === 'centaurAxe'), 'lists what the hero can sell');
  assert.equal(ev.stock.length, 2, 'lists the stock');
  assert.ok(ev.stock[0].cost && ev.stock[0].cost.gold > 0, 'stock carries a buy price');
});

test('a trading post round-trips through save/load with its stock', () => {
  const s = newGame({ seed: 3 });
  const id = `O${s.map.nextOid++}`;
  s.map.objects[id] = { id, x: 20, y: 20, type: 'tradingPost', stock: ['centaurAxe', 'titansGladius'] };
  const back = deserialize(serialize(s));
  assert.deepEqual(back.map.objects[id].stock, ['centaurAxe', 'titansGladius']);
});

test('generator seats trading posts on large maps with valid, unique, non-relic stock', () => {
  const towns = [];
  const map = generateMap({
    w: 60, h: 50, rng: new Rng(7),
    players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  const posts = Object.values(map.objects).filter((o) => o.type === 'tradingPost');
  assert.ok(posts.length >= 1, 'large map seats at least one trading post');
  for (const p of posts) {
    assert.ok(Array.isArray(p.stock) && p.stock.length >= 3, 'stock of 3+ artifacts');
    assert.equal(new Set(p.stock).size, p.stock.length, 'stock items are unique');
    for (const id of p.stock) {
      assert.ok(ARTIFACTS[id], `stock artifact ${id} is real`);
      assert.ok(!SET_PIECES.has(id), 'never a story-relic / set piece');
    }
    const t = map.tiles[p.y * map.w + p.x];
    assert.notEqual(t.terrain, 'water');
    assert.equal(t.obstacle, null);
  }
});


// ---------------------------------------------------------------------------
// Prices, and what is on the shelves
// ---------------------------------------------------------------------------

test('buy price and sell value are the same ladder, so no band is an arbitrage', () => {
  // Both sides are linear in the rarity band, which is what stops one band being
  // a better deal than another: buy low / sell high across bands must not pay.
  // (The round trip is a LOSS in the game's own money — CONFIG.XP_PER_GOLD is 18
  // experience per gold and the post gives about 11.7 — which is the property
  // that keeps a shop from being an experience pump.)
  const gEq = (c) => c.gold + c.gems * 150; // rares at the market's base rate
  const rate = [1, 2, 3, 4].map((v) => {
    const id = Object.keys(ARTIFACTS).find((a) => ARTIFACTS[a].value === v);
    assert.ok(id, `the catalog has a band-${v} artifact`);
    return tradingPostSellXp(id) / gEq(tradingPostBuyCost(id));
  });
  for (const r of rate) {
    assert.ok(Math.abs(r - rate[0]) < 1e-6, `experience per gold differs by band: ${rate.join(', ')}`);
    assert.ok(r < CONFIG.XP_PER_GOLD,
      `a buy-and-sell round trip pays ${r.toFixed(1)} XP per gold against the game's own ${CONFIG.XP_PER_GOLD} — the shop would be the cheapest experience on the map`);
  }
});

test('a post never stocks a campaign relic, by the flag and not by luck', () => {
  // Every campaign relic happens to also be a piece of the Panoply of the First
  // Dawn, so the set-piece filter covered them by coincidence. A story relic
  // outside a set would have walked straight onto a shelf. Both filters are
  // applied now; this asserts the one that is about the actual property.
  const campaign = Object.keys(ARTIFACTS).filter((id) => ARTIFACTS[id].campaign);
  assert.ok(campaign.length >= 3, 'there are campaign relics to exclude');
  for (const seed of [3, 14, 25, 36, 47]) {
    const towns = [];
    const map = generateMap({
      w: 60, h: 50, rng: new Rng(seed),
      players: [{ faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    });
    for (let m = map; m; m = m.underground) {
      for (const o of Object.values(m.objects || {})) {
        if (o.type !== 'tradingPost') continue;
        for (const id of o.stock) assert.ok(!ARTIFACTS[id].campaign, `a post stocked ${id}`);
      }
    }
  }
});

test('a post prefers to sell what the map did not already bury', () => {
  // A shop that mostly sells what is already lying under a guard on the same map
  // is a shop with nothing to say. On a map with slack in the catalog the stock
  // should come from the artifacts placement did NOT use; at sizes where the
  // catalog is exhausted by placement alone it falls back, and no assertion here
  // can or should demand otherwise.
  // FORTY seeds, not the eight this first used: a small map seats one post with
  // three or four items, so eight seeds is ~28 samples and the overlap is mostly
  // noise. On the eight originally picked the figure was 10.7% both before and
  // after the change — the test passed against the very code it was written to
  // catch. Over 40 seeds the same measurement reads 19.0% before and 8.0% after.
  let stocked = 0, alsoPlaced = 0;
  for (const seed of Array.from({ length: 40 }, (_, i) => 3 + i * 11)) {
    const towns = [];
    const map = generateMap({
      w: 44, h: 36, rng: new Rng(seed),
      players: [{ faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    });
    const placed = new Set(), stock = [];
    for (let m = map; m; m = m.underground) {
      for (const o of Object.values(m.objects || {})) {
        if (o.type === 'artifact') placed.add(o.artifact);
        if (o.type === 'tradingPost') stock.push(...o.stock);
      }
    }
    stocked += stock.length;
    alsoPlaced += stock.filter((id) => placed.has(id)).length;
  }
  assert.ok(stocked > 0, 'the sweep found stock');
  const overlap = alsoPlaced / stocked;
  // The surface ledger is complete when the posts are stocked; the caverns are
  // generated afterwards and can still land on a stocked relic, so this is a
  // bound rather than zero. It was 19% before the stock consulted the ledger.
  assert.ok(overlap <= 0.12,
    `${(overlap * 100).toFixed(0)}% of a small map's stock duplicates its own buried treasure (was 19% before the stock read the ledger)`);
});
