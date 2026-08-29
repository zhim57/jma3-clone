/**
 * glyphs/primitives.js — Shared low-level painters used across the glyph
 * modules. These are NOT glyphs themselves (they aren't keyed in GLYPHS); they
 * are the building blocks (fill/stroke helpers + reusable silhouettes) that the
 * weapon/creature/artifact painters compose from.
 *
 * Every painter draws within [0..s]x[0..s] using the same c = { fill, ink,
 * accent } color context the glyphs receive.
 */

export function stroked(ctx, c, fn, lw = 2.5) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  fn();
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = lw;
  ctx.stroke();
}

export function lineArt(ctx, c, fn, lw = 4) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = lw + 2.5;
  fn();
  ctx.stroke();
  ctx.strokeStyle = c.fill;
  ctx.lineWidth = lw;
  fn();
  ctx.stroke();
}

/** Feathered wing sweeping from (x,y). dir=1 right, -1 left. */
export function wing(ctx, x, y, span, dir, c) {
  stroked(ctx, c, () => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + dir * span * 0.55, y - span * 0.72, x + dir * span, y - span * 0.34);
    ctx.quadraticCurveTo(x + dir * span * 0.62, y - span * 0.18, x + dir * span * 0.60, y + span * 0.02);
    ctx.quadraticCurveTo(x + dir * span * 0.38, y + span * 0.10, x + dir * span * 0.40, y + span * 0.26);
    ctx.quadraticCurveTo(x + dir * span * 0.16, y + span * 0.26, x, y + span * 0.16);
    ctx.closePath();
  }, 2);
}

export function trident(ctx, s, c, ornate = false) {
  const cx = s / 2;
  lineArt(ctx, c, () => {
    ctx.beginPath();
    ctx.moveTo(cx, s * 0.88);
    ctx.lineTo(cx, s * 0.34);
  });
  stroked(ctx, c, () => {
    ctx.beginPath();
    // center prong
    ctx.moveTo(cx - 2.5, s * 0.36);
    ctx.lineTo(cx - 2.5, s * 0.2);
    ctx.lineTo(cx, s * 0.1);
    ctx.lineTo(cx + 2.5, s * 0.2);
    ctx.lineTo(cx + 2.5, s * 0.36);
    ctx.closePath();
  }, 2);
  for (const dir of [-1, 1]) {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(cx + dir * 3, s * 0.4);
      ctx.quadraticCurveTo(cx + dir * s * 0.2, s * 0.42, cx + dir * s * 0.2, s * 0.26);
      ctx.lineTo(cx + dir * s * 0.2 - dir * 1, s * 0.15);
      ctx.lineTo(cx + dir * s * 0.14, s * 0.28);
      ctx.quadraticCurveTo(cx + dir * s * 0.13, s * 0.34, cx + dir * 2, s * 0.35);
      ctx.closePath();
    }, 2);
  }
  if (ornate) {
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(cx, s * 0.5, 3.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function houndHead(ctx, x, y, sc, c) {
  stroked(ctx, c, () => {
    ctx.beginPath();
    ctx.moveTo(x - 14 * sc, y + 10 * sc);            // neck base
    ctx.quadraticCurveTo(x - 16 * sc, y - 8 * sc, x - 6 * sc, y - 12 * sc); // back of skull
    ctx.lineTo(x - 2 * sc, y - 20 * sc);             // ear tip
    ctx.lineTo(x + 3 * sc, y - 11 * sc);             // ear front
    ctx.quadraticCurveTo(x + 14 * sc, y - 8 * sc, x + 18 * sc, y - 1 * sc); // snout top
    ctx.lineTo(x + 10 * sc, y + 1 * sc);             // mouth notch
    ctx.lineTo(x + 15 * sc, y + 6 * sc);             // jaw
    ctx.quadraticCurveTo(x + 2 * sc, y + 12 * sc, x - 4 * sc, y + 12 * sc);
    ctx.closePath();
  }, 2);
  ctx.fillStyle = c.accent;
  ctx.beginPath();
  ctx.arc(x + 1 * sc, y - 4 * sc, 1.8 * sc, 0, Math.PI * 2);
  ctx.fill();
}

export function swordPath(ctx, s, cx, tilt) {
  ctx.save();
  ctx.translate(cx, s / 2);
  ctx.rotate(tilt);
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.40);          // tip
  ctx.lineTo(4, -s * 0.30);
  ctx.lineTo(4, s * 0.14);           // blade right
  ctx.lineTo(12, s * 0.17);          // guard right
  ctx.lineTo(12, s * 0.22);
  ctx.lineTo(4, s * 0.22);
  ctx.lineTo(3, s * 0.36);           // grip
  ctx.lineTo(-3, s * 0.36);
  ctx.lineTo(-4, s * 0.22);
  ctx.lineTo(-12, s * 0.22);
  ctx.lineTo(-12, s * 0.17);
  ctx.lineTo(-4, s * 0.14);
  ctx.lineTo(-4, -s * 0.30);
  ctx.closePath();
  ctx.restore();
}
