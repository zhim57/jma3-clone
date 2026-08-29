/**
 * AdventureScene — The strategic layer: world map, fog of war, hero movement,
 * pickups, end-turn/AI cycle, and the bridges into Town/Combat/Hero scenes.
 *
 * Rendering: the terrain is painted once onto a big offscreen canvas (smooth
 * gradients + feathered terrain transitions); everything else is sprites
 * whose depth is their world y (painter's sort). The camera pans by
 * drag/WASD/arrows and zooms to the pointer with the wheel.
 *
 * All screen-space UI (resource bar, side panel, toasts, dialogs) lives in
 * AdvUIScene — a separate scene with a static camera, so UI hit-testing is
 * immune to this scene's scrolling camera.
 */

import Phaser from 'phaser';
import { CONFIG } from '../config.js';
import { ARTIFACTS } from '../data/artifacts.js';
import { CREATURES } from '../data/creatures.js';
import { FACTIONS, BANNER_COLORS } from '../data/factions.js';
import { hasSprite, spriteKey, artifactTextureKey, townIcon, heroTextureKey } from '../gfx/sprites.js';
import { getState, setState, saveGame, clearCampaignSave } from '../game/session.js';
import { scaledDuration, getSetting, setSetting, onSettingsChange } from '../game/settings.js';
import { playMusic, playSfx, stopMusic } from '../game/audio.js';
import { hideOverlay, showOverlay } from '../game/loadingOverlay.js';
import {
  currentPlayer, playerHeroes, playerTowns, tileAt, weekOf, dayOfWeek, heroAt,
  levelMap, levelObjects, sameTeam, playerHasKey, getObject, featureOn, canAfford, bannerSlot,
} from '../core/GameState.js';
import { armyValue } from '../core/heroUtils.js';
import { vassalsOf } from '../core/pacts.js';
import { adventureParam, scrySighting } from '../core/magic.js';
import {
  endTurn, stepHero, stepReserve, applyCombatResult, mineName, boosterName, boosterEffect, boosterSpent, checkVictory, acceptPleas, buildBoat,
  useObjectUnderHero, castAdventureSpell, weekEventMessage, seerQuestText,
  digForGrail, grailKnown, keyColorName, pandoraRewardText, victoryObjectiveText,
  dwellingCreature, dwellingName, dimDoorLandable, townPortalTowns, townPortalCanChoose,
  parley, parleyOffer, combatContext, encounterPreviewKey, pveWouldScale, bandAssaultContext, settleBandAssault, autoBandBattle,
  encounterFlees, letThemGo, chaseThem, chaseCost,
  claimVictoryNow,
} from '../core/actions.js';
import { SPELLS } from '../data/spells.js';
import { bankDef, broodOf } from '../data/creatureBanks.js';
import { SKILLS } from '../data/skills.js';
import { isCampaign, currentScenario } from '../core/campaign.js';
import { ageFloorText } from '../core/ages.js';
import { isEndless, endlessRealm, advanceEndless } from '../core/endless.js';
import { recordHumanMove } from '../ai/adventureTelemetry.js';
import { campaignById } from '../data/campaigns.js';
import { findPath } from '../map/Pathfinding.js';
import { isExplored, fogFor } from '../map/fog.js';
import { seasonName, seasonOf, isSeasonChange } from '../core/seasons.js';
import {
  drawTerrainTile, paintTransition, baseColorOf, decorTextureFor,
  paintMacroVariation, paintGroundCover, paintRoads,
  TERRAIN_STYLE, setTerrainRaster, clearTerrainRasters,
} from '../gfx/terrain.js';
import { makeCanvas } from '../gfx/canvasKit.js';
import { AITurnController } from '../ai/AIPlayer.js';
import { canRecruitFrom, pactOffers, acceptOffer, declineOffer } from '../core/pacts.js';
import {
  mercyPleas, mercyTownChoices, grantMercy, refuseMercy, clearMercyPlea,
} from '../core/uprisings.js';
import { refuseTerms } from '../core/patrons.js';
import { isRonin, roninBrief } from '../core/ronins.js';
import { FONT, modalOpen, worldClicksBlocked, panel, label, button, trackModal, pinToScreen, fmtCount, COLORS, DEPTH, showDialog } from '../ui/uikit.js';

const T = CONFIG.TILE;

// Terrain is baked in CHUNK×CHUNK-tile canvases rather than one map-sized one: a
// single map.w*T × map.h*T texture blows past the WebGL max texture size (commonly
// 4096px = 64 tiles) on larger maps and fails to upload. 32 tiles is 2048px — safe
// on effectively all hardware — and any map size renders. Module-level because the
// queue (buildTerrain) and the painter (bakeTerrainChunk) must agree on it.
const TERRAIN_CHUNK = 32;

// The count under a wild stack. Two colours because it is two different claims:
// the number the object is holding, and the number the fight would field. See
// AdventureScene.paintCount.
const COUNT_RESTING = '#ffe9b0';
const COUNT_MASSED = '#e2837c';

// Base per-tile animation duration (ms), scaled by the animSpeed setting. Paced
// so the eye can track each step comfortably; finer control lives on that
// setting.
//
// ONE PACE FOR BOTH SIDES. The AI's step used to be 200ms against your own 150,
// on the argument that a slower glide made the enemy's turn "read as a distinct
// beat you can follow across the map". Held up against play, that did not
// survive: the beat it bought was a third of a second per tile added to a wait
// nobody wanted, on a turn the player is not acting in — and the banner, not the
// tempo, is what says whose turn it is. Written as one constant rather than two
// equal ones, because two names for the same number is a second thing to keep in
// step. The number itself lives in CONFIG (STEP_ANIM_MS) so the aiperf
// instrument prices the AI trail off the pace the scene actually plays.
const HUMAN_STEP_MS = CONFIG.STEP_ANIM_MS;
const AI_STEP_MS = HUMAN_STEP_MS;

// Soft camera-follow during a walk: the moving token may roam the central
// fraction of the view (the deadzone) before the camera slides, and the frame
// eases toward it rather than snapping — so it trails a walking hero smoothly
// without jerking on short hops.
const MOVE_FOLLOW_DEADZONE = 0.5; // token stays within the central 50% of the view
const MOVE_FOLLOW_LERP = 0.16;    // per-16ms easing toward the needed correction

// Player colours (blue, red, green, gold) — used to tint the hero hover card
// border so it echoes the owner's map banner.
const OWNER_TINT = [0x4a86d8, 0xd8514a, 0x4ad07a, 0xd8b23a];

// Multi-state hero pointer: a RAPID re-click within this window of the previous
// click on the SAME hero CYCLES the pointer to the next intent (info → command →
// select); an ordinary, spaced click COMMITS the action the cursor is showing.
const HERO_ACTION_MS = 400;

// Scouting brackets (HoMM3-style): an enemy stack's count is never revealed
// exactly on hover — only the bracket word — so intel is useful but imperfect.
function vagueCount(n) {
  if (n <= 4) return 'Few';
  if (n <= 9) return 'Several';
  if (n <= 19) return 'Pack';
  if (n <= 49) return 'Lots';
  if (n <= 99) return 'Horde';
  if (n <= 249) return 'Throng';
  if (n <= 499) return 'Swarm';
  return 'Legion';
}
// Overall army-strength descriptor (+ escalating colour) from total army value,
// so a glance tells a chip hero from a doomstack.
const STRENGTH_TIERS = [
  [500, 'Meager', '#8fd39a'], [2000, 'Modest', '#bcd98a'], [6000, 'Sizable', '#e8d46a'],
  [15000, 'Strong', '#e8b45a'], [40000, 'Formidable', '#e8894a'], [100000, 'Fearsome', '#e8624a'],
];
function strengthWord(v) {
  for (const [cap, word] of STRENGTH_TIERS) if (v < cap) return word;
  return 'Overwhelming';
}
function strengthColor(v) {
  for (const [cap, , col] of STRENGTH_TIERS) if (v < cap) return col;
  return '#e83a3a';
}

// Portal glow colours, indexed by a pair's `color`. Two linked portals share a
// colour so you can read at a glance where a gateway leads.
const PORTAL_COLORS = [0x39d7ff, 0xd06bff, 0xffcf3a, 0x66ff9e, 0xff7a7a, 0x8ab4ff];

/**
 * Everything an object's map sprite is DRAWN from, as one short string — or
 * null for the types whose art never changes once placed.
 *
 * Map sprites are built once and then only nudged (a flag retinted, a count
 * relabelled), which is right for the overwhelming majority of objects and
 * wrong for the few whose picture is a function of mutable state. refreshWorld
 * compares this against the sprite's stored key and rebuilds on a mismatch, so
 * an emptied vault greys out and a REOCCUPIED one comes back — with its new
 * tenants' sprite, since a reload may rotate a Dwarven Treasury into a Dragon
 * Utopia — without anyone having to remember to poke the container by hand.
 */
function objectLook(obj) {
  switch (obj.type) {
    // Looted → dimmed and stripped of its guard pip; bankType picks the sprite.
    case 'creatureBank': return `${obj.bankType}|${obj.looted ? 1 : 0}`;
    // Looted → dimmed; guarded → a red pip (a reload rolls fresh guards).
    case 'pandora': return `${obj.looted ? 1 : 0}|${obj.guards?.length ? 1 : 0}`;
    // A flagged dwelling flies its owner's pennant.
    case 'dwelling': return `${obj.dwellingType}|${obj.owner ?? -1}`;
    // A wandering stack is furniture; a stack that has taken a CAPTAIN is an
    // event, and it flies a standard for it (see the monster case below). The
    // captain arrives mid-game — spawnRonins runs at dawn, on a stack that has
    // been standing there for weeks — so without this the marker would only ever
    // have appeared on a reload, which is precisely when it is no longer news.
    case 'monster': return `${obj.creature}|${isRonin(obj) ? 1 : 0}`;
    default: return null;
  }
}

export class AdventureScene extends Phaser.Scene {
  constructor() {
    super('Adventure');
  }

  // =========================================================================
  // Creation
  // =========================================================================

  create() {
    const state = getState();
    if (!state) {
      this.scene.start('Menu');
      return;
    }
    this.state = state;
    // A player is at the keyboard: assaults on their towns are theirs to FIGHT, not
    // to read about afterwards (core/invasions.assaultIsPlayable). Set on every
    // create, never saved — a headless sim of the same save resolves them at dawn
    // exactly as before.
    state.interactive = true;
    playMusic(this.adventureMood());
    this.selectedHeroId = null;
    // Priced hover cards, keyed by actions.monsterPreviewKey. Per scene life: a new
    // game's keys carry a different map seed and could never hit these anyway, so
    // this is about not holding the memory rather than about correctness.
    this._monsterCards = new Map();
    this.viewLevel = 0;       // which map level is on screen (0 surface, 1 underground)
    this.preview = null;      // { tx, ty, path, totalCost }
    this.moving = false;
    this.aiRunning = false;
    this._followSprite = null; // hero token the camera trails during a walk (auto-follow)
    this.gameOverShown = false;
    this.ui = null;           // AdvUIScene, set via uiReady()
    this.objSprites = new Map();   // object id -> container
    this.heroSprites = new Map();  // hero id -> container
    this.decorSprites = [];        // static tree/rock/mountain images

    this.buildTerrain();
    this.buildDecor();
    this.buildObjects();
    this.buildHeroes();
    // World art is painter-sorted by world y IN PIXELS, so on the largest map a
    // bottom-row tree reaches depth 7,680 — every screen-space layer in this
    // scene has to clear that, and they all come from the one ladder (uikit
    // DEPTH). Fog and the path preview sit just above the world.
    this.fogG = this.add.graphics().setDepth(DEPTH.FOG);
    this.previewG = this.add.graphics().setDepth(DEPTH.FOG + 1);
    this.redrawFog();

    this.buildVignette();
    // Rebuild the vignette live when its setting is toggled (Settings overlays
    // the running adventure). Unsubscribed on shutdown below.
    this._offSettings = onSettingsChange((key) => { if (key === 'vignette') this.buildVignette(); });
    this.bindInput();

    // Start looking at your town, at the player's persisted zoom.
    const home = playerTowns(state, 0)[0] || Object.values(state.towns)[0];
    this.applyCameraBounds();
    this.cameras.main.setZoom(Phaser.Math.Clamp(getSetting('zoom'), CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX));
    this.cameras.main.centerOn(home.x * T, home.y * T);

    const firstHero = playerHeroes(state, 0)[0];
    if (firstHero) this.selectHero(firstHero.id);

    // The raster sprite pack loads off the critical path, so the map above may
    // have first drawn on procedural art. Upgrade it in place once the pack
    // arrives (fixes towns/heroes showing their initial symbolic art).
    if (!this.game.registry.get('spritesReady')) {
      this.game.events.once('sprites-loaded', this.rebuildDynamicArt, this);
    }
    // Belt-and-braces for a straggler that finishes AFTER the boot budget (a big
    // local pack on a cold cache can outrun the loader's deadline): whenever a
    // new sprite texture lands, schedule a debounced rebuild so it swaps in on
    // its own — instead of being stranded as procedural until an unrelated
    // redraw. Bursts coalesce into one rebuild; a walk is never cut mid-step.
    this._onLateSprite = (key) => {
      if (typeof key === 'string' && key.startsWith('sprite_')) this.scheduleArtRebuild();
    };
    this.textures.on('addtexture', this._onLateSprite, this);

    // Fires exactly once; also tear down the global-ScaleManager resize
    // listener registered in buildVignette so it can't outlive this scene.
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.onResizeVignette);
      // Null the handle too: the Scene OBJECT survives a stop/start cycle, and
      // buildVignette only subscribes when the handle is absent (the once-per-
      // scene-life guard) — a stale one would leave the next life unsubscribed.
      this.onResizeVignette = null;
      this._offSettings?.();
      this.game.events.off('sprites-loaded', this.rebuildDynamicArt, this);
      this.textures.off('addtexture', this._onLateSprite, this);
      if (this._artRebuildTimer) { clearTimeout(this._artRebuildTimer); this._artRebuildTimer = null; }
      this.hideHeroHover();
      this.hideObjectTip();
      // Free the canvas textures we parked in the game-wide TextureManager —
      // scene teardown destroys our display objects but never these, so without
      // this they survive a quit to the menu (the terrain chunks are the bulk).
      this.releaseTerrain();
      if (this.textures.exists('vignette')) this.textures.remove('vignette');
      this.scene.stop('AdvUI');
    });
    this.scene.launch('AdvUI', { adventure: this });
  }

  /** Called by AdvUIScene when it has finished building. */
  uiReady(ui) {
    this.ui = ui;
    this.applyCameraBounds(); // now that the real hudWidth is known
    ui.refreshHUD();
    hideOverlay(); // the map is built and on screen — drop the loading cover
    ui.toast(`Week ${weekOf(this.state.day)}, Day ${dayOfWeek(this.state.day)} — your move.`);
    // Remind the player of a special objective (a plain conquest needs no note).
    const vic = this.state.victory || {};
    if (vic.kind || vic.grail) ui.toast(`Objective: ${victoryObjectiveText(this.state)}`);
    // …and the age floor this game runs under, if any (core/ages.js). It decides
    // when a win may SETTLE, which is a thing to know on day one rather than to
    // discover on the day you win and nothing happens.
    const floor = ageFloorText(this.state);
    if (floor) ui.toast(`The age — ${floor}`);
    // Introduce the rival warlords and their temperaments — a fresh game only,
    // so a mid-match restore doesn't re-announce them every load.
    if (this.state.day === 1) {
      // Campaign chapters open with a storyteller's briefing (narrative + foes +
      // charge). A plain skirmish just gets the rival toast below.
      if (isCampaign(this.state)) ui.showChapterIntro?.(currentScenario(this.state));
      const rivals = this.state.players
        .filter((p) => !p.isHuman && p.warlord && CONFIG.WARLORDS[p.warlord])
        .map((p) => `${p.name}, ${CONFIG.WARLORDS[p.warlord].title}`);
      if (rivals.length) ui.toast(`Rivals take the field — ${rivals.join(' · ')}.`);
    }
    // A save made in an odd moment (or a crash mid-AI-turn) can restore with
    // the AI to move; nothing else would ever restart it, so do it here.
    if (this.state.winner === null && currentPlayer(this.state).index !== 0) {
      this.runAITurn();
    }
    // A save of an ALREADY-SETTLED game restores into a world whose every action
    // is gated on `winner !== null`. Nothing used to raise the outcome dialog on
    // load, so such a save opened onto a map that looked simply broken — heroes
    // that will not move, an End Turn that does nothing. The dialog is the only
    // door out of that state (and now the door INTO the plea, which is the whole
    // point of keeping such a save), so put it up the moment the map is on screen.
    if (this.state.winner !== null) this.checkGameOver();
  }

  hudWidth() {
    return this.ui ? this.ui.hudWidth() : 232;
  }

  /**
   * Camera pan bounds. The map fills the whole window while AdvUIScene paints the
   * resource bar over the top (~46px) and the side panel over the right
   * (hudWidth). To stop the map's TOP and RIGHT edges from being permanently
   * hidden behind them, we extend the bounds outward by those covered widths
   * (converted to world px at the widest zoom-out) so the far edges can always be
   * scrolled clear of the HUD. Left/bottom keep the usual 2-tile margin.
   */
  applyCameraBounds() {
    const { w, h } = this.state.map;
    const MINZOOM = CONFIG.ZOOM_MIN; // pad for the widest zoom-out
    const rightPad = Math.ceil(this.hudWidth() / MINZOOM);
    const topPad = Math.ceil(46 / MINZOOM);
    this.cameras.main.setBounds(-T * 2, -T * 2 - topPad, w * T + T * 4 + rightPad, h * T + T * 4 + topPad);
  }

  /**
   * Set the camera zoom (clamped to CONFIG.ZOOM_MIN/MAX), anchored at a screen
   * point (default: the screen centre). Persists the level so it carries across
   * games, and refreshes the HUD readout. The single choke point for every zoom
   * change — wheel, +/- keys, and the HUD buttons all route through here.
   */
  applyZoom(next, ax, ay) {
    const cam = this.cameras.main;
    next = Phaser.Math.Clamp(next, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    const prev = cam.zoom;
    if (next === prev) return;
    ax = ax ?? cam.width / 2; ay = ay ?? cam.height / 2;
    // Anchor the zoom at (ax, ay): the world point under it stays put. Computed
    // analytically — the camera matrix only refreshes on render, so reading
    // getWorldPoint right after setZoom would use stale values.
    const offX = ax - cam.width / 2, offY = ay - cam.height / 2;
    const worldX = cam.scrollX + cam.width / 2 + offX / prev;
    const worldY = cam.scrollY + cam.height / 2 + offY / prev;
    cam.setZoom(next);
    cam.scrollX = worldX - cam.width / 2 - offX / next;
    cam.scrollY = worldY - cam.height / 2 - offY / next;
    setSetting('zoom', next);
    this.ui?.refreshZoomLabel?.();
  }

  /** Multiply the zoom by `factor` (>1 in, <1 out), anchored at the screen centre. */
  nudgeZoom(factor) { this.applyZoom(this.cameras.main.zoom * factor); }

  quitToMenu() {
    this.scene.stop('AdvUI');
    this.scene.start('Menu');
  }

  /** Leave the won chapter for the next chapter's intro (campaign flow).
   *
   *  CLONE: campaigns are not shipped (the registry in data/campaigns.js is empty
   *  and CampaignScene is not registered), so no game here is ever a campaign and
   *  this is unreachable — `isCampaign()` is false for every state. Kept as a
   *  return to the Menu rather than deleted, because the win path calls it by name
   *  and a missing method would be a crash where this is a no-op. */
  toCampaignChapter() {
    this.scene.stop('AdvUI');
    this.scene.start('Menu');
  }

  /**
   * March into the next realm of an endless run: build it from the won one, install
   * it as the live session, save it, and re-enter the map.
   *
   * Restarted rather than continued in place — the state object is wholly new (a
   * fresh map, fresh towns, remade heroes) and every layer this scene holds points
   * into the old one.
   */
  toNextRealm() {
    const next = advanceEndless(this.state);
    if (!next) { this.quitToMenu(); return; }
    setState(next);
    saveGame();
    showOverlay('Forging the next realm…');
    this.scene.stop('AdvUI');
    requestAnimationFrame(() => this.scene.start('Adventure'));
  }

  // ---- view-level helpers: every render reads the level on screen ----------
  /** The grid ({ w, h, tiles, objects }) currently displayed. */
  curMap() { return levelMap(this.state, this.viewLevel); }
  /** The object dict of the displayed level. */
  curObjects() { return levelObjects(this.state, this.viewLevel); }
  /** Is (x,y) explored on the displayed level, for the human player? */
  curExplored(x, y) { return isExplored(this.state, 0, x, y, this.viewLevel); }
  /** Does this game have an underground to descend into? */
  hasUnderground() { return !!this.state.map.underground; }

  /** Flip the displayed level (surface ⇄ underground), if one exists. */
  toggleLevel() {
    if (!this.hasUnderground() || this.moving || this.aiRunning) return;
    this.setViewLevel(this.viewLevel === 0 ? 1 : 0);
    const c = this.cameras.main;
    c.centerOn(c.midPoint.x, c.midPoint.y); // keep the same map area framed
  }

  /**
   * Switch which map level is drawn and rebuild every layer for it. Used by the
   * level toggle and automatically when the followed hero steps through a gate.
   */
  setViewLevel(level) {
    if (level === this.viewLevel || !levelMap(this.state, level)) return;
    this.viewLevel = level;
    this.clearPreview();
    for (const spr of this.decorSprites) spr.destroy();
    this.decorSprites = [];
    for (const spr of this.objSprites.values()) spr.destroy();
    this.objSprites.clear();
    for (const spr of this.heroSprites.values()) spr.destroy();
    this.heroSprites.clear();
    this.buildTerrain();
    this.buildDecor();
    this.buildObjects();
    this.buildHeroes();
    this.redrawFog();
    this.buildGrailMarker();
    this.ui?.onLevelChanged?.(level);
    // Swap the overworld theme to match the level (surface faction theme ↔ the
    // underground theme). Only on the live map — AdvUI is asleep during a battle
    // or town visit, so their music isn't clobbered by a background level change.
    if (this.scene.isActive('AdvUI')) playMusic(this.adventureMood());
  }

  /**
   * Sync the terrain raster registry from the loaded sprite pack: a generated
   * `sprite_terrain_<t>` texture becomes the tile drawTerrainTile blits for that
   * terrain; any terrain without one keeps its procedural tile. Cleared and
   * rebuilt each bake so the registry always mirrors the textures currently
   * loaded (a rebake after the pack arrives swaps the ground in place).
   */
  syncTerrainRasters() {
    clearTerrainRasters();
    const found = [];
    for (const t of Object.keys(TERRAIN_STYLE)) {
      const key = spriteKey(`terrain_${t}`);
      if (this.textures.exists(key)) { setTerrainRaster(t, this.textures.get(key).getSourceImage()); found.push(t); }
    }
    // Returned so buildTerrain's skip-guard is keyed on the SAME reading that the
    // bake itself uses. A guard that asked the texture manager its own separate
    // question could answer differently from the paint it is guarding.
    return found;
  }

  /** True when the loaded pack has at least one `sprite_terrain_<t>` texture. */
  hasTerrainSprites() {
    return Object.keys(TERRAIN_STYLE).some((t) => this.textures.exists(spriteKey(`terrain_${t}`)));
  }

  /**
   * Drop every terrain chunk this scene added to the (game-wide) TextureManager,
   * plus the painted images and the gloom overlay. Called both on rebuild AND on
   * scene shutdown: the canvas textures live in the global manager, so without an
   * explicit release the chunks (2048px each, several per map) stay resident in
   * memory after quitting back to the menu.
   */
  releaseTerrain() {
    for (const key of this._terrainKeys || []) if (this.textures.exists(key)) this.textures.remove(key);
    for (const img of this._terrainImages || []) img.destroy();
    if (this.textures.exists('worldTerrain')) this.textures.remove('worldTerrain'); // legacy single texture
    this._gloom?.destroy();
    this._gloom = null;
    // The season tint is rebuilt by buildTerrain exactly like the gloom, so it
    // must be released here exactly like the gloom: buildTerrain overwrites the
    // only handle, and without this line every surface bake left the previous
    // full-map wash orphaned on the display list — descending stacked the
    // surface tint over the underground, and ten gate round trips rendered ten
    // near-opaque rectangles every frame (measured: one leaked per rebake).
    this._seasonTint?.destroy();
    this._seasonTint = null;
    this._terrainKeys = [];
    this._terrainImages = [];
    // Whatever was still queued was for the bake just thrown away. Leaving it to
    // drain would paint the OLD level's chunks over the new one, a frame at a time.
    this._bakeQueue = [];
    // There is no bake on screen any more, so nothing may claim one is current.
    // buildTerrain re-stamps this immediately after calling here; every other
    // caller (a level flip, scene shutdown) genuinely wants it gone.
    this._terrainSig = null;
  }

  buildTerrain() {
    const map = this.curMap();
    const rasters = this.syncTerrainRasters(); // prefer generated terrain tiles over procedural paint
    // WHAT THIS BAKE IS A FUNCTION OF, and nothing else: the level on screen, its
    // size, and which terrains have a raster tile. Map tiles are written only by
    // the generator (MapGenerator) and never during play, and the season is a wash
    // laid OVER the ground rather than baked into it — so with these three equal,
    // a re-bake repaints the identical pixels.
    //
    // It used to repaint them anyway, several seconds at a time, in the middle of
    // play. Every `sprite_*` texture that lands after the scene starts schedules a
    // dynamic-art rebuild (scheduleArtRebuild), and that rebuild re-baked the
    // terrain whenever the pack had ANY terrain sprite — not when a terrain sprite
    // had actually arrived. A hero portrait finishing late re-tiled the whole
    // world. Measured on the 144×120 preset: three full bakes on entering the map,
    // 4.9s + 2.1s + 2.7s, the last two landing seconds apart while the player was
    // already trying to hover and select. That is the reported freeze.
    //
    // The guard also needs the bake to still BE there — painted, or queued and on
    // its way. releaseTerrain (a level flip, a shutdown) drops both and clears the
    // signature, so a flip away and back re-bakes exactly as before.
    const sig = `${this.viewLevel}|${map.w}x${map.h}|${rasters.join(',')}`;
    if (sig === this._terrainSig && (this._terrainImages?.length || this._bakeQueue?.length)) return;
    this.releaseTerrain();   // clears _terrainSig — set it AFTER, not before
    this._terrainSig = sig;

    // ONE CHUNK PER FRAME, NEAREST THE CAMERA FIRST — see stepTerrainBake.
    // The bake is 20 chunks on the largest preset and the whole run is seconds
    // long; done in one go it is seconds during which the page answers nothing,
    // which is what a player experiences as "it froze before I could hover or
    // select". Queued, each frame pays for one chunk and the map stays live
    // throughout. The fill is very nearly invisible in the case that matters —
    // on entering a map, everything but the starting neighbourhood is under fog,
    // and fog is drawn over the ground whether that ground is painted yet or not.
    this._bakeQueue = [];
    for (let cy0 = 0; cy0 < map.h; cy0 += TERRAIN_CHUNK) {
      for (let cx0 = 0; cx0 < map.w; cx0 += TERRAIN_CHUNK) this._bakeQueue.push([cx0, cy0]);
    }
    // Underground gloom: a dark wash over the terrain (above the ground, below
    // decor/objects/heroes) so the cavern reads as subterranean. releaseTerrain()
    // above already cleared any prior gloom.
    if (this.viewLevel === 1) {
      this._gloom = this.add.rectangle(-T * 2, -T * 2, map.w * T + T * 4, map.h * T + T * 4, 0x05030a, 0.5)
        .setOrigin(0).setDepth(0.5);
    }
    // Seasonal wash on the SURFACE: a faint tint over the ground (above terrain,
    // below decor/objects) so the world reads as the current season — the
    // "re-baked terrain" beat. Refreshed on season turns (see applySeasonTint).
    if (this.viewLevel === 0) {
      this._seasonTint = this.add.rectangle(-T * 2, -T * 2, map.w * T + T * 4, map.h * T + T * 4, 0xffffff, 0)
        .setOrigin(0).setDepth(0.45);
      this.applySeasonTint();
    }
  }

  /**
   * Paint ONE terrain chunk and park it in the world.
   *
   * Lifted out of buildTerrain's double loop unchanged, so the queued bake paints
   * exactly the pixels the all-at-once bake did — the clip invariants in
   * tests/terrain-clip.test.js are statements about this function's body and stay
   * statements about it.
   */
  bakeTerrainChunk(cx0, cy0) {
    const map = this.curMap();
    const CHUNK = TERRAIN_CHUNK;
    const dirs = [[0, -1, 0], [1, 0, 1], [0, 1, 2], [-1, 0, 3]];
    const cw = Math.min(CHUNK, map.w - cx0);
    const chh = Math.min(CHUNK, map.h - cy0);
    const canvas = makeCanvas(cw * T, chh * T);
    const ctx = canvas.getContext('2d');
    // Paint in WORLD coordinates, offset into the chunk: the seeded macro /
    // ground-cover passes then tile seamlessly across chunk borders (their
    // noise keys off world position). Off-chunk draws simply clip.
    ctx.translate(-cx0 * T, -cy0 * T);
    for (let y = cy0; y < cy0 + chh; y++) {
      for (let x = cx0; x < cx0 + cw; x++) {
        const tile = map.tiles[y * map.w + x];
        drawTerrainTile(ctx, x * T, y * T, T, tile.terrain, tile.decor);
      }
    }
    // Feathered transitions (painted within each tile's own cell, so a
    // chunk-edge tile's transition toward an out-of-chunk neighbour still
    // lands inside this chunk — no seam).
    for (let y = cy0; y < cy0 + chh; y++) {
      for (let x = cx0; x < cx0 + cw; x++) {
        const tile = map.tiles[y * map.w + x];
        for (const [dx, dy, side] of dirs) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
          const n = map.tiles[ny * map.w + nx];
          if (n.terrain !== tile.terrain) {
            paintTransition(ctx, x * T, y * T, T, side, baseColorOf(n.terrain));
          }
        }
      }
    }
    // Whole-map cohesion passes (large-scale luminance undulation to dissolve
    // the tile grid; baked ground cover under obstacle clusters). Run over the
    // full map under the chunk's translate so seams align — but told which
    // rectangle this chunk actually shows, so each pass skips the canvas work
    // for everything that would only be clipped away. Without the rect every
    // pass repainted the WHOLE map once per chunk (20 chunks on the largest
    // preset ⇒ ~95% of ~103k gradient fills discarded, a multi-second stall
    // on every level flip). The passes keep their rng streams intact for
    // skipped elements, so the bake is pixel-identical either way
    // (tests/terrain-clip.test.js, tests/smoke/terrain-clip-smoke.mjs).
    const clip = { x0: cx0 * T, y0: cy0 * T, x1: (cx0 + cw) * T, y1: (cy0 + chh) * T };
    paintMacroVariation(ctx, map, T, clip);
    paintGroundCover(ctx, map, T, clip);
    paintRoads(ctx, map, T, clip); // fast highways connecting the towns, baked in

    const key = `worldTerrain_${cx0}_${cy0}`;
    this.textures.addCanvas(key, canvas);
    this._terrainKeys.push(key);
    this._terrainImages.push(this.add.image(cx0 * T, cy0 * T, key).setOrigin(0).setDepth(0));
  }

  /**
   * Advance the queued terrain bake — called once per frame from update().
   *
   * Nearest the camera FIRST, re-evaluated every frame rather than fixed when the
   * queue was built: the player can pan while the ground is still filling in, and
   * the chunk they are looking at is the only one whose absence they can see. A
   * fixed order would happily paint the far corner while the screen under the
   * cursor stayed black.
   *
   * The budget is a wall-clock slice with a floor of one chunk, so a fast machine
   * finishes the map in a frame or two and a slow one still makes progress every
   * frame instead of stalling until it can afford the lot.
   */
  stepTerrainBake() {
    const q = this._bakeQueue;
    if (!q || !q.length) return;
    const cam = this.cameras.main;
    const mid = { x: cam.scrollX + cam.width / cam.zoom / 2, y: cam.scrollY + cam.height / cam.zoom / 2 };
    const t0 = performance.now();
    do {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < q.length; i++) {
        const dx = (q[i][0] + TERRAIN_CHUNK / 2) * T - mid.x,
              dy = (q[i][1] + TERRAIN_CHUNK / 2) * T - mid.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      const [cx0, cy0] = q.splice(best, 1)[0];
      this.bakeTerrainChunk(cx0, cy0);
    } while (q.length && performance.now() - t0 < 8);
  }

  /**
   * Finish the queued bake now.
   *
   * For anything that needs the whole ground painted at a known moment rather
   * than a few frames later — a screenshot, a pixel comparison, a test that
   * counts chunks. Ordinary play never calls it: waiting for the map is the cost
   * this queue exists to avoid.
   */
  finishTerrainBake() {
    while (this._bakeQueue?.length) {
      const [cx0, cy0] = this._bakeQueue.shift();
      this.bakeTerrainChunk(cx0, cy0);
    }
  }

  /** Tint the surface toward the current season's colour (a gentle wash). */
  applySeasonTint() {
    if (!this._seasonTint) return;
    const season = CONFIG.SEASONS[seasonOf(this.state.day)];
    // The opening season leaves the map untinted; the others lay a faint wash.
    const alpha = seasonOf(this.state.day) === 0 ? 0 : 0.16;
    this._seasonTint.setFillStyle(season.tint, alpha);
  }

  /** Screen-fixed vignette for depth (darkens the corners of the viewport).
   *  Opt-out via the 'vignette' setting — then the map edges stay flat/clear. */
  buildVignette() {
    if (!getSetting('vignette')) { this.vignette?.destroy(); this.vignette = null; return; }
    const W = this.scale.width, H = this.scale.height;
    if (this.textures.exists('vignette')) this.textures.remove('vignette');
    const canvas = makeCanvas(256, 256);
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(128, 118, 40, 128, 128, 168);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.7, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(6,6,14,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    this.textures.addCanvas('vignette', canvas);
    this.vignette?.destroy();
    this.vignette = this.add.image(W / 2, H / 2, 'vignette')
      .setDisplaySize(W + 4, H + 4).setScrollFactor(0).setDepth(DEPTH.FOG - 1000).setName('vignette');
    // Registered ONCE per scene life, not once per call: buildVignette re-runs
    // on every off→on toggle of the setting, and re-subscribing here used to
    // overwrite the only handle to the previous closure — shutdown could then
    // `off` exactly one, permanently leaking a listener on the game-wide
    // ScaleManager per toggle (measured: +1 per toggle). The closure reads
    // everything through `this`, so the first one stays correct across
    // rebuilds; when the vignette is off it early-returns and costs nothing.
    // Stored as a stable reference so scene shutdown can `off` it (the
    // ScaleManager is global and would otherwise retain this dead scene).
    if (!this.onResizeVignette) {
      this.onResizeVignette = () => {
        if (!this.vignette) return;
        this.vignette.setPosition(this.scale.width / 2, this.scale.height / 2)
          .setDisplaySize(this.scale.width + 4, this.scale.height + 4);
      };
      this.scale.on('resize', this.onResizeVignette);
    }
  }

  /**
   * A soft white radial blob, reused (via tint) for ground decals and contact
   * shadows so decor sits *in* the terrain instead of floating as a cut-out.
   */
  ensureGroundBlob() {
    if (this.textures.exists('groundBlob')) return;
    const s = 96;
    const canvas = makeCanvas(s, s);
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    this.textures.addCanvas('groundBlob', canvas);
  }

  buildDecor() {
    this.ensureGroundBlob();
    const map = this.curMap();
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const tile = map.tiles[y * map.w + x];
        if (!tile.obstacle) continue;
        const key = decorTextureFor(tile.obstacle, tile.terrain, tile.decor);
        const jx = ((tile.decor % 7) - 3) * 1.5;
        const px = x * T + T / 2 + jx;
        const py = y * T + T;
        // Prefer the raster decor sprite; scale it to the procedural texture's
        // height so trees/rocks/mountains keep their original on-map footprint.
        const useSprite = this.textures.exists(spriteKey(key));
        const img = this.add.image(px, py, useSprite ? spriteKey(key) : key)
          .setOrigin(0.5, 0.94).setDepth(py);
        if (useSprite) img.setScale(this.textures.get(key).getSourceImage().height / img.height);
        // Contact shadow so the object grips the ground (the broader forest /
        // stony floor is baked into the terrain by paintGroundCover).
        const w = img.displayWidth;
        const shadow = this.add.image(px + w * 0.04, py - 2, 'groundBlob')
          .setDisplaySize(w * 0.9, w * 0.4).setTint(0x000000).setAlpha(0.34).setDepth(py - 1);
        this.decorSprites.push(shadow, img);
      }
    }
  }

  /**
   * Add a map image at (x, y) that prefers the raster sprite `sprite_<key>` and
   * falls back to the procedural texture `<key>`. A used sprite is scaled to the
   * procedural texture's height so it keeps the same on-map footprint (the
   * procedural art defines the intended size; raster renders are square).
   */
  mapArt(key, x, y, mult = 1) {
    if (this.textures.exists(spriteKey(key))) {
      const img = this.add.image(x, y, spriteKey(key));
      img.setScale((this.textures.get(key).getSourceImage().height / img.height) * mult);
      return img;
    }
    const img = this.add.image(x, y, key);
    if (mult !== 1) img.setScale(mult);
    return img;
  }

  /**
   * If a generated sprite exists for `key`, add it to container `c` fitted like a
   * map object (≈1.4 tiles, standing on the tile base) and return true; else leave
   * `c` untouched and return false so the caller draws its procedural shape. `tint`
   * colours the raster for keyed props (border guards / keymaster tents) whose
   * colour is the gameplay signal — one neutral sprite serves every key colour,
   * exactly like the faction-tinted building glyphs.
   */
  placeObjectSprite(c, key, tint) {
    if (!hasSprite(this, key)) return false;
    const img = this.add.image(0, 2, spriteKey(key)).setOrigin(0.5, 0.55);
    img.setScale(Math.min((T * 1.4) / img.width, (T * 1.4) / img.height));
    if (tint != null) img.setTint(tint);
    c.add(img);
    return true;
  }

  buildObjects() {
    for (const obj of Object.values(this.curObjects())) {
      this.spawnObjectSprite(obj);
    }
  }

  spawnObjectSprite(obj) {
    const px = obj.x * T + T / 2;
    const py = obj.y * T + T / 2;
    const c = this.add.container(px, py).setDepth(obj.y * T + T * 0.8);
    c.lookKey = objectLook(obj); // what this sprite was drawn from (see refreshWorld)
    const shadow = this.add.ellipse(0, T * 0.3, T * 0.7, T * 0.22, 0x000000, 0.25);
    c.add(shadow);
    // These connectors/sea-props draw procedurally below, but if the sprite pack
    // ships a raster for one (see scripts/sprites/manifest.js) we prefer it — a
    // static icon like mines/towns. Types with their own mapArt path are
    // unaffected (they already load rasters themselves).
    const RASTER_OBJECT = { boat: 'boat', portal: 'portal', subGate: 'subgate', whirlpool: 'whirlpool', shipyard: 'shipyard' }[obj.type];
    if (RASTER_OBJECT && hasSprite(this, RASTER_OBJECT)) {
      const img = this.add.image(0, 2, spriteKey(RASTER_OBJECT)).setOrigin(0.5, 0.55);
      img.setScale(Math.min((T * 1.4) / img.width, (T * 1.4) / img.height));
      c.add(img);
      this.objSprites.set(obj.id, c);
      return c;
    }
    switch (obj.type) {
      case 'town': {
        const town = this.state.towns[obj.townId];
        // Castles read ~2x the size of everything else on the map (a hero token
        // is ~1.5 tiles; the castle is ~3), and stand on the tile's base.
        shadow.setSize(T * 1.9, T * 0.4);
        const castle = townIcon(this, FACTIONS[town.faction].townGlyph, 0, T * 0.5, 190);
        castle.setOrigin(0.5, 1);
        c.add(castle);
        c.flag = this.add.image(-castle.displayWidth * 0.28, T * 0.5 - castle.displayHeight * 0.82,
          town.owner >= 0 ? `flag_${bannerSlot(this.state, town.owner)}` : 'flag_0');
        c.flag.setVisible(town.owner >= 0);
        c.add(c.flag);
        c.add(this.add.text(0, T * 0.5 + 14, town.name, {
          fontFamily: FONT, fontSize: '12px', color: '#fff', stroke: '#000', strokeThickness: 3,
        }).setOrigin(0.5));
        break;
      }
      case 'mine': {
        c.add(this.mapArt(`mine_${obj.mineType}`, 0, 2));
        c.flag = this.add.image(18, -18, obj.owner >= 0 ? `flag_${bannerSlot(this.state, obj.owner)}` : 'flag_0');
        c.flag.setVisible(obj.owner >= 0);
        c.add(c.flag);
        break;
      }
      case 'resource':
        c.add(this.mapArt(`res_${obj.resource}`, 0, 4, 1.15));
        break;
      case 'chest':
        c.add(this.mapArt('chest', 0, 4));
        break;
      case 'artifact':
        c.add(this.add.image(0, 6, 'pedestal'));
        if (hasSprite(this, obj.artifact)) {
          const a = this.add.image(0, -18, spriteKey(obj.artifact));
          a.setScale((T * 0.7) / a.height);
          c.add(a);
        } else {
          c.add(this.add.image(0, -18, `art_${obj.artifact}`).setScale(0.62));
        }
        break;
      case 'booster':
        c.add(this.mapArt(`boost_${obj.boosterType}`, 0, 2));
        break;
      case 'seerHut':
        c.add(this.mapArt('boost_seerHut', 0, 2));
        break;
      case 'tradingPost':
        c.add(this.mapArt('boost_tradingPost', 0, 2));
        break;
      case 'dwelling': {
        // A raster lodge if the pack ships one (dwelling_<type>), else a little
        // roofed lodge with its roof tinted by the creature it musters. Either way
        // it flies a pennant once a realm has flagged it.
        if (!this.placeObjectSprite(c, `dwelling_${obj.dwellingType}`)) {
          const roofTint = CREATURES[dwellingCreature(obj)]?.tint ?? 0x8a6a48;
          const base = this.add.rectangle(0, T * 0.22, T * 0.66, T * 0.42, 0x6b5636).setStrokeStyle(2, 0x241c14, 0.9);
          const roof = this.add.triangle(0, -T * 0.06, -T * 0.44, T * 0.14, T * 0.44, T * 0.14, 0, -T * 0.34, roofTint).setStrokeStyle(2, 0x241c14, 0.9);
          const door = this.add.rectangle(0, T * 0.3, T * 0.18, T * 0.26, 0x1a120a);
          c.add([base, roof, door]);
        }
        if (obj.owner >= 0) { // a flagged site flies a pennant
          c.add(this.add.rectangle(T * 0.34, -T * 0.18, 2, T * 0.4, 0x3a2c1a));
          c.add(this.add.triangle(T * 0.34, -T * 0.34, 0, -6, 0, 8, T * 0.22, 1, 0xf0d060));
        }
        break;
      }
      case 'keymaster': {
        // A striped pavilion tent flying a pennant in the key's colour.
        const tint = CONFIG.KEY_COLORS.find((k) => k.id === obj.color)?.tint ?? 0x999999;
        if (this.placeObjectSprite(c, 'keymaster', tint)) break; // generated raster, tinted per key colour
        const tent = this.add.triangle(0, 6, -T * 0.42, T * 0.34, T * 0.42, T * 0.34, 0, -T * 0.32, 0xe9e0c8);
        const stripe = this.add.triangle(0, 6, -T * 0.15, T * 0.34, T * 0.15, T * 0.34, 0, -T * 0.32, tint);
        const pole = this.add.rectangle(0, -T * 0.32, 2, T * 0.24, 0x5a4326);
        const flag = this.add.triangle(0, -T * 0.46, 0, -6, 0, 8, T * 0.26, 1, tint);
        c.add([tent, stripe, pole, flag]);
        break;
      }
      case 'borderGuard': {
        // A striped barrier bar in the guard's colour, slung between two posts.
        const tint = CONFIG.KEY_COLORS.find((k) => k.id === obj.color)?.tint ?? 0x999999;
        if (this.placeObjectSprite(c, 'borderGuard', tint)) break; // generated raster, tinted per key colour
        const postL = this.add.rectangle(-T * 0.32, 4, 5, T * 0.72, 0x3a2c1a);
        const postR = this.add.rectangle(T * 0.32, 4, 5, T * 0.72, 0x3a2c1a);
        const bar = this.add.rectangle(0, -T * 0.12, T * 0.78, T * 0.22, tint).setStrokeStyle(2, 0x1a140a, 1);
        const s1 = this.add.rectangle(-T * 0.17, -T * 0.12, T * 0.1, T * 0.22, 0x1a140a, 0.45);
        const s2 = this.add.rectangle(T * 0.17, -T * 0.12, T * 0.1, T * 0.22, 0x1a140a, 0.45);
        c.add([postL, postR, bar, s1, s2]);
        break;
      }
      case 'creatureBank': {
        // A generated raster per bank type (griffinConservatory, dragonUtopia, …)
        // wins when present; else the procedural rocky-lair mound below.
        if (this.placeObjectSprite(c, `bank_${obj.bankType}`)) {
          if (obj.looted) c.list.forEach((o) => o.setAlpha?.(0.6));
          break;
        }
        // A rocky lair mound with a dark maw; a hoard glint + a red guard pip
        // while it holds treasure, dimmed once plundered.
        const looted = obj.looted;
        const mound = this.add.ellipse(0, T * 0.24, T * 1.05, T * 0.66, looted ? 0x4a4640 : 0x6b5a44).setStrokeStyle(2, 0x241c14, 0.9);
        const top = this.add.triangle(0, -T * 0.16, -T * 0.36, T * 0.22, T * 0.36, T * 0.22, 0, -T * 0.36, looted ? 0x555049 : 0x7a6a50).setStrokeStyle(2, 0x241c14, 0.9);
        const maw = this.add.ellipse(0, T * 0.3, T * 0.4, T * 0.38, 0x0b0a08);
        c.add([mound, top, maw]);
        if (!looted) {
          c.add(this.add.triangle(0, T * 0.3, -5, 4, 5, 4, 0, -6, 0xffd873)); // gold glint in the maw
          c.add(this.add.circle(T * 0.36, -T * 0.3, 5, 0xc23b2b).setStrokeStyle(1.5, 0x1a140a, 1)); // guarded pip
        } else {
          c.list.forEach((o) => o.setAlpha?.(0.6));
        }
        break;
      }
      case 'pandora': {
        // A generated raster wins when present; else the procedural rune-box below.
        if (this.placeObjectSprite(c, 'pandora')) {
          if (obj.looted) c.list.forEach((o) => o.setAlpha?.(0.55));
          break;
        }
        // A rune-etched box wreathed in violet mystery: a lidded chest, a bright
        // arcane sparkle, a red guard pip while it is guarded, all dimmed once
        // the box has been opened (an empty, spent husk).
        const looted = obj.looted;
        const guarded = !looted && obj.guards && obj.guards.length;
        const glow = this.add.ellipse(0, T * 0.08, T * 1.02, T * 0.9, 0x8a3ff0, looted ? 0.06 : 0.2);
        const body = this.add.rectangle(0, T * 0.16, T * 0.68, T * 0.44, looted ? 0x4a4152 : 0x6a4fa0).setStrokeStyle(2, 0x241633, 0.95);
        const lid = this.add.rectangle(0, T * -0.1, T * 0.74, T * 0.22, looted ? 0x554b60 : 0x7d63b8).setStrokeStyle(2, 0x241633, 0.95);
        const band = this.add.rectangle(0, T * 0.16, T * 0.12, T * 0.44, 0xd9c26a, looted ? 0.5 : 1); // gilt clasp band
        const lock = this.add.circle(0, T * 0.02, T * 0.09, looted ? 0x8a7f6a : 0xf0d878).setStrokeStyle(1.5, 0x241633, 1);
        c.add([glow, body, lid, band, lock]);
        if (!looted) {
          // A four-pointed arcane sparkle over the lock.
          c.add(this.add.star(0, T * -0.28, 4, T * 0.05, T * 0.18, 0xf0e6ff, 0.95));
          if (guarded) c.add(this.add.circle(T * 0.34, T * -0.28, 5, 0xc23b2b).setStrokeStyle(1.5, 0x1a140a, 1)); // guarded pip
        } else {
          c.list.forEach((o) => o.setAlpha?.(0.55));
        }
        break;
      }
      case 'portal': {
        // A glowing gateway: a coloured halo, a dark oval mouth ringed by the
        // pair's colour, and a pulsing bright core so it reads as magical from
        // across the map. A linked pair shares its colour. View-only — no state.
        const col = PORTAL_COLORS[(obj.color ?? 0) % PORTAL_COLORS.length];
        const halo = this.add.ellipse(0, 2, T * 0.98, T * 1.18, col, 0.16);
        const mouth = this.add.ellipse(0, 0, T * 0.66, T * 0.92, 0x0a0616, 0.95);
        const ring = this.add.ellipse(0, 0, T * 0.66, T * 0.92).setStrokeStyle(5, col, 1);
        const inner = this.add.ellipse(0, 0, T * 0.4, T * 0.6, col, 0.5);
        const core = this.add.ellipse(0, 0, T * 0.16, T * 0.26, 0xffffff, 0.8);
        c.add([halo, mouth, ring, inner, core]);
        const pulse = this.tweens.add({
          targets: [inner, core], scaleX: 1.25, scaleY: 1.25, alpha: 0.7,
          duration: 850, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
        const glow = this.tweens.add({
          targets: halo, scaleX: 1.15, scaleY: 1.15, alpha: 0.3,
          duration: 1300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
        c.once('destroy', () => { pulse.remove(); glow.remove(); }); // no orphaned tweens
        break;
      }
      case 'monolith': {
        // A one-way standing-stone gate: two rough pillars + a lintel with a
        // coloured veil between them. An ENTRANCE glows and pulses (step in →
        // swept to a matching exit); an EXIT is a dimmer, inert arch you only
        // ever arrive at. A chevron marks the direction (▼ in / ▲ out).
        const col = PORTAL_COLORS[(obj.color ?? 0) % PORTAL_COLORS.length];
        const entrance = obj.dir === 'entrance';
        // Prefer a raster gate (tinted by the portal colour) if the pack ships one;
        // else the procedural pillars + veil. Either way the chevron marks the
        // direction and an ENTRANCE pulses — so the raster keeps both signals.
        let pulseTarget;
        if (hasSprite(this, 'monolith')) {
          const img = this.add.image(0, 2, spriteKey('monolith')).setOrigin(0.5, 0.55);
          img.setScale(Math.min((T * 1.4) / img.width, (T * 1.4) / img.height));
          img.setTint(col);
          if (!entrance) img.setAlpha(0.7); // an exit reads dimmer/inert
          c.add(img);
          pulseTarget = img;
        } else {
          const stone = 0x6b6470;
          const veil = this.add.rectangle(0, T * 0.08, T * 0.34, T * 0.66, col, entrance ? 0.55 : 0.22);
          const pillarL = this.add.rectangle(-T * 0.28, T * 0.06, T * 0.2, T * 0.86, stone).setStrokeStyle(2, 0x2a2630, 1);
          const pillarR = this.add.rectangle(T * 0.28, T * 0.06, T * 0.2, T * 0.86, stone).setStrokeStyle(2, 0x2a2630, 1);
          const lintel = this.add.rectangle(0, -T * 0.34, T * 0.86, T * 0.2, stone).setStrokeStyle(2, 0x2a2630, 1);
          c.add([veil, pillarL, pillarR, lintel]);
          pulseTarget = veil;
        }
        const chev = entrance
          ? this.add.triangle(0, T * 0.1, -6, -5, 6, -5, 0, 6, 0xffffff, 0.9)   // ▼ enter
          : this.add.triangle(0, T * 0.1, -6, 5, 6, 5, 0, -6, col, 0.95);       // ▲ exit
        c.add(chev);
        if (entrance) {
          const pulse = this.tweens.add({
            targets: pulseTarget, alpha: 0.9, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
          });
          c.once('destroy', () => pulse.remove());
        }
        break;
      }
      case 'whirlpool': {
        // A swirling sea vortex: a dark funnel ringed in teal with spiral arms
        // that rotate continuously, so it reads as a WHIRLPOOL (a moving hazard,
        // distinct from a portal's standing gateway). Sits flat on the water.
        const disc = this.add.ellipse(0, 2, T * 0.9, T * 0.9, 0x0a2233, 0.9);
        const ring1 = this.add.ellipse(0, 2, T * 0.9, T * 0.9).setStrokeStyle(3, 0x53c7d6, 0.85);
        const ring2 = this.add.ellipse(0, 2, T * 0.56, T * 0.56).setStrokeStyle(2, 0x8fe9f0, 0.7);
        const eye = this.add.ellipse(0, 2, T * 0.14, T * 0.14, 0x061620, 1);
        const swirl = this.add.container(0, 2);
        const arms = 7;
        for (let k = 0; k < arms; k++) {
          const a = (k / arms) * Math.PI * 2;
          const r = T * (0.12 + 0.3 * (k / arms));
          swirl.add(this.add.ellipse(Math.cos(a) * r, Math.sin(a) * r, T * 0.1, T * 0.1, 0x9fe8f2, 0.75));
        }
        c.add([disc, ring1, ring2, swirl, eye]);
        const spin = this.tweens.add({
          targets: swirl, angle: 360, duration: 3200, repeat: -1, ease: 'Linear',
        });
        const pulse = this.tweens.add({
          targets: ring2, scaleX: 1.2, scaleY: 1.2, alpha: 0.4,
          duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
        c.once('destroy', () => { spin.remove(); pulse.remove(); });
        break;
      }
      case 'boat': {
        // A moored boat waiting on the water: hull + a small mast and sail.
        c.add(this.makeBoatHull());
        const mast = this.add.rectangle(0, 4, 3, 26, 0x4a3320).setOrigin(0.5, 1);
        const sail = this.add.triangle(4, -8, 0, 0, 0, 22, 15, 11, 0xf1e6c8, 0.95);
        c.add([mast, sail]);
        const bob = this.tweens.add({
          targets: c.list.slice(-3), y: '+=2', duration: 1100,
          yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
        c.once('destroy', () => bob.remove());
        break;
      }
      case 'shipyard': {
        // A coastal dock: a plank platform on posts with an anchor — a place to
        // build a boat, not a boat itself.
        const g = this.add.graphics();
        g.fillStyle(0x000000, 0.25); g.fillEllipse(0, 26, T * 0.8, T * 0.22);
        g.fillStyle(0x6b4a2b, 1); g.fillRect(-T * 0.42, 6, T * 0.84, 8);     // deck
        g.fillStyle(0x4a3320, 1); g.fillRect(-T * 0.36, 14, 5, 12); g.fillRect(T * 0.3, 14, 5, 12); // posts
        c.add(g);
        const anchor = this.add.text(0, -12, '⚓', {
          fontFamily: FONT, fontSize: '22px', color: '#cfe4ff', stroke: '#0a1420', strokeThickness: 3,
        }).setOrigin(0.5);
        c.add(anchor);
        break;
      }
      case 'subGate': {
        // A stone-ringed shaft between the levels: on the surface it reads as a
        // cave mouth going DOWN (▼); underground, a lit shaft going UP (▲). A
        // pair shares a channel colour. `obj.z`/level is implied by which grid
        // it lives in — we key the arrow off the level being viewed.
        const col = PORTAL_COLORS[(obj.color ?? 0) % PORTAL_COLORS.length];
        const rim = this.add.ellipse(0, 2, T * 0.82, T * 0.5, 0x2a2320, 1).setStrokeStyle(5, 0x6b5a44, 1);
        const shaft = this.add.ellipse(0, 2, T * 0.52, T * 0.3, 0x05030a, 1);
        const glow = this.add.ellipse(0, 2, T * 0.34, T * 0.2, col, 0.55);
        const arrow = this.add.text(0, 2, this.viewLevel === 1 ? '▲' : '▼', {
          fontFamily: FONT, fontSize: '18px', fontStyle: 'bold', color: '#ffe9b0', stroke: '#000', strokeThickness: 3,
        }).setOrigin(0.5);
        c.add([rim, shaft, glow, arrow]);
        const pulse = this.tweens.add({
          targets: glow, alpha: 0.85, scaleX: 1.25, scaleY: 1.25,
          duration: 950, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        });
        c.once('destroy', () => pulse.remove());
        break;
      }
      case 'monster': {
        // A WAR-BAND wears the same creature sprite as any wandering stack, so
        // on the map it reads as one more guard to walk around — the reported
        // experience is a HUD line saying a band is attacking and no way to find
        // it. Ring it: a pulsing hostile aura under the sprite, drawn BEFORE the
        // creature so the art still leads. Ordinary neutrals get nothing, which
        // is the whole point — the ring means "this one is coming for you".
        if (obj.invader) {
          const aura = this.add.ellipse(0, 6, 62, 46, 0xff3b30, 0.22)
            .setStrokeStyle(2.5, 0xff6b5e, 0.95);
          c.add(aura);
          const auraPulse = this.tweens.add({
            targets: aura,
            scaleX: 1.18, scaleY: 1.18, alpha: 0.55,
            duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
          });
          // Same discipline as the portal/whirlpool/boat/subGate cases above:
          // Phaser does not kill a tween when its target is destroyed, and this
          // container IS destroyed on routine paths (refreshWorld, level flips,
          // art rebuilds) — without the hook, one zombie tween per band ever
          // spawned kept writing to a dead ellipse until scene shutdown.
          c.once('destroy', () => auraPulse.remove());
        }
        // A band with a CAPTAIN. Same creatures, same count, and until now the
        // same token as the leaderless stack on the next hill — so the first a
        // player heard of the commander was either a tavern offering to sell it
        // to them, or a hero appearing across the field of a fight they had
        // already committed to. A battle you cannot see coming is one you cannot
        // decline, and declining fights is most of what an adventure map is for.
        //
        // Deliberately NOT the war-band's treatment above. That mark is red and
        // it pulses, because a band is marching at you; a ronin is not your
        // enemy — it fights for whoever was attacked, which is as often you as
        // not. So this one is still, and bone rather than any realm's colour: it
        // says "somebody commands these", not "these are hostile".
        //
        // A STANDARD RATHER THAN A RING. The first version drew a pale ellipse on
        // the ground under the band, which was the obvious low-zoom mark and the
        // wrong one: the selected hero already stands in a pale gold ellipse
        // (selRing, 0xffe9a0), and at map scale the two were the same object. The
        // screenshot said so immediately and no assertion ever would have. A
        // banner changes the token's SILHOUETTE instead, which nothing else on
        // the map does — the same lesson the scry shield learned when its inner
        // bar read as a minus sign and the outline had to carry the meaning.
        // Added after the count label so it draws over the creature art.
        const roninLed = isRonin(obj);
        // Prefer the raster creature sprite (contain-fit ~one tile); fall back
        // to the procedural token. The sprite id is the creature id; the
        // procedural texture is `token_<id>`, so mapArt() can't be reused here.
        if (hasSprite(this, obj.creature)) {
          const m = this.add.image(0, -2, spriteKey(obj.creature)).setOrigin(0.5, 0.5);
          m.setScale(Math.min(60 / m.width, 60 / m.height));
          c.add(m);
        } else {
          c.add(this.add.image(0, -4, `token_${obj.creature}`).setScale(0.82));
        }
        c.countLabel = this.add.text(0, 20, '', {
          fontFamily: FONT, fontSize: '12px', fontStyle: 'bold',
          color: COUNT_RESTING, stroke: '#000', strokeThickness: 3,
        }).setOrigin(0.5);
        this.paintCount(c.countLabel, obj);
        c.add(c.countLabel);
        if (roninLed) c.add(this.roninStandard());
        break;
      }
      default:
        break;
    }
    this.objSprites.set(obj.id, c);
    return c;
  }

  buildHeroes() {
    for (const hero of Object.values(this.state.heroes)) {
      if ((hero.z ?? 0) === this.viewLevel) this.spawnHeroSprite(hero);
    }
  }

  spawnHeroSprite(hero) {
    const c = this.add.container(hero.x * T + T / 2, hero.y * T + T / 2);
    const shadow = this.add.ellipse(0, 26, 40, 12, 0x000000, 0.3);
    // Every hero shows as a generic mounted rider carrying the owner's banner —
    // the raster horseman when a sprite pack provided one, else the procedural
    // coloured rider. The hero's own portrait is revealed on hover.
    const riderKey = `hero_rider_${bannerSlot(this.state, hero.owner)}`;
    let rider;
    if (hasSprite(this, riderKey)) {
      rider = this.add.image(0, 28, spriteKey(riderKey)).setOrigin(0.5, 1);
      rider.setScale((T * 1.5) / rider.height);
    } else if (hasSprite(this, hero.rosterId)) {
      // No banner rider generated — fall back to the hero's own full-body sprite
      // rather than the bare procedural symbol.
      rider = this.add.image(0, 28, spriteKey(hero.rosterId)).setOrigin(0.5, 1);
      rider.setScale((T * 1.5) / rider.height);
    } else {
      rider = this.add.image(0, 0, riderKey);
    }
    // A boat hull under the rider, shown only while the hero is aboard.
    const boatHull = this.makeBoatHull().setVisible(!!hero.onBoat);
    c.add([shadow, boatHull, rider]);
    c.boatHull = boatHull;
    c.setDepth(hero.y * T + T);
    // No hand-cursor: showHeroHover drives a bespoke multi-state pointer (info /
    // sword / exchange / arrow) that the browser's 'pointer' would clobber.
    rider.setInteractive({ useHandCursor: false })
      .on('pointerover', () => this.showHeroHover(hero))
      .on('pointerout', () => this.hideHeroHover());
    this.heroSprites.set(hero.id, c);
    return c;
  }

  /**
   * A masterless captain's standard: a staff with a pennant, planted at the left
   * of the band so it flies clear of the creature art rather than over it.
   *
   * Bone-gold, in a game where every flag on the map is a realm's colour. That is
   * the whole message — this band answers to somebody, and that somebody is not a
   * player. Drawn with the same outline-then-fill idiom as scryFlag so it reads
   * against grass, snow and lava alike; kept inside the tile so a band on a
   * crowded road does not plant its banner in the neighbour's square.
   */
  roninStandard() {
    const g = this.add.graphics();
    const sx = -T * 0.32, top = -T * 0.56, foot = T * 0.30;
    g.lineStyle(3.4, 0x11131a, 0.9);   // dark backing, so the staff reads on snow
    g.beginPath(); g.moveTo(sx, foot); g.lineTo(sx, top); g.strokePath();
    g.lineStyle(1.5, 0xd8c7a0, 0.95);
    g.beginPath(); g.moveTo(sx, foot); g.lineTo(sx, top); g.strokePath();
    // A PLAIN triangle, and bone. Every realm banner on this map is a notched,
    // waving pennant in one of the four player colours or an invader's (see
    // gfx/tokens flag_<slot>), so shape and colour both say the same thing here:
    // this band flies nobody's livery. Gold would have been the obvious choice
    // and is the one to avoid — a player's fourth banner colour IS gold.
    const tip = sx - T * 0.26, hi = top + 1, lo = top + T * 0.22;
    g.fillStyle(0xf0dfa8, 1);
    g.fillTriangle(sx - 1, hi, tip, (hi + lo) / 2, sx - 1, lo);
    g.lineStyle(1.2, 0x0d0f14, 0.9);
    g.strokeTriangle(sx - 1, hi, tip, (hi + lo) / 2, sx - 1, lo);
    g.fillStyle(0x0d0f14, 0.9); g.fillCircle(sx, top - 2, 3);   // finial, so the
    g.fillStyle(0xf0dfa8, 1); g.fillCircle(sx, top - 2, 2);     // staff ends rather than stops
    return g;
  }

  /** A little procedural boat hull (used under a sailing hero and for map boats). */
  makeBoatHull() {
    const g = this.add.graphics();
    g.fillStyle(0x000000, 0.28); g.fillEllipse(0, 30, T * 0.86, T * 0.2); // water shadow
    g.fillStyle(0x6b4a2b, 1); // hull body
    g.beginPath();
    g.moveTo(-T * 0.42, 20); g.lineTo(T * 0.42, 20);
    g.lineTo(T * 0.3, 32); g.lineTo(-T * 0.3, 32); g.closePath(); g.fillPath();
    g.fillStyle(0x8a6440, 1); g.fillRect(-T * 0.42, 18, T * 0.84, 4); // gunwale trim
    return g;
  }

  /**
   * Floating card above a map hero: portrait + name, plus an army readout so
   * you can gauge a hero before committing. Your own and allied heroes show
   * EXACT stack counts; an enemy is only SCOUTED — vague HoMM3-style bracket
   * words per stack and an overall strength descriptor — so you can tell a chip
   * hero from a doomstack without a full reveal.
   */
  showHeroHover(hero) {
    this.hideHeroHover();
    const spr = this.heroSprites.get(hero.id);
    if (!spr || !spr.visible) return;
    const s = this.state;
    const humanIdx = s.players.findIndex((p) => p.isHuman);
    const friendly = hero.owner === humanIdx || (humanIdx >= 0 && sameTeam(s, hero.owner, humanIdx));
    // Multi-state pointer (feature): each successive hover of the SAME hero
    // advances the cursor info → command → arrow, so one hero exposes three
    // intents. Command is a SWORD over an enemy (click marches to attack) or an
    // EXCHANGE glyph over a friendly hero (click meets an adjacent ally to trade
    // troops); the third state is the plain arrow that simply selects. A
    // different hero resets the cycle to "info".
    if (this._heroCursor && this._heroCursor.id === hero.id) {
      this._heroCursor.stage = (this._heroCursor.stage + 1) % 3;
    } else {
      this._heroCursor = { id: hero.id, stage: 0 };
    }
    this._heroCursor.friendly = friendly;
    const stage = this._heroCursor.stage;
    this.input.setDefaultCursor(
      stage === 0 ? this.heroCursorCss('info')
        : stage === 1 ? this.heroCursorCss(friendly ? 'exchange' : 'sword')
          : 'default');
    this._townCursorOn = false; // the hero owns the cursor now (keep the town tracker in sync)
    // A disguised enemy hides its army from scouting (the Disguise spell).
    const cloaked = !friendly && hero.disguised;
    const stacks = hero.army.filter(Boolean);
    const lines = cloaked
      ? ['(army concealed by disguise)']
      : stacks.length
        ? stacks.map((st) => {
          const nm = CREATURES[st.creature]?.name || st.creature;
          return friendly ? `${nm}  ×${fmtCount(st.count)}` : `${nm} · ${vagueCount(st.count)}`;
        })
        : ['(no army)'];
    const strength = friendly ? null : cloaked ? 'unknown' : strengthWord(armyValue(hero.army));

    const CW = 172, imgH = 82, nameH = 18, lineH = 14, headH = friendly ? 0 : 13;
    const strH = strength ? 15 : 0;
    const titleH = hero.nemesisTitle ? 13 : 0; // "Bane of …" line for a branded nemesis
    const cardH = imgH + nameH + titleH + headH + lines.length * lineH + strH + 8;
    const tint = OWNER_TINT[hero.owner] ?? 0xffe9a0;
    const key = hasSprite(this, hero.rosterId) ? spriteKey(hero.rosterId) : heroTextureKey(this, hero);
    // Screen-space card, positioned one tile off the hero toward the view centre
    // (positionHeroCard) so it never sits under the pointer/hero — like the
    // map-object card. Children are laid out around the container's centre.
    const card = this.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD + 10);
    const bg = this.add.rectangle(0, 0, CW, cardH, 0x0d0b1a, 0.95).setStrokeStyle(2, tint, 0.95);
    card.add(bg);
    let y = -cardH / 2 + 2;
    const img = this.add.image(0, y + imgH / 2, key);
    img.setScale(Math.min((CW - 14) / img.width, imgH / img.height));
    card.add(img);
    y += imgH;
    card.add(this.add.text(0, y, hero.name, {
      fontFamily: FONT, fontSize: '11px', fontStyle: 'bold', color: '#ffe9b0', stroke: '#000', strokeThickness: 3,
    }).setOrigin(0.5, 0));
    y += nameH;
    if (hero.nemesisTitle) {
      card.add(this.add.text(0, y, hero.nemesisTitle, {
        fontFamily: FONT, fontSize: '9px', fontStyle: 'bold italic', color: '#e5584a', stroke: '#000', strokeThickness: 2,
      }).setOrigin(0.5, 0));
      y += titleH;
    }
    if (!friendly) {
      card.add(this.add.text(0, y, 'ARMY — SCOUTED', {
        fontFamily: FONT, fontSize: '8px', fontStyle: 'bold', color: '#b9a877',
      }).setOrigin(0.5, 0));
      y += headH;
    }
    for (const ln of lines) {
      card.add(this.add.text(-CW / 2 + 14, y, ln, {
        fontFamily: FONT, fontSize: '10px', color: friendly ? '#e6dcc4' : '#cfe0ef',
      }).setOrigin(0, 0));
      y += lineH;
    }
    if (strength) {
      card.add(this.add.text(0, y + 1, `Strength: ${strength}`, {
        fontFamily: FONT, fontSize: '10px', fontStyle: 'bold', color: cloaked ? '#9b93a8' : strengthColor(armyValue(hero.army)),
      }).setOrigin(0.5, 0));
    }
    this.heroHover = card;
    this.positionHeroCard(card, spr, CW, cardH);
  }

  /**
   * Place the hero hover card at least one tile off the hero, offset toward the
   * centre of the view so it never covers the hero or the pointer. Screen-space
   * (the card has scrollFactor 0), clamped clear of the top bar and side panel —
   * mirrors showObjectCard's placement.
   */
  positionHeroCard(card, spr, cw, ch) {
    const cam = this.cameras.main;
    // Hero centre in screen space.
    const hx = (spr.x - cam.worldView.x) * cam.zoom;
    const hy = (spr.y - cam.worldView.y) * cam.zoom;
    // Centre of the visible MAP region (right side is under the HUD panel).
    const cx = (this.scale.width - this.hudWidth()) / 2;
    const cy = (46 + this.scale.height) / 2;
    const step = Math.max(24, T * cam.zoom); // ~one tile toward the centre
    let px = (hx <= cx) ? hx + step : hx - step - cw;
    let py = (hy <= cy) ? hy + step : hy - step - ch;
    const maxX = this.scale.width - this.hudWidth() - cw - 4;
    px = Phaser.Math.Clamp(px, 4, Math.max(4, maxX));
    py = Phaser.Math.Clamp(py, 50, Math.max(50, this.scale.height - ch - 4));
    card.setPosition(px + cw / 2, py + ch / 2);
  }

  /**
   * A cached CSS cursor string for the multi-state hero pointer. Each glyph is
   * painted once to a small canvas (ivory line-art with a dark keyline, matching
   * the action pictograms) and cached as a data-URI. 'info' reads as a circled
   * "i"; 'sword' points its tip at the top-left hotspot; 'exchange' is a pair of
   * swapping arrows. Falls back to the platform arrow if canvas is unavailable.
   */
  heroCursorCss(kind) {
    this._heroCursorCache = this._heroCursorCache || {};
    if (this._heroCursorCache[kind]) return this._heroCursorCache[kind];
    let css = 'default';
    try {
      const S = 30;
      const c = makeCanvas(S, S);
      const ctx = c.getContext('2d');
      const ink = (lw) => { ctx.strokeStyle = 'rgba(18,14,26,0.9)'; ctx.lineWidth = lw + 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); };
      const ivory = (lw) => { ctx.strokeStyle = '#f4eeda'; ctx.lineWidth = lw; ctx.stroke(); };
      let hot = '15 15';
      if (kind === 'info') {
        ctx.beginPath(); ctx.arc(15, 15, 12, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(13,11,26,0.92)'; ctx.fill(); ivory(2.5);
        ctx.fillStyle = '#f4eeda';
        ctx.beginPath(); ctx.arc(15, 9.5, 1.8, 0, Math.PI * 2); ctx.fill(); // dot
        ctx.beginPath(); ctx.moveTo(15, 13); ctx.lineTo(15, 21.5); ink(4); ivory(3); // stem
      } else if (kind === 'sword') {
        hot = '2 2';
        // Blade: tip at the top-left, running down to the guard.
        ctx.beginPath(); ctx.moveTo(3, 3); ctx.lineTo(18, 18); ink(5); ivory(3.5);
        ctx.beginPath(); ctx.moveTo(14, 22); ctx.lineTo(23, 13); ink(4); ivory(3); // guard
        ctx.beginPath(); ctx.moveTo(19, 17); ctx.lineTo(25, 23); ink(4.5); ivory(3.5); // hilt
        ctx.fillStyle = '#f4eeda'; ctx.strokeStyle = 'rgba(18,14,26,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(26, 24, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); // pommel
      } else if (kind === 'exchange') {
        const arrow = (y, dir) => {
          const x0 = dir > 0 ? 5 : 25, x1 = dir > 0 ? 25 : 5;
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y);
          ctx.moveTo(x1, y); ctx.lineTo(x1 - dir * 5, y - 4);
          ctx.moveTo(x1, y); ctx.lineTo(x1 - dir * 5, y + 4);
          ink(4); ivory(2.8);
        };
        arrow(11, 1); arrow(19, -1);
      } else if (kind === 'town') {
        // A gate arch with an up-arrow — "enter the town".
        ctx.beginPath();
        ctx.moveTo(7, 27); ctx.lineTo(7, 13);
        ctx.arc(15, 13, 8, Math.PI, 0, true); // top arc (7,13) → (23,13)
        ctx.lineTo(23, 27);
        ink(3); ivory(2.4);
        ctx.fillStyle = '#bfe8ff'; ctx.strokeStyle = 'rgba(18,14,26,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(15, 9); ctx.lineTo(20, 16); ctx.lineTo(17, 16);
        ctx.lineTo(17, 24); ctx.lineTo(13, 24); ctx.lineTo(13, 16); ctx.lineTo(10, 16);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      css = `url(${c.toDataURL('image/png')}) ${hot}, auto`;
    } catch { css = 'default'; }
    this._heroCursorCache[kind] = css;
    return css;
  }

  hideHeroHover() {
    this.heroHover?.destroy();
    this.heroHover = null;
    // Restore the platform arrow when the pointer leaves a hero. The hover STAGE
    // is deliberately kept, so re-hovering the same hero advances the cursor.
    this.input?.setDefaultCursor('default');
    this._townCursorOn = false;
  }

  // ---- map-object hover tooltip (what is it, who owns it) ------------------

  ownerLabel(owner) {
    if (owner == null || owner < 0) return 'unowned';
    if (owner === 0) return 'owned by you';
    return `owned by the ${this.state.players[owner]?.colorName || 'rival'} player`;
  }

  /** Status-line colour for a map object's owner (you / rival / unowned). */
  ownerColor(owner) {
    if (owner == null || owner < 0) return '#cabd94';
    if (owner === 0) return '#8fd18f';
    return '#e2837c';
  }

  /**
   * One line on how "fresh" a booster is for the SELECTED hero: weekly sites
   * (Windmill / Water Wheel / Magic Spring) report per-week; movement camps
   * per-day; the reusable Mana Well / Hill Fort say so; everything else is a
   * once-per-hero learning site. Mirrors the engine's boosterSpent so the card
   * never disagrees with what actually happens on visit.
   */
  boosterStatusLine(obj) {
    const s = this.state;
    const t = obj.boosterType;
    const READY = '#8fd18f', SPENT = '#d8b46a', REUSE = '#8fb8d1';
    if (t === 'mana') return { text: 'Reusable — refills your spell points', color: REUSE };
    if (t === 'hillFort') return { text: 'Reusable — upgrades your creatures', color: REUSE };
    if (t === 'windmill' || t === 'waterWheel' || t === 'magicSpring') {
      return obj.harvestedWeek === weekOf(s.day)
        ? { text: 'Already drained — refills next week', color: SPENT }
        : { text: 'Ready to harvest this week', color: READY };
    }
    const hero = this.selectedHeroId ? s.heroes[this.selectedHeroId] : null;
    if (!hero) return { text: t === 'move' ? 'Grants extra movement (once a day)' : 'A one-time bonus per hero', color: '#b9a877' };
    const spent = boosterSpent(s, hero, obj);
    if (t === 'move') {
      return spent ? { text: `${hero.name} already used it today`, color: SPENT }
        : { text: `${hero.name} can use it today`, color: READY };
    }
    return spent ? { text: `${hero.name} has already visited`, color: SPENT }
      : { text: `${hero.name} hasn't visited yet`, color: READY };
  }

  /** Structured content for the hover card: title, description, optional status. */
  objectCardData(obj) {
    const s = this.state;
    switch (obj.type) {
      case 'town': {
        const t = s.towns[obj.townId];
        return { title: t.name, desc: `${FACTIONS[t.faction]?.name || t.faction} town`,
          status: this.ownerLabel(t.owner), statusColor: this.ownerColor(t.owner), tint: OWNER_TINT[t.owner] };
      }
      case 'mine': {
        const inc = CONFIG.MINE_INCOME[obj.mineType] || {};
        const incTxt = Object.entries(inc).map(([r, v]) => `+${v} ${r} / day`).join('  ');
        return { title: mineName(obj.mineType), desc: incTxt,
          status: this.ownerLabel(obj.owner), statusColor: this.ownerColor(obj.owner), tint: OWNER_TINT[obj.owner] };
      }
      case 'resource':
        return { title: `${obj.amount} ${obj.resource}`, desc: 'Pick up to add to your treasury' };
      case 'chest':
        return { title: 'Treasure Chest', desc: 'Take the gold, or trade it for hero experience' };
      case 'artifact': {
        const a = ARTIFACTS[obj.artifact];
        return { title: a?.name || 'Artifact', desc: a?.desc || 'A magical artifact', status: a?.slot ? `Equips: ${a.slot}` : null, statusColor: '#c9bd95' };
      }
      case 'booster': {
        let effect = boosterEffect(obj.boosterType);
        if (obj.boosterType === 'witchHut' && obj.skill) effect = `Teaches ${SKILLS[obj.skill]?.name || obj.skill}`;
        else if (obj.boosterType === 'shrine' && obj.spell) effect = `Teaches ${SPELLS[obj.spell]?.name || obj.spell}`;
        const st = this.boosterStatusLine(obj);
        return { title: boosterName(obj.boosterType), desc: effect, status: st.text, statusColor: st.color };
      }
      case 'seerHut':
        return obj.done
          ? { title: 'Seer Hut', desc: 'The seer has no more tasks', status: 'Completed', statusColor: '#d8b46a' }
          : { title: 'Seer Hut', desc: `Bring ${seerQuestText(obj.quest)}\n→ a sealed reward (revealed when paid)` };
      case 'tradingPost':
        return { title: 'Trading Post', desc: `Sell artifacts for experience,\nor buy them for resources${obj.stock?.length ? ` (${obj.stock.length} for sale)` : ''}` };
      case 'dwelling': {
        const cr = dwellingCreature(obj);
        const each = CREATURES[cr]?.cost?.gold || 0;
        const stock = obj.available || 0;
        return {
          title: dwellingName(obj),
          desc: `Musters ${CREATURES[cr]?.name || cr} — ${each} gold each\nReady to recruit: ${stock}`,
          status: stock > 0 ? 'Recruit here' : 'Mustering…',
          statusColor: stock > 0 ? '#8fe870' : '#d8b46a',
        };
      }
      case 'monster': {
        const c = CREATURES[obj.creature];
        const title = `${obj.count} × ${c?.name || obj.creature}`;
        // A captain, if this band has one. The map's standard says THAT there is
        // one; the card is where you find out who, how senior, and what a ronin
        // does — the three things that decide whether you pick this fight. `tint`
        // carries the same bone-gold to the card's border, so the token you
        // hovered and the card you get are visibly the same claim.
        const led = roninBrief(obj);
        const captain = led
          ? [`Led by ${led.name}, level ${led.level}`
             + (led.fights
               ? ` — ${led.fights} battle${led.fights === 1 ? '' : 's'} fought, ${led.helped} won`
               : ''),
            'Sworn to no realm: they fight for whoever is attacked']
          : [];
        const ledTint = led ? { tint: 0xe7d49a } : null;
        // The warning calls the SAME functions the encounter calls. It used to
        // read "Will fight" unconditionally, which was wrong twice over: a stack
        // that would have offered to join was labelled a fight, and a stack that
        // masses against you on contact was quoted at its resting size. A warning
        // that reimplements the check is the instrument-vs-engine problem moved
        // into the UI, and a wrong warning is worse than none — you cannot learn
        // from it without paying a battle to test it.
        const hero = this.selectedHeroId ? s.heroes[this.selectedHeroId] : null;
        if (!hero) {
          return {
            title,
            desc: [...captain, 'Guards the way — blocks passage until defeated'].join('\n'),
            status: led ? 'A commanded band' : 'Will fight',
            statusColor: led ? '#e7d49a' : '#e2837c',
            ...ledTint,
          };
        }
        // CACHED, because this handler runs on raw pointermove (Phaser dispatches
        // per DOM event, uncoalesced) and the engine call below prices the fight
        // with a full auto-resolved battle — measured cold at 26-99ms, all of it
        // inside the tide sizer's ~100 sims. showObjectCard's `_cardSig` cannot do
        // this job: it is consulted AFTER objectCardData has already paid.
        //
        // MANY entries, not one. It used to hold a single memo, so moving the
        // pointer along a road of guards re-priced every stack on the way out and
        // again on the way back — the one arrangement of stacks a player is most
        // likely to hover is exactly the one the memo could not help with. The
        // cache is bounded and least-recently-used, like the sizer's own
        // (TIDE_MULT_CACHE): a hover you keep coming back to is the one kept.
        //
        // The key is the ENGINE's (actions.monsterPreviewKey), not one built here
        // from the fields that looked relevant. The old local key missed the
        // hero's artifacts, skills, spells, war machines and specialty, the
        // feature flags, the realm's upgrades and the learned tide bias — all of
        // which the answer reads. A one-entry memo hid that, because the next
        // hover of anything else evicted the entry; widening it is precisely what
        // would have made those gaps show up as wrong numbers on the card.
        // combatContext is the encounter's own function: whatever it says the
        // defender will be, that is what the hero would meet. Priced once and
        // cached — see pricedEncounter, which every guarded fight now shares.
        const { ctx } = this.pricedEncounter(obj, 'monster', hero);
        // The context carries the offer the scaling branch already priced
        // (ctx.parleyOffer), so the card never runs the fight simulation twice.
        // It is absent only when PvE scaling is off for this game — then the
        // offer is priced here, once.
        const offer = ctx.parleyOffer || parleyOffer(s, hero, obj);
        const massed = (ctx.defenderArmy || []).reduce((n, st) => n + (st ? st.count : 0), 0);
        const lines = [...captain, 'Guards the way — blocks passage until defeated'];
        if (ctx.tideScaled && massed > obj.count) {
          lines.push(`→ they will mass to ${massed} against ${hero.name}`);
        }
        let data;
        if (offer.offered && !offer.refused) {
          lines.push((offer.free ? '→ would join you for nothing' : `→ would join for ${offer.price} gold`)
            + (offer.acceptable ? '' : ' — but you cannot take them up on it'));
          data = {
            title,
            desc: lines.join('\n'),
            status: offer.acceptable ? 'Would join — or fight' : 'Offer you cannot accept',
            statusColor: offer.acceptable ? '#8fe870' : '#e2c07c',
            ...ledTint,
          };
        } else {
          if (offer.reason === 'no room') lines.push('→ no room in your army for them');
          else if (offer.refused) lines.push('→ they refuse to bargain');
          // A band that will bolt is not a fight, and the card is the only place
          // to learn that before committing the click — the same argument that put
          // the massed count and the join price here. It is a seeded fact about
          // this encounter (diplomacy.fleeCheck), so saying it early costs nothing.
          const runs = encounterFlees(s, ctx).flees;
          if (runs) lines.push('→ they will break and run — chase them, or let them pass');
          data = {
            title,
            desc: lines.join('\n'),
            // The captain leads the status line when there is one: "will fight"
            // is true of every stack on the map and says nothing, while "under a
            // captain" is the whole reason this card looks different.
            status: runs ? 'Will break and run' : (led ? 'Will fight — under a captain' : 'Will fight'),
            statusColor: runs ? '#9fc8e8' : (led ? '#e7d49a' : '#e2837c'),
            ...ledTint,
          };
        }
        return data;
      }
      case 'keymaster': {
        const humanIdx = this.state.players.findIndex((p) => p.isHuman);
        const held = playerHasKey(this.state, humanIdx, obj.color);
        return {
          title: `${keyColorName(obj.color)} Keymaster Tent`,
          desc: `Grants your realm the ${keyColorName(obj.color)} Key — opens every ${keyColorName(obj.color)} Border Guard`,
          status: held ? 'Key held' : 'Visit for the key', statusColor: held ? '#8fe870' : '#d8b46a',
        };
      }
      case 'borderGuard': {
        const humanIdx = this.state.players.findIndex((p) => p.isHuman);
        const held = playerHasKey(this.state, humanIdx, obj.color);
        return {
          title: `${keyColorName(obj.color)} Border Guard`,
          desc: 'Bars the way until you hold the matching key',
          status: held ? 'Open to you' : 'Locked', statusColor: held ? '#8fe870' : '#e2837c',
        };
      }
      case 'creatureBank': {
        const def = bankDef(obj.bankType);
        if (obj.looted) {
          // A cleared lair that has bred since (lairBrood) is worth a march
          // again, so the hover has to say so — otherwise "Looted" reads as
          // "nothing here" and the stock is never found.
          const n = obj.brood || 0;
          const cr = n > 0 ? broodOf(obj.bankType)?.creature : null;
          if (cr) {
            return {
              title: def?.name || 'Creature Bank',
              desc: `The nest has bred again.\n→ ${n} ${CREATURES[cr]?.name || cr} waiting to join`,
              status: 'Yours for the taking', statusColor: '#8fe870',
            };
          }
          return { title: def?.name || 'Creature Bank', desc: 'Already plundered', status: 'Looted', statusColor: '#8a8578' };
        }
        const rw = def?.reward || {};
        const bits = [];
        if (rw.gold) bits.push(`${rw.gold} gold`);
        if (rw.creatures) bits.push(rw.creatures.map((cr) => `${cr.count} ${CREATURES[cr.creature]?.name || cr.creature}`).join(' + '));
        if (rw.artifact) bits.push('an artifact');
        const gimmick = def?.boss && def.gimmick ? `\n${def.gimmick}` : '';
        return {
          title: def?.name || 'Creature Bank',
          desc: `Guarded by ${this.guardLine(obj)}${gimmick}\n→ reward: ${bits.join(' · ')}`,
          status: def?.boss ? 'Boss lair — a mighty guardian' : 'Guarded — will fight',
          statusColor: def?.boss ? '#e5584a' : '#e2837c',
        };
      }
      case 'pandora': {
        // The reward stays a mystery until opened (true to the box's nature);
        // the guard, if any, can be scouted before committing.
        if (obj.looted) return { title: "Pandora's Box", desc: 'Already opened', status: 'Opened', statusColor: '#8a8578' };
        const guarded = obj.guards && obj.guards.length;
        if (guarded) {
          const guards = this.guardLine(obj);
          return {
            title: "Pandora's Box",
            desc: `Guarded by ${guards}\n→ reward: an unknown treasure`,
            status: 'Guarded — will fight', statusColor: '#e2837c',
          };
        }
        return { title: "Pandora's Box", desc: 'An unguarded box — open it for an unknown treasure', status: 'Free to open', statusColor: '#8fe870' };
      }
      case 'monolith': {
        return obj.dir === 'entrance'
          ? { title: 'One-Way Monolith', desc: 'Step in → swept to a matching exit\n(a one-way trip — you cannot return)', status: 'Entrance', statusColor: '#8fe870' }
          : { title: 'One-Way Monolith', desc: 'The exit of a one-way monolith', status: 'Exit — inert', statusColor: '#8a8578' };
      }
      default: {
        const map = {
          portal: ['Portal', 'Steps instantly to its linked gate'],
          subGate: ['Subterranean Gate', 'Travels between the surface and the caverns'],
          whirlpool: ['Whirlpool', 'Swallows a boat and casts it out elsewhere at sea'],
          boat: ['Boat', 'Board it to sail across the water'],
          shipyard: ['Shipyard', 'Build a boat here to take to sea'],
        };
        const [title, desc] = map[obj.type] || [obj.type, ''];
        return { title, desc };
      }
    }
  }

  /** Candidate texture keys (raster preferred) for an object's card icon. */
  cardIconKeys(obj) {
    switch (obj.type) {
      case 'town': { const g = FACTIONS[this.state.towns[obj.townId].faction]?.townGlyph; return g ? [spriteKey(g), g] : []; }
      case 'mine': return [spriteKey(`mine_${obj.mineType}`), `mine_${obj.mineType}`];
      case 'resource': return [spriteKey(`res_${obj.resource}`), `res_${obj.resource}`];
      case 'chest': return [spriteKey('chest'), 'chest'];
      case 'artifact': return [spriteKey(obj.artifact), `art_${obj.artifact}`];
      case 'booster': return [spriteKey(`boost_${obj.boosterType}`), `boost_${obj.boosterType}`];
      case 'seerHut': return [spriteKey('boost_seerHut'), 'boost_seerHut'];
      case 'tradingPost': return [spriteKey('boost_tradingPost'), 'boost_tradingPost'];
      case 'pandora': return [spriteKey('pandora')];
      case 'creatureBank': return [spriteKey(`bank_${obj.bankType}`)];
      case 'keymaster': return [spriteKey('keymaster')];
      case 'borderGuard': return [spriteKey('borderGuard')];
      case 'monster': return [spriteKey(obj.creature), `token_${obj.creature}`];
      case 'dwelling': { const cr = dwellingCreature(obj); return cr ? [spriteKey(cr), `token_${cr}`] : []; }
      case 'boat': return [spriteKey('boat')];
      case 'portal': return [spriteKey('portal')];
      case 'subGate': return [spriteKey('subgate')];
      case 'whirlpool': return [spriteKey('whirlpool')];
      case 'shipyard': return [spriteKey('shipyard')];
      default: return [];
    }
  }

  /** A representative icon GameObject for the card, scaled to fit `box`. */
  objectCardIcon(obj, box) {
    for (const key of this.cardIconKeys(obj)) {
      if (key && this.textures.exists(key)) {
        const img = this.add.image(0, 0, key);
        img.setScale(Math.min(box / img.width, box / img.height));
        return img;
      }
    }
    // Procedural/animated props (or missing art): a simple glyph stand-in.
    const glyph = { portal: '◍', whirlpool: '≈', boat: '⛵', shipyard: '⚓',
      subGate: this.viewLevel === 1 ? '▲' : '▼' }[obj.type] || '◆';
    return this.add.text(0, 0, glyph, {
      fontFamily: FONT, fontSize: `${Math.round(box * 0.72)}px`, color: '#e6dcc4', stroke: '#000', strokeThickness: 3,
    }).setOrigin(0.5);
  }

  /**
   * The town whose visual footprint covers (tx,ty), or null. The castle stands
   * on its base tile and rises ~2 tiles, so its footprint is the 3×3 block from
   * the base row up: base at (bx,by) claims (bx-1..bx+1, by-2..by). Used to make
   * the whole castle a click/hover target for entering. A tile carrying its own
   * (non-town) object is never claimed, so an adjacent mine/etc. keeps its click.
   */
  townFootprintAt(tx, ty) {
    const here = tileAt(this.state, tx, ty, this.viewLevel);
    const hereObj = here?.objectId ? this.curObjects()[here.objectId] : null;
    if (hereObj && hereObj.type !== 'town') return null;
    for (let dy = 0; dy <= 2; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = tileAt(this.state, tx + dx, ty + dy, this.viewLevel);
        const o = t?.objectId ? this.curObjects()[t.objectId] : null;
        if (o && o.type === 'town') return o;
      }
    }
    return null;
  }

  updateObjectHover(pointer) {
    if (this.dragState?.panned || modalOpen()
      || pointer.y < 46 || pointer.x > this.scale.width - this.hudWidth()) {
      this.setTownCursor(false);
      this.hideObjectTip();
      return;
    }
    const s = this.state;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tx = Math.floor(world.x / T), ty = Math.floor(world.y / T);
    const lvl = this.viewLevel;
    if (tx < 0 || ty < 0 || tx >= s.map.w || ty >= s.map.h || !this.curExplored(tx, ty)) {
      this.setTownCursor(false);
      this.hideObjectTip();
      return;
    }
    // Heroes own their cursor + portrait card — don't fight them.
    if (heroAt(s, tx, ty, lvl)) { this.hideObjectTip(); return; }
    const tile = tileAt(s, tx, ty, lvl);
    // A click anywhere on a castle's footprint enters it, so hovering it shows an
    // "enter town" cursor + the town's card (not just its one base tile). Skip the
    // cursor while a spell is being targeted (that mode owns the pointer).
    const footTown = this.townFootprintAt(tx, ty);
    this.setTownCursor(!!footTown && !this.castTarget);
    if (footTown) { this.showObjectCard(footTown, pointer); return; }
    const obj = tile.objectId ? this.curObjects()[tile.objectId] : null;
    if (!obj) { this.hideObjectTip(); return; }
    this.showObjectCard(obj, pointer);
    // Hovering is what prices a fight, so hovering is when this token can stop
    // saying "5+" and start saying what the hero would actually meet. Only this
    // one token: repainting every count runs per pointermove, and building a
    // preview key per object is not free.
    const spr = this.objSprites.get(obj.id);
    if (spr?.countLabel) this.paintCount(spr.countLabel, obj);
  }

  /**
   * Toggle the "enter town" pointer, tracking state so we only touch the CSS
   * cursor on a change (and never clobber the hero/spell cursors, which set it
   * themselves). Restores the plain arrow when leaving a town's footprint.
   */
  setTownCursor(on) {
    if (!!on === !!this._townCursorOn) return;
    this._townCursorOn = on;
    this.input.setDefaultCursor(on ? this.heroCursorCss('town') : 'default');
  }

  /**
   * A rich hover card for a map object: a large icon, the name, a short
   * description, and — where it matters — an owner / freshness status line, all
   * on an owner-tinted panel. Replaces the old cramped two-line text tip (#14).
   * Rebuilt on each tile change; a cached `_cardObjId` skips redundant redraws
   * while the pointer lingers on the same object.
   */
  /** Repaint every visible wild stack's count (cheap: it only peeks, never prices). */
  repaintCounts() {
    const objs = this.curObjects();
    for (const [id, spr] of this.objSprites) {
      const obj = objs[id];
      if (obj && obj.type === 'monster' && spr.countLabel) this.paintCount(spr.countLabel, obj);
    }
  }

  /**
   * The number under a wild stack — and which of two numbers it is.
   *
   * Reported: "we have 5 griffins guarding a mine, I attack them and they turn to
   * 12k — other users may be too surprised." Under Tide of War the count on the
   * object is the truth about the object and a lie about the fight, and a map that
   * prints one while delivering the other is not a map anyone can plan on.
   *
   * So the label says what it knows, and says which it is:
   *
   *   scaling off             5      the object's count, exactly as before
   *   scaling on, unpriced    5+     at least this many; nobody has asked yet
   *   scaling on, priced   12000     what this hero would actually face
   *
   * PRICED MEANS HOVERED. Sizing a fight is the most expensive thing on this path
   * and there can be dozens of tokens on screen, so this never pays for one — it
   * peeks at the cache a hover already filled (pricedEncounter). The map therefore
   * gets more honest as you scout it, which is the right way round: the "+" is an
   * invitation to hover rather than a number to act on, and the hover card gives
   * the same figure in words.
   *
   * The colour carries the distinction on its own, so a player who never reads the
   * "+" still sees at a glance that this number is about a fight rather than a
   * headcount.
   */
  paintCount(labelObj, obj) {
    const hero = this.selectedHeroId ? this.state.heroes[this.selectedHeroId] : null;
    if (!hero || !pveWouldScale(this.state, hero, obj)) {
      labelObj.setText(`${obj.count}`);
      labelObj.setColor(COUNT_RESTING);
      return;
    }
    const known = this.pricedEncounter(obj, obj.type, hero, { peek: true });
    const massed = known
      ? (known.ctx.defenderArmy || []).reduce((n, st) => n + (st ? st.count : 0), 0)
      : 0;
    labelObj.setText(massed > 0 ? `${fmtCount(massed)}` : `${obj.count}+`);
    labelObj.setColor(COUNT_MASSED);
  }

  /**
   * What the selected hero would actually meet at a guarded prize.
   *
   * The card used to list `obj.guards` — the guards as PLACED — while the fight
   * masses them to the hero (the Tide of War sizer). That is the same defect the
   * monster card was fixed for: a warning that reimplements the check instead of
   * asking it, and a wrong warning is worse than none, because you cannot learn
   * from it without paying a battle to test it.
   *
   * Asking costs a full sizing run, which is exactly why it is worth doing HERE:
   * priced on the hover it is cached by the time the click lands, and the click
   * was where the several-second freeze was. With no hero selected there is
   * nobody to size against, so the placed guards are the honest answer.
   */
  guardLine(obj) {
    const named = (list) => (list || []).filter((g) => g && g.count > 0)
      .map((g) => `${fmtCount(g.count)} ${CREATURES[g.creature]?.name || g.creature}`).join(', ');
    const hero = this.selectedHeroId ? this.state.heroes[this.selectedHeroId] : null;
    if (!hero) return named(obj.guards);
    const { ctx } = this.pricedEncounter(obj, obj.type, hero);
    return named(ctx.defenderArmy) || named(obj.guards);
  }

  /**
   * The fight this object would actually give the selected hero, priced ONCE.
   *
   * Reported: attacking a Pandora's Box or a creature bank froze for several
   * seconds. It was the Tide of War sizer — measured on the player's own machine,
   * `sized=3321ms field=15ms` for a Dwarven Treasury — running its bracket, its
   * bisection and its wipe guard, thirty to sixty full auto-resolved battles, on
   * the click.
   *
   * WHY ONLY THOSE. A wild stack's hover card has always quoted the real fight, so
   * by the time you click one, the sizer's answer is already in its cache and the
   * click is free. The guarded prizes had static cards — a list of the guards as
   * PLACED — so nothing was warm and the click paid the whole cold search. The
   * asymmetry was the bug: same engine, same cost, one of them pre-paid.
   *
   * Now they all come through here, and the card is honest as a side effect: those
   * cards used to print the resting guards while the fight massed them, which is
   * the same defect the monster card was fixed for ("a wrong warning is worse than
   * none — you cannot learn from it without paying a battle to test it").
   *
   * `preview` keeps it a pure question: the same numbers with no rng draw, no
   * divine gift, no pveScaleLog row (tests/smoke/hover-purity-smoke.mjs).
   */
  pricedEncounter(obj, kind, hero, { peek = false } = {}) {
    const s = this.state;
    const key = encounterPreviewKey(s, hero, obj);
    const hit = this._monsterCards.get(key);
    // `peek` asks what is already known and never pays. The map labels every
    // visible token every refresh, which the sizing could not survive being asked;
    // a hover pays once and the map is honest about that stack from then on.
    if (peek && !hit) return null;
    if (hit) {
      this._monsterCards.delete(key);   // re-insert: most recently used last
      this._monsterCards.set(key, hit);
      return hit;
    }
    const entry = { ctx: combatContext(s, hero, { kind, objectId: obj.id }, { preview: true }) };
    this._monsterCards.set(key, entry);
    if (this._monsterCards.size > CONFIG.MONSTER_CARD_CACHE_MAX) {
      // Map iterates in insertion order and a hit re-inserts, so the first key
      // is the least recently used one.
      this._monsterCards.delete(this._monsterCards.keys().next().value);
    }
    return entry;
  }

  showObjectCard(obj, pointer) {
    const d = this.objectCardData(obj);
    // Redraw only when the object OR its live status changed (cheap while hovering).
    const sig = `${obj.id}|${d.status || ''}`;
    if (this._cardSig !== sig) {
      this.hideObjectTip();
      const CW = 232, PAD = 12, ICONBOX = 60, GAP = 5, WRAP = CW - PAD * 2;
      const card = this.add.container(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD + 11);
      let y = PAD;
      const icon = this.objectCardIcon(obj, ICONBOX);
      icon.setPosition(0, y + ICONBOX / 2);
      card.add(icon);
      y += ICONBOX + GAP + 2;
      const title = this.add.text(0, y, d.title, {
        fontFamily: FONT, fontSize: '15px', fontStyle: 'bold', color: '#ffe9b0',
        align: 'center', wordWrap: { width: WRAP }, stroke: '#000', strokeThickness: 2,
      }).setOrigin(0.5, 0);
      card.add(title); y += title.height + GAP;
      if (d.desc) {
        const desc = this.add.text(0, y, d.desc, {
          fontFamily: FONT, fontSize: '11px', color: '#d9cdb0',
          align: 'center', wordWrap: { width: WRAP }, lineSpacing: 3,
        }).setOrigin(0.5, 0);
        card.add(desc); y += desc.height + GAP;
      }
      if (d.status) {
        const st = this.add.text(0, y + 2, d.status, {
          fontFamily: FONT, fontSize: '11px', fontStyle: 'bold', color: d.statusColor || '#b9a877',
          align: 'center', wordWrap: { width: WRAP },
        }).setOrigin(0.5, 0);
        card.add(st); y += st.height + GAP + 2;
      }
      const cardH = y - GAP + PAD;
      const tint = d.tint ?? 0x9a8a5a;
      const bg = this.add.rectangle(0, cardH / 2, CW, cardH, 0x0c0a16, 0.96).setStrokeStyle(2, tint, 0.95);
      card.addAt(bg, 0);
      card._cw = CW; card._ch = cardH;
      this.objCard = card;
      this._cardSig = sig;
    }
    // Sit the card one tile off the object, on the side facing the screen centre,
    // so it never covers what you're inspecting and always reads "inward". The
    // pointer is on the object's tile, so it stands in for the object's position;
    // one tile in screen space is T×zoom (floored so it never hugs the object at
    // low zoom). Children are laid out with x=0 = horizontal centre, y=0 = top.
    const card = this.objCard;
    const cx = this.scale.width / 2, cy = this.scale.height / 2;
    const step = Math.max(20, T * this.cameras.main.zoom); // ~one tile toward centre
    let px = (pointer.x <= cx) ? pointer.x + step : pointer.x - step - card._cw;
    let py = (pointer.y <= cy) ? pointer.y + step : pointer.y - step - card._ch;
    // Keep it fully on-screen, clear of the top resource bar and the side panel.
    const maxX = this.scale.width - this.hudWidth() - card._cw - 4;
    px = Phaser.Math.Clamp(px, 4, Math.max(4, maxX));
    py = Phaser.Math.Clamp(py, 50, Math.max(50, this.scale.height - card._ch - 4));
    card.setPosition(px + card._cw / 2, py);
  }

  hideObjectTip() {
    this.objCard?.destroy();
    this.objCard = null;
    this._cardSig = null;
  }

  /**
   * Destroy and rebuild every map object & hero. Called when the raster sprite
   * pack finishes loading after the map first drew on procedural art, so towns,
   * artifacts and heroes swap up to their generated sprites without a reload.
   */
  /**
   * Coalesce a burst of late-arriving sprite textures into a single dynamic-art
   * rebuild, deferred while a hero is walking or the AI is moving so a rebuild
   * can never destroy a tweening token mid-step. Uses setTimeout (not a scene
   * timer) so it still fires while this scene is paused under a Town/Combat/Hero
   * overlay — the map is correct the moment you return to it.
   */
  scheduleArtRebuild() {
    if (this._artRebuildTimer) clearTimeout(this._artRebuildTimer);
    this._artRebuildTimer = setTimeout(() => {
      this._artRebuildTimer = null;
      if (this.moving || this.aiRunning) { this.scheduleArtRebuild(); return; } // don't cut a walk
      this.rebuildDynamicArt();
    }, 400);
  }

  rebuildDynamicArt() {
    this.hideHeroHover();
    // Terrain can now carry raster tiles too; rebake the ground only when the
    // pack actually brought a terrain sprite, so the common (no terrain sprite)
    // case skips the expensive re-tile. buildTerrain re-syncs the registry.
    if (this.hasTerrainSprites()) this.buildTerrain();
    for (const spr of this.objSprites.values()) spr.destroy();
    this.objSprites.clear();
    for (const spr of this.heroSprites.values()) spr.destroy();
    this.heroSprites.clear();
    for (const img of this.decorSprites) img.destroy();
    this.decorSprites = [];
    this.selRing = null; // was a child of a now-destroyed hero container
    this.buildDecor();
    this.buildObjects();
    this.buildHeroes();
    this.refreshVisibility();
    if (this.selectedHeroId && this.state.heroes[this.selectedHeroId]) {
      this.selectHero(this.selectedHeroId);
    }
  }

  // =========================================================================
  // Fog & sprite visibility
  // =========================================================================

  redrawFog() {
    const { map } = this.state; // w/h are shared across levels
    const fog = fogFor(this.state, 0, this.viewLevel); // human knowledge, this level
    const seen = (i) => !!fog && fog[i] === 1; // absent fog ⇒ nothing seen (all black)
    const g = this.fogG;
    g.clear();
    g.fillStyle(0x07060d, 1);
    for (let y = 0; y < map.h; y++) {
      let runStart = -1;
      for (let x = 0; x <= map.w; x++) {
        const hidden = x < map.w && !seen(y * map.w + x);
        if (hidden && runStart < 0) runStart = x;
        if (!hidden && runStart >= 0) {
          g.fillRect(runStart * T - 1, y * T - 1, (x - runStart) * T + 2, T + 2);
          runStart = -1;
        }
      }
    }
    // Outside-map border shade.
    g.fillRect(-T * 2, -T * 2, map.w * T + T * 4, T * 2);
    g.fillRect(-T * 2, map.h * T, map.w * T + T * 4, T * 2);
    g.fillRect(-T * 2, 0, T * 2, map.h * T);
    g.fillRect(map.w * T, 0, T * 2, map.h * T);

    this.drawScry();
    this.refreshVisibility();
  }

  /**
   * The View Earth sighting, painted OVER the dark.
   *
   * A flag for a castle, a shield for a commander, both in the owner's banner
   * colour — "all black, and show the castle locations with flags and heroes with
   * shields in the respective colour". Drawn above the fog because that is the
   * whole idea: the land stays unknown and only the powers on it are marked.
   *
   * Only in the DARK. On ground the player has actually explored the real town and
   * the real hero are already drawn, and a marker on top of them would be a second,
   * staler copy of something already true.
   *
   * It FADES with age. A sighting is a snapshot and armies move, so an old one is a
   * rumour rather than a report, and it should look like one — full strength on the
   * day it is cast, thinning to nothing as it lapses.
   */
  drawScry() {
    this.scryG?.destroy();
    this.scryG = null;
    const s = this.state;
    const sight = scrySighting(s, 0);
    if (!sight) return;
    const c = this.add.container(0, 0).setDepth(DEPTH.FOG + 4).setAlpha(sight.alpha);
    for (const m of sight.marks) {
      if ((m.z ?? 0) !== this.viewLevel) continue;
      if (this.curExplored(m.x, m.y)) continue; // the real thing is already drawn
      const px = m.x * T + T / 2, py = m.y * T + T / 2;
      const col = m.owner >= 0 ? (BANNER_COLORS[bannerSlot(s, m.owner)] || 0x9aa0a6) : 0x9aa0a6;
      c.add(m.kind === 'town' ? this.scryFlag(px, py, col) : this.scryShield(px, py, col));
    }
    if (!c.length) { c.destroy(); return; }
    this.scryG = c;
  }

  /** A castle's pennant on a staff, in the owner's colour. */
  scryFlag(px, py, col) {
    const g = this.add.graphics();
    g.lineStyle(2, 0x11131a, 0.85);
    g.beginPath(); g.moveTo(px, py + T * 0.34); g.lineTo(px, py - T * 0.34); g.strokePath();
    g.fillStyle(col, 1);
    g.fillTriangle(px + 1, py - T * 0.34, px + T * 0.36, py - T * 0.2, px + 1, py - T * 0.06);
    g.lineStyle(1.2, 0x0d0f14, 0.8);
    g.strokeTriangle(px + 1, py - T * 0.34, px + T * 0.36, py - T * 0.2, px + 1, py - T * 0.06);
    return g;
  }

  /** A commander's shield, in the owner's colour. */
  scryShield(px, py, col) {
    const g = this.add.graphics();
    const w = T * 0.24, h = T * 0.3;
    const face = [
      [px - w, py - h], [px + w, py - h],
      [px + w, py + h * 0.15], [px, py + h], [px - w, py + h * 0.15],
    ];
    g.fillStyle(col, 1);
    g.beginPath();
    g.moveTo(face[0][0], face[0][1]);
    for (const [x, y] of face.slice(1)) g.lineTo(x, y);
    g.closePath(); g.fillPath();
    // A bevel down one side rather than a bar across the middle. The bar version
    // read as a minus sign at map scale, which is a symbol that means something
    // else; a lit edge just says "metal" and leaves the silhouette to do the work
    // of telling a shield from a flag.
    g.fillStyle(0xffffff, 0.3);
    g.beginPath();
    g.moveTo(px - w, py - h);
    g.lineTo(px, py - h);
    g.lineTo(px, py + h * 0.62);
    g.lineTo(px - w, py + h * 0.15);
    g.closePath(); g.fillPath();
    g.lineStyle(1.4, 0x0d0f14, 0.9);
    g.beginPath();
    g.moveTo(face[0][0], face[0][1]);
    for (const [x, y] of face.slice(1)) g.lineTo(x, y);
    g.closePath(); g.strokePath();
    return g;
  }

  refreshVisibility() {
    const s = this.state;
    const objs = this.curObjects();
    for (const [id, spr] of this.objSprites) {
      const obj = objs[id];
      if (!obj) { spr.destroy(); this.objSprites.delete(id); continue; }
      spr.setVisible(this.curExplored(obj.x, obj.y));
    }
    for (const [id, spr] of this.heroSprites) {
      const hero = s.heroes[id];
      if (!hero) { spr.destroy(); this.heroSprites.delete(id); continue; }
      // A hero that left this level (descended/emerged) hides here.
      spr.setVisible((hero.z ?? 0) === this.viewLevel && this.curExplored(hero.x, hero.y));
    }
  }

  /** Sync every dynamic sprite with the state (post combat/AI/day). */
  refreshWorld() {
    const s = this.state;
    const objs = this.curObjects();
    for (const [id, spr] of [...this.objSprites]) {
      const obj = objs[id];
      if (!obj) {
        spr.destroy();
        this.objSprites.delete(id);
        continue;
      }
      // A site whose ART is drawn from state the engine can change — a vault
      // that has been emptied or REOCCUPIED, a dwelling that has been flagged —
      // needs its sprite rebuilt when that state moves. Nothing did that, so a
      // Pandora's Box or Dwarven Treasury that reloaded four weeks after it was
      // cleared (the siteRespawn rule) went on showing the greyed-out husk of
      // the emptied one, guard pip and all, for the rest of the game: the reload
      // had happened, and the map was the last place you could tell.
      const look = objectLook(obj);
      if (look !== null && spr.lookKey !== look) {
        spr.destroy();
        this.objSprites.delete(id);
        this.spawnObjectSprite(obj);
        continue;
      }
      // Map objects were furniture: placed once at generation and never moved, so
      // nothing in the view ever re-seated one. Ronins MARCH (core/ronins
      // .marchRonins moves the object and re-keys its tile every dawn), and their
      // token went on standing where the captain rose — for the rest of the game.
      // The marker below would then have been a lie about the one thing it exists
      // to report, which is worse than no marker: a stack you walk around because
      // you can see its banner, and a band that is actually three tiles away and
      // about to reach the fight you started. Cheap for the furniture — the
      // comparison fails only for something that really moved.
      const ox = obj.x * T + T / 2, oy = obj.y * T + T / 2;
      if (spr.x !== ox || spr.y !== oy) {
        spr.setPosition(ox, oy);
        spr.setDepth(obj.y * T + T * 0.8);
        spr.setVisible(this.curExplored(obj.x, obj.y));
      }
      if (obj.type === 'monster' && spr.countLabel) this.paintCount(spr.countLabel, obj);
      if (obj.type === 'mine' && spr.flag) {
        spr.flag.setVisible(obj.owner >= 0);
        if (obj.owner >= 0) spr.flag.setTexture(`flag_${bannerSlot(this.state, obj.owner)}`);
      }
      if (obj.type === 'town' && spr.flag) {
        const town = s.towns[obj.townId];
        spr.flag.setVisible(town.owner >= 0);
        if (town.owner >= 0) spr.flag.setTexture(`flag_${bannerSlot(this.state, town.owner)}`);
      }
    }
    for (const [id, spr] of [...this.heroSprites]) {
      const hero = s.heroes[id];
      // Drop the sprite if the hero is gone OR has left the displayed level
      // (descended/emerged) — it will be respawned on its own level's view.
      if (!hero || (hero.z ?? 0) !== this.viewLevel) {
        spr.destroy();
        this.heroSprites.delete(id);
        // A hero that is GONE (died in a fight, dismissed) must hand the
        // selection to a survivor, not to nothing. The whole side panel — the
        // hero card, the army grid, the Cast Spell button — lives inside an
        // `if (hero)` in AdvUIScene, so deselecting empties it, and the only
        // thing that used to re-select was the dawn pass. Lose a hero mid-turn
        // to an invasion and you played the rest of that turn with no panel.
        if (!hero && this.selectedHeroId === id) {
          const alive = playerHeroes(s, 0);
          this.selectHero(alive.length ? alive[0].id : null);
        }
        continue;
      }
      spr.setPosition(hero.x * T + T / 2, hero.y * T + T / 2);
      spr.setDepth(hero.y * T + T);
      if (spr.boatHull) spr.boatHull.setVisible(!!hero.onBoat); // show hull while aboard
    }
    for (const hero of Object.values(s.heroes)) {
      if ((hero.z ?? 0) === this.viewLevel && !this.heroSprites.has(hero.id)) this.spawnHeroSprite(hero);
    }
    // Spawn sprites for objects that appeared since the last build — a boat left
    // on disembark, a boat built at a shipyard, etc. (on the displayed level).
    for (const obj of Object.values(objs)) {
      if (!this.objSprites.has(obj.id)) this.spawnObjectSprite(obj);
    }
    this.redrawCaravans();
    this.applySeasonTint();
    this.redrawFog();
    this.buildGrailMarker();
    this.ui?.refreshHUD();
  }

  /**
   * Draw the in-transit caravans (state.caravans). They are moving entities, not
   * map objects, and there are only ever a few, so the layer is cleared and
   * rebuilt each refresh rather than sprite-managed. Fog-gated: a caravan shows
   * only on an explored tile of the displayed level (so an enemy supply run is
   * visible only where you have eyes).
   */
  redrawCaravans() {
    if (!this.caravanLayer) this.caravanLayer = this.add.container(0, 0);
    this.caravanLayer.removeAll(true);
    for (const c of (this.state.caravans || [])) {
      if ((c.z ?? 0) !== this.viewLevel) continue;
      if (!this.curExplored(c.x, c.y)) continue;
      const g = this.add.container(c.x * T + T / 2, c.y * T + T / 2).setDepth(c.y * T + T - 2);
      g.add(this.add.circle(-T * 0.16, T * 0.24, T * 0.08, 0x241c14)); // wheels
      g.add(this.add.circle(T * 0.16, T * 0.24, T * 0.08, 0x241c14));
      g.add(this.add.rectangle(0, T * 0.08, T * 0.52, T * 0.24, 0x6b4f2a).setStrokeStyle(1.5, 0x241c14, 0.9)); // cart
      g.add(this.add.ellipse(0, -T * 0.06, T * 0.48, T * 0.3, 0xe4d6b0).setStrokeStyle(1.5, 0x241c14, 0.9)); // canopy
      if (this.textures.exists(`flag_${bannerSlot(this.state, c.owner)}`)) { // owner pennant
        g.add(this.add.image(T * 0.3, -T * 0.22, `flag_${bannerSlot(this.state, c.owner)}`).setScale((T * 0.3) / 32));
      }
      this.caravanLayer.add(g);
    }
  }

  /**
   * A pulsing X over the buried Grail tile — shown only once the HUMAN player
   * has uncovered every obelisk (so the location is earned, not free), while
   * it's undug, and on the surface where it lies.
   */
  buildGrailMarker() {
    this._grailMarker?.destroy();
    this._grailMarker = null;
    const g = this.state.map.grail;
    if (!g || this.state.grailDug || this.viewLevel !== 0 || !grailKnown(this.state, 0)) return;
    const c = this.add.container(g.x * T + T / 2, g.y * T + T / 2).setDepth(g.y * T + T * 0.5);
    const ring = this.add.circle(0, 0, T * 0.34).setStrokeStyle(3, 0xffe066, 0.9);
    const x = this.add.text(0, 0, '✖', { fontFamily: FONT, fontSize: '22px', color: '#ffe066', stroke: '#241a06', strokeThickness: 4 }).setOrigin(0.5);
    c.add([ring, x]);
    const pulse = this.tweens.add({ targets: ring, scale: 1.35, alpha: 0.35, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    c.once('destroy', () => pulse.remove());
    this._grailMarker = c;
  }

  // =========================================================================
  // Input: camera + selection + movement
  // =========================================================================

  bindInput() {
    const cam = this.cameras.main;

    // Wheel zoom anchored at the pointer. Scene-level, so it fires over an open
    // modal too — the map must not zoom under a dialog the player is reading.
    this.input.on('wheel', (pointer, _objs, _dx, dy) => {
      if (modalOpen()) return;
      this.applyZoom(cam.zoom * (dy > 0 ? 1 / CONFIG.ZOOM_STEP : CONFIG.ZOOM_STEP), pointer.x, pointer.y);
    });

    // Drag panning with movement threshold (so clicks still work). Gated the same
    // way: dragging across a dialog used to pan the map behind it.
    this.dragState = null;
    this.input.on('pointerdown', (p) => {
      if (modalOpen()) return;
      if (p.y < 46 || p.x > this.scale.width - this.hudWidth()) return; // HUD areas
      this.dragState = { x: p.x, y: p.y, sx: cam.scrollX, sy: cam.scrollY, panned: false };
    });
    this.input.on('pointermove', (p) => {
      if (!this.dragState || !p.isDown) return;
      const dx = p.x - this.dragState.x, dy = p.y - this.dragState.y;
      if (!this.dragState.panned && Math.hypot(dx, dy) < 8) return;
      this.dragState.panned = true;
      cam.scrollX = this.dragState.sx - dx / cam.zoom;
      cam.scrollY = this.dragState.sy - dy / cam.zoom;
    });
    this.input.on('pointerup', (p) => {
      const wasPan = this.dragState?.panned;
      this.dragState = null;
      if (wasPan) return;
      if (p.y < 46 || p.x > this.scale.width - this.hudWidth()) return;
      // A click during your own hero's walk interrupts it: the hero stops at the
      // next tile and we offer a fresh route from there (see executeMove +
      // requestMoveInterrupt). AI turns and teleport transits are never cut.
      if (this.moving && !this.aiRunning) { this.requestMoveInterrupt(p); return; }
      this.onWorldClick(p);
    });
    // Hover a map object to see what it is (and who owns it).
    this.input.on('pointermove', (p) => { this.updateObjectHover(p); this.updateDimDoorCursor(p); });

    // Hotkeys must respect open modal dialogs (which only block pointers).
    this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,H,E');
    this.input.keyboard.on('keydown-E', () => { if (!modalOpen()) this.onEndTurn(); });
    this.input.keyboard.on('keydown-H', () => { if (!modalOpen()) this.cycleHero(); });
    this.input.keyboard.on('keydown-C', () => { if (!modalOpen()) this.openAdventureSpellbook(); });
    this.input.keyboard.on('keydown-G', () => { if (!modalOpen()) this.digWithSelectedHero(); });
    // Zoom: +/= to zoom in, -/_ to zoom out (mirrors the wheel + HUD buttons).
    this.input.keyboard.on('keydown-PLUS', () => { if (!modalOpen()) this.nudgeZoom(CONFIG.ZOOM_STEP); });
    this.input.keyboard.on('keydown-EQUALS', () => { if (!modalOpen()) this.nudgeZoom(CONFIG.ZOOM_STEP); });
    this.input.keyboard.on('keydown-MINUS', () => { if (!modalOpen()) this.nudgeZoom(1 / CONFIG.ZOOM_STEP); });
    this.input.keyboard.on('keydown-ESC', () => {
      // The only hotkey here that used to skip the modal gate: ESC closes an open
      // dialog, and that same keypress must not ALSO cancel an armed spell behind it.
      if (modalOpen()) return;
      if (this.castTarget) { this.castTarget = null; this.clearDimDoorTargeting(); this.ui?.toast('Spell cancelled.'); }
    });
    this.input.keyboard.on('keydown-SPACE', () => {
      if (modalOpen()) return;
      // HoMM3 Space = "visit the object under the hero". If the selected hero
      // stands on a portal/gate/whirlpool, step back through it (the escape hatch
      // for a hero teleported onto an exit hemmed in by rock); otherwise re-centre.
      if (this.useTeleporterUnderSelectedHero()) return;
      const hero = this.state.heroes[this.selectedHeroId];
      if (hero) this.cameras.main.pan(hero.x * T, hero.y * T, 250, 'Sine.easeInOut');
    });
  }

  /** The portal/subGate/whirlpool the hero is standing on, or null. */
  teleporterUnderHero(hero) {
    if (!hero) return null;
    const tile = tileAt(this.state, hero.x, hero.y, hero.z ?? 0);
    const obj = tile?.objectId ? levelObjects(this.state, hero.z ?? 0)[tile.objectId] : null;
    if (obj && obj.type === 'monolith' && obj.dir === 'entrance') return obj; // an exit is inert
    return obj && (obj.type === 'portal' || obj.type === 'subGate' || obj.type === 'whirlpool') ? obj : null;
  }

  /**
   * Re-use the teleporter the selected hero is standing on (Space / the hero-card
   * button). Animates the transit exactly like a stepped-onto one and follows the
   * hero to the exit. Returns true if a teleporter was used (so the caller can
   * skip its fallback), false otherwise.
   */
  useTeleporterUnderSelectedHero() {
    if (this.moving || this.aiRunning) return false;
    const hero = this.state.heroes[this.selectedHeroId];
    if (!hero || hero.owner !== 0 || (hero.z ?? 0) !== this.viewLevel) return false;
    if (!this.teleporterUnderHero(hero)) return false;
    const spr = this.heroSprites.get(hero.id);
    const ev = useObjectUnderHero(this.state, hero);
    const done = () => { this.moving = false; this.refreshWorld(); this.followHeroAfterTeleport(hero); };
    if (ev.type === 'portal' || ev.type === 'monolith') { this.moving = true; this.animatePortal(hero, spr, ev, done); return true; }
    if (ev.type === 'subGate') { this.moving = true; this.animateSubGate(hero, ev, done); return true; }
    if (ev.type === 'whirlpool') { this.moving = true; this.animateWhirlpool(hero, spr, ev, done); return true; }
    if (ev.type === 'blockedExit') { this.ui?.toast('The far end is blocked — someone is standing on it.'); return true; }
    return false;
  }

  update(_time, dt) {
    const cam = this.cameras.main;
    // Before anything else, including the walk-follow early return below: a bake
    // left half-finished because a hero happened to be walking is a map with a
    // hole in it for as long as the walk lasts.
    this.stepTerrainBake();
    // While a hero (yours, or a visible enemy on its turn) is walking, the camera
    // trails it automatically and manual pan/edge-scroll stand down so the two
    // don't fight; ordinary controls resume the moment the walk ends.
    if (this.followMovingHero(cam, dt)) { this.ui?.updateMinimapViewport(); return; }
    const v = (dt / 1000) * 900 / cam.zoom;
    if (this.keys?.A.isDown || this.keys?.LEFT.isDown) cam.scrollX -= v;
    if (this.keys?.D.isDown || this.keys?.RIGHT.isDown) cam.scrollX += v;
    if (this.keys?.W.isDown || this.keys?.UP.isDown) cam.scrollY -= v;
    if (this.keys?.S.isDown || this.keys?.DOWN.isDown) cam.scrollY += v;
    this.edgeScroll(cam, dt);
    this.ui?.updateMinimapViewport();
  }

  /**
   * Soft-follow the token currently walking (set on `this._followSprite` by the
   * human move executor and the AI trail replay). Keeps the token inside a
   * central deadzone box, easing the camera toward the needed correction so a
   * walk never runs off the edge and short hops don't shove the map around. The
   * camera's own bounds clamp the result to the map. Returns true while it owns
   * the camera (so update() suspends manual pan), false when nothing is walking.
   */
  followMovingHero(cam, dt) {
    const spr = this._followSprite;
    if (!(this.moving || this.aiRunning) || !spr || !spr.active) return false;
    const view = cam.worldView;
    const mx = (view.width * (1 - MOVE_FOLLOW_DEADZONE)) / 2;
    const my = (view.height * (1 - MOVE_FOLLOW_DEADZONE)) / 2;
    const left = view.x + mx, right = view.right - mx;
    const top = view.y + my, bottom = view.bottom - my;
    let tx = cam.scrollX, ty = cam.scrollY;
    if (spr.x < left) tx -= left - spr.x;
    else if (spr.x > right) tx += spr.x - right;
    if (spr.y < top) ty -= top - spr.y;
    else if (spr.y > bottom) ty += spr.y - bottom;
    const k = Math.min(1, MOVE_FOLLOW_LERP * (dt / 16.67)); // frame-rate independent ease
    cam.scrollX += (tx - cam.scrollX) * k;
    cam.scrollY += (ty - cam.scrollY) * k;
    return true;
  }

  /** Is a tile's centre currently inside the camera's visible world rect? Used to
   *  decide whether to trail an enemy hero (only ones already on screen). */
  isTileInView(x, y) {
    const view = this.cameras.main.worldView;
    const wx = x * T + T / 2, wy = y * T + T / 2;
    return wx >= view.x && wx <= view.right && wy >= view.y && wy <= view.bottom;
  }

  /** HoMM-style: nudge the camera when the pointer nears an edge of the map view. */
  edgeScroll(cam, dt) {
    if (this.dragState || modalOpen()) return;
    if (typeof document !== 'undefined' && !document.hasFocus()) return; // not when unfocused
    const p = this.input.activePointer;
    if (!p) return;
    const W = this.scale.width, H = this.scale.height;
    const right = W - this.hudWidth(), top = 46, EDGE = 44;
    if (p.x < 0 || p.y < top || p.x > right || p.y > H) return; // only inside the map view
    const sp = (dt / 1000) * 850 / cam.zoom;
    if (p.x < EDGE) cam.scrollX -= sp * (1 - p.x / EDGE);
    else if (p.x > right - EDGE) cam.scrollX += sp * (1 - (right - p.x) / EDGE);
    if (p.y < top + EDGE) cam.scrollY -= sp * (1 - (p.y - top) / EDGE);
    else if (p.y > H - EDGE) cam.scrollY += sp * (1 - (H - p.y) / EDGE);
  }

  onWorldClick(pointer) {
    if (this.moving || this.aiRunning) return;
    // A settled game swallows world input — but silently swallowing it is what
    // stranded players whose outcome dialog had been dismissed. Put it back.
    if (this.state.winner !== null) { this.checkGameOver(); return; }
    // Dialog blockers only stop object-level input, and modalOpen() alone is not
    // enough: the pointerup that CLOSED a modal reaches this handler in the same
    // dispatch, once the gate has already opened — so the press that dismissed the
    // Town Portal chooser or the spellbook would also order the hero to walk.
    if (worldClicksBlocked()) return;
    if (currentPlayer(this.state).index !== 0) return;

    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    let tx = Math.floor(world.x / T);
    let ty = Math.floor(world.y / T);
    const s = this.state;
    if (tx < 0 || ty < 0 || tx >= s.map.w || ty >= s.map.h) return;

    // Dimension Door / other click-targeted spells: this click is the target. A
    // failed target (blocked tile) keeps you in targeting mode — the toast says
    // why and the green overlay/✗ marker guide you to a legal tile; only a
    // successful cast ends it.
    if (this.castTarget) {
      const { heroId, spellId } = this.castTarget;
      const hero = s.heroes[heroId];
      const cast = hero ? this.performCast(hero, spellId, { x: tx, y: ty }) : false;
      if (cast || !hero) { this.castTarget = null; this.clearDimDoorTargeting(); }
      return;
    }

    if (!this.curExplored(tx, ty)) return;

    // Click own hero: an ordinary, spaced click COMMITS the action the cursor is
    // showing; a RAPID re-click (< HERO_ACTION_MS after the last click on this
    // hero) CYCLES the pointer to the next intent (info → exchange → select) so
    // you can pick a different action. Committing = the usual behaviour: exchange
    // with an adjacent selected hero, open a town you're standing in, else select.
    const clickedHero = heroAt(s, tx, ty, this.viewLevel);
    if (clickedHero && clickedHero.owner === 0) {
      const now = this.time.now;
      const dt = (this._heroClick?.id === clickedHero.id) ? now - this._heroClick.t : Infinity;
      this._heroClick = { id: clickedHero.id, t: now };
      if (dt < HERO_ACTION_MS) {
        this.showHeroHover(clickedHero); // rapid re-click: cycle to the next cursor; don't act
        return;
      }
      const selected = s.heroes[this.selectedHeroId];
      if (selected && selected.id !== clickedHero.id
        && Math.max(Math.abs(selected.x - clickedHero.x), Math.abs(selected.y - clickedHero.y)) === 1) {
        this.openHeroMeet(selected.id, clickedHero.id);
        return;
      }
      if (this.selectedHeroId === clickedHero.id && clickedHero.inTownId) {
        this.openTown(clickedHero.inTownId);
        return;
      }
      this.selectHero(clickedHero.id);
      return;
    }

    // Bigger town target: the castle sprite rises ~2 tiles above its base, so a
    // click anywhere on that footprint counts as a click on the town's gate tile.
    // (Skip when a hero sits on the tile — that click was for the hero.) The hero
    // then routes to the front, since findPath enforces the gate approach.
    if (!clickedHero) {
      const footTown = this.townFootprintAt(tx, ty);
      if (footTown) { tx = footTown.x; ty = footTown.y; }
    }

    const hero = s.heroes[this.selectedHeroId];

    const tile = tileAt(s, tx, ty, this.viewLevel);
    const obj = tile.objectId ? this.curObjects()[tile.objectId] : null;

    // Double-click an OWN town on the map: open its screen in place, whatever is
    // selected — manage a far town without marching a hero across the world. A
    // deliberate (slower) two-click still previews/moves a selected hero there.
    if (obj?.type === 'town' && s.towns[obj.townId]?.owner === 0) {
      const now = this.time.now;
      const dbl = this._lastTownClick && this._lastTownClick.id === obj.townId
        && (now - this._lastTownClick.t) < 350;
      this._lastTownClick = dbl ? null : { id: obj.townId, t: now };
      if (dbl) { this.clearPreview(); this.openTown(obj.townId); return; }
    }

    // Click own town without a selected hero: open it.
    if (obj?.type === 'town' && s.towns[obj.townId].owner === 0 && !hero) {
      this.openTown(obj.townId);
      return;
    }
    if (!hero) return;
    // The selected hero must be on the level you're looking at to take orders.
    if ((hero.z ?? 0) !== this.viewLevel) return;

    // Second click on the same tile: go!
    if (this.preview && this.preview.tx === tx && this.preview.ty === ty) {
      this.executeMove(hero, this.preview.path);
      return;
    }

    // First click: compute & draw path preview.
    const found = findPath(s, hero, tx, ty, 0);
    if (!found) {
      this.clearPreview();
      return;
    }
    this.preview = { tx, ty, path: found.path, totalCost: found.totalCost };
    this.drawPreview(hero);
  }

  drawPreview(hero) {
    const g = this.previewG;
    g.clear();
    if (!this.preview) return;
    let mp = hero.mp;
    let px = hero.x, py = hero.y;
    for (let i = 0; i < this.preview.path.length; i++) {
      const step = this.preview.path[i];
      const within = mp >= step.cost;
      if (within) mp -= step.cost;
      const cx = step.x * T + T / 2, cy = step.y * T + T / 2;
      const last = i === this.preview.path.length - 1;
      g.fillStyle(within ? 0x9fe870 : 0xe86f5f, last ? 1 : 0.85);
      g.lineStyle(2, 0x10240a, 0.8);
      if (last) {
        const ax = px * T + T / 2, ay = py * T + T / 2;
        const ang = Math.atan2(cy - ay, cx - ax);
        const r = 13;
        g.beginPath();
        g.moveTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
        g.lineTo(cx + Math.cos(ang + 2.6) * r, cy + Math.sin(ang + 2.6) * r);
        g.lineTo(cx + Math.cos(ang - 2.6) * r, cy + Math.sin(ang - 2.6) * r);
        g.closePath();
        g.fillPath();
        g.strokePath();
      } else {
        g.fillCircle(cx, cy, 5.5);
        g.strokeCircle(cx, cy, 5.5);
      }
      px = step.x; py = step.y;
    }
  }

  clearPreview() {
    this.preview = null;
    this.previewG?.clear();
  }

  // =========================================================================
  // Adventure-map spells (Town Portal, Dimension Door, View Air, Summon Boat)
  // =========================================================================

  /** Open the spellbook for the selected hero (C key / hero-card button). */
  openAdventureSpellbook() {
    if (modalOpen() || this.moving || this.aiRunning) return;
    this.castTarget = null;
    this.clearDimDoorTargeting();
    this.ui?.openAdventureSpellbook();
  }

  /** Dig for the Grail with the selected hero (G key / hero-card button). */
  digWithSelectedHero() {
    if (modalOpen() || this.moving || this.aiRunning) return;
    const hero = this.state.heroes[this.selectedHeroId];
    if (!hero || hero.owner !== 0) return;
    const res = digForGrail(this.state, hero);
    if (res.found) {
      playSfx('pickup');
      this.buildGrailMarker(); // the buried spot is now empty
    }
    this.refreshWorld();
    this.ui?.toast(res.text);
  }

  /** From the spellbook: cast now, or enter click-to-target mode (Dimension Door). */
  castOrTarget(heroId, spellId) {
    const hero = this.state.heroes[heroId];
    if (!hero) return;
    if (SPELLS[spellId]?.cast === 'dimensionDoor') {
      this.castTarget = { heroId, spellId };
      this.beginDimDoorTargeting(hero);
      this.ui?.toast('Dimension Door — green tiles are safe to blink to; a red ✗ means you can\'t land there (Esc cancels).');
      return;
    }
    if (SPELLS[spellId]?.cast === 'townPortal') {
      // Refuse up front with the same words the engine uses, so we never pop a
      // town chooser the hero hasn't the movement to act on.
      if ((hero.mp || 0) < adventureParam(hero, 'townPortal', CONFIG.TOWN_PORTAL_MP_BY_SCHOOL)) {
        this.ui?.toast('Not enough movement left to cast this spell.');
        return;
      }
      const towns = townPortalTowns(this.state, hero);
      if (townPortalCanChoose(hero) && towns.length > 1) {
        this.openTownPortalChooser(hero, spellId, towns);
        return;
      }
      this.performCast(hero, spellId, null); // no Earth Magic (or a lone town): nearest
      return;
    }
    this.performCast(hero, spellId, null);
  }

  /**
   * An Earth mage's Town Portal destination picker: a grid of the hero's towns
   * across BOTH map levels, each a card with the town's sprite + name (easier to
   * recognise than a name alone), its level, and an "occupied" flag. The hero's
   * own level sorts first, then by distance. Rendered on the HUD scene (static
   * camera) like every other adventure dialog — the map camera scrolls, so a
   * dialog on THIS scene would drift off-screen.
   */
  openTownPortalChooser(hero, spellId, towns) {
    const host = this.ui || this;
    const W = host.scale.width, H = host.scale.height;
    const fromLvl = hero.z ?? 0;
    const dist = (t) => Math.max(Math.abs(t.x - hero.x), Math.abs(t.y - hero.y));
    const rank = (t) => ((t.z ?? 0) === fromLvl ? 0 : 1);
    const ordered = [...towns].sort((a, b) => rank(a) - rank(b) || dist(a) - dist(b));
    const busy = (t) => t.visitingHeroId && t.visitingHeroId !== hero.id;

    const CW = 120, CH = 128, gap = 12;
    const COLS = Math.min(4, Math.max(1, ordered.length));
    const rows = Math.ceil(ordered.length / COLS);
    const gridW = COLS * CW + (COLS - 1) * gap;
    const pw = Math.max(360, gridW + 48);
    const ph = Math.min(H - 20, 84 + rows * CH + (rows - 1) * gap + 56);
    const px = (W - pw) / 2, py = (H - ph) / 2;

    const root = host.add.container(0, 0).setDepth(DEPTH.MODAL);
    trackModal(root); // so the map behind doesn't process the picking clicks
    root.add(host.add.rectangle(W / 2, H / 2, W * 2, H * 2, 0x000000, 0.6).setInteractive());
    const close = () => root.destroy();

    root.add(panel(host, px, py, pw, ph));
    root.add(label(host, W / 2, py + 20, 'Town Portal', { size: '19px', bold: true, color: COLORS.gold, ox: 0.5 }));
    root.add(label(host, W / 2, py + 44, 'Recall to which town?', { size: '13px', color: COLORS.dim, ox: 0.5 }));

    const gx0 = px + (pw - gridW) / 2 + CW / 2;
    const gy0 = py + 84 + CH / 2;
    ordered.forEach((t, i) => {
      const cx = gx0 + (i % COLS) * (CW + gap);
      const cy = gy0 + Math.floor(i / COLS) * (CH + gap);
      const cell = host.add.rectangle(cx, cy, CW - 6, CH - 6, 0x14121f, 0.5).setStrokeStyle(2, 0x4a4560)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => cell.setStrokeStyle(2, 0xe8c060))
        .on('pointerout', () => cell.setStrokeStyle(2, 0x4a4560))
        .on('pointerup', () => { root.destroy(); this.performCast(hero, spellId, { townId: t.id }); });
      root.add(cell);
      root.add(townIcon(host, FACTIONS[t.faction].townGlyph, cx, cy - 24, 54));
      root.add(label(host, cx, cy + 22, t.name, { size: '12px', bold: true, ox: 0.5, oy: 0.5, color: COLORS.parchment, align: 'center', wrap: CW - 14 }));
      const tag = `${(t.z ?? 0) === 0 ? 'surface' : 'underground'}${busy(t) ? ' · occupied' : ''}`;
      root.add(label(host, cx, cy + 50, tag, { size: '10px', ox: 0.5, oy: 0.5, color: busy(t) ? COLORS.danger : COLORS.dim }));
    });

    root.add(button(host, W / 2, py + ph - 26, 130, 34, 'Cancel', close));
    const kb = host.input?.keyboard;
    if (kb) { const onEsc = () => close(); kb.once('keydown-ESC', onEsc); root.once('destroy', () => kb.off('keydown-ESC', onEsc)); }
    // `host` may be THIS scene, whose camera pans across the map — an unpinned
    // overlay would be drawn out in the world, off screen (see pinToScreen).
    pinToScreen(root);
  }

  /**
   * Show where a Dimension Door can land: paint every legal tile in range with a
   * soft green wash, and prime the hover marker (updated by updateDimDoorCursor).
   * The overlay is static — targeting doesn't move the hero — so it's drawn once.
   */
  beginDimDoorTargeting(hero) {
    this.clearDimDoorTargeting();
    // The mastered reach, so the green tiles the player sees are exactly the
    // ones the engine will accept (dimDoorLandable reads the same ladder).
    const R = adventureParam(hero, 'dimensionDoor', CONFIG.DIM_DOOR_RANGE_BY_SCHOOL);
    const g = this.add.graphics().setDepth(DEPTH.FOG + 2);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = hero.x + dx, y = hero.y + dy;
        if (x < 0 || y < 0 || x >= this.state.map.w || y >= this.state.map.h) continue;
        if (!dimDoorLandable(this.state, hero, x, y)) continue;
        g.fillStyle(0x5ad06a, 0.22);
        g.fillRect(x * T + 3, y * T + 3, T - 6, T - 6);
        g.lineStyle(1.5, 0x8ff0a0, 0.5);
        g.strokeRect(x * T + 3, y * T + 3, T - 6, T - 6);
      }
    }
    this._ddRangeG = g;
    // Hover marker: a ring + a ✓ / ✗ glyph snapped to the tile under the pointer.
    const cur = this.add.container(0, 0).setDepth(DEPTH.FOG + 3).setVisible(false);
    const ring = this.add.graphics();
    const icon = this.add.text(0, 0, '', { fontFamily: FONT, fontSize: '30px', fontStyle: 'bold', stroke: '#0a0a0a', strokeThickness: 5 }).setOrigin(0.5);
    cur.add([ring, icon]);
    cur.ring = ring; cur.icon = icon;
    this._ddCursor = cur;
    this.updateDimDoorCursor(this.input.activePointer);
  }

  /** Move the Dimension Door hover marker to the tile under the pointer, coloured
   *  green (✓, a legal landing) or red (✗, blocked / out of range / unexplored). */
  updateDimDoorCursor(pointer) {
    if (!this.castTarget || !this._ddCursor || !pointer) return;
    const hero = this.state.heroes[this.castTarget.heroId];
    if (!hero) return;
    const inHud = pointer.y < 46 || pointer.x > this.scale.width - this.hudWidth();
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tx = Math.floor(world.x / T), ty = Math.floor(world.y / T);
    if (inHud || tx < 0 || ty < 0 || tx >= this.state.map.w || ty >= this.state.map.h) {
      this._ddCursor.setVisible(false);
      return;
    }
    const ok = dimDoorLandable(this.state, hero, tx, ty);
    const col = ok ? 0x5ad06a : 0xe8514a;
    this._ddCursor.setPosition(tx * T + T / 2, ty * T + T / 2).setVisible(true);
    const ring = this._ddCursor.ring;
    ring.clear();
    ring.lineStyle(3, col, 0.95);
    ring.strokeCircle(0, 0, T * 0.42);
    this._ddCursor.icon.setText(ok ? '✓' : '✗').setColor(ok ? '#b8ffbf' : '#ff7a68');
  }

  /** Tear down the Dimension Door targeting overlay (cast, cancel, or Esc). */
  clearDimDoorTargeting() {
    this._ddRangeG?.destroy(); this._ddRangeG = null;
    this._ddCursor?.destroy(); this._ddCursor = null;
  }

  /** Resolve an adventure spell and reflect it on the map. */
  performCast(hero, spellId, target) {
    if (this.moving || this.aiRunning) return false;
    const res = castAdventureSpell(this.state, hero, spellId, target);
    if (!res.ok) { this.ui?.toast(res.reason || 'The spell fizzles.'); return false; }
    playSfx(res.type === 'summonBoat' || res.type === 'scuttleBoat' ? 'splash' : 'magic');
    this.refreshWorld();
    if (res.to) this.followHeroAfterTeleport(hero); // teleports: follow to the exit
    else { this.selectHero(hero.id); this.redrawFog(); } // view/summon: just refresh
    this.ui?.refreshHUD();
    this.ui?.toast(`${SPELLS[spellId].name} cast.`);
    return true;
  }

  selectHero(heroId) {
    this.selectedHeroId = heroId;
    this.clearPreview();
    this.selRing?.destroy();
    this.selRing = null;
    const hero = heroId && this.state.heroes[heroId];
    if (hero) {
      // Follow the hero to its level so a selected/cycled hero is always shown
      // (setViewLevel rebuilds the sprites, so re-fetch afterward).
      if ((hero.z ?? 0) !== this.viewLevel) this.setViewLevel(hero.z ?? 0);
      const spr = this.heroSprites.get(heroId);
      if (spr) {
        this.selRing = this.add.ellipse(0, 26, 46, 16).setStrokeStyle(2.5, 0xffe9a0, 0.95);
        spr.addAt(this.selRing, 0);
      }
    }
    // A wild stack's count is about a FIGHT, and which fight depends on who is
    // selected — a stack already priced for one hero is unpriced for the next.
    this.repaintCounts();
    this.ui?.refreshHUD();
  }

  /**
   * After a teleport (portal/whirlpool), guarantee the moved hero is followed:
   * flip to its level if needed, re-select it (restores the ring + HUD), and pan
   * the camera to it. This is the safety net that keeps a just-teleported hero
   * from ever being left off-screen or on the wrong displayed level. Only acts
   * for the human's own hero (an AI teleport must not hijack the camera).
   */
  followHeroAfterTeleport(hero) {
    if (!hero || hero.owner !== 0 || !this.state.heroes[hero.id]) return;
    if ((hero.z ?? 0) !== this.viewLevel) this.setViewLevel(hero.z ?? 0);
    this.selectHero(hero.id);
    this.cameras.main.pan(hero.x * T + T / 2, hero.y * T + T / 2, scaledDuration(220), 'Sine.easeInOut');
  }

  cycleHero() {
    const heroes = playerHeroes(this.state, 0);
    if (!heroes.length) return;
    const idx = heroes.findIndex((h) => h.id === this.selectedHeroId);
    const next = heroes[(idx + 1) % heroes.length];
    this.selectHero(next.id);
    this.cameras.main.pan(next.x * T, next.y * T, 250, 'Sine.easeInOut');
  }

  // =========================================================================
  // Movement execution
  // =========================================================================

  executeMove(hero, path) {
    if (this.moving) return;
    // Scored BEFORE the march, against the AI's own goal ranking for this exact
    // tile. The player is the reference class: where their destination sits in
    // that ranking is what says whether the scorer is wrong (adventureTelemetry).
    const dest = path[path.length - 1];
    if (dest) recordHumanMove(this.state, hero, dest.x, dest.y, { path });
    this.moving = true;
    this._interruptMove = false;   // cleared per walk; a click sets it (feature: halt mid-march)
    this._interruptTarget = null;
    this.hideHeroHover();
    this.clearPreview();
    const spr = this.heroSprites.get(hero.id);
    this._followSprite = spr || null; // the camera trails the walking hero (update loop)

    const stepNext = (i) => {
      if (this.state.winner !== null) { this.moving = false; this.checkGameOver(); return; }
      if (i >= path.length) { this.moving = false; this.refreshWorld(); return; }
      const step = path[i];
      // A Water Walk / Fly hero may only STOP on land, so entering water demands
      // enough movement to reach the far shore this move (stepReserve); short of
      // that the hero halts at the water's edge on land, exactly as when plain
      // movement runs out.
      const reserve = stepReserve(this.state, hero, path, i);
      if (hero.mp < reserve) {
        this.moving = false;
        const onWater = tileAt(this.state, step.x, step.y, hero.z ?? 0)?.terrain === 'water';
        // Infinity = the run never LANDS (a fight on open water at its far
        // end): no amount of resting fixes that, so say so instead of
        // promising tomorrow will (see stepReserve).
        this.ui?.toast(reserve === Infinity
          ? 'The spell can carry you over the water, but there is nowhere to stand — strike from the shore instead.'
          : onWater
            ? 'Not enough movement to reach the far shore — rest until tomorrow.'
            : 'Not enough movement left — rest until tomorrow.');
        this.refreshWorld();
        return;
      }
      const ev = stepHero(this.state, hero, step);
      switch (ev.type) {
        case 'noMp':
        case 'blocked':
          this.moving = false;
          this.refreshWorld();
          return;
        case 'borderGuard':
          // Halted at a locked Border Guard — the hero has no matching key.
          this.moving = false;
          this.refreshWorld();
          this.ui?.toast(`You need the ${keyColorName(ev.color)} Key to pass this Border Guard.`);
          return;
        case 'navalCapture': {
          // A boat hero took an undefended coastal town from the water — the
          // hero stays aboard (no move), the flag flips. Toast + refresh + a
          // win check (a game-ending capture ends here).
          this.moving = false;
          playSfx('build');
          this.ui?.toast('Coastal town captured!');
          this.refreshWorld();
          this.checkGameOver();
          return;
        }
        case 'combat': {
          this.moving = false;
          this.refreshWorld();
          this.launchCombat(ev.context);
          return;
        }
        case 'portal':
        case 'monolith': {
          // A portal/monolith is always the last step of a human path (auto-path
          // never routes *through* one), so end the walk after the teleport.
          // Follow the hero to the exit so they're never left off-screen. The
          // monolith reuses the portal transit animation (same-level teleport).
          this.animatePortal(hero, spr, ev, () => {
            this.moving = false;
            this.refreshWorld();
            this.followHeroAfterTeleport(hero);
          });
          return;
        }
        case 'subGate': {
          // Descending/emerging is always the last step of a human path (gates
          // are through-walls) — switch the displayed level after the transit.
          this.animateSubGate(hero, ev, () => { this.moving = false; this.refreshWorld(); });
          return;
        }
        case 'whirlpool': {
          // A whirlpool is always the last step of a boat path (it is a
          // through-wall too) — spin the hero out at the random exit, then show
          // what the sea took.
          this.animateWhirlpool(hero, spr, ev, () => {
            this.moving = false;
            this.refreshWorld();
            this.followHeroAfterTeleport(hero);
          });
          return;
        }
        default: {
          // 'blockedExit' arrives here too: the hero stepped onto a portal whose
          // far end was occupied, so they simply settle onto it (hero.x/y is the
          // portal tile) — the generic glide is exactly right.
          this.tweens.add({
            targets: spr,
            x: hero.x * T + T / 2,
            y: hero.y * T + T / 2,
            duration: scaledDuration(HUMAN_STEP_MS),
            onUpdate: () => spr.setDepth(spr.y + T / 2),
            onComplete: () => {
              this.redrawFog();
              // If the player clicked to interrupt, this step's event still
              // resolves (a pickup toasts, a mine flags) but the walk halts here
              // instead of continuing — finishMoveInterrupt re-routes from the
              // tile just reached.
              const cont = this._interruptMove
                ? () => this.finishMoveInterrupt(hero)
                : () => stepNext(i + 1);
              // Is this tile the errand, or just on the way to it? Sites the
              // player must decide something at — a dwelling's recruit stepper,
              // a shipyard's boat — stop the march only when the hero was SENT
              // there. An interrupted walk ends here, so that counts as arrival.
              const passing = !this._interruptMove && i < path.length - 1;
              this.handleMoveEvent(hero, ev, cont, passing);
            },
          });
        }
      }
    };
    stepNext(0);
  }

  /**
   * Record a request to interrupt the current walk (a click on the map while a
   * hero is moving). The walk stops at the next tile boundary; the clicked tile
   * is remembered so finishMoveInterrupt can offer it as the new destination.
   */
  requestMoveInterrupt(pointer) {
    if (!this.moving || this.aiRunning) return;
    this._interruptMove = true;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tx = Math.floor(world.x / T), ty = Math.floor(world.y / T);
    const s = this.state;
    this._interruptTarget = (tx >= 0 && ty >= 0 && tx < s.map.w && ty < s.map.h) ? { tx, ty } : null;
  }

  /**
   * Halt a walk the player interrupted with a click. The hero stays on the tile
   * it just reached; we re-select it and, if the interrupting click named a
   * reachable tile, preview a fresh route there so one confirming click sets the
   * new course (matching the normal click-to-preview, click-again-to-go flow).
   */
  finishMoveInterrupt(hero) {
    this.moving = false;
    this._interruptMove = false;
    this._followSprite = null;
    this.refreshWorld();
    this.selectHero(hero.id);
    const t = this._interruptTarget;
    this._interruptTarget = null;
    if (t && (t.tx !== hero.x || t.ty !== hero.y) && this.curExplored(t.tx, t.ty)
        && (hero.z ?? 0) === this.viewLevel) {
      const found = findPath(this.state, hero, t.tx, t.ty, 0);
      if (found) {
        this.preview = { tx: t.tx, ty: t.ty, path: found.path, totalCost: found.totalCost };
        this.drawPreview(hero);
      }
    }
    this.ui?.toast('Movement halted — click to set a new course.');
  }

  /**
   * Teleport animation: glide onto the entry portal, shrink+fade out, reappear
   * at the exit (panning the camera through so the player follows), fade in.
   */
  animatePortal(hero, spr, ev, done) {
    this._followSprite = null; // this animation drives the camera itself (explicit pan)
    const stepMs = scaledDuration(HUMAN_STEP_MS);
    this.tweens.add({
      targets: spr,
      x: ev.from.x * T + T / 2,
      y: ev.from.y * T + T / 2,
      duration: stepMs,
      onUpdate: () => spr.setDepth(spr.y + T / 2),
      onComplete: () => {
        this.redrawFog();
        playSfx('portal');
        this.tweens.add({
          targets: spr, scaleX: 0.2, scaleY: 0.2, alpha: 0, duration: scaledDuration(170),
          ease: 'Sine.easeIn',
          onComplete: () => {
            spr.setPosition(ev.to.x * T + T / 2, ev.to.y * T + T / 2);
            spr.setDepth(spr.y + T / 2);
            this.cameras.main.pan(spr.x, spr.y, scaledDuration(240), 'Sine.easeInOut');
            this.redrawFog();
            this.tweens.add({
              targets: spr, scaleX: 1, scaleY: 1, alpha: 1, duration: scaledDuration(220),
              ease: 'Back.easeOut', onComplete: done,
            });
          },
        });
      },
    });
  }

  /**
   * Whirlpool: glide onto the entry swirl, get sucked DOWN with a fast spin,
   * reappear spinning at the random exit whirlpool (camera follows), and — if
   * the sea took part of the weakest stack — toast the loss. Same shape as
   * animatePortal, but the spin + splash SFX + toll sell the whirlpool.
   */
  animateWhirlpool(hero, spr, ev, done) {
    this._followSprite = null; // this animation drives the camera itself (explicit pan)
    const stepMs = scaledDuration(HUMAN_STEP_MS);
    this.tweens.add({
      targets: spr,
      x: ev.from.x * T + T / 2,
      y: ev.from.y * T + T / 2,
      duration: stepMs,
      onUpdate: () => spr.setDepth(spr.y + T / 2),
      onComplete: () => {
        this.redrawFog();
        playSfx('splash');
        this.tweens.add({
          targets: spr, scaleX: 0.15, scaleY: 0.15, alpha: 0, angle: 540, duration: scaledDuration(240),
          ease: 'Sine.easeIn',
          onComplete: () => {
            spr.setPosition(ev.to.x * T + T / 2, ev.to.y * T + T / 2);
            spr.setAngle(0);
            spr.setDepth(spr.y + T / 2);
            this.cameras.main.pan(spr.x, spr.y, scaledDuration(240), 'Sine.easeInOut');
            this.redrawFog();
            playSfx('splash');
            this.tweens.add({
              targets: spr, scaleX: 1, scaleY: 1, alpha: 1, duration: scaledDuration(240),
              ease: 'Back.easeOut',
              onComplete: () => {
                if (ev.lost) {
                  const nm = CREATURES[ev.lost.creature]?.name || 'crew';
                  this.ui?.toast(`The whirlpool swallowed ${ev.lost.count} ${nm}${ev.lost.count === 1 ? '' : 's'}!`);
                }
                done();
              },
            });
          },
        });
      },
    });
  }

  /**
   * Descend/emerge through a subterranean gate: glide onto the entry gate, sink
   * out, switch the whole view to the destination level (rebuilding it), then
   * rise from the exit gate and re-establish the selection there.
   */
  animateSubGate(hero, ev, done) {
    this._followSprite = null; // this animation drives the camera itself (explicit pan)
    const spr = this.heroSprites.get(hero.id);
    const stepMs = scaledDuration(HUMAN_STEP_MS);
    const emerge = () => {
      playSfx('portal');
      this.setViewLevel(ev.to.level); // rebuilds sprites/terrain/fog for the new level
      this.selectHero(hero.id);        // restore ring + HUD on the new level
      this.cameras.main.pan(hero.x * T + T / 2, hero.y * T + T / 2, scaledDuration(260), 'Sine.easeInOut');
      const nspr = this.heroSprites.get(hero.id);
      if (nspr) {
        nspr.setScale(0.2); nspr.setAlpha(0);
        this.tweens.add({ targets: nspr, scaleX: 1, scaleY: 1, alpha: 1, duration: scaledDuration(240), ease: 'Back.easeOut', onComplete: done });
      } else { done(); }
    };
    if (!spr) { emerge(); return; }
    this.tweens.add({
      targets: spr, x: ev.from.x * T + T / 2, y: ev.from.y * T + T / 2, duration: stepMs,
      onUpdate: () => spr.setDepth(spr.y + T / 2),
      onComplete: () => {
        this.tweens.add({ targets: spr, scaleX: 0.2, scaleY: 0.2, alpha: 0, duration: scaledDuration(180), ease: 'Sine.easeIn', onComplete: emerge });
      },
    });
  }

  /**
   * Post-step events that need UI (dialogs stop the walk).
   *
   * `passing` says the hero is crossing this tile on the way somewhere else, not
   * arriving at it. Sites that ask the player to DECIDE something — a dwelling's
   * recruit stepper, a shipyard's boat offer — respect it and let the march
   * continue, because a road that happens to run over a dwelling should not
   * interrogate every hero who uses it. Rewards and one-off benefits ignore it:
   * a chest or an artifact must never be walked past unseen.
   */
  handleMoveEvent(hero, ev, continueWalk, passing = false) {
    switch (ev.type) {
      case 'pickup':
        playSfx('coin');
        this.ui?.toast(`Picked up ${ev.amount} ${ev.resource}.`);
        this.ui?.refreshHUD();
        continueWalk();
        return;
      case 'artifact': {
        this.moving = false;
        this.refreshWorld();
        const art = ARTIFACTS[ev.artifact] || { name: ev.artifact, desc: '' };
        this.ui?.artifactDialog(art.name, art.desc, artifactTextureKey(this, ev.artifact));
        return;
      }
      case 'chest':
        this.moving = false;
        this.ui?.chestDialog(hero, ev, (tookXp) => {
          this.refreshWorld();
          if (tookXp) this.ui?.maybeShowLevelUps(hero);
        });
        return;
      case 'mineFlagged':
        playSfx('build');
        this.ui?.toast(`${mineName(ev.mineType)} is now yours.`);
        this.refreshWorld();
        continueWalk();
        return;
      case 'caravanRaided': {
        // Scattered an enemy supply caravan for XP — toast it and roll any
        // level-up, then carry on.
        playSfx('coin');
        this.ui?.toast(`Intercepted a caravan of ${ev.count} ${CREATURES[ev.creature]?.name || ev.creature}! (+${ev.xp} XP)`);
        this.refreshWorld();
        if (ev.events?.some((e) => e.type === 'levelUp')) {
          this.moving = false;
          this.ui?.maybeShowLevelUps(hero, () => continueWalk());
          return;
        }
        continueWalk();
        return;
      }
      case 'dwelling': {
        // Flagged the site; open the recruit stepper (the walk stops for it) —
        // unless the hero is only crossing the tile, in which case say what is on
        // offer and keep marching. The flag and the weekly stock are unaffected;
        // the player can come back when buying is the errand.
        if (passing) {
          const cName = CREATURES[ev.creature]?.name || ev.creature;
          this.ui?.toast(ev.available > 0
            ? `${ev.name}: ${ev.available} ${cName} waiting to be hired.`
            : `${ev.name}: no ${cName} to hire yet.`);
          this.refreshWorld();
          continueWalk();
          return;
        }
        this.moving = false;
        this.refreshWorld();
        const obj = ((hero.z ?? 0) ? this.state.map.underground?.objects : this.state.map.objects)?.[ev.objectId];
        if (obj) {
          this.ui?.dwellingDialog(this.state, obj, hero, () => { this.refreshWorld(); this.ui?.refreshHUD?.(); });
        } else continueWalk();
        return;
      }
      case 'lairBrood':
        // A cleared lair that bred since: the young join on contact, like a
        // pickup, so it never defers to `passing` — walking over your own dragon
        // farm and leaving the dragons behind would be the bug, not the courtesy.
        if (ev.full) {
          this.ui?.toast(`${ev.name}: ${ev.available} ${CREATURES[ev.creature]?.name || ev.creature} wait — your army has no room.`);
          continueWalk();
          return;
        }
        playSfx('coin');
        this.ui?.toast(`${ev.name}: ${ev.count} ${CREATURES[ev.creature]?.name || ev.creature} join you.`);
        this.ui?.refreshHUD?.();
        this.refreshWorld();
        continueWalk();
        return;
      case 'keymaster':
        // Walkable tent: grant the key (once) and keep walking.
        if (ev.isNew) {
          playSfx('coin');
          this.ui?.toast(`Received the ${keyColorName(ev.color)} Key!`);
          this.ui?.refreshHUD?.();
          this.refreshWorld();
        }
        continueWalk();
        return;
      case 'pandora': {
        // An unguarded box opened by walking onto it: toast the treasure, resolve
        // any level-up (XP rewards), and carry on.
        playSfx('coin');
        this.ui?.toast(`Pandora's Box yields ${pandoraRewardText(ev.reward)}!`);
        this.ui?.refreshHUD?.();
        this.refreshWorld();
        if (ev.events?.some((e) => e.type === 'levelUp')) {
          this.moving = false;
          this.ui?.maybeShowLevelUps(hero, () => continueWalk());
          return;
        }
        continueWalk();
        return;
      }
      case 'shipyard': {
        // Buying a boat is an errand, and a dock sits on the shoreline every
        // coastal road runs along — so a hero merely crossing it is not asked.
        // Silently, too: there is nothing to miss, and a toast per crossing would
        // be worse than the dialog it replaced.
        if (passing) { continueWalk(); return; }
        this.moving = false;
        this.refreshWorld();
        if (ev.canBuild) {
          this.ui?.shipyardDialog(ev.cost, () => {
            const res = buildBoat(this.state, hero, ev.objectId);
            if (res.type === 'boatBuilt') { playSfx('build'); this.ui?.toast('A boat awaits at the dock.'); }
            else this.ui?.toast('The boat could not be built.');
            this.refreshWorld();
          });
        } else {
          const why = ev.reason === 'cost' ? 'You cannot afford a boat here.'
            : ev.reason === 'boatAtDock' ? 'A boat is already docked here.'
              : 'There is no open water to launch a boat.';
          this.ui?.toast(why);
        }
        return;
      }
      case 'embark': {
        playSfx('splash');
        const spr = this.heroSprites.get(hero.id);
        if (spr?.boatHull) spr.boatHull.setVisible(true);
        this.refreshWorld(); // the boarded boat is gone from the map
        continueWalk();
        return;
      }
      case 'disembark': {
        playSfx('splash');
        const spr = this.heroSprites.get(hero.id);
        if (spr?.boatHull) spr.boatHull.setVisible(false);
        this.refreshWorld(); // a boat now waits on the vacated water tile
        // Landed on a pickup (e.g. an island reward)? Resolve it as a normal
        // step event — a chest opens its dialog, a resource toasts, and so on.
        if (ev.landed && ev.landed.type !== 'moved') { this.handleMoveEvent(hero, ev.landed, continueWalk, passing); return; }
        continueWalk();
        return;
      }
      case 'visited':
        // A spent / no-benefit site (mana already full, windmill drained, a
        // skill already known…) no longer halts the march — toast it and walk
        // on. A beneficial visit still stops to show its dialog so the reward
        // is never missed. (Movement can also be halted mid-step: see the
        // interrupt handling that wraps continueWalk in executeMove.)
        if (ev.noBenefit) {
          this.ui?.toast(`${ev.name}: ${ev.text}`);
          continueWalk();
          return;
        }
        this.moving = false;
        this.refreshWorld();
        // Feedback on the same channel gold already had. A structure that DID
        // something for you says so out loud — `statup` for a permanent point,
        // `visit` for everything else a visit grants. A spent site (above) stays
        // silent on purpose: it gave you nothing, and a reward chime for nothing is
        // worse than no chime at all.
        playSfx(ev.statGain ? 'statup' : 'visit');
        this.ui?.visitedDialog(ev.name, ev.text);
        if (ev.events?.some((e) => e.type === 'levelUp')) this.ui?.maybeShowLevelUps(hero);
        return;
      case 'seerHut':
        // An already-fulfilled Seer Hut has nothing to offer — toast & carry on.
        if (ev.done) {
          this.ui?.toast('Seer Hut — this quest is already fulfilled.');
          continueWalk();
          return;
        }
        this.moving = false;
        this.refreshWorld();
        this.ui?.seerHutDialog(hero, ev, (levels) => {
          this.refreshWorld();
          if (levels > 0) this.ui?.maybeShowLevelUps(hero);
        });
        return;
      case 'tradingPost':
        this.moving = false;
        this.refreshWorld();
        this.ui?.tradingPostDialog(hero, ev, (levels) => {
          this.refreshWorld();
          if (levels > 0) this.ui?.maybeShowLevelUps(hero);
        });
        return;
      case 'enterTown': {
        this.moving = false;
        this.refreshWorld();
        if (ev.captured) this.ui?.toast('Town captured!');
        const town = this.state.towns[ev.townId];
        const enter = () => { this.openTown(ev.townId); this.checkGameOver(); };
        // Carrying the Grail into one of your own towns → offer to enshrine it.
        if (hero.carryingGrail && town && town.owner === hero.owner) {
          this.ui?.grailDeliverDialog(hero, town, enter);
        } else {
          enter();
        }
        return;
      }
      default:
        continueWalk();
    }
  }

  // =========================================================================
  // Combat / Town / Hero scene bridges
  // =========================================================================

  launchCombat(ctx, opts = {}) {
    // Two ways an encounter ends without the battle the caller asked for, and the
    // order between them is the rule: a band that would TAKE YOUR GOLD does not run
    // from you, so the bargain is offered first and the flight is what is left for
    // the bands that would not deal. Either dialog handles the encounter itself
    // (recruit / let go / a deferred Fight), so combat does not open now.
    if (!ctx._noParley && this.maybeParley(ctx, opts)) return;
    if (!ctx._noFlee && this.maybeFlee(ctx, opts)) return;
    this._doLaunchCombat(ctx, opts);
  }

  /**
   * Diplomacy: offer to parley a neutral stack. Shows a Fight/Parley dialog and
   * returns true (it handled the encounter) — Parley recruits and continues, Fight
   * re-enters launchCombat with the parley skipped. Returns false to fall through
   * to a normal battle when there is no offer (feature off, too strong, not human).
   */
  maybeParley(ctx, opts) {
    const s = this.state;
    if (!featureOn(s, 'diplomacy') || ctx.defender?.kind !== 'monster') return false;
    const hero = s.heroes[ctx.attackerHeroId];
    if (!hero || hero.owner !== 0) return false; // the human decides its own parleys
    const monster = getObject(s, ctx.defender.objectId);
    if (!monster) return false;
    const offer = ctx.parleyOffer || parleyOffer(s, hero, monster);
    if (!offer.offered) return false;
    // A refusal is not an outcome worth a modal of its own once flight exists: the
    // band that will not bargain is exactly the band that may bolt, and stopping
    // to say "they refuse" before the flee check would bury that fork behind a
    // click. The refusal still shows — as a line in the flee dialog, or, if they
    // stand their ground, as the battle the player already asked for.
    if (offer.refused) return false;
    const name = CREATURES[monster.creature]?.name || 'neutrals';
    const afford = canAfford(s.players[0], { gold: offer.price });
    const fight = () => this.launchCombat({ ...ctx, _noParley: true, _noFlee: true }, opts);
    const buttons = [];
    if (afford) {
      buttons.push({ text: offer.free ? 'Welcome them — free' : `Parley — ${offer.price}g`, blue: true, track: 'Parley', onClick: () => {
        const res = parley(s, hero, monster);
        this.refreshWorld();
        if (!res.ok) { fight(); return; }
        opts.onFinished?.();
      } });
    }
    buttons.push({ text: 'Fight', onClick: fight });
    showDialog(this, {
      title: `${monster.count} ${name}`,
      lines: offer.free
          // Kin, and next to nothing beside your host: they fall in for nothing
          // (CONFIG.PARLEY_FREE_RATIO). Saying "0 gold" would read as a bug.
          ? [`The ${name} know your colours and ask nothing — they will simply join you.`]
          : afford
            ? [`The ${name} would join you for ${offer.price} gold — or you can take them by force.`]
            : [`The ${name} would join for ${offer.price} gold, but your treasury is short. Fight instead?`],
      buttons,
    });
    return true;
  }

  /**
   * Settle one event from a cleared guard's spoils, for the human only. Returns
   * true when it consumed the event.
   *
   * Shared because a wild stack now leaves the tile two ways — beaten, or let go
   * after it ran — and actions.clearWildStack emits the same events for both. A
   * second copy of this would be a second place for a claimed mine to go missing.
   */
  settleGuardSpoil(hero, ev) {
    if (!hero || hero.owner !== 0) return false;
    if (ev.type === 'interact') {
      this.handleMoveEvent(hero, ev.event, () => {});
      return true;
    }
    if (ev.type === 'chestUnderGuard') {
      // A chest won under a guard's ZoC: offer the same gold-vs-XP choice a
      // normally-reached chest gets (was previously dropped — no prize).
      this.ui?.chestDialog(hero, ev, (tookXp) => {
        this.refreshWorld();
        if (tookXp) this.ui?.maybeShowLevelUps(hero);
      });
      return true;
    }
    return false;
  }

  /**
   * Flee and chase: a band far weaker than the hero breaks and runs on contact,
   * and the player decides what that is worth. Returns true when it handled the
   * encounter, false to fall through to the battle.
   *
   * Reported as "a weak stack may flee, and a user may decide to chase if they
   * need the experience, or to let them go and save time". Both halves are real:
   * the chase pays the full, tide-sized battle and its experience for
   * CONFIG.CHASE_MOVE_COST of the day, and letting them go opens the road for
   * nothing at all — no experience, no spoils, and no prize, because a band posted
   * on one never runs in the first place (diplomacy.fleeCheck).
   */
  maybeFlee(ctx, opts) {
    const s = this.state;
    if (ctx.defender?.kind !== 'monster') return false;
    const hero = s.heroes[ctx.attackerHeroId];
    if (!hero || hero.owner !== 0) return false; // an AI hero simply fights
    const monster = getObject(s, ctx.defender.objectId);
    if (!monster) return false;
    // A band that would take your gold does not run from you. This is the rule,
    // not the call order — maybeParley runs first, but its Fight button comes back
    // through here and must not be answered with a flight.
    const offer = ctx.parleyOffer
      || (featureOn(s, 'diplomacy') ? parleyOffer(s, hero, monster) : null);
    if (offer?.offered && !offer.refused) return false;
    if (!encounterFlees(s, ctx).flees) return false;
    const name = CREATURES[monster.creature]?.name || 'neutrals';
    const cost = chaseCost(hero);
    // TILES, not movement points. The HUD renders the allowance as `mp / 100`
    // (AdvUIScene), so a button reading "240 mp" beside a bar reading "Move 15/15"
    // quotes a price in a currency the player has never been shown.
    const tiles = Math.max(1, Math.round(cost / CONFIG.MOVE_COST_STRAIGHT));
    const lines = [`The ${name} break and run rather than face ${hero.name}.`];
    if (offer?.refused) lines.push('They would not bargain, and they will not stand.');
    // "Either way the road ahead is clear" was the first draft and it over-promised:
    // letting them pass opens the tile outright, but the chase opens it only if you
    // WIN the fight it starts. Say what each fork actually buys.
    lines.push(`Chase them down and fight for the experience — ${tiles} tile`
      + `${tiles === 1 ? '' : 's'} of travel — or let them pass and take the road for nothing.`);
    showDialog(this, {
      title: `${monster.count} ${name}`,
      lines,
      buttons: [
        { text: `Chase — ${tiles} tile${tiles === 1 ? '' : 's'}`, blue: true, track: 'Chase', onClick: () => {
          // Spend the afternoon, then fight the battle that was already priced.
          // Neither fork may re-open here: they ran once.
          if (!chaseThem(s, ctx).ok) { this._doLaunchCombat(ctx, opts); return; }
          this.ui?.refreshHUD?.();
          this._doLaunchCombat({ ...ctx, _noParley: true, _noFlee: true }, opts);
        } },
        { text: 'Let them go', track: 'LetGo', onClick: () => {
          const res = letThemGo(s, ctx);
          this.refreshWorld();
          if (!res.ok) { this._doLaunchCombat({ ...ctx, _noParley: true, _noFlee: true }, opts); return; }
          this.ui?.toast(`The ${name} scatter into the country.`);
          for (const ev of res.events) this.settleGuardSpoil(hero, ev);
          this.ui?.refreshHUD?.();
          opts.onFinished?.();
        } },
      ],
    });
    return true;
  }

  _doLaunchCombat(ctx, opts = {}) {
    const { onFinished } = opts;
    // Never stack a battle over one that is already running or over its recap —
    // that stomps the end screen ("battle won't end": dead enemy + ring, no
    // recap, a second combat spawns). If somehow called, defer to the caller's
    // continuation instead of opening a duplicate battle.
    if (this.scene.isActive('Combat') || this.scene.isActive('Debrief')) {
      console.warn('[adv] launchCombat ignored — a battle or its recap is already active');
      onFinished?.();
      return;
    }
    const s = this.state;
    // Reported: "attacking a Pandora's Box or a Griffin Conservatory takes several
    // seconds before proceeding." Every measurement of the engine says otherwise —
    // 15-180ms to build the encounter, 2-4ms to fight it, under 1ms to apply the
    // result, on a real day-57 game at every position of the hardness dial — so the
    // useful thing is not a guess but a reading from the machine it happens on.
    // The engine stamps what it cost (actions.combatContext); this says so when it
    // is out of line, naming the defender. If a freeze produces no line, the time
    // went somewhere other than sizing the fight, which is worth as much to know.
    if (ctx.builtMs > CONFIG.SLOW_ENCOUNTER_MS) {
      console.warn(`[jma3] sizing this ${ctx.defender?.kind || 'encounter'}`
        + `${ctx.defenderName ? ` (${ctx.defenderName})` : ''} took ${ctx.builtMs}ms`);
    }
    this.clearPreview();
    this.hideHeroHover();
    this.scene.sleep('AdvUI');
    playMusic(this.combatMood(ctx)); // naval theme on water, else combat
    this.scene.launch('Combat', {
      ctx,
      onDone: (result) => {
        // A war-band storming a town is settled by its own writer: there is no
        // attacking hero to hand survivors, experience or loot to, and the town has
        // to fall to NOBODY rather than to a player. Same function the dawn tick
        // calls, same rules — only the result comes from a fight that was played.
        const assault = ctx.bandAssault ? settleBandAssault(s, ctx, result) : null;
        const events = ctx.bandAssault ? [] : applyCombatResult(s, ctx, result);
        this.scene.wake('AdvUI');
        this.scene.resume('Adventure');
        playMusic(this.adventureMood()); // back to the overworld theme after the battle
        this.refreshWorld();
        // After the wake, or the toast is written to a sleeping scene.
        if (assault) this.reportAssault(ctx, assault);
        const attacker = s.heroes[ctx.attackerHeroId];
        const defender = ctx.defenderHeroId ? s.heroes[ctx.defenderHeroId] : null;
        // Loot claimed by winning a guard fight on top of a prize tile.
        for (const ev of events) {
          if (this.settleGuardSpoil(attacker, ev)) {
            // The tile the guard stood on, or the prize it stood over.
          } else if (ev.type === 'bankLooted' && attacker && attacker.owner === 0) {
            // Storming a Creature Bank paid off — toast the plunder.
            const def = bankDef(ev.bankType);
            const r = ev.reward || {};
            const bits = [];
            if (r.gold) bits.push(`${r.gold} gold`);
            for (const [res, amt] of Object.entries(r.resources || {})) bits.push(`${amt} ${res}`);
            for (const cr of (r.creatures || [])) bits.push(`${cr.count} ${CREATURES[cr.creature]?.name || cr.creature}`);
            if (r.artifact) bits.push(ARTIFACTS[r.artifact]?.name || 'an artifact');
            playSfx('coin');
            this.ui?.toast(`Plundered the ${def?.name || 'bank'}: ${bits.join(', ')}.`);
            this.ui?.refreshHUD?.();
          } else if (ev.type === 'pandoraOpened' && attacker && attacker.owner === 0) {
            // Won the guard fight and cracked the box open.
            playSfx('coin');
            this.ui?.toast(`Pandora's Box yields ${pandoraRewardText(ev.reward)}!`);
            this.ui?.refreshHUD?.();
          } else if (ev.type === 'skeletonsRaised' && attacker && attacker.owner === 0) {
            // Necromancy: the enemy fallen rose to swell your ranks.
            this.ui?.toast(`Necromancy: raised ${ev.count} skeleton${ev.count === 1 ? '' : 's'} from the dead.`);
            this.ui?.refreshHUD?.();
          } else if (ev.type === 'artifactsLooted') {
            // The victor may be the attacker OR the defending hero, so gate on the
            // winner named in the event — not on `attacker` — and show the spoils.
            const winner = s.heroes[ev.heroId];
            if (winner && winner.owner === 0) this.ui?.spoilsDialog(winner, ev);
          } else if (ev.type === 'heroFled') {
            // No loot from a hero that escaped — tell the player why.
            const victor = s.heroes[ev.heroId];
            if (victor && victor.owner === 0) this.ui?.toast(`${ev.fromName} fled the field, escaping with their equipment.`);
          } else if (ev.type === 'defeatLesson') {
            // A hero of yours lost and took something from it. Worth a line: the
            // battle is otherwise pure loss, and a player who is not told will
            // reasonably assume it was.
            const fallen = s.heroes[ev.heroId] || (s.players[0]?.heroPool || []).find((h) => h.id === ev.heroId);
            if (fallen) this.ui?.toast(`${fallen.name} learns from the defeat — ${ev.xp} experience.`);
          } else if (ev.type === 'roninFought') {
            // A masterless captain took a hand in this fight. Say so, because from
            // the player's side an unexplained extra stack in the enemy line is a
            // bug until it is named.
            this.ui?.toast(ev.destroyed
              ? "The masterless captain's band was destroyed."
              : 'A masterless captain stood with the defenders.');
          }
        }
        // Level-up dialogs must fully resolve BEFORE the AI pump resumes,
        // or the next AI attack would sleep this UI over an open modal.
        const humans = [attacker, defender].filter((h) => h && h.owner === 0);
        const chain = (i) => {
          if (i >= humans.length || !this.ui) {
            this.checkGameOver();
            onFinished?.(result);
            return;
          }
          this.ui.maybeShowLevelUps(humans[i], () => chain(i + 1));
        };
        chain(0);
      },
    });
    this.scene.pause('Adventure');
  }

  /**
   * The adventure-map music mood: the underground theme while the cavern level
   * is shown, else the human player's faction overworld theme (falling back to
   * the generic adventure loop when they hold no town). A real music_<mood>.mp3
   * wins over the generative loop; an unwired/ungenerated mood degrades to the
   * base loop (see audio.js generativeMoodFor), so this is always safe to call.
   */
  adventureMood() {
    if (this.viewLevel === 1) return 'underground';
    const faction = playerTowns(this.state, 0)[0]?.faction;
    return faction ? `adventure_${faction}` : 'adventure';
  }

  /** The battle music for `ctx`: the naval theme on a water tile, else combat. */
  combatMood(ctx) {
    let terrain = ctx.terrain;
    if (!terrain) {
      const a = ctx.attackerHeroId ? this.state.heroes[ctx.attackerHeroId] : null;
      if (a) terrain = tileAt(this.state, a.x, a.y, a.z ?? 0)?.terrain;
    }
    return terrain === 'water' ? 'naval' : 'combat';
  }

  openTown(townId) {
    // A HUD chip can fire mid-move or mid-AI-turn; opening a screen pauses
    // 'Adventure' and would freeze the AI pump under it (mirrors onEndTurn).
    if (this.moving || this.aiRunning) return;
    // Your own town, or a sworn realm's whose pact granted market rights — "I will need
    // to be able to buy creatures from his town with permission". TownScene knows which
    // it is and shows a vassal's town as a market rather than a seat of government.
    const t = this.state.towns[townId];
    if (!t || (t.owner !== 0 && !canRecruitFrom(this.state, 0, t))) return;
    this.hideHeroHover(); // drop any hover card + restore the arrow cursor
    const faction = this.state.towns[townId]?.faction;
    playMusic(faction ? `town_${faction}` : 'town'); // the town's own theme while inside
    this.scene.sleep('AdvUI');
    this.scene.launch('Town', {
      townId,
      onClose: () => {
        this.scene.wake('AdvUI');
        this.scene.resume('Adventure');
        playMusic(this.adventureMood()); // back to the overworld theme on exit
        this.refreshWorld();
      },
    });
    this.scene.pause('Adventure');
  }

  openHeroScreen(heroId) {
    if (this.moving || this.aiRunning) return;
    this.hideHeroHover();
    this.scene.sleep('AdvUI');
    this.scene.launch('Hero', {
      heroId,
      onClose: () => {
        this.scene.wake('AdvUI');
        this.scene.resume('Adventure');
        this.refreshWorld();
      },
    });
    this.scene.pause('Adventure');
  }

  /** Two same-owner heroes meet on the map to exchange armies. */
  openHeroMeet(heroAId, heroBId) {
    if (this.moving || this.aiRunning) return;
    this.hideHeroHover();
    this.scene.sleep('AdvUI');
    this.scene.launch('HeroMeet', {
      heroAId,
      heroBId,
      onClose: () => {
        this.scene.wake('AdvUI');
        this.scene.resume('Adventure');
        this.refreshWorld();
      },
    });
    this.scene.pause('Adventure');
  }

  // =========================================================================
  // End turn & AI
  // =========================================================================

  onEndTurn() {
    if (this.moving || this.aiRunning) return;
    if (this.state.winner !== null) { this.checkGameOver(); return; }
    if (currentPlayer(this.state).index !== 0) return;
    this.clearPreview();
    endTurn(this.state);
    this.refreshWorld();
    if (this.checkGameOver()) return;
    this.runAITurn();
  }

  runAITurn() {
    const s = this.state;
    // Stop driving AI turns when it's the human's turn, the game is decided, or
    // the human has been eliminated (no point watching allied/enemy AI grind on
    // — finishAITurn → checkGameOver surfaces the defeat).
    const human = s.players.find((p) => p.isHuman);
    if (currentPlayer(s).index === 0 || s.winner !== null || human?.defeated) {
      this.finishAITurn();
      return;
    }
    this.aiRunning = true;
    this.ui?.showAIBanner(true);
    const controller = new AITurnController(s, currentPlayer(s).index);
    let animCursor = 0; // how much of controller.moveLog we've already animated
    // One trail-time budget for this WHOLE AI player's turn (playAiTrail runs
    // once per pump, so the cap has to live out here) — see AI_TRAIL_BUDGET_MS.
    const trailBudget = { left: CONFIG.AI_TRAIL_BUDGET_MS };

    const pump = (fromSlice = false) => {
      // The winner early-out serves the interactive-battle path (the game was
      // just decided on screen; stop driving). It must NOT fire between time
      // slices: before slicing existed the whole turn ran atomically, so a
      // turn whose own auto-battle decided the game still finished its
      // remaining marches — and the headless drivers (sims, tests) still run
      // that way. Truncating on a slice boundary would make the scene-driven
      // game diverge from the same seed replayed headlessly.
      if (!fromSlice && s.winner !== null) { this.afterAI(); return; }
      let r;
      try {
        // BUDGETED: next() returns { type: 'paused' } once it has thought for
        // AI_SLICE_MS, and the delayedCall below resumes it next tick — so the
        // browser paints and reads input between slices instead of freezing
        // for the whole turn (measured at 2.8s of solid thinking on the 88×72
        // preset before this). Pausing never changes what the AI computes;
        // see the controller's contract and tests/ai-slicing.test.js.
        r = controller.next(CONFIG.AI_SLICE_MS);
      } catch (e) {
        console.error('AI error', e);
        this.afterAI();
        return;
      }
      // Replay the moves this next() produced (visible tiles only), THEN act on
      // the outcome — so you watch the enemy march before a battle opens. On a
      // paused slice this drains the moveLog incrementally: the march plays
      // WHILE the AI is still thinking, instead of all of it after.
      this.playAiTrail(controller.moveLog, animCursor, (cursor) => {
        animCursor = cursor;
        if (r.type === 'combat') {
          // The AI attacks YOU — defend interactively.
          this.ui?.showAIBanner(false);
          this.refreshWorld();
          this.launchCombat(r.context, {
            onFinished: () => {
              this.ui?.showAIBanner(true);
              this.time.delayedCall(60, pump);
            },
          });
        } else if (r.type === 'paused') {
          this.time.delayedCall(0, () => pump(true)); // next tick — one frame breathes
        } else {
          this.afterAI();
        }
      }, trailBudget);
    };
    this.time.delayedCall(220, pump);
  }

  /**
   * Animate the AI's hero movement by replaying its move trail — but only the
   * steps whose tiles the human has explored (you never see heroes move through
   * your fog). The engine has already applied the whole turn; this is a cosmetic
   * glide of the tokens from where they were to where they now stand, paced by
   * the animSpeed setting. Steps outside vision (or by a hero that later died)
   * are skipped so an all-fog turn stays instant, exactly as before.
   *
   * `budget` (optional, shared across this AI turn's pumps — see runAITurn) is
   * the mutable { left: ms } trail-time allowance. Without it the pace is the
   * plain scaled AI_STEP_MS, which is what the smoke test drives directly.
   */
  playAiTrail(moveLog, cursor, done, budget = null) {
    const s = this.state;
    // The AI only ever moves on the surface (it never descends in v1), so skip
    // the visual trail while the underground is displayed — those moves aren't
    // on screen. State has already advanced in the controller.
    if (this.viewLevel !== 0) { done(moveLog.length); return; }
    const steps = [];
    for (let i = cursor; i < moveLog.length; i++) {
      const m = moveLog[i];
      if (isExplored(s, 0, m.to.x, m.to.y) || isExplored(s, 0, m.from.x, m.from.y)) steps.push(m);
    }
    const newCursor = moveLog.length;
    if (!steps.length || s.winner !== null) { done(newCursor); return; }

    // A BUDGET ON WATCHING, because "only what you can see" stopped being a
    // cap by late game: the follow-camera keeps a marching hero in view once
    // any of its steps is, so a 200-step march near your borders animated in
    // FULL — measured at the 88×72 preset, 226 explored steps in one turn,
    // 42 seconds at the base pace. When this turn's remaining trail would
    // overrun the remaining budget, the pace compresses (never below the
    // floor, so each step still reads as a step), and once the budget is
    // truly spent the rest lands instantly — the same treatment off-screen
    // steps have always had. Early-game trails fit the budget and play at
    // the base pace, exactly as before.
    const base = scaledDuration(AI_STEP_MS);
    const stepMs = budget
      ? Math.max(CONFIG.AI_TRAIL_MIN_STEP_MS, Math.min(base, budget.left / steps.length))
      : base;
    // REALMS SWORN TO YOU ARE NOT A TURN YOU WATCH. A vassal fights on your side
    // and cannot march on you, so its trail is the one part of the computer's
    // turn that carries no information: nothing to decide, nothing to be
    // surprised by. Off by default and toggleable in Settings ('Watch vassal
    // moves'), because a player who signed the pact to watch an ally sweep the
    // map should still be able to. Vassals of somebody ELSE are enemies with a
    // patron and animate exactly as they always did.
    const skipVassals = !getSetting('showVassalMoves');
    const myVassals = skipVassals
      ? new Set(vassalsOf(s, 0).map((p) => p.vassal))
      : null;
    let idx = 0;
    const playNext = () => {
      // FAST-FORWARD WHAT NOBODY CAN SEE, and this is where the computer turn's
      // wait came from. The filter above admits every step on an EXPLORED tile,
      // and the camera below follows one only if it is ON SCREEN — so a march
      // across a remembered corner of the map was costing 250ms a tile to glide
      // a token through a part of the world the player was not looking at.
      // Measured in a browser: twenty steps on screen took 5.55s and twenty
      // steps entirely off it took 5.60s. The player waited the same for
      // nothing.
      //
      // So a step neither end of which is in view lands instantly and the loop
      // moves on. Nothing is skipped — the sprite still arrives exactly where
      // the engine put it, and a hero walking INTO view still glides in, because
      // the step whose destination is on screen is the one that gets the tween.
      let m = null, spr = null;
      while (idx < steps.length && this.state.winner === null) {
        const cand = steps[idx++];
        const hero = s.heroes[cand.heroId];
        if (!hero) continue; // fell in a later battle — nothing to show
        let sp = this.heroSprites.get(hero.id);
        if (!sp) sp = this.spawnHeroSprite(hero);
        sp.setVisible(true);
        // A spent trail budget fast-forwards the same way an off-screen step
        // does: the sprite still lands exactly where the engine put it.
        const watched = !(myVassals && myVassals.has(hero.owner))
          && !(budget && budget.left <= 0);
        if (watched
          && (this.isTileInView(cand.from.x, cand.from.y) || this.isTileInView(cand.to.x, cand.to.y))) {
          m = cand; spr = sp; break;
        }
        sp.setPosition(cand.to.x * T + T / 2, cand.to.y * T + T / 2);
        sp.setDepth(sp.y + T / 2);
      }
      if (!m || this.state.winner !== null) { done(newCursor); return; }
      // Start at the step's origin, glide to its destination.
      spr.setPosition(m.from.x * T + T / 2, m.from.y * T + T / 2);
      spr.setDepth(spr.y + T / 2);
      // Trail this enemy — it is on screen by construction now, since an
      // off-screen one never reaches here. Once it is being followed it stays
      // centred (and thus in view), so the whole leg reads smoothly.
      this._followSprite = spr;
      if (budget) budget.left -= stepMs; // this glide's cost, off the turn's allowance
      this.tweens.add({
        targets: spr,
        x: m.to.x * T + T / 2,
        y: m.to.y * T + T / 2,
        duration: stepMs,
        onUpdate: () => spr.setDepth(spr.y + T / 2),
        onComplete: playNext,
      });
    };
    playNext();
  }

  afterAI() {
    const s = this.state;
    this.aiRunning = false;
    this.ui?.showAIBanner(false);
    // This AI player's turn is done — hand the turn to the next player. With
    // 3+ players that next player may itself be another AI, so we always route
    // back through runAITurn: it drives the next AI, or (once currentPlayer is
    // the human again / the game is won) falls through to finishAITurn. In the
    // 2-player case this is exactly one endTurn that wraps back to the human.
    if (s.winner === null && currentPlayer(s).index !== 0) {
      endTurn(s);
    }
    this.runAITurn();
  }

  finishAITurn() {
    this._followSprite = null; // the AI's turn is over — release the auto-follow
    this.refreshWorld();
    if (this.checkGameOver()) return;
    // A war-band at the gate is the FIRST thing about this dawn, ahead of the day
    // toast and the autosave: it is a battle, and until it is fought the state of
    // the realm is not yet decided.
    this.playPendingAssaults(() => this.dawnRoutine());
  }

  /**
   * War-bands standing at your walls, one fight at a time.
   *
   * Reported as: "when a band attacks a castle I don't get warning of a fight and
   * understand the castle was attacked and taken only when I check and see a decrease
   * in the towns held and there is no flag on that castle." The assault used to be
   * settled inside endTurn by autoResolve — your garrison fought without you and the
   * only trace was one line in the dawn's toasts. Now the tick sets it aside
   * (core/actions.bandAssaultAtDawn) and it arrives here as what it is.
   *
   * The herald first, because a battle screen that opens by itself is a jump-scare and
   * because the choice belongs to the player: hold the walls, or wave the defence
   * through on auto-resolve exactly as before.
   */
  playPendingAssaults(done) {
    const s = this.state;
    const next = () => {
      const p = s.pendingAssaults?.shift();
      if (!p) { done(); return; }
      const obj = getObject(s, p.objectId);
      const town = s.towns[p.townId];
      // The band or the town may be gone by the time we get here (a save reloaded
      // into a different world, a town lost another way) — skip, never crash.
      if (!obj || !town || town.owner !== 0) { next(); return; }
      const ctx = bandAssaultContext(s, obj, town);
      if (!ctx) { next(); return; }
      const fight = (auto) => {
        if (auto) {
          const res = settleBandAssault(s, ctx, autoBandBattle(s, ctx));
          this.refreshWorld();
          this.reportAssault(ctx, res, true);
          this.checkGameOver();
          next();
          return;
        }
        this._doLaunchCombat(ctx, { onFinished: () => next() });
      };
      const defenders = (ctx.defenderArmy || []).reduce((n, st) => n + (st?.count || 0), 0);
      showDialog(this, {
        title: `${ctx.peopleName} are at the walls of ${town.name}`,
        lines: [
          `${fmtCount(obj.count)} ${CREATURES[obj.creature]?.name || 'warriors'} are storming the gate.`,
          defenders > 0
            ? `${fmtCount(defenders)} defenders stand inside${ctx.fortTier ? ' behind the walls' : ''}.`
            : 'There is nobody inside to hold it.',
          'If the walls fall the town is theirs, and the survivors garrison it.',
        ],
        buttons: [
          { text: 'To the walls!', blue: true, onClick: () => fight(false) },
          { text: 'Let them fight it', onClick: () => fight(true) },
        ],
      });
    };
    next();
  }

  /**
   * One line on how an assault ended — for both paths. A played fight already had
   * its debrief, so `chime` is only asked for on the auto-resolved one, where this
   * toast is the entire report.
   */
  reportAssault(ctx, res, chime = false) {
    if (!res) return;
    if (chime) playSfx(res.taken ? 'defeat' : 'victory');
    this.ui?.toast(res.taken
      ? `${ctx.peopleName} have stormed ${res.townName}. They hold the walls now.`
      : `${res.townName} holds — ${ctx.peopleName} are thrown back${res.gone ? ' and broken' : ''}.`);
    this.ui?.refreshHUD?.();
  }

  /** The rest of the dawn, once any battle at the gate has been settled. */
  dawnRoutine() {
    const s = this.state;
    if (this.checkGameOver()) return;
    const week = weekOf(s.day), day = dayOfWeek(s.day);
    this.ui?.toast(day === 1 && s.weekEvent ? weekEventMessage(s.weekEvent) : `Day ${day}, Week ${week}.`);
    // Surface any living-campaign beats that fired at this dawn (queued by the
    // engine), then clear the queue so they announce exactly once.
    if (s.eventToasts?.length) {
      for (const t of s.eventToasts) this.ui?.toast(t);
      s.eventToasts = [];
    }
    // The turn of a season: a one-line beat when a new month brings a new season.
    if (isSeasonChange(s.day)) this.ui?.toast(`${seasonName(s.day)} settles over the land.`);
    // Envoys at the door. A cornered realm asking to rule in your name is a decision,
    // not a notice, so it opens at dawn rather than scrolling past in a toast.
    this.showPactOffer();
    // …and a beaten rebel asking for one castle back. After the pact offer, so the two
    // never stack: showMercyPlea refuses to open over another modal and will raise
    // itself at the next dawn instead.
    this.showMercyPlea();
    // …and the crown waiting on the age, if one is. Last of the three, for the same
    // reason: each refuses to open over another modal and comes back at the next dawn.
    this.showHeldCrown();
    const heroes = playerHeroes(s, 0);
    if (heroes.length && !s.heroes[this.selectedHeroId]) this.selectHero(heroes[0].id);
    this.ui?.refreshHUD();
    // Autosave at the start of each of your days. The write is asynchronous now
    // (gzip into IndexedDB), so the toast waits for it to actually land rather
    // than announcing a save that might still fail.
    saveGame().then((ok) => { if (ok) this.ui?.toast('Game autosaved.'); });
  }

  /**
   * A cornered realm's envoys, waiting on an answer.
   *
   * The deal in the words that set it: "he gets his town and the applicable mines and
   * tends over his land, but I will need to be able to buy creatures from his town with
   * permission." Accepting puts them on your banner — their armies fight beside yours,
   * their tribute arrives weekly, and their dwellings open to your purse. Refusing is
   * not free: they remember who turned them down, and that is what sends them looking
   * for somebody outside to pay for a war on your flank (patrons.js).
   *
   * One at a time, at dawn, and never over another modal.
   */
  showPactOffer() {
    const s = this.state;
    if (modalOpen() || this.moving || this.aiRunning) return false;
    const offer = pactOffers(s).find((o) => o.to === 0);
    if (!offer) return false;
    const them = s.players[offer.from];
    if (!them || them.defeated) { declineOffer(s, offer.from); return false; }

    const share = Math.round((offer.terms.tributeShare || 0) * 100);
    const lines = [
      `${them.name} would rule in your name rather than be finished.`,
      `They keep their ${offer.towns === 1 ? 'town' : `${offer.towns} towns`}, their mines and their`
        + ' farms, and tend their own land.',
      `• ${share}% of their proceeds, every week`,
      '• their armies answer the call when a people comes ashore',
    ];
    if (offer.terms.trade) lines.push('• their dwellings open to your purse — you may buy their creatures');
    if (offer.terms.husbandry) {
      lines.push('• their stewards work the mills and wheels of their own lands, and you take your share');
    }
    lines.push('In exchange they expect to be defended. Refuse, and they will remember it.');
    showDialog(this, {
      title: `Envoys from ${them.name}`,
      lines,
      buttons: [
        {
          text: 'Accept their oath',
          blue: true,
          onClick: () => {
            const res = acceptOffer(s, offer.from);
            this.ui?.toast(res.ok
              ? `${them.name} swears to you. Their towns are open to your purse.`
              : `The oath could not be sworn — ${res.reason}.`);
            this.ui?.refreshHUD();
          },
        },
        {
          text: 'Refuse',
          onClick: () => {
            declineOffer(s, offer.from, refuseTerms);
            this.ui?.toast(`${them.name}'s envoys are sent away empty-handed.`);
          },
        },
      ],
    });
    return true;
  }

  /**
   * A broken rebel at the gate, asking for one castle back.
   *
   * The far side of an uprising, in the words that set it: "once they wage a war I can
   * take also their castles and eventually they beg for mercy and one castle — at that
   * time I can choose one that I wish to give to them and keep them in the game and make
   * the vassals again." So the WHICH is a decision, not a default: the towns are listed
   * least-developed first (you keep your best) and every one of them is a button.
   *
   * One at a time, at dawn, and never over another modal — same rule as the pact offer
   * above, and for the same reason: handing over a castle is not a thing to discover
   * after the fact.
   */
  showMercyPlea() {
    const s = this.state;
    if (modalOpen() || this.moving || this.aiRunning) return false;
    const plea = mercyPleas(s).find((p) => p.to === 0);
    if (!plea) return false;
    const them = s.players[plea.from];
    if (!them) { clearMercyPlea(s, plea.from); return false; }
    const choices = mercyTownChoices(s, 0);
    // Nothing to give — a lord on one town cannot seat anybody. Leave the plea on the
    // table rather than dropping it: take a second town and they are still asking.
    if (!choices.length) return false;

    const MAX = 8;
    const shown = choices.slice(0, MAX);
    const buttons = shown.map((town, i) => ({
      text: `${town.name}${town.buildings?.length ? ` (${town.buildings.length})` : ''}`,
      blue: i === 0,
      onClick: () => {
        const res = grantMercy(s, 0, plea.from, town.id);
        this.ui?.toast(res.ok
          ? `${them.name} is spared, and swears again — ${town.name} is theirs.`
          : `They cannot be seated — ${res.reason}.`);
        this.ui?.refreshHUD();
      },
    }));
    buttons.push({
      text: 'Refuse',
      cancel: true,
      onClick: () => {
        refuseMercy(s, plea.from);
        this.ui?.toast(`${them.name}'s envoys are sent away. There will be no second oath.`);
      },
    });
    showDialog(this, {
      title: `${them.name} begs for terms`,
      width: 620,
      lines: [
        `${them.name} rose against you with foreign money, and has nothing left to rise with.`,
        'They ask for one castle, and offer their oath on it — the same terms as before: '
        + 'their mines and their farms stay theirs, a share of the proceeds comes to you '
        + 'every week, and their armies answer when a people comes ashore.',
        'A realm you spared is a grateful vassal. It is still a vassal, and loyalty still moves.',
        '',
        'Which castle do you give them?'
        + (choices.length > MAX ? ` (your ${MAX} least-developed — you keep the rest)` : ''),
      ],
      buttons,
    });
    return true;
  }

  /**
   * Accept the conquered realms' pleas: seat each in one of your towns, take
   * their oaths, and PUT THE MAP BACK IN PLAY.
   *
   * The engine half (actions.acceptPleas) clears `winner`, which is what unfreezes
   * hero movement and End Turn. This side has to undo the view's own end-of-game
   * latches to match — the dialog gate and the music — or the world would be live
   * while the UI still believed the game was over.
   */
  acceptPleas(pleas, battleTarget = null) {
    const s = this.state;
    // The plea dialog's buttons are BATTLE counts now (see AdvUIScene.pleaDialog
    // and actions.noteInvaderBattle) — the Pax installs `invaderBattles`, so this
    // is the target it reads.
    const res = acceptPleas(s, 0, pleas, { battleTarget });
    if (!res.ok) {
      this.ui?.toast(`The envoys are turned away — ${res.reason}.`);
      this.checkGameOver(); // still settled: put the outcome dialog back up
      return false;
    }
    // The game is live again: drop the latch so a LATER outcome can raise a fresh
    // dialog, and stop holding the victory bed over a running map.
    this.gameOverShown = false;
    if (this.ui) this.ui.gameOverRoot = null;
    playMusic(this.adventureMood());
    this.refreshWorld();
    this.ui?.refreshHUD();
    for (const t of (s.eventToasts || [])) this.ui?.toast(t);
    s.eventToasts = [];
    saveGame();
    return true;
  }

  /**
   * The crown that is waiting on the age (core/ages.js).
   *
   * One dialog per held win, never over another modal and never mid-move: a
   * conquest is usually held the instant a battle ends, with the debrief still on
   * screen, so a refused opening is simply retried at the next dawn — the same
   * courtesy showMercyPlea extends. The engine has already logged and toasted it,
   * so nothing is lost if this never gets a clear moment.
   */
  showHeldCrown() {
    const held = this.state.pendingWin;
    if (!held) { this.heldCrownShown = null; return false; }
    // Keyed on the day the note was OPENED, not on its reason: a held win rewrites
    // its own reason as conditions come and go (actions.holdWin), and a key that
    // moved with it would re-raise this dialog every turn.
    const key = `held@${held.since}`;
    if (this.heldCrownShown === key) return false;
    if (modalOpen() || this.moving || this.aiRunning) return false;
    this.heldCrownShown = key;
    this.ui?.heldCrownDialog();
    return true;
  }

  /** Take a held crown now — the age floor's own way out (actions.claimVictoryNow). */
  claimCrown() {
    const res = claimVictoryNow(this.state);
    if (!res.ok) { this.ui?.toast(`The crown cannot be claimed — ${res.reason}.`); return false; }
    this.checkGameOver();
    saveGame();
    return true;
  }

  checkGameOver() {
    const s = this.state;
    checkVictory(s);
    const human = s.players.find((p) => p.isHuman);
    const humanLost = !!human?.defeated;
    // Game over for the human when their team has won, someone else has won, or
    // the human themselves is eliminated (even if allied AI fight on).
    if (s.winner === null && !humanLost) {
      // …unless a win is WON and merely waiting on the age floor, which is its own
      // announcement and its own decision (see showHeldCrown).
      this.showHeldCrown();
      return false;
    }
    // Re-raise whenever the dialog is not actually on screen. `gameOverShown`
    // alone latched: any dismissal that ran no handler (an Esc, a scene rebuild)
    // left the player in a world whose every action is gated on `winner !== null`
    // — heroes frozen, End Turn a no-op, no way back to the menu and no way on.
    // The outcome dialog is the ONLY exit from that state, so its liveness, not a
    // boolean, is what decides whether to draw it.
    if (this.gameOverShown && this.ui?.gameOverRoot?.scene) return true;
    this.gameOverShown = true;
    const humanWon = !humanLost && s.winner === (human?.team ?? 0);
    stopMusic();
    playSfx(humanWon ? 'victory' : 'defeat');
    // Campaign: a win that isn't the final chapter offers "next chapter" instead
    // of only returning to the menu; the final win completes the campaign.
    let campaign = null;
    if (isCampaign(s)) {
      const camp = campaignById(s.campaign.id);
      const hasNext = !!camp && s.campaign.scenarioIndex + 1 < camp.scenarios.length;
      campaign = { name: camp?.name, chapter: s.campaign.scenarioIndex + 1, total: camp?.scenarios.length, hasNext };
      // Persist campaign progress: a non-final WIN stays resumable (Resume routes
      // to the next chapter's intro, reading this won state); a final win or any
      // loss ends the campaign, so its save is dropped.
      if (humanWon && hasNext) saveGame();
      else clearCampaignSave();
    }
    // An endless run has no last realm: a win offers the next one, carrying the
    // top three heroes and the masonry. Only on a WIN — a lost realm ends the run.
    const endless = (humanWon && isEndless(s)) ? { realm: endlessRealm(s) } : null;
    if (endless) saveGame(); // the won realm stays resumable until you march on
    this.ui?.gameOverDialog(humanWon, s.winReason, campaign, endless);
    return true;
  }
}
