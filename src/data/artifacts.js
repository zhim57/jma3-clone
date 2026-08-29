/**
 * artifacts.js — Artifact catalog (paper-doll equipment).
 *
 * Slots (see HeroScreen paper doll): head, cape, neck, weapon, shield, torso,
 * ring (two ring sockets share the 'ring' slot type), feet, misc (two sockets).
 *
 * Effects understood by the engine (src/core/heroUtils.js):
 *   attack/defense/power/knowledge — primary stat bonuses
 *   morale/luck                    — army-wide morale & luck
 *   moveBonus                      — extra daily movement points (path length!)
 *   creatureSpeed                  — +combat speed for every stack
 *   creatureHealth                 — +HP for every stack
 *   goldPerDay                     — treasury income
 *   manaRegen                      — extra mana per day
 *
 * `value` drives treasure placement: higher value artifacts appear behind
 * tougher map guards.
 *
 * `campaign: true` marks a relic the SCENARIO grants (a chapter reward, a set
 * piece of a story panoply). The map generator never seats one as treasure, so
 * a skirmish cannot hand you a named campaign sword and a campaign cannot give
 * you a second copy of one you already carry.
 *
 * HOW TO ADD AN ARTIFACT: add an entry; effects combine automatically.
 */

export const ARTIFACTS = {
  // ---- weapons ----
  centaurAxe: {
    name: 'Centaur’s Axe', slot: 'weapon', value: 1,
    effects: { attack: 2 }, glyph: 'axe',
    desc: '+2 Attack',
  },
  blackshardBlade: {
    name: 'Blackshard of the Dead Knight', slot: 'weapon', value: 2,
    effects: { attack: 3 }, glyph: 'darksword',
    desc: '+3 Attack',
  },
  swordOfHellfire: {
    name: 'Sword of Hellfire', slot: 'weapon', value: 3,
    effects: { attack: 4 }, glyph: 'firesword',
    desc: '+4 Attack',
  },
  // +6, not +5, and the extra point is the whole reason it exists. At +5 this
  // was STRICTLY dominated by Mornbrand below — same slot, same rarity band,
  // same attack, plus a point of morale — so the map's hardest guard could only
  // ever be hiding the worse of two swords. It is the pure-magnitude weapon now
  // (Mornbrand trades a point of attack for utility), which also lines it up
  // with the other pure-stat relic of its band, the Aegis at +6 Defense.
  titansGladius: {
    name: 'Titan’s Gladius', slot: 'weapon', value: 4,
    effects: { attack: 6 }, glyph: 'gladius',
    desc: '+6 Attack',
  },
  // Value-4 relics that share the "grand prize" band with the Gladius, so every
  // map's heavily-guarded jackpot isn't always a sword (item E40). One per
  // primary stat, top-tier magnitudes.
  aegisOfTitans: {
    name: 'Aegis of the Titans', slot: 'shield', value: 4,
    effects: { defense: 6 }, glyph: 'towershield',
    desc: '+6 Defense',
  },
  orbOfTheFirmament: {
    name: 'Orb of the Firmament', slot: 'misc', value: 4,
    effects: { power: 5 }, glyph: 'talisman',
    desc: '+5 Power',
  },
  // Named apart from the value-2 `magiCrown` below, which is the HoMM3 relic
  // (+4 Knowledge) and holds the original name. Both are head slot and both were
  // called "Crown of the Supreme Magi", so a chest could hand you either and the
  // hero screen showed two different artifacts under one name.
  crownOfTheMagi: {
    name: 'Crown of the Elder Magi', slot: 'head', value: 4,
    effects: { knowledge: 5 }, glyph: 'crown',
    desc: '+5 Knowledge',
  },
  // Campaign relics for "The First Vow" (data/campaigns.js) — value-4 capstones
  // granted at the START of chapters 6 / 11 / 17 (a kind:'artifact' bonus). Worn
  // together they complete the Panoply of the First Dawn set (ARTIFACT_SETS below).
  // `campaign: true` keeps all three out of random-map treasure: they were being
  // seated as ordinary loot (a small map placed one every other game, a huge one
  // three or four), which put a named story relic on a map with no story and let
  // a campaign hand you a second Mornbrand on top of the one it just granted.
  mornbrand: {
    name: 'Mornbrand', slot: 'weapon', value: 4, campaign: true,
    effects: { attack: 5, morale: 1 }, glyph: 'gladius',
    desc: '+5 Attack, +1 Morale',
  },
  sunwardBastion: {
    name: 'Sunward Bastion', slot: 'torso', value: 4, campaign: true,
    effects: { defense: 5, creatureHealth: 2 }, glyph: 'wonderarmor',
    desc: '+5 Defense, +2 HP to all creatures',
  },
  dawnstarHelm: {
    name: 'Dawnstar Helm', slot: 'head', value: 4, campaign: true,
    effects: { knowledge: 4, power: 2 }, glyph: 'helm',
    desc: '+4 Knowledge, +2 Power',
  },
  // Four more of the top band, one per slot it did not yet cover. With the
  // campaign relics above excluded the grand prize was drawn from FOUR artifacts
  // — a sword, a shield, an orb and a crown — so the hardest guard on the map hid
  // one of the same four things every game, and three of the four were a flat
  // primary stat. These are the same tier expressed as tempo, reach, spirit and
  // endurance instead.
  stormcallerCloak: {
    name: 'Cloak of the Stormcaller', slot: 'cape', value: 4,
    effects: { creatureSpeed: 3 }, glyph: 'cape',
    desc: '+3 speed to all creatures in combat',
  },
  sevenLeagueBoots: {
    name: 'Seven-League Boots', slot: 'feet', value: 4,
    effects: { moveBonus: 1000 }, glyph: 'boots',
    desc: '+10 tiles of movement per day',
  },
  collarOfDominion: {
    name: 'Collar of Dominion', slot: 'neck', value: 4,
    effects: { morale: 2, luck: 2 }, glyph: 'pendant',
    desc: '+2 Morale, +2 Luck',
  },
  ringOfTheDeepWell: {
    name: 'Ring of the Deep Well', slot: 'ring', value: 4,
    effects: { knowledge: 3, manaRegen: 5 }, glyph: 'ring2',
    desc: '+3 Knowledge, +5 mana regenerated per day',
  },
  // ---- shields ----
  dwarvenShield: {
    name: 'Shield of the Dwarven Lords', slot: 'shield', value: 1,
    effects: { defense: 2 }, glyph: 'shield',
    desc: '+2 Defense',
  },
  gnollShield: {
    name: 'Buckler of the Gnoll King', slot: 'shield', value: 2,
    effects: { defense: 4 }, glyph: 'buckler',
    desc: '+4 Defense',
  },
  sentinelShield: {
    name: 'Tower Shield of the Sentinel', slot: 'shield', value: 3,
    effects: { defense: 5 }, glyph: 'towershield',
    desc: '+5 Defense',
  },
  // ---- head ----
  alabasterHelm: {
    name: 'Helm of the Alabaster Unicorn', slot: 'head', value: 1,
    effects: { knowledge: 1 }, glyph: 'helm',
    desc: '+1 Knowledge',
  },
  magiCrown: {
    name: 'Crown of the Supreme Magi', slot: 'head', value: 2,
    effects: { knowledge: 4 }, glyph: 'crown',
    desc: '+4 Knowledge',
  },
  circletOfPower: {
    name: 'Circlet of the Enlightened', slot: 'head', value: 2,
    effects: { power: 2 }, glyph: 'circlet',
    desc: '+2 Power',
  },
  // ---- torso ----
  petrifiedWood: {
    name: 'Breastplate of Petrified Wood', slot: 'torso', value: 1,
    effects: { power: 1 }, glyph: 'breastplate',
    desc: '+1 Power',
  },
  armorOfWonder: {
    name: 'Armor of Wonder', slot: 'torso', value: 3,
    effects: { attack: 1, defense: 1, power: 1, knowledge: 1 }, glyph: 'wonderarmor',
    desc: '+1 to all primary stats',
  },
  dragonScaleMail: {
    name: 'Dragon Scale Mail', slot: 'torso', value: 3,
    effects: { attack: 2, defense: 2 }, glyph: 'scalemail',
    desc: '+2 Attack, +2 Defense',
  },
  // ---- cape ----
  capeOfVelocity: {
    name: 'Cape of Velocity', slot: 'cape', value: 3,
    effects: { creatureSpeed: 2 }, glyph: 'cape',
    desc: '+2 speed to all creatures in combat',
  },
  wardingCloak: {
    name: 'Warding Cloak', slot: 'cape', value: 2,
    effects: { defense: 2 }, glyph: 'cloak',
    desc: '+2 Defense',
  },
  // ---- neck ----
  pendantOfCourage: {
    name: 'Pendant of Courage', slot: 'neck', value: 2,
    effects: { morale: 1, luck: 1 }, glyph: 'pendant',
    desc: '+1 Morale, +1 Luck',
  },
  amuletOfInsight: {
    name: 'Amulet of Insight', slot: 'neck', value: 2,
    effects: { knowledge: 2 }, glyph: 'amulet',
    desc: '+2 Knowledge',
  },
  necklaceOfBliss: {
    name: 'Celestial Necklace of Bliss', slot: 'neck', value: 3,
    effects: { attack: 2, defense: 2, power: 2, knowledge: 2 }, glyph: 'necklace',
    desc: '+2 to all primary stats',
  },
  // ---- rings ----
  ringOfVitality: {
    name: 'Ring of Vitality', slot: 'ring', value: 1,
    effects: { creatureHealth: 1 }, glyph: 'ring',
    desc: '+1 HP to all creatures',
  },
  ringOfConjuring: {
    name: 'Ring of Conjuring', slot: 'ring', value: 1,
    effects: { power: 1 }, glyph: 'ring2',
    desc: '+1 Power',
  },
  ringOfLife: {
    name: 'Ring of Life', slot: 'ring', value: 2,
    effects: { creatureHealth: 2 }, glyph: 'ring3',
    desc: '+2 HP to all creatures',
  },
  // ---- feet: PATH LENGTH boosters ----
  bootsOfSpeed: {
    name: 'Boots of Speed', slot: 'feet', value: 2,
    effects: { moveBonus: 600 }, glyph: 'boots',
    desc: '+6 tiles of movement per day',
  },
  wingedSandals: {
    name: 'Sandals of the Zephyr', slot: 'feet', value: 3,
    effects: { moveBonus: 800 }, glyph: 'sandals',
    desc: '+8 tiles of movement per day',
  },
  // ---- misc ----
  equestrianGloves: {
    name: 'Equestrian’s Gloves', slot: 'misc', value: 2,
    effects: { moveBonus: 200 }, glyph: 'gloves',
    desc: '+2 tiles of movement per day',
  },
  endlessPurse: {
    name: 'Endless Purse of Gold', slot: 'misc', value: 3,
    effects: { goldPerDay: 500 }, glyph: 'purse',
    desc: '+500 gold per day',
  },
  charmOfMana: {
    name: 'Charm of Mana', slot: 'misc', value: 1,
    effects: { manaRegen: 2 }, glyph: 'charm',
    desc: '+2 mana regenerated per day',
  },
  talismanOfMana: {
    name: 'Talisman of Mana', slot: 'misc', value: 2,
    effects: { manaRegen: 4 }, glyph: 'talisman',
    desc: '+4 mana regenerated per day',
  },
  bannerOfValor: {
    name: 'Banner of Valor', slot: 'misc', value: 2,
    effects: { morale: 2 }, glyph: 'banner',
    desc: '+2 Morale',
  },
  // ---- band fillers ----
  // Four slots had a hole in the middle of their ladder — no value-3 head, no
  // value-3 ring, no value-2 torso, no value-1 cape — and a large map asks for
  // more artifacts than the catalog holds, so every hole was papered over by a
  // draw from some other band. These fill the holes at the magnitude the
  // neighbouring rungs imply; none is a new idea, only a missing step.
  helmOfTheSternWatch: {
    name: 'Helm of the Stern Watch', slot: 'head', value: 3,
    effects: { knowledge: 2, defense: 2 }, glyph: 'helm',
    desc: '+2 Knowledge, +2 Defense',
  },
  vanguardGauntlets: {
    name: 'Gauntlets of the Vanguard', slot: 'misc', value: 3,
    effects: { attack: 3 }, glyph: 'gloves',
    desc: '+3 Attack',
  },
  ringOfTheWardedHeart: {
    name: 'Ring of the Warded Heart', slot: 'ring', value: 3,
    effects: { creatureHealth: 3 }, glyph: 'ring3',
    desc: '+3 HP to all creatures',
  },
  marchBrigandine: {
    name: 'Brigandine of the March', slot: 'torso', value: 2,
    effects: { defense: 3 }, glyph: 'breastplate',
    desc: '+3 Defense',
  },
  pilgrimsCloak: {
    name: 'Pilgrim’s Cloak', slot: 'cape', value: 1,
    effects: { morale: 1 }, glyph: 'cloak',
    desc: '+1 Morale',
  },
  // ---- second rungs ----
  // Sixteen more, sized against MEASURED demand rather than taste. Counting both
  // map levels, the generator asks a 88×72 map for ~8 value-1, ~17 value-2 and
  // ~15 value-3 artifacts against pools of 8 / 13 / 11, so the two middle bands
  // ran out and the tail of every large map repeated itself. These are +1 / +8 /
  // +7 in exactly those bands.
  //
  // None of them is a stronger version of something already in its band — that
  // would be dominance, which a test now forbids. Each trades a point of the
  // band's obvious stat for something else the band already prices: a point of
  // luck, of morale, of movement, of creature health. Two artifacts of the same
  // rarity in the same slot should be a CHOICE.
  cloverCharm: {
    name: 'Four-Leaf Charm', slot: 'neck', value: 1,
    effects: { luck: 1 }, glyph: 'charm',
    desc: '+1 Luck',
  },
  moonshadowBlade: {
    name: 'Moonshadow Blade', slot: 'weapon', value: 2,
    effects: { attack: 2, luck: 1 }, glyph: 'darksword',
    desc: '+2 Attack, +1 Luck',
  },
  oathBulwark: {
    name: 'Bulwark of the Oath', slot: 'shield', value: 2,
    effects: { defense: 3, morale: 1 }, glyph: 'buckler',
    desc: '+3 Defense, +1 Morale',
  },
  farWatchVisor: {
    name: 'Visor of the Far Watch', slot: 'head', value: 2,
    effects: { defense: 2, knowledge: 1 }, glyph: 'helm',
    desc: '+2 Defense, +1 Knowledge',
  },
  emberScaleJerkin: {
    name: 'Ember-Scale Jerkin', slot: 'torso', value: 2,
    effects: { attack: 3 }, glyph: 'scalemail',
    desc: '+3 Attack',
  },
  windrunnerMantle: {
    name: 'Windrunner’s Mantle', slot: 'cape', value: 2,
    effects: { moveBonus: 300 }, glyph: 'cape',
    desc: '+3 tiles of movement per day',
  },
  amuletOfEmbers: {
    name: 'Amulet of Embers', slot: 'neck', value: 2,
    effects: { power: 2 }, glyph: 'amulet',
    desc: '+2 Power',
  },
  wardensSignet: {
    name: 'Signet of the Warden', slot: 'ring', value: 2,
    effects: { defense: 2 }, glyph: 'ring2',
    desc: '+2 Defense',
  },
  longRoadGreaves: {
    name: 'Greaves of the Long Road', slot: 'feet', value: 2,
    effects: { moveBonus: 400, defense: 1 }, glyph: 'sandals',
    desc: '+4 tiles of movement per day, +1 Defense',
  },
  reaversEdge: {
    name: 'Reaver’s Edge', slot: 'weapon', value: 3,
    effects: { attack: 3, luck: 1 }, glyph: 'firesword',
    desc: '+3 Attack, +1 Luck',
  },
  sunkenKeepWard: {
    name: 'Ward of the Sunken Keep', slot: 'shield', value: 3,
    effects: { defense: 4, creatureHealth: 1 }, glyph: 'shield',
    desc: '+4 Defense, +1 HP to all creatures',
  },
  tideseerDiadem: {
    name: 'Diadem of the Tideseer', slot: 'head', value: 3,
    effects: { power: 3 }, glyph: 'circlet',
    desc: '+3 Power',
  },
  ninefoldHauberk: {
    name: 'Hauberk of the Ninefold Weave', slot: 'torso', value: 3,
    effects: { defense: 2, creatureHealth: 2 }, glyph: 'breastplate',
    desc: '+2 Defense, +2 HP to all creatures',
  },
  nightMarchCloak: {
    name: 'Cloak of the Night March', slot: 'cape', value: 3,
    effects: { moveBonus: 500, morale: 1 }, glyph: 'cloak',
    desc: '+5 tiles of movement per day, +1 Morale',
  },
  threeCrownsChain: {
    name: 'Chain of the Three Crowns', slot: 'neck', value: 3,
    effects: { knowledge: 3, morale: 1 }, glyph: 'necklace',
    desc: '+3 Knowledge, +1 Morale',
  },
  emberForgeBand: {
    name: 'Band of the Ember Forge', slot: 'ring', value: 3,
    effects: { attack: 2, power: 2 }, glyph: 'ring',
    desc: '+2 Attack, +2 Power',
  },
  // Three more, and the exact number is not arbitrary. Only the top band is
  // unreachable from below, so the three lower bands behave as one shared pool:
  // what decides whether a map repeats itself is total lower-band supply against
  // total lower-band demand. Clash of Kingdoms (96×80) asks for 50 and had 48.
  // These are the two. The third is margin, and they sit in the bands with the
  // deepest per-band shortfall (value 3 is short 9 against its own worst seed,
  // value 2 short 6) so fewer draws have to borrow from a neighbour at all.
  ironshodSabatons: {
    name: 'Ironshod Sabatons', slot: 'feet', value: 3,
    effects: { defense: 3, moveBonus: 200 }, glyph: 'boots',
    desc: '+2 tiles of movement per day, +3 Defense',
  },
  valewindHorn: {
    name: 'Horn of the Valewind', slot: 'misc', value: 3,
    effects: { morale: 2, luck: 1 }, glyph: 'banner',
    desc: '+2 Morale, +1 Luck',
  },
  // The bottom rung of a ladder that had none: creature speed ran +2 at value 3
  // and +3 at value 4 with nothing beneath it.
  bandOfQuickening: {
    name: 'Band of Quickening', slot: 'ring', value: 2,
    effects: { creatureSpeed: 1 }, glyph: 'ring3',
    desc: '+1 speed to all creatures in combat',
  },
};

/**
 * What an artifact of rarity band `v` costs — by BAND rather than by id, because
 * several systems have to price a relic nobody has drawn yet: a creature bank's
 * reward is a band, and so is a Pandora's Box's guard budget. One definition, so
 * the trading post, the AI and the box generator cannot come to disagree about
 * what a relic is worth.
 */
export function artifactBandCost(v) {
  return { gold: v * 2000, gems: v * 2 };
}

/** Paper-doll socket layout: socket id -> accepted slot type. */
export const EQUIP_SOCKETS = {
  head: 'head', cape: 'cape', neck: 'neck',
  weapon: 'weapon', shield: 'shield', torso: 'torso',
  ring1: 'ring', ring2: 'ring',
  feet: 'feet', misc1: 'misc', misc2: 'misc',
};

/**
 * Combination (assembled) artifacts — a "set bonus" model. When a hero wears
 * EVERY component of a set at once, they gain the set's `effects` ON TOP of the
 * components' own bonuses (the synergy). Break the set (unequip/trade any piece)
 * and the bonus vanishes — no physical merge, so nothing to disassemble and no
 * new saved state (a completed set is derived from `hero.equipment`).
 *
 * effects use the same engine-understood keys as artifacts (see the header), so
 * they flow through heroUtils.artifactBonus to combat / movement / mana / income.
 *
 * INVARIANT (pinned by tests/combo-artifacts.test.js): every component exists,
 * and a set's components all fit at once (≤ the socket count for each slot).
 */
export const ARTIFACT_SETS = {
  warlordsPanoply: {
    name: "Warlord's Panoply",
    components: ['titansGladius', 'sentinelShield', 'dragonScaleMail'],
    effects: { attack: 2, defense: 2, morale: 1 },
    desc: '+2 Attack, +2 Defense, +1 Morale',
  },
  archmagesRegalia: {
    name: "Archmage's Regalia",
    components: ['magiCrown', 'amuletOfInsight', 'talismanOfMana'],
    effects: { power: 2, knowledge: 1, manaRegen: 4 },
    desc: '+2 Power, +1 Knowledge, +4 mana/day',
  },
  pathfindersKit: {
    name: "Pathfinder's Kit",
    components: ['bootsOfSpeed', 'equestrianGloves', 'endlessPurse'],
    effects: { moveBonus: 400, goldPerDay: 250 },
    desc: '+4 tiles/day movement, +250 gold/day',
  },
  // The three relics of "The First Vow" reforged. The hardest set to assemble —
  // three value-4 relics gathered across chapters 6/11/17 — so it earns a genuine
  // capstone spike (morale caps at the engine ceiling, so it can't run away).
  panoplyOfFirstDawn: {
    name: 'Panoply of the First Dawn',
    components: ['mornbrand', 'sunwardBastion', 'dawnstarHelm'],
    effects: { attack: 2, defense: 2, morale: 2, luck: 1, manaRegen: 3 },
    desc: '+2 Attack, +2 Defense, +2 Morale, +1 Luck, +3 mana/day',
  },
};

/** Which of `hero`'s equipped artifacts (by id) — for set completeness checks. */
export function equippedArtifactIds(hero) {
  return new Set(Object.values(hero.equipment || {}).filter(Boolean));
}

/** True when every component of `set` is currently worn. */
export function heroHasFullSet(hero, set) {
  const worn = equippedArtifactIds(hero);
  return set.components.every((id) => worn.has(id));
}

/** The completed sets a hero is currently wearing (ids). */
export function activeArtifactSets(hero) {
  return Object.keys(ARTIFACT_SETS).filter((id) => heroHasFullSet(hero, ARTIFACT_SETS[id]));
}
