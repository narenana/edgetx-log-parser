# RC Log Viewer — UX Review & Improvement Plan

*Reviewed: 2026-06-21. Method: full source read + live measurement of the production build at desktop 1280×720 and mobile 375×812 (computed styles, contrast ratios, touch-target sizes, layout boxes), plus competitive benchmarking against 6 categories of comparable tools.*

This document records a polish-focused UX audit and the prioritized plan that came out of it. Items marked **✅ shipped** were implemented on the `ux/quick-wins-polish` branch; everything else is proposed and tracked here.

---

## Overall assessment

RC Log Viewer is a competent, token-driven dashboard with a genuinely strong privacy-first (all-client-side) architecture, hand-built SVG instruments, and a polished Cesium replay. The UX is held back by three things that read as "unfinished":

1. **Inverted visual hierarchy** — the hero 3D globe is *smaller* than its own gauge strip and buried under four floating control clusters.
2. **A cluster of measured layout / contrast / accessibility defects.**
3. **An interaction model that fights analysis** — hovering a chart scrubs the whole app; a theatrical modal gates every load.

The highest-impact fixes are mostly small, mechanical changes against a clean token system. Privacy-first, local-only, and free are fully preservable throughout.

## Cross-cutting themes

1. **Inverted hierarchy** — on 1280×720 the globe canvas is 248px while the gauge strip below it is 262px, and the globe is overlaid with fullscreen + AUTO/MANUAL + a 4-button camera row + a compass/tilt/zoom widget.
2. **Inspect ≠ commit** — hovering any of the 5 charts moves the global playback cursor (`SyncedChart` `onHover→onCursorChange`), so you can't read a value without scrubbing the entire 3D scene.
3. **Accessibility is load-bearing and failing the foundations** — sub-AA contrast app-wide, no `prefers-reduced-motion`, one focus style total, a gating modal with no focus trap/Escape, and clickable `div`s unreachable by keyboard.
4. **Dishonest perceived performance** — a ~840ms theatrical 3-step animation + a mandatory "Proceed" click gates every instant CSV parse, contradicting the "replay in seconds" promise.
5. **Theme-system breaks & emoji iconography cap the polish ceiling** — the error banner is hardcoded dark-only (invisible on the default light theme); load-bearing controls render as OS emoji.
6. **Mobile is a desktop retrofit** — ~33% of a 375×812 screen is permanent chrome; `100vh` (not `dvh`); the 10px scrubber sits in the home-indicator zone; no landscape handling.
7. **Under-served personas need canonical tuning views** — per-axis step response + Freq×Throttle spectrogram — but that's a Q3 bet, behind the roadmap's P0 work.

---

## Quick wins — high impact, low effort

| # | Fix | Files | Status |
|---|-----|-------|--------|
| 1 | **Dock-overlap clipping the globe/gauge column.** Dock is 143px but layout reserved only 110px → bottom ~33px of gauges hidden. Measure the dock with a ResizeObserver → `--dock-h` CSS var → `.dashboard` padding-bottom. | `App.css`, `Dashboard.jsx` | ✅ shipped |
| 2 | **`--text3` contrast fails WCAG AA** (`#6478A0` ≈ 3.6:1 at 10–11px) across stat labels, cursor info, chart ticks, legends. Darken in both themes, drop `.drop-privacy` `opacity:0.7`, and fix the hardcoded `tickDim` hex in `SyncedChart` (Chart.js can't read CSS vars). | `App.css`, `SyncedChart.jsx` | ✅ shipped |
| 3 | **No `prefers-reduced-motion`** anywhere despite strobing wingtip lights + modal scale/pulse/bar-slide + consent slide + PWA toast. Add a global reduce block; hold strobes at baseline via `matchMedia`. | `App.css`, `GlobeView.jsx` | ✅ shipped |
| 4 | **Error banner is hardcoded dark-only** (`#2d1b1e`/`#f7768e`) → invisible/glitchy on the default light theme. Move to `--danger-*` tokens + `role="alert"` + a real focusable dismiss button. | `App.jsx`, `App.css` | ✅ shipped |
| 5 | **Chart hover hijacks the global cursor.** Make hover a passive tooltip; bind seek to **click**. Also fix the crosshair color (`#e0af68`) colliding with the Heading/Voltage series. | `SyncedChart.jsx` | ✅ shipped |
| 6 | **Theatrical 840ms gate on instant parses.** Skip straight to the summary on the sync CSV path; add Escape/Enter to dismiss the modal. Also speeds the empty-file failure path. | `FlightSummaryModal.jsx` | ✅ shipped |
| 7 | **Tab-label parser garbles 100% of loads.** `shortName()` strips the last two hyphen tokens as date+time, so both demos render `sample wi:ng` / `sample qu:ad`. Gate on the date regex; else use the basename; add `title={filename}`. | `App.jsx` | ✅ shipped |
| 8 | **No global focus style** (only `.summary-cta`). Add a global `:focus-visible` outline, with a high-contrast ring variant for globe overlays. | `App.css` | ✅ shipped |
| 9 | **Scrubber has no total-time readout** + raw `sample-fixed-wing` subtitle + redundant `Max sink -2.5 m/s` sign. Show `T+ / total`; clean derived names; `Math.abs()` sink in modal + StatsPanel. | `Dashboard.jsx`, `StatsPanel.jsx`, `FlightSummaryModal.jsx` | ✅ shipped |
| 10 | **Silent mis-parse on blackbox sniff-failure** (falls through to CSV on binary). Bail with a specific error; also error when a drop matches zero accepted types. | `App.jsx` | ✅ shipped |
| 11 | **PWA `theme-color` is dark** (`#0e1117`) while the default theme is light → dark mobile chrome over a white app. Default it light and update it on theme toggle. | `index.html`, `App.jsx` | ✅ shipped |

## Major improvements (M / L — proposed)

- **Right-size the 3D hero & consolidate its floating chrome (M).** Make the Cesium canvas the tallest element in the left column; merge AUTO/MANUAL into the camera-view row; collapse the nav widget behind a handle; auto-hide secondary chrome on idle; add a "hide 3D → full-width charts" mode. *(ArduPilot UAV Log Viewer lets you dismiss the 3D pane.)*
- **Rich keyboard transport + `?` cheatsheet (M).** ←/→ frame-step, Shift+arrow / `,`·`.` = ±1s, Home/End = takeoff/landing, `[`·`]` = prev/next event marker, `B` = bookmark, number keys = speed. Fix Space to work whenever the player has focus. *(Betaflight Blackbox Explorer is almost entirely keyboard-driven.)*
- **Client-side session persistence (IndexedDB) + "Reopen last" + URL view-state (L).** Reload currently wipes all loaded logs. Persist parsed logs; add a "Recent flights" row; serialize *view-only* state (theme/camera/time-window — never coordinates) to the URL. Roadmap P0/"saved tab session".
- **Brushable overview+detail timeline + chart zoom (L).** Twin handles set the visible window for all 5 charts; `chartjs-plugin-zoom` with linked x-pan; merge the flight-mode bar into the scrubber and make event markers clickable, labelled, focusable ticks. *(ArduPilot twin sliders; PX4 links x-axes.)*
- **Mobile dock → peek+expand sheet (L).** Peek (~56px: play + scrubber + cursor-info), drag up for the rest; scrubber to the top of the dock out of the gesture zone; `100dvh`; `env(safe-area-inset-*)` on the base rule; a landscape block.
- **Replace emoji/unicode icons with one inline SVG set (M).** `currentColor` so glyphs theme and recolor on state. Scope to load-bearing controls first.
- **"Follow" as home camera state, free-look as transient (M).** Auto-snap back to follow after idle; one-tap recenter. *(ForeFlight Glance Mode.)*
- **Tuning view for blackbox logs (L, Q3).** Per-axis step response + Freq×Throttle spectrogram, computed client-side — the canonical FPV-tuning language (PIDtoolbox / Plasmatree / Blackbox Explorer). Moves the multirotor/freestyle personas from "partial" to "served". Sequenced behind P0 per the roadmap.

## Accessibility must-fix (WCAG)

- Sub-AA contrast on `--text3` (1.4.3) — **✅ fixed**.
- No `prefers-reduced-motion` (2.3.3) — **✅ fixed**.
- Modal lacks focus trap / Escape (2.4.3) — **partial: Escape added; focus-trap proposed**.
- No global focus style (2.4.7) — **✅ fixed**.
- Clickable `div`s (tabs, mode-bar segments, event markers) keyboard-unreachable and unlabelled (2.1.1) — **proposed**.
- Error banner unthemed + non-focusable `×` (1.4.3 / 4.1.2) — **✅ fixed**.
- Charts distinguished by color only, no text alternative (1.1.1 / 1.4.1) — **proposed**.
- Range input announces "slider, 3847" instead of a time (4.1.2) — **proposed (`aria-valuetext`)**.

## Polish details (proposed)

Tint chart plot areas by flight mode (PX4) · unify units (`dBm` vs `dB`) and stat labels from one constant · helpful "No GPS" empty state + auto-select Classic for GPS-less logs · drive the blackbox progress bar from real `parsing.pct` · hide the worker diag dump behind a disclosure · clickable wordmark = home + "Close all" · 0.25× / 20× speeds · drop circled `①②` on the view toggle · thicker desktop scrubber + hover time-bubble · radius-scale token + shared `.btn` base.

---

## Competitive benchmarks

| Tool | Pattern worth borrowing |
|------|--------------------------|
| **Betaflight Blackbox Explorer** | Installable PWA; near-fully keyboard-driven (arrows step frames, I/O marks, M = measure delta+frequency); per-field smoothing/zoom; exportable "workspaces"; sync a flight video → export annotated WebM. |
| **ArduPilot UAV Log Viewer** (Cesium) | Sample-first empty state; **dismissable** 3D pane → full-width plots; twin range-sliders = brushable overview+detail *separate from* the cursor; hover reads values without hijacking playback. |
| **PX4 Flight Review** | Overview-first health card; **plot background colored by flight mode** (context, zero chrome); two-tier zoom; linked x-axes; logs are shareable URLs. |
| **PIDtoolbox / Plasmatree** | Per-axis step response + Freq×Throttle spectrogram = the FPV-tuning language; one-click PNG export; batch multi-log overlay for before/after. |
| **ForeFlight / CloudAhoy** | Speed *cycle* button (not a pill row); pinch-to-zoom scrubbing; Glance Mode auto-returns to follow; 2–3 corner readouts over the 3D view; expected-vs-actual overlays for instruction. |
| **Flightradar24 / Strava / Relive** | 3D is opt-in with sparse chrome; a zero-input "auto-tour" recap as the lean-back default; **Strava had to make replay opt-in after a privacy backlash** — keep any future sharing explicit & link-scoped. |
| **YouTube / DaVinci / DevTools Perf** | Thin scrubber that thickens on hover + thumbnail preview; chapters as a self-labelling segmented bar; JKL shuttle; explicit panel-focus outline; Shift+? cheatsheet; hover inspects without committing. |
| **Grafana / TradingView** | Shared crosshair across stacked charts; `pointer-events:none` tooltips for pure inspection; interactive legends (click-to-toggle, double-click-to-isolate). |

The throughline across **every** category: the 3D/visual is the hero with restrained chrome; *hover inspects while click/drag commits*; real keyboard transport; honest/instant entry — the four places this app currently diverges.

---

## Caveats / known gaps in this plan

- **Long-log chart performance (roadmap P0) is not yet addressed.** `Dashboard.jsx` maps every row into all 5 Chart.js datasets with no downsampling; an ~18k-row 30-min log will stutter, and the proposed chart-zoom work must follow decimation, not precede it.
- **The shareability tier is out of scope here** (MP4 export, crash-detect "jump to 5s before", compare-mode, annotations) — these are the roadmap's north-star levers and remain proposed elsewhere.
- **`?log=<url>` is a live hazard, not just dead code.** `App.jsx` fires an outbound fetch for any `?log=` param on mount and is *not* build-flagged despite the comment — it should be gated off until the opt-in backend exists, and no coordinates should ever be serialized into the URL.
- **Tab switch resets transport state.** `Dashboard` remounts on `key={filename}`, resetting cursor/view/pause — worth fixing alongside persistence.
