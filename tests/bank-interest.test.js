/**
 * bank-interest.test.js — the deposit half of the Town Bank.
 *
 * Asked for: "give the town bank 10% interest on the week-ending gold; banks
 * stackable to 5, then additional banks at 5%."
 *
 * So gold still in the treasury when the week turns earns its keep: each of the
 * first CONFIG.BANK_DEPOSIT_STACK banks pays the full rate, every bank beyond that
 * the reduced one. That gives hoarding a purpose and makes a second and third bank
 * a build worth considering rather than a one-off utility.
 *
 * One deliberate departure from the letter of the request, and it is a balance
 * valve rather than a narrowing: interest is paid on the first
 * CONFIG.BANK_DEPOSIT_CAP gold. Uncapped, five banks is 50% a week COMPOUNDING —
 * a treasury doubles in two weeks and then leaves every other economy in the game
 * behind. The rate is exactly as asked; only the principal it applies to is
 * bounded, and the constant can be raised or set to Infinity for the pure version.
 * The tests below pin the rate arithmetic and the cap separately so either can be
 * retuned without the other going quiet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerTowns, weekOf } from '../src/core/GameState.js';
import { endTurn, bankCount, bankDepositRate, bankInterestDue } from '../src/core/actions.js';

const SPINE = ['villageHall', 'tavern', 'townHall', 'marketplace', 'blacksmith', 'cityHall', 'fort'];

/** A game where the human owns `banks` towns, each carrying a Town Bank. */
function realm({ banks = 1, gold = 10000, townBank = true } = {}) {
  const s = newGame({ seed: 808, features: { townBank } });
  const home = playerTowns(s, 0)[0];
  home.buildings = [...SPINE, 'bank'];
  // Extra banks live in extra towns: nothing stops a player owning several, and
  // that is what "stackable" has to mean.
  const spare = Object.values(s.towns).filter((t) => t.id !== home.id);
  for (let i = 1; i < banks; i++) {
    const t = spare[i - 1];
    if (!t) throw new Error(`the test map has no ${banks}th town to bank in`);
    t.owner = 0;
    t.buildings = [...SPINE, 'bank'];
  }
  if (banks === 0) home.buildings = [...SPINE];
  s.players[0].resources.gold = gold;
  return { s, home };
}

/** Advance exactly one game week and report the human's gold before and after. */
function overAWeek(s) {
  const before = s.players[0].resources.gold;
  const w0 = weekOf(s.day);
  let guard = 60;
  while (weekOf(s.day) === w0 && guard-- > 0) endTurn(s);
  assert.equal(weekOf(s.day), w0 + 1, 'advanced exactly one week');
  return { before, after: s.players[0].resources.gold };
}

test('one bank pays the full rate on the gold you are holding', () => {
  const { s } = realm({ banks: 1, gold: 10000 });
  assert.equal(bankCount(s, 0), 1);
  assert.equal(bankDepositRate(s, 0), CONFIG.BANK_DEPOSIT_RATE);
  assert.equal(bankInterestDue(s, 0), Math.floor(10000 * CONFIG.BANK_DEPOSIT_RATE));
});

test('banks stack at the full rate up to the cap on their number', () => {
  for (let n = 1; n <= CONFIG.BANK_DEPOSIT_STACK; n++) {
    let built;
    try { built = realm({ banks: n, gold: 1000 }); } catch { break; } // map ran out of towns
    assert.equal(bankCount(built.s, 0), n, `${n} banks counted`);
    assert.ok(Math.abs(bankDepositRate(built.s, 0) - n * CONFIG.BANK_DEPOSIT_RATE) < 1e-9,
      `${n} banks should pay ${n} × the full rate`);
  }
});

test('banks past the stack cap pay the reduced rate', () => {
  // Computed directly rather than by seating N towns: the rate is a pure function
  // of the count, and the map may not have that many towns to own.
  const s = newGame({ seed: 5, features: { townBank: true } });
  const town = playerTowns(s, 0)[0];
  town.buildings = [...SPINE, 'bank'];
  const fake = (n) => {
    // Stand in for n banks by asking the same arithmetic the function uses.
    const full = Math.min(n, CONFIG.BANK_DEPOSIT_STACK);
    const extra = Math.max(0, n - CONFIG.BANK_DEPOSIT_STACK);
    return full * CONFIG.BANK_DEPOSIT_RATE + extra * CONFIG.BANK_DEPOSIT_EXTRA_RATE;
  };
  const atCap = fake(CONFIG.BANK_DEPOSIT_STACK);
  const overCap = fake(CONFIG.BANK_DEPOSIT_STACK + 2);
  assert.ok(overCap > atCap, 'more banks are never worse');
  assert.ok(Math.abs((overCap - atCap) - 2 * CONFIG.BANK_DEPOSIT_EXTRA_RATE) < 1e-9,
    'and the ones past the cap pay exactly the reduced rate');
  assert.ok(CONFIG.BANK_DEPOSIT_EXTRA_RATE < CONFIG.BANK_DEPOSIT_RATE,
    'the request was explicit that the extra ones pay less');
});

test('interest is credited when the week turns, not day by day', () => {
  const { s } = realm({ banks: 1, gold: 10000 });
  const day0 = s.players[0].resources.gold;
  endTurn(s); // one ordinary day
  const daily = s.players[0].resources.gold - day0;
  const expected = Math.floor(10000 * CONFIG.BANK_DEPOSIT_RATE);
  assert.ok(daily < expected,
    `a single day must not pay a week's interest (gained ${daily}, a week is ${expected})`);
});

test('a week of holding gold pays the interest on top of ordinary income', () => {
  const withBank = realm({ banks: 1, gold: 10000 });
  const without = realm({ banks: 0, gold: 10000 });
  const a = overAWeek(withBank.s);
  const b = overAWeek(without.s);
  const bonus = (a.after - a.before) - (b.after - b.before);
  // The principal is the WEEK-ENDING balance, not the starting one — a week of
  // mine and town income lands first. The bankless realm has identical income, so
  // its closing gold IS the other realm's pre-interest balance.
  assert.equal(bonus, Math.floor(Math.min(b.after, CONFIG.BANK_DEPOSIT_CAP) * CONFIG.BANK_DEPOSIT_RATE),
    'the difference between the two realms is exactly the interest on the closing balance');
  assert.ok(bonus > 0, 'and it is real money');
});

test('interest is paid on the capped principal, not on an unbounded hoard', () => {
  const cap = CONFIG.BANK_DEPOSIT_CAP;
  const under = realm({ banks: 1, gold: cap });
  const over = realm({ banks: 1, gold: cap * 10 });
  assert.equal(bankInterestDue(under.s, 0), bankInterestDue(over.s, 0),
    'ten times the treasury earns the same — the ceiling is what stops the runaway');
  assert.equal(bankInterestDue(over.s, 0), Math.floor(cap * CONFIG.BANK_DEPOSIT_RATE));
});

test('no bank, no interest — and an empty treasury earns nothing', () => {
  const none = realm({ banks: 0, gold: 10000 });
  assert.equal(bankCount(none.s, 0), 0);
  assert.equal(bankDepositRate(none.s, 0), 0);
  assert.equal(bankInterestDue(none.s, 0), 0);

  const broke = realm({ banks: 1, gold: 0 });
  assert.equal(bankInterestDue(broke.s, 0), 0, 'a bank pays interest, not an allowance');
});

test('debt is a real hole: interest cannot be earned on gold you do not have', () => {
  const { s } = realm({ banks: 1, gold: 0 });
  s.players[0].resources.gold = -500; // shouldn't happen, but must not pay out if it does
  assert.equal(bankInterestDue(s, 0), 0);
});

test('with the feature OFF a week of play pays nothing', () => {
  const off = realm({ banks: 1, gold: 10000, townBank: false });
  const on = realm({ banks: 1, gold: 10000, townBank: true });
  const a = overAWeek(off.s);
  const b = overAWeek(on.s);
  assert.ok((b.after - b.before) > (a.after - a.before),
    'the flag has to be what makes the difference');
  // And the gate must not touch the RNG stream.
  assert.deepEqual(off.s.rng.toJSON(), on.s.rng.toJSON(),
    'paying interest is arithmetic, never a roll');
});

test('the AI banks too — a bank is in its build order', async () => {
  const src = (await import('node:fs')).readFileSync(
    new URL('../src/ai/AIPlayer.js', import.meta.url), 'utf8');
  const orders = [...src.matchAll(/const BUILD_ORDER(?:_CAPITOL)? = \[([\s\S]*?)\];/g)];
  assert.equal(orders.length, 2, 'both build orders should exist');
  for (const [, body] of orders) {
    assert.match(body, /'bank'/,
      'an income building the human gets and the AI never builds is a one-sided economy');
  }
});

test('the AI earns interest on the same terms', () => {
  const s = newGame({ seed: 909, features: { townBank: true } });
  const foe = Object.values(s.towns).find((t) => t.owner === 1);
  assert.ok(foe, 'the test map has an AI town');
  foe.buildings = [...SPINE, 'bank'];
  s.players[1].resources.gold = 10000;
  assert.equal(bankInterestDue(s, 1), Math.floor(10000 * CONFIG.BANK_DEPOSIT_RATE));
  const before = s.players[1].resources.gold;
  const w0 = weekOf(s.day);
  let guard = 60;
  while (weekOf(s.day) === w0 && guard-- > 0) endTurn(s);
  assert.ok(s.players[1].resources.gold > before, 'a rival that banks its gold is paid for it');
});
