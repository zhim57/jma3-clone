/**
 * guild-upgrade.test.js — commissioning the next Mage Guild level from inside it.
 *
 * Asked for: "the Mage Guild levels 1/2/3/4 should be enterable, with the spells
 * studied and read inside, and an upgrade button when an upgrade is possible."
 *
 * Entering and reading was already there (buildingAction routes every mageGuild*
 * to the guild overlay, and a visiting hero studies on entry). What was missing
 * was the upgrade: a player standing in a level-1 guild, looking at three tier-1
 * spells, had to leave and hunt the right cell in the build grid to get tier 2 —
 * and the one case where that hurts most, a guild with no spells researched yet,
 * was a dead-end dialog with nothing to press at all.
 *
 * So the overlay grew an `extra` row: one wide action about the PLACE rather than
 * a spell. Verified in Chromium across all three states:
 *   affordable   → enabled, note "Cost: 1000 Gold, 5 Wood, 5 Ore, …"
 *   blocked      → disabled, note "Not enough resources" under the button
 *   top of chain → no row at all (guildUpgradeExtra() returns null)
 *
 * The pure half (which level is next, which is built) is tested for real here; the
 * scene wiring is a static guard, since Phaser scenes cannot run headlessly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FACTIONS } from '../src/data/factions.js';
import { buildingCatalog, nextGuildLevel, guildLevelOf, buildingAction } from '../src/data/buildings.js';
import { newGame, playerTowns } from '../src/core/GameState.js';
import { buildStructure } from '../src/core/actions.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const town = () => playerTowns(newGame({ seed: 31 }), 0)[0];

/** Every guild level id for a faction, lowest first. */
function guildChain(faction) {
  return Object.entries(buildingCatalog(faction))
    .filter(([, b]) => b.guildLevel)
    .sort((a, b) => a[1].guildLevel - b[1].guildLevel)
    .map(([id]) => id);
}

test('every faction has a Mage Guild chain, and it is contiguous from level 1', () => {
  for (const faction of Object.keys(FACTIONS)) {
    const chain = guildChain(faction);
    assert.ok(chain.length >= 1, `${faction} has no mage guild at all`);
    const catalog = buildingCatalog(faction);
    chain.forEach((id, i) => {
      assert.equal(catalog[id].guildLevel, i + 1, `${faction}: ${id} should be level ${i + 1}`);
    });
  }
});

test('nextGuildLevel walks the chain and stops at the top', () => {
  const t = town();
  const chain = guildChain(t.faction);
  t.buildings = t.buildings.filter((b) => !chain.includes(b));
  for (const id of chain) {
    assert.equal(nextGuildLevel(t), id, `with none above built, the next level is ${id}`);
    t.buildings.push(id);
  }
  assert.equal(nextGuildLevel(t), null, 'a fully built guild has nothing left to commission');
});

test('guildLevelOf reports the highest level actually built', () => {
  const t = town();
  const chain = guildChain(t.faction);
  t.buildings = t.buildings.filter((b) => !chain.includes(b));
  assert.equal(guildLevelOf(t), 0, 'no guild, no level');
  chain.forEach((id, i) => {
    t.buildings.push(id);
    assert.equal(guildLevelOf(t), i + 1);
  });
});

test('a gap in the chain still reports the LOWEST missing level, not the highest built', () => {
  // Nothing in the rules can produce level 3 without level 2, but the accessor
  // must not lie if a save or a campaign grant ever does.
  const t = town();
  const chain = guildChain(t.faction);
  t.buildings = t.buildings.filter((b) => !chain.includes(b));
  t.buildings.push(chain[0], chain[2]);
  assert.equal(nextGuildLevel(t), chain[1], 'the hole is what needs building');
  assert.equal(guildLevelOf(t), 3, 'but the guild really does teach up to 3');
});

test('every guild level routes to the guild overlay when clicked', () => {
  // "Levels 1/2/3/4 should be enterable" — each one, not only the first.
  for (const faction of Object.keys(FACTIONS)) {
    const catalog = buildingCatalog(faction);
    for (const id of guildChain(faction)) {
      assert.equal(buildingAction(id, catalog[id]), 'guild', `${faction}/${id} must open the guild`);
    }
  }
});

test('commissioning the next level really researches its spells', () => {
  // The engine half of the button: build it, and the guild teaches a new tier.
  const s = newGame({ seed: 31 });
  const t = playerTowns(s, 0)[0];
  const chain = guildChain(t.faction);
  t.buildings = t.buildings.filter((b) => !chain.includes(b));
  s.players[0].resources = { gold: 99999, wood: 99, ore: 99, mercury: 99, sulfur: 99, crystal: 99, gems: 99 };
  t.builtToday = false;
  assert.equal(buildStructure(s, t, chain[0]), true);
  const lvl1 = Object.keys(t.guildSpells || {});
  assert.deepEqual(lvl1, ['1'], 'a level-1 guild researches tier-1 spells');
  assert.ok(t.guildSpells[1].length > 0);

  t.builtToday = false;
  assert.equal(buildStructure(s, t, chain[1]), true);
  assert.ok((t.guildSpells[2] || []).length > 0, 'level 2 adds tier-2 spells');
  assert.equal(guildLevelOf(t), 2);
});

// ---- the overlay wiring ------------------------------------------------------

test('the spellbook overlay supports one action about the PLACE', () => {
  const src = read('../src/ui/spellbook.js');
  assert.match(src, /const extraH = opts\.extra \? 46 : 0;/,
    'the panel must GROW for the row — shrinking the detail strip takes room from '
    + 'the one part of this dialog that exists to be read');
  // The same rule now covers the magic-school mastery line (noteH): every
  // optional row the panel gains is added to h AND subtracted from dTop, so the
  // detail strip keeps its size and its distance from the foot either way.
  assert.match(src, /const noteH = opts\.noteOf \? 20 : 0;/,
    'a mastery note gets its own reserved line rather than landing on the description');
  assert.match(src, /\+ 128 \+ extraH \+ noteH\)/, 'both optional rows grow the panel');
  assert.match(src, /const dTop = py \+ h - 104 - extraH - noteH;/,
    'so the detail strip stays exactly where it was');
  assert.match(src, /if \(opts\.extra\) \{/);
  assert.match(src, /if \(ex\.enabled === false\) btn\.setEnabled\(false\)/,
    'a blocked action shows as blocked rather than doing nothing when pressed');
  assert.match(src, /if \(ex\.note\) root\.add\(label/, 'and the reason/cost prints under it');
});

test('the guild dialog offers the upgrade, in both the stocked and the empty case', () => {
  const src = read('../src/scenes/TownScene.js');
  assert.match(src, /^ {2}guildUpgradeExtra\(\) \{/m, 'the row must be built somewhere nameable');
  const fn = src.slice(src.indexOf('  guildUpgradeExtra() {'), src.indexOf('  guildDialog() {'));
  assert.match(fn, /const next = nextGuildLevel\(town\);/);
  assert.match(fn, /if \(!next\) return null;/, 'a maxed guild offers nothing');
  assert.match(fn, /const reason = buildBlockReason\(/,
    'a dead button naming the blocker beats no button — that is the answer being looked for');
  assert.match(fn, /enabled: !reason,/);
  assert.match(fn, /buildStructure\(this\.state, town, next\)/);

  const dlg = src.slice(src.indexOf('  guildDialog() {'));
  assert.match(dlg, /const extra = this\.guildUpgradeExtra\(\);/);
  assert.ok(dlg.indexOf('extra') < dlg.indexOf('if (!all.length)'),
    'the row is computed BEFORE the empty-guild early return, which is the case that needs it most');
  assert.match(dlg, /extra,/, 'and handed to the overlay in the stocked case');
});

test('the guild subtitle says what it teaches and what Wisdom that needs', () => {
  const src = read('../src/scenes/TownScene.js');
  const dlg = src.slice(src.indexOf('  guildDialog() {'));
  assert.match(dlg, /teaches spell tiers 1–\$\{level\}/,
    'a guild level is only half the story');
  assert.match(dlg, /wisdomRequiredForTier\(level\)/,
    'Wisdom is the other half — a spell you cannot learn should say why');
});
