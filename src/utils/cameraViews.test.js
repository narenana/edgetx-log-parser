import { describe, it, expect } from 'vitest'
import {
  CAMERA_VIEWS, DEFAULT_CHASE_M, frameForSky,
  SKY_HORIZON_FROM_TOP, SKY_AIRCRAFT_MAX_FROM_TOP,
} from './cameraViews'

const D2R = Math.PI / 180
// Vertical FOV Cesium derives from its 60° fov on a landscape canvas.
const fovyFor = (aspect) => 2 * Math.atan(Math.tan(30 * D2R) / aspect)

// Where on the canvas (0 = top, 1 = bottom) a point at elevation angle
// `elevRad` (from the camera, positive up) lands for a view pitched `aimRad`.
const fromTop = (elevRad, aimRad, fovy) => 0.5 - 0.5 * Math.tan(elevRad - aimRad) / Math.tan(fovy / 2)

// Camera offset from the aircraft (horizontal distance, height) implied by
// a lookAt at a target `liftM` above the aircraft with the given pitch/range.
const cameraOffset = ({ pitchRad, rangeM, liftM }) => ({
  horiz: rangeM * Math.cos(pitchRad),
  height: liftM - rangeM * Math.sin(pitchRad),
})

const chase = (dist = DEFAULT_CHASE_M) =>
  CAMERA_VIEWS.chase.compute({ smoothHdgDeg: 0, smoothDistM: dist })

describe('frameForSky', () => {
  // [label, canvas aspect, lowest acceptable horizon position from the top].
  // On the short phone strip the aircraft clamp wins and the horizon rides
  // higher than the one-third target, but still well inside the canvas.
  for (const [label, aspect, minHorizon] of [
    ['desktop panel', 819 / 579, SKY_HORIZON_FROM_TOP],
    ['phone landscape strip', 390 / 195, 0.2],
    ['fullscreen', 1366 / 900, SKY_HORIZON_FROM_TOP],
  ]) {
    it(`keeps the camera where the view put it (${label})`, () => {
      const fovy = fovyFor(aspect)
      for (const v of [chase(), chase(120), chase(1500)]) {
        const before = cameraOffset({ ...v, liftM: 0 })
        const after = cameraOffset(frameForSky(v, fovy))
        expect(after.horiz).toBeCloseTo(before.horiz, 6)
        expect(after.height).toBeCloseTo(before.height, 6)
      }
    })

    it(`puts sky in the top of the frame and the aircraft below centre (${label})`, () => {
      const fovy = fovyFor(aspect)
      const v = chase()
      const aim = frameForSky(v, fovy)
      const horizon = fromTop(0, aim.pitchRad, fovy)
      const aircraft = fromTop(v.pitchRad, aim.pitchRad, fovy)
      // The bug: the old CHASE (-18°, centred on the aircraft) left the
      // horizon in the top tenth of the canvas, or above it.
      expect(fromTop(0, -18 * D2R, fovy)).toBeLessThan(0.12)
      expect(horizon).toBeGreaterThan(fromTop(0, v.pitchRad, fovy))
      expect(horizon).toBeGreaterThanOrEqual(minHorizon - 1e-9)
      expect(horizon).toBeLessThan(0.45)
      expect(aircraft).toBeGreaterThan(0.5)
      expect(aircraft).toBeLessThanOrEqual(SKY_AIRCRAFT_MAX_FROM_TOP + 1e-9)
    })
  }

  it('lands the horizon exactly at the target when the aircraft clamp allows it', () => {
    const fovy = fovyFor(819 / 579)
    const aim = frameForSky(chase(), fovy)
    expect(fromTop(0, aim.pitchRad, fovy)).toBeCloseTo(SKY_HORIZON_FROM_TOP, 6)
    expect(aim.liftM).toBeGreaterThan(0)
  })

  it('leaves a view alone when the horizon is already low enough (TAIL on a tall canvas)', () => {
    const fovy = fovyFor(0.6) // portrait: Cesium's 60° becomes the vertical FOV
    const v = CAMERA_VIEWS.tail.compute({ aircraftHdgDeg: 0, smoothDistM: DEFAULT_CHASE_M })
    expect(frameForSky(v, fovy)).toEqual({ pitchRad: v.pitchRad, rangeM: v.rangeM, liftM: 0 })
  })

  it('passes bad input through unchanged', () => {
    const v = chase()
    for (const fovy of [undefined, NaN, 0, -1, Math.PI]) {
      expect(frameForSky(v, fovy)).toEqual({ pitchRad: v.pitchRad, rangeM: v.rangeM, liftM: 0 })
    }
    expect(frameForSky({ pitchRad: NaN, rangeM: 300 }, 0.7).liftM).toBe(0)
    expect(frameForSky({ pitchRad: -0.2, rangeM: 0 }, 0.7).liftM).toBe(0)
  })
})

describe('camera views', () => {
  it('only TOPDOWN opts out of sky framing', () => {
    expect(Object.entries(CAMERA_VIEWS).filter(([, v]) => !v.sky).map(([k]) => k)).toEqual(['topdown'])
  })

  it('follow views put sky in frame on a landscape panel', () => {
    const fovy = fovyFor(819 / 579)
    const ctx = { aircraftHdgDeg: 90, smoothHdgDeg: 90, smoothDistM: DEFAULT_CHASE_M, vtSec: 3 }
    for (const key of ['chase', 'tail', 'orbit']) {
      const v = CAMERA_VIEWS[key].compute(ctx)
      const aim = frameForSky(v, fovy)
      expect(fromTop(0, aim.pitchRad, fovy), key).toBeGreaterThan(0.25)
      expect(fromTop(v.pitchRad, aim.pitchRad, fovy), key).toBeLessThanOrEqual(SKY_AIRCRAFT_MAX_FROM_TOP + 1e-9)
    }
  })
})
