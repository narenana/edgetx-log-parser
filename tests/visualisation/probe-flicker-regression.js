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
// 2. Plays at 1× for ~200 frames, recording aircraft world position
//    every rAF.
// 3. Computes consecutive step distances |pos[i] - pos[i-1]|.
// 4. Asserts max(step) / median(step) <= MAX_VARIANCE_RATIO.
//
// Caveat: headless puppeteer Chrome doesn't experience the same rAF
// stalls as an interactive browser under recording load, so a passing
// run here does NOT prove the user-side flicker is gone — that requires
// visual inspection at 1× zoomed-in. But this probe is a guardrail: if
// someone removes the dt-cap and the variance ratio crashes through the
// ceiling, headless will catch it. It also catches outright path-lerp
// bugs (e.g. a missing CallbackProperty `result`-mutate that produced a
// 17 px step we tracked before PR #22).
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
// Variance threshold. Headless rAF cadence is fairly even; under this
// regime, a healthy build tends to land at ratio ≈ 1.5–2.5. 4.0 leaves
// generous headroom for normal jitter while still catching catastrophic
// regressions (e.g. dt-cap removed).
const MAX_VARIANCE_RATIO = Number(process.env.MAX_VARIANCE_RATIO || 4.0)

const OUT = path.join(__dirname, 'flicker-regression')
fs.mkdirSync(OUT, { recursive: true })

console.log(`Probing ${URL}`)
console.log(`Log: ${LOG}`)
console.log(`Samples: ${NUM_SAMPLES}, max ratio: ${MAX_VARIANCE_RATIO}`)

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

// Sample aircraft world position every rAF for NUM_SAMPLES frames.
await page.evaluate((n) => {
  window.__regSamples = []
  let count = 0
  const tick = () => {
    const v = window.__viewerState?.()
    if (v && v.aircraft) {
      window.__regSamples.push({
        t: performance.now(),
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

// Step distances between consecutive aircraft world positions.
const steps = []
for (let i = 1; i < samples.length; i++) {
  const dx = samples[i].x - samples[i - 1].x
  const dy = samples[i].y - samples[i - 1].y
  const dz = samples[i].z - samples[i - 1].z
  steps.push(Math.hypot(dx, dy, dz))
}

// Throw out the first 20 frames — they often include a settle-in
// transient as smooth.pos / lastReal initialise.
const tail = steps.slice(20)
const sorted = [...tail].sort((a, b) => a - b)
const median = sorted[Math.floor(sorted.length / 2)]
const max = Math.max(...tail)
const min = Math.min(...tail)
const mean = tail.reduce((a, b) => a + b, 0) / tail.length
const ratio = median > 0 ? max / median : Infinity

// Per-frame dt jitter, useful to confirm the probe environment isn't
// itself producing huge cadence swings.
const dts = []
for (let i = 1; i < samples.length; i++) dts.push(samples[i].t - samples[i - 1].t)
const dtTail = dts.slice(20)
const dtSortedT = [...dtTail].sort((a, b) => a - b)
const dtMedian = dtSortedT[Math.floor(dtSortedT.length / 2)]
const dtMax = Math.max(...dtTail)

console.log('\n  step (m)        dt (ms)')
console.log(`  median ${median.toFixed(3).padStart(7)}   ${dtMedian.toFixed(1).padStart(5)}`)
console.log(`  mean   ${mean.toFixed(3).padStart(7)}`)
console.log(`  min    ${min.toFixed(3).padStart(7)}`)
console.log(`  max    ${max.toFixed(3).padStart(7)}   ${dtMax.toFixed(1).padStart(5)}`)
console.log(`  ratio (max/median): ${ratio.toFixed(2)}x`)
console.log(`  threshold: ${MAX_VARIANCE_RATIO}x`)

const csv = ['idx,t_ms,dt_ms,step_m,x,y,z']
for (let i = 0; i < samples.length; i++) {
  const dt = i > 0 ? (samples[i].t - samples[i - 1].t).toFixed(2) : ''
  const step = i > 0 ? steps[i - 1].toFixed(4) : ''
  csv.push(`${i},${samples[i].t.toFixed(2)},${dt},${step},${samples[i].x.toFixed(3)},${samples[i].y.toFixed(3)},${samples[i].z.toFixed(3)}`)
}
fs.writeFileSync(path.join(OUT, 'samples.csv'), csv.join('\n'))
console.log(`\nCSV: ${path.join(OUT, 'samples.csv')}`)

if (!Number.isFinite(ratio) || ratio > MAX_VARIANCE_RATIO) {
  console.error(`\nFAIL: per-frame aircraft step variance ratio ${ratio.toFixed(2)}x exceeds threshold ${MAX_VARIANCE_RATIO}x`)
  console.error('This usually means the dt-cap in Dashboard.jsx rAF tick is missing or too loose.')
  console.error('Check: src/components/Dashboard.jsx — `dtSec = Math.min(rawDt, 0.033)` should be present.')
  process.exit(1)
}
console.log('\nPASS: per-frame aircraft motion variance is bounded.')
