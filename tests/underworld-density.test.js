/**
 * underworld-density.test.js — the lower level must be worth going down to.
 *
 * Playtest report, on exploration scoring 45/100: "the underworld was mostly
 * empty, 4-5 mines, a monolith, 2 power poles ... mostly just walking in empty
 * after the 20th day". Counted on that seed (376709956, 44x36):
 *
 *     surface     120 objects
 *     underground  38 objects   -> 27-38% of surface density across all sizes
 *
 * The audit harness had measured ONLY the surface, so a map with a hollow
 * underworld scored a clean pass — the same blind spot as the underground roads.
 * scripts/audit-maps.mjs now carries UNDER.dens / UNDER.mines / UNDER.reach.
 *
 * The fix is not just more loot. One-shot pickups make the lower level a single
 * errand, which is the same complaint as the late game running dry, so the caverns
 * now also carry dwellings (recruits accrue) and weekly sites (a reason to send a
 * hero down every week rather than once).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame } from '../src/core/GameState.js';

const P = [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }];
const SIZES = [[36, 30], [44, 36], [52, 46], [72, 64]];
const build = (seed, w, h) => newGame({ seed, players: P, mapW: w, mapH: h });

const tally = (level) => {
  const c = {};
  for (const o of Object.values(level?.objects || {})) {
    const k = o.type === 'booster' ? `boost:${o.boosterType}` : o.type;
    c[k] = (c[k] || 0) + 1;
  }
  return c;
};
const total = (t) => Object.values(t).reduce((a, b) => a + b, 0);

test('the underworld is not markedly emptier than the surface', () => {
  for (const [w, h] of SIZES) {
    for (const seed of [1, 5, 376709956]) {
      const s = build(seed, w, h);
      const u = s.map.underground;
      assert.ok(u, `${w}x${h}: no underground at all`);
      const sDen = Object.keys(s.map.objects).length / (s.map.w * s.map.h);
      const uDen = total(tally(u)) / (u.w * u.h);
      const ratio = uDen / sDen;
      assert.ok(ratio >= 0.5,
        `${w}x${h} seed ${seed}: underworld at ${(ratio * 100).toFixed(0)}% of surface density`);
    }
  }
});

test('the caverns carry things worth COMING BACK for, not only loot', () => {
  // A dwelling accrues recruits and a weekly site refills — both give the lower
  // level standing value instead of being one errand.
  let withDwelling = 0, withWeekly = 0;
  const N = 6;
  for (let seed = 1; seed <= N; seed++) {
    const t = tally(build(seed, 44, 36).map.underground);
    if ((t.dwelling || 0) > 0) withDwelling++;
    const weekly = (t['boost:tradeFair'] || 0) + (t['boost:waterWheel'] || 0) + (t['boost:windmill'] || 0);
    if (weekly > 0) withWeekly++;
  }
  assert.ok(withDwelling >= N - 1, `only ${withDwelling}/${N} maps had an underground dwelling`);
  assert.ok(withWeekly >= N - 1, `only ${withWeekly}/${N} maps had an underground weekly site`);
});

test('the caverns still hold industry worth taking', () => {
  for (const [w, h] of SIZES) {
    const t = tally(build(9, w, h).map.underground);
    assert.ok((t.mine || 0) >= 4, `${w}x${h}: only ${t.mine || 0} underground mines`);
    assert.ok((t.town || 0) >= 1, `${w}x${h}: the lower level needs a capturable anchor`);
  }
});

test('nothing underground is stranded from the gates that reach it', () => {
  for (const [w, h] of SIZES) {
    const s = build(4, w, h);
    const u = s.map.underground;
    const objs = Object.values(u.objects);
    const mouths = objs.filter((o) => o.type === 'subGate');
    assert.ok(mouths.length >= 1, `${w}x${h}: no way down`);
    // Flood with gates open and water crossable — same rule as the audit.
    const seen = new Uint8Array(u.w * u.h);
    const q = mouths.map((m) => m.y * u.w + m.x);
    q.forEach((i) => { seen[i] = 1; });
    const walk = (x, y) => { const t = u.tiles[y * u.w + x]; return !!t && !t.obstacle; };
    for (let head = 0; head < q.length; head++) {
      const ci = q[head], cx = ci % u.w, cy = (ci / u.w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= u.w || ny >= u.h) continue;
        if (!walk(nx, ny)) continue;
        if (dx && dy && !(walk(cx + dx, cy) || walk(cx, cy + dy))) continue;
        const ni = ny * u.w + nx;
        if (!seen[ni]) { seen[ni] = 1; q.push(ni); }
      }
    }
    const stranded = objs.filter((o) => !['subGate', 'portal'].includes(o.type) && !seen[o.y * u.w + o.x]);
    assert.deepEqual(stranded.map((o) => `${o.type}@${o.x},${o.y}`), [], `${w}x${h}: stranded below`);
  }
});

test('the richness knobs stay in a sane band', () => {
  assert.ok(CONFIG.UNDERGROUND_RICHNESS > 1, 'below 1 would thin the caverns further');
  assert.ok(CONFIG.UNDERGROUND_RICHNESS <= 4, 'past this the lower level out-loots the surface');
  assert.ok(CONFIG.UNDERGROUND_DWELLINGS >= 1 && CONFIG.UNDERGROUND_WEEKLY >= 1);
});

test('the generator stays deterministic with the richer caverns', () => {
  const fp = (s) => Object.values(s.map.underground.objects)
    .map((o) => `${o.x},${o.y},${o.type}`).sort().join('|');
  assert.equal(fp(build(7, 44, 36)), fp(build(7, 44, 36)));
});
