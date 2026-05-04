import { forwardRef, useImperativeHandle, useRef, useMemo } from 'react'
import { polar, mapClamp, niceRoundMax } from './gaugeUtils'

/**
 * Altimeter (single-needle, scale picked from the log's max altitude).
 *
 * A real Cessna altimeter has 3 hands (hundreds / thousands / ten-thousands
 * of feet). For RC drones, where the typical log sits below 500 m and
 * almost never above 2 km, three hands are overkill and unreadable at
 * gauge cluster size. Single-hand dial that auto-scales to the log's
 * own ceiling reads better.
 *
 * Same sweep/style conventions as Airspeed (so the cluster looks
 * consistent): 240° sweep from 7 o'clock to 5 o'clock, color arcs
 * indicating the log's profile (green = below 50% max, yellow 50-80%,
 * orange 80-100%). Digital readout in metres at the bottom.
 *
 * Altitude is AGL (per blackbox-mapper.js — 'Alt(m)' is above-launch).
 */

const SIZE = 90
const R = SIZE / 2 - 2
const SWEEP_FROM = -120
const SWEEP_TO   = 120
const SWEEP_TOTAL = SWEEP_TO - SWEEP_FROM

const Altimeter = forwardRef(function Altimeter({ rows }, ref) {
  // Pick a sensible full-scale value: max(Alt) + 25%, then bump to the
  // next "nice" round number. Floor at 100 m so a hover log doesn't
  // produce a useless 0-30 m scale.
  const fullScale = useMemo(() => {
    let max = 0
    for (const r of rows) {
      const a = r['Alt(m)']
      if (typeof a === 'number' && a > max) max = a
    }
    const padded = max * 1.25 || 100
    return Math.max(100, niceRoundMax(padded))
  }, [rows])

  const needleRef = useRef(null)
  const valueRef = useRef(null)

  useImperativeHandle(ref, () => ({
    setAltitude(meters) {
      const a = Number.isFinite(meters) ? meters : 0
      const angle = mapClamp(a, 0, fullScale, SWEEP_FROM, SWEEP_TO)
      if (needleRef.current) {
        needleRef.current.setAttribute(
          'transform',
          `rotate(${angle.toFixed(2)} ${SIZE / 2} ${SIZE / 2})`,
        )
      }
      if (valueRef.current) {
        // Negative altitude can happen briefly on takeoff jitter — show
        // it honestly rather than clamping the readout.
        valueRef.current.textContent = a.toFixed(0)
      }
    },
  }))

  const cx = SIZE / 2
  const cy = SIZE / 2

  // 5 major ticks at 0, 25%, 50%, 75%, 100% of fullScale.
  const majorTicks = []
  for (let i = 0; i <= 5; i++) {
    const t = i / 5
    const value = Math.round(fullScale * t)
    const angle = SWEEP_FROM + SWEEP_TOTAL * t
    const outer = polar(cx, cy, R - 2, angle)
    const inner = polar(cx, cy, R - 10, angle)
    const label = polar(cx, cy, R - 17, angle)
    majorTicks.push(
      <g key={`maj-${i}`}>
        <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="#e8eef8" strokeWidth="1.4" />
        <text x={label.x} y={label.y + 2.8} fontSize="8" fill="#cfd8e8" textAnchor="middle">{value}</text>
      </g>,
    )
  }

  const minorTicks = []
  for (let i = 0; i <= 20; i++) {
    if (i % 4 === 0) continue
    const t = i / 20
    const angle = SWEEP_FROM + SWEEP_TOTAL * t
    const outer = polar(cx, cy, R - 2, angle)
    const inner = polar(cx, cy, R - 7, angle)
    minorTicks.push(
      <line
        key={`min-${i}`}
        x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
        stroke="#7a8294" strokeWidth="0.8"
      />,
    )
  }

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="gauge gauge-altimeter"
      aria-label="Altimeter"
    >
      <defs>
        <radialGradient id="alt-bezel" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#3a4760" />
          <stop offset="60%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#0a0e18" />
        </radialGradient>
      </defs>

      <circle cx={cx} cy={cy} r={R} fill="url(#alt-bezel)" stroke="#000" strokeWidth="1" />

      {minorTicks}
      {majorTicks}

      <text x={cx} y={cy - 6} fontSize="6" fill="#7a8294" textAnchor="middle" letterSpacing="0.5">m AGL</text>

      <text
        ref={valueRef}
        x={cx}
        y={cy + 16}
        fontSize="14"
        fill="#e8eef8"
        textAnchor="middle"
        fontWeight="600"
        fontFamily="Consolas, monospace"
      >0</text>

      {/* Needle: same style as airspeed but in green (altitude is the
          "primary positive" data — pilots want to know they're climbing). */}
      <g ref={needleRef} transform={`rotate(${SWEEP_FROM} ${cx} ${cy})`}>
        <line x1={cx} y1={cy + 6} x2={cx} y2={cy - (R - 6)} stroke="#9ece6a" strokeWidth="1.8" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={cx} y2={cy + 8} stroke="#9ece6a" strokeWidth="2.2" strokeLinecap="round" opacity="0.7" />
      </g>

      <circle cx={cx} cy={cy} r="2.6" fill="#0a0e18" stroke="#9ece6a" strokeWidth="1" />

      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#243044" strokeWidth="2" />
    </svg>
  )
})

export default Altimeter
