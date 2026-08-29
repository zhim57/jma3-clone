/**
 * seasons.js — Seasons: every month (4 weeks) the world turns through a
 * four-season cycle (see CONFIG.SEASONS), derived deterministically from
 * state.day so it round-trips saves for free and needs no state of its own.
 *
 * A season only ever SLOWS off-road land travel (all multipliers >= 1.0, so the
 * A* heuristic stays admissible and plowed roads are untouched); the opening
 * month is temperate, so the early game plays exactly as before and the world
 * only shifts from month 2 on. Pure functions — Pathfinding.stepCost reads the
 * multiplier, the view reads the name/tint for its seasonal wash + a toast.
 */

import { CONFIG } from '../config.js';

const DAYS_PER_MONTH = 4 * CONFIG.DAYS_PER_WEEK;

/** 0-based season index for an absolute day (day 1 → season 0, the opener). A
 *  missing/invalid day (e.g. a bare pathfinding test state) falls back to the
 *  temperate opener, so a day-less caller pays no season penalty. */
export function seasonOf(day) {
  const d = Number.isFinite(day) && day >= 1 ? day : 1;
  const month = Math.floor((d - 1) / DAYS_PER_MONTH); // 0-based month
  return month % CONFIG.SEASONS.length;
}

/** The season descriptor ({ name, tint, terrainMult }) for a day. */
export function currentSeason(day) {
  return CONFIG.SEASONS[seasonOf(day)];
}

/** Human-readable season name for a day (e.g. 'Winter'). */
export function seasonName(day) {
  return currentSeason(day).name;
}

/**
 * Movement-cost multiplier this season lays on a terrain (>= 1.0; 1.0 when the
 * season doesn't touch that terrain, or on the temperate opening month).
 */
export function seasonTerrainMult(day, terrain) {
  return currentSeason(day).terrainMult[terrain] ?? 1.0;
}

/** True on the first day of a new season (a month boundary past the opener). */
export function isSeasonChange(day) {
  return day > DAYS_PER_MONTH && (day - 1) % DAYS_PER_MONTH === 0;
}
