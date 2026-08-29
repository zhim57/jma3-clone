/**
 * AdvUIScene — Screen-space HUD & dialogs for the adventure layer.
 *
 * Lives in its own scene (static camera) so input hit-testing stays correct
 * while the Adventure camera pans/zooms — the standard Phaser pattern for
 * strategy-game UI. It renders above AdventureScene and is put to sleep
 * whenever a full-screen scene (Town / Combat / Hero) opens.
 *
 * All world mutations still go through AdventureScene / core actions; this
 * scene only *presents*.
 */

import Phaser from 'phaser';
import { RESOURCES, CONFIG, XP_TABLE } from '../config.js';
import { FACTIONS, BANNER_COLORS } from '../data/factions.js';
import { SKILLS, SKILL_LEVEL_NAMES } from '../data/skills.js';
import { SPELLS } from '../data/spells.js';
import { unitIcon, heroPortrait, heroTextureKey, townIcon, resourceIcon, artifactIcon } from '../gfx/sprites.js';
import { baseColorOf } from '../gfx/terrain.js';
import { makeCanvas, shade, rgba } from '../gfx/canvasKit.js';
import { getState, saveGame } from '../game/session.js';

import { playSfx, playMusic } from '../game/audio.js';
import { playerHeroes, playerTowns, weekOf, dayOfWeek, levelMap, bannerSlot } from '../core/GameState.js';
import { daysToNextWave, activeBands, invasionTruce } from '../core/invasions.js';
import { roninStacks } from '../core/ronins.js';
import { invasionForecast } from '../core/invaderPlanner.js';
import { seasonName } from '../core/seasons.js';
import { tideOfWar } from '../core/pacing.js';
import { fogFor } from '../map/fog.js';
import { chooseSkill, resolveChest, fulfillSeerQuest, seerRewardText, deliverGrail, grailKnown, grailPerkText,
  recruitFromDwelling, recruitCost, dwellingCreature, dwellingName,
  victoryObjectiveText, lossConditionText,
  tradingPostView, sellArtifactsForXp, buyArtifactAt, tradingPostSellXp } from '../core/actions.js';
import { isCampaign, currentScenario } from '../core/campaign.js';
import { canRecruitFrom, pleaOffers } from '../core/pacts.js';
import { ageProgress, ageFloorText } from '../core/ages.js';
import { heldWinReason } from '../core/actions.js';
import { uprisingReport } from '../core/uprisings.js';
import { heroMaxMovement, heroMaxMana, heroStat } from '../core/heroUtils.js';
import { spellCost, masteryNote, scrySighting } from '../core/magic.js';
import { CREATURES } from '../data/creatures.js';
import { ARTIFACTS } from '../data/artifacts.js';
import {
  panel, inset, button, label, iconButton, numberPicker, showDialog, modalOpen, trackModal, pinToScreen, resetModals, Tooltip, FONT, COLORS, DEPTH, costText,
} from '../ui/uikit.js';
import { openSpellbook } from '../ui/spellbook.js';
import { aiLogLines, aiDiagnosis } from '../ai/aiLog.js';
import { toJSONL, aggregateLines } from '../ai/telemetry.js';

const T = CONFIG.TILE;

/** 0xRRGGBB → a `#rrggbb` CSS string for a 2D canvas fillStyle. */
const cssHex = (n) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

export class AdvUIScene extends Phaser.Scene {
  constructor() {
    super('AdvUI');
  }

  init(data) {
    this.adv = data.adventure;
  }

  create() {
    this.state = getState();
    this.tooltip = new Tooltip(this); // hover tips for the HUD's icon buttons
    this.buildHUD();
    this.scale.on('resize', this.layoutHUD, this);
    // The raster pack may arrive after the HUD first drew — rebuild it once so
    // the resource-bar icons (and any other sprite-backed HUD art) upgrade.
    if (!this.game.registry.get('spritesReady')) {
      this.game.events.once('sprites-loaded', this.layoutHUD, this);
    }
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.layoutHUD, this);
      this.game.events.off('sprites-loaded', this.layoutHUD, this);
      // Free the baked minimap canvas texture parked in the game-wide manager.
      if (this.textures.exists('mm_terrain')) this.textures.remove('mm_terrain');
    });
    this.adv.uiReady(this);
    // Announce the preset once at game start so it's unmistakable the growth /
    // scaling / intervention system is live (the panel badge is the persistent
    // reminder). No-op in Classic.
    if (tideOfWar(this.state)) {
      this.toast('⚔ Tide of War is active — wild armies grow each week and the world fights back.');
    }
  }

  // ---- study-break Pomodoro (#10) ------------------------------------------
  // CLONE: the study-break Pomodoro (armPomodoro / disarmPomodoro / pomodoroFired
  // / openStudy) is removed with the rest of the study module — see the note in
  // game/settings.js. Upstream it fires a timer mid-game that opens a math or
  // reading break which pays out in-game resources.

  hudWidth() {
    return 232;
  }

  // ---- mini-map ------------------------------------------------------------
  drawMinimap() {
    if (!this.mmMapG || !this.mm) return;
    const s = getState();
    if (!s?.map) return;
    const level = this.adv?.viewLevel ?? 0; // draw the level currently on screen
    const map = levelMap(s, level) || s.map;
    const fog = fogFor(s, 0, level);
    const { x: ox, y: oy, size } = this.mm;
    const cell = size / Math.max(map.w, map.h);
    const offX = ox + (size - map.w * cell) / 2;
    const offY = oy + (size - map.h * cell) / 2;
    this.mm.cell = cell; this.mm.offX = offX; this.mm.offY = offY;

    // Terrain + fog are baked once to an offscreen texture (below); only the
    // MOVING landmarks — town/hero dots — are drawn live into mmMapG each refresh.
    this.bakeMinimapTerrain(map, fog, level, offX, offY, cell);

    const g = this.mmMapG;
    g.clear();
    // Brightened banner colours, one per SLOT — the minimap had four, hard-coded,
    // so an invader realm's towns and heroes drew grey. "We can even colour them
    // on the minimap" is most of the point of them being realms at all.
    const OWNER = BANNER_COLORS.map((c) => shade(c, 0.22));
    for (const town of Object.values(s.towns || {})) {
      if ((town.z ?? 0) !== level) continue; // only landmarks on the shown level
      if (fog && fog[town.y * map.w + town.x] === 0) continue;
      g.fillStyle(town.owner >= 0 ? (OWNER[bannerSlot(s, town.owner)] || 0xaaaaaa) : 0xcfcfcf, 1);
      g.fillRect(offX + town.x * cell - 1, offY + town.y * cell - 1, cell + 2, cell + 2);
    }
    for (const hero of Object.values(s.heroes || {})) {
      if ((hero.z ?? 0) !== level) continue;
      if (fog && fog[hero.y * map.w + hero.x] === 0) continue;
      g.fillStyle(OWNER[bannerSlot(s, hero.owner)] || 0xaaaaaa, 1);
      g.fillCircle(offX + hero.x * cell + cell / 2, offY + hero.y * cell + cell / 2, Math.max(1.6, cell * 0.55));
    }
    // A View Earth sighting: the powers you were SHOWN rather than the ones you can
    // see. Drawn HOLLOW, and only on ground still in fog — a filled mark means "this
    // is there now", a ring means "this was reported to be there", and the two must
    // never be confused when the second is by then several days old.
    const sight = scrySighting(s, 0);
    if (sight) {
      const a = sight.alpha;
      for (const m of sight.marks) {
        if ((m.z ?? 0) !== level) continue;
        if (!fog || fog[m.y * map.w + m.x] !== 0) continue; // in the light already
        const col = m.owner >= 0 ? (OWNER[bannerSlot(s, m.owner)] || 0xaaaaaa) : 0xcfcfcf;
        const cx = offX + m.x * cell + cell / 2, cy = offY + m.y * cell + cell / 2;
        g.lineStyle(Math.max(1.2, cell * 0.28), col, a);
        if (m.kind === 'town') {
          g.strokeRect(offX + m.x * cell - 1, offY + m.y * cell - 1, cell + 2, cell + 2);
        } else {
          g.strokeCircle(cx, cy, Math.max(1.6, cell * 0.55));
        }
      }
    }
    // Led bands (ronins), for the same reason war-bands are here: a captain's
    // stack is a `monster` object, and monsters are not on the minimap at all, so
    // the one neutral in the world that MARCHES was also the one you could not
    // track on the panel that exists for tracking things. A hollow bone-gold
    // DIAMOND — not a hero's filled dot, not a band's red ring, not a scry mark's
    // owner-coloured circle — because a ronin is none of those: it is nobody's,
    // and it is not automatically your enemy.
    for (const { obj, level: oz } of roninStacks(s)) {
      if (oz !== level) continue;
      if (fog && fog[obj.y * map.w + obj.x] === 0) continue;
      const cx = offX + obj.x * cell + cell / 2, cy = offY + obj.y * cell + cell / 2;
      const r = Math.max(2.2, cell * 0.75);
      g.lineStyle(Math.max(1.3, cell * 0.26), 0xe7d49a, 1);
      g.beginPath();
      g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy);
      g.closePath(); g.strokePath();
    }
    // War-bands, LAST so nothing paints over them. A band is a `monster` object
    // and monsters are not drawn on the minimap at all — which left the one
    // thing on the map actively marching at your towns as the only thing you
    // could not find on the panel that exists to tell you where things are. A
    // hollow red ring, bigger than a hero dot and unlike any banner colour.
    for (const band of activeBands(s)) {
      if (level !== 0) continue;                    // bands come ashore on the surface
      if (fog && fog[band.y * map.w + band.x] === 0) continue;
      const cx = offX + band.x * cell + cell / 2, cy = offY + band.y * cell + cell / 2;
      const r = Math.max(2.4, cell * 0.85);
      g.lineStyle(Math.max(1.5, cell * 0.3), 0xff3b30, 1);
      g.strokeCircle(cx, cy, r);
      g.fillStyle(0xff3b30, 0.45);
      g.fillCircle(cx, cy, r * 0.45);
    }
  }

  /**
   * Bake terrain + fog into an offscreen canvas texture shown as ONE Image.
   * drawMinimap used to paint every tile as a fillRect into a live Graphics on
   * each refresh — a retained ~7.7k-rect command list the WebGL renderer
   * re-submitted every frame. Now that grid is a single quad, re-baked only when
   * the shown level or the explored-tile count changes (fog only ever reveals),
   * while the dots + viewport rect stay live and cheap.
   */
  bakeMinimapTerrain(map, fog, level, offX, offY, cell) {
    let known = 0;
    if (fog) { for (let i = 0; i < fog.length; i++) if (fog[i] !== 0) known++; }
    const sig = `${level}:${map.w}x${map.h}:${fog ? known : 'full'}`;
    if (sig !== this._mmSig) {
      this._mmSig = sig;
      const step = Math.ceil(cell) + 1;
      const canvas = makeCanvas(Math.ceil(map.w * cell) + 1, Math.ceil(map.h * cell) + 1);
      const ctx = canvas.getContext('2d');
      for (let ty = 0; ty < map.h; ty++) {
        for (let tx = 0; tx < map.w; tx++) {
          const idx = ty * map.w + tx;
          const seen = !fog || fog[idx] !== 0;
          ctx.fillStyle = cssHex(seen ? baseColorOf(map.tiles[idx].terrain) : 0x2a2842);
          ctx.fillRect(tx * cell, ty * cell, step, step);
        }
      }
      const key = 'mm_terrain';
      if (this.textures.exists(key)) this.textures.remove(key);
      this.textures.addCanvas(key, canvas);
      if (!this.mmTerrainImg) {
        this.mmTerrainImg = this.add.image(offX, offY, key).setOrigin(0, 0);
        this.hud.add(this.mmTerrainImg);
        this.hud.moveBelow(this.mmTerrainImg, this.mmMapG); // under the dots, over the panel bg
      } else {
        this.mmTerrainImg.setTexture(key);
      }
    }
    this.mmTerrainImg?.setPosition(offX, offY);
  }

  /** AdventureScene calls this when the displayed level flips. */
  onLevelChanged() {
    this.drawMinimap();
    if (this.levelToggleLabel) {
      this.levelToggleLabel.setText(this.adv?.viewLevel === 1 ? '▲ Underground' : '▼ Surface');
    }
  }

  /** Yellow rect showing the camera's view; redrawn each frame from AdventureScene.update. */
  updateMinimapViewport() {
    if (!this.mmViewG || !this.mm?.cell || !this.adv) return;
    const cam = this.adv.cameras.main;
    const { offX, offY, cell } = this.mm;
    const g = this.mmViewG;
    g.clear();
    g.lineStyle(1.5, 0xf4d35e, 0.9);
    g.strokeRect(
      offX + (cam.scrollX / T) * cell,
      offY + (cam.scrollY / T) * cell,
      (cam.width / cam.zoom / T) * cell,
      (cam.height / cam.zoom / T) * cell,
    );
  }

  onMinimapClick(p) {
    if (!this.mm?.cell || !this.adv) return;
    const { offX, offY, cell } = this.mm;
    this.adv.cameras.main.centerOn(((p.x - offX) / cell) * T, ((p.y - offY) / cell) * T);
  }

  // =========================================================================
  // HUD structure
  // =========================================================================

  buildHUD() {
    this.hud = this.add.container(0, 0).setDepth(DEPTH.HUD);
    this.layoutHUD();
  }

  layoutHUD() {
    if (!this.hud) return;
    this.hud.removeAll(true);
    const W = this.scale.width, H = this.scale.height;
    const hw = this.hudWidth();

    // ---- top resource bar ----
    this.hud.add(panel(this, -8, -10, W + 16, 54));
    let rx = 16;
    for (const res of RESOURCES) {
      const icon = resourceIcon(this, res, rx + 10, 22, 26); // prefers the raster pack, else procedural
      const val = this.add.text(rx + 24, 22, '0', {
        fontFamily: FONT, fontSize: '14px', color: COLORS.parchment, fontStyle: 'bold',
      }).setOrigin(0, 0.5);
      val.name = `res_${res}`;
      this.hud.add([icon, val]);
      rx += res === 'gold' ? 96 : 78;
    }
    this.dateLabel = this.add.text(W - hw - 18, 22, '', {
      fontFamily: FONT, fontSize: '14px', color: COLORS.gold, fontStyle: 'bold',
    }).setOrigin(1, 0.5);
    this.hud.add(this.dateLabel);
    // The horizon: how long until the next foreign wave, and what is already
    // ashore. daysToNextWave() existed and NOTHING called it, so a player running
    // the invasions feature had no way at all to see it coming — the whole point
    // of a wave is the fortnight you spend preparing for it. Sits under the date,
    // hidden entirely when the feature is off.
    this.waveLabel = this.add.text(W - hw - 18, 40, '', {
      fontFamily: FONT, fontSize: '11.5px', color: '#e8a060', fontStyle: 'bold',
    }).setOrigin(1, 0.5);
    // Clicking the horizon opens the herald panel — the whole point of a forecast
    // is that it can be studied, not just glimpsed.
    this.waveLabel.setInteractive({ useHandCursor: true })
      .on('pointerover', (p) => this.tooltip?.show(p.x, p.y, 'The horizon — who is ashore and who is coming'))
      .on('pointerout', () => this.tooltip?.hide())
      .on('pointerup', () => { this.tooltip?.hide(); this.invasionHeraldDialog(); });
    this.hud.add(this.waveLabel);
    // Scenario-info pictogram (top-right): goals + victory/loss on demand, with a
    // hover tooltip so the icon-only button stays discoverable.
    this.hud.add(iconButton(this, W - 22, 22, 26, '📜', () => this.scenarioInfoDialog(), { tooltip: 'Scenario information', fontSize: '15px' }));
    // The AI's flight recorder (see ai/aiLog.js). Beside the scenario scroll
    // because it answers the same class of question — what is going on out there
    // — and because a rival that has quietly stopped working its economy is
    // otherwise completely invisible from this side of the map.
    this.hud.add(iconButton(this, W - 52, 22, 26, '🧠', () => this.aiBrainLogDialog(), { tooltip: 'AI brain log — what the rivals are doing, and why', fontSize: '15px' }));

    // ---- right side panel ----
    this.hud.add(panel(this, W - hw, 40, hw + 10, H - 30));
    const sx = W - hw + 14;
    let sy = 56;
    // Tide of War badge — a persistent "the growth system is live" indicator at
    // the panel top, so you always know whether the preset is on. Nothing shows
    // in Classic (layout unchanged), so the base game is untouched.
    if (tideOfWar(this.state)) {
      const bx = W - hw / 2 + 5; // panel centre
      this.hud.add(this.add.rectangle(bx, sy + 6, hw - 20, 22, 0x241b33, 0.92).setStrokeStyle(1, 0xc0a050));
      this.hud.add(label(this, bx, sy + 6, '⚔ Tide of War', { size: '12px', bold: true, color: '#f0c060', ox: 0.5, oy: 0.5 }));
      sy += 30;
    }
    this.hud.add(label(this, sx, sy, 'HEROES', { size: '12px', color: COLORS.dim, bold: true }));
    sy += 20;
    this.heroListY = sy;
    sy += 64;
    this.hud.add(label(this, sx, sy, 'TOWNS', { size: '12px', color: COLORS.dim, bold: true }));
    sy += 20;
    this.townListY = sy;
    sy += 56;
    this.heroCardY = sy;

    // ---- mini-map (fills the empty panel space above the buttons) ----
    const mmSize = Math.min(hw - 30, H * 0.32);
    const mmX = sx, mmY = H - 98 - mmSize;
    this.hud.add(label(this, sx, mmY - 15, 'MAP', { size: '12px', color: COLORS.dim, bold: true }));
    this.hud.add(this.add.rectangle(mmX + mmSize / 2, mmY + mmSize / 2, mmSize + 4, mmSize + 4, 0x0a0912).setStrokeStyle(2, 0x4a4560));
    this.mm = { x: mmX, y: mmY, size: mmSize };
    this.mmTerrainImg = null;   // offscreen-baked terrain+fog quad (see bakeMinimapTerrain)
    this._mmSig = null;         // signature of the currently-baked terrain texture
    this.mmMapG = this.add.graphics();   // town/hero dots — live, a handful of fills
    this.mmViewG = this.add.graphics();  // camera viewport rect — per frame
    this.hud.add([this.mmMapG, this.mmViewG]);
    const mmZone = this.add.rectangle(mmX + mmSize / 2, mmY + mmSize / 2, mmSize, mmSize, 0xffffff, 0.001)
      .setInteractive({ useHandCursor: true });
    mmZone.on('pointerdown', (p) => this.onMinimapClick(p));
    this.hud.add(mmZone);
    this.drawMinimap();

    // ---- zoom control (live readout + − / + ; mirrors the wheel & +/- keys) ----
    const zbw = hw - 28;
    const zy = mmY - 34;
    const zoomBtn = (bx, txt, factor) => {
      const b = this.add.rectangle(bx, zy, 26, 22, 0x1a1730, 0.92)
        .setOrigin(0, 0.5).setStrokeStyle(1.5, 0x6b5a8a).setInteractive({ useHandCursor: true });
      const t = label(this, bx + 13, zy, txt, { size: '16px', color: COLORS.parchment, ox: 0.5, oy: 0.5, bold: true });
      b.on('pointerup', () => { playSfx('click'); this.adv?.nudgeZoom(factor); });
      this.hud.add([b, t]);
    };
    zoomBtn(sx, '−', 1 / CONFIG.ZOOM_STEP);        // − zoom out
    zoomBtn(sx + zbw - 26, '+', CONFIG.ZOOM_STEP);      // + zoom in
    this.zoomLabel = label(this, sx + zbw / 2, zy, '', { size: '12px', color: COLORS.gold, ox: 0.5, oy: 0.5, bold: true });
    this.hud.add(this.zoomLabel);
    this.refreshZoomLabel();

    // ---- level toggle (only when this scenario has an underground) ----
    if (this.adv?.hasUnderground?.()) {
      const tx = mmX + mmSize, ty = mmY - 13;
      const bg = this.add.rectangle(tx, ty, 124, 22, 0x1a1730, 0.92)
        .setOrigin(1, 0.5).setStrokeStyle(1.5, 0x6b5a8a).setInteractive({ useHandCursor: true });
      this.levelToggleLabel = label(this, tx - 8, ty, this.adv.viewLevel === 1 ? '▲ Underground' : '▼ Surface',
        { size: '12px', color: COLORS.parchment, ox: 1, oy: 0.5 });
      bg.on('pointerup', () => { playSfx('click'); this.adv.toggleLevel(); });
      this.hud.add([bg, this.levelToggleLabel]);
    }

    // ---- bottom buttons ----
    const bw = hw - 26;
    this.hud.add(button(this, sx + bw / 2, H - 36, bw, 44, 'End Turn  (E)', () => this.adv.onEndTurn(), { fontSize: '16px' }));
    this.hud.add(button(this, sx + bw / 4 - 4, H - 84, bw / 2 - 6, 34, 'Save', () => {
      // Never save mid-AI-turn or mid-walk: the save would freeze that state.
      if (this.adv.aiRunning || this.adv.moving) {
        this.toast('Cannot save right now — wait for your turn.');
        return;
      }
      // Quick save writes the single slot "Continue" reads; Save As… opens the
      // named-save browser so a run can be archived or branched by title+date.
      showDialog(this, {
        title: 'Save Game',
        lines: ['Quick Save overwrites the one Continue slot. Save As… keeps any number of named, dated saves.'],
        buttons: [
          // saveGame() resolves a boolean; testing the promise itself is always true.
          { text: 'Quick Save', blue: true, onClick: () => saveGame().then((ok) => this.toast(ok ? 'Game saved.' : 'Save failed!')) },
          { text: 'Save As…', blue: true, onClick: () => this.openSaveBrowser('save') },
          { text: 'Cancel', onClick: () => {} },
        ],
      });
    }, { blue: true, fontSize: '13px' }));
    this.hud.add(button(this, sx + (bw * 3) / 4 + 4, H - 84, bw / 2 - 6, 34, 'Menu', () => {
      showDialog(this, {
        title: 'Game Menu',
        lines: ['Adjust settings, or leave (unsaved progress is lost).'],
        buttons: [
          { text: 'Stay' },
          { text: '⚙ Settings', onClick: () => {
            // Pause the live world while Settings is open (mirrors MenuScene):
            // otherwise E still ends the turn and clicks/edge-scroll leak to the
            // map beneath. Settings' own full-screen backdrop blocks pointer
            // leaks to this HUD; pausing 'Adventure' stops its keyboard + update.
            this.scene.launch('Settings', { onClose: () => this.scene.resume('Adventure') });
            this.scene.pause('Adventure');
          } },
          { text: 'To Menu', blue: true, onClick: () => this.adv.quitToMenu() },
        ],
      });
    }, { blue: true, fontSize: '13px' }));

    // dynHud lives outside `hud`, so replace it explicitly (a resize would
    // otherwise leak the old container with its still-clickable chips).
    this.dynHud?.destroy();
    this.dynHud = this.add.container(0, 0).setDepth(DEPTH.HUD + 1);
    this.refreshHUD();
  }

  // =========================================================================
  // Dynamic HUD content
  // =========================================================================

  /**
   * A compact "‹ 4–6/9 ›" pager drawn at the right of a HEROES/TOWNS section
   * label, so a strip with more than one page (3 chips) can be scrolled. Only
   * the in-range arrow is clickable; both live in dynHud (rebuilt each refresh).
   */
  /**
   * Past ten towns the three-across strip stops working: fifteen towns meant five pages
   * of clicking to reach the one you wanted. The strip shows a single summary chip
   * instead, and the chip opens a VERTICAL CAROUSEL of ten — "10 visible is the optimal".
   *
   * An overlay rather than an inline list, because the HUD column already carries the
   * hero strip, the selected-hero card, the minimap and the turn buttons; ten rows inline
   * would push the minimap off the panel.
   */
  drawTownCarousel(list, sx) {
    const mine = list.filter((t) => t.owner === 0).length;
    const sworn = list.length - mine;
    const y = this.townListY;
    const chip = button(this, sx + 84, y + 20, 168, 34,
      `${list.length} towns${sworn ? ` (+${sworn} sworn)` : ''}  ▾`,
      () => this.openTownCarousel(list), { fontSize: '13px', blue: true });
    this.dynHud.add(chip);
  }

  /**
   * The carousel itself: ten rows at a time over the map, newest paging at the edges.
   * A sworn realm's town is marked and sorted last — it is a market you may buy from,
   * not a seat of government (see pacts.canRecruitFrom).
   */
  openTownCarousel(list) {
    if (modalOpen()) return;
    const W = this.scale.width, H = this.scale.height;
    const PER = CONFIG.TOWN_CAROUSEL_VISIBLE;
    const ROW = 34, w = 340;
    const h = 78 + PER * ROW;
    const x = (W - w) / 2, y = Math.max(20, (H - h) / 2);
    const root = this.add.container(0, 0);
    let page = 0;
    const pages = Math.max(1, Math.ceil(list.length / PER));

    const draw = () => {
      root.removeAll(true);
      root.add(panel(this, x, y, w, h));
      root.add(label(this, x + w / 2, y + 20, 'YOUR TOWNS', {
        size: '15px', bold: true, color: COLORS.gold, ox: 0.5,
      }));
      const start = page * PER;
      list.slice(start, start + PER).forEach((t, i) => {
        const ry = y + 46 + i * ROW;
        const foreign = t.owner !== 0;
        const row = this.add.rectangle(x + w / 2, ry + 14, w - 24, ROW - 4, 0x241b33, 0.9)
          .setStrokeStyle(1, foreign ? 0x8a7a40 : 0x4a4560)
          .setInteractive({ useHandCursor: true });
        row.on('pointerup', () => {
          resetModals();
          this.adv.setViewLevel(t.z ?? 0);
          this.adv.cameras.main.pan(t.x * T, t.y * T, 250, 'Sine.easeInOut');
          this.adv.openTown(t.id);
        });
        root.add(row);
        root.add(label(this, x + 20, ry + 14, `${start + i + 1}.`, {
          size: '11px', color: COLORS.dim, oy: 0.5,
        }));
        root.add(label(this, x + 46, ry + 14, t.name, {
          size: '13px', color: foreign ? '#d8c88a' : COLORS.parchment, oy: 0.5,
        }));
        const marks = [];
        if ((t.z ?? 0) === 1) marks.push('▾');
        if (t.beachhead) marks.push('⚑');
        if (foreign) marks.push('sworn');
        if (marks.length) {
          root.add(label(this, x + w - 20, ry + 14, marks.join(' '), {
            size: '11px', color: COLORS.gold, ox: 1, oy: 0.5,
          }));
        }
      });
      const by = y + h - 24;
      if (pages > 1) {
        root.add(button(this, x + 54, by, 76, 30, '‹', () => { page = (page - 1 + pages) % pages; draw(); }, { fontSize: '15px' }));
        root.add(label(this, x + w / 2, by, `${page + 1} / ${pages}`, {
          size: '12px', color: COLORS.dim, ox: 0.5, oy: 0.5,
        }));
        root.add(button(this, x + w - 130, by, 76, 30, '›', () => { page = (page + 1) % pages; draw(); }, { fontSize: '15px' }));
      }
      root.add(button(this, x + w - 46, by, 68, 30, 'Close', () => resetModals(), { fontSize: '12px' }));
      pinToScreen(root);
    };
    draw();
    trackModal(root);
  }

  drawStripPager(labelY, page, pages, start, total, onPrev, onNext) {
    const W = this.scale.width;
    const end = Math.min(total, start + 3);
    this.dynHud.add([
      label(this, W - 62, labelY + 6, `${start + 1}–${end}/${total}`,
        { size: '10px', color: COLORS.dim, ox: 0.5, oy: 0.5 }),
      this.pagerArrow(W - 100, labelY + 6, '‹', page > 0 ? onPrev : null),
      this.pagerArrow(W - 22, labelY + 6, '›', page < pages - 1 ? onNext : null),
    ]);
  }

  /** One pager arrow — gold + clickable when `onClick` is given, else dimmed. */
  pagerArrow(x, y, ch, onClick) {
    const t = this.add.text(x, y, ch, {
      fontFamily: FONT, fontSize: '18px', fontStyle: 'bold', color: onClick ? '#e8c060' : '#555',
    }).setOrigin(0.5, 0.5);
    if (onClick) {
      t.setInteractive({ useHandCursor: true }).on('pointerup', () => { playSfx('click'); onClick(); });
    }
    return t;
  }

  /** Update the zoom readout to the live camera zoom (called on every change). */
  refreshZoomLabel() {
    if (!this.zoomLabel?.active) return;
    const z = this.adv?.cameras?.main?.zoom ?? 1;
    this.zoomLabel.setText(`Zoom ${Math.round(z * 100)}%`);
  }

  refreshHUD() {
    if (!this.hud || !this.dynHud) return;
    const s = this.state;
    const W = this.scale.width;
    const hw = this.hudWidth();
    const sx = W - hw + 14;

    const p0 = s.players[0];
    this.hud.each((child) => {
      if (child.name?.startsWith('res_')) {
        child.setText(`${p0.resources[child.name.slice(4)] ?? 0}`);
      }
    });
    this.dateLabel?.setText(`${seasonName(s.day)} · Week ${weekOf(s.day)}, Day ${dayOfWeek(s.day)}`);
    this.refreshWaveLabel();

    this.dynHud.removeAll(true);
    this.drawMinimap(); // fog/heroes/towns may have changed

    // hero chips (paged: 3 per page, with a ‹ › pager when you have more)
    {
      const heroes = playerHeroes(s, 0);
      const per = 3, pages = Math.max(1, Math.ceil(heroes.length / per));
      this.heroPage = Phaser.Math.Clamp(this.heroPage || 0, 0, pages - 1);
      const start = this.heroPage * per;
      heroes.slice(start, start + per).forEach((h, i) => {
        const x = sx + i * 66, y = this.heroListY;
        const img = heroPortrait(this, h, x + 26, y + 26, 52);
        const ring = this.add.rectangle(x + 26, y + 26, 56, 56)
          .setStrokeStyle(2.5, h.id === this.adv.selectedHeroId ? 0xe8c060 : 0x4a4560);
        const mpFrac = heroMaxMovement(h) ? Phaser.Math.Clamp(h.mp / heroMaxMovement(h), 0, 1) : 0;
        const mpBar = this.add.rectangle(x + 2, y + 54, 48 * mpFrac + 1, 4, 0x7ec860).setOrigin(0);
        img.setInteractive({ useHandCursor: true }).on('pointerup', () => {
          this.adv.selectHero(h.id); // jumps to the hero's level if it differs
          this.adv.cameras.main.pan(h.x * T, h.y * T, 250, 'Sine.easeInOut');
        });
        this.dynHud.add([img, ring, mpBar]);
        // A hero a level away (e.g. gone underground) is invisible on this map —
        // mark the chip so it's clear the hero is still there, one click away.
        if ((h.z ?? 0) !== (this.adv.viewLevel ?? 0)) {
          this.dynHud.add(label(this, x + 44, y + 2, (h.z ?? 0) === 1 ? '▾' : '▲',
            { size: '14px', bold: true, color: COLORS.gold }));
        }
      });
      if (heroes.length > per) {
        this.drawStripPager(this.heroListY - 20, this.heroPage, pages, start, heroes.length,
          () => { this.heroPage -= 1; this.refreshHUD(); },
          () => { this.heroPage += 1; this.refreshHUD(); });
      }
    }

    // Town chips. Three across the strip normally; past ten towns the strip cannot
    // carry them at any sane page size, so it becomes a VERTICAL CAROUSEL of ten —
    // "just need the towns to be shown as a vertical carousel when over 10, as 10
    // visible is the optimal". Reported at fifteen towns, where three-at-a-time meant
    // five pages of clicking to reach the one you wanted.
    {
      const towns = playerTowns(s, 0);
      // A sworn realm's towns are yours to buy from, so they belong on the strip too —
      // with a mark, because they are a market and not a seat of government.
      const allied = Object.values(s.towns)
        .filter((t) => t.owner !== 0 && canRecruitFrom(s, 0, t))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const list = [...towns, ...allied];
      // The carousel REPLACES the strip — it must not replace the rest of the
      // panel. This used to `return` out of refreshHUD entirely, so the moment
      // an eleventh town appeared the selected-hero card below (stats, army,
      // Cast Spell, Dig, teleporter) silently stopped being drawn: "the new
      // button hides the selected hero stats, army, the cast spell button".
      // Draw the chip, then fall through to the hero card like any other day.
      if (list.length > CONFIG.TOWN_CAROUSEL_FROM) {
        this.drawTownCarousel(list, sx);
      } else {
        const per = 3, pages = Math.max(1, Math.ceil(list.length / per));
        this.townPage = Phaser.Math.Clamp(this.townPage || 0, 0, pages - 1);
        const start = this.townPage * per;
        list.slice(start, start + per).forEach((t, i) => {
          const x = sx + i * 66, y = this.townListY;
          const img = townIcon(this, FACTIONS[t.faction].townGlyph, x + 26, y + 22, 52);
          const ring = this.add.rectangle(x + 26, y + 22, 56, 50).setStrokeStyle(2, 0x4a4560);
          img.setInteractive({ useHandCursor: true }).on('pointerup', () => {
            this.adv.setViewLevel(t.z ?? 0); // a cave town flips the view underground
            this.adv.cameras.main.pan(t.x * T, t.y * T, 250, 'Sine.easeInOut');
            this.adv.openTown(t.id);
          });
          this.dynHud.add([img, ring]);
          // Mark an underground town so the player knows the chip is a level away.
          if ((t.z ?? 0) === 1) {
            this.dynHud.add(label(this, x + 44, y + 2, '▾', { size: '14px', bold: true, color: COLORS.gold }));
          }
        });
        if (list.length > per) {
          this.drawStripPager(this.townListY - 20, this.townPage, pages, start, list.length,
            () => { this.townPage -= 1; this.refreshHUD(); },
            () => { this.townPage += 1; this.refreshHUD(); });
        }
      }
    }

    // selected hero card
    const hero = s.heroes[this.adv.selectedHeroId];
    if (hero) {
      let y = this.heroCardY;
      const teleporter = this.adv.teleporterUnderHero(hero);
      const hasAdvSpells = (hero.spells || []).some((id) => SPELLS[id] && SPELLS[id].adventure);
      const nExtra = (teleporter ? 1 : 0) + (hasAdvSpells ? 1 : 0);
      this.dynHud.add(inset(this, sx - 4, y, hw - 18, 206 + 34 * nExtra));
      const img = heroPortrait(this, hero, sx + 26, y + 32, 56);
      // The portrait IS the "open hero screen" control (no separate button —
      // that used to hang over the minimap). Hint it with the hand cursor.
      img.setInteractive({ useHandCursor: true }).on('pointerup', () => this.adv.openHeroScreen(hero.id));
      this.dynHud.add(img);
      this.dynHud.add(label(this, sx + 60, y + 8, hero.name, { size: '15px', bold: true, color: COLORS.gold }));
      this.dynHud.add(label(this, sx + 60, y + 27, `Level ${hero.level} ${hero.className}`, { size: '11px', color: COLORS.dim }));
      this.dynHud.add(label(this, sx + 60, y + 42,
        `A${heroStat(hero, 'attack')} D${heroStat(hero, 'defense')} P${heroStat(hero, 'power')} K${heroStat(hero, 'knowledge')}`,
        { size: '12px' }));
      y += 66;
      const mpMax = heroMaxMovement(hero);
      this.dynHud.add(label(this, sx, y, `Move ${Math.floor(hero.mp / 100)}/${Math.floor(mpMax / 100)}`, { size: '11px', color: COLORS.dim }));
      this.dynHud.add(this.add.rectangle(sx + 92, y + 7, 100, 7, 0x1c1a2a).setOrigin(0, 0.5).setStrokeStyle(1, 0x4a4560));
      this.dynHud.add(this.add.rectangle(sx + 92, y + 7, Phaser.Math.Clamp(hero.mp / Math.max(1, mpMax), 0, 1) * 100, 7, 0x7ec860).setOrigin(0, 0.5));
      y += 18;
      const manaMax = heroMaxMana(hero);
      this.dynHud.add(label(this, sx, y, `Mana ${hero.mana}/${manaMax}`, { size: '11px', color: COLORS.dim }));
      this.dynHud.add(this.add.rectangle(sx + 92, y + 7, 100, 7, 0x1c1a2a).setOrigin(0, 0.5).setStrokeStyle(1, 0x4a4560));
      this.dynHud.add(this.add.rectangle(sx + 92, y + 7, manaMax ? Phaser.Math.Clamp(hero.mana / manaMax, 0, 1) * 100 : 0, 7, 0x5a8ae0).setOrigin(0, 0.5));
      y += 22;
      hero.army.forEach((stack, i) => {
        const ax = sx + (i % 4) * 50 + 22;
        const ay = y + Math.floor(i / 4) * 52 + 20;
        this.dynHud.add(this.add.rectangle(ax, ay, 46, 46, 0x14121f).setStrokeStyle(1, 0x4a4560));
        if (stack && stack.count > 0) {
          this.dynHud.add(unitIcon(this, stack.creature, ax, ay - 4, 38));
          this.dynHud.add(this.add.text(ax + 20, ay + 21, `${stack.count}`, {
            fontFamily: FONT, fontSize: '11px', fontStyle: 'bold', color: '#ffe9b0',
            stroke: '#000', strokeThickness: 3,
          }).setOrigin(1));
        }
      });
      y += 108;
      // Standing on a teleporter → a clear "use it" button (Space also works),
      // so a hero who arrived on an exit boxed in by rock can step back through.
      if (teleporter) {
        const lbl = teleporter.type === 'subGate'
          ? ((hero.z ?? 0) === 1 ? '▲ Take the gate up  (Space)' : '▼ Take the gate down  (Space)')
          : teleporter.type === 'whirlpool' ? '≈ Ride the whirlpool  (Space)'
            : '⟳ Step through the portal  (Space)';
        this.dynHud.add(button(this, sx + (hw - 26) / 2, y, hw - 30, 30, lbl,
          () => this.adv.useTeleporterUnderSelectedHero(), { blue: true, fontSize: '12px' }));
        y += 34;
      }
      // Cast an adventure-map spell (Town Portal, Dimension Door, View Air…).
      if (hasAdvSpells) {
        this.dynHud.add(button(this, sx + (hw - 26) / 2, y, hw - 30, 30, '✦ Cast Spell  (C)',
          () => this.openAdventureSpellbook(), { blue: true, fontSize: '12px' }));
        y += 34;
      }
      // Grail: carrying it shows a banner; otherwise, once the puzzle is solved
      // and the Grail is still buried, a hero on the surface can Dig for it.
      const st = this.adv.state;
      if (hero.carryingGrail) {
        this.dynHud.add(label(this, sx + (hw - 26) / 2, y + 6, '✦ Carrying the Holy Grail — take it to a town',
          { size: '11px', ox: 0.5, color: COLORS.gold, wrap: hw - 34 }));
        y += 34;
      } else if (!st.grailDug && (hero.z ?? 0) === 0 && grailKnown(st, 0)) {
        // THE COORDINATES, WRITTEN DOWN. Reading the last obelisk announces the
        // Grail's tile once, in a toast and a log line — and the log is a
        // rolling 200-entry window, so on a large map the one place the answer
        // ever existed scrolls away while you are still walking there. The
        // pulsing marker is on the map, but a marker you have to FIND is no help
        // when what you have forgotten is where to look. So the tile is printed
        // here, above the spade, for as long as the Grail is buried: this panel
        // is already where a player goes to dig, and it cannot scroll away.
        const g = st.map.grail;
        if (g) {
          this.dynHud.add(label(this, sx + (hw - 26) / 2, y,
            `✦ The Grail lies buried at (${g.x}, ${g.y})`,
            { size: '11px', ox: 0.5, color: COLORS.gold, wrap: hw - 34 }));
          y += 16;
        }
        this.dynHud.add(button(this, sx + (hw - 26) / 2, y, hw - 30, 30, '⛏ Dig for the Grail  (G)',
          () => this.adv.digWithSelectedHero(), { blue: true, fontSize: '12px' }));
        y += 34;
      }
    }
  }

  /** Confirm enshrining a carried Grail at an owned town (raises its structure). */
  grailDeliverDialog(hero, town, onClose) {
    showDialog(this, {
      title: 'The Holy Grail',
      lines: [`Enshrine the Grail at ${town.name}?`,
        `It raises the town's Grail structure — ${grailPerkText(town.faction)}.`],
      buttons: [
        { text: 'Not yet', onClick: () => onClose?.() },
        { text: 'Enshrine it', blue: true, onClick: () => {
          const r = deliverGrail(this.adv.state, hero, town);
          if (r.ok) { playSfx('build'); this.toast(`The Grail structure rises at ${town.name}!`); }
          onClose?.();
        } },
      ],
    });
  }

  // =========================================================================
  // Toasts & banners
  // =========================================================================

  /**
   * Open the named-save browser over the map. The adventure scene is paused while
   * it is up (as Town/Combat do) so a stray click can't order a hero underneath,
   * and loading a save restarts Adventure onto the freshly-installed state.
   */
  openSaveBrowser(mode) {
    this.scene.launch('SaveLoad', {
      mode,
      onClose: () => { this.scene.resume('Adventure'); this.scene.wake('AdvUI'); },
      onLoaded: () => {
        this.scene.stop('SaveLoad');
        this.scene.stop('AdvUI');
        this.scene.start('Adventure');
      },
    });
    this.scene.sleep();
    this.scene.pause('Adventure');
  }

  toast(text) {
    this.toasts = (this.toasts || []).filter((x) => x.active);
    const t = this.add.text(14, 0, text, {
      fontFamily: FONT, fontSize: '14px', color: '#f4edda',
      backgroundColor: 'rgba(14,12,24,0.88)', padding: { x: 12, y: 7 },
    }).setDepth(300);
    this.toasts.unshift(t);
    this.toasts.slice(0, 4).forEach((x, i) => x.setY(this.scale.height - 44 - i * 34));
    this.toasts.slice(4).forEach((x) => x.destroy());
    this.tweens.add({
      targets: t, alpha: 0, delay: 3600, duration: 500,
      onComplete: () => t.destroy(),
    });
  }

  showAIBanner(show) {
    if (show && !this.aiBanner) {
      const W = this.scale.width, H = this.scale.height;
      const bg = this.add.rectangle(W / 2, H / 2, 340, 64, 0x100e1c, 0.92)
        .setStrokeStyle(2, 0xc23b2b, 0.9).setDepth(400);
      const txt = this.add.text(W / 2, H / 2, 'The enemy is scheming…', {
        fontFamily: FONT, fontSize: '18px', color: '#e8b0a0', fontStyle: 'italic',
      }).setOrigin(0.5).setDepth(401);
      this.aiBanner = [bg, txt];
    } else if (!show && this.aiBanner) {
      this.aiBanner.forEach((o) => o.destroy());
      this.aiBanner = null;
    }
  }

  // =========================================================================
  // Adventure dialogs (chest, artifact, level-up, game over…)
  // =========================================================================

  artifactDialog(name, desc, textureKey) {
    showDialog(this, { title: 'Artifact found!', picture: textureKey, lines: [name, desc] });
  }

  /** Spoils of War: after a hero battle, show the artifacts stripped from the
   *  fallen enemy (the transfer already happened in core; this just reveals it,
   *  since looted items often land unseen in the victor's backpack). */
  spoilsDialog(hero, ev) {
    const arts = (ev.artifacts || []).map((id) => ARTIFACTS[id]).filter(Boolean);
    if (!arts.length) return;
    playSfx('coin');
    const lines = [
      `${hero.name} claims the spoils from ${ev.fromName || 'the fallen champion'}:`,
      ...arts.map((a) => `• ${a.name}${a.desc ? ` — ${a.desc}` : ''}`),
      'Auto-equipped where a slot was free; the rest wait in the backpack.',
    ];
    showDialog(this, { title: '⚔ Spoils of War', lines, buttons: [{ text: 'Claim', primary: true }] });
    this.refreshHUD?.();
  }

  visitedDialog(name, text) {
    showDialog(this, { title: name, lines: [text] });
  }

  /** The rival warlords this scenario, as "Name the Title (Faction)" — live
   *  players when the game exists, else the authored enemy factions. */
  opponentsText(state, scn) {
    const foes = (state?.players || []).filter((p) => !p.isHuman);
    if (foes.length) {
      return foes.map((p) => {
        const title = p.warlord && CONFIG.WARLORDS?.[p.warlord]?.title;
        const fac = FACTIONS[p.faction]?.name || p.faction;
        return `${p.name}${title ? ` ${title}` : ''} (${fac})`;
      }).join(' · ');
    }
    const enemies = (scn?.enemies || []).map((e) => FACTIONS[e.faction]?.name || e.faction);
    return enemies.length ? enemies.join(' & ') : 'no rival stands';
  }

  /** Scenario-information popup (from the HUD pictogram): objective + how you
   *  win, how you lose, and who you face. Works in campaigns and skirmishes. */
  scenarioInfoDialog() {
    const state = getState();
    const scn = isCampaign(state) ? currentScenario(state) : null;
    const lines = [];
    if (scn) lines.push(scn.name);
    lines.push(`Victory — ${victoryObjectiveText(state)}`);
    lines.push(`Defeat — ${lossConditionText(state)}`);
    lines.push(`You face — ${this.opponentsText(state, scn)}`);
    // The age floor, when this game runs under one (core/ages.js): what the realm
    // must grow into before a win may settle, ticked off item by item. This panel
    // is the standing answer to "why did nothing happen when I won" — so it also
    // carries the way out, whenever a crown is actually waiting.
    const floor = ageFloorText(state);
    const buttons = [{ text: 'Close', primary: true }];
    if (floor) {
      const prog = ageProgress(state, state?.players?.find((p) => p.isHuman)?.team ?? 0);
      lines.push('', `The age — ${prog.floor.name}`);
      for (const n of prog.needs) {
        lines.push(`  ${n.done ? '✔' : '·'} ${n.label}${n.count ? `  ${Math.min(n.have, n.need)}/${n.need}` : ''}`);
      }
    }
    // The way out of a held win lives here whatever is holding it — an age floor,
    // or an objective the sea has still to decide (actions.objectiveOutlastsConquest).
    if (state.pendingWin) {
      lines.push('', `Your victory is won and waiting — ${heldWinReason(state, state.pendingWin.team ?? 0)}`);
      buttons.unshift({ text: '👑 Take the crown now', blue: true, onClick: () => this.adv.claimCrown() });
    }
    showDialog(this, { title: '📜 Scenario Information', lines, buttons });
  }

  /**
   * "You have won — the age has not finished with you."
   *
   * Raised once, the turn a win is first held by the age floor. It has to say three
   * things or it is a bug report waiting to happen: that the game was WON, why it is
   * still running, and how to end it now if that is what the player wants. The
   * envoys ride along when there are any, because a conquest held open is exactly
   * the moment to put rivals back on the board rather than hold an empty map.
   */
  heldCrownDialog() {
    const state = getState();
    const team = state.pendingWin?.team ?? 0;
    const prog = ageProgress(state, team);
    if (!state.pendingWin) return null;
    const pleas = pleaOffers(state, 0);
    const buttons = [{ text: 'Play on', blue: true, cancel: true }];
    if (pleas.length) {
      buttons.push({ text: `⚖ Hear their envoys (${pleas.length})`, onClick: () => this.pleaDialog(pleas) });
    }
    buttons.push({ text: '👑 Take the crown now', onClick: () => this.adv.claimCrown() });
    const lines = [state.pendingWin?.msg || 'The realm is yours.', ''];
    if (prog.floor) {
      // Held by the age floor: the checklist IS the explanation.
      lines.push(`But you set this game to run a full age — ${prog.floor.name.toLowerCase()} — and it is not `
        + 'grown yet. The crown is yours the day it is:');
      for (const n of prog.needs) {
        lines.push(`  ${n.done ? '✔' : '·'} ${n.label}${n.count ? `  ${Math.min(n.have, n.need)}/${n.need}` : ''}`);
      }
    } else {
      // Held by the charge itself: beating the neighbours was never the goal, and
      // the towns (or the invasions) still have to come from outside the map.
      lines.push('But the war between realms was never your charge, and the sea has not '
        + 'finished with this land:');
      lines.push(`  · ${victoryObjectiveText(state)}`);
      lines.push('Their camps are towns, and the peoples keep coming.');
    }
    lines.push('', 'Nothing is at risk in the waiting: the victory is recorded and settles on '
      + 'its own. Take it now instead, at any time, from this panel or the scenario scroll.');
    if (pleas.length) {
      lines.push('', `Envoys from the ${pleas.length} realm${pleas.length === 1 ? '' : 's'} you broke are at `
        + 'the gate, asking for their nations back — a town each, and their oath in return.');
    }
    return showDialog(this, { title: '👑 The crown waits', width: 640, lines, buttons });
  }

  /**
   * The AI brain log (see ai/aiLog.js) — a scrollable read of what each rival
   * realm decided on its last turns and, for everything it did NOT do, the named
   * gate that stopped it.
   *
   * Asked for directly: "implement a log of what the AI brain is doing and why it
   * stops flagging mines, so we can fix the issue". The header of each realm is
   * the one-line diagnosis (aiDiagnosis); the body is the raw trail beneath it.
   * A realm filter, because on a four-rival map the interleaved log is a wall.
   */
  aiBrainLogDialog(only = null, page = 0) {
    if (modalOpen() && !this.brainOverlay) return;
    this.brainOverlay?.destroy();
    const state = getState();
    const rivals = (state?.players || []).filter((p) => !p.isHuman && !p.invader);
    const W = this.scale.width, H = this.scale.height;
    const pw = Math.min(760, W - 40), ph = Math.min(H - 40, 560);
    const px = (W - pw) / 2, py = (H - ph) / 2;
    const root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
    this.brainOverlay = root;
    root.once('destroy', () => { if (this.brainOverlay === root) this.brainOverlay = null; });
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x05040a, 0.86).setInteractive());
    root.add(panel(this, px, py, pw, ph));
    root.add(label(this, W / 2, py + 20, '🧠 AI Brain Log', { size: '20px', bold: true, color: COLORS.gold, ox: 0.5 }));

    // Realm filter: All, then one chip per rival.
    const chips = [{ label: 'All', index: null }, ...rivals.map((p) => ({ label: p.name, index: p.index }))];
    const cw = Math.min(140, (pw - 60) / Math.max(1, chips.length) - 8);
    chips.forEach((c, i) => {
      const cx = px + 30 + cw / 2 + i * (cw + 8);
      root.add(button(this, cx, py + 52, cw, 26, c.label,
        () => this.aiBrainLogDialog(c.index, 0),
        { blue: c.index === only, fontSize: '11px' }));
    });

    // The verdict line(s) — the thing a player actually reads.
    let y = py + 80;
    for (const p of rivals.filter((r) => only == null || r.index === only)) {
      root.add(label(this, px + 26, y, `${p.name}: ${aiDiagnosis(state, p.index)}`,
        { size: '12px', color: COLORS.gold, wrap: pw - 52 }));
      y += 20;
    }
    y += 6;

    // …then the raw trail, paged. Fixed line height, so the page size is simply
    // how many lines fit between here and the buttons.
    const LH = 15;
    const rows = Math.max(4, Math.floor((py + ph - 64 - y) / LH));
    const all = aiLogLines(state, { player: only, limit: 400 });
    const pages = Math.max(1, Math.ceil(all.length / rows));
    const pg = Phaser.Math.Clamp(page, 0, pages - 1);
    if (!all.length) {
      root.add(label(this, W / 2, y + 20, 'Nothing recorded yet — end a turn and let the rivals move.',
        { size: '12px', color: COLORS.dim, ox: 0.5 }));
    }
    all.slice(pg * rows, pg * rows + rows).forEach((line, i) => {
      const head = line.startsWith('──');
      root.add(label(this, px + 26, y + i * LH, line, {
        size: head ? '11.5px' : '11px',
        bold: head,
        color: head ? COLORS.parchment : (line.includes('NONE viable') ? COLORS.danger : COLORS.dim),
      }));
    });

    const by = py + ph - 28;
    if (pages > 1) {
      root.add(button(this, px + 70, by, 100, 30, '◀ Newer',
        () => this.aiBrainLogDialog(only, pg - 1), { fontSize: '12px' }));
      // Between the two arrows, not at a viewport fraction — the panel is
      // centred but its width is clamped, so W/2 drifts away from px + width/2.
      root.add(label(this, px + 130, by, `${pg + 1}/${pages}`, { size: '12px', color: COLORS.dim, ox: 0.5, oy: 0.5 }));
      root.add(button(this, px + 190, by, 100, 30, 'Older ▶',
        () => this.aiBrainLogDialog(only, pg + 1), { fontSize: '12px' }));
    }
    // The whole point of recording: getting the file OUT. JSONL, one object per
    // line — greppable, streamable, and it survives being truncated.
    root.add(button(this, px + pw - 250, by, 150, 30, '⭳ Export JSONL',
      () => this.exportTelemetry(), { fontSize: '12px' }));
    root.add(button(this, px + pw - 80, by, 130, 30, 'Close', () => root.destroy(), { blue: true, fontSize: '12px' }));
    pinToScreen(root);
    return root;
  }

  /**
   * The chapter's opening briefing: a storyteller's narrative, the foes, and the
   * charge — shown once at chapter start (AdventureScene.uiReady, day 1). Auto-
   * begins after a short countdown, or the player presses Begin. A tracked modal,
   * so the world stays gated while it's up.
   */
  showChapterIntro(scn) {
    if (!scn) return;
    const state = getState();
    const W = this.scale.width, H = this.scale.height;
    const root = this.add.container(0, 0).setDepth(DEPTH.MODAL);
    trackModal(root);
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x05040a, 0.74).setInteractive());
    const w = Math.min(720, W - 60);
    const px = (W - w) / 2;
    const narrative = scn.briefing || scn.intro || '';
    // Measure the wrapped narrative to size the panel to its content.
    const narr = label(this, W / 2, 0, narrative, { size: '15px', color: COLORS.parchment, ox: 0.5, align: 'center', wrap: w - 80 });
    const foes = label(this, W / 2, 0, `You face  —  ${this.opponentsText(state, scn)}`, { size: '14px', color: COLORS.danger, ox: 0.5, align: 'center', wrap: w - 80 });
    const goal = label(this, W / 2, 0, `Your charge  —  ${victoryObjectiveText(state)}`, { size: '14px', bold: true, color: COLORS.gold, ox: 0.5, align: 'center', wrap: w - 80 });
    // A map FINGERPRINT, so playtest feedback is traceable to an exact map. The
    // seed was previously only visible on the Custom Scenario setup screen, which
    // means a report like "chapter 3 felt empty" could never be reproduced.
    const camp = state.campaign;
    const chapterOf = camp
      ? `  ·  chapter ${(camp.scenarioIndex ?? 0) + 1}${camp.sagaOpts?.length ? `/${camp.sagaOpts.length}` : ''}`
      : '';
    const fp = label(this, W / 2, 0,
      `map ${state.map.w}x${state.map.h}  ·  seed ${state.seed}${chapterOf}`,
      { size: '11px', color: COLORS.dim, ox: 0.5 });
    const h = Math.min(H - 50, 150 + narr.height + foes.height + goal.height + fp.height + 106);
    const py = (H - h) / 2;
    root.add(panel(this, px, py, w, h));
    let y = py + 24;
    root.add(label(this, W / 2, y, scn.name, { size: '22px', bold: true, color: COLORS.gold, ox: 0.5, align: 'center', wrap: w - 60 }));
    y += 46;
    narr.setY(y); root.add(narr); y += narr.height + 16;
    root.add(this.add.rectangle(W / 2, y, w - 100, 1, 0x6b5a8a, 0.5)); y += 14;
    foes.setY(y); root.add(foes); y += foes.height + 10;
    goal.setY(y); root.add(goal); y += goal.height + 12;
    fp.setY(y); root.add(fp);
    // Countdown + Begin. `close` clears the timer and the modal; the timer ticks
    // the label and auto-begins at zero.
    const btnY = py + h - 32;
    const countdown = label(this, W / 2, btnY - 34, '', { size: '12px', color: COLORS.dim, ox: 0.5 });
    root.add(countdown);
    let remaining = 14;
    const close = () => { if (this._introTimer) { this._introTimer.remove(); this._introTimer = null; } if (root.active) root.destroy(); };
    this._introTimer = this.time.addEvent({ delay: 1000, loop: true, callback: () => {
      remaining -= 1;
      if (remaining <= 0) { close(); return; }
      countdown.setText(`The chapter begins in ${remaining}s…`);
    } });
    countdown.setText(`The chapter begins in ${remaining}s…`);
    root.add(button(this, W / 2, btnY, 220, 40, '⚔ Begin Chapter', () => close(), { fontSize: '15px' }));
    root.once('destroy', () => { if (this._introTimer) { this._introTimer.remove(); this._introTimer = null; } });
  }

  /** The adventure spellbook: pick an out-of-combat spell for the selected hero. */
  openAdventureSpellbook() {
    const hero = getState().heroes[this.adv.selectedHeroId];
    if (!hero || hero.owner !== 0) return;
    const known = (hero.spells || []).filter((id) => SPELLS[id] && SPELLS[id].adventure);
    if (!known.length) { this.toast('This hero knows no adventure spells.'); return; }
    openSpellbook(this, {
      title: `${hero.name} — Spellbook`,
      subtitle: `Mana ${hero.mana}/${heroMaxMana(hero)}`,
      groups: [{ label: 'Adventure', spells: known }],
      actionLabel: 'Cast',
      costOf: (id) => spellCost(hero, id),
      noteOf: (id) => masteryNote(hero, id),
      canAct: (id) => hero.mana >= spellCost(hero, id),
      actNote: (id) => `Need ${spellCost(hero, id)} mana`,
      onAct: (id) => this.adv.castOrTarget(hero.id, id),
    });
  }

  /** Offer to build a boat at a shipyard; onBuild() fires on confirm. */
  shipyardDialog(cost, onBuild) {
    const price = Object.entries(cost).map(([r, n]) => `${n} ${r}`).join(' + ');
    showDialog(this, {
      title: 'Shipyard',
      lines: [`Build a boat for ${price}?`, 'It launches at the dock beside you.'],
      buttons: [
        { text: 'Not now' },
        { text: '⚓ Build boat', blue: true, onClick: () => onBuild() },
      ],
    });
  }

  /**
   * External-dwelling recruit stepper — the town recruit dialog's twin, but it
   * buys from the dwelling object into the visiting hero. `onDone` refreshes the
   * map (updated stock + hero army). Clamped to the accrued stock AND affordable
   * amount, exactly like recruitFromDwelling, so the confirm can never overspend.
   */
  dwellingDialog(state, obj, hero, onDone = () => {}) {
    const cr = dwellingCreature(obj);
    const c = CREATURES[cr];
    const player = state.players[hero.owner];
    let maxN = obj.available || 0;
    for (const r of RESOURCES) if (c.cost[r]) maxN = Math.min(maxN, Math.floor((player.resources[r] || 0) / c.cost[r]));
    if (maxN <= 0) {
      showDialog(this, {
        title: dwellingName(obj),
        lines: [(obj.available || 0) <= 0 ? 'The dwelling is still mustering — return next week.' : 'You cannot afford any recruits.'],
      });
      return;
    }
    let n = maxN;
    const W = this.scale.width, H = this.scale.height;
    // Tracked: this dialog sits over a LIVE Adventure scene (unlike the town
    // screens, the map is not paused behind it), whose scene-level pointerup fires
    // straight through the blocker. Untracked, every press in here also clicked
    // the map and could send the hero walking.
    const root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55).setInteractive());
    const w = 400, h = 270, px = (W - w) / 2, py = (H - h) / 2;
    root.add(panel(this, px, py, w, h));
    root.add(label(this, W / 2, py + 18, `Recruit ${c.name}s`, { size: '18px', bold: true, color: COLORS.gold, ox: 0.5 }));
    root.add(unitIcon(this, cr, W / 2, py + 66, 52));
    const costLbl = label(this, W / 2, py + 104, '', { size: '14px', bold: true, ox: 0.5, color: COLORS.gold });
    root.add(costLbl);
    // Slider + stepper + type-to-enter: pick any amount in one gesture; the total
    // cost readout tracks the picker live via onChange.
    const picker = numberPicker(this, W / 2, py + 158, {
      value: n, min: 1, max: maxN, bigStep: 10, width: 300,
      onChange: (v) => { n = v; costLbl.setText(costText(recruitCost(cr, v))); },
    });
    root.add(picker.objects);
    costLbl.setText(costText(recruitCost(cr, n)));
    root.add(button(this, W / 2 - 70, py + h - 34, 120, 36, 'Leave', () => root.destroy()));
    root.add(button(this, W / 2 + 70, py + h - 34, 120, 36, 'Recruit', () => {
      recruitFromDwelling(state, hero, obj, n);
      root.destroy();
      onDone();
    }, { blue: true, icon: '⚔' }));
  }

  chestDialog(hero, ev, onResolved) {
    showDialog(this, {
      title: 'Treasure Chest',
      picture: 'chest',
      lines: ['Distribute the spoils:'],
      buttons: [
        {
          text: `${ev.gold} Gold`,
          onClick: () => {
            resolveChest(this.state, hero, ev.objectId, 'gold');
            onResolved(false);
          },
        },
        {
          text: `${ev.xp} XP`,
          blue: true,
          onClick: () => {
            resolveChest(this.state, hero, ev.objectId, 'xp');
            onResolved(true);
          },
        },
      ],
    });
  }

  /**
   * A Seer Hut: show the fetch quest and, when the tribute is in hand, a
   * Fulfill button. `onFulfilled(levels)` fires after a successful hand-in
   * (levels = any level-ups from an XP reward).
   */
  seerHutDialog(hero, ev, onFulfilled) {
    if (ev.done) {
      showDialog(this, { title: 'Seer Hut', picture: 'boost_seerHut', lines: ['The seer gazes into the crystal, then shakes her head — there is nothing more she needs.'] });
      return;
    }
    const buttons = [{ text: 'Not now' }];
    if (ev.canFulfill) {
      buttons.push({
        text: '✦ Pay the tribute',
        blue: true,
        onClick: () => {
          const r = fulfillSeerQuest(this.state, hero, ev.objectId);
          if (r.ok) {
            playSfx('coin');
            // The sealed promise is revealed only now that it's been paid.
            showDialog(this, {
              title: 'The Seer\'s Gift',
              picture: 'boost_seerHut',
              lines: [
                `You lay ${ev.questText} before the seer.`,
                `Her promise is kept — you receive ${seerRewardText(r.reward)}!`,
              ],
              buttons: [{ text: 'Wonderful', primary: true }],
            });
            onFulfilled(r.levels || 0);
          } else {
            this.toast('The quest could not be completed.');
          }
        },
      });
    }
    showDialog(this, {
      title: 'Seer Hut',
      picture: 'boost_seerHut',
      lines: [
        `The seer seeks ${ev.questText}.`,
        `In return she promises ${ev.rewardText} — but she will not say what until it is paid.`,
        ev.canFulfill ? 'You carry what she asks.' : 'Return when you can provide it.',
      ],
      buttons,
    });
  }

  /**
   * The Trading Post: two columns — SELL your artifacts for experience (left),
   * BUY the stall's stock for resources (right). Reusable, so it rebuilds its
   * content live after each trade. `onDone(levels)` chains any level-ups.
   */
  /**
   * Trading Post — an "altar" staging flow. Browse the hero's artifacts (backpack
   * front-and-centre, worn ones dimmed with a W badge), inspect each one's
   * picture / description / offered XP in the middle, move pieces onto the Altar
   * and back, then SACRIFICE the whole altar for experience with one button. A
   * Buy tab keeps the old resources→stock purchase. Staging is UI-only — nothing
   * leaves the hero until you finalise (sellArtifactsForXp).
   */
  tradingPostDialog(hero, ev, onDone = () => {}) {
    const state = getState();
    const W = this.scale.width, H = this.scale.height;
    const w = 860, h = 560, px = (W - w) / 2, py = (H - h) / 2;
    const root = this.add.container(0, 0).setDepth(DEPTH.MODAL);
    trackModal(root);
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.55).setInteractive());
    root.add(panel(this, px, py, w, h));
    root.add(label(this, W / 2, py + 14, '⚖ Trading Post', { size: '20px', bold: true, color: COLORS.gold, ox: 0.5 }));
    root.add(label(this, W / 2, py + 40, 'Lay artifacts on the altar to sacrifice them for experience.', { size: '12px', color: COLORS.dim, ox: 0.5 }));

    let levels = 0, mode = 'sell', uid = 0;
    const mkInst = (id, worn) => ({ key: `k${uid++}`, id, worn });
    const buildAvailable = () => {
      const list = [];
      for (const id of Object.values(hero.equipment || {})) if (id) list.push(mkInst(id, true));
      for (const id of (hero.backpack || [])) list.push(mkInst(id, false));
      return list;
    };
    let available = buildAvailable();
    let altar = [];

    const colY = py + 96;
    const colAx = px + 24;                 // left column (your artifacts)
    const previewCx = px + w / 2;          // centre column (inspect)
    const colCx = px + w - 24 - 3 * 64 + 6; // right column (the altar)

    // ---- centre: inspect the hovered/selected artifact -------------------
    const previewBox = this.add.container(0, 0); root.add(previewBox);
    const inspect = (id, worn, priceLine) => {
      previewBox.removeAll(true);
      if (!id) {
        previewBox.add(label(this, previewCx, colY + 100, 'Hover an artifact\nto inspect it.', { size: '13px', color: COLORS.dim, ox: 0.5, align: 'center' }));
        return;
      }
      const a = ARTIFACTS[id] || { name: id, desc: '' };
      previewBox.add(artifactIcon(this, id, previewCx, colY + 54, 88));
      previewBox.add(label(this, previewCx, colY + 100, a.name, { size: '15px', bold: true, color: COLORS.gold, ox: 0.5, align: 'center', wrap: 250 }));
      previewBox.add(label(this, previewCx, colY + 128, a.desc || '', { size: '12px', color: COLORS.parchment, ox: 0.5, align: 'center', wrap: 250 }));
      if (worn != null) previewBox.add(label(this, previewCx, colY + 170, worn ? '● Currently worn' : '○ In backpack', { size: '11px', color: worn ? COLORS.danger : COLORS.dim, ox: 0.5, align: 'center' }));
      previewBox.add(label(this, previewCx, colY + 196, priceLine, { size: '14px', bold: true, color: COLORS.good, ox: 0.5, align: 'center' }));
    };
    inspect(null);

    // ---- one artifact cell (icon + inset + worn badge) ------------------
    const cell = (parent, id, worn, gx, gy, onClick) => {
      parent.add(inset(this, gx, gy, 58, 58));
      const img = artifactIcon(this, id, gx + 29, gy + 29, 44);
      if (worn) img.setAlpha(0.5);
      img.setInteractive({ useHandCursor: true })
        .on('pointerover', () => inspect(id, worn, `Sacrifice value: ${tradingPostSellXp(id).toLocaleString()} XP`))
        .on('pointerup', () => { playSfx('click'); onClick(); });
      parent.add(img);
      if (worn) {
        parent.add(this.add.circle(gx + 49, gy + 9, 8, 0x5a1a1a).setStrokeStyle(1.5, 0xe8a04a));
        parent.add(this.add.text(gx + 49, gy + 8, 'W', { fontFamily: FONT, fontSize: '10px', fontStyle: 'bold', color: '#ffcf8a' }).setOrigin(0.5));
      }
    };
    const gridPos = (base, i) => ({ gx: base + (i % 3) * 64, gy: colY + 24 + Math.floor(i / 3) * 64 });

    let content = null;
    const render = () => {
      if (content) content.destroy();
      content = this.add.container(0, 0); root.add(content);
      if (mode === 'sell') {
        // left — your artifacts (click to move to the altar)
        content.add(label(this, colAx, colY, 'YOUR ARTIFACTS', { size: '12px', bold: true, color: COLORS.parchment }));
        if (!available.length) content.add(label(this, colAx, colY + 26, 'Nothing to sell.', { size: '12px', color: COLORS.dim }));
        available.slice(0, 12).forEach((inst, i) => {
          const { gx, gy } = gridPos(colAx, i);
          cell(content, inst.id, inst.worn, gx, gy, () => {
            const idx = available.indexOf(inst);
            if (idx >= 0) { available.splice(idx, 1); altar.push(inst); render(); inspect(inst.id, inst.worn, `Sacrifice value: ${tradingPostSellXp(inst.id).toLocaleString()} XP`); }
          });
        });
        // right — the altar (click to send back)
        content.add(this.add.rectangle(colCx - 8, colY + 18, 3 * 64 + 6, 4 * 64 + 4, 0x2a1030, 0.35).setOrigin(0, 0).setStrokeStyle(1.5, 0x7a4aa0, 0.6));
        content.add(label(this, colCx, colY, '⚱ THE ALTAR', { size: '12px', bold: true, color: COLORS.gold }));
        if (!altar.length) content.add(label(this, colCx, colY + 30, 'Click your artifacts\nto place them here.', { size: '11px', color: COLORS.dim, wrap: 180 }));
        altar.slice(0, 12).forEach((inst, i) => {
          const { gx, gy } = gridPos(colCx, i);
          cell(content, inst.id, inst.worn, gx, gy, () => {
            const idx = altar.indexOf(inst);
            if (idx >= 0) { altar.splice(idx, 1); available.push(inst); render(); inspect(inst.id, inst.worn, `Sacrifice value: ${tradingPostSellXp(inst.id).toLocaleString()} XP`); }
          });
        });
        // total + the one finalise button
        const totalXp = altar.reduce((s, inst) => s + tradingPostSellXp(inst.id), 0);
        content.add(label(this, W / 2, py + h - 118, altar.length ? `Altar holds ${altar.length} artifact${altar.length > 1 ? 's' : ''} — total ${totalXp.toLocaleString()} XP` : 'The altar is empty.', {
          size: '13px', bold: true, color: altar.length ? COLORS.good : COLORS.dim, ox: 0.5, align: 'center',
        }));
        const sac = button(this, W / 2, py + h - 84, 320, 44, altar.length ? `⚱ Sacrifice for ${totalXp.toLocaleString()} XP` : '⚱ Sacrifice', () => {
          if (!altar.length) return;
          const r = sellArtifactsForXp(state, hero, altar.map((inst) => inst.id));
          if (r.ok) {
            playSfx('coin');
            levels += r.levels || 0;
            this.toast(`Sacrificed ${r.count} artifact${r.count > 1 ? 's' : ''} for ${r.xp.toLocaleString()} XP.`);
            this.refreshHUD?.();
            altar = []; available = buildAvailable(); inspect(null); render();
          }
        }, { blue: true, fontSize: '14px' });
        sac.setEnabled?.(altar.length > 0);
        content.add(sac);
      } else {
        // buy tab — the stall's stock, click an affordable piece to buy it
        const view = tradingPostView(state, hero, ev.objectId);
        const player = state.players[hero.owner];
        content.add(label(this, colAx, colY, 'FOR SALE — click to buy', { size: '12px', bold: true, color: COLORS.parchment }));
        if (!view.stock.length) content.add(label(this, colAx, colY + 26, 'The stall is bare.', { size: '12px', color: COLORS.dim }));
        view.stock.slice(0, 12).forEach((a, i) => {
          const { gx, gy } = gridPos(colAx, i);
          const affordable = (player.resources.gold || 0) >= a.cost.gold && (player.resources.gems || 0) >= (a.cost.gems || 0);
          content.add(inset(this, gx, gy, 58, 58));
          const img = artifactIcon(this, a.id, gx + 29, gy + 29, 44);
          if (!affordable) img.setAlpha(0.45);
          img.setInteractive({ useHandCursor: true })
            .on('pointerover', () => inspect(a.id, null, `Cost: ${costText(a.cost)}`))
            .on('pointerup', () => {
              const r = buyArtifactAt(state, hero, ev.objectId, a.id);
              if (r.ok) { playSfx('coin'); this.refreshHUD?.(); inspect(null); render(); }
              else this.toast(r.reason === 'sold out' ? 'Already sold.' : 'Not enough resources.');
            });
          content.add(img);
        });
        content.add(label(this, W / 2, py + h - 100, 'Buying spends gold & gems from your treasury.', { size: '12px', color: COLORS.dim, ox: 0.5, align: 'center' }));
      }
    };

    // ---- Sacrifice / Buy tabs -------------------------------------------
    let tabs = null;
    const renderTabs = () => {
      if (tabs) tabs.destroy();
      tabs = this.add.container(0, 0); root.add(tabs);
      tabs.add(button(this, W / 2 - 68, py + 66, 128, 28, '⚱ Sacrifice', () => { if (mode !== 'sell') { mode = 'sell'; inspect(null); render(); renderTabs(); } }, { fontSize: '12px', blue: mode === 'sell' }));
      tabs.add(button(this, W / 2 + 68, py + 66, 128, 28, '🛒 Buy', () => { if (mode !== 'buy') { mode = 'buy'; inspect(null); render(); renderTabs(); } }, { fontSize: '12px', blue: mode === 'buy' }));
    };
    renderTabs();
    render();
    root.add(button(this, W / 2, py + h - 34, 150, 32, 'Leave', () => { root.destroy(); onDone(levels); }));
  }

  /**
   * Recursively present pending level-up skill choices for a hero.
   * `onComplete` fires once every pending choice is resolved — callers that
   * must not proceed while a modal is up (the AI turn pump) chain on it.
   */
  /**
   * The level-up screen. Shows EVERY level the hero reaches with its statistics —
   * which primary rose, the full primary line, derived mana/movement, experience
   * and progress to the next level, and the current secondary skills — then either
   * the skill choice for that level or a plain Continue.
   *
   * A skill-capped hero used to consume its level SILENTLY (no screen, no sound),
   * so past the eight-skill cap you had no idea you were still growing. At a level
   * cap of 74 that is most of a hero's career, so a level now always reports itself.
   */
  maybeShowLevelUps(hero, onComplete) {
    if (!hero || !this.state.heroes[hero.id]) { onComplete?.(); return; }
    const ups = hero.pendingLevelUps;
    if (!ups?.length) {
      // No queued screens. Older saves (and any AI-granted level) may still carry
      // raw skill choices — consume them so nothing is left dangling.
      while (hero.pendingSkillChoices?.length) chooseSkill(this.state, hero, 0);
      this.refreshHUD();
      onComplete?.();
      return;
    }
    const up = ups[0];
    const choice = up.choice ? hero.pendingSkillChoices?.[0] : null;
    const advance = () => { hero.pendingLevelUps.shift(); this.maybeShowLevelUps(hero, onComplete); };

    playSfx('levelup');
    const buttons = (choice?.options?.length)
      ? choice.options.map((opt, i) => ({
        text: `${SKILL_LEVEL_NAMES[opt.toLevel]} ${SKILLS[opt.skill]?.name || opt.skill}`,
        blue: i === 1,
        onClick: () => { chooseSkill(this.state, hero, i); advance(); },
      }))
      : [{ text: 'Continue', blue: true, onClick: advance }];

    showDialog(this, {
      title: `${hero.name} — Level ${up.level}!`,
      picture: heroTextureKey(this, hero),
      lines: this.levelUpLines(hero, up, !!choice?.options?.length),
      buttons,
      width: 520,
    });
  }

  /** The statistics block on the level-up screen. */
  levelUpLines(hero, up, hasChoice) {
    const STAT_NAME = { attack: 'Attack', defense: 'Defense', power: 'Spell Power', knowledge: 'Knowledge' };
    const lines = [];
    if (up.stat) lines.push(`${STAT_NAME[up.stat] || up.stat} +1`);
    lines.push(`Attack ${heroStat(hero, 'attack')}   ·   Defense ${heroStat(hero, 'defense')}   ·   `
      + `Power ${heroStat(hero, 'power')}   ·   Knowledge ${heroStat(hero, 'knowledge')}`);
    lines.push(`Max mana ${heroMaxMana(hero)}   ·   Movement ${heroMaxMovement(hero)}`);
    // Experience and the road to the next level (XP_TABLE is cumulative; the top
    // of the table is the level cap, where there is no "next").
    const next = XP_TABLE[hero.level + 1];
    lines.push(next != null
      ? `Experience ${hero.xp.toLocaleString()}   ·   ${Math.max(0, next - hero.xp).toLocaleString()} to level ${hero.level + 1}`
      : `Experience ${hero.xp.toLocaleString()}   ·   maximum level reached`);
    const skills = Object.entries(hero.skills || {})
      .map(([id, lvl]) => `${SKILLS[id]?.name || id} (${SKILL_LEVEL_NAMES[lvl]})`);
    lines.push(skills.length ? `Skills: ${skills.join(', ')}` : 'Skills: none yet');
    lines.push(hasChoice
      ? 'Choose a secondary skill:'
      : `All ${skills.length} skill slots are full — this level raises your statistics.`);
    return lines;
  }

  /**
   * The invasion horizon line under the date, and the door to the herald panel.
   *
   * Priority, highest first: a PEOPLE ashore as a realm, then war-bands in the
   * field, then the countdown to whoever is next. A nation with camps and armies
   * outranks a band on every axis that matters, so it gets the line. Blank when the
   * feature is off, so a Classic game's HUD is unchanged.
   */
  refreshWaveLabel() {
    if (!this.waveLabel) return;
    const s = this.state;
    // A rising in your own house outranks anything on the horizon — and it is checked
    // before the invasions guard below, because a Classic game with waves switched off
    // can still have its vassals bought. These are realms that fought beside you last
    // week, in the field with money nobody here could have paid them.
    const risen = uprisingReport(s, 0);
    if (risen.length) {
      const lead = risen[0];
      const others = risen.length - 1;
      const arms = lead.force >= 1000 ? `${Math.round(lead.force / 1000)}k in arms` : `${lead.force} in arms`;
      this.waveLabel.setText(`⚑ ${lead.name} in revolt — ${lead.towns === 1 ? '1 town' : `${lead.towns} towns`}, ${arms}`
        + (others > 0 ? `  +${others} more risen` : ''));
      this.waveLabel.setColor('#e0604c');
      return;
    }
    const days = daysToNextWave(s);
    const forecast = invasionForecast(s);
    if (days === null && !forecast) { this.waveLabel.setText(''); return; }

    // A people ashore is THE news. Name them, say what they hold, and colour the
    // line in their own banner so the words match the flags on the map.
    if (forecast?.ashore.length) {
      const lead = forecast.ashore[0];
      const others = forecast.ashore.length - 1;
      const held = lead.towns === 1 ? '1 town' : `${lead.towns} towns`;
      this.waveLabel.setText(`⚔ ${lead.name} — ${lead.broken ? 'foothold broken' : held}`
        + (others > 0 ? `  +${others} more ashore` : '')
        + `   ·   ${forecast.days === 0 ? 'another people is at the border' : `next in ${forecast.days}d`}`);
      this.waveLabel.setColor(rgba(shade(lead.color, 0.45)));
      return;
    }
    const bands = activeBands(s);
    if (bands.length) {
      // What is on the ground beats what is coming: name the people and how close
      // the nearest band is to the town it is marching on.
      const named = bands[0].invader?.peopleName || 'a war-band';
      const closest = bands.reduce((best, b) => {
        const t = s.towns[b.invader?.targetTownId];
        const d = t ? Math.abs(t.x - b.x) + Math.abs(t.y - b.y) : Infinity;
        return d < best.d ? { d, b, t } : best;
      }, { d: Infinity });
      const eta = Number.isFinite(closest.d)
        ? `  ·  ${closest.t?.name || 'a town'} in ~${Math.max(1, Math.ceil(closest.d / Math.max(1, closest.b.invader?.speed || 1)))}d`
        : '';
      this.waveLabel.setText(`⚔ ${named} afoot — ${bands.length} band${bands.length > 1 ? 's' : ''}${eta}`);
      this.waveLabel.setColor(invasionTruce(s) ? '#ff7a5a' : '#e8a060');
      return;
    }
    // Nothing in the field: the horizon. Whichever is sooner, a nation or a band.
    const nationDays = forecast?.days;
    const soonest = Number.isFinite(nationDays) ? Math.min(nationDays, days ?? nationDays) : days;
    const who = forecast?.coming?.[0]?.name;
    this.waveLabel.setText(soonest <= 0
      ? '⚔ outriders sighted'
      : `${who ? `${who} in` : 'next wave in'} ${soonest}d`);
    this.waveLabel.setColor(soonest <= 14 ? '#e8a060' : '#8a8578');
  }

  /**
   * The herald panel: who is ashore, who is coming, and how long.
   *
   * The reason it exists rather than a toast: a wave you are told about as it
   * arrives is an announcement, and a wave you can see queued three peoples deep is
   * a decision — march now, sign terms now, or spend the fortnight building. Every
   * number here is one the engine already computes; nothing is decorative.
   */
  invasionHeraldDialog() {
    const f = invasionForecast(this.state);
    if (!f) return;
    const W = this.scale.width, H = this.scale.height;
    const rows = f.ashore.length + f.coming.length;
    const w = Math.min(620, W - 30);
    const h = Math.min(H - 30, 168 + rows * 44);
    const px = (W - w) / 2, py = (H - h) / 2;
    const root = trackModal(this.add.container(0, 0).setDepth(DEPTH.MODAL));
    root.add(this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.6).setInteractive());
    root.add(panel(this, px, py, w, h));
    root.add(label(this, W / 2, py + 16, 'The Horizon', { size: '20px', bold: true, color: COLORS.gold, ox: 0.5 }));
    root.add(label(this, W / 2, py + 42,
      f.days === 0 ? 'Outriders are at the border.' : `The next people is ${f.days} days out.`,
      { size: '12px', color: COLORS.dim, ox: 0.5 }));

    let y = py + 72;
    /** One row: a banner swatch, a name, and a line of what it means. */
    const row = (color, name, detail, nameColor) => {
      root.add(this.add.rectangle(px + 30, y + 10, 14, 14, color).setStrokeStyle(1.5, 0x1a1826));
      root.add(label(this, px + 50, y, name, { size: '14px', bold: true, color: nameColor || COLORS.parchment }));
      root.add(label(this, px + 50, y + 19, detail, { size: '11.5px', color: COLORS.dim, wrap: w - 90 }));
      y += 44;
    };

    if (f.ashore.length) {
      root.add(label(this, px + 30, y - 18, 'ASHORE', { size: '10.5px', bold: true, color: COLORS.danger }));
      y += 6;
      for (const n of f.ashore) {
        row(n.color, n.name, n.broken
          ? 'Foothold broken — no camp, no conquest. Their armies have nowhere to fall back to.'
          : `Holds ${n.towns === 1 ? '1 town' : `${n.towns} towns`}. Break the camps and the rest withers.`,
        rgba(shade(n.color, 0.5)));
      }
      y += 8;
    }
    if (f.coming.length) {
      root.add(label(this, px + 30, y - 18, 'ON THE LIST', { size: '10.5px', bold: true, color: COLORS.dim }));
      y += 6;
      f.coming.forEach((n, i) => {
        // Unlanded peoples have no banner yet, so the swatch greys back with distance.
        row(shade(0x8a8578, -0.15 * i), n.name, n.creed);
      });
    }
    root.add(button(this, W / 2, py + h - 26, 150, 32, 'Close', () => root.destroy()));
    pinToScreen(root);
    return root;
  }

  gameOverDialog(won, reason, campaign = null, endless = null) {
    const grail = reason === 'grail';
    const draw = reason === 'draw';
    playMusic(won ? 'victory' : 'defeat'); // the end-game bed under the dialog
    // A campaign win frames the outcome as a chapter — and, unless it's the
    // last chapter, offers to march on with the same commander carried forward.
    if (won && campaign) {
      if (campaign.hasNext) {
        showDialog(this, {
          title: 'CHAPTER WON!',
          lines: [`${campaign.name} — Chapter ${campaign.chapter} of ${campaign.total} is yours.`,
            'Your commander carries their skills, spells and artifacts onward.'],
          buttons: [
            { text: 'March On →', onClick: () => this.adv.toCampaignChapter() },
            { text: 'Return to Menu', blue: true, onClick: () => this.adv.quitToMenu() },
          ],
        });
        return;
      }
      showDialog(this, {
        title: 'CAMPAIGN COMPLETE!',
        lines: [`${campaign.name} is won.`, 'Your name will echo through the ages!'],
        buttons: [{ text: 'Return to Menu', onClick: () => this.adv.quitToMenu() }],
      });
      return;
    }
    const wonLinesByReason = {
      grail: ['You have raised the Holy Grail.', 'The realm is united under your light!'],
      captureTown: ['The objective town flies your banner.', 'The realm is yours by seizing its heart!'],
      survive: ['You have outlasted the onslaught.', 'The realm endures under your watch!'],
      gold: ['Your treasury overflows.', 'The realm bows to your fortune!'],
      acquireArtifact: ['The fabled artifact is in your grasp.', 'Its power seals your claim to the realm!'],
      defeatHero: ['Your rival champion lies defeated.', 'No challenger remains to your rule!'],
      mines: ['Every mine in the land flies your banner.', 'The realm bows to your wealth!'],
      repelInvasions: ['The sea has stopped sending them.', 'You held the coast — the age is yours!'],
      invaderBattles: ['The long watch is ended.', 'Battle after battle, you held the coast — the age is yours!'],
      conquest: ['The enemy has been vanquished.', 'The realm bows to your banner!'],
    };
    const lines = won
      ? [
        ...(wonLinesByReason[reason] || wonLinesByReason.conquest),
        ...(endless ? [
          '',
          `Realm ${endless.realm} is yours. Your three greatest heroes carry everything they `
          + 'earned — level, skills, spells and every artifact — and so does every stone your '
          + 'masons laid. The next land is WIDER, and the age has advanced for everyone else '
          + 'too: rival capitals start as tall, their armies larger, their champions armed, '
          + 'and the wild stacks scale to the veterans you bring.',
        ] : []),
      ]
      : draw ? ['The realm lies in ruin.', 'No victor remains…']
        : (grail ? ['A rival has raised the Holy Grail.', 'Its light shines for another…']
                 : ['Your last stronghold has fallen.', 'The realm is lost to darkness…']);
    const buttons = [];
    // An endless run: the realm is won, so offer the next one. First button,
    // because it is what the player pressed "continue the run" for.
    if (endless) {
      buttons.push({
        text: `⚔ March on to realm ${endless.realm + 1}`,
        onClick: () => this.adv.toNextRealm(),
      });
    }
    // The envoys of the conquered. A conquest win is the end of the WAR; it does
    // not have to be the end of the MAP. Seat each fallen realm in one of your
    // towns, take its oath, and the game runs on — which is the only way to play
    // out an invasion you were already braced for.
    const pleas = won ? pleaOffers(getState(), 0) : [];
    if (pleas.length) {
      buttons.push({
        text: `⚖ Hear their envoys (${pleas.length})`,
        onClick: () => this.pleaDialog(pleas),
      });
    }
    // Learning Mode (#19): a generative "what you learned" debrief before you leave.
    buttons.push({ text: 'Return to Menu', blue: buttons.length > 0, onClick: () => this.adv.quitToMenu() });
    if (pleas.length) {
      lines.push('', 'Envoys from the realms you broke are at the gate, asking for their '
        + 'nations back — a town each, and their oath in return.');
    }
    // PERSISTENT: these buttons are the only way out of a settled game, so Esc
    // must not be able to dismiss the box and strand the player in a frozen world.
    this.gameOverRoot = showDialog(this, {
      title: won ? 'VICTORY!' : (draw ? 'STALEMATE' : 'DEFEAT'), lines, buttons, persistent: true,
    });
    return this.gameOverRoot;
  }

  /**
   * The envoys, named: who rises, in which of your towns, and what it costs.
   *
   * Shown before anything is committed, because handing over towns is not a thing
   * to discover after the fact. Accepting calls through to acceptPleas, which
   * seats every realm, signs every oath, and puts the game back in play — the Pax
   * then decides the age by invasions instead of conquest.
   */
  pleaDialog(pleas) {
    const grants = pleas.map((p) => `• ${p.name} → ${p.townName}${p.theirCapital ? ' (their old seat)' : ''}`);
    const days = CONFIG.PAX_INVASION_PERIOD_DAYS;
    // The watch length is the player's to set — "end after I successfully defend
    // against a set number of invasions, 3, 5, 15 etc" — so the counts ARE the
    // buttons. One screen, one decision.
    // The watch length is the player's to set, and it is now set in BATTLES —
    // "ten bands in one big wave = ten battles, two castles by four invader heroes
    // are eight battles". A wave count could not be asked to be long, because a
    // three-band raid and a ten-fight war score the same (actions.noteInvaderBattle).
    const buttons = CONFIG.PAX_BATTLE_CHOICES.map((n, i) => ({
      text: `${n} battles`,
      blue: n === CONFIG.PAX_BATTLE_TARGET || (i === 0 && !CONFIG.PAX_BATTLE_CHOICES.includes(CONFIG.PAX_BATTLE_TARGET)),
      onClick: () => this.adv.acceptPleas(pleas, n),
    }));
    buttons.push({ text: 'Refuse', cancel: true, onClick: () => this.adv.checkGameOver() });
    showDialog(this, {
      title: '⚖ Envoys of the Conquered',
      width: 620,
      lines: [
        'They ask for their nations back, and offer their oaths for them.',
        ...grants,
        '',
        'Each keeps its town, its mines and its farms, sends you a share of the '
        + 'proceeds, and answers the call when a people comes ashore. A realm you '
        + 'restored is the most loyal vassal there is — but loyalty still moves, '
        + 'and an oath can still be thrown off.',
        '',
        `The war between realms ends here; the coast decides the age. Waves come about `
        + `every ${days} days once the peace is sworn. How many do you mean to throw back?`,
      ],
      buttons,
    });
  }

  /**
   * Write the whole telemetry stream to a .jsonl download, with the aggregate
   * roll-up as a leading comment block.
   *
   * One object per line so the file can be grepped, streamed and truncated
   * without becoming unreadable — the format matters because the file exists to
   * be handed to somebody else and read with ordinary tools.
   */
  exportTelemetry() {
    const state = getState();
    const summary = aggregateLines(state).map((l) => `# ${l}`).join('\n');
    const body = toJSONL(state);
    const blob = new Blob([`${summary}\n${body}\n`], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jma3-telemetry-day${state?.day ?? 0}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    this.toast(`Telemetry exported — ${(state?.telemetry || []).length} events.`);
  }

  // CLONE: the end-of-game "What you learned" debrief (Learning Mode, #19) is
  // removed along with game/insights.js — it belongs to the study/edutainment half
  // of the parent repo, not to AI research.

}
