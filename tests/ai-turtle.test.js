/**
 * ai-turtle.test.js — Pins the AI's turtle-and-build-up defense.
 *
 * The reported griefing setup: a human parks a hero with a HUGE army on a
 * mine next to the AI's castle. The old AI hired a fresh hero every turn,
 * handed it the week's cheap recruits and marched it into the human hero,
 * where it died — chip-suicide, feeding the enemy one week of recruits at a
 * time. The fixed AI instead:
 *   - prices enemy heroes standing ON or BESIDE a prize as guards
 *     (guardValueNear), so the mine is courage-gated like a monster guard;
 *   - never chases loot inside the strike range of a superior enemy army;
 *   - consolidates INTO the menaced town, holds (turtles) while every week's
 *     recruits pool onto the defender, and suppresses hiring there;
 *   - remembers the PEAK threat on town.aiThreat (plain serializable data
 *     that decays over days), so a briefly-retreating besieger doesn't bait
 *     a premature sally;
 *   - and sallies with the consolidated army once the town's defense beats
 *     the remembered threat by the courage margin.
 *
 * All tests are headless and deterministic (fixed seed, state.rng only).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newGame, playerHeroes, playerTowns, serialize, deserialize,
} from '../src/core/GameState.js';
import { endTurn } from '../src/core/actions.js';
import { armyValue } from '../src/core/heroUtils.js';
import { armyPower } from '../src/core/power.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const SEED = 4242;
const HUMAN = 0;
const AI = 1;

/**
 * Drive one full AI turn. Battles against the human are auto-resolved, but
 * recorded — the turtle tests assert the AI never initiates one it loses.
 */
function runTurn(state, playerIndex = AI) {
  // This suite pins the AI's NEUTRAL turtle/threat contract — the safety gate
  // that keeps it from chip-suiciding. That gate is warlord-independent (an
  // aggression knob raises target desirability, never lowers the superiority
  // margin), so we run under the neutral Tactician to isolate the invariant
  // from the personality layer; the temperaments themselves live in
  // ai-warlord.test.js.
  state.players[playerIndex].warlord = 'tactician';
  const ai = new AITurnController(state, playerIndex);
  const combats = [];
  let guard = 200;
  let r;
  do {
    r = ai.next();
    if (r.type === 'combat') {
      combats.push({
        attacker: armyValue(state.heroes[r.context.attackerHeroId].army),
        defender: armyValue(r.context.defenderArmy || []),
      });
      ai.autoFight(r.context);
    }
  } while (r.type !== 'done' && guard-- > 0);
  assert.equal(r.type, 'done', 'AI turn terminates');
  return { ai, combats };
}

/** Make (x, y) an empty walkable surface tile (never clears a town). */
function clearTile(state, x, y) {
  const t = state.map.tiles[y * state.map.w + x];
  if (t.objectId) {
    assert.notEqual(state.map.objects[t.objectId]?.type, 'town', 'test must not clear a town');
    delete state.map.objects[t.objectId];
    t.objectId = null;
  }
  t.obstacle = null;
  t.terrain = 'grass';
}

/** Mint a neutral gold mine on an (already cleared) tile. */
function placeMine(state, x, y) {
  const t = state.map.tiles[y * state.map.w + x];
  assert.equal(t.objectId, null, 'mine tile must be clear');
  const id = `O${state.map.nextOid++}`;
  state.map.objects[id] = { id, x, y, type: 'mine', mineType: 'goldMine', owner: -1 };
  t.objectId = id;
  return state.map.objects[id];
}

/** Toward-map-center direction from the AI town, so offsets stay in bounds. */
function inwardDir(state, town) {
  return town.x < state.map.w / 2 ? 1 : -1;
}

const stack = (creature, count) => [{ creature, count, hurt: 0 }, null, null, null, null, null, null];

// ---------------------------------------------------------------------------

test('reported case: superior hero parked on a mine by the AI town → turtle and build up, never chip-suicide', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  const dir = inwardDir(s, town);
  // A gold mine three tiles from the AI town, with the human's hero parked ON
  // it carrying an overwhelming army — the reported griefing setup.
  clearTile(s, town.x + 3 * dir, town.y);
  const mine = placeMine(s, town.x + 3 * dir, town.y);
  const enemy = playerHeroes(s, HUMAN)[0];
  enemy.x = mine.x;
  enemy.y = mine.y;
  enemy.z = 0;
  enemy.army = stack('archangel', 200); // vastly superior, permanently

  const aiHeroId = playerHeroes(s, AI)[0].id;
  const valueByDay = {};
  while (s.day <= 15) {
    assert.equal(s.currentPlayer, HUMAN);
    endTurn(s); // the human just sits on the mine
    const { combats } = runTurn(s);
    assert.equal(combats.length, 0, `day ${s.day}: the AI initiated no battle against the human`);
    for (const h of playerHeroes(s, AI)) {
      assert.ok(!(h.x === enemy.x && h.y === enemy.y && (h.z ?? 0) === 0),
        'no AI hero ever steps onto the player');
    }
    const defender = town.visitingHeroId ? s.heroes[town.visitingHeroId] : null;
    if (s.day >= 2) {
      assert.ok(defender, `day ${s.day}: a defender garrisons the menaced town`);
      assert.equal(defender.inTownId, town.id, 'the defender holds inside the walls');
    }
    if (defender) valueByDay[s.day] = armyValue(defender.army);
    endTurn(s);
  }

  assert.ok(s.heroes[enemy.id], 'the player hero was never attacked');
  assert.equal(mine.owner, -1, 'the guarded mine was never grabbed');
  assert.equal(town.owner, AI, 'the town still stands');
  // E: no chip-hiring into the lost cause — the single starting hero remains
  // the only one (the old AI would have hired up to the cap and fed each).
  const mine2 = playerHeroes(s, AI);
  assert.equal(mine2.length, 1, 'no fresh heroes were hired while turtling');
  assert.equal(mine2[0].id, aiHeroId, 'and it is the original hero, alive');
  // C: the build-up is real — recruits pool onto the defender week over week.
  assert.ok(valueByDay[8] > valueByDay[1],
    `defender grew across week 1→2 (${valueByDay[1]} → ${valueByDay[8]})`);
  assert.ok(valueByDay[15] > valueByDay[8],
    `defender grew across week 2→3 (${valueByDay[8]} → ${valueByDay[15]})`);
  // D: the peak threat is remembered on the town, in serializable form.
  assert.ok(town.aiThreat && town.aiThreat.value >= armyValue(enemy.army),
    'the peak threat is remembered on the town');
});

test('build-up completes → the hold releases and the AI sallies at the now-beatable menace', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  const dir = inwardDir(s, town);
  clearTile(s, town.x + 3 * dir, town.y);
  const mine = placeMine(s, town.x + 3 * dir, town.y);
  const enemy = playerHeroes(s, HUMAN)[0];
  enemy.x = mine.x;
  enemy.y = mine.y;
  enemy.z = 0;
  enemy.army = stack('griffin', 30); // superior to the starting hero, beatable later
  const threat = armyValue(enemy.army);

  let defenderId = null;
  const sallies = [];
  for (let day = 1; day <= 6 && s.heroes[enemy.id]; day++) {
    assert.equal(s.day, day);
    if (day === 4) {
      // The week's build-up, compressed for the test: a strong garrison for
      // the defender to absorb (manageTowns pools it onto the visiting hero).
      town.garrison[0] = { creature: 'archangel', count: 5, hurt: 0 };
    }
    endTurn(s); // human sits
    const { combats } = runTurn(s);
    sallies.push(...combats.map((c) => ({ ...c, day })));
    if (day <= 3) {
      assert.equal(combats.length, 0, `day ${day}: still building — no battle`);
      defenderId = town.visitingHeroId;
      assert.ok(defenderId, `day ${day}: a defender turtles in the town`);
      assert.equal(s.heroes[defenderId].inTownId, town.id, 'held inside while too weak');
    }
    endTurn(s);
  }

  assert.ok(sallies.length > 0, 'the consolidated army sallied out');
  assert.ok(sallies[0].day >= 4, 'and only after the build-up crossed the courage bar');
  for (const c of sallies) {
    assert.ok(c.attacker >= c.defender, 'the AI only ever attacked from superiority');
  }
  assert.ok(sallies.some((c) => c.defender === threat), 'the sally engaged the remembered menace');
  assert.ok(!s.heroes[enemy.id], 'the menace was destroyed');
});

test('hero-as-guard: an enemy hero beside a mine gates a weak hero off it, but not a strong one', () => {
  const s = newGame({ seed: SEED });
  // A quiet pocket far from every town, so no turtle logic interferes.
  const towns = Object.values(s.towns).filter((t) => (t.z ?? 0) === 0);
  let spot = null;
  for (let y = 4; y < s.map.h - 4 && !spot; y++) {
    for (let x = 4; x < s.map.w - 4 && !spot; x++) {
      if (towns.every((t) => Math.hypot(t.x - x, t.y - y) > 14)) spot = { x, y };
    }
  }
  assert.ok(spot, 'found a spot far from all towns');
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -4; dx <= 4; dx++) clearTile(s, spot.x + dx, spot.y + dy);
  }
  const mine = placeMine(s, spot.x, spot.y);
  const enemy = playerHeroes(s, HUMAN)[0];
  enemy.x = spot.x + 1; // ADJACENT to the mine, not on it
  enemy.y = spot.y;
  enemy.z = 0;
  enemy.army = stack('griffin', 30);
  const hero = playerHeroes(s, AI)[0];
  hero.x = spot.x - 3;
  hero.y = spot.y;
  hero.z = 0;

  // The adjacent enemy hero is priced as a guard, exactly like a monster.
  const probe = new AITurnController(s, AI);
  // POWER, not price. guardValueNear is asking "how hard is this to get past",
  // which src/core/power.js separated from "what is it worth".
  assert.equal(probe.guardValueNear(mine, 0), armyPower(enemy.army),
    'guardValueNear folds the adjacent enemy hero into the guard value');

  // Weak: the mine is bait — never taken, the enemy never attacked.
  for (let day = 1; day <= 2; day++) {
    endTurn(s); // human
    const { combats } = runTurn(s);
    assert.equal(combats.length, 0, 'the weak hero picked no fight with the human');
    endTurn(s);
  }
  assert.equal(mine.owner, -1, 'the guarded mine was not grabbed by the weak hero');
  assert.ok(s.heroes[enemy.id], 'the human hero was left alone');

  // Strong: the same prize now clears its courage gate — the AI takes it
  // (destroying the squatter on the way, from overwhelming superiority).
  // Re-stage the hero beside the mine: the weak phase left it collecting
  // safe prizes elsewhere on the map.
  if (hero.inTownId) {
    s.towns[hero.inTownId].visitingHeroId = null;
    hero.inTownId = null;
  }
  hero.x = spot.x - 3;
  hero.y = spot.y;
  hero.z = 0;
  hero.army = stack('archangel', 300);
  let took = false;
  for (let day = 0; day < 3 && !took; day++) {
    endTurn(s); // human
    runTurn(s);
    took = mine.owner === AI;
    endTurn(s);
  }
  assert.ok(!s.heroes[enemy.id], 'the strong army removed the squatting hero');
  assert.equal(mine.owner, AI, 'and flagged the mine');
});

test('threat memory: the peak persists past a brief retreat, round-trips save/load, then decays away', () => {
  let s = newGame({ seed: SEED });
  let town = playerTowns(s, AI)[0];
  const dir = inwardDir(s, town);
  clearTile(s, town.x + 3 * dir, town.y);
  clearTile(s, town.x + 10 * dir, town.y);
  let enemy = playerHeroes(s, HUMAN)[0];
  const enemyId = enemy.id;
  const home = { x: enemy.x, y: enemy.y };
  enemy.x = town.x + 3 * dir; // inside THREAT_RADIUS (8) of the AI town
  enemy.y = town.y;
  enemy.z = 0;
  enemy.army = stack('griffin', 40);
  const peak = armyPower(enemy.army);   // a threat is measured in power, not price

  // Day 1: the menace is seen and the peak recorded.
  endTurn(s);
  runTurn(s);
  assert.deepEqual(town.aiThreat,
    { value: peak, x: enemy.x, y: enemy.y, z: 0, day: 1 },
    'the peak threat is recorded on the town');
  const defenderId = town.visitingHeroId;
  assert.ok(defenderId, 'a defender consolidated into the town');
  endTurn(s);

  // Day 2: the menace WEAKENS in place — the remembered peak is kept.
  enemy.army[0].count = 20;
  endTurn(s);
  runTurn(s);
  assert.equal(town.aiThreat.value, peak, 'a weakened live menace does not erase the peak');
  assert.equal(town.aiThreat.day, 1, 'nor refresh its timestamp');
  endTurn(s);

  // Days 3-4: the menace steps JUST outside the radius. The memory persists
  // (decaying), and the defender keeps building instead of sallying.
  enemy.x = town.x + 10 * dir;
  const remembered = [];
  for (let i = 0; i < 2; i++) {
    remembered.push(new AITurnController(s, AI).rememberedThreat(town));
    endTurn(s);
    runTurn(s);
    assert.ok(town.aiThreat, 'the memory persists while the enemy hovers out of range');
    assert.equal(s.heroes[defenderId].inTownId, town.id, 'the defender keeps holding');
    endTurn(s);
  }
  assert.ok(remembered[0] > remembered[1] && remembered[1] > 0,
    `the remembered threat decays day over day (${remembered.join(' > ')})`);

  // The memory survives save/load byte for byte.
  const snapshot = { ...town.aiThreat };
  s = deserialize(serialize(s));
  town = s.towns[town.id];
  enemy = s.heroes[enemyId];
  assert.deepEqual(town.aiThreat, snapshot, 'town.aiThreat round-trips serialization');

  // The menace leaves for good: the memory decays to nothing (7 days after
  // day 1) and the town returns to normal play — the defender marches out.
  enemy.x = home.x;
  enemy.y = home.y;
  while (s.day <= 8) {
    endTurn(s);
    runTurn(s);
    endTurn(s);
  }
  assert.equal(town.aiThreat, undefined, 'the fully-decayed memory is dropped');
  let left = false;
  for (let i = 0; i < 3 && !left; i++) {
    endTurn(s);
    runTurn(s);
    left = s.heroes[defenderId].inTownId !== town.id;
    endTurn(s);
  }
  assert.ok(left, 'with the threat forgotten, the defender goes back to work');
});

test('chip-hire suppression: a heroless besieged town pools recruits until a hire can actually win', () => {
  const s = newGame({ seed: SEED });
  const town = playerTowns(s, AI)[0];
  const dir = inwardDir(s, town);
  // The defender has fallen: no AI heroes at all, gold aplenty for hires.
  const fallen = playerHeroes(s, AI)[0];
  delete s.heroes[fallen.id];
  s.players[AI].resources.gold = 20000;
  clearTile(s, town.x + 3 * dir, town.y);
  const enemy = playerHeroes(s, HUMAN)[0];
  enemy.x = town.x + 3 * dir;
  enemy.y = town.y;
  enemy.z = 0;
  enemy.army = stack('griffin', 30);

  // Two days under siege: the old AI would hire (and feed) a hero each day;
  // the new one pools every recruit into the garrison instead.
  for (let day = 1; day <= 2; day++) {
    endTurn(s);
    const { combats } = runTurn(s);
    assert.equal(combats.length, 0, 'nothing was fed to the besieger');
    assert.equal(playerHeroes(s, AI).length, 0, `day ${day}: no hopeless hire`);
    endTurn(s);
  }
  assert.ok(armyValue(town.garrison) > 0, 'the recruits pooled into the garrison');

  // Once the garrison could actually win, hiring resumes: the new hero
  // absorbs the pooled army and leads it out.
  town.garrison[1] = { creature: 'archangel', count: 5, hurt: 0 };
  endTurn(s);
  const { combats } = runTurn(s);
  assert.equal(playerHeroes(s, AI).length, 1, 'the sally hero was hired');
  for (const c of combats) {
    assert.ok(c.attacker >= c.defender, 'and it only attacks from superiority');
  }
  endTurn(s);
});

test('non-regression: with no superior threat the AI expands as before, bit-identically across runs', () => {
  const play = () => {
    const s = newGame({ seed: SEED });
    let guard = 400;
    // The PEAK count, not the count on the final morning. How many heroes are
    // alive at day 8 is seed noise — sampled across ten seeds it lands anywhere
    // from 1 to 4, on this catalog and on the one before it, because a hero can
    // walk into a wandering stack on the last day. "Heroes are still fielded" is
    // a claim about the week, so measure it across the week.
    s.peakHeroes = 0;
    while (s.winner === null && s.day <= 8 && guard-- > 0) {
      const ai = new AITurnController(s, s.currentPlayer);
      let r, g2 = 100;
      do {
        r = ai.next();
        if (r.type === 'combat') ai.autoFight(r.context);
      } while (r.type !== 'done' && g2-- > 0);
      assert.equal(r.type, 'done', 'every AI turn terminates');
      s.peakHeroes = Math.max(s.peakHeroes, Object.keys(s.heroes).length);
      endTurn(s);
    }
    assert.ok(guard > 0, 'no loop across a week of play');
    return s;
  };
  // Entity ids are minted from a process-global counter, so they differ
  // between two games in one process — digest world CONTENT, not ids.
  const digest = (s) => JSON.stringify({
    day: s.day,
    heroes: Object.values(s.heroes).map(
      (h) => [h.owner, h.x, h.y, h.z ?? 0, armyValue(h.army)],
    ),
    towns: Object.values(s.towns).map(
      (t) => [t.owner, t.buildings.slice().sort().join(','), armyValue(t.garrison)],
    ),
    mines: Object.values(s.map.objects).filter((o) => o.type === 'mine').map((o) => [o.id, o.owner]),
    gold: s.players.map((p) => p.resources.gold),
  });

  const a = play();
  const b = play();
  assert.equal(digest(a), digest(b), 'two identical runs produce identical worlds');
  // The AI still plays an expanding game: mines get flagged and heroes march.
  const flagged = Object.values(a.map.objects).filter((o) => o.type === 'mine' && o.owner >= 0);
  assert.ok(flagged.length > 0, 'mines were captured during the week');
  assert.ok(a.peakHeroes >= 2, 'heroes are still fielded');
});
