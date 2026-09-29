/**
 * Sparse-GPS path reconstruction for radio (EdgeTX) logs.
 *
 * ELRS/Crossfire telemetry delivers GPS positions far slower than the
 * radio writes rows — real logs show a fresh fix only every ~9 s while
 * rows tick at 0.5 s, i.e. ~18 duplicate positions per fix. A spline
 * through duplicated control points degenerates into straight chords
 * with pointed corners (a circling wing gets aliased into zigzag), and
 * that is exactly what the 3D path looked like for these logs.
 *
 * The rescue is that the radio logs HEADING and SPEED 18× more often
 * than position: at each fix we know which way the aircraft was
 * pointing and how fast it moved, so a cubic Hermite through the
 * distinct fixes — with tangents built from Hdg(°)/GSpd(kmh)/VSpd(m/s)
 * — reconstructs plausible curves (circles come back as loops, not
 * stars). Where telemetry is missing, tangents fall back to central
 * differences in time (Catmull-Rom). Fix gaps beyond GAP_CHORD_S give
 * up on curvature and ease along the chord — no invented geometry.
 *
 * Blackbox logs never enter this path: their mapper already
 * interpolates positions per row, so cadence analysis reports them
 * dense and the classic pipeline renders them unchanged.
 *
 * Pure geodetic math (lon/lat degrees + altitude metres) — no Cesium
 * types — so the whole thing unit-tests in node.
 */

const M_PER_DEG_LAT = 111320
const D2R = Math.PI / 180

// A log is "sparse" when distinct fixes arrive slower than this. Dense
// logs (blackbox ~1 row cadence, EdgeTX with 1 Hz GPS at 1 s rows)
// keep the existing render pipeline byte-identical.
export const SPARSE_FIX_DT_S = 2
// Beyond this gap between fixes we draw an eased chord instead of a
// curve — inventing 20 s of flight path would be fiction.
export const GAP_CHORD_S = 15

/** Cadence analysis over the GPS-bearing rows. */
export function analyzeGpsCadence(gpsRows) {
  if (!gpsRows || gpsRows.length < 3) {
    return { sparse: false, medianFixDt: 0, distinctCount: gpsRows?.length ?? 0 }
  }
  const dts = []
  let distinct = 1
  let prev = gpsRows[0]
  for (let i = 1; i < gpsRows.length; i++) {
    const r = gpsRows[i]
    if (r._lat !== prev._lat || r._lon !== prev._lon) {
      dts.push(r._tSec - prev._tSec)
      distinct++
      prev = r
    }
  }
  if (!dts.length) return { sparse: false, medianFixDt: 0, distinctCount: distinct }
  dts.sort((a, b) => a - b)
  const medianFixDt = dts[Math.floor(dts.length / 2)]
  return { sparse: medianFixDt > SPARSE_FIX_DT_S, medianFixDt, distinctCount: distinct }
}

/**
 * Collapse duplicate-position runs to their FIRST row (the moment the
 * fix arrived). The final row is appended even when its position
 * repeats, so the path's time domain still spans the whole flight and
 * cursor→pathRow binary search stays valid to the last second.
 */
export function dedupeFixes(gpsRows) {
  if (!gpsRows.length) return []
  const out = [gpsRows[0]]
  for (let i = 1; i < gpsRows.length; i++) {
    const r = gpsRows[i]
    const last = out[out.length - 1]
    if (r._lat !== last._lat || r._lon !== last._lon) out.push(r)
  }
  const tail = gpsRows[gpsRows.length - 1]
  if (out[out.length - 1] !== tail) out.push(tail)
  return out
}

// Velocity tangent (deg/s for lon/lat, m/s for alt) at a fix row.
// Prefers logged heading+speed; falls back to a central difference.
function tangentAt(rows, i, altAt) {
  const r = rows[i]
  const hdg = r['Hdg(°)']
  const spd = r['GSpd(kmh)']
  if (typeof hdg === 'number' && !isNaN(hdg) && typeof spd === 'number' && !isNaN(spd) && spd >= 0) {
    const v = spd / 3.6 // m/s
    const th = hdg * D2R
    const vz = typeof r['VSpd(m/s)'] === 'number' && !isNaN(r['VSpd(m/s)']) ? r['VSpd(m/s)'] : centralAltRate(rows, i, altAt)
    return {
      lon: (v * Math.sin(th)) / (M_PER_DEG_LAT * Math.cos(r._lat * D2R)),
      lat: (v * Math.cos(th)) / M_PER_DEG_LAT,
      alt: vz,
    }
  }
  // Central difference in time (classic Catmull-Rom tangent).
  const a = rows[Math.max(0, i - 1)]
  const b = rows[Math.min(rows.length - 1, i + 1)]
  const dt = Math.max(1e-6, b._tSec - a._tSec)
  return {
    lon: (b._lon - a._lon) / dt,
    lat: (b._lat - a._lat) / dt,
    alt: (altAt(b) - altAt(a)) / dt,
  }
}

function centralAltRate(rows, i, altAt) {
  const a = rows[Math.max(0, i - 1)]
  const b = rows[Math.min(rows.length - 1, i + 1)]
  const dt = Math.max(1e-6, b._tSec - a._tSec)
  return (altAt(b) - altAt(a)) / dt
}

/**
 * Cubic Hermite through the distinct fixes, `steps` samples per
 * segment. Output length = (fixRows.length - 1) * steps + 1 — the SAME
 * invariant catmullRomSmooth keeps, so every downstream index mapping
 * (FM colours, cursor split, aircraft pose) works unchanged.
 *
 * altAt(row) supplies the absolute altitude (the caller's absAlt
 * closure — includes the launch-terrain offset and is re-invoked on
 * terrain resolve via rebuildPathPositions).
 */
export function hermitePathGeodetic(fixRows, steps, altAt) {
  const n = fixRows.length
  if (n === 0) return []
  if (n === 1) {
    const r = fixRows[0]
    return [{ lon: r._lon, lat: r._lat, alt: altAt(r) }]
  }
  const tangents = fixRows.map((_, i) => tangentAt(fixRows, i, altAt))
  const out = []
  for (let i = 0; i < n - 1; i++) {
    const a = fixRows[i]
    const b = fixRows[i + 1]
    const dt = Math.max(1e-6, b._tSec - a._tSec)
    // Chord length in metres — the yardstick for tangent sanity.
    const chordM = Math.hypot(
      (b._lat - a._lat) * M_PER_DEG_LAT,
      (b._lon - a._lon) * M_PER_DEG_LAT * Math.cos(a._lat * D2R),
    )
    // Long gap (telemetry hole): ease along the chord, invent nothing.
    // Zero-length chord (position held, e.g. the appended tail row, or
    // a hover): stationary — live tangents here would fabricate a
    // phantom loop out of thin air.
    const gap = dt > GAP_CHORD_S || chordM < 1
    let ta = gap ? { lon: 0, lat: 0, alt: 0 } : tangents[i]
    let tb = gap ? { lon: 0, lat: 0, alt: 0 } : tangents[i + 1]
    if (!gap) {
      // Cap tangent influence at 2× the chord — real radio logs carry
      // stale GSpd/Hdg around landings (observed frozen at 63.8 km/h
      // at 0 AGL), and an oversized tangent overshoots into loops.
      const cap = t => {
        const magM = Math.hypot(t.lat * M_PER_DEG_LAT, t.lon * M_PER_DEG_LAT * Math.cos(a._lat * D2R)) * dt
        if (magM <= 2 * chordM || magM === 0) return t
        const s = (2 * chordM) / magM
        return { lon: t.lon * s, lat: t.lat * s, alt: t.alt * s }
      }
      ta = cap(ta)
      tb = cap(tb)
    }
    const pa = { lon: a._lon, lat: a._lat, alt: altAt(a) }
    const pb = { lon: b._lon, lat: b._lat, alt: altAt(b) }
    for (let j = 0; j < steps; j++) {
      const u = j / steps
      const u2 = u * u
      const u3 = u2 * u
      const h00 = 2 * u3 - 3 * u2 + 1
      const h10 = u3 - 2 * u2 + u
      const h01 = -2 * u3 + 3 * u2
      const h11 = u3 - u2
      out.push({
        lon: h00 * pa.lon + h10 * dt * ta.lon + h01 * pb.lon + h11 * dt * tb.lon,
        lat: h00 * pa.lat + h10 * dt * ta.lat + h01 * pb.lat + h11 * dt * tb.lat,
        alt: h00 * pa.alt + h10 * dt * ta.alt + h01 * pb.alt + h11 * dt * tb.alt,
      })
    }
  }
  const last = fixRows[n - 1]
  out.push({ lon: last._lon, lat: last._lat, alt: altAt(last) })
  return out
}
