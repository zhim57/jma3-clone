/**
 * fake-indexeddb.js — the smallest IndexedDB that saveStore.js cannot tell from
 * a real one. NOT a test file: the name misses node --test's discovery
 * patterns, so it is only ever imported (same convention as helpers.js).
 *
 * WHY THIS EXISTS. Node has no IndexedDB, so every save test used to exercise
 * the single-store configuration — localStorage only — and that made a whole
 * class of bug structurally invisible: the two-store bugs, where IndexedDB
 * holds one copy of a save and localStorage holds another and the read order
 * between them decides which game the player gets back. The worst of that
 * class shipped and survived 2,352 green tests: the beforeunload exit flush
 * (localStorage-only by necessity) was shadowed by any older IndexedDB record,
 * so on every browser that actually has IndexedDB — all of them — the safety
 * net under the day-boundary autosave never once functioned. A bug that no
 * possible test can reach will recur; this fake exists so the two-store
 * configuration is a test fixture rather than a production-only surprise.
 *
 * WHY HAND-ROLLED AND NOT A LIBRARY. The runtime dependency budget is phaser,
 * full stop, and a dev-dependency shim (fake-indexeddb on npm) models
 * the entire IDB spec — versionchange events, key ranges, cursors, index
 * stores — when saveStore.js uses exactly four operations: open, get, put,
 * delete, all through one object store. Modeling only what the code under test
 * calls keeps the fake auditable in one screen and keeps its failure knobs
 * honest: each knob maps to one real-world failure the code must survive.
 *
 * WHAT IT GETS RIGHT, BECAUSE THE CODE UNDER TEST DEPENDS ON IT:
 *   · Requests complete ASYNCHRONOUSLY (queueMicrotask), never inline — real
 *     IDB never calls onsuccess before .open()/.get() returns, and saveStore
 *     assigns its handlers after the call, so an inline fake would drop every
 *     event on the floor.
 *   · Failure flags are read at COMPLETION time, not call time, so a test can
 *     flip a knob and have it apply to the very next await.
 *   · Stored values are copied on put (real IDB structured-clones), so a test
 *     mutating a Uint8Array it just saved cannot silently corrupt the "disk".
 *
 * THE KNOBS, each a real production failure:
 *   ctl.failOpen    — indexedDB.open errors: private-browsing modes that
 *                     expose the global but refuse the database.
 *   ctl.failPuts    — writes fail, reads still work: quota exhaustion, or a
 *                     versionchange close landing mid-session. THE knob for
 *                     the resurrection bug: an older record stays readable
 *                     while every newer write bounces.
 *   ctl.failDeletes — deletes fail: proves a cleanup that cannot run is
 *                     survivable rather than assumed.
 *   ctl.failAll     — every transaction fails: the database died entirely.
 *
 * ctl.stores is the raw Map-of-Maps behind it, so a test can assert directly
 * what "disk" holds — e.g. that a stale record was actually removed.
 */

/** The one store saveStore.js creates; exported so tests can reach into ctl.stores. */
export const FAKE_IDB_STORE = 'payloads';

export function installFakeIndexedDB(target = globalThis) {
  const stores = new Map();
  const ctl = {
    failOpen: false,
    failPuts: false,
    failDeletes: false,
    failAll: false,
    stores,
    uninstall() { delete target.indexedDB; },
  };

  // A request whose completion runs strictly after the caller's synchronous
  // code, mirroring the event-loop contract real IDB provides.
  function complete(shouldFail, op) {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    queueMicrotask(() => {
      if (ctl.failAll || shouldFail()) {
        req.error = new DOMException('fake IndexedDB failure', 'UnknownError');
        req.onerror?.({ target: req });
        return;
      }
      try {
        req.result = op();
        req.onsuccess?.({ target: req });
      } catch (e) {
        req.error = e;
        req.onerror?.({ target: req });
      }
    });
    return req;
  }

  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(n) { stores.set(n, new Map()); return {}; },
    transaction(name, _mode) {
      const map = stores.get(name);
      if (!map) throw new DOMException(`no object store: ${name}`, 'NotFoundError');
      return {
        onabort: null,
        onerror: null,
        objectStore: () => ({
          get: (k) => complete(() => false, () => (map.has(k) ? map.get(k) : undefined)),
          // Copy on write, as structured clone would: the caller keeps no
          // live reference into the "disk".
          put: (v, k) => complete(() => ctl.failPuts, () => {
            map.set(k, v instanceof Uint8Array ? new Uint8Array(v) : v);
            return k;
          }),
          delete: (k) => complete(() => ctl.failDeletes, () => { map.delete(k); }),
        }),
      };
    },
    close() {},
  };

  target.indexedDB = {
    open(_name, _version) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: undefined };
      queueMicrotask(() => {
        if (ctl.failOpen || ctl.failAll) {
          req.onerror?.({ target: req });
          return;
        }
        req.result = db;
        // First open of a fresh database: the upgrade callback is where
        // saveStore creates its object store, so it must actually run.
        if (stores.size === 0) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };

  return ctl;
}
