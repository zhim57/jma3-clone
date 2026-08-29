/**
 * sagas.js — the procedural long-saga generator (#4).
 *
 * The hand-authored campaigns in campaigns.js are ~3 chapters. A *saga* is a
 * generated chain of 10 / 20 / 30 chapters that escalates map size, enemy count
 * and difficulty toward a boss finale — reusing the exact campaign scenario
 * shape, so `core/campaign.js` runs it with no new interpreter and the same
 * commander-carry (level / skills / spells / kept artifacts forward, a fresh
 * army each chapter).
 *
 * `generateSaga` is a PURE, DETERMINISTIC function of { seed, length, faction }:
 * the same inputs always yield the same chain (no Math.random — every choice is
 * arithmetic on seed + chapter index). That lets the engine regenerate the saga
 * on demand from the tiny descriptor stored on state.campaign, so saves stay
 * small and reproducible.
 */

import { CONFIG } from '../config.js';
import { FACTIONS } from './factions.js';

/** Supported saga lengths offered in the UI (any 3..40 still generates). */
export const SAGA_LENGTHS = [10, 20, 30];

/**
 * Saga archetypes — the SHAPE of the chain, not just its length.
 *
 *   classic       the original: one escalating coalition, 1 → 3 enemies on ONE team
 *   migrationAge  a multipolar world in the middle of the Migration Age. Many
 *                 rivals, each on its OWN team so they fight each other as well
 *                 as you, on rich land worth farming, with the waves of history
 *                 arriving every few months whether or not anyone is ready.
 *
 * `forceFeatures` is merged over the player's Settings flags when the saga starts:
 * a chain whose whole premise is invasion cannot be played with invasions off.
 */
export const SAGA_ARCHETYPES = {
  classic: {
    id: 'classic',
    label: 'Classic',
    blurb: 'One rival coalition, escalating toward a boss finale.',
    enemies: (t, isFinale) => (isFinale ? 3 : 1 + Math.floor(t * 2)),
    multipolar: false,
    forceFeatures: null,
  },
  migrationAge: {
    id: 'migrationAge',
    label: 'Migration Age',
    blurb: 'A crowded, multipolar world on rich land — and every few months, '
      + 'a foreign people arrives who did not check whether you were ready.',
    enemies: (t, isFinale) => (isFinale ? 6 : 2 + Math.round(t * 4)), // 2 → 6
    multipolar: true, // every rival on its OWN team: they fight each other too
    forceFeatures: { invasions: true, richLands: true },
  },
};
export const SAGA_ARCHETYPE_ORDER = ['classic', 'migrationAge'];

const ROMAN = [
  '', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX',
  'XXI', 'XXII', 'XXIII', 'XXIV', 'XXV', 'XXVI', 'XXVII', 'XXVIII', 'XXIX', 'XXX',
];
const roman = (n) => ROMAN[n] || String(n);

// Rotating, escalating chapter-title flavour (early → late arc feel).
const TITLES = [
  'The Borderlands', 'The River Kingdoms', 'The Ashen Marches', 'The Broken Coast',
  'The Sundered Vale', 'The Frostreach', 'The Emberwastes', 'The Shadowfen',
  'The Iron Passes', 'The Weeping Hills', 'The Storm Isles', 'The Deep Roads',
  'The Gilded Ruin', 'The Warlord\'s Reach', 'The Last Bastion',
];

/** A gently-escalating gold bonus, its size scaled by saga progress `t` (0..1). */
const goldBonus = (t) => Math.round(2000 + t * 6000);

function sagaName(n) {
  if (n <= 10) return 'A Short Saga';
  if (n <= 20) return 'A Long Saga';
  return 'An Epic Saga';
}

// Deterministic "bard" briefing for a saga chapter — composed by arithmetic on
// (seed, index) so every regeneration from the tiny descriptor is byte-identical.
// Evocative but bounded; the hand-authored campaigns carry their own prose.
const SAGA_OPENERS = [
  'The road climbs on into',
  'War follows you into',
  'You ride beneath grey banners into',
  'The war-horns summon you to',
  'No rest — the campaign presses into',
];
const SAGA_CLOSERS = [
  'Raise a fresh host, and take it.',
  'Muster what this land will give, and press on.',
  'Bleed them for every mile.',
  'Hold nothing back — the saga remembers.',
  'It is not yet written who wins here. Write it.',
];
function sagaBriefing(s, i, N, title, enemyKeys, isFinale) {
  const foes = enemyKeys.map((k) => `the ${FACTIONS[k]?.name || k}`);
  if (isFinale) {
    return `The last stronghold rises before you, and the powers of ${foes.join(', ')} rally to hold it. `
      + `Everything you have carried across ${N - 1} lands — every scar, every relic, every hard-won soldier — comes to bear on this one field. End it, and the saga is won.`;
  }
  const open = SAGA_OPENERS[Math.abs(s + i * 13) % SAGA_OPENERS.length];
  const close = SAGA_CLOSERS[Math.abs(s * 3 + i * 7) % SAGA_CLOSERS.length];
  return `${open} ${title}. Here the banners of ${foes.join(' and ')} bar the way, and they will not yield to a name alone. ${close}`;
}

function chapterBonuses(i, t) {
  const gold = goldBonus(t);
  // A creature bonus that grows in tier/count as the saga escalates.
  const troop = t < 0.34
    ? { id: 'troops', label: 'A company of 10 pikemen', kind: 'creatures', creature: 'pikeman', count: 10 }
    : t < 0.67
      ? { id: 'troops', label: 'A flight of 8 griffins', kind: 'creatures', creature: 'griffin', count: 8 }
      : { id: 'troops', label: 'A vanguard of 4 cavaliers', kind: 'creatures', creature: 'cavalier', count: 4 };
  return [
    { id: 'gold', label: `+${gold} gold`, kind: 'resource', resources: { gold } },
    { id: 'rares', label: '+6 of each rare resource', kind: 'resource', resources: { gems: 6, crystal: 6, mercury: 6, sulfur: 6 } },
    troop,
  ];
}

/**
 * Generate an N-chapter saga as a campaign-shaped object (see campaigns.js).
 * Deterministic in (seed, length, faction). `length` is clamped to [3, 40].
 */
export function generateSaga({ seed = 1, length = 10, faction = 'castle', archetype = 'classic' } = {}) {
  const arch = SAGA_ARCHETYPES[archetype] || SAGA_ARCHETYPES.classic;
  const N = Math.max(3, Math.min(40, length | 0));
  const s = seed | 0;
  const enemyFactions = Object.keys(FACTIONS).filter((f) => f !== faction);
  const ef = enemyFactions.length ? enemyFactions : Object.keys(FACTIONS);
  // Deterministic enemy pick from (chapter, slot) — no rng, so every regeneration
  // from the same descriptor is byte-identical.
  const pickEnemy = (i, slot) => ef[Math.abs(s * 31 + i * 17 + slot * 7) % ef.length];
  const DIFF = CONFIG.DIFFICULTY_ORDER; // ['easy','normal','hard','expert','impossible']

  const scenarios = [];
  for (let i = 0; i < N; i++) {
    const t = N > 1 ? i / (N - 1) : 0; // progress 0..1
    const isFinale = i === N - 1;
    const mapW = Math.round(36 + t * 44); // 36 → 80
    const mapH = Math.round(30 + t * 42); // 30 → 72
    // Difficulty ramps normal → hard → expert, with an Impossible boss finale.
    const difficulty = isFinale ? 'impossible' : (DIFF[Math.min(3, 1 + Math.floor(t * 3))] || 'normal');
    const enemyCount = arch.enemies(t, isFinale);
    const enemies = [];
    for (let e = 0; e < enemyCount; e++) {
      // Multipolar: each rival gets its own team, so the map is a world of realms
      // that fight one another as well as you — regimes rise and fall around you
      // instead of every enemy dogpiling the player.
      enemies.push({ faction: pickEnemy(i, e), team: arch.multipolar ? 2 + e : 1 });
    }
    const title = isFinale ? 'The Final Throne' : TITLES[i % TITLES.length];
    scenarios.push({
      name: `Chapter ${roman(i + 1)} — ${title}`,
      intro: isFinale
        ? 'The last stronghold stands before you. End it, and the saga is won.'
        : `Chapter ${i + 1} of ${N}. The war widens — press on, commander.`,
      briefing: sagaBriefing(s, i, N, title, enemies.map((e) => e.faction), isFinale),
      mapW,
      mapH,
      difficulty,
      seedOffset: (i + 1) * 101,
      enemies,
      victory: {},
      carry: i === 0 ? null : { skills: true, spells: true, artifacts: 'all' },
      bonuses: chapterBonuses(i, t),
    });
  }

  const id = arch.id === 'classic' ? `saga${N}` : `saga${N}_${arch.id}`;
  const name = arch.id === 'classic'
    ? `${sagaName(N)} (${N} chapters)`
    : `${arch.label} (${N} chapters)`;
  return {
    id, name, faction, isSaga: true, archetype: arch.id,
    forceFeatures: arch.forceFeatures, scenarios,
  };
}
