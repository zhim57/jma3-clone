/**
 * SaveLoadScene — the named-save browser.
 *
 * Two modes over the same list:
 *   'save' — launched from inside a game: type a title (a sensible default is
 *            pre-filled) and write a new slot, or click an existing row to
 *            overwrite it.
 *   'load' — launched from the menu: pick a save to resume.
 * Every row shows its title, the date it was written, and a summary — day, gold,
 * heroes, towns, and the campaign chapter when it is one — so a campaign can be
 * branched or rolled back instead of being overwritten forever.
 *
 * The list is paged rather than free-scrolled: Phaser needs a camera/mask to clip
 * a scrolling column, and pages keep the whole thing to plain buttons.
 */

import Phaser from 'phaser';
import { campaignById } from '../data/campaigns.js';
import {
  getState, listSaves, saveGameAs, loadSaveById, deleteSave, suggestSaveName, formatSavedAt,
} from '../game/session.js';
import { panel, inset, label, button, showDialog, COLORS, destroyAllChildren } from '../ui/uikit.js';

const PER_PAGE = 6;
const NAME_MAX = 40;

export class SaveLoadScene extends Phaser.Scene {
  constructor() { super('SaveLoad'); }

  init(data) {
    this.mode = data?.mode === 'save' ? 'save' : 'load';
    this.onClose = data?.onClose || null;
    // Where to go when a save is loaded: the caller owns the transition, because
    // loading from the menu and loading from a live game unwind differently.
    this.onLoaded = data?.onLoaded || null;
    this.page = 0;
    this.nameBuf = this.mode === 'save' ? suggestSaveName(getState()) : '';
    // The field opens PRE-FILLED with a suggestion. Treat it like a selected
    // default: the first thing typed REPLACES it rather than appending to it
    // (otherwise "Day 27" + "Boss fight" reads "Day 27Boss fight").
    this.pristine = true;
  }

  create() {
    this.scene.bringToTop();
    this.render();
    this.input.keyboard?.on('keydown', (e) => this.onKey(e));
    this.events.once('shutdown', () => this.input.keyboard?.off('keydown'));
  }

  /** Type into the title field (save mode only); Esc leaves, Enter commits. */
  onKey(e) {
    if (e.key === 'Escape') { this.close(); return; }
    if (this.mode !== 'save') return;
    if (e.key === 'Enter') { this.commitSave(); return; }
    if (e.key === 'Backspace') {
      // Backspacing a still-pristine suggestion clears the whole thing at once —
      // nobody wants to hold Backspace through a pre-filled default.
      this.nameBuf = this.pristine ? '' : this.nameBuf.slice(0, -1);
      this.pristine = false;
      this.render();
      return;
    }
    // Printable single characters only — ignore F-keys, arrows, modifiers.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      if (this.pristine) { this.nameBuf = ''; this.pristine = false; }
      if (this.nameBuf.length < NAME_MAX) this.nameBuf += e.key;
      this.render();
    }
  }

  /** One line describing what a save contains. */
  rowDetail(m) {
    const bits = [`Day ${m.day}`];
    if (m.campaignId) {
      const camp = campaignById(m.campaignId);
      const chapter = (m.scenarioIndex ?? 0) + 1;
      bits.push(`${camp?.name || m.campaignId} — ch.${chapter}${m.chapterWon ? ' (won)' : ''}`);
    }
    bits.push(`${m.towns} town${m.towns === 1 ? '' : 's'}`, `${m.heroes} hero${m.heroes === 1 ? '' : 'es'}`,
      `${(m.gold || 0).toLocaleString()}g`);
    return bits.join('  ·  ');
  }

  render() {
    destroyAllChildren(this);
    const W = this.scale.width, H = this.scale.height;
    this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.66).setInteractive();

    const pw = Math.min(W - 40, 900);
    const ph = Math.min(H - 24, 660);
    const px = (W - pw) / 2, py = (H - ph) / 2;
    panel(this, px, py, pw, ph);
    label(this, W / 2, py + 22, this.mode === 'save' ? 'Save Game' : 'Load Game',
      { size: '22px', bold: true, color: COLORS.gold, ox: 0.5 });

    let y = py + 58;

    // ---- save mode: the title field -----------------------------------------
    if (this.mode === 'save') {
      label(this, px + 30, y, this.pristine
        ? 'Type a name (this replaces the suggestion below), then press Enter or click Save:'
        : 'Press Enter or click Save:', { size: '12px', color: COLORS.dim });
      y += 20;
      inset(this, px + 30, y, pw - 190, 36);
      // A pristine suggestion is dimmed, like placeholder text, so it reads as
      // "about to be replaced" rather than as something you must delete.
      label(this, px + 42, y + 18, this.nameBuf || ' ',
        { size: '15px', color: this.pristine ? COLORS.dim : COLORS.parchment, oy: 0.5 });
      // A blinking caret would need an update loop; a static bar reads fine.
      label(this, px + 42 + Math.min(this.nameBuf.length * 8.2, pw - 230), y + 18, '|',
        { size: '15px', color: COLORS.gold, oy: 0.5 });
      button(this, px + pw - 100, y + 18, 130, 36, 'Save', () => this.commitSave(), { blue: true, fontSize: '14px' });
      y += 54;
    }

    // ---- the list -----------------------------------------------------------
    const all = listSaves();
    const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    const rows = all.slice(this.page * PER_PAGE, this.page * PER_PAGE + PER_PAGE);

    if (!all.length) {
      label(this, W / 2, y + 60, this.mode === 'save'
        ? 'No saved games yet — name one above and press Save.'
        : 'No saved games yet.', { size: '14px', color: COLORS.dim, ox: 0.5 });
    }

    const rowH = 64;
    for (const m of rows) {
      inset(this, px + 30, y, pw - 60, rowH - 8);
      label(this, px + 46, y + 14, m.name, { size: '15px', bold: true, color: COLORS.parchment });
      label(this, px + 46, y + 34, `${formatSavedAt(m.savedAt)}   ·   ${this.rowDetail(m)}`,
        { size: '11px', color: COLORS.dim });
      // Primary action: overwrite this slot (save mode) or resume it (load mode).
      button(this, px + pw - 176, y + 26, 104, 32,
        this.mode === 'save' ? 'Overwrite' : 'Load',
        () => (this.mode === 'save' ? this.commitSave(m.name) : this.doLoad(m)),
        { blue: true, fontSize: '12px' });
      button(this, px + pw - 86, y + 26, 62, 32, 'Delete', () => this.confirmDelete(m), { fontSize: '12px' });
      y += rowH;
    }

    // ---- paging + exit ------------------------------------------------------
    const by = py + ph - 38;
    if (pages > 1) {
      button(this, W / 2 - 150, by, 60, 32, '◀', () => { this.page--; this.render(); }, { fontSize: '13px' });
      label(this, W / 2, by, `Page ${this.page + 1} / ${pages}`, { size: '12px', color: COLORS.dim, ox: 0.5, oy: 0.5 });
      button(this, W / 2 + 150, by, 60, 32, '▶', () => { this.page++; this.render(); }, { fontSize: '13px' });
    }
    button(this, W / 2 + 300, by, 120, 34, 'Back', () => this.close(), { fontSize: '14px' });
  }

  async commitSave(nameOverride) {
    const name = nameOverride ?? this.nameBuf;
    const meta = await saveGameAs(name);
    if (!meta) {
      showDialog(this, { title: 'Save failed', lines: ['Browser storage is unavailable or full.'] });
      return;
    }
    this.nameBuf = meta.name;
    this.page = 0;
    this.render();
    label(this, this.scale.width / 2, this.scale.height - 26, `Saved as “${meta.name}”.`,
      { size: '13px', color: COLORS.good, ox: 0.5 });
  }

  async doLoad(m) {
    if (!await loadSaveById(m.id)) {
      showDialog(this, { title: 'Load failed', lines: ['That save could not be read — it may be corrupt.'] });
      return;
    }
    if (this.onLoaded) { this.onLoaded(); return; }
    this.scene.stop();
    this.scene.start('Adventure');
  }

  confirmDelete(m) {
    showDialog(this, {
      title: 'Delete this save?',
      lines: [`“${m.name}” — ${formatSavedAt(m.savedAt)}.`, 'This cannot be undone.'],
      buttons: [
        { text: 'Delete', onClick: async () => { await deleteSave(m.id); this.render(); } },
        { text: 'Keep', blue: true, onClick: () => {} },
      ],
    });
  }

  close() {
    this.scene.stop();
    this.onClose?.();
  }
}
