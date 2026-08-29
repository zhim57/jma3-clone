/**
 * SkirmishSetupScene — the Battle Gym entry: constrained preparation.
 *
 * Pick a scenario, choose a hero, and compose a company within a point budget
 * against a fully visible enemy army. "Fight" builds a self-contained skirmish
 * ctx and hands off to CombatScene; when the battle ends, CombatScene's onDone
 * computes the debrief and opens DebriefScene. No adventure map, no save.
 */

import Phaser from 'phaser';
import { FACTIONS } from '../data/factions.js';
import { CREATURES, fieldableCreatureIds } from '../data/creatures.js';
import { HERO_ROSTER, HERO_CLASSES, heroesOfFaction } from '../data/heroes.js';
import { SKIRMISH_SCENARIOS, armyPoints } from '../data/skirmishScenarios.js';
import { createHero } from '../core/GameState.js';
import { Rng } from '../core/rng.js';
import { battleDigest } from '../core/combat/battleDigest.js';
import { panel, button, label, Tooltip, COLORS, destroyAllChildren } from '../ui/uikit.js';

export class SkirmishSetupScene extends Phaser.Scene {
  constructor() { super('SkirmishSetup'); }

  init(data) {
    this.scenarioIndex = data?.scenarioIndex ?? 0;
  }

  create() {
    const scn = SKIRMISH_SCENARIOS[this.scenarioIndex] || SKIRMISH_SCENARIOS[0];
    this.scn = scn;
    this.faction = scn.playerFaction;
    this.heroId = heroesOfFaction(this.faction)[0];
    this.counts = {};                 // creatureId -> chosen count
    this.countLabels = {};
    this.buildUI();
  }

  factionCreatures() {
    // A battle-remnant creature is nobody's roster entry, here included.
    return fieldableCreatureIds().map((id) => [id, CREATURES[id]])
      .filter(([, c]) => c.faction === this.faction)
      .sort((a, b) => a[1].tier - b[1].tier || a[1].aiValue - b[1].aiValue)
      .map(([id]) => id);
  }

  composedStacks() {
    return Object.entries(this.counts)
      .filter(([, n]) => n > 0)
      .map(([creature, count]) => ({ creature, count }));
  }

  spent() { return armyPoints(this.composedStacks()); }

  /** Multi-line stat readout for a creature, shown on hover. */
  creatureTip(id) {
    const c = CREATURES[id];
    const lines = [
      `${c.name}  ·  ${c.aiValue} pts`,
      `Atk ${c.attack}  Def ${c.defense}  Dmg ${c.damage[0]}–${c.damage[1]}`,
      `HP ${c.health}  Spd ${c.speed}  (${c.reach}${c.shots ? `, ${c.shots} shots` : ''})`,
    ];
    if (c.desc) lines.push(c.desc);
    return lines.join('\n');
  }

  /** Short "name — class / bio" blurb for a hero, shown on hover. */
  heroTip(hid) {
    const h = HERO_ROSTER[hid];
    const cls = HERO_CLASSES[h.class]?.name || h.class;
    return `${h.name} — ${cls}\n${h.bio}`;
  }

  adjust(id, delta) {
    const cur = this.counts[id] || 0;
    if (delta > 0) {
      const cost = CREATURES[id].aiValue;
      const affordable = Math.max(0, Math.floor((this.scn.pointBudget - this.spent()) / cost));
      this.counts[id] = cur + Math.min(delta, affordable);
    } else {
      this.counts[id] = Math.max(0, cur + delta);
    }
    this.refresh();
  }

  refresh() {
    const spent = this.spent();
    const budget = this.scn.pointBudget;
    const remaining = budget - spent;
    const over = remaining < 0;
    this.spentLabel.setText(`Points  ${spent} / ${budget}`);
    this.spentLabel.setColor(over ? COLORS.danger : (remaining <= budget * 0.02 ? COLORS.gold : COLORS.parchment));
    this.remainLabel.setText(over ? `Over budget by ${-remaining}` : `${remaining} to spend`);
    this.remainLabel.setColor(over ? COLORS.danger : (remaining === 0 ? COLORS.gold : COLORS.dim));
    for (const [id, lbl] of Object.entries(this.countLabels)) lbl.setText(`${this.counts[id] || 0}`);
    const n = this.composedStacks().reduce((a, s) => a + s.count, 0);
    this.fightBtn.setEnabled(n > 0);
  }

  buildUI() {
    destroyAllChildren(this);
    this.tooltip = new Tooltip(this);
    const W = this.scale.width, H = this.scale.height;
    this.add.rectangle(0, 0, W, H, 0x0d0b16).setOrigin(0);

    // Header.
    panel(this, 12, 10, W - 24, 74);
    label(this, W / 2, 20, `Battle Gym — ${this.scn.name}`, { size: '20px', bold: true, color: COLORS.gold, ox: 0.5 });
    label(this, W / 2, 48, this.scn.brief, { size: '13px', color: COLORS.dim, ox: 0.5, align: 'center', wrap: W - 80 });

    const colW = (W - 40) / 2;
    const top = 96;
    const bodyH = H - top - 66;

    // ---- Left: your company ----
    panel(this, 12, top, colW - 4, bodyH);
    label(this, 28, top + 12, 'Your Company', { size: '16px', bold: true, color: COLORS.gold });
    this.spentLabel = label(this, colW - 12, top + 8, '', { size: '15px', bold: true, ox: 1 });
    this.remainLabel = label(this, colW - 12, top + 28, '', { size: '11px', color: COLORS.dim, ox: 1 });

    // Hero picker.
    label(this, 28, top + 40, 'Commander:', { size: '13px', color: COLORS.dim });
    const heroIds = heroesOfFaction(this.faction);
    this.heroBtns = {};
    heroIds.forEach((hid, i) => {
      const bx = 40 + (i % 3) * ((colW - 60) / 3) + (colW - 60) / 6;
      const by = top + 66 + Math.floor(i / 3) * 34;
      const b = button(this, bx, by, (colW - 70) / 3, 28, HERO_ROSTER[hid].name,
        () => { this.heroId = hid; this.markHero(); }, { fontSize: '12px', blue: hid === this.heroId });
      b.on('pointerover', (p) => this.tooltip.show(p.x, p.y, this.heroTip(hid)));
      b.on('pointerout', () => this.tooltip.hide());
      this.heroBtns[hid] = b;
    });
    const heroRows = Math.ceil(heroIds.length / 3);
    const listTop = top + 66 + heroRows * 34 + 8;

    // Creature buy list (two sub-columns).
    const creatures = this.factionCreatures();
    const cellW = (colW - 28) / 2;
    const cellH = Math.min(40, (top + bodyH - listTop - 8) / Math.ceil(creatures.length / 2));
    creatures.forEach((id, i) => {
      const c = CREATURES[id];
      const cx = 22 + (i % 2) * cellW;
      const cy = listTop + Math.floor(i / 2) * cellH;
      label(this, cx + 4, cy + 2, c.name, { size: '12px', bold: true });
      label(this, cx + 4, cy + 18, `${c.aiValue} pts`, { size: '10px', color: COLORS.dim });
      // Invisible hit area over the name/pts region shows a stat tooltip on hover.
      this.add.rectangle(cx, cy, cellW - 100, cellH, 0x000000, 0).setOrigin(0)
        .setInteractive()
        .on('pointerover', (p) => this.tooltip.show(p.x, p.y, this.creatureTip(id)))
        .on('pointerout', () => this.tooltip.hide());
      const bx = cx + cellW - 96;
      button(this, bx, cy + 12, 22, 22, '−', () => this.adjust(id, -1), { fontSize: '14px' });
      this.countLabels[id] = label(this, bx + 30, cy + 4, '0', { size: '14px', bold: true, ox: 0.5 });
      button(this, bx + 52, cy + 12, 22, 22, '+', () => this.adjust(id, 1), { fontSize: '14px' });
      button(this, bx + 80, cy + 12, 26, 22, '+5', () => this.adjust(id, 5), { fontSize: '11px', blue: true });
    });

    // ---- Right: the enemy ----
    const rx = 24 + colW;
    panel(this, rx, top, colW - 4, bodyH);
    label(this, rx + 16, top + 12, 'The Enemy', { size: '16px', bold: true, color: COLORS.danger });
    const eh = HERO_ROSTER[this.scn.enemyHero];
    label(this, rx + 16, top + 40, `${eh ? eh.name : 'Wild horde'} · ${FACTIONS[this.scn.enemyFaction].name}`,
      { size: '13px', color: COLORS.parchment });
    this.scn.enemyArmy.forEach((s, i) => {
      const c = CREATURES[s.creature];
      const ey = top + 72 + i * 26;
      label(this, rx + 24, ey, `${c.name}`, { size: '13px' });
      label(this, rx + colW - 20, ey, `× ${s.count}`, { size: '13px', bold: true, color: COLORS.gold, ox: 1 });
      this.add.rectangle(rx + 16, ey - 4, colW - 32, 24, 0x000000, 0).setOrigin(0)
        .setInteractive()
        .on('pointerover', (p) => this.tooltip.show(p.x, p.y, this.creatureTip(s.creature)))
        .on('pointerout', () => this.tooltip.hide());
    });
    const epts = armyPoints(this.scn.enemyArmy);
    label(this, rx + 16, top + bodyH - 30, `Enemy strength: ${epts} pts`, { size: '13px', color: COLORS.dim });

    // ---- Bottom bar ----
    const by = H - 40;
    button(this, 90, by, 150, 40, '‹ Menu', () => this.scene.start('Menu'), { blue: true });
    if (SKIRMISH_SCENARIOS.length > 1) {
      button(this, W / 2 - 150, by, 130, 40, '‹ Scenario',
        () => this.scene.restart({ scenarioIndex: (this.scenarioIndex + SKIRMISH_SCENARIOS.length - 1) % SKIRMISH_SCENARIOS.length }), { fontSize: '13px' });
      button(this, W / 2 + 150, by, 130, 40, 'Scenario ›',
        () => this.scene.restart({ scenarioIndex: (this.scenarioIndex + 1) % SKIRMISH_SCENARIOS.length }), { fontSize: '13px' });
    }
    this.fightBtn = button(this, W - 110, by, 170, 44, 'To Battle!', () => this.startFight(), { fontSize: '17px' });
    this.refresh();
  }

  markHero() {
    for (const [hid, b] of Object.entries(this.heroBtns)) {
      b.bg.setTexture(hid === this.heroId ? 'ui_btn_blue' : 'ui_btn');
    }
  }

  startFight() {
    const stacks = this.composedStacks();
    if (!stacks.length) return;
    this.tooltip.hide();
    // Minimal state is enough for createHero (it needs only rng + heroes).
    const rng = new Rng((Math.random() * 2 ** 31) | 0);
    const state = { rng, heroes: {} };
    const playerHero = createHero(state, this.heroId, 0, 0, 0);
    const enemyHero = createHero(state, this.scn.enemyHero, 1, 0, 0);
    playerHero.army = pad7(stacks);
    enemyHero.army = pad7(this.scn.enemyArmy);

    const ctx = {
      skirmish: true,
      rng: state.rng,
      terrain: FACTIONS[this.faction].nativeTerrain || 'grass',
      humanSide: 0,
      attacker: { hero: playerHero, army: playerHero.army.filter(Boolean), playerIndex: 0 },
      defender: { hero: enemyHero, army: enemyHero.army.filter(Boolean), playerIndex: 1, name: enemyHero.name },
      defenseBonus: 0,
    };

    const scenarioIndex = this.scenarioIndex;
    const scenarioName = this.scn.name;
    const combat = this.scene.get('Combat');
    const onDone = (result) => {
      const digest = battleDigest(result.events, result.roster, {
        humanSide: result.humanSide,
        won: result.attackerWon === (result.humanSide === 0),
        xp: result.xp,
      });
      combat.scene.start('Debrief', { digest, scenarioIndex, scenarioName });
    };
    this.scene.start('Combat', { ctx, onDone });
  }
}

function pad7(stacks) {
  const army = [null, null, null, null, null, null, null];
  stacks.slice(0, 7).forEach((s, i) => { army[i] = { creature: s.creature, count: s.count, hurt: 0 }; });
  return army;
}
