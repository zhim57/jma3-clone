/**
 * site-respawn.test.js — an emptied reward site is reoccupied four weeks on.
 *
 * The map is a place, not a checklist. A Pandora's Box, a Creature Bank, a boss
 * lair and a Seer Hut were all one-shot: cleared once, then a dead tile for the
 * rest of a sixty-week game. The `siteRespawn` feature re-seats them, and three
 * things about the reload are the whole point:
 *
 *   1. The content ROTATES. A bank draws a new tenant from its own tier, a box
 *      rolls a fresh reward, a hut a fresh quest — the site is a different
 *      proposition the second time, not a repeat.
 *   2. The tier is preserved. A plain bank rotates among plain banks and a boss
 *      lair among boss lairs, so a reload can turn a Dwarven Treasury into a
 *      Dragon Utopia but can never mint a second Archangel Spire — "one apex
 *      prize per map" survives.
 *   3. It is TIDE-SIZED from the start. The ordinary tide only inflates a
 *      defender when a human attacks it, at the moment of battle; a reoccupied
 *      site bakes the size into the object, so it is a real fight for the AI too
 *      and it LOOKS like one on the map.
 *
 * It is ON by default — in the ENGINE and not only in the Settings menu, so a
 * headless balance probe measures the game people actually play — and a player
 * who turns it off gets the old behaviour exactly: nothing stamped, nothing
 * drawn, nothing changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, featureOn, DEFAULT_ON_FEATURES } from '../src/core/GameState.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { Rng } from '../src/core/rng.js';
import { endTurn, applyCombatResult, stepHero, fulfillSeerQuest } from '../src/core/actions.js';
import { CREATURES } from '../src/data/creatures.js';
import { CREATURE_BANKS, BOSS_LAIRS, bankDef } from '../src/data/creatureBanks.js';
import { CONFIG } from '../src/config.js';

const guardWorth = (g) => (g || []).reduce((n, st) => n + (CREATURES[st.creature]?.aiValue || 0) * st.count, 0);

function game(features = {}) {
  // No `siteRespawn` key on purpose: the feature is ON by default, and every
  // test below that does not say otherwise is therefore also a test that the
  // default is real rather than only a Settings checkbox.
  const s = newGame({ seed: 31, features });
  return s;
}
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
/** Advance whole days without running anybody's turn. */
function skipDays(s, days) {
  for (let i = 0; i < days * s.players.length; i++) endTurn(s);
}
const win = (hero) => ({ attackerWon: true, attackerArmy: hero.army.filter(Boolean).map((st) => ({ ...st })), defenderArmy: [], xp: 500 });

test('a plundered bank is reoccupied after the configured wait, and not before', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, 22, 20);
  const bank = putObj(s, 22, 20, {
    type: 'creatureBank', bankType: 'dwarvenTreasury', looted: false,
    guards: CREATURE_BANKS.dwarvenTreasury.guards.map((g) => ({ ...g })),
  });
  hero.x = bank.x - 1; hero.y = bank.y; hero.z = 0; hero.mp = 2000;
  const ctx = stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 }).context;
  applyCombatResult(s, ctx, win(hero));
  assert.equal(bank.looted, true, 'plundered');
  assert.ok(bank.respawnAt > s.day, 'and the clock is running');

  const due = bank.respawnAt;
  skipDays(s, CONFIG.SITE_RESPAWN_WEEKS * CONFIG.DAYS_PER_WEEK - 2);
  assert.equal(bank.looted, true, `still empty on day ${s.day} (due ${due})`);

  skipDays(s, CONFIG.DAYS_PER_WEEK);
  assert.equal(bank.looted, false, 'reoccupied once the wait is up');
  assert.ok(bank.guards.length > 0 && guardWorth(bank.guards) > 0, 'with a real guard');
  assert.equal(bank.brood, 0, 'and no stale brood left from while it stood empty');
  assert.ok(!(bank.respawnAt > 0), 'the clock is cleared, so it does not reload again immediately');
});

test('a reload rotates the tenant within its own tier — never across it', () => {
  // A plain bank may become any plain bank; a boss lair may become any boss
  // lair. Crossing the two would either mint a second apex prize on a map that
  // is meant to hold one, or quietly demote the map's marquee site to a
  // Dwarven Treasury.
  const plain = new Set(Object.keys(CREATURE_BANKS));
  const boss = new Set(Object.keys(BOSS_LAIRS));
  const seenPlain = new Set(), seenBoss = new Set();

  for (const [startType, bucket, seen] of [
    ['dwarvenTreasury', plain, seenPlain],
    ['phoenixRoost', boss, seenBoss],
  ]) {
    for (let seed = 1; seed <= 25; seed++) {
      const s = newGame({ seed, features: {} });
      clearBlock(s, 22, 20);
      const bank = putObj(s, 22, 20, {
        type: 'creatureBank', bankType: startType, looted: true,
        respawnAt: s.day + 1, guards: [],
      });
      skipDays(s, CONFIG.DAYS_PER_WEEK * CONFIG.SITE_RESPAWN_WEEKS);
      assert.equal(bank.looted, false, 'it did reload');
      assert.ok(bucket.has(bank.bankType), `${startType} reloaded as ${bank.bankType}, out of its tier`);
      seen.add(bank.bankType);
    }
  }
  assert.ok(seenPlain.size > 1, `a plain bank always reloaded as ${[...seenPlain]} — no rotation`);
  assert.ok(seenBoss.size > 1, `a boss lair always reloaded as ${[...seenBoss]} — no rotation`);
});

test('a reoccupied site is tide-sized from the start, and never scaled down', () => {
  // The ordinary tide only inflates a defender when a HUMAN attacks it, at the
  // moment of battle. That leaves the AI facing a four-week-old guard table and
  // leaves the site reading as a walkover on the map. Baking the size in at
  // reload is what makes the second visit worth the trip.
  //
  // What it is sized AGAINST is the realm whose ground the site stands on, not
  // the world's leader — see site-respawn-sizing.test.js for why that changed.
  // So this pins the property that survives either way: the reload is scaled to
  // the realm that owns the country around it, and never below the site's own
  // authored table. The whole map is one realm's here, so the two readings
  // coincide and the test says the same thing it always did.
  const s = game();
  for (const t of Object.values(s.towns)) t.owner = 0;   // one realm holds the country
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 40, hurt: 0 }, null, null, null, null, null, null];
  for (const h of Object.values(s.heroes)) if (h.owner !== 0) h.army = [null, null, null, null, null, null, null];
  for (const t of Object.values(s.towns)) t.garrison = [null, null, null, null, null, null, null];
  const mighty = 40 * CREATURES.archangel.aiValue;

  clearBlock(s, 22, 20);
  const bank = putObj(s, 22, 20, {
    type: 'creatureBank', bankType: 'dwarvenTreasury', looted: true,
    respawnAt: s.day + 1, guards: [],
  });
  skipDays(s, CONFIG.DAYS_PER_WEEK * CONFIG.SITE_RESPAWN_WEEKS);

  const hardness = Number.isFinite(s.tideHardness) ? s.tideHardness : CONFIG.SITE_RESPAWN_TIDE;
  const authored = guardWorth(bankDef(bank.bankType).guards);
  assert.ok(guardWorth(bank.guards) >= mighty * hardness * 0.9,
    `reloaded at ${guardWorth(bank.guards)} in the country of a realm fielding ${mighty} — not tide-sized`);
  assert.ok(guardWorth(bank.guards) >= authored,
    'and never weaker than the bank\'s own table');
});

test('a site whose own table outweighs the world keeps its teeth', () => {
  // Scaling is one-way. A boss lair reoccupied in week five, when the strongest
  // hero is still small, must not be shrunk to match — the tide raises floors,
  // it does not level mountains.
  const s = game();
  for (const h of Object.values(s.heroes)) h.army = [{ creature: 'peasant', count: 5, hurt: 0 }, null, null, null, null, null, null];
  clearBlock(s, 22, 20);
  const lair = putObj(s, 22, 20, {
    type: 'creatureBank', bankType: 'archangelSpire', looted: true,
    respawnAt: s.day + 1, guards: [],
  });
  skipDays(s, CONFIG.DAYS_PER_WEEK * CONFIG.SITE_RESPAWN_WEEKS);
  assert.equal(lair.looted, false);
  assert.ok(guardWorth(lair.guards) >= guardWorth(bankDef(lair.bankType).guards),
    'a lair was shrunk to fit a peasant army');
});

test('a box and a hut reload too, with fresh contents', () => {
  const s = game();
  clearBlock(s, 22, 20); clearBlock(s, 26, 20);
  const box = putObj(s, 22, 20, { type: 'pandora', looted: true, respawnAt: s.day + 1, reward: null, guards: [] });
  const hut = putObj(s, 26, 20, {
    type: 'seerHut', done: true, respawnAt: s.day + 1,
    quest: { kind: 'resource', res: 'gold', amount: 1 }, reward: { kind: 'resource', res: 'gold', amount: 2 },
  });
  skipDays(s, CONFIG.DAYS_PER_WEEK * CONFIG.SITE_RESPAWN_WEEKS);

  assert.equal(box.looted, false, 'the box is sealed again');
  assert.ok(box.reward && box.reward.kind, 'with a freshly rolled reward');
  assert.equal(hut.done, false, 'the hut is open again');
  assert.ok(hut.quest.amount > 1, 'with a real quest rather than the stub it replaced');
  // The hut's own contract survives a reload: still worth at least twice the ask.
  const WORTH = { wood: 150, ore: 150, mercury: 350, sulfur: 350, crystal: 350, gems: 350, gold: 1 };
  const tribute = hut.quest.amount * (WORTH[hut.quest.res] || 1);
  if (hut.reward.kind === 'resource') assert.ok(hut.reward.amount * (WORTH[hut.reward.res] || 1) >= tribute * 2);
  if (hut.reward.kind === 'xp') assert.ok(hut.reward.amount / CONFIG.XP_PER_GOLD >= tribute * 2);
});

test('the rule is on by default in the ENGINE, not only in the menus', () => {
  // Flipping only the Settings default would give menu-started games one ruleset
  // and every headless game — the balance probes, the AI benchmarks, any
  // programmatic newGame — another, so a measurement would quietly describe a
  // game nobody plays. `featureOn` therefore reads a default-on list, and this
  // pins both halves of it.
  assert.ok(DEFAULT_ON_FEATURES.has('siteRespawn'), 'listed as on-by-default');
  assert.equal(featureOn(newGame({ seed: 2 }), 'siteRespawn'), true,
    'a game that never mentions the key still has it');
  assert.equal(featureOn(newGame({ seed: 2, features: { siteRespawn: false } }), 'siteRespawn'), false,
    'and an explicit refusal still wins');
  // The inversion must be per-key: an ordinary optional feature is still OFF
  // when absent, which is what keeps old saves and seeded tests reading Classic.
  assert.equal(featureOn(newGame({ seed: 2 }), 'lairBrood'), false,
    'the default-on list leaked onto every feature');
});

test('turned off explicitly, nothing is stamped, drawn or changed', () => {
  // The gate is what lets a player opt out completely: no field written on the
  // object, and no rng drawn at the week turn.
  const s = newGame({ seed: 31, features: { siteRespawn: false } });
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, 22, 20);
  const bank = putObj(s, 22, 20, {
    type: 'creatureBank', bankType: 'dwarvenTreasury', looted: false,
    guards: CREATURE_BANKS.dwarvenTreasury.guards.map((g) => ({ ...g })),
  });
  hero.x = bank.x - 1; hero.y = bank.y; hero.z = 0; hero.mp = 2000;
  const ctx = stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 }).context;
  applyCombatResult(s, ctx, win(hero));
  assert.equal(bank.respawnAt, undefined, 'no clock is written at all');

  const before = s.rng.state ?? null;
  skipDays(s, CONFIG.DAYS_PER_WEEK * (CONFIG.SITE_RESPAWN_WEEKS + 1));
  assert.equal(bank.looted, true, 'and it stays empty for good');
  void before;
});

test('a seer hut reloads only after it was actually fulfilled', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = 50000;
  clearBlock(s, 22, 20);
  const hut = putObj(s, 22, 20, {
    type: 'seerHut', done: false,
    quest: { kind: 'resource', res: 'gold', amount: 2000 },
    reward: { kind: 'resource', res: 'gold', amount: 6000 },
  });
  assert.equal(hut.respawnAt, undefined, 'an unfulfilled hut has no clock');
  assert.equal(fulfillSeerQuest(s, hero, hut.id).ok, true);
  assert.ok(hut.respawnAt > s.day, 'fulfilling starts it');
});


test('"one apex prize per map" survives any number of reloads', () => {
  // The tier test above pins ONE site. This asks the question that actually
  // matters after a site can recycle: can a whole MAP end up with two apexes?
  //
  // Structurally it should be impossible — respawnSites mutates objects in place
  // and never creates one, and a bank draws from `BOSS_LAIRS[type] ?
  // BOSS_LAIR_TYPES : BANK_TYPES`, so a plain bank cannot promote itself. But
  // "should be impossible" is what a test is for, and the generator seats the
  // single lair through a different path entirely (placeBossLairs), so nothing
  // else was watching the two together.
  //
  // Every bank on a real generated map is forced through repeated reload cycles
  // — far more churn than a real game produces — and the map-wide count is
  // checked after each one.
  let boss = 0, plain = 0, reloads = 0;
  for (const seed of [3, 14, 25, 36]) {
    const towns = [];
    const map = generateMap({
      w: 72, h: 60, rng: new Rng(seed),
      players: [{ faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    });
    const s = newGame({ seed });
    s.map = map;
    const banks = [];
    for (let m = map; m; m = m.underground) {
      for (const o of Object.values(m.objects || {})) if (o.type === 'creatureBank') banks.push(o);
    }
    assert.ok(banks.length >= 2, `seed ${seed} seated ${banks.length} banks`);
    const lairsAtGen = banks.filter((b) => BOSS_LAIRS[b.bankType]).length;
    assert.ok(lairsAtGen <= 1, `seed ${seed} generated with ${lairsAtGen} boss lairs`);

    for (let round = 0; round < 6; round++) {
      for (const b of banks) { b.looted = true; b.respawnAt = s.day + 1; }
      skipDays(s, CONFIG.DAYS_PER_WEEK * CONFIG.SITE_RESPAWN_WEEKS);
      for (const b of banks) {
        assert.ok(bankDef(b.bankType), `a reload produced the unknown bank type ${b.bankType}`);
        if (BOSS_LAIRS[b.bankType]) boss++; else plain++;
        if (!b.looted) reloads++;
      }
      const live = banks.filter((b) => BOSS_LAIRS[b.bankType]).length;
      assert.ok(live <= 1,
        `seed ${seed} round ${round}: ${live} boss lairs alive at once — a reload minted a second apex`);
    }
  }
  assert.ok(reloads > 50, `only ${reloads} reloads exercised — the sweep is not doing its job`);
  assert.ok(boss > 0 && plain > 0, 'both tiers were exercised');
});
