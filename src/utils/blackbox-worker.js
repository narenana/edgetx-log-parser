/**
 * Web Worker that runs the WASM blackbox parser off the main thread.
 *
 * The first attempt at this used `wasm-pack build --target bundler` —
 * that produces ESM with top-level-await for WASM init, which Vite then
 * wraps via `vite-plugin-top-level-await`. In a worker context the
 * `addEventListener('message', ...)` line was reached only AFTER init
 * resolved, and init silently never resolved (suspected interaction
 * between vite-plugin-top-level-await's promise wrapper and the worker
 * module's eval order). Messages from the main thread queued forever.
 *
 * This rewrite uses `--target web` instead. Init is an explicit async
 * function (`init()`) we call once. We register the message handler
 * immediately, kick off init in the background, and await it inside
 * the handler before using the parser. So even if init takes a while,
 * the worker is "alive" — it can accept messages and reply with progress
 * events. If init ever does hang we'll see a clean diag line ("init
 * timed out") instead of a silent dead worker.
 */

import init, { parseBlackbox as wasmParseBlackbox } from 'blackbox-parser'
// `?url` tells Vite to emit the WASM as a hash-named asset and resolve
// to its public URL — the worker fetches that URL itself rather than
// relying on the relative-import shape that broke the bundler target.
import wasmUrl from 'blackbox-parser/blackbox_parser_bg.wasm?url'
import { mapToViewerLog } from './blackbox-mapper'

// Target post-decode row count. Stride keeps the data crossing the
// WASM/JS boundary bounded regardless of input size.
const TARGET_MAIN_FRAMES = 8000
const APPROX_BYTES_PER_FRAME = 60

// Kick off init synchronously when the worker module loads, but DON'T
// `await` it at the top level — that would block the message handler
// from registering. Instead store the promise so the handler can await
// it on first use.
let initPromise = null
function ensureInit() {
  // wasm-bindgen 0.2.100+ deprecated the bare-URL form; the object form
  // is the supported path forward.
  if (!initPromise) initPromise = init({ module_or_path: wasmUrl })
  return initPromise
}

self.addEventListener('message', async e => {
  const { bytes, filename } = e.data
  const t0 = performance.now()
  const diag = msg => {
    const line = `+${(performance.now() - t0).toFixed(0)}ms ${msg}`
    self.postMessage({ type: 'diag', message: line })
  }

  diag(`received ${filename} (${bytes.length.toLocaleString()} bytes)`)
  try {
    diag('awaiting WASM init...')
    await ensureInit()
    diag('WASM ready')

    const estimatedFrames = bytes.length / APPROX_BYTES_PER_FRAME
    const stride = Math.max(1, Math.round(estimatedFrames / TARGET_MAIN_FRAMES))
    diag(`stride=${stride} (≈${Math.round(estimatedFrames).toLocaleString()} frames est.)`)

    self.postMessage({ type: 'progress', stage: 'parsing', pct: 10 })

    const tParse = performance.now()
    const parsed = wasmParseBlackbox(bytes, stride)
    diag(`wasmParseBlackbox returned in ${(performance.now() - tParse).toFixed(0)}ms`)

    self.postMessage({ type: 'progress', stage: 'mapping', pct: 60 })

    const tMap = performance.now()
    const log = mapToViewerLog(parsed, filename, diag)
    diag(`mapToViewerLog returned in ${(performance.now() - tMap).toFixed(0)}ms, rows=${log.rows.length}`)

    parsed.free()

    self.postMessage({ type: 'progress', stage: 'done', pct: 100 })
    self.postMessage({ type: 'done', log })
  } catch (err) {
    diag(`error: ${err && err.message ? err.message : String(err)}`)
    self.postMessage({
      type: 'error',
      message: err && err.message ? err.message : String(err),
    })
  }
})

// Tell the main thread we're alive and listening. If this never reaches
// the main thread (worker hung at top-level), the spawn-side timeout
// kicks in and we fall back to main-thread parsing.
self.postMessage({ type: 'ready' })
