import { useState, useCallback, useRef } from 'react'
import { parseEdgeTXLog } from './utils/parseLog'
import { parseBlackbox, isBlackboxBuffer } from './utils/parseBlackbox'
import Dashboard from './components/Dashboard'

function shortName(filename) {
  // EdgeTX CSV: "ModelName-YYYY-MM-DD-HHMMSS.csv" → "ModelName HH:MM"
  const base = filename.replace(/\.csv$/i, '')
  const parts = base.split('-')
  if (parts.length >= 3) {
    const time = parts[parts.length - 1]
    const hh = time.slice(0, 2), mm = time.slice(2, 4)
    const name = parts.slice(0, -2).join('-')
    if (/^\d{6}$/.test(time)) return `${name} ${hh}:${mm}`
  }
  // Blackbox / generic: trim to 30 chars
  return filename.replace(/\.[^.]+$/, '').slice(0, 30)
}

export default function App() {
  const [logs, setLogs] = useState([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [error, setError] = useState(null)
  const fileInputRef = useRef(null)

  const loadFiles = useCallback(async files => {
    setError(null)
    const results = []
    for (const file of files) {
      const name = file.name.toLowerCase()
      try {
        if (name.endsWith('.csv')) {
          const text = await file.text()
          results.push(parseEdgeTXLog(text, file.name))
        } else if (name.endsWith('.bbl') || name.endsWith('.bfl') || name.endsWith('.txt')) {
          const arrayBuf = await file.arrayBuffer()
          const buf = new Uint8Array(arrayBuf)
          if (!isBlackboxBuffer(buf)) {
            // .txt that's not blackbox — try CSV
            const text = new TextDecoder().decode(buf)
            results.push(parseEdgeTXLog(text, file.name))
          } else {
            const logs = parseBlackbox(buf, file.name)
            if (!logs.length) throw new Error('No valid flight data found')
            results.push(...logs)
          }
        }
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
          accept=".csv,.bbl,.bfl,.txt"
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
            Drop EdgeTX CSV or Blackbox BBL/TXT log files here, or click to browse
          </div>
          <button className="drop-btn" onClick={() => fileInputRef.current.click()}>
            Open log files
          </button>
          <div style={{ marginTop: 8, color: 'var(--text3)', fontSize: 11 }}>
            Supports EdgeTX CSV · iNAV Blackbox · Betaflight Blackbox
          </div>
        </div>
      )}
    </div>
  )
}
