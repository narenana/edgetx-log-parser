import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import { VitePWA } from 'vite-plugin-pwa'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// Dual-target build:
//   VITE_BUILD_TARGET=web      → hosted (Cloudflare Pages, mounted at /log-viewer/
//                                via a path-stripping Worker — see ../website/).
//                                Adds vite-plugin-pwa: manifest, service worker.
//   VITE_BUILD_TARGET=desktop  → packaged for Electron, file:// loads. PWA
//                                disabled — Electron has its own shell.
//
// `base: './'` makes index.html references relative to the page URL, so the
// same dist/ works for both targets:
//   - Electron: file:///.../dist/index.html → resolves ./assets/* locally
//   - Web:      mydomain.com/log-viewer/    → resolves to .../log-viewer/assets/*
//                                             (Worker strips → Pages serves dist/)
// If we later add path-based routing inside the SPA (e.g. /log-viewer/share/abc),
// switch to `base: '/log-viewer/'` and add a post-build step to flatten
// vite-plugin-cesium's nested output. For now, query-param sharing keeps things
// simple.
export default defineConfig(() => {
  const isDesktop = process.env.VITE_BUILD_TARGET === 'desktop'

  const pwa = VitePWA({
    // ⚠️ Self-destroying SW deploy — flushes a stale SW that was caching
    // landing-page HTML at /log-viewer/index.html (caused by a Worker bug
    // where Pages' 308 `Location: /` redirect leaked past the prefix).
    // The Worker bug is fixed in narenana-website. After verifying users
    // recover, flip `selfDestroying` back to false in a follow-up deploy
    // to re-enable the PWA.
    selfDestroying: true,
    registerType: 'autoUpdate',
    injectRegister: 'auto',
    devOptions: { enabled: false },

    manifest: {
      name: 'EdgeTX Log Viewer',
      short_name: 'EdgeTX',
      description:
        "Drop your transmitter's CSV log and replay the entire flight on a 3D " +
        'globe with synced charts. Works in the browser — your logs never ' +
        'leave your machine.',
      theme_color: '#0e1117',
      background_color: '#0e1117',
      display: 'standalone',
      start_url: '.',
      scope: '.',
      orientation: 'any',
      // Primary icon is the narenana brand mark (200x200 JPEG from the YouTube
      // channel). The SVG paper-plane stays as a secondary entry for renderers
      // that prefer vector or maskable. iOS install also picks up the
      // apple-touch-icon <link> in index.html.
      icons: [
        {
          src: 'narenana.jpg',
          sizes: '200x200',
          type: 'image/jpeg',
          purpose: 'any',
        },
        {
          src: 'favicon.svg',
          sizes: 'any',
          type: 'image/svg+xml',
          purpose: 'maskable',
        },
      ],
    },

    workbox: {
      // App shell + sample log. CSV included so the demo button works offline.
      // Exclude /cesium/* — Cesium.js alone is 5.84 MB and would force every
      // visitor to precache it before ever opening the globe. We lazy-cache
      // it via runtimeCaching below.
      globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,csv}'],
      globIgnores: ['cesium/**/*'],
      maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,

      // Cesium runtime gets CacheFirst — first globe open downloads, every
      // subsequent open serves from cache. 30-day expiration.
      runtimeCaching: [
        {
          urlPattern: ({ url }) => url.pathname.includes('/cesium/'),
          handler: 'CacheFirst',
          options: {
            cacheName: 'cesium-runtime',
            expiration: {
              maxEntries: 200,
              maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
            },
          },
        },
      ],
    },
  })

  return {
    // wasm + topLevelAwait teach Vite/Rollup to handle the ESM-style WASM
    // import that `wasm-pack build --target bundler` emits — needed by
    // `@narenana/blackbox-parser`. Order matters: wasm before topLevelAwait.
    plugins: [react(), wasm(), topLevelAwait(), cesium(), ...(isDesktop ? [] : [pwa])],
    // Vite worker contexts use a separate plugin pipeline. The blackbox
    // parser worker needs the same WASM glue, so re-register both
    // plugins here. Without this the worker build fails with the
    // "ESM integration proposal for Wasm" error.
    worker: {
      format: 'es',
      plugins: () => [wasm(), topLevelAwait()],
    },
    base: './',
    // Desktop builds need a stub for `virtual:pwa-register/react` since the
    // PWA plugin isn't active. PwaUpdate.jsx imports it statically; the stub
    // satisfies Vite's resolve without changing runtime behaviour (the
    // component is never mounted on desktop).
    resolve: isDesktop
      ? {
          alias: {
            'virtual:pwa-register/react': new URL(
              './src/utils/pwa-stub.js',
              import.meta.url,
            ).pathname,
          },
        }
      : {},
    server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
    build: { outDir: 'dist' },
  }
})
