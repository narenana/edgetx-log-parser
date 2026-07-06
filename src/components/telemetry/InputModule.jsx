import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { sampleWindow, stickOffsets } from './telemetryUtils'

/**
 * Pilot-input module — the right end of the telemetry bar.
 *
 * Replaces the RadioMaster Pocket illustration. Everything here carries
 * data: a vertical throttle bar, two SQUARE stick boxes (the ±100/±100
 * input domain IS square — a circular gimbal ring lets the cap escape
 * its own housing at corner deflections), and a four-row channel
 * readout. Full box = full travel: the dot centre moves ±TRAVEL px, so
 * a 10% input is ~2.3px instead of the old 1.2px — and far more
 * readable in practice because of the trails.
 *
 * TRAILS: the magenta polyline behind each dot is the last 800ms of
 * FLIGHT TIME (sampled from `rows` at the cursor's _tSec — amendment B),
 * so they are correct at every playback speed, persist when paused, and
 * show how the sticks arrived at a scrubbed-to frame.
 *
 * Imperative API (same contract as the old ControlsCluster):
 *   ref.current.update(row)  — row from interpRows or rows[cursorIndex]
 */

const BOX = 56           // stick box outer size (px)
const C = BOX / 2        // box centre
const TRAVEL = 23        // max dot-centre deflection from centre (px)
const TRAIL_S = 0.8      // seconds of flight-time history in the trail
const TRAIL_N = 12       // trail samples

const InputModule = forwardRef(function InputModule({ rows }, ref) {
  // Does this log carry stick channels at all? Checked once. When false
  // the boxes render EMPTY — never a fake centred dot, which would read
  // as "the pilot made no inputs" in crash review.
  const hasSticks = useMemo(
    () => rows.some(r =>
      Number.isFinite(r._throttle) || Number.isFinite(r._stickRoll) ||
      Number.isFinite(r._stickPitch) || Number.isFinite(r._stickYaw)),
    [rows],
  )

  const dotL = useRef(null)
  const dotR = useRef(null)
  const trailL = useRef(null)
  const trailR = useRef(null)
  const thrFill = useRef(null)
  const roT = useRef(null)
  const roY = useRef(null)
  const roP = useRef(null)
  const roR = useRef(null)
  const rootRef = useRef(null)

  useImperativeHandle(ref, () => ({
    update(row) {
      if (!hasSticks || !row) return
      const off = stickOffsets({
        throttle: row._throttle,
        yaw: row._stickYaw,
        pitch: row._stickPitch,
        roll: row._stickRoll,
      })
      const root = rootRef.current
      if (!off) {
        // Mid-log dropout: sticks logged elsewhere but absent here.
        if (root) root.classList.add('tm-input-gap')
        return
      }
      if (root) root.classList.remove('tm-input-gap')

      // A box whose BOTH axes are absent renders no dot — a centered
      // dot that wasn't measured reads as "the pilot made no inputs".
      const leftLive = off.hasThr || off.hasYaw
      const rightLive = off.hasPitch || off.hasRoll
      if (dotL.current) {
        dotL.current.style.display = leftLive ? '' : 'none'
        dotL.current.setAttribute('cx', (C + off.lx * TRAVEL).toFixed(1))
        dotL.current.setAttribute('cy', (C + off.ly * TRAVEL).toFixed(1))
      }
      if (dotR.current) {
        dotR.current.style.display = rightLive ? '' : 'none'
        dotR.current.setAttribute('cx', (C + off.rx * TRAVEL).toFixed(1))
        dotR.current.setAttribute('cy', (C + off.ry * TRAVEL).toFixed(1))
      }

      // Flight-time trails: sample the window ending at this row's time.
      const t = row._tSec
      if (Number.isFinite(t) && trailL.current && trailR.current) {
        const thrW = sampleWindow(rows, t, TRAIL_S, TRAIL_N, r => r._throttle)
        const yawW = sampleWindow(rows, t, TRAIL_S, TRAIL_N, r => r._stickYaw)
        const pitW = sampleWindow(rows, t, TRAIL_S, TRAIL_N, r => r._stickPitch)
        const rolW = sampleWindow(rows, t, TRAIL_S, TRAIL_N, r => r._stickRoll)
        const lp = []
        const rp = []
        for (let i = 0; i <= TRAIL_N; i++) {
          const o = stickOffsets({ throttle: thrW[i], yaw: yawW[i], pitch: pitW[i], roll: rolW[i] })
          if (!o) continue
          lp.push((C + o.lx * TRAVEL).toFixed(1) + ',' + (C + o.ly * TRAVEL).toFixed(1))
          rp.push((C + o.rx * TRAVEL).toFixed(1) + ',' + (C + o.ry * TRAVEL).toFixed(1))
        }
        trailL.current.style.display = leftLive ? '' : 'none'
        trailR.current.style.display = rightLive ? '' : 'none'
        trailL.current.setAttribute('points', lp.join(' '))
        trailR.current.setAttribute('points', rp.join(' '))
      }

      if (thrFill.current) {
        thrFill.current.style.height = off.hasThr ? off.thr.toFixed(0) + '%' : '0%'
      }
      if (roT.current) roT.current.textContent = off.hasThr ? String(Math.round(off.thr)) : '–'
      if (roY.current) roY.current.textContent = off.hasYaw ? signed(off.yawV) : '–'
      if (roP.current) roP.current.textContent = off.hasPitch ? signed(off.pitchV) : '–'
      if (roR.current) roR.current.textContent = off.hasRoll ? signed(off.rollV) : '–'
    },
  }), [rows, hasSticks])

  if (!hasSticks) {
    return (
      <div className="tm-input tm-input-empty" ref={rootRef} aria-label="Pilot inputs">
        <StickBox dotRef={null} trailRef={null} label="T/Y" empty />
        <StickBox dotRef={null} trailRef={null} label="P/R" empty />
        <div className="tm-nostick">
          NO STICK DATA IN LOG
          <span>enable Ail/Ele/Thr/Rud logging on the radio</span>
        </div>
      </div>
    )
  }

  return (
    <div className="tm-input" ref={rootRef} aria-label="Pilot inputs">
      <div className="tm-thr" aria-hidden="true">
        <div className="tm-thr-fill" ref={thrFill} />
        <i style={{ top: '25%' }} /><i style={{ top: '50%' }} /><i style={{ top: '75%' }} />
      </div>
      <StickBox dotRef={dotL} trailRef={trailL} label="T/Y" />
      <StickBox dotRef={dotR} trailRef={trailR} label="P/R" />
      <div className="tm-readout" aria-hidden="true">
        <div><span>T</span><b ref={roT}>0</b></div>
        <div><span>Y</span><b ref={roY}>0</b></div>
        <div><span>P</span><b ref={roP}>0</b></div>
        <div><span>R</span><b ref={roR}>0</b></div>
      </div>
    </div>
  )
})

function StickBox({ dotRef, trailRef, label, empty = false }) {
  return (
    <svg className="tm-stickbox" width={BOX} height={BOX} viewBox={`0 0 ${BOX} ${BOX}`} aria-hidden="true">
      <rect className="tm-box-frame" x="0.75" y="0.75" width={BOX - 1.5} height={BOX - 1.5} rx="4" />
      <line className="tm-box-guide" x1={C} y1="5" x2={C} y2={BOX - 5} />
      <line className="tm-box-guide" x1="5" y1={C} x2={BOX - 5} y2={C} />
      <rect className="tm-box-guide tm-box-half" x={C - TRAVEL / 2} y={C - TRAVEL / 2} width={TRAVEL} height={TRAVEL} />
      {!empty && <polyline ref={trailRef} className="tm-trail" points="" />}
      {!empty && <circle ref={dotRef} className="tm-dot" cx={C} cy={C} r="5" />}
      <text className="tm-box-label" x="4" y={BOX - 4}>{label}</text>
    </svg>
  )
}

function signed(v) {
  const n = Math.round(v)
  if (n === 0) return '0'
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`
}

export default InputModule
