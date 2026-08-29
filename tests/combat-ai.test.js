/**
 * combat-ai.test.js — Behavioral pins for the value-driven combat AI.
 *
 * The AI prices every option (attacks, spells, resurrection) in one currency:
 * expected aiValue destroyed minus expected aiValue lost. These tests build
 * small hand-placed battles and assert the AI makes the plays the naive
 * "biggest stack, highest tier" brain got wrong: partial spell damage counts,
 * sorcery-boosted nukes beat token debuffs, area spells aim at clusters,
 * shooters get hunted and don't brawl, archangels don't waste turns mending
 * chip damage, and a stalemate cap no longer deletes the losing side.
 *
 * Everything is headless and deterministic (seeded rng, no AI-side rng).
 * Run with: node --test tests/combat-ai.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle, hexDistance } from '../src/core/combat/CombatEngine.js';
import { chooseAction, maybeCastAISpell, autoResolve } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';

const SEED = 9001;

/** Minimal plain-object hero that satisfies heroUtils + castSpell. */
function makeHero(opts = {}) {
  return {
    stats: { attack: 0, defense: 0, power: opts.power ?? 0, knowledge: 0 },
    skills: opts.skills || {},
    equipment: {},
    army: [],
    spells: opts.spells || [],
    mana: opts.mana ?? 0,
    tempMorale: 0, tempLuck: 0,
  };
}

function makeBattle(attackerArmy, defenderArmy, opts = {}) {
  const battle = createBattle({
    // Engine unit tests fix their own deployment: a heroless defender now splits
    // across hexes by rule (CONFIG.PVE_STACK_SPLIT), which is right for a real PvE
    // fight and wrong here — a three-way split changes which unit strikes whom and
    // would quietly make these assertions about a different scenario.
    pveStackSplit: false,
    rng: new Rng(opts.seed ?? SEED),
    attacker: { hero: opts.attackerHero || null, army: attackerArmy, playerIndex: 0 },
    defender: { hero: opts.defenderHero || null, army: defenderArmy, playerIndex: 1 },
  });
  battle.obstacles = []; // hand-placed geometry must not depend on the seed
  return battle;
}

function unitOf(battle, creature) {
  return battle.units.find((u) => u.creature === creature);
}

function place(u, x, y) { u.x = x; u.y = y; }

// ---------------------------------------------------------------------------
// Spellcasting
// ---------------------------------------------------------------------------

test('spells: picks the stronger of two same-tier nukes, not the first by tier', () => {
  // Titan's Bolt (80+60/power) and Implosion (100+75/power) are both tier 5;
  // at power 4 Implosion kills 4 champions to the Bolt's 3. Tier-based
  // selection casts whichever sorts first — value-based selection must not.
  const hero = makeHero({ spells: ['titanBolt', 'implosion'], mana: 60, power: 4 });
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'champion', count: 20 }],
    { attackerHero: hero });
  const ev = maybeCastAISpell(battle, 0);
  const hits = ev.filter((e) => e.type === 'spellHit');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].spellId, 'implosion', 'the bigger nuke wins, not the tier sort');
});

test('spells: an area spell is aimed at the cluster, not the single fattest stack', () => {
  // Three nomad stacks stand shoulder to shoulder; a lone giant stack is worth
  // more on paper but Fireball over the cluster removes far more total value.
  const hero = makeHero({ spells: ['fireball'], mana: 20, power: 5 });
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'giant', count: 5 }, { creature: 'nomad', count: 30 },
      { creature: 'nomad', count: 30 }, { creature: 'nomad', count: 30 }],
    { attackerHero: hero });
  const [n1, n2, n3] = battle.units.filter((u) => u.creature === 'nomad');
  place(unitOf(battle, 'pikeman'), 0, 5);
  place(unitOf(battle, 'giant'), 12, 2);
  place(n1, 6, 5); place(n2, 7, 5); place(n3, 8, 5);

  const ev = maybeCastAISpell(battle, 0);
  const hits = ev.filter((e) => e.type === 'spellHit');
  assert.equal(hits.length, 3, 'fireball centered on the cluster burns all three stacks');
  for (const h of hits) {
    assert.ok([n1.id, n2.id, n3.id].includes(h.targetId), 'only nomads were hit');
  }
});

test('spells: partial damage is worth casting for — no full kill required', () => {
  // Lightning Bolt at power 3 with expert Sorcery deals round(85*1.15)=98 to a
  // 200 HP angel: zero whole kills, but a meaty chunk of a 5019-point stack.
  // A killed-creatures-only score is 0 and the hero would sit on his mana.
  const hero = makeHero({ spells: ['lightningBolt'], mana: 20, power: 3, skills: { sorcery: 3 } });
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'angel', count: 4 }],
    { attackerHero: hero });
  const ev = maybeCastAISpell(battle, 0);
  const hit = ev.find((e) => e.type === 'spellHit');
  assert.ok(hit, 'the bolt is cast even though it kills no whole creature');
  assert.equal(hit.damage, 98, 'estimate matches the engine: sorcery included');
  assert.equal(hit.kills, 0);
});

test('spells: a meaty nuke beats Blind when it removes more value', () => {
  // Implosion chips ~70% off an archangel (worth ~1800 points of a 17552-point
  // stack); Blind only denies what those archangels could do to 10 pikemen
  // (~800 points). Naive scoring said 0 for the nuke and picked Blind.
  const hero = makeHero({ spells: ['blind', 'implosion'], mana: 40, power: 1 });
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 10 }],
    [{ creature: 'archangel', count: 2 }],
    { attackerHero: hero });
  const ev = maybeCastAISpell(battle, 0);
  const hit = ev.find((e) => e.type === 'spellHit');
  assert.ok(hit, 'a damage spell was cast');
  assert.equal(hit.spellId, 'implosion');
});

test('spells: equal value goes to the cheaper spell', () => {
  // At power 0 both bolts deal exactly 10 damage — same kills, same value.
  // Ice Bolt costs 8 mana to Lightning Bolt's 10, so it must win the tie.
  const hero = makeHero({ spells: ['lightningBolt', 'iceBolt'], mana: 30, power: 0 });
  const battle = makeBattle(
    [{ creature: 'pikeman', count: 5 }],
    [{ creature: 'peasant', count: 100 }],
    { attackerHero: hero });
  const ev = maybeCastAISpell(battle, 0);
  const hit = ev.find((e) => e.type === 'spellHit');
  assert.ok(hit);
  assert.equal(hit.spellId, 'iceBolt', 'ties break on lower mana cost');
});

test('spells: Armageddon is never cast when it nets negative', () => {
  // 280 field damage only chips the two lone titans (no kills) but slaughters
  // 70 of our imps and 28 of our pikemen — clearly value-negative, so the
  // hero must hold the spell even though it is the only one he knows.
  const hero = makeHero({ spells: ['armageddon'], mana: 30, power: 5 });
  const battle = makeBattle(
    [{ creature: 'imp', count: 400 }, { creature: 'pikeman', count: 300 }],
    [{ creature: 'titan', count: 1 }, { creature: 'titan', count: 1 }],
    { attackerHero: hero });
  const ev = maybeCastAISpell(battle, 0);
  assert.equal(ev.length, 0, 'no cast');
  assert.equal(hero.mana, 30, 'mana untouched');
});

// ---------------------------------------------------------------------------
// Stack actions
// ---------------------------------------------------------------------------

test('melee: hunts the enemy shooter / lethal hit over a bigger stack with brutal retaliation', () => {
  // 200 pikemen are "worth" 16000 to a raw value*count sort, but charging them
  // buys ~5500 value at the cost of a 131-strong counter-attack. Wiping the
  // 30 marksmen is lethal (no retaliation) AND silences a shooter.
  const battle = makeBattle(
    [{ creature: 'champion', count: 20 }],
    [{ creature: 'pikeman', count: 200 }, { creature: 'marksman', count: 30 }]);
  const champion = unitOf(battle, 'champion');
  const marksman = unitOf(battle, 'marksman');
  place(champion, 3, 5);
  place(unitOf(battle, 'pikeman'), 7, 5);
  place(marksman, 8, 7);

  const action = chooseAction(battle, champion);
  assert.equal(action.type, 'attack');
  assert.equal(action.targetId, marksman.id, 'kills the shooter instead of trading with the wall');
});

test('shooter: shoots the enemy shooter, not the fattest stack', () => {
  // The chaff stack tops the head count, and SHOOTER_BONUS is what decides
  // against it. Both targets are within full range, so this is purely a
  // valuation call.
  //
  // SIZED TO THE BOUNDARY DELIBERATELY. This read 500 Peasants, and 500 was on
  // the wrong side of a margin nobody had measured: a volley into that pile
  // removes about 1,800 points and into the Archers about 1,620 WITH the 1.5x
  // premium applied, so the pile wins on arithmetic and the AI taking it is
  // correct, not a bug. The old numbers cleared it by roughly one percent, and a
  // re-pricing of the Archer — which the measurement says was flattered by its
  // price — crossed it. Measured: the AI switches between 120 and 125 Peasants.
  // At 120 the premium is what carries the decision, and deleting SHOOTER_BONUS
  // flips this test, which is the thing it exists to guard.
  const battle = makeBattle(
    [{ creature: 'marksman', count: 20 }],
    [{ creature: 'peasant', count: 120 }, { creature: 'archer', count: 30 }]);
  const marksman = unitOf(battle, 'marksman');
  const archer = unitOf(battle, 'archer');
  place(marksman, 2, 5);
  place(unitOf(battle, 'peasant'), 7, 5);
  place(archer, 9, 5);

  const action = chooseAction(battle, marksman);
  assert.equal(action.type, 'shoot', 'keeps shooting in place while it can');
  assert.equal(action.targetId, archer.id);
});

test('shooter: blocked by a bruiser, it repositions to shoot instead of brawling', () => {
  // An archer stack pinned by 20 gold golems: its half-penalty melee scratch
  // buys a full-stack retaliation wipe. Stepping clear keeps the bow in play.
  const battle = makeBattle(
    [{ creature: 'archer', count: 10 }],
    [{ creature: 'goldGolem', count: 20 }]);
  const archer = unitOf(battle, 'archer');
  const golem = unitOf(battle, 'goldGolem');
  place(archer, 5, 5);
  place(golem, 6, 5);

  const action = chooseAction(battle, archer);
  assert.equal(action.type, 'move', 'slips away rather than melee into a wipe');
  assert.ok(hexDistance(action.x, action.y, golem.x, golem.y) > 1,
    'destination is clear of the blocker, so it can shoot next turn');
});

test('archangel: attacks instead of mending a one-creature chip loss', () => {
  const battle = makeBattle(
    [{ creature: 'archangel', count: 2 }, { creature: 'pikeman', count: 20 }],
    [{ creature: 'goldGolem', count: 10 }]);
  const arch = unitOf(battle, 'archangel');
  const pike = unitOf(battle, 'pikeman');
  pike.count = 19; // one pikeman down: 80 points of mending vs a ~1600-point attack

  const action = chooseAction(battle, arch);
  assert.equal(action.type, 'attack', 'a strong attack outranks trivial mending');
  assert.equal(action.targetId, unitOf(battle, 'goldGolem').id);
});

test('archangel: still resurrects when the revived value beats its best attack', () => {
  const battle = makeBattle(
    [{ creature: 'archangel', count: 2 }, { creature: 'champion', count: 10 }],
    [{ creature: 'goldGolem', count: 10 }]);
  const arch = unitOf(battle, 'archangel');
  const champ = unitOf(battle, 'champion');
  champ.count = 8; // two champions down: 4200 points revivable

  const action = chooseAction(battle, arch);
  assert.equal(action.type, 'resurrect');
  assert.equal(action.targetId, champ.id);
});

test('chooseAction: always returns a legal-looking action for every unit', () => {
  const battle = makeBattle(
    [{ creature: 'archer', count: 12 }, { creature: 'griffin', count: 8 }],
    [{ creature: 'skeleton', count: 40 }, { creature: 'medusa', count: 6 }]);
  for (const u of battle.units) {
    const a = chooseAction(battle, u);
    assert.ok(a && typeof a.type === 'string', `unit ${u.id} got an action`);
  }
});

// ---------------------------------------------------------------------------
// Auto-resolve
// ---------------------------------------------------------------------------

test('autoResolve: stalemate cap keeps the losing side\'s actual survivors', () => {
  // Force the cap immediately: the stronger side wins the judgment call, but
  // the 50 pikemen must NOT be deleted into a free total wipe.
  const battle = makeBattle(
    [{ creature: 'archangel', count: 10 }],
    [{ creature: 'pikeman', count: 50 }]);
  const result = autoResolve(battle, 0);
  assert.equal(result.attackerWon, true, 'stronger remnant is judged the winner');
  assert.equal(result.defenderArmy.length, 1, 'losers keep their surviving stacks');
  assert.equal(result.defenderArmy[0].count, 50, 'nobody actually died at the cap');
});

test('autoResolve: deterministic and terminates with a spellcasting hero', () => {
  const run = () => {
    const hero = makeHero({ spells: ['fireball', 'blind', 'haste'], mana: 30, power: 5 });
    const battle = createBattle({
      rng: new Rng(4242),
      attacker: { hero, army: [{ creature: 'swordsman', count: 30 }, { creature: 'archer', count: 20 }], playerIndex: 0 },
      defender: { hero: null, army: [{ creature: 'hellHound', count: 25 }, { creature: 'gog', count: 15 }], playerIndex: 1 },
    });
    return autoResolve(battle);
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'same seed, same battle, same outcome');
  assert.equal(typeof a.attackerWon, 'boolean');
});
