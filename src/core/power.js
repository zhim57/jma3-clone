/**
 * power.js — what a creature can DO, as distinct from what it is WORTH.
 *
 * THE TWO JOBS `aiValue` WAS DOING, and why they had to come apart.
 *
 * `aiValue` is a price. It settles transmutation quotes, net worth, diplomacy,
 * what a Pandora reward is allowed to contain — every question of the form "are
 * these two piles of creatures worth the same". That is a designed number and it
 * should stay a designed number.
 *
 * It was also, silently, the DIFFICULTY DIAL. `realmBenchmark` reads the
 * strongest army in the world priced in aiValue and every invader band is
 * budgeted against it; `MapGenerator` rolls guards and town garrisons as
 * `budget / aiValue`; `pandora.js` sizes its guards the same way. So a creature's
 * price decided how much opposition the game built to meet whoever fielded it.
 *
 * Sharing one field between those two jobs is fine exactly as long as the price
 * is a truthful statement of strength. When this module was written it was not:
 * `scripts/sim/tiers.mjs` priced every creature against its peers at equal
 * aiValue and found misses up to 1.8× — a Medusa worth four fifths less than it
 * cost, a Stone Golem nearly twice what it cost. Those prices have since been
 * recalibrated, so the classic table below is now close to 1 throughout; the
 * separation is what keeps it that way rather than something to be undone.
 *
 * The consequence was measured rather than argued. Re-pricing the Archangel by
 * +37% to correct the comparison left the hero's sixty Archangels exactly as
 * strong and grew the war-band they walk into from 213 Champions to 292, because
 * the band is budgeted off the hero's own price. The hero won that fight before
 * the correction and lost it after, having gained nothing and been charged for
 * it. That is not a balance decision; it is two quantities wearing one name.
 *
 * So: opposition is sized in POWER, comparison stays in PRICE.
 *
 *     power(creature) = aiValue / POWER_INDEX[model][creature]
 *
 * With both sides of a sizing decision in the same honest currency, "a raid is
 * 0.90 of the strongest army in the world" becomes TRUE as stated, instead of
 * true only when the two sides' pricing errors happen to cancel.
 *
 * ONE INDEX PER DAMAGE MODEL, because there is no single honest answer.
 *
 * `physicalDamage` (settings.js, opt-in and off by default) does not merely
 * change numbers, it disagrees with the classic ladder about WHICH CREATURES ARE
 * GOOD — by up to twenty points of a faction's standing. Prices are calibrated
 * against classic, since that is the game almost every player meets, and the
 * consequence used to be that a physical-model game sized every guard, garrison,
 * Pandora escort and invasion wave off a strength claim that model did not agree
 * with. The faction spread at equal price under physical is 1.45× against
 * classic's 1.15×, and all of that error used to land on the difficulty dial.
 *
 * A price cannot be right for both models at once. A SIZING SCALAR CAN, because
 * it is read at a moment when the game knows which model is running. So there
 * are two measured tables and the caller says which one it is playing under.
 * Measured, at 24 seeds:
 *
 *     equal PRICE, physical      1.45×   unchanged, and unfixable without
 *                                        breaking the shipped model
 *     equal POWER, physical      1.45× → 1.13×   every faction inside 0.92–1.04
 *     equal POWER, classic       1.15×   untouched — the classic table is
 *                                        exactly what it was
 *
 * and the round trip that actually matters — budget an opposition off a hero
 * army, spend it on six different species, fight all six — went from 22% to 13%
 * dispersion (scripts/sim/sizing.mjs). The 1.13× is better than the shipped
 * model's own 1.15×, which is the claim in one number: two damage models that
 * disagree violently about which creatures are good can each still build a fight
 * of the size it says.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not change one price. Nothing a
 * player pays, sells, transmutes or is rewarded with moves, and no creature
 * becomes stronger or weaker in a fight — `power` is read only where the game was
 * already asking "how much opposition should there be", and there it now gets a
 * better answer to the question it was already asking. Nor does it claim to make
 * two equal-PRICE armies an even match under the physical model: that is a
 * pricing question and it stays open (see scripts/sim/roster.mjs, which measures
 * both). What it fixes is that the game no longer sizes a fight in a currency
 * the running model rejects.
 */

import { CREATURES } from '../data/creatures.js';

/**
 * How much `aiValue` OVERSTATES a creature's fighting strength UNDER THE CLASSIC
 * DAMAGE MODEL. Above 1 means the price flatters it; below 1 means the creature
 * is better than its price.
 *
 * MEASURED, NOT DESIGNED, and regenerated rather than hand-edited:
 *
 *     node scripts/data/write-power.mjs --model=classic   # rewrites this block
 *     node scripts/sim/tiers.mjs 24                       # the same numbers, as a report
 *
 * Each entry is the geometric mean of the power ratio against the other eight
 * factions' creature of the same tier, sized to equal aiValue, over both attack
 * directions.
 *
 * Creatures absent from the table — neutrals, war machines, anything with no
 * faction ladder to be compared against — read as 1.0, which says "no
 * measurement, price stands", not "measured as fair".
 *
 * A number here is worth about ±0.03: an 8-seed pass and a 24-seed pass of the
 * same scan agree to that. Since the recalibration the whole table sits inside
 * 0.885–1.009, so what remains is mostly what the roster's rising-with-tier rule
 * refused to let a price express — which is exactly the residual this table
 * exists to carry.
 */
export const POWER_INDEX_CLASSIC = {
  /* GENERATED — scripts/data/write-power.mjs writes this block; do not hand-edit. */
  // castle
  pikeman: 0.997,
  halberdier: 1.002,
  archer: 1.003,
  marksman: 0.999,
  griffin: 1.001,
  royalGriffin: 0.999,
  swordsman: 1.001,
  crusader: 1.000,
  monk: 1.000,
  zealot: 1.000,
  cavalier: 1.000,
  champion: 1.000,
  angel: 1.000,
  archangel: 1.000,
  // rampart
  centaur: 1.005,
  centaurCaptain: 1.000,
  dwarf: 1.003,
  battleDwarf: 0.999,
  woodElf: 1.000,
  grandElf: 1.000,
  pegasus: 0.999,
  silverPegasus: 1.000,
  dendroid: 1.000,
  dendroidSoldier: 1.000,
  unicorn: 1.000,
  warUnicorn: 1.000,
  greenDragon: 1.000,
  goldDragon: 1.000,
  // tower
  servitor: 1.005,
  masterServitor: 0.996,
  stoneGargoyle: 1.004,
  obsidianGargoyle: 1.000,
  stoneGolem: 1.001,
  ironGolem: 1.001,
  mage: 1.001,
  archMage: 1.000,
  genie: 1.000,
  masterGenie: 1.000,
  naga: 1.000,
  nagaQueen: 1.000,
  giant: 1.000,
  titan: 1.000,
  // inferno
  imp: 0.993,
  familiar: 0.999,
  gog: 0.997,
  magog: 0.998,
  hellHound: 0.999,
  cerberus: 0.999,
  demon: 0.999,
  hornedDemon: 1.000,
  pitFiend: 1.000,
  pitLord: 1.000,
  efreeti: 1.000,
  efreetSultan: 1.000,
  devil: 1.000,
  archDevil: 1.000,
  // necropolis
  skeleton: 0.997,
  skeletonWarrior: 1.005,
  walkingDead: 0.998,
  zombie: 1.000,
  wight: 1.002,
  wraith: 1.000,
  vampire: 0.999,
  vampireLord: 1.000,
  lich: 1.001,
  powerLich: 1.000,
  blackKnight: 1.000,
  dreadKnight: 1.000,
  boneDragon: 1.000,
  ghostDragon: 1.000,
  // dungeon
  troglodyte: 1.005,
  infernalTroglodyte: 0.996,
  harpy: 0.997,
  harpyHag: 0.999,
  beholder: 1.001,
  evilEye: 1.001,
  medusa: 1.001,
  medusaQueen: 1.001,
  minotaur: 1.000,
  minotaurKing: 1.000,
  manticore: 1.000,
  scorpicore: 1.000,
  redDragon: 1.000,
  blackDragon: 1.000,
  // stronghold
  goblin: 1.006,
  hobgoblin: 1.003,
  wolfRider: 0.998,
  wolfRaider: 1.001,
  orc: 1.001,
  orcChieftain: 0.999,
  ogre: 1.000,
  ogreMage: 1.000,
  roc: 0.999,
  thunderbird: 1.000,
  cyclops: 1.000,
  cyclopsKing: 1.000,
  behemoth: 1.000,
  ancientBehemoth: 1.000,
  // fortress
  gnoll: 0.996,
  gnollMarauder: 0.997,
  lizardman: 0.981,
  lizardWarrior: 1.000,
  serpentFly: 0.997,
  dragonFly: 0.998,
  basilisk: 1.000,
  greaterBasilisk: 1.000,
  gorgon: 0.999,
  mightyGorgon: 1.000,
  wyvern: 1.000,
  wyvernMonarch: 1.000,
  hydra: 1.000,
  chaosHydra: 1.000,
  // conflux
  pixie: 1.009,
  sprite: 0.996,
  airElemental: 0.999,
  stormElemental: 0.999,
  waterElemental: 0.885,
  iceElemental: 0.999,
  fireElemental: 0.928,
  energyElemental: 1.001,
  earthElemental: 0.999,
  magmaElemental: 1.000,
  psychicElemental: 1.000,
  magicElemental: 1.000,
  firebird: 1.000,
  phoenix: 1.000,
};

/**
 * The same measurement under the OPT-IN PHYSICAL MODEL.
 *
 *     node scripts/data/write-power.mjs --model=physical   # rewrites this block
 *     node scripts/sim/tiers.mjs 24 --model=physical       # the same numbers, as a report
 *
 * This table is WIDE where the classic one is narrow, and that is the finding
 * rather than a fault in it. Prices were recalibrated against classic, so the
 * classic index collapsed to near 1 — the price now says what the creature does.
 * The physical model was never party to that agreement: it derives damage from
 * mass, speed, armour hardness and wound energy, and it reaches its own verdict
 * about, say, a Dendroid's bulk or a Medusa's arrow. Where it disagrees with the
 * price, the disagreement shows up here, which is precisely where a sizing
 * decision can act on it.
 *
 * Neither table is more correct than the other. They are two models' answers to
 * the same question, and the game reads whichever one it is playing under.
 */
export const POWER_INDEX_PHYSICAL = {
  /* GENERATED — scripts/data/write-power.mjs writes this block; do not hand-edit. */
  // castle
  pikeman: 0.758,
  halberdier: 0.712,
  archer: 1.263,
  marksman: 0.981,
  griffin: 1.155,
  royalGriffin: 1.199,
  swordsman: 0.637,
  crusader: 0.572,
  monk: 1.172,
  zealot: 1.246,
  cavalier: 0.858,
  champion: 0.804,
  angel: 0.585,
  archangel: 0.802,
  // rampart
  centaur: 1.223,
  centaurCaptain: 1.091,
  dwarf: 0.487,
  battleDwarf: 0.488,
  woodElf: 1.240,
  grandElf: 1.091,
  pegasus: 0.914,
  silverPegasus: 0.930,
  dendroid: 1.268,
  dendroidSoldier: 1.045,
  unicorn: 1.063,
  warUnicorn: 0.998,
  greenDragon: 1.328,
  goldDragon: 1.804,
  // tower
  servitor: 1.047,
  masterServitor: 1.665,
  stoneGargoyle: 0.405,
  obsidianGargoyle: 0.392,
  stoneGolem: 0.294,
  ironGolem: 0.260,
  mage: 1.360,
  archMage: 1.357,
  genie: 1.011,
  masterGenie: 1.039,
  naga: 0.826,
  nagaQueen: 0.698,
  giant: 1.128,
  titan: 1.007,
  // inferno
  imp: 1.088,
  familiar: 1.068,
  gog: 1.511,
  magog: 1.437,
  hellHound: 1.124,
  cerberus: 1.311,
  demon: 0.987,
  hornedDemon: 0.973,
  pitFiend: 0.971,
  pitLord: 0.985,
  efreeti: 1.003,
  efreetSultan: 1.219,
  devil: 0.987,
  archDevil: 0.894,
  // necropolis
  skeleton: 0.872,
  skeletonWarrior: 0.777,
  walkingDead: 1.089,
  zombie: 1.147,
  wight: 1.109,
  wraith: 1.143,
  vampire: 0.864,
  vampireLord: 0.847,
  lich: 1.263,
  powerLich: 1.207,
  blackKnight: 0.815,
  dreadKnight: 0.814,
  boneDragon: 1.196,
  ghostDragon: 1.197,
  // dungeon
  troglodyte: 1.047,
  infernalTroglodyte: 0.997,
  harpy: 1.174,
  harpyHag: 1.341,
  beholder: 1.308,
  evilEye: 1.192,
  medusa: 1.470,
  medusaQueen: 1.512,
  minotaur: 0.954,
  minotaurKing: 0.994,
  manticore: 0.978,
  scorpicore: 1.185,
  redDragon: 0.771,
  blackDragon: 0.868,
  // stronghold
  goblin: 1.071,
  hobgoblin: 1.046,
  wolfRider: 1.211,
  wolfRaider: 1.289,
  orc: 1.136,
  orcChieftain: 1.000,
  ogre: 1.126,
  ogreMage: 1.205,
  roc: 1.023,
  thunderbird: 1.048,
  cyclops: 2.014,
  cyclopsKing: 1.830,
  behemoth: 1.202,
  ancientBehemoth: 0.922,
  // fortress
  gnoll: 0.990,
  gnollMarauder: 0.964,
  lizardman: 1.214,
  lizardWarrior: 1.045,
  serpentFly: 1.095,
  dragonFly: 1.073,
  basilisk: 0.853,
  greaterBasilisk: 0.808,
  gorgon: 0.909,
  mightyGorgon: 0.925,
  wyvern: 0.882,
  wyvernMonarch: 0.954,
  hydra: 1.215,
  chaosHydra: 0.989,
  // conflux
  pixie: 0.979,
  sprite: 0.926,
  airElemental: 1.413,
  stormElemental: 1.788,
  waterElemental: 1.168,
  iceElemental: 1.533,
  fireElemental: 1.050,
  energyElemental: 1.142,
  earthElemental: 0.611,
  magmaElemental: 0.646,
  psychicElemental: 0.934,
  magicElemental: 0.871,
  firebird: 0.858,
  phoenix: 0.811,
};

/**
 * The index table for the model in play.
 */
export function powerIndex(physical) {
  return physical ? POWER_INDEX_PHYSICAL : POWER_INDEX_CLASSIC;
}

/**
 * HOW FAR A SAME-TIER DUEL MAY BE EXTRAPOLATED, and the reason there is a limit.
 *
 * Every index is measured one stack against one stack of the same tier at equal
 * price (scripts/sim/tiers.mjs). That is the right instrument for a guard, a
 * war-band or a Pandora escort, which are built one species at a time. It is a
 * WEAKER statement about a creature's contribution to a seven-stack army, and
 * the physical model is where the difference bites: armour wins a same-tier duel
 * outright, so an Iron Golem measures at 0.26 — worth nearly four times its
 * price — while the same armour does very little against the tier-7s in a mixed
 * army. Spend a budget at 0.26 and you buy a quarter of the golems you needed.
 *
 * MEASURED, and the alternatives are recorded because they were run. Faction
 * round-robin at equal power under the physical model, spread strongest to
 * weakest (scripts/sim/roster.mjs section 1b, 12 seeds):
 *
 *     unbounded     1.46×   Tower 1.29 — the golem-and-gargoyle roster alone
 *     [0.50, 2.00]  1.21×   Tower 1.06
 *     [0.60, 1.70]  1.12×   Tower 1.00        ← this
 *     [0.70, 1.45]  1.14×   Tower 0.92 — over-corrected, the clamp now bites
 *                           creatures whose measurement was fine
 *
 * 1.12× is better than the classic model's own 1.15×, which is the point: two
 * damage models that disagree violently about which creatures are good can still
 * both size a fight honestly.
 *
 * ONE RULE FOR BOTH TABLES, though today it only ever touches the physical one —
 * the classic table sits inside 0.885–1.009, comfortably within the bound. That
 * is deliberate: the rule is about how far a duel generalises, not about which
 * model is being played, and a test pins the classic no-op so a future
 * re-measurement that drifts outside the bound is a visible event.
 */
export const POWER_INDEX_BOUND = [0.60, 1.70];

/**
 * Which model a game is running, for callers that hold a `state`.
 *
 * This reads the flag directly instead of calling `featureOn`, because
 * `featureOn` lives in GameState, GameState imports MapGenerator, and
 * MapGenerator imports this file — the import would close a cycle. It is safe
 * for exactly one reason: `physicalDamage` is not in `DEFAULT_ON_FEATURES`, so
 * for this key `featureOn` IS this expression. A test pins the two together, so
 * the day that stops being true the suite says so rather than the sizing
 * quietly reading the wrong table.
 */
export function physicalModel(state) {
  return !!(state && state.features && state.features.physicalDamage);
}

/**
 * What one of this creature is worth to a sizing decision.
 *
 * Falls back to `aiValue` for anything unmeasured, so an un-indexed creature
 * behaves exactly as it did before this module existed. `physical` defaults to
 * false — the shipped model — so a caller that has no state to ask, and every
 * test written before the split, reads the classic table exactly as before.
 */
export function creaturePower(creatureId, physical = false) {
  const v = CREATURES[creatureId]?.aiValue || 0;
  const k = powerIndex(physical)[creatureId];
  if (!k) return v;
  return v / Math.min(POWER_INDEX_BOUND[1], Math.max(POWER_INDEX_BOUND[0], k));
}

/** Σ power over a stack list, skipping empty slots. The power twin of armyValue. */
export function armyPower(army, physical = false) {
  let n = 0;
  for (const stack of army || []) {
    if (!stack) continue;
    n += creaturePower(stack.creature, physical) * (stack.count || 0);
  }
  return n;
}
