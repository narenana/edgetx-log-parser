import { forwardRef, useImperativeHandle, useRef } from 'react'

/**
 * Throttle Lever — vertical aircraft-style throttle.
 *
 * Layout (matches a real GA / fighter throttle quadrant):
 *   - Vertical channel cut into a dark bezel.
 *   - T-shaped handle that slides up the channel as throttle increases.
 *   - 0/25/50/75/100% tick marks down the side.
 *   - "MAX" / "IDLE" wording near the extremes — bog-standard cockpit
 *     copy, immediately legible to any pilot.
 *   - Handle goes red over 90% (most fighters mark this region with
 *     "AB" / afterburner, but RC props don't have an afterburner so we
 *     use it as an "approaching peak power" cue).
 *
 * Driven by rcCommand[3] / EdgeTX Thr channel (normalized to 0..100 in
 * the parsers). When the source log lacks throttle telemetry the
 * imperative setter receives null and the handle freezes at idle with
 * a "—" badge — same fallback the BatteryGauge uses.
 *
 * Imperative API:
 *   ref.current.setThrottle(percent)
 */

const W = 50
const H = 110
const TRACK_X = W / 2
const TRACK_TOP = 14
const TRACK_BOT = H - 16
const TRACK_HEIGHT = TRACK_BOT - TRACK_TOP

const HANDLE_COLOR_OK   = '#9ece6a'
const HANDLE_COLOR_HIGH = '#ff9e64'
const HANDLE_COLOR_AB   = '#e85060'

const ThrottleLever = forwardRef(function ThrottleLever(_props, ref) {
  const handleRef = useRef(null)
  const handleFillRef = useRef(null)
  const valueRef = useRef(null)
  const noTlmRef = useRef(null)

  useImperativeHandle(ref, () => ({
    setThrottle(pct) {
      if (!Number.isFinite(pct)) {
        if (handleRef.current) handleRef.current.setAttribute('transform', 'translate(0 0)')
        if (handleFillRef.current) handleFillRef.current.setAttribute('fill', '#444a5a')
        if (valueRef.current) valueRef.current.textContent = '—'
        if (noTlmRef.current) noTlmRef.current.style.display = 'block'
        return
      }
      if (noTlmRef.current) noTlmRef.current.style.display = 'none'
      const clamped = Math.max(0, Math.min(100, pct))
      // y=TRACK_BOT at 0%, y=TRACK_TOP at 100%. Translate from the
      // handle's natural position (TRACK_BOT) by a negative dy as %
      // increases — handle slides UP the channel.
      const dy = -(clamped / 100) * TRACK_HEIGHT
      if (handleRef.current) {
        handleRef.current.setAttribute('transform', `translate(0 ${dy.toFixed(2)})`)
      }
      const color = clamped < 50 ? HANDLE_COLOR_OK
                  : clamped < 90 ? HANDLE_COLOR_HIGH
                  : HANDLE_COLOR_AB
      if (handleFillRef.current) handleFillRef.current.setAttribute('fill', color)
      if (valueRef.current) valueRef.current.textContent = `${clamped.toFixed(0)}%`
    },
  }))

  // Tick marks down the right side of the channel: 0 / 25 / 50 / 75 / 100.
  const ticks = [0, 25, 50, 75, 100].map(pct => {
    const y = TRACK_BOT - (pct / 100) * TRACK_HEIGHT
    return (
      <g key={`t-${pct}`}>
        <line
          x1={TRACK_X + 6} y1={y}
          x2={TRACK_X + 11} y2={y}
          stroke="#cfd8e8" strokeWidth="1.2"
        />
        <text
          x={TRACK_X + 14}
          y={y + 2.6}
          fontSize="6"
          fill="#cfd8e8"
          textAnchor="start"
        >{pct}</text>
      </g>
    )
  })

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="gauge gauge-throttle"
      aria-label="Throttle lever"
    >
      <defs>
        <linearGradient id="thr-bezel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#1a2030" />
          <stop offset="50%" stopColor="#0a0e18" />
          <stop offset="100%" stopColor="#1a2030" />
        </linearGradient>
        {/* Recessed channel — darker than bezel so the slot reads as cut INTO
            the panel. */}
        <linearGradient id="thr-channel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#03060c" />
          <stop offset="50%" stopColor="#0a0e18" />
          <stop offset="100%" stopColor="#03060c" />
        </linearGradient>
      </defs>

      {/* Bezel */}
      <rect x="2" y="2" width={W - 4} height={H - 4} rx="6" fill="url(#thr-bezel)" stroke="#243044" strokeWidth="1" />

      {/* MAX / IDLE end labels */}
      <text x={TRACK_X - 6} y="9" fontSize="6" fill="#7a8294" textAnchor="middle" letterSpacing="0.5">MAX</text>
      <text x={TRACK_X - 6} y={H - 6} fontSize="6" fill="#7a8294" textAnchor="middle" letterSpacing="0.5">IDLE</text>

      {/* Track / channel */}
      <rect
        x={TRACK_X - 5}
        y={TRACK_TOP - 3}
        width="10"
        height={TRACK_HEIGHT + 6}
        rx="3"
        fill="url(#thr-channel)"
        stroke="#000"
        strokeWidth="0.5"
      />

      {/* "Filled" portion of the track behind the handle — visualizes the
          % value with a coloured bar under the handle. */}
      <clipPath id="thr-fill-clip">
        <rect x={TRACK_X - 4} y={TRACK_TOP - 2} width="8" height={TRACK_HEIGHT + 4} rx="2" />
      </clipPath>
      <g ref={handleFillRef => null} clipPath="url(#thr-fill-clip)">
        {/* Handled by handle group below — see note */}
      </g>

      {ticks}

      {/* Handle group: starts at IDLE (TRACK_BOT), translated up by setThrottle.
          T-shape gives the "throttle has a wide grip" look. */}
      <g ref={handleRef} transform="translate(0 0)">
        {/* Vertical post (the lever's stem) */}
        <rect
          x={TRACK_X - 1.5}
          y={TRACK_BOT - 8}
          width="3"
          height="10"
          fill="#5a6478"
          stroke="#000"
          strokeWidth="0.5"
        />
        {/* T-grip — wider horizontal bar at the top. Color shifts with throttle. */}
        <rect
          ref={handleFillRef}
          x={TRACK_X - 12}
          y={TRACK_BOT - 12}
          width="24"
          height="6"
          rx="2"
          fill={HANDLE_COLOR_OK}
          stroke="#000"
          strokeWidth="0.7"
        />
        {/* Highlight stripe across the top of the grip — gives the metal-
            with-rubber-grip look. */}
        <rect
          x={TRACK_X - 11}
          y={TRACK_BOT - 11}
          width="22"
          height="1.5"
          fill="rgba(255,255,255,0.25)"
        />
      </g>

      {/* Digital readout below — small, % format. */}
      <text
        ref={valueRef}
        x={TRACK_X}
        y={H - 17}
        fontSize="9"
        fill="#e8eef8"
        textAnchor="middle"
        fontWeight="600"
        fontFamily="Consolas, monospace"
      >0%</text>

      {/* "no telemetry" overlay — hidden by default, shown via setThrottle(null). */}
      <text
        ref={noTlmRef}
        x={TRACK_X}
        y={H / 2}
        fontSize="6.5"
        fill="#7a8294"
        textAnchor="middle"
        letterSpacing="0.5"
        style={{ display: 'none' }}
      >NO TLM</text>
    </svg>
  )
})

export default ThrottleLever
