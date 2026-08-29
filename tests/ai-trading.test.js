/**
 * ai-trading.test.js — the AI can use Seer Huts and Trading Posts.
 *
 * It could not, at all: neither `seerHut` nor `tradingPost` appeared in the
 * object-scoring switch, so both buildings were invisible and the AI walked
 * past them. On a 96×80 map that is 5 posts and 7 huts a human can work and the
 * AI cannot — buying out every post and selling it back is roughly 1.1M
 * experience the AI had no way to reach.
 *
 * Two valuations and one transaction, each with its own hazard:
 *
 *   seerValue   — must NOT read the sealed reward. A hut hides its prize until
 *                 the tribute is offered; the generator's contract is that it is
 *                 worth at least twice the tribute, and the AI prices it off
 *                 that guarantee, so it plays by the promise the player is asked
 *                 to trust rather than by peeking.
 *   postValue   — must count only SURPLUS gear as sellable, and only real
 *                 upgrades as worth buying.
 *   tradeAtPost — order is everything: wear, buy, wear, sell. Any other order
 *                 sells the thing it just bought, or buys back what it sold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { endTurn, tradingPostSellXp } from '../src/core/actions.js';
import { ARTIFACTS } from '../src/data/artifacts.js';

const byVal = (v) => Object.keys(ARTIFACTS).find((id) => ARTIFACTS[id].value === v && !ARTIFACTS[id].campaign);

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
}

test('a Seer Hut is priced off its guarantee, never off its sealed reward', () => {
  const s = newGame({ seed: 5 });
  const ai = new AITurnController(s, 0);
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = 50000;

  const quest = { kind: 'resource', res: 'gold', amount: 4000 };
  // Same tribute, wildly different prizes. If the AI were reading the reward
  // these would price differently — and it would be playing with information the
  // player does not have.
  const cheap = { id: 'S1', type: 'seerHut', done: false, quest, reward: { kind: 'resource', res: 'gold', amount: 8000 } };
  const rich = { id: 'S2', type: 'seerHut', done: false, quest, reward: { kind: 'artifact', artifact: byVal(4) } };
  assert.equal(ai.seerValue(hero, cheap), ai.seerValue(hero, rich),
    'the AI is peeking at the sealed reward');
  assert.ok(ai.seerValue(hero, cheap) > 0, 'and it does value a payable hut');

  // Cannot pay → worthless, so the AI never marches on a hut it must turn away from.
  s.players[0].resources.gold = 10;
  assert.equal(ai.seerValue(hero, cheap), 0, 'an unpayable hut is worth nothing');

  // Already done → worthless.
  s.players[0].resources.gold = 50000;
  assert.equal(ai.seerValue(hero, { ...cheap, done: true }), 0);
});

test('a Trading Post is worth the surplus it can absorb and the upgrades it stocks', () => {
  const s = newGame({ seed: 6 });
  const ai = new AITurnController(s, 0);
  const hero = playerHeroes(s, 0)[0];
  const v1 = byVal(1), v4 = byVal(4);

  // Nothing to sell, nothing affordable → not worth a step.
  hero.equipment = {}; hero.backpack = [];
  for (const r of Object.keys(s.players[0].resources)) s.players[0].resources[r] = 0;
  assert.equal(ai.postValue(hero, { stock: [] }), 0, 'an empty post is worth nothing');

  // A relic the hero is already wearing a better one of is SURPLUS: sellable.
  hero.equipment = { weapon: v4 };
  hero.backpack = [v1];
  const surplus = ai.postValue(hero, { stock: [] });
  assert.ok(surplus > 0, 'the pack holds something the hero will not wear');

  // The same relic when the socket is EMPTY is not surplus — it is gear.
  hero.equipment = {};
  assert.equal(ai.postValue(hero, { stock: [] }), 0,
    'an artifact the hero would wear must not be priced as merchandise');

  // Stock is only worth something when it beats the socket AND is affordable.
  hero.equipment = { weapon: v4 }; hero.backpack = [];
  assert.equal(ai.postValue(hero, { stock: [v1] }), 0, 'a downgrade is worth nothing');
  s.players[0].resources.gold = 100000; s.players[0].resources.gems = 100;
  hero.equipment = {};
  assert.ok(ai.postValue(hero, { stock: [v4] }) > 0, 'an affordable upgrade is worth something');
  for (const r of Object.keys(s.players[0].resources)) s.players[0].resources[r] = 0;
  assert.equal(ai.postValue(hero, { stock: [v4] }), 0, 'an upgrade we cannot pay for is not a prize');
});

test('trading at a post wears, buys, wears, then sells — in that order', () => {
  const s = newGame({ seed: 7 });
  const ai = new AITurnController(s, 0);
  const hero = playerHeroes(s, 0)[0];
  const v1 = byVal(1), v4 = byVal(4);
  s.players[0].resources.gold = 100000; s.players[0].resources.gems = 100;

  clearBlock(s, 22, 20);
  const post = putObj(s, 22, 20, { type: 'tradingPost', stock: [v4] });
  hero.equipment = {};
  hero.backpack = [v1];               // a trinket for the same slot as the relic
  const xp0 = hero.xp;

  ai.tradeAtPost(hero, post.id);

  const worn = Object.values(hero.equipment).filter(Boolean);
  assert.ok(worn.includes(v4), 'the upgrade was bought AND put on');
  assert.ok(!hero.backpack.includes(v4), 'and not left in the pack to be sold again');
  assert.ok(!post.stock.includes(v4), 'the shelf is emptied');
  // The trinket it displaced is surplus and became experience.
  assert.ok(!hero.backpack.includes(v1) && !worn.includes(v1), 'the displaced trinket is gone');
  assert.equal(hero.xp, xp0 + tradingPostSellXp(v1), 'sold for exactly its listed price');
});

test('the AI never sells the gear it is wearing', () => {
  // sellArtifactsForXp strips a worn socket before it looks in the pack, so a
  // careless "sell everything" would strip the hero bare for experience.
  const s = newGame({ seed: 8 });
  const ai = new AITurnController(s, 0);
  const hero = playerHeroes(s, 0)[0];
  const v4 = byVal(4), v3 = byVal(3);
  for (const r of Object.keys(s.players[0].resources)) s.players[0].resources[r] = 0;

  clearBlock(s, 22, 20);
  const post = putObj(s, 22, 20, { type: 'tradingPost', stock: [] });
  hero.equipment = {}; hero.backpack = [v4, v3];
  ai.tradeAtPost(hero, post.id);

  const worn = Object.values(hero.equipment).filter(Boolean);
  assert.ok(worn.length >= 1, 'the hero came away wearing something');
  for (const id of worn) {
    assert.ok([v4, v3].includes(id), 'and it is one of the pieces it arrived with');
  }
});

test('the AI reaches a Seer Hut it can pay for, and comes away with the reward', () => {
  // End to end: the hut must be visible to the goal picker, marched on, and
  // fulfilled on arrival — all three were missing.
  const s = newGame({ seed: 11 });
  const hero = playerHeroes(s, 1)[0];
  s.players[1].resources.gold = 40000;

  clearBlock(s, hero.x + 2, hero.y, 2);
  const hut = putObj(s, hero.x + 2, hero.y, {
    type: 'seerHut',
    done: false,
    quest: { kind: 'resource', res: 'gold', amount: 3000 },
    // An ARTIFACT reward, because gold is confounded: the AI collects income,
    // recruits and pays upkeep across the days this takes, so a treasury figure
    // could not tell us whether the hut paid out. A named relic in the hero's
    // hands can only have come from here.
    reward: { kind: 'artifact', artifact: byVal(4) },
  });

  // Run the AI's turns until it gets there (a few days of grace — the hut is two
  // tiles away, but the hero may have a better first errand).
  for (let day = 0; day < 4 && !hut.done; day++) {
    while (s.currentPlayer !== 1) endTurn(s);
    const ai = new AITurnController(s, 1);
    let r, guard = 300;
    do { r = ai.next(); if (r.type === 'combat') ai.autoFight(r.context); } while (r.type !== 'done' && guard-- > 0);
    endTurn(s);
  }
  assert.equal(hut.done, true, 'the AI never visited a hut two tiles from its hero');
  const carriers = Object.values(s.heroes).filter((h) => h.owner === 1
    && (Object.values(h.equipment || {}).includes(byVal(4)) || (h.backpack || []).includes(byVal(4))));
  assert.ok(carriers.length >= 1, 'it paid the tribute but the reward never reached a hero');
});
