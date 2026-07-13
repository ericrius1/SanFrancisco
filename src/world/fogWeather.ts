import { sfCivilScalarDays, type SfCivilTime } from "./solar.ts"

export type FogWeatherMode = "procedural" | "blend" | "live"

/** Macro weather values consumed by the retained TSL fog graph. */
export type FogWeatherState = {
  bankScale: number
  hazeScale: number
  topOffsetM: number
  billowScale: number
  driftScale: number
  frontX: number
  frontWidthM: number
  frontSkew: number
  macroPhase: number
  inlandFloor: number
  gateReachM: number
  windX: number
  windZ: number
  season: number
  regime: number
  diurnal: number
}

export type LiveFogBias = {
  state: FogWeatherState
  confidence: number
  observedAtMs: number
  decaysAtMs: number
  expiresAtMs: number
  label: string
}

const TAU = Math.PI * 2
const DAY_MS = 24 * 60 * 60 * 1000
const SUMMER_PEAK_DAY = Date.UTC(2025, 6, 24) / DAY_MS
const AUTUMN_CLEAR_DAY = Date.UTC(2025, 9, 1) / DAY_MS

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number) => clamp(v, 0, 1)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth01 = (v: number) => {
  const t = clamp01(v)
  return t * t * (3 - 2 * t)
}
const smoothstep = (a: number, b: number, v: number) => smooth01((v - a) / (b - a))

function hash01(i: number, salt: number): number {
  let x = (Math.trunc(i) ^ Math.imul(salt, 0x9e3779b1)) | 0
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad)
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97)
  return ((x ^ (x >>> 15)) >>> 0) / 0xffffffff
}

/** Quintic value noise: deterministic, continuous, and reverse-scrub safe. */
function valueNoise1D(x: number, salt: number): number {
  const i = Math.floor(x)
  const f = x - i
  const q = f * f * f * (f * (f * 6 - 15) + 10)
  return lerp(hash01(i, salt), hash01(i + 1, salt), q)
}

/**
 * Living SF fallback: multi-day regimes, summer marine season, an early-fall
 * clearing notch, and a daily front that burns back before returning gradually
 * from the Pacific and reaching its nightly maximum near dawn.
 */
export function sampleProceduralFog(civil: SfCivilTime, out?: FogWeatherState): FogWeatherState {
  const day = sfCivilScalarDays(civil)
  const summerWave = (Math.cos(((day - SUMMER_PEAK_DAY) / 365.2425) * TAU) + 1) * 0.5
  const season = clamp01(0.38 + summerWave * 0.62)
  const autumnWave = (Math.cos(((day - AUTUMN_CLEAR_DAY) / 365.2425) * TAU) + 1) * 0.5
  const autumnClear = Math.pow(autumnWave, 6)
  const synoptic =
    valueNoise1D(day / 6.5, 17) * 0.52 +
    valueNoise1D(day / 3.1, 53) * 0.3 +
    valueNoise1D(day / 1.4, 101) * 0.18
  const regime = clamp01(0.09 + season * 0.34 + synoptic * 0.68 - autumnClear * 0.12)

  const dailyTiming = valueNoise1D(day / 2.2, 211)
  const burnStart = lerp(7.1, 9.1, dailyTiming)
  const burnEnd = lerp(10.4, 15.2, regime)
  const returnStart = lerp(16.8, 20.4, 1 - regime)
  const returnEnd = returnStart + lerp(1.6, 3.1, dailyTiming)
  let nightEnvelope = 0
  if (civil.hour < burnStart) {
    const nightT = (civil.hour + 24 - returnEnd) / (24 + 5.5 - returnEnd)
    nightEnvelope = lerp(0.84, 1, smooth01(nightT))
  } else if (civil.hour < burnEnd) {
    nightEnvelope = 1 - smoothstep(burnStart, burnEnd, civil.hour)
  } else if (civil.hour >= returnStart && civil.hour < returnEnd) {
    nightEnvelope = smoothstep(returnStart, returnEnd, civil.hour) * 0.84
  } else if (civil.hour >= returnEnd) {
    const nightT = (civil.hour - returnEnd) / (24 + 5.5 - returnEnd)
    nightEnvelope = lerp(0.84, 1, smooth01(nightT))
  }
  const middayFloor = lerp(0.04, 0.45, smoothstep(0.56, 0.94, regime))
  const diurnal = lerp(middayFloor, 1, nightEnvelope)

  const coverage = clamp01(0.06 + regime * (0.34 + 0.66 * diurnal))
  const patchiness = valueNoise1D(day / 1.8, 307)
  const windAngle = lerp(-0.4, 0.4, valueNoise1D(day / 2.7, 401))
  const windSpeed = lerp(0.35, 1.2, valueNoise1D(day / 1.1, 443))

  const state = out ?? ({} as FogWeatherState)
  state.bankScale = lerp(0.3, 1.22, clamp01(regime * (0.5 + diurnal * 0.5)))
  state.hazeScale = lerp(0.68, 1.08, clamp01(regime * 0.62 + diurnal * 0.18))
  state.topOffsetM = lerp(-55, 50, coverage)
  state.billowScale = lerp(1.28, 0.78, coverage) * lerp(0.9, 1.1, patchiness)
  state.driftScale = lerp(0.68, 1.18, (windSpeed - 0.35) / 0.85)
  state.frontX = lerp(-5200, 3600, coverage)
  state.frontWidthM = lerp(1750, 760, clamp01(regime * 0.75 + patchiness * 0.25))
  state.frontSkew = lerp(-0.1, 0.16, valueNoise1D(day / 3.8, 487))
  state.macroPhase = valueNoise1D(day / 4.2, 503) * TAU
  state.inlandFloor = lerp(0.05, 0.34, regime * diurnal)
  state.gateReachM = lerp(350, 5200, clamp01(coverage * 1.08))
  state.windX = Math.cos(windAngle) * windSpeed
  state.windZ = Math.sin(windAngle) * windSpeed
  state.season = season
  state.regime = regime
  state.diurnal = diurnal
  return state
}

/** CPU twin of the shader's stable west-to-east front and Golden Gate tongue. */
export function fogCoverageAt(state: FogWeatherState, x: number, z: number): number {
  const meander = Math.sin(z * 0.00072 + state.macroPhase) * 430
  const coord = x + z * state.frontSkew + meander
  const pacific = 1 - smoothstep(
    state.frontX - state.frontWidthM,
    state.frontX + state.frontWidthM,
    coord
  )

  const gateAlong = x + 3000
  const gateAcross = z + 2700 - gateAlong * 0.12
  const along = smoothstep(-300, 450, gateAlong) *
    (1 - smoothstep(state.gateReachM, state.gateReachM + 900, gateAlong))
  const across = 1 - smoothstep(350, 1350, Math.abs(gateAcross))
  const gate = along * across
  return lerp(state.inlandFloor, 1, 1 - (1 - pacific) * (1 - gate))
}

/** Last-good live influence is flat through decaysAt, then reaches zero at expiry. */
export function liveFogFreshness(bias: LiveFogBias, nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 0
  return 1 - smoothstep(bias.decaysAtMs, bias.expiresAtMs, nowMs)
}

function logLerp(a: number, b: number, t: number): number {
  return Math.exp(lerp(Math.log(Math.max(0.0001, a)), Math.log(Math.max(0.0001, b)), t))
}

export function blendFogWeather(
  a: FogWeatherState,
  b: FogWeatherState,
  t: number,
  out?: FogWeatherState
): FogWeatherState {
  const w = clamp01(t)
  const state = out ?? ({} as FogWeatherState)
  state.bankScale = logLerp(a.bankScale, b.bankScale, w)
  state.hazeScale = logLerp(a.hazeScale, b.hazeScale, w)
  state.topOffsetM = lerp(a.topOffsetM, b.topOffsetM, w)
  state.billowScale = logLerp(a.billowScale, b.billowScale, w)
  state.driftScale = logLerp(a.driftScale, b.driftScale, w)
  state.frontX = lerp(a.frontX, b.frontX, w)
  state.frontWidthM = lerp(a.frontWidthM, b.frontWidthM, w)
  state.frontSkew = lerp(a.frontSkew, b.frontSkew, w)
  const phaseDelta = ((b.macroPhase - a.macroPhase + Math.PI * 3) % TAU) - Math.PI
  state.macroPhase = (a.macroPhase + phaseDelta * w + TAU) % TAU
  state.inlandFloor = lerp(a.inlandFloor, b.inlandFloor, w)
  state.gateReachM = lerp(a.gateReachM, b.gateReachM, w)
  state.windX = lerp(a.windX, b.windX, w)
  state.windZ = lerp(a.windZ, b.windZ, w)
  state.season = lerp(a.season, b.season, w)
  state.regime = lerp(a.regime, b.regime, w)
  state.diurnal = lerp(a.diurnal, b.diurnal, w)
  return state
}

export function effectiveLiveWeight(
  mode: FogWeatherMode,
  requestedInfluence: number,
  realTime: boolean,
  bias: LiveFogBias | null,
  nowMs: number
): number {
  if (!realTime || mode === "procedural" || !bias) return 0
  const modeWeight = mode === "live" ? 1 : clamp01(requestedInfluence)
  return modeWeight * bias.confidence * liveFogFreshness(bias, nowMs)
}
