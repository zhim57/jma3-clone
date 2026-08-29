/**
 * BootScene — registers every procedural texture, then launches the Menu.
 *
 * All art in this clone is generated here, at boot, from vector drawing code:
 * ui/uikit.js (panels, buttons, dialog chrome), gfx/terrain.js (tile painters,
 * trees, rocks, mountains) and gfx/tokens.js (creature medallions, hero riders,
 * town silhouettes, mines, resource icons, portraits). Nothing is fetched.
 *
 * The parent repo also loads an optional AI-generated raster sprite pack here and
 * prefers it over the procedural glyphs; this clone drops that pack entirely (see
 * gfx/sprites.js), so `enhance()` and its CDN preloader are gone.
 *
 * `spritesReady` IS STILL SET, and deliberately. The HTML loading overlay
 * (index.html + game/loadingOverlay.js) lifts only once BOTH `bootReady` and
 * `spritesReady` are in the registry, and MenuScene / AdvUIScene / AdventureScene
 * each arm a one-shot re-render off the same pair. Dropping the raster path
 * without setting the flag would leave a game that boots perfectly behind an
 * opaque cover until the overlay's timeout rescued it. `spriteCount: 0` is the
 * honest answer to "how many raster sprites are loaded".
 */

import Phaser from 'phaser';
import { registerDecorTextures } from '../gfx/terrain.js';
import { registerAllTokens } from '../gfx/tokens.js';
import { registerUITextures } from '../ui/uikit.js';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    // Procedural art — the only art there is.
    registerUITextures(this);
    registerDecorTextures(this);
    registerAllTokens(this);

    // Both flags together: the art IS ready, because it is all generated above.
    this.game.registry.set('bootReady', true);
    this.game.registry.set('spriteCount', 0);
    this.game.registry.set('spritesReady', true);

    this.scene.launch('Menu');
    this.scene.stop();
  }
}
