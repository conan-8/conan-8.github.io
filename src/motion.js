// ============================================================================
// THE ELEVATOR — Phase 0
// src/motion.js — owner of the motion contract (R21–R26).
//
// Exports:
//   tween({ from, to, duration, ease, onUpdate }) -> Promise<{cancelled}>
//   shudder(t), mech(t), soft(t)                  — named easing curves
//   REDUCED                                       — prefers-reduced-motion flag
//   prefersFrame()                                — next-frame (or immediate)
//
// Every animated property driven through this module is transform/opacity
// only (R6), and every tween collapses to its final frame when the user has
// asked the OS for reduced motion (R7, R25).
// ============================================================================

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * shudder(t) — a sharp impulse that slams past 1, rebounds twice with
 * decaying amplitude, and settles exactly at 1.
 *
 * Shape: 1 - (1-t)^2 * cos(3πt). The quadratic window is exactly 0 at t=1
 * (so the curve lands dead on 1 with no residual), while the cosine term
 * produces two overshoot lobes above 1 — a strong one around t=1/3 and a
 * much smaller one near t=0.88 — i.e. two decaying rebounds.
 */
export function shudder(t) {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x) * Math.cos(3 * Math.PI * x);
}

/**
 * mech(t) — stiff, mechanical accelerate–decelerate with a single
 * micro-settle: a smoothstep backbone plus a small sinusoidal ripple that
 * is exactly zero at both endpoints (a slight rush mid-stroke, a slight
 * hesitation before docking).
 */
export function mech(t) {
  const x = clamp01(t);
  const backbone = x * x * (3 - 2 * x);
  const microSettle = Math.sin(2 * Math.PI * x) * x * (1 - x);
  return backbone + 0.14 * microSettle;
}

/**
 * soft(t) — smooth decelerating ease-out (quadratic). Sits on or above the
 * linear diagonal for the whole run: fast approach, gentle landing.
 */
export function soft(t) {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x);
}

/**
 * REDUCED — captured once at module load (R24). When true, no tween in this
 * module ever schedules an animation frame (R7, R25, R26).
 */
export const REDUCED = (() => {
  try {
    return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
})();

/**
 * tween({ from, to, duration, ease, onUpdate }) — R21/R22.
 *
 * Drives onUpdate(value) once per animation frame, interpolating from→to
 * over duration ms shaped by ease, and resolves { cancelled: false } when
 * the run completes. The returned promise exposes .cancel():
 *   - cancel() stops the frame loop and resolves { cancelled: true };
 *   - cancel() never rejects;
 *   - cancel() after the tween has settled is a safe no-op (the promise
 *     keeps its original resolution).
 *
 * Under REDUCED (R25): zero frames are scheduled — onUpdate(to) is called
 * exactly once, synchronously, and the promise resolves immediately with
 * { cancelled: false }.
 */
export function tween({ from = 0, to = 1, duration = 400, ease = soft, onUpdate } = {}) {
  const update = typeof onUpdate === 'function' ? onUpdate : null;

  if (REDUCED) {
    // Final frame only, no rAF traffic at all.
    if (update) update(to);
    const settled = Promise.resolve({ cancelled: false });
    settled.cancel = () => settled; // safe no-op after settle
    return settled;
  }

  let rafId = 0;
  let done = false;
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });

  const start = performance.now();

  const step = (now) => {
    if (done) return;
    const t = duration > 0 ? Math.min(1, (now - start) / duration) : 1;
    if (t >= 1) {
      // Land exactly on the endpoint — no easing drift on the final value.
      done = true;
      if (update) update(to);
      settle({ cancelled: false });
      return;
    }
    if (update) update(from + (to - from) * ease(t));
    rafId = requestAnimationFrame(step);
  };

  rafId = requestAnimationFrame(step);

  promise.cancel = () => {
    if (!done) {
      done = true;
      cancelAnimationFrame(rafId);
      settle({ cancelled: true });
    }
    return promise;
  };

  return promise;
}

/**
 * prefersFrame() — R26. Resolves on the next animation frame; under REDUCED
 * it resolves immediately without scheduling a frame.
 */
export function prefersFrame() {
  if (REDUCED) return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
