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
