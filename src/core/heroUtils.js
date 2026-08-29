/**
 * heroUtils.js — Derived hero values.
 *
 * Heroes are stored as plain objects (see GameState.createHero). Everything
 * that *derives* from base stats + artifacts + skills is computed here so
 * there is exactly one source of truth for each formula.
 */

import { CONFIG, XP_TABLE } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { armyPower } from './power.js';
import { ARTIFACTS, ARTIFACT_SETS, heroHasFullSet } from '../data/artifacts.js';
import { skillValue } from '../data/skills.js';

/**
 * Sum one numeric effect across all equipped artifacts, PLUS the synergy of any
 * completed combination set (see ARTIFACT_SETS). Folding the set bonus in here
 * means every consumer (combat stats, movement, mana, income) picks it up for
 * free — a completed set is derived from equipment, so it also round-trips.
 */
export function artifactBonus(hero, effect) {
  let sum = 0;
  for (const socket of Object.keys(hero.equipment || {})) {
    const artId = hero.equipment[socket];
    if (!artId) continue;
    const art = ARTIFACTS[artId];
    if (art?.effects?.[effect]) sum += art.effects[effect];
  }
  for (const setId of Object.keys(ARTIFACT_SETS)) {
    const set = ARTIFACT_SETS[setId];
    if (set.effects[effect] && heroHasFullSet(hero, set)) sum += set.effects[effect];
  }
  return sum;
}

/** Effective primary stat: base + artifacts. stat ∈ attack|defense|power|knowledge */
export function heroStat(hero, stat) {
  const spec = hero.specialty && hero.specialty.kind === 'stat' && hero.specialty.stat === stat ? 1 : 0;
  return (hero.stats[stat] || 0) + artifactBonus(hero, stat) + spec;
}

/** Max mana: knowledge * 10, boosted by Intelligence. */
export function heroMaxMana(hero) {
  const base = heroStat(hero, 'knowledge') * CONFIG.MANA_PER_KNOWLEDGE;
  return Math.round(base * (1 + skillValue(hero, 'intelligence')));
}

/** Mana regenerated per day. */
export function heroManaRegen(hero) {
  return CONFIG.BASE_MANA_REGEN + (skillValue(hero, 'mysticism') || 0) + artifactBonus(hero, 'manaRegen');
}

/**
 * Army-equivalent value of a hero's COMBAT contribution — so force comparisons
 * can see the commander, not just the stacks. Blends the primary combat stats
 * (attack + defense, which multiply the whole army's punch and staying power) and
 * the SPELL threat (power × current mana — the burst a full bar of nukes can
 * deliver). Zero for a spectator/absent hero. Callers scale it by the hero-power
 * weight; see CONFIG.HERO_STAT_VALUE / HERO_SPELL_VALUE.
 */
export function heroPowerValue(hero) {
  if (!hero || !hero.stats) return 0; // no stats to read ⇒ can't estimate (armies only)
  const stat = (heroStat(hero, 'attack') + heroStat(hero, 'defense')) * CONFIG.HERO_STAT_VALUE;
  const spell = heroStat(hero, 'power') * (hero.mana || 0) * CONFIG.HERO_SPELL_VALUE;
  return Math.round(stat + spell);
}

/** A hero's total effective force: its army value plus its scaled commander power
 *  (weight 0 ⇒ armies only). The lens force comparisons should use. */
export function effectiveForce(army, hero, weight) {
  return armyValue(army) + (weight || 0) * heroPowerValue(hero);
}

/**
 * The same reading in POWER rather than in price — what this army can do, not
 * what it is worth. See src/core/power.js for why those are different questions
 * and which one each caller is actually asking; anything SIZING OPPOSITION wants
 * this one, anything comparing wealth wants effectiveForce.
 */
export function effectivePower(army, hero, weight, physical = false) {
  return armyPower(army, physical) + (weight || 0) * heroPowerValue(hero);
}

/** Speed of the slowest creature in the army (heroes without troops move as speed 4). */
export function slowestSpeed(hero) {
  let slowest = Infinity;
  for (const stack of hero.army) {
    if (!stack) continue;
    const c = CREATURES[stack.creature];
    if (c && c.speed < slowest) slowest = c.speed;
  }
  return slowest === Infinity ? 4 : slowest;
}

/**
 * Daily movement point pool.
 * Base scales with the slowest creature (HoMM3 rule), then Logistics %,
 * artifact bonuses (Boots of Speed — the "path length" boosters) and
 * temporary weekly bonuses (Stables) are added.
 */
export function heroMaxMovement(hero) {
  const spd = slowestSpeed(hero);
  const fromSpeed = Math.min(
    CONFIG.MP_BASE + Math.max(0, spd - 4) * CONFIG.MP_PER_SPEED,
    CONFIG.MP_MAX_FROM_SPEED,
  );
  const logistics = 1 + skillValue(hero, 'logistics');
  const artifacts = artifactBonus(hero, 'moveBonus');
  const weekly = hero.weeklyMoveBonus || 0;
  return Math.round(fromSpeed * logistics) + artifacts + weekly;
}

/** Sight radius in tiles. */
export function heroSightRadius(hero) {
  return CONFIG.SIGHT_RADIUS + (skillValue(hero, 'scouting') || 0);
}

/**
 * Hero-level morale WITHOUT creature auras (leadership, artifacts, temp, faction
 * penalty). Unclamped — callers clamp after adding their own modifiers. Combat
 * uses this as the side base and adds creature auras dynamically from LIVE units
 * (see sideMorale in CombatEngine) so the aura fades when the angel dies and is
 * never double-counted. Mixed factions in the army cost 1 morale.
 */
export function heroBaseMorale(hero) {
  let m = skillValue(hero, 'leadership') + artifactBonus(hero, 'morale') + (hero.tempMorale || 0);
  const factions = new Set();
  for (const stack of hero.army) {
    if (!stack) continue;
    factions.add(CREATURES[stack.creature].faction);
  }
  if (factions.size > 1) m -= 1;
  return m;
}

/** Army-wide morale (clamped ±3), including creature morale auras — adventure display. */
export function heroMorale(hero) {
  let m = heroBaseMorale(hero);
  // Angels (and any moraleAura creature) lift the army's displayed morale.
  if (hero.army.some((s) => s && CREATURES[s.creature].abilities.includes('moraleAura'))) m += 1;
  return Math.max(-CONFIG.MORALE_LUCK_MAX, Math.min(CONFIG.MORALE_LUCK_MAX, m));
}

/** Army-wide luck (clamped ±3). */
export function heroLuck(hero) {
  const l = skillValue(hero, 'luck') + artifactBonus(hero, 'luck') + (hero.tempLuck || 0);
  return Math.max(-CONFIG.MORALE_LUCK_MAX, Math.min(CONFIG.MORALE_LUCK_MAX, l));
}

/**
 * Total army PRICE — Σ aiValue × count. The unit of what an army is WORTH
 * (trades, rewards, pickup economics, telemetry), not of what it can do in a
 * fight: the AI's can-I-win comparisons read `armyPower` (src/core/power.js),
 * which corrects each creature's price by the running damage model's own
 * verdict on it. This docblock used to say "used by the AI to compare forces",
 * and that claim going stale is how half the AI's courage gates ended up
 * comparing a price against a power without anyone choosing to.
 */
export function armyValue(army) {
  let v = 0;
  for (const stack of army) {
    if (!stack) continue;
    v += (CREATURES[stack.creature]?.aiValue || 0) * stack.count;
  }
  return v;
}

export function armyIsEmpty(army) {
  return !army.some((s) => s && s.count > 0);
}

/** Level for a total XP amount. */
export function levelForXp(xp) {
  let lvl = 1;
  while (lvl + 1 < XP_TABLE.length && xp >= XP_TABLE[lvl + 1]) lvl++;
  return lvl;
}

/**
 * Merge a creature stack into an army (7 slots).
 * Returns true if it fit (stacks merge with same creature type).
 */
/**
 * Would addToArmy succeed? A matching stack to top up, or a free slot.
 *
 * The predicate exists because one caller must know BEFORE it acts: a Seer Hut
 * takes the tribute first, and it was paying for a warband an already-full army
 * then dropped on the floor — the hut marked itself done, the gold was gone, and
 * the hero got nothing. Everywhere else the grant is free, so attempting and
 * checking the return is enough.
 */
export function canAddToArmy(army, creatureId, count = 1) {
  if (count <= 0) return true;
  for (const stack of army || []) if (stack && stack.creature === creatureId) return true;
  for (const slot of army || []) if (!slot || slot.count <= 0) return true;
  return false;
}

export function addToArmy(army, creatureId, count) {
  if (count <= 0) return true;
  for (const stack of army) {
    if (stack && stack.creature === creatureId) {
      stack.count += count;
      return true;
    }
  }
  for (let i = 0; i < army.length; i++) {
    if (!army[i] || army[i].count <= 0) {
      army[i] = { creature: creatureId, count, hurt: 0 };
      return true;
    }
  }
  return false;
}
