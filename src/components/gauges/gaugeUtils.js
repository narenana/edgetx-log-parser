/**
 * Shared helpers for the SVG cockpit gauges.
 *
 * - Geometry helpers (arc paths, tick mark generators)
 * - Cell-count detection from peak battery voltage
 * - Safe value clamps for the imperative needle setters
 *
 * Kept framework-free (pure functions) so tests can exercise them and so
 * a future video-export pipeline can call the same code from a non-React
 * worker if we ever need to.
 */

/**
 * Polar to cartesian, with 0° = up, increasing CW (the convention every
 * cockpit gauge uses; differs from canonical math which has 0° = right).
 *
 * @param cx,cy   centre of the circle
 * @param r       radius
 * @param degCW   angle in degrees, 0 = up, +CW
 */
export function polar(cx, cy, r, degCW) {
  const rad = ((degCW - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

/**
 * Build an SVG arc path between two angles (degCW, 0 = up).
 * Used for the green/yellow/red arcs on airspeed and battery dials.
 */
export function arcPath(cx, cy, r, fromDeg, toDeg) {
  const a = polar(cx, cy, r, fromDeg)
  const b = polar(cx, cy, r, toDeg)
  // arcs in cockpit gauges are always < 360°, so large-arc-flag is 0 unless
  // the swept angle exceeds 180°.
  const sweep = ((toDeg - fromDeg + 360) % 360) > 180 ? 1 : 0
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${sweep} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
}

/**
 * Detect lipo cell count from the highest voltage seen across the log.
 * RC packs are integer multiples of 4.20 V (full charge). Round to the
 * nearest integer of (max / 4.20). Floor at 1 so a degenerate log
 * doesn't return 0 cells.
 *
 * Returns { cells, full, nominal, low, critical } in volts so each gauge
 * can scale its arcs without re-deriving the constants.
 */
export function detectBatteryConfig(rows) {
  let maxV = 0
  for (const r of rows) {
    const v = r['RxBt(V)']
    if (typeof v === 'number' && v > maxV) maxV = v
  }
  // 4.05 instead of 4.20 — packs are rarely seen at peak (you stop charging
  // before pulling the connector). 4.05 gives the right cell count for
  // packs anywhere from 4.0 to 4.2 V/cell at log start.
  const cells = Math.max(1, Math.round(maxV / 4.05))
  return {
    cells,
    full:     cells * 4.20,
    nominal:  cells * 3.70,
    low:      cells * 3.50,
    critical: cells * 3.30,
    detected: maxV > 0,
  }
}

/**
 * Linear map x from [a0,a1] → [b0,b1], clamped to [b0,b1].
 * Used in needle-angle calculations.
 */
export function mapClamp(x, a0, a1, b0, b1) {
  if (a1 === a0) return b0
  const t = (x - a0) / (a1 - a0)
  if (!Number.isFinite(t)) return b0
  if (t <= 0) return b0
  if (t >= 1) return b1
  return b0 + t * (b1 - b0)
}

/**
 * Round-to-nearest-N helper for chunky tick generation.
 * Used when the airspeed gauge picks its own scale based on log max.
 */
export function roundUpTo(x, step) {
  return Math.ceil(x / step) * step
}

/**
 * Pick a "nice" round max for an autoscaled dial. Returns the smallest
 * value in [50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, ...]
 * that exceeds `value`. Used for airspeed + altimeter scale picking so
 * the dial shows whole-number marks regardless of the flight's profile.
 */
export function niceRoundMax(value) {
  if (value <= 0 || !Number.isFinite(value)) return 100
  const steps = [50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000,
                 1500, 2000, 2500, 3000, 4000, 5000]
  for (const s of steps) if (s >= value) return s
  // Beyond 5000 just round up to nearest 1000.
  return Math.ceil(value / 1000) * 1000
}

/**
 * Shortest-arc angle delta in degrees, signed.
 *  delta(350, 10)   = 20
 *  delta(10, 350)   = -20
 * Used to lerp compass-card rotations without crossing the wrong way.
 */
export function angleDelta(from, to) {
  return ((to - from + 540) % 360) - 180
}
