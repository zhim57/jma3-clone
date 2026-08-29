/**
 * ai-brain-log.test.js — the AI flight recorder (src/ai/aiLog.js).
 *
 * The recorder exists because an AI economy failure is invisible from the
 * outside: a rival that stopped taking mines and a rival with no mines left to
 * take look exactly the same on the map. These tests pin the three things that
 * make it a diagnosis rather than a noticeboard —
 *
 *   · every AI turn is recorded, and the record names what each hero DECIDED;
 *   · a prize the AI passed over is attributed to the NAMED gate that rejected
 *     it, so "why did it stop" has an answer;
 *   · the log is bounded, save-safe, and never changes how the game plays.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, playerTowns, levelObjects, serialize, deserialize } from '../src/core/GameState.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { aiLog, aiLogEntries, aiLogLines, aiDiagnosis, vetoText, AI_LOG_MAX } from '../src/ai/aiLog.js';
import { setTelemetry } from '../src/ai/telemetry.js';

const SEED = 4242;
const AI = 1;

function runTurn(state, playerIndex = AI) {
  const ai = new AITurnController(state, playerIndex);
  let guard = 400;
  let r;
  do {
    r = ai.next();
    if (r.type === 'combat') ai.autoFight(r.context);
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return ai;
}

// ---------------------------------------------------------------------------

test('an AI turn writes a realm header carrying the mine census', () => {
  const s = newGame({ seed: SEED });
  runTurn(s);

  const turns = aiLogEntries(s, { player: AI, kind: 'turn' });
  assert.equal(turns.length, 1, 'exactly one header per turn');
  const t = turns[0];
  assert.equal(t.day, s.day);
  assert.equal(typeof t.gold, 'number');
  assert.ok(t.minesOnMap > 0, 'a generated map has mines to count');
  assert.ok(t.minesHeld <= t.minesOnMap, 'cannot hold more than exist');
  assert.equal(typeof t.minesFlagged, 'number', 'the headline number is recorded');
  assert.ok(t.bestArmy > 0, 'the realm knows its own strength');
});

test('each hero records its decision — a goal, a hold, or nothing in reach', () => {
  const s = newGame({ seed: SEED });
  runTurn(s);

  const heroes = aiLogEntries(s, { player: AI, kind: 'hero' });
  assert.ok(heroes.length >= 1, 'every hero that took a turn is recorded');
  for (const h of heroes) {
    assert.equal(typeof h.hero, 'string');
    assert.ok(h.goal || h.decision, 'a hero either marched somewhere or said why not');
    if (h.goal) {
      assert.equal(typeof h.goal.what, 'string', 'the goal says what KIND of prize it is');
      assert.ok(h.goal.dist >= 0);
    }
    assert.equal(typeof h.mines.seen, 'number', 'mines in view are always counted');
  }
});

test('a prize the AI passes over is attributed to the gate that rejected it', () => {
  const s = newGame({ seed: SEED });
  // Ring the AI in: a colossal enemy hero parked next to its capital puts every
  // nearby prize inside a superior army's strike range, which is the `menaced`
  // gate — the exact failure mode reported ("it senses decline in the army so
  // it stops developing").
  const town = playerTowns(s, AI)[0];
  const foe = playerHeroes(s, 0)[0];
  foe.x = town.x + 2;
  foe.y = town.y;
  foe.z = town.z ?? 0;
  foe.army = [{ creature: 'archangel', count: 400, hurt: 0 }];
  // Put an unclaimed mine right next to the AI's capital so there IS something
  // to pass over.
  const objs = levelObjects(s, town.z ?? 0);
  const mine = Object.values(objs).find((o) => o.type === 'mine' && o.owner !== AI);
  assert.ok(mine, 'the generated map has an unclaimed mine');
  runTurn(s);

  const heroes = aiLogEntries(s, { player: AI, kind: 'hero' });
  const anyVetoed = heroes.some((h) => h.vetoed > 0);
  assert.ok(anyVetoed, 'prizes were passed over, and the count says so');
  // Every recorded veto carries a NAME, never a bare number — that is the whole
  // point of the tally.
  for (const h of heroes) {
    for (const [why, n] of Object.entries(h.vetoes)) {
      // `unaffordable` joined the vocabulary with the Seer Hut: "we walked past
      // because the treasury is short" is a different diagnosis from "it was
      // worth nothing", and the tally exists to tell those apart.
      assert.match(why, /^(menaced|guarded|unreachable|blacklisted|avoided|spent|owned|worthless|unaffordable)$/,
        `veto reasons are from the fixed vocabulary, got "${why}"`);
      assert.ok(n > 0);
    }
  }
  const seenMines = heroes.reduce((n, h) => n + h.mines.seen, 0);
  assert.ok(seenMines > 0, 'unclaimed mines in view are counted, so "none in view" is distinguishable');
});

test('the diagnosis names the dominant reason mines went untaken', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  const foe = playerHeroes(s, 0)[0];
  foe.x = town.x + 2;
  foe.y = town.y;
  foe.z = town.z ?? 0;
  foe.army = [{ creature: 'archangel', count: 400, hurt: 0 }];
  runTurn(s);

  const text = aiDiagnosis(s, AI);
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  // It always resolves to one of the four shapes — never a shrug.
  assert.match(text, /Economy moving|no unclaimed mine|No heroes|in view|outranked|No AI turn/i);
});

test('aiLogLines renders newest-first and can be narrowed to one realm', () => {
  const s = newGame({ seed: SEED, players: [{ faction: 'castle', isHuman: true }, { faction: 'inferno' }, { faction: 'castle' }] });
  runTurn(s, 1);
  runTurn(s, 2);

  const all = aiLogLines(s);
  assert.ok(all.length > 0);
  const only1 = aiLogLines(s, { player: 1 });
  assert.ok(only1.length > 0 && only1.length < all.length, 'the filter actually narrows');
  // Newest first: realm 2 moved last, so an unfiltered read leads with it.
  assert.match(all[0], new RegExp(s.players[2].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('vetoText sorts the biggest reason first and drops empties', () => {
  assert.equal(vetoText({}), '');
  assert.equal(vetoText({ guarded: 0 }), '');
  assert.equal(vetoText({ guarded: 2, menaced: 9 }), "in an enemy army's reach ×9, guarded too heavily ×2");
});

test('the log is a bounded ring that round-trips a save with no version bump', () => {
  const s = newGame({ seed: SEED });
  for (let i = 0; i < AI_LOG_MAX + 40; i++) aiLog(s, { kind: 'note', player: AI, text: `n${i}` });
  assert.equal(s.aiLog.length, AI_LOG_MAX, 'the ring never grows past its bound');
  assert.equal(s.aiLog[s.aiLog.length - 1].text, `n${AI_LOG_MAX + 39}`, 'the newest entry survives');

  const round = deserialize(serialize(s));
  assert.equal(round.aiLog.length, AI_LOG_MAX, 'and it survives a save/load as plain data');
  assert.equal(round.aiLog[0].text, s.aiLog[0].text);
});

test('recording changes nothing about how the game plays', () => {
  // The strongest form of the claim: run the SAME seed with recording on and with
  // it off. The recorder draws no rng and the engine never reads it back, so the
  // two worlds must be byte-identical once the log itself is set aside. (Comparing
  // two recording runs would only prove determinism, not that recording is free.)
  const a = newGame({ seed: SEED });
  const b = newGame({ seed: SEED });
  setTelemetry(b, false);
  runTurn(a);
  runTurn(b);
  // Drop the recorder's own fields and normalise key ORDER: the two states got
  // their telemetry keys at different moments, so a raw JSON compare would differ on
  // insertion order alone and say nothing about the world.
  const strip = (s) => {
    const o = JSON.parse(serialize(s));
    // telemetryBattleSeq is the battle-id counter — recorder bookkeeping like
    // telemetrySeq, written only when a battle is recorded, so only run `a`
    // can ever carry it.
    for (const k of ['aiLog', 'telemetry', 'telemetrySeq', 'telemetryOff', 'telemetryBattleSeq']) delete o[k];
    return JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
  };
  assert.equal(strip(a), strip(b), 'same seed, same turn, same world — recording is free');
  assert.ok((a.aiLog || []).length > 0, 'and the log was in fact written');
  assert.equal((b.telemetry || []).length, 0, 'while the opted-out game recorded nothing');
});
