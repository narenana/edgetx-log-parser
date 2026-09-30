import { useMemo, useState, useCallback } from 'react'
import { TEMPLATES, checksFor, debriefAsText, formatEvidence } from '../debrief/templates.js'
import DebriefChart from './DebriefChart.jsx'
import { SEVERITY_RANK } from '../debrief/detectors.js'
import { track } from '../utils/analytics'
// Narration tier is web-only: Electron builds compile it out entirely
// (design invariant #7 — no /api/debrief string in the desktop bundle).
const IS_WEB = import.meta.env.VITE_BUILD_TARGET === 'web'
const NarrationSection = IS_WEB
  ? (await import('./NarrationSection.jsx')).default
  : null

/**
 * Flight Debrief panel — design rev 2 §7. Deterministic findings as
 * one-line rows that expand to evidence (numbers + sparkline + bench
 * checks). Everything renders from local data; nothing here talks to
 * the network (the AI narration tier is D2). Clean flights render as a
 * single ✓ strip; the panel auto-expands on CRITICAL only.
 */

const SEV_ICON = { critical: '⛔', warning: '⚠️', notice: '▲', info: 'ℹ' }
const SEV_LABEL = { critical: 'CRITICAL', warning: 'WARNING', notice: 'NOTICE', info: 'INFO' }


const fmtT = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

function evidencePairs(f) {
  return Object.entries(f.evidence || {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => formatEvidence(k, v))
}

export default function DebriefPanel({ log, onJumpToTime, forceOpen, onClose }) {
  const debrief = log.debrief
  const ackKey = `debrief-ack:${log.filename}`
  const [acked, setAcked] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(ackKey) || '[]')) } catch { return new Set() }
  })
  const [openIds, setOpenIds] = useState(() => new Set(
    (debrief?.findings || []).filter(f => f.severity === 'critical').map(f => f.id),
  ))
  const [copied, setCopied] = useState(false)

  const findings = useMemo(() => (debrief?.findings || []).map(f =>
    acked.has(f.id) && SEVERITY_RANK[f.severity] === SEVERITY_RANK.warning
      ? { ...f, severity: 'notice', _acked: true }
      : f,
  ), [debrief, acked])

  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, notice: 0 }
    for (const f of findings) if (c[f.severity] != null) c[f.severity]++
    return c
  }, [findings])

  const toggle = useCallback(id => {
    setOpenIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else { next.add(id); track('debrief_expanded') }
      return next
    })
  }, [])

  const ack = useCallback(id => {
    setAcked(prev => {
      const next = new Set(prev)
      next.add(id)
      try { localStorage.setItem(ackKey, JSON.stringify([...next])) } catch { /* private mode */ }
      return next
    })
  }, [ackKey])

  const copyText = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(debriefAsText(debrief, log.filename))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
      track('debrief_copied')
    } catch { /* clipboard unavailable */ }
  }, [debrief, log.filename])

  const copyCoords = useCallback(async fix => {
    try { await navigator.clipboard.writeText(`${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}`) } catch { /* ignore */ }
  }, [])

  const [selfOpen, setSelfOpen] = useState(false)

  if (!debrief) return null
  // Clean flights: the panel stays VISIBLE as a one-line strip and
  // expands in place (owner feedback 2026-09-29 — the badge-only entry
  // was "almost entirely hidden away").
  if (debrief.clean && !forceOpen && !selfOpen) {
    return (
      <section className="debrief-panel" aria-label="Flight Debrief">
        <button type="button" className="db-strip" onClick={() => { setSelfOpen(true); track('debrief_expanded') }}>
          <span className="db-title">FLIGHT DEBRIEF</span>
          <span className="db-chip ok">✓ Clean flight</span>
          <span className="db-strip-sub">all {debrief.coverage.ran.length} checks passed · view details</span>
          <span className="db-caret" aria-hidden="true">▸</span>
        </button>
      </section>
    )
  }

  const ctx = debrief.context
  const lastFix = debrief.local?.lastFix

  return (
    <section className="debrief-panel" aria-label="Flight Debrief">
      <div className="db-head">
        <span className="db-title">FLIGHT DEBRIEF</span>
        <span className="db-chips">
          {counts.critical > 0 && <span className="db-chip crit">{counts.critical} critical</span>}
          {counts.warning > 0 && <span className="db-chip warn">{counts.warning} warning</span>}
          {counts.notice > 0 && <span className="db-chip note">{counts.notice} notice</span>}
          {debrief.clean && <span className="db-chip ok">✓ clean</span>}
        </span>
        <button type="button" className="db-copy" onClick={copyText}>
          {copied ? 'Copied ✓' : 'Copy as text'}
        </button>
        {(forceOpen || selfOpen) && (
          <button type="button" className="db-close"
            onClick={() => { setSelfOpen(false); if (onClose) onClose() }} aria-label="Collapse debrief">✕</button>
        )}
      </div>

      <ul className="db-list">
        {findings.map(f => {
          const t = TEMPLATES[f.id]
          if (!t) return null
          const open = openIds.has(f.id)
          const pairs = evidencePairs(f)
          const checks = checksFor(f, ctx)
          const showFix = (f.id === 'E2' || f.id === 'E4') && lastFix
          return (
            <li key={f.id} className={`db-row sev-${f.severity}${open ? ' open' : ''}`}>
              <button type="button" className="db-row-head" onClick={() => toggle(f.id)} aria-expanded={open}>
                <span className="db-ico" aria-hidden="true">{SEV_ICON[f.severity]}</span>
                <span className="db-sev">{SEV_LABEL[f.severity]}</span>
                <span className="db-row-title">
                  {t.title}
                  {f.experimental && <span className="db-exp">experimental</span>}
                  {f._acked && <span className="db-exp">acknowledged</span>}
                </span>
                <span className="db-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div className="db-detail">
                  <p className="db-summary">{t.summary(f, ctx)}</p>
                  {f.spark && <DebriefChart spark={f.spark} />}
                  {showFix && (
                    <div className="db-lastfix">
                      <span className="db-lastfix-label">LAST KNOWN POSITION</span>
                      <span>
                        {lastFix.distKm != null && `${lastFix.distKm < 1 ? `${Math.round(lastFix.distKm * 1000)} m` : `${lastFix.distKm.toFixed(2)} km`} from launch`}
                        {lastFix.bearing != null && ` · bearing ${Math.round(lastFix.bearing)}°`}
                        {lastFix.alt != null && ` · ${Math.round(lastFix.alt)} m up`}
                      </span>
                      <span className="db-lastfix-btns">
                        <button type="button" onClick={() => copyCoords(lastFix)}>Copy coordinates</button>
                        <a href={`https://maps.google.com/?q=${lastFix.lat.toFixed(6)},${lastFix.lon.toFixed(6)}`}
                          target="_blank" rel="noopener noreferrer">Open in Google Maps ↗</a>
                      </span>
                      <span className="db-lastfix-note">Shown locally only — never leaves this page.</span>
                    </div>
                  )}
                  {pairs.length > 0 && (
                    <dl className="db-evidence">
                      {pairs.map(pair => (
                        <div key={pair.label}><dt>{pair.label}</dt><dd>{pair.text}</dd></div>
                      ))}
                    </dl>
                  )}
                  {checks.length > 0 && (
                    <ol className="db-checks">
                      {checks.map((c, i) => <li key={i}>{c}</li>)}
                    </ol>
                  )}
                  <div className="db-row-actions">
                    {f.t && onJumpToTime && (
                      <button type="button" onClick={() => onJumpToTime(f.t[0])}>
                        Jump to {fmtT(f.t[0])} ▸
                      </button>
                    )}
                    {f.ackable && !f._acked && (
                      <button type="button" onClick={() => ack(f.id)}>Expected for this craft</button>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {NarrationSection && <NarrationSection debrief={debrief} />}

      <div className="db-foot">
        <span>
          {debrief.coverage.skipped.length === 0
            ? `Ran all ${debrief.coverage.ran.length} checks`
            : ctx.source === 'edgetx-csv'
              ? `Ran all ${debrief.coverage.ran.length} checks this log type supports`
              : `Ran ${debrief.coverage.ran.length} checks (${debrief.coverage.skipped.length} need fields this log doesn't carry)`}
        </span>
        <span className="db-privacy">Analysed locally — your log never leaves this device.</span>
      </div>
    </section>
  )
}
