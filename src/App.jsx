import { useState, useCallback, useEffect, useRef } from 'react'
import { parseEdgeTXLog } from './utils/parseLog'
import { loadLogFromUrl } from './utils/loadLogFromUrl'
import Dashboard from './components/Dashboard'

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

export default function App() {
  const [logs, setLogs] = useState([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState(null)
  const [loadingSample, setLoadingSample] = useState(false)
  const fileInputRef = useRef(null)

  const appendLog = useCallback(log => {
    setLogs(prev => {
      const next = [...prev, log]
      setActiveIndex(next.length - 1)
      return next
    })
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
      setLogs(prev => {
        const next = [...prev, ...results]
        setActiveIndex(next.length - 1)
        return next
      })
    }
  }, [])

  const loadSample = useCallback(async () => {
    setError(null)
    setLoadingSample(true)
    try {
      const log = await loadLogFromUrl('./sample-log.csv', { displayName: 'sample-flight.csv' })
      appendLog(log)
    } catch (e) {
      setError(`Failed to load sample: ${e.message}`)
    } finally {
      setLoadingSample(false)
    }
  }, [appendLog])

  // Phase-2 share hook: ?log=<url> auto-loads a remote CSV on mount.
  // Disabled by default until we ship a backend; the parser stays the same.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const remote = params.get('log')
    if (!remote) return
    loadLogFromUrl(remote)
      .then(appendLog)
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
        <Dashboard key={activeLog.filename} log={activeLog} />
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
              onClick={loadSample}
              disabled={loadingSample}
            >
              {loadingSample ? 'Loading…' : 'Try a sample flight'}
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
    </div>
  )
}
