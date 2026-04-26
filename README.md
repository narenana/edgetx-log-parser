# EdgeTX Log Parser

A flight log visualiser for EdgeTX RC aircraft. Load a CSV log from your transmitter's SD card and replay the entire flight in 3D — satellite map, live attitude, synced charts.

[![EdgeTX Log Parser — video walkthrough](https://img.youtube.com/vi/6MLQCoG5t2w/maxresdefault.jpg)](https://youtu.be/6MLQCoG5t2w)

*Click the thumbnail above to watch a quick walkthrough on YouTube.*

---

## Two ways to use it

**🌐 Web app** — open in any modern browser, drop a log, done. Logs never leave your machine; parsing and rendering all happen client-side. Best for one-off viewing or sharing a quick look on someone else's computer.

**💻 Desktop app (Windows)** — installer / portable build with the full Electron shell. Same UI, file-association support, and works offline. Best for regular use.

### Web

Visit the hosted version *(domain coming soon)*. No install, no upload — your CSV is parsed in-browser with PapaParse, drawn with Cesium / Three.js / Leaflet, and discarded when you close the tab.

The web build is a PWA — on supported browsers (Chrome, Edge, modern Safari) the address bar shows an install icon. Once installed, the app shell and Cesium runtime are cached, so the viewer works fully offline thereafter. Updates show a small "Refresh / Later" prompt — they never reload mid-session.

### Desktop downloads

Grab the latest Windows build from [**Releases**](https://github.com/narenana/edgetx-log-parser/releases):

| File | Description |
|------|-------------|
| `EdgeTX Log Parser Setup x.x.x.exe` | NSIS installer — installs to Program Files with shortcuts |
| `EdgeTX Log Parser x.x.x.exe` | Portable — run directly, no install needed |

Windows x64 only.

---

## Features

- **3D Globe view** — CesiumJS globe with satellite imagery, flight path drawn at real altitude coloured by flight mode, auto-follow camera with smooth cinematic tracking
- **Classic view** — 2D map (Leaflet/OpenStreetMap) + Three.js attitude/altitude panel showing a 3D aircraft model responding to pitch, roll and yaw
- **5 synced chart panels** — attitude, altitude & vertical speed, speed & heading, battery, signal — all linked to the same timeline cursor
- **Flight animation** — 0.1× to 60× playback with 60 fps interpolation between 1 Hz data points for smooth movement
- **Smart event markers** — auto-detected takeoff, RTH on/off and landing shown on the timeline
- **Flight mode bar** — full-flight colour bar with live active-mode highlight
- **Multi-file tabs** — open several logs at once and switch between them
- Drag-and-drop log files onto the window to open them

---

## Step 1 — Enable logging in EdgeTX

Logs are not recorded by default. You need to add a Special Function to your model that tells EdgeTX to write to the SD card.

### 1.1 Open your model's Special Functions page

On your transmitter:

```
MDL → (scroll to) Special Functions
```

Or on newer EdgeTX versions: **Model Settings → Special Functions**

### 1.2 Add a logging function

Press **[+]** to add a new special function and configure it:

| Field | Value |
|-------|-------|
| **Switch** | `ON` (logs always) or any switch you prefer, e.g. `SA↑` |
| **Function** | `SD Logs` |
| **Interval** | `1.0` s (recommended — one data point per second) |
| **Active** | ✓ enabled |

> **Interval options:** `0.1 s` gives 10 Hz logs (very detailed, large files). `1.0 s` is a good balance. Values above `2.0 s` may produce jerky replays.

### 1.3 Bind to an arm switch (optional but useful)

If you want logging to start only when the aircraft is armed, set **Switch** to the same switch you use for arming. This keeps log files short and avoids recording bench time.

### 1.4 Save

Press **[Save]** / **[Enter]** to confirm. The setting persists per-model.

---

## Step 2 — Fly and retrieve the log

1. Power on your transmitter with the model loaded.
2. The log starts as soon as the configured switch activates.
3. After the flight, connect the transmitter to your PC via USB and choose **USB Storage** mode.
4. Navigate to `SD card → LOGS →` your model folder.
5. Log files are named `ModelName-YYYY-MM-DD-HHMMSS.csv` — copy them to your PC.

> **Note:** If you don't see a `LOGS` folder, make sure your SD card is formatted correctly and has free space. EdgeTX creates the folder automatically on first log write.

---

## Step 3 — Load the log in EdgeTX Log Parser

1. Launch the app.
2. Drag one or more `.csv` log files onto the window — or click **Open Log** in the top-right corner.
3. Each file opens as a tab. Click a tab to switch between flights.

---

## Using the app

### Views

Use the **① Classic / ② 3D Globe** toggle at the top of the left panel to switch views.

**3D Globe (default)**

- The flight path is drawn on a satellite map at the actual altitude recorded in the log.
- The path is colour-coded by flight mode (see legend on the timeline bar).
- An aircraft icon tracks the current playback position and rotates to match heading.
- The camera automatically follows the aircraft with a slight top-side angle.
  - Click **⊙ AUTO** in the top-right of the globe to toggle **✥ MANUAL** mode — this releases the camera so you can orbit, pan and zoom freely with the mouse. Click again to re-engage auto-follow.

**Classic**

- 2D map with GPS track, colour-coded by flight mode.
- 3D attitude panel below: a model aircraft reflects actual pitch, roll and yaw from the iNAV/Betaflight attitude data. The plane rises and falls on an altitude scale.

### Playback controls

| Control | Action |
|---------|--------|
| **▶ / ⏸** | Play / pause (also **Space bar**) |
| **0.1× … 60×** | Playback speed |
| Timeline scrubber | Drag to jump to any point |
| Flight mode bar | Click any segment to jump there |
| Event markers (▲ ⚑ ⚐ ▼) | Click to jump to takeoff, RTH events, landing |

### Charts

All five chart panels share a single cursor. Hover over any chart to move it; drag the scrubber to set it. Charts scroll vertically — battery and signal panels only appear if that data is present in the log.

---

## Supported firmware

| Firmware | GPS | Attitude (pitch/roll/yaw) | Notes |
|----------|-----|--------------------------|-------|
| iNAV | ✓ | ✓ | Full support. Tested with fixed-wing. |
| Betaflight | ✓ | ✓ | Attitude columns may vary by version |
| ExpressLRS / receiver-only | — | — | Speed, RSSI and battery only; no GPS or attitude |

The parser reads standard EdgeTX CSV column names. If a column is absent, the corresponding panel is hidden automatically.

---

## Development

```bash
# Prerequisites: Node.js 18+, Git

git clone https://github.com/narenana/edgetx-log-parser.git
cd edgetx-log-parser
npm install

# Optional: copy .env.example to .env.local and fill in tokens
cp .env.example .env.local
```

The codebase builds two targets from one source. `VITE_BUILD_TARGET` (set via `cross-env` in the npm scripts) is exposed at runtime as `import.meta.env.VITE_BUILD_TARGET` so web-only features (analytics, install prompts) can be gated cleanly.

```bash
# ── Web target (browser, hosted on Cloudflare Pages) ─────────────────────
npm run dev:web        # Vite dev server only — http://localhost:5173
npm run build          # cross-env VITE_BUILD_TARGET=web vite build

# ── Desktop target (Electron) ────────────────────────────────────────────
npm run dev            # Vite + Electron with hot reload
npm run build:desktop  # cross-env VITE_BUILD_TARGET=desktop vite build
npm run dist           # build:desktop + electron-builder (NSIS + portable)
```

Both targets share `base: './'`, so the same `dist/` works for `file://` (Electron) and for path-prefix hosting (a Cloudflare Worker on the customer site strips `/log-viewer/` and forwards to Pages).

**Env vars** — `.env.example` lists them. All `VITE_*` vars are inlined into the client bundle at build time:
- `VITE_CESIUM_TOKEN` — Cesium Ion access token (optional; falls back to ephemeral key)
- `VITE_GA_ID` — GA4 measurement ID (web build only; empty disables analytics)

**Stack:** Electron 31 · Vite 5 · React 18 · CesiumJS · Three.js · Leaflet · Chart.js · PapaParse

---

## License

MIT
