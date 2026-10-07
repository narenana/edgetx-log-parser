// Sun time for the 3D globe.
//
// The globe is lit by Cesium's sun, whose position comes from the scene
// clock. Pinning one UTC instant (the viewer used 2024-09-15T21:30Z) gives
// a mid-afternoon sun only near the longitude it was picked for, the
// Grand Canyon demo flight; over India or Australia the same instant is
// the middle of the night, so the sky renders black and the terrain dark.
//
// Instead: the same mid-September day, at a fixed LOCAL SOLAR hour for the
// flight's longitude. Mid-September sits on the equinox, so at 14:00 solar
// the sun is well up at every latitude pilots fly, north or south. For the
// demo flight (lon -112.1) this lands within two minutes of the old pin.

const SUN_DAY_UTC_MS = Date.UTC(2024, 8, 15) // 2024-09-15T00:00Z
export const SUN_SOLAR_HOUR = 14

export function afternoonSunDate(lonDeg, solarHour = SUN_SOLAR_HOUR) {
  const lon = Number.isFinite(lonDeg) ? ((((lonDeg + 180) % 360) + 360) % 360) - 180 : 0
  // Local solar time = UTC + lon / 15 h.
  return new Date(SUN_DAY_UTC_MS + (solarHour - lon / 15) * 3600 * 1000)
}
