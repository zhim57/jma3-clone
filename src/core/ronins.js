/**
 * ronins.js — INERT STUB (jma3-clone). See core/invasions.js for why the cluster
 * is stubbed rather than deleted.
 *
 * Upstream, "ronins" are masterless captains wandering the map who can intervene
 * in battles and be hired from a town. The feature is flag-gated (`features.ronins`,
 * default false) and every entry point already returns []/null when it is off —
 * which is exactly what this stub returns, so the clone behaves identically to an
 * upstream game with the flag left alone.
 *
 * Three pure predicates keep their REAL implementations, because callers branch on
 * them and a faked answer would be wrong rather than merely inert: with no ronins
 * on the map `isRonin` is simply always false, and `contextDefenderHero` is a plain
 * battle-context accessor that has nothing to do with the feature at all —
 * core/actions.js and ai/AIPlayer.js both rely on it resolving a normal defender.
 */

/** True for a ronin stack. No object in this clone ever carries `.ronin`. */
export function isRonin(obj) {
  return !!obj && obj.type === 'monster' && !!obj.ronin;
}

/** The captain riding on a ronin stack, or null. */
export function roninHero(obj) {
  return isRonin(obj) ? obj.ronin.hero : null;
}

/**
 * Resolve the defending hero for a battle context. NOT a ronin feature — this is
 * the ordinary accessor the combat pipeline uses, so it keeps its real body.
 */
export function contextDefenderHero(state, ctx) {
  if (ctx?.defenderHeroId) return state.heroes[ctx.defenderHeroId] || null;
  return ctx?.defenderRonin || null;
}

export function roninStacks() { return []; }
export function roninBrief() { return null; }
export function mintRonin() { return null; }
export function roninTarget() { return 0; }
export function spawnRonins() { return []; }
export function marchRonins() { return []; }
export function interveningRonin() { return null; }
export function roninReinforce() { return null; }
export function settleRoninBattle() { return null; }
export function removeRonin() { return null; }
export function hireableRonins() { return []; }
export function roninHireCost() { return 0; }
export function hireRonin() { return null; }
