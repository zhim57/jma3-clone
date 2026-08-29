/**
 * patrons.js — the cornered realm that was refused goes and finds a sponsor.
 *
 * The rule this exists to make true: REFUSING TO NEGOTIATE WITH SOMEONE WEAK IS
 * ONLY SAFE IF YOU CAN ACTUALLY FINISH THEM.
 *
 * Squeezing a rival down to one town and leaving it there is the strongest play in
 * the game as it stands, and it is the least realistic thing in it. A cornered
 * party that is refused does not sit and wait to be mopped up — it goes looking for
 * somebody who would rather pay for a war on your flank than fight one on their own
 * ground. Germany did not conquer Russia in 1917; it put Lenin on a sealed train
 * with a chest of gold, because a revolution was cheaper than an eastern front. A
 * squeezed supplier goes to outside financing and comes back as a competitor.
 * Yahoo declined to negotiate with Google. Blockbuster laughed at Netflix.
 *
 * Which makes patronage the other half of pacts. `pacts.js` is what happens when
 * terms are ACCEPTED: a realm serves, pays tribute, and can revolt. This is what
 * happens when they are refused — the money moves anyway, just not to you.
 *
 * Three deliberate design choices:
 *
 *   It is NOT vassalage, so it is not a pact. Money flows from patron to client,
 *   not the other way, and the client's team never changes. That matters: there is
 *   nothing on the minimap to notice. A sponsored realm looks exactly like the
 *   realm you thought you had beaten.
 *
 *   The tell is INFERABLE, NOT ANNOUNCED. Half of every subsidy arrives as men of
 *   the PATRON'S OWN faction, delivered into the client's field army — veterans
 *   peeled off the patron's best commander where there is a line to peel, bought at
 *   market where there is not. So you march on the one-town realm you starved, and
 *   its line has Behemoths in it. You learn that somebody is paying before you learn
 *   who, and you learn it by looking at what you are fighting, which is how
 *   intelligence actually works. One log line ever, naming nobody.
 *
 *   And paying in blood rather than only coin is what gives the money teeth. A war
 *   chest spent at market rates arms a cornered realm to three per cent of an
 *   average kingdom army over twelve weeks — measured, not guessed. The people that
 *   owns the chest has eight armies in the field, each sized against the whole
 *   world. The purse was never the asset.
 *
 *   Nobody has to click anything. A realm cornered for PATRON_PATIENCE_DAYS with
 *   no offer on the table treats the silence as the refusal it is. An explicit
 *   refusal (`refuseTerms`) just spends that clock immediately.
 *
 *   AND THE BILL COMES DUE. A sponsorship leaves a ledger, and the ledger is where
 *   the mechanic earns its keep (`settleDebt`). The client pays, or it cannot pay and
 *   swears — which is how a people from outside the world ends up holding a local
 *   realm's banner without ever besieging it — or it cannot pay and its creditor
 *   cannot make it, and it repudiates. That last one is what a patron who gave until
 *   it was spent has coming, and it is the truest outcome of the three: Germany armed
 *   Lenin and got a Comintern. The client you armed becomes your problem.
 *
 * Unflagged on purpose, like pacts and liberation: feature flags are snapshotted
 * into state at newGame, so a flag added today can never be turned on in a game
 * already running — and a game already running, with a rival ground down to one
 * town, is precisely the game this was asked for. The cost of that is a weekly scan
 * over the player list, which draws no rng and writes nothing when no realm is
 * cornered. A world in balance never notices this module exists.
 *
 * Pure rule-engine: no Phaser, no view imports. `dailyIncome` is injected for the
 * same reason pacts.js injects it — actions.js imports this module.
 */

import { CONFIG } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { playerTowns, playerHeroes, logMsg } from './GameState.js';
import { armyValue } from './heroUtils.js';
import { corneredScore, isVassal, realmForce, signPact, defaultTerms } from './pacts.js';
import { isInvaderRealm } from './invaderRealms.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Every live patronage. Absent on a save written before this existed. */
export function allPatronages(state) {
  return state.patronages || [];
}

/** The patronage bankrolling `client`, or null. A client takes one purse. */
export function patronageFor(state, client) {
  return allPatronages(state).find((p) => p.client === client) || null;
}

/** Everyone `patron` is bankrolling. */
export function clientsOf(state, patron) {
  return allPatronages(state).filter((p) => p.patron === patron);
}

/** Is this realm being paid for by somebody outside? */
export const isSponsored = (state, playerIndex) => !!patronageFor(state, playerIndex);

/** Gold a realm could put into somebody else's war without gutting itself. */
export function spendable(state, playerIndex) {
  const p = state.players?.[playerIndex];
  if (!p || p.defeated) return 0;
  return Math.max(0, (p.resources?.gold || 0) - CONFIG.PATRON_TREASURY_FLOOR);
}

/**
 * The realm doing the squeezing, in three tiers of evidence.
 *
 *   1. Whoever REFUSED terms. A realm that asked and was turned down knows exactly
 *      whose flank it wants burned.
 *   2. Whoever has TAKEN THE MOST OF ITS TOWNS (captureTown keeps the tally). This
 *      is the tier that matters, and it exists because the obvious answer — the
 *      strongest realm in the world — is wrong in the exact case this feature is
 *      for. Measured: a people that lands with two million in armies outranks every
 *      local by an order of magnitude, so on force alone it becomes the "oppressor"
 *      of every cornered realm on the map the morning it arrives, and can therefore
 *      never be anybody's patron. That inverts the whole design. The realm actually
 *      grinding you down is the neighbour who has your towns.
 *   3. Failing both, the strongest hostile realm — a squeeze that has not cost a
 *      town yet still has a most-likely author.
 */
export function oppressorOf(state, client) {
  const me = state.players?.[client];
  if (!me) return -1;
  const usable = (i) => {
    const r = state.players?.[i];
    return r && !r.defeated && r.index !== client && r.team !== me.team ? i : -1;
  };
  if (Number.isInteger(me.refusedBy) && usable(me.refusedBy) >= 0) return me.refusedBy;

  let taker = -1, most = 0;
  for (const [key, n] of Object.entries(me.takenBy || {})) {
    const i = usable(Number(key));
    if (i >= 0 && n > most) { most = n; taker = i; }
  }
  if (taker >= 0) return taker;

  let best = -1, bestForce = -1;
  for (const p of state.players) {
    if (usable(p.index) < 0) continue;
    const force = realmForce(state, p.index);
    if (force > bestForce) { bestForce = force; best = p.index; }
  }
  return best;
}

/**
 * Record that `refuser` turned down `petitioner`'s offer of terms.
 *
 * The refusal is the trigger, not the tragedy: it names the target and spends the
 * patience clock, so the shopping happens at the next week's dawn rather than a
 * fortnight later. Saying no on Tuesday and finding the money already moved by the
 * following week is the whole shape of the Yahoo/Google beat.
 */
export function refuseTerms(state, refuser, petitioner) {
  const p = state.players?.[petitioner];
  if (!p) return false;
  p.refusedBy = refuser;
  p.refusedDay = state.day;
  p.corneredSince = Math.min(p.corneredSince ?? state.day, state.day - CONFIG.PATRON_PATIENCE_DAYS);
  return true;
}

/** Is this realm out of options long enough to look outside for help? */
export function wouldSeekPatron(state, playerIndex) {
  const p = state.players?.[playerIndex];
  if (!p || p.defeated) return false;
  // A people from outside the world came to conquer, not to beg — a broken invader
  // withdraws (the planner displaces it) rather than shopping for a purse.
  if (isInvaderRealm(state, playerIndex)) return false;
  if (isVassal(state, playerIndex) || isSponsored(state, playerIndex)) return false;
  // A defaulter is financed once. Repudiating a creditor is free in the moment and
  // closes the market for the rest of the game — which is the whole cost of it.
  if (p.defaulted != null) return false;
  if (!playerTowns(state, playerIndex).length) return false;
  if (corneredScore(state, playerIndex) < CONFIG.PACT_CORNERED_THRESHOLD) return false;
  const since = p.corneredSince;
  return Number.isFinite(since) && state.day - since >= CONFIG.PATRON_PATIENCE_DAYS;
}

/**
 * Who would pay for this war, ranked best first.
 *
 * Two motives, and they are not the same motive:
 *
 *   A LOCAL realm funds the enemy of somebody who overshadows IT. That is fear, and
 *   it is conditional — a local with nothing to fear from the oppressor has no
 *   reason to spend gold on somebody else's border (PATRON_FEAR_MIN).
 *
 *   A PEOPLE FROM OUTSIDE always qualifies, and outbids every local. It has no
 *   local balance to protect, its treasury is enormous, and its whole interest is
 *   to see the strongest realm here bled before it has to meet that realm itself.
 *   Which is what makes the jar part of the ocean: refuse the weak neighbour inside
 *   your world and the answer arrives from outside it.
 *
 * Deterministic: no rng, so a scan that finds nobody costs a game nothing.
 */
export function patronCandidates(state, client) {
  const me = state.players?.[client];
  if (!me) return [];
  const oppressor = oppressorOf(state, client);
  const foe = state.players?.[oppressor];
  if (!foe) return [];
  const foeForce = realmForce(state, oppressor);

  const out = [];
  for (const p of state.players) {
    if (p.defeated) continue;
    if (p.index === client || p.index === oppressor) continue;
    if (p.team === me.team) continue;      // an ally is help, not a patron
    if (p.team === foe.team) continue;     // and nobody funds their own enemy's war
    if (isVassal(state, p.index)) continue; // a sworn realm has no foreign policy
    // Never the human. Bankrolling somebody else's war is a decision with a price,
    // and a price is not something to take out of a player's treasury while they
    // are looking at a different screen. The player's side of this is the OFFER —
    // a cornered realm coming to them with a proposal — not an automatic debit.
    if (p.isHuman) continue;
    if (clientsOf(state, p.index).length >= CONFIG.PATRON_MAX_CLIENTS) continue;
    const purse = spendable(state, p.index);
    if (purse < CONFIG.PATRON_MIN_TREASURY) continue;

    const invader = isInvaderRealm(state, p.index);
    // Fear, for a local: how far the oppressor overshadows this realm's own army.
    const fear = invader ? 1 : clamp01(foeForce / Math.max(1, realmForce(state, p.index)));
    if (!invader && fear < CONFIG.PATRON_FEAR_MIN) continue;

    const money = clamp01(purse / CONFIG.PATRON_RICH);
    const score = money * fear * (invader ? CONFIG.PATRON_INVADER_WEIGHT : 1);
    out.push({ index: p.index, score, purse, invader, fear });
  }
  // Best score, ties to the lower index — a stable order, so the same world always
  // produces the same sponsor and a save replays.
  out.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return out;
}

/**
 * Find `client` a sponsor and open the account.
 *
 * Returns { ok, patronage } or { ok: false, reason }. Signing is silent by design —
 * no log line, no toast, nothing on the minimap. The first the world hears of it is
 * foreign troops in the client's line, weeks later.
 */
export function seekPatron(state, client) {
  if (isSponsored(state, client)) return { ok: false, reason: 'already bought' };
  const candidates = patronCandidates(state, client);
  if (!candidates.length) return { ok: false, reason: 'nobody will pay for this war' };
  const pick = candidates[0];
  const patronage = {
    id: `S${(state.nextPatronageId = (state.nextPatronageId || 0) + 1)}`,
    patron: pick.index,
    client,
    against: oppressorOf(state, client),
    signedDay: state.day,
    weeks: 0,
    paid: 0,        // total gold — the debt, for whoever calls it in one day
    shipped: 0,     // total aiValue of troops delivered
    revealed: false, // has the world seen the money yet?
  };
  (state.patronages ||= []).push(patronage);
  return { ok: true, patronage };
}

/** End a patronage. `reason` is 'outgrown', 'lapsed' or 'released'. */
export function endPatronage(state, id, reason = 'lapsed') {
  const i = allPatronages(state).findIndex((p) => p.id === id);
  if (i < 0) return null;
  const [patronage] = state.patronages.splice(i, 1);
  return { patronage, reason };
}

/**
 * This week's coin, capped by the purse and by what a subsidy is ever worth.
 *
 * Two channels, and the second one matters more than it looks. A share of weekly
 * INCOME is how a going concern funds a proxy war out of its mines. A share of the
 * PURSE is how a war chest gets spent — and a people from outside the world is
 * exactly that: an enormous treasury attached to two village halls. Germany did not
 * send Lenin a standing order against next quarter's receipts; it sent a chest.
 * Income-only sizing had the Horde sitting on forty thousand gold and dribbling out
 * a few hundred a week, which is a sponsor in name and nothing on the battlefield.
 *
 * The purse share is proportional, so a chest ramps down as it empties rather than
 * stopping dead.
 */
export function subsidyDue(state, patronage, dailyIncome) {
  const purse = spendable(state, patronage.patron);
  if (purse <= 0) return 0;
  const gold = (dailyIncome?.(state, state.players[patronage.patron])?.gold || 0);
  const fromIncome = gold * CONFIG.DAYS_PER_WEEK * CONFIG.PATRON_SUBSIDY_SHARE;
  const fromChest = purse * CONFIG.PATRON_TREASURY_SHARE;
  const week = Math.max(fromIncome, fromChest);
  const want = Math.min(CONFIG.PATRON_SUBSIDY_MAX, Math.max(CONFIG.PATRON_SUBSIDY_MIN, Math.round(week)));
  const pay = Math.min(want, purse);
  // A dribble is not a subsidy. A patron that cannot manage the floor pays nothing
  // this week and stays on the books — its mines may pay next week.
  return pay >= CONFIG.PATRON_SUBSIDY_MIN ? pay : 0;
}

/**
 * What a gold budget buys out of `faction`'s barracks: the strongest line troops
 * whose count lands in a readable window.
 *
 * Bought at market cost, not at aiValue, because a patron is spending coin the way
 * anybody else spends it. Upgraded forms excluded — a sponsor ships regulars, and
 * regulars are what makes the stack read as somebody else's men rather than as a
 * mysteriously elite local unit.
 */
export function contingentFor(faction, budget, rng = null) {
  const pool = Object.keys(CREATURES)
    .filter((id) => {
      const c = CREATURES[id];
      return c.faction === faction && !c.upgraded && !c.summonedOnly && (c.cost?.gold || 0) > 0;
    })
    .sort((a, b) => (CREATURES[b].aiValue || 0) - (CREATURES[a].aiValue || 0));
  if (!pool.length) return null;
  const count = (id) => Math.floor(budget / CREATURES[id].cost.gold);
  const window = pool.filter((id) => count(id) >= CONFIG.PATRON_SHIPMENT_MIN
    && count(id) <= CONFIG.PATRON_SHIPMENT_MAX);
  const choices = window.length
    ? window.slice(0, CONFIG.INVADER_TROOP_CHOICES)
    : [pool.find((id) => count(id) >= CONFIG.PATRON_SHIPMENT_MIN)].filter(Boolean);
  if (!choices.length) return null;
  const creature = rng ? choices[rng.int(0, choices.length - 1)] : choices[0];
  const n = Math.min(CONFIG.PATRON_SHIPMENT_MAX, count(creature));
  return n >= CONFIG.PATRON_SHIPMENT_MIN ? { creature, count: n } : null;
}

/**
 * Merge a stack into an army that may be SHORT.
 *
 * heroUtils' addToArmy walks the seven slots a hero is built with and gives up if it
 * finds none free — correct for a hero from createHero, wrong for one whose army was
 * assigned wholesale. musterCommander does exactly that (`hero.army = [{...}]`), so
 * every invader commander in the game carries a one-element array and cannot be
 * reinforced at all. Found by measurement: a detachment that could not be placed is
 * handed back to the patron, and handing it back into a one-slot array would have
 * destroyed the men.
 */
function placeStack(army, creature, count) {
  if (!Array.isArray(army) || count <= 0) return false;
  for (const stack of army) {
    if (stack && stack.creature === creature) { stack.count += count; return true; }
  }
  for (let i = 0; i < army.length; i++) {
    if (!army[i] || army[i].count <= 0) { army[i] = { creature, count, hurt: 0 }; return true; }
  }
  if (army.length < CONFIG.ARMY_SLOTS) { army.push({ creature, count, hurt: 0 }); return true; }
  return false;
}

/**
 * A detachment off the patron's OWN line: a share of one stack from its strongest
 * commander, of its own faction.
 *
 * This exists because the coin alone was measured and found to be theatre. A war
 * chest of forty thousand gold, spent at market rates, arms a cornered realm to
 * three per cent of an average kingdom army over twelve weeks — a visible tell
 * attached to nothing. Meanwhile the people that owns the chest has eight armies in
 * the field, each sized against the whole world. The purse was never the asset.
 *
 * Germany's decisive help to the Bolsheviks was not the gold; it was that Germany
 * was already fighting Russia. So a patron pays in BLOOD, not just coin: it peels a
 * tenth of a stack off its best commander and puts it in the client's line. Nothing
 * is minted — the patron is weaker by exactly what the client is stronger, which is
 * what makes sponsoring a proxy a real decision instead of a free one, and what
 * makes it self-limiting.
 *
 * Returns { creature, count } or null when there is nothing to spare: a patron never
 * detaches down to a weaker army than the client it is arming, and never empties a
 * stack.
 */
export function detachmentFrom(state, patronIndex, clientIndex) {
  const patron = state.players?.[patronIndex];
  if (!patron) return null;
  const mine = playerHeroes(state, patronIndex)
    .slice()
    .sort((a, b) => armyValue(b.army) - armyValue(a.army))[0];
  if (!mine) return null;
  // Nothing to spare: a sponsor with no more men than its client is a client.
  const theirs = Math.max(0, ...playerHeroes(state, clientIndex).map((h) => armyValue(h.army)));
  if (armyValue(mine.army) <= theirs) return null;

  let best = null;
  for (const s of mine.army) {
    if (!s || s.count <= 1) continue;
    if (CREATURES[s.creature]?.faction !== patron.faction) continue;
    const worth = (CREATURES[s.creature].aiValue || 0) * s.count;
    if (!best || worth > best.worth) best = { stack: s, worth };
  }
  if (!best) return null;
  const share = Math.round(best.stack.count * CONFIG.PATRON_DETACH_SHARE);
  const count = Math.min(best.stack.count - 1, Math.max(CONFIG.PATRON_DETACH_MIN, share));
  if (count < CONFIG.PATRON_DETACH_MIN) return null;
  best.stack.count -= count;
  return { creature: best.stack.creature, count };
}

/**
 * Put a contingent where the player will meet it: the client's strongest army in
 * the field first, its capital garrison if there is no army to reinforce.
 *
 * The field army is the point. A shipment sitting in a garrison is a surprise for
 * whoever storms the town; a shipment marching out is a surprise for whoever
 * thought this realm was finished.
 */
export function deliverContingent(state, client, creature, count) {
  const heroes = playerHeroes(state, client)
    .slice()
    .sort((a, b) => armyValue(b.army) - armyValue(a.army));
  for (const hero of heroes) {
    if (placeStack(hero.army, creature, count)) return { where: 'hero', heroId: hero.id };
  }
  for (const town of playerTowns(state, client)) {
    if (placeStack(town.garrison, creature, count)) return { where: 'town', townId: town.id };
  }
  return null;
}

/**
 * The foreign metal in a realm's hands: troops of nobody's faction here but their
 * sponsor's.
 *
 * This IS the tell, computed rather than announced — the number behind "armies its
 * income cannot explain". Neutral creatures do not count, because wild stacks join
 * realms all the time; a Rampart realm fielding Behemoths is a different claim.
 * Deliberately noisy at the edges (an army can pick up another faction's dwelling),
 * because an inference the player has to make is worth more than a readout.
 */
export function unexplainedForce(state, playerIndex) {
  const p = state.players?.[playerIndex];
  if (!p) return { value: 0, share: 0, stacks: [] };
  const stacks = [];
  let foreign = 0, total = 0;
  const scan = (army) => {
    for (const s of army || []) {
      if (!s || s.count <= 0) continue;
      const c = CREATURES[s.creature];
      if (!c) continue;
      const worth = (c.aiValue || 0) * s.count;
      total += worth;
      if (c.faction === p.faction || c.faction === 'neutral') continue;
      foreign += worth;
      stacks.push({ creature: s.creature, count: s.count, faction: c.faction, value: worth });
    }
  };
  for (const hero of playerHeroes(state, playerIndex)) scan(hero.army);
  for (const town of playerTowns(state, playerIndex)) scan(town.garrison);
  return { value: foreign, share: total > 0 ? foreign / total : 0, stacks };
}

/**
 * The desirability bias money creates: a patron marches on the realm it is paying to
 * have fought, and neither party marches on the other.
 *
 * Without this, patronage is a wire transfer with no front attached — the Horde funds
 * a war on your border and then wanders off to loot a windmill. Germany's decisive
 * help to the Bolsheviks was that Germany was ALREADY fighting Russia; the money only
 * made sense as part of a war the patron was prosecuting anyway. So a sponsorship
 * points its patron's armies at the client's oppressor, and points the client's at the
 * same realm from the other side.
 *
 * Returns (owner) => multiplier, or null when this realm has no money in anybody's
 * war — the null is what keeps the AI's hot path free when nothing is sponsored.
 * Shaped exactly like balanceOfPowerBias so the two compose: DESIRABILITY only, never
 * the army-superiority gate, so a bias can covet a target but never order a hopeless
 * attack. The truce half is a damp rather than a prohibition for the same reason —
 * a patron does not raid its own client, but if the client is the last thing standing
 * between it and victory the arithmetic is still allowed to say so.
 */
export function warBias(state, playerIndex) {
  const deals = allPatronages(state);
  if (!deals.length) return null;
  const covet = new Set();   // teams this realm has bought a war against
  const spare = new Set();   // teams it is not marching on while the money moves
  const teamOf = (i) => {
    const p = state.players?.[i];
    return p && !p.defeated ? (p.team ?? i) : null;
  };
  for (const deal of deals) {
    const side = deal.patron === playerIndex ? deal.client
      : deal.client === playerIndex ? deal.patron : null;
    if (side === null) continue;
    const foe = teamOf(deal.against);
    if (foe !== null) covet.add(foe);
    const friend = teamOf(side);
    if (friend !== null) spare.add(friend);
  }
  if (!covet.size && !spare.size) return null;
  return (owner) => {
    const team = state.players?.[owner]?.team ?? owner;
    // Coveting wins a tie: if the realm paying you is also the realm squeezing you,
    // the war you were paid for is the war you are in.
    if (covet.has(team)) return CONFIG.PATRON_WAR_BIAS;
    if (spare.has(team)) return CONFIG.PATRON_TRUCE_DAMP;
    return 1;
  };
}

/** The bill: coin handed over plus what the men cost to raise. */
export const debtOf = (patronage) => Math.round(patronage?.owed || 0);

/**
 * Everything a realm can put in the way of a creditor: every army in the field plus
 * every garrison.
 *
 * Deliberately NOT realmForce, which is the strongest single hero — the right measure
 * for "can this commander beat that one" and the wrong one for "can this realm make
 * that realm pay". The distinction is load-bearing and was measured: detachmentFrom
 * peels men off the patron's STRONGEST commander, so by the time an account closes the
 * creditor's best army has been ground down by its own generosity. Judged on that one
 * army, a people with two million in the field and six commanders still standing could
 * not enforce a bill against a realm holding a third of one of them, and every
 * sponsorship in the game ended in repudiation. Enforcement is a realm against a realm.
 */
export function realmArmy(state, playerIndex) {
  let total = 0;
  for (const hero of playerHeroes(state, playerIndex)) total += armyValue(hero.army);
  for (const town of playerTowns(state, playerIndex)) total += armyValue(town.garrison);
  return total;
}

/**
 * Call in the debt.
 *
 * A sponsorship that ends leaves a ledger, and the ledger is the point. Germany
 * bankrolled Lenin and then presented the bill at Brest-Litovsk; the Bolsheviks
 * signed it, and repudiated it the moment Germany lost. Three ways it goes, and
 * which one is arithmetic the player can follow rather than a roll:
 *
 *   PAID — the client hoarded the coin instead of spending it. Debts are cheaper
 *   than wars, so if it can clear the bill it does, and the two part square.
 *
 *   SWORN — it cannot pay, and its creditor is strong enough to insist. A debt you
 *   cannot pay becomes a suzerainty; this is the door onto pacts.js, and it is how a
 *   people from outside the world ends up holding a local realm's banner without
 *   ever besieging it. Terms taken at the point of a bill are worse than terms
 *   negotiated (25% against the standing 15%), the oath starts colder, and
 *   `underDebt` bleeds loyalty every week after — so a realm taken this way is the
 *   least stable thing on the map.
 *
 *   REPUDIATED — it cannot pay and its creditor cannot make it. Which is precisely
 *   what a patron who gave until it was spent has coming: the two closing paths map
 *   onto the two outcomes almost by themselves, because a patron stops being able to
 *   send men at the exact moment it stops being able to enforce anything. The client
 *   keeps the gold and the veterans. The cost is its credit — nobody finances a
 *   defaulter twice, and `wouldSeekPatron` never looks at it again.
 *
 * Returns { outcome, bill, events }. Announced loudly, unlike the subsidy: the
 * subsidy has to be inferred, but a reckoning is public by nature.
 */
export function settleDebt(state, patronage) {
  const patron = state.players?.[patronage.patron];
  const client = state.players?.[patronage.client];
  const bill = debtOf(patronage);
  const events = [];
  if (!patron || !client || patron.defeated || client.defeated || bill <= 0) {
    return { outcome: 'written off', bill, events };
  }
  const push = (kind, text) => { events.push({ kind, text, patron: patron.index, client: client.index }); };

  if ((client.resources.gold || 0) >= bill) {
    client.resources.gold -= bill;
    patron.resources.gold = (patron.resources.gold || 0) + bill;
    logMsg(state, `${client.name} settles its accounts with ${patron.name} — ${bill} gold.`);
    push('debtPaid', `${client.name} has paid off ${patron.name}. Whatever passed between them is square.`);
    return { outcome: 'paid', bill, events };
  }

  const enforceable = realmArmy(state, patronage.patron)
    >= realmArmy(state, patronage.client) * CONFIG.PATRON_DEBT_OVERMATCH;
  if (enforceable) {
    const res = signPact(state, patronage.patron, patronage.client, {
      ...defaultTerms(), tributeShare: CONFIG.PATRON_DEBT_TRIBUTE,
    });
    if (res.ok) {
      res.pact.underDebt = true;
      res.pact.debt = bill;
      res.pact.loyalty = Math.max(1, CONFIG.PACT_LOYALTY_START - CONFIG.PATRON_DEBT_RESENTMENT);
      logMsg(state, `${client.name} could not pay the ${bill} gold it owed ${patron.name}.`);
      push('debtSworn', `${client.name} could not pay what it owed. It rules now in ${patron.name}'s name.`);
      return { outcome: 'sworn', bill, events, pact: res.pact };
    }
  }

  client.defaulted = state.day;
  (patron.betrayedBy ||= {})[client.index] = state.day;
  logMsg(state, `${client.name} repudiates the ${bill} gold it owes ${patron.name}.`);
  push('debtRepudiated',
    `${client.name} has repudiated its debts to ${patron.name} — and armed itself with them. `
    + 'No one will finance them again.');
  return { outcome: 'repudiated', bill, events };
}

/**
 * The weekly tick: pay what is owed, ship what was bought, close accounts that
 * have served their purpose, and let anyone who has been left to die go shopping.
 *
 * Returns log-ready events. Empty — and rng-free — in a world where nobody is
 * cornered, which is what keeps a game that never triggers this unchanged.
 *
 * `deps.dailyIncome` is injected: actions.js imports this module.
 */
export function tickPatronages(state, deps = {}) {
  const events = [];
  // Closing an account presents the bill. 'lapsed' does not go through here: a dead
  // patron collects nothing and a dead client owes nothing.
  const close = (patronage, reason) => {
    endPatronage(state, patronage.id, reason);
    events.push(...settleDebt(state, patronage).events);
  };

  for (const patronage of [...allPatronages(state)]) {
    const patron = state.players?.[patronage.patron];
    const client = state.players?.[patronage.client];
    // Either side gone, the client sworn to somebody, or the patron itself now a
    // vassal with no foreign policy left: close the account quietly.
    if (!patron || !client || patron.defeated || client.defeated
        || isVassal(state, patronage.client) || isVassal(state, patronage.patron)) {
      endPatronage(state, patronage.id, 'lapsed');
      continue;
    }
    // The client is out of danger. It keeps the men and the gold, the patron keeps
    // the receipt, and the war it was funded to fight is now its own. (`paid` is
    // left on nothing — the debt is deliberately recorded on the object rather than
    // forgiven, because "call in the debt" is the next thing this wants to grow.)
    //
    // PARITY WITH THE OPPRESSOR is the whole test, and deliberately the ONLY one.
    //
    // Comfort measured against the world at large was tried and is wrong in both
    // directions, both measured. Too lax: a client sponsored by a people ashore is
    // compared against the strongest realm anywhere, which IS its patron — two
    // million in armies — so it reads as cornered forever and the subsidy never
    // stops; twelve weeks of that made it 108% of an average kingdom army and still
    // climbing. Too strict: with a horde on the map, corneredScore falls below its
    // threshold at 380k while the realm the client was armed against fields 700k, so
    // the money stops at 54% of the war it was bought for. The account exists to
    // fight ONE realm. When it can, it closes; until then, it does not.
    const foe = state.players?.[patronage.against];
    if (!foe || foe.defeated
        || realmForce(state, patronage.client) >= realmForce(state, patronage.against) * CONFIG.PATRON_PARITY) {
      logMsg(state, `${client.name} no longer needs anyone's coin.`);
      close(patronage, 'outgrown');
      continue;
    }

    // A patron may be out of coin and still full of men, and men are the asset — a
    // dry purse must not stop the sponsorship, only the cash half of it. (An early
    // version skipped the whole week when the purse ran low, which quietly capped
    // every sponsorship at whatever the chest happened to hold.)
    const pay = subsidyDue(state, patronage, deps.dailyIncome);
    patronage.weeks++;
    if (pay > 0) patron.resources.gold = Math.max(0, (patron.resources.gold || 0) - pay);

    // Every other week, half the subsidy arrives as men rather than coin. In blood
    // if the patron has a line to peel — veterans off its own best commander, which
    // is the form that actually changes a war — and at market rates out of the purse
    // if it has no army in the field. The rest is coin, which the client's own AI
    // spends on its own troops out of its own dwellings.
    const shipWeek = patronage.weeks % CONFIG.PATRON_SHIPMENT_WEEKS === 0;
    const troopHalf = shipWeek ? Math.floor(pay * CONFIG.PATRON_SHIPMENT_SHARE) : 0;
    let delivered = null, lot = null, bought = false, worth = 0;
    if (shipWeek) {
      // Blood first.
      lot = detachmentFrom(state, patronage.patron, patronage.client);
      if (lot) {
        delivered = deliverContingent(state, patronage.client, lot.creature, lot.count);
        // A detachment that could not be placed goes back where it came from: a full
        // army on the receiving end must never destroy men.
        if (!delivered) deliverContingent(state, patronage.patron, lot.creature, lot.count);
      }
      // …coin second, for a purse with no line to peel.
      if (!delivered && troopHalf > 0) {
        lot = contingentFor(patron.faction, troopHalf, state.rng);
        if (lot) delivered = deliverContingent(state, patronage.client, lot.creature, lot.count);
        bought = !!delivered;
      }
      if (delivered) {
        patronage.shipped += (CREATURES[lot.creature].aiValue || 0) * lot.count;
        // The ledger, in gold, at what the men actually cost to raise. Kept at
        // shipment time rather than converted from aiValue afterwards, because
        // aiValue is a strength metric and a bill is a bill.
        worth = (CREATURES[lot.creature].cost?.gold || 0) * lot.count;
        patronage.owed = (patronage.owed || 0) + worth;
      }
    }

    // A sponsorship that has nothing left to send. Both taps can close: the purse
    // empties, and detachmentFrom stops peeling once the patron's best commander is
    // no longer stronger than the client it armed — which is the natural end point,
    // since every shipment moves the two closer together. Measured: without this the
    // account sat open forever at 99% of its parity target, inert, because the client
    // was by then better armed than any single army the patron had left to give.
    // A patron between paydays recovers in a week; one that is spent is spent.
    if (pay <= 0 && !delivered) {
      patronage.dry = (patronage.dry || 0) + 1;
      if (patronage.dry >= CONFIG.PATRON_DRY_WEEKS) {
        logMsg(state, `${patron.name} has nothing more to send ${client.name}.`);
        close(patronage, 'spent');
      }
      continue;
    }
    patronage.dry = 0;
    // The coin. Of the week's disbursement, troopHalf was earmarked for men. Bought,
    // it is spent — but only what the men actually cost, so the remainder of the
    // budget reaches the client as cash instead of evaporating. Sent as veterans, the
    // whole earmark goes home: the patron paid in blood and keeps the coin. Nothing
    // shipped at all, and the earmark is released as cash. Spent exactly once.
    const marketSpend = bought ? Math.min(worth, troopHalf) : 0;
    const heldBack = delivered && !bought ? troopHalf : 0;
    const coin = Math.max(0, pay - marketSpend - heldBack);
    client.resources.gold = (client.resources.gold || 0) + coin;
    if (heldBack > 0) patron.resources.gold += heldBack;
    patronage.paid += coin + marketSpend;
    patronage.owed = (patronage.owed || 0) + coin;

    // One line, ever, and it names nobody. The player learns that money is moving;
    // whose it is has to be read off the stacks they meet.
    if (delivered && !patronage.revealed) {
      patronage.revealed = true;
      events.push({
        kind: 'patronage',
        clientIndex: patronage.client,
        text: `${client.name} fields troops no one in these lands recruits. Someone outside is paying for this war.`,
      });
    }
  }

  // And the shopping. A realm that has been cornered for a fortnight with no offer
  // on the table has been refused, whether or not anyone said the word.
  //
  // AI realms only. A human being handed a foreign purse unasked is a decision
  // taken away from them — `wouldSeekPatron` and `patronCandidates` are exported so
  // the offer can be PUT to a human instead, which is the same beat from the other
  // side of the table.
  for (const p of state.players) {
    if (p.defeated || p.isHuman || p.invader) continue;
    const cornered = corneredScore(state, p.index) >= CONFIG.PACT_CORNERED_THRESHOLD;
    // Only ever CLEAR a clock that was set: a world in balance must not acquire a
    // key on every player just because this module ran.
    if (!cornered) { if (p.corneredSince != null) p.corneredSince = null; continue; }
    if (p.corneredSince == null) p.corneredSince = state.day;
    if (wouldSeekPatron(state, p.index)) seekPatron(state, p.index);
  }

  return events;
}
