/**
 * site-respawn-reachable.test.js — the reoccupation rule actually reaches the
 * player.
 *
 * The rule itself was right (site-respawn.test.js pins it) and the vaults still
 * did not come back. Two things stood between the rule and the game:
 *
 *   1. A game snapshots its feature flags at New Game, and `siteRespawn` shipped
 *      OFF before it was turned ON two days later. featureOn() lets an explicit
 *      `false` beat the engine default — correctly, that is what a Settings
 *      toggle is for — so every save begun in that window carried a `false`
 *      nothing could ever lift. Those games were never going to reload a vault,
 *      whatever any later build said. Same story one layer up: the settings store
 *      persists the whole object the first time any preference is touched, so a
 *      player who had opened Settings had `siteRespawn: false` frozen into
 *      localStorage and every NEW game inherited it too.
 *
 *   2. Even where it fired, the map did not show it: a map sprite is built once
 *      and afterwards only nudged (a flag retinted, a count relabelled), so a
 *      reoccupied Pandora's Box or Dwarven Treasury went on drawing the greyed
 *      husk of the emptied one — and a reload you cannot see has not happened.
 *
 * This file covers both, plus the "on by default" claim end to end from a
 * plundered bank to a live one four weeks later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { newGame, playerHeroes, featureOn, serialize, deserialize, SAVE_VERSION } from '../src/core/GameState.js';
import { endTurn, applyCombatResult, stepHero } from '../src/core/actions.js';
import { CREATURE_BANKS } from '../src/data/creatureBanks.js';
import { rollPandoraReward } from '../src/data/pandora.js';
import { CONFIG } from '../src/config.js';

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, ...data };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}
function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    const t = m.tiles[y * m.w + x];
    t.obstacle = null; t.terrain = 'grass';
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
  }
}
const win = (hero) => ({ attackerWon: true, attackerArmy: hero.army.filter(Boolean).map((st) => ({ ...st })), defenderArmy: [], xp: 500 });
const weeks = (s, n) => { for (let i = 0; i < n * CONFIG.DAYS_PER_WEEK * s.players.length; i++) endTurn(s); };

/** Plunder a bank the way the game does: step onto it, win the fight. */
function plunderBank(s, at = { x: 22, y: 20 }) {
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, at.x, at.y);
  const bank = putObj(s, at.x, at.y, {
    type: 'creatureBank', bankType: 'dwarvenTreasury', looted: false,
    guards: CREATURE_BANKS.dwarvenTreasury.guards.map((g) => ({ ...g })),
  });
  hero.x = bank.x - 1; hero.y = bank.y; hero.z = 0; hero.mp = 20000;
  applyCombatResult(s, stepHero(s, hero, { x: bank.x, y: bank.y, cost: 100 }).context, win(hero));
  return bank;
}

// ---------------------------------------------------------------------------
// 1. The rule is reachable from a real game
// ---------------------------------------------------------------------------

test('a game started with no features block reoccupies its vaults', () => {
  const s = newGame({ seed: 31 });
  assert.equal(featureOn(s, 'siteRespawn'), true, 'ON by default in the engine');
  const bank = plunderBank(s);
  assert.equal(bank.looted, true);
  assert.ok(bank.respawnAt > s.day, 'the clock is stamped when the vault is emptied');
  weeks(s, CONFIG.SITE_RESPAWN_WEEKS + 2);
  assert.equal(bank.looted, false, 'new tenants have moved in');
});

test('a save that froze siteRespawn:false before the default flipped is unstuck on load', () => {
  // Exactly the shape of a game begun in the window where the feature shipped
  // off: an explicit false in the snapshot, and a save version that predates
  // the fix. The migration clears the flag so the engine default applies.
  const s = newGame({ seed: 31, features: { siteRespawn: false } });
  assert.equal(featureOn(s, 'siteRespawn'), false, 'off while the stale flag stands');

  const stale = JSON.parse(serialize(s));
  stale.version = 3;                       // written by the build that had it off
  const loaded = deserialize(JSON.stringify(stale));
  assert.equal(featureOn(loaded, 'siteRespawn'), true, 'the stuck flag is lifted on load');
  assert.equal(loaded.version, SAVE_VERSION);

  const bank = plunderBank(loaded);
  weeks(loaded, CONFIG.SITE_RESPAWN_WEEKS + 2);
  assert.equal(bank.looted, false, 'and the vaults reload for the rest of that game');
});

test('a CURRENT save that says false means false — the migration lands once, not forever', () => {
  // Turning the rule off from here on writes a v4 save, and loading one must
  // honour the choice rather than re-enabling it at every load.
  const s = newGame({ seed: 31, features: { siteRespawn: false } });
  const loaded = deserialize(serialize(s));
  assert.equal(loaded.version, SAVE_VERSION);
  assert.equal(featureOn(loaded, 'siteRespawn'), false, 'a deliberate opt-out survives');

  const bank = plunderBank(loaded);
  assert.equal(bank.respawnAt, undefined, 'nothing stamped');
  weeks(loaded, CONFIG.SITE_RESPAWN_WEEKS + 2);
  assert.equal(bank.looted, true, 'and nothing reloads');
});

test('an explicit true is left exactly as it is by the migration', () => {
  const s = newGame({ seed: 31, features: { siteRespawn: true } });
  const stale = JSON.parse(serialize(s));
  stale.version = 3;
  const loaded = deserialize(JSON.stringify(stale));
  assert.equal(loaded.features.siteRespawn, true);
  assert.equal(featureOn(loaded, 'siteRespawn'), true);
});

test('a Pandora\'s Box reloads with fresh contents, not the husk of the old one', () => {
  const s = newGame({ seed: 77 });
  const hero = playerHeroes(s, 0)[0];
  clearBlock(s, 26, 20);
  const box = putObj(s, 26, 20, { type: 'pandora', looted: false, reward: rollPandoraReward(s.rng), guards: [] });
  hero.x = box.x - 1; hero.y = box.y; hero.z = 0; hero.mp = 20000;
  stepHero(s, hero, { x: box.x, y: box.y, cost: 100 });
  assert.equal(box.looted, true, 'opened');

  weeks(s, CONFIG.SITE_RESPAWN_WEEKS + 2);
  assert.equal(box.looted, false, 'a box stands on that tile again');
  assert.ok(box.reward, 'with a reward of its own');
  assert.ok(Array.isArray(box.guards), 'and its own guard');
});

// ---------------------------------------------------------------------------
// 2. The map is told about it
// ---------------------------------------------------------------------------
//
// Phaser scenes cannot be instantiated headlessly (see scene-methods.test.js),
// so the view half is pinned the way this suite pins the rest of the view: over
// the source, as a wiring contract.

const SCENE = readFileSync(new URL('../src/scenes/AdventureScene.js', import.meta.url), 'utf8');

test('a map sprite records what it was drawn from, and refreshWorld rebuilds when that moves', () => {
  assert.match(SCENE, /function objectLook\(obj\)/,
    'the appearance signature must exist — without it nothing can notice a vault has reloaded');
  assert.match(SCENE, /c\.lookKey = objectLook\(obj\)/,
    'spawnObjectSprite must stamp the sprite with what it drew');
  assert.match(SCENE, /spr\.lookKey !== look/,
    'refreshWorld must compare the stamp against the object\'s current look');
});

test('every object type whose art reads mutable state has a look signature', () => {
  // A type drawn from `looted`/`done`/`owner` and MISSING from objectLook is the
  // exact bug this file exists for: the state changes and the picture does not.
  const look = SCENE.slice(SCENE.indexOf('function objectLook(obj)'));
  const body = look.slice(0, look.indexOf('\n}\n'));
  for (const t of ['creatureBank', 'pandora', 'dwelling']) {
    assert.ok(body.includes(`case '${t}':`), `objectLook does not cover "${t}"`);
  }
  // A reload can rotate a bank's tenants, so the sprite key itself must be part
  // of the signature — a Dwarven Treasury that comes back as a Dragon Utopia is
  // a different picture, not merely an undimmed one.
  assert.match(body, /obj\.bankType/, 'a bank\'s signature must include its type, which a reload rerolls');
  assert.match(body, /obj\.looted/, 'a vault\'s signature must include whether it is emptied');
});
