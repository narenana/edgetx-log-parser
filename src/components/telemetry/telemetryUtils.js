/**
 * Pure helpers for the READOUT/72 telemetry bar.
 *
 * Framework-free (like gaugeUtils.js) so unit tests and a future
 * video-export pipeline can call the same code outside React.
 *
 * The history helpers implement FLIGHT-TIME lookback (redesign plan
 * amendment B): sparklines and stick trails sample the parsed rows in a
 * time window ending at the cursor's _tSec — NOT a frame-fed ring buffer.
 * A frame-fed buffer records wall-clock playback (at 60x speed a "30s"
 * sparkline would span 30 minutes of log; after a scrub it would contain
 * the scrub trajectory). Sampling log time makes trails/sparklines
 * correct at every speed, after every scrub, and while paused.
 */

/**
 * Binary-search the row index whose _tSec is closest at-or-before tSec.
 * Rows are sorted ascending by _tSec (both parsers guarantee this).
 */
export function rowIndexAtTime(rows, tSec) {
  let lo = 0
  let hi = rows.length - 1
  if (hi < 0) return -1
  if (tSec <= rows[0]._tSec) return 0
  if (tSec >= rows[hi]._tSec) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (rows[mid]._tSec <= tSec) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Sample `getter(row)` at n+1 evenly spaced flight-time points across
 * [tEnd - windowS, tEnd]. Times before the log start clamp to the first
 * row. Returns an array of numbers (NaN where the field is absent) —
 * callers decide how to render gaps.
 */
export function sampleWindow(rows, tEnd, windowS, n, getter) {
  const out = new Array(n + 1)
  for (let i = 0; i <= n; i++) {
    const t = tEnd - windowS + (windowS * i) / n
    const idx = rowIndexAtTime(rows, t)
    const v = idx >= 0 ? getter(rows[idx]) : NaN
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : NaN
  }
  return out
}

/**
 * Build an SVG polyline `points` string from sampled values, auto-scaled
 * to [min,max] of the finite samples. Gaps (NaN) break the line by
 * emitting nothing (SVG polyline can't gap, so callers wanting gaps
 * should split — for 15px sparklines a straight bridge is acceptable,
 * we simply skip NaN points).
 */
export function sparkPoints(values, w, h, pad = 2) {
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (Number.isNaN(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) return { points: '', min: 0, max: 0 }
  const span = max - min || 1
  const n = values.length - 1
  const pts = []
  for (let i = 0; i <= n; i++) {
    const v = values[i]
    if (Number.isNaN(v)) continue
    const x = (w * i) / n
    const y = h - pad - (h - 2 * pad) * ((v - min) / span)
    pts.push(x.toFixed(1) + ',' + y.toFixed(1))
  }
  return { points: pts.join(' '), min, max }
}

/** Great-circle distance in meters (haversine, good enough at RC ranges). */
export function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const d2r = Math.PI / 180
  const dLat = (lat2 - lat1) * d2r
  const dLon = (lon2 - lon1) * d2r
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Initial bearing (compass deg) from point 1 to point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const d2r = Math.PI / 180
  const φ1 = lat1 * d2r
  const φ2 = lat2 * d2r
  const dλ = (lon2 - lon1) * d2r
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) / d2r + 360) % 360
}

/* ── Stick normalization — ported VERBATIM in behavior from
 *    RcController.jsx (the sign conventions are battle-tested):
 *
 *  LEFT stick  — Y = throttle (0..100; up = full, 50 = centre)
 *                X = yaw      (-100..+100)
 *  RIGHT stick — Y = pitch    (-100..+100; +ve = stick pushed FORWARD =
 *                              nose-down command — iNAV rcCommand[1] and
 *                              EdgeTX Ele both use this convention, so
 *                              the displayed stick moves AWAY from the
 *                              pilot for positive values)
 *                X = roll     (-100..+100; +ve = right)
 *
 *  SVG +Y is DOWN on screen, so both "up" directions negate.
 * ────────────────────────────────────────────────────────────────── */

/**
 * Convert raw channel values into dot offsets in [-1, 1] box space.
 * Returns null when NO channel is finite (no stick data at this row).
 */
export function stickOffsets({ throttle, yaw, pitch, roll }) {
  const tOk = Number.isFinite(throttle)
  const yOk = Number.isFinite(yaw)
  const pOk = Number.isFinite(pitch)
  const rOk = Number.isFinite(roll)
  if (!tOk && !yOk && !pOk && !rOk) return null
  const thr = tOk ? Math.max(0, Math.min(100, throttle)) : 50
  const yawV = yOk ? Math.max(-100, Math.min(100, yaw)) : 0
  const pitchV = pOk ? Math.max(-100, Math.min(100, pitch)) : 0
  const rollV = rOk ? Math.max(-100, Math.min(100, roll)) : 0
  return {
    // left box: x = yaw, y = throttle (up = +thr → negative dy)
    lx: yawV / 100,
    ly: -((thr - 50) / 50),
    // right box: x = roll, y = pitch (forward/+ve = up on screen → negative dy)
    rx: rollV / 100,
    ry: -(pitchV / 100),
    thr,
    yawV,
    pitchV,
    rollV,
    hasThr: tOk,
  }
}
