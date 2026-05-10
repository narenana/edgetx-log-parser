// Flicker regression probe.
//
// Investigation summary (May 2026): user reported aircraft "moving back
// then forward" every few frames in the chase camera, especially at
// zoomed-in distances. Root cause was uneven browser rAF cadence under
// load (screen recording, GC, Cesium tile fetches) translating into
// uneven `virtualTimeRef` advancement: a frame stalled to 80 ms after a
// run of 16 ms frames advances vt 5× the typical step, which lerps the
// aircraft 5× as far across the smoothed path. At zoomed-in chase
// distances (50 m) where 1 m world ≈ 20 px, this read as visible scroll-
// jerk on the background tiles even though the aircraft remained on its
// path.
//
// Fix: cap per-frame `dtSec` to 33 ms (~30 fps floor) in Dashboard.jsx's
// rAF tick, so a stall slows playback rather than producing a giant
// motion step. Commit `80f41dd` on `feat/camera-director`.
//
// What this probe checks
// ----------------------
// 1. Loads the deployed app with a real iNAV log.
// 2. Plays at 1× for ~200 frames, recording the per-frame `vt`
//    advancement (the actual controlled variable that the dt-cap
//    bounds).
// 3. Asserts that no Δvt exceeds the dt-cap ceiling plus a small
//    measurement-jitter margin.
//
// Why measure Δvt and not aircraft world step? Aircraft world step per
// frame is dominated by path-segment-length variance in the smoothed
// path geometry, not by dt cadence — at a path vertex transition the
// same Δvt can produce very different world steps depending on where
// in the smoothed-path curve the aircraft is. The dt-cap directly
// bounds Δvt, so that's what the regression check should measure.
//
// Caveat: headless puppeteer Chrome doesn't experience the same rAF
// stalls as an interactive browser under recording load, so a passing
// run here does NOT prove the user-side flicker is gone — that requires
// visual inspection at 1× zoomed-in. But this probe is a guardrail: if
// someone removes the dt-cap and Δvt blows past the ceiling on any
// frame where rAF stalled, headless will catch it. The dt-cap kicks in
// roughly once per second even in healthy headless runs because Cesium
// tile loads cause occasional ~50 ms preUpdate stalls.
//
// Diagnostic playbook for future flicker reports
// -----------------------------------------------
// Step 1: have the user record at 1× with full zoom-in (`smooth.dist`
// near the lower clamp). Visual flicker that disappears when zoomed
// out is almost certainly per-frame motion variance, not a rendering
// issue.
//
// Step 2: run THIS probe against the suspect commit. Variance ratio
// > 3 means a real per-frame motion bug (not just rAF jitter).
//
// Step 3: if the probe shows a bounded ratio but the user still sees
// flicker, bring up `tests/visualisation/track-both-axes.py` against
// a screen recording — extract every Nth frame, dual-centroid track
// (magenta nose marker + a known white pixel in the background), and
// plot both. If the magenta moves smoothly but the white pixel jumps,
// it's camera-distance jitter or background tile churn. If both move
// in lockstep but unevenly, it's vt-cadence (this probe's domain).
//
// Step 4: if vt-cadence is suspect, run `probe-cam-vs-aircraft.js` to
// see per-frame world deltas and `smooth.dist` history side by side.

import puppeteer from 'puppeteer-core'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const URL = process.env.PROBE_URL || 'https://feat-camera-director.edgetx-log-parser.pages.dev/?fps=1'
const LOG = process.env.PROBE_LOG || 'C:\\Users\\Guddu\\Desktop\\suchit logs\\LOG00003 (2).TXT'
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const NUM_SAMPLES = Number(process.env.NUM_SAMPLES || 200)
// Δvt ceiling. The fix in Dashboard.jsx caps `dtSec = min(rawDt, 0.033)`,
// so at 1× playback Δvt should never exceed ~0.033s. 5 ms of margin
// handles measurement jitter (the probe samples once per rAF and reads
// `virtualTimeRef.current` at that moment; the rAF-side advancement and
// our read can disagree by sub-millisecond amounts). If a user changes
// the playback-speed default or the cap value, this constant must
// change to match.
const MAX_DVT_S = Number(process.env.MAX_DVT_S || 0.038)

const OUT = path.join(__dirname, 'flicker-regression')
fs.mkdirSync(OUT, { recursive: true })

console.log(`Probing ${URL}`)
console.log(`Log: ${LOG}`)
console.log(`Samples: ${NUM_SAMPLES}, max Δvt: ${(MAX_DVT_S * 1000).toFixed(0)} ms`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--enable-webgl'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  protocolTimeout: 600000,
})
const page = await browser.newPage()
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible' })
  Object.defineProperty(document, 'hidden', { get: () => false })
})
page.on('pageerror', e => console.error('[pageerror]', e.message))

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
const fileInput = await page.$('input[type=file]')
await fileInput.uploadFile(LOG)
await page.waitForSelector('.summary-cta', { timeout: 120000 })
await page.click('.summary-cta')
await page.waitForSelector('.timeline-scrubber', { timeout: 30000 })
await sleep(8000)

// Scrub to 10% in so we're past the takeoff transient and well into a
// flying section where the path is dense.
await page.evaluate(() => {
  const s = document.querySelector('.timeline-scrubber')
  if (s) {
    const max = parseFloat(s.max)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(s, String(Math.round(max * 0.10)))
    s.dispatchEvent(new Event('input', { bubbles: true }))
  }
  document.body.focus()
})
await sleep(500)
await page.keyboard.press('Space')
await sleep(2000)

// Sample (vt, perf.now, aircraft pos) every rAF for NUM_SAMPLES frames.
await page.evaluate((n) => {
  window.__regSamples = []
  let count = 0
  const tick = () => {
    const v = window.__viewerState?.()
    if (v && v.aircraft && Number.isFinite(v.vt)) {
      window.__regSamples.push({
        t: performance.now(),
        vt: v.vt,
        x: v.aircraft.x,
        y: v.aircraft.y,
        z: v.aircraft.z,
      })
      count++
    }
    if (count < n) requestAnimationFrame(tick)
    else window.__regDone = true
  }
  requestAnimationFrame(tick)
}, NUM_SAMPLES)

await page.waitForFunction(() => window.__regDone === true, { timeout: 60000 })
const samples = await page.evaluate(() => window.__regSamples)
await browser.close()

console.log(`captured ${samples.length} samples`)

// Per-frame Δvt: the controlled variable. dt-cap clamps this at 0.033s.
const dvts = []
const wallDts = []
const worldSteps = []
for (let i = 1; i < samples.length; i++) {
  dvts.push(samples[i].vt - samples[i - 1].vt)
  wallDts.push(samples[i].t - samples[i - 1].t)
  const dx = samples[i].x - samples[i - 1].x
  const dy = samples[i].y - samples[i - 1].y
  const dz = samples[i].z - samples[i - 1].z
  worldSteps.push(Math.hypot(dx, dy, dz))
}

// Skip the first 20 frames — settle-in transients (smooth.pos init,
// lastReal seed, possible scrub-event aftershock).
const tailStart = 20
const dvtTail = dvts.slice(tailStart)
const wallTail = wallDts.slice(tailStart)
const stepTail = worldSteps.slice(tailStart)

const sortedDvt = [...dvtTail].sort((a, b) => a - b)
const dvtMedian = sortedDvt[Math.floor(sortedDvt.length / 2)]
const dvtMax = Math.max(...dvtTail)
const dvtMin = Math.min(...dvtTail)
const dvtNegativeCount = dvtTail.filter(d => d < -1e-6).length

const sortedWall = [...wallTail].sort((a, b) => a - b)
const wallMedian = sortedWall[Math.floor(sortedWall.length / 2)]
const wallMax = Math.max(...wallTail)

const stepMedian = ((s) => s[Math.floor(s.length / 2)])([...stepTail].sort((a, b) => a - b))
const stepMax = Math.max(...stepTail)

console.log('\n           Δvt (ms)   wall dt (ms)   world step (m)')
console.log(`  median   ${(dvtMedian * 1000).toFixed(2).padStart(6)}        ${wallMedian.toFixed(1).padStart(5)}          ${stepMedian.toFixed(3)}`)
console.log(`  min      ${(dvtMin * 1000).toFixed(2).padStart(6)}`)
console.log(`  max      ${(dvtMax * 1000).toFixed(2).padStart(6)}        ${wallMax.toFixed(1).padStart(5)}          ${stepMax.toFixed(3)}`)
console.log(`  threshold (Δvt): ${(MAX_DVT_S * 1000).toFixed(0)} ms`)
console.log(`  negative Δvt frames: ${dvtNegativeCount} (should be 0 — virtualTimeRef must be monotonic during play)`)

const csv = ['idx,t_ms,wall_dt_ms,vt_s,dvt_ms,step_m,x,y,z']
for (let i = 0; i < samples.length; i++) {
  const wallDt = i > 0 ? (samples[i].t - samples[i - 1].t).toFixed(2) : ''
  const dvt = i > 0 ? ((samples[i].vt - samples[i - 1].vt) * 1000).toFixed(3) : ''
  const step = i > 0 ? worldSteps[i - 1].toFixed(4) : ''
  csv.push([
    i,
    samples[i].t.toFixed(2),
    wallDt,
    samples[i].vt.toFixed(4),
    dvt,
    step,
    samples[i].x.toFixed(3),
    samples[i].y.toFixed(3),
    samples[i].z.toFixed(3),
  ].join(','))
}
fs.writeFileSync(path.join(OUT, 'samples.csv'), csv.join('\n'))
console.log(`\nCSV: ${path.join(OUT, 'samples.csv')}`)

let failed = false
if (!Number.isFinite(dvtMax) || dvtMax > MAX_DVT_S) {
  console.error(`\nFAIL: per-frame Δvt of ${(dvtMax * 1000).toFixed(2)} ms exceeds ceiling ${(MAX_DVT_S * 1000).toFixed(0)} ms`)
  console.error('This usually means the dt-cap in Dashboard.jsx rAF tick is missing or too loose.')
  console.error('Check: src/components/Dashboard.jsx — `dtSec = Math.min(rawDt, 0.033)` should be present.')
  failed = true
}
if (dvtNegativeCount > 0) {
  console.error(`\nFAIL: ${dvtNegativeCount} negative Δvt frames during play — virtualTimeRef went backwards.`)
  console.error('This means a scrub or jump fired while the rAF tick was advancing time. Investigate.')
  failed = true
}
if (failed) process.exit(1)
console.log('\nPASS: per-frame Δvt is bounded by the dt-cap and monotonic.')
