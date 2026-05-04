import { forwardRef, useImperativeHandle, useRef } from 'react'
import ThrottleLever from './ThrottleLever'
import Joystick from './Joystick'
import YawPedals from './YawPedals'

/**
 * Pilot input cluster — mirror of GaugeCluster, but for what the pilot
 * was COMMANDING (channels) rather than what the aircraft was DOING
 * (telemetry).
 *
 * Same architecture: pure SVG view, single imperative `update(row)`
 * method. Driven from GlobeView's preRender so we share Cesium's rAF
 * with everyone else.
 *
 * Source field per control:
 *   ThrottleLever → row._throttle    (0..100)
 *   Joystick      → row._stickRoll, row._stickPitch  (-100..+100 each)
 *   YawPedals     → row._stickYaw    (-100..+100)
 *
 * Logs without pilot-input fields → each control's setter receives
 * null and shows a "NO TLM" overlay.
 */
const ControlsCluster = forwardRef(function ControlsCluster(_props, ref) {
  const throttleRef = useRef(null)
  const joystickRef = useRef(null)
  const pedalsRef = useRef(null)

  useImperativeHandle(ref, () => ({
    update(r) {
      if (!r) return
      throttleRef.current?.setThrottle(r._throttle)
      joystickRef.current?.setStick(r._stickRoll, r._stickPitch)
      pedalsRef.current?.setYaw(r._stickYaw)
    },
  }))

  return (
    <div className="controls-cluster" aria-label="Pilot input cluster">
      <ThrottleLever ref={throttleRef} />
      <div className="controls-stack-right">
        <Joystick ref={joystickRef} />
        <YawPedals ref={pedalsRef} />
      </div>
    </div>
  )
})

export default ControlsCluster
