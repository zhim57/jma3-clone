/**
 * water.test.js — navigable water: boats, embark / sail / disembark.
 *
 * A foot hero can board a boat that waits on a water tile, sail freely over
 * water, and step back onto clear land (leaving the boat at the shore). On foot
 * you can never enter open water; auto-pathing respects the movement mode
 * (foot ↔ boat), so a land hero never routes over the sea — a boat is boarded
 * only as a deliberate destination (the AI's included; see ai-connectors.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, tileAt, heroAt, playerHeroes, nextObjectId } from '../src/core/GameState.js';
import { stepHero } from '../src/core/actions.js';
import { findPath, isWalkable, isEnterable } from '../src/map/Pathfinding.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { Rng } from '../src/core/rng.js';

/** Carve a clean horizontal strip and return its left-edge coords at row y. */
function waterStrip(state) {
  const { w, h } = state.map;
  // find a row with a clean 6-wide run away from objects/heroes
  for (let y = 4; y < h - 4; y++) {
    for (let x0 = 4; x0 < w - 8; x0++) {
      let ok = true;
      for (let dx = -1; dx <= 6 && ok; dx++) {
        for (let dy = -1; dy <= 1 && ok; dy++) {
          const t = tileAt(state, x0 + dx, y + dy);
          if (!t || t.objectId || heroAt(state, x0 + dx, y + dy)) ok = false;
        }
      }
      if (ok) return { x0, y };
    }
  }
  throw new Error('no clean strip');
}

/** Paint tiles: land | water(boat) | water | land, return the four x's. */
function layout(state) {
  const { x0, y } = waterStrip(state);
  const paint = (x, terrain) => { const t = tileAt(state, x, y); t.terrain = terrain; t.obstacle = null; };
  // clear a little apron of grass so nothing stray interferes
  for (let dx = -1; dx <= 4; dx++) for (let dy = -1; dy <= 1; dy++) {
    const t = tileAt(state, x0 + dx, y + dy); t.terrain = 'grass'; t.obstacle = null; t.objectId = null;
  }
  paint(x0, 'grass'); paint(x0 + 1, 'water'); paint(x0 + 2, 'water'); paint(x0 + 3, 'grass');
  // boat on the first water tile
  const id = nextObjectId(state);
  state.map.objects[id] = { id, x: x0 + 1, y, type: 'boat' };
  tileAt(state, x0 + 1, y).objectId = id;
  return { land0: { x: x0, y }, boatWater: { x: x0 + 1, y }, openWater: { x: x0 + 2, y }, land1: { x: x0 + 3, y }, boatId: id };
}

function readyHero(state) {
  const hero = playerHeroes(state, 0)[0];
  hero.army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 5000;
  return hero;
}

test('embark: a foot hero boards a boat waiting on water', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = layout(s);
  const hero = readyHero(s);
  hero.x = L.land0.x; hero.y = L.land0.y;
  const ev = stepHero(s, hero, { x: L.boatWater.x, y: L.boatWater.y, cost: 100 });
  assert.equal(ev.type, 'embark');
  assert.equal(hero.onBoat, true, 'hero is now aboard');
  assert.equal(hero.x, L.boatWater.x, 'hero moved onto the water tile');
  assert.equal(s.map.objects[L.boatId], undefined, 'the boat is now carried, not on the map');
});

test('sail then disembark: cross water and step onto clear land, leaving the boat', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = layout(s);
  const hero = readyHero(s);
  hero.x = L.land0.x; hero.y = L.land0.y;
  stepHero(s, hero, { x: L.boatWater.x, y: L.boatWater.y, cost: 100 }); // embark

  const sail = stepHero(s, hero, { x: L.openWater.x, y: L.openWater.y, cost: 100 });
  assert.equal(sail.type, 'moved');
  assert.equal(hero.onBoat, true, 'still aboard on open water');

  const land = stepHero(s, hero, { x: L.land1.x, y: L.land1.y, cost: 100 });
  assert.equal(land.type, 'disembark');
  assert.equal(hero.onBoat, false, 'back on foot');
  assert.equal(hero.x, L.land1.x, 'hero stands on land');
  const boatTile = tileAt(s, L.openWater.x, L.openWater.y);
  assert.ok(boatTile.objectId && s.map.objects[boatTile.objectId]?.type === 'boat',
    'a boat is left on the water tile the hero vacated');
});

test('re-embark: an island hero can board a DIAGONALLY-placed boat (no corner-cut strand)', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  s.fog[0].fill(1); // the human can see the island (onWorldClick paths with forPlayer 0)
  const { w, h } = s.map;
  // Find a clean 3×3 area to carve a one-tile island into.
  let cx = -1, cy = -1;
  outer:
  for (let y = 4; y < h - 4; y++) {
    for (let x = 4; x < w - 4; x++) {
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) {
        const t = tileAt(s, x + dx, y + dy);
        if (!t || t.objectId || heroAt(s, x + dx, y + dy)) ok = false;
      }
      if (ok) { cx = x; cy = y; break outer; }
    }
  }
  assert.ok(cx >= 0, 'found a clean 3×3');
  // Centre land, all 8 neighbours water — a hero here is surrounded by sea.
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const t = tileAt(s, cx + dx, cy + dy);
    t.obstacle = null; t.objectId = null;
    t.terrain = (dx === 0 && dy === 0) ? 'grass' : 'water';
  }
  // The boat sits on a DIAGONAL water neighbour (NW) — the case a diagonal
  // disembark produces and that foot corner-cutting used to make unreachable.
  const bx = cx - 1, by = cy - 1;
  const id = nextObjectId(s);
  s.map.objects[id] = { id, x: bx, y: by, type: 'boat' };
  tileAt(s, bx, by).objectId = id;

  const hero = readyHero(s);
  hero.onBoat = false; hero.x = cx; hero.y = cy;

  const path = findPath(s, hero, bx, by, 0);
  assert.ok(path && path.path.length === 1, 'a one-step path onto the diagonal boat exists (not stranded)');
  const ev = stepHero(s, hero, path.path[0]);
  assert.equal(ev.type, 'embark', 'stepping onto it re-embarks');
  assert.equal(hero.onBoat, true);
  assert.equal(hero.x, bx); assert.equal(hero.y, by);
});

test('disembark collects a pickup on the landing tile (island reward)', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = layout(s);
  // Put a resource on the far shore — the "island reward" the hero lands on.
  const rid = nextObjectId(s);
  s.map.objects[rid] = { id: rid, x: L.land1.x, y: L.land1.y, type: 'resource', resource: 'gems', amount: 10, seaLocked: true };
  tileAt(s, L.land1.x, L.land1.y).objectId = rid;

  const hero = readyHero(s);
  const gems0 = s.players[0].resources.gems;
  hero.x = L.land0.x; hero.y = L.land0.y;
  stepHero(s, hero, { x: L.boatWater.x, y: L.boatWater.y, cost: 100 }); // embark
  stepHero(s, hero, { x: L.openWater.x, y: L.openWater.y, cost: 100 });  // sail

  const ev = stepHero(s, hero, { x: L.land1.x, y: L.land1.y, cost: 100 }); // land on the reward
  assert.equal(ev.type, 'disembark');
  assert.equal(ev.landed.type, 'pickup', 'the island reward is collected on landing');
  assert.equal(hero.onBoat, false, 'ashore');
  assert.equal(s.map.objects[rid], undefined, 'the reward is consumed');
  assert.equal(s.players[0].resources.gems, gems0 + 10, 'gems credited');
});

test('on foot you cannot swim: stepping onto open water is blocked', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = layout(s);
  const hero = readyHero(s);
  hero.x = L.land1.x; hero.y = L.land1.y; // beside the open-water tile
  const ev = stepHero(s, hero, { x: L.openWater.x, y: L.openWater.y, cost: 100 });
  assert.equal(ev.type, 'blocked');
  assert.equal(hero.onBoat, false);
  assert.equal(hero.x, L.land1.x, 'hero did not move');
});

test('pathfinding respects the movement mode (foot never routes over sea)', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const L = layout(s);
  const hero = readyHero(s);
  hero.x = L.land0.x; hero.y = L.land0.y;

  // Foot: open water is not walkable-through nor enterable (no boat there).
  assert.equal(isWalkable(s, L.openWater.x, L.openWater.y, -1, null, false), false);
  assert.equal(isEnterable(s, L.openWater.x, L.openWater.y, -1, false), false);
  // Foot: the boat tile IS enterable (you may end a move there, to embark).
  assert.equal(isEnterable(s, L.boatWater.x, L.boatWater.y, -1, false), true);

  // Aboard: water is walkable, land is a valid destination (disembark).
  assert.equal(isWalkable(s, L.openWater.x, L.openWater.y, -1, null, true), true);
  assert.equal(isEnterable(s, L.land1.x, L.land1.y, -1, true), true);
  // Aboard: land is NOT walkable *through* (you can only end a move on it).
  assert.equal(isWalkable(s, L.land1.x, L.land1.y, -1, null, true), false);

  // A boat hero can path across the sea to the far shore; a foot hero cannot
  // stand on open water at all.
  hero.x = L.boatWater.x; hero.y = L.boatWater.y; hero.onBoat = true;
  assert.ok(findPath(s, hero, L.land1.x, L.land1.y, -1), 'boat hero reaches the far shore');
  hero.onBoat = false; hero.x = L.land0.x; hero.y = L.land0.y;
  assert.equal(findPath(s, hero, L.openWater.x, L.openWater.y, -1), null, 'foot hero cannot reach open water');
});

test('generator: sea-locked island rewards are true islets — boat-only', () => {
  const towns = [];
  const map = generateMap({
    w: 88, h: 72, rng: new Rng(7), players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  const { w, h } = map;
  const isWater = (x, y) => { const t = map.tiles[y * w + x]; return !!t && t.terrain === 'water'; };
  const islands = Object.values(map.objects).filter((o) => o.seaLocked);
  const boats = Object.values(map.objects).filter((o) => o.type === 'boat');
  assert.ok(islands.length >= 1, 'at least one sea-locked island reward');

  // Every island sits on land ringed entirely by water (no foot approach)…
  for (const isl of islands) {
    assert.notEqual(map.tiles[isl.y * w + isl.x].terrain, 'water', 'reward is on the raised islet, not water');
    for (let ny = isl.y - 1; ny <= isl.y + 1; ny++) {
      for (let nx = isl.x - 1; nx <= isl.x + 1; nx++) {
        if (nx === isl.x && ny === isl.y) continue;
        assert.ok(isWater(nx, ny), `islet ${isl.id} is ringed by water at ${nx},${ny}`);
      }
    }
  }

  // …and every island is reachable by a boat (a water neighbour lies in the
  // water a boat can sail — the flood from all boats over water tiles).
  const seen = new Uint8Array(w * h);
  const q = [];
  for (const b of boats) { const i = b.y * w + b.x; if (!seen[i]) { seen[i] = 1; q.push(i); } }
  while (q.length) {
    const i = q.pop(), x = i % w, y = (i / w) | 0;
    for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ex, ny = y + ey;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!seen[j] && isWater(nx, ny)) { seen[j] = 1; q.push(j); }
    }
  }
  for (const isl of islands) {
    let dockable = false;
    for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (seen[(isl.y + ey) * w + (isl.x + ex)]) dockable = true;
    }
    assert.ok(dockable, `islet ${isl.id} has a boat-reachable dock`);
  }
});
