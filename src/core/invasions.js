/**
 * invasions.js — INERT STUB (jma3-clone).
 *
 * The full game ships a PvE "invasion" system: foreign peoples land waves of
 * war-bands that besiege towns. This clone exists to study AI PLAYER logic, and
 * invasions are out of scope, so this module keeps the full module's export
 * surface and returns exactly what the real one returns when its feature flag is
 * off (`features.invasions` defaults to false upstream).
 *
 * WHY A STUB AND NOT A DELETION
 * -----------------------------
 * `core/actions.js` and `ai/AIPlayer.js` import from here. Those two files are
 * 63% of the AI dependency closure and they are the files a novel AI idea has to
 * travel back to the parent repo in. Keeping this module's shape lets both stay
 * BYTE-IDENTICAL to upstream, so a patch developed here applies cleanly there and
 * a change made there applies cleanly here. The stub is the price of that.
 *
 * Every function below matches the real module's flag-off return value. If you
 * ever want the real behaviour, copy the file back from the parent repo — nothing
 * else in this tree needs to change.
 */

export const INVADER_PEOPLES = [];
export const WAVE_TIERS = [];

export function waveTier() { return null; }
export function initInvasions() { return null; }
export function noteBandBroken() { return null; }
export function settleWaves() { return []; }
export function bandBudget() { return 0; }
export function realmBenchmark() { return 0; }
export function bandSize() { return 0; }
export function invasionAreaScale() { return 1; }
export function bandSpeed() { return 0; }
export function bandCreature() { return null; }
export function splitBand() { return []; }
export function landWave() { return []; }
export function townDefense() { return 0; }
export function bandForce() { return 0; }
export function bandUnitWorth() { return 0; }
export function assaultIsPlayable() { return false; }
export function bandCanStorm() { return false; }
export function settleAssault() { return null; }
export function sackTown() { return null; }
export function invasionPeriod() { return 0; }

/** Real module returns null here when the feature is off. */
export function invasionTruce() { return null; }
export function daysToNextWave() { return null; }

/** No bands ever exist in this clone. */
export function activeBands() { return []; }
export function tickInvasions() { return []; }
