// Botanical species intent for the shared authored-tree/SeedForest runtime.
// Species index matches GARDEN_SPECIES; null means the shared fern shrub profile
// owns that botanical form instead of the tree renderer.

import type { SeedTreeDesignSpec } from "../seedForest";

export type SeedTreeDesign = SeedTreeDesignSpec | null;

const GARDEN_GENERATION: NonNullable<SeedTreeDesignSpec["generation"]> = {
  lod: { lod1Dist: 40, lod2Dist: 90, lod2Pct: 4, lod2Prune: 0.55, lod2Density: 0.8 },
  foliageGrade: { colorScale: 0.5, tint: 0x4e623a, tintMix: 0.45 }
};

export const SEED_TREE_DESIGNS: readonly SeedTreeDesign[] = [
  {
    species: "douglasFir",
    seed: 11,
    controls: { height: 27, branchDensity: 34, leavesPerBranch: 22, leafColorize: 0x496835, leafTintAmount: 0.42 },
    sink: 0.25,
    generation: GARDEN_GENERATION
  },
  { species: "tulipPoplar", seed: 22, controls: { height: 9, leafColorize: 0x66783f, leafTintAmount: 0.58 }, sink: 0.2, generation: GARDEN_GENERATION },
  { species: "pine", seed: 33, controls: { height: 12, branchDensity: 30, leavesPerBranch: 20, leafColorize: 0x3f5f34, leafTintAmount: 0.45 }, sink: 0.25, generation: GARDEN_GENERATION },
  null,
  { species: "whiteOak", seed: 44, controls: { height: 12, leafColorize: 0x4c6735, leafTintAmount: 0.52 }, sink: 0.25, generation: GARDEN_GENERATION },
  { species: "redMaple", seed: 55, controls: { height: 7, leafColorize: 0x744a38, leafTintAmount: 0.42 }, sink: 0.2, generation: GARDEN_GENERATION },
  { species: "americanBeech", seed: 66, controls: { height: 17, leafColorize: 0x5a6b3d, leafTintAmount: 0.5 }, sink: 0.25, generation: GARDEN_GENERATION },
  {
    species: "joshuaTree",
    seed: 77,
    controls: { trunkHeight: 3.4, armLength: 1.15 },
    sink: 0.2,
    nearClones: false,
    generation: GARDEN_GENERATION
  }
] as const;
