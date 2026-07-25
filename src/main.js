// ============================================================================
// THE ELEVATOR — Phase 0
// src/main.js — owner of boot wiring + debug harness (R43–R47).
//
// The single entry module (index.html loads it as the only script tag).
// On load it: claims the stage, registers the eight placeholder scene
// factories, subscribes to state:exit / state:enter on window, arms the
// ?debug-only keydown harness, and boots BOOT -> LOBBY so the first paint
// shows the LOBBY placeholder.
//
// Placeholder scenes live entirely in this file (R42). Each conforms to
// the joint scene contract (R40/R41): factory createScene(deps) with
// deps = { state, motion } (the module namespaces), returning exactly
// { el, enter, leave, destroy }. Scenes own their tweens and clean them
// up in destroy(). Only transform/opacity ever move (R6), and under
// prefers-reduced-motion every entrance snaps straight to its final
// frame (R7) — motion.tween handles that collapse internally.
// ============================================================================

import * as motion from './motion.js';
import * as state from './state.js';
import { createStage } from './stage.js';
import * as engine from './audio/engine.js';
import * as soundcheck from './audio/soundcheck.js';

const STATES = [
  'BOOT',
  'LOBBY',
  'DOORS_OPENING',
  'CAB',
  'RIDING',
  'FLOOR_REVEAL',
  'FLOOR',
  'RETURNING',
];

// R42 per-state placeholder palette (shaft-dark solids).
const PLACEHOLDER_BG = {
  BOOT: '#0b0a08',
  LOBBY: '#1c1207',
  DOORS_OPENING: '#2a1a0a',
  CAB: '#12100a',
  RIDING: '#0d1117',
  FLOOR_REVEAL: '#201a10',
  FLOOR: '#101a12',
  RETURNING: '#170f0f',
};

/**
 * createPlaceholderScene(name) -> createScene(deps)
 *
 * Phase 0 stand-in scene: a solid-color full-screen div carrying the
 * state's name dead-center in the mono face, cream on dark. The entrance
 * is a short rise-and-fade (opacity + transform only); leave()/destroy()
 * cancel the tween so nothing leaks past the scene's lifetime.
 */
function createPlaceholderScene(name) {
  return function createScene(deps) {
    const el = document.createElement('div');
    el.classList.add('scene');
    el.style.background = PLACEHOLDER_BG[name];
    el.style.display = 'grid';
    el.style.placeItems = 'center';
    el.style.fontFamily = 'var(--font-mono)';
    el.style.color = 'var(--cream)';
    el.style.fontSize = 'clamp(1.6rem, 7vw, 4.6rem)';
    el.style.fontWeight = '500';
    el.style.letterSpacing = '0.34em';
    el.style.paddingLeft = '0.34em'; // optically re-center tracked type
    el.style.textShadow = '0 2px 18px rgba(0, 0, 0, 0.55)';
    el.textContent = name;

    let entrance = null;

    return {
      el,
      enter() {
        // Called after mount + activation (R41). Settle from one frame
        // below: fade in while drifting up a third of an em.
        el.style.opacity = '0';
        el.style.transform = 'translateY(0.3em)';
        entrance = deps.motion.tween({
          from: 0,
          to: 1,
          duration: 340,
          ease: deps.motion.soft,
          onUpdate: (v) => {
            el.style.opacity = String(v);
            el.style.transform = `translateY(${(1 - v) * 0.3}em)`;
          },
        });
      },
      leave() {
        if (entrance && typeof entrance.cancel === 'function') entrance.cancel();
        entrance = null;
      },
      destroy() {
        if (entrance && typeof entrance.cancel === 'function') entrance.cancel();
        entrance = null;
      },
    };
  };
}

// ---- boot wiring (R43) -----------------------------------------------------

const stage = createStage(); // claimed exactly once, here and only here

// Factory registry: state name -> createScene(deps).
const factories = {};
for (const name of STATES) {
  factories[name] = createPlaceholderScene(name);
}

// Live scene instances keyed by state name, plus the outgoing scene
// tracked from state:exit's detail.from (R44).
const live = new Map();
let outgoing = null;

window.addEventListener('state:exit', (event) => {
  const from = event.detail ? event.detail.from : null;
  outgoing = (from && live.get(from)) || null;
  if (from) live.delete(from);
});

window.addEventListener('state:enter', (event) => {
  const detail = event.detail || {};
  const to = detail.to;
  const factory = factories[to];
  if (!factory) return;

  // Mount the incoming placeholder on top, then retire the outgoing one
  // through the stage lifecycle: leave -> destroy -> DOM removal (R38).
  const scene = factory({ state, motion });
  live.set(to, scene);
  stage.push(scene, { payload: detail.payload });

  const stale = outgoing;
  outgoing = null;
  if (stale) stage.remove(stale);
});

// ---- debug harness (R45–R47) -----------------------------------------------
// Ships permanently, but is only armed when the URL carries ?debug.
// Digits 0-4 force-jump through set() (the R31 forced path); ride states
// carry payload { floor: 3 }. Without ?debug, digit keys are inert.

const DEBUG = /[?&]debug(?:=|&|$)/.test(String(window.location.search || ''));

const DEBUG_JUMPS = {
  '0': { to: 'LOBBY' },
  '1': { to: 'CAB' },
  '2': { to: 'RIDING', payload: { floor: 3 } },
  '3': { to: 'FLOOR_REVEAL', payload: { floor: 3 } },
  '4': { to: 'FLOOR', payload: { floor: 3 } },
};

if (DEBUG) {
  window.addEventListener('keydown', (event) => {
    const jump = DEBUG_JUMPS[event.key];
    if (!jump) return;
    state.set(jump.to, jump.payload);
  });
}

// ---- first paint: BOOT -> LOBBY (legal edge, R43) ---------------------------

state.go('LOBBY');

// ---- Phase-1 audio harness (R-HAR) ------------------------------------------
// Ships permanently. The ?soundcheck flag mounts the diagnostic overlay
// (R-HAR-04); the M key toggles the master mute from anywhere — ?debug
// included — without ever touching the digit rig above; engine.unlock()
// is called exactly once, here and only here, so the AudioContext opens
// at the end of boot.

const SOUNDCHECK = new URLSearchParams(window.location.search).has('soundcheck');
if (SOUNDCHECK) soundcheck.mount(document.body);

// M toggles mute. Deliberately a separate listener from the ?debug rig:
// it never calls preventDefault() and never looks at digits 0-4, so the
// forced-jump keys keep working unchanged. Keystrokes that land inside a
// form field are ignored so typing an "m" never silences the shaft.
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'm') return;
  const target = event.target;
  if (
    target &&
    typeof target.closest === 'function' &&
    target.closest('input, textarea, [contenteditable]')
  ) {
    return;
  }
  engine.setMuted(!engine.isMuted());
});

engine.unlock();
