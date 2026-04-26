/**
 * Compile-time stub for `virtual:pwa-register/react` used by desktop builds.
 *
 * vite-plugin-pwa registers `virtual:pwa-register/react` as a Vite virtual
 * module. When the plugin is disabled (desktop build), that import would
 * fail to resolve. PwaUpdate.jsx is never actually mounted on desktop —
 * App.jsx gates it behind `VITE_BUILD_TARGET === 'web'` — but Vite still
 * has to resolve the import at build time. This stub satisfies the resolve
 * with a hook that does nothing.
 */
export function useRegisterSW() {
  return {
    needRefresh: [false, () => {}],
    offlineReady: [false, () => {}],
    updateServiceWorker: () => {},
  }
}
