// Public shared-vegetation boundary for authored flower beds and park patches.
// Geometry/material ownership currently lives beside the wildlands scatter
// strategy, but every consumer imports it through this renderer-neutral module.

export {
  createAuthoredFlowerPatch,
  type AuthoredFlowerPalette,
  type AuthoredFlowerPlacement,
  type AuthoredFlowerSpecies
} from "../wildlands/flowerRing";
