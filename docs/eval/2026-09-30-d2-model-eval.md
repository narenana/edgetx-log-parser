# D2 narration eval — 2026-09-30

Model: `@cf/meta/llama-3.2-3b-instruct` · prompt `p2` · endpoint: preview worker.
(3.1-8b retired on Workers AI — deprecated 2026-05-30; the fp8 variant 502s upstream.)

| Fixture | Path | Sections | No URLs | No raw ids | Grounded numbers | Verdict |
|---|---|---|---|---|---|---|
| LOG00060 (crash, E4) | model | ✓ | ✓ | ✓ | ✓ (stable vbat, mid-air end, death rattle all from payload) | PASS |
| Dolphin CSV (R2 critical) | model | ✓ | ✓ | ✓ | ✓ (6 windows, ~4 s, ~550 s all from payload) | PASS (wording slightly stiff) |
| LOG00041 / LOG00046 / LOG00057 / WING CSV (clean) | deterministic | ✓ | ✓ | ✓ | ✓ | PASS by construction |

Notes:
- p1 → p2 added the anti-invention clause after the model narrated a
  phantom power loss for an EMPTY findings payload. Clean flights now
  never reach the model at all (server-side deterministic summary).
- Guard trips are nondeterministic (~1 in 6 observed on the crash
  payload with p2); the worker retries one fresh sample before 502.
- Rubric rerun required on any PROMPT_VERSION bump or model swap (the
  cache key includes both, so stale narrations cannot outlive either).
