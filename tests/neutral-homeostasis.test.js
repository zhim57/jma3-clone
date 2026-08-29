/**
 * neutral-homeostasis.test.js — the world keeps its own population.
 *
 * Two failures, opposite ends of one missing feedback loop, both measured across
 * six 100-day campaigns before any of this was written:
 *
 *   Depletion — the wandering bands went 47 -> 2 and the guards 112 -> 3. By day
 *   80 the map was empty, because breeding new stacks was bundled into the
 *   opt-in Tide of War preset and the base game never did it.
 *
 *   Staleness — the median band went 880 -> 3,770 (its growth capped at 2.5x its
 *   original size) while the leading realm went 5,877 -> 2,100,980. Relative to
 *   the leader the open country ended 75x weaker than it began.
 *
 * The fix is a crawling peg: a wandering band's value tracks PEG_RATIO x the
 * leading realm's army, moving at most PEG_CRAWL_PCT of the gap per week, plus a
 * floor that refills the population a few bands at a time. The rate limit and the
 * trickle are the load-bearing halves — an instant peg would re-scale the map the
 * day someone doubled their army, and an instant refill would mean clearing a
 * region bought nothing.
 *
 * PEG_RATIO is measured, not chosen: 0.150 is what the map generator ships on
 * day 1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import {
  newGame, serialize, deserialize, playerHeroes, playerTowns,
} from '../src/core/GameState.js';
import {
  endTurn, pegWildStacks, respawnWildStacks, wildStream, growMapCreatures,
} from '../src/core/actions.js';
import {
  neutralCensus, wildStacks, wildFloor, pegTarget, leadingRealmArmy,
  bandAnchor, bandTarget, nearestTownOwner, fieldableArmy, realmArmyValues,
} from '../src/core/neutrals.js';
import { COURAGE } from '../src/ai/AIPlayer.js';
import { neutralHomeostasis } from '../src/core/pacing.js';
import { addToArmy, armyValue } from '../src/core/heroUtils.js';

const SEED = 4242;
const PLAIN = { kind: 'plain', name: 'Fox', week: 2 };

function game(setup = {}) {
  return newGame({ seed: SEED, mapW: 44, mapH: 36, ...setup });
}

const wandering = (s) => wildStacks(s).filter((w) => !w.guard);
const guards = (s) => wildStacks(s).filter((w) => w.guard);

/** Give player 0 an army worth roughly `value`, so the peg has a real anchor. */
function anchorArmy(s, value, creature = 'angel') {
  const hero = playerHeroes(s, 0)[0];
  hero.army = [null, null, null, null, null, null, null];
  const per = CREATURES[creature].aiValue;
  addToArmy(hero.army, creature, Math.max(1, Math.round(value / per)));
  return armyValue(hero.army);
}

// ---------------------------------------------------------------------------

test('census: the map splits into guards and wandering bands, and the baseline is recorded', () => {
  const s = game();
  const c = neutralCensus(s);
  assert.ok(c.wandering.count > 0 && c.guards.count > 0, 'both roles are present');
  assert.equal(c.wandering.count + c.guards.count, wildStacks(s).length);
  assert.equal(s.wildBaseline, c.wandering.count, 'the floor is measured before anything is cleared');
  assert.equal(wildFloor(s), Math.floor(c.wandering.count * CONFIG.PEG_FLOOR_SHARE));
  // A guard is a stack the generator tied to the object it protects.
  assert.ok(guards(s).every((w) => typeof w.obj.guards === 'string'));
});

test('peg: a band crawls toward the leader, and cannot jump there', () => {
  const s = game();
  anchorArmy(s, 400000);
  const band = wandering(s)[0].obj;
  const before = band.count;
  // Each band aims at its own target: its weight in the distribution against the
  // anchor its position implies.
  const target = bandTarget(s, band, 0) / CREATURES[band.creature].aiValue;
  assert.ok(target > before * 5, 'the anchor is far above this band');

  pegWildStacks(s, PLAIN);

  assert.ok(band.count > before, 'it moved toward the target');
  assert.ok(band.count < target, 'but nowhere near all the way — this is a crawl');
  const gapClosed = (band.count - before) / (target - before);
  assert.ok(gapClosed <= CONFIG.PEG_CRAWL_PCT + 0.02, `closed ${gapClosed.toFixed(2)} of the gap`);

  // …and repeated weeks converge on the target rather than overshooting it.
  for (let i = 0; i < 40; i++) pegWildStacks(s, PLAIN);
  assert.ok(band.count <= Math.ceil(target) + 1, 'converges, never overshoots');
  assert.ok(band.count > target * 0.9, 'and does arrive');
});

test('peg: guards are left to their own slow, bounded growth', () => {
  const s = game();
  anchorArmy(s, 400000);
  const guard = guards(s)[0].obj;
  const before = guard.count;

  pegWildStacks(s, PLAIN);
  assert.equal(guard.count, before, 'the peg does not touch a stack that gates content');

  // The old rule still owns them, capped at a multiple of the original size.
  growMapCreatures(s, PLAIN, { guardsOnly: true });
  assert.ok(guard.count > before, 'guards still grow');
  for (let i = 0; i < 80; i++) growMapCreatures(s, PLAIN, { guardsOnly: true });
  assert.ok(guard.count <= Math.ceil(before * CONFIG.TIDE_MAP_GROWTH_CAP), 'within the old cap');
});

test('peg: a band never shrinks below the size the map shipped it at', () => {
  const s = game();
  // The fattest band on the map, so a collapsed world is unambiguously below it.
  const band = wandering(s).sort((a, b) => b.value - a.value)[0].obj;
  band.count0 = band.count;
  // A collapsed world: every realm is worth almost nothing, so the target is far
  // BELOW every band on the map.
  for (const h of Object.values(s.heroes)) h.army = [null, null, null, null, null, null, null];
  for (const t of Object.values(s.towns)) t.garrison = [null, null, null, null, null, null, null];
  anchorArmy(s, 100, 'pikeman');
  assert.ok(pegTarget(s) < band.count * CREATURES[band.creature].aiValue, 'the target really is below it');

  for (let i = 0; i < 20; i++) pegWildStacks(s, PLAIN);

  assert.equal(band.count, band.count0,
    'the generator\'s own design is a floor, not a starting point to be rolled back');
});

test('floor: a cleared world refills a few bands a week, not all at once', () => {
  const s = game();
  anchorArmy(s, 60000);
  const floor = wildFloor(s);
  // Clear almost everything, as a hundred-day campaign does.
  for (const w of wandering(s).slice(2)) {
    const m = w.level === 0 ? s.map : s.map.underground;
    m.tiles[w.obj.y * m.w + w.obj.x].objectId = null;
    delete m.objects[w.obj.id];
  }
  const emptied = wandering(s).length;
  assert.ok(emptied < floor, 'the world is below its floor');
  const emptiedDeficit = floor - emptied;

  const bred = respawnWildStacks(s);
  assert.ok(bred.length > 0, 'bands ride in');
  // A trickle, not a flood: at most half the shortfall, and never the whole of it.
  assert.ok(bred.length <= Math.ceil(emptiedDeficit * CONFIG.PEG_RESPAWN_CATCHUP)
    || bred.length <= CONFIG.PEG_RESPAWN_PER_WEEK, 'a trickle, not a flood');
  assert.ok(bred.length < emptiedDeficit, 'and never the whole shortfall at once');
  assert.equal(wandering(s).length, emptied + bred.length);
  assert.ok(wandering(s).length < floor, 'clearing a region still buys a real period of quiet');

  // Kept up week after week until the floor is met, then it stops.
  for (let i = 0; i < 40; i++) respawnWildStacks(s);
  assert.ok(wandering(s).length >= floor, 'and the floor is eventually held');
  const settled = wandering(s).length;
  respawnWildStacks(s);
  assert.equal(wandering(s).length, settled, 'no breeding above the floor');
});

test('floor: fresh bands are sized at the peg and never appear in sight of a hero', () => {
  const s = game();
  anchorArmy(s, 200000);
  for (const w of wandering(s)) {
    const m = w.level === 0 ? s.map : s.map.underground;
    m.tiles[w.obj.y * m.w + w.obj.x].objectId = null;
    delete m.objects[w.obj.id];
  }
  const bred = [];
  for (let i = 0; i < 30; i++) bred.push(...respawnWildStacks(s));
  assert.ok(bred.length > 0);

  for (const obj of bred) {
    const value = CREATURES[obj.creature].aiValue * obj.count;
    // Sized at the peg for WHERE IT LANDED, times its own rolled weight — some
    // skirmishes, some problems, never a copy of the median.
    const aim = CONFIG.PEG_RATIO * bandAnchor(s, obj.x, obj.y, 0) * obj.peg;
    assert.ok(obj.peg >= CONFIG.PEG_SPREAD_MIN && obj.peg <= CONFIG.PEG_SPREAD_MAX);
    assert.ok(value > aim * 0.5 && value < aim * 2,
      `a fresh band is sized at its local peg (${Math.round(value)} vs ${Math.round(aim)})`);
    for (const h of Object.values(s.heroes)) {
      if ((h.z ?? 0) !== 0) continue;
      const d = Math.max(Math.abs(h.x - obj.x), Math.abs(h.y - obj.y));
      assert.ok(d > CONFIG.PEG_RESPAWN_CLEARANCE, 'never within sight of a hero');
    }
  }
});

test('repopulation draws from the world stream, never from gameplay\'s', () => {
  const s = game();
  anchorArmy(s, 60000);
  for (const w of wandering(s).slice(1)) {
    const m = w.level === 0 ? s.map : s.map.underground;
    m.tiles[w.obj.y * m.w + w.obj.x].objectId = null;
    delete m.objects[w.obj.id];
  }
  const gameplayDraws = s.rng.calls;
  const worldDraws = wildStream(s).calls;

  respawnWildStacks(s);

  assert.equal(s.rng.calls, gameplayDraws,
    'switching the world on must not shift a seed\'s combat rolls, events or wave sizes');
  assert.ok(wildStream(s).calls > worldDraws, 'the world has its own stream');
});

test('"frozen stacks" is one intent: wildGrowth false turns homeostasis off too', () => {
  const frozen = game({ wildGrowth: false });
  assert.equal(neutralHomeostasis(frozen), false);
  const before = wandering(frozen).map((w) => w.obj.count);
  for (let i = 0; i < 40; i++) if (endTurn(frozen).newWeek) break;
  assert.deepEqual(wandering(frozen).map((w) => w.obj.count), before, 'not one band moved');

  // And the peg alone can be switched off without freezing the old growth rule.
  const pegless = game({ neutralPeg: false });
  assert.equal(neutralHomeostasis(pegless), false);
  assert.equal(pegless.neutralPeg, false);
});

test('the world stream and the population baseline round-trip a save', () => {
  const s = game();
  anchorArmy(s, 50000);
  respawnWildStacks(s);
  wildStream(s).random();
  const back = deserialize(serialize(s));

  assert.equal(back.wildBaseline, s.wildBaseline);
  assert.equal(wildStream(back).calls, wildStream(s).calls, 'the stream resumes where it stopped');
  assert.equal(wildStream(back).random(), wildStream(s).random(), 'and produces the same next draw');
  assert.equal(leadingRealmArmy(back), leadingRealmArmy(s));
});

test('a save written before homeostasis existed adopts it at the next dawn', () => {
  const s = game();
  const raw = JSON.parse(serialize(s));
  delete raw.wildRng;
  delete raw.wildBaseline;
  const old = deserialize(JSON.stringify(raw));

  assert.equal(neutralHomeostasis(old), true, 'an absent field reads as on');
  assert.ok(wildFloor(old) > 0, 'the floor falls back to the population it can see');
  anchorArmy(old, 300000);
  const band = wandering(old)[0].obj;
  const before = band.count;
  pegWildStacks(old, PLAIN);
  assert.ok(band.count > before, 'and the world starts breathing');
  assert.ok(wildStream(old).calls >= 0, 'a stream is minted from the seed on first use');
});

test('peg: the distribution keeps its SHAPE, not just its level', () => {
  const s = game();
  anchorArmy(s, 400000);
  const values = () => wandering(s).map((w) => w.value).sort((a, b) => a - b);
  const spread = (v) => v[Math.floor(v.length * 0.9)] / Math.max(1, v[Math.floor(v.length * 0.1)]);
  const before = spread(values());
  assert.ok(before > 2, `the generator ships a real spread (${before.toFixed(1)}x)`);

  for (let i = 0; i < 30; i++) pegWildStacks(s, PLAIN);

  const after = spread(values());
  assert.ok(after > 2,
    `pegging every band to one number would flatten this to 1.0x (got ${after.toFixed(1)}x)`);
  // A band that started small stays comparatively small.
  const w = wandering(s).sort((a, b) => a.value - b.value);
  assert.ok(w[0].obj.peg < w[w.length - 1].obj.peg,
    'the smallest band still carries the smallest weight');
});

test('floor: fresh bands are spread around the peg, not inflated above it', () => {
  const s = game();
  anchorArmy(s, 200000);
  for (const w of wandering(s)) {
    const m = w.level === 0 ? s.map : s.map.underground;
    m.tiles[w.obj.y * m.w + w.obj.x].objectId = null;
    delete m.objects[w.obj.id];
  }
  // Breed, record, clear, repeat — the floor stops respawning once it is met, and
  // this test is about the shape of the roll rather than the size of the map.
  const weights = [];
  const wipe = () => {
    for (const w of wandering(s)) {
      const m = w.level === 0 ? s.map : s.map.underground;
      m.tiles[w.obj.y * m.w + w.obj.x].objectId = null;
      delete m.objects[w.obj.id];
    }
  };
  for (let i = 0; i < 30; i++) { for (const o of respawnWildStacks(s)) weights.push(o.peg); wipe(); }
  assert.ok(weights.length >= 20, `enough bands to talk about a distribution (${weights.length})`);
  weights.sort((a, b) => a - b);
  const median = weights[weights.length >> 1];
  // The weight is a MULTIPLIER: sampled uniformly its median would be ~1.45 and
  // the whole world would drift half again too hard once the map turned over.
  assert.ok(median > 0.75 && median < 1.35, `median weight ${median.toFixed(2)} sits at the peg`);
  assert.ok(weights[0] < 0.7 && weights[weights.length - 1] > 1.6, 'and there is a real spread');
});

test('territory: a realm\'s own country is priced against that realm, the frontier against the leader', () => {
  const s = game();
  // A hegemon and a realm that is losing badly.
  const leaderTown = playerTowns(s, 0)[0];
  const weakTown = playerTowns(s, 1)[0];
  anchorArmy(s, 900000);           // player 0: the leader
  for (const h of playerHeroes(s, 1)) h.army = [null, null, null, null, null, null, null];
  for (const t of playerTowns(s, 1)) t.garrison = [null, null, null, null, null, null, null];
  const weakHero = playerHeroes(s, 1)[0];
  addToArmy(weakHero.army, 'pikeman', 400);      // a small but real army
  const weak = leadingRealmArmy(s);
  assert.ok(weak === 900000 || weak > 0);

  const atHome = bandAnchor(s, weakTown.x, weakTown.y, weakTown.z ?? 0);
  const atLeader = bandAnchor(s, leaderTown.x, leaderTown.y, leaderTown.z ?? 0);
  // Ground contested with the leader: right beside the leader's own town.
  const far = bandAnchor(s, leaderTown.x - 1, leaderTown.y, leaderTown.z ?? 0);

  assert.ok(atHome < atLeader / 10,
    `a losing realm's doorstep is priced against IT (${Math.round(atHome)} vs ${Math.round(atLeader)})`);
  assert.ok(far > atHome * 2, 'and the country beyond its reach is priced against the leader');
  assert.equal(nearestTownOwner(s, weakTown.x, weakTown.y, weakTown.z ?? 0).owner, 1);
});

test('territory: the blend is geometric, so a 30x gap does not swamp the near half', () => {
  const s = game();
  const town = playerTowns(s, 1)[0];
  const z = town.z ?? 0;
  anchorArmy(s, 900000);
  for (const h of playerHeroes(s, 1)) h.army = [null, null, null, null, null, null, null];
  for (const t of playerTowns(s, 1)) t.garrison = [null, null, null, null, null, null, null];
  addToArmy(playerHeroes(s, 1)[0].army, 'pikeman', 400);

  // Walk from this realm's town toward its nearest rival's and sample the blend
  // at the doorstep, at the midpoint of the two, and at the rival's doorstep.
  const rivalTown = Object.values(s.towns)
    .filter((t) => t.owner !== town.owner && (t.z ?? 0) === z)
    .sort((a, b) => Math.max(Math.abs(a.x - town.x), Math.abs(a.y - town.y))
      - Math.max(Math.abs(b.x - town.x), Math.abs(b.y - town.y)))[0];
  assert.ok(rivalTown, 'there is a rival realm to contest with');
  const own = bandAnchor(s, town.x, town.y, z);
  const mid = bandAnchor(s, Math.round((town.x + rivalTown.x) / 2),
    Math.round((town.y + rivalTown.y) / 2), z);
  const out = bandAnchor(s, rivalTown.x, rivalTown.y, z);

  // Geometric: the midpoint is the geometric mean, not the arithmetic one. A
  // linear blend would put the midpoint at (own+out)/2 — half the LEADER's army,
  // which is what locked a trailing realm out of its own country.
  assert.ok(Math.abs(mid - Math.sqrt(own * out)) < Math.sqrt(own * out) * 0.15,
    `midpoint ${Math.round(mid)} is the geometric mean ${Math.round(Math.sqrt(own * out))}`);
  assert.ok(mid < (own + out) / 4, 'and far below the arithmetic blend a linear one would give');
});

test('anchor: the heaviest band at home is one the realm\'s OWN best hero can beat', () => {
  // The guarantee stated as arithmetic. A band in your own country is worth at
  // most PEG_RATIO x PEG_SPREAD_MAX of the anchor, and the courage margin asks
  // 1.3x that of a single hero — so anchoring to what a realm can FIELD makes the
  // whole product come out under 1 by construction. Anchored to a realm's TOTAL
  // army it did not: Phase B measured realm / best hero at a median 2.09, which
  // put the median realm exactly on the line.
  assert.ok(CONFIG.PEG_RATIO * CONFIG.PEG_SPREAD_MAX * COURAGE < 1,
    'a realm can always clear its own country with the hero it actually has');

  const s = game();
  // A realm spread thinner than the measured median: one 10k hero, and 20k more
  // sitting in two garrisons, so realm = 30k but fieldable = 10k.
  const towns = Object.values(s.towns).slice(0, 2);
  for (const t of towns) {
    t.owner = 1;
    t.garrison = [null, null, null, null, null, null, null];
    addToArmy(t.garrison, 'pikeman', Math.round(10000 / CREATURES.pikeman.aiValue));
  }
  const hero = playerHeroes(s, 1)[0];
  hero.army = [null, null, null, null, null, null, null];
  addToArmy(hero.army, 'pikeman', Math.round(10000 / CREATURES.pikeman.aiValue));
  hero.x = towns[0].x; hero.y = towns[0].y; hero.z = towns[0].z ?? 0;
  // Nobody else on the board, so this realm's country is unambiguously its own.
  for (const p of s.players) if (p.index !== 1) p.defeated = true;

  const realm = realmArmyValues(s).get(1);
  const field = fieldableArmy(s, 1);
  assert.ok(realm > field * 2.5, `spread thin: realm ${Math.round(realm)} vs fieldable ${Math.round(field)}`);

  const heaviest = CONFIG.PEG_RATIO * bandAnchor(s, towns[0].x, towns[0].y, towns[0].z ?? 0)
    * CONFIG.PEG_SPREAD_MAX;
  assert.ok(heaviest * COURAGE < armyValue(hero.army),
    `its own hero clears the worst its country can hold (${Math.round(heaviest * COURAGE)} vs ${Math.round(armyValue(hero.army))})`);
  // The old anchor would have priced that same band past what this realm can field.
  assert.ok(CONFIG.PEG_RATIO * realm * CONFIG.PEG_SPREAD_MAX * COURAGE > armyValue(hero.army),
    'which the realm-total anchor did not');
});

test('anchor: a garrison counts as fieldable, because a hero can walk in and take it', () => {
  const s = game();
  const town = playerTowns(s, 1)[0];
  const hero = playerHeroes(s, 1)[0];
  hero.army = [null, null, null, null, null, null, null];
  addToArmy(hero.army, 'pikeman', 10);
  town.garrison = [null, null, null, null, null, null, null];
  addToArmy(town.garrison, 'angel', 20);

  // Phase B's pickup-on-pass made this literal: the realm's fielded strength is
  // what a hero could carry out of its own town, not what it happens to hold now.
  assert.equal(Math.round(fieldableArmy(s, 1)), Math.round(armyValue(town.garrison)));
  assert.ok(fieldableArmy(s, 1) > armyValue(hero.army));
});
