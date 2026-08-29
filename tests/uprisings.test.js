/**
 * uprisings.test.js — the bought rebellion.
 *
 * The rule under test, in the words that set it: "I need the vassals either one by one
 * or two or three of them to suddenly decide from time to time to overthrow me and take
 * my castles — an outside power finances them and they can buy big armies (200k, 300k of
 * gold each rebel ruler), so they can quickly amass huge armies and attack me… once they
 * wage a war I can take also their castles and eventually they beg for mercy and one
 * castle, at that time I can choose one that I wish to give to them."
 *
 * Five properties are load-bearing, and each is a way the mechanic could be built and be
 * worthless:
 *
 *   INERT with no pacts. A game that never took an oath must not be able to tell this
 *   module is compiled in — no state key, and no rng drawn from the world stream.
 *
 *   THE CHEST IS THE FEATURE. A revolt that hands a one-town realm its own banner back
 *   is what pacts.js already did and is not a rebellion. The test asserts the gold, the
 *   host, and that the host is standing in the FIELD.
 *
 *   THEY RISE TOGETHER, one to three, and WHICH is not a roll — the neglected vassal is
 *   the one somebody else pays for.
 *
 *   A FRESH OATH IS SAFE. Sworn a fortnight ago and rising today would make taking an
 *   oath a worse deal than finishing them.
 *
 *   AND MERCY PUTS THEM BACK. The lord chooses the castle; the realm returns sworn, and
 *   the map carries the same realms it started with.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerTowns, playerHeroes } from '../src/core/GameState.js';
import { CREATURES } from '../src/data/creatures.js';
import { armyValue } from '../src/core/heroUtils.js';
import { Rng } from '../src/core/rng.js';
import {
  signPact, allPacts, isVassal, suzerainPact, vassalsOf,
} from '../src/core/pacts.js';
import {
  allUprisings, uprisingOf, inUprising, uprisingsAgainst, seducibility, uprisingCandidates,
  hegemony, uprisingChance, foreignBackerFor, warChestFor, rebelHost, musterRebelHost,
  fireUprising, uprisingBias, tickUprisings, endUprising, uprisingReport, maxRebelsFor,
  mercyPleas, mercyPlea, mercyTownChoices, grantMercy, refuseMercy, clearMercyPlea,
} from '../src/core/uprisings.js';

const PLAYERS = [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
  { faction: 'inferno', isHuman: false, team: 2 },
  { faction: 'inferno', isHuman: false, team: 3 },
];
const game = (seed = 5) => newGame({ seed, players: PLAYERS, mapW: 52, mapH: 44 });

/** Give a realm a second town, so a lord has something to hand back. */
function planted(s, owner, from = null) {
  const spare = Object.values(s.towns).find((t) => t.owner !== owner && (from == null || t.owner === from));
  if (spare) spare.owner = owner;
  return spare;
}

/**
 * Make a realm worth conspiring against: nobody buys a rebellion against a lord who
 * has not won anything yet (UPRISING_MIN_LORD_FORCE), so every test about the ODDS has
 * to seat a real hegemon first.
 */
function hegemon(s, lord = 0) {
  for (const h of Object.values(s.heroes)) {
    if (h.owner === lord) h.army = [{ creature: 'archangel', count: 120, hurt: 0 }];
  }
  return s;
}

/** Strip a realm of its land — what beating a rebel back to nothing looks like. */
function unland(s, index, to = 0) {
  for (const t of playerTowns(s, index)) t.owner = to;
}

const goldOf = (s, i) => s.players[i].resources.gold || 0;
const fieldForce = (s, i) => Math.max(0, ...playerHeroes(s, i).map((h) => armyValue(h.army)), 0);

// ---- inert until an oath exists ---------------------------------------------

test('a game that never took an oath cannot tell this module is compiled in', () => {
  const s = game();
  const calls = s.rng.calls;
  assert.deepEqual(tickUprisings(s), [], 'nothing to report');
  assert.equal(s.rng.calls, calls, 'and no roll taken out of the world stream');
  assert.equal(s.uprisings, undefined, 'not even an empty array on state');
  assert.equal(s.mercyPleas, undefined);
  assert.equal(allUprisings(s).length, 0);
});

test('and a lord whose oaths are all fresh is left alone', () => {
  const s = game();
  signPact(s, 0, 1);
  assert.deepEqual(uprisingCandidates(s, 0), [], 'a fortnight-old oath is not for sale');
  assert.equal(uprisingChance(s, 0), 0);
  const calls = s.rng.calls;
  assert.deepEqual(tickUprisings(s), []);
  assert.equal(s.rng.calls, calls);
  assert.equal(allPacts(s).length, 1, 'the pact stands');
});

test('the off-switch is honoured, and an absent one reads as ON', () => {
  const s = hegemon(game());
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  assert.ok(uprisingChance(s, 0) > 0, 'absent field: live');
  s.vassalUprisings = false;
  assert.equal(uprisingChance(s, 0), 0);
  assert.deepEqual(tickUprisings(s), []);
  assert.equal(allPacts(s).length, 1);
});

// ---- who gets bought --------------------------------------------------------

test('the vassal you neglected is the one somebody else pays', () => {
  const s = game();
  const a = signPact(s, 0, 1).pact;
  const b = signPact(s, 0, 2).pact;
  a.loyalty = 90;   // devoted
  b.loyalty = 10;   // already halfway out the door
  assert.ok(seducibility(s, b) > seducibility(s, a), 'restlessness ranks them');
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  const ranked = uprisingCandidates(s, 0);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].pact.vassal, 2, 'the restless one is the first prospect');
});

test('an oath bought with a debt turns easiest; one bought with a nation, hardest', () => {
  const s = game();
  const plain = signPact(s, 0, 1).pact;
  const debt = signPact(s, 0, 2).pact;
  const given = signPact(s, 0, 3).pact;
  for (const p of [plain, debt, given]) p.loyalty = 50;
  debt.underDebt = true;
  given.liberated = true;
  assert.ok(seducibility(s, debt) > seducibility(s, plain));
  assert.ok(seducibility(s, given) < seducibility(s, plain));
});

test('winning is what makes a lord worth conspiring against', () => {
  const s = hegemon(game());
  const alone = hegemony(s, 0);
  signPact(s, 0, 1);
  signPact(s, 0, 2);
  assert.ok(hegemony(s, 0) > alone, 'a banner counts its sworn realms\' towns too');
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  const two = uprisingChance(s, 0);
  assert.ok(two > 0 && two <= CONFIG.UPRISING_CHANCE_MAX, `bounded (${two})`);
});

test('a coalition that survived one rising gets a season before the next', () => {
  const s = hegemon(game());
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  assert.ok(uprisingChance(s, 0) > 0);
  s.players[0].uprisingDay = s.day - 1;
  assert.equal(uprisingChance(s, 0), 0, 'the cooldown shuts the door');
  s.day += CONFIG.UPRISING_COOLDOWN_DAYS;
  assert.ok(uprisingChance(s, 0) > 0, 'and opens it again');
});

test('a human vassal is never risen for — that is their decision, not the engine\'s', () => {
  const s = hegemon(game(), 1);
  signPact(s, 1, 0);            // the player, sworn to an AI lord
  signPact(s, 1, 2);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  const ranked = uprisingCandidates(s, 1);
  assert.deepEqual(ranked.map((r) => r.pact.vassal), [2],
    'the AI vassal is for sale; the player is not');
  fireUprising(s, 1, { rng: new Rng(4), count: 3 });
  assert.equal(isVassal(s, 0), true, 'nobody broke the player\'s oath for them');
});

test('nobody buys a rebellion against a realm that has not won anything yet', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  assert.ok(uprisingCandidates(s, 0).length, 'the vassal is available…');
  assert.equal(uprisingChance(s, 0), 0, '…but the target is not worth a chest');
  hegemon(s);
  assert.ok(uprisingChance(s, 0) > 0, 'win something, and somebody starts pricing you');
});

test('a backer sizes the job to the realm it means to unseat', () => {
  const s = game();
  assert.equal(maxRebelsFor(s, 0), 1, 'one chest is enough for a small realm');
  hegemon(s);
  const many = maxRebelsFor(s, 0);
  assert.ok(many > 1 && many <= CONFIG.UPRISING_REBEL_ODDS.length,
    `a realm with armies in the field is worth more of them (${many})`);
});

// ---- the chest IS the feature ----------------------------------------------

test('a rising arrives with a war chest and a host already in the field', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  const before = { gold: goldOf(s, 1), force: fieldForce(s, 1) };

  const res = fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  assert.equal(res.ok, true);
  const rebel = res.uprising.rebels[0];
  assert.equal(rebel.player, 1);

  assert.ok(rebel.chest >= CONFIG.UPRISING_CHEST_MIN, `the figure asked for (${rebel.chest})`);
  assert.ok(rebel.chest <= CONFIG.UPRISING_CHEST_CAP);
  // The coin half lands in the treasury…
  const coin = Math.round(rebel.chest * (1 - CONFIG.UPRISING_HOST_SHARE));
  assert.equal(goldOf(s, 1), before.gold + coin, 'the coin half is theirs to spend');
  // …and the men half is standing in the field, not sitting in a garrison.
  assert.ok(fieldForce(s, 1) > before.force * 2, 'an army no tribute of theirs ever paid for');
  assert.ok(rebel.host > 0);
  assert.ok(rebel.heroId && s.heroes[rebel.heroId], 'a commander carries it');
  assert.equal(s.heroes[rebel.heroId].owner, 1);
});

test('the oath is broken, the banner handed back, and the war is on', () => {
  const s = game();
  const pact = signPact(s, 0, 1).pact;
  assert.equal(s.players[1].team, s.players[0].team);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;

  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  assert.equal(isVassal(s, 1), false, 'no longer sworn');
  assert.equal(s.players[1].team, pact.vassalTeam, 'and flying its own banner again');
  assert.equal(allPacts(s).length, 0);
  assert.equal(s.players[1].defaulted, undefined,
    'a rebellion somebody else paid for is not a default on your own creditor');
  assert.equal(inUprising(s, 1), true);
  assert.equal(uprisingOf(s, 1).against, 0);
  assert.equal(uprisingsAgainst(s, 0).length, 1);
});

test('one, two or three rise in the same hour', () => {
  const s = game();
  signPact(s, 0, 1);
  signPact(s, 0, 2);
  signPact(s, 0, 3);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  const res = fireUprising(s, 0, { rng: new Rng(9), count: 3 });
  assert.equal(res.uprising.rebels.length, 3, 'a lord cannot be everywhere');
  assert.equal(allPacts(s).length, 0, 'every oath broken at once');
  for (const r of res.uprising.rebels) {
    assert.ok(goldOf(s, r.player) >= CONFIG.UPRISING_CHEST_MIN * (1 - CONFIG.UPRISING_HOST_SHARE),
      'each rebel ruler gets its own chest');
  }
});

test('the odds table only ever asks for one to three', () => {
  const s = game();
  signPact(s, 0, 1);
  signPact(s, 0, 2);
  signPact(s, 0, 3);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  const seen = new Set();
  for (let seed = 0; seed < 40; seed++) {
    const t = hegemon(game());
    signPact(t, 0, 1); signPact(t, 0, 2); signPact(t, 0, 3);
    t.day += CONFIG.UPRISING_MIN_PACT_DAYS;
    const r = fireUprising(t, 0, { rng: new Rng(seed) });
    seen.add(r.uprising.rebels.length);
  }
  assert.ok([...seen].every((n) => n >= 1 && n <= 3), `only 1..3 (saw ${[...seen].sort()})`);
  assert.ok(seen.size > 1, 'and not always the same number');
});

test('the chest tracks the war it has to buy, and is bounded at both ends', () => {
  const s = game();
  const small = warChestFor(s, 0, new Rng(1));
  assert.ok(small >= CONFIG.UPRISING_CHEST_MIN && small <= CONFIG.UPRISING_CHEST_MAX,
    `an early lord is priced in the named band (${small})`);
  for (const h of Object.values(s.heroes)) {
    if (h.owner === 0) h.army = [{ creature: 'archangel', count: 4000, hurt: 0 }];
  }
  const big = warChestFor(s, 0, new Rng(1));
  assert.ok(big > small, 'a lord with an age of army behind him costs more to unseat');
  assert.ok(big <= CONFIG.UPRISING_CHEST_CAP, 'and never unbounded');
});

test('a host is an order of battle, not one enormous stack', () => {
  const stacks = rebelHost('castle', 150000, new Rng(3));
  assert.ok(stacks.length >= 3, `several tiers (${stacks.length})`);
  assert.ok(stacks.every((st) => st.count > 0 && CREATURES[st.creature]));
  assert.ok(stacks.every((st) => CREATURES[st.creature].faction === 'castle'), 'their own line');
  assert.ok(stacks.every((st) => !CREATURES[st.creature].upgraded), 'regulars: money buys bodies');
  const spent = stacks.reduce((n, st) => n + CREATURES[st.creature].cost.gold * st.count, 0);
  assert.ok(spent <= 150000 * 1.15, `the budget is spent, not exceeded (${spent})`);
  assert.ok(spent >= 150000 * 0.8, 'and a chest is spent, not banked');
  assert.equal(rebelHost('castle', 0).length, 0);
});

test('a host with nowhere to muster reinforces what the realm already has', () => {
  const s = game();
  const hero = playerHeroes(s, 1)[0];
  const before = armyValue(hero.army);
  // No towns: musterRebelHost has no capital to muster outside, so the men are handed
  // to whatever is standing rather than destroyed.
  unland(s, 1, 2);
  const out = musterRebelHost(s, 1, [{ creature: 'imp', count: 200 }]);
  assert.equal(out, null, 'no commander was raised');
  assert.ok(fieldForce(s, 1) > before, 'but the men were not lost');
});

// ---- who is paying ----------------------------------------------------------

test('a people from outside the world outbids a frightened local', () => {
  const s = game();
  signPact(s, 0, 1);
  s.players[2].resources.gold = 80000;
  for (const h of Object.values(s.heroes)) {
    if (h.owner === 0) h.army = [{ creature: 'archangel', count: 200, hurt: 0 }];
  }
  assert.equal(foreignBackerFor(s, 0), 2, 'the frightened neighbour with a purse');
  s.players[3].invader = true;
  assert.equal(foreignBackerFor(s, 0), 3, 'until a people from outside is ashore');
});

test('a backer inside the world pays out of its own purse', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  s.players[2].resources.gold = 80000;
  for (const h of Object.values(s.heroes)) {
    if (h.owner === 0) h.army = [{ creature: 'archangel', count: 200, hurt: 0 }];
  }
  const purse = goldOf(s, 2);
  const res = fireUprising(s, 0, { rng: new Rng(2), count: 1 });
  assert.equal(res.uprising.backer, 2);
  assert.ok(res.uprising.rebels[0].local > 0, 'a real debit');
  assert.equal(goldOf(s, 2), purse - res.uprising.rebels[0].local,
    'funding somebody\'s rebellion leaves you poorer for it');
});

test('and with nobody rich left standing, the money still comes — from beyond the map', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  for (const p of s.players) p.resources.gold = 0;
  for (const i of [2, 3]) s.players[i].defeated = true;
  assert.equal(foreignBackerFor(s, 0), -1);
  const res = fireUprising(s, 0, { rng: new Rng(2), count: 1 });
  assert.equal(res.ok, true, 'the mechanic must not need a rich third party to exist');
  assert.ok(res.uprising.rebels[0].chest >= CONFIG.UPRISING_CHEST_MIN);
  assert.equal(res.uprising.rebels[0].local, 0);
});

// ---- the war itself ---------------------------------------------------------

test('rebels covet their old lord\'s castles, and he theirs', () => {
  const s = game();
  assert.equal(uprisingBias(s, 0), null, 'free hot path when nobody has risen');
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });

  const lord = uprisingBias(s, 0);
  const rebel = uprisingBias(s, 1);
  assert.ok(lord && rebel);
  assert.equal(lord(1), CONFIG.UPRISING_WAR_BIAS, 'the lord marches on the risen');
  assert.equal(rebel(0), CONFIG.UPRISING_WAR_BIAS, 'and the risen on the lord');
  assert.equal(lord(2), 1, 'and neither of them on anybody else');
  assert.equal(uprisingBias(s, 2), null, 'a realm outside the quarrel is untouched');
});

test('a rising fires from the weekly tick and is announced, not inferred', () => {
  const s = hegemon(game());
  signPact(s, 0, 1);
  signPact(s, 0, 2);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  // Walk the days until the roll lands. The odds are per-week-per-lord and its own
  // stream, so this is a bounded search over days, not a hidden retry.
  let events = [];
  for (let i = 0; i < 400 && !events.length; i++) {
    s.day++;
    events = tickUprisings(s).filter((e) => e.kind === 'uprising');
  }
  assert.ok(events.length, 'from time to time, somebody buys one');
  assert.ok(events[0].text.includes('throws off'), 'and it is said out loud');
  assert.equal(uprisingsAgainst(s, 0).length, 1);
});

test('the report reads out what the player is facing', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  const [row] = uprisingReport(s, 0);
  assert.equal(row.player, 1);
  assert.ok(row.chest >= CONFIG.UPRISING_CHEST_MIN);
  assert.ok(row.force > 0);
  assert.ok(row.towns > 0);
});

// ---- and the far side: mercy ------------------------------------------------

test('a rebel beaten to nothing begs for one castle', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  planted(s, 0, 3); // the lord needs a spare town to be able to give one

  assert.deepEqual(tickUprisings(s).filter((e) => e.kind === 'mercy'), [],
    'nothing to beg for while they still hold land');

  unland(s, 1);     // you took their castles
  const events = tickUprisings(s).filter((e) => e.kind === 'mercy');
  assert.equal(events.length, 1);
  assert.ok(events[0].text.includes('begs'));
  assert.equal(mercyPlea(s, 1).to, 0);
  assert.equal(allUprisings(s).length, 0, 'and the rising is over');
});

test('the lord chooses which castle — and the realm comes back sworn', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  planted(s, 0, 3);
  unland(s, 1);
  tickUprisings(s);

  const choices = mercyTownChoices(s, 0);
  assert.ok(choices.length >= 2, 'every town but the last is on the table');
  assert.ok((choices[0].buildings?.length || 0) <= (choices[choices.length - 1].buildings?.length || 0),
    'least-developed first — you keep your best');

  const mine = choices.length;
  const pick = choices[0];
  const res = grantMercy(s, 0, 1, pick.id);
  assert.equal(res.ok, true);
  assert.equal(s.towns[pick.id].owner, 1, 'the castle the LORD chose');
  assert.equal(playerTowns(s, 0).length, mine - 1, 'and it cost him one');
  assert.equal(isVassal(s, 1), true, 'vassals again');
  assert.equal(suzerainPact(s, 1).spared, true);
  assert.equal(s.players[1].defeated, false, 'kept in the game');
  assert.equal(mercyPlea(s, 1), null, 'the plea is answered');
  assert.ok(playerHeroes(s, 1).length > 0, 'and they have somebody to lead it');
});

test('a spared realm is a grateful one — but it is still a vassal', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  planted(s, 0, 3);
  unland(s, 1);
  tickUprisings(s);
  grantMercy(s, 0, 1, mercyTownChoices(s, 0)[0].id);
  const pact = suzerainPact(s, 1);
  assert.ok(pact.loyalty > CONFIG.PACT_LOYALTY_START, 'they remember being spared');
  assert.ok(pact.loyalty <= 100);
  assert.equal(pact.liberated, true, 'from their side, you gave them a nation back');
  assert.equal(vassalsOf(s, 0).length, 1);
  // …and a realm restored today cannot rise again tomorrow: the oath is new.
  assert.deepEqual(uprisingCandidates(s, 0), []);
});

test('mercy can be refused, and a lord on one town has nothing to give', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  planted(s, 0, 3);
  unland(s, 1);
  tickUprisings(s);

  assert.equal(refuseMercy(s, 1), true);
  assert.equal(mercyPlea(s, 1), null);
  assert.equal(s.mercyPleas, undefined, 'and no empty array left on state');
  assert.equal(refuseMercy(s, 1), false, 'answering twice is a no-op');

  // A lord down to his last castle cannot seat anybody, whatever he means to do.
  const towns = playerTowns(s, 0);
  for (const t of towns.slice(1)) t.owner = 2;
  assert.deepEqual(mercyTownChoices(s, 0), []);
  assert.equal(grantMercy(s, 0, 1, towns[0].id).ok, false);
});

test('an AI lord is never handed a dialog it cannot answer', () => {
  const s = game();
  s.players[0].isHuman = false;
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  planted(s, 0, 3);
  unland(s, 1);
  const events = tickUprisings(s);
  assert.deepEqual(events.filter((e) => e.kind === 'mercy'), []);
  assert.equal(s.mercyPleas, undefined);
  assert.ok(events.some((e) => e.kind === 'uprisingOver'), 'the rising still closes');
});

test('a rebel that swears again on its own is out of the rising, not begging', () => {
  const s = game();
  signPact(s, 0, 1);
  signPact(s, 0, 2);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(7), count: 2 });
  signPact(s, 0, 1); // terms taken again in the field
  unland(s, 2);
  planted(s, 0, 3);
  const events = tickUprisings(s);
  assert.equal(mercyPlea(s, 1), null, 'a re-sworn realm has nothing to beg for');
  assert.ok(events.some((e) => e.kind === 'mercy' && e.player === 2));
});

// ---- the war ends the moment it ends, not at the next week's dawn -----------
//
// Reported from play: "the green rebelled and I beat his heroes, then he requested a
// peace and became a vassal again, but the game did not notice and still showed a
// rebellion in the HUD — I tried to attack a town and a hero, and he is a vassal so no
// fight possible, but the HUD shows him still as an enemy." The engine was right (the
// oath was live, so no fight) and everything READING the rising was a week behind it.

test('a re-sworn rebel is off the HUD at once, not at the next weekly tick', () => {
  const s = hegemon(game());
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  assert.equal(uprisingReport(s, 0).length, 1, 'in revolt');

  planted(s, 0, 3);
  unland(s, 1);
  tickUprisings(s);                      // they beg
  grantMercy(s, 0, 1, mercyTownChoices(s, 0)[0].id);

  assert.deepEqual(uprisingReport(s, 0), [], 'the banner is back — say so NOW');
  assert.equal(uprisingsAgainst(s, 0).length, 0, 'and the books are closed');
});

test('and one that swears again by any other road is off it too', () => {
  const s = hegemon(game());
  signPact(s, 0, 1);
  signPact(s, 0, 2);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(7), count: 2 });
  assert.equal(uprisingReport(s, 0).length, 2);

  signPact(s, 0, 1);                     // terms taken in the field, mid-week
  assert.deepEqual(uprisingReport(s, 0).map((r) => r.player), [2],
    'only the one still in arms');
  assert.equal(uprisingsAgainst(s, 0).length, 1, 'the rising is not over — one is still up');
});

test('and a lord never covets his own new vassal', () => {
  const s = hegemon(game());
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  assert.equal(uprisingBias(s, 0)(1), CONFIG.UPRISING_WAR_BIAS, 'while it is a war');

  signPact(s, 0, 1);
  const lord = uprisingBias(s, 0);
  assert.equal(lord === null || lord(1) === 1, true,
    'once it is an oath, his armies must not be pointed at their own banner');
  const them = uprisingBias(s, 1);
  assert.equal(them === null || them(0) === 1, true, 'and theirs not at his');
});

test('the books close cleanly', () => {
  const s = game();
  signPact(s, 0, 1);
  s.day += CONFIG.UPRISING_MIN_PACT_DAYS;
  const res = fireUprising(s, 0, { rng: new Rng(4), count: 1 });
  assert.ok(endUprising(s, res.uprising.id));
  assert.equal(s.uprisings, undefined, 'no empty array left behind');
  assert.equal(endUprising(s, res.uprising.id), null, 'and closing twice is a no-op');
  assert.equal(clearMercyPlea(s, 1), false);
  assert.deepEqual(mercyPleas(s), []);
});
