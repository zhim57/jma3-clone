/**
 * grail-victory.test.js — the Grail as a win condition ("race for the Grail").
 *
 * Standard elimination always applies; a game opted into `victory.grail` ADDS
 * an outright win: the instant a player enshrines the Grail structure at one of
 * their towns, that player's team wins — even with every rival still alive. A
 * plain conquest game ignores the Grail for victory. The AI races for it too.
 *
 * Headless and deterministic (fixed seed, hand-shaped state).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, playerHeroes, playerTowns, serialize, deserialize,
} from '../src/core/GameState.js';
import { deliverGrail, checkVictory, endTurn } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const SEED = 4242;
const AI = 1;

const bigArmy = () => [{ creature: 'archangel', count: 50, hurt: 0 }, null, null, null, null, null, null];

function runTurn(state, playerIndex = AI) {
  const ai = new AITurnController(state, playerIndex);
  let r, guard = 400;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return ai;
}

function clearBox(s, x0, y0, x1, y1) {
  const m = s.map;
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const t = m.tiles[y * m.w + x];
      t.obstacle = null; t.terrain = 'grass';
      if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
    }
  }
}

// ---------------------------------------------------------------------------

test('newGame: conquest is the default; setup.victory.grail opts into the race', () => {
  assert.deepEqual(newGame({ seed: SEED }).victory, { grail: false }, 'default is conquest only');
  assert.deepEqual(newGame({ seed: SEED, victory: { grail: true } }).victory, { grail: true }, 'opt-in honoured');
});

test('conquest game: enshrining the Grail raises the structure but does NOT win', () => {
  const s = newGame({ seed: SEED }); // conquest (default)
  const hero = playerHeroes(s, 0)[0];
  hero.carryingGrail = true;
  const town = playerTowns(s, 0)[0];

  const r = deliverGrail(s, hero, town);
  assert.ok(r.ok && town.grail, 'the structure still rises');
  assert.equal(s.winner, null, 'but a conquest game is not decided by the Grail');
  assert.equal(s.winReason, null);
});

test('race for the Grail: enshrining wins outright, with every rival still alive', () => {
  const s = newGame({ seed: SEED, victory: { grail: true } });
  const hero = playerHeroes(s, 0)[0];
  hero.carryingGrail = true;
  const town = playerTowns(s, 0)[0];
  const rivals = s.players.filter((p) => p.index !== town.owner);
  assert.ok(rivals.every((p) => !p.defeated), 'rivals are alive when the Grail is raised');

  const r = deliverGrail(s, hero, town);
  assert.ok(r.ok, 'the Grail is enshrined');
  assert.equal(s.winner, s.players[town.owner].team ?? town.owner, 'the enshriner\'s team wins');
  assert.equal(s.winReason, 'grail', 'and the game records a Grail victory');
});

test('race for the Grail: the winner is the enshriner\'s TEAM', () => {
  const s = newGame({ seed: SEED, victory: { grail: true } });
  const town = playerTowns(s, 0)[0];
  s.players[town.owner].team = 3; // an unusual team id to prove it is read, not assumed
  const hero = playerHeroes(s, 0)[0];
  hero.carryingGrail = true;

  deliverGrail(s, hero, town);
  assert.equal(s.winner, 3, 'winner is the team, not the player index');
});

test('race for the Grail: a rival AI can win it (the human then loses)', () => {
  const s = newGame({ seed: SEED, victory: { grail: true } });
  const hero = playerHeroes(s, AI)[0];
  hero.army = bigArmy();
  hero.carryingGrail = true;
  const town = playerTowns(s, AI)[0];
  hero.z = town.z ?? 0;
  if (hero.inTownId) { s.towns[hero.inTownId].visitingHeroId = null; hero.inTownId = null; }
  const dir = town.x > 2 ? -1 : 1;
  hero.x = town.x + 2 * dir; hero.y = town.y;
  clearBox(s, town.x, town.y - 1, hero.x, town.y + 1);

  let guard = 6;
  while (guard-- > 0 && s.winner === null) {
    endTurn(s);
    runTurn(s);
    if (s.winner === null) endTurn(s);
  }
  assert.equal(s.winner, s.players[AI].team ?? AI, 'the AI won the realm with the Grail');
  assert.equal(s.winReason, 'grail');
  assert.notEqual(s.winner, s.players[0].team ?? 0, 'which is a loss for the human');
});

test('checkVictory: a Grail win needs BOTH the flag and a standing Grail town', () => {
  const s = newGame({ seed: SEED, victory: { grail: true } });
  s.grailTownId = undefined; // no Grail raised yet
  assert.equal(checkVictory(s), null, 'no Grail town → no Grail win');

  // Raise it, then defeat its owner: a fallen realm cannot claim the prize.
  const town = playerTowns(s, 0)[0];
  town.grail = true; s.grailTownId = town.id;
  s.players[town.owner].defeated = true;
  s.winner = null; s.winReason = null;
  assert.notEqual(checkVictory(s), s.players[town.owner].team ?? town.owner,
    'a defeated owner does not win by a Grail town it no longer holds');
});

test('elimination still works and is tagged as a conquest win', () => {
  const s = newGame({ seed: SEED, victory: { grail: true } }); // even in Grail mode
  // Wipe player 1 off the board entirely.
  for (const h of playerHeroes(s, 1)) delete s.heroes[h.id];
  for (const t of playerTowns(s, 1)) t.owner = 0;
  checkVictory(s);
  assert.equal(s.winner, s.players[0].team ?? 0, 'the last team standing wins');
  assert.equal(s.winReason, 'conquest', 'by conquest, not by Grail');
});

test('the victory config and reason round-trip a save', () => {
  const s = newGame({ seed: SEED, victory: { grail: true } });
  const hero = playerHeroes(s, 0)[0];
  hero.carryingGrail = true;
  deliverGrail(s, hero, playerTowns(s, 0)[0]);
  assert.equal(s.winReason, 'grail');

  const r = deserialize(serialize(s));
  assert.deepEqual(r.victory, { grail: true }, 'the victory mode survives');
  assert.equal(r.winReason, 'grail', 'the win reason survives');
  assert.equal(r.winner, s.winner, 'and the winner survives');
});
