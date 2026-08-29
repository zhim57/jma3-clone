/**
 * creature-banks.test.js — Creature Banks: guarded one-time reward sites (map RPG
 * layer, part B). A bank has a fixed guard army; beat it (combatContext →
 * applyCombatResult) to plunder resources/creatures/an artifact and empty it
 * (obj.looted). A repelled assault thins the guard. Engine only, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CREATURES } from '../src/data/creatures.js';
import { CREATURE_BANKS, BANK_TYPES, BOSS_LAIRS, bankDef } from '../src/data/creatureBanks.js';
import { ARTIFACTS } from '../src/data/artifacts.js';
import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { stepHero, applyCombatResult } from '../src/core/actions.js';
import { isWalkable } from '../src/map/Pathfinding.js';
import { revealAround } from '../src/map/fog.js';

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
function seatBank(s, bankType, cx = 22, cy = 20) {
  clearBlock(s, cx, cy, 2);
  const bank = putObj(s, cx, cy, { type: 'creatureBank', bankType, looted: false, guards: bankDef(bankType).guards.map((g) => ({ ...g })) });
  revealAround(s, 0, cx, cy, 5);
  return bank;
}
const win = (hero, xp = 500) => ({ attackerWon: true, attackerArmy: hero.army.filter(Boolean).map((s) => ({ ...s })), defenderArmy: [], xp });

test('every bank references real creatures for its guards and reward, and BANK_TYPES covers them', () => {
  assert.deepEqual([...BANK_TYPES].sort(), Object.keys(CREATURE_BANKS).sort(), 'BANK_TYPES lists every bank');
  for (const [id, b] of Object.entries(CREATURE_BANKS)) {
    assert.ok(b.name && b.guards.length, `${id} has a name + guards`);
    for (const g of b.guards) assert.ok(CREATURES[g.creature] && g.count > 0, `${id} guard ${g.creature} is real`);
    for (const c of (b.reward.creatures || [])) assert.ok(CREATURES[c.creature], `${id} reward ${c.creature} is real`);
  }
});

test('an un-looted bank blocks pathing and storming it starts combat against its guards', () => {
  const s = newGame({ seed: 6 });
  const hero = playerHeroes(s, 0)[0];
  const bank = seatBank(s, 'griffinConservatory');
  hero.x = bank.x - 1; hero.y = bank.y; hero.z = 0; hero.mp = 2000;

  assert.equal(isWalkable(s, bank.x, bank.y, 0), false, 'un-looted bank blocks through-traffic');
  const ev = stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 });
  assert.equal(ev.type, 'combat');
  assert.equal(ev.context.defender.kind, 'creatureBank');
  assert.deepEqual(ev.context.defenderArmy.map((a) => a.creature), ['griffin'], 'the bank fields its guards');
  assert.equal(hero.x, bank.x - 1, 'the attacker does not enter the bank tile (fights from outside)');
});

test('victory plunders the reward, empties the bank, and makes it walkable', () => {
  const s = newGame({ seed: 7 });
  const hero = playerHeroes(s, 0)[0];
  const bank = seatBank(s, 'cyclopsStockpile');
  hero.x = bank.x - 1; hero.y = bank.y; hero.z = 0; hero.mp = 2000;
  const goldBefore = s.players[0].resources.gold, oreBefore = s.players[0].resources.ore;

  const ctx = stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 }).context;
  const events = applyCombatResult(s, ctx, win(hero));
  const looted = events.find((e) => e.type === 'bankLooted');
  assert.ok(looted, 'a bankLooted event fires');
  assert.equal(bank.looted, true, 'the bank is emptied');
  const r = CREATURE_BANKS.cyclopsStockpile.reward;
  assert.equal(s.players[0].resources.gold - goldBefore, r.gold, 'gold reward paid');
  assert.equal(s.players[0].resources.ore - oreBefore, r.resources.ore, 'ore reward paid');
  assert.ok(hero.army.some((st) => st && st.creature === 'cyclops'), 'the reward cyclopes joined the hero');
  assert.equal(isWalkable(s, bank.x, bank.y, 0), true, 'a looted bank is an inert, walkable ruin');
  // Walking over the emptied ruin is a plain move.
  hero.x = bank.x - 1; hero.mp = 2000;
  assert.equal(stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 }).type, 'moved');
});

test('the richest bank grants an artifact', () => {
  const s = newGame({ seed: 8 });
  const hero = playerHeroes(s, 0)[0];
  const bank = seatBank(s, 'dragonUtopia');
  hero.x = bank.x - 1; hero.y = bank.y; hero.z = 0; hero.mp = 2000;
  const ctx = stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 }).context;
  const events = applyCombatResult(s, ctx, win(hero));
  const looted = events.find((e) => e.type === 'bankLooted');
  assert.ok(looted.reward.artifact && ARTIFACTS[looted.reward.artifact], 'a real artifact was granted');
});

// Plunder `bankType` once on a fresh game per seed and return the artifact ids.
const plunderArtifacts = (bankType, seeds) => seeds.map((seed) => {
  const s = newGame({ seed });
  const hero = playerHeroes(s, 0)[0];
  const bank = seatBank(s, bankType);
  hero.x = bank.x - 1; hero.y = bank.y; hero.z = 0; hero.mp = 2000;
  const ctx = stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 }).context;
  const events = applyCombatResult(s, ctx, win(hero));
  return events.find((e) => e.type === 'bankLooted')?.reward?.artifact;
});

test('a plundered bank pays a relic from the band it EARNED, never the catalog at large', () => {
  // `reward.artifact` is the rarity band, and rarity band is the one thing that
  // decides how hard a fight a relic is supposed to stand behind. The payout was
  // `rng.pick(Object.keys(ARTIFACTS))` — flat over everything — so an Archangel
  // Spire, whose guard is five times what stands over the map's own grand prize,
  // handed out a +1 Luck charm about one time in seven.
  const seeds = Array.from({ length: 40 }, (_, i) => 500 + i);
  for (const [bankType, want] of [['dragonUtopia', 3], ['archangelSpire', 4], ['hydraLair', 4]]) {
    const got = plunderArtifacts(bankType, seeds);
    for (const id of got) {
      assert.ok(id && ARTIFACTS[id], `${bankType}: a real artifact`);
      assert.equal(ARTIFACTS[id].value, want, `${bankType} paid ${id} (band ${ARTIFACTS[id].value}), wanted band ${want}`);
    }
    // …and it is still a ROLL, not one fixed relic — the band has several members.
    assert.ok(new Set(got).size > 1, `${bankType} draws from its band rather than a single artifact`);
  }
});

test('no bank ever pays out a campaign relic', () => {
  // A First Vow set piece is granted by its scenario. The map generator's
  // treasure placement already refuses to seat one; the bank payout is the same
  // leak through a different door, and it was open.
  const seeds = Array.from({ length: 40 }, (_, i) => 900 + i);
  for (const bankType of ['dragonUtopia', 'archangelSpire', 'blackDragonCave']) {
    for (const id of plunderArtifacts(bankType, seeds)) {
      assert.ok(!ARTIFACTS[id].campaign, `${bankType} paid the campaign relic ${id}`);
    }
  }
});

test('the artifact band a site pays rises with the guard standing over it', () => {
  // The band is authored per bank, so nothing stops someone giving a Dwarven
  // Treasury a top-band relic. This is the ordering that makes the field mean
  // something: sort every artifact-paying site by the aiValue of its guard, and
  // the bands must not go backwards.
  const sites = Object.entries({ ...CREATURE_BANKS, ...BOSS_LAIRS })
    .filter(([, d]) => d.reward.artifact)
    .map(([id, d]) => ({
      id,
      band: d.reward.artifact,
      guard: d.guards.reduce((n, g) => n + (CREATURES[g.creature]?.aiValue || 0) * g.count, 0),
    }))
    .sort((a, b) => a.guard - b.guard);
  for (const s of sites) {
    assert.ok(Number.isInteger(s.band) && s.band >= 1, `${s.id}: reward.artifact is a rarity band, not a flag`);
  }
  for (let i = 1; i < sites.length; i++) {
    assert.ok(sites[i].band >= sites[i - 1].band,
      `${sites[i].id} (guard ${sites[i].guard}) pays band ${sites[i].band}, under ${sites[i - 1].id}'s ${sites[i - 1].band}`);
  }
});

test('a repelled assault thins the guard but leaves the reward and the block intact', () => {
  const s = newGame({ seed: 9 });
  const hero = playerHeroes(s, 0)[0];
  const bank = seatBank(s, 'griffinConservatory'); // 12 griffins
  hero.x = bank.x - 1; hero.y = bank.y; hero.z = 0; hero.mp = 2000;
  const ctx = stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 }).context;
  // Attacker loses; 5 griffins survive.
  const loss = { attackerWon: false, attackerArmy: [], defenderArmy: [{ creature: 'griffin', count: 5, hurt: 0 }], xp: 0 };
  const gold = s.players[0].resources.gold;
  applyCombatResult(s, ctx, loss);
  assert.equal(bank.looted, false, 'the bank is NOT plundered on a loss');
  assert.deepEqual(bank.guards, [{ creature: 'griffin', count: 5 }], 'the guard is thinned to the survivors');
  assert.equal(s.players[0].resources.gold, gold, 'no reward on a loss');
  assert.equal(isWalkable(s, bank.x, bank.y, 0), false, 'still blocks (still guarded)');
});

test('a bank survives a save/load round-trip (looted flag + mutable guards)', () => {
  const s = newGame({ seed: 10 });
  const bank = seatBank(s, 'nagaBank');
  bank.guards = [{ creature: 'naga', count: 2 }]; // a thinned guard
  const back = deserialize(serialize(s));
  const b2 = back.map.objects[bank.id];
  assert.equal(b2.type, 'creatureBank');
  assert.equal(b2.bankType, 'nagaBank');
  assert.deepEqual(b2.guards, [{ creature: 'naga', count: 2 }]);
});
