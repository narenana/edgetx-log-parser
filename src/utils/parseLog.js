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

  const stats = {
    duration: rows.length > 1 ? rows[rows.length - 1]._tSec : 0,
    maxAlt: altVals.length ? Math.max(...altVals) : 0,
    minAlt: altVals.length ? Math.min(...altVals) : 0,
    maxSpeed: spdVals.length ? Math.max(...spdVals) : 0,
    maxClimb: vspVals.length ? Math.max(...vspVals) : 0,
    maxSink: vspVals.length ? Math.min(...vspVals) : 0,
    distanceKm: totalDistKm,
    minVoltage: voltVals.length ? Math.min(...voltVals) : null,
    maxCapacity: capVals.length ? Math.max(...capVals) : null,
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
