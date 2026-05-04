import { forwardRef, useImperativeHandle, useRef } from 'react'

/**
 * Artificial Horizon (Attitude Indicator).
 *
 * Visual layout (matches a real Cessna primary AI):
 *   - Sky/ground "world" half-circle, clipped to the gauge bezel.
 *   - Pitch ladder on the world (white horizontal lines every 10°).
 *   - Roll arc with tick marks at 0/±10/±20/±30/±60/±90 (fixed).
 *   - Roll pointer at the top: triangle that rotates with the world to
 *     show current roll against the fixed arc.
 *   - Center "W" aircraft icon (fixed) — the pilot's reference point.
 *
 * Roll: world rotates by -roll. Positive roll = right wing down → world
 *       tilts CCW from the pilot's perspective.
 * Pitch: world translates vertically. +1° pitch = world moves DOWN by
 *        PIXELS_PER_DEG so the horizon line falls below the aircraft W
 *        (climb attitude).
 *
 * Imperative API:
 *   const ref = useRef()
 *   ref.current.setAttitude(pitchDeg, rollDeg)
 * Skips React re-renders during playback — needles update via direct
 * style.transform mutation, same pattern GlobeView uses for the model.
 */

const SIZE = 110          // px (largest gauge in the cluster)
const R = SIZE / 2 - 2    // bezel radius
const PIXELS_PER_DEG = 1.6 // pitch ladder spacing (visible range ±25°)
const PITCH_LADDER_DEGS = [-30, -20, -10, 10, 20, 30]
const ROLL_TICK_DEGS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]

const AttitudeIndicator = forwardRef(function AttitudeIndicator(_props, ref) {
  // worldRef wraps the rotating + translating "horizon view" group.
  const worldRef = useRef(null)
  // rollPointerRef is the small triangle at the top that rotates with roll.
  const rollPointerRef = useRef(null)

  useImperativeHandle(ref, () => ({
    setAttitude(pitchDeg, rollDeg) {
      const p = Number.isFinite(pitchDeg) ? pitchDeg : 0
      const r = Number.isFinite(rollDeg) ? rollDeg : 0
      // Clamp pitch to ±25° so the world doesn't slide entirely out of
      // the gauge at extreme attitudes (still readable).
      const clampedPitch = Math.max(-25, Math.min(25, p))
      // Roll: world rotates -roll; pitch: world translates +pitch (in px).
      const tyPx = clampedPitch * PIXELS_PER_DEG
      if (worldRef.current) {
        worldRef.current.setAttribute(
          'transform',
          `translate(0 ${tyPx.toFixed(2)}) rotate(${(-r).toFixed(2)} ${SIZE / 2} ${SIZE / 2 - tyPx})`,
        )
      }
      // Roll pointer rotates with the world so it always points at
      // current bank against the fixed arc behind it.
      if (rollPointerRef.current) {
        rollPointerRef.current.setAttribute(
          'transform',
          `rotate(${(-r).toFixed(2)} ${SIZE / 2} ${SIZE / 2})`,
        )
      }
    },
  }))

  const cx = SIZE / 2
  const cy = SIZE / 2

  // Pre-compute roll tick mark coordinates. The ticks live on a circle
  // just inside the bezel, with 0 at top, +ve = right (CW).
  const rollTickPath = ROLL_TICK_DEGS.map(deg => {
    const major = Math.abs(deg) === 0 || Math.abs(deg) === 30 || Math.abs(deg) === 60
    const inner = R - (major ? 12 : 8)
    const outer = R - 2
    const a = ((deg - 90) * Math.PI) / 180
    const x1 = cx + outer * Math.cos(a)
    const y1 = cy + outer * Math.sin(a)
    const x2 = cx + inner * Math.cos(a)
    const y2 = cy + inner * Math.sin(a)
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)}`
  }).join(' ')

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="gauge gauge-attitude"
      aria-label="Attitude indicator"
    >
      <defs>
        {/* Clip the rotating world to the inner gauge area so the sky/
            ground rectangle doesn't bleed past the bezel. Inset by 4 px
            so the bezel stroke is always visible on top. */}
        <clipPath id="ai-clip">
          <circle cx={cx} cy={cy} r={R - 4} />
        </clipPath>
        {/* Subtle radial highlight so the gauge feels backlit. */}
        <radialGradient id="ai-bezel" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#3a4760" />
          <stop offset="60%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#0a0e18" />
        </radialGradient>
      </defs>

      {/* Outer bezel */}
      <circle cx={cx} cy={cy} r={R} fill="url(#ai-bezel)" stroke="#000" strokeWidth="1" />

      {/* Rotating + translating world (sky + ground + pitch ladder).
          Clipped to the inner circle. */}
      <g clipPath="url(#ai-clip)">
        <g ref={worldRef} transform={`rotate(0 ${cx} ${cy})`}>
          {/* Sky: extends WAY beyond the gauge so rotation/translation
              never reveals empty space. Width/height 4× SIZE is overkill
              but cheap and bulletproof. */}
          <rect
            x={cx - SIZE * 2}
            y={cy - SIZE * 2}
            width={SIZE * 4}
            height={SIZE * 2}
            fill="#3aa1ff"
          />
          {/* Ground */}
          <rect
            x={cx - SIZE * 2}
            y={cy}
            width={SIZE * 4}
            height={SIZE * 2}
            fill="#7a4a1e"
          />
          {/* Horizon line — bright white for visibility */}
          <line
            x1={cx - SIZE * 2}
            y1={cy}
            x2={cx + SIZE * 2}
            y2={cy}
            stroke="#fff"
            strokeWidth="1.4"
          />

          {/* Pitch ladder — short bars at ±10°/±20°/±30° with degree labels. */}
          {PITCH_LADDER_DEGS.map(deg => {
            const y = cy - deg * PIXELS_PER_DEG
            const halfLen = Math.abs(deg) === 10 ? 14 : Math.abs(deg) === 20 ? 22 : 30
            return (
              <g key={deg}>
                <line
                  x1={cx - halfLen}
                  y1={y}
                  x2={cx + halfLen}
                  y2={y}
                  stroke="#fff"
                  strokeWidth="1.0"
                  opacity="0.85"
                />
                <text
                  x={cx - halfLen - 3}
                  y={y + 3}
                  fontSize="7"
                  fill="#fff"
                  textAnchor="end"
                  opacity="0.7"
                >{Math.abs(deg)}</text>
                <text
                  x={cx + halfLen + 3}
                  y={y + 3}
                  fontSize="7"
                  fill="#fff"
                  textAnchor="start"
                  opacity="0.7"
                >{Math.abs(deg)}</text>
              </g>
            )
          })}
        </g>
      </g>

      {/* Roll arc tick marks (fixed) — sit on the bezel ring just inside
          the outer edge. Major ticks longer + more opaque. */}
      <path d={rollTickPath} stroke="#fff" strokeWidth="1.2" fill="none" opacity="0.85" />

      {/* Roll arc cardinal labels at ±30 / ±60 for readability */}
      <text x={cx} y={cy - R + 5} fontSize="6" fill="#fff" textAnchor="middle" opacity="0.5">0</text>

      {/* Roll pointer — small triangle at the top, rotates with roll so
          it lines up with the bezel ticks behind it. */}
      <g ref={rollPointerRef} transform={`rotate(0 ${cx} ${cy})`}>
        <polygon
          points={`${cx},${cy - R + 4} ${cx - 4},${cy - R + 11} ${cx + 4},${cy - R + 11}`}
          fill="#ff9e64"
          stroke="#000"
          strokeWidth="0.4"
        />
      </g>

      {/* Aircraft "W" reference (fixed, always centered). Two small
          orange triangles + a centre dot — reads as "the wings of YOUR
          plane, watching the world tilt". */}
      <g>
        <line x1={cx - 24} y1={cy} x2={cx - 9} y2={cy} stroke="#ff9e64" strokeWidth="2.5" strokeLinecap="round" />
        <line x1={cx + 9} y1={cy} x2={cx + 24} y2={cy} stroke="#ff9e64" strokeWidth="2.5" strokeLinecap="round" />
        <line x1={cx - 9} y1={cy} x2={cx - 9} y2={cy + 4} stroke="#ff9e64" strokeWidth="2.5" strokeLinecap="round" />
        <line x1={cx + 9} y1={cy} x2={cx + 9} y2={cy + 4} stroke="#ff9e64" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="1.6" fill="#ff9e64" />
      </g>

      {/* Bezel ring on top of everything else for a clean edge */}
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#243044" strokeWidth="2" />
    </svg>
  )
})

export default AttitudeIndicator
