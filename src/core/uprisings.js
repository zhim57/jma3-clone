/**
 * uprisings.js — the bought rebellion: sworn realms rise together, on foreign money.
 *
 * The gap this closes, in the words that set it: "I need the vassals either one by
 * one or two or three of them to suddenly decide from time to time to overthrow me
 * and take my castles — an outside power finances them and they can buy big armies,
 * so they can quickly amass huge armies and attack me."
 *
 * What was there before, and why it was not enough. `pacts.js` already lets a vassal
 * throw off the banner: loyalty slides for named reasons and crosses a threshold, and
 * the team integer moves back. That is a good REVOLT and a poor REBELLION, because of
 * what happens the morning after — a realm that was cornered enough to swear to you is
 * still cornered when it walks away, so the flip changes a colour on the minimap and
 * nothing else. Measured: a vassal at revolt is typically a one-town realm with an army
 * an order of magnitude under its lord's. It cannot take a castle, so it does not try,
 * and a rebellion the player never has to answer is not a rebellion.
 *
 * So the missing piece was never the trigger. It was the WAR CHEST.
 *
 * Which is exactly the shape `patrons.js` already argues for — a squeezed party goes to
 * outside financing and comes back as a competitor; Germany put Lenin on a sealed train
 * because a revolution was cheaper than an eastern front. Patronage aims that at the
 * realm being ground down. This aims it at the realm that has already WON: when one
 * banner covers half the map, the cheapest way to break it is not to fight it, it is to
 * pay the people already inside it. A coalition is only ever rented.
 *
 * Four things are deliberate:
 *
 *   THEY RISE TOGETHER. One, two or three at the same hour (UPRISING_REBEL_ODDS) —
 *   because the point of buying a rebellion is that the lord cannot be everywhere, and
 *   one rebel at a time is a police action. Which vassals is not a roll: `seducibility`
 *   ranks them by loyalty already on the slide, by their own strength, and by whether
 *   the oath was bought (`underDebt`) or given (`liberated`). The vassal you neglected
 *   is the vassal somebody else pays.
 *
 *   THE CHEST IS ENORMOUS AND IT ARRIVES AS MEN. 200-300k of gold each, of which
 *   UPRISING_HOST_SHARE lands immediately as a mustered host of their own faction
 *   rather than as coin — because coin has to be spent through dwellings that grow
 *   weekly, and a rebellion that needs six weeks of recruitment to become dangerous is
 *   one the player answers at leisure. The rest is gold in their treasury for their own
 *   AI to spend. Measured against patronage, which pays 6k a week at most: this is two
 *   orders of magnitude bigger, and it has to be, because a patron is keeping a dying
 *   realm alive and this is arming a live one to storm a capital.
 *
 *   THE MONEY IS FROM OUTSIDE. `foreignBackerFor` names an on-map power where one fits
 *   — a people from beyond the sea first, a frightened rival second — and that power
 *   pays what its purse can stand. Beyond that the chest is drawn on a power BEYOND THE
 *   MAP, and yes, that mints gold. It is the one place in this engine that does, and it
 *   is deliberate: no treasury inside a HoMM-scale world holds a quarter of a million
 *   spare, so sourcing it locally would mean the mechanic could only fire in games rich
 *   enough not to need it. The money that funds a rebellion generally does come from
 *   outside the theatre; that is the whole historical shape of the thing.
 *
 *   AND THEY CAN BE FORGIVEN. A rebel beaten back to nothing BEGS — `mercyPleas` — and
 *   the lord chooses which of their own castles to hand back. That is the other half of
 *   the request ("eventually they beg for mercy and one castle, at that time I can
 *   choose one that I wish to give to them, and keep them in the game and make the
 *   vassals again"), and it is why an uprising is a chapter rather than an elimination:
 *   the map that comes out the far side has the same realms on it, in different hands.
 *
 * Inert until there are pacts, like the modules it sits between: no live pact means no
 * eligible vassal, which means this returns before it constructs an Rng, writes nothing
 * and draws nothing. Unflagged for the same reason pacts and patronage are — flags are
 * snapshotted at newGame, and the game that wants this is the one already running.
 *
 * Off-switch: `state.vassalUprisings === false` (scenario/save level). Absent reads as
 * on, so an in-progress save adopts it at the next week's dawn.
 *
 * Pure rule-engine: no Phaser, no view imports. `dailyIncome` is not needed here, but
 * the same no-cycle rule applies — actions.js imports this module, never the reverse.
 */

import { CONFIG } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { heroesOfFaction } from '../data/heroes.js';
import { playerTowns, playerHeroes, logMsg, createHero, tileAt, heroAt } from './GameState.js';
import { armyValue } from './heroUtils.js';
import { Rng } from './rng.js';
import {
  allPacts, vassalsOf, isVassal, breakPact, realmForce,
  canRestoreRealm, restoreRealm, defaultTerms,
} from './pacts.js';
import { deliverContingent, realmArmy, spendable } from './patrons.js';
import { isInvaderRealm } from './invaderRealms.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Are bought rebellions live in this game? Absent reads as ON — see the header. */
export const uprisingsOn = (state) => (state?.vassalUprisings ?? true) !== false;

/** Every live uprising. Absent on a save written before this existed. */
export function allUprisings(state) {
  return state.uprisings || [];
}

/** The uprising `playerIndex` is in arms for, or null. */
export function uprisingOf(state, playerIndex) {
  return allUprisings(state).find((u) => u.rebels.some((r) => r.player === playerIndex)) || null;
}

/** Is this realm one of the risen? */
export const inUprising = (state, playerIndex) => !!uprisingOf(state, playerIndex);

/** Every uprising raised against `lord`. */
export function uprisingsAgainst(state, lord) {
  return allUprisings(state).filter((u) => u.against === lord);
}

/**
 * A stable 32-bit seed for ONE lord's weekly temptation.
 *
 * Its own stream, deliberately. Drawing from `state.rng` would move every other roll
 * in the seed the moment a pact existed — combat, map events, wave sizes — and the
 * promise this module inherits from pacts.js is that a game which never triggers it is
 * unchanged. Seeded from (seed, day, lord) so a reload re-rolls the same week.
 */
function weekSeed(state, lord) {
  let h = 2166136261 >>> 0;
  const s = `U|${state.seed}|${state.day}|${lord}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Who can be bought
// ---------------------------------------------------------------------------

/**
 * How buyable this vassal is, 0 (devoted) to 1 (already halfway out the door).
 *
 * Not a roll, and not loyalty alone. Loyalty says whether they WANT to leave; their own
 * army says whether leaving is worth anybody's money — a foreign power buying a
 * rebellion is buying a war, and a one-town realm with no line to put in the field is a
 * gesture. The two oath flavours pull the way they read: an oath sworn to settle a bill
 * (`underDebt`) is the least stable thing on the map, and a realm you handed its nation
 * back to (`liberated`) is the hardest to turn.
 */
export function seducibility(state, pact) {
  const vassal = state.players?.[pact.vassal];
  if (!vassal || vassal.defeated) return 0;
  const restless = 1 - clamp01((pact.loyalty ?? CONFIG.PACT_LOYALTY_START) / 100);
  const lordForce = Math.max(1, realmForce(state, pact.suzerain));
  const own = clamp01(realmForce(state, pact.vassal) / lordForce);
  let score = CONFIG.UPRISING_RESTLESS_SHARE * restless
    + (1 - CONFIG.UPRISING_RESTLESS_SHARE) * own;
  if (pact.underDebt) score += CONFIG.UPRISING_DEBT_BONUS;
  if (pact.liberated) score -= CONFIG.UPRISING_GRATITUDE_DAMP;
  return clamp01(score);
}

/**
 * The sworn realms of `lord` that could be turned this week, best prospect first.
 *
 * A fresh oath is off the table (UPRISING_MIN_PACT_DAYS): a realm that swore a fortnight
 * ago and rises today reads as the engine cheating, not as politics, and it would make
 * taking an oath in the first place a worse deal than finishing them. A realm with no
 * town has nothing to rise WITH.
 *
 * And never a HUMAN vassal. Breaking somebody's oath for them and starting their war is
 * a decision taken out of their hands while they are looking at a different screen —
 * the same rule that keeps patrons.js from spending a player's treasury on a proxy war.
 * The player's side of this is an OFFER (a foreign envoy with a chest on the table),
 * which is the same beat from the other side and is not built yet.
 */
export function uprisingCandidates(state, lord) {
  return vassalsOf(state, lord)
    .filter((pact) => {
      const vassal = state.players?.[pact.vassal];
      if (!vassal || vassal.defeated || vassal.isHuman) return false;
      if (state.day - (pact.signedDay ?? 0) < CONFIG.UPRISING_MIN_PACT_DAYS) return false;
      return playerTowns(state, pact.vassal).length > 0;
    })
    .map((pact) => ({ pact, score: seducibility(state, pact) }))
    // Best prospect first; ties to the lower index so a world always tempts the same
    // realm and a save replays.
    .sort((a, b) => (b.score - a.score) || (a.pact.vassal - b.pact.vassal));
}

/**
 * How much of the world flies this lord's banner, 0..1 — their own towns and every
 * sworn realm's, against every owned town on the map.
 *
 * This is the thing an outside power is actually paying to break. A lord with two
 * vassals on a crowded map is one power among several; a lord whose banner covers
 * two thirds of the towns has already won unless somebody spends money on it.
 */
export function hegemony(state, lord) {
  const owned = Object.values(state.towns || {}).filter((t) => t.owner >= 0);
  if (!owned.length) return 0;
  const banner = new Set([lord, ...vassalsOf(state, lord).map((p) => p.vassal)]);
  return clamp01(owned.filter((t) => banner.has(t.owner)).length / owned.length);
}

/**
 * The odds that somebody buys a rebellion against `lord` THIS WEEK, 0..1.
 *
 * Three multiplicands, and each is a lever the player can actually pull: how many
 * realms are sworn (more doors to knock on), how restless the most tempted of them is
 * (loyalty is the player's business, weekly), and how far the lord's banner already
 * covers the map (winning is what makes you worth conspiring against).
 *
 * Zero during the cooldown, so a coalition that has just survived one gets a season to
 * put itself back together rather than being ground down by a dice sequence.
 */
export function uprisingChance(state, lord) {
  if (!uprisingsOn(state)) return 0;
  const player = state.players?.[lord];
  if (!player || player.defeated) return 0;
  const candidates = uprisingCandidates(state, lord);
  if (!candidates.length) return 0;
  // Nobody buys a rebellion against a realm that has not won anything yet, and the
  // clause is what separates a war from an execution. MEASURED: without it, a rising
  // fired on day 36 against a lord whose whole realm fielded 90k, the chest floor
  // bought a 283k host, and the game was over two days later. The floor the request
  // named is enormous on purpose — so the target has to be enormous too.
  if (realmArmy(state, lord) < CONFIG.UPRISING_MIN_LORD_FORCE) return 0;
  const last = player.uprisingDay;
  if (Number.isFinite(last) && state.day - last < CONFIG.UPRISING_COOLDOWN_DAYS) return 0;
  const base = CONFIG.UPRISING_WEEKLY_CHANCE
    + CONFIG.UPRISING_CHANCE_PER_VASSAL * (candidates.length - 1);
  const restless = candidates[0].score;
  const reach = hegemony(state, lord);
  return Math.min(CONFIG.UPRISING_CHANCE_MAX,
    base * (1 + CONFIG.UPRISING_RESTLESS_WEIGHT * restless) * (1 + CONFIG.UPRISING_HEGEMON_WEIGHT * reach));
}

/**
 * How many rebellions this lord is worth buying at once.
 *
 * One more per UPRISING_REBEL_PER_CHEST chests' worth of realm to unseat, capped by the
 * odds table. A backer sizes the job: three chests against a realm one chest could take
 * is money burned, and one chest against a realm with eight armies in the field is a
 * gesture. It is also the safety valve on the floor — the 200-300k figure is enormous
 * for a young realm, so a young realm never faces more than one of it.
 */
export function maxRebelsFor(state, lord) {
  const per = Math.max(1, CONFIG.UPRISING_REBEL_PER_CHEST) * CONFIG.UPRISING_CHEST_MIN;
  const worth = Math.floor(realmArmy(state, lord) / per);
  return Math.max(1, Math.min(CONFIG.UPRISING_REBEL_ODDS.length, worth));
}

/**
 * Who is paying, in two tiers of evidence and one honest admission.
 *
 *   A PEOPLE FROM OUTSIDE THE WORLD, if one is ashore. It has no local balance to
 *   protect and every reason to see the strongest realm here bled before it has to meet
 *   that realm itself — the same argument that makes it the best patron in patrons.js.
 *   A rebellion in the lord's own house is simply the cheapest form of that.
 *
 *   A FRIGHTENED RIVAL otherwise: a sovereign realm not of the lord's banner, with a
 *   purse worth the name, that the lord's coalition overshadows.
 *
 *   And failing both, -1 — a power beyond the map. The mechanic must not require a rich
 *   third party to exist, because the world this is FOR is the one where the lord has
 *   already swallowed every rich third party. See the header on the minting.
 *
 * Deterministic: no rng, so a scan that finds nobody costs a game nothing.
 */
export function foreignBackerFor(state, lord) {
  const me = state.players?.[lord];
  if (!me) return -1;
  const banner = new Set([lord, ...vassalsOf(state, lord).map((p) => p.vassal)]);
  const lordForce = Math.max(1, realmArmy(state, lord));
  let best = -1, bestScore = 0;
  for (const p of state.players || []) {
    if (p.defeated || banner.has(p.index)) continue;
    if ((p.team ?? p.index) === (me.team ?? lord)) continue;
    if (isVassal(state, p.index)) continue;      // a sworn realm has no foreign policy
    const invader = isInvaderRealm(state, p.index);
    const fear = clamp01(lordForce / Math.max(1, realmArmy(state, p.index)));
    if (!invader && fear < CONFIG.PATRON_FEAR_MIN) continue;
    if (!invader && spendable(state, p.index) < CONFIG.PATRON_MIN_TREASURY) continue;
    const score = fear * (invader ? CONFIG.PATRON_INVADER_WEIGHT : 1);
    if (score > bestScore) { bestScore = score; best = p.index; }
  }
  return best;
}

/**
 * One rebel's war chest, in gold.
 *
 * The band the request named (200-300k) is the FLOOR of the thing, not the whole of it:
 * a flat figure is a war in month three and pocket change in month nine, and a mechanic
 * that stops mattering is worse than one that never fired. So the chest also tracks the
 * army the rebel has to beat — UPRISING_CHEST_PER_FORCE of the lord's whole realm
 * (every field army and every garrison, `realmArmy`), bounded by UPRISING_CHEST_CAP.
 *
 * The unit conversion is deliberately rough: `realmArmy` is aiValue and a chest is gold,
 * and those are not the same currency. It is a BUDGET HEURISTIC — "size the money to the
 * war" — bracketed at both ends by constants, which is the only property it needs.
 */
export function warChestFor(state, lord, rng = null) {
  const band = rng
    ? rng.int(CONFIG.UPRISING_CHEST_MIN, CONFIG.UPRISING_CHEST_MAX)
    : CONFIG.UPRISING_CHEST_MIN;
  const matched = Math.round(realmArmy(state, lord) * CONFIG.UPRISING_CHEST_PER_FORCE);
  return Math.min(CONFIG.UPRISING_CHEST_CAP, Math.max(band, matched));
}

/**
 * What a chest buys out of `faction`'s barracks: an ORDER OF BATTLE, not one stack.
 *
 * Several tiers, weighted to the top — because one enormous stack of the best thing is
 * answered by a single Blind or one well-placed shooter, and a rebellion that dies to
 * one spell is theatre. Regulars only (no upgraded forms), for the same reason patronage
 * ships regulars: it is money buying bodies, not a realm's own veterans, and the bigger
 * visible counts are what make the host read as bought.
 *
 * Returns [{ creature, count }], best tier first, or [] when the faction has no line.
 */
export function rebelHost(faction, budget, rng = null) {
  if (!(budget > 0)) return [];
  const byTier = new Map();
  for (const [id, c] of Object.entries(CREATURES)) {
    if (c.faction !== faction || c.upgraded || c.summonedOnly) continue;
    if (!(c.cost?.gold > 0)) continue;
    const held = byTier.get(c.tier);
    if (!held || (c.aiValue || 0) > (CREATURES[held].aiValue || 0)) byTier.set(c.tier, id);
  }
  const line = [...byTier.entries()]
    .sort((a, b) => b[0] - a[0])       // highest tier first
    .map(([, id]) => id);
  if (!line.length) return [];

  const weights = CONFIG.UPRISING_HOST_WEIGHTS;
  const take = Math.min(line.length, weights.length);
  const out = [];
  let spent = 0;
  for (let i = 0; i < take; i++) {
    // A little jitter per stack so two uprisings in one game do not field the same
    // army twice. Bounded, so the shape of the host is the weights, not the roll.
    const jitter = rng ? 1 + (rng.random() - 0.5) * CONFIG.UPRISING_HOST_JITTER : 1;
    const slice = budget * weights[i] * jitter;
    const each = CREATURES[line[i]].cost.gold;
    const count = Math.floor(slice / each);
    if (count <= 0) continue;
    out.push({ creature: line[i], count });
    spent += count * each;
  }
  // Whatever the rounding left over goes on more of the best thing they can field —
  // a chest is spent, not banked.
  const rest = budget - spent;
  if (out.length && rest > 0) {
    const top = out[0];
    const more = Math.floor(rest / CREATURES[top.creature].cost.gold);
    if (more > 0) top.count += more;
  }
  return out;
}

/** The nearest open land tile around (cx,cy) — where a rebel host musters. */
function openTileNear(state, cx, cy) {
  for (let r = 1; r <= 6; r++) {
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

/** The best stat sum any commander in the world carries — what a bought captain is
 *  measured against, so a rebellion is not led by a level-1 clerk. */
function worldStatTarget(state) {
  const STATS = ['attack', 'defense', 'power', 'knowledge'];
  let best = 0, bestLevel = 1;
  for (const hero of Object.values(state.heroes || {})) {
    const sum = STATS.reduce((n, k) => n + (hero.stats?.[k] || 0), 0);
    if (sum > best) { best = sum; bestLevel = hero.level || 1; }
  }
  return { statTarget: Math.round(best * CONFIG.UPRISING_STAT_SHARE), level: Math.max(1, Math.round(bestLevel * CONFIG.UPRISING_STAT_SHARE)) };
}

/**
 * Put a bought host in the field: a fresh commander outside the rebel's own capital,
 * carrying the whole order of battle.
 *
 * A new commander rather than a reinforcement of an existing one, because the host has
 * to be somewhere the player will MEET it — a garrison shipment is a surprise for
 * whoever storms the town, and this is meant to march. Falls back to reinforcing
 * whatever the realm already has (patrons.deliverContingent) when the map has no room.
 */
export function musterRebelHost(state, playerIndex, stacks) {
  const player = state.players?.[playerIndex];
  if (!player || !stacks.length) return null;
  const home = playerTowns(state, playerIndex)
    .slice()
    .sort((a, b) => (b.buildings?.length || 0) - (a.buildings?.length || 0))[0];
  const spot = home ? openTileNear(state, home.x, home.y) : null;
  if (!spot) {
    for (const s of stacks) deliverContingent(state, playerIndex, s.creature, s.count);
    return null;
  }
  const roster = heroesOfFaction(player.faction) || [];
  const pick = roster[0];
  const rosterId = typeof pick === 'string' ? pick : pick?.id;
  if (!rosterId) return null;
  const hero = createHero(state, rosterId, playerIndex, spot.x, spot.y);
  if (!hero) return null;

  const { statTarget, level } = worldStatTarget(state);
  const STATS = ['attack', 'defense', 'power', 'knowledge'];
  const baseSum = STATS.reduce((n, k) => n + (hero.stats[k] || 0), 0) || 1;
  if (statTarget > baseSum) {
    const scale = statTarget / baseSum;
    for (const stat of STATS) hero.stats[stat] = Math.max(1, Math.round((hero.stats[stat] || 1) * scale));
    hero.level = Math.max(hero.level || 1, level);
  }
  // Always the full seven slots: a short army cannot be reinforced by the slot walk
  // every daily/weekly reinforcement path uses (see patrons.placeStack).
  const army = [null, null, null, null, null, null, null];
  stacks.slice(0, CONFIG.ARMY_SLOTS).forEach((s, i) => { army[i] = { creature: s.creature, count: s.count, hurt: 0 }; });
  hero.army = army;
  hero.rebelCaptain = true;
  return hero;
}

// ---------------------------------------------------------------------------
// The rising
// ---------------------------------------------------------------------------

/**
 * Buy a rebellion against `lord`: one, two or three sworn realms throw the banner off
 * in the same hour, each with a chest and a host already in the field.
 *
 * Returns { ok, uprising, events } or { ok: false, reason }. `count` overrides the roll
 * (the tests use it; nothing in the game does).
 *
 * Announced LOUDLY, unlike a subsidy. A patron's money has to be inferred off the stacks
 * you meet, because that is intelligence work. This is a declaration of war by realms
 * that were on your side yesterday — there is nothing to infer, and the player needs the
 * week to answer it.
 */
export function fireUprising(state, lord, { rng = null, count = 0 } = {}) {
  const candidates = uprisingCandidates(state, lord);
  if (!candidates.length) return { ok: false, reason: 'nobody left to buy', events: [] };
  const roll = rng || new Rng(weekSeed(state, lord) ^ 0x9e3779b9);

  // How many rise together. Weighted, capped by who is actually available.
  let want = count;
  if (!want) {
    const odds = CONFIG.UPRISING_REBEL_ODDS;
    const r = roll.random();
    let acc = 0;
    want = odds.length;
    for (let i = 0; i < odds.length; i++) {
      acc += odds[i];
      if (r < acc) { want = i + 1; break; }
    }
  }
  // …and how many the backer will actually PAY for. Money follows the size of the job:
  // three chests against a small realm is money wasted, and one against a realm with
  // eight armies in the field is a gesture. An explicit `count` (tests, scripting) is
  // taken as given.
  if (!count) want = Math.min(want, maxRebelsFor(state, lord));
  const rising = candidates.slice(0, Math.max(1, Math.min(want, candidates.length)));

  const backer = foreignBackerFor(state, lord);
  const uprising = {
    id: `U${(state.nextUprisingId = (state.nextUprisingId || 0) + 1)}`,
    against: lord,
    backer,                    // -1: a power beyond the map
    day: state.day,
    rebels: [],
  };
  const events = [];

  for (const { pact, score } of rising) {
    const rebel = state.players[pact.vassal];
    const chest = warChestFor(state, lord, roll);
    // An on-map backer pays what its purse can stand; the remainder is drawn on a
    // power beyond the map. The local half is a REAL debit — a rival that funds your
    // rebellion is poorer for it, which is what keeps sponsoring one a decision.
    const local = backer >= 0 ? Math.min(chest, Math.round(spendable(state, backer) * CONFIG.UPRISING_BACKER_SHARE)) : 0;
    if (local > 0) {
      state.players[backer].resources.gold = Math.max(0, (state.players[backer].resources.gold || 0) - local);
    }

    breakPact(state, pact.id, 'uprising');
    rebel.resources.gold = (rebel.resources.gold || 0) + Math.round(chest * (1 - CONFIG.UPRISING_HOST_SHARE));
    rebel.roseAgainst = lord;
    rebel.roseDay = state.day;

    const stacks = rebelHost(rebel.faction, Math.round(chest * CONFIG.UPRISING_HOST_SHARE), roll);
    const hero = musterRebelHost(state, pact.vassal, stacks);
    const host = stacks.reduce((n, s) => n + (CREATURES[s.creature]?.aiValue || 0) * s.count, 0);

    uprising.rebels.push({
      player: pact.vassal, chest, local, host, heroId: hero?.id || null, seduced: Math.round(score * 100),
    });
    events.push({
      kind: 'uprising',
      player: pact.vassal,
      against: lord,
      text: `${rebel.name} throws off ${state.players[lord].name}'s banner — and marches with an army no `
        + 'tribute of theirs ever paid for.',
    });
  }

  if (!uprising.rebels.length) return { ok: false, reason: 'no oath could be broken', events: [] };
  (state.uprisings ||= []).push(uprising);
  state.players[lord].uprisingDay = state.day;

  const names = uprising.rebels.map((r) => state.players[r.player].name).join(', ');
  logMsg(state, uprising.rebels.length === 1
    ? `${names} rises against ${state.players[lord].name}. Somebody outside these lands has paid for it.`
    : `${names} rise together against ${state.players[lord].name}. Somebody outside these lands has paid for it.`);
  events.push({
    kind: 'uprisingCall',
    against: lord,
    text: uprising.rebels.length === 1
      ? 'The oath is broken. Foreign coin bought it.'
      : `${uprising.rebels.length} sworn realms broke their oaths in the same hour. Foreign coin bought them all.`,
  });
  return { ok: true, uprising, events };
}

/**
 * Is this rebel STILL IN ARMS — asked of the world, not of a flag.
 *
 * The distinction is the whole of a bug reported from play: "the green rebelled and I
 * beat his heroes, then he requested a peace and became a vassal again, but the game did
 * not notice and still showed a rebellion in the HUD — he is a vassal so no fight is
 * possible, but the HUD shows him still as an enemy."
 *
 * The engine was right and the READERS were a week behind it. `settled` is written by
 * the weekly tick, and a war can end on any day of the week — a rebel re-swears the hour
 * he is beaten, and until the next dawn every reader of the rising was describing a war
 * that was already over. So the readers ask the live question instead: a realm that is
 * sworn again, defeated, or already settled is not at war with anybody.
 */
function stillInArms(state, r) {
  const rebel = state.players?.[r.player];
  if (!rebel || rebel.defeated || r.settled) return false;
  return !isVassal(state, r.player);
}

/**
 * Close a rising whose last rebel has stopped fighting, and hand back whether it closed.
 * Shared by the weekly tick and by grantMercy, because peace made on a Tuesday has to
 * settle the books on the Tuesday.
 */
function closeIfOver(state, u) {
  if (u.rebels.some((r) => stillInArms(state, r))) return false;
  endUprising(state, u.id);
  return true;
}

/**
 * Mark a rebel as out of the fight, and close the rising if it was the last one.
 *
 * Exported because the two ways a war ends live in different modules: the weekly tick
 * finds the beaten ones, and `grantMercy` (a dialog, on any day) ends one by hand.
 */
export function settleRebel(state, playerIndex, how = 'sworn') {
  const u = uprisingOf(state, playerIndex);
  if (!u) return false;
  const r = u.rebels.find((x) => x.player === playerIndex);
  if (r && !r.settled) r.settled = how;
  closeIfOver(state, u);
  return true;
}

/**
 * The desirability bias a rebellion creates: rebels march on the lord they served, and
 * on nobody else in particular.
 *
 * Shaped exactly like patrons.warBias and balanceOfPowerBias so the three compose —
 * DESIRABILITY only, never the army-superiority gate, so a rebel covets its old lord's
 * castles but is never ordered into a hopeless attack. Returns null when this realm has
 * no rebellion of its own to prosecute, which is what keeps the AI's hot path free in a
 * world where nobody has risen.
 *
 * Both directions: the risen covet the lord's holdings, and the lord covets theirs. A
 * rebellion that the lord's own armies wander away from is not a war.
 */
export function uprisingBias(state, playerIndex) {
  const live = allUprisings(state);
  if (!live.length) return null;
  const covet = new Set();
  const teamOf = (i) => {
    const p = state.players?.[i];
    return p && !p.defeated ? (p.team ?? i) : null;
  };
  for (const u of live) {
    if (u.against === playerIndex) {
      for (const r of u.rebels) {
        if (!stillInArms(state, r)) continue;   // beaten, or sworn again this week
        const t = teamOf(r.player);
        if (t !== null) covet.add(t);
      }
    } else if (u.rebels.some((r) => r.player === playerIndex && stillInArms(state, r))) {
      const t = teamOf(u.against);
      if (t !== null) covet.add(t);
    }
  }
  // A rebel that took terms joins its lord's TEAM, so a bias built a moment earlier would
  // point the lord's armies at his own banner. Never covet your own colours — the check
  // is cheap and it is the last line of defence for every path into this.
  covet.delete(state.players?.[playerIndex]?.team ?? playerIndex);
  if (!covet.size) return null;
  return (owner) => {
    const team = state.players?.[owner]?.team ?? owner;
    return covet.has(team) ? CONFIG.UPRISING_WAR_BIAS : 1;
  };
}

// ---------------------------------------------------------------------------
// Mercy
// ---------------------------------------------------------------------------

/**
 * A beaten rebel's plea, waiting for an answer.
 *
 * Plain data on state, exactly like pacts.pactOffers, so it survives a save and the view
 * can raise it whenever the player next looks. One per petitioner.
 */
export const mercyPleas = (state) => state.mercyPleas || [];

/** The plea from `rebel`, or null. */
export function mercyPlea(state, rebel) {
  return mercyPleas(state).find((p) => p.from === rebel) || null;
}

/** Take a plea off the table (answered, or gone stale). */
export function clearMercyPlea(state, rebel) {
  if (!state.mercyPleas) return false;
  const at = state.mercyPleas.findIndex((p) => p.from === rebel);
  if (at < 0) return false;
  state.mercyPleas.splice(at, 1);
  if (!state.mercyPleas.length) delete state.mercyPleas;
  return true;
}

/**
 * The towns `lord` could hand a beggar, worst first.
 *
 * Worst first because the point is to seat a realm, not to gut your own — but the whole
 * list is returned and the CHOICE is the player's, which is the half of this the request
 * was explicit about ("at that time I can choose one that I wish to give to them").
 *
 * A lord on ONE town gets an empty list: canRestoreRealm refuses to hand over a last
 * town, and rightly, so offering it would be quoting a deal that cannot be taken.
 */
export function mercyTownChoices(state, lord) {
  const towns = playerTowns(state, lord);
  if (towns.length <= 1) return [];
  return towns
    .slice()
    .sort((a, b) => (a.buildings?.length || 0) - (b.buildings?.length || 0) || (a.id < b.id ? -1 : 1));
}

/**
 * Spare a beaten rebel: hand back one castle, take their oath again.
 *
 * `restoreRealm` already does the mechanics of seating a realm — un-defeat, hand the
 * town, muster a hero, sign the pact — and this is the same act with a different story
 * around it, so it calls through rather than reimplementing. What it adds is the memory:
 * the pact is marked `spared`, and it carries the `liberated` gratitude, because from the
 * rebel's side those are the same fact. You had them and you gave them a nation back.
 *
 * Returns restoreRealm's result. Refuses rather than half-applying.
 */
export function grantMercy(state, lord, rebel, townId, { terms } = {}) {
  const plea = mercyPlea(state, rebel);
  const check = canRestoreRealm(state, lord, rebel, townId);
  if (!check.ok) return { ok: false, reason: check.reason };
  const res = restoreRealm(state, lord, rebel, townId, { pact: true, terms: terms || defaultTerms() });
  if (!res.ok) return res;
  if (res.pact) {
    res.pact.spared = true;
    res.pact.roseBefore = (state.players[rebel].roseDay ?? null);
    res.pact.loyalty = Math.min(100, res.pact.loyalty + CONFIG.UPRISING_MERCY_LOYALTY);
  }
  if (plea) clearMercyPlea(state, rebel);
  // They rose, they lost, they were forgiven. The cooldown is the lord's, not theirs —
  // clearing the marks here is what lets the map carry on with the same realms on it.
  delete state.players[rebel].roseAgainst;
  // And the war is over THIS HOUR, not at the next week's dawn. Reported from play: an
  // oath re-sworn on a Tuesday left the HUD flying a rebellion until the following dawn.
  settleRebel(state, rebel, 'sworn');
  logMsg(state, `${state.players[rebel].name} begs, and is spared. They rule again in ${state.players[lord].name}'s name.`);
  return res;
}

/** Turn a beggar away. The plea is gone; the realm is not coming back. */
export function refuseMercy(state, rebel) {
  const plea = mercyPlea(state, rebel);
  if (!plea) return false;
  clearMercyPlea(state, rebel);
  const them = state.players?.[rebel];
  if (them) logMsg(state, `${them.name}'s envoys are sent away. There will be no second oath.`);
  return true;
}

/**
 * The weekly tick: settle the risings that are over, and let somebody buy a new one.
 *
 * Returns log-ready events; empty — and rng-free — in a world with no pacts and no live
 * uprising, which is what keeps a game that never touches this unchanged.
 */
export function tickUprisings(state) {
  if (!uprisingsOn(state)) return [];
  const events = [];

  // --- risings that have run their course ---------------------------------
  for (const u of [...allUprisings(state)]) {
    const lord = state.players?.[u.against];
    if (!lord || lord.defeated) { endUprising(state, u.id); continue; }
    let standing = 0;
    for (const r of u.rebels) {
      const rebel = state.players?.[r.player];
      if (!rebel) continue;
      // Re-sworn (they took terms again, by mercy or by negotiation): out of the rising.
      // The readers already knew this the hour it happened (see stillInArms); writing the
      // flag here is bookkeeping, not the news.
      if (isVassal(state, r.player)) { r.settled = 'sworn'; continue; }
      if (r.settled) continue;
      const towns = playerTowns(state, r.player).length;
      if (towns > 0 && !rebel.defeated) { standing++; continue; }
      // Beaten to nothing. THEY BEG — one castle, and their oath for it. Only ever put
      // to a human: an AI lord has no dialog to answer with, and mercy that resolves
      // itself is not mercy.
      r.settled = 'beaten';
      if (!lord.isHuman) continue;
      // Recorded even when the lord has no spare town to give TODAY: a plea is a
      // standing offer, and a lord down to his last castle who takes a second one next
      // week is a lord who can now answer it. The view holds the dialog back until
      // there is something to hand over (see AdventureScene.showMercyPlea).
      const pleas = (state.mercyPleas ||= []);
      const at = pleas.findIndex((p) => p.from === r.player);
      const plea = { from: r.player, to: u.against, day: state.day, uprisingId: u.id, chest: r.chest };
      if (at >= 0) pleas[at] = plea; else pleas.push(plea);
      events.push({
        kind: 'mercy',
        player: r.player,
        text: `${rebel.name} is broken and begs for terms — one castle, and their oath on it.`,
      });
    }
    if (!standing) {
      endUprising(state, u.id);
      events.push({
        kind: 'uprisingOver',
        against: u.against,
        text: `The rising against ${lord.name} is put down.`,
      });
    }
  }

  // --- and the next one ----------------------------------------------------
  // Every lord with sworn realms, human or not: this is a rule of the world, not a
  // punishment aimed at the player. Draws from its own stream (see weekSeed), so a
  // world where nobody holds a vassal costs nothing and moves no other roll.
  if (allPacts(state).length) {
    const lords = new Set(allPacts(state).map((p) => p.suzerain));
    for (const lord of [...lords].sort((a, b) => a - b)) {
      const chance = uprisingChance(state, lord);
      if (chance <= 0) continue;
      const rng = new Rng(weekSeed(state, lord));
      if (!rng.chance(chance)) continue;
      const res = fireUprising(state, lord, { rng });
      if (res.ok) events.push(...res.events);
    }
  }
  return events;
}

/** Close an uprising's books. */
export function endUprising(state, id) {
  const i = allUprisings(state).findIndex((u) => u.id === id);
  if (i < 0) return null;
  const [u] = state.uprisings.splice(i, 1);
  if (!state.uprisings.length) delete state.uprisings;
  return u;
}

/**
 * A readout for the view: what a live rising is, in one object per rebel.
 * Pure, so the HUD can ask per frame.
 */
export function uprisingReport(state, lord) {
  const out = [];
  for (const u of uprisingsAgainst(state, lord)) {
    for (const r of u.rebels) {
      const rebel = state.players?.[r.player];
      // The LIVE question, not the weekly flag: a realm that swore again an hour ago is
      // not in revolt, and the line that says otherwise is the one the player reads.
      if (!rebel || !stillInArms(state, r)) continue;
      out.push({
        player: r.player,
        name: rebel.name,
        chest: r.chest,
        towns: playerTowns(state, r.player).length,
        force: Math.round(Math.max(0, ...playerHeroes(state, r.player).map((h) => armyValue(h.army)), 0)),
        since: u.day,
      });
    }
  }
  return out;
}
