/**
 * Flight Debrief — deterministic detectors + composite scenarios.
 *
 * Runs INSIDE the parse path (mapToViewerLog for blackbox, before
 * parsed.free(); end of parseEdgeTXLog for CSV) so detectors can see
 * both the viewer rows AND the raw decoded slow-frame arrays that never
 * survive into rows. Pure functions over a ctx object — no DOM, no
 * network, worker-safe. See docs/FLIGHT-DEBRIEF-DESIGN.md §2/§5.
 *
 * ctx = {
 *   source: 'blackbox' | 'edgetx-csv',
 *   rows, stats, events,
 *   slow: null | { names, times: Float64Array(µs, first n sane), frames, cols, n, t0Us },
 *   main: null | { names, times, frames, cols, n, t0Us },   // strided
 *   meta: { endMarker: bool|null, droppedMain, droppedGps, padBytes,
 *           firmwareFamily, firmwareVersion, target, cadenceS },
 *   chem: { cells, chemistry: 'lipo'|'liion'|null, perCellFull },
 * }
 *
 * A finding = { id, cls, severity, confidence, t: [s,s]|null,
 *               evidence: {numbers/bools/enums only}, spark? }
 * Severity ladder: info < notice < warning < critical.
 */
import { T } from './thresholds.js'

export const SEVERITY_RANK = { info: 0, notice: 1, warning: 2, critical: 3 }

// ── shared helpers ─────────────────────────────────────────────────────

const median = arr => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const stddev = arr => {
  if (arr.length < 2) return 0
  const m = arr.reduce((a, b) => a + b, 0) / arr.length
  return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length)
}

// Numeric row series over a window [tA, tB] (whole flight when omitted).
const rowSeries = (rows, key, tA = -Infinity, tB = Infinity) => {
  const t = [], v = []
  for (const r of rows) {
    if (r._tSec < tA || r._tSec > tB) continue
    const x = r[key]
    if (typeof x === 'number' && !isNaN(x)) { t.push(r._tSec), v.push(x) }
  }
  return { t, v }
}

// Slow-frame column as {t(relative s), v} within the sanitized run.
const slowSeries = (slow, name) => {
  const t = [], v = []
  if (!slow) return { t, v }
  const j = slow.names.indexOf(name)
  if (j < 0) return { t, v }
  for (let i = 0; i < slow.n; i++) {
    t.push((slow.times[i] - slow.t0Us) / 1e6)
    v.push(slow.frames[i * slow.cols + j])
  }
  return { t, v }
}

const hasSlowField = (slow, name) => !!slow && slow.names.indexOf(name) >= 0

// Slant range (m) from launch to a row: the hypotenuse of horizontal
// distance and AGL altitude — "how far away was it, really".
const slantAt = (row, home) => {
  if (row._lat == null || home == null) return null
  const dLat = (row._lat - home._lat) * 111320
  const dLon = (row._lon - home._lon) * 111320 * Math.cos(home._lat * Math.PI / 180)
  const h = Math.hypot(dLat, dLon)
  const a = typeof row['Alt(m)'] === 'number' && !isNaN(row['Alt(m)']) ? Math.max(0, row['Alt(m)']) : 0
  return Math.hypot(h, a)
}

// Last GPS-bearing row at or before time t — the last place we KNEW it was.
const lastFixBefore = (rows, t) => {
  let best = null
  for (const r of rows) {
    if (r._tSec > t) break
    if (r._lat != null) best = r
  }
  return best
}

// Link quality vs slant distance, bucketed — NOT a time series: the
// average link reading at each distance band (the flight’s own link-
// budget curve). x = bucket centre in metres, y = avg LQ%/RSSI.
export function lqDistanceProfile(rows, home, key) {
  if (!home) return null
  const B = 14
  let maxSlant = 0
  const samples = []
  for (const r of rows) {
    const s = slantAt(r, home)
    const v = r[key]
    if (s == null || typeof v !== 'number' || isNaN(v)) continue
    if (s > maxSlant) maxSlant = s
    samples.push([s, v])
  }
  if (samples.length < 20 || maxSlant < 100) return null
  const width = maxSlant / B
  const sum = new Array(B).fill(0), n = new Array(B).fill(0)
  for (const [s, v] of samples) {
    const b = Math.min(B - 1, Math.floor(s / width))
    sum[b] += v; n[b]++
  }
  const points = []
  for (let b = 0; b < B; b++) {
    if (n[b] >= 3) points.push([Math.round((b + 0.5) * width), sum[b] / n[b]])
  }
  return points.length >= 4 ? points : null
}

// Bounded sparkline slice for the local evidence card. Never enters the
// AI payload (payload.js strips spark) — local render only.
const spark = (label, unit, t, v, tA = null, tB = null, marks = []) => {
  let idx = t.map((x, i) => i)
  if (tA != null) idx = idx.filter(i => t[i] >= tA - T.SPARK_CONTEXT_S && t[i] <= tB + T.SPARK_CONTEXT_S)
  const step = Math.max(1, Math.ceil(idx.length / T.SPARK_MAX_POINTS))
  const pts = []
  for (let k = 0; k < idx.length; k += step) pts.push([t[idx[k]], v[idx[k]]])
  return pts.length >= 2 ? { label, unit, xUnit: 's', points: pts, marks } : null
}

const lastValid = (rows, key, windowS = Infinity) => {
  const end = rows[rows.length - 1]?._tSec ?? 0
  for (let i = rows.length - 1; i >= 0; i--) {
    if (end - rows[i]._tSec > windowS) break
    const x = rows[i][key]
    if (typeof x === 'number' && !isNaN(x)) return { v: x, t: rows[i]._tSec, i }
  }
  return null
}

// ── chemistry / cells (exported for tests + mapper) ────────────────────

export function detectChemistry(rows) {
  // Per-cell voltage at log start decides cell count + chemistry. Uses
  // the first 10 s median so a momentary droop at arm doesn't skew it.
  const { v } = rowSeries(rows, 'RxBt(V)', 0, 10)
  const v0 = median(v.filter(x => x > 4))
  if (!v0) return { cells: null, chemistry: null, perCellFull: null }
  const cells = Math.max(1, Math.round(v0 / 4.0))
  const perCellFull = v0 / cells
  let chemistry = null
  if (perCellFull >= T.LIPO_FULL_MIN) chemistry = 'lipo'
  else if (perCellFull <= T.LIION_FULL_MAX) chemistry = 'liion'
  return { cells, chemistry, perCellFull }
}

// ── detectors ──────────────────────────────────────────────────────────

const E1 = {
  id: 'E1', cls: 'electrical',
  requires: ctx => ctx.source === 'blackbox',
  run(ctx) {
    const { endMarker, droppedMain, droppedGps, padBytes } = ctx.meta
    if (endMarker !== false && !(droppedMain > 0)) return null
    return {
      id: 'E1', cls: 'electrical', severity: 'notice', confidence: 0.95, t: null,
      evidence: {
        end_marker: endMarker === true,
        dropped_main: droppedMain || 0,
        dropped_gps: droppedGps || 0,
        pad_bytes: padBytes ?? 0,
      },
    }
  },
}

const E2 = {
  id: 'E2', cls: 'electrical',
  requires: ctx => rowSeries(ctx.rows, 'Alt(m)').v.length > 0,
  run(ctx) {
    if (ctx.stats.duration < T.MIN_FLIGHT_S) return null
    const end = ctx.stats.duration
    const win = rowSeries(ctx.rows, 'Alt(m)', end - T.MIDAIR_WINDOW_S, end)
    if (!win.v.length) return null
    const minWin = Math.min(...win.v)
    const last = win.v[win.v.length - 1]
    // Landing = altitude actually came down inside the final window.
    if (last <= T.MIDAIR_END_ALT_M || minWin <= T.MIDAIR_END_ALT_M * 0.75) return null
    const spd = lastValid(ctx.rows, 'GSpd(kmh)', T.MIDAIR_WINDOW_S)
    const all = rowSeries(ctx.rows, 'Alt(m)', end - 30, end)
    return {
      id: 'E2', cls: 'electrical', severity: 'warning',
      confidence: spd && spd.v > 30 ? 0.9 : 0.75,
      t: [Math.max(0, end - T.MIDAIR_WINDOW_S), end],
      evidence: { alt_agl_at_end: last, gspd_at_end: spd ? spd.v : null },
      spark: spark('Altitude', 'm', all.t, all.v, end - 30, end),
    }
  },
}

const E3 = {
  id: 'E3', cls: 'electrical',
  requires: ctx => hasSlowField(ctx.slow, 'sagCompensatedVBat') ||
    hasSlowField(ctx.slow, 'rxSignalReceived') || hasSlowField(ctx.slow, 'IMUTemperature'),
  run(ctx) {
    const { slow, chem } = ctx
    if (!slow || slow.n < 4 || ctx.stats.duration < T.MIN_FLIGHT_S) return null
    const endT = (slow.times[slow.n - 1] - slow.t0Us) / 1e6
    const K = 3 // final frames under inspection
    const from = slow.n - K
    const sag = slowSeries(slow, 'sagCompensatedVBat')
    const imu = slowSeries(slow, 'IMUTemperature')
    const rx = slowSeries(slow, 'rxSignalReceived')
    const rxValid = slowSeries(slow, 'rxFlightChannelsValid')
    const cells = chem.cells || 4

    let sagCollapse = null, tempStep = null, invalidFlags = 0
    // Healthy reference: median over the flight excluding the tail.
    const sagRef = median(sag.v.slice(0, Math.max(1, sag.v.length - K)))
    for (let i = Math.max(0, from); i < slow.n; i++) {
      if (sag.v.length === slow.n) {
        const perCell = sag.v[i] / 100 / cells // centivolts → V
        if (sagRef != null && sagRef / 100 / cells > 3 && perCell < T.RATTLE_VBAT_PER_CELL) {
          sagCollapse = sag.v[i] / 100
        }
      }
      if (imu.v.length === slow.n && i > 0) {
        const step = Math.abs(imu.v[i] - imu.v[i - 1]) / 10 // deci°C → °C
        if (step > T.RATTLE_TEMP_STEP_C) tempStep = step
      }
      if (rx.v.length === slow.n && rx.v[i] !== 0 && rx.v[i] !== 1) invalidFlags++
      if (rxValid.v.length === slow.n && rxValid.v[i] !== 0 && rxValid.v[i] !== 1) invalidFlags++
    }
    if (sagCollapse == null && tempStep == null && invalidFlags === 0) return null
    ctx._rattleT = Math.max(0, endT - 1.5)
    return {
      id: 'E3', cls: 'electrical', severity: 'warning', confidence: 0.85,
      t: [Math.max(0, endT - 1), endT],
      evidence: {
        sag_vbat_final_v: sagCollapse,
        temp_step_c: tempStep,
        invalid_flag_count: invalidFlags,
      },
      spark: spark('Sag-comp vbat', 'V', sag.t, sag.v.map(x => x / 100), endT - 30, endT),
    }
  },
}

const E5 = {
  id: 'E5', cls: 'electrical',
  requires: ctx => hasSlowField(ctx.slow, 'powerSupplyImpedance'),
  run(ctx) {
    if (ctx.stats.duration < T.MIN_FLIGHT_S) return null
    const s = slowSeries(ctx.slow, 'powerSupplyImpedance')
    const nz = s.v.map((v, i) => [s.t[i], v]).filter(([, v]) => v > 0)
    if (nz.length < 20) return null
    const endT = nz[nz.length - 1][0]
    // Baseline: median of the middle half — skips the cold-pack settle
    // at the start (fixture: 166→116 mΩ downward, must NOT fire) and
    // the tail under test.
    const mid = nz.slice(Math.floor(nz.length * 0.25), Math.floor(nz.length * 0.75))
    const base = median(mid.map(([, v]) => v))
    const tail = median(nz.filter(([t]) => t > endT - 30).map(([, v]) => v))
    if (base == null || tail == null) return null
    if (tail < base * T.IMPEDANCE_RISE_FACTOR || tail - base < T.IMPEDANCE_RISE_FLOOR_MOHM) return null
    return {
      id: 'E5', cls: 'electrical', severity: 'warning', confidence: 0.8,
      t: [Math.max(0, endT - 30), endT],
      evidence: { impedance_baseline_mohm: base, impedance_late_mohm: tail },
      spark: spark('Supply impedance', 'mΩ', s.t, s.v),
    }
  },
}

const E6 = {
  id: 'E6', cls: 'electrical',
  requires: ctx => ctx.rows.some(r => r['RxBt(V)'] > 0),
  run(ctx) {
    const { cells } = ctx.chem
    if (!cells) return null
    const { t, v } = rowSeries(ctx.rows, 'RxBt(V)')
    const dipV = T.BROWNOUT_PER_CELL_V * cells
    const recV = T.BROWNOUT_RECOVER_PER_CELL_V * cells
    const endT = ctx.stats.duration
    for (let i = 1; i < v.length; i++) {
      if (v[i] >= dipV || v[i] <= 1) continue
      // find recovery within the window; must ALSO not be the log end
      for (let j = i + 1; j < v.length && t[j] - t[i] <= T.BROWNOUT_RECOVER_S; j++) {
        if (v[j] >= recV && endT - t[i] > T.MIN_FLIGHT_S / 2) {
          const win = rowSeries(ctx.rows, 'RxBt(V)', t[i] - 10, t[i] + 10)
          return {
            id: 'E6', cls: 'electrical', severity: 'warning',
            // Coarse row cadence (radio logs at 0.5–1 s) can't resolve
            // sub-sample dips — say so via confidence.
            confidence: ctx.meta.cadenceS <= 0.2 ? 0.85 : 0.5,
            t: [t[i], Math.min(endT, t[i] + T.BROWNOUT_RECOVER_S)],
            evidence: { dip_v: v[i], recovered_v: recV, cells },
            spark: spark('Battery', 'V', win.t, win.v, t[i] - 10, t[i] + 10),
          }
        }
      }
    }
    return null
  },
}

const R1 = {
  id: 'R1', cls: 'link',
  requires: ctx => hasSlowField(ctx.slow, 'failsafePhase'),
  run(ctx) {
    const s = slowSeries(ctx.slow, 'failsafePhase')
    const ranges = []
    let start = null, phase = 0
    for (let i = 0; i < s.v.length; i++) {
      const p = s.v[i]
      const active = p >= 1 && p <= 6 // in-enum, non-idle
      if (active && start == null) { start = s.t[i]; phase = p }
      if (!active && start != null) { ranges.push([start, s.t[i], phase]); start = null }
    }
    if (start != null) ranges.push([start, s.t[s.t.length - 1], phase])
    // Corrupt-tail guard: a "failsafe" that begins inside the E3 death-
    // rattle window is the ADC collapsing, not a real failsafe entry.
    const rattle = ctx._rattleT
    const real = ranges.filter(([a]) => rattle == null || a < rattle)
    if (!real.length) return null
    ranges.splice(0, ranges.length, ...real)
    const alt = lastValid(ctx.rows, 'Alt(m)') // was it airborne at first entry?
    const airborne = (() => {
      const a = rowSeries(ctx.rows, 'Alt(m)', ranges[0][0] - 2, ranges[0][0] + 2)
      return a.v.length ? Math.max(...a.v) > T.MIDAIR_END_ALT_M : !!(alt && alt.v > T.MIDAIR_END_ALT_M)
    })()
    return {
      id: 'R1', cls: 'link', severity: airborne ? 'critical' : 'notice', confidence: 0.95,
      t: [ranges[0][0], ranges[ranges.length - 1][1]],
      evidence: { count: ranges.length, first_phase: ranges[0][2], airborne },
    }
  },
}

const R2 = {
  id: 'R2', cls: 'link',
  requires: ctx => hasSlowField(ctx.slow, 'rxSignalReceived') ||
    (ctx.source === 'edgetx-csv' && rowSeries(ctx.rows, 'RQly(%)').v.length > 0),
  run(ctx) {
    let t, lost
    if (hasSlowField(ctx.slow, 'rxSignalReceived')) {
      const s = slowSeries(ctx.slow, 'rxSignalReceived')
      // Ignore out-of-enum garbage (E3's death rattle is not RX loss).
      t = s.t; lost = s.v.map(v => v === 0)
    } else {
      const s = rowSeries(ctx.rows, 'RQly(%)')
      t = s.t; lost = s.v.map(v => v === 0)
    }
    const windows = []
    let start = null
    for (let i = 0; i < lost.length; i++) {
      if (lost[i] && start == null) start = t[i]
      if (!lost[i] && start != null) {
        if (t[i] - start >= T.RX_LOSS_MIN_S) windows.push([start, t[i]])
        start = null
      }
    }
    if (start != null && t[t.length - 1] - start >= T.RX_LOSS_MIN_S) windows.push([start, t[t.length - 1]])
    if (!windows.length) return null
    const longest = windows.reduce((a, w) => Math.max(a, w[1] - w[0]), 0)
    // ── loss geometry: WHERE in space did the link die? Hypotenuse from
    // launch to the last known position at each loss start, judged
    // against the flight’s own maximum slant range.
    const evidence = { window_count: windows.length, longest_s: longest }
    let geoSpark = null
    const home = ctx.rows.find(r => r._lat != null)
    if (home) {
      let maxSlant = 0
      const sT = [], sV = []
      for (const r of ctx.rows) {
        const s = slantAt(r, home)
        if (s == null) continue
        if (s > maxSlant) maxSlant = s
        sT.push(r._tSec); sV.push(s)
      }
      const lossSlants = windows
        .map(([a]) => lastFixBefore(ctx.rows, a))
        .filter(Boolean)
        .map(r => slantAt(r, home))
        .filter(s => s != null)
      if (lossSlants.length && maxSlant > 0) {
        const med = median(lossSlants)
        const ratio = med / maxSlant
        let pattern = 'mixed'
        if (ratio >= T.RANGE_BOUNDARY_RATIO) pattern = 'range_boundary'
        else if (ratio <= T.CLOSE_IN_RATIO || med <= T.CLOSE_IN_ABS_M) pattern = 'close_in'
        evidence.loss_slant_m = med
        evidence.max_slant_m = maxSlant
        evidence.slant_ratio = ratio
        evidence.pattern = pattern
        // Prefer the link-budget curve (avg LQ per distance band);
        // fall back to the slant-range time series.
        const lqKey = rowSeries(ctx.rows, 'RQly(%)').v.length ? 'RQly(%)' : '1RSS(dB)'
        const prof = lqDistanceProfile(ctx.rows, home, lqKey)
        geoSpark = prof
          ? { label: (lqKey === 'RQly(%)' ? 'Avg link quality' : 'Avg RSSI') + ' vs distance', unit: lqKey === 'RQly(%)' ? '%' : 'dB', xUnit: 'm', points: prof, marks: [] }
          : spark('Slant range from launch', 'm', sT, sV)
      }
    }
    return {
      id: 'R2', cls: 'link', severity: 'critical', confidence: 0.9,
      t: windows[0],
      evidence,
      spark: geoSpark,
    }
  },
}

const R3 = {
  id: 'R3', cls: 'link',
  requires: ctx => rowSeries(ctx.rows, 'RQly(%)').v.length > 0 ||
    rowSeries(ctx.rows, '1RSS(dB)').v.length > 0,
  run(ctx) {
    // Prefer link quality (%) — RSSI dB swings with antenna orientation.
    const q = rowSeries(ctx.rows, 'RQly(%)')
    const use = q.v.length ? q : rowSeries(ctx.rows, '1RSS(dB)')
    const isQly = q.v.length > 0
    if (use.v.length < 30 || ctx.stats.duration < T.LINK_MIN_FLIGHT_S) return null
    const endT = ctx.stats.duration
    const flightMed = median(use.v.slice(0, Math.floor(use.v.length * 0.8)))
    const tail = use.v.filter((_, i) => use.t[i] > endT - T.LINK_WINDOW_S)
    const tailMed = median(tail)
    if (flightMed == null || tailMed == null) return null
    // Scale-agnostic: fraction moved DOWN from the flight median. Works
    // for LQ % (100→40), positive-unit RSSI (iNAV 0..1023: 868→812 is
    // only 6% — must not fire), and negative dBm alike.
    const drop = (flightMed - tailMed) / Math.max(1, Math.abs(flightMed))
    if (drop < T.LINK_DROP_FRACTION) return null
    // Far-out flying degrades links by physics; that's a notice, not a warning.
    const far = (() => {
        const home = ctx.rows.find(r => r._lat != null)
        const last = [...ctx.rows].reverse().find(r => r._lat != null)
        if (!home || !last) return false
        let maxSlant = 0
        for (const r of ctx.rows) {
          const s = slantAt(r, home)
          if (s != null && s > maxSlant) maxSlant = s
        }
        const s = slantAt(last, home)
        return s != null && maxSlant > 0 && s > maxSlant * 0.7
      })()
    return {
      id: 'R3', cls: 'link', severity: far ? 'notice' : 'warning', confidence: 0.7,
      t: [Math.max(0, endT - T.LINK_WINDOW_S), endT],
      evidence: {
        metric: isQly ? 'lq' : 'rssi',
        flight_median: flightMed, late_median: tailMed, distance_correlated: far,
      },
      spark: (() => { const home = ctx.rows.find(r => r._lat != null); const prof = home ? lqDistanceProfile(ctx.rows, home, isQly ? 'RQly(%)' : '1RSS(dB)') : null; return prof ? { label: (isQly ? 'Avg link quality' : 'Avg RSSI') + ' vs distance', unit: isQly ? '%' : 'dB', xUnit: 'm', points: prof, marks: [] } : spark(isQly ? 'Link quality' : 'RSSI', isQly ? '%' : 'dB', use.t, use.v) })(),
    }
  },
}

const R4 = {
  id: 'R4', cls: 'link',
  requires: ctx => hasSlowField(ctx.slow, 'rxUpdateRate'),
  run(ctx) {
    const s = slowSeries(ctx.slow, 'rxUpdateRate')
    const med = median(s.v.filter(v => v > 0))
    if (!med) return null
    let start = null, worst = 0, windows = 0
    for (let i = 0; i < s.v.length; i++) {
      const low = s.v[i] < med * T.RC_RATE_FRACTION
      if (low && start == null) start = s.t[i]
      if (!low && start != null) {
        const len = s.t[i] - start
        if (len >= T.RC_RATE_MIN_S) { windows++; worst = Math.max(worst, len) }
        start = null
      }
    }
    if (!windows) return null
    return {
      id: 'R4', cls: 'link', severity: windows > 2 ? 'warning' : 'notice', confidence: 0.75,
      t: null,
      evidence: { window_count: windows, longest_s: worst, median_rate: med },
    }
  },
}

const B1 = {
  id: 'B1', cls: 'battery',
  requires: ctx => ctx.rows.some(r => r['Curr(A)'] > 0) && ctx.rows.some(r => r['RxBt(V)'] > 0),
  run(ctx) {
    const { cells, chemistry } = ctx.chem
    if (!cells || ctx.stats.duration < T.MIN_FLIGHT_S) return null
    const rows = ctx.rows
    const punches = []
    for (let i = 1; i < rows.length; i++) {
      const dI = (rows[i]['Curr(A)'] ?? 0) - (rows[i - 1]['Curr(A)'] ?? 0)
      const dV = (rows[i - 1]['RxBt(V)'] ?? 0) - (rows[i]['RxBt(V)'] ?? 0)
      const dt = rows[i]._tSec - rows[i - 1]._tSec
      if (dt > 1.5 || dI < T.IR_PUNCH_MIN_DELTA_A || dV <= 0) continue
      punches.push((dV / dI / cells) * 1000) // mΩ per cell
    }
    if (punches.length < T.IR_MIN_PUNCHES) return null
    const ir = median(punches)
    const limit = T.IR_WARN_MOHM[chemistry || 'lipo']
    if (ir < limit) return null
    return {
      id: 'B1', cls: 'battery', severity: 'warning',
      confidence: chemistry ? 0.7 : 0.5,
      t: null,
      evidence: { ir_per_cell_mohm: ir, punch_count: punches.length, chemistry: chemistry || 'unknown' },
      ackable: true,
    }
  },
}

const B2 = {
  id: 'B2', cls: 'battery',
  requires: ctx => ctx.rows.some(r => r['RxBt(V)'] > 0),
  run(ctx) {
    const { cells, chemistry } = ctx.chem
    if (!cells || ctx.stats.duration < T.MIN_FLIGHT_S) return null
    const endT = ctx.stats.duration
    const tail = rowSeries(ctx.rows, 'RxBt(V)', endT - 5, endT)
    const endV = median(tail.v.filter(v => v > 1))
    if (endV == null) return null
    const perCell = endV / cells
    const th = T.DISCHARGE[chemistry || 'lipo']
    let severity = null
    if (perCell < th.critical) severity = 'critical'
    else if (perCell < th.warning) severity = 'warning'
    if (!severity) return null
    return {
      id: 'B2', cls: 'battery', severity, confidence: chemistry ? 0.85 : 0.6,
      t: [Math.max(0, endT - 5), endT],
      evidence: { end_v_per_cell: perCell, cells, chemistry: chemistry || 'unknown' },
    }
  },
}

const B3 = {
  id: 'B3', cls: 'battery',
  requires: ctx => hasSlowField(ctx.slow, 'sagCompensatedVBat') && ctx.rows.some(r => r['RxBt(V)'] > 0),
  run(ctx) {
    const { cells } = ctx.chem
    if (!cells) return null
    if (ctx.stats.duration < T.MIN_FLIGHT_S) return null
    const sag = slowSeries(ctx.slow, 'sagCompensatedVBat')
    if (sag.v.length < 40) return null
    // Gap between iNAV's sag-compensated (resting-estimate) and raw vbat,
    // early vs late thirds. Growth = pack weaker than the model expects.
    const vbatAt = t => {
      const w = rowSeries(ctx.rows, 'RxBt(V)', t - 2, t + 2)
      return median(w.v.filter(v => v > 1))
    }
    const third = Math.floor(sag.v.length / 3)
    const gapAt = i => {
      const raw = vbatAt(sag.t[i])
      return raw != null ? sag.v[i] / 100 - raw : null
    }
    const early = [], late = []
    for (let k = 0; k < 10; k++) {
      const a = gapAt(Math.floor(third * (k / 10)))
      const b = gapAt(sag.v.length - 1 - Math.floor(third * (k / 10)))
      if (a != null) early.push(a)
      if (b != null) late.push(b)
    }
    const growth = (median(late) ?? 0) - (median(early) ?? 0)
    if (growth / cells < T.SAG_DIVERGENCE_PER_CELL_V) return null
    return {
      id: 'B3', cls: 'battery', severity: 'notice', confidence: 0.6, t: null,
      evidence: { gap_growth_per_cell_v: growth / cells },
      ackable: true,
    }
  },
}

const B4 = {
  id: 'B4', cls: 'battery',
  requires: ctx => ctx.rows.some(r => r['RxBt(V)'] > 0),
  run(ctx) {
    const endT = ctx.stats.duration
    const curr = rowSeries(ctx.rows, 'Curr(A)')
    const avgA = curr.v.length ? curr.v.reduce((a, b) => a + b, 0) / curr.v.length : null
    const endV = median(rowSeries(ctx.rows, 'RxBt(V)', endT - 5, endT).v.filter(v => v > 1))
    return {
      id: 'B4', cls: 'battery', severity: 'info', confidence: 1, t: null,
      evidence: {
        duration_s: endT,
        mah_used: ctx.stats.maxCapacity || null,
        avg_current_a: avgA,
        end_v_per_cell: endV != null && ctx.chem.cells ? endV / ctx.chem.cells : null,
        cells: ctx.chem.cells,
      },
    }
  },
}

const M1 = {
  id: 'M1', cls: 'mechanical', experimental: true,
  requires: ctx => !!ctx.main && ctx.main.names.indexOf('accVib') >= 0,
  run(ctx) {
    if (ctx.stats.duration < T.MIN_FLIGHT_S) return null
    const { main } = ctx
    const j = main.names.indexOf('accVib')
    const t = [], v = []
    for (let i = 0; i < main.n; i++) {
      t.push((main.times[i] - main.t0Us) / 1e6)
      v.push(main.frames[i * main.cols + j])
    }
    const med = median(v.filter(x => x > 0))
    if (!med) return null
    let start = null, worst = 0, total = 0
    for (let i = 0; i < v.length; i++) {
      const high = v[i] > med * T.VIB_FACTOR
      if (high && start == null) start = t[i]
      if (!high && start != null) {
        const len = t[i] - start
        if (len >= T.VIB_MIN_S) { total += len; worst = Math.max(worst, len) }
        start = null
      }
    }
    if (total < T.VIB_MIN_S) return null
    return {
      id: 'M1', cls: 'mechanical', severity: 'notice', confidence: 0.5, t: null,
      evidence: { high_vib_total_s: total, longest_s: worst, vib_median: med },
      spark: spark('accVib', '', t, v),
      ackable: true, experimental: true,
    }
  },
}

const M2 = {
  id: 'M2', cls: 'mechanical', experimental: true,
  requires: ctx => !!ctx.main && ctx.main.names.indexOf('accVib') >= 0 &&
    ctx.rows.some(r => r._stickRoll != null),
  run(ctx) {
    if (ctx.stats.duration < T.MIN_FLIGHT_S) return null
    // Re-scoped after review (design §5): strided main frames can't do
    // frequency analysis, so "oscillation" = sustained high accVib while
    // the STICKS are quiet — vibration the pilot isn't commanding.
    const { main, rows } = ctx
    const j = main.names.indexOf('accVib')
    const med = (() => {
      const all = []
      for (let i = 0; i < main.n; i++) all.push(main.frames[i * main.cols + j])
      return median(all.filter(x => x > 0))
    })()
    if (!med) return null
    // stick activity per second bucket
    const stickRate = new Map()
    for (let i = 1; i < rows.length; i++) {
      const dt = rows[i]._tSec - rows[i - 1]._tSec
      if (dt <= 0) continue
      const d = Math.abs((rows[i]._stickRoll ?? 0) - (rows[i - 1]._stickRoll ?? 0)) +
        Math.abs((rows[i]._stickPitch ?? 0) - (rows[i - 1]._stickPitch ?? 0))
      const bucket = Math.floor(rows[i]._tSec)
      stickRate.set(bucket, (stickRate.get(bucket) || 0) + d / dt)
    }
    let start = null, windows = 0, worst = 0
    for (let i = 0; i < main.n; i++) {
      const t = (main.times[i] - main.t0Us) / 1e6
      const high = main.frames[i * main.cols + j] > med * T.OSC_FACTOR
      const quiet = (stickRate.get(Math.floor(t)) || 0) < T.OSC_STICK_QUIET_PCT_S
      const osc = high && quiet
      if (osc && start == null) start = t
      if (!osc && start != null) {
        const len = t - start
        if (len >= T.OSC_MIN_S) { windows++; worst = Math.max(worst, len) }
        start = null
      }
    }
    if (windows < 2) return null
    return {
      id: 'M2', cls: 'mechanical', severity: 'notice', confidence: 0.4, t: null,
      evidence: { window_count: windows, longest_s: worst },
      ackable: true, experimental: true,
    }
  },
}

export const DETECTORS = [E1, E2, E3, E5, E6, R1, R2, R3, R4, B1, B2, B3, B4, M1, M2]

// ── composite scenarios (the deterministic "synthesis" layer) ──────────
// Rules combining detector outputs into named findings. Reviewed like
// copy, tested like code. E4 is the founding case's signature.

export function runScenarios(findings, ctx) {
  const has = id => findings.find(f => f.id === id)
  const out = []

  const e1 = has('E1'), e2 = has('E2'), e3 = has('E3')
  if (e2 && (e1 || e3)) {
    // Instant power interruption: ends mid-air + (unterminated log and/or
    // ADC death rattle), with vbat stable right up to the cutoff.
    const endT = ctx.stats.duration
    const tailV = rowSeries(ctx.rows, 'RxBt(V)', endT - T.STABLE_VBAT_WINDOW_S, endT)
      .v.filter(v => v > 1)
    const sigma = stddev(tailV)
    const stable = tailV.length >= 3 && sigma < T.STABLE_VBAT_SIGMA_V
    const amps = lastValid(ctx.rows, 'Curr(A)', T.STABLE_VBAT_WINDOW_S)
    const constituents = [e1, e2, e3].filter(Boolean).length + (stable ? 1 : 0)
    out.push({
      id: 'E4', cls: 'electrical',
      severity: 'critical',
      confidence: Math.min(0.95, 0.45 + constituents * 0.125),
      t: e2.t,
      evidence: {
        ends_midair: true,
        unterminated: !!e1,
        death_rattle: !!e3,
        vbat_stable_before: stable,
        vbat_sigma_v: sigma,
        amps_at_cutoff: amps ? amps.v : null,
        alt_agl_at_end: e2.evidence.alt_agl_at_end,
      },
      spark: e2.spark || null,
    })
  }
  return out
}
