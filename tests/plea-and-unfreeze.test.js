/**
 * plea-and-unfreeze.test.js — the envoys of the conquered, and the frozen map.
 *
 * Reported together, because they were hit together: "I got a victory because I
 * took all towns — can we allow the other opponents to plead and I give them one
 * castle and a vassalage each so they can return? I am stuck and can enter towns,
 * but my heroes cannot move and act and the days do not advance. I was due for
 * the first invasion in 16 days and wish to prepare and see how it would go."
 *
 * Two defects and one feature:
 *
 *   FREEZE — every world action in AdventureScene is gated on `winner !== null`
 *     and returned SILENTLY, while the outcome dialog that is the only exit could
 *     be dismissed by Esc onto no handler at all (showDialog's Esc path fell
 *     through to activate(null): destroy the box, run nothing). Town entry was not
 *     gated, which is exactly the reported "I can enter towns but nothing else".
 *
 *   PLEA — a conquest win is the end of the war, not necessarily the end of the
 *     map. Seating each fallen realm in one of your towns under an oath puts the
 *     board back in play, and the Pax then decides the age by invasions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../src/config.js';
import { newGame, playerTowns, serialize } from '../src/core/GameState.js';
import { pleaOffers } from '../src/core/pacts.js';
import { checkVictory, acceptPleas } from '../src/core/actions.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// CLONE: `features: { vassalage: true }`. Upstream, wouldSeekTerms is unflagged and a
// cornered realm always sues for terms; this clone gates it OFF by default so an AI
// experiment measures a war rather than an alliance (see core/pacts.js). Everything
// below is ABOUT the vassalage/Pax arc, so it switches the flag on explicitly.
// CLONE: five tests are removed from this file — the ones that drive the PAX, the
// endgame in which a conquered world is put back in play and "the age is decided by
// invasions, not conquest". The Pax switches the invasion waves on, and this clone
// stubs the whole invasion engine out (core/invasions.js), so those tests assert on
// machinery that is not here. What remains is the PLEA itself: a beaten realm asking
// to be restored as a vassal, and the freeze/unfreeze around it.
const SEED = 31337;

/** A three-realm game the human has just won by taking every town on the map. */
function conquered(extra = {}) {
  const s = newGame({
    seed: SEED,
    features: { vassalage: true },
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', team: 1 },
      { faction: 'castle', team: 2 },
    ],
    ...extra,
  });
  // Take everything, and remove every rival hero — the exact end state of a
  // "took all towns" win.
  for (const t of Object.values(s.towns)) t.owner = 0;
  for (const h of Object.values(s.heroes)) if (h.owner !== 0) delete s.heroes[h.id];
  checkVictory(s);
  assert.equal(s.winner, 0, 'the setup really is a won game');
  assert.equal(s.winReason, 'conquest');
  return s;
}

// ---------------------------------------------------------------------------
// The plea
// ---------------------------------------------------------------------------

test('the conquered plead, and each is offered one of your towns', () => {
  const s = conquered();
  const offers = pleaOffers(s, 0);
  assert.equal(offers.length, 2, 'both broken realms send envoys');
  const towns = offers.map((o) => o.townId);
  assert.equal(new Set(towns).size, 2, 'no two realms are offered the same town');
  for (const o of offers) {
    assert.equal(s.towns[o.townId].owner, 0, 'you can only give what you hold');
    assert.equal(typeof o.name, 'string');
  }
});

test('a realm is seated in a town of its OWN faction when you hold one', () => {
  const s = conquered();
  const offers = pleaOffers(s, 0);
  for (const o of offers) {
    if (o.theirCapital) {
      assert.equal(s.towns[o.townId].faction, s.players[o.player].faction,
        'their old seat is a town of their own faction');
    }
  }
});

test('the offer never spends your last town', () => {
  const s = conquered();
  // Reduce the human to exactly two towns: only ONE can be given away.
  const mine = playerTowns(s, 0);
  for (const t of mine.slice(2)) t.owner = -1;
  assert.equal(playerTowns(s, 0).length, 2);
  assert.equal(pleaOffers(s, 0).length, 1, 'one town to give means one realm restored');

  for (const t of playerTowns(s, 0).slice(1)) t.owner = -1;
  assert.equal(playerTowns(s, 0).length, 1);
  assert.deepEqual(pleaOffers(s, 0), [], 'your last town is not on the table');
});




test('a wave you can already see is left exactly where it was', () => {
  // The reported situation: "I was due for the first invasion in 16 days and wish
  // to prepare." A player counting down to a wave must never have it pushed away
  // — or pulled forward — by making peace.
  const s = conquered({ features: { invasions: true } });
  s.invasion = s.invasion || {};
  s.day = 41;
  s.invasion.nextDay = 57;         // 16 days out, exactly the reported case
  s.invasion.waveIndex = 0;
  acceptPleas(s, 0);
  assert.equal(s.invasion.nextDay, 57, 'the horizon they were preparing for is untouched');
});

test('a DISTANT first wave is pulled onto the Pax tempo, so the endgame is playable', () => {
  // Once the realms have stopped fighting each other the coast is the whole
  // story, and the ordinary 84-day spacing turns the objective into a wait —
  // measured, five invasions at that cadence lands past day 390.
  const s = conquered({ features: { invasions: true } });
  s.day = 1;
  s.invasion = { waveIndex: 0, nextDay: CONFIG.INVASION_FIRST_DAY, truceUntil: 0, active: 0, lastPeople: null, history: [] };
  acceptPleas(s, 0);
  assert.ok(s.invasion.nextDay <= 1 + CONFIG.PAX_INVASION_PERIOD_DAYS,
    `a ${CONFIG.INVASION_FIRST_DAY}-day wait is pulled in to the Pax period`);
  assert.ok(s.invasion.nextDay > s.day, 'but never onto the doorstep');
  assert.ok(CONFIG.PAX_INVASION_PERIOD_DAYS < CONFIG.INVASION_PERIOD_DAYS,
    'the Pax tempo is genuinely tighter than the ordinary one');
});



test('refusing changes nothing — the win stands', () => {
  const s = conquered();
  const before = serialize(s);
  assert.equal(s.winner, 0);
  // Never called: the dialog's other button simply re-settles.
  checkVictory(s);
  assert.equal(serialize(s), before, 'a refused plea is a no-op');
});

test('acceptPleas refuses cleanly when there is nobody to restore', () => {
  const s = newGame({
    seed: SEED,
    features: { vassalage: true },
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', team: 1 }],
  });
  const res = acceptPleas(s, 0);
  assert.equal(res.ok, false, 'no fallen realms, no restoration');
  assert.deepEqual(res.restored, []);
  assert.equal(s.winner, null, 'and nothing was disturbed');
});


// ---------------------------------------------------------------------------
// The freeze
// ---------------------------------------------------------------------------

test('the outcome dialog is persistent — Esc cannot dismiss it onto nothing', () => {
  const uikit = read('../src/ui/uikit.js');
  // The Esc handler must consult the flag BEFORE falling through to activate(null),
  // which is the path that destroyed the box and ran no handler at all.
  assert.match(uikit, /if \(!isTopmost\(\) \|\| spec\.persistent\) return;/,
    'a persistent dialog refuses Esc');
  assert.match(uikit, /const cancel = spec\.persistent \? null :/,
    'and has no implicit cancel button for Esc to find');

  const ui = read('../src/scenes/AdvUIScene.js');
  const fn = ui.slice(ui.indexOf('  gameOverDialog('), ui.indexOf('\n  pleaDialog('));
  assert.match(fn, /persistent: true/, 'the game-over dialog is one of them');
  assert.match(fn, /this\.gameOverRoot = showDialog\(/, 'and its root is kept, so liveness can be tested');
});

test('a settled game re-raises its dialog instead of swallowing the click', () => {
  const adv = read('../src/scenes/AdventureScene.js');
  // Both gated entry points: the world click and End Turn. Neither may return
  // silently on a settled game — that is the frozen map with no way out.
  assert.match(adv, /onWorldClick\(pointer\) \{\s*\n\s*if \(this\.moving \|\| this\.aiRunning\) return;[\s\S]{0,240}?if \(this\.state\.winner !== null\) \{ this\.checkGameOver\(\); return; \}/);
  assert.match(adv, /onEndTurn\(\) \{\s*\n\s*if \(this\.moving \|\| this\.aiRunning\) return;\s*\n\s*if \(this\.state\.winner !== null\) \{ this\.checkGameOver\(\); return; \}/);
  // And checkGameOver must decide on the dialog's LIVENESS, not a latched boolean.
  assert.match(adv, /if \(this\.gameOverShown && this\.ui\?\.gameOverRoot\?\.scene\) return true;/);
});

test('accepting the pleas clears the view latches too, or the UI stays "over"', () => {
  const adv = read('../src/scenes/AdventureScene.js');
  const start = adv.indexOf('  acceptPleas(pleas, battleTarget = null) {');
  assert.ok(start > 0, 'the scene handler exists');
  const fn = adv.slice(start, adv.indexOf('\n  checkGameOver()'));
  assert.match(fn, /acceptPleas\(s, 0, pleas, \{ battleTarget \}\)/,
    'the engine half does the seating, and carries the chosen watch length');
  assert.match(fn, /this\.gameOverShown = false/, 'the dialog latch is dropped');
  assert.match(fn, /gameOverRoot = null/);
  assert.match(fn, /playMusic\(/, 'the victory bed stops playing over a live map');
  assert.match(fn, /saveGame\(\)/, 'and the resumed game is saved');
  assert.match(fn, /if \(!res\.ok\)[\s\S]{0,200}?checkGameOver\(\)/,
    'a refused restoration must put the outcome dialog back, never leave a frozen map');
});

test('a settled save raises its outcome dialog the moment the map is on screen', () => {
  // A save of an already-won game restores into a world whose every action is
  // gated on `winner !== null`. Nothing used to put the dialog up on load, so
  // such a save opened onto a map that looked simply broken — and the dialog is
  // both the only way out and the only way INTO the plea. uiReady is where the
  // map first has a live HUD, so that is where it belongs.
  const adv = read('../src/scenes/AdventureScene.js');
  const fn = adv.slice(adv.indexOf('  uiReady(ui) {'), adv.indexOf('\n  hudWidth()'));
  assert.match(fn, /if \(this\.state\.winner !== null\) this\.checkGameOver\(\);/,
    'a restored, settled game shows its outcome dialog without being prodded');
});

test('the victory dialog offers the envoys, and the plea dialog offers the counts', () => {
  const ui = read('../src/scenes/AdvUIScene.js');
  const over = ui.slice(ui.indexOf('  gameOverDialog('), ui.indexOf('\n  pleaDialog('));
  assert.match(over, /const pleas = won \? pleaOffers\(getState\(\), 0\) : \[\]/,
    'only a WIN can hear envoys — a defeat has nothing to grant');
  assert.match(over, /Hear their envoys/);

  const plea = ui.slice(ui.indexOf('  pleaDialog(pleas) {'));
  assert.match(plea, /CONFIG\.PAX_BATTLE_CHOICES\.map/,
    'the watch length is the player\'s, so the counts are the buttons');
  assert.match(plea, /this\.adv\.acceptPleas\(pleas, n\)/);
});
