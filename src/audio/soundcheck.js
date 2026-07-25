// ============================================================================
// src/audio/soundcheck.js — ?soundcheck diagnostic overlay
// ----------------------------------------------------------------------------
// Owner role : harness — Phase 1 audio-kit acceptance rig
// Rules      : R-HAR-04  built ONLY under the ?soundcheck flag ....... rule 54
//              R-HAR-05  onVoice readout in --brass/--amber/--cream/--ink
//                        + --font-mono ............................... rule 55
//              R-HAR-06  transform/opacity-only motion; honors
//                        prefers-reduced-motion ...................... rule 64
//              R-HAR-07  owns every listener/timer it adds and removes
//                        them all on teardown ........................ rule 64
//              R-HAR-08  numbered shortcuts 1-9 are scoped to this
//                        overlay — added with it, removed with it, and
//                        they always yield to ?debug keys 0-4 ........ rule 54
//              R-HAR-09  zero network requests, zero audio files —
//                        pure Web Audio via the frozen kit API ....... rule 59
// Notes      : main.js calls mount(document.body) when ?soundcheck is set.
//              Everything the overlay adds — DOM, <style>, the window
//              keydown listener, the engine.onVoice subscription, the whir
//              handle, ambient beds, exit timers — is removed by
//              teardown(). No class-heavy OOP; plain module functions.
// ============================================================================

import * as engine from './engine.js';
import * as sfx from './sfx.js';
import * as ambient from './ambient.js';
import { REDUCED } from '../motion.js';

// === Catalogues (mirror the frozen sfx / ambient APIs) ======================
/** @type {ReadonlyArray<string>} every sfx one-shot, in score order. Keys 1-9. */
const ONE_SHOTS = [
  'clunk',
  'ding',
  'clack',
  'doorShudder',
  'buttonChunk',
  'bloop',
  'speakerCrackle',
  'ding_arrive',
  'ding_depart',
];

/** @type {ReadonlyArray<string>} every ambient bed. */
const BEDS = ['lobby', 'cab', 'library', 'workshop', 'studio'];

/** @type {ReadonlyArray<{label: string, line: string}>} voice() demo phrases. */
const VOICE_DEMOS = [
  { label: 'GOING UP', line: 'Going up.' },
  { label: 'THIRD FLOOR', line: 'Third floor. Watch your step.' },
];

/** @type {ReadonlyArray<number>} whir pitch presets fed to setPitch(rate). */
const WHIR_PITCHES = [0.7, 1.0, 1.4];

/** true when ?debug is also active — shortcuts then yield keys 0-4 entirely. */
const DEBUG_ACTIVE = /[?&]debug(?:=|&|$)/.test(window.location.search);

// === Overlay state (module-private; all cleared on teardown) ================
/** @type {HTMLElement|null} overlay root, null when not mounted. */
let root = null;
/** @type {HTMLStyleElement|null} injected stylesheet for the overlay only. */
let styleEl = null;
/** @type {(() => void)|null} engine.onVoice unsubscribe handle. */
let unsubVoice = null;
/** @type {{setPitch(rate: number): void, stop(fadeMs: number): void}|null} */
let whirHandle = null;
/** @type {Set<string>} ambient beds this overlay started (and must stop). */
const activeBeds = new Set();
/** @type {Map<string, HTMLButtonElement>} one-shot name → its button. */
const shotBtns = new Map();
/** @type {Array<() => void>} listener-removal fns run once on teardown. */
let teardownFns = [];
/** @type {HTMLButtonElement|null} */
let muteBtn = null;
/** @type {HTMLElement|null} live voice-line readout. */
let voiceWell = null;

// === Styles (base.css tokens; animated properties: transform/opacity only) ==
/**
 * OVERLAY_CSS — inspection-plate styling built on the base.css custom
 * properties (--brass, --brass-hi, --brass-lo, --amber, --cream, --ink,
 * --steel, --font-display, --font-mono). Every transition/animation
 * declared here moves transform and opacity ONLY (R-HAR-06), and the
 * prefers-reduced-motion block disables them outright.
 * @type {string}
 */
const OVERLAY_CSS = `
#sc-overlay {
  position: fixed; right: 16px; bottom: 16px; z-index: 9999;
  width: min(376px, calc(100vw - 24px));
  max-height: calc(100vh - 24px); overflow-y: auto; box-sizing: border-box;
  padding: 14px 14px 12px;
  color: var(--cream, #efe6d5);
  background:
    radial-gradient(120% 90% at 0% 0%, rgba(176, 141, 87, 0.14), transparent 55%),
    linear-gradient(165deg, #2a1c10 0%, #1a1410 48%, #120d08 100%);
  border: 1px solid var(--brass, #b08d57);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.62),
    inset 0 0 0 1px rgba(176, 141, 87, 0.22),
    inset 0 1px 0 rgba(230, 200, 138, 0.16);
  font-family: var(--font-mono, "IBM Plex Mono", monospace);
  opacity: 0; transform: translateY(14px) scale(0.985);
  transition: opacity 220ms ease-out, transform 220ms ease-out;
}
#sc-overlay.is-in  { opacity: 1; transform: none; }
#sc-overlay.is-out { opacity: 0; transform: translateY(10px); }

#sc-overlay .sc-head {
  display: flex; align-items: baseline; gap: 10px;
  margin: 0 0 10px; padding-bottom: 9px;
  border-bottom: 1px solid var(--brass-lo, #6e5426);
}
#sc-overlay .sc-title {
  margin: 0;
  font-family: var(--font-display, "Cormorant Garamond", serif);
  font-size: 22px; font-weight: 600; letter-spacing: 0.22em;
  color: var(--brass-hi, #e6c88a);
}
#sc-overlay .sc-sub { font-size: 9px; letter-spacing: 0.18em; color: var(--steel, #8a8f94); }
#sc-overlay .sc-close { margin-left: auto; padding: 2px 9px; line-height: 1.4; }

#sc-overlay .sc-section { margin: 13px 0 0; }
#sc-overlay .sc-label {
  display: flex; align-items: center; gap: 8px;
  margin: 0 0 6px; font-size: 9px; letter-spacing: 0.24em;
  color: var(--brass, #b08d57);
}
#sc-overlay .sc-label::after { content: ""; flex: 1; height: 1px; background: var(--brass-lo, #6e5426); opacity: 0.6; }

#sc-overlay button {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 7px 8px; cursor: pointer;
  font: inherit; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--cream, #efe6d5);
  background: rgba(26, 20, 16, 0.85);
  border: 1px solid var(--brass-lo, #6e5426);
  transition: transform 120ms ease-out, opacity 120ms ease-out;
}
#sc-overlay button:hover  { transform: translateY(-1px); }
#sc-overlay button:active { transform: scale(0.96); }
#sc-overlay button:focus-visible { outline: 1px solid var(--amber, #ffb54d); outline-offset: 2px; }
#sc-overlay button[aria-pressed="true"] { border-color: var(--amber, #ffb54d); color: var(--amber, #ffb54d); }
#sc-overlay kbd {
  font: inherit; font-size: 9px; padding: 1px 5px;
  color: var(--steel, #8a8f94); border: 1px solid var(--brass-lo, #6e5426);
}

#sc-overlay .sc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
#sc-overlay .sc-row  { display: flex; gap: 6px; flex-wrap: wrap; }
#sc-overlay .sc-row button { flex: 1 1 auto; }
#sc-overlay .sc-beds { display: grid; grid-template-columns: repeat(auto-fit, minmax(64px, 1fr)); gap: 6px; }
#sc-overlay .sc-beds button { justify-content: center; }
#sc-overlay .sc-pitch { flex: 0 0 auto; }

@keyframes sc-hit {
  0%   { opacity: 0.35; transform: scale(0.94); }
  100% { opacity: 1;    transform: none; }
}
#sc-overlay .is-hit { animation: sc-hit 200ms ease-out; }

#sc-voiceline {
  display: flex; align-items: center; margin: 6px 0 0; min-height: 36px;
  padding: 8px 10px; box-sizing: border-box;
  background: var(--ink, #1a1410);
  border: 1px solid var(--brass-lo, #6e5426);
  color: var(--amber, #ffb54d);
  font-size: 11.5px; letter-spacing: 0.04em;
}
@keyframes sc-voice {
  0%   { opacity: 0.15; transform: translateY(4px); }
  100% { opacity: 1;    transform: none; }
}
#sc-voiceline.is-live { animation: sc-voice 280ms ease-out; }

#sc-mute { width: 100%; justify-content: center; margin-top: 12px; padding: 9px; font-size: 11px; letter-spacing: 0.16em; }
#sc-mute.is-muted { background: var(--amber, #ffb54d); border-color: var(--amber, #ffb54d); color: var(--ink, #1a1410); font-weight: 600; }

@media (prefers-reduced-motion: reduce) {
  #sc-overlay, #sc-overlay * { transition: none !important; animation: none !important; }
}
`;

// === Small DOM + guard helpers ==============================================
/**
 * h(tag, attrs, ...children) — tiny element builder; `class`/`text` are
 * sugar, every other key goes through setAttribute.
 * @param {string} tag
 * @param {Record<string, string>|null} [attrs]
 * @param {...Node} children
 * @returns {HTMLElement}
 */
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/**
 * isTypingTarget(target) — true for input/textarea/contenteditable, where
 * digit keys must type rather than fire sounds.
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * pretty(name) — 'ding_arrive' → 'DING ARRIVE' for button labels.
 * @param {string} name
 * @returns {string}
 */
function pretty(name) {
  return name.replace(/_/g, ' ').toUpperCase();
}

// === Behaviour ===============================================================
/**
 * fireOneShot(name) — trigger one sfx one-shot and flash its button.
 * (Ducking happens inside sfx.play per rule 16 — nothing to do here.)
 * @param {string} name — one of ONE_SHOTS.
 */
function fireOneShot(name) {
  sfx.play(name);
  const btn = shotBtns.get(name);
  if (btn && !REDUCED) {
    btn.classList.remove('is-hit');
    void btn.offsetWidth; // restart the opacity/transform hit flash
    btn.classList.add('is-hit');
  }
}

/**
 * setWhir(on) — start or stop the sustained whir; exactly one live handle
 * at a time, torn down with a fade on stop (and on overlay teardown).
 * @param {boolean} on
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} labelEl
 */
function setWhir(on, btn, labelEl) {
  if (on && !whirHandle) {
    whirHandle = sfx.whir();
    whirHandle.setPitch(1.0);
  } else if (!on && whirHandle) {
    whirHandle.stop(220);
    whirHandle = null;
  }
  const running = Boolean(whirHandle);
  btn.setAttribute('aria-pressed', String(running));
  labelEl.textContent = running ? 'WHIR · STOP' : 'WHIR · START';
}

/**
 * toggleBed(name, btn, labelEl) — start/stop one ambient bed via the
 * dispatcher API and mirror the state on the button. Beds started here are
 * tracked in activeBeds and stopped again on teardown.
 * @param {string} name — one of BEDS.
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} labelEl
 */
function toggleBed(name, btn, labelEl) {
  if (activeBeds.has(name)) {
    ambient.stop(name);
    activeBeds.delete(name);
    btn.setAttribute('aria-pressed', 'false');
    labelEl.textContent = `${name} · start`;
  } else {
    ambient.start(name);
    activeBeds.add(name);
    btn.setAttribute('aria-pressed', 'true');
    labelEl.textContent = `${name} · stop`;
  }
}

/**
 * syncMute() — reflect engine.isMuted() on the mute button (label,
 * aria-pressed, tint). Called on click, on mount, and whenever the global
 * M key fires while the overlay is open.
 */
function syncMute() {
  if (!muteBtn) return;
  const muted = engine.isMuted();
  muteBtn.setAttribute('aria-pressed', String(muted));
  muteBtn.classList.toggle('is-muted', muted);
  muteBtn.textContent = muted ? 'MUTED · M TO RESTORE' : 'SOUND ON · M TO MUTE';
}

/**
 * renderVoice(line) — push the latest voice() line into the annunciator
 * readout (R-HAR-05) and replay its opacity/transform pulse.
 * @param {string} line
 */
function renderVoice(line) {
  if (!voiceWell) return;
  voiceWell.textContent = `\u201C${line}\u201D`;
  if (REDUCED) return;
  voiceWell.classList.remove('is-live');
  void voiceWell.offsetWidth;
  voiceWell.classList.add('is-live');
}

/**
 * onOverlayKeys(event) — the overlay's OWN keydown handler (R-HAR-08).
 * Added on mount, removed on teardown. Digits 1-9 fire one-shots; Escape
 * closes. When ?debug is also active, keys 0-4 are yielded to the debug
 * jump rig without interference — this handler ignores them entirely and
 * never calls preventDefault().
 * @param {KeyboardEvent} event
 */
function onOverlayKeys(event) {
  const key = event.key;
  if (!key) return;
  if (key === 'Escape') { teardown(); return; }
  if (key === 'm' || key === 'M') { syncMute(); return; } // mirror the global toggle
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;
  if (key.length === 1 && key >= '1' && key <= '9') {
    if (DEBUG_ACTIVE && key <= '4') return; // R-HAR-08: ?debug keys 0-4 win, always
    fireOneShot(ONE_SHOTS[Number(key) - 1]);
  }
}

// === Public API ==============================================================
/**
 * mount(host) — build the ?soundcheck overlay and append it to `host`
 * (main.js passes document.body). Idempotent: a second call returns the
 * existing root. Registers exactly one window keydown listener and one
 * engine.onVoice subscription, both removed by teardown().
 * @param {HTMLElement} host
 * @returns {HTMLElement} the overlay root element.
 */
export function mount(host) {
  if (root) return root;

  styleEl = h('style', null);
  styleEl.textContent = OVERLAY_CSS;

  root = h('aside', { id: 'sc-overlay', role: 'region', 'aria-label': 'Sound check console' });

  // --- head: title plate + close -------------------------------------------
  const closeBtn = h('button', { class: 'sc-close', type: 'button', 'aria-label': 'Close sound check', text: '\u00D7' });
  closeBtn.addEventListener('click', teardown);
  root.append(
    h('header', { class: 'sc-head' },
      h('h2', { class: 'sc-title', text: 'SOUND CHECK' }),
      h('span', { class: 'sc-sub', text: 'PHASE 1 \u00B7 WEB AUDIO KIT' }),
      closeBtn),
  );

  // --- one-shots (keys 1-9) --------------------------------------------------
  const grid = h('div', { class: 'sc-grid' });
  ONE_SHOTS.forEach((name, i) => {
    const btn = h('button', { type: 'button', 'data-sfx': name, title: `play ${name} [${i + 1}]` },
      h('span', { text: pretty(name) }),
      h('kbd', { text: String(i + 1) }));
    btn.addEventListener('click', () => fireOneShot(name));
    shotBtns.set(name, btn);
    grid.append(btn);
  });
  root.append(h('section', { class: 'sc-section' },
    h('p', { class: 'sc-label', text: 'ONE-SHOTS' }), grid));

  // --- whir sustain + pitch presets ------------------------------------------
  const whirLabel = h('span', { text: 'WHIR \u00B7 START' });
  const whirBtn = h('button', { type: 'button', 'aria-pressed': 'false' }, whirLabel, h('kbd', { text: 'SUSTAIN' }));
  whirBtn.addEventListener('click', () => setWhir(!whirHandle, whirBtn, whirLabel));
  const whirRow = h('div', { class: 'sc-row' }, whirBtn);
  for (const rate of WHIR_PITCHES) {
    const chip = h('button', { class: 'sc-pitch', type: 'button', title: `whir pitch ${rate}\u00D7`, text: `${rate}\u00D7` });
    chip.addEventListener('click', () => { if (whirHandle) whirHandle.setPitch(rate); });
    whirRow.append(chip);
  }
  root.append(h('section', { class: 'sc-section' },
    h('p', { class: 'sc-label', text: 'SUSTAIN' }), whirRow));

  // --- ambient beds -----------------------------------------------------------
  const beds = h('div', { class: 'sc-beds' });
  for (const name of BEDS) {
    const labelEl = h('span', { text: `${name} \u00B7 start` });
    const btn = h('button', { type: 'button', 'aria-pressed': 'false', title: `ambient bed: ${name}` }, labelEl);
    btn.addEventListener('click', () => toggleBed(name, btn, labelEl));
    beds.append(btn);
  }
  root.append(h('section', { class: 'sc-section' },
    h('p', { class: 'sc-label', text: 'AMBIENT BEDS' }), beds));

  // --- voice demo + annunciator readout (R-HAR-05) ----------------------------
  const voiceRow = h('div', { class: 'sc-row' });
  for (const demo of VOICE_DEMOS) {
    const btn = h('button', { type: 'button', title: `voice("${demo.line}")`, text: demo.label });
    btn.addEventListener('click', () => sfx.voice(demo.line));
    voiceRow.append(btn);
  }
  voiceWell = h('p', { id: 'sc-voiceline', text: '\u2014 annunciator idle \u2014' });
  root.append(h('section', { class: 'sc-section' },
    h('p', { class: 'sc-label', text: 'ANNUNCIATOR' }), voiceRow, voiceWell));

  // --- mute toggle --------------------------------------------------------------
  muteBtn = h('button', { id: 'sc-mute', type: 'button' });
  muteBtn.addEventListener('click', () => {
    engine.setMuted(!engine.isMuted());
    syncMute();
  });
  syncMute();
  root.append(muteBtn);

  // --- owned listeners: keydown + onVoice (R-HAR-07) ----------------------------
  window.addEventListener('keydown', onOverlayKeys);
  teardownFns.push(() => window.removeEventListener('keydown', onOverlayKeys));

  unsubVoice = engine.onVoice(renderVoice);

  // --- enter: opacity/transform only ---------------------------------------------
  host.append(styleEl, root);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (root) root.classList.add('is-in');
  }));

  return root;
}

/**
 * teardown() — remove everything the overlay added: the window keydown
 * listener, the engine.onVoice subscription, the whir handle (with fade),
 * every ambient bed this overlay started, then the DOM + stylesheet. The
 * exit fade animates opacity/transform only and its fallback timer is
 * cleared by the transitionend path (R-HAR-06/07). Idempotent.
 * @returns {void}
 */
export function teardown() {
  if (!root) return;

  for (const fn of teardownFns.splice(0)) fn();
  if (unsubVoice) { unsubVoice(); unsubVoice = null; }
  if (whirHandle) { whirHandle.stop(180); whirHandle = null; }
  for (const name of activeBeds) ambient.stop(name);
  activeBeds.clear();
  shotBtns.clear();
  muteBtn = null;
  voiceWell = null;

  const el = root; root = null;
  const sheet = styleEl; styleEl = null;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.remove();
    if (sheet) sheet.remove();
  };

  if (REDUCED) { finish(); return; }
  el.classList.remove('is-in');
  el.classList.add('is-out');
  const timer = setTimeout(finish, 260);
  el.addEventListener('transitionend', () => { clearTimeout(timer); finish(); }, { once: true });
}
