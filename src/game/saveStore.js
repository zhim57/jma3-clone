/**
 * saveStore.js — where a save's BYTES live.
 *
 * Split out of session.js, which owns what a save *means* (slots, titles,
 * summaries) while this owns where the payload is put and how big it is.
 *
 * WHY THIS EXISTS. Measured on a 40-day World's Edge (144x120) game:
 *
 *     raw 2.79 MB  ->  gzip 285 KB   (10.0x smaller)
 *     map 2,558 KB | fog 270 KB | chronicle 11 KB | heroes 2 KB
 *
 * 92% of a save is map tiles, and localStorage's ceiling is about 5 MB for the
 * WHOLE origin. One World's Edge game in the quick slot therefore spent over
 * half the budget before a single named save existed, and forty named slots (the
 * cap session.js advertises) were never reachable on a big map. The old answer
 * to running out was the quota valve in saveGame, which drops the chronicle —
 * all 11 KB of it, 0.4% of the problem, while throwing away the one artifact
 * built for diagnosing what went wrong. It was aimed at the wrong thing.
 *
 * Two web platform features retire this with no library at all:
 *   - `CompressionStream('gzip')` is built into every current browser. 10x.
 *   - IndexedDB raises the ceiling from ~5 MB to hundreds of MB.
 * Either alone would fix it; together the problem is gone — a World's Edge save
 * becomes 285 KB, so even forty of them are a fraction of what one used to cost.
 *
 * THE COST, AND WHY THE SPLIT IS WHERE IT IS. Both features are asynchronous,
 * and everything above this used to be synchronous. Rather than make the whole
 * save layer async, only the PAYLOAD moved: the small metadata records that the
 * menus render from stay in localStorage and stay synchronous, so listing saves,
 * drawing "Continue" and reading a summary never became a promise. Only actually
 * writing or reading a game's bytes awaits.
 *
 * TWO STORES MEANS RECENCY MUST BE EXPLICIT. Once a payload could live in
 * either store, "which copy is newer" became a real question — and for a while
 * it was answered by accident: reads preferred IndexedDB unconditionally,
 * which shadowed the one writer that can only reach localStorage (the
 * beforeunload exit flush) behind whatever older record IndexedDB held. On
 * every browser that has IndexedDB, the flush wrote a save no read would ever
 * return. The fix considered first was stamping every payload with a counter
 * and comparing on read; rejected because it changes both stored formats, adds
 * a migration, and makes every read pay for a race only one writer can cause.
 * What this module does instead is keep ONE COPY of a key wherever possible —
 * a successful IndexedDB write deletes the localStorage copy, a successful
 * localStorage fallback deletes the IndexedDB copy — and, for the synchronous
 * path that cannot await a delete, leave a `<key>:fresh` marker telling the
 * next read to try localStorage first. Absent marker = the old read order, so
 * every save written before the marker existed loads exactly as before.
 *
 * NOTHING HERE THROWS. IndexedDB is absent in headless tests, blocked in some
 * private-browsing modes, and can fail mid-transaction; CompressionStream is
 * missing on older engines. Every path degrades to plain localStorage, which is
 * exactly the old behaviour, and a save that cannot be written reports false
 * rather than exploding into a scene.
 */

const DB_NAME = 'jma3';
const DB_VERSION = 1;
const STORE = 'payloads';

/** Marks a localStorage value as gzip bytes rather than JSON text (see toLatin1). */
const GZIP_PREFIX = 'gz1:';

/**
 * `<key>:fresh` — "the localStorage copy of this key is the newest write".
 *
 * Set by the ONE writer that cannot clean up after itself: putPayloadSync,
 * which runs inside beforeunload and so cannot await the delete that would
 * remove a stale IndexedDB record. Cleared at exactly the two points the
 * localStorage copy itself is removed (a successful IndexedDB write, and
 * delPayload), so the marker cannot outlive the copy it vouches for — and even
 * a marker orphaned by outside interference (devtools, another tab clearing
 * selectively) only changes which store is TRIED first; a missing or unreadable
 * localStorage copy still falls through to IndexedDB. The value is a timestamp
 * for the benefit of anyone debugging storage by hand; only presence matters.
 */
const FRESH_SUFFIX = ':fresh';

// ---------------------------------------------------------------------------
// Capability probes — every one of these may be absent or throw on access.
// ---------------------------------------------------------------------------

/** localStorage if usable, else null (headless, or blocked in private mode). */
export function localStore() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function canCompress() {
  try {
    return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'
      && typeof Response !== 'undefined';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// gzip, via the platform
// ---------------------------------------------------------------------------

/** Text -> gzip bytes. Rejects nothing: callers treat a throw as "no compression". */
async function gzip(text) {
  const stream = new Response(text).body.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gzip bytes -> text. */
async function gunzip(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * Bytes <-> a string localStorage will hold losslessly.
 *
 * Only used by the localStorage FALLBACK, never by IndexedDB (which stores the
 * Uint8Array directly). localStorage stores UTF-16 strings, so a byte written as
 * a code point above 0x7F would be re-encoded on the way out and the gzip stream
 * would no longer decompress. One code unit per byte keeps it exact — and even
 * paying UTF-16's two bytes per unit, gzip still wins by ~5x on a big map.
 */
function toLatin1(bytes) {
  let out = '';
  // Chunked: String.fromCharCode(...bytes) on a 285 KB array blows the argument
  // limit and throws RangeError.
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

function fromLatin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// IndexedDB — a tiny promise wrapper. Resolves null instead of rejecting.
// ---------------------------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        } catch { /* the error handler below resolves null */ }
      };
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
    return undefined;
  });
  return dbPromise;
}

/**
 * Run one request against the store. Resolves `{ ok, value }` — never a bare
 * value, because the two failure-ish outcomes must not be confused: a `get` on a
 * missing key succeeds with `undefined`, while a transaction that could not run
 * fails. Collapsing those made payloadInfo report a phantom record for a key
 * that had just been deleted, which a browser check caught and no node test
 * could have, since node has no IndexedDB at all.
 */
function idbRun(mode, fn) {
  return openDb().then((db) => {
    if (!db) return { ok: false, value: undefined };
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        const fail = () => resolve({ ok: false, value: undefined });
        tx.onabort = fail;
        tx.onerror = fail;
        req.onerror = fail;
        req.onsuccess = () => resolve({ ok: true, value: req.result });
      } catch {
        resolve({ ok: false, value: undefined });
      }
    });
  }).catch(() => ({ ok: false, value: undefined }));
}

/** The stored bytes for a key, or null when absent or unreadable. */
function idbGet(key) {
  return idbRun('readonly', (s) => s.get(key)).then((r) => (r.ok && r.value != null ? r.value : null));
}

// ---------------------------------------------------------------------------
// The payload API
// ---------------------------------------------------------------------------

/**
 * Write a save payload. Compressed into IndexedDB when both are available,
 * otherwise compressed into localStorage, otherwise plain text into
 * localStorage — which is byte-for-byte what this module replaced.
 *
 * Returns true if the bytes landed somewhere they can be read back from —
 * "read back" meaning by getPayload, not merely in principle: whichever store
 * took the write, the OTHER store's copy of the key is removed, so a later
 * read cannot resurrect an older game from underneath this one. That delete
 * used to run only on the IndexedDB→localStorage cleanup; the reverse case —
 * the IndexedDB put failing (quota, a versionchange close, private mode) while
 * an older record survives in there — reported success and then loaded the old
 * game. Now the fallback removes the stale record too, and only AFTER its own
 * write landed, so a total failure never destroys the last good copy; if even
 * the delete fails, the freshness marker putPayloadSync leaves still steers
 * the read to the newer copy.
 */
export async function putPayload(key, json) {
  let packed = null;
  if (canCompress()) {
    try {
      packed = await gzip(json);
    } catch {
      packed = null; // fall through to plain text
    }
  }
  if (packed && (await idbRun('readwrite', (s) => s.put(packed, key))).ok) {
    // The payload now lives in IndexedDB. Drop any localStorage copy so the
    // origin's 5 MB is not still being spent on a stale duplicate — and the
    // freshness marker with it, since the copy it vouched for is gone.
    const ls = localStore();
    if (ls) {
      try { ls.removeItem(key); } catch { /* ignore */ }
      try { ls.removeItem(key + FRESH_SUFFIX); } catch { /* ignore */ }
    }
    return true;
  }
  // A database that EXISTS refusing a write is an anomaly worth a line in the
  // console (quota, private mode, a versionchange close) — unlike the routine
  // degradations around it: no IndexedDB at all and no CompressionStream are
  // normal on headless runs and old engines, and warning there would print on
  // every save of every test.
  if (packed && await openDb()) {
    console.warn('Save: IndexedDB refused the write; falling back to localStorage.');
  }
  const ok = putPayloadSync(key, json, packed);
  if (ok) {
    // Restore the one-copy invariant from the other side: the fallback copy in
    // localStorage is now the newest, so any IndexedDB record is stale. Deleted
    // only after the write above succeeded — when NOTHING is writable, the old
    // record is the player's last good save and must be left standing.
    await idbRun('readwrite', (s) => s.delete(key));
  }
  return ok;
}

/**
 * The synchronous write, for the one caller that cannot await: the page-unload
 * flush. `beforeunload` does not keep the tab alive for a promise, so an async
 * save started there may never land — this path is the safety net under it and
 * is deliberately plain localStorage.
 *
 * `packed` is an optional already-compressed form (putPayload passes what it
 * has); compression itself cannot be done synchronously.
 *
 * A successful write leaves the `<key>:fresh` marker, because this path cannot
 * do what putPayload's success branch does — delete the other store's copy —
 * and without SOME signal the next read would prefer whatever older record
 * IndexedDB holds, making the write pointless on precisely the browsers it
 * exists for. The marker is written second: a payload without a marker
 * degrades to the pre-marker read order, but a marker without a payload would
 * be a lie (a harmless one — reads fall through — but still not worth writing
 * first). If the payload fits and the ~15-byte marker somehow does not, the
 * write still counts as landed: it is readable today, and shadowable only if
 * an older IndexedDB record also exists.
 */
export function putPayloadSync(key, json, packed = null) {
  const ls = localStore();
  if (!ls) return false;
  let wrote = false;
  if (packed) {
    try {
      ls.setItem(key, GZIP_PREFIX + toLatin1(packed));
      wrote = true;
    } catch { /* over quota even compressed — try the plain form below */ }
  }
  if (!wrote) {
    try {
      ls.setItem(key, json);
    } catch {
      return false;
    }
  }
  try { ls.setItem(key + FRESH_SUFFIX, String(Date.now())); } catch { /* see above */ }
  return true;
}

/** Is the localStorage copy of `key` marked as the newest write? */
function localIsFresh(key) {
  const ls = localStore();
  if (!ls) return false;
  try {
    return ls.getItem(key + FRESH_SUFFIX) != null;
  } catch {
    return false;
  }
}

/** The localStorage form of a payload, decompressed to text, or null. */
async function readLocalPayload(key) {
  const ls = localStore();
  if (!ls) return null;
  let raw = null;
  try {
    raw = ls.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  if (raw.startsWith(GZIP_PREFIX)) {
    try {
      return await gunzip(fromLatin1(raw.slice(GZIP_PREFIX.length)));
    } catch {
      return null;
    }
  }
  return raw; // legacy: plain JSON, exactly as saves were written before
}

/**
 * Read a save payload back, or null.
 *
 * Order matters, and the freshness marker is what decides it. Unmarked — every
 * save written by putPayload, and every save that predates this module — the
 * order is the migration: IndexedDB first (where new saves go), then
 * localStorage, which holds both the compressed fallback form and the plain
 * JSON of the pre-compression era. An existing player's game is found
 * unchanged and moves into IndexedDB the next time it is written. MARKED, the
 * order flips: the marker means the localStorage copy was written by the
 * synchronous path — the exit flush — which could not remove the IndexedDB
 * record it superseded, so reading IndexedDB first would hand back the older
 * game and silently discard the player's last moments of play. Either way both
 * stores are consulted before giving up: a marked-but-unreadable localStorage
 * copy still falls through to IndexedDB, because an older game beats no game.
 */
export async function getPayload(key) {
  const fresh = localIsFresh(key);
  if (fresh) {
    const text = await readLocalPayload(key);
    if (text != null) return text;
  }
  const fromDb = await idbGet(key);
  if (fromDb) {
    try {
      return await gunzip(fromDb);
    } catch { /* corrupt or not actually gzip — try localStorage below */ }
  }
  return fresh ? null : readLocalPayload(key);
}

/** Remove a payload from wherever it lives, and its freshness marker. Never throws. */
export async function delPayload(key) {
  await idbRun('readwrite', (s) => s.delete(key));
  const ls = localStore();
  if (ls) {
    try { ls.removeItem(key); } catch { /* ignore */ }
    try { ls.removeItem(key + FRESH_SUFFIX); } catch { /* ignore */ }
  }
}

/**
 * What a payload costs, for diagnostics and tests: the stored size in bytes and
 * where it ended up. Returns null when there is nothing stored under the key.
 *
 * Follows getPayload's read order exactly — freshness marker and all — so
 * `where` answers the question a diagnostic actually asks: "where would a load
 * come from", not "which store happens to contain something".
 */
export async function payloadInfo(key) {
  const fresh = localIsFresh(key);
  if (fresh) {
    const local = localPayloadInfo(key);
    if (local) return local;
  }
  const fromDb = await idbGet(key);
  if (fromDb) return { where: 'indexeddb', bytes: fromDb.byteLength ?? fromDb.length ?? 0, compressed: true };
  return fresh ? null : localPayloadInfo(key);
}

function localPayloadInfo(key) {
  const ls = localStore();
  if (!ls) return null;
  let raw = null;
  try { raw = ls.getItem(key); } catch { return null; }
  if (!raw) return null;
  const compressed = raw.startsWith(GZIP_PREFIX);
  return {
    where: 'localstorage',
    bytes: compressed ? raw.length - GZIP_PREFIX.length : raw.length,
    compressed,
  };
}

/** Test seam: forget the cached IndexedDB handle so a suite can re-probe. */
export function resetStoreForTests() {
  dbPromise = null;
}
