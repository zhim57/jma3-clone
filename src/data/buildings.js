/**
 * buildings.js — Town building catalog.
 *
 * Two groups:
 *   COMMON_BUILDINGS — shared by every faction (halls, fort line, guild, market...).
 *   DWELLINGS[factionId] — the 7 creature dwellings (+ upgrades) per faction.
 *
 * Building schema:
 *   name, desc      display strings
 *   cost            resource cost object
 *   requires        array of building ids that must already be built
 *   upgradeOf       id of the building this one replaces (hall/fort/dwelling lines)
 *   income          daily resources granted to the owner
 *   dwellingTier    (dwellings only) which creature tier it recruits
 *   dwellingUpgrade (dwellings only) true = unlocks the upgraded creature
 *   guildLevel      (mage guilds only) spell tier taught
 *   special         id handled ad-hoc by game logic ('stables', 'shipyard')
 *   coastal         true = only buildable when the town borders water
 *                   (see townIsCoastal in core/actions.js)
 *
 * HOW TO ADD A BUILDING: add an entry, give it a cost + requires; if it needs
 * custom behavior add a `special` tag and handle it where relevant
 * (search for existing specials to see the pattern).
 */

export const COMMON_BUILDINGS = {
  // ---- Hall line: daily gold ----
  villageHall: {
    name: 'Village Hall', desc: 'The heart of the town. +500 gold/day.',
    cost: {}, requires: [], income: { gold: 500 }, autoBuilt: true,
  },
  townHall: {
    name: 'Town Hall', desc: '+1000 gold/day.',
    cost: { gold: 2500 }, requires: ['tavern'], upgradeOf: 'villageHall',
    income: { gold: 1000 },
  },
  cityHall: {
    name: 'City Hall', desc: '+2000 gold/day.',
    cost: { gold: 5000 }, requires: ['townHall', 'marketplace', 'blacksmith', 'mageGuild1'],
    upgradeOf: 'townHall', income: { gold: 2000 },
  },
  capitol: {
    name: 'Capitol', desc: '+4000 gold/day. Only one per realm.',
    cost: { gold: 10000 }, requires: ['cityHall', 'castle'], upgradeOf: 'cityHall',
    income: { gold: 4000 }, onePerPlayer: true,
  },

  // ---- Fort line: walls & growth ----
  fort: {
    name: 'Fort', desc: 'City walls. Garrison defends behind fortifications.',
    cost: { gold: 5000, wood: 20, ore: 20 }, requires: [],
  },
  citadel: {
    name: 'Citadel', desc: 'Keep tower. Weekly creature growth +50%.',
    cost: { gold: 2500, ore: 5 }, requires: ['fort'], upgradeOf: 'fort',
  },
  castle: {
    name: 'Castle', desc: 'Full fortifications. Weekly creature growth +100%.',
    cost: { gold: 5000, wood: 10, ore: 10 }, requires: ['citadel'], upgradeOf: 'citadel',
  },

  // ---- Support ----
  tavern: {
    name: 'Tavern', desc: 'Recruit new heroes here.',
    cost: { gold: 500, wood: 5 }, requires: [],
  },
  marketplace: {
    name: 'Marketplace', desc: 'Trade resources.',
    cost: { gold: 500, wood: 5 }, requires: [],
  },
  resourceSilo: {
    name: 'Resource Silo', desc: 'Produces bonus resources daily.',
    cost: { gold: 5000, ore: 5 }, requires: ['marketplace'],
    // income filled per faction below (factionIncome)
    factionIncome: {
      castle: { wood: 1, ore: 1 },
      inferno: { mercury: 1 },
      tower: { gems: 1 },
      rampart: { crystal: 1 },
      necropolis: { sulfur: 1 },
      dungeon: { sulfur: 1 },
      stronghold: { ore: 1, wood: 1 },
      fortress: { wood: 1, ore: 1 },
      conflux: { mercury: 1 },
    },
  },
  blacksmith: {
    name: 'Blacksmith', desc: 'Sells war machines to the visiting hero (required for City Hall).',
    cost: { gold: 1000, wood: 5 }, requires: [], special: 'blacksmith',
  },
  shipyard: {
    name: 'Shipyard', desc: 'Build boats at the town’s own coast.',
    cost: { gold: 2000, wood: 20 }, requires: [], special: 'shipyard', coastal: true,
  },
  altar: {
    name: 'Altar of Transmutation',
    desc: 'Transmute army stacks into creatures this town can build, for a power tax + gold fee.',
    cost: { gold: 4000, crystal: 5 }, requires: ['marketplace'], special: 'transmuter',
  },
  hallOfReflection: {
    name: 'Hall of Reflection',
    desc: 'A visiting hero may forget a secondary skill for a level-scaled fee, freeing the slot.',
    cost: { gold: 5000, gems: 5 }, requires: ['mageGuild1'], onePerPlayer: true,
    special: 'reflection', feature: 'hallOfReflection', // only offered when the feature is on
  },
  bank: {
    name: 'Town Bank',
    desc: 'Pays weekly interest on the gold you hold, and lends against a big-ticket building — secured, repaid weekly.',
    cost: { gold: 3000, ore: 5 }, requires: ['marketplace'],
    special: 'bank', feature: 'townBank',
  },

  // ---- Mage guild ----
  mageGuild1: {
    name: 'Mage Guild Level 1', desc: 'Teaches tier 1 spells to visiting heroes.',
    cost: { gold: 2000, wood: 5, ore: 5 }, requires: [], guildLevel: 1,
  },
  mageGuild2: {
    name: 'Mage Guild Level 2', desc: 'Teaches tier 2 spells.',
    cost: { gold: 1000, wood: 5, ore: 5, mercury: 4, sulfur: 4, crystal: 4, gems: 4 },
    requires: ['mageGuild1'], upgradeOf: 'mageGuild1', guildLevel: 2,
  },
  mageGuild3: {
    name: 'Mage Guild Level 3', desc: 'Teaches tier 3 spells.',
    cost: { gold: 1000, wood: 5, ore: 5, mercury: 6, sulfur: 6, crystal: 6, gems: 6 },
    requires: ['mageGuild2'], upgradeOf: 'mageGuild2', guildLevel: 3,
  },
  mageGuild4: {
    name: 'Mage Guild Level 4', desc: 'Teaches tier 4 spells.',
    cost: { gold: 1000, wood: 5, ore: 5, mercury: 8, sulfur: 8, crystal: 8, gems: 8 },
    requires: ['mageGuild3'], upgradeOf: 'mageGuild3', guildLevel: 4,
  },
  mageGuild5: {
    name: 'Mage Guild Level 5', desc: 'Teaches tier 5 spells.',
    cost: { gold: 1000, wood: 5, ore: 5, mercury: 10, sulfur: 10, crystal: 10, gems: 10 },
    requires: ['mageGuild4'], upgradeOf: 'mageGuild4', guildLevel: 5,
  },
};

/** Spells offered per guild level: index 0 unused; [level] = how many spells of that tier.
 *  Tier 5 gets TWO slots (not one): its pool mixes 4 combat spells with 2 adventure
 *  spells (Fly / Dimension Door), so a single slot had a ~1-in-3 chance of leaving a
 *  town with no tier-5 combat spell at all. Two slots drop that to ~1-in-15. */
export const GUILD_SPELL_SLOTS = [0, 3, 3, 2, 2, 2];

export const DWELLINGS = {
  castle: {
    dwelling1: {
      name: 'Guardhouse', desc: 'Recruit Pikemen.',
      cost: { gold: 500, wood: 5 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Guardhouse', desc: 'Recruit Halberdiers.',
      cost: { gold: 1000, wood: 5 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Archers’ Tower', desc: 'Recruit Archers.',
      cost: { gold: 1000, wood: 5, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Archers’ Tower', desc: 'Recruit Marksmen.',
      cost: { gold: 1500, wood: 5, ore: 5 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Griffin Tower', desc: 'Recruit Griffins.',
      cost: { gold: 2000, ore: 10 }, requires: ['dwelling1'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Griffin Tower', desc: 'Recruit Royal Griffins.',
      cost: { gold: 3000, ore: 5 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Barracks', desc: 'Recruit Swordsmen.',
      cost: { gold: 2000, wood: 10, ore: 5 }, requires: ['dwelling2', 'blacksmith'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Barracks', desc: 'Recruit Crusaders.',
      cost: { gold: 3000, wood: 5, ore: 5 }, requires: ['dwelling4'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Monastery', desc: 'Recruit Monks.',
      cost: { gold: 3000, wood: 5, ore: 5, mercury: 2, sulfur: 2, crystal: 2, gems: 2 },
      requires: ['mageGuild1', 'dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Monastery', desc: 'Recruit Zealots.',
      cost: { gold: 3000, wood: 5, ore: 5 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Training Grounds', desc: 'Recruit Cavaliers.',
      cost: { gold: 5000, wood: 20 }, requires: ['dwelling4', 'stables'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Training Grounds', desc: 'Recruit Champions.',
      cost: { gold: 5000, wood: 10 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Portal of Glory', desc: 'Recruit Angels.',
      cost: { gold: 20000, ore: 10, gems: 10 }, requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Portal of Glory', desc: 'Recruit Archangels.',
      cost: { gold: 20000, ore: 10, gems: 10 }, requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
    // Faction-specific support building (demonstrates the `special` hook).
    stables: {
      name: 'Stables', desc: 'Visiting heroes gain +400 movement until end of week.',
      cost: { gold: 2000, wood: 10 }, requires: ['dwelling2'], special: 'stables',
    },
  },

  inferno: {
    dwelling1: {
      name: 'Imp Crucible', desc: 'Recruit Imps.',
      cost: { gold: 300, wood: 5 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Imp Crucible', desc: 'Recruit Familiars.',
      cost: { gold: 1000, wood: 5 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Hall of Sins', desc: 'Recruit Gogs.',
      cost: { gold: 1000, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Hall of Sins', desc: 'Recruit Magogs.',
      cost: { gold: 1500, ore: 5, sulfur: 2 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Kennels', desc: 'Recruit Hell Hounds.',
      cost: { gold: 1500, wood: 10 }, requires: ['dwelling2'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Kennels', desc: 'Recruit Cerberi.',
      cost: { gold: 2000, wood: 5, sulfur: 2 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Demon Gate', desc: 'Recruit Demons.',
      cost: { gold: 2000, ore: 10 }, requires: ['dwelling3'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Demon Gate', desc: 'Recruit Horned Demons.',
      cost: { gold: 3000, ore: 5, sulfur: 2 }, requires: ['dwelling4'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Hell Hole', desc: 'Recruit Pit Fiends.',
      cost: { gold: 3000, ore: 10, sulfur: 4 }, requires: ['dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Hell Hole', desc: 'Recruit Pit Lords.',
      cost: { gold: 3000, ore: 5, sulfur: 4 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Fire Lake', desc: 'Recruit Efreeti.',
      cost: { gold: 4000, ore: 10, sulfur: 5 }, requires: ['mageGuild1', 'dwelling4'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Fire Lake', desc: 'Recruit Efreet Sultans.',
      cost: { gold: 4000, sulfur: 5, mercury: 3 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Forsaken Palace', desc: 'Recruit Devils.',
      cost: { gold: 15000, ore: 10, sulfur: 20, mercury: 10 },
      requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Forsaken Palace', desc: 'Recruit Arch Devils.',
      cost: { gold: 20000, ore: 10, sulfur: 20, mercury: 10 },
      requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
  },

  tower: {
    dwelling1: {
      name: 'Workshop', desc: 'Recruit Servitors.',
      cost: { gold: 400, wood: 5 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Workshop', desc: 'Recruit Master Servitors.',
      cost: { gold: 1000, wood: 5 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Parapet', desc: 'Recruit Stone Gargoyles.',
      cost: { gold: 1000, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Parapet', desc: 'Recruit Obsidian Gargoyles.',
      cost: { gold: 1500, ore: 5, crystal: 2 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Golem Factory', desc: 'Recruit Stone Golems.',
      cost: { gold: 2000, ore: 10 }, requires: ['dwelling2'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Golem Factory', desc: 'Recruit Iron Golems.',
      cost: { gold: 2000, ore: 5, mercury: 2 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Mage Tower', desc: 'Recruit Mages.',
      cost: { gold: 2000, wood: 10, ore: 5 }, requires: ['mageGuild1', 'dwelling3'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Mage Tower', desc: 'Recruit Arch Mages.',
      cost: { gold: 3000, mercury: 3 }, requires: ['dwelling4'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Altar of Wishes', desc: 'Recruit Genies.',
      cost: { gold: 3000, mercury: 4, gems: 2 }, requires: ['dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Altar of Wishes', desc: 'Recruit Master Genies.',
      cost: { gold: 3000, mercury: 4 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Golden Pavilion', desc: 'Recruit Nagas.',
      cost: { gold: 4000, gems: 5 }, requires: ['dwelling5'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Golden Pavilion', desc: 'Recruit Naga Queens.',
      cost: { gold: 4000, gems: 5, mercury: 3 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Cloud Temple', desc: 'Recruit Giants.',
      cost: { gold: 15000, ore: 10, crystal: 20 }, requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Cloud Temple', desc: 'Recruit Titans.',
      cost: { gold: 20000, ore: 10, crystal: 20 }, requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
  },

  rampart: {
    dwelling1: {
      name: 'Centaur Stables', desc: 'Recruit Centaurs.',
      cost: { gold: 400, wood: 5 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Centaur Stables', desc: 'Recruit Centaur Captains.',
      cost: { gold: 1000, wood: 5 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Dwarf Cottage', desc: 'Recruit Dwarves.',
      cost: { gold: 1000, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Dwarf Cottage', desc: 'Recruit Battle Dwarves.',
      cost: { gold: 1500, ore: 5, crystal: 2 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Homestead', desc: 'Recruit Wood Elves.',
      cost: { gold: 1500, wood: 10 }, requires: ['dwelling2'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Homestead', desc: 'Recruit Grand Elves.',
      cost: { gold: 2000, wood: 5 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Enchanted Spring', desc: 'Recruit Pegasi.',
      cost: { gold: 2000, wood: 5, crystal: 2 }, requires: ['dwelling3'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Enchanted Spring', desc: 'Recruit Silver Pegasi.',
      cost: { gold: 3000, crystal: 2 }, requires: ['dwelling4'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Dendroid Arches', desc: 'Recruit Dendroid Guards.',
      cost: { gold: 2500, wood: 10 }, requires: ['dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Dendroid Arches', desc: 'Recruit Dendroid Soldiers.',
      cost: { gold: 3000, wood: 10 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Unicorn Glade', desc: 'Recruit Unicorns.',
      cost: { gold: 4000, wood: 10, crystal: 5 }, requires: ['mageGuild1', 'dwelling5'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Unicorn Glade', desc: 'Recruit War Unicorns.',
      cost: { gold: 4000, crystal: 5 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Dragon Cliffs', desc: 'Recruit Green Dragons.',
      cost: { gold: 15000, ore: 10, crystal: 20 }, requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Dragon Cliffs', desc: 'Recruit Gold Dragons.',
      cost: { gold: 20000, ore: 10, crystal: 20 }, requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
  },

  necropolis: {
    dwelling1: {
      name: 'Cursed Temple', desc: 'Recruit Skeletons.',
      cost: { gold: 300, wood: 5 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Cursed Temple', desc: 'Recruit Skeleton Warriors.',
      cost: { gold: 1000, wood: 5 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Graveyard', desc: 'Recruit Walking Dead.',
      cost: { gold: 1000, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Graveyard', desc: 'Recruit Zombies.',
      cost: { gold: 1500, ore: 5, sulfur: 2 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Tomb of Souls', desc: 'Recruit Wights.',
      cost: { gold: 1500, wood: 10 }, requires: ['dwelling2'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Tomb of Souls', desc: 'Recruit Wraiths.',
      cost: { gold: 2000, wood: 5, mercury: 2 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Estate', desc: 'Recruit Vampires.',
      cost: { gold: 2000, ore: 10 }, requires: ['dwelling3'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Estate', desc: 'Recruit Vampire Lords.',
      cost: { gold: 3000, ore: 5, sulfur: 2 }, requires: ['dwelling4'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Mausoleum', desc: 'Recruit Liches.',
      cost: { gold: 3000, ore: 10, sulfur: 4 }, requires: ['mageGuild1', 'dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Mausoleum', desc: 'Recruit Power Liches.',
      cost: { gold: 3000, ore: 5, sulfur: 4 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Hall of Darkness', desc: 'Recruit Black Knights.',
      cost: { gold: 4000, ore: 10, mercury: 5 }, requires: ['dwelling5'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Hall of Darkness', desc: 'Recruit Dread Knights.',
      cost: { gold: 4000, mercury: 5 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Dragon Vault', desc: 'Recruit Bone Dragons.',
      cost: { gold: 15000, ore: 10, sulfur: 20 }, requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Dragon Vault', desc: 'Recruit Ghost Dragons.',
      cost: { gold: 20000, ore: 10, sulfur: 20, mercury: 5 }, requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
  },

  dungeon: {
    dwelling1: {
      name: 'Warren', desc: 'Recruit Troglodytes.',
      cost: { gold: 400, wood: 5 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Warren', desc: 'Recruit Infernal Troglodytes.',
      cost: { gold: 1000, wood: 5 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Harpy Loft', desc: 'Recruit Harpies.',
      cost: { gold: 1000, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Harpy Loft', desc: 'Recruit Harpy Hags.',
      cost: { gold: 1500, ore: 5, mercury: 2 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Pillar of Eyes', desc: 'Recruit Beholders.',
      cost: { gold: 1500, wood: 10 }, requires: ['dwelling2'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Pillar of Eyes', desc: 'Recruit Evil Eyes.',
      cost: { gold: 2000, wood: 5, sulfur: 2 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Chapel of Stilled Voices', desc: 'Recruit Medusas.',
      cost: { gold: 2000, ore: 10 }, requires: ['dwelling3'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Chapel of Stilled Voices', desc: 'Recruit Medusa Queens.',
      cost: { gold: 3000, ore: 5, sulfur: 2 }, requires: ['dwelling4'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Labyrinth', desc: 'Recruit Minotaurs.',
      cost: { gold: 3000, ore: 10, sulfur: 4 }, requires: ['dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Labyrinth', desc: 'Recruit Minotaur Kings.',
      cost: { gold: 3000, ore: 5, sulfur: 4 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Manticore Lair', desc: 'Recruit Manticores.',
      cost: { gold: 4000, ore: 10, sulfur: 5 }, requires: ['mageGuild1', 'dwelling5'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Manticore Lair', desc: 'Recruit Scorpicores.',
      cost: { gold: 4000, sulfur: 5, mercury: 3 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Dragon Cave', desc: 'Recruit Red Dragons.',
      cost: { gold: 15000, ore: 10, sulfur: 20 }, requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Dragon Cave', desc: 'Recruit Black Dragons.',
      cost: { gold: 20000, ore: 10, sulfur: 20, mercury: 5 }, requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
  },

  stronghold: {
    dwelling1: {
      name: 'Goblin Barracks', desc: 'Recruit Goblins.',
      cost: { gold: 300, wood: 5 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Goblin Barracks', desc: 'Recruit Hobgoblins.',
      cost: { gold: 1000, wood: 5 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Wolf Pen', desc: 'Recruit Wolf Riders.',
      cost: { gold: 1000, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Wolf Pen', desc: 'Recruit Wolf Raiders.',
      cost: { gold: 1500, ore: 5, wood: 5 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Orc Tower', desc: 'Recruit Orcs.',
      cost: { gold: 1500, wood: 10 }, requires: ['dwelling2'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Orc Tower', desc: 'Recruit Orc Chieftains.',
      cost: { gold: 2000, wood: 5, ore: 5 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Ogre Fort', desc: 'Recruit Ogres.',
      cost: { gold: 2000, ore: 10 }, requires: ['dwelling3'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Ogre Fort', desc: 'Recruit Ogre Magi.',
      cost: { gold: 3000, ore: 5, crystal: 2 }, requires: ['dwelling4', 'mageGuild1'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Cliff Nest', desc: 'Recruit Rocs.',
      cost: { gold: 3000, ore: 10, wood: 10 }, requires: ['dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Cliff Nest', desc: 'Recruit Thunderbirds.',
      cost: { gold: 3000, mercury: 3 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Cyclops Cave', desc: 'Recruit Cyclopes.',
      cost: { gold: 4000, ore: 15, crystal: 5 }, requires: ['dwelling5'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Cyclops Cave', desc: 'Recruit Cyclops Kings.',
      cost: { gold: 4000, crystal: 5 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Behemoth Crag', desc: 'Recruit Behemoths.',
      cost: { gold: 10000, ore: 20, crystal: 10 }, requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Behemoth Crag', desc: 'Recruit Ancient Behemoths.',
      cost: { gold: 15000, ore: 20, crystal: 20 }, requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
  },

  fortress: {
    dwelling1: {
      name: 'Gnoll Hut', desc: 'Recruit Gnolls.',
      cost: { gold: 300, wood: 5 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Gnoll Hut', desc: 'Recruit Gnoll Marauders.',
      cost: { gold: 1000, wood: 5 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Lizard Den', desc: 'Recruit Lizardmen.',
      cost: { gold: 1000, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Lizard Den', desc: 'Recruit Lizard Warriors.',
      cost: { gold: 1500, ore: 5, wood: 5 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Serpent Fly Hive', desc: 'Recruit Serpent Flies.',
      cost: { gold: 1500, wood: 10 }, requires: ['dwelling2'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Serpent Fly Hive', desc: 'Recruit Dragon Flies.',
      cost: { gold: 2000, wood: 5, mercury: 2 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Basilisk Pit', desc: 'Recruit Basilisks.',
      cost: { gold: 2000, ore: 10 }, requires: ['dwelling3'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Basilisk Pit', desc: 'Recruit Greater Basilisks.',
      cost: { gold: 3000, ore: 5, sulfur: 2 }, requires: ['dwelling4'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Gorgon Lair', desc: 'Recruit Gorgons.',
      cost: { gold: 3000, ore: 10, wood: 10 }, requires: ['dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Gorgon Lair', desc: 'Recruit Mighty Gorgons.',
      cost: { gold: 3000, ore: 10, crystal: 2 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Wyvern Nest', desc: 'Recruit Wyverns.',
      cost: { gold: 4000, ore: 15, sulfur: 5 }, requires: ['mageGuild1', 'dwelling5'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Wyvern Nest', desc: 'Recruit Wyvern Monarchs.',
      cost: { gold: 4000, sulfur: 5, mercury: 3 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Hydra Pond', desc: 'Recruit Hydras.',
      cost: { gold: 10000, ore: 20, sulfur: 10 }, requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Hydra Pond', desc: 'Recruit Chaos Hydras.',
      cost: { gold: 15000, ore: 20, sulfur: 20 }, requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
  },

  conflux: {
    dwelling1: {
      name: 'Magic Lantern', desc: 'Recruit Pixies.',
      cost: { gold: 300, mercury: 1 }, requires: ['fort'], dwellingTier: 1,
    },
    dwelling1u: {
      name: 'Upg. Magic Lantern', desc: 'Recruit Sprites.',
      cost: { gold: 1000, mercury: 1 }, requires: ['dwelling1'], upgradeOf: 'dwelling1',
      dwellingTier: 1, dwellingUpgrade: true,
    },
    dwelling2: {
      name: 'Altar of Air', desc: 'Recruit Air Elementals.',
      cost: { gold: 1000, ore: 5 }, requires: ['dwelling1'], dwellingTier: 2,
    },
    dwelling2u: {
      name: 'Upg. Altar of Air', desc: 'Recruit Storm Elementals.',
      cost: { gold: 1500, ore: 5, mercury: 2 }, requires: ['dwelling2'], upgradeOf: 'dwelling2',
      dwellingTier: 2, dwellingUpgrade: true,
    },
    dwelling3: {
      name: 'Altar of Water', desc: 'Recruit Water Elementals.',
      cost: { gold: 1500, wood: 10 }, requires: ['dwelling2'], dwellingTier: 3,
    },
    dwelling3u: {
      name: 'Upg. Altar of Water', desc: 'Recruit Ice Elementals.',
      cost: { gold: 2000, wood: 5, crystal: 2 }, requires: ['dwelling3'], upgradeOf: 'dwelling3',
      dwellingTier: 3, dwellingUpgrade: true,
    },
    dwelling4: {
      name: 'Altar of Fire', desc: 'Recruit Fire Elementals.',
      cost: { gold: 2000, ore: 10 }, requires: ['dwelling3'], dwellingTier: 4,
    },
    dwelling4u: {
      name: 'Upg. Altar of Fire', desc: 'Recruit Energy Elementals.',
      cost: { gold: 3000, ore: 5, sulfur: 2 }, requires: ['dwelling4'], upgradeOf: 'dwelling4',
      dwellingTier: 4, dwellingUpgrade: true,
    },
    dwelling5: {
      name: 'Altar of Earth', desc: 'Recruit Earth Elementals.',
      cost: { gold: 3000, ore: 15 }, requires: ['dwelling4'], dwellingTier: 5,
    },
    dwelling5u: {
      name: 'Upg. Altar of Earth', desc: 'Recruit Magma Elementals.',
      cost: { gold: 3000, ore: 10, sulfur: 3 }, requires: ['dwelling5'], upgradeOf: 'dwelling5',
      dwellingTier: 5, dwellingUpgrade: true,
    },
    dwelling6: {
      name: 'Altar of Thought', desc: 'Recruit Psychic Elementals.',
      cost: { gold: 4000, mercury: 5 }, requires: ['mageGuild1', 'dwelling5'], dwellingTier: 6,
    },
    dwelling6u: {
      name: 'Upg. Altar of Thought', desc: 'Recruit Magic Elementals.',
      cost: { gold: 4000, mercury: 5, crystal: 3 }, requires: ['dwelling6'], upgradeOf: 'dwelling6',
      dwellingTier: 6, dwellingUpgrade: true,
    },
    dwelling7: {
      name: 'Pyre', desc: 'Recruit Firebirds.',
      cost: { gold: 10000, mercury: 10, sulfur: 10 }, requires: ['dwelling5', 'dwelling6'], dwellingTier: 7,
    },
    dwelling7u: {
      name: 'Upg. Pyre', desc: 'Recruit Phoenixes.',
      cost: { gold: 15000, mercury: 15, sulfur: 15 }, requires: ['dwelling7'], upgradeOf: 'dwelling7',
      dwellingTier: 7, dwellingUpgrade: true,
    },
  },
};

/** Full building catalog available to a faction's town. */
export function buildingCatalog(factionId) {
  return { ...COMMON_BUILDINGS, ...(DWELLINGS[factionId] || {}) };
}

/**
 * Which town-screen action clicking an ALREADY-BUILT building triggers, so the
 * building grid is the primary interaction (not just an info popup): a dwelling
 * opens its own recruit modal ('recruit'), the Fort/Citadel/Castle line opens a
 * recruit overview of every available tier ('recruitAll'), Tavern/Marketplace/
 * Shipyard/Mage Guild/Blacksmith open their function, and every passive building
 * (hall line, silo, stables) shows its info ('info'). Pure — takes the
 * building id + its catalog def; unit-tested so the routing can't silently drift
 * from the TownScene switch that consumes it.
 */
export function buildingAction(id, b) {
  if (id === 'marketplace') return 'market';
  if (id === 'tavern') return 'tavern';
  if (id === 'shipyard') return 'shipyard';
  if (id === 'blacksmith') return 'blacksmith';
  if (b?.special === 'transmuter') return 'transmuter';
  if (b?.special === 'reflection') return 'reflection';
  if (b?.special === 'bank') return 'bank';
  if (b?.guildLevel || id.startsWith('mageGuild')) return 'guild';
  if (b?.dwellingTier) return 'recruit';
  if (id === 'fort' || id === 'citadel' || id === 'castle') return 'recruitAll';
  return 'info';
}

/**
 * The VISUAL category of a building — which procedural glyph (and, later, which
 * generated sprite silhouette) it draws as on the town screen. A sibling of
 * buildingAction (that routes clicks; this picks art). Pure; unit-tested so the
 * glyph set can't drift as buildings/factions grow. Every building resolves to
 * exactly one of: dwelling · fort · hall · tavern · market · blacksmith ·
 * shipyard · guild · silo · special.
 */
export function buildingCategory(id, b) {
  if (b?.dwellingTier) return 'dwelling';
  if (id === 'fort' || id === 'citadel' || id === 'castle') return 'fort';
  if (id === 'villageHall' || id === 'townHall' || id === 'cityHall' || id === 'capitol') return 'hall';
  if (id === 'tavern') return 'tavern';
  if (id === 'marketplace') return 'market';
  if (id === 'blacksmith') return 'blacksmith';
  if (id === 'shipyard') return 'shipyard';
  if (b?.guildLevel || id.startsWith('mageGuild')) return 'guild';
  if (id === 'resourceSilo') return 'silo';
  return 'special'; // stables + any future one-off (grail, …)
}

/**
 * The list of buildings a town screen should offer, ONE SLOT PER UPGRADE CHAIN.
 *
 * Buildings linked by `upgradeOf` (villageHall→townHall→cityHall→capitol,
 * fort→citadel→castle, mageGuild1→…→5, every dwellingN→dwellingNu) collapse to
 * a single slot showing the *current step*: the next un-built upgrade of the
 * highest tier already built, or — once a chain is maxed — its top tier. This
 * keeps the grid small enough to hold every dwelling instead of drowning them
 * under a permanent box for each built tier. Standalone buildings (tavern,
 * marketplace, blacksmith, resource silo, faction specials) return themselves.
 * Auto-built roots (Village Hall) never appear as their own slot.
 *
 * Pure — takes the town's `buildings` list, returns building ids in catalog
 * order. The caller decides buildable/blocked/built styling per id.
 */
/**
 * The Mage Guild level a town could raise NEXT — the lowest guildLevel building
 * it does not have — or null when the guild is already at the top of its chain.
 *
 * Used by the guild overlay to offer the upgrade from inside the guild itself,
 * so a hero reading tier-1 spells can commission tier 2 on the spot instead of
 * being sent back out to hunt the right cell in the build grid.
 */
export function nextGuildLevel(town) {
  const catalog = buildingCatalog(town.faction);
  const levels = Object.entries(catalog)
    .filter(([, b]) => b.guildLevel)
    .sort((a, b) => a[1].guildLevel - b[1].guildLevel);
  for (const [id] of levels) if (!town.buildings.includes(id)) return id;
  return null;
}

/** The highest Mage Guild level this town has actually built (0 = none). */
export function guildLevelOf(town) {
  const catalog = buildingCatalog(town.faction);
  let hi = 0;
  for (const id of town.buildings) {
    const lvl = catalog[id]?.guildLevel;
    if (lvl && lvl > hi) hi = lvl;
  }
  return hi;
}

export function townBuildSlots(town, factionId) {
  const catalog = buildingCatalog(factionId);
  const built = new Set(town.buildings);
  for (const [id, b] of Object.entries(catalog)) if (b.autoBuilt) built.add(id);
  // predecessor id -> successor id, via upgradeOf
  const successor = {};
  for (const [id, b] of Object.entries(catalog)) if (b.upgradeOf) successor[b.upgradeOf] = id;

  const slots = [];
  for (const [id, b] of Object.entries(catalog)) {
    if (b.upgradeOf) continue; // walk each chain only from its root
    const chain = [id];
    let cur = id;
    while (successor[cur]) { cur = successor[cur]; chain.push(cur); }
    let hi = -1;
    for (let i = 0; i < chain.length; i++) if (built.has(chain[i])) hi = i;
    const rep = hi < chain.length - 1 ? chain[hi + 1] : chain[hi];
    if (catalog[rep].autoBuilt) continue; // a bare auto-built root has nothing to offer
    slots.push(rep);
  }
  return slots;
}
