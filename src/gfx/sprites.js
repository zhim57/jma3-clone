/**
 * sprites.js — PROCEDURAL-ONLY resolver (jma3-clone).
 *
 * The parent repo ships an OPTIONAL raster-sprite pack: ~600 AI-generated PNGs
 * (plus a music/SFX pack) served from a CDN or `public/sprites/`, preferred over
 * the procedural glyphs wherever a unit, hero, artifact or building is drawn. It
 * is 209 MB of committed art — and this clone exists to study AI PLAYER logic, so
 * it carries none of it. Every pixel here is generated at boot from vector drawing
 * code in gfx/tokens.js, gfx/terrain.js, gfx/glyphs/ and ui/uikit.js.
 *
 * WHY THIS FILE STILL EXISTS. Ten scene/UI modules call these helpers to place an
 * icon, and upstream every one of them already has a procedural else-branch — the
 * raster pack was always an upgrade layer, never a requirement. Rather than edit
 * ten call sites (and fork them against upstream), this module keeps the exact
 * export surface and answers "there is no raster sprite" every time, which drops
 * every caller onto the procedural branch it already had. Callers are unchanged
 * and unaware.
 *
 * Consequently this file is ~50 lines instead of ~660: gone are the CDN index
 * layering, the URL optimiser, the atlas/batch preloaders with their stall
 * watchdogs, and strict-assets mode (a debug mode that replaces missing raster art
 * with a magenta placeholder — meaningless when there is no raster art by design).
 *
 * To restore the raster path, copy this file back from the parent repo along with
 * scripts/sprites/ and a sprite pack. Nothing else in this tree would change.
 */

import { FACTIONS } from '../data/factions.js';
import { buildingCategory } from '../data/buildings.js';

/** Texture key a raster sprite WOULD occupy. Kept so callers still compose ids. */
export function spriteKey(id) {
  return `sprite_${id}`;
}

/** Always false here: this clone never loads a raster sprite. */
export function hasSprite() {
  return false;
}

/** Strict-assets mode is a raster-pack debug aid; there is no pack to be strict about. */
export function isStrictAssets() {
  return false;
}

export function strictFromInputs() {
  return false;
}

/** Contain-fit an image into `box` px, the shape every icon helper returns. */
function fit(scene, key, x, y, box) {
  return scene.add.image(x, y, key).setDisplaySize(box, box);
}

/** Creature medallion — the procedural `token_<id>` glyph. */
export function unitIcon(scene, id, x, y, box) {
  return fit(scene, `token_${id}`, x, y, box);
}

/** Hero bust — the procedural `portrait_<portrait>` glyph. */
export function heroPortrait(scene, hero, x, y, box) {
  return fit(scene, `portrait_${hero.portrait}`, x, y, box);
}

export function heroTextureKey(scene, hero) {
  return `portrait_${hero.portrait}`;
}

/** Artifact pedestal glyph. */
export function artifactIcon(scene, id, x, y, box) {
  return fit(scene, `art_${id}`, x, y, box);
}

export function artifactTextureKey(scene, id) {
  return `art_${id}`;
}

/** Resource-bar icon — contain-fit like upstream, which scales rather than stretches. */
export function resourceIcon(scene, res, x, y, box) {
  const img = scene.add.image(x, y, `res_${res}`);
  img.setScale(Math.min(box / img.width, box / img.height));
  return img;
}

/** Spell plaque (school colour + effect symbol; see gfx/spellIcons.js). */
export function spellIcon(scene, id, x, y, box) {
  return fit(scene, `spellicon_${id}`, x, y, box);
}

/** Combat-control pictogram (Wait / Defend / …). */
export function actionIconKey(scene, name) {
  return `actionicon_${name}`;
}

/** Town silhouette — the procedural TOWN_PAINTERS art, keyed by townGlyph. */
export function townIcon(scene, townGlyph, x, y, box) {
  const img = scene.add.image(x, y, townGlyph);
  img.setScale(Math.min(box / img.width, box / img.height));
  return img;
}

/**
 * Town-building glyph, tinted by faction colour so one small category glyph set
 * serves every faction — exactly upstream's procedural branch.
 */
export function buildingIcon(scene, faction, id, b, x, y, box) {
  const cat = buildingCategory(id, b);
  const key = cat === 'dwelling' ? `bld_dwelling_${b?.dwellingTier || 1}` : `bld_${cat}`;
  const img = fit(scene, key, x, y, box);
  img.setTint(FACTIONS[faction]?.color ?? 0x9a94a8);
  return img;
}

/** No pack to preload. Callers await these during boot and read the count. */
export async function preloadSprites() { return 0; }
export async function preloadAtlas() { return 0; }
export async function spriteIndex() { return {}; }
export async function spriteUrl() { return null; }
