/**
 * Golden Gate Park Archery Field — pure layout math (no three, no host
 * imports), mirroring wildlands/layout.ts discipline so the foliage keep-out
 * can consume the same predicate the game builds from.
 *
 * Real place: the archery field in the park's NW corner near 47th Ave
 * (~lat 37.7712, lon -122.5069). Projection x=(lon+122.444)*87972,
 * z=(37.79-lat)*110574 puts the field at ≈ (-5533, 2079), inside the ggpark
 * wild region — the keep-out below clears the lanes of the forest matrix.
 *
 * Frame: yaw `a` names the DOWNRANGE direction as (sin a, cos a) in xz —
 * the same yaw convention golf's teeAim uses. The real field shoots roughly
 * west→east along the flat dune shelf, so downrange = +X (a = π/2); the
 * probe confirmed the groundTop slope along that axis stays gentle.
 */

export const ARCHERY_CENTER = { x: -5533, z: 2079 } as const;

/** Downrange yaw: dir = (sin, cos) = +X (east). */
export const ARCHERY_YAW = Math.PI / 2;

/** Downrange unit vector components (world xz). */
export const ARCHERY_DIR = { x: Math.sin(ARCHERY_YAW), z: Math.cos(ARCHERY_YAW) } as const;
/** Lateral unit vector (to the shooter's right when facing downrange). */
export const ARCHERY_LAT = { x: Math.cos(ARCHERY_YAW), z: -Math.sin(ARCHERY_YAW) } as const;

/** The shooting line sits upstream of the field centre so the longest lane
 *  still lands inside the AABB with apron to spare. */
export const SHOOTING_LINE = {
  x: ARCHERY_CENTER.x - ARCHERY_DIR.x * 14,
  z: ARCHERY_CENTER.z - ARCHERY_DIR.z * 14
} as const;

export const LANE_SPACING = 4;
/** Target distances per lane (metres from the shooting line), short→long
 *  across the field like a real club range. */
export const LANE_DISTANCES = [15, 18, 22, 25, 28] as const;
export const LANE_COUNT = LANE_DISTANCES.length;

/** Half-extents of the playable footprint in the range's local frame:
 *  u = downrange metres past the shooting line, v = lateral metres. */
const U_MIN = -10; // apron behind the shooting line (rack, sign, hay)
const U_MAX = 38; // longest butt at 28 m + overshoot apron
const V_HALF = 13;

/** Range-local coordinates of a world point: u downrange from the shooting
 *  line, v lateral (+ = shooter's right). */
export function archeryLocal(x: number, z: number): { u: number; v: number } {
  const dx = x - SHOOTING_LINE.x;
  const dz = z - SHOOTING_LINE.z;
  return {
    u: dx * ARCHERY_DIR.x + dz * ARCHERY_DIR.z,
    v: dx * ARCHERY_LAT.x + dz * ARCHERY_LAT.z
  };
}

/** Footprint + pad test — the site gate's `contains`, and the wildlands
 *  foliage keep-out (trees pad wider so no canopy leans over the lanes). */
export function inArcheryRange(x: number, z: number, pad = 0): boolean {
  const dx = x - SHOOTING_LINE.x;
  const dz = z - SHOOTING_LINE.z;
  const u = dx * ARCHERY_DIR.x + dz * ARCHERY_DIR.z;
  if (u < U_MIN - pad || u > U_MAX + pad) return false;
  const v = dx * ARCHERY_LAT.x + dz * ARCHERY_LAT.z;
  return v >= -V_HALF - pad && v <= V_HALF + pad;
}

/** Lateral offset of lane i (0..4), centred on the field. */
export function laneV(lane: number): number {
  return (lane - (LANE_COUNT - 1) / 2) * LANE_SPACING;
}

/** World xz of lane i's spot on the shooting line. */
export function laneLineXZ(lane: number): { x: number; z: number } {
  const v = laneV(lane);
  return { x: SHOOTING_LINE.x + ARCHERY_LAT.x * v, z: SHOOTING_LINE.z + ARCHERY_LAT.z * v };
}

/** World xz of lane i's target butt. */
export function laneTargetXZ(lane: number): { x: number; z: number } {
  const v = laneV(lane);
  const d = LANE_DISTANCES[lane];
  return {
    x: SHOOTING_LINE.x + ARCHERY_LAT.x * v + ARCHERY_DIR.x * d,
    z: SHOOTING_LINE.z + ARCHERY_LAT.z * v + ARCHERY_DIR.z * d
  };
}
