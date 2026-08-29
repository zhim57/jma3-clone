/**
 * battle-seed.test.js — one battle, replayable on its own.
 *
 * The engine was always deterministic given (setup, rng state), but battles borrow the
 * game's single persistent stream rather than owning a seed, so the state a *particular*
 * fight began at existed nowhere: a save holds the stream as it is now, and the only way
 * back to day 130's third battle was to replay the whole game from turn zero. That is the
 * difference between "deterministic" and "reproducible", and it is what a replay format, a
 * battle debugger or a bug report that says "this fight went wrong" actually needs.
 *
 * So `createBattle` stamps the rng state it starts from, `battleResult` carries it out, and
 * `applyCombatResult` — the one choke point every battle passes through — writes it to the
 * chronicle. The properties worth pinning:
 *
 *   TAKEN BEFORE THE FIRST DRAW. Deployment splits and the obstacle field are already
 *   draws, so a seed captured a line too late replays a different battlefield.
 *
 *   ENOUGH TO REBUILD THE FIGHT, after the game's stream has moved on — which is the whole
 *   point, since a save is always "after".
 *
 *   ON THE RECORD, in the JSON and in the text a bug report is pasted from.
 *
 *   AND IT COSTS NOTHING: reading a seed draws no rng, so a seed stays comparable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { combatContext, applyCombatResult } from '../src/core/actions.js';
import { chronicleEntries, chronicleText } from '../src/core/chronicle.js';

const ARMY_A = [
  { creature: 'marksman', count: 40, hurt: 0 },
  { creature: 'griffin', count: 18, hurt: 0 },
];
const ARMY_B = [
  { creature: 'gog', count: 45, hurt: 0 },
  { creature: 'demon', count: 22, hurt: 0 },
];

const cfgOf = (rng) => ({
  rng,
  attacker: { hero: null, army: ARMY_A.map((s) => ({ ...s })), playerIndex: 0 },
  defender: { hero: null, army: ARMY_B.map((s) => ({ ...s })), playerIndex: 1 },
});

/** Everything about a battle that a replay has to reproduce, as one comparable string. */
const digest = (battle, result) => JSON.stringify({
  obstacles: battle.obstacles,
  units: battle.units.map((u) => ({ id: u.id, creature: u.creature, count: u.count, x: u.x, y: u.y })),
  result: { won: result.attackerWon, atk: result.attackerArmy, def: result.defenderArmy, xp: result.xp },
});

// ---- the seed itself --------------------------------------------------------

test('a battle records the rng state it started from, before its first draw', () => {
  const rng = new Rng(9871);
  rng.random(); rng.random();               // the game's stream is mid-flight, as it always is
  const at = { state: rng.a >>> 0, calls: rng.calls };
  const battle = createBattle(cfgOf(rng));
  assert.deepEqual(battle.seed, at,
    'the instant BEFORE deployment and the obstacle field, which are already draws');
  assert.ok(battle.rng.calls > at.calls, 'and createBattle did draw, so the instant matters');
});

test('the seed leaves the engine on the result, which is what reaches the log', () => {
  const rng = new Rng(4242);
  const battle = createBattle(cfgOf(rng));
  const result = autoResolve(battle);
  assert.deepEqual(result.seed, battle.seed);
  assert.ok(Number.isFinite(result.seed.state) && Number.isFinite(result.seed.calls));
});

test('a hand-rolled rng records no seed rather than one that cannot restore', () => {
  // Some callers (tests, previews) pass a bare {random,int,chance} rather than an Rng.
  // A number that does not rebuild the stream would be worse than an honest null.
  const fake = { random: () => 0.5, int: (lo) => lo, chance: () => false, pick: (a) => a[0] };
  assert.equal(createBattle(cfgOf(fake)).seed, null);
});

// ---- what it buys -----------------------------------------------------------

test('the same fight replays exactly from its seed, after the stream has moved on', () => {
  const stream = new Rng(31337);
  for (let i = 0; i < 17; i++) stream.random();   // an arbitrary point in a long game

  const battle = createBattle(cfgOf(stream));
  const first = digest(battle, autoResolve(battle));

  // The rest of the game happens: more battles, more days, hundreds of draws. This is
  // the state a save would hold, and why the seed had to be taken at the time.
  for (let i = 0; i < 500; i++) stream.random();

  const replay = createBattle(cfgOf(Rng.fromJSON({ seed: stream.seed, ...battle.seed })));
  assert.equal(digest(replay, autoResolve(replay)), first,
    'same obstacles, same deployment, same outcome — one battle out of a long game');
});

test('a different seed is a different battle, so the replay is proving something', () => {
  const a = createBattle(cfgOf(new Rng(1)));
  const b = createBattle(cfgOf(new Rng(2)));
  assert.notDeepEqual(a.seed, b.seed);
  assert.notEqual(digest(a, autoResolve(a)), digest(b, autoResolve(b)));
});

// ---- on the record ----------------------------------------------------------

test('the chronicle carries the seed of every battle it writes down', () => {
  const s = newGame({
    seed: 21, mapW: 44, mapH: 38, pveScaling: false,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 40, hurt: 0 }, null, null, null, null, null, null];
  const monster = Object.values(s.map.objects).find((o) => o.type === 'monster');
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: monster.id });

  const battle = createBattle({
    rng: s.rng,
    attacker: { hero, army: hero.army.filter(Boolean), playerIndex: 0 },
    defender: { hero: null, army: ctx.defenderArmy, playerIndex: -1 },
  });
  ctx.battleSeed = battle.seed;
  applyCombatResult(s, ctx, autoResolve(battle));

  const fight = chronicleEntries(s).find((e) => e.t === 'fight');
  assert.ok(fight, 'the battle was written down');
  assert.deepEqual(fight.seed, battle.seed, 'and with the seed that reproduces it');
  assert.match(chronicleText(s), /seed \d+ @\d+ draws/,
    'in the text a bug report is pasted from, not only the JSON');
});

test('an older entry without a seed still renders', () => {
  const s = newGame({
    seed: 21, mapW: 44, mapH: 38,
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  });
  s.chronicle = {
    entries: [{ t: 'fight', d: 1, atk: 'A (one)', def: 'B (two)', won: 'atk', atkBefore: 10, atkAfter: 9, defBefore: 8, defAfter: 0 }],
    dropped: 0,
  };
  const txt = chronicleText(s);
  assert.match(txt, /FIGHT A \(one\) vs B \(two\)/);
  assert.doesNotMatch(txt, /seed \d+ @/, 'no seed claimed for a battle that never recorded one');
});

test('recording a seed draws nothing — a log may never move the stream', () => {
  const rng = new Rng(77);
  const before = rng.calls;
  const battle = createBattle({ rng, attacker: { hero: null, army: [], playerIndex: 0 }, defender: { hero: null, army: [], playerIndex: 1 } });
  const empty = createBattle({ rng: new Rng(77), attacker: { hero: null, army: [], playerIndex: 0 }, defender: { hero: null, army: [], playerIndex: 1 } });
  assert.equal(rng.calls - before, empty.rng.calls,
    'the same battle costs the same draws whether or not its seed is taken');
  assert.ok(battle.seed);
});
