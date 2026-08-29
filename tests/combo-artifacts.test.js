/**
 * combo-artifacts.test.js — combination (assembled) artifacts as a SET BONUS.
 *
 * Wearing every component of a set adds the set's synergy on top of the pieces'
 * own effects; breaking the set (unequip/trade any piece) removes it. Folded
 * into heroUtils.artifactBonus, so combat stats, movement, mana and income all
 * pick it up — and since a completed set is derived from equipment, it survives
 * save/load with no new state. No Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { giveArtifact, unequipArtifact, dailyIncome } from '../src/core/actions.js';
import {
  heroStat, heroBaseMorale, heroMaxMovement, heroManaRegen,
} from '../src/core/heroUtils.js';
import {
  ARTIFACTS, ARTIFACT_SETS, activeArtifactSets, heroHasFullSet,
} from '../src/data/artifacts.js';

const sumEffect = (ids, effect) => ids.reduce((n, id) => n + (ARTIFACTS[id].effects[effect] || 0), 0);
const socketHolding = (hero, artId) => Object.keys(hero.equipment).find((k) => hero.equipment[k] === artId);

function bareHero() {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.equipment = {}; hero.backpack = [];
  return { s, hero };
}

test("Warlord's Panoply: the synergy applies only with all three pieces", () => {
  const { s, hero } = bareHero();
  const set = ARTIFACT_SETS.warlordsPanoply;
  const [, , third] = set.components;

  set.components.forEach((id) => giveArtifact(s, hero, id));
  assert.equal(heroHasFullSet(hero, set), true, 'all worn → complete');
  const indAtk = sumEffect(set.components, 'attack'), indDef = sumEffect(set.components, 'defense');
  assert.equal(heroStat(hero, 'attack'), hero.stats.attack + indAtk + set.effects.attack, 'set attack added');
  assert.equal(heroStat(hero, 'defense'), hero.stats.defense + indDef + set.effects.defense, 'set defense added');

  // Break the set by removing one piece → only that piece's own bonus is lost,
  // plus the whole synergy.
  unequipArtifact(s, hero, socketHolding(hero, third));
  assert.equal(heroHasFullSet(hero, set), false, 'incomplete → no synergy');
  assert.equal(
    heroStat(hero, 'attack'),
    hero.stats.attack + (indAtk - (ARTIFACTS[third].effects.attack || 0)),
    'set attack gone; remaining pieces still count',
  );
});

test("Warlord's Panoply: the morale synergy flows through heroBaseMorale", () => {
  const { s, hero } = bareHero();
  const set = ARTIFACT_SETS.warlordsPanoply;
  set.components.forEach((id) => giveArtifact(s, hero, id));
  const withSet = heroBaseMorale(hero);
  // dragonScaleMail carries no morale, so removing it drops ONLY the set morale.
  unequipArtifact(s, hero, socketHolding(hero, 'dragonScaleMail'));
  assert.equal(withSet - heroBaseMorale(hero), set.effects.morale);
});

test("Pathfinder's Kit: movement + gold synergy reach heroMaxMovement / dailyIncome", () => {
  const { s, hero } = bareHero();
  const set = ARTIFACT_SETS.pathfindersKit;
  const mv0 = heroMaxMovement(hero);
  set.components.forEach((id) => giveArtifact(s, hero, id));
  assert.equal(
    heroMaxMovement(hero) - mv0,
    sumEffect(set.components, 'moveBonus') + set.effects.moveBonus,
    'individual + set moveBonus in the pool',
  );

  const goldFull = dailyIncome(s, s.players[0]).gold || 0;
  // bootsOfSpeed has no goldPerDay, so removing it drops only the set gold.
  unequipArtifact(s, hero, socketHolding(hero, 'bootsOfSpeed'));
  assert.equal((goldFull) - (dailyIncome(s, s.players[0]).gold || 0), set.effects.goldPerDay);
});

test("Archmage's Regalia: power/knowledge/mana-regen synergy", () => {
  const { s, hero } = bareHero();
  const set = ARTIFACT_SETS.archmagesRegalia;
  const regen0 = heroManaRegen(hero);
  set.components.forEach((id) => giveArtifact(s, hero, id));
  assert.equal(heroStat(hero, 'power'), hero.stats.power + sumEffect(set.components, 'power') + set.effects.power);
  assert.equal(heroStat(hero, 'knowledge'), hero.stats.knowledge + sumEffect(set.components, 'knowledge') + set.effects.knowledge);
  assert.equal(heroManaRegen(hero) - regen0, sumEffect(set.components, 'manaRegen') + set.effects.manaRegen);
});

test('a completed set is derived from equipment → survives save/load', () => {
  const { s, hero } = bareHero();
  ARTIFACT_SETS.warlordsPanoply.components.forEach((id) => giveArtifact(s, hero, id));
  assert.ok(activeArtifactSets(hero).includes('warlordsPanoply'));
  const before = heroStat(hero, 'attack');

  const r = deserialize(serialize(s));
  const rh = r.heroes[hero.id];
  assert.ok(activeArtifactSets(rh).includes('warlordsPanoply'), 'still complete after reload');
  assert.equal(heroStat(rh, 'attack'), before, 'and still grants the same bonus');
});

test('every set is valid: real components, fit in sockets, known effect keys', () => {
  const slotCap = { head: 1, cape: 1, neck: 1, weapon: 1, shield: 1, torso: 1, ring: 2, feet: 1, misc: 2 };
  const known = new Set([
    'attack', 'defense', 'power', 'knowledge', 'morale', 'luck',
    'moveBonus', 'creatureSpeed', 'creatureHealth', 'goldPerDay', 'manaRegen',
  ]);
  for (const [id, set] of Object.entries(ARTIFACT_SETS)) {
    assert.ok(set.components.length >= 2, `${id}: a set needs multiple pieces`);
    const bySlot = {};
    for (const c of set.components) {
      assert.ok(ARTIFACTS[c], `${id}: component ${c} exists`);
      const slot = ARTIFACTS[c].slot;
      bySlot[slot] = (bySlot[slot] || 0) + 1;
    }
    for (const [slot, n] of Object.entries(bySlot)) {
      assert.ok(n <= slotCap[slot], `${id}: ${n} ${slot} piece(s) fit in ${slotCap[slot]} socket(s)`);
    }
    for (const k of Object.keys(set.effects)) assert.ok(known.has(k), `${id}: effect '${k}' is engine-known`);
  }
});
