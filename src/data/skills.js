/**
 * skills.js — Secondary skills.
 *
 * Each skill has 3 levels: 1 Basic, 2 Advanced, 3 Expert.
 * `levels` holds the magnitude at each level (index 0 = Basic).
 * The `apply` semantics for each skill id are implemented in
 * src/core/heroUtils.js and the combat engine — search for the skill id.
 *
 * HOW TO ADD A SKILL: add an entry, then honor its id where relevant.
 */

export const SKILLS = {
  logistics: {
    name: 'Logistics',
    levels: [0.1, 0.2, 0.3],
    fmt: (v) => `+${Math.round(v * 100)}% movement points`,
    desc: 'Increases the hero’s daily movement.',
  },
  pathfinding: {
    name: 'Pathfinding',
    levels: [0.25, 0.5, 0.75],
    fmt: (v) => `-${Math.round(v * 100)}% terrain penalties`,
    desc: 'Reduces movement penalties from rough terrain.',
  },
  scouting: {
    name: 'Scouting',
    levels: [1, 2, 3],
    fmt: (v) => `+${v} sight radius`,
    desc: 'The hero sees farther on the adventure map.',
  },
  archery: {
    name: 'Archery',
    levels: [0.1, 0.25, 0.5],
    fmt: (v) => `+${Math.round(v * 100)}% ranged damage`,
    desc: 'Increases damage of ranged attacks.',
  },
  offense: {
    name: 'Offense',
    levels: [0.1, 0.2, 0.3],
    fmt: (v) => `+${Math.round(v * 100)}% melee damage`,
    desc: 'Increases damage of melee attacks.',
  },
  armorer: {
    name: 'Armorer',
    levels: [0.05, 0.1, 0.15],
    fmt: (v) => `-${Math.round(v * 100)}% damage taken`,
    desc: 'Reduces all damage dealt to the hero’s troops.',
  },
  wisdom: {
    name: 'Wisdom',
    levels: [3, 4, 5],
    fmt: (v) => `learn spells up to tier ${v}`,
    desc: 'Allows learning higher-tier spells.',
  },
  mysticism: {
    name: 'Mysticism',
    levels: [2, 3, 4],
    fmt: (v) => `+${v} mana regenerated per day`,
    desc: 'Regenerate extra mana every day.',
  },
  intelligence: {
    name: 'Intelligence',
    levels: [0.25, 0.5, 1.0],
    fmt: (v) => `+${Math.round(v * 100)}% maximum mana`,
    desc: 'Increases the hero’s mana pool.',
  },
  sorcery: {
    name: 'Sorcery',
    levels: [0.05, 0.1, 0.15],
    fmt: (v) => `+${Math.round(v * 100)}% spell damage`,
    desc: 'Increases damage dealt by spells.',
  },
  leadership: {
    name: 'Leadership',
    levels: [1, 2, 3],
    fmt: (v) => `+${v} morale`,
    desc: 'Raises the morale of the hero’s troops.',
  },
  luck: {
    name: 'Luck',
    levels: [1, 2, 3],
    fmt: (v) => `+${v} luck`,
    desc: 'Raises the luck of the hero’s troops.',
  },
  tactics: {
    name: 'Tactics',
    // The reach (in battlefield columns) a hero may reposition its stacks before
    // the fight. HoMM3: Basic 3, Advanced 5, Expert 7. The effective range is the
    // difference between the two heroes' tactics (see CombatEngine.setupTactics).
    levels: [3, 5, 7],
    fmt: (v) => `reposition stacks up to ${v} columns pre-battle`,
    desc: 'Rearrange your army before the battle begins.',
  },
  necromancy: {
    name: 'Necromancy',
    // The fraction of a slain MORTAL army's life that rises as skeletons after a
    // victory (HoMM3: Basic 10% / Advanced 20% / Expert 30%). Resolved in
    // actions.raiseSkeletons; undead + war machines cannot be reanimated.
    levels: [0.1, 0.2, 0.3],
    fmt: (v) => `raise ${Math.round(v * 100)}% of the fallen as skeletons`,
    desc: 'After a victory, reanimate the enemy dead as skeletons.',
  },
  diplomacy: {
    name: 'Diplomacy',
    // How willing a neutral band is to deal with this hero, 0..1. It widens the
    // bargaining band, cuts the refusal chance, discounts the price, and lets kin
    // join for nothing; it also cuts what the hero's own surrender costs. See the
    // Diplomacy block in config.js for the four places it enters, and
    // core/diplomacy.js for the arithmetic.
    levels: [0.25, 0.5, 0.75],
    // What it literally does to the refusal roll — see parleyOffer. "+75% chance
    // to join" would be a nicer sentence and a false one: the skill cuts the
    // chance they turn you down, it does not add percentage points to a join.
    fmt: (v) => `${Math.round(v * 100)}% fewer refusals, better terms`,
    desc: 'Neutral stacks are likelier to join you, at a better price — and your own surrender costs less.',
  },
  estates: {
    name: 'Estates',
    // HoMM3 progression: Basic 125, Advanced 250, Expert 350. Expert was 500 —
    // an undocumented +43% that broke the curve and stacked unbounded per hero.
    levels: [125, 250, 350],
    fmt: (v) => `+${v} gold per day`,
    desc: 'The hero contributes gold to the treasury daily.',
  },

  // Magic schools — each boosts the effect of spells of its school (see
  // castSpell + spells.SCHOOL_SKILL): more damage/healing, and longer buffs.
  airMagic: {
    name: 'Air Magic',
    levels: [0.15, 0.25, 0.35],
    fmt: (v) => `+${Math.round(v * 100)}% Air spell effect`,
    desc: 'Strengthens Air spells (Haste, Lightning, Chain Lightning…).',
  },
  earthMagic: {
    name: 'Earth Magic',
    levels: [0.15, 0.25, 0.35],
    fmt: (v) => `+${Math.round(v * 100)}% Earth spell effect`,
    desc: 'Strengthens Earth spells (Stone Skin, Meteor Shower, Resurrection…).',
  },
  fireMagic: {
    name: 'Fire Magic',
    levels: [0.15, 0.25, 0.35],
    fmt: (v) => `+${Math.round(v * 100)}% Fire spell effect`,
    desc: 'Strengthens Fire spells (Fireball, Inferno, Armageddon…).',
  },
  waterMagic: {
    name: 'Water Magic',
    levels: [0.15, 0.25, 0.35],
    fmt: (v) => `+${Math.round(v * 100)}% Water spell effect`,
    desc: 'Strengthens Water spells (Bless, Cure, Prayer…).',
  },
};

export const SKILL_LEVEL_NAMES = ['', 'Basic', 'Advanced', 'Expert'];

/** Magnitude of a hero's skill, or 0/undefined-safe default. */
export function skillValue(hero, skillId) {
  const lvl = hero.skills?.[skillId] || 0;
  if (!lvl) return 0;
  return SKILLS[skillId].levels[lvl - 1];
}
