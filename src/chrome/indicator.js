// ============================================================================
// src/chrome/indicator.js — THE ELEVATOR · Phase 3 · split-flap indicator
// ----------------------------------------------------------------------------
// Owner role : Indicator part (task_id "indicator-extract") — the reusable
//              split-flap factory lifted byte-for-byte out of scenes/lobby.js
//              (R1; the old inline block at lobby.js ~L74–188).
// Rules      : S1 (frozen seam), R1/R2/R3, GATE A / R24 (spec/reconciled.md)
//
//   S1   createSplitFlap(cells, { clackMs, spinMs, onClack }) -> flap:
//          flap.set(char, {spin}) -> Promise — spin:true rattles random
//            glyphs one change per clackMs, decelerating over ~spinMs,
//            resolves when settled (immediately without spin);
//          flap.countThrough([chars], opts) -> Promise — three clack-steps
//            per transition (third lands on target), clackMs*2 mechanical
//            breath between transitions, resolves after the final settle;
//            opts MAY override the per-step timing ({ clackMs });
//          flap.cancel() — cancel every pending step;
//          flap.render(value) — right-aligned 2-cell render, uppercased
//            ('L' -> [' ', 'L']).
//   R24  lobby visuals, count timing and clack sfx identical to pre-extract.
//
// Contract : ZERO imports — no sfx, no content, no DOM creation. The clack
//            sound is an injected onClack dependency. Usable standalone by
//            scenes/lobby.js and the cab scene (cab.js).
// ============================================================================

const FLAP_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function createSplitFlap(cells, { clackMs, spinMs, onClack }) {
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
   * countThrough([chars], opts) — walk the flap through each value in order:
   * three rapid clack-steps per transition (clack each), the third landing on
   * the target. Resolves after the final settle. opts MAY override the
   * per-step timing ({ clackMs }); without opts the schedule is exactly the
   * construction clackMs (byte-identical to the original inline factory).
   */
  function countThrough(values, opts) {
    cancel();
    const token = runToken;
    const list = Array.isArray(values) ? values.slice() : [values];
    const step = opts && opts.clackMs != null ? opts.clackMs : clackMs;
    return new Promise((resolve) => {
      let at = 0;
      for (const value of list) {
        for (let k = 0; k < 3; k++) {
          at += step;
          const lands = k === 2;
          later(() => {
            if (token !== runToken) return;
            render(lands ? value : scramble(2));
            clack();
          }, at);
        }
        at += step * 2; // mechanical breath between transitions
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
