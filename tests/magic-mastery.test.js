/**
 * magic-mastery.test.js — what being EXPERT in a magic school actually does.
 *
 * Two claims, and the second is the one that changes battles:
 *
 *   1. A spell in a hero's own school costs less mana. Modest, floored at 1, and
 *      exactly zero for a hero with no school skill — the catalog price is what
 *      an unskilled hero has always paid and must keep paying.
 *
 *   2. At EXPERT, a spell the catalog flags `mass` stops being single-target and
 *      covers the whole line: Expert Air Magic hastes all seven friendly stacks,
 *      Expert Earth Magic slows every enemy, for the price of one cast.
 *
 * The interesting tests are the ones about what mastery does NOT do. Blind and
 * Frenzy stay single-target at any level (they are flagged, or rather not
 * flagged, in the catalog for exactly that reason). A mass cast applies the SAME
 * per-stack rules as a single one — a Black Dragon still shrugs it off, Sorrow
 * still fizzles on the undead — because the engine runs one enchant() per stack
 * rather than a second copy of the rules. And the price is the price the
 * spellbook quoted: canCast, castSpell and the UI all read src/core/magic.js.
 *
 * No Phaser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPELLS } from '../src/data/spells.js';
import { CONFIG } from '../src/config.js';
import {
  spellCost, isMassCast, schoolLevel, masteryNote, effectSummary, effectDetail, effectMood,
  effectsAtLevel, spellEffects, durationAtLevel, spellDuration, massSide,
} from '../src/core/magic.js';
import { createBattle, castSpell, canCast, massCastTargets, unitSpeed } from '../src/core/combat/CombatEngine.js';
import { maybeCastAISpell } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

function makeHero(opts = {}) {
  return {
    name: opts.name || 'Mage',
    stats: { attack: 0, defense: 0, power: opts.power ?? 4, knowledge: 5 },
    skills: opts.skills || {},
    equipment: {}, army: [], spells: opts.spells || [], mana: opts.mana ?? 100,
    tempMorale: 0, tempLuck: 0,
  };
}

/** A battle with a multi-stack army on each side, so "all stacks" has teeth. */
function field(heroOpts, opts = {}) {
  const hero = makeHero(heroOpts);
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: new Rng(7),
    attacker: {
      hero,
      army: opts.ours || [
        { creature: 'pikeman', count: 40 }, { creature: 'archer', count: 30 },
        { creature: 'griffin', count: 20 }, { creature: 'swordsman', count: 15 },
      ],
      playerIndex: 0,
    },
    defender: {
      hero: opts.foeHero ?? null,
      army: opts.theirs || [
        { creature: 'gnoll', count: 40 }, { creature: 'lizardman', count: 30 },
        { creature: 'serpentFly', count: 20 },
      ],
      playerIndex: 1,
    },
  });
  return { hero, battle };
}
const ours = (b) => b.units.filter((u) => u.side === 0 && u.alive);
const theirs = (b) => b.units.filter((u) => u.side === 1 && u.alive);
const carries = (u, id) => u.effects.some((e) => e.spellId === id);

// ---------------------------------------------------------------------------
// 1. The price
// ---------------------------------------------------------------------------

test('cost: an unskilled hero pays the catalog price for every spell', () => {
  const plain = makeHero();
  for (const [id, sp] of Object.entries(SPELLS)) {
    assert.equal(spellCost(plain, id), sp.manaCost, `${id} unchanged without a school skill`);
  }
});

test('cost: mastery of the spell’s OWN school discounts it; another school does not', () => {
  const base = SPELLS.haste.manaCost;
  const expert = makeHero({ skills: { airMagic: 3 } });
  const wrong = makeHero({ skills: { earthMagic: 3 } });

  assert.equal(spellCost(expert, 'haste'),
    Math.max(1, Math.round(base * (1 - CONFIG.SPELL_SCHOOL_DISCOUNT[2]))));
  assert.ok(spellCost(expert, 'haste') < base, 'and it is strictly cheaper');
  assert.equal(spellCost(wrong, 'haste'), base, 'Earth Magic does not discount an Air spell');

  // The discount deepens with the skill, and never makes a spell free.
  const costs = [0, 1, 2, 3].map((lvl) => spellCost(makeHero({ skills: { airMagic: lvl } }), 'haste'));
  for (let i = 1; i < costs.length; i++) assert.ok(costs[i] <= costs[i - 1], 'monotone in skill level');
  assert.ok(Math.min(...costs) >= 1, 'never free');
});

test('cost: the discount is what canCast checks and what castSpell charges', () => {
  const { hero, battle } = field({ skills: { airMagic: 3 }, spells: ['haste'] });
  const cost = spellCost(hero, 'haste');
  assert.ok(cost < SPELLS.haste.manaCost, 'there is a discount to test');

  hero.mana = cost - 1;
  assert.equal(canCast(battle, 0, 'haste'), false, 'one short is still short');
  hero.mana = cost;
  assert.equal(canCast(battle, 0, 'haste'), true, 'the mastered price is the bar');

  castSpell(battle, 0, 'haste', {});
  assert.equal(hero.mana, 0, 'and exactly the mastered price is taken');
});

// ---------------------------------------------------------------------------
// 2. The mass cast
// ---------------------------------------------------------------------------

test('mass: Expert Air Magic hastes EVERY friendly stack for one cast', () => {
  const { hero, battle } = field({ skills: { airMagic: 3 }, spells: ['haste'] });
  const before = ours(battle).map((u) => unitSpeed(battle, u));

  const events = castSpell(battle, 0, 'haste', {}); // no target at all

  assert.ok(ours(battle).length >= 4, 'a real line to sweep');
  for (const u of ours(battle)) assert.ok(carries(u, 'haste'), `${u.creature} is hasted`);
  for (const u of theirs(battle)) assert.ok(!carries(u, 'haste'), 'the enemy is not');
  const swing = spellEffects(hero, 'haste').speed;   // Expert Air is +5, not the catalog's +3
  ours(battle).forEach((u, i) => assert.equal(unitSpeed(battle, u), before[i] + swing));
  assert.equal(events.filter((e) => e.type === 'spellEffect').length, ours(battle).length);
  assert.ok(events.every((e) => e.type !== 'spellEffect' || e.mass), 'events are marked mass for the log');
  assert.equal(hero.mana, 100 - spellCost(hero, 'haste'), 'one cast, one price');
  assert.equal(battle.sides[0].castThisRound, true, 'and still only one cast this round');
});

test('mass: Expert Earth Magic slows every ENEMY stack and leaves ours alone', () => {
  const { battle } = field({ skills: { earthMagic: 3 }, spells: ['slow'] });
  castSpell(battle, 0, 'slow', {});
  for (const u of theirs(battle)) assert.ok(carries(u, 'slow'), `${u.creature} is slowed`);
  for (const u of ours(battle)) assert.ok(!carries(u, 'slow'), 'our own line is untouched');
});

test('mass: below Expert the same spell is still one stack at a time', () => {
  for (const lvl of [0, 1, 2]) {
    const { hero, battle } = field({ skills: { airMagic: lvl }, spells: ['haste'] });
    assert.equal(isMassCast(hero, 'haste'), false, `level ${lvl} does not mass`);
    const t = ours(battle)[0];
    castSpell(battle, 0, 'haste', { unitId: t.id });
    assert.equal(ours(battle).filter((u) => carries(u, 'haste')).length, 1, `level ${lvl}: exactly one stack`);
  }
});

test('mass: a targetless cast of a NON-mass spell is still refused, unpaid', () => {
  const { hero, battle } = field({ skills: { airMagic: 3 }, spells: ['lightningBolt'] });
  const events = castSpell(battle, 0, 'lightningBolt', {});
  assert.equal(events.length, 0, 'refused');
  assert.equal(hero.mana, 100, 'no mana spent');
  assert.equal(battle.sides[0].castThisRound, false, 'the round’s cast is not burned');
});

test('mass: Expert Air sweeps Disrupting Ray over the whole enemy line', () => {
  // Air's second mass spell, and the one that carries it. Deliberately NOT a
  // HoMM3 rule (Disrupting Ray is single-target there) — see docs/MAGIC_SCHOOLS.md
  // §2: Air's only sweep was Haste, and Haste is the one effect this engine
  // barely rewards, so Air had a mastery that bought nothing.
  const { hero, battle } = field({ skills: { airMagic: 3 }, spells: ['disruptingRay'] });
  assert.equal(isMassCast(hero, 'disruptingRay'), true);
  castSpell(battle, 0, 'disruptingRay', {});
  for (const u of theirs(battle)) {
    const e = u.effects.find((x) => x.spellId === 'disruptingRay');
    assert.ok(e, `${u.creature} is hexed`);
    assert.equal(e.effects.defense, -5, 'at the Expert magnitude');
  }
  for (const u of ours(battle)) assert.ok(!carries(u, 'disruptingRay'), 'our own line is untouched');

  // Below Expert it is still one stack at a time.
  for (const lvl of [0, 1, 2]) {
    const f = field({ skills: { airMagic: lvl }, spells: ['disruptingRay'] });
    assert.equal(isMassCast(f.hero, 'disruptingRay'), false, `level ${lvl}`);
    castSpell(f.battle, 0, 'disruptingRay', { unitId: theirs(f.battle)[0].id });
    assert.equal(theirs(f.battle).filter((u) => carries(u, 'disruptingRay')).length, 1);
  }
});

test('mass: Air owns exactly two sweeps, and they pull in opposite directions', () => {
  const airExpert = makeHero({ skills: { airMagic: 3 } });
  const air = Object.keys(SPELLS).filter((id) => SPELLS[id].school === 'air' && isMassCast(airExpert, id));
  assert.deepEqual(air.sort(), ['disruptingRay', 'haste'],
    'Haste on our line, Disrupting Ray on theirs');
  // The point of the pairing: one ADDS to us, one SUBTRACTS from them, and this
  // engine pays far better for the second (docs/MAGIC_SCHOOLS.md §7).
  assert.equal(massSide('haste'), 'friendly');
  assert.equal(massSide('disruptingRay'), 'enemy');
});

test('mass: Blind and Frenzy stay single-target however expert the caster', () => {
  const airExpert = makeHero({ skills: { airMagic: 3, fireMagic: 3, earthMagic: 3, waterMagic: 3 } });
  assert.equal(isMassCast(airExpert, 'blind'), false, 'Blind is never mass');
  assert.equal(isMassCast(airExpert, 'frenzy'), false, 'Frenzy is never mass');
  assert.equal(isMassCast(airExpert, 'resurrection'), false, 'Resurrection is never mass');
  // …and a mass-flagged spell of the same school at the same level IS mass.
  assert.equal(isMassCast(airExpert, 'curse'), true, 'Curse (fire, flagged) is');
});

test('mass: every mass-flagged spell is a buff, debuff or heal — never a nuke', () => {
  for (const [id, sp] of Object.entries(SPELLS)) {
    if (!sp.mass) continue;
    assert.ok(['buff', 'debuff', 'heal'].includes(sp.kind), `${id} is enchantment, not damage`);
    assert.ok(!sp.adventure, `${id} is a combat spell`);
  }
});

// ---------------------------------------------------------------------------
// 3. A mass cast obeys the SAME per-stack rules as a single one
// ---------------------------------------------------------------------------

test('mass: a spell-immune stack shrugs off the sweep, the rest still take it', () => {
  const { battle } = field({ skills: { earthMagic: 3 }, spells: ['slow'] }, {
    theirs: [{ creature: 'blackDragon', count: 2 }, { creature: 'gnoll', count: 30 }],
  });
  const events = castSpell(battle, 0, 'slow', {});
  const dragon = theirs(battle).find((u) => u.creature === 'blackDragon');
  const gnoll = theirs(battle).find((u) => u.creature === 'gnoll');
  assert.ok(!carries(dragon, 'slow'), 'magic never touches a Black Dragon');
  assert.ok(carries(gnoll, 'slow'), 'but the stack beside it is slowed');
  assert.equal(events.filter((e) => e.type === 'spellFizzle').length, 1);
});

test('mass: Sorrow fizzles on the undead and lands on everyone else', () => {
  const { battle } = field({ skills: { earthMagic: 3 }, spells: ['sorrow'] }, {
    theirs: [{ creature: 'skeleton', count: 40 }, { creature: 'gnoll', count: 30 }],
  });
  castSpell(battle, 0, 'sorrow', {});
  const bones = theirs(battle).find((u) => u.creature === 'skeleton');
  const gnoll = theirs(battle).find((u) => u.creature === 'gnoll');
  assert.ok(!carries(bones, 'sorrow'), 'the dead feel no sorrow');
  assert.ok(carries(gnoll, 'sorrow'), 'the living do');
});

test('mass: Expert Water Cure mends and cleanses the whole line at once', () => {
  const { battle } = field({ skills: { waterMagic: 3 }, spells: ['cure'] });
  for (const u of ours(battle)) {
    u.hp = 1;
    u.effects.push({ spellId: 'curse', effects: SPELLS.curse.effects, rounds: 5 });
  }
  const events = castSpell(battle, 0, 'cure', {});
  for (const u of ours(battle)) {
    assert.ok(u.hp > 1, `${u.creature} healed`);
    assert.ok(!carries(u, 'curse'), `${u.creature} cleansed`);
  }
  assert.equal(events.filter((e) => e.type === 'heal').length, ours(battle).length);
});

test('mass: a sweep with nobody to touch is refused rather than paid for', () => {
  const { hero, battle } = field({ skills: { earthMagic: 3 }, spells: ['slow'] });
  for (const u of theirs(battle)) { u.alive = false; u.count = 0; }
  const events = castSpell(battle, 0, 'slow', {});
  assert.equal(events.length, 0);
  assert.equal(hero.mana, 100, 'no mana spent on an empty field');
  assert.equal(battle.sides[0].castThisRound, false);
});

test('massCastTargets names the side the spell sweeps, alive only', () => {
  const { battle } = field({ skills: { airMagic: 3, earthMagic: 3 }, spells: ['haste', 'slow'] });
  assert.deepEqual(massCastTargets(battle, 0, 'haste').map((u) => u.id).sort(),
    ours(battle).map((u) => u.id).sort(), 'a buff sweeps our own line');
  assert.deepEqual(massCastTargets(battle, 0, 'slow').map((u) => u.id).sort(),
    theirs(battle).map((u) => u.id).sort(), 'a hex sweeps theirs');
  const dead = theirs(battle)[0];
  dead.alive = false;
  assert.ok(!massCastTargets(battle, 0, 'slow').includes(dead), 'the fallen are not hexed');
});

// ---------------------------------------------------------------------------
// 3b. Per-spell level variants — the MAGNITUDE, not just the target count
// ---------------------------------------------------------------------------

test('data: every byLevel ladder is 4 long, starts at the catalog effect, and only grows', () => {
  let ladders = 0;
  for (const [id, sp] of Object.entries(SPELLS)) {
    if (!sp.byLevel) continue;
    for (const [stat, ladder] of Object.entries(sp.byLevel)) {
      ladders++;
      assert.equal(ladder.length, 4, `${id}.${stat}: [none, Basic, Advanced, Expert]`);
      // THE invariant that keeps an unskilled hero's game unchanged.
      assert.equal(ladder[0], sp.effects[stat], `${id}.${stat}: index 0 is the catalog effect`);
      // HoMM3 treats casting without the skill as the Basic effect.
      assert.equal(ladder[1], ladder[0], `${id}.${stat}: no skill casts at Basic`);
      for (let i = 1; i < 4; i++) {
        assert.ok(Math.abs(ladder[i]) >= Math.abs(ladder[i - 1]),
          `${id}.${stat}: mastery never weakens a spell (${ladder.join('/')})`);
        assert.ok(ladder[i] === 0 || Math.sign(ladder[i]) === Math.sign(ladder[0]),
          `${id}.${stat}: a hex stays a hex and a buff stays a buff`);
      }
    }
  }
  assert.ok(ladders >= 12, `the ladders span the roster (${ladders} found)`);
});

test('Disrupting Ray reads −3 / −4 / −5 by school level, the way HoMM3 does', () => {
  assert.equal(effectsAtLevel('disruptingRay', 0).defense, -3, 'no Air Magic');
  assert.equal(effectsAtLevel('disruptingRay', 1).defense, -3, 'Basic casts as unskilled');
  assert.equal(effectsAtLevel('disruptingRay', 2).defense, -4);
  assert.equal(effectsAtLevel('disruptingRay', 3).defense, -5);
});

test('level: an Advanced Air hero’s Haste really is +5 speed on the field', () => {
  for (const [lvl, want] of [[0, 3], [1, 3], [2, 5], [3, 5]]) {
    const { hero, battle } = field({ skills: { airMagic: lvl }, spells: ['haste'] });
    assert.equal(spellEffects(hero, 'haste').speed, want, `level ${lvl} → +${want}`);
    const t = ours(battle)[0];
    const before = unitSpeed(battle, t);
    castSpell(battle, 0, 'haste', isMassCast(hero, 'haste') ? {} : { unitId: t.id });
    assert.equal(unitSpeed(battle, t) - before, want, `level ${lvl}: the stack moves ${want} faster`);
    assert.equal(t.effects.find((e) => e.spellId === 'haste').effects.speed, want,
      'and the magnitude is STORED, not re-derived from the catalog');
  }
});

test('level: mastery and the sweep compose — Expert Air hastes everyone by 5', () => {
  const { battle } = field({ skills: { airMagic: 3 }, spells: ['haste'] });
  const before = ours(battle).map((u) => unitSpeed(battle, u));
  castSpell(battle, 0, 'haste', {});
  ours(battle).forEach((u, i) => {
    assert.equal(unitSpeed(battle, u) - before[i], 5, `${u.creature}: swept AND at Advanced+ magnitude`);
    assert.equal(carries(u, 'haste'), true);
  });
});

test('level: a stored effect keeps the magnitude it was cast with', () => {
  const { hero, battle } = field({ skills: { earthMagic: 2 }, spells: ['slow'] });
  const t = theirs(battle)[0];
  castSpell(battle, 0, 'slow', { unitId: t.id });
  assert.equal(t.effects[0].effects.speed, -5, 'Advanced Earth Slow');

  // The hero forgets the school mid-battle; what is already on the stack stands.
  hero.skills = {};
  assert.equal(t.effects[0].effects.speed, -5, 'the cast is not re-evaluated');
  assert.equal(spellEffects(hero, 'slow').speed, -3, 'but the NEXT cast is the weaker one');
});

test('level: the resolved effects are a fresh object per stack, never the catalog’s', () => {
  const { battle } = field({ skills: { earthMagic: 3 }, spells: ['stoneSkin'] });
  castSpell(battle, 0, 'stoneSkin', {});
  const stacks = ours(battle);
  assert.ok(stacks.length > 1);
  const a = stacks[0].effects.find((e) => e.spellId === 'stoneSkin');
  const b = stacks[1].effects.find((e) => e.spellId === 'stoneSkin');
  assert.notEqual(a.effects, b.effects, 'a sweep does not alias one object across seven stacks');
  assert.notEqual(a.effects, SPELLS.stoneSkin.effects, 'and never hands out the catalog object');
  assert.deepEqual(a.effects, { defense: 6 }, 'Expert Earth Stone Skin');
  assert.deepEqual(SPELLS.stoneSkin.effects, { defense: 4 }, 'the catalog is untouched');
});

test('Prayer has NO magnitude ladder, and that is the point', () => {
  // A +6/+6/+6 Expert ladder was added with the rest of §2b and measured as the
  // single reason Expert Water outran every other school. +4 on three stats is
  // already Bloodlust and Stone Skin in one cast — and +4 is what HoMM3's Expert
  // Prayer gives. Reverted; the sweep, the duration ladder and the discount stay.
  assert.equal(SPELLS.prayer.byLevel, undefined, 'no magnitude ladder');
  for (const lvl of [0, 1, 2, 3]) {
    assert.deepEqual(effectsAtLevel('prayer', lvl), { attack: 4, defense: 4, speed: 4 },
      `prayer is +4 on three stats at level ${lvl}`);
  }
  const expert = makeHero({ skills: { waterMagic: 3 } });
  assert.equal(isMassCast(expert, 'prayer'), true, 'it is still a sweep at Expert');
  assert.ok(spellDuration(expert, 'prayer') > durationAtLevel('prayer', 0), 'and still lasts longer');
  assert.ok(spellCost(expert, 'prayer') < SPELLS.prayer.manaCost, 'and still costs less');
});

test('level: a spell with no ladder is the same at every level', () => {
  for (const lvl of [0, 1, 2, 3]) {
    assert.deepEqual(effectsAtLevel('blind', lvl), SPELLS.blind.effects, `blind at ${lvl}`);
    assert.deepEqual(effectsAtLevel('bless', lvl), SPELLS.bless.effects, `bless at ${lvl}`);
  }
});

// ---------------------------------------------------------------------------
// 3c. Per-spell DURATION tables — how long, not just how much
// ---------------------------------------------------------------------------

test('data: every duration table is 4 long, starts at the catalog duration, and never shrinks', () => {
  let tables = 0;
  for (const [id, sp] of Object.entries(SPELLS)) {
    if (!sp.durationByLevel) {
      // A spell with no table keeps the old flat rule, exactly.
      if (sp.duration) assert.equal(durationAtLevel(id, 2), sp.duration + 2, `${id}: old rule`);
      continue;
    }
    tables++;
    const t = sp.durationByLevel;
    assert.equal(t.length, 4, `${id}: [none, Basic, Advanced, Expert]`);
    assert.equal(t[0], sp.duration, `${id}: index 0 is the catalog duration — unskilled is untouched`);
    for (let i = 1; i < 4; i++) {
      assert.ok(t[i] >= t[i - 1], `${id}: mastery never shortens its own spell (${t.join('/')})`);
    }
    assert.ok(['buff', 'debuff'].includes(sp.kind), `${id}: only lasting effects have a duration`);
  }
  assert.ok(tables >= 16, `the tables span the buff/debuff roster (${tables})`);
});

test('duration: the tables have SHAPE — a lockout grows slower than a cheap stat buff', () => {
  // The whole point of the change. Every buff and debuff used to last 3 + level
  // rounds, so a Blind that removes a stack from the battle lasted exactly as
  // long as a Bloodlust.
  const growth = (id) => durationAtLevel(id, 3) - durationAtLevel(id, 0);
  assert.ok(growth('blind') < growth('haste'), 'Blind grows slower than Haste');
  assert.ok(growth('frenzy') < growth('haste'), 'so does Frenzy');
  assert.ok(growth('haste') < growth('shield'), 'and Haste slower than a cheap single-stat buff');
  assert.equal(durationAtLevel('haste', 3) - durationAtLevel('haste', 0), 3,
    'the initiative spells keep the old +1-per-level');
  // …and at NO mastery every one of them is what it always was.
  for (const id of ['blind', 'frenzy', 'haste', 'shield', 'prayer', 'sorrow']) {
    assert.equal(durationAtLevel(id, 0), 3, `${id} unskilled`);
  }
});

test('duration: the engine applies the mastered ladder, plus the Power bonus, and nothing else', () => {
  const powerBonus = (p) => Math.min(CONFIG.SPELL_DURATION_POWER_CAP,
    Math.floor(p / CONFIG.SPELL_DURATION_POWER_DIV));

  for (const [id, school, side] of [['shield', 'earthMagic', 'ours'], ['blind', 'fireMagic', 'theirs']]) {
    for (const lvl of [0, 1, 2, 3]) {
      const { hero, battle } = field({ power: 4, skills: { [school]: lvl }, spells: [id] });
      const pool = side === 'ours' ? ours(battle) : theirs(battle);
      const t = pool[0];
      castSpell(battle, 0, id, isMassCast(hero, id) ? {} : { unitId: t.id });
      const e = t.effects.find((x) => x.spellId === id);
      assert.ok(e, `${id} landed at level ${lvl}`);
      assert.equal(e.rounds, durationAtLevel(id, lvl) + powerBonus(4),
        `${id} at level ${lvl}: ladder + Power, with no leftover flat bonus`);
    }
  }
});

test('duration: Expert Fire Blind is SHORTER than it used to be, and that is the point', () => {
  // The old rule gave every spell duration + level: Expert Blind ran 6 base
  // rounds (9 with the Power cap), which is most of a battle for one 10-mana
  // cast. This is a deliberate nerf to the mastered lockout, recorded as one.
  assert.equal(durationAtLevel('blind', 3), 4);
  assert.ok(durationAtLevel('blind', 3) < 3 + 3, 'shorter than the old flat rule gave');
  // Everything about an UNSKILLED Blind is unchanged.
  assert.equal(durationAtLevel('blind', 0), SPELLS.blind.duration);
});

test('duration: a stack keeps the rounds it was enchanted with', () => {
  const { hero, battle } = field({ power: 4, skills: { earthMagic: 3 }, spells: ['shield'] });
  castSpell(battle, 0, 'shield', {});
  const long = ours(battle)[0].effects.find((e) => e.spellId === 'shield').rounds;
  assert.ok(long > durationAtLevel('shield', 0), 'an Expert Shield really does hold longer');
  hero.skills = {};
  assert.equal(ours(battle)[0].effects.find((e) => e.spellId === 'shield').rounds, long,
    'losing the skill does not shorten what is already on the field');
  assert.equal(spellDuration(hero, 'shield'), durationAtLevel('shield', 0), 'but the next cast is short');
});

test('duration: the book says how long, including when mastery made it shorter', () => {
  assert.match(masteryNote(makeHero({ skills: { earthMagic: 3 } }), 'shield'),
    /lasts 8 rounds \(was 3\)/);
  assert.match(masteryNote(makeHero({ skills: { fireMagic: 3 } }), 'blind'),
    /lasts 4 rounds \(was 3\)/, 'a lockout that grew only a little says so');
  assert.doesNotMatch(masteryNote(makeHero({ skills: { fireMagic: 1 } }), 'blind') || '',
    /lasts/, 'Basic Fire moves Blind’s duration not at all');
  assert.equal(masteryNote(makeHero(), 'shield'), null, 'and an unskilled hero is told nothing');
});

// ---------------------------------------------------------------------------
// 4. The AI prices the sweep, and the reading the player gets
// ---------------------------------------------------------------------------

test('the AI casts a mass buff as ONE decision worth the whole line', () => {
  const foe = makeHero({ name: 'Foe', power: 6, skills: { airMagic: 3 }, spells: ['haste'], mana: 100 });
  const { battle } = field({ spells: [] }, { foeHero: foe });
  const events = maybeCastAISpell(battle, 1);
  const swept = theirs(battle).filter((u) => carries(u, 'haste'));
  assert.ok(events.length > 0, 'it cast something');
  assert.ok(swept.length > 1, `mass Haste covered ${swept.length} stacks in one cast`);
  assert.equal(foe.mana, 100 - spellCost(foe, 'haste'), 'and paid once');
});

test('the AI refuses a field spell that would wipe its own line', () => {
  // Armageddon burns EVERY stack, and the engine scores mutual annihilation to
  // the defender (CombatEngine.finish). So a cast that kills the last stack on
  // both sides hands away a battle the attacker was winning — measured, an
  // Armageddon-only book went from 96% to 76% once Fire mastery pushed the
  // damage over that line, while the HP totals barely moved.
  const mk = (ourArmy) => {
    const foe = makeHero({ name: 'Foe', power: 8, skills: { fireMagic: 3 }, spells: ['armageddon'], mana: 100 });
    return createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
      rng: new Rng(3),
      attacker: { hero: null, army: [{ creature: 'hydra', count: 40 }], playerIndex: 0 },
      defender: { hero: foe, army: ourArmy, playerIndex: 1 },
    });
  };
  const cast = (b) => maybeCastAISpell(b, 1).some((e) => e.spellId === 'armageddon');

  // Its own line is one frail stack: the blast kills it and leaves the hydras
  // standing, so casting is a concession, not a trade.
  assert.equal(cast(mk([{ creature: 'imp', count: 3 }])), false, 'refused');

  // Give it a stack the blast cannot touch at all — Black Dragons shrug off
  // every spell — and the same cast becomes a clean trade.
  assert.equal(cast(mk([{ creature: 'imp', count: 3 }, { creature: 'blackDragon', count: 2 }])), true,
    'cast once someone on our side is still standing afterwards');
});

test('effectSummary reports what is riding on a stack, with rounds left', () => {
  const { battle } = field({ skills: { airMagic: 3, earthMagic: 3 }, spells: ['haste'] });
  const u = ours(battle)[0];
  assert.deepEqual(effectSummary(u), [], 'a clean stack carries nothing');

  castSpell(battle, 0, 'haste', {});
  u.effects.push({ spellId: 'slow', effects: SPELLS.slow.effects, rounds: 2 });

  const fx = effectSummary(u);
  assert.deepEqual(fx.map((e) => e.name), ['Haste', 'Slow']);
  assert.equal(fx[0].hostile, false, 'a buff reads friendly');
  assert.equal(fx[1].hostile, true, 'a hex reads hostile');
  assert.ok(fx[0].rounds > 0);
  assert.equal(effectDetail(fx[0].effects), '+5 speed', 'the card quotes what was CAST, not the catalog');
  assert.equal(effectDetail({ blessed: 1 }), 'always max damage');
});

test('masteryNote says what mastery is doing, and nothing when it does nothing', () => {
  assert.equal(masteryNote(makeHero(), 'haste'), null, 'no skill, no note');
  assert.equal(masteryNote(makeHero({ skills: { earthMagic: 3 } }), 'haste'), null, 'wrong school, no note');

  const note = masteryNote(makeHero({ skills: { airMagic: 3 } }), 'haste');
  assert.match(note, /Expert Air Magic/);
  assert.match(note, /EVERY friendly stack/);
  // The magnitude, quoted against the number the spell's own description prints
  // — otherwise the book says "+3 speed" while the cast gives +5.
  assert.match(note, /\+5 speed \(was \+3\)/);
  assert.match(masteryNote(makeHero({ skills: { airMagic: 2 } }), 'haste'), /\+5 speed \(was \+3\)/,
    'Advanced says so too, without claiming a sweep');
  assert.doesNotMatch(masteryNote(makeHero({ skills: { airMagic: 2 } }), 'haste'), /EVERY/);
  assert.doesNotMatch(masteryNote(makeHero({ skills: { airMagic: 1 } }), 'haste'), /speed/,
    'Basic changes no magnitude, so it claims none');
  assert.match(masteryNote(makeHero({ skills: { earthMagic: 3 } }), 'slow'), /EVERY enemy stack/);
  assert.equal(schoolLevel(makeHero({ skills: { airMagic: 2 } }), 'haste'), 2);
});

test('regression: a hero with no magic school casts exactly as it always did', () => {
  const skilled = field({ skills: { airMagic: 3 }, spells: ['haste'] });
  const plain = field({ spells: ['haste'] });
  const t = ours(plain.battle)[0];
  castSpell(plain.battle, 0, 'haste', { unitId: t.id });

  assert.equal(plain.hero.mana, 100 - SPELLS.haste.manaCost, 'catalog price');
  assert.equal(ours(plain.battle).filter((u) => carries(u, 'haste')).length, 1, 'one stack');
  assert.deepEqual(t.effects.find((e) => e.spellId === 'haste').effects, SPELLS.haste.effects,
    'and the catalog magnitude, unchanged');
  // …and the mastered hero is the one that differs, so the test above is live.
  assert.ok(spellCost(skilled.hero, 'haste') !== SPELLS.haste.manaCost);
});

test('effectMood reads the enchantment light on a stack, and hostile wins a tie', () => {
  // The count plate under a stack turns green when only blessings ride it and
  // red when anything hexes it. That decision is this function, and it lives in
  // core so this test can ask it without a Phaser canvas.
  assert.equal(effectMood({ effects: [] }), null, 'a clean stack lights nothing');
  assert.equal(effectMood(undefined), null, 'and neither does a missing one');
  assert.equal(effectMood({ effects: [{ spellId: 'haste' }] }), 'friendly');
  assert.equal(effectMood({ effects: [{ spellId: 'slow' }] }), 'hostile');
  // A stack that is both blessed and cursed is a stack in TROUBLE: the badge
  // exists to warn, and a green plate over a blinded stack would be worse than
  // no plate at all. Order must not matter.
  assert.equal(effectMood({ effects: [{ spellId: 'haste' }, { spellId: 'curse' }] }), 'hostile');
  assert.equal(effectMood({ effects: [{ spellId: 'curse' }, { spellId: 'haste' }] }), 'hostile');
  // Live, off a real cast rather than a hand-built effects array.
  const { battle } = field({ skills: { earthMagic: 3 }, spells: ['slow'] });
  castSpell(battle, 0, 'slow', { unitId: theirs(battle)[0].id });
  assert.equal(effectMood(theirs(battle)[0]), 'hostile');
  assert.equal(effectMood(ours(battle)[0]), null, 'the casting side is untouched');
  // Every spell the catalog can hang on a stack must classify, or the plate
  // would light green for a hex nobody thought to flag.
  for (const [id, sp] of Object.entries(SPELLS)) {
    if (!sp.effects && !sp.kind) continue;
    if (sp.kind !== 'buff' && sp.kind !== 'debuff') continue;
    assert.equal(effectMood({ effects: [{ spellId: id }] }), sp.kind === 'debuff' ? 'hostile' : 'friendly', id);
  }
});
