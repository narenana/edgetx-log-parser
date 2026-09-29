/**
 * Flight Debrief — AI payload builder + validator.
 *
 * The findings JSON is the ONLY thing that ever leaves the browser
 * (D2, on explicit consent). This module is the privacy boundary:
 * closed-vocabulary strings, per-detector evidence-key allowlists,
 * quantized numbers, hard caps. The validator implements the same
 * rules the Worker will enforce server-side (shared source of truth —
 * docs/FLIGHT-DEBRIEF-DESIGN.md §3–4).
 */
import { T } from './thresholds.js'

export const FINDING_IDS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'R1', 'R2', 'R3', 'R4', 'B1', 'B2', 'B3', 'B4', 'M1', 'M2', 'X1', 'X2']
export const CLASSES = ['electrical', 'link', 'battery', 'mechanical', 'meta']
export const SEVERITIES = ['info', 'notice', 'warning', 'critical']

// Per-detector evidence-key allowlist — generated from the catalog
// (design §4). An unknown key is dropped client-side and REJECTED
// server-side.
export const EVIDENCE_KEYS = {
  E1: ['end_marker', 'dropped_main', 'dropped_gps', 'pad_bytes'],
  E2: ['alt_agl_at_end', 'gspd_at_end'],
  E3: ['sag_vbat_final_v', 'temp_step_c', 'invalid_flag_count'],
  E4: ['ends_midair', 'unterminated', 'death_rattle', 'vbat_stable_before', 'vbat_sigma_v', 'amps_at_cutoff', 'alt_agl_at_end'],
  E5: ['impedance_baseline_mohm', 'impedance_late_mohm'],
  E6: ['dip_v', 'recovered_v', 'cells'],
  R1: ['count', 'first_phase', 'airborne'],
  R2: ['window_count', 'longest_s'],
  R3: ['metric', 'flight_median', 'late_median', 'distance_correlated'],
  R4: ['window_count', 'longest_s', 'median_rate'],
  B1: ['ir_per_cell_mohm', 'punch_count', 'chemistry'],
  B2: ['end_v_per_cell', 'cells', 'chemistry'],
  B3: ['gap_growth_per_cell_v'],
  B4: ['duration_s', 'mah_used', 'avg_current_a', 'end_v_per_cell', 'cells'],
  M1: ['high_vib_total_s', 'longest_s', 'vib_median'],
  M2: ['window_count', 'longest_s'],
  X1: [], X2: ['skipped_count'],
}
// The few string values allowed in evidence, as closed enums.
const EVIDENCE_ENUMS = {
  metric: ['lq', 'rssi'],
  chemistry: ['lipo', 'liion', 'unknown'],
}

const FW_FAMILIES = ['INAV', 'Betaflight', 'EmuFlight']
const MAX_FINDINGS = 24

const q = (v, step) => (typeof v === 'number' && isFinite(v) ? Number((Math.round(v / step) * step).toFixed(4)) : null)
const KEY_QUANT = {
  alt_agl_at_end: T.Q.alt_m,
  gspd_at_end: 1,
  sag_vbat_final_v: T.Q.volt_v, dip_v: T.Q.volt_v, recovered_v: T.Q.volt_v,
  vbat_sigma_v: 0.01, end_v_per_cell: 0.05, gap_growth_per_cell_v: 0.05,
  amps_at_cutoff: T.Q.curr_a, avg_current_a: T.Q.curr_a,
  impedance_baseline_mohm: T.Q.mohm, impedance_late_mohm: T.Q.mohm, ir_per_cell_mohm: T.Q.mohm,
  temp_step_c: T.Q.temp_c,
  duration_s: T.Q.t_s, longest_s: T.Q.t_s, high_vib_total_s: T.Q.t_s,
  flight_median: 1, late_median: 1, median_rate: 1, vib_median: 1,
  mah_used: 10,
}

/** Build the outbound payload from a runDebrief() result. Strips spark
 *  slices and everything under `local`; quantizes evidence per key. */
export function buildPayload(debrief) {
  const c = debrief.context
  const context = {
    source: c.source === 'edgetx-csv' ? 'edgetx-csv' : 'blackbox',
    fw: FW_FAMILIES.includes(c.firmwareFamily) && /^\d+\.\d+\.\d+$/.test(c.firmwareVersion || '')
      ? `${c.firmwareFamily} ${c.firmwareVersion}` : null,
    target: /^[A-Z0-9_]{1,30}$/.test(c.target || '') ? c.target : null,
    duration_s: q(c.duration_s, T.Q.t_s),
    cells: Number.isInteger(c.cells) && c.cells >= 1 && c.cells <= 14 ? c.cells : null,
    has_gps: !!c.has_gps,
  }
  const findings = debrief.findings.slice(0, MAX_FINDINGS).map(f => {
    const keys = EVIDENCE_KEYS[f.id] || []
    const evidence = {}
    for (const k of keys) {
      const v = f.evidence?.[k]
      if (v == null) continue
      if (typeof v === 'boolean') evidence[k] = v
      else if (typeof v === 'number' && isFinite(v)) evidence[k] = KEY_QUANT[k] ? q(v, KEY_QUANT[k]) : Math.round(v)
      else if (typeof v === 'string' && (EVIDENCE_ENUMS[k] || []).includes(v)) evidence[k] = v
    }
    return {
      id: f.id,
      class: f.cls,
      severity: f.severity,
      confidence: Math.round(f.confidence * 20) / 20,
      t: Array.isArray(f.t) ? [q(f.t[0], T.Q.t_s), q(f.t[1], T.Q.t_s)] : null,
      evidence,
    }
  })
  return { v: 1, context, findings, clean: !!debrief.clean }
}

/** Validate a payload against the schema rules. Returns [] when valid.
 *  Mirrors the Worker-side check (D2) — hostile-but-valid fixtures in
 *  the test plan run through this exact function. */
export function validatePayload(p) {
  const errs = []
  const push = m => errs.push(m)
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['payload: not an object']
  const topKeys = ['v', 'context', 'findings', 'clean']
  for (const k of Object.keys(p)) if (!topKeys.includes(k)) push(`unknown top-level key: ${k}`)
  if (p.v !== 1) push('v: must be 1')
  if (typeof p.clean !== 'boolean') push('clean: must be boolean')

  const c = p.context
  if (!c || typeof c !== 'object') push('context: missing')
  else {
    const ck = ['source', 'fw', 'target', 'duration_s', 'cells', 'has_gps']
    for (const k of Object.keys(c)) if (!ck.includes(k)) push(`context: unknown key ${k}`)
    if (!['blackbox', 'edgetx-csv'].includes(c.source)) push('context.source: bad enum')
    if (c.fw != null && !/^(INAV|Betaflight|EmuFlight) \d+\.\d+\.\d+$/.test(c.fw)) push('context.fw: bad format')
    if (c.target != null && !/^[A-Z0-9_]{1,30}$/.test(c.target)) push('context.target: bad format')
    if (c.duration_s != null && !(Number.isFinite(c.duration_s) && c.duration_s >= 0 && c.duration_s < 86400)) push('context.duration_s: out of range')
  }

  if (!Array.isArray(p.findings)) push('findings: not an array')
  else {
    if (p.findings.length > MAX_FINDINGS) push(`findings: more than ${MAX_FINDINGS}`)
    const seen = new Set()
    for (const f of p.findings) {
      if (!f || typeof f !== 'object') { push('finding: not an object'); continue }
      const fk = ['id', 'class', 'severity', 'confidence', 't', 'evidence']
      for (const k of Object.keys(f)) if (!fk.includes(k)) push(`finding ${f.id}: unknown key ${k}`)
      if (!FINDING_IDS.includes(f.id)) { push(`finding: unknown id ${f.id}`); continue }
      if (seen.has(f.id) && f.id !== 'B2') push(`finding: duplicate id ${f.id}`)
      seen.add(f.id)
      if (!CLASSES.includes(f.class)) push(`finding ${f.id}: bad class`)
      if (!SEVERITIES.includes(f.severity)) push(`finding ${f.id}: bad severity`)
      if (!(f.confidence >= 0 && f.confidence <= 1)) push(`finding ${f.id}: bad confidence`)
      if (f.t != null && !(Array.isArray(f.t) && f.t.length === 2 && f.t.every(x => Number.isFinite(x) && x >= 0 && Number.isInteger(x)))) push(`finding ${f.id}: bad t`)
      const allowed = EVIDENCE_KEYS[f.id] || []
      if (f.evidence && typeof f.evidence === 'object') {
        for (const [k, v] of Object.entries(f.evidence)) {
          if (!allowed.includes(k)) push(`finding ${f.id}: evidence key ${k} not allowed`)
          else if (typeof v === 'string' && !(EVIDENCE_ENUMS[k] || []).includes(v)) push(`finding ${f.id}: evidence ${k} string not in enum`)
          else if (!['number', 'boolean', 'string'].includes(typeof v)) push(`finding ${f.id}: evidence ${k} bad type`)
          else if (typeof v === 'number' && !Number.isFinite(v)) push(`finding ${f.id}: evidence ${k} not finite`)
        }
      } else if (f.evidence != null) push(`finding ${f.id}: evidence not an object`)
    }
  }
  if (errs.length === 0 && JSON.stringify(p).length > 8192) push('payload: exceeds 8KB')
  return errs
}
