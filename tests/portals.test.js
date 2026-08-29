/**
 * portals.test.js — two-way teleport portals.
 *
 * The generator drops linked portal pairs (both ends in one realm, never
 * bridging the ridge); a hero who steps onto a portal emerges from its partner;
 * auto-pathing routes *around* portals (so the AI never teleports by accident)
 * but may still target one as a destination.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, tileAt, heroAt, playerHeroes, nextObjectId } from '../src/core/GameState.js';
import { stepHero, applyCombatResult } from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { isWalkable, isEnterable } from '../src/map/Pathfinding.js';
import { Rng } from '../src/core/rng.js';

function genMap(w, h, seed) {
  const towns = [];
  const map = generateMap({
    w, h, rng: new Rng(seed), players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  return { map, towns };
}

/** Drop a portal object into a live state at (x,y); returns the object. */
function putPortal(state, x, y, channel, color = 0) {
  const id = nextObjectId(state);
  const obj = { id, x, y, type: 'portal', channel, color };
  state.map.objects[id] = obj;
  tileAt(state, x, y).objectId = id;
  return obj;
}

/**
 * A tile at the centre of a clean 5×5 block — no obstacle, object, water, or
 * hero anywhere in the block. That guarantees no wandering-guard zone of control
 * touches the tile (or its approach), so stepping onto a portal here can't be
 * hijacked into combat. `avoid` skips tiles/blocks near already-chosen spots.
 */
function openTile(state, avoid = []) {
  const { w, h } = state.map;
  const oob = (x, y) => x < 0 || y < 0 || x >= w || y >= h;
  const skip = (x, y) => avoid.some((a) => Math.abs(a.x - x) <= 3 && Math.abs(a.y - y) <= 3);
  const clean = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (oob(x, y)) return false;
        const t = tileAt(state, x, y);
        if (!t || t.obstacle || t.objectId || t.terrain === 'water') return false;
        if (heroAt(state, x, y)) return false;
      }
    }
    return true;
  };
  // Prefer a naturally-clean block (identical behaviour on roomy maps).
  for (let y = 3; y < h - 3; y++)
    for (let x = 3; x < w - 3; x++)
      if (!skip(x, y) && clean(x, y)) return { x, y };
  // A dense map may offer no natural 5×5 gap (rich object scatter). Rather than
  // let these stepHero-mechanics tests hostage on incidental generator free
  // space, CLEAR a block — but never over a town or a hero.
  const townOrHero = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, y = cy + dy;
      if (oob(x, y)) return true;
      const t = tileAt(state, x, y);
      const o = t?.objectId ? state.map.objects[t.objectId] : null;
      if ((o && o.type === 'town') || heroAt(state, x, y)) return true;
    }
    return false;
  };
  for (let y = 3; y < h - 3; y++)
    for (let x = 3; x < w - 3; x++) {
      if (skip(x, y) || townOrHero(x, y)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const t = tileAt(state, x + dx, y + dy);
        t.obstacle = null; t.terrain = 'grass';
        if (t.objectId) { delete state.map.objects[t.objectId]; t.objectId = null; }
      }
      return { x, y };
    }
  throw new Error('no clean tile');
}

test('generator: portals come in linked pairs, both ends in the same realm', () => {
  for (const [w, h] of [[56, 46], [88, 72]]) {
    const { map } = genMap(w, h, 3);
    const portals = Object.values(map.objects).filter((o) => o.type === 'portal');
    assert.ok(portals.length >= 2, `${w}x${h}: at least one pair placed`);
    assert.equal(portals.length % 2, 0, 'portals come in pairs');
    const byChannel = {};
    for (const p of portals) (byChannel[p.channel] ??= []).push(p);
    for (const [ch, pair] of Object.entries(byChannel)) {
      assert.equal(pair.length, 2, `channel ${ch} is exactly a pair`);
      assert.equal(pair[0].color, pair[1].color, 'a pair shares its colour');
      const d = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
      assert.ok(d >= 6, `pair ${ch} is a real shortcut (${d.toFixed(1)} tiles apart)`);
    }
  }
});

test('pathfinding: a portal blocks through-traffic but is enterable as a destination', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const p = openTile(s);
  putPortal(s, p.x, p.y, 1);
  assert.equal(isWalkable(s, p.x, p.y, -1), false, 'auto-path never routes THROUGH a portal');
  assert.equal(isEnterable(s, p.x, p.y, -1), true, 'but a hero may end a move on one');
});

test('stepHero: stepping onto a portal emerges from its partner', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 2000;

  const a = openTile(s);
  const b = openTile(s, [a, { x: a.x, y: a.y + 1 }]);
  putPortal(s, a.x, a.y, 7);
  putPortal(s, b.x, b.y, 7);
  // Stand next to portal A and step onto it.
  hero.x = a.x; hero.y = a.y + 1;
  const ev = stepHero(s, hero, { x: a.x, y: a.y, cost: 100 });
  assert.equal(ev.type, 'portal', 'a portal event fired');
  assert.deepEqual(ev.to, { x: b.x, y: b.y }, 'emerged at the partner');
  assert.equal(hero.x, b.x, 'hero x moved to the exit');
  assert.equal(hero.y, b.y, 'hero y moved to the exit');
});

test('stepHero: a lone (unpaired) portal is inert — a plain move', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 2000;
  const a = openTile(s);
  putPortal(s, a.x, a.y, 42); // no partner
  hero.x = a.x; hero.y = a.y + 1;
  const ev = stepHero(s, hero, { x: a.x, y: a.y, cost: 100 });
  assert.equal(ev.type, 'moved', 'no partner → no teleport');
  assert.equal(hero.x, a.x, 'hero simply stands on the portal');
  assert.equal(hero.y, a.y);
});

test('stepHero: a blocked exit (a hero on the far portal) cancels the teleport', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const mover = playerHeroes(s, 0)[0];
  const other = playerHeroes(s, 1)[0];
  mover.army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  mover.mp = 2000;
  const a = openTile(s);
  const b = openTile(s, [a, { x: a.x, y: a.y + 1 }]);
  putPortal(s, a.x, a.y, 9);
  putPortal(s, b.x, b.y, 9);
  other.x = b.x; other.y = b.y; // someone is standing on the exit
  mover.x = a.x; mover.y = a.y + 1;
  const ev = stepHero(s, mover, { x: a.x, y: a.y, cost: 100 });
  assert.equal(ev.type, 'blockedExit', 'exit occupied → no teleport');
  assert.equal(mover.x, a.x, 'mover settles onto the entry portal instead');
  assert.equal(mover.y, a.y);
});

// ---------------------------------------------------------------------------
// Winning a battle while STANDING on a teleporter (audit C15).
//
// applyCombatResult re-runs the interaction of the tile under the victor —
// that re-run exists for the zone-of-control case, where enterTile ran first
// and the tile's own prize (or teleport) was genuinely deferred by the fight.
// But a DIRECT attack (tryEngage) never moves the attacker, so the "tile under
// the victor" is then whatever the hero was already standing on — typically
// the portal/gate exit it arrived on earlier — and the re-run yanked the hero
// back through a teleporter it never asked to use, contradicting the arrival
// rule documented in usePortal/useSubGate. The distinction is ctx.tileEntered,
// stamped only by the ZoC branch of stepHero; both directions are pinned here.
// ---------------------------------------------------------------------------

/** A won-battle result for `hero` (shape per CombatEngine.battleResult). */
const wonBy = (hero) => ({
  attackerWon: true,
  attackerArmy: hero.army.filter(Boolean).map((st) => ({ ...st })),
  defenderArmy: [],
  xp: 0,
});

/** Drop a lone weak monster at (x,y) — synthetic, like putPortal. */
function putMonster(state, x, y) {
  const id = nextObjectId(state);
  const obj = { id, x, y, type: 'monster', creature: 'peasant', count: 1 };
  state.map.objects[id] = obj;
  tileAt(state, x, y).objectId = id;
  return obj;
}

test('a victory fought FROM a portal exit does not re-fire the portal', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46, pveScaling: false });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 5, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 2000;
  const a = openTile(s);
  const b = openTile(s, [a, { x: a.x, y: a.y + 1 }]);
  putPortal(s, a.x, a.y, 11);
  putPortal(s, b.x, b.y, 11);
  // Arrive at B through the portal, then a monster wanders up next door.
  hero.x = a.x; hero.y = a.y + 1;
  assert.equal(stepHero(s, hero, { x: a.x, y: a.y, cost: 100 }).type, 'portal');
  assert.deepEqual([hero.x, hero.y], [b.x, b.y]);
  const mon = putMonster(s, b.x, b.y + 1);
  // Direct attack: the hero fights from the exit it is standing on.
  const ev = stepHero(s, hero, { x: mon.x, y: mon.y, cost: 100 });
  assert.equal(ev.type, 'combat');
  assert.ok(!ev.context.tileEntered, 'a direct attack never entered the target tile');
  applyCombatResult(s, ev.context, wonBy(hero));
  assert.deepEqual([hero.x, hero.y], [b.x, b.y],
    'the victor stays on the exit — winning a fight is not a request to teleport');
});

test('the ZoC-deferred teleport still completes after the victory', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46, pveScaling: false });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 5, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 2000;
  const a = openTile(s);
  const b = openTile(s, [a, { x: a.x, y: a.y + 1 }]);
  putPortal(s, a.x, a.y, 12);
  putPortal(s, b.x, b.y, 12);
  // A guard whose zone of control covers portal A: stepping onto A is a fight
  // FIRST, and the portal transit is deferred until the fight is won.
  putMonster(s, a.x + 1, a.y);
  hero.x = a.x - 1; hero.y = a.y;
  const ev = stepHero(s, hero, { x: a.x, y: a.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'waylaid on the portal tile');
  assert.equal(ev.context.tileEntered, true, 'and the step DID enter the tile');
  assert.deepEqual([hero.x, hero.y], [a.x, a.y], 'the hero stands on the portal for the fight');
  const events = applyCombatResult(s, ev.context, wonBy(hero));
  assert.deepEqual([hero.x, hero.y], [b.x, b.y], 'victory completes the deferred teleport');
  assert.ok(events.some((e) => e.type === 'interact' && e.event?.type === 'portal'),
    'reported as the deferred portal interaction');
});
