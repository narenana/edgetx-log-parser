/**
 * Main-thread shim for the blackbox parser. All real work happens in
 * `blackbox-worker.js` so the UI thread stays responsive while a 50 MB
 * BBL parses + maps in the background.
 *
 * Vite's `?worker` suffix tells the bundler to compile this file's
 * import target as a separate worker chunk — the WASM binary travels
 * with it. No special config beyond what's already in `vite.config.js`.
 *
 * The worker is instantiated once per page load and reused across all
 * subsequent loads. WASM init (~20 ms) happens on first message, not
 * on every parse.
 */

// v0.1.1 NOTE: temporarily running the parser on the main thread instead
// of in a Web Worker. The bundler-target WASM module's top-level-await
// init was hanging silently inside the worker context — a known sharp
// edge of vite-plugin-top-level-await + worker bundles, where init can
// stall before the worker's `message` handler even registers.
//
// Trade-off: drag-and-drop will briefly block the UI thread during parse
// (~1-2 s with the Float64Array fast path on a 5 MB log). Worth it to
// get a working pipeline in the user's hands; we'll layer the worker
// back on once we understand exactly why init was hanging.

import { parseBlackbox as wasmParseBlackbox } from 'blackbox-parser'
import { mapToViewerLog } from './blackbox-mapper'

const BLACKBOX_MAGIC = 'H Product:Blackbox'
export function looksLikeBlackbox(uint8) {
  if (!uint8 || uint8.length < BLACKBOX_MAGIC.length) return false
  for (let i = 0; i < BLACKBOX_MAGIC.length; i++) {
    if (uint8[i] !== BLACKBOX_MAGIC.charCodeAt(i)) return false
  }
  return true
}

const TARGET_MAIN_FRAMES = 8000
const APPROX_BYTES_PER_FRAME = 60

/**
 * Parse a blackbox log buffer (main-thread for now — see note above).
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {(stage: string, pct: number) => void} [onProgress]
 * @param {(line: string) => void} [onDiag]
 */
export async function parseBlackboxBuffer(bytes, filename, onProgress, onDiag) {
  const t0 = performance.now()
  const diag = msg => {
    const line = `+${(performance.now() - t0).toFixed(0)}ms ${msg}`
    if (onDiag) onDiag(line)
    console.log('[bb-parse]', line)
  }

  diag(`received ${filename} (${bytes.length.toLocaleString()} bytes)`)

  const estimatedFrames = bytes.length / APPROX_BYTES_PER_FRAME
  const stride = Math.max(1, Math.round(estimatedFrames / TARGET_MAIN_FRAMES))
  diag(`stride=${stride} (≈${Math.round(estimatedFrames).toLocaleString()} frames est.)`)

  if (onProgress) onProgress('parsing', 10)

  // Yield to the event loop so React renders the modal before the
  // (potentially blocking) WASM call. Without this the modal won't even
  // paint the "parsing" step until after the parse finishes.
  await new Promise(r => setTimeout(r, 0))

  const tParse = performance.now()
  const parsed = wasmParseBlackbox(bytes, stride)
  diag(`wasmParseBlackbox returned in ${(performance.now() - tParse).toFixed(0)}ms`)

  if (onProgress) onProgress('mapping', 60)
  // Yield again so the bar animation updates before the mapping loop.
  await new Promise(r => setTimeout(r, 0))

  const tMap = performance.now()
  const log = mapToViewerLog(parsed, filename, diag)
  diag(`mapToViewerLog returned in ${(performance.now() - tMap).toFixed(0)}ms, rows=${log.rows.length}`)

  parsed.free()
  if (onProgress) onProgress('done', 100)
  return log
}
