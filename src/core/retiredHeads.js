/**
 * retiredHeads.js — the fletchery fork, after it was cut.
 *
 * WHAT WAS CUT AND WHY. Two upgrade nodes excluded each other: a narrow bodkin for
 * armour, a wide broadhead for flesh. Three mechanisms were built to make that a real
 * choice — taper, the arrest solver, the width term — each landed as specified, and none
 * of them produced a fork. The decisive one is structural rather than numerical: the
 * bodkin sits under the 22 mm cut-width threshold and never bleeds, so the width term's
 * λ can only push one way. A parameter with no balancing value is not a tuning knob.
 *
 * THE EPITAPH, and it generalises: **the fork's margin was set by `feel` constants** —
 * the x0.55 / x1.7 `contactArea_m2` multipliers and the ρ = 1.104 energy pair — **and
 * every anchored term added afterwards overwhelmed them.** That is a prediction about
 * every other fork in the tree, not a fact about this one. See docs/PHYSICAL_MODEL.md §8i.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than the multipliers simply being deleted.
 *
 *   THE INSTRUMENTS ARE THE EVIDENCE. Sixteen sim scripts and about twenty tests measure
 *   this pair — the isocline, the clamp releases, the E* band, c_crit, the equivariance
 *   set. Those are checks on `penetrate`'s ALGEBRA, which survives the fork entirely, and
 *   deleting them to remove two multipliers would trade a large amount of verification
 *   for nothing. They now measure a fixture instead of content.
 *
 *   AND IT KEEPS THE DOOR TWO-WAY. Collapsing two nodes into one is reversible: if the
 *   mesh mechanism named in §8i ever lands, restoring the fork is restoring a node, not
 *   reconstructing a model. The multipliers live in exactly one place so that re-cut is
 *   an edit rather than an archaeology exercise.
 *
 * THIS IS NOT CONTENT. Nothing in `UPGRADE_NODES` refers to it, no player can reach it,
 * and it must never be read by the damage path — it is a fixture, in the same sense a
 * test's fixture is, and it is in `core` only because both tests and scripts read it
 * (I11).
 */

import { CREATURES } from '../data/creatures.js';
import { patchedPhys } from './upgrades.js';

/** The node that survived the cut, and the base both retired heads were spent on. */
export const DRAW_WEIGHT = 'homestead.fletchery.drawWeight';

/**
 * The two retired heads' effects, verbatim from the nodes as they stood at the cut.
 *
 * `contactArea_m2`: the ratio between these two is what the whole boundary rested on.
 * Graded `feel` throughout — geometry gives 2.5-4x on a frontal reading and 47-83x on a
 * defeat-patch reading, and the authored 2.02x was sourced from neither.
 *
 * `blowEnergy_j`: ρ = 1.06/0.96 = 1.104167. NOT independently felt — both are consistent
 * with one virtual-mass bow model to 4.9%, which is the single externally corroborated
 * quantity the fork ever produced.
 */
export const RETIRED_HEADS = {
  narrow: { blowMass_kg: 0.85, blowEnergy_j: 0.96, contactArea_m2: 0.55 },
  wide: { blowMass_kg: 1.3, blowEnergy_j: 1.06, contactArea_m2: 1.7 },
};

/**
 * One retired head as a complete `phys` block, on top of the surviving Heavy Draw node.
 *
 * The velocity re-coupling is the same one `patchedPhys` performs, and it is here for the
 * same reason it is there: a block carrying a new mass and energy alongside an inherited
 * `blowSpeed_mps` is a state that reads as valid and is not, which is exactly how a
 * synthetic head once got scored at a speed its own mass could not produce.
 */
function apply(id, phys, effects) {
  const out = { ...patchedPhys(id, phys, [DRAW_WEIGHT]) };
  for (const [field, mul] of Object.entries(effects)) out[field] *= mul;
  out.blowSpeed_mps = Math.sqrt((2 * out.blowEnergy_j) / out.blowMass_kg);
  return out;
}

/**
 * `{ narrow, wide }` for a creature — the pair every fork instrument is written against.
 *
 * `phys` overrides the creature's own block, and it is not a convenience: the equivariance
 * tests perturb the base and assert ρ does not move, and a fixture that silently ignored
 * the perturbation would turn those into tests that pass by doing nothing. That is the
 * exact failure mode of a stand-in going stale, so the seam is explicit.
 */
export function retiredHeads(id = 'woodElf', phys = CREATURES[id].phys) {
  return {
    narrow: apply(id, phys, RETIRED_HEADS.narrow),
    wide: apply(id, phys, RETIRED_HEADS.wide),
  };
}
