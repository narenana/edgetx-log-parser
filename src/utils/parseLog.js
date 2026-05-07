import Papa from 'papaparse'

const R2D = 180 / Math.PI

function normHdg(h) {
  if (h == null || h === '') return null
  return ((h % 360) + 360) % 360
}

function parseGPS(str) {
  if (!str || typeof str !== 'string') return [null, null]
  const parts = str.trim().split(/\s+/)
  if (parts.length < 2) return [null, null]
  const lat = parseFloat(parts[0])
  const lon = parseFloat(parts[1])
  return isNaN(lat) || isNaN(lon) ? [null, null] : [lat, lon]
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * (Math.PI / 180)
  const dLon = (lon2 - lon1) * (Math.PI / 180)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function parseEdgeTXLog(text, filename) {
  const parsed = Papa.parse(text.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  })

  if (!parsed.data.length) {
    throw new Error('No data rows found in file')
  }

  const raw = parsed.data
  const t0 = new Date(`${raw[0]['Date']}T${raw[0]['Time']}`).getTime()

  let totalDistKm = 0
  let prevLat = null
  let prevLon = null

  const rows = raw.map((r, i) => {
    const ts = new Date(`${r['Date']}T${r['Time']}`).getTime()
    const [lat, lon] = parseGPS(r['GPS'])

    if (lat !== null && prevLat !== null) {
      totalDistKm += haversineKm(prevLat, prevLon, lat, lon)
    }
    if (lat !== null) {
      prevLat = lat
      prevLon = lon
    }

    // ── Pilot inputs from EdgeTX channel columns ───────────────────────
    // EdgeTX logs four common stick channels at the post-mixer outputs:
    //   Ail (aileron / roll), Ele (elevator / pitch),
    //   Thr (throttle),       Rud (rudder / yaw)
    // Range is -1024..+1024 (centered, with throttle stick-low = -1024).
    // Normalize to -100..+100 for sticks and 0..100 for throttle so the
    // viewer's pilot-input UI is firmware-agnostic (matches the same
    // _stick* fields the blackbox parser produces from rcCommand[0..3]).
    //
    // Some EdgeTX setups use longer column names (Aileron / Elevator /
    // etc) — fall back gracefully so logs from non-default templates
    // still drive the controls.
    const ail = r['Ail'] ?? r['Aileron']  ?? null
    const ele = r['Ele'] ?? r['Elevator'] ?? null
    const thr = r['Thr'] ?? r['Throttle'] ?? null
    const rud = r['Rud'] ?? r['Rudder']   ?? null
    const stickPct = v => (v == null ? null : (v / 1024) * 100)
    // Throttle: stick-low (-1024) → 0%, stick-high (+1024) → 100%.
    const thrPct = thr == null ? null : ((thr + 1024) / 2048) * 100

    return {
      ...r,
      _i: i,
      _tSec: (ts - t0) / 1000,
      _lat: lat,
      _lon: lon,
      _pitchDeg: r['Ptch(rad)'] != null ? r['Ptch(rad)'] * R2D : null,
      _rollDeg: r['Roll(rad)'] != null ? r['Roll(rad)'] * R2D : null,
      _yawDeg: r['Yaw(rad)'] != null ? r['Yaw(rad)'] * R2D : null,
      'Hdg(°)': normHdg(r['Hdg(°)']),
      _stickRoll:  stickPct(ail),
      _stickPitch: stickPct(ele),
      _stickYaw:   stickPct(rud),
      _throttle:   thrPct,
    }
  })

  const hasGPS = rows.some(r => r._lat !== null)
  const hasBattery = rows.some(r => r['RxBt(V)'] > 0)
  const hasCurrent = rows.some(r => r['Curr(A)'] > 0)
  const flightModes = [...new Set(rows.map(r => r['FM']).filter(Boolean))]

  const altVals = rows.map(r => r['Alt(m)']).filter(v => v != null && !isNaN(v))
  const spdVals = rows.map(r => r['GSpd(kmh)']).filter(v => v != null && !isNaN(v))
  const vspVals = rows.map(r => r['VSpd(m/s)']).filter(v => v != null && !isNaN(v))
  const voltVals = rows.filter(r => r['RxBt(V)'] > 0).map(r => r['RxBt(V)'])
  const capVals = rows.map(r => r['Capa(mAh)'] || 0)

  // ── Extra metrics for the pre-flight summary modal ────────────────────────
  // One pass over rows: peak distance from launch (the "how far did you
  // get" number a pilot actually cares about), peak current, worst RSSI,
  // and dominant flight mode by row count. Kept separate from the existing
  // stats block so the diff stays reviewable; fold into the main loop later
  // when we move parsing to a Web Worker.
  let maxDistFromHomeKm = 0
  let maxCurrent = 0
  let minRSSI = null
  let homeLat = null
  let homeLon = null
  const modeCounts = {}
  let totalModed = 0

  for (const r of rows) {
    if (r._lat != null) {
      if (homeLat == null) {
        homeLat = r._lat
        homeLon = r._lon
      } else {
        const d = haversineKm(homeLat, homeLon, r._lat, r._lon)
        if (d > maxDistFromHomeKm) maxDistFromHomeKm = d
      }
    }
    const cu = r['Curr(A)']
    if (typeof cu === 'number' && !isNaN(cu) && cu > maxCurrent) maxCurrent = cu
    const rs = r['1RSS(dB)']
    if (typeof rs === 'number' && !isNaN(rs)) {
      if (minRSSI == null || rs < minRSSI) minRSSI = rs
    }
    if (r['FM']) {
      modeCounts[r['FM']] = (modeCounts[r['FM']] || 0) + 1
      totalModed++
    }
  }

  let dominantMode = null
  let dominantPct = 0
  if (totalModed > 0) {
    for (const [mode, count] of Object.entries(modeCounts)) {
      const pct = count / totalModed
      if (pct > dominantPct) {
        dominantMode = mode
        dominantPct = pct
      }
    }
  }

  const stats = {
    duration: rows.length > 1 ? rows[rows.length - 1]._tSec : 0,
    maxAlt: altVals.length ? Math.max(...altVals) : 0,
    minAlt: altVals.length ? Math.min(...altVals) : 0,
    maxSpeed: spdVals.length ? Math.max(...spdVals) : 0,
    maxClimb: vspVals.length ? Math.max(...vspVals) : 0,
    maxSink: vspVals.length ? Math.min(...vspVals) : 0,
    distanceKm: totalDistKm,
    maxDistFromHomeKm,
    minVoltage: voltVals.length ? Math.min(...voltVals) : null,
    maxCapacity: capVals.length ? Math.max(...capVals) : null,
    maxCurrent,
    minRSSI,
    dominantMode,
    dominantPct,
  }

  const events = detectEvents(rows)

  return { filename, rows, flightModes, hasGPS, hasBattery, hasCurrent, stats, events }
}

function detectEvents(rows) {
  if (rows.length < 2) return []

  const events = []
  const baseAlt = rows[0]['Alt(m)'] ?? 0
  const AIRBORNE_ALT = baseAlt + 8  // 8 m above launch point
  const AIRBORNE_SPD = 15           // km/h

  const airborne = r =>
    (r['Alt(m)'] ?? 0) > AIRBORNE_ALT || (r['GSpd(kmh)'] ?? 0) > AIRBORNE_SPD

  let wasFlying = false
  let tookOff = false
  let lastLandIdx = -1

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const prev = rows[i - 1]
    const nowFlying = airborne(r)

    if (!wasFlying && nowFlying && !tookOff) {
      events.push({ type: 'takeoff', index: i })
      tookOff = true
    }

    if (wasFlying && !nowFlying) {
      lastLandIdx = i
    }

    if (prev) {
      if (r['FM'] === 'RTH' && prev['FM'] !== 'RTH')
        events.push({ type: 'rth_on', index: i })
      if (prev['FM'] === 'RTH' && r['FM'] !== 'RTH')
        events.push({ type: 'rth_off', index: i })
    }

    wasFlying = nowFlying
  }

  if (lastLandIdx > 0) events.push({ type: 'land', index: lastLandIdx })

  return events.sort((a, b) => a.index - b.index)
}
