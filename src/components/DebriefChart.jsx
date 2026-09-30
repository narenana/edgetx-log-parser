/**
 * Debrief evidence chart — a small but complete chart, not a naked
 * polyline: framed plot area, three recessive gridlines with labelled
 * y-ticks (units on the top tick), x-axis end labels in the x-unit,
 * 2px series lines, and per-point native tooltips on bucketed
 * profiles. Supports one or two series; with two, a legend row is
 * always present (dataviz rule) — e.g. the link profile leads with
 * WORST (min) per distance band, since an average hides a momentary
 * dropout inside an otherwise-healthy bucket, with average as muted
 * context. Text wears text tokens; only marks carry the accent.
 *
 * spark = { label, unit, xUnit: 's'|'m',
 *           points: [[x,y],...],                 // single-series form
 *           series?: [{ name, points, muted? }]} // multi-series form
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
  if (xUnit === 'pct') return `${Math.round(v)}%`
  return String(Math.round(v))
}

// 3–6 intermediate ticks on a nice step for the x-unit.
const xTicksFor = (x0, x1, xUnit) => {
  const span = x1 - x0
  const steps = xUnit === 'pct' ? [10, 20, 25, 50]
    : xUnit === 's' ? [15, 30, 60, 120, 300, 600, 1200]
    : [50, 100, 250, 500, 1000, 2000, 5000]
  const step = steps.find(s => span / s <= 6) || steps[steps.length - 1]
  const out = []
  for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) out.push(t)
  return { ticks: out, step }
}

// Status-band tints — reserved status colors with visible labels
// (never color alone).
const BAND_FILL = { good: 'rgba(158,206,106,0.10)', warn: 'rgba(224,175,104,0.12)', crit: 'rgba(247,118,142,0.12)' }
const BAND_INK = { good: '#9ece6a', warn: '#e0af68', crit: '#f7768e' }

export default function DebriefChart({ spark }) {
  if (!spark) return null
  const series = (spark.series && spark.series.length
    ? spark.series
    : [{ name: spark.label, points: spark.points }]
  ).filter(s => s.points && s.points.length >= 2)
  if (!series.length) return null
  const { label, unit, xUnit = 's' } = spark
  const isProfile = xUnit === 'm'
  const primary = series.find(s => !s.muted) || series[0]

  const W = 300, H = 116
  const M = { top: 8, right: 10, bottom: 18, left: 44 }
  const iw = W - M.left - M.right
  const ih = H - M.top - M.bottom

  const allPts = series.flatMap(s => s.points)
  const xs = allPts.map(p => p[0])
  const ys = allPts.map(p => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  let y0 = Math.min(...ys), y1 = Math.max(...ys)
  if (y0 === y1) { y0 -= 1; y1 += 1 }
  const pad = (y1 - y0) * 0.08
  y0 -= pad; y1 += pad

  const sx = x => M.left + ((x - x0) / (x1 - x0)) * iw
  const sy = y => M.top + ih - ((y - y0) / (y1 - y0)) * ih
  const lineOf = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('')

  const yTicks = [y0 + pad, (y0 + y1) / 2, y1 - pad]
  const { ticks: xTicks } = xTicksFor(x0, x1, xUnit)
  // status bands: ordered high→low by 'from'; each spans from its
  // 'from' up to the previous band's floor (clamped to the plot).
  const bands = (spark.bands || [])
    .map((b, i, arr) => {
      const top = i === 0 ? y1 : arr[i - 1].from
      const lo = Math.max(y0, Math.min(b.from === -Infinity ? y0 : b.from, y1))
      const hi = Math.max(y0, Math.min(top, y1))
      return hi > lo ? { ...b, lo, hi } : null
    })
    .filter(Boolean)
  // secondary value at the same x, for richer tooltips on profile dots
  const secondary = series.find(s => s.muted)
  const secAt = x => secondary?.points.find(p => p[0] === x)?.[1]

  return (
    <figure className="db-chart" role="img"
      aria-label={`${label}${unit ? ` in ${unit}` : ''}, from ${fmtX(x0, xUnit)} to ${fmtX(x1, xUnit)}`}>
      <figcaption className="db-chart-title">
        <span className="db-chart-dot" aria-hidden="true" />
        {label}{unit ? <span className="db-chart-unit"> ({unit})</span> : null}
        {series.length > 1 && (
          <span className="db-chart-legend">
            {series.map(s => (
              <span key={s.name} className={`db-chart-key${s.muted ? ' muted' : ''}`}>
                <i aria-hidden="true" />{s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
        {bands.map(b => (
          <g key={b.label}>
            <rect x={M.left} y={sy(b.hi)} width={iw} height={Math.max(0, sy(b.lo) - sy(b.hi))}
              fill={BAND_FILL[b.level]} />
            <text x={W - M.right - 3} y={sy(b.hi) + 8} textAnchor="end"
              className="db-chart-band" fill={BAND_INK[b.level]}>{b.label}</text>
          </g>
        ))}
        {xTicks.map(t => (
          <g key={'x' + t}>
            <line x1={sx(t)} x2={sx(t)} y1={M.top} y2={M.top + ih} className="db-chart-grid" />
            <text x={sx(t)} y={H - 4} textAnchor="middle" className="db-chart-tick">{fmtX(t, xUnit)}</text>
          </g>
        ))}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={M.left} x2={W - M.right} y1={sy(t)} y2={sy(t)} className="db-chart-grid" />
            <text x={M.left - 5} y={sy(t) + 3} textAnchor="end" className="db-chart-tick">
              {i === 2 ? fmtY(t, unit) : fmtY(t, '')}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={W - M.right} y1={M.top + ih} y2={M.top + ih} className="db-chart-axis" />
        {xTicks.length === 0 && (
          <>
            <text x={M.left} y={H - 4} textAnchor="start" className="db-chart-tick">{fmtX(x0, xUnit)}</text>
            <text x={W - M.right} y={H - 4} textAnchor="end" className="db-chart-tick">{fmtX(x1, xUnit)}</text>
          </>
        )}
        {/* muted context series first, primary on top */}
        {[...series].sort((a, b) => (a.muted ? -1 : 1) - (b.muted ? -1 : 1)).map(s => (
          <path key={s.name} d={lineOf(s.points)}
            className={s.muted ? 'db-chart-line muted' : 'db-chart-line'} />
        ))}
        {!primary.muted && series.length === 1 && (
          <path d={`${lineOf(primary.points)}L${sx(x1).toFixed(1)},${(M.top + ih).toFixed(1)}L${sx(primary.points[0][0]).toFixed(1)},${(M.top + ih).toFixed(1)}Z`} className="db-chart-area" />
        )}
        {isProfile
          ? primary.points.map((p, i) => {
              const sec = secAt(p[0])
              return (
                <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r="3" className="db-chart-pt">
                  <title>{`${fmtX(p[0], xUnit)}: worst ${fmtY(p[1], unit)}${sec != null ? `, avg ${fmtY(sec, unit)}` : ''}`}</title>
                </circle>
              )
            })
          : (
              <circle cx={sx(primary.points[primary.points.length - 1][0])}
                cy={sy(primary.points[primary.points.length - 1][1])} r="3" className="db-chart-pt">
                <title>{`${fmtX(x1, xUnit)}: ${fmtY(primary.points[primary.points.length - 1][1], unit)}`}</title>
              </circle>
            )}
      </svg>
      <div className="db-chart-xlabel">
        {xUnit === 'm' ? 'slant distance from launch →' : xUnit === 'pct' ? 'throttle →' : 'flight time →'}
      </div>
    </figure>
  )
}
