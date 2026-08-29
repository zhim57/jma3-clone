/**
 * battleDigest.js — Pure reducer: combat event stream -> a debrief.
 *
 * The consequence layer of the Battle Gym. Given the raw engine event list a
 * battle produced and a roster snapshot (unit id -> side/creature/startCount),
 * it computes what actually happened — losses per stack, who did the killing,
 * the single biggest threat — and a one-line verdict. No engine state, no
 * Phaser: just data in, data out, so it is trivially unit-testable.
 *
 * Roster entry: { id, side, creature, startCount }
 * meta: { humanSide, won, xp }
 */

import { CREATURES } from '../../data/creatures.js';

function creatureName(id) {
  return CREATURES[id]?.name || id;
}

function isShooter(id) {
  return CREATURES[id]?.reach === 'ranged';
}

export function battleDigest(events, roster, meta = {}) {
  const H = meta.humanSide ?? 0;
  const E = 1 - H;
  const byId = new Map((roster || []).map((u) => [u.id, u]));
  const sideOf = (id) => byId.get(id)?.side;
  const creatureOf = (id) => byId.get(id)?.creature;

  // Enemy hero spell damage is attributed to this synthetic "attacker" so the
  // debrief can blame nukes (a hero is not a battlefield unit with an id).
  const SPELL_THREAT = '@spell';

  let rounds = 1;
  const dmgBySide = [0, 0];            // total damage dealt, by side
  const lossByStack = new Map();       // unitId -> creatures lost
  const killsByAttacker = new Map();   // attackerId -> creatures of the HUMAN side it slew

  // The side that dealt an event's damage: a unit via attackerId, or a hero via
  // casterSide (spell events carry no attackerId).
  const dealerSide = (ev) => (ev.attackerId != null ? sideOf(ev.attackerId)
    : (ev.casterSide === 0 || ev.casterSide === 1 ? ev.casterSide : undefined));

  for (const ev of events || []) {
    if (ev.type === 'roundStart') {
      rounds = Math.max(rounds, ev.round || rounds);
      continue;
    }
    // Creatures handed BACK to a stack — Resurrection / Archangel (heal.revived)
    // and Phoenix rebirth (rebirth.count) — reduce that stack's net losses, so
    // the debrief reports what actually fell rather than gross kills.
    if (ev.type === 'rebirth' && ev.unitId != null && ev.count > 0) {
      lossByStack.set(ev.unitId, Math.max(0, (lossByStack.get(ev.unitId) || 0) - ev.count));
      continue;
    }
    if (ev.type === 'heal' && ev.targetId != null && ev.revived > 0) {
      lossByStack.set(ev.targetId, Math.max(0, (lossByStack.get(ev.targetId) || 0) - ev.revived));
      continue;
    }
    // A rout (opt-in cohesion, #11) is a loss with no killer: checkBreak zeroes
    // the stack and its survivors flee the field — they are NOT in the army
    // written back after the battle — but the event carries no `kills`, so
    // without this branch the debrief reported the fled troops as having come
    // home. `count` is the fled-survivor tally checkBreak recorded; they are
    // deliberately NOT credited to any attacker (nobody killed them, so they
    // must not inflate a "biggest threat" line).
    if (ev.type === 'rout' && ev.unitId != null && ev.count > 0) {
      lossByStack.set(ev.unitId, (lossByStack.get(ev.unitId) || 0) + ev.count);
      continue;
    }
    // The moat bites the stack that ENTERS it: the victim rides on `unitId`, not
    // `targetId`, so normalise. (Terrain damage has no dealer — see below.)
    const victimId = ev.targetId ?? ev.unitId;
    if (typeof ev.damage === 'number') {
      const s = dealerSide(ev);
      // Only count damage dealt to the OTHER side as a side's output: friendly
      // fire (chain lightning, Armageddon, Magog splash) must not inflate it,
      // and terrain (moat) has no dealer at all.
      if ((s === 0 || s === 1) && sideOf(victimId) !== s) dmgBySide[s] += ev.damage;
    }
    if (typeof ev.kills === 'number' && ev.kills > 0 && victimId != null) {
      lossByStack.set(victimId, (lossByStack.get(victimId) || 0) + ev.kills);
      if (sideOf(victimId) === H) {
        if (ev.attackerId != null && sideOf(ev.attackerId) === E) {
          killsByAttacker.set(ev.attackerId, (killsByAttacker.get(ev.attackerId) || 0) + ev.kills);
        } else if (ev.casterSide === E) {
          // Enemy hero's spell cut down your troops — blame the sorcery.
          killsByAttacker.set(SPELL_THREAT, (killsByAttacker.get(SPELL_THREAT) || 0) + ev.kills);
        }
      }
    }
  }

  // Losses grouped by creature, per side.
  const lossesFor = (S) => {
    const m = new Map();
    for (const u of (roster || []).filter((x) => x.side === S)) {
      const e = m.get(u.creature) || { creature: u.creature, name: creatureName(u.creature), lost: 0, started: 0 };
      e.lost += lossByStack.get(u.id) || 0;
      e.started += u.startCount || 0;
      m.set(u.creature, e);
    }
    return [...m.values()].map((e) => ({ ...e, survived: Math.max(0, e.started - e.lost) }));
  };

  // Per-stack casualty detail (one row per stack, not folded by creature).
  const stacksFor = (S) => (roster || []).filter((x) => x.side === S).map((u) => {
    const started = u.startCount || 0;
    const lost = lossByStack.get(u.id) || 0;
    return {
      id: u.id,
      creature: u.creature,
      name: creatureName(u.creature),
      started,
      lost,
      survived: Math.max(0, started - lost),
    };
  });

  // The single enemy stack (or the enemy hero's sorcery) that cut down the most
  // of your troops.
  let biggestThreat = null;
  for (const [aid, kills] of killsByAttacker) {
    if (!biggestThreat || kills > biggestThreat.kills) {
      biggestThreat = aid === SPELL_THREAT
        ? { creature: null, name: "hero's spells", kills }
        : { creature: creatureOf(aid), name: creatureName(creatureOf(aid)), kills };
    }
  }

  const yourLosses = lossesFor(H);
  const yourStacks = stacksFor(H);
  const totalYouLost = yourLosses.reduce((n, e) => n + e.lost, 0);
  const totalYouStarted = yourStacks.reduce((n, s) => n + s.started, 0);
  const won = !!meta.won;

  // How your shooters fared — the raw material for the "screen them" advisory.
  let shooterStarted = 0, shooterLost = 0;
  for (const s of yourStacks) {
    if (isShooter(s.creature)) { shooterStarted += s.started; shooterLost += s.lost; }
  }

  return {
    rounds,
    won,
    humanSide: H,
    xp: meta.xp || 0,
    yourLosses,
    enemyLosses: lossesFor(E),
    yourStacks,
    enemyStacks: stacksFor(E),
    damageDealt: dmgBySide[H],
    damageTaken: dmgBySide[E],
    biggestThreat,
    totalYouLost,
    totalYouStarted,
    verdict: verdictLine(won, totalYouLost, biggestThreat),
    advice: advisoryLine({ won, totalYouLost, totalYouStarted, threat: biggestThreat, shooterStarted, shooterLost }),
  };
}

/** The emotional core: what to take away, phrased as a consequence. */
function verdictLine(won, totalYouLost, threat) {
  if (won && totalYouLost === 0) {
    return 'Flawless victory — not a single soul lost. Whatever you did, do it again.';
  }
  if (won) {
    return threat && threat.kills > 0
      ? `Costly win. The enemy ${threat.name} alone cut down ${threat.kills} of your troops — ` +
        'shield them, out-range them, or kill them first next time.'
      : `Victory, but ${totalYouLost} of your own fell. A cleaner line was there to be found.`;
  }
  return threat && threat.kills > 0
    ? `Routed. The ${threat.name} were your undoing (${threat.kills} slain). ` +
      'Strike them first, bring a counter, or add weight before you try again.'
    : 'Routed. Rebuild the company and rethink the opening.';
}

/** One actionable tip, chosen from the data by severity of the mistake. */
function advisoryLine({ won, totalYouLost, totalYouStarted, threat, shooterStarted, shooterLost }) {
  // Lost every shooter — a specific, correctable positioning error.
  if (shooterStarted > 0 && shooterLost >= shooterStarted) {
    return 'You lost every shooter. Screen them behind your line or block the lanes to them — ranged fire is wasted once they are dead.';
  }
  // One enemy stack accounted for most of your dead — concentrate fire on it.
  if (threat && totalYouLost > 0 && threat.kills * 2 >= totalYouLost) {
    return `The enemy ${threat.name} accounted for most of your losses (${threat.kills}). Focus it down first, or stay out of its reach.`;
  }
  // Won with plenty to spare — you likely over-committed for this fight.
  if (won && totalYouStarted > 0 && totalYouLost <= Math.floor(totalYouStarted * 0.1)) {
    return 'You won with troops to spare. A smaller or cheaper army could likely have taken this fight — save the veterans for a harder one.';
  }
  if (won) {
    return 'A fair trade, but tighten the line: fewer exposed stacks and better focus fire keep more of your army standing.';
  }
  return 'Rethink the opening — protect your shooters, pick your engagements, and bring enough weight to break their strongest stack.';
}
