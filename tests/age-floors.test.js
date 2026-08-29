/**
 * age-floors.test.js — the guardrail on how soon an age may end.
 *
 * Reported: "this game finished after I beat up the first rogue band attacking me
 * — can we set up some guardrails so I can play enough time in developing [the]
 * game, in medium developed and a fully developed? I could not finish and try my
 * castle units improvements nor to face some full fledge invasions from enemy
 * hordes."
 *
 * Four claims are pinned here, and they are what make a floor safe to switch on:
 *
 *   1. A floor HOLDS a win, and holds nothing else. The victory is recorded, the
 *      map keeps running, and the crown lands the day the realm is grown.
 *   2. It never holds a DEFEAT, a draw, or a rival's victory.
 *   3. It can always be stepped over — by the player (claimVictoryNow) and by the
 *      calendar (`patience`), so no floor can strand a game that cannot meet it.
 *   4. Without a floor — every game that existed before this one — nothing changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerTowns, featureOn, serialize, deserialize } from '../src/core/GameState.js';
import { checkVictory, claimVictoryNow } from '../src/core/actions.js';
import { ageProgress, ageFloorHeld, ageFloorText, wavesFaced } from '../src/core/ages.js';

const SEED = 4242;

/** You (0) and one rival (1), on their own teams. */
function world(victory = {}) {
  return newGame({
    seed: SEED,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', team: 1 },
    ],
    victory,
  });
}

/** Wipe a realm off the map and let checkVictory settle what it settles. */
function eliminate(state, index) {
  for (const t of Object.values(state.towns)) if (t.owner === index) t.owner = -1;
  for (const h of Object.values(state.heroes)) if (h.owner === index) delete state.heroes[h.id];
  checkVictory(state);
}

/** Raise a floor's whole town requirement in the human's first town. */
function developCapital(state, spec) {
  const town = playerTowns(state, 0)[0];
  const add = (...ids) => { for (const id of ids) if (!town.buildings.includes(id)) town.buildings.push(id); };
  if (spec.hall) add('villageHall', 'townHall', 'cityHall', ...(spec.hall === 'capitol' ? ['capitol'] : []));
  if (spec.fort) add('fort', 'citadel', ...(spec.fort === 'castle' ? ['castle'] : []));
  for (let i = 1; i <= (spec.dwellings || 0); i++) add(`dwelling${i}`);
  for (let i = 1; i <= (spec.upgrades || 0); i++) add(`dwelling${i}u`);
  return town;
}

/** Pretend the realm has weathered `n` foreign waves. */
function faceWaves(state, n) {
  state.invasion = state.invasion || { waveIndex: 0, nextDay: 999, truceUntil: 0, active: 0, history: [], waves: {} };
  for (let i = 0; i < n; i++) {
    state.invasion.history.push({ day: state.day, people: 'horseLords', tier: 'raid', bands: 1 });
  }
}

// ---------------------------------------------------------------------------
// 1. The floor holds a win, and lets it go when the realm is grown
// ---------------------------------------------------------------------------

test('with no floor, a conquest settles the instant it happens (unchanged)', () => {
  const s = world();
  eliminate(s, 1);
  assert.equal(s.winner, 0);
  assert.equal(s.winReason, 'conquest');
  assert.equal(s.pendingWin, undefined);
});

test('a settled-realm floor holds the conquest instead of ending the map', () => {
  const s = world({ ageFloor: 'settled' });
  eliminate(s, 1);
  assert.equal(s.winner, null, 'the map keeps running');
  assert.ok(s.pendingWin, 'the win is recorded');
  assert.equal(s.pendingWin.reason, 'conquest');
  assert.equal(s.pendingWin.since, s.day);
  // And the player is told, in the log and at the next dawn.
  assert.ok(s.log.some((l) => /age is not finished/i.test(l.text)), 'the log says why');
  assert.ok((s.eventToasts || []).some((t) => /crown waits/i.test(t)), 'and so does a toast');
});

test('the held win settles the day the last requirement is met — not a day sooner', () => {
  const spec = CONFIG.AGE_FLOORS.settled;
  const s = world({ ageFloor: 'settled' });
  eliminate(s, 1);
  assert.equal(s.winner, null);

  // One requirement at a time; none of them alone is enough.
  s.day = spec.days;
  checkVictory(s);
  assert.equal(s.winner, null, 'the calendar alone does not settle it');

  developCapital(s, spec);
  checkVictory(s);
  assert.equal(s.winner, null, 'nor a developed capital alone');

  faceWaves(s, spec.waves);
  checkVictory(s);
  assert.equal(s.winner, 0, 'with the last one met, the crown lands');
  assert.equal(s.winReason, 'conquest', 'and it is the win that was held, not a new one');
  assert.equal(s.pendingWin, null);
});

test('the floor announces itself once, not once a turn', () => {
  const s = world({ ageFloor: 'settled' });
  eliminate(s, 1);
  const said = () => s.log.filter((l) => /age is not finished/i.test(l.text)).length;
  assert.equal(said(), 1);
  for (let i = 0; i < 5; i++) { s.day++; checkVictory(s); }
  assert.equal(said(), 1, 'the same held win is not re-announced every day');
});

test('two win conditions true at once announce ONE crown, not one apiece per turn', () => {
  const s = world({ ageFloor: 'settled', kind: 'accumulateGold', goldTarget: 1000 });
  s.players[0].resources.gold = 999_999;
  eliminate(s, 1); // the treasury objective and the conquest are both true now
  const said = () => s.log.filter((l) => /age is not finished/i.test(l.text)).length;
  assert.equal(said(), 1);
  for (let i = 0; i < 4; i++) { s.day++; checkVictory(s); }
  assert.equal(said(), 1, 'the two conditions do not take turns re-announcing');
  assert.ok(s.pendingWin, 'and a crown is still waiting');
});

test('a held win that stops being true stops being pending', () => {
  const s = world({ ageFloor: 'settled' });
  eliminate(s, 1);
  assert.ok(s.pendingWin);
  // The rival is back on the board (the envoys were heard, a town was handed over):
  // the conquest is simply no longer a fact, and the note goes with it.
  s.players[1].defeated = false;
  const town = playerTowns(s, 0)[0];
  town.owner = 1;
  checkVictory(s);
  assert.equal(s.pendingWin, null, 'no crown is owed');
  assert.equal(s.winner, null);
});

// ---------------------------------------------------------------------------
// 2. Nothing but the human's own victory ever waits
// ---------------------------------------------------------------------------

test('a defeat settles under a floor exactly as it does without one', () => {
  const s = world({ ageFloor: 'golden' });
  eliminate(s, 0);            // the HUMAN is wiped out
  assert.equal(s.winner, 1, 'the rival wins immediately');
  assert.equal(s.winReason, 'conquest');
  assert.equal(s.pendingWin ?? null, null);
});

test('mutual annihilation is a draw the same day, floor or no floor', () => {
  const s = world({ ageFloor: 'golden' });
  for (const t of Object.values(s.towns)) t.owner = -1;
  for (const h of Object.values(s.heroes)) delete s.heroes[h.id];
  checkVictory(s);
  assert.equal(s.winner, -1);
  assert.equal(s.winReason, 'draw');
});

// ---------------------------------------------------------------------------
// 3. A guardrail you cannot step over is a cage
// ---------------------------------------------------------------------------

test('the crown can be claimed early, and stays claimable for the next condition', () => {
  const s = world({ ageFloor: 'golden' });
  eliminate(s, 1);
  assert.equal(s.winner, null);
  const res = claimVictoryNow(s);
  assert.equal(res.ok, true);
  assert.equal(s.winner, 0);
  assert.equal(s.winReason, 'conquest');
  assert.equal(s.victory.crownWaived, true, 'the waiver is written into the game');
  assert.equal(ageFloorHeld(s, 0), false, 'and holds nothing afterwards');
});

test('claiming when nothing is waiting is refused, not obeyed', () => {
  const s = world({ ageFloor: 'golden' });
  const res = claimVictoryNow(s);
  assert.equal(res.ok, false);
  assert.equal(s.winner, null);
});

test('patience lifts a floor the realm can no longer meet', () => {
  const spec = CONFIG.AGE_FLOORS.golden;
  const s = world({ ageFloor: 'golden' });
  eliminate(s, 1);
  assert.equal(s.winner, null);
  // Its capital razed, its masons dead: the town requirements can never be met.
  // The calendar is the backstop, and it is the LAST day that still holds.
  s.day = spec.patience - 1;
  checkVictory(s);
  assert.equal(s.winner, null);
  s.day = spec.patience;
  checkVictory(s);
  assert.equal(s.winner, 0, 'the age has run its course; the win settles');
});

// ---------------------------------------------------------------------------
// 4. What the floor measures, and what it says
// ---------------------------------------------------------------------------

test('the seat of power is ONE town, not the whole realm added up', () => {
  const spec = CONFIG.AGE_FLOORS.settled;
  const s = world({ ageFloor: 'settled' });
  s.day = spec.days;
  faceWaves(s, spec.waves);
  const towns = playerTowns(s, 0);
  const second = { ...towns[0], id: 'T99', name: 'Second Seat', buildings: ['villageHall', 'townHall', 'cityHall'] };
  s.towns[second.id] = second;
  // A hall in one town and a citadel in another is two half-built towns.
  towns[0].buildings = ['fort', 'citadel', 'dwelling1', 'dwelling2', 'dwelling3', 'dwelling4', 'dwelling5', 'dwelling1u'];
  assert.equal(ageProgress(s, 0).met, false);
  towns[0].buildings.push('villageHall', 'townHall', 'cityHall');
  assert.equal(ageProgress(s, 0).met, true, 'one town carrying the whole floor is what counts');
});

test('upgraded dwellings are counted apart from the dwellings themselves', () => {
  const s = world({ ageFloor: 'golden' });
  const spec = CONFIG.AGE_FLOORS.golden;
  const town = developCapital(s, { ...spec, upgrades: 0 });
  let prog = ageProgress(s, 0);
  assert.equal(prog.needs.find((n) => n.id === 'dwellings').done, true);
  assert.equal(prog.needs.find((n) => n.id === 'upgrades').done, false, 'the improvements are their own requirement');
  for (let i = 1; i <= spec.upgrades; i++) town.buildings.push(`dwelling${i}u`);
  prog = ageProgress(s, 0);
  assert.equal(prog.needs.find((n) => n.id === 'upgrades').have, spec.upgrades);
  assert.equal(prog.needs.find((n) => n.id === 'dwellings').have, spec.dwellings, 'an upgrade is not also a dwelling');
});

test('the waves counted are the ones that CAME, not the ones that were beaten', () => {
  const s = world({ ageFloor: 'settled' });
  assert.equal(wavesFaced(s), 0);
  faceWaves(s, 2);
  assert.equal(wavesFaced(s), 2);
});

test('a nation ashore counts as a wave weathered — both tiers feed the tally', () => {
  // The heavy tier (invaderRealms) stands the band waves DOWN while a people
  // holds the field, so a tally read off invasion.history alone froze the day the
  // first nation landed: measured, one band wave in 461 days under a golden
  // floor, the requirement met only by the day-448 patience backstop. A nation
  // with camps and commanders is if anything more of a "full fledge invasion"
  // than three stacks of wolf riders — the report's own words for what the floor
  // must let the player face.
  const s = world({ ageFloor: 'golden' });
  faceWaves(s, 1);                                       // one band wave landed…
  (s.invaderPlan ||= { nextDay: 999, waveIndex: 0, history: [] })
    .history.push({ day: s.day, nation: 'theHorde', commanders: 3, total: 90000 }); // …and one nation
  assert.equal(wavesFaced(s), 2, 'one wave per tier, both weathered');
  const need = ageProgress(s, 0).needs.find((n) => n.id === 'waves');
  assert.equal(need.have, 2, 'and the floor reads the same number');
});

test('a floor that counts waves switches the waves on at setup', () => {
  assert.equal(featureOn(world({ ageFloor: 'golden' }), 'invasions'), true);
  assert.equal(featureOn(world(), 'invasions'), false, 'and a game without a floor is untouched');
});

test('the floor reads as a sentence, before and after it is met', () => {
  const s = world({ ageFloor: 'settled' });
  assert.match(ageFloorText(s), /still wanted/i);
  const spec = CONFIG.AGE_FLOORS.settled;
  s.day = spec.days;
  developCapital(s, spec);
  faceWaves(s, spec.waves);
  assert.match(ageFloorText(s), /a win settles now/i);
  assert.equal(ageFloorText(world()), null, 'and says nothing at all without a floor');
});

// ---------------------------------------------------------------------------
// 5. It round-trips a save, and an unknown floor is no floor
// ---------------------------------------------------------------------------

test('the floor and a held win survive a save', () => {
  const s = world({ ageFloor: 'golden' });
  eliminate(s, 1);
  const back = deserialize(serialize(s));
  assert.equal(back.victory.ageFloor, 'golden');
  assert.equal(back.pendingWin.reason, 'conquest');
  assert.equal(back.winner, null);
  assert.equal(ageFloorHeld(back, 0), true);
});

test('a nonsense floor id reads as no floor at all', () => {
  const s = world({ ageFloor: 'the-age-of-nonsense' });
  assert.equal(s.victory.ageFloor, undefined);
  eliminate(s, 1);
  assert.equal(s.winner, 0);
});
