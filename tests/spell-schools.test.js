/**
 * spell-schools.test.js — magic schools (Air/Earth/Fire/Water) + their skills.
 *
 * Every spell has a `school`; the matching magic skill (SCHOOL_SKILL) strengthens
 * it in castSpell: more damage/healing (a school-specific fraction, on top of
 * Sorcery) and longer buffs/debuffs (per-spell ladders — see
 * magic-mastery.test.js). A hero without the skill casts EXACTLY as before
 * (zero regression). No Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPELLS, SCHOOL_SKILL } from '../src/data/spells.js';
import { SKILLS } from '../src/data/skills.js';
import { createBattle, castSpell } from '../src/core/combat/CombatEngine.js';
import { heroStat } from '../src/core/heroUtils.js';
import { Rng } from '../src/core/rng.js';

function makeHero(opts = {}) {
  return {
    stats: { attack: 0, defense: 0, power: opts.power ?? 4, knowledge: 5 },
    skills: opts.skills || {},
    equipment: {}, army: [], spells: opts.spells || [], mana: opts.mana ?? 100,
    tempMorale: 0, tempLuck: 0,
  };
}
/** Cast a spell at a fresh battle; return the events. */
function cast(spellId, heroOpts, targetSide = 1) {
  const hero = makeHero({ ...heroOpts, spells: [spellId] });
  const battle = createBattle({
    rng: new Rng(1),
    attacker: { hero, army: [{ creature: 'pikeman', count: 1 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 200 }], playerIndex: 1 },
  });
  const target = battle.units.find((u) => u.side === targetSide);
  const events = castSpell(battle, 0, spellId, { unitId: target.id });
  return { events, battle, target, hero };
}
const dmgOf = (events) => events.find((e) => e.type === 'spellHit')?.damage;

test('data: every spell has a real school; all 4 schools map to a skill', () => {
  for (const [id, sp] of Object.entries(SPELLS)) {
    assert.ok(['air', 'earth', 'fire', 'water'].includes(sp.school), `${id} has a valid school (${sp.school})`);
  }
  for (const school of ['air', 'earth', 'fire', 'water']) {
    const skill = SCHOOL_SKILL[school];
    assert.ok(SKILLS[skill], `${school} → ${skill} is a real skill`);
    assert.equal(SKILLS[skill].levels.length, 3, `${skill} has 3 levels`);
  }
});

test('damage: the matching magic school amplifies the spell; a fresh hero is unchanged', () => {
  const power = heroStat(makeHero({ power: 4 }), 'power');
  const rawBase = SPELLS.fireball.base + SPELLS.fireball.perPower * power; // fire spell

  // No magic skill → exactly the old formula (round(base × sorcery=1)).
  const plain = dmgOf(cast('fireball', { power: 4 }).events);
  assert.equal(plain, Math.round(rawBase), 'no-school hero casts exactly as before');

  // Expert Fire Magic → +35%.
  const expert = dmgOf(cast('fireball', { power: 4, skills: { fireMagic: 3 } }).events);
  assert.equal(expert, Math.round(rawBase * (1 + SKILLS.fireMagic.levels[2])), 'Fire Magic boosts a fire spell');
  assert.ok(expert > plain, 'and it is strictly more');
});

test('damage: the WRONG school does nothing (fireball unmoved by Air Magic)', () => {
  const plain = dmgOf(cast('fireball', { power: 4 }).events);
  const wrong = dmgOf(cast('fireball', { power: 4, skills: { airMagic: 3 } }).events);
  assert.equal(wrong, plain, 'Air Magic leaves a Fire spell untouched');
});

test('damage: Sorcery and school mastery stack multiplicatively', () => {
  const power = heroStat(makeHero({ power: 4 }), 'power');
  const raw = SPELLS.lightningBolt.base + SPELLS.lightningBolt.perPower * power; // air spell
  const both = dmgOf(cast('lightningBolt', { power: 4, skills: { sorcery: 2, airMagic: 3 } }).events);
  const expected = Math.round(raw * (1 + SKILLS.sorcery.levels[1]) * (1 + SKILLS.airMagic.levels[2]));
  assert.equal(both, expected);
});

test('duration: the matching school lengthens the buff — Haste keeps the +1-per-level shape', () => {
  // Duration is per-spell now (spell.durationByLevel): Haste deliberately keeps
  // the old +1-a-level ladder, while a lockout grows slower and a cheap
  // single-stat buff grows faster. See tests/magic-mastery.test.js §3c.
  const rounds = (opts) => {
    const { target } = cast('haste', opts, 0); // haste = air buff, cast on our own stack
    return target.effects.find((e) => e.spellId === 'haste').rounds;
  };
  const base = rounds({ power: 4 });
  const adv = rounds({ power: 4, skills: { airMagic: 2 } });
  assert.equal(adv - base, 2, 'Advanced Air Magic = +2 rounds on Haste');
  // A different school does not extend it.
  assert.equal(rounds({ power: 4, skills: { fireMagic: 3 } }), base, 'Fire Magic leaves Haste untouched');
});

test('healing: the spell’s own school boosts it (Water Magic → Cure), Sorcery does not', () => {
  // Wound our stack, then Cure it and read the healed amount.
  const healed = (skills) => {
    const hero = makeHero({ power: 4, skills, spells: ['cure'] });
    const battle = createBattle({
      rng: new Rng(1),
      attacker: { hero, army: [{ creature: 'angel', count: 3 }], playerIndex: 0 },
      defender: { hero: null, army: [{ creature: 'pikeman', count: 50 }], playerIndex: 1 },
    });
    const u = battle.units.find((x) => x.side === 0);
    u.hp = 1; // heavily wounded top creature
    const ev = castSpell(battle, 0, 'cure', { unitId: u.id });
    return ev.find((e) => e.type === 'heal')?.healed ?? 0;
  };
  const plain = healed({});
  const water = healed({ waterMagic: 3 });
  const sorc = healed({ sorcery: 3 });
  assert.ok(water > plain, 'Water Magic strengthens Cure');
  assert.equal(sorc, plain, 'Sorcery never touches healing');
});
