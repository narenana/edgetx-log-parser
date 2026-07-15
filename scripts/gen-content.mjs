// Static SEO content generator.
//
// Renders the hand-authored content cluster (use-case landing pages + how-to
// guides) into self-contained static HTML under public/, builds the guides
// hub index, and regenerates public/sitemap.xml to list every crawlable URL.
//
// These files live in public/ so Cloudflare Pages serves them as real files
// BEFORE the SPA fallback (zero routing config; base:'./' untouched). Each
// page is fully standalone — its own <title>, meta description, canonical,
// Open Graph set and JSON-LD — per the growth plan's "each page ships its own
// unfurl" rule. No FAQPage markup anywhere (deliberate: rich-result dead + the
// plan bans it); guides use plain Article/TechArticle + BreadcrumbList.
//
// Source of truth: content/pages/*.json (one structured object per page,
// shape documented below). Editable by hand or via PR. Wired into the build
// as the `prebuild` npm hook, so CI regenerates HTML + sitemap every build.
//
// Page object shape:
//   { slug, kind: 'usecase'|'guide', title, metaDescription, h1,
//     ogTitle, ogDescription, targetQuery,
//     introHtml, sections:[{heading,html}], faqs:[{q,a}], relatedLinks:[{text,href}] }

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONTENT_DIR = join(ROOT, 'content', 'pages')
const PUBLIC_DIR = join(ROOT, 'public')

const SITE = 'https://www.narenana.com'
const BASE = SITE + '/log-viewer/'
const OG_IMAGE = BASE + 'og-card.jpg'
const TODAY = new Date().toISOString().slice(0, 10)

// Shared page CSS — mirrors index.html's .seo-shell so the cluster reads as
// one system, plus a slim top bar and a CTA button.
const STYLE = `
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;background:#f5f7fb;color:#2c3e5c;
    font-family:'Segoe UI',system-ui,-apple-system,sans-serif;line-height:1.6}
  a{color:#2272d8}
  .topbar{border-bottom:1px solid #e2e7f0;background:#fff}
  .topbar .in{max-width:820px;margin:0 auto;padding:12px 24px;display:flex;
    gap:16px;align-items:center;font-size:14px}
  .topbar .brand{font-weight:700;color:#0f1a2c;text-decoration:none}
  .topbar .sp{flex:1}
  .wrap{max-width:820px;margin:0 auto;padding:40px 24px 64px}
  .crumbs{font-size:13px;color:#5a6b8c;margin:0 0 18px}
  h1{font-size:30px;line-height:1.2;color:#0f1a2c;margin:0 0 10px}
  .lede{font-size:16px;color:#3a4c70;margin:0 0 22px}
  h2{font-size:19px;color:#0f1a2c;margin:30px 0 8px}
  p,li{font-size:15px;margin:0 0 10px}
  ol,ul{padding-left:22px;margin:0 0 10px}
  table{border-collapse:collapse;font-size:14px;margin:8px 0 12px;width:100%}
  th,td{border:1px solid #d7dde8;padding:7px 12px;text-align:left;vertical-align:top}
  th{background:#eef2f9;color:#0f1a2c}
  code{background:#eef2f9;border-radius:4px;padding:1px 5px;font-size:13.5px}
  .cta{display:inline-block;margin:8px 0 4px;padding:11px 20px;border-radius:8px;
    background:#2272d8;color:#fff;font-weight:600;text-decoration:none}
  .faq dt{font-weight:600;color:#0f1a2c;margin-top:14px}
  .faq dd{margin:2px 0 0}
  .related{margin-top:8px}
  .related li{margin-bottom:4px}
  footer{max-width:820px;margin:0 auto;padding:24px;border-top:1px solid #e2e7f0;
    font-size:13px;color:#5a6b8c}
  @media(prefers-color-scheme:dark){
    body{background:#0e1117;color:#c4cfe0}
    .topbar{background:#11151c;border-color:#232a36}
    .topbar .brand,h1,h2,th,.faq dt{color:#e8eef8}
    .lede{color:#a9b6cd}.crumbs{color:#8394b0}
    a{color:#5aa2f0}
    th{background:#1a2029}td,th{border-color:#2a323f}
    code{background:#1a2029}
    footer{border-color:#232a36;color:#8394b0}
  }`

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => esc(s).replace(/"/g, '&quot;')

function jsonLd(page, url) {
  const isGuide = page.kind === 'guide'
  const crumbs = [
    { name: 'narenana', item: SITE + '/' },
    { name: 'RC Log Viewer', item: BASE },
  ]
  if (isGuide) crumbs.push({ name: 'Guides', item: BASE + 'guides/' })
  crumbs.push({ name: page.h1, item: url })
  const graph = [
    {
      '@type': isGuide ? 'TechArticle' : 'WebPage',
      '@id': url + '#page',
      name: page.title,
      headline: page.h1,
      description: page.metaDescription,
      url,
      inLanguage: 'en',
      image: OG_IMAGE,
      isPartOf: { '@type': 'WebSite', name: 'narenana', url: SITE + '/' },
      about: { '@type': 'SoftwareApplication', name: 'RC Log Viewer', url: BASE },
      author: { '@type': 'Organization', name: 'narenana', url: SITE + '/' },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({
        '@type': 'ListItem', position: i + 1, name: c.name, item: c.item,
      })),
    },
  ]
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2)
}

function renderPage(page) {
  const isGuide = page.kind === 'guide'
  const url = isGuide ? `${BASE}guides/${page.slug}/` : `${BASE}${page.slug}/`
  const crumbHtml = isGuide
    ? `<a href="${BASE}">RC Log Viewer</a> › <a href="${BASE}guides/">Guides</a> › ${esc(page.h1)}`
    : `<a href="${BASE}">RC Log Viewer</a> › ${esc(page.h1)}`

  const sections = page.sections.map(
    (s) => `<h2>${esc(s.heading)}</h2>\n${s.html}`
  ).join('\n')

  const faqs = page.faqs && page.faqs.length
    ? `<h2>Frequently asked questions</h2>\n<dl class="faq">\n` +
      page.faqs.map((f) => `<dt>${esc(f.q)}</dt>\n<dd>${f.a}</dd>`).join('\n') +
      `\n</dl>`
    : ''

  const related = page.relatedLinks && page.relatedLinks.length
    ? `<h2>Related</h2>\n<ul class="related">\n` +
      page.relatedLinks.map((l) => `<li><a href="${escAttr(l.href)}">${esc(l.text)}</a></li>`).join('\n') +
      `\n</ul>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(page.title)}</title>
<meta name="description" content="${escAttr(page.metaDescription)}" />
<meta name="author" content="narenana" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="${url}" />
<link rel="icon" type="image/jpeg" href="${BASE}narenana.jpg" sizes="200x200" />
<link rel="icon" type="image/svg+xml" href="${BASE}favicon.svg" />
<link rel="apple-touch-icon" href="${BASE}narenana.jpg" />
<meta property="og:type" content="${isGuide ? 'article' : 'website'}" />
<meta property="og:site_name" content="narenana" />
<meta property="og:locale" content="en_US" />
<meta property="og:url" content="${url}" />
<meta property="og:title" content="${escAttr(page.ogTitle || page.title)}" />
<meta property="og:description" content="${escAttr(page.ogDescription || page.metaDescription)}" />
<meta property="og:image" content="${OG_IMAGE}" />
<meta property="og:image:type" content="image/jpeg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escAttr(page.ogTitle || page.title)}" />
<meta name="twitter:description" content="${escAttr(page.ogDescription || page.metaDescription)}" />
<meta name="twitter:image" content="${OG_IMAGE}" />
<script type="application/ld+json">
${jsonLd(page, url)}
</script>
<style>${STYLE}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <a class="brand" href="${BASE}">RC Log Viewer</a>
  <a href="${BASE}guides/">Guides</a>
  <span class="sp"></span>
  <a href="${BASE}">Open the viewer →</a>
</div></div>
<main class="wrap">
  <p class="crumbs">${crumbHtml}</p>
  <h1>${esc(page.h1)}</h1>
  <div class="lede">${page.introHtml}</div>
  <p><a class="cta" href="${BASE}">Open a log in the browser →</a></p>
  ${sections}
  ${faqs}
  ${related}
</main>
<footer>
  <a href="${BASE}">RC Log Viewer</a> ·
  <a href="${BASE}guides/">Guides</a> ·
  <a href="https://github.com/narenana/edgetx-log-parser">Source on GitHub (GPL-3.0)</a> ·
  Part of <a href="${SITE}/">narenana — free browser tools for RC pilots</a>,
  alongside the <a href="https://sim.narenana.com">Nanawing FPV wing simulator</a>.
</footer>
</body>
</html>
`
}

function renderHub(guides) {
  const url = BASE + 'guides/'
  const cards = guides.map((g) =>
    `<li><a href="${BASE}guides/${g.slug}/"><strong>${esc(g.h1)}</strong></a><br />${esc(g.metaDescription)}</li>`
  ).join('\n')
  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage', '@id': url + '#page',
        name: 'RC Flight Log Guides', url, inLanguage: 'en',
        description: 'How-to guides for recording and reading EdgeTX, iNAV and Betaflight flight logs.',
        isPartOf: { '@type': 'WebSite', name: 'narenana', url: SITE + '/' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'narenana', item: SITE + '/' },
          { '@type': 'ListItem', position: 2, name: 'RC Log Viewer', item: BASE },
          { '@type': 'ListItem', position: 3, name: 'Guides', item: url },
        ],
      },
    ],
  }, null, 2)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>RC Flight Log Guides — EdgeTX, iNAV &amp; Betaflight</title>
<meta name="description" content="How-to guides for recording and reading flight logs: enable SD-card logging on EdgeTX, blackbox in Betaflight and iNAV, and read or analyze a log." />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="${url}" />
<link rel="icon" type="image/jpeg" href="${BASE}narenana.jpg" sizes="200x200" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="narenana" />
<meta property="og:url" content="${url}" />
<meta property="og:title" content="RC Flight Log Guides — EdgeTX, iNAV & Betaflight" />
<meta property="og:description" content="How-to guides for recording and reading EdgeTX, iNAV and Betaflight flight logs." />
<meta property="og:image" content="${OG_IMAGE}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${OG_IMAGE}" />
<script type="application/ld+json">
${jsonld}
</script>
<style>${STYLE}
  .hub li{margin:0 0 16px;list-style:none}
  .hub ul{padding:0}</style>
</head>
<body>
<div class="topbar"><div class="in">
  <a class="brand" href="${BASE}">RC Log Viewer</a>
  <a href="${BASE}guides/">Guides</a>
  <span class="sp"></span>
  <a href="${BASE}">Open the viewer →</a>
</div></div>
<main class="wrap hub">
  <p class="crumbs"><a href="${BASE}">RC Log Viewer</a> › Guides</p>
  <h1>RC flight log guides</h1>
  <div class="lede">Short, practical how-tos for recording and reading RC flight logs — then replay any of them in 3D with the <a href="${BASE}">RC Log Viewer</a>.</div>
  <ul>
${cards}
  </ul>
</main>
<footer>
  <a href="${BASE}">RC Log Viewer</a> ·
  <a href="https://github.com/narenana/edgetx-log-parser">Source on GitHub (GPL-3.0)</a> ·
  Part of <a href="${SITE}/">narenana — free browser tools for RC pilots</a>.
</footer>
</body>
</html>
`
}

function writeFileEnsured(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function main() {
  if (!existsSync(CONTENT_DIR)) {
    console.error('[gen-content] no content dir yet at', CONTENT_DIR, '— skipping (nothing to generate)')
    return
  }
  const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json'))
  const pages = files.map((f) => JSON.parse(readFileSync(join(CONTENT_DIR, f), 'utf8')))
  const usecases = pages.filter((p) => p.kind === 'usecase')
  const guides = pages.filter((p) => p.kind === 'guide')

  // Warn (don't fail the build) on meta-length overruns so drift is visible.
  for (const p of pages) {
    if (p.title.length > 60) console.warn(`[gen-content] WARN title ${p.title.length}c >60: ${p.slug}`)
    if (p.metaDescription.length > 155) console.warn(`[gen-content] WARN desc ${p.metaDescription.length}c >155: ${p.slug}`)
  }

  const urls = [BASE]
  for (const p of usecases) {
    writeFileEnsured(join(PUBLIC_DIR, p.slug, 'index.html'), renderPage(p))
    urls.push(`${BASE}${p.slug}/`)
  }
  if (guides.length) {
    writeFileEnsured(join(PUBLIC_DIR, 'guides', 'index.html'), renderHub(guides))
    urls.push(`${BASE}guides/`)
    for (const g of guides) {
      writeFileEnsured(join(PUBLIC_DIR, 'guides', g.slug, 'index.html'), renderPage(g))
      urls.push(`${BASE}guides/${g.slug}/`)
    }
  }

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/gen-content.mjs (prebuild). Do not edit by hand. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${TODAY}</lastmod>\n  </url>`).join('\n')}
</urlset>
`
  writeFileEnsured(join(PUBLIC_DIR, 'sitemap.xml'), sitemap)

  console.log(`[gen-content] wrote ${usecases.length} use-case pages, ${guides.length} guides + hub, sitemap with ${urls.length} URLs`)
}

main()
