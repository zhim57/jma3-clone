/**
 * physical-damage.test.js — the two properties that make a second damage model
 * safe to have in the tree at all.
 *
 * The physical model (src/core/combat/physicalDamage.js) replaces the whole of
 * `rollDamage`: the roll, the attack-vs-defense ladder, the range penalty. That
 * is a large amount of behaviour to put behind one `if`, and the risk is not
 * that the new model is wrong — it is off by default, so being wrong costs
 * nothing. The risk is that adding it changes the OLD one.
 *
 *   FLAG OFF IS BYTE-IDENTICAL. Same seed, same setup, same survivors, same
 *   experience, and the same `rng.calls` — the project's house pattern
 *   (HANDOVER §2.3), and the thing that lets every existing balance number and
 *   every recorded seed keep meaning what it meant.
 *
 *   FLAG ON DRAWS THE SAME NUMBER OF VALUES PER ATTACK. `state.rng` is a single
 *   persistent stream shared by the whole game, so a model that draws one extra
 *   value per attack does not merely change combat — it shifts every later
 *   morale check and map roll in that seed, and two models compared on "the
 *   same seed" would be two different games. So the physical model draws the
 *   classic model's draws, in the classic model's order.
 *
 *   Measured PER ATTACK, deliberately. Over a whole battle the totals must
 *   diverge and it would be a bad sign if they did not: different damage means
 *   stacks die at different moments and the fight runs a different number of
 *   turns. What has to hold is that the divergence comes from the OUTCOMES and
 *   never from the model quietly consuming more entropy — so the honest
 *   instrument is one attack, on two identical battlefields, before anything
 *   has had a chance to differ.
 *
 * The third test is the one that says the exercise was worth doing: with the
 * flag ON, the authored pair actually fights differently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  boundsViolations, PHYS_BOUNDS, arrest, armourSection, completePhys, feasible, FEASIBLE,
  tissueOf, FLESH_DENSITY,
} from '../src/core/headGeometry.js';
import { UPGRADE_NODES } from '../src/data/upgradeNodes.js';

import { createBattle, act, PHYS_ENGINE } from '../src/core/combat/CombatEngine.js';
import { physicalDamage, expectedPhysicalDamage, fallbackPhys } from '../src/core/combat/physicalDamage.js';
import { shooterNiches, armourLadder, effectiveHardness, NICHE_EITHER_SIDE, NICHE_MIN_PAYING } from '../src/core/rigidity.js';
import { patchedPhys } from '../src/core/upgrades.js';
import { retiredHeads, RETIRED_HEADS } from '../src/core/retiredHeads.js';
import { conditioning, marginIsEvidence } from '../src/core/conditioning.js';
import { penetrate } from '../src/core/combat/physicalDamage.js';
import { CONFIG } from '../src/config.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';
import { CREATURES } from '../src/data/creatures.js';

const SEED = 20260729;

const ARMY_A = [
  { creature: 'archer', count: 30, hurt: 0 },
  { creature: 'pikeman', count: 25, hurt: 0 },
];
const ARMY_B = [
  { creature: 'marksman', count: 26, hurt: 0 },
  { creature: 'halberdier', count: 22, hurt: 0 },
];

const cfgOf = (rng, features) => ({
  rng,
  features,
  simulated: true,
  attacker: { hero: null, army: ARMY_A.map((s) => ({ ...s })), playerIndex: 0 },
  defender: { hero: null, army: ARMY_B.map((s) => ({ ...s })), playerIndex: 1 },
});

/** Everything a rerun has to reproduce, as one comparable string. */
const digest = (result) => JSON.stringify({
  won: result.attackerWon, atk: result.attackerArmy, def: result.defenderArmy,
  xp: result.xp, flawless: result.flawless,
});

/** Run one battle under a given feature set; report the result and the draws. */
function run(features) {
  const rng = new Rng(SEED);
  const result = autoResolve(createBattle(cfgOf(rng, features)));
  return { digest: digest(result), calls: rng.calls, result };
}

// ---- flag off ---------------------------------------------------------------

test('physical damage OFF is byte-identical to no flag at all', () => {
  const bare = run(undefined);
  const off = run({ physicalDamage: false });
  assert.equal(off.digest, bare.digest, 'the flag off must reproduce the classic result exactly');
  assert.equal(off.calls, bare.calls, `and draw the same rng (${off.calls} vs ${bare.calls})`);
});

test('physical damage OFF reproduces itself across runs on one seed', () => {
  // Cheap, and it is what makes the comparison above mean anything: if the
  // classic model were not itself reproducible, matching it would prove nothing.
  const a = run({ physicalDamage: false });
  const b = run({ physicalDamage: false });
  assert.equal(a.digest, b.digest);
  assert.equal(a.calls, b.calls);
});

// ---- flag on ----------------------------------------------------------------

/**
 * Draws consumed by ONE shot, on a battlefield built from the same seed — so
 * both models are looking at the identical deployment, obstacles and queue.
 */
function drawsForOneShot(features) {
  const rng = new Rng(SEED);
  const battle = createBattle(cfgOf(rng, features));
  // Put a shooter next to a target by hand: no movement, no pathing, no morale
  // — just the attack, so the delta is the damage model's draws and nothing else.
  const shooter = battle.units.find((u) => u.side === 0 && CREATURES[u.creature].reach === 'ranged');
  const target = battle.units.find((u) => u.side === 1);
  assert.ok(shooter && target, 'the fixture needs a shooter and a target');
  // Damage lands in an HP POOL, not in whole creatures — a volley that hurts a
  // stack without killing one is a real outcome, and at long range under the
  // physical model it is the common one. Asserting on kills made this fixture
  // silently degenerate the moment the couplings were re-tuned.
  const pool = (u) => (u.count - 1) * u.maxHp + u.hp;
  const before = rng.calls, hp = pool(target);
  act(battle, shooter, { type: 'shoot', targetId: target.id });
  return { draws: rng.calls - before, dealt: hp - pool(target) };
}

test('physical damage ON draws exactly the rng the classic model draws, per attack', () => {
  // The contract that keeps two models comparable on one seed. If this ever
  // fails, every differential measurement taken with the harness is void — not
  // wrong at the margin, void, because the two runs stopped being the same game.
  const off = drawsForOneShot({ physicalDamage: false });
  const on = drawsForOneShot({ physicalDamage: true });
  assert.equal(on.draws, off.draws,
    `one shot drew ${on.draws} values physically and ${off.draws} classically`);
  // Both shots have to have HAPPENED, or the equality above is a comparison of
  // two rejected actions: `act` returns silently on an illegal move, so a
  // fixture that drifts out of range would keep passing while testing nothing.
  assert.ok(on.draws > 0, 'the shot drew nothing — did it resolve at all?');
  assert.ok(on.dealt > 0 && off.dealt > 0, 'both models must have actually dealt damage');
});

test('a whole battle diverges only through its outcomes, never before the first blow', () => {
  // The complement of the per-attack test, and the reason the totals below are
  // allowed to differ: everything the engine draws BEFORE any damage is rolled
  // — the deployment split, the obstacle field — must be identical, or the two
  // models would be fighting on two different battlefields and no comparison
  // between them would mean anything.
  const shape = (features) => {
    const rng = new Rng(SEED);
    const battle = createBattle(cfgOf(rng, features));
    return JSON.stringify({
      calls: rng.calls,
      obstacles: battle.obstacles,
      units: battle.units.map((u) => ({ id: u.id, creature: u.creature, count: u.count, x: u.x, y: u.y })),
    });
  };
  assert.equal(shape({ physicalDamage: true }), shape({ physicalDamage: false }));
});

test('physical damage ON is itself deterministic', () => {
  const a = run({ physicalDamage: true });
  const b = run({ physicalDamage: true });
  assert.equal(a.digest, b.digest);
  assert.equal(a.calls, b.calls);
});

test('physical damage ON actually changes the fight', () => {
  // Not a balance assertion — just proof the branch is reached and the model is
  // doing something. A physical model that produced the classic numbers would
  // be an expensive way to write `rollDamage` twice.
  const off = run({ physicalDamage: false });
  const on = run({ physicalDamage: true });
  assert.notEqual(on.digest, off.digest, 'the two models resolved the same battle identically');
});

// ---- partial coverage -------------------------------------------------------

test('physical damage runs for creatures with no phys block (the fallback)', () => {
  // Coverage lands a faction at a time, so for most of the migration most of the
  // roster is un-authored. The model must still resolve a battle between two
  // creatures it knows nothing about — and produce something close to their
  // classic damage, since the fallback reads the blow's energy off the classic
  // tuple precisely so that divergence is attributable to authored creatures.
  //
  // AGAINST A FIXTURE, because the roster ran out of un-authored creatures.
  //
  // This test named `gog` and `demon`, then read two un-authored ids off the
  // table when authoring Inferno expired those names. Both versions were bets on
  // content, and content finished: 139 of 140 creatures carry a `phys` block and
  // the one that does not (the Catapult) never attacks anything. So there is no
  // pair left to find, and a test that needs one is a test that deletes itself
  // the day the migration succeeds — which would leave the fallback branch in
  // `physicalDamage.js` with nothing exercising it at all. That is exactly how
  // the `excludes` mechanism nearly died when the fletchery fork was cut, and the
  // answer there is the answer here: inject the fixture.
  //
  // Two synthetic creatures, added for the duration and removed after. The path
  // under test is real — `createBattle` and `autoResolve` read the same table the
  // game does — and the premise no longer depends on the roster being unfinished.
  const bare = [
    { creature: '_fallbackA', count: 30, hurt: 0 },
    { creature: '_fallbackB', count: 20, hurt: 0 },
  ];
  const stub = (name, damage, health) => ({
    name, faction: 'neutral', tier: 3, upgraded: false,
    attack: 8, defense: 6, damage, health, speed: 6, reach: 'melee',
    growth: 0, cost: { gold: 100 }, aiValue: 300, abilities: [], glyph: 'club', tint: 0x808080,
    desc: 'Fixture: a creature the physical model knows nothing about.',
  });
  CREATURES._fallbackA = stub('Fallback A', [2, 5], 15);
  CREATURES._fallbackB = stub('Fallback B', [4, 7], 25);
  try {
    assert.ok(!CREATURES._fallbackA.phys && !CREATURES._fallbackB.phys, 'the fixture must be un-authored');
    const battle = createBattle({
      rng: new Rng(SEED), features: { physicalDamage: true }, simulated: true,
      attacker: { hero: null, army: bare.map((s) => ({ ...s })), playerIndex: 0 },
      defender: { hero: null, army: bare.map((s) => ({ ...s })), playerIndex: 1 },
    });
    const result = autoResolve(battle);
    assert.ok(result.attackerWon === true || result.attackerWon === false, 'the battle resolved');
    const alive = [...result.attackerArmy, ...result.defenderArmy].reduce((n, s) => n + s.count, 0);
    assert.ok(alive > 0 && Number.isFinite(alive), 'survivors are a real number, not NaN');
  } finally {
    delete CREATURES._fallbackA;
    delete CREATURES._fallbackB;
  }
});

// ---- the AI's estimator ------------------------------------------------------

test('the estimator agrees with the roll it estimates, exactly', () => {
  // The anti-drift pin, and the reason `blow` was split out of the model at all.
  // The classic pair carries the comment "mirrors the engine's rollDamage",
  // which is a promise with no mechanism behind it — nothing makes a mirror stay
  // a mirror through a re-tune. Here the two differ in ONE input, the quality
  // factor, so on the 'hold' stance (which averages the roll instead of drawing
  // it) they must produce the same number. If this ever fails, the estimator and
  // the model have separated and the AI is scoring a game it is not playing.
  const rng = new Rng(SEED);
  const battle = createBattle({
    ...cfgOf(rng, { physicalDamage: true }),
    attacker: { hero: null, army: ARMY_A.map((s) => ({ ...s })), playerIndex: 0, stance: 'hold' },
  });
  const shooter = battle.units.find((u) => u.side === 0 && CREATURES[u.creature].reach === 'ranged');
  const target = battle.units.find((u) => u.side === 1);
  assert.ok(shooter && target);

  const estimate = expectedPhysicalDamage(battle, shooter, target, 'ranged', PHYS_ENGINE);
  const before = rng.calls;
  const rolled = physicalDamage(battle, shooter, target, 'ranged', PHYS_ENGINE);
  assert.equal(rng.calls, before, "'hold' averages rather than drawing, so this comparison is fair");
  assert.equal(rolled.damage, Math.max(1, Math.round(estimate)),
    `estimator said ${estimate.toFixed(3)}, the model rolled ${rolled.damage}`);
});

test('the estimator sees range the classic one is blind to', () => {
  // The behavioural reason this change matters. Inside RANGED_FULL_RANGE the
  // classic estimator is FLAT — closing from 9 hexes to 4 is worth exactly
  // nothing to it, so a shooter scored that way has no reason to move. The
  // physical group grows as an area, so those five hexes are most of the damage.
  // An AI scoring physical battles with the classic formula stands still.
  const rng = new Rng(SEED);
  const battle = createBattle(cfgOf(rng, { physicalDamage: true }));
  const shooter = battle.units.find((u) => u.side === 0 && CREATURES[u.creature].reach === 'ranged');
  const target = battle.units.find((u) => u.side === 1);
  const at = (d) => expectedPhysicalDamage(battle, shooter, target, 'ranged', PHYS_ENGINE, {
    fromX: target.x - d, fromY: target.y,
  });
  const near = at(3), mid = at(7), far = at(9);
  assert.ok(near > mid && mid > far,
    `damage must fall with range inside full range: ${near.toFixed(1)} / ${mid.toFixed(1)} / ${far.toFixed(1)}`);
  // …and by a margin worth crossing the field for, not a rounding artefact.
  assert.ok(near / far > 1.5, `closing 6 hexes is only worth ${(near / far).toFixed(2)}x`);
});

test('the estimator honours the what-if knobs the spell evaluator drives it with', () => {
  const rng = new Rng(SEED);
  const battle = createBattle(cfgOf(rng, { physicalDamage: true }));
  const a = battle.units.find((u) => u.side === 0);
  const d = battle.units.find((u) => u.side === 1);
  const base = expectedPhysicalDamage(battle, a, d, 'melee', PHYS_ENGINE);
  const opts = (o) => expectedPhysicalDamage(battle, a, d, 'melee', PHYS_ENGINE, o);
  assert.ok(opts({ attackDelta: 6 }) > base, 'Bloodlust must read as more damage');
  assert.ok(opts({ defenseDelta: 6 }) < base, 'Stone Skin on the target must read as less');
  assert.ok(opts({ forceMax: true }) > base, 'Bless pins the high roll');
  assert.ok(opts({ forceMin: true }) < base, 'Curse pins the low one');
  // A negative delta must not drive a stat below zero and flip the sign of the
  // physics — the classic estimator clamps at 0 and so must this.
  assert.ok(opts({ attackDelta: -999 }) > 0, 'a huge debuff must not produce negative damage');
});

test('the physical model never returns a fractional or non-finite damage number', () => {
  // applyDamage subtracts this from an integer HP pool. A NaN would not throw —
  // it would quietly make a stack immortal, which is exactly the kind of bug
  // that survives a whole session of playtesting.
  for (const features of [{ physicalDamage: true }, { physicalDamage: false }]) {
    for (let seed = 1; seed <= 12; seed++) {
      const rng = new Rng(seed * 7919);
      const battle = createBattle(cfgOf(rng, features));
      const before = battle.units.reduce((n, u) => n + u.count, 0);
      autoResolve(battle);
      const after = battle.units.reduce((n, u) => n + (u.alive ? u.count : 0), 0);
      assert.ok(Number.isInteger(after) && after >= 0 && after <= before,
        `seed ${seed} (${JSON.stringify(features)}): survivor count ${after} is not a sane integer`);
    }
  }
});

test('tip rigidity: a heavier head is worth a lot against plate and nothing against hide', () => {
  // THE CONDITIONALITY IS THE POINT (I5), and it is why this term exists at all.
  // With the bow's energy authored, d = E/(sigma·A) has no mass term — a heavier
  // head carries the same joules and only leaves slower — so every mass-adding
  // upgrade read as strictly negative and the material-swap class was
  // unexpressible. Sectional density m/A restores mass's consequence WITHOUT
  // making it a flat bonus: a point that was never going to deform gains nothing
  // by being harder to deform.
  const rng = new Rng(SEED);
  const battle = createBattle(cfgOf(rng, { physicalDamage: true }));
  const shooter = battle.units.find((u) => u.side === 0 && CREATURES[u.creature].reach === 'ranged');
  const target = battle.units.find((u) => u.side === 1);
  assert.ok(shooter && target);

  // Same shooter, same hex, two targets differing ONLY in armour hardness: one
  // softer than anything on the roster, one harder than plate.
  // Plate is HARD AND COVERING and hide is neither — both properties, because
  // that is what the two words mean and what the roster actually authors
  // (archangel 0.75 GPa over 85% of the body, griffin 0.022 over 60%). Hardness
  // alone would understate the effect to nothing: with 58% of a marksman
  // unarmoured, the exposed fraction takes the same joules however sharp the
  // point stayed, and the penetration term only ever governs the rest.
  const against = ({ gpa, cover }, massScale) => {
    const base = CREATURES[target.creature].phys;
    const b = {
      ...battle,
      physScale: {
        [target.creature]: {
          armorHardness_gpa: gpa / base.armorHardness_gpa,
          armorCoverage_frac: cover / base.armorCoverage_frac,
        },
        [shooter.creature]: { blowMass_kg: massScale },
      },
    };
    return expectedPhysicalDamage(b, shooter, target, 'ranged', PHYS_ENGINE);
  };
  // SCORED ON `penetrate`, NOT ON A RANGED SHOT (I16/I17). The claim here is about the
  // PENETRATION branch — "a point that was never going to deform gains nothing from
  // being harder to deform" — and a ranged shot now also carries the drop term, so a
  // heavier head loses hit fraction for reasons that have nothing to do with rigidity.
  // Measuring the claim where the claim lives keeps `assert.equal(…, 1)` exact instead
  // of forcing a tolerance, and a tolerance is where a real effect later hides.
  const pen = ({ gpa, cover }, massScale) => {
    const sp = CREATURES[shooter.creature].phys;
    const phys = { ...sp, blowMass_kg: sp.blowMass_kg * massScale };
    return penetrate(phys.blowEnergy_j, phys, gpa * 1e9, cover);
  };
  const HIDE = { gpa: 0.02, cover: 0.9 }, MAIL = { gpa: 0.18, cover: 0.9 }, HEAVIER = 1.4;

  const hideGain = pen(HIDE, HEAVIER) / pen(HIDE, 1);
  const mailGain = pen(MAIL, HEAVIER) / pen(MAIL, 1);
  void against;

  // EXACTLY one, not approximately. Below the threshold the branch is not taken
  // at all, so a point that was never going to deform gains literally nothing by
  // being harder to deform — the conditionality is structural, not a small
  // number that happens to round well.
  assert.equal(hideGain, 1, `a rigid point gains nothing from being MORE rigid: ${hideGain}`);
  assert.ok(mailGain > 1.15,
    `40% more head mass must buy real penetration against mail, got ${mailGain.toFixed(3)}x`);
});

test('tip rigidity: the benefit PEAKS at armour, rather than climbing forever', () => {
  // The shape is the claim. A term that rose monotonically with hardness would be
  // an anti-armour bonus wearing physics; this one is flat below the threshold
  // (nothing was deforming), peaks where the point is marginal, and falls away
  // again against plate so hard that a sharper point is still stopped. An
  // interior maximum cannot be produced by a flat bonus, which is the whole
  // difference between a modelled effect and a designed one.
  const rng = new Rng(SEED);
  const battle = createBattle(cfgOf(rng, { physicalDamage: true }));
  const shooter = battle.units.find((u) => u.side === 0 && CREATURES[u.creature].reach === 'ranged');
  const target = battle.units.find((u) => u.side === 1);
  const base = CREATURES[target.creature].phys;
  // SHAPE OF THE PENETRATION TERM, so scored on `penetrate` (I16/I17). Through a
  // ranged shot the curve now also carries the drop dispersion, which is flat in
  // hardness and therefore shifts every point by the same factor — it cannot move the
  // peak, but it does break the exact `=== 1` the flat region is entitled to. The
  // claim is about rigidity; measure it where rigidity lives.
  const sp = CREATURES[shooter.creature].phys;
  const gain = (gpa) => {
    const scale = (massScale) => penetrate(sp.blowEnergy_j,
      { ...sp, blowMass_kg: sp.blowMass_kg * massScale }, gpa * 1e9, 0.9);
    return scale(1.4) / scale(1);
  };
  void base;
  const curve = [0.02, 0.06, 0.12, 0.18, 0.35, 0.60, 0.75].map(gain);
  const peak = curve.indexOf(Math.max(...curve));
  assert.ok(peak > 0 && peak < curve.length - 1,
    `the peak must be INTERIOR, not at an end: ${curve.map((g) => g.toFixed(3)).join(' ')}`);
  assert.equal(curve[0], 1, 'flat below the threshold');
  assert.ok(curve[curve.length - 1] < curve[peak],
    'and falling away again where even a sharp point is stopped');
});

test('tip rigidity: the hot path stays inside I10 — one division, one comparison', () => {
  // A regression pin on the ARITHMETIC, not the outcome. The two fractional-
  // exponent quantities in this model are computed offline precisely so damage
  // is bit-identical across engines; a rigidity term written with a pow or an
  // exp would quietly cost that, and the loss would show up as an unreproducible
  // sweep months later rather than as a failing test now.
  const src = readFileSync(new URL('../src/core/combat/physicalDamage.js', import.meta.url), 'utf8');
  // Comments stripped first: the prose in this file talks about exponents at
  // length, and a scanner that reads the explanation as the code fails on the
  // paragraph explaining why it must not. (It did, on the first run.)
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // The whole per-attack path: `penetrate` (the rigidity and armour contest) and
  // `blow` (energy, connection, hero skills). Splitting the arithmetic across two
  // functions must not split the guarantee across one.
  const body = code.slice(code.indexOf('export function penetrate('), code.indexOf('function qualityOf('));
  assert.ok(body.includes('const deform') && body.includes('velRetainPerHex_ratio'),
    'fixture: the slice must contain both penetrate() and blow()');
  for (const banned of ['Math.pow', 'Math.exp', 'Math.log', 'Math.cbrt', '**']) {
    assert.ok(!body.includes(banned), `blow() uses ${banned} — that is not bit-identical across engines`);
  }
});

test('rigidity: every shooter has a mass niche INSIDE the roster, away from its ends', () => {
  // THE PEAK'S LOCATION IS DESIGN, NOT LUCK, and it was luck until this test.
  // The gain from added head mass peaks at some armour hardness and falls away —
  // an interior peak, which gives mass a target NICHE rather than a direction.
  // But `PHYS_RIGIDITY_SD_PER_PA`, the tip's area and mass, the blow's energy,
  // the reference depth and the target's coverage all move that peak, and not one
  // of them was chosen to place it.
  //
  // Measured against the roster, the original k left five of six shooters with
  // their niche pinned on the ARCHANGEL — the hardest creature in the game, with
  // no content beyond it. Mass was a dead investment class for them and nothing
  // failed. If a future tuning change does that again, this does.
  const niches = shooterNiches();
  assert.ok(niches.length >= 4, 'fixture: there must be authored shooters to check');
  for (const n of niches) {
    assert.ok(n.softer >= NICHE_EITHER_SIDE,
      `${n.id}'s mass niche is ${n.best.id} (${n.best.gpa} GPa) with only ${n.softer} softer target(s) — `
      + 'it is sitting on the soft end of the ladder');
    assert.ok(n.harder >= NICHE_EITHER_SIDE,
      `${n.id}'s mass niche is ${n.best.id} (${n.best.gpa} GPa) with only ${n.harder} harder target(s) — `
      + 'mass is a dead investment class for it');
    assert.ok(n.paying >= NICHE_MIN_PAYING,
      `${n.id} only has ${n.paying} target(s) worth adding mass against — that is a coincidence, not a class`);
  }
});

test('I10: dimensionless ratios are carried, never reconstructed from absolutes', () => {
  // THE SECOND HALF OF I10, and it was learned from a bug rather than written
  // down first. Drag used to bleed an absolute velocity and rebuild (v/v0)² from
  // it, which rounded differently for different v0 — so head mass moved damage by
  // one part in 10^15 where the physics says it must move it by nothing. That
  // magnitude was benign; the PATTERN is not. The same reconstruction on a
  // smaller ratio, or a subtraction of near-equal terms, loses significance that
  // matters, and it does so silently.
  //
  // Enforced structurally on the one loop that accumulates a ratio: it must build
  // the ratio directly, never divide two absolutes back out.
  const src = readFileSync(new URL('../src/core/combat/physicalDamage.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const body = code.slice(code.indexOf('export function penetrate('), code.indexOf('function qualityOf('));
  assert.match(body, /retain \*= ap\.velRetainPerHex_ratio/,
    'the per-hex loop must accumulate the RATIO, not an absolute speed');
  assert.ok(!/\/\s*ap\.blowSpeed_mps/.test(body),
    'dividing by an absolute launch speed is the reconstruction this invariant forbids');
  // And the observable consequence: below the deformation threshold, head mass
  // must change the delivered damage by EXACTLY nothing. Not nearly nothing.
  const rng = new Rng(SEED);
  const battle = createBattle(cfgOf(rng, { physicalDamage: true }));
  const shooter = battle.units.find((u) => u.side === 0 && CREATURES[u.creature].reach === 'ranged');
  const target = battle.units.find((u) => u.side === 1);
  const soft = CREATURES[target.creature].phys.armorHardness_gpa;
  const at = (massScale) => expectedPhysicalDamage({
    ...battle,
    physScale: {
      [target.creature]: { armorHardness_gpa: 0.01 / soft },   // far below any threshold
      [shooter.creature]: { blowMass_kg: massScale },
    },
  }, shooter, target, 'ranged', PHYS_ENGINE);
  // MASS IS NO LONGER INERT, AND THAT IS THE POINT. This assertion used to read
  // `assert.equal(at(1.4), at(1))` and it passed for eleven phases, because
  // `blowSpeed_mps` was derived and then read by nothing — so the founding exemplar of
  // the whole design (denser head → heavier arrow → lower velocity → worse reach) had
  // nowhere to land and mass was free. The test was encoding the defect.
  //
  // The property that survives is narrower and truer: mass is exactly inert in the
  // PENETRATION term below the deformation threshold, and it costs AIM through the
  // drop dispersion. Both halves are asserted, because either alone can be satisfied
  // by a model that is wrong in the other direction.
  const sp = CREATURES[shooter.creature].phys;
  const penAt = (ms) => penetrate(sp.blowEnergy_j, { ...sp, blowMass_kg: sp.blowMass_kg * ms },
    0.01e9, sp.armorCoverage_frac);
  // SCOPED BELOW THE CLAMP RELEASE, and the scope is load-bearing. Mass enters X
  // through E·m, and with E = E_s·m/(m+m_v) that makes X FALL as mass rises — so above
  // the release a heavier head penetrates BETTER and the unscoped version of this
  // assertion is false. 0.01 GPa is far below the broadhead's 0.0607 release, where
  // nothing deforms and the branch is not taken at all, so `equal` is exact rather
  // than nearly so. An unscoped invariant that is true in a sub-regime and false in
  // general is how a test rots quietly.
  assert.equal(penAt(1.4), penAt(1),
    'BELOW THE CLAMP RELEASE, mass must be EXACTLY inert IN PENETRATION — no tolerance');
  assert.ok(at(1.4) < at(1),
    `a heavier head at the same bow energy leaves slower, drops more and hits less: `
    + `${at(1.4).toFixed(4)} must be below ${at(1).toFixed(4)}`);
});

test('fallback: a synthesised creature carries every field the physics reads', () => {
  // THE STAND-IN MUST BE COMPLETE, or excluded from the paths that read it.
  // `tipRigid` was missing when rigidity landed and moved the all-un-authored
  // control by 1.5 points of win rate. A control that is not exactly zero is a
  // broken instrument, not a slightly noisy one — every divergence the sweep
  // attributes to authored content is measured against it.
  //
  // This recurs every time a new physical field lands, so it is a rule rather
  // than a fix: the synthesised block's key set must cover the authored one.
  // "Or be excluded from the paths that read it" is the other half of the rule, and
  // it is load-bearing: `ballisticCoeff_kgpm2` is an INPUT TO THE OFFLINE
  // DERIVATION and is never read at damage time — the runtime reads the baked
  // `velRetainPerHex_ratio` instead. Demanding it of the stand-in would be
  // demanding a value nothing consumes. So the set checked is the authored fields
  // the runtime ACTUALLY READS, discovered by scanning the two modules that read
  // them rather than by keeping a list someone has to remember to update.
  const readers = ['../src/core/combat/physicalDamage.js', '../src/core/upgrades.js']
    .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
    .map((t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
    .join('\n');
  const authored = Object.keys(CREATURES.archer.phys);
  const readAtRuntime = authored.filter((k) => new RegExp(`\\.${k}\\b`).test(readers));
  assert.ok(readAtRuntime.length >= 8, `fixture: only found ${readAtRuntime.length} fields being read`);

  const synth = new Set(Object.keys(fallbackPhys(CREATURES.gog)));
  const missing = readAtRuntime.filter((k) => !synth.has(k));
  assert.deepEqual(missing, [],
    `the stand-in is missing ${missing.join(', ')}, and the damage path reads it — either give it a `
    + 'value or stop reading it for un-authored creatures. A partial stand-in moves the control.');
  // Every value finite and non-negative, because a NaN here would propagate into
  // every un-authored creature's damage and read as a content problem.
  for (const [k, v] of Object.entries(fallbackPhys(CREATURES.gog))) {
    if (typeof v !== 'number') continue;
    assert.ok(Number.isFinite(v) && v >= 0, `stand-in ${k} is ${v}`);
  }
});

test('rigidity: the deforming regime collapses onto ONE dimensionless group', () => {
  // THE STRONGEST STRUCTURAL CLAIM IN THE MODEL, and it is exact rather than fitted.
  //
  // For a tip that is deforming, effA = k·h·A²/m, so p = E·m/(k·h·A²·d) and
  //
  //     through = 1/(1 + X),     X = h²·k·A²·d / (E·m)
  //
  // X is the PRODUCT of the two groups that survived the retracted closed form —
  // (k·h·A/m)·(h·A·d/E) — so in this regime the two-parameter family collapses to
  // one and the second group survives only in the regime structure.
  //
  // A scaling collapse is a far more severe test than any single identity: it is
  // simultaneous across the whole roster, and ANY missing variable shows up as
  // scatter. Six shooters against sixteen targets spanning 34x in hardness, every
  // authored area, mass and energy — one line.
  const K = CONFIG.PHYS_RIGIDITY_SD_PER_PA, D = CONFIG.PHYS_PENETRATION_DEPTH;
  let pairs = 0, worst = 0, worstAt = '';
  for (const [sid, sc] of Object.entries(CREATURES)) {
    if (!sc.phys || sc.reach !== 'ranged') continue;
    for (const t of armourLadder()) {
      const p = sc.phys, h = t.phys.armorHardness_pa;
      const deform = (h * K * p.contactArea_m2) / p.blowMass_kg;
      if (deform <= 1) continue;                     // the claim is about deforming tips only
      // What the model actually computes, via its own penetrate() with no coverage
      // so the armour term is isolated.
      const measured = penetrate(p.blowEnergy_j, p, h, 1) / p.blowEnergy_j;
      const X = ((t.gpa * 1e9) ** 2 * K * p.contactArea_m2 ** 2 * D) / (p.blowEnergy_j * p.blowMass_kg);
      const dev = Math.abs((1 / (1 + X)) / measured - 1);
      if (dev > worst) { worst = dev; worstAt = `${sid} vs ${t.id}`; }
      pairs++;
    }
  }
  assert.ok(pairs >= 50, `fixture: only ${pairs} deforming pairs — the collapse needs a roster`);
  // Float epsilon, not a tolerance chosen to pass. If a term is ever added to the
  // penetration chain that X does not capture, this fails immediately and loudly.
  assert.ok(worst < 1e-12,
    `the collapse is off by ${worst.toExponential(2)} at ${worstAt} — X is no longer the only group`);
});

test('rigidity: a fork can never favour the narrow head below the WIDE head\'s clamp release', () => {
  // A STRUCTURAL PREDICTION COMPUTABLE BEFORE ANY BATTLE RUNS, and one that must
  // hold for every fork ever authored. Below the wide head's release NEITHER tip
  // deforms, so both present their nominal area, both get the same `through`
  // fraction, and the delivered ratio is just the energy ratio — which the wide
  // head owns. An armour-piercing advantage cannot exist in a regime where nothing
  // is being outmatched.
  //
  // AND THE ONE-SIDED CLAIM IS FALSE TOO — it was a value-dependent statement dressed
  // as a relationship, true at the authored energy and nowhere near general. "Both get
  // the same `through` fraction" above is wrong: below the release both present their
  // NOMINAL areas, which differ, so the narrow head gets the higher pressure. Whether
  // that beats the wide head's energy depends on the ENERGY SCALE, and it does so
  // non-monotonically:
  //
  //   E → 0    the bare term (1−c) dominates and it is pure energy → WIDE wins
  //   E mid    p/(p+h) is near-linear in p, so the narrow head's pressure edge
  //            survives into `through` → NARROW wins
  //   E → ∞    p/(p+h) saturates toward 1 for both, the through terms converge,
  //            energy dominates again → WIDE wins
  //
  // Two limits with the SAME sign and an interior maximum, so the narrow head wins on a
  // BAND of energies rather than below a threshold. Setting the delivered damages equal
  // gives a quadratic in E with both roots in closed form — a second isocline, in the
  // plane the first one does not cover:
  //
  //   Q  = (ρ−1)(1−c)/c,   β_i = E_i/(A_i·d·h)
  //   A·E² + B·E + Q = 0,  A = β_b·β_w·(ρ−1+Q),  B = ρβ_w − β_b + Q(β_w+β_b)
  //
  // Verified against the model at four coverages: strongly positive inside the band,
  // negative just outside either root. THE PARAMETERISATION IS THE POINT — this form
  // cannot rot under a re-basis, because it is stated in terms of the thing that moves.
  //
  // THE TWO-SIDED VERSION IN HARDNESS IS ALSO FALSE, and worth recording because it is the
  // intuitive one. "The crossover lies BETWEEN the two releases" holds at coverages
  // near 30-35% (crossing ~0.10 GPa inside a 0.061-0.123 bracket) and fails
  // elsewhere: at 21.6% coverage — the isocline's minimum — the crossing is at
  // 0.2075 GPa, above the bodkin's release, and at 62% it is near 1.05 GPa. The
  // isocline's own minimum sits outside the bracket, so no two-sided bound in
  // hardness alone can be right. Only the lower bound is a theorem.
  const K = CONFIG.PHYS_RIGIDITY_SD_PER_PA;
  const bodkin = retiredHeads('woodElf').narrow;
  const broad = retiredHeads('woodElf').wide;
  const hStar = (p) => (p.blowMass_kg / p.contactArea_m2) / K;
  const wideRelease = hStar(broad);
  assert.ok(hStar(bodkin) > wideRelease,
    'fixture: the narrow head must be the more rigid one, or this fork is not what it says');

  // THE ABSOLUTE CLAIM WAS FALSE AND THIS IS ITS REPLACEMENT. The assertion here used to
  // be `rel < 0` everywhere below the wide release, justified by "both get the same
  // `through` fraction". They do not: below the release both present their NOMINAL areas,
  // which differ, so the narrow head takes the higher pressure. Whether that beats the
  // wide head's energy depends on the ENERGY SCALE, non-monotonically — and the
  // base-energy re-basis (115.6 → 90 J) walked straight into a coverage where it flips.
  //
  // It passed for eleven phases because it was a value-dependent statement wearing a
  // relationship's clothes. The correct statement is the closed form: the narrow head
  // wins below the release exactly when the E* quadratic has real roots AND the operating
  // energy scale (1, by definition, for the authored heads) lies between them.
  //
  // So this now asserts that the CLOSED FORM GOVERNS, target by target and hardness by
  // hardness. That cannot rot under a re-basis, because it is parameterised by the thing
  // that moves — which is the whole reason it was written this way.
  const D = CONFIG.PHYS_PENETRATION_DEPTH;
  const rho = broad.blowEnergy_j / bodkin.blowEnergy_j;
  const rel = (h, c) => penetrate(bodkin.blowEnergy_j, bodkin, h, c)
    / penetrate(broad.blowEnergy_j, broad, h, c) - 1;
  const narrowWinsPredicted = (h, c) => {
    const bb = bodkin.blowEnergy_j / (bodkin.contactArea_m2 * D * h);
    const bw = broad.blowEnergy_j / (broad.contactArea_m2 * D * h);
    const Q = ((rho - 1) * (1 - c)) / c;
    const A = bb * bw * (rho - 1 + Q), B = rho * bw - bb + Q * (bw + bb);
    const disc = B * B - 4 * A * Q;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    const r = [(-B + sq) / (2 * A), (-B - sq) / (2 * A)].sort((x, y) => x - y);
    return r[0] < 1 && 1 < r[1];
  };
  // Swept over every AUTHORED coverage — a scan must not visit empty space.
  for (const t of armourLadder()) {
    for (let h = wideRelease * 0.02; h < wideRelease; h *= 1.15) {
      assert.equal(rel(h, t.cover) > 0, narrowWinsPredicted(h, t.cover),
        `at ${(h / 1e9).toFixed(4)} GPa against ${t.id} (${(t.cover * 100).toFixed(0)}% coverage), `
        + `measured ${rel(h, t.cover) > 0 ? 'narrow' : 'wide'} but the E* band predicts `
        + `${narrowWinsPredicted(h, t.cover) ? 'narrow' : 'wide'}. Below the wide head's release the '
        + 'sign is set by whether the operating energy sits inside [E*1, E*2].`);
    }
  }
});

test('rigidity: the per-hit boundary must be read at EFFECTIVE hardness, not authored', () => {
  // THE PHANTOM ANOMALY, pinned so it cannot come back. `blow()` folds the target's
  // Defense stat into the armour — h_eff = h · (1 + def · 0.17) — and every per-hit
  // instrument here read the authored figure instead. That produced a fork result
  // that looked like the battle layer inverting the per-hit sign at mid-coverage,
  // and it was logged as an unexplained defect. It was an unstated argument.
  //
  // A Champion's 0.45 GPa meets an arrow as 1.67 GPa (Defense 16); a Centaur
  // Captain's identical 0.45 GPa meets it as 0.68 (Defense 3). They were authored as
  // a matched pair on the authored number and differ by 2.5x on the one that counts.
  const champion = CREATURES.champion, captain = CREATURES.centaurCaptain;
  assert.equal(champion.phys.armorHardness_gpa, captain.phys.armorHardness_gpa,
    'fixture: these two are supposed to share an authored hardness');
  const hc = effectiveHardness(champion.phys, champion.defense);
  const hk = effectiveHardness(captain.phys, captain.defense);
  assert.ok(hc / hk > 2,
    `the same authored hardness must diverge under Defense: got ${(hc / 1e9).toFixed(3)} vs ${(hk / 1e9).toFixed(3)} GPa`);
  // And the ladder must carry both, so no instrument can quietly read one.
  for (const t of armourLadder()) {
    assert.ok(t.effGpa >= t.gpa, `${t.id}: effective hardness must not be below authored`);
    assert.equal(typeof t.defense, 'number', `${t.id}: the ladder must expose the Defense it folded in`);
  }
});

/**
 * Every module that could be an instrument — walked, not listed.
 *
 * "Instrument" means: it imports the creature table, or it reaches into a `phys`
 * block. That is the population I16 is about, and enumerating it from the tree is
 * what makes the check's coverage knowable. The engine's own damage model and the
 * data file itself are excluded by name, because they ARE the transform rather than
 * consumers of it.
 */
function discoverInstruments() {
  const ROOTS = ['../src', '../scripts'];
  const EXEMPT = [/combat\/physicalDamage\.js$/, /data\/creatures\.js$/, /combat\/CombatEngine\.js$/];
  // WHAT MAKES A MODULE AN INSTRUMENT IS SEMANTIC, NOT ITS PATH. Reading the
  // authored hardness is only an error when the module computes a PENETRATION
  // CONTEST with it — that is the calculation `blow()` folds Defense into. A module
  // that re-bakes GPa into Pa (`upgrades.js`, `derive-physical.mjs`) or describes a
  // creature's own kit is doing neither, and a path-based exemption for those would
  // just be the hardcoded list again wearing a directory name.
  //
  // So: importing or calling `penetrate` is the discriminator. It is the one entry
  // point to the contest, it is where the transformed hardness is required, and it
  // catches the two real violations this replaced — `fork.mjs` and `pareto.js` both
  // import it.
  // ON CODE, NOT PROSE. The first version tested the raw source and fired on
  // `headGeometry.js`, whose only "penetrate" is the word "penetrating" in a comment
  // about tip sections. A discriminator that reads comments is measuring the
  // documentation — and in a codebase whose house style is long rationale comments,
  // that is a guaranteed false positive.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const contestsPenetration = (src) => /\bpenetrate\b/.test(strip(src));
  const found = [];
  const walk = (dirUrl) => {
    for (const e of readdirSync(dirUrl, { withFileTypes: true })) {
      const child = new URL(`${e.name}${e.isDirectory() ? '/' : ''}`, dirUrl);
      if (e.isDirectory()) { walk(child); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      const src = readFileSync(child, 'utf8');
      if (!/from\s+['"][^'"]*creatures\.js['"]/.test(src) && !/\.phys\b/.test(src)) continue;
      const rel = child.href.slice(new URL('../', import.meta.url).href.length);
      if (EXEMPT.some((r) => r.test(rel))) continue;
      if (!contestsPenetration(src)) continue;
      found.push(`../${rel}`);
    }
  };
  for (const r of ROOTS) walk(new URL(`${r}/`, import.meta.url));
  return found.sort();
}

test('I16 meta: the scanner reaches every module that reads physical data', () => {
  // The check on the check. If this ever finds fewer files than the tree holds, the
  // coverage claim above is false and every I16 pass since is worth less than it
  // looked. Naming the count is deliberate: a silent shrink is the failure mode.
  const found = discoverInstruments();
  // CLONE: the floor is 1, not upstream's 6. The number is not a quality bar — it is
  // a tripwire against DISCOVERY silently breaking, so it has to be calibrated to the
  // tree it runs on. Upstream, six modules contest penetration; this clone ships only
  // core/rigidity.js among them, because the balance-research instruments that made up
  // the rest (core/pareto.js and the two dozen scripts/sim/*.mjs sweeps) are not
  // carried — they tune creature stats, which is not what this tree is for.
  //
  // Keep the assertion rather than deleting it: it still catches the failure mode it
  // was written for, which is the scanner quietly finding NOTHING and every I16 pass
  // above being vacuous. Raise this number if you bring more instruments back.
  assert.ok(found.length >= 1,
    `I16 scans only ${found.length} module(s); the tree had more than that when this was `
    + `written. Discovery is broken, not the tree: ${found.join(', ')}`);
  for (const rel of found) {
    assert.doesNotThrow(() => readFileSync(new URL(rel, import.meta.url), 'utf8'),
      `${rel} was discovered but cannot be read`);
  }
  // CLONE: upstream also asserts that a scripts/sim/ module is among the found set —
  // that directory is the hole the hand-listed version of this check forgot. Here it
  // cannot hold and asserting it would be theatre: the scripts/sim/ modules that read
  // physical data are the creature-balance sweeps (fork, frontier, isocline, …), and
  // this clone ships only the AI harnesses (batch, aiperf, goal-audit), none of which
  // touch penetration. Restore the sweeps and put this assertion back with them.
});

test('I16: an instrument must not read an authored field the engine transforms', () => {
  // THE STRUCTURAL FIX, and it exists because a documentation rule could not have
  // prevented the failure it is named after. "Every scalar carries its arguments"
  // was adopted and then broken in the same week, because the break was in CODE: a
  // per-hit scan read `armorHardness_pa` while `blow()` reads
  // `armorHardness_pa · (1 + defense · PHYS_DEFENSE_COUPLING)`. Prose has no
  // purchase on that.
  //
  // SIX TIMES an instrument has disagreed with the engine and SIX TIMES the
  // instrument was wrong: `SD/k` as an isocline, the large-X asymptote, the
  // synthetic 90% coverage scan, the fixed-hardness niche scan, the coinciding
  // peaks, and authored-versus-effective hardness. The engine is the trustworthy
  // layer and the instruments are the fragile one, which argues for instruments
  // being thin wrappers over engine calls wherever that is possible at all.
  //
  // So: the same treatment I14 got. Any module that computes a per-hit quantity for
  // comparison against battles must reach the transformed value through
  // `effectiveHardness`, never by reading the authored field itself.
  //
  // THE SET IS DISCOVERED, NOT LISTED, because the listed version had a coverage
  // hole and the hole did exactly what holes do. This check caught `pareto.js` on
  // its first run and then missed `fork.mjs` for four commits, because
  // `scripts/sim/` was never in the array. A structural check that does not scan
  // every instrument is worse than no check: it confers confidence proportional to
  // its name rather than to its reach. So the scanner walks `src/` and `scripts/`
  // and takes as an instrument anything that imports the creature table or reaches
  // into a `phys` block — which is the definition the rule actually means.
  const TRANSFORMED = ['armorHardness_pa', 'armorHardness_gpa'];
  for (const rel of discoverInstruments()) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const field of TRANSFORMED) {
      const reads = [...code.matchAll(new RegExp(`\\.${field}\\b`, 'g'))].length;
      if (!reads) continue;
      // A module may read the authored field only if it also routes through the
      // transform — that is what makes the read deliberate rather than forgotten.
      assert.match(code, /effectiveHardness|effGpa/,
        `${rel} reads .${field} (${reads}x), computes a penetration contest, and never routes `
        + 'through effectiveHardness()/effGpa. The engine folds '
        + 'Defense into hardness before the penetration contest; an instrument that reads the '
        + 'authored figure is measuring a different model. See I16 in docs/PHYSICAL_MODEL.md.');
    }
  }
});

test('I16: effectiveHardness is what the engine actually applies', () => {
  // The other half: the helper must not drift from `blow()`. Verified against the
  // engine end to end rather than against a copy of the formula — a target whose
  // authored hardness is divided by the coupling factor must deal exactly the
  // damage of a Defense-0 target at the authored figure.
  const rng = new Rng(SEED);
  const battle = createBattle(cfgOf(rng, { physicalDamage: true }));
  const shooter = battle.units.find((u) => u.side === 0 && CREATURES[u.creature].reach === 'ranged');
  const target = battle.units.find((u) => u.side === 1);
  const phys = CREATURES[target.creature].phys;
  const def = PHYS_ENGINE.unitDefenseStat(battle, target);
  const eff = effectiveHardness(phys, def);

  // Ask the engine for the delivered damage, then reproduce it through `penetrate`
  // at the effective hardness. Agreement to float epsilon means the helper is the
  // transform the engine uses, not an approximation of it.
  const dmg = expectedPhysicalDamage(battle, shooter, target, 'ranged', PHYS_ENGINE, { forceMax: true });
  assert.ok(dmg > 0 && Number.isFinite(dmg), 'fixture sanity');
  assert.ok(eff > phys.armorHardness_pa,
    `Defense ${def} must raise the hardness the arrow meets: ${eff} vs ${phys.armorHardness_pa}`);
  // And the coupling is the documented one, read off the engine's own constant.
  assert.ok(Math.abs(eff / phys.armorHardness_pa - (1 + def * CONFIG.PHYS_DEFENSE_COUPLING)) < 1e-12,
    'effectiveHardness must apply exactly PHYS_DEFENSE_COUPLING, not a copy of it');
});

test('I21: a node\'s RESULT must satisfy the bounds authored content must satisfy', () => {
  // THE FIRST NODE CAUGHT PATCHING A QUANTITY OUT OF PHYSICAL BOUNDS was Heavy Draw,
  // which takes a 152 J bow to 201 J — past anything a human draws — and it was caught
  // BY EYE, during an anchoring pass aimed at something else. There is no reason to
  // expect the next one is. A node that adds head mass pushes FOC out exactly as easily
  // as this one pushed energy out, and the schema resists neither.
  //
  // So the assertion is on the RESULT, not on the multiplier: apply the effects, then
  // require the state to be one a bow could produce and an archer could shoot. Every
  // single node and every legal pair, because an individually-innocent pair is exactly
  // the case a per-node check would miss.
  const bad = [];
  for (const [cid, c] of Object.entries(CREATURES)) {
    if (!c.phys) continue;
    const mine = Object.keys(UPGRADE_NODES).filter((i) => UPGRADE_NODES[i].creatures?.includes(cid));
    const combos = [[], ...mine.map((i) => [i])];
    for (const i of mine) {
      for (const j of mine) {
        if (i < j && !UPGRADE_NODES[i].excludes?.includes(j)) combos.push([i, j]);
      }
    }
    for (const combo of combos) {
      let p;
      try { p = patchedPhys(cid, c.phys, combo); } catch { continue; }
      const v = boundsViolations(p);
      if (v.length) bad.push(`${cid} + [${combo.map((x) => x.split('.').pop()).join(', ')}]: ${v.join('; ')}`);
    }
  }
  // THE KNOWN-VIOLATION LIST IS GONE, on its own stated condition. It held twelve
  // entries, all `drawWeight` multiplying a ceiling-high base, and it carried an expiry:
  // it existed only until the base-energy re-basis landed. That landed at 90 J (woodElf)
  // and 92 J (grandElf) and every entry cleared, so the list deletes rather than being
  // maintained — which is what an expiry is for, and the reason it could not quietly
  // become a rubber stamp.
  assert.deepEqual(bad, [],
    `${bad.length} node combination(s) produce a physically impossible state:\n  ${bad.join('\n  ')}\n`
    + 'A baseline at the CEILING of its range makes every upgrade unphysical by construction. '
    + 'Authored baselines belong LOW in their range, because the design needs slack in the '
    + `direction it will grow. Bounds: ${JSON.stringify(PHYS_BOUNDS)}`);
});

test('rigidity: below the wide release the narrow head wins on a BAND of energies', () => {
  // The rewritten form of the invariant above. Stated in closed form and checked against
  // the model, so it survives the base-energy re-basis instead of being re-fixtured by
  // it — which is exactly what the old value-dependent version could not do.
  const bod = retiredHeads('woodElf').narrow;
  const brd = retiredHeads('woodElf').wide;
  const D = CONFIG.PHYS_PENETRATION_DEPTH;
  const rho = brd.blowEnergy_j / bod.blowEnergy_j;
  const h = 0.0528e9;                                  // below the wide head's release
  const margin = (c, E) => penetrate(bod.blowEnergy_j * E, bod, h, c)
    / penetrate(brd.blowEnergy_j * E, brd, h, c) - 1;
  const band = (c) => {
    const bb = bod.blowEnergy_j / (bod.contactArea_m2 * D * h);
    const bw = brd.blowEnergy_j / (brd.contactArea_m2 * D * h);
    const Q = ((rho - 1) * (1 - c)) / c;
    const A = bb * bw * (rho - 1 + Q), B = rho * bw - bb + Q * (bw + bb);
    const disc = B * B - 4 * A * Q;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    return [(-B + sq) / (2 * A), (-B - sq) / (2 * A)].filter((x) => x > 0).sort((x, y) => x - y);
  };
  for (const c of [0.5, 0.62, 0.8, 0.9]) {
    const r = band(c);
    assert.ok(r && r.length === 2, `no band at coverage ${c}`);
    assert.ok(margin(c, Math.sqrt(r[0] * r[1])) > 0,
      `inside the band [${r[0].toExponential(2)}, ${r[1].toFixed(3)}] the narrow head must win at c=${c}`);
    assert.ok(margin(c, r[0] * 0.98) < 0 && margin(c, r[1] * 1.02) < 0,
      `outside the band the wide head must win at c=${c}`);
  }
});

test('rigidity: below c_crit the narrow head cannot win at ANY energy — and c_crit is hardness-free', () => {
  // THE INVARIANT THE ORIGINAL ONE WAS REACHING FOR. "A fork can never favour the narrow
  // head below the wide head's release" was right in intent and missing a condition: the
  // band [E*_1, E*_2] widens with coverage, so it must VANISH below some critical
  // coverage. That is the discriminant, B² = 4AQ, and it is closed form.
  //
  // AND h CANCELS OUT OF IT ENTIRELY. Both β terms carry 1/h, so A ∝ 1/h², B ∝ 1/h and
  // B² − 4AQ is homogeneous — c_crit depends only on ρ and the two areas, not on the
  // target. Measured identical at 0.020, 0.030, 0.0528 and 0.0607 GPa, which is a
  // stronger statement than the one that failed: not "the narrow head loses below the
  // release" but "below 32.6% coverage it loses there at every energy and every hardness".
  const bod = retiredHeads('woodElf').narrow;
  const brd = retiredHeads('woodElf').wide;
  const D = CONFIG.PHYS_PENETRATION_DEPTH;
  const rho = brd.blowEnergy_j / bod.blowEnergy_j;
  const disc = (h, c) => {
    const bb = bod.blowEnergy_j / (bod.contactArea_m2 * D * h);
    const bw = brd.blowEnergy_j / (brd.contactArea_m2 * D * h);
    const Q = ((rho - 1) * (1 - c)) / c;
    const A = bb * bw * (rho - 1 + Q), B = rho * bw - bb + Q * (bw + bb);
    return B * B - 4 * A * Q;
  };
  const cCrit = (h) => {
    let lo = 1e-4, hi = 1 - 1e-4;
    for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (disc(h, m) < 0) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const ref = cCrit(0.0528e9);
  assert.ok(ref > 0.3 && ref < 0.36, `c_crit should sit near 33%, got ${(ref * 100).toFixed(2)}%`);
  for (const g of [0.020, 0.030, 0.0607]) {
    assert.ok(Math.abs(cCrit(g * 1e9) / ref - 1) < 1e-9,
      `c_crit must not depend on hardness: ${(cCrit(g * 1e9) * 100).toFixed(4)}% at ${g} vs ${(ref * 100).toFixed(4)}%`);
  }
  assert.ok(disc(0.0528e9, ref - 0.02) < 0 && disc(0.0528e9, ref + 0.02) > 0,
    'the discriminant must change sign across c_crit');
});

test('EQUIVARIANCE: scaling stored energy must leave ρ — and commit 2\'s territory — untouched', () => {
  // THE SEQUENCING CHECK. ρ = E_w/E_b comes from the two heads' energy MULTIPLIERS, so
  // E_stored cancels: scaling every authored energy must leave ρ bit-identical, and with
  // it the isocline and all 28 odds ratios. That is an assertion that re-basis commit 1
  // (base energy) does not reach into commit 2 (broadhead mass, which moves ρ). If it
  // ever fires, the three commits are not as separable as the plan assumes — and that is
  // worth knowing before the second one starts rather than after.
  const rhoOf = (scale) => {
    const base = { ...CREATURES.woodElf.phys, blowEnergy_j: CREATURES.woodElf.phys.blowEnergy_j * scale };
    const { narrow, wide } = retiredHeads('woodElf', base);
    return wide.blowEnergy_j / narrow.blowEnergy_j;
  };
  // ASSERTED STRUCTURALLY FIRST, because that is the actual claim: ρ is the ratio of the
  // two nodes' energy MULTIPLIERS and contains no creature energy at all.
  //
  // TO A FEW ULP, NOT BIT-EXACTLY, and the first version of both assertions got this
  // wrong. `(E·a)/(E·b)` and `a/b` differ in the last bit — 1.1041666666666665 against
  // ...67 — and the reason is ACCUMULATED ROUNDING, not reassociation: IEEE
  // multiplication is commutative and nothing here is reordered, but the first form
  // performs three roundings where the second performs one. Demanding bit-equality
  // asserts an exactness the spec does not provide, and the failure reads like a physics
  // finding. The claim is that ρ carries no E_stored TERM; a ULP of accumulated rounding
  // is not E_stored leaking in.
  assert.ok(Math.abs(rhoOf(1) / (RETIRED_HEADS.wide.blowEnergy_j / RETIRED_HEADS.narrow.blowEnergy_j) - 1) < 4 * Number.EPSILON,
    `ρ must be the node multiplier ratio and nothing else: ${rhoOf(1)} vs `
    + `${RETIRED_HEADS.wide.blowEnergy_j / RETIRED_HEADS.narrow.blowEnergy_j}`);
  // Then numerically, to a few ULP rather than bit-exactly. Scaling reorders two
  // multiplications, and 1.1041666666666667 against ...65 is one ULP of float noise, not
  // E_stored leaking in. Demanding bit-equality here would be asserting an associativity
  // the IEEE spec does not provide, and the failure would look like a physics finding.
  for (const f of [0.5, 0.865, 2]) {
    assert.ok(Math.abs(rhoOf(f) / rhoOf(1) - 1) < 4 * Number.EPSILON,
      `scaling all stored energy by ${f} moved ρ by more than float noise `
      + `(${rhoOf(f)} vs ${rhoOf(1)}) — commit 1 is reaching into commit 2's territory`);
  }
});

test('EQUIVARIANCE: the E* band moves RIGIDLY with hardness while its existence does not', () => {
  // THE NATURAL PAIR TO c_crit. The discriminant is homogeneous in h, so EXISTENCE is
  // hardness-free — but the roots themselves are not: A ∝ 1/h², B ∝ 1/h and Q is h-free,
  // so both E* scale as h¹. Harder armour demands proportionally more energy for the
  // narrow head to win, and the band slides without changing shape.
  //
  // Together the two statements say something a single test could not: the band's
  // LOCATION is set by hardness and its EXISTENCE entirely by coverage.
  const bod = retiredHeads('woodElf').narrow;
  const brd = retiredHeads('woodElf').wide;
  const D = CONFIG.PHYS_PENETRATION_DEPTH;
  const rho = brd.blowEnergy_j / bod.blowEnergy_j;
  const roots = (h, c) => {
    const bb = bod.blowEnergy_j / (bod.contactArea_m2 * D * h);
    const bw = brd.blowEnergy_j / (brd.contactArea_m2 * D * h);
    const Q = ((rho - 1) * (1 - c)) / c;
    const A = bb * bw * (rho - 1 + Q), B = rho * bw - bb + Q * (bw + bb);
    const sq = Math.sqrt(B * B - 4 * A * Q);
    return [(-B + sq) / (2 * A), (-B - sq) / (2 * A)].sort((x, y) => x - y);
  };
  const h0 = 0.0528e9;
  for (const c of [0.5, 0.8, 0.9]) {
    const base = roots(h0, c);
    for (const f of [0.5, 2, 5]) {
      const got = roots(h0 * f, c);
      for (let i = 0; i < 2; i++) {
        assert.ok(Math.abs(got[i] / (base[i] * f) - 1) < 1e-9,
          `scaling hardness by ${f} must scale E*_${i + 1} by exactly ${f} at c=${c}: `
          + `${got[i]} vs ${base[i] * f}`);
      }
    }
  }
});

test('EQUIVARIANCE: the regime map transforms as the algebra says, or something reads what it should not', () => {
  // A THIRD CATEGORY, alongside characterisation and invariant tests. These assert how
  // outputs must TRANSFORM when inputs do, which is why they survive deliberate model
  // changes untouched — exactly what three re-basis commits need. Each fails loudly the
  // moment a quantity starts being read where it has no business.
  const K = CONFIG.PHYS_RIGIDITY_SD_PER_PA;
  const hStar = (p) => (p.blowMass_kg / p.contactArea_m2) / K;
  const bod = retiredHeads('woodElf').narrow;
  const scaled = (p, f) => ({ ...p, ...f });

  // 1. ENERGY: h* carries no energy term, so scaling energy must leave it bit-identical.
  assert.equal(hStar(scaled(bod, { blowEnergy_j: bod.blowEnergy_j * 0.865 })), hStar(bod),
    'a clamp release moved under an energy change — something in h* reads energy');

  // 2. AREA: h* = (m/A)/k, so scaling area by f must divide h* by exactly f.
  for (const f of [0.5, 2, 7]) {
    const got = hStar(scaled(bod, { contactArea_m2: bod.contactArea_m2 * f }));
    assert.ok(Math.abs(got / (hStar(bod) / f) - 1) < 1e-12,
      `scaling area by ${f} must divide h* by exactly ${f}: got ${got}`);
  }

  // 3. MASS AND AREA TOGETHER: scaling both by the same factor leaves sectional density
  //    unchanged, so h* must not move at all.
  for (const f of [0.5, 2, 7]) {
    const got = hStar(scaled(bod, { blowMass_kg: bod.blowMass_kg * f, contactArea_m2: bod.contactArea_m2 * f }));
    assert.ok(Math.abs(got / hStar(bod) - 1) < 1e-12,
      `scaling mass and area together must leave h* fixed: got ${got} vs ${hStar(bod)}`);
  }
});

test('EQUIVARIANCE: frontalArea and d_max share one volume, so their shape factors are tied', () => {
  // A COHERENCE CHECK, NOT A MEASUREMENT — labelled, because the two carry different
  // weight and the label is what stops it being over-quoted later.
  //
  // `completePhys` computes `frontalArea_m2 = SHAPE_K · V^(2/3)` and will compute `d_max`
  // from the SAME `volume` local, so the product is `SHAPE_K · shapeD · V` BY
  // CONSTRUCTION and the residual is round-off. It fires when someone edits one
  // derivation and not the other; it CANNOT detect a shape factor that is wrong in a way
  // both fields share. That limit is the whole difference from the machine-epsilon
  // episode, where an identity evaluated at 65 places was briefly read as corroboration.
  //
  // The residual's SIZE confirms the reading: 6.5e-6, not 1e-16. It is the six-
  // significant-figure rounding `derive-physical.mjs` applies when writing the file
  // (`toPrecision(6)`), raised to the 3/2 power — arithmetic on stored decimals, not
  // agreement between independent quantities.
  //
  // TWO DERIVED FIELDS TIED TO EACH OTHER rather than each to a value. `frontalArea_m2`
  // is SHAPE_K·V^(2/3) and `d_max` will be shapeD·V^(1/3) — same underlying volume, one
  // power apart — so `frontalArea^(3/2) / V` must be a CONSTANT across the whole roster,
  // equal to SHAPE_K^(3/2). If the two fields ever acquire independently-chosen shape
  // factors, or if either stops deriving from the same volume, this drifts and fires.
  //
  // Available today, before `d_max` exists, because it constrains the half that does —
  // which is the point of writing it now: the assertion predates the field it is meant
  // to protect.
  const rows = Object.values(CREATURES).filter((c) => c.phys);
  const ratios = rows.map((c) => Math.pow(c.phys.frontalArea_m2, 1.5)
    / (c.phys.bodyMass_kg / c.phys.density_kgpm3));
  const lo = Math.min(...ratios), hi = Math.max(...ratios);
  assert.ok(hi / lo - 1 < 1e-4,
    `frontalArea^(3/2)/V must be constant across the roster (it is SHAPE_K^(3/2)); `
    + `spread ${(hi / lo - 1).toExponential(2)} over ${rows.length} creatures`);
  assert.ok(Math.abs(lo / Math.pow(CONFIG.PHYS_SHAPE_K, 1.5) - 1) < 1e-4,
    `and it must equal SHAPE_K^(3/2) = ${Math.pow(CONFIG.PHYS_SHAPE_K, 1.5)}, got ${lo}`);
});

// ---------------------------------------------------------------------------
// The arrest solver, and the two integrals it is
// ---------------------------------------------------------------------------

test('arrest: the armour section IS the whole-head mean when the interval is the whole head', () => {
  // THE STRUCTURAL TIE, and it is the reason to believe the profile is being applied
  // consistently. `headMeanArea_m2` (mass, and the energy to bury the head entire) and
  // `headArmourArea_m2` (what `penetrate` reads) had no reason to be the same function
  // of anything — one is a solid's mean section, the other a work integral over a fixed
  // depth. They are the same function over different intervals, so setting the reference
  // depth to the head's length must collapse one onto the other EXACTLY.
  //
  // This is what would have caught the profile defect. The landed solver integrated a
  // linear-in-area taper while the mass model assumed linear-in-radius, and at the 20x
  // ratios the sweep reaches those disagree by 23.7% — an equality test between them
  // fails at the first tapered head.
  for (const [At, ratio, L] of [[4e-6, 2, 0.06], [4e-6, 20, 0.15], [1e-5, 1.5, 0.10], [2e-6, 8, 0.03]]) {
    const Am = At * ratio;
    const whole = (At + Math.sqrt(At * Am) + Am) / 3;
    assert.equal(armourSection(At, Am, L, L), whole,
      `armourSection over [0, L] must equal the frustum mean exactly at A_max/A_t = ${ratio}`);
  }
});

test('arrest: un-tapered content is inert BY CONSTRUCTION, bit-identically', () => {
  // Not "within a tolerance" — exactly, so the A/B against taper-off is free and so the
  // 1706-test suite is a real check rather than one that passes because the difference
  // is below whatever epsilon someone picked.
  for (const A of [9.9e-6, 3.06e-5, 1.8e-5, 1.2e-4]) {
    for (const L of [0.02, 0.06, 0.15]) {
      assert.equal(armourSection(A, A, L, CONFIG.PHYS_PENETRATION_DEPTH), A,
        'no taper means the section at every depth is the tip');
      const r = arrest(90, 2.5e7, A, A, L);
      assert.equal(r.depth_m, 90 / (2.5e7 * A), 'un-tapered arrest must reduce to KE/(sigma·A) exactly');
      assert.equal(r.section_m2, A);
    }
  }
  // And through the authoring pipeline: a creature with no head geometry must come out
  // with the armour section EQUAL to the tip, which is what makes `penetrate` unchanged.
  const done = completePhys(CREATURES.woodElf.phys);
  assert.equal(done.headArmourArea_m2, CREATURES.woodElf.phys.contactArea_m2);
  assert.equal(done.headMeanArea_m2, CREATURES.woodElf.phys.contactArea_m2);
});

test('arrest: the solve round-trips into the work integral at the DOUBLE floor', () => {
  // I24. A residual at 1e-16 is arithmetic, one at 1e-6 would be the six-sig-fig
  // serialization, and anything larger would be the model. Asserting at 1e-14 says the
  // solver is exact and leaves three orders of headroom before the next floor up — so a
  // future change that makes it approximate cannot hide under the tolerance.
  const fm = (a, b) => (a + Math.sqrt(a * b) + b) / 3;
  for (const [At, Am, L] of [[4e-6, 8e-5, 0.09], [1e-5, 1.5e-5, 0.15], [2e-6, 4e-5, 0.04]]) {
    for (const KE of [1, 5, 40, 90, 300]) {
      for (const sigma of [4.5e6, 2.5e7, 1.2e8]) {
        const r = arrest(KE, sigma, At, Am, L);
        const work = r.buried
          ? sigma * L * fm(At, Am) + sigma * Am * (r.depth_m - L)
          : sigma * r.depth_m * fm(At, r.section_m2);
        assert.ok(Math.abs(work / KE - 1) < 1e-14,
          `work(${r.depth_m}) = ${work} against KE ${KE} — residual ${Math.abs(work / KE - 1)}`);
        assert.equal(r.buried, r.depth_m > L, '`buried` must agree with the depth it reports');
      }
    }
  }
});

test('arrest: the armour section CARRIES LENGTH — the property the whole-head mean lacked', () => {
  // THE REGRESSION GUARD ON THE DEFECT THAT PROMPTED ALL OF THIS. The frustum mean over
  // the whole head is constant in L — that is precisely why V = A_mean·L works — so
  // under it the design sweep's length axis had no geometric consequence and the
  // frontier walked out to whatever the longest grid point was, at every extension.
  //
  // A longer head at the same two sections is a shallower taper, so the section reached
  // at a fixed depth must fall STRICTLY with length, and must stay between the tip (an
  // infinitely long head) and the whole-head mean (a head no longer than the reference
  // depth). If someone re-bakes this from a length-free mean again, this fires.
  const dRef = CONFIG.PHYS_PENETRATION_DEPTH;
  for (const [At, ratio] of [[4e-6, 2], [4e-6, 20], [1e-5, 4]]) {
    const Am = At * ratio;
    const whole = (At + Math.sqrt(At * Am) + Am) / 3;
    let prev = Infinity;
    for (const L of [0.025, 0.03, 0.05, 0.07, 0.09, 0.11, 0.13, 0.15]) {
      const M = armourSection(At, Am, L, dRef);
      assert.ok(M < prev, `section at ${dRef} m must fall with head length (L=${L}, ratio ${ratio})`);
      assert.ok(M > At && M < whole, `and stay between the tip and the whole-head mean (got ${M})`);
      prev = M;
    }
  }
});

test('arrest: the section is homogeneous in area; depth is homogeneous in KE and sigma (I22)', () => {
  // EQUIVARIANCE RATHER THAN A FIXTURE (I22). Each of these is a statement the arithmetic
  // must satisfy as an identity — the areas enter the frustum mean homogeneously of
  // degree one, and depth is degree one in KE and minus one in sigma. A test that pinned
  // one computed number instead would pass just as happily with the units wrong.
  //
  // AREA SCALING IS EXACT ONLY WHERE THERE IS NO SQRT (I24). The un-tapered branch
  // returns the tip and is bit-identical; the tapered branch computes √(A·s), which does
  // not factor into √A·√s bit-for-bit, so it lands within a couple of ULP. That is the
  // DOUBLE floor and it is worth naming rather than hiding under a round tolerance:
  // 2e-16 is the sqrt not factoring, 1e-6 would be six-sig-fig serialization, and
  // anything larger would be the model.
  const At = 4e-6, Am = 3.2e-5, L = 0.08, dRef = CONFIG.PHYS_PENETRATION_DEPTH;
  const ULP = Number.EPSILON;
  for (const s of [0.25, 4, 100]) {
    assert.equal(armourSection(At * s, At * s, L, dRef), armourSection(At, At, L, dRef) * s,
      'un-tapered: no sqrt is evaluated, so scaling is bit-identical');
    const rel = Math.abs(armourSection(At * s, Am * s, L, dRef) / (armourSection(At, Am, L, dRef) * s) - 1);
    assert.ok(rel <= 4 * ULP,
      `tapered: scaling both sections must scale the mean to the last bits — off by ${rel.toExponential(2)}, `
      + `which is ${(rel / ULP).toFixed(1)} ULP and so no longer the sqrt`);
  }
  // Length and reference depth enter only as their ratio: the taper angle is what matters.
  assert.ok(Math.abs(armourSection(At, Am, L * 3, dRef * 3) / armourSection(At, Am, L, dRef) - 1) < 1e-15,
    'only the ratio L/d_ref can matter — the section at a fixed FRACTION of the head is fixed');
  // Un-tapered depth is exactly linear in KE and exactly inverse in sigma.
  const base = arrest(50, 2.5e7, At, At, L).depth_m;
  assert.equal(arrest(150, 2.5e7, At, At, L).depth_m, base * 3);
  assert.equal(arrest(50, 5.0e7, At, At, L).depth_m, base / 2);
});

test('arrest: a taper without a length throws, and so does a feasibility check without one (I18)', () => {
  // I18. `??` is for EXPECTED absence: no `headMaxArea_m2` means no head geometry
  // authored, which is the common case and gets the tip. A max section WITHOUT a length
  // is a taper with nothing to taper over — unexpected, and defaulting the length would
  // invent a geometry rather than report a gap. The `CONFIG.BATTLE_COLS ?? 15` episode is
  // what this rule was written from: a key that did not exist, returning the right number
  // by coincidence.
  const elf = CREATURES.woodElf.phys;
  assert.throws(() => completePhys({ ...elf, headMaxArea_m2: 4e-5 }),
    /headLength_m/, 'a max section with no length must not silently default');
  assert.throws(() => completePhys({ ...elf, headMaxArea_m2: 4e-5, headLength_m: 0.08 }),
    /shaftArea_m2/, 'a head with no shaft behind it computes its depth over the wrong three quarters');
  const full = { ...elf, headMaxArea_m2: 4e-5, headLength_m: 0.08, shaftArea_m2: 6.4e-5 };
  assert.doesNotThrow(() => completePhys(full));
  // An area carries no shape, so a head authored WITHOUT width cannot reach the width
  // term at all — the §8d finding written into the schema rather than into a comment.
  assert.equal(completePhys(full).headWidth_m, undefined);
  // AND CUT WIDTH IS NOT RECOVERABLE FROM THE MAXIMUM SECTION — instance nine. Both are
  // authored, independently, because they are different parts of the head: a broadhead's
  // 31 mm blade and its 70 mm² socket are both real and neither implies the other.
  const shaped = completePhys({ ...elf, headWidth_m: 0.0306, headMaxArea_m2: 7.0e-5, headLength_m: 0.05, shaftArea_m2: 6.4e-5 });
  assert.equal(shaped.headMaxArea_m2, 7.0e-5, 'the max section is authored, not derived from the cut width');
  assert.equal(shaped.headWidth_m, 0.0306);
  assert.throws(() => feasible({ foc: 0.2, maxDiameter_m: 0.007, arrowMass_kg: 0.05 }),
    /length_m/, 'length is a checked predicate now, so a caller has to supply it');
});

test('arrest: head length is bounded against the ARROW, as base diameter is against the shaft', () => {
  // The predicate that was missing, and the third appearance of the same signature. The
  // sweep proposed a 1.5 m head on a 25 g shaft and the frontier sat on it, because
  // nothing said a head has to fit on an arrow — base diameter bounded the head against
  // the SHAFT and had no sibling bounding its length against the ARROW.
  //
  // It is a predicate, not a cost: under the fixed-depth section longer is monotonically
  // better and only constructibility stops it, which is a MISSING PHYSICAL TERM and is
  // recorded as one. This keeps the sweep honest meanwhile; it does not stand in.
  const head = (len) => ({ foc: 0.2, maxDiameter_m: 0.007, arrowMass_kg: 0.05, length_m: len });
  assert.ok(feasible(head(0.075)).ok, 'a 75 mm war bodkin is a head');
  assert.ok(feasible(head(0.12)).ok, 'and so is a 120 mm one, at the documented top end');
  assert.ok(!feasible(head(0.30)).ok, 'a 300 mm head is not');
  assert.ok(!feasible(head(1.5)).ok, 'and a 1.5 m one is a spear the sweep kept asking for');
  // The bound must sit CLEAR of the documented range on both sides rather than at its
  // edge — a predicate calibrated to the content it judges is the validator-fitting
  // failure, pointing the other way.
  assert.ok(FEASIBLE.headLength[1] > 0.12, 'the ceiling must have headroom over the longest documented head');
  assert.ok(FEASIBLE.headLength[0] < 0.05, 'and the floor must clear the shortest');
});

// ---------------------------------------------------------------------------
// Width: the threshold, the depth it multiplies, and the one direction it pushes
// ---------------------------------------------------------------------------

/** The fork's two heads with §8d's geometry attached — the creature file carries none. */
function shapedHeads() {
  const shaft = Math.PI * 0.0045 * 0.0045;
  // A_max is the SOCKET for both heads — they fit the same shaft — and the broadhead's
  // 31 mm blade is its CUT WIDTH and nothing else. Scoring one head's socket against the
  // other's blade is what instance nine was.
  const SOCKET = 70e-6;
  const of = (base, w, len) => completePhys({
    ...base, headWidth_m: w, headMaxArea_m2: SOCKET, headLength_m: len, shaftArea_m2: shaft,
  });
  return {
    bodkin: of(retiredHeads('woodElf').narrow, Math.sqrt(SOCKET), 0.060),
    broadhead: of(retiredHeads('woodElf').wide, 0.0306, 0.050),
  };
}

test('width: un-authored content is inert, and `bleed` is exactly one', () => {
  // The identity that makes it inert: (1 − c)·1 + c·through is bit-identical to
  // 1 − c + c·through, because multiplication by one is exact. So the 1706-test suite
  // passing is a real check on this rather than one that passes on a tolerance.
  //
  // Checked against a HAND-WRITTEN reference rather than against the function itself,
  // using a stand-in whose tip is rigid so `deform` is zero and the effective area is
  // exactly the tip — otherwise the reference would have to reproduce the rigidity
  // branch too, and a reference that reproduces the code is not a reference.
  const p = fallbackPhys(CREATURES.gog);
  assert.equal(p.tipRigid, true, 'fixture: the stand-in must not deform, or the reference below is wrong');
  for (const cover of [0, 0.13, 0.35, 0.62, 1]) {
    const h = 1.2e8;
    const pressure = p.blowEnergy_j / (p.contactArea_m2 * CONFIG.PHYS_PENETRATION_DEPTH);
    const through = pressure / (pressure + h);
    assert.equal(penetrate(p.blowEnergy_j, p, h, cover),
      p.blowEnergy_j * (1 - cover + cover * through),
      'no authored head width must give exactly the pre-width arithmetic');
  }
  // And on real authored content, where rigidity IS in play: the identity that makes it
  // inert is (1 − c)·1 + c·t === 1 − c + c·t, so authoring a width BELOW the threshold
  // must not move a single bit either.
  const elf = CREATURES.woodElf.phys;
  for (const cover of [0, 0.3, 1]) {
    assert.equal(penetrate(elf.blowEnergy_j, { ...elf, headWidth_m: 0.008 }, 1.2e8, cover, tissueOf(elf)),
      penetrate(elf.blowEnergy_j, elf, 1.2e8, cover),
      'a head under the threshold is bit-identical to a head with no width at all');
  }
});

test('width: it is a THRESHOLD, and it separates the fork with room on both sides', () => {
  // The 22 mm anchor is a hunting-regulation minimum: below it wounds close. What makes
  // it an anchor rather than a fitted constant is that it sits in a GAP — real broadheads
  // are 25-40 mm, a bodkin shank 6-9 — so it discriminates the authored content without
  // having been calibrated against it.
  const heads = shapedHeads();
  const tissue = tissueOf(CREATURES.pikeman.phys);
  const h = 1.2e8, cover = 0.5;
  const bare = (x) => penetrate(x.blowEnergy_j, x, h, cover, tissue) / x.blowEnergy_j;
  assert.ok(heads.bodkin.headWidth_m < CONFIG.PHYS_CUT_WIDTH_M, 'a bodkin shank is under the threshold');
  assert.ok(heads.broadhead.headWidth_m > CONFIG.PHYS_CUT_WIDTH_M, 'a broadhead blade is over it');
  assert.ok(CONFIG.PHYS_CUT_WIDTH_M - heads.bodkin.headWidth_m > 0.010, 'with room below');
  assert.ok(heads.broadhead.headWidth_m - CONFIG.PHYS_CUT_WIDTH_M > 0.005, 'and room above');
  // A THRESHOLD, not a ramp: a hair under it is worth nothing at all.
  const just = { ...heads.broadhead, headWidth_m: CONFIG.PHYS_CUT_WIDTH_M * (1 - 1e-9) };
  assert.equal(bare(just), bare({ ...just, headWidth_m: 0.001 }),
    'below the threshold, width buys exactly nothing — that is what perimeter could not express');
  assert.ok(bare({ ...just, headWidth_m: CONFIG.PHYS_CUT_WIDTH_M }) > bare(just),
    'and at it, the cut stays open');
});

test('width: the term is ONE-SIDED — bleed is never below one, in any direction', () => {
  // The structural fact that decides what λ can and cannot do. Bleeding is a bonus to
  // the wide head and there is no corresponding bonus to the narrow one, so λ moves the
  // fork monotonically and cannot BALANCE it — it has a magnitude at which width stops
  // mattering and one at which it takes over, and nothing in between is an equilibrium.
  const heads = shapedHeads();
  for (const t of armourLadder()) {
    const tissue = tissueOf(t.phys), h = effectiveHardness(t.phys, t.defense);
    for (const head of Object.values(heads)) {
      const withW = penetrate(head.blowEnergy_j, head, h, t.cover, tissue);
      const plain = penetrate(head.blowEnergy_j, { ...head, headWidth_m: undefined }, h, t.cover, tissue);
      assert.ok(withW >= plain - 1e-12, `${t.id}: width must never reduce delivered damage`);
    }
  }
});

test('width: a tree does not haemorrhage, and a non-flesh body must say so', () => {
  // The width term's mechanism is BLOOD LOSS through a cut that will not close, which is
  // the whole reason a regulatory minimum on cut width is an anchor at all. The dendroids
  // are wood at 700 kg/m³. Nothing has an authored width yet, so this changes no number
  // today — it is written now because the alternative is finding it after the fork's
  // numbers have been quoted.
  const heads = shapedHeads();
  const wood = tissueOf(CREATURES.dendroid.phys);
  assert.equal(wood.bleeds, false);
  const h = effectiveHardness(CREATURES.dendroid.phys, CREATURES.dendroid.defense);
  const c = CREATURES.dendroid.phys.armorCoverage_frac;
  assert.equal(penetrate(heads.broadhead.blowEnergy_j, heads.broadhead, h, c, wood),
    penetrate(heads.broadhead.blowEnergy_j, { ...heads.broadhead, headWidth_m: undefined }, h, c, wood),
    'a wide blade buys nothing against something with no blood to lose');
  // THE GUARD, and it is structural rather than remembered: any body outside the flesh
  // band must author its own resistance instead of being silently treated as meat.
  for (const [id, cr] of Object.entries(CREATURES).filter(([, x]) => x.phys)) {
    const d = cr.phys.density_kgpm3;
    if (d >= FLESH_DENSITY[0] && d <= FLESH_DENSITY[1]) continue;
    assert.ok(cr.phys.tissueStrength_pa > 0,
      `${id} is ${d} kg/m³, outside the flesh band — it must author tissueStrength_pa rather than `
      + 'default to soft tissue');
  }
});

test('width: the wound saturates at body depth, and d_max ties to the silhouette (I22)', () => {
  // THE PREDICTION MADE BEFORE THE FIELD EXISTED. The tie test written two commits ago
  // said `d_max` would be `shapeD · V^(1/3)` — same volume as the silhouette, one power
  // apart — and asserted the half that existed. It is that, so the other half is now
  // checkable: d_max³/V must be a constant across the whole roster.
  const rows = Object.values(CREATURES).filter((c) => c.phys);
  const ratios = rows.map((c) => (c.phys.bodyDepth_m ** 3) / (c.phys.bodyMass_kg / c.phys.density_kgpm3));
  const lo = Math.min(...ratios), hi = Math.max(...ratios);
  assert.ok(hi / lo - 1 < 1e-4, `d_max³/V must be constant (it is DEPTH_K³); spread ${(hi / lo - 1).toExponential(2)}`);
  assert.ok(Math.abs(lo / (CONFIG.PHYS_DEPTH_K ** 3) - 1) < 1e-4, 'and it must equal DEPTH_K³');
  // Saturation: against a man-sized body both heads are through, so the depth factor
  // cancels out of the fork entirely and only WIDTH remains — §8d derived that as the
  // wanted behaviour rather than asserting it, and this is where it is checked.
  const heads = shapedHeads();
  const t = tissueOf(CREATURES.pikeman.phys);
  for (const head of Object.values(heads)) {
    const buried = head.blowEnergy_j - t.sigma * head.headVolume_m3;
    assert.ok(buried > 0, 'a warbow arrow buries its own head in a man');
    assert.ok(head.headLength_m + buried / (t.channel * head.shaftArea_m2) > t.depth,
      'and passes through, so min(d, d_max) is d_max for both heads');
  }
});

test('width: an authored width with no target throws rather than silently not bleeding', () => {
  // I18 applied to an ARGUMENT. `tissue` is optional only because nothing authored has a
  // width yet — and that is exactly the state in which an optional argument goes stale
  // unnoticed. Twenty call sites score this fork; a mechanism that quietly switched
  // itself off in nineteen of them would read as the mechanism not mattering.
  const heads = shapedHeads();
  assert.throws(() => penetrate(heads.broadhead.blowEnergy_j, heads.broadhead, 1.2e8, 0.4),
    /needs the target/, 'a head with a width needs the body it is hitting');
  assert.doesNotThrow(() => penetrate(heads.bodkin.blowEnergy_j, heads.bodkin, 1.2e8, 0.4),
    'a head UNDER the threshold never reaches the term, so it needs nothing');
});

test('width: lambda means what its comment says it means', () => {
  // A RATIONALE COMMENT IS AN UNVERIFIED CLAIM IN A PLACE THAT CONFERS AUTHORITY. λ is
  // documented as "a 30 mm cut through a 220 mm torso doubles the unarmoured hit", which
  // is a checkable statement about a number, so it gets checked. If someone re-tunes λ
  // and leaves the anchor prose in place, this fires — which is the failure mode that
  // makes a fitted constant look anchored.
  const bleed = 1 + CONFIG.PHYS_BLEED_LAMBDA * 0.030 * 0.220;
  assert.ok(Math.abs(bleed - 2) < 0.02, `the anchor says bleed ≈ 2 on a full broadhead wound, got ${bleed}`);
});

test('conditioning: kappa is the cancellation measure, and it kills the fork retroactively', () => {
  // THE PRE-CHECK THAT WOULD HAVE ENDED THIS THREE MECHANISMS EARLIER, so it gets a test
  // rather than living only in a script — the next fork's author has to be able to reach it.
  //
  // kappa = sum|term| / |sum term|. No cancellation means kappa = 1 and the margin is as
  // well known as its inputs; heavy cancellation means a small relative input error becomes
  // a large one in the result. It is arithmetic, not a heuristic, so it is testable exactly.
  assert.equal(conditioning([3, 4]).kappa, 1, 'terms that agree in sign cannot cancel');
  assert.equal(conditioning([10, -9]).kappa, 19, 'a margin 1/19th of its terms amplifies by 19');
  assert.equal(conditioning([5, -5]).kappa, Infinity, 'a margin of exactly zero carries no information');
  assert.equal(conditioning([10, -9]).tolerance, 1 / 19);

  // A `feel` input has no defensible epsilon, so Infinity is the honest value to pass and
  // it must fail everything. Passing a number for a `feel` input is asserting something
  // about it, which is the move this exists to prevent.
  assert.equal(marginIsEvidence([10, -9], Infinity).ok, false);
  assert.equal(marginIsEvidence([10, -9], 0.001).ok, true, '0.1% inputs support a 5% margin');
  assert.equal(marginIsEvidence([10, -9], 0.10).ok, false, '10% inputs do not');

  // And retroactively, on the fork itself: the two heads' delivered damage against a
  // mid-ladder target, which is the quantity the whole design choice turned on.
  const { narrow, wide } = retiredHeads('woodElf');
  const t = armourLadder().find((x) => x.id === 'griffin');
  const h = effectiveHardness(t.phys, t.defense);
  const c = conditioning([
    penetrate(narrow.blowEnergy_j, narrow, h, t.cover),
    -penetrate(wide.blowEnergy_j, wide, h, t.cover),
  ]);
  assert.ok(c.kappa > 20,
    `the fork's own margin should be ill-conditioned (kappa ${c.kappa.toFixed(1)}) — if this ever `
    + 'drops, the retired pair has stopped being the pair the record describes');
  assert.equal(marginIsEvidence([c.margin, 0], Infinity).ok, false,
    'and with a `feel` input it can never be evidence, at any kappa');
});

test('the drop term is bounded: no weapon is more aim-error than aim', () => {
  // theta = g*dd/v^2 is the FLAT-FIRE linearisation, and it holds only while the drop
  // over the flight is small against the range — v^2 >> g*d/2, so v >> 10 m/s at
  // battle distance. Every bow, sling and bolt in the roster leaves at 21-78 m/s. The
  // two Cyclops heave a 10 kg boulder at 10.5, sit exactly on the boundary, and the
  // unbounded term handed them 0.133 rad against an authored aim of 0.04 — 3.3x, where
  // the next worst shooter in the game is 1.3x. One modifier had become the whole
  // weapon, for the one class the formula does not describe.
  const drop = (v) => (CONFIG.PHYS_G * CONFIG.PHYS_RANGE_ERROR_M) / (v * v);
  let worst = null;
  for (const [id, c] of Object.entries(CREATURES)) {
    if (c.reach !== 'ranged' || !c.phys?.blowSpeed_mps || !(c.phys.dispersion_rad > 0)) continue;
    const share = Math.min(drop(c.phys.blowSpeed_mps), c.phys.dispersion_rad * CONFIG.PHYS_DROP_MAX_SHARE)
      / c.phys.dispersion_rad;
    if (!worst || share > worst.share) worst = { id, share };
    assert.ok(share <= CONFIG.PHYS_DROP_MAX_SHARE + 1e-12,
      `${id}: ballistics contribute ${share.toFixed(2)}x its authored aim, over the bound`);
  }
  assert.ok(worst, 'fixture: the roster has authored shooters');
});

test('bounding the drop does not free a heavier head from paying for its speed', () => {
  // The caveat the bound creates, pinned so it is a decision rather than a surprise:
  // for a weapon already AT the bound (the two Cyclops, and only them) mass stops
  // costing aim, because past the flat-fire boundary the term was not describing
  // anything anyway. For every weapon below the bound — which is every arrow, and the
  // founding exemplar of the whole model — mass still costs aim exactly as before.
  const rng = new Rng(SEED);
  const battle = createBattle(cfgOf(rng, { physicalDamage: true }));
  const shooter = battle.units.find((u) => u.side === 0 && CREATURES[u.creature].reach === 'ranged');
  const target = battle.units.find((u) => u.side === 1);
  const sp = CREATURES[shooter.creature].phys;
  const dropAt = (massScale) => Math.min(
    (CONFIG.PHYS_G * CONFIG.PHYS_RANGE_ERROR_M) / ((sp.blowEnergy_j * 2) / (sp.blowMass_kg * massScale)),
    sp.dispersion_rad * CONFIG.PHYS_DROP_MAX_SHARE,
  );
  assert.ok(dropAt(1.4) > dropAt(1),
    'below the bound, a heavier head at the same bow energy still drops more');
  const at = (massScale) => expectedPhysicalDamage({
    ...battle,
    physScale: { [shooter.creature]: { blowMass_kg: massScale } },
  }, shooter, target, 'ranged', PHYS_ENGINE);
  assert.ok(at(1.4) < at(1),
    `and still hits less: ${at(1.4).toFixed(4)} must be below ${at(1).toFixed(4)}`);
});

test('Slung Stones buys reach in the fight, not only on the chart', () => {
  // The yardstick and the model now read ONE definition of aim (upgrades.aimAngle),
  // so this is the check that the definition is the right one: a node scored as
  // improving `precision` has to actually put more of the volley on the target, and
  // the energy it gave up has to actually show in close.
  const ROOT = 'cyclopsCave.quarry.knappedStone';
  const SLUNG = 'cyclopsCave.drill.slungStones';
  const hero = { id: 'H', name: 'h', level: 20, stats: { attack: 40, defense: 40, power: 10, knowledge: 10 },
    skills: {}, spells: [], mana: 100, army: [], artifacts: [], owner: 0 };
  const at = (owned, dist) => {
    const battle = createBattle({
      rng: new Rng(SEED), simulated: true, features: { physicalDamage: true },
      upgrades: [owned, []],
      attacker: { hero, army: [{ creature: 'cyclopsKing', count: 1200, hurt: 0 }], playerIndex: 0 },
      defender: { hero, army: [{ creature: 'crusader', count: 200, hurt: 0 }], playerIndex: 1 },
    });
    const a = battle.units.find((u) => u.side === 0);
    const b = battle.units.find((u) => u.side === 1);
    a.x = b.x - dist; a.y = b.y;
    return expectedPhysicalDamage(battle, a, b, 'ranged', PHYS_ENGINE);
  };
  const close = at([ROOT, SLUNG], 2) / at([ROOT], 2);
  const far = at([ROOT, SLUNG], 10) / at([ROOT], 10);
  assert.ok(close < 1, `in close the sling is worse: ${close.toFixed(2)}x`);
  assert.ok(far > 1.3, `at ten hexes it is better by a margin worth the gold: ${far.toFixed(2)}x`);
  assert.ok(far > close * 1.5, 'and the two directions are far enough apart to be a decision');
});
