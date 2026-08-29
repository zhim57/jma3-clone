/**
 * spellbook.js — a shared, pictogram spellbook overlay.
 *
 * One grid-of-icons dialog used by all three places a player meets spells: the
 * town Mage Guild (browse), the combat spellbook (cast now) and the adventure
 * spellbook (cast on the map). Spells show as pictograms (see gfx/spellIcons);
 * click one to read its description and, when an action is offered, Cast/Learn it.
 *
 * When two groups are given (e.g. Combat + Adventure) they become tabs. The whole
 * thing is drawn at absolute screen coords under a root container at (0,0), like
 * the other modal dialogs, so it layers cleanly over any scene.
 *
 * opts:
 *   title            header text
 *   subtitle?        small line under the title (e.g. mana available)
 *   groups           [{ label, spells:[id] }] — 1 group = no tabs, 2+ = tabs
 *   actionLabel?     e.g. 'Cast' / 'Learn' — omit for a browse-only book
 *   canAct?(id)      → bool, enables the action button for that spell
 *   actNote?(id)     → string|null, a short reason shown when !canAct
 *   costOf?(id)      → the mana this READER actually pays. Magic-school mastery
 *                      discounts a spell in its own school, so the book must not
 *                      print the catalog price while the engine charges another
 *                      (see src/core/magic.js). Omit in a browse-only book with
 *                      no hero — the catalog price is then correct.
 *   noteOf?(id)      → string|null, a line under the description saying what
 *                      mastery is doing to this spell (mass cast, cheaper)
 *   onAct?(id)       invoked after the overlay closes (the actual cast/learn)
 *   footer?          a status line pinned near the bottom (e.g. 'studied: …')
 *   extra?           one wide button on its own row at the foot of the panel:
 *                    { label, onClick, note?, enabled? }. For an action about the
 *                    PLACE rather than a spell — the town Mage Guild uses it to
 *                    commission the next guild level without sending the player
 *                    back out to the build grid. `note` prints under it (a cost,
 *                    or the reason the button is dead).
 *   onClose?
 */

import { panel, button, iconButton, label, trackModal, pinToScreen, COLORS, DEPTH } from './uikit.js';
import { spellIcon } from '../gfx/sprites.js';
import { SPELLS } from '../data/spells.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const tierSort = (a, b) => (SPELLS[a].tier - SPELLS[b].tier) || SPELLS[a].name.localeCompare(SPELLS[b].name);

export function openSpellbook(scene, opts) {
  const groups = (opts.groups || []).filter((g) => (g.spells || []).length);
  const W = scene.scale.width, H = scene.scale.height;

  const root = scene.add.container(0, 0).setDepth(DEPTH.MODAL);
  // Register as a live modal so scenes that gate world input on modalOpen() (the
  // combat grid's scene-level pointerup) don't process clicks that land on this
  // overlay — otherwise picking a spell also moves a unit on the battlefield.
  trackModal(root);
  root.add(scene.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.6).setInteractive());

  const close = () => { root.destroy(); opts.onClose?.(); };

  if (!groups.length) {
    root.add(scene.add.rectangle(W / 2, H / 2, 380, 150, 0x201c2e).setStrokeStyle(2, 0x4a4560));
    root.add(label(scene, W / 2, H / 2 - 20, opts.title || 'Spellbook', { size: '18px', bold: true, ox: 0.5, color: COLORS.gold }));
    root.add(label(scene, W / 2, H / 2 + 8, 'No spells in this book yet.', { size: '13px', ox: 0.5, color: COLORS.dim }));
    root.add(button(scene, W / 2, H / 2 + 46, 120, 32, 'Close', close));
    bindEsc(scene, root, close);
    pinToScreen(root);
    return root;
  }

  const COLS = 6, CELL_H = 92;
  const maxRows = Math.max(1, ...groups.map((g) => Math.ceil(g.spells.length / COLS)));
  const tabbed = groups.length > 1;
  const w = Math.min(760, W - 20); // wider cells so a spell's name fits & reads
  const gridTopOff = tabbed ? 96 : 62;
  // An `extra` action gets its own row, and the panel grows to hold it rather than
  // the detail strip shrinking — the strip is where a spell is actually read.
  const extraH = opts.extra ? 46 : 0;
  // A book that can report magic-school mastery keeps a line for it, so the
  // note never lands on top of a two-line description.
  const noteH = opts.noteOf ? 20 : 0;
  const h = Math.min(H - 20, gridTopOff + maxRows * CELL_H + 128 + extraH + noteH);
  const px = (W - w) / 2, py = (H - h) / 2;

  let activeTab = 0;
  let selected = null;

  // Everything below the persistent chrome is redrawn on tab/selection change.
  const content = scene.add.container(0, 0);

  const rebuild = () => {
    content.removeAll(true);
    const grp = groups[activeTab];
    const ids = [...grp.spells].sort(tierSort);

    if (tabbed) {
      const tabW = 150, gap = 10;
      let tx = W / 2 - (groups.length * tabW + (groups.length - 1) * gap) / 2 + tabW / 2;
      groups.forEach((g, i) => {
        content.add(button(scene, tx, py + 62, tabW, 30, g.label,
          () => { if (i !== activeTab) { activeTab = i; selected = null; rebuild(); } },
          { blue: i === activeTab, fontSize: '13px' }));
        tx += tabW + gap;
      });
    }

    // Grid of pictograms.
    const gridTop = py + gridTopOff;
    const cellW = (w - 44) / COLS;
    ids.forEach((id, idx) => {
      const cx = px + 22 + cellW / 2 + (idx % COLS) * cellW;
      const cy = gridTop + Math.floor(idx / COLS) * CELL_H + 30;
      const sel = id === selected;
      content.add(scene.add.rectangle(cx, cy - 4, cellW - 8, CELL_H - 10, sel ? 0x2a3550 : 0x14121f, sel ? 1 : 0.4)
        .setStrokeStyle(2, sel ? 0xe8c060 : 0x3a3550)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => scene.tooltip?.show(p.x, p.y, `${SPELLS[id].name}\n${SPELLS[id].desc || ''}`))
        .on('pointerout', () => scene.tooltip?.hide())
        .on('pointerup', () => { scene.tooltip?.hide(); selected = id; rebuild(); }));
      content.add(spellIcon(scene, id, cx, cy - 18, 40));
      content.add(label(scene, cx, cy + 12, SPELLS[id].name,
        { size: '12.5px', bold: true, ox: 0.5, color: sel ? COLORS.gold : COLORS.parchment, align: 'center', wrap: cellW - 12 }));
    });

    // Detail strip — the spell's explanation, opened by clicking its pictogram.
    const dTop = py + h - 104 - extraH - noteH;
    content.add(scene.add.rectangle(px + 20, dTop, w - 40, 90 + noteH, 0x0c0a14, 0.6).setOrigin(0, 0).setStrokeStyle(1, 0x3a3550));
    if (selected) {
      const sp = SPELLS[selected];
      const cost = opts.costOf ? opts.costOf(selected) : sp.manaCost;
      const meta = `Tier ${sp.tier}${sp.school ? `  ·  ${cap(sp.school)}` : ''}  ·  ${cost} mana`
        + (cost !== sp.manaCost ? ` (was ${sp.manaCost})` : '');
      const actW = opts.actionLabel ? 176 : 20; // reserve room for the action button
      content.add(label(scene, px + 36, dTop + 12, sp.name, { size: '18px', bold: true, color: COLORS.gold }));
      content.add(label(scene, px + 36, dTop + 37, meta, { size: '13px', color: COLORS.dim }));
      content.add(label(scene, px + 36, dTop + 58, sp.desc, { size: '14px', color: COLORS.parchment, wrap: w - 72 - actW }));
      const mastery = opts.noteOf ? opts.noteOf(selected) : null;
      if (mastery) content.add(label(scene, px + 36, dTop + 82, `✦ ${mastery}`, { size: '12px', color: COLORS.good, wrap: w - 72 - actW }));
      if (opts.actionLabel) {
        const can = opts.canAct ? !!opts.canAct(selected) : true;
        const act = button(scene, px + w - 108, dTop + 28, 156, 38, opts.actionLabel,
          () => { if (!can) return; close(); opts.onAct?.(selected); }, { blue: true, fontSize: '15px' });
        if (!can) act.setEnabled(false);
        content.add(act);
        const note = (!can && opts.actNote) ? opts.actNote(selected) : null;
        if (note) content.add(label(scene, px + w - 108, dTop + 60, note, { size: '11px', ox: 0.5, color: COLORS.danger }));
      }
    } else {
      content.add(label(scene, W / 2, dTop + 34, '☞ Click a spell to read what it does.',
        { size: '14px', ox: 0.5, color: COLORS.dim }));
    }
    pinToScreen(content); // rebuilt children must be screen-pinned too
  };

  // Persistent chrome (survives rebuilds).
  root.add(panel(scene, px, py, w, h));
  root.add(label(scene, W / 2, py + 16, opts.title, { size: '20px', bold: true, color: COLORS.gold, ox: 0.5 }));
  if (opts.subtitle) root.add(label(scene, W / 2, py + 40, opts.subtitle, { size: '12px', color: COLORS.dim, ox: 0.5 }));
  if (opts.footer) root.add(label(scene, px + 30, py + h - 12 - extraH, opts.footer, { size: '11px', color: COLORS.good }));
  if (opts.extra) {
    const ex = opts.extra;
    const btn = button(scene, W / 2, py + h - 38, Math.min(380, w - 80), 34, ex.label,
      () => { if (ex.enabled === false) return; close(); ex.onClick?.(); },
      { blue: true, fontSize: '13px' });
    if (ex.enabled === false) btn.setEnabled(false);
    root.add(btn);
    if (ex.note) root.add(label(scene, W / 2, py + h - 15, ex.note,
      { size: '10.5px', ox: 0.5, color: ex.enabled === false ? COLORS.danger : COLORS.dim }));
  }
  root.add(iconButton(scene, px + w - 24, py + 22, 30, '✕', close, { tooltip: 'Close' }));
  root.add(content); // grid/detail draw over the panel chrome
  rebuild();

  bindEsc(scene, root, close);
  // The grid is rebuilt on tab/selection change, so re-pin after every rebuild.
  pinToScreen(root);
  return root;
}

function bindEsc(scene, root, close) {
  const kb = scene.input?.keyboard;
  if (!kb) return;
  const onEsc = () => close();
  kb.once('keydown-ESC', onEsc);
  root.once('destroy', () => kb.off('keydown-ESC', onEsc));
}
