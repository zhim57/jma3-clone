/**
 * guard-prize.test.js — beating the guard IS taking the prize.
 *
 * A guard stack names what it protects (`obj.guards`) and stands BESIDE it, not on
 * it. So winning the fight used to leave the mine unflagged and the artifact lying
 * on the ground: you had to step onto the tile afterwards, which usually meant next
 * turn. Reported as "if we stop on a mine to carry a battle for the mine, to get the
 * mine after the battle — not to have to move and return, as it often happens with
 * structures and towers, artifacts and obelisks now".
 *
 * The prize is claimed WITHOUT moving the hero, which is the detail worth pinning:
 * walking it onto the tile would spend movement it never spent and re-run that
 * tile's own interaction — the bug that yanked a hero standing on a portal through
 * a teleporter it never asked to use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, levelObjects } from '../src/core/GameState.js';
import { combatContext, applyCombatResult } from '../src/core/actions.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

/** A world with guarded prizes, and a hero strong enough to take them. */
function guarded(wantType) {
  const s = newGame({
    seed: 4242, mapW: 60, mapH: 52,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const objs = levelObjects(s, 0);
  const guard = Object.values(objs)
    .find((o) => o.type === 'monster' && o.guards && objs[o.guards]?.type === wantType);
  if (!guard) return null;
  const prize = objs[guard.guards];
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 200, hurt: 0 }, null, null, null, null, null, null];
  hero.x = guard.x - 1; hero.y = guard.y; hero.z = 0;
  return { s, guard, prize, hero };
}

function fight({ s, guard, hero }) {
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: guard.id });
  const b = createBattle({
    rng: new Rng(4), terrain: 'grass',
    attacker: { hero, army: hero.army.filter(Boolean), playerIndex: 0 },
    defender: { hero: null, army: ctx.defenderArmy, playerIndex: -1 },
    humanSide: 0,
  });
  const result = autoResolve(b);
  return { result, events: applyCombatResult(s, ctx, result) };
}

test('a guard stands BESIDE what it protects — which is why a second move was needed', () => {
  const g = guarded('mine');
  assert.ok(g, 'fixture: this map guards a mine');
  const sameTile = g.guard.x === g.prize.x && g.guard.y === g.prize.y;
  assert.equal(sameTile, false, 'the guard is adjacent, so killing it leaves the hero off the prize');
});

test('winning flags the guarded mine, with the hero still standing where it fought', () => {
  const g = guarded('mine');
  const at = { x: g.hero.x, y: g.hero.y };
  assert.notEqual(g.prize.owner, 0, 'fixture: the mine is not already yours');
  const { result } = fight(g);
  assert.equal(result.attackerWon, true, 'fixture: the guard falls');
  assert.equal(levelObjects(g.s, 0)[g.prize.id].owner, 0, 'the mine is yours now');
  assert.deepEqual({ x: g.hero.x, y: g.hero.y }, at,
    'and the hero never moved — no movement spent, no tile re-entered');
});

test('…the guarded artifact is picked up', () => {
  const g = guarded('artifact');
  assert.ok(g, 'fixture: this map guards an artifact');
  const { events } = fight(g);
  assert.equal(levelObjects(g.s, 0)[g.prize.id], undefined, 'taken off the map');
  const it = events.find((e) => e.type === 'interact');
  assert.equal(it?.event?.type, 'artifact');
});

test('…and the guarded structure is visited', () => {
  const g = guarded('booster');
  assert.ok(g, 'fixture: this map guards a structure');
  const { events } = fight(g);
  const it = events.find((e) => e.type === 'interact');
  assert.equal(it?.event?.type, 'visited', 'the tower/well/fort gives its benefit');
});

test('a stat booster names the stat on the RESULT, not only in its prose', () => {
  // The map plays a distinct sound for a permanent +1 ("we have one for collecting
  // gold"). Reading that out of an English sentence would break the first time the
  // sentence was reworded, so the result carries the field.
  const s = newGame({
    seed: 4242, mapW: 60, mapH: 52,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const objs = levelObjects(s, 0);
  const STATS = ['attack', 'defense', 'power', 'knowledge'];
  const statObj = Object.values(objs).find((o) => o.type === 'booster' && STATS.includes(o.boosterType));
  assert.ok(statObj, 'fixture: this map has a stat booster');
  const hero = playerHeroes(s, 0)[0];
  const before = hero.stats[statObj.boosterType];

  // applyBooster is reached through interactWithObject, which the combat path and
  // the walk path both use — assert through the same door the game uses.
  const guard = Object.values(objs).find((o) => o.type === 'monster' && o.guards === statObj.id);
  if (guard) {
    hero.army = [{ creature: 'archangel', count: 200, hurt: 0 }, null, null, null, null, null, null];
    hero.x = guard.x - 1; hero.y = guard.y; hero.z = 0;
    const { events } = fight({ s, guard, hero });
    const it = events.find((e) => e.type === 'interact');
    assert.equal(it?.event?.statGain, statObj.boosterType, 'the gained stat is named');
    assert.equal(hero.stats[statObj.boosterType], before + 1, 'and it really went up');
  }
});

test('a spent site names no stat gain — a reward chime for nothing is worse than silence', () => {
  const g = guarded('booster');
  const { events } = fight(g);
  const it = events.find((e) => e.type === 'interact');
  if (it?.event?.noBenefit) {
    assert.ok(!it.event.statGain, 'nothing was gained, so nothing is announced');
  }
});
