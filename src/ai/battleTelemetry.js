/**
 * battleTelemetry.js — the adapter that hangs the recorder off a battle.
 *
 * Layering: src/core/combat/* is a pure rule engine with no knowledge of the
 * session, the UI, or where a log lives. So it does not import the recorder —
 * it calls `battle.telemetry.decision(...)` if and only if something attached
 * one. This module is that something, and it is the only place the two meet.
 *
 * It also owns the half of the job the AI cannot do for itself: scoring the
 * HUMAN's moves. When a player acts, we run the AI's own candidate generator on
 * the same board and record where their choice landed in its ranking. That
 * single number — `chosenRank` on a human decision — is what turns the log from
 * a record of the AI's behaviour into a measurement of its evaluation function,
 * because a human move the AI ranked fifth (or never generated at all) indicts
 * the scorer, not the player.
 */

import { record, decision, telemetryEnabled } from './telemetry.js';
import { scoredOptionsFor } from '../core/combat/CombatAI.js';
import { CREATURES } from '../data/creatures.js';

/**
 * Mint the next battle id — from the STATE's own counter, never a module
 * global. The entries this id stamps live on `state.telemetry`, which rides the
 * save; a counter that lived here (as it originally did) was reset to zero by a
 * page reload while the saved log still held B1…, so the next battle was minted
 * as a SECOND "B1" and countCasts — which joins decisions to their battle by
 * this id — silently summed two unrelated fights into one report. Same class of
 * bug, same fix, as the hero/town uid moving into the save (GameState, save v3):
 * an id whose entries persist must mint from a counter that persists with them.
 *
 * `state.telemetryBattleSeq` follows the telemetrySeq/telemetryOff naming — a
 * recorder field, not a world field — and the nextCaravanId/nextPactId house
 * shape: last id handed out, incremented before use, lazily created. Two same-
 * seed games in one process now also produce byte-identical logs, because each
 * fresh state starts its own count instead of continuing its predecessor's.
 *
 * ADOPTING AN EXISTING SAVE. A save written before this fix carries B-stamped
 * entries but no counter, so the first mint against such a state scans the log
 * once and starts one past the highest id found — the same "one past what is
 * actually present" clamp deserialize applies to nextUid. Done HERE, lazily,
 * rather than in a migration: the log rides saves with no version bump by
 * design, load must not mutate a diagnostic record, and a state that never
 * records another battle never needs the field (which keeps
 * serialize→deserialize→serialize byte-stable for old saves).
 */
function mintBattleId(state) {
  if (typeof state.telemetryBattleSeq !== 'number') {
    let max = 0;
    for (const e of state.telemetry || []) {
      const m = typeof e.battleId === 'string' && /^B(\d+)$/.exec(e.battleId);
      if (m && +m[1] > max) max = +m[1];
    }
    state.telemetryBattleSeq = max;
  }
  return `B${++state.telemetryBattleSeq}`;
}

/**
 * Attach a recorder to `battle`. `state` is the game state that owns the log;
 * `humanSide` is the side a player is steering (−1 for an auto-resolve where
 * nobody is). `owners` maps side → player index, so a log covering a whole game
 * names realms rather than sides.
 *
 * Returns the battle id, or null when recording is off — in which case
 * `battle.telemetry` is left unset and every log call in the engine is a
 * cheap property test that short-circuits.
 */
export function attachBattleTelemetry(battle, state, { humanSide = -1, owners = null, context = null } = {}) {
  if (!telemetryEnabled(state) || !battle) return null;
  const battleId = mintBattleId(state);
  battle.telemetry = {
    humanSide,
    ownerOf: (side) => (owners ? owners[side] ?? side : side),
    decision: (entry) => record(state, decision({ ...entry, battleId })),
  };
  record(state, {
    phase: 'combat',
    kind: 'battle.start',
    battleId,
    humanSide,
    // The seed IS the replayability contract: with it and this initial roster,
    // any decision in the file can be re-run rather than argued about.
    seed: battle.seed || null,
    context: context || null,
    sides: [0, 1].map((side) => ({
      side,
      owner: owners ? owners[side] ?? side : side,
      hero: battle.sides?.[side]?.hero
        ? {
          name: battle.sides[side].hero.name,
          level: battle.sides[side].hero.level,
          mana: battle.sides[side].hero.mana,
          spells: [...(battle.sides[side].hero.spells || [])],
        }
        : null,
    })),
    units: (battle.units || []).map(unitSnapshot),
  });
  return battleId;
}

/** Casts actually made in this battle, per side, read back off the log. */
function countCasts(state, battleId) {
  const out = [0, 0];
  for (const e of state?.telemetry || []) {
    if (e.battleId !== battleId || e.kind !== 'decision' || e.channel !== 'spell') continue;
    if (!e.chosen || e.chosen === 'no-cast') continue;
    const side = e.subject?.side;
    if (side === 0 || side === 1) out[side]++;
  }
  return out;
}

/** Everything about a stack that a later reader needs to reconstruct the board. */
function unitSnapshot(u) {
  return {
    id: u.id,
    side: u.side,
    creature: u.creature,
    count: u.count,
    hp: u.hp,
    maxHp: u.maxHp,
    x: u.x,
    y: u.y,
    speed: u.speed,
    ...(u.machine ? { machine: u.machine } : {}),
    ...(u.effects?.length ? { effects: u.effects.map((e) => e.spellId) } : {}),
  };
}

/**
 * Close a battle out with the summary that says whether it went badly — the
 * middle read-out of the three, and the one that tells you WHICH fights to open
 * the per-decision log for.
 */
export function recordBattleEnd(battle, state, battleId, result = {}) {
  if (!battleId || !telemetryEnabled(state)) return null;
  // A battle unit carries no aiValue of its own — it is a property of the
  // CREATURE. Reading it off the unit silently produced zeroes, which is exactly
  // the "term reading the wrong quantity" defect this log exists to catch, so it
  // is worth saying plainly: the harness caught it in its first run.
  const lost = [0, 0];
  const survivorValue = [0, 0];
  for (const u of battle.units || []) {
    const worth = CREATURES[u.creature]?.aiValue || 0;
    const gone = Math.max(0, (u.startCount ?? u.count) - u.count);
    lost[u.side] += gone * worth;
    survivorValue[u.side] += (u.alive ? u.count : 0) * worth;
  }
  return record(state, {
    phase: 'combat',
    kind: 'battle.end',
    battleId,
    rounds: battle.round || 0,
    humanSide: battle.telemetry?.humanSide ?? -1,
    humanWon: result.humanWon ?? null,
    attackerWon: result.attackerWon ?? null,
    valueLost: lost,
    valueLeft: survivorValue,
    // Counted from the decision stream rather than from the battle, which keeps
    // no cast tally — one source of truth, and it stays correct if the engine
    // changes.
    spellsCast: countCasts(state, battleId),
    survivors: (battle.units || []).filter((u) => u.alive)
      .map((u) => ({ id: u.id, side: u.side, creature: u.creature, count: u.count })),
  });
}

/**
 * Record a HUMAN combat action, scored by the AI's own evaluator.
 *
 * This is the symmetric half, and the reason it is worth the work: the AI's
 * choice cannot be judged without a reference class, and the player IS the
 * reference class. Running `scoredOptionsFor` on the identical board and finding
 * where the human's action sits in the ranking gives three distinct readings:
 *
 *   rank 0        → the AI would have played the same move; no defect here.
 *   rank 3, 5, …  → the AI had the move and under-rated it → a MIS-WEIGHTED TERM.
 *   not found     → the AI never generated the move at all → a MISSING CANDIDATE,
 *                   the most serious of the three, because no amount of tuning
 *                   can make it choose something it cannot see.
 */
export function recordHumanAction(battle, state, battleId, unit, action) {
  if (!battleId || !telemetryEnabled(state) || !unit || !action) return null;
  let options = [];
  try {
    options = scoredOptionsFor(battle, unit) || [];
  } catch {
    options = []; // never let a diagnostic break a player's turn
  }
  const candidates = options.map((o) => ({ label: o.label || o.action?.type, score: o.score, terms: o.terms }));
  let chosenIndex = options.findIndex((o) => sameAction(o.action, action));
  let note = null;
  if (chosenIndex < 0) {
    // The move the AI could not see. Recorded AS a candidate at score 0 so the
    // file stays well-formed, and flagged so the aggregate can count it.
    candidates.push({ label: `human: ${describe(action)}`, score: 0, terms: {} });
    chosenIndex = candidates.length - 1;
    note = 'not-in-candidate-set';
  }
  return record(state, decision({
    phase: 'combat',
    channel: 'unit',
    battleId,
    actor: battle.telemetry?.ownerOf ? battle.telemetry.ownerOf(unit.side) : unit.side,
    human: true,
    unit: `${unit.creature}#${unit.id}`,
    subject: { side: unit.side, x: unit.x, y: unit.y, count: unit.count, hp: unit.hp, round: battle.round },
    candidates,
    chosenIndex,
    note,
    extra: { action: describe(action) },
  }));
}

/** Do two actions mean the same thing? Compared by intent, not object identity. */
function sameAction(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'attack') return a.targetId === b.targetId && a.x === b.x && a.y === b.y;
  if (a.type === 'shoot' || a.type === 'resurrect') return a.targetId === b.targetId;
  if (a.type === 'move') return a.x === b.x && a.y === b.y;
  return true; // wait / defend / spell — the type alone is the whole action
}

function describe(a) {
  if (!a) return 'none';
  if (a.type === 'attack') return `attack ${a.targetId} from ${a.x},${a.y}`;
  if (a.type === 'shoot') return `shoot ${a.targetId}`;
  if (a.type === 'move') return `move ${a.x},${a.y}`;
  if (a.type === 'resurrect') return `resurrect ${a.targetId}`;
  return a.type;
}

/**
 * Record a human HERO CAST, scored against the same spell candidate set the AI
 * would have built. The reported gap — "the AI never casts Blind where I would" —
 * is invisible in a movement log and shows up here as a human cast the AI either
 * ranked low or never priced.
 */
export function recordHumanCast(battle, state, battleId, side, spellId, target) {
  if (!battleId || !telemetryEnabled(state)) return null;
  return record(state, decision({
    phase: 'combat',
    channel: 'spell',
    battleId,
    actor: battle.telemetry?.ownerOf ? battle.telemetry.ownerOf(side) : side,
    human: true,
    subject: { side, round: battle.round, mana: battle.sides?.[side]?.hero?.mana ?? null },
    candidates: [{ label: `${spellId}${target?.unitId ? ` @${target.unitId}` : ''}`, score: 0, terms: {} }],
    chosenIndex: 0,
    note: 'human-cast',
    extra: { spell: spellId, target: target?.unitId ?? null },
  }));
}
