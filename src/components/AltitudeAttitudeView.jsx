import { useEffect, useRef, useMemo } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { interpRows } from '../utils/interpRows'

const DEG2RAD = Math.PI / 180

// Compute heading (°) from trajectory: bearing between GPS rows spanning vtSec
function computeTrajHdg(gpsRows, vtSec) {
  if (gpsRows.length < 2) return 0
  let idx = 0
  for (let i = 0; i < gpsRows.length - 1; i++) {
    if (gpsRows[i]._tSec <= vtSec) idx = i; else break
  }
  const r1 = gpsRows[Math.max(0, idx - 3)]
  const r2 = gpsRows[Math.min(gpsRows.length - 1, idx + 5)]
  if (r1 === r2) return 0
  const φ1 = r1._lat * DEG2RAD, λ1 = r1._lon * DEG2RAD
  const φ2 = r2._lat * DEG2RAD, λ2 = r2._lon * DEG2RAD
  const dλ = λ2 - λ1
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (Math.atan2(y, x) / DEG2RAD + 360) % 360
}

// Compute pitch (°) from GPS trajectory: arctan(deltaAlt / horizDist)
function computeTrajPitch(gpsRows, vtSec) {
  if (gpsRows.length < 2) return 0
  let idx = 0
  for (let i = 0; i < gpsRows.length - 1; i++) {
    if (gpsRows[i]._tSec <= vtSec) idx = i; else break
  }
  const r1 = gpsRows[Math.max(0, idx - 1)]
  const r2 = gpsRows[Math.min(gpsRows.length - 1, idx + 2)]
  if (r1 === r2) return 0
  const φ1 = r1._lat * DEG2RAD, φ2 = r2._lat * DEG2RAD
  const dφ = φ2 - φ1, dλ = (r2._lon - r1._lon) * DEG2RAD
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
  const horizDist = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  if (horizDist < 1) return 0
  const deltaAlt = (r2['Alt(m)'] ?? 0) - (r1['Alt(m)'] ?? 0)
  return Math.atan2(deltaAlt, horizDist) / DEG2RAD
}

// ── Aircraft model ────────────────────────────────────────────────────────────
function buildPlane() {
  const g = new THREE.Group()
  g.rotation.order = 'YXZ'   // heading → pitch → roll

  // High-vis paint — see comment in GlobeView buildAircraftScene().
  const matBody  = new THREE.MeshPhongMaterial({ color: 0xff7a00, shininess: 90,  specular: 0xffae40 })
  const matDark  = new THREE.MeshPhongMaterial({ color: 0x1a1a1a, shininess: 35 })
  const matWing  = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 60,  specular: 0xeef0ff })
  const matGlass = new THREE.MeshPhongMaterial({ color: 0x4a6e99, shininess: 200, specular: 0xaaddff,
                                                  transparent: true, opacity: 0.72 })
  const matRed   = new THREE.MeshPhongMaterial({ color: 0xff3333, shininess: 100 })
  const matGreen = new THREE.MeshPhongMaterial({ color: 0x33ff77, shininess: 100 })
  const matProp  = new THREE.MeshPhongMaterial({ color: 0x5a6a7a, shininess: 140 })

  const cast = mesh => { mesh.castShadow = true; return mesh }

  // ── Fuselage — cylindrical cross-section, nose-forward along -Z
  const fuse = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.29, 4.0, 14), matBody))
  fuse.rotation.x = Math.PI / 2
  g.add(fuse)

  // Nose cone
  const nose = cast(new THREE.Mesh(new THREE.ConeGeometry(0.24, 1.25, 14), matBody))
  nose.rotation.x = Math.PI / 2
  nose.position.z = -2.62
  g.add(nose)

  // Cockpit canopy (hemisphere bubble)
  const canopy = cast(new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    matGlass
  ))
  canopy.position.set(0, 0.23, -0.65)
  g.add(canopy)

  // Tail cone
  const tailCone = cast(new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.65, 10), matDark))
  tailCone.rotation.x = -Math.PI / 2
  tailCone.position.z = 2.32
  g.add(tailCone)

  // ── Main wings — two halves with sweep and dihedral
  // Each half is offset from centre, rotated for sweep + dihedral, inner box
  const addWingHalf = (side) => {
    const inner = cast(new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.10, 1.40), matWing))
    inner.position.set(side * 1.1, 0.05, 0.1)
    inner.rotation.z = -side * 0.05    // dihedral
    g.add(inner)

    const outer = cast(new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 1.15), matWing))
    outer.position.set(side * 3.1, 0.14, 0.28)
    outer.rotation.y = side * 0.13     // sweep
    outer.rotation.z = -side * 0.10   // dihedral continues
    g.add(outer)

    // Wingtip
    const tip = cast(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.7), matWing))
    tip.position.set(side * 4.45, 0.33, 0.38)
    g.add(tip)

    // Nav light
    const navMat = side < 0 ? matRed : matGreen
    const nav = cast(new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), navMat))
    nav.position.set(side * 4.5, 0.32, 0.38)
    g.add(nav)
  }
  addWingHalf(-1)   // left
  addWingHalf(+1)   // right

  // ── Horizontal stabilisers
  const addHStab = (side) => {
    const hs = cast(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.07, 0.68), matWing))
    hs.position.set(side * 0.85, 0.07, 2.22)
    hs.rotation.y = side * 0.10
    hs.rotation.z = -side * 0.04
    g.add(hs)
  }
  addHStab(-1)
  addHStab(+1)

  // ── Vertical stabiliser
  const vStab = cast(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.82, 0.68), matWing))
  vStab.position.set(0, 0.46, 2.18)
  g.add(vStab)

  // ── Propeller group (spins)
  const propGroup = new THREE.Group()
  propGroup.position.set(0, 0, -3.25)
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.11, 1.9, 0.06), matProp)
  blade.castShadow = true
  const blade2 = blade.clone()
  blade2.rotation.z = Math.PI / 2
  propGroup.add(blade, blade2)
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.24, 10), matDark)
  spinner.rotation.x = Math.PI / 2
  spinner.position.z = -0.16
  spinner.castShadow = true
  propGroup.add(spinner)
  g.add(propGroup)

  return { group: g, propGroup }
}

// ── Compass rose on ground ────────────────────────────────────────────────────
function buildCompassRose() {
  const g = new THREE.Group()
  g.position.y = 0.015

  // Outer ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(7.6, 7.9, 72),
    new THREE.MeshBasicMaterial({ color: 0x3a4a6a, side: THREE.DoubleSide, transparent: true, opacity: 0.7 })
  )
  ring.rotation.x = -Math.PI / 2
  g.add(ring)

  // Cardinal ticks: N longer/red, others white
  const tickMats = {
    N: new THREE.MeshBasicMaterial({ color: 0xff5555 }),
    E: new THREE.MeshBasicMaterial({ color: 0x8899bb }),
    S: new THREE.MeshBasicMaterial({ color: 0x8899bb }),
    W: new THREE.MeshBasicMaterial({ color: 0x8899bb }),
  }
  const cards = [
    { label: 'N', angle: 0,             mat: tickMats.N, len: 1.1 },
    { label: 'E', angle: Math.PI / 2,   mat: tickMats.E, len: 0.6 },
    { label: 'S', angle: Math.PI,       mat: tickMats.S, len: 0.6 },
    { label: 'W', angle: -Math.PI / 2,  mat: tickMats.W, len: 0.6 },
  ]
  for (const { angle, mat, len } of cards) {
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.01, len), mat)
    tick.rotation.y = angle
    tick.position.set(Math.sin(angle) * 7.1, 0, -Math.cos(angle) * 7.1)
    g.add(tick)
  }

  // North arrow (pointing North = -Z in scene)
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0xff4444 })
  const arrowBody = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.01, 3.5), arrowMat)
  arrowBody.position.set(0, 0, -3.5 / 2)
  g.add(arrowBody)
  const arrowHead = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.7, 6), arrowMat)
  arrowHead.rotation.x = Math.PI / 2
  arrowHead.position.set(0, 0, -3.7)
  g.add(arrowHead)

  // South half of arrow (grey)
  const southMat = new THREE.MeshBasicMaterial({ color: 0x556688 })
  const arrowS = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.01, 3.5), southMat)
  arrowS.position.set(0, 0, 3.5 / 2)
  g.add(arrowS)

  return g
}

// ── Pose application ──────────────────────────────────────────────────────────
function applyPose(s, row, baseAlt, altRange, hud, ruler, hdgDeg = 0, pitchDeg = 0) {
  const alt   = row['Alt(m)'] ?? 0
  const pitch = pitchDeg * DEG2RAD
  const roll  = (row._rollDeg  ?? 0) * DEG2RAD
  const hdg   = hdgDeg * DEG2RAD

  const SCALE  = 14 / altRange
  const planeY = Math.max(0.5, (alt - baseAlt) * SCALE)

  // YXZ order: first heading (Y), then pitch (X), then roll (Z)
  // Compass North = -Z in scene. Heading increases clockwise → negative Y rotation.
  // Positive pitch = nose up → positive rotation.x tilts nose toward +Y (up).
  s.plane.rotation.y = -hdg
  s.plane.rotation.x = pitch
  s.plane.rotation.z = -roll
  s.plane.position.y = planeY

  s.pole.scale.y     = planeY
  s.pole.position.y  = planeY / 2
  s.shadowCircle.material.opacity = Math.max(0.04, 0.32 - planeY * 0.014)

  if (s.controls) s.controls.target.set(0, planeY, 0)

  if (hud) {
    const vspd = row['VSpd(m/s)'] ?? 0
    const spd  = row['GSpd(kmh)'] ?? 0
    hud.innerHTML = [
      `<span style="color:#9ece6a">ALT</span> ${alt.toFixed(1)}<small>m</small>`,
      `<span style="color:#7dcfff">V/S</span> ${vspd >= 0 ? '+' : ''}${vspd.toFixed(1)}<small>m/s</small>`,
      `<span style="color:#f7768e">PCH</span> ${pitchDeg.toFixed(1)}°`,
      `<span style="color:#7aa2f7">RLL</span> ${(row._rollDeg ?? 0).toFixed(1)}°`,
      `<span style="color:#e0af68">HDG</span> ${hdgDeg.toFixed(0)}°`,
      `<span style="color:#ff9e64">SPD</span> ${spd.toFixed(0)}<small>km/h</small>`,
    ].join('<br/>')
  }
  if (ruler) updateRuler(ruler, alt, baseAlt, altRange)
}

// ── React component ───────────────────────────────────────────────────────────
export default function AltitudeAttitudeView({ rows, cursorIndex, virtualTimeRef }) {
  const canvasRef = useRef(null)
  const sceneRef  = useRef(null)
  const hudRef    = useRef(null)
  const rulerRef  = useRef(null)
  const baRef     = useRef(0)
  const arRef     = useRef(30)

  useMemo(() => {
    baRef.current = rows[0]?.['Alt(m)'] ?? 0
    const alts = rows.map(r => r['Alt(m)'] ?? 0)
    arRef.current = Math.max(30, Math.max(...alts) - Math.min(...alts))
  }, [rows])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const W = canvas.clientWidth
    const H = canvas.clientHeight

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(W, H)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x070d18)
    scene.fog = new THREE.FogExp2(0x070d18, 0.020)

    // Lighting — key + fill + rim for 3-point setup
    const ambient = new THREE.AmbientLight(0x7788bb, 0.45)
    scene.add(ambient)

    const sun = new THREE.DirectionalLight(0xfff4e0, 1.4)
    sun.position.set(10, 22, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.near = 0.5
    sun.shadow.camera.far  = 80
    sun.shadow.camera.left = sun.shadow.camera.bottom = -20
    sun.shadow.camera.right = sun.shadow.camera.top  = 20
    scene.add(sun)

    const fill = new THREE.DirectionalLight(0x2244aa, 0.4)
    fill.position.set(-10, 6, -12)
    scene.add(fill)

    const rim = new THREE.DirectionalLight(0x99aacc, 0.25)
    rim.position.set(0, -4, -20)
    scene.add(rim)

    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshLambertMaterial({ color: 0x1a3010 })
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    // Grid
    const grid = new THREE.GridHelper(80, 40, 0x243818, 0x243818)
    grid.position.y = 0.01
    scene.add(grid)

    // Compass rose (fixed to world — does not rotate with plane)
    scene.add(buildCompassRose())

    // Altitude pole
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1, 6),
      new THREE.MeshLambertMaterial({ color: 0x4a5580, transparent: true, opacity: 0.55 })
    )
    scene.add(pole)

    // Shadow circle
    const shadowCircle = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 20),
      new THREE.MeshLambertMaterial({ color: 0x000000, transparent: true, opacity: 0.32 })
    )
    shadowCircle.rotation.x = -Math.PI / 2
    shadowCircle.position.y = 0.02
    scene.add(shadowCircle)

    // Aircraft
    const { group: plane, propGroup } = buildPlane()
    scene.add(plane)

    const gpsRows = rows.filter(r => r._lat != null && r._lon != null)

    const camera = new THREE.PerspectiveCamera(52, W / H, 0.1, 600)
    camera.position.set(0, 3, 32)
    camera.lookAt(0, 2, 0)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping  = true
    controls.dampingFactor  = 0.08
    controls.minDistance    = 5
    controls.maxDistance    = 80
    controls.target.set(0, 2, 0)
    controls.update()

    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(canvas)

    sceneRef.current = { renderer, scene, camera, controls, plane, propGroup, pole, shadowCircle }

    let raf
    const animate = () => {
      raf = requestAnimationFrame(animate)
      propGroup.rotation.z += 0.18

      const vt  = virtualTimeRef?.current ?? rows[0]._tSec
      const row = interpRows(rows, vt)
      if (row) applyPose(
        { renderer, scene, camera, controls, plane, propGroup, pole, shadowCircle },
        row, baRef.current, arRef.current,
        hudRef.current, rulerRef.current,
        computeTrajHdg(gpsRows, vt),
        computeTrajPitch(gpsRows, vt)
      )
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      sceneRef.current = null
    }
  }, [])

  return (
    <div className="attitude-view">
      <canvas ref={canvasRef} className="attitude-canvas" />
      <div ref={rulerRef} className="alt-ruler" />
      <div ref={hudRef} className="attitude-hud" />
      <div className="attitude-label">ATTITUDE</div>
    </div>
  )
}

// ── Altitude ruler ────────────────────────────────────────────────────────────
function updateRuler(el, currentAlt, baseAlt, altRange) {
  const step = altRange > 200 ? 50 : altRange > 80 ? 25 : 10
  const maxAlt = baseAlt + altRange
  const minAlt = baseAlt

  const ticks = []
  const first = Math.ceil(minAlt / step) * step
  for (let a = first; a <= maxAlt + step * 0.5; a += step) {
    const pct    = ((a - minAlt) / altRange) * 100
    const clamp  = Math.min(98, Math.max(2, 100 - pct))
    const active = Math.abs(a - currentAlt) < step * 0.5
    ticks.push(
      `<div class="ruler-tick${active ? ' ruler-tick-active' : ''}" style="top:${clamp}%">` +
      `<span class="ruler-val">${a}</span><span class="ruler-line"></span></div>`
    )
  }

  const curPct  = 100 - (((currentAlt - minAlt) / altRange) * 100)
  const clamped = Math.min(96, Math.max(3, curPct))
  ticks.push(
    `<div class="ruler-cursor" style="top:${clamped}%">` +
    `<span class="ruler-cursor-val">${currentAlt.toFixed(0)}</span>` +
    `<span class="ruler-cursor-arrow">◄</span></div>`
  )

  el.innerHTML = ticks.join('')
}
