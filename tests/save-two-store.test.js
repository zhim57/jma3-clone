/**
 * save-two-store.test.js — the TWO-STORE configuration: IndexedDB and
 * localStorage both holding copies of a save, and the read order between them.
 *
 * Every other save test runs in node's native configuration — a Map-backed
 * localStorage and NO IndexedDB — which is the one configuration in which the
 * bug family this file guards against cannot occur. That is not hypothetical:
 * the beforeunload exit flush writes localStorage (it cannot await IndexedDB),
 * reads used to prefer IndexedDB unconditionally, and so on every browser that
 * has IndexedDB the flush wrote a save no load would ever return. 2,352 tests
 * were green the whole time, because none of them could represent a browser
 * that HAS IndexedDB. This file installs tests/fake-indexeddb.js — a
 * four-operation fake with per-operation failure knobs — precisely so the
 * configurations that matter exist somewhere a regression can fail:
 *
 *   · IDB healthy            — the flush must still win over an older record
 *   · IDB present, puts fail — quota/versionchange: the fallback must win too
 *   · IDB present, deletes also fail — the freshness marker alone must hold
 *   · plus the meta/index bookkeeping above the payload layer, which only
 *     shows its failure modes when SOME writes succeed while others fail
 *
 * The localStorage here has a settable quota and a per-key failure set, so
 * "the payload bounced but the tiny meta record fit" — the exact shape of a
 * real quota failure — is constructible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Storage fakes must exist before the modules under test are imported.
const mem = new Map();
let quota = Infinity;          // setItem throws above this many chars
let failKeys = new Set();      // keys whose setItem always throws
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    if (failKeys.has(k) || String(v).length > quota) {
      throw new DOMException('quota', 'QuotaExceededError');
    }
    mem.set(k, String(v));
  },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};

const { installFakeIndexedDB, FAKE_IDB_STORE } = await import('./fake-indexeddb.js');
const ctl = installFakeIndexedDB();

const {
  putPayload, putPayloadSync, payloadInfo, resetStoreForTests,
} = await import('../src/game/saveStore.js');
const {
  startNewGame, saveGame, loadGame, clearSession, savedGameSummary, hasSave,
  saveGameAs, deleteSave, listSaves, loadSaveById,
} = await import('../src/game/session.js');
const { serialize } = await import('../src/core/GameState.js');

const SAVE_KEY = 'jma3_save_v1';

const fresh = (over = {}) => startNewGame({
  seed: 5,
  players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  ...over,
});

/** Clean slate: both stores empty, all failure knobs off, IDB re-probed. */
function reset() {
  mem.clear();
  ctl.stores.clear();
  ctl.failOpen = ctl.failPuts = ctl.failDeletes = ctl.failAll = false;
  quota = Infinity;
  failKeys = new Set();
  resetStoreForTests();
}

/** What the fake IDB holds under a key, or undefined. */
const idbRecord = (key) => ctl.stores.get(FAKE_IDB_STORE)?.get(key);

test('the exit flush is what loads back, even when IndexedDB holds an older save', async () => {
  // THE headline defect: day 3 autosaved into IDB, the player plays on to day
  // 4 and closes the tab. beforeunload can only reach localStorage. If the
  // read prefers IDB, day 4 silently never happened.
  reset();
  const s = fresh();
  s.day = 3;
  await saveGame();                                  // → IndexedDB
  assert.ok(idbRecord(SAVE_KEY), 'the autosave really is in IndexedDB');
  s.day = 4;
  assert.equal(putPayloadSync(SAVE_KEY, serialize(s)), true, 'the flush lands');
  clearSession();
  const back = await loadGame();
  assert.equal(back?.day, 4, 'the flushed game is the one that returns');
});

test('a later real save supersedes the flush and cleans localStorage back out', async () => {
  reset();
  const s = fresh();
  s.day = 3;
  await saveGame();
  s.day = 4;
  putPayloadSync(SAVE_KEY, serialize(s));            // flush...
  s.day = 5;
  await saveGame();                                  // ...but the session continued
  assert.equal((await loadGame())?.day, 5, 'the newest write wins');
  assert.equal(mem.has(SAVE_KEY), false, 'the localStorage copy is gone');
  assert.equal(mem.has(SAVE_KEY + ':fresh'), false, 'and the marker with it');
  assert.equal((await payloadInfo(SAVE_KEY)).where, 'indexeddb');
});

test('a failed IndexedDB put cannot resurrect the older game it left behind', async () => {
  // Quota exhaustion or a versionchange close: the put fails, the fallback
  // writes localStorage, putPayload reports true — and the read must then
  // return the NEW game, not the older record still sitting in IDB.
  reset();
  const s = fresh();
  s.day = 5;
  await saveGame();                                  // healthy: day 5 in IDB
  ctl.failPuts = true;
  s.day = 6;
  assert.equal(await saveGame(), true, 'the fallback still counts as saved');
  assert.equal((await loadGame())?.day, 6, 'and is what a load produces');
  assert.equal((await payloadInfo(SAVE_KEY)).where, 'localstorage');
  assert.equal(idbRecord(SAVE_KEY), undefined,
    'the stale IndexedDB record was deleted — one copy of a key exists');
});

test('even with IDB deletes ALSO failing, the freshness marker alone holds', async () => {
  // The belt under the belt: if the stale record cannot be removed (the whole
  // database is wedged mid-versionchange, say), the marker still steers the
  // read to the newer copy.
  reset();
  const s = fresh();
  s.day = 7;
  await saveGame();
  ctl.failPuts = true;
  ctl.failDeletes = true;
  s.day = 8;
  assert.equal(await saveGame(), true);
  assert.ok(idbRecord(SAVE_KEY), 'the stale record is genuinely still there');
  assert.equal((await loadGame())?.day, 8, 'and still cannot shadow the newer save');
});

test('when nothing at all is writable, the last good save survives untouched', async () => {
  // The fallback deletes the stale IDB record only AFTER its own write landed.
  // If localStorage refuses too, deleting would destroy the player's last good
  // save in exchange for nothing.
  reset();
  const s = fresh();
  s.day = 9;
  await saveGame();
  ctl.failPuts = true;
  failKeys = new Set([SAVE_KEY]);                    // localStorage refuses the payload too
  s.day = 10;
  assert.equal(await saveGame(), false, 'total failure reports false');
  assert.ok(idbRecord(SAVE_KEY), 'the old record was NOT sacrificed');
  assert.equal((await loadGame())?.day, 9, 'and still loads');
});

test('saves written by the pre-marker build load exactly as before', async () => {
  // Compatibility is by absence: no marker means the old read order. All three
  // historical forms — IDB record, compressed localStorage fallback, plain
  // pre-compression JSON — must load with no marker present.
  reset();
  const s = fresh();
  s.day = 21;
  const json = serialize(s);

  // Form 1: an IndexedDB record (the bytes putPayload writes are unchanged).
  await putPayload(SAVE_KEY, json);
  assert.equal(mem.has(SAVE_KEY + ':fresh'), false, 'a normal save leaves no marker');
  clearSession();
  assert.equal((await loadGame())?.day, 21, 'IDB form loads');

  // Form 2: the compressed localStorage fallback, minus the marker the old
  // build never wrote.
  reset();
  ctl.failAll = true;                                // no IDB ⇒ fallback form
  await putPayload(SAVE_KEY, json);
  mem.delete(SAVE_KEY + ':fresh');                   // mimic the old writer
  assert.match(mem.get(SAVE_KEY), /^gz1:/, 'it is the compressed LS form');
  clearSession();
  assert.equal((await loadGame())?.day, 21, 'compressed LS form loads');

  // Form 3: plain JSON, the pre-compression era.
  reset();
  mem.set(SAVE_KEY, json);
  clearSession();
  assert.equal((await loadGame())?.day, 21, 'plain legacy form loads');
  assert.equal(hasSave(), true, 'and the menu still finds it');
});

test('the menu never advertises a save that a load cannot produce', async () => {
  // The meta record is written optimistically before the payload lands (menus
  // are synchronous and must not blink). When the payload write then fails,
  // the record must be rolled back to describe the save that actually exists
  // — not deleted (the older payload still loads) and not left claiming the
  // day that bounced.
  reset();
  ctl.failAll = true;                                // everything through localStorage
  const s = fresh();
  s.day = 7;
  await saveGame();
  failKeys = new Set([SAVE_KEY]);                    // payload bounces, tiny meta fits
  s.day = 9;
  assert.equal(await saveGame(), false);
  const sum = savedGameSummary();
  clearSession();
  const back = await loadGame();
  assert.equal(back?.day, 7, 'the day-7 save is still the loadable one');
  assert.equal(sum?.day, 7, 'and the menu says so — not day 9');
});

test('the over-quota valve stores the snapshot it was handed, not the live game', async () => {
  // writeSave runs at the end of a promise chain; by then `current` can be a
  // different game. The chronicle-strip retry must re-serialize the SNAPSHOT.
  reset();
  ctl.failAll = true;                                // localStorage only, so quota bites
  const s = fresh();
  s.day = 11;
  // A fat, incompressible chronicle: the full form must bust quota while the
  // stripped form fits, so random digits, which gzip cannot crush.
  s.chronicle = {
    entries: Array.from({ length: 3000 }, (_, i) => ({
      day: 1, text: `e${i}:${Math.random()}${Math.random()}${Math.random()}`,
    })),
  };
  // Find the two stored sizes, then set quota between them.
  await putPayload('probe_full', serialize(s));
  const fullBytes = (await payloadInfo('probe_full')).bytes;
  const strippedJson = JSON.stringify({
    ...JSON.parse(serialize(s)), chronicle: { entries: [], dropped: 3000 },
  });
  await putPayload('probe_stripped', strippedJson);
  const strippedBytes = (await payloadInfo('probe_stripped')).bytes;
  mem.delete('probe_full'); mem.delete('probe_stripped');
  assert.ok(strippedBytes < fullBytes, 'the strip actually shrinks the save');
  quota = Math.floor((fullBytes + strippedBytes) / 2) + 8;

  const p = saveGame();                              // snapshots day 11
  s.day = 999;                                       // the live game moves on mid-write
  assert.equal(await p, true, 'the stripped retry landed');
  quota = Infinity;
  clearSession();
  const back = await loadGame();
  assert.equal(back?.day, 11, 'what landed is the snapshot, not the mutated live game');
  assert.equal(back?.chronicle?.dropped, 3000, 'with the strip recorded in it');
});

test('a named save whose index write fails reports failure and leaves no orphan', async () => {
  reset();
  fresh();
  failKeys = new Set(['jma3_slots_v1']);             // the index refuses writes
  const meta = await saveGameAs('vanishing');
  assert.equal(meta, null, 'no row will ever appear, so this is a failure');
  assert.equal(listSaves().length, 0);
  const orphans = [...mem.keys()].filter((k) => k.startsWith('jma3_slot_v1:'));
  assert.deepEqual(orphans, [], 'the unreachable payload was taken back out');
});

test('overwriting an existing named save keeps it loadable when the index write fails', async () => {
  // The one case where the payload must NOT be rolled back: the old row still
  // points at this id, so deleting the payload would turn a stale-but-loadable
  // row into a phantom. The row's summary is briefly out of date; the game it
  // loads is the newer one, and the next successful save heals the row.
  reset();
  const s = fresh();
  s.day = 10;
  const first = await saveGameAs('My run');
  assert.ok(first);
  failKeys = new Set(['jma3_slots_v1']);
  s.day = 20;
  assert.equal(await saveGameAs('My run'), null, 'still reported as failed');
  failKeys = new Set();
  assert.equal((await loadSaveById(first.id))?.day, 20,
    'but the slot holds the newer game rather than nothing');
  assert.equal(listSaves().length, 1, 'and the row is still there');
});

test('deleting a named save whose index write fails changes nothing at all', async () => {
  // Index first, payload second: if the row cannot be unlisted, delete nothing
  // and return false — the player can retry. The old order left a row that
  // listed forever and loaded never.
  reset();
  const s = fresh();
  s.day = 33;
  const meta = await saveGameAs('doomed');
  failKeys = new Set(['jma3_slots_v1']);
  assert.equal(await deleteSave(meta.id), false, 'reported as not removed');
  failKeys = new Set();
  assert.equal(listSaves().length, 1, 'still listed');
  assert.equal((await loadSaveById(meta.id))?.day, 33, 'and still loads');
});

test('the REAL beforeunload handler leaves payload, marker and meta in agreement', async () => {
  // Everything above drives putPayloadSync directly; this drives the actual
  // handler installExitSave registers, through a stub window — so the
  // handler's own ordering (payload first, meta only if it landed) is what is
  // under test, not a re-enactment of it.
  reset();
  const handlers = {};
  globalThis.window = { addEventListener: (ev, fn) => { handlers[ev] = fn; } };
  globalThis.document = { visibilityState: 'visible' };
  try {
    const { installExitSave } = await import('../src/game/session.js');
    assert.equal(installExitSave(), true, 'the stub window is enough to install');
    assert.ok(handlers.beforeunload, 'the desktop signal is hooked');

    const s = fresh();
    s.day = 30;
    await saveGame();                                // dawn autosave → IDB
    s.day = 31;
    handlers.beforeunload();                         // the tab closes mid-day
    assert.ok(mem.has(SAVE_KEY + ':fresh'), 'the flush left its marker');
    clearSession();
    assert.equal((await loadGame())?.day, 31, 'the flushed day is what loads');
    assert.equal(savedGameSummary()?.day, 31, 'and the menu agrees with it');
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('the Quick Save toast reports the resolved result, not the promise', async () => {
  // saveGame() returns a promise, and a promise is always truthy — so
  // `toast(saveGame() ? … : …)` told the player "Game saved." whatever
  // happened. Pinned at the source because the scene needs a browser to run.
  const src = readFileSync(new URL('../src/scenes/AdvUIScene.js', import.meta.url), 'utf8');
  assert.match(src, /saveGame\(\)\.then\(\(ok\) => this\.toast\(ok \? 'Game saved\.' : 'Save failed!'\)\)/,
    'the toast must await the boolean saveGame resolves');
});
