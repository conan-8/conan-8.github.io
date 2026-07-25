// ============================================================================
// THE ELEVATOR — Phase 0
// src/state.js — owner of the FSM contract (R27–R34).
//
// Exports:
//   go(nextState, payload)  — validated transition along the legal graph
//   set(state, payload)     — forced path for the debug harness / __lift
//
// Events (plain CustomEvents on window):
//   "state:exit"  detail: { from, to }
//   "state:enter" detail: { to, payload }
// Order per transition: exit fires, then enter, then the current state
// variable flips (R29).
//
// Dev mode (R33): hostname localhost / 127.0.0.1, or ?debug in the URL.
//   - dev:  illegal transitions throw an Error (R32)
//   - prod: illegal transitions console.warn and are ignored, no events
// In dev mode only, window.__lift = { go, set, state } is attached (R34).
// ============================================================================

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

// The one legal edge out of each state (R28). RETURNING closes the ride
// loop back into CAB; from CAB the cycle may repeat.
const GRAPH = {
  BOOT: 'LOBBY',
  LOBBY: 'DOORS_OPENING',
  DOORS_OPENING: 'CAB',
  CAB: 'RIDING',
  RIDING: 'FLOOR_REVEAL',
  FLOOR_REVEAL: 'FLOOR',
  FLOOR: 'RETURNING',
  RETURNING: 'CAB',
};

// Entering any of these states requires payload.floor (R30).
const FLOOR_REQUIRED = { RIDING: true, FLOOR_REVEAL: true, FLOOR: true };

let current = 'BOOT';

const DEV = (() => {
  try {
    const loc = window.location;
    const host = String(loc.hostname || '');
    if (host === 'localhost' || host === '127.0.0.1') return true;
    return /[?&]debug(?:=|&|$)/.test(String(loc.search || ''));
  } catch {
    return false;
  }
})();

const isKnownState = (s) => STATES.indexOf(s) >= 0;
const isValidFloor = (f) => Number.isInteger(f) && f >= 1 && f <= 6;

/**
 * Floor validation (R30). Whenever payload.floor is present it must be an
 * integer in 1–6, on ANY transition; into RIDING / FLOOR_REVEAL / FLOOR it
 * is additionally mandatory. Applies to both go() and set().
 * Returns an error message string, or null when the payload is fine.
 */
function floorError(next, payload) {
  const present = !!payload && typeof payload === 'object' && 'floor' in payload;
  if (FLOOR_REQUIRED[next]) {
    if (!present || !isValidFloor(payload.floor)) {
      return `transition into ${next} requires payload.floor as an integer in 1-6`;
    }
    return null;
  }
  if (present && !isValidFloor(payload.floor)) {
    return `payload.floor must be an integer in 1-6 (got ${String(payload.floor)})`;
  }
  return null;
}

/** exit event -> enter event -> state flip (R29, exact order). */
function emitTransition(from, to, payload) {
  window.dispatchEvent(new CustomEvent('state:exit', { detail: { from, to } }));
  window.dispatchEvent(new CustomEvent('state:enter', { detail: { to, payload } }));
  current = to;
}

/** Dev mode throws; production warns and ignores (R32). Never emits. */
function rejectIllegal(message) {
  if (DEV) throw new Error(`[state] ${message}`);
  console.warn(`[state] ${message}`);
}

/**
 * go(nextState, payload) — R29. Validates the edge from the current state
 * against the graph (R28) and the floor rules (R30), then emits
 * state:exit / state:enter and updates the current state.
 */
export function go(next, payload) {
  if (!isKnownState(next)) {
    rejectIllegal(`unknown state "${String(next)}"`);
    return current;
  }
  if (GRAPH[current] !== next) {
    rejectIllegal(`illegal transition ${current} -> ${next}`);
    return current;
  }
  const badFloor = floorError(next, payload);
  if (badFloor) {
    rejectIllegal(badFloor);
    return current;
  }
  emitTransition(current, next, payload);
  return current;
}

/**
 * set(state, payload) — R31, the forced path. Bypasses graph validation
 * (any state may be entered from any state) but still performs floor
 * validation and emits the same event shapes as go(). Reserved for the
 * debug harness and window.__lift.
 */
export function set(next, payload) {
  if (!isKnownState(next)) {
    rejectIllegal(`unknown state "${String(next)}"`);
    return current;
  }
  const badFloor = floorError(next, payload);
  if (badFloor) {
    rejectIllegal(badFloor);
    return current;
  }
  emitTransition(current, next, payload);
  return current;
}

// Dev-only inspection/jump surface (R34). Never attached in production.
if (DEV) {
  window.__lift = {
    go: (next, payload) => go(next, payload),
    set: (next, payload) => set(next, payload),
    state: () => current,
  };
}
