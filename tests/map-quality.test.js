/**
 * map-quality.test.js — the map-design rules, inside the suite.
 *
 * scripts/audit-maps.mjs is the exploration instrument: many seeds, five sizes,
 * a scorecard. It is not run by `npm test`, so the four generator rules it drove
 * to green were protected by nothing a future change would trip over. This pins
 * them at a smaller sample so a regression fails CI instead of shipping.
 *
 * Deliberately mirrors the harness's definitions rather than importing it, since
 * a test that shares its subject's helpers can pass while both are wrong — that
 * is how the harness's own border-guard and on-foot-only bugs survived at first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame } from '../src/core/GameState.js';
import { CREATURES } from '../src/data/creatures.js';
import { FACTIONS } from '../src/data/factions.js';

const P = [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }];
// Three sizes, three seeds: enough to catch a systematic regression, fast enough
// to sit in the suite. The harness sweeps far wider when we are exploring.
const SIZES = [[36, 30], [52, 46], [72, 64]];
const SEEDS = [1, 5, 9];
const GATED = new Set(['boat', 'whirlpool', 'shipyard', 'monolith', 'subGate', 'portal']);

const build = (seed, w, h, features = {}) => newGame({ seed, players: P, mapW: w, mapH: h, features });

/** Reachable-by-any-means flood: gates open, water crossable by boat. */
function reachAny(level, starts) {
  const { w, h, tiles } = level;
  const at = (x, y) => y * w + x;
  const seen = new Uint8Array(w * h);
  const q = [];
  for (const s of starts) { const i = at(s.x, s.y); if (!seen[i]) { seen[i] = 1; q.push(i); } }
  const walk = (x, y) => { const t = tiles[at(x, y)]; return !!t && !t.obstacle; };
  for (let head = 0; head < q.length; head++) {
    const ci = q[head], cx = ci % w, cy = (ci / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!walk(nx, ny)) continue;
      if (dx && dy && !(walk(cx + dx, cy) || walk(cx, cy + dy))) continue;
      const ni = at(nx, ny);
      if (!seen[ni]) { seen[ni] = 1; q.push(ni); }
    }
  }
  return seen;
}

const eachMap = (fn, features) => {
  for (const [w, h] of SIZES) for (const seed of SEEDS) fn(build(seed, w, h, features), `${w}x${h} seed ${seed}`);
};

test('no prize is stranded: every object is reachable by some means', () => {
  eachMap((state, where) => {
    const map = state.map;
    const starts = Object.values(state.towns).filter((t) => t.owner >= 0 && (t.z ?? 0) === 0);
    const seen = reachAny(map, starts.length ? starts : Object.values(state.towns));
    const stranded = Object.values(map.objects)
      .filter((o) => !GATED.has(o.type) && !seen[o.y * map.w + o.x]);
    assert.deepEqual(stranded.map((o) => `${o.type}@${o.x},${o.y}`), [],
      `${where}: content the player can never collect`);
  });
});

test('every town touches the road network — on its OWN level', () => {
  // The bug this pins twice over: the generator built its road MST over towns
  // only, so a lone cavern town got no network at all; and the audit read SURFACE
  // tiles at an underground town's coordinates, so it could never have seen a
  // cavern road even once one existed.
  eachMap((state, where) => {
    for (const t of Object.values(state.towns)) {
      const lvl = (t.z === 1) ? state.map.underground : state.map;
      if (!lvl) continue;
      let onRoad = false;
      for (let dy = -1; dy <= 1 && !onRoad; dy++) {
        for (let dx = -1; dx <= 1 && !onRoad; dx++) {
          const x = Math.max(0, Math.min(lvl.w - 1, t.x + dx));
          const y = Math.max(0, Math.min(lvl.h - 1, t.y + dy));
          if (lvl.tiles[y * lvl.w + x]?.road) onRoad = true;
        }
      }
      assert.ok(onRoad, `${where}: ${t.name} (z${t.z ?? 0}) is not on the road network`);
    }
  });
});

test('neither starting zone gets materially more dwellings', () => {
  eachMap((state, where) => {
    const map = state.map;
    const diag = Math.hypot(map.w, map.h);
    const zoneOf = (o) => ((Math.hypot(o.x, (map.h - 1) - o.y) - Math.hypot((map.w - 1) - o.x, o.y)) / diag < 0 ? 0 : 1);
    const n = [0, 0];
    for (const o of Object.values(map.objects)) if (o.type === 'dwelling') n[zoneOf(o)]++;
    assert.ok(Math.abs(n[0] - n[1]) <= 1,
      `${where}: dwellings split ${n[0]}/${n[1]} — one player starts with materially more recruitment`);
  });
});

test('wild stacks favour their own terrain, but the map still surprises', () => {
  let native = 0, total = 0;
  const factionsSeen = [];
  eachMap((state) => {
    const map = state.map;
    const facs = new Set();
    for (const o of Object.values(map.objects)) {
      if (o.type !== 'monster' || o.invader || !CREATURES[o.creature]) continue;
      const f = CREATURES[o.creature].faction;
      facs.add(f);
      total++;
      if (FACTIONS[f]?.nativeTerrain === map.tiles[o.y * map.w + o.x]?.terrain) native++;
    }
    factionsSeen.push(facs.size);
  });
  const share = native / Math.max(1, total);
  // Floor: well clear of the ~15% that purely random seating produced.
  assert.ok(share >= 0.35, `only ${(share * 100).toFixed(0)}% of wild stacks on native terrain`);
  // Ceiling: a monoculture would make every terrain a lookup table. The knob is
  // CONFIG.WILD_NATIVE_CHANCE; this guards against someone winding it to 1.
  assert.ok(share <= 0.85, `${(share * 100).toFixed(0)}% native — terrain has become predictable`);
  assert.ok(CONFIG.WILD_NATIVE_CHANCE > 0 && CONFIG.WILD_NATIVE_CHANCE < 1,
    'the habitat bias must stay a bias, not a rule');
  // And no faction may be fenced off the map by the bias.
  assert.ok(Math.min(...factionsSeen) >= 6,
    `a map fielded only ${Math.min(...factionsSeen)} distinct factions among its wild stacks`);
});

test('the rules hold with Rich Lands on too', () => {
  // Rich Lands adds a lot of objects; the reachability and road guarantees must
  // survive the extra crowding.
  eachMap((state, where) => {
    const map = state.map;
    const starts = Object.values(state.towns).filter((t) => t.owner >= 0 && (t.z ?? 0) === 0);
    const seen = reachAny(map, starts.length ? starts : Object.values(state.towns));
    const stranded = Object.values(map.objects)
      .filter((o) => !GATED.has(o.type) && !seen[o.y * map.w + o.x]);
    assert.equal(stranded.length, 0, `${where} (rich): ${stranded.length} stranded`);
  }, { richLands: true });
});

test('the generator is still a pure function of its seed', () => {
  const fp = (s) => Object.values(s.map.objects)
    .map((o) => `${o.x},${o.y},${o.type},${o.mineType || o.boosterType || o.creature || ''}`).sort().join('|');
  for (const [w, h] of SIZES) {
    assert.equal(fp(build(4, w, h)), fp(build(4, w, h)), `${w}x${h}: same seed must give the same map`);
  }
});
