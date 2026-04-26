import { useState } from 'react'

function fmt(val, decimals = 0, unit = '') {
  if (val == null || isNaN(val)) return '—'
  return `${val.toFixed(decimals)}${unit}`
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function StatsPanel({ log, cursorRow }) {
  // Collapsed by default — only matters at <= 640px (CSS hides the toggle
  // and force-shows the panel above that). Stored in component state so
  // the choice survives across cursor moves but resets on log switch.
  const [expanded, setExpanded] = useState(false)
  const { stats, hasBattery, hasCurrent } = log

  const statItems = [
    { label: 'Duration', value: fmtDuration(stats.duration) },
    { label: 'Max Alt', value: fmt(stats.maxAlt, 0, ' m') },
    { label: 'Max Speed', value: fmt(stats.maxSpeed, 0, ' km/h') },
    { label: 'Distance', value: fmt(stats.distanceKm, 2, ' km') },
    { label: 'Max Climb', value: fmt(stats.maxClimb, 1, ' m/s') },
    { label: 'Max Sink', value: fmt(stats.maxSink, 1, ' m/s') },
    ...(hasBattery
      ? [{ label: 'Min Volt', value: fmt(stats.minVoltage, 1, ' V') }]
      : []),
    ...(hasCurrent
      ? [{ label: 'Used', value: fmt(stats.maxCapacity, 0, ' mAh') }]
      : []),
  ]

  return (
    <div className={`stats-panel-wrap${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="stats-toggle"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        Stats {expanded ? '▴' : '▾'}
      </button>
      <div className="stats-panel">
        {statItems.map(item => (
          <div key={item.label} className="stat-item">
            <div className="stat-label">{item.label}</div>
            <div className="stat-value">{item.value}</div>
          </div>
        ))}
        {cursorRow && (
          <div className="stat-item" style={{ flexBasis: '100%', borderRight: 'none', borderTop: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={{ color: 'var(--text3)', fontSize: 10 }}>
              T+{fmtDuration(cursorRow._tSec)}
            </span>
            {cursorRow._lat != null && (
              <span style={{ color: 'var(--text3)', fontSize: 10 }}>
                {cursorRow._lat.toFixed(5)}, {cursorRow._lon.toFixed(5)}
              </span>
            )}
            <span style={{ color: 'var(--text3)', fontSize: 10 }}>
              Alt {fmt(cursorRow['Alt(m)'], 0, 'm')}
            </span>
            <span style={{ color: 'var(--text3)', fontSize: 10 }}>
              {cursorRow['FM']}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
