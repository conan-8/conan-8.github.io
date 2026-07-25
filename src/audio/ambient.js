// ============================================================================
// src/audio/ambient.js
// THE ELEVATOR — Phase 1 synthesized sound kit (zero audio files, all synth)
//
// Owner role: AMBIENT BED BUILDER — per-floor room-tone beds.
//
// Rules:
//   R-AMB-46  lobby bed  : near-silence + lowpassed noise (-40 dB) + distant
//                          creak recurring every 8-20 s (re-jittered/cycle)
//   R-AMB-47  cab bed    : 50 Hz mains hum + soft cable groan recurring
//                          every 10-25 s (re-jittered each cycle)
//   R-AMB-48  library / workshop / studio : INTENTIONAL STUBS — silence with
//                          one faint identifying texture; same {stop()}
//                          contract so later per-floor phases fill them in
//                          through THIS module's start/stop/stopAll API
//                          (floors must NOT build bypass graphs)
//   R-AMB-49  every stop() disconnects/stops ALL nodes and clears ALL
//                          timers/intervals the bed created (no leak across
//                          start/stop cycles)
//   R-AMB-50  start(<unknown>) → ONE console.warn + no-op { stop(){} },
//                          never throws
//   R-AMB-51  stop(name) is idempotent
//   R-AMB-52  stopAll() stops every active bed
//
// Topology: every bed sums into a bed-local GainNode wired to
//           engine.ambientBus() — nothing else downstream. All noise reuses
//           engine.noiseBuffer() (memoized 2 s mono, loop=true); this module
//           NEVER allocates its own white-noise buffer.
// Policy  : sustained beds never call engine.duck — ducking is one-shot
//           driven via sfx.play, not ambient. This module imports ONLY
//           ./engine.js and never imports ./sfx.js.
// ============================================================================

import * as engine from './engine.js';

// === Internal registry ======================================================

/**
 * Live beds keyed by floor name. At most ONE bed per name: re-starting a
 * name stops/replaces the previous bed so no nodes can leak (R-AMB-49).
 * @type {Map<string, {stop: Function}>}
 */
const active = new Map();

/**
 * Unknown bed names already warned about, so repeated misuse produces exactly
 * ONE console.warn per name (R-AMB-50), never a throw, never a spam loop.
 * @type {Set<string>}
 */
const warnedUnknown = new Set();

// === Bed lifecycle plumbing =================================================

/**
 * @typedef {Object} Bed
 * @property {string} name            floor/bed name (registry key)
 * @property {AudioContext} ctx       engine context snapshot at build time
 * @property {GainNode} out           bed-local summing gain → ambientBus()
 * @property {Set<AudioScheduledSourceNode>} sources  sustained sources
 * @property {Set<AudioNode>} nodes                   all persistent nodes
 * @property {Set<number>} timers                     live setTimeout ids
 * @property {Set<{srcs: Array<AudioScheduledSourceNode>, nodes: Array<AudioNode>}>} oneshots
 * @property {boolean} dead           true once teardown has run
 */

/**
 * Open a fresh bed: bed-local GainNode wired straight into the engine's
 * ambient bus. All bed audio sums through `bed.out` (R-AMB topology).
 * @param {string} name  floor/bed name
 * @returns {Bed} empty bed scaffold (caller adds sources, then finishBed())
 */
function openBed(name) {
  const ctx = engine.getCtx();
  const out = ctx.createGain();
  out.gain.value = 1.0; // bed level; per-texture gains carry the dB values
  out.connect(engine.ambientBus());
  return {
    name,
    ctx,
    out,
    sources: new Set(),
    nodes: new Set([out]),
    timers: new Set(),
    oneshots: new Set(),
    dead: false,
  };
}

/**
 * Register a built bed under its name and hand back the public handle.
 * The handle's stop() tears the bed down AND self-removes it from the
 * registry (guarded so a stale handle can't evict its replacement).
 * @param {Bed} bed fully-wired bed scaffold
 * @returns {{stop: Function}} public bed handle
 */
function finishBed(bed) {
  const handle = {
    stop() {
      closeBed(bed);
      if (active.get(bed.name) === handle) active.delete(bed.name);
    },
  };
  active.set(bed.name, handle);
  return handle;
}

/**
 * Full synchronous teardown (R-AMB-49): clear every timer first (so no new
 * one-shots can spawn), then stop + disconnect every transient and sustained
 * node, then drop all references. Deliberately synchronous — no deferred
 * disconnect timers exist to leak; beds sit at <= -26 dB so the hard cut is
 * click-free in practice. Idempotent via the `dead` flag.
 * @param {Bed} bed bed to tear down
 * @returns {void}
 */
function closeBed(bed) {
  if (bed.dead) return;
  bed.dead = true;

  for (const id of bed.timers) clearTimeout(id);
  bed.timers.clear();

  const t = bed.ctx.currentTime;

  for (const shot of bed.oneshots) {
    for (const s of shot.srcs) { try { s.stop(t); } catch { /* already ended */ } }
    for (const n of shot.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
  }
  bed.oneshots.clear();

  for (const s of bed.sources) { try { s.stop(t); } catch { /* not started/ended */ } }
  for (const n of bed.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
  bed.sources.clear();
  bed.nodes.clear();
}

/**
 * Jittered recurrence scheduler: fires `fire()`, then re-draws a FRESH random
 * interval for the next cycle (8-20 s / 10-25 s per bed — the interval is
 * re-jittered every cycle, never a fixed metronome). Every timeout id is
 * tracked on the bed so closeBed() clears the whole chain (R-AMB-49).
 * @param {Bed} bed    owning bed (chain dies with it)
 * @param {number} minS minimum wait, seconds
 * @param {number} maxS maximum wait, seconds
 * @param {Function} fire zero-arg callback invoked each cycle
 * @returns {void}
 */
function recur(bed, minS, maxS, fire) {
  if (bed.dead) return;
  const ms = (minS + Math.random() * (maxS - minS)) * 1000;
  const id = setTimeout(() => {
    bed.timers.delete(id);
    if (bed.dead) return;
    fire();
    recur(bed, minS, maxS, fire); // fresh draw each cycle
  }, ms);
  bed.timers.add(id);
}

/**
 * Spawn a short-lived event graph (creak / groan) on the bed. The event
 * self-disconnects via its anchor source's `onended`; if the bed is stopped
 * mid-event, closeBed() stops + disconnects it too (R-AMB-49).
 * @param {Bed} bed   owning bed
 * @param {Function} build () => {srcs, nodes} freshly wired to bed.out
 * @returns {void}
 */
function spawnOneShot(bed, build) {
  if (bed.dead) return;
  const shot = build();
  bed.oneshots.add(shot);
  const anchor = shot.srcs[0];
  if (anchor) {
    anchor.onended = () => {
      bed.oneshots.delete(shot);
      for (const n of shot.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
    };
  }
}

/**
 * Route the engine's memoized noise buffer (looped — NEVER re-allocated here)
 * through a filter chain at a faint bed level, into bed.out.
 * @param {Bed} bed             owning bed
 * @param {Array<AudioNode>} filters shape filters, source order → out order
 * @param {number} level        linear gain of the texture
 * @returns {GainNode} the texture's gain node (for optional modulation)
 */
function noiseLoopInto(bed, filters, level) {
  const src = bed.ctx.createBufferSource();
  src.buffer = engine.noiseBuffer(); // shared 2 s mono buffer, looped
  src.loop = true;
  let node = src;
  for (const f of filters) { node.connect(f); node = f; }
  const g = bed.ctx.createGain();
  g.gain.value = level;
  node.connect(g);
  g.connect(bed.out);
  src.start();
  bed.sources.add(src);
  for (const f of filters) bed.nodes.add(f);
  bed.nodes.add(g);
  return g;
}

// === One-shot event voices ==================================================

/**
 * A distant metal creak: strained sawtooth bending downward with a slow
 * wobble, rung through a resonant bandpass, then muffled by a lowpass so it
 * reads as "three floors away". Self-cleaning via onended.
 * @returns {{srcs: Array<AudioScheduledSourceNode>, nodes: Array<AudioNode>}}
 */
function distantCreak(bed) {
  const { ctx, out } = bed;
  const t = ctx.currentTime;
  const dur = 0.45 + Math.random() * 0.75;
  const f0 = 170 + Math.random() * 280;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f0 * (0.5 + Math.random() * 0.25), t + dur);

  const wobble = ctx.createOscillator();
  wobble.type = 'sine';
  wobble.frequency.value = 4 + Math.random() * 5;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = f0 * 0.05;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(osc.frequency);

  const ring = ctx.createBiquadFilter();
  ring.type = 'bandpass';
  ring.frequency.value = 480 + Math.random() * 520;
  ring.Q.value = 9 + Math.random() * 7;

  const muffle = ctx.createBiquadFilter(); // distance eats the highs
  muffle.type = 'lowpass';
  muffle.frequency.value = 1100 + Math.random() * 400;

  const env = ctx.createGain();
  const peak = 0.02 + Math.random() * 0.025; // faint: it is far away
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + dur * 0.3);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(ring);
  ring.connect(muffle);
  muffle.connect(env);
  env.connect(out);

  const until = t + dur + 0.05;
  osc.start(t); osc.stop(until);
  wobble.start(t); wobble.stop(until);

  return { srcs: [osc, wobble], nodes: [osc, wobble, wobbleDepth, ring, muffle, env] };
}

/**
 * A soft cable groan under load: triangle fundamental + sine sub-octave,
 * both sagging in pitch as the cable "gives", damped by a low lowpass.
 * Self-cleaning via onended.
 * @returns {{srcs: Array<AudioScheduledSourceNode>, nodes: Array<AudioNode>}}
 */
function cableGroan(bed) {
  const { ctx, out } = bed;
  const t = ctx.currentTime;
  const dur = 0.9 + Math.random() * 0.8;
  const f0 = 65 + Math.random() * 60;

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + dur);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(f0 / 2, t);
  sub.frequency.exponentialRampToValueAtTime(f0 * 0.31, t + dur);
  const subGain = ctx.createGain();
  subGain.gain.value = 0.5;

  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 300;
  damp.Q.value = 1.2;

  const env = bed.ctx.createGain();
  const peak = 0.035 + Math.random() * 0.02; // soft: through two walls
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + dur * 0.35);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(damp);
  sub.connect(subGain);
  subGain.connect(damp);
  damp.connect(env);
  env.connect(out);

  const until = t + dur + 0.05;
  osc.start(t); osc.stop(until);
  sub.start(t); sub.stop(until);

  return { srcs: [osc, sub], nodes: [osc, sub, subGain, damp, env] };
}

// === Floor beds =============================================================

/**
 * R-AMB-46 — LOBBY: near-silence. Looped engine noise lowpassed to a room
 * tone at -40 dB (gain 0.01), plus a random distant creak recurring every
 * 8-20 s with the interval re-drawn each cycle.
 * @returns {{stop: Function}} bed handle
 */
function bedLobby() {
  const bed = openBed('lobby');

  const lp = bed.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 240;
  lp.Q.value = 0.7;
  noiseLoopInto(bed, [lp], 0.01); // -40 dB room tone

  recur(bed, 8, 20, () => spawnOneShot(bed, distantCreak));

  return finishBed(bed);
}

/**
 * R-AMB-47 — CAB: 50 Hz mains hum (with a faint 100 Hz partial so it reads
 * as fluorescent-ballast hum, not a test tone), plus a soft cable groan
 * recurring every 10-25 s with the interval re-drawn each cycle.
 * @returns {{stop: Function}} bed handle
 */
function bedCab() {
  const bed = openBed('cab');
  const { ctx, out } = bed;

  const fund = ctx.createOscillator();
  fund.type = 'sine';
  fund.frequency.value = 50; // mains fundamental
  const fundGain = ctx.createGain();
  fundGain.gain.value = 0.05;
  fund.connect(fundGain);
  fundGain.connect(out);

  const harm = ctx.createOscillator();
  harm.type = 'sine';
  harm.frequency.value = 100; // 2nd harmonic, keeps it feeling electric
  const harmGain = ctx.createGain();
  harmGain.gain.value = 0.014;
  harm.connect(harmGain);
  harmGain.connect(out);

  fund.start();
  harm.start();
  bed.sources.add(fund);
  bed.sources.add(harm);
  bed.nodes.add(fundGain);
  bed.nodes.add(harmGain);

  recur(bed, 10, 25, () => spawnOneShot(bed, cableGroan));

  return finishBed(bed);
}

/**
 * R-AMB-48 — LIBRARY: **INTENTIONAL STUB** — silence plus one faint
 * identifying texture (a distant ventilation hush: looped engine noise,
 * bandpassed, barely there). Exposes the exact same {stop()} contract as
 * full beds; a later per-floor phase fills this in by routing through this
 * module's start/stop/stopAll API — floors must NOT build bypass graphs.
 * @returns {{stop: Function}} bed handle
 */
function bedLibrary() {
  const bed = openBed('library');

  const bp = bed.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 420;
  bp.Q.value = 0.6;
  noiseLoopInto(bed, [bp], 0.004); // distant ventilation hush

  return finishBed(bed);
}

/**
 * R-AMB-48 — WORKSHOP: **INTENTIONAL STUB** — silence plus one faint
 * identifying texture (far-off machinery idle: looped engine noise,
 * lowpassed, breathing slowly via a 0.13 Hz LFO on its gain). Same {stop()}
 * contract; filled in later through this module's start/stop/stopAll API —
 * floors must NOT build bypass graphs.
 * @returns {{stop: Function}} bed handle
 */
function bedWorkshop() {
  const bed = openBed('workshop');
  const { ctx } = bed;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 140;
  lp.Q.value = 0.8;
  const idle = noiseLoopInto(bed, [lp], 0.006); // far-off machinery idle

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.13; // slow breathing of the idle machine
  const depth = ctx.createGain();
  depth.gain.value = 0.002;
  lfo.connect(depth);
  depth.connect(idle.gain);
  lfo.start();
  bed.sources.add(lfo);
  bed.nodes.add(depth);

  return finishBed(bed);
}

/**
 * R-AMB-48 — STUDIO: **INTENTIONAL STUB** — silence plus one faint
 * identifying texture (monitor hiss: looped engine noise, highpassed,
 * whisper level). Same {stop()} contract; filled in later through this
 * module's start/stop/stopAll API — floors must NOT build bypass graphs.
 * @returns {{stop: Function}} bed handle
 */
function bedStudio() {
  const bed = openBed('studio');

  const hp = bed.ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1400;
  hp.Q.value = 0.5;
  noiseLoopInto(bed, [hp], 0.003); // monitor hiss

  return finishBed(bed);
}

/**
 * Bed builders keyed by floor name — the complete accepted vocabulary.
 * @type {Record<string, Function>}
 */
const BUILDERS = {
  lobby: bedLobby,
  cab: bedCab,
  library: bedLibrary,
  workshop: bedWorkshop,
  studio: bedStudio,
};

// === Public dispatchers =====================================================

/**
 * Start the ambient bed for a floor.
 *
 * Accepted names: `lobby`, `cab`, `library`, `workshop`, `studio`.
 * - Unknown name → exactly ONE console.warn (per name) + inert
 *   `{ stop(){} }` handle; never throws (R-AMB-50).
 * - Engine context unavailable → inert `{ stop(){} }` handle; never throws.
 * - Re-starting an already-active name stops/replaces the old bed first, so
 *   nodes and timers never stack up (R-AMB-49).
 *
 * Every bed routes through engine.ambientBus() and reuses
 * engine.noiseBuffer() for noise (looped, never re-allocated here).
 * Sustained beds never call engine.duck — ducking is one-shot driven via
 * sfx.play, not ambient.
 *
 * @param {string} name floor/bed name
 * @returns {{stop: Function}} handle whose stop() fully tears the bed down
 */
export function start(name) {
  const ctx = engine.getCtx();
  if (!ctx) return { stop() {} }; // audio unavailable: inert handle, no throw

  const build = BUILDERS[name];
  if (!build) {
    if (!warnedUnknown.has(name)) {
      warnedUnknown.add(name);
      console.warn(`[ambient] unknown bed "${name}" — returning no-op handle`);
    }
    return { stop() {} }; // R-AMB-50: warn once, never throw
  }

  const prev = active.get(name);
  if (prev) prev.stop(); // replace, never double-layer (no leaked nodes)

  try {
    return build();
  } catch (err) {
    console.warn(`[ambient] bed "${name}" failed to build:`, err);
    return { stop() {} };
  }
}

/**
 * Stop the named bed if it is active; idempotent no-op otherwise
 * (R-AMB-51). Safe with any input, including names never started and
 * names whose context is gone — throws nothing.
 * @param {string} name floor/bed name
 * @returns {void}
 */
export function stop(name) {
  const handle = active.get(name);
  if (!handle) return; // idempotent no-op
  handle.stop(); // tears down + self-removes from the registry
}

/**
 * Stop every currently-active bed (R-AMB-52) and empty the registry.
 * Each handle's stop() already performs full node + timer teardown, so
 * after stopAll() nothing scheduled by this module remains. Throws nothing.
 * @returns {void}
 */
export function stopAll() {
  for (const handle of [...active.values()]) handle.stop();
  active.clear();
}

/**
 * Module namespace (project convention): `ambient.start/stop/stopAll`.
 * @type {{start: Function, stop: Function, stopAll: Function}}
 */
export const ambient = { start, stop, stopAll };

export default ambient;
