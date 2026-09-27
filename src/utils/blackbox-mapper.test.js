import { describe, it, expect } from 'vitest'
import { mapToViewerLog, sanitizeDecodedTimes } from './blackbox-mapper'

/**
 * Build a minimal fake of the WASM parser's FlightLog output so we can
 * exercise the REAL mapper without a WASM module or a log fixture.
 * `rows` is an array of per-field value arrays aligned to `fieldNames`.
 */
function makeParsed(fieldNames, rows, timesUs) {
  const cols = fieldNames.length
  const flat = new Float64Array(rows.length * cols)
  rows.forEach((r, i) => r.forEach((v, j) => { flat[i * cols + j] = v }))
  return {
    mainFieldNames: fieldNames,
    mainCols: cols,
    mainTimes: Float64Array.from(timesUs),
    mainFrames: flat,
    hasGps: false,
  }
}

const throttle = log => log.rows.map(r => r._throttle)

describe('mapToViewerLog — throttle (iNAV rcCommand[3] regression)', () => {
  it('prefers rcData[3] (raw stick) so motor-idle reads 0%, not ~8%', () => {
    // iNAV floors rcCommand[3] at minthrottle (~1080). rcData[3] is the
    // firmware-agnostic 1000..2000 stick channel; idle must be 0%.
    const fields = ['time', 'rcData[3]', 'rcCommand[3]']
    const log = mapToViewerLog(
      makeParsed(fields, [
        [0, 1000, 1080],   // idle: rcData 1000 → 0%  (rcCommand 1080 would give 8%)
        [500000, 1500, 1500],
        [1000000, 2000, 1998], // full → 100%
      ], [0, 500000, 1000000]),
      'iNAV.txt',
    )
    expect(throttle(log)).toEqual([0, 50, 100])
  })

  it('clamps raw stick over/undershoot into 0..100', () => {
    const fields = ['time', 'rcData[3]']
    const log = mapToViewerLog(
      makeParsed(fields, [[0, 989], [1, 2012]], [0, 500000]),
      'endpoints.txt',
    )
    expect(throttle(log)).toEqual([0, 100])
  })

  it('falls back to rcCommand[3] when rcData[3] is not logged', () => {
    const fields = ['time', 'rcCommand[3]']
    const log = mapToViewerLog(
      makeParsed(fields, [[0, 1000], [1, 1500]], [0, 500000]),
      'noRcData.txt',
    )
    expect(throttle(log)).toEqual([0, 50])
  })

  it('is null when neither throttle channel is present', () => {
    const log = mapToViewerLog(
      makeParsed(['time', 'vbat'], [[0, 1660]], [0]),
      'noThrottle.txt',
    )
    expect(log.rows[0]._throttle).toBeNull()
  })
})

describe('sanitizeDecodedTimes — corrupt-tail truncation', () => {
  // SD logs that end at a crash (power loss) have no "End of log"
  // marker and a preallocated tail of stale sectors; the decoder emits
  // a few garbage frames with random timestamps from that region.
  const s = 1e6 // one second in µs

  it('keeps a fully monotonic timeline untouched', () => {
    const t = Float64Array.from([0, s, 2 * s, 3 * s])
    expect(sanitizeDecodedTimes(t)).toBe(4)
    expect(Array.from(t)).toEqual([0, s, 2 * s, 3 * s])
  })

  it('truncates at a backwards jump (garbage tail frames)', () => {
    // Real flight ticking along at ~20 Hz, then junk frames at 77µs /
    // 73µs — the exact tail signature seen on a real crash log.
    const t = Float64Array.from([635.3e6, 635.35e6, 635.4e6, 77, 73])
    expect(sanitizeDecodedTimes(t)).toBe(3)
  })

  it('truncates at a wild forward jump not followed by sane cadence', () => {
    // Garbage timestamp that happens to land AHEAD of the real data,
    // then collapses — a single lookahead spots it.
    const t = Float64Array.from([0, s, 2 * s, 900e6, 12])
    expect(sanitizeDecodedTimes(t)).toBe(3)
  })

  it('truncates a lone forward-jump frame at the very end', () => {
    const t = Float64Array.from([0, s, 2 * s, 900e6])
    expect(sanitizeDecodedTimes(t)).toBe(3)
  })

  it('keeps a legit logging pause (gap resumes with normal cadence)', () => {
    // Blackbox-switch pause: minutes-long gap, but frames after it tick
    // normally, so the whole array stays.
    const t = Float64Array.from([0, s, 2 * s, 200e6, 200e6 + s, 200e6 + 2 * s])
    expect(sanitizeDecodedTimes(t)).toBe(6)
  })

  it('unwraps the 32-bit micros() rollover instead of truncating', () => {
    // micros() wraps every 2^32 µs ≈ 71.6 min. Times must come out
    // strictly increasing across the wrap.
    const W = 2 ** 32
    const t = Float64Array.from([W - 2 * s, W - s, 0.5 * s, 1.5 * s])
    expect(sanitizeDecodedTimes(t)).toBe(4)
    expect(Array.from(t)).toEqual([W - 2 * s, W - s, W + 0.5 * s, W + 1.5 * s])
  })
})

describe('mapToViewerLog — unterminated log (crash) end-to-end', () => {
  it('drops garbage tail frames so duration is positive and rows are clean', () => {
    const fields = ['time', 'attitude[0]']
    const log = mapToViewerLog(
      makeParsed(fields, [
        [0, 100],            // 10.0° roll
        [0, 150],
        [0, 200],
        [0, -31337],         // garbage frame from the stale tail
      ], [635.3e6, 635.8e6, 636.3e6, 77]),
      'crash.txt',
    )
    expect(log.rows).toHaveLength(3)
    expect(log.stats.duration).toBeCloseTo(1.0)
    expect(log.rows.every(r => Math.abs(r._rollDeg) <= 180)).toBe(true)
  })

  it('truncates garbage GPS frames so the last rows keep real coordinates', () => {
    // The gpsPtr walk advances while gpsTimes[ptr+1] <= tUs — junk
    // low-timestamp GPS frames at the tail would otherwise capture
    // every late row (the crash moment itself).
    const parsed = makeParsed(['time'], [[0], [0], [0]], [0, 1e6, 2e6])
    parsed.hasGps = true
    parsed.gpsCols = 3
    parsed.gpsFieldNames = ['GPS_coord[0]', 'GPS_coord[1]', 'GPS_fixType']
    parsed.gpsTimes = Float64Array.from([0, 2e6, 55]) // last one is garbage
    parsed.gpsFrames = Float64Array.from([
      // Synthetic coordinates (1e-7° units) — not from any real log.
      100000000, 200000000, 2,   // real fix: 10.0000, 20.0000
      100001000, 200001000, 2,   // real fix: 10.0001, 20.0001
      -999999999, 999999999, 2,  // garbage from stale tail
    ])
    const log = mapToViewerLog(parsed, 'gpsJunk.txt')
    expect(log.hasGPS).toBe(true)
    const last = log.rows[log.rows.length - 1]
    expect(last._lat).toBeCloseTo(10.0001, 3)
    expect(last._lon).toBeCloseTo(20.0001, 3)
  })
})

describe('mapToViewerLog — other unit conventions', () => {
  it('inverts iNAV pitch to aviation convention (nose-up positive)', () => {
    // iNAV logs attitude in deci-degrees, positive = nose DOWN.
    const log = mapToViewerLog(
      makeParsed(['time', 'attitude[1]'], [[0, 100]], [0]), // 10.0° nose-down
      'pitch.txt',
    )
    expect(log.rows[0]._pitchDeg).toBeCloseTo(-10)
  })

  it('scales vbat from centivolts to volts', () => {
    const log = mapToViewerLog(
      makeParsed(['time', 'vbat'], [[0, 1660]], [0]),
      'vbat.txt',
    )
    expect(log.rows[0]['RxBt(V)']).toBeCloseTo(16.6)
    expect(log.hasBattery).toBe(true)
  })
})
