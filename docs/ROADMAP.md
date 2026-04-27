# EdgeTX Log Viewer — Product Roadmap

*Last updated: 2026-04-27*

## Vision

The fastest, most respectful way to understand a flight you just took — drop the SD card's CSV in your browser, see the whole flight rebuilt in 3D within five seconds, share or save without anything ever leaving your device.

The tool is a **standalone product** (browser-native, also packaged as Electron) and the **anchor product of [narenana.com](https://narenana.com)** — the umbrella domain where future RC pilot tools will live alongside it.

## Who's it for

| Persona | What they want | What we deliver today |
|---|---|---|
| **Fixed-wing pilot (iNAV)** | Replay a long cross-country, check altitude / battery margins | ✅ Full support — globe, charts, attitude indicator |
| **Multirotor pilot (Betaflight, ExpressLRS)** | Quick "did the link drop / how was the throttle" check post-flight | ⚠️ Partial — basic columns work, blackbox not yet |
| **FPV freestyle pilot** | "Show me the flight that ended in a tree" + share with friends | ⚠️ Partial — replay works, sharing manual, no DVR sync |
| **Sim-to-field beginner** | Confidence pre-flight, learn from each session | ❌ Not yet — needs guided tour, anomaly summary |
| **Hobby flight school instructor** | Show students "this is what a stall looks like in the data" | ❌ Not yet — needs annotation, comparison, teaching mode |

## North-star metric

**Sessions where a user opened a log file → played it back to the end.** Anything that doesn't increase this is a side quest. Today this is implicit (we have GA `log_loaded` + `playback_started` events; ratio is the proxy).

## Roadmap

### Now (Q2 2026 — next 0–3 months)

The "what's already nearly working / what users hit first" tier. Polish the core flow and stop people from bouncing.

#### P0 — Fix what's broken in the core loop

- **Performance for long logs** — the in-browser parser handles 5-min flights instantly but a 30-min cross-country at 10 Hz (~18 k rows) makes Chart.js stutter on first render. Move parsing to a Web Worker, virtualise the chart x-axis, sample-down the path passed to Cesium.
- **Betaflight column completeness** — current parser leans on iNAV column names. Audit Betaflight 4.4 / 4.5 SD log columns and fill gaps so the dashboard feels complete on Betaflight too.
- **Mobile fullscreen polish** — exit-fullscreen viz still occasionally flickers on iOS Safari. Replace the dual `setTimeout` resize-dispatch with a proper `ResizeObserver` listener inside Cesium's render loop (already partially there for GlobeView).
- **Saved tab session** — reopening the app loses the loaded logs. Save filename → CSV blob in IndexedDB; offer "reopen last 3" on empty state.

#### P1 — High-leverage shareability

- **MP4 export of replay** *(M)* — render the 3D globe playback to a downloadable MP4. WebCodecs in modern Chromium is fast enough; fall back to capturing canvas frames + `mediaRecorder`. Massive social/Reddit value — "look at my flight" goes from screenshot to actual video.
- **`?log=<url>` share endpoint** *(S — code already exists, needs backend)* — the URL parser is wired up but inert. Ship a tiny Cloudflare Worker that accepts a CSV upload, returns a 7-day expiring URL. Privacy-first: the user opts in to "share this log," default is decline. Drives huge traction since pilots already share flights as raw CSV in Discord — we make the URL the share unit.
- **Smart event labels in the UI** *(S)* — already detecting takeoff / RTH / land. Surface them in the chart legend and as clickable jump points in the playback dock (currently only on the flight-mode bar).
- **Annotations** *(S)* — click anywhere on the timeline → drop a note. Persist in localStorage keyed by log filename hash. Export with the share link.

#### P2 — Insights, not just visualisation

- **Pre-flight summary panel** — a one-screen post-load card: total duration, max alt, max distance from home, peak current, min voltage, weakest RSSI, RTH count, mode-time pie chart. Zero clicks needed to "know how this flight went."
- **Crash detection + zoom** — heuristics: sudden Alt drop coincident with RPM=0 / GSpd=0 / RSSI loss → mark as crash event, offer "jump to 5 s before" button. Nail this and pilots will share the link to friends to debug.

### Next (Q3 2026 — 3–6 months)

Earn loyalty. Expand log compatibility. Make the tool useful beyond the first-load curiosity.

- **Blackbox (BBL/TXT) parser** *(L)* — there's already a parked branch (`feature/blackbox-parser`). 1 kHz logs with PID/gyro/setpoint open the door to PID tuning workflows. Major effort, major payoff.
- **Compare-mode (two logs side-by-side)** — overlay flight paths on the globe, sync the playback cursors, compare charts column-for-column. Killer for "compare today's flight to a baseline" or "before vs after a tune."
- **PID-tuning assist** *(post-blackbox)* — once we have setpoint vs gyro, surface oscillations, suggest P/D direction, link to Betaflight Configurator presets.
- **DVR / goggles video sync** *(L)* — drop an MP4 alongside the CSV; user sets one sync point; the video plays alongside the 3D replay. The single most-requested FPV tool that doesn't exist as a website. (Could spin out as its own tool — see narenana.com roadmap.)
- **Multi-log tabs that survive reload** — index by filename, keep parsed copies in IndexedDB, faster than re-parsing.
- **Live tail (WebSerial)** *(experimental)* — connect to a transmitter over USB, pull telemetry in real time during a bench test. Niche but cool.

### Later (Q4 2026+ — 6–12 months)

Speculative. Worth tracking but only commit when "Next" is rock-solid.

- **Squadron view** — multiple pilots' logs at the same field/time → group flying analysis, formation visualisation.
- **AI flight insights** *(LLM-backed)* — "your battery sagged 8 % during the third throttle punch — check your C-rating" or "RSSI dropped near the SE corner at 80 m, possible obstruction." Run inference in-browser via WebLLM or via a backend with explicit upload.
- **Flight-school mode** — instructor sets exercises, student uploads logs, tool grades attempts (e.g., "hold heading ±5° for 30 s").
- **OEM API** — embed our viewer on transmitter manufacturer websites or fly-club sites via iframe + postMessage.

## What's intentionally NOT on the roadmap

- **User accounts as a hard requirement.** Logs stay client-side. Account features (saved logs, profiles) are opt-in for sharing only.
- **Server-side log storage by default.** Privacy is a feature, not a footnote.
- **Mobile apps.** PWA install + responsive web is enough; native app store distribution adds review overhead with no upside.
- **Generic flight log standard support (ULOG / ArduPilot bin)** before EdgeTX/iNAV/Betaflight is rock solid. Different audience, different tool.

## Effort tags

| Tag | Means |
|---|---|
| **S** | < 1 week of focused work |
| **M** | 1–3 weeks |
| **L** | 3–6 weeks (often involves design + iteration) |
| **XL** | Multi-month, probably its own project |

## How decisions get made

1. **The core loop must keep working.** Drop log → 3D replay → understand flight, in <30 s. Anything that breaks this gets rolled back.
2. **No upload by default.** Every share/sync feature must be explicit, opt-in, and clearly disclosed.
3. **Open-source + free.** The whole tool is MIT-licensed; we don't paywall the basics. Future revenue (if any) comes from sponsored content / affiliate / enterprise OEM integrations, not user fees.
4. **Each release ships behind a flag if risky** — see the kill-switch SW pattern from April 2026 for how we recover from a botched deploy.

## Recently shipped (changelog highlights)

- 2026-04-27 · Light + dark theme toggle (default light)
- 2026-04-27 · High-vis aircraft livery + strobing wingtip lights
- 2026-04-27 · Brighter UI palette, bigger interactive elements
- 2026-04-26 · Two demo flights (fixed-wing + 5″ quad freestyle)
- 2026-04-26 · Sticky playback dock + fullscreen toggle (mweb)
- 2026-04-26 · GA4 + Consent Mode v2
- 2026-04-26 · PWA installable + offline-capable
- 2026-04-26 · Lazy-loaded chunks (170 kB empty-state, was 1 MB)
- 2026-04-26 · Responsive layout for tablet + phone
- 2026-04-26 · Sample-flight + share-URL hook
- 2026-04-26 · Web target alongside Electron (dual build)
