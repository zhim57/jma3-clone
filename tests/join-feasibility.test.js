/**
 * join-feasibility.test.js — the join warning stops lying, and a stack that
 * would join is not sized as a boss.
 *
 * Two failures reported together, and they are the same seam seen from both
 * ends:
 *
 *   The warning read "Will fight" unconditionally and was usually wrong. A stack
 *   that would have offered to join was labelled a fight, and a stack that masses
 *   against you on contact was quoted at its resting size — one player took that
 *   at its word and met 220 Monks for 52% of an army. A wrong warning is worse
 *   than none, because you cannot learn from it without paying a battle to test
 *   it. The fix is not a better warning: it is that the warning must call the
 *   SAME functions the encounter calls.
 *
 *   And the scaling had no feasibility gate. A stack standing there as a
 *   recruitment offer became a boss encounter the moment the offer could not be
 *   accepted — seven slots full, no matching stack, no gold — because the offer
 *   and the scaling never consulted each other.
 *
 * The feasibility check is the fourth instance of one defect class in this
 * project: an action offered on the strength of a reward the actor cannot
 * receive (see docs/DESIGN_DECISIONS.md). It has to happen where the offer is
 * MADE, because by the time it is taken up the player has already been quoted a
 * price and made a plan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, levelObjects } from '../src/core/GameState.js';
import { combatContext, parley } from '../src/core/actions.js';
import { parleyOffer, joinFeasible } from '../src/core/diplomacy.js';
import { armyValue } from '../src/core/heroUtils.js';

const SEED = 11;

function game() {
  const s = newGame({ seed: SEED });
  s.features = { ...(s.features || {}), diplomacy: true };
  return s;
}

const firstMonster = (s) => Object.values(levelObjects(s, 0)).find((o) => o.type === 'monster');
/**
 * The first stack that both offers AND does not refuse.
 *
 * These tests are about the FEASIBILITY seam — room in the army, gold in the
 * treasury, and whether the scaler sizes a standing offer as a fight. They are
 * not about how often a band refuses. That used to be the same thing, because
 * refusal was `ratio x SLOPE` and a hero's ratio against a starting stack is ~0,
 * so the first monster on the map always dealt. Diplomacy's flat
 * CONFIG.PARLEY_REFUSE_BASE ended that on purpose (an untrained hero is turned
 * down about 40% of the time), so the fixture has to ASK for a live offer rather
 * than assume the first stack is one.
 */
function dealableMonster(s, hero) {
  for (const o of Object.values(levelObjects(s, 0))) {
    if (o.type !== 'monster') continue;
    const offer = parleyOffer(s, hero, o);
    if (offer.offered && !offer.refused) return o;
  }
  throw new Error('no neutral stack on this map would deal at all');
}
const fullArmy = (creature) => [
  { creature: 'archangel', count: 30, hurt: 0 }, { creature: 'crusader', count: 40, hurt: 0 },
  { creature: 'marksman', count: 60, hurt: 0 }, { creature: 'cavalier', count: 20, hurt: 0 },
  { creature: 'monk', count: 30, hurt: 0 }, { creature: 'griffin', count: 25, hurt: 0 },
  { creature: creature === 'pikeman' ? 'swordsman' : 'pikeman', count: 50, hurt: 0 },
];

// ---------------------------------------------------------------------------

test('feasibility: seven full slots and no matching stack means no offer at all', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  const mon = firstMonster(s);
  hero.army = fullArmy(mon.creature);
  assert.equal(joinFeasible(hero, mon), false);

  const offer = parleyOffer(s, hero, mon);
  assert.equal(offer.offered, false, 'an offer the hero cannot take is not made');
  assert.equal(offer.reason, 'no room');

  // …and one free slot is all it takes.
  hero.army[6] = null;
  assert.equal(joinFeasible(hero, mon), true);
  assert.equal(parleyOffer(s, hero, mon).offered, true);
});

test('feasibility: a matching stack is room, even with every slot occupied', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  const mon = firstMonster(s);
  hero.army = fullArmy(mon.creature);
  hero.army[6] = { creature: mon.creature, count: 3, hurt: 0 };

  assert.equal(joinFeasible(hero, mon), true, 'they merge into their own kind');
  assert.equal(parleyOffer(s, hero, mon).offered, true);
});

test('feasibility: an offer the treasury cannot cover is offered but not acceptable', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  const mon = dealableMonster(s, hero);
  const priced = parleyOffer(s, hero, mon);
  assert.ok(priced.offered && priced.price > 0);

  s.players[0].resources.gold = priced.price - 1;
  const poor = parleyOffer(s, hero, mon);
  assert.equal(poor.offered, true, 'they would still deal');
  assert.equal(poor.acceptable, false, 'but the hero cannot close it');

  s.players[0].resources.gold = priced.price;
  assert.equal(parleyOffer(s, hero, mon).acceptable, true);
});

test('scaling: a stack with a live, acceptable offer is not sized as a fight', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = 10 ** 6;
  const mon = dealableMonster(s, hero);
  const offer = parleyOffer(s, hero, mon);
  assert.ok(offer.acceptable, 'the offer stands');

  const ctx = combatContext(s, hero, { kind: 'monster', objectId: mon.id });

  assert.equal(ctx.joinOffered, true);
  assert.ok(!ctx.tideScaled, 'a recruitment offer is not massed against you');
  assert.equal(ctx.defenderArmy[0].count, mon.count,
    'what you were shown is what you would meet');
});

test('scaling: the same stack IS sized as a fight once the offer cannot be accepted', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  const mon = firstMonster(s);
  // Give the hero an army big enough that the stack is a walkover (so the tide
  // floor has work to do) and no room at all for the creatures on offer.
  hero.army = fullArmy(mon.creature);
  assert.equal(parleyOffer(s, hero, mon).offered, false);

  const ctx = combatContext(s, hero, { kind: 'monster', objectId: mon.id });

  assert.ok(!ctx.joinOffered);
  assert.ok(ctx.tideScaled, 'no offer means it is a fight, and it is sized like one');
  assert.ok(ctx.defenderArmy[0].count > mon.count);
});

test('the warning and the encounter now read the same numbers', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = 10 ** 6;
  const mon = dealableMonster(s, hero);

  // What a warning would say (both engine calls), and what the encounter does.
  const offer = parleyOffer(s, hero, mon);
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: mon.id });
  const shown = (ctx.defenderArmy || []).reduce((n, st) => n + (st ? st.count : 0), 0);

  const before = armyValue(hero.army);
  const res = parley(s, hero, mon);
  assert.equal(res.ok, true, 'the offer the warning quoted can actually be taken');
  assert.equal(res.price, offer.price, 'at the price it quoted');
  assert.equal(res.count, shown, 'for the stack it showed');
  assert.ok(armyValue(hero.army) > before, 'and the hero is stronger for it');
});

test('every realized multiplier is recorded, with whether an offer stood', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  s.players[0].resources.gold = 10 ** 6;
  const monsters = Object.values(levelObjects(s, 0)).filter((o) => o.type === 'monster').slice(0, 6);
  for (const m of monsters) combatContext(s, hero, { kind: 'monster', objectId: m.id });

  const log = s.pveScaleLog || [];
  assert.equal(log.length, monsters.length, 'one sample per encounter priced');
  assert.ok(log.every((e) => typeof e.mult === 'number' && typeof e.joinOffered === 'boolean'));
  // The question the brief asked has to be answerable from this: do the big
  // multipliers only ever land on stacks nobody could have recruited?
  assert.ok(log.filter((e) => e.joinOffered).every((e) => e.mult === 1),
    'a stack that would join is never multiplied at all');
});
