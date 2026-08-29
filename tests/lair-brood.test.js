/**
 * lair-brood.test.js — a cleared lair keeps breeding (the `lairBrood` feature).
 *
 * Asked for: "the dragon lairs, the behemoth lairs should give a new creature
 * each week, but only if they have been emptied, so a player who wants to harvest
 * dragons sees them show up regularly and can grow their army."
 *
 * So: killing the guards does not clear the nest. A LOOTED Creature Bank or boss
 * lair accrues its own apex creature week by week, and a hero who comes back
 * takes the young — free, the fight for them long since won. What it breeds is
 * derived from the reward stack it already hands out, so a new lair needs no
 * second table.
 *
 * An UNLOOTED bank must never breed: it still has both its garrison and its prize,
 * and swelling that would only move the goalposts.
 *
 * Feature-gated, and the gate is tested the way this project tests gates: with the
 * flag off, a week of play must leave the bank byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CREATURES } from '../src/data/creatures.js';
import {
  CREATURE_BANKS, BOSS_LAIRS, BANK_TYPES, BOSS_LAIR_TYPES, broodOf, BROOD_RATE, BROOD_CAP_MULT,
} from '../src/data/creatureBanks.js';
import { newGame, playerHeroes, serialize, deserialize, weekOf } from '../src/core/GameState.js';
import { stepHero, endTurn } from '../src/core/actions.js';
import { revealAround } from '../src/map/fog.js';
import { isWalkable } from '../src/map/Pathfinding.js';

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, ...data };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}

function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const t = m.tiles[y * m.w + x];
      t.obstacle = null; t.terrain = 'grass';
      if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
    }
  }
  return { x: cx, y: cy };
}

function game({ lairBrood = true, bankType = 'dragonUtopia', looted = true, seed = 9 } = {}) {
  const s = newGame({
    seed,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    features: { lairBrood },
  });
  const spot = clearBlock(s, 22, 20, 2);
  const bank = putObj(s, spot.x, spot.y, {
    type: 'creatureBank', bankType, looted,
    guards: looted ? [] : (CREATURE_BANKS[bankType] || BOSS_LAIRS[bankType]).guards.map((g) => ({ ...g })),
  });
  revealAround(s, 0, spot.x, spot.y, 6);
  const hero = playerHeroes(s, 0)[0];
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000;
  return { s, bank, hero, spot };
}

/** Advance exactly one game week. */
function nextWeek(state) {
  const w0 = weekOf(state.day);
  let guard = 60;
  while (weekOf(state.day) === w0 && guard-- > 0) endTurn(state);
  assert.equal(weekOf(state.day), w0 + 1, 'advanced exactly one week');
}

test('every bank and lair with a creature reward has a brood derived from it', () => {
  for (const id of [...BANK_TYPES, ...BOSS_LAIR_TYPES]) {
    const def = CREATURE_BANKS[id] || BOSS_LAIRS[id];
    const first = (def.reward.creatures || [])[0];
    const brood = broodOf(id);
    if (!first) { assert.equal(brood, null, `${id} has no creature reward, so nothing to breed`); continue; }
    assert.ok(brood, `${id} should breed`);
    assert.equal(brood.creature, first.creature, `${id} breeds what it rewards`);
    assert.ok(brood.perWeek >= 1, `${id} must breed at least one a week, got ${brood.perWeek}`);
    assert.ok(brood.cap > brood.perWeek, `${id} cap ${brood.cap} must be worth waiting for`);
    assert.equal(brood.perWeek, Math.max(1, Math.round(first.count * BROOD_RATE)));
    assert.equal(brood.cap, Math.max(1, Math.round(first.count * BROOD_CAP_MULT)));
  }
  assert.equal(broodOf('notABank'), null, 'an unknown type breeds nothing');
});

test('a LOOTED lair breeds each week, up to its cap', () => {
  const { s, bank } = game({ bankType: 'dragonUtopia' });
  const brood = broodOf('dragonUtopia');
  assert.equal(bank.brood ?? 0, 0, 'starts empty');
  nextWeek(s);
  assert.equal(bank.brood, brood.perWeek, 'one week, one brood step');
  nextWeek(s);
  assert.equal(bank.brood, brood.perWeek * 2, 'and it accumulates while nobody collects');
  for (let i = 0; i < 20; i++) nextWeek(s);
  assert.equal(bank.brood, brood.cap, 'an ignored lair fills to its cap and stops');
});

test('an UNLOOTED bank never breeds — it still has its garrison and its prize', () => {
  const { s, bank } = game({ looted: false });
  const guards0 = JSON.stringify(bank.guards);
  nextWeek(s);
  nextWeek(s);
  assert.equal(bank.brood ?? 0, 0, 'no brood before the fight is won');
  assert.equal(JSON.stringify(bank.guards), guards0, 'and no change to the guard either');
});

test('walking onto a bred lair takes the young into the army', () => {
  const { s, bank, hero, spot } = game({ bankType: 'behemothCrag' });
  nextWeek(s);
  nextWeek(s);
  const n = bank.brood;
  assert.ok(n > 0);
  const cr = broodOf('behemothCrag').creature;
  const before = hero.army.filter(Boolean).reduce((t, st) => t + (st.creature === cr ? st.count : 0), 0);

  hero.mp = 4000;
  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'lairBrood');
  assert.equal(ev.count, n);
  assert.equal(ev.creature, cr);
  assert.equal(ev.full, false);
  assert.equal(bank.brood, 0, 'the nest is emptied by the collection');
  const after = hero.army.filter(Boolean).reduce((t, st) => t + (st.creature === cr ? st.count : 0), 0);
  assert.equal(after, before + n, `${n} ${CREATURES[cr].name} joined`);
});

test('the nest refills after a collection — this is the harvest the report asked for', () => {
  const { s, bank, hero, spot } = game({ bankType: 'dragonUtopia' });
  const per = broodOf('dragonUtopia').perWeek;
  let harvested = 0;
  for (let week = 0; week < 3; week++) {
    nextWeek(s);
    hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000;
    const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
    assert.equal(ev.type, 'lairBrood', `week ${week + 1} should have a brood waiting`);
    harvested += ev.count;
  }
  assert.equal(harvested, per * 3, 'a standing road to the lair pays every week');
  assert.equal(bank.brood, 0);
});

test('a full army leaves the brood in the nest rather than destroying it', () => {
  const { s, bank, hero, spot } = game({ bankType: 'dragonUtopia' });
  nextWeek(s);
  const n = bank.brood;
  // Fill every slot with creatures that cannot merge with the brood.
  hero.army = hero.army.map(() => ({ creature: 'pikeman', count: 1, hurt: 0 }));
  hero.mp = 4000;
  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'lairBrood');
  assert.equal(ev.full, true);
  assert.equal(ev.count, 0, 'nothing joined');
  assert.equal(ev.available, n, 'and the report says what is still waiting');
  assert.equal(bank.brood, n, 'the brood survives to be collected with room to spare');
});

test('an empty cleared lair is still just a ruin to walk over', () => {
  const { s, hero, spot } = game();
  // Passability is checked BEFORE the step: afterwards the hero itself occupies
  // the tile, which blocks it for everyone regardless of the object under them.
  assert.equal(isWalkable(s, spot.x, spot.y, 0, null, false, 0), true,
    'a looted bank stays passable, brood or not');
  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'moved', 'no brood yet, no event');
});

test('with the feature OFF a week of play leaves the lair untouched', () => {
  const { s, bank } = game({ lairBrood: false });
  const snap = JSON.stringify(bank);
  nextWeek(s);
  nextWeek(s);
  assert.equal(JSON.stringify(bank), snap, 'no flag, no brood, no field, no change');
  assert.equal(bank.brood, undefined, 'not even a zero — the object shape is untouched');
});

test('two games, flag on and off, stay in RNG lockstep for a fortnight', () => {
  // The gate must not draw from state.rng: a feature that shifts the stream
  // changes every unrelated roll in the game.
  const a = game({ lairBrood: false, seed: 77 });
  const b = game({ lairBrood: true, seed: 77 });
  for (let i = 0; i < 14; i++) { endTurn(a.s); endTurn(b.s); }
  assert.deepEqual(a.s.rng.toJSON(), b.s.rng.toJSON(),
    'weekly brood growth must be arithmetic, never a roll');
});

test('a brood round-trips a save', () => {
  const { s, bank } = game();
  nextWeek(s);
  const n = bank.brood;
  assert.ok(n > 0);
  const back = deserialize(serialize(s));
  // By id: a generated map has creature banks of its own, so "the first bank
  // found" is not necessarily the one seated here.
  assert.equal(back.map.objects[bank.id].brood, n, 'the nest is still stocked after a reload');
});

test('the AI values a bred lair like free army, and an empty one at nothing', async () => {
  const { AITurnController } = await import('../src/ai/AIPlayer.js');
  const { s, bank } = game({ bankType: 'dragonUtopia' });
  const ai = new AITurnController(s, 1);
  assert.equal(ai.broodValue(bank), 0, 'an empty nest is worth no march');
  nextWeek(s);
  const cr = broodOf('dragonUtopia').creature;
  assert.equal(ai.broodValue(bank), (CREATURES[cr].aiValue || 0) * bank.brood,
    'a stocked one is priced as the army it is');
});
