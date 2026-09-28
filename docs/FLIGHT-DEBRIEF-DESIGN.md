# Flight Debrief — design (rev 2, post-review)

**Status:** REVIEWED — 3-lens adversarial review (engineering / privacy-abuse / pilot-UX) returned *sound-with-fixes* on all lenses; every blocker and major is integrated below and marked `[R]`. Awaiting owner sign-off before implementation.
**Owner decisions baked in (2026-09-28):** name = **Flight Debrief**; panel in the right column; detectors local + automatic; AI narration on-click with payload preview; all four failure classes in v1. Review resolved former open question #2: **regenerate is cut from v1**.

---

## 1. What this is

Every loaded log gets an automatic, local, deterministic **findings pass** (detectors), rendered as evidence cards. A **narration tier** — Cloudflare Workers AI via the narenana-website Worker — turns findings into a plain-English story on request. The raw log never leaves the browser in any tier. The model input is a derived, allowlisted, quantized **findings JSON** of a few KB.

Origin case: a pilot's 25 MB crash log the viewer called "empty." The corrected pipeline plus manual forensics produced a complete electrical diagnosis. This feature is that analysis productised: detectors find, cards prove, templates explain, the model narrates.

### Non-goals (v1)
No PID/filter tuning advice. No auto-run of the AI tier. No accounts or server-side log storage. No narration regenerate button `[R]`. No new log formats.

## 2. Architecture

```
browser (all local)                                  narenana-website Worker
┌────────────────────────────────────────┐           ┌──────────────────────────────┐
│ decode (worker) ─ mapToViewerLog       │           │ POST /api/debrief            │
│   ├ detectors run HERE, before free(): │── click ─▶│  strict schema (closed enums)│
│   │  see rows + parsed.slow*/gps* +    │  (~2KB)   │  device-token / Turnstile    │
│   │  tail-scan + truncation stats      │◀─ stream ─│  DO rate limiter + budget    │
│   └ findings attached to log object    │           │  KV cache (findings‖model‖   │
│ templates + cards + sparklines         │           │            prompt_version)   │
│ consent + always-inspectable payload   │           │  env.AI.run → post-check     │
└────────────────────────────────────────┘           └──────────────────────────────┘
```

**Integration point (normative).** `[R blocker]` Detectors execute **inside `mapToViewerLog`** — the single function all three blackbox paths share (rust-worker, rust main-thread fallback, C fallback) — receiving the mapped rows **and** the raw `parsed` object (`slowFieldNames/slowTimes/slowFrames`, `gps*`) *before* `parsed.free()`. The worker attaches `log.debrief = { findings, coverage }` to the posted result. The EdgeTX CSV path gets its own named call site at the end of `parseEdgeTXLog`. The mapper/worker contract therefore **changes** (slow arrays consumed in-worker; truncation stats returned); the test plan carries mapper-contract tests for this.

**Data-rate reality (normative).** `[R blocker]` Main frames are stride-decimated at decode (~8,000 frames regardless of file size; ≈20 Hz effective on the founding 25 MB fixture). Slow frames and GPS frames are full-rate. Every v1 detector is specified against **strided main + full-rate slow/gps**; synthetic fixtures must emulate production stride. Consequences: M2 is re-scoped (below), E6 carries a resolution caveat, and thresholds are calibrated on strided data only.

**E1 plumbing (normative).** `[R major]` The worker scans the raw byte tail for the ASCII `End of log` event marker before the buffer is transferred, and `mapToViewerLog` returns truncation stats (`droppedMain`, `droppedGps`). `context.cells` derives from a start-of-log voltage heuristic (`round(v / 4.2)`, chemistry-adjusted) — `vbatref` is not exposed by the wrappers.

## 3. Privacy invariants (hard rules, each one a test)

1. The log file, row arrays, and any GPS coordinate never leave the browser. Local-only UI (cards, sparklines, last-known-position) may use full-precision data freely; the payload may not.
2. The findings JSON contains no lat/lon, no craft name, no filename, no absolute timestamps. **All strings are allowlisted** `[R blocker]`: `context.fields` against the mapper's canonical vocabulary; `target` against `^[A-Z0-9_]{1,30}$`; `fw` extracted by strict regex (`^(INAV|Betaflight) \d+\.\d+\.\d+$` — commit hashes of personal forks fingerprint people and are dropped); reject-on-no-match, enforced client-side AND in the Worker.
3. **Evidence is quantized before sending** `[R major]`: durations and t-ranges to whole seconds, voltages to 0.1 V, altitudes to 10 m buckets, currents to 0.5 A. Templates and cards keep full precision locally; narration does not need it (a findings payload precise to 0.1 s is a unique flight fingerprint).
4. Server retention, stated honestly: the Worker keeps no request bodies in logs; the KV cache retains *generated narrations* keyed by findings-hash for 30 days; the Cloudflare edge sees client IPs as with any request to the site. The consent sheet says exactly this.
5. Consent is remembered per browser (`debrief-consent:<schema-major>`) but the payload stays **permanently inspectable** — a "view what will be sent" link sits beside the button every time, and a schema major bump forces a fresh preview `[R major]`.
6. Sentry never receives log-derived content `[R major]`: detector failures report `{detector_id, error_name}` only (never `err.message`); a `beforeBreadcrumb` hook drops console breadcrumbs that look like JSON or exceed 200 chars. **Pre-existing side-fix shipped with D1:** `captureParseError` currently sends `filename` — replace with extension + size.
7. Electron builds compile the narration tier out (button, consent, fetch — tree-shaken via `VITE_BUILD_TARGET`); the web/PWA build hides the button offline at runtime and falls back to templates `[R minor]`.
8. Analytics: `debrief_shown` carries only `{any_warning: bool}` — class/severity breakdowns never go to GA `[R minor]`. Richer aggregates live only in the narration endpoint's own first-party metadata.
9. No third-party script (including Turnstile's) loads before the user accepts the consent sheet `[R minor]`.

## 4. Findings schema v1 (`debrief.schema.json`)

Shape as rev 1 (context + findings array + `clean`), hardened `[R major]`: `additionalProperties: false` at every level; `id` a **closed enum** of the 17 detector ids; a per-id **evidence-key allowlist** (one table, generated from the catalog); `findings` maxItems 24, duplicate ids rejected; evidence values are numbers, booleans, or named enums only — no free strings. The Worker validates independently of the client; hostile-but-valid fixtures are in the test plan.

## 5. Detector catalog (v1: 16 + composite layer)

Unchanged in intent from rev 1 (same ids/classes/table), with these review amendments:

- **Every detector declares `plots: {series, window}`** — the evidence series its card renders as a local mini-sparkline (raw arrays, t-range ± 5 s, threshold annotated). `[R major ×2]` This is the falsifiability answer: no finding without a visible curve, including S-frame signals no main chart shows (impedance, sagVbat, failsafePhase). It also documents that detectors consume the raw slow arrays in-worker — sparkline slices (bounded, coordinate-free) ride along inside `log.debrief` for local rendering only.
- **E1** uses the end-marker tail scan + truncation stats (see §2). A cleanly-flushed mid-air-ending log fires E2 without E1 — the composite handles both shapes.
- **E6** carries a stated resolution limit (dip must span ≥2 strided samples; sub-100 ms brownouts are invisible at large stride) — severity `notice`, wording hedged.
- **M2 re-scoped** `[R blocker]`: gyro-band analysis is impossible at ~20 Hz effective. v1 M2 = sustained high `accVib` variance gated on low stick rate (accel-RMS proxy), badge *experimental*; true oscillation detection deferred until a full-rate windowed decode exists (vNext note).
- **B1/B2 are chemistry-aware** `[R major]`: full-charge voltage detection (≈4.2 V/cell LiPo vs ≤4.1 Li-ion) selects the threshold set (Li-ion: healthy IR 20–40+ mΩ, normal landing 3.0–3.3 V/cell), with a manual chemistry override in the panel. Without this, every Li-ion long-range wing — the founding demographic — gets a false CRITICAL per flight.
- **Per-finding acknowledge** `[R major]`: "expected for this craft" (localStorage, per-craft key like bookmarks) demotes a chronic B1/M1 warning to notice on subsequent flights — anti-alarm-fatigue.
- **E2/E4 add a LOCAL-ONLY "Last known position" row** `[R major — the #1 pilot need]`: distance + bearing from home, show-on-map (centers the globe/map at the last fix), copy-coordinates for Google Maps. Rendered from local rows, **never in the findings JSON** (the privacy property sweep asserts this). This delivers roadmap NOW #4 inside the debrief.
- **CSV-positive framing** `[R minor]`: on EdgeTX logs the footer reads "Ran all 8 checks this log type supports" (not "8 of 16"), leading with what ran; X2 becomes the blackbox upsell ("enable blackbox for electrical forensics") — a growth hook, not an apology.

## 6. Narration tier (Workers AI)

As rev 1 (endpoint beside `/videos.json`; 8B-class model chosen by eval; prompt contract with fixed sections; client + **server-side** post-check; narration rendered as plain text with URLs stripped `[R blocker — injection]`), amended:

- **Cache key = SHA-256(canonical findings ‖ model_id ‖ prompt_version)** `[R major ×2]`; prompt_version is a Worker constant bumped on any prompt edit (a model swap or prompt fix must never serve stale narrations — and the shared samples are the hottest keys). Only responses that pass the post-check are cached; KV namespace prefix is an env var (incident kill-switch = rotate prefix).
- **Rate limiting on a Durable Object** (or the Workers rate-limiting binding), never KV `[R major — KV can't count]`: keys = IPv6 /64 + IPv4 /32; 10/h per key as backstop.
- **Device token, defined** `[R major]`: first accept → Turnstile widget lazy-injected *inside the consent sheet* ("quick bot check — first time only") → Worker `siteverify` → signed ≤24 h token bound to the IP prefix; requests present the token; a rate-limit breach or expiry forces a fresh challenge. No "first-seen device" fiction.
- **Budget**: global daily Neuron counter on the same DO; 80% threshold fires an alert (email via a simple Worker cron notification); past cap → `503 {fallback:"templates"}` and the panel's "resting — back tomorrow" line. Free-plan worst case remains ₹0 by construction.
- Any failure → template fallback; the panel never blocks on the network.

## 7. UX specification (amended)

- **Cards are one-line rows** (icon · title · headline number), expanding on tap to evidence table + sparkline + check-list; the panel has a max-height with internal scroll so Battery/Signal charts stay reachable `[R major — displacement]`.
- **Auto-expand on CRITICAL only**; warnings appear as chips on the collapsed strip `[R major — alarm fatigue]`.
- **Clean flights**: no standalone panel — a "✓ Clean flight · view debrief" badge in StatsPanel's header expands the panel on demand (kills the duplicate-stats strip) `[R minor]`.
- **Mobile discovery**: a severity pill in the sticky header + red debrief markers on the flight-mode bar (reusing the event-marker affordance) that scroll to the panel `[R major]`.
- **"✦ Explain this flight"** is primary only when ≥1 notice+ finding; clean flights get a quiet text link ("Write a plain-English summary") `[R minor — don't lead with AI]`.
- **"Copy debrief as text"** ships in D1 `[R minor — highest-leverage growth surface]`: markdown rendering of the cards (findings, evidence numbers, checks-run footer, tool URL) — exactly the artifact pilots paste into Discord/IntoFPV #help threads today.
- Consent copy adds explicit negatives: "No GPS positions, no file, no filename — just the numbers below," and names the IP + 30-day-cache facts from invariant 4.
- Summary-modal tie-in unchanged (one warning line, anchor-scroll).

## 8. Rollout

| Phase | Ships | Gate |
|---|---|---|
| D1 | schema + detectors (in-worker) + templates + panel + sparklines + last-known-position + copy-as-text + Sentry filename side-fix | test plan §§2–3, 5, 6 green incl. fixture matrix + stride-emulating fixtures |
| D2 | Worker endpoint (DO limiter, device token, cache, post-check) + consent flow + narration | §4 green; model eval rubric passed; hostile-payload + token-replay tests green |
| D3 | advice.json board knowledge; share-card integration; preview-host policy | D2 telemetry healthy ≥ 1 week |

## 9. Open questions for the owner
1. Narration endpoint on www only, or also latest.narenana.com / pages.dev previews (each needs a CORS + Turnstile allow-list entry)? *(Recommend: www-only for D2.)*
2. ~~Regenerate?~~ Resolved: cut `[R]`.
3. Clean-flight PNG "brag card" in D3 — still wanted as the happy-path payoff?
4. NEW `[R]`: altitude evidence quantized to 10 m buckets — comfortable, or prefer coarse bands (">120 m") given some payloads will document altitude-limit breaches next to an IP at the edge? *(Recommend: 10 m buckets + the invariant-4 honesty line; bands if you want maximum caution.)*
