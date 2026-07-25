// ============================================================================
// src/audio/sfx.js — THE ELEVATOR · Phase 1 · synthesized one-shot sound kit
// ----------------------------------------------------------------------------
// Owner role : SFX part (task_id "sfx") — all interactive/mechanical sounds.
// Rules      : R-SFX 16, 25–45, 61 (see spec/reconciled.md)
//
//   R-SFX 16     every sfx.play(<one-shot>) calls engine.duck(<nominal sec>);
//                whir()/voice() manage their own ducking (single call, never
//                per-frame).
//   R-SFX 25-41  one-shot recipes: clunk, ding (+arrive +5% / depart -5%),
//                clack (pooled, ×20/s safe), doorShudder, buttonChunk,
//                bloop (pure 600 Hz, -18 dB), speakerCrackle.
//   R-SFX 33-36  whir() sustained cable/motor loop { setPitch, stop }.
//   R-SFX 42-45  voice() = crackle + syllabic square-wave mumble; the
//                intentional NO-ASSET speech substitute (zero TTS, zero
//                audio files — everything below is synthesized).
//   R-SFX 61     clack ×20/s must not distort (node pool + engine compressor).
//
// Contract  : imports ONLY './engine.js'. NEVER imports './ambient.js'.
//             Every source terminates at engine.sfxBus() and nothing else
//             downstream. ALL noise is engine.noiseBuffer() (memoized 2 s
//             mono buffer) — this module NEVER allocates its own white noise.
//             No classes, no frameworks, fire-and-forget (never awaits).
//             When engine.getCtx() is null every export degrades to a silent
//             no-op / safe stub and throws nothing.
// ============================================================================

import * as engine from './engine.js';

// === NOMINAL DUCK DURATIONS (R-SFX 16) ======================================
// Seconds passed to engine.duck() for each one-shot name. These are the
// "nominal durationSec" values fixed by the part contract.
const NOMINAL_DUCK_SEC = Object.freeze({
  clunk: 0.18,
  ding: 1.8,
  clack: 0.04,
  doorShudder: 0.6,
  buttonChunk: 0.09,
  bloop: 0.05,
  speakerCrackle: 0.3,
  ding_arrive: 1.8,
  ding_depart: 1.8,
});

// === CLACK NODE POOL (R-SFX 30-32, 61) ======================================
// Six prebuilt bandpass->gain + tick->gain voice chains, reused round-robin.
// 20 triggers/second recycle the same six slots: bounded node count, no
// unbounded graph growth, and the engine compressor tames the sum. Only the
// single-use BufferSource/Oscillator atoms are rebuilt per hit (Web Audio
// sources can start exactly once); the expensive filter/gain chains persist.
const CLACK_POOL_SIZE = 6;

/** @type {?{ctx: AudioContext, next: number, slots: Array<Object>}} */
let clackPool = null;

/**
 * Lazily build (or rebuild for a new context) the clack voice pool.
 * Slot chains are wired straight to engine.sfxBus() and stay connected for
 * the lifetime of the context — retriggering only swaps the source atoms.
 * @param {AudioContext} ctx live context from engine.getCtx()
 * @returns {{ctx: AudioContext, next: number, slots: Array<Object>}} the pool
 */
function getClackPool(ctx) {
  if (clackPool && clackPool.ctx === ctx) return clackPool;
  const bus = engine.sfxBus();
  const slots = [];
  for (let i = 0; i < CLACK_POOL_SIZE; i++) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000; // sits inside the 2–4 kHz clack band
    bp.Q.value = 1.5;          // ~2 kHz bandwidth → covers 2–4 kHz
    const bpGain = ctx.createGain();
    bpGain.gain.value = 0;
    bp.connect(bpGain);
    bpGain.connect(bus);

    const tickGain = ctx.createGain();
    tickGain.gain.value = 0;
    tickGain.connect(bus);

    slots.push({ bp, bpGain, tickGain, src: null, tick: null });
  }
  clackPool = { ctx, next: 0, slots };
  return clackPool;
}

// === SHARED SYNTH HELPERS (internal — not exported) =========================

/**
 * Linear-interpolate a {t0,v0,t1,v1} automation segment at time `now`.
 * Lets us resume a ramp deterministically without relying on the
 * (implementation-dependent) AudioParam.value getter mid-automation.
 * @param {{t0:number,v0:number,t1:number,v1:number}} seg
 * @param {number} now context time
 * @returns {number} interpolated value
 */
function segValueAt(seg, now) {
  if (now <= seg.t0) return seg.v0;
  if (now >= seg.t1) return seg.v1;
  return seg.v0 + (seg.v1 - seg.v0) * ((now - seg.t0) / (seg.t1 - seg.t0));
}

/**
 * Deep mechanical thunk: 60 Hz sine burst + lowpassed noise snap, ~180 ms.
 * Internal workhorse — reused at staggered velocities by doorShudder.
 * @param {AudioContext} ctx live context
 * @param {number} t start time (ctx.currentTime base)
 * @param {number} velocity 0..1 impact strength (scales both layers)
 */
function clunkAt(ctx, t, velocity) {
  const bus = engine.sfxBus();

  // Layer 1 — 60 Hz sine body.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(60, t);
  const og = ctx.createGain();
  osc.connect(og);
  og.connect(bus);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime(0.9 * velocity, t + 0.008);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.start(t);
  osc.stop(t + 0.19);

  // Layer 2 — noise snap through a 420 Hz lowpass (metal-on-metal contact).
  const snap = ctx.createBufferSource();
  snap.buffer = engine.noiseBuffer(); // shared memoized buffer — never our own
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 420;
  const ng = ctx.createGain();
  snap.connect(lp);
  lp.connect(ng);
  ng.connect(bus);
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.linearRampToValueAtTime(0.5 * velocity, t + 0.004);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  snap.start(t);
  snap.stop(t + 0.09);
}

/** Brass bell partial table (R-SFX 27-29). Slight mutual detune (±0.3–0.4 %)
 *  breaks the synthetic "perfect chord" sheen for a struck-metal realism. */
const DING_PARTIALS = Object.freeze([
  Object.freeze({ freq: 880, gain: 0.5, detune: 1.0 }),
  Object.freeze({ freq: 1320, gain: 0.3, detune: 1.003 }),
  Object.freeze({ freq: 2093, gain: 0.18, detune: 0.996 }),
]);

/**
 * Brass bell: sine partials at 880/1320/2093 Hz (× pitchScale), exponential
 * decay over ~1.8 s. ding_arrive/ding_depart are this with pitchScale 1.05 /
 * 0.95 (R-SFX 41).
 * @param {AudioContext} ctx live context
 * @param {number} t start time
 * @param {number} pitchScale multiplier applied to every partial (1 = concert)
 */
function dingAt(ctx, t, pitchScale) {
  const bus = engine.sfxBus();
  for (const p of DING_PARTIALS) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(p.freq * pitchScale * p.detune, t);
    const g = ctx.createGain();
    osc.connect(g);
    g.connect(bus);
    g.gain.setValueAtTime(p.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8); // ~1.8 s exp decay
    osc.start(t);
    osc.stop(t + 1.85);
  }
}

/**
 * Split-flap flip through the pooled voice chain (R-SFX 30-32, 61).
 * Fully synchronous fire-and-forget: NEVER awaits, allocates only the two
 * single-use source atoms, and round-robins six slots so ×20/s stays bounded.
 * @param {AudioContext} ctx live context
 * @param {number} t start time
 */
function clackAt(ctx, t) {
  const pool = getClackPool(ctx);
  const slot = pool.slots[pool.next % CLACK_POOL_SIZE];
  pool.next = (pool.next + 1) % CLACK_POOL_SIZE;

  // — Bandpassed noise burst, 2–4 kHz, ~40 ms (recycles the slot's chain).
  if (slot.src) {
    try { slot.src.stop(t); } catch { /* already ended — fine */ }
    try { slot.src.disconnect(); } catch { /* already gone — fine */ }
  }
  const src = ctx.createBufferSource();
  src.buffer = engine.noiseBuffer(); // shared buffer, zero per-call noise alloc
  src.connect(slot.bp);
  slot.src = src;
  // Jitter the center inside the 2–4 kHz band so rapid hits sound mechanical,
  // not machine-gunned.
  slot.bp.frequency.setValueAtTime(2600 + Math.random() * 800, t);
  const bg = slot.bpGain.gain;
  bg.cancelScheduledValues(t);
  bg.setValueAtTime(0.85, t);
  bg.exponentialRampToValueAtTime(0.0001, t + 0.04); // ~40 ms burst
  src.start(t);
  src.stop(t + 0.05);

  // — 200 Hz tick (the flap's pivot knock), ~30 ms.
  if (slot.tick) {
    try { slot.tick.stop(t); } catch { /* already ended — fine */ }
    try { slot.tick.disconnect(); } catch { /* already gone — fine */ }
  }
  const tick = ctx.createOscillator();
  tick.type = 'triangle';
  tick.frequency.setValueAtTime(200, t);
  tick.connect(slot.tickGain);
  slot.tick = tick;
  const tg = slot.tickGain.gain;
  tg.cancelScheduledValues(t);
  tg.setValueAtTime(0.5, t);
  tg.exponentialRampToValueAtTime(0.0001, t + 0.03);
  tick.start(t);
  tick.stop(t + 0.035);
}

/**
 * Elevator-door shudder, ~600 ms: low rumble noise bed + three staggered
 * clunk variants at decreasing velocity (1.0 → 0.55 → 0.3) (R-SFX 37).
 * @param {AudioContext} ctx live context
 * @param {number} t start time
 */
function doorShudderAt(ctx, t) {
  const bus = engine.sfxBus();

  // Rumble bed — looped-shared noise, 110 Hz lowpass, 600 ms swell + decay.
  const rumble = ctx.createBufferSource();
  rumble.buffer = engine.noiseBuffer();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 110;
  const rg = ctx.createGain();
  rumble.connect(lp);
  lp.connect(rg);
  rg.connect(bus);
  rg.gain.setValueAtTime(0.0001, t);
  rg.gain.linearRampToValueAtTime(0.55, t + 0.05);
  rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  rumble.start(t);
  rumble.stop(t + 0.62);

  // Three staggered clunk variants, decreasing velocity.
  clunkAt(ctx, t, 1.0);
  clunkAt(ctx, t + 0.16, 0.55);
  clunkAt(ctx, t + 0.34, 0.3);
}

/**
 * Heavy button depress: 120 Hz square blip + broadband noise click, ~90 ms
 * (R-SFX 38).
 * @param {AudioContext} ctx live context
 * @param {number} t start time
 */
function buttonChunkAt(ctx, t) {
  const bus = engine.sfxBus();

  // Square blip — the mechanism's thud.
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(120, t);
  const og = ctx.createGain();
  osc.connect(og);
  og.connect(bus);
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime(0.45, t + 0.005);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  osc.start(t);
  osc.stop(t + 0.095);

  // Noise click — highpassed for the plastic snap.
  const click = ctx.createBufferSource();
  click.buffer = engine.noiseBuffer();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 900;
  const cg = ctx.createGain();
  click.connect(hp);
  hp.connect(cg);
  cg.connect(bus);
  cg.gain.setValueAtTime(0.0001, t);
  cg.gain.linearRampToValueAtTime(0.35, t + 0.003);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  click.start(t);
  click.stop(t + 0.04);
}

/**
 * Hover tick: PURE 600 Hz sine, 50 ms, -18 dB (gain 0.126). No sweep, no
 * filter, no modulation — deliberately quiet and unobtrusive (R-SFX 39).
 * @param {AudioContext} ctx live context
 * @param {number} t start time
 */
function bloopAt(ctx, t) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, t); // pure — frequency never moves
  const g = ctx.createGain();
  osc.connect(g);
  g.connect(engine.sfxBus());
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.126, t + 0.004); // -18 dB peak
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05); // 50 ms total
  osc.start(t);
  osc.stop(t + 0.055);
}

/** Sputtering envelope steps for the crackle — deterministic, ~25 ms apart. */
const CRACKLE_STEPS = Object.freeze([
  0.32, 0.1, 0.28, 0.06, 0.3, 0.14, 0.24, 0.08, 0.2, 0.05, 0.12, 0.03,
]);

/**
 * Loudspeaker static: ~300 ms of bandpassed noise with a sputtering gain
 * envelope (R-SFX 40). Used directly by play('speakerCrackle') AND as the
 * lead-in of voice() — voice calls this internal, never play(), so ducking
 * stays single-sourced.
 * @param {AudioContext} ctx live context
 * @param {number} t start time
 * @param {number} [velocity=1] level scale (voice() uses 0.8 under the mumble)
 */
function crackleAt(ctx, t, velocity = 1) {
  const src = ctx.createBufferSource();
  src.buffer = engine.noiseBuffer();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600;
  bp.Q.value = 0.6;
  const g = ctx.createGain();
  src.connect(bp);
  bp.connect(g);
  g.connect(engine.sfxBus());

  const gg = g.gain;
  gg.setValueAtTime(0.0001, t);
  for (let i = 0; i < CRACKLE_STEPS.length; i++) {
    gg.setValueAtTime(Math.max(0.0001, CRACKLE_STEPS[i] * velocity), t + i * 0.025);
  }
  gg.exponentialRampToValueAtTime(0.0001, t + 0.3);
  src.start(t);
  src.stop(t + 0.31);
}

// === ONE-SHOT DISPATCH TABLE =================================================
/** @type {Record<string, (ctx: AudioContext, t: number) => void>} */
const ONE_SHOTS = {
  clunk: (ctx, t) => clunkAt(ctx, t, 1),
  ding: (ctx, t) => dingAt(ctx, t, 1),
  ding_arrive: (ctx, t) => dingAt(ctx, t, 1.05), // +5 % (R-SFX 41)
  ding_depart: (ctx, t) => dingAt(ctx, t, 0.95), // -5 % (R-SFX 41)
  clack: (ctx, t) => clackAt(ctx, t),
  doorShudder: (ctx, t) => doorShudderAt(ctx, t),
  buttonChunk: (ctx, t) => buttonChunkAt(ctx, t),
  bloop: (ctx, t) => bloopAt(ctx, t),
  speakerCrackle: (ctx, t) => crackleAt(ctx, t, 1),
};

/** Names already warned about — unknown names warn ONCE, then stay silent. */
const warnedUnknown = new Set();

// === PUBLIC API ==============================================================

/**
 * Fire a synthesized one-shot by name. Fire-and-forget: fully synchronous,
 * never awaits, never throws.
 *
 * Names: clunk, ding, clack, doorShudder, buttonChunk, bloop, speakerCrackle,
 * ding_arrive, ding_depart. Every one-shot calls engine.duck() with its
 * nominal duration (R-SFX 16) so the ambience dips -6 dB while it speaks,
 * and routes exclusively into engine.sfxBus().
 *
 * Robustness: unknown name → ONE console.warn (deduped) + no-op.
 * engine.getCtx() null → silent no-op. clack is pool-backed, safe at ×20/s.
 *
 * @param {string} name one of the nine one-shot names above
 * @returns {void}
 */
export function play(name) {
  if (!Object.prototype.hasOwnProperty.call(ONE_SHOTS, name)) {
    const key = String(name);
    if (!warnedUnknown.has(key)) {
      warnedUnknown.add(key);
      console.warn(`[sfx] play(): unknown one-shot "${key}" — ignored.`);
    }
    return;
  }
  const ctx = engine.getCtx();
  if (!ctx) return; // audio unavailable → silent no-op, never throw
  try {
    engine.ensureRunning();
    engine.duck(NOMINAL_DUCK_SEC[name]); // R-SFX 16 — every one-shot ducks
    ONE_SHOTS[name](ctx, ctx.currentTime);
  } catch (err) {
    console.warn('[sfx] play(): synth error swallowed:', err);
  }
}

/**
 * Start the SUSTAINED cable/motor loop (NOT a one-shot) (R-SFX 33-36).
 *
 * Graph: sawtooth gliding 80 → 140 Hz + looped noise with amplitude
 * modulation (6.5 Hz LFO on a lowpassed noise voice), mixed at a modest
 * ~0.15 level into engine.sfxBus(). whir manages its OWN ducking: one
 * engine.duck() dip at spin-up — it never calls duck per frame.
 *
 * @returns {{setPitch(rate: number): void, stop(fadeMs?: number): void}}
 *   - setPitch(rate): re-targets the frequency glide LIVE (140 Hz × rate)
 *     without restarting any node; rate ≤ 0 / non-finite is ignored.
 *   - stop(fadeMs=200): ramps output gain to 0 over fadeMs, then stops and
 *     disconnects ALL nodes (clean teardown, no leak). A second stop() is a
 *     no-op.
 *   When audio is unavailable, returns inert stubs: {setPitch(){},stop(){}}.
 */
export function whir() {
  const ctx = engine.getCtx();
  if (!ctx) return { setPitch() {}, stop() {} }; // safe stub, never throw

  let stopped = false;
  try {
    engine.ensureRunning();
    const bus = engine.sfxBus();
    const t = ctx.currentTime;
    const GLIDE_SEC = 1.6;
    const SPINUP_SEC = 0.25;
    const LEVEL = 0.15;

    // Output stage — the single node touching sfxBus.
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(bus);

    // Voice 1 — sawtooth gliding 80 → 140 Hz.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, t);
    osc.frequency.linearRampToValueAtTime(140, t + GLIDE_SEC);
    const oscMix = ctx.createGain();
    oscMix.gain.value = 0.5;
    osc.connect(oscMix);
    oscMix.connect(out);

    // Voice 2 — looped noise, lowpassed, amplitude-modulated by a slow LFO.
    const noise = ctx.createBufferSource();
    noise.buffer = engine.noiseBuffer(); // shared buffer, looped — no new noise
    noise.loop = true;
    const nFilt = ctx.createBiquadFilter();
    nFilt.type = 'lowpass';
    nFilt.frequency.value = 800;
    const am = ctx.createGain();
    am.gain.value = 0.5; // AM base level
    noise.connect(nFilt);
    nFilt.connect(am);
    am.connect(out);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 6.5; // cable-strain wobble
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.35; // AM depth: 0.15–0.85 of the noise voice
    lfo.connect(lfoDepth);
    lfoDepth.connect(am.gain);

    // Spin-up fade to the modest ~0.15 operating level.
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(LEVEL, t + SPINUP_SEC);

    noise.start(t);
    osc.start(t);
    lfo.start(t);

    // Own ducking (R-SFX 16): ONE dip for the spin-up moment — never per-frame.
    engine.duck(2.0);

    // Deterministic automation bookkeeping (no AudioParam.value guessing).
    let glide = { t0: t, v0: 80, t1: t + GLIDE_SEC, v1: 140 };
    let level = { t0: t, v0: 0, t1: t + SPINUP_SEC, v1: LEVEL };

    return {
      /**
       * Re-target the glide LIVE to 140 Hz × rate without restarting nodes.
       * @param {number} rate pitch multiplier (> 0)
       * @returns {void}
       */
      setPitch(rate) {
        if (stopped || !Number.isFinite(rate) || rate <= 0) return;
        try {
          const now = ctx.currentTime;
          const cur = segValueAt(glide, now);
          const target = 140 * rate;
          const f = osc.frequency;
          f.cancelScheduledValues(now);
          f.setValueAtTime(cur, now);
          f.linearRampToValueAtTime(target, now + GLIDE_SEC);
          glide = { t0: now, v0: cur, t1: now + GLIDE_SEC, v1: target };
        } catch { /* closed context — degrade silently */ }
      },

      /**
       * Fade out over fadeMs then stop + disconnect EVERY node (no leak).
       * Idempotent: a second stop() is a no-op.
       * @param {number} [fadeMs=200] fade length in milliseconds
       * @returns {void}
       */
      stop(fadeMs = 200) {
        if (stopped) return; // second stop() → no-op
        stopped = true;
        try {
          const ms = Number.isFinite(fadeMs) ? fadeMs : 200;
          const dur = Math.max(0.01, ms / 1000);
          const now = ctx.currentTime;
          const cur = segValueAt(level, now);
          out.gain.cancelScheduledValues(now);
          out.gain.setValueAtTime(Math.max(0.0001, cur), now);
          out.gain.linearRampToValueAtTime(0.0001, now + dur);
          const endT = now + dur + 0.05;
          try { osc.stop(endT); } catch { /* not started — fine */ }
          try { noise.stop(endT); } catch { /* not started — fine */ }
          try { lfo.stop(endT); } catch { /* not started — fine */ }
          setTimeout(() => {
            for (const n of [osc, noise, lfo, lfoDepth, nFilt, am, oscMix, out]) {
              try { n.disconnect(); } catch { /* already detached — fine */ }
            }
          }, ms + 80);
        } catch { /* closed context — degrade silently */ }
      },
    };
  } catch (err) {
    console.warn('[sfx] whir(): start error swallowed:', err);
    stopped = true;
    return { setPitch() {}, stop() {} };
  }
}

/**
 * Estimate syllable count as vowel-group count (a e i o u y), minimum 1.
 * @param {string} text announcement line
 * @returns {number} ≥ 1
 */
function countSyllables(text) {
  const groups = String(text).toLowerCase().match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

/**
 * Fan the line out to every engine.onVoice subscriber via the engine's
 * voice emitter (the dispatch counterpart of onVoice). No emitter and no
 * subscriber ⇒ no error (R-SFX 44).
 * @param {string} line announcement text
 */
function fanVoiceLine(line) {
  const emit =
    (typeof engine.emitVoice === 'function' && engine.emitVoice) ||
    (typeof engine.fireVoice === 'function' && engine.fireVoice) ||
    (typeof engine.notifyVoice === 'function' && engine.notifyVoice) ||
    null;
  if (!emit) return;
  try {
    emit(line);
  } catch (err) {
    console.warn('[sfx] voice(): subscriber fan-out error swallowed:', err);
  }
}

/**
 * Lo-fi cabin announcement — the INTENTIONAL NO-ASSET SPEECH SUBSTITUTE.
 * (R-SFX 42-45)
 *
 * No TTS engine and no audio files exist in this project; instead the PA
 * "speaks" in pure synthesis: speakerCrackle FIRST (the amp waking up), then
 * a warbly filtered SQUARE-wave mumble whose rhythmic gain bumps match the
 * SYLLABLE COUNT of `line` — one bump per syllable (vowel-group estimate,
 * min 1). A slow LFO wobbles the lowpass cutoff for the worn-speaker warble.
 *
 * Ducking: voice() manages its OWN ducking with a single engine.duck() call
 * spanning crackle + mumble + tail (R-SFX 16) — it does not call play(), so
 * nothing double-ducks.
 *
 * Caption fan-out: as the mumble begins (~300 ms in), the line is fanned to
 * every engine.onVoice subscriber so the UI can render it (soundcheck overlay
 * and later chrome/speaker.js subscribe identically). No subscriber ⇒ no
 * error. Audio unavailable ⇒ silent no-op, never throws.
 *
 * @param {string} line announcement text (syllable count drives the rhythm)
 * @returns {void}
 */
export function voice(line) {
  const ctx = engine.getCtx();
  if (!ctx) return; // audio unavailable → silent no-op, never throw
  try {
    engine.ensureRunning();
    const text = String(line == null ? '' : line);
    const syllables = countSyllables(text);

    const CRACKLE_SEC = 0.3;
    const BUMP_SEC = 0.14; // one mumble bump per syllable
    const GAP_SEC = 0.05;
    const mumbleSec = syllables * (BUMP_SEC + GAP_SEC);
    const totalSec = CRACKLE_SEC + mumbleSec + 0.2;

    // Own ducking (R-SFX 16): one call covering the whole announcement.
    engine.duck(totalSec);

    const t0 = ctx.currentTime;

    // 1) speakerCrackle FIRST (R-SFX 40) — internal call, single-sourced duck.
    crackleAt(ctx, t0, 0.8);

    // 2) Warbly filtered square mumble — bump count === syllable count.
    const start = t0 + CRACKLE_SEC;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 750;
    filt.Q.value = 1.5;
    const warble = ctx.createOscillator();
    warble.type = 'sine';
    warble.frequency.value = 5.3; // slow worn-speaker warble
    const warbleDepth = ctx.createGain();
    warbleDepth.gain.value = 220; // ±220 Hz around the 750 Hz cutoff
    warble.connect(warbleDepth);
    warbleDepth.connect(filt.frequency);
    const g = ctx.createGain();
    osc.connect(filt);
    filt.connect(g);
    g.connect(engine.sfxBus());

    const gg = g.gain;
    gg.setValueAtTime(0.0001, t0);
    for (let i = 0; i < syllables; i++) {
      const bt = start + i * (BUMP_SEC + GAP_SEC);
      // Deterministic per-syllable pitch wander: mumble, not monotone.
      osc.frequency.setValueAtTime(120 + ((i * 53) % 60), bt);
      gg.setValueAtTime(0.0001, bt);
      gg.linearRampToValueAtTime(0.28, bt + 0.02);
      gg.exponentialRampToValueAtTime(0.0001, bt + BUMP_SEC);
    }
    const endT = start + mumbleSec + 0.05;
    osc.start(start);
    osc.stop(endT);
    warble.start(start);
    warble.stop(endT);

    // 3) Fan the line to onVoice subscribers as the mumble begins (R-SFX 44).
    setTimeout(() => fanVoiceLine(text), Math.round(CRACKLE_SEC * 1000));
  } catch (err) {
    console.warn('[sfx] voice(): synth error swallowed:', err);
  }
}
