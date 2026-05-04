import { forwardRef, useImperativeHandle, useRef } from 'react'
import RcController from './RcController'

/**
 * Pilot input cluster — what the pilot was COMMANDING via the radio's
 * stick channels, mirroring the GaugeCluster on the other side that
 * shows what the AIRCRAFT was DOING. Reading both at once turns a
 * flight log into "watch the pilot fly the plane."
 *
 * The cluster used to render three separate widgets (ThrottleLever +
 * Joystick + YawPedals). It now renders a single RC-transmitter view
 * (RcController) — same channel data, but visualised on a recognisable
 * RadioMaster Pocket-style two-stick remote. One device = one mental
 * model for the pilot's hands.
 *
 * Source field per stick (Mode 2 convention):
 *   LEFT  stick → Y = row._throttle, X = row._stickYaw
 *   RIGHT stick → Y = row._stickPitch, X = row._stickRoll
 *
 * Logs without pilot-input fields → setSticks receives nulls and the
 * controller shows a "NO TLM" overlay; sticks freeze centred.
 */
const ControlsCluster = forwardRef(function ControlsCluster(_props, ref) {
  const rcRef = useRef(null)

  useImperativeHandle(ref, () => ({
    update(r) {
      if (!r) return
      rcRef.current?.setSticks({
        throttle: r._throttle,
        yaw:      r._stickYaw,
        pitch:    r._stickPitch,
        roll:     r._stickRoll,
      })
    },
  }))

  return (
    <div className="controls-cluster" aria-label="Pilot input cluster">
      <RcController ref={rcRef} />
    </div>
  )
})

export default ControlsCluster
