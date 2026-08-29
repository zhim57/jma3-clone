/**
 * magic.js — magic-school MASTERY: what knowing a school does to its spells.
 *
 * The school bonuses that scale a NUMBER (damage, healing, duration) already
 * live inside `CombatEngine.castSpell`, because they only exist at the moment a
 * spell resolves. The two answers in this file are different: they are needed
 * *before* the cast, by people who are not the engine —
 *
 *   - what does this spell cost me?     (spellbook, `canCast`, the AI's budget,
 *                                        the adventure-map cast, the imp siphon)
 *   - who does this spell hit?          (the spellbook decides whether to arm
 *                                        target-picking or fire immediately)
 *
 * so they must have exactly ONE definition that every caller shares. A UI that
 * prints 6 mana while the engine charges 5, or a book that asks you to pick a
 * target for a spell the engine will mass-cast anyway, is the same defect as the
 * join warning that never called the join check (docs/JOIN_FEASIBILITY.md).
 *
 * Pure data in, pure data out: no Phaser, no game state, no rng, and nothing
 * here imports actions.js. `effectSummary` is here rather than in the scene for
 * the same reason — it is the answer to "what magic is on this stack", and a
 * headless test should be able to ask it.
 *
 * HoMM3 note: expert mass-casting is faithful to the original. The mana discount
 * is NOT a HoMM3 rule (schools there change only magnitude and duration); it is
 * a JMA3 addition, deliberately small — see CONFIG.SPELL_SCHOOL_DISCOUNT and
 * docs/MAGIC_SCHOOLS.md.
 */

import { SPELLS, SCHOOL_SKILL } from '../data/spells.js';
import { SKILL_LEVEL_NAMES } from '../data/skills.js';
import { CONFIG } from '../config.js';

/** The hero's level (0 = none, 1 Basic … 3 Expert) in THIS spell's own school. */
export function schoolLevel(hero, spellId) {
  const spell = SPELLS[spellId];
  const skill = spell && SCHOOL_SKILL[spell.school];
  if (!skill) return 0;
  return hero?.skills?.[skill] || 0;
}

/**
 * What this hero actually pays to cast this spell. Mastery of the spell's own
 * school takes a fraction off; the result is rounded and floored at 1, so no
 * spell is ever free however skilled the caster. A hero with no school skill
 * pays the catalog price exactly — zero regression.
 */
export function spellCost(hero, spellId) {
  const spell = SPELLS[spellId];
  if (!spell) return 0;
  const lvl = schoolLevel(hero, spellId);
  if (!lvl) return spell.manaCost;
  const off = CONFIG.SPELL_SCHOOL_DISCOUNT[lvl - 1] || 0;
  return Math.max(1, Math.round(spell.manaCost * (1 - off)));
}

/**
 * The stat deltas this spell applies when cast at school level `lvl`.
 *
 * `spell.effects` is the level-0 truth and the fallback for every stat with no
 * ladder; `spell.byLevel` overrides per stat from a 4-entry ladder indexed
 * [none, Basic, Advanced, Expert]. Always a FRESH object: the resolved effects
 * are stored on the stack, and handing out a reference to the catalog would let
 * one battle's mutation rewrite the spell for every game afterwards.
 */
export function effectsAtLevel(spellId, lvl) {
  const spell = SPELLS[spellId];
  if (!spell) return {};
  const out = { ...(spell.effects || {}) };
  if (!spell.byLevel) return out;
  const i = Math.max(0, Math.min(3, Math.trunc(lvl) || 0));
  for (const [stat, ladder] of Object.entries(spell.byLevel)) {
    out[stat] = ladder[i] ?? ladder[ladder.length - 1];
  }
  return out;
}

/** What THIS hero's cast of this spell actually does — the ladder at their level. */
export function spellEffects(hero, spellId) {
  return effectsAtLevel(spellId, schoolLevel(hero, spellId));
}

/**
 * The BASE rounds this spell lasts when cast at school level `lvl`, before the
 * Power bonus the engine adds on top.
 *
 * Every buff and debuff in the catalog used to last `3 + level` rounds — the
 * same for a Bloodlust as for a Blind, which removes a stack from the battle
 * altogether. `durationByLevel` replaces that one rule with a per-spell shape;
 * a spell without a table keeps the old `duration + level` exactly, so nothing
 * added later changes silently.
 */
export function durationAtLevel(spellId, lvl) {
  const spell = SPELLS[spellId];
  if (!spell) return 0;
  const i = Math.max(0, Math.min(3, Math.trunc(lvl) || 0));
  const table = spell.durationByLevel;
  if (!table) return (spell.duration || 1) + i;
  return table[i] ?? table[table.length - 1];
}

/** The base rounds THIS hero's cast would last (before the Power bonus). */
export function spellDuration(hero, spellId) {
  return durationAtLevel(spellId, schoolLevel(hero, spellId));
}

/**
 * One adventure-spell knob at this hero's mastery of the spell's own school.
 *
 * The ladders live in CONFIG (`*_BY_SCHOOL`) with the rest of the tuning, and
 * index 0 — the unskilled value — is what CONFIG's plain scalar is derived
 * from. Every reader of a laddered knob goes through here: the cast, the UI
 * overlay that draws the reachable tiles, and the AI's affordability check must
 * agree on the range, or the player is shown a green tile the engine refuses.
 */
export function adventureParam(hero, spellId, ladder) {
  return ladder[Math.max(0, Math.min(ladder.length - 1, schoolLevel(hero, spellId)))];
}

/**
 * The adventure knobs each spell ladders, for the spellbook. Purely descriptive
 * — the engine reads the ladders directly through `adventureParam`; this table
 * only says how to PRINT them. Note that a reward here is sometimes a SMALLER
 * number (movement spent per jump), so the note reads "movement a jump 200
 * (was 400)" and says nothing about which way is better; the player can see it.
 */
const ADVENTURE_LADDERS = {
  dimensionDoor: [
    { label: 'reach', ladder: CONFIG.DIM_DOOR_RANGE_BY_SCHOOL, fmt: (v) => `${v} tiles` },
    { label: 'casts a day', ladder: CONFIG.DIM_DOOR_USES_BY_SCHOOL, fmt: (v) => `${v}` },
    { label: 'movement a jump', ladder: CONFIG.DIM_DOOR_MP_BY_SCHOOL, fmt: (v) => `${v}` },
  ],
  townPortal: [
    { label: 'movement', ladder: CONFIG.TOWN_PORTAL_MP_BY_SCHOOL, fmt: (v) => (v ? `${v}` : 'free') },
  ],
  visions: [
    { label: 'radius', ladder: CONFIG.VISIONS_RANGE_BY_SCHOOL, fmt: (v) => `${v} tiles` },
  ],
  scuttleBoat: [
    { label: 'range', ladder: CONFIG.SCUTTLE_RANGE_BY_SCHOOL, fmt: (v) => `${v} tiles` },
  ],
  summonBoat: [
    { label: 'reach', ladder: CONFIG.SUMMON_BOAT_RANGE_BY_SCHOOL, fmt: (v) => `${v} tiles` },
  ],
  disguise: [
    { label: 'bluff', ladder: CONFIG.DISGUISE_BLUFF_BY_SCHOOL, fmt: (v) => `×${v}` },
  ],
};

/** Does an Expert of this spell's school scry BOTH map levels with View Air? */
export function viewAirSeesBothLevels(hero) {
  return schoolLevel(hero, 'viewAir') >= CONFIG.SPELL_MASS_MASTERY;
}

/**
 * Does this hero cast this spell on EVERY stack of the relevant side?
 * True only for spells the catalog flags `mass` and only at expert mastery of
 * their own school (CONFIG.SPELL_MASS_MASTERY) — Expert Air Magic hastes the
 * whole army, Expert Earth Magic slows the whole enemy line.
 */
export function isMassCast(hero, spellId) {
  const spell = SPELLS[spellId];
  if (!spell || !spell.mass) return false;
  return schoolLevel(hero, spellId) >= CONFIG.SPELL_MASS_MASTERY;
}

/** Which side a mass cast covers: 'friendly' for buffs and healing, 'enemy' for hexes. */
export function massSide(spellId) {
  return SPELLS[spellId]?.kind === 'debuff' ? 'enemy' : 'friendly';
}

/**
 * A one-line note on what mastery is doing to this spell for this hero, or null
 * when it is doing nothing. Written for a spellbook detail strip, so it names
 * the skill level the player would recognise.
 */
export function masteryNote(hero, spellId) {
  const spell = SPELLS[spellId];
  const lvl = schoolLevel(hero, spellId);
  if (!spell || !lvl) return null;
  const school = spell.school ? spell.school[0].toUpperCase() + spell.school.slice(1) : '';
  const head = `${SKILL_LEVEL_NAMES[lvl]} ${school} Magic`;
  const parts = [];
  if (isMassCast(hero, spellId)) {
    parts.push(massSide(spellId) === 'enemy' ? 'affects EVERY enemy stack' : 'affects EVERY friendly stack');
  }
  // Only the stats this level actually MOVED, quoted against the unskilled
  // number the spell's own description prints — otherwise the book says "+3
  // speed" while the cast gives +5 and the player has no way to see it.
  const now = spellEffects(hero, spellId);
  const base = effectsAtLevel(spellId, 0);
  for (const [stat, v] of Object.entries(now)) {
    if (base[stat] === v) continue;
    const was = typeof base[stat] === 'number'
      ? `${base[stat] > 0 ? '+' : ''}${base[stat]}`   // "+5 speed (was +3)", not "(was +3 speed)"
      : effectDetail({ [stat]: base[stat] });
    parts.push(base[stat] === undefined
      ? effectDetail({ [stat]: v })
      : `${effectDetail({ [stat]: v })} (was ${was})`);
  }
  // Duration, when this spell's ladder moved it. Reported even when it moved
  // DOWN (Blind, Frenzy), because a shorter lockout is a real thing to know
  // before you spend the mana.
  const lasts = spellDuration(hero, spellId);
  const plainLasts = durationAtLevel(spellId, 0);
  if (spell.duration && lasts !== plainLasts) {
    parts.push(`lasts ${lasts} rounds (was ${plainLasts})`);
  }
  // Adventure spells ladder parameters rather than stat deltas, and the reward
  // is sometimes a SMALLER number (movement spent), so they are printed from
  // their own table rather than diffed like effects.
  for (const knob of ADVENTURE_LADDERS[spellId] || []) {
    const v = adventureParam(hero, spellId, knob.ladder);
    if (v === knob.ladder[0]) continue;
    parts.push(`${knob.label} ${knob.fmt(v)} (was ${knob.ladder[0]})`);
  }
  if (spellId === 'viewAir' && viewAirSeesBothLevels(hero)) parts.push('scries BOTH map levels');
  const saved = spell.manaCost - spellCost(hero, spellId);
  if (saved > 0) parts.push(`−${saved} mana`);
  if (!parts.length) return null;
  return `${head}: ${parts.join(', ')}`;
}

/**
 * The magic currently riding on a battlefield stack, newest last, as plain data:
 * `[{ spellId, name, rounds, hostile }]`. `unit.effects` is the engine's own
 * store, so this reports what the engine will actually apply — it does not model
 * effects a second time.
 */
export function effectSummary(unit) {
  return (unit?.effects || []).map((e) => ({
    spellId: e.spellId,
    name: SPELLS[e.spellId]?.name || e.spellId,
    rounds: e.rounds,
    hostile: SPELLS[e.spellId]?.kind === 'debuff',
    effects: e.effects || {},
  }));
}

/**
 * The MOOD of the magic on a stack: 'hostile' if anything hexes it, 'friendly'
 * if it carries only blessings, null if it is clean.
 *
 * Hostile wins a tie on purpose. A stack that is both blessed and cursed is a
 * stack in trouble, and the badge exists to warn — a green plate over a blinded
 * stack would be worse than no plate at all. Lives here rather than in the
 * combat scene so the rule is one function and a headless test can ask it.
 */
export function effectMood(unit) {
  let friendly = false;
  for (const e of unit?.effects || []) {
    if (SPELLS[e.spellId]?.kind === 'debuff') return 'hostile';
    friendly = true;
  }
  return friendly ? 'friendly' : null;
}

/** Human-readable stat line for one active effect, e.g. "+3 speed" / "max damage". */
export function effectDetail(fx) {
  const bits = [];
  for (const [stat, v] of Object.entries(fx || {})) {
    if (stat === 'blessed') bits.push('always max damage');
    else if (stat === 'cursed') bits.push('always min damage');
    else if (stat === 'blinded') bits.push('cannot act');
    else bits.push(`${v > 0 ? '+' : ''}${v} ${stat}`);
  }
  return bits.join(', ');
}

/**
 * The View Earth sighting a player currently holds, with the strength it should be
 * drawn at — or null when there is none, or it has lapsed.
 *
 * ONE definition because there are two readers: the map paints flags and shields
 * over the fog, and the minimap paints hollow marks in the same places. A fade rule
 * written twice is a fade rule that drifts, and the two surfaces disagreeing about
 * whether a sighting is still valid would be the worst kind of bug — the map says
 * the enemy is there and the panel says nothing is.
 *
 * Full strength on the day it was cast, thinning as it ages, gone at
 * CONFIG.VIEW_EARTH_DAYS. Never quite transparent while still valid: a sighting on
 * its last day should read as faint, not as absent, or the player cannot tell "old
 * news" from "no news".
 */
export function scrySighting(state, playerIndex = 0) {
  const scry = state?.players?.[playerIndex]?.scry;
  if (!scry?.marks?.length) return null;
  const age = (state.day || 0) - (scry.day || 0);
  if (age < 0 || age >= CONFIG.VIEW_EARTH_DAYS) return null;
  return { marks: scry.marks, age, alpha: 0.35 + 0.65 * (1 - age / CONFIG.VIEW_EARTH_DAYS) };
}
