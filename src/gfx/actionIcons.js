/**
 * actionIcons.js — Procedural pictograms for the combat control bar.
 *
 * The battle buttons (Wait, Defend, Spellbook, Resurrect, Auto, Quick, Retreat,
 * Surrender) read as icons instead of bare words. Each is drawn at boot as an
 * `actionicon_<name>` canvas texture in ivory line-art that sits on the gold/blue
 * button skin; a raster pack can override any of them with `sprite_action_<name>`
 * (see gfx/sprites.actionIconKey). Procedural floor, raster-ready.
 */

import { paint } from './canvasKit.js';

const IVORY = '#f4eeda';
const INK = 'rgba(18,14,26,0.85)';

function stroked(ctx, lw = 4) {
  ctx.strokeStyle = INK; ctx.lineWidth = lw + 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
  ctx.strokeStyle = IVORY; ctx.lineWidth = lw; ctx.stroke();
}
function filled(ctx) {
  ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = IVORY; ctx.fill();
}

const PAINTERS = {
  // Hourglass — Wait.
  wait(ctx, s) {
    const m = s / 2;
    ctx.beginPath();
    ctx.moveTo(m - s * 0.22, s * 0.20); ctx.lineTo(m + s * 0.22, s * 0.20);
    ctx.lineTo(m + s * 0.04, m); ctx.lineTo(m + s * 0.22, s * 0.80);
    ctx.lineTo(m - s * 0.22, s * 0.80); ctx.lineTo(m - s * 0.04, m);
    ctx.closePath();
    filled(ctx);
    // caps + falling sand
    ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(m - s * 0.26, s * 0.20); ctx.lineTo(m + s * 0.26, s * 0.20);
    ctx.moveTo(m - s * 0.26, s * 0.80); ctx.lineTo(m + s * 0.26, s * 0.80);
    ctx.stroke();
  },
  // Shield with a boss — Defend.
  defend(ctx, s) {
    const m = s / 2;
    ctx.beginPath();
    ctx.moveTo(m, s * 0.16);
    ctx.lineTo(m + s * 0.26, s * 0.26);
    ctx.lineTo(m + s * 0.26, s * 0.52);
    ctx.quadraticCurveTo(m + s * 0.24, s * 0.74, m, s * 0.86);
    ctx.quadraticCurveTo(m - s * 0.24, s * 0.74, m - s * 0.26, s * 0.52);
    ctx.lineTo(m - s * 0.26, s * 0.26);
    ctx.closePath();
    filled(ctx);
    ctx.strokeStyle = INK; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(m, s * 0.30); ctx.lineTo(m, s * 0.66); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(m - s * 0.14, s * 0.46); ctx.lineTo(m + s * 0.14, s * 0.46); ctx.stroke();
  },
  // Open book with a spark — Spellbook.
  spellbook(ctx, s) {
    const m = s / 2;
    ctx.beginPath();
    ctx.moveTo(m, s * 0.30);
    ctx.quadraticCurveTo(m - s * 0.22, s * 0.20, m - s * 0.30, s * 0.30);
    ctx.lineTo(m - s * 0.30, s * 0.72);
    ctx.quadraticCurveTo(m - s * 0.22, s * 0.64, m, s * 0.72);
    ctx.quadraticCurveTo(m + s * 0.22, s * 0.64, m + s * 0.30, s * 0.72);
    ctx.lineTo(m + s * 0.30, s * 0.30);
    ctx.quadraticCurveTo(m + s * 0.22, s * 0.20, m, s * 0.30);
    ctx.closePath();
    filled(ctx);
    ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(m, s * 0.30); ctx.lineTo(m, s * 0.72); ctx.stroke();
    // spark
    ctx.fillStyle = INK;
    for (const [dx, dy, r] of [[0.0, 0.16, 0.05], [0.16, 0.10, 0.03]]) {
      ctx.beginPath(); ctx.arc(m + s * dx, s * dy, s * r, 0, Math.PI * 2); ctx.fill();
    }
  },
  // Ankh — Resurrect.
  resurrect(ctx, s) {
    const m = s / 2;
    ctx.beginPath();
    ctx.ellipse(m, s * 0.32, s * 0.12, s * 0.15, 0, 0, Math.PI * 2);
    ctx.moveTo(m, s * 0.44); ctx.lineTo(m, s * 0.84);
    ctx.moveTo(m - s * 0.18, s * 0.56); ctx.lineTo(m + s * 0.18, s * 0.56);
    stroked(ctx, 6);
  },
  // Crossed swords — Auto.
  auto(ctx, s) {
    const m = s / 2;
    for (const dir of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(m - dir * s * 0.24, s * 0.22);
      ctx.lineTo(m + dir * s * 0.20, s * 0.72);
      stroked(ctx, 6);
      // hilt
      ctx.beginPath();
      ctx.moveTo(m - dir * s * 0.30, s * 0.16);
      ctx.lineTo(m - dir * s * 0.18, s * 0.28);
      stroked(ctx, 5);
    }
  },
  // Fast-forward double chevron — Quick.
  quick(ctx, s) {
    const m = s / 2;
    for (const ox of [-0.14, 0.10]) {
      ctx.beginPath();
      ctx.moveTo(m + s * ox - s * 0.10, s * 0.28);
      ctx.lineTo(m + s * ox + s * 0.14, m);
      ctx.lineTo(m + s * ox - s * 0.10, s * 0.72);
      stroked(ctx, 6);
    }
  },
  // Flag on a leaning pole (fleeing) — Retreat.
  retreat(ctx, s) {
    const m = s / 2;
    ctx.beginPath();
    ctx.moveTo(m - s * 0.14, s * 0.84); ctx.lineTo(m + s * 0.06, s * 0.18);
    stroked(ctx, 5);
    ctx.beginPath();
    ctx.moveTo(m + s * 0.04, s * 0.22);
    ctx.lineTo(m + s * 0.34, s * 0.30);
    ctx.lineTo(m + s * 0.06, s * 0.44);
    ctx.closePath();
    filled(ctx);
  },
  // White flag raised — Surrender.
  surrender(ctx, s) {
    const m = s / 2;
    ctx.beginPath();
    ctx.moveTo(m - s * 0.16, s * 0.84); ctx.lineTo(m - s * 0.16, s * 0.16);
    stroked(ctx, 5);
    ctx.beginPath();
    ctx.moveTo(m - s * 0.16, s * 0.18);
    ctx.quadraticCurveTo(m + s * 0.06, s * 0.10, m + s * 0.28, s * 0.20);
    ctx.quadraticCurveTo(m + s * 0.06, s * 0.30, m + s * 0.28, s * 0.40);
    ctx.quadraticCurveTo(m + s * 0.06, s * 0.48, m - s * 0.16, s * 0.40);
    ctx.closePath();
    filled(ctx);
  },
};

export const ACTION_ICON_NAMES = Object.keys(PAINTERS);

function add(scene, key, canvas) {
  if (!scene.textures.exists(key)) scene.textures.addCanvas(key, canvas);
}

/** Register an `actionicon_<name>` texture for each combat action (idempotent). */
export function registerActionIcons(scene) {
  for (const [name, fn] of Object.entries(PAINTERS)) {
    add(scene, `actionicon_${name}`, paint(64, 64, (ctx) => fn(ctx, 64)));
  }
}

/** Draw one action pictogram into an s×s box (for headless tests). */
export function drawActionIcon(ctx, s, name) {
  (PAINTERS[name] || PAINTERS.wait)(ctx, s);
}
