#!/usr/bin/env node
// Builds public/models/wing.glb, the aircraft the 3D Globe view flies, from
// the Nanawing sim's flying-wing mesh (assets-src/wing-source.glb, the raw
// desert-camo export the sim also starts from).
//
//   node scripts/build-wing-glb.mjs
//
// What it changes, and why:
//   - Livery. The camo albedo is replaced by a texture baked from the mesh
//     itself: every texel is coloured from the 3D point it maps to, so the
//     stripes follow the planform instead of the UV layout. Top: charcoal
//     with two brand-blue (#087bc1) slashes per panel, orange (#ff8500)
//     tips and a forward-pointing orange nose chevron (tells nose from
//     tail in TOPDOWN). Belly: orange, so a bank or an inverted pass reads
//     at a glance, the way pilots paint real wings for orientation.
//     Camo blends into desert and scrub imagery; this livery does not.
//   - Winglets. Orange fins at each tip, like the wing on the homepage
//     hero. From behind a flat wing is a 2 px line; the fins give it a
//     shape you can read bank angle from at chase distance.
//   - Nav lights. Emissive red (left) and green (right) beads at the tip
//     leading edges, under the Cesium-side strobes.
//   - Finish. Satin clearcoat over a 0.45-roughness base (the sim's
//     "race-wrap" polish), metallic 0. The camo roughness map is dropped;
//     the normal map (fine wrap texture, keyed to the same UVs) is kept.
//
// No dependencies: GLB parsing, triangle rasterisation and the PNG encoder
// are all below (node:zlib does the deflate). Output stays well under the
// 600 KB budget (about 160 KB).

import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'assets-src/wing-source.glb')
const OUT = join(ROOT, 'public/models/wing.glb')

// ── Palette (sRGB bytes) ────────────────────────────────────────────────────
const CHARCOAL = [40, 44, 51]
const CHARCOAL_EDGE = [30, 33, 38]
const ELEVON = [52, 57, 65]
const BLUE = [8, 123, 193] // narenana blue #087bc1
const ORANGE = [255, 133, 0] // narenana orange #ff8500
const PROP = [26, 28, 32]
const CAMERA = [18, 20, 23]

// ── GLB reading ─────────────────────────────────────────────────────────────
function readGlb(path) {
  const buf = readFileSync(path)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a GLB`)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const binLen = buf.readUInt32LE(20 + jsonLen)
  const bin = buf.subarray(28 + jsonLen, 28 + jsonLen + binLen)
  return { json, bin }
}

const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const CSIZE = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }
function readAccessor({ json, bin }, idx) {
  const a = json.accessors[idx]
  const bv = json.bufferViews[a.bufferView]
  const n = NCOMP[a.type]
  const cs = CSIZE[a.componentType]
  const stride = bv.byteStride || n * cs
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0)
  const read = {
    5121: (o) => bin.readUInt8(o),
    5123: (o) => bin.readUInt16LE(o),
    5125: (o) => bin.readUInt32LE(o),
    5126: (o) => bin.readFloatLE(o),
  }[a.componentType]
  const out = new Array(a.count)
  for (let i = 0; i < a.count; i++) {
    if (n === 1) { out[i] = read(base + i * stride); continue }
    const v = new Array(n)
    for (let c = 0; c < n; c++) v[c] = read(base + i * stride + c * cs)
    out[i] = v
  }
  return out
}

// Node TRS → functions mapping mesh-local points / normals to the model frame.
function nodeXform(node) {
  const t = node.translation || [0, 0, 0]
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1]
  const s = node.scale || [1, 1, 1]
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
  const pt = (p) => [0, 1, 2].map((i) => R[i][0] * p[0] * s[0] + R[i][1] * p[1] * s[1] + R[i][2] * p[2] * s[2] + t[i])
  const nrm = (q) => {
    const v = [0, 1, 2].map((i) => R[i][0] * q[0] / s[0] + R[i][1] * q[1] / s[1] + R[i][2] * q[2] / s[2])
    const l = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  return { pt, nrm }
}

// ── Livery ──────────────────────────────────────────────────────────────────
// Model frame (glTF): +X right wing, +Y up, nose toward -Z. Span ±5.0 m;
// leading edge runs from the nose (z -1.74) to the tips (z 1.27), trailing
// edge from z -0.06 at the root to 1.86 at the tips (measured from the mesh).
const zLE = (ax) => -1.74 + 0.602 * ax
const smooth = (e0, e1, v) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
// 1 inside [lo, hi] with a soft ~1.5 cm edge (the 2x supersample does the rest).
const band = (v, lo, hi) => smooth(lo - 0.015, lo + 0.015, v) * (1 - smooth(hi - 0.015, hi + 0.015, v))

function livery(part, p, n) {
  const ax = Math.abs(p[0])
  const z = p[2]
  const top = n[1] > 0.35
  const belly = n[1] < -0.35
  if (part === 'Prop') return PROP
  if (part === 'Camera') return CAMERA

  // Racing slashes: lines that step outboard as they run aft, so they read
  // as a forward-leaning chevron across the whole wing from above.
  const s = ax + 0.55 * (z - zLE(ax))
  const slash = Math.max(band(s, 1.55, 2.2), band(s, 2.42, 2.6))
  const tip = smooth(4.5, 4.54, ax)

  if (part === 'flapL' || part === 'flapR') {
    if (belly) return ORANGE
    return mix(ELEVON, ORANGE, tip)
  }

  if (top) {
    let c = CHARCOAL
    c = mix(c, BLUE, slash)
    // Nose chevron: a V pointing forward on the centre pod.
    const zc = -1.42 + 0.95 * ax
    const chevron = ax < 0.95 ? band(z, zc - 0.11, zc + 0.11) * (1 - smooth(0.85, 0.95, ax)) : 0
    c = mix(c, ORANGE, chevron)
    return mix(c, ORANGE, tip)
  }
  if (belly) {
    return mix(ORANGE, BLUE, slash * (1 - tip))
  }
  // Leading / trailing edge faces: dark, with the tip colour carried round.
  return mix(CHARCOAL_EDGE, ORANGE, tip)
}

// ── Bake: rasterise every triangle in UV space at 2x, then box-filter ───────
function bakeLivery(glb, size) {
  const SS = 2
  const W = size * SS
  const col = new Float32Array(W * W * 3)
  const hit = new Uint8Array(W * W)
  for (let ni = 0; ni < glb.json.nodes.length; ni++) {
    const node = glb.json.nodes[ni]
    if (node.mesh == null) continue
    const prim = glb.json.meshes[node.mesh].primitives[0]
    if (prim.material !== 0 || prim.attributes.TEXCOORD_0 == null) continue
    const X = nodeXform(node)
    const P = readAccessor(glb, prim.attributes.POSITION).map(X.pt)
    const UV = readAccessor(glb, prim.attributes.TEXCOORD_0)
    const I = readAccessor(glb, prim.indices)
    // The source's normals point INTO the airframe (its faces are wound
    // inside-out too, so the double-sided material still lights it right).
    // Orient them by geometry: on a thin wing, outward normals agree with
    // the vertex's height above the part's mean height.
    let N = readAccessor(glb, prim.attributes.NORMAL).map(X.nrm)
    const meanY = P.reduce((s, p) => s + p[1], 0) / P.length
    const agree = P.reduce((s, p, i) => s + N[i][1] * (p[1] - meanY), 0)
    if (agree < 0) N = N.map((q) => [-q[0], -q[1], -q[2]])
    for (let t = 0; t < I.length; t += 3) {
      const ia = I[t], ib = I[t + 1], ic = I[t + 2]
      const ax = UV[ia][0] * W, ay = UV[ia][1] * W
      const bx = UV[ib][0] * W, by = UV[ib][1] * W
      const cx = UV[ic][0] * W, cy = UV[ic][1] * W
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if (Math.abs(area) < 1e-9) continue
      const nx = N[ia][0] + N[ib][0] + N[ic][0]
      const ny = N[ia][1] + N[ib][1] + N[ic][1]
      const nz = N[ia][2] + N[ib][2] + N[ic][2]
      const nl = Math.hypot(nx, ny, nz) || 1
      const fn = [nx / nl, ny / nl, nz / nl]
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)))
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(W - 1, Math.ceil(Math.max(ay, by, cy)))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area
          const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area
          const w2 = 1 - w0 - w1
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue
          const p = [0, 1, 2].map((k) => P[ia][k] * w0 + P[ib][k] * w1 + P[ic][k] * w2)
          const c = livery(node.name, p, fn)
          const o = y * W + x
          col[o * 3] = c[0]; col[o * 3 + 1] = c[1]; col[o * 3 + 2] = c[2]
          hit[o] = 1
        }
      }
    }
  }
  // Downsample: average the covered subsamples of each output texel.
  const out = new Uint8Array(size * size * 3)
  const mask = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, k = 0
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const o = (y * SS + sy) * W + (x * SS + sx)
        if (!hit[o]) continue
        r += col[o * 3]; g += col[o * 3 + 1]; b += col[o * 3 + 2]; k++
      }
      const o = y * size + x
      if (k) { out[o * 3] = r / k; out[o * 3 + 1] = g / k; out[o * 3 + 2] = b / k; mask[o] = 1 }
    }
  }
  // Dilate 8 px so mip levels and bilinear taps at island borders never
  // pull in background; anything left over is charcoal.
  for (let pass = 0; pass < 8; pass++) {
    const grow = []
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const o = y * size + x
      if (mask[o]) continue
      let r = 0, g = 0, b = 0, k = 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue
        const q = yy * size + xx
        if (!mask[q]) continue
        r += out[q * 3]; g += out[q * 3 + 1]; b += out[q * 3 + 2]; k++
      }
      if (k) grow.push([o, r / k, g / k, b / k])
    }
    for (const [o, r, g, b] of grow) { out[o * 3] = r; out[o * 3 + 1] = g; out[o * 3 + 2] = b; mask[o] = 1 }
  }
  for (let o = 0; o < size * size; o++) if (!mask[o]) { out[o * 3] = CHARCOAL[0]; out[o * 3 + 1] = CHARCOAL[1]; out[o * 3 + 2] = CHARCOAL[2] }
  return out
}

// ── PNG (RGB8) ──────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
const crc32 = zlibCrc32 || ((buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 })
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}
function encodePng(rgb, w, h) {
  const stride = w * 3
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    // "Up" filter: flat livery fields compress to almost nothing.
    raw[y * (stride + 1)] = 2
    for (let i = 0; i < stride; i++) {
      const cur = rgb[y * stride + i]
      const up = y ? rgb[(y - 1) * stride + i] : 0
      raw[y * (stride + 1) + 1 + i] = (cur - up) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Extra geometry: winglets + nav-light beads ──────────────────────────────
// Flat-shaded closed prism from a planar polygon (in the fin plane) with
// thickness along the plane normal.
function finMesh(side) {
  const H = 0.95 // fin height (m) on the 10 m span
  const cant = 0.14 // outward lean of the fin top (m)
  const t = 0.05 // thickness
  const xRoot = side * 4.97
  // Fin plane normal, pointing outboard: perpendicular to the canted fin
  // span (side*cant, H) within the XY plane.
  const hl = Math.hypot(cant, H)
  const out = [(side * H) / hl, -cant / hl, 0]
  // Fin outline as (chordwise z, height fraction): root LE, root TE, top TE, top LE.
  const outline = [[1.22, 0], [1.86, 0], [2.02, 1], [1.72, 1]]
  const pos = [], nor = [], idx = []
  const quad = (a, b, c, d, n) => {
    const base = pos.length / 3
    for (const v of [a, b, c, d]) { pos.push(...v); nor.push(...n) }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const P = (k, off) => { const [z, f] = outline[k]; return [xRoot + side * cant * f + out[0] * off, -0.01 + H * f + out[1] * off, z] }
  // Outer and inner faces.
  quad(P(0, t / 2), P(1, t / 2), P(2, t / 2), P(3, t / 2), out)
  quad(P(3, -t / 2), P(2, -t / 2), P(1, -t / 2), P(0, -t / 2), [-out[0], -out[1], 0])
  // Rim: root, trailing edge, top, leading edge.
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4
    const a = P(k, t / 2), b = P(k2, t / 2), c = P(k2, -t / 2), d = P(k, -t / 2)
    const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    // Rim normal = edge direction x fin normal, pointing away from the fin centre.
    let n = [e[1] * out[2] - e[2] * out[1], e[2] * out[0] - e[0] * out[2], e[0] * out[1] - e[1] * out[0]]
    const l = Math.hypot(...n) || 1
    n = n.map((v) => v / l)
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
    const ctr = P(0, 0).map((v, i) => (v + P(2, 0)[i]) / 2)
    if ((mid[0] - ctr[0]) * n[0] + (mid[1] - ctr[1]) * n[1] + (mid[2] - ctr[2]) * n[2] < 0) n = n.map((v) => -v)
    quad(a, b, c, d, n)
  }
  // Fix winding so every face is front-facing along its normal.
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]].map((j) => pos.slice(j * 3, j * 3 + 3))
    const cr = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ]
    const n = nor.slice(idx[i] * 3, idx[i] * 3 + 3)
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) { const tmp = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = tmp }
  }
  return { pos, nor, idx }
}

function sphereMesh(center, r, seg = 10, rings = 7) {
  const pos = [], nor = [], idx = []
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * Math.PI
    for (let j = 0; j <= seg; j++) {
      const ph = (j / seg) * Math.PI * 2
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]
      pos.push(center[0] + n[0] * r, center[1] + n[1] * r, center[2] + n[2] * r)
      nor.push(...n)
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1
    idx.push(a, a + 1, b, b, a + 1, b + 1)
  }
  return { pos, nor, idx }
}

// Nav-light bead position (model frame). GlobeView puts its strobes here too.
export const NAV_LIGHT_GLTF = { x: 5.0, y: 0.02, z: 1.2 }

// ── Assemble ────────────────────────────────────────────────────────────────
function build() {
  const glb = readGlb(SRC)
  const src = glb.json
  const TEX = 1024
  const png = encodePng(bakeLivery(glb, TEX), TEX, TEX)

  const chunks = []
  let offset = 0
  const bufferViews = []
  const pushView = (data, extra = {}) => {
    const pad = (4 - (offset % 4)) % 4
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...extra })
    chunks.push(data); offset += data.length
    return bufferViews.length - 1
  }

  // Geometry views carried over verbatim; images rebuilt.
  const viewMap = new Map()
  src.bufferViews.forEach((bv, i) => {
    if (bv.target == null) return // image views
    const data = glb.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)
    const { buffer, byteOffset, byteLength, ...rest } = bv
    viewMap.set(i, pushView(Buffer.from(data), rest))
  })
  const accessors = src.accessors.map((a) => ({ ...a, bufferView: viewMap.get(a.bufferView) }))

  const normalImg = src.images.find((im) => /normal/i.test(im.name))
  const nbv = src.bufferViews[normalImg.bufferView]
  const normalView = pushView(Buffer.from(glb.bin.subarray(nbv.byteOffset, nbv.byteOffset + nbv.byteLength)))
  const liveryView = pushView(png)

  const addGeom = ({ pos, nor, idx }) => {
    const pb = Buffer.alloc(pos.length * 4), nb = Buffer.alloc(nor.length * 4), ib = Buffer.alloc(idx.length * 2)
    pos.forEach((v, i) => pb.writeFloatLE(v, i * 4))
    nor.forEach((v, i) => nb.writeFloatLE(v, i * 4))
    idx.forEach((v, i) => ib.writeUInt16LE(v, i * 2))
    const min = [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k)))
    const max = [0, 1, 2].map((k) => Math.max(...pos.filter((_, i) => i % 3 === k)))
    const pv = pushView(pb, { target: 34962 }), nv = pushView(nb, { target: 34962 }), iv = pushView(ib, { target: 34963 })
    accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max })
    accessors.push({ bufferView: nv, componentType: 5126, count: nor.length / 3, type: 'VEC3' })
    accessors.push({ bufferView: iv, componentType: 5123, count: idx.length, type: 'SCALAR' })
    return { POSITION: accessors.length - 3, NORMAL: accessors.length - 2, indices: accessors.length - 1 }
  }

  const meshes = src.meshes.map((m) => ({ ...m, primitives: m.primitives.map((p) => ({ ...p, material: 0 })) }))
  const nodes = src.nodes.map((n) => ({ ...n }))
  const sceneNodes = [...src.scenes[0].nodes]
  const addPart = (name, geom, material) => {
    const { indices, ...attributes } = addGeom(geom)
    meshes.push({ name, primitives: [{ attributes, indices, material, mode: 4 }] })
    nodes.push({ name, mesh: meshes.length - 1 })
    sceneNodes.push(nodes.length - 1)
  }
  addPart('wingletL', finMesh(-1), 1)
  addPart('wingletR', finMesh(+1), 1)
  const L = NAV_LIGHT_GLTF
  addPart('navLightL', sphereMesh([-L.x, L.y, L.z], 0.1), 2)
  addPart('navLightR', sphereMesh([L.x, L.y, L.z], 0.1), 3)

  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const json = {
    asset: { version: '2.0', generator: 'scripts/build-wing-glb.mjs (narenana log viewer)' },
    extensionsUsed: ['EXT_texture_webp', 'KHR_materials_clearcoat'],
    scene: 0,
    scenes: [{ name: 'Nanawing One', nodes: sceneNodes }],
    nodes,
    meshes,
    materials: [
      {
        name: 'NanawingLivery',
        doubleSided: true,
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.45 },
        normalTexture: { index: 1 },
        extensions: { KHR_materials_clearcoat: { clearcoatFactor: 0.45, clearcoatRoughnessFactor: 0.22 } },
      },
      {
        name: 'Winglet',
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [...ORANGE.map(lin), 1], metallicFactor: 0, roughnessFactor: 0.45 },
        extensions: { KHR_materials_clearcoat: { clearcoatFactor: 0.45, clearcoatRoughnessFactor: 0.22 } },
      },
      { name: 'NavRed', pbrMetallicRoughness: { baseColorFactor: [1, 0.05, 0.05, 1], metallicFactor: 0, roughnessFactor: 0.3 }, emissiveFactor: [1, 0.06, 0.04] },
      { name: 'NavGreen', pbrMetallicRoughness: { baseColorFactor: [0.05, 1, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.3 }, emissiveFactor: [0.05, 1, 0.25] },
    ],
    textures: [
      { sampler: 0, source: 0 },
      { sampler: 0, extensions: { EXT_texture_webp: { source: 1 } } },
    ],
    images: [
      { name: 'nanawing_livery', mimeType: 'image/png', bufferView: liveryView },
      { name: normalImg.name, mimeType: 'image/webp', bufferView: normalView },
    ],
    samplers: src.samplers,
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  }

  const pad = (4 - (offset % 4)) % 4
  if (pad) chunks.push(Buffer.alloc(pad))
  const bin = Buffer.concat(chunks)
  json.buffers[0].byteLength = bin.length
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jpad = (4 - (jsonBuf.length % 4)) % 4
  if (jpad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8)
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  const glbOut = Buffer.concat([header, jh, jsonBuf, bh, bin])
  writeFileSync(OUT, glbOut)
  if (process.env.WING_LIVERY_PNG) writeFileSync(process.env.WING_LIVERY_PNG, png)
  console.log(`wrote ${OUT} (${(glbOut.length / 1024).toFixed(0)} KB; livery ${TEX}px PNG ${(png.length / 1024).toFixed(0)} KB)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build()
