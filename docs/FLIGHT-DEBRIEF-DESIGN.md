# Flight Debrief — design

**Status:** DRAFT for owner review. No code until this and the test plan are approved.
**Owner decisions baked in (2026-09-28):** name = **Flight Debrief**; UX = collapsible panel under the charts; detectors run locally and automatically, AI narration is on-click with a one-time payload preview; v1 covers all four failure classes (electrical, RX/link, battery, mechanical).

---

## 1. What this is

Every loaded log gets an automatic, local, deterministic **findings pass** (the detectors), rendered as evidence cards in a Debrief panel. A **narration tier** — Cloudflare Workers AI, called from the narenana-website Worker — turns those findings into a plain-English story on request. The raw log never leaves the browser, in any tier, ever. The model input is a derived **findings JSON** of a few KB.

The origin story is a real case: a pilot's 25 MB crash log that the viewer previously called "empty." The corrected pipeline plus manual analysis produced a complete electrical forensic (mid-air power cutoff, ADC death rattle, no sag precursor, board-specific suspect list). The Debrief feature is that analysis, productised: detectors find, templates explain, the model narrates.

### Non-goals (v1)
- No PID/filter tuning advice (that is Plasmatree/PIDtoolbox territory; revisit in LATER).
- No auto-run of the AI tier — narration is always user-initiated.
- No accounts, no server-side log storage, no learning loop that uploads anything.
- No DJI/rotorflight formats beyond what the parsers already support.

---

## 2. Architecture

```
browser (log viewer, all local)                 narenana-website Worker (existing)
┌──────────────────────────────────┐            ┌──────────────────────────────┐
│ parse → rows (existing)          │            │ POST /api/debrief            │
│ detectors.js  → findings JSON ───┼── click ──▶│  validate schema (reject >8KB)│
│ templates.js  → evidence cards   │  (~2KB)    │  Turnstile check (first use) │
│ debrief panel UI                 │◀─ stream ──│  KV cache by findings hash   │
│ consent + payload preview        │            │  env.AI.run(model, prompt)   │
└──────────────────────────────────┘            │  per-IP RL + daily budget cap │
                                                └──────────────────────────────┘
```

- **Detectors** run in the viewer after parse (same place `stats` are computed today), pure functions over the row arrays + the raw decoded S-frame arrays. Zero network. Work offline, in the PWA, on desktop builds.
- **Templates** give every finding a deterministic explanation + "check this" list. They are the offline story, the quota-exhausted fallback, and the guarantee that the panel is never empty of meaning.
- **Narration endpoint** lives in the narenana-website Worker (it already has `env.AI`-capable plumbing, Turnstile availability, KV) — NOT in the Pages app, which has no bindings. CORS-allow `www.narenana.com` only. The viewer calls it with the findings JSON; the Worker streams model tokens back.
- **The findings JSON is the product's stable interface**: panel input, template input, model payload, and later the PNG share card and event-strip data source. Schema-versioned from day one.

## 3. Privacy invariants (hard rules, enforced in code + tests)

1. The log file, row arrays, and any GPS coordinate never leave the browser.
2. The findings JSON contains: no lat/lon, no craft name (header `Craft name` can be a person's name), no filename, no timestamps other than flight-relative seconds, no free-text from the log except the firmware target string (e.g. `SPEEDYBEEF405WING`) and firmware version.
3. The payload preview shows the literal JSON that will be sent, pretty-printed, before the first narration call (per-device consent, `localStorage`, revocable in the panel footer).
4. The Worker logs request metadata only (status, model, token counts) — never payload bodies.
5. Desktop/offline builds compile with the narration button absent (build flag), not hidden.

## 4. Findings schema v1 (`debrief.schema.json`)

```jsonc
{
  "v": 1,
  "context": {
    "source": "blackbox" | "edgetx-csv",
    "fw": "INAV 9.0.0",              // family + version only
    "target": "SPEEDYBEEF405WING",   // board target string
    "duration_s": 390.2,
    "cells": 4,                       // derived from vbatcellvoltage/vbatref
    "has_gps": true,
    "fields": ["vbat","amperage","impedance","imu_temp", ...]  // what was available
  },
  "findings": [
    {
      "id": "E4",                    // detector id, stable
      "class": "electrical",         // electrical | link | battery | mechanical | meta
      "severity": "critical",        // info | notice | warning | critical
      "confidence": 0.9,             // detector-assigned, honest
      "t": [389.8, 389.9],           // flight-relative seconds (null = whole flight)
      "evidence": {                   // numbers only, detector-specific keys
        "vbat_at_cutoff": 15.49,
        "vbat_stddev_5s": 0.02,
        "amps_at_cutoff": 1.3,
        "alt_agl_at_end": 845
      }
    }
  ],
  "clean": false                      // true = no warning/critical findings
}
```

Rules: `evidence` values are numbers/booleans/short enums only (schema-enforced `maxLength` on strings, no arrays of raw samples). Whole payload hard-capped at 8 KB by the Worker. Findings sorted severity-desc. A `clean: true` flight still produces `info` findings (endurance summary) so happy flights get a positive debrief.

## 5. Detector catalog (v1: 16 detectors + 1 composite layer)

Every detector declares `requires: [fields]` and silently skips when the source lacks them (EdgeTX CSV has no S-frames → electrical forensics partially unavailable there; the panel says which checks ran). Thresholds live in one `thresholds.js` with a rationale comment each — they are all tunable constants, not magic numbers.

### Electrical / power (blackbox-first)
| id | Finding | Signal | Trigger sketch |
|---|---|---|---|
| E1 | Unterminated log | decoder | sanitizer truncated ≥1 frame OR no end-marker event; evidence: frames removed, pad bytes |
| E2 | Ends mid-air | baro/GPS alt | last-valid AGL > 20 m AND no landing signature (alt slope + |vspeed| in final 3 s) |
| E3 | ADC death rattle | S-frames | final ≤3 S-frames: sagVbat < 2 V after stable > 3 V/cell, OR enum fields out of range, OR temp step > 20 °C within 1 s |
| E4 | *Composite:* instant power interruption | E1+E2+E3 + vbat σ<0.05 V over last 5 s + amps < 30 % of flight max | the Suchit signature; confidence scales with how many constituents fired |
| E5 | Degrading connection | powerSupplyImpedance | robust slope > +50 % of baseline over flight, or step > 2× median |
| E6 | In-flight brownout (recovered) | vbat | dip < 3.0 V/cell recovering < 500 ms while log continues |

### RX / link
| id | Finding | Signal | Trigger sketch |
|---|---|---|---|
| R1 | Failsafe entered | failsafePhase | any transition ≠ 0; evidence: phase, count, t-ranges |
| R2 | RX signal lost | rxSignalReceived / rxFlightChannelsValid | windows of 0 ≥ 200 ms |
| R3 | Link degrading before event | rssi (+LQ where present) | ≥ 40 % sustained decline in the 30 s before any critical finding, vs flight median |
| R4 | RC update gaps | rxUpdateRate | rate < 25 % of median for ≥ 500 ms |

### Battery health
| id | Finding | Signal | Trigger sketch |
|---|---|---|---|
| B1 | High effective IR | vbat vs amperage | per-cell sag/current ratio > 40 mΩ (warm pack norm; tunable), computed on throttle punches |
| B2 | Deep discharge at end | vbat | resting-estimate < 3.5 V/cell at log end (info at 3.6, warning at 3.5, critical at 3.3) |
| B3 | Sag-comp divergence | sagCompensatedVBat vs vbat | growing gap = pack weaker than iNAV's model expects |
| B4 | Endurance summary (always, info) | mAh/duration/avg amps | not a fault — feeds the clean-flight debrief |

### Mechanical / vibration *(experimental badge in UI)*
| id | Finding | Signal | Trigger sketch |
|---|---|---|---|
| M1 | Elevated vibration | accVib | RMS percentile bands; warn > sustained 0.5 g-equiv (tunable; needs fixture calibration) |
| M2 | Sustained oscillation | gyroADC rolling band energy | windowed std × frequency proxy above band for > 2 s in cruise (not during stick moves — gate on rcCommand rate) |

### Meta
| id | Finding | | |
|---|---|---|---|
| X1 | Clean flight | none of warning+ fired | positive summary from B4 + max stats |
| X2 | Checks skipped | requires-matrix | lists detectors that couldn't run on this source format |

**The composite layer (E4 pattern) is the "synthesis" made deterministic:** a small rule table combining detector outputs into named scenarios (instant power interruption; failsafe crash; battery exhaustion landing; vibration-degraded flight). Rules are data (`scenarios.js`), reviewed like copy, unit-tested like code.

### Board-specific advice (v1.1, data-only change)
`advice.json` keyed by `context.target` — e.g. SPEEDYBEE F405 WING → "inspect the PDB↔FC board-to-board header" appears in E4's check-list. Ships with ~5 popular wing/AIO targets; community-extendable later.

## 6. Narration tier (Workers AI)

- **Endpoint:** `POST https://www.narenana.com/api/debrief` (Worker route beside `/videos.json`). Body = findings JSON; response = SSE token stream + final `usage` frame.
- **Model:** start with an 8B-class instruct model on Workers AI; selection is an eval task in the test plan (fixture findings → rubric), not a design decision. Model id is a Worker env var so swaps need no deploy of the viewer.
- **Prompt contract:** system prompt embeds the detector taxonomy, tone rules ("incident debrief, plain English, no blame, hedge appropriately"), and the OUTPUT SECTIONS: *What happened* (≤120 words) / *The evidence* (bullet per finding id it references) / *Check before the next flight* (numbered, concrete). The model may only reference finding ids present in the payload; it never invents sensor values.
- **Guardrail:** client renders narration *below* the deterministic cards, labelled "AI narration — generated from the findings above". A post-check drops any narration paragraph naming a finding id not in the payload (belt-and-braces; cheap string check).
- **Cache:** Worker KV keyed by SHA-256 of the canonicalised findings JSON, TTL 30 d — identical findings (e.g. the same log re-opened, or a shared sample) cost zero Neurons.
- **Budget & abuse:** Turnstile token required on a device's first call; per-IP sliding-window limit (10/h) via KV; global daily Neuron counter — past the cap the endpoint returns `503 {fallback:"templates"}` and the panel shows template text with "AI narration is resting — back tomorrow." Free-plan worst case is ₹0 by construction.
- **Failure = fallback, always:** any endpoint error renders templates. The panel never blocks on the network.

## 7. UX specification

**Placement:** a `DebriefPanel` section at the top of the right column (above Altitude chart), collapsed to a one-line strip when `clean: true` ("✓ Clean flight — 6:30, 1.9 km, battery healthy · expand"), expanded by default when any warning/critical finding exists.

**Anatomy (top → bottom):**
1. Header row: `FLIGHT DEBRIEF` + severity chips (`1 critical · 2 notice`) + collapse control.
2. Finding cards, severity-sorted: icon, title (template), one-line evidence sentence with real numbers, expandable detail (evidence table + t-range "jump to" link that scrubs the timeline — reuses the bookmark-jump plumbing).
3. `✦ Explain this flight` button (primary, only when ≥1 notice+ finding, or always? → always, smaller when clean). First click → consent sheet: the literal payload, "This summary — never your log file — is sent to narenana's server (Cloudflare) to write the narration. Remember on this device." → streamed narration block with the AI label + "regenerate" (cache-busting regenerate capped at 2/flight).
4. Footer: `Checks run: 14 of 16 (2 need blackbox S-frames)` + privacy line + consent-revoke link.

**Summary modal tie-in:** one added line under the stats grid when warnings exist: `⚠ 2 findings — see Flight Debrief` (anchor-scrolls to panel after "Proceed"). No second modal page.

**Mobile:** the panel participates in the existing right-column flow; cards stack; consent sheet becomes full-screen.

**Empty/edge states:** CSV-only fields → X2 card explains reduced coverage; no battery fields at all → battery class hidden; detectors error → panel shows "Debrief unavailable for this log" and reports to Sentry (no log data attached).

## 8. Rollout

| Phase | Ships | Gate |
|---|---|---|
| D1 | schema + detectors + templates + panel (no network) | test plan green incl. fixture matrix |
| D2 | Worker endpoint + consent flow + narration + guards | model eval rubric ≥ pass on all fixtures; abuse tests green |
| D3 | advice.json board knowledge + share-card integration | D2 telemetry ≥ 1 week healthy |

Analytics (consent-gated, already live): `debrief_shown {classes, severities}`, `debrief_expanded`, `narration_requested`, `narration_completed {cached}`, `narration_fallback {reason}` — no evidence values in events.

## 9. Open questions for the owner
1. `api/debrief` on www.narenana.com implies the viewer (served from the same origin via the proxy) has no CORS friction — but latest.narenana.com and *.pages.dev previews will need an allow-list entry each. Ship narration on previews, or www-only?
2. Regenerate button: worth the Neurons, or cut it?
3. Should `clean` flights get a one-click "brag card" (ties into the roadmap PNG share card) as the debrief's happy-path payoff?
