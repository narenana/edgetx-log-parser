import { forwardRef, useImperativeHandle, useRef } from 'react'
import { polar, angleDelta } from './gaugeUtils'

/**
 * Heading Indicator (Directional Gyro / HSI compass card).
 *
 * In a real aircraft the compass card rotates so the current heading
 * appears under a fixed lubber line at the top — pilot looks at the
 * top of the card to read where the nose is pointing. We do the same:
 *
 *   - Card (the rotating ring with N/E/S/W cardinal letters and tick
 *     marks every 10°) rotates by -heading.
 *   - Lubber line (orange triangle at top, fixed) marks current heading.
 *   - Aircraft icon in centre (fixed) — visual reference for the pilot.
 *
 * Smoothing: rotation is set imperatively each frame to the latest
 * heading. We DON'T do any EMA in here — interpRows + the upstream
 * smoothing already produce a stable Hdg(°). Adding more smoothing in
 * the gauge would make the compass lag the aircraft by visible amounts.
 */

const SIZE = 90
const R = SIZE / 2 - 2

const HeadingIndicator = forwardRef(function HeadingIndicator(_props, ref) {
  const cardRef = useRef(null)
  const valueRef = useRef(null)
  const lastHdgRef = useRef(0)

  useImperativeHandle(ref, () => ({
    setHeading(deg) {
      const h = Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : 0
      // Use shortest-arc delta so the card always takes the short way
      // around (no spurious 350° spins on a 10° → 350° transition during
      // a bookmark scrub).
      const delta = angleDelta(lastHdgRef.current, h)
      lastHdgRef.current = lastHdgRef.current + delta
      // Card rotates -heading so heading=90° puts E under the lubber line.
      if (cardRef.current) {
        cardRef.current.setAttribute(
          'transform',
          `rotate(${(-lastHdgRef.current).toFixed(2)} ${SIZE / 2} ${SIZE / 2})`,
        )
      }
      if (valueRef.current) {
        valueRef.current.textContent = h.toFixed(0).padStart(3, '0') + '°'
      }
    },
  }))

  const cx = SIZE / 2
  const cy = SIZE / 2

  // Build the rotating card: 36 ticks (every 10°), labelled at cardinals.
  const cardElements = []
  for (let deg = 0; deg < 360; deg += 10) {
    const isCardinal = deg % 90 === 0          // N E S W
    const isMajor = deg % 30 === 0             // every 30°
    const inner = polar(cx, cy, R - (isCardinal ? 12 : isMajor ? 10 : 7), deg)
    const outer = polar(cx, cy, R - 2, deg)
    cardElements.push(
      <line
        key={`t-${deg}`}
        x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
        stroke={isCardinal ? '#ff9e64' : isMajor ? '#e8eef8' : '#7a8294'}
        strokeWidth={isCardinal ? 1.4 : isMajor ? 1.2 : 0.8}
      />,
    )
  }

  // Cardinal letters at N/E/S/W.
  const cardinals = [
    { deg: 0,   label: 'N', color: '#ff9e64' },
    { deg: 90,  label: 'E', color: '#e8eef8' },
    { deg: 180, label: 'S', color: '#e8eef8' },
    { deg: 270, label: 'W', color: '#e8eef8' },
  ]
  const cardinalElements = cardinals.map(({ deg, label, color }) => {
    const p = polar(cx, cy, R - 19, deg)
    return (
      <text
        key={`c-${deg}`}
        x={p.x}
        y={p.y + 3.3}
        fontSize="10"
        fill={color}
        textAnchor="middle"
        fontWeight="700"
      >{label}</text>
    )
  })

  // Numeric labels at 30/60/120/150/210/240/300/330 (the "between" cardinals)
  // shown as just the tens digit (3, 6, 12 etc) — saves space.
  const intercardinals = [30, 60, 120, 150, 210, 240, 300, 330]
  const intercardinalElements = intercardinals.map(deg => {
    const p = polar(cx, cy, R - 17, deg)
    return (
      <text
        key={`ic-${deg}`}
        x={p.x}
        y={p.y + 2.6}
        fontSize="6.5"
        fill="#cfd8e8"
        textAnchor="middle"
      >{deg / 10}</text>
    )
  })

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="gauge gauge-heading"
      aria-label="Heading indicator"
    >
      <defs>
        <radialGradient id="hi-bezel" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#3a4760" />
          <stop offset="60%" stopColor="#1a2030" />
          <stop offset="100%" stopColor="#0a0e18" />
        </radialGradient>
      </defs>

      <circle cx={cx} cy={cy} r={R} fill="url(#hi-bezel)" stroke="#000" strokeWidth="1" />

      {/* Rotating card */}
      <g ref={cardRef} transform={`rotate(0 ${cx} ${cy})`}>
        {cardElements}
        {cardinalElements}
        {intercardinalElements}
      </g>

      {/* Lubber line — orange triangle at the top + small mark. Fixed. */}
      <polygon
        points={`${cx},${cy - R + 4} ${cx - 4},${cy - R + 12} ${cx + 4},${cy - R + 12}`}
        fill="#ff9e64"
        stroke="#000"
        strokeWidth="0.4"
      />

      {/* Aircraft icon — small plane shape pointing up, fixed in centre.
          Just the silhouette outline so it doesn't fight the card. */}
      <g stroke="#ff9e64" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <line x1={cx} y1={cy - 11} x2={cx} y2={cy + 9} />
        <line x1={cx - 11} y1={cy + 1} x2={cx + 11} y2={cy + 1} />
        <line x1={cx - 5} y1={cy + 8} x2={cx + 5} y2={cy + 8} />
      </g>

      {/* Digital heading readout below */}
      <text
        ref={valueRef}
        x={cx}
        y={cy + 24}
        fontSize="9"
        fill="#e8eef8"
        textAnchor="middle"
        fontWeight="600"
        fontFamily="Consolas, monospace"
      >000°</text>

      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#243044" strokeWidth="2" />
    </svg>
  )
})

export default HeadingIndicator
