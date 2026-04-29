# Visualisation Layer — Test Plan

*Last updated: 2026-04-27*

Test suite for the **3D Globe view's camera, controls, and playback interactions** — the area that has churned the most across recent commits and where regressions hide easily because the WebGL canvas can't be DOM-inspected.

## Tooling

No paid services needed.

| Layer | Tool | Notes |
|---|---|---|
| Browser automation | `puppeteer-core` against the user's installed Chrome | Already vendored at `/c/Users/Guddu/AppData/Local/Temp/bb-test/`. Free, local. |
| State inspection | Tests evaluate JS in the page that reads `window.__viewerState` (a dev-only export) | The `smooth` ref + Cesium `viewer.camera` are otherwise unreachable from DOM. |
| Input simulation | Puppeteer's `page.mouse` + `page.keyboard` + custom `WheelEvent` dispatch | Real DOM events go through the same handlers a user would trigger. |
| Visual diff (subjective) | `page.screenshot()` with golden images committed to `tests/golden/` | For things like "does the path look wavy?" — automated comparison plus human review when threshold exceeded. |

**What can be fully automated:** state assertions (camera distance, heading, mode toggles, smooth.userDistOverride flag, viewer.trackedEntity), behaviour over time (camera distance after 2 s of playback at 5×), event-driven transitions (mousedown switches to manual mode).

**What still needs human review:** subjective smoothness, perceived "feel" of the camera, anti-aliasing of the path, animation easing.

Conservative split: ~30 of ~40 test cases below run without human input. Run automated suite on every PR; spot-check the subjective handful before tagging a release.

---

## ⚠ Headline class: stability invariants + fuzz testing

**The most important tests in this suite are not the named cases below — they're the invariants checked after every action in every test, plus the fuzz runs that combine actions randomly.** Reported real-world failures look like:

- Camera endlessly zooms out, never settles, aircraft lost in space.
- Camera pans away into the distance and never recovers — craft no longer visible.
- Happens both desktop + mobile, intermittently, after some unlucky combination of scroll + scrub + speed-change + mode-toggle.

These are **invariant violations**, not test-condition failures. A specific test case for "scroll then play at 60×" can pass while a different sequence (drag → wheel → scrub backward → 60× → scroll → pause) breaks the same invariants. The suite therefore has TWO layers of defense:

### Layer 1: post-condition invariants (run after EVERY action in every test)

Five must-always-hold conditions. If any one fails, the test fails immediately and the failure dump records the action sequence that produced it.

| ID | Invariant | Programmatic check |
|---|---|---|
| **INV-1** | `smooth.dist` is finite and in `[50, 5000]` | `Number.isFinite(d) && d >= 50 && d <= 5000` |
| **INV-2** | Camera position to aircraft position is < 10 km | `Cesium.Cartesian3.distance(viewer.camera.positionWC, aircraft.position.getValue(now)) < 10000` |
| **INV-3** | Aircraft projects to a finite point on screen | `cartesianToCanvasCoordinates(...)` returns `{x, y}` both finite |
| **INV-4** | `smooth.pos`, `smooth.hdg`, `smooth.dist` all finite (no `NaN` propagation) | `Number.isFinite()` on each field |
| **INV-5** | Mode flags consistent: `autoRef.current` matches the `.globe-auto-btn.active` class state | `autoRef === btn.classList.contains('active')` |

If a state ever leaves the legal box defined by the invariants, the camera is one frame away from "fly away" mode (because the next preRender uses that broken state for the next lerp, compounding the error). Catching it at the boundary is much easier than catching it after multiple frames of accumulated drift.

### Runtime fly-away guard (production code, not just tests)

Two layers of runtime protection ship in `GlobeView.jsx`:

**1. Smooth-state guard (auto + manual mode):** the preRender callback runs the same family of checks every frame and **automatically resets the camera back to auto view** when state has been bad for 8 consecutive frames (~130 ms at 60 fps). Recovery: clear `smooth.pos/hdg/dist`, drop `userDistOverride`, force `autoRef=true`, reset `lookAtTransform` to IDENTITY. A 1-second cooldown prevents recovery storms. Each recovery increments `window.__flyAwayCount` for diagnostics.

Watched conditions (more permissive than INV-1..4 to avoid false positives during legitimate transients like flyTo or scrub teleport):

- `smooth.dist` non-finite, or `< 40`, or `> 5500`
- `smooth.hdg` non-finite
- `smooth.pos` x/y/z non-finite
- `viewer.camera.positionWC` x/y/z non-finite
- `cam-to-aircraft` distance > **12 km** in auto mode, > **100 km** in manual mode

**2. Manual-mode offset clamp (every preRender):** while in manual mode the camera's local position (the orbit offset relative to the aircraft's ENU frame) is hard-clamped to **5 km** before the per-frame `lookAtTransform` re-projection. Without this clamp, the `_setTransform` reprojection of a stale offset could amplify wildly across frames, producing the 1+ million-metre runaways the fuzz first surfaced. With it, even adversarial action sequences (`togglePlay → wheelDown → navZOut`-style) stay within INV-2 bounds.

Test cases **G1–G4** in the harness directly inject corruption via `window.__viewerCorrupt` and assert the guard recovers within 450 ms. **N1–N8** verify nav-widget zoom/rotate/tilt buttons stay bounded under various holds + post-release. **D1–D4** verify mouse drag enters manual cleanly and the camera doesn't drift after release.

### Layer 2: fuzz / property-based testing

After running every named test below, the harness runs a **fuzz loop**: 200 randomly-ordered interactions per seed, 20 seeds, ~4000 total actions per run. Action menu:

- Scroll wheel up / down (varying `deltaY` 50–500)
- Mouse drag (varying length / direction)
- Right-click drag
- Click auto-toggle button
- Click random nav-widget button (rotate, tilt, zoom)
- Drag timeline scrubber to random t
- Toggle play/pause
- Set speed to random value from `[0.5, 1, 2, 5, 10, 30, 60]`
- Wait 0–500 ms (so actions can overlap with playback frames)

After each action: assert all invariants. Capture screenshots every 50 actions for visual diff.

If a fuzz seed causes an invariant break, the harness writes the **exact action log** to `tests/fuzz-failures/<seed>.json` so it can be replayed deterministically.

### Layer 3: mobile-touch fuzz

Same as Layer 2 but with `page.touchscreen` instead of `page.mouse`. Touch behaves differently — pinch-zoom hits a different code path than wheel-zoom; touch-drag on a `.nav-btn` may register as a click on iOS Safari. These have been the source of the mobile-specific fly-aways the user reported.

### Release gate

Before any tag push, the harness runs:

1. Every named test below — must pass.
2. Fuzz desktop — 20 seeds × 200 actions × INV checked after each.
3. Fuzz mobile — same, with touch.

Any invariant violation = **release blocked**. Failure dump → ticket → fix → re-run.

---

## Setup conventions

- **Test target**: `http://localhost:5577/` (local preview) or `https://www.narenana.com/log-viewer/` (production).
- **Sample log for tests**: `LOG00009.TXT` (5 MB iNAV, 113 s flight) — small enough to parse fast (~0.5 s), real enough to exercise GPS interpolation.
- **Browser**: headless Chromium, viewport 1280×800.
- **Pre-flow before each test**:
  1. Navigate to viewer URL with cache disabled
  2. Drop log file via `input[type=file]`
  3. Wait for `.summary-cta` selector
  4. Click "Proceed to visualisation"
  5. Wait for `.globe-wrap canvas` to be present and `viewer.scene.preRender` event to have fired at least once

---

## Test cases

Status legend: ✅ passing, ❌ failing, ⚠ flaky / needs investigation, ⏳ implementation-pending, 👁 subjective (human required).

### A. Auto-mode camera follow (baseline behaviour)

#### A1 — Aircraft in frame at every playback speed

| Field | Value |
|---|---|
| Pre-conditions | Auto mode active. Playback paused. `smooth.userDistOverride === false`. |
| Action | For each speed in `[0.5, 1, 2, 5, 10, 30, 60]`: set speed, play 3 s, screenshot, pause. Read aircraft model's screen-space bounding box from `viewer.scene.cartesianToCanvasCoordinates(aircraft.position)`. |
| Expected | Aircraft's projected canvas position stays within the centre 60 % of the viewport at every speed (camera "glued"). |
| Current behaviour | ✅ Camera tracks correctly at all speeds since `e93a4e9` raised teleport threshold to 200 and added speed-scaled damping. At 30× and 60× the camera is essentially snapping each frame. |
| Automation | Programmatic — read camera + aircraft positions, assert distance / projection. |

#### A2 — Camera distance lerps to speed/altitude target when not overridden

| Field | Value |
|---|---|
| Pre-conditions | Auto mode. `userDistOverride === false`. Aircraft at low altitude, low speed. |
| Action | Play to a high-altitude, high-speed segment (~30–60 s into the flight for LOG00009). Sample `smooth.dist` every 100 ms. |
| Expected | `smooth.dist` smoothly increases from ~150 toward ~600 as `speed × 5 + alt × 1.5 + 150` rises. No jumps > 30 m between consecutive frames. |
| Current behaviour | ⏳ Not yet automated — believed correct based on code reading. |
| Automation | Programmatic. |

#### A3 — Heading deadband prevents jitter on small turns

| Field | Value |
|---|---|
| Pre-conditions | Aircraft cruising along a near-straight segment. |
| Action | Play 5 s. Record `smooth.hdg` every frame. |
| Expected | `smooth.hdg` does NOT change while target heading deviates < 45° from current — only follows on bigger turns. Total heading change over the 5 s window is < 5° if the aircraft's actual heading changed by < 45°. |
| Current behaviour | ⏳ Not yet automated — implemented in `GlobeView.jsx` line ~568. |
| Automation | Programmatic. |

---

### B. Wheel zoom in auto mode

#### B1 — Single scroll-down zooms out by ~15 %

| Field | Value |
|---|---|
| Pre-conditions | Auto mode. Playback paused. Initial `smooth.dist = D₀`. |
| Action | Dispatch single `WheelEvent { deltaY: 100 }` over the globe canvas. |
| Expected | `smooth.dist ≈ D₀ × 1.15` within 1 frame. `smooth.userDistOverride === true`. Auto mode still active (`autoRef.current === true`). |
| Current behaviour | ✅ Verified manually post-`8389a44`. |
| Automation | Programmatic — dispatch `WheelEvent`, read state. |

#### B2 — Single scroll-up zooms in by ~13 %

Same as B1 but `deltaY: -100`. Expected `smooth.dist ≈ D₀ × 0.87`.

#### B3 — Zoom respected through speed changes

| Field | Value |
|---|---|
| Pre-conditions | Scroll once to `smooth.dist = 250`. `userDistOverride === true`. |
| Action | Set speed to 60×. Play for 3 s. |
| Expected | `smooth.dist` remains in `[200, 300]` range (no auto pull-back, no teleport reset). |
| Current behaviour | ✅ Fixed in `8389a44` — teleport threshold raised to 200 + override flag check inside teleport branch. **Regression target: this exact bug was reported on the 28th.** |
| Automation | Programmatic. |

#### B4 — Zoom respected through timeline scrub

| Field | Value |
|---|---|
| Pre-conditions | Scrolled to `smooth.dist = 250`. Paused. |
| Action | Drag timeline scrubber from t=0 to t=60 s in one motion (programmatic input event). |
| Expected | After settle, `smooth.dist` ≈ 250 (camera position teleports to new aircraft location, but distance preserved). |
| Current behaviour | ✅ Fixed in `8389a44`. |
| Automation | Programmatic. |

#### B5 — Zoom clamps at lower bound

| Field | Value |
|---|---|
| Pre-conditions | Auto mode, paused. |
| Action | Dispatch 30 consecutive `WheelEvent { deltaY: -100 }` events (zoom in repeatedly). |
| Expected | `smooth.dist >= 50` (the documented lower clamp). No camera-clipping-into-aircraft, no infinity / NaN. |
| Current behaviour | ⏳ Not yet automated — clamp is in code at `Math.max(50, Math.min(5000, next))`. |
| Automation | Programmatic. |

#### B6 — Zoom clamps at upper bound

Like B5 but `deltaY: 100` × 60. Expected `smooth.dist <= 5000`.

#### B7 — Auto-toggle button releases the override

| Field | Value |
|---|---|
| Pre-conditions | Scrolled to `smooth.dist = 800` (override set). |
| Action | Click `.globe-auto-btn` to flip auto OFF, then click again to flip back to auto. |
| Expected | After the second click, `smooth.userDistOverride === false`. Within ~1 s, `smooth.dist` lerps back toward the speed/altitude-derived auto target. |
| Current behaviour | ✅ Implemented in `5d322de`'s `toggleAuto`. |
| Automation | Programmatic. |

---

### C. Mouse drag in auto mode

#### C1 — Mousedown switches to manual mode

| Field | Value |
|---|---|
| Pre-conditions | Auto mode. Paused. |
| Action | `page.mouse.down()` over the globe canvas, then `page.mouse.up()` (no movement). |
| Expected | `autoRef.current === false`. `viewer.trackedEntity === aircraftEntity`. The auto-toggle button shows the inactive state (label switches from "AUTO" to "MANUAL" or similar). |
| Current behaviour | ⏳ Believed working — mousedown handler unchanged from earlier. |
| Automation | Programmatic. |

#### C2 — Drag in auto mode orbits the camera and switches to manual

| Field | Value |
|---|---|
| Pre-conditions | Auto mode. |
| Action | `mouse.down()` at canvas centre, `mouse.move()` 200 px right, `mouse.up()`. |
| Expected | Mode flipped to manual. Camera heading changed. Aircraft still in frame. No "snap zoom" on the transition (the bug fixed in `e93a4e9`). |
| Current behaviour | ✅ Snap-zoom regression fixed in `e93a4e9`. The `releaseAuto()` function now relies on Cesium's `trackedEntity` after the mousedown. |
| Automation | Programmatic + screenshot diff for "no snap zoom" assertion. |

---

### D. Manual-mode controls (Cesium ScreenSpaceCameraController)

#### D1 — Drag rotates around aircraft

| Field | Value |
|---|---|
| Pre-conditions | Manual mode (toggled in via auto button). |
| Action | `mouse.down → move 300 px arc → up`. |
| Expected | Camera heading changes by approximately the drag angle. Aircraft stays in the frame's centre (it's the tracked entity). Aircraft's screen position before == after (within tolerance). |
| Current behaviour | ⏳ Not yet automated. Cesium's controller handles this — should work. |
| Automation | Programmatic. |

#### D2 — Right-click drag tilts pitch

| Field | Value |
|---|---|
| Pre-conditions | Manual mode. |
| Action | `mouse.down(button=right) → move 200 px down → up`. |
| Expected | Camera pitch decreases (looks more from above). Heading unchanged. |
| Current behaviour | ⏳ Not yet automated. |
| Automation | Programmatic. |

#### D3 — Wheel zooms in manual mode

| Field | Value |
|---|---|
| Pre-conditions | Manual mode. |
| Action | Dispatch `WheelEvent { deltaY: -300 }`. |
| Expected | Camera distance to aircraft decreases. No mode flip. No reset to auto. |
| Current behaviour | ⏳ Not yet automated. |
| Automation | Programmatic. |

---

### E. Nav-widget buttons

The discrete rotate / tilt / zoom buttons should always work even on touch devices that don't support drag-orbit naturally.

#### E1 — `nav-rot-l` rotates camera left while held

| Field | Value |
|---|---|
| Pre-conditions | Auto or manual mode. |
| Action | `mouse.down` on the button, hold 1 s, `mouse.up`. |
| Expected | Camera heading decreases continuously (rotating left). Aircraft remains in centre of frame. |
| Current behaviour | ⏳ Not yet automated. |
| Automation | Programmatic. |

#### E2 — `nav-rot-r`, tilt up, tilt down, zoom in, zoom out — symmetric tests

One test per button. Each: hold 1 s, expect proportional change in the appropriate camera axis.

---

### F. Speed picker × camera tracking matrix

These are the cases that bit us recently. Pair every speed with every interaction.

| Test | Speed | Interaction | Expected | Current |
|---|---|---|---|---|
| F1 | 1× | None, play 5 s | Camera follows smoothly. dist within ±10 m of auto target. | ✅ |
| F2 | 5× | None, play 5 s | Camera follows smoothly. No visible jitter. | 👁 (human review for "smoothness") |
| F3 | 30× | None, play 3 s | Aircraft stays in frame. | ✅ |
| F4 | 60× | None, play 2 s | Aircraft stays in frame. No teleport-each-frame artefacts (regression: `e93a4e9` raised threshold from 50→200). | ✅ |
| F5 | 60× | Scroll once before playing | Zoom level holds across the 2 s play (regression: `8389a44`). | ✅ |
| F6 | 0.1× | Play 30 s | Camera moves slowly with aircraft. No drift. | ⏳ |

---

### G. Timeline scrub interactions

#### G1 — Scrub forward to mid-flight while paused

| Field | Value |
|---|---|
| Pre-conditions | Paused at t=0. Auto mode. No user-set distance. |
| Action | Drag timeline scrubber thumb to t=60 s. Release. |
| Expected | Aircraft jumps to position at t=60 s. Camera teleports there (`speedFactor > 200` triggers, valid case). `smooth.dist` resets to auto target. |
| Current behaviour | ✅ Teleport branch handles this. |

#### G2 — Scrub forward while user has zoomed manually

Same as G1 but with `userDistOverride === true` from a prior scroll.

| Expected | Aircraft jumps. Camera teleports. `smooth.dist` PRESERVED at user's chosen value (regression target: `8389a44`). |
| Current behaviour | ✅ |

#### G3 — Scrub backward in time

Tests the same thing as G1 but in reverse direction. Expected: works identically; no asymmetric path-through-zero issues.

---

### H. Pause vs play interactions

#### H1 — Wheel zoom while playing at 1×

| Pre | 1× speed, playing. |
| Action | Single `WheelEvent { deltaY: 100 }`. |
| Expected | Distance immediately changes. Playback continues. Aircraft still in frame. `userDistOverride === true`. |
| Current | ✅ |

#### H2 — Wheel zoom while playing at 60×

Same as H1 but at 60×. Critical because this is where the previously-broken teleport branch was.

| Expected | Same as H1 — no teleport-induced reset. |
| Current | ✅ Fixed in `8389a44`. |

#### H3 — Pause mid-flight, then zoom

| Pre | Playing at 5×, currently at t=30 s. |
| Action | Press space (pause), then dispatch wheel. |
| Expected | Pause takes effect. Zoom adjusts distance. Camera doesn't drift after settle. |
| Current | ⏳ Not automated. Subjectively works. |

---

### I. Fullscreen toggle

#### I1 — Enter fullscreen

| Action | Click `.fullscreen-btn`. |
| Expected | Globe canvas fills viewport. Cesium calls `viewer.resize()` and the canvas backing buffer matches new dimensions. No black bars. |
| Current | ✅ Resize hook on `fullscreenchange` shipped earlier in session. |
| Note | Hard to verify dimensions exactly headless; partial visual diff. |

#### I2 — Exit fullscreen restores layout

| Action | While fullscreen, click button again. |
| Expected | Globe shrinks back to its `.globe-wrap` size. Canvas backing matches. **Regression target: earlier session reported globe didn't shrink on exit; fix used `ResizeObserver` on `.globe-wrap` plus explicit `viewer.resize()` calls. Should hold.** |
| Current | ✅ |

---

### J. View toggle (Globe ↔ Classic)

#### J1 — Switch from Globe to Classic preserves cursor time

| Pre | Playing at 1×, paused at t=45 s in Globe view. |
| Action | Click "① Classic" button. |
| Expected | View switches. Cursor stays at t=45 s. Aircraft position on 2D map matches t=45 s lat/lon. |
| Current | ⏳ Not automated. |

#### J2 — Switch back to Globe preserves cursor

Same flow in reverse. Cursor preserved.

---

### K. Sample-flight loading

These cover the entry surface (the empty-state UI we just rebranded).

#### K1 — Click "Fixed-wing flight" sample card

| Pre | Empty state showing. |
| Action | Click `.sample-card[aria-label*="Fixed-wing"]`. |
| Expected | Sample log loads via `loadLogFromUrl`. Modal opens with "Parsing log" → reveal. |
| Current | ⏳ Not automated. |

#### K2 — Click "5″ quad flight" sample card

Same as K1 with the quad sample.

#### K3 — File-format magic detection

| Action | Drop a `.csv` file vs a `.bbl` file vs a `.txt` file with the blackbox magic header. |
| Expected | CSV → `parseEdgeTXLog` path. BBL → worker path. TXT with magic → worker path. TXT without magic → CSV path tries, errors gracefully. |
| Current | ⏳ Not automated. |

---

## Open regressions captured by this suite

These are the known-fixed bugs whose tests above act as regression guards:

| ID | Bug | Fix commit | Test that catches a regression |
|---|---|---|---|
| R1 | First wheel scroll snaps to ~10 m from aircraft | `e93a4e9` | C2 (no snap zoom on mode transition) |
| R2 | Zoom level reset every 2.5 s | `8389a44` | B3 (zoom holds through 60× playback) |
| R3 | At 60× speed teleport branch wipes user zoom every frame | `8389a44` | B3, F5 |
| R4 | Path polyline waves after GPS-frame lerp commit | `06a11d2` | (visual / human review — see below) |
| R5 | Aircraft stutter every 100–200 ms (GPS frame steps) | `9ce5163` | F2 (subjective; needs eye) |
| R6 | Camera streaks off-screen at 60× | speed-scaled damping | A1, F3, F4 |

---

## Manual / subjective tests (human required)

The list below is intentionally short — these are the things automated suites can flag candidates for but can't decide.

1. **Path smoothness** — load LOG00015 (17 MB, real flight). Eyeball the flight path on the globe. Is it smooth or wavy at GPS-frame boundaries? *Pass criterion: no visible micro-S-curves.*
2. **Aircraft motion** — at 1× and 5× playback, does the aircraft glide smoothly or stutter? *Pass criterion: no visible per-frame jumps.*
3. **Camera lag** — at 30× speed, does the camera feel "glued" or "chasing"? *Pass criterion: aircraft stays roughly centred without overshoot.*
4. **Light-mode contrast** — every control (fullscreen, auto-toggle, nav widget rotate / tilt / zoom buttons) clearly visible in light theme on a bright satellite tile.
5. **Empty-state hierarchy** — drop the page in front of someone unfamiliar. Do they read "Open log files" as the primary CTA and the sample cards as demos? *Pass criterion: yes, immediately.*
6. **Mobile drag** — touch-drag on the globe in Chrome mobile devtools (simulated touch). Behaves the same as mouse drag.

---

## Roadmap for this suite

- **Phase 1 (next, this session)** — implement the harness + automate categories A, B, C, F, G, H. Gives us regression coverage for the recent fixes.
- **Phase 2** — D, E, I, J. Lower-priority, but easy to add once harness exists.
- **Phase 3** — visual diff with golden screenshots, integrated into CI on PR. Pixel-comparison can flag rendering regressions even where state is correct.
- **Phase 4** — accessibility + keyboard navigation tests (space to play/pause already implemented; verify focus management on the modal).
