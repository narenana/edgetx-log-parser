import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react'
import FlightMap from './FlightMap'
import SyncedChart from './SyncedChart'
import FlightModeBar from './FlightModeBar'
import StatsPanel from './StatsPanel'
import FullscreenButton from './FullscreenButton'
import { track } from '../utils/analytics'

// GlobeView pulls in Cesium (external via vite-plugin-cesium) and the
// Three.js GLB exporter. AltitudeAttitudeView pulls in the Three.js runtime.
// Both are heavy and only needed for the active view mode — lazy chunks let
// users on the alternate view skip the download entirely until they switch.
const GlobeView = lazy(() => import('./GlobeView'))
const AltitudeAttitudeView = lazy(() => import('./AltitudeAttitudeView'))

const SPEEDS = [0.1, 0.5, 1, 2, 5, 10, 30, 60]

function ds(label, data, color, extra = {}) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color + '18',
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 3,
    tension: 0.15,
    fill: false,
    ...extra,
  }
}

export default function Dashboard({ log, theme = 'light' }) {
  const [viewMode, setViewMode] = useState(2) // 1 = classic, 2 = 3D globe
  const [cursorIndex, setCursorIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [speedExpanded, setSpeedExpanded] = useState(false)
  const speedRef = useRef(speed)
  const virtualTimeRef = useRef(0)
  useEffect(() => { speedRef.current = speed }, [speed])

  const { rows, events } = log

  // ── Per-log analytics summary (privacy-safe aggregates only) ────────────────
  // Fired once per loaded log. No GPS, no flight content — just shape metrics
  // that help us see what kinds of flights people are analysing.
  useEffect(() => {
    track('log_summary', {
      duration_sec: Math.round(log.stats?.duration ?? 0),
      row_count: rows.length,
      has_gps: !!log.hasGPS,
      has_battery: !!log.hasBattery,
      has_current: !!log.hasCurrent,
      mode_count: log.flightModes?.length ?? 0,
      event_count: events?.length ?? 0,
    })
  }, [log.filename]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Animation loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return

    // Seed virtual time from the cursor's current position
    virtualTimeRef.current = rows[cursorIndex]?._tSec ?? 0
    let lastReal = performance.now()

    const id = setInterval(() => {
      const now = performance.now()
      virtualTimeRef.current += ((now - lastReal) / 1000) * speedRef.current
      lastReal = now
      const vt = virtualTimeRef.current

      setCursorIndex(prev => {
        if (prev >= rows.length - 1) { setPlaying(false); return prev }
        // Advance as many rows as virtual time has passed — but never go back
        let next = prev
        while (next < rows.length - 1 && rows[next + 1]._tSec <= vt) next++
        return next
      })
    }, 33)

    return () => clearInterval(id)
  }, [playing, rows])

  // ── Space bar to play/pause ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = e => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault()
        setPlaying(p => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Move cursor + keep virtualTime in sync for smooth interpolation
  const handleCursor = useCallback(
    idx => {
      if (idx >= 0 && idx < rows.length) {
        setCursorIndex(idx)
        virtualTimeRef.current = rows[idx]._tSec
      }
    },
    [rows]
  )

  // ── Chart data ──────────────────────────────────────────────────────────────
  const labels = useMemo(
    () =>
      rows.map(r => {
        const s = Math.round(r._tSec)
        return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
      }),
    [rows]
  )

  const attitudeDatasets = useMemo(
    () => [
      ds('Pitch°', rows.map(r => r._pitchDeg?.toFixed(1) ?? null), '#f7768e'),
      ds('Roll°', rows.map(r => r._rollDeg?.toFixed(1) ?? null), '#7aa2f7'),
      ds('Yaw°', rows.map(r => r._yawDeg?.toFixed(1) ?? null), '#bb9af7', { borderDash: [4, 3] }),
    ],
    [rows]
  )

  const altDatasets = useMemo(
    () => [
      ds('Alt (m)', rows.map(r => r['Alt(m)']), '#9ece6a'),
      ds('VSpd (m/s)', rows.map(r => r['VSpd(m/s)']), '#7dcfff', { yAxisID: 'y1' }),
    ],
    [rows]
  )

  const speedDatasets = useMemo(
    () => [
      ds('Speed (km/h)', rows.map(r => r['GSpd(kmh)']), '#ff9e64'),
      ds('Heading (°)', rows.map(r => r['Hdg(°)']), '#e0af68', { borderDash: [4, 3], yAxisID: 'y1' }),
    ],
    [rows]
  )

  const batteryDatasets = useMemo(() => {
    const result = []
    if (log.hasBattery)
      result.push(ds('Voltage (V)', rows.map(r => r['RxBt(V)'] || null), '#e0af68'))
    if (log.hasCurrent)
      result.push(ds('Current (A)', rows.map(r => r['Curr(A)'] || null), '#f7768e', { yAxisID: 'y1' }))
    return result
  }, [rows, log.hasBattery, log.hasCurrent])

  const signalDatasets = useMemo(
    () => [
      ds('RSSI-1 (dB)', rows.map(r => r['1RSS(dB)']), '#9ece6a'),
      ds('RSSI-2 (dB)', rows.map(r => (r['2RSS(dB)'] ? r['2RSS(dB)'] : null)), '#7dcfff'),
      ds('Link Qual%', rows.map(r => r['RQly(%)']), '#bb9af7', { yAxisID: 'y1' }),
    ],
    [rows]
  )

  // ── Cursor info string ──────────────────────────────────────────────────────
  const cursorRow = rows[cursorIndex]
  const tStr = cursorRow
    ? `T+${Math.floor(cursorRow._tSec / 60)}:${(Math.round(cursorRow._tSec) % 60)
        .toString()
        .padStart(2, '0')}  ${cursorRow['FM'] || ''}  Alt ${cursorRow['Alt(m)']}m  ${cursorRow['GSpd(kmh)']} km/h`
    : ''

  return (
    <div className="dashboard">
      {/* View mode toggle */}
      <div className="view-toggle-bar">
        <span className="view-toggle-label">View</span>
        <button
          className={`view-toggle-btn${viewMode === 1 ? ' active' : ''}`}
          onClick={() => {
            if (viewMode !== 1) {
              setViewMode(1)
              track('view_changed', { mode: 'classic' })
            }
          }}
          title="2D map + attitude panel"
        >
          ① Classic
        </button>
        <button
          className={`view-toggle-btn${viewMode === 2 ? ' active' : ''}`}
          onClick={() => {
            if (viewMode !== 2) {
              setViewMode(2)
              track('view_changed', { mode: 'globe' })
            }
          }}
          title="3D globe with satellite imagery"
        >
          ② 3D Globe
        </button>
      </div>

      <div className="dashboard-main">
        <div className="dashboard-left">
          {viewMode === 2 ? (
            /* ── 3D Globe view ── */
            log.hasGPS ? (
              <div className="globe-wrap">
                <FullscreenButton targetClass="globe-wrap" />
                <Suspense fallback={<div className="lazy-fallback">Loading 3D globe…</div>}>
                  <GlobeView key={log.filename} rows={rows} cursorIndex={cursorIndex} virtualTimeRef={virtualTimeRef} />
                </Suspense>
              </div>
            ) : (
              <div className="no-gps-msg">No GPS data</div>
            )
          ) : (
            /* ── Classic: 2D map + attitude ── */
            <>
              <div className="map-wrap">
                <FullscreenButton targetClass="map-wrap" />
                {log.hasGPS ? (
                  <FlightMap rows={rows} cursorIndex={cursorIndex} />
                ) : (
                  <div className="no-gps-msg">No GPS data</div>
                )}
              </div>
              <Suspense fallback={<div className="lazy-fallback attitude-view">Loading attitude view…</div>}>
                <AltitudeAttitudeView rows={rows} cursorIndex={cursorIndex} virtualTimeRef={virtualTimeRef} />
              </Suspense>
            </>
          )}
          <StatsPanel log={log} cursorRow={cursorRow} />
        </div>

        <div className="dashboard-right">
          <SyncedChart title="Attitude" datasets={attitudeDatasets} labels={labels} yLabel="degrees" cursorIndex={cursorIndex} onCursorChange={handleCursor} theme={theme} />
          <SyncedChart title="Altitude & Vertical Speed" datasets={altDatasets} labels={labels} yLabel="m" y1Label="m/s" cursorIndex={cursorIndex} onCursorChange={handleCursor} theme={theme} />
          <SyncedChart title="Speed & Heading" datasets={speedDatasets} labels={labels} yLabel="km/h" y1Label="degrees" cursorIndex={cursorIndex} onCursorChange={handleCursor} theme={theme} />
          {batteryDatasets.length > 0 && (
            <SyncedChart title="Battery" datasets={batteryDatasets} labels={labels} yLabel="V" y1Label="A" cursorIndex={cursorIndex} onCursorChange={handleCursor} theme={theme} />
          )}
          <SyncedChart title="Signal" datasets={signalDatasets} labels={labels} yLabel="dBm" y1Label="%" cursorIndex={cursorIndex} onCursorChange={handleCursor} theme={theme} />
        </div>
      </div>

      <div className="dashboard-bottom">
        {/* Playback controls */}
        <div className="playback-row">
          <button
            className={`play-btn${playing ? ' active' : ''}`}
            onClick={() => {
              setPlaying(p => {
                const next = !p
                if (next) track('playback_started', { speed })
                return next
              })
            }}
            title="Play / Pause (Space)"
          >
            {playing ? '⏸' : '▶'}
          </button>

          {/* Speed picker — full row of pills on desktop, single chip
              that opens a popover scroller on mobile (CSS handles the swap). */}
          <div className={`speed-picker${speedExpanded ? ' expanded' : ''}`}>
            <button
              type="button"
              className="speed-current"
              onClick={() => setSpeedExpanded(e => !e)}
              aria-expanded={speedExpanded}
              aria-label={`Playback speed ${speed}×, tap to change`}
            >
              {speed}×
            </button>
            <div className="speed-pills">
              {SPEEDS.map(s => (
                <button
                  key={s}
                  type="button"
                  className={`speed-btn${speed === s ? ' active' : ''}`}
                  onClick={() => {
                    if (s !== speed) {
                      setSpeed(s)
                      track('playback_speed_changed', { speed: s })
                    }
                    setSpeedExpanded(false)
                  }}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>

          <div className="cursor-info" style={{ marginLeft: 'auto' }}>{tStr}</div>
        </div>

        {/* Flight mode bar with event markers */}
        <FlightModeBar
          rows={rows}
          cursorIndex={cursorIndex}
          onCursorChange={idx => { handleCursor(idx); setPlaying(false) }}
          events={events}
          onSegmentClick={mode => track('flight_mode_clicked', { mode })}
          onEventClick={type => track('event_marker_clicked', { type })}
        />

        {/* Timeline scrubber */}
        <input
          type="range"
          className="timeline-scrubber"
          min={0}
          max={rows.length - 1}
          value={cursorIndex}
          onChange={e => {
            const idx = Number(e.target.value)
            setCursorIndex(idx)
            virtualTimeRef.current = rows[idx]._tSec
            setPlaying(false)
          }}
        />
      </div>
    </div>
  )
}
