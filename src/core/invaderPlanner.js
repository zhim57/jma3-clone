/**
 * invaderPlanner.js — INERT STUB (jma3-clone). See core/invasions.js for why the
 * invasion cluster is stubbed rather than deleted (it keeps core/actions.js and
 * ai/AIPlayer.js byte-identical to the parent repo).
 *
 * Returns exactly what the real planner returns with `features.invasions` off.
 */

export function initInvaderPlan() { return null; }
export function defenderForce() { return 0; }
export function tickInvaderTempo() { return []; }
export function daysToNextNation() { return null; }
export function averageRealmArmy() { return 0; }
export function wavePowerBase() { return 0; }
const STATS = ['attack', 'defense', 'power', 'knowledge'];

/**
 * The best commander in the world: highest primary-stat SUM and highest level
 * among the realms' heroes.
 *
 * REAL BODY, NOT A STUB — and it has to be. Despite living in this module it is
 * not an invasion function and is not behind the invasions flag: core/actions.js
 * calls it unconditionally every day for the chronicle's day record
 * (`bestHeroStat` / `bestHeroLevel`), and dereferences the result. A null here is
 * a crash on day one of every game, invasions or not.
 */
export function bestHero(state) {
  let statSum = 0, level = 1;
  for (const h of Object.values(state.heroes || {})) {
    const p = state.players?.[h.owner];
    if (!p || p.defeated || p.invader) continue;
    statSum = Math.max(statSum, STATS.reduce((n, k) => n + (h.stats?.[k] || 0), 0));
    level = Math.max(level, h.level || 1);
  }
  return { statSum, level };
}

/** The average commander — mean stat sum and mean level. Real body, same reason. */
export function averageHero(state) {
  const heroes = Object.values(state.heroes || {})
    .filter((h) => { const p = state.players?.[h.owner]; return p && !p.defeated && !p.invader; });
  if (!heroes.length) return { statSum: 0, level: 1 };
  let stats = 0, level = 0;
  for (const h of heroes) {
    stats += STATS.reduce((n, k) => n + (h.stats?.[k] || 0), 0);
    level += h.level || 1;
  }
  return { statSum: stats / heroes.length, level: level / heroes.length };
}
export function factionTroop() { return null; }
export function factionSpread() { return []; }
export function planWave() { return null; }
export function reinforceInvaders() { return []; }
export function tickInvaderPlanner() { return []; }
export function invasionForecast() { return null; }
