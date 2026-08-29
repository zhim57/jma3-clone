/**
 * CombatAI.js — Stack-level combat brain + instant auto-resolver.
 *
 * Used for: (a) the enemy side when the human fights, (b) neutral monster
 * stacks, and (c) silent AI-vs-neutral / AI-vs-AI battles via autoResolve.
 *
 * Every decision — stack actions AND hero spellcasting — is priced in ONE
 * currency: POWER points expected to be destroyed minus power points
 * expected to be lost. Damage is estimated deterministically (average dice,
 * the engine's real attack-vs-defense scaling, hero skills, shooter
 * penalties), converted to whole-creature kills plus a discounted sliver for
 * chip damage, and everything from a melee trade to a Blind competes on that
 * scale. No rng is consulted here in Classic or any auto-resolve, so a battle
 * replays identically from the same state — the sole exception is the opt-in
 * Cunning AI (#12), which draws off the seeded battle rng ONLY when an AI side
 * faces a human (battle.humanSide >= 0), for both its stack moves and its hero
 * spellcasting; see cunningPick / maybeCastAISpell.
 */

import { CONFIG } from '../../config.js';
import { CREATURES } from '../../data/creatures.js';
import { creaturePower, armyPower } from '../power.js';
import { SPELLS, SCHOOL_SKILL } from '../../data/spells.js';
import { heroStat } from '../heroUtils.js';
import { skillValue } from '../../data/skills.js';
import { spellCost, isMassCast, spellEffects, spellDuration, durationAtLevel, schoolLevel } from '../magic.js';
import {
  beginTurn, act, castSpell, canCast, canShoot, reachableHexes,
  hexNeighbors, hexDistance, unitAt, battleResult, ability,
  unitAttackStat, unitDefenseStat, hasFlag, createBattle, normStance, PHYS_ENGINE,
} from './CombatEngine.js';
import { expectedPhysicalDamage } from './physicalDamage.js';
import { Rng } from '../rng.js';

// ---------------------------------------------------------------------------
// Tuning knobs — all scores are in POWER points (src/core/power.js).
// ---------------------------------------------------------------------------
const CHIP_WEIGHT = 0.3;          // partial damage counts, but never out-bids a real kill
const SHOOTER_BONUS = 1.5;        // stacks that shoot back get hunted first
const REPOSITION_DISCOUNT = 0.5;  // a shot next turn is worth half a shot now
const EFFECT_ROUNDS = 2;          // rounds a lasting buff/debuff is expected to matter
const EFFECT_ROUNDS_MAX = 4;      // ...and the most any duration can be worth (a battle is finite)
const BLIND_WORTH = 1.5;          // actions Blind steals (it breaks on the first hit)
const BLIND_WAKE_PENALTY = 0.5;   // share of the stolen turns we forfeit by waking a blinded stack
const SPEED_WORTH = 0.08;         // strike-value share per speed point, for stacks that fight up close
const SPEED_WORTH_RANGED = 0.01;  // shooters barely care about speed
const CAST_FLOOR_MIN = 10;        // never cast for less than this...
const CAST_FLOOR_RATE = 0.02;     // ...or less than 2% of the enemy's total value (mana is precious)
const DIST_EPS = 1e-3;            // distance only ever breaks value ties
const TIE_EPS = 1e-9;

// ---------------------------------------------------------------------------
// The value currency
// ---------------------------------------------------------------------------

/**
 * THE CURRENCY IS POWER, NOT PRICE (src/core/power.js). Every score in this file
 * is "how much of the enemy did that remove, against how much of us it costs" —
 * a question about fighting strength, which price answers only where the two
 * agree. They do not: an Archer is priced well above what it does, so a marksman
 * offered 500 Peasants or 30 Archers went for the Peasants on the strength of the
 * sticker, when the Archers both remove more and shoot back.
 */
function aiVal(battle, unit) {
  // PER MODEL, because power is. The physical model reaches its own verdict about
  // which creatures are good — an Iron Golem is nearly four times its price there
  // and a Cyclops about half — so an AI that ranked targets off the classic table
  // in a physical-model battle would be scoring the fight it is NOT having.
  return creaturePower(unit.creature, !!battle?.features?.physicalDamage) || 1;
}

function stackValue(battle, unit) {
  return aiVal(battle, unit) * unit.count;
}

/** Remaining HP pool, matching the engine's applyDamage bookkeeping. */
function hpPool(unit) {
  return unit.alive ? (unit.count - 1) * unit.maxHp + unit.hp : 0;
}

/** Whole creatures `dmg` HP would kill (engine-exact ceil arithmetic). */
function expectedKills(unit, dmg) {
  const pool = hpPool(unit);
  if (pool <= 0 || dmg <= 0) return 0;
  if (dmg >= pool) return unit.count;
  return unit.count - Math.ceil((pool - dmg) / unit.maxHp);
}

/**
 * Value (power points) that `dmg` HP removes from `unit`: whole kills at
 * full price plus a discounted sliver for leftover chip damage, so partial
 * damage sorts sensibly but never out-values an actual kill.
 */
function damageValue(battle, unit, dmg) {
  const pool = hpPool(unit);
  if (pool <= 0 || dmg <= 0) return 0;
  const v = aiVal(battle, unit);
  if (dmg >= pool) return unit.count * v;
  const kills = expectedKills(unit, dmg);
  const chip = Math.max(0, dmg - kills * unit.maxHp) / unit.maxHp;
  return kills * v + chip * CHIP_WEIGHT * v;
}

// ---------------------------------------------------------------------------
// Deterministic damage estimator — mirrors the engine's rollDamage minus rng
// ---------------------------------------------------------------------------

/**
 * Expected damage of one strike, using the average roll and the engine's real
 * formula (attack-vs-defense scaling, hero skills, shooter penalties).
 * `opts` lets spell evaluation ask "what if" without mutating anyone:
 *   attackDelta / defenseDelta — stat swings under consideration
 *   forceMax / forceMin        — Bless / Curse dice pinning
 *   fromX / fromY              — shoot from a hypothetical hex (range penalty)
 */
function expectedDamage(battle, attacker, defender, kind, opts = {}) {
  // Under the physical model the AI must score with the physical model. This is
  // not a refinement — the two disagree in SIGN about where to stand. The
  // classic body below charges a flat x0.5 past RANGED_FULL_RANGE and nothing at
  // all inside it, so closing from 9 hexes to 4 is worth exactly zero and a
  // shooter has no reason to move; the physical model's group grows as an area,
  // so those same five hexes are most of the damage. An AI scoring physical
  // battles with the classic formula stands still and shoots badly.
  //
  // Same `opts` contract, and the SAME arithmetic the engine rolls — not a
  // second copy of it (see physicalDamage.js `blow`).
  if (battle.features?.physicalDamage) {
    return expectedPhysicalDamage(battle, attacker, defender, kind, PHYS_ENGINE, opts);
  }
  const c = CREATURES[attacker.creature];
  const [dmin, dmax] = c.damage;
  let per;
  if (opts.forceMax || (!opts.forceMin && hasFlag(attacker, 'blessed'))) per = dmax;
  else if (opts.forceMin || hasFlag(attacker, 'cursed')) per = dmin;
  else per = (dmin + dmax) / 2;
  let dmg = per * attacker.count;

  const A = Math.max(0, unitAttackStat(battle, attacker) + (opts.attackDelta || 0));
  let D = Math.max(0, unitDefenseStat(battle, defender) + (opts.defenseDelta || 0));
  // Behemoths rend through armour (mirror the engine's ignoreDefense).
  if (ability(attacker, 'ignoreDefense')) D = Math.round(D * (1 - (c.defenseIgnore ?? 0.4)));
  if (A >= D) {
    dmg *= 1 + Math.min(CONFIG.ATTACK_BONUS_CAP, (A - D) * CONFIG.ATTACK_BONUS_PER_POINT);
  } else {
    dmg *= 1 - Math.min(CONFIG.DEFENSE_REDUCTION_CAP, (D - A) * CONFIG.DEFENSE_REDUCTION_PER_POINT);
  }

  const hero = battle.sides[attacker.side].hero;
  if (hero) dmg *= 1 + skillValue(hero, kind === 'ranged' ? 'archery' : 'offense');
  const defHero = battle.sides[defender.side].hero;
  if (defHero) dmg *= 1 - skillValue(defHero, 'armorer');

  if (kind === 'ranged') {
    const fx = opts.fromX ?? attacker.x;
    const fy = opts.fromY ?? attacker.y;
    if (hexDistance(fx, fy, defender.x, defender.y) > CONFIG.RANGED_FULL_RANGE) dmg *= 0.5;
  } else if (c.reach === 'ranged' && !ability(attacker, 'noMeleePenalty')) {
    dmg *= 0.5; // shooter forced into melee
  }
  return Math.max(1, dmg);
}

/** Hits one attack action lands (Crusader double strike, Marksman double shot). */
function strikesPer(unit, kind) {
  if (kind === 'ranged') return ability(unit, 'shootsTwice') && unit.shots >= 2 ? 2 : 1;
  return ability(unit, 'doubleAttack') ? 2 : 1;
}

/** A stack that can still rain arrows is worth silencing early. */
function isThreatShooter(unit) {
  return CREATURES[unit.creature].reach === 'ranged' && unit.shots > 0;
}

/**
 * Value of the best single attack `unit` could land on the opposing side —
 * the "how scary is this stack" yardstick that puts buffs, debuffs and Blind
 * on the same currency as raw damage. Ignores positioning on purpose.
 */
function bestStrikeValue(battle, unit, opts = {}) {
  const kind = isThreatShooter(unit) ? 'ranged' : 'melee';
  let best = 0;
  for (const foe of battle.units) {
    if (!foe.alive || foe.side === unit.side) continue;
    const dmg = expectedDamage(battle, unit, foe, kind, opts) * strikesPer(unit, kind);
    const v = damageValue(battle, foe, dmg);
    if (v > best) best = v;
  }
  return best;
}

/**
 * Value the scariest opposing strike removes from `unit` — the yardstick for
 * Shield / Stone Skin (raise defense on ours) and Disrupting Ray (drop it on
 * theirs), via opts.defenseDelta.
 */
function threatAgainst(battle, unit, opts = {}) {
  let worst = 0;
  for (const foe of battle.units) {
    if (!foe.alive || foe.side === unit.side) continue;
    const kind = isThreatShooter(foe) ? 'ranged' : 'melee';
    const dmg = expectedDamage(battle, foe, unit, kind, opts) * strikesPer(foe, kind);
    const v = damageValue(battle, unit, dmg);
    if (v > worst) worst = v;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Stack actions
// ---------------------------------------------------------------------------

/** Net value of a ranged attack on `target` (splash included for Magogs).
 *  `terms` (optional) is filled with the score's decomposition — the telemetry
 *  needs to name WHICH term is wrong, not just that the total was. */
function shootScore(battle, unit, target, terms = null) {
  const dmg = expectedDamage(battle, unit, target, 'ranged') * strikesPer(unit, 'ranged');
  let gain = damageValue(battle, target, dmg);
  if (terms) { terms.dmg = dmg; terms.raw = gain; }
  if (isThreatShooter(target)) { gain *= SHOOTER_BONUS; if (terms) terms.shooterBonus = SHOOTER_BONUS; }
  // Area blast splashes everything around the target — our own stacks too.
  if (ability(unit, 'areaBlast')) {
    for (const [nx, ny] of hexNeighbors(target.x, target.y)) {
      const splash = unitAt(battle, nx, ny);
      if (!splash || splash.id === unit.id) continue;
      const v = damageValue(battle, splash, expectedDamage(battle, unit, splash, 'ranged') * 0.5);
      gain += splash.side === unit.side ? -v : v;
      if (terms) terms.splash = (terms.splash || 0) + (splash.side === unit.side ? -v : v);
    }
  }
  if (terms) terms.total = gain;
  return gain;
}

/**
 * Net value of a melee attack: value removed from the target MINUS the value
 * its counter-attack removes from us. Killing outright silences the
 * retaliation entirely, which is exactly why lethal hits beat bigger chip.
 *
 * `fromX/fromY` is the hex the strike lands FROM (the approach destination) —
 * it matters for attacksAround (Hydra), whose real blow savages EVERY enemy
 * adjacent to that hex with no retaliation at all (mirror of the engine's
 * attacksAround branch). Omitted → the unit's current hex.
 */
function meleeScore(battle, unit, target, fromX = unit.x, fromY = unit.y, terms = null) {
  const one = expectedDamage(battle, unit, target, 'melee');
  const total = one * strikesPer(unit, 'melee');
  let gain = damageValue(battle, target, total);
  if (terms) { terms.dmg = total; terms.raw = gain; }
  if (isThreatShooter(target)) { gain *= SHOOTER_BONUS; if (terms) terms.shooterBonus = SHOOTER_BONUS; }

  if (ability(unit, 'attacksAround')) {
    // Hydra: add every OTHER adjacent enemy hit by the same blow, and return
    // without any retaliation term — the engine lets nobody strike back.
    for (const [nx, ny] of hexNeighbors(fromX, fromY)) {
      const other = unitAt(battle, nx, ny);
      if (!other || !other.alive || other.side === unit.side || other.id === target.id) continue;
      if (ability(other, 'untargetable')) continue;
      const dmg = expectedDamage(battle, unit, other, 'melee') * strikesPer(unit, 'melee');
      let v = damageValue(battle, other, dmg);
      if (isThreatShooter(other)) v *= SHOOTER_BONUS;
      gain += v;
      if (terms) terms.around = (terms.around || 0) + v;
    }
    if (terms) { terms.total = gain; terms.noRetaliation = true; }
    return gain;
  }

  let lost = 0;
  // The engine retaliates after the FIRST strike, from whoever survived it.
  const survivors = target.count - expectedKills(target, one);
  const blinded = hasFlag(target, 'blinded');
  const retaliates = survivors > 0 && !blinded &&
    !ability(unit, 'noEnemyRetaliation') &&
    (!target.retaliated || ability(target, 'unlimitedRetaliation'));
  if (retaliates) {
    const retal = expectedDamage(battle, target, unit, 'retaliation') * (survivors / target.count);
    const v = damageValue(battle, unit, retal);
    lost += v;
    if (terms) terms.retaliation = -v;
  }
  if (survivors > 0 && ability(target, 'fireShield')) {
    const v = damageValue(battle, unit, Math.max(1, total * 0.2));
    lost += v;
    if (terms) terms.fireShield = -v;
  }
  if (blinded && survivors > 0) {
    // Waking a blinded stack hands part of its stolen turns back.
    const v = bestStrikeValue(battle, target) * (survivors / target.count) * BLIND_WAKE_PENALTY;
    lost += v;
    if (terms) terms.wakeBlinded = -v;
  }
  if (terms) { terms.survivors = survivors; terms.total = gain - lost; }
  return gain - lost;
}

/**
 * A blocked shooter looks for a hex it could actually shoot from next turn
 * (no adjacent enemy), worth a discounted shot — so it slips out of melee
 * instead of trading its bow away, but a genuinely good strike still wins.
 */
function repositionOption(battle, unit, enemies, reach) {
  let best = null;
  for (const h of reach) {
    const stillBlocked = hexNeighbors(h.x, h.y).some(([x, y]) => {
      const u = unitAt(battle, x, y);
      return u && u.side !== unit.side;
    });
    if (stillBlocked) continue;
    let shot = 0;
    for (const enemy of enemies) {
      const dmg = expectedDamage(battle, unit, enemy, 'ranged', { fromX: h.x, fromY: h.y })
        * strikesPer(unit, 'ranged');
      let v = damageValue(battle, enemy, dmg);
      if (isThreatShooter(enemy)) v *= SHOOTER_BONUS;
      if (v > shot) shot = v;
    }
    if (shot <= 0) continue;
    const score = shot * REPOSITION_DISCOUNT - hexDistance(unit.x, unit.y, h.x, h.y) * DIST_EPS;
    if (!best || score > best.score) {
      best = {
        score,
        action: { type: 'move', x: h.x, y: h.y },
        label: `reposition to ${h.x},${h.y} to shoot`,
        terms: { shot, discount: REPOSITION_DISCOUNT, total: score },
      };
    }
  }
  return best;
}

/**
 * War machines are on rails — they never move, charge or retaliate. Every branch
 * returns an action the engine will actually apply (shoot / firstAid / defend),
 * so the immobile machine always advances the initiative queue (no soft-lock).
 *   Catapult → batter the gate (fastest breach), else the nearest standing wall.
 *   Ballista / Arrow Tower → shell the enemy stack it hurts most.
 *   First Aid Tent → mend the most-wounded friendly (non-machine) stack.
 *   Ammo Cart → dig in (its mere presence already frees the side's shooters).
 */
function machineAction(battle, unit) {
  if (unit.machine === 'catapult') {
    // Checked before the shooter branch: a Catapult is a ranged unit too, but it
    // shells walls, never stacks. Gate first (opens the central passage); once
    // the gate is down, batter the standing segment nearest the gate row so the
    // breach lands where units cross — the old reduce() took the bottom-most
    // segment, contradicting its own comment.
    const walls = (battle.walls || []).filter((w) => w.alive);
    if (walls.length) {
      const gate = walls.find((w) => w.kind === 'gate');
      const gateRow = CONFIG.SIEGE.GATE_ROW;
      const target = gate || walls.reduce((a, b) =>
        (Math.abs(b.y - gateRow) < Math.abs(a.y - gateRow) ? b : a));
      return { type: 'batter', wallId: target.id };
    }
    return { type: 'defend' };
  }
  if ((unit.machine === 'ballista' || unit.machine === 'arrowTower') && canShoot(battle, unit)) {
    let best = null, bestScore = -Infinity;
    for (const foe of battle.units) {
      if (!foe.alive || foe.side === unit.side || ability(foe, 'untargetable')) continue;
      const s = shootScore(battle, unit, foe);
      if (s > bestScore) { bestScore = s; best = foe; }
    }
    if (best) return { type: 'shoot', targetId: best.id };
  }
  if (unit.machine === 'firstAidTent') {
    // The tent tops up only the LIVE top creature (it never resurrects), so rank
    // by that creature's wound — NOT the whole-pool deficit, which counts dead
    // creatures the tent can't restore and would send it to "heal" a stack whose
    // top creature is already full, mending 0 HP forever.
    let best = null, bestWound = 0;
    for (const ally of battle.units) {
      if (!ally.alive || ally.side !== unit.side || ally.machine) continue;
      const wound = ally.maxHp - ally.hp;
      if (wound > bestWound) { bestWound = wound; best = ally; }
    }
    if (best) return { type: 'firstAid', targetId: best.id };
  }
  return { type: 'defend' };
}

/** The value the moat would bite out of `unit` if it ENDED its move on (x,y). */
function moatCost(battle, unit, x, y) {
  if (!battle.moat || unit.machine) return 0;
  if (!battle.moat.some((m) => m.x === x && m.y === y)) return 0;
  return damageValue(battle, unit, Math.min(CONFIG.SIEGE.moatDamage, hpPool(unit)));
}

/** Pick the best action for `unit`. Never returns null. */
/**
 * Cunning AI (#12): does side `side` mix its choices in this battle? Only an
 * AI side facing the human — off in Classic, in AI-vs-AI, and in every
 * auto-resolve/preview (battle.humanSide is -1 there). Gates BOTH the stack
 * moves (cunningPick) and the hero's spellcasting (see maybeCastAISpell).
 */
export function cunningSideActive(battle, side) {
  return !!battle.features?.cunningAI
    && battle.humanSide >= 0
    && side !== battle.humanSide;
}

/** cunningSideActive for an acting stack. */
export function cunningActive(battle, unit) {
  return cunningSideActive(battle, unit.side);
}

/**
 * The cunning sampler: softmax over the NEAR-best options (score >=
 * CUNNING_NEAR × best, and positive), drawn off `rng` — so a memorised
 * single-exploit stops auto-winning while dominated choices stay out. Shared
 * by stack moves and hero spellcasting; callers gate + roll CUNNING_EPSILON.
 */
function softmaxNearBest(rng, options, best) {
  const floor = best.score * CONFIG.CUNNING_NEAR;
  const cands = options.filter((o) => o.score > 0 && o.score >= floor);
  if (cands.length <= 1) return best;
  const T = Math.max(1e-6, best.score * CONFIG.CUNNING_TEMP);
  const weights = cands.map((o) => Math.exp((o.score - best.score) / T));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.random() * total;
  for (let i = 0; i < cands.length; i++) { r -= weights[i]; if (r <= 0) return cands[i]; }
  return best;
}

/**
 * Cunning AI's move selection: usually the strict argmax `best`, but with
 * probability CUNNING_EPSILON it softmax-samples among the near-best options.
 * Returns `best` unchanged whenever cunning is inactive (no rng drawn then).
 */
export function cunningPick(battle, unit, options, best) {
  if (!cunningActive(battle, unit) || !battle.rng) return best;
  if (!battle.rng.chance(CONFIG.CUNNING_EPSILON)) return best;
  return softmaxNearBest(battle.rng, options, best);
}

/**
 * Every action this stack could take right now, each priced, each carrying the
 * decomposition of its own score.
 *
 * Split out of chooseAction so the SAME candidate set can be built for a board a
 * human is about to act on (see ai/battleTelemetry.recordHumanAction). Choosing
 * and enumerating were one function, which meant the AI's opinion of a human's
 * move could not be asked for without also taking the move — and that opinion is
 * the measurement the whole log is built around.
 *
 * Pure: no rng, no mutation, safe to call at any time on any board.
 * Returns { options, engaged, enemies, shooter, reach }.
 */
export function candidateActions(battle, unit) {
  const enemies = battle.units.filter((u) =>
    u.alive && u.side !== unit.side && !ability(u, 'untargetable'));
  const options = []; // { score, action, label, terms }
  let engaged = null; // best strike available from where we already stand
  if (!enemies.length) return { options, engaged, enemies, shooter: false, reach: [] };

  // Archangel gift of life, priced on the same scale as everything else:
  // mending the line is chosen only when the revived value beats the best
  // attack this archangel could deliver instead.
  if (ability(unit, 'resurrectAllies') && !unit.resurrectUsed) {
    const healPool = 100 * unit.count; // engine heals 100 HP per archangel
    let bestAlly = null, bestGain = 0;
    for (const ally of battle.units) {
      if (ally.side !== unit.side || ally.id === unit.id) continue;
      // A corpse whose hex a live stack has since claimed cannot re-form there
      // (one hex, one stack) — the engine refuses the action, so pricing it
      // would burn the archangel's turn on a guaranteed no-op.
      if (!ally.alive && unitAt(battle, ally.x, ally.y)) continue;
      const lost = ally.startCount - ally.count;
      if (lost <= 0) continue;
      const revivable = Math.min(lost, Math.floor(healPool / ally.maxHp));
      const gain = revivable * aiVal(battle, ally);
      if (gain > bestGain) { bestGain = gain; bestAlly = ally; }
    }
    if (bestAlly) {
      options.push({
        score: bestGain,
        action: { type: 'resurrect', targetId: bestAlly.id },
        label: `resurrect ${bestAlly.creature}`,
        terms: { revivedValue: bestGain },
      });
    }
  }

  const shooter = isThreatShooter(unit);
  let outReach = [];

  if (canShoot(battle, unit)) {
    // Shooting costs no position and draws no retaliation — melee never beats
    // it for a stack that can loose arrows right now.
    for (const enemy of enemies) {
      const terms = {};
      options.push({
        score: shootScore(battle, unit, enemy, terms),
        action: { type: 'shoot', targetId: enemy.id },
        label: `shoot ${enemy.creature}#${enemy.id}`,
        terms,
      });
    }
  } else {
    // Melee: every enemy, from every free hex we could strike it this turn.
    const reach = reachableHexes(battle, unit);
    const reachKey = new Set(reach.map((h) => h.y * 100 + h.x));
    reachKey.add(unit.y * 100 + unit.x); // attacking from where we stand
    // A Hydra's blow depends on WHERE it lands (every adjacent enemy is hit),
    // so its score is per-approach-hex; everyone else prices the target once.
    const positional = ability(unit, 'attacksAround');
    for (const enemy of enemies) {
      const baseTerms = {};
      const baseNet = positional ? 0 : meleeScore(battle, unit, enemy, unit.x, unit.y, baseTerms);
      for (const [nx, ny] of hexNeighbors(enemy.x, enemy.y)) {
        const occupied = unitAt(battle, nx, ny);
        if (occupied && occupied.id !== unit.id) continue;
        if (!reachKey.has(ny * 100 + nx)) continue;
        const terms = positional ? {} : { ...baseTerms };
        const net = positional ? meleeScore(battle, unit, enemy, nx, ny, terms) : baseNet;
        const moat = moatCost(battle, unit, nx, ny);
        terms.approach = -hexDistance(unit.x, unit.y, nx, ny) * DIST_EPS;
        if (moat) terms.moat = -moat;
        const scored = {
          score: net
            - hexDistance(unit.x, unit.y, nx, ny) * DIST_EPS // near hex breaks ties
            - moat,                                          // the moat bites move-enders
          action: { type: 'attack', targetId: enemy.id, x: nx, y: ny },
          label: `attack ${enemy.creature}#${enemy.id} from ${nx},${ny}`,
          terms,
        };
        options.push(scored);
        // Blinded neighbors pose no threat; standing pat doesn't donate hits.
        if (nx === unit.x && ny === unit.y && !hasFlag(enemy, 'blinded') &&
            (!engaged || scored.score > engaged.score)) {
          engaged = scored;
        }
      }
    }
    // A shooter that is blocked keeps its bow relevant instead of brawling.
    if (shooter) {
      const spot = repositionOption(battle, unit, enemies, reach);
      if (spot) options.push(spot);
    }
    outReach = reach;
  }
  return { options, engaged, enemies, shooter, reach: outReach };
}

/** Just the priced list — what an outside caller (the telemetry) wants. */
export function scoredOptionsFor(battle, unit) {
  if (!unit || unit.machine) return [];
  return candidateActions(battle, unit).options;
}

export function chooseAction(battle, unit) {
  if (unit.machine) return machineAction(battle, unit);
  const { options, engaged, enemies, shooter } = candidateActions(battle, unit);
  if (!enemies.length) return { type: 'defend' };

  // Take the best option that actually gains value. Cunning AI (#12) may instead
  // draw from the near-best set when facing a human, so the same board no longer
  // resolves identically (see cunningPick — a no-op in Classic/auto-resolve).
  let best = null;
  for (const o of options) if (!best || o.score > best.score) best = o;
  if (best && best.score > 0) {
    const picked = cunningPick(battle, unit, options, best);
    logUnitDecision(battle, unit, options, picked);
    return picked.action;
  }

  // No trade gains value outright. If an enemy already stands at our side,
  // swing anyway — declining contact just donates free hits. But never CHARGE
  // into a losing trade (that was the old blunder)...
  if (engaged) {
    logUnitDecision(battle, unit, options, engaged, 'engaged-swing-anyway');
    return engaged.action;
  }

  // ...unless the enemy is shooting us while we hold: soaking arrows for free
  // is worse than the least-bad charge.
  const underFire = enemies.some((e) => isThreatShooter(e) && canShoot(battle, e));
  if (underFire && best && best.action.type === 'attack') {
    logUnitDecision(battle, unit, options, best, 'least-bad-charge-under-fire');
    return best.action;
  }

  // Walkers close the distance so the fight can happen at all; shooters with
  // ammo hold their ground — their value is exactly where they stand.
  if (!shooter) {
    const nearest = enemies.reduce((a, b) =>
      (hexDistance(unit.x, unit.y, a.x, a.y) <= hexDistance(unit.x, unit.y, b.x, b.y) ? a : b));
    // Prefer closing ground WITHOUT ending the move in the moat (crossing
    // through is free — only the end tile bites). Take a moat end-tile only
    // when it is the sole way to make progress: the bite is then the price of
    // the assault, not a self-inflicted wound.
    const dHere = hexDistance(unit.x, unit.y, nearest.x, nearest.y);
    let move = null, moveD = dHere, moatMove = null, moatD = dHere;
    for (const h of reachableHexes(battle, unit)) {
      const d = hexDistance(h.x, h.y, nearest.x, nearest.y);
      if (moatCost(battle, unit, h.x, h.y) > 0) {
        if (d < moatD) { moatD = d; moatMove = h; }
      } else if (d < moveD) {
        moveD = d; move = h;
      }
    }
    if (!move && moatMove) move = moatMove;
    if (move) {
      logUnitDecision(battle, unit, options, null, 'close-the-distance',
        { type: 'move', x: move.x, y: move.y });
      return { type: 'move', x: move.x, y: move.y };
    }
  }

  // Nothing productive: hold ground. Wait once to let allies act first this
  // round, then dig in on defense.
  // These two are the flattest part of the wheel and the reason `fallback` is a
  // first-class field: a turn that ends in wait/defend is one where the whole
  // candidate set was worth nothing, and the aggregate counts them per channel.
  if (!unit.hasWaitedFlag) {
    logUnitDecision(battle, unit, options, null, 'nothing-scored-wait', { type: 'wait' });
    return { type: 'wait' };
  }
  logUnitDecision(battle, unit, options, null, 'nothing-scored-defend', { type: 'defend' });
  return { type: 'defend' };
}

/**
 * Emit one unit-action decision: every option that was on the table, its score
 * decomposed into terms, and which one was taken.
 *
 * `fallback` names a path that did NOT take the argmax — the hard-coded
 * escapes at the bottom of chooseAction. Those are exactly the corners: a turn
 * spent on `wait` is a turn where nothing in the candidate set was worth doing,
 * and whether that is right or a missing candidate is the question the log
 * exists to answer.
 */
function logUnitDecision(battle, unit, options, picked, fallback = null, forcedAction = null) {
  if (!battle.telemetry) return; // recording off, or a battle nobody asked about
  const candidates = options.map((o) => ({
    label: o.label || o.action?.type || 'option',
    score: o.score,
    terms: o.terms,
  }));
  let chosenIndex = picked ? options.indexOf(picked) : -1;
  if (chosenIndex < 0 && forcedAction) {
    // A fallback action that was never a scored candidate. Record it as one, at
    // score 0, so the file never contains a `chosen` that is not in the list.
    candidates.push({ label: `${fallback}: ${forcedAction.type}`, score: 0, terms: {} });
    chosenIndex = candidates.length - 1;
  }
  battle.telemetry.decision({
    phase: 'combat',
    channel: 'unit',
    actor: battle.telemetry.ownerOf ? battle.telemetry.ownerOf(unit.side) : unit.side,
    human: battle.telemetry.humanSide === unit.side,
    unit: `${unit.creature}#${unit.id}`,
    subject: { side: unit.side, x: unit.x, y: unit.y, count: unit.count, hp: unit.hp, round: battle.round },
    candidates,
    chosenIndex: Math.max(0, chosenIndex),
    // The sampler's OWN numbers, so a logged probability is the one it used —
    // softmaxNearBest keys both the floor and the temperature off the best score.
    ...(cunningActive(battle, unit) && candidates.length ? (() => {
      const bestScore = Math.max(...candidates.map((c) => c.score));
      return {
        temperature: Math.max(1e-6, bestScore * CONFIG.CUNNING_TEMP),
        nearFloor: bestScore * CONFIG.CUNNING_NEAR,
      };
    })() : {}),
    fallback,
  });
}

// ---------------------------------------------------------------------------
// Hero spellcasting
// ---------------------------------------------------------------------------

/** Mirror of the engine's chain-lightning leap: nearest un-hit stack, half damage per hop. */
function chainNet(battle, first, base, leaps, signed) {
  let amount = base, net = 0, current = first;
  const seen = new Set();
  for (let i = 0; i <= leaps && current; i++) {
    net += signed(current, amount);
    seen.add(current.id);
    amount /= 2;
    let next = null, bestD = Infinity;
    for (const u of battle.units) {
      if (!u.alive || seen.has(u.id)) continue;
      const d = hexDistance(current.x, current.y, u.x, u.y);
      if (d < bestD) { bestD = d; next = u; }
    }
    current = next;
  }
  return net;
}

/**
 * One buff/debuff cast valued on the damage currency. Symmetric on purpose:
 * a stat swing is worth the |change| it makes to the stack's best strike (or
 * to the best strike AGAINST it) — whether we grant it to a friend or deny it
 * to a foe. Lasting effects are credited EFFECT_ROUNDS rounds of benefit;
 * Blind is one-shot (the first hit breaks it) and priced as stolen actions.
 *
 * Takes the RESOLVED effects rather than the spell, because a spell no longer
 * has one magnitude: Advanced Air Haste is +5 speed where the catalog says +3
 * (spell.byLevel). Pricing the catalog number would have the AI value its own
 * mastery at the unskilled rate — and, on the cleanse path, value stripping a
 * hex by a magnitude the enemy did not actually cast.
 *
 * `rounds` is how many rounds of benefit to credit. It defaults to the flat
 * EFFECT_ROUNDS this file has always used, and callers scale it by how long the
 * cast will ACTUALLY last (spell.durationByLevel): an Expert Shield that holds
 * for eight rounds is not worth what a three-round one is, and before the
 * durations differed per spell there was nothing to notice.
 */
function effectValue(battle, unit, fx, rounds = EFFECT_ROUNDS) {
  if (fx.blinded) return bestStrikeValue(battle, unit) * BLIND_WORTH;

  const base = bestStrikeValue(battle, unit);
  let perRound = 0;
  if (fx.blessed) perRound += bestStrikeValue(battle, unit, { forceMax: true }) - base;
  if (fx.cursed) perRound += base - bestStrikeValue(battle, unit, { forceMin: true });
  if (fx.attack) {
    perRound += Math.abs(bestStrikeValue(battle, unit, { attackDelta: fx.attack }) - base);
  }
  if (fx.defense) {
    perRound += Math.abs(
      threatAgainst(battle, unit) - threatAgainst(battle, unit, { defenseDelta: fx.defense }));
  }
  if (fx.speed) {
    // Mobility only pays for stacks that must close the distance to fight.
    const mobile = !isThreatShooter(unit);
    perRound += Math.abs(fx.speed) * base * (mobile ? SPEED_WORTH : SPEED_WORTH_RANGED);
  }
  // Morale/luck swings are probabilistic extra (or lost) strikes. The undead and
  // mindless have engine-locked 0 morale, so a morale swing on them is worth
  // nothing — don't pay a spell for it (Sorrow on Dread Knights every battle).
  const uc = CREATURES[unit.creature];
  if (fx.morale && !(uc?.undead || uc?.mindless)) {
    perRound += Math.abs(fx.morale) * CONFIG.MORALE_CHANCE_PER_POINT * base;
  }
  if (fx.luck) perRound += Math.abs(fx.luck) * CONFIG.LUCK_CHANCE_PER_POINT * base;
  return perRound * rounds;
}

/**
 * Rounds of benefit to credit a cast that will last `lasts` base rounds, scaled
 * so an UNSKILLED cast is worth exactly EFFECT_ROUNDS — the number this file was
 * calibrated on. Mastery then moves the value in proportion rather than
 * re-tuning the constant.
 */
function creditedRounds(spellId, lasts) {
  const plain = durationAtLevel(spellId, 0) || 1;
  // Capped, because the credit is rounds of BENEFIT and a battle is finite —
  // these run seven or eight rounds, and a buff cast in one of them cannot pay
  // out over more of them than remain. Without the cap the AI valued an
  // eight-round Disrupting Ray at 5.3 rounds of benefit and spent its cast on it
  // instead of a nuke; measured, that was worth −4 points of win rate.
  return Math.min(EFFECT_ROUNDS_MAX, EFFECT_ROUNDS * (lasts / plain));
}

/** Restorable value of a heal/resurrect on `u` (engine-exact heal arithmetic). */
function healValue(battle, u, sp, amount) {
  const cur = hpPool(u);
  const cap = u.startCount * u.maxHp;
  if (sp.revives) {
    // Revive credits whole creatures returned to the fight.
    const target = Math.min(cap, cur + amount);
    if (target <= 0) return 0;
    const revived = Math.max(0, Math.ceil(target / u.maxHp) - (u.alive ? u.count : 0));
    return revived * aiVal(battle, u);
  }
  if (!u.alive) return 0;
  // A plain cure only tops up the stack's lead creature — chip value at best —
  // but cleansing hands back whatever the enemy's debuffs were denying us.
  const capTop = (u.count - 1) * u.maxHp + u.maxHp;
  const healed = Math.min(capTop, cur + amount) - cur;
  let v = (healed / u.maxHp) * aiVal(battle, u) * CHIP_WEIGHT;
  if (sp.cleanse) {
    for (const e of u.effects) {
      // What is ON the stack, at the magnitude it was actually cast with — and
      // for the rounds it has LEFT, which is what a cleanse actually buys back.
      if (SPELLS[e.spellId]?.kind === 'debuff') {
        v += effectValue(battle, u, e.effects || {}, creditedRounds(e.spellId, e.rounds));
      }
    }
  }
  return v;
}

/**
 * Will the enemy hero simply undo this effect on its next cast?
 *
 * The estimator had no model of counterplay: it priced a nine-round mass Slow at
 * nine rounds even against a hero holding mass Haste, which cancels it outright
 * (`unitSpeed` floors the SUM of effects, so +5 and −5 net to zero). Measured,
 * that made Earth's signature spell a NET LOSS — striking Slow from its book
 * won +10.7 points against Expert Air and +5.0 against Expert Water, because the
 * round spent on it was a round not spent on Implosion.
 *
 * The predicate is deliberately narrow, because "can answer" is not "will
 * answer": every hero in a test harness knows every spell, and one holding Haste
 * as a fourth-choice side spell will never cast it. So an answer counts only
 * when the opponent has **mastered the school it belongs to** — someone who
 * specialised in the counter will reach for it. A cleanse (Cure) answers any
 * hex; otherwise a spell answers when its own effects reverse at least half of
 * the stat swing, on the side the effect sits on.
 */
function answerable(battle, side, spellId, fx) {
  const sp = SPELLS[spellId];
  const foe = battle.sides[1 - side].hero;
  if (!foe || !sp || !foe.spells) return false;
  const hex = sp.kind === 'debuff';            // a hex sits on THEIR stacks…
  const wantKind = hex ? 'buff' : 'debuff';    // …so they answer it by buffing themselves
  const stats = Object.entries(fx).filter(([, v]) => typeof v === 'number' && v !== 0);
  for (const id of foe.spells) {
    const cand = SPELLS[id];
    if (!cand || cand.adventure) continue;
    if (!schoolLevel(foe, id)) continue;       // not their school: they will not reach for it
    if ((foe.mana || 0) < spellCost(foe, id)) continue;
    if (hex && cand.cleanse) return true;      // Cure strips any hex outright
    if (cand.kind !== wantKind) continue;
    const cfx = spellEffects(foe, id);
    for (const [stat, v] of stats) {
      const c = cfx[stat];
      if (typeof c === 'number' && Math.sign(c) === -Math.sign(v) && Math.abs(c) >= Math.abs(v) / 2) return true;
    }
  }
  return false;
}

/**
 * AI hero spellcasting. A hero may cast once per round, so EVERY affordable
 * spell is priced against EVERY sensible target on the one value currency —
 * real magnitude (power AND sorcery), golem resistance, every stack an area /
 * chain / field spell actually hits (friendly fire counts against us) — and
 * the single best option is cast, provided it clears a floor scaled to the
 * opposition (heroes hoard mana rather than blow it on trivia). Ties go to
 * the cheaper spell. Deterministic — no rng is consulted — except under the
 * opt-in Cunning AI (#12) facing a human, which sometimes swaps the argmax for
 * a near-best cast off the seeded battle rng (see the pick-mixing below).
 */
export function maybeCastAISpell(battle, side) {
  const s = battle.sides[side];
  if (!s.hero || s.castThisRound) return [];
  // War machines are never worth a spell — buffing a Ballista or healing a Tent
  // is a wasted cast, so they're not offered as targets.
  const enemies = battle.units.filter((u) => u.alive && u.side !== side && !u.machine);
  const friends = battle.units.filter((u) => u.alive && u.side === side && !u.machine);
  if (!enemies.length) return [];

  const castable = s.hero.spells.filter((id) => SPELLS[id] && canCast(battle, side, id));
  if (!castable.length) return [];

  const power = heroStat(s.hero, 'power');
  const sorcery = 1 + skillValue(s.hero, 'sorcery');
  // Magic-school mastery multiplies a spell's damage/healing on its OWN school,
  // exactly like the engine. The estimator used to omit it, under-pricing nukes
  // by up to 35% (Expert) — so the AI skipped casts that would actually win.
  const schoolMult = (sp) => {
    const sk = SCHOOL_SKILL[sp.school];
    return 1 + (sk ? skillValue(s.hero, sk) : 0);
  };

  // Engine-exact per-stack spell damage (sorcery × school-mastery multiplier,
  // golem resistance, Black Dragon immunity — magic never touches them, so never
  // spend a spell). `amount` already folds in the school multiplier (see below),
  // so hit() only adds the sorcery factor, matching the engine's single round.
  const hit = (u, amount) => {
    if (ability(u, 'spellImmune')) return 0;
    let dmg = Math.round(amount * sorcery);
    if (ability(u, 'spellResist50')) dmg = Math.round(dmg * 0.5);
    return dmg;
  };
  // Signed from OUR perspective: enemy losses are gains, friendly losses count
  // against us (area, chain and Armageddon happily burn our own).
  const signed = (u, amount) => (u.side === side ? -1 : 1) * damageValue(battle, u, hit(u, amount));

  const options = []; // { score, id, target, mana }
  const consider = (score, id, target, terms = null) =>
    options.push({
      score, id, target, mana: spellCost(s.hero, id),
      label: `${id}${target && target.unitId ? ` @${target.unitId}` : ''}`,
      terms: { ...(terms || {}), mana: spellCost(s.hero, id), school: SPELLS[id].school, kind: SPELLS[id].kind },
    });

  for (const id of castable) {
    const sp = SPELLS[id];
    if (sp.kind === 'damage') {
      const base = (sp.base + sp.perPower * power) * schoolMult(sp);
      if (sp.hitsAll) {
        // A field spell burns our own line too, so "nets positive in power" is
        // NOT the whole test. The engine scores mutual annihilation to the
        // DEFENDER (see finish()), so an Armageddon that kills the last stack on
        // both sides hands away a battle we were winning — measured, mastering
        // Fire took an Armageddon-only book from 96% to 76% while the HP totals
        // barely moved. Count who would still be standing, and refuse the cast
        // that leaves nobody on our side.
        let net = 0, weSurvive = 0, theySurvive = 0;
        for (const u of battle.units) {
          if (!u.alive) continue;
          net += signed(u, base);
          if (u.machine || hit(u, base) >= hpPool(u)) continue;  // dies to the blast
          if (u.side === side) weSurvive++; else theySurvive++;
        }
        // Wiping both sides is a WIN for the defender and a loss for the
        // attacker, so the same board is acceptable or not depending on which
        // seat we are in.
        const suicidal = weSurvive === 0 && !(theySurvive === 0 && side === 1);
        if (!suicidal) consider(net, id, {}, { weSurvive, theySurvive });
      } else if (sp.area) {
        for (const t of enemies) {
          let net = signed(t, base);
          for (const [nx, ny] of hexNeighbors(t.x, t.y)) {
            const u = unitAt(battle, nx, ny);
            if (u) net += signed(u, base);
          }
          consider(net, id, { unitId: t.id });
        }
      } else if (sp.chain) {
        for (const t of enemies) consider(chainNet(battle, t, base, sp.chain, signed), id, { unitId: t.id });
      } else {
        for (const t of enemies) consider(signed(t, base), id, { unitId: t.id });
      }
    } else if (sp.kind === 'buff' || sp.kind === 'debuff') {
      const pool = sp.kind === 'buff' ? friends : enemies;
      const fx = spellEffects(s.hero, id);   // the magnitude THIS hero would cast
      // …and how long it will actually HOLD. An opponent who has mastered the
      // answer spends their next cast undoing it, so credit one round rather
      // than the mastered duration — the spell is then priced as the tempo
      // trade it really is, not as the nine-round lockout it looks like.
      const rounds = answerable(battle, side, id, fx)
        ? 1 : creditedRounds(id, spellDuration(s.hero, id));
      const worth = (u) => {
        if (ability(u, 'spellImmune')) return null;              // magic can't touch them
        if (u.effects.some((e) => e.spellId === id)) return null; // already carries it
        return effectValue(battle, u, fx, rounds);
      };
      if (isMassCast(s.hero, id)) {
        // ONE option covering the whole line, priced as the sum of what it is
        // worth on each stack that would actually take it. Scoring it per-target
        // would have the AI pay a mass Haste's price for one stack's benefit and
        // skip the cast that wins the battle.
        let net = 0, n = 0;
        for (const u of pool) { const v = worth(u); if (v !== null) { net += v; n++; } }
        if (n) consider(net, id, {}, { massTargets: n });
      } else {
        for (const u of pool) { const v = worth(u); if (v !== null) consider(v, id, { unitId: u.id }); }
      }
    } else if (sp.kind === 'heal') {
      // Healing takes the school-mastery bonus but NOT sorcery (sorcery is
      // "+% spell DAMAGE" only) — the engine is explicit about this; the
      // estimator had it backwards (sorcery applied, school omitted).
      const amount = Math.round((sp.base + sp.perPower * power) * schoolMult(sp));
      // Reviving spells may target dead stacks (still present in battle.units)
      // — but not a corpse whose hex a live stack has since claimed: the engine
      // refuses that cast (one hex, one stack), so offering it here would spend
      // mana and the round's cast on a guaranteed no-op.
      const pool = sp.revives
        ? battle.units.filter((u) => u.side === side && !u.machine
            && (u.alive || !unitAt(battle, u.x, u.y)))
        : friends;
      if (isMassCast(s.hero, id)) {
        let net = 0, n = 0;
        for (const u of pool) {
          if (ability(u, 'spellImmune')) continue;
          net += healValue(battle, u, sp, amount); n++;
        }
        if (n) consider(net, id, {}, { massTargets: n });
      } else {
        for (const u of pool) {
          if (ability(u, 'spellImmune')) continue;
          consider(healValue(battle, u, sp, amount), id, { unitId: u.id });
        }
      }
    }
  }

  const enemyTotal = enemies.reduce((n, u) => n + stackValue(battle, u), 0);
  const floor = Math.max(CAST_FLOOR_MIN, enemyTotal * CAST_FLOOR_RATE);
  let pick = null;
  for (const o of options) {
    if (o.score < floor) continue;
    if (!pick || o.score > pick.score + TIE_EPS ||
        (Math.abs(o.score - pick.score) <= TIE_EPS && o.mana < pick.mana)) {
      pick = o;
    }
  }
  if (!pick) {
    // A ROUND WITH NO CAST IS STILL A DECISION, and the most informative one in
    // the file: "the hero had eight spells and cast none, the best scored 12
    // against a floor of 40" is a diagnosis. Logging only the casts would hide
    // exactly the failure reported — that the AI never casts Blind where a human
    // would — because a spell never cast leaves no trace in a move log at all.
    logSpellDecision(battle, side, options, null, floor);
    return [];
  }
  // Cunning AI (#12) reaches into the spellbook too: facing a human, the hero
  // sometimes casts a NEAR-best option instead of the strict argmax — a rival
  // spell within CUNNING_NEAR of the best, or the same spell at a near-equal
  // target — so its casting can't be perfectly predicted and pre-countered.
  // Candidates still clear the cast floor (never trivia). Inactive (Classic,
  // auto-resolve, AI-vs-AI): no rng drawn, strict argmax, byte-identical.
  if (cunningSideActive(battle, side) && battle.rng && battle.rng.chance(CONFIG.CUNNING_EPSILON)) {
    pick = softmaxNearBest(battle.rng, options.filter((o) => o.score >= floor), pick);
  }
  logSpellDecision(battle, side, options, pick, floor);
  return castSpell(battle, side, pick.id, pick.target);
}

/**
 * Emit one spellcasting decision — every affordable spell against every sensible
 * target, priced, plus the cast floor that a candidate had to clear.
 *
 * The floor is logged as a term because "did not cast" has two entirely
 * different causes: nothing scored well (a real judgement) or everything scored
 * below a floor that is set too high (a corner). Without the floor in the record
 * the two are indistinguishable.
 */
function logSpellDecision(battle, side, options, pick, floor) {
  if (!battle.telemetry) return;
  const candidates = options.map((o) => ({ label: o.label, score: o.score, terms: o.terms }));
  let chosenIndex = pick ? options.indexOf(pick) : -1;
  if (chosenIndex < 0) {
    candidates.push({ label: 'no-cast', score: 0, terms: { floor, reason: 'nothing cleared the cast floor' } });
    chosenIndex = candidates.length - 1;
  }
  battle.telemetry.decision({
    phase: 'combat',
    channel: 'spell',
    actor: battle.telemetry.ownerOf ? battle.telemetry.ownerOf(side) : side,
    human: battle.telemetry.humanSide === side,
    subject: { side, round: battle.round, mana: battle.sides[side]?.hero?.mana ?? null, floor },
    candidates,
    chosenIndex,
    ...(cunningSideActive(battle, side) && candidates.length ? (() => {
      const bestScore = Math.max(...candidates.map((c) => c.score));
      return { temperature: Math.max(1e-6, bestScore * CONFIG.CUNNING_TEMP), nearFloor: Math.max(floor, bestScore * CONFIG.CUNNING_NEAR) };
    })() : {}),
    fallback: pick ? null : 'no-cast',
  });
}

// ---------------------------------------------------------------------------
// Auto-resolver
// ---------------------------------------------------------------------------

/**
 * Run the whole battle silently with both sides on AI.
 * Returns the engine result (see battleResult). Rounds are capped; if the
 * cap is hit the side with more remaining value is declared winner — but both
 * sides keep their actual survivors (a 51/49 standoff is not a free wipe).
 */
export function autoResolve(battle, maxRounds = 60, onTurn = null) {
  for (let guard = 0; guard < 5000; guard++) {
    if (battle.over || battle.round > maxRounds) break;
    const { unit } = beginTurn(battle);
    if (!unit) break;
    maybeCastAISpell(battle, unit.side);
    if (battle.over) break;
    const action = chooseAction(battle, unit);
    act(battle, unit, action);
    // OBSERVER, and it exists so instruments do not fork this loop. Measuring
    // anything mid-battle used to mean re-driving beginTurn/chooseAction/act from a
    // script, which is a second copy of the resolve order that drifts silently — the
    // same class of defect I16 exists to stop. One optional callback, called after
    // the action so the observer sees its effect, and `null` by default so every
    // existing caller is byte-identical.
    if (onTurn) onTurn(battle, unit, action);
  }
  if (!battle.over) {
    const strength = (side) => battle.units
      .filter((u) => u.alive && u.side === side && !u.machine)
      .reduce((n, u) => n + stackValue(battle, u), 0);
    battle.over = true;
    battle.winner = strength(0) >= strength(1) ? 0 : 1;
  }
  return battleResult(battle);
}

/**
 * Battle Formations (#10): estimate one side's win probability under a given
 * stance, by Monte-Carlo. Clone the createBattle config with a fresh RNG per
 * sample, force that side's stance (the OTHER side keeps whatever stance the
 * cfg already carries — classic 'press' when none, so the human's preview
 * prices the stance the AI will actually fight under), auto-resolve, and count
 * wins. Pure preview: `simulated: true` makes createBattle clone the heroes so
 * the sim's spellcasting never spends the real hero's mana, and deployArmy
 * already builds its own unit copies, so the source armies are untouched too.
 * `cfg` is the createBattle config WITHOUT rng.
 */
export function estimateStanceWinProb(cfg, humanSide, stance, samples = 40, seed0 = 1) {
  if (humanSide !== 0 && humanSide !== 1) return null;
  const aStance = humanSide === 0 ? stance : normStance(cfg.attacker?.stance);
  const dStance = humanSide === 1 ? stance : normStance(cfg.defender?.stance);
  let wins = 0;
  for (let i = 0; i < samples; i++) {
    const rng = new Rng((seed0 + i * 0x9e3779b1) >>> 0);
    const battle = createBattle({
      ...cfg, rng, simulated: true, // clone the heroes — a preview must not spend real mana
      attacker: { ...cfg.attacker, stance: aStance },
      defender: { ...cfg.defender, stance: dStance },
    });
    autoResolve(battle);
    if (battle.winner === humanSide) wins++;
  }
  return wins / samples;
}

/** Value (Σ power × count) of a plain army array [{creature, count}]. */
function armyArrayValue(army, physical = false) {
  return armyPower(army, physical);
}

/**
 * The stance a side should fight at, from its win probability: seek variance as a
 * clear underdog, kill variance as a clear favorite, classic press when the fight
 * is contested. Used by the AI only — the player is never shown these odds.
 */
export function stanceForOdds(p) {
  if (!Number.isFinite(p)) return 'press';
  if (p <= CONFIG.AI_STANCE_UNDERDOG) return 'allin';
  if (p >= CONFIG.AI_STANCE_FAVORITE) return 'hold';
  return 'press';
}

export function chooseAIStances(cfg, opts = {}) {
  const human = cfg.humanSide ?? -1;
  const out = { attacker: null, defender: null };
  // `cfg.features` is what createBattle will thread onto the battle, so the
  // pre-battle odds are read in the same currency the battle itself will fight in.
  const physical = !!cfg.features?.physicalDamage;
  const av = armyArrayValue(cfg.attacker?.army, physical);
  const dv = armyArrayValue(cfg.defender?.army, physical);
  if (av <= 0 || dv <= 0) return out;
  const skip = CONFIG.AI_STANCE_SKIP_RATIO;
  let p0, bias = 1; // p0 = the ATTACKER's win probability, both sides at press
  if (av >= dv * skip) p0 = 1;
  else if (dv >= av * skip) p0 = 0;
  else {
    p0 = estimateStanceWinProb(cfg, 0, 'press',
      opts.samples ?? CONFIG.AI_STANCE_SAMPLES, opts.seed0 ?? 1);
    bias = Math.max(0, Math.min(1, opts.winBias ?? 1));
  }
  if (human !== 0) out.attacker = stanceForOdds(p0 * bias);
  if (human !== 1) out.defender = stanceForOdds((1 - p0) * bias);
  return out;
}

