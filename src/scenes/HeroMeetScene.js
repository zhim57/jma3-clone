/**
 * HeroMeetScene — Two same-owner heroes meet on the map and exchange troops.
 *
 * Modal overlay showing both heroes' 7-slot armies side by side. Click a stack
 * then a slot (in either army) to move / merge / swap; click the same stack
 * twice to split it in half into the next empty slot; or "Swap Armies" to trade
 * the whole army. A hero can never be emptied to zero stacks.
 */

import Phaser from 'phaser';
import { CONFIG } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { ARTIFACTS, EQUIP_SOCKETS } from '../data/artifacts.js';
import { unitIcon, heroPortrait, artifactIcon } from '../gfx/sprites.js';
import { getState } from '../game/session.js';
import { moveStack, splitStack, giveArtifactToHero } from '../core/actions.js';
import { panel, button, label, showDialog, Tooltip, FONT, COLORS, destroyAllChildren, modalOpen } from '../ui/uikit.js';

export class HeroMeetScene extends Phaser.Scene {
  constructor() {
    super('HeroMeet');
  }

  init(data) {
    this.aId = data.heroAId;
    this.bId = data.heroBId;
    this.onClose = data.onClose;
    this.picked = null; // { army, index }
  }

  create() {
    this.state = getState();
    this.buildAll();
    this.input.keyboard.on('keydown-ESC', () => { if (!modalOpen()) this.close(); });
    this.scale.on('resize', this.buildAll, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.buildAll, this));
  }

  close() {
    this.tooltip?.hide();
    this.scene.stop();
    this.onClose?.();
  }

  buildAll() {
    destroyAllChildren(this);
    this.tooltip = new Tooltip(this);
    const a = this.state.heroes[this.aId];
    const b = this.state.heroes[this.bId];
    if (!a || !b) { this.close(); return; }
    const W = this.scale.width, H = this.scale.height;
    this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x060510, 0.82);
    const mw = Math.min(760, W - 24), mh = Math.min(420, H - 20);
    const mx = (W - mw) / 2, my = (H - mh) / 2;
    panel(this, mx, my, mw, mh);
    label(this, mx + mw / 2, my + 18, 'Hero Meeting', { size: '18px', bold: true, ox: 0.5, color: COLORS.gold });
    button(this, mx + mw - 54, my + 26, 76, 32, 'Done', () => this.close(), { blue: true });

    const colW = (mw - 60) / 2;
    this.heroColumn(a, mx + 24, my + 64, colW);
    this.heroColumn(b, mx + 36 + colW, my + 64, colW);

    const artY = my + 168;
    this.artifactRow(a, b, mx + 24, artY, colW);
    this.artifactRow(b, a, mx + 36 + colW, artY, colW);

    button(this, mx + mw / 2, my + mh - 36, 160, 32, '⇄ Swap Armies', () => {
      for (let i = 0; i < CONFIG.ARMY_SLOTS; i++) {
        const t = a.army[i] || null;
        a.army[i] = b.army[i] || null;
        b.army[i] = t;
      }
      this.picked = null;
      this.buildAll();
    });
    label(this, mx + 22, my + mh - 22,
      'Click a stack then a slot to move · same stack twice splits · click an artifact to hand it across',
      { size: '11px', color: COLORS.dim });
  }

  heroColumn(hero, x, y, w) {
    heroPortrait(this, hero, x + 22, y + 6, 40);
    label(this, x + 50, y - 6, hero.name, { size: '14px', bold: true, color: COLORS.gold });
    label(this, x + 50, y + 12, `Level ${hero.level} ${hero.className}`, { size: '11px', color: COLORS.dim });
    const slot = Math.min(48, (w - 4) / CONFIG.ARMY_SLOTS);
    const sy = y + 40;
    for (let i = 0; i < CONFIG.ARMY_SLOTS; i++) {
      const sx = x + i * slot;
      const stack = hero.army[i];
      const picked = this.picked && this.picked.army === hero.army && this.picked.index === i;
      const cell = this.add.rectangle(sx + slot / 2, sy + 26, slot - 4, 52, 0x14121f)
        .setStrokeStyle(2, picked ? 0xe8c060 : 0x4a4560)
        .setInteractive({ useHandCursor: true });
      if (stack && stack.count > 0) {
        const c = CREATURES[stack.creature];
        // Drawn on top of the cell but deliberately NOT interactive. Phaser's
        // input.topOnly defaults to true, so an interactive icon here swallows
        // every press that lands on it and only the strip of cell around it — in
        // practice the bottom corner holding the count — could still be clicked.
        // Reported as "only the corner with the number is responsive". The cell
        // owns both the click and the hover for the whole rectangle instead.
        unitIcon(this, stack.creature, sx + slot / 2, sy + 20, slot - 14);
        this.add.text(sx + slot - 4, sy + 46, `${stack.count}`, {
          fontFamily: FONT, fontSize: '11px', fontStyle: 'bold', color: '#ffe9b0', stroke: '#000', strokeThickness: 3,
        }).setOrigin(1);
        cell.on('pointerover', (p) => this.tooltip.show(p.x, p.y, `${c.name} ×${stack.count}`))
          .on('pointerout', () => this.tooltip.hide());
      }
      cell.on('pointerup', () => {
        this.tooltip.hide();
        this.onSlotClick(hero.army, i);
      });
    }
  }

  /**
   * A hero's tradeable artifacts (equipped sockets first, then backpack) as a
   * wrapping grid of clickable icons. Worn artifacts get a blue border, carried
   * ones gray. Clicking hands the artifact to `other` via giveArtifactToHero,
   * then rebuilds so indices stay fresh.
   */
  artifactRow(hero, other, x, y, w) {
    label(this, x, y, 'Artifacts', { size: '12px', bold: true, color: COLORS.gold });
    const items = [];
    for (const socket of Object.keys(EQUIP_SOCKETS)) {
      const id = hero.equipment[socket];
      if (id) items.push({ id, source: { equip: socket }, worn: true });
    }
    hero.backpack.forEach((id, idx) => items.push({ id, source: { backpack: idx }, worn: false }));
    if (!items.length) {
      label(this, x, y + 20, 'None to trade.', { size: '11px', color: COLORS.dim });
      return;
    }
    const size = 30, gap = 6;
    const perRow = Math.max(1, Math.floor((w + gap) / (size + gap)));
    items.forEach((it, k) => {
      const col = k % perRow, row = Math.floor(k / perRow);
      const cx = x + col * (size + gap) + size / 2;
      const cy = y + 22 + row * (size + gap) + size / 2;
      // Same rule as the army slots: the frame owns the input, the icon on top
      // stays inert, so the whole square is clickable and not just the art.
      const frame = this.add.rectangle(cx, cy, size, size, 0x14121f)
        .setStrokeStyle(2, it.worn ? 0x6ea8ff : 0x4a4560);
      const art = ARTIFACTS[it.id];
      artifactIcon(this, it.id, cx, cy, size - 6);
      frame.setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => this.tooltip.show(p.x, p.y,
          `${art ? art.name : it.id}${art ? '\n' + art.desc : ''}\nClick → give to ${other.name}`))
        .on('pointerout', () => this.tooltip.hide())
        .on('pointerup', () => {
          this.tooltip.hide();
          giveArtifactToHero(this.state, hero, other, it.source);
          this.picked = null;
          this.buildAll();
        });
    });
  }

  onSlotClick(army, i) {
    if (!this.picked) {
      if (army[i] && army[i].count > 0) this.picked = { army, index: i };
    } else if (this.picked.army === army && this.picked.index === i) {
      const empty = army.findIndex((sk) => !sk || sk.count <= 0);
      if (empty >= 0) splitStack(army, i, army, empty);
      this.picked = null;
    } else if (this.wouldEmptyHero(army, i)) {
      this.picked = null;
      showDialog(this, { title: 'Command refused', lines: ['A hero cannot be left without a single creature stack.'] });
      return;
    } else {
      moveStack(this.picked.army, this.picked.index, army, i);
      this.picked = null;
    }
    this.buildAll();
  }

  /** Would moving the picked stack out leave its source hero with no stacks? */
  wouldEmptyHero(destArmy, destIdx) {
    const src = this.picked;
    if (src.army === destArmy) return false;
    const moving = src.army[src.index];
    const dest = destArmy[destIdx];
    if (dest && dest.count > 0 && dest.creature !== moving?.creature) return false; // swap returns a stack
    const remaining = src.army.filter((s, j) => s && s.count > 0 && j !== src.index).length;
    return remaining === 0;
  }
}
