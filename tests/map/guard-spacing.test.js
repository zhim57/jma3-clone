/**
 * guard-spacing.test.js — the ZoC-aware guard hardening (2026-07 repo review,
 * backlog G66).
 *
 * Two monster guards within Chebyshev 2 of each other can interlock their zones
 * of control across a 1-wide passage — a hero can't get adjacent to fight one
 * without standing in the other's ZoC. findGuardTile now prefers a guard tile
 * clear of any other monster within Chebyshev 2 (falling back to any valid tile
 * so nothing goes unguarded), which cut the interlock rate on this sample from
 * ~2.2% of monsters to ~0.8%. These pin: (1) generation stays deterministic per
 * seed, and (2) the interlock rate stays low (a regression that drops the check
 * roughly triples it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap } from '../../src/map/MapGenerator.js';
import { Rng } from '../../src/core/rng.js';

function buildMap(seed, w, h) {
  const towns = [];
  return generateMap({
    w, h, rng: new Rng(seed),
    players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (town) => { const id = `T${towns.length}`; town.id = id; towns.push(town); return id; },
  });
}

const monsters = (lvl) => (lvl ? Object.values(lvl.objects).filter((o) => o.type === 'monster') : []);
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function interlockPairs(map) {
  let n = 0;
  for (const lvl of [map, map.underground]) {
    const m = monsters(lvl);
    for (let i = 0; i < m.length; i++) {
      for (let j = i + 1; j < m.length; j++) if (cheb(m[i], m[j]) <= 2) n++;
    }
  }
  return n;
}

const SIZES = [[44, 36], [56, 46], [72, 60]];
const seedsFor = (w, h) => Array.from({ length: 10 }, (_, k) => (k + 1) * 2003 + w * 7 + h);

test('G66: generated guards stay deterministic and rarely interlock (ZoC hardening)', () => {
  let interlocks = 0, totalMonsters = 0;
  for (const [w, h] of SIZES) {
    for (const seed of seedsFor(w, h)) {
      const a = buildMap(seed, w, h);
      // Determinism: the same seed twice → the same monster layout.
      const b = buildMap(seed, w, h);
      const key = (mp) => monsters(mp).concat(monsters(mp.underground)).map((o) => `${o.x},${o.y}`).sort().join('|');
      assert.equal(key(a), key(b), `${w}x${h} seed ${seed}: monster layout is deterministic`);

      interlocks += interlockPairs(a);
      totalMonsters += monsters(a).length + monsters(a.underground).length;
    }
  }
  assert.ok(totalMonsters > 500, 'the sample actually placed a lot of guards');
  const rate = interlocks / totalMonsters;
  // ~0.8% with the hardening; ~2.2% without it. 1.2% sits comfortably between.
  assert.ok(rate < 0.012, `interlock rate ${rate.toFixed(4)} is low (ZoC hardening active)`);
});
