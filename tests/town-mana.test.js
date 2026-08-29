/**
 * town-mana.test.js — a night under a Mage Guild refills the spell book.
 *
 * HoMM3's rule, and the one a player coming from that game most expects to
 * find: the guild is where the hero's spells came from, so sleeping beneath it
 * and waking still empty is the odd outcome. Before this, a hero who ended a
 * turn in their own capital woke with BASE_MANA_REGEN and nothing more — the
 * same trickle they would have had asleep in a field.
 *
 * What the tests below pin, in the order the risk actually sits:
 *   1. the refill happens, and it is FULL rather than a bonus trickle;
 *   2. it is the GUILD that does it, not merely being in a town;
 *   3. a hero in the field is untouched, so the field regen still means
 *      something and the choice "press on or ride home" is still a choice;
 *   4. the Magic Spring's over-max surplus survives the new line — the reason
 *      the dawn refresh uses max(current, …) in the first place, and the exact
 *      thing a naive `hero.mana = heroMaxMana(hero)` would have quietly eaten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { endTurn } from '../src/core/actions.js';
import { heroMaxMana } from '../src/core/heroUtils.js';

/** A hero parked in its own town, spell book nearly empty. */
function sleeping({ guild = true, inTown = true } = {}) {
  const s = newGame({ seed: 7, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const hero = playerHeroes(s, 0)[0];
  const town = playerTowns(s, 0)[0];
  town.buildings = town.buildings.filter((b) => !/^mageGuild/.test(b));
  if (guild) town.buildings.push('mageGuild1');
  if (inTown) {
    hero.x = town.x; hero.y = town.y;
    hero.inTownId = town.id;
    town.visitingHeroId = hero.id;
  }
  hero.mana = 1;
  return { s, hero, town };
}

/** Both players end their turn, so the calendar reaches a new dawn. */
const overnight = (s) => { endTurn(s); endTurn(s); };

test('a hero sleeping in a town with a Mage Guild wakes with full mana', () => {
  const { s, hero } = sleeping();
  const max = heroMaxMana(hero);
  overnight(s);
  assert.equal(hero.mana, max, 'the guild refills the pool, it does not top it up');
});

test('the same town WITHOUT a guild gives only the ordinary daily regen', () => {
  const { s, hero } = sleeping({ guild: false });
  const max = heroMaxMana(hero);
  overnight(s);
  assert.ok(hero.mana < max, 'no guild, no refill');
  assert.ok(hero.mana > 1, 'but the ordinary regen still runs');
});

test('a hero in the field is untouched by a guild it is not standing in', () => {
  const { s, hero, town } = sleeping({ inTown: false });
  assert.ok(town.buildings.some((b) => /^mageGuild/.test(b)), 'fixture: the town has a guild');
  const max = heroMaxMana(hero);
  overnight(s);
  assert.ok(hero.mana < max, 'the refill is a reason to ride home, not a free aura');
});

test('any guild tier does it — the level prices itself in what it teaches', () => {
  for (const tier of ['mageGuild1', 'mageGuild3', 'mageGuild5']) {
    const { s, hero, town } = sleeping({ guild: false });
    town.buildings.push(tier);
    const max = heroMaxMana(hero);
    overnight(s);
    assert.equal(hero.mana, max, `${tier} should refill`);
  }
});

test('a Magic Spring surplus above the cap is not eaten by the guild refill', () => {
  // The dawn refresh deliberately uses max(current, …) so an over-max pool
  // survives; a bare assignment here would have clipped it back on the very
  // next dawn, before it bought a single useful day.
  const { s, hero } = sleeping();
  const max = heroMaxMana(hero);
  hero.mana = max * 2;
  overnight(s);
  assert.equal(hero.mana, max * 2, 'the surplus rides through the night intact');
});
