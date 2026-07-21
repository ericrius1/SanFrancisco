// Pure deterministic regression probe for the living SF fog-weather model.
// Run: node --experimental-strip-types tools/fog-weather-test.mjs

import assert from "node:assert/strict"
import { weatherNumber } from "../server/weather-utils.mjs"
import {
  blendFogWeather,
  effectiveLiveWeight,
  fogCoverageAt,
  liveFogFreshness,
  sampleProceduralFog
} from "../src/world/fogWeather.ts"
import { normalizeLiveFog } from "../src/world/liveFogModel.ts"
import {
  distanceHazeHalfOpacityM,
  distanceHazeOpacity,
  marineBankOpacity,
  resolveFogParameters
} from "../src/world/fogParameters.ts"
import {
  addSfCivilHours,
  sanFranciscoCivilNow,
  sfCivilFromScalarDays,
  sfCivilScalarDays,
  sfCivilToUtcMs,
  sfUtcOffsetHours,
  solarPosition
} from "../src/world/solar.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const TAU = Math.PI * 2
const EPS = 1e-9
const failures = []
const results = {}

function check(name, run) {
  try {
    results[name] = run() ?? "pass"
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function near(actual, expected, tolerance, message) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`
  )
}

function angularDistance(a, b) {
  return Math.abs(((b - a + Math.PI * 3) % TAU) - Math.PI)
}

function assertCivil(actual, expected, label) {
  assert.equal(actual.year, expected.year, `${label} year`)
  assert.equal(actual.month, expected.month, `${label} month`)
  assert.equal(actual.day, expected.day, `${label} day`)
  near(actual.hour, expected.hour, 1e-8, `${label} hour`)
}

check("missing provider numbers stay missing", () => {
  for (const value of [null, undefined, "", "  ", Number.NaN, Number.POSITIVE_INFINITY, "unknown"]) {
    assert.equal(weatherNumber(value), null, `${String(value)} should stay missing`)
  }
  assert.equal(weatherNumber(0), 0)
  assert.equal(weatherNumber("0"), 0)
  assert.equal(weatherNumber(" 12.5 "), 12.5)
  return { missingFixtures: 7 }
})

const STATE_KEYS = [
  "bankScale",
  "hazeScale",
  "topOffsetM",
  "billowScale",
  "driftScale",
  "frontX",
  "frontWidthM",
  "frontSkew",
  "macroPhase",
  "inlandFloor",
  "gateReachM",
  "windX",
  "windZ",
  "season",
  "regime",
  "diurnal"
]

function assertStateNear(actual, expected, tolerance, label) {
  for (const key of STATE_KEYS) {
    const delta = key === "macroPhase"
      ? angularDistance(actual[key], expected[key])
      : Math.abs(actual[key] - expected[key])
    assert(delta <= tolerance, `${label} ${key}: delta ${delta} > ${tolerance}`)
  }
}

const FOG_CONTROLS = {
  fogEnabled: true,
  fogMaster: 0.25,
  fogTop: 100,
  fogBank: 1.2,
  fogNoise: 0.5,
  fogDrift: 1.5,
  fog: 0.0004
}

const FOG_WEATHER = {
  bankScale: 1.1,
  hazeScale: 0.81,
  topOffsetM: 35,
  billowScale: 0.8,
  driftScale: 1.2,
  frontX: -2000,
  frontWidthM: 1200,
  frontSkew: 0.1,
  macroPhase: 1,
  inlandFloor: 0.1,
  gateReachM: 1800,
  windX: 0.6,
  windZ: -0.2,
  season: 1,
  regime: 0.5,
  diurnal: 0.7
}

check("resolved fog parameters match their displayed units", () => {
  const resolved = resolveFogParameters(FOG_CONTROLS, FOG_WEATHER, 3500)
  assert.equal(resolved.weatherEnabled, true)
  near(resolved.layerTopM, 135, EPS, "effective layer top")
  near(resolved.bankDensity, 1.2 * 0.25 * 1.1, EPS, "effective bank density")
  near(resolved.hazeDensityPerM, 0.0004 * Math.sqrt(0.25 * 0.81), EPS, "effective haze density")
  near(resolved.billowScale, 0.5 * 0.8, EPS, "effective billow scale")
  near(resolved.motionRate, 1.5 * 1.2, EPS, "effective motion rate")
  near(resolved.edgeStartM, 3500 * 0.88, EPS, "edge start")
  near(resolved.edgeEndM, 3500 * 0.98, EPS, "edge end")
  const expectedEdgeOpacity = 1 -
    (1 - distanceHazeOpacity(resolved.hazeDensityPerM, resolved.edgeEndM)) *
    (1 - marineBankOpacity(resolved.bankDensity, resolved.edgeEndM))
  near(resolved.farWeatherOpacity, expectedEdgeOpacity, EPS, "edge/backdrop opacity")
  const halfM = distanceHazeHalfOpacityM(resolved.hazeDensityPerM)
  assert(halfM !== null)
  near(distanceHazeOpacity(resolved.hazeDensityPerM, halfM), 0.5, EPS, "50% haze range")
  return resolved
})

check("zero master density is truly fog-free", () => {
  const resolved = resolveFogParameters(
    { ...FOG_CONTROLS, fogMaster: 0 },
    FOG_WEATHER,
    21000
  )
  assert.equal(resolved.weatherEnabled, false)
  assert.equal(resolved.masterDensity, 0)
  assert.equal(resolved.bankDensity, 0)
  assert.equal(resolved.localDensity, 0)
  assert.equal(resolved.hazeDensityPerM, 0)
  assert.equal(resolved.billowScale, 0)
  assert.equal(resolved.motionRate, 0)
  assert.equal(resolved.windX, 0)
  assert.equal(resolved.windZ, 0)
  assert.equal(resolved.farWeatherOpacity, 0)
  assert.equal(distanceHazeHalfOpacityM(resolved.hazeDensityPerM), null)
  return resolved
})

check("weather fog switch zeroes every rendered weather term", () => {
  const resolved = resolveFogParameters(
    { ...FOG_CONTROLS, fogEnabled: false },
    FOG_WEATHER,
    3500
  )
  assert.equal(resolved.weatherEnabled, false)
  assert.equal(resolved.bankDensity, 0)
  assert.equal(resolved.hazeDensityPerM, 0)
  assert.equal(resolved.farWeatherOpacity, 0)
  return resolved
})

check("civil calendar rollover", () => {
  assertCivil(
    addSfCivilHours({ year: 2026, month: 1, day: 31, hour: 23.5 }, 1),
    { year: 2026, month: 2, day: 1, hour: 0.5 },
    "month rollover"
  )
  assertCivil(
    addSfCivilHours({ year: 2024, month: 2, day: 28, hour: 23.5 }, 1),
    { year: 2024, month: 2, day: 29, hour: 0.5 },
    "leap rollover"
  )
  assertCivil(
    addSfCivilHours({ year: 2025, month: 2, day: 28, hour: 23.5 }, 1),
    { year: 2025, month: 3, day: 1, hour: 0.5 },
    "non-leap rollover"
  )
  assertCivil(
    addSfCivilHours({ year: 2025, month: 12, day: 31, hour: 23.5 }, 1),
    { year: 2026, month: 1, day: 1, hour: 0.5 },
    "year rollover"
  )
  assertCivil(
    addSfCivilHours({ year: 2026, month: 1, day: 1, hour: 0.25 }, -1),
    { year: 2025, month: 12, day: 31, hour: 23.25 },
    "negative rollover"
  )
  // Accelerated civil time deliberately keeps a 24-hour day through DST.
  assertCivil(
    addSfCivilHours({ year: 2026, month: 3, day: 8, hour: 1.5 }, 2),
    { year: 2026, month: 3, day: 8, hour: 3.5 },
    "civil DST policy"
  )

  const fixtures = [
    { year: 2024, month: 2, day: 29, hour: 0.1 },
    { year: 2026, month: 7, day: 13, hour: 18.483333333 },
    { year: 2027, month: 12, day: 31, hour: 23.999 }
  ]
  for (const fixture of fixtures) {
    assertCivil(
      sfCivilFromScalarDays(sfCivilScalarDays(fixture)),
      fixture,
      `scalar round-trip ${fixture.year}-${fixture.month}-${fixture.day}`
    )
  }
  return { fixtures: fixtures.length }
})

check("solar month and year rollover", () => {
  const boundaries = [
    [
      { year: 2026, month: 1, day: 31, hour: 12 },
      { year: 2026, month: 2, day: 1, hour: 12 }
    ],
    [
      { year: 2026, month: 12, day: 31, hour: 12 },
      { year: 2027, month: 1, day: 1, hour: 12 }
    ]
  ]
  const deltas = []
  for (const [before, after] of boundaries) {
    assert.equal(sfCivilToUtcMs(after) - sfCivilToUtcMs(before), DAY_MS)
    assertCivil(
      sanFranciscoCivilNow(new Date(sfCivilToUtcMs(before))),
      before,
      "UTC-to-SF round-trip before boundary"
    )
    assertCivil(
      sanFranciscoCivilNow(new Date(sfCivilToUtcMs(after))),
      after,
      "UTC-to-SF round-trip after boundary"
    )
    const a = solarPosition(before)
    const b = solarPosition(after)
    for (const position of [a, b]) {
      for (const value of Object.values(position)) assert(Number.isFinite(value))
      near(Math.hypot(position.x, position.y, position.z), 1, 1e-12, "solar unit vector")
    }
    const elevation = Math.abs(b.elevation - a.elevation)
    const azimuth = angularDistance(a.azimuth * Math.PI / 180, b.azimuth * Math.PI / 180) * 180 / Math.PI
    assert(elevation < 1, `daily solar elevation jump ${elevation}`)
    assert(azimuth < 2, `daily solar azimuth jump ${azimuth}`)
    deltas.push({ elevation, azimuth })
  }
  return { deltas }
})

check("accelerated solar continuity across DST", () => {
  const boundaries = [
    [
      { year: 2026, month: 3, day: 8, hour: 1.99 },
      { year: 2026, month: 3, day: 8, hour: 2.01 }
    ],
    [
      { year: 2026, month: 11, day: 1, hour: 1.99 },
      { year: 2026, month: 11, day: 1, hour: 2.01 }
    ]
  ]
  const deltas = []
  for (const [before, after] of boundaries) {
    // Simulated time is a continuous 24-hour civil clock, so Sky captures one
    // Pacific offset for the run instead of inheriting a real DST jump.
    const offset = sfUtcOffsetHours({ ...before, hour: 12 })
    near(
      sfCivilToUtcMs(after, offset) - sfCivilToUtcMs(before, offset),
      0.02 * 3600000,
      1e-5,
      "fixed-offset UTC delta"
    )
    const a = solarPosition(before, undefined, undefined, offset)
    const b = solarPosition(after, undefined, undefined, offset)
    const elevation = Math.abs(b.elevation - a.elevation)
    const azimuth = angularDistance(a.azimuth * Math.PI / 180, b.azimuth * Math.PI / 180) * 180 / Math.PI
    assert(elevation < 0.3, `DST solar elevation jump ${elevation}`)
    assert(azimuth < 0.6, `DST solar azimuth jump ${azimuth}`)
    deltas.push({ offset, elevation, azimuth })
  }
  return { deltas }
})

check("procedural determinism and reverse scrub", () => {
  const civil = { year: 2026, month: 7, day: 15, hour: 6.25 }
  const a = sampleProceduralFog(civil)
  const b = sampleProceduralFog(civil)
  assert.deepEqual(b, a, "same civil instant must be bit-deterministic")

  const reusable = Object.fromEntries(STATE_KEYS.map((key) => [key, Number.NaN]))
  const returned = sampleProceduralFog(civil, reusable)
  assert.equal(returned, reusable, "out parameter identity")
  assert.deepEqual(returned, a, "out parameter result")

  const forwardCivil = addSfCivilHours(civil, 37.25)
  sampleProceduralFog(forwardCivil)
  const reverseCivil = addSfCivilHours(forwardCivil, -37.25)
  const reversed = sampleProceduralFog(reverseCivil)
  assertCivil(reverseCivil, civil, "reverse scrub civil instant")
  assertStateNear(reversed, a, 1e-9, "reverse scrub weather")
  return { forwardCivil, reverseMaxTolerance: 1e-9 }
})

const scan = {
  samples: 0,
  min: Object.fromEntries(STATE_KEYS.map((key) => [key, Infinity])),
  max: Object.fromEntries(STATE_KEYS.map((key) => [key, -Infinity])),
  sum: Object.fromEntries(STATE_KEYS.map((key) => [key, 0]))
}

check("multi-year bounds and mean", () => {
  const bounds = {
    bankScale: [0.3, 1.22],
    hazeScale: [0.68, 1.08],
    topOffsetM: [-55, 50],
    billowScale: [0.7, 1.41],
    driftScale: [0.68, 1.18],
    frontX: [-5200, 3600],
    frontWidthM: [760, 1750],
    frontSkew: [-0.1, 0.16],
    macroPhase: [0, TAU],
    inlandFloor: [0.05, 0.34],
    gateReachM: [350, 5200],
    season: [0.38, 1],
    regime: [0, 1],
    diurnal: [0.04, 1]
  }
  let civil = { year: 2024, month: 1, day: 1, hour: 0 }
  const sampleCount = 8 * 366 * 8
  for (let i = 0; i < sampleCount; i++) {
    const state = sampleProceduralFog(civil)
    for (const key of STATE_KEYS) {
      const value = state[key]
      assert(Number.isFinite(value), `${key} was not finite at ${JSON.stringify(civil)}`)
      scan.min[key] = Math.min(scan.min[key], value)
      scan.max[key] = Math.max(scan.max[key], value)
      scan.sum[key] += value
    }
    for (const [key, [lo, hi]] of Object.entries(bounds)) {
      assert(
        state[key] >= lo - EPS && state[key] <= hi + EPS,
        `${key} ${state[key]} outside [${lo}, ${hi}] at ${JSON.stringify(civil)}`
      )
    }
    const windSpeed = Math.hypot(state.windX, state.windZ)
    assert(windSpeed >= 0.35 - EPS && windSpeed <= 1.2 + EPS, `wind speed ${windSpeed}`)
    assert(state.windX >= 0.35 * Math.cos(0.4) - EPS, `fog wind reversed: ${state.windX}`)
    assert(
      Math.abs(state.windZ) <= state.windX * Math.tan(0.4) + EPS,
      `fog wind escaped coastal cone: ${state.windX}, ${state.windZ}`
    )
    scan.samples++
    civil = addSfCivilHours(civil, 3)
  }
  const meanTop = scan.sum.topOffsetM / scan.samples
  assert(Math.abs(meanTop) < 10, `mean top offset ${meanTop} m was not centered`)
  return {
    samples: scan.samples,
    bank: [scan.min.bankScale, scan.max.bankScale],
    haze: [scan.min.hazeScale, scan.max.hazeScale],
    top: [scan.min.topOffsetM, scan.max.topOffsetM],
    meanTop
  }
})

check("month and year weather continuity", () => {
  let maxSeasonDelta = 0
  let maxBankDelta = 0
  let maxFrontDelta = 0
  let maxPhaseDelta = 0
  let boundaries = 0
  for (let year = 2024; year <= 2031; year++) {
    for (let month = 1; month <= 12; month++) {
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
      const before = { year, month, day: lastDay, hour: 23 + 3599 / 3600 }
      const after = addSfCivilHours(before, 2 / 3600)
      const a = sampleProceduralFog(before)
      const b = sampleProceduralFog(after)
      maxSeasonDelta = Math.max(maxSeasonDelta, Math.abs(b.season - a.season))
      maxBankDelta = Math.max(maxBankDelta, Math.abs(b.bankScale - a.bankScale))
      maxFrontDelta = Math.max(maxFrontDelta, Math.abs(b.frontX - a.frontX))
      maxPhaseDelta = Math.max(maxPhaseDelta, angularDistance(a.macroPhase, b.macroPhase))
      boundaries++
    }
  }
  assert(maxSeasonDelta < 1e-6, `season discontinuity ${maxSeasonDelta}`)
  assert(maxBankDelta < 1e-4, `bank discontinuity ${maxBankDelta}`)
  assert(maxFrontDelta < 1, `front discontinuity ${maxFrontDelta} m`)
  assert(maxPhaseDelta < 1e-4, `macro phase discontinuity ${maxPhaseDelta}`)
  return { boundaries, maxSeasonDelta, maxBankDelta, maxFrontDelta, maxPhaseDelta }
})

function monthlyMean(month, hour, key) {
  let total = 0
  let count = 0
  for (let year = 2024; year <= 2031; year++) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    for (let day = 1; day <= lastDay; day++) {
      total += sampleProceduralFog({ year, month, day, hour })[key]
      count++
    }
  }
  return total / count
}

check("procedural climatology and day-to-day variation", () => {
  const januaryDawn = monthlyMean(1, 6, "bankScale")
  const aprilDawn = monthlyMean(4, 6, "bankScale")
  const julyDawn = monthlyMean(7, 6, "bankScale")
  const julyAfternoon = monthlyMean(7, 14, "bankScale")
  const octoberDawn = monthlyMean(10, 6, "bankScale")
  const julyDawnFront = monthlyMean(7, 6, "frontX")
  const julyAfternoonFront = monthlyMean(7, 14, "frontX")

  assert(julyDawn - januaryDawn >= 0.15, "summer marine season was too weak")
  assert(julyDawn - julyAfternoon >= 0.18, "July burnoff was too weak")
  assert(julyDawnFront - julyAfternoonFront >= 2500, "July front did not retreat enough")
  assert(octoberDawn <= aprilDawn, "early-fall clearing notch was ineffective")

  const banks = []
  const fronts = []
  for (let year = 2024; year <= 2031; year++) {
    for (let day = 1; day <= 31; day++) {
      const state = sampleProceduralFog({ year, month: 7, day, hour: 6 })
      banks.push(state.bankScale)
      fronts.push(state.frontX)
    }
  }
  const bankRange = Math.max(...banks) - Math.min(...banks)
  const frontRange = Math.max(...fronts) - Math.min(...fronts)
  assert(bankRange >= 0.2, `July day-to-day bank range ${bankRange}`)
  assert(frontRange >= 1500, `July day-to-day front range ${frontRange}`)
  return {
    januaryDawn,
    aprilDawn,
    julyDawn,
    julyAfternoon,
    octoberDawn,
    julyFrontRetreatM: julyDawnFront - julyAfternoonFront,
    julyBankRange: bankRange,
    julyFrontRangeM: frontRange
  }
})

check("spatial Pacific front and Golden Gate tongue", () => {
  const state = sampleProceduralFog({ year: 2026, month: 1, day: 15, hour: 14 })
  const xs = [-6000, -4000, -2000, 0, 2000, 4000, 6000]
  const factors = xs.map((x) => fogCoverageAt(state, x, 0))
  for (const factor of factors) {
    assert(factor >= state.inlandFloor - EPS && factor <= 1 + EPS, `coverage ${factor}`)
  }
  for (let i = 1; i < factors.length; i++) {
    assert(factors[i] <= factors[i - 1] + EPS, `front reversed between ${xs[i - 1]} and ${xs[i]}`)
  }
  assert(factors[0] > 0.95, `Pacific side ${factors[0]} was not covered`)
  near(factors.at(-1), state.inlandFloor, 1e-6, "far-east density floor")

  const gateX = -1000
  const gateAlong = gateX + 3000
  const gateAxisZ = -2700 + gateAlong * 0.12
  const onAxis = fogCoverageAt(state, gateX, gateAxisZ)
  const offAxis = fogCoverageAt(state, gateX, 0)
  assert(onAxis - offAxis >= 0.5, `Gate tongue contrast ${onAxis - offAxis}`)
  return { factors, onAxis, offAxis }
})

const LIVE_NOW = Date.parse("2026-07-13T18:00:00Z")
const LIVE_ROLES = [
  ["coast", "KHAF", "west"],
  ["southBay", "KSFO", "center"],
  ["eastBay", "KOAK", "bay"]
]
const minutesAgo = (minutes) => new Date(LIVE_NOW - minutes * MINUTE_MS).toISOString()

function station(role, id, overrides = {}) {
  return {
    role,
    id,
    observedAt: minutesAgo(overrides.ageMinutes ?? 5),
    visibilityM: 16000,
    temperatureC: 18,
    dewpointC: 10,
    windFromDeg: 270,
    windSpeedMps: 5,
    weather: null,
    clouds: [],
    ...overrides,
    ageMinutes: undefined
  }
}

function grid(role, overrides = {}) {
  return {
    role,
    issuedAt: minutesAgo(overrides.ageMinutes ?? 30),
    validAt: minutesAgo(overrides.validAgeMinutes ?? overrides.ageMinutes ?? 30),
    visibilityM: 16000,
    ceilingM: 2000,
    humidityPct: 55,
    skyCoverPct: 10,
    windFromDeg: 270,
    windSpeedMps: 5,
    ...overrides,
    ageMinutes: undefined,
    validAgeMinutes: undefined
  }
}

function livePayload(stations, grids) {
  return {
    version: 1,
    generatedAt: new Date(LIVE_NOW).toISOString(),
    sources: {},
    stations,
    grid: grids
  }
}

const allStations = (overrides = {}) => LIVE_ROLES.map(([role, id]) => station(role, id, overrides))
const allGrid = (overrides = {}) => LIVE_ROLES.map(([, , role]) => grid(role, overrides))

check("live clear, FG, BR, and low stratus", () => {
  assert.equal(normalizeLiveFog(livePayload([], []), LIVE_NOW), null)

  const clear = normalizeLiveFog(livePayload(allStations(), allGrid()), LIVE_NOW)
  const fg = normalizeLiveFog(
    livePayload(allStations({ visibilityM: 300, temperatureC: 12, dewpointC: 12, weather: "FZFG" }), []),
    LIVE_NOW
  )
  const br = normalizeLiveFog(
    livePayload(allStations({ visibilityM: 16000, temperatureC: 18, dewpointC: 10, weather: "BR" }), []),
    LIVE_NOW
  )
  const stratus = normalizeLiveFog(
    livePayload([], allGrid({ visibilityM: 16000, ceilingM: 220, humidityPct: 96, skyCoverPct: 100 })),
    LIVE_NOW
  )
  for (const [label, bias] of Object.entries({ clear, fg, br, stratus })) {
    assert(bias, `${label} payload did not normalize`)
    for (const key of STATE_KEYS) assert(Number.isFinite(bias.state[key]), `${label} ${key}`)
  }
  near(clear.state.bankScale, 0.3, 1e-12, "clear bank")
  assert(fg.state.bankScale > 1.2, `FG bank ${fg.state.bankScale}`)
  assert(br.state.bankScale > clear.state.bankScale + 0.5, `BR bank ${br.state.bankScale}`)
  assert(br.state.bankScale < fg.state.bankScale, "BR should be weaker than FG")
  near(stratus.state.bankScale, 0.3, 1e-12, "low-stratus surface bank")
  assert(stratus.state.topOffsetM > 0, `low stratus top ${stratus.state.topOffsetM}`)
  assert(stratus.state.frontX > -1000, `low stratus front ${stratus.state.frontX}`)
  return {
    clearBank: clear.state.bankScale,
    fgBank: fg.state.bankScale,
    brBank: br.state.bankScale,
    stratusBank: stratus.state.bankScale,
    stratusTop: stratus.state.topOffsetM,
    stratusFront: stratus.state.frontX
  }
})

check("per-source aging and handoff", () => {
  const stationPayload = livePayload(
    allStations({ ageMinutes: 0, visibilityM: 300, weather: "FG" }),
    []
  )
  const gridPayload = livePayload(
    [],
    allGrid({ ageMinutes: 0, visibilityM: 300, ceilingM: 220, humidityPct: 100, skyCoverPct: 100 })
  )
  const station20 = normalizeLiveFog(stationPayload, LIVE_NOW + 20 * MINUTE_MS)
  const station55 = normalizeLiveFog(stationPayload, LIVE_NOW + 55 * MINUTE_MS)
  const station90 = normalizeLiveFog(stationPayload, LIVE_NOW + 90 * MINUTE_MS)
  assert(station20 && station55)
  near(station20.confidence, 0.68, 1e-12, "station full-window confidence")
  near(station55.confidence, 0.34, 1e-12, "station midpoint confidence")
  near(liveFogFreshness(station55, LIVE_NOW + 55 * MINUTE_MS), 1, 1e-12, "new aggregate freshness")
  assert.equal(station90, null, "station should expire at 90 minutes")

  const grid90 = normalizeLiveFog(gridPayload, LIVE_NOW + 90 * MINUTE_MS)
  const grid225 = normalizeLiveFog(gridPayload, LIVE_NOW + 225 * MINUTE_MS)
  const grid360 = normalizeLiveFog(gridPayload, LIVE_NOW + 360 * MINUTE_MS)
  assert(grid90 && grid225)
  near(grid90.confidence, 0.32, 1e-12, "grid full-window confidence")
  near(grid225.confidence, 0.16, 1e-12, "grid midpoint confidence")
  assert.equal(grid360, null, "grid should expire at six hours")

  // A fresh-enough grid is the station's continuity fallback. Effective live
  // influence must not collapse to zero and jump back up as the METAR expires.
  const mixedPayload = livePayload(
    allStations({ ageMinutes: 0, visibilityM: 300, weather: "FG" }),
    allGrid({ ageMinutes: 0, visibilityM: 300, ceilingM: 220, humidityPct: 100, skyCoverPct: 100 })
  )
  const beforeNow = LIVE_NOW + 89.99 * MINUTE_MS
  const afterNow = LIVE_NOW + 90 * MINUTE_MS
  const before = normalizeLiveFog(mixedPayload, beforeNow)
  const after = normalizeLiveFog(mixedPayload, afterNow)
  assert(before && after)
  const beforeWeight = effectiveLiveWeight("live", 1, true, before, beforeNow)
  const afterWeight = effectiveLiveWeight("live", 1, true, after, afterNow)
  assert(
    Math.abs(afterWeight - beforeWeight) < 0.05,
    `station-to-grid handoff jumped ${beforeWeight} -> ${afterWeight}`
  )
  return { beforeWeight, afterWeight }
})

check("blend endpoints and live weights", () => {
  const a = sampleProceduralFog({ year: 2026, month: 1, day: 15, hour: 14 })
  const b = sampleProceduralFog({ year: 2026, month: 7, day: 15, hour: 6 })
  assertStateNear(blendFogWeather(a, b, -1), a, 1e-12, "blend low clamp")
  assertStateNear(blendFogWeather(a, b, 1), b, 1e-12, "blend high endpoint")
  const midpoint = blendFogWeather(a, b, 0.5)
  near(midpoint.bankScale, Math.sqrt(a.bankScale * b.bankScale), 1e-12, "log bank midpoint")
  near(midpoint.hazeScale, Math.sqrt(a.hazeScale * b.hazeScale), 1e-12, "log haze midpoint")
  near(midpoint.topOffsetM, (a.topOffsetM + b.topOffsetM) / 2, 1e-12, "linear top midpoint")
  const alias = { ...a }
  blendFogWeather(alias, b, 0.5, alias)
  assertStateNear(alias, midpoint, 1e-12, "in-place blend")

  const bias = {
    state: b,
    confidence: 0.8,
    observedAtMs: LIVE_NOW,
    decaysAtMs: LIVE_NOW + 30 * MINUTE_MS,
    expiresAtMs: LIVE_NOW + 180 * MINUTE_MS,
    label: "fixture"
  }
  near(liveFogFreshness(bias, LIVE_NOW), 1, 1e-12, "freshness now")
  near(liveFogFreshness(bias, LIVE_NOW + 30 * MINUTE_MS), 1, 1e-12, "freshness decay start")
  near(liveFogFreshness(bias, LIVE_NOW + 105 * MINUTE_MS), 0.5, 1e-12, "freshness midpoint")
  near(liveFogFreshness(bias, LIVE_NOW + 180 * MINUTE_MS), 0, 1e-12, "freshness expiry")
  near(effectiveLiveWeight("blend", 0.7, true, bias, LIVE_NOW), 0.56, 1e-12, "blend weight")
  near(effectiveLiveWeight("live", 0.1, true, bias, LIVE_NOW), 0.8, 1e-12, "live weight")
  near(effectiveLiveWeight("procedural", 1, true, bias, LIVE_NOW), 0, 1e-12, "procedural mode")
  near(effectiveLiveWeight("live", 1, false, bias, LIVE_NOW), 0, 1e-12, "simulated clock")
  near(effectiveLiveWeight("blend", 2, true, bias, LIVE_NOW), 0.8, 1e-12, "influence clamp")
  return { midpointBank: midpoint.bankScale }
})

const summary = {
  ok: failures.length === 0,
  failures,
  results
}
console.log(JSON.stringify(summary, null, 2))
if (failures.length) process.exitCode = 1
