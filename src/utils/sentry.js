/**
 * Sentry error reporting — privacy-first, consent-aware.
 *
 * Boots on every page load (no-op if VITE_SENTRY_DSN is empty), runs in
 * always-anonymous mode (no PII, no IPs, query strings scrubbed), and
 * captures unhandled errors plus explicitly-reported parse failures.
 *
 * Consent model (Option B — "Consent Mode degraded"):
 *   - DEFAULT (page load, before consent decision):
 *       * sendDefaultPii: false
 *       * IP scrubbed in beforeSend
 *       * URL query strings stripped (might contain log filenames)
 *       * Default breadcrumbs DISABLED (no click/console capture) so we
 *         don't passively record what the user clicked before they
 *         consented to anything
 *       * Errors still caught and reported anonymously
 *   - AFTER `upgradeSentryConsent()`:
 *       * Breadcrumbs integration added — console + click + fetch breadcrumbs
 *         ride along with future errors, making them much easier to debug.
 *       * IP and URL still scrubbed (we never want those).
 *
 * Why we still scrub IP/URL on consent grant: the viewer doesn't have user
 * accounts, so there's nothing on the Sentry side that benefits from
 * knowing the user's IP. The information would only marginally help (rough
 * geo) and meaningfully hurt (PII storage). Keep it scrubbed.
 *
 * What we never collect:
 *   - The bytes of any flight log
 *   - GPS coordinates
 *   - User-identifiable info (no auth, no email, no UA fingerprint)
 *
 * What we DO collect on parse failure (via captureParseError):
 *   - File size in bytes
 *   - Firmware product/version string from the log header
 *   - Frame schema field names (the column list, e.g. "loopIteration,time,axisP")
 *   - The error message from the parser
 */

import * as Sentry from '@sentry/react'

const DSN = import.meta.env.VITE_SENTRY_DSN
const RELEASE = import.meta.env.VITE_RELEASE || 'dev'
const IS_WEB = import.meta.env.VITE_BUILD_TARGET === 'web'

let initialized = false
let consentGranted = false

export function isSentryAvailable() {
  return IS_WEB && !!DSN
}

/**
 * Initialise Sentry. Safe to call multiple times — second call is a no-op.
 * Called from main.jsx before React renders.
 */
export function initSentry() {
  if (initialized) return
  if (!isSentryAvailable()) return

  initialized = true

  Sentry.init({
    dsn: DSN,
    release: RELEASE,
    environment: import.meta.env.MODE,
    sendDefaultPii: false,

    // Default integrations include Breadcrumbs which records console logs,
    // clicks, and fetch — useful for debugging but recorded passively. In
    // degraded mode (pre-consent) we strip the user-action ones; we re-add
    // them on consent grant via upgradeSentryConsent().
    defaultIntegrations: false,
    integrations: [
      Sentry.dedupeIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.inboundFiltersIntegration(),
      // GlobalHandlers catches window.onerror + unhandledrejection — that's
      // the whole point of having Sentry here, so always on.
      Sentry.globalHandlersIntegration({ onerror: true, onunhandledrejection: true }),
      Sentry.linkedErrorsIntegration(),
      Sentry.httpContextIntegration(),
    ],

    // No tracing / replay / profiling — those would be high-data features
    // requiring real consent.
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    beforeSend(event) {
      // Always scrub IP — we never want it.
      if (event.user) {
        delete event.user.ip_address
        delete event.user.email
        delete event.user.id
      } else {
        event.user = { ip_address: null }
      }

      // Strip URL query string — log filenames or share params don't belong
      // in error reports.
      if (event.request?.url) {
        try {
          const u = new URL(event.request.url)
          event.request.url = u.origin + u.pathname
        } catch {
          // Malformed URL — drop it entirely rather than risk leaking.
          event.request.url = '[scrubbed]'
        }
      }

      return event
    },
  })
}

/**
 * Upgrade from degraded-anonymous to full-anonymous-with-breadcrumbs.
 * Called from analytics.js when the user clicks Accept on the consent
 * banner. We don't unscrub IP or URL — those stay anonymous always.
 * What changes: breadcrumbs (console / clicks / fetch) start riding along
 * with future error events so we can see what happened before a crash.
 */
export function upgradeSentryConsent() {
  if (consentGranted) return
  consentGranted = true
  if (!initialized) return

  Sentry.addIntegration(Sentry.breadcrumbsIntegration({
    console: true,
    dom: true,
    fetch: true,
    history: false,
    sentry: true,
    xhr: true,
  }))
}

/**
 * Capture a parser failure with privacy-safe context. Called from
 * parseBlackbox.js after both Rust and C parsers have rejected a file.
 *
 * @param {Error} err               The error thrown by the parser
 * @param {object} ctx              Privacy-safe context only
 * @param {number} ctx.fileSize     bytes
 * @param {string} ctx.filename     just the basename + extension, no path
 * @param {string} [ctx.firmware]   e.g. "Cleanflight", "iNAV 9.0.1"
 * @param {string[]} [ctx.fields]   frame schema field names (strings only)
 * @param {string} [ctx.parserChain] which parsers were tried (e.g. "rust→c")
 */
export function captureParseError(err, ctx) {
  if (!initialized) return

  Sentry.captureException(err, {
    tags: {
      kind: 'parse_failure',
      parser_chain: ctx.parserChain || 'unknown',
    },
    extra: {
      file_size_bytes: ctx.fileSize,
      filename: ctx.filename, // basename only — no path
      firmware: ctx.firmware,
      schema_fields: ctx.fields,
    },
  })
}

// Re-export the React Error Boundary so main.jsx can wrap <App />.
export const SentryErrorBoundary = Sentry.ErrorBoundary
