/**
 * pandora.test.js — Pandora's Box: a one-time object that yields a big, VARIED
 * reward (map RPG layer, part C). A box rolls a reward + guard at generation and
 * stamps them on the object. A guarded box fights first (combatContext →
 * applyCombatResult wins the reward); an UNGUARDED box is a free find that opens
 * on contact (stepHero → interactWithObject). Engine only, no Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CREATURES } from '../src/data/creatures.js';
import { ARTIFACTS } from '../src/data/artifacts.js';
import { SPELLS } from '../src/data/spells.js';
import { Rng } from '../src/core/rng.js';
import {
  rollPandoraReward, rollPandoraGuard, pandoraRewardValue, PANDORA_GUARD_MAX,
  GUARD_STACK_MIN, GUARD_STACK_MAX,
} from '../src/data/pandora.js';
import { creaturePower } from '../src/core/power.js';
import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import {
  stepHero, applyCombatResult, pandoraRewardText,
} from '../src/core/actions.js';
import { isWalkable } from '../src/map/Pathfinding.js';
import { revealAround } from '../src/map/fog.js';

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, ...data };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}
function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    const t = m.tiles[y * m.w + x];
    t.obstacle = null; t.terrain = 'grass';
    if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; }
  }
  return { x: cx, y: cy };
}
function seatBox(s, { reward, guards }, cx = 22, cy = 20) {
  clearBlock(s, cx, cy, 2);
  const box = putObj(s, cx, cy, { type: 'pandora', looted: false, reward, guards });
  revealAround(s, 0, cx, cy, 5);
  return box;
}
const win = (hero, xp = 500) => ({ attackerWon: true, attackerArmy: hero.army.filter(Boolean).map((s) => ({ ...s })), defenderArmy: [], xp });

test('rolled rewards + guards reference only real content (many draws)', () => {
  const rng = new Rng(12345);
  const kinds = new Set();
  let free = 0, guarded = 0;
  for (let i = 0; i < 400; i++) {
    const r = rollPandoraReward(rng);
    kinds.add(r.kind);
    if (r.kind === 'artifact') assert.ok(ARTIFACTS[r.artifact], `real artifact ${r.artifact}`);
    if (r.kind === 'spell') assert.ok(SPELLS[r.spell], `real spell ${r.spell}`);
    if (r.kind === 'creatures') for (const c of r.creatures) assert.ok(CREATURES[c.creature] && c.count > 0, `real creature ${c.creature}`);
    if (r.kind === 'resource') assert.ok(r.amount > 0 && typeof r.resource === 'string');
    if (r.kind === 'xp' || r.kind === 'mana') assert.ok(r.amount > 0);
    assert.ok(pandoraRewardValue(r) > 0, `${r.kind} has a positive AI value`);

    const g = rollPandoraGuard(rng);
    if (!g.length) { free++; continue; }
    guarded++;
    for (const st of g) assert.ok(CREATURES[st.creature] && st.count >= 1, `real guard ${st.creature} x${st.count}`);
  }
  // The full palette should show up over 400 draws, and both guarded + free boxes occur.
  for (const k of ['xp', 'resource', 'artifact', 'spell', 'creatures', 'mana']) assert.ok(kinds.has(k), `saw a ${k} reward`);
  assert.ok(free > 0 && guarded > 0, `both free (${free}) and guarded (${guarded}) boxes roll`);
});

test('a guarded box blocks pathing and storming it fights the guard', () => {
  const s = newGame({ seed: 21 });
  const hero = playerHeroes(s, 0)[0];
  const box = seatBox(s, { reward: { kind: 'resource', resource: 'gold', amount: 5000 }, guards: [{ creature: 'troll', count: 6 }] });
  hero.x = box.x - 1; hero.y = box.y; hero.z = 0; hero.mp = 2000;

  assert.equal(isWalkable(s, box.x, box.y, 0), false, 'a guarded box blocks through-traffic');
  const ev = stepHero(s, hero, { x: box.x, y: box.y, cost: 100 });
  assert.equal(ev.type, 'combat');
  assert.equal(ev.context.defender.kind, 'pandora');
  assert.deepEqual(ev.context.defenderArmy.map((a) => a.creature), ['troll'], 'the box fields its guard');
  assert.equal(hero.x, box.x - 1, 'the attacker fights from outside the box tile');
});

test('victory opens a guarded box, pays the reward, and makes it walkable', () => {
  const s = newGame({ seed: 22 });
  const hero = playerHeroes(s, 0)[0];
  const box = seatBox(s, { reward: { kind: 'resource', resource: 'gold', amount: 4200 }, guards: [{ creature: 'medusa', count: 4 }] });
  hero.x = box.x - 1; hero.y = box.y; hero.z = 0; hero.mp = 2000;
  const goldBefore = s.players[0].resources.gold;

  const ctx = stepHero(s, hero, { x: box.x, y: box.y, cost: 100 }).context;
  const events = applyCombatResult(s, ctx, win(hero));
  const opened = events.find((e) => e.type === 'pandoraOpened');
  assert.ok(opened, 'a pandoraOpened event fires');
  assert.equal(opened.reward.kind, 'resource');
  assert.equal(box.looted, true, 'the box is spent');
  assert.equal(s.players[0].resources.gold - goldBefore, 4200, 'the gold reward was paid');
  assert.equal(isWalkable(s, box.x, box.y, 0), true, 'a spent box is an inert, walkable husk');
});

test('an UNGUARDED box is a free find that opens on contact', () => {
  const s = newGame({ seed: 23 });
  const hero = playerHeroes(s, 0)[0];
  const box = seatBox(s, { reward: { kind: 'creatures', creatures: [{ creature: 'griffin', count: 5 }] }, guards: [] });
  hero.x = box.x - 1; hero.y = box.y; hero.z = 0; hero.mp = 2000;

  assert.equal(isWalkable(s, box.x, box.y, 0), true, 'an unguarded box does not block pathing');
  const ev = stepHero(s, hero, { x: box.x, y: box.y, cost: 100 });
  assert.equal(ev.type, 'pandora', 'stepping onto it opens it (no combat)');
  assert.equal(ev.reward.kind, 'creatures');
  assert.ok(hero.army.some((st) => st && st.creature === 'griffin'), 'the reward griffins joined the hero');
  assert.equal(box.looted, true, 'the box is spent');
  assert.equal(hero.x, box.x, 'the hero moved onto the now-inert tile');
});

test('an experience box can level the hero up and flags a levelUp event', () => {
  const s = newGame({ seed: 24 });
  const hero = playerHeroes(s, 0)[0];
  hero.xp = 0; hero.level = 1;
  const box = seatBox(s, { reward: { kind: 'xp', amount: 5000 }, guards: [] });
  hero.x = box.x - 1; hero.y = box.y; hero.z = 0; hero.mp = 2000;

  const ev = stepHero(s, hero, { x: box.x, y: box.y, cost: 100 });
  assert.equal(ev.type, 'pandora');
  assert.equal(ev.reward.kind, 'xp');
  assert.ok(hero.xp >= 5000 && hero.level > 1, 'the hero gained XP and leveled up');
  assert.ok(ev.levels > 0, 'the event reports the levels gained');
  assert.ok(ev.events?.some((e) => e.type === 'levelUp'), 'a levelUp event is bundled for the view');
});

test('a repelled assault thins the guard but leaves the reward and the block', () => {
  const s = newGame({ seed: 25 });
  const hero = playerHeroes(s, 0)[0];
  const box = seatBox(s, { reward: { kind: 'artifact', artifact: Object.keys(ARTIFACTS)[0] }, guards: [{ creature: 'troll', count: 8 }] });
  hero.x = box.x - 1; hero.y = box.y; hero.z = 0; hero.mp = 2000;
  const ctx = stepHero(s, hero, { x: box.x, y: box.y, cost: 100 }).context;
  const loss = { attackerWon: false, attackerArmy: [], defenderArmy: [{ creature: 'troll', count: 3, hurt: 0 }], xp: 0 };
  applyCombatResult(s, ctx, loss);
  assert.equal(box.looted, false, 'the box is NOT opened on a loss');
  assert.deepEqual(box.guards, [{ creature: 'troll', count: 3 }], 'the guard is thinned to the survivors');
  assert.equal(isWalkable(s, box.x, box.y, 0), false, 'still blocks (still guarded)');
});

test('pandoraRewardText describes every reward kind', () => {
  assert.match(pandoraRewardText({ kind: 'xp', amount: 3500 }), /3500 experience/);
  assert.match(pandoraRewardText({ kind: 'mana', amount: 12 }), /12 spell points/);
  assert.match(pandoraRewardText({ kind: 'resource', resource: 'gems', amount: 10 }), /10 gems/);
  assert.ok(pandoraRewardText({ kind: 'artifact', artifact: Object.keys(ARTIFACTS)[0] }).length > 0);
  const anySpell = Object.keys(SPELLS).find((id) => !SPELLS[id].adventure);
  assert.match(pandoraRewardText({ kind: 'spell', spell: anySpell }), /spell/);
  assert.match(pandoraRewardText({ kind: 'creatures', creatures: [{ creature: 'griffin', count: 4 }] }), /4 .*[Gg]riffin/);
});

test('a box survives a save/load round-trip (looted flag + reward + mutable guards)', () => {
  const s = newGame({ seed: 26 });
  const box = seatBox(s, { reward: { kind: 'resource', resource: 'crystal', amount: 11 }, guards: [{ creature: 'medusa', count: 2 }] });
  box.guards = [{ creature: 'medusa', count: 1 }]; // a thinned guard
  const back = deserialize(serialize(s));
  const b2 = back.map.objects[box.id];
  assert.equal(b2.type, 'pandora');
  assert.equal(b2.looted, false);
  assert.deepEqual(b2.reward, { kind: 'resource', resource: 'crystal', amount: 11 });
  assert.deepEqual(b2.guards, [{ creature: 'medusa', count: 1 }]);
});


// ---------------------------------------------------------------------------
// The guard is sized by the prize
// ---------------------------------------------------------------------------
//
// It used to be rolled blind: a flat 35% free find, otherwise a flat 2500–5000
// budget, with no sight of the reward. Measured over 40 000 rolls the
// correlation between what a box was worth and what stood over it was 0.005 —
// none — while this very module's valuation comment claimed the gold-equivalent
// "is what scales its GUARD". A third of the richest boxes (a 25 000-gold hoard,
// a 396 000-experience jackpot that takes a level-10 hero to 25) were free
// finds, and two thirds of the poorest — ten spell points — sat behind a real
// battle.

// A guard is priced as a FIGHT, not as loot: you never take it home, so what it
// costs you is power (src/core/power.js), and the rule below — never fight for
// less than the fight costs — only reads true when risk and reward are each in
// their own honest currency.
const guardValue = (g) => g.reduce((n, st) => n + creaturePower(st.creature) * st.count, 0);
const sample = (n, seed = 4242) => {
  const rng = new Rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const reward = rollPandoraReward(rng);
    const guards = rollPandoraGuard(rng, reward);
    out.push({ reward, worth: pandoraRewardValue(reward), guard: guardValue(guards) });
  }
  return out;
};

test('a box\'s guard tracks the prize it stands over', () => {
  const rows = sample(4000);
  const mv = rows.reduce((n, r) => n + r.worth, 0) / rows.length;
  const mg = rows.reduce((n, r) => n + r.guard, 0) / rows.length;
  let num = 0, dx = 0, dy = 0;
  for (const r of rows) { num += (r.worth - mv) * (r.guard - mg); dx += (r.worth - mv) ** 2; dy += (r.guard - mg) ** 2; }
  const corr = num / Math.sqrt(dx * dy);
  assert.ok(corr > 0.5, `reward/guard correlation is ${corr.toFixed(3)} — the guard is not reading the prize`);

  // The rich are not free, and the poor are not overcharged. Both directions,
  // because a rule that only bounded one of them would leave the other defect.
  const rich = rows.filter((r) => r.worth >= 8000);
  assert.ok(rich.length, 'the sample contains rich boxes at all');
  const richFree = rich.filter((r) => r.guard === 0).length / rich.length;
  assert.ok(richFree < 0.15, `${(richFree * 100).toFixed(0)}% of the richest boxes are free finds`);
  for (const r of rows) {
    if (!r.guard) continue;
    assert.ok(r.guard <= r.worth * 3,
      `a ${r.reward.kind} box worth ${Math.round(r.worth)} is guarded by ${r.guard} — you would fight for less than the fight costs`);
    assert.ok(r.guard <= PANDORA_GUARD_MAX * 1.5, `guard ${r.guard} runs away past the cap`);
  }
  // …and a free find still exists. The point was never to guard everything.
  assert.ok(rows.some((r) => r.guard === 0), 'free finds still happen');
});

test('rollPandoraGuard draws the same number of times as it always did', () => {
  // A box's guard is rolled during MAP GENERATION, so the number of draws this
  // makes is load-bearing for every layout downstream of it: one draw when the
  // free-find test passes, three when it does not. The budget and the species
  // filter must not cost an extra draw however narrow the pool gets.
  const counting = (seed) => {
    const rng = new Rng(seed);
    let n = 0;
    const wrap = {
      random: () => { n++; return rng.random(); },
      int: (a, b) => { n++; return rng.int(a, b); },
      pick: (a) => { n++; return rng.pick(a); },
      chance: (p) => { n++; return rng.chance(p); },
    };
    return { wrap, count: () => n };
  };
  for (const kind of [
    { kind: 'mana', amount: 10 },                       // the cheapest prize there is
    { kind: 'resource', resource: 'gold', amount: 25000 }, // and the richest
  ]) {
    for (let seed = 1; seed <= 40; seed++) {
      const { wrap, count } = counting(seed);
      const g = rollPandoraGuard(wrap, kind);
      assert.equal(count(), g.length ? 3 : 1,
        `${kind.kind}: ${count()} draws for a ${g.length ? 'guarded' : 'free'} box`);
    }
  }
});

test('a box values an artifact by its rarity band, not at a flat rate', () => {
  const byBand = {};
  for (const [id, a] of Object.entries(ARTIFACTS)) (byBand[a.value] ||= id);
  const low = pandoraRewardValue({ kind: 'artifact', artifact: byBand[1] });
  const top = pandoraRewardValue({ kind: 'artifact', artifact: byBand[4] });
  assert.ok(top > low * 2,
    `a top-band relic values at ${top} against a value-1 trinket's ${low} — the band is being ignored`);
  // …and that number is what sizes the guard, so the two must move together.
  const rng = new Rng(7);
  const g = (art) => guardValue(rollPandoraGuard(rng, { kind: 'artifact', artifact: art }));
  const lows = Array.from({ length: 200 }, () => g(byBand[1])).reduce((a, b) => a + b, 0);
  const tops = Array.from({ length: 200 }, () => g(byBand[4])).reduce((a, b) => a + b, 0);
  assert.ok(tops > lows, 'the box hiding a top-band relic is the better-guarded one');
});

test('no box ever holds a campaign relic', () => {
  const rng = new Rng(31337);
  for (let i = 0; i < 4000; i++) {
    const r = rollPandoraReward(rng);
    if (r.kind === 'artifact') assert.ok(!ARTIFACTS[r.artifact].campaign, `a box held ${r.artifact}`);
  }
});

test('a spell box the hero could not use says so instead of claiming a reward', () => {
  // The one reward kind that can silently be a no-op was also the one that
  // claimed otherwise: `got.spell` was set whether or not the spell was learned,
  // so the toast read "Pandora's Box yields the Haste spell!" and the spellbook
  // was unchanged.
  const s = newGame({ seed: 77 });
  const hero = playerHeroes(s, 0)[0];
  const known = Object.keys(SPELLS).find((id) => !SPELLS[id].adventure);
  if (!hero.spells.includes(known)) hero.spells.push(known);
  const before = hero.spells.length;
  const box = seatBox(s, { reward: { kind: 'spell', spell: known }, guards: [] });
  hero.x = box.x - 1; hero.y = box.y; hero.z = 0; hero.mp = 2000;
  const ev = stepHero(s, hero, { x: box.x, y: box.y, cost: 100 });
  assert.equal(hero.spells.length, before, 'nothing was learned');
  assert.equal(ev.reward.spell, undefined, 'and nothing is reported as learned');
  assert.equal(ev.reward.knewSpell, known, 'the box says which spell it wasted');
  assert.match(pandoraRewardText(ev.reward), /already/, 'and the toast tells the player');

  // The ordinary case still reads as a gift.
  const fresh = Object.keys(SPELLS).find((id) => !SPELLS[id].adventure && !hero.spells.includes(id));
  const box2 = seatBox(s, { reward: { kind: 'spell', spell: fresh }, guards: [] }, 26, 20);
  hero.x = box2.x - 1; hero.y = box2.y; hero.mp = 2000;
  const ev2 = stepHero(s, hero, { x: box2.x, y: box2.y, cost: 100 });
  assert.equal(ev2.reward.spell, fresh);
  assert.ok(hero.spells.includes(fresh));
  assert.doesNotMatch(pandoraRewardText(ev2.reward), /already/);
});


test('a box\'s guard is always a stack you can size up at a glance', () => {
  // The map generator picks a wandering guard's species so the budget lands in
  // 3..60 of it — a readable stack. The box's guard is scouted the same way, off
  // the same hover ("Guarded by N Rogues"), and must obey the same bound.
  //
  // Only the floor was here at first, and the ceiling is the half that bites at
  // the top of the range: 20 000 of budget spent on rogues is 148 of them. On
  // real 72×60 maps 2.5% of guarded boxes were over the line, the worst a stack
  // of 152. Both ends are enforced by choosing a SPECIES that fits the budget
  // rather than by clamping a bad choice after the fact — a clamp alone would
  // quietly stop the guard being worth what it was sized to be.
  let guarded = 0;
  const rng = new Rng(909);
  const seen = new Set();
  for (let i = 0; i < 6000; i++) {
    const reward = rollPandoraReward(rng);
    const guards = rollPandoraGuard(rng, reward);
    if (!guards.length) continue;
    guarded++;
    for (const st of guards) {
      seen.add(st.creature);
      assert.ok(st.count >= GUARD_STACK_MIN && st.count <= GUARD_STACK_MAX,
        `${st.count} ${st.creature} guarding a ${reward.kind} box worth ${Math.round(pandoraRewardValue(reward))}`);
    }
  }
  assert.ok(guarded > 1000, `the sweep produced ${guarded} guarded boxes`);
  assert.ok(seen.size >= 3, 'and the species still vary rather than collapsing onto one that always fits');
});
