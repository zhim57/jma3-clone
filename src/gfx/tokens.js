/**
 * tokens.js — World sprites: creature tokens, heroes, towns, mines, loot,
 * boosters, artifact icons, portraits. All generated at boot from vector
 * painters (canvasKit + glyphs). Every function is idempotent per texture key.
 */

import { paint, rgba, shade, linGrad, radGrad, poly, star, withShadow, resetShadow, noiseRng } from './canvasKit.js';
import { drawGlyph } from './glyphs.js';
import { registerSpellIcons } from './spellIcons.js';
import { registerActionIcons } from './actionIcons.js';
import { CREATURES } from '../data/creatures.js';
import { ARTIFACTS } from '../data/artifacts.js';
import { FACTIONS, BANNER_COLORS } from '../data/factions.js';
import { HERO_ROSTER } from '../data/heroes.js';

function add(scene, key, canvas) {
  if (!scene.textures.exists(key)) scene.textures.addCanvas(key, canvas);
}

// ---------------------------------------------------------------------------
// Creature tokens
// ---------------------------------------------------------------------------

/**
 * Draw the token medallion (faction ring + tinted inner disc + rim). Returns
 * the inner radius so the caller can fill it with a glyph or a real portrait.
 * Shared by the procedural tokens and the HoMM3-portrait tokens.
 */
export function paintTokenBase(ctx, ringColor, tint, size = 64) {
  const cx = size / 2, cy = size / 2;
  withShadow(ctx, 'rgba(0,0,0,0.45)', 5, 0, 2);
  ctx.fillStyle = linGrad(ctx, 4, 4, size - 4, size - 4, [
    [0, rgba(shade(ringColor, 0.35))],
    [1, rgba(shade(ringColor, -0.35))],
  ]);
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.453, 0, Math.PI * 2);
  ctx.fill();
  resetShadow(ctx);
  ctx.fillStyle = radGrad(ctx, cx - 7, cy - 9, 2, size * 0.47, [
    [0, rgba(shade(tint, -0.05))],
    [1, rgba(shade(tint, -0.62))],
  ]);
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.383, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.367, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();
  return size * 0.383;
}

/** Golden chevron marking an upgraded creature. */
export function paintUpgradeChevron(ctx, size = 64) {
  const cx = size / 2;
  ctx.fillStyle = '#f4c542';
  ctx.strokeStyle = 'rgba(20,16,28,0.9)';
  ctx.lineWidth = 1.4;
  poly(ctx, [[cx - 7, 7], [cx, 1.5], [cx + 7, 7], [cx, 12.5]]);
  ctx.fill();
  ctx.stroke();
}

export function registerCreatureTokens(scene) {
  for (const [id, c] of Object.entries(CREATURES)) {
    const ringColor = FACTIONS[c.faction]?.color ?? 0x777788;
    add(scene, `token_${id}`, paint(64, 64, (ctx) => {
      paintTokenBase(ctx, ringColor, c.tint, 64);
      ctx.save();
      ctx.translate(10, 10);
      drawGlyph(ctx, c.glyph, 44, {
        fill: '#f2ecd9',
        ink: 'rgba(20,16,28,0.9)',
        accent: rgba(shade(c.tint, 0.45)),
      });
      ctx.restore();
      if (c.upgraded) paintUpgradeChevron(ctx, 64);
    }));
  }
}

// ---------------------------------------------------------------------------
// Hero riders (one per player color)
// ---------------------------------------------------------------------------

export function registerHeroSprites(scene) {
  // BANNER_COLORS, not PLAYER_COLORS: an invader realm joins the game at a slot
  // past the four local ones, and a slot with no registered rider draws as a
  // missing texture.
  BANNER_COLORS.forEach((color, i) => {
    add(scene, `hero_rider_${i}`, paint(64, 72, (ctx) => {
      const groundY = 64;
      withShadow(ctx, 'rgba(0,0,0,0.4)', 4, 0, 2);
      // shadow ellipse handled by scene; draw mount ---------------------------------
      const dark = '#2c2a33';
      // legs
      ctx.strokeStyle = dark;
      ctx.lineCap = 'round';
      ctx.lineWidth = 4.5;
      for (const [lx0, lx1, back] of [[22, 18, 1], [28, 27, 0], [40, 38, 0], [46, 50, 1]]) {
        ctx.beginPath();
        ctx.moveTo(lx0, groundY - 20);
        ctx.lineTo(lx1, groundY - (back ? 2 : 0));
        ctx.stroke();
      }
      // body
      ctx.fillStyle = linGrad(ctx, 16, 30, 52, 48, [[0, '#4a4754'], [1, dark]]);
      ctx.beginPath();
      ctx.ellipse(34, groundY - 24, 17, 9.5, -0.06, 0, Math.PI * 2);
      ctx.fill();
      // neck + head
      ctx.beginPath();
      ctx.moveTo(46, groundY - 30);
      ctx.quadraticCurveTo(54, groundY - 40, 53, groundY - 46);
      ctx.lineTo(59, groundY - 40);
      ctx.quadraticCurveTo(62, groundY - 37, 58, groundY - 34);
      ctx.quadraticCurveTo(52, groundY - 26, 47, groundY - 24);
      ctx.closePath();
      ctx.fill();
      // tail
      ctx.strokeStyle = '#3c3944';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(18, groundY - 28);
      ctx.quadraticCurveTo(10, groundY - 22, 12, groundY - 10);
      ctx.stroke();
      resetShadow(ctx);
      // rider torso
      ctx.fillStyle = linGrad(ctx, 26, 14, 40, 34, [[0, '#cfd6e4'], [1, '#8b93a8']]);
      ctx.beginPath();
      ctx.moveTo(29, groundY - 30);
      ctx.quadraticCurveTo(28, groundY - 46, 34, groundY - 48);
      ctx.quadraticCurveTo(40, groundY - 46, 39, groundY - 30);
      ctx.closePath();
      ctx.fill();
      // helmet
      ctx.fillStyle = '#dfe5f0';
      ctx.beginPath();
      ctx.arc(34.5, groundY - 51, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(color);
      ctx.beginPath(); // plume
      ctx.moveTo(34, groundY - 55);
      ctx.quadraticCurveTo(30, groundY - 62, 25, groundY - 60);
      ctx.quadraticCurveTo(30, groundY - 57, 31.5, groundY - 52);
      ctx.closePath();
      ctx.fill();
      // banner pole + flag in player color
      ctx.strokeStyle = '#6b5a3e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(24, groundY - 26);
      ctx.lineTo(24, groundY - 66);
      ctx.stroke();
      ctx.fillStyle = linGrad(ctx, 24, 0, 24, 16, [
        [0, rgba(shade(color, 0.25))],
        [1, rgba(shade(color, -0.2))],
      ]);
      ctx.beginPath();
      ctx.moveTo(24, groundY - 66);
      ctx.lineTo(46, groundY - 62);
      ctx.lineTo(38, groundY - 58);
      ctx.lineTo(46, groundY - 54);
      ctx.lineTo(24, groundY - 52);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,16,28,0.55)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }));
  });

  // Small waving flag used on owned mines/towns — one per banner slot, invaders
  // included (see registerHeroSprites).
  BANNER_COLORS.forEach((color, i) => {
    add(scene, `flag_${i}`, paint(28, 34, (ctx) => {
      ctx.strokeStyle = '#5d4e35';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(5, 32);
      ctx.lineTo(5, 3);
      ctx.stroke();
      ctx.fillStyle = linGrad(ctx, 5, 2, 26, 14, [
        [0, rgba(shade(color, 0.3))],
        [1, rgba(shade(color, -0.15))],
      ]);
      ctx.beginPath();
      ctx.moveTo(5, 3);
      ctx.quadraticCurveTo(17, 0, 26, 4);
      ctx.lineTo(22, 9);
      ctx.lineTo(26, 14);
      ctx.quadraticCurveTo(15, 17, 5, 15);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,16,28,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }));
  });
}

// ---------------------------------------------------------------------------
// Towns
// ---------------------------------------------------------------------------

/**
 * TOWN_PAINTERS — registry of town silhouettes keyed by faction id. Each
 * `(ctx)` painter draws one town on the shared 104×96 canvas; registered as
 * `town_<id>` so a new faction gets its town art by adding one entry here
 * (plus its FACTIONS entry). Nothing else registers these keys.
 */
export const TOWN_PAINTERS = {
  castle(ctx) {
    const baseY = 88;
    withShadow(ctx, 'rgba(0,0,0,0.4)', 7, 0, 3);
    // walls
    ctx.fillStyle = linGrad(ctx, 10, 40, 94, baseY, [[0, '#d9d3c6'], [1, '#9a927f']]);
    ctx.fillRect(14, baseY - 34, 76, 34);
    resetShadow(ctx);
    // crenellation
    ctx.fillStyle = '#c9c2b2';
    for (let x = 14; x < 90; x += 10) ctx.fillRect(x, baseY - 40, 6, 8);
    // gate
    ctx.fillStyle = '#4c3f30';
    ctx.beginPath();
    ctx.moveTo(44, baseY);
    ctx.lineTo(44, baseY - 18);
    ctx.arc(52, baseY - 18, 8, Math.PI, 0);
    ctx.lineTo(60, baseY);
    ctx.closePath();
    ctx.fill();
    // side towers
    for (const tx of [14, 82]) {
      ctx.fillStyle = linGrad(ctx, tx - 8, 0, tx + 8, 0, [[0, '#e8e2d4'], [1, '#a49c89']]);
      ctx.fillRect(tx - 8, baseY - 58, 16, 58);
      ctx.fillStyle = linGrad(ctx, tx - 10, 0, tx + 10, 0, [[0, '#5a7fc0'], [1, '#2e4a80']]);
      poly(ctx, [[tx - 11, baseY - 58], [tx + 11, baseY - 58], [tx, baseY - 80]]);
      ctx.fill();
    }
    // central keep
    ctx.fillStyle = linGrad(ctx, 40, 0, 66, 0, [[0, '#efe9db'], [1, '#b0a894']]);
    ctx.fillRect(40, baseY - 66, 26, 40);
    ctx.fillStyle = linGrad(ctx, 36, 0, 70, 0, [[0, '#6b90d0'], [1, '#33528c']]);
    poly(ctx, [[36, baseY - 66], [70, baseY - 66], [53, baseY - 92]]);
    ctx.fill();
    // windows
    ctx.fillStyle = '#f7d97c';
    for (const [wx, wy] of [[51, baseY - 52], [18, baseY - 46], [86, baseY - 46]]) {
      ctx.fillRect(wx - 2, wy, 4, 7);
    }
  },
  inferno(ctx) {
    const baseY = 88;
    // lava pool base
    withShadow(ctx, 'rgba(255,80,0,0.55)', 10, 0, 0);
    ctx.fillStyle = '#ff7a28';
    ctx.beginPath();
    ctx.ellipse(52, baseY - 2, 40, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    // jagged spires
    const spire = (cx, w, h) => {
      ctx.fillStyle = linGrad(ctx, cx - w, baseY - h, cx + w, baseY, [[0, '#5a4448'], [1, '#221a1e']]);
      poly(ctx, [
        [cx - w, baseY], [cx - w * 0.7, baseY - h * 0.55], [cx - w * 0.2, baseY - h * 0.5],
        [cx, baseY - h], [cx + w * 0.25, baseY - h * 0.55], [cx + w * 0.75, baseY - h * 0.65],
        [cx + w, baseY],
      ]);
      ctx.fill();
    };
    spire(20, 14, 58);
    spire(84, 14, 62);
    spire(52, 20, 86);
    // glowing windows
    ctx.fillStyle = '#ffa040';
    withShadow(ctx, 'rgba(255,120,30,0.9)', 6, 0, 0);
    for (const [wx, wy] of [[52, baseY - 56], [20, baseY - 36], [84, baseY - 40], [52, baseY - 30]]) {
      poly(ctx, [[wx - 2.5, wy + 7], [wx, wy], [wx + 2.5, wy + 7]]);
      ctx.fill();
    }
    resetShadow(ctx);
    // fanged gate
    ctx.fillStyle = '#120c10';
    ctx.beginPath();
    ctx.moveTo(42, baseY);
    ctx.quadraticCurveTo(52, baseY - 26, 62, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e8e0d0';
    for (let i = 0; i < 4; i++) {
      const fx = 45 + i * 4.5;
      poly(ctx, [[fx, baseY - 12 + Math.abs(i - 1.5) * 3], [fx + 1.6, baseY - 5 + Math.abs(i - 1.5) * 3], [fx + 3.2, baseY - 12 + Math.abs(i - 1.5) * 3]]);
      ctx.fill();
    }
  },
  tower(ctx) {
    // A wizard's observatory, not a fortress: a tall banded spire under a
    // bulbous arcane dome, flanked by two domed turrets, wreathed in a glowing
    // orbital ring and lit by arched runic windows.
    const baseY = 90;
    // --- two shorter flanking turrets with onion domes ---
    for (const tx of [22, 82]) {
      withShadow(ctx, 'rgba(0,0,0,0.4)', 6, 0, 3);
      ctx.fillStyle = linGrad(ctx, tx - 8, 0, tx + 8, 0, [[0, '#eef3fa'], [1, '#9fb0cc']]);
      ctx.fillRect(tx - 8, baseY - 42, 16, 42);
      resetShadow(ctx);
      ctx.fillStyle = linGrad(ctx, tx - 10, 0, tx + 10, 0, [[0, '#7cc0f0'], [1, '#345fa8']]);
      ctx.beginPath();
      ctx.moveTo(tx - 10, baseY - 42);
      ctx.quadraticCurveTo(tx - 12, baseY - 58, tx, baseY - 66);
      ctx.quadraticCurveTo(tx + 12, baseY - 58, tx + 10, baseY - 42);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#cfeaff';
      star(ctx, tx, baseY - 70, 4, 2.4, 1);
      ctx.fill();
    }
    // --- central observatory shaft: tapering banded cylinder ---
    withShadow(ctx, 'rgba(0,0,0,0.45)', 7, 0, 3);
    ctx.fillStyle = linGrad(ctx, 38, 0, 66, 0, [[0, '#f4f8fe'], [0.5, '#d6e0ee'], [1, '#a3b3cf']]);
    ctx.beginPath();
    ctx.moveTo(40, baseY);
    ctx.lineTo(41, baseY - 52);
    ctx.quadraticCurveTo(52, baseY - 56, 63, baseY - 52);
    ctx.lineTo(64, baseY);
    ctx.closePath();
    ctx.fill();
    resetShadow(ctx);
    // stone banding rings
    ctx.strokeStyle = 'rgba(70,90,130,0.5)';
    ctx.lineWidth = 1.4;
    for (const yy of [baseY - 14, baseY - 32]) {
      ctx.beginPath();
      ctx.moveTo(40, yy);
      ctx.lineTo(64, yy);
      ctx.stroke();
    }
    // --- bulbous arcane dome (onion) ---
    ctx.fillStyle = linGrad(ctx, 36, 0, 68, 0, [[0, '#8ccdf6'], [1, '#2f5aa0']]);
    ctx.beginPath();
    ctx.moveTo(39, baseY - 52);
    ctx.quadraticCurveTo(33, baseY - 74, 52, baseY - 90);
    ctx.quadraticCurveTo(71, baseY - 74, 65, baseY - 52);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(46, baseY - 66, 3, 10, -0.4, 0, Math.PI * 2);
    ctx.fill();
    // --- glowing arcane orb finial ---
    withShadow(ctx, 'rgba(150,210,255,0.95)', 10, 0, 0);
    ctx.fillStyle = '#eaf5ff';
    ctx.beginPath();
    ctx.arc(52, baseY - 94, 4, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    // --- arched runic windows up the shaft ---
    ctx.fillStyle = '#bfe4ff';
    withShadow(ctx, 'rgba(120,200,255,0.85)', 5, 0, 0);
    for (const wy of [baseY - 22, baseY - 40, baseY - 62]) {
      ctx.beginPath();
      ctx.moveTo(52 - 2.5, wy + 3);
      ctx.lineTo(52 - 2.5, wy - 1);
      ctx.arc(52, wy - 1, 2.5, Math.PI, 0);
      ctx.lineTo(52 + 2.5, wy + 3);
      ctx.closePath();
      ctx.fill();
    }
    resetShadow(ctx);
    // --- orbital arcane ring around the dome ---
    ctx.strokeStyle = 'rgba(150,210,255,0.7)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(52, baseY - 70, 21, 6, 0, 0, Math.PI * 2);
    ctx.stroke();
  },
  rampart(ctx) {
    // An elven forest-hold: a grassy mound and timber wall under a living-wood
    // keep grown into a spired tree-tower, flanked by tall pines, its canopy
    // crowned with a golden finial and lit by warm windows.
    const baseY = 88;
    // --- grassy mound base ---
    withShadow(ctx, 'rgba(0,0,0,0.35)', 6, 0, 2);
    ctx.fillStyle = linGrad(ctx, 10, baseY - 14, 94, baseY, [[0, '#7fae5a'], [1, '#4a7434']]);
    ctx.beginPath();
    ctx.ellipse(52, baseY - 2, 42, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    // --- flanking pines ---
    for (const tx of [17, 87]) {
      ctx.fillStyle = '#5d4326';
      ctx.fillRect(tx - 2, baseY - 12, 4, 10);
      ctx.fillStyle = linGrad(ctx, tx - 12, baseY - 60, tx + 12, baseY, [[0, '#5f9a44'], [1, '#2f5c26']]);
      for (let i = 0; i < 3; i++) {
        const w = 13 - i * 3, yy = baseY - 12 - i * 13;
        poly(ctx, [[tx - w, yy], [tx + w, yy], [tx, yy - 18]]);
        ctx.fill();
      }
    }
    // --- stone-and-timber wall with a rounded gate ---
    withShadow(ctx, 'rgba(0,0,0,0.4)', 6, 0, 3);
    ctx.fillStyle = linGrad(ctx, 24, baseY - 26, 80, baseY, [[0, '#cfc4a4'], [1, '#8d8264']]);
    ctx.fillRect(26, baseY - 24, 52, 22);
    resetShadow(ctx);
    ctx.fillStyle = '#9a8f6e';
    for (let x = 28; x < 78; x += 9) ctx.fillRect(x, baseY - 29, 5, 7);
    ctx.fillStyle = '#4c3f30';
    ctx.beginPath();
    ctx.moveTo(46, baseY - 2);
    ctx.lineTo(46, baseY - 14);
    ctx.arc(52, baseY - 14, 6, Math.PI, 0);
    ctx.lineTo(58, baseY - 2);
    ctx.closePath();
    ctx.fill();
    // --- central living-wood keep: a tapering trunk tower ---
    withShadow(ctx, 'rgba(0,0,0,0.45)', 7, 0, 3);
    ctx.fillStyle = linGrad(ctx, 42, 0, 64, 0, [[0, '#a8845a'], [1, '#6a4e30']]);
    ctx.beginPath();
    ctx.moveTo(44, baseY - 20);
    ctx.quadraticCurveTo(46, baseY - 48, 49, baseY - 60);
    ctx.lineTo(57, baseY - 60);
    ctx.quadraticCurveTo(60, baseY - 48, 62, baseY - 20);
    ctx.closePath();
    ctx.fill();
    resetShadow(ctx);
    // bark seams
    ctx.strokeStyle = 'rgba(60,42,24,0.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(50, baseY - 24);
    ctx.quadraticCurveTo(49, baseY - 40, 51, baseY - 56);
    ctx.moveTo(57, baseY - 24);
    ctx.quadraticCurveTo(58, baseY - 40, 56, baseY - 56);
    ctx.stroke();
    // --- leafy canopy crowning the trunk ---
    ctx.fillStyle = linGrad(ctx, 30, baseY - 90, 76, baseY - 54, [[0, '#8cc25e'], [1, '#3e7830']]);
    ctx.beginPath();
    ctx.ellipse(53, baseY - 70, 22, 16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.ellipse(46, baseY - 76, 8, 5, -0.4, 0, Math.PI * 2);
    ctx.fill();
    // --- golden spire piercing the canopy ---
    ctx.fillStyle = linGrad(ctx, 50, baseY - 94, 56, baseY - 78, [[0, '#ffe9a0'], [1, '#caa74a']]);
    poly(ctx, [[50, baseY - 80], [56, baseY - 80], [53, baseY - 94]]);
    ctx.fill();
    withShadow(ctx, 'rgba(255,230,140,0.9)', 7, 0, 0);
    ctx.fillStyle = '#fff4c8';
    star(ctx, 53, baseY - 94, 4, 3, 1.2);
    ctx.fill();
    resetShadow(ctx);
    // --- warm windows in the trunk and wall ---
    ctx.fillStyle = '#f7d97c';
    withShadow(ctx, 'rgba(250,210,110,0.8)', 5, 0, 0);
    for (const [wx, wy] of [[52, baseY - 44], [52, baseY - 32], [34, baseY - 16], [70, baseY - 16]]) {
      ctx.fillRect(wx - 2, wy, 4, 6);
    }
    resetShadow(ctx);
  },
  necropolis(ctx) {
    // A gothic crypt-hold: a barrow mound of dead earth under a bone-grey
    // mausoleum, flanked by leaning tombstones, its central spire crowned with a
    // skull finial and lit by a cold necrotic-green glow, wreathed in grave-mist.
    const baseY = 88;
    // --- barrow mound of dead earth ---
    withShadow(ctx, 'rgba(0,0,0,0.4)', 6, 0, 2);
    ctx.fillStyle = linGrad(ctx, 10, baseY - 12, 94, baseY, [[0, '#6a6258'], [1, '#3a352f']]);
    ctx.beginPath();
    ctx.ellipse(52, baseY - 2, 42, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    // --- flanking leaning tombstones ---
    for (const [tx, lean] of [[17, -0.12], [87, 0.12]]) {
      ctx.save();
      ctx.translate(tx, baseY - 4);
      ctx.rotate(lean);
      ctx.fillStyle = linGrad(ctx, -8, -30, 8, 0, [[0, '#b9b4a8'], [1, '#736d62']]);
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(-8, -22);
      ctx.arc(0, -22, 8, Math.PI, 0);
      ctx.lineTo(8, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,38,34,0.55)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-3, -24); ctx.lineTo(3, -24);
      ctx.moveTo(0, -24); ctx.lineTo(0, -18);
      ctx.stroke();
      ctx.restore();
    }
    // --- mausoleum body: bone-grey stone with a fanged arch tomb-mouth ---
    withShadow(ctx, 'rgba(0,0,0,0.45)', 6, 0, 3);
    ctx.fillStyle = linGrad(ctx, 24, baseY - 30, 80, baseY, [[0, '#c4bfb0'], [1, '#7c766a']]);
    ctx.fillRect(26, baseY - 28, 52, 26);
    resetShadow(ctx);
    // weathered crenellations
    ctx.fillStyle = '#8f897b';
    for (let x = 28; x < 78; x += 9) ctx.fillRect(x, baseY - 33, 5, 7);
    // tomb doorway, dark and cold
    ctx.fillStyle = '#171420';
    ctx.beginPath();
    ctx.moveTo(45, baseY - 2);
    ctx.lineTo(45, baseY - 16);
    ctx.arc(52, baseY - 16, 7, Math.PI, 0);
    ctx.lineTo(59, baseY - 2);
    ctx.closePath();
    ctx.fill();
    // necrotic glow within the doorway
    withShadow(ctx, 'rgba(120,210,120,0.8)', 6, 0, 0);
    ctx.fillStyle = 'rgba(150,230,150,0.55)';
    ctx.beginPath();
    ctx.ellipse(52, baseY - 8, 3.5, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    // --- central crypt spire ---
    withShadow(ctx, 'rgba(0,0,0,0.45)', 7, 0, 3);
    ctx.fillStyle = linGrad(ctx, 42, 0, 64, 0, [[0, '#b0aa9c'], [1, '#6a6458']]);
    ctx.beginPath();
    ctx.moveTo(44, baseY - 26);
    ctx.lineTo(46, baseY - 62);
    ctx.lineTo(60, baseY - 62);
    ctx.lineTo(62, baseY - 26);
    ctx.closePath();
    ctx.fill();
    resetShadow(ctx);
    // spire crown, a dark pointed cap
    ctx.fillStyle = linGrad(ctx, 44, baseY - 78, 62, baseY - 60, [[0, '#4a4656'], [1, '#26232e']]);
    poly(ctx, [[44, baseY - 60], [62, baseY - 60], [53, baseY - 80]]);
    ctx.fill();
    // --- skull finial atop the spire ---
    ctx.fillStyle = '#e8e2d2';
    ctx.beginPath();
    ctx.arc(53, baseY - 84, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(50, baseY - 82, 6, 4); // jaw
    ctx.fillStyle = '#171420';
    ctx.beginPath();
    ctx.arc(51.4, baseY - 85, 1.1, 0, Math.PI * 2);
    ctx.arc(54.6, baseY - 85, 1.1, 0, Math.PI * 2);
    ctx.fill();
    // cold aura around the skull
    withShadow(ctx, 'rgba(150,120,210,0.9)', 8, 0, 0);
    ctx.strokeStyle = 'rgba(180,150,230,0.6)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(53, baseY - 84, 7, 0, Math.PI * 2);
    ctx.stroke();
    resetShadow(ctx);
    // --- cold necrotic windows in the spire and wall ---
    ctx.fillStyle = '#9be29b';
    withShadow(ctx, 'rgba(120,220,120,0.75)', 5, 0, 0);
    for (const [wx, wy] of [[53, baseY - 48], [53, baseY - 36], [35, baseY - 18], [71, baseY - 18]]) {
      poly(ctx, [[wx - 2.4, wy + 6], [wx - 2.4, wy], [wx, wy - 3], [wx + 2.4, wy], [wx + 2.4, wy + 6]]);
      ctx.fill();
    }
    resetShadow(ctx);
    // --- low grave-mist drifting across the mound ---
    ctx.fillStyle = 'rgba(200,210,200,0.18)';
    for (const [mx, mw] of [[34, 16], [62, 18]]) {
      ctx.beginPath();
      ctx.ellipse(mx, baseY - 4, mw, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  dungeon(ctx) {
    // A warlock's cavern-fastness: a black-rock massif split by a fanged cavern
    // gate, jagged spires and hanging stalactites, an all-seeing eye carved above
    // the mouth, lit by cold magenta arcane light.
    const baseY = 90;
    // --- rock massif base ---
    withShadow(ctx, 'rgba(0,0,0,0.45)', 7, 0, 3);
    ctx.fillStyle = linGrad(ctx, 12, baseY - 60, 92, baseY, [[0, '#4a3f52'], [1, '#211c28']]);
    poly(ctx, [
      [10, baseY], [12, baseY - 30], [22, baseY - 40], [30, baseY - 62],
      [44, baseY - 50], [52, baseY - 74], [60, baseY - 50], [74, baseY - 64],
      [82, baseY - 40], [92, baseY - 28], [94, baseY],
    ]);
    ctx.fill();
    resetShadow(ctx);
    // --- flanking jagged spires ---
    for (const [sx, sh, sw] of [[24, 54, 8], [80, 58, 9]]) {
      ctx.fillStyle = linGrad(ctx, sx - sw, baseY - sh, sx + sw, baseY, [[0, '#3e3446'], [1, '#181420']]);
      poly(ctx, [[sx - sw, baseY], [sx - sw * 0.4, baseY - sh * 0.6], [sx, baseY - sh], [sx + sw * 0.5, baseY - sh * 0.55], [sx + sw, baseY]]);
      ctx.fill();
    }
    // --- fanged cavern gate ---
    ctx.fillStyle = '#0c0a12';
    ctx.beginPath();
    ctx.moveTo(40, baseY);
    ctx.quadraticCurveTo(40, baseY - 30, 52, baseY - 34);
    ctx.quadraticCurveTo(64, baseY - 30, 64, baseY);
    ctx.closePath();
    ctx.fill();
    // stalactite/stalagmite fangs around the mouth. poly() BEGINS a fresh path,
    // so each fang must be filled before the next poly() call discards it — a
    // poly-poly-fill sequence rasterised only the stalagmites and silently
    // dropped all five stalactites (verified against a recording context).
    ctx.fillStyle = '#5a5064';
    for (let i = 0; i < 5; i++) {
      const fx = 42 + i * 4.6;
      poly(ctx, [[fx, baseY - 26], [fx + 1.6, baseY - 18], [fx + 3.2, baseY - 26]]); // upper
      ctx.fill();
      poly(ctx, [[fx, baseY], [fx + 1.6, baseY - 8], [fx + 3.2, baseY]]);            // lower
      ctx.fill();
    }
    // magenta glow within the cavern
    withShadow(ctx, 'rgba(210,70,180,0.85)', 8, 0, 0);
    ctx.fillStyle = 'rgba(230,110,200,0.5)';
    ctx.beginPath();
    ctx.ellipse(52, baseY - 12, 5, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    // --- the all-seeing eye carved above the gate ---
    ctx.fillStyle = '#c9bcd6';
    ctx.beginPath();
    ctx.moveTo(42, baseY - 44);
    ctx.quadraticCurveTo(52, baseY - 54, 62, baseY - 44);
    ctx.quadraticCurveTo(52, baseY - 34, 42, baseY - 44);
    ctx.closePath();
    ctx.fill();
    withShadow(ctx, 'rgba(210,70,180,0.9)', 6, 0, 0);
    ctx.fillStyle = '#8a2f6a';
    ctx.beginPath();
    ctx.arc(52, baseY - 44, 4, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    ctx.fillStyle = '#1a0e18';
    ctx.beginPath();
    ctx.arc(52, baseY - 44, 1.8, 0, Math.PI * 2);
    ctx.fill();
    // --- cold arcane windows dotting the rock ---
    ctx.fillStyle = '#e07ad0';
    withShadow(ctx, 'rgba(210,90,190,0.75)', 5, 0, 0);
    for (const [wx, wy] of [[30, baseY - 34], [74, baseY - 38], [52, baseY - 62], [38, baseY - 20], [66, baseY - 22]]) {
      poly(ctx, [[wx - 2, wy + 5], [wx, wy - 3], [wx + 2, wy + 5]]);
      ctx.fill();
    }
    resetShadow(ctx);
  },
  stronghold(ctx) {
    // A barbarian war-camp: a spiked timber palisade and log watchtowers around a
    // great longhouse, banners of hide and bone, a skull totem over the gate, all
    // in wasteland browns lit by a war-fire glow.
    const baseY = 88;
    // --- packed-earth mound ---
    withShadow(ctx, 'rgba(0,0,0,0.4)', 6, 0, 2);
    ctx.fillStyle = linGrad(ctx, 10, baseY - 12, 94, baseY, [[0, '#9a7a44'], [1, '#5a4326']]);
    ctx.beginPath();
    ctx.ellipse(52, baseY - 2, 42, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    // --- flanking log watchtowers with pointed roofs ---
    for (const tx of [18, 86]) {
      withShadow(ctx, 'rgba(0,0,0,0.4)', 5, 0, 2);
      ctx.fillStyle = linGrad(ctx, tx - 8, 0, tx + 8, 0, [[0, '#8a6a3e'], [1, '#4e3a20']]);
      ctx.fillRect(tx - 7, baseY - 50, 14, 50);
      resetShadow(ctx);
      // lashed-log banding
      ctx.strokeStyle = 'rgba(40,28,16,0.5)';
      ctx.lineWidth = 1.2;
      for (const yy of [baseY - 14, baseY - 30]) { ctx.beginPath(); ctx.moveTo(tx - 7, yy); ctx.lineTo(tx + 7, yy); ctx.stroke(); }
      // thatch/hide roof
      ctx.fillStyle = linGrad(ctx, tx - 11, baseY - 66, tx + 11, baseY - 48, [[0, '#7a4a2a'], [1, '#43281a']]);
      poly(ctx, [[tx - 11, baseY - 50], [tx + 11, baseY - 50], [tx, baseY - 70]]);
      ctx.fill();
      // bone finial
      ctx.strokeStyle = '#e8e0cc';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx, baseY - 70); ctx.lineTo(tx, baseY - 78); ctx.stroke();
    }
    // --- spiked palisade wall ---
    withShadow(ctx, 'rgba(0,0,0,0.4)', 6, 0, 3);
    ctx.fillStyle = linGrad(ctx, 24, baseY - 26, 80, baseY, [[0, '#8a6838'], [1, '#523a1e']]);
    ctx.fillRect(26, baseY - 24, 52, 22);
    resetShadow(ctx);
    // sharpened stake tops
    ctx.fillStyle = '#6e4e28';
    for (let x = 27; x < 79; x += 6) { poly(ctx, [[x, baseY - 24], [x + 3, baseY - 32], [x + 6, baseY - 24]]); ctx.fill(); }
    // log seams
    ctx.strokeStyle = 'rgba(40,28,14,0.5)';
    ctx.lineWidth = 1;
    for (let x = 32; x < 78; x += 6) { ctx.beginPath(); ctx.moveTo(x, baseY - 22); ctx.lineTo(x, baseY - 2); ctx.stroke(); }
    // gate
    ctx.fillStyle = '#2c1e10';
    ctx.beginPath();
    ctx.moveTo(45, baseY - 2);
    ctx.lineTo(45, baseY - 15);
    ctx.arc(52, baseY - 15, 7, Math.PI, 0);
    ctx.lineTo(59, baseY - 2);
    ctx.closePath();
    ctx.fill();
    // --- central longhouse behind the wall ---
    withShadow(ctx, 'rgba(0,0,0,0.45)', 7, 0, 3);
    ctx.fillStyle = linGrad(ctx, 40, baseY - 44, 66, baseY - 24, [[0, '#9a7444'], [1, '#5e4324']]);
    ctx.fillRect(41, baseY - 42, 24, 20);
    resetShadow(ctx);
    ctx.fillStyle = linGrad(ctx, 36, baseY - 60, 70, baseY - 40, [[0, '#7a4a2a'], [1, '#43281a']]);
    poly(ctx, [[37, baseY - 42], [69, baseY - 42], [53, baseY - 62]]);
    ctx.fill();
    // war-fire glow through the longhouse door
    withShadow(ctx, 'rgba(255,140,40,0.85)', 7, 0, 0);
    ctx.fillStyle = '#ffb050';
    poly(ctx, [[50, baseY - 22], [53, baseY - 34], [56, baseY - 22]]);
    ctx.fill();
    resetShadow(ctx);
    // --- skull totem on a pole above the gate ---
    ctx.strokeStyle = '#5a4326';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(53, baseY - 62); ctx.lineTo(53, baseY - 78); ctx.stroke();
    ctx.fillStyle = '#e8e0cc';
    ctx.beginPath(); ctx.arc(53, baseY - 82, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(50, baseY - 80, 6, 4);
    ctx.fillStyle = '#2c1e10';
    ctx.beginPath();
    ctx.arc(51.4, baseY - 83, 1.1, 0, Math.PI * 2);
    ctx.arc(54.6, baseY - 83, 1.1, 0, Math.PI * 2);
    ctx.fill();
    // hide banners flanking the totem
    for (const [bx, dir] of [[40, -1], [66, 1]]) {
      ctx.fillStyle = dir < 0 ? '#a8442a' : '#8a6a2a';
      poly(ctx, [[bx, baseY - 58], [bx + dir * 8, baseY - 54], [bx + dir * 6, baseY - 44], [bx, baseY - 46]]);
      ctx.fill();
    }
  },
  fortress(ctx) {
    // A half-sunken swamp bastion: a squat scale-plated keep on a muddy hummock
    // ringed by a moat and gnarled reeds, its jaws-of-the-beast gate flanked by
    // twin bone-tusked turrets, under a murky green fen-glow.
    const baseY = 90;
    // --- moat / murky water ---
    ctx.fillStyle = linGrad(ctx, 8, baseY - 8, 96, baseY + 4, [[0, '#3a5238'], [1, '#20301e']]);
    ctx.beginPath();
    ctx.ellipse(52, baseY, 46, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,190,140,0.25)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(52, baseY - 1, 40, 7, 0, 0, Math.PI * 2);
    ctx.stroke();
    // --- muddy hummock the keep sits on ---
    withShadow(ctx, 'rgba(0,0,0,0.4)', 6, 0, 2);
    ctx.fillStyle = linGrad(ctx, 16, baseY - 14, 88, baseY, [[0, '#6a6a3a'], [1, '#3a3a1e']]);
    ctx.beginPath();
    ctx.ellipse(52, baseY - 4, 34, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    resetShadow(ctx);
    // --- gnarled reeds around the mound ---
    ctx.strokeStyle = '#5a6a3a';
    ctx.lineWidth = 1.6;
    for (const [rx, rh] of [[22, 14], [26, 10], [80, 12], [84, 16]]) {
      ctx.beginPath();
      ctx.moveTo(rx, baseY - 2);
      ctx.quadraticCurveTo(rx + 3, baseY - rh, rx + 1, baseY - rh - 4);
      ctx.stroke();
    }
    // --- twin bone-tusked turrets ---
    for (const tx of [22, 82]) {
      withShadow(ctx, 'rgba(0,0,0,0.4)', 5, 0, 2);
      ctx.fillStyle = linGrad(ctx, tx - 8, 0, tx + 8, 0, [[0, '#7a8a5a'], [1, '#43502c']]);
      ctx.fillRect(tx - 7, baseY - 42, 14, 42);
      resetShadow(ctx);
      // scale banding
      ctx.strokeStyle = 'rgba(30,40,20,0.5)';
      ctx.lineWidth = 1;
      for (const yy of [baseY - 12, baseY - 26]) { ctx.beginPath(); ctx.moveTo(tx - 7, yy); ctx.lineTo(tx + 7, yy); ctx.stroke(); }
      // domed reptilian cap
      ctx.fillStyle = linGrad(ctx, tx - 9, baseY - 54, tx + 9, baseY - 40, [[0, '#6a8a52'], [1, '#354a24']]);
      ctx.beginPath();
      ctx.moveTo(tx - 9, baseY - 42);
      ctx.quadraticCurveTo(tx, baseY - 58, tx + 9, baseY - 42);
      ctx.closePath();
      ctx.fill();
      // curved bone tusks
      ctx.strokeStyle = '#e0dcc4';
      ctx.lineWidth = 2;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(tx, baseY - 52);
        ctx.quadraticCurveTo(tx + dir * 8, baseY - 58, tx + dir * 6, baseY - 66);
        ctx.stroke();
      }
    }
    // --- squat scale-plated keep ---
    withShadow(ctx, 'rgba(0,0,0,0.45)', 7, 0, 3);
    ctx.fillStyle = linGrad(ctx, 36, baseY - 46, 68, baseY - 6, [[0, '#7c8a56'], [1, '#414e28']]);
    ctx.fillRect(38, baseY - 44, 28, 40);
    resetShadow(ctx);
    // overlapping scale plates
    ctx.strokeStyle = 'rgba(30,40,18,0.45)';
    ctx.lineWidth = 1;
    for (let yy = baseY - 38; yy < baseY - 6; yy += 8) {
      ctx.beginPath();
      for (let xx = 40; xx <= 66; xx += 8) { ctx.moveTo(xx, yy); ctx.arc(xx, yy, 4, 0, Math.PI); }
      ctx.stroke();
    }
    // reptilian ridge crest along the roof
    ctx.fillStyle = '#354a24';
    for (let x = 40; x < 66; x += 6) { poly(ctx, [[x, baseY - 44], [x + 3, baseY - 52], [x + 6, baseY - 44]]); ctx.fill(); }
    // --- jaws-of-the-beast gate ---
    ctx.fillStyle = '#161c10';
    ctx.beginPath();
    ctx.moveTo(45, baseY - 6);
    ctx.quadraticCurveTo(52, baseY - 26, 59, baseY - 6);
    ctx.closePath();
    ctx.fill();
    // fangs around the gate maw
    ctx.fillStyle = '#e0dcc4';
    for (let i = 0; i < 4; i++) {
      const fx = 47 + i * 3.6;
      poly(ctx, [[fx, baseY - 16], [fx + 1.4, baseY - 10], [fx + 2.8, baseY - 16]]);
      ctx.fill();
    }
    // --- fen-glow eyes above the gate ---
    withShadow(ctx, 'rgba(150,220,120,0.85)', 6, 0, 0);
    ctx.fillStyle = '#b8e88a';
    for (const dx of [-6, 6]) {
      ctx.beginPath();
      ctx.ellipse(52 + dx, baseY - 34, 2.4, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    resetShadow(ctx);
  },
  conflux(ctx) {
    // An elemental confluence: a crystalline prism-spire on a stepped dais,
    // wreathed in an orbital energy ring and ringed by four elemental nodes
    // (air, water, fire, earth), crowned with a bright spark of raw magic.
    const baseY = 90;
    // --- stepped stone dais ---
    withShadow(ctx, 'rgba(0,0,0,0.4)', 6, 0, 3);
    for (const [w, y] of [[40, 0], [32, 8], [24, 16]]) {
      ctx.fillStyle = linGrad(ctx, 52 - w, baseY - y - 8, 52 + w, baseY - y, [[0, '#cfd6e0'], [1, '#8a94a4']]);
      ctx.fillRect(52 - w, baseY - y - 8, w * 2, 8);
    }
    resetShadow(ctx);
    // --- central crystalline prism-spire ---
    withShadow(ctx, 'rgba(120,220,220,0.6)', 8, 0, 0);
    ctx.fillStyle = linGrad(ctx, 42, baseY - 74, 62, baseY - 24, [[0, '#e6feff'], [0.5, '#7fe0e8'], [1, '#2a9aa8']]);
    poly(ctx, [[46, baseY - 24], [44, baseY - 54], [52, baseY - 78], [60, baseY - 54], [58, baseY - 24]]);
    ctx.fill();
    resetShadow(ctx);
    // facet highlight
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    poly(ctx, [[52, baseY - 78], [50, baseY - 54], [52, baseY - 26]]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(46, baseY - 44); ctx.lineTo(58, baseY - 44);
    ctx.stroke();
    // --- orbital energy ring around the spire ---
    ctx.strokeStyle = 'rgba(150,240,240,0.75)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(52, baseY - 48, 26, 8, 0, 0, Math.PI * 2);
    ctx.stroke();
    // --- four elemental nodes around the ring ---
    const nodes = [
      [26, baseY - 48, '#cfe6ff'], // air
      [78, baseY - 48, '#5ab0e0'], // water
      [36, baseY - 40, '#f07838'], // fire
      [68, baseY - 40, '#b08a4a'], // earth
    ];
    for (const [nx, ny, col] of nodes) {
      withShadow(ctx, col, 6, 0, 0);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(nx, ny, 4, 0, Math.PI * 2);
      ctx.fill();
      resetShadow(ctx);
    }
    // --- bright spark of raw magic crowning the spire ---
    withShadow(ctx, 'rgba(200,255,255,0.95)', 10, 0, 0);
    ctx.fillStyle = '#ffffff';
    star(ctx, 52, baseY - 82, 4, 6, 2.4);
    ctx.fill();
    ctx.fillStyle = '#bfeaff';
    star(ctx, 52, baseY - 82, 4, 3, 1.2, Math.PI / 4);
    ctx.fill();
    resetShadow(ctx);
  },
};

export function registerTownSprites(scene) {
  for (const [id, fn] of Object.entries(TOWN_PAINTERS)) {
    add(scene, `town_${id}`, paint(104, 96, fn));
  }
}

// ---------------------------------------------------------------------------
// Town BUILDING glyphs — the procedural fallback drawn for each town-screen
// building until a generated sprite exists. Deliberately GRAYSCALE + bold: the
// caller (gfx/sprites.js buildingIcon) tints each by its faction colour with
// setTint(), so one small painter set serves all 9 factions (and dwellings ramp
// by tier), instead of baking ~150 per-faction textures at boot. Category comes
// from data/buildings.js buildingCategory(); keys are `bld_dwelling_<tier>` and
// `bld_<category>`. Bold silhouettes so a 40px thumbnail still reads.

const BG_INK = '#23262e';   // outline / deep shadow  (darkest → deepest tint)
const BG_DARK = '#565b66';  // shadow wall
const BG_WALL = '#8b8f98';  // mid wall
const BG_ROOF = '#c6cad2';  // roof / lit face
const BG_LITE = '#eef0f4';  // highlight

/** A ground-shadow ellipse so a building doesn't float. */
function bldGround(ctx, s) {
  ctx.fillStyle = 'rgba(20,22,28,0.28)';
  ctx.beginPath();
  ctx.ellipse(s / 2, s - 8, s * 0.36, 5, 0, 0, Math.PI * 2);
  ctx.fill();
}
/** Outlined filled polygon in one grayscale tone. */
function bldShape(ctx, pts, fill) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = BG_INK;
  ctx.lineWidth = 2;
  poly(ctx, pts, true);
  ctx.fill();
  ctx.stroke();
}
/** A simple peaked-roof house body within [x0,x1]×[yTop..base]. */
function bldHouse(ctx, x0, x1, base, wallTop, peakY) {
  bldShape(ctx, [[x0, base], [x0, wallTop], [x1, wallTop], [x1, base]], BG_WALL); // wall
  const mid = (x0 + x1) / 2;
  bldShape(ctx, [[x0 - 3, wallTop], [mid, peakY], [x1 + 3, wallTop]], BG_ROOF);   // roof
}

export const BUILDING_PAINTERS = {
  // A creature dwelling — grandeur scales with tier (hut → spired keep), plus
  // tier pips along the sill so 1..7 read unambiguously at a glance.
  dwelling(ctx, s, tier = 1) {
    bldGround(ctx, s);
    const t = Math.max(1, Math.min(7, tier | 0));
    const w = 20 + t * 3;                 // wider with tier
    const x0 = (s - w) / 2, x1 = x0 + w;
    const base = s - 12;
    const wallTop = base - (18 + t * 2);  // taller with tier
    const peakY = wallTop - (8 + t * 2);
    bldHouse(ctx, x0, x1, base, wallTop, peakY);
    // door
    bldShape(ctx, [[s / 2 - 4, base], [s / 2 - 4, base - 9], [s / 2 + 4, base - 9], [s / 2 + 4, base]], BG_INK);
    // elite tiers gain flanking spires
    if (t >= 5) {
      for (const sx of [x0 - 5, x1 + 5]) {
        bldShape(ctx, [[sx - 3, base], [sx - 3, wallTop - 4], [sx, wallTop - 12], [sx + 3, wallTop - 4], [sx + 3, base]], BG_DARK);
      }
    }
    // tier pips
    ctx.fillStyle = BG_LITE;
    for (let i = 0; i < t; i++) {
      ctx.beginPath();
      ctx.arc(s / 2 - (t - 1) * 3 + i * 6, base + 6, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  // Fort line — a crenellated keep flanked by two towers.
  fort(ctx, s) {
    bldGround(ctx, s);
    const base = s - 12;
    bldShape(ctx, [[16, base], [16, 30], [48, 30], [48, base]], BG_WALL);        // keep
    for (const tx of [12, 44]) bldShape(ctx, [[tx, base], [tx, 24], [tx + 8, 24], [tx + 8, base]], BG_DARK); // towers
    ctx.fillStyle = BG_ROOF; // battlements
    for (const bx of [12, 20, 28, 36, 44]) ctx.fillRect(bx, 20, 5, 5);
    bldShape(ctx, [[28, base], [28, base - 12], [36, base - 12], [36, base]], BG_INK); // gate
  },
  // Hall line — a columned civic hall under a low dome.
  hall(ctx, s) {
    bldGround(ctx, s);
    const base = s - 12;
    bldShape(ctx, [[14, base], [14, 34], [50, 34], [50, base]], BG_WALL);
    ctx.fillStyle = BG_ROOF; ctx.strokeStyle = BG_INK; ctx.lineWidth = 2; // dome
    ctx.beginPath(); ctx.arc(s / 2, 34, 16, Math.PI, 0); ctx.fill(); ctx.stroke();
    ctx.fillStyle = BG_LITE; ctx.beginPath(); ctx.arc(s / 2, 20, 2.5, 0, Math.PI * 2); ctx.fill(); // finial
    ctx.fillStyle = BG_DARK; for (const cx of [18, 26, 34, 42]) ctx.fillRect(cx, 38, 3, base - 38); // columns
  },
  // Tavern — an inn with a hanging tankard sign.
  tavern(ctx, s) {
    bldGround(ctx, s);
    bldHouse(ctx, 16, 46, s - 12, 32, 20);
    bldShape(ctx, [[24, s - 12], [24, s - 24], [32, s - 24], [32, s - 12]], BG_INK); // door
    ctx.strokeStyle = BG_INK; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(46, 30); ctx.lineTo(52, 30); ctx.lineTo(52, 36); ctx.stroke();
    ctx.fillStyle = BG_LITE; ctx.beginPath(); ctx.arc(52, 40, 4, 0, Math.PI * 2); ctx.fill(); // tankard sign
    ctx.strokeStyle = BG_INK; ctx.stroke();
  },
  // Marketplace — an awning stall over coins.
  market(ctx, s) {
    bldGround(ctx, s);
    const base = s - 12;
    bldShape(ctx, [[14, base], [14, 34], [50, 34], [50, base]], BG_WALL);       // stall
    bldShape(ctx, [[10, 34], [22, 24], [42, 24], [54, 34]], BG_ROOF);           // awning
    ctx.fillStyle = BG_DARK; for (let x = 14; x < 50; x += 8) ctx.fillRect(x, 34, 4, 4); // awning scallops
    ctx.fillStyle = BG_LITE; // coins
    for (const [cx, cy] of [[26, base - 8], [34, base - 8], [30, base - 14]]) { ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = BG_INK; ctx.lineWidth = 1.5; ctx.stroke(); }
  },
  // Blacksmith — a forge with a smoking chimney and an anvil.
  blacksmith(ctx, s) {
    bldGround(ctx, s);
    const base = s - 12;
    bldShape(ctx, [[16, base], [16, 32], [48, 32], [48, base]], BG_WALL);
    bldShape(ctx, [[13, 32], [32, 22], [51, 32]], BG_ROOF);
    bldShape(ctx, [[40, 32], [40, 14], [46, 14], [46, 32]], BG_DARK);            // chimney
    ctx.fillStyle = 'rgba(230,232,238,0.5)'; ctx.beginPath(); ctx.arc(43, 12, 4, 0, Math.PI * 2); ctx.arc(46, 8, 3, 0, Math.PI * 2); ctx.fill(); // smoke
    ctx.fillStyle = BG_INK; ctx.beginPath(); ctx.arc(30, base - 4, 7, Math.PI, 0); ctx.fill(); // forge glow mouth
    ctx.fillStyle = BG_LITE; ctx.fillRect(22, base - 16, 14, 3); ctx.fillRect(27, base - 16, 4, 6); // anvil
  },
  // Shipyard — a dock with a boat hull and mast.
  shipyard(ctx, s) {
    bldGround(ctx, s);
    const base = s - 12;
    ctx.fillStyle = BG_DARK; ctx.fillRect(8, base, s - 16, 4);                    // dock
    bldShape(ctx, [[16, base], [22, base + 6], [42, base + 6], [48, base]], BG_WALL); // hull
    ctx.strokeStyle = BG_INK; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(32, base); ctx.lineTo(32, 20); ctx.stroke(); // mast
    bldShape(ctx, [[32, 20], [46, 28], [32, 34]], BG_ROOF);                       // sail
    ctx.fillStyle = 'rgba(200,205,214,0.5)'; for (let y = base + 8; y < s; y += 4) ctx.fillRect(6, y, s - 12, 2); // water
  },
  // Mage guild — an arcane spire crowned with an orb.
  guild(ctx, s) {
    bldGround(ctx, s);
    const base = s - 12;
    bldShape(ctx, [[24, base], [26, 24], [38, 24], [40, base]], BG_WALL);        // tapered spire
    bldShape(ctx, [[24, 24], [32, 10], [40, 24]], BG_ROOF);                      // conical cap
    ctx.fillStyle = BG_LITE; ctx.strokeStyle = BG_INK; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(32, 8, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); // orb
    star(ctx, 32, base - 12, 4, 5, 2, -Math.PI / 2); ctx.fillStyle = BG_LITE; ctx.fill(); // arcane star
    bldShape(ctx, [[30, base], [30, base - 8], [34, base - 8], [34, base]], BG_INK); // door
  },
  // Resource silo — a domed silo beside a barn.
  silo(ctx, s) {
    bldGround(ctx, s);
    const base = s - 12;
    bldShape(ctx, [[16, base], [16, 26], [30, 26], [30, base]], BG_WALL);        // silo body
    ctx.fillStyle = BG_ROOF; ctx.strokeStyle = BG_INK; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(23, 26, 7, Math.PI, 0); ctx.fill(); ctx.stroke(); // silo dome
    bldHouse(ctx, 32, 50, base, 32, 22);                                          // barn
    ctx.fillStyle = BG_INK; ctx.fillRect(37, base - 12, 8, 12);                   // barn door
  },
  // Generic special/ornate building (stables, future grail…): an arched hall.
  special(ctx, s) {
    bldGround(ctx, s);
    const base = s - 12;
    bldShape(ctx, [[14, base], [14, 30], [50, 30], [50, base]], BG_WALL);
    bldShape(ctx, [[11, 30], [32, 18], [53, 30]], BG_ROOF);
    ctx.fillStyle = BG_INK; ctx.beginPath(); ctx.moveTo(26, base); ctx.lineTo(26, base - 12); ctx.arc(32, base - 12, 6, Math.PI, 0); ctx.lineTo(38, base); ctx.fill(); // arch
    ctx.fillStyle = BG_LITE; ctx.beginPath(); ctx.arc(32, 24, 2.5, 0, Math.PI * 2); ctx.fill(); // finial
  },
};

/** Register the grayscale building glyphs (7 dwelling tiers + 9 categories). */
export function registerBuildingGlyphs(scene) {
  for (let t = 1; t <= 7; t++) {
    add(scene, `bld_dwelling_${t}`, paint(64, 64, (ctx, w) => BUILDING_PAINTERS.dwelling(ctx, w, t)));
  }
  for (const cat of ['fort', 'hall', 'tavern', 'market', 'blacksmith', 'shipyard', 'guild', 'silo', 'special']) {
    add(scene, `bld_${cat}`, paint(64, 64, (ctx, w) => BUILDING_PAINTERS[cat](ctx, w)));
  }
}

// ---------------------------------------------------------------------------
// Mines & map loot
// ---------------------------------------------------------------------------

export function registerResourceIcons(scene) {
  const painters = {
    gold: (ctx, s) => {
      // stack of coins
      for (let i = 0; i < 3; i++) {
        const y = s * 0.66 - i * s * 0.13;
        ctx.fillStyle = linGrad(ctx, 0, y - 6, 0, y + 6, [[0, '#ffe38a'], [1, '#c89a28']]);
        ctx.beginPath();
        ctx.ellipse(s * 0.5, y, s * 0.3, s * 0.13, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(90,60,10,0.7)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    },
    wood: (ctx, s) => {
      ctx.save();
      ctx.translate(s * 0.5, s * 0.55);
      for (const [rot, oy] of [[-0.18, -6], [0.18, 4]]) {
        ctx.save();
        ctx.rotate(rot);
        ctx.fillStyle = linGrad(ctx, -s * 0.34, 0, s * 0.34, 0, [[0, '#a8794a'], [1, '#775430']]);
        ctx.fillRect(-s * 0.34, oy - 5, s * 0.68, 11);
        ctx.fillStyle = '#d9b98c';
        ctx.beginPath();
        ctx.ellipse(s * 0.34, oy + 0.5, 3, 5.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    },
    ore: (ctx, s) => {
      ctx.fillStyle = linGrad(ctx, 0, s * 0.3, s, s * 0.8, [[0, '#a7a7b4'], [1, '#5d5d68']]);
      poly(ctx, [[s * 0.18, s * 0.75], [s * 0.3, s * 0.4], [s * 0.5, s * 0.52], [s * 0.62, s * 0.3], [s * 0.84, s * 0.75]]);
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,30,40,0.6)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      poly(ctx, [[s * 0.62, s * 0.3], [s * 0.7, s * 0.5], [s * 0.56, s * 0.44]]);
      ctx.fill();
    },
    mercury: (ctx, s) => {
      // round flask
      ctx.fillStyle = 'rgba(220,228,240,0.9)';
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.58, s * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#eef2fa';
      ctx.fillRect(s * 0.44, s * 0.16, s * 0.12, s * 0.2);
      ctx.strokeStyle = 'rgba(60,70,90,0.7)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.58, s * 0.24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = linGrad(ctx, 0, s * 0.55, 0, s * 0.8, [[0, '#dfe6f2'], [1, '#98a4bc']]);
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.62, s * 0.17, 0, Math.PI * 2);
      ctx.fill();
    },
    sulfur: (ctx, s) => {
      ctx.fillStyle = linGrad(ctx, 0, s * 0.3, 0, s * 0.8, [[0, '#f0e050'], [1, '#a89018']]);
      poly(ctx, [[s * 0.2, s * 0.76], [s * 0.42, s * 0.34], [s * 0.56, s * 0.5], [s * 0.66, s * 0.3], [s * 0.82, s * 0.76]]);
      ctx.fill();
      ctx.strokeStyle = 'rgba(80,60,0,0.55)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
    },
    crystal: (ctx, s) => {
      ctx.fillStyle = linGrad(ctx, s * 0.3, s * 0.2, s * 0.7, s * 0.8, [[0, '#ff9a9a'], [1, '#b03838']]);
      poly(ctx, [[s * 0.5, s * 0.14], [s * 0.66, s * 0.42], [s * 0.6, s * 0.78], [s * 0.4, s * 0.78], [s * 0.34, s * 0.42]]);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.14);
      ctx.lineTo(s * 0.47, s * 0.78);
      ctx.stroke();
    },
    gems: (ctx, s) => {
      const gem = (cx, cy, r, col) => {
        ctx.fillStyle = rgba(col);
        star(ctx, cx, cy, 4, r, r * 0.55, Math.PI / 4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(20,30,40,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      };
      gem(s * 0.36, s * 0.6, s * 0.16, 0x58c8d8);
      gem(s * 0.64, s * 0.56, s * 0.14, 0x8a68d8);
      gem(s * 0.5, s * 0.4, s * 0.13, 0x58d888);
    },
  };
  for (const [res, fn] of Object.entries(painters)) {
    add(scene, `res_${res}`, paint(40, 40, (ctx) => {
      withShadow(ctx, 'rgba(0,0,0,0.35)', 3, 0, 1.5);
      fn(ctx, 40);
      resetShadow(ctx);
    }));
  }
}

export function registerMapObjectSprites(scene) {
  // ---- mines: shared hut + per-type emblem ----
  const mineEmblem = {
    sawmill: (ctx, s) => {
      ctx.strokeStyle = '#e8ddc8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.42, 8, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(s * 0.5 + Math.cos(a) * 8, s * 0.42 + Math.sin(a) * 8);
        ctx.lineTo(s * 0.5 + Math.cos(a + 0.35) * 12, s * 0.42 + Math.sin(a + 0.35) * 12);
        ctx.stroke();
      }
    },
    orePit: (ctx, s) => {
      ctx.strokeStyle = '#e8ddc8';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.52);
      ctx.lineTo(s * 0.62, s * 0.3);
      ctx.moveTo(s * 0.42, s * 0.28);
      ctx.quadraticCurveTo(s * 0.56, s * 0.22, s * 0.66, s * 0.34);
      ctx.stroke();
    },
    goldMine: (ctx, s) => {
      ctx.fillStyle = '#f4c542';
      for (const [dx, dy] of [[-6, 2], [0, -2], [6, 2]]) {
        ctx.beginPath();
        ctx.ellipse(s * 0.5 + dx, s * 0.4 + dy, 4.5, 3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    alchemistLab: (ctx, s) => {
      ctx.fillStyle = '#cfd6e6';
      poly(ctx, [[s * 0.46, s * 0.24], [s * 0.54, s * 0.24], [s * 0.54, s * 0.34], [s * 0.62, s * 0.5], [s * 0.38, s * 0.5], [s * 0.46, s * 0.34]]);
      ctx.fill();
    },
    sulfurMine: (ctx, s) => {
      ctx.fillStyle = '#e8d84a';
      poly(ctx, [[s * 0.36, s * 0.5], [s * 0.5, s * 0.26], [s * 0.64, s * 0.5]]);
      ctx.fill();
    },
    crystalCavern: (ctx, s) => {
      ctx.fillStyle = '#ff8484';
      poly(ctx, [[s * 0.44, s * 0.5], [s * 0.5, s * 0.24], [s * 0.56, s * 0.5]]);
      ctx.fill();
      ctx.fillStyle = '#ffb0b0';
      poly(ctx, [[s * 0.54, s * 0.5], [s * 0.62, s * 0.32], [s * 0.68, s * 0.5]]);
      ctx.fill();
    },
    gemPond: (ctx, s) => {
      ctx.fillStyle = '#58c8d8';
      star(ctx, s * 0.5, s * 0.38, 4, 8, 4.4, Math.PI / 4);
      ctx.fill();
    },
  };
  for (const [type, emblem] of Object.entries(mineEmblem)) {
    add(scene, `mine_${type}`, paint(64, 64, (ctx) => {
      const baseY = 58;
      withShadow(ctx, 'rgba(0,0,0,0.4)', 5, 0, 2);
      // hut
      ctx.fillStyle = linGrad(ctx, 10, 26, 54, baseY, [[0, '#8d7a5e'], [1, '#5e5140']]);
      ctx.fillRect(12, baseY - 24, 40, 24);
      resetShadow(ctx);
      // roof
      ctx.fillStyle = linGrad(ctx, 8, 18, 56, 34, [[0, '#6e5844'], [1, '#443628']]);
      poly(ctx, [[6, baseY - 24], [58, baseY - 24], [46, baseY - 40], [18, baseY - 40]]);
      ctx.fill();
      // door
      ctx.fillStyle = '#2e2418';
      ctx.beginPath();
      ctx.moveTo(26, baseY);
      ctx.lineTo(26, baseY - 12);
      ctx.arc(32, baseY - 12, 6, Math.PI, 0);
      ctx.lineTo(38, baseY);
      ctx.closePath();
      ctx.fill();
      // emblem plate
      ctx.fillStyle = 'rgba(20,16,24,0.55)';
      ctx.beginPath();
      ctx.arc(32, 24, 13, 0, Math.PI * 2);
      ctx.fill();
      emblem(ctx, 64);
    }));
  }

  // ---- loose resource piles reuse res icons at map scale (see scene) ----

  // ---- treasure chest ----
  add(scene, 'chest', paint(48, 44, (ctx) => {
    withShadow(ctx, 'rgba(0,0,0,0.4)', 4, 0, 2);
    ctx.fillStyle = linGrad(ctx, 6, 14, 42, 40, [[0, '#a06a32'], [1, '#5f3d1c']]);
    ctx.fillRect(8, 18, 32, 20);
    resetShadow(ctx);
    ctx.fillStyle = linGrad(ctx, 6, 4, 42, 20, [[0, '#b87c3e'], [1, '#7a5226']]);
    ctx.beginPath();
    ctx.moveTo(8, 18);
    ctx.quadraticCurveTo(24, 2, 40, 18);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#f0c040';
    ctx.lineWidth = 2.4;
    ctx.strokeRect(8, 18, 32, 20);
    ctx.fillStyle = '#f0c040';
    ctx.fillRect(21, 18, 6, 10);
    ctx.fillStyle = '#241a10';
    ctx.fillRect(23, 22, 2, 4);
  }));

  // ---- artifact pedestal ----
  add(scene, 'pedestal', paint(48, 52, (ctx) => {
    withShadow(ctx, 'rgba(0,0,0,0.4)', 4, 0, 2);
    ctx.fillStyle = linGrad(ctx, 10, 20, 38, 50, [[0, '#b9b3c4'], [1, '#6f6a7c']]);
    poly(ctx, [[14, 48], [18, 26], [30, 26], [34, 48]]);
    ctx.fill();
    ctx.fillRect(10, 20, 28, 8);
    resetShadow(ctx);
    withShadow(ctx, 'rgba(140,190,255,0.9)', 8, 0, 0);
    ctx.fillStyle = '#dcecff';
    star(ctx, 24, 12, 4, 9, 3.4);
    ctx.fill();
    resetShadow(ctx);
  }));

  // ---- boosters ----
  const boosters = {
    attack: (ctx, s) => { // mercenary camp: tent + crossed swords
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 8, 20, 56, 52, [[0, '#b04838'], [1, '#702c20']]);
      poly(ctx, [[8, 52], [32, 16], [56, 52]]);
      ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#3a2018';
      poly(ctx, [[26, 52], [32, 36], [38, 52]]);
      ctx.fill();
      ctx.strokeStyle = '#e8ddc8';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(20, 12);
      ctx.lineTo(32, 24);
      ctx.moveTo(44, 12);
      ctx.lineTo(32, 24);
      ctx.stroke();
    },
    defense: (ctx, s) => { // watchtower
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 22, 10, 42, 54, [[0, '#c9c2b2'], [1, '#847d6c']]);
      ctx.fillRect(22, 18, 20, 36);
      resetShadow(ctx);
      ctx.fillStyle = '#9a92a0';
      for (let x = 20; x <= 40; x += 8) ctx.fillRect(x, 12, 5, 8);
      ctx.fillStyle = '#332818';
      ctx.fillRect(29, 42, 6, 12);
    },
    power: (ctx, s) => { // obelisk
      withShadow(ctx, 'rgba(120,80,255,0.7)', 8, 0, 0);
      ctx.fillStyle = linGrad(ctx, 24, 6, 40, 54, [[0, '#8a78c8'], [1, '#453a68']]);
      poly(ctx, [[26, 54], [29, 10], [35, 10], [38, 54]]);
      ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#d8ccff';
      star(ctx, 32, 8, 4, 5, 2);
      ctx.fill();
    },
    knowledge: (ctx, s) => { // garden tree
      ctx.fillStyle = '#6d5232';
      ctx.fillRect(29, 34, 6, 20);
      withShadow(ctx, 'rgba(0,0,0,0.3)', 4, 0, 2);
      ctx.fillStyle = radGrad(ctx, 30, 22, 2, 20, [[0, '#7ec860'], [1, '#3e7830']]);
      ctx.beginPath();
      ctx.arc(32, 22, 17, 0, Math.PI * 2);
      ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#f2e070';
      for (const [fx, fy] of [[24, 18], [38, 14], [34, 28], [26, 28]]) {
        ctx.beginPath();
        ctx.arc(fx, fy, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    library: (ctx) => { // an open tome radiating light — the Library of Enlightenment
      withShadow(ctx, 'rgba(0,0,0,0.35)', 5, 0, 3);
      ctx.fillStyle = '#4a3378'; // book covers, spread open
      poly(ctx, [[10, 40], [32, 34], [32, 52], [10, 50]]); ctx.fill();
      poly(ctx, [[54, 40], [32, 34], [32, 52], [54, 50]]); ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#efe7cf'; // pages
      poly(ctx, [[13, 41], [32, 36], [32, 50], [13, 48]]); ctx.fill();
      poly(ctx, [[51, 41], [32, 36], [32, 50], [51, 48]]); ctx.fill();
      ctx.strokeStyle = '#b9ab8a'; ctx.lineWidth = 1; // page lines
      for (const yy of [40, 43, 46]) {
        ctx.beginPath(); ctx.moveTo(16, yy); ctx.lineTo(30, yy - 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(34, yy - 2); ctx.lineTo(48, yy); ctx.stroke();
      }
      ctx.fillStyle = '#bfe6ff'; // knowledge rising off the page
      withShadow(ctx, 'rgba(150,220,255,0.9)', 10, 0, 0);
      ctx.beginPath(); ctx.arc(32, 22, 6, 0, Math.PI * 2); ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#f2e070';
      for (const [mx, my] of [[24, 18], [40, 18], [32, 11]]) {
        ctx.beginPath(); ctx.arc(mx, my, 1.8, 0, Math.PI * 2); ctx.fill();
      }
    },
    tradeFair: (ctx) => { // a striped market awning over crates, pennants flying
      ctx.strokeStyle = '#6d5232'; ctx.lineWidth = 2.4; // posts
      for (const px of [13, 51]) { ctx.beginPath(); ctx.moveTo(px, 28); ctx.lineTo(px, 52); ctx.stroke(); }
      withShadow(ctx, 'rgba(0,0,0,0.32)', 5, 0, 3);
      ctx.fillStyle = '#e8dfc8'; // awning
      poly(ctx, [[10, 30], [54, 30], [50, 22], [14, 22]]); ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#c2503f'; // its red stripes — filled PER STRIPE: poly()
      // begins a fresh path, so one fill after the loop shipped an awning with
      // a single stripe at the far right edge (the other three were discarded).
      for (const sx of [17, 27, 37, 47]) { poly(ctx, [[sx, 30], [sx + 5, 30], [sx + 3, 22], [sx - 2, 22]]); ctx.fill(); }
      ctx.fillStyle = '#8a6a3c'; // crates of goods beneath
      ctx.fillRect(18, 38, 12, 11);
      ctx.fillRect(33, 41, 10, 8);
      ctx.strokeStyle = '#5d4527'; ctx.lineWidth = 1;
      ctx.strokeRect(18, 38, 12, 11); ctx.strokeRect(33, 41, 10, 8);
      ctx.fillStyle = '#f2c94c'; // a spill of coin
      for (const [cx, cy] of [[46, 47], [49, 49], [43, 49]]) {
        ctx.beginPath(); ctx.arc(cx, cy, 2.1, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#3c78c8'; // pennant
      poly(ctx, [[51, 22], [51, 13], [60, 17]]); ctx.fill();
    },
    treeOfKnowledge: (ctx) => { // a great golden-fruited tree over a book at its roots
      ctx.fillStyle = '#6d5232';
      ctx.fillRect(28, 34, 8, 22);
      withShadow(ctx, 'rgba(0,0,0,0.3)', 5, 0, 2);
      ctx.fillStyle = radGrad(ctx, 32, 20, 3, 24, [[0, '#8fd86f'], [1, '#356b2c']]);
      ctx.beginPath(); ctx.arc(32, 20, 20, 0, Math.PI * 2); ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#f2c94c'; // golden fruit of knowledge
      for (const [fx, fy] of [[22, 16], [42, 14], [36, 26], [24, 28], [32, 9]]) {
        ctx.beginPath(); ctx.arc(fx, fy, 2.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#efe7cf'; // a book resting at the roots
      poly(ctx, [[26, 52], [32, 50], [38, 52], [38, 56], [26, 56]]); ctx.fill();
      ctx.strokeStyle = '#4a3378'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(32, 50); ctx.lineTo(32, 56); ctx.stroke();
    },
    xp: (ctx, s) => { // rune stone
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 14, 10, 50, 54, [[0, '#8e97a8'], [1, '#4e5563']]);
      poly(ctx, [[16, 54], [14, 26], [26, 10], [44, 14], [50, 34], [46, 54]]);
      ctx.fill();
      resetShadow(ctx);
      ctx.strokeStyle = '#a8e8ff';
      ctx.lineWidth = 2;
      withShadow(ctx, 'rgba(120,220,255,0.9)', 6, 0, 0);
      ctx.beginPath();
      ctx.moveTo(28, 20);
      ctx.lineTo(36, 26);
      ctx.lineTo(28, 32);
      ctx.lineTo(36, 40);
      ctx.stroke();
      resetShadow(ctx);
    },
    luck: (ctx, s) => { // fountain
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 10, 36, 54, 54, [[0, '#b9b3c4'], [1, '#6f6a7c']]);
      ctx.beginPath();
      ctx.ellipse(32, 46, 22, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#5aa8e0';
      ctx.beginPath();
      ctx.ellipse(32, 45, 17, 5.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#bfe4ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(32, 44);
      ctx.quadraticCurveTo(30, 26, 24, 22);
      ctx.moveTo(32, 44);
      ctx.quadraticCurveTo(34, 24, 40, 20);
      ctx.stroke();
    },
    morale: (ctx, s) => { // small temple
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = '#d9d3c6';
      ctx.fillRect(14, 30, 36, 24);
      resetShadow(ctx);
      ctx.fillStyle = '#b3ab99';
      for (const cx of [18, 28, 38, 46]) ctx.fillRect(cx, 32, 4, 22);
      ctx.fillStyle = linGrad(ctx, 10, 16, 54, 32, [[0, '#e8e2d4'], [1, '#a8a08c']]);
      poly(ctx, [[10, 30], [54, 30], [32, 14]]);
      ctx.fill();
    },
    mana: (ctx, s) => { // magic well
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 14, 28, 50, 54, [[0, '#7f8ca8'], [1, '#485064']]);
      ctx.fillRect(16, 34, 32, 20);
      resetShadow(ctx);
      ctx.fillStyle = '#3a86d8';
      withShadow(ctx, 'rgba(80,160,255,0.9)', 7, 0, 0);
      ctx.beginPath();
      ctx.ellipse(32, 35, 13, 4.5, 0, 0, Math.PI * 2);
      ctx.fill();
      resetShadow(ctx);
      ctx.strokeStyle = '#5d4e35';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(18, 34);
      ctx.lineTo(18, 18);
      ctx.moveTo(46, 34);
      ctx.lineTo(46, 18);
      ctx.moveTo(14, 18);
      ctx.lineTo(50, 18);
      ctx.stroke();
    },
    move: (ctx) => { // wayfarer's signpost — grants extra travel for the day
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = '#5d4326';
      ctx.fillRect(30, 12, 5, 42); // post
      resetShadow(ctx);
      // upper board pointing right
      ctx.fillStyle = linGrad(ctx, 8, 18, 56, 30, [[0, '#d8b878'], [1, '#a8894e']]);
      poly(ctx, [[24, 18], [48, 18], [54, 23], [48, 28], [24, 28]]);
      ctx.fill();
      // lower board pointing left
      ctx.fillStyle = linGrad(ctx, 8, 32, 56, 44, [[0, '#c8a868'], [1, '#98793e']]);
      poly(ctx, [[40, 34], [16, 34], [10, 39], [16, 44], [40, 44]]);
      ctx.fill();
      ctx.fillStyle = '#5d4326';
      for (const [nx, ny] of [[33, 22], [33, 25], [32, 37], [32, 40]]) {
        ctx.beginPath(); ctx.arc(nx, ny, 1, 0, Math.PI * 2); ctx.fill();
      }
    },
    obelisk: (ctx) => { // tall carved monolith — scouts the surrounding lands
      withShadow(ctx, 'rgba(0,0,0,0.4)', 5, 0, 3);
      ctx.fillStyle = '#4a4640';
      poly(ctx, [[20, 54], [44, 54], [40, 48], [24, 48]]); // base
      ctx.fill();
      ctx.fillStyle = linGrad(ctx, 24, 8, 40, 50, [[0, '#8c8880'], [1, '#3c3a36']]);
      poly(ctx, [[26, 50], [28, 9], [36, 9], [38, 50]]); // tapering shaft
      ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#2c2a28';
      poly(ctx, [[28, 11], [32, 2], [36, 11]]); // pointed cap
      ctx.fill();
      ctx.strokeStyle = '#8fe0ff';
      ctx.lineWidth = 1.6;
      withShadow(ctx, 'rgba(120,220,255,0.9)', 6, 0, 0);
      ctx.beginPath();
      ctx.moveTo(30, 20); ctx.lineTo(34, 20);
      ctx.moveTo(29, 29); ctx.lineTo(35, 29);
      ctx.moveTo(30, 38); ctx.lineTo(34, 38);
      ctx.stroke();
      resetShadow(ctx);
    },
    windmill: (ctx) => { // stone tower with four sails — weekly resources
      withShadow(ctx, 'rgba(0,0,0,0.4)', 5, 0, 3);
      ctx.fillStyle = linGrad(ctx, 22, 12, 42, 54, [[0, '#d8cdb4'], [1, '#8a7d63']]);
      poly(ctx, [[24, 54], [40, 54], [37, 16], [27, 16]]); // tapering tower
      ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#6b4b2c';
      poly(ctx, [[25, 17], [39, 17], [32, 6]]); // conical cap
      ctx.fill();
      ctx.fillStyle = '#5d4326';
      ctx.fillRect(30, 45, 5, 9); // door
      const hx = 32, hy = 18;
      withShadow(ctx, 'rgba(0,0,0,0.35)', 3, 0, 1);
      ctx.strokeStyle = '#efe7d2';
      ctx.lineWidth = 3;
      for (const [ax, ay] of [[-12, -12], [12, -12], [12, 12], [-12, 12]]) {
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + ax, hy + ay); ctx.stroke();
      }
      resetShadow(ctx);
      ctx.fillStyle = '#5d4326';
      ctx.beginPath(); ctx.arc(hx, hy, 2.6, 0, Math.PI * 2); ctx.fill();
    },
    waterWheel: (ctx) => { // vertical mill wheel turning in a stream — weekly gold
      withShadow(ctx, 'rgba(0,0,0,0.3)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 8, 46, 56, 56, [[0, '#4a90c0'], [1, '#2c5f88']]);
      ctx.beginPath(); ctx.ellipse(32, 50, 24, 6, 0, 0, Math.PI * 2); ctx.fill(); // stream
      resetShadow(ctx);
      const cx = 30, cy = 31, r = 18;
      ctx.strokeStyle = '#6b4a28';
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); // rim
      ctx.strokeStyle = '#8a6538';
      ctx.lineWidth = 2;
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
        ctx.stroke();
      }
      ctx.fillStyle = '#5d4326';
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill(); // hub
    },
    observatory: (ctx) => { // tall tower topped by a domed telescope — scouts a wide area
      withShadow(ctx, 'rgba(0,0,0,0.4)', 5, 0, 3);
      ctx.fillStyle = linGrad(ctx, 22, 18, 42, 54, [[0, '#c24a3a'], [1, '#6e241c']]); // redwood tower
      poly(ctx, [[24, 54], [40, 54], [38, 22], [26, 22]]);
      ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#7a2c22';
      for (const wy of [30, 40]) { ctx.fillStyle = '#4a1712'; ctx.fillRect(29, wy, 6, 6); } // windows
      // silver dome
      ctx.fillStyle = linGrad(ctx, 22, 8, 42, 22, [[0, '#e8ecf2'], [1, '#9aa6b4']]);
      ctx.beginPath(); ctx.ellipse(32, 22, 11, 9, 0, Math.PI, 0); ctx.fill();
      // telescope poking out, aimed up-right
      ctx.strokeStyle = '#3a4048';
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(30, 18); ctx.lineTo(44, 8); ctx.stroke();
      ctx.fillStyle = '#aef0ff';
      withShadow(ctx, 'rgba(140,230,255,0.9)', 6, 0, 0);
      ctx.beginPath(); ctx.arc(44, 8, 2.4, 0, Math.PI * 2); ctx.fill();
      resetShadow(ctx);
    },
    magicSpring: (ctx) => { // a glowing spring jetting water — refills mana
      withShadow(ctx, 'rgba(0,0,0,0.3)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 10, 40, 54, 56, [[0, '#7a6a58'], [1, '#4a3e30']]); // rock rim
      ctx.beginPath(); ctx.ellipse(32, 48, 22, 8, 0, 0, Math.PI * 2); ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#3a86d8';
      withShadow(ctx, 'rgba(90,170,255,0.9)', 8, 0, 0);
      ctx.beginPath(); ctx.ellipse(32, 47, 15, 5, 0, 0, Math.PI * 2); ctx.fill(); // glowing pool
      resetShadow(ctx);
      // rising jet + droplets
      ctx.strokeStyle = '#bfe4ff';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(32, 45); ctx.quadraticCurveTo(30, 24, 32, 14); ctx.stroke();
      ctx.fillStyle = '#dff2ff';
      for (const [dx, dy] of [[24, 26], [40, 22], [32, 12], [37, 32], [27, 34]]) {
        ctx.beginPath(); ctx.arc(dx, dy, 2, 0, Math.PI * 2); ctx.fill();
      }
    },
    hillFort: (ctx) => { // a small keep on a mound — upgrades the army in the field
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 8, 44, 56, 56, [[0, '#6f7a4a'], [1, '#48512e']]); // hill
      ctx.beginPath(); ctx.ellipse(32, 50, 24, 8, 0, 0, Math.PI * 2); ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = linGrad(ctx, 16, 18, 48, 50, [[0, '#b9b0a0'], [1, '#736c5e']]); // keep
      ctx.fillRect(18, 24, 28, 24);
      // crenellations
      ctx.fillStyle = '#8a8274';
      for (const bx of [18, 26, 34, 42]) ctx.fillRect(bx, 18, 5, 8);
      // gate
      ctx.fillStyle = '#3a3228';
      ctx.beginPath();
      ctx.moveTo(28, 48); ctx.lineTo(28, 38); ctx.arc(32, 38, 4, Math.PI, 0); ctx.lineTo(36, 48);
      ctx.fill();
      // side towers
      ctx.fillStyle = '#a49a88';
      ctx.fillRect(12, 28, 8, 20); ctx.fillRect(44, 28, 8, 20);
    },
    witchHut: (ctx) => { // a crooked thatched hut — teaches a secondary skill
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 16, 30, 48, 54, [[0, '#7a5a38'], [1, '#4c3720']]); // walls
      ctx.fillRect(18, 32, 28, 22);
      resetShadow(ctx);
      ctx.fillStyle = '#3a2a18'; ctx.fillRect(28, 42, 8, 12); // door
      // sagging thatch roof
      ctx.fillStyle = linGrad(ctx, 10, 14, 54, 34, [[0, '#9c8a4a'], [1, '#6b5c2e']]);
      poly(ctx, [[12, 34], [32, 12], [52, 34], [46, 34], [32, 20], [18, 34]]);
      ctx.fill();
      poly(ctx, [[12, 34], [32, 14], [52, 34]]);
      ctx.fill();
      // green glow from the window (witchcraft)
      ctx.fillStyle = '#8ef0a0';
      withShadow(ctx, 'rgba(120,240,150,0.9)', 6, 0, 0);
      ctx.fillRect(21, 38, 5, 6);
      resetShadow(ctx);
    },
    shrine: (ctx) => { // a small pillared shrine with a glowing tome/orb — teaches a spell
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      ctx.fillStyle = linGrad(ctx, 12, 44, 52, 54, [[0, '#c9c2b2'], [1, '#8a8474']]); // base
      poly(ctx, [[14, 54], [50, 54], [46, 46], [18, 46]]);
      ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = '#b3ab99'; // two pillars
      ctx.fillRect(18, 24, 6, 22); ctx.fillRect(40, 24, 6, 22);
      ctx.fillStyle = linGrad(ctx, 12, 16, 52, 24, [[0, '#e8e2d4'], [1, '#a8a08c']]); // lintel
      poly(ctx, [[14, 24], [50, 24], [32, 12]]);
      ctx.fill();
      // floating arcane orb
      ctx.fillStyle = '#8fbaff';
      withShadow(ctx, 'rgba(120,180,255,0.95)', 8, 0, 0);
      ctx.beginPath(); ctx.arc(32, 34, 5, 0, Math.PI * 2); ctx.fill();
      resetShadow(ctx);
    },
    seerHut: (ctx) => { // a seer's tent + a glowing crystal ball — sets a fetch quest
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      // conical tent
      ctx.fillStyle = linGrad(ctx, 14, 16, 50, 52, [[0, '#5b4a86'], [1, '#342a54']]);
      poly(ctx, [[32, 12], [50, 50], [14, 50]]);
      ctx.fill();
      resetShadow(ctx);
      // tent door slit + gold trim
      ctx.fillStyle = '#241d3c';
      poly(ctx, [[32, 24], [39, 50], [25, 50]]);
      ctx.fill();
      ctx.strokeStyle = '#caa74a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(32, 12); ctx.lineTo(32, 24); ctx.stroke();
      // pennant
      ctx.fillStyle = '#caa74a';
      poly(ctx, [[32, 10], [42, 13], [32, 16]]);
      ctx.fill();
      // glowing crystal ball on a stand before the tent
      ctx.fillStyle = '#6b5a3a';
      poly(ctx, [[26, 54], [38, 54], [35, 48], [29, 48]]); ctx.fill();
      ctx.fillStyle = '#b7ecff';
      withShadow(ctx, 'rgba(150,230,255,0.95)', 9, 0, 0);
      ctx.beginPath(); ctx.arc(32, 44, 6, 0, Math.PI * 2); ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(30, 42, 2, 0, Math.PI * 2); ctx.fill(); // highlight
    },
    tradingPost: (ctx) => { // a merchant's stall — sell artifacts for XP, buy them for resources
      withShadow(ctx, 'rgba(0,0,0,0.35)', 4, 0, 2);
      // wooden counter
      ctx.fillStyle = linGrad(ctx, 12, 40, 52, 54, [[0, '#8a6a3a'], [1, '#5c4522']]);
      ctx.fillRect(13, 40, 38, 14);
      resetShadow(ctx);
      // support posts
      ctx.fillStyle = '#6b5230';
      ctx.fillRect(14, 22, 4, 20); ctx.fillRect(46, 22, 4, 20);
      // ridge beam
      ctx.fillStyle = '#7a2f18';
      ctx.fillRect(11, 14, 42, 4);
      // striped canopy
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = ['#cf5330', '#ece2cb'][i % 2];
        ctx.fillRect(12 + i * 5.7, 18, 5.7, 7);
      }
      // scalloped hem
      ctx.fillStyle = '#b3471f';
      for (let i = 0; i < 7; i++) { poly(ctx, [[12 + i * 5.7, 25], [17.7 + i * 5.7, 25], [14.85 + i * 5.7, 29]]); ctx.fill(); }
      // a gold coin glinting on the counter
      ctx.fillStyle = '#f0d060';
      withShadow(ctx, 'rgba(240,210,90,0.9)', 7, 0, 0);
      ctx.beginPath(); ctx.arc(32, 36, 5, 0, Math.PI * 2); ctx.fill();
      resetShadow(ctx);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(30, 34, 1.6, 0, Math.PI * 2); ctx.fill();
    },
  };
  for (const [type, fn] of Object.entries(boosters)) {
    add(scene, `boost_${type}`, paint(64, 58, (ctx) => fn(ctx, 64)));
  }
}

// ---------------------------------------------------------------------------
// Artifact icons
// ---------------------------------------------------------------------------

export function registerArtifactIcons(scene) {
  for (const [id, art] of Object.entries(ARTIFACTS)) {
    add(scene, `art_${id}`, paint(48, 48, (ctx) => {
      // gilded plate
      withShadow(ctx, 'rgba(0,0,0,0.4)', 3, 0, 1.5);
      ctx.fillStyle = linGrad(ctx, 2, 2, 46, 46, [[0, '#3d3752'], [1, '#191625']]);
      ctx.beginPath();
      ctx.roundRect(3, 3, 42, 42, 8);
      ctx.fill();
      resetShadow(ctx);
      ctx.strokeStyle = art.value >= 3 ? '#f0c040' : art.value === 2 ? '#b8c4d8' : '#8a7a5c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(3, 3, 42, 42, 8);
      ctx.stroke();
      ctx.save();
      ctx.translate(4, 4);
      drawGlyph(ctx, art.glyph, 40, {
        fill: '#e8e2d0',
        ink: 'rgba(12,10,20,0.9)',
        accent: '#f0c040',
      });
      ctx.restore();
    }));
  }
}

// ---------------------------------------------------------------------------
// Hero portraits
// ---------------------------------------------------------------------------

export function registerPortraits(scene) {
  // `trim` tints the pauldrons/armour so classes read apart at a glance;
  // `beard` biases male faces toward facial hair for the martial archetypes.
  const CLASS_LOOK = {
    knight: { bg: 0x3a5a8c, hat: 'helm', trim: 0xcdd4e2, beard: 0.4 },
    cleric: { bg: 0x6a4a8c, hat: 'hood', trim: 0xd8c98c, beard: 0.15 },
    demoniac: { bg: 0x8c3a2e, hat: 'horns', trim: 0x7a4034, beard: 0.7 },
    heretic: { bg: 0x7c2a48, hat: 'hood', trim: 0x6a3350, beard: 0.35 },
    wizard: { bg: 0x3a6a9c, hat: 'hood', trim: 0xbcd0e8, beard: 0.2 },
    ranger: { bg: 0x3a7a46, hat: 'hood', trim: 0xa8c890, beard: 0.3 },
    druid: { bg: 0x5a7038, hat: 'hood', trim: 0xd8c98c, beard: 0.6 },
    deathKnight: { bg: 0x3e3a4c, hat: 'helm', trim: 0x8a8496, beard: 0.5 },
    necromancer: { bg: 0x4a3a58, hat: 'hood', trim: 0x9a8ca8, beard: 0.35 },
    overlord: { bg: 0x6a2a52, hat: 'helm', trim: 0xb07098, beard: 0.5 },
    warlock: { bg: 0x52306a, hat: 'hood', trim: 0xc088c0, beard: 0.3 },
    barbarian: { bg: 0x8a4a1e, hat: 'horns', trim: 0xc09050, beard: 0.7 },
    battleMage: { bg: 0x7a5a2a, hat: 'helm', trim: 0xd0b070, beard: 0.5 },
    beastmaster: { bg: 0x4a6a34, hat: 'helm', trim: 0x9aba70, beard: 0.6 },
    witch: { bg: 0x3a5a3e, hat: 'hood', trim: 0x8aba86, beard: 0.15 },
    planeswalker: { bg: 0x2a7a86, hat: 'helm', trim: 0x8ad8e0, beard: 0.5 },
    elementalist: { bg: 0x2a8a90, hat: 'hood', trim: 0x9ae8ee, beard: 0.2 },
  };
  for (const def of Object.values(HERO_ROSTER)) {
    const key = `portrait_${def.portrait}`;
    if (scene.textures.exists(key)) continue;
    const look = CLASS_LOOK[def.class] || CLASS_LOOK.knight;
    const rng = noiseRng([...def.portrait].reduce((a, ch) => a + ch.charCodeAt(0), 7));
    const female = def.portrait.includes('_f');
    add(scene, key, paint(64, 64, (ctx) => {
      // Backdrop: soft radial field with a darker vignette ring so the bust
      // pops off it (matches the old two-stop look, plus a rim).
      ctx.fillStyle = radGrad(ctx, 32, 20, 4, 52, [
        [0, rgba(shade(look.bg, 0.35))],
        [1, rgba(shade(look.bg, -0.45))],
      ]);
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = radGrad(ctx, 32, 30, 26, 46, [
        [0, 'rgba(0,0,0,0)'],
        [1, 'rgba(0,0,0,0.3)'],
      ]);
      ctx.fillRect(0, 0, 64, 64);

      const skin = rng.pick(['#e8c49a', '#d9b088', '#c89878', '#b98a66']);
      const skinDark = rgba(shade(parseHex(skin), -0.28));
      const hair = rng.pick(['#5d4228', '#2c2118', '#8c5a20', '#3a2a44', '#9a9088']);
      const trim = look.trim;

      // Neck (drawn before shoulders so the collar overlaps it).
      ctx.fillStyle = skinDark;
      ctx.fillRect(27, 36, 10, 12);

      // Pauldrons: armour plate with a class-coloured trim ridge and a
      // rim highlight, giving the bust some heft.
      ctx.fillStyle = linGrad(ctx, 12, 40, 52, 64, [[0, '#cfd4e0'], [1, '#767e92']]);
      ctx.beginPath();
      ctx.moveTo(6, 64);
      ctx.quadraticCurveTo(10, 44, 22, 44);
      ctx.quadraticCurveTo(28, 50, 32, 50);
      ctx.quadraticCurveTo(36, 50, 42, 44);
      ctx.quadraticCurveTo(54, 44, 58, 64);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba(trim, 0.9);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(9, 60);
      ctx.quadraticCurveTo(14, 47, 23, 47);
      ctx.moveTo(55, 60);
      ctx.quadraticCurveTo(50, 47, 41, 47);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(11, 58);
      ctx.quadraticCurveTo(15, 49, 22, 49);
      ctx.stroke();
      // collar gorget under the chin
      ctx.fillStyle = rgba(shade(trim, -0.1));
      ctx.beginPath();
      ctx.moveTo(24, 48);
      ctx.quadraticCurveTo(32, 54, 40, 48);
      ctx.quadraticCurveTo(36, 46, 32, 46);
      ctx.quadraticCurveTo(28, 46, 24, 48);
      ctx.closePath();
      ctx.fill();

      // Head — slightly narrower jaw than crown for a face-y silhouette.
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.moveTo(21, 25);
      ctx.quadraticCurveTo(21, 14, 32, 14);
      ctx.quadraticCurveTo(43, 14, 43, 25);
      ctx.quadraticCurveTo(43, 38, 32, 41);
      ctx.quadraticCurveTo(21, 38, 21, 25);
      ctx.closePath();
      ctx.fill();
      // ears
      ctx.beginPath();
      ctx.ellipse(21, 27, 2.4, 3.2, 0, 0, Math.PI * 2);
      ctx.ellipse(43, 27, 2.4, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      // form shadow on the right/underside of the face
      ctx.fillStyle = rgba(shade(parseHex(skin), -0.22), 0.5);
      ctx.beginPath();
      ctx.moveTo(38, 20);
      ctx.quadraticCurveTo(43, 26, 40, 36);
      ctx.quadraticCurveTo(36, 40, 32, 40);
      ctx.quadraticCurveTo(38, 34, 38, 20);
      ctx.closePath();
      ctx.fill();
      // cheek/temple highlight
      ctx.fillStyle = 'rgba(255,246,232,0.28)';
      ctx.beginPath();
      ctx.ellipse(28, 24, 4, 6, -0.3, 0, Math.PI * 2);
      ctx.fill();

      // Long hair for women, framing the face (behind the features).
      if (female) {
        ctx.fillStyle = hair;
        ctx.beginPath();
        ctx.moveTo(20, 22);
        ctx.quadraticCurveTo(16, 46, 23, 54);
        ctx.lineTo(28, 40);
        ctx.quadraticCurveTo(22, 32, 24, 19);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(44, 22);
        ctx.quadraticCurveTo(48, 46, 41, 54);
        ctx.lineTo(36, 40);
        ctx.quadraticCurveTo(42, 32, 40, 19);
        ctx.closePath();
        ctx.fill();
        // strand highlight
        ctx.strokeStyle = rgba(shade(parseHex(hair), 0.3), 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(22, 26);
        ctx.quadraticCurveTo(20, 42, 25, 50);
        ctx.stroke();
      }

      // Brows.
      ctx.strokeStyle = rgba(shade(parseHex(hair), -0.15), 0.9);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(25.5, 24);
      ctx.quadraticCurveTo(28, 22.6, 30.5, 23.6);
      ctx.moveTo(33.5, 23.6);
      ctx.quadraticCurveTo(36, 22.6, 38.5, 24);
      ctx.stroke();
      // Eyes with a catchlight.
      ctx.fillStyle = '#f4efe6';
      ctx.beginPath();
      ctx.ellipse(28, 27, 2.4, 1.8, 0, 0, Math.PI * 2);
      ctx.ellipse(36, 27, 2.4, 1.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rng.pick(['#4a3524', '#3a5a6a', '#2f4a2f', '#2a2018']);
      ctx.beginPath();
      ctx.arc(28.4, 27.2, 1.2, 0, Math.PI * 2);
      ctx.arc(36.4, 27.2, 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(27.9, 26.7, 0.5, 0, Math.PI * 2);
      ctx.arc(35.9, 26.7, 0.5, 0, Math.PI * 2);
      ctx.fill();
      // Nose (soft shadow down the bridge + tip).
      ctx.strokeStyle = rgba(shade(parseHex(skin), -0.3), 0.55);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(32, 28);
      ctx.quadraticCurveTo(33.4, 31, 32, 32.5);
      ctx.stroke();
      // Mouth.
      ctx.strokeStyle = 'rgba(120,60,50,0.85)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(28.5, 36);
      ctx.quadraticCurveTo(32, 37.8, 35.5, 36);
      ctx.stroke();

      // Beard/short hair for men.
      if (!female) {
        const bearded = rng.chance(look.beard);
        if (bearded) {
          ctx.fillStyle = hair;
          ctx.beginPath();
          ctx.moveTo(24, 30);
          ctx.quadraticCurveTo(25, 40, 32, 42.5);
          ctx.quadraticCurveTo(39, 40, 40, 30);
          ctx.quadraticCurveTo(36, 34, 32, 34);
          ctx.quadraticCurveTo(28, 34, 24, 30);
          ctx.closePath();
          ctx.fill();
          // moustache
          ctx.beginPath();
          ctx.moveTo(28, 34.5);
          ctx.quadraticCurveTo(32, 36, 36, 34.5);
          ctx.quadraticCurveTo(32, 35, 28, 34.5);
          ctx.closePath();
          ctx.fill();
        }
      }

      // Headgear (drawn last so it sits over hair/brow).
      if (look.hat === 'helm') {
        ctx.fillStyle = linGrad(ctx, 20, 8, 44, 22, [[0, '#e6ebf4'], [1, '#8a93a8']]);
        ctx.beginPath();
        ctx.moveTo(20, 24);
        ctx.quadraticCurveTo(22, 7, 32, 7);
        ctx.quadraticCurveTo(42, 7, 44, 24);
        ctx.quadraticCurveTo(38, 19, 32, 19);
        ctx.quadraticCurveTo(26, 19, 20, 24);
        ctx.closePath();
        ctx.fill();
        // brow band + nose guard
        ctx.fillStyle = rgba(trim);
        ctx.fillRect(21, 21, 22, 3);
        ctx.fillStyle = linGrad(ctx, 30, 20, 34, 34, [[0, '#e6ebf4'], [1, '#9aa2b6']]);
        ctx.fillRect(31, 22, 2, 12);
        // rivets
        ctx.fillStyle = 'rgba(60,66,82,0.8)';
        for (const rx of [23, 41]) { ctx.beginPath(); ctx.arc(rx, 22.5, 1, 0, Math.PI * 2); ctx.fill(); }
        // crest ridge
        ctx.fillStyle = rgba(shade(look.bg, 0.3));
        ctx.beginPath();
        ctx.moveTo(30, 7);
        ctx.quadraticCurveTo(32, 1, 34, 7);
        ctx.quadraticCurveTo(32, 5, 30, 7);
        ctx.closePath();
        ctx.fill();
      } else if (look.hat === 'hood') {
        ctx.fillStyle = linGrad(ctx, 16, 6, 48, 30, [
          [0, rgba(shade(look.bg, 0.25))],
          [1, rgba(shade(look.bg, -0.35))],
        ]);
        ctx.beginPath();
        ctx.moveTo(17, 32);
        ctx.quadraticCurveTo(15, 5, 32, 5);
        ctx.quadraticCurveTo(49, 5, 47, 32);
        ctx.quadraticCurveTo(42, 15, 32, 14);
        ctx.quadraticCurveTo(22, 15, 17, 32);
        ctx.closePath();
        ctx.fill();
        // fur/cloth trim around the face opening
        ctx.strokeStyle = rgba(trim, 0.9);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(19, 30);
        ctx.quadraticCurveTo(23, 15, 32, 14.5);
        ctx.quadraticCurveTo(41, 15, 45, 30);
        ctx.stroke();
        // crown gem
        ctx.fillStyle = rgba(shade(look.bg, 0.45));
        ctx.beginPath();
        ctx.arc(32, 10, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (look.hat === 'horns') {
        ctx.fillStyle = linGrad(ctx, 20, 2, 44, 18, [[0, '#e2d6c8'], [1, '#9a8878']]);
        for (const dir of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(32 + dir * 8, 17);
          ctx.quadraticCurveTo(32 + dir * 20, 12, 32 + dir * 15, 1);
          ctx.quadraticCurveTo(32 + dir * 11, 9, 32 + dir * 5, 15);
          ctx.closePath();
          ctx.fill();
          // ridged shading
          ctx.strokeStyle = 'rgba(60,40,30,0.4)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(32 + dir * 10, 14);
          ctx.quadraticCurveTo(32 + dir * 16, 10, 32 + dir * 14, 3);
          ctx.stroke();
        }
        // browband between the horns
        ctx.fillStyle = rgba(shade(look.bg, -0.1));
        ctx.beginPath();
        ctx.ellipse(32, 18, 11, 5, 0, Math.PI, 0);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,120,60,0.6)';
        ctx.beginPath();
        ctx.arc(32, 16.5, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Gilt frame.
      ctx.strokeStyle = 'rgba(240,200,90,0.8)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(1.5, 1.5, 61, 61);
    }));
  }
}

/** Parse a '#rrggbb' string to a 0xRRGGBB number (portrait palette helper). */
function parseHex(s) {
  return parseInt(s.slice(1), 16);
}

/** Register everything from this module. */
export function registerAllTokens(scene) {
  registerCreatureTokens(scene);
  registerHeroSprites(scene);
  registerTownSprites(scene);
  registerBuildingGlyphs(scene);
  registerResourceIcons(scene);
  registerMapObjectSprites(scene);
  registerArtifactIcons(scene);
  registerPortraits(scene);
  registerSpellIcons(scene);
  registerActionIcons(scene);
}
