/**
 * Main-thread shim for the blackbox parser.
 *
 * Spawns a Web Worker (see `blackbox-worker.js`) on first call and
 * routes all parsing through it. The worker's message handler is
 * registered before WASM init starts, so the worker can reply with
 * `ready` + `diag` events even while it's still initializing — gives us
 * an early failure signal if init hangs.
 *
 * If the worker doesn't say `ready` within 4 s we assume it's wedged
 * and fall back to parsing on the main thread (briefly blocking the
 * UI but at least the user gets a result).
 */

import init, { parseBlackbox as wasmParseBlackbox } from 'blackbox-parser'
import wasmUrl from 'blackbox-parser/blackbox_parser_bg.wasm?url'
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
  // Try the worker first.
  try {
    const { worker, ready } = getWorker()
    await ready
    return await parseViaWorker(worker, bytes, filename, onProgress, onDiag)
  } catch (err) {
    if (onDiag) onDiag(`worker unavailable: ${err.message}; falling back to main thread`)
    // Worker dead — fall back so the user still gets a result.
    return parseOnMainThread(bytes, filename, onProgress, onDiag)
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
