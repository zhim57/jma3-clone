/**
 * terrain.js — Adventure-map terrain & decoration painters.
 *
 * The map is rendered once onto a big offscreen canvas (see AdventureScene):
 * per-tile painters lay down gradient bases with seeded speckle detail, then
 * soft feather strips blend different terrains into each other so nothing
 * looks like a hard grid. Obstacles (trees, rocks, mountains) are separate
 * sprites so they can sit "above" the ground with soft shadows.
 */

import { rgba, shade, mix, linGrad, radGrad, noiseRng, paint, poly, withShadow, resetShadow, makeCanvas } from './canvasKit.js';

/**
 * Each terrain has a base tone plus a warm (sunlit) and cool (shadow) accent
 * that the painter mottles between — this two-accent scheme is what turns a
 * flat fill into painterly, HoMM-flavoured ground. `flora` seeds tiny accent
 * specks (flowers, embers) for life.
 *
 * OPTIONAL STYLE FLAGS (all default to the plain look when omitted, so the
 * original terrains render byte-for-byte the same):
 *   detail   name looked up in DETAIL_PAINTERS for the terrain-specific flourish.
 *   density  multiplier (default 1) on the detail painter's element counts — a
 *            terrain opts into a busier, richer surface by bumping this above 1.
 *   variant  free-form string a detail painter may branch on for a palette or
 *            motif change (e.g. mossy rocks, foamy ripples) without a new painter.
 *
 * New looks are added purely by registering a painter in DETAIL_PAINTERS and
 * pointing a style entry (often a variant of an existing terrain) at it.
 */
export const TERRAIN_STYLE = {
  grass: { base: 0x5a9440, warm: 0x86b24e, cool: 0x35673a, detail: 'grass', flora: [0xf2e36a, 0xe8908a, 0xffffff] },
  dirt: { base: 0x8a6a42, warm: 0xa8895a, cool: 0x5f4830, detail: 'pebbles' },
  rough: { base: 0x9d8a58, warm: 0xbfa972, cool: 0x6f6038, detail: 'pebbles' },
  snow: { base: 0xe6ecf2, warm: 0xffffff, cool: 0xb4c6de, detail: 'sparkle' },
  swamp: { base: 0x5d7550, warm: 0x7d9060, cool: 0x384a38, detail: 'swamp', flora: [0x6a8a44] },
  lava: { base: 0x39302e, warm: 0x5a3a2e, cool: 0x1e1816, detail: 'cracks', flora: [0xff8030, 0xffb040] },
  sand: { base: 0xd6c07c, warm: 0xeed99a, cool: 0xa8905a, detail: 'sand' },
  water: { base: 0x2f5f96, warm: 0x4f86c0, cool: 0x1d3d68, detail: 'waves' },

  // ---- Richer variants of the base terrains (opt-in via map data). Each is a
  // recolour of an existing terrain routed through a new detail painter, so
  // baseColorOf/paintTerrainTile treat them like any other terrain. ----
  meadow: {
    base: 0x4f9a3e, warm: 0x94c657, cool: 0x2f6236, detail: 'tufts', density: 1.4,
    flora: [0xf2e36a, 0xe8908a, 0xffffff, 0xc76ad0],
  },
  highland: {
    base: 0x8f8468, warm: 0xb2a681, cool: 0x5c5442, detail: 'rocks', density: 1.2,
    variant: 'mossy', flora: [0x7a8a4a],
  },
  shallows: {
    base: 0x3f7fb0, warm: 0x74b6db, cool: 0x2a597f, detail: 'ripples', density: 1.3,
    variant: 'foam',
  },
};

export function baseColorOf(terrain) {
  return (TERRAIN_STYLE[terrain] || TERRAIN_STYLE.grass).base;
}

// ---------------------------------------------------------------------------
// Fast tiling: painting every one of ~1600 tiles from scratch is the dominant
// cost of building the world canvas. Instead we pre-render a handful of variants
// per terrain ONCE (into an offscreen cache that persists across games) and blit
// the right one per tile — ~20× faster. Repetition is hidden by the per-edge
// transitions and the map-wide macro/ground-cover passes drawn on top.
// ---------------------------------------------------------------------------
const TILE_VARIANTS = 12;
const _tileCache = new Map();

function tileVariant(terrain, v, size) {
  const key = `${terrain}:${size}:${v}`;
  let c = _tileCache.get(key);
  if (!c) {
    c = makeCanvas(size, size);
    paintTerrainTile(c.getContext('2d'), 0, 0, size, terrain, v * 7919 + 101);
    _tileCache.set(key, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Optional RASTER terrain tiles — the top of the terrain resolver (my layer ▸
// accepted ▸ procedural), matching the unit-sprite path. A generated
// `terrain_<t>` sprite is a seamless tileable texture; once the sprite pack has
// loaded, the scene registers it here and drawTerrainTile blits it in place of
// the procedural paint. The procedural tile stays the permanent fallback for
// any terrain without a raster, so a partial (or empty) set always renders.
//
// The registry is a module global (like _tileCache) populated ONLY by the game
// scene (AdventureScene.syncTerrainRasters). The standalone Asset Lab never
// registers, so its compare backdrop keeps drawing the procedural tile — the
// point of comparison. Sources are ready-to-draw (Image/Canvas from a loaded
// Phaser texture); a null or zero-size source is ignored so a half-decoded
// image can never paint a blank tile.
// ---------------------------------------------------------------------------
const _terrainRasters = new Map();

/** Register a ready drawable (Image/Canvas) as the raster tile for `terrain`;
 *  a null/zero-size source instead clears any existing registration. */
export function setTerrainRaster(terrain, source) {
  if (source && source.width) _terrainRasters.set(terrain, source);
  else _terrainRasters.delete(terrain);
}

/** Drop every registered raster tile (call before re-syncing from a scene). */
export function clearTerrainRasters() {
  _terrainRasters.clear();
}

/** True when a raster tile is registered for `terrain`. */
export function hasTerrainRaster(terrain) {
  return _terrainRasters.has(terrain);
}

/**
 * Blit one terrain tile at (px,py): the registered raster tile scaled to `size`
 * when one exists (seamless, so it tiles across cells), else a cached
 * pre-rendered procedural variant chosen by `seed` (one of TILE_VARIANTS looks).
 * Same signature and output box either way, so callers never branch on which
 * tier served the tile.
 */
export function drawTerrainTile(ctx, px, py, size, terrain, seed) {
  const raster = _terrainRasters.get(terrain);
  if (raster) { ctx.drawImage(raster, px, py, size, size); return; }
  const v = ((seed % TILE_VARIANTS) + TILE_VARIANTS) % TILE_VARIANTS;
  ctx.drawImage(tileVariant(terrain, v, size), px, py);
}

/**
 * Paint one terrain tile at (px,py). Layers: lit base gradient → broad
 * warm/cool mottling (drawn past the edges so it reads seamless across tiles)
 * → fine grain → terrain-specific flourish → sparse flora specks.
 */
export function paintTerrainTile(ctx, px, py, size, terrain, seed) {
  const style = TERRAIN_STYLE[terrain] || TERRAIN_STYLE.grass;
  const rng = noiseRng(seed);
  const base = style.base;

  // Flat base fill. A per-tile diagonal gradient telegraphs the grid (every
  // tile repeats the same NW→SE ramp), so the variation is carried instead by
  // the mottling below and the map-wide macro pass (paintMacroVariation).
  ctx.fillStyle = rgba(base);
  ctx.fillRect(px, py, size, size);

  // Broad mottling toward the warm & cool accents (overflows the tile so
  // neighbouring tiles blend without a visible grid).
  for (let i = 0; i < 5; i++) {
    const warm = rng.chance(0.5);
    const bx = px + rng.range(-10, size + 10);
    const by = py + rng.range(-10, size + 10);
    const br = rng.range(14, 34);
    const col = mix(base, warm ? style.warm : style.cool, rng.range(0.4, 0.85));
    ctx.fillStyle = radGrad(ctx, bx, by, 0, br, [
      [0, rgba(col, warm ? 0.28 : 0.34)],
      [1, rgba(col, 0)],
    ]);
    ctx.fillRect(bx - br, by - br, br * 2, br * 2);
  }

  // Fine grain (soft-light keeps it subtle and painterly).
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  for (let i = 0; i < 40; i++) {
    const sx = px + rng.range(0, size);
    const sy = py + rng.range(0, size);
    const light = rng.chance(0.5);
    ctx.fillStyle = rgba(light ? 0xffffff : 0x000000, rng.range(0.05, 0.16));
    const r = rng.range(0.6, 2.2);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  paintDetail(ctx, px, py, size, style, base, rng);

  // Sparse flora specks (flowers on grass, embers on lava…).
  if (style.flora && rng.chance(0.34)) {
    const n = rng.int(1, 2);
    for (let i = 0; i < n; i++) {
      const fx = px + rng.range(4, size - 4);
      const fy = py + rng.range(4, size - 4);
      const col = rng.pick(style.flora);
      ctx.fillStyle = rgba(col, terrain === 'lava' ? 0.9 : 0.8);
      if (terrain === 'lava') withShadow(ctx, rgba(col, 0.9), 4, 0, 0);
      ctx.beginPath();
      ctx.arc(fx, fy, rng.range(0.9, 1.8), 0, Math.PI * 2);
      ctx.fill();
      if (terrain === 'lava') resetShadow(ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// The three COHESION passes below (macro variation, ground cover, roads) are
// whole-map effects: they must paint the same geometry at the same world
// coordinates for every chunk of the bake, or the art breaks at chunk seams.
// They therefore always COMPUTE over the full map — but each accepts an
// optional `clip` rectangle (world px, {x0, y0, x1, y1}) and skips the actual
// canvas work for any element that cannot touch it. Skipping is per-element
// and conservative (the element's own painted extent against the rect), so a
// clipped bake is pixel-identical to an unclipped one: everything skipped
// would have been discarded by the canvas edge anyway.
//
// Why this shape: buildTerrain bakes ~2048px chunks, and before the clip each
// pass ran its full-map work once PER CHUNK — on the 144×120 preset that is 20
// chunks × ~103k gradient fills of which ~95% were clipped away, a ~2.8s
// main-thread stall paid on every surface⇄underground flip. The rejected
// alternative — painting the passes once into a shared whole-map canvas and
// blitting per chunk — removes the redundancy entirely but needs a
// map.w*T × map.h*T canvas, which is exactly the WebGL/canvas size limit the
// chunking exists to avoid (9216×7680 on the largest preset).
//
// DETERMINISM: paintMacroVariation and paintGroundCover's scatter pass draw
// from a single sequential rng, so a skipped element still ADVANCES the stream
// exactly as before — only the gradient construction and fill are skipped.
// Anything less and each chunk would paint a DIFFERENT macro layer, breaking
// the very seams this design preserves (guarded by tests/terrain-clip.test.js).
// ---------------------------------------------------------------------------

/** Does an element painted inside [x0,x1]×[y0,y1] (world px) touch `clip`?
 *  No clip means paint everything (the pre-clip behaviour, kept as default). */
function touchesClip(clip, x0, y0, x1, y1) {
  return !clip || (x1 >= clip.x0 && x0 <= clip.x1 && y1 >= clip.y0 && y0 <= clip.y1);
}

/**
 * Map-wide macro variation: large soft light/dark blobs painted across the
 * whole terrain canvas, independent of the tile grid, so the ground undulates
 * on a scale much larger than a tile and the per-tile seams stop reading as a
 * checkerboard. Deterministic per map (seeded from the tiles' decor values).
 */
export function paintMacroVariation(ctx, map, size, clip = null) {
  const W = map.w * size, H = map.h * size;
  let seed = 0;
  for (let i = 0; i < map.tiles.length; i += 17) seed = (seed + map.tiles[i].decor) >>> 0;
  const rng = noiseRng(seed || 1);
  const count = Math.round((map.w * map.h) / 22);
  ctx.save();
  for (let i = 0; i < count; i++) {
    // Every rng draw happens for every blob, clipped or not — the stream is the
    // seam-alignment contract (see the cohesion-pass note above).
    const cx = rng.range(0, W), cy = rng.range(0, H);
    const r = rng.range(size * 1.6, size * 4.2);
    const light = rng.chance(0.5);
    const col = light ? 0xffffff : 0x2b2b2b;
    const a = light ? rng.range(0.08, 0.18) : rng.range(0.05, 0.12);
    if (!touchesClip(clip, cx - r, cy - r, cx + r, cy + r)) continue;
    ctx.globalCompositeOperation = light ? 'soft-light' : 'multiply';
    ctx.fillStyle = radGrad(ctx, cx, cy, 0, r, [[0, rgba(col, a)], [1, rgba(col, 0)]]);
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
}

/**
 * Bake ground cover into the terrain: a soft forest-floor (under trees) or
 * stony-ground (under rock/mountain) patch beneath every obstacle so it sits in
 * a bed of undergrowth rather than on bare lawn — overlapping patches from
 * adjacent obstacles merge into continuous forest/rock ground — plus scattered
 * worn-earth patches on open terrain for landscape variety.
 */
export function paintGroundCover(ctx, map, size, clip = null) {
  ctx.save();
  // (a) forest-floor / stony ground under obstacle clusters. Each obstacle's
  // patches are seeded from ITS OWN tile position, so tiles are independent and
  // whole rows/columns that cannot reach the clip can be skipped outright. The
  // widest patch reaches |ox−cx| ≤ 0.42·size plus r ≤ 1.0·size from the tile
  // centre — under 1.5 tiles — so a 2-tile apron around the clip is safely
  // conservative.
  const APRON = 2;
  const ty0 = clip ? Math.max(0, Math.floor(clip.y0 / size) - APRON) : 0;
  const ty1 = clip ? Math.min(map.h - 1, Math.ceil(clip.y1 / size) + APRON) : map.h - 1;
  const tx0 = clip ? Math.max(0, Math.floor(clip.x0 / size) - APRON) : 0;
  const tx1 = clip ? Math.min(map.w - 1, Math.ceil(clip.x1 / size) + APRON) : map.w - 1;
  for (let y = ty0; y <= ty1; y++) {
    for (let x = tx0; x <= tx1; x++) {
      const tile = map.tiles[y * map.w + x];
      if (!tile.obstacle) continue;
      const style = TERRAIN_STYLE[tile.terrain] || TERRAIN_STYLE.grass;
      const rng = noiseRng(tile.decor + x * 7 + y * 131);
      const floor = tile.obstacle === 'tree'
        ? mix(style.base, 0x35281a, 0.5)   // leafy earth
        : mix(style.base, 0x585048, 0.5);  // stony ground
      const cx = x * size + size / 2, cy = y * size + size * 0.82;
      for (let i = 0; i < 3; i++) {
        const ox = cx + rng.range(-size * 0.42, size * 0.42);
        const oy = cy + rng.range(-size * 0.28, size * 0.14);
        const r = rng.range(size * 0.55, size * 1.0);
        ctx.fillStyle = radGrad(ctx, ox, oy, 0, r, [
          [0, rgba(floor, 0.5)], [0.55, rgba(floor, 0.26)], [1, rgba(floor, 0)],
        ]);
        ctx.fillRect(ox - r, oy - r, r * 2, r * 2);
      }
    }
  }
  // (b) scattered worn-earth patches on open ground. ONE sequential rng for the
  // whole map, so — unlike pass (a) — every iteration must run and draw its
  // values in the original order; only the gradient + fill are skipped for
  // patches that cannot touch the clip (see the cohesion-pass note above).
  let seed = 7;
  for (let i = 0; i < map.tiles.length; i += 23) seed = (seed + map.tiles[i].decor) >>> 0;
  const rng = noiseRng(seed || 3);
  const W = map.w * size, H = map.h * size;
  const patches = Math.round((map.w * map.h) / 40);
  for (let i = 0; i < patches; i++) {
    const cx = rng.range(0, W), cy = rng.range(0, H);
    const tile = map.tiles[Math.floor(cy / size) * map.w + Math.floor(cx / size)];
    if (!tile || tile.terrain === 'water' || tile.terrain === 'lava') continue;
    const style = TERRAIN_STYLE[tile.terrain] || TERRAIN_STYLE.grass;
    const worn = mix(style.base, style.cool, 0.6);
    const r = rng.range(size * 0.6, size * 1.4);
    if (!touchesClip(clip, cx - r, cy - r, cx + r, cy + r)) continue;
    ctx.fillStyle = radGrad(ctx, cx, cy, 0, r, [[0, rgba(worn, 0.22)], [1, rgba(worn, 0)]]);
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
}

// Road surface tones, keyed by CONFIG.ROAD_COST type. Each is a lighter travel
// surface over a darker sunken edge, so a road reads as a worn track.
const ROAD_STYLE = {
  dirt: { base: 0x6f5334, edge: 0x49341e },
  cobble: { base: 0x9a978c, edge: 0x67655c },
};

/**
 * Paint the road network onto the terrain canvas: every `tile.road` cell draws
 * a rounded node plus a half-tile spur toward each adjacent road cell (the
 * neighbour paints the matching half, so segments meet seamlessly into a
 * continuous track). A wide dark edge pass underlays a narrower light surface.
 * Whole-map pass like paintGroundCover — run under the chunk translate so it
 * tiles across chunk borders; tiles that cannot reach the `clip` rect are
 * skipped, and the few border tiles that can are painted in full and clipped
 * by the canvas edge as before.
 */
export function paintRoads(ctx, map, size, clip = null) {
  const { w, h, tiles } = map;
  const roadAt = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? tiles[y * w + x].road : null;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  // No rng at all here — a road tile's paint depends only on its own position
  // and its neighbours' road flags — so the scan can be bounded to the tiles
  // whose paint can reach the clip. A tile's paint extends at most 0.7·size
  // from its centre (a half-tile spur plus the round cap's half-width), so a
  // 1-tile apron is safely conservative.
  const ty0 = clip ? Math.max(0, Math.floor(clip.y0 / size) - 1) : 0;
  const ty1 = clip ? Math.min(h - 1, Math.ceil(clip.y1 / size) + 1) : h - 1;
  const tx0 = clip ? Math.max(0, Math.floor(clip.x0 / size) - 1) : 0;
  const tx1 = clip ? Math.min(w - 1, Math.ceil(clip.x1 / size) + 1) : w - 1;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const layer of ['edge', 'base']) {
    for (let y = ty0; y <= ty1; y++) {
      for (let x = tx0; x <= tx1; x++) {
        const r = tiles[y * w + x].road;
        if (!r) continue;
        const st = ROAD_STYLE[r] || ROAD_STYLE.dirt;
        const cx = x * size + size / 2, cy = y * size + size / 2;
        const width = size * (layer === 'edge' ? 0.4 : 0.26);
        const col = rgba(st[layer], layer === 'edge' ? 0.55 : 0.92);
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(cx, cy, width / 2, 0, Math.PI * 2);
        ctx.fill();
        for (const [dx, dy] of DIRS) {
          if (!roadAt(x + dx, y + dy)) continue;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + dx * size / 2, cy + dy * size / 2);
          ctx.stroke();
        }
      }
    }
  }
  ctx.restore();
}

/**
 * DETAIL_PAINTERS — extensible registry of terrain-detail flourish painters.
 *
 * A painter receives `(ctx, px, py, size, style, base, rng)` and lays down the
 * terrain-specific surface texture (blades, pebbles, ripples…) on top of the
 * already-painted base + mottling. New terrain looks are added by REGISTERING a
 * painter here and pointing a TERRAIN_STYLE entry's `detail` at its key — no
 * switch to edit. `style.density` (default 1) scales element counts so a style
 * can opt into a busier surface; `style.variant` lets a painter branch palette
 * or motif. The original painters honour density at ×1, i.e. unchanged output.
 */
export const DETAIL_PAINTERS = {
  grass(ctx, px, py, size, style, base, rng) {
    // Layered tufts: dark base blades + a lighter highlighted blade.
    const n = Math.round(9 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const gx = px + rng.range(3, size - 3);
      const gy = py + rng.range(7, size - 1);
      const hgt = rng.range(4, 8);
      ctx.strokeStyle = rgba(shade(base, -0.3), 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + rng.range(-2, 2), gy - hgt * 0.6, gx + rng.range(-3, 3), gy - hgt);
      ctx.stroke();
      ctx.strokeStyle = rgba(mix(base, style.warm, 0.7), 0.5);
      ctx.beginPath();
      ctx.moveTo(gx + 1, gy);
      ctx.quadraticCurveTo(gx + 1, gy - hgt * 0.6, gx + rng.range(-1, 2), gy - hgt + 1);
      ctx.stroke();
    }
  },

  swamp(ctx, px, py, size, style, base, rng) {
    const n = Math.round(6 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const gx = px + rng.range(4, size - 4);
      const gy = py + rng.range(6, size - 2);
      ctx.strokeStyle = rgba(shade(base, -0.32), 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + rng.range(-2, 2), gy - rng.range(4, 7));
      ctx.stroke();
    }
    // murky puddles
    if (rng.chance(0.4)) {
      ctx.fillStyle = rgba(shade(base, -0.4), 0.3);
      ctx.beginPath();
      ctx.ellipse(px + rng.range(12, size - 12), py + rng.range(12, size - 12), rng.range(6, 11), rng.range(3, 6), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  pebbles(ctx, px, py, size, style, base, rng) {
    const n = Math.round(7 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const gx = px + rng.range(4, size - 4);
      const gy = py + rng.range(4, size - 4);
      const r = rng.range(1.4, 3);
      // pebble with a lit top and shadow underside
      ctx.fillStyle = rgba(shade(base, -0.28), 0.6);
      ctx.beginPath();
      ctx.ellipse(gx, gy + 0.8, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(shade(base, 0.22), 0.6);
      ctx.beginPath();
      ctx.ellipse(gx, gy - 0.4, r * 0.8, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  sand(ctx, px, py, size, style, base, rng) {
    // wind ripples
    ctx.strokeStyle = rgba(shade(base, -0.2), 0.35);
    ctx.lineWidth = 1.1;
    const n = Math.round(4 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const wy = py + rng.range(6, size - 6);
      const wx = px + rng.range(2, size - 26);
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.quadraticCurveTo(wx + 8, wy - 2, wx + 16, wy);
      ctx.quadraticCurveTo(wx + 22, wy + 1.6, wx + 26, wy - 0.6);
      ctx.stroke();
    }
  },

  sparkle(ctx, px, py, size, style, base, rng) {
    // snow drifts (cool pools) + glints
    ctx.fillStyle = rgba(style.cool, 0.18);
    ctx.beginPath();
    ctx.ellipse(px + rng.range(10, size - 10), py + rng.range(10, size - 10), rng.range(9, 17), rng.range(5, 9), rng.range(0, 3), 0, Math.PI * 2);
    ctx.fill();
    const n = Math.round(7 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const gx = px + rng.range(3, size - 3);
      const gy = py + rng.range(3, size - 3);
      ctx.fillStyle = rgba(0xffffff, rng.range(0.5, 0.95));
      ctx.fillRect(gx, gy, 1.3, 1.3);
    }
  },

  cracks(ctx, px, py, size, style, base, rng) {
    // cooled crust plates + glowing magma fissures
    ctx.strokeStyle = rgba(0x000000, 0.3);
    ctx.lineWidth = 1.2;
    const n = Math.round(2 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      let cx = px + rng.range(4, size - 4), cy = py + rng.range(4, size - 4);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      for (let s = 0; s < 3; s++) { cx += rng.range(-10, 10); cy += rng.range(-10, 10); ctx.lineTo(cx, cy); }
      ctx.stroke();
    }
    if (rng.chance(0.7)) {
      const m = rng.int(1, 2);
      for (let c = 0; c < m; c++) {
        let cx = px + rng.range(6, size - 6);
        let cy = py + rng.range(6, size - 6);
        withShadow(ctx, rgba(0xff5a10, 0.95), 7, 0, 0);
        ctx.strokeStyle = rgba(0xffa040, 0.9);
        ctx.lineWidth = rng.range(1.2, 2.2);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        for (let s = 0; s < 3; s++) { cx += rng.range(-9, 9); cy += rng.range(-9, 9); ctx.lineTo(cx, cy); }
        ctx.stroke();
        resetShadow(ctx);
      }
    }
  },

  waves(ctx, px, py, size, style, base, rng) {
    ctx.strokeStyle = rgba(shade(base, 0.4), 0.45);
    ctx.lineWidth = 1.2;
    const n = Math.round(4 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const wy = py + rng.range(6, size - 6);
      const wx = px + rng.range(2, size - 26);
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.quadraticCurveTo(wx + 6, wy - 2.5, wx + 12, wy);
      ctx.quadraticCurveTo(wx + 18, wy + 2.5, wx + 24, wy);
      ctx.stroke();
    }
    // sun glints on the water
    ctx.fillStyle = rgba(0xffffff, 0.25);
    for (let i = 0; i < 2; i++) {
      ctx.fillRect(px + rng.range(4, size - 6), py + rng.range(4, size - 4), rng.range(2, 5), 1.2);
    }
  },

  // ---- New looks (registered, not switched) ------------------------------

  /** Lush meadow grass: denser clustered tufts crowned with a bright blade. */
  tufts(ctx, px, py, size, style, base, rng) {
    const n = Math.round(7 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const gx = px + rng.range(3, size - 3);
      const gy = py + rng.range(8, size - 1);
      const blades = rng.int(3, 5);
      // a fan of blades sharing a root — reads as a tuft rather than stray grass
      for (let b = 0; b < blades; b++) {
        const spread = (b / (blades - 1) - 0.5) * rng.range(5, 9);
        const hgt = rng.range(4, 9);
        ctx.strokeStyle = rgba(shade(base, -0.3), 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.quadraticCurveTo(gx + spread * 0.5, gy - hgt * 0.6, gx + spread, gy - hgt);
        ctx.stroke();
      }
      // lit crown blade
      const hgt = rng.range(6, 10);
      ctx.strokeStyle = rgba(mix(base, style.warm, 0.8), 0.6);
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + rng.range(-1, 1), gy - hgt * 0.6, gx + rng.range(-2, 2), gy - hgt);
      ctx.stroke();
    }
  },

  /** Scattered angular rocks with a lit facet and cast shadow (highland moor). */
  rocks(ctx, px, py, size, style, base, rng) {
    const n = Math.round(4 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const gx = px + rng.range(6, size - 6);
      const gy = py + rng.range(6, size - 6);
      const r = rng.range(2.4, 5);
      // contact shadow
      ctx.fillStyle = rgba(0x000000, 0.22);
      ctx.beginPath();
      ctx.ellipse(gx + 1, gy + r * 0.7, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // faceted body: dark base wedge then a lit top wedge
      const pts = [];
      const facets = rng.int(5, 6);
      for (let f = 0; f < facets; f++) {
        const a = (f / facets) * Math.PI * 2;
        const rr = r * rng.range(0.75, 1.12);
        pts.push([gx + Math.cos(a) * rr, gy + Math.sin(a) * rr * 0.82]);
      }
      ctx.fillStyle = rgba(shade(base, -0.3), 0.85);
      poly(ctx, pts);
      ctx.fill();
      ctx.fillStyle = rgba(shade(base, 0.28), 0.8);
      poly(ctx, [pts[0], pts[1], [gx, gy - r * 0.2]]);
      ctx.fill();
      // optional moss on the shaded side
      if (style.variant === 'mossy' && rng.chance(0.5)) {
        ctx.fillStyle = rgba(0x5f7a3a, 0.5);
        ctx.beginPath();
        ctx.ellipse(gx - r * 0.4, gy + r * 0.3, r * 0.5, r * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },

  /** Concentric shallow-water ripples with bright foam highlights. */
  ripples(ctx, px, py, size, style, base, rng) {
    const n = Math.round(3 * (style.density ?? 1));
    for (let i = 0; i < n; i++) {
      const cx = px + rng.range(8, size - 8);
      const cy = py + rng.range(8, size - 8);
      const rings = rng.int(2, 3);
      for (let r = 0; r < rings; r++) {
        const rr = 3 + r * rng.range(3, 5);
        ctx.strokeStyle = rgba(shade(base, 0.42), 0.34 - r * 0.07);
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rr, rr * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // foamy glints riding the crests
    const foam = style.variant === 'foam' ? 0.5 : 0.28;
    ctx.fillStyle = rgba(0xffffff, foam);
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(px + rng.range(4, size - 6), py + rng.range(4, size - 4), rng.range(2, 4), 1.1);
    }
  },
};

/** Route a tile's detail flourish through the registry (no-op if unregistered). */
function paintDetail(ctx, px, py, size, style, base, rng) {
  const painter = DETAIL_PAINTERS[style.detail];
  if (painter) painter(ctx, px, py, size, style, base, rng);
}

/**
 * Feather strip blending neighbor terrain into this tile along one side.
 * side: 0=N 1=E 2=S 3=W. Painted after all base tiles.
 */
export function paintTransition(ctx, px, py, size, side, neighborColor) {
  const f = 10; // feather width
  let grad;
  if (side === 0) grad = linGrad(ctx, 0, py, 0, py + f, [[0, rgba(neighborColor, 0.4)], [1, rgba(neighborColor, 0)]]);
  if (side === 2) grad = linGrad(ctx, 0, py + size, 0, py + size - f, [[0, rgba(neighborColor, 0.4)], [1, rgba(neighborColor, 0)]]);
  if (side === 3) grad = linGrad(ctx, px, 0, px + f, 0, [[0, rgba(neighborColor, 0.4)], [1, rgba(neighborColor, 0)]]);
  if (side === 1) grad = linGrad(ctx, px + size, 0, px + size - f, 0, [[0, rgba(neighborColor, 0.4)], [1, rgba(neighborColor, 0)]]);
  ctx.fillStyle = grad;
  ctx.fillRect(px, py, size, size);
}

// ---------------------------------------------------------------------------
// Decoration sprites (obstacles)
// ---------------------------------------------------------------------------

/** Register tree/rock/mountain sprites with Phaser. Idempotent per scene. */
export function registerDecorTextures(scene) {
  const add = (key, canvas) => {
    if (!scene.textures.exists(key)) scene.textures.addCanvas(key, canvas);
  };

  // Broadleaf + conifer trees. Variant 0/1 = leafy oaks, 2 = pine.
  for (let v = 0; v < 3; v++) {
    add(`decor_tree_${v}`, paint(64, 88, (ctx) => {
      const rng = noiseRng(100 + v);
      const cx = 32, baseY = 80;
      // ground contact shadow
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath();
      ctx.ellipse(cx, baseY + 2, 20, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      // trunk with shading
      ctx.fillStyle = linGrad(ctx, cx - 4, 0, cx + 4, 0, [[0, '#6d4e34'], [0.5, '#5a3f28'], [1, '#3f2c1c']]);
      ctx.beginPath();
      ctx.moveTo(cx - 4, baseY);
      ctx.quadraticCurveTo(cx - 3, baseY - 18, cx - 2.5, baseY - 26);
      ctx.lineTo(cx + 2.5, baseY - 26);
      ctx.quadraticCurveTo(cx + 3, baseY - 18, cx + 4, baseY);
      ctx.closePath();
      ctx.fill();

      if (v === 2) {
        // Pine: stacked tiers with a lit side.
        const green = 0x2f6b34;
        for (let layer = 0; layer < 4; layer++) {
          const w = 46 - layer * 9 + rng.range(-2, 2);
          const y = baseY - 20 - layer * 13;
          ctx.fillStyle = linGrad(ctx, cx - w / 2, y - 18, cx + w / 2, y, [
            [0, rgba(mix(green, 0x9ed06a, 0.5))],
            [1, rgba(shade(green, -0.32))],
          ]);
          poly(ctx, [[cx - w / 2, y], [cx + w / 2, y], [cx, y - 22]]);
          ctx.fill();
        }
      } else {
        // Broadleaf: overlapping foliage blobs, dark base then lit clumps.
        const green = v === 0 ? 0x357a38 : 0x4a8a3a;
        const canopyY = baseY - 40;
        withShadow(ctx, 'rgba(0,0,0,0.25)', 5, 0, 3);
        ctx.fillStyle = rgba(shade(green, -0.28));
        ctx.beginPath();
        ctx.ellipse(cx, canopyY + 4, 24, 22, 0, 0, Math.PI * 2);
        ctx.fill();
        resetShadow(ctx);
        // clumps
        for (let i = 0; i < 10; i++) {
          const a = rng.range(0, Math.PI * 2), r = rng.range(4, 17);
          const bx = cx + Math.cos(a) * r, by = canopyY + Math.sin(a) * r * 0.9;
          const rad = rng.range(7, 12);
          const lit = by < canopyY; // upper clumps catch light
          ctx.fillStyle = radGrad(ctx, bx - rad * 0.3, by - rad * 0.4, 1, rad, [
            [0, rgba(mix(green, 0xcfe88a, lit ? 0.55 : 0.28))],
            [1, rgba(shade(green, -0.18), 0.96)],
          ]);
          ctx.beginPath();
          ctx.arc(bx, by, rad, 0, Math.PI * 2);
          ctx.fill();
        }
        // top highlight
        ctx.fillStyle = rgba(0xdff0a8, 0.35);
        ctx.beginPath();
        ctx.ellipse(cx - 5, canopyY - 10, 8, 5, -0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }));
  }

  // Round rocks.
  for (let v = 0; v < 2; v++) {
    add(`decor_rock_${v}`, paint(64, 56, (ctx) => {
      const rng = noiseRng(200 + v);
      withShadow(ctx, 'rgba(0,0,0,0.35)', 5, 0, 3);
      const grey = v === 0 ? 0x6f6a66 : 0x5d5a58;
      const pts = [];
      const cx = 32, cy = 34, R = 20;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r = R * rng.range(0.75, 1.1);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.72]);
      }
      ctx.fillStyle = linGrad(ctx, cx - R, cy - R, cx + R, cy + R, [
        [0, rgba(shade(grey, 0.3))],
        [1, rgba(shade(grey, -0.3))],
      ]);
      poly(ctx, pts);
      ctx.fill();
      resetShadow(ctx);
      // cracks
      ctx.strokeStyle = rgba(shade(grey, -0.5), 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy - 8);
      ctx.lineTo(cx - 1, cy);
      ctx.lineTo(cx - 7, cy + 8);
      ctx.stroke();
    }));
  }

  // Mountain (occupies ~1 tile but drawn tall).
  add('decor_mountain', paint(84, 92, (ctx) => {
    const baseY = 84;
    withShadow(ctx, 'rgba(0,0,0,0.4)', 8, 0, 4);
    // main massif
    ctx.fillStyle = linGrad(ctx, 0, 10, 84, baseY, [
      [0, '#8b8894'], [0.6, '#5f5c68'], [1, '#46444e'],
    ]);
    poly(ctx, [[2, baseY], [26, 34], [40, 12], [58, 40], [82, baseY]]);
    ctx.fill();
    resetShadow(ctx);
    // ridge shading
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    poly(ctx, [[40, 12], [58, 40], [82, baseY], [52, baseY]]);
    ctx.fill();
    // snow cap
    ctx.fillStyle = '#eef2f8';
    poly(ctx, [[33, 24], [40, 12], [49, 26], [44, 24], [40, 30], [36, 23]]);
    ctx.fill();
  }));

  // Jagged lava rock.
  add('decor_lavarock', paint(64, 60, (ctx) => {
    withShadow(ctx, 'rgba(0,0,0,0.45)', 6, 0, 3);
    ctx.fillStyle = linGrad(ctx, 8, 6, 56, 54, [[0, '#4a3d3a'], [1, '#241d1c']]);
    poly(ctx, [[6, 52], [16, 26], [26, 36], [34, 10], [46, 34], [58, 24], [60, 52]]);
    ctx.fill();
    resetShadow(ctx);
    withShadow(ctx, 'rgba(255,90,20,0.8)', 5, 0, 0);
    ctx.strokeStyle = 'rgba(255,120,40,0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(20, 46);
    ctx.lineTo(30, 38);
    ctx.lineTo(36, 44);
    ctx.stroke();
    resetShadow(ctx);
  }));
}

/**
 * WHICH obstacle stands on a battlefield hex, chosen from the ground it stands on.
 *
 * Every combat obstacle used to draw the same `decor_rock_0` decal — one boulder,
 * one size, one facing, on every blocked hex of every battlefield. That is the
 * "schematic" in the report: not that the art is poor (the adventure map draws from
 * this same sheet and reads fine) but that it never varies, so a field of them
 * reads as a diagram of blocked cells rather than as ground.
 *
 * DETERMINISTIC FROM THE HEX, never from an rng draw. The battlefield is redrawn on
 * every relayout — a window resize, a HUD rebuild — and an obstacle that changed
 * shape when the player dragged the window would be a bug rather than variety.
 * Hashing the coordinates gives the same answer forever and gives neighbours
 * different answers, which is all the variety has to do.
 *
 * Lives here rather than in the scene because it is a pure function of (x, y,
 * terrain) and therefore the only part of this worth testing.
 */
export function combatObstacleFor(x, y, terrain) {
  // Mixed enough that adjacent hexes disagree, which a plain (x + y) would not: that
  // makes diagonal stripes of identical rocks, which is the failure being fixed.
  let h = ((x + 1) * 73856093) ^ ((y + 1) * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  // What grows here. Snow and swamp field thickets as readily as stone; sand and
  // lava have nothing standing, so they are all rock.
  //
  // NO MOUNTAINS, though the decor sheet has one and the first cut used it. Looked
  // at on screen, `decor_mountain` is map-scale art: on a battlefield hex it drew a
  // flat grey cutout whose peak overhung the hex above it, so it read as a piece of
  // paper rather than as ground. It is also the wrong FICTION — a boulder or a
  // thicket is something a battle is fought around, and a mountain is not something
  // that fits on one hex of it.
  const treeShare = terrain === 'sand' || terrain === 'lava' ? 0
    : (terrain === 'snow' || terrain === 'swamp' ? 0.5 : 0.4);
  const kind = (h % 1000) / 1000 < treeShare ? 'tree' : 'rock';
  return { kind, seed: h };
}

/** Map an obstacle id + terrain to a decor texture key. */
export function decorTextureFor(obstacle, terrain, seed) {
  if (obstacle === 'mountain') return 'decor_mountain';
  if (obstacle === 'tree') return `decor_tree_${terrain === 'snow' || terrain === 'rough' ? 2 : seed % 3}`;
  if (obstacle === 'rock') return terrain === 'lava' ? 'decor_lavarock' : `decor_rock_${seed % 2}`;
  return `decor_rock_0`;
}
