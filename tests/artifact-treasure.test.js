/**
 * artifact-treasure.test.js — what the map generator is allowed to put behind a
 * guard.
 *
 * `value` is a RARITY BAND, and the only thing it means in play is *how hard the
 * guard in front of the treasure is*. The generator asks for a band, seats a
 * guard sized to that band, and draws an artifact to match. When a band ran dry
 * the draw used to fall back to "any unused artifact", which is not a near miss
 * but a collapse of the whole contract — measured over 30 seeds a size, before
 * the fix:
 *
 *   Age of Empires   (88×72)  up to  2 top-band relics per map
 *   Clash of Kingdoms(96×80)  up to  5
 *   World's Edge    (144×120) up to 14
 *
 * …where the generator reserves exactly ONE as the map's marquee reward. The
 * rest were sitting behind light and medium guards, so the +6 Attack Titan's
 * Gladius was a routine day-three pickup off a peasant stack.
 *
 * The properties below are the contract. They are asserted against real generated
 * maps at every size the game actually ships — both levels of each, since the
 * underground is a second map sharing the same artifact pool — because the
 * failure was invisible at the default size and only bit on the big presets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../src/map/MapGenerator.js';
import { ARTIFACTS } from '../src/data/artifacts.js';
import { Rng } from '../src/core/rng.js';
import { CONFIG } from '../src/config.js';

// Every map size the game ships: the SCENARIOS presets plus the campaign sizes.
// The bug hid at 44×36 and only bit on the big ones, so a test that checks one
// size checks the wrong thing.
const SIZES = [[36, 30], [44, 36], [56, 46], [72, 60], [88, 72], [96, 80], [144, 120]];
const SEEDS = [11, 202, 3003, 40004];

const mapsOfSize = function* (w, h) {
  for (const seed of SEEDS) {
    const towns = [];
    yield generateMap({
      w, h, rng: new Rng(seed),
      players: [{ faction: 'castle' }, { faction: 'inferno' }],
      registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
    });
  }
};
// BOTH levels. The underground is a whole second map hanging off `map.underground`
// with its own object store, and it shares the surface's artifact pool — on
// World's Edge it holds very nearly half of them. A first cut of this file read
// only `map.objects` and so measured half the problem: it reported large maps as
// duplicate-free when the caverns underneath were repeating artifacts.
const artifactsOn = (map) => {
  const out = [];
  for (let m = map; m; m = m.underground) {
    for (const o of Object.values(m.objects || {})) if (o.type === 'artifact') out.push(o);
  }
  return out;
};
const TOP = Math.max(...Object.values(ARTIFACTS).map((a) => a.value));

test('treasure: a map seats exactly one top-band artifact — its grand prize', () => {
  for (const [w, h] of SIZES) {
    for (const map of mapsOfSize(w, h)) {
      const top = artifactsOn(map).filter((a) => ARTIFACTS[a.artifact].value === TOP);
      assert.equal(top.length, 1,
        `${w}×${h}: ${top.length} top-band artifacts (${top.map((a) => a.artifact).join(', ')}) — the generator reserves one`);
    }
  }
});

test('treasure: a campaign relic is never map loot', () => {
  // Mornbrand, the Sunward Bastion and the Dawnstar Helm are granted at the
  // start of chapters 6/11/17 of "The First Vow" and form a story set. They were
  // being seated as ordinary treasure — one every other small map, three or four
  // on a huge one — which put a named story relic on a map with no story, and
  // let a campaign hand you a second copy of the sword it had just given you.
  const campaign = Object.keys(ARTIFACTS).filter((id) => ARTIFACTS[id].campaign);
  assert.ok(campaign.length >= 3, 'the First Vow relics still carry the flag');
  for (const [w, h] of SIZES) {
    for (const map of mapsOfSize(w, h)) {
      const leaked = artifactsOn(map).filter((a) => ARTIFACTS[a.artifact].campaign);
      assert.deepEqual(leaked.map((a) => a.artifact), [], `${w}×${h}: campaign relic placed as treasure`);
    }
  }
});

test('treasure: no map the game ships ever repeats an artifact', () => {
  // Two separate things make this true, and both are load-bearing.
  //
  // A failed placement used to consume an artifact anyway — the id was drawn
  // before the spot was looked for — so a crowded map burned about two artifacts
  // for every one it seated and everything past the halfway point came out of
  // the fallback path. `place` now takes a thunk, evaluated only once a spot
  // exists.
  //
  // And artifact seats no longer scale with area without limit
  // (CONFIG.ARTIFACT_DENSITY_CAP_AREA). CAPACITY is not "how many artifacts
  // exist": the top band is reserved — one is seated as the grand prize and the
  // rest are unreachable, because a dry draw steps DOWN a band but never up into
  // the top one — so what the lower bands can cover is (artifacts below the top
  // band) + the one prize. World's Edge used to ask for 110 against 52 and hand
  // out the same sword four times.
  const usable = Object.values(ARTIFACTS).filter((a) => !a.campaign);
  const capacity = usable.filter((a) => a.value < TOP).length + 1;
  for (const [w, h] of SIZES) {
    for (const map of mapsOfSize(w, h)) {
      const list = artifactsOn(map);
      assert.ok(list.length <= capacity,
        `${w}×${h}: seats ${list.length} artifacts but only ${capacity} are reachable`);
      const counts = {};
      for (const a of list) counts[a.artifact] = (counts[a.artifact] || 0) + 1;
      const repeats = Object.entries(counts).filter(([, n]) => n > 1);
      assert.deepEqual(repeats, [],
        `${w}×${h}: ${list.length} artifacts seated, ${capacity} available, yet ${repeats.length} repeated`);
    }
  }
});

test('treasure: the artifact density cap is a size the catalog can actually fill', () => {
  // The test above measures whatever the presets happen to be. This one ties the
  // two knobs together directly, because they can drift apart in either
  // direction: growing CONFIG.ARTIFACT_DENSITY_CAP_AREA without adding artifacts
  // brings the repeats back, and shrinking the catalog under a standing cap does
  // the same. Generate AT the cap and far past it — past the cap the seat count
  // must stop growing, which is the whole mechanism.
  //
  // Only the TOP band is unreachable from below, so the three lower bands behave
  // as one shared pool and what matters is total lower-band supply against total
  // lower-band demand. The margin at the cap size is two artifacts, which is why
  // this sweeps eight seeds rather than trusting one.
  const usable = Object.values(ARTIFACTS).filter((a) => !a.campaign);
  const capacity = usable.filter((a) => a.value < TOP).length + 1;
  const side = Math.round(Math.sqrt(CONFIG.ARTIFACT_DENSITY_CAP_AREA));
  let atCap = 0;
  for (const [w, h] of [[side, side], [side * 2, side * 2]]) {
    for (const seed of [...SEEDS, 5150, 6262, 7373, 8484]) {
      const towns = [];
      const map = generateMap({
        w, h, rng: new Rng(seed),
        players: [{ faction: 'castle' }, { faction: 'inferno' }],
        registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
      });
      const list = artifactsOn(map);
      assert.ok(list.length <= capacity,
        `${w}×${h} seed ${seed}: seats ${list.length} artifacts, ${capacity} reachable — cap and catalog have drifted apart`);
      assert.equal(new Set(list.map((a) => a.artifact)).size, list.length,
        `${w}×${h} seed ${seed}: filled without repeating one`);
      if (w === side) atCap = Math.max(atCap, list.length);
    }
  }
  // …and the cap is not set so low it is throttling maps nobody plays: a map AT
  // the cap should be using most of what the catalog can serve.
  assert.ok(atCap > capacity * 0.6,
    `a map at the cap seats only ${atCap} of ${capacity} — the cap is far below what the catalog could fill`);
});
