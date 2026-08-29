/**
 * helpers.js — shared test utilities. NOT a test file: the name does not match
 * node --test's discovery patterns, so it is only ever imported.
 */

import { endTurn } from '../src/core/actions.js';

/**
 * Advance `days` WHOLE DAYS, calling `onDay(state)` after each one.
 *
 * `endTurn` advances ONE PLAYER'S TURN, not one day. A plain
 * `for (i < 14) endTurn(state)` covers seven days in a two-player game, and
 * that has produced at least two confident, wrong conclusions in this project's
 * history (HANDOVER §2.5). So the loop watches `state.day` actually move rather
 * than counting calls.
 *
 * This existed as six hand-rolled copies across the suite, and they had already
 * drifted into THREE different guard formulas — `(players + 2) + 20`,
 * `(players + 2) + 40` and `(players + 4) + 40`. Nothing was broken by that
 * yet, which is the point: six copies of a trap is five chances to get it wrong
 * later. The shared guard takes the most generous of the three, so no caller
 * that relied on the loosest bound can start failing.
 *
 * The guard is a runaway backstop, not a schedule: it exists because `endTurn`
 * can decline to advance (a defeated player, a finished game) and an unguarded
 * `while (state.day < until)` would then spin forever.
 */
export function runDays(state, days, onDay) {
  const until = state.day + days;
  let guard = days * (state.players.length + 4) + 40;
  let seen = state.day;
  while (state.day < until && state.winner === null && guard-- > 0) {
    endTurn(state);
    if (state.day !== seen) { seen = state.day; onDay?.(state); }
  }
  return state;
}
