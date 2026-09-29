# Flight Debrief — test plan

Companion to `FLIGHT-DEBRIEF-DESIGN.md`. Gate for phase D1/D2 per its rollout table. All layers follow the house pattern: Vitest for units (`npm test`), a `debrief:check` harness over gitignored real logs (bb:check style), and headless puppeteer for UI flows.

## 1. Fixture strategy

**Real logs (gitignored `test-logs/`, never committed):** the four SPEEDYBEE F405 WING logs are the founding fixtures — expectations live in `test-logs/expectations.json` (also gitignored, since even expectations leak flight facts):

| Log | Known truth | Must fire | Must NOT fire |
|---|---|---|---|
| LOG00060 | 6:30 crash flight, mid-air power cutoff | E1, E2, E3, E4(conf ≥0.8), B4 | E5, E6, R1, R2, B2, `clean` |
| LOG00041 | unterminated, landed variant | E1, B4 | E2†, E4, R1 |
| LOG00046 | clean control, "End of log" marker | B4, X1 (`clean:true`) | every E/R warning+ |
| LOG00057 | 1.5 s arm-only blip | X2/B4 only, short-flight guard | E2, E4 (duration gate <10 s) |
| WING-…-110747.csv | **EdgeTX CSV clean control** (2026-09-29 addition): healthy 9:03 ELRS wing flight, 507 m, 152 km/h, lands 3.72 V/cell, link 98–100 % to last row; RTH excursion early; final-pass RSSI dip −46→−86 dB with RQly steady | B4, X1 (`clean:true`), CSV-positive footer; existing event engine finds takeoff + rth_on/rth_off | R2/R3 (the −86 dB dip is the canonical must-NOT-fire: RSSI dip ≠ link loss), B2 (3.72 V/cell LiPo is healthy), E2 (lands), X2 phrased positively |

† verify against the actual data during implementation; if 41 also ends airborne, move it to the must-fire column — the harness makes this a one-line change.
CSV note: the radio freezes GSpd at its last GPS fix for several rows around landing (observed 63.8 km/h at 0 AGL) — speed-derived detectors must gate on fix freshness/Sats, and this fixture is the regression case.

**Synthetic fixtures (committed, coordinate-free):** a `fixtures/synth.js` generator building typed arrays per scenario — the mapper tests already established this style. One scenario per detector trigger, boundary, and false-positive guard. Synthetic EdgeTX CSV strings for the CSV-side subset.

## 2. Unit test matrix (Vitest, ~45 cases)

Per detector, three mandatory cases — **trigger** (fires with correct severity + evidence keys), **boundary** (value at threshold ± ε behaves per spec), **guard** (the named false-positive does NOT fire):

- E1: truncated tail fires / clean end-marker silent / stride-sampled decode not mistaken for truncation.
- E2: ends at 845 m AGL fires / lands to <5 m silent / **guard:** baro drift at rest does not fake altitude; short logs (<10 s) exempt.
- E3: sagVbat collapse fires; enum out-of-range fires / **guard:** legitimate cold-start low temps at flight START do not fire (window = tail only).
- E4 composite: all constituents → conf 0.9; two of three → lower conf, severity drop; single constituent → no composite.
- E5: monotonic 150→300 mΩ fires / **guard:** the LOG00060 pattern (cold-pack settle 166→116 then pinned) must NOT fire — this exact curve is a committed synthetic fixture.
- E6: 400 ms dip-and-recover fires / sustained sag routes to B2 not E6.
- R1–R4: phase transitions, loss windows ≥200 ms, pre-event RSSI decline vs median, update-rate collapse / **guards:** single-frame RSSI dropouts; RSSI decline during an intentional long-range leg (distance-correlated) reported as `notice` not `warning`.
- B1: sag ratio on punches only / **guard:** never computed from <3 punch windows.
- B2: 3.49 V/cell = warning, 3.29 = critical, 3.51 = info.
- B3: divergence growth fires / static offset silent.
- M1/M2: banded fixtures; **guard:** stick-command-correlated gyro energy exempt (M2's gate).
- X1/X2: clean flight yields `clean:true` + B4; CSV source lists skipped detectors correctly.
- Schema: every emitted findings JSON validates against `debrief.schema.json`; property-based sweep asserts NO key ever contains lat/lon-like pairs, craft name, filename, or sub-second t precision (privacy invariants #2–3 as tests).
- **Mapper contract (rev 2):** detectors receive parsed.slow* arrays in-worker before free(); truncation stats (droppedMain/droppedGps) returned; end-marker tail scan correct on: clean log, truncated log, log with 'End of log' bytes inside frame data (false-positive guard). "Mapper untouched" is withdrawn — these ARE mapper tests.
- **Stride emulation (rev 2):** every synthetic main-frame fixture is generated full-rate then decimated with production stride math; E5's pinned-impedance guard and E6's dip fixtures exist in strided form. A fixture pair (same event, 2 MB vs 25 MB stride) asserts detector verdicts MATCH — the stride-invariance test.
- **Chemistry (rev 2):** B1/B2 fixture pairs per chemistry — Li-ion healthy flight (3.2 V/cell landing, 35 mΩ) fires NOTHING; LiPo same numbers fires B2 warning + B1. Manual override respected.
- **Acknowledge demotion (rev 2):** chronic B1 acknowledged for craft → next flight severity notice, panel not auto-expanded.
- **Allowlists (rev 2):** custom-firmware string ("INAV 9.0.1 (deadbeef) MYFORK"), renamed EdgeTX sensor columns, and a 31-char target all REJECTED client-side (payload never built) — and the same fixtures rejected Worker-side.

## 3. Harness (`npm run debrief:check`)

Extends bb:check: decode each test-log → run detectors → diff against `expectations.json` → non-zero exit on any miss/extra above `info`. Prints the findings JSON per log (evidence values visible for eyeballing) plus sparkline-slice byte sizes (bounded, coordinate-free — asserted < 8 KB per finding). Runs in CI only when test-logs exist (local gate, like bb:check today).

## 4. Narration tier tests (D2)

**Endpoint (Worker, integration):**
- schema-invalid body → 400; >8 KB → 413; missing Turnstile on first-seen device → 403; 11th call in an hour per IP → 429; daily budget counter exhausted → 503 `{fallback:"templates"}`.
- identical findings JSON twice → second response has `cached:true` and no `env.AI` invocation (assert via test double).
- **cache key (rev 2):** model env-var swap OR prompt_version bump → previously cached findings produce a cache MISS; a response failing the post-check is NOT cached.
- **hostile-but-valid payloads (rev 2):** duplicate finding ids, unknown evidence keys, 30 findings, instruction-text laundered into enum-ish strings, per-id evidence keys from the wrong detector — all 400, none reach env.AI.
- **device token (rev 2):** replayed token from a different IP prefix → 403 + re-challenge; expired (>24 h) token → 403; forged "not-first" request without token → 403; rate-limit breach invalidates the token.
- **rate limiter (rev 2):** 20 parallel requests from one IPv6 /64 → ≥10 rejected (Durable Object consistency test — this is exactly what KV counters fail).
- CORS: allowed for `https://www.narenana.com`, refused for others (preview policy per design open-question #1).

**Model output (eval rubric, run per candidate model + on any prompt change):** feed the four fixture findings JSONs + 4 synthetic scenario JSONs; PASS requires for each: (a) references every critical finding id, (b) zero references to ids absent from the payload (the guardrail check must find nothing to strip), (c) no invented numeric sensor values (every number in the output must appear in the payload, ±rounding), (d) sections all present, ≤ length caps, (e) tone: no blame, hedged appropriately — human-scored 1–5, ≥4 required. Store rubric scores in `docs/eval/` (numbers only, no payloads).

## 5. UI tests (headless, prod-pattern)

1. Load LOG00060 fixture → panel expanded, E4 card first, severity chips correct, "jump to" scrubs to t≈389.8.
2. Load clean sample → collapsed strip with ✓ line; expanding shows B4 + X1.
3. First "Explain this flight" click → consent sheet shows payload; the displayed JSON strictly equals what the network layer would send (intercept + compare).
4. Decline → no request ever fires (network spy); accept → SSE renders progressively; kill network mid-stream → template fallback replaces cleanly.
5. Endpoint 503 → template text + "resting" notice, no error state.
6. Consent revoke in footer → next click shows the sheet again.
7. Panel absent from desktop/offline build (build-flag test).
8. Reduced coverage: EdgeTX CSV load shows the CSV-positive footer ("Ran all N checks this log type supports") + blackbox-upsell X2 card.
9. **(rev 2)** Expanded E3 card renders the vbat-collapse sparkline — the evidence is VISIBLE (pixel-diff against a blank-sparkline baseline).
10. **(rev 2)** E2/E4 card shows the local Last-known-position row; the network spy asserts its coordinates appear in NO request of any kind.
11. **(rev 2)** No third-party script (incl. Turnstile) loads before consent acceptance; after acceptance the widget loads inside the sheet.
12. **(rev 2)** "Copy debrief as text" produces markdown containing every finding title + evidence number + the tool URL, and no coordinates.
13. **(rev 2)** Desktop (Electron) bundle contains no "/api/debrief" string and no Explain button; panel + detectors fully present.
14. **(rev 2)** Clean flight: no standalone panel; StatsPanel header shows the ✓ badge; badge click expands the debrief.

## 6. Regression safety

- Detectors run in-worker in a `try/catch`; a thrown detector = Sentry event carrying ONLY {detector_id, error_name} (asserted — no message, no evidence, no filename) + panel "unavailable" state; the dashboard renders normally regardless (test: detector forced to throw).
- Perf budget (rev 2, real inputs): full detector pass over strided main (~8 k rows) + full-rate slow (~55 k) + gps arrays < 100 ms in-worker on a mid laptop; end-marker tail scan < 10 ms on a 25 MB buffer. Bench in harness, warn at 60 ms.
- Sentry hygiene (rev 2): beforeBreadcrumb drops JSON-ish/long console lines (unit-tested); captureParseError no longer sends filename (extension + size only) — this side-fix ships in D1 and has its own test.
- bb:check + existing 52 unit tests stay green. The mapper CHANGES (slow-array consumption, truncation stats) — covered by the §2 mapper-contract tests, not hand-waved.

## 7. Exit criteria

- D1: sections 2–3, 5(1-2,7-8), 6 green.
- D2: section 4 green with a chosen model recorded in the design doc; 5(3-6) green; abuse limits verified against production Worker in preview.
