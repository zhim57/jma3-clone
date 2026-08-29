/**
 * transmute.test.js — the Altar of Transmutation (creature-conversion economy).
 *
 * Pure-engine coverage: the aiValue-based quote (output count + gold fee), the
 * "you can never gain total power" tax invariant, the too-small-stack guard, the
 * town-recruitable target gating, and the stateful transmuteStack round-trip
 * with its fail-closed rollbacks (no altar / bad target / no gold / army full).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, RESOURCES } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import {
  townHasAltar, transmuteTargets, transmuteQuote, transmuteMinInput, transmuteInputFor, transmuteStack,
} from '../src/core/transmute.js';

const EFF = CONFIG.TRANSMUTE_EFFICIENCY;
const zero = () => Object.fromEntries(RESOURCES.map((r) => [r, 0]));

// A castle town that can recruit tiers 1 (base), 2 (base + upgraded), and has an
// Altar. So its transmute targets are pikeman, archer, marksman — NOT halberdier
// (the upgraded tier-1 dwelling is not built).
function castleTown(over = {}) {
  return {
    owner: 0, faction: 'castle',
    buildings: ['villageHall', 'fort', 'marketplace', 'altar', 'dwelling1', 'dwelling2', 'dwelling2u'],
    ...over,
  };
}
function mockState(town, gold = 100000) {
  const p = { isHuman: true, index: 0, resources: { ...zero(), gold } };
  return { players: [p], town };
}

// out = floor(count · aiValue(from) · efficiency / aiValue(to)), stated once and
// read off the table. These tests transcribed the four aiValues into comments and
// assertions, and an aiValue recalibration then failed a test about the FORMULA
// for having the wrong idea of what a pikeman is worth. The formula is the claim;
// the prices are content and belong looked up.
const expectOut = (from, to, n) =>
  Math.floor(n * CREATURES[from].aiValue * EFF / CREATURES[to].aiValue);

test('quote: aiValue-based output count and gold fee (the 10 pikemen → archers case)', () => {
  const q = transmuteQuote('pikeman', 'archer', 10);
  const out = expectOut('pikeman', 'archer', 10);
  assert.equal(q.ok, true);
  assert.ok(out > 0, 'fixture: this pair must convert to at least one creature');
  assert.equal(q.outCount, out);
  assert.equal(q.inValue, 10 * CREATURES.pikeman.aiValue);
  assert.equal(q.outValue, out * CREATURES.archer.aiValue);
  assert.equal(q.goldFee, Math.ceil(out * CREATURES.archer.aiValue * CONFIG.TRANSMUTE_GOLD_PER_VALUE));
});

test("quote: the user's necromancer example — 10 skeleton warriors → marksman", () => {
  const q = transmuteQuote('skeletonWarrior', 'marksman', 10);
  const out = expectOut('skeletonWarrior', 'marksman', 10);
  assert.ok(out > 0, 'fixture: this pair must convert to at least one creature');
  assert.equal(q.outCount, out);
  assert.equal(q.goldFee, Math.ceil(out * CREATURES.marksman.aiValue * CONFIG.TRANSMUTE_GOLD_PER_VALUE));
});

test('invariant: output power never exceeds the input power × efficiency (the tax)', () => {
  const ids = Object.keys(CREATURES).filter((id) => CREATURES[id].aiValue > 0);
  for (const from of ids.slice(0, 12)) {
    for (const to of ids.slice(0, 12)) {
      if (from === to) continue;
      const q = transmuteQuote(from, to, 25);
      if (!q.ok) continue;
      assert.ok(
        q.outValue <= q.inValue * EFF + 1e-9,
        `${from}->${to}: outValue ${q.outValue} exceeded taxed input ${q.inValue * EFF}`,
      );
    }
  }
});

test('quote: rejects same creature, unknown ids, empty count, and a too-small stack', () => {
  assert.equal(transmuteQuote('pikeman', 'pikeman', 10).ok, false);
  assert.equal(transmuteQuote('pikeman', 'nope', 10).ok, false);
  assert.equal(transmuteQuote('pikeman', 'archer', 0).ok, false);
  // 1 pikeman (80) can't make even one griffin (351): floor(80*0.8/351) = 0.
  assert.equal(transmuteQuote('pikeman', 'griffin', 1).ok, false);
});

const expectIn = (from, to, n = 1) =>
  Math.ceil(n * CREATURES[to].aiValue / (CREATURES[from].aiValue * EFF));

test('transmuteMinInput: fewest source creatures for one target', () => {
  // ceil(aiValue(griffin) / (aiValue(pikeman) · efficiency)), read off the table
  // for the same reason the quote tests do.
  const want = expectIn('pikeman', 'griffin');
  assert.ok(want > 1, 'fixture: a griffin must cost more than one pikeman');
  assert.equal(transmuteMinInput('pikeman', 'griffin'), want);
  assert.equal(transmuteMinInput('pikeman', 'nope'), Infinity);
});

test('transmuteInputFor: fewest source for N outputs, round-tripping the quote', () => {
  const want = expectIn('pikeman', 'griffin', 3);
  assert.equal(transmuteInputFor('pikeman', 'griffin', 3), want);
  assert.equal(transmuteQuote('pikeman', 'griffin', want).outCount, 3, 'that source yields exactly 3');
  assert.equal(transmuteInputFor('pikeman', 'griffin', 0), 0);
});

test('targets: the town TIER-2 creature only; none without an Altar', () => {
  // Narrowed deliberately: the Altar used to output any built dwelling's creature,
  // which let a junk horde be laundered into elites. Castle now yields Archers
  // (plus Marksmen where that dwelling is built) and nothing else.
  const t = castleTown();
  assert.equal(townHasAltar(t), true);
  const targets = transmuteTargets(t).sort();
  assert.deepEqual(targets, ['archer', 'marksman'].sort());
  assert.ok(!targets.includes('pikeman'), 'tier 1 is no longer an output');
  assert.ok(!targets.includes('halberdier'), 'nor any other tier');

  const noAltar = castleTown({ buildings: ['dwelling1', 'dwelling2'] });
  assert.equal(townHasAltar(noAltar), false);
  assert.deepEqual(transmuteTargets(noAltar), []);
});

test('transmuteStack: consumes the source, adds the result, charges the gold fee', () => {
  const town = castleTown();
  const state = mockState(town, 100000);
  const army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];

  const out = expectOut('pikeman', 'archer', 10);
  const res = transmuteStack(state, town, army, 0, 'archer');
  assert.equal(res.ok, true);
  assert.ok(out > 0, 'fixture: ten pikemen must be worth at least one archer');
  assert.equal(res.outCount, out);
  assert.equal(res.consumed, 10);
  // source fully consumed → slot freed; the archer stack is present at `out`.
  const archer = army.find((s) => s && s.creature === 'archer');
  assert.ok(archer && archer.count === out);
  assert.ok(!army.some((s) => s && s.creature === 'pikeman'));
  assert.equal(state.players[0].resources.gold, 100000 - res.goldFee);
});

test('transmuteStack: partial consume leaves the remainder and merges into an existing target stack', () => {
  const town = castleTown();
  const state = mockState(town, 100000);
  const army = [{ creature: 'pikeman', count: 30, hurt: 0 }, { creature: 'archer', count: 2, hurt: 0 }, null, null, null, null, null];

  const res = transmuteStack(state, town, army, 0, 'archer', 10); // convert only 10 of 30
  assert.equal(res.ok, true);
  assert.equal(army[0].count, 20, 'remainder stays');
  assert.equal(army[1].count, 2 + res.outCount, 'result merged into the existing archer stack');
});

test('transmuteStack: fail-closed — no altar, invalid target, and not enough gold all no-op', () => {
  // no altar
  const t0 = castleTown({ buildings: ['dwelling1', 'dwelling2'] });
  const s0 = mockState(t0, 100000);
  const a0 = [{ creature: 'pikeman', count: 10, hurt: 0 }];
  assert.equal(transmuteStack(s0, t0, a0, 0, 'archer').ok, false);
  assert.equal(a0[0].count, 10);

  // target the town can't build (griffin dwelling not built)
  const t1 = castleTown();
  const s1 = mockState(t1, 100000);
  const a1 = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  assert.equal(transmuteStack(s1, t1, a1, 0, 'griffin').ok, false);

  // not enough gold → nothing spent, army unchanged
  const t2 = castleTown();
  const s2 = mockState(t2, 1); // 1 gold, fee is ~315
  const a2 = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  assert.equal(transmuteStack(s2, t2, a2, 0, 'archer').reason, 'not enough gold');
  assert.equal(a2[0].count, 10, 'source untouched');
  assert.equal(s2.players[0].resources.gold, 1, 'no gold spent');
});

test('transmuteStack: army full + partial consume rolls back; full consume reuses the freed slot', () => {
  const town = castleTown();
  // 7 full slots, none an archer, source (pikeman) has extra so a partial convert
  // would need a new slot → must fail and roll back with no gold spent.
  const full = () => [
    { creature: 'pikeman', count: 100, hurt: 0 },
    { creature: 'halberdier', count: 5, hurt: 0 },
    { creature: 'griffin', count: 5, hurt: 0 },
    { creature: 'royalGriffin', count: 5, hurt: 0 },
    { creature: 'skeleton', count: 5, hurt: 0 },
    { creature: 'skeletonWarrior', count: 5, hurt: 0 },
    { creature: 'marksman', count: 5, hurt: 0 },
  ];
  const s1 = mockState(town, 100000);
  const a1 = full();
  const r1 = transmuteStack(s1, town, a1, 0, 'archer', 10);
  assert.equal(r1.ok, false);
  assert.equal(a1[0].count, 100, 'source restored');
  assert.equal(s1.players[0].resources.gold, 100000, 'no gold spent on a rolled-back trade');

  // Same board, but convert the WHOLE pikeman slot → it frees, archer takes it.
  const s2 = mockState(town, 100000);
  const a2 = full();
  const r2 = transmuteStack(s2, town, a2, 0, 'archer'); // all 100
  assert.equal(r2.ok, true);
  assert.ok(a2.some((s) => s && s.creature === 'archer'));
});

// ---------------------------------------------------------------------------
// No dead remainder
// ---------------------------------------------------------------------------

/**
 * Reported: "331 creatures make 256 of the new ones, 334 make 257, and we have
 * 332 — so one remains, and it is better to round to the larger number than to
 * fill a slot with 1 or 2 leftovers."
 *
 * The dialog steps in whole units of the OUTPUT, so "forge the most you can" asks
 * for the FEWEST source creatures that reach that output — 331 of your 332 — and
 * the odd one is stranded in a slot it can never leave, because one creature can
 * never fund another target. The altar now sweeps a leftover too small to trade
 * again into the trade it came from.
 */
/** Every stack size for which "forge the most you can" used to strand creatures. */
function strandingSizes(from, to, upTo = 400) {
  const minIn = transmuteMinInput(from, to);
  const out = [];
  for (let have = minIn; have <= upTo; have++) {
    const most = transmuteQuote(from, to, have).outCount;
    const asked = transmuteInputFor(from, to, most);
    if (asked < have && have - asked < minIn) out.push({ have, asked, most, left: have - asked });
  }
  return out;
}

test('the stranding is common, not a corner — the fixture that makes the rest meaningful', () => {
  // Not a constructed example: for pikemen into archers, more than a third of every
  // stack size up to 400 leaves creatures behind when you ask for the most you can
  // forge. A test that built one such stack by hand could be satisfied by a fix
  // that only worked on that stack.
  const cases = strandingSizes('pikeman', 'archer');
  assert.ok(cases.length > 100, `${cases.length} stack sizes strand creatures`);
  for (const c of cases.slice(0, 20)) {
    assert.ok(c.left > 0 && c.left < transmuteMinInput('pikeman', 'archer'),
      `${c.have}: what is left (${c.left}) could never be traded again`);
  }
});

test('a leftover too small to ever trade again is swept into the trade', () => {
  for (const [from, to] of [['pikeman', 'archer'], ['peasant', 'archer']]) {
    if (!CREATURES[from] || !CREATURES[to]) continue;
    for (const c of strandingSizes(from, to).slice(0, 30)) {
      const q = transmuteQuote(from, to, c.asked, c.have);
      assert.equal(q.consumed, c.have, `${from}->${to} @${c.have}: the whole stack goes in`);
      assert.equal(q.swept, c.left);
      assert.ok(q.outCount >= c.most, 'and the player is never worse off for it');
    }
  }
});

test('a leftover that CAN still be traded is left alone', () => {
  const from = 'pikeman', to = 'archer';
  const minIn = transmuteMinInput(from, to);
  const have = minIn * 10;
  const asked = minIn * 4;                       // half a trade, deliberately
  const q = transmuteQuote(from, to, asked, have);
  assert.equal(q.consumed, asked, 'asking for part of a stack still gives you part of it');
  assert.equal(q.swept, 0);
});

test('the sweep reaches the army, not just the quote', () => {
  const town = castleTown(), s = mockState(town);
  const from = 'pikeman', to = 'archer';
  const c = strandingSizes(from, to)[8];       // a real stranding case, not a made-up one
  const army = [{ creature: from, count: c.have, hurt: 0 }, null, null, null, null, null, null];

  const res = transmuteStack(s, town, army, 0, to, c.asked);
  assert.equal(res.ok, true);
  assert.equal(res.consumed, c.have, 'the odd ones went in with the rest');
  assert.equal(res.swept, c.left);
  // Not "the slot is null": transmuteStack frees the source slot FIRST so the
  // result can claim it, so slot 0 is now the archers. The claim is that no
  // untradeable rump of the SOURCE is left holding a slot anywhere.
  assert.equal(army.filter((st) => st && st.creature === from).length, 0,
    'no rump of the source is left holding a slot');
  assert.ok(army.some((st) => st && st.creature === to && st.count === res.outCount),
    'and the result took the slot the source gave up');
});

test('the whole-stack path is unchanged — it never had a remainder to sweep', () => {
  const town = castleTown(), s = mockState(town);
  const from = 'pikeman', to = 'archer';
  const have = transmuteMinInput(from, to) * 5;
  const army = [{ creature: from, count: have, hurt: 0 }, null, null, null, null, null, null];
  const res = transmuteStack(s, town, army, 0, to, null);   // "all of it"
  assert.equal(res.consumed, have);
  assert.equal(res.swept, 0);
});

test('a quote with no stack behind it is exactly what it always was', () => {
  // transmuteQuote(from, to, n) is a pure "what would N fetch" and several callers
  // ask it that way (the AI, the max-output label). Defaulting `have` to `count`
  // keeps that reading, so nothing is swept into a question about nothing.
  const from = 'pikeman', to = 'archer';
  for (const n of [transmuteMinInput(from, to), 100, 331, 332, 1000]) {
    const q = transmuteQuote(from, to, n);
    if (!q.ok) continue;
    assert.equal(q.consumed, n, `${n}: a bare quote consumes exactly what it was asked about`);
    assert.equal(q.swept, 0);
  }
});
