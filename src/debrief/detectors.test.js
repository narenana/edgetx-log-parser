import { describe, it, expect } from 'vitest'
import { runDebrief, parseFirmware, scanLogTail } from './index.js'
import { detectChemistry } from './detectors.js'

/**
 * Synthetic fixtures per docs/FLIGHT-DEBRIEF-TESTPLAN.md §2. Every
 * fixture is generated full-rate then DECIMATED with production-style
 * stride so detectors are exercised on the data shape they actually
 * see (the stride-invariance rule). Coordinates, when present, are
 * synthetic (0-island-adjacent), never real.
 */

// Build rows at a given cadence from channel generator functions of t.
function mkRows(durationS, cadenceS, gen = {}) {
  const rows = []
  let i = 0
  for (let t = 0; t <= durationS + 1e-9; t += cadenceS) {
    const r = { _i: i, _tSec: t, _lat: null, _lon: null }
    for (const [key, fn] of Object.entries(gen)) r[key] = fn(t)
    rows.push(r)
    i++
  }
  return rows
}

function mkStats(rows) {
  const alt = rows.map(r => r['Alt(m)']).filter(v => v != null)
  const volt = rows.map(r => r['RxBt(V)']).filter(v => v > 0)
  return {
    duration: rows.length ? rows[rows.length - 1]._tSec : 0,
    maxAlt: alt.length ? Math.max(...alt) : 0,
    minAlt: alt.length ? Math.min(...alt) : 0,
    maxSpeed: 0, maxClimb: 0, maxSink: 0,
    distanceKm: 0, maxDistFromHomeKm: 0,
    minVoltage: volt.length ? Math.min(...volt) : null,
    maxCapacity: null, maxCurrent: 0, minRSSI: null,
    dominantMode: null, dominantPct: 0,
  }
}

// Slow-frame block: values = {name: fn(t)}, rate in Hz.
function mkSlow(durationS, rateHz, values) {
  const names = Object.keys(values)
  const n = Math.floor(durationS * rateHz) + 1
  const times = new Float64Array(n)
  const frames = new Float64Array(n * names.length)
  for (let i = 0; i < n; i++) {
    const t = i / rateHz
    times[i] = t * 1e6
    names.forEach((name, j) => { frames[i * names.length + j] = values[name](t) })
  }
  return { names, times, frames, cols: names.length, n, t0Us: 0 }
}

const META = { endMarker: null, droppedMain: 0, droppedGps: 0, padBytes: null, firmwareFamily: 'INAV', firmwareVersion: '9.0.0', target: 'SPEEDYBEEF405WING', cadenceS: 0.5 }

function run(over = {}) {
  const rows = over.rows || mkRows(120, 0.5, { 'Alt(m)': t => (t < 110 ? 50 : 2), 'RxBt(V)': () => 16.4 })
  return runDebrief({
    source: over.source || 'blackbox',
    rows,
    stats: over.stats || mkStats(rows),
    events: [],
    slow: over.slow ?? null,
    main: over.main ?? null,
    meta: { ...META, ...(over.meta || {}) },
    ...(over.chem ? { chem: over.chem } : {}),
  })
}

const find = (d, id) => d.findings.find(f => f.id === id)

// ── chemistry ──────────────────────────────────────────────────────────
describe('chemistry detection', () => {
  it('4S LiPo off the charger', () => {
    const rows = mkRows(30, 0.5, { 'RxBt(V)': () => 16.72 })
    expect(detectChemistry(rows)).toMatchObject({ cells: 4, chemistry: 'lipo' })
  })
  it('4S Li-ion full charge', () => {
    const rows = mkRows(30, 0.5, { 'RxBt(V)': () => 16.3 })
    expect(detectChemistry(rows)).toMatchObject({ cells: 4, chemistry: 'liion' })
  })
  it('6S LiPo', () => {
    const rows = mkRows(30, 0.5, { 'RxBt(V)': () => 25.1 })
    expect(detectChemistry(rows)).toMatchObject({ cells: 6, chemistry: 'lipo' })
  })
  it('no voltage → nulls, nothing throws', () => {
    const rows = mkRows(30, 0.5, {})
    expect(detectChemistry(rows)).toMatchObject({ cells: null, chemistry: null })
  })
})

// ── E1 ────────────────────────────────────────────────────────────────
describe('E1 unterminated log', () => {
  it('fires on missing end marker', () => {
    const d = run({ meta: { endMarker: false } })
    expect(find(d, 'E1')).toBeTruthy()
  })
  it('fires on dropped tail frames even with marker unknown', () => {
    const d = run({ meta: { endMarker: null, droppedMain: 2 } })
    expect(find(d, 'E1')).toBeTruthy()
  })
  it('silent on clean end marker', () => {
    const d = run({ meta: { endMarker: true, droppedMain: 0 } })
    expect(find(d, 'E1')).toBeFalsy()
  })
  it('skipped entirely for CSV', () => {
    const d = run({ source: 'edgetx-csv', meta: { endMarker: null } })
    expect(d.coverage.skipped).toContain('E1')
  })
})

// ── E2 ────────────────────────────────────────────────────────────────
describe('E2 ends mid-air', () => {
  const midair = cadence => mkRows(300, cadence, {
    'Alt(m)': t => Math.min(200, t * 2),
    'GSpd(kmh)': () => 80,
    'RxBt(V)': () => 15.5,
  })
  it('fires when the log stops high', () => {
    const d = run({ rows: midair(0.5) })
    const f = find(d, 'E2')
    expect(f).toBeTruthy()
    expect(f.evidence.alt_agl_at_end).toBeGreaterThan(150)
  })
  it('stride-invariance: same verdict at 0.02s and 1s cadence', () => {
    const a = !!find(run({ rows: midair(0.02) }), 'E2')
    const b = !!find(run({ rows: midair(1) }), 'E2')
    expect(a).toBe(true)
    expect(b).toBe(true)
  })
  it('silent when the flight lands', () => {
    const rows = mkRows(300, 0.5, { 'Alt(m)': t => (t < 280 ? 100 : Math.max(0, 100 - (t - 280) * 6)), 'RxBt(V)': () => 15.5 })
    expect(find(run({ rows }), 'E2')).toBeFalsy()
  })
  it('guard: arm-blip logs under 10s never fire', () => {
    const rows = mkRows(1.5, 0.1, { 'Alt(m)': () => 60, 'RxBt(V)': () => 16.4 })
    expect(find(run({ rows }), 'E2')).toBeFalsy()
  })
})

// ── E3 ────────────────────────────────────────────────────────────────
describe('E3 death rattle', () => {
  it('fires on final sag-vbat collapse + garbage flags', () => {
    const slow = mkSlow(390, 2, {
      sagCompensatedVBat: t => (t < 389 ? 1548 : 34),
      rxSignalReceived: t => (t < 389 ? 1 : 6),
      IMUTemperature: t => (t < 389 ? 645 : 29),
    })
    const d = run({ slow })
    const f = find(d, 'E3')
    expect(f).toBeTruthy()
    expect(f.evidence.invalid_flag_count).toBeGreaterThan(0)
  })
  it('guard: legitimately cold sensors at flight START do not fire', () => {
    const slow = mkSlow(390, 2, {
      sagCompensatedVBat: () => 1540,
      rxSignalReceived: () => 1,
      IMUTemperature: t => Math.min(600, 100 + t * 5), // warms up 10→60°C smoothly
    })
    expect(find(run({ slow }), 'E3')).toBeFalsy()
  })
  it('silent on a clean flight', () => {
    const slow = mkSlow(390, 2, { sagCompensatedVBat: () => 1520, rxSignalReceived: () => 1, IMUTemperature: () => 640 })
    expect(find(run({ slow }), 'E3')).toBeFalsy()
  })
})

// ── E4 composite ──────────────────────────────────────────────────────
describe('E4 instant power interruption', () => {
  const crashRows = mkRows(390, 0.5, {
    'Alt(m)': t => Math.min(900, t * 4),
    'GSpd(kmh)': () => 80,
    'RxBt(V)': () => 15.49,
    'Curr(A)': () => 1.3,
  })
  const rattleSlow = mkSlow(390, 2, {
    sagCompensatedVBat: t => (t < 389.5 ? 1548 : 34),
    rxSignalReceived: t => (t < 389.5 ? 1 : 6),
    IMUTemperature: t => (t < 389.5 ? 645 : 29),
  })
  it('all constituents → critical, confidence ≥ 0.8 (the founding signature)', () => {
    const d = run({ rows: crashRows, meta: { endMarker: false } , slow: rattleSlow })
    const f = find(d, 'E4')
    expect(f).toBeTruthy()
    expect(f.severity).toBe('critical')
    expect(f.confidence).toBeGreaterThanOrEqual(0.8)
    expect(f.evidence.vbat_stable_before).toBe(true)
  })
  it('E2 alone (clean flush, no rattle) → no composite', () => {
    const d = run({ rows: crashRows, meta: { endMarker: true } })
    expect(find(d, 'E2')).toBeTruthy()
    expect(find(d, 'E4')).toBeFalsy()
  })
  it('landing flight never composites', () => {
    const rows = mkRows(390, 0.5, { 'Alt(m)': t => (t < 380 ? 100 : 1), 'RxBt(V)': () => 15.5 })
    expect(find(run({ rows, meta: { endMarker: false } }), 'E4')).toBeFalsy()
  })
})

// ── E5 ────────────────────────────────────────────────────────────────
describe('E5 impedance rising', () => {
  it('fires on a genuine late rise', () => {
    const slow = mkSlow(390, 2, { powerSupplyImpedance: t => (t < 300 ? 110 : 110 + (t - 300) * 1.2) })
    const f = find(run({ slow }), 'E5')
    expect(f).toBeTruthy()
  })
  it('guard: the cold-pack settle (166→116, downward) must NOT fire', () => {
    const slow = mkSlow(390, 2, { powerSupplyImpedance: t => (t < 33 ? 166 - t * 1.5 : 116) })
    expect(find(run({ slow }), 'E5')).toBeFalsy()
  })
  it('guard: small relative rise below the absolute floor is silent', () => {
    const slow = mkSlow(390, 2, { powerSupplyImpedance: t => (t < 300 ? 20 : 34) })
    expect(find(run({ slow }), 'E5')).toBeFalsy()
  })
})

// ── E6 ────────────────────────────────────────────────────────────────
describe('E6 brownout recovered', () => {
  it('fires on a dip-and-recover mid-flight', () => {
    const rows = mkRows(200, 0.1, {
      'Alt(m)': () => 80,
      'RxBt(V)': t => (t > 100 && t < 100.4 ? 11.2 : 15.8),
    })
    const f = find(run({ rows }), 'E6')
    expect(f).toBeTruthy()
  })
  it('sustained sag is NOT a brownout (routes to B2)', () => {
    const rows = mkRows(200, 0.1, { 'Alt(m)': () => 80, 'RxBt(V)': t => (t > 100 ? 12.8 : 15.8) })
    expect(find(run({ rows }), 'E6')).toBeFalsy()
  })
})

// ── R1 / R2 ───────────────────────────────────────────────────────────
describe('R1 failsafe + R2 rx loss', () => {
  it('R1 critical when airborne', () => {
    const rows = mkRows(200, 0.5, { 'Alt(m)': () => 120, 'RxBt(V)': () => 15.5 })
    const slow = mkSlow(200, 5, { failsafePhase: t => (t > 100 && t < 103 ? 2 : 0) })
    const f = find(run({ rows, slow }), 'R1')
    expect(f).toBeTruthy()
    expect(f.severity).toBe('critical')
  })
  it('R1 notice on the ground', () => {
    const rows = mkRows(60, 0.5, { 'Alt(m)': () => 0.5, 'RxBt(V)': () => 15.5 })
    const slow = mkSlow(60, 5, { failsafePhase: t => (t > 30 && t < 32 ? 1 : 0) })
    const f = find(run({ rows, slow, stats: { ...mkStats(rows), duration: 60 } }), 'R1')
    expect(f).toBeTruthy()
    expect(f.severity).toBe('notice')
  })
  it('R1 corrupt-tail guard: failsafe inside the death rattle is not real (LOG00060 regression)', () => {
    const rows = mkRows(390, 0.5, { 'Alt(m)': () => 800, 'RxBt(V)': () => 15.5 })
    const slow = mkSlow(390, 2, {
      failsafePhase: t => (t > 389.6 ? 5 : 0),          // "failsafe" only in the garbage tail
      sagCompensatedVBat: t => (t < 389.5 ? 1548 : 34), // rattle present
      rxSignalReceived: t => (t < 389.5 ? 1 : 6),
      IMUTemperature: () => 640,
    })
    const d = run({ rows, slow })
    expect(find(d, 'E3')).toBeTruthy()
    expect(find(d, 'R1')).toBeFalsy()
  })

  it('R2 fires on a ≥0.2s loss window', () => {
    const slow = mkSlow(200, 20, { rxSignalReceived: t => (t > 90 && t < 90.5 ? 0 : 1) })
    expect(find(run({ slow }), 'R2')).toBeTruthy()
  })
  it('R2 guard: a single lost frame does not fire', () => {
    const slow = mkSlow(200, 20, { rxSignalReceived: t => (Math.abs(t - 90) < 0.03 ? 0 : 1) })
    expect(find(run({ slow }), 'R2')).toBeFalsy()
  })
  it('R2 on CSV uses RQly==0', () => {
    const rows = mkRows(200, 0.5, { 'Alt(m)': () => 100, 'RQly(%)': t => (t > 90 && t < 92 ? 0 : 98), 'RxBt(V)': () => 15.5 })
    expect(find(run({ source: 'edgetx-csv', rows }), 'R2')).toBeTruthy()
  })
})

// ── R3 ────────────────────────────────────────────────────────────────
describe('R3 link degradation', () => {
  it('guard: the fixture landing pass — deep RSSI dip, RQly steady — stays quiet', () => {
    const rows = mkRows(540, 0.5, {
      'Alt(m)': t => (t < 530 ? 100 : 3),
      'RQly(%)': () => 98,
      '1RSS(dB)': t => (t > 535 ? -86 : -48),
      'RxBt(V)': () => 15.5,
    })
    // RQly present and healthy → preferred metric → no finding
    expect(find(run({ source: 'edgetx-csv', rows }), 'R3')).toBeFalsy()
  })
  it('fires when link quality itself collapses late', () => {
    const rows = mkRows(540, 0.5, {
      'Alt(m)': () => 100,
      'RQly(%)': t => (t > 510 ? 40 : 99),
      'RxBt(V)': () => 15.5,
    })
    expect(find(run({ source: 'edgetx-csv', rows }), 'R3')).toBeTruthy()
  })
})

// ── B1 / B2 ───────────────────────────────────────────────────────────
describe('B1 internal resistance + B2 discharge, chemistry-aware', () => {
  const punchRows = (sagPerPunchV, baseV = 16.0) => mkRows(300, 0.5, {
    'Alt(m)': () => 60,
    'Curr(A)': t => (Math.floor(t) % 30 === 0 ? 22 : 3),
    'RxBt(V)': t => (Math.floor(t) % 30 === 0 ? baseV - sagPerPunchV : baseV),
  })
  it('B1 fires on a saggy LiPo', () => {
    // 19A punch delta, 4S: 0.06 V/cell/A → ~60 mΩ/cell
    const d = run({ rows: punchRows(4.6), chem: { cells: 4, chemistry: 'lipo', perCellFull: 4.2 } })
    expect(find(d, 'B1')).toBeTruthy()
  })
  it('B1 guard: the same numbers on Li-ion are healthy', () => {
    const d = run({ rows: punchRows(4.6), chem: { cells: 4, chemistry: 'liion', perCellFull: 4.05 } })
    expect(find(d, 'B1')).toBeFalsy()
  })
  it('B1 guard: fewer than 3 punches never fires', () => {
    const rows = mkRows(50, 0.5, {
      'Alt(m)': () => 60,
      'Curr(A)': t => (t === 25 ? 22 : 3),
      'RxBt(V)': t => (t === 25 ? 11.5 : 16),
    })
    expect(find(run({ rows }), 'B1')).toBeFalsy()
  })
  const landAt = (perCell, chemistry) => run({
    rows: mkRows(300, 0.5, { 'Alt(m)': t => (t < 290 ? 60 : 1), 'RxBt(V)': t => (t > 290 ? perCell * 4 : 15.2) }),
    chem: { cells: 4, chemistry, perCellFull: chemistry === 'lipo' ? 4.2 : 4.05 },
  })
  it('B2 boundaries on LiPo: 3.49 warning, 3.29 critical, 3.55 info', () => {
    expect(find(landAt(3.49, 'lipo'), 'B2')?.severity).toBe('warning')
    expect(find(landAt(3.29, 'lipo'), 'B2')?.severity).toBe('critical')
    expect(find(landAt(3.55, 'lipo'), 'B2')?.severity).toBe('info')
  })
  it('B2 guard: 3.2 V/cell Li-ion landing fires NOTHING (the false-critical fix)', () => {
    expect(find(landAt(3.2, 'liion'), 'B2')).toBeFalsy()
  })
})

// ── X / meta + orchestrator ───────────────────────────────────────────
describe('meta findings + orchestrator', () => {
  it('clean flight → X1, clean=true', () => {
    const rows = mkRows(300, 0.5, { 'Alt(m)': t => (t < 290 ? 80 : 1), 'RxBt(V)': t => 16 - t * 0.003 })
    const d = run({ rows, meta: { endMarker: true } })
    expect(d.clean).toBe(true)
    expect(find(d, 'X1')).toBeTruthy()
  })
  it('CSV → X2 coverage note with skipped detectors', () => {
    const d = run({ source: 'edgetx-csv' })
    const f = find(d, 'X2')
    expect(f).toBeTruthy()
    expect(f.evidence.skipped_count).toBeGreaterThan(0)
  })
  it('a throwing detector reports {id, error_name} and never breaks the run', () => {
    // slow with names but broken frames access triggers inside detectors
    const evil = { names: ['powerSupplyImpedance'], times: new Float64Array([0, 1e6]), get frames() { throw new TypeError('boom') }, cols: 1, n: 2, t0Us: 0 }
    const d = run({ slow: evil })
    expect(d.errors.some(e => e.error_name === 'TypeError')).toBe(true)
    expect(d.findings.length).toBeGreaterThan(0) // B4 etc. still ran
    // error entries never carry a message field
    for (const e of d.errors) expect(Object.keys(e).sort()).toEqual(['error_name', 'id'])
  })
  it('last known position is computed locally for E2 flights', () => {
    const rows = mkRows(300, 0.5, {
      'Alt(m)': t => Math.min(200, t * 2),
      'GSpd(kmh)': () => 60,
      'RxBt(V)': () => 15.5,
    })
    rows.forEach((r, i) => { r._lat = 0.5 + i * 1e-5; r._lon = 0.5 })
    const d = run({ rows })
    expect(find(d, 'E2')).toBeTruthy()
    expect(d.local.lastFix).toBeTruthy()
    expect(d.local.lastFix.distKm).toBeGreaterThan(0)
  })
})

// ── firmware / tail utilities ─────────────────────────────────────────
describe('parseFirmware + scanLogTail', () => {
  it('extracts family, version, target; drops the commit hash', () => {
    expect(parseFirmware('INAV 9.0.0 (a7932b92) SPEEDYBEEF405WING')).toEqual({
      firmwareFamily: 'INAV', firmwareVersion: '9.0.0', target: 'SPEEDYBEEF405WING',
    })
  })
  it('rejects a fork string that fits no allowlist', () => {
    const out = parseFirmware('MyCustomFork build-77 (deadbeef)')
    expect(out.firmwareFamily).toBeNull()
  })
  it('finds the end marker in a tail, counts padding', () => {
    const buf = new Uint8Array(4096).fill(0x41)
    const marker = 'End of log'
    for (let i = 0; i < marker.length; i++) buf[3000 + i] = marker.charCodeAt(i)
    buf.fill(0x00, 3500)
    const out = scanLogTail(buf)
    expect(out.endMarker).toBe(true)
    expect(out.padBytes).toBe(4096 - 3500)
  })
  it('no marker in padding-only tail', () => {
    const buf = new Uint8Array(4096).fill(0xff)
    expect(scanLogTail(buf).endMarker).toBe(false)
  })
})
