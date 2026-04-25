import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'

// Dual-target build:
//   VITE_BUILD_TARGET=web      → hosted (Cloudflare Pages, mounted at /log-viewer/
//                                via a path-stripping Worker — see ../website/)
//   VITE_BUILD_TARGET=desktop  → packaged for Electron, file:// loads
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
export default defineConfig({
  plugins: [react(), cesium()],
  base: './',
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
  build: { outDir: 'dist' },
})
