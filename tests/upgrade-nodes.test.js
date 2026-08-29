/**
 * upgrade-nodes.test.js — the schema, the gate, and the one rule that gives the
 * schema a shape.
 *
 * An upgrade node patches a creature's physical parameters, so unlike a flat
 * "+2 attack" it can be checked for meaning: apply the patch, recompute what the
 * damage model derives from those parameters, and look at what moved. That makes
 * one design rule automatable, and it is the rule the whole branch is built
 * around —
 *
 *   EVERY NODE MUST DEGRADE AT LEAST ONE DERIVED OUTPUT.
 *
 * A heavier arrow is slower. A narrower head carries less. Mail that stops a
 * bodkin also tires the arm that draws. If a node can be strictly better in
 * every measurable way then the branch is not a set of choices, it is a list of
 * things to buy in whatever order gold arrives — and nothing in a data file
 * would ever tell you that had happened. Here it fails the build.
 *
 * The complement is checked too: a node must improve something, or it is a
 * purchase nobody would make and probably a sign the multipliers went in
 * backwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UPGRADE_NODES, branchNodes, factionNodes } from '../src/data/upgradeNodes.js';
import {
  upgradeBlockReason, patchedPhys, derivedOutputs, PATCHABLE, aimAngle,
} from '../src/core/upgrades.js';
import { CREATURES } from '../src/data/creatures.js';
import { buildingCatalog } from '../src/data/buildings.js';
import { retiredHeads, RETIRED_HEADS } from '../src/core/retiredHeads.js';
import { boundsViolations } from '../src/core/headGeometry.js';

const entries = () => Object.entries(UPGRADE_NODES);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('upgrades: every node references a real faction, dwelling and creatures', () => {
  // CLONE: the check is "names a faction with an authored roster", not "names a
  // PLAYABLE faction". Two factions are playable here (data/factions.js) but all
  // nine authored upgrade trees and bestiaries are kept — see the note at the
  // bottom of data/upgradeNodes.js. A node naming a faction no creature belongs to
  // is still the dangling reference this assertion exists to catch.
  const authored = new Set(Object.values(CREATURES).map((c) => c.faction));
  for (const [id, n] of entries()) {
    assert.ok(authored.has(n.faction), `${id} names unknown faction "${n.faction}"`);
    const catalog = buildingCatalog(n.faction);
    assert.ok(catalog[n.dwelling], `${id} hangs off missing building "${n.dwelling}"`);
    assert.ok(n.creatures?.length, `${id} patches no creatures`);
    for (const cid of n.creatures) {
      const c = CREATURES[cid];
      assert.ok(c, `${id} patches missing creature "${cid}"`);
      assert.equal(c.faction, n.faction, `${id} patches ${cid}, which is not ${n.faction}`);
      // A patch against a creature with no authored physics is a patch on the
      // fallback — numbers nobody chose, adjusted by a percentage somebody did.
      assert.ok(c.phys, `${id} patches ${cid}, which has no authored phys block`);
    }
  }
});

test('upgrades: every effect patches a patchable field with exactly one operation', () => {
  for (const [id, n] of entries()) {
    const fields = Object.entries(n.effects || {});
    assert.ok(fields.length, `${id} has no effects — it patches nothing`);
    for (const [field, patch] of fields) {
      assert.ok(PATCHABLE.has(field),
        `${id} patches "${field}", which is not patchable (derived, or an input to the offline derivation)`);
      const ops = ['mul', 'add', 'set'].filter((k) => patch[k] !== undefined);
      assert.equal(ops.length, 1, `${id}.${field} must use exactly one of mul/add/set, has [${ops}]`);
      assert.ok(Number.isFinite(patch[ops[0]]), `${id}.${field}.${ops[0]} is not a number`);
      if (patch.mul !== undefined) assert.ok(patch.mul > 0, `${id}.${field} multiplies by ${patch.mul}`);
      if (patch.set !== undefined) assert.ok(patch.set >= 0, `${id}.${field} sets ${patch.set}`);
    }
  }
});

test('upgrades: requires and excludes name real nodes, and excludes is symmetric', () => {
  for (const [id, n] of entries()) {
    for (const req of n.requires || []) {
      assert.ok(UPGRADE_NODES[req], `${id} requires missing node "${req}"`);
    }
    for (const ex of n.excludes || []) {
      assert.ok(UPGRADE_NODES[ex], `${id} excludes missing node "${ex}"`);
      // The gate checks both directions so a one-way exclusion still holds, but
      // one-way data is a fork somebody meant to close and half-closed.
      assert.ok((UPGRADE_NODES[ex].excludes || []).includes(id),
        `${id} excludes ${ex} but ${ex} does not exclude ${id} — an asymmetric fork`);
      assert.notEqual(ex, id, `${id} excludes itself`);
    }
  }
});

test('upgrades: every node is reachable — no cycles, no dead-end prerequisites', () => {
  // The same topological walk the building tree gets in data-integrity, for the
  // same reason: one typo'd id (or a cycle) leaves a node permanently
  // unbuildable, and nothing at import time would say so. Forks are walked as if
  // both halves were taken; `excludes` limits what one PLAYTHROUGH can hold, not
  // what is reachable.
  const owned = new Set();
  for (let progress = true; progress;) {
    progress = false;
    for (const [id, n] of entries()) {
      if (owned.has(id)) continue;
      if ((n.requires || []).every((r) => owned.has(r))) { owned.add(id); progress = true; }
    }
  }
  const stranded = Object.keys(UPGRADE_NODES).filter((id) => !owned.has(id));
  assert.equal(stranded.length, 0, `unreachable node(s): ${stranded.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('upgrades: every node degrades at least one derived output, and improves at least one', () => {
  for (const [id, n] of entries()) {
    for (const cid of n.creatures) {
      const before = derivedOutputs(CREATURES[cid].phys);
      const after = derivedOutputs(patchedPhys(cid, CREATURES[cid].phys, [id]));
      const worse = Object.keys(before).filter((k) => after[k] < before[k]);
      const better = Object.keys(before).filter((k) => after[k] > before[k]);
      const report = Object.keys(before)
        .map((k) => `${k} ${before[k].toPrecision(4)}→${after[k].toPrecision(4)}`).join(', ');
      assert.ok(worse.length > 0,
        `${id} on ${cid} costs nothing physical — every derived output holds or improves (${report})`);
      assert.ok(better.length > 0,
        `${id} on ${cid} improves nothing (${report})`);
    }
  }
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('upgrades: the gate refuses a node whose prerequisite is missing, and allows it once held', () => {
  assert.equal(upgradeBlockReason('homestead.fletchery.drawWeight', []), null, 'a root node needs nothing');
  assert.match(upgradeBlockReason('homestead.fletchery.warHeads', []), /^Requires /);
  assert.equal(upgradeBlockReason('homestead.fletchery.warHeads', ['homestead.fletchery.drawWeight']), null);
});

test('upgrades: the gate refuses a fork from either side, whichever half was bought first', () => {
  // AGAINST A FIXTURE, because the tree has no forks any more. The fletchery pair was the
  // only mutually-excluding nodes in it, and cutting them left this mechanism with no
  // content exercising it — which is how a feature stops working without anyone finding
  // out until the next branch wants one. So the catalog is injected.
  //
  // Note the asymmetry: `b` excludes `a` and `a` says nothing. The gate checks BOTH
  // directions on purpose, so a one-way `excludes` in future data cannot silently open
  // the fork from the side that omitted it.
  const FIXTURE = {
    a: { name: 'A', requires: [], excludes: [] },
    b: { name: 'B', requires: [], excludes: ['a'] },
  };
  const gate = (id, owned) => upgradeBlockReason(id, owned, () => true, [], FIXTURE);
  assert.match(gate('b', ['a']), /^Excluded by A$/);
  assert.match(gate('a', ['b']), /^Excluded by B$/);
  assert.equal(gate('a', []), null);
  // Queued counts as claimed, or both halves could sit in the queue at once and you
  // would end up owning both — the one thing a fork exists to prevent.
  assert.match(upgradeBlockReason('b', [], () => true, ['a'], FIXTURE), /^Excluded by A$/);
});

test('upgrades: the gate refuses a node already taken, and one that cannot be paid for', () => {
  assert.equal(upgradeBlockReason('homestead.fletchery.drawWeight', ['homestead.fletchery.drawWeight']), 'Already taken');
  assert.equal(upgradeBlockReason('homestead.fletchery.drawWeight', [], () => false), 'Not enough resources');
  assert.equal(upgradeBlockReason('nope.notAThing', []), 'Unknown upgrade');
  // A Set is as good as an array — callers hold owned nodes either way.
  assert.equal(upgradeBlockReason('homestead.fletchery.warHeads', new Set(['homestead.fletchery.drawWeight'])), null);
});

// ---------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------

test('upgrades: patching is order-independent and leaves un-upgraded creatures untouched', () => {
  const base = CREATURES.woodElf.phys;
  // Same object back when nothing applies: an un-upgraded creature must be
  // byte-identical to a game with no upgrade system at all.
  assert.equal(patchedPhys('woodElf', base, []), base);
  assert.equal(patchedPhys('woodElf', base, ['homestead.fletchery.drawWeight']) === base, false);
  // A node that names other creatures must not touch this one.
  assert.equal(patchedPhys('archer', CREATURES.archer.phys, ['homestead.fletchery.drawWeight']),
    CREATURES.archer.phys);

  const a = patchedPhys('woodElf', base, ['homestead.fletchery.drawWeight', 'homestead.armoury.wardensMail']);
  const b = patchedPhys('woodElf', base, ['homestead.armoury.wardensMail', 'homestead.fletchery.drawWeight']);
  assert.deepEqual(a, b, 'the same nodes in a different order gave a different creature');
  assert.notDeepEqual(a, base, 'the patch did nothing');
});

test('upgrades: `set` replaces rather than scales — a material swap', () => {
  // Wardens' Mail SETS hardness to 0.12 GPa. A scale would be backwards: it
  // would be worth more to a creature that already had good armour, when the
  // whole point of changing material is that you end up in that material
  // whatever you started in. Wood Elves start at 0.08, Grand Elves at 0.10, and
  // both must finish at exactly 0.12.
  for (const cid of ['woodElf', 'grandElf']) {
    const out = patchedPhys(cid, CREATURES[cid].phys, ['homestead.armoury.wardensMail']);
    assert.equal(out.armorHardness_gpa, 0.12,
      `${cid} should end in mail, not in 1.5x whatever it wore`);
  }
  assert.notEqual(CREATURES.woodElf.phys.armorHardness_gpa,
    CREATURES.grandElf.phys.armorHardness_gpa, 'fixture: they must start different');
});

test('upgrades: patching the authored GPa figure re-bakes the SI one', () => {
  // Authored hardness is in GPa because 0.12 is a figure a curious player can
  // look up; the damage model reads the baked Pa field so the hot path never has
  // to know which unit it is holding. Two names means two chances to disagree —
  // this is the one that stops them.
  const base = CREATURES.woodElf.phys;
  const out = patchedPhys('woodElf', base, ['homestead.armoury.wardensMail']);
  assert.ok(out.armorHardness_gpa > base.armorHardness_gpa, 'the mail did something');
  assert.equal(out.armorHardness_pa, out.armorHardness_gpa * 1e9,
    'the SI field must follow the authored one, not the pre-patch value');
  assert.notEqual(out.armorHardness_pa, base.armorHardness_pa, 'and must not be stale');
});

test('upgrades: a patch never pushes a field outside its physical range', () => {
  // armorCoverage_frac is a fraction of a body. Wardens' Mail multiplies it by 1.15,
  // which on anything already above 0.87 would otherwise armour more of a
  // creature than it has.
  const heavy = { ...CREATURES.woodElf.phys, armorCoverage_frac: 0.95 };
  const out = patchedPhys('woodElf', heavy, ['homestead.armoury.wardensMail']);
  assert.ok(out.armorCoverage_frac <= 1, `coverage ran to ${out.armorCoverage_frac}`);
  assert.ok(out.armorCoverage_frac > heavy.armorCoverage_frac, 'and it still improved');
});

test('upgrades: TRIPWIRE — no forks in the tree, and this assertion expects to be deleted', () => {
  // NOT AN INVARIANT, AND THE DISTINCTION MATTERS BECAUSE IT WOULD CONTRADICT ONE.
  // I7 requires a tree whose forks BIND — that is what `excludes` and the depth-4 shape
  // are for. An invariant asserting no forks exist directly opposes it, and leaving both
  // on the page means someone in three months reads "the tree has no forks, asserted" as
  // a design property rather than as the residue of one branch failing.
  //
  // So: a TRIPWIRE, in the same class as the known-violation list. It has a stated
  // deletion condition and it expects to fire.
  //
  //   WHY IT EXISTS   the fletchery fork was cut (§8i) and was the only fork in the tree.
  //                   This makes the NEXT one a deliberate decision taken with that record
  //                   in view, rather than something that reappears by drift.
  //   DELETE IT WHEN  a fork lands whose margin `marginIsEvidence` ACCEPTS. That used to
  //                   read "a fork that has been checked", and the check has since been
  //                   run — scripts/sim/forkgate.mjs — which turned the condition from
  //                   procedural into unreachable: every field a fork margin can rest on
  //                   (blowEnergy_j, contactArea_m2, blowMass_kg, armorHardness_gpa) is
  //                   graded `feel`, and `feel` defends no accuracy, so the answer is no
  //                   at any conditioning. Conditioning itself is NOT the blocker any
  //                   more: the cut fork measures κ = 1.8 against hide and doubling its
  //                   separation takes mail from 8.4 to 2.4, well inside what a graded
  //                   input could carry. So the real precondition is a PROVENANCE change
  //                   — source one of those fields — and then forkgate answers on its own.
  //   NOT A REASON TO KEEP IT  "the tree should have no forks". I7 says the opposite.
  const forks = Object.entries(UPGRADE_NODES).filter(([, n]) => (n.excludes || []).length);
  assert.deepEqual(forks.map(([id]) => id), [],
    'a fork is back in the tree. If it was checked for conditioning, DELETE THIS TEST — it is '
    + 'a tripwire with a stated expiry, not a rule. If it was not, read docs §8i first.');

  // What survived pulls ONE way, and that is now the honest description: War Heads trade
  // energy for pressure. There is no second half trading the other way.
  const base = CREATURES.woodElf.phys;
  const war = derivedOutputs(patchedPhys('woodElf', base, ['homestead.fletchery.warHeads']));
  const from = derivedOutputs(base);
  assert.ok(war.pressure > from.pressure, 'war heads: pressure up');
  assert.ok(war.energy < from.energy, 'and energy down — a lighter arrow leaves with less');
});

test('upgrades: the retired-head fixture cannot outlive the schema it patches', () => {
  // A GOLDEN FIXTURE CAN KEEP DEAD FIELDS ALIVE BY BEING THEIR ONLY CONSUMER, and
  // `retiredHeads` is a fixture for a schema that changed twice in three commits. If a
  // field leaves PATCHABLE, the fixture must fail rather than quietly go on multiplying
  // something the engine no longer reads — which would make the retired pair diverge from
  // the model it is supposed to be a historical record of.
  for (const effects of Object.values(RETIRED_HEADS)) {
    for (const field of Object.keys(effects)) {
      assert.ok(PATCHABLE.has(field),
        `retiredHeads multiplies "${field}", which is no longer patchable — the fixture is `
        + 'preserving a field the engine has dropped');
    }
  }
  // And it must still produce blocks the physics accepts, not just objects with the right
  // keys: the same bounds authored content has to meet (I21).
  for (const head of Object.values(retiredHeads('woodElf'))) {
    assert.deepEqual(boundsViolations(head), [], 'the retired pair must still be shootable');
  }
});

test('upgrades: the branch/faction helpers find the authored branches', () => {
  // A dwelling hosts NAMED branches — the Homestead has a fletchery and an
  // armoury — so `branch` means the line WITHIN a dwelling rather than the
  // dwelling itself. `armoury` is deliberately shared across dwellings and
  // factions, which is what makes branchNodes a cross-cutting query rather than
  // a second spelling of the dwelling id.
  const fletchery = branchNodes('fletchery');
  assert.ok(fletchery.length >= 3, `only ${fletchery.length} nodes in the fletchery`);
  assert.ok(fletchery.every((n) => n.id && n.name), 'helpers must carry the id alongside the record');
  assert.ok(fletchery.every((n) => n.dwelling === 'dwelling3' && n.faction === 'rampart'),
    'the fletchery is the Homestead\'s');
  const armoury = branchNodes('armoury');
  assert.ok(new Set(armoury.map((n) => n.faction)).size > 1,
    'an armoury is a KIND of branch, not one dwelling\'s — it should span factions');

  // A faction is either authored or it is not: no half-covered rosters, where a
  // player finds a branch behind three dwellings and nothing behind the other
  // four and cannot tell whether that is design or an unfinished job. So the
  // rule is stated over whichever factions carry nodes at all, and it is the
  // LIST that moves when the next one lands, not the rule.
  const done = [...new Set(Object.values(UPGRADE_NODES).map((n) => n.faction))].sort();
  assert.deepEqual(done, ['castle', 'conflux', 'dungeon', 'fortress', 'inferno', 'necropolis',
    'rampart', 'stronghold', 'tower'], 'all nine factions');
  for (const faction of done) {
    const nodes = factionNodes(faction);
    assert.ok(nodes.length >= 21, `${faction} has only ${nodes.length} nodes`);
    assert.ok(nodes.every((n) => n.faction === faction));
    const dwellings = new Set(nodes.map((n) => n.dwelling));
    assert.equal(dwellings.size, 7, `${faction} covers ${dwellings.size} dwellings, not all seven`);
  }
});

test('upgrades: every dwelling branch is one root and its dependents', () => {
  // The shape a player learns once and then recognises everywhere: exactly one
  // node per dwelling needs nothing, and everything else in that dwelling hangs
  // off the branch. A second root would be a second thing to explain; an orphan
  // would be a node reachable without ever visiting the dwelling's own line.
  const byDwelling = new Map();
  for (const [id, n] of entries()) {
    const key = `${n.faction}/${n.dwelling}`;
    if (!byDwelling.has(key)) byDwelling.set(key, []);
    byDwelling.get(key).push({ id, ...n });
  }
  for (const [key, nodes] of byDwelling) {
    const roots = nodes.filter((n) => !(n.requires || []).length);
    assert.equal(roots.length, 1, `${key} has ${roots.length} root nodes: ${roots.map((r) => r.id)}`);
    const own = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      for (const req of n.requires || []) {
        assert.ok(own.has(req), `${n.id} requires ${req}, which is not in its own dwelling`);
      }
    }
  }
});

test('upgrades: the yardstick reads the aim the MODEL shoots, drop included', () => {
  // `derivedOutputs.precision` used to read `dispersion_rad` alone while the damage
  // model had been adding a drop term for as long as velocity stopped being inert.
  // The gap made a whole class of node unbuildable rather than merely unbalanced: a
  // node that buys reach by lightening the projectile improves NOTHING the yardstick
  // can see, so the I3 check refuses it — not because the trade is bad, but because
  // the instrument could not see the half that pays.
  //
  // Mass is the field that exposes it, because RECOUPLE re-derives v = sqrt(2E/m) on
  // every patch. A mass-only change therefore has to move precision, in the direction
  // the physics says: lighter leaves faster, drops less, groups tighter.
  const base = CREATURES.cyclopsKing.phys;
  const lighter = patchedPhys('cyclopsKing', base, ['cyclopsCave.drill.slungStones']);
  const heavier = patchedPhys('cyclopsKing', base, ['cyclopsCave.quarry.heavierStones']);
  assert.equal(lighter.dispersion_rad, base.dispersion_rad, 'fixture: neither node touches the authored aim');
  assert.equal(heavier.dispersion_rad, base.dispersion_rad);
  assert.ok(derivedOutputs(lighter).precision > derivedOutputs(base).precision,
    'a lighter, faster projectile groups tighter and the yardstick must say so');
  assert.ok(aimAngle(lighter) < aimAngle(base), 'and the angle it shoots is smaller');
});

test('upgrades: Slung Stones is a trade, not a gift', () => {
  // The fifth trade, and the only dwelling with one: aim bought on the OTHER half of
  // v = sqrt(2E/m), because a Cyclops's shot is lost to drop rather than to a loose
  // group. It has to cost something real, and it costs three things.
  const root = ['cyclopsCave.quarry.knappedStone'];
  const slung = [...root, 'cyclopsCave.drill.slungStones'];
  for (const cid of ['cyclops', 'cyclopsKing']) {
    const base = CREATURES[cid].phys;
    const a = derivedOutputs(patchedPhys(cid, base, root));
    const b = derivedOutputs(patchedPhys(cid, base, slung));
    assert.ok(b.precision > a.precision * 1.5, `${cid}: the reach is the point (${(b.precision / a.precision).toFixed(2)}x)`);
    assert.ok(b.energy < a.energy, `${cid}: a sling gives up energy on the release`);
    assert.ok(b.pressure < a.pressure, `${cid}: and therefore pressure at the point`);
    assert.ok(b.rigidity < a.rigidity * 0.5, `${cid}: a small stone mushrooms against armour`);
    // The projectile must stay out of the arrow bounds, which describe a shaft
    // launched from a bow — a 552 J sling stone is not one, and would fail every
    // one of them if it ever dropped under the isArrow threshold.
    const patched = patchedPhys(cid, base, slung);
    assert.ok(patched.blowMass_kg > 0.15,
      `${cid}: a slung stone must not fall into the arrow envelope (${patched.blowMass_kg} kg)`);
  }
});

test('upgrades: Heavier Stones and Slung Stones compose without cancelling', () => {
  // `set` beats `mul` for whichever node is declared later, and this one is. Stated as
  // a test rather than left in a comment, because the ordering is a property of the
  // data file and a reader moving a block would otherwise silently change the game:
  // a realm holding both slings the sling's stone, and keeps the arm the bigger rock
  // trained — which is better than either alone, and is the honest reading of it.
  const base = CREATURES.cyclopsKing.phys;
  const both = patchedPhys('cyclopsKing', base,
    ['cyclopsCave.quarry.knappedStone', 'cyclopsCave.quarry.heavierStones', 'cyclopsCave.drill.slungStones']);
  const slungOnly = patchedPhys('cyclopsKing', base,
    ['cyclopsCave.quarry.knappedStone', 'cyclopsCave.drill.slungStones']);
  assert.equal(both.blowMass_kg, slungOnly.blowMass_kg, 'the sling decides the stone');
  assert.ok(both.blowEnergy_j > slungOnly.blowEnergy_j, 'and the arm still counts');
  assert.ok(aimAngle(both) < aimAngle(slungOnly), 'so it flies flatter still');
});
