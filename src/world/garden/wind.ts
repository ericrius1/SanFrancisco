// Shared CPU-side wind gust envelope. One scalar signal drives the grass sway
// amplitude (via the windGustGlobal TSL uniform) — and can drive procedural wind
// audio too, so what the meadow looks like and what it sounds like stay in sync.
//
// The envelope is a sum of incommensurate sines (never repeats audibly) with a
// slow random-walk turbulence term layered on top. Range is [0, 1]; the mean
// sits near 0.55 so windStrength keeps its historical feel at default tuning.

import { uniform } from "three/tsl";
import { windSpeed } from "../../../vendor/SeedThree/src/core/wind.js";

export const windGustGlobal = uniform(0.55);

let t = 0;
let turbulence = 0;

export function updateWindGusts(dt: number): number {
  const step = Math.min(dt, 0.1);
  t += step * Math.max(0.05, windSpeed.value as number);

  // Slow swells (~30-90s), mid gusts (~10-25s), fast flutter (~3-7s).
  const slow = Math.sin(t * 0.104) * 0.55 + Math.sin(t * 0.047 + 1.7) * 0.45;
  const mid = Math.sin(t * 0.31 + 0.9) * 0.6 + Math.sin(t * 0.211 + 4.1) * 0.4;
  const fast = Math.sin(t * 1.13 + 2.3) * 0.5 + Math.sin(t * 0.71 + 0.4) * 0.5;

  // Bounded random walk: small chaotic component so gusts feel alive.
  turbulence += (Math.random() - 0.5 - turbulence * 0.35) * step * 1.6;
  turbulence = Math.max(-0.14, Math.min(0.14, turbulence));

  let g = 0.55 + 0.27 * slow + 0.13 * mid + 0.05 * fast + turbulence;
  g = Math.min(1, Math.max(0, g));
  // Bias toward calm-then-swell: spends more time low, spikes read as gusts.
  g = g * g * (3 - 2 * g);
  windGustGlobal.value = g;
  return g;
}

export function windGustValue(): number {
  return windGustGlobal.value as number;
}
