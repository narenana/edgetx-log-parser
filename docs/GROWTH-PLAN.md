# Organic Growth Plan — SEO + Social Virality ("one domain, one authority system")

*Produced 2026-07-08 from a multi-agent review: 4 web researchers (SERP landscape, tool-SEO playbooks, virality mechanics, community map) + 4 audits (technical SEO, content architecture, share loops, narenana.com homepage hub) → synthesis → adversarial critique. The critique's corrections are baked in as **binding amendments** (§9). Covers BOTH repos: `edgetx-log-parser` (the tool) and `narenana-website` (homepage + Worker).*

---

## 1. Diagnosis — why organic traffic is low

**The binding constraint is content existence, not domain authority.** The only indexed URL, `www.narenana.com/log-viewer/`, serves a completely **empty `<body>`** — zero text, zero `<h1>`, zero `<noscript>`. Every ranking signal rides on the `<title>`, a truncating ~172-char meta description, and JSON-LD. AI answer engines (a growing "best free blackbox viewer" discovery channel) see literally nothing.

**Proof:** the homepage — which *has* a few hundred words of server-rendered text — already ranks **~#7 for "rc log viewer replay flight logs 3d"** by accident, while the app page with the perfect exact-match title ranks nowhere.

Compounding factors:
1. **One URL can't cover four query families** (EdgeTX CSV / iNAV blackbox / Betaflight blackbox / `.bbl` file-extension queries) — and those SERPs are demonstrably weak: GitHub READMEs, a 17-star repo, a 2023 tutorial recommending Excel.
2. **The homepage hero duplicates the log-viewer pitch** — the hub cannibalizes the money page instead of feeding it.
3. **Zero share affordances** in an app whose 3D replay is the most photogenic artifact in its competitor set. FPV culture is "DVR or it didn't happen" — every screenshot posted today is a dead-end impression with no URL.
4. **Technical leaks:** soft-404 robots/sitemap under `/log-viewer/`, indexable pages.dev duplicates, borrowed YouTube-thumbnail og:image on every unfurl.
5. **The north-star metric (loaded AND played-to-end) is unmeasurable** — playback completion silently calls `setPlaying(false)` (Dashboard.jsx:189-192); no `playback_completed` event exists.

Every earned-link target that matters (EdgeTX manual, iNAV docs, Betaflight docs, awesome-flying-fpv, Oscar Liang) explicitly accepts contributions. The fix stack needs **no backend, no base-path change, no privacy compromise**.

## 2. Phase 0 — measurement setup (owner, ~1.5h, do first)

- **Google Search Console**: verify `narenana.com` as a **domain property** (covers www + path + sim subdomain); submit both sitemaps. Until this exists the plan flies blind.
- **Bing Webmaster Tools + IndexNow** *(critique addition)*: ~15 min; Bingbot isn't in the AI-block list and powers DuckDuckGo + ChatGPT-search retrieval — cheap coverage of the AI-answer channel.
- **GA4 events** (consent-gated as today; note `bootGaDegraded()` already gives anonymous cookieless trends pre-consent):
  - Add `playback_completed{duration_sec, speed}` — **not inside the state updater** (React updaters must stay pure; StrictMode double-invokes) — use the same pattern as the dock's `playback_started`.
  - `log_loaded` **already carries `source`** ('file'/'sample'/'shared-url') — don't rename existing values; only `playback_started` gains `source: 'ui'|'deep-link'`.
  - Share loop (as features land): `share_card_created`, `share_invoked{method, artifact}`, `export_completed{format, clip_seconds}`, `shared_link_opened`.

## 3. Quick wins (week 1)

### edgetx-log-parser repo
| # | Item | Effort |
|---|---|---|
| 1 | **Static crawlable landing shell inside `#root`** — THE unlock. ~600–900 words of real HTML in index.html: `<h1>`, privacy tagline, 3-step how-it-works, supported-formats `<table>`, privacy paragraph, 5–6 FAQ as visible text (NO FAQPage markup — rich results dead), footer links (guides, GitHub, sim, homepage). Inline `<style>` so it paints pre-JS (becomes the LCP element) + `<noscript>`. **Hydration-safe: `createRoot().render()` discards #root children wholesale** (verified). Works with `base:'./'` + the Worker (no path routes → vite.config caveat never triggers); ships identically to Electron. Mirror the live empty-state copy (no cloaking). Change App.jsx:346 drop-title `<div>`→`<h1>` so pre/post-JS DOM agree. | M |
| 2 | **Title + description rewrite.** Title ≤60 chars front-loading "blackbox": `RC Log Viewer — EdgeTX & Betaflight/iNAV Blackbox in 3D` (56). Description ≤155 keeping the privacy hook: `Replay EdgeTX CSV and iNAV/Betaflight blackbox logs on a 3D globe with synced telemetry charts. Free, in-browser — logs never leave your machine.` (146). Longer copy stays in og:*. | S |
| 3 | **Real `public/robots.txt` + `public/sitemap.xml`.** Kills the soft-404s and fixes the pages.dev host-root robots.txt (Pages serves real files before the SPA fallback; Worker forwards). Note (critique): `/log-viewer/robots.txt` has **no crawler effect for www** (robots is host-root only) — its value is soft-404 hygiene + the pages.dev host; the *root* robots.txt declares the `/log-viewer/sitemap.xml` (cross-directory sitemaps are valid when declared in robots). | S |
| 4 | **⚠ Duplicate hosts — SEE AMENDMENT A before touching.** The naive `_headers` X-Robots-Tag noindex **would noindex the money page** (the Worker passes upstream headers through to www). Do it only with the Worker-side header strip, or rely on canonical for the prod pages.dev host. | S |
| 5 | **Designed og:image card** (1200×630: globe mid-replay + wordmark + "Replay any flight in 3D — nothing uploaded") as `public/og-card.png`; real UI capture as JSON-LD `screenshot`; 1280×640 crop as GitHub social preview. Fixes every Discord/Reddit/forum unfurl before share features even ship. | M |
| 6 | **`?sample=` deep link + `autoplay=1` + `playback_completed`.** Mints "watch a flight in 5 seconds" URLs (`/log-viewer/?sample=quad&camera=orbit&autoplay=1`) for YouTube descriptions, README hero, guide CTAs, sim footer. Query strings dodge the base caveat. Also the end-of-playback card (replay/share CTA slot) — the highest-intent moment, currently a silent stop. | S |
| 7 | **JSON-LD upgrade**: @graph with VideoObject (the YouTube demo), BreadcrumbList, `sameAs`→GitHub, featureList; fix hardcoded `softwareVersion` via a build token. No fabricated ratings. | S |
| 8 | **GitHub as discovery surface**: topics, About link, README hero (demo link + GIF), social-preview image. | S |

### narenana-website repo
| # | Item | Effort |
|---|---|---|
| 9 | **Homepage title/description**: brand + suite terms (`narenana — free browser tools for RC pilots`), stop pitching the log viewer verbatim in the hero. **Sequencing rule: ship the /log-viewer/ static shell FIRST** — today the homepage accidentally carries the money queries and must not drop them into a void. | S |
| 10 | **Root sitemap/robots hygiene**: merge the two conflicting `User-agent: *` groups, add the second `Sitemap:` line, lastmod refresh. | S |

## 4. Medium term (weeks 2–6)

1. **Four use-case landing pages** as static `public/<slug>/index.html` (served before SPA fallback, zero config): `betaflight-blackbox-viewer`, `inav-blackbox-viewer` (**most winnable — zero hosted web tools in that SERP**), `edgetx-log-viewer`, `open-bbl-file`. Hand-written, genuinely distinct, each with its own title/description/og set *(critique addition)*. Hard stop at four — no doorway permutations.
2. **Guides hub at `/log-viewer/guides/`** — markdown in `docs/guides/*.md` + ~40-line prebuild script (wired into `npm run build`) that also regenerates sitemap.xml. First guide is already written (README's EdgeTX SD-logging section). Inventory in §6.
3. **Homepage hub restructure** (AFTER the shell ships): hero → "Free browser tools for RC pilots"; tool sections with keyword anchors; **server-render the latest N YouTube links** (grid is currently client-rendered → invisible freshness).
4. **Share loop v1 — flight-summary PNG card** (Strava pattern): hand-drawn canvas, stat tiles + **path-shape minimap on neutral background** (no map tiles → no location leak, no CORS), watermark `narenana.com/log-viewer` baked into pixels; Web Share API + download fallback; surfaced at end-of-playback, summary modal, stats panel. 16:9 + 9:16 variants.
5. **Activate `?log=` share links — they already work** (verified: the hook consumes `?log=` today; GitHub raw/gist URLs replay now). Ship the UI ("Copy replay link", gist helper, forum BBCode variant) + fix blackbox byte-sniffing in loadLogFromUrl. Unlocks the help-seeking loop ("what went wrong?" replays into IntoFPV/RCGroups/Discord).
6. **Docs-PR link sprint** (permanent links, each a morning): EdgeTX user manual how-to article; iNAV `docs/Blackbox.md` viewer listing; awesome-flying-fpv PR. *(Betaflight docs PR: soft-pedal — see Amendment D.)*
7. **YouTube flywheel**: canonical URL + "made with RC Log Viewer" in every video description + pinned comment; one 3–5 min search-targeted tutorial.
8. **Internal-linking pass** (both repos) per the map in §6.
9. **Recent-flights retention loop** *(critique addition)*: localStorage list on the empty state — feeds return sessions and is the prerequisite for Season Wrapped anyway.
10. Opportunistic perf/PWA: trim the 1.8MB precache; static shell already fixes LCP.

## 5. Strategic (launch-gated / ongoing)

- **MP4/GIF replay export** — the launch artifact ("no competitor can produce a 3D replay video"). Offline deterministic render: step `virtualTimeRef` at 1/30s → `requestRender` → WebCodecs. **Effort is XL, not L** *(critique correction)* — multi-week for a solo dev. **Do NOT gate the community launch solely on it**; PNG card + `?log=` links can carry an earlier, smaller wave.
- **Crash detection + "share this crash" link** (T-minus-5s framing) — share is simultaneously a help request and the product.
- **Opt-in share-upload Worker** (the only backend in the plan; only after gist links prove demand): 10MB cap, R2 7-day TTL, explicit consent modal. Matches the roadmap's own opt-in terms.
- **Community launch wave** (see §7) + **Show HN** *(critique addition)*: free/GPL/privacy-first/WebCodecs+Cesium is prime HN material.
- **AI-crawler policy decision** (owner, 15 min): the Cloudflare-managed robots blocks GPTBot/ClaudeBot/etc. outright — blocking not just training but **retrieval/citation**, so assistants can never recommend the tool. Real traffic trade-off; owner's call.
- **Web-to-desktop path** *(critique addition)*: download CTA on the landing shell → GitHub Releases; explore winget/Homebrew-cask listings (discovery + backlinks).
- **Season Wrapped card** (annual spike; needs recent-flights store first). **Ayvri-orphan probe**: one soaring-community post to test demand before any IGC work. **Monitor Betaflight 2026.6** (official app is adding a built-in viewer): keep the moat on EdgeTX + privacy + polish; don't chase Betaflight head queries or PID-tuning SERPs.

## 6. Content architecture (decisions)

**Guides live under `/log-viewer/guides/` in this repo** (not www root): static files in `public/` are served before the SPA fallback with zero build/config changes; the topic cluster sits on the money path; community PRs can fix steps; one prebuild regenerates guides + sitemap.

**Query division (anti-cannibalization contract):**
- Homepage = brand + suite ("free RC pilot tools")
- `/log-viewer/` = head tool terms ("edgetx log viewer", "blackbox viewer online", "3d flight log replay")
- Use-case pages = one modifier family each · Guides = how-to long tail · sim.narenana.com = "fpv wing simulator"

**12-URL inventory** (each hand-written; target query in parens): homepage (brand/suite) · `/log-viewer/` (head terms) · 4 use-case pages (above) · guides hub · `edgetx-sd-card-logging` · `enable-blackbox-betaflight` · `enable-blackbox-inav` · `how-to-read-a-blackbox-log` · `analyze-a-crash-log`. Later, feature-gated: `blackbox-to-video`, find-lost-drone page ("find lost drone last GPS coordinates" — current #1 advice is hand-copying coords into Google Maps).

**Rules:** answers front-loaded (LLM citation), FAQs as text never markup, hard stop at the inventory, no AI filler.

## 7. Community playbook (3 phases, solo-dev cadence)

- **P1 (weekends, 4 PRs):** EdgeTX manual article · iNAV Blackbox.md · Betaflight docs (soft) · awesome-flying-fpv. Skip: AlternativeTo/directories (verified dead), archived lists.
- **P2 (20 min/day):** join iNAV/ExpressLRS/Betaflight/INAV-FWG Discords; **never cold-announce** — answer "how do I see my flight path" questions with replay links. YouTube description housekeeping now.
- **P3 (launch month, one channel/week, timed to a real artifact):** r/fpv (video post, link in top comment, 48h responsiveness) → RCGroups evergreen author thread → INAV Fixed Wing Group (group + Discord + Wing Talk podcast pitch + inavfixedwinggroup.com guide) → IntoFPV crash-analysis thread first, THEN Oscar Liang guest-post pitch (his /log-telemetry/ tutorial still recommends Excel) → FliteTest "Shameless Self Promotion Zone" (instructor framing) → Show HN.

## 8. Measurement cadence + targets

Weekly 15 min: Search Console impressions/clicks for 6 query families; index coverage. Monthly 1h: north-star by acquisition source; share funnel (`playback_completed → share_invoked → shared_link_opened`); **query mining decides the next guide** (demand-driven, never speculative); referral log.

**90-day targets** (post-shell): top-20 "edgetx log viewer", top-10 "inav blackbox viewer" variants; 4 docs backlinks live; ≥25% of guide/use-case organic sessions reach `log_loaded`; `playback_completed` trending; ≥1 living community thread. **180-day** (post-MP4): `share_invoked` ≥5% of completed playbacks; `shared_link_opened` a visible acquisition source. **Kill criteria:** impressions but <2% CTR after 60 days → fix titles before writing anything new.

## 9. Binding amendments (from the adversarial critique)

- **A. THE LANDMINE — do not blanket-noindex pages.dev.** The Worker's `forward()` returns upstream headers intact, and production www fetches from `edgetx-log-parser.pages.dev` — a `_headers` X-Robots-Tag would **noindex www.narenana.com/log-viewer itself**, and `latest.narenana.com` flows through the same path. Fix: `headers.delete('x-robots-tag')` in `forward()` for narenana.com hosts before adding any noindex, or skip `_headers` noindex for the production host and rely on canonical.
- **B. Analytics corrections:** `log_loaded` already has `source`; don't fire events inside React state updaters; pre-consent cookieless trends already exist (`bootGaDegraded`).
- **C. Effort correction:** MP4 export = XL; stage an earlier smaller launch wave on the PNG card + `?log=` links.
- **D. Community-norm guard:** docs PRs must be genuinely useful docs first, links second; the Betaflight docs PR is the least likely to land (they're shipping their own viewer) — deprioritize.
- **E. Don't degrade the product for privacy theater:** keep full-precision in-app GPS coords (local-only); privacy rules apply to *shared artifacts* (no lat/lon text on any artifact, map background off by default, MP4 dialog acknowledges satellite imagery of the flying site).
- **F. Compliance fix while at it:** un-hide the Cesium imagery credit (current `display:none` is a license bug); artifacts with globe pixels carry "Imagery © Esri · Maxar".
- **G. Each new static page ships its own title/description/og image** — no shared generic unfurls.
- **H. Data drift:** live meta description is ~172 chars (not 193); title 68 (not 67). Rewrites proceed as specced.
