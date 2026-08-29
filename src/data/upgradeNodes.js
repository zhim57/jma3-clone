/**
 * upgradeNodes.js — upgrade nodes (data-driven; no logic).
 *
 * A node is a purchasable change to what a dwelling's creatures physically ARE:
 * a heavier draw weight, a narrower arrowhead, mail for the wardens. Its
 * `effects` are PARAMETER PATCHES against the creature's `phys` block, so an
 * upgrade is expressed in the same units the damage model reads rather than as
 * a bonus bolted on beside it. "+15% draw weight" is a real sentence about a
 * bow; "+2 attack" was never a sentence about anything.
 *
 * HOW TO ADD A NODE
 * -----------------
 *   id          unique, `<dwelling>.<branch>.<name>` — self-describing, so a test
 *               failure or a commit message says where the node lives
 *   name        display name
 *   branch      the line WITHIN the dwelling (a Homestead has a fletchery and an
 *               armoury); not the dwelling itself
 *   dwelling    building id in DWELLINGS/buildingCatalog that hosts the branch.
 *               A building id, deliberately, and not a parallel dwelling-name
 *               namespace — building ids already exist and a second name for the
 *               same entity is a second thing to keep in step
 *   faction     the faction whose town can build it
 *   creatures   creature ids the patch applies to — normally a dwelling's base
 *               and its upgrade, since they are the same troops better equipped
 *   requires    node ids that must already be owned. Checked through ONE gate
 *               (upgradeBlockReason), exactly as buildBlockReason gates a
 *               building on b.requires — same shape, same single choke point, so
 *               a topological walk over `requires` mirrors the engine
 *   excludes    node ids this one can never coexist with. This is what makes a
 *               FORK a fork: two nodes that exclude each other are a choice, and
 *               the exclusion is symmetric (the test enforces it).
 *
 *               NO NODE USES IT TODAY, and that is worth saying rather than
 *               leaving to be discovered. The fletchery pair was the only fork in
 *               the tree and was cut (docs/PHYSICAL_MODEL.md §8i), so `excludes`
 *               is INTENDED FUTURE USE, not dead code and not a vestige: I7
 *               requires a tree whose forks bind, so the schema keeps the field
 *               and the gate keeps enforcing it. The machinery is exercised
 *               against a fixture catalog in upgrade-nodes.test.js, because a
 *               mechanism with no test stops working silently and the next branch
 *               to want a fork would find out the hard way.
 *
 *               Before authoring one, run the conditioning pre-check in
 *               src/core/conditioning.js on the margin that is supposed to
 *               separate its halves. That is the check the fletchery fork did not
 *               get, and it would have cost one function call.
 *               SCOPED PER PLAYER: a fork committed by any town commits the
 *               realm. Effects patch creature PARAMETERS, and an arrow has one
 *               contact area — there is nowhere to put a per-town answer. See
 *               docs/PHYSICAL_MODEL.md §4 for why per-town was reverted.
 *   cost        resources, same shape as a building's. PRICED SO THE BOTTLENECK
 *               MIGRATES, not to feel fair: gold in the thousands, because it is
 *               measured against a 500/day opening income and a town buying its
 *               own halls out of the same purse, and the deep nodes priced in
 *               CRYSTAL and GEMS, which have no income at all until a cavern is
 *               taken. That is the language the mage guild already speaks
 *               (tier 3 wants 8 of each against a starting stock of 5), and it
 *               is what makes materials the late-campaign constraint rather than
 *               a rounding error. Verified by scripts/sim/constraints.mjs, which
 *               reports which constraint binds on each of 100 days
 *   crew        { pool, count, days } — which crew pool, how many of them at
 *               once, and for how many days
 *   effects     the patch: { <physField>: { mul } | { add } | { set } }.
 *
 *               SCALE FOR WHAT COMPOUNDS, SET FOR WHAT SUBSTITUTES. Training,
 *               conditioning and practice build on a baseline — those scale; a
 *               better-drilled archer is better relative to how good they
 *               already were. Material, equipment and replacement parts put you
 *               in the new regime regardless of where you started — those set.
 *               Mail is not "leather x 1.5", it is mail.
 *
 *               Getting this backwards makes an upgrade worth MOST to whoever
 *               already has the most, compounding an advantage for no modelled
 *               reason — a modelling error that reads as a balance problem. It
 *               is also where I5 comes from for free: Wardens' Mail sets 0.12
 *               GPa, so a Wood Elf (0.08) gains more than a Grand Elf (0.10),
 *               and conditional effectiveness falls out of the physics instead
 *               of being designed in.
 *               There is no `depth` field: depth is derivable from the `requires`
 *               chain, and a derived value stored as data is the same error I2
 *               forbids in effects, turned on the schema itself.
 *   desc        one line, said in physical terms
 *
 * WHAT MAY BE PATCHED, and why the list is short. Only the AUTHORED fields that
 * are not inputs to the offline derivation:
 *
 *   blowMass_kg  blowEnergy_j  contactArea_m2  dispersion_rad  armorHardness_gpa
 *   armorCoverage_frac  woundEnergy_j
 *
 * `bodyMass_kg`, `density_kgpm3` and `ballisticCoeff_kgpm2` are excluded because
 * `frontalArea_m2` and `velRetainPerHex_ratio` are derived from them with a fractional
 * exponent, offline, precisely so no `pow` runs at damage time (see
 * scripts/data/derive-physical.mjs). A node that changed a creature's mass would
 * force that derivation back into the runtime and cost the model its
 * bit-identical reproducibility — for a silhouette that no upgrade in this
 * branch wants to move anyway. The derived fields themselves are likewise
 * unpatchable: they are outputs, not dials.
 *
 * EVERY NODE MUST COST SOMETHING PHYSICAL. Not gold — a derived output. A node
 * has to make at least one of {blow energy, impact pressure, hit fraction at
 * range, armour stopping power, toughness} strictly WORSE, and at least one
 * strictly better. tests/upgrade-nodes.test.js computes them and fails
 * otherwise, so "strictly better in every way" is not expressible in this
 * schema. That is the whole point of patching physics rather than adding
 * bonuses: a heavier arrow is slower, a narrower head carries less, and mail
 * that stops a bodkin also tires the arm that draws.
 */


/**
 * SHAPE OF A BRANCH: every dwelling offers all four trades it can physically
 * carry, on one root.
 *
 * A WEAPON node anybody can start, and three that require it — ARMOUR, ENDURANCE
 * (soak more before one falls) and WEIGHT (a heavier blow, bought with armour the
 * troops stop wearing to swing it). Depth 2, four nodes, one root.
 *
 * IT USED TO BE THREE — armour plus ONE of endurance or weight, chosen per
 * dwelling — and the fourth was added because the tree ran out. At a 160-day
 * horizon `scripts/sim/constraints.mjs` found every faction finishing its
 * branches by about day 110-130 and then idling for a quarter of the campaign,
 * which is I7 ("the tree must exceed the budget") failing against the calendar
 * rather than against the purse. Widening every dwelling by one node moved the
 * per-faction tree from 303 crew-days to 404 and the idle share at 160 days from
 * as much as 38% to 26% in one faction and under 17% everywhere else.
 *
 * The shape is also more regular than it was, which was the other half of the
 * argument: a player used to meet three questions at a dwelling and a DIFFERENT
 * three at the next one, because which of endurance or weight appeared was
 * authored case by case. Now the same four questions are asked everywhere they
 * can be asked, and the exceptions below are exceptions for a physical reason
 * rather than an editorial one.
 *
 * A BOW LINE HAS NO WEIGHT TRADE, and this is a finding rather than an omission.
 * Weight everywhere else means a heavier weapon swung with more energy; an arrow
 * cannot have that, because the BOW stores the energy and the roster's bows
 * already sit high in the 40-175 J band that PHYS_BOUNDS allows. A Medusa's
 * +20% shot runs to 195 J stored, and stacking one on Heavy Draw takes the Wood
 * Elf to 194 J — bows that do not exist. Adding mass alone instead pushes the
 * head base past 12 mm, which is a head no smith forges. So the arrow dwellings
 * take PRECISION as their fourth trade (tighter groups, bought with shaft
 * energy), except the Homestead, which already had precision and takes the one
 * form of weight a bow does allow: a heavier shaft at the SAME draw, which is
 * sectional density bought with coverage and touches neither energy nor
 * pressure. See `homestead.forge.warShafts`.
 *
 * The Homestead remains the reference branch and remains the widest, because it
 * was built while the schema was being discovered; copying its irregularity
 * everywhere would have made the irregularity look like a rule.
 *
 * THE FOUR TRADES, and why these and not others. Each is a real coupling in the
 * damage model, not a designer's tax:
 *
 *   weapon     a narrower striking surface concentrates the same blow (pressure
 *              and sectional density rise) but a keener edge is a lighter one, so
 *              the blow carries less energy
 *   armour     a harder material over more of the body, paid for in the energy an
 *              armoured arm can put into a swing or a draw
 *   endurance  more punishment absorbed before one falls, at the cost of bulkier
 *              tackle that spreads the blow it lands
 *   weight     a heavier, harder-hitting weapon needs both hands, so the shield
 *              and some of the harness come off
 *   precision  a slower, steadier release groups the shot tighter, paid for in
 *              the energy a held draw loses — the bow line's fourth trade, since
 *              it cannot have weight (above)
 *
 * `set` for armour and `mul` for everything else, per §3: material substitutes,
 * training compounds. Each armour node names a hardness ABOVE both creatures the
 * dwelling musters, so the base unit gains more than its upgrade — I5's
 * conditional effectiveness falling out of the physics rather than authored in.
 *
 * NO FORKS. `excludes` is empty everywhere, and that is a decision rather than an
 * oversight: a fork must first clear the conditioning pre-check in
 * src/core/conditioning.js (§8i — the one the fletchery fork did not get), and
 * none of these were built to be one. The tripwire in upgrade-nodes.test.js
 * stands.
 *
 * COSTS climb with the dwelling's tier and lean on the materials that have no
 * income until a cavern is taken — crystal and gems from tier 5 up — so the
 * binding constraint migrates off gold as a realm matures (§5, and
 * scripts/sim/constraints.mjs reports which one binds).
 *
 * BOTH RARES, and for a while only one of them was real. The schedule charged
 * crystal 12 / 17 / 21 against gems 0 / 13 / 25, which is 200 crystal to 152
 * gems per faction — and a town's own buildings eat crystal too, 33 at the
 * baseline and 75-89 for Rampart, Tower and Stronghold. Measured over 160 days
 * the player finished on 9-14 crystal and 33-219 GEMS: the third act was always
 * `materials:crystal`, and gems were a number that accumulated. Moving 2 units a
 * node from crystal to gems at tier 5 and 3 at tier 6 (180 crystal against 172
 * gems) makes the act alternate between the two, and took six of the nine
 * factions from not finishing their tree to finishing it.
 */
const ALL_UPGRADE_NODES = {
  // ========================= CASTLE — GUARDHOUSE =========================
  // Pikemen and Halberdiers: a hedge of polearms. The weapon node lengthens the
  // shaft rather than sharpening it, because reach is what a pike is for.

  'guardhouse.drill.longPikes': {
    name: 'Long Pikes',
    branch: 'drill', dwelling: 'dwelling1', faction: 'castle',
    creatures: ['pikeman', 'halberdier'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'masons', count: 1, days: 5 },
    // A longer shaft is more mass at the end of a longer lever: a fifth more
    // energy in the thrust and a quarter more steel behind the point. Both hands
    // stay on the haft, so the shield comes off and coverage drops a tenth.
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.18 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Eighteen-foot shafts: +18% thrust energy, −10% armour coverage.',
  },

  'guardhouse.drill.groundedStance': {
    name: 'Grounded Stance',
    branch: 'drill', dwelling: 'dwelling1', faction: 'castle',
    creatures: ['pikeman', 'halberdier'],
    requires: ['guardhouse.drill.longPikes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    // Butt-spiked and braced against the ground. A braced line takes a charge
    // instead of being carried by it — but a man rooted to his footing puts less
    // of himself into the thrust.
    effects: { woundEnergy_j: { mul: 1.18 }, blowEnergy_j: { mul: 0.92 } },
    desc: 'Braced and butt-spiked: +18% toughness, −8% thrust energy.',
  },

  'guardhouse.armoury.brigandine': {
    name: 'Brigandine',
    branch: 'armoury', dwelling: 'dwelling1', faction: 'castle',
    creatures: ['pikeman', 'halberdier'],
    requires: ['guardhouse.drill.longPikes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { armorHardness_gpa: { set: 0.26 }, armorCoverage_frac: { mul: 1.08 }, blowEnergy_j: { mul: 0.94 } },
    desc: 'Riveted plates in canvas (0.26 GPa) over more of the body, −6% thrust.',
  },

  'guardhouse.forge.weightedHeads': {
    name: 'Weighted Heads',
    branch: 'forge', dwelling: 'dwelling1', faction: 'castle',
    creatures: ['pikeman', 'halberdier'],
    requires: ['guardhouse.drill.longPikes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Lead-cored spearheads: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================= CASTLE — ARCHERS' TOWER =======================
  // The only Castle branch whose blow is a projectile, so it is the only one
  // where the shot group is a real output — and where PHYS_BOUNDS applies.

  'archersTower.bowyer.heavyLimbs': {
    name: 'Heavy Limbs',
    branch: 'bowyer', dwelling: 'dwelling2', faction: 'castle',
    creatures: ['archer', 'marksman'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    // Same trade the Homestead's Heavy Draw makes and deliberately a smaller one:
    // the Marksman's bow already stores 118 J against a 175 J ceiling, so +32%
    // would put the tower's own upgrade outside what a bow can hold. Priced to
    // what the roster leaves room for, not to what the Elves got.
    effects: { blowEnergy_j: { mul: 1.22 }, dispersion_rad: { mul: 1.2 } },
    desc: 'Stiffer limbs: +22% arrow energy, groups open 20%.',
  },

  'archersTower.bowyer.bodkinPoints': {
    name: 'Bodkin Points',
    branch: 'bowyer', dwelling: 'dwelling2', faction: 'castle',
    creatures: ['archer', 'marksman'],
    requires: ['archersTower.bowyer.heavyLimbs'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    // A narrow square point on a lighter shaft: the same joules through 60% of
    // the area. Lighter costs a little, because a bow hands a smaller FRACTION of
    // what it stores to a light arrow — the rest stays in the limbs.
    effects: { blowMass_kg: { mul: 0.9 }, blowEnergy_j: { mul: 0.97 }, contactArea_m2: { mul: 0.6 } },
    desc: 'Needle points: −3% energy, +62% impact pressure. For armour.',
  },

  'archersTower.armoury.towerGuard': {
    name: 'Tower Guard',
    branch: 'armoury', dwelling: 'dwelling2', faction: 'castle',
    creatures: ['archer', 'marksman'],
    requires: ['archersTower.bowyer.heavyLimbs'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { armorHardness_gpa: { set: 0.2 }, armorCoverage_frac: { mul: 1.1 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Mail and a padded jack (0.20 GPa) for the shooting line, −7% draw.',
  },

  'archersTower.drill.wallDiscipline': {
    name: 'Wall Discipline',
    branch: 'drill', dwelling: 'dwelling2', faction: 'castle',
    creatures: ['archer', 'marksman'],
    requires: ['archersTower.bowyer.heavyLimbs'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.18 }, blowEnergy_j: { mul: 0.92 } },
    desc: 'Reliefs and cover on the wall: +18% toughness, −8% shot energy.',
  },

  // ======================== CASTLE — GRIFFIN TOWER ========================

  'griffinTower.mews.honedTalons': {
    name: 'Honed Talons',
    branch: 'mews', dwelling: 'dwelling3', faction: 'castle',
    creatures: ['griffin', 'royalGriffin'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Filed and capped talons: +37% impact pressure, −4% energy.',
  },

  'griffinTower.mews.warBarding': {
    name: 'War Barding',
    branch: 'mews', dwelling: 'dwelling3', faction: 'castle',
    creatures: ['griffin', 'royalGriffin'],
    requires: ['griffinTower.mews.honedTalons'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    // A griffin wears almost nothing (0.022 GPa is feather and hide), so boiled
    // leather and a chest plate is the largest proportional jump on the roster —
    // and the flying weight is paid straight out of the stoop.
    effects: { armorHardness_gpa: { set: 0.05 }, armorCoverage_frac: { mul: 1.08 }, blowEnergy_j: { mul: 0.92 } },
    desc: 'Hardened leather and a chest plate (0.05 GPa), −8% stoop energy.',
  },

  'griffinTower.mews.stoopTraining': {
    name: 'Stoop Training',
    branch: 'mews', dwelling: 'dwelling3', faction: 'castle',
    creatures: ['griffin', 'royalGriffin'],
    requires: ['griffinTower.mews.honedTalons'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { blowMass_kg: { mul: 1.15 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A longer dive: +20% strike energy, −10% barding carried.',
  },

  'griffinTower.drill.eyrieConditioning': {
    name: 'Eyrie Conditioning',
    branch: 'drill', dwelling: 'dwelling3', faction: 'castle',
    creatures: ['griffin', 'royalGriffin'],
    requires: ['griffinTower.mews.honedTalons'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Hard-flown and deep-chested: +20% toughness, −18% impact pressure.',
  },

  // =========================== CASTLE — BARRACKS ===========================

  'barracks.armoury.temperedEdge': {
    name: 'Tempered Edge',
    branch: 'armoury', dwelling: 'dwelling4', faction: 'castle',
    creatures: ['swordsman', 'crusader'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Differentially tempered blades: +37% impact pressure, −4% energy.',
  },

  'barracks.armoury.plateHarness': {
    name: 'Plate Harness',
    branch: 'armoury', dwelling: 'dwelling4', faction: 'castle',
    creatures: ['swordsman', 'crusader'],
    requires: ['barracks.armoury.temperedEdge'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.52 }, armorCoverage_frac: { mul: 1.08 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Full harness (0.52 GPa) over more of the body, −7% cut energy.',
  },

  'barracks.drill.shieldWall': {
    name: 'Shield Wall',
    branch: 'drill', dwelling: 'dwelling4', faction: 'castle',
    creatures: ['swordsman', 'crusader'],
    requires: ['barracks.armoury.temperedEdge'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Locked shields: +20% toughness, −18% impact pressure.',
  },

  'barracks.forge.greatswords': {
    name: 'Greatswords',
    branch: 'forge', dwelling: 'dwelling4', faction: 'castle',
    creatures: ['swordsman', 'crusader'],
    requires: ['barracks.armoury.temperedEdge'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Both hands to the hilt: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================== CASTLE — MONASTERY ==========================
  // Monks throw force rather than swing it — they carry a dispersion, so the
  // shot group is a live output here as it is for the archers.

  'monastery.scriptorium.focusedBolt': {
    name: 'Focused Bolt',
    branch: 'scriptorium', dwelling: 'dwelling5', faction: 'castle',
    creatures: ['monk', 'zealot'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { dispersion_rad: { mul: 0.78 }, blowEnergy_j: { mul: 0.9 } },
    desc: 'A narrower cast: groups tighten 22%, −10% energy.',
  },

  'monastery.scriptorium.channelledForce': {
    name: 'Channelled Force',
    branch: 'scriptorium', dwelling: 'dwelling5', faction: 'castle',
    creatures: ['monk', 'zealot'],
    requires: ['monastery.scriptorium.focusedBolt'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { blowEnergy_j: { mul: 1.25 }, dispersion_rad: { mul: 1.18 } },
    desc: 'A harder cast: +25% energy, groups open 18%.',
  },

  'monastery.armoury.blessedVestments': {
    name: 'Blessed Vestments',
    branch: 'armoury', dwelling: 'dwelling5', faction: 'castle',
    creatures: ['monk', 'zealot'],
    requires: ['monastery.scriptorium.focusedBolt'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    // A Monk wears 0.06 GPa of cloth over a fifth of himself. Everything here is
    // a large proportional gain and it still costs the cast, because a weighted
    // sleeve is a weighted sleeve whatever is embroidered on it.
    effects: { armorHardness_gpa: { set: 0.16 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.94 } },
    desc: 'Weighted, warded cloth (0.16 GPa) over more of the body, −6% cast.',
  },

  'monastery.drill.longerVigils': {
    name: 'Longer Vigils',
    branch: 'drill', dwelling: 'dwelling5', faction: 'castle',
    creatures: ['monk', 'zealot'],
    requires: ['monastery.scriptorium.focusedBolt'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.18 }, blowEnergy_j: { mul: 0.92 } },
    desc: 'Fasting and the night office: +18% toughness, −8% shot energy.',
  },

  // ======================= CASTLE — TRAINING GROUNDS =======================

  'trainingGrounds.lists.couchedLance': {
    name: 'Couched Lance',
    branch: 'lists', dwelling: 'dwelling6', faction: 'castle',
    creatures: ['cavalier', 'champion'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.65 }, blowEnergy_j: { mul: 0.97 } },
    desc: 'A steel coronel on a rest: +49% impact pressure, −3% energy.',
  },

  'trainingGrounds.lists.barding': {
    name: 'Full Barding',
    branch: 'lists', dwelling: 'dwelling6', faction: 'castle',
    creatures: ['cavalier', 'champion'],
    requires: ['trainingGrounds.lists.couchedLance'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.55 }, armorCoverage_frac: { mul: 1.08 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Horse and rider in plate (0.55 GPa), −7% charge energy.',
  },

  'trainingGrounds.lists.destriers': {
    name: 'Destriers',
    branch: 'lists', dwelling: 'dwelling6', faction: 'castle',
    creatures: ['cavalier', 'champion'],
    requires: ['trainingGrounds.lists.couchedLance'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Heavier warhorses: +20% charge energy, −10% barding carried.',
  },

  'trainingGrounds.drill.tiltDrill': {
    name: 'Tilt Drill',
    branch: 'drill', dwelling: 'dwelling6', faction: 'castle',
    creatures: ['cavalier', 'champion'],
    requires: ['trainingGrounds.lists.couchedLance'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Endless tilting in full harness: +20% toughness, −18% impact pressure.',
  },

  // ======================= CASTLE — PORTAL OF GLORY =======================

  'portalOfGlory.reliquary.flamingBrand': {
    name: 'Flaming Brand',
    branch: 'reliquary', dwelling: 'dwelling7', faction: 'castle',
    creatures: ['angel', 'archangel'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A narrower, hotter blade: +37% impact pressure, −4% energy.',
  },

  'portalOfGlory.reliquary.aegis': {
    name: 'Aegis',
    branch: 'reliquary', dwelling: 'dwelling7', faction: 'castle',
    creatures: ['angel', 'archangel'],
    requires: ['portalOfGlory.reliquary.flamingBrand'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    // The Archangel already wears 0.85 of itself, so the coverage multiplier is
    // the smallest in the tree — anything larger would be clamped rather than
    // paid for, and a node whose effect the clamp eats is a node that lies.
    effects: { armorHardness_gpa: { set: 0.9 }, armorCoverage_frac: { mul: 1.05 }, blowEnergy_j: { mul: 0.94 } },
    desc: 'Consecrated plate (0.90 GPa) over more of the host, −6% strike.',
  },

  'portalOfGlory.reliquary.hostsEndurance': {
    name: "Host's Endurance",
    branch: 'reliquary', dwelling: 'dwelling7', faction: 'castle',
    creatures: ['angel', 'archangel'],
    requires: ['portalOfGlory.reliquary.flamingBrand'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.18 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Unbreaking host: +18% toughness, −17% impact pressure.',
  },

  'portalOfGlory.forge.greaterBrand': {
    name: 'Greater Brand',
    branch: 'forge', dwelling: 'dwelling7', faction: 'castle',
    creatures: ['angel', 'archangel'],
    requires: ['portalOfGlory.reliquary.flamingBrand'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A brand swung from the shoulder: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================= RAMPART — HOMESTEAD =======================
  // The reference branch. The Homestead recruits Wood Elves and, upgraded,
  // Grand Elves — the same archers with better tackle, which is exactly the
  // thing a parameter patch describes and a flat stat bonus does not.

  'homestead.fletchery.drawWeight': {
    name: 'Heavy Draw',
    branch: 'fletchery', dwelling: 'dwelling3', faction: 'rampart',
    creatures: ['woodElf', 'grandElf'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    // A stiffer bow stores +32% more energy. What that becomes at the target
    // depends on the shaft it is spent on — v = sqrt(2E/m) — so this buys energy
    // and lets the head decide how it arrives. Harder to hold at full draw, so
    // the group opens by a fifth.
    // RE-COST BY THE DROP COUPLING, not by taste. Once `blowSpeed_mps` started
    // reaching the hit fraction, more draw weight at the same head mass meant a FASTER
    // arrow, a flatter arc and less drop error — so Heavy Draw quietly gained accuracy
    // at range and its stated tradeoff ("worse far out") stopped holding: the wiring
    // test read 40 against 38 where it needs the group to cost more than the energy
    // buys. The physics is right and the node's price was stale, so the price moves.
    effects: { blowEnergy_j: { mul: 1.32 }, dispersion_rad: { mul: 1.28 } },
    desc: 'Stiffer bows: +15% arrow speed (+32% energy), groups open 20%.',
  },

  // ---- THE FORK WAS CUT — see docs/PHYSICAL_MODEL.md §8i ----
  //
  // Two nodes stood here: Bodkin Heads (narrow, for armour) and Broadheads (wide, for
  // flesh), each excluding the other. Three mechanisms were built to make that a real
  // choice — taper, the arrest solver, the width term — each landed as specified, and
  // none produced a fork. The decisive objection is structural: a bodkin is under the
  // 22 mm cut-width threshold and never bleeds, so the width term's coefficient has no
  // balancing value at any setting. A parameter that can only push one way is not a
  // tuning knob.
  //
  // What is left is one head upgrade with no exclusion. The multipliers of the retired
  // pair live in src/core/retiredHeads.js so the instruments that measured them still
  // run, and so restoring the fork is an edit rather than a reconstruction.
  'homestead.fletchery.warHeads': {
    name: 'War Heads',
    branch: 'fletchery', dwelling: 'dwelling3', faction: 'rampart',
    creatures: ['woodElf', 'grandElf'],
    requires: ['homestead.fletchery.drawWeight'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    // The narrow head, kept because it is the one the model favours across the roster
    // and the one with a historical reason to exist. Lighter and much narrower: the same
    // joules through 55% of the area. The lightness costs a little, because a bow
    // transfers a smaller FRACTION of its stored energy to a light arrow — more of it
    // stays in the limbs. A real effect and a small one (−4%).
    //
    // The multipliers are UNCHANGED from the node this replaces. Re-authoring them while
    // cutting would confound the cut with a balance change, and the whole finding here is
    // that these numbers are `feel` and load-bearing — moving them on the way out is
    // exactly the move that produced the situation.
    effects: { blowMass_kg: { mul: 0.85 }, blowEnergy_j: { mul: 0.96 }, contactArea_m2: { mul: 0.55 } },
    desc: 'Needle heads: −4% energy, +82% impact pressure. For armour.',
  },

  'homestead.fletchery.steadyStance': {
    name: 'Steady Stance',
    branch: 'fletchery', dwelling: 'dwelling3', faction: 'rampart',
    creatures: ['woodElf', 'grandElf'],
    requires: ['homestead.fletchery.drawWeight'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    // Deliberate release: a quarter tighter group, at the cost of a slower,
    // more careful loose. Buys back what Heavy Draw spent, differently.
    effects: { dispersion_rad: { mul: 0.75 }, blowEnergy_j: { mul: 0.865 } },
    desc: 'Deliberate loose: groups tighten 25%, −13% energy.',
  },

  'homestead.armoury.wardensMail': {
    name: "Wardens' Mail",
    branch: 'armoury', dwelling: 'dwelling3', faction: 'rampart',
    creatures: ['woodElf', 'grandElf'],
    requires: ['homestead.fletchery.drawWeight'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    // Mail over more of the body. It is also weight on the drawing arm and a
    // sleeve in the way of the string: the draw they can hold all day is a
    // shorter one, so the bow stores less. Paid in ENERGY, not in arrow mass —
    // mass is what the shaft is, and mail does not change the shaft.
    effects: { armorHardness_gpa: { set: 0.12 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Riveted mail (0.12 GPa) over more of the body, −7% draw.',
  },

  'homestead.armoury.silvanVigil': {
    name: 'Silvan Vigil',
    branch: 'armoury', dwelling: 'dwelling3', faction: 'rampart',
    creatures: ['woodElf', 'grandElf'],
    requires: ['homestead.fletchery.steadyStance'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    // Elves who will not go down: a fifth more punishment absorbed before one
    // falls. The tackle that keeps them standing is bulkier at the head.
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.25 } },
    desc: 'Hardened wardens: +20% toughness, −20% impact pressure.',
  },

  'homestead.forge.warShafts': {
    name: 'War Shafts',
    branch: 'forge', dwelling: 'dwelling3', faction: 'rampart',
    creatures: ['woodElf', 'grandElf'],
    requires: ['homestead.fletchery.drawWeight'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    // THE WEIGHT TRADE AS A BOW CAN TAKE IT, which is not how a melee dwelling
    // takes it. Everywhere else the heavier weapon also swings with more energy;
    // an arrow cannot, because the bow is what stores the energy and the Elves'
    // already sits high in the 40-175 J band. Stack Heavy Draw on top of a
    // +20% shot and the pair runs to 194 J, which is a bow that does not exist.
    //
    // So the shaft gets heavier at the SAME draw: more mass behind the same
    // joules is more sectional density, which is what carries a point through
    // mail, and the extra quiver comes off the harness. Energy and pressure do
    // not move at all — the whole trade is density against coverage.
    effects: { blowMass_kg: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Heavier war shafts off the same bow: +20% sectional density, −10% armour coverage.',
  },

  // ====================== RAMPART — CENTAUR STABLES ======================

  'centaurStables.paddock.ashSpears': {
    name: 'Ash Spears',
    branch: 'paddock', dwelling: 'dwelling1', faction: 'rampart',
    creatures: ['centaur', 'centaurCaptain'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Seasoned ash and a narrow head: +37% impact pressure, −4% energy.',
  },

  'centaurStables.paddock.scaleBarding': {
    name: 'Scale Barding',
    branch: 'paddock', dwelling: 'dwelling1', faction: 'rampart',
    creatures: ['centaur', 'centaurCaptain'],
    requires: ['centaurStables.paddock.ashSpears'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    // A centaur covers a fifth of a very large body: coverage is where the gain
    // is, and it is the widest multiplier in the tree because there is that much
    // uncovered horse to put scale on.
    effects: { armorHardness_gpa: { set: 0.5 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Scale over the barrel (0.50 GPa) and more of it, −7% thrust.',
  },

  'centaurStables.paddock.skirmishDrill': {
    name: 'Skirmish Drill',
    branch: 'paddock', dwelling: 'dwelling1', faction: 'rampart',
    creatures: ['centaur', 'centaurCaptain'],
    requires: ['centaurStables.paddock.ashSpears'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Wheel and re-form: +25% toughness, −17% impact pressure.',
  },

  'centaurStables.forge.ironedShafts': {
    name: 'Ironed Shafts',
    branch: 'forge', dwelling: 'dwelling1', faction: 'rampart',
    creatures: ['centaur', 'centaurCaptain'],
    requires: ['centaurStables.paddock.ashSpears'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Iron-shod butts and thicker ash: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================= RAMPART — DWARF COTTAGE =======================

  'dwarfCottage.forge.hardenedHeads': {
    name: 'Hardened Heads',
    branch: 'forge', dwelling: 'dwelling2', faction: 'rampart',
    creatures: ['dwarf', 'battleDwarf'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Case-hardened axe bits: +37% impact pressure, −4% energy.',
  },

  'dwarfCottage.forge.deepMail': {
    name: 'Deep Mail',
    branch: 'forge', dwelling: 'dwelling2', faction: 'rampart',
    creatures: ['dwarf', 'battleDwarf'],
    requires: ['dwarfCottage.forge.hardenedHeads'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    // A Battle Dwarf is already armoured over 0.84 of itself, which is why the
    // coverage multiplier here is 1.05 — the clamp would eat anything larger and
    // the player would have paid for a number that never landed.
    effects: { armorHardness_gpa: { set: 0.42 }, armorCoverage_frac: { mul: 1.05 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Mountain mail (0.42 GPa) over more of a short body, −7% swing.',
  },

  'dwarfCottage.forge.greatHammers': {
    name: 'Great Hammers',
    branch: 'forge', dwelling: 'dwelling2', faction: 'rampart',
    creatures: ['dwarf', 'battleDwarf'],
    requires: ['dwarfCottage.forge.hardenedHeads'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { blowMass_kg: { mul: 1.3 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Two-handed mauls: +20% blow energy, −10% armour worn.',
  },

  'dwarfCottage.drill.mountainWind': {
    name: 'Mountain Wind',
    branch: 'drill', dwelling: 'dwelling2', faction: 'rampart',
    creatures: ['dwarf', 'battleDwarf'],
    requires: ['dwarfCottage.forge.hardenedHeads'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Bred to the thin air of the deep roads: +20% toughness, −18% impact pressure.',
  },

  // ====================== RAMPART — ENCHANTED SPRING ======================

  'enchantedSpring.spring.honedHooves': {
    name: 'Honed Hooves',
    branch: 'spring', dwelling: 'dwelling4', faction: 'rampart',
    creatures: ['pegasus', 'silverPegasus'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Shod and pared: +37% impact pressure, −4% energy.',
  },

  'enchantedSpring.spring.wardedFlanks': {
    name: 'Warded Flanks',
    branch: 'spring', dwelling: 'dwelling4', faction: 'rampart',
    creatures: ['pegasus', 'silverPegasus'],
    requires: ['enchantedSpring.spring.honedHooves'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.22 }, armorCoverage_frac: { mul: 1.1 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Silvered plate at the flanks (0.22 GPa), −7% strike energy.',
  },

  'enchantedSpring.spring.divingCharge': {
    name: 'Diving Charge',
    branch: 'spring', dwelling: 'dwelling4', faction: 'rampart',
    creatures: ['pegasus', 'silverPegasus'],
    requires: ['enchantedSpring.spring.honedHooves'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { blowMass_kg: { mul: 1.2 }, blowEnergy_j: { mul: 1.22 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Strike out of the dive: +22% energy, −10% plate carried.',
  },

  'enchantedSpring.drill.highPastures': {
    name: 'High Pastures',
    branch: 'drill', dwelling: 'dwelling4', faction: 'rampart',
    creatures: ['pegasus', 'silverPegasus'],
    requires: ['enchantedSpring.spring.honedHooves'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Grown on thin mountain grass: +20% toughness, −18% impact pressure.',
  },

  // ====================== RAMPART — DENDROID ARCHES ======================
  // The one branch whose root is the armour node: a dendroid IS its bark, and
  // sharpening a tree is the odd request, not armouring one.

  'dendroidArches.grove.ironBark': {
    name: 'Iron Bark',
    branch: 'grove', dwelling: 'dwelling5', faction: 'rampart',
    creatures: ['dendroid', 'dendroidSoldier'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { armorHardness_gpa: { set: 0.26 }, armorCoverage_frac: { mul: 1.1 }, blowEnergy_j: { mul: 0.94 } },
    desc: 'Mineral-fed bark (0.26 GPa) over more of the trunk, −6% swing.',
  },

  'dendroidArches.grove.splitLimbs': {
    name: 'Split Limbs',
    branch: 'grove', dwelling: 'dwelling5', faction: 'rampart',
    creatures: ['dendroid', 'dendroidSoldier'],
    requires: ['dendroidArches.grove.ironBark'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Splintered striking limbs: +37% impact pressure, −4% energy.',
  },

  'dendroidArches.grove.deepRoots': {
    name: 'Deep Roots',
    branch: 'grove', dwelling: 'dwelling5', faction: 'rampart',
    creatures: ['dendroid', 'dendroidSoldier'],
    requires: ['dendroidArches.grove.ironBark'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Rooted and fed: +25% toughness, −17% impact pressure.',
  },

  'dendroidArches.forge.heartwoodLimbs': {
    name: 'Heartwood Limbs',
    branch: 'forge', dwelling: 'dwelling5', faction: 'rampart',
    creatures: ['dendroid', 'dendroidSoldier'],
    requires: ['dendroidArches.grove.ironBark'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Limbs grown from the heartwood: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================= RAMPART — UNICORN GLADE =======================

  'unicornGlade.glade.spiralHorn': {
    name: 'Spiral Horn',
    branch: 'glade', dwelling: 'dwelling6', faction: 'rampart',
    creatures: ['unicorn', 'warUnicorn'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.72 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A finer spiral to the point: +33% impact pressure, −4% energy.',
  },

  'unicornGlade.glade.silverCaparison': {
    name: 'Silver Caparison',
    branch: 'glade', dwelling: 'dwelling6', faction: 'rampart',
    creatures: ['unicorn', 'warUnicorn'],
    requires: ['unicornGlade.glade.spiralHorn'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.3 }, armorCoverage_frac: { mul: 1.2 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Silvered mail beneath the caparison (0.30 GPa), −7% charge.',
  },

  'unicornGlade.glade.gladeVigil': {
    name: 'Glade Vigil',
    branch: 'glade', dwelling: 'dwelling6', faction: 'rampart',
    creatures: ['unicorn', 'warUnicorn'],
    requires: ['unicornGlade.glade.spiralHorn'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Warded and watchful: +20% toughness, −18% impact pressure.',
  },

  'unicornGlade.forge.fullCareer': {
    name: 'Full Career',
    branch: 'forge', dwelling: 'dwelling6', faction: 'rampart',
    creatures: ['unicorn', 'warUnicorn'],
    requires: ['unicornGlade.glade.spiralHorn'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A longer run at the charge: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================= RAMPART — DRAGON CLIFFS =======================

  'dragonCliffs.cliffs.rendingClaws': {
    name: 'Rending Claws',
    branch: 'cliffs', dwelling: 'dwelling7', faction: 'rampart',
    creatures: ['greenDragon', 'goldDragon'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Sharpened and capped claws: +37% impact pressure, −4% energy.',
  },

  'dragonCliffs.cliffs.scaleTempering': {
    name: 'Scale Tempering',
    branch: 'cliffs', dwelling: 'dwelling7', faction: 'rampart',
    creatures: ['greenDragon', 'goldDragon'],
    requires: ['dragonCliffs.cliffs.rendingClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    // A Green Dragon's hide is 0.086 GPa against a Gold's 0.179 — the widest gap
    // any dwelling's pair carries, so this is the clearest case in the tree of a
    // material swap being worth more to the base unit than to its upgrade.
    effects: { armorHardness_gpa: { set: 0.22 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Fire-tempered scale (0.22 GPa) over more of the flank, −7% strike.',
  },

  'dragonCliffs.cliffs.wingBuffet': {
    name: 'Wing Buffet',
    branch: 'cliffs', dwelling: 'dwelling7', faction: 'rampart',
    creatures: ['greenDragon', 'goldDragon'],
    requires: ['dragonCliffs.cliffs.rendingClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Strike with the whole wing: +20% energy, −10% scale carried.',
  },

  'dragonCliffs.drill.scarredHide': {
    name: 'Scarred Hide',
    branch: 'drill', dwelling: 'dwelling7', faction: 'rampart',
    creatures: ['greenDragon', 'goldDragon'],
    requires: ['dragonCliffs.cliffs.rendingClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Old burns healed over thick scale: +20% toughness, −18% impact pressure.',
  },

  // ========================== TOWER — WORKSHOP ==========================
  // Servitors, and the first dwelling on the roster whose UPGRADE gains a ranged
  // attack. Nothing here patches `dispersion_rad`: a Servitor is melee and has no
  // shot group, so a multiplier on it would improve the Master Servitor and do
  // literally nothing for its base — which the "improves something" rule would
  // catch, and which would be bad content even if it did not.

  'workshop.bench.keenerTools': {
    name: 'Keener Tools',
    branch: 'bench', dwelling: 'dwelling1', faction: 'tower',
    creatures: ['servitor', 'masterServitor'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Ground edges and sharpened darts: +37% impact pressure, −4% energy.',
  },

  'workshop.bench.platedShells': {
    name: 'Plated Shells',
    branch: 'bench', dwelling: 'dwelling1', faction: 'tower',
    creatures: ['servitor', 'masterServitor'],
    requires: ['workshop.bench.keenerTools'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { armorHardness_gpa: { set: 0.14 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Riveted shells (0.14 GPa) over more of a small body, −7% blow.',
  },

  'workshop.bench.wardedFrames': {
    name: 'Warded Frames',
    branch: 'bench', dwelling: 'dwelling1', faction: 'tower',
    creatures: ['servitor', 'masterServitor'],
    requires: ['workshop.bench.keenerTools'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Bound and braced: +20% toughness, −17% impact pressure.',
  },

  'workshop.forge.ballastedFrames': {
    name: 'Ballasted Frames',
    branch: 'forge', dwelling: 'dwelling1', faction: 'tower',
    creatures: ['servitor', 'masterServitor'],
    requires: ['workshop.bench.keenerTools'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Lead in the frame behind the tool: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // =========================== TOWER — PARAPET ===========================

  'parapet.mason.chiselledClaws': {
    name: 'Chiselled Claws',
    branch: 'mason', dwelling: 'dwelling2', faction: 'tower',
    creatures: ['stoneGargoyle', 'obsidianGargoyle'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Re-cut talons: +37% impact pressure, −4% energy.',
  },

  'parapet.mason.basaltCore': {
    name: 'Basalt Core',
    branch: 'mason', dwelling: 'dwelling2', faction: 'tower',
    creatures: ['stoneGargoyle', 'obsidianGargoyle'],
    requires: ['parapet.mason.chiselledClaws'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    // 0.95 GPa is above the Obsidian Gargoyle's own 0.80, so the base gains far
    // more than its upgrade — the material-swap rule doing its work on the
    // hardest-skinned pair in the game short of the golems.
    effects: { armorHardness_gpa: { set: 0.95 }, armorCoverage_frac: { mul: 1.05 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Recarved in basalt (0.95 GPa) over more of the body, −7% strike.',
  },

  'parapet.mason.divingWeight': {
    name: 'Diving Weight',
    branch: 'mason', dwelling: 'dwelling2', faction: 'tower',
    creatures: ['stoneGargoyle', 'obsidianGargoyle'],
    requires: ['parapet.mason.chiselledClaws'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Heavier at the leading edge: +20% energy, −10% shell carried.',
  },

  'parapet.drill.weatheredStone': {
    name: 'Weathered Stone',
    branch: 'drill', dwelling: 'dwelling2', faction: 'tower',
    creatures: ['stoneGargoyle', 'obsidianGargoyle'],
    requires: ['parapet.mason.chiselledClaws'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Seasoned through a hundred winters: +20% toughness, −18% impact pressure.',
  },

  // ======================== TOWER — GOLEM FACTORY ========================

  'golemFactory.forge.hardenedFists': {
    name: 'Hardened Fists',
    branch: 'forge', dwelling: 'dwelling3', faction: 'tower',
    creatures: ['stoneGolem', 'ironGolem'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A struck face rather than a flat one: +37% pressure, −4% energy.',
  },

  'golemFactory.forge.temperedShell': {
    name: 'Tempered Shell',
    branch: 'forge', dwelling: 'dwelling3', faction: 'tower',
    creatures: ['stoneGolem', 'ironGolem'],
    requires: ['golemFactory.forge.hardenedFists'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    // A golem is already armoured over 0.95 of itself, so coverage moves by 3%
    // and not more: the clamp at 1.0 would eat anything larger, and a node whose
    // effect the clamp eats is a node that lies about what it sold you.
    effects: { armorHardness_gpa: { set: 1.4 }, armorCoverage_frac: { mul: 1.03 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Case-hardened to 1.40 GPa — the hardest body on the roster, −7% blow.',
  },

  'golemFactory.forge.counterweights': {
    name: 'Counterweights',
    branch: 'forge', dwelling: 'dwelling3', faction: 'tower',
    creatures: ['stoneGolem', 'ironGolem'],
    requires: ['golemFactory.forge.hardenedFists'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { blowMass_kg: { mul: 1.3 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Weighted arms: +20% blow energy, −10% shell carried.',
  },

  'golemFactory.drill.packedCore': {
    name: 'Packed Core',
    branch: 'drill', dwelling: 'dwelling3', faction: 'tower',
    creatures: ['stoneGolem', 'ironGolem'],
    requires: ['golemFactory.forge.hardenedFists'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Cores packed dense against a hard blow: +20% toughness, −18% impact pressure.',
  },

  // ========================== TOWER — MAGE TOWER ==========================

  'mageTower.study.focusedBolt': {
    name: 'Focused Bolt',
    branch: 'study', dwelling: 'dwelling4', faction: 'tower',
    creatures: ['mage', 'archMage'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { dispersion_rad: { mul: 0.78 }, blowEnergy_j: { mul: 0.9 } },
    desc: 'A narrower cast: groups tighten 22%, −10% energy.',
  },

  'mageTower.study.chargedCasting': {
    name: 'Charged Casting',
    branch: 'study', dwelling: 'dwelling4', faction: 'tower',
    creatures: ['mage', 'archMage'],
    requires: ['mageTower.study.focusedBolt'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { blowEnergy_j: { mul: 1.25 }, dispersion_rad: { mul: 1.18 } },
    desc: 'A harder cast: +25% energy, groups open 18%.',
  },

  'mageTower.study.wardedRobes': {
    name: 'Warded Robes',
    branch: 'study', dwelling: 'dwelling4', faction: 'tower',
    creatures: ['mage', 'archMage'],
    requires: ['mageTower.study.focusedBolt'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.15 }, armorCoverage_frac: { mul: 1.2 }, blowEnergy_j: { mul: 0.94 } },
    desc: 'Warded cloth (0.15 GPa) over far more of the body, −6% cast.',
  },

  'mageTower.drill.mnemonicDrill': {
    name: 'Mnemonic Drill',
    branch: 'drill', dwelling: 'dwelling4', faction: 'tower',
    creatures: ['mage', 'archMage'],
    requires: ['mageTower.study.focusedBolt'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.18 }, blowEnergy_j: { mul: 0.92 } },
    desc: 'Rote-drilled to hold a form under fire: +18% toughness, −8% shot energy.',
  },

  // ======================= TOWER — ALTAR OF WISHES =======================

  'altarOfWishes.altar.condensedForm': {
    name: 'Condensed Form',
    branch: 'altar', dwelling: 'dwelling5', faction: 'tower',
    creatures: ['genie', 'masterGenie'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Gathered to a point: +37% impact pressure, −4% energy.',
  },

  'altarOfWishes.altar.boundVeil': {
    name: 'Bound Veil',
    branch: 'altar', dwelling: 'dwelling5', faction: 'tower',
    creatures: ['genie', 'masterGenie'],
    requires: ['altarOfWishes.altar.condensedForm'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { armorHardness_gpa: { set: 0.24 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'A bound veil (0.24 GPa) over more of the form, −7% strike.',
  },

  'altarOfWishes.altar.gatheredStorm': {
    name: 'Gathered Storm',
    branch: 'altar', dwelling: 'dwelling5', faction: 'tower',
    creatures: ['genie', 'masterGenie'],
    requires: ['altarOfWishes.altar.condensedForm'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'More weather behind the blow: +20% energy, −10% veil held.',
  },

  'altarOfWishes.drill.boundEssence': {
    name: 'Bound Essence',
    branch: 'drill', dwelling: 'dwelling5', faction: 'tower',
    creatures: ['genie', 'masterGenie'],
    requires: ['altarOfWishes.altar.condensedForm'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Essence bound tighter to the vessel: +20% toughness, −18% impact pressure.',
  },

  // ======================= TOWER — GOLDEN PAVILION =======================

  'goldenPavilion.pavilion.pairedEdges': {
    name: 'Paired Edges',
    branch: 'pavilion', dwelling: 'dwelling6', faction: 'tower',
    creatures: ['naga', 'nagaQueen'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Every blade re-edged: +37% impact pressure, −4% energy.',
  },

  'goldenPavilion.pavilion.goldScale': {
    name: 'Gold Scale',
    branch: 'pavilion', dwelling: 'dwelling6', faction: 'tower',
    creatures: ['naga', 'nagaQueen'],
    requires: ['goldenPavilion.pavilion.pairedEdges'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.5 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Gilded scale (0.50 GPa) down more of the coil, −7% strike.',
  },

  'goldenPavilion.pavilion.coiledStrike': {
    name: 'Coiled Strike',
    branch: 'pavilion', dwelling: 'dwelling6', faction: 'tower',
    creatures: ['naga', 'nagaQueen'],
    requires: ['goldenPavilion.pavilion.pairedEdges'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Struck from the coil: +20% toughness, −17% impact pressure.',
  },

  'goldenPavilion.forge.weightedGlaives': {
    name: 'Weighted Glaives',
    branch: 'forge', dwelling: 'dwelling6', faction: 'tower',
    creatures: ['naga', 'nagaQueen'],
    requires: ['goldenPavilion.pavilion.pairedEdges'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Longer hafts and heavier heads: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================== TOWER — CLOUD TEMPLE ========================
  // The other mixed-reach dwelling: a Giant swings and a Titan throws lightning.
  // No dispersion patch here either, for the same reason as the Workshop.

  'cloudTemple.temple.stormcastArms': {
    name: 'Stormcast Arms',
    branch: 'temple', dwelling: 'dwelling7', faction: 'tower',
    creatures: ['giant', 'titan'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A struck fist and a tighter bolt: +37% pressure, −4% energy.',
  },

  'cloudTemple.temple.thunderplate': {
    name: 'Thunderplate',
    branch: 'temple', dwelling: 'dwelling7', faction: 'tower',
    creatures: ['giant', 'titan'],
    requires: ['cloudTemple.temple.stormcastArms'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.62 }, armorCoverage_frac: { mul: 1.08 }, blowEnergy_j: { mul: 0.94 } },
    desc: 'Cloud-forged plate (0.62 GPa) over more of them, −6% blow.',
  },

  'cloudTemple.temple.risingGale': {
    name: 'Rising Gale',
    branch: 'temple', dwelling: 'dwelling7', faction: 'tower',
    creatures: ['giant', 'titan'],
    requires: ['cloudTemple.temple.stormcastArms'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'The storm behind the arm: +20% energy, −10% plate carried.',
  },

  'cloudTemple.drill.thunderInured': {
    name: 'Thunder-Inured',
    branch: 'drill', dwelling: 'dwelling7', faction: 'tower',
    creatures: ['giant', 'titan'],
    requires: ['cloudTemple.temple.stormcastArms'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Raised in the storm that forged them: +20% toughness, −18% impact pressure.',
  },

  // ====================== NECROPOLIS — CURSED TEMPLE ======================

  'cursedTemple.ossuary.graveIron': {
    name: 'Grave Iron',
    branch: 'ossuary', dwelling: 'dwelling1', faction: 'necropolis',
    creatures: ['skeleton', 'skeletonWarrior'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Blades off the barrow floor: +37% pressure, −4% energy.',
  },

  'cursedTemple.ossuary.burialPlate': {
    name: 'Burial Plate',
    branch: 'ossuary', dwelling: 'dwelling1', faction: 'necropolis',
    creatures: ['skeleton', 'skeletonWarrior'],
    requires: ['cursedTemple.ossuary.graveIron'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { armorHardness_gpa: { set: 0.3 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'What they were buried in (0.30 GPa), over more of the frame, −7% blow.',
  },

  'cursedTemple.ossuary.knittedBone': {
    name: 'Knitted Bone',
    branch: 'ossuary', dwelling: 'dwelling1', faction: 'necropolis',
    creatures: ['skeleton', 'skeletonWarrior'],
    requires: ['cursedTemple.ossuary.graveIron'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Bound where it breaks: +25% toughness, −17% impact pressure.',
  },

  'cursedTemple.forge.boneMauls': {
    name: 'Bone Mauls',
    branch: 'forge', dwelling: 'dwelling1', faction: 'necropolis',
    creatures: ['skeleton', 'skeletonWarrior'],
    requires: ['cursedTemple.ossuary.graveIron'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Femur mauls swung two-handed: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================= NECROPOLIS — GRAVEYARD =========================

  'graveyard.pit.rendingHands': {
    name: 'Rending Hands',
    branch: 'pit', dwelling: 'dwelling2', faction: 'necropolis',
    creatures: ['walkingDead', 'zombie'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Nails and bone, not fists: +37% impact pressure, −4% energy.',
  },

  'graveyard.pit.gravewrap': {
    name: 'Gravewrap',
    branch: 'pit', dwelling: 'dwelling2', faction: 'necropolis',
    creatures: ['walkingDead', 'zombie'],
    requires: ['graveyard.pit.rendingHands'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { armorHardness_gpa: { set: 0.15 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Hardened wrappings (0.15 GPa) over more of it, −7% swing.',
  },

  'graveyard.pit.deadWeight': {
    name: 'Dead Weight',
    branch: 'pit', dwelling: 'dwelling2', faction: 'necropolis',
    creatures: ['walkingDead', 'zombie'],
    requires: ['graveyard.pit.rendingHands'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { blowMass_kg: { mul: 1.3 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'All of it behind the swing: +20% energy, −10% wrapping.',
  },

  'graveyard.drill.packedGraveclothes': {
    name: 'Packed Graveclothes',
    branch: 'drill', dwelling: 'dwelling2', faction: 'necropolis',
    creatures: ['walkingDead', 'zombie'],
    requires: ['graveyard.pit.rendingHands'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Wound in layer on layer of linen: +20% toughness, −18% impact pressure.',
  },

  // ======================= NECROPOLIS — TOMB OF SOULS =======================

  'tombOfSouls.tomb.chillTouch': {
    name: 'Chill Touch',
    branch: 'tomb', dwelling: 'dwelling3', faction: 'necropolis',
    creatures: ['wight', 'wraith'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Narrowed to a finger\'s width: +37% pressure, −4% energy.',
  },

  'tombOfSouls.tomb.shroudWeave': {
    name: 'Shroud Weave',
    branch: 'tomb', dwelling: 'dwelling3', faction: 'necropolis',
    creatures: ['wight', 'wraith'],
    requires: ['tombOfSouls.tomb.chillTouch'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { armorHardness_gpa: { set: 0.17 }, armorCoverage_frac: { mul: 1.2 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'A shroud that turns a blade (0.17 GPa), over more of it, −7% touch.',
  },

  'tombOfSouls.tomb.lingeringSpite': {
    name: 'Lingering Spite',
    branch: 'tomb', dwelling: 'dwelling3', faction: 'necropolis',
    creatures: ['wight', 'wraith'],
    requires: ['tombOfSouls.tomb.chillTouch'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Slower to disperse: +25% toughness, −17% impact pressure.',
  },

  'tombOfSouls.forge.leadenTouch': {
    name: 'Leaden Touch',
    branch: 'forge', dwelling: 'dwelling3', faction: 'necropolis',
    creatures: ['wight', 'wraith'],
    requires: ['tombOfSouls.tomb.chillTouch'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A colder and heavier hand: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================== NECROPOLIS — ESTATE ==========================

  'estate.crypt.honedFangs': {
    name: 'Honed Fangs',
    branch: 'crypt', dwelling: 'dwelling4', faction: 'necropolis',
    creatures: ['vampire', 'vampireLord'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'The narrowest strike in the faction: +37% pressure, −4% energy.',
  },

  'estate.crypt.nobleHarness': {
    name: 'Noble Harness',
    branch: 'crypt', dwelling: 'dwelling4', faction: 'necropolis',
    creatures: ['vampire', 'vampireLord'],
    requires: ['estate.crypt.honedFangs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.26 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Chased plate beneath the cloak (0.26 GPa), −7% strike.',
  },

  'estate.crypt.batSwarm': {
    name: 'Bat Swarm',
    branch: 'crypt', dwelling: 'dwelling4', faction: 'necropolis',
    creatures: ['vampire', 'vampireLord'],
    requires: ['estate.crypt.honedFangs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Scatter and re-form: +20% toughness, −17% impact pressure.',
  },

  'estate.forge.talonedGrasp': {
    name: 'Taloned Grasp',
    branch: 'forge', dwelling: 'dwelling4', faction: 'necropolis',
    creatures: ['vampire', 'vampireLord'],
    requires: ['estate.crypt.honedFangs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'The grip that comes before the bite: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================== NECROPOLIS — MAUSOLEUM ========================

  'mausoleum.rites.tightenedBlast': {
    name: 'Tightened Blast',
    branch: 'rites', dwelling: 'dwelling5', faction: 'necropolis',
    creatures: ['lich', 'powerLich'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { dispersion_rad: { mul: 0.78 }, blowEnergy_j: { mul: 0.9 } },
    desc: 'A disciplined blast: groups tighten 22%, −10% energy.',
  },

  'mausoleum.rites.deathlyForce': {
    name: 'Deathly Force',
    branch: 'rites', dwelling: 'dwelling5', faction: 'necropolis',
    creatures: ['lich', 'powerLich'],
    requires: ['mausoleum.rites.tightenedBlast'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { blowEnergy_j: { mul: 1.25 }, dispersion_rad: { mul: 1.18 } },
    desc: 'More behind it: +25% energy, groups open 18%.',
  },

  'mausoleum.rites.boneWard': {
    name: 'Bone Ward',
    branch: 'rites', dwelling: 'dwelling5', faction: 'necropolis',
    creatures: ['lich', 'powerLich'],
    requires: ['mausoleum.rites.tightenedBlast'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { armorHardness_gpa: { set: 0.2 }, armorCoverage_frac: { mul: 1.2 }, blowEnergy_j: { mul: 0.94 } },
    desc: 'A lattice of bone (0.20 GPa) over more of the robe, −6% blast.',
  },

  'mausoleum.drill.boundPhylactery': {
    name: 'Bound Phylactery',
    branch: 'drill', dwelling: 'dwelling5', faction: 'necropolis',
    creatures: ['lich', 'powerLich'],
    requires: ['mausoleum.rites.tightenedBlast'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.18 }, blowEnergy_j: { mul: 0.92 } },
    desc: 'The vessel carried closer: +18% toughness, −8% shot energy.',
  },

  // ===================== NECROPOLIS — HALL OF DARKNESS =====================

  'hallOfDarkness.hall.cursedEdge': {
    name: 'Cursed Edge',
    branch: 'hall', dwelling: 'dwelling6', faction: 'necropolis',
    creatures: ['blackKnight', 'dreadKnight'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A blade that will not blunt: +37% pressure, −4% energy.',
  },

  'hallOfDarkness.hall.blackPlate': {
    name: 'Black Plate',
    branch: 'hall', dwelling: 'dwelling6', faction: 'necropolis',
    creatures: ['blackKnight', 'dreadKnight'],
    requires: ['hallOfDarkness.hall.cursedEdge'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.72 }, armorCoverage_frac: { mul: 1.08 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Grave-black harness (0.72 GPa) over more of the rider, −7% cut.',
  },

  'hallOfDarkness.hall.deathCharge': {
    name: 'Death Charge',
    branch: 'hall', dwelling: 'dwelling6', faction: 'necropolis',
    creatures: ['blackKnight', 'dreadKnight'],
    requires: ['hallOfDarkness.hall.cursedEdge'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Heavier horse, heavier blade: +20% energy, −10% harness worn.',
  },

  'hallOfDarkness.drill.dreadVigil': {
    name: 'Dread Vigil',
    branch: 'drill', dwelling: 'dwelling6', faction: 'necropolis',
    creatures: ['blackKnight', 'dreadKnight'],
    requires: ['hallOfDarkness.hall.cursedEdge'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Riders who never dismount: +20% toughness, −18% impact pressure.',
  },

  // ======================= NECROPOLIS — DRAGON VAULT =======================

  'dragonVault.vault.splinteredClaws': {
    name: 'Splintered Claws',
    branch: 'vault', dwelling: 'dwelling7', faction: 'necropolis',
    creatures: ['boneDragon', 'ghostDragon'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Bone worked to a point: +37% impact pressure, −4% energy.',
  },

  'dragonVault.vault.boneLattice': {
    name: 'Bone Lattice',
    branch: 'vault', dwelling: 'dwelling7', faction: 'necropolis',
    creatures: ['boneDragon', 'ghostDragon'],
    requires: ['dragonVault.vault.splinteredClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.3 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'A knitted lattice (0.30 GPa) over more of the frame, −7% strike.',
  },

  'dragonVault.vault.gravewind': {
    name: 'Gravewind',
    branch: 'vault', dwelling: 'dwelling7', faction: 'necropolis',
    creatures: ['boneDragon', 'ghostDragon'],
    requires: ['dragonVault.vault.splinteredClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'The whole wing behind it: +20% energy, −10% lattice carried.',
  },

  'dragonVault.drill.knittedBones': {
    name: 'Knitted Bones',
    branch: 'drill', dwelling: 'dwelling7', faction: 'necropolis',
    creatures: ['boneDragon', 'ghostDragon'],
    requires: ['dragonVault.vault.splinteredClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Old breaks knitted with grave-iron: +20% toughness, −18% impact pressure.',
  },

  // ======================== INFERNO — IMP CRUCIBLE ========================

  'impCrucible.crucible.barbedClaws': {
    name: 'Barbed Claws',
    branch: 'crucible', dwelling: 'dwelling1', faction: 'inferno',
    creatures: ['imp', 'familiar'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Iron filed into the nail: +37% impact pressure, −4% energy.',
  },

  'impCrucible.crucible.cinderHide': {
    name: 'Cinder Hide',
    branch: 'crucible', dwelling: 'dwelling1', faction: 'inferno',
    creatures: ['imp', 'familiar'],
    requires: ['impCrucible.crucible.barbedClaws'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { armorHardness_gpa: { set: 0.08 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Fire-cured to a shell (0.08 GPa) over more of it, −7% swipe.',
  },

  'impCrucible.crucible.sootLungs': {
    name: 'Soot Lungs',
    branch: 'crucible', dwelling: 'dwelling1', faction: 'inferno',
    creatures: ['imp', 'familiar'],
    requires: ['impCrucible.crucible.barbedClaws'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Bred to the smoke: +25% toughness, −17% impact pressure.',
  },

  'impCrucible.forge.brandedIrons': {
    name: 'Branded Irons',
    branch: 'forge', dwelling: 'dwelling1', faction: 'inferno',
    creatures: ['imp', 'familiar'],
    requires: ['impCrucible.crucible.barbedClaws'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A hot iron gripped in both claws: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================= INFERNO — HALL OF SINS =========================

  'hallOfSins.brimstone.packedCores': {
    name: 'Packed Cores',
    branch: 'brimstone', dwelling: 'dwelling2', faction: 'inferno',
    creatures: ['gog', 'magog'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A tighter ball burns through less of itself: +37% pressure, −4% energy.',
  },

  'hallOfSins.brimstone.slagPlate': {
    name: 'Slag Plate',
    branch: 'brimstone', dwelling: 'dwelling2', faction: 'inferno',
    creatures: ['gog', 'magog'],
    requires: ['hallOfSins.brimstone.packedCores'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { armorHardness_gpa: { set: 0.12 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Cooled slag hung on the frame (0.12 GPa), −7% on the throw.',
  },

  'hallOfSins.brimstone.heavierCharges': {
    name: 'Heavier Charges',
    branch: 'brimstone', dwelling: 'dwelling2', faction: 'inferno',
    creatures: ['gog', 'magog'],
    requires: ['hallOfSins.brimstone.packedCores'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A bigger ball needs both hands: +20% energy, −10% slag worn.',
  },

  'hallOfSins.drill.ashLungs': {
    name: 'Ash Lungs',
    branch: 'drill', dwelling: 'dwelling2', faction: 'inferno',
    creatures: ['gog', 'magog'],
    requires: ['hallOfSins.brimstone.packedCores'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Lungs seasoned on brimstone smoke: +20% toughness, −18% impact pressure.',
  },

  // =========================== INFERNO — KENNELS ===========================

  'kennels.kennel.honedFangs': {
    name: 'Honed Fangs',
    branch: 'kennel', dwelling: 'dwelling3', faction: 'inferno',
    creatures: ['hellHound', 'cerberus'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Filed to points: +37% pressure through the bite, −4% in the jaw.',
  },

  'kennels.kennel.studdedCollars': {
    name: 'Studded Collars',
    branch: 'kennel', dwelling: 'dwelling3', faction: 'inferno',
    creatures: ['hellHound', 'cerberus'],
    requires: ['kennels.kennel.honedFangs'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { armorHardness_gpa: { set: 0.1 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Iron at the throat and shoulder (0.10 GPa), −7% on the lunge.',
  },

  'kennels.kennel.deepChests': {
    name: 'Deep Chests',
    branch: 'kennel', dwelling: 'dwelling3', faction: 'inferno',
    creatures: ['hellHound', 'cerberus'],
    requires: ['kennels.kennel.honedFangs'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Bred long in the ribs: +22% toughness, −17% impact pressure.',
  },

  'kennels.forge.pitBred': {
    name: 'Pit-Bred',
    branch: 'forge', dwelling: 'dwelling3', faction: 'inferno',
    creatures: ['hellHound', 'cerberus'],
    requires: ['kennels.kennel.honedFangs'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Bred heavier in the fighting pits: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================= INFERNO — DEMON GATE =========================

  'demonGate.gate.abyssalEdge': {
    name: 'Abyssal Edge',
    branch: 'gate', dwelling: 'dwelling4', faction: 'inferno',
    creatures: ['demon', 'hornedDemon'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Ground thin on the abyss stone: +37% pressure, −4% energy.',
  },

  'demonGate.gate.scaleHarness': {
    name: 'Scale Harness',
    branch: 'gate', dwelling: 'dwelling4', faction: 'inferno',
    creatures: ['demon', 'hornedDemon'],
    requires: ['demonGate.gate.abyssalEdge'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.32 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Hardened scale strapped over the hide (0.32 GPa), −7% swing.',
  },

  'demonGate.gate.greatCleaver': {
    name: 'Great Cleaver',
    branch: 'gate', dwelling: 'dwelling4', faction: 'inferno',
    creatures: ['demon', 'hornedDemon'],
    requires: ['demonGate.gate.abyssalEdge'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Two hands on the haft: +20% energy, −10% harness carried.',
  },

  'demonGate.drill.brimstoneHide': {
    name: 'Brimstone Hide',
    branch: 'drill', dwelling: 'dwelling4', faction: 'inferno',
    creatures: ['demon', 'hornedDemon'],
    requires: ['demonGate.gate.abyssalEdge'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Hide cured in the gate\'s own smoke: +20% toughness, −18% impact pressure.',
  },

  // ========================== INFERNO — HELL HOLE ==========================

  'hellHole.overseer.bladedLash': {
    name: 'Bladed Lash',
    branch: 'overseer', dwelling: 'dwelling5', faction: 'inferno',
    creatures: ['pitFiend', 'pitLord'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Barbs braided into the fall: +37% pressure, −4% in the arm.',
  },

  'hellHole.overseer.brandedPlate': {
    name: 'Branded Plate',
    branch: 'overseer', dwelling: 'dwelling5', faction: 'inferno',
    creatures: ['pitFiend', 'pitLord'],
    requires: ['hellHole.overseer.bladedLash'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { armorHardness_gpa: { set: 0.4 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Plate struck with the legion brand (0.40 GPa), −7% on the lash.',
  },

  'hellHole.overseer.searedSinew': {
    name: 'Seared Sinew',
    branch: 'overseer', dwelling: 'dwelling5', faction: 'inferno',
    creatures: ['pitFiend', 'pitLord'],
    requires: ['hellHole.overseer.bladedLash'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Cauterised as it grows: +22% toughness, −17% impact pressure.',
  },

  'hellHole.forge.weightedLash': {
    name: 'Weighted Lash',
    branch: 'forge', dwelling: 'dwelling5', faction: 'inferno',
    creatures: ['pitFiend', 'pitLord'],
    requires: ['hellHole.overseer.bladedLash'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A chain lash loaded at the fall: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================== INFERNO — FIRE LAKE ==========================

  'fireLake.flame.narrowedFlame': {
    name: 'Narrowed Flame',
    branch: 'flame', dwelling: 'dwelling6', faction: 'inferno',
    creatures: ['efreeti', 'efreetSultan'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'The lash drawn to a thread: +37% pressure, −4% carried heat.',
  },

  'fireLake.flame.moltenMail': {
    name: 'Molten Mail',
    branch: 'flame', dwelling: 'dwelling6', faction: 'inferno',
    creatures: ['efreeti', 'efreetSultan'],
    requires: ['fireLake.flame.narrowedFlame'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.3 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Poured and set on the djinn itself (0.30 GPa), −7% on the lash.',
  },

  'fireLake.flame.gatheredHeat': {
    name: 'Gathered Heat',
    branch: 'flame', dwelling: 'dwelling6', faction: 'inferno',
    creatures: ['efreeti', 'efreetSultan'],
    requires: ['fireLake.flame.narrowedFlame'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Held back a beat longer: +20% energy, −10% of the shell worn.',
  },

  'fireLake.drill.emberSkin': {
    name: 'Ember Skin',
    branch: 'drill', dwelling: 'dwelling6', faction: 'inferno',
    creatures: ['efreeti', 'efreetSultan'],
    requires: ['fireLake.flame.narrowedFlame'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Skin banked like a covered fire: +20% toughness, −18% impact pressure.',
  },

  // ======================= INFERNO — FORSAKEN PALACE =======================

  'forsakenPalace.court.hellforgedEdge': {
    name: 'Hellforged Edge',
    branch: 'court', dwelling: 'dwelling7', faction: 'inferno',
    creatures: ['devil', 'archDevil'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Struck on the deepest anvil: +37% pressure, −4% energy.',
  },

  'forsakenPalace.court.infernalPlate': {
    name: 'Infernal Plate',
    branch: 'court', dwelling: 'dwelling7', faction: 'inferno',
    creatures: ['devil', 'archDevil'],
    requires: ['forsakenPalace.court.hellforgedEdge'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.58 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'The court armoury opens (0.58 GPa) over more of it, −7% cut.',
  },

  'forsakenPalace.court.executionersSwing': {
    name: "Executioner's Swing",
    branch: 'court', dwelling: 'dwelling7', faction: 'inferno',
    creatures: ['devil', 'archDevil'],
    requires: ['forsakenPalace.court.hellforgedEdge'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Everything behind one stroke: +20% energy, −10% plate carried.',
  },

  'forsakenPalace.drill.infernalVigour': {
    name: 'Infernal Vigour',
    branch: 'drill', dwelling: 'dwelling7', faction: 'inferno',
    creatures: ['devil', 'archDevil'],
    requires: ['forsakenPalace.court.hellforgedEdge'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'A court that does not tire: +20% toughness, −18% impact pressure.',
  },

  // ============================ DUNGEON — WARREN ============================

  'warren.burrow.knappedClubs': {
    name: 'Knapped Clubs',
    branch: 'burrow', dwelling: 'dwelling1', faction: 'dungeon',
    creatures: ['troglodyte', 'infernalTroglodyte'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A struck edge instead of a knob: +37% pressure, −4% energy.',
  },

  'warren.burrow.chitinVests': {
    name: 'Chitin Vests',
    branch: 'burrow', dwelling: 'dwelling1', faction: 'dungeon',
    creatures: ['troglodyte', 'infernalTroglodyte'],
    requires: ['warren.burrow.knappedClubs'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { armorHardness_gpa: { set: 0.11 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Cave-beetle plate laced on (0.11 GPa) over more of it, −7% swing.',
  },

  'warren.burrow.blindEndurance': {
    name: 'Blind Endurance',
    branch: 'burrow', dwelling: 'dwelling1', faction: 'dungeon',
    creatures: ['troglodyte', 'infernalTroglodyte'],
    requires: ['warren.burrow.knappedClubs'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Nothing to see and nowhere to run: +25% toughness, −17% pressure.',
  },

  'warren.forge.stoneMauls': {
    name: 'Stone Mauls',
    branch: 'forge', dwelling: 'dwelling1', faction: 'dungeon',
    creatures: ['troglodyte', 'infernalTroglodyte'],
    requires: ['warren.burrow.knappedClubs'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A river stone lashed to the haft: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================== DUNGEON — HARPY LOFT ==========================

  'harpyLoft.roost.honedTalons': {
    name: 'Honed Talons',
    branch: 'roost', dwelling: 'dwelling2', faction: 'dungeon',
    creatures: ['harpy', 'harpyHag'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Kept to a needle on the rock: +37% pressure, −4% energy.',
  },

  'harpyLoft.roost.featherMail': {
    name: 'Feather Mail',
    branch: 'roost', dwelling: 'dwelling2', faction: 'dungeon',
    creatures: ['harpy', 'harpyHag'],
    requires: ['harpyLoft.roost.honedTalons'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { armorHardness_gpa: { set: 0.08 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Rings sewn between the quills (0.08 GPa), −7% on the strike.',
  },

  'harpyLoft.roost.stoopingDive': {
    name: 'Stooping Dive',
    branch: 'roost', dwelling: 'dwelling2', faction: 'dungeon',
    creatures: ['harpy', 'harpyHag'],
    requires: ['harpyLoft.roost.honedTalons'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Height traded for speed: +20% energy, −10% of the mail worn.',
  },

  'harpyLoft.drill.cliffBred': {
    name: 'Cliff-Bred',
    branch: 'drill', dwelling: 'dwelling2', faction: 'dungeon',
    creatures: ['harpy', 'harpyHag'],
    requires: ['harpyLoft.roost.honedTalons'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Hatched on the updraught: +20% toughness, −18% impact pressure.',
  },

  // ======================== DUNGEON — PILLAR OF EYES ========================

  'pillarOfEyes.oculus.narrowedGaze': {
    name: 'Narrowed Gaze',
    branch: 'oculus', dwelling: 'dwelling3', faction: 'dungeon',
    creatures: ['beholder', 'evilEye'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'The bolt drawn to a point: +37% pressure, −4% delivered.',
  },

  'pillarOfEyes.oculus.chitinCarapace': {
    name: 'Chitin Carapace',
    branch: 'oculus', dwelling: 'dwelling3', faction: 'dungeon',
    creatures: ['beholder', 'evilEye'],
    requires: ['pillarOfEyes.oculus.narrowedGaze'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { armorHardness_gpa: { set: 0.16 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Grown thick around the eye (0.16 GPa), −7% on the bolt.',
  },

  'pillarOfEyes.oculus.swollenHumour': {
    name: 'Swollen Humour',
    branch: 'oculus', dwelling: 'dwelling3', faction: 'dungeon',
    creatures: ['beholder', 'evilEye'],
    requires: ['pillarOfEyes.oculus.narrowedGaze'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'More to burst before it bursts: +22% toughness, −17% pressure.',
  },

  'pillarOfEyes.forge.massedLenses': {
    name: 'Massed Lenses',
    branch: 'forge', dwelling: 'dwelling3', faction: 'dungeon',
    creatures: ['beholder', 'evilEye'],
    requires: ['pillarOfEyes.oculus.narrowedGaze'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'More lenses behind the same eye: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // =================== DUNGEON — CHAPEL OF STILLED VOICES ===================
  // The one Dungeon branch whose blow is a real arrow, so PHYS_BOUNDS applies to
  // every node and every pair of them (I21). That is why this dwelling gets
  // ENDURANCE rather than WEIGHT: a heavier-shaft node would multiply a stored
  // bow energy that is already 157 J against a 175 J ceiling, and the bound would
  // be met by the second purchase rather than by design.

  'chapelOfStilledVoices.chapel.stoneBodkins': {
    name: 'Stone Bodkins',
    branch: 'chapel', dwelling: 'dwelling4', faction: 'dungeon',
    creatures: ['medusa', 'medusaQueen'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Knapped narrow, not heavy: +37% pressure, −4% delivered energy.',
  },

  'chapelOfStilledVoices.chapel.serpentScale': {
    name: 'Serpent Scale',
    branch: 'chapel', dwelling: 'dwelling4', faction: 'dungeon',
    creatures: ['medusa', 'medusaQueen'],
    requires: ['chapelOfStilledVoices.chapel.stoneBodkins'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.22 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Shed scale relaid as armour (0.22 GPa), −7% on the draw.',
  },

  'chapelOfStilledVoices.chapel.coiledStance': {
    name: 'Coiled Stance',
    branch: 'chapel', dwelling: 'dwelling4', faction: 'dungeon',
    creatures: ['medusa', 'medusaQueen'],
    requires: ['chapelOfStilledVoices.chapel.stoneBodkins'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Braced on the coil: +20% toughness, −17% impact pressure.',
  },

  'chapelOfStilledVoices.drill.stilledAim': {
    name: 'Stilled Aim',
    branch: 'drill', dwelling: 'dwelling4', faction: 'dungeon',
    creatures: ['medusa', 'medusaQueen'],
    requires: ['chapelOfStilledVoices.chapel.stoneBodkins'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { dispersion_rad: { mul: 0.78 }, blowEnergy_j: { mul: 0.9 } },
    desc: 'A held breath and a longer look: groups tighten 22%, −10% shaft energy.',
  },

  // ========================== DUNGEON — LABYRINTH ==========================

  'labyrinth.maze.groundBits': {
    name: 'Ground Bits',
    branch: 'maze', dwelling: 'dwelling5', faction: 'dungeon',
    creatures: ['minotaur', 'minotaurKing'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'The bit taken back to an edge: +37% pressure, −4% energy.',
  },

  'labyrinth.maze.bullPlate': {
    name: 'Bull Plate',
    branch: 'maze', dwelling: 'dwelling5', faction: 'dungeon',
    creatures: ['minotaur', 'minotaurKing'],
    requires: ['labyrinth.maze.groundBits'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { armorHardness_gpa: { set: 0.4 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Plate cut for the shoulders (0.40 GPa), −7% on the swing.',
  },

  'labyrinth.maze.twoHandedHaft': {
    name: 'Two-Handed Haft',
    branch: 'maze', dwelling: 'dwelling5', faction: 'dungeon',
    creatures: ['minotaur', 'minotaurKing'],
    requires: ['labyrinth.maze.groundBits'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A longer haft and no free hand: +20% energy, −10% plate carried.',
  },

  'labyrinth.drill.mazeBred': {
    name: 'Maze-Bred',
    branch: 'drill', dwelling: 'dwelling5', faction: 'dungeon',
    creatures: ['minotaur', 'minotaurKing'],
    requires: ['labyrinth.maze.groundBits'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Grown in the dark on hard walls: +20% toughness, −18% impact pressure.',
  },

  // ======================== DUNGEON — MANTICORE LAIR ========================

  'manticoreLair.lair.finerBarb': {
    name: 'Finer Barb',
    branch: 'lair', dwelling: 'dwelling6', faction: 'dungeon',
    creatures: ['manticore', 'scorpicore'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'The sting worked to a hair: +37% pressure, −4% in the tail.',
  },

  'manticoreLair.lair.lionMail': {
    name: 'Lion Mail',
    branch: 'lair', dwelling: 'dwelling6', faction: 'dungeon',
    creatures: ['manticore', 'scorpicore'],
    requires: ['manticoreLair.lair.finerBarb'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.26 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Mail fitted along the flank (0.26 GPa), −7% on the lash.',
  },

  'manticoreLair.lair.thickenedTail': {
    name: 'Thickened Tail',
    branch: 'lair', dwelling: 'dwelling6', faction: 'dungeon',
    creatures: ['manticore', 'scorpicore'],
    requires: ['manticoreLair.lair.finerBarb'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Muscle where the barb sits: +22% toughness, −17% pressure.',
  },

  'manticoreLair.forge.heavierSting': {
    name: 'Heavier Sting',
    branch: 'forge', dwelling: 'dwelling6', faction: 'dungeon',
    creatures: ['manticore', 'scorpicore'],
    requires: ['manticoreLair.lair.finerBarb'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A thicker tail and a longer arc: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================= DUNGEON — DRAGON CAVE =========================

  'dragonCave.hoard.rakingClaws': {
    name: 'Raking Claws',
    branch: 'hoard', dwelling: 'dwelling7', faction: 'dungeon',
    creatures: ['redDragon', 'blackDragon'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Kept sharp on the hoard: +37% pressure, −4% energy.',
  },

  'dragonCave.hoard.hoardScale': {
    name: 'Hoard Scale',
    branch: 'hoard', dwelling: 'dwelling7', faction: 'dungeon',
    creatures: ['redDragon', 'blackDragon'],
    requires: ['dragonCave.hoard.rakingClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.8 }, armorCoverage_frac: { mul: 1.1 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Coin and plate bedded into the hide (0.80 GPa), −7% strike.',
  },

  'dragonCave.hoard.wingfallStrike': {
    name: 'Wingfall Strike',
    branch: 'hoard', dwelling: 'dwelling7', faction: 'dungeon',
    creatures: ['redDragon', 'blackDragon'],
    requires: ['dragonCave.hoard.rakingClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'The whole stoop behind it: +20% energy, −10% scale carried.',
  },

  'dragonCave.drill.hoardBedded': {
    name: 'Hoard-Bedded',
    branch: 'drill', dwelling: 'dwelling7', faction: 'dungeon',
    creatures: ['redDragon', 'blackDragon'],
    requires: ['dragonCave.hoard.rakingClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Scales bedded in gold and grit: +20% toughness, −18% impact pressure.',
  },

  // ====================== STRONGHOLD — GOBLIN BARRACKS ======================

  'goblinBarracks.warcamp.sharpenedStakes': {
    name: 'Sharpened Stakes',
    branch: 'warcamp', dwelling: 'dwelling1', faction: 'stronghold',
    creatures: ['goblin', 'hobgoblin'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Fire-hardened to a point: +37% impact pressure, −4% energy.',
  },

  'goblinBarracks.warcamp.hideJerkins': {
    name: 'Hide Jerkins',
    branch: 'warcamp', dwelling: 'dwelling1', faction: 'stronghold',
    creatures: ['goblin', 'hobgoblin'],
    requires: ['goblinBarracks.warcamp.sharpenedStakes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { armorHardness_gpa: { set: 0.1 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Boiled hide with plates sewn in (0.10 GPa), −7% on the jab.',
  },

  'goblinBarracks.warcamp.pitFed': {
    name: 'Pit-Fed',
    branch: 'warcamp', dwelling: 'dwelling1', faction: 'stronghold',
    creatures: ['goblin', 'hobgoblin'],
    requires: ['goblinBarracks.warcamp.sharpenedStakes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Fed on what the horde leaves: +25% toughness, −17% pressure.',
  },

  'goblinBarracks.forge.loadedClubs': {
    name: 'Loaded Clubs',
    branch: 'forge', dwelling: 'dwelling1', faction: 'stronghold',
    creatures: ['goblin', 'hobgoblin'],
    requires: ['goblinBarracks.warcamp.sharpenedStakes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A stone set in the head of the club: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================= STRONGHOLD — WOLF PEN =========================

  'wolfPen.pen.notchedBlades': {
    name: 'Notched Blades',
    branch: 'pen', dwelling: 'dwelling2', faction: 'stronghold',
    creatures: ['wolfRider', 'wolfRaider'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Ground to bite on the pass: +37% pressure, −4% energy.',
  },

  'wolfPen.pen.ridersHarness': {
    name: "Rider's Harness",
    branch: 'pen', dwelling: 'dwelling2', faction: 'stronghold',
    creatures: ['wolfRider', 'wolfRaider'],
    requires: ['wolfPen.pen.notchedBlades'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { armorHardness_gpa: { set: 0.14 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Barding for both of them (0.14 GPa), −7% from the saddle.',
  },

  'wolfPen.pen.chargingWeight': {
    name: 'Charging Weight',
    branch: 'pen', dwelling: 'dwelling2', faction: 'stronghold',
    creatures: ['wolfRider', 'wolfRaider'],
    requires: ['wolfPen.pen.notchedBlades'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'The wolf carries the blow: +20% energy, −10% barding worn.',
  },

  'wolfPen.drill.packEndurance': {
    name: 'Pack Endurance',
    branch: 'drill', dwelling: 'dwelling2', faction: 'stronghold',
    creatures: ['wolfRider', 'wolfRaider'],
    requires: ['wolfPen.pen.notchedBlades'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Run to the end of the day: +20% toughness, −18% impact pressure.',
  },

  // ========================= STRONGHOLD — ORC TOWER =========================
  // ONE OF THE THREE ARROW DWELLINGS, so PHYS_BOUNDS applies to every node and
  // every legal pair (I21) — and the third node is ENDURANCE, not WEIGHT. That
  // now holds at every bow in the game (Archers' Tower, Homestead, Chapel of
  // Stilled Voices, Orc Tower, Lizard Den) and it is not a coincidence: a warbow
  // stores at most 175 J, an authored baseline sits well inside that so the
  // branch has room, and a node that multiplies BOTH shaft mass and draw energy
  // walks a creature out of the envelope in one purchase. Checked, not assumed —
  // an Orc Chieftain with a weight node lands a 12.2 mm head against a 12 mm
  // ceiling. Bows buy toughness; everything else buys mass.

  'orcTower.totem.barbedJavelins': {
    name: 'Barbed Javelins',
    branch: 'totem', dwelling: 'dwelling3', faction: 'stronghold',
    creatures: ['orc', 'orcChieftain'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Narrow heads, not heavy ones: +37% pressure, −4% delivered.',
  },

  'orcTower.totem.warPaintPlate': {
    name: 'War-Paint Plate',
    branch: 'totem', dwelling: 'dwelling3', faction: 'stronghold',
    creatures: ['orc', 'orcChieftain'],
    requires: ['orcTower.totem.barbedJavelins'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { armorHardness_gpa: { set: 0.16 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Scavenged plate over the paint (0.16 GPa), −7% on the throw.',
  },

  'orcTower.totem.thickHides': {
    name: 'Thick Hides',
    branch: 'totem', dwelling: 'dwelling3', faction: 'stronghold',
    creatures: ['orc', 'orcChieftain'],
    requires: ['orcTower.totem.barbedJavelins'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Broader across the back: +22% toughness, −17% impact pressure.',
  },

  'orcTower.drill.steadiedCast': {
    name: 'Steadied Cast',
    branch: 'drill', dwelling: 'dwelling3', faction: 'stronghold',
    creatures: ['orc', 'orcChieftain'],
    requires: ['orcTower.totem.barbedJavelins'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { dispersion_rad: { mul: 0.78 }, blowEnergy_j: { mul: 0.9 } },
    desc: 'A planted foot and a slower throw: groups tighten 22%, −10% shaft energy.',
  },

  // ========================= STRONGHOLD — OGRE FORT =========================

  'ogreFort.fort.ironedClubs': {
    name: 'Ironed Clubs',
    branch: 'fort', dwelling: 'dwelling4', faction: 'stronghold',
    creatures: ['ogre', 'ogreMage'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Bands and spikes on the head: +37% pressure, −4% energy.',
  },

  'ogreFort.fort.scrapPlate': {
    name: 'Scrap Plate',
    branch: 'fort', dwelling: 'dwelling4', faction: 'stronghold',
    creatures: ['ogre', 'ogreMage'],
    requires: ['ogreFort.fort.ironedClubs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.22 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Whatever fits, hammered flat (0.22 GPa), −7% on the swing.',
  },

  'ogreFort.fort.twoHandedSwing': {
    name: 'Two-Handed Swing',
    branch: 'fort', dwelling: 'dwelling4', faction: 'stronghold',
    creatures: ['ogre', 'ogreMage'],
    requires: ['ogreFort.fort.ironedClubs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A longer trunk, both hands: +20% energy, −10% scrap carried.',
  },

  'ogreFort.drill.thickHide': {
    name: 'Thick Hide',
    branch: 'drill', dwelling: 'dwelling4', faction: 'stronghold',
    creatures: ['ogre', 'ogreMage'],
    requires: ['ogreFort.fort.ironedClubs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Hide layered with scar and fat: +20% toughness, −18% impact pressure.',
  },

  // ========================= STRONGHOLD — CLIFF NEST =========================

  'cliffNest.eyrie.honedTalons': {
    name: 'Honed Talons',
    branch: 'eyrie', dwelling: 'dwelling5', faction: 'stronghold',
    creatures: ['roc', 'thunderbird'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Kept keen on the crag: +37% pressure, −4% in the stoop.',
  },

  'cliffNest.eyrie.stormFeather': {
    name: 'Storm Feather',
    branch: 'eyrie', dwelling: 'dwelling5', faction: 'stronghold',
    creatures: ['roc', 'thunderbird'],
    requires: ['cliffNest.eyrie.honedTalons'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { armorHardness_gpa: { set: 0.2 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Quills hardened to horn (0.20 GPa) over more of it, −7% strike.',
  },

  'cliffNest.eyrie.deepKeel': {
    name: 'Deep Keel',
    branch: 'eyrie', dwelling: 'dwelling5', faction: 'stronghold',
    creatures: ['roc', 'thunderbird'],
    requires: ['cliffNest.eyrie.honedTalons'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Bred deeper in the chest: +22% toughness, −17% pressure.',
  },

  'cliffNest.forge.thunderStoop': {
    name: 'Thunder Stoop',
    branch: 'forge', dwelling: 'dwelling5', faction: 'stronghold',
    creatures: ['roc', 'thunderbird'],
    requires: ['cliffNest.eyrie.honedTalons'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A longer dive onto the strike: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================== STRONGHOLD — CYCLOPS CAVE ========================

  'cyclopsCave.quarry.knappedStone': {
    name: 'Knapped Stone',
    branch: 'quarry', dwelling: 'dwelling6', faction: 'stronghold',
    creatures: ['cyclops', 'cyclopsKing'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Rocks split to an edge, not picked up: +37% pressure, −4% energy.',
  },

  'cyclopsCave.quarry.quarryPlate': {
    name: 'Quarry Plate',
    branch: 'quarry', dwelling: 'dwelling6', faction: 'stronghold',
    creatures: ['cyclops', 'cyclopsKing'],
    requires: ['cyclopsCave.quarry.knappedStone'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.26 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Slabs strapped to the chest (0.26 GPa), −7% on the throw.',
  },

  'cyclopsCave.quarry.heavierStones': {
    name: 'Heavier Stones',
    branch: 'quarry', dwelling: 'dwelling6', faction: 'stronghold',
    creatures: ['cyclops', 'cyclopsKing'],
    requires: ['cyclopsCave.quarry.knappedStone'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    // The node the first authoring of the Cyclops could not have carried: at
    // 20 kg on 40 cm² a heavier rock bought a measurable gain against nothing on
    // the roster. At 9 kg on 6 cm² it pays against seven targets.
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A bigger rock and the arm to send it: +20% energy, −10% plate.',
  },

  'cyclopsCave.drill.quarryHardened': {
    name: 'Quarry-Hardened',
    branch: 'drill', dwelling: 'dwelling6', faction: 'stronghold',
    creatures: ['cyclops', 'cyclopsKing'],
    requires: ['cyclopsCave.quarry.knappedStone'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'A lifetime under falling rock: +20% toughness, −18% impact pressure.',
  },

  // THE FIFTH TRADE, AND THE ONLY DWELLING THAT HAS ONE, for a physical reason
  // rather than an editorial one — the same kind of exception the bow lines get
  // when they take precision instead of weight.
  //
  // Aim, for everything else that shoots, is a steadier release: the arrow lines
  // buy it with `dispersion_rad` and pay in shaft energy. A Cyclops cannot. Its
  // group is not what is losing the shot — the DROP is. It heaves 10 kg at
  // 10.5 m/s, the slowest projectile in the game by a factor of two, and
  // theta = g*dd/v^2 turns a mis-judged range into 0.133 rad of vertical miss
  // against an authored aim of 0.04. That is the whole weapon at range, and it is
  // bounded now (PHYS_DROP_MAX_SHARE) precisely because the formula stops
  // describing a lob — but bounded is not free, and the Cyclops still shoots at
  // the bound while every bow in the roster sits at a tenth of it.
  //
  // So the trade this dwelling can make, and no other can, is on the other half
  // of v = sqrt(2E/m): throw something SMALLER, faster and flatter. It is a real
  // choice and not a strict gain, because the model charges for it twice — a
  // lighter stone mushrooms against armour (the rigidity term, so `rigidity`
  // falls to an eighth) and a sling gives up energy on the release.
  //
  // `set`, not `mul`, per §3: a sling is equipment, and equipment substitutes.
  // The consequence worth stating rather than discovering — nodes are applied in
  // this file's declaration order, so a realm holding Heavier Stones as well ends
  // up slinging 1.2 kg regardless of the bigger rock it trained on. The arm
  // strength that node bought still counts; the rock it used to throw does not.
  'cyclopsCave.drill.slungStones': {
    name: 'Slung Stones',
    branch: 'drill', dwelling: 'dwelling6', faction: 'stronghold',
    creatures: ['cyclops', 'cyclopsKing'],
    requires: ['cyclopsCave.quarry.knappedStone'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { set: 1.2 }, blowEnergy_j: { mul: 0.88 } },
    desc: 'A whirled cord and a smaller stone — it flies flat: +60% past five hexes, −13% in close.',
  },

  // ======================= STRONGHOLD — BEHEMOTH CRAG =======================

  'behemothCrag.crag.splitClaws': {
    name: 'Split Claws',
    branch: 'crag', dwelling: 'dwelling7', faction: 'stronghold',
    creatures: ['behemoth', 'ancientBehemoth'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Worn to points on the rock: +37% pressure, −4% energy.',
  },

  'behemothCrag.crag.beastPlate': {
    name: 'Beast Plate',
    branch: 'crag', dwelling: 'dwelling7', faction: 'stronghold',
    creatures: ['behemoth', 'ancientBehemoth'],
    requires: ['behemothCrag.crag.splitClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.58 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Iron bound into the pelt (0.58 GPa) over more of it, −7% rake.',
  },

  'behemothCrag.crag.fullWeight': {
    name: 'Full Weight',
    branch: 'crag', dwelling: 'dwelling7', faction: 'stronghold',
    creatures: ['behemoth', 'ancientBehemoth'],
    requires: ['behemothCrag.crag.splitClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'All of it through the forelimb: +20% energy, −10% iron carried.',
  },

  'behemothCrag.drill.crustedHide': {
    name: 'Crusted Hide',
    branch: 'drill', dwelling: 'dwelling7', faction: 'stronghold',
    creatures: ['behemoth', 'ancientBehemoth'],
    requires: ['behemothCrag.crag.splitClaws'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Mud and stone baked into the hide: +20% toughness, −18% impact pressure.',
  },

  // ========================== FORTRESS — GNOLL HUT ==========================

  'gnollHut.hut.notchedGlaives': {
    name: 'Notched Glaives',
    branch: 'hut', dwelling: 'dwelling1', faction: 'fortress',
    creatures: ['gnoll', 'gnollMarauder'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A hook and a point, not a bar: +37% pressure, −4% energy.',
  },

  'gnollHut.hut.reedPlate': {
    name: 'Reed Plate',
    branch: 'hut', dwelling: 'dwelling1', faction: 'fortress',
    creatures: ['gnoll', 'gnollMarauder'],
    requires: ['gnollHut.hut.notchedGlaives'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { armorHardness_gpa: { set: 0.14 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Lacquered reed over scale (0.14 GPa), −7% on the thrust.',
  },

  'gnollHut.hut.marshBred': {
    name: 'Marsh-Bred',
    branch: 'hut', dwelling: 'dwelling1', faction: 'fortress',
    creatures: ['gnoll', 'gnollMarauder'],
    requires: ['gnollHut.hut.notchedGlaives'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Raised in the fever-marsh: +25% toughness, −17% pressure.',
  },

  'gnollHut.forge.boneWeighted': {
    name: 'Bone-Weighted Glaives',
    branch: 'forge', dwelling: 'dwelling1', faction: 'fortress',
    creatures: ['gnoll', 'gnollMarauder'],
    requires: ['gnollHut.hut.notchedGlaives'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A counterweight of bone at the butt: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================== FORTRESS — LIZARD DEN ==========================
  // The second arrow dwelling, and endurance for the same reason as the Orc
  // Tower — see the note there.

  'lizardDen.den.barbedDarts': {
    name: 'Barbed Darts',
    branch: 'den', dwelling: 'dwelling2', faction: 'fortress',
    creatures: ['lizardman', 'lizardWarrior'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Filed to a needle: +37% impact pressure, −4% delivered energy.',
  },

  'lizardDen.den.riverScale': {
    name: 'River Scale',
    branch: 'den', dwelling: 'dwelling2', faction: 'fortress',
    creatures: ['lizardman', 'lizardWarrior'],
    requires: ['lizardDen.den.barbedDarts'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { armorHardness_gpa: { set: 0.2 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Shed plates relaid and boiled (0.20 GPa), −7% on the draw.',
  },

  'lizardDen.den.coldBlood': {
    name: 'Cold Blood',
    branch: 'den', dwelling: 'dwelling2', faction: 'fortress',
    creatures: ['lizardman', 'lizardWarrior'],
    requires: ['lizardDen.den.barbedDarts'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Slower to bleed out: +22% toughness, −17% impact pressure.',
  },

  'lizardDen.drill.steadiedThrow': {
    name: 'Steadied Throw',
    branch: 'drill', dwelling: 'dwelling2', faction: 'fortress',
    creatures: ['lizardman', 'lizardWarrior'],
    requires: ['lizardDen.den.barbedDarts'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { dispersion_rad: { mul: 0.78 }, blowEnergy_j: { mul: 0.9 } },
    desc: 'A braced stance on the mud: groups tighten 22%, −10% shaft energy.',
  },

  // ======================= FORTRESS — SERPENT FLY HIVE =======================

  'serpentFlyHive.hive.honedStings': {
    name: 'Honed Stings',
    branch: 'hive', dwelling: 'dwelling3', faction: 'fortress',
    creatures: ['serpentFly', 'dragonFly'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Finer than anything else in the game: +37% pressure, −4% energy.',
  },

  'serpentFlyHive.hive.chitinRings': {
    name: 'Chitin Rings',
    branch: 'hive', dwelling: 'dwelling3', faction: 'fortress',
    creatures: ['serpentFly', 'dragonFly'],
    requires: ['serpentFlyHive.hive.honedStings'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { armorHardness_gpa: { set: 0.13 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Hardened segments along the body (0.13 GPa), −7% on the sting.',
  },

  'serpentFlyHive.hive.broodFat': {
    name: 'Brood Fat',
    branch: 'hive', dwelling: 'dwelling3', faction: 'fortress',
    creatures: ['serpentFly', 'dragonFly'],
    requires: ['serpentFlyHive.hive.honedStings'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Something to lose before it drops: +25% toughness, −17% pressure.',
  },

  'serpentFlyHive.forge.loadedStings': {
    name: 'Loaded Stings',
    branch: 'forge', dwelling: 'dwelling3', faction: 'fortress',
    creatures: ['serpentFly', 'dragonFly'],
    requires: ['serpentFlyHive.hive.honedStings'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'A thicker sting and a slower pass: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================= FORTRESS — BASILISK PIT =========================

  'basiliskPit.stones.serratedFangs': {
    name: 'Serrated Fangs',
    branch: 'stones', dwelling: 'dwelling4', faction: 'fortress',
    creatures: ['basilisk', 'greaterBasilisk'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Edges filed into the bite: +37% pressure, −4% in the jaw.',
  },

  'basiliskPit.stones.stoneCourse': {
    name: 'Stone Course',
    branch: 'stones', dwelling: 'dwelling4', faction: 'fortress',
    creatures: ['basilisk', 'greaterBasilisk'],
    requires: ['basiliskPit.stones.serratedFangs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.38 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Fed on the pit floor until the scale sets (0.38 GPa), −7% bite.',
  },

  'basiliskPit.stones.loweredHaunch': {
    name: 'Lowered Haunch',
    branch: 'stones', dwelling: 'dwelling4', faction: 'fortress',
    creatures: ['basilisk', 'greaterBasilisk'],
    requires: ['basiliskPit.stones.serratedFangs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Eight legs behind the lunge: +20% energy, −10% scale carried.',
  },

  'basiliskPit.drill.stoneHide': {
    name: 'Stone Hide',
    branch: 'drill', dwelling: 'dwelling4', faction: 'fortress',
    creatures: ['basilisk', 'greaterBasilisk'],
    requires: ['basiliskPit.stones.serratedFangs'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Hide gone to stone in patches: +20% toughness, −18% impact pressure.',
  },

  // ========================== FORTRESS — GORGON LAIR ==========================

  'gorgonLair.byre.groundHorns': {
    name: 'Ground Horns',
    branch: 'byre', dwelling: 'dwelling5', faction: 'fortress',
    creatures: ['gorgon', 'mightyGorgon'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Filed back to a tip: +37% impact pressure, −4% in the gore.',
  },

  'gorgonLair.byre.ironBarding': {
    name: 'Iron Barding',
    branch: 'byre', dwelling: 'dwelling5', faction: 'fortress',
    creatures: ['gorgon', 'mightyGorgon'],
    requires: ['gorgonLair.byre.groundHorns'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { armorHardness_gpa: { set: 0.48 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Plate riveted over the plate (0.48 GPa), −7% on the charge.',
  },

  'gorgonLair.byre.deepGirth': {
    name: 'Deep Girth',
    branch: 'byre', dwelling: 'dwelling5', faction: 'fortress',
    creatures: ['gorgon', 'mightyGorgon'],
    requires: ['gorgonLair.byre.groundHorns'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'More bull to work through: +22% toughness, −17% pressure.',
  },

  'gorgonLair.forge.ironedHorns': {
    name: 'Ironed Horns',
    branch: 'forge', dwelling: 'dwelling5', faction: 'fortress',
    creatures: ['gorgon', 'mightyGorgon'],
    requires: ['gorgonLair.byre.groundHorns'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Horns sheathed and weighted in iron: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ========================== FORTRESS — WYVERN NEST ==========================

  'wyvernNest.nest.finerBarb': {
    name: 'Finer Barb',
    branch: 'nest', dwelling: 'dwelling6', faction: 'fortress',
    creatures: ['wyvern', 'wyvernMonarch'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'The sting drawn to a hair: +37% pressure, −4% in the tail.',
  },

  'wyvernNest.nest.drakeScale': {
    name: 'Drake Scale',
    branch: 'nest', dwelling: 'dwelling6', faction: 'fortress',
    creatures: ['wyvern', 'wyvernMonarch'],
    requires: ['wyvernNest.nest.finerBarb'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.42 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Marsh-hardened plating (0.42 GPa) over more of it, −7% lash.',
  },

  'wyvernNest.nest.wholeTail': {
    name: 'Whole Tail',
    branch: 'nest', dwelling: 'dwelling6', faction: 'fortress',
    creatures: ['wyvern', 'wyvernMonarch'],
    requires: ['wyvernNest.nest.finerBarb'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Every vertebra behind it: +20% energy, −10% scale carried.',
  },

  'wyvernNest.drill.venomInured': {
    name: 'Venom-Inured',
    branch: 'drill', dwelling: 'dwelling6', faction: 'fortress',
    creatures: ['wyvern', 'wyvernMonarch'],
    requires: ['wyvernNest.nest.finerBarb'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Grown proof against its own brood: +20% toughness, −18% impact pressure.',
  },

  // =========================== FORTRESS — HYDRA POND ===========================

  'hydraPond.mere.rowedTeeth': {
    name: 'Rowed Teeth',
    branch: 'mere', dwelling: 'dwelling7', faction: 'fortress',
    creatures: ['hydra', 'chaosHydra'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Seven mouths closing on less: +37% pressure, −4% energy.',
  },

  'hydraPond.mere.bogPlate': {
    name: 'Bog Plate',
    branch: 'mere', dwelling: 'dwelling7', faction: 'fortress',
    creatures: ['hydra', 'chaosHydra'],
    requires: ['hydraPond.mere.rowedTeeth'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.64 }, armorCoverage_frac: { mul: 1.1 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Bog iron set into the hide (0.64 GPa), −7% on the bite.',
  },

  'hydraPond.mere.risingCoil': {
    name: 'Rising Coil',
    branch: 'mere', dwelling: 'dwelling7', faction: 'fortress',
    creatures: ['hydra', 'chaosHydra'],
    requires: ['hydraPond.mere.rowedTeeth'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'The whole body out of the water: +20% energy, −10% plate.',
  },

  'hydraPond.drill.regrownNecks': {
    name: 'Regrown Necks',
    branch: 'drill', dwelling: 'dwelling7', faction: 'fortress',
    creatures: ['hydra', 'chaosHydra'],
    requires: ['hydraPond.mere.rowedTeeth'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Necks that have been taken before: +20% toughness, −18% impact pressure.',
  },

  // ======================= CONFLUX — MAGIC LANTERN =======================
  // No arrow anywhere in Conflux: the Storm and Ice Elementals shoot, but at
  // 300 g and 400 g they are bolts rather than shafts and sit outside the
  // `isArrow` envelope, so PHYS_BOUNDS never applies and every dwelling here is
  // free to take a weight node. It is the only faction of the nine where that
  // is true of all seven.

  'magicLantern.lantern.honedMotes': {
    name: 'Honed Motes',
    branch: 'lantern', dwelling: 'dwelling1', faction: 'conflux',
    creatures: ['pixie', 'sprite'],
    requires: [], excludes: [],
    cost: { gold: 2800 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Drawn to a spark: +37% impact pressure, −4% energy.',
  },

  'magicLantern.lantern.glassWing': {
    name: 'Glass Wing',
    branch: 'lantern', dwelling: 'dwelling1', faction: 'conflux',
    creatures: ['pixie', 'sprite'],
    requires: ['magicLantern.lantern.honedMotes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { armorHardness_gpa: { set: 0.06 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Wings set hard as glass (0.06 GPa) over more of it, −7% strike.',
  },

  'magicLantern.lantern.lanternFed': {
    name: 'Lantern-Fed',
    branch: 'lantern', dwelling: 'dwelling1', faction: 'conflux',
    creatures: ['pixie', 'sprite'],
    requires: ['magicLantern.lantern.honedMotes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'fletchers', count: 1, days: 5 },
    effects: { woundEnergy_j: { mul: 1.25 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Something to burn before it gutters: +25% toughness, −17% pressure.',
  },

  'magicLantern.forge.massedMotes': {
    name: 'Massed Motes',
    branch: 'forge', dwelling: 'dwelling1', faction: 'conflux',
    creatures: ['pixie', 'sprite'],
    requires: ['magicLantern.lantern.honedMotes'], excludes: [],
    cost: { gold: 3200 },
    crew: { pool: 'masons', count: 1, days: 5 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Motes gathered before the strike: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================== CONFLUX — ALTAR OF AIR ========================

  'altarOfAir.gale.focusedGust': {
    name: 'Focused Gust',
    branch: 'gale', dwelling: 'dwelling2', faction: 'conflux',
    creatures: ['airElemental', 'stormElemental'],
    requires: [], excludes: [],
    cost: { gold: 4000 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'The push narrowed to a blade: +37% pressure, −4% energy.',
  },

  'altarOfAir.gale.stormShell': {
    name: 'Storm Shell',
    branch: 'gale', dwelling: 'dwelling2', faction: 'conflux',
    creatures: ['airElemental', 'stormElemental'],
    requires: ['altarOfAir.gale.focusedGust'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'masons', count: 1, days: 6 },
    effects: { armorHardness_gpa: { set: 0.09 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'The vortex packed tight (0.09 GPa) around more of it, −7% blast.',
  },

  'altarOfAir.gale.gatheredFront': {
    name: 'Gathered Front',
    branch: 'gale', dwelling: 'dwelling2', faction: 'conflux',
    creatures: ['airElemental', 'stormElemental'],
    requires: ['altarOfAir.gale.focusedGust'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'More air behind the front: +20% energy, −10% of the shell held.',
  },

  'altarOfAir.drill.thickenedCore': {
    name: 'Thickened Core',
    branch: 'drill', dwelling: 'dwelling2', faction: 'conflux',
    creatures: ['airElemental', 'stormElemental'],
    requires: ['altarOfAir.gale.focusedGust'], excludes: [],
    cost: { gold: 4400 },
    crew: { pool: 'fletchers', count: 1, days: 6 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'A denser eye at the centre: +20% toughness, −18% impact pressure.',
  },

  // ======================= CONFLUX — ALTAR OF WATER =======================

  'altarOfWater.tide.drivenSpray': {
    name: 'Driven Spray',
    branch: 'tide', dwelling: 'dwelling3', faction: 'conflux',
    creatures: ['waterElemental', 'iceElemental'],
    requires: [], excludes: [],
    cost: { gold: 5200 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'A jet, not a wave: +37% impact pressure, −4% energy.',
  },

  'altarOfWater.tide.rimeCrust': {
    name: 'Rime Crust',
    branch: 'tide', dwelling: 'dwelling3', faction: 'conflux',
    creatures: ['waterElemental', 'iceElemental'],
    requires: ['altarOfWater.tide.drivenSpray'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'masons', count: 2, days: 7 },
    effects: { armorHardness_gpa: { set: 0.11 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Frozen at the surface (0.11 GPa) over more of it, −7% on the strike.',
  },

  'altarOfWater.tide.fullSurge': {
    name: 'Full Surge',
    branch: 'tide', dwelling: 'dwelling3', faction: 'conflux',
    creatures: ['waterElemental', 'iceElemental'],
    requires: ['altarOfWater.tide.drivenSpray'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'The whole column moves: +20% energy, −10% of the crust kept.',
  },

  'altarOfWater.drill.deepPressure': {
    name: 'Deep Pressure',
    branch: 'drill', dwelling: 'dwelling3', faction: 'conflux',
    creatures: ['waterElemental', 'iceElemental'],
    requires: ['altarOfWater.tide.drivenSpray'], excludes: [],
    cost: { gold: 5600 },
    crew: { pool: 'fletchers', count: 2, days: 7 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Drawn from under the weight of water: +20% toughness, −18% impact pressure.',
  },

  // ======================== CONFLUX — ALTAR OF FIRE ========================

  'altarOfFire.ember.narrowedTongue': {
    name: 'Narrowed Tongue',
    branch: 'ember', dwelling: 'dwelling4', faction: 'conflux',
    creatures: ['fireElemental', 'energyElemental'],
    requires: [], excludes: [],
    cost: { gold: 2400, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'The flame drawn to a point: +37% pressure, −4% carried heat.',
  },

  'altarOfFire.ember.slagSkin': {
    name: 'Slag Skin',
    branch: 'ember', dwelling: 'dwelling4', faction: 'conflux',
    creatures: ['fireElemental', 'energyElemental'],
    requires: ['altarOfFire.ember.narrowedTongue'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { armorHardness_gpa: { set: 0.13 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'A cooled crust it carries with it (0.13 GPa), −7% on the lash.',
  },

  'altarOfFire.ember.bankedCoals': {
    name: 'Banked Coals',
    branch: 'ember', dwelling: 'dwelling4', faction: 'conflux',
    creatures: ['fireElemental', 'energyElemental'],
    requires: ['altarOfFire.ember.narrowedTongue'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'fletchers', count: 2, days: 10 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'Fuel held in reserve: +22% toughness, −17% impact pressure.',
  },

  'altarOfFire.forge.bankedCoals': {
    name: 'Banked Coals',
    branch: 'forge', dwelling: 'dwelling4', faction: 'conflux',
    creatures: ['fireElemental', 'energyElemental'],
    requires: ['altarOfFire.ember.narrowedTongue'], excludes: [],
    cost: { gold: 2800, ore: 6 },
    crew: { pool: 'masons', count: 2, days: 10 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'Coals banked deep before the flare: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ======================= CONFLUX — ALTAR OF EARTH =======================

  'altarOfEarth.bedrock.knappedFists': {
    name: 'Knapped Fists',
    branch: 'bedrock', dwelling: 'dwelling5', faction: 'conflux',
    creatures: ['earthElemental', 'magmaElemental'],
    requires: [], excludes: [],
    cost: { gold: 2000, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Stone split to an edge: +37% impact pressure, −4% energy.',
  },

  'altarOfEarth.bedrock.basaltCore': {
    name: 'Basalt Core',
    branch: 'bedrock', dwelling: 'dwelling5', faction: 'conflux',
    creatures: ['earthElemental', 'magmaElemental'],
    requires: ['altarOfEarth.bedrock.knappedFists'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'masons', count: 2, days: 12 },
    effects: { armorHardness_gpa: { set: 0.62 }, armorCoverage_frac: { mul: 1.1 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Bedrock in place of packed soil (0.62 GPa), −7% on the blow.',
  },

  'altarOfEarth.bedrock.deeperMass': {
    name: 'Deeper Mass',
    branch: 'bedrock', dwelling: 'dwelling5', faction: 'conflux',
    creatures: ['earthElemental', 'magmaElemental'],
    requires: ['altarOfEarth.bedrock.knappedFists'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'More of the hill in the arm: +20% energy, −10% shell carried.',
  },

  'altarOfEarth.drill.compactedMass': {
    name: 'Compacted Mass',
    branch: 'drill', dwelling: 'dwelling5', faction: 'conflux',
    creatures: ['earthElemental', 'magmaElemental'],
    requires: ['altarOfEarth.bedrock.knappedFists'], excludes: [],
    cost: { gold: 2400, crystal: 10, gems: 2 },
    crew: { pool: 'fletchers', count: 2, days: 12 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Packed down under its own weight: +20% toughness, −18% impact pressure.',
  },

  // ====================== CONFLUX — ALTAR OF THOUGHT ======================

  'altarOfThought.mind.singleIntent': {
    name: 'Single Intent',
    branch: 'mind', dwelling: 'dwelling6', faction: 'conflux',
    creatures: ['psychicElemental', 'magicElemental'],
    requires: [], excludes: [],
    cost: { gold: 2200, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'One thought instead of many: +37% pressure, −4% delivered.',
  },

  'altarOfThought.mind.wardedForm': {
    name: 'Warded Form',
    branch: 'mind', dwelling: 'dwelling6', faction: 'conflux',
    creatures: ['psychicElemental', 'magicElemental'],
    requires: ['altarOfThought.mind.singleIntent'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.2 }, armorCoverage_frac: { mul: 1.15 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'The shape held against a blade (0.20 GPa), −7% on the press.',
  },

  'altarOfThought.mind.deeperWell': {
    name: 'Deeper Well',
    branch: 'mind', dwelling: 'dwelling6', faction: 'conflux',
    creatures: ['psychicElemental', 'magicElemental'],
    requires: ['altarOfThought.mind.singleIntent'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.22 }, contactArea_m2: { mul: 1.2 } },
    desc: 'More of it to unmake: +22% toughness, −17% impact pressure.',
  },

  'altarOfThought.forge.massedIntent': {
    name: 'Massed Intent',
    branch: 'forge', dwelling: 'dwelling6', faction: 'conflux',
    creatures: ['psychicElemental', 'magicElemental'],
    requires: ['altarOfThought.mind.singleIntent'], excludes: [],
    cost: { gold: 2600, crystal: 14, gems: 16 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'One thought carried by many: +20% blow energy and a quarter more mass behind it, −10% armour coverage.',
  },

  // ============================ CONFLUX — PYRE ============================

  'pyre.ash.whitenedTalons': {
    name: 'Whitened Talons',
    branch: 'ash', dwelling: 'dwelling7', faction: 'conflux',
    creatures: ['firebird', 'phoenix'],
    requires: [], excludes: [],
    cost: { gold: 2400, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { contactArea_m2: { mul: 0.7 }, blowEnergy_j: { mul: 0.96 } },
    desc: 'Burnt past yellow to white: +37% pressure, −4% energy.',
  },

  'pyre.ash.emberMail': {
    name: 'Ember Mail',
    branch: 'ash', dwelling: 'dwelling7', faction: 'conflux',
    creatures: ['firebird', 'phoenix'],
    requires: ['pyre.ash.whitenedTalons'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'masons', count: 2, days: 8 },
    effects: { armorHardness_gpa: { set: 0.46 }, armorCoverage_frac: { mul: 1.12 }, blowEnergy_j: { mul: 0.93 } },
    desc: 'Feathers fused to a shell (0.46 GPa) over more of it, −7% strike.',
  },

  'pyre.ash.fullPlume': {
    name: 'Full Plume',
    branch: 'ash', dwelling: 'dwelling7', faction: 'conflux',
    creatures: ['firebird', 'phoenix'],
    requires: ['pyre.ash.whitenedTalons'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { blowMass_kg: { mul: 1.25 }, blowEnergy_j: { mul: 1.2 }, armorCoverage_frac: { mul: 0.9 } },
    desc: 'The whole fire behind the stoop: +20% energy, −10% shell carried.',
  },

  'pyre.drill.ashenPlumage': {
    name: 'Ashen Plumage',
    branch: 'drill', dwelling: 'dwelling7', faction: 'conflux',
    creatures: ['firebird', 'phoenix'],
    requires: ['pyre.ash.whitenedTalons'], excludes: [],
    cost: { gold: 2800, gems: 25, crystal: 21 },
    crew: { pool: 'fletchers', count: 2, days: 8 },
    effects: { woundEnergy_j: { mul: 1.2 }, contactArea_m2: { mul: 1.22 } },
    desc: 'Feathers laid over banked ash: +20% toughness, −18% impact pressure.',
  },
};

// CLONE NOTE: all nine factions' upgrade trees are kept, exactly as data/creatures.js
// keeps all nine bestiaries. Only two factions are PLAYABLE (data/factions.js), and
// the game only ever offers a town its own faction's nodes (factionNodes below), so
// the other seven trees are simply unreachable in play — not broken.
//
// They are kept rather than pruned because they are the corpus the physical damage
// model is tested against: tests/upgrade-nodes.test.js exercises patch ordering,
// `set`-vs-scale, range clamping and the GPa re-bake using nodes from the rampart,
// stronghold and tower trees as fixtures. Pruning them would delete that coverage to
// save bytes that do not matter beside the 330 MB of raster art this clone drops.
export const UPGRADE_NODES = ALL_UPGRADE_NODES;


/** Every node in one branch, in catalog order. */
export function branchNodes(branch) {
  return Object.entries(UPGRADE_NODES)
    .filter(([, n]) => n.branch === branch)
    .map(([id, n]) => ({ id, ...n }));
}

/** Every node a given faction's towns can build. */
export function factionNodes(faction) {
  return Object.entries(UPGRADE_NODES)
    .filter(([, n]) => n.faction === faction)
    .map(([id, n]) => ({ id, ...n }));
}

/**
 * One dwelling's branch, ROOT FIRST and then in prerequisite order — what the
 * town screen offers behind a built dwelling.
 *
 * `dwelling` is the BASE building id: a branch hangs off the Homestead, and an
 * Upgraded Homestead is the same workshop with better tenants. Callers holding a
 * chain's representative id (townBuildSlots hands back the highest built) walk
 * `upgradeOf` down to the root first — that link is the catalog's, and doing it
 * by trimming a 'u' off the string would be a second, weaker spelling of it.
 */
export function dwellingNodes(faction, dwelling) {
  const mine = Object.entries(UPGRADE_NODES)
    .filter(([, n]) => n.faction === faction && n.dwelling === dwelling)
    .map(([id, n]) => ({ id, ...n }));
  const order = new Map(mine.map((n) => [n.id, 0]));
  // Depth from the root, so a dependent never lists above what it needs. The
  // branch is two deep by construction; the loop is bounded by the node count so
  // a future deeper branch orders correctly and a cycle cannot hang the screen.
  for (let pass = 0; pass < mine.length; pass++) {
    for (const n of mine) {
      const deep = (n.requires || []).reduce((d, r) => Math.max(d, order.has(r) ? order.get(r) + 1 : 0), 0);
      if (deep > order.get(n.id)) order.set(n.id, deep);
    }
  }
  return mine.sort((a, b) => order.get(a.id) - order.get(b.id) || a.id.localeCompare(b.id));
}
