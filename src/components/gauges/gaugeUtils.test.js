import { describe, it, expect } from 'vitest'
import { detectBatteryConfig, mapClamp, niceRoundMax, angleDelta } from './gaugeUtils'

const packRows = peak => [{ 'RxBt(V)': peak * 0.9 }, { 'RxBt(V)': peak }]

describe('detectBatteryConfig', () => {
  it('detects cell count from the peak voltage (4.05 V/cell heuristic)', () => {
    expect(detectBatteryConfig(packRows(12.4)).cells).toBe(3) // 3S
    expect(detectBatteryConfig(packRows(16.6)).cells).toBe(4) // 4S
    expect(detectBatteryConfig(packRows(24.7)).cells).toBe(6) // 6S
  })
  it('exposes the derived thresholds in volts', () => {
    const c = detectBatteryConfig(packRows(16.6))
    expect(c.full).toBeCloseTo(4 * 4.2)
    expect(c.low).toBeCloseTo(4 * 3.5)
    expect(c.detected).toBe(true)
  })
  it('reports not-detected (cells=1) when there is no battery telemetry', () => {
    const c = detectBatteryConfig([{ 'RxBt(V)': 0 }, {}])
    expect(c.detected).toBe(false)
    expect(c.cells).toBe(1)
  })
})

describe('mapClamp', () => {
  it('maps linearly within range', () => {
    expect(mapClamp(1500, 1000, 2000, 0, 100)).toBe(50)
  })
  it('clamps to the output bounds', () => {
    expect(mapClamp(500, 1000, 2000, 0, 100)).toBe(0)
    expect(mapClamp(2500, 1000, 2000, 0, 100)).toBe(100)
  })
  it('returns b0 for a degenerate input range', () => {
    expect(mapClamp(5, 10, 10, 0, 100)).toBe(0)
  })
})

describe('niceRoundMax', () => {
  it('rounds up to the next "nice" scale value', () => {
    expect(niceRoundMax(30)).toBe(50)
    expect(niceRoundMax(115)).toBe(150)
    expect(niceRoundMax(480)).toBe(500)
  })
  it('guards non-positive / non-finite input', () => {
    expect(niceRoundMax(0)).toBe(100)
    expect(niceRoundMax(NaN)).toBe(100)
  })
})

describe('angleDelta', () => {
  it('takes the shortest signed arc', () => {
    expect(angleDelta(350, 10)).toBe(20)
    expect(angleDelta(10, 350)).toBe(-20)
    expect(angleDelta(0, 90)).toBe(90)
  })
  it('resolves the 180° case to a bounded magnitude', () => {
    expect(Math.abs(angleDelta(0, 180))).toBe(180)
  })
})
