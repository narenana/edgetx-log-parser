import { useEffect, useMemo, useRef, useState } from 'react'
import { buildPayload } from '../debrief/payload.js'
import {
  setNarrationConsent,
  requestNarration, renderTurnstile,
} from '../debrief/narrate.js'
import { track, usageBeacon } from '../utils/analytics'

/**
 * "AI Flight Analysis" — the D2 AI narration tier, surfaced as a
 * prominent hero card at the TOP of the Debrief panel.
 *
 * Flow (design rev 4, 2026-10-05): one click goes STRAIGHT to the
 * summary — no interstitial payload-JSON wall (that read as confusing).
 * What's sent is disclosed in one plain-English line, with the exact
 * JSON available on demand behind a "what's sent?" toggle. Turnstile (if
 * ever enabled server-side) renders inline only when the server asks for
 * it. Renders nothing in desktop builds (tree-shaken via the build-target
 * guard in DebriefPanel) and self-disables offline. The deterministic
 * cards below never depend on this.
 */
export default function NarrationSection({ debrief }) {
  const payload = useMemo(() => buildPayload(debrief), [debrief])
  const payloadPretty = useMemo(() => JSON.stringify(payload, null, 2), [payload])
  const [showJson, setShowJson] = useState(false)  // transparency toggle (opt-in)
  const [challenge, setChallenge] = useState(null) // sitekey while Turnstile pending
  const [narration, setNarration] = useState('')
  const [state, setState] = useState('idle')       // idle | busy | done | resting
  const tsRef = useRef(null)

  // The Turnstile widget can only mount AFTER React has committed the
  // container (the ref doesn't exist in the same tick the challenge state
  // is set — rendering synchronously raced it and nothing appeared).
  useEffect(() => {
    if (challenge && tsRef.current) {
      tsRef.current.innerHTML = ''
      renderTurnstile(tsRef.current, challenge, tok => run(tok))
    }
  }, [challenge]) // eslint-disable-line react-hooks/exhaustive-deps

  const online = typeof navigator === 'undefined' || navigator.onLine !== false

  const run = async turnstile => {
    setState('busy')
    setNarration('')
    setChallenge(null)
    // Using the feature is the consent — remember it so nothing re-prompts.
    setNarrationConsent(true)
    track('narration_requested')
    usageBeacon('narration_requested')
    const res = await requestNarration(payload, { turnstile, onText: setNarration })
    if (res.ok) {
      setState('done')
      track('narration_completed', { cached: !!res.usage?.cached })
      usageBeacon('narration_completed', res.usage?.cached ? 'cached' : 'fresh')
    } else if (res.reason === 'challenge') {
      // Server wants a bot-check (only when Turnstile is configured).
      // Render it inline; the solve callback re-runs run(token).
      setChallenge(res.sitekey || null)
      setState('idle')
    } else {
      setState('resting')
      track('narration_fallback', { status: res.status || 0 })
    }
  }

  // Offline with nothing to show: hide the whole card rather than offer a
  // button that can only fail.
  if (!online && state === 'idle') return null

  const cta = debrief.clean ? 'Summarize this flight' : 'Explain what went wrong'
  const pitch = debrief.clean
    ? 'Turn this flight’s numbers into a plain-English summary you can share.'
    : 'Get a plain-English breakdown of what the data shows — and why.'

  return (
    <div className="db-ai">
      <div className="db-ai-head">
        <span className="db-ai-spark" aria-hidden="true">✦</span>
        <span className="db-ai-title">AI Flight Analysis</span>
        <span className="db-ai-tag">beta</span>
      </div>

      {state === 'idle' && (
        <div className="db-ai-idle">
          <p className="db-ai-pitch">{pitch}</p>

          {challenge == null ? (
            <button type="button" className="db-ai-cta" onClick={() => run()}>
              <span className="db-ai-cta-spark" aria-hidden="true">✦</span>
              {cta}
            </button>
          ) : (
            <div className="db-ai-ts">
              <span>Quick bot check — first time only:</span>
              <div ref={tsRef} />
            </div>
          )}

          <p className="db-ai-note">
            Sends an anonymous summary of these numbers — <b>never your log file</b>,
            no GPS, no filename — to narenana’s AI (Cloudflare Workers AI).{' '}
            <button type="button" className="db-ai-what" onClick={() => setShowJson(s => !s)}>
              {showJson ? 'hide' : 'what’s sent?'}
            </button>
          </p>
          {showJson && <pre className="db-ai-json">{payloadPretty}</pre>}
        </div>
      )}

      {state === 'busy' && !narration && (
        <div className="db-ai-loading">
          <span className="db-ai-dots" aria-hidden="true"><i /><i /><i /></span>
          Reading your flight data…
        </div>
      )}

      {(state === 'busy' || state === 'done') && narration && (
        <div className="db-ai-output">
          <div className="db-ai-text">
            {narration}
            {state === 'busy' && <span className="db-ai-caret" aria-hidden="true" />}
          </div>
          {state === 'done' && (
            <div className="db-ai-outfoot">
              <span>✦ Written by AI from the findings below</span>
              <button type="button" className="db-ai-what" onClick={() => run()}>
                regenerate
              </button>
            </div>
          )}
        </div>
      )}

      {state === 'resting' && (
        <div className="db-ai-resting">
          AI analysis is resting (offline, busy, or over today’s free budget).
          The findings below are the full breakdown.
        </div>
      )}
    </div>
  )
}
