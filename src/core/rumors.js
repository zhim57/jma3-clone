/**
 * rumors.js — Tavern rumors: weekly flavor + soft intel, read entirely from
 * existing game state (pure, no rng, no mutation), so it round-trips saves for
 * free and is trivially testable. The tavern screen renders these lines so a
 * visit between hires is worth something: a hint at the strongest rival abroad,
 * a whisper of the Grail's whereabouts once the obelisk hunt is underway, and
 * the sign of the current week.
 *
 * `tavernRumors(state, playerIndex)` returns an ordered array of one-line
 * strings — always at least one (an atmospheric line), never player-identifying
 * secrets the fog wouldn't already permit (enemy strength is qualitative, and
 * the Grail hint is gated on the visiting player's OWN obelisk progress).
 */

import { armyValue } from './heroUtils.js';
import { weekOf } from './GameState.js';
import { obeliskProgress, grailKnown } from './actions.js';

// Atmospheric one-liners, rotated deterministically by week so the tavern feels
// alive on repeat visits without ever affecting play.
const ATMOSPHERE = [
  'The alehouse is loud with soldiers between campaigns.',
  'A bard tunes a lute in the corner, angling for coin.',
  'Two mercenaries argue over a map stained with ale.',
  'The keeper polishes a tankard and eyes your purse.',
  'A hooded scout nurses a drink and says nothing.',
  'Dice clatter across a far table; someone curses their luck.',
  'A courier stamps mud from their boots by the fire.',
];

/** A qualitative read on an enemy champion's host — never exact numbers. */
function strengthEpithet(v) {
  if (v >= 20000) return ', whose host is said to darken the hills';
  if (v >= 8000) return ', who leads a formidable army';
  if (v >= 2000) return ', at the head of a growing warband';
  return ', still gathering their first swords';
}

/** Rough compass placement of the buried Grail, from its tile vs map centre. */
function grailQuadrant(state) {
  const g = state.map.grail;
  const { w, h } = state.map;
  const ns = g.y < h * 0.4 ? 'north' : g.y > h * 0.6 ? 'south' : '';
  const ew = g.x < w * 0.4 ? 'west' : g.x > w * 0.6 ? 'east' : '';
  if (!ns && !ew) return 'near the very heart of the land';
  if (ns && ew) return `somewhere to the ${ns}-${ew}`;
  return `somewhere to the ${ns || ew}`;
}

/** The sign of the current week (or month), from the rolled week event (if any). */
function weekRumor(wk) {
  const span = wk.month ? 'a whole season' : 'this week';
  if (wk.kind === 'creature') return `The beasts stir — ${wk.name} broods swell in every den for ${span}.`;
  if (wk.kind === 'plague') return `A pox walks the land; the dens breed poorly for ${span}.`;
  return wk.month ? `A new month opens under the sign of the ${wk.name}.` : `A quiet week passes under the sign of the ${wk.name}.`;
}

/**
 * Tavern rumor lines for the player visiting `town.owner`'s tavern.
 * Ordered: one atmospheric line, then whatever soft intel applies.
 */
export function tavernRumors(state, playerIndex) {
  const me = state.players[playerIndex];
  const myTeam = me?.team ?? playerIndex;
  const lines = [ATMOSPHERE[(weekOf(state.day) - 1) % ATMOSPHERE.length]];

  // The strongest rival champion abroad — named, strength qualitative. Allies
  // (same team) are never gossiped about as a threat.
  let champ = null;
  for (const h of Object.values(state.heroes)) {
    const owner = state.players[h.owner];
    if (!owner || h.owner === playerIndex) continue;
    if ((owner.team ?? h.owner) === myTeam) continue;
    const v = armyValue(h.army);
    if (!champ || v > champ.v) champ = { hero: h, v };
  }
  if (champ) lines.push(`They speak of ${champ.hero.name}${strengthEpithet(champ.v)}.`);

  // The Grail hunt — gated on the VISITING player's own obelisk progress, so it
  // never leaks intel they haven't earned. A quadrant hint at the halfway mark;
  // once every obelisk is read, the tile is already theirs to dig.
  if (state.map.grail) {
    const { seen, total } = obeliskProgress(state, playerIndex);
    if (grailKnown(state, playerIndex)) {
      // Name the tile. The player has read every obelisk, so this is intel they
      // have already earned — and the announcement that first gave it to them
      // was a toast and a log line, both of which are gone by the time they are
      // standing in a tavern wondering where they were supposed to dig. A rumor
      // board that says "you know where it is" without saying where is a joke at
      // the player's expense.
      const g = state.map.grail;
      lines.push(`Every obelisk is read — the Grail lies buried at (${g.x}, ${g.y}). Take up the spade.`);
    } else if (total > 0 && seen >= Math.ceil(total / 2)) {
      lines.push(`The obelisks you've read whisper the Grail rests ${grailQuadrant(state)}.`);
    }
  }

  // The sign of the current week (only set once the first week has turned over).
  if (state.weekEvent) lines.push(weekRumor(state.weekEvent));

  return lines;
}
