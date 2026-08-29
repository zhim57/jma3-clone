/**
 * glyphs/artifacts.js — Artifact glyphs. See glyphs/index.js for how these are
 * merged into the shared GLYPHS registry and the (ctx, s, c) contract.
 *
 * `wonderarmor` composes `breastplate` at draw time; it resolves against the
 * MERGED registry imported from ./index.js (not this module's local
 * `artifacts`), so the cross-reference stays live across the whole registry.
 */

import { star } from '../canvasKit.js';
import { stroked, lineArt, wing, swordPath } from './primitives.js';
import { GLYPHS } from './index.js';

export const artifacts = {
  axe: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.84);
      ctx.lineTo(s * 0.62, s * 0.20);
    });
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.58, s * 0.30);
      ctx.quadraticCurveTo(s * 0.36, s * 0.30, s * 0.28, s * 0.48);
      ctx.quadraticCurveTo(s * 0.46, s * 0.50, s * 0.64, s * 0.40);
      ctx.closePath();
    }, 2);
  },
  darksword: (ctx, s, c) => stroked(ctx, { ...c, fill: '#3d3a4a' }, () => swordPath(ctx, s, s / 2, 0.35), 2.4),
  firesword: (ctx, s, c) => {
    stroked(ctx, c, () => swordPath(ctx, s, s / 2, 0.35), 2.4);
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.2);
      ctx.quadraticCurveTo(s * 0.42, s * 0.10, s * 0.40, s * 0.02);
      ctx.quadraticCurveTo(s * 0.52, s * 0.10, s * 0.46, s * 0.24);
      ctx.closePath();
    }, 1.6);
  },
  shield: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.26, s * 0.2);
      ctx.lineTo(s * 0.74, s * 0.2);
      ctx.quadraticCurveTo(s * 0.74, s * 0.62, s * 0.5, s * 0.84);
      ctx.quadraticCurveTo(s * 0.26, s * 0.62, s * 0.26, s * 0.2);
      ctx.closePath();
    }, 2.4);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.28);
    ctx.lineTo(s * 0.5, s * 0.72);
    ctx.moveTo(s * 0.36, s * 0.42);
    ctx.lineTo(s * 0.64, s * 0.42);
    ctx.stroke();
  },
  buckler: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.5, s * 0.28, 0, Math.PI * 2);
    }, 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.5, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  },
  helm: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.28, s * 0.62);
      ctx.quadraticCurveTo(s * 0.26, s * 0.28, s * 0.5, s * 0.22);
      ctx.quadraticCurveTo(s * 0.74, s * 0.28, s * 0.72, s * 0.62);
      ctx.lineTo(s * 0.6, s * 0.62);
      ctx.lineTo(s * 0.58, s * 0.48);
      ctx.lineTo(s * 0.42, s * 0.48);
      ctx.lineTo(s * 0.40, s * 0.62);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.10);
    ctx.lineTo(s * 0.56, s * 0.24);
    ctx.lineTo(s * 0.44, s * 0.24);
    ctx.closePath();
    ctx.fill();
  },
  crown: (ctx, s, c) => {
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.24, s * 0.66);
      ctx.lineTo(s * 0.22, s * 0.34);
      ctx.lineTo(s * 0.36, s * 0.48);
      ctx.lineTo(s * 0.5, s * 0.26);
      ctx.lineTo(s * 0.64, s * 0.48);
      ctx.lineTo(s * 0.78, s * 0.34);
      ctx.lineTo(s * 0.76, s * 0.66);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.fill;
    for (const px of [0.34, 0.5, 0.66]) {
      ctx.beginPath();
      ctx.arc(s * px, s * 0.58, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  breastplate: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.3, s * 0.22);
      ctx.lineTo(s * 0.7, s * 0.22);
      ctx.quadraticCurveTo(s * 0.72, s * 0.5, s * 0.60, s * 0.72);
      ctx.quadraticCurveTo(s * 0.5, s * 0.8, s * 0.40, s * 0.72);
      ctx.quadraticCurveTo(s * 0.28, s * 0.5, s * 0.3, s * 0.22);
      ctx.closePath();
    }, 2.4);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.26);
    ctx.lineTo(s * 0.5, s * 0.7);
    ctx.stroke();
  },
  wonderarmor: (ctx, s, c) => {
    GLYPHS.breastplate(ctx, s, c);
    ctx.fillStyle = c.accent;
    star(ctx, s * 0.5, s * 0.45, 4, 7, 2.8);
    ctx.fill();
  },
  cape: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.18);
      ctx.lineTo(s * 0.64, s * 0.18);
      ctx.quadraticCurveTo(s * 0.78, s * 0.5, s * 0.70, s * 0.82);
      ctx.quadraticCurveTo(s * 0.5, s * 0.72, s * 0.30, s * 0.82);
      ctx.quadraticCurveTo(s * 0.22, s * 0.5, s * 0.36, s * 0.18);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.24, 3, 0, Math.PI * 2);
    ctx.fill();
  },
  pendant: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.34, s * 0.17, Math.PI * 0.2, Math.PI * 0.8, true);
    }, 2);
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.44);
      ctx.lineTo(s * 0.62, s * 0.58);
      ctx.lineTo(s * 0.5, s * 0.78);
      ctx.lineTo(s * 0.38, s * 0.58);
      ctx.closePath();
    }, 2);
  },
  necklace: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.3, s * 0.24, Math.PI * 0.1, Math.PI * 0.9);
    }, 2);
    ctx.fillStyle = c.accent;
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (0.15 + 0.7 * (i / 4));
      ctx.beginPath();
      ctx.arc(s * 0.5 + Math.cos(a) * s * 0.24, s * 0.3 + Math.sin(a) * s * 0.24, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  ring: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.56, s * 0.17, 0, Math.PI * 2);
    }, 4);
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.20);
      ctx.lineTo(s * 0.58, s * 0.32);
      ctx.lineTo(s * 0.5, s * 0.42);
      ctx.lineTo(s * 0.42, s * 0.32);
      ctx.closePath();
    }, 1.8);
  },
  ring2: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.5, s * 0.18, 0, Math.PI * 2);
    }, 4.5);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.3, 3.2, 0, Math.PI * 2);
    ctx.fill();
  },
  boots: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.16);
      ctx.lineTo(s * 0.52, s * 0.16);
      ctx.lineTo(s * 0.52, s * 0.55);
      ctx.quadraticCurveTo(s * 0.72, s * 0.58, s * 0.74, s * 0.74);
      ctx.lineTo(s * 0.34, s * 0.74);
      ctx.closePath();
    }, 2.4);
    // speed whooshes
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(s * 0.16, s * 0.3);
    ctx.lineTo(s * 0.3, s * 0.3);
    ctx.moveTo(s * 0.12, s * 0.44);
    ctx.lineTo(s * 0.28, s * 0.44);
    ctx.stroke();
  },
  gloves: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.8);
      ctx.lineTo(s * 0.36, s * 0.4);
      ctx.lineTo(s * 0.30, s * 0.30);
      ctx.lineTo(s * 0.36, s * 0.24);
      ctx.lineTo(s * 0.44, s * 0.34);
      ctx.lineTo(s * 0.46, s * 0.2);
      ctx.lineTo(s * 0.54, s * 0.2);
      ctx.lineTo(s * 0.56, s * 0.36);
      ctx.lineTo(s * 0.64, s * 0.3);
      ctx.lineTo(s * 0.68, s * 0.38);
      ctx.lineTo(s * 0.62, s * 0.48);
      ctx.lineTo(s * 0.62, s * 0.8);
      ctx.closePath();
    }, 2.2);
  },
  purse: (ctx, s, c) => {
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.40, s * 0.30);
      ctx.lineTo(s * 0.60, s * 0.30);
      ctx.quadraticCurveTo(s * 0.78, s * 0.52, s * 0.68, s * 0.74);
      ctx.quadraticCurveTo(s * 0.5, s * 0.82, s * 0.32, s * 0.74);
      ctx.quadraticCurveTo(s * 0.22, s * 0.52, s * 0.40, s * 0.30);
      ctx.closePath();
    }, 2.2);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.42, s * 0.28);
      ctx.quadraticCurveTo(s * 0.5, s * 0.16, s * 0.58, s * 0.28);
    }, 2);
    ctx.fillStyle = c.ink;
    ctx.font = `bold ${Math.round(s * 0.24)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', s * 0.5, s * 0.56);
  },
  charm: (ctx, s, c) => {
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.14);
      ctx.quadraticCurveTo(s * 0.74, s * 0.34, s * 0.62, s * 0.6);
      ctx.quadraticCurveTo(s * 0.56, s * 0.74, s * 0.5, s * 0.8);
      ctx.quadraticCurveTo(s * 0.44, s * 0.74, s * 0.38, s * 0.6);
      ctx.quadraticCurveTo(s * 0.26, s * 0.34, s * 0.5, s * 0.14);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.fill;
    star(ctx, s * 0.5, s * 0.46, 4, 6, 2.2);
    ctx.fill();
  },
  gladius: (ctx, s, c) => {
    stroked(ctx, c, () => swordPath(ctx, s * 0.9, s / 2, 0), 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.68, 3, 0, Math.PI * 2);
    ctx.fill();
  },
  towershield: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.32, s * 0.14);
      ctx.lineTo(s * 0.68, s * 0.14);
      ctx.lineTo(s * 0.68, s * 0.66);
      ctx.quadraticCurveTo(s * 0.5, s * 0.88, s * 0.32, s * 0.66);
      ctx.closePath();
    }, 2.4);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.20);
    ctx.lineTo(s * 0.5, s * 0.78);
    ctx.moveTo(s * 0.38, s * 0.36);
    ctx.lineTo(s * 0.62, s * 0.36);
    ctx.stroke();
  },
  circlet: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.24, s * 0.56);
      ctx.quadraticCurveTo(s * 0.5, s * 0.44, s * 0.76, s * 0.56);
      ctx.lineTo(s * 0.72, s * 0.64);
      ctx.quadraticCurveTo(s * 0.5, s * 0.54, s * 0.28, s * 0.64);
      ctx.closePath();
    }, 2.2);
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.34);
      ctx.lineTo(s * 0.57, s * 0.48);
      ctx.lineTo(s * 0.5, s * 0.54);
      ctx.lineTo(s * 0.43, s * 0.48);
      ctx.closePath();
    }, 1.8);
  },
  amulet: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.32, s * 0.16, Math.PI * 0.2, Math.PI * 0.8, true);
    }, 2);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.6, s * 0.16, 0, Math.PI * 2);
    }, 2.2);
    ctx.fillStyle = c.accent;
    star(ctx, s * 0.5, s * 0.6, 4, 6, 2.4);
    ctx.fill();
  },
  scalemail: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.24);
      ctx.lineTo(s * 0.70, s * 0.24);
      ctx.quadraticCurveTo(s * 0.70, s * 0.56, s * 0.5, s * 0.80);
      ctx.quadraticCurveTo(s * 0.30, s * 0.56, s * 0.30, s * 0.24);
      ctx.closePath();
    }, 2.4);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.4;
    for (let row = 0; row < 3; row++) {
      const y = 0.34 + row * 0.14;
      for (const dx of [-0.1, 0.06]) {
        ctx.beginPath();
        ctx.arc(s * (0.5 + dx), s * y, s * 0.05, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
      }
    }
  },
  cloak: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.16);
      ctx.quadraticCurveTo(s * 0.34, s * 0.22, s * 0.30, s * 0.44);
      ctx.lineTo(s * 0.24, s * 0.82);
      ctx.quadraticCurveTo(s * 0.5, s * 0.72, s * 0.76, s * 0.82);
      ctx.lineTo(s * 0.70, s * 0.44);
      ctx.quadraticCurveTo(s * 0.66, s * 0.22, s * 0.5, s * 0.16);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.30, s * 0.08, s * 0.11, 0, 0, Math.PI * 2);
    ctx.fill();
  },
  ring3: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.56, s * 0.17, 0, Math.PI * 2);
    }, 4);
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.28, s * 0.09, 0, Math.PI * 2);
    }, 1.8);
  },
  sandals: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.60);
      ctx.lineTo(s * 0.70, s * 0.60);
      ctx.quadraticCurveTo(s * 0.74, s * 0.72, s * 0.62, s * 0.74);
      ctx.lineTo(s * 0.34, s * 0.74);
      ctx.quadraticCurveTo(s * 0.26, s * 0.72, s * 0.30, s * 0.60);
      ctx.closePath();
    }, 2.2);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.42, s * 0.60);
      ctx.lineTo(s * 0.48, s * 0.48);
      ctx.moveTo(s * 0.58, s * 0.60);
      ctx.lineTo(s * 0.50, s * 0.48);
    }, 2.4);
    wing(ctx, s * 0.30, s * 0.56, s * 0.22, -1, { ...c, fill: c.accent });
  },
  talisman: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.52, s * 0.26, 0, Math.PI * 2);
    }, 2.4);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.14);
      ctx.lineTo(s * 0.5, s * 0.26);
    }, 2);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.36);
    ctx.lineTo(s * 0.5, s * 0.68);
    ctx.moveTo(s * 0.38, s * 0.52);
    ctx.lineTo(s * 0.62, s * 0.52);
    ctx.stroke();
  },
  banner: (ctx, s, c) => {
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.86);
      ctx.lineTo(s * 0.34, s * 0.12);
    }, 3);
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.16);
      ctx.lineTo(s * 0.74, s * 0.22);
      ctx.quadraticCurveTo(s * 0.64, s * 0.34, s * 0.74, s * 0.46);
      ctx.lineTo(s * 0.36, s * 0.52);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.fill;
    star(ctx, s * 0.52, s * 0.34, 3, 5, 2.2);
    ctx.fill();
  },
};
