/**
 * weekly-circuit.test.js — the weekly circuit must actually be a circuit.
 *
 * Playtest report on Rich Lands: "there was only one wheel available to me which
 * i visited often, the AI's was next to his castle so i did not frequent it much
 * ... i think they were too few".
 *
 * Two separate faults, both measured over 10 maps at 44x36 with the feature on:
 *   - 17% of weekly sites sat within 5 tiles of a town. A stop on the doorstep is
 *     a zero-detour freebie for whoever holds that town and nothing at all for the
 *     rival — it is not a circuit stop.
 *   - the two zones split the stops by an average gap of 2.8 and as much as 3
 *     against 9, so one realm got a tour and the other got a single wheel.
 *
 * COUNT was never the problem: 12 stops per map. Placement was.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame } from '../src/core/GameState.js';

const P = [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }];
const WEEKLY = ['windmill', 'waterWheel', 'tradeFair'];
const build = (seed, w = 44, h = 36) => newGame({ seed, players: P, mapW: w, mapH: h, features: { richLands: true } });

function survey(state) {
  const m = state.map, diag = Math.hypot(m.w, m.h);
  const zoneOf = (o) => ((Math.hypot(o.x, (m.h - 1) - o.y) - Math.hypot((m.w - 1) - o.x, o.y)) / diag < 0 ? 0 : 1);
  const towns = Object.values(state.towns).filter((t) => (t.z ?? 0) === 0);
  const stops = Object.values(m.objects).filter((o) => o.type === 'booster' && WEEKLY.includes(o.boosterType));
  const zone = [0, 0];
  let doorstep = 0;
  for (const o of stops) {
    zone[zoneOf(o)]++;
    if (towns.some((t) => Math.abs(t.x - o.x) + Math.abs(t.y - o.y) <= 5)) doorstep++;
  }
  return { n: stops.length, zone, gap: Math.abs(zone[0] - zone[1]), doorstep };
}

test('the circuit is big enough to be a standing job', () => {
  for (const seed of [1, 4, 9]) {
    const s = survey(build(seed));
    assert.ok(s.n >= 7, `seed ${seed}: only ${s.n} weekly stops`);
  }
});

test('stops are NOT on a town doorstep', () => {
  let doorstep = 0, total = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const s = survey(build(seed));
    doorstep += s.doorstep; total += s.n;
  }
  const share = doorstep / total;
  assert.ok(share <= 0.12,
    `${(share * 100).toFixed(0)}% of stops sit within 5 tiles of a town (was 17%)`);
});

test('neither realm is starved — the split stays close', () => {
  const gaps = [];
  for (let seed = 1; seed <= 10; seed++) gaps.push(survey(build(seed)).gap);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(avg <= 2.2, `average zone gap ${avg.toFixed(1)} (was 2.8)`);
  assert.ok(Math.max(...gaps) <= 5, `worst split gap ${Math.max(...gaps)} (was 6)`);
  // And each side must get a real share, never a token one.
  for (let seed = 1; seed <= 10; seed++) {
    const { zone } = survey(build(seed));
    assert.ok(Math.min(...zone) >= 2, `seed ${seed}: a realm got only ${Math.min(...zone)} stop(s)`);
  }
});

test('spreading did not cost any stops', () => {
  // The relaxation ladder must still meet quota; a "spread" that seats fewer sites
  // trades one complaint for another.
  for (const [w, h] of [[36, 30], [44, 36], [52, 46]]) {
    for (let seed = 1; seed <= 5; seed++) {
      const s = survey(build(seed, w, h));
      assert.ok(s.n >= CONFIG.RICH_LANDS_WATER_WHEELS + CONFIG.RICH_LANDS_TRADE_FAIRS,
        `${w}x${h} seed ${seed}: ${s.n} stops, below the wheels+fairs quota`);
    }
  }
});

test('the doorstep distance is a sane knob', () => {
  assert.ok(CONFIG.WEEKLY_MIN_TOWN_DIST >= 5, 'too small and a stop is still a freebie');
  assert.ok(CONFIG.WEEKLY_MIN_TOWN_DIST <= 14, 'too large and a small map cannot seat any');
});
