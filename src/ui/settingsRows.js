/**
 * settingsRows.js — WHAT the Settings screen offers, and WHERE each row lands.
 *
 * One declarative table, rendered by SettingsScene, replayed by
 * scripts/settings-layout-replay.mjs, and scanned by every guard in
 * tests/settings-schema.test.js and tests/settings-layout.test.js.
 *
 * It is one table because the alternative was measured and failed: the screen
 * used to build its rows imperatively in create(), and the replay script mirrored
 * that list BY HAND. Add a row to the scene, forget the mirror, and the
 * off-panel guard silently guards last month's screen — the same drift the
 * feature-toggle wiring test avoids by reading the scene's source directly.
 * Here the scene, the replay and the guards all read the same object, so there is
 * no copy to fall behind.
 *
 * Phaser-free on purpose: the packer below is pure arithmetic, so "does anything
 * get drawn off the panel?" is a millisecond unit test rather than a browser run
 * at six window sizes.
 */

import { CONFIG } from '../config.js';
import { tideTargetLoss } from '../core/pacing.js';

/**
 * Row heights. Denser than the screen they replace: a boolean was a 13px label
 * plus a 92x30 button in a 46px row — the widest possible rendering of one bit,
 * and sixteen of them ran 776px into a 596px column. A checkbox chip carries the
 * same bit in 26px at half the width, so two sit side by side.
 */
export const ROW_H = {
  header: 20,      // section title alone
  headerNote: 40,  // title + one wrapped line of note
  slider: 40,      // label + value on one baseline, track beneath
  cycle: 34,       // label + a compact value button
  checkPair: 26,   // one or two checkbox chips
  combo: 44,       // a cycle and its magnitude slider, sharing a row
  readonly: 26,    // a value the player may see but not set
  action: 44,      // a button (Export game log)
};

/** The interactive height a row's controls claim, whatever they are drawn at. */
export const TOUCH_MIN = 36;

/**
 * Panel chrome the columns may not use: the title and tab strip above, and the
 * detail strip plus the button row below.
 *
 * Named constants rather than a magic 124, because the first cut of this budget
 * counted the title and the buttons but forgot the 40px detail strip that was
 * added at the same time — so the packer thought it had 60 more pixels than it
 * did and the last row of each column drew straight through the strip. Nothing
 * was off-PANEL, so the arithmetic guard passed; only rendering it showed the
 * overlap. The guard now measures against contentBottom(), not the panel edge.
 */
export const CHROME_TOP = 62; // title + tabs

/**
 * The bottom chrome, part by part, so the budget is DERIVED from what the scene
 * draws rather than asserted next to it.
 *
 * This shape is the fix for a real defect and for a guard that could not see it.
 * CHROME_BOTTOM was first written as a bare 118 while the scene positioned its
 * strip independently; when the strip was added the budget was not updated, and
 * the last row of every column drew straight through it. The layout guard stayed
 * green throughout — it compared content against `panelH - CHROME_BOTTOM`, and
 * both sides moved together, so no value of that constant could ever fail. Only
 * rendering the screen showed the overlap.
 *
 * Now the scene lays its chrome out from these fields and the budget is their
 * sum, so a strip that grows without the budget growing is a contradiction the
 * test in settings-layout.test.js can actually catch.
 */
export const CHROME = {
  stripGap: 8,      // panel content bottom -> detail strip top
  stripH: 40,       // the detail strip itself
  buttonsGap: 14,   // strip bottom -> button top
  buttonsH: 32,     // the footer buttons
  marginBelow: 24,  // button bottom -> panel edge
};

export const CHROME_BOTTOM = CHROME.stripGap + CHROME.stripH
  + CHROME.buttonsGap + CHROME.buttonsH + CHROME.marginBelow;

/** The lowest y a packed row may occupy in a panel of this height. */
export const contentBottom = (panelH) => panelH - CHROME_BOTTOM;

/**
 * Breathing room above a section that is not the first in its column. Reserved
 * for EVERY block when balancing (so one gap per column is over-reserved, which
 * can only ever leave slack) and applied only BETWEEN them when placing.
 */
export const SECTION_GAP = 12;

const pct = (v) => `${Math.round(v * 100)}%`;
const mult = (v) => `${v.toFixed(1)}x`;
const times2 = (v) => `${v.toFixed(2)}x`;
const title = (v) => v.charAt(0).toUpperCase() + v.slice(1);

/**
 * The two pages, their sections, and the rows in them.
 *
 * Every section declares ONE scope and every row in it must carry that scope
 * (guarded) — so the screen can tell the player when a change takes effect
 * without annotating 40 rows individually. That distinction is the whole point:
 * Settings opens over a running game, where a 'game' row cannot reach the game
 * you are looking at, and the old screen said nothing.
 */
export const SETTINGS_PAGES = [
  {
    id: 'game',
    title: 'Game',
    sections: [
      {
        title: 'Sound & Picture',
        scope: 'device',
        // The mute switch rides the header instead of being a third button in the
        // footer, next to volumes it is obviously part of.
        headerCheck: 'muted',
        headerCheckLabel: 'Sound on',
        headerCheckInvert: true,
        rows: [
          { kind: 'slider', key: 'masterVolume', label: 'Master volume', min: 0, max: 1, fmt: pct, sfx: 'coin' },
          { kind: 'slider', key: 'musicVolume', label: 'Music', min: 0, max: 1, fmt: pct },
          { kind: 'slider', key: 'sfxVolume', label: 'Effects', min: 0, max: 1, fmt: pct, sfx: 'coin' },
          { kind: 'slider', key: 'animSpeed', label: 'Animation speed', min: 0.4, max: 2.5, fmt: mult },
          { kind: 'slider', key: 'uiTextScale', label: 'Hover text size', min: 0.8, max: 2, fmt: times2 },
          { kind: 'check', key: 'vignette', label: 'Map edge vignette' },
          { kind: 'check', key: 'showVassalMoves', label: 'Watch vassal moves' },
        ],
      },
      {
        title: 'Pacing & Challenge',
        scope: 'game',
        note: 'The last two only bite under Tide of War.',
        rows: [
          {
            kind: 'cycle', key: 'pacing', label: 'Pacing',
            values: CONFIG.PACING_ORDER,
            fmt: (v) => CONFIG.PACING[v]?.label || 'Classic',
            isOn: (v) => !!CONFIG.PACING[v]?.tideOfWar,
          },
          { kind: 'check', key: 'wildGrowth', label: 'Wild stacks grow weekly' },
          {
            // pveScaling + tideHardness were two rows for one idea: an amount with
            // an off position. Merged into one slider with an Off detent — but
            // still TWO keys underneath, deliberately. tideHardness clamps to
            // [0.5, 1.3], so an out-of-range "off" sentinel would be silently
            // clamped into a real value, i.e. a game quietly different from the
            // one the player asked for.
            // Formatted as the COST it promises, not as its own raw value: the dial
            // reads 0.5-1.3, which used to be "the fraction of your army value the
            // defender is lifted to" and is now an index into a target loss. Rendering
            // 0.85 as "85%" would name a quantity that no longer exists — the honest
            // label is the ~20% of your army the fight is actually sized to cost.
            kind: 'slider', key: 'tideHardness', label: 'How hard wild fights hit back',
            min: 0.5, max: 1.3, offKey: 'pveScaling',
            fmt: (v) => `costs ~${Math.round(tideTargetLoss(v) * 100)}% of your army`,
          },
          {
            // Same shape: 'off' is already a value of the cycle, and the power
            // slider is meaningless while it reads Off — so it greys out there
            // instead of sitting live and inert as it used to.
            kind: 'combo', key: 'tideIntervention', label: 'Divine intervention',
            values: CONFIG.TIDE_INTERVENTION_LEVELS, fmt: title, isOn: (v) => v !== 'off',
            powerKey: 'tideInterventionPower', powerMin: 0, powerMax: 2, powerFmt: pct,
          },
        ],
      },
      // CLONE: the whole "Study break" settings group is removed with the study
      // module (a Pomodoro that pays in-game resources for math problems or reading).
      // It also carried the only two private third-party URLs in the parent repo, so
      // dropping it is what makes this tree publishable as-is.
      {
        title: 'Optional Features',
        scope: 'game',
        note: 'Classic play is unchanged with these off.',
        rows: [
          { kind: 'check', key: 'balanceOfPower', label: 'Balance of Power' },
          { kind: 'check', key: 'cohesionRout', label: 'Cohesion & Rout' },
          { kind: 'check', key: 'cunningAI', label: 'Cunning AI' },
          { kind: 'check', key: 'aiTownPortal', label: 'AI Town Portal' },
          { kind: 'check', key: 'sunkCostSiege', label: 'Sunk-Cost Siege' },
          { kind: 'check', key: 'hallOfReflection', label: 'Hall of Reflection' },
          { kind: 'check', key: 'diplomacy', label: 'Diplomacy' },
          { kind: 'check', key: 'townBank', label: 'Town Bank' },
          { kind: 'check', key: 'lizardGhosts', label: 'Lizard Ghosts' },
          { kind: 'check', key: 'richLands', label: 'Rich Lands' },
          { kind: 'check', key: 'invasions', label: 'Invasions' },
          { kind: 'check', key: 'lairBrood', label: 'Lairs Keep Breeding' },
          { kind: 'check', key: 'siteRespawn', label: 'Vaults Are Reoccupied' },
          { kind: 'check', key: 'physicalDamage', label: 'Physical Damage Model' },
          { kind: 'check', key: 'ronins', label: 'Ronins (Masterless Captains)' },
        ],
      },
    ],
  },
  {
    id: 'advanced',
    title: 'Advanced',
    sections: [
      {
        // These are not preferences. Every one is a knob whose correct value is
        // already measured and shipped; they stay reachable because
        // re-measurement and regression bisects need them, and they live here
        // because a player scanning for the volume should never meet them.
        title: 'AI behaviour',
        scope: 'live',
        note: 'Shipped values are the measured best. Applies to the game you are playing.',
        rows: [
          { kind: 'check', key: 'aiStackSplit', label: 'Splits stacks at deploy' },
          { kind: 'check', key: 'aiBattleFormations', label: 'Picks a battle stance' },
          { kind: 'check', key: 'aiDuskEconomy', label: 'Spends the day at dusk' },
          { kind: 'check', key: 'aiFrontCaravans', label: 'Caravans garrisons forward' },
          { kind: 'check', key: 'aiCapitolRush', label: 'Rushes the Capitol' },
        ],
      },
      {
        title: 'Combat tuning',
        scope: 'live',
        rows: [
          { kind: 'slider', key: 'siegeTowerDamage', label: 'Siege tower damage', min: 0.5, max: 6, fmt: mult },
        ],
      },
      {
        title: 'Balance model',
        scope: 'game',
        note: 'Read when a new game starts.',
        rows: [
          { kind: 'slider', key: 'heroPowerWeight', label: 'Hero-strength weight', min: 0, max: 3, fmt: pct },
        ],
      },
      {
        title: 'Diagnostics',
        scope: 'device',
        rows: [
          { kind: 'check', key: 'strictAssets', label: 'Strict assets (MISSING art)' },
          { kind: 'check', key: 'uiTelemetry', label: 'Count what I click' },
          { kind: 'action', id: 'exportLog', label: 'Export game log' },
          { kind: 'action', id: 'exportUsage', label: 'Export usage stats' },
        ],
      },
    ],
  },
];

/** Every settings key the screen offers, in declaration order. */
export function offeredKeys() {
  const out = [];
  for (const page of SETTINGS_PAGES) {
    for (const s of page.sections) {
      if (s.headerCheck) out.push(s.headerCheck);
      for (const r of s.rows) {
        if (r.key) out.push(r.key);
        if (r.offKey) out.push(r.offKey);
        if (r.powerKey) out.push(r.powerKey);
      }
    }
  }
  return out;
}

/** The height a packed row occupies. */
const rowHeight = (r) => ROW_H[r.kind === 'check' ? 'checkPair' : r.kind];

/**
 * Fold a section's rows into drawable entries: consecutive checkboxes pair up
 * two-to-a-row, everything else passes through.
 */
function foldRows(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind !== 'check') { out.push({ ...r, h: rowHeight(r) }); continue; }
    const last = out[out.length - 1];
    if (last?.kind === 'checkPair' && last.items.length < 2) last.items.push(r);
    else out.push({ kind: 'checkPair', items: [r], h: ROW_H.checkPair });
  }
  return out;
}

/**
 * A section as a single indivisible block: its header plus its folded rows.
 *
 * Indivisible is the point. flow()'s old 96px reserve stopped a HEADER stranding
 * at a column foot but said nothing about the body beneath it, so a section
 * could still be cut mid-run and leave rows at the top of the next column with
 * no heading above them — which happens on the shipped screen today.
 */
function toBlocks(sections) {
  return sections.map((s) => {
    const rows = foldRows(s.rows);
    const headerH = s.note ? ROW_H.headerNote : ROW_H.header;
    return { section: s, rows, headerH, h: headerH + rows.reduce((n, r) => n + r.h, 0) };
  });
}

/**
 * Split any block too tall for one column into continuation blocks, so that
 * every block is placeable. Nothing is ever dropped — the continuation carries
 * the same title so the player can see it runs on.
 */
function splitOversized(blocks, colH) {
  const out = [];
  for (const b of blocks) {
    if (b.h <= colH) { out.push(b); continue; }
    let rows = b.rows, first = true;
    while (rows.length) {
      const headerH = first && b.section.note ? ROW_H.headerNote : ROW_H.header;
      const take = [];
      let used = headerH;
      while (rows.length && used + rows[0].h <= colH) { used += rows[0].h; take.push(rows.shift()); }
      if (!take.length) take.push(rows.shift()); // a single row taller than a column: place it anyway
      out.push({
        section: first ? b.section : { ...b.section, title: `${b.section.title} (cont.)`, note: null, headerCheck: null },
        rows: take, headerH, h: headerH + take.reduce((n, r) => n + r.h, 0), continued: !first,
      });
      first = false;
    }
  }
  return out;
}

/**
 * Split a contiguous run of blocks into `cols` columns, minimising the TALLEST
 * column. Greedy filling gives a lopsided panel; balanced is what lets the panel
 * size down to its content instead of always maxing out at 720px.
 */
function balance(blocks, cols) {
  const n = blocks.length;
  if (!n) return [];
  const memo = new Map();
  const best = (i, c) => {
    if (i >= n) return { max: 0, cuts: [] };
    if (c === 1) return { max: blocks.slice(i).reduce((s, b) => s + b.h + SECTION_GAP, 0), cuts: [] };
    const memoKey = `${i}:${c}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    let acc = 0, top = null;
    for (let j = i; j < n; j++) {
      acc += blocks[j].h + SECTION_GAP;
      const rest = best(j + 1, c - 1);
      const m = Math.max(acc, rest.max);
      if (!top || m < top.max) top = { max: m, cuts: [j + 1, ...rest.cuts] };
    }
    memo.set(memoKey, top);
    return top;
  };
  const { cuts } = best(0, cols);
  const columns = [];
  let prev = 0;
  for (const cut of [...cuts, n]) { columns.push(blocks.slice(prev, cut)); prev = cut; }
  return columns.slice(0, cols);
}

/**
 * Lay a page out. Returns physical pages — plural, because a declared page that
 * cannot fit its columns PAGES rather than overflowing.
 *
 * That is the whole fix for the reported bug. The old flow() advanced a column
 * only while `ci < COLS - 1`; in the last column the guard failed silently and
 * rows kept being drawn at absolute y, below the panel and across the button
 * row. There was no scrollbar, no pager and no clipping mask, so the screen did
 * not read as truncated — it read as finished, with five to six of the
 * optional-feature toggles unreachable at every common viewport.
 */
export function packPage(sections, { pw, maxH, cols = 2, pad = 34, gap = 30 }) {
  const colW = Math.floor((pw - pad * 2 - gap * (cols - 1)) / cols);
  const top = CHROME_TOP;
  const colH = maxH - CHROME_TOP - CHROME_BOTTOM;

  const blocks = splitOversized(toBlocks(sections), colH);

  // Fill physical pages: take as many blocks as `cols` balanced columns hold.
  const pages = [];
  let rest = blocks;
  while (rest.length) {
    let take = rest.length;
    while (take > 0 && Math.max(...balance(rest.slice(0, take), cols).map((c) => c.reduce((n, b) => n + b.h + SECTION_GAP, 0)), 0) > colH) take--;
    take = Math.max(1, take);
    pages.push(balance(rest.slice(0, take), cols));
    rest = rest.slice(take);
  }

  // Place everything at real coordinates, panel-local.
  return pages.map((columns) => {
    const items = [];
    let tallest = 0;
    columns.forEach((col, ci) => {
      let cy = top;
      const x = pad + ci * (colW + gap);
      for (const b of col) {
        if (cy > top) cy += SECTION_GAP;
        items.push({ type: 'header', section: b.section, x, y: cy, w: colW, h: b.headerH });
        cy += b.headerH;
        for (const r of b.rows) { items.push({ type: 'row', row: r, section: b.section, x, y: cy, w: colW, h: r.h }); cy += r.h; }
      }
      tallest = Math.max(tallest, cy - top);
    });
    return { items, colW, tallest, panelH: tallest + CHROME_TOP + CHROME_BOTTOM, colH };
  });
}

/**
 * Pack every declared page against one viewport, and report the panel height they
 * must share.
 *
 * Shared, because a panel sized per-page would move the tabs and the Back button
 * under the pointer as you switch between a 564px page and a 314px one.
 */
export function packAll(W, H, { cols = 2 } = {}) {
  const pw = Math.min(W - 40, 1180);
  const maxH = Math.min(H - 24, 720);
  const packed = SETTINGS_PAGES.map((page) => ({ page, physical: packPage(page.sections, { pw, maxH, cols }) }));
  const panelH = Math.min(maxH, Math.max(...packed.flatMap((p) => p.physical.map((x) => x.panelH))));
  return { pw, panelH, maxH, packed };
}
