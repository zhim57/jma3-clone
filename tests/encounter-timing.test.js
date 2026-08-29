/**
 * encounter-timing.test.js — "attacking X takes several seconds" must be answerable.
 *
 * Reported for a Pandora's Box and a Griffin Conservatory. Every measurement of
 * the engine says the encounter is not where the seconds are: on a real day-57
 * game (88×72, both sides played out, a level-29 hero with ~500 creatures)
 * building the encounter costs 15-180ms for every defender kind, at every
 * position of the hardness dial and every value of the learned bias; the battle
 * itself is 2-4ms, applying its result under 1ms, serialising the game 24-33ms.
 * A browser driving the real click through to the battlefield showed a monster, a
 * guarded box and a bank within milliseconds of each other.
 *
 * So the useful thing is not another guess. The engine now stamps what building
 * the encounter cost, and the view reports it when it is out of line — and the
 * combat scene's opening line carries both halves, sizing and field build, so the
 * two candidate answers are separated by the log rather than by argument. A
 * freeze that produces no line is as informative as one that does: it says the
 * time went somewhere other than sizing the fight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../src/config.js';
import { newGame, playerHeroes, levelObjects } from '../src/core/GameState.js';
import { combatContext } from '../src/core/actions.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const game = () => newGame({
  seed: 4242, mapW: 60, mapH: 52,
  players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ],
});
const find = (s, f) => Object.values(levelObjects(s, 0)).find(f);

test('every encounter carries what it cost to build', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  const mon = find(s, (o) => o.type === 'monster' && !o.invader);
  const ctx = combatContext(s, hero, { kind: 'monster', objectId: mon.id }, { preview: true });
  assert.equal(typeof ctx.builtMs, 'number', 'stamped, so the view never has to time it itself');
  assert.ok(ctx.builtMs >= 0 && Number.isFinite(ctx.builtMs));
});

test('a preview and the real call both carry it — the click pays either path', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  const mon = find(s, (o) => o.type === 'monster' && !o.invader);
  for (const opts of [{ preview: true }, undefined]) {
    const ctx = combatContext(s, hero, { kind: 'monster', objectId: mon.id }, opts);
    assert.equal(typeof ctx.builtMs, 'number');
  }
});

test('the guarded prizes that were reported are timed like anything else', () => {
  // Both go through combatContext from stepHero, so both are covered — pinned
  // because these two are the ones the report named.
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  hero.army = [{ creature: 'archangel', count: 200, hurt: 0 }, null, null, null, null, null, null];
  for (const [kind, pick] of [
    ['pandora', (o) => o.type === 'pandora' && o.guards?.length && !o.looted],
    ['creatureBank', (o) => o.type === 'creatureBank' && !o.looted],
  ]) {
    const obj = find(s, pick);
    if (!obj) continue;   // this seed may not place one; the monster case covers the path
    const ctx = combatContext(s, hero, { kind, objectId: obj.id }, { preview: true });
    assert.equal(typeof ctx.builtMs, 'number', `${kind} carries its build cost`);
  }
});

test('the threshold sits above every measured encounter and below a reported freeze', () => {
  assert.ok(CONFIG.SLOW_ENCOUNTER_MS > 180,
    'above the slowest reading from a real day-57 game, or the line is noise');
  assert.ok(CONFIG.SLOW_ENCOUNTER_MS < 1000,
    'and well below "several seconds", or it would never fire for the thing it exists to catch');
});

test('the view reports a slow encounter, naming the defender', () => {
  const adv = read('../src/scenes/AdventureScene.js');
  const at = adv.indexOf('_doLaunchCombat(ctx, opts = {})');
  const body = adv.slice(at, adv.indexOf('\n  }\n', at));
  assert.match(body, /ctx\.builtMs > CONFIG\.SLOW_ENCOUNTER_MS/, 'compared against the threshold');
  assert.match(body, /ctx\.defender\?\.kind/, 'and says WHICH defender was slow, or the line cannot be acted on');
  // Before the scene sleeps and the battle takes over: a warning issued after the
  // hand-off is buried under the combat scene's own opening lines.
  assert.ok(body.indexOf('builtMs') < body.indexOf("this.scene.sleep('AdvUI')"));
});

test('the combat log line separates the two halves of the wait', () => {
  const combat = read('../src/scenes/CombatScene.js');
  const at = combat.indexOf('[combat] START build');
  const line = combat.slice(at, at + 500);
  assert.match(line, /sized=\$\{ctx\.builtMs\}ms/, 'what the engine spent sizing the fight');
  assert.match(line, /field=\$\{Math\.round\(performance\.now\(\) - t0\)\}ms/, 'and what the scene spent building it');
  assert.match(combat, /create\(\) \{\n\s*const t0 = performance\.now\(\);/,
    'timed from the top of create, so the number covers the whole build');
});
