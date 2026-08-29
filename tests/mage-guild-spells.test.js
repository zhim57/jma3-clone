/**
 * mage-guild-spells.test.js — the Mage Guild spell offering, with the tier-5
 * two-slot fix (2026-07 repo review, backlog E50).
 *
 * Tier 5's pool mixes 4 combat spells with 2 adventure spells (Fly, Dimension
 * Door). A single slot had a 2-in-6 chance of offering NO tier-5 combat spell;
 * two slots cut that shut-out to 1-in-15 (you must draw BOTH adventure spells).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerTowns } from '../src/core/GameState.js';
import { buildStructure } from '../src/core/actions.js';
import { GUILD_SPELL_SLOTS } from '../src/data/buildings.js';
import { SPELLS, spellsOfTier } from '../src/data/spells.js';

const nCr = (n, r) => {
  if (r < 0 || r > n) return 0;
  let c = 1;
  for (let i = 0; i < r; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
};
// Fraction of `slots`-sized draws from the pool that contain ZERO combat spells.
const shutoutRate = (pool, slots) => {
  const adv = pool.filter((id) => SPELLS[id].adventure).length;
  return nCr(adv, slots) / nCr(pool.length, slots);
};

test('E50: tier 5 offers two slots, shrinking the no-combat-spell shut-out', () => {
  assert.deepEqual(GUILD_SPELL_SLOTS, [0, 3, 3, 2, 2, 2], 'tier 5 gets two slots');
  const pool = spellsOfTier(5);
  const combat = pool.filter((id) => !SPELLS[id].adventure);
  const adventure = pool.filter((id) => SPELLS[id].adventure);
  assert.ok(combat.length >= 2 && adventure.length === 2,
    'the tier-5 pool is combat-heavy but carries Fly + Dimension Door');
  // Two slots strictly beat one, and drop the shut-out to at most ~1-in-15.
  assert.ok(shutoutRate(pool, 2) < shutoutRate(pool, 1), 'two slots beat one');
  assert.ok(shutoutRate(pool, 2) <= 1 / 15 + 1e-9, 'shut-out is at most ~1-in-15');
});

test('E50: building a tier-5 Mage Guild offers two tier-5 spells', () => {
  const s = newGame({ seed: 7 });
  const town = playerTowns(s, 0)[0];
  // Stand up the guild prerequisites and pay for the top level directly.
  for (const g of ['mageGuild1', 'mageGuild2', 'mageGuild3', 'mageGuild4']) {
    if (!town.buildings.includes(g)) town.buildings.push(g);
  }
  town.builtToday = false;
  const p = s.players[town.owner];
  for (const r of Object.keys(p.resources)) p.resources[r] += 100000;

  assert.equal(buildStructure(s, town, 'mageGuild5'), true, 'the guild builds');
  const offered = town.guildSpells[5];
  assert.equal(offered.length, 2, 'two tier-5 spells are offered');
  for (const id of offered) assert.equal(SPELLS[id].tier, 5, `${id} is a tier-5 spell`);
});
