/**
 * learning-visitables.test.js — Witch Huts (teach a secondary skill) and
 * Shrines of Magic (teach a spell). Both are `booster` map objects carrying a
 * fixed payload (obj.skill / obj.spell) chosen at generation, resolved by
 * actions.applyBooster; once per hero (hero.visited). First quest-layer unit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { SKILLS } from '../src/data/skills.js';
import { SPELLS } from '../src/data/spells.js';
import { newGame, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { stepHero, boosterName, boosterEffect, boosterSpent } from '../src/core/actions.js';
import { generateMap } from '../src/map/MapGenerator.js';
import { Rng } from '../src/core/rng.js';

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
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
function buildMap(seed, w, h) {
  const towns = [];
  const map = generateMap({
    w, h, rng: new Rng(seed), players: [{ faction: 'castle' }, { faction: 'inferno' }],
    registerTown: (t) => { const id = `T${towns.length}`; t.id = id; towns.push(t); return id; },
  });
  return { map, towns };
}

test('Witch Hut: teaches its skill at Basic, once per hero; no-op if already known', () => {
  assert.equal(boosterName('witchHut'), 'Witch Hut');
  assert.match(boosterEffect('witchHut'), /skill/i);

  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 20, 20, 2);
  // Teach a skill the starting hero lacks.
  const skill = Object.keys(SKILLS).find((k) => !hero.skills[k]);
  const hut = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'witchHut', skill });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 2000;

  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'visited');
  assert.equal(ev.name, 'Witch Hut');
  assert.equal(hero.skills[skill], 1, 'learned the skill at Basic');
  assert.equal(hero.visited[hut.id], true, 'once per hero');
  assert.match(ev.text, new RegExp(SKILLS[skill].name));

  // Re-visit: already benefited.
  stepHero(s, hero, { x: spot.x - 1, y: spot.y, cost: 100 });
  const ev2 = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.match(ev2.text, /already benefited/i);
});

test('Witch Hut: a known skill teaches nothing; a full skillset is turned away', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];

  // Already known → nothing to teach. The visit is NOT consumed (see the
  // forget-and-return test below) — nothing was given, so nothing was spent.
  const known = Object.keys(hero.skills)[0];
  const spot = clearBlock(s, 24, 20, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'witchHut', skill: known });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 2000;
  const lvlBefore = hero.skills[known];
  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.match(ev.text, /nothing to teach/i);
  assert.equal(hero.skills[known], lvlBefore, 'no change to a known skill');

  // Full skillset → refused.
  const hero2 = playerHeroes(s, 0)[0];
  hero2.skills = {};
  Object.keys(SKILLS).slice(0, CONFIG.MAX_SECONDARY_SKILLS).forEach((k) => { hero2.skills[k] = 1; });
  const newSkill = Object.keys(SKILLS).find((k) => !hero2.skills[k]);
  const spot2 = clearBlock(s, 28, 24, 2);
  putObj(s, spot2.x, spot2.y, { type: 'booster', boosterType: 'witchHut', skill: newSkill });
  hero2.x = spot2.x - 1; hero2.y = spot2.y; hero2.mp = 2000;
  const ev2 = stepHero(s, hero2, { x: spot2.x, y: spot2.y, cost: 100 });
  assert.match(ev2.text, new RegExp(`${CONFIG.MAX_SECONDARY_SKILLS}`));
  assert.equal(hero2.skills[newSkill], undefined, 'no skill learned past the cap');
});

test('Witch Hut: turned away for lack of a slot, taught after one is freed', () => {
  // Reported: "I didn't have place for tactics, so I 'forgot' a skill, but visiting
  // the [hut] does not help me as [it] was visited unsuccessfully in the past."
  // A refusal used to stamp the visit like a gift, locking the hero out for good.
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.skills = {};
  const ids = Object.keys(SKILLS);
  ids.slice(0, CONFIG.MAX_SECONDARY_SKILLS).forEach((k) => { hero.skills[k] = 1; });
  const wanted = ids.find((k) => !hero.skills[k]);
  const spot = clearBlock(s, 20, 26, 2);
  const hut = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'witchHut', skill: wanted });

  const walkIn = () => {
    hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 2000;
    return stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  };

  const turned = walkIn();
  assert.match(turned.text, /turns you away/i);
  assert.equal(turned.noBenefit, true);
  assert.equal(hero.visited[hut.id], undefined, 'a refusal spends nothing');
  // …but it still reads as SPENT while the slots are full, so nobody — the AI
  // above all — treats it as "worth a look" and shuttles back to it forever.
  assert.equal(boosterSpent(s, hero, hut), true, 'nothing here for a hero with no room');

  // Come back with the slots still full: still refused, still not spent.
  assert.match(walkIn().text, /turns you away/i);
  assert.equal(hero.skills[wanted], undefined);

  // Free a slot (the Hall of Reflection does this in play) and return.
  delete hero.skills[ids[0]];
  assert.equal(boosterSpent(s, hero, hut), false, 'and it is worth a look again the moment there is room');
  const taught = walkIn();
  assert.match(taught.text, new RegExp(SKILLS[wanted].name));
  assert.equal(hero.skills[wanted], 1, 'the witch teaches it at last');
  assert.equal(hero.visited[hut.id], true, 'and NOW the visit is spent');
  assert.match(walkIn().text, /already benefited/i);
});

test('Shrine of Magic: reveals its spell into the spellbook, once; no-op if known', () => {
  assert.equal(boosterName('shrine'), 'Shrine of Magic');
  assert.match(boosterEffect('shrine'), /spell/i);

  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const spell = Object.keys(SPELLS).find((id) => !SPELLS[id].adventure && !(hero.spells || []).includes(id));
  const spot = clearBlock(s, 22, 22, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'shrine', spell });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 2000;

  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'visited');
  assert.ok(hero.spells.includes(spell), 'learned the spell');
  assert.match(ev.text, new RegExp(SPELLS[spell].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // A shrine holding a spell you already know does nothing.
  const spot2 = clearBlock(s, 26, 26, 2);
  putObj(s, spot2.x, spot2.y, { type: 'booster', boosterType: 'shrine', spell });
  hero.x = spot2.x - 1; hero.y = spot2.y; hero.mp = 2000;
  const before = hero.spells.length;
  const ev2 = stepHero(s, hero, { x: spot2.x, y: spot2.y, cost: 100 });
  assert.match(ev2.text, /already know/i);
  assert.equal(hero.spells.length, before, 'no duplicate spell');
});

test('boosterSpent: huts and shrines are once-per-hero', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const fresh = Object.keys(SKILLS).find((k) => !hero.skills[k]);
  const hut = { boosterType: 'witchHut', id: 'WH', skill: fresh };
  const shrine = { boosterType: 'shrine', id: 'SH', spell: 'bless' };
  assert.equal(boosterSpent(s, hero, hut), false);
  assert.equal(boosterSpent(s, hero, shrine), false);
  hero.visited.WH = true; hero.visited.SH = true;
  assert.equal(boosterSpent(s, hero, hut), true);
  assert.equal(boosterSpent(s, hero, shrine), true);
});

test('boosterSpent: a hut is spent for a hero it can teach nothing, visited or not', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const known = Object.keys(hero.skills)[0];
  assert.equal(boosterSpent(s, hero, { boosterType: 'witchHut', id: 'K', skill: known }), true,
    'a skill already held is nothing to walk across a map for');
  const fresh = Object.keys(SKILLS).find((k) => !hero.skills[k]);
  const full = { boosterType: 'witchHut', id: 'F', skill: fresh };
  assert.equal(boosterSpent(s, hero, full), false);
  Object.keys(SKILLS).slice(0, CONFIG.MAX_SECONDARY_SKILLS).forEach((k) => { hero.skills[k] = 1; });
  assert.equal(boosterSpent(s, hero, full), true, 'and neither is one there is no room for');
});

test('a learned skill/spell + the object payload round-trip through save/load', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 20, 24, 2);
  const skill = Object.keys(SKILLS).find((k) => !hero.skills[k]);
  const hut = putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'witchHut', skill });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 2000;
  stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });

  const r = deserialize(serialize(s));
  assert.equal(r.heroes[hero.id].skills[skill], 1, 'the learned skill survives');
  assert.equal(r.map.objects[hut.id].skill, skill, 'the hut payload survives');
});

test('generator: places witch huts + shrines with valid, advertised payloads', () => {
  let sawHut = false, sawShrine = false;
  for (const seed of [101, 202, 303, 404]) {
    const { map } = buildMap(seed, 56, 46);
    for (const o of Object.values(map.objects)) {
      if (o.type !== 'booster') continue;
      if (o.boosterType === 'witchHut') {
        sawHut = true;
        assert.ok(SKILLS[o.skill], `seed ${seed}: witch hut teaches a real skill (${o.skill})`);
      }
      if (o.boosterType === 'shrine') {
        sawShrine = true;
        assert.ok(SPELLS[o.spell], `seed ${seed}: shrine teaches a real spell (${o.spell})`);
        assert.ok(!SPELLS[o.spell].adventure, 'shrines hold combat spells');
      }
    }
  }
  assert.ok(sawHut, 'witch huts appear');
  assert.ok(sawShrine, 'shrines appear');
});
