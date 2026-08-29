/**
 * glyphs/weapons.js — Weapons / simple arms glyphs. See glyphs/index.js for how
 * these are merged into the shared GLYPHS registry and the (ctx, s, c) contract.
 */

import { stroked, lineArt, swordPath } from './primitives.js';

export const weapons = {
  pike: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.28, s * 0.85);
      ctx.lineTo(s * 0.66, s * 0.32);
    });
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.62, s * 0.36);
      ctx.quadraticCurveTo(s * 0.64, s * 0.22, s * 0.78, s * 0.14);
      ctx.quadraticCurveTo(s * 0.78, s * 0.30, s * 0.70, s * 0.42);
      ctx.closePath();
    }, 2);
  },
  halberd: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.35, s * 0.88);
      ctx.lineTo(s * 0.60, s * 0.16);
    });
    stroked(ctx, c, () => {
      // axe blade
      ctx.beginPath();
      ctx.moveTo(s * 0.58, s * 0.22);
      ctx.quadraticCurveTo(s * 0.40, s * 0.26, s * 0.34, s * 0.44);
      ctx.quadraticCurveTo(s * 0.50, s * 0.44, s * 0.62, s * 0.36);
      ctx.closePath();
    }, 2);
    stroked(ctx, c, () => {
      // top spike
      ctx.beginPath();
      ctx.moveTo(s * 0.60, s * 0.16);
      ctx.lineTo(s * 0.66, s * 0.04);
      ctx.lineTo(s * 0.68, s * 0.18);
      ctx.closePath();
    }, 2);
  },
  bow: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.38, s * 0.5, s * 0.33, -Math.PI * 0.42, Math.PI * 0.42);
    }, 3.5);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.47, s * 0.20);
      ctx.lineTo(s * 0.47, s * 0.80);
    }, 1.6);
    // arrow
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.5);
      ctx.lineTo(s * 0.80, s * 0.5);
    }, 2.4);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.86, s * 0.5);
      ctx.lineTo(s * 0.74, s * 0.44);
      ctx.lineTo(s * 0.74, s * 0.56);
      ctx.closePath();
    }, 1.6);
  },
  crossbow: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.84);
      ctx.lineTo(s * 0.5, s * 0.18);
    }, 3.5);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.14, s * 0.3, Math.PI * 0.12, Math.PI * 0.88);
    }, 3);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.22, s * 0.24);
      ctx.lineTo(s * 0.78, s * 0.24);
    }, 1.6);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.06);
      ctx.lineTo(s * 0.455, s * 0.18);
      ctx.lineTo(s * 0.545, s * 0.18);
      ctx.closePath();
    }, 1.6);
  },
  sword: (ctx, s, c) => {
    stroked(ctx, c, () => swordPath(ctx, s, s / 2, 0), 2.4);
  },
  crusader: (ctx, s, c) => {
    stroked(ctx, c, () => swordPath(ctx, s, s * 0.40, -0.5), 2);
    stroked(ctx, c, () => swordPath(ctx, s, s * 0.60, 0.5), 2);
  },
  dagger: (ctx, s, c) => {
    ctx.save();
    ctx.translate(0, -s * 0.02);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.16);
      ctx.lineTo(s * 0.56, s * 0.44);
      ctx.lineTo(s * 0.5, s * 0.52);
      ctx.lineTo(s * 0.44, s * 0.44);
      ctx.closePath();
    }, 2);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.38, s * 0.55);
      ctx.lineTo(s * 0.62, s * 0.55);
      ctx.moveTo(s * 0.5, s * 0.55);
      ctx.lineTo(s * 0.5, s * 0.74);
    }, 3);
    ctx.restore();
  },
  scimitar: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.78);
      ctx.quadraticCurveTo(s * 0.24, s * 0.40, s * 0.52, s * 0.16);
      ctx.quadraticCurveTo(s * 0.72, s * 0.02, s * 0.84, s * 0.06);
      ctx.quadraticCurveTo(s * 0.66, s * 0.16, s * 0.60, s * 0.34);
      ctx.quadraticCurveTo(s * 0.50, s * 0.58, s * 0.38, s * 0.78);
      ctx.closePath();
    }, 2);
  },
  pitchfork: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.86);
      ctx.lineTo(s * 0.5, s * 0.34);
      ctx.moveTo(s * 0.34, s * 0.34);
      ctx.lineTo(s * 0.34, s * 0.14);
      ctx.moveTo(s * 0.5, s * 0.34);
      ctx.lineTo(s * 0.5, s * 0.12);
      ctx.moveTo(s * 0.66, s * 0.34);
      ctx.lineTo(s * 0.66, s * 0.14);
    }, 3);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.34);
      ctx.lineTo(s * 0.66, s * 0.34);
    }, 3);
  },
  club: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.40, s * 0.84);
      ctx.lineTo(s * 0.34, s * 0.42);
      ctx.quadraticCurveTo(s * 0.30, s * 0.14, s * 0.52, s * 0.12);
      ctx.quadraticCurveTo(s * 0.72, s * 0.12, s * 0.64, s * 0.44);
      ctx.lineTo(s * 0.52, s * 0.86);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.ink;
    for (const [px, py] of [[0.42, 0.24], [0.56, 0.20], [0.50, 0.34]]) {
      ctx.beginPath();
      ctx.arc(s * px, s * py, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  whip: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.24, s * 0.80);
      ctx.lineTo(s * 0.34, s * 0.58);
    }, 5);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.58);
      ctx.quadraticCurveTo(s * 0.46, s * 0.20, s * 0.68, s * 0.24);
      ctx.quadraticCurveTo(s * 0.86, s * 0.30, s * 0.72, s * 0.46);
      ctx.quadraticCurveTo(s * 0.62, s * 0.56, s * 0.56, s * 0.70);
    }, 2.6);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.56, s * 0.72, 2.6, 0, Math.PI * 2);
    ctx.fill();
  },

  // ---- War machines (Ballista / First Aid Tent / Ammo Cart / Catapult) ----
  ballista: (ctx, s, c) => {
    // A-frame stand.
    lineArt(ctx, c, () => { ctx.beginPath(); ctx.moveTo(s * 0.22, s * 0.82); ctx.lineTo(s * 0.5, s * 0.5); ctx.lineTo(s * 0.78, s * 0.82); }, 3);
    // The bow, a vertical arc at the front.
    lineArt(ctx, c, () => { ctx.beginPath(); ctx.moveTo(s * 0.6, s * 0.24); ctx.quadraticCurveTo(s * 0.8, s * 0.44, s * 0.6, s * 0.64); }, 3);
    // The bolt on the rail.
    lineArt(ctx, c, () => { ctx.beginPath(); ctx.moveTo(s * 0.3, s * 0.44); ctx.lineTo(s * 0.74, s * 0.44); }, 3);
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.moveTo(s * 0.82, s * 0.44); ctx.lineTo(s * 0.68, s * 0.37); ctx.lineTo(s * 0.68, s * 0.51); ctx.closePath(); ctx.fill();
  },
  firstAidTent: (ctx, s, c) => {
    stroked(ctx, c, () => { ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.18); ctx.lineTo(s * 0.84, s * 0.8); ctx.lineTo(s * 0.16, s * 0.8); ctx.closePath(); }, 2.5);
    lineArt(ctx, c, () => { ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.44); ctx.lineTo(s * 0.5, s * 0.8); }, 3);
    // Medical cross.
    ctx.strokeStyle = c.accent; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.28); ctx.lineTo(s * 0.5, s * 0.4); ctx.moveTo(s * 0.44, s * 0.34); ctx.lineTo(s * 0.56, s * 0.34); ctx.stroke();
  },
  ammoCart: (ctx, s, c) => {
    stroked(ctx, c, () => { ctx.beginPath(); ctx.rect(s * 0.22, s * 0.44, s * 0.5, s * 0.22); }, 2.5);
    // Bolts poking out of the bed.
    ctx.strokeStyle = c.accent; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const x of [0.34, 0.44, 0.54, 0.64]) { ctx.moveTo(s * x, s * 0.44); ctx.lineTo(s * (x - 0.03), s * 0.24); }
    ctx.stroke();
    // Wheels.
    ctx.fillStyle = c.ink; ctx.beginPath(); ctx.arc(s * 0.34, s * 0.74, s * 0.09, 0, Math.PI * 2); ctx.arc(s * 0.62, s * 0.74, s * 0.09, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c.fill; ctx.beginPath(); ctx.arc(s * 0.34, s * 0.74, s * 0.04, 0, Math.PI * 2); ctx.arc(s * 0.62, s * 0.74, s * 0.04, 0, Math.PI * 2); ctx.fill();
  },
  catapult: (ctx, s, c) => {
    // Base + throwing arm + counterweight, a siege engine.
    lineArt(ctx, c, () => { ctx.beginPath(); ctx.moveTo(s * 0.2, s * 0.8); ctx.lineTo(s * 0.5, s * 0.5); ctx.lineTo(s * 0.8, s * 0.8); }, 3);
    lineArt(ctx, c, () => { ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.5); ctx.lineTo(s * 0.78, s * 0.26); }, 3);
    stroked(ctx, c, () => { ctx.beginPath(); ctx.arc(s * 0.78, s * 0.22, s * 0.09, 0, Math.PI * 2); }, 2);
  },
  arrowTower: (ctx, s, c) => {
    // A crenellated stone tower with an arrow slit.
    stroked(ctx, c, () => { ctx.beginPath(); ctx.rect(s * 0.34, s * 0.32, s * 0.32, s * 0.5); }, 2.5);
    // Battlements along the top.
    ctx.fillStyle = c.ink;
    for (const dx of [0.34, 0.46, 0.58]) ctx.fillRect(s * dx, s * 0.24, s * 0.08, s * 0.1);
    // The arrow slit + a bolt loosed from it.
    ctx.strokeStyle = c.accent; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(s * 0.5, s * 0.42); ctx.lineTo(s * 0.5, s * 0.58); ctx.stroke();
    lineArt(ctx, c, () => { ctx.beginPath(); ctx.moveTo(s * 0.66, s * 0.5); ctx.lineTo(s * 0.86, s * 0.5); }, 2.5);
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.moveTo(s * 0.9, s * 0.5); ctx.lineTo(s * 0.8, s * 0.45); ctx.lineTo(s * 0.8, s * 0.55); ctx.closePath(); ctx.fill();
  },
};
