/**
 * physicalDamage.js — damage derived from the physics of the blow, not from a
 * roll on an attack/defense ladder. Opt-in: `battle.features.physicalDamage`.
 *
 * A drop-in for CombatEngine's `rollDamage` — same arguments, same
 * `{ damage, luck }` back — so the engine branches once and nothing downstream
 * knows which model ran. `applyDamage`'s HP-pool accounting, hpLost, XP,
 * resurrection and rout all keep working on the number this returns.
 *
 * THE CHAIN, and what each step replaces:
 *
 *   energy      AUTHORED as `blowEnergy_j` — what the bow stores. Velocity is a
 *               consequence, v = sqrt(2E/m), and drag bleeds it by a stored
 *               per-hex constant; since E goes as v², the retained fraction
 *               SQUARED carries that loss into the energy. This replaces
 *               nothing — the classic model has no notion of it.
 *   connection  the shot group's area against the target's silhouette. This
 *               replaces the flat ×0.5 beyond RANGED_FULL_RANGE with a
 *               continuous falloff, and it is where a crossbow beats a bow.
 *   rigidity    the tip's SECTIONAL DENSITY (m/A) against the hardness it meets.
 *               A point that is outmatched mushrooms and presents more area; one
 *               that is not keeps its shape. The only place a blow's mass has
 *               any consequence, and the reason a denser head is worth buying.
 *   penetration impact pressure (E over EFFECTIVE contact area × a reference
 *               stopping distance) against the target's armour hardness, as
 *               p/(p+h). This replaces the ±5%/2.5%-per-point ladder: Attack is skill in
 *               delivering the blow and rides the energy, Defense is what the
 *               point has to get through, and the two trade off smoothly instead
 *               of climbing to +300%. Only the covered fraction of the body is
 *               protected, so a bodkin through a padded jack and a bodkin
 *               against plate are different events, not the same subtraction.
 *   toughness   delivered joules over the target's woundEnergy_j, converted back
 *               into hit points — so the engine's HP pool is untouched.
 *
 * ARITHMETIC. Multiplication, division and Math.min/max/round only. The two
 * fractional-exponent quantities (silhouette area, per-hex drag) are computed
 * offline by scripts/data/derive-physical.mjs and read here as plain numbers,
 * because pow/exp have implementation-defined precision in ECMA-262 and a
 * damage model that is not bit-identical across engines cannot be A/B'd against
 * the model it is replacing.
 *
 * RNG. Draws exactly what the classic model draws, in the same order: one
 * stance roll (none on `hold`, which averages) and the same luck chance. That
 * is not a coincidence to be preserved by accident — a model that draws a
 * different NUMBER of values shifts every later roll in the seed and silently
 * invalidates every existing balance measurement (HANDOVER §2.3).
 *
 * DEPENDENCIES are injected by the engine rather than imported from it, so this
 * module never imports CombatEngine back (HANDOVER §2.4).
 */

import { CONFIG } from '../../config.js';
import { CREATURES } from '../../data/creatures.js';
import { skillValue } from '../../data/skills.js';
import { patchedPhys, upgradesForSide, aimAngle } from '../upgrades.js';
import { tissueOf } from '../headGeometry.js';

/**
 * The stand-in for a creature nobody has authored yet. Coverage is rolled out a
 * faction at a time, so most of the roster has no `phys` block for most of the
 * migration, and a model that could only run on a fully authored roster could
 * never be measured until the day it was finished.
 *
 * It is deliberately crude and deliberately NEUTRAL: a generic man-sized body,
 * with the blow's energy read straight off the classic damage tuple
 * (E = mean damage × J_PER_HP) so that an un-authored creature reproduces its
 * classic damage almost exactly. Divergence in a sweep then comes from the
 * creatures that were actually authored, which is the only way to attribute it.
 * A dragon standing in as a 72 kg man is a known lie with a known expiry.
 *
 * IT MUST SHARE THE AUTHORED SCALE, and this cost a full round of measurement to
 * learn. Fitting the stand-in's ARMOUR for neutrality works beautifully in
 * isolation (RMS 4.3% against the classic ladder, versus 12% when the armour is
 * pinned to a plausible body) and is catastrophic on contact: the fit wants
 * plate-grade hardness at 85% coverage, so an authored archer shooting a
 * fallback creature delivers 39% of its energy while the same creature swinging
 * back delivers 142% of its own. Measured over 200 seeds, that swung the
 * authored-meets-fallback matchup from +20 to −76 points of attacker win rate —
 * an artefact of the stand-in, an order of magnitude larger than anything the
 * model was saying. So: the fallback wears the same armour as the creature it
 * stands beside, the couplings absorb what they can, and the residual is
 * reported rather than fitted away.
 */
const FB = {
  massPerHp: 7.2,        // kg per hit point — 10 HP ≈ a 72 kg man in kit
  joulesPerHp: 26,       // J per hit point to put one down
  frontalArea_m2: 0.171926, // m² — man-sized silhouette (the archer's, derived)
  // Same man, one power down: 0.55 · V^(1/3). A LITERAL for the same reason the
  // silhouette is one — `fallbackPhys` runs per blow for un-authored creatures, and a
  // cbrt there is a transcendental on the damage path (I10).
  bodyDepth_m: 0.228052,
  density_kgpm3: 1010,         // kg/m³
  armorHardness_gpa: 0.12, // GPa — mail over padding, same scale as the authored archer
  armorCoverage_frac: 0.35,
  pressure: 2.0e8,       // Pa — contact area is set to land a nominal blow here
  speed: { melee: 12, ranged: 55, flying: 14 }, // m/s at the target
  retainPerHex: 0.99796,
};

/**
 * Physical parameters for a creature, authored or synthesised, with the owning
 * player's upgrade nodes patched in. `owned` is null on the common path (nobody
 * has bought a node, or the side has no owner), and then an authored creature
 * gets its OWN `phys` object straight back — no copy, no arithmetic, so a game
 * with no upgrades is byte-identical to one with no upgrade system.
 */
function physOf(id, c, owned, scale) {
  if (c.phys) {
    const patched = owned ? patchedPhys(id, c.phys, owned) : c.phys;
    return scale ? scaled(id, patched, scale) : patched;
  }
  const fallback = fallbackPhys(c, id);
  // A node may only name authored creatures (the schema test enforces it), so
  // this branch is unreachable today. Patching anyway, because the alternative
  // is a node that silently stops working the day someone relaxes that rule.
  const patched = owned ? patchedPhys(id, fallback, owned) : fallback;
  return scale ? scaled(id, patched, scale) : patched;
}

/**
 * The synthesised `phys` block for an un-authored creature.
 *
 * EXPORTED so a test can assert it is COMPLETE. A synthesised entity must carry
 * every field the physics reads, or be excluded from the paths that read it —
 * `tipRigid` was missing when rigidity landed and moved the all-un-authored
 * control by 1.5 points of win rate. A control that is not exactly zero is a
 * broken instrument, not a slightly noisy one, because every divergence the sweep
 * attributes to authored content is measured against it. This recurs every time a
 * new physical field lands, so it is checked structurally rather than remembered.
 */
export function fallbackPhys(c) {
  const dmgMean = (c.damage[0] + c.damage[1]) / 2;
  const energy = dmgMean * FB.joulesPerHp;              // J the blow must carry
  const speed = FB.speed[c.reach] || FB.speed.melee;
  return {
    blowMass_kg: (2 * energy) / (speed * speed),
    blowEnergy_j: energy,
    blowSpeed_mps: speed,
    contactArea_m2: energy / (CONFIG.PHYS_PENETRATION_DEPTH * FB.pressure),
    dispersion_rad: 0,                                       // no ballistics until authored

    bodyMass_kg: c.health * FB.massPerHp,
    density_kgpm3: FB.density_kgpm3,
    armorHardness_gpa: FB.armorHardness_gpa,
    armorHardness_pa: FB.armorHardness_gpa * 1e9,
    armorCoverage_frac: FB.armorCoverage_frac,
    woundEnergy_j: c.health * FB.joulesPerHp,
    frontalArea_m2: FB.frontalArea_m2,
    bodyDepth_m: FB.bodyDepth_m,
    velRetainPerHex_ratio: FB.retainPerHex,
    // THE STAND-IN'S POINT NEVER DEFORMS, for the same reason it has no
    // dispersion: a synthesised blow has no authored tip, so any sectional
    // density read off it is an artefact of the mass/area fit, not a statement
    // about a weapon. Left in, it moved the all-un-authored control matchup by
    // 1.5 points of win rate — small next to the 37 a guessed dispersion once
    // cost, and the same category of error. A fallback that moves the control is
    // an instrument measuring itself.
    tipRigid: true,
  };
}

/**
 * A controlled-trial perturbation: multiply named fields of one creature.
 * Applied AFTER upgrades, so a sensitivity sweep measures the derivative at the
 * build the player actually has rather than at the bare creature. Returns the
 * original object untouched when nothing names this creature, so an ordinary
 * battle pays one property lookup for the whole feature.
 */
function scaled(id, phys, scale) {
  const fields = scale[id];
  if (!fields) return phys;
  const out = { ...phys };
  for (const [field, factor] of Object.entries(fields)) {
    if (!(field in out)) continue;
    out[field] = out[field] * factor;
    // The authored/derived pair must not drift here either (see patchedPhys).
    if (field === 'armorHardness_gpa') out.armorHardness_pa = out.armorHardness_gpa * 1e9;
  }
  // Same re-coupling a node patch gets: perturbing energy or mass moves velocity
  // with it, so a sensitivity sweep measures interventions that exist.
  if (out.blowEnergy_j > 0 && out.blowMass_kg > 0) {
    out.blowSpeed_mps = Math.sqrt((2 * out.blowEnergy_j) / out.blowMass_kg);
  }
  return out;
}

/**
 * Joules delivered into a body by a blow carrying `energy`, given the armour it
 * meets. The rigidity check, the pressure, the p/(p+h) contest and the covered/
 * exposed split, in one place.
 *
 * EXPORTED because the Pareto frontier needs to score builds by DAMAGE, and
 * damage is not energy — energy is a mechanism, exactly as impact pressure is.
 * A frontier that scored `blowEnergy_j` silently assumes armour is free to
 * ignore, which is how it came to cross out every bodkin build while sixty
 * paired fights said the bodkin wins against pikemen. The fix is not to
 * reimplement this arithmetic over there: this codebase has already watched a
 * hand-maintained twin (`expectedDamage` "mirrors the engine's rollDamage") stop
 * mirroring. One function, two callers.
 *
 * `hardness` is passed in rather than read off `dp`, because the engine folds
 * Defense and `ignoreDefense` into it and a build chart has neither.
 */
export function penetrate(energy, ap, hardness, cover, tissue) {
  // TIP RIGIDITY, and the ONLY consequence a blow's mass has. `deform` is the
  // sectional density the armour demands over the one the tip actually has: at
  // or under 1 the point holds its shape, above it the point mushrooms and the
  // area it presents grows in proportion. One division and one comparison, so
  // I10 holds — and the branch is continuous at 1, unlike the min(1, p/h) clamp
  // this model already had to abandon for creating a dead zone.
  //
  // This is what makes an upgrade CONDITIONAL for a physical reason rather than
  // a designed one: sectional density buys nothing against hide (nothing was
  // going to deform) and doubles the pressure delivered against mail.
  //
  // TAPER: THE SECTION THAT RESISTS IS THE ONE REACHED AT THE REFERENCE DEPTH. A head is
  // a tapered solid, so what the armour has to open is not the point that touched first
  // — but nor is it the mean over the WHOLE head, which is what the first version of
  // this used. That charged a blow for a base it never reaches, and it carried no L, so
  // head length had no geometric consequence and the design sweep's frontier walked out
  // to whatever the longest grid point happened to be.
  //
  // `headArmourArea_m2` is the arrest integral evaluated at PHYS_PENETRATION_DEPTH: the
  // frustum mean of the tip and the section at that depth, baked in `completePhys`. It
  // carries L — the same two sections over twice the length is half the taper angle —
  // and it costs the hot path nothing, because the transcendental in the arrest solver
  // is only needed when the DEPTH is the unknown. Here it is a constant. I10 holds: one
  // division and one comparison, no sqrt, no cbrt.
  //
  // DEFORMATION READS THE TIP, not the mean. Mushrooming is what happens to the point
  // that meets the armour, and its sectional density is m/A_tip. The mean-area version
  // was an artefact of one field standing for three sections; the traverse is integrated
  // properly now, so the tip goes back to doing the one job that is actually its own.
  //
  // Un-tapered content is unchanged BY CONSTRUCTION and BIT-IDENTICALLY: with no head
  // geometry authored, `headArmourArea_m2` is absent and `contactArea_m2` is used for
  // both terms — exactly the arithmetic that was here before taper landed. The `??` is
  // the legitimate kind (I18): absence means "no head geometry authored", which is
  // expected. A max section without a length, which is NOT expected, throws in
  // `completePhys` rather than defaulting.
  const sect = ap.headArmourArea_m2 ?? ap.contactArea_m2;
  const deform = ap.tipRigid ? 0
    : (hardness * CONFIG.PHYS_RIGIDITY_SD_PER_PA * ap.contactArea_m2) / ap.blowMass_kg;
  const effArea = deform > 1 ? sect * deform : sect;

  // p/(p+h), NOT min(1, p/h) — a hard clamp made every point of Defense past the
  // penetration threshold worth exactly nothing, and every point of Attack past
  // it worth nothing too. This form is monotone in both for all values, never
  // quite reaches 1 (armour always costs something), and sits at ½ where
  // pressure equals hardness.
  const pressure = energy / (effArea * CONFIG.PHYS_PENETRATION_DEPTH);
  const through = pressure / (pressure + hardness);

  // WIDTH, ON THE BARE FRACTION. A wide head buys nothing against armour — it is
  // charged for its section above, and correctly. What it buys is a wound that does not
  // close, and that happens on the part of the body armour is not covering.
  //
  // A THRESHOLD, NOT A SMOOTH TERM, and that is the whole reason this works where the
  // retracted perimeter derivation did not. Perimeter is smooth and cancels against
  // area — it charged the BODKIN for being wide, because P/A is set by thickness. Cut
  // closure is a threshold on width, and a threshold cannot cancel.
  //
  // MAGNITUDE IS CUT AREA, width × depth. Width alone would score a graze that clears
  // the threshold the same as a pass-through: a broadhead arrested at 3 mm has opened a
  // wide cut in nothing much. The depth factor is what stops width being free.
  //
  // `headWidth_m` is absent on everything without authored head geometry, and
  // `undefined >= x` is false — so this is one comparison for un-authored content and
  // the whole term is skipped. Absence means "no shape authored", which is expected
  // (I18), and an unshaped head cannot reach this because nothing knows whether the cut
  // it makes stays open.
  let bleed = 1;
  if (ap.headWidth_m >= CONFIG.PHYS_CUT_WIDTH_M) {
    // `tissue` is optional ONLY because nothing authored has a width yet, and that is
    // exactly the state in which an optional argument goes stale unnoticed: twenty call
    // sites score the fork today, and a mechanism that silently switched itself off in
    // nineteen of them would read as the mechanism not mattering. So the moment a width
    // IS authored, every caller that has not been updated fails loudly. Same rule as
    // I18, applied to an argument instead of a field.
    if (!tissue) throw new Error('penetrate(): a head with an authored width needs the target it is hitting');
  }
  // A wound that will not close is worth something only to a body that can lose blood
  // through it. The dendroids are wood and author `bleeds: false`; in a fuller roster the
  // undead, elementals and constructs are the same class.
  if (ap.headWidth_m >= CONFIG.PHYS_CUT_WIDTH_M && tissue.bleeds) {
    // THE WOUND IS MOSTLY SHAFT. Burying the head costs σ_tissue × its volume; past
    // that the shaft rides in an already-opened channel against friction, at a stated
    // fraction of the same σ. Only 8-24% of a documented penetration depth is inside
    // the head, so a depth computed from the head alone is a model of the wrong three
    // quarters — that is what kept σ out of content until now, and it is a SCHEMA
    // result rather than a calibration one.
    const buried = energy - tissue.sigma * ap.headVolume_m3;
    const depth = buried > 0
      ? ap.headLength_m + buried / (tissue.channel * ap.shaftArea_m2)
      // Too weak to bury its own head. Interpolated rather than solved: the exact
      // sub-bury depth needs the cbrt in `arrest`, which the hot path may not have
      // (I10), and this regime is one where the term is nearly off anyway — a blow that
      // cannot bury a 50 mm head has `depth << d_max` and `bleed` barely above 1. The
      // error is under-stating depth, so it under-states bleeding: wrong in the
      // direction that does not flatter the mechanism being argued for.
      : (ap.headLength_m * energy) / (tissue.sigma * ap.headVolume_m3);
    bleed = 1 + CONFIG.PHYS_BLEED_LAMBDA * ap.headWidth_m * Math.min(depth, tissue.depth);
  }

  // Only the covered fraction of the body is protected, so a bodkin through a
  // padded jack and a bodkin against plate are different events, not the same
  // subtraction. With `bleed` at 1 this is `1 - cover + cover*through` to the bit —
  // multiplication by one is exact — so un-authored content is unchanged.
  return energy * ((1 - cover) * bleed + cover * through);
}

/**
 * THE DETERMINISTIC HEART OF THE MODEL — everything except the dice.
 *
 * Split out so the combat AI's estimator can call the SAME arithmetic the
 * engine rolls, instead of keeping a hand-copied twin of it. The classic pair
 * shows why that matters: CombatAI's `expectedDamage` carries the comment
 * "mirrors the engine's rollDamage", which is a promise rather than a
 * mechanism — nothing makes a mirror stay a mirror. Here the estimator and the
 * roll differ in exactly one thing, the quality factor, which is the only part
 * the dice decide.
 *
 * `quality` is 1.0 for a nominal blow. `opts` lets the estimator ask "what if":
 *   attackDelta / defenseDelta — stat swings a spell is being weighed for
 *   fromX / fromY              — strike from a hypothetical hex
 *
 * Returns the raw damage as a float, before luck and before rounding.
 */
function blow(battle, attacker, defender, kind, eng, quality, opts = {}) {
  const c = CREATURES[attacker.creature];
  // The blow is patched by whoever owns the ATTACKER; the body it lands on by
  // whoever owns the DEFENDER. Nodes patch both halves of a `phys` block, so
  // reading one player's list for both sides would arm an enemy with your mail.
  const ap = physOf(attacker.creature, c, upgradesForSide(battle, attacker.side), battle.physScale);
  const dp = physOf(defender.creature, CREATURES[defender.creature],
    upgradesForSide(battle, defender.side), battle.physScale);

  // Energy at the target. Drag is one multiplication per hex travelled — never
  // a pow, so the result is bit-identical everywhere.
  const fx = opts.fromX ?? attacker.x, fy = opts.fromY ?? attacker.y;
  const dist = eng.hexDistance(fx, fy, defender.x, defender.y);
  // Retained VELOCITY FRACTION, accumulated per hex, then squared — not v/v₀
  // reconstructed from an absolute speed. Algebraically the same thing, but the
  // reconstruction rounded differently for different v₀, so head mass moved the
  // damage by one part in 10^15 even where the physics says it must move it by
  // nothing at all. An invariant that holds to fifteen places is an invariant a
  // test has to write a tolerance for, and a tolerance is where a real effect
  // later hides.
  let retain = 1;
  if (kind === 'ranged') for (let i = 0; i < dist; i++) retain *= ap.velRetainPerHex_ratio;
  // Attack is skill in delivering the blow, so it belongs to the ENERGY and
  // reaches the pressure through it — not to the pressure alone. Attached only
  // to the pressure it stopped mattering the moment the point cleared armour.
  const attackStat = Math.max(0, eng.unitAttackStat(battle, attacker) + (opts.attackDelta || 0));
  // Energy is AUTHORED now, not computed from mass and speed — the bow's stored
  // energy is the decision. Drag still bleeds velocity, and since E ∝ v² the
  // retained fraction squared carries that loss into the energy without
  // reintroducing the uncoupled dial.
  const energy = ap.blowEnergy_j * retain * retain * quality
    * (1 + attackStat * CONFIG.PHYS_ATTACK_COUPLING);

  // Connection. A shot group grows with range as an area; a silhouette does
  // not. Inside ~6 hexes an archer's group is smaller than a man and every
  // shaft counts; past that the fraction that lands falls off as 1/d².
  let hit = 1;
  if (kind === 'ranged' && ap.dispersion_rad > 0) {
    // DROP, and it is the only place mass has ever cost anything. A heavier head at
    // the same bow energy leaves slower, drops more over the same distance, and a
    // range mis-estimate therefore costs more vertical miss: theta = g*dd/v^2. Angular
    // and constant in distance, so it adds to the authored aim dispersion rather than
    // scaling it. See PHYS_G in config.js for why this is not a range cliff.
    //
    // AND IT IS BOUNDED, because theta = g*dd/v^2 is the FLAT-FIRE linearisation and
    // stops describing anything once the shot is a lob. The linearisation holds while
    // the total drop over the flight is small against the range — 1/2 g (d/v)^2 << d,
    // i.e. v^2 >> g*d/2, which at battle distance (20 m) means v >> 10 m/s. Every
    // authored bow, sling and bolt sits at 21-78 m/s and is comfortably inside it. The
    // two Cyclops heave a 10 kg boulder at 10.5 m/s, which is exactly ON that boundary,
    // and the unbounded term then handed them an aim error of 0.133 rad against an
    // authored aim of 0.04 — 3.3x, the only shooters in the game where the MODIFIER
    // outweighed the thing it modifies, and the next worst is 1.3x.
    //
    // Measured, before the bound: 1200 Cyclops Kings against 200 Archangels connect
    // 100% at 2 hexes and 4.8% at ten, so 95% of the weapon's damage is lost between
    // point-blank and the range a shooter actually fights at — reported as "very weak
    // in melee seems reasonable, but damage from afar is terrible". Past the flat-fire
    // boundary the physics does not agree with the term either: a lobbed shot is thrown
    // near the range-optimal elevation, where range is STATIONARY in launch angle, so
    // its sensitivity to a mis-judged range is lower than a flat one's, not unboundedly
    // higher.
    //
    // The bound is a SHARE OF THE AUTHORED AIM rather than a radian constant, so it
    // needs no fitted number, scales with whatever a weapon's own group is, and stays
    // constant in distance — the property the whole term was built around (see PHYS_G).
    // At 1.0 it reads: ballistics may at most double a weapon's group. The founding
    // exemplar is untouched, because it lives far below the bound — a 40% heavier arrow
    // still leaves slower, still drops more and still hits less.
    // `aimAngle` (core/upgrades.js) is the one definition of aim-plus-drop, and
    // it lives there because `derivedOutputs` — the yardstick every upgrade node
    // is scored against — has to read the SAME number. It did not, for as long
    // as the drop term existed, and the gap made a whole class of node (buy
    // reach by lightening the projectile) score as improving nothing.
    const spread = aimAngle(ap) * dist * CONFIG.PHYS_HEX_METERS;
    const group = spread * spread;
    if (group > dp.frontalArea_m2) hit = dp.frontalArea_m2 / group;
  } else if (kind === 'ranged' && dist > CONFIG.RANGED_FULL_RANGE) {
    // An un-authored shooter has no ballistics to fall off with, so it keeps the
    // classic cliff. This is not tidiness — measured over 60 seeds, giving the
    // fallback a *guessed* dispersion_rad instead swung the all-un-authored control
    // matchup by 37 points of win rate, which is divergence produced by the
    // stand-in rather than by anything anyone authored. A fallback that moves
    // the control is an instrument measuring itself.
    hit *= 0.5;
  } else if (kind !== 'ranged' && c.reach === 'ranged' && !eng.ability(attacker, 'noMeleePenalty')) {
    hit *= 0.5; // a shooter swinging its bow, as in the classic model
  }

  // Penetration: what the armoured fraction of the body actually lets through.
  // The arithmetic lives in `penetrate` so the build chart can score DAMAGE
  // using the same chain the engine rolls rather than a second copy of it.
  // Defense and `ignoreDefense` are folded into the hardness here, because they
  // are properties of this fight and not of the armour.
  const defenseStat = Math.max(0, eng.unitDefenseStat(battle, defender) + (opts.defenseDelta || 0));
  let hardness = dp.armorHardness_pa * (1 + defenseStat * CONFIG.PHYS_DEFENSE_COUPLING);
  if (eng.ability(attacker, 'ignoreDefense')) hardness *= 1 - (c.defenseIgnore ?? 0.4);

  let delivered = penetrate(energy, ap, hardness, dp.armorCoverage_frac, tissueOf(dp)) * hit;

  // Hero skills keep their classic meaning: they scale what gets delivered.
  const hero = battle.sides[attacker.side].hero;
  if (hero) delivered *= 1 + skillValue(hero, kind === 'ranged' ? 'archery' : 'offense');
  const defHero = battle.sides[defender.side].hero;
  if (defHero) delivered *= 1 - skillValue(defHero, 'armorer');
  if (attacker.machine === 'arrowTower') delivered *= battle.siegeTowerDamage;

  // Joules into hit points, across the whole stack.
  return (delivered * attacker.count / dp.woundEnergy_j) * defender.maxHp;
}

/** How cleanly a blow lands, as a factor around 1.0. `roll` supplies the dice. */
function qualityOf(attacker, eng, roll, opts = {}) {
  const [dmin, dmax] = CREATURES[attacker.creature].damage;
  let per;
  if (opts.forceMax || (!opts.forceMin && eng.hasFlag(attacker, 'blessed'))) per = dmax;
  else if (opts.forceMin || eng.hasFlag(attacker, 'cursed')) per = dmin;
  else per = roll(dmin, dmax);
  return per / ((dmin + dmax) / 2);
}

/**
 * One attack instance, physically. Signature and return shape match rollDamage.
 * `eng` carries the engine helpers (see the header note on injection).
 */
export function physicalDamage(battle, attacker, defender, kind, eng) {
  const side = battle.sides[attacker.side];
  // The classic roll, kept verbatim so the draw count and the blessed/cursed
  // overrides are identical, read as a quality factor around a nominal blow
  // rather than as hit points.
  const quality = qualityOf(attacker, eng,
    (dmin, dmax) => eng.stanceBaseRoll(battle.rng, dmin, dmax, side.stance));
  let dmg = blow(battle, attacker, defender, kind, eng, quality);

  // Luck — the same two chances, in the same order, as the classic model.
  let luck = 0;
  const l = eng.sideLuck(battle, attacker.side, attacker);
  const sw = eng.stanceSwing(side.stance);
  if (l > 0 && battle.rng.chance(l * CONFIG.LUCK_CHANCE_PER_POINT * sw)) { dmg *= 2; luck = 1; }
  else if (l < 0 && battle.rng.chance(-l * CONFIG.LUCK_CHANCE_PER_POINT * sw)) { dmg *= 0.5; luck = -1; }

  return { damage: Math.max(1, Math.round(dmg)), luck };
}

/**
 * Expected damage of one strike under the physical model — the estimator's
 * counterpart to `physicalDamage`, and the SAME arithmetic with the average
 * roll substituted for the dice.
 *
 * Unrounded on purpose. The AI compares candidate targets and candidate hexes
 * against each other, and rounding to whole hit points collapses near-ties that
 * the physical model draws real distinctions between — a shot two hexes closer
 * is worth measurably more here, where under the classic cliff it was worth
 * nothing until the tenth hex.
 *
 * Luck is ignored, exactly as the classic estimator ignores it: it is a
 * symmetric coin the AI cannot influence, so it shifts every candidate equally.
 */
export function expectedPhysicalDamage(battle, attacker, defender, kind, eng, opts = {}) {
  const quality = qualityOf(attacker, eng, (dmin, dmax) => (dmin + dmax) / 2, opts);
  return Math.max(1, blow(battle, attacker, defender, kind, eng, quality, opts));
}
