/**
 * data-integrity.test.js — Cross-reference integrity of the content data.
 *
 * The catalogs in src/data are pure data authored by hand, so the failure mode
 * is a typo: a hero recruiting a creature id that no longer exists, an upgrade
 * pointing at a renamed base, a dwelling wired to the wrong tier, or a glyph
 * key with no painter. Nothing catches those at import time — the game just
 * renders a fallback or throws deep in a screen. This suite is the guardrail:
 * it walks every reference in the CURRENT data and asserts it resolves.
 *
 * Pure data — no Phaser, no engine. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CREATURES, creaturesOfTier } from '../src/data/creatures.js';
import { deriveFrom, DERIVED_KEYS } from '../scripts/data/derive-physical.mjs';
import { ARTIFACTS } from '../src/data/artifacts.js';
import { HERO_ROSTER } from '../src/data/heroes.js';
import { SKILLS } from '../src/data/skills.js';
import { SPELLS } from '../src/data/spells.js';
import { DWELLINGS, buildingCatalog } from '../src/data/buildings.js';
import { FACTIONS } from '../src/data/factions.js';
import { GLYPHS } from '../src/gfx/glyphs.js';

// ---------------------------------------------------------------------------

test('data: every hero references creatures/spells/skills that exist', () => {
  for (const [hid, hero] of Object.entries(HERO_ROSTER)) {
    // Starting army rows are [creatureId, min, max].
    for (const [cid] of hero.army) {
      assert.ok(CREATURES[cid], `hero ${hid} recruits missing creature "${cid}"`);
    }
    for (const spellId of hero.spells) {
      assert.ok(SPELLS[spellId], `hero ${hid} starts with missing spell "${spellId}"`);
    }
    for (const skillId of Object.keys(hero.skills)) {
      assert.ok(SKILLS[skillId], `hero ${hid} has missing skill "${skillId}"`);
    }
    // A hero's class and faction should also resolve (cheap to check here).
    assert.ok(FACTIONS[hero.faction], `hero ${hid} has unknown faction "${hero.faction}"`);
  }
});

test('data: every creature.upgradeOf points to a real base of the same faction/tier', () => {
  for (const [cid, c] of Object.entries(CREATURES)) {
    if (!c.upgradeOf) continue;
    const base = CREATURES[c.upgradeOf];
    assert.ok(base, `creature ${cid} upgrades from missing creature "${c.upgradeOf}"`);
    // An upgrade must share the dwelling slot it grows out of.
    assert.equal(base.faction, c.faction, `${cid} upgradeOf crosses faction`);
    assert.equal(base.tier, c.tier, `${cid} upgradeOf crosses tier`);
    assert.equal(base.upgraded, false, `${cid} upgradeOf targets another upgrade, not a base`);
    // The upgrade side of the link must actually be flagged as one.
    assert.equal(c.upgraded, true, `${cid} has upgradeOf but is not flagged upgraded`);
    // An upgrade is strictly better, so it must never cost LESS gold than its base
    // (the Pixie→Sprite inversion, item E41). A negative price difference would
    // also make the Hill Fort upgrade nonsensical.
    assert.ok((c.cost?.gold || 0) >= (base.cost?.gold || 0),
      `${cid} (${c.cost?.gold}g) costs less than its base ${c.upgradeOf} (${base.cost?.gold}g)`);
  }
});

test('data: every dwelling maps to a creature of the matching tier (both directions)', () => {
  // Forward: each dwelling's tier resolves to a base creature, and an upgraded
  // dwelling resolves to an upgraded creature.
  for (const [faction, dwellings] of Object.entries(DWELLINGS)) {
    for (const [did, d] of Object.entries(dwellings)) {
      if (d.dwellingTier == null) continue; // support buildings (e.g. stables)
      const { base, upgraded } = creaturesOfTier(faction, d.dwellingTier);
      if (d.dwellingUpgrade) {
        assert.ok(upgraded, `${faction}.${did} recruits tier ${d.dwellingTier} but no upgraded creature exists`);
      } else {
        assert.ok(base, `${faction}.${did} recruits tier ${d.dwellingTier} but no base creature exists`);
      }
    }
  }

  // Reverse: every town (non-neutral) creature has a dwelling that recruits it,
  // matched on tier and the base/upgrade flag — so no creature is unbuildable.
  for (const [cid, c] of Object.entries(CREATURES)) {
    if (!FACTIONS[c.faction]) continue; // neutrals are map guards, not recruited
    // Non-recruitable creatures are exempt: no growth AND no price means nothing
    // can ever buy one, so demanding a dwelling for it is meaningless. This is how
    // battlefield remnants (the Lizard Ghost, which only ever rises from a slain
    // lizard stack) belong to a faction without being buildable.
    if (!c.growth && !Object.keys(c.cost || {}).length) continue;
    const dwellings = DWELLINGS[c.faction] || {};
    const match = Object.values(dwellings).find(
      (d) => d.dwellingTier === c.tier && Boolean(d.dwellingUpgrade) === Boolean(c.upgraded),
    );
    assert.ok(match, `creature ${cid} (${c.faction} tier ${c.tier}, upgraded=${!!c.upgraded}) has no dwelling`);
  }
});

test('data: every building requires an existing building, and each faction tree is fully buildable (F53)', () => {
  // buildBlockReason gates a build ONLY on b.requires, so a topological walk over
  // `requires` mirrors the engine exactly: one typo'd id (or a cycle) would leave
  // a dwelling permanently unbuildable — this fails loudly instead.
  for (const factionId of Object.keys(FACTIONS)) {
    const catalog = buildingCatalog(factionId);
    for (const [bid, b] of Object.entries(catalog)) {
      for (const req of b.requires || []) {
        assert.ok(catalog[req], `${factionId}.${bid} requires missing building "${req}"`);
      }
    }
    // Build anything whose requires are all satisfied, repeatedly; the whole tree
    // must eventually be reachable (no cycle, no dead-end prereq).
    const built = new Set();
    for (let progress = true; progress;) {
      progress = false;
      for (const [bid, b] of Object.entries(catalog)) {
        if (built.has(bid)) continue;
        if ((b.requires || []).every((r) => built.has(r))) { built.add(bid); progress = true; }
      }
    }
    const unbuildable = Object.keys(catalog).filter((b) => !built.has(b));
    assert.equal(unbuildable.length, 0, `${factionId}: unbuildable buildings — ${unbuildable.join(', ')}`);
  }
});

test('data: every glyph named by a creature or artifact has a painter in GLYPHS', () => {
  for (const [cid, c] of Object.entries(CREATURES)) {
    assert.ok(GLYPHS[c.glyph], `creature ${cid} names missing glyph "${c.glyph}"`);
  }
  for (const [aid, a] of Object.entries(ARTIFACTS)) {
    assert.ok(GLYPHS[a.glyph], `artifact ${aid} names missing glyph "${a.glyph}"`);
  }
});

// The complete set of ability ids the combat engine handles. A typo in a
// creature's abilities list (e.g. 'shootsTwic') otherwise silently does nothing;
// this fails loudly. Keep in sync with the creatures.js header and the engine's
// ability() checks when adding a new ability.
const KNOWN_ABILITIES = new Set([
  'ghostRemnant', // a wiped stack MAY leave a shade (CombatEngine.spawnGhostRemnants)
  'areaBlast', 'attacksAround', 'curseAura', 'doubleAttack', 'fireShield',
  'ignoreDefense', 'lifeDrain', 'manaThief', 'moraleAura', 'noEnemyRetaliation',
  'noMeleePenalty', 'rebirth', 'regenerate', 'resurrectAllies', 'shootsTwice',
  'spellImmune', 'spellResist50', 'teleport', 'unlimitedRetaliation', 'untargetable',
]);

test('data: the grand-prize (top value) artifact band has variety (E40)', () => {
  const maxValue = Math.max(...Object.values(ARTIFACTS).map((a) => a.value));
  const grand = Object.values(ARTIFACTS).filter((a) => a.value === maxValue);
  assert.ok(grand.length >= 2,
    `only ${grand.length} artifact(s) in the top value band ${maxValue} — every map's jackpot would be identical`);
  // …and they should not all buff the same primary stat.
  const stats = new Set(grand.flatMap((a) => Object.keys(a.effects)));
  assert.ok(stats.size >= 2, 'the grand-prize band should span more than one stat');
});

test('data: every creature ability id is a known, handled ability (no typos)', () => {
  for (const [cid, c] of Object.entries(CREATURES)) {
    for (const ab of c.abilities || []) {
      assert.ok(KNOWN_ABILITIES.has(ab), `creature ${cid} lists unknown ability "${ab}"`);
    }
  }
});

test('data: every whitelisted ability is used by at least one creature (no dead entries)', () => {
  const used = new Set();
  for (const c of Object.values(CREATURES)) for (const ab of c.abilities || []) used.add(ab);
  for (const ab of KNOWN_ABILITIES) {
    assert.ok(used.has(ab), `ability "${ab}" is whitelisted but no creature uses it — stale entry?`);
  }
});

// ---------------------------------------------------------------------------
// Physical parameters (the optional `phys` block)
// ---------------------------------------------------------------------------
//
// These numbers are in SI units, which sounds like it makes them self-checking
// and does the opposite: `blowMass_kg: 45` reads perfectly well and is a 45 kg
// arrow. A game integer that is wrong looks wrong; a physical quantity that is
// wrong by three orders of magnitude looks like a physical quantity. So the
// guardrail here is the same one the ability whitelist provides — a table of
// what each field may legally BE — plus a set of coherence checks that catch
// the errors a range cannot: an upgrade authored weaker than its base, a
// silhouette smaller than the arrowhead aimed at it, and a physical envelope
// that has quietly drifted away from the damage tuple it is meant to reproduce.

// [min, max] inclusive, with the unit. Bands are deliberately generous — they
// exist to catch a slipped decimal point, not to enforce a balance opinion.
const PHYS_RANGE = {
  blowMass_kg: [0.001, 500, 'kg'],          // a dart … a giant's club
  blowEnergy_j: [1, 1e6, 'J'],              // energy PUT INTO one blow — the authored dial
  blowSpeed_mps: [1, 200, 'm/s'],            // DERIVED: v = sqrt(2E/m), a consequence of the two above
  contactArea_m2: [1e-6, 0.5, 'm²'],        // a needle point … a titan's fist
  dispersion_rad: [0, 0.3, 'rad'],           // 0 = melee (it connects) … 17° of spray
  ballisticCoeff_kgpm2: [1, 5000, 'kg/m²'],    // sectional density_kgpm3 of the projectile
  bodyMass_kg: [0.5, 20000, 'kg'],          // a sprite … a dragon
  density_kgpm3: [200, 8000, 'kg/m³'],         // gas-filled … solid iron
  armorHardness_gpa: [0.001, 2, 'GPa'],      // bare hide … hardened plate
  armorHardness_pa: [1e6, 2e9, 'Pa'],        // DERIVED: the same figure in SI
  armorCoverage_frac: [0, 1, '—'],
  woundEnergy_j: [5, 2e6, 'J'],            // energy to put ONE creature down
  frontalArea_m2: [1e-3, 60, 'm²'],
  velRetainPerHex_ratio: [0.5, 1, '—'],
  bodyDepth_m: [0.05, 5, 'm'],              // DERIVED: K·V^(1/3), the depth a wound saturates at
};

// OPTIONAL fields, and the distinction is load-bearing rather than tidiness. Every key in
// PHYS_RANGE must be present on every block, because a partial block yields NaN damage
// instead of a fallback. These are different: their ABSENCE is meaningful and is the
// common case, so requiring them would be requiring every creature to declare that it is
// made of meat. They still get a range, because a slipped decimal is a slipped decimal.
//
// `bleeds` carries no range because it is a boolean — the width term's mechanism is
// haemorrhage, and a dendroid is a tree.
const PHYS_OPTIONAL = {
  tissueStrength_pa: [1e6, 1e9, 'Pa'],      // authored only where the body is not flesh
  headLength_m: [0.005, 0.5, 'm'],
  headWidth_m: [0.001, 0.1, 'm'],       // the CUT width, not recoverable from headMaxArea_m2
  headMaxArea_m2: [1e-6, 1e-3, 'm²'],   // the maximum SECTION — a different part of the head
  shaftArea_m2: [1e-6, 1e-3, 'm²'],
  bleeds: null,
};

/**
 * Kinetic energy of one blow, in joules. Read, not computed: energy is the
 * authored quantity now and velocity is what falls out of it (v = sqrt(2E/m)),
 * so recomputing ½mv² here would be checking the derivation against itself.
 */
const blowEnergy = (p) => p.blowEnergy_j;

const withPhys = () => Object.entries(CREATURES).filter(([, c]) => c.phys);

test('data: physical coverage is non-empty (the phys checks are not vacuous)', () => {
  // Every check below iterates the covered set. Renaming the block, or dropping
  // it in a refactor, would turn all of them into silent no-ops that still pass.
  assert.ok(withPhys().length > 0, 'no creature carries a `phys` block — did the field get renamed?');
});

test('data: every physical field is a known key, finite, and inside its documented range', () => {
  for (const [cid, c] of withPhys()) {
    for (const [k, v] of Object.entries(c.phys)) {
      assert.ok(k in PHYS_RANGE || k in PHYS_OPTIONAL, `creature ${cid} has unknown physical field "${k}"`);
      const band = PHYS_RANGE[k] ?? PHYS_OPTIONAL[k];
      if (band === null) { assert.equal(typeof v, 'boolean', `${cid}.phys.${k} must be a boolean`); continue; }
      const [lo, hi, unit] = band;
      assert.ok(Number.isFinite(v), `${cid}.phys.${k} is not a finite number (${v})`);
      assert.ok(v >= lo && v <= hi, `${cid}.phys.${k} = ${v} ${unit} is outside [${lo}, ${hi}]`);
    }
    // A partially authored block is worse than none: the model would read
    // `undefined` and produce NaN damage rather than fall back.
    for (const k of Object.keys(PHYS_RANGE)) {
      assert.ok(k in c.phys, `${cid}.phys is missing "${k}" — a partial block yields NaN, not a fallback`);
    }
  }
});

test('data: derived physical quantities match a fresh derivation (the script is the only author)', () => {
  // The fractional exponents are evaluated offline (see the script's header) and
  // committed as literals, which means nothing MAKES anyone re-run it after
  // editing an authored field. This does.
  for (const [cid, c] of withPhys()) {
    const want = deriveFrom(c.phys);
    for (const k of DERIVED_KEYS) {
      assert.equal(c.phys[k], want[k],
        `${cid}.phys.${k} is stale (${c.phys[k]} vs ${want[k]}) — run: node scripts/data/derive-physical.mjs`);
    }
  }
});

test('data: physical parameters are internally coherent', () => {
  for (const [cid, c] of withPhys()) {
    const p = c.phys;
    assert.ok(p.blowMass_kg < p.bodyMass_kg,
      `${cid}: the blow (${p.blowMass_kg} kg) outweighs the creature throwing it (${p.bodyMass_kg} kg)`);
    assert.ok(p.contactArea_m2 < p.frontalArea_m2,
      `${cid}: contact area ${p.contactArea_m2} m² exceeds the silhouette ${p.frontalArea_m2} m² it lands on`);
    // Dispersion is a shot group. A melee blow does not have one, and a shooter
    // with none never misses at any range — both are authoring slips.
    if (c.reach === 'ranged') {
      assert.ok(p.dispersion_rad > 0, `${cid} shoots but has zero dispersion_rad — it would never miss`);
    } else {
      assert.equal(p.dispersion_rad, 0, `${cid} is ${c.reach}, so its blow has no shot group`);
    }
  }
});

test('data: the physical envelope agrees with the damage tuple it replaces (within 2x)', () => {
  // The point of physical authoring is a different MODEL, not a different game.
  // One creature shooting itself, bare — no armour, no dispersion_rad, no hero — is
  // the one comparison both models can make, and it is where a slipped decimal
  // shows up as a stack that evaporates in one volley.
  for (const [cid, c] of withPhys()) {
    const classic = (c.damage[0] + c.damage[1]) / 2;              // HP per creature per blow
    const physical = (blowEnergy(c.phys) / c.phys.woundEnergy_j) * c.health;
    // Tightened from 2.5x once a whole faction was authored: the first Castle
    // pass used most of the old headroom at tiers 6-7 (champion 2.16x, archangel
    // 2.09x) and it showed up in the sweep as an authored faction crushing an
    // un-authored one — a migration artefact, not a model result. Re-authored to
    // 0.92-1.40x across all fourteen, and the band now holds that.
    const ratio = physical / classic;
    assert.ok(ratio >= 0.5 && ratio <= 2.0,
      `${cid}: physical bare damage ${physical.toFixed(2)} HP vs classic ${classic} HP — ${ratio.toFixed(2)}x apart`);
  }
});

test('data: an upgraded creature is not physically weaker than its base', () => {
  // The classic stats already have this guarded by price (an upgrade may not
  // cost less). Physics needs its own version, because "upgrade" here means a
  // heavier bolt, a narrower head or a tighter group — and any of the three can
  // be typed in the wrong direction without the number looking wrong.
  for (const [cid, c] of withPhys()) {
    const base = c.upgradeOf && CREATURES[c.upgradeOf];
    if (!base?.phys) continue;
    assert.ok(blowEnergy(c.phys) >= blowEnergy(base.phys),
      `${cid} lands less energy than ${c.upgradeOf} (${blowEnergy(c.phys).toFixed(1)} J vs ${blowEnergy(base.phys).toFixed(1)} J)`);
    assert.ok(c.phys.armorHardness_gpa * c.phys.armorCoverage_frac >= base.phys.armorHardness_gpa * base.phys.armorCoverage_frac,
      `${cid} is worse protected than ${c.upgradeOf}`);
    // A TIGHTER GROUP ONLY MEANS SOMETHING IF THE BASE HAD ONE. Written when
    // Tower brought the first two pairs whose upgrade GAINS a ranged attack —
    // Servitor → Master Servitor and Giant → Titan. The base is melee, so its
    // dispersion is 0 by the coherence rule above, and "the upgrade's group must
    // be no wider than its base's" then demands a group narrower than nothing:
    // unsatisfiable for any creature that starts shooting. The rule was authored
    // against a roster where every pair shot or neither did, and it says what it
    // meant, not what it happens to compare.
    //
    // So the clause is scoped to pairs that both shoot. Gaining a ranged attack
    // is checked as what it is — a gain — rather than waved through: the upgrade
    // must actually have a shot group, which the coherence rule already demands,
    // and nothing here may read it as a regression.
    const baseShoots = CREATURES[c.upgradeOf].reach === 'ranged';
    if (baseShoots) {
      assert.ok(c.phys.dispersion_rad <= base.phys.dispersion_rad,
        `${cid} shoots a looser group than ${c.upgradeOf} (${c.phys.dispersion_rad} vs ${base.phys.dispersion_rad} rad)`);
    } else if (c.reach === 'ranged') {
      assert.ok(c.phys.dispersion_rad > 0,
        `${cid} gains a ranged attack over ${c.upgradeOf} but has no shot group`);
    }
    // Toughness per hit point must stay in step across the pair, or the same
    // arrow would take a wildly different number of shots to kill two creatures
    // the classic model rates identically.
    const jPerHp = (x) => x.phys.woundEnergy_j / x.health;
    const drift = Math.abs(jPerHp(c) - jPerHp(base)) / jPerHp(base);
    assert.ok(drift <= 0.25,
      `${cid} is ${(drift * 100).toFixed(0)}% off ${c.upgradeOf} in J per hit point — the pair should be made of the same stuff`);
  }
});


test('artifacts: no two share a display name', () => {
  // `value` is a rarity band, not a price, and two artifacts in DIFFERENT bands
  // once shared the name "Crown of the Supreme Magi" — one +4 Knowledge at value
  // 2, one +5 at value 4, both head slot. A chest could hand you either and the
  // paper doll showed no way to tell them apart. Ids are what saves store, so a
  // rename is display-only; this keeps the collision from coming back.
  const byName = {};
  for (const [id, a] of Object.entries(ARTIFACTS)) (byName[a.name] ||= []).push(id);
  const clashes = Object.entries(byName).filter(([, ids]) => ids.length > 1);
  assert.deepEqual(clashes, [], `these names are shared: ${clashes.map(([n, ids]) => `${n} = ${ids.join(' + ')}`).join('; ')}`);
});

test('artifacts: no artifact is strictly dominated by a rival in its own slot and band', () => {
  // Titan's Gladius (value 4, weapon, +5 Attack) was strictly worse than
  // Mornbrand (value 4, weapon, +5 Attack AND +1 Morale): same competition, no
  // reason to prefer it, ever. That is worse than a weak artifact — it defeats
  // the point of a rarity band. `value` decides how hard the guard in front of a
  // treasure is, so a dominated top-band artifact means a map's hardest fight
  // can only be hiding the worse of two swords. Fixed by side-grading the
  // Gladius to +6 Attack: raw magnitude against Mornbrand's utility, and neither
  // is a strict upgrade on the other.
  //
  // Only artifacts that actually COMPETE are compared — the same slot (they can
  // never be worn together) and the same value (a rarer artifact is supposed to
  // be better). Ties are fine; what this refuses is "≥ on everything and > on
  // something", which is a choice with no decision in it.
  const dominates = (a, b) => {
    let better = false;
    for (const k of new Set([...Object.keys(a.effects), ...Object.keys(b.effects)])) {
      const x = a.effects[k] || 0, y = b.effects[k] || 0;
      if (y < x) return false;
      if (y > x) better = true;
    }
    return better;
  };
  const bad = [];
  for (const [ia, a] of Object.entries(ARTIFACTS)) {
    for (const [ib, b] of Object.entries(ARTIFACTS)) {
      if (ia !== ib && a.slot === b.slot && a.value === b.value && dominates(a, b)) {
        bad.push(`${ib} strictly dominates ${ia}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('; '));
});

test('artifacts: every printed desc quotes the effects the engine will actually apply', () => {
  // The Gladius side-grade is the reminder: an artifact's numbers live in TWO
  // places, `effects` (what heroUtils applies) and `desc` (what the paper doll,
  // the treasure popup and the trading post print). Change one and the game
  // lies. Only the magnitudes are checked — wording is the author's.
  const LABEL = {
    attack: 'Attack', defense: 'Defense', power: 'Power', knowledge: 'Knowledge',
    morale: 'Morale', luck: 'Luck',
  };
  const PRIMARY = ['attack', 'defense', 'power', 'knowledge'];
  for (const [id, a] of Object.entries(ARTIFACTS)) {
    // "+N to all primary stats" is the collective phrasing (Armor of Wonder,
    // Sword of Judgement). Check the one number instead of four names.
    const all = a.desc.match(/^\+(\d+) to all primary stats/);
    if (all) {
      for (const k of PRIMARY) {
        assert.equal(a.effects[k], Number(all[1]),
          `${id}: desc promises +${all[1]} to every primary stat but ${k} is ${a.effects[k] ?? 0}`);
      }
      continue;
    }
    for (const [k, v] of Object.entries(a.effects)) {
      if (!LABEL[k]) continue; // moveBonus/goldPerDay etc. are phrased in their own units
      assert.match(a.desc, new RegExp(`\\+${v} ${LABEL[k]}\\b`),
        `${id}: effects say ${k} ${v} but desc reads "${a.desc}"`);
    }
  }
});

// CLONE: the "docs tables match the data" guard is dropped with docs/.
// Upstream it re-runs scripts/data/docs-tables.mjs --check so a hand-copied
// physical figure in docs/PHYSICAL_MODEL.md can never go stale. This clone ships
// a README and no docs/, so there is no table to keep honest.
