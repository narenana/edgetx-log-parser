import { describe, it, expect } from 'vitest'
import { classifyCraft, flightDynamics, CRAFT_T } from './craft.js'

// Build a flight: a few on-ground rows at `base` altitude, then `n` aloft
// rows produced by `aloft(i)`. Altitude baselines to the min, so passing a
// large `base` also exercises the MSL case.
function flight(base, n, aloft) {
  const rows = []
  for (let i = 0; i < 5; i++) rows.push({ 'Alt(m)': base, 'GSpd(kmh)': 0, 'Roll(rad)': 0 })
  for (let i = 0; i < n; i++) rows.push(aloft(i))
  return rows
}
const ctx = (rows, meta = {}) => ({ rows, meta })

describe('flightDynamics', () => {
  it('detects aloft relative to the flight min altitude (MSL-safe)', () => {
    const rows = flight(1500, 40, () => ({ 'Alt(m)': 1540, 'GSpd(kmh)': 50, 'Roll(rad)': 0 }))
    const d = flightDynamics(rows)
    expect(d.airborneN).toBe(40)
    expect(d.p25Kmh).toBe(50)
    expect(d.hoverFrac).toBe(0)
  })

  it('is empty-safe', () => {
    expect(flightDynamics([]).airborneN).toBe(0)
    expect(flightDynamics(null).airborneN).toBe(0)
    expect(flightDynamics([{ foo: 1 }]).airborneN).toBe(0)
  })
})

describe('classifyCraft', () => {
  it('WING board target wins outright', () => {
    // Even with hovering dynamics, an explicit wing board is a wing.
    const rows = flight(0, 40, () => ({ 'Alt(m)': 20, 'GSpd(kmh)': 0, 'Roll(rad)': 0 }))
    expect(classifyCraft(ctx(rows, { firmwareFamily: 'INAV', target: 'SPEEDYBEEF405WING' }))).toBe('wing')
  })

  it('hovering → quad (a plane cannot hover)', () => {
    const rows = flight(0, 60, i => ({ 'Alt(m)': 25, 'GSpd(kmh)': i % 3 === 0 ? 2 : 10, 'Roll(rad)': 0 }))
    expect(classifyCraft(ctx(rows, {}))).toBe('quad')
  })

  it('sustained inversion → quad (no GPS, attitude only)', () => {
    const rows = flight(0, 50, i => ({ 'Alt(m)': 30, 'GSpd(kmh)': null, 'Roll(rad)': i % 8 === 0 ? 3.0 : 0.1 }))
    expect(classifyCraft(ctx(rows, {}))).toBe('quad')
  })

  it('Betaflight firmware ⇒ quad even with no usable dynamics', () => {
    // All on-ground (never aloft) → dynamics inconclusive; firmware decides.
    const rows = flight(0, 0, () => ({}))
    expect(classifyCraft(ctx(rows, { firmwareFamily: 'Betaflight', target: 'SPEEDYBEEF405' }))).toBe('quad')
  })

  it('EmuFlight ⇒ quad', () => {
    expect(classifyCraft(ctx([], { firmwareFamily: 'EmuFlight' }))).toBe('quad')
  })

  it('iNav cruising, never hovering, real airspeed ⇒ wing', () => {
    const rows = flight(0, 60, i => ({ 'Alt(m)': 40, 'GSpd(kmh)': 45 + (i % 10), 'Roll(rad)': 0.3 }))
    expect(classifyCraft(ctx(rows, { firmwareFamily: 'INAV', target: 'MATEKF405' }))).toBe('wing')
  })

  it('iNav hovering ⇒ quad (firmware gives iNav no prior)', () => {
    const rows = flight(0, 60, i => ({ 'Alt(m)': 20, 'GSpd(kmh)': i % 2 ? 3 : 8, 'Roll(rad)': 0 }))
    expect(classifyCraft(ctx(rows, { firmwareFamily: 'INAV', target: 'MATEKF405' }))).toBe('quad')
  })

  it('ambiguous slow cruise, no firmware ⇒ unknown (honest)', () => {
    // 10–20 km/h: not hovering, not real flying speed; no firmware, no target.
    const rows = flight(0, 40, i => ({ 'Alt(m)': 25, 'GSpd(kmh)': 10 + (i % 8), 'Roll(rad)': 0.2 }))
    expect(classifyCraft(ctx(rows, {}))).toBe('unknown')
  })

  it('too short to tell ⇒ unknown', () => {
    const rows = flight(0, 5, () => ({ 'Alt(m)': 30, 'GSpd(kmh)': 50, 'Roll(rad)': 0 }))
    expect(classifyCraft(ctx(rows, {}))).toBe('unknown')
  })

  it('never throws on junk input', () => {
    expect(classifyCraft(undefined)).toBe('unknown')
    expect(classifyCraft({})).toBe('unknown')
    expect(classifyCraft({ rows: null, meta: null })).toBe('unknown')
  })
})
