import { parseEdgeTXLog } from './parseLog'

/**
 * Fetch a CSV from a URL and run it through the EdgeTX parser.
 *
 * Used by:
 *   - the "Try sample log" button on the empty state (./sample-log.csv)
 *   - phase-2 sharing hook: ?log=<encoded-url> in App.jsx
 *
 * Same-origin requests work unconditionally. Cross-origin requests need the
 * remote server to send `Access-Control-Allow-Origin: *` (or specifically our
 * domain). Sample logs we host ourselves are always same-origin.
 *
 * Optional `displayName` overrides the filename derived from the URL — useful
 * when the URL is opaque (signed S3 link, share token, etc.).
 */
export async function loadLogFromUrl(url, { displayName } = {}) {
  const res = await fetch(url, { credentials: 'omit' })
  if (!res.ok) {
    throw new Error(`Failed to fetch log (${res.status} ${res.statusText})`)
  }
  const text = await res.text()
  const filename = displayName || filenameFromUrl(url)
  return parseEdgeTXLog(text, filename)
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url, window.location.href)
    const tail = u.pathname.split('/').pop() || 'log.csv'
    return tail.toLowerCase().endsWith('.csv') ? tail : tail + '.csv'
  } catch {
    return 'log.csv'
  }
}
