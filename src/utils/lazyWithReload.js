import { lazy } from 'react'
import { reportChunkLoadFailed } from './sentry'

// A failed dynamic import is almost always a STALE CLIENT after a deploy: the
// cached index.html points at an old chunk hash that the new build has already
// replaced, so `import()` 404s (Sentry RC-LOG-VIEWER-P/Q — Firefox, old
// releases). Recover by reloading once to pull the fresh index.html + new
// hashes.
export const isChunkLoadError = (e) => {
  const m = String((e && e.message) || e || '')
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed/i.test(m)
}

/**
 * Decide whether to reload for a chunk failure — and claim the one-shot guard.
 * Returns true ONLY when a durable guard was persisted, so a chunk that fails
 * every time (a genuinely broken deploy) reloads at most once. If sessionStorage
 * is unavailable (some private modes / sandboxed frames) we must NOT reload: we
 * couldn't remember we tried, and a reload-every-time loop is far worse than an
 * error boundary. Already-guarded (second failure) also returns false.
 */
export function claimReloadGuard(flag) {
  try {
    if (sessionStorage.getItem(flag) === '1') return false // already reloaded once
    sessionStorage.setItem(flag, '1')
    return sessionStorage.getItem(flag) === '1' // only reload if the write actually stuck
  } catch {
    return false // storage unavailable → never risk a reload loop
  }
}

/**
 * React.lazy with stale-deploy self-healing. Happy path is identical to
 * `lazy(factory)` — the extra work only runs when the import fails.
 * @param {() => Promise<any>} factory  the `() => import('…')`
 * @param {string} key                  stable id for the reload guard (per chunk)
 */
export function lazyWithReload(factory, key) {
  const flag = 'chunkReload:' + key
  return lazy(() =>
    factory()
      .then((m) => {
        // Loaded cleanly → clear the guard so a future deploy can self-heal too.
        try { sessionStorage.removeItem(flag) } catch { /* storage unavailable */ }
        return m
      })
      .catch((err) => {
        if (isChunkLoadError(err) && claimReloadGuard(flag)) {
          location.reload()
          return new Promise(() => {}) // hold the import open until the reload lands
        }
        // Not a chunk error, already reloaded once, or no durable guard → surface
        // it (persistent chunk failures report distinctly) and let the boundary show.
        if (isChunkLoadError(err)) reportChunkLoadFailed(key)
        throw err
      }),
  )
}
