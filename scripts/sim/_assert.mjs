/**
 * _assert.mjs — the structural invariants an instrument can check on ITSELF.
 *
 * EXIT STATUS CATCHES CRASHES, NOT CORRUPTION. `tests/sim-scripts.test.js` runs every fast
 * instrument and asserts it exits zero, which was written after two of them broke silently
 * — but an instrument that runs and prints wrong numbers still exits zero. That is the same
 * failure mode one layer up, and it is the more dangerous one, because a crash announces
 * itself and a wrong number goes into the record.
 *
 * THE MIDDLE OPTION, AND IT DOES NOT REQUIRE PINNING ANY MEASUREMENT. Asserting an
 * instrument's OUTPUT would defeat it: a sweep exists to discover numbers, and a test that
 * fails when a measurement changes is a test against measuring. But several of these
 * scripts compute quantities that are not measurements at all — they are PROPERTIES OF THE
 * MODEL, true by construction, and false only if something is broken:
 *
 *   the sweep's control at exactly +0.0%      an all-un-authored matchup must not diverge
 *   ρ invariant under energy scaling          E_stored cancels out of a ratio
 *   the frustum-mean tie                      ∫A dx over [0,L] IS the whole-head mean
 *   the equivariance triple                   areas scale, energy leaves h* alone
 *   bleed ≥ 1                                 the width term is one-sided
 *   an un-tapered head is bit-identical       (A + √(A·A) + A)/3 = A
 *
 * None of those is a discoverable number. Every one of them fires if the model is
 * corrupted, and none of them fires when a measurement legitimately moves. So: assert those
 * where they exist, exit status everywhere else.
 *
 * Deliberately not `node:assert` — these run as scripts, and a stack trace is the wrong
 * output for a tool whose job is to print a report. The message names the invariant.
 */

let checked = 0;

/** Assert a structural property of the model. Exits non-zero, loudly, with no stack. */
export function structural(ok, what) {
  checked++;
  if (ok) return;
  console.error(`\n  STRUCTURAL INVARIANT FAILED: ${what}`);
  console.error('  This is not a measurement that moved — it is a property that must hold by');
  console.error('  construction. The instrument is reporting corruption, not a finding.\n');
  process.exit(1);
}

/** Exactly equal, for the invariants that are exact and must be checked as exact (I24). */
export function structuralEq(a, b, what) {
  structural(Object.is(a, b), `${what} — got ${a}, expected ${b}`);
}

/** Within a stated relative tolerance, with the tolerance named so it cannot drift. */
export function structuralNear(a, b, rel, what) {
  structural(Math.abs(a / b - 1) <= rel,
    `${what} — got ${a} against ${b}, off by ${(Math.abs(a / b - 1)).toExponential(2)} > ${rel}`);
}

/** Print what was verified, so a silent instrument cannot be mistaken for a checked one. */
export function structuralSummary() {
  console.log(`\n  [${checked} structural invariant(s) held — see scripts/sim/_assert.mjs]`);
}
