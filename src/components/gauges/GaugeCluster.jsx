import { forwardRef, useImperativeHandle, useRef } from 'react'
import AttitudeIndicator from './AttitudeIndicator'
import Airspeed from './Airspeed'
import Altimeter from './Altimeter'
import HeadingIndicator from './HeadingIndicator'
import BatteryGauge from './BatteryGauge'
import './gauges.css'

/**
 * Cockpit instrument cluster.
 *
 * Pure SVG view — no rAF loop of its own. The parent (GlobeView's
 * Cesium preRender callback) drives updates by calling the imperative
 * `update(row)` method exposed via `forwardRef`. This keeps the entire
 * UI on a SINGLE rAF (Cesium's), eliminating both the duplicate
 * interpRows work and the GC pressure from spreading rows in 3 parallel
 * loops.
 *
 * Imperative API:
 *   ref.current.update(row)
 *     row → output of interpRows(rows, vt). Pass null to no-op.
 *
 * Each child gauge still owns its own DOM-mutating setter; this cluster
 * just dispatches the right field of `row` to each one.
 */
const GaugeCluster = forwardRef(function GaugeCluster({ rows }, ref) {
  const attitudeRef = useRef(null)
  const airspeedRef = useRef(null)
  const altimeterRef = useRef(null)
  const headingRef = useRef(null)
  const batteryRef = useRef(null)

  useImperativeHandle(ref, () => ({
    update(r) {
      if (!r) return
      attitudeRef.current?.setAttitude(r._pitchDeg, r._rollDeg)
      airspeedRef.current?.setSpeed(r['GSpd(kmh)'])
      altimeterRef.current?.setAltitude(r['Alt(m)'])
      headingRef.current?.setHeading(r['Hdg(°)'])
      batteryRef.current?.setVoltage(r['RxBt(V)'])
    },
  }))

  return (
    <div className="gauge-cluster" aria-label="Cockpit instrument cluster">
      <Airspeed         ref={airspeedRef}  rows={rows} />
      <AttitudeIndicator ref={attitudeRef} />
      <Altimeter        ref={altimeterRef} rows={rows} />
      <HeadingIndicator ref={headingRef} />
      <BatteryGauge     ref={batteryRef}   rows={rows} />
    </div>
  )
})

export default GaugeCluster
