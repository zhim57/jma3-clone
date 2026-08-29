/**
 * seer-huts.test.js — Seer Huts: fetch-quest visitables (quest layer, part 2a).
 *
 * A Seer Hut carries a quest fixed at generation (v1: bring a resource tribute)
 * and a one-time reward (gold / experience / an artifact). The claim is GLOBAL
 * (obj.done) — once any hero completes it the seer has nothing left. Resolved by
 * actions.visitSeerHut (event) + fulfillSeerQuest (the dialog's hand-in).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { stepHero, fulfillSeerQuest, seerQuestText, seerRewardText } from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { ARTIFACTS, ARTIFACT_SETS, artifactBandCost } from '../src/data/artifacts.js';
import { CREATURES } from '../src/data/creatures.js';
import { Rng } from '../src/core/rng.js';
import { CONFIG } from '../src/config.js';

// Mirror of the generator's tribute-worth table (used to assert net-positive rewards).
const RES_WORTH = { wood: 150, ore: 150, mercury: 350, sulfur: 350, crystal: 350, gems: 350, gold: 1 };
const SET_PIECES = new Set(Object.values(ARTIFACT_SETS).flatMap((s) => s.components || []));

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
/** Place a seer hut one tile right of a cleared spot and stand the hero at its left. */
function seatHut(s, hero, quest, reward) {
  const spot = clearBlock(s, 22, 20, 2);
  const hut = putObj(s, spot.x, spot.y, { type: 'seerHut', done: false, quest, reward });
  hero.x = spot.x - 1; hero.y = spot.y; hero.z = 0; hero.mp = 2000;
  return hut;
}
const step = (s, hero, hut) => stepHero(s, hero, { x: hut.x, y: hut.y, cost: 100 });

test('text helpers describe the tribute and the reward', () => {
  assert.equal(seerQuestText({ kind: 'resource', res: 'ore', amount: 10 }), '10 ore');
  assert.equal(seerQuestText({ kind: 'resource', res: 'gold', amount: 2000 }), '2000 gold');
  assert.equal(seerRewardText({ kind: 'xp', amount: 3000 }), '3000 experience');
  assert.equal(seerRewardText({ kind: 'resource', res: 'gold', amount: 5000 }), '5000 gold');
  const anyArt = Object.keys(ARTIFACTS)[0];
  assert.equal(seerRewardText({ kind: 'artifact', artifact: anyArt }), ARTIFACTS[anyArt].name);
  assert.equal(seerRewardText({ kind: 'creatures', creature: 'archangel', count: 3 }), `3 ${CREATURES.archangel.name}s`);
  assert.equal(seerRewardText({ kind: 'creatures', creature: 'archangel', count: 1 }), `1 ${CREATURES.archangel.name}`);
});

test('reward kind: a creature warband is added to the visiting hero\'s army', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = 10000;
  const before = hero.army.filter((st) => st && st.creature === 'archangel').reduce((n, st) => n + st.count, 0);
  const hut = seatHut(s, hero, { kind: 'resource', res: 'gold', amount: 4000 }, { kind: 'creatures', creature: 'archangel', count: 3 });
  const r = fulfillSeerQuest(s, hero, hut.id);
  assert.equal(r.ok, true);
  const after = hero.army.filter((st) => st && st.creature === 'archangel').reduce((n, st) => n + st.count, 0);
  assert.equal(after, before + 3, 'the 3 archangels joined the army');
});

test('fetch → gold: fulfilling consumes the tribute, pays the reward, marks done globally', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const player = s.players[0];
  const hut = seatHut(s, hero, { kind: 'resource', res: 'ore', amount: 10 }, { kind: 'resource', res: 'gold', amount: 3000 });
  player.resources.ore = 12;
  const gold0 = player.resources.gold;

  const ev = step(s, hero, hut);
  assert.equal(ev.type, 'seerHut');
  assert.equal(ev.done, false);
  assert.equal(ev.canFulfill, true, 'has the tribute');
  assert.match(ev.questText, /10 ore/);
  assert.doesNotMatch(ev.rewardText, /3000|gold/, 'the reward is SEALED before paying — no magnitude leaked');
  assert.match(ev.rewardText, /worthy of your tribute/, 'shows the teaser instead');

  const r = fulfillSeerQuest(s, hero, hut.id);
  assert.equal(r.ok, true);
  assert.equal(player.resources.ore, 2, 'tribute consumed');
  assert.equal(player.resources.gold, gold0 + 3000, 'reward paid');
  assert.equal(hut.done, true, 'globally complete');

  // A second visit finds nothing to do (step off the hut, then back onto it).
  stepHero(s, hero, { x: hut.x - 1, y: hut.y, cost: 100 });
  const ev2 = step(s, hero, hut);
  assert.equal(ev2.done, true);
  assert.equal(fulfillSeerQuest(s, hero, hut.id).ok, false, 'no double reward');
});

test('cannot fulfill without the tribute — nothing is consumed', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const player = s.players[0];
  const hut = seatHut(s, hero, { kind: 'resource', res: 'gems', amount: 15 }, { kind: 'resource', res: 'gold', amount: 4000 });
  player.resources.gems = 3; // short
  const gold0 = player.resources.gold;

  const ev = step(s, hero, hut);
  assert.equal(ev.canFulfill, false);
  const r = fulfillSeerQuest(s, hero, hut.id);
  assert.equal(r.ok, false);
  assert.equal(player.resources.gems, 3, 'tribute untouched');
  assert.equal(player.resources.gold, gold0, 'no reward');
  assert.equal(hut.done, false, 'still open');
});

test('reward kinds: experience grants XP, artifact is handed to the hero', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.wood = 50;

  // XP reward
  const xpHut = seatHut(s, hero, { kind: 'resource', res: 'wood', amount: 5 }, { kind: 'xp', amount: 2000 });
  const xp0 = hero.xp;
  assert.equal(fulfillSeerQuest(s, hero, xpHut.id).ok, true);
  assert.equal(hero.xp, xp0 + 2000, 'experience awarded');

  // Artifact reward
  const artId = Object.keys(ARTIFACTS)[0];
  const artHut = seatHut(s, hero, { kind: 'resource', res: 'wood', amount: 5 }, { kind: 'artifact', artifact: artId });
  assert.equal(fulfillSeerQuest(s, hero, artHut.id).ok, true);
  const held = Object.values(hero.equipment).includes(artId) || hero.backpack.includes(artId);
  assert.equal(held, true, 'artifact given to the hero');
});

test('generator: seer huts appear on large maps (valid payloads), none below the reference size', () => {
  // Sweep several seeds so every reward branch (gold / xp / warband / relic) is
  // exercised and the net-positive invariant is checked broadly, not on one roll.
  const huts = [];
  let bigMap;
  for (let seed = 1; seed <= 10; seed++) {
    const towns = [];
    bigMap = generateMap({
      w: 60, h: 50, rng: new Rng(seed),
      players: [{ faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    });
    for (const o of Object.values(bigMap.objects)) if (o.type === 'seerHut') huts.push({ h: o, map: bigMap });
  }
  assert.ok(huts.length >= 1, 'large maps seat seer huts');
  const kinds = new Set(huts.map(({ h }) => h.reward.kind));
  assert.ok(kinds.size >= 2, 'the sweep exercises multiple reward kinds');
  for (const { h, map } of huts) {
    assert.equal(h.done, false);
    assert.equal(h.quest.kind, 'resource');
    assert.ok(h.quest.amount > 0);
    assert.ok(['resource', 'xp', 'creatures', 'artifact'].includes(h.reward.kind));
    // Shape only here; the 2x promise gets its own test below, in one currency.
    if (h.reward.kind === 'creatures') {
      assert.ok(CREATURES[h.reward.creature] && h.reward.count >= 2, 'a real, sizeable warband');
    } else if (h.reward.kind === 'artifact') {
      assert.ok(ARTIFACTS[h.reward.artifact], 'reward artifact is real');
      assert.ok((ARTIFACTS[h.reward.artifact].value || 0) >= 2, 'never a value-1 trinket');
      assert.ok(!SET_PIECES.has(h.reward.artifact), 'never a story-relic / set piece');
    }
    // stands on non-water land, no obstacle
    const t = map.tiles[h.y * map.w + h.x];
    assert.notEqual(t.terrain, 'water');
    assert.equal(t.obstacle, null);
  }

  const townsSmall = [];
  const small = generateMap({
    w: 36, h: 30, rng: new Rng(7),
    players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${townsSmall.length}`; t.id = id; townsSmall.push(t); return id; },
  });
  assert.equal(Object.values(small.objects).filter((o) => o.type === 'seerHut').length, 0,
    'small maps stay lean (scale < 1) — byte-identical to the pre-feature baseline');
});

test('a seer hut round-trips through save/load with its quest, reward and done flag', () => {
  const s = newGame({ seed: 3 });
  const hut = putObj(s, 20, 20, {
    type: 'seerHut', done: true,
    quest: { kind: 'resource', res: 'mercury', amount: 7 },
    reward: { kind: 'artifact', artifact: Object.keys(ARTIFACTS)[0] },
  });
  const r = deserialize(serialize(s));
  const back = r.map.objects[hut.id];
  assert.equal(back.type, 'seerHut');
  assert.equal(back.done, true);
  assert.equal(back.quest.res, 'mercury');
  assert.equal(back.quest.amount, 7);
  assert.equal(back.reward.kind, 'artifact');
});


// ---------------------------------------------------------------------------
// The bargain
// ---------------------------------------------------------------------------
//
// A hut's whole promise, stated in its own generator: "The reward is ALWAYS
// worth clearly more than the tribute (>=2x) — no more 'pay 6000 gold, get
// 3000'." Two of the four reward branches did not keep it, because they compute
// a gold target and then snap it to a DISCRETE unit — a stack of creatures, a
// rung on the artifact ladder — and the snapping was free to round down.
//
// Measured over 270 huts before the fix: the warband branch paid a median 1.20x
// and fell under 2x on 99% of huts, one of them at 0.77x — literally the deal
// the comment says was fixed. The relic branch fell short on 55%: a 20-mercury
// tribute against the best relic in the game is 1.31x, because an artifact's
// worth is capped by the catalog however large the tribute grows.
//
// Everything is priced in the hut's OWN money (RES_WORTH), the same rates it
// takes tribute in — comparing a reward valued one way against a tribute valued
// another is how a shortfall hides.

const seerWorth = (r) => {
  if (r.kind === 'resource') return r.amount * (RES_WORTH[r.res] || 1);
  if (r.kind === 'xp') return r.amount / CONFIG.XP_PER_GOLD;
  if (r.kind === 'creatures') return (CREATURES[r.creature]?.cost?.gold || 0) * r.count;
  if (r.kind === 'artifact') {
    const c = artifactBandCost(ARTIFACTS[r.artifact].value);
    return c.gold + c.gems * RES_WORTH.gems;
  }
  return 0;
};

const sweepHuts = (seeds) => {
  const out = [];
  for (const seed of seeds) {
    const towns = [];
    const map = generateMap({
      w: 60, h: 50, rng: new Rng(seed),
      players: [{ faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    });
    for (let m = map; m; m = m.underground) {
      for (const o of Object.values(m.objects || {})) if (o.type === 'seerHut') out.push(o);
    }
  }
  return out;
};

test('every seer hut pays at least twice what it asks — in every reward branch', () => {
  const huts = sweepHuts(Array.from({ length: 60 }, (_, i) => 200 + i));
  assert.ok(huts.length >= 40, `the sweep found ${huts.length} huts`);
  const seen = new Set();
  for (const h of huts) {
    seen.add(h.reward.kind);
    const tribute = h.quest.amount * (RES_WORTH[h.quest.res] || 1);
    const worth = seerWorth(h.reward);
    assert.ok(worth >= tribute * 2,
      `pay ${h.quest.amount} ${h.quest.res} (${tribute}) for ${JSON.stringify(h.reward)} (${Math.round(worth)}) = ${(worth / tribute).toFixed(2)}x`);
  }
  // All four branches must be in the sample, or the test is only guarding some.
  for (const k of ['resource', 'xp', 'creatures', 'artifact']) {
    assert.ok(seen.has(k), `the sweep never produced a ${k} reward — the guarantee is untested for it`);
  }
});

test('a hut that cannot pay a relic pays gold instead of a short one', () => {
  // An artifact's worth is a ladder that ends: past a tribute the top band
  // cannot double, no relic can honour the promise. The branch must fall through
  // rather than hand over the best it has and call it a bargain.
  const huts = sweepHuts(Array.from({ length: 60 }, (_, i) => 200 + i));
  const topWorth = (() => {
    const top = Math.max(...Object.values(ARTIFACTS).map((a) => a.value));
    const c = artifactBandCost(top);
    return c.gold + c.gems * RES_WORTH.gems;
  })();
  const rich = huts.filter((h) => h.quest.amount * (RES_WORTH[h.quest.res] || 1) * 2 > topWorth);
  assert.ok(rich.length, 'the sweep contains tributes no relic can double');
  for (const h of rich) {
    assert.notEqual(h.reward.kind, 'artifact',
      `a ${h.quest.amount}-${h.quest.res} tribute was answered with ${h.reward.artifact}, which cannot be worth twice it`);
  }
});

test('a full army does not pay a tribute for a warband it cannot hold', () => {
  // The one reward path that CHARGES before it pays. fulfillSeerQuest called
  // addToArmy and threw the answer away, so a hero with every slot full paid the
  // tribute, watched the hut close, and received nothing at all.
  const s = newGame({ seed: 91 });
  const hero = playerHeroes(s, 0)[0];
  const filler = ['pikeman', 'archer', 'griffin', 'swordsman', 'monk', 'cavalier', 'angel']
    .filter((id) => CREATURES[id]);
  hero.army = filler.slice(0, hero.army.length).map((creature) => ({ creature, count: 5, hurt: 0 }));
  assert.ok(hero.army.every((st) => st && st.count > 0), 'the hero has no free slot');

  const quest = { kind: 'resource', res: 'gold', amount: 3000 };
  const reward = { kind: 'creatures', creature: 'behemoth', count: 3 };
  const hut = seatHut(s, hero, quest, reward);
  const goldBefore = s.players[0].resources.gold;

  const res = fulfillSeerQuest(s, hero, hut.id);
  assert.equal(res.ok, false, 'the hut refuses');
  assert.equal(res.reason, 'armyFull', 'and says why');
  assert.equal(s.players[0].resources.gold, goldBefore, 'the tribute was NOT taken');
  assert.equal(hut.done, false, 'and the hut is still there for a hero with room');

  // Make room and the same hut pays out normally.
  hero.army[hero.army.length - 1] = null;
  const ok = fulfillSeerQuest(s, hero, hut.id);
  assert.equal(ok.ok, true);
  assert.equal(hut.done, true);
  assert.ok(hero.army.some((st) => st && st.creature === 'behemoth' && st.count === 3), 'the warband arrived');
  assert.equal(s.players[0].resources.gold, goldBefore - 3000, 'and now the tribute was taken');
});
