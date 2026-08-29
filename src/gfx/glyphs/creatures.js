/**
 * glyphs/creatures.js — Creature glyphs. See glyphs/index.js for how these are
 * merged into the shared GLYPHS registry and the (ctx, s, c) contract.
 *
 * `hornedDemon` composes `demon` at draw time; it resolves against the MERGED
 * registry imported from ./index.js (not this module's local `creatures`), so
 * that cross-reference stays live even if another module overrides `demon`.
 */

import { star, linGrad, withShadow, resetShadow, poly } from '../canvasKit.js';
import { stroked, lineArt, wing, trident, houndHead, swordPath } from './primitives.js';
import { GLYPHS } from './index.js';

export const creatures = {
  griffin: (ctx, s, c) => {
    wing(ctx, s * 0.46, s * 0.52, s * 0.42, -1, c);
    // beaked head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.46, s * 0.62);
      ctx.quadraticCurveTo(s * 0.44, s * 0.36, s * 0.58, s * 0.30);
      ctx.lineTo(s * 0.60, s * 0.20);   // ear
      ctx.lineTo(s * 0.66, s * 0.30);
      ctx.quadraticCurveTo(s * 0.82, s * 0.32, s * 0.84, s * 0.40); // beak top
      ctx.quadraticCurveTo(s * 0.74, s * 0.42, s * 0.72, s * 0.48); // beak hook
      ctx.quadraticCurveTo(s * 0.62, s * 0.66, s * 0.46, s * 0.62);
      ctx.closePath();
    }, 2);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.63, s * 0.38, 2, 0, Math.PI * 2);
    ctx.fill();
  },
  monk: (ctx, s, c) => {
    // hooded figure with glowing orb
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.28, s * 0.82);
      ctx.quadraticCurveTo(s * 0.26, s * 0.40, s * 0.5, s * 0.16);
      ctx.quadraticCurveTo(s * 0.74, s * 0.40, s * 0.72, s * 0.82);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.40, s * 0.10, s * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.62, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  },
  zealot: (ctx, s, c) => {
    // radiant orb
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.5, s * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.stroke();
    lineArt(ctx, c, () => {
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.moveTo(s * 0.5 + Math.cos(a) * s * 0.20, s * 0.5 + Math.sin(a) * s * 0.20);
        ctx.lineTo(s * 0.5 + Math.cos(a) * s * (i % 2 ? 0.3 : 0.38), s * 0.5 + Math.sin(a) * s * (i % 2 ? 0.3 : 0.38));
      }
    }, 2.6);
  },
  horse: (ctx, s, c) => {
    // chess-knight head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.84);
      ctx.quadraticCurveTo(s * 0.30, s * 0.55, s * 0.40, s * 0.40);
      ctx.quadraticCurveTo(s * 0.46, s * 0.30, s * 0.44, s * 0.18); // forehead
      ctx.lineTo(s * 0.52, s * 0.10);                               // ear
      ctx.lineTo(s * 0.56, s * 0.22);
      ctx.quadraticCurveTo(s * 0.74, s * 0.28, s * 0.80, s * 0.44); // muzzle
      ctx.lineTo(s * 0.68, s * 0.50);                               // mouth
      ctx.quadraticCurveTo(s * 0.60, s * 0.52, s * 0.58, s * 0.60);
      ctx.quadraticCurveTo(s * 0.66, s * 0.74, s * 0.66, s * 0.84);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.52, s * 0.33, 2.2, 0, Math.PI * 2);
    ctx.fill();
  },
  champion: (ctx, s, c) => {
    // helm with plume + lance
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.72, s * 0.9);
      ctx.lineTo(s * 0.86, s * 0.12);
    }, 2.6);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.26, s * 0.72);
      ctx.quadraticCurveTo(s * 0.22, s * 0.36, s * 0.44, s * 0.28);
      ctx.quadraticCurveTo(s * 0.64, s * 0.34, s * 0.62, s * 0.72);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.ink;
    ctx.fillRect(s * 0.26, s * 0.5, s * 0.36, s * 0.07);
    // plume
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.42, s * 0.28);
      ctx.quadraticCurveTo(s * 0.36, s * 0.06, s * 0.18, s * 0.10);
      ctx.quadraticCurveTo(s * 0.30, s * 0.16, s * 0.34, s * 0.30);
      ctx.closePath();
    }, 2);
  },
  angel: (ctx, s, c) => {
    wing(ctx, s * 0.5, s * 0.56, s * 0.4, -1, c);
    wing(ctx, s * 0.5, s * 0.56, s * 0.4, 1, c);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.56, s * 0.09, s * 0.2, 0, 0, Math.PI * 2);
    }, 2);
    // halo
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.22, s * 0.11, s * 0.045, 0, 0, Math.PI * 2);
    ctx.stroke();
  },
  archangel: (ctx, s, c) => {
    wing(ctx, s * 0.5, s * 0.56, s * 0.42, -1, c);
    wing(ctx, s * 0.5, s * 0.56, s * 0.42, 1, c);
    stroked(ctx, c, () => swordPath(ctx, s * 0.85, s * 0.5, 0), 2);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.16, s * 0.11, s * 0.045, 0, 0, Math.PI * 2);
    ctx.stroke();
  },
  imp: (ctx, s, c) => {
    // small horned face with grin
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.54, s * 0.2, s * 0.18, 0, 0, Math.PI * 2);
    }, 2.2);
    for (const dir of [-1, 1]) {
      stroked(ctx, c, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.5 + dir * s * 0.12, s * 0.40);
        ctx.quadraticCurveTo(s * 0.5 + dir * s * 0.22, s * 0.26, s * 0.5 + dir * s * 0.14, s * 0.12);
        ctx.quadraticCurveTo(s * 0.5 + dir * s * 0.11, s * 0.28, s * 0.5 + dir * s * 0.05, s * 0.38);
        ctx.closePath();
      }, 2);
    }
    ctx.fillStyle = c.ink;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.08, s * 0.5, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.57, s * 0.09, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  },
  fireball: (ctx, s, c) => {
    // comet with flame tail
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.20, s * 0.24);
      ctx.quadraticCurveTo(s * 0.44, s * 0.30, s * 0.56, s * 0.44);
      ctx.quadraticCurveTo(s * 0.48, s * 0.50, s * 0.36, s * 0.48);
      ctx.quadraticCurveTo(s * 0.30, s * 0.36, s * 0.20, s * 0.24);
      ctx.closePath();
    }, 2);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.60, s * 0.56, s * 0.17, 0, Math.PI * 2);
    }, 2.2);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.60, s * 0.56, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
  },
  hound: (ctx, s, c) => {
    houndHead(ctx, s * 0.5, s * 0.5, 1.15, c);
  },
  cerberus: (ctx, s, c) => {
    houndHead(ctx, s * 0.40, s * 0.36, 0.8, c);
    houndHead(ctx, s * 0.60, s * 0.42, 0.8, c);
    houndHead(ctx, s * 0.46, s * 0.62, 0.9, c);
  },
  demon: (ctx, s, c) => {
    // horned visage
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.42);
      ctx.quadraticCurveTo(s * 0.34, s * 0.72, s * 0.5, s * 0.8);
      ctx.quadraticCurveTo(s * 0.66, s * 0.72, s * 0.66, s * 0.42);
      ctx.quadraticCurveTo(s * 0.5, s * 0.34, s * 0.34, s * 0.42);
      ctx.closePath();
    }, 2.2);
    for (const dir of [-1, 1]) {
      stroked(ctx, c, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.5 + dir * s * 0.13, s * 0.42);
        ctx.quadraticCurveTo(s * 0.5 + dir * s * 0.3, s * 0.34, s * 0.5 + dir * s * 0.26, s * 0.12);
        ctx.quadraticCurveTo(s * 0.5 + dir * s * 0.16, s * 0.26, s * 0.5 + dir * s * 0.07, s * 0.36);
        ctx.closePath();
      }, 2);
    }
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * 0.5 + dir * s * 0.07, s * 0.52, 2.6, 1.8, dir * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  hornedDemon: (ctx, s, c) => {
    GLYPHS.demon(ctx, s, c);
    // extra crown spikes
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.44, s * 0.36);
      ctx.lineTo(s * 0.5, s * 0.18);
      ctx.lineTo(s * 0.56, s * 0.36);
      ctx.closePath();
    }, 2);
  },
  pitlord: (ctx, s, c) => {
    trident(ctx, s, c, true);
    for (const dir of [-1, 1]) {
      stroked(ctx, c, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.5 + dir * s * 0.12, s * 0.66);
        ctx.quadraticCurveTo(s * 0.5 + dir * s * 0.34, s * 0.6, s * 0.5 + dir * s * 0.34, s * 0.4);
        ctx.quadraticCurveTo(s * 0.5 + dir * s * 0.26, s * 0.52, s * 0.5 + dir * s * 0.12, s * 0.56);
        ctx.closePath();
      }, 2);
    }
  },
  flame: (ctx, s, c) => {
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.10);
      ctx.quadraticCurveTo(s * 0.72, s * 0.34, s * 0.66, s * 0.56);
      ctx.quadraticCurveTo(s * 0.62, s * 0.74, s * 0.5, s * 0.84);
      ctx.quadraticCurveTo(s * 0.38, s * 0.74, s * 0.34, s * 0.56);
      ctx.quadraticCurveTo(s * 0.28, s * 0.36, s * 0.42, s * 0.28);
      ctx.quadraticCurveTo(s * 0.46, s * 0.20, s * 0.5, s * 0.10);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.fill;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.42);
    ctx.quadraticCurveTo(s * 0.60, s * 0.56, s * 0.54, s * 0.68);
    ctx.quadraticCurveTo(s * 0.51, s * 0.75, s * 0.5, s * 0.76);
    ctx.quadraticCurveTo(s * 0.42, s * 0.68, s * 0.44, s * 0.58);
    ctx.quadraticCurveTo(s * 0.46, s * 0.50, s * 0.5, s * 0.42);
    ctx.closePath();
    ctx.fill();
  },
  devil: (ctx, s, c) => {
    trident(ctx, s, c);
    wing(ctx, s * 0.42, s * 0.6, s * 0.3, -1, c);
    wing(ctx, s * 0.58, s * 0.6, s * 0.3, 1, c);
  },
  archdevil: (ctx, s, c) => {
    trident(ctx, s, c, true);
    wing(ctx, s * 0.40, s * 0.62, s * 0.34, -1, c);
    wing(ctx, s * 0.60, s * 0.62, s * 0.34, 1, c);
    ctx.fillStyle = c.accent;
    star(ctx, s * 0.5, s * 0.82, 3, 5, 2.4);
    ctx.fill();
  },
  golem: (ctx, s, c) => {
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.32, s * 0.78);
      ctx.lineTo(s * 0.30, s * 0.36);
      ctx.lineTo(s * 0.42, s * 0.22);
      ctx.lineTo(s * 0.58, s * 0.22);
      ctx.lineTo(s * 0.70, s * 0.36);
      ctx.lineTo(s * 0.68, s * 0.78);
      ctx.closePath();
    }, 2.4);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(s * 0.34, s * 0.5);
    ctx.lineTo(s * 0.66, s * 0.5);
    ctx.moveTo(s * 0.5, s * 0.5);
    ctx.lineTo(s * 0.5, s * 0.76);
    ctx.stroke();
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.08, s * 0.35, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  gremlin: (ctx, s, c) => {
    // squat body with big pointed ears
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.58, s * 0.18, s * 0.22, 0, 0, Math.PI * 2);
    }, 2.2);
    for (const dir of [-1, 1]) {
      stroked(ctx, c, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.5 + dir * s * 0.14, s * 0.44);
        ctx.lineTo(s * 0.5 + dir * s * 0.34, s * 0.30);
        ctx.lineTo(s * 0.5 + dir * s * 0.18, s * 0.52);
        ctx.closePath();
      }, 2);
    }
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.08, s * 0.54, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  skeleton: (ctx, s, c) => {
    // grinning skull with jagged teeth
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.32, s * 0.56);
      ctx.quadraticCurveTo(s * 0.30, s * 0.24, s * 0.5, s * 0.22);
      ctx.quadraticCurveTo(s * 0.70, s * 0.24, s * 0.68, s * 0.56);
      ctx.lineTo(s * 0.60, s * 0.62);
      ctx.lineTo(s * 0.56, s * 0.56);
      ctx.lineTo(s * 0.5, s * 0.62);
      ctx.lineTo(s * 0.44, s * 0.56);
      ctx.lineTo(s * 0.40, s * 0.62);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.ink;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * 0.5 + dir * s * 0.11, s * 0.42, s * 0.06, s * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.46);
    ctx.lineTo(s * 0.47, s * 0.54);
    ctx.lineTo(s * 0.53, s * 0.54);
    ctx.stroke();
  },
  wolf: (ctx, s, c) => {
    // howling profile, muzzle raised
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.82);
      ctx.quadraticCurveTo(s * 0.28, s * 0.52, s * 0.38, s * 0.40);
      ctx.lineTo(s * 0.34, s * 0.24);            // ear
      ctx.lineTo(s * 0.46, s * 0.32);
      ctx.quadraticCurveTo(s * 0.54, s * 0.22, s * 0.60, s * 0.30); // muzzle up
      ctx.quadraticCurveTo(s * 0.80, s * 0.30, s * 0.84, s * 0.20);
      ctx.lineTo(s * 0.74, s * 0.40);
      ctx.quadraticCurveTo(s * 0.62, s * 0.46, s * 0.58, s * 0.58);
      ctx.quadraticCurveTo(s * 0.56, s * 0.72, s * 0.58, s * 0.84);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.46, s * 0.40, 2.2, 0, Math.PI * 2);
    ctx.fill();
  },
  mummy: (ctx, s, c) => {
    // bandaged upright figure
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.84);
      ctx.quadraticCurveTo(s * 0.32, s * 0.40, s * 0.5, s * 0.18);
      ctx.quadraticCurveTo(s * 0.68, s * 0.40, s * 0.64, s * 0.84);
      ctx.closePath();
    }, 2.4);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const y of [0.36, 0.5, 0.64, 0.78]) {
      ctx.moveTo(s * 0.34, s * y);
      ctx.lineTo(s * 0.66, s * (y + 0.03));
    }
    ctx.stroke();
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(s * 0.42, s * 0.32);
    ctx.lineTo(s * 0.58, s * 0.32);
    ctx.stroke();
  },
  medusa: (ctx, s, c) => {
    // serpent-locked head
    for (const dx of [-0.14, -0.05, 0.05, 0.14]) {
      lineArt(ctx, c, () => {
        ctx.beginPath();
        ctx.moveTo(s * (0.5 + dx), s * 0.42);
        ctx.quadraticCurveTo(s * (0.5 + dx * 2.2), s * 0.24, s * (0.5 + dx), s * 0.12);
      }, 2);
    }
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.58, s * 0.16, s * 0.2, 0, 0, Math.PI * 2);
    }, 2.2);
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.06, s * 0.54, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  cyclops: (ctx, s, c) => {
    // hulking one-eyed head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.84);
      ctx.quadraticCurveTo(s * 0.26, s * 0.34, s * 0.5, s * 0.20);
      ctx.quadraticCurveTo(s * 0.74, s * 0.34, s * 0.70, s * 0.84);
      ctx.closePath();
    }, 2.6);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.46, s * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.46, s * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(s * 0.36, s * 0.34);
    ctx.lineTo(s * 0.64, s * 0.34);
    ctx.stroke();
  },
  dragon: (ctx, s, c) => {
    wing(ctx, s * 0.44, s * 0.5, s * 0.34, -1, c);
    wing(ctx, s * 0.56, s * 0.5, s * 0.34, 1, c);
    // horned head on a coiled neck
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.40, s * 0.84);
      ctx.quadraticCurveTo(s * 0.42, s * 0.54, s * 0.5, s * 0.42);
      ctx.lineTo(s * 0.44, s * 0.30);            // horn
      ctx.lineTo(s * 0.54, s * 0.36);
      ctx.quadraticCurveTo(s * 0.66, s * 0.32, s * 0.72, s * 0.40); // snout
      ctx.lineTo(s * 0.60, s * 0.46);            // mouth
      ctx.quadraticCurveTo(s * 0.58, s * 0.60, s * 0.60, s * 0.84);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.55, s * 0.42, 2.2, 0, Math.PI * 2);
    ctx.fill();
  },

  // ======================= TOWER =======================
  servitor: (ctx, s, c) => {
    // little brass automaton: domed body + single eye + antenna
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.78);
      ctx.lineTo(s * 0.36, s * 0.52);
      ctx.quadraticCurveTo(s * 0.36, s * 0.34, s * 0.5, s * 0.34);
      ctx.quadraticCurveTo(s * 0.64, s * 0.34, s * 0.64, s * 0.52);
      ctx.lineTo(s * 0.64, s * 0.78);
      ctx.closePath();
    }, 2.2);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.34);
      ctx.lineTo(s * 0.5, s * 0.2);
    }, 2);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.18, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.5, s * 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.4, s * 0.64);
    ctx.lineTo(s * 0.6, s * 0.64);
    ctx.stroke();
  },
  masterServitor: (ctx, s, c) => {
    // refitted automaton hurling an arcane bolt
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.28, s * 0.78);
      ctx.lineTo(s * 0.28, s * 0.52);
      ctx.quadraticCurveTo(s * 0.28, s * 0.34, s * 0.42, s * 0.34);
      ctx.quadraticCurveTo(s * 0.56, s * 0.34, s * 0.56, s * 0.52);
      ctx.lineTo(s * 0.56, s * 0.78);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.arc(s * 0.42, s * 0.5, s * 0.055, 0, Math.PI * 2);
    ctx.fill();
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.58, s * 0.5);
      ctx.lineTo(s * 0.7, s * 0.46);
    }, 1.8);
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.arc(s * 0.78, s * 0.44, s * 0.08, 0, Math.PI * 2);
    }, 2);
  },
  stoneGargoyle: (ctx, s, c) => {
    wing(ctx, s * 0.5, s * 0.5, s * 0.34, -1, c);
    wing(ctx, s * 0.5, s * 0.5, s * 0.34, 1, c);
    // crouched stony body with horned brow
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.40, s * 0.78);
      ctx.lineTo(s * 0.42, s * 0.5);
      ctx.lineTo(s * 0.38, s * 0.4);            // horn
      ctx.lineTo(s * 0.48, s * 0.44);
      ctx.quadraticCurveTo(s * 0.5, s * 0.38, s * 0.52, s * 0.44);
      ctx.lineTo(s * 0.62, s * 0.4);            // horn
      ctx.lineTo(s * 0.58, s * 0.5);
      ctx.lineTo(s * 0.60, s * 0.78);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.05, s * 0.52, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  obsidianGargoyle: (ctx, s, c) => {
    GLYPHS.stoneGargoyle(ctx, s, c);
    // extra volcanic-glass crest spike
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.44, s * 0.42);
      ctx.lineTo(s * 0.5, s * 0.28);
      ctx.lineTo(s * 0.56, s * 0.42);
      ctx.closePath();
    }, 2);
  },
  stoneGolem: (ctx, s, c) => {
    // Hulking rock construct: boulder shoulders, faceted plates, glowing seams.
    const body = () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.26, s * 0.82);
      ctx.lineTo(s * 0.30, s * 0.50);
      ctx.lineTo(s * 0.23, s * 0.42);          // left shoulder boulder
      ctx.lineTo(s * 0.30, s * 0.34);
      ctx.lineTo(s * 0.40, s * 0.33);
      ctx.lineTo(s * 0.42, s * 0.24);          // neck
      ctx.lineTo(s * 0.58, s * 0.24);
      ctx.lineTo(s * 0.60, s * 0.33);
      ctx.lineTo(s * 0.70, s * 0.34);
      ctx.lineTo(s * 0.77, s * 0.42);          // right shoulder boulder
      ctx.lineTo(s * 0.70, s * 0.50);
      ctx.lineTo(s * 0.74, s * 0.82);
      ctx.closePath();
    };
    // grounded cast shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.85, s * 0.25, s * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    stroked(ctx, c, body, 2.6);
    // volumetric shading: lit upper-left, shadowed lower-right
    ctx.save();
    body();
    ctx.clip();
    ctx.fillStyle = linGrad(ctx, s * 0.2, s * 0.24, s * 0.8, s * 0.86, [
      [0, 'rgba(255,255,255,0.30)'], [0.45, 'rgba(255,255,255,0)'], [1, 'rgba(20,16,28,0.34)'],
    ]);
    ctx.fillRect(0, 0, s, s);
    // faceted plate seams
    ctx.strokeStyle = 'rgba(20,16,28,0.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.34); ctx.lineTo(s * 0.5, s * 0.8);   // spine
    ctx.moveTo(s * 0.32, s * 0.54); ctx.lineTo(s * 0.5, s * 0.6);
    ctx.moveTo(s * 0.68, s * 0.54); ctx.lineTo(s * 0.5, s * 0.6);
    ctx.moveTo(s * 0.42, s * 0.7); ctx.lineTo(s * 0.5, s * 0.66);
    ctx.moveTo(s * 0.58, s * 0.72); ctx.lineTo(s * 0.5, s * 0.66);
    ctx.stroke();
    ctx.restore();
    // brow-plate highlight
    ctx.fillStyle = 'rgba(255,255,255,0.24)';
    ctx.fillRect(s * 0.43, s * 0.255, s * 0.14, s * 0.025);
    // glowing rune seam + eyes
    withShadow(ctx, c.accent, 6, 0, 0);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.46); ctx.lineTo(s * 0.5, s * 0.6);
    ctx.stroke();
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.045, s * 0.29, s * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }
    resetShadow(ctx);
  },
  ironGolem: (ctx, s, c) => {
    GLYPHS.stoneGolem(ctx, s, c);
    // riveted plating
    ctx.fillStyle = c.accent;
    for (const [rx, ry] of [[0.4, 0.5], [0.6, 0.5], [0.4, 0.72], [0.6, 0.72]]) {
      ctx.beginPath();
      ctx.arc(s * rx, s * ry, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  mage: (ctx, s, c) => {
    // staff with glowing head
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.72, s * 0.86);
      ctx.lineTo(s * 0.72, s * 0.22);
    }, 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.72, s * 0.2, s * 0.055, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // robed body with pointed hood
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.28, s * 0.82);
      ctx.quadraticCurveTo(s * 0.30, s * 0.42, s * 0.44, s * 0.24);
      ctx.lineTo(s * 0.46, s * 0.16);           // hood point
      ctx.quadraticCurveTo(s * 0.56, s * 0.28, s * 0.58, s * 0.5);
      ctx.lineTo(s * 0.58, s * 0.82);
      ctx.closePath();
    }, 2.4);
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.ellipse(s * 0.45, s * 0.34, s * 0.06, s * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  },
  archMage: (ctx, s, c) => {
    GLYPHS.mage(ctx, s, c);
    // orbiting arcane spark around the staff head
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(s * 0.72, s * 0.2, s * 0.11, s * 0.05, -0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = c.accent;
    star(ctx, s * 0.72, s * 0.2, 4, s * 0.05, s * 0.02);
    ctx.fill();
  },
  genie: (ctx, s, c) => {
    // Ethereal spirit: smoky tail fading to vapor, crossed arms, turban, aura.
    const tail = () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.40, s * 0.52);
      ctx.quadraticCurveTo(s * 0.24, s * 0.72, s * 0.40, s * 0.86);
      ctx.quadraticCurveTo(s * 0.50, s * 0.93, s * 0.60, s * 0.86);
      ctx.quadraticCurveTo(s * 0.76, s * 0.72, s * 0.60, s * 0.52);
      ctx.closePath();
    };
    // tail fill fades to vapor at the bottom
    ctx.save();
    tail();
    ctx.clip();
    ctx.fillStyle = linGrad(ctx, 0, s * 0.5, 0, s * 0.92, [[0, c.fill], [1, 'rgba(242,236,217,0.12)']]);
    ctx.fillRect(0, s * 0.5, s, s * 0.45);
    ctx.restore();
    stroked(ctx, { ...c, fill: 'rgba(0,0,0,0)' }, tail, 2.2);
    // torso with crossed arms
    const torso = () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.32, s * 0.52);
      ctx.quadraticCurveTo(s * 0.50, s * 0.42, s * 0.68, s * 0.52);
      ctx.quadraticCurveTo(s * 0.60, s * 0.30, s * 0.50, s * 0.30);
      ctx.quadraticCurveTo(s * 0.40, s * 0.30, s * 0.32, s * 0.52);
      ctx.closePath();
    };
    stroked(ctx, c, torso, 2.2);
    ctx.save();
    torso();
    ctx.clip();
    ctx.fillStyle = linGrad(ctx, s * 0.3, s * 0.3, s * 0.7, s * 0.55, [
      [0, 'rgba(255,255,255,0.32)'], [0.5, 'rgba(255,255,255,0)'], [1, 'rgba(20,16,28,0.26)'],
    ]);
    ctx.fillRect(0, s * 0.28, s, s * 0.3);
    ctx.strokeStyle = 'rgba(20,16,28,0.45)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(s * 0.36, s * 0.44); ctx.lineTo(s * 0.64, s * 0.5);   // crossed arms
    ctx.moveTo(s * 0.64, s * 0.44); ctx.lineTo(s * 0.36, s * 0.5);
    ctx.stroke();
    ctx.restore();
    // head
    stroked(ctx, c, () => { ctx.beginPath(); ctx.arc(s * 0.5, s * 0.24, s * 0.085, 0, Math.PI * 2); }, 2);
    // turban band + jewel
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(s * 0.41, s * 0.2);
    ctx.quadraticCurveTo(s * 0.5, s * 0.125, s * 0.59, s * 0.2);
    ctx.quadraticCurveTo(s * 0.5, s * 0.185, s * 0.41, s * 0.2);
    ctx.closePath();
    ctx.fill();
    withShadow(ctx, c.accent, 6, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(s * 0.5, s * 0.172, s * 0.013, 0, Math.PI * 2); ctx.fill();
    // topknot flame
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.13);
    ctx.lineTo(s * 0.47, s * 0.05);
    ctx.quadraticCurveTo(s * 0.5, s * 0.09, s * 0.53, s * 0.07);
    ctx.closePath();
    ctx.fill();
    resetShadow(ctx);
    // glowing eyes
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.032, s * 0.245, s * 0.012, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  masterGenie: (ctx, s, c) => {
    GLYPHS.genie(ctx, s, c);
    // blessing sparkles
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      star(ctx, s * 0.5 + dir * s * 0.2, s * 0.24, 4, s * 0.035, s * 0.015);
      ctx.fill();
    }
  },
  naga: (ctx, s, c) => {
    // coiled serpent tail
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.32, s * 0.8);
      ctx.quadraticCurveTo(s * 0.2, s * 0.66, s * 0.36, s * 0.58);
      ctx.quadraticCurveTo(s * 0.56, s * 0.5, s * 0.5, s * 0.4);
      ctx.quadraticCurveTo(s * 0.46, s * 0.34, s * 0.5, s * 0.3);
      ctx.quadraticCurveTo(s * 0.6, s * 0.4, s * 0.58, s * 0.56);
      ctx.quadraticCurveTo(s * 0.68, s * 0.72, s * 0.6, s * 0.82);
      ctx.closePath();
    }, 2.4);
    // upper body head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.24, s * 0.08, s * 0.1, 0, 0, Math.PI * 2);
    }, 2);
    // pair of raised blade-arms
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.42, s * 0.34);
      ctx.lineTo(s * 0.26, s * 0.2);
      ctx.moveTo(s * 0.58, s * 0.34);
      ctx.lineTo(s * 0.74, s * 0.2);
    }, 2.2);
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.035, s * 0.23, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  nagaQueen: (ctx, s, c) => {
    GLYPHS.naga(ctx, s, c);
    // crown atop the head
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.42, s * 0.16);
      ctx.lineTo(s * 0.44, s * 0.08);
      ctx.lineTo(s * 0.5, s * 0.13);
      ctx.lineTo(s * 0.56, s * 0.08);
      ctx.lineTo(s * 0.58, s * 0.16);
      ctx.closePath();
    }, 1.8);
  },
  giant: (ctx, s, c) => {
    // Colossus: broad pauldrons, plated chest with metal sheen, helmed head.
    const torso = () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.24, s * 0.82);
      ctx.lineTo(s * 0.28, s * 0.46);
      ctx.quadraticCurveTo(s * 0.20, s * 0.40, s * 0.26, s * 0.34);  // left pauldron
      ctx.quadraticCurveTo(s * 0.34, s * 0.30, s * 0.42, s * 0.32);
      ctx.lineTo(s * 0.42, s * 0.26);
      ctx.quadraticCurveTo(s * 0.50, s * 0.22, s * 0.58, s * 0.26);
      ctx.lineTo(s * 0.58, s * 0.32);
      ctx.quadraticCurveTo(s * 0.66, s * 0.30, s * 0.74, s * 0.34);
      ctx.quadraticCurveTo(s * 0.80, s * 0.40, s * 0.72, s * 0.46);  // right pauldron
      ctx.lineTo(s * 0.76, s * 0.82);
      ctx.closePath();
    };
    // cast shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.85, s * 0.26, s * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
    stroked(ctx, c, torso, 2.6);
    // metal sheen + shading
    ctx.save();
    torso();
    ctx.clip();
    ctx.fillStyle = linGrad(ctx, s * 0.24, 0, s * 0.76, 0, [
      [0, 'rgba(255,255,255,0.32)'], [0.5, 'rgba(255,255,255,0.05)'], [1, 'rgba(20,16,28,0.3)'],
    ]);
    ctx.fillRect(0, s * 0.3, s, s * 0.55);
    ctx.strokeStyle = 'rgba(20,16,28,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(s * 0.3, s * 0.52); ctx.quadraticCurveTo(s * 0.5, s * 0.58, s * 0.7, s * 0.52);  // belt
    ctx.moveTo(s * 0.5, s * 0.34); ctx.lineTo(s * 0.5, s * 0.52);                                 // sternum
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.beginPath();
    ctx.arc(s * 0.27, s * 0.38, s * 0.02, 0, Math.PI * 2);
    ctx.arc(s * 0.73, s * 0.38, s * 0.02, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // helmed head
    stroked(ctx, c, () => { ctx.beginPath(); ctx.arc(s * 0.5, s * 0.2, s * 0.085, 0, Math.PI * 2); }, 2.2);
    ctx.fillStyle = 'rgba(20,16,28,0.55)';
    ctx.fillRect(s * 0.44, s * 0.19, s * 0.12, s * 0.02);  // visor slit
    // glowing eyes
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.032, s * 0.205, s * 0.013, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  titan: (ctx, s, c) => {
    GLYPHS.giant(ctx, s, c);
    // crackling lightning bolt, glowing white-hot
    withShadow(ctx, c.accent, 7, 0, 0);
    ctx.fillStyle = c.accent;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s * 0.82, s * 0.2);
    ctx.lineTo(s * 0.70, s * 0.42);
    ctx.lineTo(s * 0.79, s * 0.44);
    ctx.lineTo(s * 0.66, s * 0.72);
    ctx.lineTo(s * 0.78, s * 0.44);
    ctx.lineTo(s * 0.72, s * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    resetShadow(ctx);
  },

  // ======================= RAMPART =======================
  centaur: (ctx, s, c) => {
    // raised spear beside a horse-kin profile
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.72, s * 0.9);
      ctx.lineTo(s * 0.86, s * 0.18);
    }, 2.6);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.82, s * 0.22);
      ctx.lineTo(s * 0.88, s * 0.05);
      ctx.lineTo(s * 0.93, s * 0.24);
      ctx.closePath();
    }, 1.8);
    ctx.save();
    ctx.translate(-s * 0.06, s * 0.04);
    GLYPHS.horse(ctx, s * 0.94, c);
    ctx.restore();
  },
  dwarf: (ctx, s, c) => {
    // domed helmet
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.40);
      ctx.quadraticCurveTo(s * 0.30, s * 0.18, s * 0.5, s * 0.18);
      ctx.quadraticCurveTo(s * 0.70, s * 0.18, s * 0.70, s * 0.40);
      ctx.closePath();
    }, 2.2);
    // broad forked beard
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.32, s * 0.44);
      ctx.quadraticCurveTo(s * 0.30, s * 0.72, s * 0.5, s * 0.84);
      ctx.quadraticCurveTo(s * 0.70, s * 0.72, s * 0.68, s * 0.44);
      ctx.quadraticCurveTo(s * 0.5, s * 0.54, s * 0.32, s * 0.44);
      ctx.closePath();
    }, 2.2);
    ctx.fillStyle = c.ink;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.08, s * 0.42, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // rune stud on the helm
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.28, 2.4, 0, Math.PI * 2);
    ctx.fill();
  },
  pegasus: (ctx, s, c) => {
    // winged steed: a raised wing behind the horse profile
    wing(ctx, s * 0.36, s * 0.46, s * 0.36, -1, c);
    ctx.save();
    ctx.translate(s * 0.08, s * 0.04);
    GLYPHS.horse(ctx, s * 0.92, c);
    ctx.restore();
  },
  dendroid: (ctx, s, c) => {
    // rooted trunk
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.86);
      ctx.lineTo(s * 0.40, s * 0.50);
      ctx.lineTo(s * 0.60, s * 0.50);
      ctx.lineTo(s * 0.66, s * 0.86);
      ctx.closePath();
    }, 2.4);
    // reaching branch-arms
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.42, s * 0.56);
      ctx.lineTo(s * 0.20, s * 0.38);
      ctx.moveTo(s * 0.58, s * 0.56);
      ctx.lineTo(s * 0.80, s * 0.38);
    }, 2.6);
    // leafy crown
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.30, s * 0.22, s * 0.19, 0, 0, Math.PI * 2);
    }, 2.4);
    // eyes glowing in the bark
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.06, s * 0.62, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  unicorn: (ctx, s, c) => {
    GLYPHS.horse(ctx, s, c);
    // spiral horn rising from the forehead
    stroked(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.46, s * 0.22);
      ctx.lineTo(s * 0.68, s * 0.02);
      ctx.lineTo(s * 0.55, s * 0.26);
      ctx.closePath();
    }, 1.8);
  },
  goldDragon: (ctx, s, c) => {
    GLYPHS.dragon(ctx, s, c);
    // gleaming crest star
    ctx.fillStyle = c.accent;
    star(ctx, s * 0.5, s * 0.14, 4, s * 0.06, s * 0.025);
    ctx.fill();
  },
  // ---- Necropolis ----
  zombie: (ctx, s, c) => {
    // hunched shambling corpse, arms outstretched
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.40, s * 0.86);
      ctx.quadraticCurveTo(s * 0.36, s * 0.52, s * 0.42, s * 0.36);
      ctx.quadraticCurveTo(s * 0.5, s * 0.26, s * 0.58, s * 0.36);
      ctx.quadraticCurveTo(s * 0.64, s * 0.52, s * 0.60, s * 0.86);
      ctx.closePath();
    }, 2.4);
    // hollow head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.28, s * 0.11, 0, Math.PI * 2);
    }, 2.2);
    ctx.fillStyle = c.ink;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.045, s * 0.28, s * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }
    // limp outstretched arms
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.42, s * 0.5);
      ctx.lineTo(s * 0.22, s * 0.54);
      ctx.moveTo(s * 0.58, s * 0.5);
      ctx.lineTo(s * 0.78, s * 0.46);
    }, 2.6);
  },
  wight: (ctx, s, c) => {
    // a drifting shroud: hooded head tapering to a wispy tail
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.14);
      ctx.quadraticCurveTo(s * 0.72, s * 0.2, s * 0.68, s * 0.5);
      ctx.quadraticCurveTo(s * 0.66, s * 0.72, s * 0.58, s * 0.86);
      ctx.quadraticCurveTo(s * 0.53, s * 0.74, s * 0.5, s * 0.86);
      ctx.quadraticCurveTo(s * 0.47, s * 0.74, s * 0.42, s * 0.86);
      ctx.quadraticCurveTo(s * 0.34, s * 0.72, s * 0.32, s * 0.5);
      ctx.quadraticCurveTo(s * 0.28, s * 0.2, s * 0.5, s * 0.14);
      ctx.closePath();
    }, 2.4);
    // dark hollow of the cowl
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.34, s * 0.11, s * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
    // cold eyes
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.045, s * 0.33, s * 0.022, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  vampire: (ctx, s, c) => {
    // a bat silhouette: scalloped wings, small body, pointed ears
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.4);
      // right wing
      ctx.quadraticCurveTo(s * 0.66, s * 0.24, s * 0.9, s * 0.32);
      ctx.quadraticCurveTo(s * 0.76, s * 0.4, s * 0.82, s * 0.56);
      ctx.quadraticCurveTo(s * 0.68, s * 0.48, s * 0.6, s * 0.58);
      // right leg
      ctx.lineTo(s * 0.56, s * 0.74);
      ctx.lineTo(s * 0.5, s * 0.64);
      // left leg
      ctx.lineTo(s * 0.44, s * 0.74);
      ctx.lineTo(s * 0.4, s * 0.58);
      // left wing
      ctx.quadraticCurveTo(s * 0.32, s * 0.48, s * 0.18, s * 0.56);
      ctx.quadraticCurveTo(s * 0.24, s * 0.4, s * 0.1, s * 0.32);
      ctx.quadraticCurveTo(s * 0.34, s * 0.24, s * 0.5, s * 0.4);
      ctx.closePath();
    }, 2.2);
    // pointed ears + head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.43, s * 0.3);
      ctx.lineTo(s * 0.46, s * 0.18);
      ctx.lineTo(s * 0.5, s * 0.28);
      ctx.lineTo(s * 0.54, s * 0.18);
      ctx.lineTo(s * 0.57, s * 0.3);
      ctx.closePath();
    }, 1.8);
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.04, s * 0.36, s * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  lich: (ctx, s, c) => {
    // a robed skull-mage leaning on a staff
    // staff
    lineArt(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.72, s * 0.18);
      ctx.lineTo(s * 0.72, s * 0.88);
    }, 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.72, s * 0.16, s * 0.045, 0, Math.PI * 2);
    ctx.fill();
    // robed body
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.30, s * 0.86);
      ctx.quadraticCurveTo(s * 0.28, s * 0.44, s * 0.44, s * 0.34);
      ctx.quadraticCurveTo(s * 0.56, s * 0.4, s * 0.58, s * 0.6);
      ctx.quadraticCurveTo(s * 0.58, s * 0.76, s * 0.56, s * 0.86);
      ctx.closePath();
    }, 2.4);
    // hooded skull face
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.42, s * 0.3, s * 0.1, 0, Math.PI * 2);
    }, 2);
    ctx.fillStyle = c.ink;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.42 + dir * s * 0.04, s * 0.3, s * 0.022, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  blackKnight: (ctx, s, c) => {
    // a grim horned battle-helm with a dark visor slit
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.78);
      ctx.quadraticCurveTo(s * 0.28, s * 0.44, s * 0.5, s * 0.24);
      ctx.quadraticCurveTo(s * 0.72, s * 0.44, s * 0.66, s * 0.78);
      ctx.quadraticCurveTo(s * 0.5, s * 0.86, s * 0.34, s * 0.78);
      ctx.closePath();
    }, 2.4);
    // horns sweeping up from the temples
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.42);
      ctx.quadraticCurveTo(s * 0.2, s * 0.3, s * 0.24, s * 0.14);
      ctx.quadraticCurveTo(s * 0.3, s * 0.26, s * 0.4, s * 0.34);
      ctx.closePath();
      ctx.moveTo(s * 0.66, s * 0.42);
      ctx.quadraticCurveTo(s * 0.8, s * 0.3, s * 0.76, s * 0.14);
      ctx.quadraticCurveTo(s * 0.7, s * 0.26, s * 0.6, s * 0.34);
      ctx.closePath();
    }, 2);
    // visor slit, glowing
    ctx.fillStyle = c.accent;
    ctx.fillRect(s * 0.38, s * 0.5, s * 0.24, s * 0.05);
    ctx.fillStyle = c.ink;
    ctx.fillRect(s * 0.48, s * 0.5, s * 0.04, s * 0.05);
  },
  boneDragon: (ctx, s, c) => {
    // the dragon silhouette, stripped to bone: ribs + a hollow eye socket
    GLYPHS.dragon(ctx, s, c);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const off of [0, 0.08, 0.16]) {
      ctx.moveTo(s * (0.4 - off * 0.3), s * (0.52 + off));
      ctx.lineTo(s * (0.6 - off * 0.3), s * (0.5 + off));
    }
    ctx.stroke();
    // hollow eye socket
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.arc(s * 0.6, s * 0.36, s * 0.035, 0, Math.PI * 2);
    ctx.fill();
  },
  // ---- Dungeon ----
  troglodyte: (ctx, s, c) => {
    // a hunched, eyeless cave-brute hefting a club
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.84);
      ctx.quadraticCurveTo(s * 0.28, s * 0.5, s * 0.42, s * 0.42);
      ctx.quadraticCurveTo(s * 0.4, s * 0.28, s * 0.52, s * 0.26);
      ctx.quadraticCurveTo(s * 0.64, s * 0.28, s * 0.6, s * 0.44);
      ctx.quadraticCurveTo(s * 0.7, s * 0.56, s * 0.64, s * 0.84);
      ctx.closePath();
    }, 2.4);
    // heavy brow, no eyes
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s * 0.46, s * 0.34);
    ctx.lineTo(s * 0.58, s * 0.34);
    ctx.stroke();
    // club
    lineArt(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.6, s * 0.6);
      ctx.lineTo(s * 0.8, s * 0.3);
    }, 3);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.82, s * 0.26, s * 0.06, 0, Math.PI * 2);
    ctx.fill();
  },
  harpy: (ctx, s, c) => {
    // a winged bird-woman: head between two sweeping wings, talons below
    wing(ctx, s * 0.44, s * 0.4, s * 0.3, -1, c);
    wing(ctx, s * 0.56, s * 0.4, s * 0.3, 1, c);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.32, s * 0.09, 0, Math.PI * 2);
    }, 2);
    // torso
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.44, s * 0.4);
      ctx.quadraticCurveTo(s * 0.5, s * 0.56, s * 0.56, s * 0.4);
      ctx.closePath();
    }, 2);
    // talons
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (const dx of [-0.05, 0.05]) {
      ctx.moveTo(s * (0.5 + dx), s * 0.54);
      ctx.lineTo(s * (0.5 + dx), s * 0.68);
      ctx.moveTo(s * (0.5 + dx), s * 0.68);
      ctx.lineTo(s * (0.5 + dx - 0.03), s * 0.72);
      ctx.moveTo(s * (0.5 + dx), s * 0.68);
      ctx.lineTo(s * (0.5 + dx + 0.03), s * 0.72);
    }
    ctx.stroke();
  },
  beholder: (ctx, s, c) => {
    // a floating orb dominated by one great eye, wreathed in tendrils
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(s * 0.5 + Math.cos(a) * s * 0.2, s * 0.5 + Math.sin(a) * s * 0.2);
      ctx.lineTo(s * 0.5 + Math.cos(a) * s * 0.32, s * 0.5 + Math.sin(a) * s * 0.32);
      ctx.stroke();
    }
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.5, s * 0.2, 0, Math.PI * 2);
    }, 2.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.5, s * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.5, s * 0.045, 0, Math.PI * 2);
    ctx.fill();
  },
  minotaur: (ctx, s, c) => {
    // a horned bull head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.4);
      ctx.quadraticCurveTo(s * 0.36, s * 0.66, s * 0.5, s * 0.74);
      ctx.quadraticCurveTo(s * 0.64, s * 0.66, s * 0.64, s * 0.4);
      ctx.quadraticCurveTo(s * 0.5, s * 0.32, s * 0.36, s * 0.4);
      ctx.closePath();
    }, 2.4);
    // horns
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.42);
      ctx.quadraticCurveTo(s * 0.2, s * 0.36, s * 0.18, s * 0.22);
      ctx.quadraticCurveTo(s * 0.28, s * 0.3, s * 0.4, s * 0.34);
      ctx.closePath();
      ctx.moveTo(s * 0.64, s * 0.42);
      ctx.quadraticCurveTo(s * 0.8, s * 0.36, s * 0.82, s * 0.22);
      ctx.quadraticCurveTo(s * 0.72, s * 0.3, s * 0.6, s * 0.34);
      ctx.closePath();
    }, 2);
    // snout + eyes
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.07, s * 0.48, s * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(s * 0.45, s * 0.62);
    ctx.lineTo(s * 0.55, s * 0.62);
    ctx.stroke();
  },
  manticore: (ctx, s, c) => {
    // a maned beast head with a curling barbed scorpion tail
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.42, s * 0.52, s * 0.18, 0, Math.PI * 2);
    }, 2.4);
    // spiky mane
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(s * 0.42 + Math.cos(a) * s * 0.18, s * 0.52 + Math.sin(a) * s * 0.18);
      ctx.lineTo(s * 0.42 + Math.cos(a) * s * 0.26, s * 0.52 + Math.sin(a) * s * 0.26);
      ctx.stroke();
    }
    // eyes
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.42 + dir * s * 0.06, s * 0.5, s * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }
    // barbed tail arcing over the back
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.56, s * 0.62);
      ctx.quadraticCurveTo(s * 0.84, s * 0.6, s * 0.8, s * 0.28);
    }, 2.6);
    ctx.fillStyle = c.accent;
    poly(ctx, [[s * 0.8, s * 0.32], [s * 0.74, s * 0.2], [s * 0.86, s * 0.22]]);
    ctx.fill();
  },
  // ---- Stronghold ----
  goblin: (ctx, s, c) => {
    // a snarling big-eared runt brandishing a jagged blade
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.4, s * 0.82);
      ctx.quadraticCurveTo(s * 0.36, s * 0.56, s * 0.44, s * 0.46);
      ctx.quadraticCurveTo(s * 0.42, s * 0.34, s * 0.5, s * 0.32);
      ctx.quadraticCurveTo(s * 0.58, s * 0.34, s * 0.56, s * 0.46);
      ctx.quadraticCurveTo(s * 0.64, s * 0.56, s * 0.6, s * 0.82);
      ctx.closePath();
    }, 2.2);
    // big pointed ears
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.44, s * 0.38);
      ctx.lineTo(s * 0.3, s * 0.3);
      ctx.lineTo(s * 0.44, s * 0.44);
      ctx.closePath();
      ctx.moveTo(s * 0.56, s * 0.38);
      ctx.lineTo(s * 0.7, s * 0.3);
      ctx.lineTo(s * 0.56, s * 0.44);
      ctx.closePath();
    }, 1.6);
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.04, s * 0.4, s * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }
    // jagged blade
    lineArt(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.62, s * 0.6);
      ctx.lineTo(s * 0.8, s * 0.28);
    }, 2.4);
  },
  wolfRider: (ctx, s, c) => {
    // a loping wolf with a small hunched rider
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.16, s * 0.74);            // rump
      ctx.quadraticCurveTo(s * 0.2, s * 0.56, s * 0.34, s * 0.56);
      ctx.lineTo(s * 0.62, s * 0.54);            // back
      ctx.quadraticCurveTo(s * 0.74, s * 0.52, s * 0.82, s * 0.44); // neck to head
      ctx.lineTo(s * 0.9, s * 0.4);              // muzzle
      ctx.lineTo(s * 0.8, s * 0.5);
      ctx.quadraticCurveTo(s * 0.7, s * 0.62, s * 0.6, s * 0.64);
      ctx.lineTo(s * 0.3, s * 0.66);
      ctx.quadraticCurveTo(s * 0.2, s * 0.72, s * 0.16, s * 0.74);
      ctx.closePath();
    }, 2.2);
    // legs
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (const x of [0.3, 0.44, 0.56]) { ctx.moveTo(s * x, s * 0.64); ctx.lineTo(s * x, s * 0.82); }
    ctx.stroke();
    // rider
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.46, s * 0.36, s * 0.07, 0, Math.PI * 2);
    }, 1.8);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s * 0.46, s * 0.42);
    ctx.lineTo(s * 0.46, s * 0.54);
    ctx.moveTo(s * 0.46, s * 0.44);
    ctx.lineTo(s * 0.6, s * 0.3); // raised weapon
    ctx.stroke();
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(s * 0.84, s * 0.44, 1.8, 0, Math.PI * 2); ctx.fill(); // wolf eye
  },
  orc: (ctx, s, c) => {
    // a broad tusked brute hefting a javelin
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.3, s * 0.84);
      ctx.quadraticCurveTo(s * 0.26, s * 0.5, s * 0.42, s * 0.44);
      ctx.quadraticCurveTo(s * 0.4, s * 0.3, s * 0.5, s * 0.28);
      ctx.quadraticCurveTo(s * 0.6, s * 0.3, s * 0.58, s * 0.44);
      ctx.quadraticCurveTo(s * 0.74, s * 0.5, s * 0.7, s * 0.84);
      ctx.closePath();
    }, 2.4);
    // tusks
    ctx.fillStyle = c.fill;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.2;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 0.5 + dir * s * 0.03, s * 0.42);
      ctx.lineTo(s * 0.5 + dir * s * 0.05, s * 0.48);
      ctx.stroke();
    }
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.5 + dir * s * 0.045, s * 0.36, s * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }
    // javelin
    lineArt(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.72, s * 0.86);
      ctx.lineTo(s * 0.78, s * 0.2);
    }, 2);
    ctx.fillStyle = c.accent;
    poly(ctx, [[s * 0.78, s * 0.16], [s * 0.74, s * 0.26], [s * 0.82, s * 0.26]]);
    ctx.fill();
  },
  ogre: (ctx, s, c) => {
    // a hulking hunched brute with a massive club
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.26, s * 0.84);
      ctx.quadraticCurveTo(s * 0.22, s * 0.46, s * 0.4, s * 0.42);
      ctx.quadraticCurveTo(s * 0.42, s * 0.3, s * 0.52, s * 0.3);
      ctx.quadraticCurveTo(s * 0.62, s * 0.32, s * 0.6, s * 0.44);
      ctx.quadraticCurveTo(s * 0.78, s * 0.5, s * 0.72, s * 0.84);
      ctx.closePath();
    }, 2.6);
    // small angry eyes + brow
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s * 0.44, s * 0.36);
    ctx.lineTo(s * 0.58, s * 0.36);
    ctx.stroke();
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.51 + dir * s * 0.05, s * 0.4, s * 0.02, 0, Math.PI * 2);
      ctx.fill();
    }
    // club over the shoulder
    lineArt(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.66, s * 0.56);
      ctx.lineTo(s * 0.84, s * 0.24);
    }, 3.4);
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(s * 0.85, s * 0.2, s * 0.08, 0, Math.PI * 2); ctx.fill();
  },
  roc: (ctx, s, c) => {
    // a great raptor with broad spread wings and a hooked beak
    wing(ctx, s * 0.42, s * 0.44, s * 0.34, -1, c);
    wing(ctx, s * 0.58, s * 0.44, s * 0.34, 1, c);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.52, s * 0.09, s * 0.14, 0, 0, Math.PI * 2);
    }, 2.2);
    // head + hooked beak
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.32, s * 0.07, 0, Math.PI * 2);
    }, 1.8);
    ctx.fillStyle = c.accent;
    poly(ctx, [[s * 0.5, s * 0.3], [s * 0.44, s * 0.28], [s * 0.5, s * 0.24]]);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s * 0.53, s * 0.3, s * 0.015, 0, Math.PI * 2);
    ctx.fill();
    // talons
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (const dx of [-0.04, 0.04]) { ctx.moveTo(s * (0.5 + dx), s * 0.64); ctx.lineTo(s * (0.5 + dx), s * 0.74); }
    ctx.stroke();
  },
  behemoth: (ctx, s, c) => {
    // a hulking horned beast, all shoulders and fanged maw
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.22, s * 0.84);
      ctx.quadraticCurveTo(s * 0.2, s * 0.52, s * 0.34, s * 0.46);
      ctx.quadraticCurveTo(s * 0.36, s * 0.4, s * 0.46, s * 0.4);   // hunched neck
      ctx.quadraticCurveTo(s * 0.5, s * 0.34, s * 0.62, s * 0.36);  // head
      ctx.quadraticCurveTo(s * 0.72, s * 0.4, s * 0.68, s * 0.5);
      ctx.quadraticCurveTo(s * 0.82, s * 0.56, s * 0.78, s * 0.84);
      ctx.closePath();
    }, 2.6);
    // curved horns
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.52, s * 0.36);
      ctx.quadraticCurveTo(s * 0.46, s * 0.24, s * 0.54, s * 0.18);
      ctx.quadraticCurveTo(s * 0.56, s * 0.28, s * 0.6, s * 0.34);
      ctx.closePath();
      ctx.moveTo(s * 0.64, s * 0.36);
      ctx.quadraticCurveTo(s * 0.72, s * 0.26, s * 0.7, s * 0.18);
      ctx.quadraticCurveTo(s * 0.66, s * 0.28, s * 0.62, s * 0.34);
      ctx.closePath();
    }, 1.8);
    // eye + fanged maw
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.62, s * 0.42, s * 0.02, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(s * 0.58, s * 0.47);
    ctx.lineTo(s * 0.7, s * 0.47);
    ctx.stroke();
    ctx.fillStyle = c.fill;
    for (const fx of [0.6, 0.66]) { poly(ctx, [[s * fx, s * 0.47], [s * (fx + 0.015), s * 0.51], [s * (fx + 0.03), s * 0.47]]); ctx.fill(); }
  },
  // ---- Fortress ----
  gnoll: (ctx, s, c) => {
    // a hyena-headed brute with a barbed polearm
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.34, s * 0.84);
      ctx.quadraticCurveTo(s * 0.3, s * 0.52, s * 0.44, s * 0.46);
      // muzzle thrust forward
      ctx.lineTo(s * 0.44, s * 0.4);
      ctx.quadraticCurveTo(s * 0.5, s * 0.3, s * 0.6, s * 0.32);
      ctx.lineTo(s * 0.7, s * 0.3);       // snout
      ctx.lineTo(s * 0.6, s * 0.4);
      ctx.quadraticCurveTo(s * 0.6, s * 0.5, s * 0.56, s * 0.5);
      ctx.quadraticCurveTo(s * 0.66, s * 0.56, s * 0.62, s * 0.84);
      ctx.closePath();
    }, 2.2);
    // ear
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.46, s * 0.4);
      ctx.lineTo(s * 0.44, s * 0.28);
      ctx.lineTo(s * 0.52, s * 0.36);
      ctx.closePath();
    }, 1.6);
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(s * 0.54, s * 0.38, s * 0.018, 0, Math.PI * 2); ctx.fill();
    // polearm
    lineArt(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath(); ctx.moveTo(s * 0.72, s * 0.86); ctx.lineTo(s * 0.78, s * 0.16);
    }, 2);
    ctx.fillStyle = c.accent;
    poly(ctx, [[s * 0.78, s * 0.12], [s * 0.72, s * 0.24], [s * 0.84, s * 0.24]]);
    ctx.fill();
  },
  lizardman: (ctx, s, c) => {
    // a scaled reptilian archer, snout raised, dart nocked
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.32, s * 0.84);
      ctx.quadraticCurveTo(s * 0.28, s * 0.5, s * 0.44, s * 0.46);
      ctx.lineTo(s * 0.44, s * 0.4);
      ctx.quadraticCurveTo(s * 0.5, s * 0.32, s * 0.58, s * 0.34);
      ctx.lineTo(s * 0.72, s * 0.3);      // snout
      ctx.lineTo(s * 0.58, s * 0.42);
      ctx.quadraticCurveTo(s * 0.66, s * 0.5, s * 0.62, s * 0.84);
      ctx.closePath();
    }, 2.2);
    // dorsal spines
    ctx.fillStyle = c.ink;
    for (const [px, py] of [[0.34, 0.5], [0.36, 0.62], [0.4, 0.74]]) {
      poly(ctx, [[s * px, s * py], [s * (px - 0.05), s * (py + 0.02)], [s * px, s * (py + 0.06)]]);
      ctx.fill();
    }
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(s * 0.56, s * 0.36, s * 0.018, 0, Math.PI * 2); ctx.fill();
    // raised dart
    lineArt(ctx, { ...c, fill: c.accent }, () => {
      ctx.beginPath(); ctx.moveTo(s * 0.6, s * 0.5); ctx.lineTo(s * 0.82, s * 0.24);
    }, 1.8);
  },
  serpentFly: (ctx, s, c) => {
    // a winged serpent — S-coiled body between two wings
    wing(ctx, s * 0.44, s * 0.42, s * 0.28, -1, c);
    wing(ctx, s * 0.56, s * 0.42, s * 0.28, 1, c);
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.24);
      ctx.quadraticCurveTo(s * 0.66, s * 0.42, s * 0.5, s * 0.56);
      ctx.quadraticCurveTo(s * 0.34, s * 0.7, s * 0.5, s * 0.84);
    }, 3);
    // head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.24, s * 0.06, s * 0.045, 0, 0, Math.PI * 2);
    }, 1.8);
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(s * 0.53, s * 0.23, s * 0.015, 0, Math.PI * 2); ctx.fill();
    // forked tongue
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(s * 0.56, s * 0.24); ctx.lineTo(s * 0.62, s * 0.22); ctx.stroke();
  },
  basilisk: (ctx, s, c) => {
    // a low spiked reptile with a petrifying glare
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.16, s * 0.62);         // tail
      ctx.quadraticCurveTo(s * 0.3, s * 0.5, s * 0.44, s * 0.54);
      ctx.quadraticCurveTo(s * 0.62, s * 0.5, s * 0.76, s * 0.46); // back to head
      ctx.lineTo(s * 0.88, s * 0.5);          // snout
      ctx.lineTo(s * 0.78, s * 0.58);
      ctx.quadraticCurveTo(s * 0.6, s * 0.66, s * 0.42, s * 0.66);
      ctx.quadraticCurveTo(s * 0.28, s * 0.68, s * 0.16, s * 0.62);
      ctx.closePath();
    }, 2.2);
    // spiked ridge
    ctx.fillStyle = c.ink;
    for (const px of [0.3, 0.42, 0.54, 0.66]) {
      poly(ctx, [[s * px, s * 0.52], [s * (px + 0.03), s * 0.4], [s * (px + 0.06), s * 0.52]]);
      ctx.fill();
    }
    // legs
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const x of [0.34, 0.5, 0.66]) { ctx.moveTo(s * x, s * 0.64); ctx.lineTo(s * x, s * 0.8); }
    ctx.stroke();
    // glaring eye
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(s * 0.78, s * 0.5, s * 0.025, 0, Math.PI * 2); ctx.fill();
  },
  gorgon: (ctx, s, c) => {
    // an armour-plated bull-beast, head lowered
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.2, s * 0.8);
      ctx.quadraticCurveTo(s * 0.22, s * 0.44, s * 0.4, s * 0.42);
      ctx.lineTo(s * 0.5, s * 0.34);          // lowered head
      ctx.quadraticCurveTo(s * 0.6, s * 0.36, s * 0.62, s * 0.46);
      ctx.quadraticCurveTo(s * 0.82, s * 0.5, s * 0.78, s * 0.8);
      ctx.closePath();
    }, 2.4);
    // armour plates
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(s * 0.3, s * 0.5); ctx.lineTo(s * 0.7, s * 0.54);
    ctx.moveTo(s * 0.28, s * 0.64); ctx.lineTo(s * 0.74, s * 0.66);
    ctx.stroke();
    // horns
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2.4;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 0.48, s * 0.36);
      ctx.quadraticCurveTo(s * (0.48 + dir * 0.12), s * 0.3, s * (0.48 + dir * 0.08), s * 0.22);
      ctx.stroke();
    }
    ctx.fillStyle = c.accent;
    ctx.beginPath(); ctx.arc(s * 0.5, s * 0.42, s * 0.02, 0, Math.PI * 2); ctx.fill();
  },
  wyvern: (ctx, s, c) => {
    // a winged marsh-drake with a barbed lashing tail
    wing(ctx, s * 0.5, s * 0.38, s * 0.32, 1, c);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.32, s * 0.52);
      ctx.quadraticCurveTo(s * 0.4, s * 0.36, s * 0.5, s * 0.36); // neck
      ctx.lineTo(s * 0.62, s * 0.28);       // head up
      ctx.lineTo(s * 0.56, s * 0.4);
      ctx.quadraticCurveTo(s * 0.5, s * 0.5, s * 0.42, s * 0.58);
      ctx.quadraticCurveTo(s * 0.34, s * 0.62, s * 0.32, s * 0.52);
      ctx.closePath();
    }, 2.2);
    // legs
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s * 0.4, s * 0.56); ctx.lineTo(s * 0.4, s * 0.72);
    ctx.moveTo(s * 0.36, s * 0.55); ctx.lineTo(s * 0.34, s * 0.7);
    ctx.stroke();
    // barbed tail curling down-right
    lineArt(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.4, s * 0.56);
      ctx.quadraticCurveTo(s * 0.7, s * 0.62, s * 0.8, s * 0.84);
    }, 2.4);
    ctx.fillStyle = c.accent;
    poly(ctx, [[s * 0.8, s * 0.84], [s * 0.72, s * 0.8], [s * 0.82, s * 0.74]]);
    ctx.fill();
    ctx.beginPath(); ctx.arc(s * 0.58, s * 0.31, s * 0.016, 0, Math.PI * 2); ctx.fill();
  },
  hydra: (ctx, s, c) => {
    // a three-headed swamp horror on a squat body
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.68, s * 0.22, s * 0.14, 0, 0, Math.PI * 2);
    }, 2.4);
    // three sinuous necks + heads
    for (const [hx, hy] of [[0.3, 0.34], [0.5, 0.28], [0.7, 0.34]]) {
      lineArt(ctx, c, () => {
        ctx.beginPath();
        ctx.moveTo(s * 0.5, s * 0.62);
        ctx.quadraticCurveTo(s * ((0.5 + hx) / 2), s * 0.44, s * hx, s * hy);
      }, 3);
      stroked(ctx, c, () => {
        ctx.beginPath();
        ctx.ellipse(s * hx, s * hy, s * 0.055, s * 0.04, 0, 0, Math.PI * 2);
      }, 1.6);
      ctx.fillStyle = c.accent;
      ctx.beginPath(); ctx.arc(s * hx, s * (hy - 0.005), s * 0.014, 0, Math.PI * 2); ctx.fill();
      // little fang
      ctx.fillStyle = c.fill;
      poly(ctx, [[s * (hx - 0.02), s * (hy + 0.03)], [s * hx, s * (hy + 0.06)], [s * (hx + 0.02), s * (hy + 0.03)]]);
      ctx.fill();
    }
  },
  // ---- Conflux ----
  pixie: (ctx, s, c) => {
    // a tiny winged sprite trailing sparkles
    // wings
    ctx.fillStyle = 'rgba(220,245,240,0.7)';
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.2;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * (0.5 + dir * 0.14), s * 0.42, s * 0.12, s * 0.07, dir * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // slim body + head
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.4);
      ctx.quadraticCurveTo(s * 0.545, s * 0.56, s * 0.5, s * 0.72);
      ctx.quadraticCurveTo(s * 0.455, s * 0.56, s * 0.5, s * 0.4);
      ctx.closePath();
    }, 1.8);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.34, s * 0.06, 0, Math.PI * 2);
    }, 1.6);
    // sparkles
    ctx.fillStyle = c.accent;
    for (const [sx, sy, r] of [[0.72, 0.28, 0.02], [0.28, 0.3, 0.016], [0.66, 0.62, 0.014]]) {
      star(ctx, s * sx, s * sy, 4, s * r * 2, s * r * 0.7);
      ctx.fill();
    }
  },
  airElemental: (ctx, s, c) => {
    // a swirling vortex of wind
    lineArt(ctx, c, () => {
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const yy = 0.32 + i * 0.16;
        ctx.moveTo(s * 0.28, s * yy);
        ctx.bezierCurveTo(s * 0.5, s * (yy - 0.08), s * 0.5, s * (yy + 0.08), s * 0.72, s * yy);
      }
    }, 2.6);
    // a coiled funnel outline
    stroked(ctx, { ...c, fill: 'rgba(210,230,245,0.35)' }, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.26);
      ctx.quadraticCurveTo(s * 0.5, s * 0.36, s * 0.64, s * 0.26);
      ctx.quadraticCurveTo(s * 0.56, s * 0.6, s * 0.5, s * 0.78);
      ctx.quadraticCurveTo(s * 0.44, s * 0.6, s * 0.36, s * 0.26);
      ctx.closePath();
    }, 1.6);
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) { ctx.beginPath(); ctx.arc(s * (0.5 + dir * 0.05), s * 0.4, s * 0.018, 0, Math.PI * 2); ctx.fill(); }
  },
  waterElemental: (ctx, s, c) => {
    // a rising column of water with a curling crest
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.82);
      ctx.quadraticCurveTo(s * 0.3, s * 0.5, s * 0.44, s * 0.34);
      ctx.quadraticCurveTo(s * 0.5, s * 0.24, s * 0.62, s * 0.24); // crest curls over
      ctx.quadraticCurveTo(s * 0.54, s * 0.3, s * 0.58, s * 0.4);
      ctx.quadraticCurveTo(s * 0.68, s * 0.56, s * 0.64, s * 0.82);
      ctx.closePath();
    }, 2.2);
    // ripples
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.2;
    for (const yy of [0.5, 0.62, 0.74]) {
      ctx.beginPath();
      ctx.moveTo(s * 0.4, s * yy);
      ctx.quadraticCurveTo(s * 0.5, s * (yy - 0.03), s * 0.6, s * yy);
      ctx.stroke();
    }
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) { ctx.beginPath(); ctx.arc(s * (0.5 + dir * 0.05), s * 0.42, s * 0.018, 0, Math.PI * 2); ctx.fill(); }
  },
  earthElemental: (ctx, s, c) => {
    // a lumbering rocky humanoid of boulders
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.28, s * 0.84);
      ctx.lineTo(s * 0.32, s * 0.5);
      ctx.lineTo(s * 0.4, s * 0.46);
      ctx.lineTo(s * 0.42, s * 0.34);
      ctx.lineTo(s * 0.58, s * 0.34);
      ctx.lineTo(s * 0.6, s * 0.46);
      ctx.lineTo(s * 0.68, s * 0.5);
      ctx.lineTo(s * 0.72, s * 0.84);
      ctx.closePath();
    }, 2.4);
    // boulder cracks
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.5); ctx.lineTo(s * 0.44, s * 0.66); ctx.lineTo(s * 0.56, s * 0.72);
    ctx.moveTo(s * 0.4, s * 0.56); ctx.lineTo(s * 0.34, s * 0.7);
    ctx.stroke();
    // glowing eyes in the crag
    ctx.fillStyle = c.accent;
    for (const dir of [-1, 1]) { ctx.beginPath(); ctx.arc(s * (0.5 + dir * 0.05), s * 0.42, s * 0.02, 0, Math.PI * 2); ctx.fill(); }
  },
  psychicElemental: (ctx, s, c) => {
    // a floating mind-form: a hooded ghostly head wreathed in a thought-aura
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.44, s * 0.28, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.36, s * 0.5);
      ctx.quadraticCurveTo(s * 0.34, s * 0.28, s * 0.5, s * 0.26);
      ctx.quadraticCurveTo(s * 0.66, s * 0.28, s * 0.64, s * 0.5);
      // wispy trailing base
      ctx.quadraticCurveTo(s * 0.6, s * 0.72, s * 0.56, s * 0.82);
      ctx.quadraticCurveTo(s * 0.52, s * 0.72, s * 0.5, s * 0.82);
      ctx.quadraticCurveTo(s * 0.48, s * 0.72, s * 0.44, s * 0.82);
      ctx.quadraticCurveTo(s * 0.4, s * 0.72, s * 0.36, s * 0.5);
      ctx.closePath();
    }, 2.2);
    // a single luminous mind-eye
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.42, s * 0.09, s * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.42, s * 0.03, 0, Math.PI * 2);
    ctx.fill();
  },
  phoenix: (ctx, s, c) => {
    // a blazing bird with spread wings and a flame crest
    wing(ctx, s * 0.42, s * 0.46, s * 0.32, -1, c);
    wing(ctx, s * 0.58, s * 0.46, s * 0.32, 1, c);
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.3);
      ctx.quadraticCurveTo(s * 0.58, s * 0.5, s * 0.5, s * 0.74); // body
      ctx.quadraticCurveTo(s * 0.42, s * 0.5, s * 0.5, s * 0.3);
      ctx.closePath();
    }, 2.2);
    // head + beak
    stroked(ctx, c, () => {
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.28, s * 0.05, 0, Math.PI * 2);
    }, 1.6);
    ctx.fillStyle = c.accent;
    poly(ctx, [[s * 0.5, s * 0.24], [s * 0.44, s * 0.22], [s * 0.5, s * 0.2]]);
    ctx.fill();
    // flame crest
    ctx.fillStyle = c.accent;
    for (const dx of [-0.03, 0.03]) {
      poly(ctx, [[s * (0.5 + dx), s * 0.24], [s * (0.5 + dx * 2), s * 0.12], [s * (0.5 + dx * 3.4), s * 0.22]]);
      ctx.fill();
    }
    // fanned tail flames
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    for (const dx of [-0.06, 0, 0.06]) {
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.72);
      ctx.lineTo(s * (0.5 + dx), s * 0.9);
      ctx.stroke();
    }
  },
};
