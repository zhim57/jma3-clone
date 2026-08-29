/**
 * passing-through.test.js — a hero crossing a tile is not a hero visiting it.
 *
 * Reported: "the heroes stop at the Redwood Observatory, shipyards, dwellings and
 * a dialog appears. Don't show the observatory dialog if everything is already
 * lit, and don't stop at dwellings or the shipyard when just passing through —
 * the player can go to them deliberately."
 *
 * Two separate fixes, because the two cases differ:
 *
 *   - The observatory's whole benefit IS the reveal. When the sweep is already
 *     charted the visit gives nothing, so it reports noBenefit and joins the
 *     existing toast-and-walk-on path. This is a rules-engine fact and is tested
 *     for real below; revealAround now returns how many tiles it lit so the
 *     engine can tell the difference.
 *   - A dwelling and a shipyard always have something to offer, so the question
 *     is not "is there a benefit" but "did the player come here". That is a view
 *     question — only executeMove knows whether this tile is the end of the path
 *     — so it is a static guard on the source.
 *
 * The line not to cross: rewards must still stop the march. A chest or an
 * artifact walked past unseen would be worse than the interruption complained of.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes } from '../src/core/GameState.js';
import { stepHero } from '../src/core/actions.js';
import { revealAround, isExplored, fogFor } from '../src/map/fog.js';

const adv = readFileSync(new URL('../src/scenes/AdventureScene.js', import.meta.url), 'utf8');

/** Clear a patch so a hero can be walked across it (as utility-visitables does). */
function clearBlock(state, cx, cy, r = 2) {
  const m = state.map;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const t = m.tiles[y * m.w + x];
      t.obstacle = null; t.terrain = 'grass';
      if (t.objectId) {
        if (m.objects[t.objectId]?.type === 'town') continue;
        delete m.objects[t.objectId]; t.objectId = null;
      }
    }
  }
  return { x: cx, y: cy };
}

function putObj(state, x, y, data) {
  const m = state.map;
  const id = `O${m.nextOid++}`;
  const obj = { id, x, y, ...data };
  m.objects[id] = obj;
  m.tiles[y * m.w + x].objectId = id;
  return obj;
}

/** handleMoveEvent's own body — the scene has other switches on object type. */
const handler = (() => {
  const from = adv.indexOf('  handleMoveEvent(hero, ev, continueWalk');
  assert.notEqual(from, -1, 'handleMoveEvent not found');
  const rest = adv.slice(from);
  const end = rest.indexOf('\n  // ====');
  return end === -1 ? rest : rest.slice(0, end);
})();

/** The body of one `case 'x': ...` arm of handleMoveEvent's switch. */
function caseBody(name) {
  const from = handler.indexOf(`      case '${name}':`);
  assert.notEqual(from, -1, `case '${name}' not found in handleMoveEvent`);
  const rest = handler.slice(from + 10);
  const end = rest.indexOf('\n      case ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('revealAround reports how many tiles it actually lit', () => {
  const s = newGame({ seed: 11 });
  const fog = fogFor(s, 0, 0);
  fog.fill(0);
  const first = revealAround(s, 0, 20, 20, 4, 0);
  assert.ok(first > 0, 'a dark disc lights up');
  assert.equal(revealAround(s, 0, 20, 20, 4, 0), 0,
    'the same disc a second time lights nothing — this is what "already charted" means');
  // Nudging the centre lights only the crescent that was outside the first disc.
  const shifted = revealAround(s, 0, 21, 20, 4, 0);
  assert.ok(shifted > 0 && shifted < first, `overlapping disc lit ${shifted}, expected a crescent`);
});

test('an observatory over already-charted land does not halt the march', () => {
  const s = newGame({ seed: 12 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 30, 16, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'observatory' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 1000;

  fogFor(s, 0, 0).fill(1); // the player has already been everywhere

  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.equal(ev.type, 'visited');
  assert.equal(ev.name, 'Redwood Observatory');
  assert.equal(ev.noBenefit, true,
    'nothing was revealed, so this must take the toast-and-continue path');
  assert.match(ev.text, /already charted/i, 'and say why, rather than claiming a reveal');
});

test('an observatory over dark land still stops and shows its reveal', () => {
  const s = newGame({ seed: 12 });
  const hero = playerHeroes(s, 0)[0];
  const spot = clearBlock(s, 30, 16, 2);
  putObj(s, spot.x, spot.y, { type: 'booster', boosterType: 'observatory' });
  hero.x = spot.x - 1; hero.y = spot.y; hero.mp = 1000;

  const probe = { x: spot.x, y: spot.y + CONFIG.OBSERVATORY_REVEAL - 1 };
  assert.ok(!isExplored(s, 0, probe.x, probe.y, 0), 'probe starts unexplored');

  const ev = stepHero(s, hero, { x: spot.x, y: spot.y, cost: 100 });
  assert.ok(!ev.noBenefit, 'a real reveal is worth the dialog');
  assert.ok(isExplored(s, 0, probe.x, probe.y, 0), 'and it did reveal');
});

// ---- the view half: only executeMove knows where the path ends --------------

test('executeMove tells handleMoveEvent whether the hero is passing through', () => {
  assert.match(adv, /handleMoveEvent\(hero, ev, continueWalk, passing = false\)/,
    'handleMoveEvent must take the flag');
  assert.match(adv, /const passing = !this\._interruptMove && i < path\.length - 1;/,
    'passing = not the last step of the path, and not a walk the player just halted');
  assert.match(adv, /this\.handleMoveEvent\(hero, ev, cont, passing\)/,
    'and it must actually be handed over');
  // A boat that lands on something resolves it through the same door.
  assert.match(adv, /this\.handleMoveEvent\(hero, ev\.landed, continueWalk, passing\)/,
    'the disembark path must not drop the flag');
});

test('a dwelling crossed on the way somewhere toasts instead of stopping', () => {
  const body = caseBody('dwelling');
  assert.match(body, /if \(passing\)/, 'the dwelling arm must honour the flag');
  const branch = body.slice(body.indexOf('if (passing)'));
  assert.match(branch, /this\.ui\?\.toast\(/, 'say what is on offer — the stock is the reason to come back');
  assert.match(branch, /continueWalk\(\);/, 'and keep walking');
  assert.ok(branch.indexOf('continueWalk()') < branch.indexOf('dwellingDialog'),
    'the pass-through branch must return before the recruit stepper opens');
});

test('a shipyard crossed on the way somewhere is silent', () => {
  const body = caseBody('shipyard');
  assert.match(body, /if \(passing\) \{ continueWalk\(\); return; \}/,
    'a dock on a coastal road must not ask every hero who walks the road');
  assert.ok(body.indexOf('if (passing)') < body.indexOf('shipyardDialog'),
    'and must return before the boat offer');
});

test('rewards still stop the march, whether or not the hero was headed there', () => {
  // The whole point of stopping is that these cannot be recovered later: a chest
  // walked past unopened, an artifact never shown. Only DECISIONS get deferred.
  for (const name of ['chest', 'artifact']) {
    assert.doesNotMatch(caseBody(name), /passing/,
      `case '${name}' must ignore passing — a reward walked past unseen is a bug, not a courtesy`);
  }
});
