import { useRef, useEffect, useMemo } from 'react'
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
    ctx.strokeStyle = 'rgba(224, 175, 104, 0.7)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.stroke()
    ctx.restore()
  },
}

ChartJS.register(crosshairPlugin)

export default function SyncedChart({
  title,
  datasets,
  labels,
  yLabel,
  y1Label,
  cursorIndex,
  onCursorChange,
  height = 160,
}) {
  const chartRef = useRef(null)
  const onCursorRef = useRef(onCursorChange)
  onCursorRef.current = onCursorChange

  // Update cursor line imperatively — no React re-render needed
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart._cursorIdx = cursorIndex
    chart.draw()
  }, [cursorIndex])

  const data = useMemo(() => ({ labels, datasets }), [labels, datasets])

  const hasDualAxis = datasets.some(d => d.yAxisID === 'y1')

  const options = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false, axis: 'x' },
    plugins: {
      legend: {
        position: 'top',
        align: 'start',
        labels: {
          color: '#a9b1d6',
          boxWidth: 10,
          boxHeight: 2,
          padding: 8,
          font: { size: 11 },
        },
      },
      title: {
        display: !!title,
        text: title,
        color: '#c0caf5',
        font: { size: 12, weight: '600' },
        padding: { top: 2, bottom: 6 },
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        backgroundColor: 'rgba(36, 40, 59, 0.96)',
        titleColor: '#c0caf5',
        bodyColor: '#a9b1d6',
        borderColor: '#414868',
        borderWidth: 1,
        padding: 8,
      },
    },
    onHover: (_event, elements) => {
      if (elements.length > 0) {
        onCursorRef.current?.(elements[0].index)
      }
    },
    scales: {
      x: {
        ticks: {
          color: '#565f89',
          maxTicksLimit: 12,
          maxRotation: 0,
          font: { size: 10 },
        },
        grid: { color: 'rgba(65, 72, 104, 0.25)' },
      },
      y: {
        position: 'left',
        title: {
          display: !!yLabel,
          text: yLabel,
          color: '#565f89',
          font: { size: 10 },
        },
        ticks: { color: '#565f89', font: { size: 10 } },
        grid: { color: 'rgba(65, 72, 104, 0.25)' },
      },
      ...(hasDualAxis && {
        y1: {
          position: 'right',
          title: {
            display: !!y1Label,
            text: y1Label,
            color: '#565f89',
            font: { size: 10 },
          },
          ticks: { color: '#565f89', font: { size: 10 } },
          grid: { drawOnChartArea: false },
        },
      }),
    },
  }), [title, yLabel, y1Label, hasDualAxis])

  return (
    <div className="chart-panel">
      <div style={{ height }}>
        <Line ref={chartRef} data={data} options={options} />
      </div>
    </div>
  )
}
