import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react'
import { parseEdgeTXLog } from './utils/parseLog'
import { parseBlackboxBuffer, looksLikeBlackbox } from './utils/parseBlackbox'
import { loadLogFromUrl } from './utils/loadLogFromUrl'
import { initAnalytics, getConsent, track } from './utils/analytics'
import ConsentBanner from './components/ConsentBanner'
import ThemeToggle from './components/ThemeToggle'
import FlightSummaryModal from './components/FlightSummaryModal'

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

// Turn a filename stem into a readable label: strip a leading "sample-"
// and replace hyphens with spaces (e.g. "sample-fixed-wing" → "Fixed wing").
function prettyModel(base) {
  const cleaned = base.replace(/^sample-/i, '')
  if (!cleaned) return base
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).replace(/-/g, ' ')
}

function shortName(filename) {
  const base = filename.replace(/\.(csv|bbl|bfl|txt)$/i, '')
  // EdgeTX names look like "Model-2026-04-26-101500" → show "Model 10:15".
  // Anything else (blackbox dumps, arbitrary names) keeps a readable
  // basename rather than blindly slicing the last two hyphen tokens as
  // date+time — which used to turn "log.bbl" into " :" and even the two
  // shipped demos ("sample-fixed-wing") into "sample wi:ng".
  const m = base.match(/^(.*)-\d{4}-\d{2}-\d{2}-(\d{2})(\d{2})\d{2}$/)
  if (m) return `${prettyModel(m[1])} ${m[2]}:${m[3]}`
  return prettyModel(base)
}

// Built-in demo flights — both shipped under public/ and routed via
// loadLogFromUrl. The `sample_type` ends up in GA4 so we can see which
// demo people actually try first.
const SAMPLES = {
  'fixed-wing': {
    url: './sample-fixed-wing.csv',
    displayName: 'sample-fixed-wing.csv',
    icon: '✈',
    title: 'Fixed-wing flight',
    sub: 'iNAV · cross-country',
  },
  'quad': {
    url: './sample-quad.csv',
    displayName: 'sample-quad.csv',
    icon: '⌖',
    title: '5″ quad flight',
    sub: 'Betaflight · freestyle',
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
  // Set of log filenames whose pre-flight summary modal has been dismissed.
  // Lifted to App so the modal stays dismissed across tab switches (which
  // remount Dashboard via key={log.filename}).
  const [dismissedSummaries, setDismissedSummaries] = useState(() => new Set())
  // Active parse state — populated while a blackbox file is in flight on
  // the worker. The page would otherwise look frozen since the user just
  // dropped a file but no log has appeared yet. { filename, stage, pct }.
  const [parsing, setParsing] = useState(null)
  // Set by an &autoplay=1 deep link: the next Dashboard mount starts
  // playback immediately (consumed once via onAutoPlayConsumed).
  const [autoPlayArmed, setAutoPlayArmed] = useState(false)
  // View mode lives here (lifted from Dashboard) so the header can host the
  // Classic / 3D-Globe segmented control — the redesign folds the old 44px
  // view-toggle band into the top bar to give the globe that vertical space.
  const [viewMode, setViewMode] = useState(2) // 1 = classic, 2 = 3D globe
  const fileInputRef = useRef(null)

  // Apply the theme to <html data-theme="..."> + persist. CSS variables
  // overridden under [data-theme="light"] / [data-theme="dark"] flip
  // automatically when the attribute changes.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('theme', theme) } catch { /* ignore */ }
    // Keep the mobile browser chrome (theme-color) in sync with the active
    // theme — it was a static dark value that tinted the URL bar dark over
    // the default light app.
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f5f7fb' : '#11151c')
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
    let anyMatched = false
    for (const file of files) {
      const lower = file.name.toLowerCase()
      const looksCsv = lower.endsWith('.csv')
      const looksBblExt = lower.endsWith('.bbl') || lower.endsWith('.bfl') || lower.endsWith('.txt')
      // .bbl/.bfl are unambiguously binary blackbox; .txt is ambiguous
      // (iNAV text blackbox vs an EdgeTX text export) so it stays on the
      // sniff-then-CSV fallback path below.
      const looksBinBlackbox = lower.endsWith('.bbl') || lower.endsWith('.bfl')
      if (!looksCsv && !looksBblExt) continue
      anyMatched = true
      try {
        // For ambiguous extensions (`.txt` is used by both EdgeTX text
        // logs and iNAV blackbox), sniff the first bytes for the
        // blackbox magic header before committing to a parser. CSVs
        // never start with that string.
        const buf = await file.arrayBuffer()
        const u8 = new Uint8Array(buf)
        let log
        if (looksBblExt && looksLikeBlackbox(u8)) {
          // Blackbox parsing runs on a Web Worker — the binary parse +
          // field mapping is multi-second work that would otherwise
          // freeze the UI. Surface progress to the loading overlay so
          // the user sees movement instead of a hung tab. Diag messages
          // accumulate in the parsing object so the modal can render
          // them inline — useful for debugging without DevTools.
          setParsing({ filename: file.name, stage: 'parsing', pct: 0, diag: [] })
          log = await parseBlackboxBuffer(
            u8,
            file.name,
            (stage, pct) => {
              setParsing(p => (p ? { ...p, stage, pct } : p))
            },
            line => {
              setParsing(p =>
                p ? { ...p, diag: [...(p.diag || []), line].slice(-20) } : p,
              )
            },
          )
          track('log_loaded', { source: 'file', format: 'blackbox' })
        } else if (looksBinBlackbox) {
          // Extension says blackbox but the magic header is missing — do
          // NOT fall through to the CSV parser on binary bytes (which
          // produces nonsense). Most likely truncated or unsupported FW.
          throw new Error('not a valid blackbox log (missing header) — it may be truncated or from an unsupported firmware')
        } else {
          // Text decoding only on the CSV path — blackbox is binary.
          const text = new TextDecoder('utf-8').decode(u8)
          log = parseEdgeTXLog(text, file.name)
        }
        results.push(log)
      } catch (e) {
        setError(`Failed to parse ${file.name}: ${e.message}`)
      } finally {
        setParsing(null)
      }
    }
    if (!anyMatched && files.length) {
      setError('Unsupported file type. Drop an EdgeTX .csv or an iNAV / Betaflight blackbox (.bbl, .bfl, .txt).')
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

  // Deep links (growth plan §quick-wins):
  //   ?log=<url>            — replay a remote log (CORS-permitting hosts,
  //                           e.g. GitHub raw/gist, work today)
  //   ?sample=fixed-wing|quad — load a built-in demo flight
  //   &autoplay=1           — skip the summary modal and start playback,
  //                           so a shared link is "watch a flight in 5s"
  // Query params (not paths) deliberately dodge the Vite base:'./' +
  // Worker path-mount caveat documented in vite.config.js.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const autoplay = params.get('autoplay') === '1'
    const arm = log => {
      if (autoplay) {
        dismissSummary(log.filename)
        setAutoPlayArmed(true)
      }
      appendLog(log)
    }
    const remote = params.get('log')
    const sampleKind = params.get('sample')
    if (remote) {
      loadLogFromUrl(remote)
        .then(log => {
          track('log_loaded', { source: 'shared-url' })
          arm(log)
        })
        .catch(e => setError(`Failed to load shared log: ${e.message}`))
    } else if (sampleKind && SAMPLES[sampleKind]) {
      loadLogFromUrl(SAMPLES[sampleKind].url, { displayName: SAMPLES[sampleKind].displayName })
        .then(log => {
          track('log_loaded', { source: 'sample', sample_type: sampleKind, deep_link: true })
          arm(log)
        })
        .catch(e => setError(`Failed to load ${sampleKind} sample: ${e.message}`))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const closeAt = useCallback(idx => {
    setLogs(prev => {
      const next = prev.filter((_, i) => i !== idx)
      setActiveIndex(i => Math.min(i, Math.max(next.length - 1, 0)))
      return next
    })
  }, [])

  const closeTab = (e, idx) => {
    e.stopPropagation()
    closeAt(idx)
  }

  const dismissSummary = useCallback(filename => {
    setDismissedSummaries(prev => {
      if (prev.has(filename)) return prev
      const next = new Set(prev)
      next.add(filename)
      return next
    })
  }, [])

  const activeLog = logs[activeIndex]

  return (
    <div
      className="app"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <header className="header">
        <span className="header-logo">RC Log Viewer</span>

        {logs.length > 0 && (
          <div className="tabs">
            {logs.map((log, i) => (
              <div
                key={i}
                className={`tab${i === activeIndex ? ' active' : ''}`}
                onClick={() => setActiveIndex(i)}
                title={log.filename}
              >
                {shortName(log.filename)}
                <span className="tab-close" onClick={e => closeTab(e, i)}>
                  ×
                </span>
              </div>
            ))}
          </div>
        )}

        {activeLog && (
          <div className="view-seg" role="group" aria-label="View mode">
            <button
              type="button"
              className={`view-seg-btn${viewMode === 1 ? ' active' : ''}`}
              onClick={() => { if (viewMode !== 1) { setViewMode(1); track('view_changed', { mode: 'classic' }) } }}
              aria-pressed={viewMode === 1}
              title="2D map + attitude panel"
            >
              Classic
            </button>
            <button
              type="button"
              className={`view-seg-btn${viewMode === 2 ? ' active' : ''}`}
              onClick={() => { if (viewMode !== 2) { setViewMode(2); track('view_changed', { mode: 'globe' }) } }}
              aria-pressed={viewMode === 2}
              title="3D globe with satellite imagery"
            >
              3D&nbsp;Globe
            </button>
          </div>
        )}

        <ThemeToggle theme={theme} onToggle={toggleTheme} />

        <button className="open-btn" onClick={() => fileInputRef.current.click()}>
          Open logs
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.bbl,.bfl,.txt"
          multiple
          style={{ display: 'none' }}
          onChange={onFileInput}
        />
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="error-banner-dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {activeLog ? (
        <Suspense fallback={<div className="lazy-fallback">Loading viewer…</div>}>
          <Dashboard
            key={activeLog.filename}
            log={activeLog}
            theme={theme}
            viewMode={viewMode}
            autoPlay={autoPlayArmed}
            onAutoPlayConsumed={() => setAutoPlayArmed(false)}
          />
        </Suspense>
      ) : (
        <div className={`drop-overlay${isDragOver ? ' drag-over' : ''}`}>
          <div className="drop-icon">✈</div>
          {/* h1 (not div) so the pre-JS static shell in index.html and the
              mounted app agree on the page's single H1. */}
          <h1 className="drop-title">RC Log Viewer</h1>
          <div className="drop-sub">
            Drop a flight log here, or click below to open one
          </div>

          {/* Single primary CTA — clear hierarchy: this is what users
              should reach for. Samples are presented separately below. */}
          <button
            className="drop-btn drop-btn-primary"
            onClick={() => fileInputRef.current.click()}
          >
            Open log files
          </button>

          <div className="drop-formats">
            Supports EdgeTX CSV · iNAV / Betaflight blackbox (.bbl, .bfl, .txt)
          </div>

          {/* Separator labels the next section so users don't read the
              sample cards as if they were primary features. */}
          <div className="drop-divider">
            <span>Or try a sample flight</span>
          </div>

          <div className="drop-samples">
            {Object.entries(SAMPLES).map(([kind, s]) => (
              <button
                key={kind}
                className="sample-card"
                onClick={() => loadSample(kind)}
                disabled={!!loadingSample}
                aria-label={`Load sample: ${s.title}`}
              >
                <span className="sample-card-icon" aria-hidden="true">
                  {s.icon}
                </span>
                <span className="sample-card-text">
                  <span className="sample-card-title">
                    {loadingSample === kind ? 'Loading…' : s.title}
                  </span>
                  <span className="sample-card-sub">{s.sub}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="drop-privacy">
            Logs are parsed in your browser — nothing is uploaded.
          </div>
        </div>
      )}

      {/* App-level FlightSummaryModal covers both flows:
            (a) BBL parse — appears the moment a file is dropped, driven
                by real worker `progress` events while the parser runs.
            (b) Sync CSV — appears once the log is in the array.
          Stable `key` on the active filename keeps the modal mounted
          across the parsing→log transition so the checklist smoothly
          fades into the summary grid instead of remounting.
          Held back by `dismissedSummaries` so re-selecting a previously
          dismissed log doesn't re-pop the modal. */}
      {(() => {
        const target = parsing?.filename ?? activeLog?.filename
        if (!target) return null
        if (dismissedSummaries.has(target)) return null
        return (
          <FlightSummaryModal
            key={target}
            parsing={parsing && parsing.filename === target ? parsing : null}
            log={activeLog && activeLog.filename === target ? activeLog : null}
            onProceed={() => dismissSummary(target)}
            onCloseLog={() => closeAt(activeIndex)}
          />
        )
      })()}

      <ConsentBanner />

      {PwaUpdate && (
        <Suspense fallback={null}>
          <PwaUpdate />
        </Suspense>
      )}
    </div>
  )
}
