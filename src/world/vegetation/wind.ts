// Sandbox-wide vegetation wind state.
//
// Trees, grass, flowers, shrubs, and procedural wind audio all read these
// uniforms and this heading, so the whole botanical layer breathes together.

import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { advanceWindPhase, sampleWindGust, windResponseAlpha } from "./windModel";

/** Prevailing world-space wind heading shared by every vegetation layer. */
export const WIND_DIR = new THREE.Vector3(0.85, 0, 0.53).normalize();

/** Global vegetation bend strength (0..1 under the current tuning UI). */
export const windStrength = uniform(0.5);

/** Global vegetation animation tempo multiplier. */
export const windSpeed = uniform(1);

/** Integrated animation phase. Unlike `time * speed`, live tempo changes cannot jump it. */
export const windPhase = uniform(0);

/** CPU gust envelope shared by visible vegetation and procedural wind audio. */
export const windGustGlobal = uniform(sampleWindGust(0));

let elapsed = 0;
let targetStrength = 0.5;
let targetSpeed = 1;

export function setWindTargets(strength: number, speed: number, immediate = false): void {
  targetStrength = Math.max(0, Number.isFinite(strength) ? strength : 0);
  targetSpeed = Math.max(0, Number.isFinite(speed) ? speed : 0);
  if (!immediate) return;
  windStrength.value = targetStrength;
  windSpeed.value = targetSpeed;
}

export function updateWindGusts(dt: number): number {
  const strengthAlpha = windResponseAlpha(dt, 0.32);
  const speedAlpha = windResponseAlpha(dt, 0.45);
  const nextStrength = THREE.MathUtils.lerp(windStrength.value as number, targetStrength, strengthAlpha);
  const nextSpeed = THREE.MathUtils.lerp(windSpeed.value as number, targetSpeed, speedAlpha);
  windStrength.value = Math.abs(nextStrength - targetStrength) < 1e-4 ? targetStrength : nextStrength;
  windSpeed.value = Math.abs(nextSpeed - targetSpeed) < 1e-4 ? targetSpeed : nextSpeed;

  elapsed = advanceWindPhase(elapsed, dt, windSpeed.value as number);
  windPhase.value = elapsed;
  const gust = sampleWindGust(elapsed);
  windGustGlobal.value = gust;
  return gust;
}

export function windGustValue(): number {
  return windGustGlobal.value as number;
}
