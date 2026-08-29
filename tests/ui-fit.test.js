/**
 * ui-fit.test.js — the shared text-fitting primitives that stop long labels
 * overflowing their boxes ("111111111 Royal Griffins" painted over its
 * neighbours). fmtCount compacts the number; fitText shrinks then ellipsises.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtCount, fitText, fitLines } from '../src/ui/uikit.js';

/** A stand-in for a Phaser text object: width is proportional to chars × size. */
function stubText(text, size = 14, pxPerChar = 0.6) {
  return {
    text,
    style: { fontSize: `${size}px` },
    _size: size,
    get width() { return this.text.length * this._size * pxPerChar; },
    setFontSize(px) { this._size = px; this.style.fontSize = `${px}px`; return this; },
    setText(t) { this.text = t; return this; },
  };
}

test('fmtCount keeps small numbers exact — precision where it matters', () => {
  assert.equal(fmtCount(0), '0');
  assert.equal(fmtCount(7), '7');
  assert.equal(fmtCount(1234), '1234');
  assert.equal(fmtCount(9999), '9999', 'exact right up to the 10k threshold');
});

test('fmtCount compacts the counts that blow out a line', () => {
  assert.equal(fmtCount(10000), '10k');
  assert.equal(fmtCount(32000), '32k');
  assert.equal(fmtCount(1500000), '1.5M');
  assert.equal(fmtCount(111111111), '111M', 'the reported case: 9 digits become 4 chars');
  assert.equal(fmtCount(40000000), '40M');
  assert.equal(fmtCount(2500000000), '2.5B');
});

test('fmtCount survives junk instead of rendering NaN', () => {
  assert.equal(fmtCount(undefined), '0');
  assert.equal(fmtCount(null), '0');
  assert.equal(fmtCount('nonsense'), '0');
});

test('fitText shrinks the font until the text fits', () => {
  const t = stubText('Royal Griffins ×111M', 14);
  fitText(t, 130);
  assert.ok(t.width <= 130, 'it fits');
  assert.ok(t._size < 14, 'by shrinking');
  assert.equal(t.text, 'Royal Griffins ×111M', 'without mangling the words');
});

test('fitText leaves text that already fits completely alone', () => {
  const t = stubText('Save', 15);
  const before = t._size;
  fitText(t, 400);
  assert.equal(t._size, before, 'no needless shrinking');
  assert.equal(t.text, 'Save');
});

test('fitText ellipsises as a last resort, never overflows', () => {
  const t = stubText('An extremely long label that cannot possibly fit anywhere', 14);
  fitText(t, 40, 9);
  assert.ok(t.width <= 40, `stays inside its box (got ${t.width})`);
  assert.ok(t.text.endsWith('…'), 'marked as clipped');
  assert.ok(t._size >= 9, 'never shrinks past the legibility floor');
});

test('fitText is defensive about bad input', () => {
  assert.equal(fitText(null, 100), null);
  const t = stubText('x');
  assert.equal(fitText(t, 0), t, 'a zero/absent width is a no-op, not a crash');
});

// ---------------------------------------------------------------------------
// fitLines — the dialog-body clamp (S35). showDialog clamps its PANEL to the
// viewport; fitLines decides how many measured body lines fit the band left
// between the chrome and the button row, reserving space for the "+N more"
// marker whenever anything is cut — a silent cut painted the tail of long
// dialogs under the buttons' opaque backgrounds.
// ---------------------------------------------------------------------------

test('fitLines shows everything when everything fits', () => {
  const r = fitLines([20, 20, 20], 100);
  assert.deepEqual(r, { shown: 3, hidden: 0 });
});

test('fitLines cuts visibly: room for the marker is part of the budget', () => {
  // 5 × 24px-with-gap lines against 80px: without a marker three would fit
  // (3×24 = 72), but the marker's 22px must also fit, so only two survive.
  const r = fitLines([20, 20, 20, 20, 20], 80);
  assert.equal(r.shown, 2);
  assert.equal(r.hidden, 3);
});

test('fitLines never lies about the total: shown + hidden covers every line', () => {
  for (const avail of [0, 10, 50, 90, 200, 1000]) {
    const heights = [30, 14, 60, 22, 22];
    const { shown, hidden } = fitLines(heights, avail);
    assert.equal(shown + hidden, heights.length, `at availH=${avail}`);
  }
});

test('fitLines survives a window too short for anything', () => {
  const r = fitLines([40, 40], 8);
  assert.equal(r.shown, 0, 'nothing fits');
  assert.equal(r.hidden, 2, 'and the marker will say so');
});
