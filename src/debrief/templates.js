/**
 * Flight Debrief — deterministic explanations. The offline story, the
 * quota-exhausted fallback, and the guarantee that every finding is
 * meaningful without any model. Copy rules: pilot's language, no blame,
 * numbers inline, one concrete action per check item.
 */
const n = (v, d = 0, unit = '') => (v == null || isNaN(v) ? '—' : `${(+v).toFixed(d)}${unit}`)
const mmss = s => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`)

// Board-specific bench advice, keyed by the firmware target token.
// Data-only: extending this table is a copy change, not code (design §5).
export const BOARD_ADVICE = {
  SPEEDYBEEF405WING: 'This board is a stack — the PDB and FC mate through a board-to-board pin header. Press and wiggle that header with the bench power on; it is a known resets-under-G failure point.',
  MATEKF405WING: 'Check the solder joints where the battery lead meets the board — wing pushers concentrate vibration there.',
  MATEKF405TE: 'Check the solder joints where the battery lead meets the board.',
  SPEEDYBEEF405V3: 'Press-test the stack pins between the FC and 4-in-1 ESC with bench power on.',
  SPEEDYBEEF405V4: 'Press-test the stack pins between the FC and 4-in-1 ESC with bench power on.',
}

export const TEMPLATES = {
  E1: {
    title: 'Log ends without a footer',
    summary: f => f.evidence.dropped_main > 0
      ? `The recording stops mid-write (${f.evidence.dropped_main} corrupt tail frames removed) — the flight controller lost power before it could close the file.`
      : 'The recording stops without its "End of log" footer — the flight controller lost power before it could close the file.',
    checks: [],
  },
  E2: {
    title: 'Recording ends mid-air',
    summary: f => `The log stops at ${n(f.evidence.alt_agl_at_end, 0, ' m')} above launch${f.evidence.gspd_at_end ? ` doing ${n(f.evidence.gspd_at_end, 0, ' km/h')}` : ''} — there is no landing in the data.`,
    checks: ['The impact itself is not in this log — whatever follows the last frame happened unrecorded.'],
  },
  E3: {
    title: 'Electrical death rattle',
    summary: f => `The final telemetry writes are physically impossible (${f.evidence.sag_vbat_final_v != null ? `battery reading collapsed to ${n(f.evidence.sag_vbat_final_v, 1, ' V')}` : `${f.evidence.invalid_flag_count} corrupted status flags`}${f.evidence.temp_step_c ? `, a ${n(f.evidence.temp_step_c, 0, ' °C')} instant temperature jump` : ''}) — the classic signature of the 5 V rail collapsing while the processor wrote its last bytes.`,
    checks: [],
  },
  E4: {
    title: 'Sudden power interruption in flight',
    summary: f => `Power to the flight controller cut out instantly at ${n(f.evidence.alt_agl_at_end, 0, ' m')}: the battery read steady right up to the last sample (σ ${n(f.evidence.vbat_sigma_v, 2, ' V')}${f.evidence.amps_at_cutoff != null ? ` at only ${n(f.evidence.amps_at_cutoff, 1, ' A')}` : ''}), then everything stopped between two samples — faster than sag, faster than a short.`,
    checks: [
      'Check the battery pigtail solder joints under the heatshrink — the connector being fine says nothing about the joint behind it.',
      'Check inside the battery: a cracked cell-tab weld opens under G and re-closes at rest. Measure per-cell internal resistance and wiggle the pack under a wattmeter load.',
      'If the video transmitter died at the same instant, the break is upstream of both — main battery path, not a BEC.',
    ],
  },
  E5: {
    title: 'Power connection degrading',
    summary: f => `Supply impedance rose from ~${n(f.evidence.impedance_baseline_mohm, 0, ' mΩ')} to ~${n(f.evidence.impedance_late_mohm, 0, ' mΩ')} during the flight — a joint or connector is getting worse under load.`,
    checks: ['Inspect and reflow the battery lead solder joints; check the connector for heat discoloration.'],
  },
  E6: {
    title: 'In-flight brownout (recovered)',
    summary: f => `Battery voltage dipped to ${n(f.evidence.dip_v, 1, ' V')} and recovered within seconds — the flight continued, but that dip is deep enough to reboot accessories.`,
    checks: ['Check for a momentary short or a failing cell under punch loads; add a low-ESR capacitor on the battery rail if not present.'],
  },
  R1: {
    title: 'Failsafe engaged',
    summary: f => `The flight controller entered failsafe ${f.evidence.count > 1 ? `${f.evidence.count} times` : 'once'}${f.evidence.airborne ? ' while airborne' : ' on the ground'}.`,
    checks: ['Check the RC link budget for this flight path — antenna orientation, obstructions, distance.', 'Review the failsafe configuration: did the aircraft do what you expected it to do?'],
  },
  R2: {
    title: 'RC signal lost',
    summary: f => {
      const e = f.evidence
      let s = `The receiver reported no signal ${e.window_count > 1 ? `${e.window_count} times, longest` : 'for'} ${n(e.longest_s, 1, ' s')}.`
      if (e.pattern === 'range_boundary') {
        s += ` The losses sit at ~${n(e.loss_slant_m, 0, ' m')} slant range — right at the edge of this flight's envelope (max ${n(e.max_slant_m, 0, ' m')}). That's the link running out of legs, not a fault.`
      } else if (e.pattern === 'close_in') {
        s += ` The losses happened at only ~${n(e.loss_slant_m, 0, ' m')} slant range while this flight reached ${n(e.max_slant_m, 0, ' m')} — far inside the envelope. Distance is NOT the cause.`
      } else if (e.pattern === 'mixed') {
        s += ` Losses are scattered across ranges (median ~${n(e.loss_slant_m, 0, ' m')} of a ${n(e.max_slant_m, 0, ' m')} envelope) — no single distance boundary explains them.`
      }
      return s
    },
    checks: f => {
      const p = f.evidence?.pattern
      if (p === 'range_boundary') {
        return [
          'This is your practical range envelope at these settings — turn back earlier, raise TX power, or improve antennas before flying farther.',
          'Check the fade margin in the link-quality-vs-distance curve on this card: a steep cliff means little margin left.',
        ]
      }
      if (p === 'close_in') {
        return [
          'Distance ruled out — inspect the receiver antenna for damage, pinching, or placement flush against carbon.',
          'Check whether losses coincide with particular attitudes (banked turns shading the antenna) or a location on the field (interference source).',
          'Verify the TX module seat and antenna are secure.',
        ]
      }
      return ['Check antenna placement and condition on both ends.', 'Compare against the link-quality-vs-distance curve on this card.']
    },
  },
  R3: {
    title: 'Link quality degrading',
    summary: f => `${f.evidence.metric === 'lq' ? 'Link quality' : 'Signal strength'} in the final ${''}stretch ran well below the flight's normal (${n(f.evidence.late_median, 0)} vs ${n(f.evidence.flight_median, 0)})${f.evidence.distance_correlated ? ' — consistent with distance, not a fault' : ''}.`,
    checks: ['If this was not a long-range leg, check antennas and video-transmitter interference.'],
  },
  R4: {
    title: 'RC updates arriving slowly',
    summary: f => `Control updates dropped below a quarter of their normal rate ${f.evidence.window_count} time${f.evidence.window_count > 1 ? 's' : ''} (longest ${n(f.evidence.longest_s, 1, ' s')}).`,
    checks: ['Usually link congestion or a failing receiver — check for firmware mismatch between TX and RX.'],
  },
  B1: {
    title: 'Battery internal resistance high',
    summary: f => `Effective internal resistance measured ~${n(f.evidence.ir_per_cell_mohm, 0, ' mΩ')}/cell over ${f.evidence.punch_count} throttle punches — ${f.evidence.chemistry === 'liion' ? 'high even for Li-ion' : 'a tired pack for LiPo'}.`,
    checks: ['Verify per-cell IR on a charger; retire or demote the pack if one cell reads far above its siblings.'],
  },
  B2: {
    title: 'Battery low at landing',
    summary: f => f.severity === 'critical'
      ? `The flight ended deeply discharged at ${n(f.evidence.end_v_per_cell, 2, ' V')}/cell${f.evidence.chemistry === 'liion' ? ' (Li-ion)' : ''} — this level damages cells.`
      : `The flight ended at ${n(f.evidence.end_v_per_cell, 2, ' V')}/cell${f.evidence.chemistry === 'liion' ? ' (Li-ion)' : ''} — lower than the comfortable floor for this chemistry.`,
    checks: ['Land a little earlier or set a capacity alarm; storage-charge promptly after low landings.'],
  },
  B3: {
    title: 'Pack weaker than its sag model',
    summary: f => `The gap between raw and sag-compensated voltage grew ${n(f.evidence.gap_growth_per_cell_v, 2, ' V')}/cell over the flight — the battery sags more than the firmware expects.`,
    checks: ['Recalibrate the battery profile, or treat this pack as end-of-life for demanding flights.'],
  },
  B4: {
    title: 'Battery summary',
    summary: f => `${mmss(f.evidence.duration_s)} flight${f.evidence.mah_used ? `, ${n(f.evidence.mah_used, 0)} mAh used` : ''}${f.evidence.avg_current_a ? `, averaging ${n(f.evidence.avg_current_a, 1, ' A')}` : ''}${f.evidence.end_v_per_cell ? `, landed at ${n(f.evidence.end_v_per_cell, 2, ' V')}/cell` : ''}.`,
    checks: [],
  },
  M1: {
    title: 'Elevated vibration',
    summary: f => `Vibration ran ${''}well above this log's own baseline for ${n(f.evidence.high_vib_total_s, 0, ' s')} in total (experimental check).`,
    checks: ['Balance props; check motor bearings and mount soft-mounting.'],
  },
  M2: {
    title: 'Uncommanded oscillation',
    summary: f => `High vibration while the sticks were quiet, ${f.evidence.window_count} window${f.evidence.window_count > 1 ? 's' : ''} (experimental check).`,
    checks: ['Review filter/PID settings; look for a damaged prop or loose mount.'],
  },
  X1: {
    title: 'Clean flight',
    summary: () => 'Every check this log supports came back clean.',
    checks: [],
  },
  X2: {
    title: 'About coverage',
    summary: (f, ctx) => ctx?.source === 'edgetx-csv'
      ? 'Ran every check this log type supports. Radio logs carry link and battery telemetry; for electrical forensics (power-loss signatures, supply impedance), enable blackbox logging on the flight controller.'
      : `Some checks were skipped — this log doesn't carry the fields they need (${f.evidence.skipped_count} skipped).`,
    checks: [],
  },
}

/** Assemble the check-list for a finding, injecting board advice.
 *  `checks` may be a static array or a function of the finding
 *  (pattern-aware lists like R2's loss-geometry advice). */
export function checksFor(finding, context) {
  const raw = TEMPLATES[finding.id]?.checks
  const base = (typeof raw === 'function' ? raw(finding, context) : raw) || []
  if (finding.id === 'E4' && context?.target && BOARD_ADVICE[context.target]) {
    return [BOARD_ADVICE[context.target], ...base]
  }
  return base
}

/** Markdown serialization of the debrief — the copy-paste artifact for
 *  Discord / forum #help threads. Numbers, no coordinates, tool URL. */
export function debriefAsText(debrief, filenameLabel = 'flight') {
  const lines = [`**Flight Debrief — ${filenameLabel}**`]
  const c = debrief.context
  lines.push(`_${c.source === 'edgetx-csv' ? 'EdgeTX radio log' : `${c.firmwareFamily || 'blackbox'} log`}${c.target ? ` · ${c.target}` : ''} · ${mmss(c.duration_s)}${c.cells ? ` · ${c.cells}S` : ''}_`)
  lines.push('')
  for (const f of debrief.findings) {
    const t = TEMPLATES[f.id]
    if (!t) continue
    lines.push(`- **[${f.severity.toUpperCase()}] ${t.title}** — ${t.summary(f, c)}`)
    for (const chk of checksFor(f, c)) lines.push(`    - ${chk}`)
  }
  lines.push('')
  lines.push(`_Checks run: ${debrief.coverage.ran.length}${debrief.coverage.skipped.length ? ` (${debrief.coverage.skipped.length} not supported by this log type)` : ''} · generated locally by https://www.narenana.com/log-viewer/_`)
  return lines.join('\n')
}
