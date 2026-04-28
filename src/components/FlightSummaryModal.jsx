import { useEffect, useRef, useState } from 'react'
import { track } from '../utils/analytics'

// Three-step processing animation. Same visuals for every load path —
// the only difference is that step 0 ("Parsing telemetry") absorbs the
// real parse wait, while steps 1–2 are post-parse theatrical flourishes:
//
//   CSV sync path:        step 0 ~280 ms (timer) → 1 ~280 ms → 2 ~280 ms
//   Blackbox async path:  step 0 = worker run time → 1 ~280 ms → 2 ~280 ms
//
// In both cases steps 1 and 2 run with the same timers, so the user sees
// the same closing animation whether the data took 100 ms or 5 s. While
// the BBL worker is mid-parse, step 0 just keeps pulsing.
const STEPS = [
  'Parsing log',                // step 1: absorbs the actual parse wait
  'Detecting flight events',    // step 2: theatrical (always 280 ms)
  'Computing flight metrics',   // step 3: theatrical (always 280 ms)
]

const STEP_MS = 280     // timer interval for the post-parse steps 1 & 2
const REVEAL_MS = 220   // brief pause before swapping processing → summary

/**
 * Pre-flight summary modal.
 *
 * Two entry modes:
 *   - `log` only:               sync-loaded log (CSV). Theatrical timer
 *                                animation runs once, then summary.
 *   - `parsing` first, then `log`: blackbox path. Real worker progress
 *                                drives the checklist. When the log
 *                                arrives the modal transitions smoothly
 *                                to the summary view (no remount).
 *
 * Caller (App.jsx) keeps the modal mounted with a stable `key` across
 * the parsing → log transition so we don't restart any animations.
 *
 * Empty-data branch (very short log, no telemetry) is reached after
 * processing finishes and shows a friendly "close this log" exit.
 */
export default function FlightSummaryModal({ log, parsing, onProceed, onCloseLog }) {
  // The header subtitle uses whichever filename is available — parsing
  // sets it before the log exists; log carries it after.
  const filename = log?.filename ?? parsing?.filename ?? ''

  // Heuristic: a log is "real" if it ran long enough AND has at least one
  // telemetry channel that captured something. Tuned conservatively.
  const hasRealData =
    !!log && log.stats.duration >= 5 &&
    (log.hasGPS || log.hasBattery || log.stats.maxAlt > 0)

  const [phase, setPhase] = useState('processing') // 'processing' | 'summary'
  const [currentStep, setCurrentStep] = useState(0)

  // Per-step timings. Step 0 starts at mount; later steps' startedAt
  // gets filled when currentStep advances. Each entry is captured once
  // (no re-starts) so the displayed durations are stable.
  const [stepTimings, setStepTimings] = useState(() => {
    const t0 = Date.now()
    return STEPS.map((_, i) => ({
      startedAt: i === 0 ? t0 : null,
      finishedAt: null,
    }))
  })

  // Live-updates the elapsed display on the active step. 200 ms is fine
  // visually and keeps render churn minimal — we're not measuring frame
  // budget, just user-facing seconds.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (currentStep >= STEPS.length) return
    const id = setInterval(() => forceTick(t => t + 1), 200)
    return () => clearInterval(id)
  }, [currentStep])

  // When currentStep advances, fill in finishedAt for completed steps
  // and startedAt for the newly active step. One pass per transition.
  useEffect(() => {
    if (currentStep === 0) return
    setStepTimings(prev => {
      const now = Date.now()
      return prev.map((t, i) => {
        if (i < currentStep && t.finishedAt === null) {
          return { ...t, finishedAt: now }
        }
        if (i === currentStep && t.startedAt === null) {
          return { ...t, startedAt: now }
        }
        return t
      })
    })
  }, [currentStep])

  // Whether we entered in async (BBL) mode. Captured once on mount so the
  // CSV vs BBL animation paths don't second-guess each other later when
  // App.jsx clears the parsing prop after the worker resolves.
  const isAsyncRef = useRef(!!parsing)

  // Track summary_shown once when a log eventually appears. Logged with
  // has_real_data so we can see how often the empty branch fires.
  useEffect(() => {
    if (!log) return
    track('summary_shown', {
      has_real_data: hasRealData,
      duration_sec: Math.round(log.stats.duration ?? 0),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!log])

  // CSV (sync) path: log was present at mount. Run the full 3-step
  // theatrical animation, no parsing wait — step 0 ticks at the same
  // timer pace as steps 1 and 2.
  useEffect(() => {
    if (isAsyncRef.current) return
    if (!log) return
    let cancelled = false
    const timers = []
    for (let s = 0; s < STEPS.length; s++) {
      timers.push(setTimeout(() => {
        if (!cancelled) setCurrentStep(s + 1)
      }, (s + 1) * STEP_MS))
    }
    timers.push(setTimeout(() => {
      if (!cancelled) setPhase('summary')
    }, STEPS.length * STEP_MS + REVEAL_MS))
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // BBL (async) path: step 0 ("Parsing telemetry") pulses while the
  // worker chews through the file. When the log lands, step 0 immediately
  // ✓s and steps 1 & 2 roll through on the same 280 ms timer used by the
  // CSV path — visual identical from the user's perspective.
  useEffect(() => {
    if (!isAsyncRef.current) return
    if (!log) return
    let cancelled = false
    const timers = []
    setCurrentStep(1) // step 0 done — parse just finished
    timers.push(setTimeout(() => {
      if (!cancelled) setCurrentStep(2)
    }, STEP_MS))
    timers.push(setTimeout(() => {
      if (!cancelled) setCurrentStep(STEPS.length)
    }, STEP_MS * 2))
    timers.push(setTimeout(() => {
      if (!cancelled) setPhase('summary')
    }, STEP_MS * 2 + REVEAL_MS))
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [!!log])

  const model = modelFromFilename(filename)
  const dateStr = dateFromFilename(filename)

  return (
    <div className="summary-modal-backdrop" role="dialog" aria-modal="true" aria-label="Flight summary">
      <div className="summary-modal-card">
        <div className="summary-modal-header">
          <div className="summary-modal-title">Flight Summary</div>
          <div className="summary-modal-subtitle">
            {model}{dateStr ? ` · ${dateStr}` : ''}
          </div>
        </div>

        {phase === 'processing' ? (
          <div className="summary-processing" aria-live="polite">
            <ul className="summary-processing-steps">
              {STEPS.map((label, i) => {
                const state =
                  i < currentStep ? 'done' :
                  i === currentStep ? 'active' :
                  'pending'
                // Step 1 carries the real parse wait, so its indicator is
                // a horizontal progress bar (indeterminate slide while
                // active, fills solid blue when done). Steps 2 and 3 are
                // theatrical bridges to the summary reveal — a small
                // dot/check is enough.
                const isFirstStep = i === 0
                const timing = stepTimings[i]
                return (
                  <li key={label} className={`summary-processing-step ${state}`}>
                    {isFirstStep ? (
                      <div className="summary-processing-bar" aria-hidden="true">
                        <div className="summary-processing-bar-fill" />
                      </div>
                    ) : (
                      <span className="summary-processing-mark" aria-hidden="true">
                        {state === 'done' ? '✓' : '·'}
                      </span>
                    )}
                    <span className="summary-processing-label">{label}</span>
                    <span className="summary-processing-time">
                      {fmtElapsed(timing)}
                    </span>
                  </li>
                )
              })}
            </ul>
            {parsing && parsing.diag && parsing.diag.length > 0 && (
              <pre className="summary-processing-diag" aria-live="polite">
                {parsing.diag.join('\n')}
              </pre>
            )}
          </div>
        ) : hasRealData ? (
          <>
            <div className="summary-grid">
              <Tile label="Duration" value={fmtDuration(log.stats.duration)} />
              <Tile label="Max altitude" value={Math.round(log.stats.maxAlt)} unit="m" />
              {log.hasGPS && (
                <Tile label="Max speed" value={Math.round(log.stats.maxSpeed)} unit="km/h" />
              )}
              {log.hasGPS && log.stats.maxDistFromHomeKm > 0 && (
                <Tile label="Max from home" value={fmtDistance(log.stats.maxDistFromHomeKm)} />
              )}
              {log.hasGPS && log.stats.distanceKm > 0 && (
                <Tile label="Total distance" value={fmtDistance(log.stats.distanceKm)} />
              )}
              <Tile label="Max climb" value={log.stats.maxClimb.toFixed(1)} unit="m/s" />
              <Tile label="Max sink" value={log.stats.maxSink.toFixed(1)} unit="m/s" />
              {log.hasBattery && log.stats.minVoltage != null && (
                <Tile label="Min voltage" value={log.stats.minVoltage.toFixed(1)} unit="V" />
              )}
              {log.hasCurrent && log.stats.maxCurrent > 0 && (
                <Tile label="Max current" value={log.stats.maxCurrent.toFixed(1)} unit="A" />
              )}
              {log.hasCurrent && log.stats.maxCapacity > 0 && (
                <Tile label="Used" value={Math.round(log.stats.maxCapacity)} unit="mAh" />
              )}
              {log.stats.minRSSI != null && (
                <Tile label="Min RSSI" value={Math.round(log.stats.minRSSI)} unit="dB" />
              )}
              {log.stats.dominantMode && log.flightModes.length > 1 && (
                <Tile
                  label="Most-used mode"
                  value={log.stats.dominantMode}
                  unit={`${Math.round(log.stats.dominantPct * 100)}%`}
                />
              )}
            </div>

            <button
              type="button"
              className="summary-cta"
              onClick={() => {
                track('summary_proceeded')
                onProceed()
              }}
              autoFocus
            >
              Proceed to visualisation →
            </button>
          </>
        ) : (
          <>
            <div className="summary-empty">
              <div className="summary-empty-icon" aria-hidden="true">🛬</div>
              <div className="summary-empty-title">No flight data here</div>
              <div className="summary-empty-msg">
                This log appears to be empty or didn&rsquo;t capture meaningful
                telemetry. Try opening a different file.
              </div>
            </div>

            <button
              type="button"
              className="summary-cta summary-cta-secondary"
              onClick={() => {
                track('summary_closed_empty')
                onCloseLog()
              }}
              autoFocus
            >
              Close this log
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, unit }) {
  return (
    <div className="summary-tile">
      <div className="summary-tile-label">{label}</div>
      <div className="summary-tile-value">
        {value}
        {unit ? <span className="summary-tile-unit"> {unit}</span> : null}
      </div>
    </div>
  )
}

// ── Formatting helpers ────────────────────────────────────────────────────

function fmtDuration(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Live-updating elapsed display per step. Pending = blank, active = time
// since startedAt right now, done = startedAt → finishedAt span.
function fmtElapsed(timing) {
  if (!timing || timing.startedAt == null) return ''
  const end = timing.finishedAt ?? Date.now()
  const ms = Math.max(0, end - timing.startedAt)
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m ${s}s`
}

function fmtDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(2)} km`
}

function modelFromFilename(filename) {
  return filename
    .replace(/\.csv$/i, '')
    .replace(/\.bbl$/i, '')
    .replace(/\.bfl$/i, '')
    .replace(/\.txt$/i, '')
    .replace(/-\d{4}-\d{2}-\d{2}-\d{6}$/, '')
}

function dateFromFilename(filename) {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  return `${m[1]} ${m[2]}:${m[3]}`
}
