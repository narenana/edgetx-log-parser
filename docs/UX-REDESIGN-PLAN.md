# RC Log Viewer — Cockpit & Interface Redesign Plan ("READOUT/72+")

*Produced 2026-06-21 from a multi-agent design review: 5 competitive-benchmark studies + 4 code-grounded audits → 3 competing design concepts → 3-lens judge panel → synthesis → adversarial engineering critique. The critique's corrections are baked into this document (see §7).*

**Status: proposal — awaiting owner approval (Phase 0 gate) before any code is deleted.**

---

## 1. Why redesign

The owner's verdict: *"not happy with the gauges and the radio controller — both can be a lot better."* The audit agreed, with measured evidence:

| Problem | Evidence (verified in source) |
|---|---|
| **Decoration outweighs data** | RcController.jsx draws antenna, speaker grille, fake buttons, trim switches, encoder — >85% of its 240×130px. The actual data: two gimbals whose stick dot moves **max 12px** (`STICK_TRAVEL = 18−6`); a 10% input = 1.2px, sub-pixel. |
| **Fake semantics** | Airspeed/altimeter color arcs are green/yellow/red at 50/80/100% **of the log's own max** (Airspeed.jsx:99-104) — a park flyer "redlines" at its own cruise speed. Only BatteryGauge has real thresholds (3.7/3.5 V/cell). |
| **Illegible type** | 4.5px "RADIOMASTER", 5px "POCKET", 6px LCD channel readouts, 6px units, 6.5px cell badge, 7px ladder labels, "NO TLM". |
| **The strip beats the hero** | Instruments (494px) + controller (240px) don't fit the 635px column at 1280×720 → flex-wrap makes a **262px two-row band under a 248px globe**. |
| **Attitude has no numbers** | The largest gauge (110px AI) is the only one with no digital readout, and silently clamps pitch to ±25°. |
| **Theme break** | Bezels/sky/ground/LCD are hardcoded hex; gauges.css deliberately keeps the strip dark in light theme — a dark slab on a white page. |
| **Backwards mobile triage** | ≤720px hides **battery** (the safety gauge) first; ≤480px applies `transform:scale(0.85)` → blurry text. |
| **Trademark exposure** | "RADIOMASTER" and "POCKET" wordmarks drawn in-product. |
| **Redundancy without role** | Altitude appears in 4 places at equal weight (gauge, dock string, stats cursor row, chart); heading in 3; no chart plots `_stick*` at all (grep-verified) — the single biggest data gap. |

## 2. Research: what the best tools do

- **Aviation glass (Garmin G1000/G3X, GI 275, Dynon)** — six steam gauges lost to integrated glass for human-factors reasons: scan cost, bezel waste, needle imprecision. Tapes + fixed digital lozenges; strict color grammar (AC 25-11B: red = real limit, amber = caution, **magenta = derived/computed**); declutter = crop elements, never shrink text.
- **FPV OSDs (Betaflight/iNAV OSD, DJI, Walksnail)** — the visual language this audience already reads in their goggles: outlined mono text tokens on the world, per-cell voltage as the #1 element, color only for real alarms, one blinking warnings slot, sacred empty center.
- **Sim racing & Blackbox Explorer input displays** — the canonical stick visualization is a **square box + dot + fading trail** (Blackbox Explorer "stick trails"); racing telemetry adds scrolling throttle/brake strip charts. Input **history** is the point — a memoryless dot can't answer "what did the pilot do before the crash."
- **Drone GCS (QGroundControl, DJI Fly, Betaflight Configurator)** — Betaflight Configurator (used weekly by this exact audience) contains **no dials anywhere** (channel bars, plain numbers); iNAV Configurator *deleted* its skeuomorphic instruments window; DJI Fly shows H/D/speed as a plain-text strip.
- **Modern gauges (Tesla/Rivian clusters, watch complications, Grafana, F1 broadcast)** — converged on **big-numeral-first**: the number IS the instrument; sparkline for context; color reserved for state; tabular numerals so digits don't shimmer.

## 3. Concepts considered & judge verdict

| Concept | Thesis | Usability | Visual | Engineering |
|---|---|---:|---:|---:|
| **HORIZON** — modern glass PFD | One integrated EFIS strip (tapes + horizon + ribbon), 164px | 35 | 36.5 | 37 |
| **GOGGLES** — FPV OSD overlay | Kill the strip; burn OSD text onto the globe; 2.25× hero | 38 | **42** | 39 |
| **READOUT/72** — data-first bar | "The number is the instrument": 72px bar of big digits + sparklines + stick boxes | **43** | 40.5 | **39** (declared winner: "safest build by a wide margin") |

**Decision: READOUT/72 as the chassis** (won 2 of 3 lenses; a log viewer is a *reading* instrument, and it's the only 100%-token-pure concept with a native light theme), **plus the judges' own grafts**:

1. GOGGLES' **fullscreen MIN-profile OSD** (today fullscreen loses *all* telemetry) — outlined text inside `.globe-wrap`, only when fullscreen.
2. GOGGLES' **home-bearing cell** (replaces the deleted heading dial).
3. GOGGLES' **warnings mirrored onto the scrubber** as scrubbable markers.
4. HORIZON's **magenta grammar** — `var(--pink)` = the single "derived/computed/pilot-set" identity (trails, future-trend, home arrow, bugs).
5. HORIZON's **6s true-future trend** on sparklines (a replay knows the future — beats real avionics).
6. HORIZON's **attitude flyout** — a real 120px horizon panel behind the ATT cell, pinned open for the fixed-wing persona.
7. HORIZON's **pinnable value bugs** shared with the dock's marker vocabulary.
8. HORIZON's **hard CI no-wrap test** (the silent-rewrap failure mode is what created the 262px band).

## 4. The spec

### 4.1 Telemetry bar (replaces all five gauges)

One opaque **72px** single-row bar, `var(--bg2)`, 1px `var(--border)` top hairline, below the canvas (no overlay → no-backdrop-filter satisfied by construction). Cells separated by 1px hairlines; **never wraps** — cells hide by explicit priority (container queries + measured-width fallback); `flex-wrap` deleted.

**Cell anatomy:** 10px uppercase label row with **provenance tag** ("ALT · BARO", "SPD · GPS" — driven by which parsed columns fed the value) → **22px mono tabular-nums value** + 11px unit → 15×56px sparkline (trailing 30s of *flight time*, see §7-B).

**Default inventory (1280px):**
- **BATT** (104px) — per-cell voltage, zone-colored by the *existing* thresholds (≥3.7 green / 3.5–3.7 yellow / <3.5 red; `detectBatteryConfig` ported verbatim). "4S LiPo" badge at 10px (was 6.5px). Pack V / mAh / A secondary line. Sparkline inherits zone color + dashed red 3.5V/cell floor. **Never hidden at any tier — removed dead last, by policy** (inverts today's CSS). The only cell with default semantic color (Grafana rule: color the number, only for real thresholds).
- **ALT** (78px) — value + sparkline; vertical speed fused as an 11px signed chevron ("▲ 1.2") in magenta (derived → magenta grammar). VS currently has no persistent home anywhere.
- **SPD** (78px) — unit toggle (m/s | km/h | mph, localStorage; source is `GSpd(kmh)` — conversion required). **No color, no arcs, ever, by default** — the log-relative arcs are deleted, not restyled. Optional per-craft Vne/stall limits (localStorage) may re-enable yellow/red *on the number only*.
- **ATT** (96px) — "R +42.3°" / "P −8.1°" at 12px mono, **unclamped** (the ±25° silent clamp dies), + 26×26px roll-line micro-glyph chip. Click → **attitude flyout**: 200×140px anchored panel, real 120px horizon on new `--ai-sky`/`--ai-ground` theme tokens, roll arc, red saturation chevrons at display limits. Pinned open in the fixed-wing preset.
- **HOME** (72px, ≥1440px or via edit mode) — distance-to-launch + magenta bearing arrow (data already exists). Replaces HeadingIndicator.jsx (triple-redundant), which is deleted. *(§7-G: numeric HDG must be a default cell at 1280 for the fixed-wing persona — amended.)*
- **Edit mode** — pencil popover: any parsed field (HDG, CURRENT, RSSI/LQ, SATS, mAh), reorder, per-craft persistence; presets: Fixed-wing / Multirotor-freestyle / Instructor.

**States:** missing data → "– –" dashed, never a stale number. Real events at cursor → **WARN chip** (canonical Betaflight strings "LOW BATTERY / LAND NOW / RSSI LOW / FAIL SAFE"), 1.6Hz blink (timer-driven, §7-C), reduced-motion → solid block.

**Update contract (frozen):** `TelemetryBar.update(row)` via forwardRef from the existing preRender call site *plus a view-independent driver* (§7-A). Per-frame: textContent writes + one polyline points string per sparkline + ≤1 transform per cell. Zero React renders per frame. Cheaper than today (deletes 5 needle transforms + 5 per-frame drop-shadow filters).

### 4.2 Input module (replaces the RadioMaster illustration)

~212px at the bar's right end. **~90% of pixels carry data (vs <15% today); trademarks deleted day one.**

- **Throttle bar** — 12×56px vertical track, green fill (sim-racing convention), ticks at 25/50/75%.
- **Two 56×56px stick boxes** — square guides (the ±100/±100 input domain IS square; the circular gimbal ring lies), center crosshair, dashed 50% square. Dot: r=5px `var(--cyan)` (cyan = measured input position, app-wide). **Full box = full travel: ±23px — a 10% input = 2.3px, ~2× today, and far more with trails.** Labels "T/Y", "P/R" by function; Mode 1–4 setting (default Mode 2).
- **Trails** — the last 800ms of *flight-time* stick path (§7-B) as 3 opacity-stepped magenta polyline segments. Trails persist when paused: scrub to a crash frame and see *how the sticks arrived there* (Blackbox Explorer pattern).
- **Readout column** — 64px, four 11px mono rows ("T 78 / Y +12 / P −3 / R +45"), values dim when centered (MSFS gray-zeros). Replaces the 6px fake LCD.
- **Precision flyout** — click → 120×120px boxes (10% = 5px), 3s trail, per-axis deg/s. Frame-by-frame freestyle analysis lives here; the bar owns the glance.
- **No-data honesty** — no stick columns → **empty boxes, no dot ever** (a centered dot that wasn't measured is the most dangerous lie in crash review), 40% opacity, "NO STICK DATA IN LOG" + logging hint. Mid-log dropout → red diagonal X (EFIS convention).
- **Carried over verbatim:** `setSticks()` API, iNAV `rcCommand[1]`/EdgeTX Ele pitch-sign convention + doc comments, `Number.isFinite` guards. **Unit tests pin the sign conventions before any geometry work** (throttle 100 → top; pitch +50 → away). V2: ghost marker showing achieved gyro rate vs commanded — commanded-vs-achieved in one frame.

### 4.3 Dashboard recomposition (desktop 1280×720)

| Region | Today | New |
|---|---|---|
| View-toggle bar | 44px | **0** (segmented control absorbed into header) |
| Globe | 248px | **~488px** (~2×) |
| Cockpit | 262px | **72px** |
| Playback dock | ~150px | **~104px** (speed pills → chip+popover everywhere; event markers overlaid on the mode bar; cursor string = "T+3:42 / 12:04" only) |
| Stats panel | 203px | **~88px** (live cursor row removed — the bar is the "now" surface; aggregates only + copy-coordinates) |
| Right column | flex 50% | `clamp(420px, 40%, 620px)` — globe absorbs ultrawide surplus |

Redundancy resolved **by role**: bar = now (+30s context), charts = history, globe = geometry, stats = whole-flight aggregates, FM bar = canonical mode. Plus a **sixth synced chart: "RC Inputs"** (throttle green area; P/R/Y thin lines) — closes the verified gap that nothing plots `_stick*`. Normalize the rogue `backdrop-filter: blur(4px)` on globe buttons (and see §7-E).

### 4.4 Visual system

- **Flat, zero bezels**: `var(--bg2)` surfaces, 1px hairlines, 4px/8px radii, no gradients, no per-element drop-shadows (5 per-frame filter paints deleted).
- **Type**: one mono family, `tabular-nums` everywhere; scale 10 / 11 / 12 / 22 (+ OSD 16/20). **Hard floor 10px.** The 6–8px era and the `scale(0.85)` blur hack are abolished.
- **Color grammar (strict)**: `--text` = data default. Green/yellow/red only for *real* thresholds (battery zones, log events, user-declared craft limits). `--cyan` = measured stick position, exclusively. `--pink` (magenta) = derived/computed/pilot-set (trails, future-trend, VS chevron, home arrow, bugs). FM_COLORS stays the mode identity. Color that fires on non-events is a defect.
- **Light/dark parity**: 100% token-pure; the "instrument panels stay dark" override and every hardcoded hex die. New tokens: `--ai-sky`/`--ai-ground` only. The fullscreen OSD (white + black outline) deliberately sits outside the token system — terrain is its background.
- **Motion**: per-frame writes are raw mutations, no easing; transitions only on discrete state changes (150ms zone crossfade; 1.6Hz warn blink); all gated by the shipped `prefers-reduced-motion` work.

### 4.5 Mobile (replaces scale-hack)

Tiers by container query, real font-size/viewBox sizing, same `update(row)` path at every tier; **battery removed dead last, by policy**:
- **A ≥1440px**: full inventory + HOME; 72px.
- **B 1024–1439**: default inventory; 72px.
- **C 640–1023**: sparklines drop, values 20px, readout column drops; 64px.
- **D <640 (375×812)**: 56px four-token bar (BATT · ALT · SPD · THR%, 16px values), swipeable extras; sticks = "STICKS" chip → 200px bottom sheet with **120px boxes** (better resolution than desktop, on demand); ATT token → flyout. Chrome ~267→~210px; globe 260→~320px+.

## 5. Fullscreen OSD (GOGGLES graft, Phase 4)

When (and only when) fullscreen is active, mount an `OsdLayer` inside `.globe-wrap`: pointer-events none, **no backdrop-filter**, outlined white mono tokens (4-direction 1px black text-shadow / SVG `paint-order:stroke`) — battery per-cell (zone-colored), T+ timer, ALT/SPD, warnings slot — driven by the same `update(row)` closures. Today fullscreen loses all telemetry. Unlocks the v2 headline: client-side "Export DVR clip" (canvas-record + burned-in OSD — privacy holds).

## 6. Phased delivery

**Phase 0 — owner gate (added by critique):** visual mockup + this doc reviewed and approved *before any deletion*. The current cockpit was hand-built recently; this plan must land as an upgrade, not an indictment.

**Phase 1 — cockpit replacement** *(the ask: gauges + radio)*
1. Day-one strike: delete RADIOMASTER/POCKET wordmarks; fix "NO TLM" copy (S — shippable immediately in the existing widget).
2. Bootstrap test infra (vitest + a layout runner) — **prerequisite, M** (§7-F: no test runner exists today).
3. Extract + unit-test `stickMath.js` (sign conventions pinned) (S).
4. `TelemetryBar` shell: cell framework, frozen imperative contract, view-independent driver (§7-A), tiers, no-wrap CI (L).
5. BATT cell (semantics ported verbatim) (M).
6. ALT + SPD cells + provenance tags; fake arcs die (M).
7. ATT cell (unclamped digits + glyph) (S).
8. Input module (boxes, trails via time-window lookback §7-B, throttle bar, readout) (L).
9. **Pull the right-column clamp forward from Phase 2** (§7-D) (S).
10. Delete old cockpit + gauges.css hacks (S).

**Phase 2 — dashboard recomposition:** header absorbs view toggle (+44px); dock slims to ~104px; stats compression (*after* Classic-view parity, §7-A); two chart weights + persona ordering; backdrop-filter normalization *including `.fullscreen-btn` and the dock blur(10px)* (§7-E).

**Phase 3 — review superpowers:** RC Inputs chart (M); HOME cell (M); magenta 6s future-trend (M); warnings engine + scrubbable timeline markers (M); attitude flyout (M); stick precision flyout (M); edit mode + presets + craft limits (L); value bugs (M).

**Phase 4 — fullscreen OSD + mobile polish:** FullscreenOsd (L); mobile Tier D + sticks bottom sheet (M); cross-view parity QA + light/dark + reduced-motion + Electron sweep (M); stretch: client-side DVR export (v2 flag).

## 7. Engineering corrections (from the adversarial critique — binding amendments)

The critique verified nearly every code citation (preRender contract, gaugeUtils exports, sign-convention blocks, CSS hacks, no-stick-chart gap — all real) but **blocked the plan as written** on these; the spec above is amended accordingly:

- **A. Classic-view / no-GPS mount + driver.** The cockpit renders only inside the `viewMode===2 && log.hasGPS` branch today — so "BATT never hidden" was falsified by its biggest case, and Classic view has *no Cesium preRender* (AltitudeAttitudeView runs its own rAF). Amendment: the bar mounts at the Dashboard level (outside the globe branch) and is driven by a small view-independent ticker (the globe's preRender when present; the playback rAF otherwise). Stats/dock deduplication (Phase 2) is gated on this parity, which is **not** "free".
- **B. Flight-time, not playback-time, history.** Frame-fed ring buffers record wall-clock playback (at 60× a "30s" sparkline spans 30 min; after a scrub they contain the scrub trajectory). Sparklines and stick trails must be **time-windowed lookbacks into `rows` at the cursor's `vt`** (same accessor pattern as the future-trend, pointed backward). This is also what makes "trails persist when paused" fall out for free — and it's the only mechanism that can deliver the flagship "see how the sticks arrived at the crash".
- **C. Paused-state animation under `requestRenderMode`.** Cesium renders only on demand; a blink toggled inside preRender freezes exactly when the user pauses on a failsafe frame. The WARN blink runs on its own ~600ms `setInterval` class toggle (cheap, reduced-motion-gated), not the render loop.
- **D. Width budget at 1280.** 568px of specced content + padding/hairlines in a 635px column fails its own no-wrap test as sequenced. Amendments: right-column clamp moves into Phase 1; cell paddings re-budgeted against real glyph metrics; ATT glyph chip drops at Tier B before anything else.
- **E. Backdrop-filter sweep is incomplete.** Also strip `.fullscreen-btn` (blur 4px, over the canvas) and `.dashboard-bottom` (blur **10px** — it anchors *inside* the fullscreened `.globe-wrap`, exactly the Phase-4 scenario). Also: Cesium attribution is already `display:none` (GlobeView ~450) — nothing to "dodge", but that's a pre-existing license-compliance question to resolve properly (restore a credits line in the fullscreen OSD).
- **F. Test infra doesn't exist.** No vitest/playwright/jest, no `test` script in package.json. The "S" test items include bootstrapping a runner + CI — re-rated **M** and made an explicit Phase-1 prerequisite.
- **G. Heading needs a default home at 1280.** With HeadingIndicator deleted and HOME at ≥1440px only, crab-angle/wind review loses heading-at-cursor. Amendment: numeric HDG joins the default inventory at 1280 (a 60px cell or fused into HOME), not just edit mode.
- **H. A11y + Electron.** Keyboard/SR semantics specified for every new interactive surface (flyouts = focus-trapped popovers with Escape; edit mode = proper listbox; sparkline bugs keyboard-operable); Electron 31 named in the QA matrix (fullscreen API + container-query support).

## 8. What is deliberately kept

The single-rAF imperative architecture; BatteryGauge's semantic model (promoted to the template for *all* color); the stick sign math verbatim; `angleDelta`/`mapClamp`/`niceRoundMax`/`detectBatteryConfig`; the no-backdrop-filter rule; FM_COLORS + event markers + bookmark auto-pause; the WCAG token system (finally extended into the cockpit); the ResizeObserver `--dock-h` sync; the aviation identity — this is still a cockpit, just a 2026 one.
