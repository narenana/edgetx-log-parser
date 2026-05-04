import { useEffect, useRef } from 'react'
import { interpRows } from '../../utils/interpRows'
import ThrottleLever from './ThrottleLever'
import Joystick from './Joystick'
import YawPedals from './YawPedals'

/**
 * Pilot input cluster — the *opposite* of the GaugeCluster.
 *
 * GaugeCluster shows what the AIRCRAFT is doing (telemetry: actual
 * attitude, altitude, speed). ControlsCluster shows what the PILOT was
 * commanding (channel values: stick deflection, throttle position).
 * Reading both at the same time turns a flight log into "watch the
 * pilot fly the plane" — the two clusters tell the story together.
 *
 * Layout: throttle on the LEFT (matches a fighter's left throttle
 * quadrant), joystick in the CENTRE (centre-stick fighter style), yaw
 * pedals on the RIGHT-BOTTOM as a horizontal bar (top-down footwell
 * view).
 *
 * Performance contract — same as GaugeCluster:
 *   - One rAF loop owns subscription to virtualTimeRef.
 *   - interpRows called ONCE per tick.
 *   - Each control exposes an imperative setter (setThrottle, setStick,
 *     setYaw); zero React re-renders during playback.
 *
 * Source field per control:
 *   ThrottleLever → row._throttle    (0..100)
 *   Joystick      → row._stickRoll, row._stickPitch  (-100..+100 each)
 *   YawPedals     → row._stickYaw    (-100..+100)
 *
 * Falls back gracefully when the source log lacks pilot-input fields:
 * each control's setter receives null and shows a "NO TLM" overlay.
 */
export default function ControlsCluster({ rows, virtualTimeRef }) {
  const throttleRef = useRef(null)
  const joystickRef = useRef(null)
  const pedalsRef = useRef(null)

  useEffect(() => {
    if (!rows || rows.length === 0) return
    let raf = 0

    const tick = () => {
      const vt = virtualTimeRef?.current ?? rows[0]._tSec
      const r = interpRows(rows, vt)
      if (r) {
        throttleRef.current?.setThrottle(r._throttle)
        joystickRef.current?.setStick(r._stickRoll, r._stickPitch)
        pedalsRef.current?.setYaw(r._stickYaw)
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [rows, virtualTimeRef])

  return (
    <div className="controls-cluster" aria-label="Pilot input cluster">
      <ThrottleLever ref={throttleRef} />
      <div className="controls-stack-right">
        <Joystick ref={joystickRef} />
        <YawPedals ref={pedalsRef} />
      </div>
    </div>
  )
}
