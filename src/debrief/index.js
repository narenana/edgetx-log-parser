/**
 * Flight Debrief orchestrator — runs in the parse path (worker-safe).
 * Wraps every detector in its own try/catch: a thrown detector becomes
 * an {id, error_name} entry (reported to Sentry on the main thread with
 * exactly that shape — never the message, which could interpolate log
 * data), and the rest of the debrief still renders.
 */
import { DETECTORS, runScenarios, detectChemistry, SEVERITY_RANK } from './detectors.js'
import { classifyCraft } from './craft.js'

export function runDebrief(ctx) {
  ctx.chem = ctx.chem || detectChemistry(ctx.rows)
  const findings = []
  const coverage = { ran: [], skipped: [] }
  const errors = []

  for (const d of DETECTORS) {
    let applicable = false
    try {
      applicable = d.requires(ctx)
    } catch (e) {
      errors.push({ id: d.id, error_name: e?.name || 'Error' })
      continue
    }
    if (!applicable) {
      coverage.skipped.push(d.id)
      continue
    }
    coverage.ran.push(d.id)
    try {
      const f = d.run(ctx)
      if (f) findings.push(f)
    } catch (e) {
      errors.push({ id: d.id, error_name: e?.name || 'Error' })
    }
  }

  try {
    findings.push(...runScenarios(findings, ctx))
  } catch (e) {
    errors.push({ id: 'scenarios', error_name: e?.name || 'Error' })
  }

  // L0 (always-on link profile) is redundant when an R2/R3 card is
  // already carrying the same chart — keep one copy only.
  if (findings.some(f => f.id === 'R2' || f.id === 'R3')) {
    const i = findings.findIndex(f => f.id === 'L0')
    if (i >= 0) findings.splice(i, 1)
  }

  const maxSev = findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity] || 0), 0)
  const clean = maxSev < SEVERITY_RANK.warning
  // Anonymous one-word verdict for the usage counter: 'critical' is the
  // "crash / in-air power or link loss" bucket (E4, R1/R2), 'warning' is
  // issues worth a look, 'clean' is a happy flight.
  const outcome = maxSev >= SEVERITY_RANK.critical ? 'critical' : clean ? 'clean' : 'warning'

  // Meta findings: the clean-flight verdict and the coverage note.
  if (clean && ctx.stats.duration >= 10) {
    findings.push({ id: 'X1', cls: 'meta', severity: 'info', confidence: 1, t: null, evidence: {} })
  }
  if (coverage.skipped.length > 0) {
    findings.push({
      id: 'X2', cls: 'meta', severity: 'info', confidence: 1, t: null,
      evidence: { skipped_count: coverage.skipped.length },
    })
  }

  findings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.confidence - a.confidence))

  // Local-only extras: last known position for the E2/E4 card. NEVER
  // copied into the AI payload (payload.js has no path to it — asserted
  // by the privacy property test).
  let lastFix = null
  if (findings.some(f => f.id === 'E2' || f.id === 'E4')) {
    const home = ctx.rows.find(r => r._lat != null)
    for (let i = ctx.rows.length - 1; i >= 0; i--) {
      if (ctx.rows[i]._lat != null) {
        const r = ctx.rows[i]
        let distKm = null, bearing = null
        if (home) {
          const dLat = (r._lat - home._lat) * 111.32
          const dLon = (r._lon - home._lon) * 111.32 * Math.cos(home._lat * Math.PI / 180)
          distKm = Math.hypot(dLat, dLon)
          bearing = ((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360
        }
        lastFix = { lat: r._lat, lon: r._lon, alt: r['Alt(m)'], t: r._tSec, rowIndex: r._i, distKm, bearing }
        break
      }
    }
  }

  // Best-effort craft type (quad | wing | unknown) for the anonymous usage
  // counter. Never let a classifier edge case break the debrief.
  let craft = 'unknown'
  try { craft = classifyCraft(ctx) } catch (e) { errors.push({ id: 'craft', error_name: e?.name || 'Error' }) }

  return {
    v: 1,
    findings,
    coverage,
    clean,
    outcome,
    craft,
    context: {
      source: ctx.source,
      firmwareFamily: ctx.meta.firmwareFamily || null,
      firmwareVersion: ctx.meta.firmwareVersion || null,
      target: ctx.meta.target || null,
      duration_s: ctx.stats.duration,
      cells: ctx.chem.cells,
      chemistry: ctx.chem.chemistry,
      has_gps: ctx.rows.some(r => r._lat != null),
    },
    local: { lastFix },
    errors,
  }
}

/**
 * Scan the raw log bytes' tail for the ASCII "End of log" event marker
 * and count trailing pad bytes. Runs where the buffer still exists
 * (worker / fallback paths, BEFORE transfer or free) — the decoder
 * wrappers expose no event stream, so this is E1's data source.
 */
export function scanLogTail(bytes) {
  const MARKER = 'End of log'
  const SCAN = Math.min(bytes.length, 256 * 1024)
  let endMarker = false
  const start = bytes.length - SCAN
  outer: for (let i = bytes.length - MARKER.length; i >= start; i--) {
    for (let j = 0; j < MARKER.length; j++) {
      if (bytes[i + j] !== MARKER.charCodeAt(j)) continue outer
    }
    endMarker = true
    break
  }
  let padBytes = 0
  const CAP = Math.min(bytes.length, 1024 * 1024)
  for (let i = bytes.length - 1; i >= bytes.length - CAP; i--) {
    const b = bytes[i]
    if (b === 0x00 || b === 0xff) padBytes++
    else break
  }
  return { endMarker, padBytes }
}

// Canonical spelling per family — payload.js's FW_FAMILIES allowlist is
// case-sensitive, so 'inav' / 'BETAFLIGHT' must not leak through.
const FAMILY_NORM = { inav: 'INAV', cleanflight: 'INAV', betaflight: 'Betaflight', emuflight: 'EmuFlight' }
const HEADER_FW = /^(INAV|Betaflight|Cleanflight|EmuFlight)\s+(\d+\.\d+\.\d+)/i
// The Rust decoder's FlightLog.firmware is its enum's Debug form, not the
// header string: "Inav(FirmwareVersion { major: 9, minor: 0, patch: 0 })".
const DEBUG_FW = /^(INAV|Betaflight|Cleanflight|EmuFlight)\s*\(\s*FirmwareVersion\s*\{\s*major:\s*(\d+),\s*minor:\s*(\d+),\s*patch:\s*(\d+)\s*\}\s*\)/i

/**
 * Firmware header string → allowlisted parts. "INAV 9.0.0 (a7932b92)
 * SPEEDYBEEF405WING" → family INAV, version 9.0.0, target token. The
 * commit hash (fingerprints personal forks) and anything else is
 * dropped — design §3.2. Also accepts the Rust decoder's Debug form
 * (family + version only; that form carries no target).
 */
export function parseFirmware(str) {
  const out = { firmwareFamily: null, firmwareVersion: null, target: null }
  if (typeof str !== 'string') return out
  const s = str.trim()
  const head = s.match(HEADER_FW)
  const dbg = head ? null : s.match(DEBUG_FW)
  if (head) {
    out.firmwareFamily = FAMILY_NORM[head[1].toLowerCase()]
    out.firmwareVersion = head[2]
  } else if (dbg) {
    out.firmwareFamily = FAMILY_NORM[dbg[1].toLowerCase()]
    out.firmwareVersion = `${dbg[2]}.${dbg[3]}.${dbg[4]}`
  }
  const tokens = s.split(/\s+/)
  const last = tokens[tokens.length - 1]
  if (/^[A-Z0-9_]{4,30}$/.test(last) && !/^\d+\.\d+/.test(last)) out.target = last
  return out
}

/**
 * Raw "H Firmware revision:" header value from the log's first 64 KB,
 * e.g. "INAV 9.0.0 (a7932b92) SPEEDYBEEF405WING", or null. Only ever fed
 * to parseFirmware (which drops the commit hash) — never stored. Runs
 * where the buffer still exists, like scanLogTail.
 */
export function scanFirmwareRevision(bytes) {
  if (!bytes || !bytes.length) return null
  const KEY = 'H Firmware revision:'
  const SCAN = Math.min(bytes.length, 64 * 1024)
  outer: for (let i = 0; i + KEY.length <= SCAN; i++) {
    for (let j = 0; j < KEY.length; j++) {
      if (bytes[i + j] !== KEY.charCodeAt(j)) continue outer
    }
    let s = ''
    const end = Math.min(bytes.length, i + KEY.length + 200)
    for (let k = i + KEY.length; k < end; k++) {
      const b = bytes[k]
      if (b < 0x20 || b > 0x7e) break // \r, \n, NUL or binary frame data
      s += String.fromCharCode(b)
    }
    return s.trim() || null
  }
  return null
}
