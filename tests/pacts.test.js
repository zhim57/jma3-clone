/**
 * pacts.test.js — vassalage, tribute, loyalty and revolt.
 *
 * The deal, as it was first put: "conquer a town near me, then negotiate with the
 * hero there that they rule in my name and give me 15% of the proceeds — their
 * mines stay theirs and their farms stay theirs. When there is an invasion I
 * provide protection and they send armies to fight for us."
 *
 * Built on `player.team`, because that one integer already carries the whole
 * meaning: every hostility check, mine capture and pathing rule honours sameTeam,
 * and checkVictory counts teams, so a vassal wins with you instead of making the
 * game unwinnable. A revolt is the same integer moving back.
 *
 * Two properties are load-bearing and tested hardest. A pact must be INERT until
 * used — an in-progress save has to pick this up without a feature flag it could
 * never turn on. And a revolt must be a slide the player could watch, never a
 * roll: loyalty moves for named reasons and crosses a threshold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerTowns, playerHeroes, weekOf } from '../src/core/GameState.js';
import { dailyIncome, endTurn } from '../src/core/actions.js';
import {
  allPacts, signPact, breakPact, canOfferVassalage, defaultTerms, suzerainPact,
  vassalsOf, isVassal, tributeDue, tickPacts, loyaltyReasons, loyaltySwing,
  corneredScore, wouldSeekTerms, realmForce, restoreRealm, canRestoreRealm,
} from '../src/core/pacts.js';
import { runDays } from './helpers.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

// CLONE: two changes from upstream, both forced by this tree's choices.
//   1. The third seat was 'rampart', which is not a playable faction here
//      (data/factions.js registers castle + inferno only), and a roster naming an
//      unregistered faction cannot generate a map. It is castle now — this file
//      tests the vassalage CONTRACT, and which banner the third realm flies is
//      not part of it.
//   2. `features: { vassalage: true }`. Upstream, wouldSeekTerms is unflagged and
//      a cornered realm always sues for terms; this clone gates it OFF by default
//      (core/pacts.js explains why: with it on, two AI realms merge onto one team
//      in most seeds and an AI experiment stops measuring a war). These tests are
//      ABOUT that behaviour, so they have to switch it on explicitly.
const PLAYERS = [
  { faction: 'castle', isHuman: true, team: 0 },
  { faction: 'inferno', isHuman: false, team: 1 },
  { faction: 'castle', isHuman: false, team: 2 },
];
const VASSALAGE = { vassalage: true };
const game = (seed = 7) => newGame({ seed, players: PLAYERS, mapW: 44, mapH: 38, features: VASSALAGE });


// ---- the contract ----------------------------------------------------------

test('a pact puts the vassal on its suzerain\'s banner, and a revolt takes it back', () => {
  const s = game();
  assert.equal(s.players[1].team, 1);
  const res = signPact(s, 0, 1);
  assert.equal(res.ok, true);
  assert.equal(s.players[1].team, s.players[0].team, 'sworn realms share a banner');
  assert.equal(isVassal(s, 1), true);
  assert.equal(vassalsOf(s, 0).length, 1);
  assert.equal(suzerainPact(s, 1).suzerain, 0);

  breakPact(s, res.pact.id, 'revolt');
  assert.equal(s.players[1].team, 1, 'a broken oath hands the realm its own banner back');
  assert.equal(isVassal(s, 1), false);
  assert.equal(allPacts(s).length, 0);
});

test('the refusals are the interesting part', () => {
  const s = game();
  assert.equal(canOfferVassalage(s, 0, 0).ok, false, 'a realm cannot swear to itself');
  assert.equal(canOfferVassalage(s, 0, 99).ok, false, 'nor to a realm that does not exist');

  signPact(s, 0, 1);
  assert.equal(canOfferVassalage(s, 2, 1).ok, false, 'a realm already sworn cannot be double-pledged');
  assert.equal(canOfferVassalage(s, 1, 2).ok, false, 'a vassal cannot take vassals of its own');
  assert.equal(canOfferVassalage(s, 0, 1).ok, false, 'already of one banner');
  assert.equal(canOfferVassalage(s, 2, 0).ok, false, 'a lord holding vassals cannot itself kneel');

  // A realm with nothing left to rule is a conquest, not a contract.
  for (const t of playerTowns(s, 2)) t.owner = 0;
  assert.match(canOfferVassalage(s, 0, 2).reason, /no town/);

  s.players[2].defeated = true;
  assert.equal(canOfferVassalage(s, 0, 2).ok, false);
});

test('a lord that holds a vassal cannot kneel — no orphans on a foreign team', () => {
  // The missed direction of the chain guard. With A sworn to B, letting B swear
  // to C moved only B's team: A stayed behind on B's OLD team, still bound by a
  // live pact — paying weekly tribute to a lord it was now mutually hostile to,
  // its heroes and its lord's attacking each other, `terms.protect` binding
  // nobody — and because allRivalsSworn saw a foreign team, the orphan held the
  // Pax open forever. The flat `player.team` integer the whole module is built
  // on cannot hold a two-level structure, so the oath is refused at the gate
  // every entry point passes through (the AI's envoys, patrons.settleDebt, the
  // offer on a human's table all consult canOfferVassalage via signPact).
  const s = game();
  assert.equal(signPact(s, 1, 2).ok, true, 'A(2) swears to B(1)');
  const res = signPact(s, 0, 1);
  assert.equal(res.ok, false, 'B, holding a vassal, may not kneel to C(0)');
  assert.match(res.reason, /cannot kneel/);
  assert.deepEqual(s.players.map((p) => p.team), [0, 1, 1],
    'the banner map is untouched — no realm stranded at war with its own lord');

  // A DEAD letter does not bind: a pact whose vassal realm is already defeated
  // is one the next tickPacts will lapse, and must not block the oath (the
  // restoration path, actions.acceptPleas, signs pacts in exactly this window).
  s.players[2].defeated = true;
  assert.equal(canOfferVassalage(s, 0, 1).ok, true,
    'with the sub-vassal gone, the lord is free to seek terms');
});

test('an orphan chain from an old save is healed: the inner pact lapses', () => {
  // A save written before the gate above closed can already hold the chain.
  // Rebuild that world by hand — signPact refuses to make it now — and let the
  // weekly tick lapse the INNER pact, handing the orphan its sovereign banner
  // back via the pact's own vassalTeam snapshot.
  const s = game();
  const inner = signPact(s, 1, 2).pact;      // A(2) sworn to B(1)
  s.pacts.push({                             // the illegal outer oath, as an old save holds it
    id: 'P-old', suzerain: 0, vassal: 1, vassalTeam: 1,
    terms: defaultTerms(), loyalty: 70, signedDay: 1, reasons: [],
  });
  s.players[1].team = 0;                     // B moved with its new lord; A stayed behind
  assert.notEqual(s.players[2].team, s.players[1].team, 'the orphan, mid-heal');

  tickPacts(s, {});
  assert.equal(allPacts(s).find((p) => p.id === inner.id), undefined, 'the stale inner oath lapsed');
  assert.equal(s.players[2].team, 2, 'the orphan flies its own banner again');
  assert.ok(allPacts(s).some((p) => p.id === 'P-old'), 'the legally signed outer oath stands');
});

test('the default terms are the deal as it was described', () => {
  const t = defaultTerms();
  assert.equal(t.tributeShare, CONFIG.PACT_TRIBUTE_SHARE);
  assert.ok(t.tributeShare > 0 && t.tributeShare < 0.5, 'a share of the proceeds, not the proceeds');
  assert.equal(t.levy, true, 'they send armies when a wave lands');
  assert.equal(t.protect, true, 'and are defended in return');
});

// ---- tribute ---------------------------------------------------------------

test('tribute is a share of the PROCEEDS — the mines stay theirs', () => {
  const s = game();
  const before = playerTowns(s, 1).map((t) => t.owner);
  const { pact } = signPact(s, 0, 1);
  assert.deepEqual(playerTowns(s, 1).map((t) => t.owner), before,
    'swearing an oath does not hand over a single town');

  s.players[1].resources.gold = 100000;
  const due = tributeDue(s, pact, dailyIncome);
  const income = dailyIncome(s, s.players[1]);
  assert.ok(due.gold > 0, 'a week of gold changes hands');
  assert.equal(due.gold, Math.floor(income.gold * CONFIG.DAYS_PER_WEEK * pact.terms.tributeShare));
});

test('tribute never invents coin a vassal does not hold', () => {
  const s = game();
  const { pact } = signPact(s, 0, 1);
  s.players[1].resources.gold = 3;
  const due = tributeDue(s, pact, dailyIncome);
  assert.ok((due.gold || 0) <= 3, `asked for ${due.gold} from a treasury of 3`);

  s.players[1].resources.gold = 0;
  assert.equal(tributeDue(s, pact, dailyIncome).gold, undefined, 'nothing to send');
});

test('a week of play moves tribute from one treasury to the other', () => {
  const s = game();
  signPact(s, 0, 1);
  s.players[0].resources.gold = 0;
  s.players[1].resources.gold = 100000;
  const mine0 = s.players[0].resources.gold;
  const theirs0 = s.players[1].resources.gold;
  runDays(s, 8);
  const gained = s.players[0].resources.gold - mine0;
  const lost = theirs0 - s.players[1].resources.gold;
  assert.ok(gained > 0, 'the suzerain is paid');
  assert.ok(lost > 0 || gained > 0, 'and the vassal pays');
});

// ---- loyalty ---------------------------------------------------------------

test('loyalty moves for reasons a player can read', () => {
  const s = game();
  const { pact } = signPact(s, 0, 1);
  pact.lastTowns = playerTowns(s, 1).length;
  const reasons = loyaltyReasons(s, pact);
  assert.ok(reasons.length > 0, 'there is always something to say');
  for (const r of reasons) {
    assert.equal(typeof r.why, 'string');
    assert.ok(r.why.length > 4, `"${r.why}" is not an explanation`);
    assert.equal(typeof r.delta, 'number');
  }
});

test('a heavy hand costs loyalty; a light one earns it', () => {
  const s = game();
  const heavy = signPact(s, 0, 1, { ...defaultTerms(), tributeShare: 0.4 }).pact;
  const heavyWhy = loyaltyReasons(s, heavy).find((r) => /tribute/.test(r.why));
  assert.ok(heavyWhy.delta < 0, 'forty per cent is remembered');

  breakPact(s, heavy.id, 'released');
  const light = signPact(s, 0, 1, { ...defaultTerms(), tributeShare: 0.02 }).pact;
  const lightWhy = loyaltyReasons(s, light).find((r) => /tribute/.test(r.why));
  assert.ok(lightWhy.delta > 0, 'a light hand is forgiven');
});

test('failing to defend a vassal is the fastest way to lose one', () => {
  const s = game();
  const { pact } = signPact(s, 0, 1);
  pact.lastTowns = playerTowns(s, 1).length + 1; // they held one more last week
  const why = loyaltyReasons(s, pact).find((r) => /lost a town/.test(r.why));
  assert.ok(why, 'losing ground under your banner must be named');
  assert.equal(why.delta, -CONFIG.PACT_LOYALTY_LOST_TOWN);
  assert.ok(Math.abs(why.delta) > CONFIG.PACT_LOYALTY_HELD * 5,
    'and must outweigh many quiet weeks — this is the one that breaks realms');
});

test('a vassal that outgrows its lord stops looking up to it', () => {
  const s = game();
  const { pact } = signPact(s, 0, 1);
  for (const h of Object.values(s.heroes)) {
    if (h.owner === 1) h.army = [{ creature: 'archangel', count: 60, hurt: 0 }];
    if (h.owner === 0) h.army = [{ creature: 'peasant', count: 1, hurt: 0 }];
  }
  assert.ok(realmForce(s, 1) > realmForce(s, 0));
  const why = loyaltyReasons(s, pact).find((r) => /outmatch/.test(r.why));
  assert.ok(why && why.delta < 0, 'obedience to someone weaker is a choice, not a duty');
});

test('a shared enemy is the best glue there is', () => {
  const s = game();
  const { pact } = signPact(s, 0, 1);
  const calm = loyaltySwing(loyaltyReasons(s, pact, { invasionAfoot: false }));
  const wave = loyaltySwing(loyaltyReasons(s, pact, { invasionAfoot: true }));
  assert.ok(wave > calm, 'a wave afoot holds a realm together');
});

test('a revolt is a SLIDE, warned about before it happens — never a roll', () => {
  const s = game();
  const { pact } = signPact(s, 0, 1);
  // A ruinous deal, and lands lost every week: this realm should walk.
  pact.terms.tributeShare = 0.6;
  let warned = false, revolted = false;
  for (let week = 0; week < 12 && !revolted; week++) {
    pact.lastTowns = playerTowns(s, 1).length + 1; // lost ground again
    for (const ev of tickPacts(s, { dailyIncome })) {
      if (ev.kind === 'restless') warned = true;
      if (ev.kind === 'revolt') revolted = true;
    }
  }
  assert.ok(revolted, 'a realm treated like that must eventually leave');
  assert.ok(warned, 'and the player must have been told it was coming FIRST');
  assert.equal(s.players[1].team, 1, 'and it leaves with its own banner');
});

test('a well-treated vassal stays, indefinitely', () => {
  const s = game();
  const { pact } = signPact(s, 0, 1, { ...defaultTerms(), tributeShare: 0.05 });
  for (let week = 0; week < 20; week++) {
    pact.lastTowns = playerTowns(s, 1).length;
    tickPacts(s, { dailyIncome });
  }
  assert.equal(allPacts(s).length, 1, 'a light hand and a quiet border keeps a realm');
  assert.ok(suzerainPact(s, 1).loyalty > CONFIG.PACT_LOYALTY_WARN);
});

test('an oath with nothing left to bind lapses instead of leaving a ghost', () => {
  const s = game();
  signPact(s, 0, 1);
  for (const t of playerTowns(s, 1)) t.owner = 0; // the vassal loses its last town
  tickPacts(s, { dailyIncome });
  assert.equal(allPacts(s).length, 0);
  assert.equal(s.players[1].team, 1, 'and the realm is not stranded on a borrowed banner');
});

// ---- the second verb -------------------------------------------------------

test('cornered needs BOTH: little land AND no army', () => {
  const s = game();
  // A great army on little land is a fortress, not a supplicant.
  for (const t of Object.values(s.towns)) if (t.owner === 1) t.owner = 0;
  const keep = Object.values(s.towns).find((t) => t.owner === 0);
  keep.owner = 1;
  for (const h of Object.values(s.heroes)) {
    if (h.owner === 1) h.army = [{ creature: 'archangel', count: 80, hurt: 0 }];
    else h.army = [{ creature: 'peasant', count: 2, hurt: 0 }];
  }
  assert.ok(corneredScore(s, 1) < CONFIG.PACT_CORNERED_THRESHOLD,
    'one town and the best army in the world is a fortress');

  // Take the army away and the same realm is finished.
  for (const h of Object.values(s.heroes)) {
    if (h.owner === 1) h.army = [{ creature: 'peasant', count: 1, hurt: 0 }];
    else h.army = [{ creature: 'archangel', count: 80, hurt: 0 }];
  }
  assert.ok(corneredScore(s, 1) >= CONFIG.PACT_CORNERED_THRESHOLD,
    'one town and nothing to hold it with is the moment to seek terms');
  assert.equal(wouldSeekTerms(s, 1), true);
});

test('a realm holding its own does not go begging', () => {
  const s = game();
  assert.ok(corneredScore(s, 1) < CONFIG.PACT_CORNERED_THRESHOLD, 'day one is not desperate');
  assert.equal(wouldSeekTerms(s, 1), false);
});

test('a realm already sworn does not seek terms again', () => {
  const s = game();
  for (const t of Object.values(s.towns)) if (t.owner === 1 && playerTowns(s, 1).length > 1) t.owner = 0;
  for (const h of Object.values(s.heroes)) {
    if (h.owner === 1) h.army = [{ creature: 'peasant', count: 1, hurt: 0 }];
    else h.army = [{ creature: 'archangel', count: 80, hurt: 0 }];
  }
  if (wouldSeekTerms(s, 1)) {
    signPact(s, 0, 1);
    assert.equal(wouldSeekTerms(s, 1), false, 'they already found a patron');
  }
});

test('a defeated realm reads as finished, not as a candidate', () => {
  const s = game();
  s.players[1].defeated = true;
  assert.equal(corneredScore(s, 1), 1);
});

// ---- inertness -------------------------------------------------------------

test('a game with no pacts writes nothing and costs nothing', () => {
  const a = game(99);
  const b = game(99);
  runDays(a, 30);
  runDays(b, 30);
  assert.equal(a.pacts, undefined, 'no pacts array is created out of nothing');
  assert.deepEqual(a.rng.toJSON(), b.rng.toJSON(), 'and no rng is drawn');
  assert.equal(tickPacts(a, { dailyIncome }).length, 0);
});

test('an in-progress save picks pacts up with no migration', () => {
  // Features are snapshotted into state at newGame, so a flag could never be
  // turned on for a game already running. This has to work without one.
  const s = game();
  delete s.pacts;
  delete s.nextPactId;
  const res = signPact(s, 0, 1);
  assert.equal(res.ok, true, 'a save that never heard of pacts can still sign one');
  assert.equal(allPacts(s).length, 1);
});

test('pacts round-trip a save', async () => {
  const { serialize, deserialize } = await import('../src/core/GameState.js');
  const s = game();
  const { pact } = signPact(s, 0, 1);
  pact.loyalty = 42;
  const back = deserialize(serialize(s));
  assert.equal(allPacts(back).length, 1);
  assert.equal(suzerainPact(back, 1).loyalty, 42);
  assert.equal(back.players[1].team, back.players[0].team, 'still of one banner after a reload');
  // And it can still be broken on the other side of the save.
  breakPact(back, suzerainPact(back, 1).id, 'revolt');
  assert.equal(back.players[1].team, 1);
});

// ---- liberation ------------------------------------------------------------
//
// "If I beat them and take back a town I may choose to revert the old AI nation,
// and that gives me some extra loyalty in the long run."
//
// The case: an invader overran a realm, you beat the invader, and the town in your
// hands used to be someone else's capital. Keeping it pays better this week.
// Giving it back pays better every week after — which is what makes it a choice
// rather than a formality.

/** A game where player 1 has been conquered and player 0 holds their last town. */
function conquered(seed = 11) {
  const s = game(seed);
  const theirs = playerTowns(s, 1);
  const lost = theirs[0];
  for (const t of theirs) t.owner = 0;
  s.players[1].defeated = true;
  for (const h of Object.values(s.heroes)) if (h.owner === 1) delete s.heroes[h.id];
  return { s, town: lost };
}

test('a liberated realm rises again, with a town and a commander', () => {
  const { s, town } = conquered();
  assert.equal(s.players[1].defeated, true);
  const res = restoreRealm(s, 0, 1, town.id);
  assert.equal(res.ok, true, res.reason);
  assert.equal(s.players[1].defeated, false, 'the realm is back');
  assert.equal(town.owner, 1, 'holding its own town');
  assert.equal(s.players[1].daysWithoutTown, 0, 'and not on the clock to die again');
  assert.ok(res.hero, 'a realm with no commander is a flag on a building');
  assert.equal(res.hero.owner, 1);
});

test('liberation is worth more every week than annexation is worth once', () => {
  const { s, town } = conquered();
  const res = restoreRealm(s, 0, 1, town.id);
  const pact = res.pact;
  assert.ok(pact, 'the restored realm swears');
  assert.equal(pact.liberated, true);
  assert.ok(pact.loyalty > CONFIG.PACT_LOYALTY_START, 'they start out already grateful');

  const why = loyaltyReasons(s, pact).find((r) => /nation back/.test(r.why));
  assert.ok(why, 'and the debt is named every week');
  assert.ok(why.delta > 0);

  // Against an ordinary vassal on identical terms, the liberated one drifts up.
  const plain = game(12);
  const ordinary = signPact(plain, 0, 1).pact;
  ordinary.lastTowns = playerTowns(plain, 1).length;
  pact.lastTowns = playerTowns(s, 1).length;
  const swingLiberated = loyaltySwing(loyaltyReasons(s, pact));
  const swingOrdinary = loyaltySwing(loyaltyReasons(plain, ordinary));
  assert.ok(swingLiberated > swingOrdinary,
    `liberated ${swingLiberated} vs beaten ${swingOrdinary} — gratitude must actually pay`);
});

test('a liberated vassal outlasts a beaten one under the same bad treatment', () => {
  const heavy = { ...defaultTerms(), tributeShare: 0.45 };
  const weeks = (s, pact) => {
    let n = 0;
    while (allPacts(s).length && n < 60) {
      pact.lastTowns = playerTowns(s, pact.vassal).length;
      tickPacts(s, { dailyIncome });
      n++;
    }
    return n;
  };
  const lib = conquered(21);
  const libPact = restoreRealm(lib.s, 0, 1, lib.town.id, { terms: heavy }).pact;
  const plain = game(22);
  const plainPact = signPact(plain, 0, 1, heavy).pact;
  assert.ok(weeks(lib.s, libPact) > weeks(plain, plainPact),
    'the realm you saved forgives more than the realm you merely beat');
});

test('liberation without an oath is allowed — a neighbour who owes you nothing', () => {
  const { s, town } = conquered(31);
  const res = restoreRealm(s, 0, 1, town.id, { pact: false });
  assert.equal(res.ok, true);
  assert.equal(res.pact, null);
  assert.equal(s.players[1].defeated, false);
  assert.equal(s.players[1].team, 1, 'independent, on its own banner');
  assert.equal(allPacts(s).length, 0);
});

test('the refusals: you cannot give away what is not yours, or your last town', () => {
  const { s, town } = conquered(41);
  assert.match(canRestoreRealm(s, 0, 0, town.id).reason, /itself/);
  assert.match(canRestoreRealm(s, 0, 1, 'nope').reason, /no such/);

  // A realm still standing does not need restoring.
  const alive = game(42);
  assert.match(canRestoreRealm(alive, 0, 1, playerTowns(alive, 0)[0].id).reason, /still stands/);

  // A town you do not hold.
  const other = Object.values(s.towns).find((t) => t.owner !== 0);
  if (other) assert.match(canRestoreRealm(s, 0, 1, other.id).reason, /not yours/);

  // And never your last one — liberation is a gift, not a suicide.
  const mine = playerTowns(s, 0);
  for (const t of mine.slice(1)) t.owner = -1;
  assert.match(canRestoreRealm(s, 0, 1, mine[0].id).reason, /last town/);
});

test('a restored realm round-trips a save, gratitude and all', async () => {
  const { serialize, deserialize } = await import('../src/core/GameState.js');
  const { s, town } = conquered(51);
  restoreRealm(s, 0, 1, town.id);
  const back = deserialize(serialize(s));
  assert.equal(back.players[1].defeated, false);
  assert.equal(suzerainPact(back, 1).liberated, true);
  assert.ok(loyaltyReasons(back, suzerainPact(back, 1)).some((r) => /nation back/.test(r.why)));
});

// ---------------------------------------------------------------------------
// Husbandry: the vassal's stewards work the weekly sites of their own lands
// ---------------------------------------------------------------------------
//
// The map bleeds without it. Measured over eight weeks of real play, 90% of
// weekly sites on a 72×60 map and larger were never visited by anybody — on a
// 96×80 that is 154 000 gold of water wheels alone left to rot. A hero cannot be
// everywhere, and a realm sworn to you has heroes of its own doing nothing with
// the countryside it still holds.
//
// Three bounds keep it supplementing the map rather than replacing it, and each
// has a test below: OWN LANDS only, a FRACTION of the yield, and ONCE a week
// through the site's own stamp so a steward and a hero never both collect.

function seatBooster(state, x, y, boosterType) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, type: 'booster', boosterType };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}
/** Roll the clock to the next week's dawn without anybody taking a turn. */
function toNextWeek(s) {
  const wk = weekOf(s.day);
  let guard = 200;
  while (weekOf(s.day) === wk && guard-- > 0) endTurn(s);
  return weekOf(s.day);
}
const townOf = (s, owner) => Object.values(s.towns).find((t) => t.owner === owner);

test('husbandry: stewards work the weekly sites standing in the VASSAL\'s lands', () => {
  const s = newGame({ seed: 9, players: [{ faction: 'castle' }, { faction: 'inferno' }], features: VASSALAGE });
  signPact(s, 0, 1, defaultTerms());
  const theirs = seatBooster(s, townOf(s, 1).x + 1, townOf(s, 1).y, 'waterWheel');
  const mine = seatBooster(s, townOf(s, 0).x + 1, townOf(s, 0).y, 'waterWheel');

  const week = toNextWeek(s);
  assert.equal(theirs.harvestedWeek, week, 'the wheel in the vassal\'s own land was worked');
  assert.equal(mine.harvestedWeek, undefined,
    'a wheel in the SUZERAIN\'s land is not the vassal\'s to tend — the clause hands over a part of the kingdom, not all of it');
});

test('husbandry: the suzerain takes the pact\'s share and the vassal keeps the rest', () => {
  const s = newGame({ seed: 9, players: [{ faction: 'castle' }, { faction: 'inferno' }], features: VASSALAGE });
  const terms = { ...defaultTerms(), tributeShare: 0.5 };
  signPact(s, 0, 1, terms);
  seatBooster(s, townOf(s, 1).x + 1, townOf(s, 1).y, 'waterWheel');

  // Zero the treasuries and the income so the wheel is the only thing moving.
  for (const p of s.players) for (const r of Object.keys(p.resources)) p.resources[r] = 0;
  const before = { suz: s.players[0].resources.gold };
  toNextWeek(s);

  const worked = Math.floor(CONFIG.WATER_WHEEL_GOLD * CONFIG.PACT_HUSBANDRY_YIELD);
  const cut = Math.floor(worked * 0.5);
  const suzGain = s.players[0].resources.gold - before.suz;
  // Income and tribute move too, so bound rather than pin: the suzerain must be
  // up by AT LEAST its cut, and the two shares must add to the worked yield.
  assert.ok(suzGain >= cut, `suzerain gained ${suzGain}, less than its ${cut} cut of the wheel`);
  assert.ok(worked > 0 && worked < CONFIG.WATER_WHEEL_GOLD,
    'a steward is not a hero: the worked yield is a fraction of what riding out yourself pays');
});

test('husbandry: a site a hero already worked this week is left alone, and vice versa', () => {
  // One stamp governs both, so the two can never double-dip on the same mill.
  const s = newGame({ seed: 9, players: [{ faction: 'castle' }, { faction: 'inferno' }], features: VASSALAGE });
  signPact(s, 0, 1, defaultTerms());
  const wheel = seatBooster(s, townOf(s, 1).x + 1, townOf(s, 1).y, 'waterWheel');
  wheel.harvestedWeek = weekOf(s.day) + 1; // pretend a hero got there first, next week

  const week = toNextWeek(s);
  assert.equal(wheel.harvestedWeek, week, 'the stamp is untouched — the stewards did not re-collect it');
  const before = s.players[0].resources.gold;
  toNextWeek(s);
  assert.ok(s.players[0].resources.gold >= before, 'and the following week resumes normally');
});

test('husbandry: no clause, no stewards', () => {
  const s = newGame({ seed: 9, players: [{ faction: 'castle' }, { faction: 'inferno' }], features: VASSALAGE });
  signPact(s, 0, 1, { ...defaultTerms(), husbandry: false });
  const wheel = seatBooster(s, townOf(s, 1).x + 1, townOf(s, 1).y, 'waterWheel');
  toNextWeek(s);
  assert.equal(wheel.harvestedWeek, undefined, 'a pact without the clause tends nothing');
});

test('husbandry: the Magic Spring is not a steward\'s business', () => {
  // It restores a visiting hero's mana on the spot. There is nothing for a
  // steward to carry home, so it must not be silently drained out from under a
  // hero who was riding to it.
  const s = newGame({ seed: 9, players: [{ faction: 'castle' }, { faction: 'inferno' }], features: VASSALAGE });
  signPact(s, 0, 1, defaultTerms());
  const spring = seatBooster(s, townOf(s, 1).x + 1, townOf(s, 1).y, 'magicSpring');
  toNextWeek(s);
  assert.equal(spring.harvestedWeek, undefined, 'the spring still waits for a hero');
});

test('an ally\'s mine is not a prize — the AI stops marching at flags it cannot take', () => {
  // `visitObject` refuses to re-flag a holding a teammate owns, and signing a
  // pact puts the vassal on the suzerain's team — so the arrival was always a
  // no-op. The goal picker never got the same check, and the hero had spent its
  // day: measured over four three-player games with a pact standing, 73 of the
  // 77 hero-turns that ended on a mine changed nothing at all. The answer was
  // already being computed eighteen lines above the prize gate, for the scan
  // counter, and simply not used.
  //
  // Read off the AI's own veto tally rather than off which goal it happened to
  // pick: whether a particular mine WINS depends on everything else on the map,
  // but whether it was refused as `owned` is exactly the claim.
  const mineVetoes = (owner) => {
    const s = newGame({ seed: 12, players: [{ faction: 'castle' }, { faction: 'inferno' }, { faction: 'castle' }], features: VASSALAGE });
    signPact(s, 1, 2, defaultTerms());
    const hero = playerHeroes(s, 1)[0];
    const m = s.map;
    const x = hero.x + 2, y = hero.y;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = m.tiles[(y + dy) * m.w + (x + dx)];
      if (t) { t.terrain = 'grass'; t.obstacle = null; if (t.objectId && m.objects[t.objectId]?.type !== 'town') { delete m.objects[t.objectId]; t.objectId = null; } }
    }
    const id = `O${m.nextOid++}`;
    m.objects[id] = { id, x, y, type: 'mine', mineType: 'goldMine', owner };
    m.tiles[y * m.w + x].objectId = id;

    const ai = new AITurnController(s, 1);
    let r, guard = 300;
    do { r = ai.next(); if (r.type === 'combat') ai.autoFight(r.context); } while (r.type !== 'done' && guard-- > 0);
    return (s.aiLog || []).filter((e) => e.kind === 'hero')
      .reduce((n, e) => n + (e.vetoes?.owned || 0), 0);
  };

  const rival = mineVetoes(0);
  const vassal = mineVetoes(2);
  assert.ok(vassal > rival,
    `a vassal's mine was refused ${vassal} times against a rival's ${rival} — the ally check is not reaching the prize gate`);
});

test('protect: a suzerain rides to a sworn vassal\'s threatened town', () => {
  // `terms.protect` was a promise with nothing behind it. It is written into
  // every pact, read out to the player as "in exchange they expect to be
  // defended", and the vassal docks loyalty every week it loses a town under
  // your banner — while `grep` finds the term consulted by NO code anywhere. The
  // oath punished a lord for failing an obligation the engine gave it no way to
  // keep.
  //
  // Built directly rather than sampled from play: over four three-player games
  // no town on the board — anyone's — ever registered a threat at a turn
  // boundary, so a game-level probe could not have told a working branch from a
  // broken one. This constructs the trigger.
  const stage = (protect) => {
    const s = newGame({ seed: 21, players: [{ faction: 'castle' }, { faction: 'inferno' }, { faction: 'castle' }], features: VASSALAGE });
    signPact(s, 0, 1, { ...defaultTerms(), protect });
    const vTown = playerTowns(s, 1)[0];
    vTown.garrison = [null, null, null, null, null, null, null];   // nothing to hold it

    // A rival hero parked on the vassal's doorstep, and our own hero in reach.
    const rival = playerHeroes(s, 2)[0];
    rival.x = vTown.x + 1; rival.y = vTown.y; rival.z = vTown.z ?? 0;
    rival.army = [{ creature: 'archangel', count: 6, hurt: 0 }, null, null, null, null, null, null];
    const ours = playerHeroes(s, 0)[0];
    ours.x = vTown.x + 3; ours.y = vTown.y; ours.z = vTown.z ?? 0;
    ours.army = [{ creature: 'archangel', count: 40, hurt: 0 }, null, null, null, null, null, null];

    const ai = new AITurnController(s, 0);
    return { s, ai, ours, vTown };
  };

  const on = stage(true);
  assert.equal(on.ai.protectedTown(on.vTown), true, 'the town is one we swore to defend');
  assert.ok(on.ai.townThreat(on.vTown) > 0, 'and the menace on its doorstep is visible to us');

  const goalFor = ({ ai, ours }) => {
    let r, guard = 300;
    do { r = ai.next(); if (r.type === 'combat') ai.autoFight(r.context); } while (r.type !== 'done' && guard-- > 0);
    void ours;
    return (ai.state.aiLog || []).filter((e) => e.kind === 'hero').map((e) => e.goal?.what);
  };
  assert.ok(goalFor(on).includes('defend vassal'),
    'no hero took up the defence of a vassal we are sworn to protect');

  // Without the clause the same board is somebody else's business.
  const off = stage(false);
  assert.equal(off.ai.protectedTown(off.vTown), false, 'no clause, no obligation');
  assert.ok(!goalFor(off).includes('defend vassal'), 'and no hero is diverted');
});

test('protect: never a rescue we cannot actually make', () => {
  // The branch is gated like our own town rescue: riding to a fight we lose
  // just feeds the besieger a second army. A vassal is not worth more than that.
  const s = newGame({ seed: 21, players: [{ faction: 'castle' }, { faction: 'inferno' }, { faction: 'castle' }], features: VASSALAGE });
  signPact(s, 0, 1, defaultTerms());
  const vTown = playerTowns(s, 1)[0];
  vTown.garrison = [null, null, null, null, null, null, null];
  const rival = playerHeroes(s, 2)[0];
  rival.x = vTown.x + 1; rival.y = vTown.y; rival.z = vTown.z ?? 0;
  rival.army = [{ creature: 'archangel', count: 200, hurt: 0 }, null, null, null, null, null, null];
  const ours = playerHeroes(s, 0)[0];
  ours.x = vTown.x + 3; ours.y = vTown.y; ours.z = vTown.z ?? 0;
  ours.army = [{ creature: 'peasant', count: 5, hurt: 0 }, null, null, null, null, null, null];

  const ai = new AITurnController(s, 0);
  let r, guard = 300;
  do { r = ai.next(); if (r.type === 'combat') ai.autoFight(r.context); } while (r.type !== 'done' && guard-- > 0);
  const goals = (s.aiLog || []).filter((e) => e.kind === 'hero').map((e) => e.goal?.what);
  assert.ok(!goals.includes('defend vassal'),
    'a hopeless rescue was attempted — that is two armies lost instead of one');
});
