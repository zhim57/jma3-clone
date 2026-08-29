/**
 * core.test.js — Headless tests for the rule engine (no Phaser required).
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, XP_TABLE } from '../src/config.js';
import { CREATURES } from '../src/data/creatures.js';
import { FACTIONS } from '../src/data/factions.js';
import { DWELLINGS } from '../src/data/buildings.js';
import {
  newGame, serialize, deserialize, playerHeroes, playerTowns,
  weekOf, dayOfWeek, tileAt,
} from '../src/core/GameState.js';
import {
  endTurn, buildStructure, buildBlockReason, recruit, recruitableCreature,
  stepHero, gainXp, chooseSkill, dailyIncome, marketTrade,
  combatContext, applyCombatResult, giveArtifact, equipArtifact, unequipArtifact,
  giveArtifactToHero, resolveChest, rollChestContents,
} from '../src/core/actions.js';
import { heroMaxMovement, heroMaxMana, slowestSpeed, armyValue } from '../src/core/heroUtils.js';
import { findPath } from '../src/map/Pathfinding.js';
import {
  createBattle, act, castSpell, hexDistance,
} from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { Rng } from '../src/core/rng.js';

const SEED = 12345;

function freshGame() {
  return newGame({ seed: SEED });
}

// ---------------------------------------------------------------------------

test('data sanity: every faction has 7 tiers, base + upgrade', () => {
  for (const fid of Object.keys(FACTIONS)) {
    for (let tier = 1; tier <= 7; tier++) {
      const base = Object.values(CREATURES).filter((c) => c.faction === fid && c.tier === tier && !c.upgraded);
      const upg = Object.values(CREATURES).filter((c) => c.faction === fid && c.tier === tier && c.upgraded);
      assert.equal(base.length, 1, `${fid} tier ${tier} base`);
      assert.equal(upg.length, 1, `${fid} tier ${tier} upgrade`);
    }
    // Dwellings for all 7 tiers exist.
    for (let t = 1; t <= 7; t++) {
      assert.ok(DWELLINGS[fid][`dwelling${t}`], `${fid} dwelling${t}`);
      assert.ok(DWELLINGS[fid][`dwelling${t}u`], `${fid} dwelling${t}u`);
    }
  }
});

test('new game: players, towns, heroes, fog', () => {
  const s = freshGame();
  assert.equal(s.players.length, 2);
  assert.equal(playerTowns(s, 0).length, 1);
  assert.equal(playerTowns(s, 1).length, 1);
  assert.equal(playerHeroes(s, 0).length, 1);
  assert.equal(playerHeroes(s, 1).length, 1);
  const hero = playerHeroes(s, 0)[0];
  assert.ok(hero.mp > 0, 'hero has movement');
  assert.ok(hero.army.some((st) => st && st.count > 0), 'hero has troops');
  // Fog: some explored around start, most of the far corner hidden.
  const fog = s.fog[0];
  const explored = fog.reduce((n, v) => n + v, 0);
  assert.ok(explored > 20 && explored < s.map.w * s.map.h, 'partial fog');
});

test('map connectivity: enemy town reachable once guards are cleared', () => {
  const s = freshGame();
  // Guards project zones of control, so raw connectivity is checked with
  // monsters removed (fighting through them is the intended route).
  for (const obj of Object.values(s.map.objects)) {
    if (obj.type === 'monster') {
      s.map.tiles[obj.y * s.map.w + obj.x].objectId = null;
      delete s.map.objects[obj.id];
    }
  }
  const hero = playerHeroes(s, 0)[0];
  const enemyTown = playerTowns(s, 1)[0];
  const path = findPath(s, hero, enemyTown.x, enemyTown.y, -1);
  assert.ok(path, 'path to enemy town exists');
  assert.ok(path.totalCost > 0);
});

test('guards exert zone of control: entering an adjacent tile means battle', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  const monster = Object.values(s.map.objects).find((o) => o.type === 'monster');
  assert.ok(monster);
  // Stand two tiles away, step into the guard's zone of control.
  const t = tileAt(s, monster.x, monster.y + 1);
  assert.ok(t && !t.obstacle && !t.objectId, 'free tile below monster');
  hero.x = monster.x;
  hero.y = monster.y + 2;
  hero.mp = 1500;
  const ev = stepHero(s, hero, { x: monster.x, y: monster.y + 1, cost: 100 });
  assert.equal(ev.type, 'combat');
  assert.equal(ev.context.defender.kind, 'monster');
  assert.equal(ev.context.defender.objectId, monster.id);
});

test('movement points follow slowest creature + artifacts', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  const spd = slowestSpeed(hero);
  const expectedBase = Math.min(CONFIG.MP_BASE + Math.max(0, spd - 4) * CONFIG.MP_PER_SPEED, CONFIG.MP_MAX_FROM_SPEED);
  assert.equal(heroMaxMovement(hero), expectedBase);
  // Boots of Speed add exactly their bonus.
  giveArtifact(s, hero, 'bootsOfSpeed');
  assert.equal(heroMaxMovement(hero), expectedBase + 600);
});

test('artifacts: a movement/mana artifact helps the same day (live pools)', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  // Start the day with a full, boots-free movement pool.
  hero.equipment.feet = null;
  hero.backpack = [];
  hero.mp = heroMaxMovement(hero);
  const mpFull = hero.mp;

  // Equip Boots of Speed from the backpack: the remaining path lengthens NOW,
  // not only after the next daily refresh.
  hero.backpack.push('bootsOfSpeed');
  assert.equal(equipArtifact(s, hero, 0, 'feet'), true);
  assert.equal(hero.mp, mpFull + 600, 'live MP rises by the boots bonus the same day');

  // Unequipping symmetrically shortens it, so equip/unequip cycling nets zero.
  unequipArtifact(s, hero, 'feet');
  assert.equal(hero.mp, mpFull, 'removing the boots gives the movement back');

  // A picked-up mana artifact (auto-equip) raises the live mana pool too.
  hero.equipment.head = null;
  hero.mana = heroMaxMana(hero);
  const manaFull = hero.mana;
  const capBefore = heroMaxMana(hero);
  assert.equal(giveArtifact(s, hero, 'alabasterHelm'), 'head', 'helm auto-equips into head');
  const delta = heroMaxMana(hero) - capBefore;
  assert.ok(delta > 0, 'the +Knowledge helm raises the mana cap');
  assert.equal(hero.mana, manaFull + delta, 'live mana rises by the same amount the same day');
});

test('turn engine: days, weeks, income, growth', () => {
  const s = freshGame();
  const p0 = s.players[0];
  const goldBefore = p0.resources.gold;
  const town = playerTowns(s, 0)[0];
  const t1Before = town.available[1];

  // Play through a full week.
  for (let i = 0; i < 2 * CONFIG.DAYS_PER_WEEK; i++) endTurn(s);
  assert.equal(s.day, 1 + CONFIG.DAYS_PER_WEEK);
  assert.equal(weekOf(s.day), 2);
  assert.equal(dayOfWeek(s.day), 1);
  assert.ok(p0.resources.gold > goldBefore, 'hall income accrued');
  assert.ok(town.available[1] > t1Before, 'weekly growth happened');
});

test('town building: prereqs, cost, one per day', () => {
  const s = freshGame();
  const town = playerTowns(s, 0)[0];
  const p = s.players[0];
  p.resources.gold = 100000;
  p.resources.wood = 100; p.resources.ore = 100;

  assert.ok(buildBlockReason(s, town, 'capitol'), 'capitol blocked without prereqs');
  assert.equal(buildBlockReason(s, town, 'dwelling2'), null, 'archers tower OK (dwelling1 prebuilt)');
  assert.ok(buildStructure(s, town, 'dwelling2'));
  assert.equal(buildBlockReason(s, town, 'marketplace'), 'Already built today');
  endTurn(s); endTurn(s); // AI turn + new day
  assert.equal(buildBlockReason(s, town, 'marketplace'), null);
  assert.ok(buildStructure(s, town, 'marketplace'));
  // Dwelling opened with a week of stock.
  assert.ok(town.available[2] >= CREATURES.archer.growth);
  // Starting dwelling came pre-stocked.
  assert.ok(town.available[1] >= CREATURES.pikeman.growth);
});

test('recruiting drains availability and gold, fills hero army', () => {
  const s = freshGame();
  const town = playerTowns(s, 0)[0];
  const p = s.players[0];
  p.resources.gold = 100000; p.resources.wood = 100;
  buildStructure(s, town, 'dwelling1');
  assert.equal(recruitableCreature(town, 1), 'pikeman');

  const avail = town.available[1];
  const goldBefore = p.resources.gold;
  const got = recruit(s, town, 1, avail);
  assert.equal(got, avail);
  assert.equal(town.available[1], 0);
  assert.equal(p.resources.gold, goldBefore - avail * CREATURES.pikeman.cost.gold);
  assert.ok(armyValue(town.garrison) > 0, 'no visiting hero: goes to garrison');
});

test('marketplace trading', () => {
  const s = freshGame();
  const p = s.players[0];
  p.resources.wood = 10; p.resources.gold = 1000;
  assert.ok(marketTrade(s, p, 'sell', 'wood', 5));
  assert.equal(p.resources.wood, 5);
  assert.equal(p.resources.gold, 1000 + 5 * 50);
  assert.ok(marketTrade(s, p, 'buy', 'ore', 1));
});

test('xp/levels: stat growth and skill choices queue', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  const statSumBefore = Object.values(hero.stats).reduce((a, b) => a + b, 0);
  gainXp(s, hero, XP_TABLE[3]); // jump to level 3
  assert.equal(hero.level, 3);
  assert.equal(hero.pendingSkillChoices.length, 2);
  const statSumAfter = Object.values(hero.stats).reduce((a, b) => a + b, 0);
  assert.equal(statSumAfter, statSumBefore + 2);
  const skillsBefore = Object.entries(hero.skills).map(([k, v]) => `${k}:${v}`).join();
  chooseSkill(s, hero, 0);
  const skillsAfter = Object.entries(hero.skills).map(([k, v]) => `${k}:${v}`).join();
  assert.notEqual(skillsAfter, skillsBefore);
  assert.equal(hero.pendingSkillChoices.length, 1);
});

test('combat: stronger army wins, XP flows, engine terminates', () => {
  const rng = new Rng(7);
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng,
    attacker: { hero: null, army: [{ creature: 'archangel', count: 10 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'imp', count: 5 }], playerIndex: 1 },
  });
  const result = autoResolve(battle);
  assert.equal(result.attackerWon, true);
  assert.ok(result.attackerArmy[0].count === 10, 'archangels unharmed-ish');
  assert.equal(result.defenderArmy.length, 0);
  assert.equal(result.baseXp, 5 * CREATURES.imp.aiValue, 'base XP is the enemy army VALUE destroyed');
  assert.equal(result.xp, result.flawless
    ? Math.round(result.baseXp * (1 + CONFIG.FLAWLESS_XP_BONUS))
    : result.baseXp, 'awarded XP adds the flawless premium only when nothing died');
});

test('combat: retaliation happens once per round', () => {
  const rng = new Rng(3);
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng,
    attacker: { hero: null, army: [{ creature: 'pikeman', count: 50 }, { creature: 'pikeman', count: 50 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 50 }], playerIndex: 1 },
  });
  // Manually drive: move both attackers adjacent to defender and strike.
  const def = battle.units.find((u) => u.side === 1);
  const [a1, a2] = battle.units.filter((u) => u.side === 0);
  a1.x = def.x - 1; a1.y = def.y;
  a2.x = def.x - 1; a2.y = def.y - 1;
  const ev1 = act(battle, a1, { type: 'attack', targetId: def.id });
  const ev2 = act(battle, a2, { type: 'attack', targetId: def.id });
  const retals1 = ev1.filter((e) => e.type === 'retaliate').length;
  const retals2 = ev2.filter((e) => e.type === 'retaliate').length;
  assert.equal(retals1, 1, 'first melee attack draws retaliation');
  assert.equal(retals2, 0, 'second attack in same round does not');
});

test('combat: hero spell damages and consumes mana; one cast per round', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  hero.spells = ['magicArrow'];
  hero.stats.power = 5;
  hero.mana = 20;
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: s.rng,
    attacker: { hero, army: [{ creature: 'pikeman', count: 10 }], playerIndex: 0 },
    defender: { hero: null, army: [{ creature: 'peasant', count: 100 }], playerIndex: 1 },
  });
  const target = battle.units.find((u) => u.side === 1);
  const before = target.count;
  const events = castSpell(battle, 0, 'magicArrow', { unitId: target.id });
  assert.ok(events.some((e) => e.type === 'spellHit'));
  assert.ok(target.count < before, 'peasants died');
  assert.equal(hero.mana, 15);
  const again = castSpell(battle, 0, 'magicArrow', { unitId: target.id });
  assert.equal(again.length, 0, 'second cast same round refused');
});

test('combat vs monster on map: applyCombatResult removes the guard', () => {
  // Scaling off: this is about the REMOVAL plumbing, and a wild stack scaled to a
  // fraction of the attacker's army is no longer a guaranteed win to plumb.
  const s = newGame({ seed: SEED, pveScaling: false });
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 20, hurt: 0 }, null, null, null, null, null, null];
  const monster = Object.values(s.map.objects).find((o) => o.type === 'monster');
  assert.ok(monster);
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: monster.id });
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng: s.rng,
    attacker: { hero, army: hero.army.filter(Boolean), playerIndex: 0 },
    defender: { hero: null, army: ctx.defenderArmy, playerIndex: -1 },
  });
  const result = autoResolve(battle);
  assert.ok(result.attackerWon);
  applyCombatResult(s, ctx, result);
  assert.ok(!s.map.objects[monster.id], 'monster removed from map');
  assert.ok(hero.xp > 0, 'hero got XP');
});

test('stepHero: resource pickup and mine flagging', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  // Clear guards so zones of control don't intercept these walks.
  for (const obj of Object.values(s.map.objects)) {
    if (obj.type === 'monster') {
      s.map.tiles[obj.y * s.map.w + obj.x].objectId = null;
      delete s.map.objects[obj.id];
    }
  }
  // Teleport the hero next to a resource pile (test convenience).
  const res = Object.values(s.map.objects).find((o) => o.type === 'resource');
  assert.ok(res);
  hero.x = res.x; hero.y = res.y - 1;
  const before = s.players[0].resources[res.resource] || 0;
  const ev = stepHero(s, hero, { x: res.x, y: res.y, cost: 100 });
  assert.equal(ev.type, 'pickup');
  assert.ok(s.players[0].resources[res.resource] > before);

  const mine = Object.values(s.map.objects).find((o) => o.type === 'mine');
  hero.x = mine.x; hero.y = mine.y - 1;
  hero.mp = 1000;
  const ev2 = stepHero(s, hero, { x: mine.x, y: mine.y, cost: 100 });
  assert.equal(ev2.type, 'mineFlagged');
  assert.equal(mine.owner, 0);
  const income = dailyIncome(s, s.players[0]);
  const [resName, amount] = Object.entries(CONFIG.MINE_INCOME[mine.mineType])[0];
  assert.ok(income[resName] >= amount, 'mine contributes to income');
});

test('guarded chest: winning the guard fight awards the prize (engine contract)', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  // A chest sits on the hero's tile (the guard's ZoC dragged the hero onto it and
  // the guard has just been beaten). objectAt reads the tile's objectId.
  const chestId = 'chestUnderGuardTest';
  s.map.objects[chestId] = { id: chestId, type: 'chest', x: hero.x, y: hero.y };
  s.map.tiles[hero.y * s.map.w + hero.x].objectId = chestId;
  // The defeated guard, on an adjacent tile.
  const monId = 'guardTest';
  s.map.objects[monId] = { id: monId, type: 'monster', x: hero.x + 1, y: hero.y, creature: 'peasant', count: 1 };

  const ctx = combatContext(s, hero, { kind: 'monster', objectId: monId });
  const result = { attackerWon: true, attackerArmy: hero.army.filter(Boolean).map((st) => ({ ...st })), defenderArmy: [], xp: 0 };
  const events = applyCombatResult(s, ctx, result);

  const chestEv = events.find((e) => e.type === 'chestUnderGuard');
  assert.ok(chestEv, 'a chest won under a guard surfaces a chestUnderGuard event');
  assert.equal(chestEv.objectId, chestId);
  assert.ok(chestEv.gold > 0, 'with pre-rolled contents');

  // Resolving it (as both the AI and the scene now do) pays out and consumes it.
  const goldBefore = s.players[0].resources.gold;
  resolveChest(s, hero, chestEv.objectId, 'gold');
  assert.equal(s.players[0].resources.gold, goldBefore + chestEv.gold, 'gold is awarded (from the stashed contents)');
  assert.equal(s.map.objects[chestId], undefined, 'the chest is consumed, not left on the floor');
});

test('rollChestContents: gold from the CONFIG tiers, xp = gold - penalty (E43)', () => {
  const s = freshGame();
  // The flat CHEST_GOLD_OPTIONS list became a weighted tier table, so the check is
  // now "inside one of the bands" rather than "one of three exact values".
  for (let i = 0; i < 40; i++) {
    const c = rollChestContents(s);
    assert.ok(CONFIG.CHEST_GOLD_TIERS.some((t) => c.gold >= t.min && c.gold <= t.max),
      `gold ${c.gold} is outside every CHEST_GOLD_TIERS band`);
    assert.equal(c.xp, Math.round((c.gold - CONFIG.CHEST_XP_PENALTY) * CONFIG.XP_PER_GOLD),
      'xp = (gold - penalty) converted at the gold-to-experience rate');
  }
});

test('resolveChest pays the STASHED contents, ignoring any caller amount (E46)', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  const chestId = 'chestStash';
  // Stash a known payout on the object, as interactWithObject does at roll time.
  s.map.objects[chestId] = { id: chestId, type: 'chest', x: hero.x, y: hero.y, chest: { gold: 1500, xp: 1000 } };
  const before = s.players[0].resources.gold;
  // resolveChest no longer accepts an amount at all — it reads the object.
  resolveChest(s, hero, chestId, 'gold');
  assert.equal(s.players[0].resources.gold, before + 1500, 'exactly the stashed gold, not a caller value');
});

test('guarded chest: the AI claims it instead of dropping it', () => {
  const s = freshGame();
  const ai = new AITurnController(s, 1);
  const hero = playerHeroes(s, 1)[0];
  const chestId = 'aiChestTest';
  s.map.objects[chestId] = { id: chestId, type: 'chest', x: hero.x, y: hero.y };
  s.map.tiles[hero.y * s.map.w + hero.x].objectId = chestId;
  const monId = 'aiGuardTest';
  s.map.objects[monId] = { id: monId, type: 'monster', x: hero.x + 1, y: hero.y, creature: 'peasant', count: 1 };

  const ctx = combatContext(s, hero, { kind: 'monster', objectId: monId });
  const goldBefore = s.players[1].resources.gold;
  const xpBefore = hero.xp;
  ai.autoFight(ctx); // hero vastly outmatches one peasant → wins, then must claim the chest
  const claimed = s.players[1].resources.gold > goldBefore || hero.xp > xpBefore;
  assert.ok(claimed, 'the AI resolved the chest (gold early, XP later) rather than dropping it');
  assert.equal(s.map.objects[chestId], undefined, 'the chest was consumed');
});

test('equip artifact into matching socket', () => {
  const s = freshGame();
  const hero = playerHeroes(s, 0)[0];
  hero.backpack.push('centaurAxe');
  assert.equal(equipArtifact(s, hero, 0, 'head'), false, 'wrong socket refused');
  assert.equal(equipArtifact(s, hero, 0, 'weapon'), true);
  assert.equal(hero.equipment.weapon, 'centaurAxe');
});

test('giveArtifactToHero: worn + carried trade, cap reclamp, guards, roundtrip', () => {
  const s = freshGame();
  const from = playerHeroes(s, 0)[0];
  const to = playerHeroes(s, 1)[0];
  // Clean slate on the sockets we exercise.
  from.equipment.feet = null; from.equipment.weapon = null; from.backpack = [];
  to.equipment.feet = null; to.equipment.weapon = null; to.backpack = [];

  // Worn Boots of Speed: giving them away costs `from` the movement the same
  // day and lengthens `to`'s day (auto-equip into their free feet socket).
  giveArtifact(s, from, 'bootsOfSpeed');
  assert.equal(from.equipment.feet, 'bootsOfSpeed');
  from.mp = heroMaxMovement(from);
  const fromMpBefore = from.mp;
  to.mp = heroMaxMovement(to);
  const toMpBefore = to.mp;

  const moved = giveArtifactToHero(s, from, to, { equip: 'feet' });
  assert.equal(moved, 'bootsOfSpeed');
  assert.equal(from.equipment.feet, null, 'from no longer wears the boots');
  assert.equal(to.equipment.feet, 'bootsOfSpeed', 'to auto-equips the boots');
  assert.equal(from.mp, fromMpBefore - 600, 'from loses the boots movement the same day');
  assert.equal(to.mp, toMpBefore + 600, 'to gains the boots movement the same day');

  // Carried artifact: moves without touching movement/mana caps.
  from.backpack.push('centaurAxe');
  const moved2 = giveArtifactToHero(s, from, to, { backpack: 0 });
  assert.equal(moved2, 'centaurAxe');
  assert.equal(from.backpack.length, 0, 'from no longer carries the axe');
  assert.equal(to.equipment.weapon, 'centaurAxe', 'to auto-equips the axe into its free weapon socket');

  // Guards: empty source / same hero / missing index all return null and mutate nothing.
  assert.equal(giveArtifactToHero(s, from, to, { equip: 'feet' }), null, 'empty socket → null');
  assert.equal(giveArtifactToHero(s, from, from, { backpack: 0 }), null, 'same hero → null');
  assert.equal(giveArtifactToHero(s, from, to, { backpack: 9 }), null, 'missing backpack index → null');
  assert.equal(giveArtifactToHero(s, from, to, {}), null, 'no equip/backpack key → null');

  // Save round-trip: the transferred equipment survives serialization.
  const s2 = deserialize(serialize(s));
  assert.equal(s2.heroes[to.id].equipment.feet, 'bootsOfSpeed');
  assert.equal(s2.heroes[to.id].equipment.weapon, 'centaurAxe');
});

test('serialization: full roundtrip preserves behavior', () => {
  const s = freshGame();
  endTurn(s); endTurn(s);
  const json = serialize(s);
  const s2 = deserialize(json);
  assert.equal(s2.day, s.day);
  assert.equal(Object.keys(s2.heroes).length, Object.keys(s.heroes).length);
  assert.deepEqual(s2.players[0].resources, s.players[0].resources);
  // The restored rng continues the same stream.
  assert.equal(s.rng.random(), s2.rng.random());
  // And the restored game still runs.
  endTurn(s2);
  assert.ok(s2.day >= s.day);
});

test('AI: takes a full turn without errors and does something useful', () => {
  const s = freshGame();
  endTurn(s); // hand over to AI (player 1)
  assert.equal(s.currentPlayer, 1);
  const ai = new AITurnController(s, 1);
  let guard = 50;
  let r;
  do {
    r = ai.next();
    // Interactive combat vs the human: auto-resolve it for the test.
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done');
});

test('full-game smoke: 3 weeks of AI vs AI stays consistent', () => {
  const s = freshGame();
  let guard = 400;
  while (s.winner === null && s.day <= 21 && guard-- > 0) {
    const ai = new AITurnController(s, s.currentPlayer);
    let r;
    let g2 = 60;
    do {
      r = ai.next();
      if (r.type === 'combat') ai.autoFight(r.context);
    } while (r.type !== 'done' && g2-- > 0);
    endTurn(s);
  }
  assert.ok(guard > 0, 'no infinite loop');
  // Invariants after weeks of play:
  for (const h of Object.values(s.heroes)) {
    assert.ok(h.mp >= 0, 'mp never negative');
    assert.ok(h.army.every((st) => !st || st.count > 0), 'no empty stacks');
  }
  for (const p of s.players) {
    for (const v of Object.values(p.resources)) assert.ok(v >= 0, 'resources never negative');
  }
});

test('hex math: distances are sane', () => {
  assert.equal(hexDistance(0, 0, 5, 0), 5);
  assert.equal(hexDistance(0, 0, 0, 4), 4);
  assert.ok(hexDistance(0, 0, 14, 10) <= 24);
});
