import { useEffect, useRef } from 'react'
import { interpRows } from '../../utils/interpRows'
import AttitudeIndicator from './AttitudeIndicator'
import Airspeed from './Airspeed'
import Altimeter from './Altimeter'
import HeadingIndicator from './HeadingIndicator'
import BatteryGauge from './BatteryGauge'
import './gauges.css'

/**
 * Cockpit-style instrument cluster — replaces the text HUD on GlobeView.
 *
 * Layout (left → right): airspeed | attitude | altimeter | heading | battery.
 * The attitude indicator is the focal point and rendered slightly larger;
 * the four flanking gauges are uniform 90 px round dials.
 *
 * Performance contract:
 *   - One rAF loop in this component owns playback subscription.
 *   - On each tick, interpRows(rows, vt) is computed ONCE.
 *   - Each gauge exposes an imperative setter (setSpeed, setAltitude,
 *     setHeading, setVoltage, setAttitude) that mutates DOM directly.
 *     ZERO React re-renders during playback.
 *   - This matches the GlobeView preRender pattern so we share the same
 *     model: virtualTimeRef is the single source of truth for "what
 *     moment is the user looking at right now."
 *
 * Video-export readiness:
 *   - Each gauge's setter is a pure function of its input value, so a
 *     future export pipeline can call them imperatively per frame
 *     without the rAF loop.
 *   - The interpRows call here is deterministic; given the same vt it
 *     produces the same row, so re-rendering for export will produce
 *     identical pixels.
 */
export default function GaugeCluster({ rows, virtualTimeRef }) {
  const attitudeRef = useRef(null)
  const airspeedRef = useRef(null)
  const altimeterRef = useRef(null)
  const headingRef = useRef(null)
  const batteryRef = useRef(null)

  useEffect(() => {
    if (!rows || rows.length === 0) return
    let raf = 0

    const tick = () => {
      const vt = virtualTimeRef?.current ?? rows[0]._tSec
      const r = interpRows(rows, vt)
      if (r) {
        attitudeRef.current?.setAttitude(r._pitchDeg, r._rollDeg)
        airspeedRef.current?.setSpeed(r['GSpd(kmh)'])
        altimeterRef.current?.setAltitude(r['Alt(m)'])
        headingRef.current?.setHeading(r['Hdg(°)'])
        batteryRef.current?.setVoltage(r['RxBt(V)'])
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [rows, virtualTimeRef])

  return (
    <div className="gauge-cluster" aria-label="Cockpit instrument cluster">
      <Airspeed         ref={airspeedRef}  rows={rows} />
      <AttitudeIndicator ref={attitudeRef} />
      <Altimeter        ref={altimeterRef} rows={rows} />
      <HeadingIndicator ref={headingRef} />
      <BatteryGauge     ref={batteryRef}   rows={rows} />
    </div>
  )
}
