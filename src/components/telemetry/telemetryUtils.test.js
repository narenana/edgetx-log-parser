import { describe, it, expect } from 'vitest'
import {
  rowIndexAtTime,
  sampleWindow,
  sparkPoints,
  distMeters,
  bearingDeg,
  stickOffsets,
} from './telemetryUtils'

const rows = [0, 1, 2, 3, 4].map(t => ({ _tSec: t, v: t * 10 }))

describe('rowIndexAtTime', () => {
  it('returns -1 for empty rows', () => {
    expect(rowIndexAtTime([], 5)).toBe(-1)
  })
  it('clamps before start and after end', () => {
    expect(rowIndexAtTime(rows, -100)).toBe(0)
    expect(rowIndexAtTime(rows, 999)).toBe(4)
  })
  it('finds the row at-or-before the time (floor)', () => {
    expect(rowIndexAtTime(rows, 0)).toBe(0)
    expect(rowIndexAtTime(rows, 2)).toBe(2)
    expect(rowIndexAtTime(rows, 2.9)).toBe(2)
    expect(rowIndexAtTime(rows, 3)).toBe(3)
  })
  it('handles a single-row array', () => {
    const one = [{ _tSec: 5 }]
    expect(rowIndexAtTime(one, 0)).toBe(0)
    expect(rowIndexAtTime(one, 10)).toBe(0)
  })
})

describe('sampleWindow', () => {
  it('returns n+1 flight-time samples ending at tEnd', () => {
    const out = sampleWindow(rows, 4, 4, 4, r => r.v) // t = 0,1,2,3,4
    expect(out).toHaveLength(5)
    expect(out).toEqual([0, 10, 20, 30, 40])
  })
  it('clamps samples before the log start to the first row', () => {
    const out = sampleWindow(rows, 1, 4, 2, r => r.v) // t = -3, -1, 1
    expect(out[0]).toBe(0) // clamped to first row's value
    expect(out[out.length - 1]).toBe(10)
  })
  it('emits NaN where the getter has no value', () => {
    const out = sampleWindow(rows, 4, 2, 2, r => r.missing)
    expect(out.every(Number.isNaN)).toBe(true)
  })
})

describe('sparkPoints', () => {
  it('auto-scales to the value range and returns a points string', () => {
    const { points, min, max } = sparkPoints([0, 5, 10], 20, 10)
    expect(min).toBe(0)
    expect(max).toBe(10)
    expect(points.split(' ')).toHaveLength(3)
  })
  it('returns empty points when everything is NaN', () => {
    const { points } = sparkPoints([NaN, NaN], 20, 10)
    expect(points).toBe('')
  })
})

describe('distMeters / bearingDeg', () => {
  it('measures ~111 km per degree near the equator', () => {
    expect(distMeters(0, 0, 0, 1)).toBeGreaterThan(111000)
    expect(distMeters(0, 0, 0, 1)).toBeLessThan(111500)
    expect(distMeters(1, 1, 1, 1)).toBe(0)
  })
  it('points N/E/S/W correctly', () => {
    expect(bearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 1) // north
    expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 1) // east
    expect(bearingDeg(0, 0, -1, 0)).toBeCloseTo(180, 1) // south
    expect(bearingDeg(0, 0, 0, -1)).toBeCloseTo(270, 1) // west
  })
})

describe('stickOffsets — sign conventions (pinned)', () => {
  it('returns null when no channel is present', () => {
    expect(stickOffsets({})).toBeNull()
  })
  it('throttle 100 → dot at top (ly = -1); 0 → bottom; 50 → centre', () => {
    expect(stickOffsets({ throttle: 100 }).ly).toBeCloseTo(-1)
    expect(stickOffsets({ throttle: 0 }).ly).toBeCloseTo(1)
    expect(stickOffsets({ throttle: 50 }).ly).toBeCloseTo(0)
  })
  it('pitch +50 → dot moves away from pilot (up on screen, ry < 0)', () => {
    expect(stickOffsets({ pitch: 50 }).ry).toBeCloseTo(-0.5)
    expect(stickOffsets({ pitch: -50 }).ry).toBeCloseTo(0.5)
  })
  it('roll right / yaw are +X to the right', () => {
    expect(stickOffsets({ roll: 100 }).rx).toBeCloseTo(1)
    expect(stickOffsets({ yaw: -100 }).lx).toBeCloseTo(-1)
  })
  it('clamps out-of-range inputs', () => {
    expect(stickOffsets({ throttle: 150 }).ly).toBeCloseTo(-1)
    expect(stickOffsets({ roll: 999 }).rx).toBeCloseTo(1)
  })
  it('reports per-channel presence flags', () => {
    const o = stickOffsets({ throttle: 20 })
    expect(o.hasThr).toBe(true)
    expect(o.hasRoll).toBe(false)
    expect(o.hasPitch).toBe(false)
    expect(o.hasYaw).toBe(false)
  })
})
