/**
 * upgrades.js — the single gate for upgrade nodes, and the patch they apply.
 *
 * Two functions, and the reason there are only two is the point of the file:
 *
 *   upgradeBlockReason(...)  why this node cannot be taken, or null
 *   patchedPhys(...)         a creature's `phys` with the owned nodes applied
 *
 * THE GATE IS ONE FUNCTION, deliberately, because that is how buildings already
 * work: `buildBlockReason` is the only place a build is refused, so a
 * topological walk over `requires` in a test mirrors the engine exactly and
 * cannot drift from it (tests/data-integrity.test.js has walked the building
 * tree that way for a while now). Nodes get the same treatment, plus `excludes`
 * — buildings have no forks, node branches do, and a fork whose two halves are
 * checked in two different places is a fork that will one day let you own both.
 *
 * PURE, and inert until something calls it. No rng, no state mutation, nothing
 * written to a save: `owned` is passed in and a fresh phys object comes back. A
 * game that never buys a node behaves exactly as it did (HANDOVER §2.2 — this
 * is the "leave the system unflagged and inert" escape, not the feature-flag
 * one, so an in-progress save picks it up for free whenever it is wired in).
 *
 * WIRED INTO COMBAT via one battle-level field. `battle.upgrades` is an array
 * INDEXED BY PLAYER INDEX, threaded from state exactly where `cfg.features` is
 * threaded, and physicalDamage.js looks up the owner of whichever side it is
 * reading. Indexing by player rather than hanging a list on each side is what
 * makes the neutral case fall out for free: a monster stack, a creature bank and
 * an invader war-band all carry `playerIndex: -1`, and `upgrades[-1]` is
 * `undefined`, so nothing owned by anyone can ever leak onto a side that has no
 * owner.
 */

import { CONFIG } from '../config.js';
import { UPGRADE_NODES } from '../data/upgradeNodes.js';
import { buildingCatalog } from '../data/buildings.js';
import { canAfford } from './GameState.js';

/**
 * Fields a node may patch: the authored ones that are NOT inputs to the offline
 * derivation. Patching bodyMass_kg/density_kgpm3/ballisticCoeff_kgpm2 would invalidate the
 * committed frontalArea_m2/velRetainPerHex_ratio and force a fractional exponent back
 * into the damage path (see scripts/data/derive-physical.mjs); the derived
 * fields themselves are outputs, not dials.
 */
export const PATCHABLE = new Set([
  'blowMass_kg', 'blowEnergy_j', 'contactArea_m2', 'dispersion_rad',
  'armorHardness_gpa', 'armorCoverage_frac', 'woundEnergy_j',
]);

/**
 * A DECISION IS SOMETHING A PLAYER CAN CHANGE; A CONSEQUENCE IS NOT.
 *
 * The mirror of the objective/mechanism rule the Pareto view runs on, applied to
 * the input side. `blowSpeed_mps` used to be patchable and it should never have
 * been: nobody buys velocity. They buy draw weight and head mass, and velocity
 * falls out of both — v = sqrt(2E/m). Patching it directly described an
 * intervention that does not exist, and worse, it let a heavier arrowhead keep
 * its speed and therefore buy 30% more energy than any bow supplied. That single
 * uncoupling is what made the bodkin/broadhead fork one-sided.
 */
const RECOUPLE = (out) => {
  if (out.blowEnergy_j > 0 && out.blowMass_kg > 0) {
    out.blowSpeed_mps = Math.sqrt((2 * out.blowEnergy_j) / out.blowMass_kg);
  }
};

/** Hard limits a patch may never push a field past, whatever it multiplies by. */
const CLAMP = {
  armorCoverage_frac: [0, 1],   // a fraction of a body; 1.15 x 0.9 is not 1.035
  dispersion_rad: [0, 0.3],
};

/**
 * Why `nodeId` cannot be taken, or null if it can. The ONE place a node is
 * refused. `owned` is the set/array of node ids already held; `canPay` is
 * injected (the caller owns the player and the resource rules — this module
 * must not import actions.js, HANDOVER §2.4).
 */
export function upgradeBlockReason(nodeId, owned, canPay = () => true, pending = [], nodes = UPGRADE_NODES) {
  // `nodes` is injectable, and that became necessary rather than nice when the fletchery
  // fork was cut: it was the ONLY pair of mutually excluding nodes in the tree, so the
  // exclusion machinery below now has no content exercising it. A mechanism with no test
  // is a mechanism that stops working silently, and the next branch to want a fork would
  // find out the hard way. The test supplies a fixture catalog instead.
  const n = nodes[nodeId];
  if (!n) return 'Unknown upgrade';
  const inList = (list, id) => (list instanceof Set ? list.has(id) : (list || []).includes(id));
  const has = (id) => inList(owned, id);
  // OWNED OR QUEUED, for anything about what you have COMMITTED to; owned alone
  // for what you have FINISHED. The distinction only appeared once upgrades
  // became scheduled work, and it is load-bearing in both directions:
  //
  //   excludes / already-taken → claimed. Otherwise both halves of a fork could
  //   sit in the queue at once and you would end up owning both, which is the
  //   one thing a fork exists to prevent. A test caught exactly this.
  //
  //   requires → owned. A prerequisite that is merely queued has not happened
  //   yet, and starting the dependent work on the strength of it would be
  //   training bodkin heads for a bow nobody has finished building.
  const claimed = (id) => has(id) || inList(pending, id);
  // Distinct wording, because "Already taken" for something still in the queue
  // is a lie a player would reasonably act on — they would go looking for the
  // effect in their army rather than for the job on their schedule.
  if (has(nodeId)) return 'Already taken';
  if (inList(pending, nodeId)) return 'Already under way';
  for (const req of n.requires || []) {
    if (!has(req)) return `Requires ${nodes[req]?.name || req}`;
  }
  // A fork is refused from EITHER side, so it does not matter which half was
  // bought first. Checked in both directions because a one-way `excludes` in the
  // data would otherwise silently open the fork from the side that omitted it —
  // the test pins symmetry, this survives it not holding.
  for (const [otherId, other] of Object.entries(nodes)) {
    const conflicts = (n.excludes || []).includes(otherId) || (other.excludes || []).includes(nodeId);
    if (conflicts && claimed(otherId)) return `Excluded by ${other.name}`;
  }
  if (!canPay(n.cost)) return 'Not enough resources';
  return null;
}

/**
 * `phys` with every owned node that names this creature applied, in catalog
 * order so the result never depends on purchase order. Returns the ORIGINAL
 * object when nothing applies, so the common path allocates nothing and an
 * un-upgraded creature is byte-identical to no upgrade system at all.
 */
export function patchedPhys(creatureId, phys, owned) {
  if (!phys || !owned) return phys;
  const has = (id) => (owned instanceof Set ? owned.has(id) : owned.includes(id));
  let out = null;
  for (const [id, n] of Object.entries(UPGRADE_NODES)) {
    if (!has(id) || !n.creatures.includes(creatureId)) continue;
    out = out || { ...phys };
    for (const [field, patch] of Object.entries(n.effects)) {
      if (!PATCHABLE.has(field)) continue;   // data-integrity fails on this; do not apply it
      let v = out[field];
      // `set` REPLACES rather than scales, and it is the honest operation for a
      // material change: mail is not "leather times 1.5", it is mail. A scale
      // would make the same upgrade worth more to a creature that already had
      // good armour, which is backwards — the whole point of swapping material
      // is that you end up with that material whatever you started in.
      if (patch.set !== undefined) v = patch.set;
      if (patch.mul !== undefined) v *= patch.mul;
      if (patch.add !== undefined) v += patch.add;
      const clamp = CLAMP[field];
      out[field] = clamp ? Math.max(clamp[0], Math.min(clamp[1], v)) : Math.max(0, v);
      // A node patches the AUTHORED figure (GPa, readable); the model reads the
      // baked SI one. Re-bake so the two cannot disagree. One exact multiply,
      // and only on the upgraded path — the common path returns the creature's
      // own object and never gets here.
      if (field === 'armorHardness_gpa') out.armorHardness_pa = out.armorHardness_gpa * 1e9;
    }
  }
  // Velocity is a consequence of energy and mass, so it is re-derived AFTER the
  // whole patch rather than carried along stale. This is the coupling doing its
  // work: a heavier head now leaves the bow slower, as it must.
  if (out) RECOUPLE(out);
  return out || phys;
}

/**
 * The per-player node lists a battle needs, indexed by player index — the shape
 * `cfg.upgrades` wants. `?? []` at the read, so a save written before players
 * had the field produces empty lists rather than undefined holes.
 */
export function playerUpgrades(state) {
  return (state?.players || []).map((p) => p.upgrades ?? []);
}

/**
 * The nodes owned by whoever owns `side` of `battle`, or null when nobody does.
 * Null rather than [] so the damage model can skip the patch entirely on the
 * common path and hand back the creature's own `phys` object untouched.
 */
export function upgradesForSide(battle, sideIndex) {
  const owner = battle?.sides?.[sideIndex]?.playerIndex ?? -1;
  const owned = owner >= 0 ? battle?.upgrades?.[owner] : null;
  return owned && owned.length ? owned : null;
}

/**
 * The ANGULAR GROUP a weapon actually shoots: its authored aim, plus what a
 * mis-judged range costs a projectile that drops on the way.
 *
 * ONE DEFINITION, read by both the damage model and `derivedOutputs` below,
 * because they were computing different things and only one of them was right.
 * The model has carried the drop term since velocity stopped being inert; the
 * yardstick a node is scored against never learned about it, and read
 * `dispersion_rad` alone. That gap is not cosmetic — it is the whole reason a
 * node may patch `blowMass_kg`, since v = sqrt(2E/m) is re-coupled on every
 * patch (see RECOUPLE) and mass therefore moves aim. With the drop missing from
 * the yardstick, a node that bought reach by lightening the projectile scored as
 * improving NOTHING and degrading rigidity: unbuildable, not because the trade
 * is bad but because the instrument could not see it.
 *
 * BOUNDED, and `blow()` in physicalDamage.js explains at length why: g*dd/v^2 is
 * the flat-fire linearisation and says nothing once the shot is a lob. The bound
 * has to live here too, or the yardstick would credit a node for aim the model
 * will not give it.
 */
export function aimAngle(phys) {
  if (!(phys?.dispersion_rad > 0)) return 0;
  const v = phys.blowSpeed_mps;
  if (!(v > 0)) return phys.dispersion_rad;
  return phys.dispersion_rad + Math.min(
    (CONFIG.PHYS_G * CONFIG.PHYS_RANGE_ERROR_M) / (v * v),
    phys.dispersion_rad * CONFIG.PHYS_DROP_MAX_SHARE,
  );
}

/**
 * The derived outputs a node is measured against — every one "higher is
 * better", so a node degrades something exactly when one of these falls.
 * Kept here rather than in the test because it is the definition of what an
 * upgrade IS in this model, and a definition that lives only in a test is one
 * the game cannot consult.
 */
export function derivedOutputs(phys, refHexes = CONFIG.RANGED_FULL_RANGE) {
  // Read, not recomputed. Energy is the authored quantity and velocity is what
  // falls out of it, so `½mv²` here would be measuring the derivation against
  // itself and would hide any node that moved the bow rather than the shaft.
  const energy = phys.blowEnergy_j;
  // The angle the MODEL shoots, drop included (see aimAngle) — not the authored
  // aim alone, which is a different number for anything that flies slowly.
  const spread = aimAngle(phys) * refHexes * CONFIG.PHYS_HEX_METERS;
  const group = spread * spread;
  return {
    energy,                                                              // J in one blow
    pressure: energy / (phys.contactArea_m2 * CONFIG.PHYS_PENETRATION_DEPTH), // Pa at the point
    // Silhouette over shot-group area at the game's own full-range boundary.
    // UNCAPPED, unlike the model's hit fraction, and that is the point: the
    // damage model clamps at 1 because more than every arrow cannot land, and
    // the clamp creates a dead zone where tightening an already-tight group buys
    // nothing. The first run of the I3 check failed inside exactly that zone —
    // Steady Stance "improved nothing" for a Grand Elf whose group was already
    // inside a man at range — which is a limitation of the yardstick, not a
    // fault in the node.
    precision: group > 0 ? phys.frontalArea_m2 / group : Infinity,
    armourStopping: phys.armorHardness_pa * phys.armorCoverage_frac,
    toughness: phys.woundEnergy_j,
    // SECTIONAL DENSITY, and the reason it is on this list. Without it, mass has
    // no consequence anywhere the I3 check can see, so every mass-increasing
    // node reads as strictly negative and the whole material-swap class — a
    // denser tip, the exemplar this schema was designed around — becomes
    // unexpressible. It is the hardest armour the point stays sharp against, in
    // kg/m², and higher is better like everything else here.
    //
    // It is deliberately NOT a Pareto objective: nobody wants sectional density,
    // they want a dead pikeman. Same rule that keeps `pressure` off that list.
    rigidity: phys.contactArea_m2 > 0 ? phys.blowMass_kg / phys.contactArea_m2 : 0,
  };
}

/**
 * Why `town` cannot take upgrade node `nodeId`, or null if it can.
 *
 * The node's own prerequisites (requires / excludes / already-taken / cost) are
 * NOT decided here — they go to `upgradeBlockReason`, the single gate in
 * core/upgrades.js, with `canAfford` injected. What this function adds is the
 * part the gate cannot know: an upgrade to a dwelling's troops needs the
 * dwelling, and needs it in a town of the right faction. Same division of labour
 * as buildBlockReason, one layer up.
 */
export function upgradeNodeBlockReason(state, town, nodeId) {
  const n = UPGRADE_NODES[nodeId];
  if (!n) return 'Unknown upgrade';
  if (town.owner < 0) return 'No owner';
  if (n.faction !== town.faction) return `Only ${n.faction} towns train that`;
  if (!town.buildings.includes(n.dwelling)) {
    return `Requires ${buildingCatalog(town.faction)[n.dwelling]?.name || n.dwelling}`;
  }
  const player = state.players[town.owner];
  // Nodes this player already has in the queue count as claimed — see the note
  // in upgradeBlockReason on why that is not the same set as `requires` reads.
  const pending = (state.jobs || [])
    .filter((j) => j.kind === 'upgradeNode' && j.owner === town.owner)
    .map((j) => j.target);
  return upgradeBlockReason(nodeId, player.upgrades ?? [], (cost) => canAfford(player, cost), pending);
}
