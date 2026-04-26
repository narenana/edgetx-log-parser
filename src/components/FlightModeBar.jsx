import { useMemo } from 'react'
import { fmColor } from './FlightMap'

const EVENT_STYLES = {
  takeoff: { icon: '▲', label: 'T/O',     color: '#9ece6a' },
  rth_on:  { icon: '⚑', label: 'RTH',     color: '#f7768e' },
  rth_off: { icon: '⚐', label: 'RTH off', color: '#ff9e64' },
  land:    { icon: '▼', label: 'LND',     color: '#7dcfff' },
}

export default function FlightModeBar({
  rows,
  cursorIndex,
  onCursorChange,
  events = [],
  onSegmentClick,
  onEventClick,
}) {
  const activeMode = rows[cursorIndex]?.['FM'] || null
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
    const idx = Math.round(frac * (total - 1))
    onCursorChange(idx)
    const mode = rows[idx]?.['FM']
    if (mode && onSegmentClick) onSegmentClick(mode)
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
                onClick={() => {
                  onCursorChange(ev.index)
                  if (onEventClick) onEventClick(ev.type)
                }}
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
        {/* cursor tick — bright + slight glow so it's easy to spot on a busy bar */}
        <div
          style={{
            position: 'absolute',
            left: `${(cursorIndex / total) * 100}%`,
            top: -1,
            bottom: -1,
            width: 3,
            marginLeft: -1.5,
            background: '#fff',
            opacity: 0.95,
            boxShadow: '0 0 6px rgba(255, 255, 255, 0.7), 0 0 2px rgba(255, 255, 255, 0.9)',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* Legend — active mode lights up */}
      <div className="fm-legend">
        {uniqueModes.map(mode => {
          const isActive = mode === activeMode
          return (
            <div
              key={mode}
              className={`fm-legend-item${isActive ? ' fm-legend-active' : ''}`}
              style={{ opacity: isActive ? 1 : 0.35 }}
            >
              <div
                className="fm-legend-dot"
                style={{
                  background: fmColor(mode),
                  boxShadow: isActive ? `0 0 6px ${fmColor(mode)}` : 'none',
                }}
              />
              <span style={{ color: isActive ? fmColor(mode) : 'var(--text3)', fontWeight: isActive ? 700 : 400 }}>
                {mode}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
