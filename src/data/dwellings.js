/**
 * dwellings.js — External creature dwellings (HoMM3 parity): a recruitment site
 * out on the adventure map, apart from any town. Each dwelling produces ONE
 * creature that accrues weekly (like a town's dwelling); a visiting hero flags
 * it and may recruit the accumulated stock straight into its army, paying the
 * creature's normal cost. Pure data — the object on the map carries its
 * `dwellingType`, its running `available` stock, and its `owner` flag, so it
 * round-trips saves with no migration (see actions.recruitFromDwelling).
 *
 * The roster is a spread of tier 1–4 creatures (apex tiers stay a town/boss-lair
 * privilege), each with a themed name.
 */
export const DWELLINGS = {
  goblinBarracks: { name: 'Goblin Barracks', creature: 'goblin' },
  centaurStables: { name: 'Centaur Stables', creature: 'centaur' },
  wolfDen: { name: 'Wolf Den', creature: 'wolfRider' },
  harpyLoft: { name: 'Harpy Loft', creature: 'harpy' },
  dwarfCottage: { name: 'Dwarf Cottage', creature: 'dwarf' },
  gargoyleCliff: { name: 'Gargoyle Cliff', creature: 'stoneGargoyle' },
  impForge: { name: 'Imp Forge', creature: 'gog' },
  houndKennel: { name: 'Hound Kennel', creature: 'hellHound' },
  griffinTower: { name: 'Griffin Tower', creature: 'griffin' },
  elvenHomestead: { name: 'Elven Homestead', creature: 'woodElf' },
  orcTower: { name: 'Orc Tower', creature: 'orc' },
  pegasusVale: { name: 'Pegasus Vale', creature: 'pegasus' },
  swordsmenHall: { name: 'Hall of Swordsmen', creature: 'swordsman' },
};

/** Dwelling ids (the generator's dwelling pass picks from these). */
export const DWELLING_TYPES = Object.keys(DWELLINGS);

/** Definition for a dwelling object's dwellingType, or null. */
export function dwellingDef(type) {
  return DWELLINGS[type] || null;
}
