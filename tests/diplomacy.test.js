/**
 * diplomacy.test.js — #16 (opt-in): parley with a weak neutral instead of fighting.
 *
 * parleyOffer only offers a deal for a weak-enough stack (and only with the
 * feature on), prices it off a real predicted combat loss, and can be refused;
 * parley recruits the stack, pays the gold, and clears it from the map — fail-closed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { parleyOffer, parley } from '../src/core/actions.js';
import { CREATURES } from '../src/data/creatures.js';
import { armyValue } from '../src/core/heroUtils.js';

function setup(features, count = 400) {
  const s = newGame({ seed: 4242, features });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'pikeman', count, hurt: 0 }, null, null, null, null, null, null]; // 7 slots
  s.players[0].resources.gold = 1_000_000;
  const monsters = Object.values(s.map.objects).filter((o) => o.type === 'monster');
  const val = (m) => (CREATURES[m.creature]?.aiValue || 0) * m.count;
  return { s, hero, monsters, val };
}

test('parleyOffer: nothing is offered when the feature is off', () => {
  const { s, hero, monsters } = setup({});
  assert.ok(monsters.length, 'the map has neutral stacks');
  assert.equal(parleyOffer(s, hero, monsters[0]).offered, false);
});

test('parleyOffer: a weak-enough neutral is offered, priced off a real predicted loss', () => {
  const { s, hero, monsters, val } = setup({ diplomacy: true });
  const weakest = monsters.slice().sort((a, b) => val(a) - val(b))[0];
  const offer = parleyOffer(s, hero, weakest);
  assert.equal(offer.offered, true);
  assert.ok(offer.price > 0, 'a positive price');
  assert.equal(typeof offer.refused, 'boolean');
});

test('parleyOffer: a stack too strong relative to the hero will not bargain', () => {
  const { s, hero, monsters, val } = setup({ diplomacy: true });
  hero.army = [{ creature: 'pikeman', count: 1, hurt: 0 }]; // value 80
  const strongest = monsters.slice().sort((a, b) => val(b) - val(a))[0];
  assert.equal(parleyOffer(s, hero, strongest).offered, false);
});

test('parley: recruits the stack, pays the fee, and clears the tile', () => {
  const { s, hero, monsters } = setup({ diplomacy: true });
  // Find a stack that both offers AND does not refuse (deterministic per encounter).
  const target = monsters.map((m) => ({ m, o: parleyOffer(s, hero, m) })).find((x) => x.o.offered && !x.o.refused);
  assert.ok(target, 'found a parley-able, non-refusing stack');
  const goldBefore = s.players[0].resources.gold;
  const valBefore = armyValue(hero.army);
  const res = parley(s, hero, target.m);
  assert.equal(res.ok, true);
  assert.ok(s.players[0].resources.gold < goldBefore, 'the fee was paid');
  assert.ok(armyValue(hero.army) > valBefore, 'the stack joined the army');
  assert.ok(!s.map.objects[target.m.id], 'the neutral was removed from the map');
});

test('parley: fail-closed when the feature is off (no change)', () => {
  const { s, hero, monsters } = setup({});
  const before = s.players[0].resources.gold;
  const res = parley(s, hero, monsters[0]);
  assert.equal(res.ok, false);
  assert.equal(s.players[0].resources.gold, before, 'no gold spent');
  assert.ok(s.map.objects[monsters[0].id], 'the neutral is untouched');
});
