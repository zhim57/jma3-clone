/**
 * week-events.test.js — "Week of the ..." weekly events.
 *
 * Each new week rolls a deterministic event off state.rng: mostly plain flavour
 * weeks, sometimes a "Week of the <creature>" (that creature's weekly growth is
 * boosted in every town) or a "Week of the Plague" (all growth reduced). Covers
 * the roll's determinism/shape, the growth formula, the end-to-end wiring
 * through advanceDay, and save round-tripping. Pure rule-engine — no Phaser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES, creaturesOfTier } from '../src/data/creatures.js';
import { newGame, playerTowns, serialize, deserialize } from '../src/core/GameState.js';
import {
  endTurn, rollWeekEvent, weeklyCreatureGrowth, weekEventMessage,
} from '../src/core/actions.js';

test('rollWeekEvent is deterministic and always names a valid event', () => {
  const a = newGame({ seed: 7 });
  const b = newGame({ seed: 7 });
  for (let i = 0; i < 25; i++) {
    const ea = rollWeekEvent(a);
    const eb = rollWeekEvent(b);
    assert.deepEqual(ea, eb, 'same seed → identical event stream');
    assert.ok(['creature', 'plague', 'plain'].includes(ea.kind), 'known kind');
    assert.equal(a.weekEvent, ea, 'stored on state');
    if (ea.kind === 'creature') {
      assert.ok(CREATURES[ea.creature], 'names a real creature');
      assert.ok(!CREATURES[ea.creature].upgraded, 'names a BASE (non-upgraded) creature');
      assert.ok(CREATURES[ea.creature].growth > 0,
        'names a creature with real growth — no dead war-machine / growth-0 weeks (E36)');
      assert.equal(ea.name, CREATURES[ea.creature].name);
    }
  }
});

test('rollWeekEvent produces plain, creature and plague weeks over time', () => {
  const s = newGame({ seed: 42 });
  const kinds = new Set();
  for (let i = 0; i < 300; i++) kinds.add(rollWeekEvent(s).kind);
  assert.ok(kinds.has('plain'), 'some plain weeks');
  assert.ok(kinds.has('creature'), 'some creature weeks');
  assert.ok(kinds.has('plague'), 'some plague weeks');
});

test('weeklyCreatureGrowth: a Week of the X doubles + bonuses the matching creature', () => {
  const g = CREATURES.pikeman.growth;
  const ev = { kind: 'creature', creature: 'pikeman', name: 'Pikeman' };
  // The named creature: base×fort, then ×mult, then +flat bonus.
  assert.equal(
    weeklyCreatureGrowth(g, 1, ev, 'pikeman'),
    Math.floor(g * CONFIG.WEEK_CREATURE_MULT) + CONFIG.WEEK_CREATURE_BONUS,
  );
  // The fort multiplier stacks underneath the creature multiplier.
  assert.equal(
    weeklyCreatureGrowth(g, CONFIG.GROWTH_CASTLE_MULT, ev, 'pikeman'),
    Math.floor(Math.floor(g * CONFIG.GROWTH_CASTLE_MULT) * CONFIG.WEEK_CREATURE_MULT)
      + CONFIG.WEEK_CREATURE_BONUS,
  );
  // A different creature is untouched by that week.
  const ag = CREATURES.archer.growth;
  assert.equal(weeklyCreatureGrowth(ag, 1, ev, 'archer'), ag);
});

test('weeklyCreatureGrowth: plague halves everything; plain/null are just base×fort', () => {
  const g = CREATURES.pikeman.growth;
  const plague = { kind: 'plague', name: 'Plague' };
  assert.equal(weeklyCreatureGrowth(g, 1, plague, 'pikeman'), Math.floor(g * CONFIG.WEEK_PLAGUE_MULT));
  assert.equal(
    weeklyCreatureGrowth(g, CONFIG.GROWTH_CASTLE_MULT, plague, 'pikeman'),
    Math.floor(Math.floor(g * CONFIG.GROWTH_CASTLE_MULT) * CONFIG.WEEK_PLAGUE_MULT),
  );
  assert.equal(weeklyCreatureGrowth(g, 1, { kind: 'plain', name: 'Fox' }, 'pikeman'), g);
  assert.equal(weeklyCreatureGrowth(g, 1, null, 'pikeman'), g, 'no event = plain growth');
});

test('advanceDay wires a forced Week of the <creature> into real town growth + the log', () => {
  const s = newGame({ seed: 3 });
  const town = playerTowns(s, 0)[0];
  const { base } = creaturesOfTier(town.faction, 1); // tier-1 dwelling is pre-built
  let fortMult = 1;
  if (town.buildings.includes('castle')) fortMult = CONFIG.GROWTH_CASTLE_MULT;
  else if (town.buildings.includes('citadel')) fortMult = CONFIG.GROWTH_CITADEL_MULT;

  // Advance to the last day of week 1 (day 7), one endTurn short of the rollover.
  for (let i = 0; i < 2 * (CONFIG.DAYS_PER_WEEK - 1) + 1; i++) endTurn(s);
  const before = town.available[1];

  // Pin the coming roll to a "Week of the <tier-1 creature>". advanceDay draws
  // from state.rng exactly once (random) then once (pick), before any growth.
  s.rng = { random: () => 0.2, pick: (arr) => (arr.includes(base) ? base : arr[0]) };
  endTurn(s); // triggers the week rollover

  assert.equal(s.weekEvent.kind, 'creature');
  assert.equal(s.weekEvent.creature, base);
  const delta = town.available[1] - before;
  const plain = Math.floor((CREATURES[base].growth || 0) * fortMult);
  assert.ok(delta > plain, 'the creature week grew more than a plain week would');
  assert.equal(delta, weeklyCreatureGrowth(CREATURES[base].growth, fortMult, s.weekEvent, base));
  assert.ok(s.log.some((m) => (m.text || m).includes(`Week of the ${s.weekEvent.name}`)), 'announced in the log');
});

test('week event round-trips through save/load', () => {
  const s = newGame({ seed: 9 });
  rollWeekEvent(s);
  const restored = deserialize(serialize(s));
  assert.deepEqual(restored.weekEvent, s.weekEvent);
});

test('weekEventMessage describes each kind (and empty for none)', () => {
  assert.match(weekEventMessage({ kind: 'creature', name: 'Angel', week: 3 }), /Week of the Angel/);
  assert.match(weekEventMessage({ kind: 'plague', week: 3 }), /Plague/);
  assert.match(weekEventMessage({ kind: 'plain', name: 'Fox', week: 3 }), /Fox/);
  assert.equal(weekEventMessage(null), '');
});
