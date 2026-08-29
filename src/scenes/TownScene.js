/**
 * TownScene — Town management overlay: construct one building per day,
 * recruit creatures by tier, hire heroes (tavern), learn spells (mage guild),
 * trade (marketplace), and shuffle troops between garrison and visiting hero.
 */

import Phaser from 'phaser';
import { RESOURCES, CONFIG } from '../config.js';
import { CREATURES } from '../data/creatures.js';
import { SKILLS } from '../data/skills.js';
import { unitIcon, townIcon, resourceIcon, buildingIcon } from '../gfx/sprites.js';
import { buildingCatalog, townBuildSlots, buildingAction, nextGuildLevel, guildLevelOf } from '../data/buildings.js';
import { SPELLS, wisdomRequiredForTier } from '../data/spells.js';
import { HERO_ROSTER } from '../data/heroes.js';
import { FACTIONS } from '../data/factions.js';
import { getState } from '../game/session.js';
import { playSfx } from '../game/audio.js';
import { dayOfWeek, weekOf, canAfford, playerTowns, featureOn, adoptFeature } from '../core/GameState.js';
import { tavernRumors } from '../core/rumors.js';
import { hireableRonins, roninHireCost, hireRonin, roninHero } from '../core/ronins.js';
import {
  buildBlockReason, buildStructure, recruit, recruitableCreature, recruitCost,
  marketExchange, marketQuote, marketGiveForGet, marketplaceCount, marketBuyRate, hireableHeroes, hireHero, hireCost, pooledHero, moveStack, splitStack, disbandStack,
  learnGuildSpells, upgradeInfo, upgradeUnitCost, upgradeStack,
  buildBoatAtTown, townShipyardBuildCheck, grailPerkText, buyWarMachine, dispatchCaravan,
  transmuteTargets, transmuteQuote, transmuteMinInput, transmuteInputFor, transmuteStack,
  forgetSkill, forgetSkillCost,
  loanQuote, loanableBuildings, takeLoan, townDebts, bankCount, bankDepositRate, bankInterestDue,
  buyUpgradeNode, upgradeNodeBlockReason,
} from '../core/actions.js';
import { dwellingNodes } from '../data/upgradeNodes.js';
import { allJobs } from '../core/jobs.js';
import {
  panel, inset, button, iconButton, label, numberPicker, showDialog, Tooltip, FONT, COLORS, DEPTH, costText,
  destroyAllChildren, modalOpen, trackModal, fitGrid,
} from '../ui/uikit.js';
import { openSpellbook } from '../ui/spellbook.js';

// Compact resource tags for the tight building-grid cost line (the full, readable
// cost is in the hover tooltip). Keeps even a 7-resource upgrade to one line so it
// can't wrap past the short cell.
const GRID_RES = { gold: 'g', wood: 'w', ore: 'o', mercury: 'Hg', sulfur: 'S', crystal: 'Cr', gems: 'Gm' };
function gridCost(cost) {
  return Object.entries(cost || {}).filter(([, n]) => n).map(([r, n]) => `${n}${GRID_RES[r] || r}`).join(' ');
}
/** Ellipsis-truncate to a char budget so a long name never spills its cell. */
function ellipsize(str, max) {
  return str.length <= max ? str : `${str.slice(0, Math.max(1, max - 1))}…`;
}

// How many town crests the left-hand switcher shows at once. Ten is about the
// most that stays navigable at a glance and still leaves each crest legible in
// a 720px-tall strip; past that the strip pages.
const TOWN_STRIP_PER = 10;

export class TownScene extends Phaser.Scene {
  constructor() {
    super('Town');
  }

  init(data) {
    this.townId = data.townId;
    this.onClose = data.onClose;
  }

  create() {
    this.state = getState();
    this.town = this.state.towns[this.townId];
    this.tooltip = new Tooltip(this);
    this.pickedStack = null; // { army, index }
    this.buildAll();
    // A dialog stacked over the town (build confirm, etc.) owns ESC — the scene
    // fires first (registered earlier), so early-return while a modal is up and
    // let the dialog's own ESC close it, instead of closing the whole screen too.
    this.input.keyboard.on('keydown-ESC', () => { if (!modalOpen()) this.close(); });
    this.scale.on('resize', this.buildAll, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.buildAll, this));
  }

  close() {
    this.tooltip.hide();
    this.scene.stop();
    this.onClose?.();
  }

  buildAll() {
    destroyAllChildren(this);
    this.tooltip = new Tooltip(this);
    const W = this.scale.width, H = this.scale.height;

    // dim world behind
    this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x060510, 0.82);

    // A left-edge strip listing the player's OTHER towns, so you can switch which
    // town you manage — and build in it — without leaving the screen. Only shown
    // when there's more than one town; it steals a sliver of width from the modal
    // and the whole block re-centres so nothing overlaps.
    const towns = playerTowns(this.state, this.town.owner);
    const stripW = towns.length > 1 ? 96 : 0;
    const gap = stripW ? 12 : 0;

    const mh = Math.min(720, H - 20);
    const my = (H - mh) / 2;
    const mw = Math.min(1060, W - 24 - stripW - gap);
    const block = stripW + gap + mw;
    const bx = (W - block) / 2;
    const mx = bx + stripW + gap;

    panel(this, mx, my, mw, mh);
    if (stripW) this.buildTownStrip(towns, bx, my, stripW, mh);

    this.buildHeader(mx, my, mw);
    const y = this.buildRecruitRow(mx, my);
    this.buildBuildings(mx, my, mw, mh, y);
    this.buildArmies(mx, my, mh);
  }

  /**
   * The town switcher strip: one crest per town the player owns, the current one
   * framed in gold. A town that has already used its one build this turn wears a
   * red ✕ in the corner, so you can see at a glance where you cannot build now.
   * Clicking another town re-opens this screen on it (switchTown).
   */
  buildTownStrip(towns, sx, sy, sw, sh) {
    // PAGED, ten at a time. The strip used to divide its height by however many
    // towns you owned and clamp the result at a 58px floor — so past about ten
    // towns the cells simply ran off the bottom of the panel and the rest of
    // your realm was unreachable from here. Reported at fifteen towns.
    const pages = Math.max(1, Math.ceil(towns.length / TOWN_STRIP_PER));
    // Follow the town being managed rather than stranding it on another page.
    if (this.townStripPage == null || this.townStripFollow !== this.town.id) {
      const at = Math.max(0, towns.findIndex((t) => t.id === this.town.id));
      this.townStripPage = Math.floor(at / TOWN_STRIP_PER);
      this.townStripFollow = this.town.id;
    }
    const page = Math.max(0, Math.min(pages - 1, this.townStripPage));
    const start = page * TOWN_STRIP_PER;
    const shown = towns.slice(start, start + TOWN_STRIP_PER);
    label(this, sx + sw / 2, sy + 7,
      pages > 1 ? `TOWNS ${start + 1}–${start + shown.length}/${towns.length}` : 'TOWNS',
      { size: '10px', bold: true, color: COLORS.dim, ox: 0.5 });
    const top = sy + 26;
    const pagerH = pages > 1 ? 26 : 0;
    const cellH = Math.max(58, Math.min(88, (sh - 34 - pagerH) / Math.max(1, shown.length)));
    const crest = Math.min(40, cellH - 28);
    if (pages > 1) {
      const py = sy + sh - 16;
      const arrow = (ax, text, delta, on) => {
        const t = label(this, ax, py, text, { size: '15px', bold: true, ox: 0.5, color: on ? COLORS.gold : COLORS.dim });
        if (on) {
          t.setInteractive({ useHandCursor: true })
            .on('pointerup', () => { this.townStripPage = page + delta; this.buildAll(); });
        }
      };
      arrow(sx + sw / 2 - 26, '◀', -1, page > 0);
      label(this, sx + sw / 2, py, `${page + 1}/${pages}`, { size: '10px', ox: 0.5, color: COLORS.dim });
      arrow(sx + sw / 2 + 26, '▶', +1, page < pages - 1);
    }
    shown.forEach((t, i) => {
      const cy = top + i * cellH;
      const current = t.id === this.town.id;
      const cell = this.add.rectangle(sx + sw / 2, cy + cellH / 2 - 4, sw - 10, cellH - 8,
        current ? 0x2a2440 : 0x14121f).setStrokeStyle(2, current ? 0xe8c060 : 0x4a4560);
      townIcon(this, FACTIONS[t.faction].townGlyph, sx + sw / 2, cy + 4 + crest / 2, crest);
      label(this, sx + sw / 2, cy + cellH - 18, ellipsize(t.name, 11),
        { size: '9px', ox: 0.5, color: current ? COLORS.gold : COLORS.parchment });
      // "cannot build here now" marker.
      if (t.builtToday) {
        const rx = sx + sw - 15, ry = cy + 9;
        this.add.circle(rx, ry, 8, 0x3a0d0d).setStrokeStyle(1.5, 0xe8514a);
        this.add.text(rx, ry - 1, '✕', { fontFamily: FONT, fontSize: '11px', fontStyle: 'bold', color: '#ff6a5a' }).setOrigin(0.5);
      }
      const tip = `${t.name}\n${FACTIONS[t.faction].name}${current ? '  (current)' : ''}\n${t.builtToday ? 'Already built here today' : 'Builders ready'}`;
      cell.setInteractive({ useHandCursor: !current })
        .on('pointerover', (p) => this.tooltip.show(p.x, p.y, tip))
        .on('pointerout', () => this.tooltip.hide())
        .on('pointerup', () => { if (!current) { this.tooltip.hide(); this.switchTown(t.id); } });
    });
  }

  /** Switch the screen to another of the player's towns (from the strip). */
  switchTown(id) {
    const t = this.state.towns[id];
    if (!t || t.owner !== this.town.owner) return;
    playSfx('click');
    this.townId = id;
    this.town = t;
    this.pickedStack = null; // the picked stack pointed into the previous town's army
    this.buildAll();
  }

  // ---- header: crest, name, day/week, resources, leave button ----
  buildHeader(mx, my, mw) {
    const s = this.state;
    const town = this.town;
    townIcon(this, FACTIONS[town.faction].townGlyph, mx + 56, my + 44, 75);
    label(this, mx + 108, my + 16, town.name, { size: '24px', bold: true, color: COLORS.gold });
    label(this, mx + 108, my + 46, `${FACTIONS[town.faction].name} township — Week ${weekOf(s.day)}, Day ${dayOfWeek(s.day)}${town.grail ? '   ·   ✦ Grail structure' : ''}`, { size: '13px', color: town.grail ? COLORS.gold : COLORS.dim });
    label(this, mx + 108, my + 64, town.builtToday ? 'Construction crews are busy (1 building per day).' : 'Builders are ready.', {
      size: '12px', color: town.builtToday ? COLORS.danger : COLORS.good,
    });
    // The Grail's blessing spelled out (faction-specific — see grailPerkText).
    if (town.grail) {
      label(this, mx + 108, my + 80, `Grail blessing: ${grailPerkText(town.faction)}.`, { size: '11px', color: COLORS.gold });
    }
    // resources
    let rx = mx + mw - 470;
    for (const res of RESOURCES) {
      resourceIcon(this, res, rx, my + 30, 22); // raster pack when present, else the procedural glyph
      label(this, rx + 12, my + 23, `${s.players[town.owner].resources[res]}`, { size: '13px', bold: true });
      rx += res === 'gold' ? 78 : 62;
    }
    iconButton(this, mx + mw - 34, my + 30, 34, '⮐', () => this.close(), { blue: true, tooltip: 'Leave town' });

    // CLONE: the Study toggle / Study Break / Study week buttons are gone with the
    // study module, and the "⚒ Schedule" button is gone with GanttScene. The job
    // QUEUE itself is untouched — core/jobs.js still ticks inside endTurn and towns
    // still build on a schedule; only the chart view of it is missing.
  }

  // ---- recruitment row: one card per tier. Returns the y below the row. ----
  buildRecruitRow(mx, my) {
    const town = this.town;
    let y = my + 92;
    label(this, mx + 18, y, 'RECRUIT', { size: '12px', color: COLORS.dim, bold: true });
    y += 18;
    for (let tier = 1; tier <= 7; tier++) {
      const x = mx + 20 + (tier - 1) * 92;
      const creatureId = recruitableCreature(town, tier);
      const card = inset(this, x, y, 84, 96);
      if (creatureId) {
        const c = CREATURES[creatureId];
        const avail = town.available[tier] || 0;
        unitIcon(this, creatureId, x + 42, y + 34, 52);
        label(this, x + 42, y + 64, c.name, { size: '11.5px', bold: true, ox: 0.5, color: COLORS.parchment, align: 'center', wrap: 82 });
        // Availability as a corner badge rather than a "N available" line — long
        // names ("Mighty Gorgon", "Greater Basilisk") used to overflow onto that
        // text. Green with the count when stock can be bought, red "0" when the
        // dwelling is tapped out until next week. Kept non-interactive so it never
        // steals the card's recruit click.
        const bx = x + 71, by = y + 13;
        this.add.circle(bx, by, 11, avail ? 0x14401d : 0x3a0d0d)
          .setStrokeStyle(1.5, avail ? 0x6fd67f : 0xe8514a);
        this.add.text(bx, by, `${avail}`, {
          fontFamily: FONT, fontSize: avail >= 100 ? '9.5px' : '11.5px', fontStyle: 'bold',
          color: avail ? '#cbf8d3' : '#ffffff', stroke: '#000', strokeThickness: 2,
        }).setOrigin(0.5);
        // The whole CARD recruits, not just the 52px creature: with the icon as
        // the input target (Phaser's input.topOnly), clicking the name under it —
        // or the empty space beside it — did nothing at all. Same cause as the
        // hero-meet slots answering only in the corner with the count.
        card.setInteractive({ useHandCursor: true })
          .on('pointerup', () => { this.tooltip.hide(); this.recruitDialog(tier, creatureId); })
          .on('pointerover', (p) => this.tooltip.show(p.x, p.y, `${creatureTip(c)}\n\n${avail ? `${avail} available to recruit` : 'None available — returns next week'}`))
          .on('pointerout', () => this.tooltip.hide());
      } else {
        label(this, x + 42, y + 40, `Tier ${tier}`, { size: '12px', ox: 0.5, color: COLORS.dim });
        label(this, x + 42, y + 58, 'no dwelling', { size: '11px', ox: 0.5, color: COLORS.dim });
      }
    }
    y += 108;
    return y;
  }

  // ---- buildings grid (scroll-less: compact cards) ----
  buildBuildings(mx, my, mw, mh, yStart) {
    const s = this.state;
    const town = this.town;
    const catalog = buildingCatalog(town.faction);
    let y = yStart;
    label(this, mx + 18, y, 'BUILD', { size: '12px', color: COLORS.dim, bold: true });
    label(this, mx + 70, y + 1, 'one per day · hover a slot for prerequisites', { size: '10px', color: COLORS.dim });
    y += 18;
    // One slot per upgrade chain (townBuildSlots) so every dwelling stays on
    // screen instead of a permanent box per built tier. Sort actionable first
    // so nothing you can build gets cut if the grid ever runs short.
    const rank = (o) => (o.built ? 2 : o.reason ? 1 : 0);
    const slots = townBuildSlots(town, town.faction)
      // Feature-gated buildings (e.g. the Hall of Reflection) only appear when
      // their optional feature is on for this game.
      .filter((id) => { const fb = catalog[id]; return !fb.feature || featureOn(s, fb.feature); })
      .map((id) => {
        const b = catalog[id];
        const built = town.buildings.includes(id);
        return { id, b, built, reason: built ? null : buildBlockReason(s, town, id) };
      })
      .sort((a, c) => rank(a) - rank(c));
    // Fit every slot: a castle has 17 build slots (19 with the optional buildings
    // on) and the old fixed 4x4 showed 16, silently dropping the rest — you could
    // not build them, nor open them once built. fitGrid widens to 5 columns and
    // tightens the rows only as far as it must, and pages rather than truncate.
    const avail = my + mh - 190 - y;
    const fit = fitGrid(slots.length, avail);
    const { cols, rowH, perPage, pages } = fit;
    const cw = (mw - 40) / cols;
    const page = Math.min(this.buildPage || 0, pages - 1);
    this.buildPage = page;
    const shown = slots.slice(page * perPage, page * perPage + perPage);
    if (pages > 1) {
      // Only reachable on a very short window; still never hides a slot silently.
      const py2 = y + fit.rows * rowH + 4;
      label(this, mx + 20, py2, `${page * perPage + 1}–${page * perPage + shown.length} of ${slots.length}`,
        { size: '11px', color: COLORS.dim });
      if (page > 0) button(this, mx + 150, py2 + 6, 74, 24, '◂ Prev', () => { this.buildPage = page - 1; this.buildAll(); }, { fontSize: '11px' });
      if (page < pages - 1) button(this, mx + 232, py2 + 6, 74, 24, 'Next ▸', () => { this.buildPage = page + 1; this.buildAll(); }, { fontSize: '11px' });
    }
    shown.forEach(({ id, b, built, reason }, i) => {
      const bx = mx + 20 + (i % cols) * cw;
      const by = y + Math.floor(i / cols) * rowH;
      inset(this, bx, by, cw - 8, rowH - 8);
      // Each building shows its own art: a generated sprite once a pack has one,
      // else the faction-tinted procedural glyph (or a MISSING box under strict).
      // Unbuilt slots draw dimmer so "built" reads at a glance.
      const icon = buildingIcon(this, town.faction, id, b, bx + 26, by + (rowH - 8) / 2, 40);
      if (!built) icon.setAlpha(reason ? 0.4 : 0.7);
      const nameCol = built ? COLORS.good : reason ? COLORS.dim : COLORS.gold;
      // Text column runs from the icon to the inset's right edge. The name is
      // ellipsized and the cost abbreviated so a long name / a 7-resource cost
      // can't spill the short cell — the full name/desc/cost are in the tooltip.
      const textX = bx + 48;
      const textW = cw - 8 - 48;
      label(this, textX, by + 7, ellipsize(b.name, Math.floor(textW / 7.5)), { size: '14px', bold: true, color: nameCol });
      label(this, textX, by + 28, built ? 'Built' : reason || `Build: ${gridCost(b.cost)}`, {
        size: '11.5px', color: built ? COLORS.dim : reason ? COLORS.danger : COLORS.parchment,
        wrap: textW,
      });
      const zone = this.add.rectangle(bx + (cw - 8) / 2, by + (rowH - 8) / 2, cw - 8, rowH - 8, 0xffffff, 0.001);
      zone.setInteractive({ useHandCursor: true })
        .on('pointerover', (p) => {
          const needs = b.requires.filter((r) => !town.buildings.includes(r)).map((r) => catalog[r]?.name || r);
          this.tooltip.show(p.x, p.y, `${b.name}\n${b.desc}\nCost: ${costText(b.cost)}${needs.length ? `\nNeeds: ${needs.join(', ')}` : ''}`);
        })
        .on('pointerout', () => this.tooltip.hide())
        .on('pointerup', () => {
          this.tooltip.hide();
          if (built) return this.openBuiltBuilding(id, b);
          if (reason) return;
          showDialog(this, {
            title: `Build ${b.name}?`,
            lines: [b.desc, `Cost: ${costText(b.cost)}`],
            buttons: [
              { text: 'Cancel' },
              {
                text: '⚒ Build',
                blue: true,
                onClick: () => {
                  buildStructure(s, town, id);
                  this.buildAll();
                },
              },
            ],
          });
        });
    });
  }

  // ---- armies: garrison + visiting hero ----
  buildArmies(mx, my, mh) {
    const s = this.state;
    const town = this.town;
    const ay = my + mh - 156;
    label(this, mx + 18, ay - 16, 'GARRISON', { size: '12px', color: COLORS.dim, bold: true });
    this.armyRow(mx + 20, ay, town.garrison, 'garrison');

    const visiting = town.visitingHeroId ? s.heroes[town.visitingHeroId] : null;
    label(this, mx + 18, ay + 58, visiting ? `VISITING — ${visiting.name}` : 'VISITING HERO', {
      size: '12px', color: COLORS.dim, bold: true,
    });
    if (visiting) {
      this.armyRow(mx + 20, ay + 76, visiting.army, 'hero');
    } else {
      label(this, mx + 20, ay + 84, 'No hero in town. Heroes visiting the town learn Mage Guild spells automatically.', { size: '12px', color: COLORS.dim });
    }
    label(this, mx + 20 + 7 * 62 + 16, ay + 10,
      'Click a stack, then a slot to move.\nClick same stack twice to split half.',
      { size: '11px', color: COLORS.dim });

    // Caravan dispatch: send a garrison stack overland to another of your towns
    // (same level). Only shown when there's somewhere to send troops and troops
    // to send — see caravanDialog / actions.dispatchCaravan.
    const others = playerTowns(s, town.owner).filter((t) => t.id !== town.id && (t.z ?? 0) === (town.z ?? 0));
    const hasTroops = (town.garrison || []).some((st) => st && st.count > 0);
    if (others.length && hasTroops) {
      button(this, mx + 20 + 7 * 62 + 16, ay + 44, 150, 30, '▶ Send Caravan',
        () => this.caravanDialog(others), { blue: true, fontSize: '12px' });
    }
  }

  /**
   * Dispatch a caravan: pick a garrison stack, then a destination town; the
   * whole stack sets out overland (actions.dispatchCaravan). Two quick picks —
   * granularity comes from which stack you choose.
   */
  caravanDialog(destTowns) {
    const town = this.town;
    const stacks = (town.garrison || [])
      .map((st, i) => ({ st, i }))
      .filter((e) => e.st && e.st.count > 0);
    showDialog(this, {
      title: 'Send a Caravan — pick a stack',
      lines: ['Which garrison stack marches out?'],
      buttons: [
        { text: 'Cancel' },
        ...stacks.map(({ st, i }) => ({
          text: `${st.count} ${CREATURES[st.creature]?.name || st.creature}`,
          blue: true,
          onClick: () => this.caravanDestDialog(i, destTowns),
        })),
      ],
      width: 560,
    });
  }

  caravanDestDialog(slotIndex, destTowns) {
    const town = this.town;
    showDialog(this, {
      title: 'Send a Caravan — pick a destination',
      lines: ['To which of your towns?'],
      buttons: [
        { text: 'Cancel' },
        ...destTowns.map((t) => ({
          text: t.name,
          blue: true,
          onClick: () => {
            const st = town.garrison[slotIndex];
            const res = dispatchCaravan(this.state, town, t.id, slotIndex, st ? st.count : 0);
            this.buildAll();
            if (!res.ok) showDialog(this, { title: 'Caravan', lines: [`It cannot set out (${res.reason}).`] });
          },
        })),
      ],
      width: 560,
    });
  }

  armyRow(x, y, army, tag) {
    for (let i = 0; i < CONFIG.ARMY_SLOTS; i++) {
      const ax = x + i * 62;
      const stack = army[i];
      const picked = this.pickedStack && this.pickedStack.army === army && this.pickedStack.index === i;
      const cell = this.add.rectangle(ax + 26, y + 26, 54, 54, 0x14121f)
        .setStrokeStyle(2, picked ? 0xe8c060 : 0x4a4560);
      if (stack && stack.count > 0) {
        unitIcon(this, stack.creature, ax + 26, y + 22, 42);
        this.add.text(ax + 49, y + 49, `${stack.count}`, {
          fontFamily: FONT, fontSize: '12px', fontStyle: 'bold', color: '#ffe9b0',
          stroke: '#000', strokeThickness: 3,
        }).setOrigin(1);
        // Upgrade badge when this stack's upgraded dwelling is built. Sits on
        // top of the cell; `input.topOnly` means clicking it upgrades rather
        // than picking the stack up.
        if (upgradeInfo(this.town, stack.creature)) {
          const badge = this.add.circle(ax + 6, y + 6, 9, 0x2f7d38).setStrokeStyle(1.5, 0xa8f0b0);
          this.add.text(ax + 6, y + 5, '▲', { fontFamily: FONT, fontSize: '11px', color: '#eafff0' }).setOrigin(0.5);
          badge.setInteractive({ useHandCursor: true })
            .on('pointerover', (p) => this.tooltip.show(p.x, p.y, `Upgrade to ${CREATURES[upgradeInfo(this.town, stack.creature).to].name}`))
            .on('pointerout', () => this.tooltip.hide())
            .on('pointerup', () => { this.tooltip.hide(); this.upgradeDialog(army, i); });
        }
      }
      if (stack && stack.count > 0) {
        // The cell carries the hover, not the icon — an interactive icon only
        // answers over its own art (same reason the hero screen frames it).
        cell.on('pointerover', (pp) => this.tooltip.show(pp.x, pp.y,
          `${CREATURES[stack.creature].name} ×${stack.count}\n\nClick to pick up\nShift-click to disband`))
          .on('pointerout', () => this.tooltip.hide());
      }
      cell.setInteractive({ useHandCursor: true }).on('pointerup', (p) => {
        // Shift-click dismisses. Destructive and irreversible, so it asks first
        // and never rides the plain click that every other army gesture uses.
        if (p?.event?.shiftKey) { this.tooltip.hide(); this.disbandDialog(army, i); return; }
        if (!this.pickedStack) {
          if (stack && stack.count > 0) this.pickedStack = { army, index: i };
        } else if (this.pickedStack.army === army && this.pickedStack.index === i) {
          // same cell: try split into first empty slot of same army
          const empty = army.findIndex((sk) => !sk || sk.count <= 0);
          if (empty >= 0) splitStack(army, i, army, empty);
          this.pickedStack = null;
        } else if (this.wouldStrandHero(army, i)) {
          // A hero may never be left without a single creature. Return BEFORE the
          // buildAll() below: its destroyAllChildren() would wipe this dialog on
          // the same frame (HeroMeetScene's twin of this branch returns too). The
          // board is unchanged — no rebuild is needed.
          this.pickedStack = null;
          showDialog(this, { title: 'Command refused', lines: ['A hero cannot march without at least one creature stack.'] });
          return;
        } else {
          moveStack(this.pickedStack.army, this.pickedStack.index, army, i);
          this.pickedStack = null;
        }
        this.buildAll();
      });
    }
  }

  /**
   * Confirm and dismiss a stack. A town GARRISON may be emptied — that is an
   * ordinary state — but a visiting hero may not lose its last stack, and the
   * rule for that lives in actions.disbandStack so this screen and the hero
   * screen cannot disagree about it.
   */
  disbandDialog(army, index) {
    const stack = army[index];
    if (!stack || stack.count <= 0) return;
    const isGarrison = army === this.town.garrison;
    const c = CREATURES[stack.creature];
    if (!isGarrison && army.filter((s) => s && s.count > 0).length <= 1) {
      showDialog(this, {
        title: 'Command refused',
        lines: ['A hero cannot march without at least one creature stack.'],
      });
      return;
    }
    showDialog(this, {
      title: 'Disband stack',
      lines: [`Dismiss ${stack.count} ${c.name}?`,
        isGarrison ? 'They leave the garrison for good.' : 'They leave the army for good.'],
      buttons: [
        { text: 'Keep them' },
        { text: '✖ Disband',
          blue: true,
          onClick: () => { disbandStack(army, index, { allowEmpty: isGarrison }); this.buildAll(); } },
      ],
    });
  }

  // ---- upgrade a stack to its dwelling's upgraded creature ----
  upgradeDialog(army, index) {
    const stack = army[index];
    const info = stack && upgradeInfo(this.town, stack.creature);
    if (!info) return;
    const from = CREATURES[stack.creature], to = CREATURES[info.to];
    const count = stack.count;
    const perUnit = upgradeUnitCost(stack.creature, info.to, 1);
    const total = upgradeUnitCost(stack.creature, info.to, count);
    const player = this.state.players[this.town.owner];
    const affordable = canAfford(player, total);

    const W = this.scale.width, H = this.scale.height;
    const overlay = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL_TOP));
    overlay.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x05040a, 0.82).setInteractive());
    const mw = 620, mh = 400, mx = (W - mw) / 2, my = (H - mh) / 2;
    overlay.add(panel(this, mx, my, mw, mh));
    overlay.add(label(this, mx + mw / 2, my + 22, `Upgrade ${from.name}`, { size: '20px', bold: true, ox: 0.5, color: COLORS.gold }));

    // Before / after unit cards with improved stats highlighted.
    const cardW = 210, cardY = my + 56, cardH = 214;
    this.unitCard(overlay, stack.creature, mx + 34, cardY, cardW, cardH, null);
    this.unitCard(overlay, info.to, mx + mw - 34 - cardW, cardY, cardW, cardH, stack.creature);
    overlay.add(label(this, mx + mw / 2, cardY + cardH / 2 - 24, '→', { size: '40px', bold: true, ox: 0.5, color: COLORS.gold }));
    overlay.add(label(this, mx + mw / 2, cardY + cardH / 2 + 22, `×${count}`, { size: '16px', bold: true, ox: 0.5, color: COLORS.parchment }));

    // Cost calculation: per-unit × count = total.
    const cy = my + mh - 96;
    overlay.add(label(this, mx + mw / 2, cy, `Upgrade all ${count} ${from.name} into ${to.name}`, { size: '13px', ox: 0.5, color: COLORS.parchment }));
    overlay.add(label(this, mx + mw / 2, cy + 22,
      `Cost:  ${count} × (${costText(perUnit)})  =  ${costText(total)}`,
      { size: '14px', bold: true, ox: 0.5, color: affordable ? COLORS.gold : '#e08a7a' }));
    if (!affordable) overlay.add(label(this, mx + mw / 2, cy + 42, 'Not enough resources.', { size: '12px', ox: 0.5, color: '#e08a7a' }));

    const by = my + mh - 32;
    overlay.add(button(this, mx + mw / 2 - 92, by, 156, 34, 'Cancel', () => overlay.destroy(), { blue: true }));
    if (affordable) {
      overlay.add(button(this, mx + mw / 2 + 92, by, 156, 34, 'Upgrade', () => {
        upgradeStack(this.state, this.town, army, index);
        overlay.destroy();
        this.buildAll();
      }, { icon: '▲' }));
    }
  }

  /** One unit card (art + stats) for the upgrade splash. If `compareId` is
   *  given, stats better than that creature's are highlighted green (worse red). */
  unitCard(overlay, id, x, y, w, h, compareId) {
    const c = CREATURES[id];
    const cmp = compareId ? CREATURES[compareId] : null;
    overlay.add(inset(this, x, y, w, h));
    overlay.add(unitIcon(this, id, x + w / 2, y + 52, 88));
    overlay.add(label(this, x + w / 2, y + 100, c.name, { size: '15px', bold: true, ox: 0.5, color: COLORS.gold }));
    const rows = [
      ['Attack', `${c.attack}`, c.attack, cmp?.attack],
      ['Defense', `${c.defense}`, c.defense, cmp?.defense],
      ['Damage', `${c.damage[0]}–${c.damage[1]}`, c.damage[1], cmp?.damage[1]],
      ['Health', `${c.health}`, c.health, cmp?.health],
      ['Speed', `${c.speed}`, c.speed, cmp?.speed],
    ];
    let ry = y + 122;
    for (const [name, text, val, cmpVal] of rows) {
      let color = COLORS.parchment;
      if (cmp) {
        if (val > cmpVal) color = COLORS.good;
        else if (val < cmpVal) color = '#e08a7a';
      }
      overlay.add(label(this, x + 16, ry, name, { size: '12px', color: COLORS.dim }));
      overlay.add(label(this, x + w - 16, ry, text, { size: '13px', bold: true, ox: 1, color }));
      ry += 17;
    }
  }

  /**
   * Would moving the picked stack into destArmy[destIdx] leave the visiting
   * hero with no creatures at all? (Swaps are fine — a stack comes back.)
   */
  wouldStrandHero(destArmy, destIdx) {
    const src = this.pickedStack;
    const visiting = this.town.visitingHeroId ? this.state.heroes[this.town.visitingHeroId] : null;
    if (!visiting || src.army !== visiting.army || destArmy === visiting.army) return false;
    const moving = src.army[src.index];
    const dest = destArmy[destIdx];
    if (dest && dest.count > 0 && dest.creature !== moving?.creature) return false; // swap
    const remaining = visiting.army.filter((s, j) => s && s.count > 0 && j !== src.index).length;
    return remaining === 0;
  }

  // ---- recruit dialog with stepper ----
  recruitDialog(tier, creatureId) {
    const s = this.state;
    const town = this.town;
    const c = CREATURES[creatureId];
    const player = s.players[town.owner];
    let maxN = town.available[tier] || 0;
    for (const r of RESOURCES) {
      if (c.cost[r]) maxN = Math.min(maxN, Math.floor(player.resources[r] / c.cost[r]));
    }
    if (maxN <= 0) {
      showDialog(this, {
        title: c.name,
        lines: [(town.available[tier] || 0) <= 0 ? 'No creatures available — wait for next week.' : 'No purchase made — not enough resources.'],
      });
      return;
    }
    let n = maxN;
    const W = this.scale.width, H = this.scale.height;
    const root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55).setInteractive());
    const w = 400, h = 270;
    const px = (W - w) / 2, py = (H - h) / 2;
    root.add(panel(this, px, py, w, h));
    root.add(label(this, W / 2, py + 18, `Recruit ${c.name}s`, { size: '18px', bold: true, color: COLORS.gold, ox: 0.5 }));
    root.add(unitIcon(this, creatureId, W / 2, py + 66, 52));
    const costLbl = label(this, W / 2, py + 104, '', { size: '14px', bold: true, ox: 0.5, color: COLORS.gold });
    root.add(costLbl);
    // Slider + stepper + type-to-enter: jump to any amount in one gesture rather
    // than clicking +10 a dozen times. onChange keeps the total-cost readout live.
    const picker = numberPicker(this, W / 2, py + 158, {
      value: n, min: 1, max: maxN, bigStep: 10, width: 300,
      onChange: (v) => { n = v; costLbl.setText(costText(recruitCost(creatureId, v))); },
    });
    root.add(picker.objects);
    costLbl.setText(costText(recruitCost(creatureId, n)));
    root.add(button(this, W / 2 - 70, py + h - 34, 120, 36, 'Cancel', () => root.destroy()));
    root.add(button(this, W / 2 + 70, py + h - 34, 120, 36, 'Recruit', () => {
      // Buying from a SWORN realm's dwellings: the buyer is named, so the gold comes
      // out of your treasury and the troops go to your hero, not the vassal's garrison.
      const got = recruit(this.state, town, tier, n, 0);
      root.destroy();
      if (got <= 0) {
        // n was clamped to what's affordable when the dialog opened, so a zero
        // result here means the army/garrison had no free slot — but if funds
        // somehow fell short, say so in the words the player expects.
        const affordable = RESOURCES.every((r) => !c.cost[r] || (player.resources[r] || 0) >= c.cost[r] * n);
        showDialog(this, {
          title: c.name,
          lines: [affordable ? 'No purchase made — no free army slot.' : 'No purchase made — not enough resources.'],
        });
      }
      this.buildAll();
    }, { blue: true, icon: '⚔' }));
  }

  // ---- Altar of Transmutation: reshape an army's composition for a fee ----
  // Three light steps reusing the dialog kit: pick a source stack → pick a
  // target the town can build → set the amount against a live quote. All the
  // rules (aiValue tax, gold fee, army-room rollback) live in the tested engine
  // (core/transmute.js); this only gathers the stacks and reports the result.
  transmuteDialog() {
    const town = this.town;
    const targets = transmuteTargets(town);
    if (!targets.length) {
      showDialog(this, { title: 'Altar of Transmutation', lines: ['Build creature dwellings first — the Altar only forges creatures this town can recruit.'] });
      return;
    }
    // Every stack present in the garrison or in a visiting hero's army.
    const sources = [];
    (town.garrison || []).forEach((s, i) => { if (s && s.count > 0) sources.push({ army: town.garrison, index: i, tag: 'Garrison' }); });
    const vh = town.visitingHeroId ? this.state.heroes[town.visitingHeroId] : null;
    if (vh) vh.army.forEach((s, i) => { if (s && s.count > 0) sources.push({ army: vh.army, index: i, tag: vh.name }); });
    if (!sources.length) {
      showDialog(this, { title: 'Altar of Transmutation', lines: ['No creatures here to transmute. Station a hero or leave a garrison stack.'] });
      return;
    }
    showDialog(this, {
      title: 'Altar of Transmutation', width: 480,
      lines: ['Choose a stack to transmute:'],
      buttons: sources.map((src) => {
        const st = src.army[src.index];
        return { text: `${st.count} ${CREATURES[st.creature].name} · ${src.tag}`, onClick: () => this.transmuteTargetDialog(src, targets) };
      }).concat([{ text: 'Cancel' }]),
    });
  }

  transmuteTargetDialog(src, targets) {
    const from = CREATURES[src.army[src.index].creature];
    // Can't turn a creature into itself; everything else the town builds is fair game.
    const choices = targets.filter((id) => id !== src.army[src.index].creature);
    if (!choices.length) {
      showDialog(this, { title: 'Altar of Transmutation', lines: ['Nothing else to forge here yet — build more dwellings.'] });
      return;
    }
    showDialog(this, {
      title: `Transmute ${from.name}`, width: 480,
      lines: [`Forge your ${from.name} into:`],
      buttons: choices.map((toId) => ({ text: CREATURES[toId].name, onClick: () => this.transmuteAmountDialog(src, toId) }))
        .concat([{ text: 'Cancel' }]),
    });
  }

  transmuteAmountDialog(src, toId) {
    const s = this.state, town = this.town;
    const stack = src.army[src.index];
    const fromId = stack.creature;
    const from = CREATURES[fromId], to = CREATURES[toId];
    const minIn = transmuteMinInput(fromId, toId);
    if (stack.count < minIn) {
      showDialog(this, { title: 'Altar of Transmutation', lines: [`Too few — you need at least ${minIn} ${from.name} to forge a single ${to.name}.`] });
      return;
    }
    const player = s.players[town.owner];
    // Step in whole units of the PRICIER creature so +1/+10 always changes the
    // result: when the TARGET is dearer (many cheap fund each), the slider counts
    // OUTPUT and the source is derived; otherwise it counts the source directly.
    const outputMode = (to.aiValue || 0) > (from.aiValue || 0);
    const maxOut = transmuteQuote(fromId, toId, stack.count).outCount;
    let n = stack.count; // the SOURCE count fed to transmuteStack, kept in sync below
    const W = this.scale.width, H = this.scale.height;
    const root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55).setInteractive());
    const w = 440, h = 300;
    const px = (W - w) / 2, py = (H - h) / 2;
    root.add(panel(this, px, py, w, h));
    root.add(label(this, W / 2, py + 18, `${from.name} → ${to.name}`, { size: '18px', bold: true, color: COLORS.gold, ox: 0.5 }));
    root.add(unitIcon(this, fromId, W / 2 - 60, py + 66, 48));
    root.add(label(this, W / 2, py + 60, '→', { size: '28px', bold: true, ox: 0.5, color: COLORS.gold }));
    root.add(unitIcon(this, toId, W / 2 + 60, py + 66, 48));
    root.add(label(this, W / 2, py + 92, outputMode ? `${to.name} to forge` : `${from.name} to spend`, { size: '11px', ox: 0.5, color: COLORS.dim }));
    const outLbl = label(this, W / 2, py + 112, '', { size: '15px', bold: true, ox: 0.5, color: COLORS.parchment });
    const feeLbl = label(this, W / 2, py + 134, '', { size: '13px', bold: true, ox: 0.5, color: COLORS.gold });
    root.add(outLbl); root.add(feeLbl);
    const refresh = (v) => {
      // In output mode `v` is the desired OUTPUT count → use the fewest source that
      // yields it; otherwise `v` is the source count directly.
      n = outputMode ? Math.min(stack.count, transmuteInputFor(fromId, toId, v)) : v;
      // Quoted against the WHOLE stack, so the altar's no-dead-remainder rule is
      // applied here and not sprung on the player at the Transmute button: asking
      // for the fewest source creatures that make 256 asks for 331 of your 332, and
      // the odd one goes in too because it could never be traded again.
      const q = transmuteQuote(fromId, toId, n, stack.count);
      const took = q.ok ? q.consumed : n;
      outLbl.setText(q.ok
        ? `${took} ${from.name}  →  ${q.outCount} ${to.name}${q.swept > 0 ? `   (+${q.swept} swept in)` : ''}`
        : '—');
      const afford = q.ok && (player.resources.gold || 0) >= q.goldFee;
      feeLbl.setText(q.ok ? `Fee: ${q.goldFee} gold${afford ? '' : '  (not enough gold)'}` : '');
      feeLbl.setColor(afford ? COLORS.gold : '#e08a7a');
    };
    const picker = numberPicker(this, W / 2, py + 178, outputMode
      ? { value: maxOut, min: 1, max: maxOut, bigStep: 10, width: 320, onChange: refresh }
      : { value: stack.count, min: minIn, max: stack.count, bigStep: 10, width: 320, onChange: refresh });
    root.add(picker.objects);
    refresh(outputMode ? maxOut : stack.count);
    root.add(button(this, W / 2 - 74, py + h - 34, 128, 36, 'Cancel', () => root.destroy()));
    root.add(button(this, W / 2 + 74, py + h - 34, 128, 36, 'Transmute', () => {
      const res = transmuteStack(this.state, town, src.army, src.index, toId, n);
      root.destroy();
      this.pickedStack = null;
      if (!res.ok) {
        const msg = res.reason === 'not enough gold' ? 'Not enough gold for the fee.'
          : res.reason === 'no room in the army for the result' ? 'No free army slot for the new creatures.'
          : 'The transmutation failed.';
        showDialog(this, { title: 'Altar of Transmutation', lines: [msg] });
      }
      this.buildAll();
    }, { blue: true, icon: '✦' }));
  }

  // ---- Hall of Reflection: forget a secondary skill for a level-scaled fee ----
  reflectionDialog() {
    const town = this.town;
    const hero = town.visitingHeroId ? this.state.heroes[town.visitingHeroId] : null;
    if (!hero) { showDialog(this, { title: 'Hall of Reflection', lines: ['A hero must be visiting to reflect on their training.'] }); return; }
    const skills = Object.keys(hero.skills || {}).filter((s) => hero.skills[s]);
    if (!skills.length) { showDialog(this, { title: 'Hall of Reflection', lines: [`${hero.name} has no secondary skills to forget.`] }); return; }
    const cost = forgetSkillCost(hero);
    if ((this.state.players[town.owner].resources.gold || 0) < cost) {
      showDialog(this, { title: 'Hall of Reflection', lines: [`Forgetting a skill costs ${cost} gold at level ${hero.level} — not enough in the treasury.`] });
      return;
    }
    showDialog(this, {
      title: 'Hall of Reflection', width: 480,
      lines: [`${hero.name} may forget one skill for ${cost} gold, freeing the slot for a future level-up.`],
      buttons: skills.map((sid) => ({
        text: `Forget ${SKILLS[sid]?.name || sid}`,
        onClick: () => { forgetSkill(this.state, town, hero, sid); this.buildAll(); },
      })).concat([{ text: 'Cancel' }]),
    });
  }

  // ---- Town Bank: borrow gold to rush a big-ticket build (secured by it) ----
  bankDialog() {
    const town = this.town;
    const catalog = buildingCatalog(town.faction);
    const debts = townDebts(this.state, town.id);
    const loanable = loanableBuildings(this.state, town);
    // Deposits first: it is the half that pays every week whether or not you ever
    // borrow, so a player who opens this dialog should see it before the loans.
    const banks = bankCount(this.state, town.owner);
    const rate = bankDepositRate(this.state, town.owner);
    const due = bankInterestDue(this.state, town.owner);
    const lines = [
      `Deposits: your ${banks === 1 ? 'bank pays' : `${banks} banks pay`} ${Math.round(rate * 100)}% a week`
      + ` on the gold you are holding when the week turns, up to ${CONFIG.BANK_DEPOSIT_CAP}g.`
      + `  At today's treasury that is ${due}g.`
      + (banks < CONFIG.BANK_DEPOSIT_STACK
        ? `  Each bank up to ${CONFIG.BANK_DEPOSIT_STACK} adds another ${Math.round(CONFIG.BANK_DEPOSIT_RATE * 100)}%.`
        : `  Further banks add ${Math.round(CONFIG.BANK_DEPOSIT_EXTRA_RATE * 100)}% each.`),
      'Borrow gold to raise a big-ticket building now — secured against it, repaid weekly. Miss a payment and the bank repossesses it.',
    ];
    if (debts.length) lines.push(`Owing: ${debts.map((d) => `${catalog[d.collateralBuilding]?.name || d.collateralBuilding} — ${d.owed}g`).join(' · ')}`);
    if (!loanable.length) lines.push('Nothing to finance right now (build the prerequisites first).');
    showDialog(this, {
      title: 'Town Bank', width: 520,
      lines,
      buttons: loanable.map((id) => {
        const q = loanQuote(town, id);
        return { text: `${catalog[id].name}: borrow ${q.principal}g (repay ${q.owed})`, onClick: () => { takeLoan(this.state, town, id); this.buildAll(); } };
      }).concat([{ text: 'Close' }]),
    });
  }

  // ---- built-building interactions ----
  // Clicking a built building routes through buildingAction (data-driven, unit-
  // tested) so the grid is the primary way to recruit/act, HoMM3-style: a
  // dwelling recruits its own unit, the Fort line opens a recruit overview of
  // every available tier, the functional buildings open their dialog, and a
  // passive building shows its info.
  openBuiltBuilding(id, b) {
    switch (buildingAction(id, b)) {
      case 'market': return this.marketDialog();
      case 'tavern': return this.tavernDialog();
      case 'shipyard': return this.shipyardDialog();
      case 'blacksmith': return this.blacksmithDialog();
      case 'transmuter': return this.transmuteDialog();
      case 'reflection': return this.reflectionDialog();
      case 'bank': return this.bankDialog();
      case 'guild': return this.guildDialog();
      case 'recruit': return this.openDwelling(id, b);
      case 'recruitAll': return this.recruitOverviewDialog();
      default: return showDialog(this, { title: b.name, lines: [b.desc] });
    }
  }

  /**
   * The root of a dwelling's build chain — the Homestead behind an Upgraded
   * Homestead. Walked through the catalog's own `upgradeOf` link rather than by
   * trimming the id, because that link is what makes the two the same workshop.
   */
  dwellingRoot(id) {
    const catalog = buildingCatalog(this.town.faction);
    let cur = id;
    for (let i = 0; i < 8 && catalog[cur]?.upgradeOf; i++) cur = catalog[cur].upgradeOf;
    return cur;
  }

  /**
   * Clicking a built dwelling. It musters troops and — where a branch has been
   * authored for it — it is also the workshop that re-equips them, so the two
   * are offered side by side rather than one being buried in the other.
   *
   * A dwelling with no branch goes straight to the muster, exactly as before:
   * the extra click only exists where there is a second thing to click.
   */
  openDwelling(id, b) {
    const nodes = dwellingNodes(this.town.faction, this.dwellingRoot(id));
    if (!nodes.length) return this.dwellingRecruit(b.dwellingTier);
    const owned = new Set(this.state.players[this.town.owner]?.upgrades ?? []);
    const done = nodes.filter((n) => owned.has(n.id)).length;
    showDialog(this, {
      title: b.name,
      lines: [b.desc, `Improvements trained here: ${done} of ${nodes.length}`],
      buttons: [
        { text: 'Cancel' },
        { text: 'Recruit', blue: true, icon: '⚔', onClick: () => this.dwellingRecruit(b.dwellingTier) },
        { text: 'Improvements', icon: '⚒', onClick: () => this.improvementsDialog(id, b) },
      ],
    });
  }

  /**
   * A dwelling's improvement branch: what each node does to the troops in
   * physical terms, what it costs, which crews it ties up and for how long.
   *
   * EVERY NODE IS SHOWN, including the ones this town cannot start yet, because
   * the branch is a plan a player makes several turns ahead — a list that hides
   * its locked entries cannot be planned against. Status comes from the engine's
   * own gate (`upgradeNodeBlockReason`), so the button and the rules cannot
   * disagree about why something is refused.
   *
   * The classic damage model does not read a creature's `phys` block at all, so
   * a node bought under it would be a purchase that changes nothing. That is
   * said at the top and the buttons stand down, rather than taking the gold and
   * leaving the player to wonder where the effect went.
   */
  improvementsDialog(buildingId, b) {
    const s = this.state;
    const town = this.town;
    const nodes = dwellingNodes(town.faction, this.dwellingRoot(buildingId));
    const owned = new Set(s.players[town.owner]?.upgrades ?? []);
    const jobs = allJobs(s).filter((j) => j.kind === 'upgradeNode' && j.owner === town.owner);
    const modelOff = !featureOn(s, 'physicalDamage');

    const W = this.scale.width, H = this.scale.height;
    const w = Math.min(620, W - 30);
    const headH = modelOff ? 76 : 56;
    // Rows tighten to fit rather than the panel being clamped under them: a
    // clamped panel still draws every row at its full pitch, so the last one
    // walks out through the bottom edge. Every node has to be on screen (see
    // above), so it is the pitch that gives.
    //
    // THE FLOOR IS 46, NOT 56, and the six points came off it when the branches
    // widened. A dwelling used to host three nodes and now hosts four — six at
    // the Homestead, which carries the original irregular branch plus War Shafts
    // — and at 56 the pitch stopped giving before the panel stopped needing it:
    // measured in a browser, the Homestead's six rows sit inside the viewport
    // down to 460px of window height and clip the last row's cost line by 3px at
    // 400px, which is a phone held sideways. At 46 the same six rows fit 400px
    // with room to spare. Three lines of 11-14px text want about 58px, so a row
    // under 46 would start colliding with itself rather than with the frame, and
    // that is the floor's real job.
    const rowH = Math.max(46, Math.min(74, Math.floor((H - 20 - headH - 56) / Math.max(1, nodes.length))));
    const h = Math.min(H - 20, headH + nodes.length * rowH + 56);
    const px = (W - w) / 2, py = (H - h) / 2;
    const root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55).setInteractive());
    root.add(panel(this, px, py, w, h));
    root.add(label(this, W / 2, py + 16, `${b.name} — Improvements`,
      { size: '17px', bold: true, color: COLORS.gold, ox: 0.5 }));
    root.add(label(this, W / 2, py + 38, 'Re-equips this dwelling\'s troops for the whole realm · crews work it over several days',
      { size: '10.5px', color: COLORS.dim, ox: 0.5 }));
    if (modelOff) {
      // THE OLD LINE SENT THE PLAYER SOMEWHERE THAT COULD NOT HELP THEM. It read
      // "these change nothing until it is on (Settings)", and a game snapshots
      // its feature flags at New Game — so a player could open Settings, turn
      // the model on, come back, and find the panel exactly as dead as before.
      // The setting governs the next game. This one is governed by a switch that
      // has to live here, next to the thing it unlocks (core adoptFeature).
      root.add(label(this, W / 2, py + 54,
        'The Physical Damage Model is off for this game — these are inert until it is adopted.',
        { size: '11px', color: COLORS.danger, ox: 0.5 }));
      root.add(button(this, W / 2, py + 70, 240, 24, 'Adopt the model for this campaign',
        () => {
          root.destroy();
          showDialog(this, {
            title: 'Adopt the Physical Damage Model?',
            lines: [
              'Damage stops rolling on the attack ladder and starts coming from mass,',
              'speed, armour hardness and wound energy. Every improvement your',
              'dwellings can be given patches that model, and none of them do',
              'anything without it.',
              '',
              'It takes effect from your NEXT battle — nothing already fought changes.',
              'This cannot be undone from here.',
            ],
            buttons: [
              {
                text: 'Adopt',
                blue: true,
                primary: true,
                onClick: () => {
                  adoptFeature(s, 'physicalDamage');
                  playSfx('build');
                  this.buildAll();
                  this.improvementsDialog(buildingId, b);
                },
              },
              { text: 'Cancel', cancel: true, onClick: () => this.improvementsDialog(buildingId, b) },
            ],
          });
        }, { fontSize: '11px' }));
    }

    nodes.forEach((n, i) => {
      const ry = py + headH + i * rowH;
      root.add(inset(this, px + 14, ry, w - 28, rowH - 8));
      const job = jobs.find((j) => j.target === n.id);
      const held = owned.has(n.id);
      // The engine's gate, asked exactly as the purchase will ask it.
      const reason = held ? null : upgradeNodeBlockReason(s, town, n.id);
      const buyable = !held && !job && !reason && !modelOff;
      const nameCol = held ? COLORS.good : buyable ? COLORS.gold : COLORS.dim;
      root.add(label(this, px + 28, ry + 8, n.name, { size: '14px', bold: true, color: nameCol }));
      root.add(label(this, px + 28, ry + 27, n.desc, { size: '11px', color: COLORS.parchment, wrap: w - 200 }));
      const crew = n.crew || {};
      const line = held
        ? 'Trained — the realm\'s troops carry it'
        : job
          ? `Under way — ${job.worked} of ${job.days} crew-days done`
          : `${costText(n.cost)} · ${crew.count || 1} ${crew.pool || 'crew'} for ${crew.days || 0}d`;
      const lineCol = held ? COLORS.good : job ? COLORS.gold : reason ? COLORS.danger : COLORS.dim;
      root.add(label(this, px + 28, ry + 46, line, { size: '11px', color: lineCol, wrap: w - 200 }));

      if (held || job) return;
      if (reason) {
        root.add(label(this, px + w - 34, ry + (rowH - 8) / 2, reason,
          { size: '10.5px', color: COLORS.dim, ox: 1, oy: 0.5, wrap: 140 }));
        return;
      }
      root.add(button(this, px + w - 88, ry + (rowH - 8) / 2, 132, 34,
        modelOff ? 'Model off' : 'Commission',
        () => {
          if (modelOff) return;
          const res = buyUpgradeNode(s, town, n.id);
          root.destroy();
          if (!res.ok) return showDialog(this, { title: n.name, lines: [res.reason] });
          playSfx('build');
          this.buildAll();
          this.improvementsDialog(buildingId, b);
        },
        { blue: buyable, fontSize: '12px', icon: buyable ? '⚒' : null }));
    });

    root.add(button(this, W / 2, py + h - 24, 120, 34, 'Close', () => root.destroy()));
  }

  /** Recruit from a single dwelling — its own unit (the upgraded creature once
   *  the upgraded dwelling is built). */
  dwellingRecruit(tier) {
    const creatureId = recruitableCreature(this.town, tier);
    if (creatureId) this.recruitDialog(tier, creatureId);
    else showDialog(this, { title: 'Dwelling', lines: ['Build this dwelling to recruit its creatures.'] });
  }

  /**
   * The Fort/Citadel/Castle "recruit overview": one row per available tier (the
   * unit, weekly availability + cost, and a Recruit button that opens the same
   * per-tier recruitDialog). A one-stop muster from behind the walls.
   */
  recruitOverviewDialog() {
    const town = this.town;
    const tiers = [];
    for (let tier = 1; tier <= 7; tier++) {
      const creatureId = recruitableCreature(town, tier);
      if (creatureId) tiers.push({ tier, creatureId, avail: town.available[tier] || 0 });
    }
    if (!tiers.length) {
      showDialog(this, { title: 'Fortifications', lines: ['No dwellings built yet — construct one to recruit creatures.'] });
      return;
    }
    const W = this.scale.width, H = this.scale.height;
    const rowH = 54;
    const w = 460, h = 78 + tiers.length * rowH;
    const px = (W - w) / 2, py = (H - h) / 2;
    const root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55).setInteractive());
    root.add(panel(this, px, py, w, h));
    root.add(label(this, W / 2, py + 18, 'Recruit Creatures', { size: '18px', bold: true, color: COLORS.gold, ox: 0.5 }));
    tiers.forEach(({ tier, creatureId, avail }, i) => {
      const ry = py + 46 + i * rowH;
      root.add(inset(this, px + 16, ry, w - 32, rowH - 8));
      const c = CREATURES[creatureId];
      root.add(unitIcon(this, creatureId, px + 46, ry + (rowH - 8) / 2, 38));
      root.add(label(this, px + 80, ry + 8, c.name, { size: '14px', bold: true, color: COLORS.parchment }));
      root.add(label(this, px + 80, ry + 28, `${avail} available · ${costText(c.cost)}`, {
        size: '12px', color: avail ? COLORS.good : COLORS.dim,
      }));
      root.add(button(this, px + w - 74, ry + (rowH - 8) / 2, 108, 34, 'Recruit',
        () => { root.destroy(); this.recruitDialog(tier, creatureId); },
        { blue: true, fontSize: '13px', icon: '⚔' }));
    });
    root.add(button(this, W / 2, py + h - 24, 120, 34, 'Close', () => root.destroy()));
  }

  /**
   * Shipyard building: launch a boat at the town's own coast for CONFIG.BOAT_COST.
   * townShipyardBuildCheck backs the button state so the dialog agrees exactly
   * with the engine (and the AI) about whether a boat can be built right now.
   */
  shipyardDialog() {
    const s = this.state;
    const town = this.town;
    const check = townShipyardBuildCheck(s, town);
    const REASONS = {
      boatAtDock: 'A boat already waits at the town’s coast — sail it out first.',
      noDock: 'No open water at the coast to launch onto right now.',
      cost: `Not enough resources — a boat costs ${costText(CONFIG.BOAT_COST)}.`,
      noShipyard: 'The shipyard has not been built.',
    };
    const lines = [
      'The town shipyard can launch a boat at its own coast.',
      `Cost: ${costText(CONFIG.BOAT_COST)}.`,
    ];
    if (!check.ok) lines.push(REASONS[check.reason] || 'A boat cannot be built here now.');
    showDialog(this, {
      title: 'Shipyard',
      lines,
      buttons: check.ok
        ? [
          { text: 'Cancel' },
          {
            text: 'Build Boat',
            blue: true,
            onClick: () => {
              buildBoatAtTown(s, town);
              this.buildAll();
            },
          },
        ]
        : [{ text: 'OK' }],
    });
  }

  /**
   * Blacksmith: sell war machines (Ballista / First Aid Tent / Ammo Cart) to the
   * hero standing in the town. One of each per hero — the machine deploys itself
   * at the start of every battle that hero fights. Rebuilds in place after each
   * purchase so Owned / affordability state stays live. Mirrors buyWarMachine's
   * rules exactly (blacksmith built, a visiting hero, gold), so the buttons never
   * disagree with the engine.
   */
  blacksmithDialog() {
    const s = this.state;
    const town = this.town;
    const player = s.players[town.owner];
    const hero = town.visitingHeroId ? s.heroes[town.visitingHeroId] : null;
    if (!hero) {
      showDialog(this, {
        title: 'Blacksmith',
        lines: ['The blacksmith forges war machines, but a hero must be in the',
          'town to receive them. Move a hero here, then return.'],
      });
      return;
    }
    const ids = Object.keys(CONFIG.WAR_MACHINES);
    const W = this.scale.width, H = this.scale.height;
    const rowH = 60;
    const w = 500, h = 96 + ids.length * rowH;
    const px = (W - w) / 2, py = (H - h) / 2;

    let root = null;
    const draw = () => {
      if (root) root.destroy();
      root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
      root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55).setInteractive());
      root.add(panel(this, px, py, w, h));
      root.add(label(this, W / 2, py + 16, 'Blacksmith', { size: '18px', bold: true, color: COLORS.gold, ox: 0.5 }));
      root.add(label(this, W / 2, py + 38, `Arming ${hero.name}`, { size: '11px', color: COLORS.dim, ox: 0.5 }));
      ids.forEach((id, i) => {
        const c = CREATURES[id];
        const cost = CONFIG.WAR_MACHINES[id].cost;
        const ry = py + 58 + i * rowH;
        root.add(inset(this, px + 16, ry, w - 32, rowH - 8));
        root.add(unitIcon(this, id, px + 46, ry + (rowH - 8) / 2, 40));
        root.add(label(this, px + 80, ry + 7, c.name, { size: '14px', bold: true, color: COLORS.parchment }));
        root.add(label(this, px + 80, ry + 26, c.desc, { size: '9px', color: COLORS.dim }));
        root.add(label(this, px + 80, ry + 40, costText(cost), { size: '10px', color: COLORS.gold }));
        const owned = !!hero.warMachines?.[id];
        const affordable = canAfford(player, cost);
        if (owned) {
          root.add(label(this, px + w - 74, ry + (rowH - 8) / 2, 'Owned', { size: '12px', color: COLORS.good, ox: 0.5 }));
        } else {
          const buyBtn = button(this, px + w - 74, ry + (rowH - 8) / 2, 108, 34, 'Buy',
            () => { if (buyWarMachine(s, town, id).ok) { playSfx('coin'); this.buildAll?.(); draw(); } },
            { blue: affordable, fontSize: '13px' });
          if (!affordable) buyBtn.setEnabled(false);
          root.add(buyBtn);
        }
      });
      root.add(button(this, W / 2, py + h - 24, 120, 34, 'Close', () => root.destroy()));
    };
    draw();
  }

  /**
   * Exchange any resource (or gold) for any other. Pick GIVE + GET, set the
   * amount, Trade. Rates improve with the number of marketplaces you own, and a
   * resource↔resource trade pays both spreads (routed through gold value).
   */
  marketDialog() {
    const s = this.state;
    const player = s.players[this.town.owner];
    const opts = ['gold', ...RESOURCES.filter((r) => r !== 'gold')]; // gold + 6 tradables
    const W = this.scale.width, H = this.scale.height;
    const root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
    const w = 640, h = 400;
    const px = (W - w) / 2, py = (H - h) / 2;
    let give = 'wood', get = 'gold', n = 1;

    // The stepper counts whichever resource is PRICIER, so each +/- press moves
    // that good by one whole unit — trading gold→gems steps gems (the gold
    // adjusts to suit), and if a gem is worth 8 ore, one press still buys 1 gem
    // rather than needing 8 presses of ore. Value = gold to acquire one unit
    // (gold itself = 1); GET being dearer means we step GET, ties favour GET so
    // you dial in what you receive.
    const valueOf = (res) => marketBuyRate(s, player, res);
    const stepGet = () => valueOf(get) >= valueOf(give);
    // Translate a stepper count `nn` (in units of the pricier resource) into the
    // concrete { giveAmt, recv } trade. Stepping GET spends the MINIMUM of the
    // cheaper GIVE needed to receive exactly nn units (ceil), so there's no
    // overpay; stepping GIVE is the plain sell where nn is the give amount.
    const resolve = (nn) => {
      if (stepGet()) {
        const giveAmt = marketGiveForGet(s, player, give, get, nn);
        return { giveAmt, recv: marketQuote(s, player, give, giveAmt, get) };
      }
      return { giveAmt: nn, recv: marketQuote(s, player, give, nn, get) };
    };

    const chipRow = (yy, sel, onPick) => {
      const n = opts.length, cw = 82, gap = 4;
      let x = W / 2 - (n * cw + (n - 1) * gap) / 2 + cw / 2;
      for (const r of opts) {
        const on = r === sel;
        root.add(this.add.rectangle(x, yy, cw - 2, 52, on ? 0x2a3550 : 0x14121f)
          .setStrokeStyle(2, on ? 0xe8c060 : 0x4a4560)
          .setInteractive({ useHandCursor: true }).on('pointerup', () => onPick(r)));
        root.add(resourceIcon(this, r, x, yy - 9, 20)); // raster pack when present, else procedural
        root.add(label(this, x, yy + 15, `${player.resources[r] || 0}`,
          { size: '11px', ox: 0.5, color: on ? COLORS.gold : COLORS.parchment }));
        x += cw + gap;
      }
    };

    const rebuild = () => {
      root.removeAll(true);
      root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55).setInteractive());
      root.add(panel(this, px, py, w, h));
      root.add(label(this, W / 2, py + 16, 'Marketplace', { size: '19px', bold: true, color: COLORS.gold, ox: 0.5 }));
      const M = Math.max(1, marketplaceCount(s, player));
      root.add(label(this, W / 2, py + 40,
        `${M} marketplace${M === 1 ? '' : 's'} — more markets, better rates · Treasury ${player.resources.gold}g`,
        { size: '12px', color: COLORS.dim, ox: 0.5 }));

      root.add(label(this, px + 26, py + 66, 'GIVE', { size: '12px', bold: true, color: COLORS.dim }));
      chipRow(py + 96, give, (r) => {
        give = r;
        if (get === give) get = opts.find((o) => o !== give);
        n = 1; // unit meaning may flip (give/get side) — reset the count
        rebuild();
      });
      root.add(label(this, px + 26, py + 134, 'GET', { size: '12px', bold: true, color: COLORS.dim }));
      chipRow(py + 164, get, (r) => {
        get = r;
        if (give === get) give = opts.find((o) => o !== get);
        n = 1; // unit meaning may flip (give/get side) — reset the count
        rebuild();
      });

      const owned = player.resources[give] || 0;
      const primaryIsGet = stepGet();
      const primaryRes = primaryIsGet ? get : give;
      // Max in PRIMARY units: everything you own converted to the pricier GET,
      // or simply your holdings when the pricier good is the one you GIVE.
      const maxN = primaryIsGet ? Math.max(1, marketQuote(s, player, give, owned, get)) : Math.max(1, owned);
      n = Math.max(1, Math.min(n, maxN));
      const quote = label(this, W / 2, py + 210, '', { size: '16px', bold: true, ox: 0.5 });
      root.add(quote);
      const refreshQuote = (nn) => {
        const { giveAmt, recv } = resolve(nn);
        quote.setText(`Give ${giveAmt} ${give}   →   get ${recv} ${get}`);
        quote.setColor(recv > 0 && giveAmt <= owned ? COLORS.good : COLORS.dim);
      };
      // The picker steps the PRICIER resource by whole units and updates the quote
      // LIVE (no full rebuild), so dialing 10 gems is 10 clicks, not 80 of ore.
      // Only a GIVE/GET chip change rebuilds, to reset the picker's unit + range.
      const picker = numberPicker(this, W / 2, py + 252, {
        value: n, min: 1, max: maxN, bigStep: 10, width: 300,
        fmt: (v) => `${v} ${primaryRes}`,
        onChange: (v) => { n = v; refreshQuote(v); },
      });
      root.add(picker.objects);
      refreshQuote(n);

      root.add(button(this, W / 2 - 80, py + h - 30, 140, 34, 'Trade', () => {
        const { giveAmt } = resolve(n);
        if (marketExchange(s, player, give, giveAmt, get).ok) playSfx('coin');
        n = 1; rebuild();
      }, { blue: true }));
      root.add(button(this, W / 2 + 80, py + h - 30, 140, 34, 'Done', () => { root.destroy(); this.buildAll(); }));
    };
    rebuild();
  }

  tavernDialog() {
    const s = this.state;
    const town = this.town;
    if (town.visitingHeroId) {
      showDialog(this, { title: 'Tavern', lines: ['The town square is occupied — move the visiting hero out first.'] });
      return;
    }
    // Returning veterans (this player's retired heroes) always show; fresh
    // recruits fill up to two more. A veteran keeps its level/skills and quotes
    // the re-hire price.
    // Local rumors: weekly flavor + soft intel, so a tavern visit is worth
    // something even when nobody's hiring (see core/rumors.js).
    const rumors = tavernRumors(s, town.owner);
    const rumorBlock = ['— Local rumors —', ...rumors, ''];
    const all = hireableHeroes(s, town);
    const veterans = all.filter((id) => pooledHero(s, town.owner, id));
    const fresh = all.filter((id) => !pooledHero(s, town.owner, id)).slice(0, 2);
    const list = [...veterans, ...fresh];
    // Masterless captains currently in the field. Offered here rather than found
    // on the map, because the fiction is that you send for a freelancer whose
    // reputation has reached you — and because a price the player can compare
    // against a recruit's is the whole point of the feature.
    const captains = hireableRonins(s, town);
    if (!list.length && !captains.length) {
      showDialog(this, { title: 'Tavern', lines: [...rumorBlock, 'No heroes are looking for work this week.'] });
      return;
    }
    const heroName = (id) => pooledHero(s, town.owner, id)?.name || HERO_ROSTER[id].name;
    showDialog(this, {
      title: 'Tavern — Hire a Hero',
      lines: [...rumorBlock, ...list.map((id) => {
        const cost = hireCost(s, town, id);
        const vet = pooledHero(s, town.owner, id);
        if (vet) return `${vet.name} — Level ${vet.level} ${vet.className || vet.class} · returning veteran — ${cost} gold`;
        const d = HERO_ROSTER[id];
        return `${d.name} — ${d.class}, ${Object.keys(d.skills).join(', ')} — ${cost} gold`;
      }), ...captains.map((obj) => {
        const h = roninHero(obj);
        // What it brings is what you watched it earn: a level, and the band it
        // has been keeping alive out there.
        return `${h.name} — Level ${h.level} ${h.className || h.class} · masterless, `
          + `${obj.count} ${CREATURES[obj.creature]?.name || obj.creature} — ${roninHireCost(obj)} gold`;
      })],
      buttons: [
        { text: 'Cancel' },
        ...list.map((id) => ({
          text: `Hire ${heroName(id)} (${hireCost(s, town, id)}g)`,
          blue: true,
          track: 'HireHero', // one telemetry id for the gesture, not one per hero name
          onClick: () => {
            const h = hireHero(s, town, id);
            // Rebuild FIRST — it destroys all scene children, which would
            // otherwise eat the failure dialog created below.
            this.buildAll();
            if (!h) showDialog(this, { title: 'Tavern', lines: ['Hiring failed — not enough gold?'] });
          },
        })),
        ...captains.map((obj) => ({
          text: `Hire ${roninHero(obj).name} (${roninHireCost(obj)}g)`,
          blue: true,
          track: 'HireRonin',
          onClick: () => {
            const h = hireRonin(s, town, obj.id);
            this.buildAll(); // destroys scene children — before any dialog below
            if (!h) showDialog(this, { title: 'Tavern', lines: ['Hiring failed — not enough gold?'] });
          },
        })),
      ],
      width: 560,
    });
  }

  /**
   * The "commission the next guild level" row for the guild overlay, or null when
   * the guild is already at the top of its chain. A dead button with the reason
   * under it beats no button at all: "Requires City Hall" or "Not enough
   * resources" is the answer to the question the player is asking.
   */
  guildUpgradeExtra() {
    const town = this.town;
    const next = nextGuildLevel(town);
    if (!next) return null;
    const b = buildingCatalog(town.faction)[next];
    const reason = buildBlockReason(this.state, town, next);
    return {
      label: `⌂  Commission ${b.name}`,
      note: reason ? reason : `Cost: ${costText(b.cost)}`,
      enabled: !reason,
      onClick: () => {
        if (buildStructure(this.state, town, next)) playSfx('build');
        this.buildAll();
      },
    };
  }

  guildDialog() {
    const town = this.town;
    // A visiting hero studies whatever they now qualify for on entering.
    const visiting = town.visitingHeroId ? this.state.heroes[town.visitingHeroId] : null;
    const learned = visiting ? learnGuildSpells(this.state, town, visiting) : [];
    const level = guildLevelOf(town);
    const extra = this.guildUpgradeExtra();

    // The guild's researched spells, split into Combat / Adventure pictogram tabs.
    const all = town.guildSpells
      ? Object.keys(town.guildSpells).sort().flatMap((lvl) => town.guildSpells[lvl])
      : [];
    if (!all.length) {
      // The one case where the upgrade matters most — an empty guild — used to be
      // a dead end with nothing to press. Offer the next level right here.
      showDialog(this, {
        title: 'Mage Guild',
        lines: [
          'The guild is quiet. Raise a higher guild level to research spells.',
          extra ? `${extra.label.replace(/^⌂\s+/, '')} — ${extra.note}` : null,
        ].filter(Boolean),
        // Only a LIVE button: the reason it is blocked already reads on the line
        // above, and a dead button in a two-button dialog just looks broken.
        buttons: [
          ...(extra && extra.enabled ? [{ text: 'Commission it', primary: true, onClick: extra.onClick }] : []),
          { text: 'Close' },
        ],
        width: 520,
      });
      return;
    }
    const combat = all.filter((id) => SPELLS[id] && !SPELLS[id].adventure);
    const adventure = all.filter((id) => SPELLS[id] && SPELLS[id].adventure);
    const groups = [];
    if (combat.length) groups.push({ label: 'Combat', spells: combat });
    if (adventure.length) groups.push({ label: 'Adventure', spells: adventure });

    // Which tiers this guild actually teaches, and what a hero needs to read them:
    // a guild level is only half the story — Wisdom is the other half, and a player
    // staring at a spell they cannot learn deserves to be told which it is.
    const need = wisdomRequiredForTier(level);
    const subtitle = [
      `Level ${level} guild — teaches spell tiers 1–${level}`,
      visiting ? `${visiting.name} is studying here` : 'A visiting hero learns these spells',
      need > 0 ? `tier ${level} needs Wisdom ${need}` : null,
    ].filter(Boolean).join('  ·  ');

    openSpellbook(this, {
      title: 'Mage Guild',
      subtitle,
      groups,
      extra,
      footer: learned.length ? `${visiting.name} studied: ${learned.map((x) => SPELLS[x].name).join(', ')}` : undefined,
    });
  }
}

function creatureTip(c) {
  const abil = c.abilities?.length ? `\n${c.desc}` : '';
  return `${c.name}\nAttack ${c.attack}  Defense ${c.defense}\nDamage ${c.damage[0]}–${c.damage[1]}  HP ${c.health}\nSpeed ${c.speed}  ${c.reach}${abil}\nCost: ${costText(c.cost)}`;
}
