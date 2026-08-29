/**
 * magic-adventure-mastery.test.js — what magic-school mastery buys ON THE MAP.
 *
 * The combat half of mastery (mass casts, per-spell magnitudes) is in
 * magic-mastery.test.js. This is the other half: an Expert of a school reaches
 * further, jumps more often, recalls for free and scries deeper with that
 * school's ADVENTURE spells.
 *
 * Three things are worth testing more than the effects themselves:
 *
 *   The ladders are additive only. Index 0 of every `*_BY_SCHOOL` array is the
 *   number this game has always used, and CONFIG's plain scalar is DERIVED from
 *   it rather than written twice — so an unskilled hero cannot be affected by
 *   any of this, and the two cannot drift apart.
 *
 *   The UI overlay and the engine read the same ladder. Dimension Door draws
 *   green landing tiles from `dimDoorLandable` and jumps via `castAdventureSpell`;
 *   if those consulted different ranges the player would be shown a tile the
 *   engine refuses. That is the docs/JOIN_FEASIBILITY.md defect, and the test
 *   below is the one that would catch it coming back.
 *
 *   Nothing here needs a save field. Mastery is derived from skills that already
 *   round-trip, so there is no migration and no SAVE_VERSION bump.
 *
 * No Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { newGame, playerHeroes, playerTowns, tileAt } from '../src/core/GameState.js';
import { castAdventureSpell, dimDoorLandable, townPortalCanChoose } from '../src/core/actions.js';
import { isExplored } from '../src/map/fog.js';
import { adventureParam, masteryNote, viewAirSeesBothLevels } from '../src/core/magic.js';
import { CONFIG } from '../src/config.js';

function clearPatch(s, cx, cy, r = 10) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const t = tileAt(s, cx + dx, cy + dy);
    if (t) { t.terrain = 'grass'; t.obstacle = null; t.objectId = null; }
  }
}

/** A hero at the centre of a cleared field, knowing `spells`, at school `skills`. */
function mage(seed, spells, skills, radius = 20) {
  const s = newGame({ seed });
  const hero = playerHeroes(s, 0)[0];
  hero.x = Math.floor(s.map.w / 2); hero.y = Math.floor(s.map.h / 2);
  clearPatch(s, hero.x, hero.y, radius);
  hero.spells = spells; hero.mana = 999; hero.mp = 9999;
  hero.skills = { ...(hero.skills || {}), ...skills };
  s.fog[0].fill(1); // Dimension Door only lands on explored ground
  return { s, hero };
}

// ---------------------------------------------------------------------------
// 1. The ladders themselves
// ---------------------------------------------------------------------------

test('data: every school ladder is 4 long, starts at the plain scalar, and casts no-skill at Basic', () => {
  const ladders = Object.keys(CONFIG).filter((k) => k.endsWith('_BY_SCHOOL'));
  assert.ok(ladders.length >= 7, `the ladders span the adventure roster (${ladders.length})`);
  for (const key of ladders) {
    const ladder = CONFIG[key];
    const scalar = key.slice(0, -'_BY_SCHOOL'.length);
    assert.equal(ladder.length, 4, `${key}: [none, Basic, Advanced, Expert]`);
    assert.equal(CONFIG[scalar], ladder[0],
      `CONFIG.${scalar} is DERIVED from ${key}[0] — never written twice`);
    assert.equal(ladder[1], ladder[0], `${key}: no skill casts at Basic`);
    assert.ok(ladder.every((v) => typeof v === 'number' && Number.isFinite(v)), `${key}: numbers`);
  }
});

test('adventureParam clamps out-of-range levels instead of returning undefined', () => {
  const l = CONFIG.DIM_DOOR_RANGE_BY_SCHOOL;
  assert.equal(adventureParam({ skills: {} }, 'dimensionDoor', l), l[0]);
  assert.equal(adventureParam({ skills: { airMagic: 3 } }, 'dimensionDoor', l), l[3]);
  assert.equal(adventureParam({}, 'dimensionDoor', l), l[0], 'a hero with no skills object at all');
  assert.equal(adventureParam({ skills: { airMagic: 9 } }, 'dimensionDoor', l), l[3], 'clamped');
  assert.equal(adventureParam({ skills: { earthMagic: 3 } }, 'dimensionDoor', l), l[0],
    'the WRONG school buys nothing');
});

// ---------------------------------------------------------------------------
// 2. Dimension Door — reach, casts a day, and the toll
// ---------------------------------------------------------------------------

test('Dimension Door: Air mastery lengthens the jump, and the overlay agrees with the engine', () => {
  const far = CONFIG.DIM_DOOR_RANGE_BY_SCHOOL[0] + 3;   // beyond an unskilled jump
  assert.ok(far <= CONFIG.DIM_DOOR_RANGE_BY_SCHOOL[3], 'but inside an Expert one');

  for (const [lvl, ok] of [[0, false], [1, false], [2, true], [3, true]]) {
    const { s, hero } = mage(5, ['dimensionDoor'], { airMagic: lvl });
    const tx = hero.x + far, ty = hero.y;
    // The overlay's predicate and the cast must never disagree.
    assert.equal(dimDoorLandable(s, hero, tx, ty), ok, `level ${lvl}: overlay`);
    const r = castAdventureSpell(s, hero, 'dimensionDoor', { x: tx, y: ty });
    assert.equal(r.ok, ok, `level ${lvl}: cast`);
    if (ok) assert.equal(hero.x, tx, 'and the hero actually arrives');
  }
});

test('Dimension Door: mastery grants more jumps a day and a cheaper toll', () => {
  const plain = mage(6, ['dimensionDoor'], {});
  const expert = mage(6, ['dimensionDoor'], { airMagic: 3 });

  const jump = (f, n) => castAdventureSpell(f.s, f.hero, 'dimensionDoor',
    { x: f.hero.x + (n % 2 ? 3 : -3), y: f.hero.y + 1 });

  const spendAll = (f) => {
    let casts = 0;
    for (let i = 0; i < 8; i++) if (jump(f, i).ok) casts++; else break;
    return casts;
  };
  assert.equal(spendAll(plain), CONFIG.DIM_DOOR_USES_BY_SCHOOL[0], 'unskilled: the old allowance');
  assert.equal(spendAll(expert), CONFIG.DIM_DOOR_USES_BY_SCHOOL[3], 'Expert Air: more');
  assert.ok(CONFIG.DIM_DOOR_USES_BY_SCHOOL[3] > CONFIG.DIM_DOOR_USES_BY_SCHOOL[0]);

  // …and each jump costs less movement.
  const one = mage(6, ['dimensionDoor'], { airMagic: 3 });
  const mp0 = one.hero.mp;
  castAdventureSpell(one.s, one.hero, 'dimensionDoor', { x: one.hero.x + 3, y: one.hero.y });
  assert.equal(mp0 - one.hero.mp, CONFIG.DIM_DOOR_MP_BY_SCHOOL[3]);
  assert.ok(CONFIG.DIM_DOOR_MP_BY_SCHOOL[3] < CONFIG.DIM_DOOR_MP_BY_SCHOOL[0], 'cheaper than unskilled');
});

// ---------------------------------------------------------------------------
// 3. Town Portal, Visions, Scuttle Boat, View Air
// ---------------------------------------------------------------------------

test('Town Portal: an Expert of Earth recalls for no movement at all', () => {
  const cast = (skills) => {
    const s = newGame({ seed: 3 });
    const hero = playerHeroes(s, 0)[0];
    const town = playerTowns(s, 0)[0];
    town.z = hero.z ?? 0; town.visitingHeroId = null;
    hero.x = Math.min(s.map.w - 2, town.x + 12); hero.y = town.y; hero.mp = 5000;
    hero.spells = ['townPortal']; hero.mana = 99;
    hero.skills = { ...(hero.skills || {}), ...skills };
    const r = castAdventureSpell(s, hero, 'townPortal', null);
    assert.equal(r.ok, true);
    return 5000 - hero.mp;
  };
  assert.equal(cast({}), CONFIG.TOWN_PORTAL_MP_BY_SCHOOL[0], 'unskilled pays what it always paid');
  assert.equal(cast({ earthMagic: 2 }), CONFIG.TOWN_PORTAL_MP_BY_SCHOOL[2]);
  assert.equal(cast({ earthMagic: 3 }), 0, 'Expert Earth: free');
});

test('Town Portal: one definition of who may AIM it — the AI reads the engine’s', () => {
  assert.equal(townPortalCanChoose({ skills: {} }), false);
  assert.equal(townPortalCanChoose({ skills: { earthMagic: 1 } }), true);
  // The AI used to carry its own copy of the rule. A second copy is how a UI and
  // an engine end up disagreeing about what a spell does (docs/JOIN_FEASIBILITY.md).
  const ai = readFileSync(new URL('../src/ai/AIPlayer.js', import.meta.url), 'utf8');
  assert.match(ai, /const canAim = townPortalCanChoose\(hero\);/);
  assert.doesNotMatch(ai, /canAim = \(hero\.skills\?\.earthMagic/, 'no second copy of the rule');
});

test('Visions and Scuttle Boat: mastery widens the reach', () => {
  // Visions — the far probe is dark at level 0 and lit at Expert.
  const probeAt = (lvl) => {
    const s = newGame({ seed: 4 });
    const hero = playerHeroes(s, 0)[0];
    hero.x = Math.floor(s.map.w / 2); hero.y = Math.floor(s.map.h / 2);
    s.fog[0].fill(0);
    hero.spells = ['visions']; hero.mana = 99;
    hero.skills = { ...(hero.skills || {}), airMagic: lvl };
    assert.equal(castAdventureSpell(s, hero, 'visions', null).ok, true);
    const px = Math.min(s.map.w - 1, hero.x + CONFIG.VISIONS_RANGE_BY_SCHOOL[0] + 3);
    return isExplored(s, 0, px, hero.y, 0);
  };
  assert.equal(probeAt(0), false, 'beyond an unskilled Visions');
  assert.equal(probeAt(3), true, 'inside an Expert one');

  // Scuttle Boat — a hull parked beyond the unskilled range.
  const scuttleAt = (lvl) => {
    const s = newGame({ seed: 4 });
    const hero = playerHeroes(s, 0)[0];
    hero.x = Math.floor(s.map.w / 2); hero.y = Math.floor(s.map.h / 2);
    const d = CONFIG.SCUTTLE_RANGE_BY_SCHOOL[0] + 2;
    assert.ok(d <= CONFIG.SCUTTLE_RANGE_BY_SCHOOL[3]);
    const bx = Math.min(s.map.w - 1, hero.x + d);
    const t = tileAt(s, bx, hero.y); t.terrain = 'water'; t.obstacle = null;
    s.map.objects.testBoat = { id: 'testBoat', type: 'boat', x: bx, y: hero.y, z: 0 };
    hero.spells = ['scuttleBoat']; hero.mana = 99;
    hero.skills = { ...(hero.skills || {}), waterMagic: lvl };
    return castAdventureSpell(s, hero, 'scuttleBoat', null).ok;
  };
  assert.equal(scuttleAt(0), false, 'out of an unskilled reach');
  assert.equal(scuttleAt(3), true, 'within an Expert one');
});

test('View Air: an Expert of Air scries the underworld too', () => {
  const scry = (lvl) => {
    const s = newGame({ seed: 3, underground: true });
    if (!s.map.underground) return null;           // this map has no second level
    const hero = playerHeroes(s, 0)[0];
    s.fog[0].fill(0); s.fog[1].fill(0);
    hero.spells = ['viewAir']; hero.mana = 99;
    hero.skills = { ...(hero.skills || {}), airMagic: lvl };
    assert.equal(castAdventureSpell(s, hero, 'viewAir', null).ok, true);
    return {
      here: isExplored(s, 0, s.map.w - 1, s.map.h - 1, 0),
      below: isExplored(s, 0, s.map.w - 1, s.map.h - 1, 1),
    };
  };
  const plain = scry(0);
  if (!plain) return;                              // no underworld on this seed — nothing to assert
  assert.equal(plain.here, true, 'the level you stand on, as always');
  assert.equal(plain.below, false, 'and no further');
  assert.deepEqual(scry(3), { here: true, below: true }, 'Expert Air lifts both fogs');
  assert.equal(viewAirSeesBothLevels({ skills: { airMagic: 2 } }), false, 'Advanced does not');
});

// ---------------------------------------------------------------------------
// 4. What the book tells the player
// ---------------------------------------------------------------------------

test('the spellbook note names the adventure knobs mastery moved', () => {
  assert.equal(masteryNote({ skills: {} }, 'dimensionDoor'), null, 'no skill, no note');

  const dd = masteryNote({ skills: { airMagic: 3 } }, 'dimensionDoor');
  assert.match(dd, /Expert Air Magic/);
  assert.match(dd, /reach 16 tiles \(was 8\)/);
  assert.match(dd, /casts a day 4 \(was 2\)/);
  assert.match(dd, /movement a jump 200 \(was 400\)/, 'a SMALLER number is still reported as the reward');

  assert.match(masteryNote({ skills: { earthMagic: 3 } }, 'townPortal'), /movement free \(was 200\)/);
  assert.match(masteryNote({ skills: { airMagic: 3 } }, 'viewAir'), /scries BOTH map levels/);
  // A school that changed nothing but the price says only that.
  const basic = masteryNote({ skills: { airMagic: 1 } }, 'dimensionDoor');
  assert.match(basic, /mana/);
  assert.doesNotMatch(basic, /reach|casts a day/, 'Basic moves no adventure knob');
});

test('regression: an unskilled hero’s adventure spells behave exactly as before', () => {
  const { s, hero } = mage(9, ['dimensionDoor', 'visions'], {});
  assert.equal(adventureParam(hero, 'dimensionDoor', CONFIG.DIM_DOOR_RANGE_BY_SCHOOL), CONFIG.DIM_DOOR_RANGE);
  assert.equal(adventureParam(hero, 'visions', CONFIG.VISIONS_RANGE_BY_SCHOOL), CONFIG.VISIONS_RANGE);

  const mp0 = hero.mp;
  const r = castAdventureSpell(s, hero, 'dimensionDoor', { x: hero.x + 3, y: hero.y });
  assert.equal(r.ok, true);
  assert.equal(mp0 - hero.mp, CONFIG.DIM_DOOR_MP, 'the documented toll');
  assert.equal(hero.dimDoorUsed, 1);
  assert.equal(castAdventureSpell(s, hero, 'dimensionDoor',
    { x: hero.x + CONFIG.DIM_DOOR_RANGE + 2, y: hero.y }).ok, false, 'the documented range');
});
