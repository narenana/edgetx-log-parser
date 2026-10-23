import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isChunkLoadError, claimReloadGuard } from './lazyWithReload'

describe('isChunkLoadError', () => {
  it('matches dynamic-import / chunk load failures across browsers', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module: /assets/Dashboard-x.js'))).toBe(true) // Vite/Firefox
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: x'))).toBe(true) // Chrome
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true) // Safari
    expect(isChunkLoadError(new Error('Loading chunk 5 failed'))).toBe(true)
  })
  it('does NOT match unrelated errors (so only real stale-chunk failures reload)', () => {
    expect(isChunkLoadError(new Error('x is not a function'))).toBe(false)
    expect(isChunkLoadError(new Error('Header parse error: MissingHeader'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('claimReloadGuard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('allows a reload exactly once, then refuses — no reload loop', () => {
    const store = {}
    vi.stubGlobal('sessionStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
    expect(claimReloadGuard('chunkReload:dash')).toBe(true)  // first failure → reload
    expect(claimReloadGuard('chunkReload:dash')).toBe(false) // after reload, still failing → give up
  })

  it('refuses when storage throws (unavailable) — never risk a loop', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => {},
    })
    expect(claimReloadGuard('chunkReload:x')).toBe(false)
  })

  it("refuses when the write doesn't persist (silent no-op storage)", () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    expect(claimReloadGuard('chunkReload:y')).toBe(false)
  })
})
