/**
 * hero-specialty.test.js — permanent hero specialties.
 *
 *   creature  — that creature (and its upgrade) gains +1 attack/defense/speed in
 *               THIS hero's battles (side-scoped, not the enemy).
 *   stat      — +1 to a primary stat, always on (flows through heroStat).
 *   resource  — +amount of a resource each day (dailyIncome).
 *
 * Covers each effect, that it's side-scoped and upgrade-aware, save round-trip,
 * and that every roster specialty is valid. No Phaser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, RESOURCES } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { HERO_ROSTER, specialtyText } from '../src/data/heroes.js';
import { newGame, createHero, playerHeroes, serialize, deserialize } from '../src/core/GameState.js';
import { dailyIncome } from '../src/core/actions.js';
import { heroStat } from '../src/core/heroUtils.js';
import {
  createBattle, unitAttackStat, unitDefenseStat, unitSpeed,
} from '../src/core/combat/CombatEngine.js';
import { Rng } from '../src/core/rng.js';

/** The specialty delta a unit gets = its full stat minus (base creature stat +
 *  the hero's army-wide bonus, which a same-side control stack also carries). */
function creatureBattle(hero) {
  return createBattle({
    rng: new Rng(1),
    attacker: {
      hero,
      army: [
        { creature: 'archer', count: 10 },   // matches an Orrin (archer) specialty
        { creature: 'marksman', count: 10 },  // archer's UPGRADE — should also match
        { creature: 'pikeman', count: 10 },   // control: never matches
      ],
      playerIndex: 0,
    },
    defender: { hero: null, army: [{ creature: 'archer', count: 10 }], playerIndex: 1 },
  });
}
const unit = (b, side, creature) => b.units.find((u) => u.side === side && u.creature === creature);

test('creature specialty: +att/+def/+speed to the matching creature AND its upgrade, own side only', () => {
  const s = newGame({ seed: 3, playerFaction: 'castle' });
  const orrin = playerHeroes(s, 0)[0];
  assert.deepEqual(orrin.specialty, { kind: 'creature', creature: 'archer' }, 'Orrin specializes in Archers');

  const b = creatureBattle(orrin);
  const archer = unit(b, 0, 'archer'), marks = unit(b, 0, 'marksman'), pike = unit(b, 0, 'pikeman');
  const enemyArcher = unit(b, 1, 'archer');
  const spec = CONFIG.SPECIALTY_CREATURE;

  // Isolate the specialty by differencing against the non-matching control stack
  // (both stacks share the same army-wide hero attack bonus).
  const atkAdv = (u) => unitAttackStat(b, u) - CREATURES[u.creature].attack;
  assert.equal(atkAdv(archer) - atkAdv(pike), spec.attack, 'archer gets the specialty attack');
  assert.equal(atkAdv(marks) - atkAdv(pike), spec.attack, 'marksman (upgrade) gets it too');

  const defAdv = (u) => unitDefenseStat(b, u) - CREATURES[u.creature].defense;
  assert.equal(defAdv(archer) - defAdv(pike), spec.defense, 'archer gets the specialty defense');

  assert.equal(unitSpeed(b, archer) - CREATURES.archer.speed
    - (unitSpeed(b, pike) - CREATURES.pikeman.speed), spec.speed, 'archer gets the specialty speed');

  // The ENEMY's archers are not touched by Orrin's specialty.
  assert.equal(unitAttackStat(b, enemyArcher), CREATURES.archer.attack, 'enemy archer unbuffed');
});

test('creature specialty: a non-creature specialist grants no unit bonus', () => {
  const s = newGame({ seed: 3, playerFaction: 'castle' });
  const adela = createHero(s, 'adela', 0, 5, 5); // stat specialist
  const b = creatureBattle(adela);
  const archer = unit(b, 0, 'archer');
  // Adela has no attack bonus (cleric start attack 1, no army-wide attack) and no
  // creature specialty, so the archer's attack is exactly its base + her attack stat.
  assert.equal(unitAttackStat(b, archer), CREATURES.archer.attack + heroStat(adela, 'attack'));
});

test('stat specialty: +1 to the specialized primary stat, others untouched', () => {
  const s = newGame({ seed: 3 });
  const adela = createHero(s, 'adela', 0, 5, 5); // { kind:'stat', stat:'knowledge' }
  assert.equal(heroStat(adela, 'knowledge'), adela.stats.knowledge + 1, 'specialized stat +1');
  assert.equal(heroStat(adela, 'attack'), adela.stats.attack, 'other stats unchanged');

  // CLONE: upstream uses solmyr, a TOWER hero. Only castle and inferno heroes are
  // in the roster here (data/heroes.js filters it to the playable factions), so the
  // power specialist is ignatius — same {kind:'stat', stat:'power'} shape.
  const ignatius = createHero(s, 'ignatius', 0, 6, 6); // power specialist
  assert.equal(heroStat(ignatius, 'power'), ignatius.stats.power + 1);
  assert.equal(heroStat(ignatius, 'knowledge'), ignatius.stats.knowledge);
});

test('resource specialty: adds a fixed daily trickle in dailyIncome', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];

  hero.specialty = { kind: 'resource', resource: 'gold', amount: 350 };
  const goldWith = dailyIncome(s, s.players[0]).gold || 0;
  hero.specialty = null;
  const goldWithout = dailyIncome(s, s.players[0]).gold || 0;
  assert.equal(goldWith - goldWithout, 350, 'gold specialist adds +350/day');

  hero.specialty = { kind: 'resource', resource: 'wood', amount: 2 };
  const woodWith = dailyIncome(s, s.players[0]).wood || 0;
  hero.specialty = null;
  const woodWithout = dailyIncome(s, s.players[0]).wood || 0;
  assert.equal(woodWith - woodWithout, 2, 'wood specialist adds +2/day');
});

test('specialty round-trips through save/load; createHero copies it', () => {
  const s = newGame({ seed: 3, playerFaction: 'castle' });
  const orrin = playerHeroes(s, 0)[0];
  assert.ok(orrin.specialty, 'createHero copied the roster specialty');
  const r = deserialize(serialize(s));
  assert.deepEqual(r.heroes[orrin.id].specialty, orrin.specialty);
});

test('specialtyText renders each kind; every roster specialty is valid', () => {
  assert.match(specialtyText({ kind: 'creature', creature: 'archer' }).name, /Archer/);
  assert.match(specialtyText({ kind: 'stat', stat: 'power' }).effect, /Power/);
  assert.match(specialtyText({ kind: 'resource', resource: 'gold', amount: 350 }).effect, /350/);
  assert.equal(specialtyText(null), null);

  for (const [id, def] of Object.entries(HERO_ROSTER)) {
    const spec = def.specialty;
    assert.ok(spec, `${id} has a specialty`);
    if (spec.kind === 'creature') {
      assert.ok(CREATURES[spec.creature], `${id}: creature ${spec.creature} exists`);
      assert.ok(!CREATURES[spec.creature].upgraded, `${id}: specializes in a BASE creature`);
    } else if (spec.kind === 'stat') {
      assert.ok(['attack', 'defense', 'power', 'knowledge'].includes(spec.stat), `${id}: valid stat`);
    } else if (spec.kind === 'resource') {
      assert.ok(RESOURCES.includes(spec.resource), `${id}: valid resource`);
      assert.ok(spec.amount > 0, `${id}: positive amount`);
    } else {
      assert.fail(`${id}: unknown specialty kind ${spec.kind}`);
    }
  }
});
