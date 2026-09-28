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

† verify against the actual data during implementation; if 41 also ends airborne, move it to the must-fire column — the harness makes this a one-line change.

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
- Schema: every emitted findings JSON validates against `debrief.schema.json`; property-based sweep asserts NO key ever contains lat/lon-like pairs, craft name, or filename (privacy invariant #2 as a test).

## 3. Harness (`npm run debrief:check`)

Extends bb:check: decode each test-log → run detectors → diff against `expectations.json` → non-zero exit on any miss/extra above `info`. Prints the findings JSON per log (evidence values visible for eyeballing). Runs in CI only when test-logs exist (local gate, like bb:check today).

## 4. Narration tier tests (D2)

**Endpoint (Worker, integration):**
- schema-invalid body → 400; >8 KB → 413; missing Turnstile on first-seen device → 403; 11th call in an hour per IP → 429; daily budget counter exhausted → 503 `{fallback:"templates"}`.
- identical findings JSON twice → second response has `cached:true` and no `env.AI` invocation (assert via test double).
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
8. Reduced coverage: EdgeTX CSV load shows X2 "checks run n of 16".

## 6. Regression safety

- Detectors run post-parse in a `try/catch`; a thrown detector = Sentry event (no log data) + panel "unavailable" state; the dashboard must render normally regardless (test: detector forced to throw).
- Perf budget: full detector pass over a 400k-row log < 250 ms on a mid laptop (bench in harness, warn at 150 ms).
- bb:check + existing 52 unit tests stay green (detectors are additive; the mapper is untouched).

## 7. Exit criteria

- D1: sections 2–3, 5(1-2,7-8), 6 green.
- D2: section 4 green with a chosen model recorded in the design doc; 5(3-6) green; abuse limits verified against production Worker in preview.
