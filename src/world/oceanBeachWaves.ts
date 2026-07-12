/**
 * Authored Pacific swell at Ocean Beach. The city water stays intentionally
 * cheap, but this strip gets a directional, shoaling wave train that can be
 * sampled identically by water rendering, boats and the surf controller.
 *
 * Local frame: +X is east / shoreward, +Z is south / along the beach.
 */

export const OCEAN_BEACH_SURF = {
  minX: -6325,
  maxX: -5765,
  minZ: 1280,
  maxZ: 4920,
  centerZ: 3100,
  entryX: -6070,
  entryZ: 3370,
  // Bigger, better-spaced sets for a Kelly-Slater-style peeling wall: crests sit
  // ~150 m apart (one clean wave at a time, not a busy ripple field) and stand
  // up head-high-plus on the shoreward face.
  spacing: 150,
  speed: 9.2,
  amplitude: 10,
  offshoreCrest: -6310,
  // Shoaling profile widths (metres): a broad offshore shoulder feeds a steep,
  // narrow shoreward face. Shared by the CPU sampler AND the GPU twin
  // (tslUtil.oceanBeachSurfField) — change here, both follow.
  shoulderWidth: 29,
  faceWidth: 6.5
} as const;

const TAU = Math.PI * 2;

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function smooth01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

/** 0 outside Ocean Beach, feathered across the authored surf strip. */
export function oceanBeachMask(x: number, z: number): number {
  const b = OCEAN_BEACH_SURF;
  const xIn = smooth01((x - b.minX) / 70) * smooth01((b.maxX - x) / 85);
  const zIn = smooth01((z - b.minZ) / 180) * smooth01((b.maxZ - z) / 180);
  return xIn * zIn;
}

/** Shoreward-moving crest base. Use adjacent integer slots for the full train. */
export function oceanBeachCrestBase(time: number): number {
  const b = OCEAN_BEACH_SURF;
  const travel = ((time * b.speed) % b.spacing + b.spacing) % b.spacing;
  return b.offshoreCrest + travel;
}

/** Sandbar/peel variation bends each crest instead of drawing a ruler-straight wall. */
export function oceanBeachCrestX(slot: number, z: number, time: number): number {
  const b = OCEAN_BEACH_SURF;
  // Slot-independent so the whole train remains periodic and the WebGPU
  // heightfield can reproduce the same nearest-crest distance cheaply.
  const peel = Math.sin(z * 0.0052 + time * 0.18) * 13;
  const shoulder = Math.sin(z * 0.0017 - time * 0.09) * 6;
  return oceanBeachCrestBase(time) + slot * b.spacing + peel + shoulder;
}

/** Signed X distance to the nearest crest: negative offshore, positive shoreward. */
export function nearestOceanBeachCrest(x: number, z: number, time: number) {
  const b = OCEAN_BEACH_SURF;
  const approx = Math.round((x - oceanBeachCrestBase(time)) / b.spacing);
  let slot = approx;
  let crestX = oceanBeachCrestX(slot, z, time);
  let distance = x - crestX;
  for (let i = approx - 1; i <= approx + 1; i++) {
    const cx = oceanBeachCrestX(i, z, time);
    const d = x - cx;
    if (Math.abs(d) < Math.abs(distance)) {
      slot = i;
      crestX = cx;
      distance = d;
    }
  }
  return { slot, crestX, distance };
}

function waveAmplitude(z: number, time: number, slot: number) {
  const b = OCEAN_BEACH_SURF;
  const setPulse = 0.82 + Math.sin(time * 0.13 + slot * 2.2) * 0.13;
  const sandbar = 0.88 + Math.sin(z * 0.0041 + time * 0.1) * 0.12;
  return b.amplitude * setPulse * sandbar;
}

/**
 * Height contribution from the breaking swell (zero outside Ocean Beach).
 * The offshore shoulder is broad and the shoreward face is narrow: a cheap
 * shoaling profile with the steep face surfers need for speed.
 */
export function oceanBeachWaveHeight(x: number, z: number, time: number): number {
  const mask = oceanBeachMask(x, z);
  if (mask <= 0.0001) return 0;
  const { slot, distance: d } = nearestOceanBeachCrest(x, z, time);
  const a = waveAmplitude(z, time, slot);
  const width = d < 0 ? OCEAN_BEACH_SURF.shoulderWidth : OCEAN_BEACH_SURF.faceWidth;
  const ridge = Math.exp(-0.5 * (d / width) ** 2);
  const trough = Math.exp(-0.5 * ((d - 22) / 11) ** 2) * 0.24;
  return (ridge - trough) * a * mask;
}

export type OceanBeachWaveSample = {
  height: number;
  slopeX: number;
  face: number;
  lip: number;
  crestDistance: number;
  crestX: number;
  slot: number;
  mask: number;
};

/** Allocation-free-friendly analytic sample for surf physics and diagnostics. */
export function sampleOceanBeachWave(x: number, z: number, time: number): OceanBeachWaveSample {
  const mask = oceanBeachMask(x, z);
  const crest = nearestOceanBeachCrest(x, z, time);
  const eps = 0.65;
  const height = oceanBeachWaveHeight(x, z, time);
  const slopeX =
    (oceanBeachWaveHeight(x + eps, z, time) - oceanBeachWaveHeight(x - eps, z, time)) /
    (2 * eps);
  const face = mask * Math.exp(-0.5 * ((crest.distance - 4) / 15) ** 2);
  const lip = mask * Math.exp(-0.5 * ((crest.distance - 1) / 5.5) ** 2);
  return {
    height,
    slopeX,
    face,
    lip,
    crestDistance: crest.distance,
    crestX: crest.crestX,
    slot: crest.slot,
    mask
  };
}

/** A deterministic little break-up used by spray/foam without allocating RNG state. */
export function oceanBeachFoamNoise(z: number, time: number, seed: number): number {
  return 0.5 + 0.5 * Math.sin(z * 0.071 + time * (1.7 + seed * 0.03) + seed * TAU * 0.618);
}
