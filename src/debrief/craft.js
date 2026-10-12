/**
 * Craft-type classifier — "quad vs plane", best-effort, anonymous.
 *
 * Returns one of 'quad' | 'wing' | 'unknown' from signals the parse path
 * already has: the flight-controller firmware family + board target (for
 * blackbox logs) and the flight dynamics (works for blackbox AND EdgeTX
 * radio CSVs, which share the canonical row schema — Alt(m), GSpd(kmh),
 * Roll(rad)). It reads NO position: altitude is only ever used relative
 * to the flight's own minimum, speed is groundspeed magnitude, and roll
 * is attitude magnitude. Nothing that leaves the machine carries a
 * coordinate — this feeds the anonymous `craft` usage counter only.
 *
 * Precedence (first match wins), chosen so a wrong guess stays rare:
 *   1. Board target says WING/GLIDER/PLANE          → wing   (explicit)
 *   2. Sustained inverted flight                     → quad   (a fixed
 *      wing flies upright; flips = multirotor/acro)
 *   3. Persistent hover                              → quad   (a plane
 *      stalls — it cannot loiter near-stationary aloft)
 *   4. Betaflight / EmuFlight                        → quad   (those
 *      firmwares are multirotor-only in practice; iNav flies both, so
 *      it gets no prior)
 *   5. Sustained forward speed, not hovering/inverted → wing
 *   6. otherwise                                     → unknown (honest:
 *      e.g. a slow or no-GPS log we can't confidently call)
 *
 * Validated against the two shipped sample flights: the freestyle quad
 * (invFrac≈0.07) → quad, the fixed-wing canyon run (p25≈79 km/h, never
 * inverted) → wing. Thresholds are deliberately forgiving — we'd rather
 * answer 'unknown' than mislabel — and tunable once real counts land.
 */

// Tunables. Distances in metres, speeds in km/h, angles in radians.
export const CRAFT_T = {
  AIRBORNE_AGL_M: 8, // above the flight's own min altitude = "aloft"
  MIN_AIRBORNE_SAMPLES: 20, // need a real flight, not a bench arm
  MIN_SPEED_SAMPLES: 10, // enough GPS speed points to trust fractions
  MIN_ATT_SAMPLES: 20, // enough attitude points to trust inversion
  HOVER_KMH: 7, // < this while aloft ≈ stationary (a plane would stall)
  HOVER_FRAC: 0.15, // ≥ 15% of aloft time near-stationary → persistent hover
  INVERT_RAD: 1.92, // |roll| > ~110° = inverted
  INVERT_FRAC: 0.03, // ≥ 3% of aloft attitude inverted → multirotor/acro
  WING_CRUISE_KMH: 35, // 25th-pctile aloft speed ≥ this → sustained flight
  WING_MAX_HOVER_FRAC: 0.12, // …and it isn't spending real time hovering
}

const WING_TARGET = /(WING|GLIDER|PLANE|FIXEDWING)/

/**
 * One pass over the rows: the 25th-percentile airborne groundspeed (a
 * robust "typical minimum" that ignores brief launch/landing slow spots),
 * how much aloft time is near-stationary (hover), and the inverted
 * fraction. Altitude is baselined to the flight's own minimum so it works
 * whether Alt(m) is AGL (blackbox) or MSL (some CSVs).
 */
export function flightDynamics(rows) {
  const out = { airborneN: 0, speedN: 0, attN: 0, hoverFrac: 0, invFrac: 0, p25Kmh: null }
  if (!Array.isArray(rows) || rows.length === 0) return out

  let minAlt = Infinity
  for (const r of rows) {
    const a = r['Alt(m)']
    if (typeof a === 'number' && Number.isFinite(a) && a < minAlt) minAlt = a
  }
  if (!Number.isFinite(minAlt)) return out // no altitude at all → can't tell aloft

  const speeds = []
  let hoverN = 0
  let attN = 0
  let invN = 0
  for (const r of rows) {
    const a = r['Alt(m)']
    if (!(typeof a === 'number' && Number.isFinite(a) && a - minAlt > CRAFT_T.AIRBORNE_AGL_M)) continue
    out.airborneN++

    const s = r['GSpd(kmh)']
    if (typeof s === 'number' && Number.isFinite(s) && s >= 0) {
      speeds.push(s)
      if (s < CRAFT_T.HOVER_KMH) hoverN++
    }
    const roll = r['Roll(rad)']
    if (typeof roll === 'number' && Number.isFinite(roll)) {
      attN++
      if (Math.abs(roll) > CRAFT_T.INVERT_RAD) invN++
    }
  }

  out.speedN = speeds.length
  out.attN = attN
  if (speeds.length >= CRAFT_T.MIN_SPEED_SAMPLES) {
    speeds.sort((x, y) => x - y)
    out.p25Kmh = speeds[Math.floor(speeds.length * 0.25)]
    out.hoverFrac = hoverN / speeds.length
  }
  if (attN >= CRAFT_T.MIN_ATT_SAMPLES) out.invFrac = invN / attN
  return out
}

/**
 * @param {object} ctx  the debrief context ({ rows, meta: { firmwareFamily, target } })
 * @returns {'quad'|'wing'|'unknown'}
 */
export function classifyCraft(ctx) {
  const fam = String(ctx?.meta?.firmwareFamily || '').toUpperCase()
  const target = String(ctx?.meta?.target || '').toUpperCase()

  // 1. Explicit board target (e.g. "SPEEDYBEEF405WING").
  if (WING_TARGET.test(target)) return 'wing'

  const dyn = flightDynamics(Array.isArray(ctx?.rows) ? ctx.rows : [])
  const enoughFlight = dyn.airborneN >= CRAFT_T.MIN_AIRBORNE_SAMPLES

  // 2–3. Hard multirotor signals: a fixed wing cannot sustain inverted
  //      flight, nor loiter near-stationary aloft.
  if (enoughFlight) {
    if (dyn.attN >= CRAFT_T.MIN_ATT_SAMPLES && dyn.invFrac >= CRAFT_T.INVERT_FRAC) return 'quad'
    if (dyn.speedN >= CRAFT_T.MIN_SPEED_SAMPLES && dyn.hoverFrac >= CRAFT_T.HOVER_FRAC) return 'quad'
  }

  // 4. Firmware prior. Betaflight/EmuFlight are multirotor firmwares in
  //    practice; iNav flies both, so it gets no prior.
  if (fam === 'BETAFLIGHT' || fam === 'EMUFLIGHT') return 'quad'

  // 5. Fixed-wing dynamics: sustained forward speed, upright, not hovering.
  if (
    enoughFlight &&
    dyn.speedN >= CRAFT_T.MIN_SPEED_SAMPLES &&
    dyn.p25Kmh != null &&
    dyn.p25Kmh >= CRAFT_T.WING_CRUISE_KMH &&
    dyn.hoverFrac <= CRAFT_T.WING_MAX_HOVER_FRAC &&
    dyn.invFrac < CRAFT_T.INVERT_FRAC
  ) {
    return 'wing'
  }

  return 'unknown'
}
