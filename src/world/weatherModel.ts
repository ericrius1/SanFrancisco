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
  const day = sfCivilScalarDays(civil);
  const winter = (Math.cos(((civil.month - 1.2) / 12) * TAU) + 1) * 0.5;
  const broadFront =
    valueNoise1D(day * 2.7, 71) * 0.5 +
    valueNoise1D(day * 6.2, 193) * 0.32 +
    valueNoise1D(day * 13.1, 337) * 0.18;
  const convective = valueNoise1D(day * 9.4, 541);

  // Pacific exposure is strongest in the west; hills wring a little more
  // moisture from a front. Both are broad so crossing a street never flips it.
  const west = 1 - smoothstep(-5200, 3000, x);
  const centralHills = Math.exp(-Math.pow((x + 250) / 2450, 2) - Math.pow((z - 1800) / 2600, 2));
  const microclimate = west * 0.075 + centralHills * 0.045;
  const front = clamp01(broadFront + winter * 0.13 + microclimate - 0.065);
  const rain = smoothstep(0.57, 0.87, front);
  const storm = smoothstep(0.73, 0.96, front * 0.86 + convective * 0.23 + winter * 0.04);
  const cloud = clamp01(0.14 + front * 0.76 + valueNoise1D(day * 4.1, 887) * 0.22);
  const wind = clamp01(0.18 + front * 0.52 + convective * 0.3);
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

