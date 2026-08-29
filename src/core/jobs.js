/**
 * jobs.js — multi-day work: things that take more than a dawn to finish.
 *
 * There was no job framework, so this copies the one precedent the codebase
 * already trusts: CARAVANS. `state.caravans` is a plain array of plain objects,
 * advanced exactly one day at a time by `advanceCaravans(state)` inside
 * `advanceDay`, round-tripping through saves with no migration and no custom
 * serializer because there is nothing in it but data. `state.jobs` is the same
 * shape for the same reasons — a job holds ids and integers, never a live
 * reference to a town or a player, so a save is a save.
 *
 * WHAT A JOB IS. A piece of work that consumes CREW-DAYS. It names the crew pool
 * it draws from, how many days of that crew it needs, and what it is producing.
 * What "producing" MEANS is not this module's business — see the injection note.
 *
 *   { id, kind, owner, townId, target, crew, days, worked, preemptible, lock }
 *
 * CREWS ARE REALM-WIDE, NOT PER-TOWN. One player has CONFIG.JOBS.CREWS.masons
 * mason crews for their whole realm, so a second town does not double your
 * builders — it competes for them. That is the entire point of having a
 * scheduler rather than a countdown per town: with unlimited crews every job
 * finishes in `days` days and the array is just a list of timers.
 *
 * PREEMPTIBLE VS NOT. A preemptible job may be set down mid-way and picked up
 * later; it keeps its `worked` days and simply does not advance on a day it
 * loses its crew. A non-preemptible job, ONCE STARTED, holds its crew until it
 * finishes — you do not leave a roof half-raised to go fletch arrows. That is
 * the whole difference, and it is what makes queue order matter: a
 * non-preemptible job that gets a crew has effectively reserved it for the rest
 * of its run.
 *
 * WRITE-LOCKS. A job may declare a `lock` string, and no second job may be
 * scheduled while a job holding that lock is alive. For construction the key is
 * `${townId}:${buildingId}`, which is the finer-grained successor to
 * `town.builtToday`: that boolean locks a WHOLE TOWN for a day, where a lock
 * keyed on the dwelling stops only the thing actually being worked on.
 * `builtToday` is still authoritative and still enforced — see the note on
 * `townBuildLock` — because a scheduler that has never run a real build is not
 * yet something to hand the construction rules to.
 *
 * NO RNG, EVER. Nothing here draws from the stream, so turning the system on for
 * a save that has never used it shifts no seed (HANDOVER §2.3). Iteration is in
 * array order throughout, which is insertion order, which is the queue.
 *
 * DEPENDENCY INJECTION (HANDOVER §2.4). `actions.js` imports this module, so
 * this module must never import `actions.js`. A job's COMPLETION EFFECT — build
 * the building, grant the upgrade — lives in actions.js and arrives as
 * `deps.complete[kind]`. This module owns scheduling and knows nothing about
 * what it is scheduling.
 */

import { CONFIG } from '../config.js';

/**
 * Crew capacity of one pool for one player. Read through `??` so a save written
 * before crews were purchasable reads as the starting allotment (I12).
 */
export function crewCapacity(state, owner, crew) {
  const held = state?.players?.[owner]?.crews?.[crew];
  return Number.isFinite(held) ? held : (CONFIG.JOBS.CREWS[crew] ?? 0);
}

/** Live jobs, oldest first (array order IS queue order). */
export function allJobs(state) {
  return state.jobs || [];
}

/** Live jobs in one town. */
export function jobsInTown(state, townId) {
  return allJobs(state).filter((j) => j.townId === townId);
}

/** The job holding `lock`, or null. */
export function jobHoldingLock(state, lock) {
  if (!lock) return null;
  return allJobs(state).find((j) => j.lock === lock) || null;
}

/**
 * The write-lock key for building `buildingId` in `townId`.
 *
 * The successor to `town.builtToday`, and deliberately not yet its replacement:
 * `builtToday` bars a second build ANYWHERE in the town today, this bars a
 * second job against THAT BUILDING for as long as the job runs. Both are live
 * while the scheduler is unproven, and the boolean is the one construction
 * actually obeys. Swapping them is a pacing change to the whole game, not a
 * refactor, and it wants its own measurement.
 */
export function townBuildLock(townId, buildingId) {
  return `${townId}:${buildingId}`;
}

/**
 * Queue a job. Returns { ok, job } or { ok:false, reason }.
 *
 * Validation only — it does not charge for anything. Whatever a job costs is
 * the caller's to take before scheduling, exactly as `dispatchCaravan` debits
 * the garrison before the caravan exists: a queued job that has not been paid
 * for is a promise the save cannot keep.
 */
export function scheduleJob(state, spec) {
  const {
    kind, owner, townId, target = null, crew, days,
    crewCount = 1, preemptible = false, lock = null, requires = [],
  } = spec || {};
  if (!kind) return { ok: false, reason: 'no kind' };
  const town = state.towns?.[townId];
  if (!town) return { ok: false, reason: 'no town' };
  if (town.owner !== owner || owner < 0) return { ok: false, reason: 'not your town' };
  if (!(crew in CONFIG.JOBS.CREWS)) return { ok: false, reason: `unknown crew "${crew}"` };
  if (!Number.isInteger(days) || days < 1) return { ok: false, reason: 'days must be a positive integer' };
  if (!Number.isInteger(crewCount) || crewCount < 1) return { ok: false, reason: 'crewCount must be a positive integer' };
  // A job that wants more crews than the realm owns can never be scheduled, and
  // would sit in the queue forever looking like a scheduler bug. Refuse it at
  // the door with a reason that names the actual problem.
  if (crewCount > crewCapacity(state, owner, crew)) {
    return { ok: false, reason: `needs ${crewCount} ${crew}, you have ${crewCapacity(state, owner, crew)}` };
  }
  const held = jobHoldingLock(state, lock);
  if (held) return { ok: false, reason: `already under way (${held.id})` };

  const job = {
    id: `JB${state.nextJobId = (state.nextJobId || 0) + 1}`,
    kind, owner, townId, target, crew, days, worked: 0,
    crewCount, preemptible: !!preemptible, lock,
    // Prerequisite JOB ids. Distinct from an upgrade node's `requires`, which is
    // about what the player already OWNS; this is about what is still in flight,
    // and it is what gives the critical path a DAG to walk.
    requires: [...requires],
    startedDay: state.day,
    paused: false,
    // Days this job has wanted a crew and not had one. Option A on starvation
    // (spec §0): no aging, so a long wait is never corrected — it is merely made
    // visible, because contention a player cannot see is indistinguishable from
    // a bug and a predictable scheduler teaches more than a fair one.
    waitingDays: 0,
  };
  (state.jobs ||= []).push(job);
  return { ok: true, job };
}

/** Drop a job without completing it. Returns true if one was removed. */
export function cancelJob(state, jobId) {
  const before = allJobs(state).length;
  state.jobs = allJobs(state).filter((j) => j.id !== jobId);
  return state.jobs.length < before;
}

/**
 * Which jobs get a crew today, per player. Exported because contention is the
 * thing a player needs to SEE — a job that did not advance and cannot say why is
 * indistinguishable from a bug — and because it lets a test assert the schedule
 * without advancing a day.
 *
 * Two passes, and the order is the rule:
 *   1. non-preemptible jobs already under way reclaim their crew
 *   2. everything else, in queue order, takes what is left
 */
export function planCrews(state, owner) {
  const mine = allJobs(state).filter((j) => j.owner === owner);
  return assignCrews(mine, (pool) => crewCapacity(state, owner, pool));
}

/**
 * The assignment itself, over a plain job list and a capacity lookup.
 *
 * Split out from `planCrews` so a HYPOTHETICAL capacity can be scheduled with
 * the same code the real day uses — that is what makes a shadow price honest.
 * A second copy of this that answered "what if I had one more crew" would be a
 * copy that drifts, and this file has already seen what a hand-maintained mirror
 * does (CombatAI's `expectedDamage` "mirrors rollDamage", and stopped).
 */
export function assignCrews(jobs, capacityOf) {
  const used = new Map();
  const claimed = new Set();
  // A job cannot start until every job it requires has left the queue. Blocked
  // jobs are skipped rather than reserved: holding a crew for work that cannot
  // begin is how a scheduler deadlocks itself.
  const live = new Set(jobs.map((j) => j.id));
  const ready = (job) => (job.requires || []).every((id) => !live.has(id));
  const take = (job) => {
    if (!ready(job)) return false;
    const n = used.get(job.crew) || 0;
    const want = job.crewCount || 1;
    if (n + want > capacityOf(job.crew)) return false;
    used.set(job.crew, n + want);
    claimed.add(job.id);
    return true;
  };
  for (const job of jobs) if (!job.preemptible && job.worked > 0) take(job);
  for (const job of jobs) if (!claimed.has(job.id)) take(job);
  return claimed;
}

/**
 * Days until this player's queue is empty, given a capacity that may be
 * hypothetical. Pure — it works on copies and never touches `state.jobs`.
 *
 * This is the measurement a crew's shadow price is taken from: run it as things
 * stand, run it with one more crew, and the difference is what that crew is
 * worth in days. On a serialized chain the difference is ZERO, which is the
 * whole point — the number tells a player not to buy.
 */
export function projectClearance(state, owner, crewsOverride = null, cap = 500) {
  const jobs = allJobs(state).filter((j) => j.owner === owner).map((j) => ({ ...j }));
  if (!jobs.length) return 0;
  const capacityOf = (pool) => (crewsOverride && pool in crewsOverride
    ? crewsOverride[pool]
    : crewCapacity(state, owner, pool));
  let live = jobs, day = 0;
  while (live.length && day < cap) {
    const working = assignCrews(live, capacityOf);
    // Nothing can advance — a job wants more crews than exist, or a cycle. Stop
    // rather than spin to the cap and report a fictional number.
    if (!working.size) return Infinity;
    for (const j of live) if (working.has(j.id)) j.worked++;
    live = live.filter((j) => j.worked < j.days);
    day++;
  }
  return live.length ? Infinity : day;
}

/**
 * Advance every job one day. Returns the events for the log/view.
 *
 * `deps.complete` maps a job kind to the effect that finishes it —
 * `(state, job) => void`. A kind with no handler still completes and still
 * reports; it simply does nothing, which is the right failure for a scheduler
 * that must not care what it schedules.
 */
export function tickJobs(state, deps = {}) {
  const events = [];
  if (!state.jobs?.length) return events;

  // A job whose town is gone, or no longer its owner's, is abandoned — the same
  // call `advanceCaravans` makes when a destination stops being ours.
  const alive = [];
  for (const job of state.jobs) {
    const town = state.towns?.[job.townId];
    if (!town || town.owner !== job.owner) {
      events.push({ type: 'jobAbandoned', job, townId: job.townId, owner: job.owner });
      continue;
    }
    alive.push(job);
  }
  state.jobs = alive;

  const owners = [...new Set(alive.map((j) => j.owner))].sort((a, b) => a - b);
  const working = new Set();
  for (const owner of owners) for (const id of planCrews(state, owner)) working.add(id);

  const finished = new Set();
  for (const job of state.jobs) {
    if (!working.has(job.id)) {
      // Report the transition, not the state: a job that has been waiting for a
      // week should not shout about it every dawn.
      if (!job.paused) events.push({ type: 'jobStalled', job, crew: job.crew, owner: job.owner });
      job.paused = true;
      job.waitingDays = (job.waitingDays || 0) + 1;
      // Flag the transition past the threshold once, not every dawn after it.
      if (job.waitingDays === CONFIG.JOBS.STARVATION_DAYS) {
        events.push({ type: 'jobStarving', job, days: job.waitingDays, owner: job.owner });
      }
      continue;
    }
    if (job.paused) events.push({ type: 'jobResumed', job, owner: job.owner });
    job.paused = false;
    job.worked++;
    if (job.worked >= job.days) {
      finished.add(job.id);
      deps.complete?.[job.kind]?.(state, job);
      events.push({ type: 'jobDone', job, kind: job.kind, target: job.target, owner: job.owner, townId: job.townId });
    }
  }
  if (finished.size) state.jobs = state.jobs.filter((j) => !finished.has(j.id));
  return events;
}

// ---------------------------------------------------------------------------
// Critical path
// ---------------------------------------------------------------------------

/**
 * Critical Path Method over the queued and in-flight jobs of one player.
 *
 * Standard CPM: a forward pass gives each job its earliest start and finish, a
 * backward pass gives its latest start and finish, and FLOAT is the difference —
 * how long a job can slip before the whole programme slips with it. Zero-float
 * jobs are the critical path. Ties are real and are kept: two chains of equal
 * length are both critical, and collapsing them to one would hide the fact that
 * shortening either alone buys nothing.
 *
 * A job's duration is what it has LEFT (`days - worked`), not its nominal
 * length, so the answer is about the programme from today rather than from the
 * day it was queued.
 *
 * IT IGNORES CREWS, DELIBERATELY, and that is the whole teaching payload. CPM
 * answers "how long would this take with unlimited crews" — the floor set by
 * dependencies alone. Compare it against what the scheduler actually delivers
 * and the gap IS the crew shortage; when there is no gap, the programme is
 * dependency-bound and buying another crew changes nothing. That is Amdahl's law
 * made checkable rather than asserted, and it is why Phase 9's shadow price for
 * a crew is exactly zero on a serialized chain.
 *
 * Pure: no rng, no mutation, no Phaser (I11).
 */
export function criticalPath(state, owner) {
  const jobs = allJobs(state).filter((j) => j.owner === owner);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const left = (j) => Math.max(0, j.days - j.worked);

  // Only prerequisites still in the queue constrain anything — a requirement
  // that has already finished is not a dependency, it is history.
  const deps = (j) => (j.requires || []).filter((id) => byId.has(id));
  const succ = new Map(jobs.map((j) => [j.id, []]));
  for (const j of jobs) for (const d of deps(j)) succ.get(d).push(j.id);

  // Forward pass, in dependency order. The queue is insertion-ordered rather
  // than topologically sorted, so iterate to a fixed point instead of assuming
  // a prerequisite comes first — a job may legally require one queued later.
  const es = new Map(), ef = new Map();
  for (const j of jobs) { es.set(j.id, 0); ef.set(j.id, left(j)); }
  for (let pass = 0; pass < jobs.length; pass++) {
    let moved = false;
    for (const j of jobs) {
      const start = deps(j).reduce((m, d) => Math.max(m, ef.get(d)), 0);
      if (start !== es.get(j.id)) {
        es.set(j.id, start); ef.set(j.id, start + left(j)); moved = true;
      }
    }
    if (!moved) break;
  }

  const finish = jobs.reduce((m, j) => Math.max(m, ef.get(j.id)), 0);

  // Backward pass, same fixed-point treatment.
  const lf = new Map(), ls = new Map();
  for (const j of jobs) { lf.set(j.id, finish); ls.set(j.id, finish - left(j)); }
  for (let pass = 0; pass < jobs.length; pass++) {
    let moved = false;
    for (const j of jobs) {
      const after = succ.get(j.id);
      const end = after.length ? after.reduce((m, s) => Math.min(m, ls.get(s)), Infinity) : finish;
      if (end !== lf.get(j.id)) {
        lf.set(j.id, end); ls.set(j.id, end - left(j)); moved = true;
      }
    }
    if (!moved) break;
  }

  const rows = jobs.map((j) => ({
    id: j.id,
    earliestStart: es.get(j.id),
    earliestFinish: ef.get(j.id),
    latestStart: ls.get(j.id),
    latestFinish: lf.get(j.id),
    float: ls.get(j.id) - es.get(j.id),
  }));
  return {
    finish,
    jobs: rows,
    // Zero-float jobs, in earliest-start order — which is the order they are
    // drawn in and the order a player reads them.
    critical: rows.filter((r) => r.float === 0)
      .sort((a, b) => a.earliestStart - b.earliestStart || (a.id < b.id ? -1 : 1))
      .map((r) => r.id),
  };
}

/**
 * Crew-days used against crew-days available, per pool, for one player today.
 * The primary contention reading: utilization is linear and readable at any
 * load, where queue depth is a nonlinear lagging consequence of it and sits near
 * zero across a wide band of low utilizations.
 */
export function crewUtilization(state, owner) {
  const working = planCrews(state, owner);
  const out = {};
  for (const pool of Object.keys(CONFIG.JOBS.CREWS)) {
    const capacity = crewCapacity(state, owner, pool);
    const used = allJobs(state)
      .filter((j) => j.owner === owner && j.crew === pool && working.has(j.id))
      .reduce((n, j) => n + (j.crewCount || 1), 0);
    out[pool] = { used, capacity, ratio: capacity > 0 ? used / capacity : 0 };
  }
  return out;
}
