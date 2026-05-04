import React from 'react'
import ReactDOM from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './App.css'
import App from './App'
import { initSentry, SentryErrorBoundary } from './utils/sentry'
import { bootGaDegraded } from './utils/analytics'

// Boot error reporting + analytics in their respective "degraded" modes
// before React renders. Both are no-ops if their env vars (VITE_SENTRY_DSN
// / VITE_GA_ID) are unset, so this is safe in dev and Electron.
//
// Sentry runs in always-anonymous mode (no PII, no IP, scrubbed URLs).
// Analytics runs in Consent Mode v2 cookieless-ping mode (anonymous
// aggregate hits, no _ga cookie). Both upgrade to fuller collection
// when the user clicks Accept on ConsentBanner.
initSentry()
bootGaDegraded()

// Fallback UI when an uncaught React render error reaches the boundary.
// We keep it minimal — a "something went wrong" panel with a reload
// button. The error has already been sent to Sentry by this point.
function ErrorFallback({ error, resetError }) {
  return (
    <div
      role="alert"
      style={{
        padding: '2rem',
        maxWidth: '40rem',
        margin: '4rem auto',
        fontFamily: 'system-ui, sans-serif',
        color: '#e6e6e6',
        background: '#1a1d23',
        border: '1px solid #2a2f37',
        borderRadius: '8px',
      }}
    >
      <h2 style={{ marginTop: 0 }}>Something broke</h2>
      <p>The viewer hit an unexpected error and can&apos;t continue. The crash has been reported anonymously so it can be fixed.</p>
      <p style={{ fontSize: '0.85rem', opacity: 0.7, fontFamily: 'monospace' }}>
        {error?.message || String(error)}
      </p>
      <button
        type="button"
        onClick={() => {
          resetError()
          window.location.reload()
        }}
        style={{
          padding: '0.5rem 1rem',
          background: '#3b82f6',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        Reload
      </button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SentryErrorBoundary fallback={ErrorFallback}>
      <App />
    </SentryErrorBoundary>
  </React.StrictMode>
)
