/**
 * aiperf.mjs — where does a computer turn's time actually go?
 *
 * "The AI turn takes too long" has two candidate causes and they have nothing to
 * do with each other:
 *
 *   ENGINE     AITurnController.next() thinking — goal scoring, pathfinding,
 *              combat previews. Headless, measurable here. Driven the way the
 *              scene now drives it — in AI_SLICE_MS time slices — so the SLICES
 *              line below is the actual worst main-thread block a browser sees,
 *              while the per-turn totals stay comparable to old readings.
 *   ANIMATION  AdventureScene.playAiTrail gliding the tokens at STEP_ANIM_MS ÷
 *              animSpeed per visible tile. Not measurable here, but this script
 *              supplies the multiplicand (steps) and applies the scene's model:
 *              off-screen steps land instantly, and one AI turn's trail is
 *              capped by AI_TRAIL_BUDGET_MS (pace compresses, then the tail
 *              fast-forwards).
 *
 * So this reports BOTH — because a fix aimed at the wrong one is wasted.
 *
 * THE DEFAULT IS THE LARGEST SHIPPED PRESET (88×72, the "Age of Empires"
 * scenario) over 60 days. The old default — 30 days at 44×38 — sampled a game
 * that ended around day 10 on a map 3.7× smaller than the biggest one in the
 * Custom Scenario menu, measured ~100ms turns, and calibrated a year of "the
 * engine is not the problem" belief on a configuration that cannot exhibit the
 * problem: at 88×72 the blow-up starts around day 40 and the same instrument
 * read a 714ms mean and 2.8s max per turn. An instrument whose default cannot
 * show the disease it exists to measure is a blind spot, not a baseline. The
 * price is that this script now runs ~30s and lives in the SLOW set of
 * tests/sim-scripts.test.js (it runs under `npm run sim:all`).
 *
 * Usage:
 *   node scripts/sim/aiperf.mjs            # 60 days, 88×72 — the shipped worst case
 *   node scripts/sim/aiperf.mjs 30 44 38   # the old small-map reference point
 */

import { performance } from 'node:perf_hooks';
import { CONFIG } from '../../src/config.js';
import { newGame, currentPlayer } from '../../src/core/GameState.js';
import { isExplored } from '../../src/map/fog.js';
import { endTurn } from '../../src/core/actions.js';
import { AITurnController } from '../../src/ai/AIPlayer.js';
import { getSetting } from '../../src/game/settings.js';
import { structural, structuralSummary } from './_assert.mjs';

const DAYS = Number(process.argv[2]) || 60;
const W = Number(process.argv[3]) || 88;
const H = Number(process.argv[4]) || 72;

const state = newGame({
  seed: 20260729,
  mapW: W,
  mapH: H,
  // BOTH SIDES PLAYED. An idle human is conquered inside a fortnight and the
  // sample ends before the turns that hurt — which are the late ones, when the
  // map is explored and the AI has several heroes.
  players: [
    { faction: 'castle', isHuman: false, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ],
});

const turns = [];
const slices = [];
let guard = DAYS * (state.players.length + 4) + 60;
while (state.winner === null && state.day <= DAYS && guard-- > 0) {
  const pi = currentPlayer(state).index;
  if (!state.players[pi].isHuman && !state.players[pi].defeated) {
    const ai = new AITurnController(state, pi);
    // Sliced exactly as AdventureScene slices it, so each next() call below is
    // one main-thread block as the browser would experience it. Slicing never
    // changes what the turn computes (tests/ai-slicing.test.js proves the
    // sliced and unsliced games byte-identical), so the per-turn totals remain
    // comparable with readings taken before slicing existed.
    let r, total = 0, worst = 0, g = 200000;
    do {
      const t0 = performance.now();
      r = ai.next(CONFIG.AI_SLICE_MS);
      const ms = performance.now() - t0;
      total += ms;
      if (ms > worst) worst = ms;
      slices.push(ms);
      if (r.type === 'combat') ai.autoFight(r.context);
    } while (r.type !== 'done' && g-- > 0);
    // Not a measurement: a budgeted turn that cannot reach 'done' in two
    // hundred thousand slices is a controller that stopped making progress.
    structural(g > 0, 'a sliced AI turn must terminate (next() stopped progressing)');
    // What the scene would consider animating: steps on a tile PLAYER 0 has
    // explored (everything else returns instantly). The scene further skips
    // off-screen steps and budgets the rest — applied in the report below.
    const seen = ai.moveLog.filter((mv) => isExplored(state, 0, mv.to.x, mv.to.y)
      || isExplored(state, 0, mv.from.x, mv.from.y)).length;
    turns.push({ day: state.day, pi, ms: total, worst, m: { ...ai.metrics }, moves: ai.moveLog.length, seen });
  }
  endTurn(state);
}

const ms = turns.map((t) => t.ms).sort((a, b) => a - b);
const pick = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
const sum = (f) => turns.reduce((a, t) => a + f(t), 0);

console.log(`\n${turns.length} AI turns over ${DAYS} days on ${W}x${H}\n`);
console.log('  ENGINE (AITurnController.next, headless, per whole turn)');
console.log(`    total ${(sum((t) => t.ms) / 1000).toFixed(2)}s   `
  + `mean ${(sum((t) => t.ms) / turns.length).toFixed(0)}ms   `
  + `median ${pick(0.5).toFixed(0)}ms   p90 ${pick(0.9).toFixed(0)}ms   max ${ms[ms.length - 1].toFixed(0)}ms`);
console.log(`    pathfinds ${sum((t) => t.m.pathfinds)}   goalPicks ${sum((t) => t.m.goalPicks)}   `
  + `steps ${sum((t) => t.m.steps)}   combat previews ${sum((t) => t.m.stanceSims || 0)}`);

// The freeze the player can still feel: the longest single main-thread block.
// The budget is AI_SLICE_MS; a slice overruns it by its last atomic unit of
// work (one plan, one auto-battle), so the max here — not the turn totals
// above — is what a frame drop during the computer turn looks like.
const sl = [...slices].sort((a, b) => a - b);
const slp = (q) => sl[Math.min(sl.length - 1, Math.floor(q * sl.length))];
console.log(`\n  SLICES (budget ${CONFIG.AI_SLICE_MS}ms — each is one uninterrupted main-thread block)`);
console.log(`    ${sl.length} slices   median ${slp(0.5).toFixed(1)}ms   p90 ${slp(0.9).toFixed(1)}ms   `
  + `p99 ${slp(0.99).toFixed(1)}ms   max ${sl[sl.length - 1].toFixed(0)}ms`);

// The animation cost, per the scene's actual model: explored steps are the
// upper bound of what animates (the follow-camera can keep a whole march in
// view), at STEP_ANIM_MS ÷ animSpeed per step, capped per AI turn by
// AI_TRAIL_BUDGET_MS (pace compresses toward AI_TRAIL_MIN_STEP_MS, then the
// tail lands instantly).
const pace = CONFIG.STEP_ANIM_MS / getSetting('animSpeed');
const budgetMs = CONFIG.AI_TRAIL_BUDGET_MS;
const trailMs = (steps) => Math.min(steps * pace, budgetMs + pace);
const moves = sum((t) => t.moves);
const seen = sum((t) => t.seen);
console.log('\n  ANIMATION (AdventureScene.playAiTrail — explored steps, scene model applied)');
console.log(`    move-log steps ${moves}   of which on explored tiles ${seen} `
  + `(${(100 * seen / Math.max(1, moves)).toFixed(0)}%)`);
console.log(`    at ${CONFIG.STEP_ANIM_MS}ms/step ÷ animSpeed ${getSetting('animSpeed')} = ${pace.toFixed(0)}ms, `
  + `budget ${(budgetMs / 1000).toFixed(0)}s/turn → `
  + `${(sum((t) => trailMs(t.seen)) / turns.length / 1000).toFixed(1)}s per AI turn on average, `
  + `${(Math.max(...turns.map((t) => trailMs(t.seen))) / 1000).toFixed(1)}s at worst`
  + `  (unbudgeted: ${(seen * pace / turns.length / 1000).toFixed(1)}s / `
  + `${(Math.max(...turns.map((t) => t.seen)) * pace / 1000).toFixed(1)}s)`);
// The trail grows as the map opens, so the average hides the shape.
const byQuarter = [0, 1, 2, 3].map((q) => {
  const slice = turns.slice(Math.floor(q * turns.length / 4), Math.floor((q + 1) * turns.length / 4));
  return slice.length ? slice.reduce((a, t) => a + t.seen, 0) / slice.length : 0;
});
console.log(`    explored steps per turn by quarter of the game: `
  + byQuarter.map((x) => x.toFixed(0)).join(' → '));

console.log('\n  slowest turns');
for (const t of [...turns].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
  console.log(`    day ${String(t.day).padStart(3)}  ${t.ms.toFixed(0).padStart(6)}ms  `
    + `worst slice ${t.worst.toFixed(0).padStart(4)}ms  `
    + `pathfinds ${String(t.m.pathfinds).padStart(4)}  steps ${String(t.m.steps).padStart(4)}  `
    + `moves ${String(t.moves).padStart(4)}  explored ${String(t.seen).padStart(4)}`);
}
structuralSummary();
