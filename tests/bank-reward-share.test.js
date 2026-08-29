/**
 * bank-reward-share.test.js — a creature bank pays a share of what you fought.
 *
 * The tables in data/creatureBanks.js name a fixed prize against a fixed guard:
 * a Dwarven Treasury holds 14 dwarves and pays 4 of them back, a sensible 29%.
 * That ratio was correct right up until the guard stopped being fixed: weekly growth,
 * the crawling peg and site respawn all move a real garrison. So the creature prize is
 * CONFIG.BANK_REWARD_SHARE of the garrison the MAP placed, floored at the table value.
 * The floor is what makes this safe against existing games: an unscaled bank pays
 * exactly what it always paid.
 *
 * The share used to be taken from the garrison as FOUGHT — after tideScaleDefender
 * inflated it for one particular hero — and the second half of this file pins why that
 * had to change. Gold, resources and the artifact roll are not scaled by the garrison
 * at all; the only thing that moves the gold is what the battle COST, which is a
 * property of the fight rather than of the pile that was standing in front of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, nextObjectId } from '../src/core/GameState.js';
import { combatContext, applyCombatResult } from '../src/core/actions.js';
import { CREATURE_BANKS } from '../src/data/creatureBanks.js';
import { armyValue } from '../src/core/heroUtils.js';

const total = (army) => (army || []).reduce((n, st) => n + (st ? st.count : 0), 0);

/**
 * Beat a bank whose garrison is the table's, multiplied by `guardMult` — the
 * same shape tideScaleDefender produces, without needing the tide to produce it.
 * Returns what the hero was actually paid.
 */
function loot(bankId, guardMult) {
  const def = CREATURE_BANKS[bankId];
  const s = newGame({ seed: 11, pveScaling: false, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 500, hurt: 0 }, null, null, null, null, null, null];
  const id = 'Obank';
  s.map.objects[id] = {
    id, type: 'creatureBank', bankType: bankId, x: hero.x + 1, y: hero.y, looted: false,
    guards: def.guards.map((g) => ({ ...g, count: g.count * guardMult })),
  };
  const ctx = combatContext(s, hero, { kind: 'creatureBank', objectId: id });
  const fought = total(ctx.defenderArmy);
  const events = applyCombatResult(s, ctx, {
    attackerWon: true,
    attackerArmy: hero.army.map((st) => (st ? { ...st } : null)),
    defenderArmy: [],
  });
  const ev = events.find((e) => e.type === 'bankLooted');
  assert.ok(ev, 'the bank was looted');
  return { fought, reward: ev.reward };
}

test('an unscaled bank pays exactly its table prize — classic games do not move', () => {
  for (const [bankId, def] of Object.entries(CREATURE_BANKS)) {
    const { reward } = loot(bankId, 1);
    for (const want of (def.reward.creatures || [])) {
      const got = reward.creatures.find((c) => c.creature === want.creature);
      assert.ok(got, `${bankId} still pays ${want.creature}`);
      assert.equal(got.count, want.count,
        `${bankId}: an unscaled bank must pay the table's ${want.count}, not a computed share`);
    }
  }
});

test('a scaled garrison pays the configured share of what was actually fought', () => {
  for (const mult of [20, 200, 1500]) {
    const { fought, reward } = loot('dwarvenTreasury', mult);
    const paid = reward.creatures.reduce((n, c) => n + c.count, 0);
    assert.equal(paid, Math.round(fought * CONFIG.BANK_REWARD_SHARE),
      `fought ${fought} → expected ${Math.round(fought * CONFIG.BANK_REWARD_SHARE)}, paid ${paid}`);
  }
});

test('the share is split across a multi-stack prize, not paid per stack', () => {
  // Otherwise a two-stack reward would be quietly worth twice a one-stack
  // reward guarded by exactly the same army.
  const bankId = 'dragonUtopia';
  const stacks = (CREATURE_BANKS[bankId].reward.creatures || []).length;
  const { fought, reward } = loot(bankId, 500);
  const paid = reward.creatures.reduce((n, c) => n + c.count, 0);
  const perStack = Math.round((fought * CONFIG.BANK_REWARD_SHARE) / stacks);
  assert.equal(paid, perStack * stacks, 'the whole prize is one share, divided');
});

test('gold, resources and the artifact roll are untouched by the garrison size', () => {
  const small = loot('dragonUtopia', 1);
  const huge = loot('dragonUtopia', 1500);
  assert.equal(huge.reward.gold, small.reward.gold, 'gold does not scale');
  assert.deepEqual(huge.reward.resources, small.reward.resources, 'resources do not scale');
  assert.ok(huge.fought > small.fought * 100, 'fixture: the garrisons really did differ');
});


// ── the refund loop ─────────────────────────────────────────────────────────
//
// The share above is of the garrison the MAP placed. It used to be of the garrison as
// FOUGHT — i.e. after tideScaleDefender inflated it for this particular hero — and
// that closed a loop: bigger army → bigger scaled guard → bigger creature prize →
// bigger army, with every step of it free because the scaled fight cost nothing.
// Measured over one half-game, 24 bank and lair fights beat 38.6M of inflated guard
// value and ~3.9M of the realm's ~5.3M total army growth arrived as that prize.
//
// The tell was already in the code: the REPEL path divides the inflation back out
// before storing survivors, on the stated grounds that it "must NOT persist". The
// victory path did not. The same number was a fiction when it would make the map
// harder and a fact when it paid the player.

/** Beat a bank under live tide scaling, losing `lossFraction` of the army doing it. */
function tideLoot(bankId, guardCount, lossFraction = 0,
  heroArmy = [{ creature: 'archangel', count: 500, hurt: 0 }]) {
  const s = newGame({ seed: 11, pacing: 'tideOfWar', tideHardness: 0.85 });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [...heroArmy.map((st) => ({ ...st })), null, null, null, null, null, null].slice(0, 7);
  const id = nextObjectId(s);
  s.map.objects[id] = {
    id, type: 'creatureBank', bankType: bankId, x: hero.x + 1, y: hero.y, z: hero.z ?? 0, looted: false,
    guards: [{ creature: 'dwarf', count: guardCount }],
  };
  const goldBefore = s.players[0].resources.gold;
  const xpBefore = hero.xp || 0;
  const ctx = combatContext(s, hero, { kind: 'creatureBank', objectId: id });
  const before = armyValue(hero.army);
  const survivors = hero.army.filter(Boolean)
    .map((st) => ({ ...st, count: Math.round(st.count * (1 - lossFraction)) }));
  const rawXp = armyValue(ctx.defenderArmy);
  const events = applyCombatResult(s, ctx, {
    attackerWon: true, attackerArmy: survivors, defenderArmy: [], xp: rawXp,
  });
  const ev = events.find((e) => e.type === 'bankLooted');
  assert.ok(ev, 'the bank was looted');
  return {
    ctx, reward: ev.reward, goldGained: s.players[0].resources.gold - goldBefore,
    xpGained: (hero.xp || 0) - xpBefore, rawXp,
    cost: before - armyValue(survivors),
  };
}

test('a tide-inflated guard pays the TABLE prize — the inflation does not reach the payout', () => {
  const def = CREATURE_BANKS.dwarvenTreasury;
  const { ctx, reward } = tideLoot('dwarvenTreasury', 4);
  assert.ok(ctx.tideScaled && ctx.tideScaleMult > 2,
    `fixture: the guard really was inflated (×${(ctx.tideScaleMult || 1).toFixed(0)})`);
  const fought = ctx.defenderArmy.reduce((n, st) => n + st.count, 0);
  assert.ok(fought > 4 * 2, `fixture: the hero fought ${fought}, not the placed 4`);
  for (const want of (def.reward.creatures || [])) {
    const got = reward.creatures.find((c) => c.creature === want.creature);
    assert.equal(got.count, want.count,
      `paid the table's ${want.count} ${want.creature}, not a share of the ${fought} it fought`);
  }
});

test('a genuinely large guard the MAP placed still pays its share', () => {
  // The share exists because weekly growth, the crawling peg and site respawn all move
  // a real garrison. That case is untouched — only the per-attacker fiction is.
  const { reward } = tideLoot('dwarvenTreasury', 4000);
  const paid = reward.creatures.reduce((n, c) => n + c.count, 0);
  const stacks = (CREATURE_BANKS.dwarvenTreasury.reward.creatures || []).length;
  assert.equal(paid, Math.round((4000 * CONFIG.BANK_REWARD_SHARE) / stacks) * stacks,
    'a big real garrison still pays BANK_REWARD_SHARE of itself');
});

test('a hard fight pays a gold premium, bounded by the site rather than the attacker', () => {
  const table = CREATURE_BANKS.dwarvenTreasury.reward.gold || 0;
  const cap = Math.round(table * CONFIG.BANK_PREMIUM_MAX);
  const free = tideLoot('dwarvenTreasury', 4, 0);
  const hard = tideLoot('dwarvenTreasury', 4, 0.3);
  assert.equal(free.goldGained, table, 'a fight that cost nothing pays exactly the table gold');
  assert.ok(hard.goldGained > free.goldGained, 'a costly fight pays more');
  assert.equal(hard.goldGained - free.goldGained,
    Math.min(cap, Math.round(hard.cost * CONFIG.BANK_COST_GOLD_SHARE)),
    'the premium is a share of what the battle took, capped at the site');
  assert.deepEqual(hard.reward.creatures, free.reward.creatures,
    'and it is paid in gold only — creatures cannot size the next fight');
});

test('the premium CANNOT scale with the attacker — the ceiling is the site s own gold', () => {
  // Without the cap this was the creature loop again in a different currency: the
  // sizer guarantees a scaled fight costs a target share of the attacker s army, so an
  // uncapped share of that cost grows with the army without bound. Measured before the
  // ceiling, a 400-Archangel hero minted 190,320 gold at a treasury whose table pays
  // 3,000.
  const table = CREATURE_BANKS.dwarvenTreasury.reward.gold || 0;
  const ceiling = table + Math.round(table * CONFIG.BANK_PREMIUM_MAX);
  const big = tideLoot('dwarvenTreasury', 4, 0.3, [{ creature: 'archangel', count: 500, hurt: 0 }]);
  assert.ok(big.cost > ceiling * 10,
    `fixture: the fight really was expensive (cost ${Math.round(big.cost)} vs ceiling ${ceiling})`);
  assert.ok(big.goldGained <= ceiling,
    `a huge hero cannot mint gold here (${big.goldGained} must be <= ${ceiling})`);
});

test('battle XP is paid off the garrison the MAP placed, not the inflated corpse pile', () => {
  // The third payout off the same pile, and the one that was missed: the creature
  // prize and the necromancy raise were both un-inflated and result.xp was not. It
  // compounds now in a way it did not before, precisely because the sizer READS the
  // commander — inflated XP buys levels, a higher-level commander is met with a bigger
  // scaled guard, and a bigger guard leaves a bigger pile.
  const small = tideLoot('dwarvenTreasury', 4, 0.2, [{ creature: 'marksman', count: 60, hurt: 0 }]);
  const big = tideLoot('dwarvenTreasury', 4, 0.2, [{ creature: 'archangel', count: 500, hurt: 0 }]);
  assert.ok(big.ctx.tideScaleMult > small.ctx.tideScaleMult * 5,
    'fixture: the two heroes met very different garrisons');
  assert.ok(big.xpGained < big.rawXp / 10,
    `XP is divided back down (${big.xpGained} from a ${Math.round(big.rawXp)} pile)`);
  // Close, not equal: the un-inflation divides by each fight's own multiplier, so two
  // heroes who met very different garrisons land within rounding of each other rather
  // than exactly on the same integer.
  assert.ok(Math.abs(small.xpGained - big.xpGained) <= Math.max(8, small.xpGained * 0.02),
    `the same four dwarves are worth about the same XP to either hero `
    + `(${small.xpGained} vs ${big.xpGained})`);
});
