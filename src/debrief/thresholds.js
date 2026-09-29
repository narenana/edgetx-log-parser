/**
 * Flight Debrief — every tunable in one place, each with its rationale.
 * These are constants, not magic numbers scattered through detectors:
 * threshold changes are reviewed here like copy. All calibrated against
 * the founding fixture set (four real SPEEDYBEE F405 WING / iNAV logs +
 * one EdgeTX ELRS wing CSV, gitignored in test-logs/) — see
 * docs/FLIGHT-DEBRIEF-TESTPLAN.md §1.
 */
export const T = {
  // ── flight shape ──────────────────────────────────────────────────
  // Below this the log is an arm-blip, not a flight — E2/E4 and the
  // "clean flight" verdict are meaningless (fixture LOG00057: 1.5 s).
  MIN_FLIGHT_S: 10,
  // E2: "ends mid-air" = last altitude above this AGL. 20 m clears baro
  // drift and hand-carry noise; a real landing reads < 5 m.
  MIDAIR_END_ALT_M: 20,
  // E2 landing signature window: alt must stay high through the final
  // seconds, not just at the last sample (guards a landing whose last
  // row happens to glitch).
  MIDAIR_WINDOW_S: 5,

  // ── electrical ────────────────────────────────────────────────────
  // E3: sag-compensated vbat below this per-cell (V) in the final slow
  // frames = ADC collapse, not a real battery reading (fixture: 0.34 V
  // on a healthy 15.5 V pack).
  RATTLE_VBAT_PER_CELL: 0.5,
  // E3: an instant temperature step this large (°C) between consecutive
  // slow frames is physically impossible (dies read 60+ °C, garbage ~3).
  RATTLE_TEMP_STEP_C: 20,
  // E4: vbat is "rock steady" when its stddev over the final window is
  // below this (V). The Suchit signature: 0.02 V σ at 1.3 A right up to
  // the cutoff — no sag precursor.
  STABLE_VBAT_SIGMA_V: 0.05,
  STABLE_VBAT_WINDOW_S: 5,
  // E5: degrading connection = late-flight impedance median above
  // baseline by BOTH this factor and this absolute floor (mΩ). The
  // floor guards tiny relative moves on already-low readings; the
  // cold-pack settle (166→116 mΩ, DOWNWARD, fixture LOG00060) must not
  // fire — only rises count.
  IMPEDANCE_RISE_FACTOR: 1.5,
  IMPEDANCE_RISE_FLOOR_MOHM: 40,
  // E6: an in-flight brownout dip must recover within this many seconds
  // to count as "recovered" (longer = it's just sag, B-class).
  BROWNOUT_PER_CELL_V: 3.0,
  BROWNOUT_RECOVER_S: 2,
  BROWNOUT_RECOVER_PER_CELL_V: 3.4,

  // ── RX / link ─────────────────────────────────────────────────────
  // R2: consecutive rx-lost time that counts as a loss window (s).
  RX_LOSS_MIN_S: 0.2,
  // R3: link-degradation = final-window median down this fraction from
  // the flight median. The CSV fixture's landing pass (RSSI −46→−86 dB
  // with RQly steady ~98 %) must NOT fire R2 and only rates a notice.
  LINK_DROP_FRACTION: 0.4,
  LINK_WINDOW_S: 30,
  LINK_MIN_FLIGHT_S: 30,
  // R4: RC update-rate collapse threshold (fraction of median) and
  // minimum duration (s).
  RC_RATE_FRACTION: 0.25,
  RC_RATE_MIN_S: 0.5,

  // ── battery ───────────────────────────────────────────────────────
  // B1: effective internal resistance per cell (mΩ) from throttle
  // punches. LiPo: a healthy warm pack sits 15–30; season-old 40–60.
  // Li-ion (18650/21700 long-range packs): 20–40+ is NORMAL — separate
  // threshold or every Li-ion wing gets a false warning per flight.
  IR_WARN_MOHM: { lipo: 45, liion: 80 },
  IR_MIN_PUNCHES: 3,
  IR_PUNCH_MIN_DELTA_A: 5,
  // B2: end-of-flight resting voltage per cell (V). Li-ion lands at
  // 3.0–3.3 V/cell by design.
  DISCHARGE: {
    lipo:  { info: 3.6, warning: 3.5, critical: 3.3 },
    liion: { info: 3.0, warning: 2.9, critical: 2.8 },
  },
  // B3: sag-model divergence — late-minus-early gap growth per cell (V).
  SAG_DIVERGENCE_PER_CELL_V: 0.25,
  // Chemistry detection: per-cell voltage at log start. ≥ this = LiPo
  // off the charger; ≤ LIION_FULL_MAX = Li-ion. Between = unknown (use
  // LiPo thresholds, flag low confidence).
  LIPO_FULL_MIN: 4.13,
  LIION_FULL_MAX: 4.1,

  // ── mechanical (experimental) ─────────────────────────────────────
  // M1/M2 thresholds are RELATIVE to the log's own quiet baseline until
  // we have enough fixtures for absolute bands. M1: sustained accVib
  // above this multiple of the flight median. M2: same, gated on quiet
  // sticks (below stick-rate threshold, %/s).
  VIB_FACTOR: 3,
  VIB_MIN_S: 5,
  OSC_FACTOR: 2,
  OSC_MIN_S: 2,
  OSC_STICK_QUIET_PCT_S: 40,

  // ── payload quantization (privacy — design §3.3) ──────────────────
  Q: { alt_m: 10, volt_v: 0.1, curr_a: 0.5, t_s: 1, mohm: 5, pct: 1, temp_c: 1, dist_m: 50 },

  // Sparkline slices attached to findings for the local cards: max
  // points per slice (bounded payload-free local data).
  SPARK_MAX_POINTS: 160,
  SPARK_CONTEXT_S: 5,
}
