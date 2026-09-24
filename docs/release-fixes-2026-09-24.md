# Local website release fixes — 24 September 2026

Fixed four generated guide links, revalidating shared assets, header Share during replay, mobile header wrapping, and keyboard isolation while the Share dialog is open. The welcome screen retains its visible floating Share button. Sharing includes only the public canonical URL, never uploaded logs.

Returning-visitor testing reproduced a Workbox default that marked unhashed public assets as revision:null. Restricted that optimization to fingerprinted bundles; family assets now receive actual content hashes. Added a postbuild gate inspecting the generated worker so this cannot silently regress. Version query parameters and local fonts remain available through precaching.

Validation: production web build, 44/44 parser tests, generated-cache gate; actual website Worker proxy at 390px. Existing cached visitor updated without clearing site data. Sample flight loaded; one visible Share moved to the header, playback timeline remained unobstructed, canonical URL was https://www.narenana.com/log-viewer/, and Escape returned focus to header Share. Welcome Share also remains visible. No social message was sent.

Runtime dependency audit: zero after compatible updates and Vite 6.4.3. Development-only Electron packaging advisories are recorded in the parent website release review; this is a browser release, not a desktop installer release.

Local only, no push or deployment. Main Worker must remove its legacy sharing injection in the coordinated release. Physical phone, actual social unfurls and production service checks remain external acceptance items.
