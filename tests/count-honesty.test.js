/**
 * count-honesty.test.js — the number under a wild stack must be about the fight.
 *
 * Reported: "we have 5 griffins guarding a mine, I attack them and they turn to
 * 12k — other users may be too surprised."
 *
 * Under Tide of War the count on the object is the truth about the object and a
 * lie about the fight. A map that prints one while delivering the other is not a
 * map anyone can plan on, and being surprised by it is the whole complaint.
 *
 * Sizing a fight is the most expensive thing on that path and there can be dozens
 * of tokens on screen, so the label cannot pay for one. It says what it knows and
 * says which it is: the object's count when nothing scales, "5+" when a fight
 * would be sized but nobody has asked yet, and the real figure once a hover has
 * priced it. The map gets more honest as it is scouted.
 *
 * The predicate that decides which is a pure lookup — that is what makes asking
 * it of every token every refresh affordable, and it is what this file tests.
 * The three-state label is scene code, pinned by reading it, and watched running
 * in tests/smoke/guarded-prize-warm-smoke.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { newGame, playerHeroes, levelObjects } from '../src/core/GameState.js';
import { pveWouldScale } from '../src/core/actions.js';

const ADV = readFileSync(fileURLToPath(new URL('../src/scenes/AdventureScene.js', import.meta.url)), 'utf8');

const game = () => newGame({
  seed: 4242, mapW: 60, mapH: 52,
  players: [
    { faction: 'castle', isHuman: true, team: 0 },
    { faction: 'inferno', isHuman: false, team: 1 },
  ],
});
const find = (s, f) => Object.values(levelObjects(s, 0)).find(f);

test('the predicate answers for every kind the sizer can size', () => {
  const s = game();
  s.pveScaling = true;
  const hero = playerHeroes(s, 0)[0];
  for (const type of ['monster', 'creatureBank', 'pandora']) {
    const obj = find(s, (o) => o.type === type);
    if (!obj) continue;
    assert.equal(pveWouldScale(s, hero, obj), true, `${type} scales`);
  }
  // …and for nothing else. A mine's guards are a monster object; the mine is not.
  for (const type of ['mine', 'town', 'artifact', 'dwelling']) {
    const obj = find(s, (o) => o.type === type);
    if (!obj) continue;
    assert.equal(pveWouldScale(s, hero, obj), false, `${type} does not`);
  }
});

test('it says no when the rule is off, so the label stays exactly what it was', () => {
  const s = game();
  const hero = playerHeroes(s, 0)[0];
  const mon = find(s, (o) => o.type === 'monster');
  s.pveScaling = true;
  assert.equal(pveWouldScale(s, hero, mon), true);
  s.pveScaling = false;
  assert.equal(pveWouldScale(s, hero, mon), false, 'a game without the rule is unchanged');
});

test('it says no for nobody and for the AI — the number is about a particular fight', () => {
  const s = game();
  s.pveScaling = true;
  const mon = find(s, (o) => o.type === 'monster');
  assert.equal(pveWouldScale(s, null, mon), false, 'with no hero selected there is no fight to be about');
  const ai = playerHeroes(s, 1)[0];
  if (ai) {
    assert.equal(pveWouldScale(s, ai, mon), false,
      'the sizer never scales for the AI (tideScaleDefender), so neither may the label');
  }
});

test('the predicate is a LOOKUP — it must never price anything', () => {
  // What makes it affordable per token per refresh. If it ever grew a simulated
  // battle, the map would cost a sizing per visible stack per frame.
  const act = readFileSync(fileURLToPath(new URL('../src/core/actions.js', import.meta.url)), 'utf8');
  const at = act.indexOf('export function pveWouldScale');
  const body = act.slice(at, act.indexOf('\n}', at));
  for (const banned of ['tideMultiplier', 'predictedArmyLoss', 'combatContext', 'parleyOffer', 'createBattle']) {
    assert.ok(!body.includes(banned), `pveWouldScale must not call ${banned}`);
  }
});

test('the label has three states, and pays for none of them', () => {
  const at = ADV.indexOf('  paintCount(labelObj, obj) {');
  assert.notEqual(at, -1, 'paintCount not found');
  const body = ADV.slice(at, ADV.indexOf('\n  }\n', at));
  assert.match(body, /pveWouldScale\(this\.state, hero, obj\)/, 'asks the cheap predicate');
  assert.match(body, /\{ peek: true \}/, 'and only PEEKS at the priced cache — never prices');
  assert.match(body, /`\$\{obj\.count\}\+`/, 'unpriced: at least this many');
  assert.match(body, /COUNT_RESTING/, 'and the two claims are coloured differently');
  assert.match(body, /COUNT_MASSED/);
});

test('peeking really is free — it returns nothing rather than pricing', () => {
  const at = ADV.indexOf('  pricedEncounter(obj, kind, hero,');
  const body = ADV.slice(at, ADV.indexOf('\n  }\n', at));
  const peek = body.indexOf('if (peek && !hit) return null;');
  assert.ok(peek > 0, 'a peek that misses returns null');
  assert.ok(peek < body.indexOf('combatContext('),
    'and it does so BEFORE the engine call, which is the entire point');
});

test('the label is repainted when the fight it describes changes', () => {
  // Whose fight it is changes with the selection; whether it is priced changes on
  // a hover. Both must repaint or the map goes stale in the two ways it can.
  const sel = ADV.slice(ADV.indexOf('  selectHero(heroId) {'));
  assert.match(sel.slice(0, sel.indexOf('\n  }\n')), /this\.repaintCounts\(\)/);
  const hov = ADV.slice(ADV.indexOf('  updateObjectHover(pointer) {'));
  const body = hov.slice(0, hov.indexOf('\n  }\n'));
  assert.match(body, /this\.paintCount\(spr\.countLabel, obj\)/, 'the hovered token repaints…');
  assert.ok(!body.includes('repaintCounts'),
    '…and only that one: this runs per pointermove, and a preview key per object is not free');
});
