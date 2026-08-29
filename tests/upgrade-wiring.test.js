/**
 * upgrade-wiring.test.js — upgrade nodes reaching an actual fight.
 *
 * The schema and the gate are covered in upgrade-nodes.test.js. This file is
 * about the wiring: a node bought in a town has to change what that player's
 * creatures physically are, in every battle path, for that player only, without
 * moving anything for a game that never buys one.
 *
 * The four properties, in the order they would hurt if broken:
 *
 *   NOBODY OWNING A NODE CHANGES NOTHING. Byte-identical result and identical
 *   rng.calls against a battle built with no upgrades field at all. This is the
 *   whole licence for the wiring to exist: every balance number and every
 *   recorded seed in the project predates it.
 *
 *   A NODE PATCHES ITS OWNER'S CREATURES ONLY. Nodes patch both halves of a
 *   `phys` block — the blow AND the body — so reading one player's list for both
 *   sides would hand your enemy your mail. The blow is patched by whoever owns
 *   the attacker, the body by whoever owns the defender.
 *
 *   A SIDE WITH NO OWNER OWNS NOTHING. Monster stacks, creature banks, pandora
 *   guards and invader war-bands all fight at playerIndex -1.
 *
 *   THE TRADEOFF SURVIVES THE TRIP. Heavy Draw is +32% energy and a 20% wider
 *   group; if only the good half reached the engine the schema's central rule
 *   would be decorative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattle, act } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { Rng } from '../src/core/rng.js';
import { playerUpgrades, upgradesForSide } from '../src/core/upgrades.js';
import { newGame, serialize, deserialize, canAfford } from '../src/core/GameState.js';
import { buyUpgradeNode, upgradeNodeBlockReason } from '../src/core/actions.js';
import { runDays } from './helpers.js';

const SEED = 411989;
const PHYS = { physicalDamage: true };

const ELVES = [{ creature: 'woodElf', count: 30, hurt: 0 }];
const FOE = [{ creature: 'pikeman', count: 30, hurt: 0 }];

/** A battle of elves vs pikemen; `upgrades` is the per-player-index array. */
function build({ upgrades, features = PHYS, defenderOwner = 1 }) {
  const rng = new Rng(SEED);
  const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
    rng, features, upgrades, simulated: true,
    attacker: { hero: null, army: ELVES.map((s) => ({ ...s })), playerIndex: 0 },
    defender: { hero: null, army: FOE.map((s) => ({ ...s })), playerIndex: defenderOwner },
  });
  return { battle, rng };
}

/** Damage one volley deals, with the shooter placed `dist` hexes from its target. */
function volley(opts, dist) {
  const { battle, rng } = build(opts);
  const shooter = battle.units.find((u) => u.side === 0 && u.alive);
  const target = battle.units.find((u) => u.side === 1 && u.alive);
  target.x = shooter.x + dist;
  target.y = shooter.y;
  const pool = (u) => (u.count - 1) * u.maxHp + u.hp;
  const before = pool(target), calls = rng.calls;
  act(battle, shooter, { type: 'shoot', targetId: target.id });
  return { dealt: before - pool(target), draws: rng.calls - calls };
}

// ---- the licence ------------------------------------------------------------

test('wiring: a game where nobody owns a node is byte-identical to no wiring at all', () => {
  const digest = (upgrades) => {
    const { battle, rng } = build({ upgrades });
    const result = autoResolve(battle);
    return JSON.stringify({
      won: result.attackerWon, atk: result.attackerArmy, def: result.defenderArmy,
      xp: result.xp, calls: rng.calls,
    });
  };
  const none = digest(undefined);            // no upgrades field at all
  assert.equal(digest([]), none, 'an empty upgrade table must not move the fight');
  assert.equal(digest([[], []]), none, 'two players owning nothing must not move it either');
  // And the same holds with the physical model OFF, where the field is not even read.
  const { battle: a, rng: ra } = build({ upgrades: [[], []], features: { physicalDamage: false } });
  const { battle: b, rng: rb } = build({ upgrades: undefined, features: { physicalDamage: false } });
  assert.equal(JSON.stringify(autoResolve(a)), JSON.stringify(autoResolve(b)));
  assert.equal(ra.calls, rb.calls);
});

test('wiring: an owned node does not change how much rng a fight draws', () => {
  // The same contract Phase 2 pinned for the model itself. A patch that altered
  // the draw count would put an upgraded player on a different seed from an
  // un-upgraded one, and no two sweeps would be comparable again.
  const bare = volley({ upgrades: [[], []] }, 4);
  const armed = volley({ upgrades: [['homestead.fletchery.drawWeight'], []] }, 4);
  assert.equal(armed.draws, bare.draws, `${armed.draws} draws vs ${bare.draws}`);
  assert.ok(bare.draws > 0 && bare.dealt > 0, 'the fixture must actually shoot');
});

// ---- the node has to do something, in both directions -----------------------

test('wiring: Heavy Draw hits harder up close and worse at range — the tradeoff is real', () => {
  const armed = ['homestead.fletchery.drawWeight'];
  const near = { bare: volley({ upgrades: [[], []] }, 3), up: volley({ upgrades: [armed, []] }, 3) };
  assert.ok(near.up.dealt > near.bare.dealt,
    `close in, +32% energy should tell: ${near.up.dealt} vs ${near.bare.dealt}`);

  // Far out, the 20% wider group is an area penalty that grows as d², and it
  // overtakes the energy gain. If this passes only because both numbers are
  // equal, the patch never reached the engine — so require a strict loss.
  const far = { bare: volley({ upgrades: [[], []] }, 13), up: volley({ upgrades: [armed, []] }, 13) };
  assert.ok(far.up.dealt < far.bare.dealt,
    `far out, the open group should cost more than the energy buys: ${far.up.dealt} vs ${far.bare.dealt}`);
});

test('wiring: a node patches its owner only — an enemy never inherits your mail', () => {
  // Wardens' Mail raises armorHardness_gpa and armorCoverage_frac: a DEFENDER-side patch.
  // Given to player 0 (the attacker) it must not toughen player 1's pikemen, and
  // the elves' own volley must weaken slightly (it also drops arrow mass 10%).
  const mail = ['homestead.armoury.wardensMail'];
  const bare = volley({ upgrades: [[], []] }, 4);
  const mineOnly = volley({ upgrades: [mail, []] }, 4);
  assert.ok(mineOnly.dealt < bare.dealt,
    'the mail owner should lose a little bite (−10% arrow mass), not gain the defence');

  // Now give the SAME node to the defender instead. Wood Elves are rampart, so
  // the node names no creature player 1 fields — nothing at all should move.
  const theirs = volley({ upgrades: [[], mail] }, 4);
  assert.equal(theirs.dealt, bare.dealt,
    'a node naming creatures the defender does not field must be inert');
});

test('wiring: a side with no owning player owns nothing', () => {
  // Neutral stacks, banks, pandora guards and invader bands all fight at -1.
  const { battle } = build({ upgrades: [['homestead.fletchery.drawWeight'], []], defenderOwner: -1 });
  assert.equal(upgradesForSide(battle, 1), null, 'playerIndex -1 must index nothing');
  assert.deepEqual(upgradesForSide(battle, 0), ['homestead.fletchery.drawWeight']);

  // And the neutral side is unaffected by what player 0 owns, in damage terms.
  const neutral = volley({ upgrades: [[], []], defenderOwner: -1 }, 4);
  const owned = volley({ upgrades: [[], ['homestead.armoury.wardensMail']], defenderOwner: -1 }, 4);
  assert.equal(owned.dealt, neutral.dealt, 'nobody owns the neutral side, so nothing patches it');
});

// CLONE: the upgrade fixtures below use INFERNO's Kennels tree, not upstream's
// rampart Homestead tree. These tests buy a node THROUGH A TOWN, so the node's
// faction has to match the town's — and only castle and inferno are playable here
// (data/factions.js). The two trees are the same shape (a tier-3 dwelling, one base
// node at 5,200g and dependents at 5,600g, two-crew seven-day builds), so every
// assertion below is testing exactly what it tested upstream.
// ---- state, purchase, save --------------------------------------------------

const upgradeGame = () => newGame({
  seed: 7, players: [
    { faction: 'inferno', isHuman: true, team: 0 },
    { faction: 'castle', isHuman: false, team: 1 },
  ],
});

/** The first town owned by `pi`, with `buildings` forced on. */
function townFor(state, pi, buildings = []) {
  const town = Object.values(state.towns).find((t) => t.owner === pi);
  assert.ok(town, `player ${pi} has no town`);
  for (const b of buildings) if (!town.buildings.includes(b)) town.buildings.push(b);
  return town;
}

test('wiring: buying a node needs the dwelling, the faction, and the resources', () => {
  const state = upgradeGame();
  const town = townFor(state, 0);
  assert.match(upgradeNodeBlockReason(state, town, 'kennels.kennel.honedFangs'), /^Requires /,
    'without the Kennels built, the branch is not on offer');

  town.buildings.push('dwelling3');
  state.players[0].resources.gold = 10_000;
  state.players[0].resources.wood = 100;
  assert.equal(upgradeNodeBlockReason(state, town, 'kennels.kennel.honedFangs'), null);

  // Wrong faction: a Castle town can never train inferno hounds.
  const castleTown = townFor(state, 1, ['dwelling3']);
  assert.match(upgradeNodeBlockReason(state, castleTown, 'kennels.kennel.honedFangs'), /Only inferno/);

  // Broke.
  state.players[0].resources.gold = 5;
  assert.equal(upgradeNodeBlockReason(state, town, 'kennels.kennel.honedFangs'), 'Not enough resources');
});

test('wiring: buying pays now and grants when the crews finish', () => {
  // Phase 7 routed this through state.jobs: the cost is taken at once and the
  // node lands days later. Everything below used to assert an instant grant.
  const state = upgradeGame();
  const town = townFor(state, 0, ['dwelling3']);
  const p = state.players[0];
  p.resources.gold = 20_000; p.resources.wood = 100;
  const goldBefore = p.resources.gold;

  const started = buyUpgradeNode(state, town, 'kennels.kennel.honedFangs');
  assert.equal(started.ok, true);
  assert.ok(p.resources.gold < goldBefore, 'the purchase must cost gold up front');
  assert.deepEqual(p.upgrades, [], 'and not be granted on the same day');
  assert.ok(state.log.some((l) => /begins training/i.test(l.text)));

  assert.match(buyUpgradeNode(state, town, 'kennels.kennel.honedFangs').reason, /lready under way/,
    'and it cannot be queued twice');

  runDays(state, started.job.days);
  assert.deepEqual(p.upgrades, ['kennels.kennel.honedFangs'], 'granted on the last crew-day');

  // Through the real action: the dependent node opens once its prerequisite is granted,
  // and cannot then be queued a second time. (There is no sibling to exclude any more —
  // the fletchery fork was cut, §8i.)
  assert.equal(buyUpgradeNode(state, town, 'kennels.kennel.studdedCollars').ok, true);
  assert.match(buyUpgradeNode(state, town, 'kennels.kennel.studdedCollars').reason, /lready under way/,
    'and not twice');
});

test('wiring: buying an upgrade does not spend the town\'s build for the day', () => {
  // Deliberate: the daily build budget belongs to the building tree. If an
  // upgrade consumed it, every node bought would silently cost a dwelling.
  const state = upgradeGame();
  const town = townFor(state, 0, ['dwelling3']);
  state.players[0].resources.gold = 20_000; state.players[0].resources.wood = 100;
  assert.equal(buyUpgradeNode(state, town, 'kennels.kennel.honedFangs').ok, true);
  assert.ok(!town.builtToday, 'training troops is not building a building');
});

test('wiring: owned nodes survive a save round-trip with no migration', () => {
  const state = upgradeGame();
  const town = townFor(state, 0, ['dwelling3']);
  state.players[0].resources.gold = 20_000; state.players[0].resources.wood = 100;
  const started = buyUpgradeNode(state, town, 'kennels.kennel.honedFangs');
  runDays(state, started.job.days);

  const back = deserialize(serialize(state));
  assert.deepEqual(back.players[0].upgrades, ['kennels.kennel.honedFangs']);
  assert.deepEqual(back.players[1].upgrades, []);
  assert.equal(serialize(back), serialize(state), 'the round trip must be byte-identical');
});

test('wiring: a save written before the field existed reads as owning nothing', () => {
  // The §2.2 escape: no migration, no SAVE_VERSION bump. Every reader takes
  // `?? []`, so an in-progress game adopts the system by simply not having used
  // it yet — which is the difference between shipping this and never shipping it
  // to anyone mid-campaign.
  const state = upgradeGame();
  const raw = JSON.parse(serialize(state));
  for (const p of raw.players) delete p.upgrades;
  const old = deserialize(JSON.stringify(raw));
  assert.deepEqual(playerUpgrades(old), [[], []], 'a fieldless save must read as empty, not undefined');

  const town = townFor(old, 0, ['dwelling3']);
  old.players[0].resources.gold = 20_000; old.players[0].resources.wood = 100;
  assert.ok(canAfford(old.players[0], { gold: 1200, wood: 8 }));
  const started = buyUpgradeNode(old, town, 'kennels.kennel.honedFangs');
  assert.equal(started.ok, true, 'and buying into it must not throw on a missing array');
  runDays(old, started.job.days);
  assert.deepEqual(old.players[0].upgrades, ['kennels.kennel.honedFangs']);
});

test('wiring: playerUpgrades produces the table createBattle wants', () => {
  const state = upgradeGame();
  state.players[0].upgrades = ['kennels.kennel.honedFangs'];
  const table = playerUpgrades(state);
  assert.equal(table.length, state.players.length, 'one entry per player, indexed by player index');
  const { battle } = build({ upgrades: table });
  assert.deepEqual(upgradesForSide(battle, 0), ['kennels.kennel.honedFangs']);
  assert.equal(upgradesForSide(battle, 1), null, 'a player owning nothing reads as null, not []');
});

test('wiring: the same creature patched twice over is still deterministic', () => {
  const many = ['kennels.kennel.honedFangs', 'kennels.kennel.deepChests', 'kennels.forge.pitBred'];
  const a = volley({ upgrades: [many, []] }, 5);
  const b = volley({ upgrades: [many.slice().reverse(), []] }, 5);
  assert.equal(a.dealt, b.dealt, 'purchase order must never change a creature');
  assert.equal(a.draws, b.draws);
  assert.ok(Number.isInteger(a.dealt), 'and damage stays an integer through the patch');
});

test('wiring: two nodes turn a battle the elves lose into one they win', () => {
  // The end-to-end proof: not one volley, a whole auto-resolved fight, same seed
  // and same armies both times.
  //
  // The fixture is deliberately PRESSURED — 30 Wood Elves against 70 Pikemen —
  // and that took a correction. The first version of this test used the 30-v-30
  // matchup the volley tests use, where the elves win flawlessly in four rounds
  // whatever they are carrying, and it failed with "the branch made no
  // difference": a rout has no room to show one. An end-to-end test needs a
  // fight whose outcome is actually in doubt, or it only pins that the engine
  // still runs.
  const run = (upgrades) => {
    const rng = new Rng(99991);
    const battle = createBattle({
    // Fixed deployment: a heroless defender now splits by rule (CONFIG.PVE_STACK_SPLIT),
    // which is right for a real PvE fight and wrong for a test asserting a mechanic on
    // one known stack. See tests/ai-stack-split.test.js for the rule itself.
    pveStackSplit: false,
      rng, features: PHYS, upgrades, simulated: true,
      attacker: { hero: null, army: [{ creature: 'woodElf', count: 30, hurt: 0 }], playerIndex: 0 },
      // RE-SIZED at the base-energy re-basis. 70 sat inside the band where two nodes
      // turn the battle against a 115.6 J bow; against 90 J the band is 48-55 and 70 is
      // past it, so the elves lose either way and the test asserts nothing. 52 is
      // mid-band, with margin on both sides — the claim ("two nodes turn a losing battle")
      // is unchanged, only the count that exhibits it.
      defender: { hero: null, army: [{ creature: 'pikeman', count: 52, hurt: 0 }], playerIndex: 1 },
    });
    const r = autoResolve(battle);
    return { won: r.attackerWon, surv: r.attackerArmy.reduce((n, s) => n + s.count, 0) };
  };
  const bare = run([[], []]);
  // CLONE: this fight is wood elves with BOWS, so it keeps upstream's rampart
  // Homestead nodes. It builds the battle directly and never goes through a town,
  // so no faction gate applies — and data/upgradeNodes.js keeps all nine trees
  // precisely so fixtures like this one still work.
  const armed = run([['homestead.fletchery.drawWeight', 'homestead.fletchery.warHeads'], []]);
  assert.equal(bare.won, false, 'un-upgraded, the elves should be losing this one');
  assert.equal(armed.won, true, 'Heavy Draw + Bodkins should turn it');
  assert.ok(armed.surv > 0);
});
