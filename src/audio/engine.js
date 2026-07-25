// ============================================================================
// THE ELEVATOR — Phase 1
// src/audio/engine.js — owner of the audio engine contract (R-ENG).
//
// This module is the FOUNDATION every other audio part codes against. It owns
// the lazy AudioContext singleton, the fixed signal topology, gesture unlock,
// re-entrant ducking, mute/persistence, and the voice subscriber registry.
// It imports NOTHING (no ./sfx, no ./ambient, no external). (R-ENG-60)
//
// Topology (the SOLE path to destination): (R-ENG-02/03/04)
//   sfxBus ─┐
//           ├─> masterGain (0.8 at rest unmuted) -> compressor -> ctx.destination
//   ambientBus ─┘
//
// Compressor params: threshold -24, knee 30, ratio 12, attack 0.003, release 0.25. (R-ENG-58)
//
// Exports:
//   getCtx()            — lazy singleton AudioContext (webkit fallback); null if absent.
//   sfxBus()            — stable GainNode feeding masterGain (one-shot sources).
//   ambientBus()        — stable GainNode feeding masterGain (bed sources).
//   ensureRunning()     — resume() if suspended; idempotent; never throws.
//   unlock()            — one pointerdown + one keydown; first fires ensureRunning, removes both.
//   noiseBuffer()       — memoized 2s mono white-noise AudioBuffer.
//   duck(durationSec)   — re-entrant -6dB dip/hold/recover on ambientBus via gain ramps only.
//   setMuted(bool)      — ramp masterGain 0.0/0.8; persist 'lift.audio.muted'.
//   isMuted()           — cached boolean; seeded from localStorage at module-eval.
//   onVoice(cb)         — subscribe to voice lines; returns an unsub for ONLY that cb.
//   emitVoice(line)     — fan a voice line to all subscribers (sink for sfx.voice, clause 44).
//
// Robustness: if Web Audio is absent, every public fn degrades to a safe no-op
// stub; isMuted() still reflects localStorage; NO exception ever reaches a caller.
// ============================================================================

// ---------------------------------------------------------------------------
// R-ENG-22 / R-ENG-21 — persisted mute state, read ONCE at module-eval.
// No AudioContext is touched here (R-ENG-01: never construct at module-eval).
// ---------------------------------------------------------------------------

/** localStorage key for persisted mute. (R-ENG-21) */
const MUTE_KEY = 'lift.audio.muted';

/**
 * Read the persisted mute flag defensively. Returns false when localStorage is
 * unavailable (private mode / SSR / node) or throws. (R-ENG-22)
 * @returns {boolean} true iff the stored value is exactly the string 'true'.
 */
function _readPersistedMuted() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      return localStorage.getItem(MUTE_KEY) === 'true';
    }
  } catch (_e) { /* storage may throw (SecurityError) — treat as unmuted */ }
  return false;
}

/**
 * Cached mute boolean. Seeded from localStorage at module-eval and kept
 * consistent for the life of the page. (R-ENG-22)
 * @type {boolean}
 */
let _muted = _readPersistedMuted();

// ---------------------------------------------------------------------------
// Lazy audio graph. Nothing here is constructed until first getCtx()/use.
// (R-ENG-01, R-ENG-05, R-ENG-07)
// ---------------------------------------------------------------------------

/** @type {AudioContext|null} lazy singleton context. */
let _ctx = null;
/** @type {GainNode|null} master bus, 0.8 at rest unmuted. (R-ENG-03) */
let _master = null;
/** @type {DynamicsCompressorNode|null} final limiter to destination. (R-ENG-58) */
let _comp = null;
/** @type {GainNode|null} one-shot bus. (R-ENG-02) */
let _sfx = null;
/** @type {GainNode|null} ambient bed bus. (R-ENG-02) */
let _ambient = null;
/** @type {AudioBuffer|null} memoized 2s mono white noise. (R-ENG-17) */
let _noise = null;

/**
 * Build the audio graph exactly once, lazily. Resolves the context constructor
 * via window.AudioContext || window.webkitAudioContext (Safari). Returns null
 * when Web Audio is entirely absent so callers can no-op safely. (R-ENG-01/05)
 *
 * Wires the sole signal path: sfx & ambient -> master -> compressor -> dest.
 * (R-ENG-02/03/04/58)
 * @returns {AudioContext|null}
 */
function _graph() {
  if (_ctx) return _ctx;

  const AC = (typeof window !== 'undefined' && window)
    ? (window.AudioContext || window.webkitAudioContext)
    : null;
  if (!AC) return null; // Web Audio absent -> everything degrades to stubs.

  try {
    _ctx = new AC();

    _master = _ctx.createGain();
    // Honor persisted mute at rest: 0.0 if muted else 0.8. (R-ENG-03/20/22)
    _master.gain.value = _muted ? 0.0 : 0.8;

    _comp = _ctx.createDynamicsCompressor();
    _comp.threshold.value = -24; // dB (R-ENG-58)
    _comp.knee.value = 30;       // dB
    _comp.ratio.value = 12;
    _comp.attack.value = 0.003;  // s
    _comp.release.value = 0.25;  // s

    _sfx = _ctx.createGain();
    _sfx.gain.value = 1.0;

    _ambient = _ctx.createGain();
    _ambient.gain.value = 1.0; // unity at rest; duck() dips this. (R-ENG-12/13)

    // The SOLE path to destination. Nothing else connects to ctx.destination.
    _sfx.connect(_master);
    _ambient.connect(_master);
    _master.connect(_comp);
    _comp.connect(_ctx.destination);
  } catch (_e) {
    // Construction failed — reset to a clean absent state so callers no-op.
    _ctx = null;
    _master = null;
    _comp = null;
    _sfx = null;
    _ambient = null;
    _noise = null;
  }
  return _ctx;
}

// ---------------------------------------------------------------------------
// Public API — context + buses
// ---------------------------------------------------------------------------

/**
 * Lazy singleton AudioContext. Uses window.AudioContext || window.webkitAudioContext
 * for Safari. NEVER constructed at module-eval. Returns null if Web Audio is
 * absent. Repeated calls return the SAME instance. (R-ENG-01/05)
 * @returns {AudioContext|null}
 */
export function getCtx() {
  return _graph();
}

/**
 * Stable singleton GainNode feeding masterGain. One-shot sources connect here.
 * Returns null when Web Audio is absent (safe stub). (R-ENG-02/04)
 * @returns {GainNode|null}
 */
export function sfxBus() {
  _graph();
  return _sfx;
}

/**
 * Stable singleton GainNode feeding masterGain. Ambient bed sources connect
 * here. duck() automates this node's gain. Returns null when Web Audio is
 * absent (safe stub). (R-ENG-02/04)
 * @returns {GainNode|null}
 */
export function ambientBus() {
  _graph();
  return _ambient;
}

// ---------------------------------------------------------------------------
// Public API — lifecycle / gesture unlock
// ---------------------------------------------------------------------------

/**
 * Resume the context if it is suspended. Idempotent and never throws. Safe to
 * call before the context exists (no-op). Swallows the resume() promise reject.
 * (R-ENG-06)
 * @returns {void}
 */
export function ensureRunning() {
  try {
    const ctx = _graph();
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (_e) { /* never propagate */ }
}

/**
 * Internal unlock arming state: 'idle' -> 'armed' -> 'done'. Guarantees repeat
 * unlock() calls never add duplicate listeners. (R-ENG-10)
 * @type {'idle'|'armed'|'done'}
 */
let _unlockState = 'idle';

/** @type {((e:Event)=>void)|null} pointerdown handler ref (for removal). */
let _onPointer = null;
/** @type {((e:Event)=>void)|null} keydown handler ref (for removal). */
let _onKey = null;

/**
 * Attach exactly ONE pointerdown + ONE keydown listener on document. On the
 * first of either, call ensureRunning() then remove BOTH. An internal armed
 * flag makes repeat calls safe (no duplicate listeners, no re-arm after fire).
 * Adds ZERO UI/DOM. (R-ENG-08/09/10/11)
 * @returns {void}
 */
export function unlock() {
  try {
    if (_unlockState !== 'idle') return; // already armed or already done.
    if (typeof document === 'undefined' || !document ||
        typeof document.addEventListener !== 'function') return;

    _unlockState = 'armed';

    const fire = () => {
      if (_unlockState === 'done') return;
      _unlockState = 'done';
      // ensureRunning() FIRST, then remove both. (R-ENG-09)
      ensureRunning();
      try { document.removeEventListener('pointerdown', _onPointer, true); } catch (_e) {}
      try { document.removeEventListener('keydown', _onKey, true); } catch (_e) {}
    };

    _onPointer = fire;
    _onKey = fire;
    // Capture phase so the very first gesture is caught early.
    document.addEventListener('pointerdown', _onPointer, true);
    document.addEventListener('keydown', _onKey, true);
  } catch (_e) { /* never propagate */ }
}

// ---------------------------------------------------------------------------
// Public API — noise cache
// ---------------------------------------------------------------------------

/**
 * Memoize ONE 2-second, 1-channel white-noise AudioBuffer at ctx.sampleRate on
 * first call; return the SAME instance thereafter. Returns null when Web Audio
 * is absent. (R-ENG-17)
 * @returns {AudioBuffer|null}
 */
export function noiseBuffer() {
  const ctx = _graph();
  if (!ctx) return null;
  if (_noise) return _noise;
  try {
    const len = Math.max(1, Math.floor(ctx.sampleRate * 2)); // 2 seconds.
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    _noise = buf;
  } catch (_e) {
    _noise = null;
  }
  return _noise;
}

// ---------------------------------------------------------------------------
// Public API — ducking
// ---------------------------------------------------------------------------

/** -6 dB expressed linearly: 10^(-6/20) ≈ 0.5012. (R-ENG-12) */
const DUCK_DIP = 0.5012;
/** Dip ramp time in seconds. (R-ENG-20a) */
const DUCK_DIP_T = 0.03;
/** Recover ramp time in seconds. (R-ENG-20a) */
const DUCK_REC_T = 0.2;

/**
 * Dip ambientBus().gain to ~0.501 (-6dB) over 30ms, hold for durationSec, then
 * recover to 1.0 over 200ms. GAIN RAMPS ONLY — never real sidechain compression.
 * (R-ENG-12/13/14)
 *
 * RE-ENTRANT: schedules against ctx.currentTime. cancelScheduledValues(now)
 * clears only FUTURE events (>= now), so past events are never overwritten and
 * the in-flight value is re-anchored with setValueAtTime(g.value, now) to avoid
 * any cancellation glitch. Overlapping ducks therefore extend the hold from
 * "now" and always settle back to 1.0. (R-ENG-15)
 * @param {number} [durationSec=0.5] hold time in seconds (clamped to >= 0).
 * @returns {void}
 */
export function duck(durationSec = 0.5) {
  try {
    const ctx = _graph();
    if (!ctx || !_ambient) return;
    const g = _ambient.gain;

    const now = ctx.currentTime;
    const hold = (typeof durationSec === 'number' && durationSec > 0) ? durationSec : 0;
    const dipEnd = now + DUCK_DIP_T;
    const holdUntil = dipEnd + hold;
    const recoverEnd = holdUntil + DUCK_REC_T;

    // Drop only future events (>= now); past events stay -> no past overwrite.
    g.cancelScheduledValues(now);
    // Re-anchor at the current value so removing the in-flight ramp can't jump.
    g.setValueAtTime(g.value, now);
    // Dip -> hold -> recover, all via gain ramps. (R-ENG-14)
    g.linearRampToValueAtTime(DUCK_DIP, dipEnd);
    g.setValueAtTime(DUCK_DIP, holdUntil);
    g.linearRampToValueAtTime(1.0, recoverEnd);
  } catch (_e) { /* never propagate */ }
}

// ---------------------------------------------------------------------------
// Public API — mute + persistence
// ---------------------------------------------------------------------------

/**
 * Set mute state. true -> ramp masterGain.gain to 0.0; false -> ramp to 0.8.
 * Ramped (linear over 50ms) to avoid zipper noise. Persists to localStorage key
 * 'lift.audio.muted' and updates the cached flag regardless of whether the
 * AudioContext exists. Does NOT force-create the context: if the graph is not
 * yet built, the persisted value is honored at build time. (R-ENG-20/21)
 * @param {boolean} flag
 * @returns {void}
 */
export function setMuted(flag) {
  const m = !!flag;
  _muted = m;

  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.setItem(MUTE_KEY, m ? 'true' : 'false');
    }
  } catch (_e) { /* storage may be unavailable — cache still updated */ }

  // Only ramp if the graph already exists; never force construction here.
  try {
    if (_ctx && _master) {
      const g = _master.gain;
      const now = _ctx.currentTime;
      const target = m ? 0.0 : 0.8;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(target, now + 0.05); // no zipper.
    }
  } catch (_e) { /* never propagate */ }
}

/**
 * Cached mute boolean. Initial value is read from localStorage at module-eval
 * and stays consistent thereafter. Does NOT require the AudioContext.
 * (R-ENG-22)
 * @returns {boolean}
 */
export function isMuted() {
  return _muted;
}

// ---------------------------------------------------------------------------
// Public API — voice subscriber registry
// ---------------------------------------------------------------------------

/**
 * Subscriber registry for voice lines. A Set so each cb is stored once and an
 * unsub removes ONLY that cb. (clause 44 / R-ENG voice fan-out)
 * @type {Set<function(string):void>}
 */
const _voiceSubs = new Set();

/**
 * Subscribe to voice line text. Each cb is invoked with the line string. The
 * returned unsub() removes ONLY this subscriber. A throwing subscriber is
 * isolated and never blocks others (see emitVoice). (clause 44)
 * @param {function(string):void} cb
 * @returns {function():void} unsub
 */
export function onVoice(cb) {
  if (typeof cb !== 'function') return () => {};
  _voiceSubs.add(cb);
  return () => { _voiceSubs.delete(cb); };
}

/**
 * Fan a voice line out to all current subscribers. Snapshots the registry so
 * add/remove during emission is safe, and wraps each cb in try/catch so a
 * throwing subscriber cannot block the rest. No subscriber => no error.
 * This is the sink sfx.voice() uses to publish lines (clause 44). (R-ENG)
 * @param {string} line
 * @returns {void}
 */
export function emitVoice(line) {
  try {
    const subs = Array.from(_voiceSubs);
    for (let i = 0; i < subs.length; i++) {
      try { subs[i](line); } catch (_e) { /* isolate throwing subscriber */ }
    }
  } catch (_e) { /* never propagate */ }
}
