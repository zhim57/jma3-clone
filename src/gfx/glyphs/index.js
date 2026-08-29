/**
 * glyphs/index.js — Vector icon library (creatures, artifacts).
 *
 * Every creature/artifact names a `glyph` in its data entry; the painter here
 * draws it centered in an s×s box. Style: bold ivory silhouette with dark
 * outline + one accent color, tuned to read at 40px.
 *
 * HOW TO ADD A GLYPH: add a function to the relevant sub-module (weapons.js,
 * creatures.js, artifacts.js) keyed by the name you used in the data file. It
 * receives (ctx, s, c) where c = { fill, ink, accent }. Draw within [0..s]x
 * [0..s]; the token painter handles background/scaling. Shared silhouettes and
 * fill/stroke helpers live in primitives.js.
 *
 * The sub-modules are merged here into a single GLYPHS map. Glyphs that compose
 * other glyphs (hornedDemon → demon, wonderarmor → breastplate, and the sword
 * fallback below) import THIS merged map, so cross-references resolve against
 * the whole registry rather than a single sub-module.
 */

import { weapons } from './weapons.js';
import { creatures } from './creatures.js';
import { artifacts } from './artifacts.js';

export const GLYPHS = {
  // ======================= weapons / simple arms =======================
  ...weapons,
  // ======================= creatures =======================
  ...creatures,
  // ======================= artifacts =======================
  ...artifacts,
};

/** Draw glyph `key` (fallback: sword) into an s×s box. */
export function drawGlyph(ctx, key, s, colors) {
  const fn = GLYPHS[key] || GLYPHS.sword;
  fn(ctx, s, colors);
}
