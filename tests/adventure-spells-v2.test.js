/**
 * adventure-spells-v2.test.js — the second wave of adventure-map spells:
 * Visions (local scout), Scuttle Boat (sink the nearest empty boat), and
 * View Earth (reveal both levels). Dispatched by actions.castAdventureSpell,
 * learned like any spell. (Fly / Water Walk / Disguise are a later unit.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, tileAt, serialize, deserialize } from '../src/core/GameState.js';
import { castAdventureSpell } from '../src/core/actions.js';
import { isExplored } from '../src/map/fog.js';
import { SPELLS } from '../src/data/spells.js';
import { scrySighting } from '../src/core/magic.js';
import { CONFIG } from '../src/config.js';

function clearPatch(s, cx, cy, r = 3) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const t = tileAt(s, cx + dx, cy + dy);
    if (t) { t.terrain = 'grass'; t.obstacle = null; t.objectId = null; }
  }
}

test('Visions: reveals a wide disc around the hero, repeatable, spends mana', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  s.fog[0].fill(0); // dark
  hero.spells = ['visions']; hero.mana = 30;

  // A probe inside the Visions disc but well outside the hero's own sight.
  const probe = { x: Math.min(s.map.w - 1, hero.x + CONFIG.VISIONS_RANGE - 1), y: hero.y };
  assert.ok(!isExplored(s, 0, probe.x, probe.y, 0), 'probe starts dark');
  const r = castAdventureSpell(s, hero, 'visions', null);
  assert.equal(r.ok, true);
  assert.equal(r.type, 'visions');
  assert.equal(hero.mana, 30 - SPELLS.visions.manaCost, 'mana spent');
  assert.ok(isExplored(s, 0, probe.x, probe.y, 0), 'the disc is revealed');
  // A tile beyond the disc stays dark.
  const far = { x: Math.min(s.map.w - 1, hero.x + CONFIG.VISIONS_RANGE + 3), y: hero.y };
  if (far.x !== probe.x) assert.ok(!isExplored(s, 0, far.x, far.y, 0), 'beyond the disc stays dark');
  // Repeatable: a second cast still works (no per-day limit).
  const r2 = castAdventureSpell(s, hero, 'visions', null);
  assert.equal(r2.ok, true, 'Visions can be cast again');
});

test('Scuttle Boat: sinks the nearest empty boat within range; else refuses', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  clearPatch(s, hero.x, hero.y, 4);
  hero.spells = ['scuttleBoat']; hero.mana = 30;

  // No boat around → refused, no mana spent.
  const none = castAdventureSpell(s, hero, 'scuttleBoat', null);
  assert.equal(none.ok, false);
  assert.equal(hero.mana, 30, 'a refused cast is free');

  // Plant a boat 2 tiles away (within SCUTTLE_RANGE) on water.
  const bx = hero.x + 2, by = hero.y;
  const bt = tileAt(s, bx, by); bt.terrain = 'water';
  const id = 'OBOAT';
  s.map.objects[id] = { id, x: bx, y: by, type: 'boat' };
  bt.objectId = id;

  const r = castAdventureSpell(s, hero, 'scuttleBoat', null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.at, { x: bx, y: by });
  assert.equal(s.map.objects[id], undefined, 'the boat object is gone');
  assert.equal(tileAt(s, bx, by).objectId, null, 'the tile is cleared');
  assert.equal(hero.mana, 30 - SPELLS.scuttleBoat.manaCost, 'mana spent');
});

test('Scuttle Boat: a boat beyond range is left alone', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.spells = ['scuttleBoat']; hero.mana = 30;
  const bx = Math.min(s.map.w - 1, hero.x + CONFIG.SCUTTLE_RANGE + 2), by = hero.y;
  const bt = tileAt(s, bx, by);
  if (bt) { bt.terrain = 'water'; bt.objectId = 'OFAR'; s.map.objects.OFAR = { id: 'OFAR', x: bx, y: by, type: 'boat' }; }
  const r = castAdventureSpell(s, hero, 'scuttleBoat', null);
  assert.equal(r.ok, false, 'out-of-range boat is not scuttled');
  assert.ok(s.map.objects.OFAR, 'the far boat survives');
});

// THESE TWO USED TO ASSERT THE OPPOSITE — "surface revealed", "underground
// revealed" — because View Earth used to be `fog.fill(1)` on every level: the whole
// map, terrain and all, permanently, for twelve mana. Reported as "it is just
// revealing the whole world forever", and rewritten to the HoMM3 behaviour asked
// for: "all black, and show the castle locations with flags and heroes with shields
// in the respective colour… this way it preserves some unknown while helping with
// general direction and location".
//
// So the assertion that matters is now the REFUSAL: the fog must not move.
test('View Earth scries the powers and leaves the land dark', () => {
  const s = newGame({ seed: 3, mapW: 56, mapH: 46 }); // large maps grow an underground
  assert.ok(s.map.underground, 'this map has an underground');
  const hero = playerHeroes(s, 0)[0];
  s.fog[0].fill(0); s.fogUnder[0].fill(0);
  hero.spells = ['viewEarth']; hero.mana = 30;

  const r = castAdventureSpell(s, hero, 'viewEarth', null);
  assert.equal(r.ok, true);
  assert.equal(hero.mana, 30 - SPELLS.viewEarth.manaCost);
  assert.ok(!isExplored(s, 0, s.map.w - 1, s.map.h - 1, 0), 'the surface stays dark');
  assert.ok(!isExplored(s, 0, s.map.w - 1, s.map.h - 1, 1), 'and so does the underworld');

  const scry = s.players[0].scry;
  assert.equal(scry.day, s.day, 'the sighting is dated — it is a snapshot, not a subscription');
  assert.ok(scry.marks.length > 0, 'and it marks something');
  // Every castle in the world, on BOTH levels — that is what the tier-3 spell buys
  // now that it no longer buys the map.
  const towns = scry.marks.filter((m) => m.kind === 'town');
  assert.equal(towns.length, Object.keys(s.towns).length, 'every castle is marked');
  for (const m of scry.marks) {
    assert.ok(m.kind === 'town' || m.kind === 'hero');
    assert.equal(typeof m.owner, 'number', 'each mark names a banner to fly');
  }
});

test('View Earth does not mark the caster — you know where you are', () => {
  const s = newGame({ seed: 3, mapW: 44, mapH: 36 });
  const hero = playerHeroes(s, 0)[0];
  hero.spells = ['viewEarth']; hero.mana = 30;
  assert.equal(castAdventureSpell(s, hero, 'viewEarth', null).ok, true);
  const heroes = s.players[0].scry.marks.filter((m) => m.kind === 'hero');
  assert.ok(!heroes.some((m) => m.x === hero.x && m.y === hero.y && (m.z ?? 0) === (hero.z ?? 0)),
    'the caster is not among the sightings');
});

test('View Earth on a map with no underworld still scries, no error', () => {
  const s = newGame({ seed: 3, mapW: 44, mapH: 36 }); // small maps have no underground
  const hero = playerHeroes(s, 0)[0];
  s.fog[0].fill(0);
  hero.spells = ['viewEarth']; hero.mana = 30;
  const r = castAdventureSpell(s, hero, 'viewEarth', null);
  assert.equal(r.ok, true);
  assert.ok(!isExplored(s, 0, s.map.w - 1, s.map.h - 1, 0), 'the land is still dark');
  assert.ok(s.players[0].scry.marks.length > 0);
});

test('a sighting round-trips a save — intelligence you paid for survives a reload', () => {
  const s = newGame({ seed: 3, mapW: 44, mapH: 36 });
  const hero = playerHeroes(s, 0)[0];
  hero.spells = ['viewEarth']; hero.mana = 30;
  castAdventureSpell(s, hero, 'viewEarth', null);
  const back = deserialize(serialize(s));
  assert.deepEqual(back.players[0].scry, s.players[0].scry);
});

// The map paints flags and shields over the fog; the minimap paints hollow marks in
// the same places. They read ONE rule (magic.scrySighting) because a fade written
// twice drifts, and the two surfaces disagreeing about whether a sighting is still
// valid is the worst version of this bug: the map says the enemy is there and the
// panel says nothing is.
test('a sighting is strongest the day it is cast and lapses on schedule', () => {
  const s = newGame({ seed: 3, mapW: 44, mapH: 36 });
  const hero = playerHeroes(s, 0)[0];
  hero.spells = ['viewEarth']; hero.mana = 30;
  castAdventureSpell(s, hero, 'viewEarth', null);

  const fresh = scrySighting(s, 0);
  assert.ok(fresh, 'there is a sighting');
  assert.equal(fresh.age, 0);
  assert.equal(fresh.alpha, 1, 'full strength on the day');

  let last = fresh.alpha;
  for (let d = 1; d < CONFIG.VIEW_EARTH_DAYS; d++) {
    s.day += 1;
    const sight = scrySighting(s, 0);
    assert.ok(sight, `day ${d}: still valid`);
    assert.ok(sight.alpha < last, `day ${d}: fainter than yesterday`);
    assert.ok(sight.alpha > 0, `day ${d}: faint is not absent — old news must not read as no news`);
    last = sight.alpha;
  }
  s.day += 1;
  assert.equal(scrySighting(s, 0), null, 'and on the last day it lapses entirely');
});

test('no sighting, or somebody else\'s, reads as nothing', () => {
  const s = newGame({ seed: 3, mapW: 44, mapH: 36 });
  assert.equal(scrySighting(s, 0), null, 'a player who never cast it sees nothing');
  const hero = playerHeroes(s, 0)[0];
  hero.spells = ['viewEarth']; hero.mana = 30;
  castAdventureSpell(s, hero, 'viewEarth', null);
  assert.ok(scrySighting(s, 0), 'the caster has one');
  assert.equal(scrySighting(s, 1), null, 'and the rival does not get it for free');
});

test('View Air still maps the ground — the two spells answer different questions', () => {
  // The tier-3 spell is no longer the tier-2 one twice over. Air sees the LAND of
  // the level you stand on; Earth senses the POWERS on both. Pinned because the
  // moment one of them stops being distinct, View Earth is pointless again.
  const s = newGame({ seed: 3, mapW: 44, mapH: 36 });
  const hero = playerHeroes(s, 0)[0];
  s.fog[0].fill(0);
  hero.spells = ['viewAir']; hero.mana = 30;
  assert.equal(castAdventureSpell(s, hero, 'viewAir', null).ok, true);
  assert.ok(isExplored(s, 0, s.map.w - 1, s.map.h - 1, 0), 'View Air still lifts the fog');
  assert.equal(s.players[0].scry, undefined, 'and writes no sighting');
});

// The unknown-spell / insufficient-mana guards are spell-agnostic (they live in
// castAdventureSpell's dispatch), so they're asserted once — over a v1 and a v2
// spell — in adventure-spells.test.js rather than re-tested per spell family.

test('the new v2 spells are adventure spells with valid guild tiers', () => {
  for (const id of ['visions', 'scuttleBoat', 'viewEarth']) {
    const sp = SPELLS[id];
    assert.ok(sp, `${id} exists`);
    assert.equal(sp.adventure, true, `${id} is an adventure spell`);
    assert.equal(sp.kind, 'adventure');
    assert.ok(sp.tier >= 1 && sp.tier <= 5, `${id} has a valid tier`);
    assert.ok(sp.manaCost > 0, `${id} has a mana cost`);
  }
});
