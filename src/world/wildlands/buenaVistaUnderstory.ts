// Buena Vista close-only understory.
//
// This module is a deliberate nested lazy boundary. The park's skyline canopy
// can activate from Corona Heights without fetching the shared shrub renderer;
// woody scrub is requested only when the camera reaches the park itself.

import {
  createAuthoredShrubPatch,
  type AuthoredShrubPalette,
  type AuthoredShrubPatch,
  type AuthoredShrubPlacement
} from "../vegetation/authoredShrubs";
import type { GardenTerrain } from "../garden/layout";
import { collectBuenaVistaShrubs, type WildTreeExclusion } from "./layout";

const BUENA_VISTA_SHRUB_PALETTES: readonly AuthoredShrubPalette[] = [
  // Dark coffeeberry / toyon shade pockets.
  { foliageA: 0x203b2b, foliageB: 0x536a45 },
  // A cooler, grey-green coastal scrub minority catches the mist and backlight.
  { foliageA: 0x3d5543, foliageB: 0x7b8960 }
] as const;

export type BuenaVistaUnderstory = AuthoredShrubPatch;

export function createBuenaVistaUnderstory(
  map: GardenTerrain,
  excluded?: WildTreeExclusion
): BuenaVistaUnderstory {
  const placements: AuthoredShrubPlacement[] = collectBuenaVistaShrubs(map, excluded).map((shrub) => ({
    ...shrub,
    profile: "coastal-scrub",
    wind: 0.52
  }));
  return createAuthoredShrubPatch(placements, {
    name: "buena_vista_coastal_scrub",
    palettes: BUENA_VISTA_SHRUB_PALETTES
  });
}
