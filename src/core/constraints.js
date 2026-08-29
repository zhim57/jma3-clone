/**
 * constraints.js — which constraint is binding today, and what relaxing it buys.
 *
 * A player who wants to start something and cannot is being stopped by exactly
 * one thing at a time: gold, a material, or crews. Naming it is the whole
 * feature. A player who notices the bottleneck MIGRATE over a campaign — gold
 * early, crews once the economy runs, materials once the crews do — and
 * reallocates in response has independently derived the Theory of Constraints,
 * which is a better outcome than being told about it.
 *
 * THE SHADOW PRICE IS THE INTERESTING NUMBER, and specifically it is interesting
 * when it is ZERO. For crews it is measured, not modelled: project the queue's
 * clearance as things stand, project it again with one more crew, and report the
 * difference in days. On a serialized chain that difference is exactly zero — no
 * arrangement of crews shortens a chain — so the readout tells a player not to
 * buy, and tells them why. That is Amdahl's law arriving as a number on a screen
 * rather than as a lesson.
 *
 * PURE, and in core (I11). No rng, no mutation, no Phaser. It imports the job
 * scheduler and the upgrade gate; it does NOT import actions.js (I13), which is
 * why `upgradeNodeBlockReason` lives in core/upgrades.js rather than there.
 */

import { CONFIG } from '../config.js';
import { UPGRADE_NODES } from '../data/upgradeNodes.js';
import { upgradeNodeBlockReason } from './upgrades.js';
import { allJobs, planCrews, crewCapacity, projectClearance } from './jobs.js';

/** Towns this player owns. Local so this module need not import actions.js. */
function townsOf(state, owner) {
  return Object.values(state.towns || {}).filter((t) => t.owner === owner);
}

/**
 * What the player would start next but cannot afford, cheapest shortfall first.
 * Only nodes refused for MONEY count — a node refused for a prerequisite is not
 * a constraint, it is a plan.
 */
function unaffordable(state, owner) {
  const player = state.players[owner];
  if (!player) return [];
  const out = [];
  for (const town of townsOf(state, owner)) {
    for (const [id, n] of Object.entries(UPGRADE_NODES)) {
      if (upgradeNodeBlockReason(state, town, id) !== 'Not enough resources') continue;
      const short = {};
      for (const [res, amount] of Object.entries(n.cost || {})) {
        const gap = amount - (player.resources[res] || 0);
        if (gap > 0) short[res] = gap;
      }
      if (Object.keys(short).length) out.push({ id, name: n.name, short });
    }
  }
  // Cheapest total shortfall first — the nearest thing to being unblocked is
  // the one actually binding, not the most expensive thing on the wishlist.
  return out.sort((a, b) =>
    Object.values(a.short).reduce((x, y) => x + y, 0) - Object.values(b.short).reduce((x, y) => x + y, 0));
}

/**
 * The binding constraint for one player, or a `none` reading.
 *
 * Order matters and is a claim about what "binding" means: CREWS FIRST. Work
 * already paid for and sitting in the queue is a harder stop than work not yet
 * started — the player has committed and is being made to wait. Only when
 * nothing is waiting does an unaffordable purchase become the thing in the way.
 */
export function bindingConstraint(state, owner) {
  const jobs = allJobs(state).filter((j) => j.owner === owner);

  // ---- crews ----
  if (jobs.length) {
    const working = planCrews(state, owner);
    const stalled = jobs.filter((j) => !working.has(j.id));
    if (stalled.length) {
      // The pool with the most crew-days waiting on it. Ties break by pool name
      // so the reading is stable from one day to the next.
      const demand = new Map();
      for (const j of stalled) demand.set(j.crew, (demand.get(j.crew) || 0) + (j.crewCount || 1));
      const pool = [...demand.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];

      const now = projectClearance(state, owner);
      const withOne = projectClearance(state, owner,
        { [pool]: crewCapacity(state, owner, pool) + 1 });
      const saved = Number.isFinite(now) && Number.isFinite(withOne) ? now - withOne : 0;

      return {
        kind: 'crews',
        pool,
        waiting: stalled.length,
        clearance: now,
        shadowPrice: { unit: 'days', value: saved, per: `1 ${pool} crew` },
        text: saved > 0
          ? `${pool} are the bottleneck — ${stalled.length} job(s) waiting. `
            + `One more crew would clear the queue ${saved} day${saved === 1 ? '' : 's'} sooner.`
          : `${pool} are busy and ${stalled.length} job(s) wait, but the queue is bound by its `
            + 'dependencies — another crew would save nothing.',
      };
    }
  }

  // ---- gold or materials ----
  const wants = unaffordable(state, owner);
  if (wants.length) {
    const next = wants[0];
    const entries = Object.entries(next.short);
    // Gold is its own category because it is the one resource everything wants
    // and the one a player can usually do something about today.
    const nonGold = entries.filter(([res]) => res !== 'gold');
    const [resource, gap] = nonGold.length ? nonGold[0] : entries[0];
    return {
      kind: resource === 'gold' ? 'gold' : 'materials',
      resource,
      node: next.id,
      shadowPrice: { unit: resource, value: gap, per: next.name },
      text: `${resource} is the bottleneck — ${gap} more would start ${next.name}.`,
    };
  }

  return { kind: 'none', shadowPrice: null, text: 'Nothing is holding you back today.' };
}

/**
 * A stable key for "has the binding constraint changed", so the morning report
 * can speak on the transition rather than every dawn. The Gantt carries the
 * standing readout; a line repeated daily stops being read.
 */
export function bindingKey(b) {
  if (!b || b.kind === 'none') return 'none';
  return `${b.kind}:${b.pool || b.resource || ''}`;
}

/** Whether a job has waited long enough to be worth flagging (Option A). */
export function isStarving(job) {
  return (job?.waitingDays || 0) >= CONFIG.JOBS.STARVATION_DAYS;
}
