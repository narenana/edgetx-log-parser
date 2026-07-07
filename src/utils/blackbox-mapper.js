/**
 * Adapter: WASM-side `FlightLog` (typed-array buffers) → viewer's row
 * format (the same shape `parseEdgeTXLog` produces from CSV).
 *
 * Reads the parser output's flat `Float64Array` buffers using row-major
 * indexing (`frames[i * cols + j]`) so we never allocate per-cell
 * JsValues. Stays format-aware about iNAV unit conventions (deci-degrees
 * for attitude, centivolts for vbat, etc.) so downstream charts render
 * in human-readable SI units regardless of the source firmware.
 *
 * Exported as a separate module so both the main thread and any future
 * Web Worker can share the exact same mapping logic.
 */

export function mapToViewerLog(parsed, filename, diag = () => {}) {
  const tExtract = performance.now()
  const mainFieldNames = parsed.mainFieldNames
  const mainCols = parsed.mainCols
  const mainTimes = parsed.mainTimes
  const mainFrames = parsed.mainFrames
  const numMain = mainTimes.length
  diag(
    `extracted main arrays in ${(performance.now() - tExtract).toFixed(0)}ms ` +
      `(numMain=${numMain}, mainFrames.len=${mainFrames.length}, mainCols=${mainCols})`,
  )

  if (numMain === 0) {
    throw new Error('Blackbox file contains no main frames — log appears empty.')
  }

  const hasGps = parsed.hasGps
  const gpsCols = hasGps ? parsed.gpsCols : 0
  const gpsFieldNames = hasGps ? parsed.gpsFieldNames : []
  const gpsTimes = hasGps ? parsed.gpsTimes : null
  const gpsFrames = hasGps ? parsed.gpsFrames : null
  const numGps = gpsTimes ? gpsTimes.length : 0

  const idxOf = (names, target) => names.indexOf(target)
  const i_attRoll = idxOf(mainFieldNames, 'attitude[0]')
  const i_attPitch = idxOf(mainFieldNames, 'attitude[1]')
  const i_attYaw = idxOf(mainFieldNames, 'attitude[2]')
  const i_vbat = idxOf(mainFieldNames, 'vbat')
  const i_amp = idxOf(mainFieldNames, 'amperage')
  const i_baroAlt = idxOf(mainFieldNames, 'BaroAlt')
  const i_rssi = idxOf(mainFieldNames, 'rssi')
  const i_motor0 = idxOf(mainFieldNames, 'motor[0]')
  const i_navState = idxOf(mainFieldNames, 'navState')
  // Pilot input channels. Roll/pitch/yaw come from rcCommand[0..2]
  // (post-curve stick command, -500..+500 → -100..+100 %).
  //
  // Throttle is special: rcCommand[3] is NOT firmware-agnostic. Betaflight
  // logs it 1000..2000, but iNAV floors it at `minthrottle` (~1080..2000
  // on these SPEEDYBEE F405 WING logs), so dividing by the 1000..2000
  // scale made motor-idle read ~8 % instead of 0 % and shifted the whole
  // range up. rcData[3] is the RAW receiver throttle channel — 1000 idle
  // / 2000 full in BOTH firmwares, i.e. the pilot's actual stick position
  // — so we prefer it and only fall back to rcCommand[3] when rcData
  // wasn't logged. Verified against 8 real iNAV 8.0.1 DOLPHIN logs.
  const i_rcRoll  = idxOf(mainFieldNames, 'rcCommand[0]')
  const i_rcPitch = idxOf(mainFieldNames, 'rcCommand[1]')
  const i_rcYaw   = idxOf(mainFieldNames, 'rcCommand[2]')
  const i_rcDataThr = idxOf(mainFieldNames, 'rcData[3]')
  const i_rcThr   = i_rcDataThr >= 0 ? i_rcDataThr : idxOf(mainFieldNames, 'rcCommand[3]')

  const i_gpsLat = hasGps ? idxOf(gpsFieldNames, 'GPS_coord[0]') : -1
  const i_gpsLon = hasGps ? idxOf(gpsFieldNames, 'GPS_coord[1]') : -1
  const i_gpsAlt = hasGps ? idxOf(gpsFieldNames, 'GPS_altitude') : -1
  const i_gpsSpeed = hasGps ? idxOf(gpsFieldNames, 'GPS_speed') : -1
  const i_gpsHdg = hasGps ? idxOf(gpsFieldNames, 'GPS_ground_course') : -1
  const i_gpsFix = hasGps ? idxOf(gpsFieldNames, 'GPS_fixType') : -1

  const totalSec = (mainTimes[numMain - 1] - mainTimes[0]) / 1e6
  const epoch = Date.now() - totalSec * 1000

  // ── Altitude reference ──────────────────────────────────────────────
  // iNAV's GPS_altitude is MSL (e.g. ~920 m at our Bangalore field) but
  // pilots think in "altitude above launch", same as the baro reading.
  // Anchor to the first valid GPS fix and report all subsequent
  // altitudes as AGL (= MSL - home_msl). BaroAlt stays as-is — iNAV
  // already auto-zeros it at power-on, so it's already AGL.
  //
  // We also keep the absolute MSL value around in 'AltMSL(m)' for the
  // 3D globe (Cesium needs absolute terrain-relative heights to render
  // the path at the correct altitude over the actual landscape).
  // Inline index math here — `cell` is declared further down and using
  // it before the declaration would hit JavaScript's temporal dead zone
  // and throw a silent ReferenceError mid-mapping.
  let homeAltMsl = null
  if (gpsTimes && i_gpsAlt >= 0) {
    for (let g = 0; g < numGps; g++) {
      const base = g * gpsCols
      const fixOk = i_gpsFix < 0 || gpsFrames[base + i_gpsFix] >= 2
      if (fixOk) {
        homeAltMsl = gpsFrames[base + i_gpsAlt]
        break
      }
    }
  }

  let gpsPtr = 0
  const rows = new Array(numMain)
  let totalDistKm = 0
  let prevLat = null
  let prevLon = null

  const cell = (buf, row, col, cols) => buf[row * cols + col]

  const tLoop = performance.now()
  for (let i = 0; i < numMain; i++) {
    const tUs = mainTimes[i]
    const tSec = (tUs - mainTimes[0]) / 1e6

    if (gpsTimes) {
      while (gpsPtr + 1 < numGps && gpsTimes[gpsPtr + 1] <= tUs) gpsPtr++
    }

    const rollDeg = i_attRoll >= 0 ? cell(mainFrames, i, i_attRoll, mainCols) / 10 : null
    const pitchDeg = i_attPitch >= 0 ? cell(mainFrames, i, i_attPitch, mainCols) / 10 : null
    const yawDeg = i_attYaw >= 0 ? cell(mainFrames, i, i_attYaw, mainCols) / 10 : null

    const vbat = i_vbat >= 0 ? cell(mainFrames, i, i_vbat, mainCols) / 100 : null
    const amperage = i_amp >= 0 ? cell(mainFrames, i, i_amp, mainCols) / 100 : null

    // Normalized pilot input. Sticks are ±500 → ±100 %; throttle stick
    // (rcData[3], preferred) is 1000..2000 → 0..100 %. Null when the
    // channel was not logged (some iNAV configs strip rcCommand/rcData
    // to save flash).
    const stickRoll  = i_rcRoll  >= 0 ? cell(mainFrames, i, i_rcRoll,  mainCols) / 5 : null
    const stickPitch = i_rcPitch >= 0 ? cell(mainFrames, i, i_rcPitch, mainCols) / 5 : null
    const stickYaw   = i_rcYaw   >= 0 ? cell(mainFrames, i, i_rcYaw,   mainCols) / 5 : null
    const throttlePct = i_rcThr  >= 0
      ? Math.max(0, Math.min(100, (cell(mainFrames, i, i_rcThr, mainCols) - 1000) / 10))
      : null

    let lat = null,
      lon = null,
      gpsAltMslM = null,
      gpsSpeedKmh = null,
      gpsHdg = null,
      hasFix = false
    if (gpsTimes && gpsPtr < numGps) {
      const fixOk = i_gpsFix < 0 || cell(gpsFrames, gpsPtr, i_gpsFix, gpsCols) >= 2
      if (fixOk) {
        // Interpolate between gpsPtr and gpsPtr+1 using this main row's
        // timestamp. Without this, every ~7-15 consecutive main rows
        // share the same GPS frame's lat/lon (GPS arrives at 5-10 Hz,
        // main at 50-70 Hz post-stride) and the aircraft visually jerks
        // forward at each GPS boundary. With it, position evolves
        // smoothly between fixes.
        const hasNext = gpsPtr + 1 < numGps
        const tA = gpsTimes[gpsPtr]
        const tB = hasNext ? gpsTimes[gpsPtr + 1] : tA
        const span = tB - tA
        const t = hasNext && span > 0
          ? Math.max(0, Math.min(1, (tUs - tA) / span))
          : 0
        const baseA = gpsPtr * gpsCols
        const baseB = hasNext ? (gpsPtr + 1) * gpsCols : baseA
        const lerp = (a, b) => a + (b - a) * t

        if (i_gpsLat >= 0) {
          lat = lerp(gpsFrames[baseA + i_gpsLat], gpsFrames[baseB + i_gpsLat]) / 1e7
        }
        if (i_gpsLon >= 0) {
          lon = lerp(gpsFrames[baseA + i_gpsLon], gpsFrames[baseB + i_gpsLon]) / 1e7
        }
        // iNAV 8 stores GPS altitude in METRES MSL (validated against 14
        // real flight logs from a Bangalore field). Older iNAV used cm.
        if (i_gpsAlt >= 0) {
          gpsAltMslM = lerp(gpsFrames[baseA + i_gpsAlt], gpsFrames[baseB + i_gpsAlt])
        }
        if (i_gpsSpeed >= 0) {
          gpsSpeedKmh = lerp(gpsFrames[baseA + i_gpsSpeed], gpsFrames[baseB + i_gpsSpeed]) * 0.036
        }
        if (i_gpsHdg >= 0) {
          // Heading lerps through the shortest arc to avoid 359°→1°
          // shooting around the long way.
          const hA = gpsFrames[baseA + i_gpsHdg] / 10
          const hB = gpsFrames[baseB + i_gpsHdg] / 10
          const d = ((hB - hA + 540) % 360) - 180
          gpsHdg = (hA + d * t + 360) % 360
        }
        hasFix = lat !== null && lon !== null && !(lat === 0 && lon === 0)
      }
    }

    const baroAltM = i_baroAlt >= 0 ? cell(mainFrames, i, i_baroAlt, mainCols) / 100 : null
    // 'Alt(m)' is AGL — matches what pilots think of as altitude. Prefer
    // GPS-derived AGL (MSL - home_msl) when we have a fix, fall back to
    // baro (already AGL relative to power-on). 'AltMSL(m)' is the
    // absolute MSL kept for the 3D globe to render at correct terrain
    // height; null when GPS is absent.
    const gpsAltAglM =
      gpsAltMslM != null && homeAltMsl != null ? gpsAltMslM - homeAltMsl : null
    const altM = gpsAltAglM != null ? gpsAltAglM : baroAltM

    if (hasFix && prevLat !== null) {
      totalDistKm += haversineKm(prevLat, prevLon, lat, lon)
    }
    if (hasFix) {
      prevLat = lat
      prevLon = lon
    }

    const ts = epoch + tSec * 1000
    const dt = new Date(ts)
    rows[i] = {
      Date: dt.toISOString().slice(0, 10),
      Time: dt.toISOString().slice(11, 19),
      _i: i,
      _tSec: tSec,
      _lat: lat,
      _lon: lon,
      GPS: hasFix ? `${lat} ${lon}` : '',
      'Alt(m)': altM,                  // AGL (above launch)
      'AltMSL(m)': gpsAltMslM,         // absolute MSL — for 3D globe
      'GSpd(kmh)': gpsSpeedKmh,
      'VSpd(m/s)': null,
      'Hdg(°)': yawDeg ?? gpsHdg,
      'Ptch(rad)': pitchDeg != null ? (pitchDeg * Math.PI) / 180 : null,
      'Roll(rad)': rollDeg != null ? (rollDeg * Math.PI) / 180 : null,
      'Yaw(rad)': yawDeg != null ? (yawDeg * Math.PI) / 180 : null,
      // iNAV's `attitude.values.pitch` (MSP_ATTITUDE convention) is
      // POSITIVE when the nose is DOWN. We invert here so `_pitchDeg`
      // follows the aviation convention POSITIVE = nose-up (climb)
      // throughout the app — what the AI gauge, pitch chart, and any
      // future consumer naturally expect. The raw `Ptch(rad)` field
      // above is left as-is so anyone exporting back to an EdgeTX-style
      // CSV preserves the source convention.
      _pitchDeg: pitchDeg != null ? -pitchDeg : null,
      _rollDeg: rollDeg,
      _yawDeg: yawDeg,
      'RxBt(V)': vbat,
      'Curr(A)': amperage,
      'Capa(mAh)': 0,
      '1RSS(dB)': i_rssi >= 0 ? cell(mainFrames, i, i_rssi, mainCols) : null,
      '2RSS(dB)': null,
      'RQly(%)': null,
      FM: navStateLabel(i_navState >= 0 ? cell(mainFrames, i, i_navState, mainCols) : null),
      'motor[0]': i_motor0 >= 0 ? cell(mainFrames, i, i_motor0, mainCols) : null,
      _stickRoll:  stickRoll,
      _stickPitch: stickPitch,
      _stickYaw:   stickYaw,
      _throttle:   throttlePct,
    }
  }
  diag(`row loop done in ${(performance.now() - tLoop).toFixed(0)}ms`)

  const hasGPS = rows.some(r => r._lat !== null)
  const hasBattery = rows.some(r => r['RxBt(V)'] > 0)
  const hasCurrent = rows.some(r => r['Curr(A)'] > 0)
  const flightModes = [...new Set(rows.map(r => r.FM).filter(Boolean))]

  // Single-pass min/max instead of Math.max(...arr) — avoids spread on
  // 8000+ element arrays which can stack-overflow on long flights.
  let maxAlt = -Infinity, minAlt = Infinity
  let maxSpeed = -Infinity
  let minVoltage = Infinity
  let maxCurrent = 0
  let voltageSeen = false
  let currentSeen = false
  for (const r of rows) {
    const a = r['Alt(m)']
    if (a != null && !isNaN(a)) {
      if (a > maxAlt) maxAlt = a
      if (a < minAlt) minAlt = a
    }
    const s = r['GSpd(kmh)']
    if (s != null && !isNaN(s) && s > maxSpeed) maxSpeed = s
    const v = r['RxBt(V)']
    if (v > 0) {
      voltageSeen = true
      if (v < minVoltage) minVoltage = v
    }
    const c = r['Curr(A)']
    if (c > 0) {
      currentSeen = true
      if (c > maxCurrent) maxCurrent = c
    }
  }
  if (maxAlt === -Infinity) maxAlt = 0
  if (minAlt === Infinity) minAlt = 0
  if (maxSpeed === -Infinity) maxSpeed = 0

  let maxDistFromHomeKm = 0
  if (hasGPS) {
    const home = rows.find(r => r._lat !== null)
    for (const r of rows) {
      if (r._lat == null) continue
      const d = haversineKm(home._lat, home._lon, r._lat, r._lon)
      if (d > maxDistFromHomeKm) maxDistFromHomeKm = d
    }
  }

  const modeCounts = {}
  let totalModed = 0
  for (const r of rows) {
    if (r.FM) {
      modeCounts[r.FM] = (modeCounts[r.FM] || 0) + 1
      totalModed++
    }
  }
  let dominantMode = null
  let dominantPct = 0
  for (const [mode, count] of Object.entries(modeCounts)) {
    const pct = count / totalModed
    if (pct > dominantPct) {
      dominantMode = mode
      dominantPct = pct
    }
  }

  const stats = {
    duration: rows.length > 1 ? rows[rows.length - 1]._tSec : 0,
    maxAlt,
    minAlt,
    maxSpeed,
    maxClimb: 0,
    maxSink: 0,
    distanceKm: totalDistKm,
    maxDistFromHomeKm,
    minVoltage: voltageSeen ? minVoltage : null,
    maxCapacity: null,
    maxCurrent: currentSeen ? maxCurrent : 0,
    minRSSI: null,
    dominantMode,
    dominantPct,
  }

  return {
    filename,
    rows,
    flightModes,
    hasGPS,
    hasBattery,
    hasCurrent,
    stats,
    events: [],
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// iNAV's `NAV_PERSISTENT_ID_*` table from src/main/navigation/navigation_private.h.
// These IDs are explicitly stable across iNAV firmware versions — the
// underlying `navigationFSMState_t` enum is allowed to renumber, but
// blackbox writes the persistent ID so external tools have a fixed
// reference. Each major mode owns 1–7 sequential IDs (one per state-
// machine slot: INITIALIZE / IN_PROGRESS / ADJUSTING / FINISHING / …);
// we collapse them to the user-facing mode name.
//
// Important: ID 1 (`NAV_PERSISTENT_ID_IDLE`) means the navigation state
// machine is OFF — the pilot is flying with sticks (ACRO / ANGLE /
// HORIZON / MANUAL). Without the `flightModeFlags` slow-frame field
// (not always logged) we can't tell which manual mode was active, so
// we label these rows "MANUAL". The previous version of this table
// indexed by the live `navigationFSMState_t` enum — which made id 1
// resolve to "ALT_HOLD" instead of IDLE, so any flight where the FSM
// stayed idle (i.e. anyone flying without nav-mode autopilot engaged)
// reported ALT_HOLD as the dominant mode.
const NAV_PERSISTENT_LABELS = {
  0: '',                                             // UNDEFINED
  1: 'MANUAL',                                       // IDLE — sticks-only flying
  2: 'ALT_HOLD', 3: 'ALT_HOLD',
  // 4, 5: unused (was POSHOLD_2D — removed from iNAV)
  6: 'POS_HOLD', 7: 'POS_HOLD',
  8: 'RTH', 9: 'RTH', 10: 'RTH', 11: 'RTH', 12: 'RTH', 13: 'RTH', 14: 'RTH',
  15: 'WP', 16: 'WP', 17: 'WP', 18: 'WP', 19: 'WP', 20: 'WP', 21: 'WP',
  22: 'EMERG_LANDING', 23: 'EMERG_LANDING', 24: 'EMERG_LANDING',
  25: 'LAUNCH', 26: 'LAUNCH', 28: 'LAUNCH',          // 27 unused
  29: 'COURSE_HOLD', 30: 'COURSE_HOLD', 31: 'COURSE_HOLD',
  32: 'CRUISE', 33: 'CRUISE', 34: 'CRUISE',
  35: 'WP',                                          // WAYPOINT_HOLD_TIME
  36: 'RTH',                                         // RTH_LOITER_ABOVE_HOME
  // 37: unused (was WP_HOVER_ABOVE_HOME)
  38: 'RTH',                                         // RTH_TRACKBACK
  39: 'MIXER_TRANSITION', 40: 'MIXER_TRANSITION', 41: 'MIXER_TRANSITION',
  42: 'FW_LANDING', 43: 'FW_LANDING', 44: 'FW_LANDING', 45: 'FW_LANDING',
  46: 'FW_LANDING', 47: 'FW_LANDING', 48: 'FW_LANDING',
  49: 'SEND_TO', 50: 'SEND_TO', 51: 'SEND_TO',
}
function navStateLabel(v) {
  if (v == null) return ''
  const i = Math.round(v)
  return NAV_PERSISTENT_LABELS[i] ?? `FM${i}`
}
