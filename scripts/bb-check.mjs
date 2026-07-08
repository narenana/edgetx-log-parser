/**
 * bb-check — end-to-end blackbox regression check.
 *
 * Runs the REAL vendored WASM parser and the REAL src/utils/blackbox-mapper
 * the app uses over a set of blackbox logs, prints the value ranges the
 * gauges consume, and asserts they're sane. Exits non-zero if any log
 * fails a hard check — so it can gate a release or run in CI.
 *
 * Usage:
 *   npm run bb:check                 # scans ./test-logs/ (gitignored)
 *   npm run bb:check -- path/to/LOG00007.TXT other.bbl
 *   npm run bb:check -- some/dir     # scans a directory for *.txt/*.bbl/*.bfl
 *
 * Fixtures are intentionally NOT committed: real logs embed GPS
 * coordinates (your flying-field location). Drop your own logs into
 * ./test-logs/ (gitignored) and run this locally.
 *
 * Why this exists: it caught the iNAV throttle-scaling bug — iNAV floors
 * rcCommand[3] at `minthrottle` (~1080) so motor-idle mapped to ~8%
 * instead of 0%. The THROTTLE_NEVER_IDLES check below guards that class
 * of scaling regression, which an in-range check alone would miss.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, join, resolve } from 'node:path'

import init, { parseBlackbox } from '../vendor/blackbox-parser/blackbox_parser.js'
import { mapToViewerLog } from '../src/utils/blackbox-mapper.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WASM = new URL('../vendor/blackbox-parser/blackbox_parser_bg.wasm', import.meta.url)
const TARGET_MAIN_FRAMES = 8000
const APPROX_BYTES_PER_FRAME = 60
const LOG_EXT = /\.(txt|bbl|bfl)$/i

await init({ module_or_path: readFileSync(WASM) })

// ── resolve the list of logs from argv (files/dirs) or ./test-logs/ ──────────
function expand(paths) {
  const out = []
  for (const p of paths) {
    if (!existsSync(p)) { console.error(`  ! not found: ${p}`); continue }
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) if (LOG_EXT.test(f)) out.push(join(p, f))
    } else {
      out.push(p)
    }
  }
  return out
}
let args = process.argv.slice(2)
if (args.length === 0) {
  const def = join(ROOT, 'test-logs')
  if (!existsSync(def)) {
    console.error('No logs given and ./test-logs/ does not exist.\n' +
      'Usage: npm run bb:check -- <file|dir> ...   (or drop logs in ./test-logs/)')
    process.exit(2)
  }
  args = [def]
}
const logs = expand(args)
if (logs.length === 0) { console.error('No .txt/.bbl/.bfl logs found.'); process.exit(2) }

// ── helpers ──────────────────────────────────────────────────────────────────
function header(bytes) {
  const txt = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 16384))).toString('latin1')
  const pick = re => (txt.match(re) || [])[1]?.trim() ?? null
  return {
    firmware: pick(/^H Firmware revision:(.*)$/m),
    craft: pick(/^H Craft name:(.*)$/m),
    minThr: Number(pick(/^H minthrottle:(.*)$/m)) || null,
    maxThr: Number(pick(/^H maxthrottle:(.*)$/m)) || null,
  }
}
function range(rows, key) {
  let mn = Infinity, mx = -Infinity, cnt = 0, bad = 0
  for (const r of rows) {
    const v = r[key]
    if (v == null) continue
    if (!Number.isFinite(v)) { bad++; continue }
    if (v < mn) mn = v; if (v > mx) mx = v; cnt++
  }
  return cnt ? { min: mn, max: mx, cnt, bad } : { empty: true, bad }
}
const f1 = n => (Math.round(n * 10) / 10).toString()

// ── per-log checks ───────────────────────────────────────────────────────────
let failed = 0
for (const p of logs) {
  const name = basename(p)
  const fails = []
  const warns = []
  let bytes
  try { bytes = new Uint8Array(readFileSync(p)) } catch (e) { console.log(`\n✗ ${name}\n  READ ERROR: ${e.message}`); failed++; continue }

  const h = header(bytes)
  const stride = Math.max(1, Math.round(bytes.length / APPROX_BYTES_PER_FRAME / TARGET_MAIN_FRAMES))

  let parsed, log
  try {
    parsed = parseBlackbox(bytes, stride)
    log = mapToViewerLog(parsed, name)
  } catch (e) {
    console.log(`\n✗ ${name}\n  PARSE/MAP ERROR: ${String(e).slice(0, 160)}`)
    parsed?.free?.()
    failed++
    continue
  }
  const R = log.rows
  const thr = range(R, '_throttle')
  const alt = range(R, 'Alt(m)')
  const spd = range(R, 'GSpd(kmh)')
  const vbat = range(R, 'RxBt(V)')
  const roll = range(R, '_rollDeg')

  // ── hard checks (fail the run) ──
  if (R.length === 0) fails.push('0 mapped rows')
  if (!thr.empty && (thr.min < -0.01 || thr.max > 100.01)) fails.push(`throttle out of 0..100 (${f1(thr.min)}..${f1(thr.max)})`)
  if (thr.bad) fails.push(`${thr.bad} non-finite throttle values`)
  if (!alt.empty && (alt.bad || Math.abs(alt.max) > 100000)) fails.push(`altitude non-finite/absurd (max ${f1(alt.max)})`)
  if (log.hasGPS && spd.empty) fails.push('GPS log but no speed values')

  // ── soft checks (warn only — heuristics that can legitimately trip) ──
  // The throttle-scaling regression signature: a real flight idles the
  // motor at some point, so a throttle floor well above 0 means the
  // channel/scale is offset (the iNAV rcCommand[3] bug).
  if (!thr.empty && log.stats.duration > 30 && thr.min > 3) warns.push(`throttle never idles (min ${f1(thr.min)}%) — possible scaling offset`)
  if (!thr.empty && thr.max - thr.min < 2) warns.push(`throttle almost flat (${f1(thr.min)}..${f1(thr.max)}%)`)
  if (!alt.empty && alt.max > 3000) warns.push(`altitude max ${f1(alt.max)} m — unusually high, confirm`)
  if (!vbat.empty && vbat.max > 0 && (vbat.max / 4.2 < 0.9 || vbat.max > 30)) warns.push(`battery peak ${f1(vbat.max)}V — odd for a standard pack`)

  const ok = fails.length === 0
  if (!ok) failed++
  console.log(`\n${ok ? '✓' : '✗'} ${name}  ·  ${h.firmware ?? '?'} · ${h.craft ?? '?'} · ${(bytes.length / 1e6).toFixed(1)}MB · ${R.length} rows`)
  const rng = r => (r.empty ? '—' : `${f1(r.min)}..${f1(r.max)}`)
  console.log(`    throttle ${rng(thr).padEnd(14)} alt ${rng(alt).padEnd(14)} spd ${rng(spd).padEnd(14)} vbat ${rng(vbat)}`)
  console.log(`    roll ${rng(roll).padEnd(18)} modes ${JSON.stringify(log.flightModes)} · ${f1(log.stats.duration)}s`)
  for (const w of warns) console.log(`    ⚠ ${w}`)
  for (const f of fails) console.log(`    ✗ ${f}`)
  parsed?.free?.()
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${logs.length - failed}/${logs.length} logs OK`)
process.exit(failed === 0 ? 0 : 1)
