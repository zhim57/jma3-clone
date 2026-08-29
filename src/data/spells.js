/**
 * spells.js — Spell catalog (tiers 1..5).
 *
 * Spell schema:
 *   name, tier, manaCost, desc
 *   kind:  'damage'  — needs target enemy stack; dmg = base + power * perPower
 *          'buff'    — needs target friendly stack; applies `effects` for `duration` rounds
 *          'debuff'  — needs target enemy stack; same but hostile
 *          'heal'    — heal/resurrect target friendly stack: hp = base + power * perPower
 *   area:  0 = single stack, 1 = target hex + adjacent hexes (friend & foe alike)
 *   hitsAll: true — hits every stack on the battlefield (Armageddon)
 *   chain: n — jumps to n additional nearest targets at half damage each hop
 *   effects: stat deltas applied to the stack while active, e.g. { speed: +3 },
 *            plus flags { blessed: 1 } (max damage), { cursed: 1 } (min damage),
 *            { blinded: 1 } (cannot act; broken by damage)
 *   duration: base rounds a buff/debuff lasts at NO school mastery; Power adds
 *             min(3, floor(Power/3)) more at cast time (bounded — see
 *             CONFIG.SPELL_DURATION_POWER_*)
 *   durationByLevel: the full base duration at each level of this spell's own
 *             school — [none, Basic, Advanced, Expert] — replacing the flat
 *             "+1 round per level" that used to apply to every spell alike.
 *             Index 0 MUST equal `duration`, so an unskilled hero is unaffected.
 *             The SHAPE is the design: a lockout (Blind, Frenzy) barely grows
 *             with mastery, a cheap single-stat buff grows fastest, and the
 *             initiative spells keep the old +1-per-level. Resolved by
 *             magic.spellDuration; a spell with no table keeps the old rule.
 *   byLevel: per-stat magnitude ladder indexed by the caster's level in this
 *            spell's OWN school — [none, Basic, Advanced, Expert]. Index 0 MUST
 *            equal the same stat in `effects`, so a hero with no school skill is
 *            unaffected; and index 1 equals index 0 because HoMM3 treats casting
 *            without the skill as the Basic effect. `effects` remains the level-0
 *            truth and the fallback for every stat with no ladder. Resolved by
 *            magic.spellEffects at cast time and STORED on the stack, so an
 *            effect keeps the magnitude it was cast with.
 *   mass: true — an EXPERT of this spell's own school casts it on EVERY stack of
 *            the relevant side at once (friendly for buff/heal, enemy for
 *            debuff) for the single-target price. This is the flag, not a rule
 *            inferred from `kind`: Blind, Frenzy and Resurrection are meant to
 *            stay single-target however skilled the caster (as in HoMM3), and a
 *            rule would sweep them in. See src/core/magic.js.
 *
 * Learning: heroes learn spells at a town Mage Guild. Tier 3/4/5 spells
 * require Basic/Advanced/Expert Wisdom. Damage is boosted by Sorcery.
 *
 * HOW TO ADD A SPELL: add an entry; if it needs a brand-new mechanic, extend
 * `applySpell` in src/core/combat/CombatEngine.js (one switch statement).
 */

export const SPELLS = {
  // ---------------- Tier 1 ----------------
  magicArrow: {
    name: 'Magic Arrow', tier: 1, manaCost: 5, kind: 'damage',
    base: 10, perPower: 10,
    desc: 'A bolt of raw magic. Damage: 10 + 10/power.',
  },
  haste: {
    name: 'Haste', tier: 1, manaCost: 6, kind: 'buff', mass: true,
    effects: { speed: 3 }, duration: 3,
    durationByLevel: [3, 4, 5, 6],
    byLevel: { speed: [3, 3, 5, 5] },
    desc: 'Target friendly stack gains +3 speed.',
  },
  slow: {
    name: 'Slow', tier: 1, manaCost: 6, kind: 'debuff', mass: true,
    effects: { speed: -3 }, duration: 3,
    durationByLevel: [3, 4, 5, 6],
    byLevel: { speed: [-3, -3, -5, -5] },
    desc: 'Target enemy stack suffers -3 speed (minimum 1).',
  },
  bless: {
    name: 'Bless', tier: 1, manaCost: 5, kind: 'buff', mass: true,
    effects: { blessed: 1 }, duration: 3,
    durationByLevel: [3, 4, 5, 6],
    desc: 'Target friendly stack always deals maximum damage.',
  },
  curse: {
    name: 'Curse', tier: 1, manaCost: 6, kind: 'debuff', mass: true,
    effects: { cursed: 1 }, duration: 3,
    durationByLevel: [3, 4, 5, 6],
    desc: 'Target enemy stack always deals minimum damage.',
  },
  shield: {
    name: 'Shield', tier: 1, manaCost: 5, kind: 'buff', mass: true,
    effects: { defense: 3 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { defense: [3, 3, 6, 6] },
    desc: 'Target friendly stack gains +3 defense.',
  },
  bloodlust: {
    name: 'Bloodlust', tier: 1, manaCost: 5, kind: 'buff', mass: true,
    effects: { attack: 3 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { attack: [3, 3, 6, 6] },
    desc: 'Target friendly stack gains +3 attack.',
  },
  weakness: {
    name: 'Weakness', tier: 1, manaCost: 6, kind: 'debuff', mass: true,
    effects: { attack: -3 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { attack: [-3, -3, -6, -6] },
    desc: 'Target enemy stack suffers -3 attack (minimum 0).',
  },

  // ---------------- Tier 2 ----------------
  lightningBolt: {
    name: 'Lightning Bolt', tier: 2, manaCost: 10, kind: 'damage',
    base: 10, perPower: 25,
    desc: 'A searing bolt. Damage: 10 + 25/power.',
  },
  iceBolt: {
    name: 'Ice Bolt', tier: 2, manaCost: 8, kind: 'damage',
    base: 10, perPower: 20,
    desc: 'A shard of ice. Damage: 10 + 20/power.',
  },
  cure: {
    name: 'Cure', tier: 2, manaCost: 6, kind: 'heal', mass: true,
    base: 10, perPower: 5, cleanse: true,
    desc: 'Heals 10 + 5/power HP and removes hostile effects. Cannot revive the dead.',
  },
  blind: {
    name: 'Blind', tier: 2, manaCost: 10, kind: 'debuff',
    effects: { blinded: 1 }, duration: 3,
    durationByLevel: [3, 3, 4, 4],
    desc: 'Target enemy stack cannot act. Broken when damaged.',
  },
  stoneSkin: {
    name: 'Stone Skin', tier: 2, manaCost: 6, kind: 'buff', mass: true,
    effects: { defense: 4 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { defense: [4, 4, 6, 6] },
    desc: 'Target friendly stack gains +4 defense.',
  },
  disruptingRay: {
    name: 'Disrupting Ray', tier: 2, manaCost: 8, kind: 'debuff', mass: true,
    effects: { defense: -3 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { defense: [-3, -3, -4, -5] },
    desc: 'Target enemy stack suffers -3 defense.',
  },

  // ---------------- Tier 3 ----------------
  fireball: {
    name: 'Fireball', tier: 3, manaCost: 15, kind: 'damage',
    base: 15, perPower: 10, area: 1,
    desc: 'Explodes over the target and all adjacent stacks. Damage: 15 + 10/power.',
  },
  mirth: {
    name: 'Mirth', tier: 3, manaCost: 12, kind: 'buff', mass: true,
    effects: { morale: 2 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { morale: [2, 2, 3, 3] },
    desc: 'Target friendly stack gains +2 morale.',
  },
  misfortune: {
    name: 'Misfortune', tier: 3, manaCost: 12, kind: 'debuff', mass: true,
    effects: { luck: -2 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { luck: [-2, -2, -3, -3] },
    desc: 'Target enemy stack suffers -2 luck.',
  },
  meteorShower: {
    name: 'Meteor Shower', tier: 3, manaCost: 16, kind: 'damage',
    base: 15, perPower: 12, area: 1,
    desc: 'Rock rains over the target and adjacent stacks. Damage: 15 + 12/power.',
  },
  fortune: {
    name: 'Fortune', tier: 3, manaCost: 12, kind: 'buff', mass: true,
    effects: { luck: 2 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { luck: [2, 2, 3, 3] },
    desc: 'Target friendly stack gains +2 luck.',
  },

  // ---------------- Tier 4 ----------------
  chainLightning: {
    name: 'Chain Lightning', tier: 4, manaCost: 24, kind: 'damage',
    base: 25, perPower: 40, chain: 3,
    desc: 'Strikes the target, then leaps to 3 nearest stacks at half damage each leap. May hit friends!',
  },
  prayer: {
    name: 'Prayer', tier: 4, manaCost: 16, kind: 'buff', mass: true,
    effects: { attack: 4, defense: 4, speed: 4 }, duration: 3,
    durationByLevel: [3, 4, 4, 5],
    // Deliberately NO magnitude ladder. A +6/+6/+6 one was added with the rest of
    // §2b and measured as the single reason Water outran every other school —
    // +4 on three stats is already two schools' best mass buffs in one cast, and
    // it is also what HoMM3's Expert Prayer gives. See docs/MAGIC_SCHOOLS.md §7.
    desc: 'Target friendly stack gains +4 attack, defense and speed.',
  },
  resurrection: {
    name: 'Resurrection', tier: 4, manaCost: 20, kind: 'heal',
    base: 40, perPower: 50, revives: true,
    desc: 'Restores 40 + 50/power HP, reviving slain creatures in the stack.',
  },
  inferno: {
    name: 'Inferno', tier: 4, manaCost: 22, kind: 'damage',
    base: 20, perPower: 30, area: 1,
    desc: 'Engulfs the target and adjacent stacks in flame. Damage: 20 + 30/power.',
  },
  sorrow: {
    name: 'Sorrow', tier: 4, manaCost: 16, kind: 'debuff', mass: true,
    effects: { morale: -2 }, duration: 3,
    durationByLevel: [3, 4, 6, 8],
    byLevel: { morale: [-2, -2, -3, -3] },
    desc: 'Target enemy stack suffers -2 morale.',
  },

  // ---------------- Tier 5 ----------------
  implosion: {
    name: 'Implosion', tier: 5, manaCost: 30, kind: 'damage',
    base: 100, perPower: 75,
    desc: 'Crushes a single stack. Damage: 100 + 75/power.',
  },
  armageddon: {
    name: 'Armageddon', tier: 5, manaCost: 24, kind: 'damage',
    base: 30, perPower: 50, hitsAll: true,
    desc: 'Fire rains on EVERY stack on the battlefield — including your own.',
  },
  titanBolt: {
    name: 'Titan’s Bolt', tier: 5, manaCost: 30, kind: 'damage',
    base: 80, perPower: 60,
    desc: 'A colossal thunderbolt smites a single stack. Damage: 80 + 60/power.',
  },
  frenzy: {
    name: 'Frenzy', tier: 5, manaCost: 26, kind: 'buff',
    effects: { attack: 8 }, duration: 3,
    durationByLevel: [3, 3, 4, 4],
    byLevel: { attack: [8, 8, 12, 16] },
    desc: 'Target friendly stack gains +8 attack.',
  },

  // ---------------- Adventure-map spells ----------------
  // Cast OUTSIDE combat from the adventure spellbook (kind: 'adventure'); the
  // engine dispatches on `cast` (see actions.castAdventureSpell). They are
  // learned at the Mage Guild like any spell and never appear in the combat book.
  viewAir: {
    name: 'View Air', tier: 2, manaCost: 8, kind: 'adventure', adventure: true, cast: 'view',
    desc: 'Scry the land: reveal the whole of the level you stand on.',
  },
  summonBoat: {
    name: 'Summon Boat', tier: 2, manaCost: 8, kind: 'adventure', adventure: true, cast: 'summonBoat',
    desc: 'Call a boat to the nearest open water beside you.',
  },
  townPortal: {
    name: 'Town Portal', tier: 3, manaCost: 12, kind: 'adventure', adventure: true, cast: 'townPortal',
    desc: 'Recall to a town on this level — with Earth Magic, choose which. Costs a couple of tiles of movement, not the whole day.',
  },
  dimensionDoor: {
    name: 'Dimension Door', tier: 5, manaCost: 20, kind: 'adventure', adventure: true, cast: 'dimensionDoor',
    desc: 'Blink to a nearby explored tile you can stand on (limited casts per day).',
  },
  visions: {
    name: 'Visions', tier: 1, manaCost: 4, kind: 'adventure', adventure: true, cast: 'visions',
    desc: 'Scout the country around you: reveal a wide disc of the map. Repeatable.',
  },
  scuttleBoat: {
    name: 'Scuttle Boat', tier: 2, manaCost: 8, kind: 'adventure', adventure: true, cast: 'scuttleBoat',
    desc: 'Sink the nearest empty boat, denying it to your rivals.',
  },
  viewEarth: {
    name: 'View Earth', tier: 3, manaCost: 12, kind: 'adventure', adventure: true, cast: 'viewEarth',
    desc: 'Sense where the powers stand: every castle and commander on both levels is marked, on land that stays dark. The sighting ages and lapses.',
  },
  waterWalk: {
    name: 'Water Walk', tier: 4, manaCost: 12, kind: 'adventure', adventure: true, cast: 'waterWalk',
    desc: 'Stride over water on foot for the rest of the day (no boat needed).',
  },
  fly: {
    name: 'Fly', tier: 5, manaCost: 20, kind: 'adventure', adventure: true, cast: 'fly',
    desc: 'Soar over water and mountains alike for the rest of the day.',
  },
  disguise: {
    name: 'Disguise', tier: 2, manaCost: 6, kind: 'adventure', adventure: true, cast: 'disguise',
    desc: 'Cloak your army’s true strength from enemy scouts for the day.',
  },
};

// ---------------------------------------------------------------------------
// Magic schools (Air / Earth / Fire / Water) — assigned centrally so the whole
// catalog is easy to see at once. Each school is boosted by its magic skill
// (see SCHOOL_SKILL + CombatEngine.castSpell). Adventure spells carry a school
// for completeness, but only combat spells scale numerically for now.
// ---------------------------------------------------------------------------
export const SCHOOL_SKILL = { air: 'airMagic', earth: 'earthMagic', fire: 'fireMagic', water: 'waterMagic' };

const SPELL_SCHOOLS = {
  magicArrow: 'air', haste: 'air', slow: 'earth', bless: 'water', curse: 'fire',
  shield: 'earth', bloodlust: 'fire', weakness: 'water',
  lightningBolt: 'air', iceBolt: 'water', cure: 'water', blind: 'fire', stoneSkin: 'earth', disruptingRay: 'air',
  fireball: 'fire', mirth: 'water', misfortune: 'fire', meteorShower: 'earth', fortune: 'water',
  chainLightning: 'air', prayer: 'water', resurrection: 'earth', inferno: 'fire', sorrow: 'earth',
  implosion: 'earth', armageddon: 'fire', titanBolt: 'air', frenzy: 'fire',
  // adventure
  viewAir: 'air', summonBoat: 'water', townPortal: 'earth', dimensionDoor: 'air',
  visions: 'air', scuttleBoat: 'water', viewEarth: 'earth',
  waterWalk: 'water', fly: 'air', disguise: 'air',
};
for (const [id, school] of Object.entries(SPELL_SCHOOLS)) {
  if (SPELLS[id]) SPELLS[id].school = school;
}

/** Wisdom skill level required to learn a spell tier (0 = none). */
export function wisdomRequiredForTier(tier) {
  if (tier <= 2) return 0;
  return tier - 2; // tier 3 -> basic(1), 4 -> advanced(2), 5 -> expert(3)
}

export function spellsOfTier(tier) {
  return Object.keys(SPELLS).filter((id) => SPELLS[id].tier === tier);
}
