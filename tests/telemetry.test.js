/**
 * telemetry.test.js — the symmetric decision log (src/ai/telemetry.js).
 *
 * The contract, in the terms that produced it: a square wheel fails at specific
 * corners, and a log of MOVES cannot find them. What has to be true of this log
 * for it to find them at all:
 *
 *   · a decision carries its REJECTED ALTERNATIVES, each with its score
 *     decomposed into terms — that is what separates a missing candidate from a
 *     mis-weighted one from a term reading the wrong quantity;
 *   · a sampled pick carries the PROBABILITY it was drawn at, so "scored the
 *     third option highest" and "sampled the third option at 22%" are different
 *     entries rather than the same one;
 *   · BOTH SIDES are logged through the same evaluator, so the human's move has
 *     a rank in the AI's own ranking;
 *   · a "did nothing" turn is a decision too, and is the flattest part of the
 *     wheel, so it is recorded with the fallback named;
 *   · the file is JSONL, and recording never changes how the game plays.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/core/rng.js';
import { newGame, serialize, deserialize } from '../src/core/GameState.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve, scoredOptionsFor, chooseAction, maybeCastAISpell } from '../src/core/combat/CombatAI.js';
import { attachBattleTelemetry, recordBattleEnd, recordHumanAction } from '../src/ai/battleTelemetry.js';
import {
  record, decision, events, toJSONL, aggregate, aggregateLines,
  setTelemetry, telemetryEnabled, TELEMETRY_MAX,
} from '../src/ai/telemetry.js';

/** A minimal host: telemetry only ever touches these three fields. */
const host = () => ({ day: 1, telemetry: [], players: [] });

function fight(state, seed = 7, opts = {}) {
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(seed),
    features: {},
    upgrades: [],
    terrain: 'grass',
    attacker: { hero: null, army: [{ creature: 'pikeman', count: 30, hurt: 0 }, { creature: 'archer', count: 12, hurt: 0 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'imp', count: 40, hurt: 0 }, { creature: 'gog', count: 10, hurt: 0 }], playerIndex: 1 },
  });
  const id = attachBattleTelemetry(battle, state, { humanSide: -1, owners: [0, 1], ...opts });
  return { battle, id };
}

// ---------------------------------------------------------------------------
// A decision is its candidate SET, not its outcome
// ---------------------------------------------------------------------------

test('every combat decision carries the alternatives it beat', () => {
  const s = host();
  const { battle, id } = fight(s);
  autoResolve(battle);
  recordBattleEnd(battle, s, id, { attackerWon: true });

  const decisions = events(s, { kind: 'decision', phase: 'combat' });
  assert.ok(decisions.length > 10, `a real battle makes many decisions (${decisions.length})`);
  for (const d of decisions) {
    assert.ok(Array.isArray(d.candidates), 'the alternatives are the record');
    assert.equal(d.n, d.candidates.length);
    assert.equal(typeof d.chosenRank, 'number', 'and where the pick sat among them');
    assert.ok(d.candidates.some((c) => c.label === d.chosen), 'the chosen option is always IN the set');
    assert.equal(d.battleId, id, 'and every decision names the battle it belongs to');
  }
});

test('a candidate score is decomposed into named terms', () => {
  const s = host();
  const { battle } = fight(s);
  autoResolve(battle);
  const attacks = events(s, { kind: 'decision' })
    .flatMap((d) => d.candidates)
    .filter((c) => /^attack /.test(c.label || ''));
  assert.ok(attacks.length > 0, 'melee options were considered');
  const withTerms = attacks.filter((c) => c.terms && Object.keys(c.terms).length);
  assert.ok(withTerms.length > 0, 'and their scores name their parts');
  // The decomposition has to include the terms a wrong choice would implicate:
  // what the blow is worth, and what it costs in retaliation.
  const any = withTerms.find((c) => 'raw' in c.terms);
  assert.ok(any, 'the raw damage value is a named term');
  assert.ok(withTerms.some((c) => 'retaliation' in c.terms || 'noRetaliation' in c.terms),
    'so is the retaliation the trade pays for');
});

test('a turn that does nothing is a decision, with the fallback named', () => {
  const s = host();
  const { battle } = fight(s);
  autoResolve(battle);
  const fell = events(s, { kind: 'decision' }).filter((d) => d.fallback);
  assert.ok(fell.length > 0, 'real battles hit the hard-coded escapes');
  for (const d of fell) {
    assert.match(d.fallback, /engaged-swing-anyway|least-bad-charge-under-fire|close-the-distance|nothing-scored-(wait|defend)|no-cast/);
    assert.ok(d.candidates.some((c) => c.label === d.chosen),
      'even a fallback action appears in the candidate list, so `chosen` is never dangling');
  }
});

test('a spell round with no cast is recorded, with the floor that blocked it', () => {
  const s = host();
  const hero = {
    id: 'h1', name: 'Caster', level: 5, stats: { attack: 3, defense: 3, power: 1, knowledge: 5 },
    skills: {}, spells: ['magicArrow'], mana: 30, equipment: {}, backpack: [], army: [], owner: 0,
  };
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(3), features: {}, upgrades: [], terrain: 'grass',
    // A colossal enemy makes the cast floor (2% of their value) enormous, so a
    // level-1-power Magic Arrow cannot clear it: the no-cast branch. The attacker
    // is given enough bodies to survive past round one, or the battle would end
    // before a spell round happened at all.
    attacker: { hero, army: [{ creature: 'pikeman', count: 400, hurt: 0 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'archangel', count: 200, hurt: 0 }], playerIndex: 1 },
  });
  attachBattleTelemetry(battle, s, { humanSide: -1, owners: [0, 1] });
  // Called directly rather than through autoResolve: against 200 archangels the
  // fight can be over before the casting side ever takes a turn, and the branch
  // under test is the CAST DECISION, not the battle around it.
  maybeCastAISpell(battle, 0);

  const spells = events(s, { kind: 'decision' }).filter((d) => d.channel === 'spell');
  assert.ok(spells.length > 0, 'the caster had a spell round');
  const noCast = spells.filter((d) => d.chosen === 'no-cast');
  assert.ok(noCast.length > 0, 'and declined to cast at least once');
  const c = noCast[0].candidates.find((x) => x.label === 'no-cast');
  assert.ok(c.terms.floor > 0, 'the floor is recorded — "nothing was worth it" vs "the bar is too high"');
  assert.equal(noCast[0].fallback, 'no-cast');
});

// ---------------------------------------------------------------------------
// Symmetry: the human is the reference class
// ---------------------------------------------------------------------------

test('a human action is scored by the AI\'s own evaluator and given a rank', () => {
  const s = host();
  const { battle, id } = fight(s, 11, { humanSide: 0 });
  // The SHOOTER: at battle start the two lines are apart, so a melee stack can
  // reach nobody and its candidate set is legitimately empty. An archer can
  // loose at either enemy from where it stands, so the board really does offer
  // a choice to rank against.
  const unit = battle.units.find((u) => u.side === 0 && u.alive && u.creature === 'archer');
  const options = scoredOptionsFor(battle, unit);
  assert.ok(options.length > 1, `the board offers a choice (${options.length})`);
  // Play the option the AI rated WORST, which is what a "the AI would not have
  // done that" move looks like from the log's side.
  const worst = options.reduce((a, b) => (a.score <= b.score ? a : b));
  recordHumanAction(battle, s, id, unit, worst.action);

  const d = events(s, { kind: 'decision' }).filter((e) => e.human).pop();
  assert.ok(d, 'the human move was recorded');
  assert.equal(d.human, true);
  assert.equal(d.n, options.length, 'against the full candidate set the AI would have built');
  assert.ok(d.chosenRank > 0, 'and it ranks below the AI\'s pick');
  assert.ok(d.regret > 0, 'with the score it gave up spelled out');
});

test('a human move the AI never generated is flagged, not silently scored', () => {
  const s = host();
  const { battle, id } = fight(s, 12, { humanSide: 0 });
  const unit = battle.units.find((u) => u.side === 0 && u.alive && !u.machine);
  // A move to a hex no candidate proposed — the MISSING CANDIDATE case, which is
  // the most serious of the three defects: no tuning can make the AI choose
  // something it never puts on the table.
  recordHumanAction(battle, s, id, unit, { type: 'move', x: 99, y: 99 });

  const d = events(s, { kind: 'decision' }).filter((e) => e.human).pop();
  assert.equal(d.note, 'not-in-candidate-set');
  assert.equal(aggregate(s).human.notInCandidateSet, 1, 'and the aggregate counts it');
});

// ---------------------------------------------------------------------------
// The aggregate — where a corner separates from noise
// ---------------------------------------------------------------------------

test('the aggregate separates argmax picks from sampled ones and counts the flat spots', () => {
  const s = host();
  for (let i = 0; i < 6; i++) {
    const { battle, id } = fight(s, 100 + i);
    autoResolve(battle);
    recordBattleEnd(battle, s, id, { attackerWon: true });
  }
  const a = aggregate(s);
  assert.ok(a.decisions > 50);
  assert.equal(a.battles, 6);
  const unit = a.byChannel.unit;
  assert.ok(unit, 'the unit channel is reported');
  assert.equal(unit.n, unit.ai + unit.human, 'every decision is attributed to a side');
  assert.ok(unit.fellThrough >= 0 && unit.single >= 0);
  // The rank histogram is the shape that says "this is systematic".
  assert.ok(Object.keys(unit.rank).length > 0);
  assert.ok(a.battleSummary.valueLostMean[0] > 0, 'value traded is a real number, not a zero');
  const lines = aggregateLines(s);
  assert.ok(lines.length >= 2 && lines.every((l) => typeof l === 'string'));
});

test('a sampled pick records the probability it was drawn at', () => {
  // Distinguishes a weighting bug from exploration noise — the two look
  // identical in a move log and must not here.
  const d = decision({
    phase: 'combat',
    channel: 'unit',
    actor: 0,
    candidates: [{ label: 'a', score: 100 }, { label: 'b', score: 95 }, { label: 'c', score: 90 }],
    chosenIndex: 2,
    temperature: 100 * 0.15,
    nearFloor: 100 * 0.85,
  });
  assert.equal(d.chosen, 'c');
  assert.equal(d.chosenRank, 2, 'third best');
  assert.equal(d.regret, 10);
  assert.ok(d.chosenP > 0 && d.chosenP < 1, 'and the probability the sampler gave it');
  const ps = d.candidates.map((c) => c.p).filter((p) => p != null);
  assert.equal(ps.length, 3);
  // Each p is rounded to 4dp for the file, so the sum is 1 to that precision.
  assert.ok(Math.abs(ps.reduce((x, y) => x + y, 0) - 1) < 1e-3, 'the probabilities are a distribution');
});

// ---------------------------------------------------------------------------
// The file, and the cost
// ---------------------------------------------------------------------------

test('the export is JSONL — one parseable object per line', () => {
  const s = host();
  const { battle, id } = fight(s);
  autoResolve(battle);
  recordBattleEnd(battle, s, id, { attackerWon: true });

  const text = toJSONL(s);
  const lines = text.split('\n');
  assert.equal(lines.length, s.telemetry.length);
  for (const line of lines) {
    const o = JSON.parse(line); // throws if the format ever stops being JSONL
    assert.ok(o.seq > 0 && o.kind, 'every line carries a sequence number and a kind');
  }
  // Truncation-tolerant: half a file is still readable up to the cut.
  const half = lines.slice(0, Math.floor(lines.length / 2));
  assert.doesNotThrow(() => half.forEach((l) => JSON.parse(l)));
});

test('the ring is bounded and the opt-out is total', () => {
  const s = host();
  for (let i = 0; i < TELEMETRY_MAX + 25; i++) record(s, { phase: 'test', kind: 'note', i });
  assert.equal(s.telemetry.length, TELEMETRY_MAX, 'bounded');
  assert.equal(s.telemetry[s.telemetry.length - 1].i, TELEMETRY_MAX + 24, 'newest kept');

  const off = host();
  setTelemetry(off, false);
  assert.equal(telemetryEnabled(off), false);
  const { battle, id } = fight(off);
  assert.equal(id, null, 'nothing is attached when recording is off');
  assert.equal(battle.telemetry, undefined, 'so the engine\'s log calls short-circuit');
  autoResolve(battle);
  assert.equal(off.telemetry.length, 0, 'and not one event is written');
});

test('recording does not change a single decision the AI makes', () => {
  // The invariant that lets this ship on by default: identical seeds, one with
  // the recorder attached and one without, must choose identically every turn.
  const mk = (seed) => createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(seed), features: {}, upgrades: [], terrain: 'grass',
    attacker: { hero: null, army: [{ creature: 'pikeman', count: 30, hurt: 0 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'imp', count: 40, hurt: 0 }], playerIndex: 1 },
  });
  const on = host();
  const a = mk(21);
  attachBattleTelemetry(a, on, { humanSide: -1, owners: [0, 1] });
  const b = mk(21);

  for (let i = 0; i < 12; i++) {
    const ua = a.units.find((u) => u.alive && !u.machine);
    const ub = b.units.find((u) => u.alive && !u.machine);
    if (!ua || !ub) break;
    assert.deepEqual(chooseAction(a, ua), chooseAction(b, ub), `same choice on turn ${i}`);
  }
  assert.ok(on.telemetry.length > 0, 'while the recorded run did write a log');
});

// ---------------------------------------------------------------------------
// Battle ids survive a save — a log that is believed must not merge two fights
// ---------------------------------------------------------------------------

test('battle ids continue across a save/reload instead of colliding with the saved log', () => {
  // The counter that mints battle ids lives in the STATE (telemetryBattleSeq),
  // because the entries it stamps live in state.telemetry, which rides the save.
  // When it was a module global, a page reload reset it to zero while the saved
  // log still held B1… — so the next fight was minted as a second "B1", and
  // countCasts, which joins decisions to their battle by this id, summed two
  // unrelated battles into one number. A diagnostic that is silently wrong is
  // worse than none, because it is believed.
  const s = newGame({ seed: 41 });
  const { id: id1 } = fight(s);
  assert.equal(id1, 'B1');
  // Two casts by side 0 in the first battle.
  for (let i = 0; i < 2; i++) {
    record(s, { phase: 'combat', kind: 'decision', channel: 'spell', battleId: id1, chosen: 'magicArrow', subject: { side: 0 } });
  }

  // Save, "close the tab", load. A fresh module instance would have reset a
  // module-global counter; the state's own counter comes back with the log.
  const loaded = deserialize(serialize(s));
  const { battle: b2, id: id2 } = fight(loaded);
  assert.equal(id2, 'B2', 'the id continues past the saved battle instead of reusing its name');

  // One cast in the new battle — and the read-back must report exactly one,
  // not one plus everything the saved B1 recorded.
  record(loaded, { phase: 'combat', kind: 'decision', channel: 'spell', battleId: id2, chosen: 'bless', subject: { side: 0 } });
  const end = recordBattleEnd(b2, loaded, id2, { attackerWon: true });
  assert.deepEqual(end.spellsCast, [1, 0], 'the saved battle\'s casts no longer leak into the new one');
});

test('a pre-counter save is adopted: ids resume one past the highest already in its log', () => {
  // Saves written before the counter existed carry B-stamped entries and no
  // telemetryBattleSeq. The first mint scans the log once and continues past
  // what is actually there — the same lazy "one past what is present" clamp
  // deserialize applies to nextUid, done here so the log needs no version bump
  // and loading never mutates a diagnostic record.
  const s = host();
  s.telemetry = [{ seq: 1, day: 3, phase: 'combat', kind: 'battle.start', battleId: 'B7' }];
  const { id } = fight(s);
  assert.equal(id, 'B8');
  assert.equal(s.telemetryBattleSeq, 8, 'and the counter now lives in the state, ready for the next save');
});

test('two same-seed sessions in one process log identical battle ids', () => {
  // The module-global counter also bled across games in one process — the same
  // defect that moved the hero/town uid into the save (v3): run one logged its
  // first battle as B1, run two as B36, so byte-identical worlds carried
  // different logs and no snapshot of the telemetry could ever be compared.
  const a = host();
  const b = host();
  assert.equal(fight(a).id, 'B1');
  assert.equal(fight(b).id, 'B1', 'a fresh state starts a fresh count — no bleed between games');
});
