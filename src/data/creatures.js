/**
 * creatures.js — Creature catalog (data-driven; no logic).
 *
 * HOW TO ADD A CREATURE
 * ---------------------
 * Add an entry keyed by a unique id. Required fields:
 *   name        display name
 *   faction     'castle' | 'inferno' | 'neutral' (add new faction ids freely)
 *   tier        1..7 (dwelling tier), neutrals may use any tier for guard sizing
 *   upgraded    true if this is the upgraded form of `upgradeOf`
 *   attack, defense, health, speed   — the core combat numbers
 *   damage      [min, max] per single creature
 *   reach       'melee' (adjacent only) | 'ranged' (shoots across the field)
 *               | 'flying' (melee but ignores obstacles & moves anywhere in speed)
 *   shots       ammo for ranged units
 *   growth      base weekly population added to a town dwelling
 *   cost        recruitment price per unit (any of the seven resources)
 *   aiValue     rough power score — used by the AI and to size neutral guards
 *   abilities   list of ability ids handled in combat/Rules (see docs/GAME_RULES.md).
 *               The complete set (a data whitelist is pinned in
 *               tests/data-integrity.test.js, so a typo'd id fails loudly):
 *               areaBlast, attacksAround, curseAura, doubleAttack, fireShield,
 *               ignoreDefense, lifeDrain, manaThief, moraleAura, noEnemyRetaliation,
 *               noMeleePenalty, rebirth, regenerate, resurrectAllies, shootsTwice,
 *               spellImmune, spellResist50, teleport, unlimitedRetaliation,
 *               untargetable (nothing may attack/shoot/enchant it — the Catapult)
 *   glyph       icon key drawn by gfx/CreatureGlyphs.js (add a drawing there for new ones)
 *   tint        base color of the unit token
 *   desc        one-line flavor/help text shown in tooltips
 *
 * Stats follow HoMM3 closely (see docs/DESIGN_DECISIONS.md for deviations).
 *
 * PHYSICAL PARAMETERS — the optional `phys` block
 * -----------------------------------------------
 * A creature MAY carry a `phys` block: the same fight described in SI units
 * instead of in game integers. It is read only by the opt-in `physicalDamage`
 * damage model; every other consumer, and the whole game with the flag off,
 * ignores it. Coverage is deliberately partial — creatures without a block get
 * a fallback synthesised from their classic stats — so factions can be authored
 * one at a time and measured against the classic model as they land.
 *
 *   phys: {
 *     // THE BLOW — what arrives at the target, per creature, per attack
 *     blowMass_kg           mass that actually lands: the arrow, or the weapon's head
 *     blowEnergy_j          energy the bow (or the arm) puts INTO the blow. The
 *                           decision a player actually makes; velocity is a
 *                           consequence of it and of blowMass_kg, not a dial
 *     contactArea_m2        area of the striking face; with the energy this is the pressure
 *     dispersion_rad        angular spread of the shot group — precision, not power. 0 = melee
 *     ballisticCoeff_kgpm2  sectional density of the projectile; how fast drag bleeds it
 *     // THE TARGET — what this creature is when it is the one being hit
 *     bodyMass_kg           one creature, kit included
 *     density_kgpm3         bulk density (flesh ≈ water ≈ 1000)
 *     armorHardness_gpa     pressure its armour resists before a point passes through
 *     armorCoverage_frac    0..1, the fraction of the body behind that armour
 *     woundEnergy_j         energy that takes ONE creature from full health to zero
 *     // DERIVED — written by scripts/data/derive-physical.mjs, never by hand
 *     frontalArea_m2        SHAPE_K · (bodyMass_kg/density_kgpm3)^(2/3) — the silhouette
 *     velRetainPerHex_ratio exp(−AIR_K · HEX_METERS / ballisticCoeff_kgpm2), per hex
 *     blowSpeed_mps         sqrt(2 · blowEnergy_j / blowMass_kg) — DERIVED, and
 *                           the reason it is: a bow stores a fixed energy, so a
 *                           heavier arrow leaves it SLOWER carrying the same
 *                           energy and more momentum. Authored as an independent
 *                           dial it let a heavier head buy energy no bow
 *                           supplied — see docs/PHYSICAL_MODEL.md §10
 *     armorHardness_pa      armorHardness_gpa × 1e9 — the figure the model actually reads
 *   }
 *
 * Two conventions hold across the roster, and both are choices rather than
 * physics:
 *
 *   woundEnergy_j ≈ 26 J per hit point, everywhere. Health is the game's
 *   abstraction for "how much punishment", so holding joules-per-hit-point
 *   constant is what makes one hit point mean the same thing for a pikeman and
 *   for an archangel. Letting toughness scale with body mass instead is more
 *   physical and unusable: an angel would take a fifth of the punishment its
 *   200 health says it does.
 *
 *   ballisticCoeff_kgpm2: 5000 on anything that does not shoot. Nothing flies, so the
 *   derived drag term is never read; 5000 is simply the "no drag" end of the
 *   range, and the field is present because a partially filled block would
 *   produce NaN damage rather than a fallback.
 *
 * The two derived numbers are the only fractional-exponent quantities in the
 * model, and they are computed offline precisely so that they are not computed
 * at runtime: `pow`/`exp` have implementation-defined precision in ECMA-262, so
 * a damage roll built on one is not bit-identical across engines. Re-run
 * `node scripts/data/derive-physical.mjs` after editing any authored field;
 * tests/data-integrity.test.js fails if the committed values have drifted.
 *
 * EVERY FIELD CARRIES ITS UNIT IN ITS NAME. Not decoration: `armorHardness` was
 * authored in pascals while the design exemplar meant gigapascals, and the
 * mismatch survived four phases and sixteen creatures because the unit lived in
 * a comment. A comment is not there when you are reading `dmg = blowMass * v`
 * three files away from the data table. A suffix is.
 *
 * Hardness is authored in GPa — 0.12 is a figure you can look up and find the
 * world agreeing with; 1.2e8 is not how anyone writes it — and the derivation
 * bakes the SI value the model reads. Same authoring-time/runtime split as the
 * exponents, for the same reason: the hot path should never have to know which
 * unit it is holding.
 *
 * World constants (hex width, air, silhouette factor) live in CONFIG.PHYS_*.
 */

export const CREATURES = {
  // ======================= CASTLE =======================
  pikeman: {
    name: 'Pikeman', faction: 'castle', tier: 1, upgraded: false,
    attack: 4, defense: 5, damage: [1, 3], health: 10, speed: 4, reach: 'melee',
    growth: 14, cost: { gold: 60 }, aiValue: 86, abilities: [],
    glyph: 'pike', tint: 0xb8c4d8, desc: 'Sturdy front-line infantry.',
    // A pike thrust: ~1.5 kg of head and forward shaft at a walking-pace 8 m/s.
    // 48 J is a modest blow, and the pike's job was never the joule count — it
    // was reach and a wall of points, neither of which this model can see.
    phys: {
      blowMass_kg: 1.5, blowEnergy_j: 57.2, contactArea_m2: 8.0e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 78, density_kgpm3: 1010, armorHardness_gpa: 0.18, armorCoverage_frac: 0.5, woundEnergy_j: 260,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.181349, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 180000000, blowSpeed_mps: 8.73308, bodyDepth_m: 0.234218,
    },
  },
  halberdier: {
    name: 'Halberdier', faction: 'castle', tier: 1, upgraded: true, upgradeOf: 'pikeman',
    attack: 6, defense: 5, damage: [2, 3], health: 10, speed: 5, reach: 'melee',
    growth: 14, cost: { gold: 75 }, aiValue: 132, abilities: [],
    glyph: 'halberd', tint: 0xd8e2f0, desc: 'Veteran infantry with wicked halberds.',
    // The halberd is the pike's answer to armour: a heavier head (2.2 kg) swung
    // rather than thrust, through a spike a third narrower. Nearly double the
    // energy through less area — this is the pair where the model most clearly
    // explains an upgrade the classic stats only assert.
    phys: {
      blowMass_kg: 2.2, blowEnergy_j: 77.29, contactArea_m2: 6.0e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 80, density_kgpm3: 1010, armorHardness_gpa: 0.2, armorCoverage_frac: 0.55, woundEnergy_j: 262,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.184436, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 200000000, blowSpeed_mps: 8.38234, bodyDepth_m: 0.236203,
    },
  },
  archer: {
    name: 'Archer', faction: 'castle', tier: 2, upgraded: false,
    attack: 6, defense: 3, damage: [2, 3], health: 10, speed: 4, reach: 'ranged', shots: 12,
    growth: 9, cost: { gold: 100 }, aiValue: 123, abilities: [],
    glyph: 'bow', tint: 0xc8b48a, desc: 'Basic ranged support.',
    // A 45 g war arrow off a self bow: ~68 J, which is where measured warbow
    // shafts actually land. Padded jack and an open face — 1.2e8 Pa is textile
    // and boiled leather, not plate, so a bodkin goes through what it covers.
    phys: {
      blowMass_kg: 0.045, blowEnergy_j: 71.5, contactArea_m2: 2.0e-5, dispersion_rad: 0.035, ballisticCoeff_kgpm2: 900,
      bodyMass_kg: 72, density_kgpm3: 1010, armorHardness_gpa: 0.12, armorCoverage_frac: 0.35, woundEnergy_j: 260,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.171926, velRetainPerHex_ratio: 0.99796, armorHardness_pa: 120000000, blowSpeed_mps: 56.3718, bodyDepth_m: 0.228052,
    },
  },
  marksman: {
    name: 'Marksman', faction: 'castle', tier: 2, upgraded: true, upgradeOf: 'archer',
    attack: 6, defense: 3, damage: [2, 3], health: 10, speed: 6, reach: 'ranged', shots: 24,
    growth: 9, cost: { gold: 150 }, aiValue: 189, abilities: ['shootsTwice'],
    glyph: 'crossbow', tint: 0xe0cba0, desc: 'Fires two bolts per attack.',
    // The crossbow's edge is NOT raw energy — 62 g at the same 55 m/s is ~94 J,
    // half a step up. It is the flat trajectory (dispersion_rad 0.022 rad against
    // the bow's 0.035, so the group is still inside a man at 20 m) and the
    // narrow bodkin head, which nearly doubles the pressure on the same energy.
    // Where the game disagrees with history it wins: it gives the Marksman a
    // SECOND bolt per attack, and these numbers describe one bolt.
    phys: {
      blowMass_kg: 0.062, blowEnergy_j: 81.125, contactArea_m2: 1.6e-5, dispersion_rad: 0.022, ballisticCoeff_kgpm2: 1200,
      bodyMass_kg: 74, density_kgpm3: 1010, armorHardness_gpa: 0.16, armorCoverage_frac: 0.42, woundEnergy_j: 275,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.175095, velRetainPerHex_ratio: 0.99847, armorHardness_pa: 160000000, blowSpeed_mps: 51.156, bodyDepth_m: 0.230144,
    },
  },
  griffin: {
    name: 'Griffin', faction: 'castle', tier: 3, upgraded: false,
    attack: 8, defense: 8, damage: [3, 6], health: 25, speed: 6, reach: 'flying',
    growth: 7, cost: { gold: 200 }, aiValue: 317, abilities: [],
    glyph: 'griffin', tint: 0xd9b458, desc: 'Flying beast of the royal aviaries.',
    // Talons, not a weapon: 1.6 kg of striking limb at 14 m/s out of a stoop.
    // The interesting number is the armour — 2.2e7 Pa is hide and feather, an
    // order of magnitude softer than a man in mail, so a griffin is a far better
    // target for arrows than its defense stat of 8 suggests.
    phys: {
      blowMass_kg: 1.6, blowEnergy_j: 128.7, contactArea_m2: 4.0e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 220, density_kgpm3: 950, armorHardness_gpa: 0.022, armorCoverage_frac: 0.6, woundEnergy_j: 650,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.377108, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 22000000, blowSpeed_mps: 12.6837, bodyDepth_m: 0.33775,
    },
  },
  royalGriffin: {
    name: 'Royal Griffin', faction: 'castle', tier: 3, upgraded: true, upgradeOf: 'griffin',
    attack: 9, defense: 9, damage: [3, 6], health: 25, speed: 9, reach: 'flying',
    growth: 7, cost: { gold: 240 }, aiValue: 436, abilities: ['unlimitedRetaliation'],
    glyph: 'griffin', tint: 0xf0d070, desc: 'Retaliates against every attack.',
    phys: {
      blowMass_kg: 1.8, blowEnergy_j: 140.184, contactArea_m2: 3.6e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 230, density_kgpm3: 950, armorHardness_gpa: 0.028, armorCoverage_frac: 0.62, woundEnergy_j: 660,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.388451, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 28000000, blowSpeed_mps: 12.4804, bodyDepth_m: 0.342792,
    },
  },
  swordsman: {
    name: 'Swordsman', faction: 'castle', tier: 4, upgraded: false,
    attack: 10, defense: 12, damage: [6, 9], health: 35, speed: 5, reach: 'melee',
    growth: 4, cost: { gold: 300 }, aiValue: 468, abilities: [],
    glyph: 'sword', tint: 0x9fb2cc, desc: 'Heavily armored men-at-arms.',
    // An arming sword's tip at 17 m/s carries ~200 J, and the edge is thin
    // (3.0e-5 m²) so the pressure is high. Against its own kind it matters
    // little: 3.5e8 Pa over 70% of the body is plate, and plate is what this
    // model finally has a way to say.
    phys: {
      blowMass_kg: 1.4, blowEnergy_j: 214.5, contactArea_m2: 3.0e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 95, density_kgpm3: 1010, armorHardness_gpa: 0.35, armorCoverage_frac: 0.7, woundEnergy_j: 910,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.206824, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 350000000, blowSpeed_mps: 17.5051, bodyDepth_m: 0.250129,
    },
  },
  crusader: {
    name: 'Crusader', faction: 'castle', tier: 4, upgraded: true, upgradeOf: 'swordsman',
    attack: 12, defense: 12, damage: [7, 10], health: 35, speed: 6, reach: 'melee',
    growth: 4, cost: { gold: 400 }, aiValue: 707, abilities: ['doubleAttack'],
    glyph: 'crusader', tint: 0xdfe8f5, desc: 'Strikes twice with every attack.',
    phys: {
      blowMass_kg: 1.6, blowEnergy_j: 263.646, contactArea_m2: 2.6e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 98, density_kgpm3: 1010, armorHardness_gpa: 0.42, armorCoverage_frac: 0.75, woundEnergy_j: 920,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.211156, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 420000000, blowSpeed_mps: 18.1537, bodyDepth_m: 0.252734,
    },
  },
  monk: {
    name: 'Monk', faction: 'castle', tier: 5, upgraded: false,
    attack: 12, defense: 7, damage: [10, 12], health: 30, speed: 5, reach: 'ranged', shots: 12,
    growth: 3, cost: { gold: 400 }, aiValue: 577, abilities: [],
    glyph: 'monk', tint: 0xb89ad0, desc: 'Battle-clerics hurling holy bolts.',
    // The monk's bolt has no historical referent to check against, so it is
    // authored as a hurled mass — 0.35 kg at 45 m/s — sized to reproduce the
    // damage tuple. Its robes are the point: 6e7 Pa over a fifth of the body is
    // the softest armour in the faction, which is why a monk dies to anything
    // that reaches it.
    phys: {
      blowMass_kg: 0.35, blowEnergy_j: 314.6, contactArea_m2: 8.0e-5, dispersion_rad: 0.03, ballisticCoeff_kgpm2: 1500,
      bodyMass_kg: 76, density_kgpm3: 1010, armorHardness_gpa: 0.06, armorCoverage_frac: 0.2, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.178236, velRetainPerHex_ratio: 0.998775, armorHardness_pa: 60000000, blowSpeed_mps: 42.3995, bodyDepth_m: 0.232199,
    },
  },
  zealot: {
    name: 'Zealot', faction: 'castle', tier: 5, upgraded: true, upgradeOf: 'monk',
    attack: 12, defense: 10, damage: [10, 12], health: 30, speed: 7, reach: 'ranged', shots: 24,
    growth: 3, cost: { gold: 450 }, aiValue: 800, abilities: ['noMeleePenalty'],
    glyph: 'zealot', tint: 0xd0b0ea, desc: 'Suffers no penalty in melee.',
    phys: {
      blowMass_kg: 0.4, blowEnergy_j: 341.807, contactArea_m2: 7.0e-5, dispersion_rad: 0.024, ballisticCoeff_kgpm2: 1800,
      bodyMass_kg: 78, density_kgpm3: 1010, armorHardness_gpa: 0.11, armorCoverage_frac: 0.3, woundEnergy_j: 790,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.181349, velRetainPerHex_ratio: 0.998979, armorHardness_pa: 110000000, blowSpeed_mps: 41.3405, bodyDepth_m: 0.234218,
    },
  },
  cavalier: {
    name: 'Cavalier', faction: 'castle', tier: 6, upgraded: false,
    attack: 15, defense: 15, damage: [15, 25], health: 100, speed: 7, reach: 'melee',
    growth: 2, cost: { gold: 1000 }, aiValue: 1826, abilities: [],
    glyph: 'horse', tint: 0xc5a26a, desc: 'Heavy shock cavalry.',
    // A couched lance does not carry the rider's arm, it carries the horse: the
    // 10 kg is the effective striking mass delivered through the point at an
    // 11 m/s charge (a real gallop, ~40 km/h), not the lance's own weight.
    // 605 J through 5e-5 m² is the highest pressure on the field, which is
    // exactly what a charge is for.
    phys: {
      blowMass_kg: 10, blowEnergy_j: 572, contactArea_m2: 5.0e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 700, density_kgpm3: 1010, armorHardness_gpa: 0.38, armorCoverage_frac: 0.6, woundEnergy_j: 2600,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.783161, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 380000000, blowSpeed_mps: 10.6958, bodyDepth_m: 0.48673,
    },
  },
  champion: {
    name: 'Champion', faction: 'castle', tier: 6, upgraded: true, upgradeOf: 'cavalier',
    attack: 16, defense: 16, damage: [20, 25], health: 100, speed: 9, reach: 'melee',
    growth: 2, cost: { gold: 1200 }, aiValue: 2016, abilities: [],
    glyph: 'champion', tint: 0xe8c888, desc: 'The kingdom’s finest lancers.',
    phys: {
      blowMass_kg: 11, blowEnergy_j: 695.61, contactArea_m2: 4.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 720, density_kgpm3: 1010, armorHardness_gpa: 0.45, armorCoverage_frac: 0.65, woundEnergy_j: 2620,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.798008, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 450000000, blowSpeed_mps: 11.2461, bodyDepth_m: 0.491322,
    },
  },
  angel: {
    name: 'Angel', faction: 'castle', tier: 7, upgraded: false,
    attack: 20, defense: 20, damage: [50, 50], health: 200, speed: 12, reach: 'flying',
    growth: 1, cost: { gold: 3000, gems: 1 }, aiValue: 5227, abilities: ['moraleAura'],
    glyph: 'angel', tint: 0xfff2c8, desc: 'Radiant warriors; +1 morale to the army.',
    // 6 kg of blade at 23 m/s off a four-metre frame. The armour (6e8 Pa over
    // 80%) is the hardest thing in the faction and it is what makes an angel
    // read as an angel here: not that it hits hard — a champion hits harder —
    // but that almost nothing the roster carries gets through it.
    phys: {
      blowMass_kg: 6, blowEnergy_j: 1430, contactArea_m2: 4.0e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 400, density_kgpm3: 1000, armorHardness_gpa: 0.6, armorCoverage_frac: 0.8, woundEnergy_j: 5200,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.542884, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 600000000, blowSpeed_mps: 21.8327, bodyDepth_m: 0.405243,
    },
  },
  archangel: {
    name: 'Archangel', faction: 'castle', tier: 7, upgraded: true, upgradeOf: 'angel',
    attack: 30, defense: 30, damage: [50, 50], health: 250, speed: 18, reach: 'flying',
    growth: 1, cost: { gold: 5000, gems: 3 }, aiValue: 9366,
    abilities: ['moraleAura', 'resurrectAllies'],
    glyph: 'archangel', tint: 0xfff8e0,
    desc: 'Can resurrect fallen allies once per battle; +1 morale.',
    phys: {
      blowMass_kg: 7, blowEnergy_j: 1545.8, contactArea_m2: 3.6e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 440, density_kgpm3: 1000, armorHardness_gpa: 0.75, armorCoverage_frac: 0.85, woundEnergy_j: 6550,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.578498, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 750000000, blowSpeed_mps: 21.0156, bodyDepth_m: 0.418325,
    },
  },

  // ======================= INFERNO =======================
  imp: {
    name: 'Imp', faction: 'inferno', tier: 1, upgraded: false,
    attack: 2, defense: 3, damage: [1, 2], health: 4, speed: 5, reach: 'melee',
    growth: 15, cost: { gold: 50 }, aiValue: 49, abilities: ['manaThief'],
    glyph: 'imp', tint: 0xd0654a, desc: 'Steals mana whenever the enemy hero casts.',
    // Barely a blow at all — a hand's worth of mass and forty joules, which is a
    // hard slap. What an imp has instead of armour is being small: thirty kilos
    // of it, a sixth of that covered by anything.
    phys: {
      blowMass_kg: 0.3, blowEnergy_j: 42.9, contactArea_m2: 6e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 30, density_kgpm3: 1010, armorHardness_gpa: 0.02, armorCoverage_frac: 0.15, woundEnergy_j: 104,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.0959106, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 20000000, blowSpeed_mps: 16.9115, bodyDepth_m: 0.170332,
    },
  },
  familiar: {
    name: 'Familiar', faction: 'inferno', tier: 1, upgraded: true, upgradeOf: 'imp',
    attack: 4, defense: 4, damage: [1, 2], health: 4, speed: 7, reach: 'melee',
    growth: 15, cost: { gold: 60 }, aiValue: 72, abilities: ['manaThief'],
    glyph: 'imp', tint: 0xe88860, desc: 'Channels 20% of enemy spell mana to its hero.',
    // The same imp, quicker and a little better kept: a shade more behind the
    // claw, onto a slightly keener point, with a scrap more hide over it.
    phys: {
      blowMass_kg: 0.32, blowEnergy_j: 46.02, contactArea_m2: 5.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 32, density_kgpm3: 1010, armorHardness_gpa: 0.03, armorCoverage_frac: 0.18, woundEnergy_j: 104,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.100127, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 30000000, blowSpeed_mps: 16.9595, bodyDepth_m: 0.174036,
    },
  },
  gog: {
    name: 'Gog', faction: 'inferno', tier: 2, upgraded: false,
    attack: 6, defense: 4, damage: [2, 4], health: 13, speed: 4, reach: 'ranged', shots: 12,
    growth: 8, cost: { gold: 125 }, aiValue: 154, abilities: [],
    glyph: 'fireball', tint: 0xc84830, desc: 'Hurls balls of demonic fire.',
    // Thrown, not shot, and the two numbers that say so are the wide group and
    // the low sectional density: a lobbed ball sheds speed over a hex where an
    // arrow barely notices. Quarter of a kilogram, 87 J, 30 milliradians of spray.
    phys: {
      blowMass_kg: 0.25, blowEnergy_j: 85.8, contactArea_m2: 5e-5, dispersion_rad: 0.03, ballisticCoeff_kgpm2: 1200,
      bodyMass_kg: 55, density_kgpm3: 1010, armorHardness_gpa: 0.05, armorCoverage_frac: 0.3, woundEnergy_j: 338,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.143668, velRetainPerHex_ratio: 0.99847, armorHardness_pa: 50000000, blowSpeed_mps: 26.1992, bodyDepth_m: 0.20847,
    },
  },
  magog: {
    name: 'Magog', faction: 'inferno', tier: 2, upgraded: true, upgradeOf: 'gog',
    attack: 7, defense: 4, damage: [2, 4], health: 13, speed: 6, reach: 'ranged', shots: 24,
    growth: 8, cost: { gold: 175 }, aiValue: 175, abilities: ['areaBlast'],
    glyph: 'fireball', tint: 0xe86840, desc: 'Fireballs splash onto adjacent stacks.',
    // The same throw, better practised: more energy behind it and a fifth off the
    // group. Both are the arm rather than the ball, which is why the upgrade
    // moves them and leaves the sectional density where it was.
    phys: {
      blowMass_kg: 0.27, blowEnergy_j: 92.04, contactArea_m2: 4.6e-5, dispersion_rad: 0.024, ballisticCoeff_kgpm2: 1200,
      bodyMass_kg: 58, density_kgpm3: 1010, armorHardness_gpa: 0.06, armorCoverage_frac: 0.34, woundEnergy_j: 338,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.148846, velRetainPerHex_ratio: 0.99847, armorHardness_pa: 60000000, blowSpeed_mps: 26.1109, bodyDepth_m: 0.212193,
    },
  },
  hellHound: {
    name: 'Hell Hound', faction: 'inferno', tier: 3, upgraded: false,
    attack: 10, defense: 6, damage: [2, 7], health: 25, speed: 7, reach: 'melee',
    growth: 5, cost: { gold: 200 }, aiValue: 336, abilities: [],
    glyph: 'hound', tint: 0x8a3020, desc: 'Fast pack-hunters of the pit.',
    // Jaws — the roster's clearest small-area blow that is not a projectile. A
    // hound puts a modest 129 J through 0.3 cm² of fang, so the pressure is out
    // of all proportion to the energy, which is what a bite IS.
    phys: {
      blowMass_kg: 1.5, blowEnergy_j: 128.7, contactArea_m2: 3e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 140, density_kgpm3: 1010, armorHardness_gpa: 0.03, armorCoverage_frac: 0.2, woundEnergy_j: 650,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.267837, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 30000000, blowSpeed_mps: 13.0996, bodyDepth_m: 0.284642,
    },
  },
  cerberus: {
    name: 'Cerberus', faction: 'inferno', tier: 3, upgraded: true, upgradeOf: 'hellHound',
    attack: 10, defense: 8, damage: [2, 7], health: 25, speed: 8, reach: 'melee',
    growth: 5, cost: { gold: 250 }, aiValue: 712, abilities: ['noEnemyRetaliation'],
    glyph: 'cerberus', tint: 0xa84028, desc: 'Three heads; victims cannot retaliate.',
    // Three heads on one body: more jaw arriving on a narrower point, off a frame
    // that is barely heavier. The upgrade is the bite, not the beast.
    phys: {
      blowMass_kg: 1.6, blowEnergy_j: 138.06, contactArea_m2: 2.8e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 145, density_kgpm3: 1010, armorHardness_gpa: 0.04, armorCoverage_frac: 0.22, woundEnergy_j: 650,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.274177, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 40000000, blowSpeed_mps: 13.1368, bodyDepth_m: 0.287991,
    },
  },
  demon: {
    name: 'Demon', faction: 'inferno', tier: 4, upgraded: false,
    attack: 10, defense: 10, damage: [7, 9], health: 35, speed: 5, reach: 'melee',
    growth: 4, cost: { gold: 250 }, aiValue: 475, abilities: [],
    glyph: 'demon', tint: 0xb05038, desc: 'The rank and file of the abyss.',
    // A demon fights the way a footman does — a blade in a fist, about 230 J of
    // it — and what the model records as the difference is the BODY behind it: a
    // quarter tonne, nearly half of it under hard scale.
    phys: {
      blowMass_kg: 3.5, blowEnergy_j: 228.8, contactArea_m2: 1.2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 260, density_kgpm3: 1010, armorHardness_gpa: 0.22, armorCoverage_frac: 0.45, woundEnergy_j: 910,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.40467, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 220000000, blowSpeed_mps: 11.4343, bodyDepth_m: 0.349875,
    },
  },
  hornedDemon: {
    name: 'Horned Demon', faction: 'inferno', tier: 4, upgraded: true, upgradeOf: 'demon',
    attack: 10, defense: 10, damage: [7, 9], health: 40, speed: 6, reach: 'melee',
    growth: 4, cost: { gold: 270 }, aiValue: 591, abilities: [],
    glyph: 'hornedDemon', tint: 0xc86848, desc: 'Tougher, meaner, hornier demons.',
    // The horns are the upgrade: more mass into the charge and less area to
    // spread it over, on a frame that is heavier and better scaled. The extra
    // five hit points are 130 more joules to put it down, at the same 26 J each.
    phys: {
      blowMass_kg: 4, blowEnergy_j: 245.44, contactArea_m2: 1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 290, density_kgpm3: 1010, armorHardness_gpa: 0.26, armorCoverage_frac: 0.48, woundEnergy_j: 1040,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.435229, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 260000000, blowSpeed_mps: 11.0779, bodyDepth_m: 0.362845,
    },
  },
  pitFiend: {
    name: 'Pit Fiend', faction: 'inferno', tier: 5, upgraded: false,
    attack: 13, defense: 13, damage: [13, 17], health: 45, speed: 6, reach: 'melee',
    growth: 3, cost: { gold: 500 }, aiValue: 736, abilities: [],
    glyph: 'whip', tint: 0x983828, desc: 'Overseers of the burning legions.',
    // A whip and a heavy arm: 429 J across a broad striking face, so an overseer
    // hits hard and concentrates badly. Armoured for standing in a line rather
    // than for duelling — a third of a GPa over half the body.
    phys: {
      blowMass_kg: 6, blowEnergy_j: 429, contactArea_m2: 1.6e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 420, density_kgpm3: 1010, armorHardness_gpa: 0.3, armorCoverage_frac: 0.5, woundEnergy_j: 1170,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.557124, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 300000000, blowSpeed_mps: 11.9583, bodyDepth_m: 0.410524,
    },
  },
  pitLord: {
    name: 'Pit Lord', faction: 'inferno', tier: 5, upgraded: true, upgradeOf: 'pitFiend',
    attack: 13, defense: 13, damage: [13, 17], health: 45, speed: 7, reach: 'melee',
    growth: 3, cost: { gold: 700 }, aiValue: 956, abilities: [],
    glyph: 'pitlord', tint: 0xb84830, desc: 'Lords of the pits of despair.',
    // More arm, less spread, more plate. The same overseer's whip landing where
    // it is aimed.
    phys: {
      blowMass_kg: 6.5, blowEnergy_j: 460.2, contactArea_m2: 1.4e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 450, density_kgpm3: 1010, armorHardness_gpa: 0.34, armorCoverage_frac: 0.55, woundEnergy_j: 1170,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.583348, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 340000000, blowSpeed_mps: 11.8996, bodyDepth_m: 0.420075,
    },
  },
  efreeti: {
    name: 'Efreeti', faction: 'inferno', tier: 6, upgraded: false,
    attack: 16, defense: 12, damage: [16, 24], health: 90, speed: 9, reach: 'flying',
    growth: 2, cost: { gold: 900 }, aiValue: 1582, abilities: [],
    glyph: 'flame', tint: 0xe07030, desc: 'Djinn of living flame.',
    // A lash rather than a club: 582 J off two and a half kilograms, so it
    // arrives at 21 m/s — fast for a melee blow. Little of an efreet is armoured
    // because little of an efreet is solid.
    phys: {
      blowMass_kg: 2.5, blowEnergy_j: 572, contactArea_m2: 8e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 400, density_kgpm3: 1010, armorHardness_gpa: 0.18, armorCoverage_frac: 0.4, woundEnergy_j: 2340,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.539294, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 180000000, blowSpeed_mps: 21.3916, bodyDepth_m: 0.403902,
    },
  },
  efreetSultan: {
    name: 'Efreet Sultan', faction: 'inferno', tier: 6, upgraded: true, upgradeOf: 'efreeti',
    attack: 16, defense: 14, damage: [16, 24], health: 90, speed: 13, reach: 'flying',
    growth: 2, cost: { gold: 1100 }, aiValue: 2309, abilities: ['fireShield'],
    glyph: 'flame', tint: 0xf89040, desc: 'Fire shield burns melee attackers.',
    // Hotter and better held: the same lash through a narrower front, and enough
    // more of the djinn hardened that a shield spell has something to bite on.
    phys: {
      blowMass_kg: 2.7, blowEnergy_j: 613.6, contactArea_m2: 7e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 420, density_kgpm3: 1010, armorHardness_gpa: 0.22, armorCoverage_frac: 0.44, woundEnergy_j: 2340,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.557124, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 220000000, blowSpeed_mps: 21.3194, bodyDepth_m: 0.410524,
    },
  },
  devil: {
    name: 'Devil', faction: 'inferno', tier: 7, upgraded: false,
    attack: 19, defense: 21, damage: [30, 40], health: 160, speed: 11, reach: 'flying',
    growth: 1, cost: { gold: 2700, mercury: 1 }, aiValue: 4720,
    abilities: ['noEnemyRetaliation', 'teleport', 'curseAura'],
    glyph: 'devil', tint: 0xd04040,
    desc: 'Teleports; victims cannot retaliate; -1 enemy luck.',
    // Nine hundred kilograms of devil behind nine of blade, through a hand's
    // breadth of edge. The top of the Inferno ladder reads like it: high energy
    // AND high pressure AND 0.42 GPa over most of the body, with no trade taken.
    phys: {
      blowMass_kg: 9, blowEnergy_j: 1001, contactArea_m2: 1.1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 900, density_kgpm3: 1010, armorHardness_gpa: 0.42, armorCoverage_frac: 0.62, woundEnergy_j: 4160,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.926007, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 420000000, blowSpeed_mps: 14.9146, bodyDepth_m: 0.529261,
    },
  },
  archDevil: {
    name: 'Arch Devil', faction: 'inferno', tier: 7, upgraded: true, upgradeOf: 'devil',
    attack: 26, defense: 28, damage: [30, 40], health: 200, speed: 17, reach: 'flying',
    growth: 1, cost: { gold: 4500, mercury: 2 }, aiValue: 7227,
    abilities: ['noEnemyRetaliation', 'teleport', 'curseAura'],
    glyph: 'archdevil', tint: 0xf05050,
    desc: 'Teleports across the field; victims cannot retaliate; -1 enemy luck.',
    // Half a GPa over two thirds of a tonne of devil, and the forty extra hit
    // points cost 1,040 more joules to work through at the same 26 J apiece.
    phys: {
      blowMass_kg: 10, blowEnergy_j: 1073.8, contactArea_m2: 1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 1000, density_kgpm3: 1010, armorHardness_gpa: 0.5, armorCoverage_frac: 0.66, woundEnergy_j: 5200,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.993388, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 500000000, blowSpeed_mps: 14.6547, bodyDepth_m: 0.548179,
    },
  },

  // ======================= TOWER =======================
  servitor: {
    name: 'Servitor', faction: 'tower', tier: 1, upgraded: false,
    attack: 4, defense: 4, damage: [1, 2], health: 5, speed: 5, reach: 'melee',
    growth: 14, cost: { gold: 40 }, aiValue: 58, abilities: [],
    glyph: 'servitor', tint: 0x8fb0c8, desc: 'Animated brass helpers of the academy.',
    // A gremlin's short blade at arm's length. Almost no mass and almost no
    // energy — tier 1 is where the model has least to say, and saying it small
    // is the honest version.
    phys: {
      blowMass_kg: 0.6, blowEnergy_j: 42.9, contactArea_m2: 9e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 25, density_kgpm3: 1010, armorHardness_gpa: 0.05, armorCoverage_frac: 0.3, woundEnergy_j: 130,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.0849335, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 50000000, blowSpeed_mps: 11.9583, bodyDepth_m: 0.160288,
    },
  },
  masterServitor: {
    name: 'Master Servitor', faction: 'tower', tier: 1, upgraded: true, upgradeOf: 'servitor',
    attack: 4, defense: 4, damage: [1, 2], health: 5, speed: 5, reach: 'ranged', shots: 8,
    growth: 14, cost: { gold: 55 }, aiValue: 86, abilities: [],
    glyph: 'masterServitor', tint: 0xb0d0e0, desc: 'Refitted to fling arcane bolts from afar.',
    // A weighted dart, thrown. THE UPGRADE GAINS A RANGED ATTACK, which no
    // Castle or Rampart pair does — so it is the first block on the roster whose
    // shot group opens from nothing rather than tightening (see the coherence
    // rule in data-integrity). 200 g puts it clear of the arrow envelope: a
    // servitor throws, it does not shoot.
    phys: {
      blowMass_kg: 0.2, blowEnergy_j: 46.02, contactArea_m2: 4e-5, dispersion_rad: 0.034, ballisticCoeff_kgpm2: 1400,
      bodyMass_kg: 26, density_kgpm3: 1010, armorHardness_gpa: 0.06, armorCoverage_frac: 0.32, woundEnergy_j: 130,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.0871836, velRetainPerHex_ratio: 0.998688, armorHardness_pa: 60000000, blowSpeed_mps: 21.4523, bodyDepth_m: 0.162398,
    },
  },
  stoneGargoyle: {
    name: 'Stone Gargoyle', faction: 'tower', tier: 2, upgraded: false,
    attack: 6, defense: 6, damage: [2, 3], health: 16, speed: 6, reach: 'flying',
    growth: 9, cost: { gold: 130 }, aiValue: 132, abilities: [],
    glyph: 'stoneGargoyle', tint: 0x8a8f98, desc: 'Carved sentinels roused to flight.',
    // Carved stone at 2,400 kg/m³ — three times a body's density, so a heavy
    // creature with a small silhouette. Hard almost everywhere and hitting with
    // a light claw: the inverse of the Griffin it shares a tier with.
    phys: {
      blowMass_kg: 1.2, blowEnergy_j: 71.5, contactArea_m2: 5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 180, density_kgpm3: 2400, armorHardness_gpa: 0.6, armorCoverage_frac: 0.85, woundEnergy_j: 416,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: carved stone.
      tissueStrength_pa: 100000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.177845, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 600000000, blowSpeed_mps: 10.9163, bodyDepth_m: 0.231944,
    },
  },
  obsidianGargoyle: {
    name: 'Obsidian Gargoyle', faction: 'tower', tier: 2, upgraded: true, upgradeOf: 'stoneGargoyle',
    attack: 7, defense: 7, damage: [2, 3], health: 16, speed: 9, reach: 'flying',
    growth: 9, cost: { gold: 160, crystal: 1 }, aiValue: 196, abilities: [],
    glyph: 'obsidianGargoyle', tint: 0x5a5f6a, desc: 'Volcanic-glass wings, swift and cruel.',
    // Volcanic glass: harder again, and it keeps an edge, so the same swing
    // lands through less area.
    phys: {
      blowMass_kg: 1.4, blowEnergy_j: 76.7, contactArea_m2: 4.4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 190, density_kgpm3: 2400, armorHardness_gpa: 0.8, armorCoverage_frac: 0.88, woundEnergy_j: 416,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: volcanic glass.
      tissueStrength_pa: 150000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.184372, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 800000000, blowSpeed_mps: 10.4676, bodyDepth_m: 0.236162,
    },
  },
  stoneGolem: {
    name: 'Stone Golem', faction: 'tower', tier: 3, upgraded: false,
    attack: 7, defense: 10, damage: [4, 5], health: 30, speed: 4, reach: 'melee',
    growth: 7, cost: { gold: 150 }, aiValue: 304, abilities: ['spellResist50'],
    glyph: 'stoneGolem', tint: 0x9098a0, desc: 'Slow construct; takes half damage from spells.',
    // An 8 kg stone fist, and 0.95 coverage — a golem has no gaps. The blunt
    // contact area is the widest of its tier, which is what makes it a poor
    // answer to plate and a fine one to everything softer.
    phys: {
      blowMass_kg: 8, blowEnergy_j: 128.7, contactArea_m2: 2.2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 400, density_kgpm3: 2600, armorHardness_gpa: 0.7, armorCoverage_frac: 0.95, woundEnergy_j: 780,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: quarried stone.
      tissueStrength_pa: 120000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.287116, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 700000000, blowSpeed_mps: 5.6723, bodyDepth_m: 0.294708,
    },
  },
  ironGolem: {
    name: 'Iron Golem', faction: 'tower', tier: 3, upgraded: true, upgradeOf: 'stoneGolem',
    attack: 9, defense: 10, damage: [4, 5], health: 35, speed: 5, reach: 'melee',
    growth: 7, cost: { gold: 200 }, aiValue: 431, abilities: ['spellResist50'],
    glyph: 'ironGolem', tint: 0xb8bcc4, desc: 'Forged anew; magic sloughs off its plating.',
    // Iron: 5,000 kg/m³ and 1.20 GPa, the hardest body anything on the roster
    // has to get through — harder than an Archangel's consecrated plate, which
    // is the point of a golem and not a slip.
    phys: {
      blowMass_kg: 9, blowEnergy_j: 138.06, contactArea_m2: 2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 500, density_kgpm3: 5000, armorHardness_gpa: 1.2, armorCoverage_frac: 0.95, woundEnergy_j: 910,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: wrought iron.
      tissueStrength_pa: 500000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.215443, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 1200000000, blowSpeed_mps: 5.53895, bodyDepth_m: 0.255287,
    },
  },
  mage: {
    name: 'Mage', faction: 'tower', tier: 4, upgraded: false,
    attack: 11, defense: 8, damage: [7, 9], health: 18, speed: 5, reach: 'ranged', shots: 12,
    growth: 4, cost: { gold: 350 }, aiValue: 531, abilities: ['noMeleePenalty'],
    glyph: 'mage', tint: 0x7ea0d0, desc: 'Fights unhindered even at close range.',
    // A cast bolt, shaped like the Monk's: 300 g of force with a shot group,
    // and a body wearing robes. Well clear of the arrow envelope — nothing in
    // Tower draws a bow.
    phys: {
      blowMass_kg: 0.3, blowEnergy_j: 228.8, contactArea_m2: 7e-5, dispersion_rad: 0.03, ballisticCoeff_kgpm2: 1500,
      bodyMass_kg: 70, density_kgpm3: 1010, armorHardness_gpa: 0.05, armorCoverage_frac: 0.2, woundEnergy_j: 468,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.168727, velRetainPerHex_ratio: 0.998775, armorHardness_pa: 50000000, blowSpeed_mps: 39.0555, bodyDepth_m: 0.22592,
    },
  },
  archMage: {
    name: 'Arch Mage', faction: 'tower', tier: 4, upgraded: true, upgradeOf: 'mage',
    attack: 12, defense: 9, damage: [7, 9], health: 18, speed: 7, reach: 'ranged', shots: 24,
    growth: 4, cost: { gold: 450 }, aiValue: 595, abilities: ['noMeleePenalty'],
    glyph: 'archMage', tint: 0xa0c0e8, desc: 'Masters of the academy; no melee penalty.',
    // The same cast, disciplined: a fifth tighter and through less area.
    phys: {
      blowMass_kg: 0.32, blowEnergy_j: 245.44, contactArea_m2: 6.2e-5, dispersion_rad: 0.024, ballisticCoeff_kgpm2: 1700,
      bodyMass_kg: 72, density_kgpm3: 1010, armorHardness_gpa: 0.07, armorCoverage_frac: 0.25, woundEnergy_j: 468,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.171926, velRetainPerHex_ratio: 0.998919, armorHardness_pa: 70000000, blowSpeed_mps: 39.1663, bodyDepth_m: 0.228052,
    },
  },
  genie: {
    name: 'Genie', faction: 'tower', tier: 5, upgraded: false,
    attack: 12, defense: 12, damage: [13, 16], health: 40, speed: 7, reach: 'flying',
    growth: 3, cost: { gold: 550, mercury: 1 }, aiValue: 694, abilities: [],
    glyph: 'genie', tint: 0x6fb0d8, desc: 'Djinn of the frozen wind.',
    // A body of moving air at 900 kg/m³, striking with something briefly
    // solid. Light for its size and barely armoured.
    phys: {
      blowMass_kg: 2.5, blowEnergy_j: 414.7, contactArea_m2: 6e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 200, density_kgpm3: 900, armorHardness_gpa: 0.1, armorCoverage_frac: 0.4, woundEnergy_j: 1040,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.366881, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 100000000, blowSpeed_mps: 18.2143, bodyDepth_m: 0.333139,
    },
  },
  masterGenie: {
    name: 'Master Genie', faction: 'tower', tier: 5, upgraded: true, upgradeOf: 'genie',
    attack: 12, defense: 12, damage: [13, 16], health: 40, speed: 11, reach: 'flying',
    growth: 3, cost: { gold: 600, mercury: 1 }, aiValue: 866, abilities: ['moraleAura'],
    glyph: 'masterGenie', tint: 0x90d0f0, desc: 'Their blessings lift the army; +1 morale.',
    // Denser at the edges where it matters.
    phys: {
      blowMass_kg: 2.8, blowEnergy_j: 444.86, contactArea_m2: 5.4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 210, density_kgpm3: 900, armorHardness_gpa: 0.14, armorCoverage_frac: 0.45, woundEnergy_j: 1040,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.37901, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 140000000, blowSpeed_mps: 17.8257, bodyDepth_m: 0.338601,
    },
  },
  naga: {
    name: 'Naga', faction: 'tower', tier: 6, upgraded: false,
    attack: 16, defense: 13, damage: [16, 20], health: 90, speed: 5, reach: 'melee',
    growth: 2, cost: { gold: 1100, gems: 1 }, aiValue: 1975, abilities: ['noEnemyRetaliation'],
    glyph: 'naga', tint: 0x5fa088, desc: 'Six-armed serpents; strikes without reprisal.',
    // Six blades arriving together. Modelled as one blow through a narrow
    // contact area rather than six — the engine has one blow per attack, and a
    // sixth of the area is the honest way to say "all of them at once".
    phys: {
      blowMass_kg: 6, blowEnergy_j: 514.8, contactArea_m2: 4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 400, density_kgpm3: 1050, armorHardness_gpa: 0.3, armorCoverage_frac: 0.6, woundEnergy_j: 2340,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.525509, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 300000000, blowSpeed_mps: 13.0996, bodyDepth_m: 0.398706,
    },
  },
  nagaQueen: {
    name: 'Naga Queen', faction: 'tower', tier: 6, upgraded: true, upgradeOf: 'naga',
    attack: 16, defense: 13, damage: [30, 30], health: 110, speed: 7, reach: 'melee',
    growth: 2, cost: { gold: 1600, gems: 2 }, aiValue: 3285, abilities: ['noEnemyRetaliation'],
    glyph: 'nagaQueen', tint: 0x7fc0a8, desc: 'Sovereigns of the pavilion; none may retaliate.',
    // The classic stats jump to a flat 30 damage here, which is the largest
    // single-step rise in either faction — so the energy ratio is authored at the
    // bottom of the band rather than the middle, or the physical envelope would
    // have run past what the tuple it replaces asserts.
    phys: {
      blowMass_kg: 7, blowEnergy_j: 920.4, contactArea_m2: 3.4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 450, density_kgpm3: 1050, armorHardness_gpa: 0.4, armorCoverage_frac: 0.65, woundEnergy_j: 2860,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.568437, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 400000000, blowSpeed_mps: 16.2164, bodyDepth_m: 0.414671,
    },
  },
  giant: {
    name: 'Giant', faction: 'tower', tier: 7, upgraded: false,
    attack: 19, defense: 16, damage: [40, 60], health: 150, speed: 7, reach: 'melee',
    growth: 1, cost: { gold: 2000, crystal: 1 }, aiValue: 4108, abilities: [],
    glyph: 'giant', tint: 0xc8d4e2, desc: 'Frost-born colossi of the high peaks.',
    // Forty kilograms of fist through half a square metre of nothing in
    // particular. Enormous energy, almost no pressure — a giant is the roster's
    // clearest statement that those are different quantities.
    phys: {
      blowMass_kg: 40, blowEnergy_j: 1430, contactArea_m2: 5e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 1800, density_kgpm3: 1010, armorHardness_gpa: 0.25, armorCoverage_frac: 0.5, woundEnergy_j: 3900,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 1.46994, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 250000000, blowSpeed_mps: 8.45577, bodyDepth_m: 0.666827,
    },
  },
  titan: {
    name: 'Titan', faction: 'tower', tier: 7, upgraded: true, upgradeOf: 'giant',
    attack: 24, defense: 24, damage: [40, 60], health: 300, speed: 11, reach: 'ranged', shots: 24,
    growth: 1, cost: { gold: 5000, crystal: 2 }, aiValue: 6461, abilities: ['noMeleePenalty'],
    glyph: 'titan', tint: 0xdce8f5, desc: 'Hurl bolts of lightning; no melee penalty.',
    // THE UPGRADE GAINS A RANGED ATTACK, and it changes what the blow IS: the
    // Giant's 40 kg fist becomes half a kilogram of lightning. Far less mass,
    // far more of it through a point — the pair is the roster's sharpest example
    // of an upgrade that is a different weapon rather than a bigger one.
    phys: {
      blowMass_kg: 0.5, blowEnergy_j: 1534, contactArea_m2: 9e-5, dispersion_rad: 0.02, ballisticCoeff_kgpm2: 2000,
      bodyMass_kg: 2200, density_kgpm3: 1010, armorHardness_gpa: 0.5, armorCoverage_frac: 0.7, woundEnergy_j: 7800,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 1.68035, velRetainPerHex_ratio: 0.999081, armorHardness_pa: 500000000, blowSpeed_mps: 78.3326, bodyDepth_m: 0.712957,
    },
  },

  // ======================= RAMPART =======================
  centaur: {
    name: 'Centaur', faction: 'rampart', tier: 1, upgraded: false,
    attack: 5, defense: 3, damage: [2, 3], health: 8, speed: 6, reach: 'melee',
    growth: 14, cost: { gold: 70 }, aiValue: 99, abilities: [],
    glyph: 'centaur', tint: 0xb08c58, desc: 'Swift spear-bearing scouts of the glades.',
    // A rider's sword from horseback — 1.2 kg at ~10 m/s, so a modest 63 J. What
    // makes a centaur interesting to this model is not the blow but the BODY: a
    // shield and helm are hard steel over a fifth of a horse-sized animal, which is
    // the (hard, bare) combination the roster had none of. 0.32 GPa over 22%.
    phys: {
      blowMass_kg: 1.2, blowEnergy_j: 61.875, contactArea_m2: 1.0e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 550, density_kgpm3: 1010, armorHardness_gpa: 0.32, armorCoverage_frac: 0.22, woundEnergy_j: 180,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.666849, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 320000000, blowSpeed_mps: 10.155, bodyDepth_m: 0.449135,
    },
  },
  centaurCaptain: {
    name: 'Centaur Captain', faction: 'rampart', tier: 1, upgraded: true, upgradeOf: 'centaur',
    attack: 6, defense: 3, damage: [2, 3], health: 10, speed: 8, reach: 'melee',
    growth: 14, cost: { gold: 90 }, aiValue: 136, abilities: [],
    glyph: 'centaur', tint: 0xd0a870, desc: 'Veteran herd-leaders, faster and hardier.',
    // THE PRE-REGISTERED TEST TARGET (docs §8b). A faced steel shield and a mail
    // vest: 0.45 GPa over 26% of a horse. That is the same hardness as a Champion
    // and 39 points less coverage, so the two are one hardness CLASS and opposite
    // sides of the fork's isocline — which is the matched pair the curve predicts
    // must disagree, and which any monotone hardness→bodkin story says must agree.
    phys: {
      blowMass_kg: 1.4, blowEnergy_j: 70.8, contactArea_m2: 9.0e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 560, density_kgpm3: 1010, armorHardness_gpa: 0.45, armorCoverage_frac: 0.26, woundEnergy_j: 240,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.674908, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 450000000, blowSpeed_mps: 10.057, bodyDepth_m: 0.45184,
    },
  },
  dwarf: {
    name: 'Dwarf', faction: 'rampart', tier: 2, upgraded: false,
    attack: 6, defense: 7, damage: [2, 4], health: 20, speed: 3, reach: 'melee',
    growth: 8, cost: { gold: 120 }, aiValue: 149, abilities: [],
    glyph: 'dwarf', tint: 0xb87848, desc: 'Stubborn axemen of the mountain vales.',
    // The opposite corner from a centaur, and authored as the contrast: a 2.5 kg axe
    // and mail over four fifths of a very small body. Same hardness band, triple
    // the coverage — so hardness alone cannot tell a dwarf from a centaur, and the
    // fork's answer for the two is different.
    phys: {
      blowMass_kg: 2.5, blowEnergy_j: 85.8, contactArea_m2: 6.0e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 95, density_kgpm3: 1040, armorHardness_gpa: 0.30, armorCoverage_frac: 0.80, woundEnergy_j: 520,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.202828, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 300000000, blowSpeed_mps: 8.28493, bodyDepth_m: 0.2477,
    },
  },
  battleDwarf: {
    name: 'Battle Dwarf', faction: 'rampart', tier: 2, upgraded: true, upgradeOf: 'dwarf',
    attack: 7, defense: 7, damage: [2, 4], health: 20, speed: 5, reach: 'melee',
    growth: 8, cost: { gold: 150 }, aiValue: 218, abilities: ['spellResist50'],
    glyph: 'dwarf', tint: 0xd89858, desc: 'Rune-warded veterans; take half damage from spells.',
    // Riveted mail and a heavier haft. Fills 0.20-0.35 GPa, which held exactly one
    // target before this pass.
    phys: {
      blowMass_kg: 2.8, blowEnergy_j: 92.04, contactArea_m2: 5.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 96, density_kgpm3: 1040, armorHardness_gpa: 0.36, armorCoverage_frac: 0.84, woundEnergy_j: 520,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.204248, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 360000000, blowSpeed_mps: 8.1082, bodyDepth_m: 0.248566,
    },
  },
  woodElf: {
    name: 'Wood Elf', faction: 'rampart', tier: 3, upgraded: false,
    attack: 9, defense: 5, damage: [3, 5], health: 15, speed: 6, reach: 'ranged', shots: 12,
    growth: 7, cost: { gold: 200 }, aiValue: 251, abilities: [],
    glyph: 'bow', tint: 0x7fb060, desc: 'Keen-eyed archers of the deep forest.',
    // Authored ahead of the rest of Rampart because the Homestead upgrade branch
    // patches these two, and a branch that patches a creature with no physics
    // would be adjusting numbers nobody chose. A lighter, faster arrow than the
    // human warbow's (50 g at 68 m/s) off a longer draw, out of a lighter body
    // in leather — elves shoot better and take a hit worse.
    phys: {
      blowMass_kg: 0.05, blowEnergy_j: 97.7146, contactArea_m2: 1.8e-5, dispersion_rad: 0.026, ballisticCoeff_kgpm2: 1000,
      bodyMass_kg: 65, density_kgpm3: 1010, armorHardness_gpa: 0.08, armorCoverage_frac: 0.3, woundEnergy_j: 390,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.160594, velRetainPerHex_ratio: 0.998164, armorHardness_pa: 80000000, blowSpeed_mps: 62.5187, bodyDepth_m: 0.220408,
    },
  },
  grandElf: {
    name: 'Grand Elf', faction: 'rampart', tier: 3, upgraded: true, upgradeOf: 'woodElf',
    attack: 9, defense: 5, damage: [3, 5], health: 15, speed: 7, reach: 'ranged', shots: 24,
    growth: 7, cost: { gold: 275 }, aiValue: 335, abilities: ['shootsTwice'],
    glyph: 'bow', tint: 0x9fd080, desc: 'Fires two arrows per attack.',
    phys: {
      blowMass_kg: 0.052, blowEnergy_j: 98.6299, contactArea_m2: 1.6e-5, dispersion_rad: 0.021, ballisticCoeff_kgpm2: 1100,
      bodyMass_kg: 66, density_kgpm3: 1010, armorHardness_gpa: 0.1, armorCoverage_frac: 0.33, woundEnergy_j: 396,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.162236, velRetainPerHex_ratio: 0.99833, armorHardness_pa: 100000000, blowSpeed_mps: 61.5911, bodyDepth_m: 0.221532,
    },
  },
  pegasus: {
    name: 'Pegasus', faction: 'rampart', tier: 4, upgraded: false,
    attack: 8, defense: 8, damage: [3, 6], health: 30, speed: 8, reach: 'flying',
    growth: 5, cost: { gold: 250 }, aiValue: 321, abilities: [],
    glyph: 'pegasus', tint: 0xd8e2f0, desc: 'Winged steeds of the high meadows.',
    // Hooves, 6 kg of them at 7 m/s. Authored to DECORRELATE the crossover band:
    // soft leather barding (0.12 GPa) over 62% of a horse puts a low-hardness,
    // HIGH-coverage point where the band previously ran monotone. Inside 0.10-0.20
    // GPa coverage now spans 28-66% instead of 30-50%.
    phys: {
      blowMass_kg: 6.0, blowEnergy_j: 128.7, contactArea_m2: 1.2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 480, density_kgpm3: 990, armorHardness_gpa: 0.12, armorCoverage_frac: 0.62, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.617169, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 120000000, blowSpeed_mps: 6.54981, bodyDepth_m: 0.432081,
    },
  },
  silverPegasus: {
    name: 'Silver Pegasus', faction: 'rampart', tier: 4, upgraded: true, upgradeOf: 'pegasus',
    attack: 9, defense: 10, damage: [3, 6], health: 30, speed: 12, reach: 'flying',
    growth: 5, cost: { gold: 275 }, aiValue: 382, abilities: [],
    glyph: 'pegasus', tint: 0xeef2fa, desc: 'Moon-bright fliers, swifter than the wind.',
    // Silvered barding — harder, and over a little more of the animal.
    phys: {
      blowMass_kg: 6.5, blowEnergy_j: 138.06, contactArea_m2: 1.15e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 485, density_kgpm3: 990, armorHardness_gpa: 0.16, armorCoverage_frac: 0.66, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.621447, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 160000000, blowSpeed_mps: 6.51767, bodyDepth_m: 0.433576,
    },
  },
  dendroid: {
    name: 'Dendroid Guard', faction: 'rampart', tier: 5, upgraded: false,
    attack: 9, defense: 12, damage: [10, 14], health: 55, speed: 3, reach: 'melee',
    growth: 3, cost: { gold: 350 }, aiValue: 628, abilities: [],
    glyph: 'dendroid', tint: 0x6a8848, desc: 'Slow, rooted wardens of living wood.',
    // MATCHED PAIR A, half one (docs §8b). Bark: 0.1974 GPa authored, which with
    // Defense 12 lands at 0.60 GPa EFFECTIVE — and effective is the coordinate the
    // fork turns on. Specified by landing point and solved back with `authorAt`,
    // because authoring plausible stats and plotting where they fell is what put
    // four creatures outside their intended band twice.
    // Coverage 25%: a treant is bark over its trunk and open everywhere else.
    phys: {
      blowMass_kg: 40, blowEnergy_j: 343.2, contactArea_m2: 4.0e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 900, density_kgpm3: 700, armorHardness_gpa: 0.1974, armorCoverage_frac: 0.25, woundEnergy_j: 1430,
      // WOOD, NOT FLESH — 700 kg/m³ is outside the 850-1100 band `tissueOf` treats as
      // tissue, so the penetration resistance is authored rather than defaulted. And a
      // tree does not haemorrhage: the width term's whole mechanism is blood loss
      // through a cut that will not close, so it must not fire here.
      tissueStrength_pa: 4.0e7, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 1.1824, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 197400000, blowSpeed_mps: 4.14246, bodyDepth_m: 0.598059,
    },
  },
  dendroidSoldier: {
    name: 'Dendroid Soldier', faction: 'rampart', tier: 5, upgraded: true, upgradeOf: 'dendroid',
    attack: 9, defense: 12, damage: [10, 14], health: 65, speed: 4, reach: 'melee',
    growth: 3, cost: { gold: 425 }, aiValue: 916, abilities: ['regenerate'],
    glyph: 'dendroid', tint: 0x88a860, desc: 'Living wood knits its wounds shut every round.',
    // MATCHED PAIR A, half two. IDENTICAL effective hardness — same 0.1974 GPa and
    // the same Defense 12, so also 0.60 GPa effective — and coverage 55% against the
    // Dendroid's 25%. The isocline puts the boundary at 40.3% coverage there, so
    // these two straddle it: odds ratio 0.49 and 1.81, opposite predicted signs from
    // coverage alone at identical hardness. Any monotone hardness→bodkin story
    // predicts the same answer for both.
    phys: {
      blowMass_kg: 45, blowEnergy_j: 368.16, contactArea_m2: 3.8e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 950, density_kgpm3: 700, armorHardness_gpa: 0.1974, armorCoverage_frac: 0.55, woundEnergy_j: 1690,
      // WOOD, NOT FLESH — 700 kg/m³ is outside the 850-1100 band `tissueOf` treats as
      // tissue, so the penetration resistance is authored rather than defaulted. And a
      // tree does not haemorrhage: the width term's whole mechanism is blood loss
      // through a cut that will not close, so it must not fire here.
      tissueStrength_pa: 4.0e7, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 1.22579, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 197400000, blowSpeed_mps: 4.04508, bodyDepth_m: 0.608935,
    },
  },
  unicorn: {
    name: 'Unicorn', faction: 'rampart', tier: 6, upgraded: false,
    attack: 15, defense: 14, damage: [18, 22], health: 90, speed: 7, reach: 'melee',
    growth: 2, cost: { gold: 850 }, aiValue: 1855, abilities: [],
    glyph: 'unicorn', tint: 0xe8e2f0, desc: 'Sacred chargers of the enchanted glades.',
    // The horn is the point of a unicorn, in both senses: 8 kg of animal behind
    // 2.5e-5 m² of ivory is the highest sectional density on the roster outside the
    // heavy cavalry. And it is the other decorrelating target — dense hide over
    // barely a quarter of itself, at a hardness where everything else is well
    // covered.
    phys: {
      blowMass_kg: 8.0, blowEnergy_j: 572, contactArea_m2: 2.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 620, density_kgpm3: 1000, armorHardness_gpa: 0.19, armorCoverage_frac: 0.28, woundEnergy_j: 2340,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.727101, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 190000000, blowSpeed_mps: 11.9583, bodyDepth_m: 0.468986,
    },
  },
  warUnicorn: {
    name: 'War Unicorn', faction: 'rampart', tier: 6, upgraded: true, upgradeOf: 'unicorn',
    attack: 15, defense: 14, damage: [18, 22], health: 110, speed: 9, reach: 'melee',
    growth: 2, cost: { gold: 950 }, aiValue: 2040, abilities: ['moraleAura'],
    glyph: 'unicorn', tint: 0xf5f0ff, desc: 'Their radiance lifts the army; +1 morale.',
    // Barded for war, but a unicorn is still mostly unicorn.
    phys: {
      blowMass_kg: 9.0, blowEnergy_j: 613.6, contactArea_m2: 2.4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 640, density_kgpm3: 1000, armorHardness_gpa: 0.24, armorCoverage_frac: 0.32, woundEnergy_j: 2860,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.742654, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 240000000, blowSpeed_mps: 11.6771, bodyDepth_m: 0.473976,
    },
  },
  greenDragon: {
    name: 'Green Dragon', faction: 'rampart', tier: 7, upgraded: false,
    attack: 18, defense: 18, damage: [40, 50], health: 180, speed: 10, reach: 'flying',
    growth: 1, cost: { gold: 2400, crystal: 1 }, aiValue: 4233, abilities: ['spellResist50'],
    glyph: 'dragon', tint: 0x5a9048, desc: 'Ancient wyrm of the deep woods; takes half damage from spells.',
    // MATCHED PAIR B, half one — the ORTHOGONAL pair, and the one that attacks the
    // "coverage predicts everything" artefact head-on rather than by removing the
    // confound. Coverage is held at 40% for both dragons and the EFFECTIVE HARDNESS
    // varies: 0.0862 GPa authored under Defense 18 lands at 0.35 GPa effective.
    // At 40% coverage the boundary hardness is near 0.6 GPa, so this sits below it.
    phys: {
      blowMass_kg: 60, blowEnergy_j: 1287, contactArea_m2: 6.0e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 3500, density_kgpm3: 900, armorHardness_gpa: 0.08621, armorCoverage_frac: 0.40, woundEnergy_j: 4680,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 2.47296, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 86210000, blowSpeed_mps: 6.54981, bodyDepth_m: 0.864911,
    },
  },
  goldDragon: {
    name: 'Gold Dragon', faction: 'rampart', tier: 7, upgraded: true, upgradeOf: 'greenDragon',
    attack: 27, defense: 27, damage: [40, 50], health: 250, speed: 16, reach: 'flying',
    growth: 1, cost: { gold: 4000, crystal: 2 }, aiValue: 7543, abilities: ['spellResist50'],
    glyph: 'goldDragon', tint: 0xf0d060,
    desc: 'Gleaming elder wyrm; takes half damage from spells.',
    // MATCHED PAIR B, half two. SAME 40% coverage, 1.00 GPa effective — above the
    // boundary where the Green Dragon is below it. Identical coverage, opposite
    // predicted signs, purely from hardness. A pure-coverage story predicts both
    // alike, so this is the direct falsification test.
    phys: {
      blowMass_kg: 70, blowEnergy_j: 1380.6, contactArea_m2: 5.6e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 4200, density_kgpm3: 900, armorHardness_gpa: 0.1789, armorCoverage_frac: 0.40, woundEnergy_j: 6500,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 2.79257, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 178900000, blowSpeed_mps: 6.28058, bodyDepth_m: 0.919105,
    },
  },

  // ======================= NECROPOLIS =======================
  // The undead legions of the crypts. Every unit carries `undead: true` — immune
  // to morale (they feel neither fear nor fervour, see CombatEngine.sideMorale)
  // and inert to a Necromancer's raise (you cannot reanimate the already-dead).
  // The tier-1 Skeleton is the very stack a Necromancer raises after victory
  // (see raiseSkeletons in core/actions.js), so it lives here as a real recruit.
  skeleton: {
    name: 'Skeleton', faction: 'necropolis', tier: 1, upgraded: false,
    attack: 5, defense: 4, damage: [1, 3], health: 6, speed: 4, reach: 'melee',
    growth: 14, cost: { gold: 60 }, aiValue: 67, abilities: [], undead: true,
    glyph: 'skeleton', tint: 0xd8d2c0, desc: 'Risen bones that feel no fear — immune to morale.',
    // Dry bone at 800 kg/m³ — the lightest body on the roster for its height,
    // and a rusted blade. Cheap to wound and cheap to field.
    phys: {
      blowMass_kg: 0.9, blowEnergy_j: 57.2, contactArea_m2: 7e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 30, density_kgpm3: 800, armorHardness_gpa: 0.15, armorCoverage_frac: 0.4, woundEnergy_j: 156,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: dry bone.
      tissueStrength_pa: 150000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.112035, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 150000000, blowSpeed_mps: 11.2744, bodyDepth_m: 0.184094,
    },
  },
  skeletonWarrior: {
    name: 'Skeleton Warrior', faction: 'necropolis', tier: 1, upgraded: true, upgradeOf: 'skeleton',
    attack: 6, defense: 6, damage: [1, 3], health: 6, speed: 5, reach: 'melee',
    growth: 14, cost: { gold: 70 }, aiValue: 93, abilities: [], undead: true,
    glyph: 'skeleton', tint: 0xe6ded0, desc: 'Drilled bone-soldiers, shield and blade; immune to morale.',
    // Grave-goods: a better blade and what armour it was buried in.
    phys: {
      blowMass_kg: 1.1, blowEnergy_j: 61.36, contactArea_m2: 6e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 32, density_kgpm3: 800, armorHardness_gpa: 0.22, armorCoverage_frac: 0.5, woundEnergy_j: 156,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: dry bone.
      tissueStrength_pa: 150000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.116961, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 220000000, blowSpeed_mps: 10.5624, bodyDepth_m: 0.188097,
    },
  },
  walkingDead: {
    name: 'Walking Dead', faction: 'necropolis', tier: 2, upgraded: false,
    attack: 5, defense: 5, damage: [2, 3], health: 15, speed: 3, reach: 'melee',
    growth: 9, cost: { gold: 100 }, aiValue: 117, abilities: [], undead: true,
    glyph: 'zombie', tint: 0x8a9470, desc: 'Shambling corpses that will not stay buried; immune to morale.',
    // A heavy, blunt, unarmoured swing. The widest contact area of its tier,
    // so it is the tier-2 body that plate answers best.
    phys: {
      blowMass_kg: 1.6, blowEnergy_j: 71.5, contactArea_m2: 1.2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 70, density_kgpm3: 1000, armorHardness_gpa: 0.05, armorCoverage_frac: 0.35, woundEnergy_j: 390,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.16985, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 50000000, blowSpeed_mps: 9.45384, bodyDepth_m: 0.226671,
    },
  },
  zombie: {
    name: 'Zombie', faction: 'necropolis', tier: 2, upgraded: true, upgradeOf: 'walkingDead',
    attack: 5, defense: 5, damage: [2, 3], health: 20, speed: 4, reach: 'melee',
    growth: 9, cost: { gold: 125 }, aiValue: 179, abilities: [], undead: true,
    glyph: 'zombie', tint: 0xa4b082, desc: 'Rotting and relentless, harder to put down; immune to morale.',
    // More of the same, and more of it.
    phys: {
      blowMass_kg: 1.8, blowEnergy_j: 76.7, contactArea_m2: 1.1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 75, density_kgpm3: 1000, armorHardness_gpa: 0.07, armorCoverage_frac: 0.4, woundEnergy_j: 520,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.177845, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 70000000, blowSpeed_mps: 9.23159, bodyDepth_m: 0.231944,
    },
  },
  wight: {
    name: 'Wight', faction: 'necropolis', tier: 3, upgraded: false,
    attack: 7, defense: 7, damage: [3, 5], health: 18, speed: 5, reach: 'flying',
    growth: 7, cost: { gold: 200 }, aiValue: 231, abilities: [], undead: true,
    glyph: 'wight', tint: 0xbcc4d0, desc: 'Grave-shades that drift over the field; immune to morale.',
    // 400 kg/m³: barely there, and a silhouette far larger than its mass —
    // the drag and area terms both read a wight as a thing that is mostly air.
    phys: {
      blowMass_kg: 1, blowEnergy_j: 114.4, contactArea_m2: 5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 40, density_kgpm3: 400, armorHardness_gpa: 0.06, armorCoverage_frac: 0.3, woundEnergy_j: 468,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: barely-there matter.
      tissueStrength_pa: 5000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.215443, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 60000000, blowSpeed_mps: 15.1261, bodyDepth_m: 0.255287,
    },
  },
  wraith: {
    name: 'Wraith', faction: 'necropolis', tier: 3, upgraded: true, upgradeOf: 'wight',
    attack: 7, defense: 7, damage: [3, 5], health: 18, speed: 7, reach: 'flying',
    growth: 7, cost: { gold: 230 }, aiValue: 323, abilities: ['manaThief'], undead: true,
    glyph: 'wight', tint: 0xd4dcea, desc: 'Siphons the enemy hero’s mana as it drifts; immune to morale.',
    // Colder and more concentrated.
    phys: {
      blowMass_kg: 1.1, blowEnergy_j: 122.72, contactArea_m2: 4.4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 42, density_kgpm3: 400, armorHardness_gpa: 0.09, armorCoverage_frac: 0.35, woundEnergy_j: 468,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: barely-there matter.
      tissueStrength_pa: 6000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.222566, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 90000000, blowSpeed_mps: 14.9374, bodyDepth_m: 0.259473,
    },
  },
  vampire: {
    name: 'Vampire', faction: 'necropolis', tier: 4, upgraded: false,
    attack: 10, defense: 9, damage: [5, 8], health: 30, speed: 6, reach: 'flying',
    growth: 5, cost: { gold: 360 }, aiValue: 544, abilities: ['noEnemyRetaliation'], undead: true,
    glyph: 'vampire', tint: 0x9a4048, desc: 'Strikes from the night; victims cannot retaliate; immune to morale.',
    // A narrow strike — claw and tooth through a very small area, which is
    // what makes it the tier-4 answer to an armoured line.
    phys: {
      blowMass_kg: 1.2, blowEnergy_j: 185.9, contactArea_m2: 3e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 70, density_kgpm3: 1010, armorHardness_gpa: 0.12, armorCoverage_frac: 0.45, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.168727, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 120000000, blowSpeed_mps: 17.6021, bodyDepth_m: 0.22592,
    },
  },
  vampireLord: {
    name: 'Vampire Lord', faction: 'necropolis', tier: 4, upgraded: true, upgradeOf: 'vampire',
    attack: 10, defense: 10, damage: [5, 8], health: 40, speed: 9, reach: 'flying',
    growth: 5, cost: { gold: 500 }, aiValue: 1092, abilities: ['noEnemyRetaliation', 'lifeDrain'], undead: true,
    glyph: 'vampire', tint: 0xb85058, desc: 'Drains the life of the living to mend its own ranks; no reprisal; immune to morale.',
    // Narrower again.
    phys: {
      blowMass_kg: 1.4, blowEnergy_j: 199.42, contactArea_m2: 2.6e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 75, density_kgpm3: 1010, armorHardness_gpa: 0.18, armorCoverage_frac: 0.5, woundEnergy_j: 1040,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.176669, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 180000000, blowSpeed_mps: 16.8786, bodyDepth_m: 0.231176,
    },
  },
  lich: {
    name: 'Lich', faction: 'necropolis', tier: 5, upgraded: false,
    attack: 13, defense: 10, damage: [11, 13], health: 30, speed: 6, reach: 'ranged', shots: 12,
    growth: 3, cost: { gold: 550 }, aiValue: 705, abilities: ['areaBlast'], undead: true,
    glyph: 'lich', tint: 0x7a8c66, desc: 'Hurls death-clouds that splash onto adjacent stacks; immune to morale.',
    // A cast blast rather than a shot: 400 g of it, spread wide. The area is
    // the largest of any ranged attack on the roster, which is the model's way of
    // saying the thing that makes a lich frightening is not penetration.
    phys: {
      blowMass_kg: 0.4, blowEnergy_j: 343.2, contactArea_m2: 9e-5, dispersion_rad: 0.028, ballisticCoeff_kgpm2: 1500,
      bodyMass_kg: 60, density_kgpm3: 950, armorHardness_gpa: 0.08, armorCoverage_frac: 0.3, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.158593, velRetainPerHex_ratio: 0.998775, armorHardness_pa: 80000000, blowSpeed_mps: 41.4246, bodyDepth_m: 0.219031,
    },
  },
  powerLich: {
    name: 'Power Lich', faction: 'necropolis', tier: 5, upgraded: true, upgradeOf: 'lich',
    attack: 13, defense: 10, damage: [11, 15], health: 40, speed: 7, reach: 'ranged', shots: 24,
    growth: 3, cost: { gold: 650 }, aiValue: 876, abilities: ['areaBlast'], undead: true,
    glyph: 'lich', tint: 0x96a880, desc: 'Greater death-clouds and deeper ammunition; immune to morale.',
    // Heavier, tighter, and carrying further.
    phys: {
      blowMass_kg: 0.45, blowEnergy_j: 398.84, contactArea_m2: 8e-5, dispersion_rad: 0.022, ballisticCoeff_kgpm2: 1700,
      bodyMass_kg: 62, density_kgpm3: 950, armorHardness_gpa: 0.12, armorCoverage_frac: 0.35, woundEnergy_j: 1040,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.162098, velRetainPerHex_ratio: 0.998919, armorHardness_pa: 120000000, blowSpeed_mps: 42.1025, bodyDepth_m: 0.221438,
    },
  },
  blackKnight: {
    name: 'Black Knight', faction: 'necropolis', tier: 6, upgraded: false,
    attack: 16, defense: 16, damage: [15, 30], health: 120, speed: 7, reach: 'melee',
    growth: 2, cost: { gold: 1200 }, aiValue: 2372, abilities: [], undead: true,
    glyph: 'blackKnight', tint: 0x4a4652, desc: 'Dread cavalry risen from the crypts; immune to morale.',
    // Plate and a heavy sword, mounted — the Castle Champion's numbers seen
    // from the other side of the grave, and deliberately close to them.
    phys: {
      blowMass_kg: 9, blowEnergy_j: 643.5, contactArea_m2: 4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 700, density_kgpm3: 1010, armorHardness_gpa: 0.5, armorCoverage_frac: 0.75, woundEnergy_j: 3120,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.783161, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 500000000, blowSpeed_mps: 11.9583, bodyDepth_m: 0.48673,
    },
  },
  dreadKnight: {
    name: 'Dread Knight', faction: 'necropolis', tier: 6, upgraded: true, upgradeOf: 'blackKnight',
    attack: 18, defense: 18, damage: [15, 30], health: 120, speed: 9, reach: 'melee',
    growth: 2, cost: { gold: 1500 }, aiValue: 3269, abilities: ['doubleAttack'], undead: true,
    glyph: 'blackKnight', tint: 0x625c70, desc: 'A death-dealing blow that strikes twice; immune to morale.',
    // Better plate, better steel.
    phys: {
      blowMass_kg: 10, blowEnergy_j: 690.3, contactArea_m2: 3.6e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 720, density_kgpm3: 1010, armorHardness_gpa: 0.6, armorCoverage_frac: 0.8, woundEnergy_j: 3120,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.798008, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 600000000, blowSpeed_mps: 11.7499, bodyDepth_m: 0.491322,
    },
  },
  boneDragon: {
    name: 'Bone Dragon', faction: 'necropolis', tier: 7, upgraded: false,
    attack: 17, defense: 15, damage: [25, 50], health: 150, speed: 9, reach: 'flying',
    growth: 1, cost: { gold: 1800, sulfur: 1 }, aiValue: 3360, abilities: ['curseAura'], undead: true,
    glyph: 'boneDragon', tint: 0xc8c2ae, desc: 'A skeletal wyrm whose presence saps enemy luck; immune to morale.',
    // Hollow bones at 500 kg/m³ — half the density of the living dragons it
    // is drawn from, and a body with nothing much left to armour.
    phys: {
      blowMass_kg: 45, blowEnergy_j: 1072.5, contactArea_m2: 4.5e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 1600, density_kgpm3: 500, armorHardness_gpa: 0.12, armorCoverage_frac: 0.45, woundEnergy_j: 3900,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: hollow bone.
      tissueStrength_pa: 120000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 2.17153, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 120000000, blowSpeed_mps: 6.90411, bodyDepth_m: 0.810487,
    },
  },
  ghostDragon: {
    name: 'Ghost Dragon', faction: 'necropolis', tier: 7, upgraded: true, upgradeOf: 'boneDragon',
    attack: 19, defense: 17, damage: [25, 50], health: 200, speed: 14, reach: 'flying',
    growth: 1, cost: { gold: 3000, mercury: 2 }, aiValue: 4166, abilities: ['curseAura'], undead: true,
    glyph: 'boneDragon', tint: 0xb4c0c4, desc: 'An ethereal wyrm draped in grave-mist; saps enemy luck; immune to morale.',
    // Larger, and what is left of it is harder to touch.
    phys: {
      blowMass_kg: 50, blowEnergy_j: 1150.5, contactArea_m2: 4e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 1800, density_kgpm3: 500, armorHardness_gpa: 0.2, armorCoverage_frac: 0.5, woundEnergy_j: 5200,
      // Outside the flesh band, so it states its own resistance instead of
      // defaulting to meat, and whether a wide cut can bleed it: hollow bone, half-there.
      tissueStrength_pa: 80000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 2.34892, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 200000000, blowSpeed_mps: 6.7838, bodyDepth_m: 0.84294,
    },
  },

  // ======================= DUNGEON =======================
  // Warlocks of the deep caverns and the beasts they master. Fast raiders,
  // serpent-haired archers, and the dragons of the abyss — crowned by the Black
  // Dragon, whose scales shrug off all magic (the `spellImmune` ability).
  // The tier-4 Medusa is re-homed from the neutral pool (its stone-fletched
  // arrows were always a Dungeon signature), gaining an upgraded Medusa Queen.
  troglodyte: {
    name: 'Troglodyte', faction: 'dungeon', tier: 1, upgraded: false,
    attack: 4, defense: 3, damage: [1, 3], health: 5, speed: 4, reach: 'melee',
    growth: 14, cost: { gold: 50 }, aiValue: 59, abilities: [],
    glyph: 'troglodyte', tint: 0x9a8fa8, desc: 'Blind cave-dwellers that swarm the deeps.',
    // A club, and the entry is really about the contact area: 1.5 cm² is enormous
    // beside a fang or a bodkin, and 57 J spread that thin stops at anything
    // properly armoured. Troglodytes are a stack, not a blow.
    phys: {
      blowMass_kg: 1, blowEnergy_j: 57.2, contactArea_m2: 1.5e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 45, density_kgpm3: 1010, armorHardness_gpa: 0.04, armorCoverage_frac: 0.25, woundEnergy_j: 130,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.125678, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 40000000, blowSpeed_mps: 10.6958, bodyDepth_m: 0.194981,
    },
  },
  infernalTroglodyte: {
    name: 'Infernal Troglodyte', faction: 'dungeon', tier: 1, upgraded: true, upgradeOf: 'troglodyte',
    attack: 5, defense: 4, damage: [1, 3], health: 6, speed: 5, reach: 'melee',
    growth: 14, cost: { gold: 65 }, aiValue: 88, abilities: [],
    glyph: 'troglodyte', tint: 0xb85a4a, desc: 'Hardier troglodytes seared by the lower fires.',
    // Seared hide and a better-shaped club: heavier, and it lands on less.
    phys: {
      blowMass_kg: 1.1, blowEnergy_j: 61.36, contactArea_m2: 1.3e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 50, density_kgpm3: 1010, armorHardness_gpa: 0.05, armorCoverage_frac: 0.28, woundEnergy_j: 156,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.134824, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 50000000, blowSpeed_mps: 10.5624, bodyDepth_m: 0.201951,
    },
  },
  harpy: {
    name: 'Harpy', faction: 'dungeon', tier: 2, upgraded: false,
    attack: 6, defense: 5, damage: [1, 4], health: 14, speed: 6, reach: 'flying',
    growth: 8, cost: { gold: 130 }, aiValue: 131, abilities: [],
    glyph: 'harpy', tint: 0x9088b0, desc: 'Shrieking winged raiders of the cliffs.',
    // Hollow-boned, so 900 kg/m³ — light for its size, and still inside the flesh
    // band, so it does not have to state its own tissue. Talons: half a kilogram
    // onto a quarter of a square centimetre, and almost nothing worn.
    phys: {
      blowMass_kg: 0.5, blowEnergy_j: 71.5, contactArea_m2: 2.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 60, density_kgpm3: 900, armorHardness_gpa: 0.02, armorCoverage_frac: 0.12, woundEnergy_j: 364,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.164414, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 20000000, blowSpeed_mps: 16.9115, bodyDepth_m: 0.223014,
    },
  },
  harpyHag: {
    name: 'Harpy Hag', faction: 'dungeon', tier: 2, upgraded: true, upgradeOf: 'harpy',
    attack: 6, defense: 6, damage: [1, 4], health: 14, speed: 9, reach: 'flying',
    growth: 8, cost: { gold: 170 }, aiValue: 299, abilities: ['noEnemyRetaliation'],
    glyph: 'harpy', tint: 0xb0a8d0, desc: 'Strikes and wheels away before any reprisal.',
    // Longer talons on the same light frame — the dive carries more and puts it
    // through less.
    phys: {
      blowMass_kg: 0.55, blowEnergy_j: 76.7, contactArea_m2: 2.2e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 62, density_kgpm3: 900, armorHardness_gpa: 0.03, armorCoverage_frac: 0.15, woundEnergy_j: 364,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.168048, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 30000000, blowSpeed_mps: 16.7006, bodyDepth_m: 0.225465,
    },
  },
  beholder: {
    name: 'Beholder', faction: 'dungeon', tier: 3, upgraded: false,
    attack: 9, defense: 7, damage: [3, 5], health: 22, speed: 5, reach: 'ranged', shots: 12,
    growth: 7, cost: { gold: 200 }, aiValue: 293, abilities: [],
    glyph: 'beholder', tint: 0x8a6aa0, desc: 'A floating eye that blasts from afar.',
    // A bolt of force still has to be priced as a thing that ARRIVES: 200 g at
    // 34 m/s, with a low sectional density, so distance costs it more than it
    // costs an arrow. The mass also puts it clear of the arrow envelope
    // (`isArrow`, ≤150 g) on purpose — a gaze is not a shaft, and running FOC and
    // head-diameter bounds on it would be asking where a beam balances.
    phys: {
      blowMass_kg: 0.2, blowEnergy_j: 114.4, contactArea_m2: 3e-5, dispersion_rad: 0.028, ballisticCoeff_kgpm2: 1000,
      bodyMass_kg: 90, density_kgpm3: 1010, armorHardness_gpa: 0.08, armorCoverage_frac: 0.35, woundEnergy_j: 572,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.199502, velRetainPerHex_ratio: 0.998164, armorHardness_pa: 80000000, blowSpeed_mps: 33.8231, bodyDepth_m: 0.245661,
    },
  },
  evilEye: {
    name: 'Evil Eye', faction: 'dungeon', tier: 3, upgraded: true, upgradeOf: 'beholder',
    attack: 10, defense: 7, damage: [3, 5], health: 22, speed: 7, reach: 'ranged', shots: 24,
    growth: 7, cost: { gold: 250 }, aiValue: 312, abilities: [],
    glyph: 'beholder', tint: 0xa888c0, desc: 'Its baleful gaze reaches farther and deeper.',
    // "Farther and deeper" said in the model's own units: a fifth off the group
    // and a tenth onto the bolt, through a narrower point.
    phys: {
      blowMass_kg: 0.21, blowEnergy_j: 122.72, contactArea_m2: 2.7e-5, dispersion_rad: 0.022, ballisticCoeff_kgpm2: 1000,
      bodyMass_kg: 92, density_kgpm3: 1010, armorHardness_gpa: 0.1, armorCoverage_frac: 0.38, woundEnergy_j: 572,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.202447, velRetainPerHex_ratio: 0.998164, armorHardness_pa: 100000000, blowSpeed_mps: 34.1872, bodyDepth_m: 0.247468,
    },
  },
  medusa: {
    name: 'Medusa', faction: 'dungeon', tier: 4, upgraded: false,
    attack: 9, defense: 9, damage: [6, 8], health: 25, speed: 5, reach: 'ranged', shots: 4,
    growth: 5, cost: { gold: 550 }, aiValue: 443, abilities: [],
    glyph: 'medusa', tint: 0x8fb090, desc: 'Serpent-haired archers who loose their volleys from afar.',
    // The only true BOW in the Dungeon, and the one place in this faction where
    // PHYS_BOUNDS binds: a 60 g shaft behind a stone bodkin. 124 J delivered is
    // 157 J stored, and a bow may store 175 — so the medusa lands at 0.68x her
    // classic tuple rather than the 1.1x the rest of the faction runs at. That is
    // the model saying a bow is a bow. Wood Elves and Grand Elves already sit at
    // 0.87x for exactly this reason; four shots is what makes her a sniper.
    phys: {
      blowMass_kg: 0.06, blowEnergy_j: 134.387, contactArea_m2: 1.8e-5, dispersion_rad: 0.02, ballisticCoeff_kgpm2: 900,
      bodyMass_kg: 110, density_kgpm3: 1010, armorHardness_gpa: 0.12, armorCoverage_frac: 0.45, woundEnergy_j: 650,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.228059, velRetainPerHex_ratio: 0.99796, armorHardness_pa: 120000000, blowSpeed_mps: 66.9296, bodyDepth_m: 0.262655,
    },
  },
  medusaQueen: {
    name: 'Medusa Queen', faction: 'dungeon', tier: 4, upgraded: true, upgradeOf: 'medusa',
    attack: 10, defense: 10, damage: [6, 8], health: 30, speed: 6, reach: 'ranged', shots: 4,
    growth: 5, cost: { gold: 600 }, aiValue: 490, abilities: [],
    glyph: 'medusa', tint: 0xa8d0a8, desc: 'Sovereign gorgons whose volleys never miss their mark.',
    // "Never miss" is a 16-milliradian group, not a zero one — the coherence rule
    // will not let a shooter own a group of nothing, and a queen who cannot miss
    // would be a shooter for whom range had stopped existing.
    phys: {
      blowMass_kg: 0.062, blowEnergy_j: 135.302, contactArea_m2: 1.6e-5, dispersion_rad: 0.016, ballisticCoeff_kgpm2: 900,
      bodyMass_kg: 120, density_kgpm3: 1010, armorHardness_gpa: 0.15, armorCoverage_frac: 0.48, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.24168, velRetainPerHex_ratio: 0.99796, armorHardness_pa: 150000000, blowSpeed_mps: 66.065, bodyDepth_m: 0.270385,
    },
  },
  minotaur: {
    name: 'Minotaur', faction: 'dungeon', tier: 5, upgraded: false,
    attack: 14, defense: 12, damage: [12, 20], health: 50, speed: 6, reach: 'melee',
    growth: 3, cost: { gold: 500, sulfur: 1 }, aiValue: 798, abilities: [],
    glyph: 'minotaur', tint: 0x8a6a4a, desc: 'Axe-wielding bull-warriors of the labyrinth.',
    // A great axe in both hands: eight kilograms and 458 J, the heaviest blow
    // below tier 7. Both hands on the haft is also why the coverage stops at a
    // half — there is no shield anywhere in this entry.
    phys: {
      blowMass_kg: 8, blowEnergy_j: 457.6, contactArea_m2: 1.8e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 450, density_kgpm3: 1010, armorHardness_gpa: 0.28, armorCoverage_frac: 0.5, woundEnergy_j: 1300,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.583348, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 280000000, blowSpeed_mps: 10.6958, bodyDepth_m: 0.420075,
    },
  },
  minotaurKing: {
    name: 'Minotaur King', faction: 'dungeon', tier: 5, upgraded: true, upgradeOf: 'minotaur',
    attack: 15, defense: 15, damage: [12, 20], health: 50, speed: 8, reach: 'melee',
    growth: 3, cost: { gold: 575, sulfur: 1 }, aiValue: 1100, abilities: ['moraleAura'],
    glyph: 'minotaur', tint: 0xa8895a, desc: 'Their steadfast command lifts the army; +1 morale.',
    // A king's axe and a king's harness: more behind the swing, onto a keener
    // bit, over more of him.
    phys: {
      blowMass_kg: 8.5, blowEnergy_j: 490.88, contactArea_m2: 1.6e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 480, density_kgpm3: 1010, armorHardness_gpa: 0.33, armorCoverage_frac: 0.55, woundEnergy_j: 1300,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.608994, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 330000000, blowSpeed_mps: 10.7471, bodyDepth_m: 0.429209,
    },
  },
  manticore: {
    name: 'Manticore', faction: 'dungeon', tier: 6, upgraded: false,
    attack: 15, defense: 13, damage: [14, 20], health: 80, speed: 7, reach: 'flying',
    growth: 2, cost: { gold: 850 }, aiValue: 1414, abilities: [],
    glyph: 'manticore', tint: 0xa85838, desc: 'Lion-bodied horrors with a barbed, lashing tail.',
    // The tail, not the claws. Three kilograms arriving on 0.4 cm² makes a tier-6
    // creature that fights like a tier-2 one — all pressure, moderate energy —
    // and it is the sting that decides which armour it is actually good against.
    phys: {
      blowMass_kg: 3, blowEnergy_j: 486.2, contactArea_m2: 4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 500, density_kgpm3: 1010, armorHardness_gpa: 0.15, armorCoverage_frac: 0.4, woundEnergy_j: 2080,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.625795, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 150000000, blowSpeed_mps: 18.0037, bodyDepth_m: 0.43509,
    },
  },
  scorpicore: {
    name: 'Scorpicore', faction: 'dungeon', tier: 6, upgraded: true, upgradeOf: 'manticore',
    attack: 16, defense: 14, damage: [14, 20], health: 80, speed: 11, reach: 'flying',
    growth: 2, cost: { gold: 1050 }, aiValue: 2125, abilities: ['noEnemyRetaliation'],
    glyph: 'manticore', tint: 0xc87848, desc: 'A paralysing sting; its victims cannot retaliate.',
    // A finer barb driving a heavier tail: the same shape of blow, further along
    // its own axis.
    phys: {
      blowMass_kg: 3.2, blowEnergy_j: 521.56, contactArea_m2: 3.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 520, density_kgpm3: 1010, armorHardness_gpa: 0.18, armorCoverage_frac: 0.44, woundEnergy_j: 2080,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.642374, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 180000000, blowSpeed_mps: 18.0548, bodyDepth_m: 0.440815,
    },
  },
  redDragon: {
    name: 'Red Dragon', faction: 'dungeon', tier: 7, upgraded: false,
    attack: 19, defense: 19, damage: [40, 50], health: 180, speed: 11, reach: 'flying',
    growth: 1, cost: { gold: 2400, sulfur: 1 }, aiValue: 4145, abilities: ['spellResist50'],
    glyph: 'dragon', tint: 0xc0402a, desc: 'Abyssal wyrm; takes half damage from spells.',
    // Three tonnes, and the blow IS the animal: 25 kg of jaw and claw at 10 m/s.
    // Scale at 0.55 GPa over 70% is the hardest hide on anything with blood in
    // it — a dragon is the target the whole rigidity curve was drawn against.
    phys: {
      blowMass_kg: 25, blowEnergy_j: 1287, contactArea_m2: 2.5e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 3000, density_kgpm3: 1010, armorHardness_gpa: 0.55, armorCoverage_frac: 0.7, woundEnergy_j: 4680,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 2.06633, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 550000000, blowSpeed_mps: 10.1469, bodyDepth_m: 0.790611,
    },
  },
  blackDragon: {
    name: 'Black Dragon', faction: 'dungeon', tier: 7, upgraded: true, upgradeOf: 'redDragon',
    attack: 25, defense: 25, damage: [40, 50], health: 300, speed: 15, reach: 'flying',
    growth: 1, cost: { gold: 4000, sulfur: 2 }, aiValue: 12944, abilities: ['spellImmune', 'noEnemyRetaliation'],
    glyph: 'dragon', tint: 0x3a3444, desc: 'Immune to all magic; victims cannot retaliate.',
    // 0.72 GPa over three quarters of it: harder than any other flesh-bodied
    // creature and beaten only by carved stone and the golems. Spell immunity
    // means the physical answer is the ONLY answer, which is a lot of weight for
    // one armour figure to carry — so it sits below the golems on purpose.
    phys: {
      blowMass_kg: 28, blowEnergy_j: 1380.6, contactArea_m2: 2.2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 3300, density_kgpm3: 1010, armorHardness_gpa: 0.72, armorCoverage_frac: 0.75, woundEnergy_j: 7800,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 2.20189, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 720000000, blowSpeed_mps: 9.93047, bodyDepth_m: 0.816132,
    },
  },

  // ======================= STRONGHOLD =======================
  // The barbarian hordes of the wastelands — cheap, fast and brutally
  // aggressive, crowned by the Behemoth whose blows rend through armour
  // (the `ignoreDefense` ability, magnitude from `defenseIgnore`).
  // The tier-6 Cyclops is re-homed from the neutral pool (a barbarian
  // war-beast at heart), gaining an upgraded Cyclops King.
  goblin: {
    name: 'Goblin', faction: 'stronghold', tier: 1, upgraded: false,
    attack: 4, defense: 2, damage: [1, 2], health: 5, speed: 5, reach: 'melee',
    growth: 15, cost: { gold: 40 }, aiValue: 56, abilities: [],
    glyph: 'goblin', tint: 0x8a9a4a, desc: 'Screeching wasteland runts that swarm in numbers.',
    // A sharpened stick and forty joules. Tier 1 is where this model has least to
    // say, and a goblin is the version of that with a rag on it.
    phys: {
      blowMass_kg: 0.8, blowEnergy_j: 42.9, contactArea_m2: 8e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 45, density_kgpm3: 1010, armorHardness_gpa: 0.03, armorCoverage_frac: 0.18, woundEnergy_j: 130,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.125678, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 30000000, blowSpeed_mps: 10.3562, bodyDepth_m: 0.194981,
    },
  },
  hobgoblin: {
    name: 'Hobgoblin', faction: 'stronghold', tier: 1, upgraded: true, upgradeOf: 'goblin',
    attack: 5, defense: 3, damage: [1, 2], health: 5, speed: 7, reach: 'melee',
    growth: 15, cost: { gold: 50 }, aiValue: 80, abilities: [],
    glyph: 'goblin', tint: 0xa8b85a, desc: 'Meaner, faster goblins driven to the front.',
    // Driven to the front means better fed and better armed, which is all the
    // difference there is: a slightly heavier point through slightly less of it.
    phys: {
      blowMass_kg: 0.85, blowEnergy_j: 46.02, contactArea_m2: 7e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 48, density_kgpm3: 1010, armorHardness_gpa: 0.04, armorCoverage_frac: 0.22, woundEnergy_j: 130,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.131204, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 40000000, blowSpeed_mps: 10.4059, bodyDepth_m: 0.199221,
    },
  },
  wolfRider: {
    name: 'Wolf Rider', faction: 'stronghold', tier: 2, upgraded: false,
    attack: 7, defense: 5, damage: [2, 4], health: 10, speed: 6, reach: 'melee',
    growth: 9, cost: { gold: 100 }, aiValue: 118, abilities: [],
    glyph: 'wolfRider', tint: 0x9a7a52, desc: 'Goblins mounted on savage wasteland wolves.',
    // The rider swings; the wolf carries. `bodyMass_kg` is the pair, which is why
    // a tier-2 unit has a tier-4 silhouette and 10 hit points behind it — a big
    // target that dies quickly is a real shape and the model can hold it.
    phys: {
      blowMass_kg: 1.2, blowEnergy_j: 85.8, contactArea_m2: 1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 120, density_kgpm3: 1010, armorHardness_gpa: 0.06, armorCoverage_frac: 0.25, woundEnergy_j: 260,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.24168, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 60000000, blowSpeed_mps: 11.9583, bodyDepth_m: 0.270385,
    },
  },
  wolfRaider: {
    name: 'Wolf Raider', faction: 'stronghold', tier: 2, upgraded: true, upgradeOf: 'wolfRider',
    attack: 8, defense: 5, damage: [3, 4], health: 10, speed: 8, reach: 'melee',
    growth: 9, cost: { gold: 140 }, aiValue: 224, abilities: ['doubleAttack'],
    glyph: 'wolfRider', tint: 0xb89460, desc: 'Twin-blade riders who strike twice in a pass.',
    // Two blades is a rate, not a blow, so the second one lives in the classic
    // tuple and this entry only says what ONE of them does: more behind it,
    // through less of it.
    phys: {
      blowMass_kg: 1.3, blowEnergy_j: 107.38, contactArea_m2: 9e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 125, density_kgpm3: 1010, armorHardness_gpa: 0.08, armorCoverage_frac: 0.28, woundEnergy_j: 260,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.248347, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 80000000, blowSpeed_mps: 12.853, bodyDepth_m: 0.274089,
    },
  },
  orc: {
    name: 'Orc', faction: 'stronghold', tier: 3, upgraded: false,
    attack: 8, defense: 4, damage: [2, 5], health: 15, speed: 4, reach: 'ranged', shots: 12,
    growth: 7, cost: { gold: 150 }, aiValue: 209, abilities: [],
    glyph: 'orc', tint: 0x6f8f4a, desc: 'Broad-shouldered brutes hurling javelins.',
    // A REAL ARROW by the model's definition — 55 g with a shot group — so
    // PHYS_BOUNDS applies here and to every pair of nodes above it. 100 J
    // delivered is 129 J stored, comfortably inside a bow's 40–175 J, which is
    // what leaves the branch room to grow.
    phys: {
      blowMass_kg: 0.055, blowEnergy_j: 100.1, contactArea_m2: 2e-5, dispersion_rad: 0.03, ballisticCoeff_kgpm2: 1100,
      bodyMass_kg: 85, density_kgpm3: 1010, armorHardness_gpa: 0.07, armorCoverage_frac: 0.3, woundEnergy_j: 390,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.192043, velRetainPerHex_ratio: 0.99833, armorHardness_pa: 70000000, blowSpeed_mps: 60.3324, bodyDepth_m: 0.241025,
    },
  },
  orcChieftain: {
    name: 'Orc Chieftain', faction: 'stronghold', tier: 3, upgraded: true, upgradeOf: 'orc',
    attack: 8, defense: 4, damage: [2, 5], health: 20, speed: 5, reach: 'ranged', shots: 24,
    growth: 7, cost: { gold: 165 }, aiValue: 241, abilities: [],
    glyph: 'orc', tint: 0x8aab5e, desc: 'War-leaders with deeper stores of javelins.',
    // A war-leader's arm and a war-leader's practice: more on the shaft, a fifth
    // off the group. The five extra hit points cost 130 more joules at the same
    // 26 J apiece, so the pair is made of the same stuff.
    phys: {
      blowMass_kg: 0.058, blowEnergy_j: 107.38, contactArea_m2: 1.8e-5, dispersion_rad: 0.024, ballisticCoeff_kgpm2: 1100,
      bodyMass_kg: 90, density_kgpm3: 1010, armorHardness_gpa: 0.09, armorCoverage_frac: 0.34, woundEnergy_j: 520,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.199502, velRetainPerHex_ratio: 0.99833, armorHardness_pa: 90000000, blowSpeed_mps: 60.8503, bodyDepth_m: 0.245661,
    },
  },
  ogre: {
    name: 'Ogre', faction: 'stronghold', tier: 4, upgraded: false,
    attack: 13, defense: 7, damage: [6, 12], health: 40, speed: 4, reach: 'melee',
    growth: 4, cost: { gold: 300 }, aiValue: 490, abilities: [],
    glyph: 'ogre', tint: 0x7a8a5a, desc: 'Lumbering club-swingers of colossal strength.',
    // Twelve kilograms of tree through 3 cm² of nothing sharp. The Giant's lesson
    // one tier down: enormous energy and almost no pressure are different
    // quantities, and an ogre is what the game looks like when you only have one.
    phys: {
      blowMass_kg: 12, blowEnergy_j: 257.4, contactArea_m2: 3e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 400, density_kgpm3: 1010, armorHardness_gpa: 0.12, armorCoverage_frac: 0.3, woundEnergy_j: 1040,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.539294, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 120000000, blowSpeed_mps: 6.54981, bodyDepth_m: 0.403902,
    },
  },
  ogreMage: {
    name: 'Ogre Mage', faction: 'stronghold', tier: 4, upgraded: true, upgradeOf: 'ogre',
    attack: 13, defense: 7, damage: [6, 12], health: 60, speed: 5, reach: 'melee',
    growth: 4, cost: { gold: 400 }, aiValue: 757, abilities: [],
    glyph: 'ogre', tint: 0x9aa86a, desc: 'Ogres steeped in crude battle-magic; hardier and swifter.',
    // Fifty percent more ogre. The twenty extra hit points are 520 more joules to
    // work through, which is where "hardier" actually lives — the club barely
    // changes.
    phys: {
      blowMass_kg: 13, blowEnergy_j: 276.12, contactArea_m2: 2.6e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 450, density_kgpm3: 1010, armorHardness_gpa: 0.15, armorCoverage_frac: 0.34, woundEnergy_j: 1560,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.583348, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 150000000, blowSpeed_mps: 6.51767, bodyDepth_m: 0.420075,
    },
  },
  roc: {
    name: 'Roc', faction: 'stronghold', tier: 5, upgraded: false,
    attack: 13, defense: 11, damage: [11, 15], health: 60, speed: 7, reach: 'flying',
    growth: 3, cost: { gold: 600 }, aiValue: 806, abilities: [],
    glyph: 'roc', tint: 0x9a6a3a, desc: 'Giant raptors of the crag-peaks.',
    // Hollow-boned at 900 kg/m³ — still flesh, so it does not state its own
    // tissue — and it fights with talons, so four kilograms arrive on half a
    // square centimetre. High pressure, moderate energy, nothing worn.
    phys: {
      blowMass_kg: 4, blowEnergy_j: 371.8, contactArea_m2: 4.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 350, density_kgpm3: 900, armorHardness_gpa: 0.1, armorCoverage_frac: 0.3, woundEnergy_j: 1560,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.532783, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 100000000, blowSpeed_mps: 13.6345, bodyDepth_m: 0.401456,
    },
  },
  thunderbird: {
    name: 'Thunderbird', faction: 'stronghold', tier: 5, upgraded: true, upgradeOf: 'roc',
    attack: 13, defense: 11, damage: [11, 15], health: 60, speed: 11, reach: 'flying',
    growth: 3, cost: { gold: 700 }, aiValue: 1005, abilities: ['moraleAura'],
    glyph: 'roc', tint: 0xc0902a, desc: 'Storm-winged rocs whose cry heartens the horde; +1 morale.',
    // The morale aura is a battle effect and lives there. What this entry says is
    // narrower: a heavier stoop onto a finer talon, over a better-feathered back.
    phys: {
      blowMass_kg: 4.3, blowEnergy_j: 398.84, contactArea_m2: 4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 360, density_kgpm3: 900, armorHardness_gpa: 0.13, armorCoverage_frac: 0.34, woundEnergy_j: 1560,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.542884, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 130000000, blowSpeed_mps: 13.6201, bodyDepth_m: 0.405243,
    },
  },
  cyclops: {
    name: 'Cyclops', faction: 'stronghold', tier: 6, upgraded: false,
    attack: 15, defense: 12, damage: [16, 20], health: 70, speed: 6, reach: 'ranged', shots: 16,
    growth: 2, cost: { gold: 750, crystal: 1 }, aiValue: 1339, abilities: ['areaBlast'],
    glyph: 'cyclops', tint: 0x9c7a4c, desc: 'Hurls boulders that splash on impact.',
    // THE ROSTER'S ONE TRUE SIEGE ENGINE — nine kilograms of rock across 6 cm²,
    // the lowest impact pressure of any shooter in the game and by far the most
    // momentum, which is why it splashes rather than punctures. 50 milliradians is
    // the widest group authored, and it should be: nobody aims a boulder.
    //
    // FIRST AUTHORED AT 20 kg ON 40 cm², AND THE MASS-NICHE INVARIANT REFUSED IT.
    // At that sectional density the boulder sits so far past the rigidity clamp
    // that adding 40% more rock buys a measurable gain against ZERO of 113 authored
    // targets — mass is not a lever there, it is already the whole weapon. That is
    // a real physical statement and it is also unplayable content: a Cyclops Cave
    // could never sell a heavier boulder. Nine kilograms on 6 cm² is still
    // unmistakably a thrown rock and puts the niche back on the Stone Golem with
    // seven targets it pays against. The test was written to catch a mistuned
    // constant and caught mis-authored content instead, which is the better outcome.
    phys: {
      blowMass_kg: 9, blowEnergy_j: 514.8, contactArea_m2: 6e-4, dispersion_rad: 0.05, ballisticCoeff_kgpm2: 4000,
      bodyMass_kg: 900, density_kgpm3: 1010, armorHardness_gpa: 0.14, armorCoverage_frac: 0.35, woundEnergy_j: 1820,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.926007, velRetainPerHex_ratio: 0.999541, armorHardness_pa: 140000000, blowSpeed_mps: 10.6958, bodyDepth_m: 0.529261,
    },
  },
  cyclopsKing: {
    name: 'Cyclops King', faction: 'stronghold', tier: 6, upgraded: true, upgradeOf: 'cyclops',
    attack: 17, defense: 13, damage: [16, 20], health: 80, speed: 8, reach: 'ranged', shots: 24,
    growth: 2, cost: { gold: 1100, crystal: 1 }, aiValue: 1378, abilities: ['areaBlast'],
    glyph: 'cyclops', tint: 0xc0985a, desc: 'War-chief cyclops; heavier boulders, deeper stores.',
    // "Heavier boulders" said in the units the desc already promises: two more
    // kilograms of rock, a tighter throw, and enough more energy to carry it.
    phys: {
      blowMass_kg: 10, blowEnergy_j: 552.24, contactArea_m2: 5.4e-4, dispersion_rad: 0.04, ballisticCoeff_kgpm2: 4000,
      bodyMass_kg: 950, density_kgpm3: 1010, armorHardness_gpa: 0.18, armorCoverage_frac: 0.4, woundEnergy_j: 2080,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.959993, velRetainPerHex_ratio: 0.999541, armorHardness_pa: 180000000, blowSpeed_mps: 10.5094, bodyDepth_m: 0.538886,
    },
  },
  behemoth: {
    name: 'Behemoth', faction: 'stronghold', tier: 7, upgraded: false,
    attack: 19, defense: 19, damage: [30, 50], health: 160, speed: 6, reach: 'melee',
    growth: 1, cost: { gold: 1500 }, aiValue: 4811, abilities: ['ignoreDefense'], defenseIgnore: 0.4,
    glyph: 'behemoth', tint: 0x8a6a48, desc: 'Titanic brutes that ignore 40% of a foe’s defense.',
    // The defense-ignoring ability and the physics say the same thing twice, which
    // is the nice case: thirty kilograms of forelimb landing on 1.4 cm² of claw is
    // both enormous energy and enormous pressure, and there is no armour figure in
    // the game that is a good answer to both at once.
    phys: {
      blowMass_kg: 30, blowEnergy_j: 1144, contactArea_m2: 1.4e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 2500, density_kgpm3: 1010, armorHardness_gpa: 0.4, armorCoverage_frac: 0.55, woundEnergy_j: 4160,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 1.82984, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 400000000, blowSpeed_mps: 8.73308, bodyDepth_m: 0.743993,
    },
  },
  ancientBehemoth: {
    name: 'Ancient Behemoth', faction: 'stronghold', tier: 7, upgraded: true, upgradeOf: 'behemoth',
    attack: 19, defense: 19, damage: [30, 50], health: 300, speed: 9, reach: 'melee',
    growth: 1, cost: { gold: 3000, crystal: 2 }, aiValue: 7313, abilities: ['ignoreDefense'], defenseIgnore: 0.8,
    glyph: 'behemoth', tint: 0xb08858, desc: 'Elder behemoths that ignore 80% of a foe’s defense.',
    // Nearly twice the creature — 300 hit points is 7,800 J to work through — on a
    // claw that has only got narrower.
    phys: {
      blowMass_kg: 33, blowEnergy_j: 1227.2, contactArea_m2: 1.2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 2800, density_kgpm3: 1010, armorHardness_gpa: 0.5, armorCoverage_frac: 0.6, woundEnergy_j: 7800,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 1.97344, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 500000000, blowSpeed_mps: 8.62414, bodyDepth_m: 0.772636,
    },
  },

  // ======================= FORTRESS =======================
  // The hardy swamp-beasts of the mire — high defense, thick hides, and nasty
  // teeth, crowned by the Hydra, which savages EVERY adjacent enemy at once and
  // suffers no reprisal (the `attacksAround` ability).
  gnoll: {
    name: 'Gnoll', faction: 'fortress', tier: 1, upgraded: false,
    attack: 3, defense: 5, damage: [2, 3], health: 6, speed: 4, reach: 'melee',
    growth: 14, cost: { gold: 50 }, aiValue: 72, abilities: [],
    glyph: 'gnoll', tint: 0x8a7a4a, desc: 'Hyena-headed brutes of the fetid marshes.',
    // Defense 5 at tier 1 is the highest in the game, and this is where it comes
    // from: a gnoll is a polearm behind a shield, not a runt with a stick. Twice
    // the Goblin's armour over half again the body.
    phys: {
      blowMass_kg: 1.4, blowEnergy_j: 71.5, contactArea_m2: 9e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 55, density_kgpm3: 1010, armorHardness_gpa: 0.06, armorCoverage_frac: 0.28, woundEnergy_j: 156,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.143668, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 60000000, blowSpeed_mps: 10.1066, bodyDepth_m: 0.20847,
    },
  },
  gnollMarauder: {
    name: 'Gnoll Marauder', faction: 'fortress', tier: 1, upgraded: true, upgradeOf: 'gnoll',
    attack: 5, defense: 6, damage: [2, 3], health: 6, speed: 5, reach: 'melee',
    growth: 14, cost: { gold: 65 }, aiValue: 103, abilities: [],
    glyph: 'gnoll', tint: 0xa8945a, desc: 'Veteran marauders, quicker and deadlier.',
    // Veterans keep their kit better: a heavier head on a narrower point and more
    // of the shield actually between them and the blow.
    phys: {
      blowMass_kg: 1.5, blowEnergy_j: 76.7, contactArea_m2: 8e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 58, density_kgpm3: 1010, armorHardness_gpa: 0.08, armorCoverage_frac: 0.32, woundEnergy_j: 156,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.148846, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 80000000, blowSpeed_mps: 10.1127, bodyDepth_m: 0.212193,
    },
  },
  lizardman: {
    name: 'Lizardman', faction: 'fortress', tier: 2, upgraded: false,
    attack: 5, defense: 6, damage: [2, 3], health: 14, speed: 4, reach: 'ranged', shots: 12,
    growth: 9, cost: { gold: 110 }, aiValue: 140, abilities: ['ghostRemnant'],
    glyph: 'lizardman', tint: 0x5f8a52, desc: 'Scaled marsh-dwellers who fling barbed darts.',
    // The lightest arrow authored, at 45 g — 71 J delivered is 97 J stored, which
    // is a hunting bow rather than a warbow, and the widest group of any shaft in
    // the game. What a lizardman has instead of a draw is scale: 0.10 GPa at tier
    // 2 is more armour than most tier-4 creatures wear.
    phys: {
      blowMass_kg: 0.045, blowEnergy_j: 71.5, contactArea_m2: 1.8e-5, dispersion_rad: 0.032, ballisticCoeff_kgpm2: 1000,
      bodyMass_kg: 75, density_kgpm3: 1010, armorHardness_gpa: 0.1, armorCoverage_frac: 0.35, woundEnergy_j: 364,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.176669, velRetainPerHex_ratio: 0.998164, armorHardness_pa: 100000000, blowSpeed_mps: 56.3718, bodyDepth_m: 0.231176,
    },
  },
  lizardWarrior: {
    name: 'Lizard Warrior', faction: 'fortress', tier: 2, upgraded: true, upgradeOf: 'lizardman',
    attack: 6, defense: 8, damage: [2, 5], health: 15, speed: 5, reach: 'ranged', shots: 24,
    growth: 9, cost: { gold: 140 }, aiValue: 205, abilities: ['ghostRemnant'],
    glyph: 'lizardman', tint: 0x74a462, desc: 'War-scarred lizards with deeper quivers.',
    // The largest jump any upgrade makes to its own blow — 2-3 becomes 2-5 in the
    // classic tuple, so the shaft gains 43% of its energy rather than the usual
    // tenth. Still 134 J stored against a 175 J ceiling.
    phys: {
      blowMass_kg: 0.05, blowEnergy_j: 107.38, contactArea_m2: 1.6e-5, dispersion_rad: 0.026, ballisticCoeff_kgpm2: 1000,
      bodyMass_kg: 80, density_kgpm3: 1010, armorHardness_gpa: 0.13, armorCoverage_frac: 0.4, woundEnergy_j: 390,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.184436, velRetainPerHex_ratio: 0.998164, armorHardness_pa: 130000000, blowSpeed_mps: 65.5378, bodyDepth_m: 0.236203,
    },
  },
  serpentFly: {
    name: 'Serpent Fly', faction: 'fortress', tier: 3, upgraded: false,
    attack: 6, defense: 6, damage: [2, 5], health: 8, speed: 9, reach: 'flying',
    growth: 8, cost: { gold: 120 }, aiValue: 145, abilities: [],
    glyph: 'serpentFly', tint: 0x6a9a7a, desc: 'Darting winged serpents of the bog.',
    // 0.15 cm² is the finest striking surface on any melee creature in the game —
    // an insect's sting, driven by almost nothing. Eight hit points is the price:
    // the model's clearest statement that pressure and survival are unrelated.
    phys: {
      blowMass_kg: 0.4, blowEnergy_j: 100.1, contactArea_m2: 1.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 35, density_kgpm3: 900, armorHardness_gpa: 0.05, armorCoverage_frac: 0.2, woundEnergy_j: 208,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.114785, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 50000000, blowSpeed_mps: 22.3719, bodyDepth_m: 0.186339,
    },
  },
  dragonFly: {
    name: 'Dragon Fly', faction: 'fortress', tier: 3, upgraded: true, upgradeOf: 'serpentFly',
    attack: 7, defense: 7, damage: [2, 5], health: 8, speed: 13, reach: 'flying',
    growth: 8, cost: { gold: 150 }, aiValue: 248, abilities: [],
    glyph: 'serpentFly', tint: 0x88bc94, desc: 'The swiftest fliers in the marsh.',
    // Finer again, and the only thing on the roster that goes below 0.15 cm².
    phys: {
      blowMass_kg: 0.44, blowEnergy_j: 107.38, contactArea_m2: 1.3e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 36, density_kgpm3: 900, armorHardness_gpa: 0.07, armorCoverage_frac: 0.24, woundEnergy_j: 208,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.116961, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 70000000, blowSpeed_mps: 22.0928, bodyDepth_m: 0.188097,
    },
  },
  basilisk: {
    name: 'Basilisk', faction: 'fortress', tier: 4, upgraded: false,
    attack: 11, defense: 11, damage: [6, 10], health: 35, speed: 5, reach: 'melee',
    growth: 5, cost: { gold: 400 }, aiValue: 490, abilities: [],
    glyph: 'basilisk', tint: 0x7a8a4a, desc: 'Eight-legged reptiles clad in thick, stony scales.',
    // "Stony scales" is a description of a MATERIAL, so it goes where materials
    // go: 0.25 GPa over half the body at tier 4, which is Champion-class armour on
    // a creature that costs a fifth as much. The bite is ordinary; the hide is not.
    phys: {
      blowMass_kg: 3, blowEnergy_j: 228.8, contactArea_m2: 3.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 240, density_kgpm3: 1010, armorHardness_gpa: 0.25, armorCoverage_frac: 0.5, woundEnergy_j: 910,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.383642, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 250000000, blowSpeed_mps: 12.3504, bodyDepth_m: 0.340664,
    },
  },
  greaterBasilisk: {
    name: 'Greater Basilisk', faction: 'fortress', tier: 4, upgraded: true, upgradeOf: 'basilisk',
    attack: 12, defense: 12, damage: [6, 10], health: 40, speed: 7, reach: 'melee',
    growth: 5, cost: { gold: 500 }, aiValue: 650, abilities: [],
    glyph: 'basilisk', tint: 0x96a85a, desc: 'Elder basilisks, thicker-scaled and swifter.',
    // "Thicker-scaled" is both numbers moving together — harder material over more
    // of it — which is what an elder animal actually is.
    phys: {
      blowMass_kg: 3.3, blowEnergy_j: 245.44, contactArea_m2: 3.2e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 260, density_kgpm3: 1010, armorHardness_gpa: 0.3, armorCoverage_frac: 0.55, woundEnergy_j: 1040,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.40467, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 300000000, blowSpeed_mps: 12.1964, bodyDepth_m: 0.349875,
    },
  },
  gorgon: {
    name: 'Gorgon', faction: 'fortress', tier: 5, upgraded: false,
    attack: 10, defense: 14, damage: [12, 16], health: 70, speed: 5, reach: 'melee',
    growth: 4, cost: { gold: 525 }, aiValue: 862, abilities: [],
    glyph: 'gorgon', tint: 0x6a7a58, desc: 'Iron-plated bull-beasts of colossal endurance.',
    // Nine kilograms of horn onto a square centimetre, off seven hundred of bull.
    // A gorgon is the roster's argument that armour and toughness are separate
    // purchases: 0.32 GPa over 55% AND 1,820 J to put one down.
    phys: {
      blowMass_kg: 9, blowEnergy_j: 400.4, contactArea_m2: 1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 700, density_kgpm3: 1010, armorHardness_gpa: 0.32, armorCoverage_frac: 0.55, woundEnergy_j: 1820,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.783161, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 320000000, blowSpeed_mps: 9.4328, bodyDepth_m: 0.48673,
    },
  },
  mightyGorgon: {
    name: 'Mighty Gorgon', faction: 'fortress', tier: 5, upgraded: true, upgradeOf: 'gorgon',
    attack: 11, defense: 16, damage: [12, 16], health: 70, speed: 6, reach: 'melee',
    growth: 4, cost: { gold: 600 }, aiValue: 1088, abilities: [],
    glyph: 'gorgon', tint: 0x869670, desc: 'Armour-clad gorgons; a near-immovable wall.',
    // "A near-immovable wall" is 0.40 GPa over three fifths of it — the hardest
    // tier-5 body in the game, and the point at which a light shaft simply stops.
    phys: {
      blowMass_kg: 9.5, blowEnergy_j: 429.52, contactArea_m2: 9e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 720, density_kgpm3: 1010, armorHardness_gpa: 0.4, armorCoverage_frac: 0.6, woundEnergy_j: 1820,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.798008, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 400000000, blowSpeed_mps: 9.50922, bodyDepth_m: 0.491322,
    },
  },
  wyvern: {
    name: 'Wyvern', faction: 'fortress', tier: 6, upgraded: false,
    attack: 14, defense: 14, damage: [14, 18], health: 70, speed: 7, reach: 'flying',
    growth: 3, cost: { gold: 800 }, aiValue: 1290, abilities: [],
    glyph: 'wyvern', tint: 0x5a8a6a, desc: 'Winged marsh-drakes with a lashing barbed tail.',
    // The Manticore's shape one faction over: a barbed tail is five kilograms
    // onto 0.3 cm², so a tier-6 flier fights on pressure rather than on mass.
    phys: {
      blowMass_kg: 5, blowEnergy_j: 457.6, contactArea_m2: 3e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 450, density_kgpm3: 1010, armorHardness_gpa: 0.28, armorCoverage_frac: 0.45, woundEnergy_j: 1820,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.583348, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 280000000, blowSpeed_mps: 13.5292, bodyDepth_m: 0.420075,
    },
  },
  wyvernMonarch: {
    name: 'Wyvern Monarch', faction: 'fortress', tier: 6, upgraded: true, upgradeOf: 'wyvern',
    attack: 14, defense: 14, damage: [18, 22], health: 80, speed: 11, reach: 'flying',
    growth: 3, cost: { gold: 1100 }, aiValue: 1645, abilities: [],
    glyph: 'wyvern', tint: 0x74a884, desc: 'Sovereign drakes, faster and far more savage.',
    // "Far more savage" is the one upgrade in these two factions that moves the
    // classic tuple by a quarter (14-18 becomes 18-22), so the sting gains a fifth
    // of its energy rather than a tenth.
    phys: {
      blowMass_kg: 5.5, blowEnergy_j: 613.6, contactArea_m2: 2.7e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 480, density_kgpm3: 1010, armorHardness_gpa: 0.34, armorCoverage_frac: 0.5, woundEnergy_j: 2080,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.608994, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 340000000, blowSpeed_mps: 14.9374, bodyDepth_m: 0.429209,
    },
  },
  // The Lizard Ghost is NOT recruitable and belongs to no dwelling: it only ever
  // appears when a slain lizard stack leaves a shade behind (a chance event — see
  // CombatEngine.spawnGhostRemnants, gated by the lizardGhosts feature). `tier: 0`
  // keeps it out of every tier lookup (dwellings, the Altar's tier-2 output);
  // growth 0 and an empty cost mean nothing can ever buy it. Incorporeal: it
  // drifts (flying), shrugs off half of any spell, and being undead it is beyond
  // morale and cannot itself be raised as skeletons.
  lizardGhost: {
    name: 'Lizard Ghost', faction: 'fortress', tier: 0, upgraded: false,
    // `summonedOnly` is what keeps it out of every ROSTER: a map guard, a town
    // garrison, the Battle Gym's creature list. It was observed guarding a sawmill
    // on a map whose lizardGhosts feature was off, because the generator's guard
    // pool filtered on `!upgraded` alone and a 150-aiValue creature fits any
    // budget. tier/growth/cost already kept it out of the dwelling lookups; this
    // marks the whole class explicitly rather than leaving each pool to infer it.
    summonedOnly: true,
    attack: 7, defense: 5, damage: [3, 6], health: 12, speed: 8, reach: 'flying',
    shots: 0, growth: 0, cost: {}, aiValue: 150, abilities: ['spellResist50'], undead: true,
    glyph: 'lizardman', tint: 0x9fd8c8, desc: 'The shade of a slain lizard host, risen from the marsh mist.',
    // AUTHORED THOUGH NO DWELLING MUSTERS IT. A lizard ghost is tier 0 and comes
    // from the battlefield rather than from a building, so no improvement branch
    // will ever patch it — but it fights, and an un-authored creature in a battle
    // between authored ones falls back to the classic tuple. Covering it is what
    // makes "Fortress is authored" true rather than true of the buildable part.
    //
    // Near-incorporeal at 400 kg/m³, so outside the flesh band and stating its own
    // tissue: mist holds together at 2 MPa, and there is nothing in it to bleed.
    phys: {
      blowMass_kg: 0.5, blowEnergy_j: 128.7, contactArea_m2: 4e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 20, density_kgpm3: 400, armorHardness_gpa: 0.04, armorCoverage_frac: 0.2, woundEnergy_j: 312,
      tissueStrength_pa: 2000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.135721, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 40000000, blowSpeed_mps: 22.6892, bodyDepth_m: 0.202622,
    },
  },
  hydra: {
    name: 'Hydra', faction: 'fortress', tier: 7, upgraded: false,
    attack: 16, defense: 18, damage: [25, 45], health: 175, speed: 5, reach: 'melee',
    growth: 1, cost: { gold: 2200 }, aiValue: 5769, abilities: ['attacksAround'],
    glyph: 'hydra', tint: 0x5a7048, desc: 'Many-headed; savages every adjacent foe and takes no reprisal.',
    // Seven mouths closing at once, so the contact area is an AGGREGATE and it is
    // wide — 2 cm² — which is why a hydra is enormous energy at unremarkable
    // pressure. Hitting everything adjacent is a battle-layer ability; this entry
    // only describes what arrives at one of them.
    phys: {
      blowMass_kg: 18, blowEnergy_j: 1001, contactArea_m2: 2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 2000, density_kgpm3: 1010, armorHardness_gpa: 0.45, armorCoverage_frac: 0.65, woundEnergy_j: 4550,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 1.57691, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 450000000, blowSpeed_mps: 10.5462, bodyDepth_m: 0.690662,
    },
  },
  chaosHydra: {
    name: 'Chaos Hydra', faction: 'fortress', tier: 7, upgraded: true, upgradeOf: 'hydra',
    attack: 18, defense: 20, damage: [25, 45], health: 250, speed: 7, reach: 'melee',
    growth: 1, cost: { gold: 3500, sulfur: 1 }, aiValue: 6502, abilities: ['attacksAround'],
    glyph: 'hydra', tint: 0x76905e, desc: 'Elder hydra; strikes all around it, still without reprisal.',
    // 250 hit points at 26 J each is 6,500 J, the second-deepest pool in the game
    // behind the Ancient Behemoth — and unlike the Behemoth it is behind 0.55 GPa.
    phys: {
      blowMass_kg: 20, blowEnergy_j: 1073.8, contactArea_m2: 1.8e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 2400, density_kgpm3: 1010, armorHardness_gpa: 0.55, armorCoverage_frac: 0.7, woundEnergy_j: 6500,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 1.78071, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 550000000, blowSpeed_mps: 10.3624, bodyDepth_m: 0.733938,
    },
  },

  // ======================= CONFLUX =======================
  // The elemental planes given form: sprites, the four elementals (air, water,
  // fire, earth) and their upgrades, the mind-elementals, and the reborn
  // firebirds. The elementals are `mindless` — no morale to sway. The Magic
  // Elemental shrugs off all spells (`spellImmune`), and the Phoenix rises from
  // its own ashes once per battle (`rebirth`).
  pixie: {
    name: 'Pixie', faction: 'conflux', tier: 1, upgraded: false,
    attack: 2, defense: 2, damage: [1, 2], health: 3, speed: 7, reach: 'flying',
    growth: 15, cost: { gold: 25 }, aiValue: 46, abilities: [],
    glyph: 'pixie', tint: 0x9ad0c0, desc: 'Flitting fey sprites of the elemental glades.',
    // A hundred grams of fey onto eight square millimetres. Three hit points is
    // 78 J, the smallest pool in the game — a pixie is the model's low end in
    // every direction at once.
    phys: {
      blowMass_kg: 0.1, blowEnergy_j: 42.9, contactArea_m2: 8e-6, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 3, density_kgpm3: 900, armorHardness_gpa: 0.01, armorCoverage_frac: 0.1, woundEnergy_j: 78,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.0223144, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 10000000, blowSpeed_mps: 29.2916, bodyDepth_m: 0.0821591,
    },
  },
  sprite: {
    name: 'Sprite', faction: 'conflux', tier: 1, upgraded: true, upgradeOf: 'pixie',
    attack: 2, defense: 2, damage: [1, 3], health: 3, speed: 9, reach: 'flying',
    growth: 15, cost: { gold: 30 }, aiValue: 59, abilities: ['noEnemyRetaliation'],
    glyph: 'pixie', tint: 0xb8ecdc, desc: 'Flits in, strikes, and is gone before any reprisal.',
    // Striking and gone: a third more energy through a finer point, on the same
    // three hit points. Everything a sprite gains, it gains in the blow.
    phys: {
      blowMass_kg: 0.11, blowEnergy_j: 61.36, contactArea_m2: 7e-6, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 3.2, density_kgpm3: 900, armorHardness_gpa: 0.015, armorCoverage_frac: 0.12, woundEnergy_j: 78,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.0232955, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 15000000, blowSpeed_mps: 33.4011, bodyDepth_m: 0.0839457,
    },
  },
  airElemental: {
    name: 'Air Elemental', faction: 'conflux', tier: 2, upgraded: false,
    attack: 9, defense: 9, damage: [2, 8], health: 25, speed: 7, reach: 'melee',
    growth: 8, cost: { gold: 250 }, aiValue: 307, abilities: [], mindless: true,
    glyph: 'airElemental', tint: 0xc8dcec, desc: 'A whirling vortex of living wind; immune to morale.',
    // Wind at 400 kg/m³ — well outside the flesh band, so it states its own
    // resistance — and the blow is DIFFUSE: two kilograms across 2 cm², the
    // opposite shape to everything else at this tier. An air elemental pushes.
    phys: {
      blowMass_kg: 2, blowEnergy_j: 143, contactArea_m2: 2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 60, density_kgpm3: 400, armorHardness_gpa: 0.02, armorCoverage_frac: 0.4, woundEnergy_j: 650,
      tissueStrength_pa: 1500000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.282311, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 20000000, blowSpeed_mps: 11.9583, bodyDepth_m: 0.292231,
    },
  },
  stormElemental: {
    name: 'Storm Elemental', faction: 'conflux', tier: 2, upgraded: true, upgradeOf: 'airElemental',
    attack: 9, defense: 9, damage: [2, 8], health: 25, speed: 8, reach: 'ranged', shots: 24,
    growth: 8, cost: { gold: 275 }, aiValue: 372, abilities: [], mindless: true,
    glyph: 'airElemental', tint: 0xa8c8e8, desc: 'Hurls bolts of lightning from afar; immune to morale.',
    // ANOTHER PAIR THAT GAINS A RANGED ATTACK ON UPGRADE, like Servitor → Master
    // Servitor. The diffuse push becomes a bolt: a fifteenth of the mass through
    // a fifth of the area, which is a different weapon rather than a bigger one.
    phys: {
      blowMass_kg: 0.3, blowEnergy_j: 153.4, contactArea_m2: 4e-5, dispersion_rad: 0.03, ballisticCoeff_kgpm2: 1500,
      bodyMass_kg: 62, density_kgpm3: 400, armorHardness_gpa: 0.03, armorCoverage_frac: 0.44, woundEnergy_j: 650,
      tissueStrength_pa: 2000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.28855, velRetainPerHex_ratio: 0.998775, armorHardness_pa: 30000000, blowSpeed_mps: 31.9792, bodyDepth_m: 0.295443,
    },
  },
  waterElemental: {
    name: 'Water Elemental', faction: 'conflux', tier: 3, upgraded: false,
    attack: 8, defense: 10, damage: [3, 7], health: 30, speed: 5, reach: 'melee',
    growth: 6, cost: { gold: 300 }, aiValue: 334, abilities: [], mindless: true,
    glyph: 'waterElemental', tint: 0x5aa0d0, desc: 'A surging column of living water; immune to morale.',
    // Water is 1,000 kg/m³ and therefore INSIDE the flesh band — the one elemental
    // that does not have to declare what it is made of, because the default
    // already describes it. Six kilograms of it, arriving slowly and wide.
    phys: {
      blowMass_kg: 6, blowEnergy_j: 143, contactArea_m2: 3e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 200, density_kgpm3: 1000, armorHardness_gpa: 0.03, armorCoverage_frac: 0.5, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.341995, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 30000000, blowSpeed_mps: 6.90411, bodyDepth_m: 0.321642,
    },
  },
  iceElemental: {
    name: 'Ice Elemental', faction: 'conflux', tier: 3, upgraded: true, upgradeOf: 'waterElemental',
    attack: 8, defense: 10, damage: [3, 7], health: 30, speed: 6, reach: 'ranged', shots: 24,
    growth: 6, cost: { gold: 350 }, aiValue: 396, abilities: [], mindless: true,
    glyph: 'waterElemental', tint: 0x9ad8ec, desc: 'Flings shards of frost; immune to morale.',
    // The same water, frozen and thrown: 400 g of shard through 0.3 cm², which is
    // a fifteenth the mass at a tenth the area. Ice is 950 kg/m³ and still inside
    // the flesh band, which is a coincidence the model is welcome to.
    phys: {
      blowMass_kg: 0.4, blowEnergy_j: 153.4, contactArea_m2: 3e-5, dispersion_rad: 0.026, ballisticCoeff_kgpm2: 1600,
      bodyMass_kg: 210, density_kgpm3: 950, armorHardness_gpa: 0.05, armorCoverage_frac: 0.55, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.365592, velRetainPerHex_ratio: 0.998852, armorHardness_pa: 50000000, blowSpeed_mps: 27.6948, bodyDepth_m: 0.332553,
    },
  },
  fireElemental: {
    name: 'Fire Elemental', faction: 'conflux', tier: 4, upgraded: false,
    attack: 10, defense: 8, damage: [4, 6], health: 35, speed: 6, reach: 'melee',
    growth: 5, cost: { gold: 350 }, aiValue: 347, abilities: [], mindless: true,
    glyph: 'flame', tint: 0xe86838, desc: 'A living pillar of flame; immune to morale.',
    // Flame at 300 kg/m³ is the lightest body authored, which is why a tier-4
    // creature has a tier-2 silhouette. Almost nothing to hit, and almost nothing
    // holding it together: 1.2 MPa.
    phys: {
      blowMass_kg: 1.5, blowEnergy_j: 143, contactArea_m2: 1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 80, density_kgpm3: 300, armorHardness_gpa: 0.04, armorCoverage_frac: 0.45, woundEnergy_j: 910,
      tissueStrength_pa: 1200000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.414298, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 40000000, blowSpeed_mps: 13.8082, bodyDepth_m: 0.354013,
    },
  },
  energyElemental: {
    name: 'Energy Elemental', faction: 'conflux', tier: 4, upgraded: true, upgradeOf: 'fireElemental',
    attack: 12, defense: 8, damage: [4, 6], health: 35, speed: 8, reach: 'melee',
    growth: 5, cost: { gold: 400 }, aiValue: 457, abilities: [], mindless: true,
    glyph: 'flame', tint: 0xf8a038, desc: 'Crackling raw energy, swift and fierce; immune to morale.',
    // Lighter again and more concentrated — raw energy is the same fire with the
    // heat put through a smaller opening.
    phys: {
      blowMass_kg: 1.2, blowEnergy_j: 153.4, contactArea_m2: 7e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 82, density_kgpm3: 250, armorHardness_gpa: 0.06, armorCoverage_frac: 0.5, woundEnergy_j: 910,
      tissueStrength_pa: 1100000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.475608, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 60000000, blowSpeed_mps: 15.9896, bodyDepth_m: 0.379304,
    },
  },
  earthElemental: {
    name: 'Earth Elemental', faction: 'conflux', tier: 5, upgraded: false,
    attack: 10, defense: 10, damage: [4, 8], health: 40, speed: 4, reach: 'melee',
    growth: 4, cost: { gold: 400 }, aiValue: 361, abilities: [], mindless: true,
    glyph: 'earthElemental', tint: 0x9a8a5a, desc: 'A lumbering giant of stone and soil; immune to morale.',
    // Rock at 2,200 kg/m³ and fifteen kilograms of fist. 0.45 GPa over 75% is the
    // hardest thing in Conflux and sits deliberately BELOW the Stone Golem's 0.70
    // — an elemental is packed soil and stone, not a carved statue.
    phys: {
      blowMass_kg: 15, blowEnergy_j: 171.6, contactArea_m2: 2.5e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 600, density_kgpm3: 2200, armorHardness_gpa: 0.45, armorCoverage_frac: 0.75, woundEnergy_j: 1040,
      tissueStrength_pa: 90000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.420551, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 450000000, blowSpeed_mps: 4.7833, bodyDepth_m: 0.356675,
    },
  },
  magmaElemental: {
    name: 'Magma Elemental', faction: 'conflux', tier: 5, upgraded: true, upgradeOf: 'earthElemental',
    attack: 11, defense: 11, damage: [6, 10], health: 40, speed: 6, reach: 'melee',
    growth: 4, cost: { gold: 500 }, aiValue: 576, abilities: [], mindless: true,
    glyph: 'earthElemental', tint: 0xc06838, desc: 'Molten rock made flesh; immune to morale.',
    // Denser, harder, and hitting a third harder for it — but the same shape of
    // creature. Molten rock still cools to rock.
    phys: {
      blowMass_kg: 16, blowEnergy_j: 245.44, contactArea_m2: 2.2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 620, density_kgpm3: 2400, armorHardness_gpa: 0.55, armorCoverage_frac: 0.8, woundEnergy_j: 1040,
      tissueStrength_pa: 110000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.405621, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 550000000, blowSpeed_mps: 5.53895, bodyDepth_m: 0.350286,
    },
  },
  psychicElemental: {
    name: 'Psychic Elemental', faction: 'conflux', tier: 6, upgraded: false,
    attack: 15, defense: 13, damage: [10, 20], health: 75, speed: 7, reach: 'melee',
    growth: 3, cost: { gold: 750, mercury: 1 }, aiValue: 1373, abilities: [], mindless: true,
    glyph: 'psychicElemental', tint: 0xc89ad8, desc: 'A shimmering thought-form of pure mind; immune to morale.',
    // Thought delivered as pressure: 800 g through 0.15 cm², which is the finest
    // point in Conflux and among the finest anywhere. There is very little of a
    // psychic elemental and all of it arrives in one place.
    phys: {
      blowMass_kg: 0.8, blowEnergy_j: 429, contactArea_m2: 1.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 150, density_kgpm3: 500, armorHardness_gpa: 0.1, armorCoverage_frac: 0.5, woundEnergy_j: 1950,
      tissueStrength_pa: 3000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.44814, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 100000000, blowSpeed_mps: 32.749, bodyDepth_m: 0.368188,
    },
  },
  magicElemental: {
    name: 'Magic Elemental', faction: 'conflux', tier: 6, upgraded: true, upgradeOf: 'psychicElemental',
    attack: 15, defense: 13, damage: [15, 25], health: 80, speed: 9, reach: 'melee',
    growth: 3, cost: { gold: 800, mercury: 1 }, aiValue: 1655, abilities: ['spellImmune'], mindless: true,
    glyph: 'psychicElemental', tint: 0xe0b8f0, desc: 'Woven of raw magic — no spell can touch it; immune to morale.',
    // Spell immunity means the physical answer is the only answer — the same
    // weight the Black Dragon carries — so the armour stays modest on purpose and
    // the creature is beaten by hitting it.
    phys: {
      blowMass_kg: 0.9, blowEnergy_j: 613.6, contactArea_m2: 1.3e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 160, density_kgpm3: 500, armorHardness_gpa: 0.14, armorCoverage_frac: 0.55, woundEnergy_j: 2080,
      tissueStrength_pa: 3500000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.467843, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 140000000, blowSpeed_mps: 36.9264, bodyDepth_m: 0.376195,
    },
  },
  firebird: {
    name: 'Firebird', faction: 'conflux', tier: 7, upgraded: false,
    attack: 18, defense: 18, damage: [30, 40], health: 150, speed: 15, reach: 'flying',
    growth: 2, cost: { gold: 1500 }, aiValue: 3310, abilities: [],
    glyph: 'phoenix', tint: 0xf07830, desc: 'A blazing bird of the fire-plane, swift as the wind.',
    // Six kilograms of burning talon onto half a square millimetre-squared, off a
    // body of flame at 600 kg/m³. High energy AND high pressure, with only half of
    // it armoured — a firebird is a glass cannon stated in joules.
    phys: {
      blowMass_kg: 6, blowEnergy_j: 1001, contactArea_m2: 5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 400, density_kgpm3: 600, armorHardness_gpa: 0.3, armorCoverage_frac: 0.5, woundEnergy_j: 3900,
      tissueStrength_pa: 4000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.763143, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 300000000, blowSpeed_mps: 18.2665, bodyDepth_m: 0.480469,
    },
  },
  phoenix: {
    name: 'Phoenix', faction: 'conflux', tier: 7, upgraded: true, upgradeOf: 'firebird',
    attack: 21, defense: 18, damage: [30, 40], health: 200, speed: 21, reach: 'flying',
    growth: 2, cost: { gold: 2000, mercury: 1 }, aiValue: 4435, abilities: ['rebirth'], rebirthFrac: 0.2,
    glyph: 'phoenix', tint: 0xf8b040, desc: 'Rises from its own ashes once per battle; fastest of all.',
    // Rebirth is a battle-layer ability and lives there. Here the phoenix is
    // simply more of the firebird: a third more body, 5,200 J to put one down,
    // and a keener talon.
    phys: {
      blowMass_kg: 6.5, blowEnergy_j: 1073.8, contactArea_m2: 4.5e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 450, density_kgpm3: 600, armorHardness_gpa: 0.38, armorCoverage_frac: 0.55, woundEnergy_j: 5200,
      tissueStrength_pa: 4500000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.825482, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 380000000, blowSpeed_mps: 18.1769, bodyDepth_m: 0.499708,
    },
  },

  // ======================= WAR MACHINES =======================
  // Battlefield support a hero buys at a Blacksmith and brings to the fight.
  // faction 'machine' keeps them out of the faction/dwelling/mapgen invariants
  // (never recruited, aiValue 0 so rollGuard skips them). They are deployed by
  // CombatEngine.deployWarMachines (NOT the 7 army slots) and flagged
  // `noncombatant` on the unit so they never keep a side "alive" (see finish()).
  ballista: {
    name: 'Ballista', faction: 'machine', tier: 0, upgraded: false,
    attack: 10, defense: 10, damage: [4, 8], health: 250, speed: 0, reach: 'ranged',
    shots: 999, growth: 0, cost: {}, aiValue: 0, abilities: [],
    glyph: 'ballista', tint: 0x9a8358, desc: 'Fires a heavy bolt at an enemy stack each round.',
    // THE ONE MACHINE THAT IS A WEAPON IN THIS MODEL'S OWN TERMS. A 350 g bolt at
    // 31 m/s through 0.15 cm² — deliberately outside the arrow envelope
    // (`isArrow`, ≤150 g), which `headGeometry` itself names: "above is a ballista
    // bolt". A bolt head is a broad iron pyramid, not a bodkin, so 0.5 cm² — and
    // the niche scan agrees: at a bodkin's 0.15 cm² added mass paid against three
    // targets, at 0.5 cm² it pays against thirty-nine. It is a crew-served engine,
    // so the group is the tightest authored.
    // The BODY is oak at 700 kg/m³, which is why it states its own tissue.
    phys: {
      blowMass_kg: 0.35, blowEnergy_j: 171.6, contactArea_m2: 5e-5, dispersion_rad: 0.012, ballisticCoeff_kgpm2: 2500,
      bodyMass_kg: 300, density_kgpm3: 700, armorHardness_gpa: 0.05, armorCoverage_frac: 0.6, woundEnergy_j: 6500,
      tissueStrength_pa: 60000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.568437, velRetainPerHex_ratio: 0.999265, armorHardness_pa: 50000000, blowSpeed_mps: 31.3141, bodyDepth_m: 0.414671,
    },
  },
  firstAidTent: {
    name: 'First Aid Tent', faction: 'machine', tier: 0, upgraded: false,
    attack: 0, defense: 10, damage: [1, 1], health: 75, speed: 0, reach: 'melee',
    shots: 0, growth: 0, cost: {}, aiValue: 0, abilities: [],
    glyph: 'firstAidTent', tint: 0xd8d2c4, desc: 'Heals a wounded friendly stack each round.',
    // AUTHORED AS A TARGET, NOT AS A WEAPON. Attack 0 and a 1-1 damage tuple: a
    // tent does not fight, and the blow below exists only because a partial `phys`
    // block yields NaN rather than a fallback. What is real here is the other
    // half — canvas over a light frame at 500 kg/m³, almost nothing hard, and
    // 1,950 J to wreck it. Those are the numbers an arrow actually meets.
    phys: {
      blowMass_kg: 0.3, blowEnergy_j: 28.6, contactArea_m2: 1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 120, density_kgpm3: 500, armorHardness_gpa: 0.01, armorCoverage_frac: 0.2, woundEnergy_j: 1950,
      tissueStrength_pa: 8000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.386196, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 10000000, blowSpeed_mps: 13.8082, bodyDepth_m: 0.341796,
    },
  },
  ammoCart: {
    name: 'Ammo Cart', faction: 'machine', tier: 0, upgraded: false,
    attack: 0, defense: 10, damage: [1, 1], health: 75, speed: 0, reach: 'melee',
    shots: 0, growth: 0, cost: {}, aiValue: 0, abilities: [],
    glyph: 'ammoCart', tint: 0x8a7048, desc: 'Your shooters never run out of ammunition.',
    // The same reasoning as the First Aid Tent: a target, not a weapon. A loaded
    // timber cart is heavier and better boarded than a tent, which is the whole
    // difference between them in this model.
    phys: {
      blowMass_kg: 0.3, blowEnergy_j: 28.6, contactArea_m2: 1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 400, density_kgpm3: 700, armorHardness_gpa: 0.03, armorCoverage_frac: 0.35, woundEnergy_j: 1950,
      tissueStrength_pa: 60000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.688612, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 30000000, blowSpeed_mps: 13.8082, bodyDepth_m: 0.456405,
    },
  },
  catapult: {
    name: 'Catapult', faction: 'machine', tier: 0, upgraded: false,
    attack: 12, defense: 12, damage: [1, 1], health: 1000, speed: 0, reach: 'ranged',
    // `untargetable` (HoMM3 rule): no attack, shot or spell can touch the
    // Catapult — otherwise a defender could snipe it and leave an all-walker
    // besieger with no way to ever breach the walls (an unbounded stalemate).
    shots: 999, growth: 0, cost: {}, aiValue: 0, abilities: ['untargetable'],
    glyph: 'catapult', tint: 0x7a6a52, desc: 'Batters down the walls of a besieged town each round.',
    // THE ONE CREATURE DELIBERATELY LEFT WITHOUT A `phys` BLOCK, and the reason is
    // that not one field of it would ever be read.
    //
    // A catapult does not attack units: its shot resolves against a wall segment
    // for CONFIG.SIEGE.catapultDamage on a separate path in CombatEngine, so the
    // `damage: [1, 1]` tuple above is a placeholder that never rolls. It is also
    // `untargetable`, so nothing shoots back — its armour, its coverage and its
    // wound pool have no consumer either. Authoring it would mean inventing a
    // 29 J blow for a siege engine and a 26,000 J body for something that cannot
    // be hit, and both numbers would sit in the file looking like measurements.
    //
    // Everything else on the roster is covered: 139 of 140. This is the gap that
    // is a decision rather than a to-do, which is why it is written here instead
    // of tracked somewhere.
  },
  arrowTower: {
    name: 'Arrow Tower', faction: 'machine', tier: 0, upgraded: false,
    attack: 12, defense: 12, damage: [8, 15], health: 400, speed: 0, reach: 'ranged',
    shots: 999, growth: 0, cost: {}, aiValue: 0, abilities: [],
    glyph: 'arrowTower', tint: 0x9a8f7a, desc: 'A fortress tower that rains arrows on besiegers.',
    // A STONE TOWER, and the only body in the game at 100% COVERAGE — there is no
    // gap in a wall. 0.45 GPa is mortared masonry, deliberately SOFTER than the
    // Stone Golem's 0.70: a golem is solid carved rock, a wall is blocks and lime,
    // and the tower's durability lives in its 10,400 J and its coverage instead.
    //
    // First authored at 0.90 and the mass-niche invariant threw out the whole
    // roster — a new rung that high pulled EVERY shooter's niche up against the
    // ceiling, leaving one harder target above it. Full coverage already makes the
    // tower the best thing in the game to answer with a heavier bolt, which is the
    // niche doing its job; it does not also need to be the hardest.
    phys: {
      blowMass_kg: 0.5, blowEnergy_j: 328.9, contactArea_m2: 8e-5, dispersion_rad: 0.01, ballisticCoeff_kgpm2: 2800,
      bodyMass_kg: 8000, density_kgpm3: 2400, armorHardness_gpa: 0.45, armorCoverage_frac: 1, woundEnergy_j: 10400,
      tissueStrength_pa: 120000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 2.23144, velRetainPerHex_ratio: 0.999344, armorHardness_pa: 450000000, blowSpeed_mps: 36.2712, bodyDepth_m: 0.821591,
    },
  },

  // ======================= NEUTRALS (map guards) =======================
  peasant: {
    name: 'Peasant', faction: 'neutral', tier: 1, upgraded: false,
    attack: 1, defense: 1, damage: [1, 1], health: 1, speed: 3, reach: 'melee',
    growth: 0, cost: { gold: 10 }, aiValue: 15, abilities: [],
    glyph: 'pitchfork', tint: 0xa89468, desc: 'Angry farmers with pitchforks.',
    // One hit point is 26 J — the smallest wound pool the model can hold, and a
    // fair description of a farmer. The pitchfork is a real kilogram of iron; the
    // man behind it is wearing a shirt.
    phys: {
      blowMass_kg: 1, blowEnergy_j: 28.6, contactArea_m2: 1.2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 70, density_kgpm3: 1010, armorHardness_gpa: 0.01, armorCoverage_frac: 0.05, woundEnergy_j: 26,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.168727, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 10000000, blowSpeed_mps: 7.56307, bodyDepth_m: 0.22592,
    },
  },
  rogue: {
    name: 'Rogue', faction: 'neutral', tier: 2, upgraded: false,
    attack: 8, defense: 3, damage: [2, 4], health: 10, speed: 6, reach: 'melee',
    growth: 0, cost: { gold: 100 }, aiValue: 135, abilities: [],
    glyph: 'dagger', tint: 0x708060, desc: 'Highway bandits.',
    // A dagger: the smallest contact area on any human in the game, and barely any
    // energy behind it. A rogue wins by where the blow lands, which is a battle
    // -layer question — this entry only says the point is sharp.
    phys: {
      blowMass_kg: 0.6, blowEnergy_j: 85.8, contactArea_m2: 3e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 70, density_kgpm3: 1010, armorHardness_gpa: 0.05, armorCoverage_frac: 0.2, woundEnergy_j: 260,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.168727, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 50000000, blowSpeed_mps: 16.9115, bodyDepth_m: 0.22592,
    },
  },
  nomad: {
    name: 'Nomad', faction: 'neutral', tier: 3, upgraded: false,
    attack: 9, defense: 8, damage: [2, 6], health: 30, speed: 7, reach: 'melee',
    growth: 0, cost: { gold: 200 }, aiValue: 345, abilities: [],
    glyph: 'scimitar', tint: 0xc0a050, desc: 'Desert riders.',
    // A sabre from the saddle. `bodyMass_kg` is rider and horse together, which is
    // why 30 hit points sit behind a modest blow.
    phys: {
      blowMass_kg: 1.1, blowEnergy_j: 114.4, contactArea_m2: 8e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 130, density_kgpm3: 1010, armorHardness_gpa: 0.09, armorCoverage_frac: 0.3, woundEnergy_j: 780,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.254926, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 90000000, blowSpeed_mps: 14.4222, bodyDepth_m: 0.277696,
    },
  },
  goldGolem: {
    name: 'Gold Golem', faction: 'neutral', tier: 4, upgraded: false,
    attack: 11, defense: 12, damage: [8, 10], health: 50, speed: 5, reach: 'melee',
    growth: 0, cost: { gold: 500 }, aiValue: 600, abilities: ['spellResist50'],
    glyph: 'golem', tint: 0xe0b830, desc: 'Takes half damage from spells.',
    // GOLD IS SOFT, and the entry says so: 0.35 GPa is below every other construct
    // in the game — a third of the Iron Golem — because gold anneals under a
    // hammer where iron work-hardens. Its defence is `spellResist50`, not its
    // surface. 6,000 kg/m³ for a gilded bronze core; the model's band stops at
    // 8,000 and solid gold would be 19,300, which is a statue nobody could animate.
    phys: {
      blowMass_kg: 8, blowEnergy_j: 257.4, contactArea_m2: 2e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 500, density_kgpm3: 6000, armorHardness_gpa: 0.35, armorCoverage_frac: 0.9, woundEnergy_j: 1300,
      tissueStrength_pa: 200000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.190786, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 350000000, blowSpeed_mps: 8.02185, bodyDepth_m: 0.240235,
    },
  },
  troll: {
    name: 'Troll', faction: 'neutral', tier: 5, upgraded: false,
    attack: 14, defense: 7, damage: [10, 15], health: 40, speed: 7, reach: 'melee',
    growth: 0, cost: { gold: 500 }, aiValue: 680, abilities: ['regenerate'],
    glyph: 'club', tint: 0x6a8858, desc: 'Regenerates wounds every round.',
    // Regeneration is the defence, so the armour is not: 0.10 GPa over 30% on a
    // creature with a ten-kilogram club. A troll is authored as barely dressed on
    // purpose — what keeps it alive is on the battle layer.
    phys: {
      blowMass_kg: 10, blowEnergy_j: 357.5, contactArea_m2: 2.4e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 380, density_kgpm3: 1010, armorHardness_gpa: 0.1, armorCoverage_frac: 0.3, woundEnergy_j: 1040,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.521164, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 100000000, blowSpeed_mps: 8.45577, bodyDepth_m: 0.397054,
    },
  },
  gremlin: {
    name: 'Gremlin', faction: 'neutral', tier: 1, upgraded: false,
    attack: 3, defense: 3, damage: [1, 2], health: 4, speed: 4, reach: 'melee',
    growth: 0, cost: { gold: 30 }, aiValue: 44, abilities: [],
    glyph: 'gremlin', tint: 0x7fae6a, desc: 'Servile tinkerers pressed into the fray.',
    // The Servitor's poorer cousin: the same short blade, less of everything else.
    phys: {
      blowMass_kg: 0.5, blowEnergy_j: 42.9, contactArea_m2: 7e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 25, density_kgpm3: 1010, armorHardness_gpa: 0.04, armorCoverage_frac: 0.25, woundEnergy_j: 104,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.0849335, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 40000000, blowSpeed_mps: 13.0996, bodyDepth_m: 0.160288,
    },
  },
  direWolf: {
    name: 'Dire Wolf', faction: 'neutral', tier: 3, upgraded: false,
    attack: 12, defense: 5, damage: [3, 5], health: 20, speed: 8, reach: 'melee',
    growth: 0, cost: { gold: 200 }, aiValue: 350, abilities: ['doubleAttack'],
    glyph: 'wolf', tint: 0x808890, desc: 'Strikes twice with slavering jaws.',
    // Jaws again, and the same shape as the Hell Hound one tier along: modest
    // energy through 0.28 cm² of fang, with nothing worn. Striking twice is a
    // rate and lives in the classic tuple.
    phys: {
      blowMass_kg: 1.8, blowEnergy_j: 114.4, contactArea_m2: 2.8e-5, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 120, density_kgpm3: 1010, armorHardness_gpa: 0.03, armorCoverage_frac: 0.15, woundEnergy_j: 520,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.24168, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 30000000, blowSpeed_mps: 11.2744, bodyDepth_m: 0.270385,
    },
  },
  mummy: {
    name: 'Mummy', faction: 'neutral', tier: 4, upgraded: false,
    attack: 7, defense: 7, damage: [3, 5], health: 30, speed: 5, reach: 'melee',
    growth: 0, cost: { gold: 400 }, aiValue: 500, abilities: ['curseAura'], undead: true,
    glyph: 'mummy', tint: 0xc8b888, desc: 'Its presence saps enemy luck; immune to morale.',
    // Bound linen over dried bone at 800 kg/m³ — outside the flesh band, so it
    // states its own resistance, and there is nothing left in it to bleed.
    phys: {
      blowMass_kg: 2, blowEnergy_j: 114.4, contactArea_m2: 1.1e-4, dispersion_rad: 0, ballisticCoeff_kgpm2: 5000,
      bodyMass_kg: 90, density_kgpm3: 800, armorHardness_gpa: 0.08, armorCoverage_frac: 0.4, woundEnergy_j: 780,
      tissueStrength_pa: 40000000, bleeds: false,
      // DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.
      frontalArea_m2: 0.233042, velRetainPerHex_ratio: 0.999632, armorHardness_pa: 80000000, blowSpeed_mps: 10.6958, bodyDepth_m: 0.26551,
    },
  },
};

/**
 * A creature that exists ONLY as the residue of a rule — nothing recruits it,
 * grows it or fields it, and no pool that enumerates CREATURES may offer it.
 *
 * There is one so far: the Lizard Ghost, which a slain lizard stack may leave
 * behind when the `lizardGhosts` feature is on. It was found guarding a sawmill on
 * a map with that feature OFF, because the generator's guard pool filtered on
 * `!upgraded` alone and a 150-aiValue creature fits any guard budget. Every roster
 * that draws from the whole creature table must exclude these.
 */
export function summonedOnly(id) {
  return !!CREATURES[id]?.summonedOnly;
}

/** The ids a roster may draw from: everything the world can actually field. */
export function fieldableCreatureIds() {
  return Object.keys(CREATURES).filter((id) => !CREATURES[id].summonedOnly);
}

/** All creature ids of a faction at a tier: [base, upgraded]. */
export function creaturesOfTier(factionId, tier) {
  const base = Object.keys(CREATURES).find(
    (id) => CREATURES[id].faction === factionId && CREATURES[id].tier === tier && !CREATURES[id].upgraded,
  );
  const upg = Object.keys(CREATURES).find(
    (id) => CREATURES[id].faction === factionId && CREATURES[id].tier === tier && CREATURES[id].upgraded,
  );
  return { base, upgraded: upg };
}
