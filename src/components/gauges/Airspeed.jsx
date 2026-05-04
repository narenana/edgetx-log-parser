import { forwardRef, useImperativeHandle, useRef, useMemo } from 'react'
import { polar, arcPath, mapClamp, niceRoundMax } from './gaugeUtils'

/**
 * Airspeed Indicator (groundspeed in km/h, since RC blackboxes don't
 * have pitot static tubes — closest analogue is GPS-derived ground speed).
 *
 * Visual layout (matches a real Cessna ASI):
 *   - Round dial, scale picked from the log's max + 25% headroom.
 *   - Major numbered ticks every 1/5 of full scale.
 *   - Minor ticks between, no labels.
 *   - Single needle from centre, swept from 7 o'clock (0) to 5 o'clock (max).
 *   - Color arcs: green (cruise), yellow (caution), red (Vne).
 *     For RC we don't know the airframe's Vne, so we derive these from
 *     the log's own profile: green up to 50% of max, yellow 50-80%,
 *     red 80-100%. This matches the GA convention while being honest
 *     about RC limits.
 *
 * Sweep: 240° total, from -120° (7 o'clock) to +120° (5 o'clock), with
 * 0 at the bottom-left and max at the bottom-right. This leaves the
 * bottom 1/3 of the dial open for the digital readout.
 */

const SIZE = 90
const R = SIZE / 2 - 2
const SWEEP_FROM = -120     // degCW, 0=up
const SWEEP_TO   = 120
const SWEEP_TOTAL = SWEEP_TO - SWEEP_FROM

const Airspeed = forwardRef(function Airspeed({ rows }, ref) {
  // Pick a sensible full-scale value once per log: max(GSpd) + 25%, then
  // bump to the next "nice" round number so the major ticks fall on
  // whole values.
  const fullScale = useMemo(() => {
    let max = 0
    for (const r of rows) {
      const s = r['GSpd(kmh)']
      if (typeof s === 'number' && s > max) max = s
    }
    return niceRoundMax(max * 1.25 || 100)
  }, [rows])

  const needleRef = useRef(null)
  const valueRef = useRef(null)

  useImperativeHandle(ref, () => ({
    setSpeed(kmh) {
      const v = Number.isFinite(kmh) ? kmh : 0
      const angle = mapClamp(v, 0, fullScale, SWEEP_FROM, SWEEP_TO)
      if (needleRef.current) {
        needleRef.current.setAttribute(
          'transform',
          `rotate(${angle.toFixed(2)} ${SIZE / 2} ${SIZE / 2})`,
        )
      }
      if (valueRef.current) {
        valueRef.current.textContent = v.toFixed(0)
      }
    },
  }))

  const cx = SIZE / 2
  const cy = SIZE / 2

  // 5 major ticks (0, 25%, 50%, 75%, 100%) labelled.
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

  // Minor ticks every 5% of full scale (20 of them across the sweep)
  const minorTicks = []
  for (let i = 0; i <= 20; i++) {
    if (i % 4 === 0) continue   // skip positions where major ticks sit
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

  // Color arcs: green 0→50%, yellow 50→80%, red 80→100% of full scale.
  const angleAt = (frac) => SWEEP_FROM + SWEEP_TOTAL * frac
  const ARC_R = R - 4
  const greenArc  = arcPath(cx, cy, ARC_R, angleAt(0.0),  angleAt(0.50))
  const yellowArc = arcPath(cx, cy, ARC_R, angleAt(0.50), angleAt(0.80))
  const redArc    = arcPath(cx, cy, ARC_R, angleAt(0.80), angleAt(1.00))

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="gauge gauge-airspeed"
      aria-label="Airspeed indicator"
    >
      <defs>
        <radialGradient id="asi-bezel" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#3a4760" />
          <stop offset="60%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#0a0e18" />
        </radialGradient>
      </defs>

      <circle cx={cx} cy={cy} r={R} fill="url(#asi-bezel)" stroke="#000" strokeWidth="1" />

      {/* Color arcs sit just inside the bezel — visible but recessed */}
      <path d={greenArc}  stroke="#5fb04f" strokeWidth="3" fill="none" opacity="0.85" />
      <path d={yellowArc} stroke="#e8c450" strokeWidth="3" fill="none" opacity="0.85" />
      <path d={redArc}    stroke="#e85060" strokeWidth="3" fill="none" opacity="0.95" />

      {minorTicks}
      {majorTicks}

      {/* Unit + scale label */}
      <text x={cx} y={cy - 6} fontSize="6" fill="#7a8294" textAnchor="middle" letterSpacing="0.5">km/h</text>

      {/* Digital readout below the centre — large, easy to read */}
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

      {/* Needle: long thin pointer from centre with a small counter-weight tail */}
      <g ref={needleRef} transform={`rotate(${SWEEP_FROM} ${cx} ${cy})`}>
        <line x1={cx} y1={cy + 6} x2={cx} y2={cy - (R - 6)} stroke="#ff9e64" strokeWidth="1.8" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={cx} y2={cy + 8} stroke="#ff9e64" strokeWidth="2.2" strokeLinecap="round" opacity="0.7" />
      </g>

      {/* Centre hub on top of the needle */}
      <circle cx={cx} cy={cy} r="2.6" fill="#0a0e18" stroke="#ff9e64" strokeWidth="1" />

      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#243044" strokeWidth="2" />
    </svg>
  )
})

export default Airspeed
