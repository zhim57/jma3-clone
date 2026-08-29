/**
 * HeroScene — Hero sheet overlay: primary/secondary stats, XP, army,
 * paper-doll artifact equipment with backpack, and the spellbook.
 */

import Phaser from 'phaser';
import { XP_TABLE } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { ARTIFACTS, EQUIP_SOCKETS, ARTIFACT_SETS, activeArtifactSets } from '../data/artifacts.js';
import { unitIcon, heroPortrait, artifactIcon } from '../gfx/sprites.js';
import { SKILLS, SKILL_LEVEL_NAMES } from '../data/skills.js';
import { specialtyText } from '../data/heroes.js';
import { SPELLS } from '../data/spells.js';
import { getState } from '../game/session.js';
import { equipArtifact, unequipArtifact, moveStack, splitStack, disbandStack } from '../core/actions.js';
import {
  heroStat, heroMaxMana, heroMaxMovement, heroMorale, heroLuck,
} from '../core/heroUtils.js';
import { panel, inset, button, label, Tooltip, COLORS, destroyAllChildren, modalOpen, showDialog } from '../ui/uikit.js';

const SOCKET_LAYOUT = [
  ['head', 'Head'], ['neck', 'Neck'], ['cape', 'Cape'],
  ['weapon', 'Weapon'], ['torso', 'Torso'], ['shield', 'Shield'],
  ['ring1', 'Ring'], ['feet', 'Feet'], ['ring2', 'Ring'],
  ['misc1', 'Misc'], ['misc2', 'Misc'],
];

export class HeroScene extends Phaser.Scene {
  constructor() {
    super('Hero');
  }

  init(data) {
    this.heroId = data.heroId;
    this.onClose = data.onClose;
  }

  create() {
    this.state = getState();
    this.tooltip = new Tooltip(this);
    this.buildAll();
    this.input.keyboard.on('keydown-ESC', () => { if (!modalOpen()) this.close(); });
    this.scale.on('resize', this.buildAll, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.buildAll, this));
  }

  close() {
    this.tooltip.hide();
    this.scene.stop();
    this.onClose?.();
  }

  /**
   * Army slot clicked: pick a stack up, put it down, or split it.
   *
   * The same three gestures as the town's garrison row and the hero-meet screen,
   * so the arrangement is made the same way everywhere:
   *   empty hand + a stack   → pick it up
   *   full hand + the SAME slot → split it into the first free slot
   *   full hand + another slot  → move there, or merge if it holds the same creature
   *
   * Nothing here can leave the hero without an army — every move stays inside the
   * one array — so there is no stranding rule to enforce, unlike the town.
   */
  /**
   * Shift-click dismisses a stack. It is a destructive, irreversible act, so it
   * asks first and it is deliberately NOT on the plain click that every other
   * army gesture uses — a misclick must never cost an army. The engine owns the
   * rule about a hero's last stack (see actions.disbandStack); this only
   * reports the refusal.
   */
  onSlotDisband(hero, i) {
    const stack = hero.army[i];
    if (!stack || stack.count <= 0) return;
    const c = CREATURES[stack.creature];
    if (hero.army.filter((s) => s && s.count > 0).length <= 1) {
      showDialog(this, {
        title: 'Command refused',
        lines: ['A hero cannot march without at least one creature stack.'],
      });
      return;
    }
    showDialog(this, {
      title: 'Disband stack',
      lines: [`Dismiss ${stack.count} ${c.name}?`, 'They leave the army for good.'],
      buttons: [
        { text: 'Keep them' },
        { text: '✖ Disband', blue: true, onClick: () => { disbandStack(hero.army, i); this.buildAll(); } },
      ],
    });
  }

  onSlotClick(hero, i) {
    if (this.picked === null || this.picked === undefined) {
      if (hero.army[i] && hero.army[i].count > 0) this.picked = i;
    } else if (this.picked === i) {
      const free = hero.army.findIndex((s) => !s || s.count <= 0);
      if (free >= 0) splitStack(hero.army, i, hero.army, free);
      this.picked = null;
    } else {
      moveStack(hero.army, this.picked, hero.army, i);
      this.picked = null;
    }
    this.buildAll();
  }

  buildAll() {
    destroyAllChildren(this);
    this.tooltip = new Tooltip(this);
    if (this.picked === undefined) this.picked = null;
    if (this.packPage === undefined) this.packPage = 0;
    const hero = this.state.heroes[this.heroId];
    if (!hero) { this.close(); return; }
    const W = this.scale.width, H = this.scale.height;
    this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x060510, 0.82);
    const mw = Math.min(980, W - 24), mh = Math.min(680, H - 20);
    const mx = (W - mw) / 2, my = (H - mh) / 2;
    panel(this, mx, my, mw, mh);

    // ---- identity ----
    heroPortrait(this, hero, mx + 56, my + 56, 80);
    label(this, mx + 108, my + 20, hero.name, { size: '24px', bold: true, color: COLORS.gold });
    label(this, mx + 108, my + 50, `Level ${hero.level} ${hero.className}`, { size: '14px', color: COLORS.dim });
    const nextXp = XP_TABLE[hero.level + 1] ?? Infinity;
    label(this, mx + 108, my + 70,
      Number.isFinite(nextXp) ? `XP ${hero.xp} / ${nextXp}` : `XP ${hero.xp} (max level)`,
      { size: '12px', color: COLORS.dim });
    const spec = specialtyText(hero.specialty);
    if (spec) {
      const st = label(this, mx + 108, my + 88, `✦ Specialty: ${spec.name}`, { size: '12px', color: COLORS.gold });
      st.setInteractive()
        .on('pointerover', (p) => this.tooltip.show(p.x, p.y, `${spec.name} — ${spec.effect}`))
        .on('pointerout', () => this.tooltip.hide());
    }
    button(this, mx + mw - 52, my + 30, 72, 34, 'Close', () => this.close(), { blue: true });

    // ---- primary stats ----
    let y = my + 110;
    label(this, mx + 20, y, 'PRIMARY STATS', { size: '12px', color: COLORS.dim, bold: true });
    y += 22;
    const stats = [
      ['Attack', heroStat(hero, 'attack'), 'boosts your troops’ damage'],
      ['Defense', heroStat(hero, 'defense'), 'reduces damage your troops take'],
      ['Power', heroStat(hero, 'power'), 'strengthens your spells'],
      ['Knowledge', heroStat(hero, 'knowledge'), 'expands your mana pool'],
    ];
    stats.forEach(([name, v, tip], i) => {
      const x = mx + 20 + i * 108;
      const box = inset(this, x, y, 98, 54);
      label(this, x + 49, y + 8, `${v}`, { size: '20px', bold: true, ox: 0.5, color: COLORS.gold });
      label(this, x + 49, y + 34, name, { size: '11px', ox: 0.5, color: COLORS.dim });
      box.setInteractive()
        .on('pointerover', (p) => this.tooltip.show(p.x, p.y, `${name}: ${tip}`))
        .on('pointerout', () => this.tooltip.hide());
    });
    y += 66;
    label(this, mx + 20, y,
      `Morale ${fmtSigned(heroMorale(hero))}    Luck ${fmtSigned(heroLuck(hero))}    Movement ${Math.floor(hero.mp / 100)}/${Math.floor(heroMaxMovement(hero) / 100)} tiles    Mana ${hero.mana}/${heroMaxMana(hero)}`,
      { size: '13px' });
    y += 30;

    // ---- secondary skills ----
    label(this, mx + 20, y, 'SECONDARY SKILLS', { size: '12px', color: COLORS.dim, bold: true });
    y += 20;
    const skills = Object.entries(hero.skills);
    if (!skills.length) label(this, mx + 20, y + 4, 'None yet — level up to learn skills.', { size: '12px', color: COLORS.dim });
    skills.slice(0, 8).forEach(([id, lvl], i) => {
      const x = mx + 20 + (i % 2) * 210;
      const yy = y + Math.floor(i / 2) * 42;
      inset(this, x, yy, 200, 36);
      const def = SKILLS[id];
      label(this, x + 10, yy + 4, `${SKILL_LEVEL_NAMES[lvl]} ${def?.name || id}`, { size: '13px', bold: true });
      label(this, x + 10, yy + 20, def ? def.fmt(def.levels[lvl - 1]) : '', { size: '10px', color: COLORS.dim });
    });

    // ---- paper doll + backpack ----
    const dx = mx + 470, dy = my + 106;
    this.buildPaperDoll(hero, dx, dy);
    this.buildBackpack(hero, dx + 250, dy);
    this.buildSetBonuses(hero, dx, dy + 330);

    // ---- army ----
    // Arrangeable here, not only in a town or at a hero meeting: the sheet is the
    // one place a commander in the field can reach their own army, and how many
    // stacks a creature is split into is a battlefield decision (more stacks =
    // more turns and more retaliations to soak) that should not need a trip home.
    const ay = my + mh - 170;
    // One heading, not a second label off to the side: the paper doll and the set
    // bonuses already own the right half of the panel at this height.
    label(this, mx + 20, ay - 18,
      'ARMY   ·   click a stack then a slot to move   ·   the same stack twice splits it',
      { size: '11px', color: COLORS.dim, bold: true });
    hero.army.forEach((stack, i) => {
      const x = mx + 20 + i * 64;
      const picked = this.picked === i;
      const cell = inset(this, x, ay, 56, 68);
      // A gold frame over the inset marks the stack in hand — the nineslice has no
      // stroke of its own to recolour.
      if (picked) this.add.rectangle(x + 28, ay + 34, 56, 68).setStrokeStyle(2, 0xe8c060);
      if (stack && stack.count > 0) {
        const c = CREATURES[stack.creature];
        // The frame carries the hover, not the icon: an interactive icon only
        // answers over its own 44px art, so the stats appeared over the creature
        // and nowhere else in the slot (Phaser's input.topOnly, same cause as the
        // hero-meet slots being clickable only in the corner with the count).
        unitIcon(this, stack.creature, x + 28, ay + 26, 44);
        label(this, x + 28, ay + 50, `${stack.count}`, { size: '12px', bold: true, ox: 0.5, color: '#ffe9b0' });
        cell.setInteractive({ useHandCursor: true })
          .on('pointerover', (p) => this.tooltip.show(p.x, p.y, `${c.name} ×${stack.count}\nAtk ${c.attack} Def ${c.defense} Dmg ${c.damage[0]}–${c.damage[1]}\nHP ${c.health} Spd ${c.speed} (${c.reach})\n\nClick to pick up${picked ? ' — click again to split' : ''}\nShift-click to disband`))
          .on('pointerout', () => this.tooltip.hide());
      } else {
        cell.setInteractive({ useHandCursor: true });
      }
      cell.on('pointerup', (p) => {
        this.tooltip.hide();
        if (p?.event?.shiftKey) this.onSlotDisband(hero, i);
        else this.onSlotClick(hero, i);
      });
    });

    // ---- spellbook ----
    const sy = ay + 84;
    label(this, mx + 20, sy - 4, 'SPELLBOOK', { size: '12px', color: COLORS.dim, bold: true });
    const known = hero.spells.map((id) => SPELLS[id]?.name).filter(Boolean);
    label(this, mx + 20, sy + 14, known.length ? known.join('  ·  ') : 'No spells known. Visit a Mage Guild (Wisdom unlocks tiers 3–5).', {
      size: '12px', color: known.length ? COLORS.parchment : COLORS.dim, wrap: mw - 60,
    });
  }

  // ---- combination sets: completed sets grant a synergy bonus ----
  buildSetBonuses(hero, x, y) {
    label(this, x, y, 'COMBINATION SETS', { size: '12px', color: COLORS.dim, bold: true });
    const active = activeArtifactSets(hero);
    if (!active.length) {
      label(this, x, y + 18, 'None assembled — collect a full set for a bonus.', { size: '11px', color: COLORS.dim });
      return;
    }
    active.forEach((setId, i) => {
      const set = ARTIFACT_SETS[setId];
      label(this, x, y + 18 + i * 17, `⚜ ${set.name}: ${set.desc}`, { size: '11px', color: COLORS.gold });
    });
  }

  // ---- paper doll: equipped artifact sockets; click to unequip ----
  buildPaperDoll(hero, dx, dy) {
    label(this, dx, dy - 22, 'EQUIPMENT', { size: '12px', color: COLORS.dim, bold: true });
    SOCKET_LAYOUT.forEach(([socket, name], i) => {
      const x = dx + (i % 3) * 78;
      const yy = dy + Math.floor(i / 3) * 78;
      const cell = inset(this, x, yy, 68, 68);
      const artId = hero.equipment[socket];
      if (artId) {
        const img = artifactIcon(this, artId, x + 34, yy + 30, 46);
        img.setInteractive({ useHandCursor: true })
          .on('pointerover', (p) => this.tooltip.show(p.x, p.y, artifactTip(artId)))
          .on('pointerout', () => this.tooltip.hide())
          .on('pointerup', () => {
            this.tooltip.hide();
            unequipArtifact(this.state, hero, socket);
            this.buildAll();
          });
        label(this, x + 34, yy + 54, name, { size: '9px', ox: 0.5, color: COLORS.dim });
      } else {
        label(this, x + 34, yy + 28, name, { size: '10px', ox: 0.5, color: '#55506a' });
        cell.setInteractive()
          .on('pointerover', (p) => this.tooltip.show(p.x, p.y, `Empty ${name.toLowerCase()} slot`))
          .on('pointerout', () => this.tooltip.hide());
      }
    });
  }

  // ---- backpack: unequipped artifacts; click to equip a matching socket ----
  /**
   * PAGED, never truncated. The 3×4 grid is a real space budget (the set-bonus
   * block sits a fixed 330px below), but the backpack itself has no cap on the
   * write side — looting a beaten hero, unequipping to make room, and endless-
   * realm rewards all push freely — so this grid used to `slice(0, 12)` and the
   * thirteenth artifact onward simply could not be reached from any screen:
   * this is the ONLY equip surface in the game. Worse, unequipping pushes the
   * worn item onto the END of the list, so the item you just took off could
   * itself vanish past the cut. Same mistake, same policy as the town build
   * grid (see uikit.fitGrid's history): page it, exactly like SaveLoadScene.
   * Keeping the 12-cell footprint (rather than routing through fitGrid) is
   * deliberate — the pager row fits the 90px gap under the grid, and the
   * layout around it stays untouched.
   */
  buildBackpack(hero, bx, by) {
    const PER_PAGE = 12; // 3 columns × 4 rows of 62px — the space the sheet reserves
    const pages = Math.max(1, Math.ceil(hero.backpack.length / PER_PAGE));
    // Clamp, don't reset: equipping from a shrunken last page should land on the
    // new last page, not bounce the player back to page one.
    this.packPage = Math.min(Math.max(0, this.packPage), pages - 1);
    const start = this.packPage * PER_PAGE;

    label(this, bx, by - 22, 'BACKPACK  (click to equip)', { size: '12px', color: COLORS.dim, bold: true });
    if (!hero.backpack.length) label(this, bx, by + 4, 'Empty.', { size: '12px', color: COLORS.dim });
    hero.backpack.slice(start, start + PER_PAGE).forEach((artId, i) => {
      const x = bx + (i % 3) * 62;
      const yy = by + Math.floor(i / 3) * 62;
      inset(this, x, yy, 54, 54);
      const img = artifactIcon(this, artId, x + 27, yy + 27, 42);
      img.setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => this.tooltip.show(p.x, p.y, artifactTip(artId)))
        .on('pointerout', () => this.tooltip.hide())
        .on('pointerup', () => {
          this.tooltip.hide();
          const art = ARTIFACTS[artId];
          // Prefer an empty matching socket, else swap with the first one.
          const sockets = Object.keys(EQUIP_SOCKETS).filter((sk) => EQUIP_SOCKETS[sk] === art.slot);
          const target = sockets.find((sk) => !hero.equipment[sk]) || sockets[0];
          // start + i, not indexOf: with duplicates of an artifact across pages,
          // indexOf always found the first copy — possibly on another page.
          if (target) equipArtifact(this.state, hero, start + i, target);
          this.buildAll();
        });
    });

    // Pager — only drawn when there is an overflow to reach. Sits in the gap
    // between the grid (ends by+240) and the set-bonus block (starts by+330).
    if (pages > 1) {
      const py = by + PER_PAGE / 3 * 62 + 12;
      button(this, bx + 16, py, 32, 26, '◀',
        () => { this.packPage--; this.buildAll(); }, { fontSize: '13px', track: 'PackPrev' });
      label(this, bx + 93, py, `Page ${this.packPage + 1}/${pages} · ${hero.backpack.length} carried`,
        { size: '11px', color: COLORS.dim, ox: 0.5, oy: 0.5, max: 110 });
      button(this, bx + 170, py, 32, 26, '▶',
        () => { this.packPage++; this.buildAll(); }, { fontSize: '13px', track: 'PackNext' });
    }
  }
}

function artifactTip(artId) {
  const a = ARTIFACTS[artId];
  return a ? `${a.name}\n${a.desc}\nSlot: ${a.slot}` : artId;
}

function fmtSigned(v) {
  return v > 0 ? `+${v}` : `${v}`;
}
