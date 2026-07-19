import { useRef, useEffect, useMemo } from 'react'
import { sharedLttbIndices, nearestPos } from '../utils/lttb'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend)

// Global crosshair plugin — reads _cursorIdx directly from each chart instance
const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    const idx = chart._cursorIdx
    if (idx == null || idx < 0) return
    const { ctx, scales, chartArea } = chart
    if (!scales.x) return
    const x = scales.x.getPixelForValue(idx)
    if (x < chartArea.left || x > chartArea.right) return
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, chartArea.top)
    ctx.lineTo(x, chartArea.bottom)
    // Distinct from every series color (the old #e0af68 was byte-identical
    // to the Heading and Voltage series, so the playhead vanished on those
    // charts). Theme-aware value is set on the instance per render.
    ctx.strokeStyle = chart._cursorColor || 'rgba(150, 150, 160, 0.9)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.stroke()
    ctx.restore()
  },
}

ChartJS.register(crosshairPlugin)

// Theme-specific chart palette. Chart.js doesn't read CSS vars at draw time,
// so we hand-pick values that match the App.css palette for each theme.
const CHART_COLORS = {
  dark: {
    title:        '#ffffff',
    legend:       '#d6dcef',
    tickStrong:   '#d6dcef',
    tickDim:      '#8893b6',
    grid:         'rgba(75, 91, 120, 0.28)',
    tooltipBg:    'rgba(28, 35, 51, 0.96)',
    tooltipText:  '#ffffff',
    tooltipBody:  '#d6dcef',
    tooltipBorder:'#4b5b78',
  },
  light: {
    title:        '#0f1a2c',
    legend:       '#2c3e5c',
    tickStrong:   '#2c3e5c',
    tickDim:      '#6478a0',
    grid:         'rgba(120, 130, 150, 0.20)',
    tooltipBg:    'rgba(255, 255, 255, 0.97)',
    tooltipText:  '#0f1a2c',
    tooltipBody:  '#2c3e5c',
    tooltipBorder:'#c5cdd9',
  },
}

export default function SyncedChart({
  title,
  datasets,
  labels,
  yLabel,
  y1Label,
  cursorIndex,
  onCursorChange,
  theme = 'light',
  height = 160,
}) {
  const chartRef = useRef(null)
  const onCursorRef = useRef(onCursorChange)
  onCursorRef.current = onCursorChange

  // ── LTTB downsampling for long logs ─────────────────────────────────────
  // Above this row count, Chart.js redraw cost makes crosshair moves janky
  // (P0 in the UX review for 20-minute blackbox logs). We pick a shared
  // kept-index set (union of per-series LTTB picks, so every series keeps
  // its own peaks/sags) and render only those rows. indexMap translates
  // between row space (the app-wide cursorIndex) and sampled space.
  const DOWNSAMPLE_AT = 3000
  const PER_SERIES = 900
  const sampled = useMemo(() => {
    if (!labels || labels.length <= DOWNSAMPLE_AT) {
      return { labels, datasets, indexMap: null }
    }
    const indexMap = sharedLttbIndices(datasets.map(d => d.data), PER_SERIES)
    return {
      labels: indexMap.map(i => labels[i]),
      datasets: datasets.map(d => ({ ...d, data: indexMap.map(i => d.data[i]) })),
      indexMap,
    }
  }, [labels, datasets])
  const indexMapRef = useRef(null)
  indexMapRef.current = sampled.indexMap

  // Update cursor line imperatively — no React re-render needed
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const map = indexMapRef.current
    chart._cursorIdx = map ? nearestPos(map, cursorIndex) : cursorIndex
    chart._cursorColor = theme === 'dark' ? '#e6ebf5' : '#1a2740'
    chart.draw()
  }, [cursorIndex, theme, sampled])

  const data = useMemo(
    () => ({ labels: sampled.labels, datasets: sampled.datasets }),
    [sampled],
  )

  const hasDualAxis = datasets.some(d => d.yAxisID === 'y1')

  const options = useMemo(() => {
    const c = CHART_COLORS[theme] || CHART_COLORS.light
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      plugins: {
        legend: {
          position: 'top',
          align: 'start',
          labels: {
            color: c.legend,
            boxWidth: 10,
            boxHeight: 2,
            padding: 8,
            font: { size: 11 },
          },
        },
        title: {
          display: !!title,
          text: title,
          color: c.title,
          font: { size: 12, weight: '600' },
          padding: { top: 2, bottom: 6 },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: c.tooltipBg,
          titleColor: c.tooltipText,
          bodyColor: c.tooltipBody,
          borderColor: c.tooltipBorder,
          borderWidth: 1,
          padding: 8,
        },
      },
      // Hover shows the tooltip only (read a value in place). Committing
      // the global playback cursor requires a deliberate click, so
      // inspecting a chart no longer scrubs the whole 3D scene + gauges.
      onClick: (event, _elements, chart) => {
        const pts = chart.getElementsAtEventForMode(event, 'index', { intersect: false }, false)
        if (pts.length > 0) {
          // Map the clicked sampled position back to the real row index so
          // the app-wide cursor (globe, telemetry bar, dock) stays exact.
          const map = indexMapRef.current
          const raw = pts[0].index
          onCursorRef.current?.(map ? map[raw] : raw)
        }
      },
      scales: {
        x: {
          ticks: {
            color: c.tickDim,
            maxTicksLimit: 12,
            maxRotation: 0,
            font: { size: 10 },
          },
          grid: { color: c.grid },
        },
        y: {
          position: 'left',
          title: {
            display: !!yLabel,
            text: yLabel,
            color: c.tickDim,
            font: { size: 10 },
          },
          ticks: { color: c.tickDim, font: { size: 10 } },
          grid: { color: c.grid },
        },
        ...(hasDualAxis && {
          y1: {
            position: 'right',
            title: {
              display: !!y1Label,
              text: y1Label,
              color: c.tickDim,
              font: { size: 10 },
            },
            ticks: { color: c.tickDim, font: { size: 10 } },
            grid: { drawOnChartArea: false },
          },
        }),
      },
    }
  }, [title, yLabel, y1Label, hasDualAxis, theme])

  return (
    <div className="chart-panel">
      <div style={{ height }}>
        <Line ref={chartRef} data={data} options={options} />
      </div>
    </div>
  )
}
