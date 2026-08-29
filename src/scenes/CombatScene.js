/**
 * CombatScene — Interactive tactical battles on a 15x11 hex field.
 *
 * All rules live in core/combat/CombatEngine.js; this scene renders the
 * battle, animates engine events, takes orders for the human side and lets
 * CombatAI drive the other side. When the battle ends it hands the raw
 * engine result back to the caller (AdventureScene applies it to the world).
 */

import Phaser from 'phaser';
import { CREATURES } from '../data/creatures.js';
import { SPELLS } from '../data/spells.js';
import { getState } from '../game/session.js';
import { playSfx } from '../game/audio.js';
import { tileAt } from '../core/GameState.js';
import { playerUpgrades } from '../core/upgrades.js';
import { heroStat, heroMaxMana } from '../core/heroUtils.js';
import { spellCost, isMassCast, masteryNote, effectSummary, effectDetail, effectMood } from '../core/magic.js';
import {
  createBattle, beginTurn, act, castSpell, canCast, canShoot, reachableHexes,
  hexNeighbors, hexDistance, unitAt, battleResult, ability, escapeBattle,
  BF_W, BF_H, unitSpeed, unitAttackStat, unitDefenseStat, tacticsBand, canPlaceTactics, placeTactics, endTactics,
} from '../core/combat/CombatEngine.js';
import { chooseAction, maybeCastAISpell, autoResolve, chooseAIStances } from '../core/combat/CombatAI.js';
import { getSetting } from '../game/settings.js';
import { surrenderCost, armyForDeploy } from '../core/actions.js';
import { aiLearnedSplitParts, aiStanceOddsBias, pveSplitParts } from '../core/aiMemory.js';
import { contextDefenderHero } from '../core/ronins.js';
import { battleDigest } from '../core/combat/battleDigest.js';
import {
  baseColorOf, decorTextureFor, drawTerrainTile, combatObstacleFor,
} from '../gfx/terrain.js';
import { makeCanvas } from '../gfx/canvasKit.js';
import { rgba, shade } from '../gfx/canvasKit.js';
import { hasSprite, spriteKey, heroPortrait, unitIcon, actionIconKey } from '../gfx/sprites.js';
import { panel, button, label, showDialog, modalOpen, modalAgeMs, worldClicksBlocked, blockWorldClicks, resetModals, MODAL_AUTOCLOSE_GUARD_MS, destroyAllChildren, Tooltip, fitText, fmtCount, FONT, COLORS, DEPTH } from '../ui/uikit.js';
import { openSpellbook as openSpellbookOverlay } from '../ui/spellbook.js';
import { attachBattleTelemetry, recordBattleEnd, recordHumanAction, recordHumanCast } from '../ai/battleTelemetry.js';

// Bump this whenever combat logic changes, so a pasted diagnostic tells us
// exactly which build the player is running.
export const COMBAT_BUILD = '2026-07-09a-wave-a';

// Wall-clock stall threshold. If the scene is neither finished, nor waiting on
// human input, nor making progress for this long, an animation/turn callback
// died and stranded the loop — the watchdog in update() recovers. Measured with
// performance.now(), so it survives a stalled Phaser Time.Clock (the root cause
// of the "unit stuck, battle never ends" soft-lock).
const STUCK_MS = 4000;

// How long an OPEN modal counts as a legitimate wait before the watchdog treats
// it as an orphan. Deliberately generous: a player weighing which spell to cast
// is not a stall, and STUCK_MS of reading time is no reading time at all. Past
// this, an overlay is one nobody can see or reach — and since clearing it now
// costs only the dialog (not the turn), being wrong is cheap either way.
const MODAL_PATIENCE_MS = 3 * 60 * 1000;

// --- Cosmetic tween durations (ms) ---------------------------------------
// These drive Phaser tweens/timers for looks only. Nothing here advances the
// turn loop — that is update()/_pumpAnim's job, off performance.now().
const TOAST_LIFETIME_MS = 4000;   // transient battlefield message auto-dismiss
const DEATH_FADE_MS = 300;        // dying stack fades out
const ACTIVE_RING_PULSE_MS = 500; // active-unit ring yoyo half-cycle
const MOVE_MS_PER_HEX = 90;       // move tween: per-hex step
const MOVE_MAX_MS = 600;          // move tween: clamp for long paths
const ATTACK_LUNGE_MS = 110;      // attacker lunge yoyo
const FLASH_MS = 120;             // hit-flash tint duration
const BANNER_IN_MS = 240;         // morale banner fade-in yoyo
const BANNER_HOLD_MS = 380;       // morale banner hold at peak
const DAMAGE_POPUP_MS = 900;      // floating damage number rise + fade

// --- Per-event dwell (ms) ------------------------------------------------
// How long the frame pump waits (wall-clock) before draining the next event.
// Pacing only — never load-bearing for correctness.
const DWELL_ATTACK_MS = 220;      // attack / retaliate
const DWELL_SPELLHIT_MS = 190;    // splash / spellHit
const DWELL_FIRESHIELD_MS = 160;  // fireShield
// A cast should be watchable, not a blink: the swirl runs about a second and the
// batch waits long enough to read it. A MASS cast emits one event per stack, so
// only the first pays the full dwell — the other six start their swirls a frame
// apart and the sweep plays as one gesture instead of seven queued ones.
const DWELL_SPELLEFFECT_MS = 620; // spellEffect
const DWELL_SPELLEFFECT_MASS_MS = 70;
const SPELL_SWIRL_MS = 950;
const DWELL_HEAL_MS = 220;        // heal
const DWELL_MORALE_MS = 320;      // morale / badMorale banner

// --- AI turn beat (ms) ---------------------------------------------------
// How long update() waits before firing a frame-scheduled AI turn. Snappier
// when no human is watching (observer / both-sides-AI).
const AI_BEAT_MS = 300;
const AI_BEAT_OBSERVER_MS = 80;

export class CombatScene extends Phaser.Scene {
  constructor() {
    super('Combat');
  }

  init(data) {
    this.ctx = data.ctx;
    this.onDone = data.onDone;
  }

  create() {
    const t0 = performance.now();
    const ctx = this.ctx;
    if (ctx.skirmish) {
      // Battle Gym: a self-contained fight. The ctx carries everything — its
      // own rng and two composed { hero, army, playerIndex } sides — so there
      // is no dependency on the adventure GameState.
      this.state = null;
      this.humanSide = ctx.humanSide ?? 0;
      this.terrain = ctx.terrain || 'grass';
      // Stash the rng-free config so the Battle Formations picker can Monte-Carlo
      // each stance's win probability off a clone.
      this.battleCfg = {
        terrain: this.terrain,
        attacker: ctx.attacker,
        defender: ctx.defender,
        defenseBonus: ctx.defenseBonus || 0,
        siege: ctx.fortTier ? { fortTier: ctx.fortTier } : null,
        features: ctx.features,
        upgrades: ctx.upgrades,
        humanSide: this.humanSide,
        siegeTowerDamage: getSetting('siegeTowerDamage'),
        aiStackSplit: getSetting('aiStackSplit'),
        aiSplitParts: aiLearnedSplitParts(this.state),
        // …and the wildlife spreads out by the same lesson (see aiMemory.pveSplitParts).
        pveSplitParts: pveSplitParts(this.state),
      };
      this.applyAIStance();
      this.battle = createBattle({ rng: ctx.rng, ...this.battleCfg });
      ctx.battleSeed = this.battle.seed;
      this.battleId = attachBattleTelemetry(this.battle, getState(), {
        humanSide: this.humanSide,
        owners: [ctx.attackerOwner ?? 0, ctx.defenderOwner ?? -1],
        context: 'arena',
      });
    } else {
      const s = getState();
      this.state = s;
      const attacker = s.heroes[ctx.attackerHeroId] || null;
      // A ronin commanding an otherwise leaderless defence is a real commander that
      // is deliberately not in state.heroes — contextDefenderHero knows about both.
      const defenderHero = contextDefenderHero(s, ctx);
      const attackerOwner = attacker ? attacker.owner : -1;
      let defenderOwner = -1;
      if (ctx.defender.kind === 'hero') defenderOwner = defenderHero?.owner ?? -1;
      if (ctx.defender.kind === 'town') defenderOwner = s.towns[ctx.defender.townId]?.owner ?? -1;

      this.humanSide = attackerOwner === 0 ? 0 : (defenderOwner === 0 ? 1 : -1);
      // A war-band storming a town has NO attacking hero, so there is no hero tile
      // to read the ground off — the context names it (the town's own tile).
      this.terrain = ctx.terrain
        || (attacker ? tileAt(s, attacker.x, attacker.y, attacker.z ?? 0)?.terrain || 'grass' : 'grass');

      this.battleCfg = {
        terrain: this.terrain,
        // `ctx.attackerArmy` is how a heroless attacker fields a force: a war-band
        // is a map object, not a commander, so there is no hero.army to deploy.
        attacker: {
          hero: attacker,
          army: ctx.attackerArmy ? armyForDeploy(ctx.attackerArmy) : armyForDeploy(attacker?.army),
          playerIndex: attackerOwner,
          discipline: ctx.attackerDiscipline || 0,
        },
        defender: { hero: defenderHero, army: ctx.defenderArmy, playerIndex: defenderOwner, discipline: ctx.defenderDiscipline || 0 },
        defenseBonus: ctx.defenseBonus || 0,
        siege: ctx.fortTier ? { fortTier: ctx.fortTier } : null,
        features: s.features,
        upgrades: playerUpgrades(s),
        humanSide: this.humanSide,
        siegeTowerDamage: getSetting('siegeTowerDamage'),
        aiStackSplit: getSetting('aiStackSplit'),
        aiSplitParts: aiLearnedSplitParts(this.state),
        // …and the wildlife spreads out by the same lesson (see aiMemory.pveSplitParts).
        pveSplitParts: pveSplitParts(this.state),
      };
      this.applyAIStance();
      this.battle = createBattle({ rng: s.rng, ...this.battleCfg });
      // The rng state this fight began at, stamped on the context so it is in hand
      // while the battle is still being played — a debugger or a bug report does not
      // have to wait for the result to know which battle to replay.
      ctx.battleSeed = this.battle.seed;
      // …and the same seed goes into the telemetry, which is what makes any
      // decision in the log replayable rather than merely describable.
      this.battleId = attachBattleTelemetry(this.battle, s, {
        humanSide: this.humanSide,
        owners: [attackerOwner, defenderOwner],
        context: ctx.defender?.kind || 'field',
      });
    }

    // Snapshot for the debrief: the raw event stream (filled as it animates)
    // and who started where, so battleDigest can attribute losses.
    this.combatEvents = [];
    this.combatRoster = this.battle.units.map((u) => ({
      id: u.id, side: u.side, creature: u.creature, startCount: u.startCount,
    }));

    this.tooltip = new Tooltip(this);
    this.unitSprites = new Map();
    this.activeUnit = null;
    this.activeChip = null;       // "now acting" panel chip (who holds the turn)
    this._activeChipId = null;    // unit id the chip currently shows
    this.activeMarker = null;     // bobbing chevron over the active stack
    this._ringKey = null;         // stack+hex the active ring is drawn for (skip rebuilds)
    this.targetingSpell = null;   // spellId while picking a spell target
    this.resurrectMode = false;
    this.busy = false;            // animating
    this.autoPlay = false;
    this.awaitingAI = false;      // an AI turn is scheduled but not yet running
    this._anim = null;            // in-flight animation batch, drained by update()
    this._pendingAI = null;       // { unit, at } — a frame-scheduled AI turn
    this.lastProgressAt = this.now();
    // Stall telemetry (surfaced by the L-key diagnostics). Frame-counted so a
    // paste shows how long the loop has gone without draining an event.
    this._frames = 0;             // update() ticks this every active frame
    this._lastProgressFrame = 0;  // frame index at the last markProgress()
    this._lastEventType = null;   // last anim event the pump drained
    // MUST reset per battle: Phaser reuses this scene instance, so a leftover
    // finished=true from the previous battle makes finish() no-op — the recap
    // never opens and the active-unit ring is never cleared (2nd+ battle glitch).
    // _left/_result guard the exit path (leaveBattle) the same way.
    this.finished = false;
    this._left = false;
    this._result = null;
    this.tacticsMode = false;
    this.tacticsSelId = null;
    // A battle opens with a CLEAN input gate. liveModals is global across scenes
    // and AdventureScene *sleeps* AdvUI rather than stopping it before launching
    // combat — a sleeping scene keeps its game objects, so any overlay still open
    // there stays registered and would gate every click on the battlefield for the
    // whole fight. Combat owns its own modals from here.
    resetModals();
    this.logLines = [];

    this.computeLayout();
    this.drawBackdrop();
    this.drawGrid();
    this.drawFortifications();
    this.spawnUnits();
    this.buildHUD();

    this.input.on('pointermove', (p) => this.onHover(p));
    this.input.on('pointerup', (p) => this.onClick(p));

    // Re-lay the battlefield when the canvas changes size. Without this the scene
    // keeps the geometry it was built with: the map, town, hero and HUD scenes all
    // re-layout on resize, so a window change left ONLY the battlefield at its old
    // size, drawn into a corner of a larger canvas with dead space around it —
    // reported as "half the screen goes dark and no animation happens". Measured:
    // the drawn content covered 56% x 57% of a 3440x1440 canvas while the exact
    // same battle filled it correctly when opened at that size.
    this.scale.on('resize', this.relayout, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.relayout, this);
      // The baked ground is a canvas texture in the global texture manager, which
      // outlives the scene. One battlefield's worth of pixels per battle fought is
      // a leak that only shows up after an hour of play, which is exactly the kind
      // that ships.
      if (this._groundKey && this.textures.exists(this._groundKey)) {
        this.textures.remove(this._groundKey);
      }
      this._groundKey = null;
      this._groundImg = null;
      this._groundMask = null;
    });

    // Press L any time in combat to copy a diagnostic report (build version +
    // full battle state) to the clipboard — paste it straight to support.
    this.input.keyboard?.on('keydown-L', () => this.copyDiagnostics());
    // Escape hatches: once a battle is decided, Enter/Esc/Space always leaves,
    // even if the victory dialog failed to render or respond.
    ['keydown-ENTER', 'keydown-ESC', 'keydown-SPACE'].forEach((k) =>
      this.input.keyboard?.on(k, () => { if (this.finished) this.leaveBattle(); }));
    // During the pre-battle Tactics phase, Space/Tab step the selection to the
    // next stack (capture stops Tab from moving browser focus off the canvas).
    this.input.keyboard?.addCapture('TAB,SPACE');
    this.input.keyboard?.on('keydown-TAB', () => { if (this.tacticsMode) this.cycleTacticsSelection(1); });
    this.input.keyboard?.on('keydown-SPACE', () => { if (this.tacticsMode) this.cycleTacticsSelection(1); });

    // The two halves of "how long from the click to the battle": what the ENGINE
    // spent sizing this encounter (actions.combatContext stamps it) and what this
    // scene spent building the field. Reported here because this line is already
    // the one a player pastes, and because a complaint that a particular defender
    // is slow to open is answerable from these two numbers and from nothing else.
    console.info(`[combat] START build ${COMBAT_BUILD} humanSide=${this.humanSide} ` +
      `defender=${ctx.skirmish ? 'skirmish' : (ctx.defender?.kind || '?')}` +
      `${ctx.defender?.objectId ? ' obj=' + ctx.defender.objectId : ''}` +
      `${ctx.builtMs != null ? ` sized=${ctx.builtMs}ms` : ''}` +
      ` field=${Math.round(performance.now() - t0)}ms`);
    this.beginBattle();
  }

  /**
   * Rebuild every geometry-dependent visual for the current canvas size, keeping
   * the battle itself untouched — this runs mid-fight, so it must not disturb
   * turn order, unit state or the animation queue. Only the static art and the
   * positions derived from it are redone; refreshUnits() then re-seats every
   * sprite on its hex.
   */
  relayout() {
    if (!this.battle || this.finished) return;
    // A modal is anchored to the OLD geometry and its owner is mid-interaction;
    // rebuilding under it would strand the dialog. Skip and catch the next resize.
    if (modalOpen()) return;
    try {
      // Destroy and rebuild, the pattern TownScene already uses. Redrawing in
      // place leaks: measured 32 -> 188 game objects over six size changes,
      // because each draw pass creates a fresh set without clearing the last.
      destroyAllChildren(this);
      this.unitSprites = new Map(); // the old sprites went with their children
      // The ring/chevron containers just died with everything else, but their
      // references and _ringKey survived — without this, buildActiveRing below
      // would early-return ("same stack, same hex"), leaving two infinite tweens
      // driving destroyed containers AND no visible ring until the next turn.
      this.clearActiveRing();
      this.tooltip = new Tooltip(this);
      this.computeLayout();
      this.drawBackdrop();
      this.drawGrid();
      this.drawFortifications();
      this.spawnUnits();
      this.buildHUD();
      this.refreshUnits();
      this.refreshHeroPanels();
      if (this.activeUnit) {
        this.refreshActiveIndicator(this.activeUnit);
        this.buildActiveRing();
      }
      this.updateHighlights();
      this.setButtonsEnabled(this.awaitingHumanInput());
    } catch (e) {
      // A relayout must never take the battle down with it; the old geometry is
      // ugly but playable, and the next resize gets another go.
      console.warn('[combat] relayout failed — keeping the previous layout', e);
    }
  }

  /**
   * AI Battle Formations: let the non-human side pick its fighting stance from
   * the odds BEFORE the battle is built — all-in as a clear underdog, hold as a
   * clear favorite, classic press when contested. The stance lands in battleCfg
   * so the battle is built as the AI will actually fight it. The PLAYER is never
   * shown these odds. Off (Settings → aiBattleFormations), or on any
   * estimator hiccup: no stance is set and the AI fights at classic 'press'.
   * The odds Monte-Carlo runs on fixed seeds with cloned heroes — it draws
   * nothing from the live rng and touches nothing real. A repeatedly beaten AI
   * also shades its perceived odds down (learning v3, aiStanceOddsBias): it
   * has learned this human outplays the simulator proxy, so it stops trusting
   * even fights and reaches for variance sooner. No state (Battle Gym) ⇒ no
   * memory ⇒ no shading.
   */
  applyAIStance() {
    if (!getSetting('aiBattleFormations') || this.humanSide < 0) return;
    const key = this.humanSide === 0 ? 'defender' : 'attacker';
    try {
      const stance = chooseAIStances(this.battleCfg, { winBias: aiStanceOddsBias(this.state) })[key];
      // Clone the side config rather than mutate it — in the Battle Gym it is
      // the caller's own ctx object.
      if (stance) this.battleCfg[key] = { ...this.battleCfg[key], stance };
    } catch { /* odds unavailable — fight at classic press */ }
  }

  /**
   * The Tactics skill grants a pre-battle placement phase: if the human side won
   * that phase, let them reposition their stacks within the highlighted band and
   * press Start; otherwise (AI holds it, or nobody does) lock it in and fight.
   */
  beginBattle() {
    // No pre-battle screens: the fight begins immediately at the classic 'press'
    // stance. (The AI still reads the odds and picks its own stance — see
    // chooseAIStances / applyAIStance — the PLAYER simply isn't shown a
    // probability sheet or asked to bet on the outcome.)
    this.proceedBattle();
  }

  /** Enter the Tactics placement phase if this side won it, else start fighting. */
  proceedBattle() {
    const t = this.battle.tactics;
    if (t && !t.done && t.side === this.humanSide && this.humanSide >= 0 && !this.autoPlay) {
      this.enterTacticsPhase();
    } else {
      if (t) endTactics(this.battle); // AI keeps its default deployment (v1)
      this.nextTurn();
    }
  }

  enterTacticsPhase() {
    this.tacticsMode = true;
    // Pre-select the first stack so the phase starts ready to place; Space/Tab
    // cycle to the next stack, and placing one auto-advances to the next.
    this.tacticsSelId = this.tacticsStacks()[0]?.id ?? null;
    this.setButtonsEnabled(false);
    this.tacticsBandG = this.add.graphics().setDepth(6);
    this.drawTacticsBand();
    const W = this.scale.width, H = this.scale.height;
    this.tacticsHint = label(this, W / 2, 150,
      'TACTICS — click a highlighted hex to place the selected stack · Space/Tab cycles stacks', {
        size: '14px', bold: true, color: COLORS.gold, ox: 0.5,
      }).setDepth(400);
    this.btnStartBattle = button(this, W / 2, H - 46, 200, 44, 'Start Battle',
      () => this.finishTactics(), { blue: true });
    this.btnStartBattle.setDepth(400);
  }

  /** Tint the hexes the human may place stacks in this tactics phase. */
  drawTacticsBand() {
    const g = this.tacticsBandG;
    g.clear();
    const band = tacticsBand(this.battle, this.humanSide);
    if (!band) return;
    for (let y = 0; y < BF_H; y++) {
      for (let x = band.min; x <= band.max; x++) {
        const u = unitAt(this.battle, x, y);
        if (u && u.machine) continue; // machines are fixed
        const c = this.hexCenter(x, y);
        const sel = this.tacticsSelId && u && u.id === this.tacticsSelId;
        g.fillStyle(sel ? 0xffe9a0 : 0x4f8fd0, sel ? 0.4 : 0.18);
        g.fillPoints(this.hexPoints(c.x, c.y, this.hexSize - 2), true);
        g.lineStyle(1.5, 0x8fc0ff, 0.5);
        g.strokePoints(this.hexPoints(c.x, c.y, this.hexSize - 2), true, true);
      }
    }
  }

  onTacticsClick(p) {
    const hex = this.hexAtPointer(p.x, p.y);
    if (!hex) return;
    const clicked = unitAt(this.battle, hex.x, hex.y);
    // Click your own (non-machine) stack → select it.
    if (clicked && clicked.side === this.humanSide && !clicked.machine) {
      this.tacticsSelId = clicked.id;
      playSfx('click');
      this.drawTacticsBand();
      return;
    }
    // Click a legal band hex with a stack selected → move it there.
    if (this.tacticsSelId) {
      const unit = this.battle.units.find((u) => u.id === this.tacticsSelId);
      if (unit && canPlaceTactics(this.battle, unit, hex.x, hex.y)) {
        placeTactics(this.battle, this.tacticsSelId, hex.x, hex.y);
        const spr = this.unitSprites.get(this.tacticsSelId);
        if (spr) { const c = this.hexCenter(hex.x, hex.y); spr.setPosition(c.x, c.y).setDepth(100 + hex.y); }
        playSfx('click');
        // Auto-advance to the next stack so you can place them in sequence.
        const list = this.tacticsStacks();
        const idx = list.findIndex((u) => u.id === unit.id);
        this.tacticsSelId = list.length ? list[(idx + 1) % list.length].id : null;
        this.drawTacticsBand();
      }
    }
  }

  /** The player's placeable stacks this tactics phase, in a stable order. */
  tacticsStacks() {
    return this.battle.units.filter((u) => u.side === this.humanSide && !u.machine && u.alive);
  }

  /** Cycle the tactics selection to the next placeable stack (Space / Tab) — so
   *  you can skip past a stack you'd rather not move without placing it. */
  cycleTacticsSelection(dir = 1) {
    const list = this.tacticsStacks();
    if (!list.length) return;
    const idx = list.findIndex((u) => u.id === this.tacticsSelId);
    this.tacticsSelId = (idx < 0 ? list[0] : list[(idx + dir + list.length) % list.length]).id;
    playSfx('click');
    this.drawTacticsBand();
    this.markProgress();   // the player is working; the loop is not stuck
  }

  finishTactics() {
    endTactics(this.battle);
    this.tacticsMode = false;
    this.tacticsBandG?.destroy(); this.tacticsBandG = null;
    this.tacticsHint?.destroy(); this.tacticsHint = null;
    this.btnStartBattle?.destroy(); this.btnStartBattle = null;
    this.nextTurn();
  }

  /** Human-readable snapshot of the whole battle, for bug reports. */
  diagnostics() {
    const b = this.battle;
    const u = (x) => `${x.id} ${x.creature} side${x.side} x${x.count} hp${x.hp}/${x.maxHp} ${x.alive ? 'ALIVE' : 'dead'}${b.queue[b.queueIndex] === x.id ? ' <ACTIVE>' : ''}`;
    return [
      `=== JMA3 combat diagnostics ===`,
      `build: ${COMBAT_BUILD}`,
      `over: ${b.over}   finished: ${!!this.finished}   busy: ${this.busy}   autoPlay: ${this.autoPlay}`,
      `humanSide: ${this.humanSide}   round: ${b.round}   queueIndex: ${b.queueIndex}   activeUnit: ${this.activeUnit ? this.activeUnit.id : 'none'}`,
      `alive side0: ${b.units.filter((x) => x.alive && x.side === 0).length}   alive side1: ${b.units.filter((x) => x.alive && x.side === 1).length}`,
      // Stall telemetry: if a callback died and stranded the loop, these tell
      // us where — a growing framesSinceProgress with busy=true is the tell.
      `stall: framesSinceProgress ${(this._frames ?? 0) - (this._lastProgressFrame ?? 0)}   animQueueDepth ${this._anim ? this._anim.events.length - this._anim.i : 0}   busy ${this.busy}   pendingAI ${!!this._pendingAI}   lastEvent ${this._lastEventType || 'none'}`,
      `queue: [${b.queue.join(', ')}]`,
      `units:`,
      ...b.units.map((x) => '  ' + u(x)),
      `recent log:`,
      ...this.logLines.map((l) => '  ' + l),
      `===============================`,
    ].join('\n');
  }

  copyDiagnostics() {
    const text = this.diagnostics();
    console.log(text); // always available via F12 console
    try {
      navigator.clipboard?.writeText(text)
        .then(() => this.toast('Battle diagnostics copied — paste them to Claude (also in console: F12).'))
        .catch(() => this.toast('Diagnostics printed to the console (F12) — copy from there.'));
    } catch {
      this.toast('Diagnostics printed to the console (F12) — copy from there.');
    }
  }

  /** Small transient message near the bottom of the battlefield. */
  toast(text) {
    this._toast?.destroy();
    this._toast = this.add.text(this.scale.width / 2, this.scale.height - 96, text, {
      fontFamily: FONT, fontSize: '14px', color: '#f4edda',
      backgroundColor: 'rgba(14,12,24,0.9)', padding: { x: 12, y: 7 },
    }).setOrigin(0.5).setDepth(DEPTH.HUD);
    const t = this._toast;
    this.time.delayedCall(TOAST_LIFETIME_MS, () => { if (t === this._toast) { t.destroy(); this._toast = null; } });
  }

  // ------------------------------------------------------------------
  // Layout & drawing
  // ------------------------------------------------------------------

  computeLayout() {
    const W = this.scale.width, H = this.scale.height;
    // Field starts below the hero panels (y 70..166) so panel clicks can
    // never land on row-0 hexes.
    const fieldTop = 178;
    const availW = W - 60, availH = H - fieldTop - 130;
    this.hexSize = Math.min(availW / (Math.sqrt(3) * (BF_W + 0.6)), availH / (1.5 * BF_H + 0.6), 34);
    this.hexW = Math.sqrt(3) * this.hexSize;
    const fieldW = this.hexW * (BF_W + 0.5);
    const fieldH = this.hexSize * (1.5 * BF_H + 0.5);
    this.ox = (W - fieldW) / 2;
    this.oy = fieldTop + Math.max(0, (availH - fieldH) / 2);
  }

  hexCenter(x, y) {
    return {
      x: this.ox + this.hexW * (x + 0.5 * (y & 1)) + this.hexW / 2,
      y: this.oy + this.hexSize * 1.5 * y + this.hexSize,
    };
  }

  hexAtPointer(px, py) {
    // brute force: closest center within one hex
    let best = null, bestD = Infinity;
    for (let y = 0; y < BF_H; y++) {
      for (let x = 0; x < BF_W; x++) {
        const c = this.hexCenter(x, y);
        const d = Math.hypot(px - c.x, py - c.y);
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
    }
    return bestD <= this.hexSize * 1.05 ? best : null;
  }

  drawBackdrop() {
    const W = this.scale.width, H = this.scale.height;
    // Authentic HoMM3 battle backdrop, if the user's assets provided one.
    const bgKey = `battlebg_${this.terrain}`;
    if (this.textures.exists(bgKey)) {
      const img = this.add.image(W / 2, this.oy + (this.hexSize * 1.5 * BF_H) / 2, bgKey).setDepth(0);
      const src = this.textures.get(bgKey).getSourceImage();
      const scale = Math.max(W / src.width, (this.hexSize * 1.5 * BF_H + 120) / src.height);
      img.setScale(scale);
      // darken the top so the header/panels stay readable
      this.add.rectangle(W / 2, 90, W * 2, 180, 0x0a0a14, 0.35).setDepth(0);
      return;
    }
    // A bespoke open-sea backdrop for naval battles — waves, glare and a
    // haze horizon instead of the generic ground+hills below.
    if (this.terrain === 'water') { this.drawSeaBackdrop(W, H); return; }
    const g = this.add.graphics().setDepth(0);
    const ground = baseColorOf(this.terrain);
    const skyTop = this.terrain === 'lava' ? 0x241016 : 0x1c2440;
    const skyBot = this.terrain === 'lava' ? 0x552018 : 0x51557c;
    const horizon = this.oy - 30;
    for (let i = 0; i < 20; i++) {
      const t = i / 20;
      g.fillStyle(Phaser.Display.Color.GetColor(
        ...lerpColor(skyTop, skyBot, t),
      ), 1);
      g.fillRect(0, (horizon * i) / 20, W, horizon / 20 + 2);
    }
    for (let i = 0; i < 16; i++) {
      const t = i / 16;
      g.fillStyle(Phaser.Display.Color.GetColor(
        ...lerpColor(shade(ground, 0.1), shade(ground, -0.35), t),
      ), 1);
      g.fillRect(0, horizon + ((H - horizon) * i) / 16, W, (H - horizon) / 16 + 2);
    }
    // distant hills
    g.fillStyle(shade(ground, -0.5), 0.5);
    g.beginPath();
    g.moveTo(0, horizon);
    for (let x = 0; x <= W; x += 60) {
      g.lineTo(x, horizon - 14 - 18 * Math.abs(Math.sin(x * 0.008 + 2)));
    }
    g.lineTo(W, horizon);
    g.closePath();
    g.fillPath();
  }

  /**
   * Open-sea backdrop (naval battles only): a hazy sky over teal-to-navy water,
   * a bright sun-glare band at the waterline, and receding wave crests that grow
   * as they near the viewer. One drifting glimmer strip gives a little motion
   * without any per-frame redraw (a single looping tween on a pre-drawn strip).
   */
  drawSeaBackdrop(W, H) {
    const g = this.add.graphics().setDepth(0);
    const horizon = this.oy - 30;
    // Sky: deep blue high up softening to a pale sea haze at the horizon.
    const skyTop = 0x27405f, skyBot = 0x9cc0dc;
    for (let i = 0; i < 20; i++) {
      g.fillStyle(Phaser.Display.Color.GetColor(...lerpColor(skyTop, skyBot, i / 20)), 1);
      g.fillRect(0, (horizon * i) / 20, W, horizon / 20 + 2);
    }
    // Sea: teal at the horizon deepening to navy at the near edge.
    const seaFar = 0x357a90, seaNear = 0x0d2740;
    for (let i = 0; i < 18; i++) {
      g.fillStyle(Phaser.Display.Color.GetColor(...lerpColor(seaFar, seaNear, i / 18)), 1);
      g.fillRect(0, horizon + ((H - horizon) * i) / 18, W, (H - horizon) / 18 + 2);
    }
    // Sun glare on the waterline.
    g.fillStyle(0xcfeaf6, 0.4);
    g.fillRect(0, horizon - 2, W, 3);
    // Receding wave crests: sine ribbons, wider and taller as they approach.
    for (let row = 0; row < 8; row++) {
      const t = row / 8;
      const y = horizon + (H - horizon) * (0.05 + t * 0.92);
      const amp = 2 + t * 6, step = 26 + t * 30;
      g.lineStyle(1 + t * 1.6, 0xa8d6ea, 0.08 + t * 0.14);
      g.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const yy = y + Math.sin(x / step + row * 1.7) * amp;
        if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
      }
      g.strokePath();
    }
    // One wide drifting glimmer strip (pre-drawn, tweened — no redraw cost).
    const strip = this.add.graphics().setDepth(0);
    strip.fillStyle(0xbfe6f2, 0.10);
    for (let x = -W; x < W * 2; x += 46) {
      const yy = horizon + (H - horizon) * 0.5 + Math.sin(x / 40) * 6;
      strip.fillCircle(x, yy, 3);
    }
    strip.x = 0;
    const drift = this.tweens.add({ targets: strip, x: 46, duration: 2600, repeat: -1, ease: 'Linear' });
    // relayout() destroys the strip and calls drawBackdrop() again, and Phaser
    // does not kill a tween when its target dies — without this hook a naval
    // battle accumulated one forever-running tween per window resize, each
    // driving a detached Graphics that the tween's target reference kept alive
    // (measured: +1 per relayout). Same idiom as AdventureScene's portal pulse.
    strip.once('destroy', () => drift.remove());
  }

  hexPoints(cx, cy, size) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 3 * i + Math.PI / 6;
      pts.push(new Phaser.Geom.Point(cx + size * Math.cos(a), cy + size * Math.sin(a)));
    }
    return pts;
  }

  /**
   * The floor the battle is fought on: the SAME terrain art the adventure map
   * paints, baked once and blitted under the grid.
   *
   * The battlefield used to be a two-tone shaded checkerboard — `fillPoints` at
   * one colour for odd cells and another for even — which is the "tiles are
   * schematic" half of the report. The map has had real ground for a long time
   * (`terrain.drawTerrainTile`: mottling, grain, a terrain-specific flourish,
   * flora specks) and the combat screen simply never used it.
   *
   * Free upgrade path, and this is the reason to route through drawTerrainTile
   * rather than to draw something bespoke here: it already prefers a generated
   * `sprite_terrain_<t>` raster over its procedural tile, so an art pack replaces
   * the battlefield floor along with the map's, with no code change. That is what
   * "replace them with sprites" asks for.
   *
   * NOT for water. The sea has a bespoke swell (below) and its own backdrop; it was
   * never the schematic case, and blitting a flat water tile over it would be a
   * downgrade.
   */
  drawGroundTexture() {
    if (this.terrain === 'water') return;
    const W = Math.ceil(this.hexW * (BF_W + 1));
    const H = Math.ceil(this.hexSize * (1.5 * BF_H + 1.5));
    if (!(W > 0 && H > 0)) return;
    // Tiles at roughly a hex across, so the terrain's own grain sits at the scale
    // the map shows it at rather than being stretched over the whole field.
    const T = Math.max(24, Math.round(this.hexSize * 1.6));
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < H; y += T) {
      for (let x = 0; x < W; x += T) {
        // A per-tile seed off the tile's own position: the same field every time it
        // is redrawn, and neighbours that differ.
        drawTerrainTile(ctx, x, y, T, this.terrain, ((x * 73856093) ^ (y * 19349663)) >>> 8);
      }
    }
    // Keyed per scene run and destroyed on shutdown: the field is re-baked on every
    // relayout, and leaving the old canvases in the texture manager would leak one
    // battlefield's worth of pixels per resize.
    this._groundKey = `combatGround_${this.terrain}_${W}x${H}`;
    if (this.textures.exists(this._groundKey)) this.textures.remove(this._groundKey);
    this.textures.addCanvas(this._groundKey, canvas);
    this._groundImg?.destroy();
    this._groundImg = this.add.image(this.ox - this.hexW / 2, this.oy - this.hexSize)
      .setOrigin(0).setDepth(1);
    this._groundImg.setTexture(this._groundKey);

    // Masked to the HEXES, not left as a rectangle of turf laid on the backdrop.
    // A baked canvas is rectangular and the field is not, so unmasked it drew a
    // hard-edged slab with visible corners — the ground stopped being scenery and
    // became a panel. Clipping it to the playable hexes gives the field its own
    // ragged edge, which is also the honest outline of where a unit may stand.
    this._groundMask?.destroy();
    const m = this.add.graphics().setVisible(false);
    m.fillStyle(0xffffff, 1);
    for (let y = 0; y < BF_H; y++) {
      for (let x = 0; x < BF_W; x++) {
        const c = this.hexCenter(x, y);
        // A hair over the hex radius so neighbouring hexes overlap and the mask has
        // no hairline seams between them.
        m.fillPoints(this.hexPoints(c.x, c.y, this.hexSize + 0.5), true);
      }
    }
    this._groundMask = m;
    this._groundImg.setMask(m.createGeometryMask());
  }

  drawGrid() {
    this.drawGroundTexture();
    this.gridG = this.add.graphics().setDepth(5);
    this.highlightG = this.add.graphics().setDepth(6);
    const g = this.gridG;
    const water = this.terrain === 'water';
    const textured = !!this._groundImg;
    const ground = baseColorOf(this.terrain);
    for (let y = 0; y < BF_H; y++) {
      for (let x = 0; x < BF_W; x++) {
        const c = this.hexCenter(x, y);
        const pts = this.hexPoints(c.x, c.y, this.hexSize - 1);
        if (water) {
          // A rolling swell: a smooth wave value per hex gives crest (lighter)
          // and trough (darker) cells, so the grid reads as open water rather
          // than a flat checkerboard. Faint foam edges, a fleck on the crests.
          const wave = 0.5 * Math.sin(x * 0.9 + y * 0.6) + 0.5 * Math.sin((x - y) * 0.55);
          g.fillStyle(shade(ground, -0.16 + wave * 0.13), 0.9);
          g.fillPoints(pts, true);
          g.lineStyle(1, 0x9fd8ea, 0.16);
          g.strokePoints(pts, true, true);
          if (wave > 0.65) {
            g.fillStyle(0xe1f4fb, 0.45);
            g.fillCircle(c.x - this.hexSize * 0.18, c.y - this.hexSize * 0.14, this.hexSize * 0.07);
          }
        } else if (textured) {
          // Over real ground the cell fill becomes a WASH, not a coat: enough of a
          // checker to keep the hexes countable at a glance (which is what the fill
          // was always for — targeting), little enough that the terrain under it is
          // the thing you see. The outline does the rest of the work.
          g.fillStyle((x + y) % 2 ? 0x000000 : 0xffffff, 0.055);
          g.fillPoints(pts, true);
          g.lineStyle(1.2, shade(ground, -0.5), 0.38);
          g.strokePoints(pts, true, true);
        } else {
          g.fillStyle(shade(ground, ((x + y) % 2 ? -0.16 : -0.1)), 0.92);
          g.fillPoints(pts, true);
          g.lineStyle(1.4, shade(ground, -0.45), 0.5);
          g.strokePoints(pts, true, true);
        }
      }
    }
    // obstacles: reefs at sea (a rock cluster ringed in foam), boulders and
    // thickets on land (see obstacleArt).
    for (const o of this.battle.obstacles) {
      const c = this.hexCenter(o.x, o.y);
      if (water) { this.drawReef(g, c); continue; }
      const pts = this.hexPoints(c.x, c.y, this.hexSize - 1);
      // A soft shadow pooled under the obstacle rather than a flat black hex: the
      // ground texture below is worth seeing, and an opaque cell hid it.
      g.fillStyle(shade(ground, -0.5), 0.55);
      g.fillPoints(pts, true);
      this.drawObstacle(c, o);
    }
  }

  /**
   * One obstacle: a generated sprite when the pack has one, else the procedural
   * decor sheet — the same three-tier resolve the reef and the units already use,
   * so a drop-in art pack upgrades the battlefield without a code change.
   */
  drawObstacle(c, o) {
    const { kind, seed } = combatObstacleFor(o.x, o.y, this.terrain);
    const s = this.hexSize;
    const spriteId = `obstacle_${kind}`;
    if (hasSprite(this, spriteId)) {
      const img = this.add.image(c.x, c.y - s * 0.18, spriteKey(spriteId)).setDepth(6);
      img.setScale(Math.min((s * 1.9) / img.width, (s * 1.9) / img.height));
      if (seed & 1) img.setFlipX(true);
      return;
    }
    const key = decorTextureFor(kind, this.terrain, seed);
    if (!this.textures.exists(key)) return; // a pack-less build without decor baked
    // Size to the hex rather than to a fixed 38px: at small hexes the old constant
    // scale left the rock overflowing its own cell.
    const img = this.add.image(c.x, c.y - s * 0.18, key).setDepth(6);
    const want = s * (kind === 'tree' ? 1.85 : 1.5);
    img.setScale(Math.min(want / img.width, want / img.height));
    // A little jitter so a row of boulders is not a row of one boulder. Bounded
    // tightly — this is variety, not chaos, and the silhouette still has to read
    // as "this hex is blocked" at a glance.
    img.setScale(img.scaleX * (0.88 + ((seed >>> 8) % 25) / 100));
    if (seed & 1) img.setFlipX(true);
  }

  /** A reef obstacle at sea: a bright foam ring around a chunky dark crag. */
  drawReef(_g, c) {
    const s = this.hexSize;
    if (hasSprite(this, 'reef')) { // prefer a generated reef sprite when present
      const img = this.add.image(c.x, c.y - s * 0.1, spriteKey('reef')).setDepth(6);
      img.setScale(Math.min((s * 2) / img.width, (s * 2) / img.height));
      return;
    }
    const base = c.y + s * 0.2; // the waterline the rock rises from
    const r = this.add.graphics().setDepth(6);
    // A dark submerged shadow, a bright foam collar, then dark water inside it.
    r.fillStyle(0x0a1c30, 0.5); r.fillEllipse(c.x, base + s * 0.04, s * 1.28, s * 0.58);
    r.fillStyle(0xe6f5fb, 0.6); r.fillEllipse(c.x, base, s * 1.08, s * 0.44);
    r.fillStyle(0x123049, 0.92); r.fillEllipse(c.x, base, s * 0.8, s * 0.3);
    // Chunky crags breaking the surface (jagged, not thin fins).
    const crag = (dx, w, top, col) => {
      r.fillStyle(col, 1);
      r.beginPath();
      r.moveTo(c.x + dx - w, base);
      r.lineTo(c.x + dx - w * 0.5, base - top * 0.78);
      r.lineTo(c.x + dx - w * 0.05, base - top);
      r.lineTo(c.x + dx + w * 0.5, base - top * 0.68);
      r.lineTo(c.x + dx + w, base);
      r.closePath(); r.fillPath();
    };
    crag(s * 0.28, s * 0.3, s * 0.46, 0x2b343e);   // smaller rock behind
    crag(-s * 0.04, s * 0.5, s * 0.74, 0x39444f);  // main rock
    // Spray-lit edge on the main rock.
    r.fillStyle(0x9fb8c6, 0.85);
    r.fillTriangle(
      c.x - s * 0.16, base - s * 0.22,
      c.x - s * 0.06, base - s * 0.66,
      c.x + s * 0.04, base - s * 0.3,
    );
  }

  /**
   * Siege fortifications: the moat band and the destructible curtain wall (the
   * Catapult renders as an ordinary unit token). Wall segments are kept in
   * this.wallSprites (by id) so a 'wallHit' can shake one and a breach can crumble
   * it. Purely cosmetic — the engine's battle.walls/moat drive everything.
   */
  drawFortifications() {
    this.wallSprites = new Map();
    const b = this.battle;
    if (!b.walls) return;
    const s = this.hexSize;
    // Moat: a dark, wet band in front of the wall. Drawn just above the grid
    // fill (depth 5) so it reads; the reachable-hex highlight (depth 6) still
    // shows over it.
    if (b.moat) {
      const mg = this.add.graphics().setDepth(5);
      for (const m of b.moat) {
        const c = this.hexCenter(m.x, m.y);
        mg.fillStyle(0x241a10, 0.85);
        mg.fillPoints(this.hexPoints(c.x, c.y, s - 1), true);
        mg.fillStyle(0x3a2c18, 0.7);
        mg.fillEllipse(c.x, c.y, s * 1.1, s * 0.5);
        mg.lineStyle(2, 0x0c0a06, 0.8);
        mg.strokePoints(this.hexPoints(c.x, c.y, s - 1), true, true);
      }
    }
    // Wall segments: chunky stone blocks; the gate is timbered with a portcullis.
    // An ordered art pack can drop in `sprite_siege_wall` / `sprite_siege_gate`
    // rasters (see scripts/sprites/manifest); otherwise the procedural masonry
    // below is the floor. Either way the segment lives in one container so a
    // 'wallHit' can shake/crumble it uniformly.
    for (const w of b.walls) {
      // A breached segment is rubble: the engine only flags it (`alive: false`,
      // it never leaves b.walls), and mid-battle the 'wallHit' handler crumbles
      // and destroys its sprite. This runs again on every relayout() (window
      // resize), so without the same filter a resize rebuilt full-opacity
      // masonry over a breach the attackers then appeared to walk through.
      if (!w.alive) continue;
      const c = this.hexCenter(w.x, w.y);
      const cont = this.add.container(c.x, c.y).setDepth(90 + w.y);
      const rasterId = w.kind === 'gate' ? 'siege_gate' : 'siege_wall';
      if (hasSprite(this, rasterId)) {
        const img = this.add.image(0, -s * 0.05, spriteKey(rasterId));
        img.setDisplaySize(s * 1.7, s * 1.95);
        cont.add(img);
      } else {
        const stone = w.kind === 'gate' ? 0x6b5636 : 0x8a8577;
        const g = this.add.graphics();
        g.fillStyle(Phaser.Display.Color.ValueToColor(stone).color, 1);
        g.fillRoundedRect(-s * 0.82, -s * 0.95, s * 1.64, s * 1.9, 4);
        g.lineStyle(2, 0x2a2620, 0.9);
        g.strokeRoundedRect(-s * 0.82, -s * 0.95, s * 1.64, s * 1.9, 4);
        // A couple of mortar courses / crenellations so it reads as masonry.
        g.lineStyle(1.5, 0x2a2620, 0.5);
        g.beginPath(); g.moveTo(-s * 0.82, -s * 0.2); g.lineTo(s * 0.82, -s * 0.2);
        g.moveTo(-s * 0.82, s * 0.45); g.lineTo(s * 0.82, s * 0.45); g.strokePath();
        g.fillStyle(0x2a2620, 0.9);
        for (const dx of [-0.5, 0, 0.5]) g.fillRect(s * (dx - 0.16), -s * 0.95, s * 0.32, s * 0.22);
        if (w.kind === 'gate') { // portcullis bars
          g.lineStyle(2, 0x3a2c18, 1);
          for (const dx of [-0.4, 0, 0.4]) { g.beginPath(); g.moveTo(s * dx, -s * 0.6); g.lineTo(s * dx, s * 0.7); g.strokePath(); }
        }
        cont.add(g);
      }
      this.wallSprites.set(w.id, cont);
    }
  }

  spawnUnits() {
    // The living only. This runs mid-battle from relayout() (window resize),
    // where the flat battle.units still holds every corpse on the hex it died
    // on — possibly under a live stack that has since moved there. Spawning
    // them popped each dead stack back at full alpha (count label 0) for
    // refreshUnits to fade out all over again. refreshUnits already has this
    // filter for mid-battle arrivals; a later revival re-enters through it.
    for (const u of this.battle.units) {
      if (!u.alive) continue;
      this.spawnUnitSprite(u);
    }
  }

  spawnUnitSprite(u) {
    const c = this.hexCenter(u.x, u.y);
    const cont = this.add.container(c.x, c.y).setDepth(100 + u.y);
    const sc = (this.hexSize * 1.9) / 64;
    const shadow = this.add.ellipse(0, this.hexSize * 0.55, this.hexSize * 1.3, this.hexSize * 0.4, 0x000000, 0.3);
    // Prefer a full-body raster sprite when one was generated; stand it on the
    // hex (feet by the count band). Falls back to the procedural medallion token.
    let img;
    if (hasSprite(this, u.creature)) {
      img = this.add.image(0, this.hexSize * 0.52, spriteKey(u.creature)).setOrigin(0.5, 1);
      img.setScale((this.hexSize * 2.25) / img.height);
    } else {
      img = this.add.image(0, -this.hexSize * 0.25, `token_${u.creature}`).setScale(sc);
    }
    if (u.side === 1) img.setFlipX(true);
    // side band under the count
    const bandColor = u.side === 0 ? 0x2f6fd0 : 0xc23b2b;
    const plateW = Math.max(26, this.hexSize * 0.95);
    const plate = this.add.rectangle(0, this.hexSize * 0.52, plateW, 15, 0x0d0b16, 0.92)
      .setStrokeStyle(1.5, bandColor, 1);
    const count = this.add.text(0, this.hexSize * 0.52, `${u.count}`, {
      fontFamily: FONT, fontSize: '12px', fontStyle: 'bold', color: '#ffe9b0',
    }).setOrigin(0.5);
    cont.add([shadow, img, plate, count]);
    cont.img = img;
    cont.countLabel = count;
    cont.plate = plate;
    cont.bandColor = bandColor;   // what the plate returns to when the magic lapses
    // War machines aren't a "stack" — no troop count under a lone Ballista/Tent.
    if (u.machine) { plate.setVisible(false); count.setVisible(false); }
    this.unitSprites.set(u.id, cont);
    return cont;
  }

  refreshUnits() {
    // Any unit the engine has that we have no sprite for is a MID-BATTLE arrival
    // (a summon, a spawned remnant). Without this it would fight invisibly.
    for (const u of this.battle.units) {
      if (u.alive && !this.unitSprites.has(u.id)) this.spawnUnitSprite(u);
    }
    for (const [id, spr] of this.unitSprites) {
      const u = this.battle.units.find((x) => x.id === id);
      if (!u) { spr.destroy(); this.unitSprites.delete(id); continue; }
      if (!u.alive) {
        this.tweens.add({ targets: spr, alpha: 0, duration: DEATH_FADE_MS, onComplete: () => spr.setVisible(false) });
        continue;
      }
      // A stack that is alive MUST be visible. It may have been faded out when it
      // died and then come back — a Phoenix rising from its ashes (rebirth), an
      // Archangel's resurrection, a healed corpse. The death fade left alpha 0
      // and a queued onComplete that hides the sprite, so a reborn stack kept
      // fighting from an apparently empty tile: it attacked, shooters could still
      // click its hex, but there was nothing to see and no way to judge a melee
      // approach. Kill the pending fade and restore it.
      this.tweens.killTweensOf(spr);
      if (spr.alpha < 1 || !spr.visible) spr.setAlpha(1).setVisible(true);
      const c = this.hexCenter(u.x, u.y);
      spr.setPosition(c.x, c.y).setDepth(100 + u.y);
      spr.countLabel.setText(`${u.count}`);
      this.refreshPlate(u);
    }
    this.refreshHeroPanels();
  }

  // ------------------------------------------------------------------
  // HUD
  // ------------------------------------------------------------------

  buildHUD() {
    const W = this.scale.width, H = this.scale.height;
    // header
    panel(this, -8, -10, W + 16, 64);
    const name0 = this.sideName(0), name1 = this.sideName(1);
    label(this, W / 2, 12, `${name0}   ⚔   ${name1}`, { size: '19px', bold: true, color: COLORS.gold, ox: 0.5 });
    this.roundLabel = label(this, W / 2, 36, '', { size: '12px', color: COLORS.dim, ox: 0.5 });

    // hero panels
    this.heroPanels = [];
    this._manaSeen = {}; // per-battle mana watchdog baseline (see refreshHeroPanels)
    [0, 1].forEach((side) => {
      const hero = this.battle.sides[side].hero;
      const x = side === 0 ? 12 : W - 232;
      panel(this, x, 70, 220, 96);
      if (hero) {
        heroPortrait(this, hero, x + 36, 118, 56);
        label(this, x + 72, 84, hero.name, { size: '14px', bold: true, color: COLORS.gold });
        const stats = label(this, x + 72, 104, '', { size: '11px' });
        const mana = label(this, x + 72, 124, '', { size: '11px', color: '#9ab8f0' });
        const castNote = label(this, x + 72, 142, '', { size: '10px', color: COLORS.dim });
        this.heroPanels[side] = { stats, mana, castNote, hero };
      } else {
        label(this, x + 16, 108, side === 0 ? (this.ctx.attackerName || 'Attackers')
          : (this.ctx.defenderName || 'Wild creatures'), { size: '13px', color: COLORS.parchment });
        this.heroPanels[side] = null;
      }
    });
    this.refreshHeroPanels();

    // action bar — pictogram buttons: the icon carries the meaning, the name is a
    // hover tooltip (iconOnly), and the pictograms are drawn large so the bar
    // reads at a glance. Compact square buttons laid out in three clusters.
    const by = H - 46;
    const aicon = (name) => actionIconKey(this, name);
    const IS = 32;               // pictogram size on a 46px-tall button
    const BW = 56, BH = 46;      // square-ish icon buttons
    const step = BW + 8;         // centre-to-centre spacing within a cluster
    const iconBtn = (x, name, tip, onClick, o = {}) =>
      button(this, x, by, BW, BH, name, onClick,
        { iconTexture: aicon(name), iconSize: IS, iconOnly: true, tooltip: tip, ...o });
    // Central cluster: Wait · Defend · Spell · Revive, centred on the field.
    const c0 = W / 2 - step * 1.5;
    this.btnWait = iconBtn(c0, 'wait', 'Wait — act later this round', () => this.humanAct({ type: 'wait' }));
    this.btnDefend = iconBtn(c0 + step, 'defend', 'Defend — brace for reduced damage', () => this.humanAct({ type: 'defend' }));
    this.btnSpell = iconBtn(c0 + step * 2, 'spellbook', 'Spellbook — cast a spell', () => this.openSpellbook(), { blue: true });
    this.btnAbility = iconBtn(c0 + step * 3, 'resurrect', 'Resurrect fallen allies', () => {
      this.resurrectMode = !this.resurrectMode;
      this.updateHighlights();
    }, { blue: true });
    this.btnAuto = iconBtn(W - 40, 'auto', 'Auto — let the AI play this side', () => {
      this.autoPlay = !this.autoPlay;
      this.btnAuto.label?.setText(this.autoPlay ? 'Manual' : 'Auto'); // label is null (iconOnly) — guard it
      this.btnAuto.icon?.setTint(this.autoPlay ? 0xffe27a : 0xffffff); // gold tint marks the "on" state
      // Only take over a HUMAN unit's pending turn: enemy units already have
      // a queued delayedCall — kicking them again would act twice.
      if (this.autoPlay && this.activeUnit && !this.busy &&
          this.activeUnit.side === this.humanSide) {
        this.playAITurnFor(this.activeUnit);
      }
    });
    // Quick-resolve (instant) + escape actions. Retreat/Surrender need a hero to
    // save; Quick is offered in any human battle. The scene instance is REUSED
    // across battles (see create's reset block), so null these conditionally-built
    // buttons FIRST: a later battle that doesn't recreate one — e.g. a garrison
    // defence with no hero after a hero battle — must not leave a STALE destroyed
    // button for setButtonsEnabled to re-enable (its bg has no scene, so
    // setTexture throws "reading 'sys'"). `?.` skips null, but not a dead object.
    this.btnQuick = this.btnFlee = this.btnSurrender = null;
    if (this.humanSide >= 0) {
      this.btnQuick = iconBtn(W - 40 - step, 'quick', 'Quick — resolve the battle instantly', () => this.quickResolve(), { blue: true });
      if (this.battle.sides[this.humanSide]?.hero) {
        this.btnFlee = iconBtn(40, 'retreat', 'Retreat — flee, losing this army', () => this.tryEscape('retreat'));
        this.btnSurrender = iconBtn(40 + step, 'surrender', 'Surrender — pay gold to keep your army', () => this.tryEscape('surrender'));
      }
    }
    // combat log
    this.logText = this.add.text(14, H - 120, '', {
      fontFamily: FONT, fontSize: '12px', color: '#cfc7b8', lineSpacing: 3,
    }).setDepth(500);
    this.setButtonsEnabled(false);
  }

  sideName(side) {
    const hero = this.battle.sides[side].hero;
    if (hero) return hero.name;
    if (side === 1) return this.ctx.defenderName || 'Defenders';
    // A heroless ATTACKER is a war-band storming a town — named for its people, so
    // the banner reads "Vurgoth Kin — Pikemen ⚔ Sunhold" and not "Attackers".
    return this.ctx.attackerName || 'Attackers';
  }

  /**
   * The "NOW ACTING" chip docked at the bottom of the acting side's hero panel:
   * the active stack's own picture + count, framed in its side colour. It gives
   * an at-a-glance confirmation of who holds the turn even when the battlefield
   * ring is hard to spot — and it moves to whichever side is acting.
   */
  refreshActiveIndicator(unit) {
    if (!unit) return;
    if (this._activeChipId === unit.id && this.activeChip) return; // already shown
    this._activeChipId = unit.id;
    this.activeChip?.destroy();
    const W = this.scale.width;
    const px = unit.side === 0 ? 12 : W - 232;
    // Below the hero panel (which spans y 70..166) so it never overlaps the
    // hero's stats — it sits in the empty side margin beside the battlefield.
    const cy = 200;
    const sideColor = unit.side === 0 ? 0x2f6fd0 : 0xc23b2b;
    const chip = this.add.container(0, 0).setDepth(520);
    const bar = this.add.rectangle(px + 110, cy, 210, 34, 0x0d0b16, 0.92)
      .setStrokeStyle(2, 0xffe9a0, 0.95);
    const frame = this.add.rectangle(px + 24, cy, 30, 30, sideColor, 0.2)
      .setStrokeStyle(2, sideColor, 1);
    const icon = unitIcon(this, unit.creature, px + 24, cy, 26);
    if (unit.side === 1 && icon.setFlipX) icon.setFlipX(true);
    const cname = CREATURES[unit.creature]?.name || unit.creature;
    const tag = this.add.text(px + 46, cy - 8, 'NOW ACTING', {
      fontFamily: FONT, fontSize: '8px', fontStyle: 'bold', color: '#e8c060',
    }).setOrigin(0, 0.5);
    // Compact the count and hard-fit the line: the chip's bar is a fixed 210px,
    // so "Royal Griffins ×111111111" used to run straight out of it.
    const txt = this.add.text(px + 46, cy + 6, `${cname}  ×${fmtCount(unit.count)}`, {
      fontFamily: FONT, fontSize: '12px', fontStyle: 'bold', color: '#ffe9b0',
    }).setOrigin(0, 0.5);
    fitText(txt, 150);
    chip.add([bar, frame, icon, tag, txt]);
    this.activeChip = chip;
  }

  refreshHeroPanels() {
    this._manaSeen ||= {};
    [0, 1].forEach((side) => {
      const p = this.heroPanels?.[side];
      if (!p) return;
      const h = p.hero;
      // Mana watchdog (YOUR side only): castLogged re-baselines _manaSeen on every
      // legitimate spend, so any OTHER change to your hero's mana between renders
      // is a leak (a preview sim mutating the live hero, a stray tick) and gets a
      // visible ledger line instead of vanishing silently. Restricted to the human
      // side — the enemy's own casts and imp siphons are legitimate and separately
      // logged, so policing them would only cry wolf. Skip the first render.
      if (side === this.humanSide) {
        const seen = this._manaSeen[side];
        if (seen != null && h.mana !== seen) {
          const d = seen - h.mana;
          this.log(`⚠ ${h.name} mana ${seen} → ${h.mana} (${d > 0 ? '−' : '+'}${Math.abs(d)}, no cast)`);
        }
        this._manaSeen[side] = h.mana;
      }
      p.stats.setText(`Atk ${heroStat(h, 'attack')}  Def ${heroStat(h, 'defense')}  Pow ${heroStat(h, 'power')}  Know ${heroStat(h, 'knowledge')}`);
      p.mana.setText(`Mana ${h.mana}/${heroMaxMana(h)}`);
      p.castNote.setText(this.battle.sides[side].castThisRound ? 'Spell cast this round' : '');
    });
    this.roundLabel?.setText(`Round ${this.battle.round}`);
  }

  setButtonsEnabled(on) {
    const u = this.activeUnit;
    this.btnWait?.setEnabled(on && !!u && !u.hasWaitedFlag);
    this.btnDefend?.setEnabled(on && !!u);
    const canCastNow = on && u && this.humanSide >= 0 &&
      this.battle.sides[this.humanSide]?.hero &&
      !this.battle.sides[this.humanSide].castThisRound &&
      (this.battle.sides[this.humanSide].hero.spells || []).some((id) => SPELLS[id] && !SPELLS[id].adventure);
    this.btnSpell?.setEnabled(!!canCastNow);
    const res = on && u && ability(u, 'resurrectAllies') && !u.resurrectUsed;
    this.btnAbility?.setEnabled(!!res);
    // Escape only at the start of your own unit's turn (like HoMM3); Quick any time it's your move.
    this.btnQuick?.setEnabled(on && !this.busy);
    this.btnFlee?.setEnabled(on && !!u);
    this.btnSurrender?.setEnabled(on && !!u);
  }

  /** The human side's current living stacks (for surrender pricing). */
  humanArmyNow() {
    return this.battle.units
      .filter((u) => u.side === this.humanSide && u.alive && u.count > 0)
      .map((u) => ({ creature: u.creature, count: u.count }));
  }

  playerGold() {
    const owner = this.battle.sides[this.humanSide]?.hero?.owner;
    const s = getState();
    return (owner != null && s?.players?.[owner]?.resources?.gold) || 0;
  }

  /** Instant one-click resolve of the rest of the battle (both sides on AI). */
  quickResolve() {
    if (this.finished || this.busy || this.battle.over) return;
    autoResolve(this.battle);
    this.finish();
  }

  /** Retreat (lose the army, free) or Surrender (keep the army, pay gold). */
  tryEscape(mode) {
    if (this.finished || this.busy || this.battle.over) return;
    if (this.humanSide < 0 || !this.battle.sides[this.humanSide]?.hero) return;
    let goldPaid = 0;
    if (mode === 'surrender') {
      // The hero is not decoration in this call: Diplomacy discounts the price,
      // and applyEscape RECOMPUTES it with the hero when it actually charges. A
      // quote taken without them would be the wrong number on the button and the
      // wrong number in the affordability check.
      goldPaid = surrenderCost(this.humanArmyNow(), this.battle.sides[this.humanSide]?.hero);
      const gold = this.playerGold();
      if (goldPaid > gold) {
        this.dialog({
          title: 'Cannot surrender',
          lines: [`Buying off your army costs ${goldPaid} gold — you have ${gold}.`],
          buttons: [{ text: 'OK' }],
        });
        return;
      }
    }
    const lines = mode === 'surrender'
      ? [`Pay ${goldPaid} gold to withdraw and KEEP your surviving army.`, 'Your hero survives and flees the field.']
      : ['Flee the battle. Your hero survives but LOSES its entire army.', 'This costs nothing.'];
    this.dialog({
      title: mode === 'surrender' ? 'Surrender?' : 'Retreat?',
      lines,
      buttons: [
        {
          text: mode === 'surrender' ? 'Pay & withdraw' : 'Retreat',
          onClick: () => {
            if (this.finished || this.battle.over) return;
            escapeBattle(this.battle, this.humanSide, mode, goldPaid);
            playSfx('cancel');
            this.finish();
          },
        },
        { text: 'Cancel' },
      ],
    });
  }

  /** showDialog, kept as a named seam for the scene's many call sites. The
   *  click-guard that stops a dismiss-press from also ordering a unit is armed by
   *  uikit's trackModal, which every modal — dialogs and the spellbook alike —
   *  goes through, so it can no longer be forgotten per call site. */
  dialog(spec) {
    return showDialog(this, spec);
  }

  log(text) {
    this.logLines.push(text);
    this.logLines = this.logLines.slice(-5);
    this.logText?.setText(this.logLines.join('\n'));
  }

  // ------------------------------------------------------------------
  // Turn engine
  // ------------------------------------------------------------------

  /** Monotonic wall-clock, independent of the Phaser Time.Clock. */
  now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  /** Stamp "the turn loop made progress just now" for the stall watchdog. */
  markProgress() {
    this.lastProgressAt = this.now();
    this._lastProgressFrame = this._frames; // for the L-key stall telemetry
  }

  /** True when the scene is legitimately idle, waiting for the human to act.
   *
   *  "Legitimately" is load-bearing: update() SUPPRESSES the stall watchdog while
   *  this is true, so any state that both looks like waiting AND cannot receive a
   *  click becomes a permanent freeze with nothing logged — no exception, no
   *  warning, just a battle that never moves again. So it is not enough for a
   *  human stack to be active; input must actually be reachable.
   *
   *  Note what this therefore is NOT: it is false while a dialog is open, because
   *  a battlefield click cannot arrive through one. That is the right answer for
   *  the HUD buttons this also drives — but on its own it made the watchdog treat
   *  a player reading the spellbook as a freeze. update() handles open dialogs
   *  separately (see MODAL_PATIENCE_MS) before consulting the watchdog. */
  awaitingHumanInput() {
    // THE TACTICS PHASE IS A WAIT FOR THE HUMAN, and it is the one wait that
    // happens before any unit is active — so `humanTurn()` below, which needs an
    // activeUnit, answered false for it and the watchdog counted the phase down
    // as a freeze. Four seconds after the battlefield appeared it logged
    // "progression stalled", tore the phase down and took the turn.
    //
    // Reported as "attacking a Pandora's Box or a Griffin Conservatory takes
    // several seconds before proceeding", and the delay was the smaller half of
    // it: a hero with Tactics ALWAYS wins the phase against a leaderless defender
    // (setupTactics reaches on the DIFFERENCE of the two heroes' skill, and a
    // pandora's guards, a bank's guards and a wild stack have no hero at all), so
    // the secondary skill the player spent a level-up on destroyed itself four
    // seconds in, on every PvE fight, and force-advanced the turn.
    //
    // Guarded exactly like the rest of this function: it is a legitimate wait
    // only while input can actually reach the field — the placement band and the
    // Start Battle button. A modal leaking over it is still a stall, and update()
    // still recovers that case by clearing the gate rather than taking the turn.
    if (this.tacticsMode) return !worldClicksBlocked();
    if (!this.humanTurn()) return false;
    return !worldClicksBlocked();
  }

  /** Whose move it is, ignoring whether input happens to be gated this instant.
   *  The HUD buttons key off this rather than awaitingHumanInput(): the guard
   *  armed after a dialog is force-closed would otherwise leave Wait/Defend/
   *  Spellbook dead for the remainder of the turn, since nothing re-runs
   *  setButtonsEnabled once the guard lapses. Pressing a HUD button during the
   *  guard is harmless — it opens a dialog; the guard exists to stop a stray
   *  press reaching the battlefield. */
  humanTurn() {
    const u = this.activeUnit;
    return !this.busy && !!u && u.alive && u.side === this.humanSide && !this.autoPlay;
  }

  /**
   * The turn engine's heartbeat — runs every frame. ALL progression is driven
   * from here off the wall clock, so it never waits on a Phaser tween
   * onComplete or timer callback (those proved unreliable in some browsers and
   * were the root of both the "battle won't finish" hang and the "manual army
   * won't move" lockout — input is gated by `busy`, which only these callbacks
   * used to clear). Priority order:
   *  1. Drain the animation queue (advances when each event's wall-clock
   *     deadline passes); this is what clears `busy` and reopens input.
   *  2. If the engine decided the battle, let the player leave it.
   *  3. Fire a due AI turn (frame-scheduled, no timer).
   *  4. Legitimately idle, waiting on the human.
   *  5. Last-resort stall backstop.
   */
  update() {
    if (!this.battle) return;
    this._frames++; // stall telemetry only — never gates progression
    if (this._anim) {
      if (this.now() >= this._eventDeadline) this._pumpAnim();
      return;
    }
    if (this.battle.over) { if (!this.finished) this.finish(); return; }
    if (this._pendingAI && this.now() >= this._pendingAI.at) {
      const u = this._pendingAI.unit;
      this._pendingAI = null;
      this.playAITurnFor(u);
      return;
    }
    if (this.awaitingHumanInput()) { this.markProgress(); return; }
    // An open dialog is a wait the player asked for — reading a spell, answering
    // a prompt — and the turn loop is idle on purpose. This branch is why: with
    // only awaitingHumanInput() to go on, the watchdog fired STUCK_MS into a
    // spell being chosen, tore the spellbook down and took the turn. Reported as
    // "the cast modal changes too fast and disappears before I press Cast, so I
    // press on the field and move my stack instead".
    if (modalOpen() && modalAgeMs() < MODAL_PATIENCE_MS) { this.markProgress(); return; }
    if (!this._pendingAI && this.now() - (this.lastProgressAt || 0) > STUCK_MS) {
      // Name the cause. A gated input channel is the one stall a player cannot
      // break out of by clicking, so clear it — and clearing it is the WHOLE
      // recovery: the turn loop was never stuck, only the way in. Advancing the
      // turn as well would cost the player the stack they were about to order.
      if (worldClicksBlocked()) {
        console.warn('[combat] input gate stuck shut (a modal leaked) — clearing it');
        // Nobody asked for this close, so hold the world shut afterwards: the
        // press already travelling towards a button on the dialog must not land
        // on the battlefield and order a stack. And say so in the log — a dialog
        // that vanishes silently reads as the game losing the click.
        resetModals({ guardMs: MODAL_AUTOCLOSE_GUARD_MS });
        this.log('A dialog closed itself — the battle had stopped responding.');
        this.markProgress();
        this.setButtonsEnabled(this.humanTurn());
        return;
      }
      console.warn('[combat] progression stalled — force-advancing the turn loop');
      this.recoverFromStall();
    }
  }

  /** Advance the animation queue by one event, or finish the batch. */
  _pumpAnim() {
    const a = this._anim;
    this.markProgress();
    if (a.i >= a.events.length) {
      this._anim = null;
      this.refreshUnits();
      if (a.done) { try { a.done(); } catch (e) { console.warn('[combat] anim done cb threw', e); } }
      return;
    }
    const ev = a.events[a.i++];
    this._lastEventType = ev?.type ?? null; // stall telemetry only
    let dur = 0;
    try { dur = this.playEvent(ev) || 0; } catch (e) { console.warn('[combat] animation error on', ev?.type, e); }
    this._eventDeadline = this.now() + dur;
  }

  /** Break a stuck turn loop: drop the locks, resync sprites, drive on. */
  recoverFromStall() {
    this.busy = false;
    this.awaitingAI = false;
    this._anim = null;
    this._pendingAI = null;
    this.markProgress();
    try { this.refreshUnits(); } catch (e) { console.warn('[combat] resync failed', e); }
    // A recovery DURING the placement phase has to close the phase, not just take
    // the turn. `tacticsMode` is what onPointerDown routes battlefield clicks by,
    // so leaving it set — with its band and its Start Battle button still drawn —
    // sent every order the player gave for the rest of the fight to the placement
    // handler instead: stacks silently repositioned, orders silently dropped.
    // This is now unreachable from the tactics phase itself (awaitingHumanInput
    // covers it), which is exactly why it is worth closing off: it was the second
    // half of the reported bug and nothing else would ever have found it.
    if (this.tacticsMode) { this.finishTactics(); return; }   // itself calls nextTurn
    if (this.battle.over) this.finish(); else this.nextTurn();
  }

  /**
   * The single choke point for every engine action the scene initiates (human
   * orders, AI orders, hero spells). Guarantees the turn engine can never hang
   * on a rendering callback: the engine call is wrapped so a throw can't strand
   * busy=true, busy is ALWAYS cleared after the events animate (or fail to), and
   * the battle-over check runs synchronously. `produce` is a thunk that calls
   * the engine and returns its event list; `after` runs once afterwards.
   */
  runAction(produce, after) {
    this.busy = true;
    this.awaitingAI = false;
    // Each batch is ONE engine action, so a mass cast's seven spellEffect events
    // are all inside this batch: reset the "already announced" marker here and a
    // sweep logs one line instead of seven (see the spellEffect handler).
    this._massAnnounced = null;
    this.markProgress();
    let events;
    try {
      events = produce() || [];
    } catch (e) {
      console.warn('[combat] engine action threw — recovering', e);
      try { this.refreshUnits(); } catch { /* ignore resync failure */ }
      events = [];
    }
    const finalize = () => {
      this.busy = false;
      this.markProgress();
      try { if (after) after(); } catch (e) { console.warn('[combat] post-action callback threw', e); }
      this.endIfOver();
    };
    try {
      this.animateEvents(events, finalize);
    } catch (e) {
      console.warn('[combat] animation pipeline threw — recovering', e);
      finalize();
    }
    // Synchronous end path — but ONLY when nothing is animating. If this action
    // queued a batch (this._anim set — e.g. the killing blow), finalize()'s
    // endIfOver runs finish() AFTER update()'s frame-pump drains it, so the
    // final blow's animation actually PLAYS before the recap opens. The pump is
    // frame-loop + wall-clock driven (not tween/timer callbacks), so a
    // dead-callback browser still drains it, and the stall watchdog backstops a
    // truly stuck batch — the anti-soft-lock guarantee is preserved.
    if (!this._anim) this.endIfOver();
  }

  /**
   * Call synchronously immediately after any act()/castSpell(): if the engine
   * has decided the battle, end it now — in the same call stack, with no
   * dependence on a tween, timer, or the frame loop firing. Returns true if
   * the battle ended.
   */
  endIfOver() {
    if (this.battle.over) { this.finish(); return true; }
    return false;
  }

  nextTurn() {
    if (this.battle.over) return this.finish();
    let unit, events;
    try {
      ({ unit, events } = beginTurn(this.battle));
    } catch (e) {
      console.warn('[combat] beginTurn threw — recovering', e);
      try { this.refreshUnits(); } catch { /* ignore resync failure */ }
      return this.endIfOver();
    }
    // Block input and arm the stall watchdog while the transition animates.
    this.busy = true;
    this.markProgress();
    const setup = () => {
      this.busy = false;
      this.markProgress();
      if (this.battle.over || !unit) return this.finish();
      this.activeUnit = unit;
      this.refreshActiveIndicator(unit);
      this.buildActiveRing();   // static ring/chevron follow the acting stack
      this.updateHighlights();  // hover/movement overlay (per-hover from here on)
      // War machines run themselves (they shell / mend / dig in via the combat
      // AI) even on the human's side — there's no manual UI to steer an immobile
      // Ballista or Tent, so they take the same auto-act path as an enemy stack.
      const isHuman = unit.side === this.humanSide && !this.autoPlay && !unit.machine;
      if (isHuman) {
        this.setButtonsEnabled(true);
      } else {
        this.setButtonsEnabled(false);
        this.awaitingAI = true;
        // Frame-scheduled, NOT a timer — update() fires it when due.
        this._pendingAI = { unit, at: this.now() + (this.humanSide === -1 ? AI_BEAT_OBSERVER_MS : AI_BEAT_MS) };
      }
    };
    try {
      this.animateEvents(events, setup);
    } catch (e) {
      console.warn('[combat] nextTurn animation threw — recovering', e);
      setup();
    }
    this.endIfOver();
  }

  playAITurnFor(unit) {
    this.awaitingAI = false;
    if (this.battle.over) return this.finish();
    if (this.busy) return;                        // an animation is mid-flight; it resumes the loop
    if (!unit || !unit.alive) { this.nextTurn(); return; } // died before its turn -> advance

    // Two guarded steps: the optional hero spell, then the stack's action. A
    // human-side war machine auto-acts too, but must NOT trigger the AI to cast
    // the human hero's spells — only enemy-side turns roll a hero spell.
    this.runAction(
      () => (unit.side === this.humanSide ? [] : maybeCastAISpell(this.battle, unit.side)),
      () => {
        if (this.battle.over) return;             // an AI hero spell ended it -> finalize handled it
        this.runAction(
          () => {
            if (!unit.alive) return [];
            const evs = act(this.battle, unit, chooseAction(this.battle, unit));
            // The engine rejects an illegal action by returning [] WITHOUT
            // advancing the queue — retrying the same choice would livelock the
            // battle (and the watchdog can't see it: each cycle "progresses").
            // Force a defend so the queue always moves on.
            return evs.length ? evs : act(this.battle, unit, { type: 'defend' });
          },
          () => { if (!this.battle.over) this.nextTurn(); },
        );
      },
    );
  }

  humanAct(action) {
    if (this.busy || !this.activeUnit) return;
    const unit = this.activeUnit;
    // Scored BEFORE the action is applied — the candidate set has to be the one
    // the player was actually looking at. This is the symmetric half of the log:
    // where the player's move ranks in the AI's own scoring is the measurement
    // that says whether the evaluator is wrong (see ai/battleTelemetry).
    recordHumanAction(this.battle, getState(), this.battleId, unit, action);
    this.resurrectMode = false;
    this.targetingSpell = null; // an armed spell must not persist across turns
    this.setButtonsEnabled(false);
    this.clearHighlights();
    this.runAction(
      () => act(this.battle, unit, action),
      () => { if (!this.battle.over) this.nextTurn(); },
    );
  }

  // ------------------------------------------------------------------
  // Input on the field
  // ------------------------------------------------------------------

  onHover(p) {
    // A dialog is up (spellbook / escape / debrief): the battlefield beneath is
    // frozen, so don't re-highlight or tooltip it under the modal.
    if (modalOpen()) { this.tooltip?.hide(); return; }
    const hex = this.hexAtPointer(p.x, p.y);
    // The MOVEMENT overlay is still ours to draw only on our own turn — but the
    // card is not an order, it is a reading, and "what magic is on that stack"
    // is most worth asking while the enemy is acting. So the highlight stays
    // gated exactly as it was and the tooltip no longer is.
    const ourTurn = !!this.activeUnit && !this.busy
      && this.activeUnit.side === this.humanSide && !this.autoPlay;
    if (ourTurn) {
      this.hoverHex = hex;
      this.updateHighlights();
    }
    // tooltip on units
    if (hex) {
      const u = unitAt(this.battle, hex.x, hex.y);
      if (u) {
        this.tooltip.show(p.x, p.y, this.unitCardText(u));
        return;
      }
      // A corpse under an armed revive: name it so the mark is legible.
      if (ourTurn && (this.resurrectMode || SPELLS[this.targetingSpell]?.revives)) {
        const dead = this.deadTargetAt(hex.x, hex.y, this.activeUnit.side);
        if (dead) {
          this.tooltip.show(p.x, p.y, `${CREATURES[dead.creature].name} (fallen)\nClick to raise`);
          return;
        }
      }
    }
    this.tooltip.hide();
  }

  /**
   * The hover card for a stack — friendly or enemy alike. Stats come from the
   * ENGINE's own accessors, so a hasted stack reads its hasted speed, and every
   * spell riding on it is named with the rounds it has left. Before this, a
   * player could see that a stack was enchanted only by watching the cast go by
   * in the log; four rounds later there was no way to ask.
   */
  unitCardText(u) {
    const c = CREATURES[u.creature];
    const lines = [
      `${c.name} ×${u.count}`,
      `Atk ${unitAttackStat(this.battle, u)} Def ${unitDefenseStat(this.battle, u)} Spd ${unitSpeed(this.battle, u)}`,
      `HP ${u.hp}/${u.maxHp}`,
    ];
    const fx = effectSummary(u);
    if (fx.length) {
      // In an observed AI-vs-AI battle there is no "our" side, so neither stack
      // gets called the enemy.
      const mine = this.humanSide !== 0 && this.humanSide !== 1 ? true : u.side === this.humanSide;
      lines.push(mine ? '— magic on this stack —' : '— magic on this enemy —');
      for (const e of fx) {
        const detail = effectDetail(e.effects);
        lines.push(`${e.hostile ? '▼' : '▲'} ${e.name}${detail ? ` (${detail})` : ''} — ${e.rounds}r`);
      }
    }
    if (c.desc) lines.push(c.desc);
    return lines.join('\n');
  }

  /** A DEAD friendly stack occupying (x,y) — the target unitAt() (alive-only)
   *  hides from every revive path. A corpse keeps its last hex; if a living
   *  stack has since moved onto it, that hex targets the living one instead. */
  deadTargetAt(x, y, side) {
    if (unitAt(this.battle, x, y)) return null;
    return this.battle.units.find((u) => !u.alive && u.side === side && u.x === x && u.y === y) || null;
  }

  onClick(p) {
    if (this.finished) return; // end screen handles its own Continue button
    // A dialog (spellbook / escape / debrief) owns input: a click on it must not
    // ALSO order a unit on the field beneath. worldClicksBlocked() covers both the
    // press that lands ON an open modal and the press that CLOSED one — the latter
    // reaches this handler in the same dispatch, after the gate has already opened.
    if (worldClicksBlocked()) return;
    // Pre-battle Tactics placement intercepts clicks before the turn loop starts.
    if (this.tacticsMode) {
      this.markProgress();   // the player is working; the loop is not stuck
      if (p.y > this.scale.height - 70 || p.y < 170) return; // Start button / header
      this.onTacticsClick(p);
      return;
    }
    if (!this.activeUnit || this.busy) return;
    if (this.activeUnit.side !== this.humanSide || this.autoPlay) return;
    if (p.y > this.scale.height - 70 || p.y < 170) return; // buttons/header/panels
    const hex = this.hexAtPointer(p.x, p.y);
    if (!hex) return;
    const unit = this.activeUnit;
    const target = unitAt(this.battle, hex.x, hex.y);

    // Spell targeting mode.
    if (this.targetingSpell) {
      const sp = SPELLS[this.targetingSpell];
      // Resurrection raises a fallen stack: unitAt() is alive-only, so also
      // accept a dead friendly corpse at the clicked hex (the engine resolves
      // by id and revives it — the AI could already do this).
      const t = target || (sp?.revives ? this.deadTargetAt(hex.x, hex.y, this.humanSide) : null);
      if (t) this.castAt(this.targetingSpell, t);
      else { this.targetingSpell = null; this.updateHighlights(); }
      return;
    }
    // Archangel resurrection targeting — a dead friendly stack is a valid mark.
    if (this.resurrectMode) {
      const t = (target && target.side === unit.side && target.id !== unit.id)
        ? target
        : this.deadTargetAt(hex.x, hex.y, unit.side);
      if (t && t.id !== unit.id) {
        this.resurrectMode = false;
        this.humanAct({ type: 'resurrect', targetId: t.id });
      } else {
        this.resurrectMode = false;
        this.updateHighlights();
      }
      return;
    }

    if (target && target.side !== unit.side) {
      // Ranged?
      if (canShoot(this.battle, unit)) {
        this.humanAct({ type: 'shoot', targetId: target.id });
        return;
      }
      // Melee: find the best reachable adjacent hex.
      const reach = new Set(reachableHexes(this.battle, unit).map((h) => h.y * 100 + h.x));
      reach.add(unit.y * 100 + unit.x);
      let best = null, bestD = Infinity;
      for (const [nx, ny] of hexNeighbors(target.x, target.y)) {
        const occ = unitAt(this.battle, nx, ny);
        if (occ && occ.id !== unit.id) continue;
        if (!reach.has(ny * 100 + nx)) continue;
        const d = hexDistance(unit.x, unit.y, nx, ny);
        if (d < bestD) { bestD = d; best = { x: nx, y: ny }; }
      }
      if (best) this.humanAct({ type: 'attack', targetId: target.id, x: best.x, y: best.y });
      return;
    }
    if (!target) {
      const reachable = reachableHexes(this.battle, unit).some((h) => h.x === hex.x && h.y === hex.y);
      if (reachable) this.humanAct({ type: 'move', x: hex.x, y: hex.y });
    }
  }

  // ------------------------------------------------------------------
  // Highlights
  // ------------------------------------------------------------------

  clearHighlights() {
    this.highlightG?.clear();
    this.clearActiveRing();
  }

  /** Tear down the active-unit ring + chevron and their two infinite tweens. */
  clearActiveRing() {
    if (this.activeRing) { this.tweens.killTweensOf(this.activeRing); this.activeRing.destroy(); this.activeRing = null; }
    if (this.activeMarker) { this.tweens.killTweensOf(this.activeMarker); this.activeMarker.destroy(); this.activeMarker = null; }
    this._ringKey = null;
  }

  /**
   * The STATIC active-unit ring + bobbing chevron. They depend only on WHICH
   * stack is acting and WHERE it stands, so they're (re)built on an activeUnit
   * change — never on hover. updateHighlights used to rebuild them on every
   * pointermove, destroying and re-creating two containers and their two infinite
   * tweens each time; keying on stack+hex lets a hover leave them untouched.
   */
  buildActiveRing() {
    const unit = this.activeUnit;
    if (!unit || this.busy) { this.clearActiveRing(); return; }
    const key = `${unit.id}:${unit.x},${unit.y}`;
    if (this._ringKey === key && this.activeRing) return; // same stack, same hex — keep the live tweens
    this.clearActiveRing();
    this._ringKey = key;

    // Active-unit ring: a DARK halo under a BRIGHT gold core, so it reads on any
    // terrain — the old single pale ellipse vanished on snow/sand/white ground.
    const c = this.hexCenter(unit.x, unit.y);
    const ringY = c.y + this.hexSize * 0.45;
    this.activeRing = this.add.container(0, 0).setDepth(90);
    const halo = this.add.ellipse(c.x, ringY, this.hexSize * 1.66, this.hexSize * 0.62)
      .setStrokeStyle(5, 0x120e18, 0.85);
    const core = this.add.ellipse(c.x, ringY, this.hexSize * 1.5, this.hexSize * 0.5)
      .setStrokeStyle(2.5, 0xffe9a0, 1);
    this.activeRing.add([halo, core]);
    this.tweens.add({
      targets: this.activeRing, alpha: 0.5, duration: ACTIVE_RING_PULSE_MS, yoyo: true, repeat: -1,
    });
    // A dark-edged gold chevron bobbing over the stack's head — an unmistakable
    // "this one is acting" mark that never blends into the ground colour.
    const markY = c.y - this.hexSize * 1.5;
    this.activeMarker = this.add.container(c.x, markY).setDepth(320);
    const chevron = this.add.triangle(0, 0, -10, -9, 10, -9, 0, 7, 0xffe9a0)
      .setStrokeStyle(2, 0x120e18, 1);
    this.activeMarker.add(chevron);
    this.tweens.add({
      targets: this.activeMarker, y: markY - 6, duration: 460, yoyo: true, repeat: -1, ease: 'Sine.inOut',
    });
  }

  /** Redraw ONLY the hover/movement/targeting overlay (highlightG). The static
   *  ring + chevron are owned by buildActiveRing() and left alone here, so a
   *  pointermove no longer churns them. */
  updateHighlights() {
    this.highlightG?.clear();
    const unit = this.activeUnit;
    if (!unit || this.busy) return;
    const g = this.highlightG;
    if (unit.side !== this.humanSide || this.autoPlay) return;

    // spell / resurrect targeting: highlight valid targets
    if (this.targetingSpell || this.resurrectMode) {
      const spell = this.targetingSpell ? SPELLS[this.targetingSpell] : null;
      for (const u of this.battle.units.filter((x) => x.alive)) {
        const friendly = u.side === this.humanSide;
        let valid;
        if (this.resurrectMode) valid = friendly && u.id !== unit.id;
        else if (spell.kind === 'damage' || spell.kind === 'debuff') valid = !friendly;
        else valid = friendly;
        if (!valid) continue;
        const uc = this.hexCenter(u.x, u.y);
        g.lineStyle(2.5, this.resurrectMode || spell.kind === 'buff' || spell.kind === 'heal' ? 0x7ec860 : 0xe86f5f, 0.95);
        g.strokePoints(this.hexPoints(uc.x, uc.y, this.hexSize - 2), true, true);
      }
      // Revive targeting also lights up DEAD friendly stacks: they keep their
      // last hex and the engine can raise them, but the alive-only loop above
      // (and unitAt) hides them, so draw a green ring + a ✚ so there is a
      // corpse to aim at.
      if (this.resurrectMode || spell?.revives) {
        for (const u of this.battle.units) {
          if (u.alive || u.side !== this.humanSide || unitAt(this.battle, u.x, u.y)) continue;
          const uc = this.hexCenter(u.x, u.y);
          g.lineStyle(2.5, 0x7ec860, 0.95);
          g.strokePoints(this.hexPoints(uc.x, uc.y, this.hexSize - 2), true, true);
          g.lineStyle(3, 0x7ec860, 0.9);
          g.beginPath();
          g.moveTo(uc.x - 7, uc.y); g.lineTo(uc.x + 7, uc.y);
          g.moveTo(uc.x, uc.y - 7); g.lineTo(uc.x, uc.y + 7);
          g.strokePath();
        }
      }
      return;
    }

    // movement range
    for (const h of reachableHexes(this.battle, unit)) {
      const hc = this.hexCenter(h.x, h.y);
      g.fillStyle(0xfff2c0, 0.14);
      g.fillPoints(this.hexPoints(hc.x, hc.y, this.hexSize - 2), true);
    }
    // shooting indicator
    if (canShoot(this.battle, unit)) {
      for (const u of this.battle.units.filter((x) => x.alive && x.side !== unit.side)) {
        const uc = this.hexCenter(u.x, u.y);
        g.lineStyle(2, 0xe8c060, 0.8);
        g.strokeCircle(uc.x, uc.y - this.hexSize * 0.2, this.hexSize * 0.55);
      }
    }
    // hover feedback
    if (this.hoverHex) {
      const t = unitAt(this.battle, this.hoverHex.x, this.hoverHex.y);
      const hc = this.hexCenter(this.hoverHex.x, this.hoverHex.y);
      if (t && t.side !== unit.side) {
        g.lineStyle(3, 0xe86f5f, 1);
        g.strokePoints(this.hexPoints(hc.x, hc.y, this.hexSize - 1.5), true, true);
      } else if (!t) {
        g.lineStyle(2, 0xfff2c0, 0.8);
        g.strokePoints(this.hexPoints(hc.x, hc.y, this.hexSize - 1.5), true, true);
      }
    }
  }

  // ------------------------------------------------------------------
  // Spellbook
  // ------------------------------------------------------------------

  openSpellbook() {
    const side = this.humanSide;
    const hero = this.battle.sides[side]?.hero;
    if (!hero) return;
    // A pictogram grid of every combat spell (adventure spells are cast on the
    // map, not here). Click one to read it, then Cast — hitsAll spells fire at
    // once, the rest arm target-picking on the battlefield.
    const known = hero.spells.filter((id) => SPELLS[id] && !SPELLS[id].adventure);
    openSpellbookOverlay(this, {
      title: 'Spellbook',
      subtitle: `${hero.mana} mana available`,
      groups: [{ label: 'Combat', spells: known }],
      actionLabel: 'Cast',
      canAct: (id) => canCast(this.battle, side, id),
      costOf: (id) => spellCost(hero, id),
      noteOf: (id) => masteryNote(hero, id),
      actNote: (id) => (hero.mana < spellCost(hero, id) ? `Need ${spellCost(hero, id)} mana` : 'Cannot cast now'),
      onAct: (id) => {
        // trackModal already armed the guard when close() destroyed the book; keep
        // arming it here too, so a future spellbook that fires onAct BEFORE it
        // closes still can't let the Cast press double as a battlefield click (a
        // stray move, or a premature target for the spell we are about to arm).
        blockWorldClicks();
        // Armageddon and any MASS cast (Expert Air Haste, Expert Earth Slow…)
        // pick their own targets, so there is nothing to aim at — fire at once
        // rather than arming a target-picker the engine would ignore.
        if (SPELLS[id].hitsAll || isMassCast(hero, id)) {
          this.runAction(
            () => this.castLogged(side, id, {}),
            () => {
              this.refreshHeroPanels();
              if (this.battle.over) return;
              this.updateHighlights();
              this.setButtonsEnabled(true);
            },
          );
        } else {
          this.targetingSpell = id;
          this.updateHighlights();
        }
      },
    });
  }

  /** Cast a spell and write a mana-ledger line to the combat log: every point
   *  spent, with the spell that spent it. Also re-baselines the mana watchdog so
   *  this legitimate spend is NOT flagged as an unexplained drain (see
   *  refreshHeroPanels). Returns the engine events, like castSpell. */
  castLogged(side, spellId, target) {
    const hero = this.battle.sides[side]?.hero;
    const before = hero ? hero.mana : 0;
    // A human cast, recorded against the same channel the AI's casts use — the
    // reported gap ("the AI never casts Blind where I would") only shows up when
    // both sides' spell decisions land in one comparable stream.
    if (side === this.humanSide) recordHumanCast(this.battle, getState(), this.battleId, side, spellId, target);
    const events = castSpell(this.battle, side, spellId, target);
    if (hero && hero.mana !== before) {
      const sp = SPELLS[spellId];
      this.log(`${hero.name} casts ${sp?.name || spellId}: mana ${before} → ${hero.mana} (−${before - hero.mana})`);
      (this._manaSeen ||= {})[side] = hero.mana; // this spend is accounted for
    }
    return events;
  }

  castAt(spellId, target) {
    this.targetingSpell = null;
    this.clearHighlights();
    this.runAction(
      () => this.castLogged(this.humanSide, spellId, { unitId: target.id }),
      () => {
        this.refreshHeroPanels();
        if (this.battle.over) return;
        this.updateHighlights();
        this.setButtonsEnabled(true);
      },
    );
  }

  // ------------------------------------------------------------------
  // Event animation
  // ------------------------------------------------------------------

  animateEvents(events, done) {
    if (!events || !events.length) { done(); return; }
    if (this.combatEvents) this.combatEvents.push(...events); // capture for the debrief
    // Queue the batch; update()'s _pumpAnim drains it by wall-clock so
    // progression (and busy-clearing, and input re-opening) never depends on a
    // tween onComplete or timer callback firing.
    this._anim = { events, i: 0, done };
    this._eventDeadline = 0; // first event plays on the next frame
    this.markProgress();
  }

  /**
   * Render ONE event and return how long (ms) to dwell before the frame pump
   * advances. Tweens still animate cosmetically, but nothing here is relied on
   * to advance the turn — that is update()/_pumpAnim's job.
   */
  playEvent(ev) {
    switch (ev.type) {
      case 'roundStart':
        this.log(`— Round ${ev.round} —`);
        this.refreshUnits();
        return 0;
      case 'move': {
        const spr = this.unitSprites.get(ev.unitId);
        if (!spr) return 0;
        const to = this.hexCenter(ev.to.x, ev.to.y);
        const dist = hexDistance(ev.from.x, ev.from.y, ev.to.x, ev.to.y);
        const dur = Math.min(MOVE_MAX_MS, MOVE_MS_PER_HEX * Math.max(1, dist));
        this.tweens.add({
          targets: spr, x: to.x, y: to.y, duration: dur, ease: 'Sine.easeInOut',
          onComplete: () => spr.setDepth(100 + ev.to.y),
        });
        return dur;
      }
      case 'attack':
      case 'retaliate': {
        const a = this.unitSprites.get(ev.attackerId);
        const t = this.unitSprites.get(ev.targetId);
        this.log(`${this.unitName(ev.attackerId)} ${ev.type === 'retaliate' ? 'retaliates against' : 'hits'} ${this.unitName(ev.targetId)} for ${ev.damage}${ev.kills ? ` (${ev.kills} slain)` : ''}${ev.luck > 0 ? ' — LUCKY STRIKE!' : ''}`);
        playSfx(ev.kind === 'ranged' ? 'shoot' : 'hit');
        if (a && t) {
          const dx = (t.x - a.x) * 0.18, dy = (t.y - a.y) * 0.18;
          this.tweens.add({ targets: a, x: a.x + dx, y: a.y + dy, duration: ATTACK_LUNGE_MS, yoyo: true });
          this.damagePopup(t.x, t.y, ev.damage, ev.luck > 0);   // fire directly, not via onYoyo
          this.flashUnit(ev.targetId);
        }
        return DWELL_ATTACK_MS;
      }
      case 'splash':
      case 'spellHit': {
        playSfx('magic');
        this.log(`${ev.spellId ? SPELLS[ev.spellId].name : 'Blast'} hits ${this.unitName(ev.targetId)} for ${ev.damage}${ev.kills ? ` (${ev.kills} slain)` : ''}`);
        const t = this.unitSprites.get(ev.targetId);
        if (t) {
          this.damagePopup(t.x, t.y, ev.damage, false, 0xb090ff);
          this.flashUnit(ev.targetId, 0x9a6fff);
        }
        return DWELL_SPELLHIT_MS;
      }
      case 'fireShield': {
        this.log(`Fire shield burns ${this.unitName(ev.targetId)} for ${ev.damage}`);
        const t = this.unitSprites.get(ev.targetId);
        if (t) this.damagePopup(t.x, t.y, ev.damage, false, 0xff8040);
        return DWELL_FIRESHIELD_MS;
      }
      case 'spellEffect': {
        playSfx('magic');
        if (ev.mass) {
          if (this._massAnnounced !== ev.spellId) {
            this._massAnnounced = ev.spellId;
            this.log(`${SPELLS[ev.spellId].name} sweeps every ${ev.hostile ? 'enemy' : 'friendly'} stack!`);
          }
        } else {
          this.log(`${SPELLS[ev.spellId].name} on ${this.unitName(ev.targetId)}`);
        }
        this.flashUnit(ev.targetId, ev.hostile ? 0xff7070 : 0x70ff90);
        this.spellSwirl(ev.targetId, ev.hostile);
        // Light the plate NOW rather than waiting for the batch's refreshUnits:
        // the badge and the swirl are one message, and a badge that arrived a
        // second after its own animation would read as belonging to the next cast.
        this.refreshPlate(this.battle.units.find((x) => x.id === ev.targetId));
        return this.moreOfSweepAhead(ev) ? DWELL_SPELLEFFECT_MASS_MS : DWELL_SPELLEFFECT_MS;
      }
      case 'heal': {
        this.log(`${this.unitName(ev.targetId)} restored ${ev.healed} HP${ev.revived ? `, ${ev.revived} revived` : ''}`);
        // A revived corpse can lack a sprite (a resize spawns the living
        // only), so re-sync first — the way rebirth/ghostRise already do.
        if (ev.revived) this.refreshUnits();
        const t = this.unitSprites.get(ev.targetId);
        if (t) {
          t.setVisible(true).setAlpha(1);
          this.damagePopup(t.x, t.y, `+${ev.healed}`, false, 0x8fe870);
          this.spellSwirl(ev.targetId, false);
        }
        return DWELL_HEAL_MS;
      }
      case 'wallHit': {
        const isGate = ev.kind === 'gate';
        this.log(`The catapult ${ev.destroyed ? `smashes the ${isGate ? 'gate' : 'wall'} to rubble!` : `batters the ${isGate ? 'gate' : 'wall'} for ${ev.damage}`}`);
        playSfx('hit');
        const spr = this.wallSprites?.get(ev.wallId);
        if (spr) {
          const ox = spr.x;
          this.tweens.add({ targets: spr, x: ox + 4, duration: 45, yoyo: true, repeat: 2, onComplete: () => spr.setX(ox) });
          const cc = this.hexCenter(ev.x, ev.y);
          this.damagePopup(cc.x, cc.y, ev.damage, false, 0xcfc3a6);
          if (ev.destroyed) {
            this.tweens.add({ targets: spr, alpha: 0, scaleY: 0.3, y: spr.y + this.hexSize * 0.4, duration: 320,
              onComplete: () => { spr.destroy(); this.wallSprites.delete(ev.wallId); } });
          }
        }
        return ev.destroyed ? DWELL_ATTACK_MS : DWELL_ATTACK_MS - 120;
      }
      case 'moat': {
        this.log(`${this.unitName(ev.unitId)} wades into the moat — ${ev.damage} damage${ev.kills ? ` (${ev.kills} slain)` : ''}`);
        playSfx('hit');
        const t = this.unitSprites.get(ev.unitId);
        if (t) { this.damagePopup(t.x, t.y, ev.damage, false, 0xc08a4a); this.flashUnit(ev.unitId, 0x7a5a2a); }
        return DWELL_FIRESHIELD_MS;
      }
      case 'manaSteal':
        this.log(`Imps siphon ${ev.amount} mana!`);
        return 0;
      case 'ghostRise': {
        // A slain lizard stack left a shade on its hex. refreshUnits creates the
        // sprite (it is a mid-battle arrival); fade it in from nothing.
        this.refreshUnits();
        const g = this.unitSprites.get(ev.unitId);
        if (g) {
          g.setAlpha(0).setVisible(true);
          this.tweens.add({ targets: g, alpha: 1, duration: 420, ease: 'Sine.easeOut' });
        }
        this.log(`A shade rises from the fallen — ${ev.count} Lizard Ghost${ev.count === 1 ? '' : 's'}!`);
        return 460;
      }
      case 'rebirth': {
        // The engine emitted this all along but the view ignored it, so a stack
        // rising from its own ashes did so silently AND invisibly. Restore the
        // sprite and flare it, so "I killed them and something is still hitting
        // me" becomes "it came back, and I saw it come back".
        this.refreshUnits();
        const spr = this.unitSprites.get(ev.unitId);
        if (spr) {
          spr.setAlpha(0).setVisible(true);
          this.tweens.add({ targets: spr, alpha: 1, duration: 260, ease: 'Quad.easeOut' });
        }
        this.log(`${this.unitName(ev.unitId)} rises from its own ashes — ${ev.count} return!`);
        return 300;
      }
      case 'morale':
        this.log(`${this.unitName(ev.unitId)} surges with high morale — extra turn!`);
        this.banner('MORALE!', 0xf0c040);
        return DWELL_MORALE_MS;
      case 'badMorale':
        this.log(`${this.unitName(ev.unitId)} freezes from low morale.`);
        this.banner('Low morale…', 0x8090b0);
        return DWELL_MORALE_MS;
      case 'skip':
        if (ev.reason === 'waver') this.log(`${this.unitName(ev.unitId)} cowers and loses its turn.`);
        else this.log(`${this.unitName(ev.unitId)} is blinded and loses its turn.`);
        return 0;
      case 'waver':
        this.log(`${this.unitName(ev.unitId)} wavers under the onslaught!`);
        this.banner('WAVERING!', 0xd08040);
        return DWELL_MORALE_MS;
      case 'rout':
        this.log(`${this.unitName(ev.unitId)} breaks and flees the field!`);
        this.banner('ROUT!', 0xe06040);
        this.refreshUnits();
        return DWELL_MORALE_MS;
      case 'wait':
        this.log(`${this.unitName(ev.unitId)} waits.`);
        return 0;
      case 'defend':
        this.log(`${this.unitName(ev.unitId)} defends (+defense).`);
        return 0;
      case 'end':
        this.refreshUnits();
        return 0;
      default:
        return 0;
    }
  }

  unitName(unitId) {
    const u = this.battle.units.find((x) => x.id === unitId);
    return u ? CREATURES[u.creature].name : '???';
  }

  damagePopup(x, y, amount, lucky, color = 0xffd090) {
    const t = this.add.text(x, y - this.hexSize, `${typeof amount === 'number' ? '-' : ''}${amount}${lucky ? '!!' : ''}`, {
      fontFamily: FONT, fontSize: lucky ? '20px' : '15px', fontStyle: 'bold',
      color: rgba(color), stroke: '#140e04', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(800);
    this.tweens.add({
      targets: t, y: y - this.hexSize - 34, alpha: 0, duration: DAMAGE_POPUP_MS,
      onComplete: () => t.destroy(),
    });
  }

  /**
   * The count plate doubles as the enchantment light: GREEN when only blessings
   * ride this stack, RED when something hexes it, the side colour when it is
   * clean. The fill stays dark — a lit plate is only useful if the number on it
   * is still legible, and gold text on a bright green rectangle is not.
   *
   * Driven off the stack's live effects rather than off the cast event, so it is
   * right after a load, after a dispel, and on the frame an effect lapses; a
   * badge that only lit on cast would go stale the moment the magic wore off.
   * The friendly/hostile decision itself is `effectMood` in core/magic.js, one
   * function a headless test can ask, not a rule buried in a scene.
   */
  refreshPlate(u) {
    const spr = this.unitSprites.get(u?.id);
    if (!spr?.plate) return;
    const mood = effectMood(u);
    const tint = mood === 'hostile' ? 0xff5a5a : mood === 'friendly' ? 0x7ce7a0 : spr.bandColor;
    spr.plate.setStrokeStyle(1.5, tint, 1);
    spr.plate.setFillStyle(mood ? shade(tint, -0.78) : 0x0d0b16, 0.92);
  }

  /**
   * The whirlpool a cast leaves on its target: three broken rings that spin
   * around the stack, widen and fade over about a second.
   *
   * Direction carries the meaning as much as the colour does, because colour
   * alone is the one channel a colour-blind player does not have. A BLESSING
   * rises — the rings start at the stack's feet, climb past its head and open
   * out, green. A HEX sinks — they start high, close in and press down, red.
   * The rings are broken (two arcs with a gap) on purpose: a closed circle
   * reads as a static halo, a broken one reads as turning.
   *
   * Purely cosmetic. It draws from the sprite's live position, owns everything
   * it creates and destroys it on completion, so a stack that dies, moves or is
   * resurrected mid-swirl costs nothing but a stray ring finishing in the air.
   */
  spellSwirl(unitId, hostile) {
    const spr = this.unitSprites.get(unitId);
    if (!spr) return;
    const color = hostile ? 0xff5a5a : 0x7ce7a0;
    const r = this.hexSize * 0.9;
    const RINGS = 3;
    const cont = this.add.container(spr.x, spr.y).setDepth((spr.depth || 100) + 40);
    for (let i = 0; i < RINGS; i++) {
      const g = this.add.graphics();
      g.lineStyle(3, color, 1);
      for (const from of [0.2, Math.PI + 0.2]) {
        g.beginPath();
        g.arc(0, 0, r, from, from + 2.3);
        g.strokePath();
      }
      // Flattened to sit on the ground plane like the unit's shadow does.
      g.setScale(hostile ? 1.15 : 0.4, hostile ? 0.42 : 0.15);
      g.y = hostile ? -this.hexSize * 1.15 : this.hexSize * 0.5;
      g.alpha = 0;
      cont.add(g);
      this.tweens.add({
        targets: g,
        delay: i * 140,
        scaleX: hostile ? 0.4 : 1.15,
        scaleY: hostile ? 0.15 : 0.42,
        y: hostile ? this.hexSize * 0.5 : -this.hexSize * 1.15,
        rotation: hostile ? -3.4 : 3.4,
        alpha: { from: 0, to: 1, ease: 'Quad.easeOut', duration: SPELL_SWIRL_MS * 0.25 },
        duration: SPELL_SWIRL_MS,
        ease: 'Sine.easeOut',
        onComplete: () => this.tweens.add({ targets: g, alpha: 0, duration: 160 }),
      });
    }
    this.time.delayedCall(SPELL_SWIRL_MS + RINGS * 140 + 220, () => cont.destroy());
  }

  /**
   * Is another stack of THIS same sweep still to come in the batch being drawn?
   * A mass cast emits one spellEffect per stack; if each paid the full dwell a
   * seven-stack sweep would take four seconds of queued solos. Every stack but
   * the last is given a frame's dwell so all seven swirls are in the air at
   * once, and the last one holds long enough to be read.
   */
  moreOfSweepAhead(ev) {
    const a = this._anim;
    if (!a) return false;
    for (let i = a.i; i < a.events.length; i++) {
      const nx = a.events[i];
      if (nx?.type === 'spellEffect' && nx.spellId === ev.spellId) return true;
    }
    return false;
  }

  flashUnit(unitId, color = 0xff6060) {
    const spr = this.unitSprites.get(unitId);
    if (!spr?.img) return;
    spr.img.setTintFill(color);
    this.time.delayedCall(FLASH_MS, () => spr.img?.clearTint());
  }

  /**
   * Leave the battlefield once it is decided — the Debrief's Continue, the
   * fallback dialog's button, and the Enter/Esc/Space escape hatch all funnel
   * here (the hatch used to call a method that didn't exist and threw).
   * Idempotent: stops the recap if it's up, stops Combat, hands the result to
   * the caller exactly once.
   */
  leaveBattle() {
    if (this._left || !this._result) return;
    this._left = true;
    if (this.scene.isActive('Debrief') || this.scene.isPaused('Debrief')) {
      this.scene.stop('Debrief');
    }
    this.scene.stop();
    this.onDone?.(this._result);
  }

  banner(text, color) {
    const W = this.scale.width;
    const t = this.add.text(W / 2, this.oy - 40, text, {
      fontFamily: FONT, fontSize: '26px', fontStyle: 'bold',
      color: rgba(color), stroke: '#140e04', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(900).setAlpha(0);
    this.tweens.add({
      targets: t, alpha: 1, y: this.oy - 56, duration: BANNER_IN_MS, yoyo: true, hold: BANNER_HOLD_MS,
      onComplete: () => t.destroy(),
    });
  }

  // ------------------------------------------------------------------
  // Finish
  // ------------------------------------------------------------------

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.clearHighlights();
    this.activeChip?.destroy(); this.activeChip = null; this._activeChipId = null;
    this.setButtonsEnabled(false);
    const result = {
      ...battleResult(this.battle),
      events: this.combatEvents,
      roster: this.combatRoster,
      humanSide: this.humanSide,
    };
    this._result = result; // the keyboard escape hatch (leaveBattle) reads this
    // The per-battle summary — the middle of the three read-outs, and the one
    // that says WHICH fights are worth opening the per-decision log for.
    recordBattleEnd(this.battle, getState(), this.battleId, {
      humanWon: this.humanSide >= 0
        ? (this.humanSide === 0 ? result.attackerWon === true : result.attackerWon === false)
        : null,
      attackerWon: result.attackerWon ?? null,
    });
    // Skirmish / Battle Gym: skip the generic end dialog and hand the extended
    // result straight to the caller, which shows the debrief.
    if (this.ctx?.skirmish) {
      // Hand off to the caller (it starts the debrief). Do NOT scene.stop()
      // first — the caller's scene.start('Debrief') does the transition, and a
      // stop-then-start race here could freeze on the way out.
      this._left = true; // the caller owns the exit now — the hatch must not double-fire
      this.onDone?.(result);
      return;
    }
    // Adventure / generic: show the recap in a FRESH Debrief scene. A full
    // scene renders reliably even in browsers where an in-scene dialog overlay
    // doesn't (the "battle ended but no end screen appeared" report). Continue
    // unwinds the stack — stop Debrief, stop Combat, call onDone (which resumes
    // the map). Adventure launches Combat OVER a paused map, so Combat stays
    // alive under the opaque Debrief until Continue tears both down.
    const won = this.humanSide === -1 || result.attackerWon === (this.humanSide === 0);
    const escaped = result.escape;
    const title = escaped
      ? (escaped.mode === 'surrender' ? 'SURRENDERED' : 'RETREATED')
      : this.humanSide === -1 ? 'BATTLE RESOLVED' : won ? 'VICTORY' : 'DEFEAT';
    const leave = () => this.leaveBattle();
    try {
      const digest = battleDigest(result.events, result.roster, {
        humanSide: this.humanSide, won, xp: result.xp,
      });
      // Tell the player WHY the experience is larger than the damage they dealt.
      if (result.flawless && won) digest.flawless = { base: result.baseXp, total: result.xp };
      console.info('[combat] battle over — opening recap');
      this.scene.launch('Debrief', {
        digest,
        adventure: true,
        title,
        onContinue: leave,
      });
    } catch (e) {
      // Never strand the player: if the recap can't open, fall back to a
      // minimal end dialog that still returns to the map.
      console.error('[combat] recap failed — using fallback end dialog', e);
      this.dialog({
        title: won ? 'VICTORY!' : 'DEFEAT',
        lines: [won ? 'The field is yours.' : 'Your forces have been routed…'],
        buttons: [{ text: 'Continue', onClick: leave }],
      });
    }
  }

}

function lerpColor(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return [
    Math.round(ar + (br - ar) * t),
    Math.round(ag + (bg - ag) * t),
    Math.round(ab + (bb - ab) * t),
  ];
}
