/**
 * pacts.js — vassalage, tribute, loyalty and betrayal.
 *
 * The substrate under a whole family of things a realm can do to another realm
 * short of destroying it: "rule in my name, keep your mines and your farms, send
 * me a share and some troops, and I will come when you are invaded." One object
 * with TERMS, so tribute, a levy, a trade agreement, a land lease and a subsidy
 * are variations on a contract rather than five separate systems.
 *
 * Why it is built on `player.team`. A vassal is a separate player moved onto its
 * suzerain's team, and that one integer buys almost everything: sameTeam() is
 * already honoured by every hostility check, mine capture, caravan and pathing
 * rule in the game; checkVictory counts TEAMS, so a vassal wins with you rather
 * than making the game unwinnable; and a revolt is the same integer moving back,
 * which re-arms every one of those checks at once.
 *
 * Loyalty is the state that makes it a game rather than a menu. It moves for
 * reasons the player can read and act on — you defended them, you did not; the
 * tribute is heavy; you have grown so much stronger that obedience looks like a
 * choice; a wave is afoot and they need you — and betrayal is a threshold, never
 * a die roll. A vassal that revolts is one you watched slide.
 *
 * Inert until used: a game with no pacts writes nothing, draws no rng, and reads
 * exactly as it did before. That is deliberate, because it means an in-progress
 * save gets this without needing a feature flag it could never turn on (flags are
 * snapshotted into state at newGame).
 *
 * Pure rule-engine: no Phaser, no view imports. `dailyIncome` is injected rather
 * than imported, because actions.js imports this module and the cycle would be
 * real (see tickPacts).
 */

import { CONFIG } from '../config.js';
import { playerTowns, logMsg, createHero, tileAt, heroAt, featureOn } from './GameState.js';
import { heroesOfFaction } from '../data/heroes.js';
import { effectiveForce } from './heroUtils.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Every live pact. Absent on a save written before pacts existed. */
export function allPacts(state) {
  return state.pacts || [];
}

/** The pact binding `vassal` to a suzerain, or null. A realm serves one master. */
export function suzerainPact(state, vassal) {
  return allPacts(state).find((p) => p.vassal === vassal) || null;
}

/** Every realm sworn to `suzerain`. */
export function vassalsOf(state, suzerain) {
  return allPacts(state).filter((p) => p.suzerain === suzerain);
}

/** Is this realm sworn to anyone? */
export const isVassal = (state, playerIndex) => !!suzerainPact(state, playerIndex);

/**
 * The team a realm would hold if every oath lapsed TODAY — its SOVEREIGN team.
 *
 * A vassal's `team` is its suzerain's; `pact.vassalTeam` is the banner it flies
 * again the moment the pact breaks (see breakPact). So this is the answer to
 * "who is genuinely a separate realm here", which is a different question from
 * "who fights on whose side this week".
 *
 * checkVictory asks the sovereign question. An oath is a contract, not a
 * conquest: a realm that swore to you still holds its towns, its mines and its
 * armies, its loyalty still moves, and it can throw the banner off any week it
 * chooses — so the map is NOT settled and the game must not declare a winner.
 * Reported as "if I sign pacts with all opponents the game ends, it shouldn't —
 * they can turn against me again, I can break the pact".
 */
export function sovereignTeamOf(state, playerIndex) {
  const pact = suzerainPact(state, playerIndex);
  if (pact && pact.vassalTeam != null) return pact.vassalTeam;
  return state.players?.[playerIndex]?.team ?? playerIndex;
}

/** The distinct sovereign teams still standing — see sovereignTeamOf. */
export function sovereignTeams(state) {
  return new Set((state.players || [])
    .filter((p) => !p.defeated)
    .map((p) => sovereignTeamOf(state, p.index)));
}

/**
 * Is every surviving rival of `playerIndex` sworn to their banner? The exact
 * situation that used to end the game on the spot: one fighting team, several
 * sovereign realms. It is peace, not victory — the Pax (see actions.enterPax).
 */
export function allRivalsSworn(state, playerIndex) {
  const me = state.players?.[playerIndex];
  if (!me || me.defeated) return false;
  const myTeam = me.team ?? playerIndex;
  const others = (state.players || []).filter((p) => !p.defeated && p.index !== playerIndex);
  if (!others.length) return false;                       // nobody left: a real conquest
  if (others.some((p) => (p.team ?? p.index) !== myTeam)) return false; // a war is still on
  return others.some((p) => isVassal(state, p.index));    // …and at least one is here by oath
}

/** The strongest field army a realm can put in the world, hero power included. */
export function realmForce(state, playerIndex) {
  const weight = Number.isFinite(state.heroPowerWeight) ? state.heroPowerWeight : 0;
  let best = 0;
  for (const hero of Object.values(state.heroes || {})) {
    if (hero.owner !== playerIndex) continue;
    best = Math.max(best, effectiveForce(hero.army, hero, weight));
  }
  return best;
}

/**
 * Whether `vassal` could be offered terms by `suzerain` right now.
 *
 * Returns { ok } or { ok: false, reason }. The reasons are the interesting part:
 * a realm already sworn to someone cannot be double-pledged, a realm cannot swear
 * to itself or to its own team, a realm with nothing left to rule has nothing
 * to offer — at that point it is a conquest, not a contract — and NO CHAINS in
 * either direction: a vassal cannot take vassals, and a lord holding vassals
 * cannot itself kneel (see the guard below for why the model cannot hold a
 * chain). Every entry point — the AI's cornered-realm envoys, a debt called in
 * (patrons.settleDebt), the offer on a human's table — consults this, so the
 * refusal is enforced at the one gate they all pass through.
 */
export function canOfferVassalage(state, suzerain, vassal) {
  const a = state.players?.[suzerain];
  const b = state.players?.[vassal];
  if (!a || !b) return { ok: false, reason: 'no such realm' };
  if (suzerain === vassal) return { ok: false, reason: 'a realm cannot swear to itself' };
  if (a.defeated || b.defeated) return { ok: false, reason: 'that realm is gone' };
  if (suzerainPact(state, vassal)) return { ok: false, reason: 'already sworn to another' };
  if (suzerainPact(state, suzerain)) return { ok: false, reason: 'a vassal cannot take vassals' };
  // …and the mirror of that guard: a lord that HOLDS vassals cannot itself kneel.
  // The two clauses together are what keep the vassalage graph one level deep,
  // which is the only shape the flat `player.team` integer can represent. The
  // reverse case was guarded from the start; this one was missed, and the result
  // was exactly the orphan signPact's own comment names: the middle realm's team
  // moved with its new lord while its vassal's did not, so the vassal kept paying
  // tribute to a banner it was now hostile to, `terms.protect` bound nobody, and
  // allRivalsSworn saw a foreign team and held the Pax open forever. Re-teaming
  // the whole sub-tree instead (chains, properly) was rejected: it needs an
  // unwind order for out-of-order breaks, a tribute route for the middle realm,
  // and a second answer to "who is sovereign here" in every consumer of
  // sovereignTeamOf — a new diplomacy model, not a fix. Only LIVING vassals bind:
  // a pact whose vassal realm is already defeated is a dead letter the next
  // tickPacts will lapse, and must not stop a restoration (actions.acceptPleas)
  // from seating a realm.
  if (vassalsOf(state, vassal).some((p) => !state.players[p.vassal]?.defeated)) {
    return { ok: false, reason: 'a lord with vassals of its own cannot kneel' };
  }
  if (!playerTowns(state, vassal).length) return { ok: false, reason: 'they hold no town to rule' };
  if (a.team === b.team) return { ok: false, reason: 'already of one banner' };
  return { ok: true };
}

/**
 * Whether `suzerain` would ACCEPT `vassal`'s oath if it were offered.
 *
 * canOfferVassalage answers whether the contract is legal; this answers whether a
 * lord in its right mind would sign it. The deal promises protection, so a lord that
 * cannot protect has nothing to sell — and a lord no stronger than its vassal has
 * bought a rival that outgrows it inside a month (the PACT_LOYALTY_WEAK_LORD reason
 * exists precisely because that pact rots).
 *
 * This is what a cornered AI consults before it sends envoys, so the refusals it
 * meets are the same refusals a thinking lord would give.
 */
export function wouldTakeVassal(state, suzerain, vassal) {
  const check = canOfferVassalage(state, suzerain, vassal);
  if (!check.ok) return check;
  if (realmForce(state, suzerain) < realmForce(state, vassal) * CONFIG.PACT_ACCEPT_OVERMATCH) {
    return { ok: false, reason: 'they could not protect us' };
  }
  return { ok: true };
}

/**
 * Default terms — the deal as it was first described: they keep their mines and
 * their farms, they send a share of the proceeds, they answer the call when a
 * wave lands, and in exchange they are defended.
 */
export function defaultTerms() {
  return {
    tributeShare: CONFIG.PACT_TRIBUTE_SHARE,
    levy: true,     // sends troops when an invasion is afoot
    protect: true,  // the suzerain is expected to answer an attack on them
    // Market rights: the suzerain may recruit from the vassal's dwellings, paying
    // from their OWN treasury. Asked for in the words that set the whole deal —
    // "he gets his town and the applicable mines and tends over his land, but I will
    // need to be able to buy creatures from his town with permission". It is the
    // thing that makes a vassal worth more than the tribute: a Tower vassal sells you
    // Titans your Castle will never build.
    trade: true,
    // Husbandry: the vassal's stewards work the weekly sites in their own lands
    // — windmills, water wheels, trade fairs — and the suzerain takes the same
    // share of the yield as of everything else. Asked for in the words that set
    // it: "I give a part of the kingdom for the vassals to organise their heroes
    // to tend over water wheels and mills to collect all and give me a cut, as
    // each week a lot of revenue is lost." It is: 90% of weekly sites on a
    // medium map are never visited by anybody (see CONFIG.PACT_HUSBANDRY_YIELD).
    husbandry: true,
  };
}

/**
 * May `buyer` recruit from `town`? Their own town always; a vassal's when the pact
 * granted market rights.
 *
 * Pure and cheap, so the view can ask it per frame when deciding whether a town chip
 * is openable.
 */
export function canRecruitFrom(state, buyer, town) {
  if (!town || buyer == null || buyer < 0) return false;
  if (town.owner === buyer) return true;
  const pact = suzerainPact(state, town.owner);
  return !!(pact && pact.suzerain === buyer && pact.terms?.trade);
}

// ---------------------------------------------------------------------------
// Envoys to a player
// ---------------------------------------------------------------------------

/**
 * A cornered realm's standing offer to a HUMAN, waiting for an answer.
 *
 * The AI could always swear to another AI on the spot (AIPlayer.maybeSeekTerms), but
 * a human has to be asked, and there was no channel to ask through — so the silence
 * was treated as a refusal and the realm went looking for foreign money instead. A
 * chronicle showed the cost of that: one rival at 0.96 cornered for twenty-three
 * straight days, 217,000 of troops locked in a garrison it could not move, and no
 * possible patron on the board. It just sat there dying.
 *
 * An offer is plain data on state, so it survives a save and the view can raise it
 * whenever the player next looks. One per petitioner; a fresh ask replaces a stale one.
 */
export const pactOffers = (state) => state.pactOffers || [];

/** Put an offer on the table for `to` (a human). Returns the offer. */
export function offerVassalage(state, from, to, terms = defaultTerms()) {
  const check = canOfferVassalage(state, to, from);
  if (!check.ok) return null;
  const offers = (state.pactOffers ||= []);
  const at = offers.findIndex((o) => o.from === from);
  const offer = {
    from, to, day: state.day, terms: { ...terms },
    towns: playerTowns(state, from).length,
    force: Math.round(realmForce(state, from)),
  };
  if (at >= 0) offers[at] = offer; else offers.push(offer);
  return offer;
}

/** Drop an offer from the table (answered, or gone stale). */
export function clearOffer(state, from) {
  if (!state.pactOffers) return false;
  const at = state.pactOffers.findIndex((o) => o.from === from);
  if (at < 0) return false;
  state.pactOffers.splice(at, 1);
  if (!state.pactOffers.length) delete state.pactOffers;
  return true;
}

/**
 * The player says yes. Signs the pact on the offer's own terms and takes it off the
 * table. Returns signPact's result.
 */
export function acceptOffer(state, from) {
  const offer = pactOffers(state).find((o) => o.from === from);
  if (!offer) return { ok: false, reason: 'no such offer' };
  const res = signPact(state, offer.to, offer.from, offer.terms);
  if (res.ok) clearOffer(state, from);
  return res;
}

/**
 * The player says no — and refusing is not free. The petitioner remembers who turned
 * them down, which is what sends them looking for a patron (patrons.refuseTerms).
 * Injected rather than imported: patrons.js imports this module.
 */
export function declineOffer(state, from, onRefused = null) {
  const offer = pactOffers(state).find((o) => o.from === from);
  if (!offer) return false;
  clearOffer(state, from);
  onRefused?.(state, offer.to, offer.from);
  return true;
}

/**
 * Sign a pact: the vassal joins the suzerain's banner.
 *
 * The vassal's own team is recorded on the pact so a revolt can hand it back —
 * a broken oath must restore the world to two realms at war, not leave an
 * orphan on a team it never belonged to.
 */
export function signPact(state, suzerain, vassal, terms = defaultTerms()) {
  const check = canOfferVassalage(state, suzerain, vassal);
  if (!check.ok) return { ok: false, reason: check.reason };
  const a = state.players[suzerain];
  const b = state.players[vassal];
  const pact = {
    id: `P${(state.nextPactId = (state.nextPactId || 0) + 1)}`,
    suzerain,
    vassal,
    vassalTeam: b.team,       // to be handed back if the oath breaks
    terms: { ...terms },
    loyalty: CONFIG.PACT_LOYALTY_START,
    signedDay: state.day,
    reasons: [],              // last week's loyalty movement, for the UI
  };
  b.team = a.team;
  (state.pacts ||= []).push(pact);
  logMsg(state, `${b.name} swears to ${a.name}, keeping their own lands and sending a share of the proceeds.`);
  return { ok: true, pact };
}

/**
 * End a pact. `reason` is 'revolt' when loyalty ran out, 'released' when the
 * suzerain let them go, 'lost' when one side ceased to exist, and 'uprising' when
 * somebody outside paid for it (see core/uprisings.js) — which is a revolt in the
 * mechanics and a different event entirely in the fiction, so it gets its own line
 * and does NOT mark a default: a rebellion bought by a third party is not the
 * rebel walking away from their own creditor.
 */
export function breakPact(state, pactId, reason = 'revolt') {
  const i = allPacts(state).findIndex((p) => p.id === pactId);
  if (i < 0) return null;
  const pact = state.pacts[i];
  state.pacts.splice(i, 1);
  const b = state.players[pact.vassal];
  const a = state.players[pact.suzerain];
  if (b) b.team = pact.vassalTeam;
  // Throwing off a CREDITOR's banner is a default, not just a revolt. An oath sworn
  // to settle a bill (patrons.js settleDebt) does not discharge the bill, so walking
  // away from it is walking away from the money — and it costs the same credit that
  // repudiating outright does: nobody finances them again. Without this the flip was
  // free, and measured it takes about four weeks, which made a reckoning a formality.
  if (b && a && pact.underDebt && reason === 'revolt') {
    b.defaulted = state.day;
    (a.betrayedBy ||= {})[b.index] = state.day;
  }
  if (b && a) {
    logMsg(state, reason === 'revolt'
      ? `${b.name} throws off ${a.name}'s banner. The tribute stops; the border does not.`
      : reason === 'uprising'
        ? `${b.name} takes up arms against ${a.name}. The oath is broken, and it was bought.`
        : reason === 'released'
          ? `${a.name} releases ${b.name} from their oath.`
          : `The pact between ${a.name} and ${b.name} lapses.`);
  }
  return { pact, reason };
}

/**
 * What one week of tribute is worth: a share of what the vassal's lands actually
 * produce, never more than they hold.
 *
 * Taken off INCOME rather than off their stores, because the deal was a share of
 * the proceeds — their mines stay theirs and keep flying their flag.
 */
export function tributeDue(state, pact, dailyIncome) {
  const vassal = state.players[pact.vassal];
  if (!vassal || vassal.defeated) return {};
  const share = Math.max(0, pact.terms?.tributeShare || 0);
  if (share <= 0) return {};
  const income = dailyIncome(state, vassal) || {};
  const due = {};
  for (const [res, perDay] of Object.entries(income)) {
    const week = Math.floor(perDay * CONFIG.DAYS_PER_WEEK * share);
    const have = Math.max(0, vassal.resources[res] || 0);
    const take = Math.min(week, have);
    if (take > 0) due[res] = take;
  }
  return due;
}

/**
 * This week's loyalty movement, as a list of { delta, why } — the list IS the UI.
 * A vassal that revolts should be one the player watched slide, and that means
 * the reasons have to be legible while it is still happening.
 */
export function loyaltyReasons(state, pact, { invasionAfoot = false } = {}) {
  const out = [];
  const vassal = state.players[pact.vassal];
  const suzerain = state.players[pact.suzerain];
  if (!vassal || !suzerain) return out;

  // Weight of the tribute. A light hand is forgiven; a heavy one is remembered.
  const share = pact.terms?.tributeShare || 0;
  const tributePain = Math.round((share - CONFIG.PACT_TRIBUTE_EASY) * CONFIG.PACT_TRIBUTE_WEIGHT);
  if (tributePain > 0) out.push({ delta: -tributePain, why: `the tribute is heavy (${Math.round(share * 100)}%)` });
  else if (tributePain < 0) out.push({ delta: -tributePain, why: 'the tribute is light' });

  // Protection. Losing ground while sworn to someone is the fastest way to stop
  // believing in them; holding what you have is quiet reassurance.
  const towns = playerTowns(state, pact.vassal).length;
  if (pact.lastTowns != null && towns < pact.lastTowns) {
    out.push({ delta: -CONFIG.PACT_LOYALTY_LOST_TOWN, why: 'they lost a town under your banner' });
  } else if (towns > 0) {
    out.push({ delta: CONFIG.PACT_LOYALTY_HELD, why: 'their lands are quiet' });
  }

  // A protector who cannot protect. Obedience to someone weaker than you looks
  // less like duty and more like a decision you keep making.
  const mine = realmForce(state, pact.suzerain);
  const theirs = realmForce(state, pact.vassal);
  if (theirs > mine * CONFIG.PACT_OVERMATCH) {
    out.push({ delta: -CONFIG.PACT_LOYALTY_WEAK_LORD, why: 'their armies now outmatch yours' });
  }

  // A shared enemy is the best glue there is.
  if (invasionAfoot) out.push({ delta: CONFIG.PACT_LOYALTY_SHARED_ENEMY, why: 'a foreign wave is afoot' });

  // And the debt that does not fade: you took their nation back off whoever had
  // it and handed it to them. A liberated realm is a different kind of vassal
  // from a beaten one, permanently — which is the whole reason to liberate rather
  // than annex, since annexing pays better this week and worse every week after.
  if (pact.liberated) {
    out.push({ delta: CONFIG.PACT_LOYALTY_LIBERATED, why: 'you gave them their nation back' });
  }

  // And the mirror of it. An oath sworn because a bill could not be paid (see
  // patrons.js settleDebt) is a different kind of oath from one that was
  // negotiated, permanently: they swore to a creditor, not to a lord. It bleeds
  // every week, so a realm taken by debt is the least stable thing on the map and
  // will throw the banner off the moment it can afford to.
  if (pact.underDebt) {
    out.push({ delta: -CONFIG.PACT_LOYALTY_UNDER_DEBT, why: 'they swore to a creditor, not a lord' });
  }

  return out;
}

/** Sum of a reasons list. */
export const loyaltySwing = (reasons) => reasons.reduce((n, r) => n + r.delta, 0);

/**
 * The weekly tick: collect tribute, move loyalty, and let go of any oath that has
 * run out. Returns log-ready events; empty when there are no pacts at all, which
 * is what keeps a game that never used this byte-identical.
 *
 * `deps.dailyIncome` is injected: actions.js imports this module, so importing it
 * back would be a real cycle.
 */
export function tickPacts(state, deps = {}) {
  const pacts = allPacts(state);
  if (!pacts.length) return [];
  const events = [];
  const invasionAfoot = !!deps.invasionAfoot;

  for (const pact of [...pacts]) {
    const vassal = state.players[pact.vassal];
    const suzerain = state.players[pact.suzerain];
    // Either side gone, or the vassal has no land left: the contract has nothing
    // to bind. Lapse it rather than leaving a ghost on somebody's team.
    if (!vassal || !suzerain || vassal.defeated || suzerain.defeated || !playerTowns(state, pact.vassal).length) {
      breakPact(state, pact.id, 'lost');
      continue;
    }
    // A suzerain that is ITSELF sworn is an illegal chain — canOfferVassalage now
    // refuses it in both directions, so this only ever matches a save written
    // before that gate closed. Such a save already holds the orphan the guard
    // exists to prevent: the middle realm's team moved with its new lord, this
    // pact's vassal stayed behind on the old one, and the two are now mutually
    // hostile while tribute still flows. Lapse the INNER pact — vassalTeam hands
    // the orphan its own sovereign banner back, which is the one restoration the
    // flat team model can make good on. (Breaking the OUTER pact instead would
    // punish the newest, legally-signed oath for the stale one's sake.)
    if (suzerainPact(state, pact.suzerain)) {
      breakPact(state, pact.id, 'lost');
      continue;
    }

    if (deps.dailyIncome) {
      const due = tributeDue(state, pact, deps.dailyIncome);
      const paid = [];
      for (const [res, amount] of Object.entries(due)) {
        vassal.resources[res] = Math.max(0, (vassal.resources[res] || 0) - amount);
        suzerain.resources[res] = (suzerain.resources[res] || 0) + amount;
        paid.push(`${amount} ${res}`);
      }
      if (paid.length) {
        events.push({ kind: 'tribute', pactId: pact.id, text: `${vassal.name} sends ${paid.join(', ')} in tribute.` });
      }
    }

    const reasons = loyaltyReasons(state, pact, { invasionAfoot });
    pact.reasons = reasons;
    pact.loyalty = Math.max(0, Math.min(100, pact.loyalty + loyaltySwing(reasons)));
    pact.lastTowns = playerTowns(state, pact.vassal).length;

    if (pact.loyalty <= CONFIG.PACT_LOYALTY_REVOLT) {
      breakPact(state, pact.id, 'revolt');
      events.push({ kind: 'revolt', pactId: pact.id, text: `${vassal.name} has thrown off ${suzerain.name}'s banner.` });
    } else if (pact.loyalty <= CONFIG.PACT_LOYALTY_WARN && !pact.warned) {
      pact.warned = true;
      events.push({ kind: 'restless', pactId: pact.id, text: `${vassal.name} grows restless under ${suzerain.name}'s banner.` });
    } else if (pact.loyalty > CONFIG.PACT_LOYALTY_WARN) {
      pact.warned = false;
    }
  }
  return events;
}

/**
 * How cornered a realm is, 0 (comfortable) to 1 (finished).
 *
 * The predicate behind a realm's second verb. A realm being ground down has no
 * concept of "this is over, I need terms" — it keeps feeding heroes into a line
 * it cannot hold, which is exactly the endgame a player describes as the AI being
 * no match. Land held against what it started with, and its best army against the
 * best in the world.
 */
export function corneredScore(state, playerIndex) {
  const player = state.players?.[playerIndex];
  if (!player || player.defeated) return 1;
  const towns = playerTowns(state, playerIndex).length;
  if (towns === 0) return 1;
  const living = state.players.filter((p) => !p.defeated).length || 1;
  const totalTowns = Object.values(state.towns).filter((t) => t.owner >= 0).length || 1;
  // Land measured against a FAIR share, not against the whole map: one town of
  // three realms' worth is holding its own, one town of eight is being squeezed.
  const fair = 1 / living;
  const landPressure = clamp01(1 - (towns / totalTowns) / Math.max(1e-6, fair));

  let strongest = 0;
  for (const p of state.players) {
    if (p.defeated || p.index === playerIndex) continue;
    strongest = Math.max(strongest, realmForce(state, p.index));
  }
  const mine = realmForce(state, playerIndex);
  const forcePressure = clamp01(1 - (strongest > 0 ? mine / strongest : 1));

  // Weighted toward FORCE, because that is what decides whether the squeeze can
  // be broken. A realm on one town with the best army in the world is a fortress
  // and asks nobody for terms; a realm with land it cannot defend is finished
  // whatever the map says.
  return clamp01(forcePressure * CONFIG.PACT_CORNERED_FORCE_WEIGHT
    + landPressure * (1 - CONFIG.PACT_CORNERED_FORCE_WEIGHT));
}

/**
 * Is this realm desperate enough to seek terms?
 *
 * The town clause is not a technicality. A landless realm scores a flat 1.00 cornered
 * — measured, in an ordinary four-player game, from about day six — and canOfferVassalage
 * would refuse its oath anyway, because a realm with nothing left to rule is a conquest
 * and not a contract. Without the clause, the first thing the AI diplomacy hook did was
 * send envoys on behalf of realms that were simply dying.
 */
export function wouldSeekTerms(state, playerIndex) {
  // CLONE-ONLY GATE. Upstream this function is unflagged and an AI realm that is
  // being ground down will swear vassalage to its attacker — after which the two
  // fight as one banner. Measured here: 6 of 8 seeds of a plain 2-player
  // castle-vs-inferno AI game ended up merged onto one team by day 45, which made
  // the default AI testbed an alliance simulator rather than a contest.
  //
  // The behaviour is kept in full and gated instead of deleted, and the gate sits
  // HERE rather than at the ai/AIPlayer.js call site (maybeSeekTerms) so that file
  // stays byte-identical to upstream and AI work patches cleanly in both
  // directions. This is the only choke point that needs it: AIPlayer bails out of
  // the whole diplomacy branch the moment this returns false.
  //
  // Flip `vassalage` on (game/settings.js) to study the diplomacy arc itself.
  if (!featureOn(state, 'vassalage')) return false;
  return !isVassal(state, playerIndex)
    && playerTowns(state, playerIndex).length > 0
    && corneredScore(state, playerIndex) >= CONFIG.PACT_CORNERED_THRESHOLD;
}

/**
 * Can `liberator` hand `fallen` its nation back, using a town they now hold?
 *
 * The case this exists for: an invader overran a realm, you beat the invader, and
 * the town in your hands used to be someone else's capital. Keeping it is worth
 * more this week. Giving it back is worth more every week after.
 */
export function canRestoreRealm(state, liberator, fallen, townId) {
  const a = state.players?.[liberator];
  const b = state.players?.[fallen];
  const town = state.towns?.[townId];
  if (!a || !b || !town) return { ok: false, reason: 'no such realm or town' };
  if (liberator === fallen) return { ok: false, reason: 'a realm cannot restore itself' };
  if (a.defeated) return { ok: false, reason: 'you hold nothing to give' };
  if (town.owner !== liberator) return { ok: false, reason: 'that town is not yours to give' };
  if (playerTowns(state, fallen).length) return { ok: false, reason: 'that realm still stands' };
  if (suzerainPact(state, liberator)) return { ok: false, reason: 'a vassal cannot make vassals' };
  if (playerTowns(state, liberator).length <= 1) return { ok: false, reason: 'that is your last town' };
  return { ok: true };
}

/**
 * The envoys of the conquered: which fallen realms would beg for their nation
 * back, and which of `liberator`'s towns each would be given.
 *
 * Asked for after a conquest win: "can we allow the other opponents to plead, and
 * I give them one castle and a vassalage each so they can return". Taking every
 * town on the map is the end of the WAR; it does not have to be the end of the
 * MAP, and a realm handed its capital back and sworn to your banner is the
 * cheapest garrison on a coast about to be invaded.
 *
 * Which town: their OWN faction's town first — that is their old capital, and
 * giving a Castle back to a Castle lord reads as restoration rather than charity.
 * Failing that, the least-developed town you hold, because the point is to seat a
 * realm, not to gut your own. Never your last town, and never two realms on one
 * town: each pick is removed from the pool before the next realm chooses.
 *
 * Pure and side-effect free — it only reports what acceptPleas would do, so the
 * dialog can name the towns before anyone commits. Invaders never plead: a people
 * from outside the world did not come to be given a province.
 */
export function pleaOffers(state, liberator) {
  const me = state.players?.[liberator];
  if (!me || me.defeated) return [];
  if (suzerainPact(state, liberator)) return []; // a vassal cannot make vassals
  const fallen = (state.players || [])
    .filter((p) => p.defeated && !p.invader && p.index !== liberator)
    .sort((a, b) => a.index - b.index); // deterministic
  if (!fallen.length) return [];

  // Towns we could part with, worst first — you keep your best. `- 1` because
  // canRestoreRealm refuses to hand over your last town, and rightly.
  const pool = playerTowns(state, liberator)
    .slice()
    .sort((a, b) => (a.buildings?.length || 0) - (b.buildings?.length || 0)
      || (a.id < b.id ? -1 : 1));
  let budget = Math.max(0, pool.length - 1);

  const offers = [];
  for (const p of fallen) {
    if (budget <= 0) break;
    const ownIdx = pool.findIndex((t) => t.faction === p.faction);
    const idx = ownIdx >= 0 ? ownIdx : 0;
    const town = pool.splice(idx, 1)[0];
    if (!town) break;
    budget--;
    offers.push({
      player: p.index,
      name: p.name,
      faction: p.faction,
      townId: town.id,
      townName: town.name,
      theirCapital: ownIdx >= 0, // a town of their own faction: their old seat
    });
  }
  return offers;
}

/** The nearest open land tile around (cx,cy) — where a restored realm's first
 *  hero musters. Null when there is no room at all. */
function openTileNear(state, cx, cy) {
  for (let r = 1; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        const t = tileAt(state, x, y, 0);
        if (!t || t.obstacle || t.objectId || t.terrain === 'water') continue;
        if (heroAt(state, x, y, 0)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * Give a conquered realm its nation back, and take its oath.
 *
 * Un-defeats the realm, hands it the town, musters it a hero of its own faction,
 * and signs a pact marked `liberated` — which is a standing loyalty bonus for as
 * long as the pact lives, not a one-off. A realm restored by your hand is the most
 * reliable vassal in the game, and it cost you a town you could have kept.
 *
 * `pact: false` liberates without taking an oath — an independent neighbour who
 * owes you nothing but remembers.
 */
export function restoreRealm(state, liberator, fallen, townId, { pact = true, terms } = {}) {
  const check = canRestoreRealm(state, liberator, fallen, townId);
  if (!check.ok) return { ok: false, reason: check.reason };
  const b = state.players[fallen];
  const town = state.towns[townId];

  town.owner = fallen;
  b.defeated = false;
  b.daysWithoutTown = 0;
  if (!b.heroPool) b.heroPool = [];

  // A restored realm with no commander is a flag on a building. Muster one.
  let hero = null;
  const spot = openTileNear(state, town.x, town.y);
  if (spot) {
    const roster = heroesOfFaction(b.faction) || [];
    const pick = roster[0];
    const rosterId = typeof pick === 'string' ? pick : pick?.id;
    if (rosterId) hero = createHero(state, rosterId, fallen, spot.x, spot.y);
  }

  logMsg(state, `${state.players[liberator].name} restores ${b.name} to ${town.name}.`);
  if (!pact) return { ok: true, town, hero, pact: null };

  const signed = signPact(state, liberator, fallen, terms || defaultTerms());
  if (signed.ok) {
    signed.pact.liberated = true;
    signed.pact.loyalty = Math.min(100, CONFIG.PACT_LOYALTY_START + CONFIG.PACT_LOYALTY_LIBERATED_START);
  }
  return { ok: true, town, hero, pact: signed.pact || null };
}
