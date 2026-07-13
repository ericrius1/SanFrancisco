import type { FogWeatherState, LiveFogBias } from "./fogWeather"

export type FogStationReading = {
  role: "coast" | "southBay" | "eastBay"
  id: string
  observedAt: string | null
  visibilityM: number | null
  temperatureC: number | null
  dewpointC: number | null
  windFromDeg: number | null
  windSpeedMps: number | null
  weather: string | null
  clouds: { cover: string; baseM: number | null }[]
}

export type FogGridReading = {
  role: "west" | "center" | "bay"
  issuedAt: string | null
  validAt: string | null
  visibilityM: number | null
  ceilingM: number | null
  humidityPct: number | null
  skyCoverPct: number | null
  windFromDeg: number | null
  windSpeedMps: number | null
}

export type LiveFogPayload = {
  version: 1
  generatedAt: string
  stale?: boolean
  sources: Record<string, { ok: boolean; fetchedAt?: string; detail?: string }>
  stations: FogStationReading[]
  grid: FogGridReading[]
  satellite?: {
    available: boolean
    detail: string
    product?: string
  }
}

const TAU = Math.PI * 2
const MINUTE_MS = 60 * 1000
const STATION_FULL_MINUTES = 20
const STATION_EXPIRE_MINUTES = 90
const GRID_FULL_MINUTES = 90
const GRID_EXPIRE_MINUTES = 6 * 60
const LAST_GOOD_FULL_MINUTES = 10
const LAST_GOOD_EXPIRE_MINUTES = 90

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number) => clamp(v, 0, 1)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth01 = (v: number) => {
  const t = clamp01(v)
  return t * t * (3 - 2 * t)
}
const smoothstep = (a: number, b: number, v: number) => smooth01((v - a) / (b - a))

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const visibilityFog = (metres: number | null) =>
  metres === null ? null : 1 - smoothstep(900, 16000, metres)
const humidityFog = (pct: number | null) =>
  pct === null ? null : smoothstep(78, 99, pct)
const ceilingFog = (metres: number | null) =>
  metres === null || metres <= 0 ? null : 1 - smoothstep(180, 1500, metres)

function parsedTime(value: string | null | undefined): number | null {
  const parsed = Date.parse(value ?? "")
  return Number.isFinite(parsed) ? parsed : null
}

function timedFreshness(
  observedAtMs: number,
  nowMs: number,
  fullMinutes: number,
  expireMinutes: number
): number {
  const ageMinutes = Math.max(0, (nowMs - observedAtMs) / MINUTE_MS)
  return 1 - smoothstep(fullMinutes, expireMinutes, ageMinutes)
}

type WeatherSignal = {
  surface: number
  coverage: number
  freshness: number
  observedAtMs: number
}

function weatherTokenStrength(weather: string | null): number {
  const tokens = (weather ?? "").toUpperCase().split(/\s+/).filter(Boolean)
  if (tokens.some((token) => /^(?:[+-]|VC)?(?:MI|BC|PR|DR|BL|SH|TS|FZ)?FG$/.test(token))) return 1
  if (tokens.some((token) => /^(?:[+-])?BR$/.test(token))) return 0.68
  return 0
}

function stationSignal(station: FogStationReading | undefined, nowMs: number): WeatherSignal | null {
  if (!station) return null
  const observedAtMs = parsedTime(station.observedAt)
  if (observedAtMs === null) return null
  const freshness = timedFreshness(
    observedAtMs,
    nowMs,
    STATION_FULL_MINUTES,
    STATION_EXPIRE_MINUTES
  )
  if (freshness <= 0) return null
  const vis = visibilityFog(finiteOrNull(station.visibilityM))
  const spread = station.temperatureC === null || station.dewpointC === null
    ? null
    : 1 - smoothstep(0.7, 6.5, Math.max(0, station.temperatureC - station.dewpointC))
  const explicit = weatherTokenStrength(station.weather)
  let lowestCloud: number | null = null
  for (const cloud of station.clouds) {
    if (!/BKN|OVC|VV/i.test(cloud.cover) || cloud.baseM === null || cloud.baseM <= 0) continue
    lowestCloud = lowestCloud === null ? cloud.baseM : Math.min(lowestCloud, cloud.baseM)
  }
  const lowCloud = ceilingFog(lowestCloud)
  const surface = clamp01(Math.max(explicit, vis ?? 0, (spread ?? 0) * 0.2))
  const coverage = clamp01(Math.max(surface, (spread ?? 0) * 0.55, (lowCloud ?? 0) * 0.7))
  return { surface, coverage, freshness, observedAtMs }
}

function gridSignal(grid: FogGridReading | undefined, nowMs: number): WeatherSignal | null {
  if (!grid) return null
  // Forecast values can be valid across long intervals; age from issuance.
  const observedAtMs = parsedTime(grid.issuedAt) ?? parsedTime(grid.validAt)
  if (observedAtMs === null) return null
  const freshness = timedFreshness(
    observedAtMs,
    nowMs,
    GRID_FULL_MINUTES,
    GRID_EXPIRE_MINUTES
  )
  if (freshness <= 0) return null
  const vis = visibilityFog(finiteOrNull(grid.visibilityM))
  const humidity = humidityFog(finiteOrNull(grid.humidityPct))
  const ceiling = ceilingFog(finiteOrNull(grid.ceilingM))
  const lowCloud = ceiling === null || grid.skyCoverPct === null
    ? ceiling
    : ceiling * smoothstep(35, 90, grid.skyCoverPct)
  // Excellent visibility plus low overcast is a layer aloft, not street fog.
  const surface = clamp01(vis ?? 0)
  const coverage = clamp01(
    (vis ?? 0) * 0.45 + (humidity ?? 0) * 0.2 + (lowCloud ?? 0) * 0.35
  )
  return {
    surface,
    coverage: Math.max(surface, coverage),
    freshness,
    observedAtMs
  }
}

type RoleSignal = WeatherSignal & { confidence: number }

function roleSignal(
  payload: LiveFogPayload,
  stationRole: FogStationReading["role"],
  gridRole: FogGridReading["role"],
  nowMs: number
): RoleSignal | null {
  const station = stationSignal(payload.stations.find((s) => s.role === stationRole), nowMs)
  const grid = gridSignal(payload.grid.find((g) => g.role === gridRole), nowMs)
  const parts = [
    station ? { signal: station, base: 0.68 } : null,
    grid ? { signal: grid, base: 0.32 } : null
  ].filter((part): part is { signal: WeatherSignal; base: number } => part !== null)
  if (!parts.length) return null
  const weights = parts.map(({ signal, base }) => signal.freshness * base)
  const total = weights.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  return {
    surface: parts.reduce((sum, part, i) => sum + part.signal.surface * weights[i], 0) / total,
    coverage: parts.reduce((sum, part, i) => sum + part.signal.coverage * weights[i], 0) / total,
    freshness: clamp01(total),
    confidence: clamp01(total),
    observedAtMs: Math.max(...parts.map(({ signal }) => signal.observedAtMs))
  }
}

function meanWind(payload: LiveFogPayload, nowMs: number): { x: number; z: number; speed: number } {
  let x = 0
  let z = 0
  let total = 0
  const add = (
    reading: Pick<FogStationReading, "windFromDeg" | "windSpeedMps">,
    freshness: number,
    base: number
  ) => {
    const from = finiteOrNull(reading.windFromDeg)
    const speed = finiteOrNull(reading.windSpeedMps)
    const weight = freshness * base
    if (from === null || speed === null || weight <= 0) return
    const r = (from * Math.PI) / 180
    x += -Math.sin(r) * speed * weight
    z += Math.cos(r) * speed * weight
    total += weight
  }
  for (const reading of payload.stations) {
    const signal = stationSignal(reading, nowMs)
    if (signal) add(reading, signal.freshness, 0.68)
  }
  for (const reading of payload.grid) {
    const signal = gridSignal(reading, nowMs)
    if (signal) add(reading, signal.freshness, 0.32)
  }
  if (!total) return { x: 0.45, z: 0, speed: 0.45 }
  x /= total
  z /= total
  return { x, z, speed: Math.hypot(x, z) }
}

/** Convert normalized provider data into the renderer's authored macro controls. */
export function normalizeLiveFog(payload: LiveFogPayload, nowMs = Date.now()): LiveFogBias | null {
  if (
    !payload ||
    payload.version !== 1 ||
    !Array.isArray(payload.stations) ||
    !Array.isArray(payload.grid)
  ) return null
  const coast = roleSignal(payload, "coast", "west", nowMs)
  const center = roleSignal(payload, "southBay", "center", nowMs)
  const bay = roleSignal(payload, "eastBay", "bay", nowMs)
  const present = [coast, center, bay].filter((v): v is RoleSignal => v !== null)
  if (!present.length) return null

  const c = coast ?? present[0]
  const m = center ?? c
  const b = bay ?? m
  const coverage = clamp01(0.05 + c.coverage * 0.45 + m.coverage * 0.32 + b.coverage * 0.23)
  const density = clamp01(Math.max(c.surface * 0.8, m.surface * 0.92, b.surface))
  const wind = meanWind(payload, nowMs)
  const confidence = clamp01(present.reduce((sum, signal) => sum + signal.confidence, 0) / 3)
  const observedAtMs = Math.max(...present.map((signal) => signal.observedAtMs))

  const state: FogWeatherState = {
    bankScale: lerp(0.3, 1.24, density),
    hazeScale: lerp(0.66, 1.12, clamp01(density * 0.76 + coverage * 0.24)),
    topOffsetM: lerp(-50, 55, coverage),
    billowScale: lerp(1.3, 0.8, coverage),
    driftScale: clamp(0.66 + wind.speed * 0.075, 0.66, 1.3),
    frontX: lerp(-5400, 3900, coverage),
    frontWidthM: lerp(1750, 720, density),
    frontSkew: lerp(-0.08, 0.12, clamp01((c.coverage - b.coverage + 1) * 0.5)),
    macroPhase: clamp01((c.coverage - b.coverage + 1) * 0.5) * TAU,
    inlandFloor: lerp(0.04, 0.38, density * coverage),
    gateReachM: lerp(300, 5600, clamp01(m.coverage * 0.55 + b.coverage * 0.45)),
    windX: wind.x,
    windZ: wind.z,
    season: 1,
    regime: density,
    diurnal: coverage
  }
  return {
    state,
    confidence,
    observedAtMs,
    // Per-reading age is already in state/confidence. This second envelope is
    // time since the client last accepted a usable aggregate, for outage fade.
    decaysAtMs: nowMs + LAST_GOOD_FULL_MINUTES * MINUTE_MS,
    expiresAtMs: nowMs + LAST_GOOD_EXPIRE_MINUTES * MINUTE_MS,
    label: `METAR + NWS · coast ${Math.round(c.coverage * 100)}% · city ${Math.round(m.coverage * 100)}% · bay ${Math.round(b.coverage * 100)}%`
  }
}
