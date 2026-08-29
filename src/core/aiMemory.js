/**
 * aiMemory.js — what the game remembers about how you actually play.
 *
 * Everything else that sizes a fight reads STATE: your army value, your
 * commander's stats, the day. None of that is experience. A player who wins every
 * battle at a tenth of the cost the model predicted, and a player who barely
 * survives the same fights, present identical numbers to it — and the request this
 * module answers is exactly that gap: adjust for what happened, not only for what
 * is on the sheet.
 *
 * `state.aiMemory` is the ledger, round-tripped in saves, updated once per battle
 * a human fought. Three lessons ride on it today:
 *
 *   disableRate  how often you MASS-DISABLE. Rising, it makes stacks deploy
 *                spread out — the AI's commanders AND the wildlife — so the
 *                Blind-one-stack-and-delete-the-army trick decays the more you
 *                lean on it.
 *   courageMult  how much overkill the AI demands before it will commit, moved by
 *                its own losses. Sun Tzu's ratio, recalibrated by defeat.
 *   tideBias     how the PvE difficulty sizer's INTENT compared with the outcome.
 *                The sizer aims a fight at a target cost and is graded on what the
 *                fight actually cost you.
 *
 * All three are EWMAs, so they weight the recent and forget the old — a lesson
 * from twenty battles ago should not still be governing this one.
 *
 * WHY ITS OWN MODULE. It used to live in actions.js, which cannot be imported by
 * the two places that most need to read it: diplomacy.js (the sizer's simulation,
 * which actions imports) and the combat scene. A memory nothing can reach is not a
 * memory. Nothing here imports anything that imports it back — CONFIG, the spell
 * and creature tables, and one army-value helper — which is what makes it safe to
 * read from anywhere.
 */

import { CONFIG } from '../config.js';
import { SPELLS } from '../data/spells.js';
import { CREATURES } from '../data/creatures.js';
import { armyValue } from './heroUtils.js';

/**
 * AI learning (#): after a battle the human fought, update the running memory of
 * their tactics — v1 tracks how often they MASS-DISABLE (Blind) the AI's stacks,
 * as an EWMA so it weights recent fights and forgets old ones. A rising rate
 * makes the AI split its stacks harder next time (see aiLearnedSplitParts), so
 * the "Blind one stack, delete the army" trick stops working the more you lean on
 * it. No-op for AI-vs-AI (no humanSide / no event stream).
 */
export function recordHumanBattleMemory(state, result) {
  const hs = result?.humanSide;
  if (!state || (hs !== 0 && hs !== 1)) return;
  const m = (state.aiMemory ||= { disableRate: 0, battles: 0, courageMult: 1 });
  m.battles = (m.battles || 0) + 1;
  // (a) Blind → split: track how disable-happy the human is (EWMA).
  const blinded = (result.events || []).some((e) => e.type === 'spellEffect'
    && e.casterSide === hs && e.hostile && SPELLS[e.spellId]?.effects?.blinded) ? 1 : 0;
  const a = CONFIG.AI_LEARN_RATE;
  m.disableRate = (m.disableRate || 0) * (1 - a) + blinded * a;
  // (b) Force-ratio recalibration (Sun Tzu — win without bleeding). Read the AI
  // side's outcome and how much of its army died, and move courageMult: a loss
  // demands much more overkill next time, a pyrrhic win nudges up, a clean win
  // relaxes toward the baseline. Needs the roster (start counts) + survivor arrays.
  if (result.roster && (result.attackerArmy || result.defenderArmy)) {
    const aiSide = 1 - hs;
    const startVal = (side) => result.roster.filter((r) => r.side === side)
      .reduce((n, r) => n + (CREATURES[r.creature]?.aiValue || 0) * (r.startCount || 0), 0);
    const aiStart = startVal(aiSide);
    if (aiStart > 0) {
      const aiEnd = armyValue((aiSide === 0 ? result.attackerArmy : result.defenderArmy) || []);
      const aiWon = result.attackerWon === (aiSide === 0);
      const lossFrac = Math.max(0, Math.min(1, (aiStart - aiEnd) / aiStart));
      let mult = m.courageMult || 1;
      if (!aiWon) mult *= CONFIG.AI_COURAGE_UP_LOSS;
      else if (lossFrac > CONFIG.AI_PYRRHIC_LOSS) mult *= CONFIG.AI_COURAGE_UP_PYRRHIC;
      else mult *= CONFIG.AI_COURAGE_RELAX;
      m.courageMult = Math.max(1, Math.min(CONFIG.AI_COURAGE_MULT_MAX, mult));
    }
  }
}

/** How many pieces the AI should tear its strongest stack into THIS battle, learned
 *  from how disable-happy the human has been: baseline when they don't Blind, up to
 *  AI_SPLIT_PARTS_MAX when they lean on it. */
export function aiLearnedSplitParts(state) {
  const base = CONFIG.AI_SPLIT_PARTS_DEFAULT, max = CONFIG.AI_SPLIT_PARTS_MAX;
  const rate = Math.max(0, Math.min(1, state?.aiMemory?.disableRate || 0));
  return Math.max(base, Math.min(max, Math.round(base + rate * (max - base))));
}

/**
 * How many pieces a HEROLESS defender — a wild stack, a bank guard, a ronin's band
 * — tears its stack into.
 *
 * The same lesson `aiLearnedSplitParts` teaches the AI's own commanders, taught to
 * the open country. This is the case the request actually named: a one-stack
 * neutral that gets Blinded and then killed unretaliated, fight after fight, and
 * never changes. The deploy rule (CONFIG.PVE_STACK_SPLIT) already stopped it being
 * ONE stack; this is what makes it spread FURTHER the more you lean on the trick,
 * which is the difference between a fixed counter and a game that learns.
 *
 * CONFIG.PVE_SPLIT_PARTS is the floor, so wildlife never manoeuvres worse than the
 * rule — a wandering pack spreads out, it does not out-think you.
 */
export function pveSplitParts(state) {
  return Math.max(CONFIG.PVE_SPLIT_PARTS, aiLearnedSplitParts(state));
}

/** The learned overkill multiplier on the AI's attack ratio (≥1): higher after
 *  losses/pyrrhic wins, easing back after cheap wins. 1 for a fresh/absent memory. */
export function aiCourageMult(state) {
  return Math.max(1, Math.min(CONFIG.AI_COURAGE_MULT_MAX, state?.aiMemory?.courageMult || 1));
}

/**
 * AI learning (v3) — odds distrust, fed into the AI's stance choice (see
 * CombatAI.chooseAIStances winBias). The stance picker estimates odds by
 * simulating BOTH sides on the computer brain — but the human it will actually
 * face may play far better than that proxy. courageMult is the running record
 * of exactly that gap: it climbs while the human keeps winning fights the sims
 * called for the AI. So shade the AI's PERCEIVED win probability by
 * 1/√courageMult (1 for a fresh memory, down to 0.5 at the cap): a repeatedly
 * beaten AI treats "comfortably ahead" as merely contested and "contested" as
 * underdog — reaching for variance sooner, the mathematically right lean
 * against a stronger player. Recovers automatically as courage relaxes.
 */
export function aiStanceOddsBias(state) {
  return 1 / Math.sqrt(aiCourageMult(state));
}
/**
 * How far the PvE sizer's INTENT has been missing the outcome, as a multiplier on
 * the cost it aims a fight at. 1 for a fresh memory.
 *
 * Above 1 means "this player keeps beating fights cheaper than they were priced,
 * so aim higher"; below 1 means the opposite. Read by `tideMultiplier`, which is
 * the one place the target is decided.
 */
export function tideBias(state) {
  const b = state?.aiMemory?.tideBias;
  return Math.max(CONFIG.TIDE_BIAS_MIN, Math.min(CONFIG.TIDE_BIAS_MAX,
    Number.isFinite(b) && b > 0 ? b : 1));
}

/**
 * Grade the sizer on a fight that actually happened.
 *
 * `target` is the loss fraction the fight was aimed at; `realised` is what it cost.
 * If a fight priced to cost a fifth of your army cost a twentieth, the estimate was
 * four times too soft, and the bias moves so the next fight is aimed higher.
 *
 * WHY THE RATIO IS CLAMPED BEFORE IT IS USED. A free win — realised 0 — is an
 * infinite correction, and one lucky fight would peg the bias at its ceiling for
 * the rest of the game. Clamping first makes a walkover read as "about four times
 * too easy", which is both true enough and survivable.
 *
 * The EWMA rate is ASYMMETRIC: four consistent walkovers to press the world to its
 * ceiling, and relief that arrives sooner than that. Measured, pressing against a
 * 2%-cost walkover: 1.09 / 1.19 / 1.30 / 1.40 (capped). Easing after a 45% mauling:
 * 1.17 / 0.97 / 0.81 / 0.68 / 0.60 (floored). Escalation is earned; mercy is prompt.
 *
 * It is a FIXED POINT wherever realised meets the dial's target, which is the whole
 * contract: the bias moves the sizer's AIM until the OUTCOME lands on the difficulty
 * the player chose. A settled bias of 0.6 means "aiming at 12% is what actually
 * delivers 20% for this player", and that is a correct answer, not a drifted one. Escalation should be
 * earned and mercy should be prompt — and the symmetric version was measured to
 * reach the cap in two fights, which is twitching, not learning.
 *
 * Only ever called for a HUMAN attacker against a PvE defender, because that is the
 * only case the sizer prices — see actions.tideScaleDefender, which declines for an
 * AI attacker on purpose.
 */
export function recordTideOutcome(state, { target, realised }) {
  if (!state || !(target > 0) || !Number.isFinite(realised) || realised < 0) return;
  const m = (state.aiMemory ||= { disableRate: 0, battles: 0, courageMult: 1 });
  const ratio = Math.max(CONFIG.TIDE_BIAS_RATIO_MIN,
    Math.min(CONFIG.TIDE_BIAS_RATIO_MAX, realised / target));
  const now = tideBias(state);
  const want = now / ratio;               // where the bias must sit to hit target next time
  // Quick to ease, slow to press — see the rates in config for why.
  const a = want < now ? CONFIG.TIDE_BIAS_RATE_DOWN : CONFIG.TIDE_BIAS_RATE_UP;
  const next = now * (1 - a) + want * a;
  m.tideBias = Math.max(CONFIG.TIDE_BIAS_MIN, Math.min(CONFIG.TIDE_BIAS_MAX, next));
  m.tideFights = (m.tideFights || 0) + 1;
}
