/**
 * named-saves.test.js — named, dated save slots layered over the two quick slots.
 *
 * A campaign or skirmish can be saved under any title, listed newest-first with
 * its date and a summary, reloaded, and deleted — without disturbing the legacy
 * quick slots that autosave and "Continue" use.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// A minimal localStorage before session.js is imported (node has none).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};

const {
  startNewGame, getState, saveGame, loadGame, hasSave,
  listSaves, saveGameAs, loadSaveById, deleteSave, suggestSaveName, formatSavedAt,
} = await import('../src/game/session.js');

const fresh = (over = {}) => startNewGame({ seed: 5, players: [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
], ...over });

test('a named save is listed with its title, date and a summary', async () => {
  mem.clear();
  const s = fresh();
  s.day = 42;
  s.players[0].resources.gold = 12345;
  const meta = await saveGameAs('Before the siege');
  assert.ok(meta, 'saving returned metadata');
  assert.equal(meta.name, 'Before the siege');
  assert.equal(meta.day, 42);
  assert.equal(meta.gold, 12345);
  assert.ok(meta.heroes >= 1 && meta.towns >= 1, 'counts my heroes and towns');
  assert.ok(!Number.isNaN(new Date(meta.savedAt).getTime()), 'stamped with a real date');

  const list = listSaves();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Before the siege');
});

test('saves list NEWEST FIRST', async () => {
  mem.clear();
  fresh();
  const a = await saveGameAs('oldest');
  // Force a strictly later stamp than the first (same-millisecond writes tie).
  const later = new Date(Date.now() + 60000).toISOString();
  await saveGameAs('newest');
  const raw = JSON.parse(localStorage.getItem('jma3_slots_v1'));
  raw.find((m) => m.name === 'newest').savedAt = later;
  localStorage.setItem('jma3_slots_v1', JSON.stringify(raw));

  const names = listSaves().map((m) => m.name);
  assert.deepEqual(names, ['newest', 'oldest']);
  assert.ok(a.id !== listSaves()[0].id, 'distinct slots');
});

test('loading a named save restores that exact game', async () => {
  mem.clear();
  const s = fresh();
  s.day = 77;
  const { id } = await saveGameAs('day 77');
  s.day = 200; // play on
  const back = await loadSaveById(id);
  assert.equal(back.day, 77, 'the saved day came back');
  assert.equal(getState().day, 77, 'and it is the live session');
});

test('saving under an existing name OVERWRITES that slot, not a duplicate', async () => {
  mem.clear();
  const s = fresh();
  s.day = 10;
  const first = await saveGameAs('My run');
  s.day = 20;
  const second = await saveGameAs('my RUN'); // same title, different case
  assert.equal(second.id, first.id, 'same slot reused');
  assert.equal(listSaves().length, 1, 'no duplicate row');
  assert.equal((await loadSaveById(first.id)).day, 20, 'holds the newer game');
});

test('deleting removes the row and its payload', async () => {
  mem.clear();
  fresh();
  const { id } = await saveGameAs('scratch');
  assert.equal(await deleteSave(id), true);
  assert.equal(listSaves().length, 0);
  assert.equal(await loadSaveById(id), null, 'payload is gone too');
  assert.equal(await deleteSave(id), false, 'deleting twice is a no-op');
});

test('a campaign save records its chapter so the browser can label it', async () => {
  mem.clear();
  const s = fresh();
  s.campaign = { id: 'brokenMarch', scenarioIndex: 2, eventsFired: [] };
  const meta = await saveGameAs('Pact of Bone');
  assert.equal(meta.campaignId, 'brokenMarch');
  assert.equal(meta.scenarioIndex, 2);
  assert.equal(meta.chapterWon, false);
});

test('named saves never disturb the quick slots', async () => {
  mem.clear();
  const s = fresh();
  s.day = 5;
  await saveGame();            // quick slot
  s.day = 99;
  await saveGameAs('a named one');
  assert.equal((await loadGame()).day, 5, 'the quick slot still holds its own game');
  assert.ok(hasSave());
});

test('suggestSaveName always offers something typable', async () => {
  mem.clear();
  const s = fresh();
  s.day = 8;
  assert.match(suggestSaveName(), /Day 8/);
  s.campaign = { id: 'brokenMarch', scenarioIndex: 1 };
  assert.match(suggestSaveName(), /chapter 2/);
  assert.equal(typeof suggestSaveName(null), 'string');
});

test('an empty title falls back to the suggestion instead of saving blank', async () => {
  mem.clear();
  fresh();
  const meta = await saveGameAs('   ');
  assert.ok(meta.name.length > 0, 'never an unnamed row');
});

test('formatSavedAt renders a readable date and survives junk', async () => {
  assert.match(formatSavedAt('2026-08-12T14:03:00Z'), /12 Aug 2026/);
  assert.equal(formatSavedAt(null), 'unknown date');
  assert.equal(formatSavedAt('not a date'), 'unknown date');
});

test('the store is capped — oldest saves are pruned, newest kept', async () => {
  mem.clear();
  const s = fresh();
  for (let i = 0; i < 45; i++) { s.day = i + 1; await saveGameAs(`run ${i}`); }
  const list = listSaves();
  assert.ok(list.length <= 40, `capped at 40 (got ${list.length})`);
  assert.ok(list.some((m) => m.name === 'run 44'), 'the newest survived');
});
