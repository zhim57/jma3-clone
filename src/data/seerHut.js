/**
 * seerHut.js — a Seer Hut's fetch quest and its sealed reward.
 *
 * A hut asks for a tribute (a resource pile or a gold sum) and pays a reward it
 * does not disclose until the tribute is offered. The one contract, and the
 * reason this is a module of its own rather than a corner of the generator: the
 * reward is ALWAYS worth at least TWICE the tribute. The player is asked to
 * trust that without seeing it, the AI prices a hut off it without peeking
 * (AIPlayer.seerValue), and a respawning hut re-rolls through the very same
 * function months into a game — so it lives beside pandora.js where every
 * consumer can reach it, not behind the map generator's private wall.
 *
 * Pure: rng in, payload out, no map and no state.
 */
import { ARTIFACTS, ARTIFACT_SETS, artifactBandCost } from './artifacts.js';
import { CREATURES } from './creatures.js';
import { CONFIG } from '../config.js';

// Seer Hut fetch quests ask for a resource pile (always gatherable) or a gold
// sum. The REWARD is rolled to be worth clearly MORE than the tribute (never a
// wash), stays hidden until paid, and is always something sizeable — a heap of
// gold, hard experience, a warband, or a real relic (never a value-1 trinket,
// never a story-relic/set piece, which are meant to be earned, not handed out).
export const SEER_FETCH_RES = ['wood', 'ore', 'mercury', 'sulfur', 'crystal', 'gems'];
// Gold-equivalent worth of one unit of each tribute resource — used to size the
// reward above the tribute's value. (Rares are worth more than wood/ore.)
export const SEER_RES_WORTH = { wood: 150, ore: 150, mercury: 350, sulfur: 350, crystal: 350, gems: 350, gold: 1 };
// Story-relics / set pieces (e.g. the Panoply of the First Dawn) are earned in
// the campaign, never dispensed by a roadside seer.
export const SEER_SET_PIECES = new Set(Object.values(ARTIFACT_SETS).flatMap((s) => s.components || []));
// Reward artifacts: real gear only (value ≥ 2), no set pieces.
export const SEER_REWARD_ARTIFACTS = Object.keys(ARTIFACTS)
  .filter((id) => (ARTIFACTS[id].value || 0) >= 2 && !SEER_SET_PIECES.has(id) && !ARTIFACTS[id].campaign);
/** What a relic of rarity band `v` is worth in the SEER's own money — the trading
 *  post's price, with its rares valued at the same rate the hut takes them in. */
const seerArtifactWorth = (v) => {
  const c = artifactBandCost(v);
  return c.gold + c.gems * SEER_RES_WORTH.gems;
};
// Iconic "sizeable stack" reward creatures, ascending by value, so a hut can
// gift a warband scaled to the tribute (a few champions … up to archangels).
export const SEER_REWARD_CREATURES = ['cavalier', 'champion', 'blackKnight', 'behemoth', 'giant', 'hydra', 'angel', 'phoenix', 'devil', 'archDevil', 'titan', 'archangel']
  .filter((id) => CREATURES[id] && CREATURES[id].aiValue > 0);
/**
 * A Seer Hut's fixed quest + reward, rolled at generation (deterministic).
 * The reward is ALWAYS worth clearly more than the tribute (≥2×) — no more
 * "pay 6000 gold, get 3000" — and is always something sizeable: a gold heap,
 * hard experience, a warband, or a real relic. It is disclosed to the player
 * only after the tribute is paid (see actions.visitSeerHut / seerRewardText).
 */
export function seerHutPayload(rng) {
  const quest = rng.random() < 0.5
    ? { kind: 'resource', res: rng.pick(SEER_FETCH_RES), amount: rng.int(5, 20) }
    : { kind: 'resource', res: 'gold', amount: rng.int(2, 6) * 1000 };
  // Value the tribute in gold, then aim the reward well above it.
  const costValue = quest.amount * (SEER_RES_WORTH[quest.res] || 1);
  const target = costValue * rng.pick([2, 2.5, 3]);
  // Round UP, never down. Snapping to the nearest 500 could shave 250 off the
  // target and drop the reward under the 2x this hut promises — measured, that
  // is exactly why a 2100-gold tribute paid 4000 gold instead of 4200.
  const roundTo = (v, step) => Math.max(step, Math.ceil(v / step) * step);
  const roll = rng.random();
  let reward;
  if (roll < 0.3) {
    reward = { kind: 'resource', res: 'gold', amount: roundTo(target, 500) };
  } else if (roll < 0.55) {
    reward = { kind: 'xp', amount: roundTo(target * CONFIG.XP_PER_GOLD, 500) };
  } else if (roll < 0.8) {
    // A warband, sized in GOLD — the currency the tribute is priced in. It used
    // to size by aiValue, which runs 1.5x to 3.2x a creature's gold cost, so the
    // stack was worth about half what the hut had aimed at: measured over 270
    // huts the warband branch paid a median 1.20x the tribute where every other
    // branch paid 2.5x, and 99% of warbands fell under the 2x this hut promises.
    // One case paid 0.77x — the literal "pay 6000, get 3000" the header says was
    // fixed. Still the strongest ladder creature that yields a stack of >= 2, so
    // the count stays in a readable 2-9 range.
    // Among every ladder creature, the smallest readable stack (2-9) whose gold
    // worth CLEARS the target — and of those, the closest to it. Picking "the
    // strongest that fits" and rounding the count to nearest left the stack a
    // whole creature short whenever the division landed just under .5: 7 sulfur
    // bought two phoenixes at 1.63x instead of the 2.45x aimed at, because a
    // 2000-gold creature can only step in 2000-gold jumps.
    const goldOf = (id) => CREATURES[id].cost?.gold || CREATURES[id].aiValue || 1;
    let best = null;
    for (const id of SEER_REWARD_CREATURES) {
      const count = Math.max(2, Math.min(9, Math.ceil(target / goldOf(id))));
      const worth = count * goldOf(id);
      // Prefer the cheapest overshoot; fall back to the richest stack available
      // when even nine of the biggest cannot reach the target.
      const better = best === null
        || (worth >= target && (best.worth < target || worth < best.worth))
        || (worth < target && best.worth < target && worth > best.worth);
      if (better) best = { creature: id, count, worth };
    }
    reward = { kind: 'creatures', creature: best.creature, count: best.count };
  } else {
    // A real relic — but an artifact's worth is a DISCRETE ladder, and a big
    // tribute outgrows the whole catalog: 20 mercury (7000 by this file's own
    // pricing) against the best relic in the game (10 800) is 1.31x, not the 2x
    // the hut guarantees, and 55% of relic huts fell short. Pick the cheapest
    // band that clears twice the tribute; when none can, pay gold instead. The
    // draw happens either way — a box's payload is rolled during generation, so
    // skipping it would shift every layout downstream.
    const need = costValue * 2;
    const band = [2, 3, 4].find((v) => seerArtifactWorth(v) >= need) || 4;
    const pool = SEER_REWARD_ARTIFACTS.filter((id) => ARTIFACTS[id].value === band);
    const pick = rng.pick(pool.length ? pool : SEER_REWARD_ARTIFACTS);
    reward = seerArtifactWorth(ARTIFACTS[pick].value) >= need
      ? { kind: 'artifact', artifact: pick }
      : { kind: 'resource', res: 'gold', amount: roundTo(target, 500) };
  }
  return { quest, reward };
}
