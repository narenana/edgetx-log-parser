import { describe, it, expect } from 'vitest'
import { analyzeGpsCadence, dedupeFixes, hermitePathGeodetic, GAP_CHORD_S } from './pathSmoothing.js'

const M_PER_DEG = 111320

/**
 * Synthetic circling wing: radius R at speed v, sampled the way an ELRS
 * radio log samples it — rows every 0.5 s, a fresh GPS fix only every
 * fixDt seconds (position REPEATS between fixes), heading/speed logged
 * on every row. Centred near the equator so deg↔m stays simple.
 */
function circlingLog({ R = 150, periodS = 30, fixDt = 9, durS = 60 }) {
  const v = (2 * Math.PI * R) / periodS
  const rows = []
  let lastFixT = -Infinity
  let fix = null
  for (let t = 0; t <= durS; t += 0.5) {
    const ang = (2 * Math.PI * t) / periodS
    if (t - lastFixT >= fixDt || fix == null) {
      fix = {
        lat: (R * Math.sin(ang)) / M_PER_DEG,
        lon: (R * Math.cos(ang)) / M_PER_DEG,
      }
      lastFixT = t
    }
    rows.push({
      _tSec: t,
      _lat: fix.lat,
      _lon: fix.lon,
      // heading = tangent of the circle (perpendicular to radius),
      // 0° = north, clockwise-positive like a compass.
      'Hdg(°)': (((Math.atan2(-Math.sin(ang), Math.cos(ang)) / Math.PI) * 180) + 360) % 360,
      'GSpd(kmh)': v * 3.6,
      'VSpd(m/s)': 0,
      'Alt(m)': 100,
    })
  }
  return rows
}

const altAt = r => r['Alt(m)'] ?? 0
const distToCentreM = p => Math.hypot(p.lat * M_PER_DEG, p.lon * M_PER_DEG)

describe('analyzeGpsCadence', () => {
  it('flags the radio-log profile as sparse', () => {
    const rows = circlingLog({})
    const c = analyzeGpsCadence(rows)
    expect(c.sparse).toBe(true)
    expect(c.medianFixDt).toBeGreaterThan(8)
  })
  it('dense per-row GPS (blackbox-mapped) is NOT sparse — classic pipeline untouched', () => {
    const rows = []
    for (let t = 0; t <= 60; t += 0.5) rows.push({ _tSec: t, _lat: t * 1e-5, _lon: 0 })
    expect(analyzeGpsCadence(rows).sparse).toBe(false)
  })
  it('1 Hz GPS at 1 s rows (classic EdgeTX + GPS) is NOT sparse', () => {
    const rows = []
    for (let t = 0; t <= 60; t += 1) rows.push({ _tSec: t, _lat: t * 1e-5, _lon: 0 })
    expect(analyzeGpsCadence(rows).sparse).toBe(false)
  })
})

describe('dedupeFixes', () => {
  it('collapses duplicate runs to the fix-arrival row and keeps the tail', () => {
    const rows = circlingLog({ durS: 30 })
    const fixes = dedupeFixes(rows)
    for (let i = 1; i < fixes.length - 1; i++) {
      expect(fixes[i]._lat !== fixes[i - 1]._lat || fixes[i]._lon !== fixes[i - 1]._lon).toBe(true)
    }
    expect(fixes[fixes.length - 1]._tSec).toBe(rows[rows.length - 1]._tSec)
  })
})

describe('hermitePathGeodetic', () => {
  it('keeps the (n-1)*steps+1 length invariant the renderer depends on', () => {
    const fixes = dedupeFixes(circlingLog({}))
    const path = hermitePathGeodetic(fixes, 24, altAt)
    expect(path.length).toBe((fixes.length - 1) * 24 + 1)
  })

  it('reconstructs a circle from 9 s fixes: ≥4× closer to the truth than chords', () => {
    const R = 150
    const fixes = dedupeFixes(circlingLog({ R }))
    const path = hermitePathGeodetic(fixes, 24, altAt)
    let maxHermiteErr = 0
    for (const p of path) maxHermiteErr = Math.max(maxHermiteErr, Math.abs(distToCentreM(p) - R))
    // Chord baseline: linear interpolation between the same fixes.
    let maxChordErr = 0
    for (let i = 0; i < fixes.length - 1; i++) {
      for (let j = 0; j <= 24; j++) {
        const u = j / 24
        const p = {
          lat: fixes[i]._lat + (fixes[i + 1]._lat - fixes[i]._lat) * u,
          lon: fixes[i]._lon + (fixes[i + 1]._lon - fixes[i]._lon) * u,
        }
        maxChordErr = Math.max(maxChordErr, Math.abs(distToCentreM(p) - R))
      }
    }
    expect(maxChordErr).toBeGreaterThan(40)         // the star-shape error we're killing
    expect(maxHermiteErr).toBeLessThan(maxChordErr / 4)
    expect(maxHermiteErr).toBeLessThan(15)
  })

  it('falls back to central-difference tangents when Hdg/GSpd are absent', () => {
    const fixes = dedupeFixes(circlingLog({})).map(r => {
      const { 'Hdg(°)': _h, 'GSpd(kmh)': _s, ...rest } = r
      return rest
    })
    const path = hermitePathGeodetic(fixes, 24, altAt)
    let maxErr = 0
    for (const p of path) maxErr = Math.max(maxErr, Math.abs(distToCentreM(p) - 150))
    // Catmull-Rom fallback on 108° arcs is only modestly better than
    // chords (~20%) — the telemetry-tangent path is the real fix; this
    // just asserts the fallback never makes things WORSE.
    expect(maxErr).toBeLessThan(55)
  })

  it('gaps beyond GAP_CHORD_S ease along the chord — no invented curvature', () => {
    const fixes = [
      { _tSec: 0, _lat: 0, _lon: 0, 'Hdg(°)': 90, 'GSpd(kmh)': 100, 'Alt(m)': 50 },
      { _tSec: GAP_CHORD_S + 5, _lat: 0, _lon: 0.01, 'Hdg(°)': 270, 'GSpd(kmh)': 100, 'Alt(m)': 50 },
    ]
    const path = hermitePathGeodetic(fixes, 16, altAt)
    // Every sample sits ON the straight lat=0 chord despite tangents
    // that would otherwise bow it into an S.
    for (const p of path) expect(Math.abs(p.lat)).toBeLessThan(1e-12)
  })

  it('altitude follows the fix altitudes through the launch-offset closure', () => {
    const fixes = [
      { _tSec: 0, _lat: 0, _lon: 0, 'Alt(m)': 0 },
      { _tSec: 5, _lat: 0.001, _lon: 0, 'Alt(m)': 100 },
    ]
    const path = hermitePathGeodetic(fixes, 8, r => 700 + r['Alt(m)'])
    expect(path[0].alt).toBe(700)
    expect(path[path.length - 1].alt).toBe(800)
  })
})
