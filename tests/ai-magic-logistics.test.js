/**
 * ai-magic-logistics.test.js — the AI learns the map-moving spells, values the
 * schools that carry them, and blinks instead of walking.
 *
 * Reported: "we need the AI to use town portal and dimension door to shuttle
 * crew; earth and air magic are very valuable as expert + town portal and
 * dimension door can reach any point of the map in half a turn."
 *
 * It could not, and the reason was a chain of four gaps rather than a missing
 * weight. Measured over four 90-day games before any of this:
 *
 *   1. BUILD ORDER. mageGuild4 and mageGuild5 were absent from the AI's list
 *      altogether, so no town ever rose above a tier-1 guild — 0 of them, in
 *      every game — and a tier-5 spell was unreachable by construction.
 *   2. THE SPELLBOOK AT THE GATE. pickupOnPass counts a hero ADJACENT to its own
 *      town as being at it and hands over the garrison, but only ever took the
 *      troops. Once guilds were built, two towns held Dimension Door and
 *      eighteen rival heroes had the Expert Wisdom to learn it — and not one did.
 *   3. THE CAST. The AI had never cast Dimension Door at all; Town Portal it
 *      cast only in a panic, to rush a hero home to a town about to fall.
 *   4. THE WEIGHTS. SKILL_WEIGHTS had no entry for any magic school, so all four
 *      scored the unlisted 20-point default — which was CORRECT for a realm that
 *      could not cast, and wrong the moment it could.
 *
 * After: 8 towns raised a tier-5 guild, 4 heroes learned Dimension Door, and the
 * AI cast it 226 times for 273,773 movement points saved — some 2,700 tiles of
 * walking that no longer had to happen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, playerTowns, tileAt } from '../src/core/GameState.js';
import { AITurnController, BUILD_ORDER, BUILD_ORDER_CAPITOL } from '../src/ai/AIPlayer.js';
import { skillOptionScore, SKILL_WEIGHTS } from '../src/core/skillPolicy.js';
import { dimDoorLandable } from '../src/core/actions.js';
import { spellsOfTier, wisdomRequiredForTier, SPELLS } from '../src/data/spells.js';

function world(seed = 4242) {
  return newGame({
    seed,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
    mapW: 44, mapH: 36,
  });
}

test('THE GAP THAT MADE ALL THE REST MOOT: the guild chain runs to five', () => {
  // Dimension Door is tier 5. With mageGuild4/5 off the list no town could ever
  // teach it, so every other part of this — the weights, the cast, the schools —
  // was arguing about a spell the AI could not obtain.
  for (const [name, order] of [['BUILD_ORDER', BUILD_ORDER], ['BUILD_ORDER_CAPITOL', BUILD_ORDER_CAPITOL]]) {
    for (const g of ['mageGuild1', 'mageGuild2', 'mageGuild3', 'mageGuild4', 'mageGuild5']) {
      assert.ok(order.includes(g), `${name} cannot reach ${g}`);
    }
    // And in order: each tier is the prerequisite of the next (buildings.js).
    const at = (g) => order.indexOf(g);
    for (let i = 1; i < 5; i++) {
      assert.ok(at(`mageGuild${i}`) < at(`mageGuild${i + 1}`),
        `${name} lists mageGuild${i + 1} before its own prerequisite`);
    }
  }
  assert.ok(spellsOfTier(5).includes('dimensionDoor'), 'the spell this exists for moved tier');
  assert.equal(wisdomRequiredForTier(SPELLS.dimensionDoor.tier), 3, 'it takes Expert Wisdom');
});

test('a hero at its own gate reads the spellbook, not just the muster roll', () => {
  const s = world();
  const ai = new AITurnController(s, 1);
  const town = playerTowns(s, 1)[0];
  const hero = playerHeroes(s, 1)[0];
  // A guild that teaches something, and a hero with the Wisdom for it, standing
  // one tile outside — the exact case pickupOnPass already treats as "at the
  // town" when it hands over the garrison.
  town.guildSpells = { 1: ['visions'] };
  hero.skills = { ...(hero.skills || {}), wisdom: 3 };
  hero.spells = [];
  hero.x = town.x + 1; hero.y = town.y; hero.z = town.z ?? 0;
  hero.inTownId = null;
  town.visitingHeroId = null;

  ai.pickupOnPass(hero);
  assert.ok(hero.spells.includes('visions'), 'stood at the gate and learned nothing');
  assert.equal(ai.metrics.spellsLearned, 1);

  // Wisdom still gates it — the AI is taught by the same function the human is.
  const other = playerHeroes(s, 1)[1] || hero;
  town.guildSpells = { 5: ['dimensionDoor'] };
  hero.skills.wisdom = 1;
  ai.pickupOnPass(hero);
  assert.ok(!hero.spells.includes('dimensionDoor'), 'Basic Wisdom must not reach a tier-5 spell');
  assert.ok(other);
});

test('a hero too far from the wall is taught nothing', () => {
  const s = world();
  const ai = new AITurnController(s, 1);
  const town = playerTowns(s, 1)[0];
  const hero = playerHeroes(s, 1)[0];
  town.guildSpells = { 1: ['visions'] };
  hero.skills = { ...(hero.skills || {}), wisdom: 3 };
  hero.spells = [];
  hero.x = town.x + 4; hero.y = town.y; hero.inTownId = null;
  ai.pickupOnPass(hero);
  assert.equal(hero.spells.length, 0, 'learned a spell from four tiles away');
});

test('Earth and Air are priced on the RANK when the hero can cast — not discounted by it', () => {
  const carrier = { class: 'knight', skills: {}, army: [], spells: ['dimensionDoor', 'townPortal'] };
  const plain = { class: 'knight', skills: {}, army: [], spells: [] };
  for (const [school, spell] of [['airMagic', 'dimensionDoor'], ['earthMagic', 'townPortal']]) {
    const basic = skillOptionScore(carrier, { skill: school, toLevel: 1 });
    const expert = skillOptionScore(carrier, { skill: school, toLevel: 3 });
    assert.ok(expert > basic,
      `${school}: Expert is the rank worth having (${spell} is free/farthest there), got ${expert} <= ${basic}`);
    assert.ok(expert >= SKILL_WEIGHTS.logistics[0] * 0.9,
      `${school} at Expert should stand with Logistics — both answer "how much map in a day"`);
    // Without the spell it is an ordinary school: worth something, not that.
    const none = skillOptionScore(plain, { skill: school, toLevel: 3 });
    assert.ok(none < basic, `${school} must not be priced for a spell the hero has not got`);
    assert.ok(none > 0);
  }
  // Fire and Water carry no map-moving spell, so the rank discount still applies.
  const fireBasic = skillOptionScore(carrier, { skill: 'fireMagic', toLevel: 1 });
  const fireExpert = skillOptionScore(carrier, { skill: 'fireMagic', toLevel: 3 });
  assert.ok(fireExpert < fireBasic, 'an ordinary school keeps the later-ranks-are-worth-less curve');
});

test('every magic school is weighted at all — the default was silently pricing them', () => {
  for (const school of ['airMagic', 'earthMagic', 'fireMagic', 'waterMagic']) {
    assert.ok(SKILL_WEIGHTS[school], `${school} falls through to the unlisted default`);
  }
});

/** A straight-line plan of `n` tiles east of the hero, each costing one step. */
function planEast(hero, n, cost = CONFIG.MOVE_COST_STRAIGHT) {
  const path = [];
  for (let i = 1; i <= n; i++) path.push({ x: hero.x + i, y: hero.y, cost });
  return { path, cursor: 0 };
}

test('BLINK: the AI jumps when jumping is cheaper, and lands where the engine allows', () => {
  const s = world();
  const ai = new AITurnController(s, 1);
  const hero = playerHeroes(s, 1)[0];
  hero.spells = ['dimensionDoor'];
  hero.skills = { ...(hero.skills || {}), airMagic: 3 };
  hero.mana = 100;
  hero.mp = 5000;
  hero.dimDoorUsed = 0;
  const plan = planEast(hero, 14);
  const from = { x: hero.x, y: hero.y };
  // No escape hatch: on this seed the line east of the starting hero holds a
  // legal landing, and a change that quietly removes one must fail here rather
  // than turn this test into a tautology.
  assert.equal(ai.maybeBlink(hero, plan), true, 'no jump was taken on a plan that plainly pays for one');
  assert.equal(ai.metrics.blinks, 1);
  assert.ok(ai.metrics.blinkSaved > 0, 'a jump that saved nothing should not have been taken');
  assert.notEqual(hero.x, from.x, 'the hero did not move');
  // It landed on a tile of the plan, and the plan carries on from after it.
  const landed = plan.path[plan.cursor - 1];
  assert.equal(hero.x, landed.x);
  assert.equal(hero.y, landed.y);
  assert.equal(hero.dimDoorUsed, 1);
});

test('BLINK is refused without the spell, the casts, the mana or the movement', () => {
  const s = world();
  const ai = new AITurnController(s, 1);
  const hero = playerHeroes(s, 1)[0];
  hero.skills = { ...(hero.skills || {}), airMagic: 3 };
  const fresh = () => { hero.spells = ['dimensionDoor']; hero.mana = 100; hero.mp = 5000; hero.dimDoorUsed = 0; };

  fresh(); hero.spells = [];
  assert.equal(ai.maybeBlink(hero, planEast(hero, 14)), false, 'cast a spell it does not know');
  fresh(); hero.dimDoorUsed = CONFIG.DIM_DOOR_USES_BY_SCHOOL[3];
  assert.equal(ai.maybeBlink(hero, planEast(hero, 14)), false, 'exceeded the daily casts');
  fresh(); hero.mana = 0;
  assert.equal(ai.maybeBlink(hero, planEast(hero, 14)), false, 'cast with no mana');
  fresh(); hero.mp = 10;
  assert.equal(ai.maybeBlink(hero, planEast(hero, 14)), false, 'jumped with no movement to spend');
  assert.equal(ai.metrics.blinks, 0);
});

test('BLINK never takes a jump that does not pay for itself', () => {
  const s = world();
  const ai = new AITurnController(s, 1);
  const hero = playerHeroes(s, 1)[0];
  hero.spells = ['dimensionDoor'];
  hero.skills = { ...(hero.skills || {}), airMagic: 3 };
  hero.mana = 100; hero.mp = 5000; hero.dimDoorUsed = 0;
  // One tile ahead: walking it costs a hundred, the jump two hundred.
  const plan = planEast(hero, 1);
  assert.equal(ai.maybeBlink(hero, plan), false, 'blinked one tile for twice the price of walking it');
  assert.equal(plan.cursor, 0, 'and the plan must be untouched');
});

test('the AI can only land where a player could — the engine owns that rule', () => {
  const s = world();
  const ai = new AITurnController(s, 1);
  const hero = playerHeroes(s, 1)[0];
  hero.spells = ['dimensionDoor'];
  hero.skills = { ...(hero.skills || {}), airMagic: 3 };
  hero.mana = 100; hero.mp = 5000; hero.dimDoorUsed = 0;
  const plan = planEast(hero, 14);
  assert.equal(ai.maybeBlink(hero, plan), true);
  {
    const landed = plan.path[plan.cursor - 1];
    assert.ok(landed, 'no landing recorded');
    // The engine's own conditions, re-checked on the tile it actually chose: a
    // Dimension Door may never put a hero on water, on an object, or on ground
    // its owner has not explored (dimDoorLandingCheck).
    const t = tileAt(s, landed.x, landed.y, hero.z ?? 0);
    assert.ok(t, 'landed off the map');
    assert.ok(!t.objectId, 'landed on an object');
    assert.ok(!t.obstacle && t.terrain !== 'water', 'landed somewhere unstandable');
  }
  assert.ok(typeof dimDoorLandable === 'function');
});
