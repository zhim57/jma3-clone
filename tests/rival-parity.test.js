/**
 * rival-parity.test.js — the two halves of "a rival should be an opponent".
 *
 * THE DEFECT, AS MEASURED. The day-56 chronicle (docs/REVIEW-2026-08-halfgame.md)
 * opened with the player's carried commanders at levels 58/53/48 and stat sums
 * 144-151, against a rival whose best hero was level 11 with a stat sum of 15. The
 * endless carry hands the player veterans and handed rivals nothing but bigger
 * stacks, so the one player-vs-AI battle of that entire game was fought at 1.05:1 in
 * ARMY VALUE — the AI was actually ahead on realm army that morning — and ended
 * 100-3. The commander enters the damage model multiplicatively on every stack; the
 * army enters it once. Scaling only the army therefore scales the half that does not
 * decide the fight.
 *
 * The second half is the deployment gate. A heroless defender used to arrive as one
 * stack on one hex, which is two exploits in one shape: a single Blind disables the
 * whole guard, and overkill against it is free because the engine skips retaliation
 * when the target dies. Both are why a tide-scaled guard could be handed absurd body
 * counts and still cost nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { matchRivalProgression, matchRivalStats } from '../src/core/campaign.js';
import { scaleRival } from '../src/core/endless.js';
import { giveArtifact } from '../src/core/actions.js';
import { heroStat } from '../src/core/heroUtils.js';
import { createBattle } from '../src/core/combat/CombatEngine.js';
import { autoResolve } from '../src/core/combat/CombatAI.js';
import { armyValue } from '../src/core/heroUtils.js';
import { Rng } from '../src/core/rng.js';

const PRIMARIES = ['attack', 'defense', 'power', 'knowledge'];
const statSum = (h) => PRIMARIES.reduce((n, k) => n + (h?.stats?.[k] || 0), 0);

/** A game whose human seat carries the chronicle's actual retinue. */
function carried(levels = [[58, 151], [53, 144], [48, 143]]) {
  const s = newGame({
    seed: 5,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  playerHeroes(s, 0).forEach((h, i) => {
    const [lv, st] = levels[Math.min(i, levels.length - 1)];
    h.level = lv; h.xp = 0;
    const each = Math.floor(st / 4);
    h.stats = { attack: each, defense: each, power: each, knowledge: st - 3 * each };
  });
  return s;
}

// ── rival progression ───────────────────────────────────────────────────────

// A campaign chapter is the OTHER carry. `advanceCampaign` hands the veteran forward
// exactly as an endless realm does, into a map whose heroes scenarios never author —
// they set size, difficulty and seed, never a level. Before parity was applied here
// too, chapter 2 opened with the same 151-against-15 the chronicle recorded.
// CLONE: the campaign-chapter half of this guarantee is dropped with campaigns (the
// registry in data/campaigns.js is empty). The endless-run half above still runs, and
// it covers the same rule — a carry that levels the player must level the rivals too.


test('a rival is levelled to its peer rank for rank, not left at 1', () => {
  const s = carried();
  const before = playerHeroes(s, 1).map((h) => h.level || 1);
  matchRivalProgression(s, 1);
  const after = playerHeroes(s, 1).map((h) => h.level || 1);
  const mine = playerHeroes(s, 0).map((h) => h.level).sort((a, b) => b - a);
  assert.ok(before.every((lv) => lv <= 11), `fixture: rivals started low (${before})`);
  after.forEach((lv, i) => {
    assert.equal(lv, mine[Math.min(i, mine.length - 1)],
      `rival ${i} matched its peer's level (${after} vs ${mine})`);
  });
});

test('the stats come with the levels — and the gap the levels leave is closed', () => {
  // Most of a carried commander's stats never came from levelling: 63 of one
  // commander's 65 gained points came from map boosters and artifacts, which a rival
  // on a freshly generated map has had no chance to visit. Level-matching alone
  // lands a rival near a stat sum of 63 against a peer's 151.
  const s = carried();
  matchRivalProgression(s, 1);
  const mine = playerHeroes(s, 0).map(statSum).sort((a, b) => b - a);
  const theirs = playerHeroes(s, 1).map(statSum).sort((a, b) => b - a);
  theirs.forEach((st, i) => {
    const peer = mine[Math.min(i, mine.length - 1)];
    assert.ok(st >= peer * 0.95, `rival ${i} stat ${st} is a peer of ${peer}`);
  });
});

// gainXp only QUEUES a skill choice; a human resolves it at the level-up screen and
// the AI resolves it on its own turn. A rival levelled by parity is resolved right
// here, or it would meet the player on day one holding 57 unread choices and the two
// skills it was born with — parity in every number and still not an opponent.
test('the skills come too, and the queue is left empty', () => {
  const s = carried();
  const foe = playerHeroes(s, 1)[0];
  const born = Object.keys(foe.skills || {}).length;
  matchRivalProgression(s, 1);
  const after = Object.keys(foe.skills || {});
  assert.ok(after.length > born,
    `a level-58 commander learned skills (${born} -> ${after.length})`);
  assert.equal((foe.pendingSkillChoices || []).length, 0,
    'nothing left queued for a turn that may never come');
  const ranks = after.map((k) => foe.skills[k]);
  assert.ok(ranks.some((r) => r > 1), `and deepened some of them (${ranks})`);
});

test('a rival already at parity is left alone — this is a floor, not a rewrite', () => {
  const s = carried([[10, 40]]);
  playerHeroes(s, 1).forEach((h) => { h.level = 30; h.stats = { attack: 30, defense: 30, power: 30, knowledge: 30 }; });
  const before = playerHeroes(s, 1).map((h) => `${h.level}/${statSum(h)}`);
  matchRivalProgression(s, 1);
  assert.deepEqual(playerHeroes(s, 1).map((h) => `${h.level}/${statSum(h)}`), before,
    'a rival above its peer keeps everything it had');
});

// Parity measures EFFECTIVE stats, so scaleRival must run it AFTER handing the rival
// its artifacts. Matched first and equipped second would put the rival above its peer
// by exactly the artifacts — an ordering bug that no base-stat assertion can see.
test('an endless rival lands ON its peer, not above it — artifacts and all', () => {
  const K = ['attack', 'defense', 'power', 'knowledge'];
  const effective = (h) => K.reduce((n, k) => n + heroStat(h, k), 0);
  const s = carried([[58, 144]]);
  const me = playerHeroes(s, 0)[0];
  giveArtifact(s, me, 'necklaceOfBliss'); // the chronicle's commander carried relics too

  scaleRival(s, 1, 3); // realm 3: the rival is handed artifacts of its own
  const foe = playerHeroes(s, 1)[0];
  assert.ok(Object.keys(foe.equipment || {}).length > 0, 'fixture: the rival got artifacts');
  assert.equal(effective(foe), effective(me),
    'the rival equals its peer in what the player actually fights, not in base points');
  assert.ok(K.reduce((n, k) => n + (foe.stats[k] || 0), 0) < K.reduce((n, k) => n + (me.stats[k] || 0), 0),
    'and got there with LESS raw stat, because its relics carried the rest');
});

test('the dials can concede or press the opening', () => {
  const s = carried([[40, 100]]);
  matchRivalStats(s, 1, 0);
  const full = playerHeroes(s, 1).map(statSum);
  assert.ok(full.every((st) => st >= 95), `at 1.0 a rival is a peer (${full})`);
  assert.equal(CONFIG.RIVAL_LEVEL_MATCH, 1.0);
  assert.equal(CONFIG.RIVAL_STAT_MATCH, 1.0);
});

// ── what parity is actually worth ───────────────────────────────────────────

test('THE POINT: equal armies behind unequal commanders is not a battle', () => {
  const hero = (st) => ({
    owner: 0, level: 50, skills: {}, spells: [], mana: 0, army: [],
    stats: { attack: st / 4, defense: st / 4, power: st / 4, knowledge: st / 4 },
  });
  const ARMY = () => [{ creature: 'marksman', count: 150 }, { creature: 'griffin', count: 40 }];
  const duel = (atkStat, defStat, n = 15) => {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const a = hero(atkStat), d = hero(defStat);
      a.army = ARMY(); d.army = ARMY();
      const b = createBattle({
        rng: new Rng((i * 2654435761) >>> 0), terrain: 'grass', simulated: true,
        attacker: { hero: a, army: ARMY(), playerIndex: 0 },
        defender: { hero: d, army: ARMY(), playerIndex: 1 },
        humanSide: 0,
      });
      const r = autoResolve(b);
      cost += 1 - armyValue(r.attackerArmy || []) / armyValue(ARMY());
    }
    return cost / n;
  };
  const lopsided = duel(151, 15);   // the chronicle's day-2 battle
  const matched = duel(151, 151);   // the same battle after this change
  assert.ok(lopsided < 0.12, `a stat-15 defender costs almost nothing (${(lopsided * 100).toFixed(0)}%)`);
  assert.ok(matched > lopsided * 4,
    `a peer costs multiples more (${(matched * 100).toFixed(0)}% vs ${(lopsided * 100).toFixed(0)}%)`);
});

// ── the deployment gate ─────────────────────────────────────────────────────

function deployed(side, cfg = {}) {
  const b = createBattle({
    rng: new Rng(7), terrain: 'grass', simulated: true,
    attacker: {
      hero: { owner: 0, stats: { attack: 20, defense: 20, power: 20, knowledge: 20 }, spells: [], mana: 0, skills: {}, army: [] },
      army: [{ creature: 'marksman', count: 200 }], playerIndex: 0,
    },
    defender: { hero: null, army: [{ creature: 'pikeman', count: 900 }], playerIndex: -1 },
    ...cfg,
  });
  return b.units.filter((u) => u.side === side && u.alive);
}

test('a heroless PvE defender deploys across several hexes', () => {
  const def = deployed(1);
  assert.ok(def.length > 1,
    `one Blind no longer disables the whole guard (deployed as ${def.map((u) => u.count).join(' + ')})`);
  assert.equal(def.reduce((n, u) => n + u.count, 0), 900, 'and no bodies were invented or lost');
});

test("the player's own army is never rearranged", () => {
  assert.equal(deployed(0, { humanSide: 0 }).length, 1, 'the human side deploys exactly as packed');
});

// The other half of the same invariant. predictedArmyLoss builds its battle with no
// `humanSide` and no `aiStackSplit`, so the ATTACKER's deployment must come out the
// same there as it does in the real battle, where the player's side is named and
// exempt. Both come out whole — but for different reasons in each shape, which is
// exactly the kind of coincidence that quietly stops being true.
test("…and the attacker's side agrees between the two shapes as well", () => {
  const asSized = deployed(0);                                    // sizer: humanSide defaults to -1
  const asFought = deployed(0, { humanSide: 0 });                  // real: the player's own side
  const asFoughtWithSetting = deployed(0, { humanSide: 0, aiStackSplit: true });
  assert.equal(asSized.length, 1, "the hero's own army is quoted whole");
  assert.equal(asFought.length, asSized.length, 'and fought whole');
  assert.equal(asFoughtWithSetting.length, asSized.length,
    'the AI setting cannot reach across and rearrange the player either');
});

test('the split is a rule, not a live setting — so the sizer\'s simulation agrees with the battle', () => {
  // tideMultiplier prices a fight by simulating it through createBattle. If the
  // defender's deployment depended on a view-layer setting the engine cannot read,
  // the simulation would deploy one way and the real battle another, and the sizer
  // would be pricing a fight nobody fights. Both paths reach this from CONFIG.
  assert.equal(typeof CONFIG.PVE_STACK_SPLIT, 'boolean');
  const withoutSetting = deployed(1);                        // no aiStackSplit passed — the sim's shape
  const withSetting = deployed(1, { aiStackSplit: true });   // the live battle's shape
  assert.equal(withoutSetting.length, withSetting.length,
    'a heroless defender deploys identically whether or not the AI setting is present');
});
