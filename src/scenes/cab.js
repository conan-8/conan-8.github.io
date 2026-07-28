// ============================================================================
// THE ELEVATOR — Phase 3
// src/scenes/cab.js — THE CAB scene (interior of the car, floor panel).
//
// Exports:
//   createScene(deps) -> { el, enter, leave, destroy }
//
// deps = { state, motion } exactly (the frozen Phase 0 call site in main.js).
// sfx, ambient, SITE and FLOORS are imported directly; the split-flap
// indicator comes from the shared chrome module (frozen S1 seam).
//
// Seam contract (FROZEN v2 — identical in the CSS part):
//   - DOM skeleton built byte-for-byte as specified (S2). The wear patch and
//     woven initials on .cab-floor are CSS pseudos — NEVER DOM nodes here.
//   - State classes set ONLY here, at the frozen moments:
//       .cab-indicator.is-lit      t+300ms after enter
//       .cab-speaker.is-voicing    for the computed duration of each voice()
//       .cab-btn.is-pressed        on press, released at t+280ms
//       .cab-btn.is-lit            latched backlight on the chosen floor
//       .cab-panel.is-locked       at handoff — every other button inert
//       .cab-mirror.is-glimpse     5000ms dwell -> 600ms hard snap
//   - Custom props set ONLY here: --px/--py (-1..1, default 0) on the
//     section.cab root per frame (CSS maps them to <=8px counter-parallax —
//     we NEVER set layer transforms); --cab-monogram once, as the JSON
//     string of SITE.name, consumed by CSS content.
//   - Animation ownership: CSS owns every @keyframes/transition, including
//     the flashing amber backlight on [data-status="wip"] .cab-btn-lamp and
//     the 80ms-down / 200ms-hold / 120ms-spring depress curve. This module
//     owns ONLY class toggles on the frozen schedule, flap textContent via
//     the chrome module, --px/--py writes, and all timers.
//
// Buttons are generated 1:1 in manifest order from FLOORS (content.js) —
// zero hardcoded floor data; the `flash` field is a Phase-4 door-crack
// color and is NEVER read here. The ONLY state edge out of CAB is
// state.go('RIDING', { floor: n }) with n validated as an integer 1-6.
// ============================================================================

import * as sfx from '../audio/sfx.js';
import * as ambient from '../audio/ambient.js';
import { SITE, FLOORS } from '../content.js';
import { createSplitFlap } from '../chrome/indicator.js';

// === TIMING =================================================================
// Single source for ALL sequence timing — ms from enter/press unless noted.
// No sequence-timing literal appears anywhere else in this file.
const TIMING = Object.freeze({
  dwell: 5000,        // mirror dwell on .cab-mirror before the premonition
  glimpse: 600,       // .is-glimpse duration — hard snap off
  cooldown: 20000,    // post-glimpse window during which dwelling does nothing
  depressDown: 80,    // mirror: button depress (CSS transition)
  depressHold: 200,   // mirror: button hold at full travel (CSS transition)
  depressUp: 120,     // mirror: button spring back (CSS transition)
  handoff: 400,       // press -> panel lock + go('RIDING') (80+200+120 settle)
  lerp: 0.1,          // parallax interpolation factor per frame
  idleMs: 500,        // cursor idle threshold — skip frames beyond it
  indicatorOn: 300,   // t+300: indicator lights + flap spins to L
  voiceAt: 400,       // t+400: "Please select a floor." announcement
  clack: 90,          // mirror of --dur-clack: one flap change per 90ms
  spin: 1200,         // split-flap settle spin duration
  voiceLead: 300,     // speaker pulse: crackle lead-in (internal to voice())
  voicePerSyllable: 190, // speaker pulse: per-syllable mumble span
  voiceTail: 200,     // speaker pulse: tail after the last syllable
});

// === CAB SCENE ==============================================================

export function createScene(deps) {
  // --- Frozen DOM skeleton (S2 — byte-for-byte; buttons appended below) -----
  const el = document.createElement('section');
  el.className = 'scene cab';
  el.innerHTML = `
  <div class="cab-shell">
    <div class="cab-wall cab-wall--left"><svg class="cab-scratch" viewBox="0 0 120 160" preserveAspectRatio="none" aria-hidden="true"><path d="M24 134 L60 46 M35 138 L72 50 M76 120 L104 68" fill="none" stroke="rgba(239,230,213,0.4)" stroke-width="1.5" stroke-linecap="round"/></svg></div>
    <div class="cab-wall cab-wall--right"></div>
    <div class="cab-wall cab-wall--back"></div>
    <div class="cab-ceiling"><div class="cab-dome"></div></div>
    <div class="cab-floor"></div>
    <div class="cab-doors">
      <div class="cab-indicator" aria-hidden="true"><span class="cab-flap"></span><span class="cab-flap"></span></div>
      <div class="cab-speaker" aria-hidden="true"></div>
      <div class="cab-door cab-door--left"></div>
      <div class="cab-door cab-door--right"></div>
    </div>
    <div class="cab-mirror"><div class="cab-mirror-glass"><figure class="cab-silhouette" aria-hidden="true"></figure></div></div>
    <div class="cab-panel">
      <div class="cab-buttons"></div>
    </div>
  </div>`;

  const indicatorEl = el.querySelector('.cab-indicator');
  const flapCells = el.querySelectorAll('.cab-flap');
  const speakerEl = el.querySelector('.cab-speaker');
  const mirrorEl = el.querySelector('.cab-mirror');
  const panelEl = el.querySelector('.cab-panel');
  const buttonsEl = el.querySelector('.cab-buttons');

  // The monogram is cast once into the root as a JSON string ("CONAN") —
  // CSS content consumes it verbatim. Never hardcoded (content.js only).
  el.style.setProperty('--cab-monogram', JSON.stringify(SITE.name));

  // --- Floor buttons — generated 1:1 in manifest order from FLOORS ----------
  // data-floor / data-status carry the manifest; .cab-btn-num = n,
  // .cab-btn-name = label (floor 6's empty label renders empty — fine).
  // .cab-tape exists ONLY on wip buttons. Zero hardcoded floor data.
  for (const floor of FLOORS) {
    const slot = document.createElement('div');
    slot.className = 'cab-btn-slot';

    const btn = document.createElement('button');
    btn.className = 'cab-btn';
    btn.type = 'button';
    btn.dataset.floor = String(floor.n);
    btn.dataset.status = floor.status;
    btn.setAttribute(
      'aria-label',
      floor.label ? `${floor.label} — floor ${floor.n}` : `Floor ${floor.n}`
    );

    const num = document.createElement('span');
    num.className = 'cab-btn-num';
    num.textContent = String(floor.n);

    const lamp = document.createElement('span');
    lamp.className = 'cab-btn-lamp';

    btn.appendChild(num);
    btn.appendChild(lamp);
    if (floor.status === 'wip') {
      const tape = document.createElement('span');
      tape.className = 'cab-tape';
      btn.appendChild(tape);
    }

    const name = document.createElement('span');
    name.className = 'cab-btn-name';
    name.textContent = floor.label;

    slot.appendChild(btn);
    slot.appendChild(name);
    buttonsEl.appendChild(slot);
  }

  // --- Instance state (closure-local; the FSM edge is the structural
  //     debounce — state.js exposes no current-state getter to scenes) ------
  let locked = false;          // panel locked at handoff — all buttons inert
  let voicingTimer = 0;        // speaker .is-voicing pulse countdown
  let dwellTimer = 0;          // mirror dwell countdown
  let glimpseTimer = 0;        // mirror glimpse snap countdown
  let cooldownUntil = 0;       // performance.now() bound of the mirror cooldown
  let ambientHandle = null;
  const inFlight = new WeakSet(); // per-button press debounce (pointerdown+click)

  // --- Owned resources: timers, tweens, listeners ----------------------------
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

  function cancelTimer(id) {
    if (!id) return;
    clearTimeout(id);
    timers.delete(id);
  }

  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
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

  // --- Split-flap instance (S1 seam — clack sound injected) ------------------
  const flap = createSplitFlap(flapCells, {
    clackMs: TIMING.clack,
    spinMs: TIMING.spin,
    onClack: () => sfx.play('clack'),
  });

  // --- Speaker voicing pulse (R19) -------------------------------------------
  // voice() is fire-and-forget, so the .is-voicing duration is computed
  // locally: crackle lead-in + per-syllable mumble + tail. The syllable
  // estimate mirrors sfx.js countSyllables exactly (vowel groups, min 1).
  function countSyllables(text) {
    const groups = String(text).toLowerCase().match(/[aeiouy]+/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  function announce(line) {
    sfx.voice(line); // crackle lead-in is INTERNAL to voice() — never play()
    cancelTimer(voicingTimer);
    speakerEl.classList.add('is-voicing');
    voicingTimer = later(() => {
      voicingTimer = 0;
      speakerEl.classList.remove('is-voicing');
    }, TIMING.voiceLead + countSyllables(line) * TIMING.voicePerSyllable + TIMING.voiceTail);
  }

  // --- Parallax (R10/R11) ------------------------------------------------------
  // ONE scene-owned rAF loop lerps the current vector toward the pointer
  // target at TIMING.lerp/frame and mirrors it into --px/--py on the root
  // (CSS maps those onto the layered walls at <=8px counter-parallax — we
  // never set layer transforms). Frames are skipped while the cursor is
  // idle beyond TIMING.idleMs — the loop sleeps until the next pointermove.
  // Under REDUCED the loop is NEVER scheduled and --px/--py stay 0.
  let rafId = 0;
  let loopRunning = false;
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let lastInput = 0;

  const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

  function applyParallax(px, py) {
    el.style.setProperty('--px', px.toFixed(4));
    el.style.setProperty('--py', py.toFixed(4));
  }

  function wake() {
    if (loopRunning || deps.motion.REDUCED) return; // R11: no loop, ever
    loopRunning = true;
    rafId = requestAnimationFrame(loop);
  }

  function pauseLoop() {
    loopRunning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function loop(now) {
    loopRunning = false;
    if (now - lastInput > TIMING.idleMs) return; // idle -> loop sleeps
    currentX += (targetX - currentX) * TIMING.lerp;
    currentY += (targetY - currentY) * TIMING.lerp;
    applyParallax(currentX, currentY);
    loopRunning = true;
    rafId = requestAnimationFrame(loop);
  }

  function onPointerMove(ev) {
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    targetX = clamp1((ev.clientX / w) * 2 - 1);
    targetY = clamp1((ev.clientY / h) * 2 - 1);
    lastInput = performance.now();
    wake();
  }

  // --- Mirror premonition (R12) ------------------------------------------------
  // pointerenter starts a TIMING.dwell countdown; at 5000ms .is-glimpse
  // snaps on for exactly TIMING.glimpse, then off, opening a TIMING.cooldown
  // window during which dwelling does nothing. pointerleave cancels only
  // the pending dwell — a glimpse already snapped runs its full 600ms.
  function onMirrorEnter() {
    if (performance.now() < cooldownUntil) return;
    if (dwellTimer) return; // already dwelling
    dwellTimer = later(() => {
      dwellTimer = 0;
      mirrorEl.classList.add('is-glimpse');
      glimpseTimer = later(() => {
        glimpseTimer = 0;
        mirrorEl.classList.remove('is-glimpse'); // hard snap
        cooldownUntil = performance.now() + TIMING.cooldown;
      }, TIMING.glimpse);
    }, TIMING.dwell);
  }

  function onMirrorLeave() {
    cancelTimer(dwellTimer);
    dwellTimer = 0;
  }

  // --- Floor buttons (R14/R15/R16/R19) ------------------------------------------
  // Depress physics: .is-pressed + buttonChunk immediately; at 280ms
  // (down+hold) the class swaps to .is-lit so CSS springs back over 120ms
  // while the backlight stays latched. At TIMING.handoff (~400ms from
  // down) the panel locks FIRST, then the one legal edge fires.
  function onPress(btn) {
    if (locked) return;                    // panel locked -> inert
    if (inFlight.has(btn)) return;         // pointerdown + click dedupe
    const status = btn.dataset.status || '';

    // Ghost / wip floors: bloop + renovation voice. NO latch, NO lock,
    // NO state edge. (The manifest `flash` field is never read here.)
    if (status !== 'open') {
      sfx.play('bloop');
      announce('This floor is currently under renovation.');
      return;
    }

    const n = parseInt(btn.dataset.floor || '0', 10);
    if (!Number.isInteger(n) || n < 1 || n > 6) return; // guard anyway (R21)

    inFlight.add(btn);
    btn.classList.add('is-pressed');
    sfx.play('buttonChunk');

    // 280ms — release the travel, latch the backlight (CSS springs 120ms).
    later(() => {
      btn.classList.remove('is-pressed');
      btn.classList.add('is-lit');
    }, TIMING.depressDown + TIMING.depressHold);

    // ~400ms — lock the panel FIRST, then the ONLY edge out of CAB.
    later(() => {
      inFlight.delete(btn);
      locked = true;
      panelEl.classList.add('is-locked');
      deps.state.go('RIDING', { floor: n });
    }, TIMING.handoff);
  }

  // Hover tick on OPEN buttons while the panel is unlocked (R19).
  function onHover(btn) {
    if (locked) return;
    if ((btn.dataset.status || '') !== 'open') return;
    sfx.play('bloop');
  }

  // --- Scene lifecycle -----------------------------------------------------------

  async function enter() {
    // Cabin bed: 50 Hz hum + cable groans; handle retained for destroy().
    ambientHandle = ambient.start('cab');

    // Static default parallax until input arrives (default 0,0).
    applyParallax(0, 0);

    // Dark, empty flap cells until the indicator lights.
    flap.render('');

    // The scene owns ALL its listeners.
    listen(el, 'pointermove', onPointerMove);
    listen(mirrorEl, 'pointerenter', onMirrorEnter);
    listen(mirrorEl, 'pointerleave', onMirrorLeave);
    for (const btn of buttonsEl.querySelectorAll('.cab-btn')) {
      listen(btn, 'pointerdown', () => onPress(btn));
      listen(btn, 'click', () => onPress(btn)); // keyboard activation path
      listen(btn, 'pointerenter', () => onHover(btn));
    }

    // t+300 — indicator flickers lit (CSS), flap decelerates onto L.
    // The car is at the lobby: NO countThrough on enter, NO ding.
    later(() => {
      indicatorEl.classList.add('is-lit');
      flap.set('L', { spin: true });
    }, TIMING.indicatorOn);

    // t+400 — the PA wakes up and asks for a floor.
    later(() => {
      announce('Please select a floor.');
    }, TIMING.voiceAt);

    wake(); // parallax loop starts; sleeps immediately until first input

    await deps.motion.prefersFrame(); // interactive on the next paintable frame
  }

  function leave() {
    // Cancel pending sequence timers/tweens; the stage runs destroy()
    // immediately after, which finishes the rest of the teardown.
    clearTimers();
    flap.cancel();
    cancelTweens();
    pauseLoop();
  }

  function destroy() {
    clearTimers();               // zero pending timers (dwell/glimpse/voicing)
    flap.cancel();               // zero split-flap timers
    cancelTweens();              // zero tweens
    pauseLoop();                 // zero live rAF callbacks
    unlistenAll();               // zero attached listeners
    if (ambientHandle) {
      try { ambientHandle.stop(); } catch { /* already gone — fine */ }
      ambientHandle = null;      // cabin bed stopped
    }
    el.replaceChildren();        // all cab DOM detached
  }

  return { el, enter, leave, destroy };
}
