/**
 * rigidity.js — where a heavier tip is worth buying, measured against the roster
 * that exists.
 *
 * The gain from added head mass rises with armour hardness, PEAKS, and falls away.
 * That interior peak is the design object: monotone would mean "mass helps more
 * the harder the armour", which is a direction; a peak means mass has a TARGET
 * NICHE, which is a richer thing for a player to find. But the peak's location is
 * set by `PHYS_RIGIDITY_SD_PER_PA`, the tip's area and mass, the blow's energy,
 * the reference stopping depth and the target's coverage — and NONE of those was
 * chosen to place it. It landed inside the roster by luck.
 *
 * MEASURED, NOT MODELLED — twice over.
 *
 * The first attempt at a closed form claimed the peak sits at `SD/k`. That is
 * where the CLAMP WINDOW ends; the gain goes on rising past it because p/(p+h) is
 * still saturating. Writing `through` out shows the shape depends on h·k·A/m AND
 * on h·A·d/E separately, so it is not a function of sectional density alone.
 *
 * The second attempt scanned a synthetic hardness axis at a fixed 90% coverage,
 * and that was the wrong basis: coverage moves the peak as much as hardness does,
 * so a synthetic sweep at one coverage measures a creature that does not exist. So
 * the niche is scanned over the ACTUAL ROSTER, each target carrying its own
 * (hardness, coverage) pair. The question is not "where is the maximum of a
 * curve" but "which creature is this upgrade FOR", which is the question a player
 * has, and the only one whose answer can be checked against content.
 *
 * Pure, and in core (I11) because both `tests/` and `scripts/sim/` need the same
 * answer. It imports the damage model's `penetrate` rather than re-deriving it.
 */

import { CREATURES } from '../data/creatures.js';
import { CONFIG } from '../config.js';
import { penetrate } from './combat/physicalDamage.js';

/**
 * THE HARDNESS THE MODEL ACTUALLY USES, which is not the authored one.
 *
 * `blow()` folds the target's Defense stat into the armour before the penetration
 * contest: `h_eff = armorHardness_pa · (1 + defense · PHYS_DEFENSE_COUPLING)`. Every
 * per-hit instrument in this project read the AUTHORED figure instead, and that
 * single omission produced a phantom defect.
 *
 * The fork's battle results looked as though the battle layer inverted the per-hit
 * sign at mid-coverage — champion at +25.5% per hit losing by 4.7 points — and it was
 * logged as an unexplained anomaly needing its own diagnostic. It needed none. A
 * Champion has Defense 16, so its 0.45 GPa of plate meets an arrow as **1.67 GPa**,
 * and at 1.67 GPa the isocline puts the boundary at 81% coverage against the
 * Champion's 65%: the broadhead wins, exactly as measured. A centaurCaptain has
 * Defense 3, so the same authored 0.45 GPa is 0.68 GPa effective.
 *
 * Predicted from authored hardness: 8 of 12 battle outcomes. From effective
 * hardness: **12 of 12.** There was never an anomaly, and the "matched pair" that
 * appeared to fail was never matched — the two creatures share an authored number
 * and differ by 2.5x in the coordinate the model reads.
 *
 * So: a per-hit calculation compared against a battle must use this, not `phys`.
 */
export function effectiveHardness(phys, defense = 0) {
  return phys.armorHardness_pa * (1 + defense * CONFIG.PHYS_DEFENSE_COUPLING);
}

/**
 * How many authored targets must sit STRICTLY EITHER SIDE of the niche.
 *
 * Stated as a count rather than as a fraction of the ladder, because a fraction
 * quantises badly: on a 16-creature ladder the achievable margins are multiples
 * of 1/15, so a 0.2 threshold is met with exact equality and any ladder change
 * moves the metric without anything real changing. Two harder and two softer is
 * what "away from the edges" actually means — there is content on both sides of
 * the niche, so choosing into it is a choice.
 */
export const NICHE_EITHER_SIDE = 2;
/** Gain above which a target counts as one this investment actually pays against. */
export const NICHE_PAYS = 1.05;
/** How many targets must pay, or the niche is a single creature and not a class. */
export const NICHE_MIN_PAYING = 3;

/** Authored targets, ascending by armour hardness — the sampled distribution. */
export function armourLadder(creatures = CREATURES) {
  return Object.entries(creatures)
    .filter(([, c]) => c.phys)
    .map(([id, c]) => ({
      id,
      gpa: c.phys.armorHardness_gpa,
      // Both, always, and never one without the other — see effectiveHardness.
      effGpa: effectiveHardness(c.phys, c.defense) / 1e9,
      defense: c.defense,
      cover: c.phys.armorCoverage_frac,
      phys: c.phys,
    }))
    .sort((a, b) => a.gpa - b.gpa);
}

/**
 * Which targets added mass pays against, for one tip.
 *
 * `massScale` is the increase being priced. Every target is evaluated with its
 * OWN hardness and coverage, so the answer is about the roster rather than about
 * a curve.
 *
 * Returns `{ rows, best, bestIndex, softer, harder, paying, ok }` — how many
 * authored targets sit either side of the niche, and how many of them the
 * investment actually pays against.
 */
export function massNiche(phys, massScale = 1.4, creatures = CREATURES) {
  const heavier = { ...phys, blowMass_kg: phys.blowMass_kg * massScale };
  const ladder = armourLadder(creatures);
  const rows = ladder.map((t) => {
    const h = t.phys.armorHardness_pa;
    const gain = penetrate(heavier.blowEnergy_j, heavier, h, t.cover)
      / penetrate(phys.blowEnergy_j, phys, h, t.cover);
    return { ...t, gain };
  });
  let bestIndex = 0;
  rows.forEach((r, i) => { if (r.gain > rows[bestIndex].gain) bestIndex = i; });
  const softer = bestIndex;
  const harder = rows.length - 1 - bestIndex;
  const paying = rows.filter((r) => r.gain >= NICHE_PAYS).length;
  return {
    rows,
    best: rows[bestIndex],
    bestIndex,
    softer,
    harder,
    paying,
    ok: softer >= NICHE_EITHER_SIDE && harder >= NICHE_EITHER_SIDE && paying >= NICHE_MIN_PAYING,
  };
}

/** Every authored shooter's niche — the set the invariant is taken over. */
export function shooterNiches(massScale = 1.4, creatures = CREATURES) {
  return Object.entries(creatures)
    .filter(([, c]) => c.phys && c.reach === 'ranged')
    .map(([id, c]) => ({ id, ...massNiche(c.phys, massScale, creatures) }));
}

// ---------------------------------------------------------------------------
// DISTANCE TO THE FORK'S BOUNDARY — the authoring metric, replacing three proxies.
//
// "Fill the hardness gap", "fill the coverage gap" and "decorrelate locally" were
// all PROXIES for one requirement: targets must sit near the boundary the fork
// turns on. Each proxy was satisfiable while the thing it stood for was not, and
// each failed differently — the hardness gap was closed and the coverage gap
// inherited it; the coverage gap was closed and the targets still sat far from the
// curve; the decorrelation passed on the authored axis and failed on the real one.
//
// So the metric is stated directly. Coverage enters the model as ODDS, so the
// natural measure is the odds ratio against the boundary at that target's own
// effective hardness:
//
//     ratio = [c/(1−c)] / [c*/(1−c*)]      1 = on the boundary
//
// Calibrated by the registered pair: 25% coverage where the boundary is 40.3% is
// ratio 0.49 and predicts −4.63% per hit; 55% is ratio 1.81 and predicts +7.46%.
// So 0.7–1.4 is the DISCRIMINATING BAND, worth roughly ±2–3 points of battle
// margin — which is near the ±0.8 precision of a 60-seed paired comparison, so
// near-boundary targets need more seeds. Nearer the boundary is more discriminating
// AND noisier, and that trade is the design decision rather than an accident.

/** The discriminating band in odds-ratio terms — inside it, the fork is a real question. */
export const DISCRIMINATING_BAND = [0.7, 1.4];

/**
 * The fork's boundary coverage at a given EFFECTIVE hardness, by bisection on the
 * engine's own `penetrate`. Returns null when the narrow head cannot win at any
 * coverage. `heads` is `{ narrow, wide }` — two patched `phys` blocks.
 */
export function boundaryCoverage(heads, hardnessPa) {
  const rel = (c) => penetrate(heads.narrow.blowEnergy_j, heads.narrow, hardnessPa, c)
    / penetrate(heads.wide.blowEnergy_j, heads.wide, hardnessPa, c) - 1;
  const lo0 = 1e-4, hi0 = 1 - 1e-4;
  if (rel(hi0) < 0) return null;
  if (rel(lo0) > 0) return 0;
  let lo = lo0, hi = hi0;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (rel(m) < 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

const odds = (c) => c / (1 - c);

/**
 * How far a target sits from the fork's boundary, as an odds ratio at its own
 * effective hardness. `> 1` favours the narrow head, `< 1` the wide one, `1` is on
 * the curve. `null` when the narrow head cannot win at any coverage there.
 */
export function isoclineDistance(heads, target) {
  const c = boundaryCoverage(heads, target.effGpa * 1e9);
  if (c === null) return { ratio: null, boundary: null, side: 'wide' };
  if (c === 0) return { ratio: Infinity, boundary: 0, side: 'narrow' };
  const ratio = odds(target.cover) / odds(c);
  return {
    ratio,
    boundary: c,
    side: ratio > 1 ? 'narrow' : 'wide',
    discriminating: ratio >= DISCRIMINATING_BAND[0] && ratio <= DISCRIMINATING_BAND[1],
  };
}

/**
 * SPECIFY THE LANDING POINT, SOLVE FOR THE STATS — the inverse of what authoring
 * has been doing, and the reason it kept missing.
 *
 * Twice now, creatures were authored by picking plausible stats and then plotting
 * where they landed; twice the landing point was somewhere else, because
 * `armorHardness_gpa` is not the coordinate the model reads. Four creatures meant to
 * decorrelate the crossover band ended up outside it. Solving back from the target
 * makes that failure structurally impossible instead of caught-on-review.
 *
 * Returns the authored fields that land at `(effGpa, cover)` for a given Defense.
 * Defense is an AUTHORING INPUT now, not a stat inherited from the classic block.
 */
export function authorAt(effGpa, cover, defense) {
  const mul = 1 + defense * CONFIG.PHYS_DEFENSE_COUPLING;
  const gpa = effGpa / mul;
  return {
    defense,
    armorHardness_gpa: Number(gpa.toPrecision(4)),
    armorCoverage_frac: Number(cover.toPrecision(4)),
    // Reported so a caller can verify the round-trip rather than trust it.
    lands: { effGpa: Number((gpa * mul).toPrecision(6)), cover },
    multiplier: mul,
  };
}
