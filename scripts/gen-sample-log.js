/**
 * Generate a synthetic EdgeTX CSV log for the demo flights.
 *
 * IMPORTANT: This is fully fabricated data. The GPS coordinates are
 * over central Iowa farmland (Calhoun County, near Lake City — visibly
 * checkerboard farms on satellite imagery). Same approximate location
 * for both flights so users see familiar terrain when switching.
 *
 * Both flights start AND END at their respective takeoff points (closed
 * loops) so the touchdown lands the user back at the spawn marker.
 *
 * Usage:
 *   node scripts/gen-sample-log.js fixed-wing > public/sample-fixed-wing.csv
 *   node scripts/gen-sample-log.js quad       > public/sample-quad.csv
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

// Grand Canyon South Rim (near Mather Point). Launch sits on the flat
// forested plateau at the rim (~2100 m MSL); the pattern's north legs
// carry the aircraft out over the rim where the canyon drops ~1300 m
// below — real 3D terrain the viewer now renders. Altitudes below stay
// AGL / relative-to-launch (the blackbox convention); GlobeView adds the
// sampled launch-terrain elevation so the flight sits correctly above
// the ground.
const HOME_LAT = 36.06
const HOME_LON = -112.1083
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

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

// Arc segment helper. Takes a center, radius, and start/end angles measured
// CLOCKWISE FROM NORTH (so 0=north, 90=east, 180=south, 270=west). For a
// left-traffic turn (banked left), phi DECREASES as the aircraft moves
// (counterclockwise from above). Returns position + compass heading + roll.
function arcPoint(centerE, centerN, R, startPhi, endPhi, u, leftTurn = true) {
  const phi = lerp(startPhi, endPhi, u) // degrees
  const phiRad = phi * D2R
  const E = centerE + R * Math.sin(phiRad)
  const N = centerN + R * Math.cos(phiRad)
  // Tangent direction (heading): for left turn, perpendicular pointing
  // 90° clockwise from outward radial. Outward radial direction = phi.
  // → heading_compass = phi - 90 (mod 360) for left turn.
  // For a right turn it'd be phi + 90.
  const hdg = ((leftTurn ? phi - 90 : phi + 90) + 360) % 360
  return { E, N, hdg }
}

// ── Fixed-wing flight ──────────────────────────────────────────────────────
//
// Two climbing left-traffic circuits → SE diversion + climb to 200m →
// hard-left U-turn → NW inbound → standard left-traffic descending
// pattern + landing. Closes the loop — touchdown a few metres past
// takeoff. Total ≈ 7.8 minutes.
//
// Field-circuit geometry (looking down, north up, east right):
//
//                downwind leg (W) ────────►
//        (-380, 250) ←───────── (380, 250)
//             ╱                       ╲
//      base ╱                           ╲ x-wind
//   (-430, 200)                   (430, 200)
//        ╲                           ╱
//         ╲                         ╱
//   (-430, 50)                  (430, 50)
//        ╱                           ╲
//      ╱                               ╲
//   (-380, 0) ───── final ←────────► (380, 0)
//          ↓                           ↑
//          touchdown (35, 3)   takeoff (0,0)
//
// The two takeoff laps gain altitude on the NORTH side. After the 2nd
// final turn the plane climbs east past origin, banks 45° right and
// flies SE for ~50 s to peak altitude (200 m). A hard-left U-turn at
// the far end (R=280 m) brings it back NW; the inbound leg is sized so
// that a 45° left turn at its end deposits the plane right onto the
// downwind line for a single descending circuit + final approach.

function buildFixedWingFlight() {
  const start = new Date('2024-09-15T21:23:00Z').getTime()
  const out = []

  // Canyon-dive demo over the Grand Canyon South Rim. The canyon opens to the
  // NORTH of the launch point; `alt` is AGL / relative-to-launch and goes
  // NEGATIVE as the aircraft noses off the rim and drops into the canyon, then
  // climbs back out to land. Waypoints -> straight legs; GlobeView's Catmull-Rom
  // smoothing rounds the corners and derives the model's dive/bank pose from the
  // resulting 3D path.
  const WP = [
    { E:     0, N:    0, alt:    0, spd:   0, mode: 'MANU' }, // pad
    { E:     0, N:  190, alt:   35, spd:  70, mode: 'ANGL' }, // hand-launch north
    { E:     0, N:  680, alt:  135, spd: 100, mode: 'ANGL' }, // climb over the plateau
    { E:    80, N: 1280, alt:  155, spd: 112, mode: 'CRUZ' }, // cruise out to the rim
    { E:   270, N: 1980, alt:   15, spd: 124, mode: 'CRUZ' }, // nose over the rim
    { E:   480, N: 2560, alt: -235, spd: 134, mode: 'CRUZ' }, // dive into the canyon
    { E:   360, N: 3090, alt: -375, spd: 133, mode: 'CRUZ' }, // pulling level, deep
    { E:  -260, N: 3170, alt: -395, spd: 123, mode: 'CRUZ' }, // bottom of the dive, banking back
    { E:  -890, N: 2820, alt: -330, spd: 119, mode: 'CRUZ' }, // tracking the gorge SW
    { E: -1190, N: 2090, alt: -140, spd: 113, mode: 'CRUZ' }, // climbing out, heading S
    { E:  -960, N: 1290, alt:   75, spd: 107, mode: 'CRUZ' }, // back up over the rim
    { E:  -540, N:  690, alt:  125, spd: 100, mode: 'CRUZ' }, // downwind over the plateau
    { E:  -100, N:  270, alt:   72, spd:  86, mode: 'CRUZ' }, // base leg
    { E:   250, N:   70, alt:   32, spd:  64, mode: 'ANGL' }, // turn to final
    { E:    60, N:    6, alt:    4, spd:  42, mode: 'ANGL' }, // short final
    { E:     0, N:    0, alt:    0, spd:  20, mode: 'LAND' }, // touchdown at home
    { E:   -30, N:    0, alt:    0, spd:   0, mode: 'LAND' }, // rollout
  ]
  // Seconds to fly each leg i (WP[i-1] -> WP[i]); a hold precedes the roll.
  const LEG = [0, 9, 17, 19, 20, 20, 18, 18, 18, 20, 20, 16, 14, 12, 14, 8, 10]
  const HOLD = 8

  const bearing = (a, b) => ((Math.atan2(b.E - a.E, b.N - a.N) * 180) / Math.PI + 360) % 360
  const angDiff = (a, b) => ((b - a + 540) % 360) - 180
  const horiz = (a, b) => Math.hypot(b.E - a.E, b.N - a.N)
  const legHdg = (i) => (i >= 1 && i < WP.length && horiz(WP[i - 1], WP[i]) > 1 ? bearing(WP[i - 1], WP[i]) : 0)

  const phases = [
    { kind: 'static', dur: HOLD, E: 0, N: 0, alt: 0, gspd: 0, hdg: legHdg(1), pitch: 0, roll: 0, mode: 'MANU' },
  ]
  for (let i = 1; i < WP.length; i++) {
    const A = WP[i - 1], B = WP[i]
    const dh = horiz(A, B)
    const hdg = dh > 1 ? bearing(A, B) : legHdg(i)
    const pitch = dh > 1 ? Math.atan2(B.alt - A.alt, dh) : 0
    let roll = 0
    if (i < WP.length - 1) {
      const turn = angDiff(hdg, legHdg(i + 1))
      roll = Math.max(-0.6, Math.min(0.6, turn * 0.010))
    }
    phases.push({
      kind: 'line', dur: LEG[i],
      fromE: A.E, toE: B.E, fromN: A.N, toN: B.N,
      fromAlt: A.alt, toAlt: B.alt, fromGspd: A.spd, toGspd: B.spd,
      hdg, pitch, roll, mode: B.mode,
    })
  }
  const TOTAL = phases.reduce((a, p) => a + p.dur, 0)

  // Sanity check: durations sum to TOTAL
  const sumDur = phases.reduce((a, p) => a + p.dur, 0)
  if (sumDur !== TOTAL) throw new Error(`fixed-wing phases sum=${sumDur}, expected ${TOTAL}`)

  let prevAlt = 0
  let cap = 0

  for (let t = 0; t <= TOTAL; t++) {
    const sample = sampleAt(phases, t)
    const { E, N, alt, gspd, hdg, pitch, roll, mode } = sample

    const yaw = hdg * D2R

    const vspd = alt - prevAlt
    prevAlt = alt

    // 12.6V → 11.0V over flight, ripple under load
    const battF = t / TOTAL
    const rxBt = 12.6 - battF * 1.5 + Math.sin(t * 0.6) * 0.05
    const curr = 7 + (gspd / 60) * 12 + (Math.abs(alt) > 5 ? Math.sin(t * 0.4) * 1.5 : 0)
    cap += (curr * 1000) / 3600

    const distM = Math.sqrt(E * E + N * N)
    const rssi1 = -(45 + Math.sin(t * 0.3) * 3 + distM / 50)
    const rssi2 = -(48 + Math.cos(t * 0.4) * 3 + distM / 50)
    const rqly = Math.max(85, 100 - distM / 30)

    const [lat, lon] = offsetToLatLon(E, N)

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

// Walk the phase table to find which phase contains time t (in seconds), and
// produce a fully resolved sample point at that time.
function sampleAt(phases, t) {
  let phaseStart = 0
  for (const p of phases) {
    if (t >= phaseStart && t <= phaseStart + p.dur) {
      const u = p.dur > 0 ? (t - phaseStart) / p.dur : 0
      return resolvePhase(p, u)
    }
    phaseStart += p.dur
  }
  // After the last phase — clamp to its end
  const last = phases[phases.length - 1]
  return resolvePhase(last, 1)
}

function resolvePhase(p, u) {
  if (p.kind === 'static') {
    return {
      E: p.E,
      N: p.N,
      alt: p.alt,
      gspd: p.fromGspd != null ? lerp(p.fromGspd, p.toGspd, u) : p.gspd,
      hdg: p.hdg,
      pitch: p.pitch,
      roll: p.roll,
      mode: p.mode,
    }
  }
  if (p.kind === 'line') {
    return {
      E: lerp(p.fromE, p.toE, u),
      N: lerp(p.fromN, p.toN, u),
      alt: p.fromAlt != null ? lerp(p.fromAlt, p.toAlt, u) : p.alt,
      gspd: p.fromGspd != null ? lerp(p.fromGspd, p.toGspd, u) : p.gspd,
      hdg: p.hdg,
      pitch: p.pitch,
      roll: p.roll,
      mode: p.mode,
    }
  }
  if (p.kind === 'arc') {
    const eu = easeInOut(u)
    const a = arcPoint(p.centerE, p.centerN, p.R, p.startPhi, p.endPhi, eu, p.leftTurn !== false)
    return {
      E: a.E,
      N: a.N,
      alt: p.fromAlt != null ? lerp(p.fromAlt, p.toAlt, u) : p.alt,
      gspd: p.fromGspd != null ? lerp(p.fromGspd, p.toGspd, u) : p.gspd,
      hdg: a.hdg,
      pitch: p.pitch,
      roll: p.roll * Math.sin(u * Math.PI), // bank in/out smoothly across the arc
      mode: p.mode,
    }
  }
  throw new Error(`unknown kind: ${p.kind}`)
}

// ── 5" freestyle quad flight ───────────────────────────────────────────────
//
// Acrobatic session ~2 minutes that stays close to home and explicitly
// returns to the takeoff point for landing.
//
// All maneuvers are anchored relative to (homeE, homeN) so the quad never
// drifts off — sprints go OUT and BACK using sin curves, the orbit centres
// on home, and the touchdown is forced at home.

function buildQuadFlight() {
  const TOTAL = 130
  const start = new Date('2024-09-15T15:10:00Z').getTime()
  const out = []

  // Quad spawn — same general patch of farmland, 50m southeast of the
  // fixed-wing spawn so users see both flights cleanly side by side.
  const homeE = 60
  const homeN = -40

  let prevAlt = 0
  let cap = 0

  for (let t = 0; t <= TOTAL; t++) {
    const s = quadSampleAt(t, homeE, homeN)
    const { E, N, alt, gspd, hdg, pitch, roll, mode } = s
    const yaw = hdg * D2R

    const vspd = alt - prevAlt
    prevAlt = alt

    const battF = t / TOTAL
    const rxBt = 16.8 - battF * 3.3 + Math.sin(t * 0.9) * 0.08 - (gspd / 130) * 0.4
    const curr = 12 + (gspd / 50) * 25 + (alt > 1 ? 8 : 0) + Math.abs(pitch) * 6
    cap += (curr * 1000) / 3600

    const distFromHome = Math.sqrt((E - homeE) ** 2 + (N - homeN) ** 2)
    const rssi1 = -(40 + Math.sin(t * 0.3) * 3 + distFromHome / 60)
    const rssi2 = -(43 + Math.cos(t * 0.4) * 3 + distFromHome / 60)
    const rqly = Math.max(80, 100 - distFromHome / 25)

    const [lat, lon] = offsetToLatLon(E, N)

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

function quadSampleAt(t, homeE, homeN) {
  // All maneuvers below produce E, N, alt, gspd, hdg, pitch, roll. They're
  // anchored to home so deviation is bounded and the flight closes.
  let E = homeE, N = homeN
  let alt = 0, gspd = 0
  let hdg = 0, pitch = 0, roll = 0
  let mode = 'ACRO'

  if (t < 3) {
    // arm + brief hover
    alt = Math.min(t * 1.0, 2)
    gspd = 1
  } else if (t < 8) {
    // punch out — vertical
    const u = (t - 3) / 5
    alt = 2 + easeInOut(u) * 28
    gspd = 5 + u * 25
    pitch = 0.05
  } else if (t < 18) {
    // first power loop, anchored to home (lateral drift stays inside ±15m)
    const u = (t - 8) / 10
    const phase = u * 2 * Math.PI
    pitch = -Math.sin(phase) * 1.6
    alt = 30 + Math.sin(phase + Math.PI / 2) * 12 - 12
    if (alt < 5) alt = 5
    gspd = 60 + Math.cos(phase) * 30
    roll = Math.sin(phase * 2) * 0.1
    // Loop drifts forward slightly then comes back — net delta=0 across loop
    E = homeE + Math.sin(phase) * 8
    N = homeN + Math.cos(phase) * 4
    hdg = 0
  } else if (t < 26) {
    // diving sprint EAST and back (sin out-and-back keeps net delta = 0)
    const u = (t - 18) / 8
    const sweep = Math.sin(u * Math.PI) // 0 → 1 → 0
    E = homeE + sweep * 80
    N = homeN
    alt = 35 - sweep * 22
    gspd = 60 + sweep * 70
    hdg = u < 0.5 ? 90 : 270
    pitch = 0.4 - sweep * 0.2
    roll = 0
  } else if (t < 34) {
    // double roll left (720°) while passing back through home
    const u = (t - 26) / 8
    let r = -((u * 4 * Math.PI) % (2 * Math.PI)) + Math.PI
    if (r > Math.PI) r -= 2 * Math.PI
    roll = r
    pitch = 0.05
    gspd = 70
    E = homeE + (1 - u) * 30 // ending close to home from the sprint
    N = homeN
    alt = 18 + u * 6
    hdg = 270
  } else if (t < 42) {
    // split-S near home — half-roll then pull through into a dive
    const u = (t - 34) / 8
    if (u < 0.4) {
      roll = (u / 0.4) * Math.PI
      pitch = 0.0
    } else {
      const v = (u - 0.4) / 0.6
      roll = Math.PI - v * Math.PI
      pitch = v * 1.4
    }
    gspd = 55 + u * 25
    alt = 24 - u * 12
    if (alt < 8) alt = 8
    E = homeE + Math.sin(u * Math.PI) * 12
    N = homeN - u * 6
    hdg = (270 + u * 90) % 360
  } else if (t < 56) {
    // second power loop around home, bigger
    const u = (t - 42) / 14
    const phase = u * 2 * Math.PI
    pitch = -Math.sin(phase) * 1.7
    alt = 25 + Math.sin(phase + Math.PI / 2) * 18 - 18
    if (alt < 4) alt = 4
    gspd = 70 + Math.cos(phase) * 35
    roll = Math.sin(phase * 1.3) * 0.15
    E = homeE + Math.sin(phase) * 12
    N = homeN + Math.cos(phase) * 6
    hdg = 0
  } else if (t < 75) {
    // yaw orbit — 25m circle CENTRED ON HOME, full revolution + a bit
    const u = (t - 56) / 19
    const orbitPhase = u * 2 * Math.PI
    const orbitR = 25
    E = homeE + Math.sin(orbitPhase) * orbitR
    N = homeN + Math.cos(orbitPhase) * orbitR
    hdg = (((orbitPhase * 180) / Math.PI + 90) % 360 + 360) % 360
    gspd = 55
    alt = 18
    roll = -0.7
    pitch = 0.15
  } else if (t < 95) {
    // rip line — out west and back (sin out-and-back). Top speed at midpoint
    const u = (t - 75) / 20
    const sweep = Math.sin(u * Math.PI) // 0 → 1 → 0
    E = homeE - sweep * 110
    N = homeN
    alt = 6 + sweep * 1.5
    gspd = 60 + sweep * 75 // up to 135 km/h at midpoint
    hdg = u < 0.5 ? 270 : 90
    pitch = 0.4 - sweep * 0.1
    roll = Math.sin(u * 6) * 0.08
  } else if (t < 110) {
    // chandelle climb back to home, banking
    const u = (t - 95) / 15
    const sweep = Math.sin(u * Math.PI)
    pitch = -0.5 + sweep * 0.3
    const turnPhase = u * Math.PI
    hdg = (90 + Math.sin(turnPhase) * 120) % 360
    roll = -0.7 * Math.sin(turnPhase)
    gspd = 60 - u * 35
    alt = 6 + easeInOut(u) * 28
    // Smoothly home in
    E = homeE + (1 - u) * 30
    N = homeN + (1 - u) * 12
  } else if (t < 122) {
    // Hover descent — drift a few metres from spawn for a hand-flown feel,
    // then settle in for touchdown. Real freestyle landings aren't pixel-
    // perfect; pilots eyeball it.
    const u = (t - 110) / 12
    E = lerp(homeE, homeE + 3, u)
    N = lerp(homeN, homeN + 2, u)
    gspd = Math.max(15 - u * 14, 0.5)
    alt = Math.max(34 - easeInOut(u) * 33, 1)
    pitch = 0
    roll = 0
    hdg = 0
  } else {
    // Touchdown / disarm — a few metres NE of the spawn pad.
    E = homeE + 3
    N = homeN + 2
    alt = 0
    gspd = 0
    pitch = 0
    roll = 0
    hdg = 0
  }

  return { E, N, alt, gspd, hdg, pitch, roll, mode }
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
