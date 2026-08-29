/**
 * derive-physical.mjs — compute the derived physical quantities offline and
 * write them back into src/data/creatures.js as plain numbers.
 *
 * WHY THIS EXISTS AT ALL. Two of the physical model's quantities are honest
 * fractional-exponent physics:
 *
 *   frontalArea_m2      = SHAPE_K · (bodyMass_kg / density_kgpm3)^(2/3)
 *   velRetainPerHex_ratio  = exp(−AIR_K · HEX_METERS / ballisticCoeff_kgpm2)
 *
 * A ⅔ power and an exponential. ECMA-262 leaves the precision of `pow`, `exp`,
 * `log` and the trig functions **implementation-defined** — two engines, or two
 * V8 versions, may differ in the last bits — so a damage number computed from
 * one is not bit-identical across machines. That is fine for a silhouette area
 * and fatal for a game whose whole working method is "same seed, same result".
 *
 * So the fractional exponents are evaluated exactly once, here, on one machine,
 * and the answers are committed as literals. The runtime model then uses
 * + - * / and Math.min/max/round only, and drag over N hexes is N
 * multiplications by a stored constant rather than one `pow` call. The cost is
 * this script and the discipline of re-running it; the return is a damage model
 * that reproduces anywhere.
 *
 * Usage:
 *   node scripts/data/derive-physical.mjs           # rewrite creatures.js in place
 *   node scripts/data/derive-physical.mjs --check   # exit 1 if anything is stale
 *
 * `deriveFrom` is exported so tests/data-integrity.test.js can re-derive and
 * assert the committed numbers still match — which is what actually keeps the
 * two in step, since nothing forces anyone to run a script.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { completePhys } from '../../src/core/headGeometry.js';
import { CREATURES } from '../../src/data/creatures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CREATURES_PATH = join(HERE, '..', '..', 'src', 'data', 'creatures.js');

/** Significant digits kept in the file. Six is well inside double precision and
 *  keeps the literals readable — these are engineering numbers, not constants. */
const SIG = 6;
const round = (x) => Number(x.toPrecision(SIG));

/**
 * The derived block for one authored `phys`. The ONLY place either formula is
 * written down; the runtime never re-derives, it reads.
 */
export function deriveFrom(phys) {
  // ONE PIPELINE, SHARED WITH STAND-INS. The formulae used to live here and synthetic
  // heads re-derived them by hand — which is how `heads.mjs` scored a head carrying the
  // ORIGINAL `blowSpeed_mps` alongside a new mass and energy. I14 catches fields that
  // are MISSING; nothing caught a field that was present and inconsistent. So the
  // derivation moved to `src/core/headGeometry.js` and both callers go through it: an
  // impossible velocity is now a state that cannot be constructed rather than a bug to
  // be caught. The rounding stays here, because it is a property of the FILE — the
  // runtime wants full precision.
  const d = completePhys(phys);
  return {
    frontalArea_m2: round(d.frontalArea_m2),
    velRetainPerHex_ratio: round(d.velRetainPerHex_ratio),
    armorHardness_pa: round(d.armorHardness_pa),
    blowSpeed_mps: round(d.blowSpeed_mps),
    bodyDepth_m: round(d.bodyDepth_m),
  };
}

/** The derived keys, in the order they are written. */
export const DERIVED_KEYS = ['frontalArea_m2', 'velRetainPerHex_ratio', 'armorHardness_pa',
  'blowSpeed_mps', 'bodyDepth_m'];

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

/**
 * Find creature `id`'s `phys: { … }` span in the source text. Brace-counted
 * rather than regexed, because a regex that matches a nested object literal is
 * a regex that will one day match the wrong one.
 */
function physSpan(src, id) {
  const at = src.indexOf(`\n  ${id}: {`);
  if (at < 0) throw new Error(`creature "${id}" not found in creatures.js`);
  const physAt = src.indexOf('phys: {', at);
  if (physAt < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', physAt); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return { start: physAt, end: i + 1 }; }
  }
  throw new Error(`unterminated phys block for "${id}"`);
}

/** Rewrite the derived line inside one phys block. Returns the new source. */
function writeBlock(src, id, derived) {
  const span = physSpan(src, id);
  if (!span) return src;
  const block = src.slice(span.start, span.end);
  const line = DERIVED_KEYS.map((k) => `${k}: ${derived[k]}`).join(', ');
  const indent = (block.match(/\n(\s+)\w/) || [null, '      '])[1];

  // Every authored block carries the marker comment; replacing the line under
  // it keeps hand-written ordering and comments intact.
  const marked = /(DERIVED — scripts\/data\/derive-physical\.mjs[^\n]*\n)[^\n]*\n/;
  const next = marked.test(block)
    ? block.replace(marked, `$1${indent}${line},\n`)
    // No marker: a freshly authored block. Splice the derived line in before the
    // closing brace so a new creature needs the authored fields only.
    : block.replace(/\n(\s*)\}$/, `\n${indent}// DERIVED — scripts/data/derive-physical.mjs writes these; do not hand-edit.\n${indent}${line},\n$1}`);
  return src.slice(0, span.start) + next + src.slice(span.end);
}

function main() {
  const check = process.argv.includes('--check');
  let src = readFileSync(CREATURES_PATH, 'utf8');
  const covered = Object.entries(CREATURES).filter(([, c]) => c.phys);
  const stale = [];

  for (const [id, c] of covered) {
    const want = deriveFrom(c.phys);
    if (DERIVED_KEYS.some((k) => c.phys[k] !== want[k])) {
      stale.push(`${id}: ${DERIVED_KEYS.map((k) => `${k} ${c.phys[k]} → ${want[k]}`).join(', ')}`);
    }
    src = writeBlock(src, id, want);
  }

  if (check) {
    if (stale.length) {
      console.error(`${stale.length} creature(s) have stale derived physics:`);
      stale.forEach((s) => console.error('  ' + s));
      console.error('Run: node scripts/data/derive-physical.mjs');
      process.exit(1);
    }
    console.log(`derive-physical --check: ${covered.length} creature(s) up to date.`);
    return;
  }

  writeFileSync(CREATURES_PATH, src);
  console.log(`derive-physical: ${covered.length} creature(s) covered, ${stale.length} rewritten.`);
  stale.forEach((s) => console.log('  ' + s));
}

// Importable without side effects — the data-integrity suite pulls `deriveFrom`
// out of here so the script's formulas, not a copy of them, are what the test
// checks against.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
