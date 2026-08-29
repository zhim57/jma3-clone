/**
 * adventure-spells-v2b.test.js — the travel-mode adventure spells (Fly, Water
 * Walk) and Disguise.
 *
 *   Water Walk — a foot hero may stride over water for the day.
 *   Fly        — cross water AND obstacles for the day.
 *   Disguise   — hides the hero's army strength from enemy scouting.
 *
 * The movement modes are threaded through pathfinding's `move` param (a boolean
 * stays legacy foot/boat, an object carries waterWalk/fly). Covers the mode
 * logic, the cast flags + guards, stepHero striding onto water, the one-day
 * flag lifecycle (kept while stranded on water), and save round-trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, playerHeroes, serialize, deserialize, tileAt } from '../src/core/GameState.js';
import { castAdventureSpell, stepHero, stepReserve, endTurn } from '../src/core/actions.js';
import { isWalkable, isEnterable } from '../src/map/Pathfinding.js';
import { SPELLS } from '../src/data/spells.js';

function setTile(s, x, y, { terrain = 'grass', obstacle = null } = {}) {
  const t = tileAt(s, x, y);
  t.terrain = terrain; t.obstacle = obstacle; t.objectId = null;
  return t;
}
function nextDay(s) {
  const d0 = s.day; let guard = 12;
  while (s.day === d0 && guard-- > 0) endTurn(s);
  assert.equal(s.day, d0 + 1);
}

test('data: Fly / Water Walk / Disguise are adventure spells with schools', () => {
  for (const id of ['fly', 'waterWalk', 'disguise']) {
    assert.ok(SPELLS[id], `${id} exists`);
    assert.equal(SPELLS[id].adventure, true);
    assert.ok(['air', 'earth', 'fire', 'water'].includes(SPELLS[id].school));
  }
});

test('pathfinding modes: obstacles & water gate foot / water-walk / fly / boat', () => {
  const s = newGame({ seed: 3 });
  s.fog[0].fill(1);
  const OB = { x: 25, y: 20 }, WA = { x: 27, y: 20 };
  // Clear the neighbourhoods so no stray monster/object skews isWalkable.
  const clearArea = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const t = tileAt(s, cx + dx, cy + dy);
      if (t) { t.terrain = 'grass'; t.obstacle = null; t.objectId = null; }
    }
  };
  clearArea(OB.x, OB.y); clearArea(WA.x, WA.y);
  setTile(s, OB.x, OB.y, { terrain: 'grass', obstacle: 'mountain' });
  setTile(s, WA.x, WA.y, { terrain: 'water' });
  const walk = (p, move) => isWalkable(s, p.x, p.y, 0, null, move, 0);

  // Obstacle: only Fly crosses it.
  assert.equal(walk(OB, false), false, 'foot blocked by obstacle');
  assert.equal(walk(OB, { waterWalk: true }), false, 'water-walk still blocked by obstacle');
  assert.equal(walk(OB, { fly: true }), true, 'fly crosses the obstacle');

  // Water: foot never; water-walk / fly / boat all pass.
  assert.equal(walk(WA, false), false, 'foot never enters water (legacy boolean)');
  assert.equal(walk(WA, { waterWalk: true }), true, 'water-walk strides water');
  assert.equal(walk(WA, { fly: true }), true, 'fly crosses water');
  assert.equal(walk(WA, true), true, 'boat sails water (legacy boolean)');

  // isEnterable: NOBODY in the foot family — plain, water-walk OR fly — may END
  // a move on open water. The spells only let you STRIDE ACROSS water (isWalkable
  // above), landing on the far shore; you can never stop mid-sea.
  assert.equal(isEnterable(s, WA.x, WA.y, 0, false, 0), false, 'foot cannot land on open water');
  assert.equal(isEnterable(s, WA.x, WA.y, 0, { waterWalk: true }, 0), false, 'water-walk cannot STOP on open water');
  assert.equal(isEnterable(s, WA.x, WA.y, 0, { fly: true }, 0), false, 'fly cannot STOP on open water');
  assert.equal(isEnterable(s, OB.x, OB.y, 0, { fly: true }, 0), false, 'even flying, land on clear ground');
});

test('Water Walk: cast sets the flag; a foot hero then strides onto open water', () => {
  const s = newGame({ seed: 3 });
  s.fog[0].fill(1);
  const hero = playerHeroes(s, 0)[0];
  hero.x = 20; hero.y = 20; hero.mp = 5000; hero.onBoat = false;
  setTile(s, 20, 20); setTile(s, 21, 20, { terrain: 'water' }); // water right of the hero

  // A plain foot hero is blocked at the water's edge.
  assert.equal(stepHero(s, hero, { x: 21, y: 20, cost: 100 }).type, 'blocked');

  hero.spells = ['waterWalk']; hero.mana = 30;
  const r = castAdventureSpell(s, hero, 'waterWalk', null);
  assert.equal(r.ok, true);
  assert.equal(hero.waterWalk, true);
  assert.equal(castAdventureSpell(s, hero, 'waterWalk', null).ok, false, 'no double-cast');

  const ev = stepHero(s, hero, { x: 21, y: 20, cost: 100 });
  assert.equal(ev.type, 'moved', 'strode onto the water');
  assert.equal(hero.x, 21);
  assert.equal(hero.onBoat, false, 'walked on water — did NOT board a boat');
});

test('Fly: cast sets the flag; the hero crosses water on foot', () => {
  const s = newGame({ seed: 3 });
  s.fog[0].fill(1);
  const hero = playerHeroes(s, 0)[0];
  hero.x = 20; hero.y = 20; hero.mp = 5000; hero.onBoat = false;
  setTile(s, 20, 20); setTile(s, 21, 20, { terrain: 'water' });
  hero.spells = ['fly']; hero.mana = 30;
  assert.equal(castAdventureSpell(s, hero, 'fly', null).ok, true);
  assert.equal(hero.flying, true);
  const ev = stepHero(s, hero, { x: 21, y: 20, cost: 100 });
  assert.equal(ev.type, 'moved');
  assert.equal(hero.x, 21);
  assert.equal(hero.onBoat, false);
});

test('Disguise: cast flags the hero; cannot double-cast', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.spells = ['disguise']; hero.mana = 30;
  assert.equal(castAdventureSpell(s, hero, 'disguise', null).ok, true);
  assert.equal(hero.disguised, true);
  assert.equal(castAdventureSpell(s, hero, 'disguise', null).ok, false);
});

test('lifecycle: the travel/scouting flags clear at dawn on solid ground', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  // On land — the only place a legal move can end — every flag clears. (The
  // stranded-on-water exception is the separate lifecycle test below.)
  setTile(s, hero.x, hero.y, { terrain: 'grass' });
  hero.flying = true; hero.waterWalk = true; hero.disguised = true;
  nextDay(s);
  assert.equal(hero.flying, false);
  assert.equal(hero.waterWalk, false);
  assert.equal(hero.disguised, false);
});

test('lifecycle: a hero on open water KEEPS its travel spell at dawn (the stranding backstop)', () => {
  // stepReserve refuses any water run that never lands, so this state is
  // unreachable through legal movement — but a save written before that rule,
  // or any path this layer has not thought of, must not become a permanently
  // immobilised hero: clearing the spell is what turns a bug terminal. The
  // spell survives dawn exactly as long as the hero stands on water, and
  // lapses the first dawn after it regains land.
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  setTile(s, hero.x, hero.y, { terrain: 'water' });
  hero.onBoat = false;
  hero.flying = false; hero.waterWalk = true; hero.disguised = true;
  nextDay(s);
  assert.equal(hero.waterWalk, true, 'the spell that can walk it ashore is kept');
  assert.equal(hero.disguised, false, 'disguise has no stranding stake — it clears as always');
  setTile(s, hero.x, hero.y, { terrain: 'grass' }); // ashore again
  nextDay(s);
  assert.equal(hero.waterWalk, false, 'back on land, the one-day rule resumes');
});

test('stepReserve: a strider needs MP to reach the far shore before entering water', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.x = 20; hero.y = 20; hero.onBoat = false;
  setTile(s, 20, 20, { terrain: 'grass' });
  setTile(s, 21, 20, { terrain: 'water' });
  setTile(s, 22, 20, { terrain: 'water' });
  setTile(s, 23, 20, { terrain: 'grass' }); // the far shore
  const path = [
    { x: 21, y: 20, cost: 100 },
    { x: 22, y: 20, cost: 100 },
    { x: 23, y: 20, cost: 100 },
  ];
  // A plain foot hero (no travel flag): reserve is just this step — movement is
  // byte-identical to before for everyone who isn't a strider.
  assert.equal(stepReserve(s, hero, path, 0), 100);
  // Water Walk: entering the water reserves MP THROUGH to the land tile (3×100),
  // so a hero short of that halts on land at the water's edge.
  hero.waterWalk = true;
  assert.equal(stepReserve(s, hero, path, 0), 300, 'must be able to clear the whole span');
  // Once on the far-shore (land) step, it's an ordinary single-step cost again.
  assert.equal(stepReserve(s, hero, path, 2), 100);
  // Fly reserves identically.
  hero.waterWalk = false; hero.flying = true;
  assert.equal(stepReserve(s, hero, path, 0), 300);
});

test('the travel flags round-trip through save/load', () => {
  const s = newGame({ seed: 3 });
  const hero = playerHeroes(s, 0)[0];
  hero.flying = true; hero.waterWalk = false; hero.disguised = true;
  const r = deserialize(serialize(s));
  const h = r.heroes[hero.id];
  assert.equal(h.flying, true);
  assert.equal(h.disguised, true);
});

test('stepReserve: a water run that never LANDS is refused outright (audit C12)', () => {
  // isEnterable accepts a water tile holding a hero as a destination (the
  // naval-v2 strike), but a fight never enters the target's tile — the
  // attacker stops one short, and for a whole-water approach "one short" is
  // open water. Before this rule a Water Walk hero attacking a mid-channel
  // boat finished the day standing on the sea; the reserve now returns
  // Infinity for such a run, so the executor halts the hero on land at the
  // water's edge, exactly as when MP runs short.
  const s = newGame({ seed: 3 });
  s.fog[0].fill(1);
  const hero = playerHeroes(s, 0)[0];
  const enemy = playerHeroes(s, 1)[0];
  hero.x = 20; hero.y = 20; hero.mp = 5000; hero.onBoat = false; hero.waterWalk = true;
  setTile(s, 20, 20, { terrain: 'grass' });
  for (let x = 21; x <= 25; x++) setTile(s, x, 20, { terrain: 'water' });
  enemy.x = 25; enemy.y = 20; enemy.z = 0; enemy.onBoat = true;
  const path = [21, 22, 23, 24, 25].map((x) => ({ x, y: 20, cost: 100 }));
  assert.equal(stepReserve(s, hero, path, 0), Infinity,
    'the crossing ends at a fight on water — no landing, no crossing');

  // The ADJACENT strike is untouched: from the shore, the water target is the
  // very step being priced and the hero fights from its own legal tile.
  enemy.x = 21;
  const strike = [{ x: 21, y: 20, cost: 100 }];
  assert.equal(stepReserve(s, hero, strike, 0), 100, 'a shore strike costs its one step');
  const ev = stepHero(s, hero, strike[0]);
  assert.equal(ev.type, 'combat');
  assert.equal(hero.x, 20, 'and the striker never left the shore');
});

test('stepReserve: a run ending on a waiting BOAT is a legal stop (boarding)', () => {
  const s = newGame({ seed: 3 });
  s.fog[0].fill(1);
  const hero = playerHeroes(s, 0)[0];
  hero.x = 20; hero.y = 20; hero.mp = 5000; hero.onBoat = false; hero.waterWalk = true;
  setTile(s, 20, 20, { terrain: 'grass' });
  for (let x = 21; x <= 24; x++) setTile(s, x, 20, { terrain: 'water' });
  s.map.objects.BOATX = { id: 'BOATX', type: 'boat', x: 24, y: 20 };
  tileAt(s, 24, 20).objectId = 'BOATX';
  const path = [21, 22, 23, 24].map((x) => ({ x, y: 20, cost: 100 }));
  assert.equal(stepReserve(s, hero, path, 0), 400,
    'the strider may cross TO the boat — embarking ends the move legally');
});
