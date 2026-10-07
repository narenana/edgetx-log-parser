/**
 * Flight highlights — the notable moments of a flight: the argmax (not just the
 * max value) of each metric the loaded log supports. The map-view highlight
 * chips use these; clicking one seeks to ~10 s before the moment and plays the
 * approach. Each entry carries the ROW INDEX where it occurs — no argmax lives
 * anywhere else (the stats builders keep only the max value, discarding where).
 *
 * G-force is intentionally absent: no acceleration field reaches the row
 * objects (EdgeTX CSV has none; the blackbox accel isn't mapped onto rows), so
 * "based on what's available" means it simply doesn't appear.
 */

// Self-contained — the parsers each inline their own copy of this and don't
// export it.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * @returns {Array<{key, label, icon, value, unit, index, tSec}>}
 *   label/value/unit are display-ready; index/tSec drive the seek + marker.
 */
export function computeHighlights(log) {
  const rows = log?.rows
  if (!rows || !rows.length) return []

  const argmax = fn => {
    let bi = -1
    let bv = -Infinity
    for (let i = 0; i < rows.length; i++) {
      const v = fn(rows[i], i)
      if (v != null && Number.isFinite(v) && v > bv) {
        bv = v
        bi = i
      }
    }
    return bi >= 0 ? { index: bi, raw: bv, tSec: rows[bi]._tSec } : null
  }

  const out = []
  const add = (key, label, icon, m, value, unit) => {
    if (m) out.push({ key, label, icon, value, unit, index: m.index, tSec: m.tSec })
  }

  const alt = argmax(r => r['Alt(m)'])
  if (alt && alt.raw > 0) add('alt', 'Highest', '▲', alt, Math.round(alt.raw), 'm')

  if (log.hasGPS) {
    const spd = argmax(r => r['GSpd(kmh)'])
    if (spd && spd.raw > 0) add('spd', 'Fastest', '»', spd, Math.round(spd.raw), 'km/h')
  }

  if (log.hasCurrent) {
    const cur = argmax(r => r['Curr(A)'])
    if (cur && cur.raw > 0) add('cur', 'Peak current', '⚡', cur, Math.round(cur.raw), 'A')
  }

  if (log.hasGPS) {
    const home = rows.find(r => r._lat != null)
    if (home) {
      const far = argmax(r =>
        r._lat != null ? haversineKm(home._lat, home._lon, r._lat, r._lon) : null,
      )
      if (far && far.raw > 0.05) {
        const km = far.raw
        add(
          'far',
          'Farthest',
          '⌖',
          far,
          km < 1 ? Math.round(km * 1000) : Math.round(km * 10) / 10,
          km < 1 ? 'm' : 'km',
        )
      }
    }
  }

  return out
}
