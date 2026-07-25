// ============================================================================
// THE ELEVATOR — Phase 2
// src/scenes/lobby.js — THE LOBBY scene (rules R2–R38 of Phase 2).
//
// Exports:
//   createScene(deps) -> { el, enter, leave, destroy }
//
// deps = { state, motion } exactly (the frozen Phase 0 call site in main.js).
// sfx, ambient and SITE are imported directly (R6).
//
// Seam contract (FROZEN v1 — identical in the CSS part):
//   - DOM skeleton built byte-for-byte as specified below (R41).
//   - State classes set ONLY here, at the frozen moments (R42):
//       .lobby.is-called            t+0 (plaque click — stops the sheen)
//       .lobby-elevator.is-revealed t+300ms
//       .lobby-indicator.is-lit     t+1500ms
//       .lobby-indicator.is-spinning  during split-flap spins only
//       .lobby-call.is-live         t+2800ms (+ disabled = false)
//       .lobby-call.is-pressed      user press OR auto at t+4800ms
//       .lobby-elevator.doors-open  t+5000ms
//   - Custom props set ONLY here (R43): --lx/--ly (-1..1, default 0) on the
//     .lobby root per frame; per-mote --dx/--dy/--dur/--delay inline.
//   - Animation ownership (R44): CSS owns every @keyframes/transition. This
//     module owns ONLY: per-frame inline transform on .lobby-light, per-frame
//     --lx/--ly on the root (CSS maps them to .lobby-frame-shadow via calc —
//     we NEVER touch .lobby-frame-shadow.style), .lobby-flap textContent
//     swaps, class toggles, and all timers.
//   - TIMING mirrors the CSS tokens exactly (R46): clack = --dur-clack (90),
//     doorTotal = --dur-door (1400), frameSlide = --dur-frame (1200).
//
// Timeline (absolute, deterministic — R29): every sequence step is a timeout
// at a fixed offset from the plaque click; identical constants and order on
// every load and every replay. Handoff (R28/R30): voice() then, same tick,
// state.go('DOORS_OPENING') followed by state.go('CAB') — GRAPH.LOBBY is
// 'DOORS_OPENING', so go('CAB') is never the first transition.
// ============================================================================

import * as sfx from '../audio/sfx.js';
import * as ambient from '../audio/ambient.js';
import { SITE } from '../content.js';

// === TIMING (R9) ============================================================
// Single source for ALL sequence timing — ms from plaque click unless noted.
// No sequence-timing literal appears anywhere else in this file.
const TIMING = Object.freeze({
  clunk: 0,             // t+0: clunk + camera shudder + .is-called
  reveal: 300,          // t+300: panel/frame reveal + dust motes
  indicatorOn: 1500,    // t+1500: indicator flickers lit + split-flap spin
  buttonLive: 2800,     // t+2800: call button arms
  whir: 3000,           // t+3000: cable whir starts, pitch ramps, flap counts
  buttonAuto: 4800,     // t+4800: call button auto-depresses if unpressed
  doors: 5000,          // t+5000: doorShudder + whir fade + doors open
  handoff: 6400,        // t+6400: voice + go('DOORS_OPENING') + go('CAB')
  shudder: 300,         // camera shudder duration
  frameSlide: 1200,     // mirror of --dur-frame (CSS-owned transition)
  flickerGap: 120,      // mirror of the CSS flicker dip spacing
  flickerCount: 3,      // mirror of the CSS flicker dip count
  spin: 1200,           // split-flap settle spin duration
  clack: 90,            // mirror of --dur-clack: one flap change per 90ms
  doorTotal: 1400,      // mirror of --dur-door (CSS-owned keyframes)
  doorSixty: 500,       // mirror: left door reaches 60% travel
  doorStall: 150,       // mirror: left door stall at 60%
  doorRightScale: 0.85, // mirror: right door duration scale (uneven doors)
  whirRamp: 2000,       // whir pitch ramp-up as the car approaches
  depressDown: 80,      // mirror: call button depress (CSS transition)
  depressUp: 200,       // mirror: call button spring back (CSS transition)
  lerp: 0.06,           // light-tracking interpolation factor per frame
  idleMs: 500,          // cursor idle threshold — skip frames beyond it
  particles: 20,        // dust mote count at reveal
  particleLife: 2500,   // mote lifetime (CSS keyframe duration)
});

// === SPLIT-FLAP INDICATOR (R22/R23 — inline, Phase-3-extractable) ===========
// Self-contained factory over the two .lobby-flap cells. The clack sound is
// an injected dependency; Phase 3 lifts this function into chrome/indicator.js
// with minimal diff. Exposes set(char, {spin}) and countThrough([chars]) ->
// Promise. Single-char values render right-aligned with a blank leading slot
// ('L' -> [' ', 'L']).
const FLAP_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function createSplitFlap(cells, { clackMs, spinMs, onClack }) {
  const timers = new Set();
  let runToken = 0; // bumping the token cancels every in-flight run

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  /** Render a value across the two cells, right-aligned, uppercased. */
  function render(value) {
    const raw = String(value == null ? '' : value).toUpperCase();
    const body = raw.length > 2 ? raw.slice(-2) : raw.padStart(2, ' ');
    cells[0].textContent = body[0];
    cells[1].textContent = body[1];
  }

  function scramble(len) {
    let out = '';
    for (let i = 0; i < len; i++) {
      out += FLAP_GLYPHS[(Math.random() * FLAP_GLYPHS.length) | 0];
    }
    return out;
  }

  function clack() {
    if (onClack) onClack();
  }

  /**
   * set(char, {spin}) — render char; with spin:true, rattle through random
   * glyphs one change per clackMs, decelerating over ~spinMs, then settle on
   * char. Resolves when settled (immediately without spin).
   */
  function set(value, options) {
    cancel();
    const spin = !!(options && options.spin);
    if (!spin) {
      render(value);
      return Promise.resolve();
    }
    const token = runToken;
    return new Promise((resolve) => {
      // Decelerating schedule: interval_i = clackMs * (1 + i * 0.35),
      // accumulated until the run spans ~spinMs.
      let at = 0;
      let i = 0;
      while (at < spinMs) {
        at += clackMs * (1 + i * 0.35);
        i += 1;
        later(() => {
          if (token !== runToken) return;
          render(scramble(2));
          clack();
        }, at);
      }
      later(() => {
        if (token !== runToken) return;
        render(value);
        resolve();
      }, at + clackMs);
    });
  }

  /**
   * countThrough([chars]) — walk the flap through each value in order: three
   * rapid clack-steps per transition (clack each), the third landing on the
   * target. Resolves after the final settle.
   */
  function countThrough(values) {
    cancel();
    const token = runToken;
    const list = Array.isArray(values) ? values.slice() : [values];
    return new Promise((resolve) => {
      let at = 0;
      for (const value of list) {
        for (let k = 0; k < 3; k++) {
          at += clackMs;
          const lands = k === 2;
          later(() => {
            if (token !== runToken) return;
            render(lands ? value : scramble(2));
            clack();
          }, at);
        }
        at += clackMs * 2; // mechanical breath between transitions
      }
      later(() => {
        if (token !== runToken) return;
        resolve();
      }, at);
    });
  }

  /** Cancel every pending step; unresolved promises simply never resolve. */
  function cancel() {
    runToken += 1;
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }

  return { set, countThrough, cancel, render };
}

// === THE LOBBY SCENE ========================================================

export function createScene(deps) {
  // --- Frozen DOM skeleton (R41 — byte-for-byte) ----------------------------
  const el = document.createElement('section');
  el.className = 'scene lobby';
  el.innerHTML = `
  <div class="lobby-wall"></div>
  <div class="lobby-light"><div class="lobby-cone"></div><div class="lobby-dust"></div></div>
  <h1 class="lobby-name brass-text"></h1>
  <p class="lobby-tagline"></p>
  <div class="lobby-elevator">
    <div class="lobby-frame-shadow"></div>
    <div class="lobby-frame">
      <div class="lobby-indicator" aria-hidden="true"><span class="lobby-flap"></span><span class="lobby-flap"></span></div>
      <div class="lobby-glow"></div>
      <div class="lobby-doors">
        <div class="lobby-door lobby-door--left"></div>
        <div class="lobby-door lobby-door--right"></div>
      </div>
    </div>
    <button class="lobby-call" type="button" aria-label="Press the call button" disabled><span class="lobby-call-halo"></span></button>
  </div>
  <button class="plaque lobby-plaque" type="button" aria-label="Call the elevator"><span class="lobby-plaque-bloom"></span><span class="lobby-plaque-label">PRESS TO CALL ELEVATOR</span></button>`;

  const lightEl = el.querySelector('.lobby-light');
  const dustEl = el.querySelector('.lobby-dust');
  const nameEl = el.querySelector('.lobby-name');
  const taglineEl = el.querySelector('.lobby-tagline');
  const elevatorEl = el.querySelector('.lobby-elevator');
  const indicatorEl = el.querySelector('.lobby-indicator');
  const flapCells = el.querySelectorAll('.lobby-flap');
  const callBtn = el.querySelector('.lobby-call');
  const plaqueBtn = el.querySelector('.lobby-plaque');

  // Lettering comes from content.js — never hardcoded (R2/R15/R16).
  nameEl.textContent = SITE.name;
  taglineEl.textContent = SITE.tagline;

  // --- Instance state (closure-local; the FSM edge is the structural
  //     debounce — state.js exposes no current-state getter to scenes) ------
  let started = false;   // plaque trigger guard (R19) — one run per instance
  let pressed = false;   // call button one-shot flag (R24)
  let whirHandle = null; // retained for cleanup (R26/R35)
  let ambientHandle = null;

  // --- Owned resources: timers, tweens, listeners (R8/R35) ------------------
  const timers = new Set();
  const tweens = new Set();
  const listeners = [];

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }

  function runTween(opts) {
    const t = deps.motion.tween(opts);
    tweens.add(t);
    const drop = () => tweens.delete(t);
    t.then(drop, drop);
    return t;
  }

  function cancelTweens() {
    for (const t of tweens) {
      if (t && typeof t.cancel === 'function') t.cancel();
    }
    tweens.clear();
  }

  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function unlistenAll() {
    for (const [target, type, fn, opts] of listeners) {
      target.removeEventListener(type, fn, opts);
    }
    listeners.length = 0;
  }

  // --- Split-flap instance (clack sound injected — R23) ---------------------
  const flap = createSplitFlap(flapCells, {
    clackMs: TIMING.clack,
    spinMs: TIMING.spin,
    onClack: () => sfx.play('clack'),
  });
  flap.render(''); // dark, empty cells until the indicator lights

  // --- Light tracking (R12/R14/R32) -----------------------------------------
  // One rAF loop lerps .lobby-light's inline transform toward the current
  // input target at TIMING.lerp/frame and mirrors the normalized vector into
  // --lx/--ly on the .lobby root (CSS maps those onto the pre-blurred
  // .lobby-frame-shadow). Frames are skipped while the cursor is idle.
  // Input priority: cursor > device orientation > autonomous drift.
  let rafId = 0;
  let loopRunning = false;
  let mode = 'idle'; // 'cursor' | 'orientation' | 'drift'
  let targetX = 0;
  let targetY = 0;
  let lightX = 0;
  let lightY = 0;
  let lastInput = 0;
  let cursorSeen = false;
  let orientTried = false;
  let orientSeen = false;

  const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

  function applyLight(lx, ly) {
    el.style.setProperty('--lx', lx.toFixed(4));
    el.style.setProperty('--ly', ly.toFixed(4));
    const w = el.clientWidth || window.innerWidth || 1;
    const h = el.clientHeight || window.innerHeight || 1;
    lightEl.style.transform =
      `translate3d(${(lx * w * 0.16).toFixed(1)}px, ${(ly * h * 0.12).toFixed(1)}px, 0)`;
  }

  function wake() {
    if (loopRunning || deps.motion.REDUCED) return; // R14: no loop, ever
    loopRunning = true;
    rafId = requestAnimationFrame(loop);
  }

  function loop(now) {
    loopRunning = false;
    let keep = false;
    if (mode === 'drift') {
      // Slow autonomous wander (JS-driven — CSS owns nothing on .lobby-light).
      // One full figure per (particleLife * 4) ms — TIMING-derived.
      const phase = (now / (TIMING.particleLife * 4)) * Math.PI * 2;
      targetX = Math.sin(phase) * 0.45;
      targetY = Math.sin(phase * 0.63 + 1.7) * 0.35;
      keep = true;
    } else if (now - lastInput <= TIMING.idleMs) {
      keep = true; // idle beyond TIMING.idleMs -> skip frames (loop sleeps)
    }
    if (!keep) return;
    lightX += (targetX - lightX) * TIMING.lerp;
    lightY += (targetY - lightY) * TIMING.lerp;
    applyLight(lightX, lightY);
    loopRunning = true;
    rafId = requestAnimationFrame(loop);
  }

  function onPointerMove(ev) {
    cursorSeen = true; // desktop with a cursor always uses the cursor
    mode = 'cursor';
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    targetX = clamp1((ev.clientX / w) * 2 - 1);
    targetY = clamp1((ev.clientY / h) * 2 - 1);
    lastInput = performance.now();
    wake();
  }

  function onOrient(ev) {
    if (ev.gamma == null && ev.beta == null) return;
    orientSeen = true;
    if (cursorSeen) return;
    mode = 'orientation';
    targetX = clamp1((ev.gamma || 0) / 45);
    targetY = clamp1(((ev.beta || 0) - 45) / 45);
    lastInput = performance.now();
    wake();
  }

  function startDrift() {
    if (deps.motion.REDUCED) return;
    if (mode !== 'cursor' && mode !== 'orientation') mode = 'drift';
    wake();
  }

  // No-cursor fallback (R32): first tap asks iOS for orientation permission;
  // granted -> orientation drives the light vector; denied/absent -> slow
  // autonomous drift. Every branch is wrapped — absence never throws.
  function attachOrientation() {
    try {
      listen(window, 'deviceorientation', onOrient);
      // Sensorless machines never fire the event — fall back to drift.
      later(() => {
        if (!orientSeen && !cursorSeen) startDrift();
      }, TIMING.particleLife);
    } catch {
      startDrift();
    }
  }

  function tryOrientation() {
    if (orientTried || cursorSeen || deps.motion.REDUCED) return;
    orientTried = true;
    try {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        DOE.requestPermission()
          .then((response) => {
            if (response === 'granted') attachOrientation();
            else startDrift();
          })
          .catch(() => startDrift());
      } else if (DOE) {
        attachOrientation();
      } else {
        startDrift();
      }
    } catch {
      startDrift();
    }
  }

  function onTap() {
    tryOrientation();
  }

  // --- Dust motes (R21 — the ONLY per-load randomness in the scene) ---------
  function spawnMotes() {
    for (let i = 0; i < TIMING.particles; i++) {
      const mote = document.createElement('i');
      mote.className = 'lobby-mote';
      mote.style.setProperty('--dx', `${((Math.random() * 2 - 1) * 70).toFixed(1)}px`);
      mote.style.setProperty('--dy', `${(-(20 + Math.random() * 50)).toFixed(1)}px`);
      mote.style.setProperty('--dur', `${TIMING.particleLife}ms`);
      mote.style.setProperty('--delay', `${(Math.random() * TIMING.clack * 5).toFixed(0)}ms`);
      dustEl.appendChild(mote);
    }
    // One cleanup timer removes every mote once the longest has faded.
    later(() => {
      dustEl.replaceChildren();
    }, TIMING.particleLife + TIMING.clack * 5);
  }

  // --- Call button (R24/R25) -------------------------------------------------
  function pressCall() {
    if (pressed || callBtn.disabled) return; // subsequent clicks inert
    pressed = true;
    callBtn.classList.add('is-pressed'); // CSS: 80ms down, 200ms spring, halo stays
    sfx.play('buttonChunk');
  }

  // --- The call sequence (R19–R30 — absolute timeline from plaque click) ----
  function startSequence() {
    if (started) return; // instance-local guard; FSM edge is the debounce
    started = true;
    plaqueBtn.style.pointerEvents = 'none';
    plaqueBtn.setAttribute('aria-disabled', 'true');
    el.classList.add('is-called'); // t+0: stop the sheen sweep

    // Reduced motion: collapse the whole timeline to its final frame (R33).
    if (deps.motion.REDUCED) {
      elevatorEl.classList.add('is-revealed');
      indicatorEl.classList.add('is-lit');
      callBtn.disabled = false;
      callBtn.classList.add('is-live', 'is-pressed');
      elevatorEl.classList.add('doors-open');
      flap.set('L'); // instant, no spin — zero tweens/rAF scheduled
      sfx.voice('Going up.'); // crackle lead-in is internal to voice()
      deps.state.go('DOORS_OPENING');
      deps.state.go('CAB');
      return;
    }

    // t+0 — clunk (frozen Phase 1 recipe, used AS-IS) + camera shudder.
    later(() => {
      sfx.play('clunk');
      runTween({
        from: 0,
        to: 1,
        duration: TIMING.shudder,
        ease: deps.motion.shudder, // 2 decaying rebounds, transform only
        onUpdate: (v) => {
          const kick = 1 - v; // impulse that slams and settles at 0 (<=4px)
          el.style.transform =
            `translate3d(${(kick * 2.5).toFixed(2)}px, ${(kick * -3).toFixed(2)}px, 0)`;
        },
      });
    }, TIMING.clunk);

    // t+300 — wall panel + frame reveal (CSS transition) + dust motes.
    later(() => {
      elevatorEl.classList.add('is-revealed');
      spawnMotes();
    }, TIMING.reveal);

    // t+1500 — indicator flickers lit (CSS), then a decelerating spin
    // settles on L with a ding.
    later(() => {
      indicatorEl.classList.add('is-lit');
      indicatorEl.classList.add('is-spinning');
      flap.set('L', { spin: true }).then(() => {
        indicatorEl.classList.remove('is-spinning');
        sfx.play('ding');
      });
    }, TIMING.indicatorOn);

    // t+2800 — the call button arms.
    later(() => {
      callBtn.classList.add('is-live');
      callBtn.disabled = false;
    }, TIMING.buttonLive);

    // t+3000 — cable whir starts quiet and ramps as the car approaches;
    // the flap counts the car up from the sub-basements.
    later(() => {
      whirHandle = sfx.whir();
      runTween({
        from: 0.7,
        to: 1.5,
        duration: TIMING.whirRamp,
        ease: deps.motion.soft,
        onUpdate: (v) => {
          if (whirHandle) whirHandle.setPitch(v);
        },
      });
      indicatorEl.classList.add('is-spinning');
      flap.countThrough(['B2', 'B1', 'L']).then(() => {
        indicatorEl.classList.remove('is-spinning');
      });
    }, TIMING.whir);

    // t+4800 — auto-depress if the visitor never did (identical end state).
    later(() => {
      pressCall();
    }, TIMING.buttonAuto);

    // t+5000 — the car lands: door shudder, whir fades, doors grind open
    // unevenly (CSS keyframes — we never set door transforms ourselves).
    later(() => {
      sfx.play('doorShudder');
      if (whirHandle) {
        try { whirHandle.stop(400); } catch { /* already gone — fine */ }
      }
      elevatorEl.classList.add('doors-open');
    }, TIMING.doors);

    // t+6400 — handoff (R28/R30): voice() (its speakerCrackle lead-in is
    // internal — NO separate play), then the double legal transition in
    // exactly this order, same tick. DOORS_OPENING never paints; the stage
    // swap destroys the lobby.
    later(() => {
      sfx.voice('Going up.');
      deps.state.go('DOORS_OPENING');
      deps.state.go('CAB');
    }, TIMING.handoff);
  }

  // --- Scene lifecycle (R5/R7) ----------------------------------------------

  async function enter(payload) {
    // Phase 1 room-tone bed; handle retained so destroy() can stop it (R38).
    ambientHandle = ambient.start('lobby');

    // Static default light position until input arrives (R14 default 0,0).
    applyLight(0, 0);

    // Lobby owns ALL its listeners (R8).
    listen(el, 'pointermove', onPointerMove);
    listen(el, 'pointerdown', onTap, { once: true });
    listen(plaqueBtn, 'click', startSequence);
    listen(callBtn, 'click', pressCall);

    await deps.motion.prefersFrame(); // interactive on the next paintable frame
  }

  function leave() {
    // Cancel pending sequence timers/tweens (R7). The stage runs destroy()
    // immediately after, which finishes the rest of the teardown.
    clearTimers();
    flap.cancel();
    cancelTweens();
    if (whirHandle) {
      try { whirHandle.stop(); } catch { /* already gone — fine */ }
    }
  }

  function destroy() {
    clearTimers();               // zero pending timers
    flap.cancel();               // zero split-flap timers
    cancelTweens();              // zero tweens
    if (rafId) cancelAnimationFrame(rafId);
    loopRunning = false;         // zero live rAF callbacks
    unlistenAll();               // zero attached listeners (incl. window)
    if (whirHandle) {
      try { whirHandle.stop(); } catch { /* already gone — fine */ }
      whirHandle = null;         // whir stopped
    }
    if (ambientHandle) {
      try { ambientHandle.stop(); } catch { /* already gone — fine */ }
      ambientHandle = null;      // ambient bed stopped
    }
    dustEl.replaceChildren();    // mote DOM gone
    el.replaceChildren();        // all lobby DOM detached
  }

  return { el, enter, leave, destroy };
}
