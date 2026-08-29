/**
 * vite.config.js — dev server + production bundle.
 *
 * Deliberately tiny. The parent repo's config carries a sprite-atlas plugin, a
 * CDN asset proxy, an /api proxy to the account service and a raster-pack
 * manifest step; this clone fetches no assets and runs no server, so none of that
 * has anything to do. `npm run dev` serves, `npm run build` bundles, and the
 * output is a static folder that works from any file host.
 */

import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Phaser is ~1.2 MB minified and is the only dependency; splitting it out
    // keeps the game bundle small enough to read in a network tab.
    rollupOptions: {
      output: {
        manualChunks: { phaser: ['phaser'] },
      },
    },
    chunkSizeWarningLimit: 1600,
  },
});
