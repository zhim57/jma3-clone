/**
 * spell-vfx.test.js — a cast must be watchable, and a stack under magic must be
 * readable at a glance.
 *
 * Two things a player asked for and neither of which any other test protects:
 *
 *   1. A spell that lands plays a visible swirl around its target for about a
 *      second — rings rising for a blessing, sinking for a hex.
 *   2. The square carrying the stack's troop count lights GREEN while only
 *      blessings ride it and RED while anything hexes it.
 *
 * The mood decision itself is `effectMood` in core/magic.js and is tested for
 * real in magic-mastery.test.js. What is left is the wiring — a scene cannot be
 * constructed headlessly (Phaser wants a canvas), so this file guards the
 * couplings at source level. Each assertion below is aimed at a way the feature
 * silently stops working, not at the text that happens to implement it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'scenes', 'CombatScene.js'), 'utf8');
const num = (name) => {
  const m = SRC.match(new RegExp(`^const ${name} = (\\d+)`, 'm'));
  assert.ok(m, `${name} is gone from CombatScene`);
  return Number(m[1]);
};

test('a cast plays a swirl on its target, for the second or two a player can see', () => {
  assert.match(SRC, /^ {2}spellSwirl\(unitId, hostile\)/m, 'the swirl method exists');
  // Both ways a spell can land on a friendly or hostile stack fire it: the
  // enchant path (buff/debuff) and the heal path (Cure, Resurrection).
  assert.match(SRC, /case 'spellEffect':[\s\S]{0,900}?this\.spellSwirl\(ev\.targetId, ev\.hostile\)/,
    'a landed enchantment swirls, and in the colour of its side');
  assert.match(SRC, /case 'heal':[\s\S]{0,600}?this\.spellSwirl\(ev\.targetId, false\)/,
    'so does a heal, and a heal is never hostile');

  // The band the request named: "some animation, 1-2 seconds". Below ~600ms it
  // is the blink this replaced; above ~2s every cast in a long battle is a wait.
  const swirl = num('SPELL_SWIRL_MS');
  assert.ok(swirl >= 800 && swirl <= 2000, `swirl runs ${swirl}ms, want 0.8–2s`);
  // And the turn loop must actually hold still long enough to see it start —
  // the dwell is what stops the next event overwriting the moment.
  assert.ok(num('DWELL_SPELLEFFECT_MS') >= 400, 'the dwell after a cast is long enough to read');
});

test('a seven-stack sweep plays as one gesture, not seven queued solos', () => {
  // Expert mastery emits one spellEffect PER stack. At the full dwell a mass
  // Haste would take four seconds of solos; every stack but the last gets a
  // frame instead, so all seven swirls are in the air together.
  const short = num('DWELL_SPELLEFFECT_MASS_MS'), full = num('DWELL_SPELLEFFECT_MS');
  assert.ok(short * 4 < full, `mass dwell ${short}ms must be far under the solo dwell ${full}ms`);
  assert.match(SRC, /this\.moreOfSweepAhead\(ev\) \? DWELL_SPELLEFFECT_MASS_MS : DWELL_SPELLEFFECT_MS/,
    'and the last stack of the sweep is the one that holds');

  // The off-by-one that would break it: moreOfSweepAhead scans the batch from
  // `a.i`, which is only the REMAINING events because the pump POST-increments.
  // If the pump ever pre-increments, the scan would see the current event and
  // every stack — including the last — would take the frame-length dwell.
  assert.match(SRC, /const ev = a\.events\[a\.i\+\+\]/,
    'the animation pump post-increments; moreOfSweepAhead depends on it');
  assert.match(SRC, /moreOfSweepAhead\(ev\)\s*\{[\s\S]{0,400}?for \(let i = a\.i;/,
    'the sweep scan starts at the first event still to come');
});

test('the troop-count plate is the enchantment light, and it can go out again', () => {
  assert.match(SRC, /import \{[^}]*\beffectMood\b[^}]*\} from '\.\.\/core\/magic\.js'/,
    'the scene asks core/magic for the mood rather than reinventing the rule');
  assert.match(SRC, /^ {2}refreshPlate\(u\)/m);
  assert.match(SRC, /refreshPlate\(u\)\s*\{[\s\S]{0,600}?const mood = effectMood\(u\)/);

  // Green for a blessing, red for a hex — and back to the SIDE colour when the
  // magic lapses. Without that last branch a stack stays lit for the rest of the
  // battle and the badge stops meaning anything.
  assert.match(SRC, /mood === 'hostile' \? 0xff5a5a : mood === 'friendly' \? 0x7ce7a0 : spr\.bandColor/);
  assert.match(SRC, /cont\.bandColor = bandColor/, 'the sprite remembers the colour to go back to');

  // It must be driven by the stack's LIVE effects on every redraw, not painted
  // once on cast: that is what makes it right after a load, after a dispel, and
  // on the round an effect expires.
  assert.match(SRC, /refreshUnits\(\)\s*\{[\s\S]{0,2600}?this\.refreshPlate\(u\)/,
    'every refresh re-reads the mood');
  // …and also lit the instant the spell lands, rather than a batch later.
  assert.match(SRC, /case 'spellEffect':[\s\S]{0,900}?this\.refreshPlate\(/);
});
