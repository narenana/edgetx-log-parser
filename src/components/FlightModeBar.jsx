import { useMemo } from 'react'
import { fmColor } from './FlightMap'

const EVENT_STYLES = {
  takeoff: { icon: '▲', label: 'T/O',     color: '#9ece6a' },
  rth_on:  { icon: '⚑', label: 'RTH',     color: '#f7768e' },
  rth_off: { icon: '⚐', label: 'RTH off', color: '#ff9e64' },
  land:    { icon: '▼', label: 'LND',     color: '#7dcfff' },
}

export default function FlightModeBar({ rows, cursorIndex, onCursorChange, events = [] }) {
  const segments = useMemo(() => {
    if (!rows.length) return []
    const segs = []
    let mode = rows[0]['FM'] || 'UNKNOWN'
    let start = 0
    for (let i = 1; i < rows.length; i++) {
      const m = rows[i]['FM'] || 'UNKNOWN'
      if (m !== mode) {
        segs.push({ mode, start, end: i - 1 })
        mode = m
        start = i
      }
    }
    segs.push({ mode, start, end: rows.length - 1 })
    return segs
  }, [rows])

  const total = rows.length
  const uniqueModes = [...new Set(segments.map(s => s.mode))]

  const handleBarClick = (e, el) => {
    const rect = el.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width
    onCursorChange(Math.round(frac * (total - 1)))
  }

  return (
    <div className="fm-bar-wrap">
      {/* Event markers row */}
      {events.length > 0 && (
        <div className="fm-events-row">
          {events.map((ev, i) => {
            const style = EVENT_STYLES[ev.type]
            if (!style) return null
            const leftPct = (ev.index / total) * 100
            return (
              <div
                key={i}
                className="fm-event"
                style={{ left: `${leftPct}%`, color: style.color }}
                title={`${style.label} at T+${Math.floor(rows[ev.index]?._tSec / 60)}:${String(Math.round(rows[ev.index]?._tSec) % 60).padStart(2, '0')}`}
                onClick={() => onCursorChange(ev.index)}
              >
                <span className="fm-event-label">{style.label}</span>
                <span className="fm-event-icon">{style.icon}</span>
                <span className="fm-event-stem" />
              </div>
            )
          })}
        </div>
      )}

      {/* Mode colour bar */}
      <div
        className="fm-segments"
        onClick={e => handleBarClick(e, e.currentTarget)}
        style={{ cursor: 'pointer' }}
      >
        {segments.map((seg, i) => (
          <div
            key={i}
            className="fm-segment"
            style={{
              width: `${((seg.end - seg.start + 1) / total) * 100}%`,
              background: fmColor(seg.mode),
            }}
            title={`${seg.mode} — ${seg.end - seg.start + 1}s`}
          />
        ))}
        {/* cursor tick */}
        <div
          style={{
            position: 'absolute',
            left: `${(cursorIndex / total) * 100}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: '#fff',
            opacity: 0.8,
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Legend */}
      <div className="fm-legend">
        {uniqueModes.map(mode => (
          <div key={mode} className="fm-legend-item">
            <div className="fm-legend-dot" style={{ background: fmColor(mode) }} />
            {mode}
          </div>
        ))}
      </div>
    </div>
  )
}
