/**
 * seasons.test.js — Seasons. Every month (4 weeks) the world turns through a
 * four-season cycle derived deterministically from state.day; a season only
 * SLOWS off-road land travel (multipliers >= 1.0, roads unaffected), and the
 * opening month is temperate so the early game is untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { seasonOf, seasonName, seasonTerrainMult, isSeasonChange, currentSeason } from '../src/core/seasons.js';
import { stepCost } from '../src/map/Pathfinding.js';

// A minimal 2-tile state: (0,0) and (1,0), terrain settable per tile.
function twoTiles(terrain0 = 'grass', terrain1 = 'grass', road1 = null) {
  const tiles = [
    { terrain: terrain0, obstacle: null, objectId: null, road: null },
    { terrain: terrain1, obstacle: null, objectId: null, road: road1 },
  ];
  return { day: 1, map: { w: 2, h: 1, tiles, objects: {}, nextOid: 1 }, heroes: {}, players: [] };
}
const hero = () => ({ x: 0, y: 0, z: 0, faction: 'tower', skills: {}, army: [], mp: 100000 }); // tower ≠ grass native

test('the season cycles one per month, starting at the temperate opener', () => {
  assert.equal(seasonName(1), 'Spring', 'month 1 opens in Spring');
  assert.equal(seasonName(29), 'Summer', 'month 2');
  assert.equal(seasonName(57), 'Autumn', 'month 3');
  assert.equal(seasonName(85), 'Winter', 'month 4');
  assert.equal(seasonName(113), 'Spring', 'and it wraps back to Spring');
  assert.equal(seasonOf(28), 0, 'the whole opening month is season 0');
  assert.equal(seasonOf(29), 1, 'the next month turns the season');
});

test('the opening month is fully neutral (all terrains ×1.0)', () => {
  for (const terrain of ['grass', 'dirt', 'sand', 'rough', 'lava', 'water']) {
    for (const day of [1, 14, 28]) {
      assert.equal(seasonTerrainMult(day, terrain), 1.0, `${terrain} on day ${day} is untouched`);
    }
  }
});

test('winter slows land, spares roads/lava/water, and never speeds anything (admissible)', () => {
  assert.ok(seasonTerrainMult(85, 'grass') > 1.0, 'winter snow slows grass');
  assert.equal(seasonTerrainMult(85, 'lava'), 1.0, 'lava is not season-slowed');
  assert.equal(seasonTerrainMult(85, 'water'), 1.0, 'water is not season-slowed');
  // The admissibility invariant the A* heuristic relies on: NO season ever
  // makes a terrain cheaper than its base (every multiplier is >= 1.0).
  for (const season of CONFIG.SEASONS) {
    for (const m of Object.values(season.terrainMult)) {
      assert.ok(m >= 1.0, `${season.name} multiplier ${m} must be >= 1.0`);
    }
  }
});

test('stepCost: a grass step costs more in winter than in the opener; a road step is unaffected', () => {
  const s = twoTiles('grass', 'grass');
  s.day = 1;
  const springGrass = stepCost(s, hero(), 0, 0, 1, 0);
  s.day = 85;
  const winterGrass = stepCost(s, hero(), 0, 0, 1, 0);
  assert.ok(winterGrass > springGrass, `winter grass (${winterGrass}) costs more than spring (${springGrass})`);
  // Determinism: same day ⇒ same cost.
  assert.equal(stepCost(s, hero(), 0, 0, 1, 0), winterGrass);

  // A plowed road ignores the season entirely.
  const r = twoTiles('grass', 'grass', 'cobble');
  r.day = 1; const springRoad = stepCost(r, hero(), 0, 0, 1, 0);
  r.day = 85; const winterRoad = stepCost(r, hero(), 0, 0, 1, 0);
  assert.equal(winterRoad, springRoad, 'a road step costs the same in every season');
});

test('isSeasonChange fires on month boundaries past the opener only', () => {
  assert.equal(isSeasonChange(1), false, 'day 1 is not a change (the game just began)');
  assert.equal(isSeasonChange(15), false);
  assert.equal(isSeasonChange(29), true, 'month 2 dawns');
  assert.equal(isSeasonChange(57), true);
  assert.equal(isSeasonChange(85), true);
  assert.equal(isSeasonChange(30), false, 'mid-month is not a change');
});

test('seasonOf tolerates a missing/invalid day (falls back to the opener)', () => {
  assert.equal(seasonOf(undefined), 0);
  assert.equal(seasonOf(0), 0);
  assert.equal(seasonOf(-5), 0);
  assert.equal(currentSeason(undefined).name, 'Spring');
});
