/**
 * victory.test.js — Non-elimination victory conditions: capture-a-town,
 * survive-to-day-N, amass-gold — each an OPT-IN objective that wins before
 * (and in addition to) standard elimination. Engine only, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns } from '../src/core/GameState.js';
import { checkVictory, victoryObjectiveText } from '../src/core/actions.js';
import { signPact } from '../src/core/pacts.js';

const humanTeam = (s) => s.players.find((p) => p.isHuman).team;

test('captureTown: a target town is chosen (enemy start on a 1v1), and taking it wins', () => {
  const s = newGame({ seed: 3, victory: { kind: 'captureTown' } });
  assert.equal(s.victory.kind, 'captureTown');
  assert.ok(s.victory.targetTownId, 'a concrete target town was flagged');
  const target = s.towns[s.victory.targetTownId];
  assert.ok(target && target.objective === true, 'the target town is marked as the objective');
  const hIdx = s.players.findIndex((p) => p.isHuman);
  assert.notEqual(target.owner, hIdx, 'the target is not a town the human already owns');
  checkVictory(s);
  assert.equal(s.winner, null, 'no winner while the objective is unmet');

  // Seize the target town → the human's team wins by objective, not elimination.
  target.owner = hIdx;
  checkVictory(s);
  assert.equal(s.winner, humanTeam(s));
  assert.equal(s.winReason, 'captureTown');
});

test('captureTown prefers a NEUTRAL hold when the map has one', () => {
  // A big map seats neutral towns; the objective should race for one of those.
  const s = newGame({ seed: 11, mapW: 56, mapH: 46, victory: { kind: 'captureTown' } });
  const target = s.towns[s.victory.targetTownId];
  assert.ok(target, 'a target exists');
  const neutrals = playerTownsNeutral(s);
  if (neutrals.length) assert.equal(target.owner, -1, 'a neutral hold was chosen as the race objective');
});
function playerTownsNeutral(s) { return Object.values(s.towns).filter((t) => t.owner < 0 && (t.z ?? 0) === 0); }

test('surviveN: the human wins by outlasting the deadline, not before', () => {
  const s = newGame({ seed: 5, victory: { kind: 'surviveN', surviveDays: 10 } });
  assert.equal(s.victory.surviveDays, 10);
  s.day = 9;
  checkVictory(s);
  assert.equal(s.winner, null, 'not yet — the deadline has not arrived');
  s.day = 10;
  checkVictory(s);
  assert.equal(s.winner, humanTeam(s), 'reaching the deadline alive wins');
  assert.equal(s.winReason, 'survive');
});

test('accumulateGold: the first team to amass the target wins', () => {
  const s = newGame({ seed: 6, victory: { kind: 'accumulateGold', goldTarget: 20000 } });
  assert.equal(s.victory.goldTarget, 20000);
  checkVictory(s);
  assert.equal(s.winner, null, 'nobody is rich enough yet');
  const hIdx = s.players.findIndex((p) => p.isHuman);
  s.players[hIdx].resources.gold = 25000;
  checkVictory(s);
  assert.equal(s.winner, humanTeam(s));
  assert.equal(s.winReason, 'gold');
});

test('objective parameters are clamped to a winnable range', () => {
  const a = newGame({ seed: 7, victory: { kind: 'surviveN', surviveDays: 2 } });
  assert.equal(a.victory.surviveDays, 7, 'survive floor');
  const b = newGame({ seed: 7, victory: { kind: 'accumulateGold', goldTarget: 5 } });
  assert.equal(b.victory.goldTarget, 1000, 'gold floor');
});

test('regression: plain conquest still wins by elimination', () => {
  const s = newGame({ seed: 8 }); // no special objective
  assert.equal(s.victory.kind, undefined);
  // Wipe the enemy (team 1): remove their towns + heroes, then settle.
  const hTeam = humanTeam(s);
  for (const p of s.players) {
    if (p.team === hTeam) continue;
    for (const t of playerTowns(s, p.index)) t.owner = -1;
    for (const h of playerHeroes(s, p.index)) delete s.heroes[h.id];
  }
  checkVictory(s);
  assert.equal(s.winner, hTeam);
  assert.equal(s.winReason, 'conquest');
});

test('regression: the Grail race still wins on enshrinement', () => {
  const s = newGame({ seed: 9, victory: { grail: true } });
  assert.equal(s.victory.grail, true);
  const hIdx = s.players.findIndex((p) => p.isHuman);
  const town = playerTowns(s, hIdx)[0];
  s.grailTownId = town.id; // pretend the Grail structure was raised here
  checkVictory(s);
  assert.equal(s.winner, humanTeam(s));
  assert.equal(s.winReason, 'grail');
});

test('victoryObjectiveText describes each objective', () => {
  assert.match(victoryObjectiveText({ victory: { kind: 'surviveN', surviveDays: 84 } }), /Survive to day 84/);
  assert.match(victoryObjectiveText({ victory: { kind: 'accumulateGold', goldTarget: 50000 } }), /Amass 50,000 gold/);
  assert.match(victoryObjectiveText({ victory: { grail: true } }), /Grail/);
  assert.match(victoryObjectiveText({ victory: {} }), /Defeat all enemies/);
  const s = newGame({ seed: 3, victory: { kind: 'captureTown' } });
  assert.match(victoryObjectiveText(s), /Capture /);
});

test('acquireArtifact: a placed artifact is targeted, and holding it wins', () => {
  const s = newGame({ seed: 12, victory: { kind: 'acquireArtifact' } });
  assert.equal(s.victory.kind, 'acquireArtifact', 'the map seats artifacts to target');
  assert.ok(s.victory.targetArtifact, 'a concrete target artifact was flagged');
  // The flagged map object matches the target id.
  const flagged = Object.values(s.map.objects).find((o) => o.type === 'artifact' && o.objective);
  assert.ok(flagged && flagged.artifact === s.victory.targetArtifact, 'the target artifact object is marked');
  checkVictory(s);
  assert.equal(s.winner, null, 'no win before the artifact is held');

  // Put the target in a human hero's backpack → the objective completes.
  const hIdx = s.players.findIndex((p) => p.isHuman);
  playerHeroes(s, hIdx)[0].backpack.push(s.victory.targetArtifact);
  checkVictory(s);
  assert.equal(s.winner, humanTeam(s));
  assert.equal(s.winReason, 'acquireArtifact');
});

test('acquireArtifact also counts an EQUIPPED copy', () => {
  const s = newGame({ seed: 13, victory: { kind: 'acquireArtifact' } });
  const hIdx = s.players.findIndex((p) => p.isHuman);
  playerHeroes(s, hIdx)[0].equipment.weapon = s.victory.targetArtifact;
  checkVictory(s);
  assert.equal(s.winReason, 'acquireArtifact');
});

test('defeatHero: an enemy champion is targeted, and its defeat wins', () => {
  const s = newGame({ seed: 14, victory: { kind: 'defeatHero' } });
  assert.equal(s.victory.kind, 'defeatHero');
  assert.ok(s.victory.targetHeroId, 'a concrete enemy hero was targeted');
  const target = s.heroes[s.victory.targetHeroId];
  assert.ok(target && target.objective === true, 'the target hero is marked as the objective');
  assert.notEqual(target.owner, s.players.findIndex((p) => p.isHuman), 'the target is an ENEMY hero');
  checkVictory(s);
  assert.equal(s.winner, null, 'no win while the champion still lives');

  // A genuine DEFEAT stamps victory.targetHeroDown at the defeat site
  // (heroLeavesWorld) — mere absence from state.heroes is NOT enough, because a
  // retreat/surrender also leaves the field (see tests/hero-lifecycle.test.js
  // for the full battle-path coverage of both outcomes).
  delete s.heroes[s.victory.targetHeroId];
  checkVictory(s);
  assert.equal(s.winner, null, 'absence alone (e.g. a retreat) does not complete the hunt');
  s.victory.targetHeroDown = true;
  checkVictory(s);
  assert.equal(s.winner, humanTeam(s));
  assert.equal(s.winReason, 'defeatHero');
});

test('victoryObjectiveText names the concrete artifact and champion', () => {
  const a = newGame({ seed: 15, victory: { kind: 'acquireArtifact' } });
  assert.match(victoryObjectiveText(a), /^Acquire the .+/);
  const h = newGame({ seed: 16, victory: { kind: 'defeatHero' } });
  const name = h.heroes[h.victory.targetHeroId].name;
  assert.equal(victoryObjectiveText(h), `Defeat ${name}`);
});

test('victory descriptor round-trips through newGame as plain data (save-safe)', () => {
  const s = newGame({ seed: 4, victory: { kind: 'surviveN', surviveDays: 50 } });
  const clone = JSON.parse(JSON.stringify(s.victory));
  assert.deepEqual(clone, s.victory);
});

// ---------------------------------------------------------------------------
// An oath is not an acquisition: possession objectives read SOVEREIGN teams.
//
// signPact rewrites the vassal's `team` to the suzerain's, so any objective that
// resolved "my team" off the raw field was met by a signature: verified at
// runtime, accumulateGold, flagMines and captureTown all flipped from null to
// winner the moment the pact was signed, with no coin, mine or town changing
// hands — and an oath can be thrown off any week, which would leave a settled
// win standing on property that just rode away. The possession branches now go
// through sovereignTeamOf, exactly like teamTownCount and checkVictory's
// conquest test. repelInvasions is the deliberate exception — a CONTRIBUTION
// counter, pinned per fighting team in tests/pax-and-endgame.test.js.
// ---------------------------------------------------------------------------

test('signing a pact does not win accumulateGold with the vassal\'s treasury', () => {
  const s = newGame({ seed: 21, victory: { kind: 'accumulateGold', goldTarget: 50000 } });
  const hIdx = s.players.findIndex((p) => p.isHuman);
  const rival = s.players.find((p) => !p.isHuman);
  s.players[hIdx].resources.gold = 1000;
  rival.resources.gold = 60000;
  signPact(s, hIdx, rival.index);
  checkVictory(s);
  assert.equal(s.winner, null, 'their gold is theirs — only the tribute share is yours');
  s.players[hIdx].resources.gold = 50000;
  checkVictory(s);
  assert.equal(s.winReason, 'gold', 'your own treasury still settles it');
});

test('a vassal holding the target town or artifact does not complete the objective', () => {
  const t = newGame({ seed: 22, victory: { kind: 'captureTown' } });
  const hIdx = t.players.findIndex((p) => p.isHuman);
  const rival = t.players.find((p) => !p.isHuman);
  t.towns[t.victory.targetTownId].owner = rival.index;
  signPact(t, hIdx, rival.index);
  checkVictory(t);
  assert.equal(t.winner, null, 'the target town flies a sworn banner, not yours');

  const a = newGame({ seed: 23, victory: { kind: 'acquireArtifact' } });
  const ha = a.players.findIndex((p) => p.isHuman);
  const ra = a.players.find((p) => !p.isHuman);
  playerHeroes(a, ra.index)[0].backpack.push(a.victory.targetArtifact);
  signPact(a, ha, ra.index);
  checkVictory(a);
  assert.equal(a.winner, null, 'an artifact in a vassal\'s saddlebag rides away with them');
});

test('flagMines stays open while a vassal holds one of the mines', () => {
  const s = newGame({ seed: 24, victory: { kind: 'flagMines' } });
  const hIdx = s.players.findIndex((p) => p.isHuman);
  const rival = s.players.find((p) => !p.isHuman);
  // The generator seeds mines on both levels; inject a two-mine world so the
  // division of ownership is the whole story (victory-flag-mines.test.js idiom).
  if (s.map.underground) s.map.underground.objects = {};
  s.map.objects = {
    M1: { id: 'M1', type: 'mine', mineType: 'goldMine', x: 5, y: 5, owner: hIdx },
    M2: { id: 'M2', type: 'mine', mineType: 'oreMine', x: 6, y: 5, owner: rival.index },
  };
  signPact(s, hIdx, rival.index);
  checkVictory(s);
  assert.equal(s.winner, null, 'one mine under a sworn flag keeps the objective open');
  s.map.objects.M2.owner = hIdx;
  checkVictory(s);
  assert.equal(s.winReason, 'mines', 'flag it yourself and the realm\'s wealth is yours');
});
