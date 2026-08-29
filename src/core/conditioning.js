/**
 * conditioning.js — is a margin big enough to be evidence about the terms that made it?
 *
 * THE CHEAP PRE-CHECK THE FLETCHERY FORK NEEDED AND DID NOT GET, and it is worth stating
 * that this is a REPLACEMENT for a weaker conclusion rather than a decoration on it.
 *
 * The first epitaph written for the fork was *"the margin came from `feel` constants, and
 * every anchored term overwhelmed them."* That is true and it is not the useful part. It
 * rests on 12 J against 8.2 J — a factor of 1.5, not the order of magnitude the phrasing
 * implies — and it offers nothing to do next except be suspicious of `feel`.
 *
 * THE SAME NUMBERS SAY SOMETHING SHARPER. The two heads' depth margin is
 *
 *     +12.0 J   the bow hands the wide head more energy (ρ = 1.104)
 *     −8.2 J    the wide head costs more to bury (the corrected geometry)
 *     ───────
 *      +3.8 J   what survives
 *
 * A margin of 3.8 J out of arrow energies of 114 and 126 J: **3% of the quantities being
 * differenced.** The two contributions that produce it are 3.2× and 2.2× its size, so a
 * 10% error in either flips it. That is ILL-CONDITIONING, and it explains the thing the
 * `feel` story does not — why *every* anchoring pass moved the answer so violently. It was
 * not that the anchored terms were large. It is that the result was a small difference of
 * large opposed terms, so any error anywhere swamped it.
 *
 * AND IT GENERALISES INTO SOMETHING YOU CAN RUN BEFORE BUILDING. Compute the margin as a
 * fraction of the terms producing it. The amplification factor is
 *
 *     κ = Σ|term| / |Σ term|
 *
 * — the standard cancellation measure — and a relative error ε in any input becomes κ·ε in
 * the margin. So a margin needs its inputs known to better than 1/κ, and **nothing in this
 * model is known to better than a few percent**: the best-founded quantity in it is a
 * literature density, and most of the fork's inputs are `feel`, which has no ε at all.
 *
 * Run against the fork before taper was written, this would have returned κ ≈ 5 on a
 * margin whose inputs were ungraded — and killed it three mechanisms earlier. That is the
 * whole value of the check: it costs one function call and it runs BEFORE the work.
 *
 * WHAT IT IS NOT. κ is not a verdict. A well-conditioned margin can still be wrong, and an
 * ill-conditioned one can still be real — it just cannot be *evidence* at the precision the
 * inputs are known to. The output is a requirement on the inputs, not a claim about the
 * answer.
 */

/**
 * The cancellation amplification of a signed sum.
 *
 * `terms` are the signed contributions to a margin. Returns the margin, the scale of the
 * terms that made it, κ, and `tolerance` — the relative accuracy each input needs for the
 * margin's SIGN to survive.
 *
 * κ = 1 means no cancellation (all terms agree in sign) and the margin is as well known as
 * its inputs. κ = 10 means a 1% input error is a 10% margin error. κ → ∞ is a margin that
 * is pure cancellation and carries no information at all.
 */
export function conditioning(terms) {
  const margin = terms.reduce((a, b) => a + b, 0);
  const scale = terms.reduce((a, b) => a + Math.abs(b), 0);
  const kappa = margin === 0 ? Infinity : scale / Math.abs(margin);
  return { margin, scale, kappa, tolerance: 1 / kappa };
}

/**
 * Does a margin clear the noise its own inputs carry?
 *
 * `worstInputError` is the relative uncertainty of the WORST-GRADED term — and grading it
 * is the point of the exercise, because a `feel` input has no defensible ε and so cannot
 * support any margin at all. Passing a number for a `feel` input is asserting something
 * about it, which is exactly the move this is meant to prevent; `Infinity` is the honest
 * value and it fails everything, correctly.
 */
export function marginIsEvidence(terms, worstInputError) {
  const c = conditioning(terms);
  return { ...c, worstInputError, ok: c.kappa * worstInputError < 1 };
}
