/**
 * save-compression.test.js — a save is gzipped before it is stored.
 *
 * Measured on a 40-day World's Edge (144x120) game, which is what motivated this:
 *
 *     raw 2.79 MB  ->  gzip 285 KB   (10.0x smaller)
 *     map 2,558 KB | fog 270 KB | chronicle 11 KB | heroes 2 KB
 *
 * 92% of a save is map tiles. localStorage's ceiling is ~5 MB for the whole
 * origin, so one big game in the quick slot spent over half the budget and the
 * forty named slots session.js advertises were unreachable. `CompressionStream`
 * needs no library and IndexedDB raises the ceiling to hundreds of MB.
 *
 * These tests run under node, which has CompressionStream but NO IndexedDB — so
 * what they exercise is precisely the fallback path (compressed into
 * localStorage), plus the round trip and the migration. The IndexedDB path is
 * the same bytes through a different door.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// A minimal localStorage before the modules under test are imported.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};

const { putPayload, getPayload, delPayload, payloadInfo, putPayloadSync } = await import('../src/game/saveStore.js');
const { startNewGame, saveGame, loadGame, hasSave, savedGameSummary } = await import('../src/game/session.js');
const { serialize } = await import('../src/core/GameState.js');

const fresh = (over = {}) => startNewGame({
  seed: 5,
  players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  ...over,
});

test('a payload round-trips through compression byte for byte', async () => {
  mem.clear();
  const json = JSON.stringify({ hello: 'world', tiles: Array.from({ length: 5000 }, (_, i) => i % 7) });
  assert.equal(await putPayload('k', json), true);
  assert.equal(await getPayload('k'), json, 'what went in came back out unchanged');
});

test('a real save is stored much smaller than its JSON', async () => {
  mem.clear();
  const s = fresh();
  const raw = serialize(s).length;
  await saveGame();
  const info = await payloadInfo('jma3_save_v1');
  assert.ok(info, 'something was stored');
  assert.ok(info.compressed, `stored compressed (got ${JSON.stringify(info)})`);
  // Map tiles are enormously repetitive, so the ratio on a real save is large.
  // Asserting only 2x keeps this a regression test for "compression happened",
  // not a brittle assertion about any particular map's entropy.
  assert.ok(info.bytes * 2 < raw,
    `expected well under half of ${raw} raw bytes, stored ${info.bytes}`);
});

test('a compressed save loads back into a playable game', async () => {
  mem.clear();
  const s = fresh();
  s.day = 61;
  s.players[0].resources.gold = 4242;
  await saveGame();
  const back = await loadGame();
  assert.ok(back, 'the save came back');
  assert.equal(back.day, 61);
  assert.equal(back.players[0].resources.gold, 4242);
  assert.ok(back.map && back.map.w > 0, 'and the map survived the round trip');
});

test('the menu still reads a summary synchronously', async () => {
  // The whole reason metadata is stored separately: scenes call these while
  // drawing and cannot await. They must answer from the small record, without
  // touching the compressed payload at all.
  mem.clear();
  const s = fresh({ kind: 'custom' });
  s.day = 33;
  await saveGame();
  assert.equal(hasSave(), true);
  const sum = savedGameSummary();
  assert.equal(sum.day, 33);
  assert.equal(sum.kind, 'custom');
  assert.ok(sum.mapW > 0 && sum.mapH > 0, 'including the map size the menu prints');
});

test('a save written before compression is still readable, and is migrated on write', async () => {
  // The upgrade path that matters: an existing player has plain JSON sitting in
  // localStorage under the same key. It must load, show on the menu, and quietly
  // become a compressed save the next time the game is written.
  mem.clear();
  const s = fresh();
  s.day = 12;
  await saveGame();          // let startNewGame's own write settle first
  const legacy = serialize(s);
  mem.clear();               // then wipe it: a legacy player has NO metadata record
  mem.set('jma3_save_v1', legacy);            // exactly what the old code wrote
  assert.equal(hasSave(), true, 'the menu finds a legacy save with no metadata record');
  assert.equal(savedGameSummary().day, 12, 'and reads its summary from the save itself');
  const back = await loadGame();
  assert.equal(back.day, 12, 'and it loads');

  await saveGame();
  const info = await payloadInfo('jma3_save_v1');
  assert.ok(info.compressed, 'saving again stores it compressed');
  assert.ok(info.bytes < legacy.length, 'and smaller than the plain form it replaced');
});

test('the synchronous unload path writes something loadable', async () => {
  // beforeunload does not keep the tab alive for a promise, so that path stays
  // synchronous and uncompressed. It must still produce a save that loads.
  mem.clear();
  const s = fresh();
  s.day = 8;
  assert.equal(putPayloadSync('jma3_save_v1', serialize(s)), true);
  assert.equal((await getPayload('jma3_save_v1')).length > 0, true);
  const back = await loadGame();
  assert.equal(back.day, 8, 'an exit-flushed game comes back');
});

test('overlapping saves land in order — the last call wins', async () => {
  // Serialization is synchronous but the write is not, so without a chain a slow
  // earlier save can land after a fast later one and persist the OLDER game.
  mem.clear();
  const s = fresh();
  s.day = 1;
  const first = saveGame();   // snapshots day 1
  s.day = 2;
  const second = saveGame();  // snapshots day 2
  await Promise.all([first, second]);
  assert.equal((await loadGame()).day, 2, 'the later save is the one on disk');
});

test('deleting a payload removes every copy of it', async () => {
  mem.clear();
  await putPayload('k', '{"a":1}');
  await delPayload('k');
  assert.equal(await getPayload('k'), null);
  assert.equal(await payloadInfo('k'), null);
});

test('storage that is absent or blocked reports failure instead of throwing', async () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = undefined;
  assert.equal(await putPayload('k', '{}'), false, 'nowhere to write ⇒ false');
  assert.equal(await getPayload('k'), null, 'nowhere to read ⇒ null');
  assert.equal(putPayloadSync('k', '{}'), false);
  await assert.doesNotReject(delPayload('k'));
  globalThis.localStorage = real;
});
