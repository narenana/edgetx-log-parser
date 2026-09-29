import { describe, it, expect } from 'vitest'
import { friendlyErrorMessage } from './parseBlackbox'

// The raw strings are the exact error texts the vendored Rust parser gave
// on 2026-09-29 for real iNAV logs with patched firmware headers.
describe('friendlyErrorMessage', () => {
  it('names iNAV 9.x as the iNAV ceiling', () => {
    const msg = friendlyErrorMessage(
      'Header parse error: UnsupportedFirmwareVersion(Inav(FirmwareVersion { major: 10, minor: 0, patch: 0 }))',
    )
    expect(msg).toMatch(/^iNAV 10\.0\.0 isn't supported/)
    expect(msg).toContain('latest supported: 9.x')
  })

  it('names Betaflight 4.5.x as the Betaflight ceiling', () => {
    const msg = friendlyErrorMessage(
      'Header parse error: UnsupportedFirmwareVersion(Betaflight(FirmwareVersion { major: 4, minor: 6, patch: 0 }))',
    )
    expect(msg).toMatch(/^Betaflight 4\.6\.0 isn't supported/)
    expect(msg).toContain('latest supported: 4.5.x')
  })

  it('explains date-versioned Betaflight (2025.12+) instead of dumping the enum', () => {
    const msg = friendlyErrorMessage(
      'Header parse error: InvalidFirmware("Betaflight 2025.12.1 (a7932b92) SPEEDYBEEF405WING")',
    )
    expect(msg).toMatch(/^Betaflight 2025\.12\.1 isn't supported/)
    expect(msg).toContain('latest supported: 4.5.x')
  })

  it('passes other errors through unchanged', () => {
    const raw = 'Header parse error: MalformedFrameDef(Intra)'
    expect(friendlyErrorMessage(raw)).toBe(raw)
  })
})
