import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import FlightMap from './FlightMap'
import SyncedChart from './SyncedChart'
import FlightModeBar from './FlightModeBar'
import StatsPanel from './StatsPanel'

const SPEEDS = [1, 2, 5, 10, 30, 60]

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

export default function Dashboard({ log }) {
  const [cursorIndex, setCursorIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const speedRef = useRef(speed)
  useEffect(() => { speedRef.current = speed }, [speed])

  const { rows, events } = log

  // ── Animation loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return

    let lastReal = performance.now()

    const id = setInterval(() => {
      const now = performance.now()
      const flightDelta = ((now - lastReal) / 1000) * speedRef.current
      lastReal = now

      setCursorIndex(prev => {
        if (prev >= rows.length - 1) {
          setPlaying(false)
          return prev
        }
        const targetSec = rows[prev]._tSec + flightDelta
        let next = prev + 1
        while (next < rows.length - 1 && rows[next]._tSec < targetSec) next++
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

  const handleCursor = useCallback(
    idx => {
      if (idx >= 0 && idx < rows.length) setCursorIndex(idx)
    },
    [rows.length]
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
      <div className="dashboard-main">
        <div className="dashboard-left">
          <div className="map-wrap">
            {log.hasGPS ? (
              <FlightMap rows={rows} cursorIndex={cursorIndex} />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)', fontSize: 13 }}>
                No GPS data
              </div>
            )}
          </div>
          <StatsPanel log={log} cursorRow={cursorRow} />
        </div>

        <div className="dashboard-right">
          <SyncedChart title="Attitude" datasets={attitudeDatasets} labels={labels} yLabel="degrees" cursorIndex={cursorIndex} onCursorChange={handleCursor} />
          <SyncedChart title="Altitude & Vertical Speed" datasets={altDatasets} labels={labels} yLabel="m" y1Label="m/s" cursorIndex={cursorIndex} onCursorChange={handleCursor} />
          <SyncedChart title="Speed & Heading" datasets={speedDatasets} labels={labels} yLabel="km/h" y1Label="degrees" cursorIndex={cursorIndex} onCursorChange={handleCursor} />
          {batteryDatasets.length > 0 && (
            <SyncedChart title="Battery" datasets={batteryDatasets} labels={labels} yLabel="V" y1Label="A" cursorIndex={cursorIndex} onCursorChange={handleCursor} />
          )}
          <SyncedChart title="Signal" datasets={signalDatasets} labels={labels} yLabel="dBm" y1Label="%" cursorIndex={cursorIndex} onCursorChange={handleCursor} />
        </div>
      </div>

      <div className="dashboard-bottom">
        {/* Playback controls */}
        <div className="playback-row">
          <button
            className={`play-btn${playing ? ' active' : ''}`}
            onClick={() => setPlaying(p => !p)}
            title="Play / Pause (Space)"
          >
            {playing ? '⏸' : '▶'}
          </button>
          <div className="speed-btns">
            {SPEEDS.map(s => (
              <button
                key={s}
                className={`speed-btn${speed === s ? ' active' : ''}`}
                onClick={() => setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
          <div className="cursor-info" style={{ marginLeft: 'auto' }}>{tStr}</div>
        </div>

        {/* Flight mode bar with event markers */}
        <FlightModeBar
          rows={rows}
          cursorIndex={cursorIndex}
          onCursorChange={idx => { handleCursor(idx); setPlaying(false) }}
          events={events}
        />

        {/* Timeline scrubber */}
        <input
          type="range"
          className="timeline-scrubber"
          min={0}
          max={rows.length - 1}
          value={cursorIndex}
          onChange={e => { setCursorIndex(Number(e.target.value)); setPlaying(false) }}
        />
      </div>
    </div>
  )
}
