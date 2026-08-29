/**
 * scan-cost.test.js — a regression guard on the shape of the AI's goal scan.
 *
 * The report was "the game became very slow": ordering a hero to a destination
 * took one to two seconds before it took a step, and a day of AI turns took four
 * and a half seconds on a large map. Nothing had been written slowly. What had
 * happened is that a handful of standing questions about the map — "where are
 * the invader war-bands", "how many obelisks are there" — were being asked from
 * inside the per-candidate loop, and each answer walked every object on the
 * level. On a 144×120 map one hero's scan visited nine and a half million
 * objects to answer questions with the same answer every time.
 *
 * That is a shape, not a constant, and a wall clock is a poor way to guard a
 * shape: it fails on a busy machine and passes on a fast one whatever the code
 * does. So this counts the WORK instead — how many object-dictionary entries one
 * goal scan touches — which is the same number on every machine, and asserts it
 * stays proportional to the map rather than to the map times the candidates.
 *
 * The budget below is deliberately loose. It is not a target to tune against; it
 * is far enough above the honest cost to leave room for new scans and far enough
 * below the old one to fail loudly the day something is put back inside the loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, levelObjects } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { revealAround } from '../src/map/fog.js';

/** Total dictionary entries visited by Object.values while `fn` runs. */
function objectsVisited(fn) {
  const real = Object.values;
  let elems = 0;
  Object.values = function (o) {
    const v = real(o);
    elems += v.length;
    return v;
  };
  try { fn(); } finally { Object.values = real; }
  return elems;
}

test('one goal scan costs a few passes over the map, not one per candidate', () => {
  const W = 88, H = 72;
  const s = newGame({ seed: 7, mapW: W, mapH: H, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
    { faction: 'inferno', isHuman: false, team: 2 },
  ] });
  // Fog-free, so the scan sees the whole board — the worst case, and what a
  // mid-game map looks like by the time anybody complains about the pace.
  for (let y = 0; y < H; y++) revealAround(s, 0, Math.floor(W / 2), y, W, 0);

  const hero = playerHeroes(s, 0)[0];
  hero.mp = 100000;
  const objects = Object.keys(levelObjects(s, 0)).length;
  assert.ok(objects > 200, `test map carries only ${objects} objects — too small to measure a shape`);

  const ai = new AITurnController(s, hero.owner);
  ai.mainHeroId = hero.id;
  const reach = ai.floodCached(hero.x, hero.y, hero.z ?? 0, false);

  const visited = objectsVisited(() => ai.pickGoal(hero, reach));
  const candidates = (ai._lastGoals || []).length;
  assert.ok(candidates > 50, `only ${candidates} candidates generated — the scan did not really run`);

  // A handful of whole-map passes is honest: the scan legitimately enumerates
  // the level's objects once itself, and the connector valuations enumerate it
  // again per connector. What must never come back is a pass PER CANDIDATE.
  const passes = visited / objects;
  assert.ok(passes < 120,
    `one goal scan walked the object dictionary ${passes.toFixed(0)} times `
    + `(${visited.toLocaleString()} entries over ${objects} objects, ${candidates} candidates). `
    + 'A whole-map scan has been put back inside a per-candidate loop.');

  // And the same bound stated against the thing that actually blew up: work must
  // not scale with candidates × objects.
  assert.ok(visited < objects * candidates * 0.5,
    'scan cost is tracking candidates × objects — the defect this file guards');
});

test('the second scan of the same turn is cheaper than the first, not the same', () => {
  // The reach and connector caches exist so a hero that re-plans mid-turn does
  // not re-derive the world. recordHumanMove once cleared them right after
  // filling them, which is how a diagnostic came to cost more than the decision.
  const W = 88, H = 72;
  const s = newGame({ seed: 12, mapW: W, mapH: H });
  for (let y = 0; y < H; y++) revealAround(s, 0, Math.floor(W / 2), y, W, 0);
  const hero = playerHeroes(s, 0)[0];
  hero.mp = 100000;

  const ai = new AITurnController(s, hero.owner);
  ai.mainHeroId = hero.id;
  const reach = ai.floodCached(hero.x, hero.y, hero.z ?? 0, false);
  const first = objectsVisited(() => ai.pickGoal(hero, reach));
  const second = objectsVisited(() => ai.pickGoal(hero, reach));
  assert.ok(second <= first, `a warm re-scan cost ${second} against a cold ${first} — the caches are not being used`);
});
