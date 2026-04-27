import { useEffect, useRef, useMemo, useState } from 'react'
import * as Cesium from 'cesium'
import * as THREE from 'three'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { interpRows } from '../utils/interpRows'
import { track } from '../utils/analytics'

// Cesium Ion token comes from Vite env (VITE_CESIUM_TOKEN). Empty token still
// renders Bing-imagery fallback; a real token unlocks higher-res tiles + 3D Tiles.
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN || ''

const FM_COLORS = {
  ANGL: '#9ece6a', RTH: '#f7768e', CRUZ: '#7dcfff',
  MANU: '#565f89', ACRO: '#ff9e64', HOLD: '#bb9af7',
  NAVWP: '#e0af68', POSHOLD: '#bb9af7', ALTHOLD: '#ff79c6',
  LAND: '#f7768e',
}
function fmColor(m) { return FM_COLORS[m] || '#7aa2f7' }

// Catmull-Rom smooth a Cartesian3[] array
function catmullRomSmooth(pts, steps = 8) {
  if (pts.length < 2) return pts
  const out = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let j = 0; j < steps; j++) {
      const t = j / steps, t2 = t * t, t3 = t2 * t
      const cr = (a, b, c, d) => 0.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t2+(-a+3*b-3*c+d)*t3)
      out.push(new Cesium.Cartesian3(cr(p0.x,p1.x,p2.x,p3.x), cr(p0.y,p1.y,p2.y,p3.y), cr(p0.z,p1.z,p2.z,p3.z)))
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

// Bearing (°) between two GPS points
const D2R = Math.PI / 180
function gpsBearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1*D2R, φ2 = lat2*D2R, dλ = (lon2-lon1)*D2R
  const y = Math.sin(dλ)*Math.cos(φ2)
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ)
  return (Math.atan2(y,x)/D2R + 360) % 360
}

function updateHud(el, r) {
  if (!el || !r) return
  const fm   = r['FM'] || '—'
  const alt  = r['Alt(m)'] ?? 0
  const vspd = r['VSpd(m/s)'] ?? 0
  const spd  = r['GSpd(kmh)'] ?? 0
  const hdg  = r['Hdg(°)'] ?? 0
  el.innerHTML = [
    `<span style="color:${fmColor(fm)};font-weight:700">${fm}</span>`,
    `<span style="color:#9ece6a">ALT</span> ${alt.toFixed(1)}<small>m</small>`,
    `<span style="color:#7dcfff">V/S</span> ${vspd >= 0 ? '+' : ''}${vspd.toFixed(1)}<small>m/s</small>`,
    `<span style="color:#f7768e">PCH</span> ${(r._pitchDeg ?? 0).toFixed(1)}°`,
    `<span style="color:#7aa2f7">RLL</span> ${(r._rollDeg ?? 0).toFixed(1)}°`,
    `<span style="color:#e0af68">HDG</span> ${hdg.toFixed(0)}°`,
    `<span style="color:#ff9e64">SPD</span> ${spd.toFixed(0)}<small>km/h</small>`,
  ].join('<br/>')
}

function lerpHdg(from, to, t) {
  let diff = ((to - from + 540) % 360) - 180
  return from + diff * t
}

// Strobe pulse — returns 0..1 over a 1.1 s cycle. Sharp 70 ms peak with a
// short fade tail, then a 0.35 baseline (steady-on position light glow).
// `phaseMs` shifts the cycle so port and starboard can alternate.
function strobeBrightness(phaseMs = 0) {
  const t = (((Date.now() + phaseMs) % 1100) + 1100) % 1100 / 1100
  if (t < 0.06) return 1.0
  if (t < 0.16) return 1.0 - ((t - 0.06) / 0.10) * 0.65
  return 0.35
}

// Add a point primitive at a wing-tip offset that tracks the aircraft's pose
// and flashes like a real anti-collision light.
function addWingtipStrobe(viewer, getAircraftEntity, localOffset, color, phaseMs) {
  const reusableMatrix = new Cesium.Matrix3()
  const reusableDelta = new Cesium.Cartesian3()
  const reusableResult = new Cesium.Cartesian3()

  return viewer.entities.add({
    position: new Cesium.CallbackProperty((time, result) => {
      const ac = getAircraftEntity()
      if (!ac) return undefined
      const pos = ac.position?.getValue?.(time)
      const ori = ac.orientation?.getValue?.(time)
      if (!pos || !ori) return undefined
      const rot = Cesium.Matrix3.fromQuaternion(ori, reusableMatrix)
      const dW = Cesium.Matrix3.multiplyByVector(rot, localOffset, reusableDelta)
      return Cesium.Cartesian3.add(pos, dW, result || reusableResult)
    }, false),
    point: {
      pixelSize: new Cesium.CallbackProperty(
        () => 5 + strobeBrightness(phaseMs) * 18,
        false,
      ),
      color: new Cesium.CallbackProperty(
        () => color.withAlpha(0.4 + strobeBrightness(phaseMs) * 0.6),
        false,
      ),
      outlineColor: new Cesium.CallbackProperty(
        () => color.withAlpha(strobeBrightness(phaseMs) * 0.6),
        false,
      ),
      outlineWidth: 4,
      // Render through terrain — the lights stay visible even when the
      // wing tip would otherwise be occluded by a hill at low altitude.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  })
}

// ── Build Three.js aircraft scene for GLB export ───────────────────────────────
// Nose along -Z (glTF/Cesium "forward"), up +Y, wings span X
// At Cesium HPR(0,0,0), glTF -Z maps to North, so nose points North → heading is straight compass
function buildAircraftScene() {
  const scene = new THREE.Scene()
  const mat = (hex, rough = 0.55, metal = 0.25) =>
    new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal })

  // High-vis paint scheme — safety orange body with white wings + black
  // accents reads cleanly against any satellite backdrop (forest, water,
  // snow, urban). Black canopy and tip stripes give a dark anchor for
  // light backgrounds; orange + white pop on dark backgrounds.
  const matBody  = mat(0xff7a00, 0.45, 0.25)   // safety orange fuselage
  const matWing  = mat(0xffffff, 0.55, 0.10)   // white wings
  const matDark  = mat(0x1a1a1a, 0.50, 0.30)   // black tail / wing tips
  const matGlass = mat(0x162236, 0.05, 0.65)   // very dark blue canopy

  // Nav lights — emissive so they glow within the GLB even after the
  // Three.js scene loses its lighting context (Cesium renders the model
  // with its own scene lights). Cesium-side strobe primitives (added in
  // the useEffect after the model loads) flash on top of these for the
  // anti-collision effect.
  const matRed = new THREE.MeshStandardMaterial({
    color: 0xff2020, roughness: 0.25, metalness: 0.30,
    emissive: 0xff2020, emissiveIntensity: 0.9,
  })
  const matGrn = new THREE.MeshStandardMaterial({
    color: 0x20ff60, roughness: 0.25, metalness: 0.30,
    emissive: 0x20ff60, emissiveIntensity: 0.9,
  })

  const g = new THREE.Group()

  // Fuselage cylinder along Z axis (forward = -Z)
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.33, 5.0, 12), matBody)
  fuse.rotation.x = Math.PI / 2
  g.add(fuse)

  // Nose cone at -Z
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.5, 12), matBody)
  nose.rotation.x = -Math.PI / 2
  nose.position.z = -3.25
  g.add(nose)

  // Tail cone at +Z
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.75, 10), matDark)
  tail.rotation.x = Math.PI / 2
  tail.position.z = 2.9
  g.add(tail)

  // Cockpit canopy (on top, forward of centre)
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    matGlass
  )
  canopy.position.set(0, 0.26, -1.0)
  g.add(canopy)

  // Wings spanning X axis
  const addWing = (side) => {
    const inner = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 2.1), matWing)
    inner.position.set(side * 1.1, 0.06, -0.2)
    inner.rotation.z = -side * 0.05
    g.add(inner)

    const outer = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.10, 1.7), matWing)
    outer.position.set(side * 3.2, 0.15, -0.4)
    outer.rotation.z = -side * 0.10
    g.add(outer)

    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.44, 0.8), matWing)
    tip.position.set(side * 4.8, 0.34, -0.4)
    g.add(tip)

    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.10, 6, 5), side < 0 ? matRed : matGrn)
    nav.position.set(side * 4.85, 0.30, -0.4)
    g.add(nav)
  }
  addWing(-1)
  addWing(+1)

  // Horizontal stabilisers (span X, at tail)
  const hStab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.09, 0.85), matWing)
  hStab.position.set(0, 0.09, 2.6)
  g.add(hStab)

  // Vertical stabiliser (at tail)
  const vStab = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.0, 0.85), matWing)
  vStab.position.set(0, 0.56, 2.6)
  g.add(vStab)

  scene.add(g)
  return scene
}

// Export scene to GLB blob URL (async)
async function buildAircraftGLB() {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  const scene = buildAircraftScene()
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      scene,
      (buf) => resolve(URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }))),
      reject,
      { binary: true }
    )
  })
}

export default function GlobeView({ rows, cursorIndex, virtualTimeRef }) {
  const containerRef  = useRef(null)
  const stateRef      = useRef(null)
  const curRowRef     = useRef(null)
  const trajHdgRef    = useRef(0)
  const trajPitchRef  = useRef(0)
  const autoRef       = useRef(true)
  const hudRef        = useRef(null)
  const glbUrlRef     = useRef(null)
  const [autoMode, setAutoMode] = useState(true)

  const gpsRows = useMemo(() => rows.filter(r => r._lat != null && r._lon != null), [rows])

  useEffect(() => {
    if (!containerRef.current || gpsRows.length < 2) return

    const viewer = new Cesium.Viewer(containerRef.current, {
      geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false,
      baseLayerPicker: false, fullscreenButton: false,
      selectionIndicator: false, infoBox: false,
    })

    const cc = viewer.cesiumWidget?.creditContainer
    if (cc) cc.style.display = 'none'

    // Disable inertia — zoom/pan/orbit should stop the instant the user releases input
    const ssc = viewer.scene.screenSpaceCameraController
    ssc.inertiaSpin = 0
    ssc.inertiaTranslate = 0
    ssc.inertiaZoom = 0

    viewer.imageryLayers.removeAll()
    Cesium.ArcGisMapServerImageryProvider
      .fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer')
      .then(p => viewer.imageryLayers.addImageryProvider(p))
      .catch(() =>
        Cesium.OpenStreetMapImageryProvider.fromUrl('https://tile.openstreetmap.org/')
          .then(p => viewer.imageryLayers.addImageryProvider(p))
      )

    // FM-coloured flight path
    let prevFM = null, segPts = []
    const flush = () => {
      if (segPts.length < 2) return
      viewer.entities.add({
        polyline: {
          positions: catmullRomSmooth(segPts.slice()), clampToGround: false, width: 3,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.fromCssColorString(fmColor(prevFM)),
          }),
        },
      })
    }
    for (const r of gpsRows) {
      const fm = r['FM'] || 'UNKNOWN'
      const pt = Cesium.Cartesian3.fromDegrees(r._lon, r._lat, Math.max(0, r['Alt(m)'] || 0))
      if (fm !== prevFM) { flush(); segPts = segPts.length ? [segPts[segPts.length - 1]] : []; prevFM = fm }
      segPts.push(pt)
    }
    flush()

    const addDot = (r, color) => viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(r._lon, r._lat, Math.max(0, r['Alt(m)'] || 0)),
      point: { pixelSize: 9, color: Cesium.Color.fromCssColorString(color), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Infinity },
    })
    addDot(gpsRows[0], '#9ece6a')
    addDot(gpsRows[gpsRows.length - 1], '#f7768e')

    // ── 3D aircraft model (async GLB build) ───────────────────────────────────
    let cancelled = false
    let aircraftEntity = null
    buildAircraftGLB().then(url => {
      if (cancelled) { URL.revokeObjectURL(url); return }
      glbUrlRef.current = url

      aircraftEntity = viewer.entities.add({
        position: new Cesium.CallbackProperty(() => {
          const r = curRowRef.current
          if (!r || r._lat == null) return Cesium.Cartesian3.fromDegrees(gpsRows[0]._lon, gpsRows[0]._lat, 0)
          return Cesium.Cartesian3.fromDegrees(r._lon, r._lat, Math.max(0, r['Alt(m)'] || 0))
        }, false),
        orientation: new Cesium.CallbackProperty(() => {
          const r = curRowRef.current
          const pos = r?._lat != null
            ? Cesium.Cartesian3.fromDegrees(r._lon, r._lat, Math.max(0, r['Alt(m)'] || 0))
            : Cesium.Cartesian3.fromDegrees(gpsRows[0]._lon, gpsRows[0]._lat, 0)

          // Cesium glTF 2.0: forwardAxis=+Z → mapped to East at HPR=0.
          // Our nose is at -Z, so at HPR=0 nose points West.
          // HPR heading CW from North: West→North needs +π/2 offset.
          const hpr = new Cesium.HeadingPitchRoll(
            trajHdgRef.current * D2R + Math.PI / 2,
            trajPitchRef.current * D2R,
            -(r?._rollDeg ?? 0) * D2R
          )
          return Cesium.Transforms.headingPitchRollQuaternion(pos, hpr)
        }, false),
        model: {
          uri: url,
          minimumPixelSize: 48,
          maximumScale: 8000,
        },
      })

      // ── Wingtip strobes — Cesium point primitives that flash like real
      // anti-collision lights. Position is derived from the aircraft's
      // current pose each frame; color + size are modulated by a strobe
      // pulse with a 0.35 baseline (steady-on position light) and a sharp
      // spike to 1.0 every 1.1 s. Port and starboard are 250 ms out of
      // phase so the flashes alternate.
      const LEFT_WT  = new Cesium.Cartesian3(-4.85, 0.30, -0.4)
      const RIGHT_WT = new Cesium.Cartesian3( 4.85, 0.30, -0.4)
      const navAircraftEntityGetter = () => aircraftEntity
      addWingtipStrobe(viewer, navAircraftEntityGetter, LEFT_WT,
                       Cesium.Color.fromCssColorString('#ff2020'), 0)
      addWingtipStrobe(viewer, navAircraftEntityGetter, RIGHT_WT,
                       Cesium.Color.fromCssColorString('#20ff60'), 250)
    }).catch(err => console.error('aircraft GLB build failed:', err))

    // Altitude stem
    viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const r = curRowRef.current
          if (!r || r._lat == null) return []
          const alt = Math.max(0, r['Alt(m)'] || 0)
          return [
            Cesium.Cartesian3.fromDegrees(r._lon, r._lat, 0),
            Cesium.Cartesian3.fromDegrees(r._lon, r._lat, alt),
          ]
        }, false),
        width: 1.5,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#ff9e64').withAlpha(0.35)
        ),
      },
    })

    // ── Per-frame: trajectory heading + pitch + camera ────────────────────────
    const smooth = { pos: null, hdg: 0, dist: 500 }
    let lastHudUpdate = 0

    viewer.scene.preRender.addEventListener(() => {
      const vt = virtualTimeRef?.current ?? rows[0]._tSec
      const r  = interpRows(rows, vt)
      if (!r || r._lat == null) return
      curRowRef.current = r

      // GPS index
      let gi = 0
      for (let i = 0; i < gpsRows.length - 1; i++) { if (gpsRows[i]._tSec <= vt) gi = i; else break }

      // Smoothed compass bearing from wide GPS window
      const g1 = gpsRows[Math.max(0, gi - 3)], g2 = gpsRows[Math.min(gpsRows.length - 1, gi + 5)]
      if (g1 !== g2) {
        const newHdg = gpsBearing(g1._lat, g1._lon, g2._lat, g2._lon)
        const diff = ((newHdg - trajHdgRef.current + 540) % 360) - 180
        trajHdgRef.current = (trajHdgRef.current + diff * 0.03 + 360) % 360
      }

      // Smoothed trajectory pitch from altitude change over horizontal distance
      const gp1 = gpsRows[Math.max(0, gi - 3)], gp2 = gpsRows[Math.min(gpsRows.length - 1, gi + 5)]
      if (gp1 !== gp2 && gp1['Alt(m)'] != null && gp2['Alt(m)'] != null) {
        const φ1 = gp1._lat * D2R, φ2 = gp2._lat * D2R
        const dφ = φ2 - φ1, dλ = (gp2._lon - gp1._lon) * D2R
        const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2
        const hd = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        if (hd > 1) {
          const newPitch = Math.atan2((gp2['Alt(m)'] ?? 0) - (gp1['Alt(m)'] ?? 0), hd) / D2R
          trajPitchRef.current += (newPitch - trajPitchRef.current) * 0.05
        }
      }

      const now = performance.now()
      if (now - lastHudUpdate > 100) { lastHudUpdate = now; updateHud(hudRef.current, r) }

      if (!autoRef.current) return

      const alt    = Math.max(0, r['Alt(m)'] || 0)
      const spdMs  = (r['GSpd(kmh)'] || 0) / 3.6
      const target = Cesium.Cartesian3.fromDegrees(r._lon, r._lat, alt)
      const targetHdg  = trajHdgRef.current
      const targetDist = Math.max(150, Math.min(600, spdMs * 5 + alt * 1.5 + 150))

      if (!smooth.pos) {
        smooth.pos  = target.clone()
        smooth.hdg  = targetHdg
        const camDist = Cesium.Cartesian3.distance(viewer.camera.position, smooth.pos)
        smooth.dist = Math.max(150, Math.min(600, camDist))
      } else {
        Cesium.Cartesian3.lerp(smooth.pos, target, 0.05, smooth.pos)
        // Heading: deadband so small drifts/turns don't rotate the camera.
        // Only follow if offset > 45°, and then slowly (0.4%/frame).
        const hdgDelta = ((targetHdg - smooth.hdg + 540) % 360) - 180
        if (Math.abs(hdgDelta) > 45) smooth.hdg = lerpHdg(smooth.hdg, targetHdg, 0.004)
        smooth.hdg = ((smooth.hdg % 360) + 360) % 360  // wrap to [0,360)
        smooth.dist += (targetDist - smooth.dist) * 0.008
      }

      viewer.camera.lookAt(
        smooth.pos,
        new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(smooth.hdg + 180),
          Cesium.Math.toRadians(-18),
          smooth.dist,
        )
      )
    })

    // Initial fly-to
    const lons = gpsRows.map(r => r._lon), lats = gpsRows.map(r => r._lat)
    const pad = 0.008
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        Math.min(...lons) - pad, Math.min(...lats) - pad,
        Math.max(...lons) + pad, Math.max(...lats) + pad,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
      duration: 2,
      complete: () => {
        const r0 = gpsRows[0]
        const anchor = Cesium.Cartesian3.fromDegrees(r0._lon, r0._lat, Math.max(0, r0['Alt(m)'] || 0))
        smooth.dist = Math.min(600, Cesium.Cartesian3.distance(viewer.camera.position, anchor))
        smooth.pos = null
      },
    })

    // Mouse/scroll → manual mode: camera still follows aircraft but user orbits/zooms freely.
    // We use Cesium.trackedEntity which keeps the camera locked onto the moving aircraft
    // while letting the ScreenSpaceCameraController handle all mouse rotation/zoom/tilt.
    const releaseAuto = () => {
      if (!autoRef.current) return
      autoRef.current = false
      setAutoMode(false)
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
      if (aircraftEntity) { viewer.trackedEntity = aircraftEntity; viewer.camera.constrainedAxis = undefined }
    }
    const el = containerRef.current
    el.addEventListener('mousedown', releaseAuto)
    el.addEventListener('wheel', releaseAuto)

    stateRef.current = { viewer, smooth, getAircraftEntity: () => aircraftEntity }
    curRowRef.current = gpsRows[0]

    // Force Cesium to recompute its canvas backing buffer when the wrap
    // changes size — most importantly when entering or exiting fullscreen.
    // Cesium's internal observer doesn't always fire fast enough on exit,
    // which leaves the canvas at fullscreen pixel dimensions even though
    // the wrap CSS has shrunk back. Calling viewer.resize() forces it.
    const wrap = el.closest('.globe-wrap')
    const onFsChange = () => {
      requestAnimationFrame(() => {
        try { viewer.resize() } catch (_) {}
        // A second tick once the layout has settled.
        setTimeout(() => { try { viewer.resize() } catch (_) {} }, 120)
      })
    }
    document.addEventListener('fullscreenchange', onFsChange)

    let resizeObserver = null
    if (wrap && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        try { viewer.resize() } catch (_) {}
      })
      resizeObserver.observe(wrap)
    }

    return () => {
      cancelled = true
      el.removeEventListener('mousedown', releaseAuto)
      el.removeEventListener('wheel', releaseAuto)
      document.removeEventListener('fullscreenchange', onFsChange)
      resizeObserver?.disconnect()
      stateRef.current = null
      if (glbUrlRef.current) { URL.revokeObjectURL(glbUrlRef.current); glbUrlRef.current = null }
      try { viewer.destroy() } catch (_) {}
    }
  }, [gpsRows])

  const toggleAuto = () => {
    const next = !autoMode
    setAutoMode(next)
    autoRef.current = next
    track('camera_mode_toggled', { mode: next ? 'auto' : 'manual' })
    const s = stateRef.current
    if (!s) return
    if (!next) {
      s.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
      const ac = s.getAircraftEntity?.()
      if (ac) { s.viewer.trackedEntity = ac; s.viewer.camera.constrainedAxis = undefined }
    } else {
      // Back to auto: release trackedEntity and any residual orbit transform
      s.viewer.trackedEntity = undefined
      s.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
      s.smooth.pos = null
    }
  }

  // ── Nav widget: ensure manual mode then step-drive the camera ───────────────
  const ensureManual = () => {
    const s = stateRef.current
    if (!s) return null
    if (autoRef.current) {
      autoRef.current = false
      setAutoMode(false)
      s.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
      const ac = s.getAircraftEntity?.()
      if (ac) { s.viewer.trackedEntity = ac; s.viewer.camera.constrainedAxis = undefined }
    }
    return s.viewer
  }
  const navHeld = (fn) => {
    // press-and-hold: fire repeatedly while mouse is down
    let raf = null
    const tick = () => {
      const v = ensureManual()
      if (v) fn(v.camera)
      raf = requestAnimationFrame(tick)
    }
    const onDown = (e) => { e.preventDefault(); tick() }
    const onUp = () => { if (raf) cancelAnimationFrame(raf); raf = null }
    return {
      onMouseDown: onDown,
      onMouseUp: onUp,
      onMouseLeave: onUp,
      onTouchStart: onDown,
      onTouchEnd: onUp,
    }
  }

  // Camera actions — small per-frame increments so hold-to-spin feels smooth
  const ROT = 0.02  // rad per frame for rotate/tilt
  const ZOOM = 8    // meters per frame for zoom
  const PITCH_MIN = -Math.PI / 2 + 0.08  // avoid straight-down lock
  const PITCH_MAX =  Math.PI / 2 - 0.08  // avoid straight-up lock
  const rotLeft  = (c) => c.rotateLeft(ROT)
  const rotRight = (c) => c.rotateRight(ROT)
  // rotateUp(+) tilts camera up relative to surface → pitch increases toward 0/above horizon.
  // Guard so repeated hold doesn't pin us at the pole.
  const tiltUp   = (c) => { if (c.pitch < PITCH_MAX) c.rotateUp(ROT) }
  const tiltDown = (c) => { if (c.pitch > PITCH_MIN) c.rotateDown(ROT) }
  const zoomIn   = (c) => c.zoomIn(ZOOM)
  const zoomOut  = (c) => c.zoomOut(ZOOM)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div ref={hudRef} className="globe-hud" />
      <button
        className={`globe-auto-btn${autoMode ? ' active' : ''}`}
        onClick={toggleAuto}
        title={autoMode ? 'Click to take manual control' : 'Click to re-enable auto follow'}
      >
        {autoMode ? '⊙ AUTO' : '✥ MANUAL'}
      </button>

      {/* Google Earth-style nav widget: compass + tilt + zoom */}
      <div className="globe-nav" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <div className="nav-compass" title="Rotate heading">
          <button className="nav-btn nav-rot-l" {...navHeld(rotLeft)}  title="Rotate left">↺</button>
          <div className="nav-compass-mark">N</div>
          <button className="nav-btn nav-rot-r" {...navHeld(rotRight)} title="Rotate right">↻</button>
        </div>
        <div className="nav-tilt" title="Tilt camera">
          <button className="nav-btn" {...navHeld(tiltUp)}   title="Tilt up">▲</button>
          <button className="nav-btn" {...navHeld(tiltDown)} title="Tilt down">▼</button>
        </div>
        <div className="nav-zoom" title="Zoom">
          <button className="nav-btn" {...navHeld(zoomIn)}  title="Zoom in">+</button>
          <button className="nav-btn" {...navHeld(zoomOut)} title="Zoom out">−</button>
        </div>
      </div>
    </div>
  )
}
