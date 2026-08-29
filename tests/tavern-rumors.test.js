/**
 * tavern-rumors.test.js — the tavern's weekly flavor + soft intel.
 *
 * tavernRumors reads existing state only (pure, no rng, no mutation): an
 * atmospheric line always, plus a named-but-qualitative read on the strongest
 * rival abroad, a Grail hint gated on the VISITING player's own obelisk
 * progress, and the sign of the current week.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { tavernRumors } from '../src/core/rumors.js';

const HUMAN = 0;
const AI = 1;
const stack = (creature, count) => [{ creature, count, hurt: 0 }, null, null, null, null, null, null];
const twoPlayer = (seed, teams) => newGame({ seed, players: [
  { faction: 'castle', isHuman: true, team: teams ? teams[0] : 0 },
  { faction: 'inferno', isHuman: false, team: teams ? teams[1] : 1 },
] });

test('always yields at least one (atmospheric) line, and never mutates state', () => {
  const s = twoPlayer(1);
  const before = JSON.stringify(s);
  const lines = tavernRumors(s, HUMAN);
  assert.ok(Array.isArray(lines) && lines.length >= 1, 'at least one rumor');
  assert.ok(lines.every((l) => typeof l === 'string' && l.length), 'all non-empty strings');
  assert.equal(JSON.stringify(s), before, 'tavernRumors is pure — state is untouched');
});

test('names the strongest rival champion, with strength kept qualitative', () => {
  const s = twoPlayer(2);
  const villain = playerHeroes(s, AI)[0];
  villain.army = stack('archangel', 40); // a formidable, unmistakable host
  const lines = tavernRumors(s, HUMAN).join('\n');
  assert.ok(lines.includes(villain.name), 'the rival champion is named');
  assert.ok(/army|host|warband|swords/.test(lines), 'strength is described, not numbered');
  assert.ok(!/\b40\b/.test(lines), 'no exact troop counts leak');
});

test('an ally is never gossiped about as a rival threat', () => {
  const s = twoPlayer(3, [0, 0]); // both on team 0
  const ally = playerHeroes(s, AI)[0];
  ally.army = stack('archangel', 40);
  const lines = tavernRumors(s, HUMAN).join('\n');
  assert.ok(!lines.includes(ally.name), 'a teammate is not named as a rival');
});

test('the Grail hint is gated on the visiting player\'s own obelisk progress', () => {
  const s = twoPlayer(4);
  s.map.grail = { x: 4, y: 4 }; // a far NW tile on a 44×36 map
  s.map.objects = {
    OB1: { id: 'OB1', type: 'booster', boosterType: 'obelisk', x: 5, y: 5 },
    OB2: { id: 'OB2', type: 'booster', boosterType: 'obelisk', x: 6, y: 6 },
    OB3: { id: 'OB3', type: 'booster', boosterType: 'obelisk', x: 7, y: 7 },
    OB4: { id: 'OB4', type: 'booster', boosterType: 'obelisk', x: 8, y: 8 },
  };

  // Below halfway: no Grail rumor at all.
  s.players[HUMAN].obeliskIds = ['OB1'];
  assert.ok(!/Grail/.test(tavernRumors(s, HUMAN).join('\n')), 'too early — no Grail whisper');

  // At/over halfway: a direction hint (this grail sits to the north-west).
  s.players[HUMAN].obeliskIds = ['OB1', 'OB2'];
  const hint = tavernRumors(s, HUMAN).join('\n');
  assert.ok(/Grail/.test(hint) && /north-west/.test(hint), 'halfway → a quadrant hint');

  // Every obelisk read: the tile is known — a "take up the spade" line.
  s.players[HUMAN].obeliskIds = ['OB1', 'OB2', 'OB3', 'OB4'];
  assert.ok(/spade/.test(tavernRumors(s, HUMAN).join('\n')), 'fully read → dig prompt');
});

test('the week rumor reflects the rolled week event', () => {
  const s = twoPlayer(5);
  s.weekEvent = { kind: 'creature', name: 'Griffin', creature: 'griffin', week: 2 };
  assert.ok(/Griffin/.test(tavernRumors(s, HUMAN).join('\n')), 'a creature week is announced');
  s.weekEvent = { kind: 'plague', name: 'Plague', week: 3 };
  assert.ok(/pox|plague/i.test(tavernRumors(s, HUMAN).join('\n')), 'a plague week is announced');
});
