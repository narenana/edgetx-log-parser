import { track } from '../utils/analytics'

/**
 * Flight-highlight chips — a small cluster over the map/globe stage. Each chip
 * is a notable moment (highest, fastest, farthest, peak current — whatever the
 * log supports). Clicking one jumps the playhead to ~10 s before the moment,
 * plays the approach, and drops a labelled marker on the timeline. Works over
 * both the 3D globe and the classic map (it's a Dashboard-level overlay).
 */
export default function HighlightChips({ highlights, onPlay }) {
  if (!highlights || !highlights.length) return null
  return (
    <div
      className="hl-chips"
      aria-label="Flight highlights"
      onMouseDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
    >
      {highlights.map(h => (
        <button
          key={h.key}
          type="button"
          className="hl-chip"
          title={`Jump to the ${h.label.toLowerCase()} point (${h.value} ${h.unit}) and play the 10 s approach`}
          onClick={() => {
            track('highlight_play', { key: h.key })
            onPlay(h)
          }}
        >
          <span className="hl-chip-ico" aria-hidden="true">{h.icon}</span>
          <span className="hl-chip-label">{h.label}</span>
          <span className="hl-chip-val">
            {h.value}
            <span className="hl-chip-unit">{h.unit}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
