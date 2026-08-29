/**
 * creatureBanks.js — Creature Banks: guarded one-time reward sites (map RPG
 * layer, part B). Each bank has a FIXED guard army; beat it and you plunder the
 * reward — resources/gold, creatures that join your hero, and (for the richest)
 * an artifact. Banks are consumed on victory (obj.looted). Guards + rewards are
 * balanced so the prize is worth roughly the fight: easy Dwarven Treasury up to
 * the prestige Dragon Utopia. All ids reference real creatures in data/creatures.
 *
 * `reward.artifact` is the RARITY BAND of the relic the site pays out (see
 * ARTIFACTS.value), not a boolean — a Dragon Utopia earns a value-3 relic, a
 * boss lair the top band. It was `true`, and the payout was drawn flat over the
 * whole catalog, so the hardest fight on the map handed out a +1 Luck charm
 * about one time in seven and could even hand out a campaign relic. Every reader
 * treats it as truthy, so the band is the same field doing more work.
 */

export const CREATURE_BANKS = {
  dwarvenTreasury: {
    name: 'Dwarven Treasury',
    guards: [{ creature: 'dwarf', count: 14 }],
    reward: { gold: 3000, resources: { gems: 6 }, creatures: [{ creature: 'dwarf', count: 4 }] },
  },
  griffinConservatory: {
    name: 'Griffin Conservatory',
    guards: [{ creature: 'griffin', count: 12 }],
    reward: { gold: 2500, creatures: [{ creature: 'griffin', count: 8 }] },
  },
  cyclopsStockpile: {
    name: 'Cyclops Stockpile',
    guards: [{ creature: 'cyclops', count: 6 }],
    reward: { gold: 5000, resources: { ore: 10 }, creatures: [{ creature: 'cyclops', count: 4 }] },
  },
  nagaBank: {
    name: 'Naga Bank',
    guards: [{ creature: 'naga', count: 5 }],
    reward: { gold: 4000, resources: { gems: 12 }, creatures: [{ creature: 'naga', count: 3 }] },
  },
  dragonUtopia: {
    name: 'Dragon Utopia',
    guards: [{ creature: 'greenDragon', count: 3 }, { creature: 'medusa', count: 8 }],
    reward: { gold: 6000, resources: { gems: 10, mercury: 6 }, creatures: [{ creature: 'greenDragon', count: 2 }], artifact: 3 },
  },
};

/** Bank ids ordered easy → hard (the generator tiers placement by this). */
export const BANK_TYPES = ['dwarvenTreasury', 'griffinConservatory', 'nagaBank', 'cyclopsStockpile', 'dragonUtopia'];

/**
 * Boss lairs — a rarer, prestige cousin of the creature bank (HoMM3's parity
 * layer). Each lair is held by a SINGLE apex species whose innate ability IS the
 * battlefield gimmick (a Phoenix that rises from its ashes, a Black Dragon magic
 * cannot touch, a Hydra that savages everything around it, a Behemoth that rends
 * armour, an Archangel that raises its fallen), so the "gimmick" needs no new
 * combat code — the engine already applies the guard's abilities. The hoard is
 * richer than any bank's: heavy gold, a clutch of that apex creature, and a
 * GUARANTEED artifact. They ride the exact creatureBank object + combat + reward
 * path (see actions.bankDef), so the view draws them as `bank_<lairType>` exactly
 * like a bank — a generated raster wins when present, else the procedural lair
 * mound. Each lair therefore has a bank_<lairType> sprite-manifest entry (pinned by
 * tests/map-object-sprites), so a new boss lair here can't drift out of the pack.
 */
export const BOSS_LAIRS = {
  phoenixRoost: {
    name: 'Phoenix Roost', boss: true,
    gimmick: 'The phoenix rises from its own ashes once per battle.',
    guards: [{ creature: 'phoenix', count: 4 }],
    reward: { gold: 8000, creatures: [{ creature: 'phoenix', count: 2 }], artifact: 4 },
  },
  blackDragonCave: {
    name: 'Black Dragon Cave', boss: true,
    gimmick: 'The black dragon is immune to all magic and brooks no retaliation.',
    guards: [{ creature: 'blackDragon', count: 3 }],
    reward: { gold: 10000, creatures: [{ creature: 'blackDragon', count: 1 }], artifact: 4 },
  },
  hydraLair: {
    name: 'Hydra Lair', boss: true,
    gimmick: 'The chaos hydra savages every adjacent foe at once, without reprisal.',
    guards: [{ creature: 'chaosHydra', count: 5 }],
    reward: { gold: 7000, resources: { sulfur: 8 }, creatures: [{ creature: 'chaosHydra', count: 2 }], artifact: 4 },
  },
  behemothCrag: {
    name: 'Behemoth Crag', boss: true,
    gimmick: 'The ancient behemoth rends through 80% of your defense.',
    guards: [{ creature: 'ancientBehemoth', count: 5 }],
    reward: { gold: 8000, creatures: [{ creature: 'ancientBehemoth', count: 2 }], artifact: 4 },
  },
  archangelSpire: {
    name: 'Archangel Spire', boss: true,
    gimmick: 'The archangel resurrects its fallen guardians mid-battle.',
    guards: [{ creature: 'archangel', count: 3 }],
    reward: { gold: 12000, creatures: [{ creature: 'archangel', count: 1 }], artifact: 4 },
  },
};

/** Boss-lair ids (the generator's rare boss pass picks from these). */
export const BOSS_LAIR_TYPES = Object.keys(BOSS_LAIRS);

/**
 * Definition for a creatureBank object's bankType — a plain bank OR a boss lair.
 * One accessor so every combat/reward/valuation/view site treats a lair exactly
 * like a bank (they share the `creatureBank` object type and its whole path).
 */
export function bankDef(bankType) {
  return CREATURE_BANKS[bankType] || BOSS_LAIRS[bankType] || null;
}

/**
 * A CLEARED lair keeps breeding (the `lairBrood` feature).
 *
 * Killing the guards does not clear the nest: the species that held the place is
 * still there, so an emptied bank accrues its own apex creature week by week and
 * a hero who comes back takes the brood. That turns a Dragon Utopia or a Behemoth
 * Crag from a single prize into a reason to keep a road to it — you can farm
 * dragons, slowly, having earned the right the hard way.
 *
 * Derived from the bank's own reward stack, so a new bank or lair needs no second
 * table: what it hands out once is what it breeds thereafter. Half the reward
 * stack per week (at least one), capped at four rewards' worth so an ignored lair
 * banks a useful stack without becoming an unbounded army.
 *
 * Returns null for a bank whose reward holds no creatures — nothing to breed.
 */
export const BROOD_RATE = 0.5;
export const BROOD_CAP_MULT = 4;

export function broodOf(bankType) {
  const first = (bankDef(bankType)?.reward?.creatures || [])[0];
  if (!first || !(first.count > 0)) return null;
  return {
    creature: first.creature,
    perWeek: Math.max(1, Math.round(first.count * BROOD_RATE)),
    cap: Math.max(1, Math.round(first.count * BROOD_CAP_MULT)),
  };
}
