/**
 * town-shipyard.test.js — the Shipyard TOWN BUILDING: a coastal town builds
 * boats from its own waterfront, paying CONFIG.BOAT_COST per boat exactly
 * like a neutral map yard.
 *
 * Pinned here:
 *   - data: the `shipyard` entry exists in every faction's catalog, carries
 *     the special/coastal flags, and is offered as a standalone build slot;
 *   - townIsCoastal / townDockTile: water within Chebyshev distance 2 makes a
 *     town coastal; the dock is the FIRST free water tile in the fixed scan
 *     order (per ring: orthogonals E/W/S/N first, then the ring row-major),
 *     skipping occupied tiles deterministically;
 *   - buildBlockReason gates the building on the coast BEFORE affordability
 *     ('Requires a coast', never a misleading 'Not enough resources');
 *   - buildBoatAtTown charges BOAT_COST, launches on the dock, and the boat is
 *     boardable in one step; every refusal ('noShipyard' / 'boatAtDock' /
 *     'noDock' / 'cost') is a graceful event that never charges;
 *   - save v2 round-trips a town shipyard + its launched boat byte-idempotently;
 *   - the AI builds the Shipyard BUILDING in its coastal towns (BUILD_ORDER)
 *     and never in landlocked ones; it launches ONE boat from a home port to
 *     collect sea-locked value, boards it via the normal embark path, and
 *     never spams (per-turn cap, cross-day cooldown, free-boat/served checks,
 *     affordability, market cover) — including when the hero already stands
 *     on the town square at the start of its turn;
 *   - landlocked play is untouched: deterministic digests, no shipyard ever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, tileAt, playerHeroes, playerTowns, serialize, deserialize,
  levelObjects, SAVE_VERSION,
} from '../src/core/GameState.js';
import {
  stepHero, endTurn, buildStructure, buildBlockReason,
  buildBoatAtTown, townShipyardBuildCheck, townIsCoastal, townDockTile,
} from '../src/core/actions.js';
import { buildingCatalog, townBuildSlots } from '../src/data/buildings.js';
import { CONFIG } from '../src/config.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1; // player index of the AI opponent in a fresh game

// ---------------------------------------------------------------------------
// Shared helpers (same idioms as shipyards.test.js)
// ---------------------------------------------------------------------------

/** Drive a full AI turn; auto-resolve any interactive battles. */
function runTurn(state, playerIndex = AI) {
  const ai = new AITurnController(state, playerIndex);
  let guard = 200;
  let r;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return ai;
}

/** Remove every surface object except towns. */
function stripObjects(state) {
  const m = state.map;
  for (const [id, obj] of Object.entries(m.objects)) {
    if (obj.type === 'town') continue;
    const t = m.tiles[obj.y * state.map.w + obj.x];
    if (t.objectId === id) t.objectId = null;
    delete m.objects[id];
  }
}

/** Make every non-AI army unbeatable so courage gates all combat goals off. */
function fortifyEnemies(state, aiIndex = AI) {
  for (const town of Object.values(state.towns)) {
    if (town.owner !== aiIndex) {
      town.garrison[0] = { creature: 'archangel', count: 500, hurt: 0 };
    }
  }
  for (const h of Object.values(state.heroes)) {
    if (h.owner !== aiIndex) {
      h.army = [{ creature: 'archangel', count: 500, hurt: 0 }, null, null, null, null, null, null];
    }
  }
}

/** Stop the AI's towns from spending, so its treasury buys exactly one thing: boats. */
function freezeAiEconomy(state, aiIndex = AI) {
  for (const town of Object.values(state.towns)) {
    if (town.owner !== aiIndex) continue;
    town.builtToday = true;
    town.available = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    town.buildings = town.buildings.filter((b) => b !== 'tavern');
  }
}

function giveResources(state, playerIndex, gold, wood) {
  state.players[playerIndex].resources = {
    gold, wood, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 0,
  };
}

/** Force a clean block of open ground around (cx, cy) on the surface. */
function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const t = m.tiles[(cy + dy) * state.map.w + (cx + dx)];
      t.obstacle = null;
      t.terrain = 'grass';
      if (t.objectId) {
        delete m.objects[t.objectId];
        t.objectId = null;
      }
    }
  }
  return { x: cx, y: cy };
}

/** Drop an object onto a live state at (x, y) on the surface; returns it. */
function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * state.map.w + x].objectId = id;
  return obj;
}

/** Turn every water tile within radius 2 of the town into grass (landlock it). */
function landlock(state, town) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const t = tileAt(state, town.x + dx, town.y + dy);
      if (t && t.terrain === 'water') t.terrain = 'grass';
    }
  }
}

/**
 * Landlock the town, then paint a clean 1x3 water column two tiles east of
 * it: the dock is then predictably (town.x+2, town.y) — ring 1 has no water,
 * and (x+2, y) is ring 2's first orthogonal in the scan order.
 */
function coastalizeEast(state, town) {
  landlock(state, town);
  for (let dy = -1; dy <= 1; dy++) {
    const t = tileAt(state, town.x + 2, town.y + dy);
    if (t.objectId) {
      delete state.map.objects[t.objectId];
      t.objectId = null;
    }
    t.terrain = 'water';
    t.obstacle = null;
  }
}

/**
 * Relocate a town (single-tile object) to (x, y): moves the map marker and
 * the town record together. The destination tile must already be clear.
 */
function moveTown(state, town, x, y) {
  const m = state.map;
  const marker = Object.values(m.objects).find((o) => o.type === 'town' && o.townId === town.id);
  const from = m.tiles[marker.y * state.map.w + marker.x];
  if (from.objectId === marker.id) from.objectId = null;
  const to = m.tiles[y * state.map.w + x];
  if (to.objectId) delete m.objects[to.objectId];
  to.objectId = marker.id;
  to.terrain = 'grass';
  to.obstacle = null;
  marker.x = x; marker.y = y;
  town.x = x; town.y = y;
}

/**
 * The AI stage shared by the town-shipyard AI tests, mirroring stageAiLake in
 * shipyards.test.js — but the boat source is the AI's own TOWN (moved onto
 * the lake shore, Shipyard building pre-built) instead of a map yard:
 * a hand-painted lake with a sea-locked islet artifact, a mainland crystal
 * pile as "work to return to", and the AI hero on the shore (or in town).
 * Surface stripped, enemies fortified, AI town spending frozen.
 */
function stageTownLake(state, { islet = true, heroInTown = false } = {}) {
  stripObjects(state);
  fortifyEnemies(state);
  freezeAiEconomy(state);
  const town = playerTowns(state, AI)[0];
  const hero = playerHeroes(state, AI)[0];
  hero.army = [{ creature: 'pikeman', count: 20, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 4000;
  const x0 = 24, y = 20;
  clearBlock(state, x0 - 5, y, 4);
  clearBlock(state, x0 + 1, y, 4);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = 1; dx <= 5; dx++) {
      const t = tileAt(state, x0 + dx, y + dy);
      t.terrain = 'water';
      t.obstacle = null;
    }
  }
  let isletObj = null;
  if (islet) {
    tileAt(state, x0 + 3, y).terrain = 'sand';
    isletObj = putObj(state, x0 + 3, y, { type: 'artifact', artifact: 'titansGladius', seaLocked: true });
  }
  moveTown(state, town, x0, y);
  town.buildings.push('shipyard');
  putObj(state, x0 - 9, y, { type: 'resource', resource: 'crystal', amount: 7 });
  if (heroInTown) {
    hero.x = x0; hero.y = y;
    hero.inTownId = town.id;
    town.visitingHeroId = hero.id;
  } else {
    hero.x = x0 - 1; hero.y = y;
  }
  return { hero, town, isletObj, x0, y };
}

// ---------------------------------------------------------------------------
// Data: catalog + build slots
// ---------------------------------------------------------------------------

test('the Shipyard building is in every faction catalog and offered as a standalone slot', () => {
  for (const faction of ['castle', 'inferno', 'tower']) {
    const cat = buildingCatalog(faction);
    assert.ok(cat.shipyard, `${faction}: shipyard in catalog`);
    assert.equal(cat.shipyard.special, 'shipyard', 'tagged for the town screen hook');
    assert.equal(cat.shipyard.coastal, true, 'carries the coastal flag');
    assert.deepEqual(cat.shipyard.requires, [], 'no building prerequisites');
    const town = { faction, buildings: ['villageHall', 'fort', 'tavern', 'dwelling1'] };
    assert.ok(townBuildSlots(town, faction).includes('shipyard'),
      `${faction}: shipyard appears as its own build slot`);
  }
});

// ---------------------------------------------------------------------------
// Coastal detection, dock selection, build gate
// ---------------------------------------------------------------------------

test('townIsCoastal/townDockTile: landlocked vs coastal, deterministic dock order', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const town = playerTowns(s, 0)[0];

  landlock(s, town);
  assert.equal(townIsCoastal(s, town), false, 'no water within radius 2 = landlocked');
  assert.equal(townDockTile(s, town), null, 'a landlocked town has no dock');

  coastalizeEast(s, town);
  assert.equal(townIsCoastal(s, town), true, 'water at distance 2 makes the town coastal');
  assert.deepEqual(townDockTile(s, town), { x: town.x + 2, y: town.y },
    'ring-2 orthogonal E is the first free water tile in the fixed scan order');

  // Ring 1 water outranks ring 2 in the scan.
  const near = tileAt(s, town.x + 1, town.y);
  near.terrain = 'water';
  assert.deepEqual(townDockTile(s, town), { x: town.x + 1, y: town.y },
    'a closer free water tile wins the dock');

  // An occupied tile is skipped deterministically...
  const squatter = putObj(s, town.x + 1, town.y, { type: 'boat' });
  assert.deepEqual(townDockTile(s, town), { x: town.x + 2, y: town.y },
    'an object on the near water pushes the dock to the next tile in order');
  delete s.map.objects[squatter.id];
  tileAt(s, town.x + 1, town.y).objectId = null;

  // ...and so is a hero afloat on it.
  const hero = playerHeroes(s, 0)[0];
  hero.x = town.x + 1; hero.y = town.y; hero.onBoat = true;
  assert.deepEqual(townDockTile(s, town), { x: town.x + 2, y: town.y },
    'a hero on the near water pushes the dock outward too');
  hero.x = town.x; hero.y = town.y + 1; hero.onBoat = false;
  near.terrain = 'grass';
});

test('buildBlockReason: a landlocked town reads "Requires a coast", never a resource excuse', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const town = playerTowns(s, 0)[0];

  landlock(s, town);
  giveResources(s, 0, 50000, 200); // rich: the coast is the ONLY blocker
  assert.equal(buildBlockReason(s, town, 'shipyard'), 'Requires a coast');
  giveResources(s, 0, 0, 0); // broke AND landlocked: the coast still reads first
  assert.equal(buildBlockReason(s, town, 'shipyard'), 'Requires a coast',
    'the coastal gate outranks the affordability check');

  coastalizeEast(s, town);
  assert.equal(buildBlockReason(s, town, 'shipyard'), 'Not enough resources',
    'coastal but broke = a plain resource block');
  giveResources(s, 0, 5000, 50);
  assert.equal(buildBlockReason(s, town, 'shipyard'), null, 'coastal and funded = buildable');
  assert.equal(buildStructure(s, town, 'shipyard'), true);
  assert.ok(town.buildings.includes('shipyard'));
  assert.equal(s.players[0].resources.gold, 5000 - buildingCatalog(town.faction).shipyard.cost.gold);
  assert.equal(buildBlockReason(s, town, 'shipyard'), 'Already built');
});

// ---------------------------------------------------------------------------
// buildBoatAtTown
// ---------------------------------------------------------------------------

test('buildBoatAtTown: charges BOAT_COST, launches at the dock, boardable in one step', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const town = playerTowns(s, 0)[0];
  coastalizeEast(s, town);
  giveResources(s, 0, 2000 + CONFIG.BOAT_COST.gold, 20 + CONFIG.BOAT_COST.wood);
  assert.equal(buildStructure(s, town, 'shipyard'), true);

  const check = townShipyardBuildCheck(s, town);
  assert.deepEqual(check, { ok: true, dock: { x: town.x + 2, y: town.y } },
    'the pure check agrees with townDockTile');

  const ev = buildBoatAtTown(s, town);
  assert.equal(ev.type, 'boatBuilt');
  assert.equal(ev.townId, town.id);
  assert.equal(ev.x, town.x + 2);
  assert.equal(ev.y, town.y);
  assert.deepEqual(ev.cost, CONFIG.BOAT_COST);
  assert.equal(s.players[0].resources.gold, 0, 'gold charged for building + boat exactly');
  assert.equal(s.players[0].resources.wood, 0, 'wood charged for building + boat exactly');
  const t = tileAt(s, town.x + 2, town.y);
  assert.ok(t.objectId && s.map.objects[t.objectId]?.type === 'boat', 'a boat floats on the dock');

  // Any hero who walks to the coast boards it via the ordinary embark path.
  const hero = playerHeroes(s, 0)[0];
  const shore = tileAt(s, town.x + 1, town.y);
  shore.terrain = 'grass'; shore.obstacle = null;
  hero.x = town.x + 1; hero.y = town.y;
  hero.mp = 1000;
  const board = stepHero(s, hero, { x: town.x + 2, y: town.y, cost: 100 });
  assert.equal(board.type, 'embark');
  assert.equal(hero.onBoat, true);
});

test('buildBoatAtTown refuses gracefully: noShipyard, cost, boatAtDock, noDock — never charging', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const town = playerTowns(s, 0)[0];
  coastalizeEast(s, town);

  // No Shipyard building yet.
  giveResources(s, 0, 9999, 99);
  let ev = buildBoatAtTown(s, town);
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'noShipyard' });
  assert.equal(s.players[0].resources.gold, 9999, 'nothing charged');

  assert.equal(buildStructure(s, town, 'shipyard'), true);

  // Owner cannot afford the boat.
  giveResources(s, 0, 0, 0);
  assert.deepEqual(townShipyardBuildCheck(s, town), { ok: false, reason: 'cost' });
  ev = buildBoatAtTown(s, town);
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'cost' });
  assert.equal(tileAt(s, town.x + 2, town.y).objectId, null, 'no boat appeared');

  // A boat already on the town's near-water makes another build redundant.
  giveResources(s, 0, 5000, 50);
  assert.equal(buildBoatAtTown(s, town).type, 'boatBuilt');
  ev = buildBoatAtTown(s, town);
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'boatAtDock' });
  assert.equal(s.players[0].resources.gold, 5000 - CONFIG.BOAT_COST.gold, 'charged exactly once');

  // No free near-water at all (every water tile occupied by non-boat objects).
  const dockTile = tileAt(s, town.x + 2, town.y);
  delete s.map.objects[dockTile.objectId];
  dockTile.objectId = null;
  for (let dy = -1; dy <= 1; dy++) {
    putObj(s, town.x + 2, town.y + dy, { type: 'monster', creature: 'pikeman', count: 1 });
  }
  ev = buildBoatAtTown(s, town);
  assert.deepEqual(ev, { type: 'boatBuildFailed', reason: 'noDock' });
  assert.equal(s.players[0].resources.gold, 5000 - CONFIG.BOAT_COST.gold, 'no refusal ever charged');
});

// ---------------------------------------------------------------------------
// Save round-trip
// ---------------------------------------------------------------------------

test('save v2 round-trips a town shipyard and its launched boat byte-idempotently', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const town = playerTowns(s, 0)[0];
  coastalizeEast(s, town);
  giveResources(s, 0, 5000, 50);
  assert.equal(buildStructure(s, town, 'shipyard'), true);
  assert.equal(buildBoatAtTown(s, town).type, 'boatBuilt');

  const j1 = serialize(s);
  assert.equal(JSON.parse(j1).version, SAVE_VERSION, 'current save version — shipyards add no shape of their own');
  const s2 = deserialize(j1);
  const town2 = s2.towns[town.id];
  assert.ok(town2.buildings.includes('shipyard'), 'the built shipyard survives');
  const dockTile = s2.map.tiles[town.y * s2.map.w + (town.x + 2)];
  assert.ok(dockTile.objectId && s2.map.objects[dockTile.objectId]?.type === 'boat',
    'the launched boat survives on its dock tile');
  assert.equal(serialize(s2), j1, 'round-trip is byte-idempotent');

  // A restored game keeps playing by the same rules.
  assert.deepEqual(buildBoatAtTown(s2, town2), { type: 'boatBuildFailed', reason: 'boatAtDock' });
});

// ---------------------------------------------------------------------------
// AI (a): building the Shipyard in town
// ---------------------------------------------------------------------------

/** Pre-build everything ahead of 'shipyard' in the AI's BUILD_ORDER. */
function prebuildToShipyard(town) {
  for (const b of ['townHall', 'dwelling2', 'marketplace', 'blacksmith', 'dwelling3',
    'mageGuild1', 'cityHall', 'citadel', 'dwelling4', 'stables']) {
    if (!town.buildings.includes(b)) town.buildings.push(b);
  }
}

test('AI: a coastal town builds the Shipyard building when its turn in the order comes', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  fortifyEnemies(s);
  const town = playerTowns(s, AI)[0];
  prebuildToShipyard(town);
  coastalizeEast(s, town);
  giveResources(s, AI, 20000, 100);

  runTurn(s);

  assert.ok(town.buildings.includes('shipyard'), 'the coastal AI town built its Shipyard');
});

test('AI: a landlocked town never builds the Shipyard, however rich', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  fortifyEnemies(s);
  const town = playerTowns(s, AI)[0];
  prebuildToShipyard(town);
  landlock(s, town);
  giveResources(s, AI, 50000, 500);

  for (let day = 0; day < 3; day++) {
    runTurn(s);
    endTurn(s); // human
    endTurn(s); // AI -> next day
  }

  assert.ok(!town.buildings.includes('shipyard'), 'no coast, no shipyard — ever');
  assert.equal(buildBlockReason(s, town, 'shipyard'), 'Requires a coast');
});

// ---------------------------------------------------------------------------
// AI (b): launching a boat from the home port
// ---------------------------------------------------------------------------

test('AI: routes home, launches ONE boat from the town shipyard, loots the sea-locked islet', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { hero, town, isletObj, x0, y } = stageTownLake(s);
  giveResources(s, AI, 5000, 50);

  const crystal0 = s.players[AI].resources.crystal;
  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 1, 'exactly one boat launched (per-turn cap)');
  assert.equal(ai.buildLog.length, 1, 'the launch is logged once');
  assert.equal(ai.buildLog[0].townId, town.id, 'the log names the home port');
  assert.equal(s.players[AI].resources.gold, 5000 - CONFIG.BOAT_COST.gold, 'gold paid once');
  assert.equal(s.players[AI].resources.wood, 50 - CONFIG.BOAT_COST.wood, 'wood paid once');
  assert.equal(levelObjects(s, 0)[isletObj.id], undefined, 'the islet reward was collected');
  const loot = [...Object.values(hero.equipment).filter(Boolean), ...hero.backpack];
  assert.ok(loot.includes('titansGladius'), 'the hero carries the sea-locked artifact');
  assert.ok(ai.metrics.transits.embark >= 1, 'the launched boat was actually boarded');
  assert.ok(!(hero.x === x0 + 3 && hero.y === y), 'not marooned on the islet');
  assert.equal(hero.onBoat, false, 'ends the turn ashore');
  assert.equal(s.players[AI].resources.crystal, crystal0 + 7, 'resumed mainland work after the trip');
  const boats = Object.values(s.map.objects).filter((o) => o.type === 'boat');
  assert.equal(boats.length, 1, 'one boat exists — launched once, reused, never duplicated');
  assert.equal(hero.aiCooldowns[`townShipyard|${town.id}`], s.day + 1,
    'the home port cools down through tomorrow');
});

test('AI: a hero already AT the home port launches and boards without leaving first', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { hero, isletObj } = stageTownLake(s, { heroInTown: true });
  giveResources(s, AI, 5000, 50);

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 1, 'the in-town hero still launches exactly one boat');
  assert.equal(levelObjects(s, 0)[isletObj.id], undefined, 'and collects the sea-locked reward');
  const loot = [...Object.values(hero.equipment).filter(Boolean), ...hero.backpack];
  assert.ok(loot.includes('titansGladius'), 'the artifact ended up on the hero');
  assert.equal(s.players[AI].resources.gold, 5000 - CONFIG.BOAT_COST.gold, 'paid once');
});

test('AI: no relaunch the next day — cooldown, consumed value and the docked boat all hold', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  stageTownLake(s);
  giveResources(s, AI, 5000, 50);
  runTurn(s);
  endTurn(s); // human
  endTurn(s); // AI -> day 2
  assert.equal(s.day, 2, 'a new day dawned');
  const hero = playerHeroes(s, AI)[0];
  hero.mp = 3000;

  const ai2 = runTurn(s);
  assert.equal(ai2.metrics.boatsBuilt, 0, 'no second boat: value is gone and the port cools down');
  const boats = Object.values(s.map.objects).filter((o) => o.type === 'boat');
  assert.equal(boats.length, 1, 'still exactly one boat on the map');
});

test('AI: does not launch when a reachable free boat already serves the same water', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { isletObj, x0, y } = stageTownLake(s);
  giveResources(s, AI, 5000, 50);
  // A free boat afloat on the same body, boardable from the far shore — outside
  // the town's radius-2 coast (inside it, the boatAtDock refusal would fire
  // instead of the valuation's served-water check).
  putObj(s, x0 + 4, y + 1, { type: 'boat' });

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 0, 'the free boat made the launch pure waste');
  assert.equal(s.players[AI].resources.gold, 5000, 'no gold spent on boats');
  assert.equal(levelObjects(s, 0)[isletObj.id], undefined, 'the islet was still looted — by the free boat');
});

test('AI: does not launch without real water value, even when rich', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  stageTownLake(s, { islet: false }); // a lake with nothing on it
  giveResources(s, AI, 20000, 100);

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 0, 'an empty lake is worth no boat');
  assert.equal(s.players[AI].resources.gold, 20000, 'not a coin spent');
});

test('AI: ignores its home port when it cannot afford the boat', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { isletObj } = stageTownLake(s);
  giveResources(s, AI, 0, 0);

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 0, 'no funds, no boat');
  assert.ok(levelObjects(s, 0)[isletObj.id], 'the islet reward stays out of reach');
});

test('AI (tuning): trades for the wood it lacks at the market, then launches', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  const { hero, isletObj } = stageTownLake(s);
  for (const t of playerTowns(s, AI)) {
    if (!t.buildings.includes('marketplace')) t.buildings.push('marketplace');
  }
  giveResources(s, AI, 8000, 0); // plenty of gold, ZERO wood

  const ai = runTurn(s);

  assert.equal(ai.metrics.boatsBuilt, 1, 'the AI bought the 10 wood and launched the boat');
  assert.equal(s.players[AI].resources.wood, 0, 'the bought wood was spent on the boat (net zero)');
  assert.ok(s.players[AI].resources.gold < 8000 - CONFIG.BOAT_COST.gold,
    'gold paid for the boat AND the market purchase of wood');
  assert.ok(s.players[AI].resources.gold >= 1000, 'the gold reserve was respected');
  assert.equal(levelObjects(s, 0)[isletObj.id], undefined, 'and the sea-locked reward was collected');
  const loot = [...Object.values(hero.equipment).filter(Boolean), ...hero.backpack];
  assert.ok(loot.includes('titansGladius'), 'the artifact ended up on the hero');
});

// ---------------------------------------------------------------------------
// Non-regression: landlocked play is byte-identical and shipyard-free
// ---------------------------------------------------------------------------

test('AI: town-shipyard decisions are deterministic — same seed, identical game', () => {
  const play = () => {
    const s = newGame({
      seed: 31337, mapW: 56, mapH: 46,
      players: [
        { faction: 'castle', isHuman: false, team: 0 },
        { faction: 'inferno', isHuman: false, team: 1 },
      ],
    });
    let guard = 40;
    while (s.winner === null && s.day <= 4 && guard-- > 0) {
      const ai = new AITurnController(s, s.currentPlayer);
      let r, g2 = 100;
      do {
        r = ai.next();
        if (r.type === 'combat') ai.autoFight(r.context);
      } while (r.type !== 'done' && g2-- > 0);
      endTurn(s);
    }
    return s;
  };
  const digest = (s) => JSON.stringify({
    day: s.day,
    rng: s.rng.toJSON(),
    players: s.players.map((p) => [p.resources, p.defeated]),
    heroes: Object.values(s.heroes).map((h) => [
      h.rosterId, h.owner, h.x, h.y, h.z, h.onBoat, h.level, h.xp, h.mp, h.army,
    ]),
    // Keyed by position, not id — town ids come from a process-global uid
    // counter that (correctly) differs between two games in one process.
    towns: Object.values(s.towns).map((t) => [`${t.x},${t.y}`, t.owner, [...t.buildings].sort()]),
    boats: Object.values(s.map.objects).filter((o) => o.type === 'boat')
      .map((o) => `${o.x},${o.y}`).sort(),
  });
  const a = play(), b = play();
  assert.equal(digest(a), digest(b), 'two runs of one seed are identical');
  // The coastal gate holds across a real sim: a shipyard NEVER stands in a
  // town that does not border water.
  for (const t of Object.values(a.towns)) {
    if (!townIsCoastal(a, t)) {
      assert.ok(!t.buildings.includes('shipyard'),
        `landlocked town ${t.id} never builds a shipyard`);
    }
  }
});
