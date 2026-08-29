/**
 * terrain-clip.test.js — the cohesion-pass clip must never change WHAT is drawn.
 *
 * AdventureScene bakes terrain in 2048px chunks, and the three whole-map
 * cohesion passes (paintMacroVariation, paintGroundCover, paintRoads) run once
 * per chunk under the chunk's translate so their geometry aligns across chunk
 * seams. The `clip` rect they now accept exists purely so most of that repeated
 * work can be SKIPPED — on the 144×120 preset ~95% of it used to be painted and
 * then discarded by the canvas edge, a multi-second stall on every level flip.
 *
 * The contract these tests pin down, per pass, against a recording context:
 *
 *   1. SUBSEQUENCE — every draw the clipped run makes appears, byte-identical
 *      and in order, in the unclipped run. The clip may only remove work, never
 *      add, reorder or alter it. For the two rng-fed passes this is the
 *      determinism guard: if a skipped element failed to advance the stream,
 *      every draw AFTER it would shift and this assertion would fail loudly.
 *   2. COMPLETENESS — every unclipped draw whose painted extent touches the
 *      clip rectangle survives into the clipped run. Anything skipped could
 *      only ever have painted pixels the chunk does not show, which is why a
 *      clipped bake is pixel-identical to an unclipped one (the browser-side
 *      pixel comparison lives in tests/smoke/terrain-clip-smoke.mjs).
 *
 * The recording context is DOM-free (gradients become plain descriptor objects,
 * strokes record their accumulated path), so this runs under node --test like
 * the rest of the suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paintMacroVariation, paintGroundCover, paintRoads } from '../src/gfx/terrain.js';

// ---------------------------------------------------------------------------
// A 2D-context stand-in that records every fill/stroke with (a) a full
// serialization of its arguments + current style and (b) the world-space
// bounding box of what it would have painted.
// ---------------------------------------------------------------------------
function recordingCtx() {
  const ops = [];
  let fillStyle = null;
  let strokeStyle = null;
  let lineWidth = 1;
  let path = []; // points of the path being built
  const ctx = {
    save() {}, restore() {},
    set fillStyle(v) { fillStyle = v; }, get fillStyle() { return fillStyle; },
    set strokeStyle(v) { strokeStyle = v; }, get strokeStyle() { return strokeStyle; },
    set lineWidth(v) { lineWidth = v; }, get lineWidth() { return lineWidth; },
    set lineCap(v) {}, get lineCap() { return 'round'; },
    set lineJoin(v) {}, get lineJoin() { return 'round'; },
    set globalCompositeOperation(v) { this._gco = v; }, get globalCompositeOperation() { return this._gco; },
    createRadialGradient(x, y, r0, x1, y1, r1) {
      const g = { kind: 'radial', args: [x, y, r0, x1, y1, r1], stops: [] };
      g.addColorStop = (t, c) => g.stops.push([t, c]);
      return g;
    },
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    arc(x, y, r) { path.push([x - r, y - r], [x + r, y + r]); },
    closePath() {},
    fillRect(x, y, w, h) {
      ops.push({
        key: JSON.stringify(['fillRect', x, y, w, h, fillStyle, ctx._gco ?? null]),
        bbox: [x, y, x + w, y + h],
      });
    },
    fill() {
      const bbox = pathBBox(path, 0);
      ops.push({ key: JSON.stringify(['fill', path, fillStyle]), bbox });
    },
    stroke() {
      // Round caps/joins pad the path's extent by half the stroke width.
      const bbox = pathBBox(path, lineWidth / 2);
      ops.push({ key: JSON.stringify(['stroke', path, strokeStyle, lineWidth]), bbox });
    },
  };
  return { ctx, ops };
}

function pathBBox(pts, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

const intersects = (b, c) => b[2] >= c.x0 && b[0] <= c.x1 && b[3] >= c.y0 && b[1] <= c.y1;

// ---------------------------------------------------------------------------
// A deterministic synthetic map, big enough to span several 32-tile chunks so
// the clip actually cuts something (40×40 tiles at size 64 = 2560px square).
// ---------------------------------------------------------------------------
function syntheticMap(w = 40, h = 40) {
  const terrains = ['grass', 'dirt', 'water', 'snow', 'lava', 'swamp'];
  const tiles = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = x * 7 + y * 131;
      tiles.push({
        terrain: terrains[n % terrains.length],
        decor: (n * 2654435761) >>> 16,
        obstacle: n % 5 === 0 ? (n % 10 === 0 ? 'tree' : 'rock') : null,
        road: n % 7 === 0 ? (n % 14 === 0 ? 'cobble' : 'dirt') : null,
      });
    }
  }
  return { w, h, tiles };
}

const SIZE = 64;
// A middle chunk (tiles 8..24 in both axes): interior clips are the sharp case,
// since work can be skipped on all four sides of them.
const CLIP = { x0: 8 * SIZE, y0: 8 * SIZE, x1: 24 * SIZE, y1: 24 * SIZE };

function runBoth(paintFn) {
  const map = syntheticMap();
  const full = recordingCtx();
  paintFn(full.ctx, map, SIZE);
  const clipped = recordingCtx();
  paintFn(clipped.ctx, map, SIZE, CLIP);
  return { full: full.ops, clipped: clipped.ops };
}

function assertClipContract(name, { full, clipped }) {
  // (1) The clipped run is an ordered, byte-identical subsequence of the full run.
  let fi = 0;
  for (const op of clipped) {
    while (fi < full.length && full[fi].key !== op.key) fi++;
    assert.ok(fi < full.length,
      `${name}: clipped run drew something the unclipped run never drew (or drew it out of order) — `
      + `the clip altered the rng stream or the draw itself: ${op.key.slice(0, 120)}`);
    fi++;
  }
  // (2) Every full-run draw that touches the clip rect survives.
  const clippedKeys = new Set(clipped.map((o) => o.key));
  for (const op of full) {
    if (!intersects(op.bbox, CLIP)) continue;
    assert.ok(clippedKeys.has(op.key),
      `${name}: a draw overlapping the clip rect was skipped — visible paint lost: ${op.key.slice(0, 120)}`);
  }
  // And the clip must actually be worth having: on a map this much larger than
  // the clip, most of the work should be skipped.
  assert.ok(clipped.length < full.length * 0.6,
    `${name}: clip skipped almost nothing (${clipped.length}/${full.length}) — the optimisation is dead`);
}

test('paintMacroVariation: clip skips draws without touching the rng stream', () => {
  assertClipContract('paintMacroVariation', runBoth(paintMacroVariation));
});

test('paintGroundCover: clip skips both passes safely (per-tile AND sequential rng)', () => {
  assertClipContract('paintGroundCover', runBoth(paintGroundCover));
});

test('paintRoads: clip bounds the scan without dropping any spur that reaches the chunk', () => {
  assertClipContract('paintRoads', runBoth(paintRoads));
});

test('no clip means the full paint — the default is the pre-clip behaviour', () => {
  const map = syntheticMap(12, 12); // small map, cheap
  for (const fn of [paintMacroVariation, paintGroundCover, paintRoads]) {
    const a = recordingCtx(); fn(a.ctx, map, SIZE);
    const b = recordingCtx(); fn(b.ctx, map, SIZE, null);
    assert.deepEqual(b.ops.map((o) => o.key), a.ops.map((o) => o.key),
      `${fn.name}: omitting clip and passing null must be the same full paint`);
  }
});
