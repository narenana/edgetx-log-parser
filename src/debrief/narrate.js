/**
 * Flight Debrief — AI narration client (D2).
 *
 * Talks to POST /api/debrief on the narenana Worker. Sends ONLY the
 * quantized findings payload (payload.js is the privacy boundary);
 * the log never leaves the machine. Everything degrades to the
 * deterministic template cards: any error, offline, rate limit, or
 * budget exhaustion simply means "no narration".
 *
 * Consent: remembered per browser, keyed to the payload schema major
 * (`debrief-consent:v1`) — a schema bump forces a fresh preview. The
 * payload stays permanently inspectable in the UI regardless.
 *
 * Desktop (Electron) builds compile this whole tier out via the
 * VITE_BUILD_TARGET guard in DebriefPanel; web builds gate on
 * navigator.onLine at click time.
 */

export const CONSENT_KEY = 'debrief-consent:v1'
const TOKEN_KEY = 'debrief-device-token'
const DEFAULT_API = 'https://www.narenana.com/api/debrief'

export const apiUrl = () => import.meta.env.VITE_DEBRIEF_API || DEFAULT_API

export const getNarrationConsent = () => {
  try { return localStorage.getItem(CONSENT_KEY) === 'granted' } catch { return false }
}
export const setNarrationConsent = v => {
  try {
    if (v) localStorage.setItem(CONSENT_KEY, 'granted')
    else localStorage.removeItem(CONSENT_KEY)
  } catch { /* private mode */ }
}

const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) } catch { return null } }
const setToken = t => { try { if (t) localStorage.setItem(TOKEN_KEY, t) } catch { /* ignore */ } }

/**
 * Client-side belt-and-braces mirror of the server post-check: strip
 * URLs, and drop any paragraph naming a finding id the payload didn't
 * contain (the server already refuses such output; this guards a
 * compromised cache).
 */
export function sanitizeNarration(text, payload) {
  const sentIds = new Set(payload.findings.map(f => f.id))
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .split(/\n\n+/)
    .filter(par => {
      const ids = par.match(/\b(E[1-6]|R[1-4]|B[1-4]|M[1-2]|X[1-2])\b/g) || []
      return ids.every(id => sentIds.has(id))
    })
    .join('\n\n')
}

/** Parse an SSE body (fetch + ReadableStream — EventSource can't POST). */
export async function consumeSse(response, onChunk) {
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let usage = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const ev = (frame.match(/^event: (.*)$/m) || [])[1]
      const data = (frame.match(/^data: (.*)$/m) || [])[1]
      if (ev === 'chunk' && data) onChunk(JSON.parse(data))
      if (ev === 'usage' && data) usage = JSON.parse(data)
    }
  }
  return usage
}

/**
 * Request a narration. onText receives the growing sanitized text.
 * Resolves { ok, reason?, challenge?, sitekey?, usage? }:
 *   ok:false reason 'challenge' → caller renders Turnstile with
 *   `sitekey`, then retries with { turnstile: token }.
 *   ok:false reason 'fallback'  → show the resting note; cards stand.
 */
export async function requestNarration(payload, { turnstile, onText } = {}) {
  const body = { payload }
  const tok = getToken()
  if (tok) body.token = tok
  if (turnstile) body.turnstile = turnstile

  let resp
  try {
    resp = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, reason: 'fallback' }
  }

  if (resp.status === 403) {
    const j = await resp.json().catch(() => ({}))
    if (j.token) setToken(j.token)
    if (j.challenge) return { ok: false, reason: 'challenge', sitekey: j.sitekey }
    return { ok: false, reason: 'fallback' }
  }
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}))
    if (j.token) setToken(j.token)
    return { ok: false, reason: 'fallback', status: resp.status, retryAfterS: j.retryAfterS }
  }

  let raw = ''
  const usage = await consumeSse(resp, chunk => {
    raw += chunk
    if (onText) onText(sanitizeNarration(raw, payload))
  })
  if (usage?.token) setToken(usage.token)
  const final = sanitizeNarration(raw, payload)
  if (!final.trim()) return { ok: false, reason: 'fallback' }
  return { ok: true, text: final, usage }
}

/** Load the Turnstile script + render a widget. ONLY called after the
 *  user accepted the consent sheet — invariant #9: no third-party
 *  script before consent. */
export function renderTurnstile(container, sitekey, onToken) {
  const ready = () => {
    window.turnstile.render(container, { sitekey, callback: onToken })
  }
  if (window.turnstile) return ready()
  const s = document.createElement('script')
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__debriefTsReady'
  window.__debriefTsReady = ready
  document.head.appendChild(s)
}
