/**
 * Authored Pacific swell at Ocean Beach. The city water stays intentionally
 * cheap, but this strip gets a directional, shoaling wave train that can be
 * sampled identically by water rendering, boats and the surf controller.
 *
 * Local frame: +X is east / shoreward, +Z is south / along the beach.
 */

export const OCEAN_BEACH_SURF = {
  minX: -6325,
  // Shoreward bound of the activity strip (sand side). The live waterline is
  // further west — see oceanBeachApproxShoreX / oceanBeachShoreline.
  maxX: -5720,
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
  amplitude: 12,
  offshoreCrest: -6310,
  // Shoaling profile widths (metres): a broad offshore shoulder feeds a steep,
  // narrow shoreward face. Shared by the CPU sampler AND the GPU twin
  // (tslUtil.oceanBeachSurfField) — change here, both follow. Narrow face =
  // a steep, near-vertical wall that towers over a rider set in the pocket.
  shoulderWidth: 30,
  faceWidth: 5.0,

  // Parametric barrel shared by CPU contact/camera queries and the lazy TSL
  // roof shell. X is signed shoreward distance from the live crest. The roof
  // starts at the crown, arches over the pocket, then falls into the pitching
  // lip. Keeping this analytic is intentional: gameplay never reads GPU state.
  tubeSpan: 14,
  tubeLineOffset: 6.2,
  tubeLineHalfWidth: 2.5,
  tubeRoofControl1: 1.16,
  tubeRoofControl2: 0.94,
  tubeRoofEnd: 0.5,
  // Long, slowly peeling barrel sections. Entry Z begins inside a clean window;
  // riding down-line eventually reaches its shoulder and exit aperture.
  barrelPeriod: 820,
  barrelDrift: 0.024
} as const;

const TAU = Math.PI * 2;

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function smooth01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

/**
 * Approximate dry-sand waterline X along Ocean Beach (no map required).
 * Fit from baked surface.bin so CPU/GPU masks stay aligned without isWater.
 * Positive error = a few metres onto sand; the feather below eats that.
 */
export function oceanBeachApproxShoreX(z: number): number {
  return -6323 + 0.08504 * z + 0.00000743 * z * z;
}

/** Dry-sand pad just east of the live waterline at this Z. */
export type OceanBeachShoreline = { x: number; z: number; waterX: number };

/**
 * Walk shoreward from the break until `isWater` flips false. Spawn/exit use this
 * so the player stands on the actual edge, not 50–150 m inland of the surf mask.
 */
export function oceanBeachShoreline(
  map: { isWater(x: number, z: number): boolean },
  z: number,
  pad = 4
): OceanBeachShoreline {
  const b = OCEAN_BEACH_SURF;
  const zz = Math.min(b.maxZ - 30, Math.max(b.minZ + 30, z));
  const startX = Math.min(oceanBeachApproxShoreX(zz) - 80, b.entryX);
  let waterX = startX;
  for (let x = startX; x < b.maxX + 220; x += 2) {
    if (map.isWater(x, zz)) waterX = x;
    else {
      return { x: x + pad, z: zz, waterX };
    }
  }
  return { x: oceanBeachApproxShoreX(zz) + pad, z: zz, waterX };
}

/** 0 outside Ocean Beach, feathered across the authored surf strip. */
export function oceanBeachMask(x: number, z: number): number {
  const b = OCEAN_BEACH_SURF;
  const shore = Math.min(b.maxX, oceanBeachApproxShoreX(z));
  const xIn = smooth01((x - b.minX) / 70) * smooth01((shore - x) / 70);
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

/** 0..1 long-section envelope for the overhanging barrel roof. */
export function oceanBeachBarrelEnvelope(z: number, time: number): number {
  const b = OCEAN_BEACH_SURF;
  const phase = Math.cos(((z - b.entryZ) / b.barrelPeriod) * TAU - time * b.barrelDrift);
  return smooth01((phase - 0.05) / 0.55);
}

/** Cubic crown-to-lip roof height as a fraction of the live set amplitude. */
export function oceanBeachTubeRoofFraction(crestDistance: number): number {
  const b = OCEAN_BEACH_SURF;
  const u = clamp01(crestDistance / b.tubeSpan);
  const v = 1 - u;
  return (
    v * v * v +
    3 * v * v * u * b.tubeRoofControl1 +
    3 * v * u * u * b.tubeRoofControl2 +
    u * u * u * b.tubeRoofEnd
  );
}

/** Smooth signed-depth proxy: 1 on the authored tube line, 0 outside it. */
function tubeLineDepth(crestDistance: number): number {
  const b = OCEAN_BEACH_SURF;
  const lineDistance = Math.abs(crestDistance - b.tubeLineOffset);
  const t = clamp01((lineDistance - 0.35) / Math.max(0.01, b.tubeLineHalfWidth - 0.35));
  return 1 - smooth01(t);
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
  slopeZ: number;
  face: number;
  lip: number;
  crestDistance: number;
  crestX: number;
  slot: number;
  mask: number;
  amplitude: number;
  /** Roof-section availability at this along-beach location. */
  barrel: number;
  /** 0..1 position inside the surfable tube line. */
  tubeDepth: number;
  /** Absolute analytic roof height (sea-level frame; base chop is sub-metre). */
  tubeRoofY: number;
};

/**
 * Analytic sample for surf physics, camera and diagnostics. A locked slot keeps
 * every semantic region attached to the crest the controller already owns.
 */
export function sampleOceanBeachWave(
  x: number,
  z: number,
  time: number,
  lockedSlot?: number
): OceanBeachWaveSample {
  const mask = oceanBeachMask(x, z);
  const nearest = nearestOceanBeachCrest(x, z, time);
  const slot = lockedSlot ?? nearest.slot;
  const crestX = lockedSlot === undefined ? nearest.crestX : oceanBeachCrestX(slot, z, time);
  const crestDistance = x - crestX;
  const eps = 0.65;
  const epsZ = 1.2;
  const height = oceanBeachWaveHeight(x, z, time);
  const slopeX =
    (oceanBeachWaveHeight(x + eps, z, time) - oceanBeachWaveHeight(x - eps, z, time)) /
    (2 * eps);
  const slopeZ =
    (oceanBeachWaveHeight(x, z + epsZ, time) - oceanBeachWaveHeight(x, z - epsZ, time)) /
    (2 * epsZ);
  const amplitude = waveAmplitude(z, time, slot);
  // These gameplay channels deliberately match oceanBeachSurfField()'s visible
  // green wall and white lip. A wider invisible scoring band made the board
  // report "on the lip" while the rendered crest was several metres away.
  const face = mask * Math.exp(-0.5 * ((crestDistance - 4) / 5.5) ** 2);
  const lip = mask * Math.exp(-0.5 * ((crestDistance - 1) / 2.6) ** 2);
  const barrel = mask * oceanBeachBarrelEnvelope(z, time);
  const tubeDepth = barrel * tubeLineDepth(crestDistance);
  const tubeRoofY = amplitude * mask * oceanBeachTubeRoofFraction(crestDistance);
  return {
    height,
    slopeX,
    slopeZ,
    face,
    lip,
    crestDistance,
    crestX,
    slot,
    mask,
    amplitude,
    barrel,
    tubeDepth,
    tubeRoofY
  };
}

/** True when the player is close enough to the waterline to start surfing / carry a board. */
export function nearOceanBeachShore(
  x: number,
  z: number,
  opts: { shorePad?: number; inlandPad?: number; zPad?: number } = {}
): boolean {
  const b = OCEAN_BEACH_SURF;
  const shorePad = opts.shorePad ?? 90;
  const inlandPad = opts.inlandPad ?? 55;
  const zPad = opts.zPad ?? 80;
  if (z < b.minZ - zPad || z > b.maxZ + zPad) return false;
  const shore = oceanBeachApproxShoreX(z);
  return x > shore - shorePad && x < shore + inlandPad;
}

/** A deterministic little break-up used by spray/foam without allocating RNG state. */
export function oceanBeachFoamNoise(z: number, time: number, seed: number): number {
  return 0.5 + 0.5 * Math.sin(z * 0.071 + time * (1.7 + seed * 0.03) + seed * TAU * 0.618);
}
