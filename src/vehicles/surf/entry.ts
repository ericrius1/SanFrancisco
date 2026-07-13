import { waterHeight } from "../../world/heightmap";
import { OCEAN_BEACH_SURF, nearestOceanBeachCrest } from "../../world/oceanBeachWaves";
import { SURF_TUNING } from "./tuning";

export type SurfEntryPose = {
  x: number;
  y: number;
  z: number;
};

/** Broad activity neighborhood where surf entry preserves the player's Z. */
export function isOceanBeachSurfApproach(x: number, z: number): boolean {
  const b = OCEAN_BEACH_SURF;
  return (
    x > b.minX - 400 &&
    x < b.maxX + 500 &&
    z > b.minZ - 400 &&
    z < b.maxZ + 400
  );
}

/**
 * Pure entry projection used by Navigation's covered preview. SurfController
 * consumes that seeded destination, then locks the nearest live crest as it
 * enters; only the wave clock can advance between preview and commitment.
 */
export function oceanBeachSurfEntryPose(
  x: number,
  z: number,
  time: number,
  keepZ = isOceanBeachSurfApproach(x, z)
): SurfEntryPose {
  const b = OCEAN_BEACH_SURF;
  const tb = SURF_TUNING.values;
  const entryZ = keepZ
    ? Math.min(b.maxZ - tb.boundaryMargin - 4, Math.max(b.minZ + tb.boundaryMargin + 4, z))
    : b.entryZ;
  const crest = nearestOceanBeachCrest(b.entryX, entryZ, time);
  const entryX = crest.crestX + tb.faceOffset;
  return {
    x: entryX,
    y: Math.max(waterHeight(entryX, entryZ, time), 0) + tb.railHeight,
    z: entryZ
  };
}
