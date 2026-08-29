/**
 * site-respawn-sizing.test.js — a reoccupied vault is a fight for the realm it
 * belongs to, not a wall for everyone but the leader.
 *
 * The reload was sized against the strongest army in the WORLD. The reasoning
 * was sound as far as it went — a site does not know who is coming, and pegging
 * it to the leader stops a runaway player farming reloads — but it solved the
 * farming problem by pricing every vault on the map out of everybody else's
 * reach. Measured over six AI games to day 56 on 72x60, a trailing realm faced
 * reloads at up to seven times its entire army, including vaults in its own
 * territory that it had cleared itself four weeks earlier. The anti-farming
 * property was doing considerably more than its job.
 *
 * The world had already met this failure and already answered it: the wandering
 * stacks found that "pegging every band to the strongest realm meant the
 * trailing realms could beat 0% of the map", and that widening the spread does
 * not reach them — only a different ANCHOR does, and the honest one is geography
 * (neutrals.bandAnchor). A reload is anchored the same way now, so the map speaks
 * with one voice: your own hinterland priced against you, a contested frontier
 * against whoever is across the line, open country against the leader. A realm
 * swept from the field has no scale to be priced against, so its ground reverts
 * to the world's — which is what stops a hegemon farming a broken neighbour.
 *
 * Anti-farming then lives where the farming is: each reload OF THAT TILE raises
 * its own guard, because farming is harvesting one renewable site over and over
 * rather than winning a hard fight once.
 *
 * What must not regress: the reload is still tide-sized (it is not a walkover),
 * still never scaled DOWN, and still costs the leader full price at home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes } from '../src/core/GameState.js';
import { endTurn } from '../src/core/actions.js';
import { AITurnController } from '../src/ai/AIPlayer.js';
import { revealAround } from '../src/map/fog.js';
import { CREATURES } from '../src/data/creatures.js';
import { bankDef } from '../src/data/creatureBanks.js';
import { CONFIG } from '../src/config.js';

const worth = (g) => (g || []).reduce((n, st) => n + (CREATURES[st.creature]?.aiValue || 0) * st.count, 0);
const skipDays = (s, days) => { for (let i = 0; i < days * s.players.length; i++) endTurn(s); };

function game() {
  return newGame({ seed: 31, players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
}
function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  m.objects[id] = { id, x, y, ...data };
  m.tiles[y * m.w + x].objectId = id;
  return m.objects[id];
}
/** Give every realm's heroes a single stack worth `value`-ish, per owner.
 *  Priced in pikemen (aiValue 80) so a small realm is still a real army rather
 *  than rounding away to none — "no army at all" is a different case entirely. */
function armies(s, valueByOwner) {
  for (const h of Object.values(s.heroes)) {
    const v = valueByOwner[h.owner] ?? 0;
    const count = Math.max(0, Math.round(v / CREATURES.pikeman.aiValue));
    h.army = [count > 0 ? { creature: 'pikeman', count, hurt: 0 } : null, null, null, null, null, null, null];
  }
  for (const t of Object.values(s.towns)) t.garrison = [null, null, null, null, null, null, null];
}
/** Move `owner`'s towns next to (x,y) and everyone else's far away. */
function ownGround(s, owner, x, y) {
  let far = 0;
  for (const t of Object.values(s.towns)) {
    if (t.owner === owner) { t.x = x + 2; t.y = y; t.z = 0; }
    else { t.x = Math.max(0, s.map.w - 2 - (far % 3)); t.y = Math.max(0, s.map.h - 2); t.z = 0; far++; }
  }
}
/** A looted bank at (x,y), reloaded by the real weekly pass. Returns its guard worth. */
function reload(s, bank) {
  bank.looted = true;
  bank.respawnAt = s.day;
  skipDays(s, CONFIG.DAYS_PER_WEEK + 1);
  assert.equal(bank.looted, false, 'the site did not reload — the harness is measuring nothing');
  return worth(bank.guards);
}
function bankAt(s, x, y, bankType = 'dwarvenTreasury') {
  return putObj(s, x, y, {
    type: 'creatureBank', bankType, looted: false,
    guards: bankDef(bankType).guards.map((g) => ({ ...g })),
  });
}

test('a vault in a trailing realm\'s land reloads at the trailing realm\'s scale', () => {
  const s = game();
  const LEADER = 4_000_000, TRAILER = 400_000; // a 10x runaway, the shape that used to lock players out
  armies(s, { 0: TRAILER, 1: LEADER });
  const bank = bankAt(s, 22, 20);
  ownGround(s, 0, 22, 20); // the site stands on the TRAILING realm's ground

  const guard = reload(s, bank);
  assert.ok(guard <= TRAILER * 1.15,
    `reloaded at ${guard} for a realm fielding ${TRAILER} — that is ${(guard / TRAILER).toFixed(1)}x its whole army`);
  // Old rule: 0.85 x 4,000,000 = 3,400,000, i.e. 8.5x. Pin the improvement.
  assert.ok(guard < LEADER * CONFIG.SITE_RESPAWN_TIDE * 0.5,
    'still pegged to the world leader');
});

test('…and still a real fight, not a walkover handed to that realm', () => {
  const s = game();
  const TRAILER = 400_000;
  armies(s, { 0: TRAILER, 1: 4_000_000 });
  const bank = bankAt(s, 22, 20);
  ownGround(s, 0, 22, 20);

  const guard = reload(s, bank);
  const authored = worth(bankDef(bank.bankType).guards);
  assert.ok(guard >= Math.min(TRAILER * 0.5, authored) ,
    `reloaded at ${guard} against a realm of ${TRAILER} — a reload must still be worth the trip`);
  assert.ok(guard >= authored, 'and never weaker than the site\'s own table');
});

test('the leader pays full price on its own ground', () => {
  const s = game();
  const LEADER = 4_000_000;
  armies(s, { 0: 400_000, 1: LEADER });
  const bank = bankAt(s, 22, 20);
  ownGround(s, 1, 22, 20); // the site stands on the LEADER's ground

  const guard = reload(s, bank);
  assert.ok(guard >= LEADER * CONFIG.SITE_RESPAWN_TIDE * 0.9,
    `the leader's own vault reloaded at ${guard} against its army of ${LEADER} — that is a farm`);
});

test('a realm with nothing left in the field does not leave free loot behind it', () => {
  // The trailing-realm concession is for realms that are still PLAYING. One with
  // no army at all has no scale to be priced against, so its ground reverts to
  // the world's — which is what stops a hegemon keeping a broken neighbour alive
  // as a larder. (bandAnchor's own rule; a vault reads the map like a war-band.)
  const s = game();
  const LEADER = 4_000_000;
  armies(s, { 0: 0, 1: LEADER }); // realm 0 has been swept from the field
  const bank = bankAt(s, 22, 20);
  ownGround(s, 0, 22, 20);

  const guard = reload(s, bank);
  assert.ok(guard >= LEADER * CONFIG.SITE_RESPAWN_TIDE * 0.9,
    `reloaded at ${guard} beside a leader fielding ${LEADER} — an empty realm's land is a larder`);
});

test('reloading the SAME tile again and again gets steadily more expensive', () => {
  // This is the actual anti-farming clause: farming means harvesting one
  // renewable site over and over, not beating a hard fight once.
  const s = game();
  const ARMY = 2_000_000;
  armies(s, { 0: ARMY, 1: ARMY });
  const bank = bankAt(s, 22, 20);
  ownGround(s, 0, 22, 20);

  const guards = [];
  for (let i = 0; i < 4; i++) guards.push(reload(s, bank));
  for (let i = 1; i < guards.length; i++) {
    assert.ok(guards[i] > guards[i - 1],
      `reload ${i + 1} (${guards[i]}) was no dearer than reload ${i} (${guards[i - 1]})`);
  }
  assert.ok(guards[0] <= ARMY * 1.05, 'the FIRST reload is the plain price, not already escalated');
  assert.equal(bank.reloads, 4, 'the tile counts its own reloads');
});

test('the escalation is capped — a long game cannot drive one tile to absurdity', () => {
  const s = game();
  const ARMY = 1_000_000;
  armies(s, { 0: ARMY, 1: ARMY });
  const bank = bankAt(s, 22, 20);
  ownGround(s, 0, 22, 20);

  let last = 0;
  for (let i = 0; i < CONFIG.SITE_RESPAWN_RELOAD_CAP + 4; i++) last = reload(s, bank);
  const ceiling = ARMY * CONFIG.SITE_RESPAWN_TIDE
    * (1 + CONFIG.SITE_RESPAWN_RELOAD_STEP * CONFIG.SITE_RESPAWN_RELOAD_CAP);
  assert.ok(last <= ceiling * 1.05,
    `after ${CONFIG.SITE_RESPAWN_RELOAD_CAP + 4} reloads the guard was ${last}, past the ${Math.round(ceiling)} ceiling`);
});

test('the reload counter rides the save, so a reload of a reload is not forgotten', () => {
  const s = game();
  armies(s, { 0: 1_000_000, 1: 1_000_000 });
  const bank = bankAt(s, 22, 20);
  ownGround(s, 0, 22, 20);
  reload(s, bank);
  const raw = JSON.parse(JSON.stringify({ reloads: bank.reloads }));
  assert.equal(raw.reloads, 1, 'the count is plain data — it round-trips a save with no migration');
});

test('a site whose own table outweighs all of this keeps its teeth', () => {
  // Scaling stays one-way. An Archangel Spire reoccupied while every realm is
  // still small must not be shrunk to match.
  const s = game();
  armies(s, { 0: 500, 1: 500 });
  const lair = bankAt(s, 22, 20, 'archangelSpire');
  ownGround(s, 0, 22, 20);
  const guard = reload(s, lair);
  assert.ok(guard >= worth(bankDef(lair.bankType).guards), 'a lair was levelled down to a peasant world');
});

test('an AI realm will actually GO for a reload in its own country', () => {
  // The sizing only matters through the gate it has to pass. The AI's courage
  // margin refuses any fight it is not clearly winning (tideScaleDefender's own
  // comment says it outright: "a defender pinned at a fraction of YOUR army can
  // never satisfy a superiority margin, so the AI would simply stop clearing the
  // map at all"), so a leader-pegged reload did not merely feel unfair to a
  // trailing realm — its own AI never once considered the tile.
  //
  // Measured here as the growth a realm needs before the gate opens on a vault
  // in its own land. Old rule: a trailing realm that grew all the way to the
  // LEADER's strength still would not go. New rule: about a quarter's growth,
  // which is roughly what four weeks buys — the site is a goal to grow into.
  const s = newGame({ seed: 31, mapW: 56, mapH: 46, players: [
    { faction: 'castle', isHuman: false, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ] });
  const TRAILER = 400_000, LEADER = 4_000_000;
  armies(s, { 0: TRAILER, 1: LEADER });

  const hero = playerHeroes(s, 0)[0];
  const bx = Math.min(s.map.w - 3, hero.x + 3), by = hero.y;
  const bank = bankAt(s, bx, by);
  for (const t of Object.values(s.towns)) if (t.owner === 0) { t.x = bx + 2; t.y = by; t.z = 0; }
  const ownGuard = reload(s, bank);
  for (let y = 0; y < s.map.h; y++) revealAround(s, 0, Math.floor(s.map.w / 2), y, s.map.w, 0);

  /** Would the AI put this tile on its list, with `army` in the field? */
  const considers = (guardValue, army) => {
    armies(s, { 0: army, 1: LEADER });
    const g = bankDef('dwarvenTreasury').guards.map((q) => ({ ...q }));
    const have = worth(g);
    for (const st of g) st.count = Math.max(1, Math.round(st.count * (guardValue / have)));
    bank.guards = g;
    bank.looted = false;
    const ai = new AITurnController(s, 0);
    ai.mainHeroId = hero.id;
    ai.pickGoal(hero, ai.floodCached(hero.x, hero.y, 0, false));
    return (ai._lastGoals || []).some((c) => c.x === bank.x && c.y === bank.y);
  };

  const leaderPegged = Math.round(LEADER * CONFIG.SITE_RESPAWN_TIDE); // what the old rule produced
  assert.ok(!considers(leaderPegged, LEADER),
    'the old leader-pegged guard was refused even by a realm that had caught the leader');
  assert.ok(considers(ownGuard, TRAILER * 1.5),
    `a realm that grew half again over the ${TRAILER} it fielded at reload still will not go for `
    + `a ${ownGuard} guard in its own country`);
});

test('turned off, the rule still writes nothing at all', () => {
  const s = newGame({ seed: 31, features: { siteRespawn: false } });
  const bank = bankAt(s, 22, 20);
  bank.looted = true;
  skipDays(s, CONFIG.DAYS_PER_WEEK * (CONFIG.SITE_RESPAWN_WEEKS + 2));
  assert.equal(bank.looted, true);
  assert.equal(bank.reloads, undefined, 'no reload counter on a game without the feature');
  assert.ok(playerHeroes(s, 0).length > 0);
});
