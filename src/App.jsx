import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react'
import { parseEdgeTXLog } from './utils/parseLog'
import { loadLogFromUrl } from './utils/loadLogFromUrl'
import { initAnalytics, getConsent, track } from './utils/analytics'
import ConsentBanner from './components/ConsentBanner'
import ThemeToggle from './components/ThemeToggle'

// Dashboard pulls in Chart.js, Leaflet, Three.js, plus its own lazy children
// (GlobeView, AltitudeAttitudeView). Splitting it off keeps the empty-state
// bundle small for first paint — empty state needs only React + the parser.
const Dashboard = lazy(() => import('./components/Dashboard'))

// PwaUpdate imports `virtual:pwa-register/react` which only exists when
// vite-plugin-pwa is enabled (web builds). The lazy import keeps the
// module out of the desktop bundle entirely.
const IS_WEB = import.meta.env.VITE_BUILD_TARGET === 'web'
const PwaUpdate = IS_WEB
  ? lazy(() => import('./components/PwaUpdate'))
  : null

function modelName(filename) {
  return filename.replace(/\.csv$/i, '').replace(/-\d{4}-\d{2}-\d{2}-\d{6}$/, '')
}

function shortName(filename) {
  const base = filename.replace(/\.csv$/i, '')
  const parts = base.split('-')
  // last 2 parts are date + time, skip them; format as "model HH:MM"
  const time = parts[parts.length - 1]
  const hh = time.slice(0, 2)
  const mm = time.slice(2, 4)
  const name = parts.slice(0, -2).join('-')
  return `${name} ${hh}:${mm}`
}

// Built-in demo flights — both shipped under public/ and routed via
// loadLogFromUrl. The `sample_type` ends up in GA4 so we can see which
// demo people actually try first.
const SAMPLES = {
  'fixed-wing': {
    url: './sample-fixed-wing.csv',
    displayName: 'sample-fixed-wing.csv',
    label: '✈ Try fixed wing',
  },
  'quad': {
    url: './sample-quad.csv',
    displayName: 'sample-quad.csv',
    label: '⌖ Try 5″ quad',
  },
}

// Read the user's saved theme choice. Default to 'light' for new visitors;
// keep 'dark' available via the toggle. The choice is mirrored to the
// `data-theme` attribute on <html> so [data-theme="light"] / [data-theme="dark"]
// CSS overrides take effect.
function readInitialTheme() {
  try {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* private mode etc. */ }
  return 'light'
}

export default function App() {
  const [logs, setLogs] = useState([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState(null)
  const [loadingSample, setLoadingSample] = useState(null) // 'fixed-wing' | 'quad' | null
  const [theme, setTheme] = useState(readInitialTheme)
  const fileInputRef = useRef(null)

  // Apply the theme to <html data-theme="..."> + persist. CSS variables
  // overridden under [data-theme="light"] / [data-theme="dark"] flip
  // automatically when the attribute changes.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('theme', theme) } catch { /* ignore */ }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(t => {
      const next = t === 'light' ? 'dark' : 'light'
      track('theme_changed', { theme: next })
      return next
    })
  }, [])

  const appendLog = useCallback(log => {
    setLogs(prev => {
      const next = [...prev, log]
      setActiveIndex(next.length - 1)
      return next
    })
  }, [])

  // If consent was granted on a previous visit, init analytics on mount.
  // (New visitors stay opted-out until they accept via the banner.)
  useEffect(() => {
    if (getConsent() === 'granted') initAnalytics()
  }, [])

  const loadFiles = useCallback(async files => {
    setError(null)
    const results = []
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.csv')) continue
      try {
        const text = await file.text()
        const log = parseEdgeTXLog(text, file.name)
        results.push(log)
      } catch (e) {
        setError(`Failed to parse ${file.name}: ${e.message}`)
      }
    }
    if (results.length) {
      track('log_loaded', { source: 'file', count: results.length })
      setLogs(prev => {
        const next = [...prev, ...results]
        setActiveIndex(next.length - 1)
        return next
      })
    }
  }, [])

  const loadSample = useCallback(async (kind) => {
    const sample = SAMPLES[kind]
    if (!sample) return
    setError(null)
    setLoadingSample(kind)
    try {
      const log = await loadLogFromUrl(sample.url, { displayName: sample.displayName })
      track('log_loaded', { source: 'sample', sample_type: kind })
      appendLog(log)
    } catch (e) {
      setError(`Failed to load ${kind} sample: ${e.message}`)
    } finally {
      setLoadingSample(null)
    }
  }, [appendLog])

  // Phase-2 share hook: ?log=<url> auto-loads a remote CSV on mount.
  // Disabled by default until we ship a backend; the parser stays the same.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const remote = params.get('log')
    if (!remote) return
    loadLogFromUrl(remote)
      .then(log => {
        track('log_loaded', { source: 'shared-url' })
        appendLog(log)
      })
      .catch(e => setError(`Failed to load shared log: ${e.message}`))
  }, [appendLog])

  const onDrop = useCallback(
    e => {
      e.preventDefault()
      setIsDragOver(false)
      loadFiles([...e.dataTransfer.files])
    },
    [loadFiles]
  )

  const onDragOver = e => {
    e.preventDefault()
    setIsDragOver(true)
  }
  const onDragLeave = () => setIsDragOver(false)

  const onFileInput = e => {
    loadFiles([...e.target.files])
    e.target.value = ''
  }

  const closeTab = (e, idx) => {
    e.stopPropagation()
    setLogs(prev => {
      const next = prev.filter((_, i) => i !== idx)
      setActiveIndex(i => Math.min(i, Math.max(next.length - 1, 0)))
      return next
    })
  }

  const activeLog = logs[activeIndex]

  return (
    <div
      className="app"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <header className="header">
        <span className="header-logo">EdgeTX Viewer</span>

        {logs.length > 0 && (
          <div className="tabs">
            {logs.map((log, i) => (
              <div
                key={i}
                className={`tab${i === activeIndex ? ' active' : ''}`}
                onClick={() => setActiveIndex(i)}
              >
                {shortName(log.filename)}
                <span className="tab-close" onClick={e => closeTab(e, i)}>
                  ×
                </span>
              </div>
            ))}
          </div>
        )}

        <ThemeToggle theme={theme} onToggle={toggleTheme} />

        <button className="open-btn" onClick={() => fileInputRef.current.click()}>
          Open logs
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          multiple
          style={{ display: 'none' }}
          onChange={onFileInput}
        />
      </header>

      {error && (
        <div
          style={{
            background: '#2d1b1e',
            color: '#f7768e',
            padding: '6px 14px',
            fontSize: 12,
            borderBottom: '1px solid #414868',
          }}
        >
          {error}
          <span
            style={{ marginLeft: 8, cursor: 'pointer', opacity: 0.6 }}
            onClick={() => setError(null)}
          >
            ×
          </span>
        </div>
      )}

      {activeLog ? (
        <Suspense fallback={<div className="lazy-fallback">Loading viewer…</div>}>
          <Dashboard key={activeLog.filename} log={activeLog} theme={theme} />
        </Suspense>
      ) : (
        <div className={`drop-overlay${isDragOver ? ' drag-over' : ''}`}>
          <div className="drop-icon">✈</div>
          <div className="drop-title">EdgeTX Log Viewer</div>
          <div className="drop-sub">
            Drop EdgeTX CSV log files here, or click to browse
          </div>
          <div className="drop-actions">
            <button className="drop-btn" onClick={() => fileInputRef.current.click()}>
              Open log files
            </button>
            <button
              className="drop-btn drop-btn-secondary"
              onClick={() => loadSample('fixed-wing')}
              disabled={!!loadingSample}
            >
              {loadingSample === 'fixed-wing' ? 'Loading…' : SAMPLES['fixed-wing'].label}
            </button>
            <button
              className="drop-btn drop-btn-secondary"
              onClick={() => loadSample('quad')}
              disabled={!!loadingSample}
            >
              {loadingSample === 'quad' ? 'Loading…' : SAMPLES['quad'].label}
            </button>
          </div>
          <div style={{ marginTop: 8, color: 'var(--text3)', fontSize: 11 }}>
            Supports iNAV · Betaflight · Basic receiver logs
          </div>
          <div style={{ marginTop: 4, color: 'var(--text3)', fontSize: 11, opacity: 0.7 }}>
            Logs are parsed in your browser — nothing is uploaded.
          </div>
        </div>
      )}

      <ConsentBanner />

      {PwaUpdate && (
        <Suspense fallback={null}>
          <PwaUpdate />
        </Suspense>
      )}
    </div>
  )
}
