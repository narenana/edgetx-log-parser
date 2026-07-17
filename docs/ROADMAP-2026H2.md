# RC Log Viewer — Roadmap 2026 H2

*Produced 2026-07-16 from a 5-agent research workflow (competitor landscape, replay-UX
patterns, community demand, growth channels → synthesis) merged with the committed
backlog (docs/UX-REDESIGN-PLAN.md Phases 2–4, docs/GROWTH-PLAN.md). Supersedes the
priority ordering in docs/ROADMAP.md; that file stays as historical context.*

**North star:** pilots load a log AND play it to the end — then share it.

---

## 1. What the research changed (key findings)

1. **Betaflight 2026.6 folded Blackbox Explorer into the default configurator.**
   "Good-enough" log viewing now ships with the firmware. Our moat must stay the 3D
   replay experience + EdgeTX CSV + iNAV multi-format — never analysis parity.
2. **Our "no competitor does in-browser 3D replay" claim expired in March 2026:**
   Airdata shipped a terrain-aware 3D Flight Player with stick inputs — but it is
   cloud-upload, subscription, DJI/enterprise. **Free + private + browser + FPV is
   still entirely open.** That is the lane.
3. **PIDtoolbox's May-2024 paywall left a goodwill vacuum** (Plasmatree abandoned,
   PIDscope niche, FPVtune $9.90/upload). Free client-side step-response analysis is
   a community-capture moment — sequenced as the second act, not the identity.
4. **PIDtoolbox grew via a Joshua Bardwell collab, Discord and Patreon — not SEO.**
   Creator seeding with personalized their-own-flight replays is the highest-leverage
   launch tactic in this niche.
5. **The most common community job-to-be-done is nearly free to serve:** a
   last-known-GPS pin with copyable coordinates for finding a downed model — data we
   already parse, on terrain we already render.
6. **Open DroneLog hit 1.5k stars in months** on "free, local-first, 3D terrain" for
   DJI — validating the logbook/retention layer beyond single-flight replay.
7. **llms.txt is measurably useless** (~0.1% crawler fetch rate; Google won't support
   it) while Q&A formatting and cited statistics move AI-citation rates 25–40%. GEO
   budget goes to page structure and third-party mentions.
8. **"inav blackbox viewer" is the single most winnable search market:** iNAV's
   official viewer lags a year behind upstream, its docs punt GPS replay to a
   GPX→Google-Earth pipeline, zero hosted web tools rank — and iNAV long-range pilots
   are the heaviest GPS loggers, i.e. our ideal user.

## 2. Strategic themes

| Theme | Why |
|---|---|
| **Finish the flight** | North-star part 1. Long-log chart performance, Phase-2 dock/stats slimming, keyboard transport — what stands between "opened it" and "watched the whole flight". |
| **Crash forensics in seconds** | #1 community job: "why did it crash / where did it land". Auto events + interest strip + last-known-position pin turn 20 min of blind scrubbing into a 10-second answer — on a 3D globe nobody else has. |
| **Share the artifact** | North-star part 2 and the growth loop: every replay link, stat card, exported clip advertises the tool. Share ladder lands BEFORE the community launch wave. |
| **Own the Betaflight/iNAV 3D gap** | Betaflight bundles a viewer now; the moat is what they don't do: cinematic 3D terrain + EdgeTX + iNAV. |
| **Free tuning analytics as goodwill wedge** | The PTB-paywall vacuum. Deliberately AFTER the replay/share core. |
| **Return between flights** | Logbook, ghost compare, battery trending — retention that makes it a habit, not a crash-day utility. |

## 3. NOW (next 4–6 weeks, in order)

| # | Item | Effort | Impact |
|---|---|---|---|
| 1 | **Finish Phase 2**: dock slim (~104px; fm-bar-wrap is the 63px chunk), stats slim (~88px), backdrop-filter sweep, chart weights | M | med |
| 2 | **Long-log chart performance**: LTTB downsampling in the Chart.js pipeline (P0 from the UX review; janky charts kill play-to-the-end on 20-min logs) | M | high |
| 3 | **Keyboard transport**: J/K/L shuttle, arrow frame-step, Shift+arrow 1s, `?` shortcut overlay | S | high |
| 4 | **Last-known-position pin**: end-of-track marker, copyable lat/lon, open-in-Google-Maps, bearing+distance from home ("use this to find your quad") | S | high |
| 5 | **Share ladder step 1**: PNG flight stat card (verified max speed/alt/distance, path-shape minimap, NO map tiles, NO lat/lon) + deep links encoding `t=`/camera/view | M | high |
| 6 | **GPX/KML export** (with the terrain altitude offset) — table-stakes gap; iNAV docs literally recommend the pipeline we replace | S | med |
| 7 | **Pre-launch hygiene**: build-flag the `?log=` outbound fetch (privacy hazard), un-hide Cesium imagery attribution (license bug). HN will find both in an hour | S | med |
| 8 | **Scrubber event hopping**: `[` `]` between mode changes/markers/bookmarks, snap-to-boundary, hover mini-stats (batches with #3, same code area) | S | med |

## 4. NEXT (6–12 weeks)

| Item | Effort | Impact |
|---|---|---|
| **Auto event detection + interest-heatmap strip** under the scrubber (voltage sag, current spikes, RSSI/LQ dropouts, failsafe, GPS glitches, arming) — the highest-leverage differentiator in the research set; feeds debrief/crash-share/segments | M | high |
| **Plain-English flight debrief** ("what likely happened") anchored at detected events + hover tooltips explaining every READOUT/72 field | M | high |
| **In/Out loop region** (I/O keys) with zoom-to-range + recomputed min/max/avg for the selection | M | high |
| **Replay-to-video export** (WebM canvas capture, READOUT/72 bar burned in) + one-click cinematic flyover recap (BBE exports WebM; Telemetry Overlay charges $99; Strava paywalls Flyover — we give it away) | L | high |
| **Community launch wave**: EdgeTX manual docs PR, Oscar Liang pitch, awesome-flying-fpv PR, canonical Reddit/IntoFPV posts, creator kit + 5 personalized YouTube seeds, then Show HN | M | high |
| **Flight-path coloring by LQ/RSSI** (heatmap toggle) + lowest-link-point marker — long-range iNAV/ELRS audience; screenshots nobody else can make | S | med |
| **Mobile progressive disclosure**: slim HUD over the globe + swipe-up bottom sheet (field use between packs) | M | med |
| **IndexedDB persistence + multi-log library seed**: recent logs, auto-split multi-session .bbl, path thumbnails | M | med |
| **Fullscreen OSD completion**: telemetry text tokens (fs-dock shipped; finishes Phase 4's OSD item) | S | med |
| **GEO/content polish**: TL;DR answer blocks, comparison table vs BBE/Companion, visible dates on top-5 cluster pages; 20-query citation audit | S | med |

## 5. LATER (3–6 months)

Ghost comparison (second log, ghost aircraft, dashed traces) · Tuning view (client-side
step-response + gyro FFT with throttle-vs-frequency heatmap, framed "tune health") ·
Logbook layer (aggregate stats, auto-tagging, per-pack battery trending) · DVR/HD video
sync pane · Dual-cursor differential measurement · Per-segment stat cards ·
Keyframable camera paths feeding cinematic export · **ArduPilot .bin (XL — decide at
quarter boundary via the CSV-import probe)** · Self-contained single-HTML flight export ·
READOUT/72 discipline presets.

## 6. Explicitly NOT doing (and why)

- **DJI .txt logs** — newer logs need server-keyed decryption via DJI's API; breaks the
  100% client-side story. PhantomHelp/Airdata/Open DroneLog own that audience.
- **llms.txt / GEO snake oil** — verified ineffective; effort goes to Q&A formatting,
  stats, third-party mentions.
- **Any server-side upload, accounts, or cloud share storage** — the moment we host
  logs we're a worse-funded Airdata. Share stays fragment/gist/file-based.
- **Competing on FFT depth as identity** — Betaflight ships analysis in-box; PTB owns
  deep-tuning mindshare. We interoperate; replay-first stays the identity.
- **PX4 .ulg** — minimal audience overlap; would dilute the ArduPilot bet.
- **Discord /replay bot (for now)** — demand unverified; answer-don't-announce first.
- **michidk/awesome-fpv listing** — repo archived May 2024, dead backlink
  (Matthias84/awesome-flying-fpv is the live target, already in the wave).
- **Native mobile apps / more Electron investment** — PWA is the distribution
  advantage (BBE's own PWA move validates it); winget/Scoop are cheap CI adds only.

## 7. Open decisions

| Decision | Recommendation |
|---|---|
| App name | **Keep "RC Log Viewer" for SEO; introduce a brand name as subtitle only after launch-wave data. Never break URLs.** |
| Video export pipeline | WebM canvas-capture first (works today), WebCodecs MP4 when demand proven. |
| Share-link payload | URL-fragment compressed track for short flights; gist/file fallback documented for power users (after the `?log=` fetch is build-flagged + opt-in). |
| ArduPilot .bin | Cheap probe first (accept UAVLogViewer/blackbox-tools CSV) + watch demand a quarter; then commit or cut. |
| Higher-poly wing model | Keep current desertwing post-brightness-fix; park as polish. **Confirm the model's license/attribution before Show HN.** |
| Event-detection thresholds | Hardcoded sensible defaults now; per-craft overrides only when the logbook layer gives them a home. |

## 8. Sequencing rules (binding)

1. Phase-2 slimming completes before Phase-3 features.
2. Share ladder (PNG card + deep links) lands before the community launch wave.
3. Tuning analytics come after the replay/share core is polished.
4. Logbook/retention starts with the IndexedDB seed, not a grand design.
5. Privacy constraints are non-negotiable: no lat/lon on shared artifacts, map
   background off by default on shares, no uploads without explicit opt-in.
