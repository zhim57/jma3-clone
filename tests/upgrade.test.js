/**
 * upgrade.test.js — upgrading owned stacks in a town.
 *
 * A stack can be upgraded to its dwelling's upgraded creature once the upgraded
 * dwelling is built, for the cost difference between the two recruit prices.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { upgradeInfo, upgradeUnitCost, upgradeStack } from '../src/core/actions.js';
import { CREATURES } from '../src/data/creatures.js';

const townWith = (buildings) => ({ owner: 0, faction: 'castle', buildings });
const stateWith = (gold) => ({ players: [{ resources: { gold } }] });

test('upgradeInfo: offered only when the upgraded dwelling is built', () => {
  // Base Guardhouse only — no upgrade path yet.
  assert.equal(upgradeInfo(townWith(['dwelling1']), 'pikeman'), null);
  // Upgraded Guardhouse built — pikeman → halberdier.
  assert.deepEqual(upgradeInfo(townWith(['dwelling1', 'dwelling1u']), 'pikeman'), { to: 'halberdier' });
  // Already upgraded units have no further upgrade.
  assert.equal(upgradeInfo(townWith(['dwelling1', 'dwelling1u']), 'halberdier'), null);
  // Wrong-faction / neutral creatures can't be upgraded here.
  assert.equal(upgradeInfo(townWith(['dwelling1', 'dwelling1u']), 'skeleton'), null);
});

test('upgradeUnitCost: charges the per-unit recruit-cost difference × count', () => {
  const per = (CREATURES.halberdier.cost.gold - CREATURES.pikeman.cost.gold);
  assert.deepEqual(upgradeUnitCost('pikeman', 'halberdier', 10), { gold: per * 10 });
});

test('upgradeStack: converts the stack and deducts the cost when affordable', () => {
  const town = townWith(['dwelling1', 'dwelling1u']);
  const cost = upgradeUnitCost('pikeman', 'halberdier', 10).gold;
  const state = stateWith(cost + 100);
  const army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null];

  assert.equal(upgradeStack(state, town, army, 0), true);
  assert.equal(army[0].creature, 'halberdier');
  assert.equal(army[0].count, 10, 'count is preserved');
  assert.equal(state.players[0].resources.gold, 100, 'exactly the cost difference is paid');
});

test('upgradeStack: refused when the player cannot afford it', () => {
  const town = townWith(['dwelling1', 'dwelling1u']);
  const state = stateWith(10); // far too little
  const army = [{ creature: 'pikeman', count: 10, hurt: 0 }];

  assert.equal(upgradeStack(state, town, army, 0), false);
  assert.equal(army[0].creature, 'pikeman', 'stack unchanged');
  assert.equal(state.players[0].resources.gold, 10, 'no gold spent');
});
