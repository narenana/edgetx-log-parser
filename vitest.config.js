import { defineConfig } from 'vitest/config'

/**
 * Standalone test config — intentionally does NOT extend vite.config.js.
 * The app config loads cesium(), VitePWA, wasm() and the Sentry plugin,
 * none of which the current unit tests need; keeping the test pipeline
 * plugin-free makes runs fast and hermetic. When component tests arrive,
 * add `@vitejs/plugin-react` here and set `environment: 'jsdom'` (or
 * per-file via `// @vitest-environment jsdom`).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
})
