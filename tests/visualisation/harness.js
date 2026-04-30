// Visualisation-layer test harness for the RC Log Viewer.
//
// Three layers of defense (see docs/test-plan-visualisation.md for full
// rationale):
//
//   1. INVARIANTS — five must-always-hold conditions checked after every
//      action. Failures are immediate and dump the action sequence.
//   2. NAMED CASES — deterministic test cases for known regressions.
//   3. FUZZ — random sequences of interactions, each followed by an
//      invariant check, to catch the sequence-dependent fly-aways the
//      named cases miss.
//
// Usage:
//   node harness.js                     # run named cases (default)
//   node harness.js --fuzz              # also run desktop fuzz
//   node harness.js --fuzz --mobile     # add mobile-touch fuzz pass
//   node harness.js --replay <seed>     # deterministically replay a seed
//
// Failures: any failed seed dumps to ./fuzz-failures/<seed>.json with the
// exact action log, so you can git-blame the seed and replay forever.

import puppeteer from 'puppeteer-core'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Configuration ───────────────────────────────────────────────────────

const URL = process.env.TEST_URL || 'http://localhost:5577/'
const LOG_PATH =
  process.env.TEST_LOG ||
  'C:\\Users\\Guddu\\Desktop\\Dolphin logs\\LOG00009.TXT'
const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HEADLESS = process.env.HEADFUL ? false : 'new'
const FUZZ_SEEDS = parseInt(process.env.FUZZ_SEEDS || '20', 10)
const FUZZ_ACTIONS_PER_SEED = parseInt(process.env.FUZZ_ACTIONS || '200', 10)
const VIEWPORT = { width: 1280, height: 800 }

const args = process.argv.slice(2)
const RUN_FUZZ = args.includes('--fuzz')
const RUN_MOBILE = args.includes('--mobile')
const REPLAY_SEED = args.includes('--replay') ? args[args.indexOf('--replay') + 1] : null

// ── Invariants ──────────────────────────────────────────────────────────

const INVARIANTS = {
  'INV-1': s =>
    Number.isFinite(s.smooth.dist) && s.smooth.dist >= 50 && s.smooth.dist <= 5000,
  'INV-2': s => s.camToAircraftMeters == null || s.camToAircraftMeters < 10000,
  'INV-3': s =>
    s.aircraft == null ||
    (Number.isFinite(s.aircraft.x) &&
      Number.isFinite(s.aircraft.y) &&
      Number.isFinite(s.aircraft.z)),
  'INV-4': s =>
    Number.isFinite(s.smooth.dist) &&
    Number.isFinite(s.smooth.hdg) &&
    (s.smooth.posX == null || Number.isFinite(s.smooth.posX)),
  'INV-5': s => true, // mode-flag consistency check requires DOM read; deferred
}

async function checkInvariants(page) {
  const state = await page.evaluate(() =>
    typeof window.__viewerState === 'function' ? window.__viewerState() : null,
  )
  if (!state) return { ok: true, state: null, violations: [] }
  const violations = []
  for (const [id, fn] of Object.entries(INVARIANTS)) {
    try {
      if (!fn(state)) violations.push({ id, state: clone(state) })
    } catch (err) {
      violations.push({ id, state: clone(state), error: err.message })
    }
  }
  return { ok: violations.length === 0, state, violations }
}

function clone(o) { return JSON.parse(JSON.stringify(o)) }

// ── Test page setup ─────────────────────────────────────────────────────

async function newSession() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Headless Chrome aggressively throttles rAF / setTimeout when the
      // window is occluded or backgrounded. Cesium's preRender only
      // fires while the scene actually renders, so under throttling the
      // per-frame tick rate collapses — the fly-away guard's 8-frame
      // debounce never accumulates, nav-widget rAF holds drift instead
      // of stepping, etc. These four flags pin the renderer to its
      // un-throttled foreground rate.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    defaultViewport: VIEWPORT,
  })
  const page = await browser.newPage()
  // Force document.visibilityState = 'visible' — rAF throttling also
  // checks this independently of the Chrome flags above.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' })
    Object.defineProperty(document, 'hidden', { get: () => false })
  })
  page.on('pageerror', err => console.error('[pageerror]', err.message))
  page.on('console', msg => {
    const t = msg.type()
    if (t === 'warn' || t === 'error') {
      console.error(`[page.${t}]`, msg.text())
    }
  })
  return { browser, page }
}

async function loadLog(page) {
  const cdp = await page.target().createCDPSession()
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Storage.clearDataForOrigin', {
    origin: URL.replace(/\/$/, ''),
    storageTypes: 'all',
  }).catch(() => {})

  await page.goto(URL, { waitUntil: 'networkidle2' })
  // Reset any lingering service worker
  await page.evaluate(async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations()
      for (const r of regs) await r.unregister()
    }
  })

  const fileInput = await page.$('input[type=file]')
  if (!fileInput) throw new Error('input[type=file] not found')
  await fileInput.uploadFile(LOG_PATH)

  // Wait for summary CTA, click, wait for globe canvas + first preRender.
  await page.waitForSelector('.summary-cta', { timeout: 60000 })
  await page.click('.summary-cta')
  await page.waitForSelector('.globe-wrap canvas', { timeout: 30000 })
  // Wait until the dev-only state hook is exposed (preRender has fired
  // at least once and the aircraft entity has been built).
  await page.waitForFunction(
    () => typeof window.__viewerState === 'function' && window.__viewerState() != null,
    { timeout: 30000 },
  )
}

// ── Action vocabulary ──────────────────────────────────────────────────

async function getCanvasCenter(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.globe-wrap canvas')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })
}

async function dispatchWheel(page, deltaY) {
  // Use the canvas's actual centre. CDP's mouse.wheel works but not all
  // versions of puppeteer-core forward it correctly to bubble through to
  // our wheel handler — dispatching the event directly is more reliable.
  await page.evaluate(deltaY => {
    const c = document.querySelector('.globe-wrap canvas') || document.querySelector('.globe-wrap')
    const r = c.getBoundingClientRect()
    c.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true,
      deltaY, deltaMode: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }))
  }, deltaY)
}

async function dragMouse(page, dx, dy, button = 'left') {
  // Puppeteer's page.mouse API doesn't reliably dispatch mousedown
  // events to a Cesium canvas (some events are silently dropped by the
  // headless input pipeline before they reach JS handlers). Direct
  // DOM-event dispatch is more reliable AND uses the same code path a
  // real user would trigger. The canvas's listeners + the parent
  // container's `mousedown` handler (releaseAuto) both fire as
  // expected when we dispatch synthetic events here.
  const buttonNum = button === 'right' ? 2 : button === 'middle' ? 1 : 0
  await page.evaluate((dx, dy, buttonNum) => {
    const cn = document.querySelector('.globe-wrap canvas') || document.querySelector('.globe-wrap')
    if (!cn) return
    const r = cn.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const opt = (px, py) => ({
      bubbles: true, cancelable: true,
      clientX: px, clientY: py,
      button: buttonNum, buttons: 1 << buttonNum,
    })
    cn.dispatchEvent(new MouseEvent('mousedown', opt(cx, cy)))
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      const px = cx + (dx * i) / steps
      const py = cy + (dy * i) / steps
      cn.dispatchEvent(new MouseEvent('mousemove', opt(px, py)))
    }
    cn.dispatchEvent(new MouseEvent('mouseup', opt(cx + dx, cy + dy)))
  }, dx, dy, buttonNum)
}

async function setSpeed(page, speed) {
  // Speed picker is a button + popover. Open by clicking the chip then
  // the value button. Pop quietly if not visible.
  const ok = await page.evaluate(speed => {
    const chip = document.querySelector('.speed-current')
    if (chip) chip.click()
    const btns = [...document.querySelectorAll('.speed-btn')]
    const target = btns.find(b => parseFloat(b.textContent) === speed)
    if (!target) return false
    target.click()
    return true
  }, speed)
  return ok
}

async function togglePlay(page) {
  await page.click('.play-btn')
}

async function clickAutoToggle(page) {
  const sel = '.globe-auto-btn'
  const has = await page.$(sel)
  if (has) await page.click(sel)
}

const NAV_BTN_MAP = {
  rotL:  '.nav-rot-l',
  rotR:  '.nav-rot-r',
  tiltU: '.nav-tilt button:nth-child(1)',
  tiltD: '.nav-tilt button:nth-child(2)',
  zIn:   '.nav-zoom button:nth-child(1)',
  zOut:  '.nav-zoom button:nth-child(2)',
}

async function holdNavBtn(page, which, ms = 300) {
  const sel = NAV_BTN_MAP[which]
  // Direct DOM-event dispatch — puppeteer's page.mouse pipeline drops
  // some events under headless Chrome + Cesium (notably mousedown/mouseup
  // on canvas, but also mouseup on buttons in some configurations). We
  // saw the symptom as a leaked rAF chain in navHeld (the React onMouseUp
  // never fired, so stop() was never called, so c.zoomOut(8) ran every
  // frame for the rest of the session — 1+ MILLION m of drift).
  // Synthetic events bubble through React's synthetic-event system and
  // reliably fire onMouseDown / onMouseUp.
  const ok = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1 }))
    return true
  }, sel)
  if (!ok) return false
  await sleep(ms)
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 0 }))
    // Also fire mouseleave in case onMouseLeave is the active stopper.
    el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true, clientX: cx, clientY: cy }))
    return true
  }, sel)
  return true
}

async function clickNavBtn(page, which) {
  return holdNavBtn(page, which, 300)
}

// Read the camera state Cesium-side (not just the smoothed proxy) so we can
// observe heading/pitch shifts after rotate/tilt actions.
async function readCameraOrient(page) {
  return page.evaluate(() => {
    const v = window.__viewerState?.()
    if (!v) return null
    return {
      smoothHdg: v.smooth.hdg,
      smoothDist: v.smooth.dist,
      camToAircraft: v.camToAircraftMeters,
      autoMode: v.autoMode,
      flyAwayCount: v.flyAwayCount,
      // Cesium camera heading (rad). Tracks the actual viewport rotation
      // even in manual mode (where smooth.hdg goes dormant).
      camHeading: v.camera?.heading,
      camPitch: v.camera?.pitch,
    }
  })
}

async function scrubTimeline(page, fraction) {
  const ok = await page.evaluate(fraction => {
    const slider = document.querySelector('.timeline-scrubber')
    if (!slider) return false
    const max = parseFloat(slider.max || '0')
    const v = Math.max(0, Math.min(max, max * fraction))
    slider.value = String(v)
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    slider.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, fraction)
  return ok
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Named test cases ────────────────────────────────────────────────────

const NAMED_CASES = [
  {
    id: 'B1',
    title: 'Single scroll-down zooms out by ~15%',
    run: async page => {
      const before = (await page.evaluate(() => window.__viewerState())).smooth.dist
      await dispatchWheel(page, 100)
      await sleep(80)
      const after = (await page.evaluate(() => window.__viewerState())).smooth.dist
      const ratio = after / before
      const pass = ratio > 1.10 && ratio < 1.22 // 15% ± slack
      return { pass, detail: `ratio=${ratio.toFixed(3)} (target ~1.15)` }
    },
  },
  {
    id: 'B3',
    title: 'Zoom holds through 60× playback (regression: 8389a44)',
    run: async page => {
      // Set zoom, set speed, play, sample dist over 3 s.
      await dispatchWheel(page, 100)
      await sleep(80)
      const target = (await page.evaluate(() => window.__viewerState())).smooth.dist
      await setSpeed(page, 60)
      await togglePlay(page)
      await sleep(3000)
      await togglePlay(page)
      const after = (await page.evaluate(() => window.__viewerState())).smooth.dist
      const ratio = after / target
      const pass = ratio > 0.85 && ratio < 1.15
      return { pass, detail: `target=${target.toFixed(0)} after=${after.toFixed(0)} ratio=${ratio.toFixed(3)}` }
    },
  },
  {
    id: 'B7',
    title: 'Auto-toggle off then on releases userDistOverride',
    run: async page => {
      await dispatchWheel(page, 100)
      const overrideAfterScroll = (await page.evaluate(() => window.__viewerState())).smooth.userDistOverride
      await clickAutoToggle(page) // off
      await sleep(150)
      await clickAutoToggle(page) // on
      await sleep(150)
      const overrideAfterToggle = (await page.evaluate(() => window.__viewerState())).smooth.userDistOverride
      const pass = overrideAfterScroll === true && overrideAfterToggle === false
      return { pass, detail: `before=${overrideAfterScroll} after=${overrideAfterToggle}` }
    },
  },
  {
    id: 'B5',
    title: 'Wheel zoom-in clamped to lower bound 50',
    run: async page => {
      for (let i = 0; i < 30; i++) await dispatchWheel(page, -200)
      await sleep(100)
      const d = (await page.evaluate(() => window.__viewerState())).smooth.dist
      return { pass: d >= 50 && d <= 80, detail: `dist=${d.toFixed(1)}` }
    },
  },
  {
    id: 'B6',
    title: 'Wheel zoom-out clamped to upper bound 5000',
    run: async page => {
      for (let i = 0; i < 60; i++) await dispatchWheel(page, 300)
      await sleep(100)
      const d = (await page.evaluate(() => window.__viewerState())).smooth.dist
      return { pass: d >= 4000 && d <= 5000, detail: `dist=${d.toFixed(1)}` }
    },
  },
  {
    id: 'F4',
    title: '60× play 2s — aircraft stays in frame',
    run: async page => {
      await setSpeed(page, 60)
      await togglePlay(page)
      await sleep(2000)
      const s = await page.evaluate(() => window.__viewerState())
      await togglePlay(page)
      const pass = s.camToAircraftMeters != null && s.camToAircraftMeters < 5000
      return { pass, detail: `camToAircraft=${s.camToAircraftMeters?.toFixed(0)}m` }
    },
  },
  {
    id: 'G1',
    title: 'Fly-away guard recovers from runaway dist (smooth.dist=99999)',
    run: async page => {
      // Bump time forward so the guard isn't sitting in the load-cooldown.
      await sleep(1100)
      const before = await page.evaluate(() => window.__viewerState())
      const ok = await page.evaluate(() => window.__viewerCorrupt('dist'))
      if (!ok) return { pass: false, detail: 'corrupt hook missing' }
      // Wait long enough for DEBOUNCE (8 frames) + recovery + 1 s
      // cooldown to fully clear, even on CI-throttled headless Chrome
      // where rAF can run nearer 10 fps than 60 fps. 1500 ms covers it.
      await sleep(1500)
      const after = await page.evaluate(() => window.__viewerState())
      const recovered = after.smooth.dist >= 50 && after.smooth.dist <= 5000
      const counted = after.flyAwayCount > before.flyAwayCount
      const autoOn = after.autoMode === true
      const pass = recovered && counted && autoOn
      return {
        pass,
        detail: `dist:${before.smooth.dist?.toFixed?.(0)}→${after.smooth.dist?.toFixed?.(0)} count:${before.flyAwayCount}→${after.flyAwayCount} auto:${after.autoMode}`,
      }
    },
  },
  {
    id: 'G2',
    title: 'Fly-away guard recovers from NaN smooth.dist',
    run: async page => {
      await sleep(1100)
      const before = await page.evaluate(() => window.__viewerState())
      await page.evaluate(() => window.__viewerCorrupt('distNaN'))
      await sleep(450)
      const after = await page.evaluate(() => window.__viewerState())
      const recovered = Number.isFinite(after.smooth.dist) && after.smooth.dist >= 50 && after.smooth.dist <= 5000
      const counted = after.flyAwayCount > before.flyAwayCount
      const pass = recovered && counted
      return {
        pass,
        detail: `dist:${before.smooth.dist?.toFixed?.(0)}→${after.smooth.dist} count:${before.flyAwayCount}→${after.flyAwayCount}`,
      }
    },
  },
  {
    id: 'G3',
    title: 'Fly-away guard recovers from NaN smooth.pos',
    run: async page => {
      await sleep(1100)
      const before = await page.evaluate(() => window.__viewerState())
      await page.evaluate(() => window.__viewerCorrupt('posNaN'))
      await sleep(450)
      const after = await page.evaluate(() => window.__viewerState())
      const posOk = Number.isFinite(after.smooth.posX) && Number.isFinite(after.smooth.posY) && Number.isFinite(after.smooth.posZ)
      const counted = after.flyAwayCount > before.flyAwayCount
      const pass = posOk && counted
      return {
        pass,
        detail: `posX:${after.smooth.posX} count:${before.flyAwayCount}→${after.flyAwayCount}`,
      }
    },
  },
  {
    id: 'G4',
    title: 'Fly-away guard forces manual → auto on recovery',
    run: async page => {
      await sleep(1100)
      // Drag → manual mode
      await dragMouse(page, -120, 0)
      await sleep(150)
      const mid = await page.evaluate(() => window.__viewerState())
      if (mid.autoMode) return { pass: false, detail: 'drag did not enter manual' }
      // Now corrupt — guard should force auto back on.
      await page.evaluate(() => window.__viewerCorrupt('dist'))
      await sleep(1500)
      const after = await page.evaluate(() => window.__viewerState())
      const pass = after.autoMode === true && after.smooth.dist <= 5000
      return { pass, detail: `auto:${mid.autoMode}→${after.autoMode} dist:${after.smooth.dist?.toFixed?.(0)}` }
    },
  },

  // ── N: nav-widget (zoom/rotate/tilt) buttons ──────────────────────────────
  // Each button is a press-and-hold that fires a rAF chain calling small
  // camera-step functions every frame. The most important property is that
  // the chain STOPS when the mouse releases — earlier a closure bug in
  // navHeld leaked the rAF after a state-driven re-render, drifting the
  // camera into space at 8 m/frame.
  {
    id: 'N1',
    title: 'Nav zoom-out button — 300ms hold zooms a sensible amount',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await holdNavBtn(page, 'zOut', 300)
      await sleep(150)
      const after = await readCameraOrient(page)
      const grew = after.camToAircraft > before.camToAircraft
      const bounded = after.camToAircraft < 10000  // INV-2
      const pass = grew && bounded
      return { pass, detail: `camToAc:${before.camToAircraft?.toFixed(0)}→${after.camToAircraft?.toFixed(0)} m` }
    },
  },
  {
    id: 'N2',
    title: 'Nav zoom-in button — 300ms hold zooms toward aircraft',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await holdNavBtn(page, 'zIn', 300)
      await sleep(150)
      const after = await readCameraOrient(page)
      const shrank = after.camToAircraft < before.camToAircraft + 50  // allow tiny drift
      const bounded = after.camToAircraft < 10000
      const pass = shrank && bounded
      return { pass, detail: `camToAc:${before.camToAircraft?.toFixed(0)}→${after.camToAircraft?.toFixed(0)} m` }
    },
  },
  {
    id: 'N3',
    title: 'Nav zoom-out — 1s hold stays bounded (no rAF leak)',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await holdNavBtn(page, 'zOut', 1000)
      await sleep(200)
      const after = await readCameraOrient(page)
      const bounded = after.camToAircraft < 10000
      // After release + 200ms wait, check it isn't STILL drifting:
      await sleep(500)
      const later = await readCameraOrient(page)
      const stable = Math.abs(later.camToAircraft - after.camToAircraft) < 200
      const pass = bounded && stable
      return {
        pass,
        detail: `camToAc:${before.camToAircraft?.toFixed(0)}→${after.camToAircraft?.toFixed(0)}→${later.camToAircraft?.toFixed(0)} m bounded=${bounded} stable=${stable}`,
      }
    },
  },
  {
    id: 'N4',
    title: 'Nav rotate-left — heading actually changes',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await holdNavBtn(page, 'rotL', 300)
      await sleep(150)
      const after = await readCameraOrient(page)
      const dh = Math.abs(((after.camHeading - before.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const rotated = dh > 0.05  // ~3° minimum for 300 ms hold @ 0.02 rad/frame
      const bounded = after.camToAircraft < 10000
      const pass = rotated && bounded
      return {
        pass,
        detail: `Δheading=${(dh*180/Math.PI).toFixed(1)}° camToAc=${after.camToAircraft?.toFixed(0)}m`,
      }
    },
  },
  {
    id: 'N5',
    title: 'Nav rotate-right — heading actually changes',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await holdNavBtn(page, 'rotR', 300)
      await sleep(150)
      const after = await readCameraOrient(page)
      const dh = Math.abs(((after.camHeading - before.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const rotated = dh > 0.05
      const bounded = after.camToAircraft < 10000
      const pass = rotated && bounded
      return {
        pass,
        detail: `Δheading=${(dh*180/Math.PI).toFixed(1)}° camToAc=${after.camToAircraft?.toFixed(0)}m`,
      }
    },
  },
  {
    id: 'N6',
    title: 'Nav tilt-up — pitch actually changes',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await holdNavBtn(page, 'tiltU', 300)
      await sleep(150)
      const after = await readCameraOrient(page)
      const dp = Math.abs(after.camPitch - before.camPitch)
      const tilted = dp > 0.03
      const bounded = after.camToAircraft < 10000
      const pass = tilted && bounded
      return {
        pass,
        detail: `Δpitch=${(dp*180/Math.PI).toFixed(1)}° camToAc=${after.camToAircraft?.toFixed(0)}m`,
      }
    },
  },
  {
    id: 'N7',
    title: 'Nav tilt-down — pitch actually changes',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await holdNavBtn(page, 'tiltD', 300)
      await sleep(150)
      const after = await readCameraOrient(page)
      const dp = Math.abs(after.camPitch - before.camPitch)
      const tilted = dp > 0.03
      const bounded = after.camToAircraft < 10000
      const pass = tilted && bounded
      return {
        pass,
        detail: `Δpitch=${(dp*180/Math.PI).toFixed(1)}° camToAc=${after.camToAircraft?.toFixed(0)}m`,
      }
    },
  },
  {
    id: 'N8',
    title: 'Nav button release stops chain (no drift over next 1s)',
    run: async page => {
      await sleep(1100)
      await holdNavBtn(page, 'zOut', 200)
      const t1 = (await readCameraOrient(page)).camToAircraft
      await sleep(1000)
      const t2 = (await readCameraOrient(page)).camToAircraft
      // Within 250 m of t1 a second later — proves rAF chain stopped.
      const stable = Math.abs(t2 - t1) < 250
      const pass = stable && t2 < 10000
      return { pass, detail: `t1=${t1?.toFixed(0)} t2=${t2?.toFixed(0)} drift=${(t2-t1).toFixed(0)} m` }
    },
  },

  // ── D: mouse drag interactions ────────────────────────────────────────────
  {
    id: 'D1',
    title: 'Short left drag enters manual mode',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await dragMouse(page, -120, 0)
      await sleep(200)
      const after = await readCameraOrient(page)
      const pass = before.autoMode === true && after.autoMode === false && after.camToAircraft < 10000
      return { pass, detail: `auto:${before.autoMode}→${after.autoMode} camToAc=${after.camToAircraft?.toFixed(0)}` }
    },
  },
  {
    id: 'D2',
    title: 'Long horizontal drag rotates farther than short drag',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await dragMouse(page, -400, 0)
      await sleep(200)
      const after = await readCameraOrient(page)
      const dh = Math.abs(((after.camHeading - before.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const rotated = dh > 0.10  // bigger drag → bigger rotation
      const bounded = after.camToAircraft < 10000
      const pass = rotated && bounded
      return { pass, detail: `Δheading=${(dh*180/Math.PI).toFixed(1)}° camToAc=${after.camToAircraft?.toFixed(0)}m` }
    },
  },
  {
    id: 'D3',
    title: 'Right-button vertical drag tilts (pitch changes)',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      await dragMouse(page, 0, -120, 'right')
      await sleep(200)
      const after = await readCameraOrient(page)
      const dp = Math.abs(after.camPitch - before.camPitch)
      const tilted = dp > 0.03
      const bounded = after.camToAircraft < 10000
      const pass = tilted && bounded
      return { pass, detail: `Δpitch=${(dp*180/Math.PI).toFixed(1)}° camToAc=${after.camToAircraft?.toFixed(0)}m` }
    },
  },
  {
    id: 'D4',
    title: 'Drag release — camera does not continue drifting',
    run: async page => {
      await sleep(1100)
      await dragMouse(page, -200, 0)
      const t1 = (await readCameraOrient(page)).camToAircraft
      await sleep(1000)
      const t2 = (await readCameraOrient(page)).camToAircraft
      const stable = Math.abs(t2 - t1) < 250
      const pass = stable && t2 < 10000
      return { pass, detail: `t1=${t1?.toFixed(0)} t2=${t2?.toFixed(0)} drift=${(t2-t1).toFixed(0)} m` }
    },
  },
  {
    id: 'D5',
    title: 'First mouse drag actually rotates camera (regression: b81db12)',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      if (before.autoMode !== true) return { pass: false, detail: `not in auto: ${before.autoMode}` }
      // Log: state before drag
      console.log(`     [D5 before] h=${before.camHeading?.toFixed(3)} orbit=${await page.evaluate(()=>window.__viewerState().camera.hasOrbitTransform)} dist=${before.smoothDist?.toFixed(0)}`)
      await dragMouse(page, -180, 0)
      await sleep(200)
      const after = await readCameraOrient(page)
      console.log(`     [D5 after ] h=${after.camHeading?.toFixed(3)} orbit=${await page.evaluate(()=>window.__viewerState().camera.hasOrbitTransform)} dist=${after.smoothDist?.toFixed(0)}`)
      const dh = Math.abs(((after.camHeading - before.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const rotated = dh > 0.05
      const switched = after.autoMode === false
      const pass = rotated && switched && after.camToAircraft < 10000
      return {
        pass,
        detail: `Δheading=${(dh*180/Math.PI).toFixed(1)}° auto:${before.autoMode}→${after.autoMode} camToAc=${after.camToAircraft?.toFixed(0)}`,
      }
    },
  },
  {
    id: 'D6',
    title: 'First right-button drag actually pitches camera',
    run: async page => {
      await sleep(1100)
      const before = await readCameraOrient(page)
      if (before.autoMode !== true) return { pass: false, detail: `not in auto: ${before.autoMode}` }
      await dragMouse(page, 0, -120, 'right')
      await sleep(200)
      const after = await readCameraOrient(page)
      const dp = Math.abs(after.camPitch - before.camPitch)
      const pitched = dp > 0.03
      const switched = after.autoMode === false
      const pass = pitched && switched && after.camToAircraft < 10000
      return {
        pass,
        detail: `Δpitch=${(dp*180/Math.PI).toFixed(1)}° auto:${before.autoMode}→${after.autoMode}`,
      }
    },
  },

  // ── T-series: interaction sequences ────────────────────────────────────
  // Each named-case reset returns to auto mode, so these tests have a
  // clean starting state. They verify that ORDER of interactions doesn't
  // break expected behaviour (the user-reported bug we just fixed was
  // exactly this: button-then-mouse worked but mouse-first didn't).
  {
    id: 'T1',
    title: 'Button-rotate then mouse-drag-rotate both change heading',
    run: async page => {
      await sleep(1100)
      const t0 = await readCameraOrient(page)
      // Step 1: rotate via button
      await holdNavBtn(page, 'rotR', 300)
      await sleep(150)
      const t1 = await readCameraOrient(page)
      const d1 = Math.abs(((t1.camHeading - t0.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      // Step 2: drag mouse — should ADDITIONALLY rotate
      await dragMouse(page, -200, 0)
      await sleep(200)
      const t2 = await readCameraOrient(page)
      const d2 = Math.abs(((t2.camHeading - t1.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const pass = d1 > 0.05 && d2 > 0.05 && t2.camToAircraft < 10000
      return {
        pass,
        detail: `button Δh=${(d1*180/Math.PI).toFixed(1)}° then mouse Δh=${(d2*180/Math.PI).toFixed(1)}°`,
      }
    },
  },
  {
    id: 'T2',
    title: 'Mouse-drag then button both change heading (REGRESSION: b81db12)',
    run: async page => {
      await sleep(1100)
      const t0 = await readCameraOrient(page)
      if (t0.autoMode !== true) return { pass: false, detail: `not in auto: ${t0.autoMode}` }
      // Step 1: first mouse drag (the case that was silently no-op-ing)
      await dragMouse(page, -200, 0)
      await sleep(200)
      const t1 = await readCameraOrient(page)
      const d1 = Math.abs(((t1.camHeading - t0.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      // Step 2: button rotate — should still work
      await holdNavBtn(page, 'rotR', 300)
      await sleep(150)
      const t2 = await readCameraOrient(page)
      const d2 = Math.abs(((t2.camHeading - t1.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const pass = d1 > 0.05 && d2 > 0.05 && t2.camToAircraft < 10000
      return {
        pass,
        detail: `mouse Δh=${(d1*180/Math.PI).toFixed(1)}° then button Δh=${(d2*180/Math.PI).toFixed(1)}°`,
      }
    },
  },
  {
    id: 'T3',
    title: 'Wheel-zoom in auto then mouse-drag — wheel adjusts dist, drag rotates',
    run: async page => {
      await sleep(1100)
      const t0 = await readCameraOrient(page)
      // Wheel zoom in auto mode adjusts smooth.dist without exiting auto
      await dispatchWheel(page, 200) // zoom out
      await sleep(150)
      const t1 = await readCameraOrient(page)
      const distGrew = t1.smoothDist > t0.smoothDist + 10
      const stillAuto = t1.autoMode === true
      // Then drag → enters manual + rotates
      await dragMouse(page, -180, 0)
      await sleep(200)
      const t2 = await readCameraOrient(page)
      const dh = Math.abs(((t2.camHeading - t1.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const rotated = dh > 0.05
      const switchedManual = t2.autoMode === false
      const pass = distGrew && stillAuto && rotated && switchedManual && t2.camToAircraft < 10000
      return {
        pass,
        detail: `dist:${t0.smoothDist?.toFixed(0)}→${t1.smoothDist?.toFixed(0)} stillAuto=${stillAuto}, then Δh=${(dh*180/Math.PI).toFixed(1)}° → manual=${!t2.autoMode}`,
      }
    },
  },
  {
    id: 'T4',
    title: 'Auto-toggle manual→auto, mouse drag re-enters manual and rotates',
    run: async page => {
      await sleep(1100)
      // Drag → manual
      await dragMouse(page, -100, 0)
      await sleep(150)
      const t1 = await readCameraOrient(page)
      if (t1.autoMode !== false) return { pass: false, detail: `expected manual after drag: ${t1.autoMode}` }
      // Auto-toggle → back to auto
      await clickAutoToggle(page)
      await sleep(200)
      const t2 = await readCameraOrient(page)
      if (t2.autoMode !== true) return { pass: false, detail: `expected auto after toggle: ${t2.autoMode}` }
      // Drag again → manual + rotates
      const before = await readCameraOrient(page)
      await dragMouse(page, -180, 0)
      await sleep(200)
      const after = await readCameraOrient(page)
      const dh = Math.abs(((after.camHeading - before.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const rotated = dh > 0.05
      const pass = rotated && after.autoMode === false && after.camToAircraft < 10000
      return {
        pass,
        detail: `manual→auto→manual; Δh on second drag=${(dh*180/Math.PI).toFixed(1)}°`,
      }
    },
  },
  {
    id: 'T5',
    title: 'Two consecutive mouse drags both rotate (no second-drag staleness)',
    run: async page => {
      await sleep(1100)
      const t0 = await readCameraOrient(page)
      await dragMouse(page, -150, 0)
      await sleep(200)
      const t1 = await readCameraOrient(page)
      const d1 = Math.abs(((t1.camHeading - t0.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      await dragMouse(page, -150, 0)
      await sleep(200)
      const t2 = await readCameraOrient(page)
      const d2 = Math.abs(((t2.camHeading - t1.camHeading + Math.PI*3) % (Math.PI*2)) - Math.PI)
      const pass = d1 > 0.05 && d2 > 0.05 && t2.camToAircraft < 10000
      return {
        pass,
        detail: `drag1 Δh=${(d1*180/Math.PI).toFixed(1)}° drag2 Δh=${(d2*180/Math.PI).toFixed(1)}°`,
      }
    },
  },
]

// ── Fuzz ────────────────────────────────────────────────────────────────

const ACTIONS = [
  { name: 'wheelDown', fn: page => dispatchWheel(page, 100 + Math.random() * 400) },
  { name: 'wheelUp', fn: page => dispatchWheel(page, -(100 + Math.random() * 400)) },
  { name: 'dragLeft', fn: page => dragMouse(page, -100 - Math.random() * 200, 0) },
  { name: 'dragRight', fn: page => dragMouse(page, 100 + Math.random() * 200, 0) },
  { name: 'dragTilt', fn: page => dragMouse(page, 0, -50 - Math.random() * 100, 'right') },
  { name: 'autoToggle', fn: clickAutoToggle },
  { name: 'navRotL', fn: page => clickNavBtn(page, 'rotL') },
  { name: 'navRotR', fn: page => clickNavBtn(page, 'rotR') },
  { name: 'navZIn', fn: page => clickNavBtn(page, 'zIn') },
  { name: 'navZOut', fn: page => clickNavBtn(page, 'zOut') },
  { name: 'scrub', fn: page => scrubTimeline(page, Math.random()) },
  { name: 'togglePlay', fn: togglePlay },
  { name: 'speed1', fn: page => setSpeed(page, 1) },
  { name: 'speed10', fn: page => setSpeed(page, 10) },
  { name: 'speed30', fn: page => setSpeed(page, 30) },
  { name: 'speed60', fn: page => setSpeed(page, 60) },
  { name: 'wait150', fn: () => sleep(150) },
  { name: 'wait500', fn: () => sleep(500) },
]

// Tiny seeded PRNG so every fuzz seed is replayable.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function runFuzzSeed(page, seed, count) {
  const rnd = rng(seed)
  const log = []
  const trace = []
  for (let i = 0; i < count; i++) {
    const a = ACTIONS[Math.floor(rnd() * ACTIONS.length)]
    log.push(a.name)
    try {
      await a.fn(page)
    } catch (err) {
      return { ok: false, log, reason: `action ${a.name} threw: ${err.message}` }
    }
    const inv = await checkInvariants(page)
    if (inv.state) {
      trace.push({ i, action: a.name, camToAc: inv.state.camToAircraftMeters, dist: inv.state.smooth?.dist, mode: inv.state.autoMode ? 'auto' : 'manual' })
    }
    if (!inv.ok) {
      return {
        ok: false,
        log,
        trace,
        reason: `invariant violations: ${inv.violations.map(v => v.id).join(', ')}`,
        state: inv.state,
        violations: inv.violations,
      }
    }
  }
  return { ok: true, log, trace }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ RC Log Viewer — Visualisation Test Suite ═══')
  console.log('URL:', URL)
  console.log('Log:', LOG_PATH)
  console.log('Headless:', HEADLESS)

  const { browser, page } = await newSession()
  try {
    console.log('\n— Loading log ...')
    await loadLog(page)
    console.log('  OK\n')

    // Sanity invariant check immediately after load
    const initial = await checkInvariants(page)
    if (!initial.ok) {
      console.error('✗ Invariants broken AT LOAD:', initial.violations)
      process.exitCode = 1
      return
    }
    console.log('✓ Invariants OK at load')
    console.log('  Initial state:', JSON.stringify(initial.state, null, 2).slice(0, 300))

    if (REPLAY_SEED) {
      const seed = parseInt(REPLAY_SEED, 10)
      console.log(`\n— Replaying fuzz seed ${seed}`)
      const r = await runFuzzSeed(page, seed, FUZZ_ACTIONS_PER_SEED)
      console.log(r.ok ? '✓ replay clean' : `✗ replay broke: ${r.reason}`)
      if (!r.ok) writeFailureDump(seed, r)
      return
    }

    // ── Named cases ─────────────────────────────────────────────────────
    console.log('\n— Named cases')
    let pass = 0, fail = 0
    for (const c of NAMED_CASES) {
      try {
        const r = await c.run(page)
        const inv = await checkInvariants(page)
        const ok = r.pass && inv.ok
        console.log(
          `  ${ok ? '✓' : '✗'} ${c.id}  ${c.title}` +
            `\n     ${r.detail}` +
            (inv.ok ? '' : `\n     INV violations: ${inv.violations.map(v => v.id).join(', ')}`),
        )
        if (ok) pass++
        else fail++
        // Reset state between cases.
        await page.evaluate(() => {
          if (typeof window.__viewerForceReset === 'function') {
            window.__viewerForceReset()
            return
          }
          const btn = document.querySelector('.globe-auto-btn')
          if (btn && !btn.classList.contains('active')) btn.click()
          if (btn && btn.classList.contains('active')) {
            btn.click(); btn.click()
          }
        })
        await sleep(300)
      } catch (err) {
        console.log(`  ✗ ${c.id}  ${c.title}\n     threw: ${err.message}`)
        fail++
      }
    }
    console.log(`\n  Named: ${pass} passed, ${fail} failed`)
    // Named-case failures must fail the build — earlier this only set
    // process.exitCode for fuzz failures, so a CI "success" could ship
    // 17 broken named cases. Promote both classes to gating failures.
    if (fail > 0) process.exitCode = 1

    // ── Fuzz ────────────────────────────────────────────────────────────
    if (RUN_FUZZ) {
      console.log(`\n— Fuzz ${RUN_MOBILE ? '(mobile-touch)' : '(desktop)'}: ${FUZZ_SEEDS} seeds × ${FUZZ_ACTIONS_PER_SEED} actions`)
      let cleanSeeds = 0
      const failedSeeds = []
      for (let s = 0; s < FUZZ_SEEDS; s++) {
        const seed = s + 1
        // Reload between seeds so each starts from a clean state.
        await loadLog(page)
        const r = await runFuzzSeed(page, seed, FUZZ_ACTIONS_PER_SEED)
        if (r.ok) {
          cleanSeeds++
          process.stdout.write('.')
        } else {
          failedSeeds.push({ seed, reason: r.reason })
          process.stdout.write('!')
          writeFailureDump(seed, r)
        }
      }
      console.log(`\n  Fuzz: ${cleanSeeds}/${FUZZ_SEEDS} seeds clean`)
      if (failedSeeds.length) {
        console.log('  Failed seeds:')
        for (const f of failedSeeds) console.log(`    seed=${f.seed}: ${f.reason}`)
        console.log('\n  Reproduce with:')
        console.log(`    node harness.js --replay <seed>\n`)
        process.exitCode = 1
      }
    }
  } finally {
    await browser.close()
  }
}

function writeFailureDump(seed, r) {
  const dir = path.join(__dirname, 'fuzz-failures')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `seed-${seed}.json`)
  fs.writeFileSync(file, JSON.stringify({
    seed, reason: r.reason, log: r.log,
    state: r.state, violations: r.violations,
    when: new Date().toISOString(),
  }, null, 2))
  console.log(`  → dumped to ${path.relative(process.cwd(), file)}`)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(2)
})
