/**
 * heroes.js — Hero classes and the hero roster.
 *
 * CLASSES define starting primary stats and the probability that each stat
 * grows on level-up (weights, HoMM3-style: might classes favor Attack/Defense,
 * magic classes favor Power/Knowledge).
 *
 * ROSTER entries:
 *   name, faction, class
 *   skills   starting secondary skills { skillId: level }
 *   army     starting troops [ [creatureId, min, max], ... ] (rolled at hire)
 *   spells   starting spellbook (ids); heroes with any spell start with a spellbook
 *   specialty a permanent perk (see specialtyText / heroStat / combat / dailyIncome):
 *              { kind:'creature', creature } — that creature (and its upgrade) gains
 *                +1 attack/defense/speed in this hero's battles;
 *              { kind:'stat', stat }         — +1 to a primary stat, always on;
 *              { kind:'resource', resource, amount } — +amount of a resource each day.
 *   portrait glyph key for gfx/Portraits
 *   bio      flavor text
 *
 * HOW TO ADD A HERO: add a roster entry (and a class if it's a new archetype).
 */

import { FACTIONS } from './factions.js';

import { CREATURES } from './creatures.js';

export const HERO_CLASSES = {
  knight: {
    name: 'Knight',
    start: { attack: 2, defense: 2, power: 1, knowledge: 1 },
    growth: { attack: 35, defense: 35, power: 15, knowledge: 15 }, // weights %
  },
  cleric: {
    name: 'Cleric',
    start: { attack: 1, defense: 0, power: 2, knowledge: 2 },
    growth: { attack: 15, defense: 15, power: 35, knowledge: 35 },
  },
  demoniac: {
    name: 'Demoniac',
    start: { attack: 2, defense: 2, power: 1, knowledge: 1 },
    growth: { attack: 35, defense: 30, power: 20, knowledge: 15 },
  },
  heretic: {
    name: 'Heretic',
    start: { attack: 1, defense: 1, power: 2, knowledge: 1 },
    growth: { attack: 20, defense: 15, power: 35, knowledge: 30 },
  },
  wizard: {
    name: 'Wizard',
    start: { attack: 0, defense: 0, power: 2, knowledge: 3 },
    growth: { attack: 10, defense: 10, power: 35, knowledge: 45 },
  },
  ranger: {
    name: 'Ranger',
    start: { attack: 1, defense: 3, power: 1, knowledge: 1 },
    growth: { attack: 30, defense: 35, power: 15, knowledge: 20 },
  },
  druid: {
    name: 'Druid',
    start: { attack: 0, defense: 2, power: 1, knowledge: 2 },
    growth: { attack: 10, defense: 20, power: 30, knowledge: 40 },
  },
  deathKnight: {
    name: 'Death Knight',
    start: { attack: 1, defense: 2, power: 1, knowledge: 1 },
    growth: { attack: 30, defense: 30, power: 25, knowledge: 15 },
  },
  necromancer: {
    name: 'Necromancer',
    start: { attack: 1, defense: 0, power: 2, knowledge: 2 },
    growth: { attack: 15, defense: 20, power: 30, knowledge: 35 },
  },
  overlord: {
    name: 'Overlord',
    start: { attack: 2, defense: 2, power: 1, knowledge: 1 },
    growth: { attack: 35, defense: 30, power: 20, knowledge: 15 },
  },
  warlock: {
    name: 'Warlock',
    start: { attack: 0, defense: 0, power: 3, knowledge: 2 },
    growth: { attack: 10, defense: 10, power: 40, knowledge: 40 },
  },
  barbarian: {
    name: 'Barbarian',
    start: { attack: 2, defense: 1, power: 1, knowledge: 1 },
    growth: { attack: 45, defense: 25, power: 15, knowledge: 15 },
  },
  battleMage: {
    name: 'Battle Mage',
    start: { attack: 1, defense: 1, power: 2, knowledge: 1 },
    growth: { attack: 25, defense: 20, power: 35, knowledge: 20 },
  },
  beastmaster: {
    name: 'Beastmaster',
    start: { attack: 1, defense: 2, power: 1, knowledge: 1 },
    growth: { attack: 25, defense: 35, power: 20, knowledge: 20 },
  },
  witch: {
    name: 'Witch',
    start: { attack: 0, defense: 1, power: 2, knowledge: 2 },
    growth: { attack: 10, defense: 20, power: 35, knowledge: 35 },
  },
  planeswalker: {
    name: 'Planeswalker',
    start: { attack: 2, defense: 2, power: 1, knowledge: 1 },
    growth: { attack: 30, defense: 30, power: 25, knowledge: 15 },
  },
  elementalist: {
    name: 'Elementalist',
    start: { attack: 0, defense: 0, power: 3, knowledge: 2 },
    growth: { attack: 10, defense: 10, power: 40, knowledge: 40 },
  },
};

const ALL_HERO_ROSTER = {
  // ---- Castle ----
  orrin: {
    name: 'Orrin', faction: 'castle', class: 'knight', portrait: 'knight_m1',
    skills: { archery: 1, leadership: 1 },
    army: [['pikeman', 10, 20], ['archer', 4, 7]],
    spells: [],
    specialty: { kind: 'creature', creature: 'archer' },
    bio: 'A legendary archer knighted for valor on the field.',
  },
  valeska: {
    name: 'Valeska', faction: 'castle', class: 'knight', portrait: 'knight_f1',
    skills: { archery: 1, offense: 1 },
    army: [['pikeman', 8, 16], ['archer', 5, 9]],
    spells: [],
    specialty: { kind: 'creature', creature: 'archer' },
    bio: 'Captain of the border marches, beloved by her marksmen.',
  },
  sylvia: {
    name: 'Sylvia', faction: 'castle', class: 'knight', portrait: 'knight_f2',
    skills: { logistics: 1, armorer: 1 },
    army: [['pikeman', 12, 22], ['griffin', 2, 3]],
    spells: [],
    specialty: { kind: 'resource', resource: 'wood', amount: 2 },
    bio: 'A restless commander who drills her troops on the march.',
  },
  adela: {
    name: 'Adela', faction: 'castle', class: 'cleric', portrait: 'cleric_f1',
    skills: { wisdom: 1, mysticism: 1 },
    army: [['pikeman', 8, 14]],
    spells: ['bless'],
    specialty: { kind: 'stat', stat: 'knowledge' },
    bio: 'A devout cleric whose blessings turn the tide of battle.',
  },
  caitlin: {
    name: 'Caitlin', faction: 'castle', class: 'cleric', portrait: 'cleric_f2',
    skills: { wisdom: 1, intelligence: 1 },
    army: [['pikeman', 6, 12], ['archer', 3, 5]],
    spells: ['magicArrow'],
    specialty: { kind: 'resource', resource: 'gold', amount: 350 },
    bio: 'A scholar of the arcane serving the crown.',
  },

  // ---- Inferno ----
  fiona: {
    name: 'Fiona', faction: 'inferno', class: 'demoniac', portrait: 'demoniac_f1',
    skills: { scouting: 1, offense: 1 },
    army: [['imp', 15, 25], ['gog', 4, 7]],
    spells: [],
    specialty: { kind: 'creature', creature: 'imp' },
    bio: 'Raised among hellhounds; strikes fast and vanishes.',
  },
  marius: {
    name: 'Marius', faction: 'inferno', class: 'demoniac', portrait: 'demoniac_m1',
    skills: { armorer: 1, offense: 1 },
    army: [['imp', 12, 20], ['hellHound', 2, 4]],
    spells: [],
    specialty: { kind: 'creature', creature: 'demon' },
    bio: 'A grim legion-master of the burning wastes.',
  },
  ignatius: {
    name: 'Ignatius', faction: 'inferno', class: 'demoniac', portrait: 'demoniac_m2',
    skills: { logistics: 1, luck: 1 },
    army: [['imp', 15, 25], ['gog', 3, 5]],
    spells: [],
    specialty: { kind: 'stat', stat: 'power' },
    bio: 'Fortune favors the wicked, he says. So far it has.',
  },
  xyron: {
    name: 'Xyron', faction: 'inferno', class: 'heretic', portrait: 'heretic_m1',
    skills: { wisdom: 1, sorcery: 1 },
    army: [['imp', 10, 16]],
    spells: ['magicArrow'],
    specialty: { kind: 'creature', creature: 'gog' },
    bio: 'A pyromancer expelled from every academy of magic.',
  },
  axsis: {
    name: 'Axsis', faction: 'inferno', class: 'heretic', portrait: 'heretic_m2',
    skills: { wisdom: 1, mysticism: 1 },
    army: [['imp', 10, 18], ['gog', 2, 4]],
    spells: ['slow'],
    specialty: { kind: 'creature', creature: 'efreeti' },
    bio: 'Meditates on entropy and the heat-death of empires.',
  },

  // ---- Tower ----
  solmyr: {
    name: 'Solmyr', faction: 'tower', class: 'wizard', portrait: 'wizard_m1',
    skills: { wisdom: 1, sorcery: 1 },
    army: [['servitor', 14, 22], ['stoneGargoyle', 3, 5]],
    spells: ['iceBolt'],
    specialty: { kind: 'stat', stat: 'power' },
    bio: 'A genie-blooded archmage who bottles the winter wind.',
  },
  aine: {
    name: 'Aine', faction: 'tower', class: 'wizard', portrait: 'wizard_f1',
    skills: { wisdom: 1, mysticism: 1 },
    army: [['servitor', 12, 20]],
    spells: ['stoneSkin'],
    specialty: { kind: 'resource', resource: 'gold', amount: 350 },
    bio: 'Warden of the golem foundries beneath the ice.',
  },
  theodorus: {
    name: 'Theodorus', faction: 'tower', class: 'wizard', portrait: 'wizard_m2',
    skills: { intelligence: 1, wisdom: 1 },
    army: [['servitor', 15, 25], ['stoneGolem', 1, 2]],
    spells: ['magicArrow'],
    specialty: { kind: 'creature', creature: 'mage' },
    bio: 'A tireless scholar cataloguing every spell ever cast.',
  },
  serena: {
    name: 'Serena', faction: 'tower', class: 'wizard', portrait: 'wizard_f2',
    skills: { wisdom: 1, luck: 1 },
    army: [['servitor', 12, 18], ['stoneGargoyle', 2, 4]],
    spells: ['bless'],
    specialty: { kind: 'stat', stat: 'knowledge' },
    bio: 'A stargazer who reads fortune in the auroras.',
  },

  // ---- Rampart ----
  ivor: {
    name: 'Ivor', faction: 'rampart', class: 'ranger', portrait: 'ranger_m1',
    skills: { archery: 1, offense: 1 },
    army: [['centaur', 10, 20], ['woodElf', 4, 7]],
    spells: [],
    specialty: { kind: 'creature', creature: 'woodElf' },
    bio: 'An elf blooded in the border wars; his archers loose as one.',
  },
  mephala: {
    name: 'Mephala', faction: 'rampart', class: 'ranger', portrait: 'ranger_f1',
    skills: { armorer: 1, pathfinding: 1 },
    army: [['centaur', 8, 16], ['dwarf', 3, 6]],
    spells: [],
    specialty: { kind: 'stat', stat: 'defense' },
    bio: 'Warden of the dwarven vales; her shield-wall does not break.',
  },
  coronius: {
    name: 'Coronius', faction: 'rampart', class: 'druid', portrait: 'druid_m1',
    skills: { wisdom: 1, mysticism: 1 },
    army: [['centaur', 8, 14], ['woodElf', 2, 4]],
    spells: ['bless'],
    specialty: { kind: 'resource', resource: 'crystal', amount: 1 },
    bio: 'A grove-keeper who reads the forest’s will in falling leaves.',
  },

  // ---- Necropolis ----
  galthran: {
    name: 'Galthran', faction: 'necropolis', class: 'deathKnight', portrait: 'deathKnight_m1',
    skills: { necromancy: 1, offense: 1 },
    army: [['skeleton', 12, 22], ['walkingDead', 3, 5]],
    spells: [],
    specialty: { kind: 'creature', creature: 'skeleton' },
    bio: 'A crypt-lord whose skeleton legions march as one cold tide.',
  },
  vokial: {
    name: 'Vokial', faction: 'necropolis', class: 'deathKnight', portrait: 'deathKnight_m2',
    skills: { necromancy: 1, armorer: 1 },
    army: [['skeleton', 10, 16], ['vampire', 1, 2]],
    spells: [],
    specialty: { kind: 'creature', creature: 'vampire' },
    bio: 'A blood-lord who leads his vampires from the front, night after night.',
  },
  isra: {
    name: 'Isra', faction: 'necropolis', class: 'necromancer', portrait: 'necromancer_f1',
    skills: { necromancy: 2, wisdom: 1 },
    army: [['skeleton', 10, 18], ['wight', 2, 3]],
    spells: ['magicArrow'],
    specialty: { kind: 'stat', stat: 'knowledge' },
    bio: 'An adept of the dark art who raises the fallen faster than any rival.',
  },

  // ---- Dungeon ----
  shakti: {
    name: 'Shakti', faction: 'dungeon', class: 'overlord', portrait: 'overlord_m1',
    skills: { offense: 1, scouting: 1 },
    army: [['troglodyte', 15, 25], ['harpy', 3, 5]],
    spells: [],
    specialty: { kind: 'creature', creature: 'troglodyte' },
    bio: 'A cave-lord who drives his troglodyte hordes up from the deeps.',
  },
  mutare: {
    name: 'Mutare', faction: 'dungeon', class: 'overlord', portrait: 'overlord_f1',
    skills: { offense: 1, armorer: 1 },
    army: [['troglodyte', 12, 20], ['minotaur', 1, 2]],
    spells: [],
    specialty: { kind: 'creature', creature: 'redDragon' },
    bio: 'A dragon-blooded overlord who rides the wyrms of the abyss to war.',
  },
  alamar: {
    name: 'Alamar', faction: 'dungeon', class: 'warlock', portrait: 'warlock_m1',
    skills: { wisdom: 1, sorcery: 1 },
    army: [['troglodyte', 10, 16], ['beholder', 2, 4]],
    spells: ['iceBolt'],
    specialty: { kind: 'stat', stat: 'power' },
    bio: 'A warlock who bargained with things in the dark for his sorcery.',
  },

  // ---- Stronghold ----
  cragHack: {
    name: 'Crag Hack', faction: 'stronghold', class: 'barbarian', portrait: 'barbarian_m1',
    skills: { offense: 1, tactics: 1 },
    army: [['goblin', 15, 25], ['wolfRider', 4, 7]],
    spells: [],
    specialty: { kind: 'stat', stat: 'attack' },
    bio: 'The wastes’ most feared raider; his charge breaks any line.',
  },
  gundula: {
    name: 'Gundula', faction: 'stronghold', class: 'barbarian', portrait: 'barbarian_f1',
    skills: { offense: 1, armorer: 1 },
    army: [['goblin', 12, 20], ['orc', 3, 5]],
    spells: [],
    specialty: { kind: 'creature', creature: 'ogre' },
    bio: 'A war-mother whose ogres never break and never tire.',
  },
  yog: {
    name: 'Yog', faction: 'stronghold', class: 'battleMage', portrait: 'battleMage_m1',
    skills: { wisdom: 1, offense: 1 },
    army: [['goblin', 10, 18], ['roc', 1, 2]],
    spells: ['magicArrow'],
    specialty: { kind: 'creature', creature: 'behemoth' },
    bio: 'A shaman-warrior who leads the great behemoths to war.',
  },

  // ---- Fortress ----
  tazar: {
    name: 'Tazar', faction: 'fortress', class: 'beastmaster', portrait: 'beastmaster_m1',
    skills: { armorer: 1, offense: 1 },
    army: [['gnoll', 15, 25], ['lizardman', 3, 5]],
    spells: [],
    specialty: { kind: 'stat', stat: 'defense' },
    bio: 'A mire-lord whose shield-wall of beasts has never been broken.',
  },
  wystan: {
    name: 'Wystan', faction: 'fortress', class: 'beastmaster', portrait: 'beastmaster_m2',
    skills: { offense: 1, armorer: 1 },
    army: [['gnoll', 12, 20], ['basilisk', 1, 2]],
    spells: [],
    specialty: { kind: 'creature', creature: 'wyvern' },
    bio: 'A swamp-warden who rides the great wyverns of the fen.',
  },
  andra: {
    name: 'Andra', faction: 'fortress', class: 'witch', portrait: 'witch_f1',
    skills: { wisdom: 1, sorcery: 1 },
    army: [['gnoll', 10, 18], ['serpentFly', 2, 4]],
    spells: ['magicArrow'],
    specialty: { kind: 'stat', stat: 'knowledge' },
    bio: 'A bog-witch who whispers to the things that slither in the reeds.',
  },

  // ---- Conflux ----
  erdamon: {
    name: 'Erdamon', faction: 'conflux', class: 'planeswalker', portrait: 'planeswalker_m1',
    skills: { armorer: 1, offense: 1 },
    army: [['pixie', 15, 25], ['airElemental', 2, 4]],
    spells: [],
    specialty: { kind: 'creature', creature: 'earthElemental' },
    bio: 'A planeswalker whose earth elementals stand like the mountains themselves.',
  },
  fiur: {
    name: 'Fiur', faction: 'conflux', class: 'planeswalker', portrait: 'planeswalker_m2',
    skills: { offense: 1, tactics: 1 },
    army: [['pixie', 12, 20], ['fireElemental', 2, 3]],
    spells: [],
    specialty: { kind: 'creature', creature: 'fireElemental' },
    bio: 'A planeswalker who walks unburned amid his own living flame.',
  },
  luna: {
    name: 'Luna', faction: 'conflux', class: 'elementalist', portrait: 'elementalist_f1',
    skills: { wisdom: 1, sorcery: 1 },
    army: [['pixie', 10, 18], ['stormElemental', 2, 4]],
    spells: ['magicArrow'],
    specialty: { kind: 'stat', stat: 'power' },
    bio: 'An elementalist who calls the lightning down from a clear sky.',
  },
};

// CLONE: only the PLAYABLE factions' heroes are exported — the same rule the
// upgrade trees follow (data/upgradeNodes.js).
//
// The roster literal above is upstream's, all nine factions, so restoring a
// faction to data/factions.js restores its heroes with no edit here. But a hero
// whose faction is not in the registry can never be hired (taverns draw from
// heroesOfFaction of a town's faction, and only playable factions have towns) and
// is a dangling reference that tests/data-integrity.test.js flags.
export const HERO_ROSTER = Object.fromEntries(
  Object.entries(ALL_HERO_ROSTER).filter(([, h]) => h.faction in FACTIONS),
);


export function heroesOfFaction(factionId) {
  return Object.keys(HERO_ROSTER).filter((id) => HERO_ROSTER[id].faction === factionId);
}

/** A short "Name — effect" description of a hero specialty for the UI. */
export function specialtyText(spec) {
  if (!spec) return null;
  if (spec.kind === 'creature') {
    const c = CREATURES[spec.creature];
    return { name: c ? c.name : spec.creature, effect: '+1 attack, defense & speed in your battles' };
  }
  if (spec.kind === 'stat') {
    const S = { attack: 'Attack', defense: 'Defense', power: 'Power', knowledge: 'Knowledge' };
    return { name: S[spec.stat] || spec.stat, effect: `+1 ${S[spec.stat] || spec.stat}` };
  }
  if (spec.kind === 'resource') {
    const R = spec.resource[0].toUpperCase() + spec.resource.slice(1);
    return { name: R, effect: `+${spec.amount} ${spec.resource} per day` };
  }
  return { name: 'Specialty', effect: '' };
}
