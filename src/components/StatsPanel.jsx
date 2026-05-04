import { useState } from 'react'

/**
 * Whole-flight stats panel. Sits at the TOP of dashboard-right (above
 * the chart panels) — single source of truth for high-level metrics
 * during analysis. Previously two separate views overlapped:
 *
 *   - A horizontal strip below the visualisation showed Duration / Max
 *     Alt / Max Speed / Distance / Max Climb / Max Sink / Min Volt /
 *     Used.
 *   - The pre-flight FlightSummaryModal showed the same eight PLUS Max
 *     from home / Max current / Min RSSI / Most-used mode.
 *
 * Both have been collapsed into this single block, with the FULL UNION
 * of 12 fields. The modal still appears during parse for the loading
 * animation + reveal, but the right-side panel is the persistent
 * reference once the dashboard is open.
 *
 * Live cursor row pinned at the bottom shows the current playback
 * position (T+, lat/lon, alt, FM) — the only field that changes per
 * cursor move; the rest are computed once at log load.
 */

function fmt(val, decimals = 0, unit = '') {
  if (val == null || isNaN(val)) return '—'
  return `${val.toFixed(decimals)}${unit}`
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function fmtDistance(km) {
  if (km == null || isNaN(km)) return '—'
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(2)} km`
}

export default function StatsPanel({ log, cursorRow }) {
  // Mobile-only: collapsed by default to save vertical space. Desktop
  // CSS overrides the toggle to always-show.
  const [expanded, setExpanded] = useState(false)
  const { stats, hasGPS, hasBattery, hasCurrent, flightModes } = log

  // Build the tile list with the full union of fields. Conditionals match
  // the modal's behaviour so we don't show "—" for telemetry the log
  // never carried (e.g. RSSI on a sample log without RX info).
  const items = [
    { label: 'Duration',     value: fmtDuration(stats.duration) },
    { label: 'Max Alt',      value: fmt(stats.maxAlt, 0), unit: 'm' },
  ]
  if (hasGPS) {
    items.push({ label: 'Max Speed', value: fmt(stats.maxSpeed, 0), unit: 'km/h' })
  }
  if (hasGPS && stats.distanceKm > 0) {
    items.push({ label: 'Distance', value: fmtDistance(stats.distanceKm) })
  }
  if (hasGPS && stats.maxDistFromHomeKm > 0) {
    items.push({ label: 'Max from home', value: fmtDistance(stats.maxDistFromHomeKm) })
  }
  items.push(
    { label: 'Max Climb', value: fmt(stats.maxClimb, 1), unit: 'm/s' },
    { label: 'Max Sink',  value: fmt(stats.maxSink,  1), unit: 'm/s' },
  )
  if (hasBattery && stats.minVoltage != null) {
    items.push({ label: 'Min Voltage', value: fmt(stats.minVoltage, 1), unit: 'V' })
  }
  if (hasCurrent && stats.maxCurrent > 0) {
    items.push({ label: 'Max Current', value: fmt(stats.maxCurrent, 1), unit: 'A' })
  }
  if (hasCurrent && stats.maxCapacity > 0) {
    items.push({ label: 'Used', value: fmt(stats.maxCapacity, 0), unit: 'mAh' })
  }
  if (stats.minRSSI != null) {
    items.push({ label: 'Min RSSI', value: fmt(stats.minRSSI, 0), unit: 'dB' })
  }
  if (stats.dominantMode && flightModes.length > 1) {
    items.push({
      label: 'Most-used mode',
      value: stats.dominantMode,
      unit: `${Math.round(stats.dominantPct * 100)}%`,
    })
  }

  return (
    <div className={`stats-panel-wrap${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="stats-toggle"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        Flight Stats {expanded ? '▴' : '▾'}
      </button>
      <div className="stats-panel">
        {items.map(item => (
          <div key={item.label} className="stat-item">
            <div className="stat-label">{item.label}</div>
            <div className="stat-value">
              {item.value}
              {item.unit ? <span className="stat-unit"> {item.unit}</span> : null}
            </div>
          </div>
        ))}
      </div>
      {cursorRow && (
        <div className="stats-cursor-row" aria-label="Current cursor position">
          <span className="stats-cursor-pill">
            <span className="stats-cursor-label">T+</span>
            {fmtDuration(cursorRow._tSec)}
          </span>
          {cursorRow._lat != null && (
            <span className="stats-cursor-pill">
              {cursorRow._lat.toFixed(5)}, {cursorRow._lon.toFixed(5)}
            </span>
          )}
          <span className="stats-cursor-pill">
            <span className="stats-cursor-label">Alt</span>
            {fmt(cursorRow['Alt(m)'], 0, ' m')}
          </span>
          {cursorRow['FM'] && (
            <span className="stats-cursor-pill">{cursorRow['FM']}</span>
          )}
        </div>
      )}
    </div>
  )
}
