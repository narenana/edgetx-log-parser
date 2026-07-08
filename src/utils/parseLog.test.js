import { describe, it, expect } from 'vitest'
import { parseGPS } from './parseLog'

describe('parseGPS', () => {
  it('parses a "lat lon" pair', () => {
    expect(parseGPS('12.9716 77.5946')).toEqual([12.9716, 77.5946])
  })
  it('treats "0.0 0.0" as no-fix (not Null Island)', () => {
    // EdgeTX logs 0,0 before the GPS acquires a fix; without this the
    // home cell + distance stats absorb an ~8,600 km hop.
    expect(parseGPS('0.0 0.0')).toEqual([null, null])
    expect(parseGPS('0 0')).toEqual([null, null])
  })
  it('returns nulls for empty / malformed / missing input', () => {
    expect(parseGPS('')).toEqual([null, null])
    expect(parseGPS('abc def')).toEqual([null, null])
    expect(parseGPS('12.34')).toEqual([null, null])
    expect(parseGPS(null)).toEqual([null, null])
  })
})
