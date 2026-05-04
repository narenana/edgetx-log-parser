import { forwardRef, useImperativeHandle, useRef } from 'react'

/**
 * RC Transmitter — visual stand-in for a RadioMaster Pocket-style
 * compact two-stick controller. Replaces the previous separate
 * ThrottleLever + Joystick + YawPedals trio with a single recognisable
 * "RC remote" shape that mirrors what the pilot was actually holding.
 *
 * Stick mapping (Mode 2, the dominant convention for fixed-wing + multi-
 * rotor RC pilots):
 *   LEFT stick  — Y = throttle  (up = full, centre = 50 %, down = 0)
 *                 X = yaw       (left/right rudder)
 *   RIGHT stick — Y = pitch     (down on screen = pulled-back = nose up)
 *                 X = roll      (right of centre = right roll)
 *
 * The two stick "tops" are SVG groups that translate by the deflection
 * fraction of MAX_TRAVEL each frame. Imperative — no React re-renders
 * during playback (matches the gauge cluster pattern).
 *
 * Imperative API:
 *   ref.current.setSticks({
 *     throttle,    // 0..100, null when no telemetry
 *     yaw,         // -100..+100
 *     pitch,       // -100..+100
 *     roll,        // -100..+100
 *   })
 *
 * Visual references (from the photo):
 *   - smoky transparent dark plastic body, rounded with grip cutouts
 *   - T-shaped antenna folded back over the top
 *   - LCD screen at top centre showing live channel readouts
 *   - power LED right of the screen
 *   - a few buttons + speaker grille for texture
 *   - "RADIOMASTER" / "POCKET" branding cues
 */

const W = 240
const H = 130
const STICK_GIMBAL_R = 18         // outer gimbal ring radius
const STICK_TRAVEL = STICK_GIMBAL_R - 6  // max pixel offset for the stick top
const LEFT_GIMBAL_X = 60
const RIGHT_GIMBAL_X = W - 60
const GIMBAL_Y = 78

const RcController = forwardRef(function RcController(_props, ref) {
  const leftStickRef = useRef(null)
  const rightStickRef = useRef(null)
  const lcdLineLeftRef = useRef(null)
  const lcdLineRightRef = useRef(null)
  const noTlmRef = useRef(null)

  useImperativeHandle(ref, () => ({
    setSticks({ throttle, yaw, pitch, roll }) {
      const tOk = Number.isFinite(throttle)
      const yOk = Number.isFinite(yaw)
      const pOk = Number.isFinite(pitch)
      const rOk = Number.isFinite(roll)

      // No pilot-input telemetry at all → freeze sticks centred + show
      // the "NO TLM" overlay. Same fallback strategy the old gauges used.
      if (!tOk && !yOk && !pOk && !rOk) {
        if (leftStickRef.current) leftStickRef.current.setAttribute('transform', 'translate(0 0)')
        if (rightStickRef.current) rightStickRef.current.setAttribute('transform', 'translate(0 0)')
        if (lcdLineLeftRef.current) lcdLineLeftRef.current.textContent = 'T —  Y —'
        if (lcdLineRightRef.current) lcdLineRightRef.current.textContent = 'P —  R —'
        if (noTlmRef.current) noTlmRef.current.style.display = 'block'
        return
      }
      if (noTlmRef.current) noTlmRef.current.style.display = 'none'

      // LEFT stick: throttle is 0..100, centred at 50; convert so 50 = 0
      // px deflection, 0 = max-down, 100 = max-up. SVG +Y is DOWN on
      // screen, so positive throttle (= up visually) becomes -dy.
      const thr = tOk ? Math.max(0, Math.min(100, throttle)) : 50
      const yawV = yOk ? Math.max(-100, Math.min(100, yaw)) : 0
      const leftDx = (yawV / 100) * STICK_TRAVEL
      const leftDy = -((thr - 50) / 50) * STICK_TRAVEL
      if (leftStickRef.current) {
        leftStickRef.current.setAttribute(
          'transform',
          `translate(${leftDx.toFixed(2)} ${leftDy.toFixed(2)})`,
        )
      }

      // RIGHT stick: pitch +ve = pulled-back = nose-up = stick handle
      // moves DOWN on screen (toward pilot). Same convention as the
      // earlier Joystick component.
      const pitchV = pOk ? Math.max(-100, Math.min(100, pitch)) : 0
      const rollV = rOk ? Math.max(-100, Math.min(100, roll)) : 0
      const rightDx = (rollV / 100) * STICK_TRAVEL
      const rightDy = (pitchV / 100) * STICK_TRAVEL
      if (rightStickRef.current) {
        rightStickRef.current.setAttribute(
          'transform',
          `translate(${rightDx.toFixed(2)} ${rightDy.toFixed(2)})`,
        )
      }

      // LCD readouts — keep terse so they fit at this size. Throttle as
      // %, yaw/pitch/roll as signed integer percent. "—" for missing
      // channels (rare, but hover/preview EdgeTX logs sometimes lack one).
      if (lcdLineLeftRef.current) {
        const thrTxt = tOk ? `${thr.toFixed(0)}` : '—'
        const yawTxt = yOk ? signed(yawV) : '—'
        lcdLineLeftRef.current.textContent = `T${thrTxt} Y${yawTxt}`
      }
      if (lcdLineRightRef.current) {
        const pTxt = pOk ? signed(pitchV) : '—'
        const rTxt = rOk ? signed(rollV) : '—'
        lcdLineRightRef.current.textContent = `P${pTxt} R${rTxt}`
      }
    },
  }))

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="gauge gauge-rc-controller"
      aria-label="RC transmitter (pilot stick inputs)"
    >
      <defs>
        <linearGradient id="rc-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#1f2533" />
          <stop offset="50%" stopColor="#0f131c" />
          <stop offset="100%" stopColor="#1a1f2c" />
        </linearGradient>
        <linearGradient id="rc-gimbal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#3a4458" />
          <stop offset="100%" stopColor="#0a0e18" />
        </linearGradient>
        <radialGradient id="rc-stick-top" cx="40%" cy="35%" r="65%">
          <stop offset="0%"  stopColor="#5a6478" />
          <stop offset="80%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#000" />
        </radialGradient>
        <linearGradient id="rc-lcd" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#3a5e44" />
          <stop offset="100%" stopColor="#1d3325" />
        </linearGradient>
      </defs>

      {/* T-antenna folded over the top centre of the body. Drawn first so
          it sits BEHIND the body, peeking out the top. */}
      <g aria-hidden="true">
        <line x1={W / 2} y1="22" x2={W / 2} y2="6"
              stroke="#0a0e18" strokeWidth="3" strokeLinecap="round" />
        <line x1={W / 2 - 20} y1="6" x2={W / 2 + 20} y2="6"
              stroke="#0a0e18" strokeWidth="4" strokeLinecap="round" />
        {/* tiny side stubs to read as a T */}
        <circle cx={W / 2 - 20} cy="6" r="2" fill="#1f2533" />
        <circle cx={W / 2 + 20} cy="6" r="2" fill="#1f2533" />
      </g>

      {/* Body — rounded rectangle with grip cutouts at the bottom corners.
          Drawn as a closed path so the cutouts are part of the silhouette. */}
      <path
        d={`
          M 12 24
          Q 12 14, 24 14
          L ${W - 24} 14
          Q ${W - 12} 14, ${W - 12} 24
          L ${W - 12} ${H - 26}
          Q ${W - 12} ${H - 14}, ${W - 24} ${H - 14}
          L ${W - 60} ${H - 14}
          Q ${W - 70} ${H - 14}, ${W - 76} ${H - 24}
          L 76 ${H - 24}
          Q 70 ${H - 14}, 60 ${H - 14}
          L 24 ${H - 14}
          Q 12 ${H - 14}, 12 ${H - 26}
          Z
        `}
        fill="url(#rc-body)"
        stroke="#000"
        strokeWidth="1"
      />

      {/* Subtle highlight strip across the top — gives the smoky-plastic
          shine look. */}
      <path
        d={`M 18 18 Q ${W / 2} 26, ${W - 18} 18`}
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="1"
        fill="none"
      />

      {/* LCD screen at top centre */}
      <rect
        x={W / 2 - 28}
        y={26}
        width="56"
        height="22"
        rx="2"
        fill="url(#rc-lcd)"
        stroke="#000"
        strokeWidth="0.7"
      />
      <text
        ref={lcdLineLeftRef}
        x={W / 2}
        y={36}
        fontSize="6"
        fill="#9bd6a8"
        textAnchor="middle"
        fontFamily="Consolas, monospace"
        letterSpacing="0.2"
      >T0 Y+0</text>
      <text
        ref={lcdLineRightRef}
        x={W / 2}
        y={45}
        fontSize="6"
        fill="#9bd6a8"
        textAnchor="middle"
        fontFamily="Consolas, monospace"
        letterSpacing="0.2"
      >P+0 R+0</text>

      {/* Power LED right of the screen */}
      <circle cx={W / 2 + 36} cy={37} r="2.2" fill="#5fb04f" stroke="#000" strokeWidth="0.4" />
      <circle cx={W / 2 + 36} cy={37} r="1" fill="#a6f08c" opacity="0.8" />

      {/* Brand wordmark — tiny, just for character */}
      <text
        x={W / 2}
        y={59}
        fontSize="4.5"
        fill="#7a8294"
        textAnchor="middle"
        letterSpacing="1.5"
        fontWeight="700"
      >RADIOMASTER</text>

      {/* Speaker grille — a few small dots, left side */}
      <g fill="#3a4458" aria-hidden="true">
        {[0, 1, 2, 3, 4].map(i => (
          <circle key={`sp-${i}`} cx={20 + (i % 3) * 4} cy={32 + Math.floor(i / 3) * 4} r="0.9" />
        ))}
      </g>

      {/* Side function buttons — left column */}
      <g fill="#2a3245" stroke="#000" strokeWidth="0.4">
        <rect x={20} y={48} width="14" height="3" rx="1.2" />
        <rect x={20} y={54} width="14" height="3" rx="1.2" />
        <rect x={20} y={60} width="14" height="3" rx="1.2" />
        <rect x={20} y={66} width="14" height="3" rx="1.2" />
      </g>

      {/* Centre four-way + buttons */}
      <g fill="#2a3245" stroke="#000" strokeWidth="0.4">
        <circle cx={W / 2 - 16} cy={70} r="3" />
        <circle cx={W / 2 + 16} cy={70} r="3" />
      </g>

      {/* Right-side encoder dial */}
      <g aria-hidden="true">
        <circle cx={W - 22} cy={56} r="4.5" fill="url(#rc-gimbal)" stroke="#000" strokeWidth="0.5" />
        <line x1={W - 22} y1={51.5} x2={W - 22} y2={54}
              stroke="#7a8294" strokeWidth="1" strokeLinecap="round" />
      </g>

      {/* ── LEFT GIMBAL (throttle + yaw) ────────────────────────────── */}
      <g aria-hidden="true">
        {/* Outer recessed housing */}
        <circle cx={LEFT_GIMBAL_X} cy={GIMBAL_Y} r={STICK_GIMBAL_R}
                fill="#0a0e18" stroke="#000" strokeWidth="1" />
        {/* Inner gimbal ring (slightly metallic) */}
        <circle cx={LEFT_GIMBAL_X} cy={GIMBAL_Y} r={STICK_GIMBAL_R - 3}
                fill="url(#rc-gimbal)" stroke="#243044" strokeWidth="0.6" />
        {/* Cross-hair guides (faint, like the real plate cutout) */}
        <line x1={LEFT_GIMBAL_X - STICK_GIMBAL_R + 5} y1={GIMBAL_Y}
              x2={LEFT_GIMBAL_X + STICK_GIMBAL_R - 5} y2={GIMBAL_Y}
              stroke="#243044" strokeWidth="0.4" />
        <line x1={LEFT_GIMBAL_X} y1={GIMBAL_Y - STICK_GIMBAL_R + 5}
              x2={LEFT_GIMBAL_X} y2={GIMBAL_Y + STICK_GIMBAL_R - 5}
              stroke="#243044" strokeWidth="0.4" />
      </g>
      {/* Animated stick top — translated by setSticks each frame */}
      <g ref={leftStickRef} transform="translate(0 0)">
        {/* Drop shadow on the gimbal beneath the stick */}
        <ellipse cx={LEFT_GIMBAL_X} cy={GIMBAL_Y + 1.5} rx="6" ry="3.5" fill="#000" opacity="0.45" />
        {/* Stick top — round cap, slightly raised */}
        <circle cx={LEFT_GIMBAL_X} cy={GIMBAL_Y} r="6" fill="url(#rc-stick-top)" stroke="#000" strokeWidth="0.6" />
        {/* Subtle highlight on top */}
        <ellipse cx={LEFT_GIMBAL_X - 1.5} cy={GIMBAL_Y - 1.5} rx="2" ry="1.2"
                 fill="rgba(255,255,255,0.18)" />
      </g>
      {/* Trim switches around the left gimbal */}
      <g fill="#2a3245" stroke="#000" strokeWidth="0.4" aria-hidden="true">
        <rect x={LEFT_GIMBAL_X - 4} y={GIMBAL_Y + STICK_GIMBAL_R + 2} width="8" height="2" rx="1" />
        <rect x={LEFT_GIMBAL_X - STICK_GIMBAL_R - 8} y={GIMBAL_Y - 1} width="2" height="8" rx="1" />
      </g>

      {/* ── RIGHT GIMBAL (pitch + roll) ─────────────────────────────── */}
      <g aria-hidden="true">
        <circle cx={RIGHT_GIMBAL_X} cy={GIMBAL_Y} r={STICK_GIMBAL_R}
                fill="#0a0e18" stroke="#000" strokeWidth="1" />
        <circle cx={RIGHT_GIMBAL_X} cy={GIMBAL_Y} r={STICK_GIMBAL_R - 3}
                fill="url(#rc-gimbal)" stroke="#243044" strokeWidth="0.6" />
        <line x1={RIGHT_GIMBAL_X - STICK_GIMBAL_R + 5} y1={GIMBAL_Y}
              x2={RIGHT_GIMBAL_X + STICK_GIMBAL_R - 5} y2={GIMBAL_Y}
              stroke="#243044" strokeWidth="0.4" />
        <line x1={RIGHT_GIMBAL_X} y1={GIMBAL_Y - STICK_GIMBAL_R + 5}
              x2={RIGHT_GIMBAL_X} y2={GIMBAL_Y + STICK_GIMBAL_R - 5}
              stroke="#243044" strokeWidth="0.4" />
      </g>
      <g ref={rightStickRef} transform="translate(0 0)">
        <ellipse cx={RIGHT_GIMBAL_X} cy={GIMBAL_Y + 1.5} rx="6" ry="3.5" fill="#000" opacity="0.45" />
        <circle cx={RIGHT_GIMBAL_X} cy={GIMBAL_Y} r="6" fill="url(#rc-stick-top)" stroke="#000" strokeWidth="0.6" />
        <ellipse cx={RIGHT_GIMBAL_X - 1.5} cy={GIMBAL_Y - 1.5} rx="2" ry="1.2"
                 fill="rgba(255,255,255,0.18)" />
      </g>
      <g fill="#2a3245" stroke="#000" strokeWidth="0.4" aria-hidden="true">
        <rect x={RIGHT_GIMBAL_X - 4} y={GIMBAL_Y + STICK_GIMBAL_R + 2} width="8" height="2" rx="1" />
        <rect x={RIGHT_GIMBAL_X + STICK_GIMBAL_R + 6} y={GIMBAL_Y - 1} width="2" height="8" rx="1" />
      </g>

      {/* "POCKET" model badge — tiny, near bottom centre */}
      <text
        x={W / 2}
        y={H - 6}
        fontSize="5"
        fill="#5a6478"
        textAnchor="middle"
        letterSpacing="2"
        fontWeight="700"
      >POCKET</text>

      {/* "no input data" overlay */}
      <text
        ref={noTlmRef}
        x={W / 2}
        y={H / 2 + 26}
        fontSize="7"
        fill="#7a8294"
        textAnchor="middle"
        letterSpacing="0.5"
        style={{ display: 'none' }}
      >NO TLM</text>
    </svg>
  )
})

function signed(v) {
  const n = Math.round(v)
  if (n === 0) return '0'
  return n > 0 ? `+${n}` : `${n}`
}

export default RcController
