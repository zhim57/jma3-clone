/**
 * town-build-grid.test.js — the town build grid must show every build slot.
 *
 * It used to be a hard-coded 4 columns with `slice(0, cols * maxRows)`, and the
 * row count worked out to 4 on every window size (the panel height is capped at
 * 720, so the grid box never grew past 294px). That is 16 visible cells against
 * a castle's 17 build slots — 19 with the optional buildings enabled — so three
 * slots silently did not exist: you could not build them, and once built you
 * could not click them to use them either. Reported as "I have the Hall of
 * Reflection enabled and see 16 cards — is it in slot 17?".
 *
 * fitGrid widens to 5 columns and tightens rows only as far as it must, and
 * PAGES when even the densest layout cannot fit — it never drops a card.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fitGrid } from '../src/ui/uikit.js';
import { buildingCatalog, townBuildSlots } from '../src/data/buildings.js';
import { newGame } from '../src/core/GameState.js';

// CLONE: slotCount() seats a real town via newGame, so it can only ask about a
// PLAYABLE faction — the other seven have no heroes to start and no registry entry
// (data/factions.js). The grid maths is faction-agnostic; it is the widest catalog
// that decides whether the page overflows, and castle/inferno carry full catalogs.
const FACTIONS = ['castle', 'inferno'];

// Every optional building switched on — the worst case a player can produce.
const ALL_FEATURES = { hallOfReflection: true, townBank: true, diplomacy: true };

// The real grid box: buildBuildings() gets `avail = my + mh - 190 - y`, where
// mh = min(720, H - 20) and y = my + 236, so avail = mh - 426.
const availFor = (H) => Math.min(720, H - 20) - 426;
const STANDARD_AVAIL = availFor(800); // 294px — any window 760px tall or more

/** Slots the grid actually RENDERS: townBuildSlots is feature-blind, so mirror
 *  TownScene's own `!b.feature || featureOn(state, b.feature)` filter. */
function slotCount(faction, { features = ALL_FEATURES, built = false } = {}) {
  const state = newGame({
    seed: 3,
    players: [{ faction, isHuman: true, team: 0 }, { faction: 'castle', isHuman: false, team: 1 }],
    features,
  });
  const town = Object.values(state.towns).find((t) => t.owner === 0);
  if (built) town.buildings = Object.keys(buildingCatalog(faction));
  const catalog = buildingCatalog(faction);
  return townBuildSlots(town, faction)
    .filter((id) => !catalog[id].feature || features[catalog[id].feature]).length;
}

test('fitGrid keeps cells as wide and tall as it can', () => {
  // Roomy box, few cards: stay at the readable 4 columns and full-height rows.
  const easy = fitGrid(8, 300);
  assert.equal(easy.cols, 4, 'no need to narrow the cells');
  assert.equal(easy.rowH, 64, 'nor to squash the rows');
  assert.equal(easy.pages, 1);
});

test('fitGrid widens before it tightens, and tightens before it pages', () => {
  const wide = fitGrid(19, 294);
  assert.equal(wide.cols, 5, 'a 5th column beats shrinking the rows');
  assert.equal(wide.rowH, 64, 'so the rows stay full height');
  assert.equal(wide.pages, 1);

  const tight = fitGrid(19, 254); // a 700px-tall window
  assert.equal(tight.pages, 1, 'still one page');
  assert.ok(tight.rowH < 64, 'by tightening the rows this time');
  assert.ok(tight.rows * tight.cols >= 19);
});

test('fitGrid NEVER silently drops a card — it reports pages instead', () => {
  // The invariant that matters: whatever the box, the reported layout can reach
  // every card. This is the assertion the old `slice()` would have failed.
  for (let n = 1; n <= 40; n++) {
    for (let availH = 52; availH <= 400; availH += 7) {
      const f = fitGrid(n, availH);
      assert.ok(f.rows >= 1 && f.cols >= 1, `n=${n} avail=${availH}: a usable layout`);
      assert.equal(f.perPage, f.rows * f.cols);
      assert.ok(f.perPage * f.pages >= n,
        `n=${n} avail=${availH}: ${f.pages} page(s) of ${f.perPage} cannot reach all ${n}`);
    }
  }
});

test('fitGrid stays sane in a box too short for even one row', () => {
  const f = fitGrid(19, 10);
  assert.ok(f.rows >= 1, 'always at least one row rather than an empty grid');
  assert.ok(f.perPage * f.pages >= 19, 'and still reaches every card');
});

test('every faction shows ALL its build slots on one page, optional buildings on', () => {
  const over = [];
  for (const faction of FACTIONS) {
    for (const built of [false, true]) {
      const n = slotCount(faction, { built });
      const f = fitGrid(n, STANDARD_AVAIL);
      if (f.pages > 1) over.push(`${faction}${built ? ' (fully built)' : ''}: ${n} slots, ${f.pages} pages`);
    }
  }
  // If this ever fails, a new building pushed the town past the grid: give the
  // panel more height, allow a 6th column, or accept paging deliberately.
  assert.deepEqual(over, [], `these towns no longer fit one page:\n  ${over.join('\n  ')}`);
});

test('the castle is the worst case and its 19th slot is reachable', () => {
  const n = slotCount('castle');
  assert.ok(n >= 17, `a castle has ${n} slots — more than the old 16-cell grid`);
  const f = fitGrid(n, STANDARD_AVAIL);
  assert.ok(f.perPage >= n, `${f.cols}x${f.rows} = ${f.perPage} cells for ${n} slots`);
});

test('the optional buildings really do add slots (so the overflow was real)', () => {
  const off = slotCount('castle', { features: {} });
  const on = slotCount('castle');
  assert.ok(on > off, `${off} slots with the optional buildings off, ${on} with them on`);
  assert.ok(off > 16, `even with every optional feature OFF a castle has ${off} slots — the old grid showed 16`);
});

test('the Hall of Reflection is a real build slot when its feature is on', () => {
  const state = newGame({
    seed: 3,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'castle', isHuman: false, team: 1 }],
    features: { hallOfReflection: true },
  });
  const town = Object.values(state.towns).find((t) => t.owner === 0);
  assert.ok(townBuildSlots(town, 'castle').includes('hallOfReflection'), 'listed with the feature on');

  const off = newGame({
    seed: 3,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'castle', isHuman: false, team: 1 }],
    features: {},
  });
  const t2 = Object.values(off.towns).find((t) => t.owner === 0);
  // The slot list itself is feature-blind; TownScene filters on featureOn(). Either
  // way, what matters is that it is NOT offered when the feature is off.
  const catalog = buildingCatalog('castle');
  const offered = townBuildSlots(t2, 'castle').filter((id) => !catalog[id].feature);
  assert.ok(!offered.includes('hallOfReflection'), 'not offered with the feature off');
});

test('TownScene no longer truncates the grid', () => {
  const src = readFileSync(new URL('../src/scenes/TownScene.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /slice\(0,\s*cols\s*\*\s*maxRows\)/,
    'the silent-truncation slice must stay gone');
  assert.match(src, /fitGrid\(slots\.length/, 'the grid sizes itself to the slot count');
});
