/**
 * uikit.js — Shared UI chrome: panel/button textures, dialogs, tooltips.
 *
 * Visual language: dark slate panels with warm gold trim (classic HoMM vibe),
 * serif display font. All chrome is generated at boot — no assets.
 */

import { paint, linGrad, rgba, shade } from '../gfx/canvasKit.js';
import { playSfx } from '../game/audio.js';
import { getSetting } from '../game/settings.js';
import { registerControl, trackClick } from '../game/uiTelemetry.js';

export const FONT = 'Georgia, "Times New Roman", serif';
export const COLORS = {
  gold: '#e8c060',
  parchment: '#e8dfc8',
  dim: '#9a94a8',
  danger: '#e07060',
  good: '#7ec860',
  ink: '#141020',
};

/** '#rrggbb' -> 0xRRGGBB, so a COLORS entry can feed numeric Phaser tints. */
const hexNum = (c) => parseInt(c.slice(1), 16);

/**
 * THE depth ladder. Every overlay depth in the game comes from here.
 *
 * Why it has to be one table: AdventureScene paints the world with a painter's
 * sort whose depth IS the sprite's world y in PIXELS (see buildDecor) — a tree
 * on the bottom row of a 120-tile map sits at depth 7680. Dialogs used to be
 * raised in that same scene at a hardcoded 5000, so on any map taller than ~78
 * tiles the trees, mountains and rocks of the lower map drew straight OVER the
 * message box. Reported as "the dialog shows under the trees".
 *
 * WORLD_MAX is the ceiling a world sprite can ever reach: the tallest map is
 * 120 tiles × 64 px = 7,680, and the fog/preview overlays already sat at 50,000
 * to clear it with room to spare. Every screen-space layer is above that, in the
 * order it must stack: the panel chrome and its dialogs, then the tooltip that
 * can float over a dialog, then a scene transition curtain over everything.
 */
export const DEPTH = {
  WORLD_MAX: 10000,   // the tallest world-y a map sprite can be given
  FOG: 50000,         // fog of war + path preview, drawn over the world
  HUD: 50100,         // screen-space panel chrome (its own scene, but explicit)
  MODAL: 60000,       // dialogs, carousels, overlay panels — above ALL world art
  MODAL_TOP: 61000,   // a second overlay raised over one of those
  TOOLTIP: 62000,     // hover text, which must clear even a modal
  CURTAIN: 63000,     // scene fades / loading veils
};

/**
 * Destroy every game object in a scene. NOTE: `scene.children.removeAll(true)`
 * must never be used for this — its boolean is `skipCallback`, so it detaches
 * children WITHOUT destroying them, leaving invisible but still-interactive
 * ghosts that keep receiving input.
 */
export function destroyAllChildren(scene) {
  for (const obj of [...scene.children.list]) obj.destroy();
}

/**
 * Live modal dialog roots across all scenes, each mapped to the moment it
 * opened. Any open modal gates world input; a keyed collection (rather than a
 * bare counter) lets us detect leaks, force-reset, and — via the timestamps —
 * tell "a human is reading this" apart from "this overlay is orphaned".
 */
const liveModals = new Map();

export function modalOpen() {
  return liveModals.size > 0;
}

/**
 * How long the OLDEST live modal has been open, in ms; 0 when none is.
 *
 * Read by the combat stall watchdog. An open modal means the turn loop is idle
 * on purpose — a human is reading a spell description — and a watchdog that
 * cannot see the difference tears the dialog down mid-read.
 */
export function modalAgeMs() {
  if (!liveModals.size) return 0;
  let oldest = Infinity;
  for (const at of liveModals.values()) oldest = Math.min(oldest, at);
  return Math.max(0, nowMs() - oldest);
}

/**
 * Safety valve for the modal gate. A dialog whose scene is torn down without
 * destroying it (or whose destroy handler never fires) would otherwise leave
 * `modalOpen()` stuck true and permanently swallow world input. Call this to
 * destroy any tracked modals and clear the gate.
 *
 * `guardMs` arms the click-guard for that long once everything is down. Pass it
 * whenever the player did NOT ask for the close: a dialog that vanishes on its
 * own takes the player's next press with it, and that press lands on whatever
 * was underneath (see MODAL_AUTOCLOSE_GUARD_MS). Scene entry wants the default
 * 0 — a fresh scene must not inherit a guard from the last one.
 */
export function resetModals({ guardMs = 0 } = {}) {
  for (const root of [...liveModals.keys()]) {
    liveModals.delete(root);
    if (root.active) root.destroy();
  }
  liveModals.clear();
  worldBlockedUntil = 0; // a torn-down scene must not leave the next one guarded
  if (guardMs > 0) blockWorldClicks(guardMs);
}

/**
 * Pin a UI object (and everything inside it) to the SCREEN rather than the world.
 *
 * Phaser positions a game object in world space by default, and a camera that
 * scrolls therefore carries it away. Most scenes here never scroll, so this went
 * unnoticed for a long time — but AdventureScene's camera pans and zooms across
 * the map, so a dialog raised on it was drawn at its screen-centre coordinates
 * interpreted as WORLD coordinates. Measured with the camera centred on the
 * hero: a dialog placed at world (640, 400) rendered at screen (768, -1152),
 * i.e. 1152px above the top of the window, while its oversized backdrop still
 * covered part of the view. That is the "half the screen goes dark and the modal
 * is somewhere I cannot see" report — and because the modal was open and unseen,
 * world input stayed gated and clicks kept burning the hero's movement.
 *
 * Recursive, and applied AFTER construction, because a container's own scroll
 * factor does not retroactively cover children added later.
 */
export function pinToScreen(obj) {
  if (!obj) return obj;
  obj.setScrollFactor?.(0, 0);
  for (const child of obj.list || []) pinToScreen(child);
  return obj;
}

/** Monotonic ms, matching the scenes' own now() so the two agree on the clock. */
const nowMs = () => ((typeof performance !== 'undefined' && performance.now)
  ? performance.now() : Date.now());

/**
 * How long after a modal closes the world keeps ignoring clicks. Long enough to
 * swallow the trailing press, short enough that nobody feels it.
 */
export const MODAL_CLICK_GUARD_MS = 150;

/**
 * The same window, but for a modal that closed WITHOUT the player asking — a
 * recovery path tore it down, or a scene rebuilt under it.
 *
 * Much longer, because the two cases are not alike. When you press ✕ you know
 * the dialog is gone and your next click is aimed at the world; when a dialog
 * vanishes by itself, the press already on its way was aimed at a button that no
 * longer exists, and it lands on whatever the dialog was covering. Reported from
 * combat: "before I press Cast it disappears, so I think I am pressing Cast but
 * actually I am pressing on the field to move my stack." Holding the world shut
 * for the best part of a second both eats that press and gives the eye time to
 * register that the dialog closed itself.
 */
export const MODAL_AUTOCLOSE_GUARD_MS = 900;

let worldBlockedUntil = 0;

/**
 * Block world clicks for a moment. Called whenever a modal closes, and callable
 * directly by anything else that dismisses an overlay mid-dispatch.
 */
export function blockWorldClicks(ms = MODAL_CLICK_GUARD_MS) {
  worldBlockedUntil = Math.max(worldBlockedUntil, nowMs() + ms);
}

/**
 * THE gate for scene-level world input: true while a modal is up, and for a beat
 * after one closes. Scenes that bind a scene-level `input.on('pointerup')` — the
 * combat grid, the adventure map — must check this and not modalOpen() alone.
 *
 * Why modalOpen() is not enough: closing a modal takes a pointerup. That press
 * destroys the overlay, flipping modalOpen() to false, and then the SAME dispatch
 * continues to the scene's own handler, where the gate is already open. The click
 * lands on the world — closing the combat spellbook marched the active stack onto
 * the hex under the ✕ button.
 *
 * Why the guard is global rather than per-scene: modals are globally exclusive
 * (liveModals already spans every scene), and the scene that OWNS a modal is
 * routinely not the scene that receives the leak. The HUD (AdvUI) builds the Town
 * Portal chooser and the trade window, while the ungated scene-level pointerup
 * belongs to the map beneath (Adventure). A guard stored on the owning scene
 * would be armed on the wrong object and protect nothing.
 */
export function worldClicksBlocked() {
  return liveModals.size > 0 || nowMs() <= worldBlockedUntil;
}

/**
 * Register an overlay `root` as a live modal: modalOpen()/worldClicksBlocked()
 * report it while it lives, and closing it arms the click-guard above.
 *
 * Every modal must come through here — the guard used to be armed per call site,
 * so the spellbook (which builds its own overlay) was tracked but unguarded, and
 * closing it ordered a unit. One choke point, no call site left to forget.
 */
export function trackModal(root) {
  liveModals.set(root, nowMs());
  root.once('destroy', () => {
    liveModals.delete(root);
    blockWorldClicks();
  });
  return root;
}

/**
 * Fit `n` cards into a box `availH` px tall: pick the FEWEST columns (widest
 * cells, so names stay readable) and TALLEST rows that still show all of them,
 * widening and tightening only as needed. If even the densest layout cannot fit
 * everything, report the page count instead — the caller pages rather than
 * silently truncating.
 *
 * Written because the town build grid was a hard-coded 4 columns and
 * `slice(0, cols * maxRows)`: a castle has 17 build slots (19 with the optional
 * buildings on) against 16 visible cells, so three vanished with no hint they
 * existed — you could neither build them nor, once built, open them again.
 */
export function fitGrid(n, availH, opts = {}) {
  const colChoices = opts.cols || [4, 5];
  const rowChoices = opts.rowHeights || [64, 58, 52];
  for (const rowH of rowChoices) {
    const rows = Math.floor(availH / rowH);
    if (rows < 1) continue;
    for (const cols of colChoices) {
      if (rows * cols >= n) return { cols, rowH, rows, perPage: rows * cols, pages: 1 };
    }
  }
  const rowH = rowChoices[rowChoices.length - 1];
  const cols = colChoices[colChoices.length - 1];
  const rows = Math.max(1, Math.floor(availH / rowH));
  const perPage = rows * cols;
  return { cols, rowH, rows, perPage, pages: Math.max(1, Math.ceil(n / perPage)) };
}

/**
 * How many body lines fit a band `availH` px tall, reserving room for a
 * "+N more" marker whenever anything must be cut. Returns
 * { shown, hidden } over the measured `lineHeights`.
 *
 * Written for showDialog: the panel is clamped to the viewport, but the body
 * text kept advancing line by line regardless, so on a short window the tail
 * of a long dialog (scenario requirements were the reported case) was painted
 * into the band the buttons occupy and covered by their backgrounds — silently
 * unreadable. Cutting must therefore be VISIBLE: when lines are dropped, the
 * marker's height is reserved so the reader learns the list was longer.
 * (Scrolling was rejected: a modal that scrolls needs input plumbing no other
 * dialog has, and each shipped overflow case remains readable in full at an
 * ordinary window height.)
 */
export function fitLines(lineHeights, availH, { gap = 4, moreH = 22 } = {}) {
  const total = lineHeights.reduce((n, hh) => n + hh + gap, 0);
  if (total <= availH) return { shown: lineHeights.length, hidden: 0 };
  let used = 0, shown = 0;
  for (const hh of lineHeights) {
    if (used + hh + gap > availH - moreH) break;
    used += hh + gap;
    shown++;
  }
  return { shown, hidden: lineHeights.length - shown };
}

export function registerUITextures(scene) {
  const add = (key, canvas) => {
    if (!scene.textures.exists(key)) scene.textures.addCanvas(key, canvas);
  };

  // Nine-slice panel: slate with gold trim.
  add('ui_panel', paint(96, 96, (ctx) => {
    ctx.fillStyle = linGrad(ctx, 0, 0, 96, 96, [[0, 'rgba(38,36,54,0.97)'], [1, 'rgba(22,20,34,0.97)']]);
    ctx.beginPath();
    ctx.roundRect(2, 2, 92, 92, 10);
    ctx.fill();
    ctx.strokeStyle = '#0c0a14';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(2, 2, 92, 92, 10);
    ctx.stroke();
    ctx.strokeStyle = rgba(hexNum(COLORS.gold), 0.75);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(4.5, 4.5, 87, 87, 8);
    ctx.stroke();
  }));

  // Lighter inset panel (slots, list rows).
  add('ui_inset', paint(64, 64, (ctx) => {
    ctx.fillStyle = 'rgba(12,10,20,0.85)';
    ctx.beginPath();
    ctx.roundRect(1, 1, 62, 62, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(130,120,160,0.4)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(2, 2, 60, 60, 6);
    ctx.stroke();
  }));

  // Buttons.
  const btn = (key, base) => {
    add(key, paint(72, 44, (ctx) => {
      ctx.fillStyle = linGrad(ctx, 0, 0, 0, 44, [
        [0, rgba(shade(base, 0.28))],
        [0.5, rgba(base)],
        [1, rgba(shade(base, -0.34))],
      ]);
      ctx.beginPath();
      ctx.roundRect(2, 2, 68, 40, 9);
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,8,16,0.9)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.roundRect(2, 2, 68, 40, 9);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,235,180,0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(4, 4, 64, 36, 7);
      ctx.stroke();
    }));
  };
  btn('ui_btn', 0x7a5c28);
  btn('ui_btn_over', 0x99742f);
  btn('ui_btn_down', 0x5c451e);
  btn('ui_btn_blue', 0x2e4a7c);
  btn('ui_btn_blue_over', 0x3c5f9c);
  btn('ui_btn_disabled', 0x3c3a46);
}

export function panel(scene, x, y, w, h, depth = 0) {
  const p = scene.add.nineslice(x, y, 'ui_panel', undefined, w, h, 14, 14, 14, 14)
    .setOrigin(0, 0).setDepth(depth);
  return p;
}

export function inset(scene, x, y, w, h, depth = 0) {
  return scene.add.nineslice(x, y, 'ui_inset', undefined, w, h, 9, 9, 9, 9)
    .setOrigin(0, 0).setDepth(depth);
}

/**
 * The id a control is counted under: `SceneKey:Label`, or `opts.track` where a
 * label is absent or too variable to group on (a resume button whose text
 * carries the day number would otherwise be a new control every day).
 *
 * Derived labels get their digit runs collapsed to `#`: only 6 of ~150 button
 * call sites pass `track:`, and every value-bearing label the rest render —
 * "⚱ Sacrifice for 3,050 XP", "Parley — 480g", "▶ Continue (Wk 3 Day 4)" —
 * used to mint a permanent key PER VALUE in the usage store, which both grew
 * localStorage without bound and poisoned the module's own deliverable: each
 * one-shot label showed up in summarize().unused as a control nobody presses.
 * Collapsing digits at the choke point fixes every such site at once; `track:`
 * remains the tool for labels whose TEXT varies (names, not numbers).
 * Exported for tests/ui-telemetry-bounds.test.js — nothing else should call it
 * directly; button() is the one real consumer.
 */
export function controlId(scene, label, opts) {
  if (opts.track === false) return null;
  if (typeof opts.track === 'string') return `${scene.scene?.key || '?'}:${opts.track}`;
  const name = String(label ?? opts.tooltip ?? opts.icon ?? '?')
    .replace(/\d[\d,.]*/g, '#') // starts with a digit, so bare punctuation survives
    .trim().slice(0, 40);
  return `${scene.scene?.key || '?'}:${name}`;
}

/**
 * Standard button. Returns a container with .setEnabled(bool) and .label.
 *
 * Every button counts itself — drawn AND pressed — through uiTelemetry, so the
 * UI can be cut on evidence. Recording the draw is what makes an unused control
 * findable: clicks alone cannot tell a button nobody presses from one that does
 * not exist. Local only, and off entirely when the player says so.
 */
export function button(scene, x, y, w, h, label, onClick, opts = {}) {
  const trackId = controlId(scene, label, opts);
  if (trackId) registerControl(trackId);
  const skin = opts.blue ? 'ui_btn_blue' : 'ui_btn';
  const skinOver = opts.blue ? 'ui_btn_blue_over' : 'ui_btn_over';
  const bg = scene.add.nineslice(0, 0, skin, undefined, w, h, 10, 10, 10, 10).setOrigin(0.5);
  const children = [bg];
  // opts.iconTexture draws a pictogram (a texture key) to the LEFT of the label,
  // so a battle button reads as an icon; opts.iconOnly drops the label entirely
  // (keep a tooltip then). opts.icon still prefixes a font glyph (⚔ Recruit).
  let img = null;
  if (opts.iconTexture && scene.textures.exists(opts.iconTexture)) {
    img = scene.add.image(0, 0, opts.iconTexture);
    const isz = opts.iconSize || Math.min(h - 10, 26);
    img.setDisplaySize(isz, isz);
    children.push(img);
  }
  const shown = opts.icon ? `${opts.icon} ${label}` : label;
  const txt = (img && opts.iconOnly) ? null : scene.add.text(0, 0, shown, {
    fontFamily: FONT,
    fontSize: opts.fontSize || '15px',
    color: opts.color || COLORS.parchment,
    fontStyle: 'bold',
  }).setOrigin(0.5);
  if (txt) children.push(txt);
  // Fit the label INSIDE the button: a fixed font in a fixed box is how a long
  // label ends up painted over the button's edges and its neighbours. Shrinks
  // toward a floor first, ellipsises only if it still cannot fit. The icon's
  // width is reserved so an icon+label button doesn't overlap either.
  if (txt) {
    const reserved = img ? img.displayWidth + 6 : 0;
    fitText(txt, Math.max(8, w - 16 - reserved), opts.minFontSize || 9);
  }
  // Centre the icon+label group as a unit (after fitting, so the measured text
  // width is the final one).
  if (img && txt) {
    const gap = 6, total = img.displayWidth + gap + txt.width;
    img.x = -total / 2 + img.displayWidth / 2;
    txt.x = total / 2 - txt.width / 2;
  }
  const c = scene.add.container(x, y, children);
  c.setSize(w, h);
  c.label = txt;
  c.bg = bg;
  c.icon = img;
  /** Re-label AND re-fit. Prefer this over `btn.label.setText(...)`, which sets a
   *  new string at the old font size and can overflow the box again. */
  c.setLabel = (text) => {
    if (!txt) return c;
    txt.setText(opts.icon ? `${opts.icon} ${text}` : text);
    txt.setFontSize(parseInt(opts.fontSize || '15px', 10));
    const reserved = img ? img.displayWidth + 6 : 0;
    fitText(txt, Math.max(8, w - 16 - reserved), opts.minFontSize || 9);
    if (img) {
      const gap = 6, total = img.displayWidth + gap + txt.width;
      img.x = -total / 2 + img.displayWidth / 2;
      txt.x = total / 2 - txt.width / 2;
    }
    return c;
  };
  let enabled = true;
  c.setEnabled = (v) => {
    enabled = v;
    bg.setTexture(v ? skin : 'ui_btn_disabled');
    txt?.setColor(v ? (opts.color || COLORS.parchment) : '#77738a');
    img?.setAlpha(v ? 1 : 0.4);
    return c;
  };
  c.setInteractive({ useHandCursor: true })
    .on('pointerover', () => enabled && bg.setTexture(skinOver))
    .on('pointerout', () => enabled && bg.setTexture(skin))
    .on('pointerdown', () => enabled && bg.setTexture('ui_btn_down'))
    .on('pointerup', () => {
      if (!enabled) return;
      bg.setTexture(skinOver);
      playSfx('click');
      if (trackId) trackClick(trackId);
      onClick?.();
    });
  // opts.tooltip: a hover label so an icon-only button stays discoverable (a11y).
  if (opts.tooltip && scene.tooltip) tipify(scene, c, scene.tooltip, opts.tooltip);
  return c;
}

/**
 * A compact square icon button — a single glyph with a hover tooltip that names
 * it, so a terse ✕ / ⮐ / ⚒ stays discoverable. Same skin/behaviour as button().
 * Prefer this for chrome (close/leave); keep text on rarer, wordier actions.
 */
export function iconButton(scene, x, y, size, glyph, onClick, opts = {}) {
  return button(scene, x, y, size, size, glyph, onClick, { fontSize: '18px', ...opts, icon: null });
}

/**
 * Compact a creature/army count so it stops blowing out the space it sits in.
 * Exact up to 10,000 (where the digits still fit and precision matters); beyond
 * that a rounded k/M/B form — "111111111 Royal Griffins" becomes "111M Royal
 * Griffins". Tooltips and recruit/transmute dialogs keep the exact figure; this
 * is for the tight one-line readouts (stack chips, army rows, hover text).
 */
export function fmtCount(n) {
  const num = Number(n) || 0;
  const v = Math.abs(num);
  if (v < 10000) return String(num);
  if (v < 1e6) return `${+(num / 1e3).toFixed(v < 1e5 ? 1 : 0)}k`;
  if (v < 1e9) return `${+(num / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`;
  if (v < 1e12) return `${+(num / 1e9).toFixed(1)}B`;
  return `${+(num / 1e12).toFixed(1)}T`;
}

/**
 * Make a Phaser text object FIT `maxWidth`: shrink the font toward `minPx`, then
 * — if it still will not fit — clip with an ellipsis. Returns the object.
 *
 * Every button and one-line readout runs through this, because a fixed font in a
 * fixed box is exactly how "111111111 Royal Griffins" ends up painted over its
 * neighbours. Shrinking first keeps the whole string readable; ellipsis is the
 * last resort (pair it with a tooltip carrying the full text).
 */
export function fitText(txt, maxWidth, minPx = 9) {
  if (!txt || !(maxWidth > 0)) return txt;
  const start = parseInt(txt.style.fontSize, 10) || 14;
  for (let px = start; px >= minPx; px--) {
    txt.setFontSize(px);
    if (txt.width <= maxWidth) return txt;
  }
  // Still too wide at the floor: trim characters until the ellipsis fits.
  const full = txt.text;
  for (let cut = full.length - 1; cut > 0; cut--) {
    txt.setText(`${full.slice(0, cut).trimEnd()}…`);
    if (txt.width <= maxWidth) break;
  }
  return txt;
}

export function label(scene, x, y, text, opts = {}) {
  const t = scene.add.text(x, y, text, {
    fontFamily: FONT,
    fontSize: opts.size || '14px',
    color: opts.color || COLORS.parchment,
    fontStyle: opts.bold ? 'bold' : 'normal',
    align: opts.align || 'left',
    wordWrap: opts.wrap ? { width: opts.wrap } : undefined,
  }).setOrigin(opts.ox ?? 0, opts.oy ?? 0);
  // opts.max: hard cap the rendered width (shrink, then ellipsise). Only for
  // single-line readouts — wrapped text is already bounded by its wrap width.
  if (opts.max && !opts.wrap) fitText(t, opts.max, opts.minSize || 9);
  return t;
}

/**
 * A reusable quantity picker: `[−big][−1]  value  [+1][+big]` on one row with a
 * draggable slider below, so you can jump to any amount in one gesture instead
 * of clicking a stepper dozens of times. The centred value is click-to-type
 * (an exact entry via prompt). Everything is created at absolute (x, y) — add
 * the returned `objects` to a dialog's root container at (0,0); `onChange(v)`
 * fires on every change (live cost readouts), and `get()/set(v)` drive it.
 *
 * opts: { value, min=1, max, step=1, bigStep=10, width=300, fmt, onChange }
 */
export function numberPicker(scene, x, y, opts = {}) {
  const min = opts.min ?? 1;
  const max = Math.max(min, opts.max ?? min);
  const step = opts.step ?? 1;
  const big = opts.bigStep ?? 10;
  const width = opts.width ?? 300;
  const fmt = opts.fmt ?? ((v) => `${v}`);
  const clamp = (v) => Math.max(min, Math.min(max, Math.round(v)));
  let value = clamp(opts.value ?? min);
  const objects = [];
  const add = (o) => { objects.push(o); return o; };
  const half = width / 2, left = x - half, sy = y + 30;

  const emit = () => { sync(); valTxt.setText(fmt(value)); opts.onChange?.(value); };
  const setVal = (v) => { const nv = clamp(v); if (nv !== value) { value = nv; emit(); } else { sync(); valTxt.setText(fmt(value)); } };

  add(button(scene, left + 22, y, 42, 30, `−${big}`, () => setVal(value - big), { fontSize: '12px' }));
  add(button(scene, left + 66, y, 34, 30, '−1', () => setVal(value - step), { fontSize: '12px' }));
  add(button(scene, x + half - 22, y, 42, 30, `+${big}`, () => setVal(value + big), { fontSize: '12px' }));
  add(button(scene, x + half - 66, y, 34, 30, '+1', () => setVal(value + step), { fontSize: '12px' }));

  const valTxt = add(scene.add.text(x, y, fmt(value), { fontFamily: FONT, fontSize: '18px', fontStyle: 'bold', color: COLORS.gold }).setOrigin(0.5));
  valTxt.setInteractive({ useHandCursor: true }).on('pointerup', () => {
    const raw = (typeof window !== 'undefined' && window.prompt) ? window.prompt('Enter amount:', String(value)) : null;
    if (raw != null && String(raw).trim() !== '' && Number.isFinite(Number(raw))) setVal(Number(raw));
  });

  add(scene.add.rectangle(left, sy, width, 6, 0x3a3550).setOrigin(0, 0.5));
  const fill = add(scene.add.rectangle(left, sy, 0, 6, hexNum(COLORS.gold)).setOrigin(0, 0.5));
  const handle = add(scene.add.circle(left, sy, 10, hexNum(COLORS.gold)).setStrokeStyle(2, 0x2a2438));
  const sync = () => { handle.x = left + ((value - min) / (max - min || 1)) * width; fill.width = handle.x - left; };
  sync();
  handle.setInteractive({ useHandCursor: true });
  scene.input.setDraggable(handle);
  handle.on('drag', (_p, dragX) => setVal(min + ((Math.max(left, Math.min(left + width, dragX)) - left) / width) * (max - min)));

  return { objects, get: () => value, set: setVal };
}

/**
 * Modal dialog. spec: { title, lines: [str], picture?: textureKey,
 * buttons: [{ text, onClick, blue, track? }], width? }
 * `track` names the button's usage-telemetry id when its label text varies
 * (see controlId). Returns the container; it destroys itself when any button
 * is pressed.
 */
export function showDialog(scene, spec) {
  const W = scene.scale.width, H = scene.scale.height;
  // A roomier default (was 420): the old box forced long lines to wrap three deep
  // and squeezed button labels. Never wider than the viewport.
  const w = Math.min(spec.width || 520, W - 30);
  const lines = spec.lines || [];
  const btns = spec.buttons?.length ? spec.buttons : [{ text: 'OK' }];
  // Buttons wrap into rows so long lists (spellbooks) never overlap.
  const perRow = Math.max(1, Math.min(btns.length, Math.floor((w - 40) / 148)));
  const btnRows = Math.ceil(btns.length / perRow);
  // MEASURE the body instead of assuming one row per line. Each line wraps at
  // (w - 50), so a long line really occupies two or three rows — the old estimate
  // of 22px each let the text run down over the buttons. Measure with throwaway
  // text objects, then size the panel to what will actually be drawn.
  const LINE_GAP = 4;
  const lineHeights = lines.map((line) => {
    const probe = scene.add.text(0, 0, line, {
      fontFamily: FONT, fontSize: '14px', align: 'center', wordWrap: { width: w - 50 },
    });
    const hh = probe.height;
    probe.destroy();
    return hh;
  });
  const linesH = lineHeights.reduce((n, hh) => n + hh + LINE_GAP, 0);
  const bodyH = 30 + (spec.title ? 34 : 0) + (spec.picture ? 84 : 0) + linesH + 20 + btnRows * 46;
  // Fit both axes to the viewport; height is clamped so a tall dialog (long
  // spellbook, many lines) can never overflow off-screen.
  const h = Math.min(Math.max(150, bodyH), H - 20);
  // DEPTH.MODAL, never a bare number: a dialog raised on AdventureScene shares a
  // display list with world art whose depth is its world y in pixels (see DEPTH).
  const root = trackModal(scene.add.container(0, 0).setDepth(DEPTH.MODAL));

  const blocker = scene.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55)
    .setInteractive();
  root.add(blocker);

  const px = (W - w) / 2, py = (H - h) / 2;
  root.add(panel(scene, px, py, w, h));
  let cy = py + 20;
  if (spec.title) {
    root.add(label(scene, W / 2, cy, spec.title, { size: '19px', bold: true, color: COLORS.gold, ox: 0.5 }));
    cy += 34;
  }
  if (spec.picture) {
    const img = scene.add.image(W / 2, cy + 36, spec.picture);
    const sc = Math.min(1, 72 / img.height);
    img.setScale(sc);
    root.add(img);
    cy += 84;
  }
  // Clamp the BODY to the band the clamped panel actually gives it (the chrome
  // constants mirror bodyH above). Without this, a dialog taller than the
  // viewport kept advancing cy line by line and painted its tail under the
  // button row, where the buttons' opaque backgrounds made it unreadable.
  const bandH = h - 30 - (spec.title ? 34 : 0) - (spec.picture ? 84 : 0) - 20 - btnRows * 46;
  const { shown, hidden } = fitLines(lineHeights, bandH, { gap: LINE_GAP });
  lines.slice(0, shown).forEach((line, i) => {
    root.add(label(scene, W / 2, cy, line, { ox: 0.5, size: '14px', wrap: w - 50, align: 'center' }));
    cy += (lineHeights[i] || 22) + LINE_GAP; // its REAL height, wrapping included
  });
  if (hidden > 0) {
    root.add(label(scene, W / 2, cy, `…and ${hidden} more line${hidden > 1 ? 's' : ''} — enlarge the window to read them`,
      { ox: 0.5, size: '12px', color: COLORS.dim }));
  }
  // Activate a button spec at most once: close the dialog, then run its handler.
  let closed = false;
  const activate = (b) => {
    if (closed) return;
    closed = true;
    root.destroy();
    b?.onClick?.();
  };

  const bw = Math.min(150, (w - 40) / perRow - 10);
  btns.forEach((b, i) => {
    const row = Math.floor(i / perRow);
    const inRow = row === btnRows - 1 ? btns.length - row * perRow : perRow;
    const col = i % perRow;
    const bx = W / 2 + (col - (inRow - 1) / 2) * (bw + 14);
    const by = py + h - 34 - (btnRows - 1 - row) * 46;
    // b.track is forwarded so a dialog button with a name-bearing label
    // ("Hire Sir Roderick (1200g)") can group under one telemetry id — until
    // this line no dialog button could supply one at all.
    root.add(button(scene, bx, by, bw, 36, b.text, () => activate(b), { blue: b.blue, track: b.track }));
  });

  // Keyboard: Enter fires the primary/confirm action, Esc cancels/closes. The
  // primary defaults to the first button; a cancel button is matched by an
  // explicit flag, a Cancel/Close/No label, or (for a lone button) that button.
  //
  // `persistent` dialogs refuse Esc outright. A dialog whose buttons are the ONLY
  // way out of the state behind it — the game-over dialog is the one that matters —
  // must not be dismissable by a key that runs no handler: Esc used to fall through
  // to activate(null), which destroys the box and does nothing, stranding the
  // player in a world whose input is gated on the very outcome the dialog exists to
  // resolve. Reported as "I am stuck, I can enter towns but my heroes cannot move
  // and the days do not advance".
  const primary = btns.find((b) => b.primary) || btns[0];
  const cancel = spec.persistent ? null : (btns.find((b) => b.cancel)
    || btns.find((b) => /^(cancel|close|no)$/i.test(b.text || ''))
    || (btns.length === 1 ? btns[0] : null));
  const kb = scene.input?.keyboard;
  if (kb) {
    // Only the TOPMOST (newest) live modal answers Enter/Esc — otherwise stacked
    // dialogs (e.g. a chest reward + a level-up after one guard fight) would both
    // resolve on a single keypress. liveModals preserves insertion order, so the
    // last entry is the newest.
    const isTopmost = () => [...liveModals.keys()].pop() === root;
    const onEnter = () => { if (isTopmost()) activate(primary); };
    const onEsc = () => {
      if (!isTopmost() || spec.persistent) return; // persistent: pick a button
      if (cancel) activate(cancel);
      else activate(null);
    };
    kb.on('keydown-ENTER', onEnter);
    kb.on('keydown-ESC', onEsc);
    root.once('destroy', () => {
      kb.off('keydown-ENTER', onEnter);
      kb.off('keydown-ESC', onEsc);
    });
  }
  // Screen-space, not world-space: see pinToScreen. Applied last so every child
  // built above is covered.
  pinToScreen(root);

  return root;
}

/** Lightweight hover tooltip manager (one per scene). */
export class Tooltip {
  constructor(scene) {
    this.scene = scene;
    this.root = null;
    this._key = null;  // what the live tooltip shows: `${text}@${scale}`
    this._w = 0;       // live box size, for the clamp when only repositioning
    this._h = 0;
  }

  show(x, y, text) {
    const scene = this.scene;
    // A fixed 13px read as "very small" on a real display, so the size is the
    // player's to set (Settings -> Hover text size). The wrap width scales with it,
    // or a bigger font would just make a taller, narrower column.
    const scale = Math.max(0.8, Math.min(2, Number(getSetting('uiTextScale')) || 1));
    // UNCHANGED CONTENT ONLY MOVES. tipify re-shows on every pointermove, and
    // rebuilding here meant a fresh Text (re-measure, re-wrap, re-render, a GL
    // texture created and destroyed) per mouse jiggle — hundreds of texture
    // churn cycles inside an input handler (measured: 31 Text objects for 31
    // moves over one button). The same fix the repo already applies to the
    // adventure object card and the combat active ring: key on the content,
    // reposition the live container, and take the rebuild path only when the
    // text (or the player's text-size setting) actually changed.
    const key = `${text}@${scale}`;
    if (this.root && this._key === key) {
      this.root.setPosition(...this._clamp(x, y));
      return;
    }
    this.hide();
    const txt = scene.add.text(0, 0, text, {
      fontFamily: FONT, fontSize: `${Math.round(13 * scale)}px`, color: COLORS.parchment,
      wordWrap: { width: Math.round(260 * scale) },
    });
    this._w = txt.width + 18;
    this._h = txt.height + 12;
    const bg = scene.add.rectangle(0, 0, this._w, this._h, 0x100e1c, 0.95).setOrigin(0)
      .setStrokeStyle(1, hexNum(COLORS.gold), 0.6);
    txt.setPosition(9, 6);
    this.root = scene.add.container(...this._clamp(x, y), [bg, txt]).setDepth(DEPTH.TOOLTIP);
    this._key = key;
    // SCREEN space, not world space. x/y come from the pointer, which is already in
    // screen pixels — unpinned, the adventure map's scrolling camera dragged the
    // tooltip away from the cursor by the scroll offset (the same defect that put
    // dialogs off-view; see pinToScreen).
    pinToScreen(this.root);
  }

  /** Box position beside the pointer, kept inside the viewport. */
  _clamp(x, y) {
    const W = this.scene.scale.width, H = this.scene.scale.height;
    return [
      Math.min(Math.max(6, x + 14), W - this._w - 6),
      Math.min(Math.max(6, y - this._h - 8), H - this._h - 6),
    ];
  }

  hide() {
    this.root?.destroy();
    this.root = null;
    this._key = null;
  }
}

/** Attach hover tooltip behavior to a game object. */
export function tipify(scene, obj, tooltip, textFn) {
  obj.setInteractive(obj.input?.hitArea ? undefined : { useHandCursor: false });
  obj.on('pointerover', (p) => tooltip.show(p.x, p.y, typeof textFn === 'function' ? textFn() : textFn));
  obj.on('pointermove', (p) => {
    if (tooltip.root) tooltip.show(p.x, p.y, typeof textFn === 'function' ? textFn() : textFn);
  });
  obj.on('pointerout', () => tooltip.hide());
}

/** Format a cost object like {gold:2000, wood:5} into a short string. */
export function costText(cost) {
  const parts = [];
  for (const [k, v] of Object.entries(cost || {})) {
    if (v) parts.push(`${v} ${k[0].toUpperCase()}${k.slice(1)}`);
  }
  return parts.length ? parts.join(', ') : 'Free';
}
