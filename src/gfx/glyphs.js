/**
 * glyphs.js — Vector icon library (creatures, artifacts).
 *
 * Thin re-export shim. The registry was split into glyphs/{primitives,weapons,
 * creatures,artifacts}.js and re-merged by glyphs/index.js; this file preserves
 * the historical import path (`./glyphs.js` → GLYPHS, drawGlyph) for callers.
 */

export * from './glyphs/index.js';
