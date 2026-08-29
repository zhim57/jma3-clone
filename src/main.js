/**
 * main.js — Phaser bootstrap.
 *
 * A pure-HTML loading overlay (index.html + game/loadingOverlay.js) covers the
 * whole boot — it renders before this bundle even runs and hides once the game
 * reports ready.
 *
 * Scene graph (13 scenes; the parent repo registers 17):
 *   Boot     → generates every texture procedurally, then hands off to Menu
 *   Menu     → new game / continue
 *   Adventure→ the strategic map + HUD (the heart of the game)
 *   Town     → town management overlay scene
 *   Combat   → tactical hex battles
 *   Hero     → hero sheet overlay (stats, skills, artifacts)
 *   HeroMeet → two heroes meet to exchange armies
 *   Skirmish → the Battle Gym: hand-authored castle-vs-inferno battle fixtures,
 *              the fastest way to watch a CombatAI change in isolation
 *
 * DROPPED HERE relative to the parent repo, with the features they front:
 *   Campaign → scripted story chains (data/campaigns.js is an empty registry now)
 *   Study    → the Pomodoro edutainment break
 *   Gantt    → the work-crew/constraints schedule view
 *   Arena    → the creature-balance sandbox, with core/arena.js and the
 *              pareto/rigidity/sensitivity/dimensions instruments behind it
 * Menu's "Play" used to open Campaign; it opens Custom Game directly instead.
 *
 * Also dropped: src/net/ (the optional magic-link account service) — it is a
 * server, a database and a deploy runbook in service of a paywall this clone has
 * no use for.
 */

import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { MenuScene } from './scenes/MenuScene.js';
import { AdventureScene } from './scenes/AdventureScene.js';
import { AdvUIScene } from './scenes/AdvUIScene.js';
import { TownScene } from './scenes/TownScene.js';
import { CombatScene } from './scenes/CombatScene.js';
import { HeroScene } from './scenes/HeroScene.js';
import { HeroMeetScene } from './scenes/HeroMeetScene.js';
import { SkirmishSetupScene } from './scenes/SkirmishSetupScene.js';
import { DebriefScene } from './scenes/DebriefScene.js';
import { SettingsScene } from './scenes/SettingsScene.js';
import { CustomScenarioScene } from './scenes/CustomScenarioScene.js';
import { SaveLoadScene } from './scenes/SaveLoadScene.js';
import { initBootOverlay } from './game/loadingOverlay.js';
import { unlockAudio } from './game/audio.js';
import { installExitSave } from './game/session.js';
import { installUiTelemetry } from './game/uiTelemetry.js';
import { installChronicleConsole } from './game/chronicleExport.js';

const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0a0a12',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: '100%',
    height: '100%',
  },
  render: {
    antialias: true,
    roundPixels: false,
  },
  // No loader tuning here: this clone fetches no art at all. Every texture is
  // generated in BootScene from vector drawing code, so the parent repo's wide
  // download queue (for its ~600-sprite CDN pack) has nothing to do.
  scene: [BootScene, MenuScene, AdventureScene, AdvUIScene, TownScene, CombatScene,
    HeroScene, HeroMeetScene, SkirmishSetupScene, DebriefScene, SettingsScene,
    CustomScenarioScene, SaveLoadScene],
};

window.game = new Phaser.Game(config);
initBootOverlay(window.game);

// Flush the live game to its save slot when the player leaves. The day-boundary
// autosave is the checkpoint; this stops a mid-day exit from costing the day.
installExitSave();

// Console doors on the chronicle: jma3Log() for the text, jma3LogJson() for the raw
// entries, jma3LogSave() to download it. The chronicle is the AI's paper trail —
// scripts/sim/goal-audit.mjs reads the same entries to answer "who attacked whom".
installChronicleConsole();

// Count what gets clicked, so the UI can be simplified on evidence rather than
// taste. Local only — it writes to this browser's localStorage and nothing sends
// it anywhere; `jma3Usage()` prints the report. Turn it off in Settings > Advanced.
installUiTelemetry(window.game);

// Browser autoplay policy: audio can only start after a user gesture. Unlock on
// the first interaction anywhere; scenes then drive their own music and SFX. All
// sound is synthesized (game/audio.js) — no audio files are shipped.
const unlockOnce = () => {
  unlockAudio();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);
