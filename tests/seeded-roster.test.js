/**
 * seeded-roster.test.js — the AI roster is dealt from the seed, never rolled
 * beside it (S14).
 *
 * Seeded determinism is the invariant this project rests on: the chronicle
 * prints the seed as the game's identity, and the Custom Game screen promises
 * "a re-rollable seed, so a map you like can be replayed". The AI factions are
 * a MAP-GENERATION input (each faction's native terrain shapes its zone), so a
 * roster drawn from Math.random made the same seed produce materially
 * different worlds on two shipped menu paths. Both now derive the roster from
 * the seed through core/rng's Rng, on a salt distinct from newGame's gameplay
 * (^0x9e3779b9) and wild (^0x5bf03635) streams — and, crucially, from a
 * separate Rng INSTANCE, so no draw order inside newGame moved for any seed.
 *
 * Phaser scenes cannot run headlessly, so these are source guards in the
 * combat-relayout.test.js pattern; the invariant itself is proven at runtime by
 * tests/smoke/seeded-roster-smoke.mjs (same seed ⇒ same roster + same map,
 * driven through the real begin()).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (n) => readFileSync(new URL(`../src/scenes/${n}.js`, import.meta.url), 'utf8');

function methodBody(src, header) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `cannot find ${header}`);
  const fn = src.slice(start);
  // CODE only: the prose above these lines names Math.random as the rejected
  // alternative (house style), which is exactly what the assertions hunt for.
  return fn.slice(0, fn.indexOf('\n  }\n')).replace(/\/\/.*$/gm, '');
}

test('CustomScenarioScene.begin deals AI factions from the displayed seed', () => {
  const body = methodBody(read('CustomScenarioScene'), '  begin() {');
  assert.match(body, /new Rng\(\(this\.cfg\.seed \^ /,
    'the roster stream must be derived from cfg.seed');
  assert.match(body, /facRng\.pick\(this\.factionIds\)/,
    'every AI slot draws from the seeded stream');
  assert.doesNotMatch(body, /Math\.random/,
    'a Math.random inside begin() is a hole in seeded determinism — the Reroll button owns variety');
});

// CLONE: the CampaignScene.beginConquest seed-mint test is dropped with that scene.
// The same invariant is still covered for the door this tree actually uses — see the
// CustomScenarioScene checks above and below.

test('the roster salt stays clear of the engine streams', () => {
  // newGame derives gameplay from seed ^ 0x9e3779b9 and the wild stream from
  // seed ^ 0x5bf03635; the roster using either would correlate its picks with
  // that stream's opening rolls.
  for (const scene of ['CustomScenarioScene']) {
    const src = read(scene);
    assert.doesNotMatch(src, /\^ 0x9e3779b9/, `${scene}: roster salt collides with the gameplay stream`);
    assert.doesNotMatch(src, /\^ 0x5bf03635/, `${scene}: roster salt collides with the wild stream`);
  }
});
