/**
 * pandora.js — Pandora's Box: a one-time object that yields a big, VARIED reward
 * (map RPG layer, part C). Unlike a Creature Bank (fixed guard + fixed hoard) a
 * box rolls a random reward at generation — experience, spell points, a resource
 * lump, an artifact, a spell, or an army — and is sometimes guarded, sometimes a
 * free find. The reward + guard are stamped onto the object so they persist and
 * replay deterministically. Structurally it reuses the bank combat/loot path.
 */
import { ARTIFACTS, artifactBandCost } from './artifacts.js';
import { SPELLS } from './spells.js';
import { CREATURES } from './creatures.js';
import { creaturePower } from '../core/power.js';

// No campaign relics: a First Vow set piece is granted by its scenario, and a
// box that hands you a second Mornbrand is the same leak the map generator's
// treasure placement already refuses (see ARTIFACTS' `campaign` flag).
const ART_IDS = Object.keys(ARTIFACTS).filter((id) => !ARTIFACTS[id].campaign);
const SPELL_IDS = Object.keys(SPELLS).filter((id) => !SPELLS[id].adventure); // teachable combat spells
/**
 * One rng draw, two bands: ~88% lands in [lo, hi] and ~12% in [bigLo, bigHi].
 *
 * A single draw matters here. Pandora rewards are rolled when the box is PLACED,
 * during map generation, so an extra draw would shift the generation stream and
 * silently change every layout after the first box — which is exactly what a first
 * attempt did, breaking two unrelated layout tests.
 */
function tailed(rng, lo, hi, bigLo, bigHi) {
  const t = rng.int(0, 999);
  if (t < 880) return lo + Math.round((t / 879) * (hi - lo));
  return bigLo + Math.round(((t - 880) / 119) * (bigHi - bigLo));
}

const REWARD_CREATURES = ['griffin', 'swordsman', 'monk', 'cavalier', 'naga', 'troll', 'goldGolem'];
const GUARD_POOL = ['rogue', 'nomad', 'troll', 'medusa', 'goldGolem', 'direWolf'];
/** The pool's cheapest species — the fallback when even it overruns the budget. */
const cheapestGuard = (physical) => GUARD_POOL.reduce(
  (a, b) => (creaturePower(a, physical) <= creaturePower(b, physical) ? a : b),
);

/** Roll a box's reward (pure; deterministic from rng). Stamped onto the object. */
export function rollPandoraReward(rng) {
  const roll = rng.random();
  // A tail on xp too: mostly a solid boost, rarely a level in one box. Folded into
  // ONE draw, mapped non-linearly — a box's reward is rolled at MAP GENERATION, so
  // spending a second draw here would shift the whole generation rng stream and
  // change every map layout downstream.
  if (roll < 0.22) return { kind: 'xp', amount: tailed(rng, 27000, 90000, 252000, 396000) };
  // 3000-6000 every time made a box a known quantity. Now roughly one in eight is
  // a hoard, still on a single draw (see tailed).
  if (roll < 0.40) return { kind: 'resource', resource: 'gold', amount: tailed(rng, 2000, 5000, 15000, 25000) };
  if (roll < 0.53) return { kind: 'resource', resource: rng.pick(['gems', 'crystal', 'mercury', 'sulfur', 'ore', 'wood']), amount: rng.int(8, 16) };
  if (roll < 0.70 && ART_IDS.length) return { kind: 'artifact', artifact: rng.pick(ART_IDS) };
  if (roll < 0.83 && SPELL_IDS.length) return { kind: 'spell', spell: rng.pick(SPELL_IDS) };
  if (roll < 0.94) return { kind: 'creatures', creatures: [{ creature: rng.pick(REWARD_CREATURES), count: rng.int(3, 8) }] };
  return { kind: 'mana', amount: rng.int(10, 20) };
}

/**
 * Roll a box's guard army — or [] for an unguarded free find.
 *
 * The guard is sized from the REWARD it stands over. It used to be rolled with
 * no knowledge of the reward at all: a flat 35% free find, otherwise a flat
 * 2500–5000 budget. Measured over 40 000 rolls, the correlation between what a
 * box was worth and what guarded it was **0.005** — none — even though this
 * file's own valuation function claimed the gold-equivalent "is what scales its
 * GUARD". In practice a third of the richest boxes (a 25 000-gold hoard, a
 * 396 000-experience jackpot) were free finds, and two thirds of the poorest —
 * ten spell points — sat behind a real battle.
 *
 * `worth` is the reward's gold-equivalent (pandoraRewardValue). A cheap box is
 * a free find far more often than a hoard is, and a guarded box is worth one to
 * two times its own prize. The budget is floored so a guard is always a fight
 * and capped so a box never becomes a boss lair by accident.
 *
 * The rng draw pattern is UNCHANGED — one draw for the free-find test, then two
 * more for a guarded box. A box's guard is rolled during map generation, so a
 * different number of draws would shift every layout downstream of it.
 */
export const PANDORA_GUARD_MIN = 900;
export const PANDORA_GUARD_MAX = 20000;
/** Readable stack bounds, matching the map generator's own wandering guards. */
export const GUARD_STACK_MIN = 3;
export const GUARD_STACK_MAX = 60;

export function rollPandoraGuard(rng, reward = null, physical = false) {
  const worth = reward ? pandoraRewardValue(reward) : 3000;
  // 0.45 at a trinket down to near-nothing at a hoard; the median box lands at
  // about 0.36, which is where the old flat rate sat, so the overall share of
  // free finds barely moves — only WHICH boxes are free.
  const freeChance = Math.max(0.02, Math.min(0.45, 0.45 - worth / 25000));
  if (rng.chance(freeChance)) return [];
  const lo = Math.max(PANDORA_GUARD_MIN, Math.round(worth));
  const hi = Math.min(PANDORA_GUARD_MAX, Math.max(lo + 1, Math.round(worth * 2)));
  // Only species that can express this budget as a READABLE stack — between 3
  // and 60 of them, the same bound the map generator's own rollGuard uses for a
  // wandering guard. Both ends matter and only one of them was here at first:
  // the floor stops a cheap prize being overrun (ten spell points, worth 600,
  // guarded by three trolls at 2040), and the ceiling stops a rich one being
  // answered with a mob — a 20 000 budget spent on rogues is 148 of them, and a
  // hover reading "Guarded by 152 Rogues" is a stack nobody can size up at a
  // glance. Measured on real maps, 2.5% of guarded boxes were over the line.
  // Still exactly one draw, whatever the pool narrows to.
  // Sized in POWER, not price (src/core/power.js). `pandoraRewardValue` below
  // stays on aiValue on purpose: what the box is WORTH to whoever opens it is a
  // price question, and only the guard is a fight.
  const fits = GUARD_POOL.filter((id) => {
    const av = creaturePower(id, physical) || 1e9;
    return av * GUARD_STACK_MIN <= hi && av * GUARD_STACK_MAX >= lo;
  });
  const c = rng.pick(fits.length ? fits : [cheapestGuard(physical)]);
  const av = creaturePower(c, physical) || 100;
  const count = Math.round(rng.int(lo, hi) / av);
  return [{ creature: c, count: Math.min(GUARD_STACK_MAX, Math.max(GUARD_STACK_MIN, count)) }];
}

/** A rough gold-equivalent of a reward — for the AI's box valuation. */
export function pandoraRewardValue(reward) {
  if (!reward) return 0;
  switch (reward.kind) {
    // 0.6 gold per XP point in the old hit-point currency; XP amounts are 18x
    // larger now, so the weight divides by the same 18 and a box's gold-equivalent
    // is left exactly where it was. That equivalent is now what SIZES THE GUARD as
    // well as what the AI pays attention to — the claim this comment used to make
    // and the code did not honour — so this weight is a live balance knob, not
    // only an AI heuristic.
    case 'xp': return reward.amount * (0.6 / 18);
    case 'mana': return reward.amount * 60;
    case 'resource': return reward.resource === 'gold' ? reward.amount : reward.amount * 120;
    // By BAND, not a flat 3000. The band is the whole difference between a +1
    // Luck charm and the Titan's Gladius, and this number is what sizes the
    // guard standing over the box — so a flat rate meant the box that hides a
    // top-band relic was guarded exactly like the one hiding a trinket. Rares at
    // the same 120 this function already uses for a resource lump.
    case 'artifact': {
      const c = artifactBandCost(ARTIFACTS[reward.artifact]?.value || 1);
      return c.gold + c.gems * 120;
    }
    case 'spell': return 1500;
    case 'creatures': return (reward.creatures || []).reduce((n, c) => n + (CREATURES[c.creature]?.aiValue || 0) * c.count, 0);
    default: return 500;
  }
}
