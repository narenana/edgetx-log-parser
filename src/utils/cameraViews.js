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
// wing flights ("want more context"); 700 m in PR #26 was too far at
// first paint; 500 m was the compromise. 2026-07: with the 3D-terrain
// upgrade the owner reported the aircraft reads too small at default
// zoom — 300 m makes the model the clear subject while the terrain
// still gives context (wheel zoom carries the user's intent anyway).
export const DEFAULT_CHASE_M = 300

// Per-view base ranges at zoom-factor = 1 (i.e. when smoothDistM ===
// DEFAULT_CHASE_M). When the user wheels, each view's actual rangeM is
// scaled by smoothDistM / DEFAULT_CHASE_M.
// TAIL is the "formation / on-the-wing" view — pulled much closer and lower
// than CHASE so the five views read as genuinely distinct (owner: tail/chase/
// cinematic felt too alike).
const TAIL_BASE_M = 110
const ORBIT_BASE_M = 480
const TOPDOWN_BASE_M = 800
// Cinematic sits a touch CLOSER than CHASE and lower-angle for an intimate,
// film-like frame where the aircraft is clearly the subject; the trailing
// azimuth lag (applied in GlobeView) does the rest. (Was 450 m — the owner
// reported the aircraft read too small / too far to make out.)
const CINEMATIC_BASE_M = 240

// ORBIT now CIRCLES the aircraft continuously (owner: "orbit mode doesn't
// orbit" — the old ±60° sine sweep only rocked side-to-side, and being driven
// by virtual time it froze whenever playback was paused). It's driven by REAL
// time (`realMs`) so it keeps revolving even when paused, one full turn every
// ORBIT_PERIOD_S. GlobeView keeps the scene rendering while ORBIT is active.
const ORBIT_PERIOD_S = 18
const ORBIT_RATE_DEG_S = 360 / ORBIT_PERIOD_S
// CINEMATIC frames the aircraft from the rear QUARTER (not straight behind
// like CHASE/TAIL) for its own 3/4 look, on top of the trailing swing.
const CINEMATIC_OFFSET_DEG = 28

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
    description: 'Tight formation — close behind and nearly level, on its wing.',
    compute: ({ aircraftHdgDeg, smoothDistM }) => ({
      headingRad: ((aircraftHdgDeg ?? 0) + 180) * D2R,
      pitchRad: -2 * D2R,
      rangeM: TAIL_BASE_M * userZoomFactor(smoothDistM),
    }),
  },

  // Continuously CIRCLES the aircraft, revealing it from every side. Driven
  // by real wall-clock time (`realMs`), world-referenced, so it keeps turning
  // whether playback is running or paused. GlobeView keeps rendering while
  // this view is active so the revolution is visible at rest.
  orbit: {
    name: 'ORBIT',
    description: 'Circles the aircraft — one full revolution every 18 s, even when paused.',
    orbiting: true,
    compute: ({ realMs, smoothDistM }) => ({
      headingRad: (((realMs ?? 0) / 1000 * ORBIT_RATE_DEG_S) % 360) * D2R,
      pitchRad: -28 * D2R,
      rangeM: ORBIT_BASE_M * userZoomFactor(smoothDistM),
    }),
  },

  // Loose trailing chase — the "replay" camera. compute() returns the
  // IDEAL pose (directly behind the live nose, gentle downward tilt, a bit
  // further back than CHASE). The `trailing` flag tells GlobeView to ease
  // the AZIMUTH toward this heading with a frame-rate-independent lag, so
  // the camera swings in behind the aircraft on turns instead of snapping.
  // Only the azimuth trails — the lookAt target stays locked 1:1 to the
  // aircraft and pitch/range are constants, so there is no target-position
  // lerp and none of the speedFactor-amplified translation that caused the
  // historical chase-cam lurch.
  cinematic: {
    name: 'CINEMATIC',
    description: 'Loose trailing chase — swings in behind on turns with a gentle lag. Best for replay viewing.',
    trailing: true,
    compute: ({ aircraftHdgDeg, smoothDistM }) => ({
      headingRad: ((aircraftHdgDeg ?? 0) + 180 + CINEMATIC_OFFSET_DEG) * D2R,
      pitchRad: -11 * D2R,
      rangeM: CINEMATIC_BASE_M * userZoomFactor(smoothDistM),
      trailing: true,
    }),
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
