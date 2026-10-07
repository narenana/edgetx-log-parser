import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

// Inspect the generated worker, not just the config: the PWA plugin can add
// defaults that incorrectly treat all public assets as fingerprinted bundles.
const sw = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8')
for (const file of ['share.js', 'share.css', 'preview-links.js', 'shell.css', 'fonts.css']) {
  const entry = sw.match(new RegExp(`url:"assets/family/${file.replace('.', '\\.')}",revision:"([a-f0-9]+)"`))
  assert.ok(entry, `${file} must have a content revision in the precache`)
}
console.log('Shared family assets have content-revisioned offline cache entries.')

// Blackbox parsers (iNAV/Betaflight .txt/.bbl/.bfl) run in a Web Worker and
// fetch their WASM lazily. If the WASM is NOT in the SW precache, the FIRST
// blackbox parse on a fresh page load races a cold network fetch against the
// service-worker install and fails silently — no output, no error — until a
// second attempt (the WASM is then in the HTTP cache). This is the regression
// guard for that fix: fail the build if either parser's WASM ever drops out of
// the precache (e.g. someone edits the workbox globPatterns in vite.config).
for (const [name, re] of [
  ['Rust (blackbox_parser_bg)', /url:"assets\/blackbox_parser_bg-[^"]+\.wasm"/],
  ['C fallback (blackbox)', /url:"assets\/blackbox-[^"]+\.wasm"/],
]) {
  assert.ok(
    re.test(sw),
    `blackbox ${name} WASM must be in the SW precache — otherwise the first ` +
      'blackbox parse on a fresh load fails silently. Check the workbox ' +
      'globPatterns in vite.config.js (it must include `wasm`).',
  )
}
console.log('Blackbox parser WASM is in the offline precache.')
