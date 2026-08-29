/**
 * audio.js — Procedural sound & music via the Web Audio API.
 *
 * No audio files ship: every sound is synthesized in code (matching the game's
 * procedural-art ethos). A master gain feeds separate Music and SFX buses, all
 * driven by the persistent settings (master/music/sfx volume + mute). Nothing
 * is created at import time — the AudioContext is built lazily and only resumed
 * on a user gesture (browser autoplay policy), so importing this module is safe
 * in any environment (it no-ops cleanly when Web Audio is unavailable, e.g. in
 * node tests).
 */

import { getSetting, onSettingsChange } from './settings.js';

let ctx = null;
let master = null;
let musicBus = null;
let sfxBus = null;
let current = null;      // { mood, timer } — the running music loop
let pendingMood = null;  // a mood requested before the context was unlocked
let unlocked = false;    // a user gesture has satisfied the autoplay policy
let recoveryWired = false;

function AudioCtor() {
  return typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
}

/** Build the audio graph on first use. Returns the context, or null if unsupported. */
function ensure() {
  if (ctx) return ctx;
  const AC = AudioCtor();
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  master = ctx.createGain();
  musicBus = ctx.createGain();
  sfxBus = ctx.createGain();
  musicBus.connect(master);
  sfxBus.connect(master);
  master.connect(ctx.destination);
  applyVolumes();
  onSettingsChange((k) => {
    if (k === 'masterVolume' || k === 'musicVolume' || k === 'sfxVolume' || k === 'muted') applyVolumes();
  });
  wireRecovery(ctx);
  // CLONE: the optional recorded sound pack (122 MB of mp3 upstream) is not
  // shipped here, so the fetch is skipped rather than left to fail three times on
  // every boot. Everything you hear is synthesized in this module — 14 SFX
  // one-shots and 9 generative music moods, all Web Audio, no assets. The loader
  // below is kept intact and exported so restoring the pack is a one-line change.
  //   if (!packRequested) { packRequested = true; loadSoundPack().catch(() => {}); }
  void packRequested;
  return ctx;
}

/**
 * Auto-recover from an audio-device / WebAudio-renderer hiccup. Chrome logs
 * "The AudioContext encountered an error from the audio device or the WebAudio
 * renderer" and can drop the context to 'suspended' when the default output
 * device changes, the machine sleeps/wakes, or the audio backend restarts —
 * leaving the game silent with no error we can catch. So once the autoplay
 * policy is satisfied, quietly nudge the context back to 'running' whenever it
 * falls out of it: on its own statechange, when the tab is shown or refocused,
 * and on the next user input. Replays any mood that was deferred while it was
 * down. Wired once; harmless if the context never hiccups.
 */
function wireRecovery(c) {
  if (recoveryWired || !c?.addEventListener) return;
  recoveryWired = true;
  const kick = () => {
    if (!(unlocked && ctx && ctx.state === 'suspended')) return;
    Promise.resolve(ctx.resume?.()).then(() => {
      if (pendingMood) { const m = pendingMood; pendingMood = null; playMusic(m); }
    }, () => { /* still blocked — a later gesture/visibility change retries */ });
  };
  c.addEventListener('statechange', kick);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', kick);
    window.addEventListener('pointerdown', kick, true);
    window.addEventListener('keydown', kick, true);
  }
}

function applyVolumes() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const m = getSetting('muted') ? 0 : getSetting('masterVolume');
  master.gain.setTargetAtTime(m, now, 0.02);
  musicBus.gain.setTargetAtTime(getSetting('musicVolume'), now, 0.02);
  sfxBus.gain.setTargetAtTime(getSetting('sfxVolume'), now, 0.02);
}

/**
 * Resume the context from a user gesture (a click/keypress). Call once early —
 * browsers block audio until the user interacts. Kicks off any music that was
 * requested while still suspended.
 */
export function unlockAudio() {
  const c = ensure();
  if (!c) return false;
  unlocked = true; // autoplay policy satisfied — recovery may auto-resume from now on
  const start = () => {
    if (!pendingMood) return;
    const mood = pendingMood;
    pendingMood = null;
    playMusic(mood);
  };
  // resume() is async: its promise resolves only once the context is actually
  // 'running'. Start the pending mood THEN — calling playMusic synchronously
  // after resume() would still see state 'suspended' and just re-defer it, so
  // the menu music would never start on the very gesture meant to unlock it.
  if (c.state === 'suspended') Promise.resolve(c.resume()).then(start, start);
  else start();
  return true;
}

// ---------------------------------------------------------------------------
// Real sound pack (optional) — decoded clips that OVERRIDE the procedural synth
// ---------------------------------------------------------------------------
//
// If public/sounds/index(.cdn).json lists clips (produced by scripts/gen-sounds
// + upload-sounds), each is decoded into an AudioBuffer keyed by its id. playSfx
// and playMusic prefer a decoded clip and fall back to the procedural synth for
// any id that isn't present — so a partial pack is always safe to ship, exactly
// like the sprite pack. Nothing loads unless a browser AudioContext exists.

const samples = new Map();      // id -> decoded AudioBuffer (SFX eager; music once played)
const musicUrls = new Map();    // music_<mood> -> url, decoded lazily on first play
const musicPending = new Map(); // music_<mood> -> in-flight decode promise (dedupe)
let packRequested = false;

function soundsBase() {
  return (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || './';
}

/**
 * Normalise a raw sound-index doc to a plain `{ id: url }` map. Two shapes:
 *   ["click", …]         → `${base}sounds/<id>.mp3` (a local --reindex list)
 *   { "click": "url" }   → explicit per-id urls (CDN, or `./sounds/lab/<id>.mp3`)
 * Pure (no I/O) so the my-layer merge is unit-testable. Unknown shapes → {}.
 */
export function normalizeSoundIndex(data, base = './') {
  if (Array.isArray(data)) return Object.fromEntries(data.map((id) => [id, `${base}sounds/${id}.mp3`]));
  if (data && typeof data === 'object') return { ...data };
  return {};
}

/**
 * Merge sound-index layers into one `{ id: url }` resolution, LATER layers
 * winning — the audio twin of sprites' mergeIndexLayers: my layer (personal
 * overrides) ▸ accepted pack ▸ [procedural synth, the player's fallback]. Pure.
 */
export function mergeSoundLayers(...layers) {
  return Object.assign({}, ...layers);
}

/**
 * Load + decode the sound pack as the merge of up to three layers (the top of
 * the my-layer ▸ accepted ▸ procedural resolver; procedural is playSfx/playMusic's
 * silent fallback, not a url). Later layers win:
 *   1. ACCEPTED — committed `index.cdn.json` (CDN urls).
 *   2. LOCAL — a git-IGNORED `index.json` (["click", …] → sounds/<id>.mp3), the
 *      reindex gen-music/gen-sounds write; laid OVER the accepted pack so a clip
 *      you just generated locally plays before you promote it (rather than being
 *      shadowed by the committed pack). Absent in production.
 *   3. MY layer — an optional, personal, git-IGNORED `overrides.json` laid ON
 *      TOP: any id it lists shadows the layers below, so a clip accepted into
 *      your own game plays immediately without shipping it.
 * Non-fatal: any clip that 404s or won't decode simply stays procedural. Pass an
 * explicit `{ id: url }` map to bypass the fetch (used by the smoke test).
 */
export async function loadSoundPack(indexOverride = null) {
  if (!ensure()) return;
  let index = indexOverride;
  if (!index) {
    const base = soundsBase();
    // Merge ALL present index layers, later winning: the accepted CDN pack
    // (`index.cdn.json`) ▸ a local `index.json` (git-IGNORED — the dev reindex
    // gen-music/gen-sounds write, so a freshly-generated clip plays before it's
    // promoted, instead of being shadowed by the committed pack) ▸ the personal
    // `overrides.json` (my layer). In production only index.cdn.json is served,
    // so this is a no-op there.
    const layers = [];
    for (const name of ['index.cdn.json', 'index.json', 'overrides.json']) {
      try {
        const res = await fetch(`${base}sounds/${name}`, { cache: 'no-cache' });
        if (res.ok) layers.push(normalizeSoundIndex(await res.json(), base));
      } catch { /* skip a missing/unreadable layer */ }
    }
    index = mergeSoundLayers(...layers); // later layers win: cdn ▸ local ▸ my layer
  }
  if (!index || typeof index !== 'object' || !Object.keys(index).length) {
    console.info('[audio] no sound pack served (public/sounds/index*.json) — using the procedural synth.');
    return;
  }
  // Music tracks are long, so their decoded PCM is heavy — and most moods are
  // never visited in a given session. Decode only the short SFX one-shots up
  // front; register each music_<mood> url and decode it lazily on the first
  // playMusic() that actually needs it (see decodeMusic).
  const entries = Object.entries(index);
  const music = entries.filter(([id]) => id.startsWith('music_'));
  const sfx = entries.filter(([id]) => !id.startsWith('music_'));
  for (const [id, url] of music) musicUrls.set(id, url);
  await Promise.all(sfx.map(async ([id, url]) => {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) return;
      samples.set(id, await ctx.decodeAudioData(await res.arrayBuffer()));
    } catch { /* leave this id procedural */ }
  }));
  console.info(`[audio] sound pack: ${samples.size}/${sfx.length} sfx clip(s) decoded`
    + `${music.length ? `, ${music.length} music track(s) deferred` : ''}`
    + `${samples.size ? ` (${[...samples.keys()].join(', ')})` : ''}.`);
  // If the CURRENTLY playing (procedural) mood now has a real track in the pack,
  // decode it and switch in seamlessly once it lands.
  maybeUpgradeCurrentMusic();
}

/** True if a decoded real clip exists for `id` (used by tests). Music tracks are
 *  decoded lazily, so this is false for a music_<mood> until its first play. */
export function hasSoundSample(id) { return samples.has(id); }

/**
 * Fetch + decode a music_<mood> track on demand, caching the AudioBuffer in
 * `samples` so later plays are instant. Concurrent calls for the same id share
 * one in-flight decode. Resolves to the buffer, or null if the pack has no track
 * for this id (or it 404s / won't decode) — the caller stays on the synth loop.
 */
async function decodeMusic(id) {
  if (samples.has(id)) return samples.get(id);
  if (musicPending.has(id)) return musicPending.get(id);
  const url = musicUrls.get(id);
  if (!url || !ctx) return null;
  const p = (async () => {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) return null;
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      samples.set(id, buf);
      return buf;
    } catch { return null; }
    finally { musicPending.delete(id); }
  })();
  musicPending.set(id, p);
  return p;
}

/**
 * If the mood currently on the generative loop has a real (pack) track, decode
 * it in the background and swap to it seamlessly once ready — the deferred twin
 * of the old "switch on the next bar" hook, now that music decodes lazily.
 */
function maybeUpgradeCurrentMusic() {
  if (!current || current.source) return;     // silent, or already a real track
  const mood = current.mood;
  if (!musicUrls.has(`music_${mood}`)) return;
  decodeMusic(`music_${mood}`).then((buf) => {
    // Guard: the mood may have changed (or a real track already started) while
    // we were decoding — don't clobber a newer loop.
    if (buf && current && !current.source && current.mood === mood) {
      stopMusic();
      playMusic(mood);
    }
  });
}

/** The mood of the music currently playing (the specific one, e.g.
 *  'adventure_castle'), or null when silent — an observability hook for tests. */
export function currentMusicMood() { return current?.mood ?? null; }

/** Fire a decoded clip on a bus; returns the source (so music loops can stop it). */
function playSample(buf, bus, loop = false) {
  if (!ctx) return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = loop;
  src.connect(bus);
  src.start();
  return src;
}

// ---------------------------------------------------------------------------
// SFX — short synthesized one-shots
// ---------------------------------------------------------------------------

function tone({ freq, type = 'sine', dur = 0.12, gain = 0.4, glideTo = null, when = 0, bus = sfxBus }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(bus);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function noise({ dur = 0.15, gain = 0.4, filter = 1400, when = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n); // decaying
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = filter;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(lp);
  lp.connect(g);
  g.connect(sfxBus);
  src.start(t0);
}

const arp = (freqs, { type = 'triangle', step = 0.09, dur = 0.16, gain = 0.3 } = {}) =>
  freqs.forEach((f, i) => tone({ freq: f, type, dur, gain, when: i * step }));

const SFX = {
  click: () => tone({ freq: 660, type: 'square', dur: 0.05, gain: 0.22 }),
  confirm: () => arp([600, 900], { step: 0.06, dur: 0.1, gain: 0.28 }),
  cancel: () => tone({ freq: 420, type: 'sawtooth', dur: 0.14, gain: 0.22, glideTo: 200 }),
  coin: () => arp([988, 1319], { step: 0.05, dur: 0.12, gain: 0.26 }),
  hit: () => { noise({ dur: 0.12, gain: 0.5, filter: 2200 }); tone({ freq: 130, type: 'sine', dur: 0.12, gain: 0.4, glideTo: 60 }); },
  shoot: () => tone({ freq: 900, type: 'square', dur: 0.09, gain: 0.2, glideTo: 300 }),
  magic: () => tone({ freq: 320, type: 'sine', dur: 0.4, gain: 0.3, glideTo: 1200 }),
  build: () => { noise({ dur: 0.1, gain: 0.4, filter: 900 }); tone({ freq: 180, type: 'square', dur: 0.09, gain: 0.22 }); },
  levelup: () => arp([523, 659, 784, 1047], { dur: 0.16, gain: 0.26 }),
  victory: () => arp([523, 659, 784, 1047, 1319], { step: 0.12, dur: 0.24, gain: 0.28 }),
  defeat: () => arp([440, 392, 330, 262], { type: 'sawtooth', step: 0.14, dur: 0.3, gain: 0.26 }),
  // A shimmering whoosh: a rising sweep as you enter, a bright arp as you emerge.
  portal: () => {
    tone({ freq: 260, type: 'sine', dur: 0.28, gain: 0.28, glideTo: 1400 });
    arp([784, 1047, 1319], { type: 'triangle', step: 0.07, dur: 0.14, gain: 0.2 });
  },
  // A soft watery plash for boarding / leaving a boat.
  splash: () => { noise({ dur: 0.22, gain: 0.34, filter: 700 }); tone({ freq: 240, type: 'sine', dur: 0.16, gain: 0.18, glideTo: 120 }); },
  // Unearthing a buried treasure (the Grail dig): a soft shovel-scuff, then a
  // bright rising reveal chime — distinct from the flat `coin` jingle.
  pickup: () => { noise({ dur: 0.14, gain: 0.3, filter: 500 }); arp([784, 1047, 1568], { type: 'sine', step: 0.08, dur: 0.2, gain: 0.24 }); },
  // A hero gains +1 to a primary stat. Reported as a gap: "when a hero collects
  // +1 on any of the stats, to have a distinct sound effect as feedback — we have
  // one for collecting gold." Deliberately NOT `levelup` (a four-note fanfare, and
  // a level is a bigger thing than a point) and not `coin` — a short two-note rise
  // with a bright tail: small, unmistakably good, and cheap to hear often.
  statup: () => { arp([659, 988], { type: 'triangle', step: 0.06, dur: 0.13, gain: 0.26 }); tone({ freq: 1319, type: 'sine', dur: 0.18, gain: 0.14 }); },
  // Visiting a structure that does something for you — an upgrade fort, a
  // mercenary camp, a well. A soft wooden knock into a warm open chord: it reads
  // as "a door opened and something was given", which is what a visit is.
  visit: () => { noise({ dur: 0.09, gain: 0.26, filter: 700 }); arp([392, 523, 659], { type: 'sine', step: 0.07, dur: 0.22, gain: 0.2 }); },
};

/** The SFX ids the synth can play — the built-in fallback layer. Exported so
 *  the manifest test can assert the ordered pack matches (no played-but-missing
 *  id like the historical `pickup` gap, and no manifest id with no synth). */
export const SFX_NAMES = Object.keys(SFX);

/** Play a named sound effect: a real clip if the pack has one, else the synth. */
export function playSfx(name) {
  if (!ensure()) return;
  const buf = samples.get(name);
  if (buf) { try { playSample(buf, sfxBus); return; } catch { /* fall back to synth */ } }
  const fn = SFX[name];
  if (fn) { try { fn(); } catch { /* ignore audio hiccups */ } }
}

// ---------------------------------------------------------------------------
// Music — lightweight generative ambient loops, one per scene mood
// ---------------------------------------------------------------------------

const MOODS = {
  menu:      { root: 220.0, scale: [0, 3, 5, 7, 10], chord: [0, 3, 7], bpm: 58, wave: 'sine', pad: 0.12 },
  adventure: { root: 196.0, scale: [0, 2, 4, 7, 9], chord: [0, 4, 7], bpm: 72, wave: 'triangle', pad: 0.10 },
  combat:    { root: 164.8, scale: [0, 2, 3, 7, 8], chord: [0, 3, 7], bpm: 108, wave: 'sawtooth', pad: 0.08 },
  town:      { root: 261.6, scale: [0, 4, 5, 7, 11], chord: [0, 4, 7], bpm: 64, wave: 'sine', pad: 0.11 },
  // The scene moods added with the Mureka score. Each gets its own generative
  // flavour so it's distinct even before a real music_<mood>.mp3 is generated.
  underground: { root: 130.8, scale: [0, 2, 3, 7, 8], chord: [0, 3, 7], bpm: 52, wave: 'sine', pad: 0.11 },     // low, brooding cavern
  naval:       { root: 220.0, scale: [0, 2, 4, 7, 9], chord: [0, 4, 7], bpm: 84, wave: 'triangle', pad: 0.10 }, // rolling, breezy
  victory:     { root: 261.6, scale: [0, 4, 7, 9, 11], chord: [0, 4, 7], bpm: 100, wave: 'triangle', pad: 0.12 }, // bright major fanfare
  defeat:      { root: 146.8, scale: [0, 1, 3, 5, 8], chord: [0, 3, 7], bpm: 46, wave: 'sine', pad: 0.11 },     // slow, mournful minor
};

/**
 * The generative-loop key that stands in for `mood` when no real track is
 * loaded: the mood itself if it has its own loop, else — for a faction variant
 * (adventure_<f> / town_<f>) — the matching BASE loop. This is prefix-driven so
 * EVERY faction, present or future, is audible and correctly flavoured (a town
 * mood borrows the town loop, an adventure mood the adventure loop) even before
 * its own Mureka track exists; a real music_<mood>.mp3 always wins over this.
 * Anything else degrades to the adventure loop (never silence). Pure —
 * unit-tested in tests/music-moods.
 */
export function generativeMoodFor(mood) {
  if (MOODS[mood]) return mood;
  if (typeof mood === 'string') {
    if (mood.startsWith('town_')) return 'town';
    if (mood.startsWith('adventure_')) return 'adventure';
  }
  return 'adventure';
}

const noteFreq = (root, semi) => root * Math.pow(2, semi / 12);

function playChord(m, when, dur) {
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  for (const semi of m.chord) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = m.wave;
    osc.frequency.value = noteFreq(m.root, semi - 12); // an octave down for a pad
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(m.pad, t0 + dur * 0.45); // slow swell
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(musicBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

/** Start (or switch to) the generative loop for a scene mood. */
export function playMusic(mood) {
  const c = ensure();
  if (!c) { pendingMood = mood; return; }
  // Autoplay policy leaves a freshly-built context 'suspended', where
  // currentTime is FROZEN. Every note the generative loop (or a looping sample)
  // schedules then stacks at that same frozen timestamp and fires in ONE
  // dissonant blast the instant the user first clicks — a blast that grows the
  // longer the menu idled. Defer until unlocked; unlockAudio() replays
  // pendingMood on resume.
  if (c.state === 'suspended') { pendingMood = mood; return; }
  if (current && current.mood === mood) return;
  stopMusic();
  // A real looping track for this mood wins over the generative loop — when it's
  // already decoded. The first play of a pack mood finds it undecoded and starts
  // on the synth loop below, then swaps in via maybeUpgradeCurrentMusic().
  const track = samples.get(`music_${mood}`);
  if (track) {
    const source = playSample(track, musicBus, true);
    current = { mood, source };
    return;
  }
  const m = MOODS[generativeMoodFor(mood)];
  const barSec = (60 / m.bpm) * 4;
  const tick = () => {
    // The interval keeps firing if the context is suspended AFTER the loop
    // started (e.g. the tab is backgrounded), which would pile notes onto the
    // frozen clock all over again. Only schedule while genuinely running.
    if (!ctx || ctx.state !== 'running') return;
    try {
      playChord(m, 0, barSec * 1.15);
      // A couple of wandering melody notes over the bar (cosmetic randomness).
      for (let i = 0; i < 2; i++) {
        if (Math.random() < 0.55) {
          const semi = m.scale[Math.floor(Math.random() * m.scale.length)] + 12;
          tone({ freq: noteFreq(m.root, semi), type: m.wave, dur: 0.35, gain: m.pad * 0.6,
            when: i * (barSec / 2) + 0.1, bus: musicBus });
        }
      }
    } catch { /* ignore */ }
  };
  tick();
  const timer = setInterval(tick, barSec * 1000);
  current = { mood, timer };
  // If the pack has a real track for this mood, decode it now and swap in when
  // ready — deferred so we never block the mood change on a fetch/decode.
  maybeUpgradeCurrentMusic();
}

export function stopMusic() {
  if (current) {
    if (current.timer) clearInterval(current.timer);
    if (current.source) { try { current.source.stop(); } catch { /* already stopped */ } current.source.disconnect?.(); }
    current = null;
  }
}
