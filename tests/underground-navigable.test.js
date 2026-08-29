/**
 * underground-navigable.test.js — the underground caverns must be NAVIGABLE, not
 * a misleading half-tile maze. The cavern shell scatters ambient rock; if it's
 * too dense, the diagonal corner-cut rule walls big patches of visually-open
 * floor into unreachable pockets (a hero sees a gap between two rocks but can't
 * squeeze through). This pins the open floor to one near-total connected space.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap } from '../src/map/MapGenerator.js';
import { Rng } from '../src/core/rng.js';

/** Fraction of open (non-obstacle, non-water) underground floor reachable from
 *  the central open tile, with the SAME diagonal corner-cut rule pathing uses. */
function openConnectedPct(seed) {
  const towns = [];
  const map = generateMap({
    w: 44, h: 36, rng: new Rng(seed), players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  const ug = map.underground;
  const { w, h, tiles } = ug;
  const at = (x, y) => y * w + x;
  const open = (x, y) => x >= 0 && y >= 0 && x < w && y < h && tiles[at(x, y)].terrain !== 'water' && !tiles[at(x, y)].obstacle;
  const openTiles = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (open(x, y)) openTiles.push([x, y]);
  // Seed the flood at the open tile nearest map centre.
  let start = openTiles[0], bd = Infinity;
  for (const [x, y] of openTiles) { const d = (x - w / 2) ** 2 + (y - h / 2) ** 2; if (d < bd) { bd = d; start = [x, y]; } }
  const seen = new Uint8Array(w * h); const q = [start]; seen[at(start[0], start[1])] = 1; let cnt = 1;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let hd = 0; hd < q.length; hd++) {
    const [cx, cy] = q[hd];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!open(nx, ny)) continue;
      if (dx && dy && !(open(cx + dx, cy) || open(cx, cy + dy))) continue; // no corner-cut
      const ni = at(nx, ny);
      if (!seen[ni]) { seen[ni] = 1; q.push([nx, ny]); cnt++; }
    }
  }
  return cnt / openTiles.length;
}

test('the underground open floor is one near-total connected space (no misleading pockets)', () => {
  for (const seed of [1, 2, 3, 7, 21, 42, 99]) {
    const pct = openConnectedPct(seed);
    assert.ok(pct >= 0.95, `seed ${seed}: only ${(pct * 100).toFixed(0)}% of open floor is reachable — pockets remain`);
  }
});
