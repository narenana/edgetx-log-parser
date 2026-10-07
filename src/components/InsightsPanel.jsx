import { useState } from 'react'
import { track } from '../utils/analytics'

/**
 * Tabbed insights panel (Phase 1, 2026-10) — replaces the old right-column
 * mega-scroll (stats → debrief → five stacked charts). Two tabs:
 *   Summary — the AI flight read (hero) → flight stats → debrief findings
 *   Charts  — the synced metric charts
 *
 * The Summary pane stays MOUNTED (toggled with `hidden`) so the AI narration
 * a user generated survives a trip to Charts and back. The Charts pane mounts
 * only while active — Chart.js mis-sizes if it first lays out inside a
 * display:none container, and the charts carry no state worth preserving
 * (cursor is prop-driven from Dashboard), so a fresh mount each visit is both
 * correct and cheap.
 *
 * It's a pure shell: the parent composes the `summary` and `charts` nodes.
 */
export default function InsightsPanel({ summary, charts }) {
  const [tab, setTab] = useState('summary')

  const select = next => {
    if (next === tab) return
    setTab(next)
    track('insights_tab', { tab: next })
  }

  return (
    <div className="insights">
      <div className="insights-tabs" role="tablist" aria-label="Flight insights">
        <button
          type="button" role="tab" id="tab-summary" aria-controls="pane-summary"
          aria-selected={tab === 'summary'}
          className={`insights-tab${tab === 'summary' ? ' active' : ''}`}
          onClick={() => select('summary')}
        >
          Summary
        </button>
        <button
          type="button" role="tab" id="tab-charts" aria-controls="pane-charts"
          aria-selected={tab === 'charts'}
          className={`insights-tab${tab === 'charts' ? ' active' : ''}`}
          onClick={() => select('charts')}
        >
          Charts
        </button>
      </div>

      <div className="insights-body">
        <div
          id="pane-summary" role="tabpanel" aria-labelledby="tab-summary"
          className="insights-pane insights-summary" hidden={tab !== 'summary'}
        >
          {summary}
        </div>
        {tab === 'charts' && (
          <div
            id="pane-charts" role="tabpanel" aria-labelledby="tab-charts"
            className="insights-pane insights-charts"
          >
            {charts}
          </div>
        )}
      </div>
    </div>
  )
}
