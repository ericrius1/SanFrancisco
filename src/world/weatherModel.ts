import { sfCivilScalarDays, type SfCivilTime } from "./solar.ts";

export type WeatherKind = "clear" | "mist" | "rain" | "storm";

export type WeatherState = {
  cloud: number;
  rain: number;
  storm: number;
  lightning: number;
  wetness: number;
  wind: number;
  kind: WeatherKind;
  label: string;
};

const TAU = Math.PI * 2;
const FRONT_SLOT_DAYS = 6 / 24;
const FRONT_SEARCH_RADIUS = 2;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function smoothstep(a: number, b: number, value: number): number {
  const t = clamp01((value - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function hash01(index: number, salt: number): number {
  let value = (Math.trunc(index) ^ Math.imul(salt, 0x9e3779b1)) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 0xffffffff;
}

/** Continuous deterministic noise. Time scrubbing and accelerated days stay reversible. */
function valueNoise1D(value: number, salt: number): number {
  const index = Math.floor(value);
  const fraction = value - index;
  const fade = fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
  return lerp(hash01(index, salt), hash01(index + 1, salt), fade);
}

function smootherstep01(value: number): number {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

type WetFront = {
  rain: number;
  storm: number;
};

/**
 * Sample a sparse sequence of actual weather episodes instead of interpreting
 * continuously blended noise as rain. Each six-hour slot gets one deterministic
 * chance to carry a front. The broad, smooth bell makes fronts arrive and leave
 * without a state-machine discontinuity and keeps clock scrubbing reversible.
 */
function sampleWetFronts(day: number, winter: number): WetFront {
  const slot = Math.floor(day / FRONT_SLOT_DAYS);
  // San Francisco should read clear most of the time. Summer fronts are rare;
  // the winter lift produces wet spells without turning the season into a
  // permanent grey/rain blend.
  const frontChance = lerp(0.09, 0.32, winter);
  let rain = 0;
  let storm = 0;

  for (let offset = -FRONT_SEARCH_RADIUS; offset <= FRONT_SEARCH_RADIUS; offset++) {
    const candidate = slot + offset;
    // The sparse random schedule gets a low-key cadence front every two days.
    // It bounds unlucky multi-hour real-play droughts while the 6 h candidate
    // grid and long clear gaps keep the sequence from feeling periodic.
    const cadenceFront = ((candidate % 8) + 8) % 8 === 0;
    if (!cadenceFront && hash01(candidate, 1103) >= frontChance) continue;

    const center = (candidate + lerp(0.18, 0.82, hash01(candidate, 1201))) * FRONT_SLOT_DAYS;
    // Total front length: 2.8–6.8 civil hours. On the game weather clock this
    // is long enough to feel like weather, not a particle-effect cameo.
    const halfDuration = lerp(1.4, 3.4, hash01(candidate, 1301)) / 24;
    const distance = Math.abs(day - center) / halfDuration;
    if (distance >= 1) continue;

    const envelope = 1 - smootherstep01(distance);
    const intensity = lerp(0.48, 1, hash01(candidate, 1409));
    rain = Math.max(rain, envelope * intensity);

    // Only a minority of wet fronts become electrical. Even in winter this is
    // deliberately uncommon; a storm should still feel like an event.
    const electricalChance = lerp(0.08, 0.22, winter);
    if (hash01(candidate, 1511) < electricalChance) {
      const electricalCore = smootherstep01(clamp01((envelope - 0.24) / 0.76));
      storm = Math.max(storm, electricalCore * lerp(0.62, 1, hash01(candidate, 1601)));
    }
  }

  return { rain, storm };
}

function weatherKind(rain: number, storm: number, cloud: number): WeatherKind {
  if (storm > 0.38) return "storm";
  if (rain > 0.12) return "rain";
  if (cloud > 0.62) return "mist";
  return "clear";
}

export function labelForWeather(kind: WeatherKind): string {
  if (kind === "storm") return "electrical storm";
  if (kind === "rain") return "soft rain";
  if (kind === "mist") return "marine mist";
  return "clear air";
}

/**
 * A game-scale SF weather forecast. Synoptic fronts evolve over hours, while
 * west-side exposure and the central hills provide gentle local variation.
 * It complements the more detailed marine-fog model rather than replacing it.
 */
export function sampleProceduralWeather(
  civil: SfCivilTime,
  x: number,
  z: number,
  out?: WeatherState
): WeatherState {
  return sampleProceduralWeatherAtDay(sfCivilScalarDays(civil), civil.month, x, z, out);
}

/** Allocation-free sampling path for WeatherDirector's accelerated forecast clock. */
export function sampleProceduralWeatherAtDay(
  day: number,
  month: number,
  x: number,
  z: number,
  out?: WeatherState
): WeatherState {
  const winter = (Math.cos(((month - 1.2) / 12) * TAU) + 1) * 0.5;
  const marineSeason = 1 - winter;
  const fronts = sampleWetFronts(day, winter);

  // Pacific exposure is strongest in the west; hills wring a little more
  // moisture from an active front. Both are broad so crossing a street never
  // flips the rain on or off.
  const west = 1 - smoothstep(-5200, 3000, x);
  const centralHills = Math.exp(-Math.pow((x + 250) / 2450, 2) - Math.pow((z - 1800) / 2600, 2));
  const microclimate = west * 0.075 + centralHills * 0.045;
  const rain = clamp01(fronts.rain * (0.93 + microclimate));
  const storm = clamp01(fronts.storm * (0.94 + microclimate * 0.45));

  // This scalar grades the existing sky only; authored/volumetric cloud
  // geometry intentionally remains a separate future system. Marine mist gets
  // its own sparse pulse, while an approaching wet front always carries a
  // visibly heavier sky than clear weather.
  const fairVariation = valueNoise1D(day * 2.1, 887);
  const mistPulse = smoothstep(
    0.7,
    0.94,
    valueNoise1D(day * 3.35, 953) + marineSeason * 0.08 + west * 0.025
  );
  const fairCloud = clamp01(0.07 + fairVariation * 0.25 + mistPulse * 0.48);
  const cloud = clamp01(Math.max(fairCloud, rain > 0 ? 0.34 + rain * 0.66 : 0) + storm * 0.06);
  const windPulse = valueNoise1D(day * 5.2, 541);
  const wind = clamp01(0.13 + windPulse * 0.2 + rain * 0.43 + storm * 0.24);
  const kind = weatherKind(rain, storm, cloud);
  const state = out ?? ({} as WeatherState);
  state.cloud = cloud;
  state.rain = rain;
  state.storm = storm;
  state.lightning = 0;
  state.wetness = rain;
  state.wind = wind;
  state.kind = kind;
  state.label = labelForWeather(kind);
  return state;
}

export function forcedWeather(kind: WeatherKind, out?: WeatherState): WeatherState {
  const values = kind === "storm"
    ? { cloud: 1, rain: 0.92, storm: 0.9, wind: 0.9 }
    : kind === "rain"
      ? { cloud: 0.9, rain: 0.68, storm: 0.08, wind: 0.52 }
      : kind === "mist"
        ? { cloud: 0.78, rain: 0.025, storm: 0, wind: 0.24 }
        : { cloud: 0.12, rain: 0, storm: 0, wind: 0.18 };
  const state = out ?? ({} as WeatherState);
  Object.assign(state, values, {
    lightning: 0,
    wetness: values.rain,
    kind,
    label: labelForWeather(kind)
  });
  return state;
}
