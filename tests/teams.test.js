/**
 * teams.test.js — N-player games and team alliances.
 *
 * newGame accepts a roster of up to four players split across two teams; the
 * generator seeds a town per player, victory is team-based (a team wins when
 * every non-allied player is eliminated), and the AI never targets an ally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerTowns, playerHeroes, tileAt, heroAt, sameTeam } from '../src/core/GameState.js';
import { checkVictory, endTurn, stepHero } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

/** Find an open tile with an open tile directly below it — no obstacle, object, or hero. */
function findOpenPair(s) {
  for (let y = 2; y < s.map.h - 2; y++) {
    for (let x = 2; x < s.map.w - 2; x++) {
      const t = tileAt(s, x, y), nt = tileAt(s, x, y + 1);
      if (t && nt && !t.obstacle && !t.objectId && !nt.obstacle && !nt.objectId
          && !heroAt(s, x, y) && !heroAt(s, x, y + 1)) {
        return { target: { x, y }, from: { x, y: y + 1 } };
      }
    }
  }
  throw new Error('no open pair found');
}

const TWO_V_TWO = [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
  { faction: 'inferno', isHuman: false, team: 1 },
];

test('N-player: four players each get a town + a hero, on their assigned teams', () => {
  const s = newGame({ seed: 3, players: TWO_V_TWO, mapW: 56, mapH: 46 });
  assert.equal(s.players.length, 4);
  assert.deepEqual(s.players.map((p) => p.team), [0, 0, 1, 1]);
  assert.equal(s.players[0].isHuman, true);
  // state.towns also holds the underground's neutral towns; each PLAYER owns
  // exactly one (surface) start town.
  assert.equal(Object.values(s.towns).filter((t) => t.owner >= 0).length, 4, 'a town per player');
  for (const p of s.players) {
    assert.equal(playerTowns(s, p.index).length, 1, `player ${p.index} has a town`);
    assert.equal(playerHeroes(s, p.index).length, 1, `player ${p.index} has a hero`);
  }
});

test('team victory: the game ends only when one whole team is left standing', () => {
  const s = newGame({ seed: 3, players: TWO_V_TWO, mapW: 56, mapH: 46 });
  assert.equal(checkVictory(s), null, 'both teams alive → no winner');

  // Knock out one enemy (team 1) player — the other still holds, no winner yet.
  s.players[2].defeated = true;
  assert.equal(checkVictory(s), null, 'one enemy survives → still no winner');

  // Eliminate the last enemy: team 0 (the human team) wins → winner is team 0.
  s.players[3].defeated = true;
  assert.equal(checkVictory(s), 0, 'human team wins → winner is team 0');
});

test('team victory: an enemy team winning reads as a non-human win', () => {
  const s = newGame({ seed: 5, players: TWO_V_TWO, mapW: 56, mapH: 46 });
  s.players[0].defeated = true;
  s.players[1].defeated = true; // both human-team players out
  assert.equal(checkVictory(s), 1, 'the surviving enemy team (1) wins');
  assert.notEqual(s.winner, 0, 'not a human win');
});

test('AI ally-awareness: allies are never enemies, and vice versa', () => {
  const s = newGame({ seed: 3, players: TWO_V_TWO, mapW: 56, mapH: 46 });
  const ai = new AITurnController(s, 0); // a team-0 player
  assert.equal(ai.isAlly(1), true, 'player 1 (same team) is an ally');
  assert.equal(ai.isEnemy(1), false, 'an ally is not an enemy');
  assert.equal(ai.isEnemy(2), true, 'player 2 (team 1) is an enemy');
  assert.equal(ai.isEnemy(3), true, 'player 3 (team 1) is an enemy');
  assert.equal(ai.isAlly(0), false, 'self is not an ally');
  assert.equal(ai.isEnemy(-1), false, 'neutral is not an enemy');
});

test('sameTeam selector: allies match, enemies and neutral do not', () => {
  const s = newGame({ seed: 3, players: TWO_V_TWO, mapW: 56, mapH: 46 });
  assert.equal(sameTeam(s, 0, 1), true, 'two team-0 players share a team');
  assert.equal(sameTeam(s, 2, 3), true, 'two team-1 players share a team');
  assert.equal(sameTeam(s, 0, 2), false, 'across teams do not');
  assert.equal(sameTeam(s, 0, -1), false, 'neutral is on nobody\'s team');
});

test('team movement: an ally hero blocks (no fight); an enemy hero triggers combat', () => {
  const s = newGame({ seed: 3, players: TWO_V_TWO, mapW: 56, mapH: 46 });
  const mover = playerHeroes(s, 0)[0]; // team 0
  const ally = playerHeroes(s, 1)[0];  // team 0
  const foe = playerHeroes(s, 2)[0];   // team 1
  mover.army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];

  const spot = findOpenPair(s);
  // Ally standing on the target tile: stepping in is blocked, never a battle.
  ally.x = spot.target.x; ally.y = spot.target.y;
  mover.x = spot.from.x; mover.y = spot.from.y; mover.mp = 2000;
  const onAlly = stepHero(s, mover, { x: spot.target.x, y: spot.target.y, cost: 100 });
  assert.equal(onAlly.type, 'blocked', 'an ally hero blocks — no friendly fire');

  // Same tile, now an enemy: stepping in is combat.
  ally.x = -9; ally.y = -9; // park the ally off-map
  foe.x = spot.target.x; foe.y = spot.target.y;
  mover.x = spot.from.x; mover.y = spot.from.y; mover.mp = 2000;
  const onFoe = stepHero(s, mover, { x: spot.target.x, y: spot.target.y, cost: 100 });
  assert.equal(onFoe.type, 'combat', 'an enemy hero is attacked');
  assert.equal(onFoe.context.defender.kind, 'hero');
});

test('team economy: you cannot re-flag a mine an ally already holds (E48)', () => {
  const s = newGame({ seed: 3, players: TWO_V_TWO, mapW: 56, mapH: 46 });
  const hero = playerHeroes(s, 0)[0]; // team 0
  const spot = findOpenPair(s);
  // Clear any monster guard / object adjacent to the mine tile so stepping onto
  // it exercises the mine interaction, not an intercepting guard fight.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const t = tileAt(s, spot.target.x + dx, spot.target.y + dy);
      if (!t) continue;
      if (t.objectId) { delete s.map.objects[t.objectId]; t.objectId = null; }
      t.obstacle = null;
    }
  }
  const id = 'MINE_T';
  s.map.objects[id] = { id, x: spot.target.x, y: spot.target.y, type: 'mine', mineType: 'goldMine', owner: 1 };
  tileAt(s, spot.target.x, spot.target.y).objectId = id;

  // Ally (player 1, same team) owns it: walking over it must not poach it.
  hero.x = spot.from.x; hero.y = spot.from.y; hero.mp = 2000;
  const onAlly = stepHero(s, hero, { x: spot.target.x, y: spot.target.y, cost: 100 });
  assert.notEqual(onAlly.type, 'mineFlagged', 'an ally mine is not flagged');
  assert.equal(s.map.objects[id].owner, 1, 'the ally still owns it');

  // An ENEMY (team 1) mine on the same tile IS flaggable.
  s.map.objects[id].owner = 2;
  hero.x = spot.from.x; hero.y = spot.from.y; hero.mp = 2000;
  const onFoe = stepHero(s, hero, { x: spot.target.x, y: spot.target.y, cost: 100 });
  assert.equal(onFoe.type, 'mineFlagged', 'an enemy mine is flagged');
  assert.equal(s.map.objects[id].owner, 0);
});

test('team movement: an ally town is off-limits, not besieged or captured', () => {
  const s = newGame({ seed: 3, players: TWO_V_TWO, mapW: 56, mapH: 46 });
  const mover = playerHeroes(s, 0)[0]; // team 0
  const allyTown = playerTowns(s, 1)[0]; // team 0's town
  mover.army = [{ creature: 'pikeman', count: 10, hurt: 0 }, null, null, null, null, null, null];
  mover.mp = 2000;
  // Stand just below the ally town and try to step onto it.
  mover.x = allyTown.x; mover.y = allyTown.y + 1;
  const ev = stepHero(s, mover, { x: allyTown.x, y: allyTown.y, cost: 100 });
  assert.equal(ev.type, 'blocked', 'cannot enter or capture an ally town');
  assert.equal(allyTown.owner, 1, 'the ally still owns it');
});

test('N-player: a full 2-team AI round runs and keeps every invariant', () => {
  const allAi = TWO_V_TWO.map((p) => ({ ...p, isHuman: false }));
  const s = newGame({ seed: 9, players: allAi, mapW: 56, mapH: 46 });
  let guard = 60;
  while (s.winner === null && s.day <= 6 && guard-- > 0) {
    const ai = new AITurnController(s, s.currentPlayer);
    let r, g2 = 80;
    do { r = ai.next(); if (r.type === 'combat') ai.autoFight(r.context); } while (r.type !== 'done' && g2-- > 0);
    endTurn(s);
  }
  assert.ok(guard > 0, 'no runaway loop');
  for (const h of Object.values(s.heroes)) {
    assert.ok(h.mp >= 0, 'mp never negative');
    assert.ok(h.army.every((st) => !st || st.count > 0), 'no empty stacks');
  }
  for (const p of s.players) {
    for (const v of Object.values(p.resources)) assert.ok(v >= 0, 'resources never negative');
  }
});
