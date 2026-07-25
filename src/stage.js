// ============================================================================
// THE ELEVATOR — Phase 0
// src/stage.js — owner of the stage contract (R35–R38).
//
// Exports:
//   createStage() -> { push, remove }
//
// createStage() claims the existing #stage element (mounted by index.html;
// this module never creates it) and maintains an ordered layer stack. Each
// pushed scene's el is appended to #stage with a strictly increasing inline
// z-index (10, 20, 30, ...). Scenes never set their own z-index.
//
// Visibility is carried purely by the .scene / .scene.is-active class pair
// from styles/base.css (instantaneous visibility switches — R6 friendly):
//   - default push: only the new top layer keeps .is-active;
//   - push(scene, { overlap: true }): the previous top ALSO stays active
//     (Phase 0 never uses this; the capability exists for later phases);
//   - remove(): leave() -> destroy() -> DOM removal, in exactly that
//     order, then the single-visible-top invariant is re-asserted.
// ============================================================================

export function createStage() {
  const root = document.getElementById('stage');
  if (!root) {
    throw new Error('createStage(): no #stage element found — index.html must provide it');
  }

  const layers = []; // ordered bottom -> top
  let zTop = 0;

  /** Only the topmost remaining layer carries .is-active. */
  function assertSingleActiveTop() {
    for (let i = 0; i < layers.length; i++) {
      layers[i].el.classList.toggle('is-active', i === layers.length - 1);
    }
  }

  /**
   * push(scene, opts = {}) — R36/R37.
   * Appends scene.el to #stage, assigns the next higher inline z-index,
   * activates the layer (keeping the previous top visible too when
   * opts.overlap is truthy), then calls scene.enter(opts.payload) AFTER
   * mount + activation (R41). Returns the pushed scene.
   */
  function push(scene, opts = {}) {
    zTop += 10;
    scene.el.style.zIndex = String(zTop);
    root.appendChild(scene.el);
    layers.push(scene);

    if (opts && opts.overlap) {
      // Both the incoming layer and the previous top stay visible; the
      // newcomer sits on top via its strictly higher z-index.
      scene.el.classList.add('is-active');
    } else {
      assertSingleActiveTop();
    }

    if (typeof scene.enter === 'function') {
      scene.enter(opts ? opts.payload : undefined);
    }
    return scene;
  }

  /**
   * remove(scene) — R38. Runs scene.leave(), then scene.destroy(), then
   * detaches scene.el from the DOM — in exactly that order — and re-asserts
   * that only the top remaining layer carries .is-active. Returns undefined.
   */
  function remove(scene) {
    const i = layers.indexOf(scene);
    if (i < 0) return undefined;

    if (typeof scene.leave === 'function') scene.leave();
    if (typeof scene.destroy === 'function') scene.destroy();
    if (scene.el && scene.el.parentNode) scene.el.parentNode.removeChild(scene.el);

    layers.splice(i, 1);
    assertSingleActiveTop();
    return undefined;
  }

  return { push, remove };
}
