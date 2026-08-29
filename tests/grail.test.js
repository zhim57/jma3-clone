/**
 * grail.test.js — the Grail quest (roadmap C / HoMM3 gap): uncover every
 * obelisk → the buried tile is revealed → dig it up → enshrine it at a town for
 * a permanent growth blessing.
 *
 *  - generation seats a reachable, object-free Grail tile;
 *  - visiting obelisks tallies per player and reveals the tile when all are seen;
 *  - digging needs a full day and only pays off on the true tile;
 *  - enshrining raises the town's Grail structure (+growth), enemy towns refused;
 *  - all of it round-trips a save.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns, serialize, deserialize } from '../src/core/GameState.js';
import { stepHero, endTurn, obeliskProgress, grailKnown, digForGrail, deliverGrail } from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { isExplored } from '../src/map/fog.js';
import { Rng } from '../src/core/rng.js';
import { CONFIG } from '../src/config.js';

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
function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, ...data };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}
/** Remove every obelisk so a test controls the puzzle's total. */
function clearObelisks(state) {
  for (const lvl of [state.map, state.map.underground]) {
    if (!lvl) continue;
    for (const o of Object.values(lvl.objects)) {
      if (o.type === 'booster' && o.boosterType === 'obelisk') {
        lvl.tiles[o.y * lvl.w + o.x].objectId = null;
        delete lvl.objects[o.id];
      }
    }
  }
}

// ---------------------------------------------------------------------------

test('generation seats a reachable, object-free Grail tile on open land', () => {
  for (const seed of [1, 42, 4242, 2024, 777]) {
    const towns = [];
    const map = generateMap({
      w: 44, h: 36, rng: new Rng(seed),
      players: [{ faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    });
    assert.ok(map.grail, `seed ${seed}: a Grail tile is chosen`);
    const t = map.tiles[map.grail.y * map.w + map.grail.x];
    assert.notEqual(t.terrain, 'water', `seed ${seed}: not on water`);
    assert.equal(t.obstacle, null, `seed ${seed}: not on an obstacle`);
    assert.equal(t.objectId, null, `seed ${seed}: not on another object`);
  }
});

test('obelisks: visiting every one tallies per player and reveals the Grail tile', () => {
  const s = newGame({ seed: 4242 });
  clearObelisks(s);
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, hero.x, hero.y, 2);
  // Two obelisks flanking the hero — total = 2.
  const oL = putObj(s, hero.x - 1, hero.y, { type: 'booster', boosterType: 'obelisk' });
  const oR = putObj(s, hero.x + 1, hero.y, { type: 'booster', boosterType: 'obelisk' });
  assert.deepEqual(obeliskProgress(s, 0), { seen: 0, total: 2 });

  hero.mp = 5000;
  stepHero(s, hero, { x: oL.x, y: oL.y, cost: 100 });
  assert.deepEqual(obeliskProgress(s, 0), { seen: 1, total: 2 }, 'first obelisk counted');
  assert.equal(grailKnown(s, 0), false, 'not solved with one left');

  const ev = stepHero(s, hero, { x: oR.x, y: oR.y, cost: 100 });
  assert.deepEqual(obeliskProgress(s, 0), { seen: 2, total: 2 }, 'second obelisk counted');
  assert.equal(grailKnown(s, 0), true, 'every obelisk uncovered');
  assert.ok(s.players[0].grailKnown, 'the reveal flag is set');
  assert.match(ev.text || '', /Grail/i, 'the visit announces the Grail');
  assert.ok(isExplored(s, 0, s.map.grail.x, s.map.grail.y, 0), 'the buried tile is revealed in fog');
});

test('dig: needs a full day, and only the true tile yields the Grail', () => {
  const s = newGame({ seed: 4242 });
  const hero = playerHeroes(s, 0)[0];
  const g = s.map.grail;
  hero.z = 0;

  // Not enough movement → refused, nothing spent as a find.
  hero.x = g.x; hero.y = g.y; hero.mp = 10;
  const tired = digForGrail(s, hero);
  assert.equal(tired.ok, false, 'a partial day cannot dig');

  // Full day on the WRONG tile → the day is spent, no Grail.
  hero.x = g.x + 1; hero.mp = 9999;
  const miss = digForGrail(s, hero);
  assert.equal(miss.ok, true);
  assert.equal(miss.found, false, 'nothing buried here');
  assert.equal(hero.mp, 0, 'the dig still consumed the day');
  assert.equal(s.grailDug, undefined, 'the Grail is still buried');

  // Full day on the TRUE tile → unearthed and carried.
  hero.x = g.x; hero.y = g.y; hero.mp = 9999;
  const hit = digForGrail(s, hero);
  assert.equal(hit.found, true, 'the Grail is unearthed on its tile');
  assert.equal(hero.carryingGrail, true, 'the hero carries it');
  assert.equal(s.grailDug, true, 'flagged dug (so it cannot be found twice)');

  // A second dig anywhere is refused.
  hero.mp = 9999;
  assert.equal(digForGrail(s, hero).ok, false, 'already unearthed');
});

test('deliver: enshrining at an OWN town raises the Grail structure; enemy towns refused', () => {
  const s = newGame({ seed: 4242 });
  const hero = playerHeroes(s, 0)[0];
  hero.carryingGrail = true;
  const mine = playerTowns(s, 0)[0];
  const enemy = Object.values(s.towns).find((t) => t.owner !== 0 && t.owner >= 0);

  assert.equal(deliverGrail(s, hero, enemy).ok, false, 'cannot enshrine at a rival town');
  assert.equal(hero.carryingGrail, true, 'still carried after a refusal');

  const r = deliverGrail(s, hero, mine);
  assert.equal(r.ok, true);
  assert.equal(mine.grail, true, 'the Grail structure is raised');
  assert.equal(hero.carryingGrail, false, 'the Grail is consumed into the town');
  assert.equal(s.grailTownId, mine.id);
});

test('the Grail structure boosts a town\'s weekly creature growth', () => {
  const s = newGame({ seed: 4242 });
  // Two player-owned towns, identical build, same faction — only one has the Grail.
  const towns = Object.values(s.towns);
  const a = towns[0], b = towns.find((t) => t.id !== a.id);
  for (const t of [a, b]) {
    t.owner = 0; t.faction = a.faction; t.buildings = ['dwelling1']; t.available = {};
  }
  a.grail = true;
  const w0 = s.day;
  let guard = 40;
  while (Math.floor((s.day - 1) / CONFIG.DAYS_PER_WEEK) === Math.floor((w0 - 1) / CONFIG.DAYS_PER_WEEK) && guard-- > 0) endTurn(s);
  // Same week event hit both towns; the Grail town grew tier-1 strictly more.
  assert.ok((a.available[1] || 0) > (b.available[1] || 0),
    `grail town grew more (${a.available[1]} vs ${b.available[1]})`);
});

test('the whole Grail state round-trips a save', () => {
  const s = newGame({ seed: 4242 });
  s.players[0].obeliskIds = ['O1', 'O2'];
  s.players[0].grailKnown = true;
  s.grailDug = true;
  const hero = playerHeroes(s, 0)[0];
  hero.carryingGrail = true;
  playerTowns(s, 0)[0].grail = true;

  const r = deserialize(serialize(s));
  assert.deepEqual(r.players[0].obeliskIds, ['O1', 'O2']);
  assert.equal(r.players[0].grailKnown, true);
  assert.equal(r.grailDug, true);
  assert.deepEqual(r.map.grail, s.map.grail);
  assert.equal(r.heroes[hero.id].carryingGrail, true);
  assert.equal(playerTowns(r, 0)[0].grail, true);
});
