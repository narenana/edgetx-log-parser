// Camera-view vocabulary for GlobeView's auto / director modes.
//
// Each view is a `compute(ctx)` function that takes the current aircraft
// state and returns Cesium HeadingPitchRange params (radians, metres).
// The lookAt target is always the aircraft's path-following position;
// only heading / pitch / distance vary per view.
//
// Conventions used here:
//   - "Aircraft heading" = compass bearing the nose points along (deg).
//   - "Behind aircraft" in HeadingPitchRange terms = camera positioned
//     at aircraft_hdg + 180 from the aircraft (i.e. compass bearing FROM
//     aircraft TO camera).
//   - Pitch is the angle of the camera below the line from camera to
//     target. Camera ABOVE aircraft looking down → NEGATIVE Cesium pitch.
//
// User zoom: `smoothDistM` carries the user's wheel-zoom intent. CHASE's
// rangeM IS `smoothDistM` directly, which means the auto camera defaults
// to `DEFAULT_CHASE_M` and shrinks/grows on wheel scroll. Other views
// scale their base range by `smoothDistM / DEFAULT_CHASE_M`, so a wheel
// scroll in one view zooms ALL views by the same proportion. View
// character (TAIL is closer than ORBIT, ORBIT closer than TOPDOWN) is
// preserved; only the absolute scale slides with the user's intent.
//
// Sky framing: the pitch / range a view returns places the CAMERA. Views
// marked `sky: true` are then aimed a little above the aircraft by
// frameForSky() (below), so the horizon sits about a third of the way down
// the canvas and the aircraft below centre. TOPDOWN is a map view and opts
// out.
//
// Wider context: this is Phase A of the camera-director feature. The
// `compute` functions are pure — same inputs always give same outputs —
// so the future director can stitch them together via interpolation
// without state.

const D2R = Math.PI / 180

// Default camera-to-aircraft distance for the AUTO-follow chase view,
// before any user wheel zoom. Used by GlobeView as the seed value of
// `smooth.dist`. Other views scale relative to this.
//
// History: was 400 m through April 2026 — felt cramped on long fixed-
// wing flights ("want more context"); 700 m in PR #26 was too far at
// first paint; 500 m was the compromise. 2026-07: with the 3D-terrain
// upgrade the owner reported the aircraft reads too small at default
// zoom — 300 m makes the model the clear subject while the terrain
// still gives context (wheel zoom carries the user's intent anyway).
export const DEFAULT_CHASE_M = 300

// Per-view base ranges at zoom-factor = 1 (i.e. when smoothDistM ===
// DEFAULT_CHASE_M). When the user wheels, each view's actual rangeM is
// scaled by smoothDistM / DEFAULT_CHASE_M.
const TAIL_BASE_M = 150
const ORBIT_BASE_M = 500
const TOPDOWN_BASE_M = 800

// Line-of-sight pitch from the camera down to the aircraft, per view. These
// set where the camera SITS (height above the aircraft = range x sin pitch).
// 2026-10: shallower than the original CHASE -18 / ORBIT -35, which on a
// landscape canvas (vertical FOV 30-45 deg) put the horizon at or past the
// top edge, so there was no sky in frame (owner: "add the sky to the 3d
// render"). CHASE at 300 m still sits ~73 m above the aircraft, enough to
// read the track ahead.
export const CHASE_PITCH_DEG = -14
const TAIL_PITCH_DEG = -6
const ORBIT_PITCH_DEG = -16
const TOPDOWN_PITCH_DEG = -89

const ORBIT_SWEEP_AMPL_DEG = 60
const ORBIT_SWEEP_PERIOD_S = 12

// Returns the user's zoom factor (smoothDistM / DEFAULT_CHASE_M),
// clamped to a sane positive range so that arithmetic on rangeM can't
// blow up if smoothDistM is missing or NaN.
function userZoomFactor(smoothDistM) {
  if (!Number.isFinite(smoothDistM) || smoothDistM <= 0) return 1
  return smoothDistM / DEFAULT_CHASE_M
}

export const CAMERA_VIEWS = {
  // Locked-behind-the-tail follow camera. Range comes directly from
  // `smoothDistM` so wheel scroll feels 1:1 in the default view.
  chase: {
    name: 'CHASE',
    description: 'Behind and above the tail, horizon in view. Scroll to zoom.',
    sky: true,
    compute: ({ smoothHdgDeg, smoothDistM }) => ({
      headingRad: ((smoothHdgDeg ?? 0) + 180) * D2R,
      pitchRad: CHASE_PITCH_DEG * D2R,
      rangeM: Number.isFinite(smoothDistM) ? smoothDistM : DEFAULT_CHASE_M,
    }),
  },

  // Close, low — "you are the chase plane on its wing." Reads great
  // during high-speed straight-line stretches; can feel hectic in turns.
  tail: {
    name: 'TAIL',
    description: 'Close behind at low elevation — chase-plane feel.',
    sky: true,
    compute: ({ aircraftHdgDeg, smoothDistM }) => ({
      headingRad: ((aircraftHdgDeg ?? 0) + 180) * D2R,
      pitchRad: TAIL_PITCH_DEG * D2R,
      rangeM: TAIL_BASE_M * userZoomFactor(smoothDistM),
    }),
  },

  // Slow side-to-side azimuth sweep at a moderate elevation, revealing
  // the aircraft from each flank in turn. The sweep is a pure sine of
  // virtual time, so it stays smooth under any playback speed.
  orbit: {
    name: 'ORBIT',
    description: 'Slow ±60° flank sweep, 12 s period.',
    sky: true,
    compute: ({ aircraftHdgDeg, vtSec, smoothDistM }) => {
      const az =
        ORBIT_SWEEP_AMPL_DEG *
        Math.sin(((vtSec ?? 0) * Math.PI * 2) / ORBIT_SWEEP_PERIOD_S)
      return {
        headingRad: ((aircraftHdgDeg ?? 0) + 180 + az) * D2R,
        pitchRad: ORBIT_PITCH_DEG * D2R,
        rangeM: ORBIT_BASE_M * userZoomFactor(smoothDistM),
      }
    },
  },

  // Bird's-eye view at a fixed offset above the aircraft. North-up. We
  // use −89° (not −90°) to avoid gimbal-lock degeneracies in Cesium's
  // HPR → quaternion conversion. A map view: no sky by design, and the
  // aircraft stays centred (sky: false skips frameForSky).
  topdown: {
    name: 'TOPDOWN',
    description: "Bird's eye, fixed offset above aircraft, north-up.",
    sky: false,
    compute: ({ smoothDistM }) => ({
      headingRad: 0,
      pitchRad: TOPDOWN_PITCH_DEG * D2R,
      rangeM: TOPDOWN_BASE_M * userZoomFactor(smoothDistM),
    }),
  },
}

// ── Sky framing ─────────────────────────────────────────────────────────────
// Cesium's camera.lookAt() puts its target dead centre. With the camera
// pitched down at the aircraft that leaves the horizon high, and on a wide
// canvas off the top edge. frameForSky() keeps the camera exactly where the
// view placed it (same heading, same horizontal distance, same height) and
// only tilts the view up by an angle θ, by aiming at a point `liftM` metres
// straight above the aircraft:
//   - θ puts the horizon (pitch ≈ 0) at `horizonFromTop` of the canvas;
//   - θ is clamped so the aircraft never drops below `aircraftMaxFromTop`
//     (and never above centre, θ >= 0). On a short canvas the clamp wins and
//     the horizon rides a little higher instead.
// Screen maths for a pinhole camera: a point θ below the view axis lands at
// 0.5 + 0.5·tan θ / tan(fovy/2) of the height from the top.
export const SKY_HORIZON_FROM_TOP = 0.33
export const SKY_AIRCRAFT_MAX_FROM_TOP = 0.7

export function frameForSky(
  { pitchRad, rangeM },
  fovyRad,
  { horizonFromTop = SKY_HORIZON_FROM_TOP, aircraftMaxFromTop = SKY_AIRCRAFT_MAX_FROM_TOP } = {},
) {
  const unchanged = { pitchRad, rangeM, liftM: 0 }
  if (!(fovyRad > 0 && fovyRad < Math.PI) || !Number.isFinite(pitchRad) || !(rangeM > 0)) {
    return unchanged
  }
  const tanHalf = Math.tan(fovyRad / 2)
  const thetaMax = Math.atan((2 * aircraftMaxFromTop - 1) * tanHalf)
  const thetaHorizon = -pitchRad - Math.atan((1 - 2 * horizonFromTop) * tanHalf)
  const theta = Math.max(0, Math.min(thetaMax, thetaHorizon))
  if (!(theta > 0)) return unchanged
  const aimPitch = pitchRad + theta
  const horiz = rangeM * Math.cos(pitchRad) // camera's horizontal distance — unchanged
  const height = -rangeM * Math.sin(pitchRad) // camera height above the aircraft — unchanged
  return {
    pitchRad: aimPitch,
    rangeM: horiz / Math.cos(aimPitch),
    liftM: height + horiz * Math.tan(aimPitch),
  }
}

export function parseCameraViewFromUrl() {
  if (typeof window === 'undefined') return null
  try {
    const v = new URLSearchParams(window.location.search).get('camera')
    if (!v) return null
    const name = v.toLowerCase()
    return CAMERA_VIEWS[name] ? name : null
  } catch (_) {
    return null
  }
}
