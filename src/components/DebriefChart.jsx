/**
 * Debrief evidence chart — a small but complete chart, not a naked
 * polyline: framed plot area, three recessive gridlines with labelled
 * y-ticks (units on the top tick), x-axis end labels in the x-unit,
 * a 2px series line with a soft area fill, and per-point native
 * tooltips on bucketed profiles. Single series → the header names it,
 * no legend box (dataviz rule). Text wears text tokens; only the mark
 * carries the accent.
 *
 * spark = { label, unit, xUnit: 's'|'m', points: [[x, y], ...] }
 */

const fmtY = (v, unit) => {
  const a = Math.abs(v)
  const s = a >= 100 ? Math.round(v).toLocaleString() : a >= 10 ? v.toFixed(1) : v.toFixed(2)
  return unit ? `${s} ${unit}` : s
}
const fmtX = (v, xUnit) => {
  if (xUnit === 's') {
    const m = Math.floor(v / 60)
    return `${m}:${String(Math.round(v % 60)).padStart(2, '0')}`
  }
  if (xUnit === 'm') return v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`
  return String(Math.round(v))
}

export default function DebriefChart({ spark }) {
  if (!spark || !spark.points || spark.points.length < 2) return null
  const { points, label, unit, xUnit = 's' } = spark
  const isProfile = xUnit === 'm'

  const W = 300, H = 116
  const M = { top: 8, right: 10, bottom: 18, left: 44 }
  const iw = W - M.left - M.right
  const ih = H - M.top - M.bottom

  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  let y0 = Math.min(...ys), y1 = Math.max(...ys)
  if (y0 === y1) { y0 -= 1; y1 += 1 }
  const pad = (y1 - y0) * 0.08
  y0 -= pad; y1 += pad

  const sx = x => M.left + ((x - x0) / (x1 - x0)) * iw
  const sy = y => M.top + ih - ((y - y0) / (y1 - y0)) * ih

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('')
  const area = `${line}L${sx(x1).toFixed(1)},${(M.top + ih).toFixed(1)}L${sx(x0).toFixed(1)},${(M.top + ih).toFixed(1)}Z`

  const yTicks = [y0 + pad, (y0 + y1) / 2, y1 - pad]

  return (
    <figure className="db-chart" role="img"
      aria-label={`${label}${unit ? ` in ${unit}` : ''}, from ${fmtX(x0, xUnit)} to ${fmtX(x1, xUnit)}`}>
      <figcaption className="db-chart-title">
        <span className="db-chart-dot" aria-hidden="true" />
        {label}{unit ? <span className="db-chart-unit"> ({unit})</span> : null}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
        {/* gridlines + y tick labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={M.left} x2={W - M.right} y1={sy(t)} y2={sy(t)} className="db-chart-grid" />
            <text x={M.left - 5} y={sy(t) + 3} textAnchor="end" className="db-chart-tick">
              {i === 2 ? fmtY(t, unit) : fmtY(t, '')}
            </text>
          </g>
        ))}
        {/* frame baseline + x end labels */}
        <line x1={M.left} x2={W - M.right} y1={M.top + ih} y2={M.top + ih} className="db-chart-axis" />
        <text x={M.left} y={H - 4} textAnchor="start" className="db-chart-tick">{fmtX(x0, xUnit)}</text>
        <text x={W - M.right} y={H - 4} textAnchor="end" className="db-chart-tick">
          {fmtX(x1, xUnit)}{xUnit === 's' ? ' min' : ''}
        </text>
        {/* series */}
        <path d={area} className="db-chart-area" />
        <path d={line} className="db-chart-line" />
        {isProfile
          ? points.map((p, i) => (
              <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r="3" className="db-chart-pt">
                <title>{`${fmtX(p[0], xUnit)}: ${fmtY(p[1], unit)}`}</title>
              </circle>
            ))
          : (
              <circle cx={sx(points[points.length - 1][0])} cy={sy(points[points.length - 1][1])} r="3" className="db-chart-pt">
                <title>{`${fmtX(x1, xUnit)}: ${fmtY(ys[ys.length - 1], unit)}`}</title>
              </circle>
            )}
      </svg>
      <div className="db-chart-xlabel">
        {isProfile ? 'slant distance from launch →' : 'flight time →'}
      </div>
    </figure>
  )
}
