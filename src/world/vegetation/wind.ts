// Sandbox-wide vegetation wind state.
//
// Trees, grass, flowers, and procedural wind audio all read these uniforms and
// this heading. The current SeedThree-backed tree materials temporarily import
// the same values while their geometry/material pipeline is replaced, so there
// is one runtime owner throughout the migration rather than two wind systems.

import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";

/** Prevailing world-space wind heading shared by every vegetation layer. */
export const WIND_DIR = new THREE.Vector3(0.85, 0, 0.53).normalize();

/** Global vegetation bend strength (0..1 under the current tuning UI). */
export const windStrength = uniform(0.5);

/** Global vegetation animation tempo multiplier. */
export const windSpeed = uniform(1);

/** CPU gust envelope shared by visible vegetation and procedural wind audio. */
export const windGustGlobal = uniform(0.55);

let elapsed = 0;
let turbulence = 0;

export function updateWindGusts(dt: number): number {
  const step = Math.min(dt, 0.1);
  elapsed += step * Math.max(0.05, windSpeed.value as number);

  // Slow swells (~30-90s), mid gusts (~10-25s), fast flutter (~3-7s).
  const slow = Math.sin(elapsed * 0.104) * 0.55 + Math.sin(elapsed * 0.047 + 1.7) * 0.45;
  const mid = Math.sin(elapsed * 0.31 + 0.9) * 0.6 + Math.sin(elapsed * 0.211 + 4.1) * 0.4;
  const fast = Math.sin(elapsed * 1.13 + 2.3) * 0.5 + Math.sin(elapsed * 0.71 + 0.4) * 0.5;

  // Bounded random walk: small chaotic component so gusts feel alive.
  turbulence += (Math.random() - 0.5 - turbulence * 0.35) * step * 1.6;
  turbulence = Math.max(-0.14, Math.min(0.14, turbulence));

  let gust = 0.55 + 0.27 * slow + 0.13 * mid + 0.05 * fast + turbulence;
  gust = Math.min(1, Math.max(0, gust));
  // Bias toward calm-then-swell: spends more time low, spikes read as gusts.
  gust = gust * gust * (3 - 2 * gust);
  windGustGlobal.value = gust;
  return gust;
}

export function windGustValue(): number {
  return windGustGlobal.value as number;
}
