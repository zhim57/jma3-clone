/**
 * upgrade-branches.test.js — every authored faction's branches, and the path a
 * player actually walks to reach one.
 *
 * upgrade-nodes.test.js proves each node is a real trade; upgrade-wiring.test.js
 * proves a node that is OWNED reaches a fight. Neither says the content is
 * reachable: a branch hung off a building the faction never builds, or off a
 * dwelling whose creatures have no authored physics, is a workshop with no door.
 * That was the state of the system before these lines were written — five nodes,
 * one dwelling, and no way to buy any of them outside a test.
 *
 * So this file walks the whole path: the dwelling exists in the faction's build
 * chain → the dwelling musters exactly the creatures the branch patches → a town
 * that has built it can commission the root → the crews finish → the troops are
 * physically different in a real battle.
 *
 * It also pins the two claims the town screen makes on the player's behalf: that
 * a branch is offered behind the dwelling it belongs to (including once that
 * dwelling has been UPGRADED — the Upgraded Homestead is the same workshop), and
 * that every dwelling of every authored faction has one. That second claim is
 * why FACTIONS_DONE is a list and not a pair: a faction is authored or it is
 * not, and a player who finds branches behind three dwellings and nothing behind
 * the other four cannot tell design from an unfinished job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { UPGRADE_NODES, dwellingNodes, factionNodes } from '../src/data/upgradeNodes.js';
import { patchedPhys, derivedOutputs } from '../src/core/upgrades.js';
import { buildingCatalog } from '../src/data/buildings.js';
import { CREATURES } from '../src/data/creatures.js';
import { newGame, canAfford } from '../src/core/GameState.js';
import { buyUpgradeNode, upgradeNodeBlockReason, recruitableCreature } from '../src/core/actions.js';
import { runDays } from './helpers.js';

const FACTIONS_DONE = ['castle', 'rampart', 'tower', 'necropolis', 'inferno', 'dungeon',
  'stronghold', 'fortress', 'conflux'];

/** The creatures a dwelling musters: its base unit and its upgrade. */
function musters(faction, dwelling) {
  const catalog = buildingCatalog(faction);
  const tier = catalog[dwelling]?.dwellingTier;
  const out = [];
  for (const [cid, c] of Object.entries(CREATURES)) {
    if (c.faction === faction && c.tier === tier) out.push(cid);
  }
  return { tier, creatures: out };
}

// ---------------------------------------------------------------------------
// The content is reachable
// ---------------------------------------------------------------------------

test('branches: every node hangs off a dwelling its faction actually builds', () => {
  for (const [id, n] of Object.entries(UPGRADE_NODES)) {
    const catalog = buildingCatalog(n.faction);
    const b = catalog[n.dwelling];
    assert.ok(b, `${id} hangs off "${n.dwelling}", which ${n.faction} has no building for`);
    assert.ok(b.dwellingTier, `${id} hangs off "${n.dwelling}", which is not a dwelling`);
    assert.ok(!b.upgradeOf, `${id} hangs off the UPGRADED dwelling — a branch belongs to the chain's root`);
  }
});

test('branches: a node patches exactly the creatures its dwelling musters', () => {
  // The failure this catches is a copy-paste one and it is silent: a branch that
  // names the neighbouring tier's creatures still passes the schema, still trades
  // something for something, and improves troops the player did not buy it for.
  for (const [id, n] of Object.entries(UPGRADE_NODES)) {
    const { tier, creatures } = musters(n.faction, n.dwelling);
    for (const cid of n.creatures) {
      assert.equal(CREATURES[cid].tier, tier,
        `${id} is on a tier-${tier} dwelling but patches ${cid} (tier ${CREATURES[cid].tier})`);
    }
    assert.deepEqual([...n.creatures].sort(), [...creatures].sort(),
      `${id} should patch both of its dwelling's creatures — the same troops, better equipped`);
  }
});

test('branches: every authored faction covers all seven dwellings', () => {
  for (const faction of FACTIONS_DONE) {
    const catalog = buildingCatalog(faction);
    const roots = Object.entries(catalog)
      .filter(([, b]) => b.dwellingTier && !b.upgradeOf)
      .map(([id]) => id);
    assert.equal(roots.length, 7, `${faction} has ${roots.length} dwelling chains`);
    for (const d of roots) {
      const nodes = dwellingNodes(faction, d);
      assert.ok(nodes.length >= 3, `${faction}/${d} (${catalog[d].name}) has only ${nodes.length} improvements`);
      // Every dwelling's creatures must carry authored physics, or the branch is
      // patching numbers nobody chose.
      for (const cid of musters(faction, d).creatures) {
        assert.ok(CREATURES[cid].phys, `${faction}/${d} musters ${cid}, which has no authored phys`);
      }
    }
  }
});

test('branches: dwellingNodes lists the root first, and only that dwelling\'s line', () => {
  const homestead = dwellingNodes('rampart', 'dwelling3');
  assert.ok(homestead.length >= 5);
  assert.deepEqual(homestead[0].requires, [], 'the first entry must be the one you can start');
  const seen = new Set();
  for (const n of homestead) {
    for (const r of n.requires) assert.ok(seen.has(r), `${n.id} listed before its prerequisite ${r}`);
    seen.add(n.id);
    assert.equal(n.dwelling, 'dwelling3');
  }
  // The claim is the SCOPING, not the size. Transcribing a count here made the
  // test expire the day Castle's third dwelling gained a node, which is a change
  // it has no opinion about — the same class of fixture rot as a test that
  // rebuilds engine arithmetic instead of calling it.
  const castleThird = dwellingNodes('castle', 'dwelling3');
  assert.ok(castleThird.length > 0, 'castle\'s third dwelling has a branch');
  assert.ok(castleThird.every((n) => n.faction === 'castle' && n.dwelling === 'dwelling3'),
    'the same dwelling id in another faction is another dwelling');
  assert.ok(dwellingNodes('rampart', 'dwelling3').every((n) => n.faction === 'rampart'),
    'and the query does not leak the other way either');
  // THE UN-AUTHORED-FACTION CLAUSE IS GONE, on its own stated condition. It
  // asserted that a faction with no branches has none on offer, and it carried an
  // expiry — "when every faction is authored, delete this check" — because there
  // would be nothing left for it to be about. Stronghold and Fortress landed, the
  // expiry fired, and the clause deletes rather than being kept alive against a
  // fixture invented for it. What it protected is now covered better by the
  // all-seven-dwellings check above, which runs over every faction there is.
  assert.equal(FACTIONS_DONE.length, new Set(Object.values(UPGRADE_NODES).map((n) => n.faction)).size,
    'every faction carrying nodes must be in FACTIONS_DONE, or its branches go unchecked');
});

// ---------------------------------------------------------------------------
// The path a player walks
// ---------------------------------------------------------------------------

function game(faction) {
  return newGame({
    seed: 21,
    features: { physicalDamage: true },
    players: [{ faction, isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
}
function townFor(state, buildings = []) {
  const town = Object.values(state.towns).find((t) => t.owner === 0);
  for (const b of buildings) if (!town.buildings.includes(b)) town.buildings.push(b);
  return town;
}
const rich = (p) => { for (const r of ['gold', 'wood', 'ore', 'mercury', 'sulfur', 'crystal', 'gems']) p.resources[r] = 100_000; };

// CLONE: this loop seats an actual TOWN of each faction, so it runs over the
// PLAYABLE factions only — the other seven have no registry entry and no heroes, so
// newGame cannot build them a realm. The data-only checks above still cover all nine
// authored trees (FACTIONS_DONE), which is where the per-faction coverage claim lives.
const FACTIONS_PLAYABLE = ['castle', 'inferno'];
for (const faction of FACTIONS_PLAYABLE) {
  test(`branches: a ${faction} town commissions a root node and the crews deliver it`, () => {
    const state = game(faction);
    const town = townFor(state);
    rich(state.players[0]);
    const root = dwellingNodes(faction, 'dwelling1')[0];

    // Without the dwelling, the branch is not on offer — the workshop's door.
    // A starting town is already given its tier-1 dwelling, so take it away to
    // check the gate rather than assume the fixture is missing it.
    town.buildings = town.buildings.filter((b) => b !== 'dwelling1');
    assert.match(upgradeNodeBlockReason(state, town, root.id), /^Requires /);
    town.buildings.push('dwelling1');
    assert.equal(upgradeNodeBlockReason(state, town, root.id), null);

    const started = buyUpgradeNode(state, town, root.id);
    assert.equal(started.ok, true, started.reason);
    assert.deepEqual(state.players[0].upgrades ?? [], [], 'commissioning is not the same as owning');
    assert.ok(state.jobs.some((j) => j.kind === 'upgradeNode' && j.target === root.id));

    runDays(state, (root.crew.days + 2) * 2);
    assert.ok((state.players[0].upgrades ?? []).includes(root.id),
      `${root.id} never landed after ${root.crew.days} crew-days`);
  });

  test(`branches: every ${faction} node changes its creatures once it is owned`, () => {
    // The whole point of a parameter patch: the troops are physically different,
    // measurably, and in the direction the node's own description claims.
    for (const n of factionNodes(faction)) {
      for (const cid of n.creatures) {
        const base = CREATURES[cid].phys;
        const after = patchedPhys(cid, base, [n.id]);
        assert.notEqual(after, base, `${n.id} left ${cid} untouched`);
        const b = derivedOutputs(base), a = derivedOutputs(after);
        const moved = Object.keys(b).filter((k) => a[k] !== b[k]);
        assert.ok(moved.length, `${n.id} moved nothing measurable on ${cid}`);
      }
    }
  });
}

test('branches: a whole branch stacks, and the realm keeps it in every town', () => {
  const state = game('castle');
  const town = townFor(state, ['dwelling1']);
  rich(state.players[0]);
  const [root, ...rest] = dwellingNodes('castle', 'dwelling1');

  buyUpgradeNode(state, town, root.id);
  runDays(state, (root.crew.days + 2) * 2);
  assert.ok(state.players[0].upgrades.includes(root.id));

  // The dependents open only once the root is FINISHED, not when it was ordered.
  for (const n of rest) {
    assert.equal(upgradeNodeBlockReason(state, town, n.id), null, `${n.id} still blocked after its root landed`);
    assert.equal(buyUpgradeNode(state, town, n.id).ok, true);
  }
  runDays(state, 40);
  for (const n of rest) assert.ok(state.players[0].upgrades.includes(n.id), `${n.id} never landed`);

  // Owned per PLAYER: a second town with the same dwelling has it already.
  const other = Object.values(state.towns).find((t) => t.owner === 0 && t.id !== town.id)
    || (() => { const t = { ...town, id: 'T999', buildings: ['dwelling1'] }; state.towns[t.id] = t; return t; })();
  other.buildings = ['dwelling1'];
  assert.equal(upgradeNodeBlockReason(state, other, root.id), 'Already taken',
    'a node re-trained town by town would be a different feature');

  // And all three are visible in the creature the dwelling musters.
  const cid = recruitableCreature(town, 1);
  const stacked = patchedPhys(cid, CREATURES[cid].phys, state.players[0].upgrades);
  assert.notDeepEqual(stacked, CREATURES[cid].phys);
});

test('branches: cost and crew are real — a poor realm is refused, a busy one queues', () => {
  // CLONE: inferno, not rampart — this seats a real town, and only castle and
  // inferno are playable here. The rule under test (cost + crew gating) is
  // faction-agnostic.
  const state = game('inferno');
  const town = townFor(state, ['dwelling1']);
  const root = dwellingNodes('inferno', 'dwelling1')[0];
  const p = state.players[0];
  for (const r of Object.keys(p.resources)) p.resources[r] = 0;
  assert.equal(upgradeNodeBlockReason(state, town, root.id), 'Not enough resources');
  rich(p);
  assert.equal(upgradeNodeBlockReason(state, town, root.id), null);
  assert.ok(canAfford(p, root.cost));
  const before = p.resources.gold;
  buyUpgradeNode(state, town, root.id);
  assert.ok(p.resources.gold < before, 'the commission is paid up front');
  assert.match(buyUpgradeNode(state, town, root.id).reason, /under way/i);
});

// ---------------------------------------------------------------------------
// The town screen's half
// ---------------------------------------------------------------------------
//
// Phaser scenes cannot be instantiated headlessly (see scene-methods.test.js),
// so the view is pinned the way this suite pins every other view: over the
// source, as a wiring contract.

const SCENE = readFileSync(new URL('../src/scenes/TownScene.js', import.meta.url), 'utf8');

test('branches: clicking a built dwelling reaches the branch, not only the muster', () => {
  assert.match(SCENE, /case 'recruit': return this\.openDwelling\(/,
    'a built dwelling must route through the chooser, or the branch has no door');
  assert.match(SCENE, /improvementsDialog\(buildingId, b\)/, 'the dialog must exist and take the building');
  assert.match(SCENE, /dwellingNodes\(this\.town\.faction, this\.dwellingRoot\(id\)\)/,
    'the branch must be looked up from the chain ROOT — an upgraded dwelling is the same workshop');
  assert.match(SCENE, /upgradeNodeBlockReason\(s, town, n\.id\)/,
    'the screen must ask the engine why a node is refused rather than deciding for itself');
  assert.match(SCENE, /buyUpgradeNode\(s, town, n\.id\)/, 'and commission through the engine');
});

test('branches: the screen says so when the damage model would ignore the purchase', () => {
  // The classic model never reads a `phys` block, so a node bought under it is a
  // purchase that changes nothing. Taking the gold anyway is the trap.
  assert.match(SCENE, /featureOn\(s, 'physicalDamage'\)/,
    'the improvements dialog must check whether the model that reads these is on');
  assert.match(SCENE, /Physical Damage Model is off/, 'and say so in words the player can act on');
  assert.match(SCENE, /if \(modelOff\) return;/, 'and refuse the purchase rather than pocket it');
});
