/**
 * debrief-check — Flight Debrief regression harness over REAL logs.
 *
 * Companion to bb-check: decodes every log in ./test-logs/ through the
 * REAL parse paths (WASM blackbox or CSV parser — both of which now run
 * the debrief inline), prints each log's findings, and when
 * ./test-logs/expectations.json exists, diffs must-fire / must-not-fire
 * per log and exits non-zero on any miss.
 *
 * Everything here is local-only: logs and expectations are gitignored
 * (real GPS + real flight facts). Run: npm run debrief:check
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, join, resolve } from 'node:path'

import init, { parseBlackbox } from '../vendor/blackbox-parser/blackbox_parser.js'
import { mapToViewerLog } from '../src/utils/blackbox-mapper.js'
import { parseEdgeTXLog } from '../src/utils/parseLog.js'
import { scanLogTail } from '../src/debrief/index.js'
import { buildPayload, validatePayload } from '../src/debrief/payload.js'
import { debriefAsText } from '../src/debrief/templates.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIR = join(ROOT, 'test-logs')
const WASM = new URL('../vendor/blackbox-parser/blackbox_parser_bg.wasm', import.meta.url)
const TARGET_MAIN_FRAMES = 8000
const APPROX_BYTES_PER_FRAME = 60

await init({ module_or_path: readFileSync(WASM) })

const files = readdirSync(DIR).filter(f => /\.(txt|bbl|bfl|csv)$/i.test(f)).sort()
const expectations = existsSync(join(DIR, 'expectations.json'))
  ? JSON.parse(readFileSync(join(DIR, 'expectations.json'), 'utf8'))
  : null

let failed = 0
const SPARK_LIMIT = 8 * 1024

for (const name of files) {
  const path = join(DIR, name)
  let log
  try {
    if (/\.csv$/i.test(name)) {
      log = parseEdgeTXLog(readFileSync(path, 'utf8'), name)
    } else {
      const bytes = new Uint8Array(readFileSync(path))
      const stride = Math.max(1, Math.round(bytes.length / APPROX_BYTES_PER_FRAME / TARGET_MAIN_FRAMES))
      const parsed = parseBlackbox(bytes, stride)
      log = mapToViewerLog(parsed, name, () => {}, scanLogTail(bytes))
      parsed.free()
    }
  } catch (e) {
    console.log(`\n■ ${name}: PARSE FAILED — ${e.message}`)
    failed++
    continue
  }

  const d = log.debrief
  console.log(`\n■ ${name}`)
  if (!d) {
    console.log('  debrief: MISSING')
    failed++
    continue
  }
  console.log(`  clean=${d.clean} · ran ${d.coverage.ran.length} · skipped [${d.coverage.skipped.join(',')}]` +
    (d.errors.length ? ` · ERRORS ${JSON.stringify(d.errors)}` : ''))
  for (const f of d.findings) {
    const ev = Object.entries(f.evidence).map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(2) : v}`).join(' ')
    console.log(`  [${f.severity.toUpperCase().padEnd(8)}] ${f.id} conf=${f.confidence.toFixed(2)}${f.t ? ` t=${f.t.map(x => x.toFixed(0)).join('–')}` : ''} ${ev}`)
    const sparkBytes = f.spark ? JSON.stringify(f.spark).length : 0
    if (sparkBytes > SPARK_LIMIT) { console.log(`    ✗ spark slice ${sparkBytes}B > ${SPARK_LIMIT}B`); failed++ }
  }
  if (d.errors.length) failed++

  // payload must always validate + fit the cap
  const payload = buildPayload(d)
  const errs = validatePayload(payload)
  if (errs.length) { console.log(`  ✗ payload invalid: ${errs.join(' | ')}`); failed++ }
  const pj = JSON.stringify(payload)
  // Key-precise leak check — substring matching burned us: "longest_s"
  // contains "lon". Only actual JSON key names count.
  if (/\d+\.\d{3,}/.test(pj) || /"(_?lat|_?lon|latitude|longitude|coords?|spark|points)"\s*:/i.test(pj)) {
    console.log('  ✗ payload leaks precision or local-only keys')
    failed++
  }
  console.log(`  payload ${pj.length}B valid=${errs.length === 0}`)

  // copy-as-text must serialize without coordinates
  const text = debriefAsText(d, 'flight')
  if (/\d{1,3}\.\d{4,}/.test(text)) { console.log('  ✗ debrief text contains coordinate-like numbers'); failed++ }

  if (expectations && expectations[name]) {
    const exp = expectations[name]
    const got = new Set(d.findings.map(f => f.id))
    for (const id of exp.mustFire || []) {
      if (!got.has(id)) { console.log(`  ✗ expected ${id} to fire`); failed++ }
    }
    for (const id of exp.mustNotFire || []) {
      if (got.has(id)) { console.log(`  ✗ ${id} fired but must not`); failed++ }
    }
    if (exp.clean != null && d.clean !== exp.clean) {
      console.log(`  ✗ clean=${d.clean}, expected ${exp.clean}`)
      failed++
    }
  }
}

console.log(failed ? `\n✗ debrief-check FAILED (${failed})` : '\n✓ debrief-check PASS')
process.exit(failed ? 1 : 0)
