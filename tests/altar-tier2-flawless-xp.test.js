/**
 * altar-tier2-flawless-xp.test.js
 *
 * Two rule changes:
 *  - The Altar of Transmutation converts ONLY into the town's TIER-2 creature
 *    (Castle -> Archers, Inferno -> Gogs), never into anything higher.
 *  - A battle won without losing a single creature pays FLAWLESS_XP_BONUS extra
 *    experience, on every battle path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { buildingCatalog } from '../src/data/buildings.js';
import { Rng } from '../src/core/rng.js';
import { newGame } from '../src/core/GameState.js';
import { transmuteTargets } from '../src/core/transmute.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';

/** A town of `faction` with the Altar and EVERY dwelling built. */
function fullTown(faction) {
  const cat = buildingCatalog(faction);
  return { faction, buildings: ['altar', ...Object.keys(cat).filter((b) => cat[b].dwellingTier)] };
}
const tierOf = (id) => CREATURES[id].tier;

test('the Altar offers ONLY the tier-2 creature, however much the town has built', () => {
  for (const faction of ['castle', 'inferno', 'necropolis', 'rampart', 'tower', 'stronghold']) {
    const out = transmuteTargets(fullTown(faction));
    assert.ok(out.length > 0, `${faction} offers something`);
    for (const id of out) {
      assert.equal(tierOf(id), CONFIG.TRANSMUTE_TARGET_TIER,
        `${faction}: ${id} is tier ${tierOf(id)}, expected ${CONFIG.TRANSMUTE_TARGET_TIER}`);
    }
  }
});

test('Castle converts to Archers, Inferno to Gogs (with the upgrade when built)', () => {
  assert.deepEqual(transmuteTargets(fullTown('castle')).map((id) => CREATURES[id].name), ['Archer', 'Marksman']);
  assert.deepEqual(transmuteTargets(fullTown('inferno')).map((id) => CREATURES[id].name), ['Gog', 'Magog']);
});

test('no top-tier minting — an Archangel can never be an Altar output', () => {
  const out = transmuteTargets(fullTown('castle'));
  assert.ok(!out.includes('archangel'), 'the old any-dwelling rule let a peasant horde become Archangels');
  assert.ok(out.every((id) => tierOf(id) <= CONFIG.TRANSMUTE_TARGET_TIER));
});

test('the Altar offers nothing without the tier-2 dwelling, or without the Altar', () => {
  assert.deepEqual(transmuteTargets({ faction: 'castle', buildings: ['altar'] }), [], 'no dwelling ⇒ nothing');
  assert.deepEqual(transmuteTargets(fullTown('castle').buildings ? { faction: 'castle', buildings: ['archerTower'] } : {}), [],
    'no Altar ⇒ nothing');
});

// ---- flawless-victory experience -------------------------------------------

/** Run a battle to its end with the game's own resolver, and return the result. */
function fightToEnd(attackerArmy, defenderArmy) {
  const s = newGame({ seed: 3, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const hero = Object.values(s.heroes).find((h) => h.owner === 0);
  const battle = createBattle({
    rng: new Rng(11),
    attacker: { hero, army: attackerArmy, playerIndex: 0 },
    defender: { hero: null, army: defenderArmy, playerIndex: -1 },
  });
  return autoResolve(battle);
}

test('an overwhelming win loses nothing and pays the flawless premium', () => {
  const r = fightToEnd([{ creature: 'archangel', count: 200 }], [{ creature: 'peasant', count: 40 }]);
  assert.equal(r.attackerWon, true);
  assert.equal(r.flawless, true, 'not a creature lost');
  assert.equal(r.xp, Math.round(r.baseXp * (1 + CONFIG.FLAWLESS_XP_BONUS)), 'xp carries the bonus');
  assert.ok(r.xp > r.baseXp, 'and it is strictly more');
});

test('a costly win pays the plain experience — the bonus is for winning CHEAPLY', () => {
  const r = fightToEnd([{ creature: 'pikeman', count: 30 }], [{ creature: 'pikeman', count: 25 }]);
  if (r.attackerWon && !r.flawless) {
    assert.equal(r.xp, r.baseXp, 'no premium when creatures died');
  }
  assert.ok(typeof r.flawless === 'boolean', 'the flag is always reported');
});

test('the bonus is exactly 10% and reported for the recap', () => {
  assert.equal(CONFIG.FLAWLESS_XP_BONUS, 0.10);
  const r = fightToEnd([{ creature: 'archangel', count: 200 }], [{ creature: 'peasant', count: 40 }]);
  assert.equal(r.xp - r.baseXp, Math.round(r.baseXp * 0.10), 'the recap can show the difference');
});
