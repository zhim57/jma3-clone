/**
 * canvasKit.js — Tiny helpers over raw Canvas2D used by all texture painters.
 *
 * All game art is generated at boot from vector drawing code (gradients,
 * beziers, soft shadows) — no bitmap assets, no pixel art. Painters receive
 * a ctx and draw into a WxH box; TextureFactory registers the canvases with
 * Phaser. Deterministic: any randomness comes from a seeded stream.
 */

import { mulberry32 } from '../core/rng.js';

/**
 * Create a CPU-backed 2D canvas.
 *
 * `willReadFrequently: true` is load-bearing, not a micro-optimisation: Chrome
 * GPU-accelerates large canvases, and an accelerated canvas silently loses ALL
 * its contents whenever the GPU process resets — taking the WebGL context with
 * it (`CONTEXT_LOST_WEBGL`). Our 2816x2304 terrain canvas tripped exactly that,
 * leaving every texture rendering as a black quad in Chrome (Edge's thresholds
 * differ, so it looked fine there). We paint each canvas once and upload it, so
 * CPU backing is both correct and faster for this access pattern.
 *
 * The 2D context is created HERE so the attribute takes effect: `getContext`
 * ignores its options on every call after the first.
 */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d', { willReadFrequently: true });
  return c;
}

/** Paint into a fresh canvas and return it. */
export function paint(w, h, fn) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  fn(ctx, w, h);
  return c;
}

export function rgba(hex, a = 1) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  return `rgba(${r},${g},${b},${a})`;
}

/** Lighten/darken a 0xRRGGBB color by f (-1..1). */
export function shade(hex, f) {
  const ch = (v) => Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  const r = ch((hex >> 16) & 255), g = ch((hex >> 8) & 255), b = ch(hex & 255);
  return (r << 16) | (g << 8) | b;
}

/** Linear blend between two 0xRRGGBB colors (t in 0..1). */
export function mix(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function linGrad(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

export function radGrad(ctx, x, y, r0, r1, stops) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

export function poly(ctx, pts, close = true) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (close) ctx.closePath();
}

/** Rounded polygon path through points (soft corners, radius r). */
export function softPoly(ctx, pts, r = 3) {
  ctx.beginPath();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    if (i === 0) ctx.moveTo((x0 + x1) / 2, (y0 + y1) / 2);
    else ctx.arcTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, r);
  }
  ctx.closePath();
}

export function star(ctx, cx, cy, spikes, outerR, innerR, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = rot + (i * Math.PI) / spikes;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Seeded random stream for deterministic texture noise. */
export function noiseRng(seed) {
  const next = mulberry32(seed);
  return {
    f: () => next(),
    range: (a, b) => a + next() * (b - a),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

/** Soft drop shadow around subsequent drawing; call resetShadow after. */
export function withShadow(ctx, color, blur, dx = 0, dy = 2) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = dx;
  ctx.shadowOffsetY = dy;
}

export function resetShadow(ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}
