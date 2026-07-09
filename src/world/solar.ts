/**
 * Astronomical sun position for San Francisco.
 *
 * World frame matches the city pipeline (tools/geo.mjs): +X east, +Y up, -Z north.
 * Algorithm is the NOAA Solar Calculator / Michalsky SPA (accurate to ~0.01°),
 * enough for lighting and seasonal path without shipping an ephemeris table.
 */

/** City origin — same pin as tools/geo.mjs ORIGIN. */
export const SF_LAT = 37.79
export const SF_LON = -122.444

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

export type SfCivilTime = {
  year: number
  month: number // 1..12
  day: number
  /** Decimal hours in America/Los_Angeles (0..24). */
  hour: number
}

export type SolarPosition = {
  /** Degrees above the horizon (negative = below). */
  elevation: number
  /** Degrees clockwise from true north (0=N, 90=E, 180=S, 270=W). */
  azimuth: number
  /** Unit vector pointing toward the sun in world space. */
  x: number
  y: number
  z: number
}

const SF_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
})

/** Current civil date+time in San Francisco. */
export function sanFranciscoCivilNow(at = new Date()): SfCivilTime {
  let year = 1970,
    month = 1,
    day = 1,
    h = 0,
    m = 0,
    s = 0
  for (const p of SF_PARTS_FMT.formatToParts(at)) {
    if (p.type === "year") year = +p.value
    else if (p.type === "month") month = +p.value
    else if (p.type === "day") day = +p.value
    else if (p.type === "hour") h = +p.value
    else if (p.type === "minute") m = +p.value
    else if (p.type === "second") s = +p.value
  }
  return { year, month, day, hour: (h % 24) + m / 60 + s / 3600 }
}

/** Decimal SF hours only (0..24) — kept for HUD / scrub callers. */
export function sanFranciscoTimeOfDay(at = new Date()): number {
  return sanFranciscoCivilNow(at).hour
}

/**
 * Convert SF civil wall time → UTC milliseconds.
 * Iterates once off a UTC guess so DST (PST/PDT) is handled by Intl.
 */
export function sfCivilToUtcMs(civil: SfCivilTime): number {
  const h = Math.floor(civil.hour)
  const minF = (civil.hour - h) * 60
  const min = Math.floor(minF)
  const sec = (minF - min) * 60
  // Pacific is UTC−7/−8; start near UTC−8 then correct from what LA actually shows.
  let utc = Date.UTC(civil.year, civil.month - 1, civil.day, h + 8, min, sec)
  for (let i = 0; i < 3; i++) {
    const shown = sanFranciscoCivilNow(new Date(utc))
    const wantDay = civil.year * 10000 + civil.month * 100 + civil.day
    const gotDay = shown.year * 10000 + shown.month * 100 + shown.day
    const daySkew = wantDay - gotDay // −1 / 0 / +1 in practice
    const hourSkew = civil.hour - shown.hour + daySkew * 24
    if (Math.abs(hourSkew) < 1 / 3600) break
    utc += hourSkew * 3600 * 1000
  }
  return utc
}

/** Julian centuries since J2000.0 from a UTC unix ms timestamp. */
function julianCenturies(utcMs: number): number {
  const jd = utcMs / 86400000 + 2440587.5
  return (jd - 2451545) / 36525
}

/**
 * Sun direction / elevation / azimuth for a San-Francisco civil instant.
 * Declination tracks the day-of-year, so winter noon sits much lower than summer.
 */
export function solarPosition(civil: SfCivilTime, lat = SF_LAT, lon = SF_LON): SolarPosition {
  const utcMs = sfCivilToUtcMs(civil)
  const T = julianCenturies(utcMs)

  // Pacific UTC offset (hours, e.g. −7 PDT / −8 PST) from the civil→UTC solve
  const h = Math.floor(civil.hour)
  const minF = (civil.hour - h) * 60
  const min = Math.floor(minF)
  const sec = (minF - min) * 60
  const localAsUtc = Date.UTC(civil.year, civil.month - 1, civil.day, h, min, sec)
  const tzHours = (localAsUtc - utcMs) / 3600000

  // Geometric mean longitude & anomaly of the sun (degrees)
  let L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
  if (L0 < 0) L0 += 360
  const M = 357.52911 + T * (35999.05029 - T * 0.0001537)
  const Mr = M * DEG

  // Equation of center, true & apparent longitude
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + T * 0.000014)) +
    Math.sin(2 * Mr) * (0.019993 - T * 0.000101) +
    Math.sin(3 * Mr) * 0.000289
  const trueLong = L0 + C
  const omega = 125.04 - 1934.136 * T
  const lambda = (trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG)) * DEG

  // Obliquity of the ecliptic
  const eps0 =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
  const eps = (eps0 + 0.00256 * Math.cos(omega * DEG)) * DEG

  // Declination
  const sinDec = Math.sin(eps) * Math.sin(lambda)
  const dec = Math.asin(sinDec)

  // Equation of time (minutes) → true solar time (NOAA: local + EoT + 4·lon − 60·tz)
  const eotY = Math.tan(eps / 2) ** 2
  const L0r = L0 * DEG
  const eqTime =
    4 *
    RAD *
    (eotY * Math.sin(2 * L0r) -
      2 * 0.016708634 * Math.sin(Mr) +
      4 * 0.016708634 * eotY * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * eotY * eotY * Math.sin(4 * L0r) -
      1.25 * 0.016708634 * 0.016708634 * Math.sin(2 * Mr))

  const trueSolarMin =
    (((civil.hour * 60 + eqTime + 4 * lon - 60 * tzHours) % 1440) + 1440) % 1440
  let hourAngle = trueSolarMin / 4 - 180 // degrees
  if (hourAngle < -180) hourAngle += 360
  const ha = hourAngle * DEG

  const latR = lat * DEG
  const cosLat = Math.cos(latR)
  const sinLat = Math.sin(latR)
  const cosDec = Math.cos(dec)

  // Elevation (refraction-corrected near the horizon, NOAA formula)
  const sinEl = sinLat * sinDec + cosLat * cosDec * Math.cos(ha)
  let elev = Math.asin(Math.min(1, Math.max(-1, sinEl))) * RAD
  const refr =
    elev > -0.575
      ? 1.029 / Math.tan((elev + 10.3 / (elev + 5.11)) * DEG) / 60
      : 0
  elev += refr

  // Azimuth clockwise from north
  const az =
    (Math.atan2(Math.sin(ha), Math.cos(ha) * sinLat - Math.tan(dec) * cosLat) * RAD +
      180) %
    360

  // World direction: +X east, +Y up, -Z north
  const elR = elev * DEG
  const azR = az * DEG
  const cosEl = Math.cos(elR)
  const dirX = Math.sin(azR) * cosEl
  const dirY = Math.sin(elR)
  const dirZ = -Math.cos(azR) * cosEl
  const len = Math.hypot(dirX, dirY, dirZ) || 1

  return { elevation: elev, azimuth: az, x: dirX / len, y: dirY / len, z: dirZ / len }
}
