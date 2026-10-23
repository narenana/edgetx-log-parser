import { lazy } from 'react'
import { reportChunkLoadFailed } from './sentry'

// A failed dynamic import is almost always a STALE CLIENT after a deploy: the
// cached index.html points at an old chunk hash that the new build has already
// replaced, so `import()` 404s (Sentry RC-LOG-VIEWER-P/Q — Firefox, old
// releases). Recover by reloading once to pull the fresh index.html + new
// hashes. A sessionStorage flag prevents a reload loop when the chunk is
// genuinely unreachable (offline / real 404): after one reload we report it as
// a persistent failure and rethrow so the error boundary shows a message.
const isChunkLoadError = (e) => {
  const m = String((e && e.message) || e || '')
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed/i.test(m)
}

/**
 * React.lazy with stale-deploy self-healing.
 * @param {() => Promise<any>} factory  the `() => import('…')`
 * @param {string} key                  stable id for the reload guard (per chunk)
 */
export function lazyWithReload(factory, key) {
  const flag = 'chunkReload:' + key
  return lazy(() =>
    factory()
      .then((m) => {
        try { sessionStorage.removeItem(flag) } catch { /* private mode */ }
        return m
      })
      .catch((err) => {
        let reloaded = false
        try { reloaded = sessionStorage.getItem(flag) === '1' } catch { /* private mode */ }
        if (isChunkLoadError(err)) {
          if (!reloaded) {
            try { sessionStorage.setItem(flag, '1') } catch { /* private mode */ }
            location.reload()
            return new Promise(() => {}) // hold the import open until the reload lands
          }
          // Already reloaded once and still failing → a real, persistent problem.
          reportChunkLoadFailed(key)
        }
        throw err
      }),
  )
}
