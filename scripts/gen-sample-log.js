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
// Standard left-traffic rectangular circuit with rounded turns.
// Closes the loop — touchdown at the same coordinates as takeoff.
//
// Geometry (looking down from above, north up, east right):
//
//       (-380, 450) ←————— downwind ←————— (380, 450)
//            ╱                                    ╲
//   base   ╱                                       ╲   crosswind
//        ╱                                          ╲
//   (-430, 50)                                  (430, 50)
//        ╲                                          ╱
//      ╱                                          ╱
//   (-380, 0)←—— final ——←—— ────────► takeoff ╱
//                      ↓
//                 ↘ touchdown at (0, 0) ↗

function buildFixedWingFlight() {
  const TOTAL = 240 // s — close enough to a real circuit, easy to follow
  const start = new Date('2024-09-15T14:23:00Z').getTime()
  const out = []

  // ── Phase table — each phase has its own evaluator ──
  // duration | mode | type | params...
  // Sum of durations = TOTAL.

  // Tweakable dims
  const CRUISE_ALT = 80
  const CRUISE_SPD = 65
  const TURN_R = 50
  // Climb / descent end-altitudes
  const CLIMB_END = 80
  const APPROACH_START = 30

  // Path waypoints (E, N, alt, gspd) at phase boundaries:
  //   W0  takeoff start  (0, 0, 0)            heading 90
  //   W1  rotation       (40, 0, 0)
  //   W2  end climb-out  (380, 0, 80)
  //   W3  end CW turn    (430, 50, 80)        heading 0  (north)
  //   W4  end x-wind leg (430, 450, 80)
  //   W5  end DW turn    (380, 500, 80)       heading 270 (west)
  //   W6  end downwind   (-380, 500, 80)
  //   W7  end base turn  (-430, 450, 75)      heading 180 (south)
  //   W8  end base leg   (-430, 50, 50)
  //   W9  end final turn (-380, 0, 35)        heading 90 (east, lined up)
  //   W10 touchdown      (0, 0, 0)
  //
  // Turn geometry: each rounded corner uses a quarter-circle arc with
  // radius TURN_R = 50m centred so it tangents both the incoming and
  // outgoing legs. For example, the crosswind turn from (380,0) heading
  // east to (430,50) heading north has its centre at (380, 50).

  const phases = [
    // 0–8  pre-takeoff hold
    { dur: 8,  mode: 'MANU', kind: 'static', E: 0, N: 0, alt: 0, gspd: 0, hdg: 90, pitch: 0, roll: 0 },

    // 8–13  takeoff roll, ground accel
    { dur: 5,  mode: 'ANGL', kind: 'line',
      fromE: 0, fromN: 0, toE: 40, toN: 0,
      fromAlt: 0, toAlt: 0, fromGspd: 0, toGspd: 50, hdg: 90, pitch: 0.05, roll: 0 },

    // 13–37  climb-out east, alt 0→80
    { dur: 24, mode: 'ANGL', kind: 'line',
      fromE: 40, fromN: 0, toE: 380, toN: 0,
      fromAlt: 0, toAlt: CLIMB_END, fromGspd: 50, toGspd: CRUISE_SPD, hdg: 90,
      pitch: 0.18, roll: 0 },

    // 37–47  crosswind turn (90°→0°), banked left
    { dur: 10, mode: 'ANGL', kind: 'arc',
      centerE: 380, centerN: 50, R: TURN_R, startPhi: 180, endPhi: 90,
      alt: CRUISE_ALT, gspd: 60, pitch: 0.04, roll: -0.42 },

    // 47–66  crosswind leg (north)
    { dur: 19, mode: 'CRUZ', kind: 'line',
      fromE: 430, fromN: 50, toE: 430, toN: 450,
      alt: CRUISE_ALT, fromGspd: 60, toGspd: CRUISE_SPD, hdg: 0, pitch: 0.02, roll: 0 },

    // 66–76  downwind turn (0°→270°)
    { dur: 10, mode: 'CRUZ', kind: 'arc',
      centerE: 380, centerN: 450, R: TURN_R, startPhi: 90, endPhi: 0,
      alt: CRUISE_ALT, gspd: 60, pitch: 0.02, roll: -0.42 },

    // 76–116  downwind leg (west)
    { dur: 40, mode: 'CRUZ', kind: 'line',
      fromE: 380, fromN: 500, toE: -380, toN: 500,
      alt: CRUISE_ALT, gspd: CRUISE_SPD, hdg: 270, pitch: 0.02, roll: 0 },

    // 116–126  base turn (270°→180°), starting descent
    { dur: 10, mode: 'CRUZ', kind: 'arc',
      centerE: -380, centerN: 450, R: TURN_R, startPhi: 0, endPhi: 270,
      fromAlt: CRUISE_ALT, toAlt: CRUISE_ALT - 5, gspd: 60, pitch: -0.02, roll: -0.40 },

    // 126–146  base leg (south, descending)
    { dur: 20, mode: 'CRUZ', kind: 'line',
      fromE: -430, fromN: 450, toE: -430, toN: 50,
      fromAlt: CRUISE_ALT - 5, toAlt: 50,
      fromGspd: 60, toGspd: 55, hdg: 180, pitch: -0.05, roll: 0 },

    // 146–158  final turn (180°→90°), continuing descent
    { dur: 12, mode: 'ANGL', kind: 'arc',
      centerE: -380, centerN: 50, R: TURN_R, startPhi: 270, endPhi: 180,
      fromAlt: 50, toAlt: APPROACH_START, gspd: 50, pitch: -0.05, roll: -0.30 },

    // 158–215  final approach (east), descending to flare height. Slight
    // crosstrack offset (+3 N) so the landing isn't pixel-perfectly aligned
    // with the takeoff line — feels more like a real flight.
    { dur: 57, mode: 'ANGL', kind: 'line',
      fromE: -380, fromN: 0, toE: -25, toN: 2,
      fromAlt: APPROACH_START, toAlt: 3,
      fromGspd: 50, toGspd: 42, hdg: 90, pitch: -0.07, roll: 0 },

    // 215–225  flare + touchdown a few metres past the takeoff line
    { dur: 10, mode: 'LAND', kind: 'line',
      fromE: -25, fromN: 2, toE: 12, toN: 3,
      fromAlt: 3, toAlt: 0,
      fromGspd: 42, toGspd: 22, hdg: 90, pitch: 0.04, roll: 0 },

    // 225–240  ground roll, decel to stop ~35 m east of takeoff start
    { dur: 15, mode: 'LAND', kind: 'line',
      fromE: 12, fromN: 3, toE: 35, toN: 3,
      alt: 0, fromGspd: 22, toGspd: 0, hdg: 90, pitch: 0, roll: 0 },
  ]

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
    const curr = 7 + (gspd / 60) * 12 + (alt > 5 ? Math.sin(t * 0.4) * 1.5 : 0)
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
    const a = arcPoint(p.centerE, p.centerN, p.R, p.startPhi, p.endPhi, eu, true)
    return {
      E: a.E,
      N: a.N,
      alt: p.fromAlt != null ? lerp(p.fromAlt, p.toAlt, u) : p.alt,
      gspd: p.gspd,
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
