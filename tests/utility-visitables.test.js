/**
 * utility-visitables.test.js — the Redwood Observatory, Magic Spring and Hill
 * Fort map objects (all on the shared `booster` object type).
 *
 *   - Observatory: a wide one-per-hero fog reveal (no XP).
 *   - Magic Spring: refills mana to MAGIC_SPRING_MULT× max, weekly PER OBJECT
 *     (first hero to drink drains it for everyone until next week).
 *   - Hill Fort: upgrades the hero's army in the field — low tiers free, higher
 *     tiers charged the price difference (unaffordable ones skipped); reusable.
 *
 * Covers each effect, the persistence axis, the shared boosterSpent predicate,
 * save round-trip, and generator placement. No Phaser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { newGame, serialize, deserialize, playerHeroes, weekOf } from '../src/core/GameState.js';
import {
  stepHero, endTurn, boosterName, boosterEffect, boosterSpent,
} from '../src/core/actions.js';
import { heroMaxMana } from '../src/core/heroUtils.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { isExplored } from '../src/map/fog.js';
import { Rng } from '../src/core/rng.js';

// --- local helpers (mirroring tests/scenario-epic.test.js) -----------------

function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const t = m.tiles[y * m.w + x];
      t.obstacle = null; t.terrain = 'grass';
      if (t.objectId) {
        if (m.objects[t.objectId]?.type === 'town') continue;
        delete m.objects[t.objectId]; t.objectId = null;
      }
    }
  }
  return { x: cx, y: cy };
}

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
}

function nextWeek(state) {
  const w0 = weekOf(state.day);
  let guard = 60;
  while (weekOf(state.day) === w0 && guard-- > 0) endTurn(state);
  assert.equal(weekOf(state.day), w0 + 1, 'advanced exactly one week');
}

function buildMap(seed, w, h) {
  const towns = [];
  const map = generateMap({
    w, h, rng: new Rng(seed), players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  return { map, towns };
}

function flood(map, seeds) {
  const { w, h } = map;
  const SOLID = new Set(['town', 'portal', 'subGate']);
  const seen = new Uint8Array(w * h);
  const open = (i) => {
    const t = map.tiles[i];
    if (t.terrain === 'water' || t.obstacle) return false;
    const o = t.objectId && map.objects[t.objectId];
    return !(o && SOLID.has(o.type));
  };
  const st = [];
  for (const s of seeds) { const i = s.y * w + s.x; if (!seen[i]) { seen[i] = 1; st.push(i); } }
  while (st.length) {
    const i = st.pop(), x = i % w;
    if (x > 0 && !seen[i - 1] && open(i - 1)) { seen[i - 1] = 1; st.push(i - 1); }
    if (x < w - 1 && !seen[i + 1] && open(i + 1)) { seen[i + 1] = 1; st.push(i + 1); }
    if (i >= w && !seen[i - w] && open(i - w)) { seen[i - w] = 1; st.push(i - w); }
    if (i < w * h - w && !seen[i + w] && open(i + w)) { seen[i + w] = 1; st.push(i + w); }
  }
  return seen;
}

const nearReachable = (map, seen, o) => {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = o.x + dx, ny = o.y + dy;
      if (nx >= 0 && ny >= 0 && nx < map.w && ny < map.h && seen[ny * map.w + nx]) return true;
    }
  }
  return false;
};

// ---------------------------------------------------------------------------

test('Redwood Observatory: a wide one-per-hero fog reveal, second visit a no-op', () => {
  assert.equal(boosterName('observatory'), 'Redwood Observatory');
  assert.match(boosterEffect('observatory'), /map|lands|surrounding/i);

  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 30, 16, 2);
  const obs = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'observatory' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 1000;

  // A probe inside the observatory's disc but outside the hero's own sight.
  const probe = { x: spot.x, y: spot.y + CONFIG.OBSERVATORY_REVEAL - 1 };
  assert.ok(!isExplored(s, 0, probe.x, probe.y, 0), 'probe starts unexplored');
  const xp0 = hero.xp;

  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'visited');
  assert.equal(ev.name, 'Redwood Observatory');
  assert.ok(isExplored(s, 0, probe.x, probe.y, 0), 'the observatory revealed the far tile');
  assert.ok(!isExplored(s, 1, probe.x, probe.y, 0), "the enemy's fog is untouched");
  assert.equal(hero.xp, xp0, 'no XP (unlike the obelisk)');
  assert.equal(hero.visited[obs.id], true, 'once-per-hero');

  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  const ev2 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.match(ev2.text, /already benefited/i);
});

test('Magic Spring: mana → MULT× max, weekly per object, refreshes next week', () => {
  assert.equal(boosterName('magicSpring'), 'Magic Spring');
  assert.match(boosterEffect('magicSpring'), /mana/i);

  const s = newGame({ seed: 4 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 22, 20, 2);
  const spring = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'magicSpring' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000; hero.mana = 1;

  const ev1 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev1.type, 'visited');
  assert.equal(hero.mana, heroMaxMana(hero) * CONFIG.MAGIC_SPRING_MULT, 'over-filled to MULT× max');
  assert.equal(spring.harvestedWeek, weekOf(s.day), 'the claim is on the OBJECT');

  // Same week: dry for everyone (drain the hero's mana and try again).
  hero.mana = 0;
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  const ev2 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.match(ev2.text, /dry|next week/i);
  assert.equal(hero.mana, 0, 'the dry spring restored nothing');

  // Next week: it wells up again.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  nextWeek(s);
  hero.mp = 4000; hero.mana = 0;
  stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(hero.mana, heroMaxMana(hero) * CONFIG.MAGIC_SPRING_MULT, 'refilled the new week');
});

test('Magic Spring: the over-max mana survives the next dawn (E49)', () => {
  const s = newGame({ seed: 11 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 24, 22, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'magicSpring' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000; hero.mana = 1;

  stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  const max = heroMaxMana(hero);
  const filled = hero.mana;
  assert.equal(filled, max * CONFIG.MAGIC_SPRING_MULT, 'spring over-fills past max');
  assert.ok(filled > max, 'the pool sits above the daily regen clamp');

  // Advance exactly one dawn. The daily regen used to min(max, …)-clamp the pool,
  // wiping the whole weekly perk before it bought a single useful day.
  const day0 = s.day;
  let guard = 20;
  while (s.day === day0 && guard-- > 0) endTurn(s);
  assert.equal(s.day, day0 + 1, 'advanced exactly one day');
  assert.equal(hero.mana, filled, 'the Magic Spring bonus is intact after dawn');
});

test('Hill Fort: upgrades stacks in the field — low tiers free, high tiers charged', () => {
  assert.equal(boosterName('hillFort'), 'Hill Fort');
  assert.match(boosterEffect('hillFort'), /upgrade/i);

  const s = newGame({ seed: 5 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 20, 24, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'hillFort' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000;

  // A tier-1 (free) stack + a tier-7 (charged) stack.
  hero.army = [
    { creature: 'pikeman', count: 10, hurt: 0 },  // → halberdier, free
    { creature: 'angel', count: 2, hurt: 0 },      // → archangel, costs gold+gems
  ];
  const p = s.players[0];
  const upCost = { // angel→archangel diff × 2, from the creature table
    gold: (CREATURES.archangel.cost.gold - CREATURES.angel.cost.gold) * 2,
    gems: (CREATURES.archangel.cost.gems - CREATURES.angel.cost.gems) * 2,
  };
  p.resources.gold = upCost.gold + 100;
  p.resources.gems = upCost.gems + 5;

  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'visited');
  assert.equal(hero.army[0].creature, 'halberdier', 'tier-1 upgraded free');
  assert.equal(hero.army[1].creature, 'archangel', 'tier-7 upgraded for the price difference');
  assert.equal(p.resources.gold, 100, 'the gold difference was charged');
  assert.equal(p.resources.gems, 5, 'the gems difference was charged');

  // Reusable but idempotent: nothing left to upgrade now.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  const ev2 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.match(ev2.text, /nothing/i);
});

test('Hill Fort: a high-tier stack you cannot afford is left unchanged', () => {
  const s = newGame({ seed: 5 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 26, 22, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'hillFort' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000;
  hero.army = [{ creature: 'angel', count: 5, hurt: 0 }];
  s.players[0].resources.gold = 0;
  s.players[0].resources.gems = 0;

  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(hero.army[0].creature, 'angel', 'stayed base — too poor to upgrade');
  assert.match(ev.text, /nothing/i);
});

test('boosterSpent: observatory once-per-hero, spring weekly, hill fort depends on the army', () => {
  const s = newGame({ seed: 7 });
  const hero = playerHeroes(s, 0)[0];
  // Observatory: default once-per-hero.
  const obs = { boosterType: 'observatory', id: 'OB' };
  assert.equal(boosterSpent(s, hero, obs), false);
  hero.visited[obs.id] = true;
  assert.equal(boosterSpent(s, hero, obs), true);
  // Magic Spring: weekly, on the object.
  const spr = { boosterType: 'magicSpring', id: 'SP' };
  assert.equal(boosterSpent(s, hero, spr), false);
  spr.harvestedWeek = weekOf(s.day);
  assert.equal(boosterSpent(s, hero, spr), true);
  // Hill Fort: "spent" only when the army has nothing upgradeable.
  const fort = { boosterType: 'hillFort', id: 'HF' };
  hero.army = [{ creature: 'pikeman', count: 1, hurt: 0 }];
  assert.equal(boosterSpent(s, hero, fort), false, 'has an upgradeable pikeman');
  hero.army = [{ creature: 'halberdier', count: 1, hurt: 0 }];
  assert.equal(boosterSpent(s, hero, fort), true, 'nothing left to upgrade');
  // Affordability gate (B12): a high-tier upgrade the player can't pay for makes
  // the fort "spent" (else the AI eyes a fort it can never use).
  hero.army = [{ creature: 'cavalier', count: 5, hurt: 0 }]; // tier 6 → champion, costs gold
  s.players[hero.owner].resources.gold = 0;
  assert.equal(boosterSpent(s, hero, fort), true, 'unaffordable paid upgrade → spent');
  s.players[hero.owner].resources.gold = 1000000;
  assert.equal(boosterSpent(s, hero, fort), false, 'affordable now → worth a visit');
});

test('a drained Magic Spring round-trips through save/load', () => {
  const s = newGame({ seed: 8 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 24, 20, 2);
  const spring = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'magicSpring' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 4000;
  stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(spring.harvestedWeek, weekOf(s.day));

  const json = serialize(s);
  const s2 = deserialize(json);
  assert.equal(s2.map.objects[spring.id].harvestedWeek, weekOf(s2.day), 'claim survives a reload');
  assert.equal(serialize(deserialize(json)), json, 'round-trip is a fixed point');
});

test('generator: observatory, hill fort and magic spring appear and are reachable', () => {
  const kinds = ['observatory', 'hillFort', 'magicSpring'];
  const seenKind = Object.fromEntries(kinds.map((k) => [k, false]));
  for (const seed of [101, 202, 303, 404]) {
    const { map, towns } = buildMap(seed, 56, 46);
    const seen = flood(map, towns.map((t) => ({ x: t.x, y: t.y })));
    for (const o of Object.values(map.objects)) {
      if (o.type !== 'booster' || !kinds.includes(o.boosterType)) continue;
      seenKind[o.boosterType] = true;
      assert.ok(nearReachable(map, seen, o), `seed ${seed}: ${o.boosterType} foot-reachable`);
    }
  }
  for (const k of kinds) assert.ok(seenKind[k], `${k} appears on generated maps`);
});
