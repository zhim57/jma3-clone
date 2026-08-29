/**
 * ai-memory.test.js — what the game remembers about how you actually play.
 *
 * v1 tracks how often the human MASS-DISABLES (Blind) and spreads stacks out in
 * response, so the "Blind one stack, delete the army" trick decays. v2/v3 move the
 * AI's engagement ratio and its trust in its own odds. The section at the FOOT of
 * this file covers the two later lessons: the disable rule reaching the wildlife
 * rather than only the AI's commanders, and the PvE sizer being graded on what its
 * fights actually cost.
 *
 * The assertions that matter throughout are the BOUNDS and the FORGETTING: a memory
 * that cannot forget, cannot be bounded, or chases its own corrections is worse
 * than no memory at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, serialize, deserialize } from '../src/core/GameState.js';
import {
  recordHumanBattleMemory, aiLearnedSplitParts, aiCourageMult, aiStanceOddsBias,
  pveSplitParts, recordTideOutcome, tideBias,
} from '../src/core/aiMemory.js';
import { playerHeroes, levelObjects } from '../src/core/GameState.js';
import { combatContext } from '../src/core/actions.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { tideTargetLoss } from '../src/core/pacing.js';
import { Rng } from '../src/core/rng.js';
import { chooseAIStances } from '../src/core/combat/CombatAI.js';

// A battle result with a roster + survivors, from the AI's perspective (AI = the
// non-human side). `aiSide` army starts at 100 champions; `end` survivors set the
// loss fraction; `won` sets who took the field. Human is side 0 here, AI side 1.
function ratioResult({ won, aiEnd }) {
  const CH = { creature: 'champion' };
  return {
    humanSide: 0, attackerWon: won ? false : true, // AI is defender (side 1)
    roster: [
      { side: 0, creature: 'champion', startCount: 100 }, // human
      { side: 1, creature: 'champion', startCount: 100 }, // AI
    ],
    attackerArmy: won ? [] : [{ ...CH, count: 100 }],       // human survivors
    defenderArmy: won ? [{ ...CH, count: aiEnd }] : [],     // AI survivors
    events: [],
  };
}

// A battle result as applyCombatResult sees it: humanSide + the event stream.
const blindResult = (humanSide = 0) => ({
  humanSide, attackerWon: true,
  events: [{ type: 'spellEffect', spellId: 'blind', casterSide: humanSide, hostile: true, targetId: 'u1_0' }],
});
const cleanResult = (humanSide = 0) => ({
  humanSide, attackerWon: true,
  events: [{ type: 'spellHit', spellId: 'lightningBolt', casterSide: humanSide, targetId: 'u1_0' }],
});

test('newGame seeds an empty AI memory that round-trips', () => {
  const s = newGame({ seed: 1 });
  assert.deepEqual(s.aiMemory, { disableRate: 0, battles: 0, courageMult: 1 });
  const back = deserialize(serialize(s));
  assert.equal(back.aiMemory.disableRate, 0);
});

test('a fresh AI splits at the baseline', () => {
  assert.equal(aiLearnedSplitParts(newGame({ seed: 1 })), CONFIG.AI_SPLIT_PARTS_DEFAULT);
  assert.equal(aiLearnedSplitParts(null), CONFIG.AI_SPLIT_PARTS_DEFAULT, 'defensive: no state ⇒ baseline');
});

test('leaning on Blind teaches the AI to split HARDER, up to the max', () => {
  const s = newGame({ seed: 1 });
  const before = aiLearnedSplitParts(s);
  for (let i = 0; i < 6; i++) recordHumanBattleMemory(s, blindResult());
  const after = aiLearnedSplitParts(s);
  assert.ok(after > before, 'the AI fragments more after repeated blinding');
  assert.equal(after, CONFIG.AI_SPLIT_PARTS_MAX, 'sustained blinding drives it to the max');
});

test('the memory FORGETS — clean battles decay the split back down', () => {
  const s = newGame({ seed: 1 });
  for (let i = 0; i < 6; i++) recordHumanBattleMemory(s, blindResult());
  assert.equal(aiLearnedSplitParts(s), CONFIG.AI_SPLIT_PARTS_MAX);
  for (let i = 0; i < 10; i++) recordHumanBattleMemory(s, cleanResult());
  assert.equal(aiLearnedSplitParts(s), CONFIG.AI_SPLIT_PARTS_DEFAULT, 'stop blinding and it relaxes again');
});

test('AI-vs-AI battles (no human seat) never touch the memory', () => {
  const s = newGame({ seed: 1 });
  recordHumanBattleMemory(s, { humanSide: -1, events: [] });
  recordHumanBattleMemory(s, { events: [] }); // no humanSide at all
  assert.equal(s.aiMemory.battles, 0, 'only human-fought battles are recorded');
});

test('a non-disable spell does not count as a mass-disable', () => {
  const s = newGame({ seed: 1 });
  recordHumanBattleMemory(s, cleanResult());
  assert.equal(s.aiMemory.disableRate, 0, 'Lightning Bolt is damage, not a disable');
  assert.equal(s.aiMemory.battles, 1, 'but the battle still counts');
});

// ---- Sun Tzu: learned engagement ratio (courageMult) ----------------------

test('a fresh AI demands the baseline ratio (mult 1)', () => {
  assert.equal(aiCourageMult(newGame({ seed: 1 })), 1);
  assert.equal(aiCourageMult(null), 1, 'defensive');
});

test('losing makes the AI demand MORE overkill next time, escalating', () => {
  const s = newGame({ seed: 1 });
  recordHumanBattleMemory(s, ratioResult({ won: false }));
  const once = aiCourageMult(s);
  assert.ok(once > 1, 'one loss raises the demanded ratio');
  recordHumanBattleMemory(s, ratioResult({ won: false }));
  assert.ok(aiCourageMult(s) > once, 'a second loss escalates it further (1.3 → 1.8 → …)');
});

test('the escalation is capped so the AI never demands the impossible', () => {
  const s = newGame({ seed: 1 });
  for (let i = 0; i < 20; i++) recordHumanBattleMemory(s, ratioResult({ won: false }));
  assert.equal(aiCourageMult(s), CONFIG.AI_COURAGE_MULT_MAX, 'clamped at the max');
});

test('a PYRRHIC win (bled heavily) still nudges the demand up — winning at 1:1 is bad', () => {
  const s = newGame({ seed: 1 });
  recordHumanBattleMemory(s, ratioResult({ won: true, aiEnd: 40 })); // lost 60% of the army
  assert.ok(aiCourageMult(s) > 1, 'a costly victory teaches: bring more force');
});

test('CHEAP wins relax the demand back toward the baseline (gravitate to what works)', () => {
  const s = newGame({ seed: 1 });
  for (let i = 0; i < 5; i++) recordHumanBattleMemory(s, ratioResult({ won: false })); // escalate
  assert.ok(aiCourageMult(s) > 1.5);
  for (let i = 0; i < 30; i++) recordHumanBattleMemory(s, ratioResult({ won: true, aiEnd: 95 })); // clean wins
  assert.equal(aiCourageMult(s), 1, 'sustained cheap wins settle it back to the baseline');
});

test('courageMult round-trips through a save', () => {
  const s = newGame({ seed: 1 });
  recordHumanBattleMemory(s, ratioResult({ won: false }));
  const mult = s.aiMemory.courageMult;
  assert.ok(mult > 1);
  assert.equal(deserialize(serialize(s)).aiMemory.courageMult, mult);
});

// ---- Learning v3: odds distrust (courageMult → stance winBias) -------------

test('aiStanceOddsBias: a fresh (or absent) memory trusts its odds fully', () => {
  assert.equal(aiStanceOddsBias(newGame({ seed: 1 })), 1);
  assert.equal(aiStanceOddsBias(null), 1, 'defensive: no state ⇒ no shading');
});

test('aiStanceOddsBias: losses erode trust, monotonically, floored at 1/√max', () => {
  const s = newGame({ seed: 1 });
  let prev = aiStanceOddsBias(s);
  for (let i = 0; i < 12; i++) {
    recordHumanBattleMemory(s, ratioResult({ won: false }));
    const b = aiStanceOddsBias(s);
    assert.ok(b <= prev, 'each loss can only deepen the distrust');
    prev = b;
  }
  assert.equal(prev, 1 / Math.sqrt(CONFIG.AI_COURAGE_MULT_MAX), 'bottoms out at 1/√cap');
});

test('a repeatedly beaten AI stops trusting a contested favorite and drops hold', () => {
  // 13-v-10 pikemen: a fresh AI reads a clear favorite and locks in 'hold'
  // (see ai-stance.test.js). After the human has beaten it into full courage
  // escalation, the same fight reads contested at best — no more 'hold'.
  const s = newGame({ seed: 1 });
  for (let i = 0; i < 20; i++) recordHumanBattleMemory(s, ratioResult({ won: false }));
  const cfg = {
    terrain: 'grass',
    attacker: { hero: null, army: [{ creature: 'pikeman', count: 13 }], playerIndex: 1 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 10 }], playerIndex: 0 },
  };
  assert.equal(chooseAIStances(cfg).attacker, 'hold', 'fresh memory: clear favorite holds');
  const shaded = chooseAIStances(cfg, { winBias: aiStanceOddsBias(s) });
  assert.notEqual(shaded.attacker, 'hold', 'a burned AI no longer trusts those odds');
});

// ===========================================================================
// The disable lesson reaches the WILDLIFE
// ===========================================================================

// THE CASE THE REQUEST ACTUALLY NAMED. "A ronin with one stack keeps it as one
// stack — I cast blind repeatedly and strike unretaliated; next time it should have
// several stacks." The deploy rule (CONFIG.PVE_STACK_SPLIT) already stopped it
// being ONE stack. This is what makes it spread FURTHER the more the trick is used,
// which is the difference between a fixed counter and a game that learns.
test('the disable lesson reaches the wildlife, not just the AI\'s own commanders', () => {
  const s = newGame({ seed: 5, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const me = playerHeroes(s, 0)[0];
  const wild = Object.values(levelObjects(s, 0)).find((o) => o.type === 'monster' && !o.guards);
  wild.count = 900;

  const hexesUsed = () => {
    const ctx = combatContext(s, me, { kind: 'monster', objectId: wild.id });
    const b = createBattle({
      rng: new Rng(7), terrain: 'grass', simulated: true,
      attacker: { hero: me, army: me.army.filter(Boolean), playerIndex: 0 },
      defender: { hero: null, army: ctx.defenderArmy, playerIndex: -1 },
      humanSide: 0, pveSplitParts: pveSplitParts(s),
    });
    return b.units.filter((u) => u.side === 1 && u.alive).length;
  };

  const before = hexesUsed();
  assert.equal(before, CONFIG.PVE_SPLIT_PARTS, 'a wild band starts on the rule\'s own baseline');
  for (let i = 0; i < 5; i++) recordHumanBattleMemory(s, blindResult());
  const after = hexesUsed();
  assert.ok(after > before, `the same band now spreads wider (${before} -> ${after})`);
  assert.equal(after, CONFIG.AI_SPLIT_PARTS_MAX);
});

test('the wildlife never manoeuvres WORSE than the rule, however peaceful you are', () => {
  const s = newGame({ seed: 5 });
  for (let i = 0; i < 20; i++) recordHumanBattleMemory(s, cleanResult());
  assert.ok(pveSplitParts(s) >= CONFIG.PVE_SPLIT_PARTS,
    'CONFIG.PVE_SPLIT_PARTS is a floor, not a starting point');
});

// ===========================================================================
// The sizer is graded on what its fights actually cost
// ===========================================================================

const TARGET = () => tideTargetLoss(CONFIG.TIDE_HARDNESS_DEFAULT);

test('a player who keeps winning cheap gets a world that presses back — bounded', () => {
  const s = newGame({ seed: 5 });
  assert.equal(tideBias(s), 1, 'a fresh memory corrects nothing');
  for (let i = 0; i < 30; i++) recordTideOutcome(s, { target: TARGET(), realised: 0.02 });
  assert.equal(tideBias(s), CONFIG.TIDE_BIAS_MAX,
    'thirty walkovers reach the ceiling and stop there — never past it');
});

test('…and one being mauled gets relief, also bounded', () => {
  const s = newGame({ seed: 5 });
  for (let i = 0; i < 30; i++) recordTideOutcome(s, { target: TARGET(), realised: 0.9 });
  assert.equal(tideBias(s), CONFIG.TIDE_BIAS_MIN);
});

test('escalation is EARNED and mercy is prompt — the rates are asymmetric on purpose', () => {
  const steps = (realised) => {
    const s = newGame({ seed: 5 });
    const stop = realised < TARGET() ? CONFIG.TIDE_BIAS_MAX : CONFIG.TIDE_BIAS_MIN;
    let n = 0;
    while (tideBias(s) !== stop && n < 50) { recordTideOutcome(s, { target: TARGET(), realised }); n++; }
    return n;
  };
  const toPress = steps(0.02);
  const toEase = steps(0.9);
  assert.ok(toEase < toPress,
    `relief arrives sooner than escalation (${toEase} fights vs ${toPress})`);
});

test('a realised cost that MATCHES the dial is a fixed point — it stops correcting', () => {
  const s = newGame({ seed: 5 });
  for (let i = 0; i < 4; i++) recordTideOutcome(s, { target: TARGET(), realised: 0.02 });
  const settled = tideBias(s);
  assert.ok(settled > 1, 'fixture: it had learned something to hold');
  for (let i = 0; i < 10; i++) recordTideOutcome(s, { target: TARGET(), realised: TARGET() });
  assert.equal(tideBias(s), settled,
    'once the outcome lands on the difficulty you chose, the correction holds still');
});

test('a free win cannot peg the correction — the ratio is clamped before it is used', () => {
  const s = newGame({ seed: 5 });
  recordTideOutcome(s, { target: TARGET(), realised: 0 }); // an infinite correction, naively
  assert.ok(Number.isFinite(tideBias(s)));
  assert.ok(tideBias(s) < CONFIG.TIDE_BIAS_MAX,
    'one walkover moves it, but nowhere near the ceiling');
});

test('nonsense is ignored rather than banked', () => {
  const s = newGame({ seed: 5 });
  const before = tideBias(s);
  recordTideOutcome(s, { target: 0, realised: 0.2 });
  recordTideOutcome(s, { target: TARGET(), realised: NaN });
  recordTideOutcome(s, { target: TARGET(), realised: -1 });
  assert.equal(tideBias(s), before);
});

test('the aim correction survives a save, and an older save reads as blank', () => {
  const s = newGame({ seed: 5 });
  for (let i = 0; i < 4; i++) recordTideOutcome(s, { target: TARGET(), realised: 0.02 });
  const back = deserialize(serialize(s));
  assert.equal(tideBias(back), tideBias(s));
  assert.ok(tideBias(back) > 1, 'fixture: there was something to remember');

  const old = newGame({ seed: 5 });
  delete old.aiMemory;                    // a save written before any of this
  assert.equal(tideBias(old), 1);
  assert.equal(pveSplitParts(old), CONFIG.PVE_SPLIT_PARTS);
});
