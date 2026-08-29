/**
 * CombatEngine.js — Headless tactical battle simulator.
 *
 * The battlefield is a 15x11 hex grid ("odd-r" offset layout: odd rows are
 * shifted right by half a hex). The engine is completely UI-free: it takes
 * actions and returns event lists; CombatScene animates them and the AI /
 * auto-resolver consume them silently. All randomness comes from the rng
 * passed in (the game's persistent stream).
 *
 * Core HoMM3 rules implemented here (docs/GAME_RULES.md):
 *   - initiative queue by creature speed, "wait" re-queues at low priority
 *   - stack damage = roll(min..max) * count, modified ±5%/2.5% per point of
 *     attack-vs-defense difference (capped +300% / -70%)
 *   - one retaliation per round per stack (unless abilities say otherwise)
 *   - hero may cast one spell per combat round
 *   - morale grants extra turns, luck doubles damage (chance = points/24)
 *   - creature specials: see `abilities` in data/creatures.js
 */

import { CONFIG } from '../../config.js';
import { CREATURES } from '../../data/creatures.js';
import { SPELLS, SCHOOL_SKILL } from '../../data/spells.js';
import { spellCost, isMassCast, massSide, spellEffects, spellDuration } from '../magic.js';
import { skillValue } from '../../data/skills.js';
import { heroStat, heroMaxMana, artifactBonus, heroBaseMorale, heroLuck } from '../heroUtils.js';
import { physicalDamage } from './physicalDamage.js';

export const BF_W = CONFIG.BATTLE_W;
export const BF_H = CONFIG.BATTLE_H;

// ---------------------------------------------------------------------------
// Hex helpers (odd-r offset)
// ---------------------------------------------------------------------------

export function hexNeighbors(x, y) {
  const odd = y & 1;
  const deltas = odd
    ? [[1, 0], [-1, 0], [0, -1], [1, -1], [0, 1], [1, 1]]
    : [[1, 0], [-1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]];
  const out = [];
  for (const [dx, dy] of deltas) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < BF_W && ny < BF_H) out.push([nx, ny]);
  }
  return out;
}

function offsetToCube(x, y) {
  const q = x - ((y - (y & 1)) >> 1);
  return [q, y, -q - y];
}

export function hexDistance(x0, y0, x1, y1) {
  const [aq, ar] = offsetToCube(x0, y0);
  const [bq, br] = offsetToCube(x1, y1);
  return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs((-aq - ar) - (-bq - br))) / 2;
}

// ---------------------------------------------------------------------------
// Battle creation
// ---------------------------------------------------------------------------

/**
 * cfg: {
 *   rng,
 *   attacker: { hero|null, army: [stacks], playerIndex },
 *   defender: { hero|null, army: [stacks], playerIndex },
 *   defenseBonus: number (siege walls, applies to defender),
 *   terrain: adventure terrain id (visual only),
 * }
 */
export function createBattle(cfg) {
  // THE BATTLE'S SEED. Battles borrow the game's persistent stream rather than
  // owning a seed, which made the engine deterministic but a single historical
  // battle unreplayable: the rng state at the moment it began was nowhere, only
  // the state now. So take it here, before the first draw of this fight — the
  // deployment split and the obstacle field are already draws, so anything later
  // is the wrong instant — and it is enough to rebuild this exact battle from a
  // save: `createBattle({ ...cfg, rng: Rng.fromJSON({ seed: 0, ...battle.seed }) })`.
  //
  // `calls` rides along as the diagnostic: it says WHERE in the game's stream the
  // fight sat, so a chronicle's battles can be ordered and a report can be placed.
  // Null when the caller passed a hand-rolled rng (some tests do) rather than an
  // Rng — recording a seed that cannot restore one would be worse than none.
  const battle = {
    rng: cfg.rng,
    seed: Number.isFinite(cfg.rng?.a)
      ? { state: cfg.rng.a >>> 0, calls: cfg.rng.calls | 0 }
      : null,
    terrain: cfg.terrain || 'grass',
    round: 0,
    sides: [
      makeSide(cfg.attacker, 0, cfg.simulated),
      makeSide(cfg.defender, 1, cfg.simulated),
    ],
    defenseBonus: cfg.defenseBonus || 0,
    units: [],
    obstacles: [],
    queue: [],
    queueIndex: 0,
    over: false,
    winner: null,
    hpLost: [0, 0],   // total HP of creatures killed, per side (debrief + telemetry)
    // Total aiValue of creatures killed, per side — the XP source. Kept BESIDE
    // hpLost rather than replacing it: HP is what the debrief and the telemetry
    // read, and value is what experience is denominated in. See battleResult.
    valueLost: [0, 0],
    walls: null,      // siege: destructible curtain-wall segments (see buildFortifications)
    moat: null,       // siege: hexes that bite a stack ending its move there
    siege: null,      // siege: { fortTier } when a walled town is besieged
    tactics: null,    // pre-battle placement: { side, reach, done } (see setupTactics)
    // Opt-in rule-engine features active for THIS battle ({} in Classic/skirmish),
    // threaded from state.features so live and auto-resolved battles agree.
    features: cfg.features || {},
    // Upgrade nodes owned by each player, INDEXED BY PLAYER INDEX (see
    // core/upgrades.js). Threaded from state the same way `features` is, so the
    // live fight and the auto-resolve of the same battle patch the same
    // creatures. A side with no owner carries playerIndex -1 and indexes nothing.
    upgrades: cfg.upgrades || [],
    // A per-creature scale on physical parameters, for CONTROLLED TRIALS: the
    // sandbox varies one parameter and holds the rest, which is exactly what a
    // partial derivative is. Absent in every real battle, and read only by the
    // physical model, so it costs a nullish check and nothing else.
    physScale: cfg.physScale || null,
    // The human's side (0/1), or -1 when no human is at the table (AI-vs-AI,
    // auto-resolve, previews). Cunning AI (#12) only mixes when facing a human.
    humanSide: cfg.humanSide ?? -1,
    // Siege arrow-tower damage multiplier (Settings). Absent (tests, non-siege
    // callers) ⇒ 1.0, so those battles are byte-identical to the raw creature
    // stat. Applied to every tower shot in rollDamage.
    siegeTowerDamage: Number.isFinite(cfg.siegeTowerDamage) ? cfg.siegeTowerDamage : 1,
  };

  // Nemesis edge: a hero branded a nemesis of the OTHER side's player fights it
  // with an escalating attack + defense bonus (CONFIG.NEMESIS), on top of its
  // normal hero stats. Applied here so it rides every battle path (interactive,
  // autoFight, autoResolve) without threading through the callers.
  applyNemesisEdge(battle.sides[0], battle.sides[1]);
  applyNemesisEdge(battle.sides[1], battle.sides[0]);
  applyInvaderDiscipline(battle.sides[0], cfg.attacker || {});
  applyInvaderDiscipline(battle.sides[1], cfg.defender || {});

  // Deploy stacks along the edges, centered rows first, with the strongest stack
  // SPLIT across empty slots first so one Blind cannot disable a whole army.
  //
  // Two kinds of side split, for two different reasons.
  //
  // A COMMANDED side (has a hero, isn't the human) splits when the player leaves the
  // `aiStackSplit` setting on — it is a statement about how cleverly the AI plays,
  // so it is the player's to turn off.
  //
  // A HEROLESS PvE DEFENDER — a wild stack, a bank guard, a war-band — splits by
  // RULE. That is new, and it closes the oldest exploit in the game: a defender that
  // deploys as one blob can be disabled by one Blind and then killed unretaliated,
  // and the same one-stack-one-hex shape is why overkill against a scaled guard was
  // free (CombatEngine skips retaliation when the target dies, so a single stack can
  // only ever be hit once per attacker). A guard on three hexes has to be disabled
  // three times, and the stacks that were not disabled swing back.
  //
  // It reads from CONFIG rather than from the live setting ON PURPOSE. The PvE sizer
  // (actions.tideMultiplier) prices a fight by SIMULATING it through this same
  // function, and a simulation that deployed differently from the battle it predicts
  // would be measuring a fight nobody fights. Deriving it from CONFIG means both
  // paths reach the same answer without threading a view-layer setting through the
  // engine — the two agree by construction rather than by discipline.
  const rows = [5, 3, 7, 1, 9, 0, 10];
  const deployArmyOf = (sideCfg, side) => {
    if (side === (cfg.humanSide ?? -1)) return sideCfg.army; // never rearrange the player's own
    const commanded = !!battle.sides[side].hero;
    // The PvE default comes from CONFIG so the sizer's simulation and the battle it
    // predicts agree without threading a setting through the engine; `cfg.pveStackSplit`
    // is an explicit override for callers that need a known deployment — engine unit
    // tests asserting a mechanic on one stack, mostly, where a three-way split would
    // silently change which unit strikes whom and make the assertion about a different
    // scenario. Both real paths take the default, so they still agree by construction.
    const pveOn = cfg.pveStackSplit === undefined ? !!CONFIG.PVE_STACK_SPLIT : !!cfg.pveStackSplit;
    const on = commanded ? !!cfg.aiStackSplit : pveOn;
    if (!on) return sideCfg.army;
    // How MANY pieces, for a heroless side, is learned rather than fixed: a player
    // who leans on mass-disable teaches the whole country to spread out, not just
    // the AI's own commanders (actions.pveSplitParts, from state.aiMemory). The
    // caller supplies it because the engine has no state; CONFIG is the floor and
    // the fallback, so a caller that does not care still gets the rule.
    //
    // EVERY caller that matters passes the same helper's answer — the real battle
    // AND the sizer's simulation of it — or the sizer would price a fight nobody
    // fights. tests/ai-memory.test.js pins that agreement.
    const parts = commanded ? cfg.aiSplitParts
      : Math.max(CONFIG.PVE_SPLIT_PARTS, cfg.pveSplitParts || 0);
    return splitArmyForDeploy(sideCfg.army, battle.rng, parts);
  };
  deployArmy(battle, deployArmyOf(cfg.attacker, 0), 0, 0, rows);
  deployArmy(battle, deployArmyOf(cfg.defender, 1), 1, BF_W - 1, rows);

  // War machines the hero brought (Blacksmith purchases). They sit on the edge
  // rows the 7 army slots never use, so they never collide with a stack.
  deployWarMachines(battle, cfg.attacker, 0, 0);
  deployWarMachines(battle, cfg.defender, 1, BF_W - 1);

  // Fortifications (Fort/Citadel/Castle): a destructible wall, a moat and the
  // besieger's Catapult REPLACE the random-obstacle field — a siege is fought on
  // the walls, not among scattered rocks.
  if (cfg.siege && cfg.siege.fortTier >= 1) {
    buildFortifications(battle, cfg.siege.fortTier);
  } else {
    // A few impassable obstacles in the middle for tactical texture.
    const count = battle.rng.int(3, 5);
    for (let i = 0; i < 60 && battle.obstacles.length < count; i++) {
      const x = battle.rng.int(3, BF_W - 4);
      const y = battle.rng.int(1, BF_H - 2);
      if (!unitAt(battle, x, y) && !battle.obstacles.some((o) => o.x === x && o.y === y)) {
        battle.obstacles.push({ x, y });
      }
    }
  }

  startRound(battle);
  setupTactics(battle, cfg);
  return battle;
}

/**
 * The Tactics skill: the hero with the higher Tactics may reposition its stacks
 * within a band of columns near its edge before the first turn. The reach is the
 * DIFFERENCE of the two heroes' tactics distances (Basic 3 / Advanced 5 / Expert
 * 7), so equal Tactics cancels out — exactly like HoMM3. Sets battle.tactics, or
 * leaves it null when nobody has an edge.
 */
function setupTactics(battle, cfg) {
  const at = cfg.attacker.hero ? skillValue(cfg.attacker.hero, 'tactics') : 0;
  const dt = cfg.defender.hero ? skillValue(cfg.defender.hero, 'tactics') : 0;
  const reach = Math.abs(at - dt);
  if (reach <= 0) return;
  battle.tactics = { side: at > dt ? 0 : 1, reach, done: false };
}

/** The [min,max] columns a side may place a stack in during the tactics phase. */
export function tacticsBand(battle, side) {
  if (!battle.tactics || battle.tactics.side !== side) return null;
  const r = battle.tactics.reach;
  return side === 0 ? { min: 0, max: r } : { min: BF_W - 1 - r, max: BF_W - 1 };
}

/** Is (x,y) a legal tactics destination for `unit`? (own non-machine stack, in
 *  the band, on a free unblocked hex, phase still open). */
export function canPlaceTactics(battle, unit, x, y) {
  const t = battle.tactics;
  if (!t || t.done || !unit || !unit.alive || unit.machine || unit.side !== t.side) return false;
  if (x < 0 || y < 0 || x >= BF_W || y >= BF_H) return false;
  const band = tacticsBand(battle, unit.side);
  if (!band || x < band.min || x > band.max) return false;
  if (blockedHex(battle, x, y)) return false;
  const occ = unitAt(battle, x, y);
  return !occ || occ.id === unit.id;
}

/** Reposition a stack during the tactics phase. Returns true if it applied. */
export function placeTactics(battle, unitId, x, y) {
  const unit = battle.units.find((u) => u.id === unitId);
  if (!canPlaceTactics(battle, unit, x, y)) return false;
  unit.x = x; unit.y = y;
  return true;
}

/** Close the tactics phase — positions are locked in and the fight begins. */
export function endTactics(battle) {
  if (battle.tactics) battle.tactics.done = true;
}

/**
 * Raise a besieged town's fortifications: a full-height curtain wall on column
 * WALL_X (one segment per row, the central row a weaker Gate), a moat band in
 * front (Citadel+), and the Catapult the attacker always brings. Walls are NOT
 * units — they're destructible barriers (see blockedHex/wallAt); the Catapult IS
 * a noncombatant unit (like the Blacksmith machines) so it can never keep the
 * attacker "alive" on its own.
 */
function buildFortifications(battle, fortTier) {
  const S = CONFIG.SIEGE;
  battle.siege = { fortTier };
  const wallHp = fortTier >= 3 ? S.wallHpCastle : S.wallHp;
  battle.walls = [];
  for (let y = 0; y < BF_H; y++) {
    const gate = y === S.GATE_ROW;
    battle.walls.push({
      id: `w${y}`, x: S.WALL_X, y,
      kind: gate ? 'gate' : 'wall',
      hp: gate ? S.gateHp : wallHp,
      maxHp: gate ? S.gateHp : wallHp,
      alive: true,
    });
  }
  battle.moat = [];
  if (fortTier >= S.moatFromTier) {
    for (let y = 0; y < BF_H; y++) battle.moat.push({ x: S.MOAT_X, y });
  }
  // The besieging hero always fields a Catapult (free siege engine). It sits on
  // the attacker edge at a row the 7 army slots + 3 Blacksmith machines never use.
  const c = CREATURES.catapult;
  battle.units.push({
    id: 'cat0', side: 0, creature: 'catapult', machine: 'catapult', noncombatant: true,
    count: 1, startCount: 1, hp: c.health, maxHp: c.health, x: 0, y: 6,
    shots: c.shots || 0, retaliated: false, defending: false, moraleUsed: false,
    resurrectUsed: false, effects: [], alive: true,
  });

  // Arrow towers: destructible auto-shooters just behind the wall (Citadel raises
  // the keep, Castle adds two more). Like the Catapult they are `noncombatant`
  // units — they shell the besiegers but never keep the defender "alive".
  const t = CREATURES.arrowTower;
  const towerRows = S.towerRows[fortTier] || [];
  towerRows.forEach((y, i) => {
    battle.units.push({
      id: `tower${i}`, side: 1, creature: 'arrowTower', machine: 'arrowTower', noncombatant: true,
      count: 1, startCount: 1, hp: t.health, maxHp: t.health, x: S.towerCol, y,
      shots: t.shots || 0, retaliated: false, defending: false, moraleUsed: false,
      resurrectUsed: false, effects: [], alive: true,
    });
  });
}

/** An invader war-band's drill: a flat attack/defense edge for the whole band,
 *  which is what "better weapons, more disciplined armies" means in the rules.
 *  Rides the same per-side bonus channel as the nemesis edge. */
function applyInvaderDiscipline(side, sideCfg) {
  const d = sideCfg.discipline || 0;
  if (!d) return;
  side.attackBonus += d;
  side.defenseBonusHero += d;
}

/** Add the nemesis's attack/defense edge to `side` when the OTHER side belongs to
 *  a player it has been branded against (see actions.brandNemesis). */
function applyNemesisEdge(side, foe) {
  const h = side.hero;
  if (!h || !h.nemesisOf || foe.playerIndex == null || foe.playerIndex < 0) return;
  const kills = h.nemesisOf[foe.playerIndex] || 0;
  if (kills <= 0) return;
  const edge = Math.min(CONFIG.NEMESIS.EDGE_CAP, kills * CONFIG.NEMESIS.EDGE_PER_KILL);
  side.attackBonus += edge;
  side.defenseBonusHero += edge;
}

function makeSide(sideCfg, index, simulated) {
  // A REAL battle holds the live hero by reference, so a cast really spends that
  // hero's mana (and manaThief siphons persist). A SIMULATION (stance win-%
  // preview, parley loss estimate, AI fight-weighing) must NOT touch the source
  // hero — autoResolve casts spells, and castSpell would otherwise drain the
  // player's real spell points to zero just by opening the pre-battle picker.
  // A shallow copy is enough: only `mana` is written during a fight; every other
  // field is read-only, so the clone shares them safely.
  const hero = simulated && sideCfg.hero ? { ...sideCfg.hero } : (sideCfg.hero || null);
  return {
    index,
    hero,
    playerIndex: sideCfg.playerIndex ?? -1,
    // Battle Formation (#10): 'press' (classic) unless the human picks otherwise.
    // Only affects damage variance + luck/morale swing — see stanceBaseRoll/stanceSwing.
    stance: normStance(sideCfg.stance),
    castThisRound: false,
    // Base morale WITHOUT the creature aura; sideMorale adds the aura from live
    // units so it applies symmetrically to hero and garrison armies (no double-count).
    morale: hero ? heroBaseMorale(hero) : 0,
    luck: hero ? heroLuck(hero) : 0,
    attackBonus: hero ? heroStat(hero, 'attack') : 0,
    defenseBonusHero: hero ? heroStat(hero, 'defense') : 0,
    creatureSpeedBonus: hero ? artifactBonus(hero, 'creatureSpeed') : 0,
    creatureHealthBonus: hero ? artifactBonus(hero, 'creatureHealth') : 0,
    // A creature-specialist hero buffs its matching stacks (see specStat).
    specCreature: hero && hero.specialty && hero.specialty.kind === 'creature' ? hero.specialty.creature : null,
  };
}

/** The specialty attack/defense/speed bonus this unit gets, if its side's hero
 *  specializes in its creature (matching the base creature OR its upgrade). */
function specStat(battle, unit, stat) {
  const spec = battle.sides[unit.side].specCreature;
  if (!spec) return 0;
  const matches = unit.creature === spec || CREATURES[unit.creature]?.upgradeOf === spec;
  return matches ? (CONFIG.SPECIALTY_CREATURE[stat] || 0) : 0;
}

/**
 * Split an AI side's strongest stack across its empty slots so a single
 * mass-disable (Blind/Paralyze) can't take the whole army out. Deploy-only: it
 * returns a NEW army array (source untouched), and writeBackArmy re-merges the
 * survivors so the stored army stays consolidated. `parts` is how many pieces to
 * aim for (clamped to the empty slots available + the stack itself). Mildly
 * randomized sizes via the battle rng — only drawn when a split actually happens,
 * so a non-splitting battle stays byte-identical.
 */
function splitArmyForDeploy(army, rng, parts) {
  const stacks = (army || []).filter((s) => s && s.count > 0);
  const empty = CONFIG.ARMY_SLOTS - stacks.length;
  if (empty <= 0) return army;
  // The stack a disable would most want to hit: highest total value, ≥ 2 to split.
  let bi = -1, bv = -1;
  stacks.forEach((s, i) => {
    const v = (CREATURES[s.creature]?.aiValue || 0) * s.count;
    if (s.count >= 2 && v > bv) { bv = v; bi = i; }
  });
  if (bi < 0) return army;
  const target = stacks[bi];
  const want = Math.max(2, Math.min(parts || CONFIG.AI_SPLIT_PARTS_DEFAULT, CONFIG.AI_SPLIT_PARTS_MAX));
  const n = Math.min(want, empty + 1, target.count);
  if (n < 2) return army;
  const counts = partitionCount(target.count, n, rng);
  // Every piece keeps the ORIGIN of the stack it was cut from, so the survivors
  // write back into that one slot rather than fragmenting the army across several
  // (see actions.writeBackArmy). A deploy-time split is a battlefield trick, not
  // a change to how the hero packs their army.
  // …and its `retinue` tag, for the same reason: a third party's stack that gets
  // cut in three is still that third party's, and all three pieces must go home
  // to it rather than to the side it fought alongside.
  const pieces = counts.map((c) => ({
    creature: target.creature, count: c, hurt: target.hurt || 0, origin: target.origin,
    retinue: target.retinue || null,
  }));
  const out = stacks.slice();
  out.splice(bi, 1, ...pieces);
  return out;
}

/** Split `total` into `parts` positive integers that sum to it, equal-ish then
 *  jittered by the rng so the pieces aren't identical (harder to plan around). */
function partitionCount(total, parts, rng) {
  const base = Math.floor(total / parts);
  const counts = new Array(parts).fill(base);
  for (let i = 0; i < total - base * parts; i++) counts[i]++;
  for (let k = 0; k < parts; k++) {
    const i = rng.int(0, parts - 1), j = rng.int(0, parts - 1);
    if (i === j || counts[i] <= 1) continue;
    const move = rng.int(1, Math.max(1, Math.floor(counts[i] * 0.4)));
    counts[i] -= move; counts[j] += move;
  }
  return counts.filter((c) => c > 0);
}

function deployArmy(battle, army, side, col, rows) {
  let slot = 0;
  for (const stack of army) {
    if (!stack || stack.count <= 0) continue;
    // Only 7 deploy rows exist; ignore extras so an oversized army can't wrap
    // two stacks onto the same hex.
    if (slot >= rows.length) break;
    const creature = CREATURES[stack.creature];
    const maxHp = creature.health + battle.sides[side].creatureHealthBonus;
    battle.units.push({
      id: `u${side}_${slot}`,
      side,
      creature: stack.creature,
      // Which of the hero's 7 slots this stack came out of, when the caller said
      // (see actions.armyForDeploy). Carried through the battle untouched and read
      // back by writeBackArmy so a player's chosen arrangement — three separate
      // stacks of archers, say — survives the fight instead of collapsing into one.
      origin: stack.origin,
      // A stack that belongs to a THIRD PARTY fighting on this side rather than to
      // the side's owner — a ronin's retinue standing with whoever was attacked
      // (see core/ronins.js). The battle treats it exactly like any other stack;
      // the tag exists solely so the survivors can be told apart afterwards and
      // handed back to their real owner instead of to the side they fought for.
      // `origin` cannot carry this: it is a slot index, and a non-integer in the
      // list makes writeBackArmy fall back to packing for the WHOLE army, which
      // would destroy the defender's own arrangement.
      retinue: stack.retinue || null,
      count: stack.count,
      startCount: stack.count,
      hp: maxHp,
      maxHp,
      x: col,
      y: rows[slot % rows.length],
      shots: creature.shots || 0,
      retaliated: false,
      defending: false,
      moraleUsed: false,
      resurrectUsed: false,
      effects: [],
      alive: true,
    });
    slot++;
  }
}

/**
 * Place the war machines a side's hero brought (hero.warMachines = { id: true }).
 * They sit at col 0 / BF_W-1 on rows 2/4/8 — the three edge rows the 7 army slots
 * never occupy (army rows are 5,3,7,1,9,0,10) — so they never overlap a stack.
 * Each is `noncombatant: true` (never keeps a side "alive") and `machine: id`.
 */
function deployWarMachines(battle, sideCfg, side, col) {
  const owned = sideCfg.hero?.warMachines;
  if (!owned) return;
  const layout = [['ballista', 4], ['firstAidTent', 2], ['ammoCart', 8]];
  let n = 0;
  for (const [id, row] of layout) {
    if (!owned[id]) continue;
    const c = CREATURES[id];
    if (!c) continue;
    battle.units.push({
      id: `m${side}_${n++}`,
      side,
      creature: id,
      machine: id,
      noncombatant: true,
      count: 1,
      startCount: 1,
      hp: c.health,
      maxHp: c.health,
      x: col,
      y: row,
      shots: c.shots || 0,
      retaliated: false,
      defending: false,
      moraleUsed: false,
      resurrectUsed: false,
      effects: [],
      alive: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Stat helpers
// ---------------------------------------------------------------------------

export function unitAt(battle, x, y) {
  return battle.units.find((u) => u.alive && u.x === x && u.y === y) || null;
}

/** An intact wall/gate segment occupying (x, y), or null. */
export function wallAt(battle, x, y) {
  if (!battle.walls) return null;
  return battle.walls.find((w) => w.alive && w.x === x && w.y === y) || null;
}

/** Does (x, y) lie in the besieged town's moat? */
function inMoat(battle, x, y) {
  return !!battle.moat && battle.moat.some((m) => m.x === x && m.y === y);
}

function blockedHex(battle, x, y) {
  // A standing wall segment blocks the hex for walkers exactly like an obstacle;
  // flyers path by distance (reachableHexes) so they still sail over it.
  return battle.obstacles.some((o) => o.x === x && o.y === y) || !!wallAt(battle, x, y);
}

/** Sum of active spell-effect deltas for a stat on this unit. */
export function effectDelta(unit, stat) {
  let d = 0;
  for (const e of unit.effects) d += e.effects[stat] || 0;
  return d;
}

export function hasFlag(unit, flag) {
  return unit.effects.some((e) => e.effects[flag]);
}

export function unitSpeed(battle, unit) {
  const c = CREATURES[unit.creature];
  return Math.max(1, c.speed + battle.sides[unit.side].creatureSpeedBonus + effectDelta(unit, 'speed')
    + specStat(battle, unit, 'speed'));
}

export function unitAttackStat(battle, unit) {
  const c = CREATURES[unit.creature];
  return Math.max(0, c.attack + battle.sides[unit.side].attackBonus + effectDelta(unit, 'attack')
    + specStat(battle, unit, 'attack'));
}

export function unitDefenseStat(battle, unit) {
  const c = CREATURES[unit.creature];
  let d = c.defense + battle.sides[unit.side].defenseBonusHero + effectDelta(unit, 'defense')
    + specStat(battle, unit, 'defense');
  if (unit.side === 1) d += battle.defenseBonus; // siege walls
  if (unit.defending) d = Math.round(d * CONFIG.DEFEND_DEFENSE_MULT);
  return Math.max(0, d);
}

function sideMorale(battle, side, unit) {
  // The undead feel neither courage nor fear, and mindless elementals have no
  // will to sway — their morale is locked at neutral (no lucky extra turns, no
  // freezes).
  const uc = unit && CREATURES[unit.creature];
  if (uc && (uc.undead || uc.mindless)) return 0;
  let m = battle.sides[side].morale + (unit ? effectDelta(unit, 'morale') : 0);
  // Angels' presence lifts the whole side. Computed from LIVE units so it applies
  // symmetrically to hero and garrison armies and fades once the angel is slain
  // (side.morale no longer bakes the aura in — see makeSide/heroBaseMorale).
  if (battle.units.some((u) => u.alive && u.side === side && CREATURES[u.creature].abilities.includes('moraleAura'))) {
    m += 1;
  }
  return clamp3(m);
}

function sideLuck(battle, side, unit) {
  let l = battle.sides[side].luck + (unit ? effectDelta(unit, 'luck') : 0);
  // Devils curse their foes' fortunes.
  if (battle.units.some((u) => u.alive && u.side !== side && CREATURES[u.creature].abilities.includes('curseAura'))) {
    l -= 1;
  }
  return clamp3(l);
}

function clamp3(v) {
  return Math.max(-CONFIG.MORALE_LUCK_MAX, Math.min(CONFIG.MORALE_LUCK_MAX, v));
}

export function ability(unit, name) {
  return CREATURES[unit.creature].abilities.includes(name);
}

/** A creature's worth in the one currency experience is denominated in. War
 *  machines are not creatures and are worth nothing. */
function unitValue(unit) {
  return unit.machine ? 0 : (CREATURES[unit.creature]?.aiValue || 0);
}

/** A live unit that counts toward a side's survival. War machines are alive on
 *  the field but are `noncombatant`: they never win or lose a battle on their own. */
export function combatant(unit) {
  return unit.alive && !unit.noncombatant;
}

/** Does `side` field an Ammo Cart? (its shooters then never run out of shots). */
function sideHasAmmoCart(battle, side) {
  return battle.units.some((u) => u.alive && u.side === side && u.machine === 'ammoCart');
}

// ---------------------------------------------------------------------------
// Round & turn management
// ---------------------------------------------------------------------------

function startRound(battle) {
  battle.round++;
  for (const side of battle.sides) side.castThisRound = false;
  for (const u of battle.units) {
    if (!u.alive) continue;
    u.retaliated = false;
    u.defending = false;
    u.moraleUsed = false;
    u.hasWaitedFlag = false; // Wait is once per ROUND, not once per battle
    u.roundStartCount = u.count;    // Cohesion (#11): baseline for the round's loss check
    u.breakCheckedThisRound = false;
    // Effects tick down at the start of each round (cast round counts as 1).
    // A corpse's effects are deliberately NOT ticked here — the dead are
    // skipped above — because revival clears them wholesale (reviveHygiene):
    // an enchantment dies with the flesh it was woven into.
    if (battle.round > 1) {
      for (const e of u.effects) e.rounds--;
      u.effects = u.effects.filter((e) => e.rounds > 0);
    }
    // Trolls knit their wounds back together.
    if (ability(u, 'regenerate')) u.hp = u.maxHp;
  }
  // Initiative: speed desc; attacker acts first on ties.
  const alive = battle.units.filter((u) => u.alive);
  alive.sort((a, b) => (unitSpeed(battle, b) - unitSpeed(battle, a)) || (a.side - b.side));
  battle.queue = alive.map((u) => u.id);
  battle.queueIndex = 0;
}

/**
 * Advance to the next unit that can act.
 * Returns { unit, events } — unit is null when the battle is over.
 * Handles round rollover, blind/bad-morale skips.
 */
export function beginTurn(battle) {
  const events = [];
  for (let guard = 0; guard < 500; guard++) {
    if (battle.over) return { unit: null, events };
    if (battle.queueIndex >= battle.queue.length) {
      startRound(battle);
      events.push({ type: 'roundStart', round: battle.round });
      continue;
    }
    const unit = battle.units.find((u) => u.id === battle.queue[battle.queueIndex]);
    if (!unit || !unit.alive) {
      battle.queueIndex++;
      continue;
    }
    // Blinded units lose their action.
    if (hasFlag(unit, 'blinded')) {
      events.push({ type: 'skip', unitId: unit.id, reason: 'blinded' });
      battle.queueIndex++;
      continue;
    }
    // Bad morale: creature freezes. War machines are mindless — never affected.
    // Battle Formation scales the chance (hold never freezes, all-in ×1.5).
    const m = unit.machine ? 0 : sideMorale(battle, unit.side, unit);
    if (m < 0 && !unit.moraleUsed && battle.rng.chance(-m * CONFIG.MORALE_CHANCE_PER_POINT * stanceSwing(battle.sides[unit.side].stance))) {
      unit.moraleUsed = true; // only one morale event per unit per round
      events.push({ type: 'badMorale', unitId: unit.id });
      battle.queueIndex++;
      continue;
    }
    // Cohesion (#11): a stack that WAVERED after heavy losses cowers — it forfeits
    // this turn (lost tempo), then steadies (the flag clears until it breaks again).
    if (unit.wavered) {
      unit.wavered = false;
      events.push({ type: 'skip', unitId: unit.id, reason: 'waver' });
      battle.queueIndex++;
      continue;
    }
    return { unit, events };
  }
  return { unit: null, events };
}

/** Legal destination hexes for a unit (excludes its own hex). */
export function reachableHexes(battle, unit) {
  const speed = unitSpeed(battle, unit);
  const c = CREATURES[unit.creature];
  const flies = c.reach === 'flying' || ability(unit, 'teleport');
  const out = [];
  if (flies) {
    for (let y = 0; y < BF_H; y++) {
      for (let x = 0; x < BF_W; x++) {
        if (hexDistance(unit.x, unit.y, x, y) <= speed &&
            !unitAt(battle, x, y) && !blockedHex(battle, x, y) &&
            !(x === unit.x && y === unit.y)) {
          out.push({ x, y });
        }
      }
    }
    return out;
  }
  // Walkers: BFS around other units and obstacles.
  const dist = new Map();
  dist.set(unit.y * BF_W + unit.x, 0);
  const q = [[unit.x, unit.y]];
  while (q.length) {
    const [cx, cy] = q.shift();
    const d = dist.get(cy * BF_W + cx);
    if (d >= speed) continue;
    for (const [nx, ny] of hexNeighbors(cx, cy)) {
      const key = ny * BF_W + nx;
      if (dist.has(key)) continue;
      if (unitAt(battle, nx, ny) || blockedHex(battle, nx, ny)) continue;
      dist.set(key, d + 1);
      out.push({ x: nx, y: ny });
      q.push([nx, ny]);
    }
  }
  return out;
}

/** Can `unit` shoot right now? (has shots — or an Ammo Cart — and no adjacent enemy) */
export function canShoot(battle, unit) {
  const c = CREATURES[unit.creature];
  if (c.reach !== 'ranged') return false;
  if (unit.shots <= 0 && !sideHasAmmoCart(battle, unit.side)) return false;
  // A Ballista / Arrow Tower is a fixed emplacement: it fires over an adjacent enemy.
  if (unit.machine === 'ballista' || unit.machine === 'arrowTower') return true;
  return !hexNeighbors(unit.x, unit.y).some(([x, y]) => {
    const u = unitAt(battle, x, y);
    return u && u.side !== unit.side;
  });
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

/**
 * Battle Formations (#10) — three EV-neutral stances a side may fight under.
 * All share the mean of [dmin,dmax]; they differ only in variance and in how
 * much luck/morale swing they invite. Only the human ever leaves 'press'.
 */
export const COMBAT_STANCES = ['hold', 'press', 'allin'];

/** Coerce any value to a valid stance ('press' — the classic roll — by default). */
export function normStance(s) {
  return COMBAT_STANCES.includes(s) ? s : 'press';
}

/**
 * The per-creature damage roll for a stance. EV-neutral across all three:
 *  - hold  → the fixed mean (dmin+dmax)/2 (zero variance)
 *  - allin → bimodal: min or max, 50/50 (maximum variance)
 *  - press → the classic uniform int(dmin,dmax) — byte-identical to before
 * (`rng` is consulted for press/allin, not hold.)
 */
export function stanceBaseRoll(rng, dmin, dmax, stance) {
  if (stance === 'hold') return (dmin + dmax) / 2;
  if (stance === 'allin') return rng.chance(0.5) ? dmax : dmin;
  return rng.int(dmin, dmax);
}

/** Luck/morale event-chance multiplier for a stance: hold 0, all-in ×1.5, press 1. */
export function stanceSwing(stance) {
  return stance === 'hold' ? 0 : stance === 'allin' ? CONFIG.BF_ALLIN_SWING : 1;
}

/** Set a live battle side's fighting stance (validated). Used by the pre-battle picker. */
export function setBattleStance(battle, side, stance) {
  if (battle?.sides?.[side]) battle.sides[side].stance = normStance(stance);
}

// The engine helpers the physical damage model needs. INJECTED rather than
// imported the other way round, so physicalDamage.js never imports this file
// back and there is no module cycle to reason about (HANDOVER §2.4).
// Exported because the combat AI's estimator calls the same model through the
// same bundle — one injection point, so the two cannot be given different
// helpers and quietly disagree.
export const PHYS_ENGINE = {
  hasFlag, ability, hexDistance, sideLuck, stanceBaseRoll, stanceSwing,
  unitAttackStat, unitDefenseStat,
};

/**
 * Compute one attack instance. Returns { damage, luck } without applying it.
 * kind: 'melee' | 'ranged' | 'retaliation'
 */
function rollDamage(battle, attacker, defender, kind) {
  // Opt-in physical model (src/core/combat/physicalDamage.js). Same return
  // shape, same rng draws; with the flag off this line is the only trace of it.
  if (battle.features?.physicalDamage) return physicalDamage(battle, attacker, defender, kind, PHYS_ENGINE);
  const c = CREATURES[attacker.creature];
  const side = battle.sides[attacker.side];
  const [dmin, dmax] = c.damage;

  let per;
  if (hasFlag(attacker, 'blessed')) per = dmax;
  else if (hasFlag(attacker, 'cursed')) per = dmin;
  else per = stanceBaseRoll(battle.rng, dmin, dmax, side.stance);
  let dmg = per * attacker.count;

  // Attack vs defense.
  const A = unitAttackStat(battle, attacker);
  let D = unitDefenseStat(battle, defender);
  // Behemoths rend through armour, ignoring a fraction of the target's defense.
  if (ability(attacker, 'ignoreDefense')) D = Math.round(D * (1 - (c.defenseIgnore ?? 0.4)));
  if (A >= D) {
    dmg *= 1 + Math.min(CONFIG.ATTACK_BONUS_CAP, (A - D) * CONFIG.ATTACK_BONUS_PER_POINT);
  } else {
    dmg *= 1 - Math.min(CONFIG.DEFENSE_REDUCTION_CAP, (D - A) * CONFIG.DEFENSE_REDUCTION_PER_POINT);
  }

  // Hero secondary skills.
  const hero = side.hero;
  if (hero) {
    if (kind === 'ranged') dmg *= 1 + skillValue(hero, 'archery');
    else dmg *= 1 + skillValue(hero, 'offense');
  }
  const defHero = battle.sides[defender.side].hero;
  if (defHero) dmg *= 1 - skillValue(defHero, 'armorer');

  // Range / melee penalties for shooters.
  if (kind === 'ranged' && hexDistance(attacker.x, attacker.y, defender.x, defender.y) > CONFIG.RANGED_FULL_RANGE) {
    dmg *= 0.5;
  }
  if (kind !== 'ranged' && CREATURES[attacker.creature].reach === 'ranged' && !ability(attacker, 'noMeleePenalty')) {
    dmg *= 0.5;
  }

  // Siege arrow towers hit for a tunable multiplier (Settings → Siege Tower
  // Damage) so a fortress's towers are a real deterrent, not a formality.
  if (attacker.machine === 'arrowTower') dmg *= battle.siegeTowerDamage;

  // Luck. Battle Formation scales the swing chance (hold=0, all-in=×1.5, press=1),
  // so 'press' is byte-identical to the classic roll and 'hold' never crits.
  let luck = 0;
  const l = sideLuck(battle, attacker.side, attacker);
  const sw = stanceSwing(side.stance);
  if (l > 0 && battle.rng.chance(l * CONFIG.LUCK_CHANCE_PER_POINT * sw)) { dmg *= 2; luck = 1; }
  else if (l < 0 && battle.rng.chance(-l * CONFIG.LUCK_CHANCE_PER_POINT * sw)) { dmg *= 0.5; luck = -1; }

  return { damage: Math.max(1, Math.round(dmg)), luck };
}

/** Apply raw damage to a unit. Returns { kills, died, damage }. */
function applyDamage(battle, unit, damage) {
  const pool = (unit.count - 1) * unit.maxHp + unit.hp;
  const newPool = pool - damage;
  let kills;
  if (newPool <= 0) {
    kills = unit.count;
    unit.count = 0;
    unit.hp = 0;
    unit.alive = false;
  } else {
    const newCount = Math.ceil(newPool / unit.maxHp);
    kills = unit.count - newCount;
    unit.count = newCount;
    unit.hp = newPool - (newCount - 1) * unit.maxHp;
  }
  battle.hpLost[unit.side] += kills * unit.maxHp;
  battle.valueLost[unit.side] += kills * unitValue(unit);
  // Pain breaks blindness.
  unit.effects = unit.effects.filter((e) => !e.effects.blinded);
  return { kills, died: !unit.alive, damage };
}

/** A stack that ended its move in the besieged town's moat takes a bite of
 *  damage. Machines (Catapult) are on the attacker edge and never enter it. */
function applyMoat(battle, unit, events) {
  if (!unit.alive || unit.machine || !inMoat(battle, unit.x, unit.y)) return;
  const dmg = CONFIG.SIEGE.moatDamage;
  const r = applyDamage(battle, unit, dmg);
  events.push({ type: 'moat', unitId: unit.id, x: unit.x, y: unit.y, damage: dmg, kills: r.kills, died: r.died });
}

/**
 * Cohesion & the Breaking Point (#11, opt-in): a bloodied stack (lost >= half its
 * round-start number) rolls a morale break check, once per round. First failure
 * → WAVER (cowers, forfeits its next turn); second → ROUT (survivors flee the
 * field, removed from the battle and booked like a kill so XP/army loss stay
 * consistent). Undead + war machines are fearless. No rng is drawn when the
 * feature is off, so Classic and auto-resolve stay byte-identical.
 */
/** Break probability for a stack at a given morale (clamped [MIN,MAX]; steadier
 *  with higher morale). Exported for the rout unit tests. */
export function routBreakChance(morale) {
  return Math.max(CONFIG.ROUT_MIN, Math.min(CONFIG.ROUT_MAX, CONFIG.ROUT_BASE - CONFIG.ROUT_PER_MORALE * morale));
}

function checkBreak(battle, unit, events) {
  if (!battle.features?.cohesionRout) return;
  if (!unit.alive || unit.machine || unit.breakCheckedThisRound) return;
  if (CREATURES[unit.creature]?.undead) return; // the dead do not fear death
  const start = unit.roundStartCount || unit.startCount || unit.count;
  if (unit.count > start * (1 - CONFIG.ROUT_LOSS_FRACTION)) return; // not yet half-gone
  unit.breakCheckedThisRound = true;
  const morale = sideMorale(battle, unit.side, unit);
  if (!battle.rng.chance(routBreakChance(morale))) return; // held the line
  unit.breakFails = (unit.breakFails || 0) + 1;
  if (unit.breakFails >= 2) {
    const fled = unit.count; // captured before the zeroing below
    battle.hpLost[unit.side] += fled * unit.maxHp; // fled survivors leave the fight
    battle.valueLost[unit.side] += fled * unitValue(unit);
    unit.count = 0; unit.hp = 0; unit.alive = false; unit.routed = true;
    // `count` rides on the event because the debrief reduces the EVENT STREAM,
    // not engine state: battleDigest accrues losses from ev.kills/ev.count, and
    // without the number here it reported the fled survivors as having come
    // home while the written-back army held no such troops.
    events.push({ type: 'rout', unitId: unit.id, count: fled });
  } else {
    unit.wavered = true; // cowers next turn (see beginTurn)
    events.push({ type: 'waver', unitId: unit.id });
  }
}

/** One attack instance from a to d (already adjacent / in range). */
function strike(battle, attacker, defender, kind, events) {
  const defenderPool = (defender.count - 1) * defender.maxHp + defender.hp;
  const { damage, luck } = rollDamage(battle, attacker, defender, kind);
  const res = applyDamage(battle, defender, damage);
  events.push({
    type: kind === 'retaliation' ? 'retaliate' : 'attack',
    kind,
    attackerId: attacker.id, targetId: defender.id,
    damage, kills: res.kills, died: res.died, luck,
  });
  if (defender.alive) checkBreak(battle, defender, events); // heavy losses may break cohesion
  // Vampire lords drain the life of the LIVING to mend (and even raise) their
  // own ranks — no drain from the undead, war machines, or via a ranged shot.
  // Healing is capped at the HP actually inflicted, so overkill never over-heals.
  if (attacker.alive && kind !== 'ranged' && ability(attacker, 'lifeDrain')) {
    const victim = CREATURES[defender.creature];
    if (victim && !victim.undead && victim.faction !== 'machine') {
      const healed = healUnit(battle, attacker, Math.min(damage, defenderPool), true);
      if (healed.hp > 0) {
        events.push({
          type: 'lifeDrain', attackerId: attacker.id, targetId: defender.id,
          healed: healed.hp, revived: healed.revived,
        });
      }
    }
  }
  // Efreet sultans wreathe themselves in fire.
  if (kind !== 'ranged' && defender.alive && ability(defender, 'fireShield')) {
    const burn = Math.max(1, Math.round(damage * 0.2));
    const r = applyDamage(battle, attacker, burn);
    events.push({
      type: 'fireShield', attackerId: defender.id, targetId: attacker.id,
      damage: burn, kills: r.kills, died: r.died,
    });
  }
  return res;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Execute a unit action. Returns an event list for animation.
 * action:
 *   { type: 'move', x, y }
 *   { type: 'attack', targetId, x, y }   — melee from hex (x,y); omit x/y to attack in place
 *   { type: 'shoot', targetId }
 *   { type: 'wait' } | { type: 'defend' }
 *   { type: 'resurrect', targetId }      — archangel special
 */
export function act(battle, unit, action) {
  const events = [];
  if (battle.over || !unit.alive) return events;

  switch (action.type) {
    case 'move': {
      // Reject illegal moves (unreachable / occupied / blocked hex) by returning
      // WITHOUT applying — never throw: autoResolve's loop has no try/catch.
      if (!reachableHexes(battle, unit).some((h) => h.x === action.x && h.y === action.y)) return events;
      events.push({ type: 'move', unitId: unit.id, from: { x: unit.x, y: unit.y }, to: { x: action.x, y: action.y } });
      unit.x = action.x; unit.y = action.y;
      applyMoat(battle, unit, events);
      break;
    }
    case 'wait': {
      // Once per ROUND (the flag resets at each new round) — reject a repeat
      // instead of re-queueing forever; the UI already greys the button, this
      // enforces it for every other caller.
      if (unit.hasWaitedFlag) return events;
      // Re-queue after everyone else (slow units get priority among waiters).
      battle.queue.splice(battle.queueIndex, 1);
      const mySpeed = unitSpeed(battle, unit);
      let insertAt = battle.queue.length;
      for (let i = battle.queueIndex; i < battle.queue.length; i++) {
        const other = battle.units.find((u) => u.id === battle.queue[i]);
        // Insert before other waiters that are faster.
        if (other && other.hasWaitedFlag && unitSpeed(battle, other) > mySpeed) { insertAt = i; break; }
      }
      unit.hasWaitedFlag = true;
      battle.queue.splice(insertAt, 0, unit.id);
      events.push({ type: 'wait', unitId: unit.id });
      // Do NOT advance queueIndex — the next unit slides into this position.
      return finish(battle, events);
    }
    case 'defend': {
      unit.defending = true;
      events.push({ type: 'defend', unitId: unit.id });
      break;
    }
    case 'shoot': {
      const target = battle.units.find((u) => u.id === action.targetId);
      // Reject illegal shots (bad target / can't shoot right now) without applying.
      if (!target || !target.alive || target.side === unit.side || !canShoot(battle, unit)) return events;
      if (ability(target, 'untargetable')) return events; // the Catapult cannot be shot
      const hasCart = sideHasAmmoCart(battle, unit.side); // Ammo Cart → unlimited shots
      if (!hasCart) unit.shots--;
      strike(battle, unit, target, 'ranged', events);
      // Magog splash: everything around the target hex burns.
      if (ability(unit, 'areaBlast')) {
        for (const [nx, ny] of hexNeighbors(target.x, target.y)) {
          const splash = unitAt(battle, nx, ny);
          if (splash && splash.id !== unit.id) {
            const { damage } = rollDamage(battle, unit, splash, 'ranged');
            const r = applyDamage(battle, splash, Math.round(damage * 0.5));
            events.push({
              type: 'splash', attackerId: unit.id, targetId: splash.id,
              damage: Math.round(damage * 0.5), kills: r.kills, died: r.died,
            });
          }
        }
      }
      // Marksman double shot — the Ammo Cart covers this bolt too. Without the
      // cart carve-out it read `unit.shots > 0` and decremented unconditionally,
      // so a cart-supplied Marksman silently lost its second shot once the base
      // ammo ran out (the cart is meant to grant UNLIMITED shots).
      if (ability(unit, 'shootsTwice') && (unit.shots > 0 || hasCart) && target.alive) {
        if (!hasCart) unit.shots--;
        strike(battle, unit, target, 'ranged', events);
      }
      break;
    }
    case 'attack': {
      const target = battle.units.find((u) => u.id === action.targetId);
      if (!target || !target.alive || target.side === unit.side) return events; // bad target: reject
      if (ability(target, 'untargetable')) return events; // the Catapult cannot be struck
      // Validate the (optional) approach BEFORE mutating, so an illegal attack
      // applies nothing (previously the approach move was committed even when the
      // final hex was non-adjacent). Reject-and-return; never throw.
      const moving = action.x !== undefined && (action.x !== unit.x || action.y !== unit.y);
      const fx = moving ? action.x : unit.x;
      const fy = moving ? action.y : unit.y;
      if (moving && !reachableHexes(battle, unit).some((h) => h.x === action.x && h.y === action.y)) return events;
      if (hexDistance(fx, fy, target.x, target.y) !== 1) return events; // must finish adjacent
      if (moving) {
        events.push({ type: 'move', unitId: unit.id, from: { x: unit.x, y: unit.y }, to: { x: action.x, y: action.y } });
        unit.x = action.x; unit.y = action.y;
        applyMoat(battle, unit, events); // charging through the moat can cost the stack dearly
        if (!unit.alive) break;          // the moat wiped the attacker before it could strike
      }

      // The strike itself breaks blindness, so remember the state beforehand.
      const targetWasBlinded = hasFlag(target, 'blinded');
      strike(battle, unit, target, 'melee', events);

      if (unit.alive && ability(unit, 'attacksAround')) {
        // Hydra: also strike every OTHER adjacent enemy — and NONE retaliate.
        for (const [nx, ny] of hexNeighbors(unit.x, unit.y)) {
          const other = unitAt(battle, nx, ny);
          if (other && other.alive && other.side !== unit.side && other.id !== target.id
              && !ability(other, 'untargetable')) {
            strike(battle, unit, other, 'melee', events);
          }
        }
      } else if (unit.alive && target.alive && !ability(unit, 'noEnemyRetaliation') && !targetWasBlinded &&
          (!target.retaliated || ability(target, 'unlimitedRetaliation'))) {
        // Retaliation (skipped if the fire shield just killed the attacker).
        target.retaliated = true;
        strike(battle, target, unit, 'retaliation', events);
      }
      // Crusader double strike (after retaliation, HoMM3 order).
      if (unit.alive && target.alive && ability(unit, 'doubleAttack')) {
        strike(battle, unit, target, 'melee', events);
      }
      break;
    }
    case 'resurrect': {
      // Archangel gift of life: heal a friendly stack 100 HP per archangel.
      // Reject illegal casts (no ability / already used / bad target) without applying.
      if (unit.resurrectUsed || !ability(unit, 'resurrectAllies')) return events;
      const target = battle.units.find((u) => u.id === action.targetId);
      if (!target || target.side !== unit.side || target.id === unit.id) return events;
      // One hex, one stack: a corpse whose hex a live stack has since claimed
      // cannot re-form there (same refusal castSpell makes for Resurrection) —
      // and it is refused BEFORE the once-per-battle flag burns on a no-op.
      if (!target.alive && unitAt(battle, target.x, target.y)) return events;
      unit.resurrectUsed = true;
      const healed = healUnit(battle, target, 100 * unit.count, true);
      events.push({ type: 'heal', sourceId: unit.id, targetId: target.id, healed: healed.hp, revived: healed.revived });
      break;
    }
    case 'firstAid': {
      // First Aid Tent: mend (never resurrect) one wounded friendly stack.
      // Reject illegal calls (wrong unit / bad target / a machine) without applying.
      if (unit.machine !== 'firstAidTent') return events;
      const target = battle.units.find((u) => u.id === action.targetId);
      if (!target || !target.alive || target.side !== unit.side || target.machine) return events;
      const healed = healUnit(battle, target, CONFIG.FIRST_AID_HEAL, false);
      events.push({ type: 'heal', sourceId: unit.id, targetId: target.id, healed: healed.hp, revived: 0 });
      break;
    }
    case 'batter': {
      // Catapult: knock a chunk out of a wall/gate segment. A segment at 0 HP is
      // a breach — it stops blocking (walkers pour through). Reject illegal calls
      // (wrong unit / already-fallen segment) without applying.
      if (unit.machine !== 'catapult' || !battle.walls) return events;
      const wall = battle.walls.find((w) => w.id === action.wallId && w.alive);
      if (!wall) return events;
      const dmg = battle.rng.int(CONFIG.SIEGE.catapultDamage[0], CONFIG.SIEGE.catapultDamage[1]);
      wall.hp -= dmg;
      const destroyed = wall.hp <= 0;
      if (destroyed) { wall.hp = 0; wall.alive = false; }
      events.push({ type: 'wallHit', unitId: unit.id, wallId: wall.id, x: wall.x, y: wall.y, kind: wall.kind, damage: dmg, destroyed });
      break;
    }
    default:
      break;
  }

  battle.queueIndex++;

  // Positive morale: a second wind (one per round, not for wait/defend). War
  // machines are mindless and never roll morale.
  if (unit.alive && !unit.machine && !unit.moraleUsed && ['move', 'attack', 'shoot'].includes(action.type) && !battle.over) {
    const m = sideMorale(battle, unit.side, unit);
    if (m > 0 && battle.rng.chance(m * CONFIG.MORALE_CHANCE_PER_POINT * stanceSwing(battle.sides[unit.side].stance))) {
      unit.moraleUsed = true;
      battle.queue.splice(battle.queueIndex, 0, unit.id);
      events.push({ type: 'morale', unitId: unit.id });
    }
  }

  return finish(battle, events);
}

/**
 * A stack raised from the DEAD is a re-formed body, not the one that fell:
 * death dispels its enchantments and clears its spent-this-round flags.
 * Without this, startRound's duration tick — which skips the dead — froze
 * every effect at the value it held at the moment of death, so a stack Slowed
 * in round 1 and resurrected in round 12 came back at speed 1 with the FULL
 * remaining duration (a zombie Prayer was just as wrong in the other
 * direction). Rejected alternative: ticking durations down on corpses instead
 * — that revives the stack still under whatever "remains" of a spell woven
 * into flesh that died, and it mutates every corpse every round for the sake
 * of the rare one that returns.
 *
 * The cohesion baseline (#11) is re-anchored to the revived number for the
 * same reason: measured against the pre-death roundStartCount, a stack raised
 * at a fraction of its old size looked freshly half-slaughtered and could
 * waver — an rng draw — the first time it was scratched.
 */
function reviveHygiene(unit) {
  unit.effects = [];
  unit.retaliated = false;
  unit.defending = false;
  unit.moraleUsed = false;
  unit.hasWaitedFlag = false;
  unit.wavered = false;
  unit.roundStartCount = unit.count;
  unit.breakCheckedThisRound = false;
}

/** Heal/resurrect a stack. Returns { hp healed, units revived }. */
function healUnit(battle, unit, amount, revive) {
  const wasDead = !unit.alive;
  // Belt and braces under castSpell/act's own target validation (they refuse
  // BEFORE charging mana or the Archangel's once-per-battle gift; this guard
  // keeps the STATE legal even for a caller that skipped them): a non-reviving
  // heal must never stand a corpse back up, and a corpse whose hex a live
  // stack has since claimed cannot re-form there (one hex, one stack).
  if (wasDead && (!revive || unitAt(battle, unit.x, unit.y))) return { hp: 0, revived: 0 };
  const before = (unit.count - 1) * unit.maxHp + unit.hp;
  const cap = unit.startCount * unit.maxHp;
  const current = wasDead ? 0 : before;
  const target = Math.min(cap, current + amount);
  if (!revive) {
    // Cure: cannot exceed current top-of-stack count. (The stack is alive
    // here — the guard above already returned for a corpse.)
    const capNoRevive = (unit.count - 1) * unit.maxHp + unit.maxHp;
    const t = Math.min(capNoRevive, current + amount);
    unit.hp = t - (unit.count - 1) * unit.maxHp;
    return { hp: t - current, revived: 0 };
  }
  if (target <= 0) return { hp: 0, revived: 0 };
  const newCount = Math.ceil(target / unit.maxHp);
  const revived = Math.max(0, newCount - (wasDead ? 0 : unit.count));
  unit.count = newCount;
  unit.hp = target - (newCount - 1) * unit.maxHp;
  unit.alive = true;
  if (wasDead) reviveHygiene(unit); // death dispelled what the old body carried
  // Revived creatures no longer count as casualties (XP bookkeeping),
  // whether the stack itself was dead or merely thinned.
  if (revived > 0) {
    battle.hpLost[unit.side] = Math.max(0, battle.hpLost[unit.side] - revived * unit.maxHp);
    battle.valueLost[unit.side] = Math.max(0, battle.valueLost[unit.side] - revived * unitValue(unit));
  }
  return { hp: target - current, revived };
}

/** Phoenixes rise from their own ashes once per battle: a stack that has just
 *  died reforms with a fraction of its starting number. Run before the
 *  battle-over check so a last-stand Phoenix can keep its side in the fight. */
function reviveRebirthers(battle, events) {
  for (const u of battle.units) {
    if (u.alive || u.rebirthUsed || !CREATURES[u.creature].abilities.includes('rebirth')) continue;
    // One hex, one stack — same refusal as every other revive path. Unreachable
    // from today's rules (rebirth fires in the same finish() as the death, and
    // nothing moves between a strike and its finish), so this guards against a
    // future death path re-forming a Phoenix under whoever stands on its ashes.
    // The rebirth is NOT consumed: the ashes wait, and rise once the hex frees.
    if (unitAt(battle, u.x, u.y)) continue;
    u.rebirthUsed = true;
    const back = Math.max(1, Math.ceil(u.startCount * (CREATURES[u.creature].rebirthFrac ?? 0.2)));
    u.count = back;
    u.hp = u.maxHp;
    u.alive = true;
    reviveHygiene(u); // the risen bird is new flesh — no leftover enchantments
    battle.hpLost[u.side] = Math.max(0, battle.hpLost[u.side] - back * u.maxHp);
    battle.valueLost[u.side] = Math.max(0, battle.valueLost[u.side] - back * unitValue(u));
    events.push({ type: 'rebirth', unitId: u.id, count: back });
  }
}

/**
 * Lizard Ghosts (opt-in): a wiped lizard stack MAY leave a shade on its own hex —
 * a chance event, so the marsh sometimes gives its dead back and sometimes does
 * not. One roll per stack per battle (`ghostRolled`), taken whether it succeeds or
 * not, and the shade itself carries no ghostRemnant ability, so nothing chains.
 * Runs before the battle-over check, like rebirth, so a last-stand shade can keep
 * its side in the fight. Draws from the seeded battle rng ONLY when the feature is
 * on and a qualifying stack has just fallen — Classic remains byte-identical.
 */
function spawnGhostRemnants(battle, events) {
  if (!battle.features?.lizardGhosts || !battle.rng) return;
  const gid = CONFIG.GHOST_REMNANT_CREATURE;
  const g = CREATURES[gid];
  if (!g) return;
  for (const u of [...battle.units]) {
    if (u.alive || u.ghostRolled) continue;
    if (!(CREATURES[u.creature]?.abilities || []).includes('ghostRemnant')) continue;
    u.ghostRolled = true;
    if (!battle.rng.chance(CONFIG.GHOST_REMNANT_CHANCE)) continue;
    const count = Math.max(1, Math.ceil(u.startCount * CONFIG.GHOST_REMNANT_FRACTION));
    const maxHp = g.health + battle.sides[u.side].creatureHealthBonus;
    battle.units.push({
      id: `${u.id}g`, side: u.side, creature: gid, ghost: true,
      count, startCount: count, hp: maxHp, maxHp, x: u.x, y: u.y,
      shots: g.shots || 0, retaliated: false, defending: false, moraleUsed: false,
      resurrectUsed: false, effects: [], alive: true,
      // The shade inherits the fallen stack's ORIGIN — the army slot it marched
      // out of. This matters far beyond the ghost itself: writeBackArmy's
      // slot-preserving path is all-or-nothing (`list.every(s => Number.isInteger
      // (s.origin))`), so ONE origin-less survivor used to throw the hero's
      // ENTIRE army into the pack-and-merge fallback — three deliberate archer
      // stacks came home as one because a shade rose. The dead lizard stack is
      // not among the survivors, so its slot is normally free for the shade;
      // if a deploy-split sibling still holds it, writeBackArmy's leftover()
      // reroutes the shade rather than losing it. (Rejected: leaving origin off
      // and special-casing ghosts in writeBackArmy — the write-back deliberately
      // knows nothing about individual creatures, and every other unit path
      // already carries origin through the battle untouched.)
      origin: u.origin,
    });
    events.push({ type: 'ghostRise', unitId: `${u.id}g`, fromId: u.id, count });
  }
}

function finish(battle, events) {
  reviveRebirthers(battle, events);
  spawnGhostRemnants(battle, events);
  // Battle over? A side is defeated when it has no COMBATANTS left — war machines
  // (noncombatant) never keep a side "alive", so a lone Ballista/Tent/Cart can't
  // soft-lock the battle after the real army is gone.
  const alive0 = battle.units.some((u) => u.side === 0 && combatant(u));
  const alive1 = battle.units.some((u) => u.side === 1 && combatant(u));
  if (!alive0 || !alive1) {
    battle.over = true;
    // Mutual annihilation (fire shield / Armageddon can wipe both sides at once):
    // resolve a deterministic draw in the defender's favour so `winner` is never
    // ambiguous. `alive0 ? 0 : 1` already yields 1 (defender) when both sides fell.
    battle.winner = alive0 ? 0 : 1;
    events.push({ type: 'end', winner: battle.winner });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

export function canCast(battle, side, spellId) {
  const s = battle.sides[side];
  const spell = SPELLS[spellId];
  if (battle.over || !s.hero || s.castThisRound || !spell) return false;
  // Adventure-book spells (Town Portal, Fly, …) never fire in combat — enforced
  // here in the engine, not just by the UI's spellbook filter, so no caller can
  // burn mana + the round's cast on a spell with no combat effect.
  if (spell.adventure) return false;
  if (!s.hero.spells.includes(spellId)) return false;
  // The MASTERED price, never the catalog one — canCast and castSpell must agree
  // with the spellbook the player read (see src/core/magic.js).
  return s.hero.mana >= spellCost(s.hero, spellId);
}

/**
 * Every stack a mass cast lands on: the caster's own side for a buff or a heal,
 * the enemy line for a hex. Alive only, and never the untargetable Catapult —
 * exactly the set a hero could have picked from one at a time.
 */
export function massCastTargets(battle, side, spellId) {
  const wantEnemy = massSide(spellId) === 'enemy';
  return battle.units.filter((u) => u.alive
    && (u.side === side) !== wantEnemy
    && !ability(u, 'untargetable'));
}

/**
 * Cast a hero spell. target: { unitId } or { x, y } for area spells.
 * Returns events (empty if the cast was illegal).
 */
export function castSpell(battle, side, spellId, target) {
  const events = [];
  if (!canCast(battle, side, spellId)) return events;
  const spell = SPELLS[spellId];
  const s = battle.sides[side];
  const hero = s.hero;

  // Validate the target BEFORE any mutation — the same reject-without-applying
  // contract act() follows. A hostile buff/heal or a friendly debuff/nuke is
  // refused outright: no mana spent, the round's cast not consumed (so a
  // misclick can't blind your own shooters for 10 mana). The find() runs over
  // ALL units (dead included) so Resurrection can target a fallen friendly
  // stack; hitsAll casts carry no unitId.
  // A mass cast (Expert Air Haste, Expert Earth Slow…) picks its own targets —
  // the whole friendly line or the whole enemy line — so no target is required
  // and a supplied one is ignored rather than validated. See src/core/magic.js.
  const mass = isMassCast(hero, spellId);
  const targetUnit = (!mass && target?.unitId) ? battle.units.find((u) => u.id === target.unitId) : null;
  if (!mass && target?.unitId && !targetUnit) return events; // unknown target id
  if (targetUnit && ability(targetUnit, 'untargetable')) return events; // the Catapult: no spells either
  if (targetUnit) {
    const friendly = targetUnit.side === side;
    if ((spell.kind === 'buff' || spell.kind === 'heal') && !friendly) return events;
    if ((spell.kind === 'debuff' || spell.kind === 'damage') && friendly) return events;
    if (!targetUnit.alive) {
      // A DEAD target is legal for exactly one thing: a spell that revives.
      // Refused HERE, not left to healUnit's arithmetic, because healUnit's
      // no-revive clamp keys on `unit.alive` — aim Cure at a corpse and it
      // would fall through into the full resurrection path, standing the stack
      // back up against its own "cannot revive the dead" description. Today's
      // callers never do this (the UI resolves non-revive targets via the
      // alive-only unitAt, and the AI pools exclude corpses), but this is the
      // documented enforcement point precisely so a future caller cannot.
      if (!spell.revives) return events;
      // ONE HEX, ONE STACK: nothing stops a live stack from walking onto a
      // corpse's hex (unitAt and reachableHexes are alive-only), so the hex a
      // revive would re-form on may no longer be free. Raising it anyway put
      // two live stacks on one hex — the buried one untargetable, immune to
      // splash, invisible to movement, yet still attacking. Refuse the cast,
      // mana unspent: the same rule the targeting UI already shows the player
      // (CombatScene.deadTargetAt and the revive-highlight loop both skip an
      // occupied corpse hex). Rejected alternative: relocating the revived
      // stack to the nearest free hex — that invents a placement policy the
      // caster never chose, needs its own deterministic search order plus a
      // no-free-hex fallback, and contradicts the UI's promise that a corpse
      // is raised where it fell.
      if (unitAt(battle, targetUnit.x, targetUnit.y)) return events;
    }
  } else if (!mass && (spell.kind !== 'damage' || !spell.hitsAll)) {
    // Every other cast is unit-targeted in this engine (area spells splash
    // around a target STACK) — a missing/absent target is a refused cast, not
    // a paid no-op.
    return events;
  }
  // A mass cast with nobody left to touch is refused rather than paid for.
  const massUnits = mass ? massCastTargets(battle, side, spellId) : [];
  if (mass && !massUnits.length) return events;

  // The MASTERED price (school discount), which is also what canCast checked and
  // what the spellbook quoted.
  const cost = spellCost(hero, spellId);
  hero.mana -= cost;
  s.castThisRound = true;

  // Imps siphon a fifth of the mana spent by the enemy hero.
  const enemySide = battle.sides[1 - side];
  if (enemySide.hero &&
      battle.units.some((u) => u.alive && u.side === 1 - side && ability(u, 'manaThief'))) {
    const stolen = Math.floor(cost * 0.2);
    if (stolen > 0) {
      // Clamp to the thief-hero's max mana: the siphon must not overfill the pool
      // past its ceiling. Report the ACTUAL gain (0 when already full).
      const before = enemySide.hero.mana;
      enemySide.hero.mana = Math.min(heroMaxMana(enemySide.hero), before + stolen);
      const gained = enemySide.hero.mana - before;
      if (gained > 0) events.push({ type: 'manaSteal', side: 1 - side, amount: gained });
    }
  }

  const power = heroStat(hero, 'power');
  const sorcery = 1 + skillValue(hero, 'sorcery');
  // Magic-school mastery: strengthens this spell's school. `schoolFrac` boosts
  // damage/healing (like sorcery, but school-specific). Duration is no longer a
  // flat "+1 round per level" — each spell carries its own ladder now, so a
  // lockout does not lengthen at the same rate as a cheap stat buff (see
  // magic.durationAtLevel and spell.durationByLevel).
  const schoolSkill = SCHOOL_SKILL[spell.school];
  const schoolFrac = schoolSkill ? skillValue(hero, schoolSkill) : 0;

  const dealSpellDamage = (unit, amount) => {
    if (!unit.alive) return;
    // Black Dragons shrug off all magic — no damage lands (nor any hit event).
    // The untargetable Catapult is likewise beyond every spell's reach.
    if (ability(unit, 'spellImmune') || ability(unit, 'untargetable')) return;
    let dmg = Math.round(amount * sorcery * (1 + schoolFrac));
    if (ability(unit, 'spellResist50')) dmg = Math.round(dmg * 0.5);
    const r = applyDamage(battle, unit, dmg);
    // casterSide lets the debrief attribute spell damage/kills to the hero that
    // cast it (units carry attackerId; a hero is not a battlefield unit).
    events.push({ type: 'spellHit', spellId, casterSide: side, targetId: unit.id, damage: dmg, kills: r.kills, died: r.died });
  };

  switch (spell.kind) {
    case 'damage': {
      const base = spell.base + spell.perPower * power;
      if (spell.hitsAll) {
        for (const u of battle.units.filter((x) => x.alive)) dealSpellDamage(u, base);
      } else if (spell.area && targetUnit) {
        dealSpellDamage(targetUnit, base);
        for (const [nx, ny] of hexNeighbors(targetUnit.x, targetUnit.y)) {
          const u = unitAt(battle, nx, ny);
          if (u) dealSpellDamage(u, base);
        }
      } else if (spell.chain && targetUnit) {
        let amount = base;
        const hit = new Set();
        let current = targetUnit;
        for (let i = 0; i <= spell.chain && current; i++) {
          dealSpellDamage(current, amount);
          hit.add(current.id);
          amount /= 2;
          let best = null, bestD = Infinity;
          for (const u of battle.units) {
            if (!u.alive || hit.has(u.id)) continue;
            const d = hexDistance(current.x, current.y, u.x, u.y);
            if (d < bestD) { bestD = d; best = u; }
          }
          current = best;
        }
      } else if (targetUnit) {
        dealSpellDamage(targetUnit, base);
      }
      break;
    }
    case 'buff':
    case 'debuff': {
      // The magnitude THIS hero's mastery produces — Advanced Air Haste is +5,
      // not +3 (see spell.byLevel). Resolved once and STORED on each stack, so
      // an effect keeps the numbers it was cast with.
      const efx = spellEffects(hero, spellId);
      // One stack's worth of enchantment. Extracted so a mass cast applies the
      // IDENTICAL rules — immunity, the morale-only fizzle, the replace-in-place
      // and the duration arithmetic — seven times over rather than a second copy
      // of them drifting out of step with this one.
      const enchant = (unit) => {
        // Spell-immune stacks (Black Dragons) cannot be enchanted or hexed at all.
        if (ability(unit, 'spellImmune')) {
          events.push({ type: 'spellFizzle', spellId, casterSide: side, targetId: unit.id });
          return;
        }
        // Morale means nothing to the undead / mindless (sideMorale locks them to
        // 0). A morale-ONLY buff/hex — Mirth, Sorrow — would pin a do-nothing icon
        // on such a stack, so fizzle it instead (Sorrow on Dread Knights, etc.).
        const moraleOnly = efx.morale !== undefined && Object.keys(efx).every((k) => k === 'morale');
        const tc = CREATURES[unit.creature];
        if (moraleOnly && tc && (tc.undead || tc.mindless)) {
          events.push({ type: 'spellFizzle', spellId, casterSide: side, targetId: unit.id });
          return;
        }
        // Replace an existing copy of the same spell.
        unit.effects = unit.effects.filter((e) => e.spellId !== spellId);
        unit.effects.push({
          spellId,
          effects: { ...efx },   // its own copy: a sweep must not alias one object across seven stacks
          // Power extends the mastered base duration, but bounded (config) so a
          // high-Power hero can't lock a stack out for the whole battle.
          rounds: spellDuration(hero, spellId)
            + Math.min(CONFIG.SPELL_DURATION_POWER_CAP, Math.floor(power / CONFIG.SPELL_DURATION_POWER_DIV)),
        });
        events.push({ type: 'spellEffect', spellId, casterSide: side, targetId: unit.id, hostile: spell.kind === 'debuff', mass });
      };
      if (mass) for (const u of massUnits) enchant(u);
      else if (targetUnit) enchant(targetUnit);
      break;
    }
    case 'heal': {
      // Sorcery is "+% spell DAMAGE" — it must not amplify healing. But the
      // spell's OWN school (Water Magic → Cure/Resurrection) does strengthen it.
      const amount = Math.round((spell.base + spell.perPower * power) * (1 + schoolFrac));
      const mend = (unit) => {
        // Immune to all magic — healing/resurrection can't touch them either.
        if (ability(unit, 'spellImmune')) {
          events.push({ type: 'spellFizzle', spellId, casterSide: side, targetId: unit.id });
          return;
        }
        const healed = healUnit(battle, unit, amount, !!spell.revives);
        if (spell.cleanse) {
          unit.effects = unit.effects.filter((e) => SPELLS[e.spellId]?.kind !== 'debuff');
        }
        events.push({ type: 'heal', spellId, casterSide: side, targetId: unit.id, healed: healed.hp, revived: healed.revived, mass });
      };
      if (mass) for (const u of massUnits) mend(u);
      else if (targetUnit) mend(targetUnit);
      break;
    }
    default:
      break;
  }

  return finish(battle, events);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * End the battle because `side` (0 = attacker, 1 = defender) fled — retreat or
 * surrender. The fleeing side is marked the loser (so battleResult hands XP to
 * the victor for what it actually killed), but the MAP layer spares the fleeing
 * hero instead of destroying it (see actions.applyCombatResult → applyEscape).
 * `mode` is 'retreat' (army lost, free) or 'surrender' (army kept, `goldPaid`).
 */
export function escapeBattle(battle, side, mode, goldPaid = 0) {
  if (battle.over) return;
  battle.over = true;
  battle.winner = side === 0 ? 1 : 0;
  battle.escape = { side, mode, goldPaid };
}

/** Extract the survivors + XP once battle.over is true (see actions.applyCombatResult). */
export function battleResult(battle) {
  // War machines are not part of the army carried off the field — the hero keeps
  // them permanently (hero.warMachines), so they never appear among survivors.
  const survivors = (side) => battle.units
    .filter((u) => u.side === side && u.alive && u.count > 0 && !u.machine)
    .map((u) => ({ creature: u.creature, count: u.count, hurt: 0, origin: u.origin, retinue: u.retinue }));
  // A FLAWLESS victory — the winner did not lose a single creature — pays a
  // CONFIG.FLAWLESS_XP_BONUS premium on top of the normal experience. It rewards
  // the thing that actually takes skill: not just winning, but winning without
  // spending your army. Computed here so every path (interactive, quick-resolve,
  // auto-resolved AI battle) awards it identically — `xp` already includes it.
  // War machines are excluded: the hero keeps them regardless, so a battered
  // Catapult is not a casualty.
  const won = battle.winner;
  const flawless = (won === 0 || won === 1) && battle.units
    .filter((u) => u.side === won && !u.machine)
    .every((u) => u.alive && u.count >= u.startCount);
  // Experience is the VALUE of what you killed, not its hit points. HP made a
  // heavy battle worth about a eighteenth of what it should be — the roster's
  // value-to-HP ratio averages x17.8 — so a hero that should have gained a dozen
  // levels gained one. Value is also what the two OTHER experience paths in this
  // game already pay in (a caravan raid, an artifact trade), so this makes the
  // main path agree with them. See docs/GAME_RULES.md.
  const baseXp = battle.valueLost[won === 0 ? 1 : 0];
  // What the LOSER takes away. A defeat teaches in proportion to what it cost the
  // victor — `valueLost[won]` is exactly the value the loser destroyed before it
  // fell, the mirror of the line above, and it is already resurrection-aware.
  //
  // It cannot invert the incentive to win. Winning the same fight pays the enemy's
  // WHOLE army (they were annihilated); losing pays a share of the part of theirs
  // you took with you, which is strictly less. So throwing a fight is never worth
  // more than taking it. What it does do is make a NARROW defeat against a mighty
  // foe worth more than an EASY win over a weak one — which is the claim "a defeat
  // teaches more than a win" actually cashes out to, and it is true here without
  // anyone having to pretend losing is good.
  //
  // A flawless victory pays the loser zero: destroy nothing, learn nothing. The
  // flawless PREMIUM is deliberately not mirrored — it rewards the winner's skill.
  const defeatXp = Math.round(battle.valueLost[won] * CONFIG.DEFEAT_XP_SHARE);
  return {
    attackerWon: battle.winner === 0,
    attackerArmy: survivors(0),
    defenderArmy: survivors(1),
    xp: flawless ? Math.round(baseXp * (1 + CONFIG.FLAWLESS_XP_BONUS)) : baseXp,
    baseXp,
    defeatXp,
    flawless,
    escape: battle.escape || null,
    // The rng state this fight started from (see createBattle). Carried on the
    // RESULT because that is what every path hands to applyCombatResult — the one
    // choke point that writes the chronicle — so the seed reaches the log without
    // threading the battle object through three callers.
    seed: battle.seed || null,
  };
}
