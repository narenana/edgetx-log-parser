import { forwardRef, useImperativeHandle, useRef } from 'react'

/**
 * Fighter Aircraft Joystick — top-down view of a centre stick.
 *
 * What you see (from "above the cockpit", looking down at the pilot's
 * lap):
 *   - Round gimbal base, slightly metallic.
 *   - Cross-hair guide rings showing the stick's mechanical envelope.
 *   - A pistol-grip handle silhouette in the centre. The handle's
 *     position offsets from centre proportional to stick deflection:
 *       roll  → handle moves LEFT/RIGHT
 *       pitch → handle moves UP/DOWN within the gimbal
 *       (positive pitch = "stick pulled back" = nose-up command, so
 *        handle moves DOWN in our top-down view, toward the pilot)
 *   - Trail line from gimbal centre to current handle position — reads
 *     as the stick's "lean" without needing 3D rendering.
 *   - Detail glyphs on the handle (trigger nub, hat-switch dot) so the
 *     silhouette reads as "fighter pistol grip" rather than "blob".
 *
 * Imperative API:
 *   ref.current.setStick(rollPercent, pitchPercent)
 *     rollPct  : -100 (full left)  → +100 (full right)
 *     pitchPct : -100 (push fwd)   → +100 (pull back)
 *
 * Source: rcCommand[0] / rcCommand[1] from iNAV/Betaflight blackbox, or
 * Ail / Ele from EdgeTX CSV. Both pre-normalized in the parsers.
 */

const SIZE = 110
const CX = SIZE / 2
const CY = SIZE / 2
const GIMBAL_R = SIZE / 2 - 6              // outer ring
const ENVELOPE_R = GIMBAL_R - 6            // inner deflection limit
const HANDLE_TRAVEL = ENVELOPE_R - 6       // max pixel offset from centre

const Joystick = forwardRef(function Joystick(_props, ref) {
  const handleGroupRef = useRef(null)
  const trailRef = useRef(null)
  const valueRollRef = useRef(null)
  const valuePitchRef = useRef(null)
  const noTlmRef = useRef(null)

  useImperativeHandle(ref, () => ({
    setStick(rollPct, pitchPct) {
      const rOk = Number.isFinite(rollPct)
      const pOk = Number.isFinite(pitchPct)
      if (!rOk && !pOk) {
        if (handleGroupRef.current) handleGroupRef.current.setAttribute('transform', 'translate(0 0)')
        if (trailRef.current) {
          trailRef.current.setAttribute('x2', CX)
          trailRef.current.setAttribute('y2', CY)
        }
        if (valueRollRef.current) valueRollRef.current.textContent = '—'
        if (valuePitchRef.current) valuePitchRef.current.textContent = '—'
        if (noTlmRef.current) noTlmRef.current.style.display = 'block'
        return
      }
      if (noTlmRef.current) noTlmRef.current.style.display = 'none'

      const r = rOk ? Math.max(-100, Math.min(100, rollPct)) : 0
      const p = pOk ? Math.max(-100, Math.min(100, pitchPct)) : 0

      // Roll: +100 → handle moves right (+X). Pitch: +100 ("pulled back",
      // nose-up command) → handle moves DOWN in top-down view (+Y in SVG
      // coordinates, since SVG +Y goes down on screen).
      const dx = (r / 100) * HANDLE_TRAVEL
      const dy = (p / 100) * HANDLE_TRAVEL
      const handleX = CX + dx
      const handleY = CY + dy

      if (handleGroupRef.current) {
        handleGroupRef.current.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`)
      }
      // Trail line from centre to handle. Slight z-axis hint by changing
      // stroke-width with deflection — reads as "the stick is leaning".
      if (trailRef.current) {
        trailRef.current.setAttribute('x2', handleX.toFixed(2))
        trailRef.current.setAttribute('y2', handleY.toFixed(2))
      }
      if (valueRollRef.current) {
        valueRollRef.current.textContent = (r >= 0 ? 'R' : 'L') + Math.abs(r).toFixed(0)
      }
      if (valuePitchRef.current) {
        // P+ = nose up, P- = nose down. UI reads "U25" / "D25".
        valuePitchRef.current.textContent = (p >= 0 ? 'U' : 'D') + Math.abs(p).toFixed(0)
      }
    },
  }))

  // Gimbal envelope rings — every 25% deflection.
  const envelopeRings = [0.25, 0.50, 0.75, 1.0].map(frac => (
    <circle
      key={`env-${frac}`}
      cx={CX} cy={CY}
      r={ENVELOPE_R * frac}
      fill="none"
      stroke="#2a3245"
      strokeWidth={frac === 1.0 ? 1.0 : 0.6}
      strokeDasharray={frac === 1.0 ? 'none' : '2 2'}
    />
  ))

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="gauge gauge-joystick"
      aria-label="Pilot stick (roll + pitch input)"
    >
      <defs>
        <radialGradient id="joy-bezel" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#3a4760" />
          <stop offset="60%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#0a0e18" />
        </radialGradient>
        <radialGradient id="joy-handle" cx="40%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#5a6478" />
          <stop offset="80%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#0a0e18" />
        </radialGradient>
      </defs>

      {/* Bezel + gimbal base */}
      <circle cx={CX} cy={CY} r={GIMBAL_R + 4} fill="url(#joy-bezel)" stroke="#000" strokeWidth="1" />
      <circle cx={CX} cy={CY} r={GIMBAL_R} fill="#0a0e18" stroke="#243044" strokeWidth="1" />

      {envelopeRings}

      {/* Cross hair through centre — pilot's mental "neutral" line. */}
      <line x1={CX - GIMBAL_R + 4} y1={CY} x2={CX + GIMBAL_R - 4} y2={CY} stroke="#243044" strokeWidth="0.6" />
      <line x1={CX} y1={CY - GIMBAL_R + 4} x2={CX} y2={CY + GIMBAL_R - 4} stroke="#243044" strokeWidth="0.6" />

      {/* Trail / "lean" line from centre to handle position */}
      <line
        ref={trailRef}
        x1={CX} y1={CY}
        x2={CX} y2={CY}
        stroke="#ff9e64"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.6"
      />

      {/* Handle group — moved by setStick. Pistol-grip silhouette: an
          asymmetric oval (the grip body) + a small nub on the front
          (trigger) + a dot on top (hat switch). Subtle but reads as
          "fighter stick" rather than "ball". */}
      <g ref={handleGroupRef} transform="translate(0 0)">
        {/* Drop shadow on the gimbal beneath the stick. */}
        <ellipse cx={CX} cy={CY + 1.5} rx="9" ry="6.5" fill="#000" opacity="0.45" />
        {/* Grip body — pistol-grip outline, narrower at top, wider at base.
            Drawn as a closed path. */}
        <path
          d={`
            M ${CX - 7} ${CY - 6}
            Q ${CX - 9} ${CY - 2}, ${CX - 8} ${CY + 4}
            Q ${CX - 7} ${CY + 7}, ${CX} ${CY + 7}
            Q ${CX + 7} ${CY + 7}, ${CX + 8} ${CY + 4}
            Q ${CX + 9} ${CY - 2}, ${CX + 7} ${CY - 6}
            Q ${CX + 4} ${CY - 8}, ${CX} ${CY - 8}
            Q ${CX - 4} ${CY - 8}, ${CX - 7} ${CY - 6}
            Z
          `}
          fill="url(#joy-handle)"
          stroke="#0a0e18"
          strokeWidth="1"
        />
        {/* Trigger nub on the front (toward pitch +). */}
        <circle cx={CX} cy={CY + 5.5} r="1.3" fill="#243044" />
        {/* Hat switch dot on top. */}
        <circle cx={CX} cy={CY - 4} r="1.5" fill="#7a8294" stroke="#000" strokeWidth="0.4" />
        {/* Highlight stripe — reads as the metal collar at the gimbal. */}
        <line x1={CX - 5} y1={CY - 7} x2={CX + 5} y2={CY - 7} stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
      </g>

      {/* Pivot dot (always at gimbal centre, behind everything visually
          but drawn last for clean appearance when stick is at neutral) */}
      <circle cx={CX} cy={CY} r="1.6" fill="#ff9e64" opacity="0.8" />

      {/* Bottom labels — roll and pitch values side-by-side */}
      <text
        ref={valueRollRef}
        x={CX - 16}
        y={SIZE - 4}
        fontSize="8"
        fill="#e8eef8"
        textAnchor="middle"
        fontWeight="600"
        fontFamily="Consolas, monospace"
      >R0</text>
      <text
        ref={valuePitchRef}
        x={CX + 16}
        y={SIZE - 4}
        fontSize="8"
        fill="#e8eef8"
        textAnchor="middle"
        fontWeight="600"
        fontFamily="Consolas, monospace"
      >U0</text>

      {/* "no input data" overlay */}
      <text
        ref={noTlmRef}
        x={CX}
        y={CY + 1}
        fontSize="6.5"
        fill="#7a8294"
        textAnchor="middle"
        letterSpacing="0.5"
        style={{ display: 'none' }}
      >NO TLM</text>

      {/* Top label */}
      <text x={CX} y="9" fontSize="6" fill="#7a8294" textAnchor="middle" letterSpacing="0.5">STICK</text>
    </svg>
  )
})

export default Joystick
