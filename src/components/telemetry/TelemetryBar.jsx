import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import InputModule from './InputModule'
import { detectBatteryConfig } from '../gauges/gaugeUtils'
import { sampleWindow, sparkPoints, distMeters, bearingDeg } from './telemetryUtils'
import './telemetry.css'

/**
 * READOUT/72 telemetry bar — replaces the five round gauges and the
 * RC-transmitter illustration with one 72px data-first strip:
 *
 *   [BATT] [ALT] [SPD] [HDG] [ATT] [HOME] [warn] ........ [input module]
 *
 * Design rules (docs/UX-REDESIGN-PLAN.md):
 *  - The number IS the instrument: 22px tabular-nums values, 10px labels.
 *  - Color only for REAL thresholds: the battery per-cell zones (the one
 *    instrument whose semantics were honest) are the ONLY default color.
 *    The old log-relative green/yellow/red arcs are gone, not restyled.
 *  - Sparklines show the trailing 30s of FLIGHT time (amendment B), and
 *    ALT extends 6s PAST the cursor in magenta — the replay knows the
 *    future. Magenta (--pink) = derived/computed, cyan = measured input.
 *  - Token-pure: every color is a theme token; the bar is a light
 *    surface in light theme like any other card.
 *
 * Update contract (frozen invariant, same as the old GaugeCluster):
 *   ref.current.update(row) — called from GlobeView's Cesium preRender
 *   in 3D view, and from Dashboard's cursor effect otherwise (amendment
 *   A: the bar renders in BOTH views and for no-GPS logs). Direct DOM
 *   mutation only; zero React renders per frame.
 */

const SPARK_EVERY = 3 // recompute sparklines every Nth update call

const TelemetryBar = forwardRef(function TelemetryBar({ log }, ref) {
  const { rows } = log

  const cfg = useMemo(() => detectBatteryConfig(rows), [rows])
  const home = useMemo(() => {
    const r0 = rows.find(r => r._lat != null && r._lon != null)
    return r0 ? { lat: r0._lat, lon: r0._lon } : null
  }, [rows])
  const has = useMemo(() => ({
    batt: cfg.detected,
    alt: rows.some(r => typeof r['Alt(m)'] === 'number'),
    spd: rows.some(r => typeof r['GSpd(kmh)'] === 'number' && r['GSpd(kmh)'] > 0),
    hdg: rows.some(r => typeof r['Hdg(°)'] === 'number'),
    att: rows.some(r => Number.isFinite(r._rollDeg) || Number.isFinite(r._pitchDeg)),
    current: log.hasCurrent,
    capacity: rows.some(r => typeof r['Capa(mAh)'] === 'number' && r['Capa(mAh)'] > 0),
  }), [rows, cfg.detected, log.hasCurrent])

  const el = {
    root: useRef(null),
    battVal: useRef(null), battSub: useRef(null), battSpark: useRef(null), battFloor: useRef(null),
    altVal: useRef(null), vsChev: useRef(null), vsVal: useRef(null),
    altSpark: useRef(null), altFuture: useRef(null),
    spdVal: useRef(null), spdSpark: useRef(null),
    hdgVal: useRef(null), hdgCard: useRef(null),
    rollVal: useRef(null), pitchVal: useRef(null), rollLine: useRef(null),
    homeVal: useRef(null), homeArrow: useRef(null),
    warn: useRef(null),
    input: useRef(null),
  }
  const frameCount = useRef(0)

  // Responsive tiers: hide cells by priority instead of ever wrapping
  // (the silent-rewrap failure mode is what created the old 262px band).
  useEffect(() => {
    const root = el.root.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const apply = () => {
      const w = root.clientWidth
      root.dataset.tier = w >= 840 ? 'a' : w >= 700 ? 'b' : w >= 560 ? 'c' : 'd'
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(root)
    // window-resize fallback: some embedded/headless environments miss
    // RO deliveries on viewport changes; a resize listener is free.
    window.addEventListener('resize', apply)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', apply)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({
    update(row) {
      if (!row) return
      const t = row._tSec
      frameCount.current++
      const doSpark = frameCount.current % SPARK_EVERY === 0 || frameCount.current === 1

      /* BATT — the one honest instrument's semantics, ported verbatim */
      if (has.batt) {
        const v = row['RxBt(V)']
        const ok = typeof v === 'number' && Number.isFinite(v) && v > 0
        const perCell = ok ? v / cfg.cells : NaN
        if (el.battVal.current) {
          el.battVal.current.textContent = ok ? perCell.toFixed(2) : '– –'
          el.battVal.current.className =
            'tm-val ' + (!ok ? '' : perCell >= 3.7 ? 'tm-green' : perCell >= 3.5 ? 'tm-yellow' : 'tm-red')
        }
        if (el.battSub.current) {
          const parts = []
          if (ok) parts.push(v.toFixed(1) + 'V')
          if (has.current && typeof row['Curr(A)'] === 'number') parts.push(row['Curr(A)'].toFixed(1) + 'A')
          if (has.capacity && typeof row['Capa(mAh)'] === 'number') parts.push(Math.round(row['Capa(mAh)']) + 'mAh')
          el.battSub.current.textContent = parts.join(' · ') || ' '
        }
        if (doSpark && el.battSpark.current && Number.isFinite(t)) {
          const vals = sampleWindow(rows, t, 30, 20, r => {
            const b = r['RxBt(V)']
            return typeof b === 'number' && b > 0 ? b / cfg.cells : NaN
          })
          const sp = sparkPoints(vals, 88, 15)
          el.battSpark.current.setAttribute('points', sp.points)
          el.battSpark.current.style.stroke =
            Number.isFinite(perCell) && perCell < 3.5 ? 'var(--red)'
              : Number.isFinite(perCell) && perCell < 3.7 ? 'var(--yellow)'
                : 'var(--green)'
          // dashed floor line at the 3.5V/cell equivalent, when in range
          if (el.battFloor.current) {
            const { min, max } = sp
            if (max > min && 3.5 >= min && 3.5 <= max) {
              const y = 15 - 2 - (15 - 4) * ((3.5 - min) / (max - min))
              el.battFloor.current.setAttribute('y1', y.toFixed(1))
              el.battFloor.current.setAttribute('y2', y.toFixed(1))
              el.battFloor.current.style.display = ''
            } else {
              el.battFloor.current.style.display = 'none'
            }
          }
        }
        // WARN chip — real thresholds only. CSS animation blinks it, so
        // it keeps blinking while Cesium is idle/paused (amendment C),
        // and the global prefers-reduced-motion rule collapses it to a
        // steady block.
        if (el.warn.current) {
          el.warn.current.classList.toggle('tm-warn-show', Number.isFinite(perCell) && perCell < 3.5)
        }
      }

      /* ALT + fused vertical speed */
      if (has.alt) {
        const a = row['Alt(m)']
        const okA = typeof a === 'number' && Number.isFinite(a)
        if (el.altVal.current) el.altVal.current.textContent = okA ? (Math.abs(a) >= 1000 ? a.toFixed(0) : a.toFixed(1)) : '– –'
        const vs = row['VSpd(m/s)']
        const okV = typeof vs === 'number' && Number.isFinite(vs)
        if (el.vsChev.current) el.vsChev.current.textContent = okV ? (vs >= 0 ? '▲' : '▼') : ''
        if (el.vsVal.current) el.vsVal.current.textContent = okV ? Math.abs(vs).toFixed(1) : ''
        if (doSpark && el.altSpark.current && Number.isFinite(t)) {
          // Shared-scale past (30s → x 0..62) + magenta future (6s → x 62..80)
          const past = sampleWindow(rows, t, 30, 18, r => r['Alt(m)'])
          const fut = sampleWindow(rows, t + 6, 6, 6, r => r['Alt(m)'])
          const all = past.concat(fut.slice(1))
          let min = Infinity, max = -Infinity
          for (const v of all) { if (!Number.isNaN(v)) { if (v < min) min = v; if (v > max) max = v } }
          if (Number.isFinite(min)) {
            const span = max - min || 1
            const y = v => (15 - 2 - (15 - 4) * ((v - min) / span)).toFixed(1)
            const p1 = []
            for (let i = 0; i < past.length; i++) if (!Number.isNaN(past[i])) p1.push(((62 * i) / (past.length - 1)).toFixed(1) + ',' + y(past[i]))
            const p2 = p1.length ? [p1[p1.length - 1]] : []
            for (let i = 1; i < fut.length; i++) if (!Number.isNaN(fut[i])) p2.push((62 + (18 * i) / (fut.length - 1)).toFixed(1) + ',' + y(fut[i]))
            el.altSpark.current.setAttribute('points', p1.join(' '))
            if (el.altFuture.current) el.altFuture.current.setAttribute('points', p2.join(' '))
          }
        }
      }

      /* SPD */
      if (has.spd) {
        const s = row['GSpd(kmh)']
        const ok = typeof s === 'number' && Number.isFinite(s)
        if (el.spdVal.current) el.spdVal.current.textContent = ok ? s.toFixed(1) : '– –'
        if (doSpark && el.spdSpark.current && Number.isFinite(t)) {
          const sp = sparkPoints(sampleWindow(rows, t, 30, 20, r => r['GSpd(kmh)']), 68, 15)
          el.spdSpark.current.setAttribute('points', sp.points)
        }
      }

      /* HDG (amendment G: heading keeps a default home in the bar) */
      if (has.hdg) {
        const h = row['Hdg(°)']
        const ok = typeof h === 'number' && Number.isFinite(h)
        if (el.hdgVal.current) el.hdgVal.current.textContent = ok ? String(Math.round(((h % 360) + 360) % 360)).padStart(3, '0') + '°' : '– –'
        if (el.hdgCard.current) {
          const cards = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
          el.hdgCard.current.textContent = ok ? cards[Math.round((((h % 360) + 360) % 360) / 45) % 8] : ''
        }
      }

      /* ATT — unclamped digits (the ±25° display clamp is gone) */
      if (has.att) {
        const rr = row._rollDeg
        const pp = row._pitchDeg
        if (el.rollVal.current) el.rollVal.current.textContent = Number.isFinite(rr) ? fmtDeg(rr) : '– –'
        if (el.pitchVal.current) el.pitchVal.current.textContent = Number.isFinite(pp) ? fmtDeg(pp) : '– –'
        if (el.rollLine.current && Number.isFinite(rr)) {
          el.rollLine.current.setAttribute('transform', `rotate(${(-rr).toFixed(1)} 13 13)`)
        }
      }

      /* HOME — distance + bearing arrow (replaces the heading dial) */
      if (home && row._lat != null && row._lon != null) {
        const d = distMeters(row._lat, row._lon, home.lat, home.lon)
        if (el.homeVal.current) {
          el.homeVal.current.textContent = d >= 1000 ? (d / 1000).toFixed(2) : String(Math.round(d))
        }
        const homeUnit = el.homeVal.current && el.homeVal.current.nextElementSibling
        if (homeUnit) homeUnit.textContent = d >= 1000 ? 'km' : 'm'
        if (el.homeArrow.current) {
          const brg = bearingDeg(row._lat, row._lon, home.lat, home.lon)
          const hd = typeof row['Hdg(°)'] === 'number' ? row['Hdg(°)'] : 0
          el.homeArrow.current.setAttribute('transform', `rotate(${(((brg - hd) % 360) + 360) % 360} 8 8)`)
        }
      }

      /* input module */
      el.input.current?.update(row)
    },
  }), [rows, cfg, has, home]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tm-bar" ref={el.root} data-tier="a" aria-label="Telemetry">
      {has.batt && (
        <div className="tm-cell tm-cell-batt">
          <div className="tm-lab">BATT · {cfg.cells}S LiPo</div>
          <div className="tm-valrow">
            <span className="tm-val" ref={el.battVal}>– –</span>
            <span className="tm-unit">V/cell</span>
            <span className="tm-sub" ref={el.battSub}></span>
          </div>
          <svg className="tm-spark" width="88" height="15" viewBox="0 0 88 15" aria-hidden="true">
            <line ref={el.battFloor} x1="0" x2="88" y1="12" y2="12" className="tm-floor" />
            <polyline ref={el.battSpark} points="" className="tm-sparkline" style={{ stroke: 'var(--green)' }} />
          </svg>
        </div>
      )}
      {has.alt && (
        <div className="tm-cell">
          <div className="tm-lab">ALT · TLM</div>
          <div className="tm-valrow">
            <span className="tm-val" ref={el.altVal}>– –</span>
            <span className="tm-unit">m</span>
            <span className="tm-vs"><span className="tm-chev" ref={el.vsChev}></span> <span ref={el.vsVal}></span></span>
          </div>
          <svg className="tm-spark" width="80" height="15" viewBox="0 0 80 15" aria-hidden="true">
            <polyline ref={el.altSpark} points="" className="tm-sparkline" />
            <polyline ref={el.altFuture} points="" className="tm-sparkline tm-future" />
          </svg>
        </div>
      )}
      {has.spd && (
        <div className="tm-cell">
          <div className="tm-lab">SPD · GPS</div>
          <div className="tm-valrow">
            <span className="tm-val" ref={el.spdVal}>– –</span>
            <span className="tm-unit">km/h</span>
          </div>
          <svg className="tm-spark" width="68" height="15" viewBox="0 0 68 15" aria-hidden="true">
            <polyline ref={el.spdSpark} points="" className="tm-sparkline" />
          </svg>
        </div>
      )}
      {has.hdg && (
        <div className="tm-cell tm-cell-hdg">
          <div className="tm-lab">HDG · GPS</div>
          <div className="tm-valrow"><span className="tm-val" ref={el.hdgVal}>– –</span></div>
          <div className="tm-lab tm-card" ref={el.hdgCard}></div>
        </div>
      )}
      {has.att && (
        <div className="tm-cell tm-cell-att">
          <div className="tm-lab">ATT</div>
          <div className="tm-att-inner">
            <div className="tm-att-nums">
              <div><span>R</span><b ref={el.rollVal}>– –</b></div>
              <div><span>P</span><b ref={el.pitchVal}>– –</b></div>
            </div>
            <svg className="tm-att-chip" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
              <rect x="0.5" y="0.5" width="25" height="25" rx="4" className="tm-chipframe" />
              <line ref={el.rollLine} x1="4" y1="13" x2="22" y2="13" className="tm-chipline" />
              <circle cx="13" cy="13" r="1.6" className="tm-chipdot" />
            </svg>
          </div>
        </div>
      )}
      {home && (
        <div className="tm-cell tm-cell-home">
          <div className="tm-lab">HOME</div>
          <div className="tm-valrow">
            <span className="tm-val" ref={el.homeVal}>– –</span>
            <span className="tm-unit">m</span>
          </div>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="tm-home-svg">
            <g ref={el.homeArrow}><path d="M 8 2 L 12 12 L 8 9.5 L 4 12 Z" className="tm-homearrow" /></g>
          </svg>
        </div>
      )}
      <div className="tm-warn" ref={el.warn} role="alert">LOW BATTERY · LAND NOW</div>
      <InputModule ref={el.input} rows={rows} />
    </div>
  )
})

function fmtDeg(v) {
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '°'
}

export default TelemetryBar
