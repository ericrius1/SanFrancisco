import * as THREE from "three/webgpu";

/**
 * Night glow for tennis / pickle balls: the ball itself goes emissive and a
 * shadowless point light fills the nearby scene. Intensity is driven from sun
 * elevation (same twilight ramp as street lamps / fireflies).
 *
 * PointLights must be created once at boot and left in the scene — adding or
 * removing lights at runtime rebuilds every lit WebGPU pipeline.
 */

export const TENNIS_BALL_COLOR = 0xb9ef31;
export const PICKLE_BALL_COLOR = 0xd8ef3c;

const TWILIGHT_START_ELEVATION = 7;
const TWILIGHT_FULL_ELEVATION = -2;
const EMISSIVE_PEAK = 1.85;
const LIGHT_INTENSITY = 15;
const LIGHT_DISTANCE = 6.5;
const LIGHT_DECAY = 2;
const LIGHT_COLOR = 0xc8ff55;

/** Shared night amount 0..1, refreshed once per frame from the sky. */
export const BALL_GLOW_NIGHT = { value: 0 };

function smooth01(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Call once per frame after the sky updates sun elevation. */
export function syncBallGlowNight(sunElevation: number): void {
  BALL_GLOW_NIGHT.value = smooth01(TWILIGHT_START_ELEVATION, TWILIGHT_FULL_ELEVATION, sunElevation);
}

export function createBallGlowLight(name = "ball-glow"): THREE.PointLight {
  const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DISTANCE, LIGHT_DECAY);
  light.name = name;
  light.castShadow = false;
  return light;
}

type EmissiveMaterial = {
  emissive: THREE.Color;
  emissiveIntensity: number;
  color?: THREE.Color;
};

/** Stamp the lime emissive onto a standard / lambert / node standard material. */
export function prepareBallGlowMaterial(material: EmissiveMaterial, ballColor = TENNIS_BALL_COLOR): void {
  material.emissive.setHex(ballColor);
  material.emissiveIntensity = 0;
}

/** Drive emissive (+ optional light). Pass amount 0 to kill the glow. */
export function applyBallGlow(
  material: EmissiveMaterial | null | undefined,
  light: THREE.PointLight | null | undefined,
  amount = BALL_GLOW_NIGHT.value
): void {
  const a = amount > 0.001 ? amount : 0;
  if (material) material.emissiveIntensity = a * EMISSIVE_PEAK;
  if (light) light.intensity = a * LIGHT_INTENSITY;
}
