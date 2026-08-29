/**
 * invaderRealms.js — INERT STUB (jma3-clone). See core/invasions.js.
 *
 * `isInvaderRealm` keeps its real one-line implementation because core/patrons.js
 * and core/uprisings.js branch on it: with no invader realms it is simply always
 * false, which is the correct answer rather than a faked one.
 */

export const isInvaderRealm = (state, playerIndex) => !!state.players?.[playerIndex]?.invader;

export function beachheadCap() { return 0; }
export function livingInvaderRealms() { return []; }
export function invaderQueue() { return []; }
export function foundInvaderRealm() { return null; }
export function beachheadBuildings() { return []; }
export function plantBeachhead() { return null; }
export function musterCommander() { return null; }
export function landInvaderNation() { return null; }
export function razeBeachhead() { return null; }
export function footholdBroken() { return false; }
