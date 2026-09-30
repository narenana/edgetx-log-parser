/**
 * Flight Debrief orchestrator — runs in the parse path (worker-safe).
 * Wraps every detector in its own try/catch: a thrown detector becomes
 * an {id, error_name} entry (reported to Sentry on the main thread with
 * exactly that shape — never the message, which could interpolate log
 * data), and the rest of the debrief still renders.
 */
import { DETECTORS, runScenarios, detectChemistry, SEVERITY_RANK } from './detectors.js'

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

  const clean = !findings.some(f => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.warning)

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

  return {
    v: 1,
    findings,
    coverage,
    clean,
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

/**
 * Firmware header string → allowlisted parts. "INAV 9.0.0 (a7932b92)
 * SPEEDYBEEF405WING" → family INAV, version 9.0.0, target token. The
 * commit hash (fingerprints personal forks) and anything else is
 * dropped — design §3.2.
 */
export function parseFirmware(str) {
  const out = { firmwareFamily: null, firmwareVersion: null, target: null }
  if (typeof str !== 'string') return out
  const fam = str.match(/^(INAV|Betaflight|Cleanflight|EmuFlight)\s+(\d+\.\d+\.\d+)/i)
  if (fam) {
    out.firmwareFamily = fam[1].toUpperCase() === 'CLEANFLIGHT' ? 'INAV' : fam[1]
    out.firmwareVersion = fam[2]
  }
  const tokens = str.trim().split(/\s+/)
  const last = tokens[tokens.length - 1]
  if (/^[A-Z0-9_]{4,30}$/.test(last) && !/^\d+\.\d+/.test(last)) out.target = last
  return out
}
