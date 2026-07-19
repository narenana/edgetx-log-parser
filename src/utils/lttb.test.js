import { describe, it, expect } from 'vitest'
import { lttbIndices, sharedLttbIndices, nearestPos } from './lttb'

describe('lttbIndices', () => {
  it('passes through when threshold >= length', () => {
    const idx = lttbIndices([1, 2, 3, 4], 10)
    expect(idx).toEqual([0, 1, 2, 3])
  })

  it('always keeps first and last points', () => {
    const values = Array.from({ length: 5000 }, (_, i) => Math.sin(i / 50))
    const idx = lttbIndices(values, 500)
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(4999)
    expect(idx.length).toBe(500)
  })

  it('returns strictly increasing indices', () => {
    const values = Array.from({ length: 3000 }, (_, i) => Math.cos(i / 30) * i)
    const idx = lttbIndices(values, 400)
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1])
    }
  })

  it('preserves an isolated extreme spike', () => {
    const values = new Array(10000).fill(0)
    values[6321] = 500 // a battery-sag-style spike
    const idx = lttbIndices(values, 300)
    expect(idx).toContain(6321)
  })

  it('tolerates null/NaN values', () => {
    const values = Array.from({ length: 2000 }, (_, i) =>
      i % 7 === 0 ? null : Math.sin(i / 20),
    )
    const idx = lttbIndices(values, 200)
    expect(idx.length).toBe(200)
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(1999)
  })
})

describe('sharedLttbIndices', () => {
  it('keeps each series peaks in the union', () => {
    const a = new Array(8000).fill(0)
    a[1111] = 100
    const b = new Array(8000).fill(0)
    b[5555] = -100
    const idx = sharedLttbIndices([a, b], 300)
    expect(idx).toContain(1111)
    expect(idx).toContain(5555)
    // sorted + deduped
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1])
    expect(idx.length).toBeLessThanOrEqual(600)
  })
})

describe('nearestPos', () => {
  const map = [0, 10, 20, 30, 40]
  it('finds exact positions', () => {
    expect(nearestPos(map, 20)).toBe(2)
    expect(nearestPos(map, 0)).toBe(0)
    expect(nearestPos(map, 40)).toBe(4)
  })
  it('rounds to the closest kept index', () => {
    expect(nearestPos(map, 14)).toBe(1)
    expect(nearestPos(map, 16)).toBe(2)
    expect(nearestPos(map, 999)).toBe(4)
  })
})
