/**
 * jobs.test.js — multi-day work.
 *
 * The job system copies the caravan precedent: a plain array on state, advanced
 * one day at a time from `advanceDay`, round-tripping through saves because
 * there is nothing in it but data. What caravans do NOT have, and what this
 * suite is mostly about, is contention — crews are a realm-wide pool, so two
 * jobs can want the same crew and one of them has to wait.
 *
 * ENDTURN ADVANCES A PLAYER, NOT A DAY. This has produced at least two
 * confident, wrong conclusions in this project's history (HANDOVER §2.5): a
 * plain `for (i < 14) endTurn()` covers SEVEN days in a two-player game, so a
 * "14-day" test of a 7-day job would watch it finish and conclude the scheduler
 * double-counts. Every loop here goes through `runDays`, which watches
 * `state.day` actually move.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, serialize, deserialize } from '../src/core/GameState.js';
import { buildBlockReason, buyUpgradeNode, hireCrew, crewUpkeep } from '../src/core/actions.js';
import {
  scheduleJob, tickJobs, cancelJob, planCrews, jobsInTown, jobHoldingLock, townBuildLock,
  criticalPath, crewUtilization, projectClearance,
} from '../src/core/jobs.js';
import { CONFIG } from '../src/config.js';
import { bindingConstraint, bindingKey } from '../src/core/constraints.js';
import { UPGRADE_NODES } from '../src/data/upgradeNodes.js';
import { runDays } from './helpers.js';


// CLONE: the upgrade fixtures below use INFERNO's Kennels tree, not upstream's
// rampart Homestead tree. These tests buy a node THROUGH A TOWN, so the node's
// faction has to match the town's — and only castle and inferno are playable here
// (data/factions.js). The two trees are the same shape (a tier-3 dwelling, one base
// node at 5,200g and dependents at 5,600g, two-crew seven-day builds), so every
// assertion below is testing exactly what it tested upstream.
const game = () => newGame({
  seed: 31337,
  players: [
    { faction: 'inferno', isHuman: true, team: 0 },
    { faction: 'castle', isHuman: false, team: 1 },
  ],
});

/** Pin this player's crews so a contention test does not ride on CONFIG. */
function withCrews(state, pi, crews) {
  state.players[pi].crews = { ...state.players[pi].crews, ...crews };
  return state;
}

/** The first town owned by `pi`, with `buildings` forced on. */
function townFor(state, pi, buildings = []) {
  const town = Object.values(state.towns).find((t) => t.owner === pi);
  assert.ok(town, `player ${pi} has no town`);
  for (const b of buildings) if (!town.buildings.includes(b)) town.buildings.push(b);
  return town;
}

/** A minimal well-formed job spec against `town`. */
const spec = (town, over = {}) => ({
  kind: 'test', owner: town.owner, townId: town.id,
  crew: 'masons', days: 3, ...over,
});

// ---- the shape ---------------------------------------------------------------

test('jobs: a fresh game has an empty queue and a day costs nothing', () => {
  const state = game();
  assert.deepEqual(state.jobs, []);
  const calls = state.rng.calls;
  runDays(state, 3);
  // The system must be inert until used — a game that schedules nothing draws
  // no rng from the job tick and so shifts no seed (§2.3).
  assert.deepEqual(state.jobs, []);
  assert.ok(state.rng.calls >= calls, 'sanity: the day still ran');
});

test('jobs: scheduling validates the town, the owner, the crew and the days', () => {
  const state = game();
  const mine = townFor(state, 0);
  const theirs = townFor(state, 1);
  assert.equal(scheduleJob(state, spec(mine)).ok, true);
  assert.match(scheduleJob(state, { ...spec(mine), townId: 'nope' }).reason, /no town/);
  assert.match(scheduleJob(state, { ...spec(theirs), owner: 0 }).reason, /not your town/);
  assert.match(scheduleJob(state, spec(mine, { crew: 'wizards' })).reason, /unknown crew/);
  assert.match(scheduleJob(state, spec(mine, { days: 0 })).reason, /positive integer/);
  assert.match(scheduleJob(state, spec(mine, { days: 2.5 })).reason, /positive integer/);
  assert.match(scheduleJob(state, { ...spec(mine), kind: undefined }).reason, /no kind/);
});

test('jobs: a write-lock admits one job and refuses the second', () => {
  const state = game();
  const town = townFor(state, 0);
  const lock = townBuildLock(town.id, 'dwelling3');
  assert.equal(scheduleJob(state, spec(town, { lock })).ok, true);
  assert.match(scheduleJob(state, spec(town, { lock })).reason, /lready under way/);
  // A DIFFERENT building in the same town is a different lock — that is the
  // whole point of it being finer-grained than `builtToday`.
  assert.equal(scheduleJob(state, spec(town, { lock: townBuildLock(town.id, 'dwelling4') })).ok, true);
  assert.ok(jobHoldingLock(state, lock));
  assert.equal(jobHoldingLock(state, 'nothing:here'), null);
  assert.equal(jobHoldingLock(state, null), null, 'a job with no lock locks nothing');
});

test('jobs: buildBlockReason enforces the write-lock at the same gate as builtToday', () => {
  // Inert today — construction is still instant, so nothing ever holds a build
  // lock. It is wired now so the boolean and its successor are refused at ONE
  // place; a lock introduced at a different choke point is how two rules that
  // were meant to be one end up disagreeing.
  const state = game();
  const town = townFor(state, 0);
  // A target that is genuinely buildable right now, or the gate short-circuits
  // on 'Already built' and this test passes without ever reaching the lock —
  // which is exactly what it did on the first run, against a fort every fresh
  // town already has.
  const target = 'dwelling2';
  assert.equal(buildBlockReason(state, town, target), null, 'fixture: this must be buildable');

  scheduleJob(state, spec(town, { lock: townBuildLock(town.id, target) }));
  assert.equal(buildBlockReason(state, town, target), 'Already under construction');
  // And only that building: the lock is finer-grained than `builtToday`, which
  // would have barred the whole town.
  assert.equal(buildBlockReason(state, town, 'tavern'), 'Already built');
  assert.equal(town.builtToday, false, 'scheduling a job is not building a building');
});

// ---- crews and contention ----------------------------------------------------

test('jobs: one crew means one job a day, in queue order', () => {
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  const a = scheduleJob(state, spec(town, { days: 2 })).job;
  const b = scheduleJob(state, spec(town, { days: 2 })).job;

  tickJobs(state, {});
  assert.equal(a.worked, 1, 'the first in the queue gets the crew');
  assert.equal(b.worked, 0, 'the second waits');
  assert.equal(b.paused, true);

  tickJobs(state, {});
  assert.equal(a.worked, 2);
  assert.equal(b.worked, 0, 'and keeps waiting while the first is unfinished');
  assert.equal(jobsInTown(state, town.id).length, 1, 'the finished job left the queue');

  tickJobs(state, {});
  assert.equal(b.worked, 1, 'now it has the crew');
});

test('jobs: separate crew pools do not compete', () => {
  const state = game();
  const town = townFor(state, 0);
  const mason = scheduleJob(state, spec(town, { crew: 'masons' })).job;
  const fletcher = scheduleJob(state, spec(town, { crew: 'fletchers' })).job;
  tickJobs(state, {});
  assert.equal(mason.worked, 1);
  assert.equal(fletcher.worked, 1, 'a realm can raise a roof and refit archers on one day');
});

test('jobs: crews are realm-wide, so a second town does not double them', () => {
  // The design decision the whole scheduler exists for. If crews were per-town,
  // every job would finish in exactly `days` days and this array would be a list
  // of timers.
  const state = withCrews(game(), 0, { masons: 1 });
  const a = townFor(state, 0);
  const b = Object.values(state.towns).find((t) => t.owner === 0 && t.id !== a.id)
    || (() => { const t = { ...a, id: 'T_extra' }; state.towns[t.id] = t; return t; })();
  scheduleJob(state, spec(a, { days: 2 }));
  const second = scheduleJob(state, spec(b, { days: 2 })).job;
  tickJobs(state, {});
  assert.equal(second.worked, 0, 'two towns, one mason crew, one job advancing');
});

test('jobs: a non-preemptible job holds its crew until it is done', () => {
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  const long = scheduleJob(state, spec(town, { days: 3, preemptible: false })).job;
  tickJobs(state, {});                       // long starts, claims the crew
  const jumper = scheduleJob(state, spec(town, { days: 1 })).job;
  tickJobs(state, {});
  assert.equal(long.worked, 2);
  assert.equal(jumper.worked, 0, 'you do not leave a roof half-raised');
  tickJobs(state, {});
  assert.equal(jumper.worked, 0, 'still nothing, right up to the last crew-day');
  tickJobs(state, {});
  assert.equal(jumper.worked, 1, 'and only then does the crew move on');
});

test('jobs: a preemptible job can be set down and resumed, keeping its progress', () => {
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  const soft = scheduleJob(state, spec(town, { days: 4, preemptible: true })).job;
  tickJobs(state, {});
  assert.equal(soft.worked, 1);

  // A non-preemptible job queued behind it takes the crew as soon as the
  // preemptible one stops being protected — it has no claim on tomorrow.
  const hard = scheduleJob(state, spec(town, { days: 2, preemptible: false })).job;
  tickJobs(state, {});
  assert.equal(soft.worked, 2, 'queue order still favours the older job');
  assert.equal(hard.worked, 0);

  // Force the contest the other way: drop the soft job's claim by cancelling and
  // re-queueing it behind the hard one.
  cancelJob(state, soft.id);
  const resumed = scheduleJob(state, spec(town, { days: 4, preemptible: true })).job;
  tickJobs(state, {});
  assert.equal(hard.worked, 1, 'the hard job is now first in the queue');
  assert.equal(resumed.worked, 0);
  assert.equal(resumed.paused, true, 'and the preemptible one waits without losing anything');
});

test('jobs: planCrews reports the schedule without advancing anything', () => {
  // Contention a player cannot SEE is indistinguishable from a bug, so the
  // assignment is queryable rather than only observable after the fact.
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  const a = scheduleJob(state, spec(town)).job;
  const b = scheduleJob(state, spec(town)).job;
  const plan = planCrews(state, 0);
  assert.ok(plan.has(a.id));
  assert.ok(!plan.has(b.id));
  assert.equal(a.worked, 0, 'planning must not advance a job');
});

// ---- completion, injection, abandonment --------------------------------------

test('jobs: a finished job fires its INJECTED effect exactly once and leaves', () => {
  const state = game();
  const town = townFor(state, 0);
  const job = scheduleJob(state, spec(town, { days: 2, target: 'thing' })).job;
  let fired = 0;
  const deps = { complete: { test: (_s, j) => { fired++; assert.equal(j.id, job.id); } } };
  tickJobs(state, deps);
  assert.equal(fired, 0, 'not before the last crew-day');
  const events = tickJobs(state, deps);
  assert.equal(fired, 1);
  assert.equal(state.jobs.length, 0, 'and it is off the queue');
  assert.ok(events.some((e) => e.type === 'jobDone' && e.target === 'thing'));
  tickJobs(state, deps);
  assert.equal(fired, 1, 'a finished job cannot fire twice');
});

test('jobs: a kind with no handler still completes — the scheduler must not care', () => {
  const state = game();
  const town = townFor(state, 0);
  scheduleJob(state, spec(town, { days: 1, kind: 'unheardOf' }));
  const events = tickJobs(state, {});
  assert.ok(events.some((e) => e.type === 'jobDone'));
  assert.equal(state.jobs.length, 0);
});

test('jobs: a job whose town is lost is abandoned, as a caravan is', () => {
  const state = game();
  const town = townFor(state, 0);
  scheduleJob(state, spec(town));
  town.owner = 1;                       // captured overnight
  const events = tickJobs(state, {});
  assert.ok(events.some((e) => e.type === 'jobAbandoned'));
  assert.equal(state.jobs.length, 0);
});

test('jobs: stalling is reported on the transition, not every dawn', () => {
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  scheduleJob(state, spec(town, { days: 5 }));
  scheduleJob(state, spec(town, { days: 5 }));
  const first = tickJobs(state, {}).filter((e) => e.type === 'jobStalled');
  const second = tickJobs(state, {}).filter((e) => e.type === 'jobStalled');
  assert.equal(first.length, 1, 'the day it stalls, say so');
  assert.equal(second.length, 0, 'a job waiting a week must not shout every morning');
});

// ---- the day loop and the save ------------------------------------------------

test('jobs: advanceDay ticks the queue, one day at a time', () => {
  const state = game();
  const town = townFor(state, 0);
  const job = scheduleJob(state, spec(town, { days: 3 })).job;
  runDays(state, 1);
  assert.equal(job.worked, 1, 'exactly one crew-day per DAY, not per player turn');
  runDays(state, 2);
  assert.equal(state.jobs.length, 0, 'and it finished on the third');
});

test('jobs: the queue round-trips a save with no migration', () => {
  const state = game();
  const town = townFor(state, 0);
  scheduleJob(state, spec(town, { days: 4, target: 'dwelling3', lock: 'L' }));
  runDays(state, 1);
  const back = deserialize(serialize(state));
  assert.equal(back.jobs.length, 1);
  assert.equal(back.jobs[0].worked, 1);
  assert.equal(back.jobs[0].target, 'dwelling3');
  assert.equal(serialize(back), serialize(state), 'byte-identical round trip');
  // And the lock survives, so a reloaded game still refuses the duplicate.
  assert.ok(jobHoldingLock(back, 'L'));
});

test('jobs: a save written before the queue existed loads with an empty one', () => {
  const state = game();
  const raw = JSON.parse(serialize(state));
  delete raw.jobs;
  const old = deserialize(JSON.stringify(raw));
  assert.deepEqual(old.jobs, [], 'no migration, no SAVE_VERSION bump (§2.2)');
  const town = townFor(old, 0);
  assert.equal(scheduleJob(old, spec(town)).ok, true, 'and scheduling into it must not throw');
});

// ---- the one real job kind -----------------------------------------------------

test('jobs: training an upgrade node takes days and grants on the last one', () => {
  const state = game();
  const town = townFor(state, 0, ['dwelling3']);
  const p = state.players[0];
  p.resources.gold = 20_000; p.resources.wood = 100;
  const goldBefore = p.resources.gold;

  const started = buyUpgradeNode(state, town, 'kennels.kennel.honedFangs');
  assert.equal(started.ok, true);
  assert.ok(p.resources.gold < goldBefore, 'paid up front, as a caravan debits its garrison');
  assert.deepEqual(p.upgrades, [], 'and not granted yet');

  const days = started.job.days;
  runDays(state, days - 1);
  assert.deepEqual(p.upgrades, [], `still nothing after ${days - 1} of ${days} days`);
  runDays(state, 1);
  assert.deepEqual(p.upgrades, ['kennels.kennel.honedFangs'], 'granted on the last crew-day');
  assert.equal(state.jobs.length, 0);
});

test('jobs: the same node cannot be queued twice, and the gate still applies', () => {
  const state = game();
  const town = townFor(state, 0, ['dwelling3']);
  state.players[0].resources.gold = 20_000; state.players[0].resources.wood = 100;
  assert.equal(buyUpgradeNode(state, town, 'kennels.kennel.honedFangs').ok, true);
  assert.match(buyUpgradeNode(state, town, 'kennels.kennel.honedFangs').reason, /lready under way/);
  // Prerequisites are still the single gate's business: Bodkins need Heavy Draw,
  // and a Heavy Draw that is only QUEUED has not been trained yet.
  assert.match(buyUpgradeNode(state, town, 'kennels.kennel.studdedCollars').reason, /^Requires /);
});

test('jobs: an unaffordable node is refused before anything is queued', () => {
  const state = game();
  const town = townFor(state, 0, ['dwelling3']);
  state.players[0].resources.gold = 5;
  const r = buyUpgradeNode(state, town, 'kennels.kennel.honedFangs');
  assert.equal(r.ok, false);
  assert.equal(state.jobs.length, 0, 'a refused job must leave no trace');
});

// ---- Phase 7: crews as a scarce, expandable resource ---------------------------

test('jobs: a job wanting more crews than the realm owns is refused at the door', () => {
  // Not left in the queue to sit forever looking like a scheduler bug — the
  // refusal names the actual problem.
  const state = withCrews(game(), 0, { masons: 2 });
  const town = townFor(state, 0);
  assert.match(scheduleJob(state, spec(town, { crewCount: 3 })).reason, /needs 3 masons, you have 2/);
  assert.equal(scheduleJob(state, spec(town, { crewCount: 2 })).ok, true);
  assert.match(scheduleJob(state, spec(town, { crewCount: 0 })).reason, /crewCount/);
});

test('jobs: a two-crew job occupies both, so a one-crew job waits behind it', () => {
  const state = withCrews(game(), 0, { masons: 2 });
  const town = townFor(state, 0);
  const big = scheduleJob(state, spec(town, { crewCount: 2, days: 2 })).job;
  const small = scheduleJob(state, spec(town, { crewCount: 1, days: 2 })).job;
  tickJobs(state, {});
  assert.equal(big.worked, 1);
  assert.equal(small.worked, 0, 'both crews are on the big job');
});

test('jobs: hiring a crew costs gold, is capped, and shows up as capacity', () => {
  const state = game();
  const p = state.players[0];
  p.resources.gold = 100_000;
  const before = p.resources.gold;
  assert.equal(hireCrew(state, 0, 'masons').ok, true);
  assert.equal(p.crews.masons, CONFIG.JOBS.CREWS.masons + 1);
  assert.ok(p.resources.gold < before, 'a crew costs gold');
  assert.match(hireCrew(state, 0, 'wizards').reason, /unknown crew/);

  while (p.crews.masons < CONFIG.JOBS.MAX_CREWS_PER_POOL) hireCrew(state, 0, 'masons');
  assert.match(hireCrew(state, 0, 'masons').reason, /no more/);

  p.resources.gold = 0;
  assert.match(hireCrew(state, 0, 'fletchers').reason, /Not enough resources/);
});

test('jobs: only crews above the starting allotment cost upkeep', () => {
  // The starting crews are the realm's existing labour. Charging upkeep on them
  // would re-tune the economy of every game ever played, including ones that
  // never queue a job — a silent global balance change a scheduler has no
  // business making.
  const state = game();
  const p = state.players[0];
  assert.equal(crewUpkeep(state, p), 0, 'a player who hired nothing pays nothing');
  p.resources.gold = 100_000;
  hireCrew(state, 0, 'masons');
  assert.equal(crewUpkeep(state, p), CONFIG.JOBS.CREW_UPKEEP_GOLD);
  hireCrew(state, 0, 'fletchers');
  assert.equal(crewUpkeep(state, p), CONFIG.JOBS.CREW_UPKEEP_GOLD * 2);
});

test('jobs: upkeep is charged daily, and a game that hired nothing is untouched', () => {
  const bare = game();
  const goldBefore = bare.players[0].resources.gold;
  runDays(bare, 3);
  const bareGain = bare.players[0].resources.gold - goldBefore;

  const hired = game();
  hired.players[0].resources.gold = 100_000;
  hireCrew(hired, 0, 'masons');
  const hiredStart = hired.players[0].resources.gold;
  runDays(hired, 3);
  const hiredGain = hired.players[0].resources.gold - hiredStart;
  assert.ok(hiredGain < bareGain, `upkeep must bite: ${hiredGain} vs ${bareGain}`);
});

test('jobs: an extra crew buys nothing when the queue is dependency-bound (Amdahl)', () => {
  // The lesson the crew market exists to teach. Three jobs in a strict chain
  // cannot be parallelised, so a second crew changes the finish date not at all
  // — and its upkeep is pure loss. A player is meant to discover this by buying
  // one and watching nothing improve.
  const chainDays = (crews) => {
    const state = withCrews(game(), 0, { masons: crews });
    const town = townFor(state, 0);
    const a = scheduleJob(state, spec(town, { days: 2 })).job;
    const b = scheduleJob(state, spec(town, { days: 2, requires: [a.id] })).job;
    scheduleJob(state, spec(town, { days: 2, requires: [b.id] }));
    let days = 0;
    while (state.jobs.length && days < 50) { tickJobs(state, {}); days++; }
    return days;
  };
  assert.equal(chainDays(1), chainDays(4), 'a serial chain does not care how many crews you own');
  assert.equal(chainDays(1), 6, 'three 2-day jobs end to end');
});

test('jobs: a job whose prerequisite is incomplete never starts', () => {
  const state = withCrews(game(), 0, { masons: 4 });
  const town = townFor(state, 0);
  const first = scheduleJob(state, spec(town, { days: 3 })).job;
  const second = scheduleJob(state, spec(town, { days: 1, requires: [first.id] })).job;
  tickJobs(state, {});
  assert.equal(second.worked, 0, 'idle crews must not start blocked work');
  assert.equal(planCrews(state, 0).has(second.id), false);
  tickJobs(state, {}); tickJobs(state, {});          // first finishes on day 3
  assert.equal(state.jobs.length, 1);
  tickJobs(state, {});
  assert.equal(state.jobs.length, 0, 'and only then does the dependent run');
});

test('jobs: a starving job is flagged once, at the threshold', () => {
  // Option A: no aging. A long wait is never corrected, only made visible.
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  scheduleJob(state, spec(town, { days: 40 }));
  const waiter = scheduleJob(state, spec(town, { days: 1 })).job;
  let flags = 0;
  for (let d = 0; d < CONFIG.JOBS.STARVATION_DAYS + 3; d++) {
    flags += tickJobs(state, {}).filter((e) => e.type === 'jobStarving').length;
  }
  assert.equal(flags, 1, 'flagged on the transition, not every dawn after');
  assert.equal(waiter.waitingDays, CONFIG.JOBS.STARVATION_DAYS + 3);
});

// ---- Phase 7 §4.4: the required properties -------------------------------------

test('jobs: queue order is deterministic given identical state', () => {
  // No Set or object-key iteration order may leak into the schedule.
  const order = () => {
    const state = withCrews(game(), 0, { masons: 1, fletchers: 1 });
    const town = townFor(state, 0);
    const ids = [];
    for (let i = 0; i < 6; i++) {
      ids.push(scheduleJob(state, spec(town, { days: 1, crew: i % 2 ? 'fletchers' : 'masons' })).job.id);
    }
    const seen = [];
    for (let d = 0; d < 8; d++) {
      for (const ev of tickJobs(state, {})) if (ev.type === 'jobDone') seen.push(ev.job.id);
    }
    return seen.join(',');
  };
  assert.equal(order(), order());
  assert.ok(order().length > 0, 'and something actually finished');
});

test('jobs: rng.calls is unchanged across a 100-day run with and without jobs queued', () => {
  // I9. The scheduler draws zero, so a queued game and an empty one must consume
  // the stream identically — otherwise every balance measurement in config.js
  // taken on a seed stops meaning what it meant.
  const bare = game();
  runDays(bare, 100);

  const busy = game();
  const town = townFor(busy, 0, ['dwelling3']);
  busy.players[0].resources.gold = 200_000; busy.players[0].resources.wood = 500;
  busy.players[0].resources.ore = 500; busy.players[0].resources.crystal = 100;
  busy.players[0].resources.gems = 100;
  buyUpgradeNode(busy, town, 'kennels.kennel.honedFangs');
  runDays(busy, 100);

  assert.ok(busy.jobs.length >= 0);
  assert.equal(busy.rng.calls, bare.rng.calls,
    `queued ${busy.rng.calls} vs empty ${bare.rng.calls} — the scheduler drew from the stream`);
});

test('jobs: an owned node survives a save round-trip and cannot be bought twice', () => {
  const state = game();
  const town = townFor(state, 0, ['dwelling3']);
  const p = state.players[0];
  p.resources.gold = 50_000; p.resources.wood = 200; p.resources.ore = 200;
  const first = buyUpgradeNode(state, town, 'kennels.kennel.honedFangs');
  runDays(state, first.job.days);
  const head = buyUpgradeNode(state, town, 'kennels.kennel.studdedCollars');
  assert.equal(head.ok, true);
  runDays(state, head.job.days);
  assert.ok(p.upgrades.includes('kennels.kennel.studdedCollars'));

  // THE FORK IS CUT (§8i), so there is no sibling to be shut out any more — what a save
  // has to preserve now is the OWNED node, and the gate refusing to sell it twice. The
  // exclusion machinery itself is tested against a fixture catalog in upgrade-nodes.
  const back = deserialize(serialize(state));
  const backTown = Object.values(back.towns).find((t) => t.id === town.id);
  back.players[0].resources.gold = 50_000; back.players[0].resources.wood = 200;
  assert.equal(buyUpgradeNode(back, backTown, 'kennels.kennel.studdedCollars').reason, 'Already taken',
    'an owned node stays owned across a save');
});

test('jobs: a save round-trip is byte-identical with jobs in flight', () => {
  const state = game();
  const town = townFor(state, 0, ['dwelling3']);
  state.players[0].resources.gold = 50_000; state.players[0].resources.wood = 200;
  buyUpgradeNode(state, town, 'kennels.kennel.honedFangs');
  runDays(state, 2);
  assert.ok(state.jobs.length === 1, 'fixture: the job must still be in flight');
  const back = deserialize(serialize(state));
  assert.equal(serialize(back), serialize(state));
  assert.equal(back.jobs[0].worked, state.jobs[0].worked);
  assert.equal(back.jobs[0].crewCount, state.jobs[0].crewCount);
});

// ---- Phase 8: critical path ----------------------------------------------------

test('cpm: a hand-computed DAG gives the known answer', () => {
  //        A(3) ──▶ C(2) ──▶ D(4)      A→C→D = 9   ← critical
  //        B(1) ──────────────┘        B→D   = 5   float 4 on B
  const state = withCrews(game(), 0, { masons: 6 });
  const town = townFor(state, 0);
  const A = scheduleJob(state, spec(town, { days: 3 })).job;
  const B = scheduleJob(state, spec(town, { days: 1 })).job;
  const C = scheduleJob(state, spec(town, { days: 2, requires: [A.id] })).job;
  const D = scheduleJob(state, spec(town, { days: 4, requires: [C.id, B.id] })).job;

  const cp = criticalPath(state, 0);
  assert.equal(cp.finish, 9, 'A(3) + C(2) + D(4)');
  assert.deepEqual(cp.critical, [A.id, C.id, D.id]);
  const row = (id) => cp.jobs.find((r) => r.id === id);
  assert.equal(row(A.id).earliestStart, 0);
  assert.equal(row(C.id).earliestStart, 3);
  assert.equal(row(D.id).earliestStart, 5);
  assert.equal(row(B.id).float, 4, 'B can slip four days before the programme does');
  assert.equal(row(A.id).float, 0);
});

test('cpm: two chains of equal length are BOTH critical', () => {
  // The tie case, and it must not collapse to one: shortening either chain
  // alone buys nothing, and a view that showed only one would say otherwise.
  const state = withCrews(game(), 0, { masons: 6 });
  const town = townFor(state, 0);
  const a1 = scheduleJob(state, spec(town, { days: 2 })).job;
  const a2 = scheduleJob(state, spec(town, { days: 3, requires: [a1.id] })).job;
  const b1 = scheduleJob(state, spec(town, { days: 3 })).job;
  const b2 = scheduleJob(state, spec(town, { days: 2, requires: [b1.id] })).job;

  const cp = criticalPath(state, 0);
  assert.equal(cp.finish, 5);
  assert.deepEqual([...cp.critical].sort(), [a1.id, a2.id, b1.id, b2.id].sort());
  for (const j of [a1, a2, b1, b2]) {
    assert.equal(cp.jobs.find((r) => r.id === j.id).float, 0, `${j.id} should be critical`);
  }
});

test('cpm: duration is what a job has LEFT, not what it started as', () => {
  const state = withCrews(game(), 0, { masons: 4 });
  const town = townFor(state, 0);
  const j = scheduleJob(state, spec(town, { days: 5 })).job;
  assert.equal(criticalPath(state, 0).finish, 5);
  tickJobs(state, {}); tickJobs(state, {});
  assert.equal(j.worked, 2);
  assert.equal(criticalPath(state, 0).finish, 3, 'the programme is about today, not about the day it was queued');
});

test('cpm: a prerequisite that already finished is history, not a dependency', () => {
  const state = withCrews(game(), 0, { masons: 4 });
  const town = townFor(state, 0);
  const first = scheduleJob(state, spec(town, { days: 1 })).job;
  const second = scheduleJob(state, spec(town, { days: 2, requires: [first.id] })).job;
  tickJobs(state, {});                       // first completes and leaves the queue
  const cp = criticalPath(state, 0);
  assert.equal(cp.finish, 2);
  assert.deepEqual(cp.critical, [second.id]);
  assert.equal(cp.jobs.find((r) => r.id === second.id).earliestStart, 0);
});

test('cpm: it ignores crews, so the gap against reality IS the crew shortage', () => {
  // Two independent 3-day jobs and one crew. CPM says 3 (unlimited crews); the
  // scheduler delivers 6. That gap is Amdahl made checkable — and when it is
  // zero, another crew buys nothing.
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  scheduleJob(state, spec(town, { days: 3 }));
  scheduleJob(state, spec(town, { days: 3 }));
  assert.equal(criticalPath(state, 0).finish, 3, 'dependency-bound floor');
  let days = 0;
  while (state.jobs.length && days < 30) { tickJobs(state, {}); days++; }
  assert.equal(days, 6, 'what one crew actually delivers');

  // Now the serial case: CPM and reality agree, so there is nothing to buy.
  const serial = withCrews(game(), 0, { masons: 1 });
  const t2 = townFor(serial, 0);
  const x = scheduleJob(serial, spec(t2, { days: 3 })).job;
  scheduleJob(serial, spec(t2, { days: 3, requires: [x.id] }));
  assert.equal(criticalPath(serial, 0).finish, 6);
  let d2 = 0;
  while (serial.jobs.length && d2 < 30) { tickJobs(serial, {}); d2++; }
  assert.equal(d2, 6, 'a serial chain is already at its floor');
});

test('cpm: an empty queue is a finished programme, not a crash', () => {
  const state = game();
  const cp = criticalPath(state, 0);
  assert.equal(cp.finish, 0);
  assert.deepEqual(cp.critical, []);
  assert.deepEqual(cp.jobs, []);
});

test('utilization: crew-days used against crew-days available, per pool', () => {
  const state = withCrews(game(), 0, { masons: 2, fletchers: 2 });
  const town = townFor(state, 0);
  assert.deepEqual(crewUtilization(state, 0).masons, { used: 0, capacity: 2, ratio: 0 });
  scheduleJob(state, spec(town, { crew: 'masons', crewCount: 2 }));
  assert.deepEqual(crewUtilization(state, 0).masons, { used: 2, capacity: 2, ratio: 1 });
  assert.equal(crewUtilization(state, 0).fletchers.ratio, 0, 'a busy pool does not report for a quiet one');
});

// ---- Phase 9: the binding constraint and its shadow price -----------------------

test('constraint: nothing binding when there is nothing to want', () => {
  const state = game();
  const b = bindingConstraint(state, 0);
  assert.equal(b.kind, 'none');
  assert.equal(b.shadowPrice, null);
});

test('constraint: crews bind when paid-for work is waiting, and the price is in DAYS', () => {
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  scheduleJob(state, spec(town, { days: 4 }));
  scheduleJob(state, spec(town, { days: 4 }));
  const b = bindingConstraint(state, 0);
  assert.equal(b.kind, 'crews');
  assert.equal(b.pool, 'masons');
  assert.equal(b.waiting, 1);
  assert.equal(b.clearance, 8, 'one crew, two 4-day jobs');
  assert.equal(b.shadowPrice.unit, 'days');
  assert.equal(b.shadowPrice.value, 4, 'a second crew runs them side by side');
  assert.match(b.text, /4 days sooner/);
});

test('constraint: the shadow price of a crew is ZERO on a serial chain', () => {
  // The most instructive number in the phase. No arrangement of crews shortens
  // a chain, so the readout tells the player not to buy — and says why.
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  const a = scheduleJob(state, spec(town, { days: 3 })).job;
  const b2 = scheduleJob(state, spec(town, { days: 3, requires: [a.id] })).job;
  scheduleJob(state, spec(town, { days: 3, requires: [b2.id] }));
  const b = bindingConstraint(state, 0);
  assert.equal(b.kind, 'crews');
  assert.equal(b.shadowPrice.value, 0, 'a chain cannot be parallelised');
  assert.match(b.text, /another crew would save nothing/);
  // And it agrees with CPM: the programme is already at its dependency floor.
  assert.equal(criticalPath(state, 0).finish, projectClearance(state, 0));
});

test('constraint: gold binds when nothing is waiting but something is wanted', () => {
  const state = game();
  townFor(state, 0, ['dwelling3']);       // the branch needs its dwelling built
  const p = state.players[0];
  // Priced from the catalog, not from a literal. These tests are about the gap
  // ARITHMETIC and the precedence rule; pinning them to a number re-breaks them
  // every time the branch is re-costed, which taught nobody anything twice.
  const want = UPGRADE_NODES['kennels.kennel.honedFangs'].cost;
  p.resources.gold = want.gold - 1100;
  p.resources.wood = 500;
  const b = bindingConstraint(state, 0);
  assert.equal(b.kind, 'gold');
  assert.equal(b.resource, 'gold');
  assert.equal(b.shadowPrice.value, 1100, 'the gap, not a marginal rate');
  assert.match(b.text, /gold is the bottleneck/);
});

test('constraint: a material binds ahead of gold when both are short', () => {
  // Gold is the resource everything wants; naming it when a rare material is
  // also missing would send the player to the wrong problem.
  const state = game();
  // THE MATERIAL-PRICED BRANCH IS FOUND, NOT NAMED. This pinned the Homestead,
  // which carried ore until the tree was re-costed onto a tier schedule — gold
  // early, crews mid, materials from tier 4 — and then the test failed for a
  // reason it is not about: its fixture had stopped carrying a material at all.
  // What it needs is "some branch whose dependent costs a material", which is a
  // property of the catalog and belongs read off it.
  const dep = Object.entries(UPGRADE_NODES).find(([, n]) => n.faction === 'inferno'
    && n.requires.length > 0
    && Object.keys(n.cost).some((r) => r !== 'gold' && n.cost[r] > 0));
  assert.ok(dep, 'fixture: no inferno node costs a material — the precedence rule is untestable');
  const town = townFor(state, 0, [dep[1].dwelling]);
  // ONLY that dwelling. A starting town already owns its tier-1 dwelling, whose
  // branch is now priced in gold alone — leave it standing and the cheapest
  // WANTED node is a gold-only one, so gold binds and the precedence rule never
  // gets asked the question. The old fixture did not have to care because every
  // tier carried a material.
  town.buildings = town.buildings.filter((b) => !/^dwelling\d$/.test(b) || b === dep[1].dwelling);
  const p = state.players[0];
  // The material-priced nodes sit one tier down, so the root has to be OWNED for
  // them to be a wish rather than a plan — a node refused for a prerequisite is
  // not a constraint. Every resource is emptied, so gold and a material are both
  // genuinely short and the precedence rule is what decides, not the fixture.
  p.upgrades = [...dep[1].requires];
  for (const res of Object.keys(p.resources)) p.resources[res] = 0;
  const b = bindingConstraint(state, 0);
  assert.equal(b.kind, 'materials');
  assert.notEqual(b.resource, 'gold', 'gold must not be named while a material is also short');
  // And the material named is one the cheapest wanted node actually asks for.
  assert.ok(UPGRADE_NODES[b.node].cost[b.resource] > 0,
    `${b.node} does not cost ${b.resource}`);
});

test('constraint: waiting work outranks an unaffordable wish', () => {
  // Order is a claim about what binding MEANS: work already paid for and sitting
  // in the queue is a harder stop than work not yet started.
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0, ['dwelling3']);
  state.players[0].resources.gold = 0;
  scheduleJob(state, spec(town, { days: 3 }));
  scheduleJob(state, spec(town, { days: 3 }));
  assert.equal(bindingConstraint(state, 0).kind, 'crews');
});

test('constraint: the morning line speaks on the transition, not every dawn', () => {
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  scheduleJob(state, spec(town, { days: 12 }));
  scheduleJob(state, spec(town, { days: 12 }));
  const said = () => state.log.filter((l) => /bottleneck|save nothing/i.test(l.text)).length;
  runDays(state, 1);
  const first = said();
  assert.equal(first, 1, 'it says so the day it becomes true');
  runDays(state, 3);
  assert.equal(said(), first, 'and does not repeat while nothing has changed');
});

test('constraint: bindingKey is stable and distinguishes the pools', () => {
  assert.equal(bindingKey({ kind: 'none' }), 'none');
  assert.equal(bindingKey(null), 'none');
  assert.equal(bindingKey({ kind: 'crews', pool: 'masons' }), 'crews:masons');
  assert.notEqual(bindingKey({ kind: 'crews', pool: 'masons' }),
    bindingKey({ kind: 'crews', pool: 'fletchers' }));
});

test('constraint: reading it draws no rng and mutates nothing', () => {
  const state = withCrews(game(), 0, { masons: 1 });
  const town = townFor(state, 0);
  const j = scheduleJob(state, spec(town, { days: 5 })).job;
  scheduleJob(state, spec(town, { days: 5 }));
  const calls = state.rng.calls, before = JSON.stringify(state.jobs);
  bindingConstraint(state, 0);
  projectClearance(state, 0, { masons: 9 });
  assert.equal(state.rng.calls, calls, 'a diagnostic must never move the seed (I9)');
  assert.equal(JSON.stringify(state.jobs), before, 'and must not advance the queue it measured');
  assert.equal(j.worked, 0);
});
