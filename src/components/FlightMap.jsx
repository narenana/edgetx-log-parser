import { useMemo, useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet'

export const FM_COLORS = {
  ANGL: '#9ece6a',
  RTH: '#f7768e',
  CRUZ: '#7dcfff',
  MANU: '#565f89',
  ACRO: '#ff9e64',
  HOLD: '#bb9af7',
  NAVWP: '#e0af68',
  POSHOLD: '#bb9af7',
  ALTHOLD: '#ff79c6',
  LAND: '#f7768e',
}
const DEFAULT_FM_COLOR = '#7aa2f7'

export function fmColor(mode) {
  return FM_COLORS[mode] || DEFAULT_FM_COLOR
}

function BoundsFitter({ bounds }) {
  const map = useMap()
  useEffect(() => {
    if (bounds && bounds.length >= 2) {
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 18 })
    }
  }, [map, bounds])
  return null
}

export default function FlightMap({ rows, cursorIndex }) {
  const gpsRows = useMemo(() => rows.filter(r => r._lat !== null), [rows])

  const segments = useMemo(() => {
    const segs = []
    let mode = null
    let seg = []
    let lastPt = null

    for (const row of rows) {
      if (row._lat == null) continue
      const pt = [row._lat, row._lon]
      const m = row['FM'] || 'UNKNOWN'

      if (m !== mode) {
        if (seg.length > 1) segs.push({ mode, points: [...seg] })
        mode = m
        seg = lastPt ? [lastPt] : []
      }
      seg.push(pt)
      lastPt = pt
    }
    if (seg.length > 1) segs.push({ mode, points: seg })
    return segs
  }, [rows])

  const bounds = useMemo(
    () => gpsRows.map(r => [r._lat, r._lon]),
    [gpsRows]
  )

  const startPt = gpsRows[0] ? [gpsRows[0]._lat, gpsRows[0]._lon] : null
  const endPt = gpsRows[gpsRows.length - 1]
    ? [gpsRows[gpsRows.length - 1]._lat, gpsRows[gpsRows.length - 1]._lon]
    : null

  const cursorRow = rows[cursorIndex]
  const hasCursor = cursorRow && cursorRow._lat != null

  const center = startPt || [0, 0]

  return (
    <MapContainer
      center={center}
      zoom={15}
      style={{ height: '100%', width: '100%' }}
      zoomControl
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        maxZoom={19}
      />
      {bounds.length >= 2 && <BoundsFitter bounds={bounds} />}

      {segments.map((seg, i) => (
        <Polyline
          key={i}
          positions={seg.points}
          pathOptions={{
            color: fmColor(seg.mode),
            weight: 2.5,
            opacity: 0.85,
          }}
        />
      ))}

      {startPt && (
        <CircleMarker
          center={startPt}
          radius={6}
          pathOptions={{ color: '#1a1b26', fillColor: '#9ece6a', fillOpacity: 1, weight: 2 }}
        />
      )}
      {endPt && endPt !== startPt && (
        <CircleMarker
          center={endPt}
          radius={6}
          pathOptions={{ color: '#1a1b26', fillColor: '#f7768e', fillOpacity: 1, weight: 2 }}
        />
      )}
      {hasCursor && (
        <CircleMarker
          center={[cursorRow._lat, cursorRow._lon]}
          radius={7}
          pathOptions={{
            color: '#fff',
            fillColor: '#e0af68',
            fillOpacity: 1,
            weight: 2,
          }}
        />
      )}
    </MapContainer>
  )
}
