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
// Wider context: this is Phase A of the camera-director feature. The
// `compute` functions are pure — same inputs always give same outputs —
// so the future director can stitch them together via interpolation
// without state.

const D2R = Math.PI / 180

const CHASE_NEAR_M = 150
const CHASE_FAR_M = 600

const TAIL_RANGE_M = 80
const ORBIT_RANGE_M = 350
const TOPDOWN_RANGE_M = 400

const ORBIT_SWEEP_AMPL_DEG = 60
const ORBIT_SWEEP_PERIOD_S = 12

export const CAMERA_VIEWS = {
  // Locked-behind-the-tail follow camera. Range scales with speed and
  // altitude (existing CHASE logic) and we read the smoothed heading
  // because aircraft yaw is noisy on a fixed-wing trajectory.
  chase: {
    name: 'CHASE',
    description: 'Behind the tail, slightly above. Smoothed heading + dynamic distance.',
    compute: ({ smoothHdgDeg, smoothDistM }) => ({
      headingRad: ((smoothHdgDeg ?? 0) + 180) * D2R,
      pitchRad: -18 * D2R,
      rangeM: Number.isFinite(smoothDistM) ? smoothDistM : CHASE_FAR_M,
    }),
  },

  // Close, low — "you are the chase plane on its wing." Reads great
  // during high-speed straight-line stretches; can feel hectic in turns.
  tail: {
    name: 'TAIL',
    description: 'Close behind at low elevation — chase-plane feel.',
    compute: ({ aircraftHdgDeg }) => ({
      headingRad: ((aircraftHdgDeg ?? 0) + 180) * D2R,
      pitchRad: -5 * D2R,
      rangeM: TAIL_RANGE_M,
    }),
  },

  // Slow side-to-side azimuth sweep at a moderate elevation, revealing
  // the aircraft from each flank in turn. The sweep is a pure sine of
  // virtual time, so it stays smooth under any playback speed.
  orbit: {
    name: 'ORBIT',
    description: 'Slow ±60° flank sweep, 12 s period.',
    compute: ({ aircraftHdgDeg, vtSec }) => {
      const az =
        ORBIT_SWEEP_AMPL_DEG *
        Math.sin(((vtSec ?? 0) * Math.PI * 2) / ORBIT_SWEEP_PERIOD_S)
      return {
        headingRad: ((aircraftHdgDeg ?? 0) + 180 + az) * D2R,
        pitchRad: -35 * D2R,
        rangeM: ORBIT_RANGE_M,
      }
    },
  },

  // Bird's-eye view at a fixed offset above the aircraft. North-up. We
  // use −89° (not −90°) to avoid gimbal-lock degeneracies in Cesium's
  // HPR → quaternion conversion.
  topdown: {
    name: 'TOPDOWN',
    description: "Bird's eye, fixed offset above aircraft, north-up.",
    compute: () => ({
      headingRad: 0,
      pitchRad: -89 * D2R,
      rangeM: TOPDOWN_RANGE_M,
    }),
  },
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
