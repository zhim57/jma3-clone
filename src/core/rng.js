/**
 * rng.js — Seedable random number generator (mulberry32).
 *
 * Map generation uses a seeded stream so a scenario seed always produces the
 * same world. Gameplay randomness (damage rolls, morale/luck) uses a separate
 * stream seeded at new-game time and persisted in the save.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.a = this.seed; // full mulberry32 state (inlined so it can be serialized directly)
    this.calls = 0;
  }

  /** float in [0,1) */
  random() {
    this.calls++;
    let a = this.a | 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    this.a = a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** integer in [min, max] inclusive */
  int(min, max) {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  /** true with probability p */
  chance(p) {
    return this.random() < p;
  }

  /**
   * Standard normal, via Box-Muller. Two draws, so it costs the stream two
   * calls — worth knowing when reasoning about determinism.
   */
  gauss() {
    let u = 0;
    while (u <= Number.EPSILON) u = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.random());
  }

  pick(arr) {
    return arr[Math.floor(this.random() * arr.length)];
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * Serialize the FULL generator state, so restore is O(1) instead of replaying
   * every historical draw. `seed`/`calls` are kept for diagnostics and to let
   * older saves (which stored only {seed, calls}) still load.
   */
  toJSON() {
    return { seed: this.seed, calls: this.calls, state: this.a >>> 0 };
  }

  static fromJSON(j) {
    const r = new Rng(j.seed);
    if (typeof j.state === 'number') {
      r.a = j.state >>> 0;   // O(1): resume from the exact stored state
      r.calls = j.calls || 0;
    } else {
      // Legacy save {seed, calls}: reconstruct the state by replaying the draws.
      for (let i = 0; i < (j.calls || 0); i++) r.random();
      r.calls = j.calls || 0;
    }
    return r;
  }
}
