/**
 * Main-thread shim for the blackbox parser.
 *
 * Three layers, in order of preference:
 *
 *   1. Rust→WASM parser running in a Web Worker (default, fastest).
 *      Source: vendor/blackbox-parser/ (the `blackbox-log` Rust crate
 *      compiled to WASM via wasm-pack).
 *
 *   2. Same Rust parser on the main thread, used only when the Web
 *      Worker fails to spawn (CSP, timeout, OOM at worker boot).
 *      Briefly freezes the UI but at least the user gets a result.
 *
 *   3. iNAV's C blackbox-tools parser compiled with Emscripten. Loaded
 *      lazily — its bundle is fetched only after the Rust parser has
 *      rejected a file. Slower to first-parse on a fresh page (one-off
 *      WASM init) but accepts a wider range of iNAV variants. See
 *      `parseBlackboxC.js` and vendor/blackbox-parser-c/.
 *
 * The C fallback was added 2026-05-04 after an A/B run across 56 real
 * iNAV logs showed one (a MATEKF405SE on iNAV 8.0.0) that the Rust
 * parser rejects with `MalformedFrameDef(Intra)` but the C parser
 * opens cleanly. Rather than fork the Rust crate around upstream
 * issues, we keep both parsers and let the user fall through to C
 * when Rust says no.
 *
 * IMPORTANT: the *Rust main-thread* fallback (layer 2) only runs when
 * the worker fails to spawn. If the worker spawned fine and replied
 * with a parse error, we don't fall back to layer 2 — the bytes were
 * transferred via postMessage and the underlying ArrayBuffer is now
 * detached on the main thread, so re-parsing on this side throws
 * "detached ArrayBuffer" and masks the actual error from WASM. We
 * fall through to the C parser (layer 3) instead, using a copy of
 * the bytes kept aside before the worker transfer.
 */

import init, { parseBlackbox as wasmParseBlackbox } from 'blackbox-parser'
import wasmUrl from 'blackbox-parser/blackbox_parser_bg.wasm?url'
import { mapToViewerLog } from './blackbox-mapper'

/**
 * Translate raw WASM error strings into something a human can act on.
 * We keep the raw message available via diag (worker posts it before
 * the error event), so the throwaway-friendly version doesn't lose
 * info — just stops scaring users with Rust enum dumps.
 */
function friendlyErrorMessage(raw) {
  if (!raw || typeof raw !== 'string') return String(raw)
  // Header parse error: UnsupportedFirmwareVersion(Inav(FirmwareVersion { major: 9, minor: 0, patch: 1 }))
  const m = raw.match(
    /UnsupportedFirmwareVersion\((Inav|Betaflight|Cleanflight)\(FirmwareVersion \{ major: (\d+), minor: (\d+), patch: (\d+) \}\)\)/,
  )
  if (m) {
    const [, fw, maj, min, patch] = m
    const ceiling =
      fw === 'Inav' ? '8.x' : fw === 'Betaflight' ? '4.5.x' : 'this firmware'
    const fwDisplay = fw === 'Inav' ? 'iNAV' : fw
    return (
      `${fwDisplay} ${maj}.${min}.${patch} isn't supported by the parser yet ` +
      `(latest supported: ${ceiling}). The blackbox-log Rust crate behind ` +
      `the WASM module needs to be updated to recognise this firmware version.`
    )
  }
  return raw
}

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
const WORKER_READY_TIMEOUT_MS = 4000

// Singleton worker — survives across log loads so WASM init only pays
// once. Created lazily on first parse.
let workerInstance = null
let workerReadyPromise = null

function getWorker() {
  if (workerInstance) return { worker: workerInstance, ready: workerReadyPromise }

  // Vite's `?worker` suffix bundles the file as a separate worker chunk
  // and exports a constructor. Type=module gets us ES imports inside.
  const w = new Worker(new URL('./blackbox-worker.js', import.meta.url), {
    type: 'module',
  })
  workerInstance = w

  workerReadyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      w.removeEventListener('message', onReady)
      reject(new Error(`worker did not become ready in ${WORKER_READY_TIMEOUT_MS}ms`))
    }, WORKER_READY_TIMEOUT_MS)
    const onReady = e => {
      if (e.data && e.data.type === 'ready') {
        clearTimeout(timer)
        w.removeEventListener('message', onReady)
        resolve()
      }
    }
    w.addEventListener('message', onReady)
  })

  return { worker: w, ready: workerReadyPromise }
}

/**
 * Parse a blackbox log buffer.
 *
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @param {(stage: string, pct: number) => void} [onProgress]
 * @param {(line: string) => void} [onDiag]
 */
export async function parseBlackboxBuffer(bytes, filename, onProgress, onDiag) {
  // Keep a copy of the bytes before we hand them off — postMessage's
  // transfer list will detach the original. The C-parser fallback (and
  // any future re-attempt) needs a live buffer.
  const bytesForFallback = bytes.slice()

  // Stage 1: spawn the Rust-WASM worker and wait for it to declare ready.
  // If this part fails (timeout, CSP, OOM, …) the worker never received
  // bytes, so it's safe to fall back to the Rust main-thread parser
  // using the same buffer.
  let worker
  try {
    const w = getWorker()
    await w.ready
    worker = w.worker
  } catch (err) {
    if (onDiag) onDiag(`worker unavailable: ${err.message}; falling back to main thread`)
    try {
      return await parseOnMainThread(bytes, filename, onProgress, onDiag)
    } catch (mainErr) {
      // Rust main-thread parser also failed. Try the C parser.
      return await tryCFallback(bytesForFallback, filename, onProgress, onDiag, mainErr)
    }
  }

  // Stage 2: hand bytes to the worker (transfers + detaches the buffer).
  // If the worker emits a parse error, fall through to the C parser
  // with the saved-aside copy.
  try {
    return await parseViaWorker(worker, bytes, filename, onProgress, onDiag)
  } catch (err) {
    return await tryCFallback(bytesForFallback, filename, onProgress, onDiag, err)
  }
}

/**
 * Lazy-load and run the C parser. If it succeeds, return its result.
 * If it also fails, throw the *original* (Rust) error since that's the
 * one the user is most likely to recognise.
 */
async function tryCFallback(bytes, filename, onProgress, onDiag, primaryErr) {
  const primaryMsg = primaryErr && primaryErr.message ? primaryErr.message : String(primaryErr)
  if (onDiag) {
    onDiag(`primary parser failed: ${primaryMsg}`)
    onDiag('trying alternate parsing technique (C / iNAV blackbox-tools)…')
  }
  if (onProgress) onProgress('parsing', 5)

  let cFallback
  try {
    cFallback = await import('./parseBlackboxC.js')
  } catch (loadErr) {
    if (onDiag) onDiag(`alternate parser bundle failed to load: ${loadErr.message || loadErr}`)
    throw new Error(friendlyErrorMessage(primaryMsg))
  }

  try {
    const log = await cFallback.parseBlackboxBufferC(bytes, filename, onProgress, onDiag)
    if (onDiag) onDiag('alternate parser succeeded')
    return log
  } catch (cErr) {
    if (onDiag) onDiag(`alternate parser also failed: ${cErr.message || cErr}`)
    throw new Error(friendlyErrorMessage(primaryMsg))
  }
}

function parseViaWorker(worker, bytes, filename, onProgress, onDiag) {
  return new Promise((resolve, reject) => {
    const handler = e => {
      const msg = e.data
      if (!msg) return
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg.stage, msg.pct)
      } else if (msg.type === 'diag') {
        if (onDiag) onDiag(msg.message)
      } else if (msg.type === 'done') {
        worker.removeEventListener('message', handler)
        worker.removeEventListener('error', errHandler)
        resolve(msg.log)
      } else if (msg.type === 'error') {
        worker.removeEventListener('message', handler)
        worker.removeEventListener('error', errHandler)
        reject(new Error(msg.message))
      }
    }
    const errHandler = e => {
      worker.removeEventListener('message', handler)
      worker.removeEventListener('error', errHandler)
      reject(new Error(e.message || 'Worker crashed'))
    }
    worker.addEventListener('message', handler)
    worker.addEventListener('error', errHandler)
    // Transfer the buffer to avoid copying — the main thread no longer
    // needs the bytes once the worker has them.
    worker.postMessage({ bytes, filename }, [bytes.buffer])
  })
}

// Fallback path. Same code that previously lived inline; kept around so
// even if the worker can't spin up (rare cache state, broken extension,
// etc.) the user still gets their log open instead of a hang.
async function parseOnMainThread(bytes, filename, onProgress, onDiag) {
  const t0 = performance.now()
  const diag = msg => {
    const line = `+${(performance.now() - t0).toFixed(0)}ms ${msg} (main-thread fallback)`
    if (onDiag) onDiag(line)
    console.log('[bb-parse]', line)
  }

  diag(`received ${filename} (${bytes.length.toLocaleString()} bytes)`)
  await init({ module_or_path: wasmUrl })

  const estimatedFrames = bytes.length / APPROX_BYTES_PER_FRAME
  const stride = Math.max(1, Math.round(estimatedFrames / TARGET_MAIN_FRAMES))
  diag(`stride=${stride}`)

  if (onProgress) onProgress('parsing', 10)
  await new Promise(r => setTimeout(r, 0)) // let modal paint

  const parsed = wasmParseBlackbox(bytes, stride)
  diag(`wasmParseBlackbox returned in ${(performance.now() - t0).toFixed(0)}ms`)

  if (onProgress) onProgress('mapping', 60)
  await new Promise(r => setTimeout(r, 0))

  const log = mapToViewerLog(parsed, filename, diag)
  parsed.free()
  if (onProgress) onProgress('done', 100)
  return log
}
