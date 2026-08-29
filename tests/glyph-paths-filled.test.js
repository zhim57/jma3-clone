/**
 * glyph-paths-filled.test.js — every path a glyph painter builds gets drawn.
 *
 * canvasKit.poly() BEGINS a new path, so a poly-poly-fill sequence rasterises
 * only the last polygon and silently discards the rest. Procedural art is this
 * project's product, so a discarded path is a visible defect, not a nit: the
 * dungeon town shipped without its five cavern stalactites, and the tradeFair
 * awning shipped with one stripe out of four (S30 — both confirmed by running
 * the painters against a recording context).
 *
 * The dungeon painter is exported (TOWN_PAINTERS), so its guard EXECUTES the
 * real code: every beginPath must be consumed by a fill or a stroke before the
 * next beginPath discards it. tradeFair lives inside registerMapObjectSprites,
 * which needs a DOM canvas — that one is pinned by a source guard instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TOWN_PAINTERS } from '../src/gfx/tokens.js';

/** A 2D-context stand-in that reports paths begun but never drawn. */
function auditingCtx() {
  const audit = { begun: 0, drawn: 0, discarded: 0 };
  let open = false; // a path is open and not yet filled/stroked
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(_t, k) {
      if (k === '_audit') return audit;
      if (k === 'beginPath') {
        return () => { if (open) audit.discarded++; open = true; audit.begun++; };
      }
      if (k === 'fill' || k === 'stroke') {
        return () => { if (open) audit.drawn++; open = false; };
      }
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      // fillRect/strokeRect/setters/etc: irrelevant to path accounting.
      return () => {};
    },
    set() { return true; },
  });
  return ctx;
}

test('every town glyph fills or strokes each path it begins', () => {
  for (const [town, painter] of Object.entries(TOWN_PAINTERS)) {
    const ctx = auditingCtx();
    painter(ctx);
    const a = ctx._audit;
    assert.equal(a.discarded, 0,
      `${town}: ${a.discarded} of ${a.begun} paths were begun and then discarded by the next beginPath — `
      + 'fill each shape as it is built (the dungeon stalactites bug)');
  }
});

test('tradeFair fills each awning stripe inside the loop', () => {
  const src = readFileSync(new URL('../src/gfx/tokens.js', import.meta.url), 'utf8');
  const at = src.indexOf('tradeFair:');
  assert.ok(at >= 0);
  const body = src.slice(at, src.indexOf('},', at));
  // The stripe loop must carry its own fill — one fill after the loop keeps
  // only the last stripe.
  assert.match(body, /for \(const sx of \[17, 27, 37, 47\]\) \{ poly\([\s\S]*?ctx\.fill\(\); \}/,
    'the fill belongs inside the stripe loop');
});
