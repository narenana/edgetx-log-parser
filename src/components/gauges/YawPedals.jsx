import { forwardRef, useImperativeHandle, useRef } from 'react'

/**
 * Yaw / Rudder Pedals.
 *
 * Real cockpit pedals are heel-toe — pushing the LEFT pedal feeds left
 * rudder (yaw -), pushing the RIGHT feeds right rudder (yaw +). When
 * one pedal goes forward, the other goes back (rigid linkage). We
 * mirror that mechanical coupling here:
 *
 *   yaw = -100 % → left pedal slides forward, right pedal slides back
 *   yaw =  +100 % → right pedal forward, left back
 *   yaw =  0     → both centred
 *
 * Visual is a top-down view of the cockpit footwell:
 *   - Two trapezoidal foot rests, hinged at the back.
 *   - Active pedal turns yellow (more pressure = more saturated).
 *   - A center-line bar between them — the rudder bar's effective
 *     position. Slides with yaw to make the input direction obvious
 *     even at small deflections.
 *
 * Imperative API:
 *   ref.current.setYaw(yawPercent)   // -100..+100
 */

const W = 110
const H = 60
const CX = W / 2
const PEDAL_W = 26
const PEDAL_H = 38
const GAP = 8
const PEDAL_LEFT_X = CX - GAP / 2 - PEDAL_W
const PEDAL_RIGHT_X = CX + GAP / 2
const PEDAL_TRAVEL = 8           // max forward/back slide in px
const PEDAL_BASE_Y = (H - PEDAL_H) / 2

const PEDAL_INACTIVE = '#3a4760'
const PEDAL_ACTIVE = '#e8c450'   // yellow — same caution-arc colour as airspeed

const YawPedals = forwardRef(function YawPedals(_props, ref) {
  const leftRef = useRef(null)
  const rightRef = useRef(null)
  const leftFillRef = useRef(null)
  const rightFillRef = useRef(null)
  const barRef = useRef(null)
  const valueRef = useRef(null)
  const noTlmRef = useRef(null)

  useImperativeHandle(ref, () => ({
    setYaw(pct) {
      if (!Number.isFinite(pct)) {
        if (leftRef.current) leftRef.current.setAttribute('transform', 'translate(0 0)')
        if (rightRef.current) rightRef.current.setAttribute('transform', 'translate(0 0)')
        if (leftFillRef.current) leftFillRef.current.setAttribute('fill', PEDAL_INACTIVE)
        if (rightFillRef.current) rightFillRef.current.setAttribute('fill', PEDAL_INACTIVE)
        if (barRef.current) barRef.current.setAttribute('transform', 'translate(0 0)')
        if (valueRef.current) valueRef.current.textContent = '—'
        if (noTlmRef.current) noTlmRef.current.style.display = 'block'
        return
      }
      if (noTlmRef.current) noTlmRef.current.style.display = 'none'
      const y = Math.max(-100, Math.min(100, pct))
      // Positive yaw = right pedal forward (-Y in SVG, "up" the page).
      // Linkage: when one pedal goes forward, the other goes back by the
      // same amount.
      const rightDy = -(y / 100) * PEDAL_TRAVEL
      const leftDy = +(y / 100) * PEDAL_TRAVEL
      if (rightRef.current) {
        rightRef.current.setAttribute('transform', `translate(0 ${rightDy.toFixed(2)})`)
      }
      if (leftRef.current) {
        leftRef.current.setAttribute('transform', `translate(0 ${leftDy.toFixed(2)})`)
      }
      // Highlight the active pedal (the one being pressed). Mix the
      // active colour by absolute deflection — small inputs barely glow.
      const intensity = Math.min(1, Math.abs(y) / 100)
      const mix = (a, b, t) => Math.round(a * (1 - t) + b * t)
      const activeR = mix(0x3a, 0xe8, intensity).toString(16).padStart(2, '0')
      const activeG = mix(0x47, 0xc4, intensity).toString(16).padStart(2, '0')
      const activeB = mix(0x60, 0x50, intensity).toString(16).padStart(2, '0')
      const activeColor = `#${activeR}${activeG}${activeB}`
      if (y > 0) {
        if (rightFillRef.current) rightFillRef.current.setAttribute('fill', activeColor)
        if (leftFillRef.current) leftFillRef.current.setAttribute('fill', PEDAL_INACTIVE)
      } else if (y < 0) {
        if (leftFillRef.current) leftFillRef.current.setAttribute('fill', activeColor)
        if (rightFillRef.current) rightFillRef.current.setAttribute('fill', PEDAL_INACTIVE)
      } else {
        if (leftFillRef.current) leftFillRef.current.setAttribute('fill', PEDAL_INACTIVE)
        if (rightFillRef.current) rightFillRef.current.setAttribute('fill', PEDAL_INACTIVE)
      }
      // Rudder bar — translates a fraction of pedal travel to amplify
      // the visual cue. Sign matches yaw (+ → bar slides right).
      const barDx = (y / 100) * 6
      if (barRef.current) {
        barRef.current.setAttribute('transform', `translate(${barDx.toFixed(2)} 0)`)
      }
      if (valueRef.current) {
        valueRef.current.textContent = (y > 0 ? 'R' : y < 0 ? 'L' : '') + Math.abs(y).toFixed(0)
      }
    },
  }))

  const trapezoidPath = (x, y, w, h) => `
    M ${x + 4} ${y}
    L ${x + w - 4} ${y}
    L ${x + w} ${y + h}
    L ${x} ${y + h}
    Z
  `

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="gauge gauge-pedals"
      aria-label="Yaw / rudder pedals"
    >
      <defs>
        <linearGradient id="ped-bezel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#0a0e18" />
        </linearGradient>
      </defs>

      {/* Bezel */}
      <rect x="2" y="2" width={W - 4} height={H - 4} rx="6" fill="url(#ped-bezel)" stroke="#243044" strokeWidth="1" />

      {/* Top label */}
      <text x={CX} y="9" fontSize="6" fill="#7a8294" textAnchor="middle" letterSpacing="0.5">RUDDER</text>

      {/* Centre-line "rudder bar" — slides with yaw input. Sits behind
          the pedals so they read as overlaid on the bar. */}
      <g ref={barRef} transform="translate(0 0)">
        <rect
          x={CX - 1}
          y={PEDAL_BASE_Y + PEDAL_H / 2 - 0.6}
          width="2"
          height="1.2"
          fill="#5a6478"
          opacity="0.8"
        />
        <circle cx={CX} cy={PEDAL_BASE_Y + PEDAL_H / 2} r="2" fill="#ff9e64" opacity="0.7" />
      </g>

      {/* Left pedal (port) */}
      <g ref={leftRef} transform="translate(0 0)">
        <path
          ref={leftFillRef}
          d={trapezoidPath(PEDAL_LEFT_X, PEDAL_BASE_Y, PEDAL_W, PEDAL_H)}
          fill={PEDAL_INACTIVE}
          stroke="#000"
          strokeWidth="0.7"
        />
        {/* Heel rest line near the back */}
        <line
          x1={PEDAL_LEFT_X + 4} y1={PEDAL_BASE_Y + 4}
          x2={PEDAL_LEFT_X + PEDAL_W - 4} y2={PEDAL_BASE_Y + 4}
          stroke="rgba(255,255,255,0.15)" strokeWidth="0.8"
        />
        <text x={PEDAL_LEFT_X + PEDAL_W / 2} y={PEDAL_BASE_Y + PEDAL_H - 4} fontSize="6.5" fill="#cfd8e8" textAnchor="middle" fontWeight="600">L</text>
      </g>

      {/* Right pedal (starboard) */}
      <g ref={rightRef} transform="translate(0 0)">
        <path
          ref={rightFillRef}
          d={trapezoidPath(PEDAL_RIGHT_X, PEDAL_BASE_Y, PEDAL_W, PEDAL_H)}
          fill={PEDAL_INACTIVE}
          stroke="#000"
          strokeWidth="0.7"
        />
        <line
          x1={PEDAL_RIGHT_X + 4} y1={PEDAL_BASE_Y + 4}
          x2={PEDAL_RIGHT_X + PEDAL_W - 4} y2={PEDAL_BASE_Y + 4}
          stroke="rgba(255,255,255,0.15)" strokeWidth="0.8"
        />
        <text x={PEDAL_RIGHT_X + PEDAL_W / 2} y={PEDAL_BASE_Y + PEDAL_H - 4} fontSize="6.5" fill="#cfd8e8" textAnchor="middle" fontWeight="600">R</text>
      </g>

      {/* Digital readout below — "L25" or "R25" or "0". */}
      <text
        ref={valueRef}
        x={CX}
        y={H - 2}
        fontSize="7"
        fill="#e8eef8"
        textAnchor="middle"
        fontWeight="600"
        fontFamily="Consolas, monospace"
      >0</text>

      {/* "no input data" overlay */}
      <text
        ref={noTlmRef}
        x={CX}
        y={H / 2 + 2}
        fontSize="6"
        fill="#7a8294"
        textAnchor="middle"
        letterSpacing="0.5"
        style={{ display: 'none' }}
      >NO TLM</text>
    </svg>
  )
})

export default YawPedals
