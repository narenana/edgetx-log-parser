import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/**
 * Service-worker update toast — bottom-right.
 *
 * Two states:
 *   - needRefresh : a new SW is waiting. Show a card with "Refresh" /
 *                   "Later" buttons. Refresh calls updateServiceWorker(true)
 *                   which activates the new SW and reloads the page.
 *   - offlineReady: the SW has cached enough for offline use on first install.
 *                   Brief auto-dismissing toast so the user knows.
 *
 * Lazy-loaded by App.jsx only on web builds — `virtual:pwa-register/react`
 * doesn't exist when vite-plugin-pwa is disabled (desktop builds).
 */
export default function PwaUpdate() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl) {
      // Hourly check for a new build. Cheap (304 most of the time).
      if (typeof window === 'undefined') return
      setInterval(() => {
        navigator.serviceWorker?.getRegistration(swUrl).then(reg => reg?.update())
      }, 60 * 60 * 1000)
    },
  })

  // Auto-dismiss the offline-ready toast after 3 s.
  useEffect(() => {
    if (!offlineReady) return
    const id = setTimeout(() => setOfflineReady(false), 3000)
    return () => clearTimeout(id)
  }, [offlineReady, setOfflineReady])

  if (!needRefresh && !offlineReady) return null

  if (offlineReady && !needRefresh) {
    return (
      <div className="pwa-toast" role="status">
        <span className="pwa-toast-icon" aria-hidden="true">●</span>
        <span>Ready to use offline</span>
      </div>
    )
  }

  return (
    <div className="pwa-toast pwa-toast-update" role="dialog" aria-label="Update available">
      <div className="pwa-toast-body">A new version is ready.</div>
      <div className="pwa-toast-actions">
        <button
          type="button"
          className="pwa-toast-btn"
          onClick={() => setNeedRefresh(false)}
        >
          Later
        </button>
        <button
          type="button"
          className="pwa-toast-btn pwa-toast-btn-primary"
          onClick={() => updateServiceWorker(true)}
        >
          Refresh
        </button>
      </div>
    </div>
  )
}
