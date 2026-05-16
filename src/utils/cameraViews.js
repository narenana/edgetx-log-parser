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
// wing flights; user reported "want more context." Bumped to 700 m in
// PR #26, which the user then said was too far at first paint. 500 m
// is the compromise — visibly wider than the original 400 but close
// enough that the aircraft is still the obvious subject after the
// initial fly-to-bounding-box transitions to chase.
export const DEFAULT_CHASE_M = 500

// Per-view base ranges at zoom-factor = 1 (i.e. when smoothDistM ===
// DEFAULT_CHASE_M). When the user wheels, each view's actual rangeM is
// scaled by smoothDistM / DEFAULT_CHASE_M.
const TAIL_BASE_M = 150
const ORBIT_BASE_M = 600
const TOPDOWN_BASE_M = 800

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
    description: 'Behind the tail, slightly above. Smoothed heading + user-driven distance.',
    compute: ({ smoothHdgDeg, smoothDistM }) => ({
      headingRad: ((smoothHdgDeg ?? 0) + 180) * D2R,
      pitchRad: -18 * D2R,
      rangeM: Number.isFinite(smoothDistM) ? smoothDistM : DEFAULT_CHASE_M,
    }),
  },

  // Close, low — "you are the chase plane on its wing." Reads great
  // during high-speed straight-line stretches; can feel hectic in turns.
  tail: {
    name: 'TAIL',
    description: 'Close behind at low elevation — chase-plane feel.',
    compute: ({ aircraftHdgDeg, smoothDistM }) => ({
      headingRad: ((aircraftHdgDeg ?? 0) + 180) * D2R,
      pitchRad: -5 * D2R,
      rangeM: TAIL_BASE_M * userZoomFactor(smoothDistM),
    }),
  },

  // Slow side-to-side azimuth sweep at a moderate elevation, revealing
  // the aircraft from each flank in turn. The sweep is a pure sine of
  // virtual time, so it stays smooth under any playback speed.
  orbit: {
    name: 'ORBIT',
    description: 'Slow ±60° flank sweep, 12 s period.',
    compute: ({ aircraftHdgDeg, vtSec, smoothDistM }) => {
      const az =
        ORBIT_SWEEP_AMPL_DEG *
        Math.sin(((vtSec ?? 0) * Math.PI * 2) / ORBIT_SWEEP_PERIOD_S)
      return {
        headingRad: ((aircraftHdgDeg ?? 0) + 180 + az) * D2R,
        pitchRad: -35 * D2R,
        rangeM: ORBIT_BASE_M * userZoomFactor(smoothDistM),
      }
    },
  },

  // Bird's-eye view at a fixed offset above the aircraft. North-up. We
  // use −89° (not −90°) to avoid gimbal-lock degeneracies in Cesium's
  // HPR → quaternion conversion.
  topdown: {
    name: 'TOPDOWN',
    description: "Bird's eye, fixed offset above aircraft, north-up.",
    compute: ({ smoothDistM }) => ({
      headingRad: 0,
      pitchRad: -89 * D2R,
      rangeM: TOPDOWN_BASE_M * userZoomFactor(smoothDistM),
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
