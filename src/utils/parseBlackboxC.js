/**
 * Lazy fallback parser using iNAV's C blackbox-tools compiled to WASM
 * (vendored at vendor/blackbox-parser-c/).
 *
 * Only loaded when the primary Rust→WASM parser rejects a file. The
 * Rust crate is faster and its bundle is the default for every page
 * load; this module is a separate Vite chunk that's fetched on demand.
 *
 * Output shape mirrors the Rust crate's `FlightLog` struct so the
 * existing `mapToViewerLog` adapter can consume it without changes —
 * `mainFieldNames` / `mainCols` / `mainTimes` (Float64Array) /
 * `mainFrames` (Float64Array, row-major), and the same trio for slow
 * + GPS streams.
 */

import wasmUrl from '../../vendor/blackbox-parser-c/blackbox.wasm?url'
import wasmModuleFactory from '../../vendor/blackbox-parser-c/blackbox.mjs'
import { mapToViewerLog } from './blackbox-mapper'

let modulePromise = null

/**
 * Boot the WASM module once and re-use it across calls. The Emscripten
 * runtime keeps growing memory as inputs require, so we don't need a
 * fresh instance per parse — but we DO need to call `bb_close()` after
 * each parse to release the parser's allocated buffers.
 */
function getModule() {
  if (!modulePromise) {
    modulePromise = wasmModuleFactory({
      // Hand the bytes to Emscripten directly — it would otherwise try
      // to fetch the URL (works in browsers, not in tests).
      locateFile: () => wasmUrl,
    })
  }
  return modulePromise
}

const TARGET_MAIN_FRAMES = 8000

/**
 * Parse a blackbox log via the C parser. Throws on hard failure (bad
 * file, OOM); returns a `FlightLog`-shaped object on success.
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {(stage: string, pct: number) => void} [onProgress]
 * @param {(line: string) => void} [onDiag]
 */
export async function parseBlackboxBufferC(bytes, filename, onProgress, onDiag) {
  const t0 = performance.now()
  const diag = msg => {
    const line = `+${(performance.now() - t0).toFixed(0)}ms ${msg} (C parser)`
    if (onDiag) onDiag(line)
    if (typeof console !== 'undefined') console.log('[bb-parse-c]', line)
  }

  diag(`received ${filename} (${bytes.length.toLocaleString()} bytes)`)
  if (onProgress) onProgress('parsing', 5)

  const m = await getModule()
  diag('WASM ready')

  // Stage bytes into the WASM heap so the C side can mmap them via MEMFS.
  const ptr = m._malloc(bytes.byteLength)
  m.HEAPU8.set(bytes, ptr)

  let ok = 0
  try {
    if (onProgress) onProgress('parsing', 30)
    const tParse = performance.now()
    ok = m._bb_open(ptr, bytes.byteLength)
    diag(`bb_open returned ${ok} in ${(performance.now() - tParse).toFixed(0)}ms`)
  } finally {
    m._free(ptr)
  }
  if (!ok) throw new Error('C parser rejected the file')

  if (onProgress) onProgress('mapping', 60)

  const parsed = readFlightLogFromWasm(m, diag)
  m._bb_close()
  diag(`extracted main=${parsed.mainTimes.length} slow=${parsed.slowTimes.length} gps=${parsed.gpsTimes.length}`)

  // Hand the FlightLog-shaped object through the same mapper the Rust
  // worker uses, so downstream code (Dashboard, Globe, charts) sees an
  // identical row schema regardless of which parser ran.
  const tMap = performance.now()
  const log = mapToViewerLog(parsed, filename, diag)
  diag(`mapToViewerLog returned in ${(performance.now() - tMap).toFixed(0)}ms, rows=${log.rows.length}`)

  if (onProgress) onProgress('done', 100)
  return log
}

/**
 * Read the parsed log's per-stream field schemas and frame buffers
 * out of WASM memory and shape it like the Rust crate's `FlightLog`.
 * One copy per stream into a JS-owned `Float64Array` — same model as
 * the Rust path. We don't keep the WASM-side buffers alive past the
 * `bb_close()` that follows.
 */
function readFlightLogFromWasm(m, diag) {
  const tExtract = performance.now()

  const main = readStream(m, 'main')
  const slow = readStream(m, 'slow')
  const gps = readStream(m, 'gps')

  diag(
    `extracted main=${main.times.length} slow=${slow.times.length} gps=${gps.times.length} ` +
      `in ${(performance.now() - tExtract).toFixed(0)}ms`,
  )

  return {
    firmware: m.UTF8ToString(m._bb_firmware_revision()),
    craftName: '',
    boardInfo: '',
    hasGps: gps.times.length > 0,

    mainFieldNames: main.names,
    mainFieldSigned: main.signed,
    mainFieldUnits: main.names.map(() => ''), // no unit info exposed yet
    mainCols: main.cols,
    mainTimes: main.times,
    mainFrames: main.frames,

    slowFieldNames: slow.names,
    slowFieldSigned: slow.signed,
    slowFieldUnits: slow.names.map(() => ''),
    slowCols: slow.cols,
    slowTimes: slow.times,
    slowFrames: slow.frames,

    gpsFieldNames: gps.names,
    gpsFieldSigned: gps.signed,
    gpsFieldUnits: gps.names.map(() => ''),
    gpsCols: gps.cols,
    gpsTimes: gps.times,
    gpsFrames: gps.frames,

    // The C parser doesn't expose `.free()` since we already called
    // `bb_close()` — keep it as a no-op so consumers that defensively
    // call .free() don't blow up.
    free: () => {},
  }
}

const STREAM_FN = {
  main: {
    fieldCount: '_bb_main_field_count',
    fieldName: '_bb_main_field_name',
    signedPtr: '_bb_main_field_signed_ptr',
    frameCount: '_bb_main_frame_count',
    framesPtr: '_bb_main_frames_ptr',
  },
  slow: {
    fieldCount: '_bb_slow_field_count',
    fieldName: '_bb_slow_field_name',
    signedPtr: '_bb_slow_field_signed_ptr',
    frameCount: '_bb_slow_frame_count',
    framesPtr: '_bb_slow_frames_ptr',
  },
  gps: {
    fieldCount: '_bb_gps_field_count',
    fieldName: '_bb_gps_field_name',
    signedPtr: '_bb_gps_field_signed_ptr',
    frameCount: '_bb_gps_frame_count',
    framesPtr: '_bb_gps_frames_ptr',
  },
}

/**
 * Pull one stream (main / slow / gps) out of WASM memory:
 *  - field name strings (UTF8 → JS strings, one per field)
 *  - signed flags (1 byte per field)
 *  - timestamps as a Float64Array — derived from the i64 time field at
 *    column 1; the Rust parser exposes them separately, here we just
 *    project from the row-major frames buffer
 *  - frames as a Float64Array (row-major, frame[i] starts at i*cols)
 */
function readStream(m, kind) {
  const fns = STREAM_FN[kind]
  const cols = m[fns.fieldCount]()
  if (cols <= 0) {
    return {
      cols: 0,
      names: [],
      signed: new Uint8Array(0),
      times: new Float64Array(0),
      frames: new Float64Array(0),
    }
  }

  const names = []
  for (let i = 0; i < cols; i++) {
    names.push(m.UTF8ToString(m[fns.fieldName](i)))
  }

  const signedPtr = m[fns.signedPtr]()
  const signed = new Uint8Array(m.HEAPU8.buffer, signedPtr, cols).slice()

  const frameCount = m[fns.frameCount]()
  if (frameCount <= 0) {
    return {
      cols,
      names,
      signed,
      times: new Float64Array(0),
      frames: new Float64Array(0),
    }
  }

  // The C side stores values as i64. JS chart code expects f64 for
  // frame data and f64 for timestamps. We materialise both:
  //   1. A BigInt64Array view onto the WASM heap (zero-copy).
  //   2. Copy into freshly-allocated Float64Arrays (JS-owned).
  // The Float64 representation loses precision past ±2^53 but iNAV
  // values (gyro counts, attitude deci-degrees, microsecond timestamps
  // up to ~285 years) all sit comfortably below that.
  const ptr = m[fns.framesPtr]()
  const total = frameCount * cols
  const i64 = new BigInt64Array(m.HEAP8.buffer, ptr, total)
  const frames = new Float64Array(total)
  const times = new Float64Array(frameCount)
  // Time field — column 0 for GPS frames (which use the standalone
  // 'time' field added relative to last main time), column 1 for
  // main + slow (which carry the FC's microsecond counter at index
  // FLIGHT_LOG_FIELD_INDEX_TIME = 1).
  const timeIdx = (kind === 'gps') ? 0 : 1
  for (let i = 0; i < total; i++) {
    frames[i] = Number(i64[i])
  }
  for (let f = 0; f < frameCount; f++) {
    times[f] = frames[f * cols + timeIdx]
  }

  return { cols, names, signed, times, frames }
}
