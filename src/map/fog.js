/**
 * fog.js — Fog of war.
 *
 * One Uint8Array per player PER MAP LEVEL: 0 = unexplored (black), 1 =
 * explored. Level 0 (surface) lives in state.fog[playerIndex], level 1
 * (underground) in state.fogUnder[playerIndex]. Explored tiles stay visible
 * forever (HoMM3-style "shroud" — there is no re-hiding). Reveal happens
 * around heroes as they move (on their own level) and around owned
 * towns/mines when acquired.
 */

export function createFog(w, h) {
  return new Uint8Array(w * h);
}

/**
 * The fog layer for one player on one level (0 = surface, 1 = underground).
 * May be undefined/empty for the underground of a migrated single-level save.
 */
export function fogFor(state, playerIndex, level = 0) {
  return level ? state.fogUnder?.[playerIndex] : state.fog[playerIndex];
}

/**
 * Reveal a disc of `radius` tiles centred on (cx, cy) for one player.
 *
 * Returns how many tiles this call actually turned from dark to light — 0 means
 * the whole disc was already charted. Callers that exist only to reveal (the
 * Redwood Observatory) use that to tell "you learned something" from "you
 * climbed a tower to look at a map you already had", and skip the dialog for
 * the latter rather than halting a march for nothing.
 */
export function revealAround(state, playerIndex, cx, cy, radius, level = 0) {
  const fog = fogFor(state, playerIndex, level);
  if (!fog || !fog.length) return 0; // absent level (migrated save) — nothing to reveal
  const { w, h } = state.map;
  const r2 = (radius + 0.5) * (radius + 0.5);
  const x0 = Math.max(0, cx - radius), x1 = Math.min(w - 1, cx + radius);
  const y0 = Math.max(0, cy - radius), y1 = Math.min(h - 1, cy + radius);
  let lit = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * w + x;
      if (fog[i] !== 1) { fog[i] = 1; lit++; }
    }
  }
  return lit;
}

export function isExplored(state, playerIndex, x, y, level = 0) {
  if (x < 0 || y < 0 || x >= state.map.w || y >= state.map.h) return false;
  const fog = fogFor(state, playerIndex, level);
  return !!fog && fog[y * state.map.w + x] === 1;
}
