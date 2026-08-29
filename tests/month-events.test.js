/**
 * month-events.test.js — "Month of the …" events (HoMM3 parity).
 *
 * From month 2 on (weeks 5, 9, 13, …) the dawn of a new month can bring a
 * stronger, rarer beat than a plain week: a bumper season for one creature, or
 * a deeper plague. It reuses the exact weekly-growth seam via an `event.month`
 * flag, so a Month of the <creature> simply multiplies harder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame } from '../src/core/GameState.js';
import { rollWeekEvent, weekEventMessage, weeklyCreatureGrowth, endTurn } from '../src/core/actions.js';

test('a month-boundary dawn (week 5) is flagged a monthly event; an ordinary week is not', () => {
  const s = newGame({ seed: 7 });
  s.day = 29; // week 5 — the dawn of month 2
  const mo = rollWeekEvent(s);
  assert.equal(mo.week, 5);
  assert.equal(mo.month, true, 'a month-boundary dawn is a monthly event');

  s.day = 15; // week 3 — mid-month
  const wk = rollWeekEvent(s);
  assert.ok(!wk.month, 'an ordinary week is never a monthly event');
});

test('the announcement reads as a Month, not a Week', () => {
  assert.match(weekEventMessage({ kind: 'creature', name: 'Griffin', week: 5, month: true }), /Month of the Griffin/);
  assert.match(weekEventMessage({ kind: 'plague', name: 'Plague', week: 9, month: true }), /Month of the Plague/);
  // Sanity: a plain week still reads as a Week.
  assert.match(weekEventMessage({ kind: 'creature', name: 'Griffin', week: 2 }), /Week of the Griffin/);
});

test('a Month of the <creature> multiplies growth harder than the weekly version', () => {
  const base = 10;
  const week = weeklyCreatureGrowth(base, 1, { kind: 'creature', creature: 'x', name: 'X' }, 'x');
  const month = weeklyCreatureGrowth(base, 1, { kind: 'creature', creature: 'x', name: 'X', month: true }, 'x');
  assert.equal(week, base * CONFIG.WEEK_CREATURE_MULT + CONFIG.WEEK_CREATURE_BONUS);
  assert.equal(month, base * CONFIG.MONTH_CREATURE_MULT + CONFIG.MONTH_CREATURE_BONUS);
  assert.ok(month > week, 'the monthly surge is stronger');
});

test('a Month of the Plague bites deeper than a plague week', () => {
  const base = 12;
  const week = weeklyCreatureGrowth(base, 1, { kind: 'plague' }, 'x');
  const month = weeklyCreatureGrowth(base, 1, { kind: 'plague', month: true }, 'x');
  assert.equal(week, Math.floor(base * CONFIG.WEEK_PLAGUE_MULT));
  assert.equal(month, Math.floor(base * CONFIG.MONTH_PLAGUE_MULT));
  assert.ok(month < week, 'the monthly plague is harsher');
});

test('advanceDay wires it up: rolling the calendar into month 2 sets a monthly event', () => {
  const s = newGame({ seed: 8 });
  let guard = 200;
  while (s.day < 29 && guard-- > 0) endTurn(s); // two endTurns per day
  assert.equal(s.day, 29, 'reached the dawn of month 2');
  assert.equal(s.weekEvent.month, true, 'the dawn rolled a monthly event');
  assert.match(weekEventMessage(s.weekEvent), /Month/, 'and it announces as a Month');
});
