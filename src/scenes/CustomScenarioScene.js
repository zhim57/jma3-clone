/**
 * CustomScenarioScene — build a one-off game from your own preferences.
 *
 * Cyclers for your faction, the opponent (or Random), the map size, and a
 * re-rollable seed (so a map you like can be replayed). Generates via the same
 * newGame path as the menu. Kept forward-compatible: player-count and team
 * rows will slot in here once N-player support lands.
 */

import Phaser from 'phaser';
import { FACTIONS } from '../data/factions.js';
import { CONFIG } from '../config.js';
import { SCENARIOS, DEFAULT_SCENARIO } from '../data/scenarios.js';
import { startNewGame, hasSave, savedGameSummary, loadGame } from '../game/session.js';
import { weekOf, dayOfWeek, holdTownsTarget } from '../core/GameState.js';
import { expectedTownCount } from '../map/MapGenerator.js';
import { gameFeatureFlags, getSetting } from '../game/settings.js';
import { Rng } from '../core/rng.js';
import { showOverlay, hideOverlay } from '../game/loadingOverlay.js';
import { panel, label, button, COLORS, destroyAllChildren } from '../ui/uikit.js';
import { rgba, shade } from '../gfx/canvasKit.js';

// Team layouts (player 0 is you, on team 0). AI fill the rest; the two-zone
// map splits every match into two sides.
const MATCHES = [
  { name: '1 vs 1', teams: [0, 1] },
  { name: '1 vs 2', teams: [0, 1, 1] },
  { name: '2 vs 2', teams: [0, 0, 1, 1] },
  { name: '1 vs 3', teams: [0, 1, 1, 1] },
];

// Victory conditions. Standard elimination always applies; "Race for the Grail"
// ALSO lets any player win outright by solving the obelisk puzzle, digging up
// the Grail and enshrining it at one of their towns.
// Exported so a browser smoke can find the town-goal row by its flag rather than
// by counting positions in a list that grows.
export const VICTORY_MODES = [
  { name: 'Conquest', victory: {} },
  { name: 'Race for the Grail', victory: { grail: true } },
  { name: 'Capture a Town', victory: { kind: 'captureTown' } },
  { name: 'Survive 100 Days', victory: { kind: 'surviveN', surviveDays: 100 } },
  { name: 'Amass 50,000 Gold', victory: { kind: 'accumulateGold', goldTarget: 50000 } },
  { name: 'Acquire an Artifact', victory: { kind: 'acquireArtifact' } },
  { name: 'Defeat the Champion', victory: { kind: 'defeatHero' } },
  { name: 'Control All Mines', victory: { kind: 'flagMines' } },
  // Hold the coast. Also the ending the Pax installs on its own when every rival
  // has sworn to you (actions.enterPax) — picking it here just says so up front,
  // and the count is the player's to choose. Turns the invasions feature on for
  // this game regardless of the Settings toggle, or the goal could never be met.
  ...CONFIG.PAX_INVASION_CHOICES.map((n) => ({
    name: `Repel ${n} Invasions`,
    victory: { kind: 'repelInvasions', invasionTarget: n },
    features: { invasions: true },
  })),
  // The same coast, counted in BATTLES instead of waves — and the ending the Pax
  // installs on its own. A wave that arrives as three bands and a wave that takes
  // ten fights score the same under Repel N, so that row cannot express a long
  // watch; this one can. See actions.noteInvaderBattle.
  ...CONFIG.PAX_BATTLE_CHOICES.map((n) => ({
    name: `The Long Watch — ${n} Battles`,
    victory: { kind: 'invaderBattles', battleTarget: n },
    features: { invasions: true },
  })),
  // Rule the realm: hold every town on the map, and as many again from the sea.
  // The target is derived from the map that gets generated (GameState.
  // holdTownsTarget), so the row's LABEL is computed per selection rather than
  // written here — 42 on World's Edge, 8 on a border skirmish. Needs the waves for
  // the same reason Repel N does: the towns past the map's own arrive as beachhead
  // camps and nothing else on the map ever adds one.
  {
    name: 'Rule the Realm',
    victory: { kind: 'holdTowns' },
    features: { invasions: true },
    townGoal: true,
  },
];

// The AGE FLOOR (core/ages.js): how grown the realm must be before a win may
// settle. Not a victory condition and never in place of one — a guardrail on the
// clock, asked for after a game ended on the first war-band of it. Ordered as the
// config declares them: no floor, then the two the report named ("medium developed
// and a fully developed").
const AGE_MODES = Object.values(CONFIG.AGE_FLOORS);

export class CustomScenarioScene extends Phaser.Scene {
  constructor() {
    super('CustomScenario');
  }

  create() {
    this.factionIds = Object.keys(FACTIONS);
    if (!this.cfg) {
      this.cfg = {
        faction: 0,             // index into factionIds
        match: 0,               // index into MATCHES (team layout)
        size: DEFAULT_SCENARIO, // index into SCENARIOS
        victory: 0,             // index into VICTORY_MODES
        age: 0,                 // index into AGE_MODES (the age floor)
        seed: (Math.random() * 1e9) | 0,
      };
    }
    this.render();
  }

  render() {
    // destroyAllChildren, NOT children.removeAll(true): the latter's boolean is
    // skipCallback, so it DETACHES children without destroying them — leaving
    // invisible-but-interactive ghost cyclers that keep taking clicks, and
    // leaking one render's objects on every re-render.
    destroyAllChildren(this);
    const W = this.scale.width, H = this.scale.height;

    this.add.rectangle(W / 2, H / 2, W, H, 0x0c0a16).setInteractive(); // opaque backdrop
    const pw = 560, ph = 564;
    const px = (W - pw) / 2, py = (H - ph) / 2;
    panel(this, px, py, pw, ph);
    label(this, W / 2, py + 26, 'Custom Game', { size: '24px', bold: true, color: COLORS.gold, ox: 0.5 });

    const rowX = px + 40, rowW = pw - 80;
    let y = py + 92;
    const gap = 62;

    const fac = FACTIONS[this.factionIds[this.cfg.faction]];
    this.cycler(rowX, y, rowW, 'Your Banner', fac.name, rgba(shade(fac.color, 0.55)),
      () => this.step('faction', -1), () => this.step('faction', 1)); y += gap;

    const m = MATCHES[this.cfg.match];
    this.cycler(rowX, y, rowW, 'Match', m.name, COLORS.parchment,
      () => this.step('match', -1), () => this.step('match', 1)); y += gap;

    const sc = SCENARIOS[this.cfg.size];
    this.cycler(rowX, y, rowW, 'Map', `${sc.name}  (${sc.mapW}×${sc.mapH})`, COLORS.parchment,
      () => this.step('size', -1), () => this.step('size', 1)); y += gap;

    const vm = VICTORY_MODES[this.cfg.victory];
    const special = Object.keys(vm.victory).length > 0;
    // "Rule the Realm" names its own number, and the number is a property of the map
    // and the match: every town this size seats, plus the share that comes ashore.
    const vmName = vm.townGoal
      ? `Rule ${holdTownsTarget(expectedTownCount(sc.mapW, sc.mapH, m.teams.length))} Towns`
      : vm.name;
    this.cycler(rowX, y, rowW, 'Victory', vmName, special ? COLORS.gold : COLORS.parchment,
      () => this.step('victory', -1), () => this.step('victory', 1)); y += gap;

    const age = AGE_MODES[this.cfg.age];
    this.cycler(rowX, y, rowW, 'Age', age.name, age.id === 'swift' ? COLORS.parchment : COLORS.gold,
      () => this.step('age', -1), () => this.step('age', 1));
    label(this, rowX, y + 22, age.blurb, { size: '10.5px', color: COLORS.dim, wrap: rowW });
    y += gap;

    // Seed row: value + a Randomize button (no text entry in Phaser).
    label(this, rowX, y, 'Seed', { size: '15px', color: COLORS.parchment });
    label(this, rowX + rowW - 120, y, `${this.cfg.seed}`, { size: '15px', color: COLORS.gold, ox: 1, oy: 0 });
    button(this, rowX + rowW - 50, y + 8, 96, 30, 'Reroll', () => { this.cfg.seed = (Math.random() * 1e9) | 0; this.render(); }, { fontSize: '12px' });
    y += gap;

    // A game in progress is offered HERE, where it was started. It lives in the
    // shared skirmish slot, which until now was only resumable from Play → Quick
    // Conquest — somewhere a player who came in this door has no reason to look.
    const saved = hasSave() ? savedGameSummary() : null;
    if (saved) {
      const what = saved.realm > 1 ? `run — realm ${saved.realm}`
        : saved.kind === 'custom' ? 'custom game' : 'saved game';
      const where = saved.mapW && saved.mapH ? `  ·  ${saved.mapW}×${saved.mapH}` : '';
      button(this, W / 2, y + 4, rowW, 34,
        `▶  Continue your ${what} — Week ${weekOf(saved.day)}, Day ${dayOfWeek(saved.day)}${where}`,
        () => this.continueSaved(), { blue: true, fontSize: '13px' });
      label(this, W / 2, y + 30, 'Generating a new realm replaces it.', { size: '10.5px', color: COLORS.dim, ox: 0.5 });
    }

    button(this, W / 2 - 96, py + ph - 40, 176, 38, '⚔  Generate & Play', () => this.begin(), { fontSize: '15px' });
    button(this, W / 2 + 96, py + ph - 40, 176, 38, 'Back', () => this.scene.start('Menu'));
    this.input.keyboard?.once('keydown-ESC', () => this.scene.start('Menu'));
  }

  /** A row: name on the left, then ◀ value ▶ — the value centred between the arrows. */
  cycler(x, y, w, name, valueText, valueColor, onPrev, onNext) {
    label(this, x, y, name, { size: '15px', color: COLORS.parchment });
    const leftBtn = x + 150, rightBtn = x + w - 16;
    button(this, leftBtn, y + 8, 32, 30, '◀', onPrev, { fontSize: '15px' });
    button(this, rightBtn, y + 8, 32, 30, '▶', onNext, { fontSize: '15px' });
    label(this, (leftBtn + rightBtn) / 2, y, valueText, { size: '16px', bold: true, color: valueColor, ox: 0.5, oy: 0 });
  }

  step(key, d) {
    if (key === 'faction') {
      this.cfg.faction = (this.cfg.faction + this.factionIds.length + d) % this.factionIds.length;
    } else if (key === 'match') {
      this.cfg.match = (this.cfg.match + MATCHES.length + d) % MATCHES.length;
    } else if (key === 'size') {
      this.cfg.size = (this.cfg.size + SCENARIOS.length + d) % SCENARIOS.length;
    } else if (key === 'victory') {
      this.cfg.victory = (this.cfg.victory + VICTORY_MODES.length + d) % VICTORY_MODES.length;
    } else if (key === 'age') {
      this.cfg.age = (this.cfg.age + AGE_MODES.length + d) % AGE_MODES.length;
    }
    this.render();
  }

  begin() {
    const playerFaction = this.factionIds[this.cfg.faction];
    const match = MATCHES[this.cfg.match];
    // You lead player 0; the AI take varied factions — drawn from the DISPLAYED
    // SEED, never Math.random. The roster is a map-generation input (each
    // faction's native terrain shapes its zone), so this screen's whole promise
    // — "a re-rollable seed, so a map you like can be replayed" — was false
    // while the AI banners rolled independently: the same seed produced
    // materially different worlds. Run-to-run variety is the Reroll button's
    // job, not this line's. The roster gets its OWN derived stream (a salt
    // distinct from newGame's gameplay ^0x9e3779b9 and wild ^0x5bf03635 salts,
    // so these picks are not correlated with either stream's opening rolls),
    // and it never touches the map-gen or gameplay streams — existing seeds'
    // draw order inside newGame is untouched.
    const facRng = new Rng((this.cfg.seed ^ 0x51ed270b) >>> 0);
    const players = match.teams.map((team, i) => ({
      faction: i === 0 ? playerFaction : facRng.pick(this.factionIds),
      isHuman: i === 0,
      team,
    }));
    const sc = SCENARIOS[this.cfg.size];
    const mode = VICTORY_MODES[this.cfg.victory];
    // The floor rides on the victory descriptor (GameState.normalizeVictory keeps it
    // there), because it is a property of how this game ENDS and has to round-trip a
    // save with the rest of it. 'swift' is the absence of one, and is not written.
    const floor = AGE_MODES[this.cfg.age];
    const victory = floor.id === 'swift' ? mode.victory : { ...mode.victory, ageFloor: floor.id };
    // endless: winning this realm offers the next one, carrying your top three
    // heroes and the buildings your masons raised (see core/endless.js).
    // A victory mode may REQUIRE a feature its goal is built on (Repel N
    // Invasions needs the waves), so it overrides the Settings snapshot for
    // this game only — otherwise the goal it just set could never be met.
    startNewGame({ players, mapW: sc.mapW, mapH: sc.mapH, seed: this.cfg.seed, victory, features: { ...gameFeatureFlags(), ...(mode.features || {}) }, wildGrowth: getSetting('wildGrowth'), pveScaling: getSetting('pveScaling'), kind: 'custom', endless: true });
    showOverlay('Forging your custom realm…');
    requestAnimationFrame(() => this.scene.start('Adventure'));
  }

  /** Pick a half-played game back up (the same slot Play → Quick Conquest uses).
   *  The overlay goes up BEFORE the await: reading a save now means fetching it
   *  from IndexedDB and gunzipping it, which is fast but no longer instant, and
   *  a frozen menu with no explanation is the worst way to spend that time. */
  async continueSaved() {
    showOverlay('Restoring your realm…');
    if (!await loadGame()) { hideOverlay(); return; }
    requestAnimationFrame(() => this.scene.start('Adventure'));
  }
}
