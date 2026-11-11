/**
 * Product feedback client — POST /api/feedback on the narenana Worker
 * (website repo, usage/lib/feedback.mjs).
 *
 * Sends ONLY what the visitor typed into the Feedback dialog — a 1–10
 * rating and an optional comment — plus which screen it came from
 * (the landing page, or the kind of log that was open). Never the log,
 * the filename, or anything about the device. Web build only.
 */
export const FEEDBACK_MAX_COMMENT = 2000
const DEFAULT_API = 'https://www.narenana.com/api/feedback'
export const feedbackUrl = () => import.meta.env.VITE_FEEDBACK_API || DEFAULT_API

const CONTEXTS = ['landing', 'blackbox', 'edgetx-csv', 'sample']

/** The exact JSON body that leaves the browser. Pure; unit-tested. */
export function buildFeedbackBody({ rating, comment = '', context = '', website = '' }) {
  return {
    product: 'log-viewer',
    rating,
    comment: String(comment).trim().slice(0, FEEDBACK_MAX_COMMENT),
    context: CONTEXTS.includes(context) ? context : '',
    website: String(website), // honeypot: hidden from people, so always '' for them
  }
}

/** Which screen the dialog was opened from (an allowlisted bucket). */
export function feedbackContext(log, sampleNames) {
  if (!log) return 'landing'
  if (sampleNames && sampleNames.has(log.filename)) return 'sample'
  const src = log.debrief?.context?.source
  if (src === 'blackbox' || src === 'edgetx-csv') return src
  return /\.csv$/i.test(log.filename || '') ? 'edgetx-csv' : 'blackbox'
}

/**
 * POST the feedback. Resolves { ok: true } or { ok: false, error } with
 * error 'rate' | 'server' | 'network'. Never throws.
 */
export async function sendFeedback(fields, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(feedbackUrl(), {
      method: 'POST',
      // text/plain keeps this a CORS "simple request" (no preflight) on the
      // pages.dev preview hosts; the server parses the body as JSON either way.
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(buildFeedbackBody(fields)),
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined,
    })
    if (res.ok) return { ok: true }
    return { ok: false, error: res.status === 429 ? 'rate' : 'server' }
  } catch {
    return { ok: false, error: 'network' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
