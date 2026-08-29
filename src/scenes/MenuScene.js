/**
 * MenuScene — Title screen: pick your faction, start a new game, or continue a
 * save. Uses the battle splash art as a backdrop when it's been generated
 * (public/sprites/splash_battle.png), else a painted night-sky scene.
 */

import Phaser from 'phaser';
import { FACTIONS } from '../data/factions.js';
import { campaignSaveSummary, hasSave, savedGameSummary, loadGame } from '../game/session.js';
import { weekOf, dayOfWeek } from '../core/GameState.js';
import { showOverlay, hideOverlay } from '../game/loadingOverlay.js';
import { townIcon } from '../gfx/sprites.js';
import { playMusic } from '../game/audio.js';
import { button, label, showDialog, FONT, COLORS, destroyAllChildren } from '../ui/uikit.js';
import { rgba, shade } from '../gfx/canvasKit.js';
import { COMBAT_BUILD } from './CombatScene.js';

// Prefer a dedicated menu vista; fall back to the battle splash, then paint.
const BACKDROP_KEYS = ['sprite_splash_menu', 'sprite_splash_battle'];

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create() {
    this.selected = this.selected || 'castle';
    playMusic('menu'); // queues until the first user gesture unlocks audio
    this.render();
    // The sprite pack loads off the critical path; re-render once it arrives so
    // the faction art + backdrop replace the procedural placeholders on their
    // own (previously it only refreshed when you clicked a card).
    if (!this.game.registry.get('spritesReady')) {
      this.game.events.once('sprites-loaded', this.onSpritesLoaded, this);
    }
    // Named handler + off on shutdown: the global ScaleManager (and game events)
    // outlive the scene, so anonymous listeners would pile up across visits.
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.onResize, this);
      this.game.events.off('sprites-loaded', this.onSpritesLoaded, this);
    });
  }

  onResize() {
    if (this.scene.isActive('Menu')) this.render();
  }

  onSpritesLoaded() {
    if (this.scene.isActive('Menu')) this.render();
  }

  render() {
    destroyAllChildren(this);
    this.drawBackground();
    this.drawTitle();
    this.drawFactions();
    this.drawActions();
    this.drawFooter();
  }

  // ---- background --------------------------------------------------------

  drawBackground() {
    const W = this.scale.width, H = this.scale.height;
    const bgKey = BACKDROP_KEYS.find((k) => this.textures.exists(k));
    if (bgKey) {
      const img = this.add.image(W / 2, H / 2, bgKey);
      img.setScale(Math.max(W / img.width, H / img.height));
      // Darken top & bottom for legible text; leave the middle art brighter.
      const g = this.add.graphics();
      g.fillStyle(0x06040e, 0.5);
      g.fillRect(0, 0, W, H);
      g.fillGradientStyle(0x05040c, 0x05040c, 0x05040c, 0x05040c, 0.92, 0.92, 0, 0);
      g.fillRect(0, 0, W, H * 0.44);
      g.fillGradientStyle(0x05040c, 0x05040c, 0x05040c, 0x05040c, 0, 0, 0.95, 0.95);
      g.fillRect(0, H * 0.56, W, H * 0.44);
    } else {
      this.drawPaintedBackdrop();
    }
  }

  /** Painted night-sky fallback: gradient sky, moon glow, stars, castle ridge. */
  drawPaintedBackdrop() {
    const W = this.scale.width, H = this.scale.height;
    const g = this.add.graphics();
    g.fillGradientStyle(0x0f0d24, 0x0f0d24, 0x3a1e2c, 0x281826, 1, 1, 1, 1);
    g.fillRect(0, 0, W, H);
    // Moon.
    g.fillStyle(0xf3ecd0, 0.10); g.fillCircle(W * 0.76, H * 0.24, 120);
    g.fillStyle(0xf3ecd0, 0.16); g.fillCircle(W * 0.76, H * 0.24, 74);
    g.fillStyle(0xfbf6e6, 0.95); g.fillCircle(W * 0.76, H * 0.24, 46);
    // Stars.
    const rnd = new Phaser.Math.RandomDataGenerator(['menu']);
    for (let i = 0; i < 140; i++) {
      g.fillStyle(0xfff8e0, rnd.frac() * 0.8 + 0.15);
      g.fillCircle(rnd.between(0, W), rnd.between(0, H * 0.66), rnd.frac() * 1.5 + 0.3);
    }
    // Misty ridge + castle silhouettes.
    const base = H - 30;
    g.fillStyle(0x0a0812, 0.55); g.fillRect(0, base - 60, W, 90);
    g.fillStyle(0x080610, 1);
    g.fillRect(W * 0.08, base - 130, 92, 130);
    g.fillTriangle(W * 0.08 - 12, base - 130, W * 0.08 + 46, base - 198, W * 0.08 + 104, base - 130);
    g.fillTriangle(W * 0.82, base, W * 0.86, base - 192, W * 0.90, base);
    g.fillTriangle(W * 0.78, base, W * 0.81, base - 122, W * 0.85, base);
    g.fillTriangle(W * 0.86, base, W * 0.90, base - 142, W * 0.94, base);
    g.fillRect(0, base, W, 30);
  }

  // ---- title -------------------------------------------------------------

  drawTitle() {
    const W = this.scale.width, H = this.scale.height;
    const cx = W / 2, top = H * 0.13;
    this.add.text(cx, top, 'R E A L M S   O F', {
      fontFamily: FONT, fontSize: '22px', color: '#c7bcda', fontStyle: 'bold',
    }).setOrigin(0.5).setShadow(0, 2, '#000', 4);
    const title = this.add.text(cx, top + 44, 'MIGHT & MAGIC', {
      fontFamily: FONT, fontSize: '58px', color: COLORS.gold, fontStyle: 'bold',
      stroke: '#140e04', strokeThickness: 8,
    }).setOrigin(0.5);
    title.setShadow(0, 0, '#e8a020', 22, false, true);
    this.add.text(cx, top + 92, 'a turn-based strategy saga', {
      fontFamily: FONT, fontSize: '15px', color: '#b7afc8', fontStyle: 'italic',
    }).setOrigin(0.5).setShadow(0, 2, '#000', 4);
  }

  // ---- faction cards -----------------------------------------------------

  drawFactions() {
    const W = this.scale.width, H = this.scale.height;
    const cx = W / 2, cy = H * 0.44;
    this.add.text(cx, cy - 104, 'CHOOSE YOUR BANNER', {
      fontFamily: FONT, fontSize: '15px', color: COLORS.parchment, fontStyle: 'bold',
    }).setOrigin(0.5).setShadow(0, 2, '#000', 4);

    // A 5-town carousel: the centre town is your chosen banner; the two towns
    // to each side preview its neighbours (smaller, dimmer). The ◀ ▶ arrows —
    // or a click on any side town — slide the selection, wrapping the ring.
    const factions = Object.values(FACTIONS);
    const n = factions.length;
    let selIdx = factions.findIndex((f) => f.id === this.selected);
    if (selIdx < 0) { selIdx = 0; this.selected = factions[0].id; }

    const slotGap = Math.min(150, (W - 160) / 5);
    const BOX = { 0: 132, 1: 84, 2: 56 };   // centre big → flanks progressively smaller
    const ALPHA = { 0: 1, 1: 0.68, 2: 0.4 };
    // Flanks first, centre last, so the big centre town overlaps its neighbours.
    for (const off of [-2, 2, -1, 1, 0]) {
      const f = factions[(selIdx + off + n) % n];
      const mag = Math.abs(off);
      const box = BOX[mag];
      const slot = this.add.container(cx + off * slotGap, cy);
      if (off === 0) {
        slot.add(this.add.rectangle(0, 0, box + 26, box + 26, f.color, 0.22)
          .setStrokeStyle(3, 0xf0d070));
      }
      const icon = townIcon(this, f.townGlyph, 0, 0, box);
      icon.setAlpha(ALPHA[mag]);
      slot.add(icon);
      slot.setSize(box, box).setInteractive({ useHandCursor: true })
        .on('pointerup', () => { if (f.id !== this.selected) { this.selected = f.id; this.render(); } });
    }

    // Arrows sit just outside the flanking towns.
    const armX = 2 * slotGap + 46;
    button(this, cx - armX, cy, 38, 48, '◀', () => this.cycleFaction(-1), { fontSize: '18px' });
    button(this, cx + armX, cy, 38, 48, '▶', () => this.cycleFaction(1), { fontSize: '18px' });

    // The selected banner's name + blurb, beneath the carousel.
    const sel = factions[selIdx];
    this.add.text(cx, cy + 88, sel.name, {
      fontFamily: FONT, fontSize: '24px', fontStyle: 'bold', color: rgba(shade(sel.color, 0.6)),
    }).setOrigin(0.5).setShadow(0, 2, '#000', 4);
    this.add.text(cx, cy + 116, sel.desc, {
      fontFamily: FONT, fontSize: '13px', color: '#cbc4dd', align: 'center',
      wordWrap: { width: Math.min(560, W - 60) },
    }).setOrigin(0.5, 0).setShadow(0, 2, '#000', 4);
  }

  /** Slide the banner carousel by ±1, wrapping around the faction ring. */
  cycleFaction(d) {
    const factions = Object.values(FACTIONS);
    const n = factions.length;
    const i = factions.findIndex((f) => f.id === this.selected);
    this.selected = factions[((i < 0 ? 0 : i) + d + n) % n].id;
    this.render();
  }

  // ---- actions -----------------------------------------------------------

  /**
   * Four doors, in the order a player wants them.
   *
   * IT USED TO BE NINE, plus the banner carousel: Play, Custom Game, Battle Gym,
   * Sandbox Arena, Settings, two Resume slots and Load Saved Game. Four of those
   * begin something and only ONE of the four begins the actual game — Battle Gym
   * and Sandbox Arena are combat workbenches and Custom Game is an advanced setup
   * screen — so a first-time player had no way to tell which door was the game.
   * Three more meant "carry on", stacked BELOW the four they would never press.
   *
   * Reported as: "it's good that we have so many options, but some users need
   * intuitive and simple UI."
   *
   * NOTHING IS REMOVED. The order is by who needs it soonest — Continue for the
   * player who came back, Play for the player who came to play, then the setup
   * screens folded behind one More door. Every one of them still counts itself
   * through uiTelemetry, so the grouping is a hypothesis the usage data can
   * correct rather than a verdict (see docs/START_SCREEN_REVIEW.md).
   */
  drawActions() {
    const W = this.scale.width, H = this.scale.height;
    const cx = W / 2;
    const camp = campaignSaveSummary();
    const skirmish = hasSave() ? savedGameSummary() : null;
    // Anchor the block to the BOTTOM as well as to 0.72H: with a Continue row it
    // is 124px from the first centre to the last, and a fraction alone walks the
    // last row into the footer on a short window (measured: it clears 768px but
    // not 600px). Whichever is higher wins.
    const lead = (camp || skirmish) ? 124 : 66;
    let y = Math.min(H * 0.72, H - 52 - lead);

    // 1. CONTINUE — first, because a returning player's action was under four
    //    things they were not going to press. Both slots are offered when both
    //    exist: a campaign, and the single-map slot (Quick Conquest and Custom
    //    Game share it).
    // CLONE: the campaign slot is gone with the Campaign scene, so there is one
    // Continue button rather than a pair. `camp` is always null here (the campaign
    // registry is empty) and is kept only so the layout maths above reads the same
    // as upstream.
    if (skirmish) {
      const both = false;
      const bw = 300;
      const bx = cx;
      {
        const what = skirmish.realm > 1 ? `realm ${skirmish.realm}`
          : skirmish.kind === 'custom' ? 'custom game' : 'conquest';
        const when = `Wk ${weekOf(skirmish.day)}, day ${dayOfWeek(skirmish.day)}`;
        button(this, bx, y, bw, 44,
          both ? `▶ Your ${what}` : `▶ Continue: your ${what} — ${when}`,
          () => this.continueSaved(),
          { blue: true, fontSize: both ? '12px' : '15px', track: 'Continue game' });
      }
      y += 58;
    }

    // 2. PLAY — the game. Conquest, the authored Campaigns and the procedural
    //    Sagas all live behind it in the Play hub, so the title carries one door
    //    rather than three. Your banner carries in; pacing comes from Settings.
    button(this, cx, y, 300, 54, '⚔  Play', () => this.openPlay(), { fontSize: '20px', track: 'Play' });
    // Publish the Play button centre so headless smokes can click through to the
    // Play hub (they then click the conquestBeginXY the Campaign scene publishes).
    this.registry.set('menuPlayXY', { x: cx, y });
    y += 66;

    // 3 & 4. Everything else. The setup screens and the save browser are real and
    //    stay reachable — they are simply not four more things to weigh up before
    //    you have played once.
    button(this, cx - 78, y, 148, 34, '✦ More ways to play', () => this.openMore(), { blue: true, fontSize: '12px', track: 'More' });
    button(this, cx + 78, y, 148, 34, '⚙ Settings', () => this.openSettings(), { fontSize: '12px', track: 'Settings' });
  }

  /**
   * The four doors that used to be on the title screen: the two combat
   * workbenches, the advanced setup, and the named-save browser.
   *
   * A dialog rather than a scene — showDialog already wraps its buttons into
   * rows, tracks itself as a modal and answers Esc, so this is the same chrome
   * every other choice in the game uses.
   */
  openMore() {
    showDialog(this, {
      title: 'More ways to play',
      lines: [
        'Custom Game is the ordinary match. The Battle Gym is one battle in isolation.',
      ],
      buttons: [
        { text: '✦ Custom Game', blue: true, onClick: () => this.scene.start('CustomScenario') },
        { text: '⚔ Battle Gym', blue: true, onClick: () => this.scene.start('SkirmishSetup', { scenarioIndex: 0 }) },
        { text: '💾 Load a save', blue: true, onClick: () => this.openLoad() },
        { text: 'Back', cancel: true },
      ],
    });
  }

  /** Named saves: pick any titled, dated save to resume. */
  openLoad() {
    this.scene.launch('SaveLoad', {
      mode: 'load',
      onClose: () => this.scene.resume(),
      onLoaded: () => { this.scene.stop('SaveLoad'); this.scene.start('Adventure'); },
    });
    this.scene.pause();
  }

  /** Resume the single-map save (Custom Game / Quick Conquest share the slot).
   *  Overlay first, then await — the read is an IndexedDB fetch plus a gunzip. */
  async continueSaved() {
    showOverlay('Restoring your realm…');
    if (!await loadGame()) { hideOverlay(); return; }
    requestAnimationFrame(() => this.scene.start('Adventure'));
  }

  /** Start a game, carrying the chosen banner.
   *
   *  CLONE: upstream this opens the Campaign hub (Conquest / Campaigns / Sagas) and
   *  Quick Conquest lives inside it. With campaigns dropped, "Play" goes straight to
   *  the Custom Game launcher — which is the single-map setup Quick Conquest was a
   *  preset of, and the only shape of game this clone runs. */
  openPlay() {
    this.scene.start('CustomScenario', { faction: this.selected });
  }

  openSettings() {
    this.scene.launch('Settings', { onClose: () => this.scene.resume('Menu') });
    this.scene.pause('Menu');
  }

  drawFooter() {
    const W = this.scale.width, H = this.scale.height;
    label(this, W - 12, H - 10, 'In the spirit of Heroes of Might and Magic III', {
      size: '11px', color: '#6a6580', ox: 1, oy: 1,
    });
    label(this, 12, H - 10, `build ${COMBAT_BUILD}`, { size: '11px', color: '#6a6580', oy: 1 });
  }
}
