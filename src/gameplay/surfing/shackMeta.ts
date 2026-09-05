import { OCEAN_BEACH_SURF, oceanBeachApproxShoreX, oceanBeachShoreline } from "../../world/oceanBeachWaves";

/** Metres east of the live shoreline to the shack building centre. */
export const SURF_SHACK_INLAND = 20;
/** Metres east of the shoreline for the spawn / exit apron (facing the boards). */
export const SURF_SHACK_APRON_INLAND = 17;
/** Reach to grab a racked board. */
export const SURF_BOARD_REACH = 2.6;

export type SurfShackPose = { x: number; z: number; heading: number };

/** Approx apron pose without a live map (spawn registry). */
export function oceanBeachSurfShackApproxPose(): SurfShackPose {
  const z = OCEAN_BEACH_SURF.entryZ;
  return {
    x: oceanBeachApproxShoreX(z) + SURF_SHACK_APRON_INLAND,
    z,
    heading: -Math.PI / 2 // east, toward the open shack front
  };
}

/** Live shoreline-refined apron pose (boot, landmark, surf exit). */
export function oceanBeachSurfShackPose(map: { isWater(x: number, z: number): boolean }): SurfShackPose {
  const shore = oceanBeachShoreline(map, OCEAN_BEACH_SURF.entryZ, 3);
  return {
    x: shore.x + (SURF_SHACK_APRON_INLAND - 3),
    z: shore.z,
    heading: -Math.PI / 2
  };
}

