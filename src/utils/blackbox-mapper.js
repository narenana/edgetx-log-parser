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

    let lat = null,
      lon = null,
      gpsAltMslM = null,
      gpsSpeedKmh = null,
      gpsHdg = null,
      hasFix = false
    if (gpsTimes && gpsPtr < numGps) {
      const fixOk = i_gpsFix < 0 || cell(gpsFrames, gpsPtr, i_gpsFix, gpsCols) >= 2
      if (fixOk) {
        if (i_gpsLat >= 0) lat = cell(gpsFrames, gpsPtr, i_gpsLat, gpsCols) / 1e7
        if (i_gpsLon >= 0) lon = cell(gpsFrames, gpsPtr, i_gpsLon, gpsCols) / 1e7
        // iNAV 8 stores GPS altitude in METRES MSL (validated against 14
        // real flight logs from a Bangalore field). Older iNAV used cm.
        if (i_gpsAlt >= 0) gpsAltMslM = cell(gpsFrames, gpsPtr, i_gpsAlt, gpsCols)
        if (i_gpsSpeed >= 0) gpsSpeedKmh = cell(gpsFrames, gpsPtr, i_gpsSpeed, gpsCols) * 0.036
        if (i_gpsHdg >= 0) gpsHdg = cell(gpsFrames, gpsPtr, i_gpsHdg, gpsCols) / 10
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
      _pitchDeg: pitchDeg,
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

const NAV_STATES = [
  'IDLE',
  'ALT_HOLD',
  'POS_HOLD',
  'RTH',
  'WP',
  'EMERG_LANDING',
  'LAUNCH',
  'CRUISE',
  'COURSE_HOLD',
  'MIXER_TRANSITION',
]
function navStateLabel(v) {
  if (v == null) return ''
  const i = Math.round(v)
  return NAV_STATES[i] != null ? NAV_STATES[i] : `FM${i}`
}
