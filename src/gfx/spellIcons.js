/**
 * spellIcons.js — Procedural spell pictograms.
 *
 * Every spell gets a small icon so the spellbooks (town mage guild, combat and
 * adventure) can read as a grid of pictograms instead of a wall of text. The art
 * is generated at boot as a `spellicon_<id>` canvas texture; a raster pack can
 * later override any spell with `sprite_spell_<id>` (see gfx/sprites.spellIcon),
 * so this is the procedural floor, raster-ready.
 *
 * The glyph encodes two things a player can learn to read at a glance:
 *   • SCHOOL by plaque colour (air / earth / fire / water), and
 *   • EFFECT by the central symbol (bolt = damage, up-chevrons = blessing,
 *     down-chevrons = hex, cross = restoration, or a per-kind adventure mark).
 * Two spells of the same school AND kind look alike on purpose — the spellbook
 * grid always labels each icon with its name, and the raster pack disambiguates.
 */

import { paint, linGrad, rgba, shade } from './canvasKit.js';
import { SPELLS } from '../data/spells.js';

/** Plaque tint per magic school (0xRRGGBB). Distinct hues; water ≠ air. */
export const SCHOOL_TINT = {
  air: 0x6fa8e0,   // pale sky blue
  earth: 0x7f9a3e, // mossy green
  fire: 0xd8552a,  // ember red-orange
  water: 0x2f6fc8, // deep royal blue
  neutral: 0x8a84a0,
};

const IVORY = '#f2ecd9';
const INK = 'rgba(20,16,28,0.92)';

function outlined(ctx, fill, ink, lw, drawPath) {
  drawPath();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = ink;
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A lightning bolt — damage spells. */
function boltSymbol(ctx, s) {
  const m = s / 2;
  outlined(ctx, IVORY, INK, 4, () => {
    ctx.beginPath();
    ctx.moveTo(m + s * 0.10, s * 0.20);
    ctx.lineTo(m - s * 0.16, s * 0.52);
    ctx.lineTo(m - s * 0.01, s * 0.52);
    ctx.lineTo(m - s * 0.12, s * 0.80);
    ctx.lineTo(m + s * 0.18, s * 0.44);
    ctx.lineTo(m + s * 0.02, s * 0.44);
    ctx.closePath();
  });
}

/** Stacked chevrons; up = blessing (buff), down = hex (debuff). */
function chevronSymbol(ctx, s, up) {
  const m = s / 2;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const rows = up ? [0.36, 0.54] : [0.46, 0.64];
  const dir = up ? -1 : 1;
  for (const cy0 of rows) {
    const cy = cy0 * s;
    ctx.beginPath();
    ctx.moveTo(m - s * 0.18, cy);
    ctx.lineTo(m, cy + dir * s * 0.16);
    ctx.lineTo(m + s * 0.18, cy);
    ctx.stroke();
  }
  ctx.strokeStyle = up ? IVORY : shadeStr(0xf2ecd9, -0.06);
  ctx.lineWidth = 3;
  for (const cy0 of rows) {
    const cy = cy0 * s;
    ctx.beginPath();
    ctx.moveTo(m - s * 0.18, cy);
    ctx.lineTo(m, cy + dir * s * 0.16);
    ctx.lineTo(m + s * 0.18, cy);
    ctx.stroke();
  }
}

function shadeStr(hex, f) { return rgba(shade(hex, f)); }

/** A plus/cross — restoration (heal / resurrect). */
function crossSymbol(ctx, s) {
  const m = s / 2, a = s * 0.11, b = s * 0.24;
  outlined(ctx, IVORY, INK, 4, () => {
    ctx.beginPath();
    ctx.rect(m - a, m - b, a * 2, b * 2);
    ctx.rect(m - b, m - a, b * 2, a * 2);
  });
}

/** An open eye — scrying adventure spells. */
function eyeSymbol(ctx, s) {
  const m = s / 2;
  ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.fillStyle = IVORY;
  ctx.beginPath();
  ctx.moveTo(m - s * 0.24, m + s * 0.04);
  ctx.quadraticCurveTo(m, m - s * 0.22, m + s * 0.24, m + s * 0.04);
  ctx.quadraticCurveTo(m, m + s * 0.24, m - s * 0.24, m + s * 0.04);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath(); ctx.arc(m, m + s * 0.03, s * 0.075, 0, Math.PI * 2); ctx.fill();
}

/** A little sailing boat — summon/scuttle boat. */
function boatSymbol(ctx, s) {
  const m = s / 2;
  outlined(ctx, IVORY, INK, 3.5, () => {
    ctx.beginPath();
    ctx.moveTo(m - s * 0.22, m + s * 0.10);
    ctx.lineTo(m + s * 0.22, m + s * 0.10);
    ctx.lineTo(m + s * 0.12, m + s * 0.26);
    ctx.lineTo(m - s * 0.12, m + s * 0.26);
    ctx.closePath();
  });
  outlined(ctx, IVORY, INK, 3, () => {
    ctx.beginPath();
    ctx.moveTo(m, m - s * 0.22);
    ctx.lineTo(m, m + s * 0.06);
    ctx.lineTo(m + s * 0.16, m + s * 0.06);
    ctx.closePath();
  });
}

/** A portal arch — town portal / dimension door. */
function portalSymbol(ctx, s) {
  const m = s / 2;
  ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(m, m + s * 0.14, s * 0.22, Math.PI, 0);
  ctx.moveTo(m - s * 0.22, m + s * 0.14);
  ctx.lineTo(m - s * 0.22, m + s * 0.30);
  ctx.moveTo(m + s * 0.22, m + s * 0.14);
  ctx.lineTo(m + s * 0.22, m + s * 0.30);
  ctx.stroke();
  ctx.strokeStyle = IVORY; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(m, m + s * 0.14, s * 0.22, Math.PI, 0);
  ctx.moveTo(m - s * 0.22, m + s * 0.14);
  ctx.lineTo(m - s * 0.22, m + s * 0.30);
  ctx.moveTo(m + s * 0.22, m + s * 0.14);
  ctx.lineTo(m + s * 0.22, m + s * 0.30);
  ctx.stroke();
}

/** A feathered wing — fly / water walk (free movement). */
function wingSymbol(ctx, s) {
  const m = s / 2;
  outlined(ctx, IVORY, INK, 3.5, () => {
    ctx.beginPath();
    ctx.moveTo(m - s * 0.22, m - s * 0.10);
    ctx.quadraticCurveTo(m + s * 0.20, m - s * 0.22, m + s * 0.24, m + s * 0.06);
    ctx.quadraticCurveTo(m + s * 0.02, m - s * 0.02, m - s * 0.22, m + s * 0.14);
    ctx.closePath();
  });
}

/** A theatre mask — disguise. */
function maskSymbol(ctx, s) {
  const m = s / 2;
  outlined(ctx, IVORY, INK, 3.5, () => {
    ctx.beginPath();
    ctx.ellipse(m, m + s * 0.02, s * 0.20, s * 0.26, 0, 0, Math.PI * 2);
  });
  ctx.fillStyle = INK;
  ctx.beginPath(); ctx.arc(m - s * 0.08, m - s * 0.04, s * 0.035, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(m + s * 0.08, m - s * 0.04, s * 0.035, 0, Math.PI * 2); ctx.fill();
}

/** Pick the central symbol painter for a spell. */
function symbolFor(sp) {
  if (sp.kind === 'adventure') {
    switch (sp.cast) {
      case 'view': case 'viewEarth': case 'visions': return eyeSymbol;
      case 'summonBoat': case 'scuttleBoat': return boatSymbol;
      case 'townPortal': case 'dimensionDoor': return portalSymbol;
      case 'fly': case 'waterWalk': return wingSymbol;
      case 'disguise': return maskSymbol;
      default: return eyeSymbol;
    }
  }
  switch (sp.kind) {
    case 'damage': return boltSymbol;
    case 'heal': return crossSymbol;
    case 'buff': return (ctx, s) => chevronSymbol(ctx, s, true);
    case 'debuff': return (ctx, s) => chevronSymbol(ctx, s, false);
    default: return boltSymbol;
  }
}

/** Draw one spell pictogram into an s×s box (transparent outside the plaque). */
export function drawSpellIcon(ctx, s, sp) {
  const tint = SCHOOL_TINT[sp.school] || SCHOOL_TINT.neutral;
  const pad = s * 0.09, r = s * 0.22;
  // Plaque: rounded square, top-lit gradient, dark rim + inner gold hairline.
  ctx.fillStyle = linGrad(ctx, 0, pad, 0, s - pad, [
    [0, rgba(shade(tint, 0.30))],
    [0.55, rgba(tint)],
    [1, rgba(shade(tint, -0.38))],
  ]);
  roundRect(ctx, pad, pad, s - pad * 2, s - pad * 2, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,8,16,0.9)';
  ctx.lineWidth = s * 0.05;
  roundRect(ctx, pad, pad, s - pad * 2, s - pad * 2, r);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,235,180,0.4)';
  ctx.lineWidth = s * 0.025;
  roundRect(ctx, pad * 1.7, pad * 1.7, s - pad * 3.4, s - pad * 3.4, r * 0.8);
  ctx.stroke();
  // Central effect symbol.
  symbolFor(sp)(ctx, s);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function add(scene, key, canvas) {
  if (!scene.textures.exists(key)) scene.textures.addCanvas(key, canvas);
}

/** Register a `spellicon_<id>` texture for every spell (idempotent per key). */
export function registerSpellIcons(scene) {
  for (const [id, sp] of Object.entries(SPELLS)) {
    add(scene, `spellicon_${id}`, paint(64, 64, (ctx) => drawSpellIcon(ctx, 64, sp)));
  }
}
