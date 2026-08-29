/**
 * serialization.test.js — Save/load round-trip fidelity for GameState.
 *
 * The whole point of the plain-object state design is trivial save/load: a
 * deserialized game must be indistinguishable from the original. These tests
 * exercise the real serialize/deserialize and check the three things that are
 * easy to get subtly wrong — RNG stream continuity, fog typing, and id
 * continuity (hero/town keys + the map's nextOid + the uid counter). Run with:
 * npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, serialize, deserialize, uid, nextObjectId, playerHeroes, SAVE_VERSION,
} from '../src/core/GameState.js';
import { endTurn } from '../src/core/actions.js';

const SEED = 12345;

function freshGame() {
  return newGame({ seed: SEED });
}

// ---------------------------------------------------------------------------

test('serialization: round-trip preserves the RNG draw stream', () => {
  const s = freshGame();
  // Advance the gameplay stream so calls > 0 — the round-trip must replay it.
  for (let i = 0; i < 5; i++) s.rng.random();

  const json = serialize(s);
  const s2 = deserialize(json);

  // toJSON captures {seed, calls} without advancing; fromJSON replays them.
  assert.equal(s2.rng.seed, s.rng.seed);
  assert.equal(s2.rng.calls, s.rng.calls);

  // Both are parked at the same position → identical subsequent draws.
  const a = Array.from({ length: 8 }, () => s.rng.random());
  const b = Array.from({ length: 8 }, () => s2.rng.random());
  assert.deepEqual(b, a, 'restored RNG reproduces the same draws');

  // A second independent load from the same bytes yields the identical stream.
  const s3 = deserialize(json);
  const c = Array.from({ length: 8 }, () => s3.rng.random());
  assert.deepEqual(c, a);
});

test('serialization: RNG stores full state and restores it O(1) (no replay needed)', () => {
  const s = freshGame();
  for (let i = 0; i < 2000; i++) s.rng.random(); // a long stream — replay would be costly

  const saved = JSON.parse(serialize(s));
  assert.equal(typeof saved.rng.state, 'number', 'the generator state is persisted');
  assert.equal(saved.rng.calls, s.rng.calls);

  const s2 = deserialize(JSON.stringify(saved));
  const a = Array.from({ length: 8 }, () => s.rng.random());
  const b = Array.from({ length: 8 }, () => s2.rng.random());
  assert.deepEqual(b, a, 'O(1)-restored RNG reproduces the exact same draws');
});

test('serialization: a legacy {seed, calls} RNG (no state) still loads correctly', () => {
  const s = freshGame();
  for (let i = 0; i < 12; i++) s.rng.random();
  const obj = JSON.parse(serialize(s));
  delete obj.rng.state; // simulate an older save that only stored {seed, calls}

  const s2 = deserialize(JSON.stringify(obj));
  const a = Array.from({ length: 6 }, () => s.rng.random());
  const b = Array.from({ length: 6 }, () => s2.rng.random());
  assert.deepEqual(b, a, 'legacy replay path reconstructs the identical stream');
});

test('serialization: save/load is idempotent (round-trip is a fixed point)', () => {
  const s = freshGame();
  endTurn(s); endTurn(s);
  for (let i = 0; i < 7; i++) s.rng.random();
  const j1 = serialize(s);
  const j2 = serialize(deserialize(j1));
  assert.equal(j2, j1, 're-serializing a loaded save yields identical bytes');
});

test('serialization: a pending skill choice survives the round-trip', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  hero.pendingSkillChoices = [{ options: ['logistics', 'offense'] }];
  const s2 = deserialize(serialize(s));
  assert.deepEqual(s2.heroes[hero.id].pendingSkillChoices, hero.pendingSkillChoices,
    'a mid-level-up save keeps its unresolved skill choice');
});

test('serialization: a save from a newer version is refused, not silently loaded', () => {
  const s = freshGame();
  const obj = JSON.parse(serialize(s));
  obj.version = SAVE_VERSION + 1;
  assert.throws(() => deserialize(JSON.stringify(obj)), /newer than this build/,
    'a future-version save is rejected rather than misread');
});

test('serialization: a corrupt or partial save is rejected, not loaded into play', () => {
  assert.throws(() => deserialize('this is not json'), 'non-JSON is rejected');
  assert.throws(() => deserialize('{"version":1,"day":1}'), /Corrupt or incompatible/,
    'a save missing players/heroes/map/rng is rejected');
  // A structurally valid save still loads (guards against over-strict validation).
  const ok = deserialize(serialize(freshGame()));
  assert.ok(ok && ok.day === 1);
});

test('serialization: fog comes back as typed Uint8Array arrays, unchanged', () => {
  const s = freshGame();
  const s2 = deserialize(serialize(s));
  assert.equal(s2.fog.length, s.fog.length);
  for (let i = 0; i < s.fog.length; i++) {
    assert.ok(s2.fog[i] instanceof Uint8Array, 'fog layer is a Uint8Array');
    assert.deepEqual(Array.from(s2.fog[i]), Array.from(s.fog[i]));
  }
});

test('serialization: hero/town ids and their contents survive the load', () => {
  const s = freshGame();
  // Play a couple of turns so day/resources are non-trivial before saving.
  endTurn(s); endTurn(s);

  const json = serialize(s);
  const s2 = deserialize(json);

  assert.equal(s2.day, s.day);
  assert.deepEqual(Object.keys(s2.heroes).sort(), Object.keys(s.heroes).sort());
  assert.deepEqual(Object.keys(s2.towns).sort(), Object.keys(s.towns).sort());

  // A hero's identity and army round-trip intact.
  const h = playerHeroes(s, 0)[0];
  const h2 = s2.heroes[h.id];
  assert.ok(h2, 'hero id maps to the same hero');
  assert.equal(h2.x, h.x);
  assert.equal(h2.y, h.y);
  assert.deepEqual(h2.army, h.army);
});

test('serialization: nextOid continues, and new object ids follow it', () => {
  const s = freshGame();
  const oidBefore = s.map.nextOid;
  const s2 = deserialize(serialize(s));

  assert.equal(s2.map.nextOid, oidBefore, 'map object counter preserved');
  const oid = nextObjectId(s2);
  assert.equal(oid, `O${oidBefore}`, 'next object id continues the sequence');
  assert.equal(s2.map.nextOid, oidBefore + 1, 'and advances the counter');
});

test('serialization: the uid counter is bumped past every saved hero/town id (no collisions)', () => {
  const s = freshGame();
  const json = serialize(s);
  // The counter lives IN the state now (save v3): deserialize restores it and
  // clamps it past every H…/T… id in the save. Map objects (O…/U…) run on
  // their own counter (map.nextOid) — a different namespace — so they are
  // deliberately not part of this bound.
  const s2 = deserialize(json);

  const savedNums = [
    ...Object.keys(s2.heroes),
    ...Object.keys(s2.towns),
  ].map((id) => parseInt(id.slice(1), 10)).filter((n) => !Number.isNaN(n));
  const maxSaved = Math.max(...savedNums);

  const fresh = uid(s2, 'H');
  const freshNum = parseInt(fresh.slice(1), 10);
  assert.ok(freshNum > maxSaved, 'a freshly minted id is past every saved hero/town id');
  assert.ok(!(fresh in s2.heroes), 'new hero id does not collide with a loaded hero');
  assert.ok(!(`T${freshNum}` in s2.towns), 'nor with a loaded town');
});

test('serialization: same-seed games mint identical ids even back-to-back in one process', () => {
  const a = newGame({ seed: 77 });
  const b = newGame({ seed: 77 });
  assert.deepEqual(Object.keys(b.towns), Object.keys(a.towns), 'town ids identical');
  assert.deepEqual(Object.keys(b.heroes), Object.keys(a.heroes), 'hero ids identical');
  assert.equal(serialize(a), serialize(b), 'two same-seed games serialize byte-identically');
});

test('serialization: a v1 save (pre-underground) migrates to a valid single-level game (F51)', () => {
  const s = freshGame();
  const raw = JSON.parse(serialize(s));
  // Strip back to a v1 shape: no underground level, no under-fog, no z stamps,
  // no nextUid — all introduced in v2/v3.
  raw.version = 1;
  delete raw.map.underground;
  delete raw.fogUnder;
  delete raw.nextUid;
  for (const h of Object.values(raw.heroes)) delete h.z;
  for (const t of Object.values(raw.towns)) delete t.z;

  const s2 = deserialize(JSON.stringify(raw));
  assert.equal(s2.version, SAVE_VERSION, 'lifted all the way to the current version');
  assert.equal(s2.map.underground, null, 'a v1 game has no underground level');
  assert.equal(s2.fogUnder.length, s2.players.length, 'one under-fog layer per player');
  for (const h of Object.values(s2.heroes)) assert.equal(h.z, 0, 'every hero pinned to the surface');
  for (const t of Object.values(s2.towns)) assert.equal(t.z, 0, 'every town pinned to the surface');
  assert.equal(typeof s2.nextUid, 'number', 'the id counter is stamped (v3)');
  // Playable: the migrated game round-trips again byte-for-byte.
  assert.equal(serialize(deserialize(serialize(s2))), serialize(s2), 'the migrated save is stable');
});

test('serialization: a v2 save (no nextUid) migrates — counter derived past every id', () => {
  const s = freshGame();
  const raw = JSON.parse(serialize(s));
  raw.version = 2;
  delete raw.nextUid;
  const s2 = deserialize(JSON.stringify(raw));
  assert.equal(s2.version, SAVE_VERSION, 'lifted to v3');
  const maxSaved = Math.max(...[
    ...Object.keys(s2.heroes), ...Object.keys(s2.towns),
  ].map((id) => parseInt(id.slice(1), 10)).filter((n) => !Number.isNaN(n)));
  assert.ok(s2.nextUid > maxSaved, 'migrated counter sits past every saved id');
});
