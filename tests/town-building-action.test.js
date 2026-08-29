/**
 * town-building-action.test.js — the data-driven router that decides what
 * clicking a BUILT town building does. TownScene.openBuiltBuilding switches on
 * this, so pinning it here keeps the view wiring honest: a dwelling recruits its
 * unit, the Fort line opens the recruit overview, the functional buildings open
 * their dialog, and passive buildings show info.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildingCatalog, buildingAction } from '../src/data/buildings.js';

const cat = buildingCatalog('castle');

test('dwellings (base and upgraded) → recruit', () => {
  assert.equal(buildingAction('dwelling1', cat.dwelling1), 'recruit');   // Guardhouse
  assert.equal(buildingAction('dwelling4', cat.dwelling4), 'recruit');   // Barracks
  assert.equal(buildingAction('dwelling7u', cat.dwelling7u), 'recruit'); // Upg. Portal of Glory
});

test('the Fort/Citadel/Castle line → recruitAll (the overview)', () => {
  assert.equal(buildingAction('fort', cat.fort), 'recruitAll');
  assert.equal(buildingAction('citadel', cat.citadel), 'recruitAll');
  assert.equal(buildingAction('castle', cat.castle), 'recruitAll');
});

test('functional buildings → their own dialog', () => {
  assert.equal(buildingAction('tavern', cat.tavern), 'tavern');
  assert.equal(buildingAction('marketplace', cat.marketplace), 'market');
  assert.equal(buildingAction('shipyard', cat.shipyard), 'shipyard');
  assert.equal(buildingAction('blacksmith', cat.blacksmith), 'blacksmith'); // sells war machines
  assert.equal(buildingAction('mageGuild1', cat.mageGuild1), 'guild');
  assert.equal(buildingAction('mageGuild5', cat.mageGuild5), 'guild');
});

test('passive buildings (hall line, silo, stables) → info', () => {
  for (const id of ['villageHall', 'townHall', 'cityHall', 'capitol', 'resourceSilo', 'stables']) {
    assert.equal(buildingAction(id, cat[id]), 'info', `${id} → info`);
  }
});

test('a dwelling is recognised by dwellingTier, not its id — inferno/tower too', () => {
  const inferno = buildingCatalog('inferno');
  const tower = buildingCatalog('tower');
  assert.equal(buildingAction('dwelling3', inferno.dwelling3), 'recruit'); // Kennels
  assert.equal(buildingAction('dwelling5', tower.dwelling5), 'recruit');   // Altar of Wishes
});
