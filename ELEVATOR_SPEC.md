# THE ELEVATOR — Build Specification

A discrete, floor-based portfolio. You don't scroll through a page. You **ride an elevator** to specific destinations. Each floor is a self-contained world. The navigation is tactile, mechanical, and satisfying.

This document is the complete build brief. Each phase is written as a self-contained instruction set an agent can execute without seeing the others. The **Global Contract** is shared context every phase must obey.

---

# GLOBAL CONTRACT (read before any phase)

## Hard constraints

- **No build step.** Plain HTML, CSS, and vanilla JS ES modules (`<script type="module">`). Must deploy to GitHub Pages by pushing to the repo root as-is. No npm, no bundler, no frameworks, no external CDN dependencies. Google Fonts via `<link>` is the only permitted external resource.
- **No image assets initially.** All textures (plaster, wood grain, brass, carpet) are CSS gradients, SVG filters (`feTurbulence` for grain), and layered box-shadows. Placeholder images may use inline SVG data-URIs.
- **All audio is synthesized** with the Web Audio API. Zero audio files.
- **Animation rule:** animate only `transform` and `opacity` wherever physically possible. Layout-affecting properties are forbidden inside animation loops. All motion must respect `prefers-reduced-motion` via a global `REDUCED` flag that skips transitional animation and cuts straight to the destination state.
- **Target:** evergreen desktop Chrome/Firefox/Safari + mobile Safari/Chrome. 60fps on a mid-range laptop.

## File layout (final state after all phases)

```
index.html
styles/
  base.css        ← tokens, reset, stage, shared utilities
  lobby.css       cab.css   ride.css   chrome.css
  floors/library.css  floors/workshop.css  floors/studio.css
src/
  main.js         ← boot, state machine
  state.js        ← FSM + pub/sub
  stage.js        ← scene layer manager
  motion.js       ← easing library, tween helper, REDUCED flag
  audio/engine.js ← AudioContext, master bus, unlock
  audio/sfx.js    ← synthesized one-shots (clunk, ding, clack…)
  audio/ambient.js← looping room tones
  scenes/lobby.js scenes/cab.js scenes/ride.js
  floors/library.js floors/workshop.js floors/studio.js
  chrome/returnButton.js  chrome/indicator.js  chrome/speaker.js
  content.js      ← ALL user content (name, projects, features) in one file
```

## The stage

`index.html` contains exactly one `#stage` element (100dvw/100dvh, `overflow:hidden`, fixed). Every scene is a `<section class="scene">` appended to it. `stage.js` manages a stack: `show(scene)`, `hide(scene)`, `swap(a, b)`. Scenes are DOM, not canvas.

## Scene interface (every scene/floor module must export)

```js
export function createScene(deps) {
  // deps = { state, sfx, ambient, motion, content, stage }
  return {
    el,                    // root HTMLElement (not yet attached)
    async enter(payload),  // attach + animate in. Resolve when interactive.
    async leave(),         // animate out + detach. Resolve when DOM removed.
    destroy()              // remove listeners, stop loops, release audio nodes
  };
}
```

Scenes own ALL their listeners and timers and must clean up in `destroy()`. No global listeners except in `chrome/` modules.

## State machine (`state.js`)

States: `BOOT → LOBBY → DOORS_OPENING → CAB → RIDING → FLOOR_REVEAL → FLOOR → RETURNING → CAB`. Export `go(nextState, payload)` which validates the transition, emits `state:enter`/`state:exit` events, and carries `payload.floor` (1–6) where relevant. Illegal transitions throw in dev.

## `content.js`

Single source of truth:

```js
export const SITE = { name: "CONAN", tagline: "Builder of things" };
export const FLOORS = [
  { n:1, id:"library",  label:"THE LIBRARY",  status:"open",  flash:"#e8b84b" },
  { n:2, id:"workshop", label:"THE WORKSHOP", status:"open",  flash:"#7ec8ff" },
  { n:3, id:"studio",   label:"THE STUDIO",   status:"open",  flash:"#ff9d6b" },
  { n:4, id:"garden",   label:"THE GARDEN",   status:"ghost", flash:"#7dd87d" },
  { n:5, id:"vault",    label:"THE VAULT",    status:"ghost", flash:"#b0bec9" },
  { n:6, id:"wip",      label:"",             status:"wip",   flash:"#ffb300" },
];
```

`flash` is the color glimpsed through the door crack when passing that floor. Floor modules receive their project data from here — no hardcoded content inside floor scenes.

## Design tokens (`base.css` `:root`)

```
--brass:#b08d57  --brass-hi:#e6c88a  --brass-lo:#6e5426
--mahogany:#3a2418  --mahogany-hi:#5a3a26  --steel:#8a8f94  --steel-dk:#4a4e52
--amber:#ffb54d  --cream:#efe6d5  --ink:#1a1410
--font-display: engraved serif (e.g. "Cormorant Garamond")
--font-mono: "IBM Plex Mono" (plaques, indicators, labels)
--ease-shudder: cubic-bezier(.36,.07,.19,.97)  --ease-mech: cubic-bezier(.64,.05,.36,1)
--dur-door:1.4s  --dur-clack:90ms
```

---

# PHASE 0 — Foundation & architecture

**Goal:** the skeleton. An empty but functioning state machine with keyboard-driven scene stepping, so every later phase has a harness.

**Deliverables**

1. `index.html`: `#stage`, module script to `src/main.js`, font links, `<meta viewport>` with `viewport-fit=cover`, dark background on `<body>` so nothing white flashes.
2. `styles/base.css`: tokens (above), reset, `.scene` base class (absolute fill, `visibility:hidden` until active), utility classes `.brass-text` (beveled lettering via layered `text-shadow`), `.plaque` (brass plate + engraved mono text), grain overlay (`svg feTurbulence` data-URI at 4% opacity, `pointer-events:none`, `mix-blend-mode:overlay`).
3. `src/motion.js`: `tween({from,to,duration,ease,onUpdate})` returning a cancelable promise; easings `shudder` (pre-baked keyframe function adding 2 decaying rebounds), `mech`, `soft`; `REDUCED` boolean from `matchMedia`; `prefersFrame()` helper that no-ops when REDUCED.
4. `src/state.js`: FSM exactly as specced in Global Contract, with dev-mode `window.__lift = { go, state }` handle for debugging.
5. `src/stage.js`: layer stack with `z-index` management; only top layer is `visibility:visible` unless a transition explicitly requests two visible (needed later for the ride reveal).
6. `src/main.js`: boots to `LOBBY` with a placeholder scene per state — each placeholder is a solid-color fullscreen div with the state name in mono text. **Debug harness:** number keys 0–4 jump between LOBBY / CAB / RIDING / FLOOR_REVEAL / FLOOR placeholders. This harness stays behind `?debug` query param forever.

**Acceptance criteria**

- `python3 -m http.server` at repo root → site loads, number keys cycle states, no console errors, no network requests beyond fonts.
- No libraries, no build artifacts, repo diff is purely additive.

---

# PHASE 1 — Audio engine

**Goal:** the complete synthesized sound kit. Every later phase only calls `sfx.play(name)` / `ambient.start(name)`.

**Deliverables**

1. `src/audio/engine.js`
   - Lazily create `AudioContext` on first pointer/keydown gesture (autoplay policy): show no UI, just hook `pointerdown` once on `document`.
   - Master `GainNode` (default 0.8) → compressor → destination. Buses: `sfxBus`, `ambientBus`, so ambience ducks −6dB while a one-shot plays (sidechain via gain ramp, not real sidechain compression).
   - `setMuted(bool)` persisted to `localStorage`; `M` key toggles (debug harness too).
2. `src/audio/sfx.js` — synthesize each one-shot with oscillators, filtered noise buffers, and gain envelopes. Pre-generate a 2s white-noise `AudioBuffer` once and reuse. Required sounds:
   - `clunk` — deep mechanical thunk: 60Hz sine burst + lowpassed noise snap, 180ms.
   - `ding` — brass bell: sine partials at 880/1320/2093Hz, exponential decay 1.8s, slight detune between partials for realism.
   - `clack` — split-flap flip: bandpassed noise burst (2–4kHz) 40ms + 200Hz tick. Must support rapid retrigger (pool nodes, never await).
   - `whir` — cable/motor loop: sawtooth 80→140Hz glideable + amplitude-modulated noise; expose `{setPitch(rate), stop(fadeMs)}` handle since the ride drives pitch live.
   - `doorShudder` — 600ms: rumble noise + three staggered `clunk` variants at decreasing velocity.
   - `buttonChunk` — heavy depress: 120Hz square blip + noise click, 90ms.
   - `bloop` — hover tick: 600Hz sine, 50ms, −18dB (quiet!).
   - `speakerCrackle` — 300ms bandpassed static, precedes every voice line.
   - `ding_arrive` vs `ding_depart` variants if cheap (pitch up/down 5%).
3. `src/audio/ambient.js` — looping beds, each a function building a small node graph returning `{stop()}`:
   - `lobby`: near-silence + faint room tone (lowpassed noise −40dB) + random distant creak every 8–20s.
   - `cab`: 50Hz mains hum + soft cable groan every 10–25s.
   - `library` / `workshop` / `studio`: per-floor beds are stubbed here as silence-with-one-texture; floors fill them in their own phases but MUST route through this module's API.
4. `voice(line)` helper in `sfx.js`: since no TTS files are allowed, "announcements" are lo-fi: `speakerCrackle` + a warbly filtered square-wave "mumble" pattern (rhythm matches syllable count) + the line rendered as on-screen text in the speaker's CSS. Document this clearly — it's the creative substitute for speech.

**Acceptance criteria**

- A hidden `?soundcheck` page section (or debug keys 1–9 in `?debug` mode) plays each sound on keypress.
- No sound before first user gesture; no errors in Safari (which requires `webkitAudioContext` fallback).
- Rapid `clack` x20 in one second doesn't distort (compressor catches it).

---

# PHASE 2 — The Lobby

**Depends on:** 0, 1. **Goal:** the full title-page experience up to standing before open elevator doors.

**Scene: `src/scenes/lobby.js` + `styles/lobby.css`**

Build in this order, each a commit:

1. **The wall.** Full-viewport plaster: base `#cfc6b8`, `feTurbulence` grain overlay, two large soft radial vignettes so edges fall into shadow. Slight vertical gradient (lighter at sconce height).
2. **The sconce.** Left side (~15% from left, 40% from top): small brass fixture (CSS shapes), and the key interaction — a light cone built from a large blurred radial-gradient div (`mix-blend-mode: screen`) whose position **lerps toward the cursor at 0.06/frame** (rAF loop), simulating the sconce "tracking" the visitor. A matching soft drop-shadow on all wall elements updates its offset from the same light vector. Cap the rAF cost: skip frames when cursor idle >500ms.
3. **Name lettering.** `SITE.name` centered at 45% height, `--font-display`, ~8vw, `brass-text` treatment: bevel via 4 layered text-shadows (highlight top-left from sconce direction, shadow bottom-right), plus `background-clip:text` brass gradient. Tagline below in `--font-mono`, letterspaced, engraved look (dark text + 1px light shadow below).
4. **The plaque.** Below tagline: small brass plate reading `PRESS TO CALL ELEVATOR` in engraved mono. Idle: faint 4s breathing sheen sweep. Hover: 600ms warm-up — orange radial bloom grows behind the brass (`filter: brightness` ramp + glow shadow), like a filament. Reduced motion: static highlight.
5. **The call sequence** (on plaque click, the money moment — ~6s total):
   - `t+0.0s`: `sfx.clunk` (deep, distant — lowpass it) + camera shudder: the whole scene element gets `motion.shudder` (2 rebounds, 300ms, 4px max).
   - `t+0.3s`: elevator frame **slides out of the right wall** — a `:before` "wall panel" translates right revealing the frame behind it, on hidden tracks: frame itself translates from `x:110%` to `0` with `--ease-mech` over 1.2s. Dust particles: 20 tiny divs, random drift + fade, in the light cone only.
   - `t+1.5s`: floor indicator above doors flickers on (3 opacity flickers, 120ms apart), then split-flap spin: rapid random uppercase chars at `--dur-clack` per char with `sfx.clack` each, decelerating over ~1.2s, settling on `L` + `sfx.ding`.
   - `t+2.8s`: call button (heavy brass bezel, round, right of doors) becomes interactive. On click: physical depress (translateZ/scale 0.92 + inset shadow swap, 80ms down / 200ms spring back), `sfx.buttonChunk`, amber backlight fades in and stays lit.
   - `t+3.0s`: `sfx.whir` starts quiet, `setPitch` rising over 2s as the car "approaches"; indicator counts `B2 → B1 → L`, 3 clacks each.
   - `t+5.0s`: `sfx.doorShudder` + doors open in **two uneven motions**: left door reaches 60% at 0.5s, stalls 150ms, both complete by 1.4s; right door moves at 0.85x the left's keyframe offsets. Behind them: warm amber gradient interior glow, hint of mahogany.
   - `t+6.4s`: `sfx.speakerCrackle` + voice line `"Going up."` + auto `state.go('CAB')`.
6. **Mobile:** plaque min 64px touch target; sconce tracking falls back to device-orientation (if permitted) else slow autonomous drift; entire sequence is tap-once-and-watch.

**Acceptance criteria**

- Full sequence replays identically on every load; clicking plaque twice is impossible (debounce via state).
- Light tracking is smooth at 60fps; `prefers-reduced-motion` cuts from plaque click straight to open doors.
- All timings defined as constants at top of file (a `TIMING` object) so later phases can tune.

---

# PHASE 3 — The Cab

**Depends on:** 2 (arrives via its door-open handoff). **Goal:** standing inside the elevator, choosing a floor.

**Scene: `src/scenes/cab.js` + `styles/cab.css`**

1. **Composition.** Fixed "back corner looking at the doors" perspective using layered planes: back wall (with mirror) at slight scale, side walls skewed 2–3° via `transform: perspective(1200px) rotateY(±4deg)` for parallax depth. Mouse-move creates ≤8px counter-parallax on layers (lerped, like the sconce).
2. **Surfaces:** mahogany panel walls — repeating linear-gradient wood grain + `feTurbulence` warp + vertical brass trim strips; one keyed scratch on the left panel (thin jagged SVG line, lighter wood beneath). Floor: geometric carpet via `repeating-conic-gradient` in deep red/gold, with a center-worn patch (radial mask lightening the middle); weave `SITE` initials subtly into the pattern via a low-contrast rotated text layer masked into the carpet. Ceiling: dome light — radial warm gradient + brass fixture; flicker = keyframes at 97–100% brightness, irregular via `animation-timing-function: steps()` on a long duration.
3. **The mirror.** Back wall, brass-framed, tarnished: reflected content is a flipped, darkened, blurred duplicate of the door area (cheap CSS "reflection", not live). Contains a faint static silhouette (radial-gradient figure, 8% opacity). **Premonition trick:** if the cursor dwells on the mirror 5s, crossfade the silhouette to a 600ms glimpse of the destination floor's `--flash` color + signature shape, then snap back. Cooldown 20s.
4. **Control panel.** Right wall, brass plate, 6 round concave brass buttons in a column, each with engraved number + mono nameplate beneath (`FLOORS` from `content.js` — labels must come from there):
   - `status:"open"` → soft white backlight (`box-shadow` inner + outer glow).
   - `status:"ghost"` → dark, unlit; clicking gives `sfx.bloop` + speaker line `"This floor is currently under renovation."` and nothing else.
   - `status:"wip"` (floor 6) → flashing amber backlight + **3D caution tape**: a rotated striped strip (repeating-linear-gradient yellow/black) draped across the button with its own drop shadow and a 2px sag curve; it sways 1° on a 5s loop.
   - Hover (open floors): backlight brightens + `sfx.bloop`.
   - Click: physical depress (same physics as lobby call button: 80ms down, hold 200ms, 120ms spring return), `sfx.buttonChunk`, button stays lit, panel locks, → `state.go('RIDING', {floor: n})`.
5. **Speaker grille** top-right of the door frame: rusted ring (radial gradient), hole pattern via `radial-gradient` dots. On enter: crackle + `"Please select a floor."`
6. **Floor indicator** above doors: reuse the Phase 2 split-flap as a **shared component** — extract it into `chrome/indicator.js` in this phase (refactor lobby to import it). API: `indicator.set(char, {spin:bool})`, `indicator.countThrough([chars], opts)` returning a promise.
7. **Mobile:** camera rotates to front-on (media query swaps the perspective transforms for flat layout); buttons become a vertical thumb-column, min 56px targets.

**Acceptance criteria**

- All 6 buttons render from `content.js`; changing a floor's `status` there changes the cab with no other edits.
- Pressing floor 1/2/3 transitions to `RIDING` with correct payload; ghost/wip floors do not.
- No audio overlaps badly: panel lock prevents double-press.
- `destroy()` fully stops the dome flicker, tape sway, and parallax rAF loops (verify via Performance tab — no stray rAF after leaving).

---

# PHASE 4 — The Ride

**Depends on:** 3. **Goal:** the transition engine between cab and any floor. This is the site's signature — allocate the most polish budget here.

**Scene: `src/scenes/ride.js` + `styles/ride.css`**

The ride is **not a separate visual scene** — it's a choreography layer that runs on top of the cab scene and hands off to the floor scene. Implement as `runRide({from:'L', to:3, cabScene, floorSceneFactory})`.

Sequence (target floor F, current `L` — always count `L,1,2…F`; when returning, `F…2,1,L`):

1. **Doors close** (1.6s): left door leads, right door lags 12%; they meet with `sfx.clunk` + 150ms settle shudder. Cab interior lighting dims 15% ("motor load") for 300ms.
2. **Lurch** (0.4s): whole cab `translateY` +6px then settle with `shudder` easing; `sfx.whir` fades in, pitch ramping up.
3. **Travel** (1.2s per floor passed, min total 2.5s, max 6s — tune so it never feels slow):
   - Split-flap counts through each intermediate floor, 3 clacks + settle per floor.
   - **Door-crack flashes:** a 6px vertical gap layer between door panels shows a blurred colored streak (the passing floor's `flash` color from `content.js`) sweeping vertically for 300ms as each floor passes, with a faint `clack`-synced light pulse on the cab walls.
   - Subtle continuous motion: cab `translateY` oscillates ±1.5px at 3Hz (cable vibration); lights breathe ±3%.
   - **Preloading happens here:** `floorSceneFactory()` is called at travel start; `Promise.all([minRideDuration, factory])` gates the arrival.
4. **Deceleration** (0.8s): whir pitch drops, bounce = `translateY` −4px overshoot with spring settle (brakes catching).
5. **Ding.** `sfx.ding` — full resonance, this is the payoff sound. Indicator settles on F. Speaker: `"Floor three. The Studio."` etc.
6. **The reveal** (2.2s — the key creative beat):
   - Doors crack open **one foot** (12% width), pause 500ms — through the gap: a sharp, bright sliver of the room beyond (the floor scene is ALREADY mounted behind the doors at this point, `stage` shows both layers).
   - `sfx.doorShudder` — doors grind open the rest, uneven like the lobby.
   - **Dolly push:** camera (a wrapper around the floor scene) animates `scale: 1 → 1.15` + slight `translateY` over 1.8s with soft easing — feels like stepping out. Elevator door frame remains visible at screen edges as a vignette/frame element (`chrome` layer), then settles to a persistent doorway at bottom-center.
   - `state.go('FLOOR', {floor: F})`.
7. **Return ride** is the same module with `direction:'down'`, used by Phase 8's return button.
8. **Reduced motion:** instant cut + single `ding`. **Timeout guard:** if a floor factory exceeds 8s, proceed anyway (floors render progressively).

**Acceptance criteria**

- Riding L→3 shows flashes for floors 1, 2, 3 in order with correct colors; L→1 shows one.
- Floor content is fully interactive the frame the dolly push ends (no post-reveal pop-in).
- Rapid floor selection after returning never overlaps two rides (FSM rejects illegal transitions).
- Total ride L→1 ≈ 4s, L→3 ≈ 6.5s. These are constants in `TIMING`.

---

# PHASE 5 — Floor 1: THE LIBRARY (study app)

**Depends on:** 4. **Goal:** cathedral library presenting the study app. **Content lives in `content.js` under `PROJECTS.library`** — features, screenshots (placeholder SVGs), categories.

**`src/floors/library.js` + `styles/floors/library.css`**

1. **Space.** Warm amber palette (`#2a1f14` base). Floor-to-ceiling bookshelves: repeating shelf units (CSS) receding via scaled layers (3 depth planes, parallax on mouse). Shelves hold "volumes": book spines via randomized `linear-gradient` blocks in leather tones — each spine is a content card from `PROJECTS.library.cards`; ~40 visible. Mezzanine band across the top with a spiral staircase silhouette (SVG). Parquet floor with a cool rectangular light patch cast from the elevator doorway behind.
2. **The reading table (hero).** Center: massive oak table, green banker's lamp (emissive green glass glow + warm pool of light beneath — two radial gradients). On it, **the open book**: two-page spread, pages **turn themselves** every 6s (CSS 3D `rotateY` page-flip with `transform-origin:left`, backface showing next spread). Each spread = one feature: screenshot left, text right. Hover a feature → a **bookmark ribbon drops from the top** of the page (translateY spring + slight sway) bearing detail text.
3. **The card catalog.** Left wall: wooden cabinet, ~12 tiny drawers, each labeled with a feature category (mono label holder, brass pull). Click a drawer → it slides out on metal rails (translateZ + long shadow, 400ms, `--ease-mech`) revealing a grid of feature cards inside; clicking elsewhere or the drawer again slides it back. Only one drawer open at a time.
4. **The ladder.** Rolling ladder on a brass rail, right side. Pure atmosphere: perpetual ±1.2° sway, 7s period, as if someone just stepped off.
5. **Atmosphere.** Dust motes in the lamp's light cone (15 particles, slow drift); grandfather clock: corner silhouette + `sfx` soft tick every 1s at −30dB; random page-whisper every 12–30s; wood creaks via `ambient.start('library')` (fill in the Phase 1 stub: lowpassed creaks + tick bed).
6. **Color temperature:** 2700K feel — everything warm; elevator doorway behind is the only cool light source (6500K rectangle), reinforcing "you came from somewhere else."

**Acceptance criteria**

- Book spreads render from `PROJECTS.library.features` — adding a feature in `content.js` adds a spread.
- Page-flip, drawer slide, and ribbon drop all 60fps, transforms only.
- Leaving the floor stops the clock tick, page timer, and particle loops.

---

# PHASE 6 — Floor 2: THE WORKSHOP (AI agent)

**Depends on:** 4. **Goal:** garage workshop where the project visibly *builds itself* — the agent metaphor.

**`src/floors/workshop.js` + `styles/floors/workshop.css`**

1. **Space.** Cool palette: concrete floor (gray `feTurbulence` + oil-stain radial blobs), pegboard back wall (`radial-gradient` dot grid) hung with tools. Fluorescent tubes overhead with genuine 60Hz-style flicker (opacity steps at irregular intervals, subtle); a swinging incandescent bulb over the bench (pendulum keyframes, 4s period, its light pool swings with it — sync via shared CSS custom property `--swing`).
2. **The tool wall.** Tools = the project's tech (from `PROJECTS.workshop.stack`): each a CSS/SVG silhouette with a logo etched on the handle. Idle sway on their hooks. **Click a tool → it flies to the bench** along an animated arc (JS tween on a quadratic-bezier path, 600ms, slight rotation), lands with `sfx.clunk` + tiny dust puff, and snaps into an empty slot on the prototype.
3. **The workbench (hero).** Heavy bench center-stage holding the half-built app as physical objects: sidebar = brushed-aluminum plate with engraved icons; chart = glass tubes with glowing liquid (animated `linear-gradient` fill heights, live-ish wobble); wires between components carry light pulses (dashed SVG strokes, `stroke-dashoffset` animation).
4. **The agent behavior — the signature twist:** every 9s the workshop **acts on its own**: a tool lifts off the wall by itself, floats over (ghosted slightly, brighter), installs a component, sparks fly. Speaker mumbles. This is the AI agent "working." It loops indefinitely and uses the same fly-animation path as user clicks.
5. **The deploy button.** Right side of bench: big red button under a clear flip-cover. Hover lifts the cover (rotateX spring). Click: klaxon-lite `sfx`, the whole bench flashes, spark burst (12 particles), and a **"BUILD SUCCESSFUL"** lightbox above the bench flashes on in buzzing neon (flicker-in like a real sign). Resets after 6s.
6. **Set dressing:** roll-up garage door in back with light streaks leaking under it (animated slow-moving stripes — the project "out in the world"); corner radio: click to cycle 3 lo-fi loops — synthesized chiptune-ish loops via `ambient` (simple oscillators + noise hat pattern, ~8s loops; keep them deliberately lo-fi so synthesis sounds intentional).
7. **Atmosphere:** fluorescent buzz bed, distant clanks, radio low in the mix.

**Acceptance criteria**

- Autonomous agent loop runs on a cleanable timer; never overlaps a user-initiated tool flight (queue if needed).
- Deploy sequence is re-triggerable and fully resets.
- Radio track choice persists while on the floor; stops on leave.

---

# PHASE 7 — Floor 3: THE STUDIO (podcast)

**Depends on:** 4. **Goal:** recording-studio loft presenting the podcast. Content in `PROJECTS.studio` — episodes (title, date, duration, link, cover placeholder SVG), waveform data optional.

**`src/floors/studio.js` + `styles/floors/studio.css`**

1. **Space.** Exposed brick walls (repeating brick pattern + mortar shading + variation), hardwood floor with permanently-wet paint splatters (glossy radial blobs with specular highlight dots). Warm tungsten Edison bulbs (visible filaments — tiny orange line glows) + track lights on the desk. Red darkroom glow from the corner. Elevator doorway = the only cool light, deliberately alien here.
2. **The mixing desk (hero, far wall, ~60% width).** Analog board: 8 channel strips, each = an episode or show parameter (from content). **Faders are draggable** (pointer events, translateY, detents, `sfx` soft zip on move) — dragging crossfades that channel's VU meter activity and a parameter readout (e.g., episode number prominence on the easels). VU meters: analog needles (rotated divs) bouncing to a simulated envelope — if `PROJECTS.studio.waveform` data exists use it, else a random-walk with per-channel character. Above the desk: **patch bay** — jack grid with cables as animated bezier SVG paths (slight gravity sag + sway); drag from a jack to repatch: cable follows cursor, snaps to target with a `sfx.clack`; repatching swaps which episodes feed the easels.
3. **The easels.** 3 easels around the room, canvases = "screens": episode cards — cover art, title, play button linking out (`href` from content, `target=_blank`). Live hover states; the desk's patching controls which episodes appear.
4. **The darkroom.** Corner under red safelight: a developing tray where an episode cover **resolves from white to full color over 20s** (masked gradient reveal + slight chemical-ripple distortion), then swaps to the next cover. Clicking the tray jumps to that episode.
5. **The couch.** Worn leather couch (creased radial gradients), guitar, coffee cup with ring stain, napkin with wireframe sketch (tiny SVG scribbles). Zero interactivity, 100% "someone was just here."
6. **Atmosphere:** analog hum bed + soft vinyl crackle + a faint distant bassline through the wall (lowpassed sine pulse pattern, −36dB).

**Acceptance criteria**

- Faders drag smoothly with touch + mouse; VU needles never drop frames.
- Patch bay repatching works and visibly reroutes easel content.
- Everything renders from `PROJECTS.studio.episodes`; ≥3 episodes supported, extras paginate on easels.

---

# PHASE 8 — Global chrome

**Depends on:** 5–7. **Goal:** the persistent elements that unify the building.

1. **`chrome/returnButton.js` + `chrome.css`:** fixed bottom-left on every floor (hidden in lobby/cab). Brass service button on a small wood backplate, engraved elevator glyph. Hover: amber warm-up (same filament treatment as lobby plaque). Click → `sfx.bloop` → `state.go('RETURNING')`: camera pulls back (scale 1.15→1 reverse-dolly), doors shudder closed in front of you, return ride down (`ride.js` direction down), doors open in cab, speaker: `"Going down."` / on arrival in the cab: `"Please select a floor."`
2. **`chrome/indicator.js`:** promote the split-flap to a true global: visible above the doorway frame **on floors too** (shows current floor; counts down during RETURNING). Single instance, scenes just position it.
3. **`chrome/speaker.js`:** global announcement queue — `speaker.say("First floor. The Library.")` = crackle + mumble + text line rendered in a small grille-adjacent caption (fades after 3s). Queue serializes; new urgent line truncates the queue. All voice lines from one `LINES` table.
4. **Floor 6 handling:** pressing the wip button (caution-taped) in the cab plays the full ride to 6, doors open onto the **plywood wall**: spray-stencil `UNDER CONSTRUCTION`, crossed caution tape, gap flashes (welding sparks, work-light glow, scaffold silhouette), construction SFX bed (backup beeps, drill, distant whistling — all synthesized). Clipboard on a string: click → flips up (rotateX) revealing the status card (`PROJECT / STATUS / ETA / BLOCKED / CREW` from `content.js`). **PEEK button:** speakeasy hatch swings open for 3s of construction-site glimpse → a hard-hat drone (small CSS bot) flies up and slams it shut. Doors auto-close after 5s; speaker: `"Please check back later."` → auto RETURNING.
5. **Ghost floors (4, 5):** stay dark in cab with the renovation line (per Phase 3) — no ride.

**Acceptance criteria**

- Return button present and functional on floors 1, 2, 3, and 6; identical behavior everywhere.
- Indicator continuity: enter floor 2 → shows `2`; return → counts `2,1,L`.
- Floor 6 is reachable end-to-end and self-returns.

---

# PHASE 9 — Mobile adaptation & final polish

**Depends on:** 8. **Goal:** portrait-first parity + performance + accessibility pass.

1. **Mobile adaptations:**
   - Lobby: plaque ≥64px; sconce tracking via `deviceorientation` (permission-gated) else autonomous drift.
   - Cab: front-on layout (flat, no perspective); vertical thumb-column of buttons ≥56px.
   - Ride: `navigator.vibrate` patterns — 30ms pulse per floor passed, `[80,40,200]` on ding. Guard: only after a user gesture, never on desktop, wrapped in try/catch.
   - Lobby doors: swipe-right on the door area also triggers open (in addition to plaque tap).
   - Floors: swipe/drag pans the camera within ±5% overflow (touch-pointer parallax replaces mouse parallax); return button ≥56px.
2. **Performance pass:** audit all rAF loops (sconce, parallax, particles, VU meters) — single shared rAF dispatcher in `motion.js`, per-scene subscriptions; `document.hidden` pauses everything; cap particles (lobby 20, library 15, workshop 12 sparks max live); verify no `will-change` older than needed, no box-shadow animating per-frame (animate a pre-blurred pseudo-element's opacity instead).
3. **Accessibility:** `prefers-reduced-motion` global audit (every TIMING sequence has an instant path); all interactive elements are real `<button>`s with `aria-label`s; floors operable by keyboard (tab through buttons/drawers/faders — faders get arrow-key support); a visually-hidden skip link: "Skip to floor menu" that jumps straight to the cab; sound toggle visible (small speaker icon, bottom-right) not just the `M` key.
4. **SEO/meta:** title, description, og tags with a static og:image (single allowed raster asset, optional), favicon (inline SVG elevator glyph).
5. **Final QA matrix:** Chrome/Firefox/Safari desktop; iOS Safari + Android Chrome; throttle to "Mid-tier mobile" in DevTools → ride still 55–60fps.

**Acceptance criteria**

- Lighthouse: Performance ≥90 mobile, Accessibility 100, no console errors anywhere.
- Full journey lobby→floor→return completable with keyboard only and with touch only.

---

# EXECUTION ORDER

`0 → 1 → 2 → 3 → 4` strictly sequential (shared interfaces), then `5, 6, 7` can run in parallel (independent floor modules), then `8 → 9`.

# FLOOR MAPPING

- **The Library** → study app (knowledge/cards/reading)
- **The Workshop** → AI agent (tools that move on their own)
- **The Studio** → podcast (mixing desk, VU meters with real episode data)
- Floors 4–6: ghost buttons in the cab; floor 6 gets the full under-construction treatment.

# OPEN QUESTIONS

1. **Name/tagline** — keep "CONAN / Builder of things" placeholders in `content.js` for later editing?
2. **Floor 6 clipboard content** — keep the "BLOCKED: Waiting on API v2 / too much coffee" joke copy, or supply your own?
