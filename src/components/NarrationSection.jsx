import { useEffect, useMemo, useRef, useState } from 'react'
import { buildPayload } from '../debrief/payload.js'
import {
  getNarrationConsent, setNarrationConsent,
  requestNarration, renderTurnstile,
} from '../debrief/narrate.js'
import { track } from '../utils/analytics'

/**
 * "Explain this flight" — the D2 AI narration tier inside the Debrief
 * panel. Renders nothing at all in desktop builds (tree-shaken via the
 * build-target guard in DebriefPanel) and self-disables offline. The
 * deterministic cards above never depend on this.
 */
export default function NarrationSection({ debrief }) {
  const payload = useMemo(() => buildPayload(debrief), [debrief])
  const payloadPretty = useMemo(() => JSON.stringify(payload, null, 2), [payload])
  const [sheet, setSheet] = useState(false)        // consent / payload sheet
  const [challenge, setChallenge] = useState(null) // sitekey while Turnstile pending
  const [narration, setNarration] = useState('')
  const [state, setState] = useState('idle')       // idle | busy | done | resting
  const tsRef = useRef(null)

  // The Turnstile widget can only mount AFTER React has committed the
  // sheet (the ref doesn't exist in the same tick the challenge state
  // is set — rendering synchronously raced it and nothing appeared).
  useEffect(() => {
    if (challenge && sheet && tsRef.current) {
      tsRef.current.innerHTML = ''
      renderTurnstile(tsRef.current, challenge, tok => run(tok))
    }
  }, [challenge, sheet]) // eslint-disable-line react-hooks/exhaustive-deps

  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  if (!online && state === 'idle') return null

  const run = async turnstile => {
    setState('busy')
    setChallenge(null)
    track('narration_requested')
    const res = await requestNarration(payload, { turnstile, onText: setNarration })
    if (res.ok) {
      setState('done')
      track('narration_completed', { cached: !!res.usage?.cached })
    } else if (res.reason === 'challenge') {
      setChallenge(res.sitekey || null)
      setSheet(true)
      setState('idle')
    } else {
      setState('resting')
      track('narration_fallback', { status: res.status || 0 })
    }
  }

  const onExplain = () => {
    if (!getNarrationConsent()) { setSheet(true); return }
    run()
  }
  const accept = () => {
    setNarrationConsent(true)
    setSheet(false)
    run()
  }

  return (
    <div className="db-narrate">
      {state === 'idle' && (
        <div className="db-narrate-cta">
          <button
            type="button"
            className={debrief.clean ? 'db-narrate-link' : 'db-narrate-btn'}
            onClick={onExplain}
          >
            {debrief.clean ? 'Write a plain-English summary' : '✦ Explain this flight'}
          </button>
          <button type="button" className="db-narrate-view" onClick={() => setSheet(s => !s)}>
            view what will be sent
          </button>
        </div>
      )}
      {state === 'busy' && <div className="db-narrate-busy">Writing the debrief…</div>}
      {(state === 'busy' || state === 'done') && narration && (
        <div className="db-narration">
          <div className="db-narration-label">AI NARRATION — generated from the findings above</div>
          <div className="db-narration-text">{narration}</div>
        </div>
      )}
      {state === 'resting' && (
        <div className="db-narrate-busy">
          AI narration is resting (offline, busy, or over today's free budget) — the findings above are the full analysis.
        </div>
      )}

      {sheet && (
        <div className="db-consent">
          <p className="db-consent-copy">
            To write the narration, this exact summary — <b>never your log file</b> — is sent
            to narenana's server (Cloudflare Workers AI). No GPS positions, no file, no
            filename — just the numbers below. Like any web request, the server sees your IP;
            generated narrations are cached for 30 days keyed by these numbers.
          </p>
          <pre className="db-consent-json">{payloadPretty}</pre>
          {challenge != null && (
            <div className="db-consent-ts">
              <span>Quick bot check — first time only:</span>
              <div ref={tsRef} />
            </div>
          )}
          {challenge == null && (
            <div className="db-consent-btns">
              <button type="button" className="db-narrate-btn" onClick={accept}>
                Send &amp; remember on this device
              </button>
              <button type="button" className="db-narrate-link" onClick={() => setSheet(false)}>
                Not now
              </button>
              {getNarrationConsent() && (
                <button
                  type="button"
                  className="db-narrate-view"
                  onClick={() => { setNarrationConsent(false); setSheet(false) }}
                >
                  Forget my consent
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
