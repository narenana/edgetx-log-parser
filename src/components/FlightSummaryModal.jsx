import { useEffect, useState } from 'react'
import { track } from '../utils/analytics'

// Theatrical processing steps — parsing has already completed by the time
// the modal mounts (it's synchronous in the parser today), but stepping
// through these states gives the user a beat to register the tool is doing
// work for them, and then a satisfying reveal of the actual summary.
// Total run time = STEPS.length × STEP_MS + REVEAL_MS.
const STEPS = [
  'Parsing telemetry',
  'Detecting flight events',
  'Computing flight metrics',
]
const STEP_MS = 280
const REVEAL_MS = 220

/**
 * Pre-flight summary modal.
 *
 * Shown immediately after a log is loaded. Forces the user to review the
 * flight's headline numbers and proceed with one deliberate click — turning
 * "drop CSV → confused dashboard" into "drop CSV → see at a glance whether
 * this flight was interesting → dive in."
 *
 * If the log captured no meaningful telemetry (very short duration, no
 * GPS/battery/altitude), the modal switches to an empty-state branch with
 * a "Close this log" exit so bad-data files don't dump the user into an
 * empty viewer.
 *
 * Dismissed-state lives in App.jsx (keyed by filename), so the modal only
 * shows once per log even when the user tabs between multiple loaded logs.
 */
export default function FlightSummaryModal({ log, onProceed, onCloseLog }) {
  const { stats, hasGPS, hasBattery, hasCurrent, flightModes } = log

  // Heuristic: a log is "real" if it ran long enough AND has at least one
  // telemetry channel that captured something. Tuned conservatively — we'd
  // rather show the empty branch on a borderline case than gate a real
  // flight behind it.
  const hasRealData =
    stats.duration >= 5 && (hasGPS || hasBattery || stats.maxAlt > 0)

  // Processing animation: step through STEPS, then transition to 'summary'.
  // `currentStep` is the index of the in-flight step; -1 means none yet,
  // STEPS.length means all done.
  const [phase, setPhase] = useState('processing') // 'processing' | 'summary'
  const [currentStep, setCurrentStep] = useState(0)

  useEffect(() => {
    track('summary_shown', {
      has_real_data: hasRealData,
      duration_sec: Math.round(stats.duration ?? 0),
    })

    let cancelled = false
    const timers = []

    // Walk through each step, then after a short reveal pause, swap to
    // the summary view. All timers cleaned up on unmount.
    STEPS.forEach((_, i) => {
      timers.push(setTimeout(() => {
        if (!cancelled) setCurrentStep(i + 1)
      }, (i + 1) * STEP_MS))
    })
    timers.push(setTimeout(() => {
      if (!cancelled) setPhase('summary')
    }, STEPS.length * STEP_MS + REVEAL_MS))

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
    // Run once per modal mount — App.jsx keys dismissal by filename so we
    // only mount once per log anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const model = modelFromFilename(log.filename)
  const dateStr = dateFromFilename(log.filename)

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
            <div className="summary-processing-spinner" aria-hidden="true" />
            <ul className="summary-processing-steps">
              {STEPS.map((label, i) => {
                const state =
                  i < currentStep ? 'done' :
                  i === currentStep ? 'active' :
                  'pending'
                return (
                  <li key={label} className={`summary-processing-step ${state}`}>
                    <span className="summary-processing-mark" aria-hidden="true">
                      {state === 'done' ? '✓' : state === 'active' ? '·' : '·'}
                    </span>
                    <span className="summary-processing-label">{label}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : hasRealData ? (
          <>
            <div className="summary-grid">
              <Tile label="Duration" value={fmtDuration(stats.duration)} />
              <Tile label="Max altitude" value={Math.round(stats.maxAlt)} unit="m" />
              {hasGPS && (
                <Tile label="Max speed" value={Math.round(stats.maxSpeed)} unit="km/h" />
              )}
              {hasGPS && stats.maxDistFromHomeKm > 0 && (
                <Tile label="Max from home" value={fmtDistance(stats.maxDistFromHomeKm)} />
              )}
              {hasGPS && stats.distanceKm > 0 && (
                <Tile label="Total distance" value={fmtDistance(stats.distanceKm)} />
              )}
              <Tile label="Max climb" value={stats.maxClimb.toFixed(1)} unit="m/s" />
              <Tile label="Max sink" value={stats.maxSink.toFixed(1)} unit="m/s" />
              {hasBattery && stats.minVoltage != null && (
                <Tile label="Min voltage" value={stats.minVoltage.toFixed(1)} unit="V" />
              )}
              {hasCurrent && stats.maxCurrent > 0 && (
                <Tile label="Max current" value={stats.maxCurrent.toFixed(1)} unit="A" />
              )}
              {hasCurrent && stats.maxCapacity > 0 && (
                <Tile label="Used" value={Math.round(stats.maxCapacity)} unit="mAh" />
              )}
              {stats.minRSSI != null && (
                <Tile label="Min RSSI" value={Math.round(stats.minRSSI)} unit="dB" />
              )}
              {stats.dominantMode && flightModes.length > 1 && (
                <Tile
                  label="Most-used mode"
                  value={stats.dominantMode}
                  unit={`${Math.round(stats.dominantPct * 100)}%`}
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

// Switch units below 1 km so a 200 m hover doesn't read "0.20 km".
function fmtDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(2)} km`
}

function modelFromFilename(filename) {
  return filename
    .replace(/\.csv$/i, '')
    .replace(/-\d{4}-\d{2}-\d{2}-\d{6}$/, '')
}

function dateFromFilename(filename) {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  return `${m[1]} ${m[2]}:${m[3]}`
}
