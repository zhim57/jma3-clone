/**
 * DebriefScene — the consequence layer of the Battle Gym.
 *
 * Renders a battleDigest: outcome, a one-line verdict, losses on both sides,
 * the single biggest threat, and the raw numbers — so a win or a loss becomes
 * "what could I have done better", the whole point of the prepare -> fight ->
 * reflect loop. Buttons re-prepare the same scenario, pick another, or exit.
 */

import Phaser from 'phaser';
import { panel, button, label, FONT, COLORS } from '../ui/uikit.js';

export class DebriefScene extends Phaser.Scene {
  constructor() { super('Debrief'); }

  init(data) {
    this.digest = data?.digest || null;
    this.scenarioIndex = data?.scenarioIndex ?? 0;
    this.scenarioName = data?.scenarioName || 'Skirmish';
    // Adventure-map battles pass a return-to-map callback + a title override.
    this.adventure = !!data?.adventure;
    this.onContinue = data?.onContinue || null;
    this.titleOverride = data?.title || null;
  }

  create() {
    // Adventure LAUNCHes this recap over the (still-active) Combat scene, so
    // force it to the top of the render order — otherwise it is active but
    // hidden behind the battlefield ("battle ended but no end screen").
    this.scene.bringToTop();
    const W = this.scale.width, H = this.scale.height;
    const d = this.digest;
    this.add.rectangle(0, 0, W, H, 0x0b0910).setOrigin(0);

    const won = d && d.won;
    this.add.text(W / 2, 44, this.titleOverride || (won ? 'VICTORY' : 'DEFEAT'), {
      fontFamily: FONT, fontSize: '46px', fontStyle: 'bold',
      color: won ? COLORS.gold : COLORS.danger, stroke: '#140e04', strokeThickness: 7,
    }).setOrigin(0.5);
    label(this, W / 2, 78, this.adventure ? 'Battle Report' : this.scenarioName, { size: '14px', color: COLORS.dim, ox: 0.5 });

    if (!d) {
      button(this, W / 2, H - 60, 200, 44, 'Continue', () => this.leave());
      return;
    }

    // Verdict — the takeaway — with the advisor's one actionable tip beneath.
    panel(this, W / 2 - 360, 104, 720, 96);
    label(this, W / 2, 116, d.verdict, { size: '15px', color: COLORS.parchment, ox: 0.5, align: 'center', wrap: 690 });
    if (d.advice) {
      label(this, W / 2, 158, `Advisor: ${d.advice}`, { size: '13px', color: COLORS.gold, ox: 0.5, align: 'center', wrap: 690 });
    }

    // Loss columns — one row per stack (started / lost / survived).
    const colY = 224, colH = H - colY - 150;
    const lossColumn = (x, title, stacks, accent) => {
      panel(this, x, colY, 320, colH);
      label(this, x + 16, colY + 12, title, { size: '15px', bold: true, color: accent });
      const rows = stacks.filter((e) => e.started > 0);
      if (!rows.length) { label(this, x + 16, colY + 42, 'No forces.', { size: '13px', color: COLORS.dim }); return; }
      rows.forEach((e, i) => {
        const y = colY + 42 + i * 24;
        const wiped = e.lost >= e.started;
        label(this, x + 16, y, e.name, { size: '13px', color: wiped ? COLORS.danger : COLORS.parchment });
        label(this, x + 300, y, `${e.lost} lost · ${e.survived}/${e.started} left`, {
          size: '13px', ox: 1, color: e.lost === 0 ? COLORS.good : (wiped ? COLORS.danger : COLORS.parchment),
        });
      });
    };
    lossColumn(W / 2 - 340, 'Your Casualties', d.yourStacks, COLORS.gold);
    lossColumn(W / 2 + 20, 'Enemy Casualties', d.enemyStacks, COLORS.danger);

    // Stat line + biggest threat.
    const sy = colY + colH + 14;
    const stats = `Rounds ${d.rounds}    ·    Damage dealt ${d.damageDealt}    ·    Damage taken ${d.damageTaken}` +
      (won ? `    ·    XP +${d.xp}` : '');
    label(this, W / 2, sy, stats, { size: '13px', color: COLORS.dim, ox: 0.5 });
    // Flawless victory premium (CONFIG.FLAWLESS_XP_BONUS) — not a scratch on your army.
    if (d.flawless) {
      label(this, W / 2, sy - 22, `✦ FLAWLESS — not a single creature lost: +${d.flawless.total - d.flawless.base} bonus experience`,
        { size: '13px', bold: true, color: COLORS.good, ox: 0.5 });
    }
    if (d.biggestThreat && d.biggestThreat.kills > 0) {
      label(this, W / 2, sy + 22, `Biggest threat: enemy ${d.biggestThreat.name} — ${d.biggestThreat.kills} of yours slain`,
        { size: '13px', color: COLORS.danger, ox: 0.5 });
    }

    // Actions.
    const by = H - 46;
    if (this.adventure) {
      // Return to the adventure map via the caller's continuation.
      button(this, W / 2, by, 240, 46, 'Continue to Map', () => this.leave(), { fontSize: '16px' });
    } else {
      button(this, W / 2 - 230, by, 200, 44, 'Try Again', () => this.scene.start('SkirmishSetup', { scenarioIndex: this.scenarioIndex }), { fontSize: '15px' });
      button(this, W / 2, by, 200, 44, 'Battle Gym', () => this.scene.start('SkirmishSetup', { scenarioIndex: 0 }), { fontSize: '15px', blue: true });
      button(this, W / 2 + 230, by, 200, 44, 'Main Menu', () => this.scene.start('Menu'), { fontSize: '15px', blue: true });
    }
  }

  /** Adventure exit: stop this recap, then hand back to combat's onContinue
   *  (which stops Combat and resumes the map). Falls back to the menu. */
  leave() {
    console.info('[recap] Continue pressed — returning to map');
    const cont = this.onContinue;
    this.scene.stop();
    if (cont) cont(); else this.scene.start('Menu');
  }
}
