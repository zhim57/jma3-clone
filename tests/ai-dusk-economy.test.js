/**
 * ai-dusk-economy.test.js — the AI's dusk economy pass and peacetime front
 * caravans (the two measured economy-leak fixes).
 *
 * Measured across 8 factions × 12 seeds: (1) 9-17% of all idle town-days were
 * "affordable by dusk" — the day's loot arrived AFTER the dawn town pass and
 * idled overnight; (2) 25-55% of the AI's fielded army value sat parked in
 * rear garrisons because caravans only rolled toward THREATENED towns. The
 * dusk pass re-runs manageTowns after the last hero finishes; front caravans
 * flow idle rear garrisons strictly closer to the main hero. Both are gated
 * by live Settings booleans (aiDuskEconomy / aiFrontCaravans) — off restores
 * classic behavior exactly. Engine + AI only, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { getSetting, setSetting } from '../src/game/settings.js';

const AI = 1;
const stack = (creature, count) => ({ creature, count, hurt: 0 });

/** Run fn with a setting temporarily forced, always restoring the old value. */
function withSetting(key, value, fn) {
  const old = getSetting(key);
  setSetting(key, value);
  try { return fn(); } finally { setSetting(key, old); }
}

// ---------------------------------------------------------------------------
// Dusk economy pass
// ---------------------------------------------------------------------------

/** A one-town AI whose dawn treasury can't build, with the day's "loot" then
 *  granted mid-flow by hand: manageTowns (dawn) → grant → duskEconomy. */
function dawnBrokeState(seed = 21) {
  const state = newGame({
    seed,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'castle', isHuman: false, team: 1 },
    ],
  });
  const player = state.players[AI];
  // Dawn: too poor to build anything (every building costs >= 500 gold).
  player.resources = { gold: 100, wood: 0, ore: 0, mercury: 0, sulfur: 0, crystal: 0, gems: 0 };
  return state;
}

test('dusk pass spends the day\'s loot on a build the dawn pass could not afford', () => {
  withSetting('aiDuskEconomy', true, () => {
    const state = dawnBrokeState();
    const town = playerTowns(state, AI)[0];
    const ctrl = new AITurnController(state, AI);
    ctrl.manageTowns(); // dawn: broke — nothing built
    ctrl.townsDone = true;
    assert.equal(town.buildings.includes('townHall'), false, 'dawn pass could not afford the Town Hall');
    // The heroes' day: a chest's worth of loot lands in the treasury.
    state.players[AI].resources.gold += 5000;
    ctrl.duskEconomy();
    assert.equal(town.buildings.includes('townHall'), true, 'dusk pass built the Town Hall from the loot');
    assert.equal(town.builtToday, true);
  });
});

test('dusk pass respects the one-build-per-day rule (no double construction)', () => {
  withSetting('aiDuskEconomy', true, () => {
    const state = dawnBrokeState(22);
    const town = playerTowns(state, AI)[0];
    state.players[AI].resources.gold = 20000; // rich at dawn
    const ctrl = new AITurnController(state, AI);
    ctrl.manageTowns();
    ctrl.townsDone = true;
    const builtAtDawn = town.buildings.length;
    assert.equal(town.builtToday, true, 'dawn pass built');
    state.players[AI].resources.gold += 20000;
    ctrl.duskEconomy();
    assert.equal(town.buildings.length, builtAtDawn, 'builtToday still caps construction at one');
  });
});

test('with aiDuskEconomy off the dusk pass is inert (classic dawn-only)', () => {
  withSetting('aiDuskEconomy', false, () => {
    const state = dawnBrokeState();
    const town = playerTowns(state, AI)[0];
    const ctrl = new AITurnController(state, AI);
    ctrl.manageTowns();
    ctrl.townsDone = true;
    state.players[AI].resources.gold += 5000;
    ctrl.duskEconomy();
    assert.equal(town.buildings.includes('townHall'), false, 'nothing is bought after dawn');
  });
});

test('duskEconomy runs once per turn (guarded), and a full next() drive fires it', () => {
  withSetting('aiDuskEconomy', true, () => {
    const state = dawnBrokeState(23);
    const ctrl = new AITurnController(state, AI);
    let r, guard = 600;
    do { r = ctrl.next(); if (r.type === 'combat') ctrl.autoFight(r.context); } while (r.type !== 'done' && guard-- > 0);
    assert.equal(ctrl.duskDone, true, 'the turn ends through the dusk pass');
    // Re-entry after done stays done and does not re-shop.
    const gold = state.players[AI].resources.gold;
    state.players[AI].resources.gold = gold + 50000;
    assert.equal(ctrl.next().type, 'done');
    assert.equal(state.players[AI].resources.gold, gold + 50000, 'no second dusk pass on re-entry');
  });
});

// ---------------------------------------------------------------------------
// Peacetime front caravans
// ---------------------------------------------------------------------------

/** The AI's home town plus a synthesized second town `dist` tiles east with a
 *  cleared corridor (same surgery as caravans.test.js), both AI-owned. */
function twoAiTowns(seed, dist = 10) {
  const s = newGame({
    seed,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'castle', isHuman: false, team: 1 },
    ],
  });
  const m = s.map;
  const home = Object.values(s.towns).find((t) => t.owner === AI);
  // Carve toward whichever side has the full `dist` of room, so the two towns
  // really stand `dist` apart (a clamped corridor would collapse the geometry
  // and put a "front" foe inside the rear town's threat radius too).
  const dir = home.x + dist <= m.w - 3 ? 1 : -1;
  const y = home.y, x1 = home.x + dir * dist;
  for (let x = Math.min(home.x, x1); x <= Math.max(home.x, x1); x++) {
    const t = m.tiles[y * m.w + x];
    t.obstacle = null; if (t.terrain === 'water') t.terrain = 'grass';
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
  }
  const east = { id: 'Teast', name: 'Eastwatch', x: x1, y, z: 0, owner: AI, faction: 'castle',
    garrison: [null, null, null, null, null, null, null], buildings: ['villageHall'], available: {} };
  if (m.tiles[y * m.w + x1].objectId) delete m.objects[m.tiles[y * m.w + x1].objectId];
  m.tiles[y * m.w + x1].objectId = null;
  s.towns.Teast = east;
  // Park the human's hero far away so no town reads as threatened.
  const foe = playerHeroes(s, 0)[0];
  foe.x = 0; foe.y = 0; foe.z = 1;
  // No gold and no veterans: the AI can neither hire a ferry hero (who would
  // absorb the garrison) nor recruit — the caravan is the only tool in reach.
  s.players[AI].resources.gold = 0;
  s.players[AI].heroPool = [];
  return { s, home, east, dir };
}

test('peacetime: a rear garrison caravans toward the town nearest the main hero', () => {
  withSetting('aiFrontCaravans', true, () => {
    const { s, home, east, dir } = twoAiTowns(31);
    home.garrison[0] = stack('griffin', 10); // worth well over CARAVAN_MIN_VALUE
    home.visitingHeroId = null;
    // The AI's main hero campaigns out by the far town — Eastwatch is the front.
    const main = playerHeroes(s, AI)[0];
    main.x = east.x + dir; main.y = east.y; main.z = 0; main.inTownId = null;
    const ctrl = new AITurnController(s, AI);
    ctrl.manageTowns();
    assert.ok(s.caravans.some((c) => c.owner === AI && c.toTownId === east.id),
      'the idle rear garrison set out toward the front town');
  });
});

test('the front town itself never dispatches (nothing is strictly closer)', () => {
  withSetting('aiFrontCaravans', true, () => {
    const { s, east, dir } = twoAiTowns(32);
    east.garrison[0] = stack('griffin', 10);
    east.visitingHeroId = null;
    const main = playerHeroes(s, AI)[0];
    main.x = east.x + dir; main.y = east.y; main.z = 0; main.inTownId = null;
    const ctrl = new AITurnController(s, AI);
    ctrl.manageTowns();
    assert.equal(s.caravans.some((c) => c.owner === AI && c.x === east.x && c.y === east.y), false,
      'the front garrison stays put — no destination is closer to the main');
  });
});

test('with aiFrontCaravans off, peacetime garrisons stay home (classic)', () => {
  withSetting('aiFrontCaravans', false, () => {
    const { s, home, east, dir } = twoAiTowns(33);
    home.garrison[0] = stack('griffin', 10);
    home.visitingHeroId = null;
    const main = playerHeroes(s, AI)[0];
    main.x = east.x + dir; main.y = east.y; main.z = 0; main.inTownId = null;
    const ctrl = new AITurnController(s, AI);
    ctrl.manageTowns();
    assert.equal(s.caravans.some((c) => c.owner === AI), false, 'no peacetime caravan when the setting is off');
  });
});

test('a threatened town still outranks the peacetime front (threat branch unchanged)', () => {
  withSetting('aiFrontCaravans', true, () => {
    const { s, home, east, dir } = twoAiTowns(34);
    home.garrison[0] = stack('griffin', 10);
    home.visitingHeroId = null;
    // Main on the FAR side of home from the front: with no threat, home itself
    // would be the front and dispatch nothing. But Eastwatch is menaced — the
    // threat branch must still send the garrison there.
    const main = playerHeroes(s, AI)[0];
    main.x = Math.min(s.map.w - 1, Math.max(0, home.x - dir * 3)); main.y = home.y + 2; main.z = 0; main.inTownId = null;
    const foe = playerHeroes(s, 0)[0];
    foe.x = east.x + dir; foe.y = east.y; foe.z = 0;
    foe.army = [stack('archangel', 30), null, null, null, null, null, null];
    const ctrl = new AITurnController(s, AI);
    ctrl.manageTowns();
    assert.ok(s.caravans.some((c) => c.owner === AI && c.toTownId === east.id),
      'the threatened front still receives the caravan');
  });
});
