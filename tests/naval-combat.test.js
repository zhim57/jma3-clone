/**
 * naval-combat.test.js — naval combat: heroes fight on and against boats.
 *
 * v1 — a hero aboard a boat can fight. stepHero's onBoat branch no longer
 * blanket-blocks occupied targets: ending a move on an adjacent ENEMY —
 * another boat hero (fleet clash), a hero or town on the shore (coastal raid /
 * siege), or a land monster — deducts MP and returns a combat/siege context
 * exactly like the foot path. The attacker NEVER enters the target tile: it
 * fights from the deck and stays onBoat at its own water tile, win or lose (no
 * disembark-on-victory). The context is naval-tagged (ctx.naval === true,
 * ctx.terrain === 'water') so the view can pick a sea battlefield backdrop;
 * land contexts carry neither field. Allied heroes/towns still block (no naval
 * friendly fire), and an armyless boat can't pick fights.
 *
 * v2 — the reverse raid + wrecks. A LAND hero may now attack an enemy boat
 * hero moored alongside: a water tile is enterable on foot when a hero sits
 * there (isEnterable), and stepHero's foot-water branch returns a naval combat
 * context (attacker stays ashore, never entering the water). And any boat hero
 * defeated — attacker or defender — leaves a drifting DERELICT boat where they
 * sank (applyCombatResult → leaveDerelictBoat), a wreck any hero can reboard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, tileAt, heroAt, playerHeroes, playerTowns, nextObjectId,
  serialize, deserialize, SAVE_VERSION,
} from '../src/core/GameState.js';
import { stepHero, applyCombatResult, townHasDefenders } from '../src/core/actions.js';
import { findPath, isEnterable } from '../src/map/Pathfinding.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { Rng } from '../src/core/rng.js';

const EMPTY = () => [null, null, null, null, null, null, null];

// ---------------------------------------------------------------------------
// Staging helpers (same approach as water.test.js)
// ---------------------------------------------------------------------------

/** Find a clean horizontal run of `len` tiles (with a 1-tile apron). */
function cleanStrip(state, len = 8) {
  const { w, h } = state.map;
  for (let y = 3; y < h - 3; y++) {
    for (let x0 = 3; x0 < w - len - 3; x0++) {
      let ok = true;
      for (let dx = -1; dx <= len && ok; dx++) {
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

/**
 * Paint a shore scene on a clean strip: land | water ×4 | land, with a grass
 * apron. Returns the key tiles.
 */
function shoreScene(state) {
  const { x0, y } = cleanStrip(state, 8);
  for (let dx = -1; dx <= 8; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const t = tileAt(state, x0 + dx, y + dy);
      t.terrain = 'grass'; t.obstacle = null; t.objectId = null;
    }
  }
  for (let dx = 1; dx <= 4; dx++) tileAt(state, x0 + dx, y).terrain = 'water';
  return {
    land0: { x: x0, y },
    water1: { x: x0 + 1, y },
    water2: { x: x0 + 2, y },
    water3: { x: x0 + 3, y },
    water4: { x: x0 + 4, y },
    shore: { x: x0 + 5, y },
  };
}

/** Put a hero on a tile, optionally aboard a boat, with a set army. */
function place(hero, at, { onBoat = false, army = null, mp = 5000 } = {}) {
  hero.x = at.x; hero.y = at.y; hero.z = 0;
  hero.onBoat = onBoat;
  hero.inTownId = null;
  hero.mp = mp;
  hero.army = army ? [...army, ...EMPTY()].slice(0, 7) : hero.army;
  return hero;
}

const PIKES = (n) => [{ creature: 'pikeman', count: n, hurt: 0 }];

/** Drop a map object at (x, y) on the surface. */
function putObj(state, x, y, data) {
  const id = nextObjectId(state);
  const obj = { id, x, y, ...data };
  state.map.objects[id] = obj;
  tileAt(state, x, y).objectId = id;
  return obj;
}

/** Relocate an existing town (map object + registry entry) to (x, y). */
function moveTown(state, town, x, y) {
  const oldTile = tileAt(state, town.x, town.y);
  const obj = state.map.objects[oldTile.objectId];
  oldTile.objectId = null;
  town.x = x; town.y = y;
  obj.x = x; obj.y = y;
  const t = tileAt(state, x, y);
  t.terrain = 'grass'; t.obstacle = null; t.objectId = obj.id;
  return town;
}

const SEED = 3;
const SIZE = { mapW: 56, mapH: 46 };

// ---------------------------------------------------------------------------
// Fleet clash: boat hero vs boat hero
// ---------------------------------------------------------------------------

test('fleet clash: a boat hero attacks an adjacent enemy boat hero', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.water1, { onBoat: true, army: PIKES(20) });
  const b = place(playerHeroes(s, 1)[0], L.water2, { onBoat: true, army: PIKES(2) });

  const mp0 = a.mp;
  const ev = stepHero(s, a, { x: L.water2.x, y: L.water2.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'sailing onto an enemy boat hero is an attack');
  assert.equal(ev.context.defender.kind, 'hero');
  assert.equal(ev.context.defenderHeroId, b.id);
  assert.equal(ev.context.naval, true, 'the context is naval-tagged');
  assert.equal(ev.context.terrain, 'water', 'the context carries the water battlefield terrain');
  assert.equal(a.mp, mp0 - 100, 'MP paid for the attack step');
  assert.equal(a.x, L.water1.x, 'attacker did NOT enter the target tile');
  assert.equal(a.onBoat, true, 'attacker is still aboard');

  // Win: the enemy is removed; the attacker still floats where it fought from.
  const events = applyCombatResult(s, ev.context, {
    attackerWon: true, attackerArmy: PIKES(18), defenderArmy: [], xp: 60,
  });
  assert.ok(Array.isArray(events));
  assert.equal(s.heroes[b.id], undefined, 'the defeated boat hero is gone');
  assert.equal(a.x, L.water1.x, 'winner has not moved');
  assert.equal(a.y, L.water1.y);
  assert.equal(a.onBoat, true, 'winner remains onBoat (no disembark-on-victory)');
  assert.equal(a.army[0].count, 18, 'survivors written back');
});

test('a boat hero that DEFENDS resolves correctly (attacker loses)', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const raider = place(playerHeroes(s, 1)[0], L.water3, { onBoat: true, army: PIKES(2) });
  const ours = place(playerHeroes(s, 0)[0], L.water2, { onBoat: true, army: PIKES(30) });

  const ev = stepHero(s, raider, { x: L.water2.x, y: L.water2.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'our boat hero can be attacked at sea');
  assert.equal(ev.context.defenderHeroId, ours.id);
  assert.equal(ev.context.naval, true);

  // Fight it for real — water terrain, boat hero on the defending side.
  const battle = createBattle({
    rng: s.rng,
    terrain: ev.context.terrain,
    attacker: { hero: raider, army: raider.army.filter(Boolean), playerIndex: raider.owner },
    defender: { hero: ours, army: ev.context.defenderArmy, playerIndex: ours.owner },
    defenseBonus: ev.context.defenseBonus || 0,
  });
  assert.equal(battle.terrain, 'water', 'the engine accepts a water battlefield');
  const result = autoResolve(battle);
  assert.equal(result.attackerWon, false, '2 pikemen lose to 30');

  applyCombatResult(s, ev.context, result);
  assert.equal(s.heroes[raider.id], undefined, 'the beaten attacker is removed (boat and all)');
  assert.ok(s.heroes[ours.id], 'the defender survives');
  assert.equal(ours.x, L.water2.x, 'defender has not moved');
  assert.equal(ours.onBoat, true, 'defender is still aboard');
  assert.ok(ours.army[0].count > 0, 'defender survivors written back');
});

// ---------------------------------------------------------------------------
// Coastal raid: boat hero vs hero / monster ashore
// ---------------------------------------------------------------------------

test('coastal raid: a boat hero attacks an enemy hero on the shore', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.water4, { onBoat: true, army: PIKES(20) });
  const b = place(playerHeroes(s, 1)[0], L.shore, { army: PIKES(2) });

  const ev = stepHero(s, a, { x: L.shore.x, y: L.shore.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'a coastal enemy hero can be raided from the water');
  assert.equal(ev.context.defender.kind, 'hero');
  assert.equal(ev.context.naval, true, 'raid from a boat is naval');
  assert.equal(ev.context.terrain, 'water');
  assert.equal(a.onBoat, true);

  applyCombatResult(s, ev.context, {
    attackerWon: true, attackerArmy: PIKES(19), defenderArmy: [], xp: 40,
  });
  assert.equal(s.heroes[b.id], undefined, 'the shore hero fell');
  assert.equal(a.x, L.water4.x, 'raider still floats offshore');
  assert.equal(a.onBoat, true);
});

test('a boat hero fights a land monster from the deck', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.water4, { onBoat: true, army: PIKES(20) });
  const mon = putObj(s, L.shore.x, L.shore.y, { type: 'monster', creature: 'peasant', count: 5 });

  const ev = stepHero(s, a, { x: L.shore.x, y: L.shore.y, cost: 100 });
  assert.equal(ev.type, 'combat');
  assert.equal(ev.context.defender.kind, 'monster');
  assert.equal(ev.context.naval, true);

  applyCombatResult(s, ev.context, {
    attackerWon: true, attackerArmy: PIKES(20), defenderArmy: [], xp: 25,
  });
  assert.equal(s.map.objects[mon.id], undefined, 'the guard is slain');
  assert.equal(tileAt(s, L.shore.x, L.shore.y).objectId, null, 'its tile is cleared');
  assert.equal(a.x, L.water4.x, 'the hero never left the water');
  assert.equal(a.onBoat, true);
});

// ---------------------------------------------------------------------------
// Coastal siege: boat hero vs town
// ---------------------------------------------------------------------------

test('coastal siege: winning flips the town owner; the raider stays aboard', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.water4, { onBoat: true, army: PIKES(30) });
  const town = moveTown(s, playerTowns(s, 1)[0], L.shore.x, L.shore.y);
  town.garrison = [...PIKES(3), ...EMPTY()].slice(0, 7);
  assert.equal(townHasDefenders(s, town), true);

  const ev = stepHero(s, a, { x: L.shore.x, y: L.shore.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'a defended coastal town is besieged from the water');
  assert.equal(ev.context.siege, true, 'it is a siege (walls apply)');
  assert.equal(ev.context.naval, true, 'and it is naval-tagged');
  assert.equal(ev.context.terrain, 'water');

  applyCombatResult(s, ev.context, {
    attackerWon: true, attackerArmy: PIKES(28), defenderArmy: [], xp: 30,
  });
  assert.equal(town.owner, 0, 'the town owner flipped to the raider');
  assert.equal(a.x, L.water4.x, 'the raider did NOT enter the town');
  assert.equal(a.y, L.water4.y);
  assert.equal(a.onBoat, true, 'the raider is still aboard');
  assert.equal(a.inTownId, null, 'not visiting the captured town');
  assert.equal(town.visitingHeroId, null, 'nobody stands on the town square');
});

test('an undefended coastal town is captured from the water without entering', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.water4, { onBoat: true, army: PIKES(10) });
  const town = moveTown(s, playerTowns(s, 1)[0], L.shore.x, L.shore.y);
  town.garrison = EMPTY();
  // An armyless enemy visitor surrenders the keys, exactly as on foot.
  const visitor = place(playerHeroes(s, 1)[0], { x: town.x, y: town.y }, { army: [] });
  visitor.army = EMPTY();
  town.visitingHeroId = visitor.id;
  visitor.inTownId = town.id;
  assert.equal(townHasDefenders(s, town), false);

  const mp0 = a.mp;
  const ev = stepHero(s, a, { x: town.x, y: town.y, cost: 100 });
  assert.equal(ev.type, 'navalCapture', 'captured from the deck, no battle needed');
  assert.equal(ev.townId, town.id);
  assert.equal(ev.captured, true);
  assert.equal(town.owner, 0, 'the flag flipped');
  assert.equal(s.heroes[visitor.id], undefined, 'the armyless visitor surrendered');
  assert.equal(a.mp, mp0 - 100, 'the step cost was paid');
  assert.equal(a.x, L.water4.x, 'the raider stays on the water');
  assert.equal(a.onBoat, true);
  assert.equal(town.visitingHeroId, null, 'the town square stays empty');
});

// ---------------------------------------------------------------------------
// Naval v2: a LAND hero attacks a boat hero from the shore
// ---------------------------------------------------------------------------

test('a land hero can path to an enemy boat hero moored alongside', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.land0, { army: PIKES(20) });
  place(playerHeroes(s, 1)[0], L.water1, { onBoat: true, army: PIKES(2) });

  // The occupied water tile is enterable on foot (attack target), but an
  // EMPTY water tile is not (can't swim / no boat). Omniscient (-1) isolates
  // the terrain/occupancy rule from fog.
  assert.equal(isEnterable(s, L.water1.x, L.water1.y, -1, false, 0), true,
    'a water tile with a boat hero is a valid foot destination (to strike it)');
  assert.equal(isEnterable(s, L.water2.x, L.water2.y, -1, false, 0), false,
    'open water is still not enterable on foot');

  const p = findPath(s, a, L.water1.x, L.water1.y, -1);
  assert.ok(p, 'a shore hero can route to the moored boat hero');
  const end = p.path.at(-1);
  assert.deepEqual([end.x, end.y], [L.water1.x, L.water1.y], 'the path ends on the boat hero tile');
});

test('naval v2: a land hero raids a boat hero and leaves a derelict on the win', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.land0, { army: PIKES(20) });
  const b = place(playerHeroes(s, 1)[0], L.water1, { onBoat: true, army: PIKES(2) });

  const mp0 = a.mp;
  const ev = stepHero(s, a, { x: L.water1.x, y: L.water1.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'striking a moored boat hero from land is an attack');
  assert.equal(ev.context.defender.kind, 'hero');
  assert.equal(ev.context.defenderHeroId, b.id);
  assert.equal(ev.context.naval, true, 'a boat defender makes the battle naval');
  assert.equal(ev.context.terrain, 'water');
  assert.equal(a.mp, mp0 - 100, 'MP paid for the attack step');
  assert.equal(a.x, L.land0.x, 'attacker never entered the water');
  assert.equal(a.y, L.land0.y);
  assert.equal(!!a.onBoat, false, 'attacker is still on foot (fought from the shore)');

  applyCombatResult(s, ev.context, {
    attackerWon: true, attackerArmy: PIKES(18), defenderArmy: [], xp: 50,
  });
  assert.equal(s.heroes[b.id], undefined, 'the boat hero was sunk');
  const wreck = s.map.objects[tileAt(s, L.water1.x, L.water1.y).objectId];
  assert.ok(wreck && wreck.type === 'boat', 'a derelict boat drifts where the hero sank');
  assert.equal(a.x, L.land0.x, 'winner stayed ashore');
});

test('naval v2: the derelict a sunk boat hero leaves can be reboarded', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.land0, { army: PIKES(20) });
  const b = place(playerHeroes(s, 1)[0], L.water1, { onBoat: true, army: PIKES(2) });

  const ev = stepHero(s, a, { x: L.water1.x, y: L.water1.y, cost: 100 });
  applyCombatResult(s, ev.context, {
    attackerWon: true, attackerArmy: PIKES(18), defenderArmy: [], xp: 50,
  });
  assert.equal(s.heroes[b.id], undefined);

  // The winner (still ashore at land0, adjacent to water1) now boards the wreck.
  const board = stepHero(s, a, { x: L.water1.x, y: L.water1.y, cost: 100 });
  assert.equal(board.type, 'embark', 'the derelict is a normal boat again');
  assert.equal(a.onBoat, true, 'the hero climbed aboard');
  assert.deepEqual([a.x, a.y], [L.water1.x, L.water1.y], 'and moved onto the boat tile');
  assert.equal(tileAt(s, L.water1.x, L.water1.y).objectId, null, 'the boat object was consumed');
});

test('naval v2: a land raider that LOSES leaves no wreck (it never had a boat)', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.land0, { army: PIKES(2) });
  const b = place(playerHeroes(s, 1)[0], L.water1, { onBoat: true, army: PIKES(30) });

  const ev = stepHero(s, a, { x: L.water1.x, y: L.water1.y, cost: 100 });
  assert.equal(ev.type, 'combat');
  applyCombatResult(s, ev.context, {
    attackerWon: false, attackerArmy: [], defenderArmy: PIKES(28), xp: 10,
  });
  assert.equal(s.heroes[a.id], undefined, 'the land raider fell');
  assert.equal(tileAt(s, L.land0.x, L.land0.y).objectId, null,
    'no boat is left on the LAND tile where a foot hero died');
  assert.ok(s.heroes[b.id], 'the boat hero survived');
  assert.equal(b.onBoat, true, 'and is still afloat with its boat intact (no derelict)');
  assert.equal(tileAt(s, L.water1.x, L.water1.y).objectId, null,
    'the surviving boat hero carries its boat — no object on the tile');
});

test('naval v2: an allied boat hero blocks a land hero (no friendly fire)', () => {
  const s = newGame({ seed: SEED, players: TWO_V_TWO, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.land0, { army: PIKES(20) });
  const ally = place(playerHeroes(s, 1)[0], L.water1, { onBoat: true, army: PIKES(5) });

  const ev = stepHero(s, a, { x: L.water1.x, y: L.water1.y, cost: 100 });
  assert.equal(ev.type, 'blocked', 'an allied boat hero is not attacked from shore');
  assert.ok(s.heroes[ally.id], 'the ally is untouched');
  assert.equal(a.x, L.land0.x, 'and the land hero did not move onto the water');
});

test('naval v2: a fleet clash loser leaves a derelict at its own tile', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  // A boat raider attacks a stronger boat defender and loses — its wreck stays.
  const raider = place(playerHeroes(s, 1)[0], L.water3, { onBoat: true, army: PIKES(2) });
  const ours = place(playerHeroes(s, 0)[0], L.water2, { onBoat: true, army: PIKES(30) });

  const ev = stepHero(s, raider, { x: L.water2.x, y: L.water2.y, cost: 100 });
  applyCombatResult(s, ev.context, {
    attackerWon: false, attackerArmy: [], defenderArmy: PIKES(28), xp: 10,
  });
  assert.equal(s.heroes[raider.id], undefined, 'the beaten raider is gone');
  const wreck = s.map.objects[tileAt(s, L.water3.x, L.water3.y).objectId];
  assert.ok(wreck && wreck.type === 'boat', 'its boat drifts on as a derelict');
  assert.ok(s.heroes[ours.id], 'the defender lives');
});

// ---------------------------------------------------------------------------
// No friendly fire; armyless boats can't fight
// ---------------------------------------------------------------------------

const TWO_V_TWO = [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
  { faction: 'inferno', isHuman: false, team: 1 },
];

test('no naval friendly fire: an allied boat hero and an allied town still block', () => {
  const s = newGame({ seed: SEED, players: TWO_V_TWO, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.water1, { onBoat: true, army: PIKES(20) });
  const ally = place(playerHeroes(s, 1)[0], L.water2, { onBoat: true, army: PIKES(5) });

  const onAlly = stepHero(s, a, { x: L.water2.x, y: L.water2.y, cost: 100 });
  assert.equal(onAlly.type, 'blocked', 'an allied boat hero blocks — never a battle');
  assert.ok(s.heroes[ally.id], 'the ally is untouched');
  assert.equal(a.x, L.water1.x, 'no move happened');

  // Allied town on the shore: off-limits, not besieged.
  const allyTown = moveTown(s, playerTowns(s, 1)[0], L.shore.x, L.shore.y);
  place(a, L.water4, { onBoat: true, army: PIKES(20) });
  const onTown = stepHero(s, a, { x: allyTown.x, y: allyTown.y, cost: 100 });
  assert.equal(onTown.type, 'blocked', 'an allied town blocks');
  assert.equal(allyTown.owner, 1, 'the ally still owns it');

  // Own second hero on the water blocks too (tile occupied, no fight).
  const own = place(playerHeroes(s, 1)[0], L.water2, { onBoat: true });
  own.owner = 0; // make it literally ours
  place(a, L.water1, { onBoat: true, army: PIKES(20) });
  const onOwn = stepHero(s, a, { x: L.water2.x, y: L.water2.y, cost: 100 });
  assert.equal(onOwn.type, 'blocked', 'your own hero blocks');
});

test('an armyless boat hero cannot pick fights (but sails on)', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.water1, { onBoat: true });
  a.army = EMPTY();
  const b = place(playerHeroes(s, 1)[0], L.water2, { onBoat: true, army: PIKES(1) });

  const onHero = stepHero(s, a, { x: L.water2.x, y: L.water2.y, cost: 100 });
  assert.equal(onHero.type, 'blocked', 'no escort, no fleet clash');
  assert.ok(s.heroes[b.id]);

  // Same against a defended town and a monster ashore.
  place(b, { x: 1, y: 1 }, { onBoat: false }); // park the enemy far away
  const town = moveTown(s, playerTowns(s, 1)[0], L.shore.x, L.shore.y);
  town.garrison = [...PIKES(3), ...EMPTY()].slice(0, 7);
  place(a, L.water4, { onBoat: true });
  a.army = EMPTY();
  assert.equal(stepHero(s, a, { x: town.x, y: town.y, cost: 100 }).type, 'blocked',
    'no escort, no siege');
  moveTown(s, town, 2, 2); // clear the shore again
  const mon = putObj(s, L.shore.x, L.shore.y, { type: 'monster', creature: 'peasant', count: 5 });
  assert.equal(stepHero(s, a, { x: mon.x, y: mon.y, cost: 100 }).type, 'blocked',
    'no escort, no monster hunt');

  // Sailing on open water is still fine without an army.
  const sail = stepHero(s, a, { x: L.water3.x, y: L.water3.y, cost: 100 });
  assert.equal(sail.type, 'moved', 'an armyless boat still sails');
});

// ---------------------------------------------------------------------------
// Tagging and engine behavior
// ---------------------------------------------------------------------------

test('land combat contexts carry no naval tag (non-regression)', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.land0, { army: PIKES(20) });
  const b = place(playerHeroes(s, 1)[0], { x: L.land0.x, y: L.land0.y + 1 }, { army: PIKES(2) });

  const ev = stepHero(s, a, { x: b.x, y: b.y, cost: 100 });
  assert.equal(ev.type, 'combat');
  assert.equal(ev.context.naval, undefined, 'a land battle is not naval-tagged');
  assert.equal(ev.context.terrain, undefined, 'no terrain override on land contexts');
});

test('the combat engine handles water terrain (no crash, no mechanical effect)', () => {
  const fight = (terrain, seed) => {
    const battle = createBattle({
      rng: new Rng(seed),
      terrain,
      attacker: { hero: null, army: PIKES(15), playerIndex: 0 },
      defender: { hero: null, army: [{ creature: 'imp', count: 10, hurt: 0 }], playerIndex: 1 },
    });
    return { terrain: battle.terrain, result: autoResolve(battle) };
  };
  const water = fight('water', 9);
  assert.equal(water.terrain, 'water', 'water is carried as the battlefield terrain');
  assert.equal(typeof water.result.attackerWon, 'boolean', 'the battle resolves');
  // Terrain is visual-only: the identical seed on grass plays out identically.
  const grass = fight('grass', 9);
  assert.deepEqual(water.result, grass.result, 'water changes nothing mechanically');
});

// ---------------------------------------------------------------------------
// Save round-trip
// ---------------------------------------------------------------------------

test('save round-trip: a boat hero mid-water survives and can still raid', () => {
  const s = newGame({ seed: SEED, ...SIZE });
  const L = shoreScene(s);
  const a = place(playerHeroes(s, 0)[0], L.water2, { onBoat: true, army: PIKES(20), mp: 700 });
  place(playerHeroes(s, 1)[0], L.shore, { army: PIKES(2) });

  const loaded = deserialize(serialize(s));
  const la = loaded.heroes[a.id];
  assert.ok(la, 'the boat hero survives the round-trip');
  assert.equal(la.onBoat, true, 'onBoat round-trips (v2 shape, no migration needed)');
  assert.deepEqual([la.x, la.y, la.z ?? 0, la.mp], [L.water2.x, L.water2.y, 0, 700]);
  assert.equal(loaded.version, SAVE_VERSION, 'current save version — naval adds no shape of its own');

  // The loaded state supports naval combat exactly like the live one.
  la.mp = 5000;
  stepHero(loaded, la, { x: L.water3.x, y: L.water3.y, cost: 100 });
  stepHero(loaded, la, { x: L.water4.x, y: L.water4.y, cost: 100 });
  const ev = stepHero(loaded, la, { x: L.shore.x, y: L.shore.y, cost: 100 });
  assert.equal(ev.type, 'combat', 'coastal raid works after loading');
  assert.equal(ev.context.naval, true);
});

// ---------------------------------------------------------------------------
// AI: initiates naval combat, terminates, never loops
// ---------------------------------------------------------------------------

/** Drive a full AI turn; auto-resolve any interactive battles. */
function runTurn(state, playerIndex) {
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

/** Make every enemy TOWN unbeatable so staged heroes are the only fight. */
function fortifyTowns(state, aiIndex) {
  for (const town of Object.values(state.towns)) {
    if (town.owner !== aiIndex) {
      town.garrison[0] = { creature: 'archangel', count: 500, hurt: 0 };
    }
  }
}

test('AI: a boat hero clashes with an adjacent weaker enemy boat hero and wins', () => {
  const s = newGame({
    seed: SEED, ...SIZE,
    players: [
      { faction: 'castle', isHuman: false, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const L = shoreScene(s);
  fortifyTowns(s, 1);
  const prey = place(playerHeroes(s, 0)[0], L.water2, { onBoat: true, army: PIKES(2) });
  // MP covers exactly the attack step, so the turn ends right after the clash
  // (with a full pool the AI would legitimately sail on / land afterwards).
  const raider = place(playerHeroes(s, 1)[0], L.water3, {
    onBoat: true, mp: 150,
    army: [{ creature: 'efreetSultan', count: 40, hurt: 0 }],
  });

  runTurn(s, 1);

  assert.equal(s.heroes[prey.id], undefined, 'the weaker boat hero was sunk');
  assert.ok(s.heroes[raider.id], 'the raider survives');
  assert.equal(raider.onBoat, true, 'and remains aboard');
  assert.deepEqual([raider.x, raider.y], [L.water3.x, L.water3.y], 'fought from its own tile');
  assert.equal(tileAt(s, raider.x, raider.y).terrain, 'water', 'still on the water');
});

test('AI: a boat hero besieges a weak coastal town from the water', () => {
  const s = newGame({
    seed: SEED, ...SIZE,
    players: [
      { faction: 'castle', isHuman: false, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const L = shoreScene(s);
  // Park the enemy hero far off so the town is the only naval target.
  place(playerHeroes(s, 0)[0], { x: 1, y: 1 }, { army: PIKES(1), mp: 0 });
  const town = moveTown(s, playerTowns(s, 0)[0], L.shore.x, L.shore.y);
  town.garrison = [...PIKES(2), ...EMPTY()].slice(0, 7);
  // MP covers exactly the siege step — the turn ends with the raider afloat.
  const raider = place(playerHeroes(s, 1)[0], L.water4, {
    onBoat: true, mp: 150,
    army: [{ creature: 'efreetSultan', count: 40, hurt: 0 }],
  });

  runTurn(s, 1);

  assert.equal(town.owner, 1, 'the coastal town fell to the fleet');
  assert.ok(s.heroes[raider.id], 'the raider survives');
  assert.equal(raider.onBoat, true, 'the raider never entered the town');
  assert.equal(raider.inTownId, null);
  assert.deepEqual([raider.x, raider.y], [L.water4.x, L.water4.y], 'besieged from its own tile');
  assert.equal(tileAt(s, raider.x, raider.y).terrain, 'water');
});

test('AI: an undefended coastal town is captured from the deck (no battle, no loop)', () => {
  const s = newGame({
    seed: SEED, ...SIZE,
    players: [
      { faction: 'castle', isHuman: false, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const L = shoreScene(s);
  place(playerHeroes(s, 0)[0], { x: 1, y: 1 }, { army: PIKES(1), mp: 0 });
  const town = moveTown(s, playerTowns(s, 0)[0], L.shore.x, L.shore.y);
  town.garrison = EMPTY();
  town.visitingHeroId = null;
  const raider = place(playerHeroes(s, 1)[0], L.water4, {
    onBoat: true, mp: 150,
    army: [{ creature: 'efreetSultan', count: 40, hurt: 0 }],
  });

  runTurn(s, 1); // termination is asserted inside — the capture cannot loop

  assert.equal(town.owner, 1, 'the undefended coastal town was flagged from the water');
  assert.equal(raider.onBoat, true, 'the raider never entered it');
  assert.deepEqual([raider.x, raider.y], [L.water4.x, L.water4.y]);
});

test('AI: naval combat keeps courage — a hopeless fleet clash is never picked', () => {
  const s = newGame({
    seed: SEED, ...SIZE,
    players: [
      { faction: 'castle', isHuman: false, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const L = shoreScene(s);
  fortifyTowns(s, 1);
  const titan = place(playerHeroes(s, 0)[0], L.water2, {
    onBoat: true, army: [{ creature: 'archangel', count: 500, hurt: 0 }],
  });
  const weak = place(playerHeroes(s, 1)[0], L.water4, { onBoat: true, mp: 2000, army: PIKES(3) });

  runTurn(s, 1);

  assert.ok(s.heroes[weak.id], 'the weak boat hero did not suicide into the titan');
  assert.ok(s.heroes[titan.id], 'no battle happened');
});

test('AI: naval decisions are deterministic — same seed, identical outcome', () => {
  const play = () => {
    const s = newGame({
      seed: 91, ...SIZE,
      players: [
        { faction: 'castle', isHuman: false, team: 0 },
        { faction: 'inferno', isHuman: false, team: 1 },
      ],
    });
    const L = shoreScene(s);
    fortifyTowns(s, 1);
    place(playerHeroes(s, 0)[0], L.water2, { onBoat: true, army: PIKES(2) });
    place(playerHeroes(s, 1)[0], L.water4, {
      onBoat: true, mp: 3000,
      army: [{ creature: 'efreetSultan', count: 40, hurt: 0 }],
    });
    runTurn(s, 1);
    return JSON.stringify({
      rng: s.rng.toJSON(),
      heroes: Object.values(s.heroes).map((h) => [h.rosterId, h.owner, h.x, h.y, h.onBoat, h.mp, h.army]),
      towns: Object.values(s.towns).map((t) => [t.name, t.owner]),
    });
  };
  assert.equal(play(), play(), 'two runs of one seed are identical');
});
