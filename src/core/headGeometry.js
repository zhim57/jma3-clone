/**
 * headGeometry.js — arrowheads parameterised by the geometry they are made from, and
 * the single pipeline every synthetic `phys` block goes through.
 *
 * TWO PROBLEMS, ONE FIX.
 *
 * THE PLANE SWEEP WAS SAMPLING AN INFEASIBLE REGION. `blowMass_kg` and
 * `contactArea_m2` were swept as independent axes, and the non-dominated set came back
 * as a single point at the corner of the grid — heavier always better, narrower always
 * better, optimum outside the box. That is the signature of infeasible configurations
 * being scored, not of a missing penalty: mass and area are both CONSEQUENCES of
 * geometry, and sweeping them independently constructs heads nobody could make. Adding
 * a cost term to make an impossible head score badly is fixing feasibility with an
 * objective-function patch, and it needs a new patch every time.
 *
 * So the axes become geometry — TIP section, MAXIMUM section, length, material — and
 * mass and area are derived. Three quantities, not two: the tip governs deformation,
 * the maximum section governs wound width and arrest, and the length governs buckling.
 * `contactArea_m2` was doing all three jobs, which is what produced a seventeen-metre
 * bodkin when the mass was attributed to the tip's section.
 *
 * AND STAND-INS KEPT GOING STALE. `heads.mjs` built a synthetic head by spreading a
 * real `phys` and overriding mass and energy, which silently kept the ORIGINAL
 * `blowSpeed_mps` — so the gate scored a head travelling at a speed its own mass could
 * not produce, and reported no cost for mass because the only field that charges for
 * mass was stale. I14 catches fields that are MISSING; it cannot catch fields that are
 * present and inconsistent. Manual re-derivation caught it once and will not keep
 * catching it, least of all across a sweep that builds hundreds of heads.
 *
 * `completePhys` is the answer: one function, shared with `derive-physical.mjs`, that
 * takes authored fields and returns the complete block. A stand-in with an impossible
 * velocity stops being a bug to catch and becomes a state that cannot be constructed.
 */

import { CONFIG } from '../config.js';

/** Densities, kg/m³ — literature values, and the reason `material` is an axis. */
export const MATERIALS = {
  steel: { density: 7850, yield_pa: 4.0e8 },
  iron: { density: 7300, yield_pa: 1.6e8 },
  bronze: { density: 8800, yield_pa: 2.0e8 },
};

/**
 * Wooden shaft, the part of an arrow that is not the head.
 *
 * `feel`, AND LOAD-BEARING — the fifth instance of the pattern and the first found by an
 * anchoring attempt rather than by a check. FOC is head mass over arrow mass, so this
 * constant sits underneath every feasibility verdict the predicate has issued. At 25 g it
 * is a modern target arrow's shaft on a war arrow's mass budget: Mary Rose-era arrows run
 * 55-95 g total with 10-30 g heads, hence 40-70 g SHAFTS. Anchoring arrow mass while
 * holding this fixed forces the extra mass into the head and drives FOC to 32-37%, which
 * is how the anchoring attempt surfaced it.
 *
 * So the mass budget is THREE-WAY — head, shaft, arrow — and no commit may anchor one leg
 * of it in isolation.
 *
 * AND IT WAS NEVER THE RIGHT SHAPE, which is the sharper finding. One constant asserts
 * both heads fly on identical shafts, and archery does not do that: spine must be matched
 * to the head, so a 30 g broadhead needs a stiffer and therefore heavier shaft than a 12 g
 * bodkin. The fix is a PER-ARROW field, not a better constant — and with one, all three
 * constraints are satisfiable at once (bodkin 12/40/52 g at FOC 11.5%, broadhead 30/60/90
 * at 16.7%, ρ = 1.1097, marginally above today's).
 *
 * Sixth instance of the same pattern, and every one has been INSUFFICIENT DIMENSIONALITY:
 * `contactArea_m2` doing tip, shank and defeat-patch; `blowMass_kg` spanning arrows and
 * maces; one shaft for all arrows. Not merely unsourced values — fields that could not
 * represent what they were asked to. Left at 25 g until commit 2, with the dependency
 * recorded rather than discovered again.
 */
export const SHAFT_MASS_KG = 0.025;

/**
 * FORWARD MASS FRACTION IS NOT FOC, AND THEY DIFFER BY A FACTOR OF TWO.
 *
 * FOC is the balance point's displacement from the arrow's centre, as a fraction of its
 * length. For a head mass fraction `f` concentrated at the tip on a uniform shaft, the
 * centre of mass sits at L(1+f)/2, so the displacement from L/2 is fL/2 and
 *
 *     FOC = f / 2
 *
 * The first version of the feasibility predicate compared `f` directly against a limit
 * quoted in FOC, making it twice as strict as the anchor it cited. That is the SAME
 * failure as the authored-versus-effective hardness episode: a number compared against a
 * limit expressed in a different coordinate, with both sides looking like percentages.
 *
 * Recomputed, the verdicts move: bodkin 41% forward is FOC 20.5% (extreme-FOC — unusual
 * but shot), broadhead 62% is FOC 31% (ultra-EFOC, at the documented edge, NOT
 * infeasible), and the plane's corner is FOC 42% and genuinely out. The corner still
 * dies; the broadhead becomes marginal rather than rejected, and its practical
 * consequence changes from "ruled out" to "re-author its mass downward in the re-basis".
 */
export const focFrom = (forwardFrac) => forwardFrac / 2;

/**
 * The derived half of a `phys` block. THE ONLY PLACE THESE FORMULAE ARE WRITTEN —
 * `scripts/data/derive-physical.mjs` imports this rather than holding a second copy,
 * so an authored creature and a synthetic stand-in are completed by the same code.
 */
export function completePhys(phys) {
  const volume = phys.bodyMass_kg / phys.density_kgpm3;
  // TAPER, baked at authoring time — TWO means, because a head has two jobs and they
  // integrate over different intervals.
  //
  //   headMeanArea_m2    the frustum mean over the WHOLE head. This is the mass model's
  //                      section (V = A_mean·L) and the energy to bury the head entire.
  //   headArmourArea_m2  the mean over [0, PHYS_PENETRATION_DEPTH] — the section the
  //                      armour actually has to open. This is what `penetrate` reads.
  //
  // The distinction is the whole of the arrest fix. The whole-head mean charges a blow
  // for a section it never reaches, and — the reason the length axis ran away — it
  // CARRIES NO L, which is precisely why V = A_mean·L works. The mean over a fixed depth
  // does carry L, because a longer head at the same two sections is a shallower taper.
  //
  // Both default to the tip when no head geometry is authored, and both are then EXACTLY
  // the tip: (A + √(A·A) + A)/3 = A with no rounding to argue about. So un-tapered
  // content is bit-identical, which is what makes the A/B free.
  // CUT WIDTH AND MAXIMUM SECTION ARE DIFFERENT PARTS OF THE OBJECT — instance NINE of
  // insufficient dimensionality, and the first one caught by someone asking what a
  // number physically was rather than by a test.
  //
  // The first version derived `A_max = headWidth_m × headThickness_m`, which quietly
  // asserted that the widest cutting section IS the maximum section. It is not. Both
  // heads are SOCKETED onto the same 9 mm shaft, so both carry a socket of about 70 mm²,
  // and that socket is the bodkin's maximum section. A broadhead's blades spread
  // SIDEWAYS from a socket the same size — so its cut is 31 mm wide and its maximum
  // section is the socket too, plus whatever the blades add.
  //
  // Scoring 70 mm² against 30.6 mm² was scoring A SOCKET AGAINST A BLADE. That is what
  // produced "burying the bodkin costs more, so the broadhead goes deeper" — a conclusion
  // about which part of each object had been measured, not about arrowheads.
  //
  // So they are authored INDEPENDENTLY: `headMaxArea_m2` is what the target has to open
  // (arrest, burial, the armour section) and `headWidth_m` is how wide the cut is
  // (closure, bleeding). An area still carries no shape — which is exactly why width has
  // to be its own field rather than something recovered from the area.
  const maxArea = phys.headMaxArea_m2 ?? phys.contactArea_m2;
  // I18: absence of head geometry is expected and gets the tip. A max section WITHOUT a
  // length is not — the taper is then undefined, and defaulting the length would silently
  // invent a geometry. Unexpected absence gets an assertion.
  if (maxArea !== phys.contactArea_m2 && !(phys.headLength_m > 0)) {
    throw new Error('a head section without headLength_m: a taper needs a length to taper over');
  }
  // The wound depth is head-then-shaft, so a head with no shaft behind it is a head
  // whose depth would be computed over the wrong three quarters of the traverse.
  if (phys.headLength_m > 0 && !(phys.shaftArea_m2 > 0)) {
    throw new Error('head geometry without shaftArea_m2: most of a wound is shaft, not head');
  }
  const headMeanArea_m2 = (phys.contactArea_m2 + Math.sqrt(phys.contactArea_m2 * maxArea) + maxArea) / 3;
  return {
    ...phys,
    headMaxArea_m2: maxArea,
    headMeanArea_m2,
    headArmourArea_m2: armourSection(phys.contactArea_m2, maxArea, phys.headLength_m,
      CONFIG.PHYS_PENETRATION_DEPTH),
    // The head's VOLUME, which is what `A_mean · L` is — so the energy to bury the head
    // is σ_tissue × this, one multiplication at damage time. Baked as a volume rather
    // than as an energy because the resistance belongs to the TARGET and the geometry to
    // the attacker, and a number baked on the wrong side of that would be a stand-in
    // going stale the first time an arrow met a different body.
    headVolume_m3: phys.headLength_m > 0 ? phys.headLength_m * headMeanArea_m2 : undefined,
    frontalArea_m2: CONFIG.PHYS_SHAPE_K * Math.cbrt(volume * volume),
    // Body thickness along the shot — what a wound depth saturates against.
    bodyDepth_m: CONFIG.PHYS_DEPTH_K * Math.cbrt(volume),
    velRetainPerHex_ratio: Math.exp(-(CONFIG.PHYS_AIR_K * CONFIG.PHYS_HEX_METERS) / phys.ballisticCoeff_kgpm2),
    armorHardness_pa: phys.armorHardness_gpa * 1e9,
    blowSpeed_mps: Math.sqrt((2 * phys.blowEnergy_j) / phys.blowMass_kg),
  };
}

/**
 * TISSUE, AS THE PENETRATOR MEETS IT — one lookup, so nothing reads half of it.
 *
 * `tissueStrength_pa` is absent on almost every creature and that absence is EXPECTED
 * (I18): the roster is flesh, at 950–1040 kg/m³, and one constant covers it. What is not
 * expected is a creature that is not flesh silently being treated as meat — the dendroids
 * are wood at 700 kg/m³, and wood crushes at roughly an order of magnitude more than
 * tissue. So the default is guarded by DENSITY rather than by memory, and the day someone
 * authors a stone golem the check fires instead of the model quietly under-charging it.
 *
 * The band is 850–1100. 900 (the dragons) is inside because an animal with air sacs is
 * 5% under water and still an animal; 700 is outside because it is a tree.
 *
 * AND A TREE DOES NOT BLEED, which is the sharper half. The width term's mechanism is
 * HAEMORRHAGE — that is the whole reason a threshold on cut width is the right shape, and
 * why the regulatory minimum is an anchor at all. Applied to a dendroid it says a wide
 * blade opens a wound that will not close in something with no blood to lose. So
 * `bleeds` is a property of the target and the two dendroids author it false; in a fuller
 * roster the undead, elementals and constructs are the same class.
 *
 * Nothing has an authored width yet, so this changes no number today. It is written now
 * because the alternative is finding it after the fork's numbers have been quoted.
 */
export const FLESH_DENSITY = [850, 1100];
export function tissueOf(phys) {
  const sigma = phys.tissueStrength_pa ?? CONFIG.PHYS_TISSUE_SIGMA_PA;
  return {
    sigma,
    channel: sigma * CONFIG.PHYS_CHANNEL_FRACTION,
    depth: phys.bodyDepth_m,
    bleeds: phys.bleeds ?? true,
  };
}

/**
 * A head from its geometry — THREE sections, not one.
 *
 * `A_tip` governs deformation (the point that meets armour), `A_max` governs wound width
 * and the depth at which the head arrests, and `length` sets the TAPER ANGLE and, with
 * the two sections, mass. Treating one area as all three is what produced a
 * seventeen-metre bodkin: `contactArea_m2` is the TIP, while the mass sits in the shank
 * behind it.
 *
 * Length was billed as governing buckling and nothing else, which is why the sweep's
 * frontier walked straight out to whatever the longest grid point was: under a
 * whole-head mean section, length changed only mass. It is `armourSection` that gives
 * length a consequence — the same two sections over twice the distance is half the taper
 * angle — so buckling is not what was missing.
 *
 * Mass uses the FRUSTUM mean section, `(A_tip + √(A_tip·A_max) + A_max)/3`, not the
 * arithmetic mean. The difference is not bookkeeping: 12% on an authored bodkin and
 * **39%** at the taper ratios the sweep reaches, which would have surfaced later as a
 * physics discrepancy with no obvious cause.
 */
export function headFrom({ tipArea_m2, maxArea_m2, length_m, material = 'steel' }) {
  const { density, yield_pa } = MATERIALS[material];
  const meanArea = (tipArea_m2 + Math.sqrt(tipArea_m2 * maxArea_m2) + maxArea_m2) / 3;
  const headMass_kg = density * meanArea * length_m;
  const dMax = Math.sqrt((4 * maxArea_m2) / Math.PI);
  return {
    tipArea_m2,
    maxArea_m2,
    length_m,
    material,
    yield_pa,
    headMass_kg,
    arrowMass_kg: headMass_kg + SHAFT_MASS_KG,
    maxDiameter_m: dMax,
    /** Fraction of the arrow's mass ahead of the shaft. NOT FOC — see `focFrom`. */
    forwardFrac: headMass_kg / (headMass_kg + SHAFT_MASS_KG),
    foc: focFrom(headMass_kg / (headMass_kg + SHAFT_MASS_KG)),
    /** For buckling: σ_crit ∝ E·A/L², so slenderness on the tip section. */
    slenderness: length_m / Math.sqrt((4 * tipArea_m2) / Math.PI),
  };
}

/**
 * Is this a head someone could make and shoot?
 *
 * L/D WAS THE WRONG PREDICATE AND IS GONE. It is a slenderness measure for uniform
 * rods, and an arrowhead is a tapered solid socketed onto a shaft — so L/D rejected
 * both authored heads (190 and 80) while accepting nothing useful. The binding
 * constraints are geometric in a different way, and both have external anchors:
 *
 *   SHAFT COMMENSURABILITY   the head's widest section sits on an 8–10 mm shaft. A
 *                            25 mm base is a mushroom, not an arrow.
 *   FRONT-OF-CENTRE          mass forward destabilises the arrow in flight. Applied in
 *                            FOC PROPER (= forwardFrac/2, see `focFrom`), not in forward
 *                            mass fraction — the first version conflated them and was
 *                            twice as strict as its own anchor. Modern bands: high
 *                            12–19%, extreme 19–30%, ultra-EFOC above 30%.
 *
 * FOC is what rules out the plane's corner: 133 g of head on a 158 g arrow is 84%
 * forward, **FOC 42%**. Under a cone taper that head is a 24 mm base — constructible,
 * and unshootable. Neither predicate rejects a bodkin, and the broadhead now reads
 * marginal (FOC 31%) rather than infeasible.
 *
 * THE WIDTH PREDICATE HAD A SIBLING NOBODY WROTE, and the arrest solver found it. Base
 * diameter bounds the head against the SHAFT it sits on; nothing bounded its LENGTH
 * against the arrow it is part of. So the sweep was free to propose a 1.5 m head on a
 * 25 g shaft, and did — the frontier walked to whatever the longest grid point was, at
 * every grid extension, which is the infeasible-region signature for the third time.
 *
 * War-arrow heads run **50–120 mm** including the socket (Mary Rose long bodkins near
 * 100 mm, Type 16 broadheads 50–60) on a **~760 mm** arrow. The bound is set at 150 mm,
 * clear of the documented range so it discriminates without having been fitted to
 * anything the sweep wanted.
 *
 * IT IS A PREDICATE, NOT A COST, and the distinction is the finding. Under the fixed-
 * depth section a longer head is a shallower taper is a smaller section to drive through
 * armour, monotonically, with mass and drop the only push-back — and both of those
 * saturate. So the physics says longer is always better and constructibility is the only
 * thing stopping it. That is what a MISSING PHYSICAL TERM looks like, and buckling is the
 * candidate. This bound keeps the sweep honest in the meantime; it does not stand in for
 * the term.
 */
export const FEASIBLE = {
  foc: [0.03, 0.35],           // FOC proper. Modern bands: high 12-19, extreme 19-30,
                               // ultra-EFOC >30. 35 admits war heads at the edge.
  maxDiameter: [0.003, 0.012], // m — what an 8-10 mm shaft can carry
  arrowMass: [0.020, 0.120],   // kg — below is a toy, above is a ballista bolt
  headLength: [0.02, 0.150],   // m — 50-120 mm documented, on a ~760 mm arrow
};
export function feasible(h) {
  const within = (v, [lo, hi]) => v >= lo && v <= hi;
  const fails = [];
  // I18. A head with no length is not a head with a default length: `geometryFor`
  // ASSUMES 100 mm and a caller passing its output has to say so, because the length is
  // now a predicate rather than a spectator.
  if (!(h.length_m > 0)) throw new Error('feasible() needs length_m — a head has one, and it is now checked');
  const foc = h.foc ?? focFrom(h.forwardFrac);
  if (!within(foc, FEASIBLE.foc)) fails.push(`FOC ${(foc * 100).toFixed(1)}%`);
  if (!within(h.maxDiameter_m, FEASIBLE.maxDiameter)) fails.push(`base ${(h.maxDiameter_m * 1000).toFixed(1)} mm`);
  if (!within(h.arrowMass_kg, FEASIBLE.arrowMass)) fails.push(`arrow ${(h.arrowMass_kg * 1000).toFixed(0)} g`);
  if (!within(h.length_m, FEASIBLE.headLength)) fails.push(`head ${(h.length_m * 1000).toFixed(0)} mm long`);
  return { ok: fails.length === 0, fails };
}

/**
 * What geometry would a given (arrow mass, tip area) pair require, under a CONE taper?
 *
 * The uniform-area version of this returned a 16.97 m spike for the plane's optimum and
 * that number went into the record. It was an artefact: a cone of the same mass and
 * length has a base, not a length, to grow into. 133 g of steel over 100 mm is a 25 mm
 * base — fat and ugly and entirely constructible. Retracted; the head is ruled out by
 * FOC and by the shaft it cannot sit on, not by being seventeen metres long.
 */
export function geometryFor(arrowMass_kg, tipArea_m2, length_m = 0.10, material = 'steel') {
  const headMass = arrowMass_kg - SHAFT_MASS_KG;
  const meanArea = headMass / (MATERIALS[material].density * length_m);
  // Invert the frustum mean for A_max given A_tip: solve (a + √(a·A) + A)/3 = mean.
  const a = tipArea_m2, m3 = 3 * meanArea;
  const r = (-Math.sqrt(a) + Math.sqrt(a + 4 * (m3 - a))) / 2;
  const maxArea_m2 = r * r;
  return {
    headMass_kg: headMass,
    maxArea_m2,
    maxDiameter_m: Math.sqrt((4 * maxArea_m2) / Math.PI),
    forwardFrac: headMass / arrowMass_kg,
    foc: focFrom(headMass / arrowMass_kg),
  };
}

/**
 * ARREST FOR A TAPERED PENETRATOR — the work integral, and the profile it integrates.
 *
 * A tapered head's presented area grows with depth, so it arrests where the widening
 * section meets resistance rather than at a fixed depth. A narrow point goes deep and
 * cuts narrow; a wide one stops shallow and cuts wide — the fork's intended logic
 * falling out of geometry, with an interior optimum in taper ANGLE rather than a corner.
 *
 * THE FIRST VERSION INTEGRATED A PROFILE THE MASS MODEL CONTRADICTS, and that was caught
 * before it was wired to anything — the fourth time specification-first has paid, and
 * again for nothing. It assumed `A(x) = A_t + (A_m − A_t)x/L`, area linear in depth. But
 * `headFrom` computes mass from the FRUSTUM mean, which is the mean of a solid whose
 * RADIUS is linear — a cone. For a cone the area is quadratic in x, and the two profiles
 * disagree by the ratio of the arithmetic mean to the frustum mean: 1.9% at a 2× taper,
 * **23.7% at the 20× the sweep reaches.** Not bookkeeping, and not visible in any test
 * that only ever looks at one of them.
 *
 * A body cannot have one shape for its mass and another for its resistance. The cone
 * wins because the mass model is the one with a landed finding behind it, and because a
 * head is closer to a cone than to a wedge. (A real broadhead is a flat blade whose
 * WIDTH grows linearly, which is a third profile again — the `A_max`-carries-no-shape
 * limitation, already recorded, biting a second mechanism.)
 *
 * THE INTEGRAL, and it is prettier than the quadratic it replaces. With √A linear in x,
 * `s(x) = √A_t + k·x` and `k = (√A_m − √A_t)/L`:
 *
 *     ∫₀^d A dx = [s(d)³ − s(0)³] / (3k) = d · (A_t + √(A_t·A_d) + A_d) / 3
 *
 * — the energy to depth `d` is σ·d· **the frustum mean of the tip and the section at
 * `d`**. The same mean the mass model uses, over the traversed interval instead of the
 * whole head. Two quantities that had no reason to be the same function turn out to be,
 * which is the sort of agreement that says the profile is being applied consistently.
 *
 * SOLVING IT, without the cancellation. `s(d) = ∛(s₀³ + 3k·KE/σ)` and then
 * `d = (s(d) − s₀)/k` — a difference of nearly equal numbers over a small denominator as
 * the taper shallows, the same trap the quadratic root had. Rationalising the cube
 * difference removes it and **k cancels entirely**:
 *
 *     d = 3·KE / ( σ · (A_d + √(A_d·A_t) + A_t) )
 *
 * which is just the integral read backwards, needs no `k ≠ 0` branch, and reduces to
 * `KE/(σ·A_t)` BIT-IDENTICALLY when `A_m === A_t` (the cbrt is bypassed on that path, so
 * there is no rounding to tolerate). Round-tripped against the work integral it holds to
 * 4.4e−16 — the double floor under I24, so the solver is exact, not close.
 *
 * BEYOND THE HEAD IS A THIRD REGIME AND THIS IS NOT IT. Once `d > L` the head is buried
 * and what is still being driven in is the SHAFT, whose section the schema does not
 * carry. Continuing at `A_max` is the least-wrong stand-in and it is wrong in a known
 * direction: a bodkin's 9 mm shaft is WIDER than its shank, a broadhead's is narrower.
 * `buried` is returned so a caller can refuse to use the number rather than discover the
 * regime by its results.
 */
export function arrest(kineticEnergy_j, sigma_pa, tipArea_m2, maxArea_m2, length_m) {
  const s0 = Math.sqrt(tipArea_m2);
  const sm = Math.sqrt(maxArea_m2);
  // Un-tapered: the integral is σ·A·d and the solve is a division. Taken as its own path
  // so the reduction is exact rather than merely correct to fifteen places.
  if (sm === s0) {
    const depth = kineticEnergy_j / (sigma_pa * tipArea_m2);
    return { depth_m: depth, section_m2: tipArea_m2, buried: depth > length_m };
  }
  // Fully buried, so the taper is spent and the rest is the (unmodelled) shaft regime.
  const bury = sigma_pa * length_m * ((tipArea_m2 + s0 * sm + maxArea_m2) / 3);
  if (kineticEnergy_j >= bury) {
    return {
      depth_m: length_m + (kineticEnergy_j - bury) / (sigma_pa * maxArea_m2),
      section_m2: maxArea_m2,
      buried: true,
    };
  }
  const k = (sm - s0) / length_m;
  const s1 = Math.cbrt(tipArea_m2 * s0 + (3 * k * kineticEnergy_j) / sigma_pa);
  const section = s1 * s1;
  return {
    depth_m: (3 * kineticEnergy_j) / (sigma_pa * (section + s1 * s0 + tipArea_m2)),
    section_m2: section,
    buried: false,
  };
}

/**
 * THE SECTION THE ARMOUR HAS TO OPEN — the arrest integral with the depth held FIXED.
 *
 * `penetrate`'s contest is `p/(p+h)` with `p = E/(A·d_ref)`, which rearranges to
 * `E/(E + h·A·d_ref)`: the blow's energy against the energy needed to drive the head
 * through `d_ref` of armour-hard material. That second quantity is exactly `σ∫₀^{d_ref}A dx`
 * with `σ = h` — **the arrest solver, evaluated where the depth is a constant.** So the
 * hot path needs no solve at all; it needs the right mean, and the right mean is
 *
 *     M = (A_t + √(A_t·A_ref) + A_ref) / 3,   A_ref = A(min(d_ref, L))
 *
 * baked here at authoring time. One number, no sqrt and no cbrt at damage time, I10
 * intact — the transcendental is only needed when the DEPTH is the unknown, which is the
 * wound, not the armour.
 *
 * This is what the whole-head frustum mean was standing in for and getting wrong in both
 * directions: it charges a blow for a base it never reaches (8.5×A_t against the true
 * 1.1–3.7×A_t at a 20× taper) and it carries no L, so length had no geometric
 * consequence at all. Here a head twice as long is a taper half as steep: at a 20× ratio
 * M runs 3.74·A_t at 40 mm down to 1.15·A_t at 500 mm.
 *
 * `L ≤ d_ref` is the short-head case: the head buries inside the reference depth and the
 * remainder is presented at `A_max`. Same shaft-section caveat as `arrest`.
 */
export function armourSection(tipArea_m2, maxArea_m2, length_m, refDepth_m) {
  if (maxArea_m2 === tipArea_m2) return tipArea_m2;
  const s0 = Math.sqrt(tipArea_m2), sm = Math.sqrt(maxArea_m2);
  const whole = (tipArea_m2 + s0 * sm + maxArea_m2) / 3;
  if (length_m <= refDepth_m) {
    return (length_m * whole + maxArea_m2 * (refDepth_m - length_m)) / refDepth_m;
  }
  const s1 = s0 + ((sm - s0) * refDepth_m) / length_m;
  return (tipArea_m2 + s0 * s1 + s1 * s1) / 3;
}

/**
 * BOUNDS AUTHORED CONTENT MUST MEET, AND SO MUST ANYTHING A NODE PRODUCES.
 *
 * Heavy Draw is the first node caught patching a quantity out of physical bounds — it
 * takes a 152 J bow to 201 J, past anything a human draws — and it was caught by eye,
 * during an unrelated anchoring pass. There is no reason to expect the next one is. A
 * node that adds head mass pushes FOC out exactly as easily as Heavy Draw pushed energy
 * out, and the schema offers no more resistance to one than to the other.
 *
 * So the check is structural: apply every node's effects, then assert the RESULT still
 * satisfies the bounds an authored creature has to satisfy. Not the node's multiplier —
 * the state it produces.
 *
 * A baseline at the ceiling of its range makes every upgrade unphysical by construction,
 * which is the general lesson and the same shape as the tree exceeding the campaign
 * budget: **authored baselines belong LOW in their physical range, because the design
 * needs slack in the direction it is going to grow.**
 */
export const PHYS_BOUNDS = {
  // Stored bow energy, from delivered energy and the virtual-mass efficiency. Warbows
  // of 100–180 lb are estimated at roughly 130–160 J; the ceiling allows a margin.
  bowEnergyStored_j: [40, 175],
  // FOC proper (= forward mass fraction / 2). Ultra-EFOC begins at 30%.
  foc: [0.03, 0.35],
  // The head's widest section against an 8–10 mm shaft.
  maxDiameter_m: [0.003, 0.012],
  arrowMass_kg: [0.020, 0.120],
};

/** Whether a `phys` block describes an arrow — see the scope note in boundsViolations. */
export const isArrow = (phys) => phys.blowMass_kg <= 0.15 && phys.dispersion_rad > 0;

/** Virtual mass recovered from the two authored heads — see `sim:heads` §1. */
export const BOW_VIRTUAL_MASS_KG = 0.0159;

/** Stored energy implied by a delivered energy and a projectile mass. */
export const storedEnergy = (delivered_j, mass_kg) =>
  delivered_j / (mass_kg / (mass_kg + BOW_VIRTUAL_MASS_KG));

/**
 * Every bound violated by a `phys` block, as strings. Empty means it is a state a bow
 * could produce and an archer could shoot.
 */
export function boundsViolations(phys) {
  const out = [];
  // SCOPED TO ARROWS, and the scope is a real limitation rather than a dodge. These
  // bounds describe a shaft launched from a bow: a Monk's 350 g `blowMass_kg` is a
  // weapon swung by hand, and running an FOC check on it asks what the balance point of
  // a mace is. The first pass flagged monk and zealot at BASE, with no nodes applied,
  // which is the check telling you its own domain. A `weaponKind` discriminator is what
  // this wants and the schema has no field for it yet.
  if (!isArrow(phys)) return out;
  const within = (v, [lo, hi]) => v >= lo && v <= hi;
  const e = storedEnergy(phys.blowEnergy_j, phys.blowMass_kg);
  if (!within(e, PHYS_BOUNDS.bowEnergyStored_j)) {
    out.push(`stored bow energy ${e.toFixed(1)} J outside `
      + `${PHYS_BOUNDS.bowEnergyStored_j[0]}-${PHYS_BOUNDS.bowEnergyStored_j[1]} J`);
  }
  if (!within(phys.blowMass_kg, PHYS_BOUNDS.arrowMass_kg)) {
    out.push(`projectile mass ${(phys.blowMass_kg * 1000).toFixed(0)} g outside `
      + `${PHYS_BOUNDS.arrowMass_kg[0] * 1000}-${PHYS_BOUNDS.arrowMass_kg[1] * 1000} g`);
  }
  const g = geometryFor(phys.blowMass_kg, phys.contactArea_m2);
  if (!within(g.foc, PHYS_BOUNDS.foc)) out.push(`FOC ${(g.foc * 100).toFixed(1)}% outside `
    + `${PHYS_BOUNDS.foc[0] * 100}-${PHYS_BOUNDS.foc[1] * 100}%`);
  if (!within(g.maxDiameter_m, PHYS_BOUNDS.maxDiameter_m)) {
    out.push(`head base ${(g.maxDiameter_m * 1000).toFixed(1)} mm outside `
      + `${PHYS_BOUNDS.maxDiameter_m[0] * 1000}-${PHYS_BOUNDS.maxDiameter_m[1] * 1000} mm`);
  }
  return out;
}
