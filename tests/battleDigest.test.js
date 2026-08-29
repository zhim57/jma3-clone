import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battleDigest } from '../src/core/combat/battleDigest.js';

// A small, fully-determined battle: side 0 (human) = pikemen + archers,
// side 1 = imps + gogs. Hand-authored event stream so every number is known.
const roster = [
  { id: 'u0_0', side: 0, creature: 'pikeman', startCount: 16 },
  { id: 'u0_1', side: 0, creature: 'archer', startCount: 6 },
  { id: 'u1_0', side: 1, creature: 'imp', startCount: 25 },
  { id: 'u1_1', side: 1, creature: 'gog', startCount: 8 },
];
const events = [
  { type: 'roundStart', round: 1 },
  { type: 'attack', attackerId: 'u1_1', targetId: 'u0_0', damage: 30, kills: 3 },  // gog -> pikemen
  { type: 'roundStart', round: 2 },
  { type: 'attack', attackerId: 'u1_0', targetId: 'u0_1', damage: 12, kills: 2 },  // imp -> archers
  { type: 'attack', attackerId: 'u1_1', targetId: 'u0_0', damage: 40, kills: 4 },  // gog -> pikemen again
  { type: 'attack', attackerId: 'u0_0', targetId: 'u1_0', damage: 50, kills: 10 }, // pikemen -> imps
  { type: 'end', winner: 0 },
];

test('battleDigest: rounds and damage totals by side', () => {
  const d = battleDigest(events, roster, { humanSide: 0, won: true, xp: 100 });
  assert.equal(d.rounds, 2);
  assert.equal(d.damageDealt, 50);   // side 0 dealt 50
  assert.equal(d.damageTaken, 82);   // side 1 dealt 30+12+40
  assert.equal(d.won, true);
  assert.equal(d.xp, 100);
});

test('battleDigest: losses grouped by creature, per side', () => {
  const d = battleDigest(events, roster, { humanSide: 0, won: true });
  const pike = d.yourLosses.find((e) => e.creature === 'pikeman');
  const arch = d.yourLosses.find((e) => e.creature === 'archer');
  assert.equal(pike.lost, 7);
  assert.equal(pike.started, 16);
  assert.equal(arch.lost, 2);
  const imp = d.enemyLosses.find((e) => e.creature === 'imp');
  const gog = d.enemyLosses.find((e) => e.creature === 'gog');
  assert.equal(imp.lost, 10);
  assert.equal(gog.lost, 0);
  assert.equal(d.totalYouLost, 9);
});

test('battleDigest: biggest threat is the enemy stack that killed the most of yours', () => {
  const d = battleDigest(events, roster, { humanSide: 0, won: false });
  assert.equal(d.biggestThreat.creature, 'gog');
  assert.equal(d.biggestThreat.kills, 7);      // 3 + 4
  assert.equal(d.biggestThreat.name, 'Gog');
  assert.match(d.verdict, /Gog/);
  assert.match(d.verdict, /7/);
});

test('battleDigest: enemy hero spell damage is counted and blamed', () => {
  // The enemy hero (side 1) Implosions your pikemen. Spell events carry
  // casterSide, not attackerId, so the digest must still tally the damage and
  // name the sorcery as the threat.
  const spellEvents = [
    { type: 'roundStart', round: 1 },
    { type: 'spellHit', spellId: 'implosion', casterSide: 1, targetId: 'u0_0', damage: 90, kills: 9 },
    { type: 'attack', attackerId: 'u0_0', targetId: 'u1_0', damage: 20, kills: 4 },
    { type: 'end', winner: 1 },
  ];
  const d = battleDigest(spellEvents, roster, { humanSide: 0, won: false });
  assert.equal(d.damageTaken, 90, 'enemy spell damage is included in damage taken');
  assert.equal(d.damageDealt, 20);
  const pike = d.yourStacks.find((s) => s.id === 'u0_0');
  assert.equal(pike.lost, 9, 'spell kills are recorded as your losses');
  assert.equal(d.biggestThreat.kills, 9);
  assert.equal(d.biggestThreat.creature, null);
  assert.match(d.biggestThreat.name, /spell/i);
  assert.match(d.verdict, /spell/i);
});

test('battleDigest: your own spell damage is not blamed as a threat', () => {
  // You (side 0) cast the nuke — it must count as damage YOU dealt, and never
  // register as an enemy threat against yourself.
  const friendlyCast = [
    { type: 'roundStart', round: 1 },
    { type: 'spellHit', spellId: 'fireball', casterSide: 0, targetId: 'u1_0', damage: 40, kills: 8 },
    { type: 'end', winner: 0 },
  ];
  const d = battleDigest(friendlyCast, roster, { humanSide: 0, won: true });
  assert.equal(d.damageDealt, 40, 'your spell counts as damage you dealt');
  assert.equal(d.biggestThreat, null, 'your own spell is never a threat to you');
});

test('battleDigest: flawless win reads as flawless', () => {
  const clean = [
    { type: 'roundStart', round: 1 },
    { type: 'attack', attackerId: 'u0_0', targetId: 'u1_0', damage: 500, kills: 25 },
    { type: 'end', winner: 0 },
  ];
  const d = battleDigest(clean, roster, { humanSide: 0, won: true });
  assert.equal(d.totalYouLost, 0);
  assert.match(d.verdict, /Flawless/);
});

test('battleDigest: tolerates empty input', () => {
  const d = battleDigest([], [], { humanSide: 0, won: false });
  assert.equal(d.rounds, 1);
  assert.equal(d.totalYouLost, 0);
  assert.equal(d.biggestThreat, null);
});

test('battleDigest: per-stack detail carries started / lost / survived', () => {
  const d = battleDigest(events, roster, { humanSide: 0, won: true });
  const pike = d.yourStacks.find((s) => s.id === 'u0_0');
  assert.equal(pike.name, 'Pikeman');
  assert.equal(pike.started, 16);
  assert.equal(pike.lost, 7);
  assert.equal(pike.survived, 9);
  const arch = d.yourStacks.find((s) => s.id === 'u0_1');
  assert.equal(arch.survived, 4);      // 6 started - 2 lost
  const imp = d.enemyStacks.find((s) => s.id === 'u1_0');
  assert.equal(imp.lost, 10);
  assert.equal(imp.survived, 15);
  assert.equal(d.totalYouStarted, 22); // 16 pikemen + 6 archers
  // survived is also surfaced on the grouped losses.
  const pikeGroup = d.yourLosses.find((e) => e.creature === 'pikeman');
  assert.equal(pikeGroup.survived, 9);
});

test('battleDigest: advisory tells you to focus the deadliest enemy stack', () => {
  const d = battleDigest(events, roster, { humanSide: 0, won: true });
  // The gog killed 7 of 9 losses — over half — so it is called out by name.
  assert.match(d.advice, /Gog/);
  assert.match(d.advice, /[Ff]ocus/);
});

test('battleDigest: advisory flags a wiped shooter stack', () => {
  const wipedShooters = [
    { type: 'roundStart', round: 1 },
    { type: 'attack', attackerId: 'u1_0', targetId: 'u0_1', damage: 60, kills: 6 }, // imps wipe the archers
    { type: 'attack', attackerId: 'u0_0', targetId: 'u1_0', damage: 20, kills: 3 },
    { type: 'end', winner: 0 },
  ];
  const d = battleDigest(wipedShooters, roster, { humanSide: 0, won: true });
  assert.match(d.advice, /shooter/i);
  assert.match(d.advice, /[Ss]creen/);
});

test('battleDigest: advisory suggests a cheaper army after a clean win', () => {
  const cheapWin = [
    { type: 'roundStart', round: 1 },
    { type: 'attack', attackerId: 'u0_0', targetId: 'u1_0', damage: 500, kills: 25 },
    { type: 'attack', attackerId: 'u1_1', targetId: 'u0_0', damage: 3, kills: 0 }, // scratch, no losses
    { type: 'end', winner: 0 },
  ];
  const d = battleDigest(cheapWin, roster, { humanSide: 0, won: true });
  assert.equal(d.totalYouLost, 0);
  assert.match(d.advice, /cheaper|spare/i);
});

test('battleDigest: advisory for a loss is a rebuild-and-rethink tip', () => {
  const d = battleDigest([], [], { humanSide: 0, won: false });
  assert.match(d.advice, /Rethink|shooter/i);
});

// --- A4: moat deaths, revive/rebirth credit, friendly-fire accounting -------

test('battleDigest: moat deaths (carried on unitId) count as losses, not enemy output (A4)', () => {
  const moatEvents = [
    { type: 'roundStart', round: 1 },
    { type: 'moat', unitId: 'u0_0', damage: 20, kills: 4 }, // your pikemen charge the moat
    { type: 'end', winner: 1 },
  ];
  const d = battleDigest(moatEvents, roster, { humanSide: 0, won: false });
  assert.equal(d.yourStacks.find((s) => s.id === 'u0_0').lost, 4, 'moat kills recorded (event uses unitId)');
  assert.equal(d.totalYouLost, 4);
  assert.equal(d.damageTaken, 0, 'terrain damage is not credited to the enemy side');
  assert.equal(d.biggestThreat, null, 'the moat is not an enemy stack to blame');
});

test('battleDigest: Resurrection credits revived creatures back to net losses (A4)', () => {
  const reviveEvents = [
    { type: 'roundStart', round: 1 },
    { type: 'attack', attackerId: 'u1_1', targetId: 'u0_0', damage: 50, kills: 5 }, // gog kills 5 pikemen
    { type: 'heal', spellId: 'resurrection', casterSide: 0, targetId: 'u0_0', healed: 30, revived: 3 },
    { type: 'end', winner: 0 },
  ];
  const d = battleDigest(reviveEvents, roster, { humanSide: 0, won: true });
  const pike = d.yourStacks.find((s) => s.id === 'u0_0');
  assert.equal(pike.lost, 2, 'net losses = 5 killed - 3 revived');
  assert.equal(pike.survived, 14);
});

test('battleDigest: Phoenix rebirth reduces net losses (A4)', () => {
  const rebirthEvents = [
    { type: 'roundStart', round: 1 },
    { type: 'attack', attackerId: 'u1_0', targetId: 'u0_1', damage: 20, kills: 4 }, // archers lose 4
    { type: 'rebirth', unitId: 'u0_1', count: 2 },                                  // 2 rise again
    { type: 'end', winner: 0 },
  ];
  const d = battleDigest(rebirthEvents, roster, { humanSide: 0, won: true });
  assert.equal(d.yourStacks.find((s) => s.id === 'u0_1').lost, 2, 'net = 4 killed - 2 reborn');
});

// --- S8: a rout's fled survivors are losses, not survivors ------------------

test('battleDigest: routed survivors count as losses and are blamed on nobody (S8)', () => {
  // Opt-in cohesion (#11): the gogs kill 6 pikemen, then the remaining 10
  // break and flee. checkBreak zeroes the stack — none of the 16 come home —
  // but the rout event carries no `kills`, so before the `rout` branch the
  // debrief reported "Pikeman survived 10" over a written-back army with none.
  const routEvents = [
    { type: 'roundStart', round: 1 },
    { type: 'attack', attackerId: 'u1_1', targetId: 'u0_0', damage: 60, kills: 6 },
    { type: 'waver', unitId: 'u0_0' },
    { type: 'roundStart', round: 2 },
    { type: 'attack', attackerId: 'u1_1', targetId: 'u0_0', damage: 1, kills: 0 },
    { type: 'rout', unitId: 'u0_0', count: 10 },
    { type: 'end', winner: 1 },
  ];
  const d = battleDigest(routEvents, roster, { humanSide: 0, won: false });
  const pike = d.yourStacks.find((s) => s.id === 'u0_0');
  assert.equal(pike.lost, 16, '6 slain + 10 fled — the whole stack is gone');
  assert.equal(pike.survived, 0, 'nobody from a routed stack comes home');
  assert.equal(d.biggestThreat.kills, 6, 'the fled are not credited to the gogs as kills');
});

test('battleDigest: friendly fire is not counted as the caster side\'s damage output (A4)', () => {
  // You (side 0) cast Chain Lightning; a leap lands on your OWN archers.
  const friendlyFire = [
    { type: 'roundStart', round: 1 },
    { type: 'spellHit', spellId: 'chainLightning', casterSide: 0, targetId: 'u1_0', damage: 40, kills: 8 }, // enemy imp
    { type: 'spellHit', spellId: 'chainLightning', casterSide: 0, targetId: 'u0_1', damage: 15, kills: 3 }, // your archers
    { type: 'end', winner: 0 },
  ];
  const d = battleDigest(friendlyFire, roster, { humanSide: 0, won: true });
  assert.equal(d.damageDealt, 40, 'only damage to the ENEMY counts as your output — not the 15 to your own');
  assert.equal(d.yourStacks.find((s) => s.id === 'u0_1').lost, 3, 'your archers really did lose 3 to the leap');
  assert.equal(d.biggestThreat, null, 'your own spell is never an enemy threat');
});
