/**
 * ai-slicing.test.js — the AI turn's time budget must never change the game,
 * and the walkability accelerators must never change an answer.
 *
 * The 2026-08 AI-turn-freeze work did two kinds of thing to AIPlayer:
 *
 *   SLICING    next(budgetMs) returns { type: 'paused' } at safe checkpoints so
 *              AdventureScene can hand the browser a frame mid-turn. This is
 *              pure control flow — WHERE the wall clock lands must not leak
 *              into WHAT the turn computes, or the same seed would play
 *              different games on a fast and a slow machine, which is the one
 *              thing this codebase's determinism contract forbids.
 *   FAST WALKS makeWalkContext + the per-plan walk masks turn isWalkable's
 *              per-probe hero scan and zone-of-control scan into array reads.
 *              They are accelerators, not approximations: every answer must be
 *              bit-for-bit what the scans give.
 *
 * Both invariants are structural (true by construction, false only when
 * broken), so both are asserted EXACTLY — no tolerances, no "close enough".
 * The equality test drives a pathologically tiny budget so a pause fires at
 * every checkpoint the code has: maximal slicing against zero slicing is the
 * widest gap the mechanism can produce, and the serialized states must still
 * match byte for byte (rng call counts included — a single extra draw fails).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, currentPlayer, serialize } from '../src/core/GameState.js';
import { endTurn } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { isWalkable, makeWalkContext, findPath } from '../src/map/Pathfinding.js';
import { playerHeroes } from '../src/core/GameState.js';

const PLAYERS = [
  { faction: 'castle', isHuman: false, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
];

/** Play `days` of AI-vs-AI, driving every turn with the given budget. */
function playDays(days, budget) {
  const s = newGame({ seed: 20260729, mapW: 44, mapH: 38, players: PLAYERS.map((p) => ({ ...p })) });
  let pauses = 0;
  let guard = days * 8 + 60;
  while (s.winner === null && s.day <= days && guard-- > 0) {
    const pi = currentPlayer(s).index;
    if (!s.players[pi].isHuman && !s.players[pi].defeated) {
      const ai = new AITurnController(s, pi);
      let r, g = 100000;
      do {
        r = ai.next(budget);
        if (r.type === 'combat') ai.autoFight(r.context);
        if (r.type === 'paused') pauses++;
      } while (r.type !== 'done' && g-- > 0);
      assert.ok(g > 0, 'a budgeted turn must terminate — next() stopped progressing');
    }
    endTurn(s);
  }
  return { state: s, pauses };
}

test('a maximally sliced game is byte-identical to an unsliced one', () => {
  // 0 = the old contract: whole turn per call, the clock is never read.
  const whole = playDays(12, 0);
  assert.equal(whole.pauses, 0, 'no budget must mean no pauses, ever');
  // A budget far below the smallest unit of work forces a pause at EVERY
  // checkpoint (the progress guard admits exactly one unit per call).
  const sliced = playDays(12, 1e-6);
  assert.ok(sliced.pauses > 100,
    `fixture: the tiny budget should pause constantly, got ${sliced.pauses}`);
  assert.equal(JSON.stringify(serialize(sliced.state)), JSON.stringify(serialize(whole.state)),
    'slicing changed the game — a checkpoint is doing work, or skipping some');
});

test('walk context and per-plan masks answer exactly as the scans do', () => {
  const s = newGame({ seed: 7, mapW: 44, mapH: 38, players: PLAYERS.map((p) => ({ ...p })) });
  const { w, h } = s.map;
  // Park a hero mid-map so the hero-occupancy half of the context has a body
  // to disagree about (generated heroes start on their towns' doorsteps).
  const hero = playerHeroes(s, 0)[0];
  hero.x = Math.floor(w / 2); hero.y = Math.floor(h / 2);
  // An exempt monster, so the exemption path is exercised too.
  const monster = Object.values(s.map.objects).find((o) => o.type === 'monster');
  assert.ok(monster, 'fixture: the generated map should carry monsters');

  for (const exempt of [null, monster.id]) {
    for (const boat of [false, true]) {
      const ctx = makeWalkContext(s, 0, exempt);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          assert.equal(
            isWalkable(s, x, y, -1, exempt, boat, 0, 0, ctx),
            isWalkable(s, x, y, -1, exempt, boat, 0, 0),
            `ctx disagrees with the scan at (${x},${y}) boat=${boat} exempt=${exempt}`,
          );
        }
      }
    }
  }

  // The plan-scoped mask must reproduce a fresh flood exactly: same predicate,
  // same world, so the reach it produces is the same array.
  const ai = new AITurnController(s, 0);
  for (const boat of [false, true]) {
    const mask = ai.walkMaskCached(0, boat);
    const bare = ai.flood(hero.x, hero.y, 0, boat);
    const masked = ai.flood(hero.x, hero.y, 0, boat, mask);
    assert.deepEqual(Array.from(masked), Array.from(bare),
      `flood with the shared mask diverged (boat=${boat})`);
  }

  // And findPath still routes: a spot check that the accelerated A* finds a
  // path a plain walk of the returned steps confirms tile by tile.
  const target = Object.values(s.map.objects).find((o) => o.type === 'mine');
  assert.ok(target, 'fixture: the generated map should carry mines');
  const found = findPath(s, hero, target.x, target.y, -1);
  if (found) {
    let px = hero.x, py = hero.y;
    for (const step of found.path) {
      assert.ok(Math.abs(step.x - px) <= 1 && Math.abs(step.y - py) <= 1,
        'A* path must advance one adjacent tile at a time');
      px = step.x; py = step.y;
    }
    assert.equal(px, target.x); assert.equal(py, target.y);
  }
});
