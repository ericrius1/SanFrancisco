import type { FogWeatherState } from "./fogWeather.ts"

/** Physical constants shared by the CPU-side resolver and the TSL fog graph. */
export const FOG_EXTINCTION_LENGTH_M = 160
export const FOG_EDGE_START_FRACTION = 0.88
export const FOG_EDGE_END_FRACTION = 0.98
export const FOG_TOP_VARIATION_M = 22

export type FogControlValues = {
  fogEnabled: boolean
  fogMaster: number
  fogTop: number
  fogBank: number
  fogNoise: number
  fogDrift: number
  fog: number
}

export type ResolvedFogParameters = {
  weatherEnabled: boolean
  masterDensity: number
  layerTopM: number
  bankDensity: number
  localDensity: number
  billowScale: number
  motionRate: number
  windX: number
  windZ: number
  hazeDensityPerM: number
  edgeStartM: number
  edgeEndM: number
  /** Maximum weather opacity expected at the streamed edge. */
  farWeatherOpacity: number
}

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback
const nonNegative = (value: number) => Math.max(0, finite(value))
const clamp01 = (value: number) => Math.min(1, Math.max(0, finite(value)))

/** Three's densityFogFactor is exp²: 1 - exp(-(density × distance)²). */
export function distanceHazeOpacity(densityPerM: number, distanceM: number): number {
  const opticalDistance = nonNegative(densityPerM) * nonNegative(distanceM)
  return clamp01(1 - Math.exp(-(opticalDistance * opticalDistance)))
}

/** Distance at which exp² haze reaches 50%; null means the haze is disabled. */
export function distanceHazeHalfOpacityM(densityPerM: number): number | null {
  const density = nonNegative(densityPerM)
  return density > 0 ? Math.sqrt(Math.log(2)) / density : null
}

/** Beer-Lambert opacity through the marine layer at the resolved density. */
export function marineBankOpacity(bankDensity: number, distanceM: number): number {
  return clamp01(1 - Math.exp(
    -(nonNegative(bankDensity) * nonNegative(distanceM)) / FOG_EXTINCTION_LENGTH_M
  ))
}

/**
 * Resolve pane values + living weather into the exact uniforms used by the fog
 * graph. This is deliberately pure so zero/off semantics and displayed units
 * cannot drift away from the renderer again.
 */
export function resolveFogParameters(
  controls: FogControlValues,
  weather: FogWeatherState,
  edgeRadiusM: number
): ResolvedFogParameters {
  const requestedMaster = nonNegative(controls.fogMaster)
  const weatherEnabled = Boolean(controls.fogEnabled) && requestedMaster > 0
  const masterDensity = weatherEnabled ? requestedMaster : 0
  const bankWeatherScale = nonNegative(weather.bankScale)
  const hazeWeatherScale = nonNegative(weather.hazeScale)
  const driftControl = nonNegative(controls.fogDrift)
  const edgeRadius = Math.max(1, nonNegative(edgeRadiusM))
  const edgeStartM = edgeRadius * FOG_EDGE_START_FRACTION
  const edgeEndM = edgeRadius * FOG_EDGE_END_FRACTION

  const hazeDensityPerM = nonNegative(controls.fog) * Math.sqrt(
    masterDensity * hazeWeatherScale
  )
  const bankDensity = nonNegative(controls.fogBank) * masterDensity * bankWeatherScale

  // The streamed edge and matching sky backdrop should be no stronger than the
  // fog that would actually be present at that distance. Their old unconditional
  // 100% value was the residual "heavy fog" seen with master density at zero.
  const hazeOpacity = distanceHazeOpacity(hazeDensityPerM, edgeEndM)
  const bankOpacity = marineBankOpacity(bankDensity, edgeEndM)
  const farWeatherOpacity = weatherEnabled
    ? 1 - (1 - hazeOpacity) * (1 - bankOpacity)
    : 0

  return {
    weatherEnabled,
    masterDensity,
    layerTopM: finite(controls.fogTop) + finite(weather.topOffsetM),
    bankDensity,
    localDensity: masterDensity * bankWeatherScale,
    billowScale: weatherEnabled
      ? nonNegative(controls.fogNoise) * nonNegative(weather.billowScale)
      : 0,
    motionRate: weatherEnabled ? driftControl * nonNegative(weather.driftScale) : 0,
    windX: weatherEnabled ? finite(weather.windX) * driftControl : 0,
    windZ: weatherEnabled ? finite(weather.windZ) * driftControl : 0,
    hazeDensityPerM,
    edgeStartM,
    edgeEndM,
    farWeatherOpacity: clamp01(farWeatherOpacity)
  }
}
