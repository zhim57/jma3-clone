/**
 * hover-preview.test.js — a hover must READ the world, never WRITE it.
 *
 * The defect this pins (audit C1, critical): AdventureScene's monster hover
 * card calls the engine's own encounter functions — deliberately, so the card
 * can never disagree with the fight (see the comment in objectCardData). But
 * combatContext is an ACTION: its tail applies the Tide of War effects, and
 * tideDivineIntervention draws from the seeded gameplay RNG and writes
 * creatures into the hero's army. Reproduced before the fix: one hover under
 * the tideOfWar pacing took a 1-peasant hero to 2 free Archangels with a
 * "Divine intervention!" log line, and advanced state.rng — so two players on
 * the same seed diverged based on where they moved the pointer. Under the
 * DEFAULT classic pacing the gift and the draw do not fire, but every hover
 * still appended a row to pveScaleLog, poisoning the instrument that is
 * supposed to record actual encounters.
 *
 * The seam is combatContext's `{ preview: true }`: identical numbers (the
 * scaling is deterministic and ctx-local), zero writes. These tests are the
 * contract — if a future tide effect forgets the flag, they go red.
 *
 * The same purity rule covers the second reporting surface: adventureTelemetry
 * runs the AI's goal scorer on the HUMAN's seat for every move order, and the
 * plain controller's pickGoal wrote hero.aiGoal / aiGoalMemory onto the human's
 * hero and pushed rows into state.aiLog — despite that module's own doc
 * promising purity. The observer controller suppresses every write while
 * keeping the scoring identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { combatContext } from '../src/core/actions.js';
import { recordHumanMove } from '../src/ai/adventureTelemetry.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const PLAYERS = [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
];

/** A game plus a lopsided monster encounter — the shape the divine
 *  intervention (#9) exists to rescue, i.e. the shape that mutated on hover. */
function encounter(pacing, { underdog = true } = {}) {
  const s = newGame({ seed: 4242, pacing, players: PLAYERS.map((p) => ({ ...p })) });
  const hero = playerHeroes(s, 0)[0];
  const monster = Object.values(s.map.objects).find((o) => o.type === 'monster');
  if (underdog) {
    monster.count = 400;
    hero.army = [{ creature: 'peasant', count: 1, hurt: 0 }];
  } else {
    monster.count = 3;
    hero.army = [{ creature: 'archangel', count: 40, hurt: 0 }];
  }
  return { s, hero, monster };
}

const snapshot = (s, hero) => JSON.stringify({
  rng: s.rng.toJSON(),
  army: hero.army,
  log: s.log.length,
  scaleLog: (s.pveScaleLog || []).length,
});

for (const pacing of ['tideOfWar', 'classic']) {
  test(`preview combatContext is pure under ${pacing}: no rng, no gift, no log, no pveScaleLog row`, () => {
    const { s, hero, monster } = encounter(pacing);
    const before = snapshot(s, hero);
    for (let i = 0; i < 50; i++) {
      combatContext(s, hero, { kind: 'monster', objectId: monster.id }, { preview: true });
    }
    assert.equal(snapshot(s, hero), before,
      '50 hovers changed nothing — not the rng stream, the army, the log, or the scale instrument');
  });
}

test('the preview tells the truth: same scaled defender the real encounter builds', () => {
  // A walkover for a strong hero, so tideScaleDefender actually inflates it.
  const { s, hero, monster } = encounter('tideOfWar', { underdog: false });
  const massed = (c) => (c.defenderArmy || []).reduce((n, st) => n + (st ? st.count : 0), 0);
  const prev = combatContext(s, hero, { kind: 'monster', objectId: monster.id }, { preview: true });
  const real = combatContext(s, hero, { kind: 'monster', objectId: monster.id });
  assert.ok(prev.tideScaled, 'the walkover was scaled up in the preview');
  assert.ok(massed(prev) > monster.count, 'to more than its resting size');
  assert.equal(massed(prev), massed(real), 'and the card quotes exactly the army the hero would meet');
  assert.equal((s.pveScaleLog || []).length, 1, 'only the REAL encounter reached the instrument');
});

test('hovering does not perturb the encounter: fight-after-50-hovers === fight', () => {
  const run = (hovers) => {
    const { s, hero, monster } = encounter('tideOfWar');
    for (let i = 0; i < hovers; i++) {
      combatContext(s, hero, { kind: 'monster', objectId: monster.id }, { preview: true });
    }
    const ctx = combatContext(s, hero, { kind: 'monster', objectId: monster.id });
    return { rng: JSON.stringify(s.rng.toJSON()), army: JSON.stringify(hero.army), gift: ctx.divineGift || null };
  };
  const clean = run(0);
  const hovered = run(50);
  assert.equal(hovered.rng, clean.rng, 'the seeded stream is byte-identical');
  assert.equal(hovered.army, clean.army, 'the army (gift included, if it fired) is byte-identical');
  assert.deepEqual(hovered.gift, clean.gift, 'the intervention itself is untouched');
});

test('the preview carries the parley offer, so the card never re-simulates the fight', () => {
  const { s, hero, monster } = encounter('classic');
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: monster.id }, { preview: true });
  // Whatever the offer says (it depends on the matchup), it must be PRESENT —
  // objectCardData reads ctx.parleyOffer instead of paying predictedFightLoss
  // a second time per pointermove.
  assert.ok(ctx.parleyOffer, 'the offer priced inside tideScaleDefender rides out on the context');
  assert.equal(typeof ctx.parleyOffer.offered, 'boolean');
});

test('recordHumanMove observes without branding the hero or spamming the aiLog', () => {
  const s = newGame({ seed: 777, players: PLAYERS.map((p) => ({ ...p })) });
  const hero = playerHeroes(s, 0)[0];
  const rng0 = JSON.stringify(s.rng.toJSON());
  const aiLog0 = (s.aiLog || []).length;

  const row = recordHumanMove(s, hero, hero.x + 2, hero.y, {});

  assert.ok(row, 'the telemetry row itself is still recorded');
  assert.ok(Array.isArray(row.candidates), 'with the candidate ranking it exists for');
  assert.equal(hero.aiGoal, undefined, 'the HUMAN hero carries no AI goal');
  assert.equal(hero.aiGoalMemory, undefined, 'no goal memory');
  assert.equal(hero.aiGoalBans, undefined, 'no goal bans');
  assert.equal((s.aiLog || []).length, aiLog0, 'no goal-change row in the shared aiLog');
  assert.equal(JSON.stringify(s.rng.toJSON()), rng0, 'and no seeded draw');
});

test('an observer controller answers as a pure function of the board', () => {
  // Two observers over the same position rank identically — nothing the first
  // one did (or a stale hero.aiGoal from an old save) feeds back into the
  // second. commitGoal's incumbent defence is deliberately bypassed.
  const s = newGame({ seed: 777, players: PLAYERS.map((p) => ({ ...p })) });
  const hero = playerHeroes(s, 0)[0];
  hero.aiGoal = { key: 'stale|X', type: 'stale', score: 10 ** 9, committedDay: 0 }; // old-save shape
  const ask = () => {
    const ai = new AITurnController(s, hero.owner, { observer: true });
    ai.mainHeroId = hero.id;
    const reach = ai.floodCached ? ai.floodCached(hero.x, hero.y, hero.z ?? 0, false) : null;
    const chosen = ai.pickGoal(hero, reach);
    return { chosen, goals: JSON.stringify(ai._lastGoals) };
  };
  const a = ask();
  const b = ask();
  assert.equal(a.goals, b.goals, 'same board, same ranking');
  assert.notEqual(a.chosen?.key, 'stale|X', 'a stale incumbent cannot win through an observer');
  assert.equal(hero.aiGoal.key, 'stale|X', 'and the stale goal was not touched either');
});
