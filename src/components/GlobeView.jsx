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

// Strobe pulse — returns 0..1 over a 2.5 s cycle. Brief 60 ms peak and
// short fade tail, then a 0.30 baseline. Earlier the cycle was 1.1 s
// with a peak that — combined with the strobe primitive's 23 px peak
// pixelSize — read as "model deforming every second" at typical
// follow distances where the model is only ~20 px wide. Stretching
// the period and lowering both peak/baseline keeps the nav-light
// effect without dominating the visible model.
function strobeBrightness(phaseMs = 0) {
  const PERIOD = 2500
  const t = (((Date.now() + phaseMs) % PERIOD) + PERIOD) % PERIOD / PERIOD
  if (t < 0.024) return 1.0                                       // ~60 ms peak
  if (t < 0.080) return 1.0 - ((t - 0.024) / 0.056) * 0.7         // ~140 ms decay
  return 0.30
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
      // 4 px baseline → 12 px peak (was 5 → 23). Sized so the strobe
      // reads as a nav light next to the model, not a flare that
      // dominates the model's silhouette at close follow distances.
      pixelSize: new Cesium.CallbackProperty(
        () => 4 + strobeBrightness(phaseMs) * 8,
        false,
      ),
      color: new Cesium.CallbackProperty(
        () => color.withAlpha(0.35 + strobeBrightness(phaseMs) * 0.4),
        false,
      ),
      outlineColor: new Cesium.CallbackProperty(
        () => color.withAlpha(strobeBrightness(phaseMs) * 0.35),
        false,
      ),
      outlineWidth: 2,
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

  // Wings — each side is a single continuous tapered surface instead of
  // the previous two-box-per-wing design (which left a visible seam at
  // the join). Built from a planform Shape extruded into thickness with
  // bevelled edges, so the surfaces blend rather than stack.
  //
  // Coordinate system in the planform Shape:
  //   X axis = span (root → tip), positive = right side
  //   Z axis = chord (negative = leading edge / forward, positive = trailing)
  // Then extrude by `depth` along Y to give the wing its thickness.
  const buildWingHalf = (side, opts) => {
    const { rootChord, tipChord, span, depth, sweep = 0, mat } = opts
    const halfRoot = rootChord / 2
    const halfTip = tipChord / 2
    const tipX = span * side
    const shape = new THREE.Shape()
    // Root leading-edge → tip leading-edge → tip trailing-edge → root trailing-edge
    shape.moveTo(0, -halfRoot)
    shape.lineTo(tipX, -halfTip + sweep)
    shape.lineTo(tipX, halfTip + sweep)
    shape.lineTo(0, halfRoot)
    shape.closePath()

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelSize: 0.04,
      bevelThickness: 0.02,
      bevelSegments: 2,
      curveSegments: 1,
    })
    // ExtrudeGeometry extrudes along +Z by default. We want thickness
    // along Y (vertical) and the planform in the XZ plane, so rotate.
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, -depth / 2, 0)
    return new THREE.Mesh(geo, mat)
  }

  const addWing = (side) => {
    const wing = buildWingHalf(side, {
      rootChord: 2.1,
      tipChord: 0.9,
      span: 4.85,
      depth: 0.10,
      sweep: 0.30,         // leading edge angled aft so the tip sits slightly behind the root
      mat: matWing,
    })
    wing.position.set(0, 0.08, -0.10)
    wing.rotation.z = -side * 0.04   // subtle dihedral
    g.add(wing)

    // Winglet — small upturned plate at the tip. Reads as "modern airliner-ish"
    // without committing to a full airliner silhouette.
    const wingletGeo = new THREE.BoxGeometry(0.08, 0.55, 0.85)
    const winglet = new THREE.Mesh(wingletGeo, matDark)
    winglet.position.set(side * 4.85, 0.34, -0.10 + 0.30)
    winglet.rotation.z = -side * 0.18
    g.add(winglet)

    // Nav light at the wingtip leading edge
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6), side < 0 ? matRed : matGrn)
    nav.position.set(side * 4.85, 0.30, -0.40)
    g.add(nav)
  }
  addWing(-1)
  addWing(+1)

  // Horizontal stabilisers — same single-piece treatment as the main wing.
  const hStabGeo = new THREE.ExtrudeGeometry(
    (() => {
      const s = new THREE.Shape()
      s.moveTo(-1.6, -0.42)
      s.lineTo(1.6, -0.42)
      s.lineTo(1.6, 0.42)
      s.lineTo(-1.6, 0.42)
      s.closePath()
      return s
    })(),
    { depth: 0.09, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.015, bevelSegments: 1 }
  )
  hStabGeo.rotateX(-Math.PI / 2)
  hStabGeo.translate(0, -0.045, 0)
  const hStab = new THREE.Mesh(hStabGeo, matWing)
  hStab.position.set(0, 0.09, 2.6)
  g.add(hStab)

  // Vertical stabiliser — slightly tapered for a more realistic profile
  // than a slab box. Wider at the root, narrower at the top.
  const vStabShape = new THREE.Shape()
  vStabShape.moveTo(-0.45, 0)        // root leading edge
  vStabShape.lineTo(0.45, 0)         // root trailing edge
  vStabShape.lineTo(0.20, 1.05)      // tip trailing edge
  vStabShape.lineTo(-0.05, 1.05)     // tip leading edge
  vStabShape.closePath()
  const vStabGeo = new THREE.ExtrudeGeometry(vStabShape, {
    depth: 0.09, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.01, bevelSegments: 1,
  })
  vStabGeo.translate(0, 0, -0.045)   // center thickness
  const vStab = new THREE.Mesh(vStabGeo, matWing)
  // ExtrudeGeometry's natural orientation has the shape in XY and depth
  // in Z — exactly what we want for the vertical stab (height in Y,
  // chord in X, thickness in Z).
  vStab.position.set(0, 0.18, 2.6)
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
  // Smoothed copy of the telemetry _pitchDeg. Used for the model's
  // attitude (matches the HUD), kept separate from trajPitchRef which
  // tracks trajectory slope.
  const attitudePitchRef = useRef(0)
  const autoRef       = useRef(true)
  const hudRef        = useRef(null)
  const glbUrlRef     = useRef(null)
  const [autoMode, setAutoMode] = useState(true)

  const gpsRows = useMemo(() => rows.filter(r => r._lat != null && r._lon != null), [rows])

  // Polyline points use a SUBSET of gpsRows. The blackbox mapper produces
  // ~7000 rows per log (every main frame interpolated linearly between
  // adjacent GPS frames so the aircraft moves smoothly per frame). That
  // density is great for the live aircraft entity but feeds Catmull-Rom
  // smoothing in the path polyline a problem set: subtle GPS noise
  // between adjacent frames + tight point spacing → tiny S-curves at
  // every GPS-frame boundary, visible as waves on the path.
  // Downsample to ~600 points (matches the original GPS rate) so the
  // smoother sees coarse waypoints and produces a clean curve.
  const pathRows = useMemo(() => {
    const target = 600
    const stride = Math.max(1, Math.floor(gpsRows.length / target))
    if (stride === 1) return gpsRows
    const out = []
    for (let i = 0; i < gpsRows.length; i += stride) out.push(gpsRows[i])
    // Always include the final row so the path doesn't end short.
    if (out[out.length - 1] !== gpsRows[gpsRows.length - 1]) {
      out.push(gpsRows[gpsRows.length - 1])
    }
    return out
  }, [gpsRows])

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

    // ── Flight path: FM-coloured past + faded gray future ────────────────
    // Cheap implementation: regular Polylines (screen-space strokes), no
    // 3D extrusion. PolylineVolume turned out to be far too expensive —
    // tessellating a multi-thousand-position volume on every cursor
    // change tanked the framerate. Polylines render as GPU-friendly
    // thick lines and are essentially free to update.
    //
    //  • Per-FM static polyline (covers the WHOLE path) — drawn first,
    //    so FM colours are visible underneath wherever nothing's on top.
    //  • Single gray-future polyline (positions = pathPositions[idx..end])
    //    drawn AFTER the FM polylines, slightly wider, opaque-ish gray.
    //    Wherever the future overlay is present it covers the FM colour
    //    underneath; wherever it isn't (i.e. the past segment), the FM
    //    colour shows through.
    //
    // Width is in pixels, so the visual thickness is consistent across
    // zoom — no ill-defined "tube radius in metres" to tune.
    const SMOOTH_STEPS = 8
    const pathPositions = (() => {
      const pts = pathRows.map(r =>
        Cesium.Cartesian3.fromDegrees(
          r._lon, r._lat, Math.max(0, r['Alt(m)'] || 0),
        ),
      )
      return catmullRomSmooth(pts, SMOOTH_STEPS)
    })()
    const FM_LINE_WIDTH = 4
    // Future stroke must be at least as wide as the FM stroke so it
    // cleanly covers the underlying FM polyline in the future zone.
    // Going thinner (the original "1 px hairline" intent) lets FM
    // colours leak around the gray, defeating the past/future split.
    const FUTURE_LINE_WIDTH = 4
    const FUTURE_COLOR = Cesium.Color.fromCssColorString('#bdbdbd')

    // pathRows sorted ascending by _tSec — binary-search for the
    // vt-aligned index, then interpolate WITHIN the bracketing pair so
    // the split lands exactly at the aircraft's actual position rather
    // than at the next pathRow boundary (which could be up to ~1 s of
    // path AHEAD of the aircraft, making the FM-coloured "past" appear
    // to lead the model).
    const tubeIdxRef = { current: 0 }
    const updateTubeIdx = () => {
      const vt = virtualTimeRef?.current ?? rows[0]._tSec
      let lo = 0, hi = pathRows.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (pathRows[mid]._tSec < vt) lo = mid + 1
        else hi = mid
      }
      // lo = first pathRows index with _tSec >= vt.
      // The aircraft is positioned BETWEEN pathRows[lo-1] and pathRows[lo].
      let smIdx
      if (lo === 0) {
        smIdx = 0
      } else {
        const t0 = pathRows[lo - 1]._tSec
        const t1 = pathRows[lo]._tSec
        const frac = t1 > t0 ? (vt - t0) / (t1 - t0) : 0
        const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac
        // Catmull-rom inserts SMOOTH_STEPS samples between each pair of
        // pathRows, so the aircraft's smoothed-position index inside
        // the bracket is (lo-1)*STEPS + fraction*STEPS, floored.
        smIdx = (lo - 1) * SMOOTH_STEPS + Math.floor(clamped * SMOOTH_STEPS)
      }
      tubeIdxRef.current = Math.min(pathPositions.length - 1, smIdx)
    }
    updateTubeIdx()

    // Per-FM-segment STATIC polylines covering the whole path. No
    // CallbackProperty — built once at log load. This was previously
    // dynamic (sliced to the cursor each frame) to avoid FM colour
    // bleed through the gray future, but per-segment CallbackProperty
    // evaluations dropped the frame rate from 60fps to ~22fps and
    // produced visible stutter. The future overlay below is wider than
    // the FM polylines and rendered after, which covers the FM colour
    // in the future zone with the negligible side-effect of a few
    // pixels of FM peeking out at the very edges.
    {
      let segStart = 0
      let prevFM = pathRows[0]?.FM || 'UNKNOWN'
      const pushSeg = (endRowIdx) => {
        const smLo = segStart * SMOOTH_STEPS
        const smHi = Math.min(pathPositions.length, endRowIdx * SMOOTH_STEPS + 1)
        if (smHi - smLo < 2) return
        viewer.entities.add({
          polyline: {
            positions: pathPositions.slice(smLo, smHi),
            width: FM_LINE_WIDTH,
            material: Cesium.Color.fromCssColorString(fmColor(prevFM)),
            clampToGround: false,
          },
        })
      }
      for (let i = 1; i < pathRows.length; i++) {
        const fm = pathRows[i].FM || 'UNKNOWN'
        if (fm !== prevFM) {
          pushSeg(i)
          segStart = i - 1
          prevFM = fm
        }
      }
      pushSeg(pathRows.length - 1)
    }

    // Future overlay polyline. Renders only positions[idx..end] — the
    // FM polylines render only positions[..idx] — so the two have zero
    // overlap. No depth-fight, no FM colour bleed.
    const futureCache = { idx: -1, arr: pathPositions.slice() }
    viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const i = tubeIdxRef.current
          if (i !== futureCache.idx) {
            futureCache.idx = i
            futureCache.arr = i <= pathPositions.length - 2
              ? pathPositions.slice(i)
              : pathPositions.slice(pathPositions.length - 2)
          }
          return futureCache.arr
        }, false),
        width: FUTURE_LINE_WIDTH,
        material: FUTURE_COLOR,
        clampToGround: false,
      },
    })

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
          //
          // Pitch from telemetry, smoothed in preRender (attitudePitchRef).
          // SIGN NEGATED: the +π/2 heading offset that compensates for
          // our -Z nose convention also flips the pitch axis relative to
          // Cesium's standard. Telemetry +pitch (nose up) → HPR -pitch
          // → after the offset/quaternion math, model nose ends up up.
          // Verified visually: HUD shows PCH +10° while ascending and
          // the model nose now points above the horizon.
          const hpr = new Cesium.HeadingPitchRoll(
            trajHdgRef.current * D2R + Math.PI / 2,
            -attitudePitchRef.current * D2R,
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
      //
      // Offset axes follow CESIUM's model frame (not glTF):
      //   +X = forward (Cesium maps glTF +Z forward → its own +X)
      //   +Y = right   (Cesium maps glTF +X right   → its own +Y)
      //   +Z = up      (Cesium maps glTF +Y up      → its own +Z)
      // glTF wingtip (±4.85, 0.30, -0.4) → Cesium (-0.4, ±4.85, 0.30).
      const LEFT_WT  = new Cesium.Cartesian3(-0.4, -4.85, 0.30)
      const RIGHT_WT = new Cesium.Cartesian3(-0.4,  4.85, 0.30)
      const navAircraftEntityGetter = () => aircraftEntity
      const leftStrobe = addWingtipStrobe(viewer, navAircraftEntityGetter, LEFT_WT,
                       Cesium.Color.fromCssColorString('#ff2020'), 0)
      const rightStrobe = addWingtipStrobe(viewer, navAircraftEntityGetter, RIGHT_WT,
                       Cesium.Color.fromCssColorString('#20ff60'), 250)

      // Debug hooks: lets the user isolate visual issues by turning off
      // the strobes (and altitude stem) and seeing if the model still
      // appears to deform. Console:
      //   window.__toggleStrobes()  // hide/show wingtip strobes
      //   window.__toggleAircraft() // hide/show aircraft model
      if (typeof window !== 'undefined') {
        window.__toggleStrobes = () => {
          const next = !leftStrobe.show
          leftStrobe.show = next; rightStrobe.show = next
          return next ? 'strobes ON' : 'strobes OFF'
        }
        window.__toggleAircraft = () => {
          if (!aircraftEntity) return 'aircraft entity not yet loaded'
          aircraftEntity.show = !aircraftEntity.show
          return aircraftEntity.show ? 'aircraft ON' : 'aircraft OFF'
        }
      }
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
    // Reused per-frame scratch buffers for the manual-mode lookAtTransform
    // pattern — avoids allocating Cesium primitives at 60 fps.
    const manualOffsetScratch = new Cesium.Cartesian3()
    const manualTransformScratch = new Cesium.Matrix4()

    // ── Fly-away guard state ─────────────────────────────────────────────────
    // Counts consecutive frames in which the camera/smooth state has gone
    // CATASTROPHICALLY bad (NaN/Infinity, or camera 30+ km from aircraft).
    // Tight thresholds + long debounce so that legitimate transients (the
    // initial flyTo settling, scrub teleports, brief speedFactor spikes)
    // never trip it — only genuine state corruption does.
    //
    // We deliberately DO NOT trigger on smooth.dist being merely "out of
    // range" — that's an invariant violation worth flagging in tests, but
    // the production lerp clamps it back into range within a few frames
    // on its own. Reacting too aggressively here was causing visible
    // 1 Hz flicker on healthy scenes, which is worse than the bug it's
    // supposed to fix.
    // Counters live on a single object so __viewerForceReset (test
    // hook) can clear them in one spot. lastResetMs in particular needs
    // to be re-zeroable so the harness can re-arm the guard between
    // named cases without waiting out the full 5 s cooldown.
    const guard = { streak: 0, count: 0, lastResetMs: 0 }
    const FLY_AWAY_DEBOUNCE = 30          // ~500 ms at 60 fps; ~3 s at 10 fps
    const FLY_AWAY_COOLDOWN_MS = 5000

    viewer.scene.preRender.addEventListener(() => {
      const vt = virtualTimeRef?.current ?? rows[0]._tSec
      const r  = interpRows(rows, vt)
      if (!r || r._lat == null) return
      curRowRef.current = r

      // Move the past/future tube split to match the current virtual
      // time. Cheap (binary-search over ~600 rows) and only the cache
      // miss inside the CallbackProperty triggers re-tessellation.
      updateTubeIdx()

      // ── Fly-away detection + auto-recovery ───────────────────────────────
      // Defensive net for the rare cases where camera state goes wild —
      // NaN propagating through smooth.pos / smooth.dist, or a runaway
      // lerp pushing the camera into orbit. When state has been bad for
      // N consecutive frames, force a clean reset back to auto mode.
      // Both modes are watched, with looser thresholds in manual since
      // a user might intentionally zoom out far.
      {
        const nowMs = performance.now()
        const inCooldown = (nowMs - guard.lastResetMs) < FLY_AWAY_COOLDOWN_MS
        if (smooth.pos != null && !inCooldown) {
          const acPos = aircraftEntity?.position?.getValue?.(viewer.clock.currentTime) ?? null
          const camPos = viewer.camera.positionWC
          const camToAc = acPos ? Cesium.Cartesian3.distance(camPos, acPos) : null

          // Catastrophic-only checks. We trigger ONLY on:
          //   - genuinely non-finite numbers (NaN / Infinity), which never
          //     show up in a healthy scene; and
          //   - camera-to-aircraft distance well past anything the auto
          //     follow can produce: max smooth.dist (5 km) + scrub
          //     transient (~few km) is comfortably under 30 km / 200 km.
          const distBad = !Number.isFinite(smooth.dist)
          const hdgBad  = !Number.isFinite(smooth.hdg)
          const posBad  = !Number.isFinite(smooth.pos.x) || !Number.isFinite(smooth.pos.y) || !Number.isFinite(smooth.pos.z)
          const camBad  = !Number.isFinite(camPos.x) || !Number.isFinite(camPos.y) || !Number.isFinite(camPos.z)
          const farLimit = autoRef.current ? 30000 : 200000
          const camTooFar = camToAc != null && Number.isFinite(camToAc) && camToAc > farLimit

          if (distBad || hdgBad || posBad || camBad || camTooFar) {
            guard.streak++
            if (guard.streak >= FLY_AWAY_DEBOUNCE) {
              guard.streak = 0
              guard.count++
              guard.lastResetMs = nowMs
              if (typeof window !== 'undefined') window.__flyAwayCount = guard.count
              console.warn('[GlobeView] fly-away detected — resetting to auto', {
                smoothDist: smooth.dist, hdg: smooth.hdg, camToAc,
                distBad, hdgBad, posBad, camBad, camTooFar,
              })
              // Clear smooth state — pos=null forces re-init from the
              // aircraft target on the next frame, dist/hdg back to safe
              // defaults, override flag cleared so auto-distance lerp
              // re-engages.
              smooth.pos = null
              smooth.hdg = 0
              smooth.dist = 500
              smooth.userDistOverride = false
              smooth.lastReal = null
              smooth.lastVt = null
              // Force auto mode if the user was in manual — fly-aways
              // typically happen when manual orbit gets confused, and
              // forcing back to auto is the only way to re-anchor. The
              // lookAtTransform(IDENTITY) call ONLY runs when we're
              // actually leaving manual; calling it in auto would clobber
              // the per-frame lookAt and produce a one-frame visual jump.
              if (!autoRef.current) {
                autoRef.current = true
                setAutoMode(true)
                try {
                  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
                } catch (_) {}
              }
            }
          } else {
            guard.streak = 0
          }
        }
      }

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

      // Smoothed telemetry pitch — used for the model's actual attitude.
      // 0.05 damping (matching trajPitchRef) was the value the user
      // confirmed felt smooth pre-pitch-change. Stronger damping like
      // 0.20 made the model visibly snap toward each new telemetry
      // sample, reading as stutter even though the numerical motion
      // was continuous.
      if (Number.isFinite(r?._pitchDeg)) {
        attitudePitchRef.current += (r._pitchDeg - attitudePitchRef.current) * 0.05
      }

      const now = performance.now()
      if (now - lastHudUpdate > 100) { lastHudUpdate = now; updateHud(hudRef.current, r) }

      if (!autoRef.current) {
        // Manual mode — keep the orbit anchored to the aircraft. Approach:
        // re-apply the SAME transform (ENU at the aircraft) every frame,
        // letting nav-button camera methods (zoomIn/zoomOut/rotate*/tilt*)
        // and screenSpaceCameraController orbit-input modify the camera's
        // local position in this frame. The aircraft's position changes,
        // but the LOCAL-frame ENU axes at the aircraft are a continuous
        // function of position, so updating the transform each frame gives
        // smooth tracking AS LONG AS the camera's local position stays
        // bounded. We hard-clamp the local-offset magnitude here as a
        // safety net — once it exceeds ~12 km the lookAtTransform re-project
        // amplifies wildly (every subsequent frame's _setTransform pre-
        // serves world position then we OVERRIDE with a now-stale-frame
        // local offset, which is the root cause of the 1+ million-metre
        // runaway the fuzz first surfaced).
        const altManual = Math.max(0, r['Alt(m)'] || 0)
        const tgtManual = Cesium.Cartesian3.fromDegrees(r._lon, r._lat, altManual)
        const localOffset = Cesium.Cartesian3.clone(viewer.camera.position, manualOffsetScratch)
        const offMag = Math.hypot(localOffset.x, localOffset.y, localOffset.z)
        const MAX_MANUAL_OFFSET = 5000  // 5 km — generous orbit, well within INV-2 (10km)
        if (offMag > MAX_MANUAL_OFFSET || !Number.isFinite(offMag)) {
          // Reset to a sane offset — this is the runtime "I detected a
          // fly-away in manual mode, snap me back to a viewable orbit"
          // that the test harness verifies via INV-2 / G-cases.
          const k = (Number.isFinite(offMag) && offMag > 0) ? MAX_MANUAL_OFFSET / offMag : 1
          localOffset.x = (Number.isFinite(localOffset.x) ? localOffset.x : 0) * k
          localOffset.y = (Number.isFinite(localOffset.y) ? localOffset.y : -500) * k
          localOffset.z = (Number.isFinite(localOffset.z) ? localOffset.z : 200) * k
        }
        if (typeof window !== 'undefined' && window.__camTrace) {
          const cw = viewer.camera.positionWC
          window.__camTrace.push({
            t: performance.now().toFixed(0),
            mode: 'manual',
            offMag: offMag.toFixed(1),
            localX: localOffset.x.toFixed(1),
            localY: localOffset.y.toFixed(1),
            localZ: localOffset.z.toFixed(1),
            wcX: cw.x.toFixed(0),
            wcY: cw.y.toFixed(0),
            wcZ: cw.z.toFixed(0),
          })
          if (window.__camTrace.length > 200) window.__camTrace.shift()
        }
        if (Number.isFinite(localOffset.x) && Number.isFinite(localOffset.y) && Number.isFinite(localOffset.z)) {
          const tform = Cesium.Transforms.eastNorthUpToFixedFrame(tgtManual, undefined, manualTransformScratch)
          viewer.camera.lookAtTransform(tform, localOffset)
        }
        return
      }

      const alt    = Math.max(0, r['Alt(m)'] || 0)
      const spdMs  = (r['GSpd(kmh)'] || 0) / 3.6
      const target = Cesium.Cartesian3.fromDegrees(r._lon, r._lat, alt)
      const targetHdg  = trajHdgRef.current
      const targetDist = Math.max(150, Math.min(600, spdMs * 5 + alt * 1.5 + 150))

      // Detect playback speed by measuring how much virtual time
      // advanced per real second since the last frame. The damping
      // factors below get scaled by this so the camera stays glued to
      // the craft regardless of speed: at 1× the catch-up is the
      // tuned-for-feel 5%/frame; at 10× it becomes 50%/frame so the
      // craft stops streaking out of view.
      const realNow = performance.now()
      let speedFactor = 1
      if (smooth.lastReal != null && smooth.lastVt != null) {
        const dReal = (realNow - smooth.lastReal) / 1000
        const dVt = vt - smooth.lastVt
        if (dReal > 0) speedFactor = Math.max(1, Math.abs(dVt) / dReal)
      }
      smooth.lastReal = realNow
      smooth.lastVt = vt

      if (!smooth.pos) {
        smooth.pos  = target.clone()
        smooth.hdg  = targetHdg
        const camDist = Cesium.Cartesian3.distance(viewer.camera.position, smooth.pos)
        // If the camera position came in as NaN (e.g. recovering from a
        // corrupted state), camDist is NaN — clamp falls through to
        // NaN which then poisons the next frame. Default to 500 m.
        const safe = Number.isFinite(camDist) ? camDist : 500
        smooth.dist = Math.max(150, Math.min(600, safe))
      } else if (speedFactor > 200) {
        // Big jump (scrub or initial seek) — teleport rather than chase.
        // Threshold raised from 50 → 200 so normal high-speed playback
        // (the speed picker maxes at 60×) doesn't trip this every frame.
        // Genuine scrubs from the timeline produce speedFactors in the
        // thousands, so they still teleport correctly.
        smooth.pos = target.clone()
        smooth.hdg = targetHdg
        // Distance: respect a manual scroll even on a teleport.
        // Otherwise scrolling at 60× playback or right after a scrub
        // would have its zoom level wiped on the next frame.
        if (!smooth.userDistOverride) {
          smooth.dist = targetDist
        }
      } else {
        const posDamp = Math.min(1, 0.05 * speedFactor)
        const hdgDamp = Math.min(1, 0.004 * speedFactor)
        const distDamp = Math.min(1, 0.008 * speedFactor)
        Cesium.Cartesian3.lerp(smooth.pos, target, posDamp, smooth.pos)
        // Heading: deadband so small drifts/turns don't rotate the camera.
        // Only follow if offset > 45°, and then at the speed-scaled rate.
        const hdgDelta = ((targetHdg - smooth.hdg + 540) % 360) - 180
        if (Math.abs(hdgDelta) > 45) smooth.hdg = lerpHdg(smooth.hdg, targetHdg, hdgDamp)
        smooth.hdg = ((smooth.hdg % 360) + 360) % 360  // wrap to [0,360)
        // Skip the auto distance lerp if the user manually scrolled.
        // The flag stays set for the rest of the session unless they
        // re-enable auto via the toggle button below — earlier this was
        // a 2.5 s timer but that read as "zoom snaps back" once it
        // lapsed.
        if (!smooth.userDistOverride) {
          smooth.dist += (targetDist - smooth.dist) * distDamp
        }
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

    // Mouse drag → manual mode. Camera still follows the aircraft, but
    // the user orbits / zooms freely via Cesium's ScreenSpaceCameraController.
    // We DELIBERATELY DO NOT use viewer.trackedEntity any more — Cesium
    // derives a default camera offset from the entity's bounding sphere,
    // and our `minimumPixelSize: 48` model inflates that sphere wildly
    // when zoomed out, sometimes snapping the camera hundreds of km away
    // on first manual entry (root cause of the reported intermittent
    // fly-aways). Instead, lookAtTransform centred on the aircraft's
    // current position seeds the orbit, and the manual-mode branch in
    // preRender keeps the transform synced to the moving aircraft.
    const releaseAuto = () => {
      if (typeof window !== 'undefined') {
        window.__releaseAutoCalls = (window.__releaseAutoCalls || 0) + 1
      }
      if (!autoRef.current) return
      autoRef.current = false
      setAutoMode(false)
      // CRITICAL: don't call viewer.camera.lookAtTransform(...) here.
      // releaseAuto runs synchronously inside the mousedown event;
      // Cesium's ScreenSpaceCameraController has already captured the
      // start of a drag and is waiting for mouse-move deltas. Mutating
      // the camera transform mid-event corrupts SSCC's drag math, so
      // the very first mouse-drag after entering manual via mouse does
      // nothing — but a subsequent mouse-drag works because the early-
      // return above skips this handler.
      //
      // The auto-mode lookAt that just ran on the previous preRender
      // frame already left the camera in an ENU-aligned local frame at
      // smooth.pos, which is close enough to the aircraft that the
      // manual-mode preRender block's per-frame lookAtTransform reads
      // a sensible local offset on its first run and the camera stays
      // anchored. No explicit handover needed.
      viewer.camera.constrainedAxis = undefined
    }
    const el = containerRef.current
    // Register on BOTH mousedown and pointerdown, AND use capture phase.
    // Cesium's ScreenSpaceEventHandler attaches pointer-event listeners
    // on the canvas and stops propagation in the bubble phase, so a
    // bubble-phase mousedown listener on the parent container never
    // hears real puppeteer/desktop drag gestures (only DOM-synthesized
    // ones). Capture-phase + pointerdown wins both: it fires before
    // Cesium can swallow the event, and on every input mode (mouse,
    // pen, touch) including modern Chrome's pointer-only path.
    el.addEventListener('pointerdown', releaseAuto, true)
    el.addEventListener('mousedown', releaseAuto, true)

    // Wheel in auto mode does NOT release auto — it just adjusts the
    // follow distance. The previous behaviour (wheel → manual mode)
    // caused a hard jump-zoom on first scroll: Cesium's `trackedEntity`
    // snaps to a default offset based on the aircraft's bounding sphere
    // (tiny model = very close camera), and the scroll event then
    // applied on top of that already-snapped position. Now scroll just
    // tweaks `smooth.dist`; the auto-follow camera-distance lerp keeps
    // it from feeling abrupt. Drag (mousedown above) remains the gesture
    // that actually means "I want to control this myself".
    const onWheelAuto = e => {
      if (!autoRef.current) return
      e.preventDefault()
      // ~15 % zoom per notch; slightly less when zoomed close so the
      // last few notches don't shoot past the aircraft.
      const factor = e.deltaY > 0 ? 1.15 : 0.87
      const next = smooth.dist * factor
      smooth.dist = Math.max(50, Math.min(5000, next))
      // Once the user has expressed a zoom preference, hold it for the
      // rest of the session. Earlier this was a 2.5 s timer that lapsed
      // and let the speed/altitude-driven auto-distance pull the camera
      // back, which read as "scroll doesn't work — it just snaps back".
      // The auto-toggle button (or a fresh log) re-engages auto distance.
      smooth.userDistOverride = true
    }
    el.addEventListener('wheel', onWheelAuto, { passive: false })

    stateRef.current = { viewer, smooth, getAircraftEntity: () => aircraftEntity }

    // Test hook: exposes a snapshot reader on window so the headless test
    // harness (see tests/harness/) can inspect camera + smooth state and
    // assert invariants after every simulated action. No production user
    // ever queries this; the property is named with a __ prefix as an
    // explicit "internal / dev" marker. Reading it has zero side effects.
    if (typeof window !== 'undefined') {
      window.__viewerState = () => {
        const s = stateRef.current
        if (!s) return null
        const ac = s.getAircraftEntity?.()
        const acPos = ac?.position?.getValue?.(s.viewer.clock.currentTime) ?? null
        const camPos = s.viewer.camera.positionWC
        return {
          autoMode: autoRef.current,
          smooth: {
            dist: s.smooth.dist,
            hdg: s.smooth.hdg,
            posX: s.smooth.pos?.x,
            posY: s.smooth.pos?.y,
            posZ: s.smooth.pos?.z,
            userDistOverride: !!s.smooth.userDistOverride,
          },
          camera: {
            x: camPos.x, y: camPos.y, z: camPos.z,
            // Cesium-tracked heading + pitch (radians). Tests use these
            // to verify that drag/rotate actually moves the camera, which
            // smooth.hdg can't catch in manual mode (smooth.hdg only
            // updates from the auto-follow block).
            heading: s.viewer.camera.heading,
            pitch: s.viewer.camera.pitch,
            // Whether the camera has an active orbit transform (non-IDENTITY).
            // SSCC needs this to be true for mouse-drag to rotate around
            // the target instead of around the globe centre.
            hasOrbitTransform: !Cesium.Matrix4.equals(
              s.viewer.camera.transform, Cesium.Matrix4.IDENTITY,
            ),
          },
          aircraft: acPos ? { x: acPos.x, y: acPos.y, z: acPos.z } : null,
          camToAircraftMeters: acPos
            ? Cesium.Cartesian3.distance(camPos, acPos)
            : null,
          trackedEntity: !!s.viewer.trackedEntity,
          flyAwayCount: window.__flyAwayCount ?? 0,
        }
      }
      // Test-only hook: lets the harness deliberately corrupt camera state
      // so the fly-away guard's recovery path can be exercised end-to-end.
      // No production user ever calls this (the __ prefix marks it as
      // internal), and reading it has no effect — only invocation does.
      window.__viewerCorrupt = (kind = 'dist') => {
        const s = stateRef.current
        if (!s) return false
        if (kind === 'dist') s.smooth.dist = 99999
        else if (kind === 'distNaN') s.smooth.dist = NaN
        else if (kind === 'hdgNaN') s.smooth.hdg = NaN
        else if (kind === 'posNaN' && s.smooth.pos) {
          s.smooth.pos.x = NaN; s.smooth.pos.y = NaN; s.smooth.pos.z = NaN
        }
        return true
      }
      // Test-only hook: hard-reset the smooth/auto state. The harness
      // calls this between named cases so corruption from one test
      // never bleeds into the next. Production code never calls this —
      // toggle the .globe-auto-btn for the user-visible reset path.
      window.__viewerForceReset = () => {
        const s = stateRef.current
        if (!s) return false
        s.smooth.pos = null
        s.smooth.hdg = 0
        s.smooth.dist = 500
        s.smooth.userDistOverride = false
        s.smooth.lastReal = null
        s.smooth.lastVt = null
        // Trajectory refs feed targetHdg/targetPitch in preRender. If a
        // prior corruption (G2 distNaN) propagated NaN into them, the
        // next auto-frame computes NaN heading and lookAt poisons the
        // camera again. Reset them too.
        if (!Number.isFinite(trajHdgRef.current))   trajHdgRef.current = 0
        if (!Number.isFinite(trajPitchRef.current)) trajPitchRef.current = 0
        if (!autoRef.current) {
          autoRef.current = true
          setAutoMode(true)
        }
        // If a previous test corrupted the camera (G2 sets
        // smooth.dist=NaN which propagates through camera.lookAt's
        // internal math, leaving camera.position/heading as NaN),
        // restore a finite state via setView. setView with destination
        // + orientation explicitly resets the camera and is the
        // documented way to do this in Cesium without disturbing
        // SSCC's orbit-mode flag (which lookAt() does corrupt).
        try {
          s.viewer.trackedEntity = undefined
          const cp = s.viewer.camera.position
          const broken = !Number.isFinite(cp.x) || !Number.isFinite(cp.y) || !Number.isFinite(cp.z) ||
                         !Number.isFinite(s.viewer.camera.heading)
          if (broken) {
            const r = curRowRef.current
            if (r && r._lat != null) {
              const alt = Math.max(0, r['Alt(m)'] || 0)
              s.viewer.camera.setView({
                destination: Cesium.Cartesian3.fromDegrees(r._lon, r._lat, alt + 500),
                orientation: { heading: 0, pitch: -Math.PI / 4, roll: 0 },
              })
            }
          }
        } catch (_) {}
        // Re-arm the fly-away guard immediately. Otherwise the inter-
        // case gap (~2 s) is shorter than the cooldown (5 s) and
        // back-to-back G-cases share their cooldowns: G1 recovers,
        // then G2/G3/G4 get blocked because guard.lastResetMs is still
        // recent.
        guard.streak = 0
        guard.count = 0
        guard.lastResetMs = 0
        window.__flyAwayCount = 0
        return true
      }
    }
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
      el.removeEventListener('pointerdown', releaseAuto, true)
      el.removeEventListener('mousedown', releaseAuto, true)
      el.removeEventListener('wheel', onWheelAuto)
      document.removeEventListener('fullscreenchange', onFsChange)
      resizeObserver?.disconnect()
      stateRef.current = null
      if (typeof window !== 'undefined') {
        delete window.__viewerState
        delete window.__viewerCorrupt
        delete window.__viewerForceReset
        delete window.__flyAwayCount
        delete window.__toggleStrobes
        delete window.__toggleAircraft
      }
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
      // Going manual — handover via lookAtTransform (no trackedEntity, see
      // releaseAuto comment for why).
      const r = curRowRef.current
      if (r && r._lat != null) {
        const alt = Math.max(0, r['Alt(m)'] || 0)
        const tgt = Cesium.Cartesian3.fromDegrees(r._lon, r._lat, alt)
        const tform = Cesium.Transforms.eastNorthUpToFixedFrame(tgt)
        s.viewer.camera.lookAtTransform(
          tform,
          new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(s.smooth.hdg + 180),
            Cesium.Math.toRadians(-18),
            Math.max(150, Math.min(800, s.smooth.dist || 500)),
          ),
        )
      }
      s.viewer.camera.constrainedAxis = undefined
    } else {
      // Back to auto — release the orbit transform and clear the
      // userDistOverride flag so the speed/altitude-driven auto distance
      // lerp re-engages. The smooth.pos=null forces a fresh re-init from
      // the aircraft target on the next preRender frame.
      s.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
      s.smooth.pos = null
      s.smooth.userDistOverride = false
    }
  }

  // ── Nav widget: ensure manual mode then step-drive the camera ───────────────
  const ensureManual = () => {
    const s = stateRef.current
    if (!s) return null
    if (autoRef.current) {
      autoRef.current = false
      setAutoMode(false)
      // Same lookAtTransform handover as the mousedown path — see the
      // comment on releaseAuto above for why we avoid viewer.trackedEntity.
      const r = curRowRef.current
      if (r && r._lat != null) {
        const alt = Math.max(0, r['Alt(m)'] || 0)
        const tgt = Cesium.Cartesian3.fromDegrees(r._lon, r._lat, alt)
        const tform = Cesium.Transforms.eastNorthUpToFixedFrame(tgt)
        s.viewer.camera.lookAtTransform(
          tform,
          new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(s.smooth.hdg + 180),
            Cesium.Math.toRadians(-18),
            Math.max(150, Math.min(800, s.smooth.dist || 500)),
          ),
        )
      }
      s.viewer.camera.constrainedAxis = undefined
    }
    return s.viewer
  }
  // Shared rAF handle for press-and-hold nav buttons. Lives on a ref so it
  // survives the re-render that happens when ensureManual() calls
  // setAutoMode(false). Earlier this was a closure local to navHeld(),
  // which meant a re-render between mouse-down and mouse-up replaced the
  // onUp handler with a fresh closure whose `raf` was null — the original
  // rAF chain kept running indefinitely (catastrophic when the action is
  // zoomOut: camera drifts off into space at 8 m/frame for the rest of
  // the session). Using a ref makes cancellation visible across renders.
  const navRafRef = useRef(null)
  const navHeld = (fn) => {
    const tick = () => {
      const v = ensureManual()
      if (v) fn(v.camera)
      navRafRef.current = requestAnimationFrame(tick)
    }
    const stop = () => {
      if (navRafRef.current != null) {
        cancelAnimationFrame(navRafRef.current)
        navRafRef.current = null
      }
    }
    const onDown = (e) => {
      e.preventDefault()
      stop() // belt-and-braces: cancel any stale chain before starting a new one
      tick()
    }
    return {
      onMouseDown: onDown,
      onMouseUp: stop,
      onMouseLeave: stop,
      onTouchStart: onDown,
      onTouchEnd: stop,
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
