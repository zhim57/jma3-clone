/**
 * balance-of-power.test.js — #9 (opt-in): rivals league against a runaway.
 *
 * Pure-logic coverage of the two exported helpers that drive the AI's coalition
 * bias: militaryStandings (world military share, by TEAM, treasury excluded) and
 * balanceOfPowerBias (null unless the feature is on AND a hegemon has emerged AND
 * the reader isn't the leader; otherwise a per-owner desirability multiplier).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREATURES } from '../src/data/creatures.js';

import { CONFIG } from '../src/config.js';
import { militaryStandings, balanceOfPowerBias } from '../src/ai/AIPlayer.js';

// Armies expressed as pikeman counts. The pikeman's PRICE is read off the table
// rather than written here: this file transcribed "aiValue = 80" and the round
// numbers built on it, and a re-pricing then failed a test about SUMMING for
// having an out-of-date opinion of a pikeman.
const pikes = (n) => [{ creature: 'pikeman', count: n }];
const PIKE = CREATURES.pikeman.aiValue;

// 3 teams (players 0,1,2 on teams 0,1,2). `mil` gives each player's pikeman count
// (heroes) and `gar` a town garrison; `features`/`defeated` optional.
function state({ mil = [40, 6, 6], gar = [0, 0, 0], features = { balanceOfPower: true }, defeated = [] }) {
  return {
    features,
    players: [0, 1, 2].map((i) => ({ index: i, team: i, defeated: defeated.includes(i) })),
    heroes: Object.fromEntries(mil.map((n, i) => [`H${i}`, { owner: i, army: pikes(n) }])),
    towns: Object.fromEntries(gar.map((n, i) => [`T${i}`, { owner: i, garrison: pikes(n) }])),
  };
}

test('militaryStandings: sums heroes + garrisons by team, treasury-free', () => {
  const st = militaryStandings(state({ mil: [40, 6, 6], gar: [10, 0, 0] }));
  // team 0: (40+10)*80 = 4000; teams 1,2: 6*80 = 480 each. total 4960.
  assert.equal(st.byTeam.get(0), 50 * PIKE);
  assert.equal(st.byTeam.get(1), 6 * PIKE);
  assert.equal(st.total, 62 * PIKE);
  assert.equal(st.leaderTeam, 0);
  assert.ok(Math.abs(st.leaderShare - 50 / 62) < 1e-9);
});

test('militaryStandings: defeated players contribute nothing; empty board is leaderless', () => {
  const st = militaryStandings(state({ mil: [40, 6, 6], defeated: [0] }));
  assert.equal(st.byTeam.has(0), false);
  assert.equal(st.leaderTeam, 1); // team 0 removed → next-strongest leads

  const empty = militaryStandings({ players: [], heroes: {}, towns: {} });
  assert.equal(empty.leaderTeam, -1);
  assert.equal(empty.leaderShare, 0);
});

test('bias: null when the feature is off, even with a clear hegemon', () => {
  assert.equal(balanceOfPowerBias(state({ features: {} }), 1), null);
  assert.equal(balanceOfPowerBias(state({ features: { balanceOfPower: false } }), 1), null);
});

test('bias: null when no hegemon has emerged (balanced board)', () => {
  const st = state({ mil: [10, 10, 10] }); // each team 1/3 < 0.45
  assert.equal(balanceOfPowerBias(st, 1), null);
});

test('bias: a trailing team covets the hegemon and eases off other rivals', () => {
  const st = state({ mil: [40, 6, 6] }); // team 0 ≈ 0.77 share ≥ 0.45
  const bias = balanceOfPowerBias(st, 1); // player 1 trails
  assert.equal(typeof bias, 'function');
  assert.equal(bias(0), CONFIG.BOP_LEADER_BIAS); // covet the leader (player 0 / team 0)
  assert.equal(bias(2), CONFIG.BOP_TRUCE_DAMP);  // ease off the other rival
  assert.ok(CONFIG.BOP_LEADER_BIAS > 1 && CONFIG.BOP_TRUCE_DAMP < 1);
});

test('bias: the leader itself gets no coalition bias (it plays normally)', () => {
  const st = state({ mil: [40, 6, 6] });
  assert.equal(balanceOfPowerBias(st, 0), null); // player 0 is the hegemon
});

test('bias: the human (team 0) leading makes the AIs league against the human', () => {
  // The player is conventionally player 0 / team 0; when they run away militarily,
  // a trailing AI (player 2) should covet the human's holdings.
  const st = state({ mil: [50, 5, 5] });
  const bias = balanceOfPowerBias(st, 2);
  assert.equal(bias(0), CONFIG.BOP_LEADER_BIAS); // the human's towns/heroes are coveted
});
