// Lightweight Wildlands geography shared by clean-boot gates, audio and the
// minimap. Planting recipes and collectors deliberately live in layout.ts so
// importing these bounds never pulls optional foliage code into the entry chunk.

import { BUENA_VISTA_REGION } from "../buenaVista";

export type WildRegionId = "ggpark" | "presidio" | "marin" | "twinpeaks" | "buenavista";

export type WildRegion = {
  id: WildRegionId;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Surface classes accepted by the region's planting collector. */
  plantClasses: readonly number[];
  /** Minimum terrain height used by shoreline planting gates. */
  minGround: number;
};

export const WILD_REGIONS: readonly WildRegion[] = [
  { id: "ggpark", minX: -5920, maxX: -760, minZ: 1780, maxZ: 2860, plantClasses: [1], minGround: -Infinity },
  { id: "presidio", minX: -3035, maxX: -200, minZ: -2250, maxZ: 180, plantClasses: [0, 1], minGround: -Infinity },
  { id: "marin", minX: -6300, maxX: -2700, minZ: -7800, maxZ: -5000, plantClasses: [0, 1], minGround: 2 },
  { id: "twinpeaks", minX: -1500, maxX: 350, minZ: 3150, maxZ: 4650, plantClasses: [1], minGround: -Infinity },
  { id: "buenavista", ...BUENA_VISTA_REGION, plantClasses: [1], minGround: -Infinity }
] as const;

export function wildRegionAt(x: number, z: number): WildRegion | null {
  for (const region of WILD_REGIONS) {
    if (
      x >= region.minX && x <= region.maxX &&
      z >= region.minZ && z <= region.maxZ
    ) return region;
  }
  return null;
}

/** True when a world-space disc touches any Wildlands region AABB. */
export function nearAnyWildRegion(x: number, z: number, reach: number): boolean {
  for (const region of WILD_REGIONS) {
    if (
      x >= region.minX - reach && x <= region.maxX + reach &&
      z >= region.minZ - reach && z <= region.maxZ + reach
    ) return true;
  }
  return false;
}
