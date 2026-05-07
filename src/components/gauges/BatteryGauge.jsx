import { forwardRef, useImperativeHandle, useRef, useMemo } from 'react'
import { polar, arcPath, mapClamp, detectBatteryConfig } from './gaugeUtils'

/**
 * Battery Voltage Gauge — aircraft-styled.
 *
 * Real cockpit voltmeters are round dials with a coloured arc:
 *   green = healthy,  yellow = caution,  red = "land NOW".
 * Our RC version follows the same convention but the thresholds are
 * derived from the pack's cell count (auto-detected from log peak):
 *
 *     voltage / cell    →    arc colour    →    pilot meaning
 *     ─────────────────────────────────────────────────────────
 *     ≥ 3.70 V/cell           green             cruise / safe
 *     3.50 – 3.70 V/cell      yellow            consider landing
 *     < 3.50 V/cell           red               LAND IMMEDIATELY
 *
 * Sweep matches the airspeed/altimeter dials so the cluster reads as
 * a unit. The needle colour shifts with the arc the needle currently
 * sits on — at a glance you see "I'm in the green / yellow / red".
 *
 * If the log has no battery telemetry at all (rare on iNAV but happens
 * on raw EdgeTX CSVs), the gauge auto-disables itself by hiding the
 * needle and showing "—" instead of a misleading "0V". The component
 * still renders so the cluster layout doesn't shift between logs.
 */

const SIZE = 90
const R = SIZE / 2 - 2
const SWEEP_FROM = -120
const SWEEP_TO   = 120
const SWEEP_TOTAL = SWEEP_TO - SWEEP_FROM

const NEEDLE_COLOR_OK   = '#9ece6a'
const NEEDLE_COLOR_WARN = '#e8c450'
const NEEDLE_COLOR_BAD  = '#e85060'

const BatteryGauge = forwardRef(function BatteryGauge({ rows }, ref) {
  // Detect cell count + thresholds once per log. Memoised so we don't
  // walk all rows every frame.
  const cfg = useMemo(() => detectBatteryConfig(rows), [rows])

  // Dial scale: 3.0 V/cell at the bottom (deep red — pack is toast)
  // through 4.2 V/cell at the top (full charge).
  const vMin = cfg.cells * 3.0
  const vMax = cfg.cells * 4.2

  const needleRef = useRef(null)
  const needleStrokeRef = useRef([null, null])
  const valueRef = useRef(null)
  const cellRef = useRef(null)

  useImperativeHandle(ref, () => ({
    setVoltage(volts) {
      // No telemetry data → show dashes, hide needle. Don't update the
      // cell label (it was set once at mount).
      if (!cfg.detected || !Number.isFinite(volts)) {
        if (valueRef.current) valueRef.current.textContent = '—'
        if (needleRef.current) needleRef.current.style.opacity = '0.2'
        return
      }
      if (needleRef.current) needleRef.current.style.opacity = '1'

      const angle = mapClamp(volts, vMin, vMax, SWEEP_FROM, SWEEP_TO)
      if (needleRef.current) {
        needleRef.current.setAttribute(
          'transform',
          `rotate(${angle.toFixed(2)} ${SIZE / 2} ${SIZE / 2})`,
        )
      }

      // Colour the needle based on arc — pilots reading at a glance
      // shouldn't have to compare needle position to arc colour.
      const perCell = volts / cfg.cells
      const color = perCell >= 3.70 ? NEEDLE_COLOR_OK
                  : perCell >= 3.50 ? NEEDLE_COLOR_WARN
                  : NEEDLE_COLOR_BAD
      const [main, tail] = needleStrokeRef.current
      if (main) main.setAttribute('stroke', color)
      if (tail) tail.setAttribute('stroke', color)

      if (valueRef.current) {
        valueRef.current.textContent = volts.toFixed(2) + 'V'
      }
    },
  }))

  const cx = SIZE / 2
  const cy = SIZE / 2

  // Major ticks: per-cell voltages (3.0, 3.3, 3.6, 3.9, 4.2 V/cell).
  // The labels show pack-level voltage so the user reads what the gauge
  // is showing rather than per-cell math.
  const PER_CELL_TICKS = [3.0, 3.3, 3.6, 3.9, 4.2]
  const majorTicks = []
  for (const pc of PER_CELL_TICKS) {
    const v = pc * cfg.cells
    const t = (v - vMin) / (vMax - vMin)
    const angle = SWEEP_FROM + SWEEP_TOTAL * t
    const outer = polar(cx, cy, R - 2, angle)
    const inner = polar(cx, cy, R - 10, angle)
    const label = polar(cx, cy, R - 17, angle)
    // Compact label — 1 decimal so it fits at small sizes.
    majorTicks.push(
      <g key={`maj-${pc}`}>
        <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="#e8eef8" strokeWidth="1.4" />
        <text x={label.x} y={label.y + 2.8} fontSize="7" fill="#cfd8e8" textAnchor="middle">
          {v.toFixed(v >= 10 ? 0 : 1)}
        </text>
      </g>,
    )
  }

  // Minor ticks every 0.1 V/cell between majors.
  const minorTicks = []
  for (let pc = 3.0; pc <= 4.2 + 0.001; pc += 0.1) {
    const isMajor = PER_CELL_TICKS.some(m => Math.abs(m - pc) < 0.05)
    if (isMajor) continue
    const v = pc * cfg.cells
    const t = (v - vMin) / (vMax - vMin)
    const angle = SWEEP_FROM + SWEEP_TOTAL * t
    const outer = polar(cx, cy, R - 2, angle)
    const inner = polar(cx, cy, R - 7, angle)
    minorTicks.push(
      <line
        key={`min-${pc.toFixed(1)}`}
        x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
        stroke="#7a8294" strokeWidth="0.7"
      />,
    )
  }

  // Color arcs: red 3.0–3.5, yellow 3.5–3.7, green 3.7–4.2 V/cell.
  const angleAt = (perCell) => {
    const v = perCell * cfg.cells
    const t = (v - vMin) / (vMax - vMin)
    return SWEEP_FROM + SWEEP_TOTAL * t
  }
  const ARC_R = R - 4
  const redArc    = arcPath(cx, cy, ARC_R, angleAt(3.0), angleAt(3.5))
  const yellowArc = arcPath(cx, cy, ARC_R, angleAt(3.5), angleAt(3.7))
  const greenArc  = arcPath(cx, cy, ARC_R, angleAt(3.7), angleAt(4.2))

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="gauge gauge-battery"
      aria-label="Battery voltage"
    >
      <defs>
        <radialGradient id="bat-bezel" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#3a4760" />
          <stop offset="60%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#0a0e18" />
        </radialGradient>
      </defs>

      <circle cx={cx} cy={cy} r={R} fill="url(#bat-bezel)" stroke="#000" strokeWidth="1" />

      <path d={redArc}    stroke="#e85060" strokeWidth="3" fill="none" opacity="0.95" />
      <path d={yellowArc} stroke="#e8c450" strokeWidth="3" fill="none" opacity="0.85" />
      <path d={greenArc}  stroke="#5fb04f" strokeWidth="3" fill="none" opacity="0.85" />

      {minorTicks}
      {majorTicks}

      {/* Cell-count badge — small text near the top so the user knows
          this gauge is auto-scaled to their pack size. */}
      <text x={cx} y={cy - 6} fontSize="6" fill="#7a8294" textAnchor="middle" letterSpacing="0.5">
        VOLTS
      </text>
      <text
        ref={cellRef}
        x={cx}
        y={cy + 2}
        fontSize="6.5"
        fill="#cfd8e8"
        textAnchor="middle"
        fontWeight="600"
        letterSpacing="0.5"
      >{cfg.detected ? `${cfg.cells}S LIPO` : 'NO TLM'}</text>

      {/* Digital readout */}
      <text
        ref={valueRef}
        x={cx}
        y={cy + 16}
        fontSize="13"
        fill="#e8eef8"
        textAnchor="middle"
        fontWeight="600"
        fontFamily="Consolas, monospace"
      >{cfg.detected ? '0.00V' : '—'}</text>

      {/* Needle */}
      <g ref={needleRef} transform={`rotate(${SWEEP_FROM} ${cx} ${cy})`}>
        <line
          ref={el => { needleStrokeRef.current[0] = el }}
          x1={cx} y1={cy + 6}
          x2={cx} y2={cy - (R - 6)}
          stroke={NEEDLE_COLOR_OK}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <line
          ref={el => { needleStrokeRef.current[1] = el }}
          x1={cx} y1={cy}
          x2={cx} y2={cy + 8}
          stroke={NEEDLE_COLOR_OK}
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.7"
        />
      </g>

      <circle cx={cx} cy={cy} r="2.6" fill="#0a0e18" stroke="#cfd8e8" strokeWidth="1" />

      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#243044" strokeWidth="2" />
    </svg>
  )
})

export default BatteryGauge
