// Botanical species intent for the one native tree/foliage runtime. Species
// index matches GARDEN_SPECIES; null is the shared tree-fern shrub profile.

import type { NativeTreeDesignSpec } from "../nativeTreeForest";

export type NativeTreeDesign = NativeTreeDesignSpec | null;

export const NATIVE_TREE_DESIGNS: readonly NativeTreeDesign[] = [
  {
    species: "coast-redwood",
    seed: 11,
    controls: { height: 27, crownDensity: 0.94, crownWidth: 0.86, foliageColor: 0x496835 },
    sink: 0.25
  },
  {
    species: "magnolia",
    seed: 22,
    controls: { height: 9, crownDensity: 1.05, crownWidth: 0.78, foliageColor: 0x66783f },
    sink: 0.2
  },
  {
    species: "monterey-cypress",
    seed: 33,
    controls: { height: 12, crownDensity: 0.95, crownWidth: 0.82, foliageColor: 0x3f5f34 },
    sink: 0.25
  },
  null,
  {
    species: "coast-live-oak",
    seed: 44,
    controls: { height: 12, crownDensity: 0.92, crownWidth: 0.88, foliageColor: 0x4c6735 },
    sink: 0.25
  },
  {
    species: "japanese-maple",
    seed: 55,
    controls: {
      height: 7,
      crownDensity: 1.08,
      crownWidth: 0.72,
      foliageColor: 0x744a38,
      foliageTint: 0xb26c4e,
      leafColorVariant: "autumn"
    },
    sink: 0.2
  },
  {
    species: "eucalyptus",
    seed: 66,
    controls: { height: 17, crownDensity: 0.9, crownWidth: 0.85, foliageColor: 0x5a6b3d },
    sink: 0.25
  },
  {
    species: "chilean-palm",
    seed: 77,
    controls: { height: 14, crownDensity: 1.08 },
    sink: 0.2,
    nearDetail: false
  }
] as const;
