/**
 * ai-connectors.test.js — the AI's use of portals, subterranean gates & boats.
 *
 * v2 of the adventure AI treats the three movement connectors as goals in its
 * one value/distance/courage currency: a connector is worth the best prize
 * reachable THROUGH it (distance-discounted, crossing cost added, hysteresis
 * damped), and a transit simply drops the cached plan and re-plans from the
 * far side. Pinned here:
 *   - an underground hero pursues underground goals (no more forced hold);
 *   - a hero routes to and descends a gate when the vault holds clear value;
 *   - a hero boards a boat, loots a sea-locked islet, and ferries back to
 *     work instead of stranding itself;
 *   - a portal is used as a shortcut toward distant value — exactly once;
 *   - oscillation is impossible: per-turn transit cap, a used gate/portal
 *     pair cools down through the following day (even when value beckons),
 *     and the return, once the cooldown expires, is purposeful;
 *   - decisions are deterministic per seed.
 *
 * Tests hand-shape a real generated game: enemy assets are fortified beyond
 * the courage gate and loose surface prizes stripped, so the staged connector
 * value is the AI's best (and only) option — deterministic by construction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, playerHeroes, playerTowns, tileAt, levelObjects,
} from '../src/core/GameState.js';
import { endTurn } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1; // player index of the AI opponent in a fresh game

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

/** Remove every object except towns from one level (0 surface, 1 under). */
function stripObjects(state, level = 0) {
  const m = level ? state.map.underground : state.map;
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

/** Zero the AI's treasury so towns neither hire, build nor recruit. */
function impoverish(state, aiIndex = AI) {
  state.players[aiIndex].resources = {
    gold: 0, wood: 0, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 0,
  };
}

/** Force a clean (r*2+1)² block of open ground around (cx, cy) on `level`. */
function clearBlock(state, level, cx, cy, r = 2) {
  const m = level ? state.map.underground : state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const t = m.tiles[(cy + dy) * state.map.w + (cx + dx)];
      t.obstacle = null;
      t.terrain = level ? 'rough' : 'grass';
      if (t.objectId) {
        delete m.objects[t.objectId];
        t.objectId = null;
      }
    }
  }
  return { x: cx, y: cy };
}

/** Drop an object onto a live state at (x, y) on `level`; returns it. */
function putObj(state, level, x, y, data) {
  const m = level ? state.map.underground : state.map;
  const id = `${level ? 'U' : 'O'}${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * state.map.w + x].objectId = id;
  return obj;
}

function aiHero(state) {
  const hero = playerHeroes(state, AI)[0];
  hero.army = [{ creature: 'pikeman', count: 20, hurt: 0 }, null, null, null, null, null, null];
  hero.mp = 3000;
  return hero;
}

// ---------------------------------------------------------------------------
// Underground pursuit
// ---------------------------------------------------------------------------

test('an underground hero pursues an underground goal (no more forced hold)', () => {
  const s = newGame({ seed: 4242 });
  const hero = aiHero(s);
  const c = clearBlock(s, 1, 22, 22, 3);
  hero.z = 1;
  hero.x = c.x;
  hero.y = c.y;
  const pile = putObj(s, 1, c.x + 1, c.y, { type: 'resource', resource: 'gems', amount: 7 });

  runTurn(s);

  // The object being GONE is the direct evidence, and the only evidence that
  // survives contact with the rest of the turn. A treasury reading used to stand
  // beside it — `gems >= gems0 + 7` — and it went stale the day the AI learned to
  // trade: the hero collects the seven gems and then spends two of them buying a
  // relic at a trading post, so the pile is plainly collected and the balance
  // sheet says otherwise. The claim was always "this hero pursued and took this
  // pile", not "the treasury moved", and a treasury can move for any reason.
  assert.equal(levelObjects(s, 1)[pile.id], undefined,
    'the underground pile was collected (consumed from the underground dict)');
  assert.ok(!Object.values(levelObjects(s, 1)).some((o) => o.x === pile.x && o.y === pile.y),
    'and its tile is clear');
});

// ---------------------------------------------------------------------------
// Subterranean gates
// ---------------------------------------------------------------------------

test('a hero routes to a gate and descends when the vault holds clear value', () => {
  const s = newGame({ seed: 4242 });
  stripObjects(s, 0);
  fortifyEnemies(s);
  impoverish(s);
  const hero = aiHero(s);

  // Stage: hero — gate on the surface; partner gate + unowned gold mine below.
  const a = clearBlock(s, 0, 30, 12, 2);
  const b = clearBlock(s, 1, 20, 20, 3);
  putObj(s, 0, a.x, a.y, { type: 'subGate', channel: 99, color: 0 });
  putObj(s, 1, b.x, b.y, { type: 'subGate', channel: 99, color: 0 });
  const mine = putObj(s, 1, b.x + 2, b.y, { type: 'mine', mineType: 'goldMine', owner: -1 });
  hero.x = a.x;
  hero.y = a.y + 1;

  const ai = runTurn(s);

  assert.ok(ai.metrics.transits.subGate >= 1, 'the hero stepped through the gate');
  assert.equal(hero.z, 1, 'the hero is underground (the used pair cools down this turn)');
  assert.equal(mine.owner, AI, 'the vault gold mine was flagged');
  assert.equal(ai.metrics.transits.subGate, 1, 'exactly one gate transit — no ping-pong');
});

test('gate oscillation is bounded: same-pair cooldown, then a purposeful return', () => {
  const s = newGame({ seed: 4242 });
  stripObjects(s, 0);
  stripObjects(s, 1);
  fortifyEnemies(s);
  impoverish(s);
  const hero = aiHero(s);

  const a = clearBlock(s, 0, 30, 12, 2);
  const b = clearBlock(s, 1, 20, 20, 3);
  putObj(s, 0, a.x, a.y, { type: 'subGate', channel: 99, color: 0 });
  putObj(s, 1, b.x, b.y, { type: 'subGate', channel: 99, color: 0 });
  putObj(s, 1, b.x + 2, b.y, { type: 'resource', resource: 'gold', amount: 1000 });
  hero.x = a.x;
  hero.y = a.y + 1;

  // Day 1: descend for the vault gold; the used pair cools down, so the hero
  // ends the turn below even with movement to spare. (Movement budgets are
  // kept tight throughout so the idle hero stays near the gate while bored.)
  hero.mp = 600;
  const t1 = runTurn(s);
  assert.equal(t1.metrics.transits.subGate, 1, 'one descent on day 1');
  assert.equal(hero.z, 1);

  // Day 2: even with fresh value at the SURFACE end, the just-used pair is
  // still cooling down — no day-after-day shuttling through one gate. The
  // hero has ample movement to reach the gate; the cooldown, not mp, stops it.
  endTurn(s);
  endTurn(s);
  assert.equal(s.day, 2, 'a new day dawned');
  const prize = putObj(s, 0, a.x + 1, a.y, { type: 'artifact', artifact: 'titansGladius' });
  hero.mp = 700;
  const t2 = runTurn(s);
  assert.equal(t2.metrics.transits.subGate, 0, 'the cooldown blocks an immediate return');
  assert.equal(hero.z, 1, 'stayed below');

  // Day 3: the cooldown has expired — the hero returns FOR the prize, once.
  endTurn(s);
  endTurn(s);
  assert.equal(s.day, 3);
  hero.mp = 3000;
  const t3 = runTurn(s);
  assert.equal(t3.metrics.transits.subGate, 1, 'one ascent, for the new prize');
  assert.equal(hero.z, 0, 'back on the surface');
  assert.equal(levelObjects(s, 0)[prize.id], undefined, 'the surface prize was taken');
});

// ---------------------------------------------------------------------------
// Boats & sea-locked islets
// ---------------------------------------------------------------------------

test('a hero boards a boat, loots the sea-locked islet, and ferries back to work', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  stripObjects(s, 0);
  fortifyEnemies(s);
  impoverish(s);
  const hero = aiHero(s);

  // Stage, on a hand-painted lake: shore hero, boat, a 1-tile islet ringed by
  // water bearing a sea-locked reward, and a mainland pile further along the
  // shore (the "work" to return to).
  const x0 = 24, y = 20;
  clearBlock(s, 0, x0 - 5, y, 4);
  clearBlock(s, 0, x0 + 1, y, 4);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = 1; dx <= 5; dx++) {
      const t = tileAt(s, x0 + dx, y + dy);
      t.terrain = 'water';
      t.obstacle = null;
    }
  }
  const isletTile = tileAt(s, x0 + 3, y);
  isletTile.terrain = 'sand';
  putObj(s, 0, x0 + 1, y, { type: 'boat' });
  putObj(s, 0, x0 + 3, y, { type: 'resource', resource: 'gems', amount: 10, seaLocked: true });
  putObj(s, 0, x0 - 9, y, { type: 'resource', resource: 'crystal', amount: 7 });
  hero.x = x0;
  hero.y = y;

  const gems0 = s.players[AI].resources.gems;
  const crystal0 = s.players[AI].resources.crystal;
  const ai = runTurn(s);

  assert.equal(s.players[AI].resources.gems, gems0 + 10, 'the islet reward was looted');
  assert.ok(ai.metrics.transits.embark >= 2, 'boarded to reach the islet AND to leave it');
  assert.ok(ai.metrics.transits.disembark >= 2, 'stepped ashore each time');
  assert.equal(hero.onBoat, false, 'ends the turn on foot');
  assert.ok(!(hero.x === x0 + 3 && hero.y === y), 'not marooned on the islet');
  assert.equal(s.players[AI].resources.crystal, crystal0 + 7, 'resumed mainland work after the crossing');
});

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------

test('a hero takes a portal shortcut toward distant value — exactly once', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 });
  stripObjects(s, 0);
  fortifyEnemies(s);
  impoverish(s);
  const hero = aiHero(s);

  const a = clearBlock(s, 0, 12, 30, 2); // near end, beside the hero
  const b = clearBlock(s, 0, 40, 12, 2); // far end, beside the prize
  putObj(s, 0, a.x, a.y, { type: 'portal', channel: 42, color: 0 });
  putObj(s, 0, b.x, b.y, { type: 'portal', channel: 42, color: 0 });
  const prize = putObj(s, 0, b.x + 1, b.y, { type: 'artifact', artifact: 'titansGladius' });
  hero.x = a.x;
  hero.y = a.y + 1;

  const ai = runTurn(s);

  assert.equal(ai.metrics.transits.portal, 1, 'stepped through the portal exactly once');
  assert.equal(levelObjects(s, 0)[prize.id], undefined, 'the far prize was collected');
  assert.ok(hero.mp >= 0 && (hero.z ?? 0) === 0, 'the hero remains valid after the transit');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('connector decisions are deterministic: same seed ⇒ identical game', () => {
  const play = () => {
    const s = newGame({
      seed: 777,
      players: [
        { faction: 'castle', isHuman: false, team: 0 },
        { faction: 'inferno', isHuman: false, team: 1 },
      ],
    });
    let guard = 60;
    while (s.winner === null && s.day <= 5 && guard-- > 0) {
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
  // Hero/town ids come from a process-global counter, so two games in one
  // process mint different ids; compare an id-independent digest instead.
  const digest = (s) => JSON.stringify({
    day: s.day,
    rng: s.rng.toJSON(),
    players: s.players.map((p) => [p.resources, p.defeated]),
    heroes: Object.values(s.heroes).map((h) => [
      h.rosterId, h.owner, h.x, h.y, h.z, h.onBoat, h.level, h.xp, h.mp, h.army, h.skills,
    ]),
    towns: Object.values(s.towns).map((t) => [
      t.name, t.owner, t.buildings, t.garrison, t.available,
    ]),
    surfaceObjects: Object.keys(s.map.objects),
    underObjects: Object.keys(s.map.underground?.objects || {}),
  });
  const s1 = play();
  const s2 = play();
  assert.equal(digest(s1), digest(s2), 'two runs of the same seed are identical');
  assert.ok(playerTowns(s1, 0).length + playerTowns(s1, 1).length > 0, 'the game is live');
});
