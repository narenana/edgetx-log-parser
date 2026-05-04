# Error reporting — what we collect, when, and why

This viewer uses [Sentry](https://sentry.io/) to capture crashes anonymously
so they can be debugged. This page is the human-readable summary of exactly
what gets sent. The implementation is in
[`src/utils/sentry.js`](src/utils/sentry.js).

## Loading model

Sentry boots on every page load (when `VITE_SENTRY_DSN` is set) in
**always-anonymous mode** — no PII, no IP address, URL query strings
stripped, no user-action breadcrumbs. The "consent banner" you see on first
visit is **not** asking permission to run Sentry; it asks permission to
attach breadcrumbs (which buttons you clicked) to future error reports.

| | Before consent (default) | After Accept | After Decline |
|---|---|---|---|
| Crash reports | ✓ anonymous | ✓ anonymous | ✓ anonymous |
| IP address | scrubbed | scrubbed | scrubbed |
| URL query strings | scrubbed | scrubbed | scrubbed |
| Breadcrumbs (click / console) | not collected | collected | not collected |
| `_ga` analytics cookie | not set | set | not set |
| GA4 cookieless pings | sent | upgraded to full | continue cookieless |

To turn Sentry off entirely, leave `VITE_SENTRY_DSN` empty in the build
environment. The whole module compiles to a no-op in that case.

## What gets sent on a crash

A crash report contains, at most:
- The error message and JavaScript stack trace
- The browser/OS user-agent string (Sentry's default; we don't add to it)
- The HTTP referrer + URL **with query string removed**
- The build's release tag (commit SHA — `VITE_RELEASE`)
- Click/console breadcrumbs only **if you accepted consent** before the crash

When the crash is a flight-log parse failure (both Rust and C parsers
rejected your file), the report ALSO carries:
- File size in bytes
- Filename **basename only** (no directory path)
- Firmware revision string from the log header (e.g. `INAV 9.0.1`)
- Frame schema field names (the column list, e.g. `["loopIteration","time","axisP[0]"]`)
- The parser error message

This metadata is what's needed to reproduce a parser bug — we can hand it to
the firmware-side maintainers (iNAV, Betaflight, blackbox-log) without
touching your actual flight data.

## What never gets sent

- The bytes of any flight log
- GPS coordinates from your log
- Your IP address (scrubbed in `beforeSend`)
- Email, name, or any account identifier (the viewer has no auth)
- URL query strings (might contain shared-log identifiers)

## Code references

- `src/utils/sentry.js` — init, beforeSend scrubbing, captureParseError
- `src/utils/parseBlackbox.js` — calls captureParseError when both parsers fail
- `src/components/ConsentBanner.jsx` — the UI prompt
- `src/utils/analytics.js` — calls upgradeSentryConsent on Accept

## Turning it off

In a build environment, leave `VITE_SENTRY_DSN` empty.

In a running browser session, opening DevTools and clearing
`localStorage.analytics-consent-v1` brings the banner back; clicking
Decline keeps Sentry running but in the most-anonymous configuration
(no breadcrumbs ever attached).

## Source maps

The build pipeline uploads source maps to Sentry at deploy time
(`@sentry/vite-plugin` runs when `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` +
`SENTRY_PROJECT` are set in CI). The maps are deleted from `dist/`
after upload, so users never download them. This lets stack traces in
the Sentry UI resolve to readable React component names instead of
minified `(c5)→(b3)` symbols.
