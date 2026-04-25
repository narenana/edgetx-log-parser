/**
 * Generate a synthetic EdgeTX CSV log for the demo button.
 *
 * IMPORTANT: This is fully fabricated data. The GPS coordinates are
 * intentionally over open Pacific water so it's obvious the log is fake
 * and no real flying-field locations are exposed.
 *
 * Usage:
 *   node scripts/gen-sample-log.js > public/sample-log.csv
 */

const HEADER = [
  'Date', 'Time',
  '1RSS(dB)', '2RSS(dB)', 'RQly(%)', 'RSNR(dB)',
  'RxBt(V)', 'Curr(A)', 'Capa(mAh)',
  'Ptch(rad)', 'Roll(rad)', 'Yaw(rad)',
  'GPS', 'GSpd(kmh)', 'Hdg(°)', 'Alt(m)', 'VSpd(m/s)',
  'FM', 'Sats',
  'TxBat(V)',
  'Rud', 'Ele', 'Thr', 'Ail',
]

// Open-Pacific origin — definitely not a real flying field.
const HOME_LAT = 25.0000
const HOME_LON = -150.0000
const HOME_ALT = 0

const D = (n, p = 1) => Number(n).toFixed(p)

function fmt(t, fields) {
  // t = seconds from start. Pretend the flight started 2024-09-15 14:23:00.
  const start = new Date('2024-09-15T14:23:00Z').getTime()
  const ms = start + t * 1000
  const d = new Date(ms)
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}.000`
  return [date, time, ...fields].join(',')
}

// Convert metres east/north of HOME to lat/lon.
function offsetToLatLon(eastM, northM) {
  const dLat = northM / 111111
  const dLon = eastM / (111111 * Math.cos((HOME_LAT * Math.PI) / 180))
  return [HOME_LAT + dLat, HOME_LON + dLon]
}

const rows = []

// ── Phase definitions ───────────────────────────────────────────────────────
// 0–10s    : on the ground, idle
// 10–40s   : takeoff + climb to 80m, heading 90°
// 40–60s   : turn left to start a circuit
// 60–180s  : 2-min cruise circle (radius ~150m)
// 180–210s : RTH triggered, heads home holding 60m
// 210–240s : descent + touchdown
// total    : 240s (4 min) → 240 rows at 1 Hz

const TOTAL = 240
let east = 0, north = 0, alt = HOME_ALT, hdg = 90, gspd = 0
let pitch = 0, roll = 0, yaw = 0
let cap = 0
let mode = 'ANGL'

for (let t = 0; t <= TOTAL; t++) {
  // ── State machine ───────────────────────────────────────────────────────
  if (t < 10) {
    // Idle on ground
    gspd = 0
    alt = HOME_ALT
    pitch = 0; roll = 0; yaw = (hdg * Math.PI) / 180
    mode = 'MANU'
  } else if (t < 40) {
    // Climb-out, heading 090
    const f = (t - 10) / 30
    gspd = 35 + f * 25                    // 35 → 60 km/h
    alt = HOME_ALT + f * 80               // 0 → 80 m
    east += (gspd / 3.6) * Math.sin((hdg * Math.PI) / 180)
    north += (gspd / 3.6) * Math.cos((hdg * Math.PI) / 180)
    pitch = 0.20 - f * 0.05               // nose-up climb
    roll = 0
    mode = 'ANGL'
  } else if (t < 60) {
    // Bank into circuit
    const f = (t - 40) / 20
    hdg = (90 - f * 90 + 360) % 360       // 090 → 360
    gspd = 60
    alt = 80
    roll = -0.45                          // left bank
    pitch = 0.05
    east += (gspd / 3.6) * Math.sin((hdg * Math.PI) / 180)
    north += (gspd / 3.6) * Math.cos((hdg * Math.PI) / 180)
    mode = 'ANGL'
  } else if (t < 180) {
    // Circle pattern — radius ~150m, period ~60s
    const period = 60
    const omega = (2 * Math.PI) / period
    const phase = (t - 60) * omega
    const radius = 150
    east = radius * Math.sin(phase + Math.PI)
    north = radius * Math.cos(phase + Math.PI) + radius
    hdg = (((Math.PI / 2 - phase) * 180) / Math.PI + 360) % 360
    gspd = 65 + Math.sin(phase * 2) * 5
    alt = 80 + Math.sin(phase * 1.5) * 8  // gentle wave
    roll = -0.35
    pitch = 0.04 + Math.sin(phase * 1.5) * 0.05
    mode = 'CRUZ'
  } else if (t < 210) {
    // RTH — heads home holding 60m
    const f = (t - 180) / 30
    const dist = Math.sqrt(east * east + north * north)
    const homeHdg = (Math.atan2(-east, -north) * 180) / Math.PI
    hdg = (homeHdg + 360) % 360
    const step = (gspd / 3.6) * 1
    east -= (east / dist) * step
    north -= (north / dist) * step
    alt = 80 + (60 - 80) * f              // 80 → 60
    gspd = 65
    roll = 0
    pitch = -0.05
    mode = 'RTH'
  } else {
    // Auto-land
    const f = (t - 210) / 30
    const dist = Math.max(Math.sqrt(east * east + north * north), 0.1)
    const homeHdg = (Math.atan2(-east, -north) * 180) / Math.PI
    hdg = (homeHdg + 360) % 360
    const step = Math.max((gspd / 3.6) * (1 - f), 0.5)
    east -= (east / dist) * step
    north -= (north / dist) * step
    alt = Math.max(60 - f * 60, HOME_ALT) // 60 → 0
    gspd = Math.max(65 - f * 60, 5)       // 65 → 5
    pitch = 0.10
    roll = 0
    mode = f < 0.7 ? 'RTH' : 'LAND'
  }

  yaw = (hdg * Math.PI) / 180

  // VSpd = derivative of alt (smoothed)
  const prevAlt = rows.length ? Number(rows[rows.length - 1].alt) : alt
  const vspd = alt - prevAlt

  // Battery sag: 12.6V full → 10.8V empty over 240s, with ripple under load
  const battF = t / TOTAL
  const rxBt = 12.6 - battF * 1.5 + Math.sin(t * 0.7) * 0.05
  const curr = 8 + (gspd / 60) * 12 + (alt > 5 ? Math.sin(t * 0.4) * 1.5 : 0)
  cap += (curr * 1000) / 3600           // amp-seconds → mAh

  // Signal — strong link, slight RSSI flutter
  const rssi1 = -(45 + Math.sin(t * 0.3) * 3 + (Math.sqrt(east * east + north * north) / 50))
  const rssi2 = -(48 + Math.cos(t * 0.4) * 3 + (Math.sqrt(east * east + north * north) / 50))
  const rqly = Math.max(85, 100 - Math.sqrt(east * east + north * north) / 30)

  const [lat, lon] = offsetToLatLon(east, north)

  rows.push({
    line: fmt(t, [
      D(rssi1, 0), D(rssi2, 0), D(rqly, 0), '14',
      D(rxBt, 2), D(curr, 1), D(cap, 0),
      D(pitch, 4), D(roll, 4), D(yaw, 4),
      `${D(lat, 6)} ${D(lon, 6)}`, D(gspd, 1), D(hdg, 0), D(alt, 1), D(vspd, 2),
      mode, '12',
      '7.8',
      '0', '0', t < 10 ? '-1024' : '0', '0',
    ]),
    alt,
  })
}

console.log(HEADER.join(','))
for (const r of rows) console.log(r.line)
