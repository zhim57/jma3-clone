/**
 * ai-town-portal.test.js — #13 (opt-in): the AI adopts Town Portal to defend.
 *
 * On a real fresh game we strand the AI's hero far from its capital, put the
 * capital under a threat its garrison can't hold, and give the realm the Mage
 * Guild that teaches Town Portal. With the feature on the hero recalls home and
 * garrisons the town; with it off (or without the guild, or with no threat) it
 * does nothing. The spell is granted on adoption so the AI reliably knows it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const SEED = 4242;
const AI = 1;

/** A fresh game with the AI's hero stranded far from a besieged, guild-holding town. */
function scenario({ features = { aiTownPortal: true }, guild = true, threatened = true } = {}) {
  const s = newGame({ seed: SEED, features });
  const town = playerTowns(s, AI)[0];
  const hero = playerHeroes(s, AI)[0];
  if (guild) town.buildings.push('mageGuild3');
  town.garrison = [];                 // an empty garrison can't hold on its own
  town.visitingHeroId = null;
  hero.inTownId = null;
  hero.army = [{ creature: 'pikeman', count: 80, hurt: 0 }]; // strong enough to turn the fight
  hero.x = Math.min(town.x + 8, s.map.w - 2); hero.y = town.y; // far from home
  hero.mana = 20; hero.mp = 2000; hero.spells = [];           // knows no spell yet
  hero.skills = {};                                            // no Earth Magic → snaps to nearest
  town.aiThreat = threatened ? { value: 3000, x: town.x, y: town.y, z: town.z ?? 0, day: s.day } : null;
  return { s, town, hero };
}

test('ON: the hero recalls home and garrisons the threatened town', () => {
  const { s, town, hero } = scenario();
  const ai = new AITurnController(s, AI);
  const cast = ai.maybeTownPortalHome(hero);
  assert.equal(cast, true, 'the AI cast Town Portal');
  assert.equal(hero.inTownId, town.id, 'the hero arrived and entered the town');
  assert.equal(hero.x, town.x); assert.equal(hero.y, town.y);
  assert.ok(hero.spells.includes('townPortal'), 'adoption granted the spell');
  assert.equal(hero.mana, 8, 'mana paid (20 - 12)');
});

test('OFF: without the feature the AI never teleports', () => {
  const { s, hero } = scenario({ features: {} });
  const ai = new AITurnController(s, AI);
  assert.equal(ai.maybeTownPortalHome(hero), false);
  assert.ok(!hero.spells.includes('townPortal'));
});

test('gated on the tech: no Mage Guild 3 → no adoption', () => {
  const { s, hero } = scenario({ guild: false });
  const ai = new AITurnController(s, AI);
  assert.equal(ai.maybeTownPortalHome(hero), false);
});

test('no need: an unthreatened town is not worth a recall', () => {
  const { s, hero } = scenario({ threatened: false });
  const ai = new AITurnController(s, AI);
  assert.equal(ai.maybeTownPortalHome(hero), false);
});
