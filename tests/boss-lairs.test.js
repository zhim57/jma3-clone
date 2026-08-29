/**
 * boss-lairs.test.js — Boss lairs (HoMM3 parity). A rare, prestige creature
 * bank held by a SINGLE apex species whose innate ability is the battlefield
 * gimmick (phoenix rebirth, black-dragon spell-immunity, hydra attacks-around,
 * behemoth armour-rending, archangel resurrection). They ride the exact
 * creatureBank object + combat + reward path via bankDef, and pay a rich hoard
 * (heavy gold + apex creatures + a guaranteed artifact).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CREATURES } from '../src/data/creatures.js';
import { ARTIFACTS } from '../src/data/artifacts.js';
import { BOSS_LAIRS, BOSS_LAIR_TYPES, bankDef, CREATURE_BANKS } from '../src/data/creatureBanks.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { stepHero, applyCombatResult } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

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
function seatLair(s, bankType, cx = 22, cy = 20) {
  clearBlock(s, cx, cy, 2);
  return putObj(s, cx, cy, { type: 'creatureBank', bankType, looted: false, guards: BOSS_LAIRS[bankType].guards.map((g) => ({ ...g })) });
}
const win = (hero, xp = 5000) => ({ attackerWon: true, attackerArmy: hero.army.filter(Boolean).map((s) => ({ ...s })), defenderArmy: [], xp });

// A battlefield-ability whitelist a boss's innate gimmick must draw from.
const GIMMICK_ABILITIES = new Set(['rebirth', 'spellImmune', 'attacksAround', 'ignoreDefense', 'resurrectAllies', 'noEnemyRetaliation']);

test('every boss lair: a SINGLE apex guard with a real battlefield gimmick + a guaranteed artifact', () => {
  assert.ok(BOSS_LAIR_TYPES.length >= 4, 'a handful of distinct lairs');
  for (const [id, b] of Object.entries(BOSS_LAIRS)) {
    assert.equal(b.boss, true, `${id} is flagged a boss`);
    assert.equal(b.guards.length, 1, `${id} is held by a single species`);
    const guard = b.guards[0];
    assert.ok(CREATURES[guard.creature] && guard.count > 0, `${id} guard ${guard.creature} is real`);
    const abils = CREATURES[guard.creature].abilities || [];
    assert.ok(abils.some((a) => GIMMICK_ABILITIES.has(a)), `${id}'s ${guard.creature} carries a battlefield gimmick`);
    // The field is the rarity BAND, not a flag: a lair's guard is several times
    // what stands over the map's own grand prize, so it pays from the top band.
    assert.equal(b.reward.artifact, Math.max(...Object.values(ARTIFACTS).map((a) => a.value)),
      `${id} pays a guaranteed TOP-band artifact`);
    for (const c of (b.reward.creatures || [])) assert.ok(CREATURES[c.creature], `${id} reward ${c.creature} is real`);
  }
});

test('bankDef resolves both a boss lair and a plain bank (shared combat/reward path)', () => {
  assert.equal(bankDef('phoenixRoost'), BOSS_LAIRS.phoenixRoost);
  assert.equal(bankDef('dwarvenTreasury'), CREATURE_BANKS.dwarvenTreasury);
  assert.equal(bankDef('nope'), null);
});

test('storming a lair fights its boss guard; victory plunders the hoard through the bank path', () => {
  const s = newGame({ seed: 6 });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 300, hurt: 0 }, null, null, null, null, null, null]; // crushing force
  const lair = seatLair(s, 'phoenixRoost');
  hero.x = lair.x - 1; hero.y = lair.y; hero.z = 0; hero.mp = 2000;
  const goldBefore = s.players[0].resources.gold;
  const artsBefore = Object.keys(hero.equipment).length + hero.backpack.length;

  const ev = stepHero(s, hero, { x: lair.x, y: lair.y, cost: 100 });
  assert.equal(ev.type, 'combat');
  assert.equal(ev.context.defender.kind, 'creatureBank');
  assert.deepEqual(ev.context.defenderArmy.map((a) => a.creature), ['phoenix'], 'the lair fields its boss');

  const events = applyCombatResult(s, ev.context, win(hero));
  const looted = events.find((e) => e.type === 'bankLooted');
  assert.ok(looted, 'a bankLooted event fires');
  assert.equal(lair.looted, true, 'the lair is emptied');
  const r = BOSS_LAIRS.phoenixRoost.reward;
  assert.equal(s.players[0].resources.gold - goldBefore, r.gold, 'the heavy gold hoard is paid');
  assert.ok(hero.army.some((st) => st && st.creature === 'phoenix'), 'the apex creatures join the hero');
  assert.ok(Object.keys(hero.equipment).length + hero.backpack.length > artsBefore, 'and a guaranteed artifact drops');
});

test('the AI reads a lair as a rich but heavily-guarded prize (only a strong hero dares it)', () => {
  const s = newGame({ seed: 8 });
  const ai = new AITurnController(s, 1);
  const lair = { id: 'BL', type: 'creatureBank', bankType: 'blackDragonCave', looted: false,
    guards: BOSS_LAIRS.blackDragonCave.guards.map((g) => ({ ...g })) };
  const bank = { id: 'DT', type: 'creatureBank', bankType: 'dwarvenTreasury', looted: false,
    guards: CREATURE_BANKS.dwarvenTreasury.guards.map((g) => ({ ...g })) };
  const bv = ai.bankValue(lair);
  assert.ok(bv.guard > 20000, `a boss guard is a serious force (got ${bv.guard})`);
  assert.ok(bv.reward > 15000, `and a rich hoard (got ${bv.reward})`);
  assert.ok(bv.guard > ai.bankValue(bank).guard, 'a lair out-guards a plain bank');
});

test('generation seats a boss lair on reference-size maps, on reachable land off the towns; none on small maps', () => {
  const lairsOf = (state) => Object.values(state.map.objects).filter(
    (o) => o.type === 'creatureBank' && BOSS_LAIR_TYPES.includes(o.bankType));

  const medium = newGame({ seed: 2, mapW: 44, mapH: 36 });
  const lairs = lairsOf(medium);
  assert.equal(lairs.length, 1, 'exactly one boss lair on a reference-size map');
  const townTiles = new Set(Object.values(medium.towns).map((t) => `${t.x},${t.y}`));
  assert.ok(!townTiles.has(`${lairs[0].x},${lairs[0].y}`), 'the lair is not on a town tile');
  assert.equal(medium.map.tiles[lairs[0].y * medium.map.w + lairs[0].x].objectId, lairs[0].id, 'tile links to the lair');

  const small = newGame({ seed: 2, mapW: 36, mapH: 30 });
  assert.equal(lairsOf(small).length, 0, 'no boss lairs on a sub-reference map');
});
