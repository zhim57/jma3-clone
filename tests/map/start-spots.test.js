/**
 * start-spots.test.js — start-town seating + runtime-blocker corridor safety
 * (2026-07 repo review, "map seams cluster").
 *
 * - "1 vs 3" (three players on one team) used to reuse the zone's 2nd town
 *   spot for the 3rd teammate: two towns (and two starting heroes) stacked on
 *   ONE tile, the tile grid pointing at only one of them — the orphaned town
 *   could never be attacked, so conquest was unwinnable. Three spots per zone
 *   now exist, with a deterministic nudge as a backstop.
 * - Key vaults, creature banks, pandora boxes, monoliths and surface gates now
 *   respect the pass-corridor `forbid` mask (they block through-traffic at
 *   RUNTIME while generation certified them passable — mid-corridor they
 *   sealed the map's few crossings). Property-checked below: with every
 *   runtime blocker treated as solid, all start towns stay mutually reachable.
 * - A surface gate can no longer seat on the buried Grail tile (stepping there
 *   teleports the digger below — the Grail race was dead on such seeds).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerTowns, playerHeroes } from '../../src/core/GameState.js';

const ONE_V_THREE = [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
  { faction: 'inferno', isHuman: false, team: 1 },
  { faction: 'inferno', isHuman: false, team: 1 },
];

test('1 vs 3: every start town (and hero) gets its own tile, and the tile grid agrees', () => {
  for (const seed of [1, 7, 23]) {
    const s = newGame({ seed, players: ONE_V_THREE, mapW: 56, mapH: 46 });
    const starts = Object.values(s.towns).filter((t) => t.owner >= 0);
    assert.equal(starts.length, 4, `seed ${seed}: a town per player`);
    const spots = new Set(starts.map((t) => `${t.x},${t.y}`));
    assert.equal(spots.size, 4, `seed ${seed}: all four town tiles are distinct`);
    for (const t of starts) {
      const tile = s.map.tiles[t.y * s.map.w + t.x];
      const obj = s.map.objects[tile.objectId];
      assert.ok(obj && obj.type === 'town' && obj.townId === t.id,
        `seed ${seed}: the tile under ${t.name} points back at it (attackable)`);
    }
    for (let p = 0; p < 4; p++) {
      assert.equal(playerTowns(s, p).length, 1, `seed ${seed}: player ${p} owns a town`);
      assert.equal(playerHeroes(s, p).length, 1, `seed ${seed}: player ${p} has a hero`);
    }
    const heroSpots = new Set(Object.values(s.heroes).map((h) => `${h.x},${h.y}`));
    assert.equal(heroSpots.size, 4, `seed ${seed}: starting heroes on distinct tiles`);
  }
});

test('runtime blockers never sever the start towns from each other', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    const s = newGame({ seed, mapW: 56, mapH: 46 });
    const m = s.map;
    const { w, h } = m;
    // Solid = what actually blocks a KEYLESS hero's through-traffic at runtime
    // (Pathfinding.isWalkable): towns, portals, gates, monoliths, whirlpools,
    // boats, keyless border guards, un-looted banks, guarded pandora boxes.
    // Monsters are beatable, so they stay passable here.
    const RUNTIME_SOLID = new Set(['town', 'portal', 'subGate', 'monolith', 'whirlpool', 'boat', 'borderGuard']);
    const solid = (i) => {
      const id = m.tiles[i].objectId;
      if (!id) return false;
      const o = m.objects[id];
      if (RUNTIME_SOLID.has(o.type)) return true;
      if (o.type === 'creatureBank' && !o.looted) return true;
      if (o.type === 'pandora' && !o.looted && o.guards && o.guards.length) return true;
      return false;
    };
    const open = (i) => {
      const tl = m.tiles[i];
      return tl.terrain !== 'water' && !tl.obstacle && !solid(i);
    };
    const starts = Object.values(s.towns).filter((t) => t.owner >= 0 && (t.z ?? 0) === 0);
    const seen = new Uint8Array(w * h);
    const q = [starts[0].y * w + starts[0].x];
    seen[q[0]] = 1;
    while (q.length) {
      const i = q.pop(), x = i % w;
      const nb = [];
      if (x > 0) nb.push(i - 1);
      if (x < w - 1) nb.push(i + 1);
      if (i >= w) nb.push(i - w);
      if (i < w * h - w) nb.push(i + w);
      for (const j of nb) if (!seen[j] && open(j)) { seen[j] = 1; q.push(j); }
    }
    for (const t of starts) {
      let ok = false;
      for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) {
        const nx = t.x + dx, ny = t.y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && seen[ny * w + nx]) ok = true;
      }
      assert.ok(ok, `seed ${seed}: ${t.name} is walk-reachable past every runtime blocker`);
    }
  }
});

test('no surface gate (or any object) squats the buried Grail tile', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    const s = newGame({ seed, mapW: 56, mapH: 46 });
    const g = s.map.grail;
    if (!g) continue; // a grail-less layout has nothing to protect
    const tile = s.map.tiles[g.y * s.map.w + g.x];
    assert.equal(tile.objectId, null,
      `seed ${seed}: the Grail tile must stay object-free (found ${tile.objectId && s.map.objects[tile.objectId]?.type})`);
  }
});
