/**
 * factions.js — Faction registry.
 *
 * THIS CLONE SHIPS TWO PLAYABLE FACTIONS. Upstream there are nine; this tree
 * exists to study AI PLAYER logic, and two rival towns are enough to run every
 * contest the AI has to reason about — expand, fight, siege, hold — while keeping
 * the tree small. Castle and Inferno are the pair the parent repo's own AI
 * benchmark already uses (scripts/sim/aiperf.mjs) and the pair every hand-authored
 * battle fixture in data/skirmishScenarios.js is written for.
 *
 * WHAT WAS *NOT* CUT, AND WHY IT MATTERS
 * --------------------------------------
 * Only this registry shrank. Every creature of all nine factions is still in
 * data/creatures.js, on purpose. A default 2-player map places ~39 distinct
 * off-roster creatures as wandering guards, creature-bank defenders, Pandora
 * rewards and hero starting armies — and combat/CombatEngine.js dereferences
 * `CREATURES[id].abilities` unguarded in five places, so a pruned roster is a hard
 * TypeError on the first fight, not a quieter map. Keeping the full bestiary also
 * means: map generation draws the SAME rng stream as upstream (so seeds stay
 * comparable), the combat AI still meets the six abilities that exist only on
 * other factions' creatures (attacksAround, ignoreDefense, lifeDrain, rebirth,
 * spellImmune, ghostRemnant — CombatAI.js has dedicated code for three of them),
 * and Necromancy still finds `CREATURES.skeleton`, which core/actions.js hardcodes
 * and any faction's hero can learn.
 *
 * So: two factions you can BUILD, nine factions' worth of creatures you can FIGHT.
 *
 * HOW TO ADD A FACTION BACK
 * -------------------------
 * 1. Copy its entry here from the parent repo (its creatures are already present).
 * 2. Its dwellings are already in buildings.js and its heroes in heroes.js.
 * 3. Re-add its CONFIG.FACTION_GRAIL row (config.js) if you want the Grail bonus,
 *    and its TOWN_NAMES row (map/MapGenerator.js) if you want themed town names —
 *    both fall back safely without one.
 * Nothing else is needed: towns, recruitment, AI and UI are faction-agnostic and
 * read this registry with Object.keys()/FACTIONS[id]. There is no branching on a
 * faction id anywhere in src/.
 */

export const FACTIONS = {
  castle: {
    id: 'castle',
    name: 'Castle',
    alignment: 'good',
    nativeTerrain: 'grass',
    color: 0x3a6ea5,      // banner/UI accent
    townGlyph: 'town_castle',   // town texture key (see gfx/tokens TOWN_PAINTERS)
    tagline: 'Order · Faith · Steel',
    desc: 'Knights and clergy of the realm. High defense, reliable morale, strong ranged and fast holy units.',
  },
  inferno: {
    id: 'inferno',
    name: 'Inferno',
    alignment: 'evil',
    nativeTerrain: 'lava',
    color: 0xa53a2a,
    townGlyph: 'town_inferno',
    tagline: 'Fire · Fury · Dominion',
    desc: 'Legions of the burning abyss. High offense, teleportation tricks and mana theft.',
  },
};

/** Player banner colors (player index -> tint). */
export const PLAYER_COLORS = [0x2f6fd0, 0xc23b2b, 0x2fa05a, 0xb08c2f];

/**
 * Every banner colour the world can fly, indexed by a player's `bannerSlot`.
 *
 * Upstream this appends a block of invader-realm colours after the four local
 * ones, because a foreign realm landing mid-game takes a slot past them. This
 * clone has no invader realms (see core/invaderRealms.js), so the two lists are
 * the same list — but gfx/tokens.js registers one rider sprite and one flag per
 * entry and three modules index into it, so the name is kept rather than folded
 * away at every call site.
 */
export const BANNER_COLORS = [...PLAYER_COLORS];
export const PLAYER_COLOR_NAMES = ['Blue', 'Red', 'Green', 'Gold'];
