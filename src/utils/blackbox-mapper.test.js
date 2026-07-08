import { describe, it, expect } from 'vitest'
import { mapToViewerLog } from './blackbox-mapper'

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
