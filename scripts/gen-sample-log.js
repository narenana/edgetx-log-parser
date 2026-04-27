/**
 * Generate a synthetic EdgeTX CSV log for the demo flights.
 *
 * IMPORTANT: This is fully fabricated data. The GPS coordinates are
 * over central Iowa farmland (visibly checkerboard farms on satellite
 * imagery). Same approximate location for both flights so users see
 * familiar terrain when switching between samples.
 *
 * Usage:
 *   node scripts/gen-sample-log.js fixed-wing > public/sample-fixed-wing.csv
 *   node scripts/gen-sample-log.js quad       > public/sample-quad.csv
 *
 * Defaults to fixed-wing if no arg given.
 */

// ── Shared helpers ──────────────────────────────────────────────────────────

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

// Iowa farmland — Calhoun County, near Lake City. Visible field grid on
// satellite imagery, no recognisable real flying field, fully fabricated.
const HOME_LAT = 42.067
const HOME_LON = -94.85
const HOME_ALT = 0

const D = (n, p = 1) => Number(n).toFixed(p)
const D2R = Math.PI / 180

function fmtTime(start, t) {
  const ms = start + t * 1000
  const d = new Date(ms)
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}.000`
  return [date, time]
}

function offsetToLatLon(eastM, northM, lat0 = HOME_LAT, lon0 = HOME_LON) {
  const dLat = northM / 111111
  const dLon = eastM / (111111 * Math.cos((lat0 * Math.PI) / 180))
  return [lat0 + dLat, lon0 + dLon]
}

// Smooth ease in/out — used for natural turn transitions.
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

// ── Fixed-wing flight ──────────────────────────────────────────────────────
//
// Standard rectangular circuit pattern with rounded turns and a final-approach
// landing. ~4 minutes. Bank angles ~30° in turns, climbs at +10° pitch, glides
// at -5°. Cruise speed ~65 km/h. Cruise altitude ~80 m AGL.

function buildFixedWingFlight() {
  const TOTAL = 240
  const start = new Date('2024-09-15T14:23:00Z').getTime()
  const out = []

  // State carried between phases
  let east = 0
  let north = 0
  let alt = HOME_ALT
  let hdg = 90       // takeoff heading: due east
  let gspd = 0
  let pitch = 0      // radians
  let roll = 0
  let cap = 0
  let prevAlt = HOME_ALT

  // Circuit geometry
  const CRUISE_ALT = 80
  const CRUISE_SPD = 65
  const RUNWAY_HDG = 90    // east takeoff/west landing
  const APPROACH_HDG = 270 // west landing direction (from east)

  for (let t = 0; t <= TOTAL; t++) {
    let mode

    if (t < 8) {
      // ── Holding short / pre-takeoff
      gspd = 0; alt = HOME_ALT; pitch = 0; roll = 0
      mode = 'MANU'
    } else if (t < 14) {
      // ── Takeoff roll, accelerating to rotation speed
      const f = (t - 8) / 6
      gspd = f * 50          // 0 → 50 km/h
      alt = HOME_ALT
      pitch = 0; roll = 0
      hdg = RUNWAY_HDG
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = 'ANGL'
    } else if (t < 35) {
      // ── Climb-out at +10° pitch, holding runway heading
      const f = (t - 14) / 21
      gspd = 50 + f * 15     // 50 → 65 km/h
      alt = easeInOut(f) * CRUISE_ALT
      pitch = 0.18 - f * 0.05
      roll = 0
      hdg = RUNWAY_HDG
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = 'ANGL'
    } else if (t < 55) {
      // ── Crosswind turn — rounded left bank from 090° to 360° (=0°)
      const f = easeInOut((t - 35) / 20)
      hdg = 90 + (360 - 90) * f
      gspd = CRUISE_SPD
      alt = CRUISE_ALT + Math.sin(f * Math.PI) * 4
      roll = -0.42 * Math.sin(f * Math.PI)
      pitch = 0.04
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      hdg = hdg % 360
      mode = 'ANGL'
    } else if (t < 90) {
      // ── Downwind leg — heading 360° (north), straight and level
      hdg = 0
      gspd = CRUISE_SPD + Math.sin(t * 0.4) * 2
      alt = CRUISE_ALT
      roll = 0
      pitch = 0.02
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = 'CRUZ'
    } else if (t < 110) {
      // ── Base turn — rounded left from 360° to 270° (west)
      const f = easeInOut((t - 90) / 20)
      hdg = (360 + (270 - 360) * f + 360) % 360
      gspd = CRUISE_SPD
      alt = CRUISE_ALT + Math.sin(f * Math.PI) * 3 - f * 5
      roll = -0.40 * Math.sin(f * Math.PI)
      pitch = -0.02
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = 'CRUZ'
    } else if (t < 145) {
      // ── Base leg / start descent towards approach
      hdg = 270
      const f = (t - 110) / 35
      gspd = CRUISE_SPD - f * 5
      alt = CRUISE_ALT - 5 - f * 25       // 75 → 50 m
      roll = 0
      pitch = -0.04
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = 'CRUZ'
    } else if (t < 165) {
      // ── Final-approach turn — rounded left from 270° to 270° (already
      // aligned, but lose another 100m of crosstrack via gentle turn to align
      // with runway). Heading actually swings 270° → 270° via brief 250° dip.
      const f = easeInOut((t - 145) / 20)
      hdg = 270 - Math.sin(f * Math.PI) * 20
      gspd = 60 - f * 5
      alt = 50 - f * 15                    // 50 → 35 m
      roll = -0.18 * Math.sin(f * Math.PI)
      pitch = -0.06
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = 'ANGL'
    } else if (t < 210) {
      // ── Final approach — slow glide, descending to round-out altitude
      const f = (t - 165) / 45
      hdg = APPROACH_HDG
      gspd = 55 - f * 10                    // 55 → 45 km/h
      alt = 35 - f * 32                     // 35 → 3 m
      roll = 0
      pitch = -0.08 + f * 0.04
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = 'ANGL'
    } else if (t < 225) {
      // ── Flare and touchdown
      const f = (t - 210) / 15
      hdg = APPROACH_HDG
      gspd = Math.max(45 - f * 25, 18)      // 45 → 20 km/h
      alt = Math.max(3 - f * 3, HOME_ALT)
      roll = 0
      pitch = 0.06 * (1 - f)
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = f < 0.5 ? 'ANGL' : 'LAND'
    } else {
      // ── Ground roll, decelerating
      const f = (t - 225) / 15
      hdg = APPROACH_HDG
      gspd = Math.max(20 - f * 18, 0)
      alt = HOME_ALT
      roll = 0
      pitch = 0
      east += (gspd / 3.6) * Math.sin(hdg * D2R)
      north += (gspd / 3.6) * Math.cos(hdg * D2R)
      mode = 'LAND'
    }

    const yaw = hdg * D2R

    const vspd = alt - prevAlt
    prevAlt = alt

    // Battery sag — 12.6V → 11.0V over flight, ripple under load
    const battF = t / TOTAL
    const rxBt = 12.6 - battF * 1.5 + Math.sin(t * 0.6) * 0.05
    const curr = 7 + (gspd / 60) * 12 + (alt > 5 ? Math.sin(t * 0.4) * 1.5 : 0)
    cap += (curr * 1000) / 3600

    // Signal — strong link at moderate distance
    const distM = Math.sqrt(east * east + north * north)
    const rssi1 = -(45 + Math.sin(t * 0.3) * 3 + distM / 60)
    const rssi2 = -(48 + Math.cos(t * 0.4) * 3 + distM / 60)
    const rqly = Math.max(85, 100 - distM / 40)

    const [lat, lon] = offsetToLatLon(east, north)

    out.push(rowOf({
      start, t,
      rssi1, rssi2, rqly, rxBt, curr, cap,
      pitch, roll, yaw,
      lat, lon, gspd, hdg, alt, vspd,
      mode, sticks: { rud: 0, ele: 0, thr: t < 8 ? -1024 : 200, ail: 0 },
    }))
  }

  return out
}

// ── 5" freestyle quad flight ───────────────────────────────────────────────
//
// 2-minute freestyle session: punch out, power loops, rolls, dives, rip line,
// orbit, land. Tight area (~150m radius). High pitch / roll values, fast
// speed transitions. 4S 1500mAh LiPo at high amperage.

function buildQuadFlight() {
  const TOTAL = 130
  const start = new Date('2024-09-15T15:10:00Z').getTime()  // 47 minutes after the fixed wing
  const out = []

  // Quad starts slightly offset from the fixed-wing pad — same farm, different corner
  const homeOffsetE = 60
  const homeOffsetN = -40

  let east = homeOffsetE
  let north = homeOffsetN
  let alt = HOME_ALT
  let hdg = 0
  let gspd = 0
  let pitch = 0
  let roll = 0
  let yaw = 0
  let cap = 0
  let prevAlt = HOME_ALT

  for (let t = 0; t <= TOTAL; t++) {
    let mode = 'ACRO'

    if (t < 3) {
      // Arm + brief low hover
      alt = HOME_ALT + Math.min(t * 1.0, 2)
      gspd = 1
      pitch = 0; roll = 0
    } else if (t < 8) {
      // ── Punch out — vertical climb to 30m
      const f = (t - 3) / 5
      alt = 2 + easeInOut(f) * 28        // 2 → 30
      gspd = 5 + f * 25
      pitch = 0.05                       // mild forward lean
      roll = 0
      hdg = 0
    } else if (t < 16) {
      // ── Power loop — pitch swings -90° → -180° → -270° → -360° (full loop)
      const f = (t - 8) / 8
      const phase = f * 2 * Math.PI       // 0 → 2π
      pitch = -Math.sin(phase) * 1.6      // ±90° peak
      // Loop centred on takeoff zone, radius ~15m
      const loopY = 30 + Math.sin(phase + Math.PI / 2) * 12 - 12
      alt = Math.max(loopY, 5)
      gspd = 60 + Math.cos(phase) * 30
      roll = Math.sin(phase * 2) * 0.1    // slight wobble
      east += Math.sin(hdg * D2R) * (gspd / 3.6) * 0.4
      north += Math.cos(hdg * D2R) * (gspd / 3.6) * 0.4
    } else if (t < 22) {
      // ── Power dive — diving forward fast
      const f = (t - 16) / 6
      pitch = 0.6 + f * 0.4                 // nose-down
      alt = Math.max(45 - f * 30, 8)        // 45 → 15 m
      gspd = 70 + f * 40                    // 70 → 110 km/h
      hdg = 90                              // dive east
      east += Math.sin(hdg * D2R) * (gspd / 3.6)
      north += Math.cos(hdg * D2R) * (gspd / 3.6)
      roll = 0
    } else if (t < 28) {
      // ── Roll left × 2 (720°) while flying east
      const f = (t - 22) / 6
      roll = -((f * 4 * Math.PI) % (2 * Math.PI)) + Math.PI
      // Normalize roll to ±π
      if (roll > Math.PI) roll -= 2 * Math.PI
      pitch = 0.05
      gspd = 90
      alt = 15 + f * 8
      hdg = 90
      east += Math.sin(hdg * D2R) * (gspd / 3.6)
      north += Math.cos(hdg * D2R) * (gspd / 3.6)
    } else if (t < 38) {
      // ── Loose horizontal arc carving back toward home
      const f = (t - 28) / 10
      hdg = (90 + f * 180) % 360            // 90° → 270°, big arc
      roll = -0.6
      pitch = 0.1
      gspd = 75 - f * 10
      alt = 23 - f * 3
      east += Math.sin(hdg * D2R) * (gspd / 3.6)
      north += Math.cos(hdg * D2R) * (gspd / 3.6)
    } else if (t < 48) {
      // ── Split-S — half-roll then pull through into a dive
      const f = (t - 38) / 10
      if (f < 0.4) {
        // Half-roll to inverted
        roll = (f / 0.4) * Math.PI
        pitch = 0.0
      } else {
        // Pull through — pitch swings from 0 down to π
        const g = (f - 0.4) / 0.6
        roll = Math.PI - g * Math.PI         // back to 0
        pitch = g * 1.4
      }
      gspd = 60 + f * 30
      alt = Math.max(20 - f * 8, 8)
      hdg = (270 + f * 60) % 360
      east += Math.sin(hdg * D2R) * (gspd / 3.6)
      north += Math.cos(hdg * D2R) * (gspd / 3.6)
    } else if (t < 58) {
      // ── Second power loop — bigger this time
      const f = (t - 48) / 10
      const phase = f * 2 * Math.PI
      pitch = -Math.sin(phase) * 1.7
      const loopY = 25 + Math.sin(phase + Math.PI / 2) * 18 - 18
      alt = Math.max(loopY, 4)
      gspd = 70 + Math.cos(phase) * 35
      roll = Math.sin(phase * 1.3) * 0.15
      east += Math.sin(hdg * D2R) * (gspd / 3.6) * 0.3
      north += Math.cos(hdg * D2R) * (gspd / 3.6) * 0.3
    } else if (t < 75) {
      // ── Yaw orbit around an imaginary tree to the south — rotating heading
      // while keeping a 25 m radius
      const f = (t - 58) / 17
      const orbitPhase = f * 2 * Math.PI
      const orbitR = 25
      const orbitCx = homeOffsetE + 0
      const orbitCy = homeOffsetN - 35
      east = orbitCx + Math.sin(orbitPhase) * orbitR
      north = orbitCy + Math.cos(orbitPhase) * orbitR
      hdg = ((orbitPhase * 180) / Math.PI + 90 + 360) % 360
      gspd = 55
      alt = 18
      roll = -0.7
      pitch = 0.15
    } else if (t < 90) {
      // ── Rip line — fast low pass heading west
      const f = (t - 75) / 15
      hdg = 270
      gspd = 80 + f * 50                    // up to 130 km/h
      alt = 6 + Math.sin(f * 4) * 1.5       // skimming low
      pitch = 0.4
      roll = Math.sin(f * 6) * 0.1          // subtle wobble
      east += Math.sin(hdg * D2R) * (gspd / 3.6)
      north += Math.cos(hdg * D2R) * (gspd / 3.6)
    } else if (t < 105) {
      // ── Pitch up and chandelle — gain altitude turning back toward home
      const f = (t - 90) / 15
      pitch = -0.6
      const turnPhase = f * Math.PI
      hdg = (270 + Math.sin(turnPhase) * 120 + 360) % 360
      roll = -0.8 * Math.sin(turnPhase)
      gspd = 80 - f * 30
      alt = 6 + easeInOut(f) * 30           // 6 → 36 m
      east += Math.sin(hdg * D2R) * (gspd / 3.6)
      north += Math.cos(hdg * D2R) * (gspd / 3.6)
    } else if (t < 118) {
      // ── Float back toward takeoff, slowing
      const f = (t - 105) / 13
      const dist = Math.max(Math.sqrt((east - homeOffsetE) ** 2 + (north - homeOffsetN) ** 2), 0.1)
      const homeHdg = (Math.atan2(homeOffsetE - east, homeOffsetN - north) * 180) / Math.PI
      hdg = (homeHdg + 360) % 360
      const step = (gspd / 3.6) * 1
      east -= ((east - homeOffsetE) / dist) * step
      north -= ((north - homeOffsetN) / dist) * step
      gspd = 35 - f * 20
      alt = 36 - f * 26                      // 36 → 10 m
      pitch = 0.05
      roll = -0.1
    } else if (t < 126) {
      // ── Hover descent
      const f = (t - 118) / 8
      gspd = 8 - f * 7
      alt = Math.max(10 - f * 9, 1)
      pitch = 0
      roll = 0
    } else {
      // ── Touchdown / disarm
      gspd = 0
      alt = HOME_ALT
      pitch = 0
      roll = 0
    }

    yaw = hdg * D2R

    const vspd = alt - prevAlt
    prevAlt = alt

    // 4S 1500 mAh LiPo: 16.8V full → 13.5V at landing
    const battF = t / TOTAL
    const rxBt = 16.8 - battF * 3.3 + Math.sin(t * 0.9) * 0.08 - (gspd / 130) * 0.4
    const curr = 12 + (gspd / 50) * 25 + (alt > 1 ? 8 : 0) + Math.abs(pitch) * 6
    cap += (curr * 1000) / 3600

    const distM = Math.sqrt(east * east + north * north)
    const rssi1 = -(40 + Math.sin(t * 0.3) * 3 + distM / 80)
    const rssi2 = -(43 + Math.cos(t * 0.4) * 3 + distM / 80)
    const rqly = Math.max(80, 100 - distM / 30)

    const [lat, lon] = offsetToLatLon(east, north)

    // Quad sticks: high throttle, lots of pitch/roll input
    const thrStick = Math.max(-1024, Math.min(1024, Math.round(gspd * 8 + (alt > 1 ? 200 : 0))))
    const eleStick = Math.round(pitch * 600)
    const ailStick = Math.round(roll * 600)
    const rudStick = Math.round(Math.sin(t * 0.5) * 80)

    out.push(rowOf({
      start, t,
      rssi1, rssi2, rqly, rxBt, curr, cap,
      pitch, roll, yaw,
      lat, lon, gspd, hdg, alt, vspd,
      mode, sticks: { rud: rudStick, ele: eleStick, thr: thrStick, ail: ailStick },
    }))
  }

  return out
}

// ── Common row formatter ───────────────────────────────────────────────────

function rowOf({ start, t, rssi1, rssi2, rqly, rxBt, curr, cap,
                 pitch, roll, yaw, lat, lon, gspd, hdg, alt, vspd,
                 mode, sticks }) {
  const [date, time] = fmtTime(start, t)
  return [
    date, time,
    D(rssi1, 0), D(rssi2, 0), D(rqly, 0), '14',
    D(rxBt, 2), D(curr, 1), D(cap, 0),
    D(pitch, 4), D(roll, 4), D(yaw, 4),
    `${D(lat, 6)} ${D(lon, 6)}`, D(gspd, 1), D(hdg, 0), D(alt, 1), D(vspd, 2),
    mode, '12',
    '7.8',
    String(sticks.rud), String(sticks.ele), String(sticks.thr), String(sticks.ail),
  ].join(',')
}

// ── Main ────────────────────────────────────────────────────────────────────

const type = (process.argv[2] || 'fixed-wing').toLowerCase()

let rows
if (type === 'quad' || type === 'q') {
  rows = buildQuadFlight()
} else if (type === 'fixed-wing' || type === 'fw' || type === 'plane') {
  rows = buildFixedWingFlight()
} else {
  console.error(`Unknown flight type: ${type}\n  expected: fixed-wing | quad`)
  process.exit(1)
}

console.log(HEADER.join(','))
for (const line of rows) console.log(line)
