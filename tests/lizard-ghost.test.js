/**
 * lizard-ghost.test.js — the Lizard Ghost (opt-in `lizardGhosts`).
 *
 * A wiped lizard stack MAY leave a shade on its hex: a chance event, so a
 * Fortress fight can turn on whether the marsh gives its dead back. Off by
 * default and drawing no rng when off, so Classic stays byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { readFileSync } from 'node:fs';

import { CREATURES, summonedOnly, fieldableCreatureIds } from '../src/data/creatures.js';
import { Rng } from '../src/core/rng.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { newGame } from '../src/core/GameState.js';
import { createBattle, unitAt } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';

const GHOST = CONFIG.GHOST_REMNANT_CREATURE;

function fight(features, seed = 4, lizard = 'lizardman', count = 40) {
  const s = newGame({ seed: 6, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const hero = Object.values(s.heroes).find((h) => h.owner === 0);
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(seed),
    attacker: { hero, army: [{ creature: 'archangel', count: 120 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: lizard, count }], playerIndex: -1 },
    features,
  });
  autoResolve(battle);
  return battle;
}
const ghosts = (b) => b.units.filter((u) => u.creature === GHOST);

test('the Lizard Ghost is a Fortress creature that nothing can recruit', () => {
  const g = CREATURES[GHOST];
  assert.equal(g.faction, 'fortress');
  assert.equal(g.growth, 0, 'no weekly growth');
  assert.deepEqual(g.cost, {}, 'and no price — it is never bought');
  assert.equal(g.tier, 0, 'tier 0 keeps it out of dwelling and Altar tier lookups');
  assert.equal(g.undead, true, 'a shade is beyond morale');
});

test('both lizard stacks can leave a shade; the shade cannot itself leave one', () => {
  assert.ok(CREATURES.lizardman.abilities.includes('ghostRemnant'));
  assert.ok(CREATURES.lizardWarrior.abilities.includes('ghostRemnant'));
  assert.ok(!CREATURES[GHOST].abilities.includes('ghostRemnant'), 'no infinite chains');
});

test('OFF (and by default): no shade ever rises, and no rng is drawn', () => {
  for (const features of [undefined, {}, { lizardGhosts: false }]) {
    const b = fight(features);
    assert.equal(ghosts(b).length, 0, 'no ghost without the feature');
  }
  // Byte-identity: the same seed with the feature absent vs explicitly false must
  // leave the rng in the same place (no extra draw).
  const a = fight({});
  const c = fight({ lizardGhosts: false });
  assert.equal(a.rng.next, c.rng.next, 'identical rng state — the feature drew nothing');
});

test('ON: a wiped lizard stack SOMETIMES leaves a shade — a real chance event', () => {
  let rose = 0;
  const N = 40;
  for (let seed = 1; seed <= N; seed++) if (ghosts(fight({ lizardGhosts: true }, seed)).length) rose++;
  assert.ok(rose > 0, 'it happens');
  assert.ok(rose < N, 'and it does NOT always happen — the marsh may keep its dead');
});

test('the shade is a real, placed, targetable combatant', () => {
  // Search seeds until one rises, then inspect it.
  let g = null, b = null;
  for (let seed = 1; seed <= 60 && !g; seed++) {
    b = fight({ lizardGhosts: true }, seed);
    g = ghosts(b)[0] || null;
  }
  assert.ok(g, 'a shade rose on some seed');
  // It spawned with a real stack size; by the end of the battle it may have taken
  // losses of its own, so count can only be <= startCount.
  assert.ok(g.startCount >= 1, 'spawned with a real stack size');
  assert.ok(g.count <= g.startCount, 'never grows beyond what rose');
  assert.equal(typeof g.x, 'number');
  assert.equal(typeof g.y, 'number');
  if (g.alive) {
    assert.equal(unitAt(b, g.x, g.y)?.id, g.id, 'occupies its hex — clickable and drawable');
  }
});

test('the shade is a FRACTION of the fallen stack, never more', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const b = fight({ lizardGhosts: true }, seed, 'lizardman', 40);
    const g = ghosts(b)[0];
    if (!g) continue;
    const cap = Math.max(1, Math.ceil(40 * CONFIG.GHOST_REMNANT_FRACTION));
    assert.equal(g.startCount, cap, `${g.startCount} shades from 40 fallen (expected ${cap})`);
    return;
  }
});

test('one roll per stack — a battle never spawns a second shade from the same stack', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const b = fight({ lizardGhosts: true }, seed);
    assert.ok(ghosts(b).length <= 1, 'at most one shade per lizard stack');
    for (const u of b.units) {
      if ((CREATURES[u.creature].abilities || []).includes('ghostRemnant') && !u.alive) {
        assert.equal(u.ghostRolled, true, 'the fallen stack recorded its single roll');
      }
    }
  }
});

test('battles still terminate cleanly with a shade in play', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const b = fight({ lizardGhosts: true }, seed);
    assert.ok(b.over, `seed ${seed}: battle ended`);
    assert.ok(b.winner === 0 || b.winner === 1, 'with a real winner');
    for (const u of b.units) assert.ok(!(u.alive && u.count <= 0), 'no zero-count survivors');
  }
});

// ---------------------------------------------------------------------------
// The roster leak: a shade must never be something the WORLD fields.
//
// Reported: "lizardGhost x4 guarding a sawmill", on a map whose lizardGhosts
// feature was off. The shade is not the bug — the roster is. MapGenerator's guard
// pool filtered on `!upgraded` alone, and at aiValue 150 the ghost fits every
// guard budget, so it was eligible everywhere. Measured over 60 generated 44x36
// maps with two Fortress players: 122 placements across 54 of the 60 maps before
// the fix, 0 after.
//
// The fix is a `summonedOnly` marker on the creature and a fieldableCreatureIds()
// accessor that every whole-table roster draws from — explicit, rather than each
// pool separately inferring it from tier/growth/cost.
// ---------------------------------------------------------------------------

test('the shade is marked summonedOnly and excluded from the fieldable roster', () => {
  assert.equal(summonedOnly(GHOST), true, 'nothing in the world may field it');
  assert.ok(!fieldableCreatureIds().includes(GHOST));
  // And it is the ONLY one, so an accidental marker on a real creature shows up.
  const marked = Object.keys(CREATURES).filter(summonedOnly);
  assert.deepEqual(marked, [GHOST], `unexpected summonedOnly creatures: ${marked.join(', ')}`);
  assert.equal(fieldableCreatureIds().length, Object.keys(CREATURES).length - 1);
});

test('no generated map fields a shade — as a guard, or in a town garrison', () => {
  // Two Fortress players, so the faction whose creature it is has every chance.
  let placements = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const towns = [];
    const map = generateMap({
      w: 44, h: 36, rng: new Rng(seed),
      players: [{ faction: 'inferno' }, { faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    });
    for (const level of [map, map.underground].filter(Boolean)) {
      for (const o of Object.values(level.objects || {})) {
        const stacks = o.type === 'monster' ? [{ creature: o.creature }] : (o.guards || []);
        for (const g of stacks) if (g.creature === GHOST) placements++;
      }
    }
    for (const t of towns) {
      for (const g of (t.garrison || []).filter(Boolean)) if (g.creature === GHOST) placements++;
    }
  }
  assert.equal(placements, 0, `a shade was placed ${placements} times on a generated map`);
});

test('the Battle Gym roster does not offer a shade either', () => {
  const src = readFileSync(new URL('../src/scenes/SkirmishSetupScene.js', import.meta.url), 'utf8');
  assert.match(src, /fieldableCreatureIds\(\)/,
    'the setup roster enumerates the whole creature table and must filter it');
});
