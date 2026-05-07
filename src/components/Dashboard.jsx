import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react'
import FlightMap from './FlightMap'
import SyncedChart from './SyncedChart'
import FlightModeBar from './FlightModeBar'
import StatsPanel from './StatsPanel'
import FullscreenButton from './FullscreenButton'
import { track } from '../utils/analytics'

// FlightSummaryModal is now rendered at the App level so it can be
// shown during async blackbox parsing (before the log object exists)
// and survive the parsing→log transition without remounting. This file
// no longer imports it.

// GlobeView pulls in Cesium (external via vite-plugin-cesium) and the
// Three.js GLB exporter. AltitudeAttitudeView pulls in the Three.js runtime.
// Both are heavy and only needed for the active view mode — lazy chunks let
// users on the alternate view skip the download entirely until they switch.
const GlobeView = lazy(() => import('./GlobeView'))
const AltitudeAttitudeView = lazy(() => import('./AltitudeAttitudeView'))
// Cockpit clusters live OUTSIDE the globe view (below it, in a strip), so
// we render them at this level. They expose imperative `update(row)`
// methods; GlobeView's preRender callback drives them via refs we own
// here. Single-rAF UI ⇒ no backdrop-filter perf cost over the WebGL
// canvas, no duplicate interpRows work.
const GaugeCluster = lazy(() => import('./gauges/GaugeCluster'))
const ControlsCluster = lazy(() => import('./gauges/ControlsCluster'))

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
  const [bookmarks, setBookmarks] = useState([]) // sorted ascending row indices
  const speedRef = useRef(speed)
  const virtualTimeRef = useRef(0)
  // Cluster refs are owned at this level (above GlobeView) because the
  // strip lives below the globe — but GlobeView's Cesium preRender is
  // the single rAF that drives them. We pass the refs DOWN into the
  // globe so the preRender callback can call update(r) on each.
  const gaugeClusterRef = useRef(null)
  const controlsClusterRef = useRef(null)
  // Mirror bookmarks into a ref so the rAF playback loop can read the
  // latest list without restarting every time the array changes.
  const bookmarksRef = useRef(bookmarks)
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { bookmarksRef.current = bookmarks }, [bookmarks])

  const { rows, events } = log

  // ── Bookmarks: per-log, persisted to localStorage ───────────────────────────
  // Stable fingerprint = filename + row-count + first-row-tSec. Two
  // different logs with the same filename (recorded after a reset, or
  // re-opened after re-parsing) get distinct keys via the row metadata.
  const bookmarkKey = useMemo(() => {
    const fname = log.filename || 'untitled'
    const t0 = rows[0]?._tSec ?? 0
    return `bm:${fname}:${rows.length}:${Math.round(t0)}`
  }, [log.filename, rows])

  // Load bookmarks when the log (or its fingerprint) changes.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(bookmarkKey)
      const parsed = raw ? JSON.parse(raw) : []
      setBookmarks(Array.isArray(parsed) ? parsed.filter(i => Number.isInteger(i) && i >= 0 && i < rows.length) : [])
    } catch { setBookmarks([]) }
  }, [bookmarkKey, rows.length])

  // Save bookmarks on change. Skip the very first run (initial empty array
  // from useState) — the load effect above writes the canonical value.
  const bmFirstRun = useRef(true)
  useEffect(() => {
    if (bmFirstRun.current) { bmFirstRun.current = false; return }
    try { localStorage.setItem(bookmarkKey, JSON.stringify(bookmarks)) } catch {}
  }, [bookmarkKey, bookmarks])

  // True when the current cursor position matches an existing bookmark
  // (within a small tolerance of ±2 rows, so users don't have to land on
  // the exact same frame to "remove" it).
  const cursorOnBookmark = useMemo(() => {
    return bookmarks.some(i => Math.abs(i - cursorIndex) <= 2)
  }, [bookmarks, cursorIndex])

  const saveBookmark = useCallback(() => {
    setBookmarks(prev => {
      // Toggle: if cursor is on (or near) an existing bookmark, remove it
      const near = prev.find(i => Math.abs(i - cursorIndex) <= 2)
      if (near != null) {
        track('bookmark_removed')
        return prev.filter(i => i !== near)
      }
      track('bookmark_saved', { count: prev.length + 1 })
      return [...prev, cursorIndex].sort((a, b) => a - b)
    })
  }, [cursorIndex])

  const jumpToBookmark = useCallback((direction) => {
    if (bookmarks.length === 0) return
    let target
    if (direction === 'next') {
      target = bookmarks.find(i => i > cursorIndex)
      if (target == null) target = bookmarks[0]                  // wrap → first
    } else {
      target = [...bookmarks].reverse().find(i => i < cursorIndex)
      if (target == null) target = bookmarks[bookmarks.length - 1] // wrap → last
    }
    setCursorIndex(target)
    virtualTimeRef.current = rows[target]._tSec
    setPlaying(false)
    track('bookmark_jumped', { direction })
  }, [bookmarks, cursorIndex, rows])

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
  // Driven by requestAnimationFrame so virtualTimeRef updates land at the
  // monitor's actual refresh rate (60 / 120 / 144 Hz). The previous
  // setInterval(33ms) ran at a fixed ~30 Hz which caused visible
  // stuttering at higher playback speeds: each tick advanced the virtual
  // time by `33 ms × speed`, so at 10× a single visual update covered
  // 330 ms of motion — the screen could render that as one big jump
  // instead of a smooth slide. With RAF, the gap between paints is one
  // vsync frame, so even at 30× speed the motion is smooth: GlobeView's
  // preRender uses interpRows(rows, vt) to compute a continuous in-between
  // position regardless of how dense the source rows are.
  useEffect(() => {
    if (!playing) return

    // Seed virtual time from the cursor's current position
    virtualTimeRef.current = rows[cursorIndex]?._tSec ?? 0
    let lastReal = performance.now()
    let raf = 0

    const tick = () => {
      const now = performance.now()
      virtualTimeRef.current += ((now - lastReal) / 1000) * speedRef.current
      lastReal = now
      const vt = virtualTimeRef.current

      setCursorIndex(prev => {
        if (prev >= rows.length - 1) {
          setPlaying(false)
          return prev
        }
        let next = prev
        while (next < rows.length - 1 && rows[next + 1]._tSec <= vt) next++
        // Pause on bookmark crossing. We only fire when the cursor has
        // ADVANCED into a bookmark — i.e. there's a bookmark strictly
        // greater than `prev` and at-or-before `next`. Pressing play
        // while parked on a bookmark therefore doesn't immediately
        // re-pause; we keep going until we cross the NEXT one.
        if (next > prev) {
          const bms = bookmarksRef.current
          // bms is sorted ascending — first match is the closest one
          // we just rolled past.
          const hit = bms.find(b => b > prev && b <= next)
          if (hit != null) {
            setPlaying(false)
            virtualTimeRef.current = rows[hit]._tSec
            track('bookmark_auto_pause')
            return hit
          }
        }
        // React bails on a state set if the value is identical, so frames
        // where the source row didn't change are essentially free.
        return next
      })

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
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
              <>
                <div className="globe-wrap">
                  <FullscreenButton targetClass="globe-wrap" />
                  <Suspense fallback={<div className="lazy-fallback">Loading 3D globe…</div>}>
                    <GlobeView
                      key={log.filename}
                      rows={rows}
                      cursorIndex={cursorIndex}
                      virtualTimeRef={virtualTimeRef}
                      gaugeClusterRef={gaugeClusterRef}
                      controlsClusterRef={controlsClusterRef}
                    />
                  </Suspense>
                </div>
                {/* Cockpit strip — instruments LEFT, pilot inputs RIGHT.
                    Lives BELOW the globe (not over it) so no backdrop-
                    filter blur over the continuously-invalidating WebGL
                    canvas. GlobeView's Cesium preRender drives the
                    cluster updates via the refs we own here. */}
                <div className="cockpit-strip" aria-label="Cockpit panel">
                  <Suspense fallback={null}>
                    <GaugeCluster ref={gaugeClusterRef} rows={rows} />
                    <ControlsCluster ref={controlsClusterRef} />
                  </Suspense>
                </div>
              </>
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
        </div>

        <div className="dashboard-right">
          {/* Combined flight stats — union of the previous below-viz panel
              and the parse-time modal grid. Lives at the TOP of the right
              column so it sits above the chart panels and stays in view
              while the user scrolls through individual chart cards. */}
          <StatsPanel log={log} cursorRow={cursorRow} />
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
            className="bookmark-btn nav-btn-prev"
            onClick={() => jumpToBookmark('prev')}
            disabled={bookmarks.length === 0}
            title="Jump to previous bookmark"
            aria-label="Jump to previous bookmark"
          >
            ⏮
          </button>

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

          <button
            className="bookmark-btn nav-btn-next"
            onClick={() => jumpToBookmark('next')}
            disabled={bookmarks.length === 0}
            title="Jump to next bookmark"
            aria-label="Jump to next bookmark"
          >
            ⏭
          </button>

          <button
            className={`bookmark-btn save-bookmark${cursorOnBookmark ? ' active' : ''}`}
            onClick={saveBookmark}
            title={cursorOnBookmark ? 'Remove bookmark here' : 'Save bookmark at current position'}
            aria-label={cursorOnBookmark ? 'Remove bookmark here' : 'Save bookmark at current position'}
            aria-pressed={cursorOnBookmark}
          >
            {cursorOnBookmark ? '★' : '☆'}
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

        {/* Timeline scrubber + bookmark markers. Markers sit in an
            overlay div positioned over the scrubber — they don't
            intercept clicks (pointer-events: none in CSS) so the
            scrubber's drag still works through them. */}
        <div className="scrubber-wrap">
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
          {bookmarks.length > 0 && (
            <div className="bookmark-marks" aria-hidden="true">
              {bookmarks.map(idx => (
                <span
                  key={idx}
                  className="bookmark-mark"
                  style={{ left: `${(idx / (rows.length - 1)) * 100}%` }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
