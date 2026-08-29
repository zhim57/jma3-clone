/**
 * ai-claim-board.test.js — one realm, one brain, and no two heroes on one prize.
 *
 * There is a single AITurnController per realm per turn, and it orders its heroes
 * strictly one at a time (see next()): the queue is sorted strongest-army-first and
 * each hero runs to completion before the next starts. So a later hero can always see
 * what an earlier one committed to — `hero.aiGoal.key` is already written. The
 * information was there all along; the scoring simply never asked.
 *
 * Measured over 325 realm-turns of ordinary AI-vs-AI play before this existed:
 *   33.5% of realm-turns had two heroes committed to the SAME target
 *   11.7% of all hero-turns were redundant commitments
 * and the duplication was almost entirely ECONOMIC, not military — boosters 55,
 * garrison pickups 37, portals 20, dwellings 14, mines 13, against 3 for 'defend
 * town'. A booster is a one-shot shrine: the second hero to reach it gets nothing.
 *
 * A damp (CLAIM_DAMP), not an exclusion, because two heroes on one target is
 * sometimes right — a town neither can take alone still wants both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { newGame, playerHeroes, playerTowns, createHero } from '../src/core/GameState.js';
import { HERO_ROSTER } from '../src/data/heroes.js';
import { AITurnController } from '../src/ai/AIPlayer.js';

const AI = 1;

/** Strip every map object so a test board contains only what the test puts there. */
function clearBoard(state) {
  const m = state.map;
  for (const o of Object.values(m.objects)) {
    if (o.type === 'town') continue;
    const t = m.tiles[o.y * m.w + o.x];
    if (t && t.objectId === o.id) t.objectId = null;
    delete m.objects[o.id];
  }
}

/** A free, walkable tile at (x,y), or null. */
function freeTile(state, x, y) {
  const m = state.map;
  if (x < 1 || y < 1 || x >= m.w - 1 || y >= m.h - 1) return null;
  const t = m.tiles[y * m.w + x];
  if (!t || t.objectId || t.obstacle || t.terrain === 'water') return null;
  return t;
}

function putArtifact(state, x, y) {
  const m = state.map;
  const t = freeTile(state, x, y);
  if (!t) return null;
  const id = `A${m.nextOid++}`;
  m.objects[id] = { id, x, y, type: 'artifact', artifact: 'bootsOfSpeed' };
  t.objectId = id;
  return m.objects[id];
}

function runTurn(state) {
  const ai = new AITurnController(state, AI);
  let guard = 400, r;
  do { r = ai.next(); if (r.type === 'combat') ai.autoFight(r.context); } while (r.type !== 'done' && guard-- > 0);
  return ai;
}

test('two heroes do not both ride for the same prize', () => {
  // Two identical artifacts, equidistant from two identically-armed heroes. Without a
  // claim board the two heroes score them identically and both take the same one; the
  // board makes the second one worth CLAIM_DAMP of its price to whoever chooses second.
  const s = newGame({
    seed: 4311, mapW: 72, mapH: 60,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  clearBoard(s);
  const home = playerTowns(s, AI)[0];
  const heroes = playerHeroes(s, AI);
  while (heroes.length < 2) {
    const h = createHero(s, Object.keys(HERO_ROSTER)[heroes.length], AI, home.x, home.y + 1);
    if (!h) break;
    heroes.push(h);
  }
  assert.ok(heroes.length >= 2, 'this test needs two heroes');

  // Equal armies, so neither absorbs the other (mergeAdjacentHeroes fires only under
  // MERGE_SHARE) and neither is obviously the main.
  const stand = [[0, 2], [1, 2]].map(([dx, dy]) => ({ x: home.x + dx, y: home.y + dy }));
  heroes.slice(0, 2).forEach((h, i) => {
    h.army = [{ creature: 'crusader', count: 40, hurt: 0 }];
    h.inTownId = null; h.aiGoal = null;
    h.x = stand[i].x; h.y = stand[i].y;
  });

  // One prize each way, the same distance out.
  const a = putArtifact(s, home.x + 6, home.y + 2);
  const b = putArtifact(s, home.x - 6, home.y + 2);
  assert.ok(a && b, 'no room on this seed to stage two equidistant prizes');

  runTurn(s);
  const picked = playerHeroes(s, AI).slice(0, 2)
    .map((h) => h.aiGoal?.key).filter(Boolean);
  assert.equal(picked.length, 2, `both heroes should have committed to something, got ${picked.length}`);
  assert.notEqual(picked[0], picked[1],
    `both heroes rode for ${picked[0]} and left the other prize standing`);
});

test('the board is read off the heroes\' own committed goals, not a second ledger', () => {
  // No new state, nothing serialized, nothing that can disagree with what the heroes
  // are actually doing — and the same key `goalKey` mints for the goal list, so a claim
  // and a goal are one identity rather than two that drift.
  const s = newGame({
    seed: 4312, mapW: 44, mapH: 38,
    players: [{ faction: 'castle', isHuman: true, team: 0 }, { faction: 'inferno', isHuman: false, team: 1 }],
  });
  const ai = new AITurnController(s, AI);
  const heroes = playerHeroes(s, AI);
  assert.ok(heroes.length >= 1);
  const h = heroes[0];

  assert.equal(ai.claimedTargets(h).size, 0, 'nothing is claimed before anybody has a goal');
  h.aiGoal = { key: 'artifact|A7', type: 'artifact', targetId: 'A7' };
  assert.equal(ai.claimedTargets(h).size, 0, 'a hero never blocks ITSELF');
  assert.ok(ai.claimedTargets(null).has('artifact|A7'), 'and its claim is visible to the others');

  // A hero of ANOTHER realm claims nothing of ours.
  const theirs = Object.values(s.heroes).find((x) => x.owner !== AI);
  if (theirs) {
    theirs.aiGoal = { key: 'artifact|A9', type: 'artifact', targetId: 'A9' };
    assert.ok(!ai.claimedTargets(h).has('artifact|A9'), 'a rival\'s plan is not our claim board');
  }
});

test('a claim damps a target, it does not delete it', () => {
  // Two heroes on one target is sometimes exactly right: a town neither can take alone
  // still wants both, and a hard exclusion would forbid that forever. Pinned at the
  // source because the arithmetic lives inside pickGoal's closure.
  const src = readFileSync(new URL('../src/ai/AIPlayer.js', import.meta.url), 'utf8');
  assert.match(src, /const CLAIM_DAMP = 0\.\d+;/, 'the damp is a named constant, not a magic number');
  assert.match(src, /if \(claimed\.has\(claimKey\)\) \{ score \*= CLAIM_DAMP;/,
    'a claimed target is multiplied down, never dropped');
  assert.match(src, /const claimKey = `\$\{tag\}\|\$\{id \?\? `\$\{x\},\$\{y\},\$\{z\}`\}`/,
    'the claim key must be the same identity goalKey mints');
  // And the claim is counted, so a brain log can show WHY a hero went elsewhere.
  assert.match(src, /scan\.vetoes\.claimed = \(scan\.vetoes\.claimed \|\| 0\) \+ 1/);
});
