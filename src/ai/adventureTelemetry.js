/**
 * adventureTelemetry.js — the adventure layer's half of the symmetric log.
 *
 * Same idea as battleTelemetry, one level up: when the PLAYER sends a hero
 * somewhere, run the AI's own goal scorer on the identical board and record
 * where their destination ranked among the goals it would have considered.
 *
 * The AI's adventure decisions are already recorded by ai/aiLog (the veto tally),
 * so this module exists for the reference class — the player's moves — plus the
 * per-day economy snapshot that makes "the AI cannot keep up on production"
 * a measurable claim instead of an impression.
 */

import { record, decision, telemetryEnabled } from './telemetry.js';
import { AITurnController } from './AIPlayer.js';
import { playerTowns, playerHeroes, levelObjects } from '../core/GameState.js';
import { armyValue } from '../core/heroUtils.js';

/**
 * Score a HUMAN hero's chosen destination against the AI's own goal ranking.
 *
 * A throwaway OBSERVER controller is built for the human's seat and discarded.
 * Reusing the AI's own scorer is the only honest way to ask "what would the AI
 * have done from exactly here": re-implementing the scoring for the human would
 * let the two drift, and a drifted reference class measures nothing.
 *
 * `observer: true` is load-bearing, not decoration. This comment used to claim
 * the plain controller was "pure scoring machinery with no side effects on the
 * world", and the code did not deliver that promise: pickGoal's tail wrote
 * hero.aiGoal / aiGoalMemory / aiGoalBans onto the HUMAN's hero and pushed a
 * goal-change row into the shared state.aiLog on every move order — and because
 * claimedTargets reads aiGoal off the seat's other heroes, one recorded move
 * fed back into the ranking of the next, so the reference class was not even a
 * pure function of the board. The observer mode (see AITurnController) keeps
 * the scoring identical and suppresses every one of those writes.
 */
export function recordHumanMove(state, hero, tx, ty, { path = null } = {}) {
  if (!telemetryEnabled(state) || !hero) return null;
  let goals = [];
  try {
    const ai = new AITurnController(state, hero.owner, { observer: true });
    ai.mainHeroId = hero.id;                 // the human's hero IS their main
    // Flood AFTER the caches exist, exactly as makePlan does. Clearing them
    // here (which is what this used to do) threw away the flood on the line
    // above and made every reach question inside the scan recompute from
    // scratch — the diagnostic cost several times what the decision it was
    // measuring costs, and the player waited for it before their hero moved.
    const reach = ai.floodCached
      ? ai.floodCached(hero.x, hero.y, hero.z ?? 0, !!hero.onBoat)
      : null;
    // pickGoal returns only its winner, but it fills the scan on the way — the
    // candidate list is what we came for, so read it off the recorded scan.
    const chosen = ai.pickGoal(hero, reach);
    const scan = ai._firstScan.get(hero.id);
    goals = ai._lastGoals || [];
    return record(state, decision({
      phase: 'adventure',
      channel: 'goal',
      actor: hero.owner,
      human: true,
      unit: hero.name || hero.id,
      subject: { x: hero.x, y: hero.y, z: hero.z ?? 0, mp: hero.mp, army: Math.round(armyValue(hero.army)) },
      candidates: goals.map((g) => ({
        label: `${g.what || 'goal'} @${g.x},${g.y}`,
        score: g.score,
        terms: { x: g.x, y: g.y },
      })),
      chosenIndex: findGoalIndex(goals, tx, ty),
      note: findGoalIndex(goals, tx, ty) < 0 ? 'not-in-candidate-set' : null,
      extra: {
        destination: { x: tx, y: ty },
        steps: path ? path.length : null,
        // What the AI would have done from this exact tile, so the two are
        // side by side in one line of the file.
        aiWouldPick: chosen && !chosen.hold ? { x: chosen.x, y: chosen.y, what: chosen.what || null } : (chosen?.hold ? 'hold' : null),
        vetoes: scan ? scan.vetoes : null,
      },
    }));
  } catch {
    return null; // a diagnostic must never break a player's move
  }
}

/** Where in the AI's ranking the human's destination sits; −1 if never generated. */
function findGoalIndex(goals, tx, ty) {
  return goals.findIndex((g) => g.x === tx && g.y === ty);
}

/**
 * One economy row per realm per day: what it holds, what it earns, what it can
 * field. The aggregate of these IS the "they cannot keep up with production and
 * economy" claim, turned into a curve that can be looked at.
 *
 * Deliberately cheap and flat — it is sampled every day for every realm, so it
 * carries counts and totals, never nested structures.
 */
export function recordEconomy(state, dailyIncome = null) {
  if (!telemetryEnabled(state)) return null;
  for (const p of state.players || []) {
    if (p.defeated) continue;
    const towns = playerTowns(state, p.index);
    const heroes = playerHeroes(state, p.index);
    let mines = 0;
    for (const lvl of state.map?.underground ? [0, 1] : [0]) {
      for (const o of Object.values(levelObjects(state, lvl))) {
        if (o.type === 'mine' && o.owner === p.index) mines++;
      }
    }
    record(state, {
      phase: 'economy',
      kind: 'economy',
      actor: p.index,
      name: p.name,
      human: !!p.isHuman,
      gold: Math.round(p.resources?.gold || 0),
      towns: towns.length,
      heroes: heroes.length,
      mines,
      buildings: towns.reduce((n, t) => n + (t.buildings?.length || 0), 0),
      army: Math.round(heroes.reduce((n, h) => Math.max(n, armyValue(h.army)), 0)),
      armyTotal: Math.round(heroes.reduce((n, h) => n + armyValue(h.army), 0)),
      garrison: Math.round(towns.reduce((n, t) => n + armyValue(t.garrison), 0)),
      ...(dailyIncome ? { income: Math.round(dailyIncome(state, p)?.gold || 0) } : {}),
    });
  }
  return true;
}
