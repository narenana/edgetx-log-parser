/**
 * Largest-Triangle-Three-Buckets downsampling for the synced charts.
 *
 * Long blackbox logs produce tens of thousands of rows; Chart.js redraws
 * every series point on every crosshair move, which makes 20-minute logs
 * feel janky (P0 in the UX review). LTTB picks, per bucket, the point that
 * forms the largest triangle with its neighbours — preserving visual shape
 * (peaks, sags, spikes) far better than uniform striding at the same size.
 *
 * We downsample INDICES, not values, so one shared kept-index set can be
 * applied to every series of a chart and to its labels — keeping tooltips,
 * clicks and the crosshair mapped back to real row indices.
 */

/**
 * Classic LTTB over a numeric series, returning the kept indices
 * (always includes first and last). Nulls/NaNs participate as 0 for the
 * area math (they render as gaps but shouldn't break selection).
 */
export function lttbIndices(values, threshold) {
  const n = values.length
  if (threshold >= n || threshold < 3) {
    // passthrough — caller shouldn't downsample
    const all = new Array(n)
    for (let i = 0; i < n; i++) all[i] = i
    return all
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  const kept = new Array(threshold)
  kept[0] = 0
  const bucketSize = (n - 2) / (threshold - 2)
  let a = 0 // last kept index

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor((i + 0) * bucketSize) + 1
    const bucketEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, n - 1)
    // Average of the NEXT bucket (the "third point" of the triangle).
    const nextStart = bucketEnd
    const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n)
    let avgX = 0
    let avgY = 0
    const nextLen = Math.max(nextEnd - nextStart, 1)
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += j
      avgY += num(values[j])
    }
    avgX /= nextLen
    avgY /= nextLen
    if (nextEnd === nextStart) {
      avgX = nextStart
      avgY = num(values[nextStart])
    }

    const ax = a
    const ay = num(values[a])
    let maxArea = -1
    let maxIdx = bucketStart
    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs(
        (ax - avgX) * (num(values[j]) - ay) - (ax - j) * (avgY - ay),
      )
      if (area > maxArea) {
        maxArea = area
        maxIdx = j
      }
    }
    kept[i + 1] = maxIdx
    a = maxIdx
  }
  kept[threshold - 1] = n - 1
  return kept
}

/**
 * Shared kept-index set for a multi-series chart: run LTTB per series and
 * union the picks, so each series keeps its own peaks. Result is sorted,
 * deduped, and bounded by seriesCount x perSeriesThreshold.
 */
export function sharedLttbIndices(seriesList, perSeriesThreshold) {
  const set = new Set()
  for (const s of seriesList) {
    const idx = lttbIndices(s, perSeriesThreshold)
    for (const i of idx) set.add(i)
  }
  return [...set].sort((x, y) => x - y)
}

/** Binary search: position in sorted indexMap closest to rowIdx. */
export function nearestPos(indexMap, rowIdx) {
  let lo = 0
  let hi = indexMap.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (indexMap[mid] < rowIdx) lo = mid + 1
    else hi = mid
  }
  // lo is the first position >= rowIdx; check whether lo-1 is closer.
  if (
    lo > 0 &&
    Math.abs(indexMap[lo - 1] - rowIdx) <= Math.abs(indexMap[lo] - rowIdx)
  ) {
    return lo - 1
  }
  return lo
}
