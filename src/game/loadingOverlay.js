/**
 * loadingOverlay.js — Controls the instant HTML loading overlay (#boot-loading
 * in index.html). It renders before any JS, so it covers the whole boot —
 * bundle parse, procedural texture generation, and raster art loading — and
 * stays up until the game is genuinely ready. It's also reused to cover the
 * (synchronous) map build when a game starts.
 */

import { CREATURES } from '../data/creatures.js';
import { FACTIONS } from '../data/factions.js';
import { HERO_ROSTER } from '../data/heroes.js';
import { ARTIFACTS } from '../data/artifacts.js';
import { SPELLS } from '../data/spells.js';
import { savedGameSummary } from './session.js';
import { spriteUrl } from '../gfx/sprites.js';

const TIPS = [
  'Tip: two of your heroes standing side by side can exchange armies.',
  'Tip: build the upgraded dwelling, then upgrade the troops you already own.',
  'Tip: flag mines and resource piles to fund your war machine.',
  'Tip: hover any map object to see what it is and who owns it.',
  'Tip: the mini-map and mouse-edge scrolling make scouting quick.',
  'Tip: your realm autosaves at the start of each new day.',
];

const el = (id) => document.getElementById(id);

let _shownAt = (typeof performance !== 'undefined') ? performance.now() : 0;
let _hideTimer = null;
let _tipTimer = null;        // rotating-tips interval (boot overlay)
let _bootCleanup = null;     // removes the sprites-progress listener
const HIDE_MIN_MS = 1500; // once shown, keep the splash up at least this long

/** Show (or re-show) the overlay with an optional status line. */
export function showOverlay(status) {
  if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  const root = el('boot-loading');
  if (!root) return;
  root.style.display = 'flex';
  root.classList.remove('bl-hide');
  if (status) { const s = el('bl-status'); if (s) s.textContent = status; }
  _shownAt = performance.now();
}

/** Fade the overlay out (kept in the DOM so it can be shown again), but never
 *  before it's been visible for HIDE_MIN_MS — so the battle art / stats read. */
export function hideOverlay() {
  // Boot overlay is done: stop the rotating-tips timer and drop the
  // sprites-progress listener so neither keeps firing (or leaking) after fade.
  if (_tipTimer) { clearInterval(_tipTimer); _tipTimer = null; }
  if (_bootCleanup) { _bootCleanup(); _bootCleanup = null; }
  const wait = Math.max(0, HIDE_MIN_MS - (performance.now() - _shownAt));
  if (_hideTimer) clearTimeout(_hideTimer);
  _hideTimer = setTimeout(() => {
    _hideTimer = null;
    const root = el('boot-loading');
    if (!root) return;
    root.classList.add('bl-hide');
    setTimeout(() => { const r = el('boot-loading'); if (r && r.classList.contains('bl-hide')) r.style.display = 'none'; }, 550);
  }, wait);
}

const MIN_MS = 2500;   // linger so the battle art + resume stats can be read
const MAX_MS = 25000;  // …but never hold forever if art is slow/broken

/**
 * Populate stats/tips and auto-hide the overlay once the game reports ready
 * (both procedural textures and the raster pack). Call once after the Phaser
 * game is created.
 */
export function initBootOverlay(game) {
  const stats = el('bl-stats');
  if (stats) {
    stats.textContent = [
      `${Object.keys(FACTIONS).length} factions`,
      `${Object.keys(CREATURES).length} creatures`,
      `${Object.keys(HERO_ROSTER).length} heroes`,
      `${Object.keys(ARTIFACTS).length} artifacts`,
      `${Object.keys(SPELLS).length} spells`,
    ].join('   ·   ');
  }
  // Where the player left off last session (or a fresh-start line).
  const resume = el('bl-resume');
  if (resume) {
    const g = savedGameSummary();
    if (g) {
      const week = Math.floor((g.day - 1) / 7) + 1, dow = ((g.day - 1) % 7) + 1;
      resume.textContent = `Last session — Week ${week}, Day ${dow}  ·  `
        + `${g.heroes} hero${g.heroes === 1 ? '' : 'es'}  ·  `
        + `${g.towns} town${g.towns === 1 ? '' : 's'}  ·  ${g.gold.toLocaleString()} gold`;
    } else {
      resume.textContent = 'A new realm awaits your banner.';
    }
  }
  // Optional battle backdrop for the splash — resolved through the sprite index,
  // so it works whether splash_battle is a local file or a CDN (Cloudinary) URL.
  spriteUrl('splash_battle').then((url) => {
    if (!url) return;
    const bg = new Image();
    bg.crossOrigin = 'anonymous';
    bg.onload = () => {
      const root = el('boot-loading');
      if (!root) return;
      root.style.backgroundImage =
        `linear-gradient(rgba(6,5,14,0.66), rgba(6,5,14,0.86)), url("${url}")`;
      root.style.backgroundSize = 'cover';
      root.style.backgroundPosition = 'center';
    };
    bg.src = url;
  }).catch(() => { /* no index / no splash — dark gradient it is */ });
  const tip = el('bl-tip');
  let ti = 0;
  if (tip) {
    tip.textContent = TIPS[0];
    _tipTimer = setInterval(() => { ti = (ti + 1) % TIPS.length; if (tip) tip.textContent = TIPS[ti]; }, 2600);
  }
  // Reflect real art-load progress in the status line when available.
  const onProgress = (v) => {
    const s = el('bl-status');
    if (s) s.textContent = `Loading world art… ${Math.round((v || 0) * 100)}%`;
  };
  game.events.on('sprites-progress', onProgress);
  _bootCleanup = () => game.events.off('sprites-progress', onProgress);

  const start = performance.now();
  const ready = () => game.registry.get('bootReady') && game.registry.get('spritesReady');
  const tick = () => {
    if (!el('boot-loading')) return;
    const elapsed = performance.now() - start;
    if ((ready() && elapsed > MIN_MS) || elapsed > MAX_MS) {
      const n = game.registry.get('spriteCount') || 0;
      const s = el('bl-status');
      if (s) s.textContent = n ? `${n} art assets ready` : 'Ready';
      hideOverlay();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
