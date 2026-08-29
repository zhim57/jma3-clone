/**
 * SettingsScene — the preferences overlay.
 *
 * Launched over whatever scene opened it; the caller passes an onClose so it can
 * resume. Reads/writes the persistent settings store live, so changes take
 * effect (and are heard) immediately.
 *
 * The screen renders SETTINGS_PAGES (src/ui/settingsRows.js) — it does not
 * declare its own rows. That table is also what the layout replay and every
 * guard test read, so there is no hand-kept copy to drift out of date.
 *
 * Three things it shows that the old screen did not:
 *
 *   SCOPE. Settings opens over a running game, and a 'game'-scope row cannot
 *   reach the game you are looking at — toggling Diplomacy mid-campaign did
 *   nothing and said nothing. Each section now states when its rows take effect.
 *
 *   WHAT YOU CHANGED. Rows differing from the shipped default carry a dot and are
 *   counted in the title. The whole siteRespawn archaeology — three incidents, a
 *   schema revision, a save migration — happened inside a store nobody could see.
 *
 *   WHY. A detail strip at the foot carries the rationale for the row under the
 *   pointer, sourced from SETTING_RATIONALE rather than from comments no player
 *   reads. It updates on hover AND on tap, because a hover tooltip is invisible
 *   until found and unusable on touch.
 */

import Phaser from 'phaser';
import {
  getSetting, setSetting, resetSetting, changedFromDefaults,
  DEFAULT_SETTINGS, SETTING_SCOPES, SETTING_RATIONALE, LIVE_TUNABLE, GAME_FEATURE_KEYS,
} from '../game/settings.js';
import { featureOn, adoptFeature } from '../core/GameState.js';
import { playSfx } from '../game/audio.js';
import { panel, inset, label, button, showDialog, COLORS } from '../ui/uikit.js';
import { getState } from '../game/session.js';
import { downloadChronicle } from '../game/chronicleExport.js';
import { downloadUsage } from '../game/uiTelemetry.js';
import { SETTINGS_PAGES, TOUCH_MIN, CHROME, CHROME_BOTTOM, packAll } from '../ui/settingsRows.js';

/**
 * Push the tunables that a RUNNING game reads off state back onto it when Settings
 * closes.
 *
 * The engine reads its challenge floor from `state.tideHardness`, seeded once at New
 * Game — which is correct (a save must replay the difficulty it was played at) but left
 * the slider useless for the game in front of you. Turning on scaled fights mid-game
 * and then being locked at whatever floor the save was born with is a switch with no
 * dial. Only the knobs that are pure magnitude are synced (LIVE_TUNABLE); the on/off
 * gates already live-adopt through `?? true`, and the pacing preset is deliberately
 * NOT synced — it changes what systems exist, not how hard they bite.
 */
function applyLiveTuning() {
  const s = getState();
  if (!s) return;
  for (const key of LIVE_TUNABLE) {
    const v = getSetting(key);
    if (Number.isFinite(v)) s[key] = v;
  }
}

/**
 * What the RUNNING game has for a 'game'-scope key, or null when there is no
 * game, the key is not game-scope, or the state does not carry it.
 *
 * The store and the running game are two different answers to "is this on", and
 * the screen used to show only the first. Reported from play: "the physical
 * model shows enabled, but in dwellings it shows it's not enabled" — both
 * screens were telling the truth about different things. A game snapshots its
 * rules at New Game and the save carries them, so ticking the box changes your
 * NEXT game; the town was reading `state.features` and was right.
 *
 * LIVE_TUNABLE is excluded on purpose: those three are pushed onto the running
 * state when Settings closes (applyLiveTuning), so a difference seen while the
 * screen is open is about to resolve itself and flagging it would be noise.
 */
function runningValue(key) {
  const s = getState();
  if (!s || SETTING_SCOPES[key] !== 'game' || LIVE_TUNABLE.includes(key)) return null;
  if (GAME_FEATURE_KEYS.includes(key)) return featureOn(s, key);
  return key in s ? s[key] : null;
}

/** True when this game is playing by a different rule than the box shows. */
function divergent(key) {
  const v = runningValue(key);
  return v !== null && v !== getSetting(key);
}

/** When a scope's changes land, as a player reads it. */
const SCOPE_TAG = {
  device: 'applies now',
  live: 'applies to the game you are playing',
  game: 'applies to your next new game',
};

export class SettingsScene extends Phaser.Scene {
  constructor() {
    super('Settings');
  }

  init(data) {
    this.onClose = data?.onClose;
    this.pageIndex = 0;
    this.physIndex = 0;
  }

  create() {
    const W = this.scale.width, H = this.scale.height;
    // Dim, input-blocking backdrop so clicks don't leak to the scene beneath.
    this.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.62).setInteractive();

    // One panel height for every tab. Sized per-page it would be 564px on Game
    // and 314px on Advanced, moving the tabs and Back button under the pointer
    // as you switch between them.
    this.layout = packAll(W, H);
    const pw = this.layout.pw, ph = this.layout.panelH;
    this.px = (W - pw) / 2;
    this.py = (H - ph) / 2;
    this.pw = pw;
    this.ph = ph;

    panel(this, this.px, this.py, pw, ph);
    this.titleText = label(this, W / 2, this.py + 18, 'Settings', {
      size: '20px', bold: true, color: COLORS.gold, ox: 0.5,
    });

    // Tabs. Two pages, so two buttons — derived from the table, not hardcoded.
    this.tabs = SETTINGS_PAGES.map((page, i) => button(
      this, this.px + 110 + i * 132, this.py + 26, 124, 28, page.title,
      () => { this.pageIndex = i; this.physIndex = 0; this.render(); },
      { fontSize: '13px', blue: i === 0 },
    ));

    // The detail strip: one line of "what does this do", shared by every row.
    // Positioned off CHROME_BOTTOM, the same budget the packer reserves, so the
    // columns can never be laid out over it.
    const stripY = this.py + ph - CHROME_BOTTOM + CHROME.stripGap;
    inset(this, this.px + 26, stripY, pw - 52, CHROME.stripH);
    this.detail = label(this, this.px + 36, stripY + 7, '', {
      size: '12px', color: COLORS.dim, wrap: pw - 72,
    });
    this.clearDetail();

    // Footer. Mute moved onto the Sound section header and Export game log onto
    // the Advanced page, so what is left here is the two whole-screen verbs.
    const by = stripY + CHROME.stripH + CHROME.buttonsGap + CHROME.buttonsH / 2;
    this.resetBtn = button(this, W / 2 - 100, by, 180, CHROME.buttonsH, 'Restore defaults', () => this.confirmReset(), { fontSize: '13px' });
    button(this, W / 2 + 100, by, 180, CHROME.buttonsH, 'Back', () => this.close(), { fontSize: '13px', blue: true });

    this.pageRoot = this.add.container(0, 0);
    this.render();

    this.input.keyboard?.once('keydown-ESC', () => this.close());
  }

  // ── chrome ────────────────────────────────────────────────────────────────

  /** Repaint the title's "N changed" counter and the Restore button's state. */
  syncChrome() {
    const n = changedFromDefaults().length;
    this.titleText.setText(n ? `Settings — ${n} changed from shipped` : 'Settings');
    this.titleText.setX(this.scale.width / 2);
    this.titleText.setOrigin(0.5, 0);
    this.resetBtn?.setEnabled(n > 0);
    this.tabs.forEach((t, i) => t.bg.setTexture(i === this.pageIndex ? 'ui_btn_blue' : 'ui_btn'));
  }

  clearDetail() {
    this.detail.setText('Point at a setting to read what it does — and what we measured.');
    this.detail.setColor(COLORS.dim);
  }

  /**
   * Show a key's rationale, plus the one thing the rationale cannot know: whether
   * this particular change can reach the game currently being played.
   */
  showDetail(key) {
    const parts = [SETTING_RATIONALE[key] || ''];
    const scope = SETTING_SCOPES[key];
    if (scope === 'game' && getState()) {
      const live = runningValue(key);
      if (LIVE_TUNABLE.includes(key)) {
        parts.push('Its size also applies to the game in progress.');
      } else if (live !== null && live !== getSetting(key)) {
        // The sentence the player was missing. Naming the current game's value
        // is what turns "the screen is lying" into "these are two questions".
        const shown = typeof live === 'boolean' ? (live ? 'on' : 'off') : String(live);
        parts.push(`YOUR GAME IN PROGRESS HAS THIS ${shown.toUpperCase()} — it kept the rules it started with.`);
        if (GAME_FEATURE_KEYS.includes(key) && !live) parts.push('Tick it again to adopt it for this game too.');
      } else {
        parts.push('Your game in progress keeps the rules it started with.');
      }
    }
    this.detail.setText(parts.filter(Boolean).join('  '));
    this.detail.setColor(COLORS.parchment);
  }

  confirmReset() {
    const changed = changedFromDefaults();
    if (!changed.length) return;
    showDialog(this, {
      title: 'Restore defaults?',
      lines: [
        `${changed.length} setting${changed.length === 1 ? '' : 's'} differ${changed.length === 1 ? 's' : ''} from what this build ships.`,
        'Restoring affects your next new game, not the one in progress.',
      ],
      buttons: [
        { text: 'Restore', blue: true, onClick: () => { for (const k of changed) resetSetting(k); this.render(); } },
        { text: 'Cancel', cancel: true },
      ],
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  render() {
    this.pageRoot.removeAll(true);
    const physical = this.layout.packed[this.pageIndex].physical;
    this.physIndex = Math.max(0, Math.min(this.physIndex, physical.length - 1));
    const sheet = physical[this.physIndex];

    for (const item of sheet.items) {
      if (item.type === 'header') this.drawHeader(item);
      else this.drawRow(item);
    }

    // A declared page that will not fit PAGES rather than overflowing — the whole
    // point of the rewrite. At every viewport the game actually runs at this never
    // fires, but it is what makes "a row is drawn off the panel" unreachable
    // however many knobs get added later.
    if (physical.length > 1) {
      // In the title row, not below the columns: the columns own everything down
      // to CHROME_BOTTOM, so a pager under them would be the overlap this
      // rewrite exists to remove.
      const ty = this.py + 26;
      this.own(button(this, this.px + this.pw - 118, ty, 26, 24, '◀', () => {
        this.physIndex = (this.physIndex + physical.length - 1) % physical.length; this.render();
      }, { fontSize: '11px' }));
      this.own(label(this, this.px + this.pw - 82, ty, `${this.physIndex + 1}/${physical.length}`, {
        size: '11px', color: COLORS.dim, ox: 0.5, oy: 0.5,
      }));
      this.own(button(this, this.px + this.pw - 46, ty, 26, 24, '▶', () => {
        this.physIndex = (this.physIndex + 1) % physical.length; this.render();
      }, { fontSize: '11px' }));
    }

    this.syncChrome();
  }

  /** Reparent a uikit object into the page container so a tab switch clears it. */
  own(obj) {
    this.pageRoot.add(obj);
    return obj;
  }

  drawHeader(item) {
    const s = item.section;
    const x = this.px + item.x, y = this.py + item.y;
    const titleTxt = this.own(label(this, x, y, s.title, { size: '14px', bold: true, color: COLORS.gold }));

    // A section-level switch riding the header (Sound on / off), claiming the
    // right end of the row.
    const checkW = s.headerCheck ? 96 : 0;
    if (s.headerCheck) {
      this.checkbox(s.headerCheck, s.headerCheckLabel, x + item.w - checkW, y - 2, checkW, { invert: s.headerCheckInvert });
    }

    // The scope tag, in whatever room is left BETWEEN the title and that switch.
    // Right-aligned across the whole row it printed straight through the mute
    // chip. 'game' turns amber while a game is running, because that is exactly
    // when the row cannot do what it looks like it does.
    const stale = s.scope === 'game' && !!getState();
    const keys = [...(s.headerCheck ? [s.headerCheck] : []), ...s.rows.map((r) => r.key).filter(Boolean)];
    const differ = keys.filter(divergent).length;
    const tag = differ
      ? `${SCOPE_TAG[s.scope]} · ${differ} differ${differ === 1 ? 's' : ''} from this game`
      : SCOPE_TAG[s.scope];
    const tagRoom = item.w - checkW - titleTxt.width - 20;
    if (tagRoom > 60) {
      this.own(label(this, x + item.w - checkW - 4, y + 3, tag, {
        size: '9px', color: stale ? '#c8a24a' : COLORS.dim, ox: 1, max: tagRoom,
      }));
    }

    if (s.note) this.own(label(this, x, y + 17, s.note, { size: '10px', color: COLORS.dim, wrap: item.w }));
  }

  drawRow(item) {
    const r = item.row;
    const x = this.px + item.x, y = this.py + item.y;
    if (r.kind === 'checkPair') {
      const cw = r.items.length > 1 ? (item.w - 14) / 2 : item.w;
      r.items.forEach((c, i) => this.checkbox(c.key, c.label, x + i * (cw + 14), y, cw));
      return;
    }
    if (r.kind === 'slider') return this.slider(r, x, y, item.w);
    if (r.kind === 'cycle') return this.cycle(r, x, y, item.w);
    if (r.kind === 'combo') return this.combo(r, x, y, item.w);
    if (r.kind === 'readonly') return this.readonly(r, x, y, item.w);
    if (r.kind === 'action') return this.action(r, x, y, item.w);
  }

  /** A gold dot marking a value that differs from what this build ships. */
  changedDot(key, x, y) {
    if (getSetting(key) === DEFAULT_SETTINGS[key]) return null;
    return this.own(this.add.circle(x, y, 3, 0xe8c060));
  }

  /**
   * A checkbox chip: 26px of drawn height, but a TOUCH_MIN-tall hit rect over the
   * whole chip — fixing "unreachable by layout" with "unreachable by fat finger"
   * would not be a fix.
   */
  checkbox(key, text, x, y, w, opts = {}) {
    const shown = () => (opts.invert ? !getSetting(key) : !!getSetting(key));
    const cy = y + 13;
    // Amber when this game is playing by a different rule than the box shows —
    // the state the dwellings screen reports and this screen used to hide.
    const off = divergent(key);
    const adoptable = off && !runningValue(key) && GAME_FEATURE_KEYS.includes(key);

    const box = this.own(this.add.rectangle(x + 8, cy, 15, 15, 0x0c0a14).setStrokeStyle(1.6, 0x6d6684));
    const tick = this.own(this.add.text(x + 8, cy, '✓', {
      fontFamily: 'Georgia, serif', fontSize: '13px', color: '#dbe6fb',
    }).setOrigin(0.5));
    this.own(label(this, x + 24, y + 4, text, {
      size: '13px', color: off ? '#c8a24a' : COLORS.parchment, max: w - (off ? 92 : 34),
    }));
    if (off) {
      this.own(label(this, x + w - 18, y + 5,
        `this game: ${runningValue(key) ? 'on' : 'off'}${adoptable ? ' ▸' : ''}`,
        { size: '9px', color: '#c8a24a', ox: 1 }));
    }
    const dot = this.changedDot(key, x + w - 6, cy);

    const paint = () => {
      const on = shown();
      box.setFillStyle(on ? 0x2e4a7c : 0x0c0a14);
      box.setStrokeStyle(1.6, on ? 0x6e8fc4 : 0x6d6684);
      tick.setVisible(on);
      dot?.setVisible(getSetting(key) !== DEFAULT_SETTINGS[key]);
    };
    paint();

    const hit = this.own(this.add.rectangle(x, cy, w, TOUCH_MIN, 0xffffff, 0)
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true }));
    hit.on('pointerover', () => this.showDetail(key));
    hit.on('pointerout', () => this.clearDetail());
    hit.on('pointerup', () => {
      const before = divergent(key);
      setSetting(key, !getSetting(key));
      playSfx('click');
      paint();
      this.showDetail(key);
      this.syncChrome();
      // Turning a game-scope rule ON while a game is running is the moment the
      // player expects it to take effect — and the moment it does not. Offer
      // adoption right there, rather than leaving them to find the one town
      // screen that carries the switch.
      if (getSetting(key) && divergent(key) && GAME_FEATURE_KEYS.includes(key)) this.offerAdopt(key, text);
      else if (before !== divergent(key)) this.render();
    });

    // The "this game: off ▸" marker is its own target, added AFTER the row's hit
    // rect so Phaser's topOnly dispatch gives it the press. It has to be separate:
    // the box is already ticked, so clicking the ROW can only mean "untick", and
    // there would otherwise be no gesture at all for "adopt it here too".
    if (adoptable) {
      const mark = this.own(this.add.rectangle(x + w - 96, cy, 96, 22, 0xffffff, 0)
        .setOrigin(0, 0.5)
        .setInteractive({ useHandCursor: true }));
      mark.on('pointerover', () => this.showDetail(key));
      mark.on('pointerout', () => this.clearDetail());
      mark.on('pointerup', () => this.offerAdopt(key, text));
    }
  }

  /**
   * One-way adoption of a rule into the game in progress, mirroring the offer the
   * Town improvements dialog already makes for the Physical Damage Model — and
   * generalising it, since every game-scope feature has the same dead end.
   * Not retroactive: it governs from here on, exactly like adoptFeature's contract.
   */
  offerAdopt(key, text) {
    showDialog(this, {
      title: `Adopt ${text} for this game?`,
      lines: [
        'A game keeps the rules it began with, so this is now set for your next new game.',
        'The game in progress can adopt it as well.',
        '',
        'It takes effect from here on — nothing already played changes,',
        'and it cannot be undone for this game.',
      ],
      buttons: [
        {
          text: 'Adopt now',
          blue: true,
          primary: true,
          onClick: () => {
            adoptFeature(getState(), key);
            playSfx('confirm');
            this.render();
            this.showDetail(key);
          },
        },
        { text: 'Just my next game', cancel: true },
      ],
    });
  }

  /**
   * A labelled slider. `row.offKey` gives it an Off detent at the far left, which
   * is how two rows (an on/off gate and its magnitude) become one control.
   *
   * Two keys stay underneath, deliberately: the detent writes the gate false and
   * does NOT touch the magnitude, whose setSetting clamp would silently pull any
   * out-of-range "off" sentinel back into a real value — a game quietly different
   * from the one that was asked for.
   */
  /**
   * Make a slider track GRABBABLE ALONG ITS WHOLE LENGTH.
   *
   * Both sliders used to hang their drag off the handle alone — a circle of
   * radius 10 (9 in the combo row), so the target was ~20px wide on a 40px-tall
   * row, and the track itself was inert. You could not click a point on the bar
   * to jump there, which is what every slider anyone has ever used does; you had
   * to find and seize the dot. That is the complaint, and the handle radius is
   * only half of it — a bar you cannot click is the other half.
   *
   * So the strip below covers the TRACK's full width at TOUCH_MIN height (the
   * same 36px minimum this file already sets for every other control) and takes
   * both gestures: `pointerdown` jumps the value to where you pressed, and a
   * drag keeps setting it as you move. It deliberately spans the track and not
   * the whole row — in the combo layout the row's left half is a label and a
   * button, and a press there must not fling the magnitude across its range.
   *
   * The handle keeps a hand cursor but no longer carries the drag itself: the
   * strip is created after it and therefore sits above it, so one surface owns
   * the gesture and the two cannot disagree about where the pointer went.
   */
  grabStrip(x0, width, cy, apply) {
    const strip = this.own(this.add.rectangle(x0, cy, width, TOUCH_MIN, 0xffffff, 0)
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true, draggable: true }));
    const set = (px) => apply(Math.max(x0, Math.min(x0 + width, px)));
    // BOTH gestures read the POINTER, not the drag payload. Phaser's `drag`
    // hands you the object's would-be position — the pointer minus wherever
    // inside the object you grabbed it — which is right for dragging a sprite
    // around and wrong for a value that IS the pointer's position on a bar.
    // Reading dragX put the value off by the grab offset, so pressing near the
    // right end and dragging left drove it to zero long before the pointer got
    // there. The pointer's own x has no offset to be wrong about.
    strip.on('pointerdown', (p) => set(p.worldX ?? p.x));
    strip.on('drag', (p) => set(p.worldX ?? p.x));
    return strip;
  }

  slider(row, x, y, w) {
    const { key, min, max, fmt, offKey } = row;
    const isOff = () => !!offKey && !getSetting(offKey);
    const text = () => (isOff() ? 'Off' : fmt(getSetting(key)));

    this.own(label(this, x, y + 2, row.label, { size: '13px', color: COLORS.parchment, max: w - 76 }));
    const valLbl = this.own(label(this, x + w, y + 2, text(), { size: '13px', color: COLORS.gold, ox: 1 }));
    this.changedDot(key, x + w + 8, y + 9);

    const ty = y + 27;
    // The detent is the leftmost slice of the track; everything right of it is
    // the real range, so the value can never be mistaken for "a bit above off".
    const detent = offKey ? 16 : 0;
    this.own(this.add.rectangle(x, ty, w, 6, 0x3a3550).setOrigin(0, 0.5));
    const fill = this.own(this.add.rectangle(x, ty, 0, 6, 0xe8c060).setOrigin(0, 0.5));
    const handle = this.own(this.add.circle(x, ty, 10, 0xe8c060).setStrokeStyle(2, 0x2a2438));

    const xForVal = () => (isOff()
      ? x
      : x + detent + ((getSetting(key) - min) / (max - min)) * (w - detent));
    const sync = () => {
      handle.x = xForVal();
      fill.width = Math.max(0, handle.x - x);
      handle.setFillStyle(isOff() ? 0x6d6684 : 0xe8c060);
      valLbl.setText(text());
    };
    sync();

    // The row-wide hover rect is created FIRST, deliberately. Phaser hands a
    // pointer to the object added LAST among those under it, so while this sat
    // at the bottom of the method it covered the grab strip and swallowed every
    // press on the track — the strip existed, was draggable, and never once saw
    // a pointer. Hover detail wants the whole row; the value wants the track;
    // the one that must win the press is created second.
    const hit = this.own(this.add.rectangle(x, y + 14, w, TOUCH_MIN, 0xffffff, 0)
      .setOrigin(0, 0.5).setInteractive());
    hit.on('pointerover', () => this.showDetail(key));
    hit.on('pointerout', () => this.clearDetail());

    handle.setInteractive({ useHandCursor: true });
    const strip = this.grabStrip(x, w, ty, (cx) => {
      if (offKey && cx < x + detent) {
        setSetting(offKey, false); // magnitude untouched — see the doc comment
      } else {
        if (offKey && !getSetting(offKey)) setSetting(offKey, true);
        setSetting(key, min + ((cx - x - detent) / (w - detent)) * (max - min));
      }
      sync();
      this.syncChrome();
    });
    strip.on('pointerover', () => this.showDetail(key));
    strip.on('pointerout', () => this.clearDetail());
    if (row.sfx) {
      strip.on('dragend', () => playSfx(row.sfx));
      strip.on('pointerup', () => playSfx(row.sfx));
    }
  }

  /** A labelled button cycling a key through `row.values`. */
  cycle(row, x, y, w) {
    const { key, values, fmt, isOn } = row;
    this.own(label(this, x, y + 6, row.label, { size: '13px', color: COLORS.parchment, max: w - 104 }));
    this.changedDot(key, x + w - 100, y + 13);
    const b = this.own(button(this, x + w - 44, y + 15, 88, 26, fmt(getSetting(key)), () => {
      const next = values[(values.indexOf(getSetting(key)) + 1) % values.length];
      setSetting(key, next);
      b.setLabel(fmt(next));
      b.bg.setTexture(isOn(next) ? 'ui_btn_blue' : 'ui_btn');
      this.showDetail(key);
      this.syncChrome();
    }, { blue: isOn(getSetting(key)), fontSize: '12px' }));
    b.on('pointerover', () => this.showDetail(key));
    b.on('pointerout', () => this.clearDetail());
  }

  /**
   * A cycle and its magnitude on one row — and the magnitude greys out when the
   * cycle reads Off, instead of sitting live and inert as it used to.
   */
  combo(row, x, y, w) {
    const { key, values, fmt, isOn, powerKey, powerMin, powerMax, powerFmt } = row;
    this.own(label(this, x, y + 2, row.label, { size: '13px', color: COLORS.parchment, max: w - 120 }));
    this.changedDot(key, x + w - 116, y + 9);

    const tw = Math.min(150, w - 120);
    const tx = x + w - tw, ty = y + 30;
    const track = this.own(this.add.rectangle(tx, ty, tw, 6, 0x3a3550).setOrigin(0, 0.5));
    const fill = this.own(this.add.rectangle(tx, ty, 0, 6, 0xe8c060).setOrigin(0, 0.5));
    const handle = this.own(this.add.circle(tx, ty, 9, 0xe8c060).setStrokeStyle(2, 0x2a2438));
    const powerLbl = this.own(label(this, x, y + 26, '', { size: '11px', color: COLORS.dim }));

    const live = () => isOn(getSetting(key));
    const sync = () => {
      const on = live();
      handle.x = tx + ((getSetting(powerKey) - powerMin) / (powerMax - powerMin)) * tw;
      fill.width = Math.max(0, handle.x - tx);
      const dim = on ? 1 : 0.35;
      track.setAlpha(dim); fill.setAlpha(dim); handle.setAlpha(dim);
      handle.setFillStyle(on ? 0xe8c060 : 0x6d6684);
      if (handle.input) handle.input.enabled = on;
      powerLbl.setText(on ? `power ${powerFmt(getSetting(powerKey))}` : 'power — off');
      powerLbl.setColor(on ? COLORS.parchment : COLORS.dim);
    };

    const b = this.own(button(this, x + 44, y + 30, 88, 26, fmt(getSetting(key)), () => {
      const next = values[(values.indexOf(getSetting(key)) + 1) % values.length];
      setSetting(key, next);
      b.setLabel(fmt(next));
      b.bg.setTexture(isOn(next) ? 'ui_btn_blue' : 'ui_btn');
      sync();
      this.showDetail(key);
      this.syncChrome();
    }, { blue: isOn(getSetting(key)), fontSize: '12px' }));
    powerLbl.setX(x + 96);

    // Created before the grab strip, for the reason spelled out in slider().
    const hit = this.own(this.add.rectangle(x, y + 14, w, TOUCH_MIN, 0xffffff, 0)
      .setOrigin(0, 0.5).setInteractive());
    hit.on('pointerover', () => this.showDetail(key));
    hit.on('pointerout', () => this.clearDetail());

    handle.setInteractive({ useHandCursor: true });
    const strip = this.grabStrip(tx, tw, ty, (cx) => {
      if (!live()) return; // greyed out while the cycle reads Off
      setSetting(powerKey, powerMin + ((cx - tx) / tw) * (powerMax - powerMin));
      sync();
      this.syncChrome();
    });
    strip.on('pointerover', () => this.showDetail(key));
    strip.on('pointerout', () => this.clearDetail());
    sync();
  }

  /** A value the player may read but not set. */
  readonly(row, x, y, w) {
    this.own(label(this, x, y + 4, row.label, { size: '12px', color: COLORS.dim }));
    this.own(label(this, x + w, y + 4, row.value(getSetting(row.key)), {
      size: '12px', color: COLORS.dim, ox: 1, max: w - 90,
    }));
    const hit = this.own(this.add.rectangle(x, y + 13, w, 26, 0xffffff, 0)
      .setOrigin(0, 0.5).setInteractive());
    hit.on('pointerover', () => this.showDetail(row.key));
    hit.on('pointerout', () => this.clearDetail());
  }

  /**
   * A button row. The chronicle is a whole-game log book written every day and
   * every battle, for reading a position back rather than reconstructing it — a
   * diagnostic, not a play verb, so it lives on Advanced. It reports what it did,
   * so a click never looks like nothing.
   */
  action(row, x, y, w) {
    const run = {
      // The chronicle: a whole-game log book written every day and every battle,
      // for reading a position back rather than reconstructing it.
      exportLog: () => { const r = downloadChronicle(); return r.ok ? `Saved ${r.entries} entries` : r.reason; },
      // What has been clicked, so the UI can be cut on evidence. Local until
      // this button is pressed — that is the whole distribution mechanism.
      exportUsage: () => {
        const r = downloadUsage();
        return r.ok ? `Saved ${r.sessions} sessions, ${r.clicks} clicks` : r.reason;
      },
    }[row.id];
    if (!run) return;
    const b = this.own(button(this, x + Math.min(w, 220) / 2, y + 20, Math.min(w, 220), 32, row.label, () => {
      const msg = run();
      b.setLabel(msg);
      playSfx('confirm');
      this.time.delayedCall(2600, () => { if (b.active) b.setLabel(row.label); });
    }, { fontSize: '13px', track: row.label }));
  }

  close() {
    applyLiveTuning();
    this.scene.stop();
    this.onClose?.();
  }
}
