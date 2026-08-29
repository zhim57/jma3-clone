/**
 * session.js — Holds the live GameState and save/load helpers.
 *
 * Scenes access the state through here (never via scene-to-scene data
 * copies), so there is always exactly one authoritative state object.
 *
 * Two independent QUICK slots so a campaign and a one-off skirmish never clobber
 * each other: the SKIRMISH slot (Continue Saved Game) and the CAMPAIGN slot
 * (Resume Campaign). A game persists to the slot that matches whether it carries
 * `state.campaign`. These are what autosave and the in-game Save button write.
 *
 * On top of those sit NAMED SAVES: any number of slots the player titles, each
 * stamped with the date it was written and a summary (day, gold, heroes, towns,
 * and the campaign chapter when there is one), so a campaign can be branched,
 * archived, or rolled back instead of being overwritten forever. The quick slots
 * are untouched by this layer, so every existing save keeps working.
 *
 * Purely client-side — a single-player save needs no backend. Where the bytes
 * actually go is saveStore.js's problem: gzip into IndexedDB when the browser
 * has both, degrading to plain localStorage when it does not. Every access is
 * wrapped: storage may be absent (headless tests) or blocked (private browsing),
 * and a save must never throw into a scene.
 *
 * SYNC OR ASYNC, AND WHY IT IS SPLIT THAT WAY. Compression and IndexedDB are
 * both asynchronous, so writing and reading a game's bytes now returns a
 * promise. Everything the MENUS need stayed synchronous, because making them
 * await would have rippled through every screen that draws a "Continue" button:
 * each slot keeps a small metadata record in localStorage, so hasSave,
 * savedGameSummary, campaignSaveSummary and listSaves are still plain calls —
 * and are now cheaper than they were, since they no longer parse a 2.79 MB save
 * to read six fields off the front of it.
 */

import { newGame, serialize, deserialize } from '../core/GameState.js';
import { beginEndless } from '../core/endless.js';
import { putPayload, putPayloadSync, getPayload, delPayload, localStore } from './saveStore.js';

const SAVE_KEY = 'jma3_save_v1';
const CAMPAIGN_KEY = 'jma3_campaign_v1';
const SLOT_PREFIX = 'jma3_slot_v1:';   // one entry per named save
const INDEX_KEY = 'jma3_slots_v1';     // the browsable list of their metadata
const META_SUFFIX = ':meta';           // the tiny sync summary beside each quick slot
const MAX_NAMED_SAVES = 40;            // keep the newest; storage is finite

/** localStorage if usable, else null (headless/blocked) — never throws. */
const store = localStore;

let current = null;

export function getState() {
  return current;
}

export function startNewGame(setup) {
  current = newGame(setup);
  // A single-map game started with `endless: true` is realm 1 of a run: winning it
  // offers the next realm, carrying the top heroes and the town legacy. Marked here
  // rather than at the win, because the setup that shaped this realm — map size,
  // roster, victory condition, feature flags — is only fully known at the front
  // door, and reconstructing it from a finished state would be guesswork.
  if (setup && setup.endless) beginEndless(current, setup);
  // Persist IMMEDIATELY. Autosave otherwise waits for the first day to end, and
  // on a big map day one is an hour of exploring, fighting and building — all of
  // it lost if the tab closes before End Turn. Reported as "custom games do not
  // autosave": they always did, just never before the first dawn.
  saveGame();
  return current;
}

/**
 * Install an already-built GameState as the live session — used by the campaign
 * flow to hand the next chapter's state (built by campaign.advanceCampaign) to
 * the scenes, which always read through getState().
 */
export function setState(state) {
  current = state;
  return current;
}

/** The slot a game persists to: campaigns keep their own, distinct from skirmishes. */
function slotKey(state) {
  return state && state.campaign ? CAMPAIGN_KEY : SAVE_KEY;
}

/**
 * The tiny record the menus render from, written beside every quick-slot save.
 *
 * Its whole reason for existing is that the payload is no longer synchronously
 * readable: hasSave() and savedGameSummary() are called while a scene is drawing
 * and cannot await. Keeping six fields in localStorage means the menu stays
 * synchronous AND stops parsing megabytes of map to find the day number.
 */
function metaString(state) {
  return JSON.stringify({
    day: state.day,
    heroes: Object.values(state.heroes || {}).filter((h) => h.owner === 0).length,
    towns: Object.values(state.towns || {}).filter((t) => t.owner === 0).length,
    gold: state.players?.[0]?.resources?.gold ?? 0,
    setupKind: state.setupKind || null,
    mapW: state.map?.w ?? null,
    mapH: state.map?.h ?? null,
    realm: state.endless?.realm ?? null,
    campaign: state.campaign ? { id: state.campaign.id, scenarioIndex: state.campaign.scenarioIndex } : null,
    winner: state.winner ?? null,
  });
}

/** Set (or, with null, remove) a slot's raw meta record. Never throws. */
function setRawMeta(key, str) {
  const ls = store();
  if (!ls) return;
  try {
    if (str == null) ls.removeItem(key + META_SUFFIX);
    else ls.setItem(key + META_SUFFIX, str);
  } catch { /* a menu without a summary is survivable; a throw here is not */ }
}

function writeMeta(key, state) {
  try {
    setRawMeta(key, metaString(state));
  } catch { /* same bargain as above */ }
}

/**
 * Per quick slot: the meta string describing the last payload that actually
 * LANDED — what the meta record must be rolled back to when a later payload
 * write fails. Seeded lazily from storage the first time a slot is saved this
 * session, because at that moment the stored record still describes the last
 * game a load can produce (it was written by a previous, completed session).
 *
 * Why keep this at all instead of just deleting the meta on failure: the older
 * payload is still on disk and still loads, so wiping the record would hide a
 * perfectly resumable game from the menu. And why not simply re-read storage
 * at rollback time: by then the optimistic write below has already replaced
 * it, possibly twice over if saves overlapped — storage holds hopes, this map
 * holds facts.
 */
const lastGoodMeta = new Map();

/**
 * Persist the live game to its quick slot. Asynchronous now — the bytes are
 * gzipped and put in IndexedDB (see saveStore) — so callers that want to report
 * success must await it. Callers that fire and forget still behave as before.
 * The resolved boolean IS the contract: it settles only when the payload has
 * landed (or every store has refused it), so a UI that wants to say "saved"
 * truthfully must await it — the Quick Save toast does.
 *
 * The metadata is written FIRST and synchronously, so a menu drawn a moment
 * later already sees the save even if the payload is still being compressed.
 * That write is OPTIMISTIC, and the chained write below settles the account:
 * on success it re-asserts this save's meta (undoing any rollback an earlier
 * failed save in the chain performed), on failure it restores the meta of the
 * last payload that actually landed. Without that, a failed payload write left
 * the menu advertising "Continue — Day 40" for a game whose load produced day
 * 39 — the record described the write's intent, not its outcome.
 *
 * Writes are CHAINED, and that is not incidental.
 *
 * A save now snapshots the state synchronously but lands some milliseconds
 * later, so two overlapping calls — the dawn autosave and an exit flush, say, or
 * a fast player hitting Save twice — can complete out of order and leave the
 * OLDER game on disk. Serializing them behind one promise makes the last call
 * win, which is the only ordering a player would ever expect. Found by a test
 * that raced startNewGame's immediate save against the next write.
 */
let pendingSave = Promise.resolve(true);

export function saveGame() {
  if (!current) return Promise.resolve(false);
  if (!store() && typeof indexedDB === 'undefined') return Promise.resolve(false);
  const key = slotKey(current);
  // Snapshot NOW, while `current` is the game the caller meant to save. The
  // snapshot is a STRING on purpose: nothing the live game does afterwards can
  // reach into it, so what lands is exactly what was promised.
  const json = serialize(current);
  if (!lastGoodMeta.has(key)) {
    let prev = null;
    const ls = store();
    if (ls) { try { prev = ls.getItem(key + META_SUFFIX); } catch { prev = null; } }
    lastGoodMeta.set(key, prev);
  }
  // Guarded like everything else on this path: serialize() succeeding makes a
  // metaString() throw all but impossible, but "a save never throws into a
  // scene" is a promise, not a probability. A null here flows through confirm
  // and rollback as "no summary", which the menus already survive.
  let metaStr = null;
  try { metaStr = metaString(current); } catch { metaStr = null; }
  setRawMeta(key, metaStr);
  const run = () => writeSave(key, json, metaStr);
  pendingSave = pendingSave.then(run, run);
  return pendingSave;
}

async function writeSave(key, json, metaStr) {
  let ok = await putPayload(key, json);
  if (!ok) {
    // Every store refused it. The chronicle is the one part of a save that is
    // pure diagnosis, so drop the book and keep the realm — but note that this
    // is now a genuine last resort rather than the routine valve it used to be:
    // compression made a World's Edge save 285 KB, and the chronicle it drops
    // was only ever 11 KB of the 2.79 MB problem.
    //
    // Stripped from the SNAPSHOT, not from the live `current`: this runs at the
    // end of a promise chain, and by now `current` can be a different game — a
    // load, a new campaign chapter — whose serialization here would store the
    // wrong realm under this key. The price is re-parsing the snapshot on a
    // path rare enough to warrant a console.warn, and that the live game's
    // chronicle keeps growing (so each over-quota save re-pays the strip);
    // mutating a game this writer cannot identify would be worse.
    try {
      const raw = JSON.parse(json);
      const lost = raw.chronicle?.entries?.length || 0;
      if (lost) {
        raw.chronicle = { entries: [], dropped: (raw.chronicle.dropped || 0) + lost };
        if (await putPayload(key, JSON.stringify(raw))) {
          console.warn(`Save was over quota: dropped ${lost} chronicle entries to fit.`);
          ok = true;
        }
      }
    } catch { /* an unparseable snapshot cannot be salvaged */ }
  }
  if (ok) {
    lastGoodMeta.set(key, metaStr);
    setRawMeta(key, metaStr);
    return true;
  }
  console.warn('Save failed: no writable storage');
  // The optimistic meta up in saveGame described this write's intent; put back
  // the record of what a load will actually produce, which may be "nothing".
  setRawMeta(key, lastGoodMeta.get(key) ?? null);
  return false;
}

/**
 * Save when the player leaves — closing the tab, switching apps, hitting Back.
 *
 * The day-boundary autosave is the checkpoint; this is the safety net under it,
 * so quitting mid-day costs the current move rather than the whole day. Idempotent
 * (installed once) and silent: there is no UI to report to at this point, and a
 * throw here would surface as a browser error on an otherwise clean exit.
 *
 * Both events are registered on purpose. `beforeunload` is the desktop signal;
 * mobile browsers routinely kill a backgrounded tab without ever firing it, and
 * `visibilitychange`→hidden is the one they do send.
 *
 * The two are handled DIFFERENTLY now that saving is asynchronous, and the
 * difference is the whole point. `visibilitychange` fires while the page is
 * still alive, so it gets the real save — compressed, into IndexedDB.
 * `beforeunload` does not keep the tab alive for a promise, so awaiting a gzip
 * stream there would mean the write simply never lands; it takes the
 * synchronous localStorage path instead. That is the pre-compression behaviour
 * — the correct floor for a safety net — but for a while it was a floor with
 * nothing standing on it: reads preferred IndexedDB, this path cannot reach
 * IndexedDB, and so on every browser that has it the flush wrote a save no
 * load would ever return. putPayloadSync now leaves a freshness marker that
 * flips the read order (see saveStore.js), which is what makes the sentence
 * "worst case the exit flush costs what it always cost" true again.
 *
 * Payload first, meta second — the reverse of saveGame. saveGame writes its
 * meta optimistically because its payload lands milliseconds later and the
 * menu must not blink; here the write is synchronous, so there is no gap to
 * paper over and no rollback machinery to invoke: if the payload did not
 * land, the meta simply is not touched, and the menu keeps describing the
 * save that actually exists.
 */
let exitSaveInstalled = false;
export function installExitSave() {
  if (exitSaveInstalled || typeof window === 'undefined' || !window.addEventListener) return false;
  exitSaveInstalled = true;
  window.addEventListener('beforeunload', () => {
    if (!current) return;
    try {
      const key = slotKey(current);
      if (putPayloadSync(key, serialize(current))) writeMeta(key, current);
    } catch { /* leaving anyway */ }
  });
  window.addEventListener('visibilitychange', () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      try { saveGame(); } catch { /* leaving anyway */ }
    }
  });
  return true;
}

/**
 * A slot's metadata, synchronously, from whichever of the two forms is there.
 *
 * The fast path is the small record writeMeta leaves in localStorage. The
 * fallback parses a legacy save — the plain JSON payload that every game written
 * before compression left in localStorage — so an existing player's "Continue"
 * button still appears on the menu, before they have re-saved even once. That
 * fallback is the only place this still parses a whole save, and it stops
 * happening for a given slot the moment it is written again.
 */
function readMeta(key) {
  const ls = store();
  if (!ls) return null;
  try {
    const m = JSON.parse(ls.getItem(key + META_SUFFIX) || 'null');
    if (m && m.day) return m;
  } catch { /* fall through to the legacy form */ }
  try {
    const raw = ls.getItem(key);
    if (!raw || raw.startsWith('gz1:')) return null; // compressed ⇒ meta is authoritative
    const s = JSON.parse(raw);
    if (!s || !s.day) return null;
    return {
      day: s.day,
      heroes: Object.values(s.heroes || {}).filter((h) => h.owner === 0).length,
      towns: Object.values(s.towns || {}).filter((t) => t.owner === 0).length,
      gold: s.players?.[0]?.resources?.gold ?? 0,
      setupKind: s.setupKind || null,
      mapW: s.map?.w ?? null,
      mapH: s.map?.h ?? null,
      realm: s.endless?.realm ?? null,
      campaign: s.campaign ? { id: s.campaign.id, scenarioIndex: s.campaign.scenarioIndex } : null,
      winner: s.winner ?? null,
    };
  } catch {
    return null;
  }
}

export function hasSave() {
  return !!readMeta(SAVE_KEY);
}

export function hasCampaignSave() {
  const m = readMeta(CAMPAIGN_KEY);
  return !!(m && m.campaign);
}

/** The human player's shared at-a-glance stats. */
function baseSummary(m) {
  return { day: m.day, heroes: m.heroes, towns: m.towns, gold: m.gold };
}

/**
 * Lightweight peek at the SKIRMISH save for the menu (parses raw JSON, no full
 * deserialize), or null if there's no (readable) save.
 */
export function savedGameSummary() {
  const m = readMeta(SAVE_KEY);
  if (!m) return null;
  // `kind` lets each front door label its own resume ("your custom game") even
  // though every non-campaign game shares this one slot.
  return {
    ...baseSummary(m),
    kind: m.setupKind || null,
    mapW: m.mapW ?? null,
    mapH: m.mapH ?? null,
    // Which realm of an endless run, so "Resume: your run — realm 4" reads as the
    // thing it is rather than as an anonymous single map.
    realm: m.realm ?? null,
  };
}

/**
 * Peek at the CAMPAIGN save: the base stats plus which campaign/chapter it is
 * and whether that chapter has been WON (so the menu can offer "march on to the
 * next chapter" vs "resume this chapter"). Null if there is no campaign save.
 */
export function campaignSaveSummary() {
  const m = readMeta(CAMPAIGN_KEY);
  if (!m || !m.campaign) return null;
  return {
    ...baseSummary(m),
    campaignId: m.campaign.id,
    scenarioIndex: m.campaign.scenarioIndex,
    chapterWon: m.winner != null,
  };
}

async function loadFrom(key) {
  try {
    const json = await getPayload(key);
    if (!json) return null;
    current = deserialize(json);
    return current;
  } catch (e) {
    console.warn('Load failed:', e);
    return null;
  }
}

export function loadGame() {
  return loadFrom(SAVE_KEY);
}

export function loadCampaign() {
  return loadFrom(CAMPAIGN_KEY);
}

/** Drop the campaign save (a campaign that has been won or lost is not resumable). */
export async function clearCampaignSave() {
  const ls = store();
  if (ls) { try { ls.removeItem(CAMPAIGN_KEY + META_SUFFIX); } catch { /* ignore */ } }
  // The rollback bookkeeping must learn the slot is now empty, or a failed
  // save of the NEXT campaign would "restore" the meta of this deleted one —
  // a Continue button pointing at a payload that no longer exists.
  lastGoodMeta.set(CAMPAIGN_KEY, null);
  await delPayload(CAMPAIGN_KEY);
}

export function clearSession() {
  current = null;
}

// ===========================================================================
// NAMED SAVES — any number of titled, dated slots
// ===========================================================================

/** The stored index of named saves (newest first), or [] when unreadable. */
export function listSaves() {
  const ls = store();
  if (!ls) return [];
  try {
    const raw = JSON.parse(ls.getItem(INDEX_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m) => m && typeof m.id === 'string')
      .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  } catch {
    return [];
  }
}

function writeIndex(list) {
  const ls = store();
  if (!ls) return false;
  try {
    ls.setItem(INDEX_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * The summary shown in the save browser. Campaign chapter details ride along as
 * ids (campaignId / scenarioIndex) so this module stays independent of the
 * campaign data tables — the UI resolves them to titles.
 */
function metaFor(state, name, id, when) {
  return {
    id,
    name,
    savedAt: when,
    day: state.day,
    gold: state.players?.[0]?.resources?.gold ?? 0,
    heroes: Object.values(state.heroes || {}).filter((h) => h.owner === 0).length,
    towns: Object.values(state.towns || {}).filter((t) => t.owner === 0).length,
    campaignId: state.campaign?.id || null,
    scenarioIndex: state.campaign?.scenarioIndex ?? null,
    chapterWon: state.winner != null,
  };
}

/** A default title for the current game, so saving never demands typing. */
export function suggestSaveName(state = current) {
  if (!state) return 'Save';
  if (state.campaign?.id) return `${state.campaign.id} — chapter ${(state.campaign.scenarioIndex ?? 0) + 1}, day ${state.day}`;
  return `Day ${state.day}`;
}

/**
 * Write the live game to a NAMED slot. Saving under a name that already exists
 * overwrites that slot (what a player expects from "save as"), keeping its id so
 * the browser doesn't sprout duplicates. Returns the stored metadata, or null if
 * there is nothing to save / storage is unavailable.
 */
export async function saveGameAs(name) {
  const ls = store();
  if (!current || !ls) return null;
  const title = String(name || '').trim() || suggestSaveName();
  const list = listSaves();
  const existing = list.find((m) => m.name.toLowerCase() === title.toLowerCase());
  const id = existing ? existing.id : `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const meta = metaFor(current, title, id, new Date().toISOString());
  if (!await putPayload(SLOT_PREFIX + id, serialize(current))) {
    console.warn('Named save failed: no writable storage');
    return null;
  }
  // Newest first, drop the oldest beyond the cap (and their payloads). Forty
  // slots was an aspiration on a big map before compression — one World's Edge
  // save was 2.79 MB against an origin budget of about 5 — and is now routine at
  // 285 KB apiece.
  //
  // ORDER: payload, then index, then pruning — arranged so that whichever
  // single write fails, the store is left holding an invisible ORPHAN payload
  // at worst, never a listed row whose payload is gone. A phantom row is a
  // player-facing lie (a save that exists until clicked); an orphan is a few
  // hundred stale KB that the id-reuse rule reclaims if the same title is ever
  // saved again. The index result used to be discarded here, which reported
  // success for a row that never appeared.
  const kept = [meta, ...list.filter((m) => m.id !== id)].slice(0, MAX_NAMED_SAVES);
  if (!writeIndex(kept)) {
    // No row will ever point at the payload just written, so take it back out
    // — but only if this save MINTED the id. When overwriting an existing slot
    // the old row still points here, and deleting would turn a stale-but-
    // loadable row into a phantom.
    if (!existing) await delPayload(SLOT_PREFIX + id);
    console.warn('Named save failed: could not write the save index');
    return null;
  }
  for (const gone of list.filter((m) => !kept.some((k) => k.id === m.id))) {
    await delPayload(SLOT_PREFIX + gone.id);
  }
  return meta;
}

/** Load a named save into the live session. Returns the state, or null. */
export async function loadSaveById(id) {
  if (!id) return null;
  try {
    const json = await getPayload(SLOT_PREFIX + id);
    if (!json) return null;
    current = deserialize(json);
    return current;
  } catch (e) {
    console.warn('Named load failed:', e);
    return null;
  }
}

/** Delete a named save (payload + index entry). Returns true if it was removed. */
export async function deleteSave(id) {
  const ls = store();
  if (!ls || !id) return false;
  const list = listSaves();
  if (!list.some((m) => m.id === id)) return false;
  // Index FIRST: if the row cannot be unlisted, delete nothing and say so —
  // the save is still whole and the player can retry. The old order deleted
  // the payload and then shrugged at a failed index write, leaving a row that
  // listed forever and loaded never. With the row gone first, a failed payload
  // delete costs only an invisible orphan.
  if (!writeIndex(list.filter((m) => m.id !== id))) return false;
  await delPayload(SLOT_PREFIX + id);
  return true;
}

/** Human-readable "when" for a save row: "12 Aug 2026, 14:03". */
export function formatSavedAt(iso) {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown date';
  const day = String(d.getDate()).padStart(2, '0');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${mon} ${d.getFullYear()}, ${hh}:${mm}`;
}
