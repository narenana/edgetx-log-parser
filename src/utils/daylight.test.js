import { describe, it, expect } from 'vitest'
import { afternoonSunDate, SUN_SOLAR_HOUR } from './daylight'

// Rough solar elevation (deg) — declination + hour angle, no equation of
// time. Plenty to tell day from night.
function sunElevationDeg(date, latDeg, lonDeg) {
  const D2R = Math.PI / 180
  const day = (date - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5
  const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (day + 10)) * D2R
  const solarHour = (date.getUTCHours() + date.getUTCMinutes() / 60 + lonDeg / 15 + 24) % 24
  const ha = (solarHour - 12) * 15 * D2R
  const lat = latDeg * D2R
  return Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha)) / D2R
}

describe('afternoonSunDate', () => {
  it('matches the old pinned instant for the Grand Canyon demo flight', () => {
    const d = afternoonSunDate(-112.1083)
    const old = Date.parse('2024-09-15T21:30:00Z')
    expect(Math.abs(d - old)).toBeLessThan(3 * 60 * 1000)
  })

  it('is local afternoon at any longitude', () => {
    for (const lon of [-179.9, -122.4, -0.1, 0, 2.35, 77.59, 151.2, 179.9, 200, -540]) {
      const d = afternoonSunDate(lon)
      const norm = ((((lon + 180) % 360) + 360) % 360) - 180
      const solar = (d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600 + norm / 15 + 48) % 24
      expect(solar).toBeCloseTo(SUN_SOLAR_HOUR, 2) // Date keeps whole ms
    }
  })

  it('puts the sun well up where pilots fly (the old pin was night outside the Americas)', () => {
    const fields = [
      [36.06, -112.11], // demo flight
      [12.97, 77.59], // Bengaluru
      [51.5, -0.12], // London
      [-33.87, 151.21], // Sydney
      [59.9, 10.75], // Oslo
      [-45.0, 170.5], // Otago
    ]
    for (const [lat, lon] of fields) {
      expect(sunElevationDeg(afternoonSunDate(lon), lat, lon)).toBeGreaterThan(25)
    }
    // The bug this replaces: one fixed UTC instant is night in India.
    expect(sunElevationDeg(new Date('2024-09-15T21:30:00Z'), 12.97, 77.59)).toBeLessThan(0)
  })

  it('falls back to Greenwich for a missing longitude', () => {
    expect(afternoonSunDate(undefined).toISOString()).toBe('2024-09-15T14:00:00.000Z')
    expect(afternoonSunDate(NaN).toISOString()).toBe('2024-09-15T14:00:00.000Z')
  })
})
