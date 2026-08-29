/**
 * buildings.test.js — townBuildSlots collapses upgrade chains to one slot each.
 *
 * The town screen has a fixed number of boxes; without collapsing, every built
 * hall/guild/fort/dwelling tier keeps its own box and the dwellings fall off the
 * bottom. This suite pins the collapse so a dwelling like the Archers' Tower is
 * always offered once its prerequisite is met.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { townBuildSlots, buildingCatalog } from '../src/data/buildings.js';

// A town as newGame() creates it (see MapGenerator): hall, fort, tavern, tier-1
// dwelling already standing.
const freshCastle = () => ({ faction: 'castle', buildings: ['villageHall', 'fort', 'tavern', 'dwelling1'] });

test('townBuildSlots: one slot per upgrade chain, current step only', () => {
  const slots = townBuildSlots(freshCastle(), 'castle');

  // Village Hall is auto-built and never offered as its own slot; the hall chain
  // shows exactly its next step, Town Hall — not cityHall/capitol.
  const halls = slots.filter((id) => ['villageHall', 'townHall', 'cityHall', 'capitol'].includes(id));
  assert.deepEqual(halls, ['townHall'], 'hall chain collapses to the single next step');

  // Fort is built, so the fort chain offers Citadel (not fort again, not castle).
  const forts = slots.filter((id) => ['fort', 'citadel', 'castle'].includes(id));
  assert.deepEqual(forts, ['citadel']);

  // Mage guild: nothing built, so only level 1 is offered.
  const guilds = slots.filter((id) => id.startsWith('mageGuild'));
  assert.deepEqual(guilds, ['mageGuild1']);
});

test('townBuildSlots: the Archers’ Tower (dwelling2) is offered once dwelling1 stands', () => {
  const slots = townBuildSlots(freshCastle(), 'castle');
  assert.ok(slots.includes('dwelling2'), 'tier-2 dwelling must be reachable in the grid');
  // dwelling1 is built, so its own chain shows the UPGRADE, not the built base.
  assert.ok(slots.includes('dwelling1u'), 'built dwelling1 collapses to its upgrade slot');
  assert.ok(!slots.includes('dwelling1'), 'the built base no longer occupies a slot');
});

test('townBuildSlots: building a tier advances the slot to the next tier', () => {
  const town = freshCastle();
  town.buildings.push('townHall'); // build the offered step
  const slots = townBuildSlots(town, 'castle');
  const halls = slots.filter((id) => ['villageHall', 'townHall', 'cityHall', 'capitol'].includes(id));
  assert.deepEqual(halls, ['cityHall'], 'after Town Hall, the slot becomes City Hall');
});

test('townBuildSlots: a maxed chain shows its top tier, still just one slot', () => {
  const town = { faction: 'castle', buildings: ['villageHall', 'fort', 'citadel', 'castle', 'tavern', 'dwelling1'] };
  const forts = townBuildSlots(town, 'castle').filter((id) => ['fort', 'citadel', 'castle'].includes(id));
  assert.deepEqual(forts, ['castle'], 'fully-built fort line collapses to its top tier');
});

test('townBuildSlots: every returned slot is a real, non-auto building for the faction', () => {
  for (const faction of ['castle', 'inferno', 'tower']) {
    const town = { faction, buildings: ['villageHall'] };
    const catalog = buildingCatalog(faction);
    for (const id of townBuildSlots(town, faction)) {
      assert.ok(catalog[id], `slot ${id} exists in ${faction} catalog`);
      assert.ok(!catalog[id].autoBuilt, `slot ${id} is not an auto-built root`);
    }
  }
});
