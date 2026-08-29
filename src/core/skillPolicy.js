/**
 * skillPolicy.js — what secondary skill a NON-HUMAN hero should take.
 *
 * Extracted from AIPlayer so that two callers cannot drift apart:
 *
 *   - the AI, resolving a level-up its hero earned on its own turn
 *     (AIPlayer.resolvePendingSkills), and
 *   - rival parity, resolving the level-ups it just granted a rival so the
 *     carried-veteran matchup is fought against a commander with skills rather
 *     than a level number (campaign.matchRivalProgression).
 *
 * They must agree. A rival levelled to 58 by parity and then handed skills by
 * some second, kinder policy would be a different opponent from the one the AI
 * grows on its own, and the difficulty of a matched rival would depend on which
 * code path built it. One function, one answer.
 *
 * Pure: no state, no rng. Given a hero and an offered option it returns a score.
 * A skill whose worth depends on an OPT-IN rule takes that as an argument rather
 * than reaching for the world — see `isOn` on skillOptionScore.
 */

import { HERO_CLASSES } from '../data/heroes.js';
import { CREATURES } from '../data/creatures.js';

/**
 * Per-level worth of each secondary skill, [might, magic] flavored by hero
 * class. Tempo (Logistics) tops the list: on the adventure map, movement IS
 * value. Archery is priced dynamically from the army's ranged share.
 */
export const SKILL_WEIGHTS = {
  logistics: [100, 95],
  offense: [85, 55],
  armorer: [80, 55],
  wisdom: [35, 85],
  pathfinding: [60, 55],
  estates: [55, 55],
  leadership: [50, 40],
  luck: [45, 40],
  intelligence: [12, 55],
  sorcery: [10, 60],
  mysticism: [8, 40],
  scouting: [15, 15],
  // Measured, not felt. Over four 45-day games with the feature on, AI heroes
  // walked into 668 neutral encounters; 157 of those bands refused to bargain
  // and 22 were bought. Giving every rival hero Expert Diplomacy cut the
  // refusals to 35 and lifted the purchases to 35 — a 59% rise in bands
  // enlisted, bounded not by the skill but by the two things it cannot fix:
  // seven full army slots (408 encounters) and an empty treasury (135). Real
  // value, and clearly not Logistics.
  diplomacy: [45, 45],
  // The magic schools. Each strengthens the spells of its own school, which is
  // what these numbers price. EARTH and AIR also carry the two spells that move
  // an army across a map — Town Portal and Dimension Door — and that is worth
  // more than any damage bonus, so a hero who actually holds one is scored by
  // LOGISTICS_SCHOOL below instead.
  earthMagic: [25, 55],
  airMagic: [25, 55],
  fireMagic: [18, 50],
  waterMagic: [18, 45],
};

/** The school each map-moving spell masters under, and the spell it needs. */
const LOGISTICS_SCHOOL = { earthMagic: 'townPortal', airMagic: 'dimensionDoor' };
// What mastery of one of those two is worth, by rank. Expert Earth makes Town
// Portal FREE and lets the hero choose the town; Expert Air turns two eight-tile
// jumps a day into four sixteen-tile ones at half the movement. So the generic
// "later ranks are worth less" curve is not merely wrong here, it is backwards —
// the last rank is the one worth having, and this ladder says so. At Expert it
// prices level with Logistics, which is the company it belongs in: both are
// answers to the same question, which is how much map a hero covers in a day.
const LOGISTICS_SCHOOL_BASE = 40;
const LOGISTICS_SCHOOL_RANK = 20;

/**
 * Skills whose worth is gated on an opt-in rule, and the rule that gates them.
 *
 * A skill that cannot act in this game must not be scored as if it could —
 * that is one of eight slots spent on nothing. Diplomacy without
 * `features.diplomacy` leaves only the cut to the hero's own surrender price
 * (actions.surrenderCost), which is worth about the unlisted default.
 */
const FEATURE_GATED = { diplomacy: 'diplomacy' };
const GATED_OFF_SCORE = 20;

/**
 * Score one offered level-up option for this hero — higher is better.
 *
 * `isOn` answers whether an opt-in rule is active in this game; pass
 * `(id) => featureOn(state, id)`. Omitted, every feature-gated skill is priced
 * as if its rule were OFF — the conservative default, because the failure it
 * guards against (a hero spending a slot on a skill that cannot act) is worse
 * than the one it risks (a diplomat undervalued in a game that wanted one).
 */
export function skillOptionScore(hero, opt, isOn = null) {
  const cls = HERO_CLASSES[hero.class] || HERO_CLASSES.knight;
  const magic = cls.growth.power + cls.growth.knowledge >= cls.growth.attack + cls.growth.defense;
  const gate = FEATURE_GATED[opt.skill];
  if (gate && !(isOn && isOn(gate))) return GATED_OFF_SCORE * rankMult(opt);
  // A school that carries a map-moving spell THIS hero already knows. Priced on
  // the rank rather than discounted by it — see LOGISTICS_SCHOOL_RANK. A hero
  // without the spell falls through to the school's ordinary weight, which is
  // the honest answer: the realm may never raise a guild that teaches it.
  const carries = LOGISTICS_SCHOOL[opt.skill];
  if (carries && (hero.spells || []).includes(carries)) {
    return LOGISTICS_SCHOOL_BASE + LOGISTICS_SCHOOL_RANK * Math.max(1, opt.toLevel || 1);
  }
  let base;
  if (opt.skill === 'archery') {
    // Archery is only as good as the bows carrying it.
    let total = 0, ranged = 0;
    for (const stack of hero.army) {
      if (!stack) continue;
      const c = CREATURES[stack.creature];
      const v = (c?.aiValue || 0) * stack.count;
      total += v;
      if (c?.reach === 'ranged') ranged += v;
    }
    base = 20 + 80 * (total ? ranged / total : 0);
  } else {
    const w = SKILL_WEIGHTS[opt.skill];
    base = w ? w[magic ? 1 : 0] : 20;
  }
  return base * rankMult(opt);
}

/** Later ranks of a known skill are worth slightly less than a first rank. */
function rankMult(opt) {
  return [1, 0.9, 0.8][Math.max(0, Math.min(2, (opt.toLevel || 1) - 1))];
}

/** Index of the best option in a pending choice (0 when there is nothing to weigh).
 *  `isOn` is forwarded to skillOptionScore — see there. */
export function bestSkillOption(hero, options, isOn = null) {
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < options.length; i++) {
    const s = skillOptionScore(hero, options[i], isOn);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}
