import type {
  TreeBranchLevelRecipe,
  TreeFoliageRecipe,
  FoliagePlacementRecipe,
  TreeLodRecipe,
  TreeRecipe
} from "../treeCompiler/types";

export type NativeTreeSpecies =
  | "coast-redwood"
  | "monterey-cypress"
  | "coast-live-oak"
  | "eucalyptus"
  | "japanese-black-pine"
  | "japanese-maple"
  | "flowering-cherry"
  | "ginkgo"
  | "magnolia"
  | "chilean-palm";

export type NativeTreeControls = {
  height?: number;
  crownDensity?: number;
  crownWidth?: number;
  foliageColor?: number;
  foliageTint?: number;
  barkColor?: number;
  windResponse?: number;
  /** Select a lazy seasonal/biome color map; null requests the default map. */
  leafColorVariant?: string | null;
};

export type NativeTreeStyle = Readonly<{
  foliageFamily: "conifer-needle" | "broadleaf" | "fan-leaf" | "blossom" | "palm-frond";
  leafColorVariant?: string;
  foliageColor: number;
  foliageAccent: number;
  barkColor: number;
  barkAccent: number;
  windAmplitude: number;
}>;

export type NativeTreeArchetype = Readonly<{
  species: NativeTreeSpecies;
  recipe: TreeRecipe;
  style: NativeTreeStyle;
}>;

const LODS: readonly TreeLodRecipe[] = [
  {
    name: "canopy",
    branchRetention: 1,
    foliageRetention: 1,
    maxBranchLevel: 3,
    radialSegments: 7,
    axialStride: 1,
    foliageScale: 1
  },
  {
    name: "grove",
    branchRetention: 0.68,
    foliageRetention: 0.58,
    maxBranchLevel: 3,
    radialSegments: 5,
    axialStride: 2,
    foliageScale: 1.12
  },
  {
    name: "landscape",
    branchRetention: 0.28,
    // More, smaller shapes read as a natural crown instead of oversized cards.
    // The compiler also retains every selected anchor's support hierarchy.
    foliageRetention: 0.36,
    maxBranchLevel: 2,
    radialSegments: 4,
    axialStride: 3,
    foliageScale: 1.5
  },
  {
    name: "horizon",
    branchRetention: 0.14,
    foliageRetention: 0.18,
    maxBranchLevel: 1,
    radialSegments: 3,
    axialStride: 4,
    foliageScale: 1.9
  }
];

function lods(maxBranchLevel: number): readonly TreeLodRecipe[] {
  return LODS.map((lod) => ({ ...lod, maxBranchLevel: Math.min(lod.maxBranchLevel, maxBranchLevel) }));
}

function level(
  count: number,
  segments: number,
  start: number,
  end: number,
  lengthRatio: readonly [number, number],
  radiusRatio: readonly [number, number],
  downAngleDeg: number,
  curveDeg: number,
  gravity: number,
  overrides: Partial<TreeBranchLevelRecipe> = {}
): TreeBranchLevelRecipe {
  return {
    count,
    segments,
    start,
    end,
    lengthRatio,
    radiusRatio,
    downAngleDeg,
    downAngleJitterDeg: 9,
    rotateJitterDeg: 13,
    curveDeg,
    curveJitterDeg: 10,
    gravity,
    taper: 0.86,
    ...overrides
  };
}

function foliage(
  kind: TreeFoliageRecipe["kind"],
  overrides: Partial<Omit<TreeFoliageRecipe, "placement">> & {
    placement?: Partial<FoliagePlacementRecipe>;
  } = {}
): TreeFoliageRecipe {
  return {
    kind,
    length: [0.34, 0.58],
    width: [0.2, 0.36],
    outwardAngleDeg: 58,
    outwardAngleJitterDeg: 18,
    droop: 0.08,
    stiffness: 0.48,
    ...overrides,
    placement: {
      minBranchLevel: 2,
      start: 0.36,
      end: 1,
      anchorsPerMeter: 0.95,
      tipBias: 1.45,
      whorlSize: 2,
      azimuthJitterDeg: 18,
      maxAnchors: 950,
      ...overrides.placement
    }
  };
}

const RECIPES: Record<NativeTreeSpecies, TreeRecipe> = {
  "coast-redwood": {
    version: 1,
    name: "coast-redwood",
    height: 28,
    trunk: {
      segments: 18,
      radius: 0.82,
      tipRadiusRatio: 0.035,
      flare: 0.58,
      curveDeg: 2.5,
      curveNoiseDeg: 2.8,
      leanDeg: 1.8,
      barkRepeat: 2.8
    },
    branchLevels: [
      level(22, 6, 0.2, 0.94, [0.16, 0.29], [0.25, 0.38], 72, -5, 0.02, {
        downAngleJitterDeg: 11,
        rotateJitterDeg: 7
      }),
      level(4, 4, 0.32, 1, [0.3, 0.56], [0.3, 0.46], 54, 8, 0.03)
    ],
    foliage: foliage("needle", {
      placement: { minBranchLevel: 1, anchorsPerMeter: 1.7, whorlSize: 2, maxAnchors: 1_800 },
      length: [0.58, 0.9],
      width: [0.36, 0.56],
      outwardAngleDeg: 36,
      droop: 0.035,
      stiffness: 0.68,
      needleBlades: 2
    }),
    lods: lods(2),
    shadow: { opacity: 0.84, preferredLod: "landscape" },
    limits: { maxBranches: 256, maxFoliageAnchors: 1_800, maxVerticesPerLod: 80_000 }
  },
  "monterey-cypress": {
    version: 1,
    name: "monterey-cypress",
    height: 15,
    trunk: {
      segments: 13,
      radius: 0.58,
      tipRadiusRatio: 0.075,
      flare: 0.34,
      curveDeg: 11,
      curveNoiseDeg: 8,
      leanDeg: 7,
      leanAzimuthDeg: 72,
      barkRepeat: 2.1
    },
    branchLevels: [
      level(13, 6, 0.18, 0.92, [0.34, 0.58], [0.28, 0.46], 62, 12, -0.02, {
        rotateJitterDeg: 24,
        curveJitterDeg: 22
      }),
      level(5, 4, 0.25, 1, [0.35, 0.62], [0.3, 0.48], 52, 15, 0.01)
    ],
    foliage: foliage("needle", {
      placement: { minBranchLevel: 1, anchorsPerMeter: 1.9, whorlSize: 2, maxAnchors: 1_600 },
      length: [0.54, 0.84],
      width: [0.4, 0.62],
      outwardAngleDeg: 42,
      droop: 0.02,
      stiffness: 0.62,
      needleBlades: 2
    }),
    lods: lods(2),
    shadow: { opacity: 0.82, preferredLod: "landscape" },
    limits: { maxBranches: 192, maxFoliageAnchors: 1_600, maxVerticesPerLod: 72_000 }
  },
  "coast-live-oak": {
    version: 1,
    name: "coast-live-oak",
    height: 12.5,
    trunk: {
      segments: 11,
      radius: 0.64,
      tipRadiusRatio: 0.11,
      flare: 0.48,
      curveDeg: 14,
      curveNoiseDeg: 7,
      leanDeg: 4,
      barkRepeat: 1.65
    },
    branchLevels: [
      level(9, 6, 0.18, 0.82, [0.38, 0.65], [0.34, 0.55], 58, 16, 0.05, {
        rotateJitterDeg: 28,
        curveJitterDeg: 24
      }),
      level(5, 4, 0.18, 1, [0.36, 0.64], [0.28, 0.46], 48, 18, 0.06),
      level(2, 3, 0.38, 1, [0.34, 0.58], [0.28, 0.42], 45, 10, 0.08)
    ],
    foliage: foliage("leaf", {
      placement: { minBranchLevel: 2, anchorsPerMeter: 1.9, whorlSize: 3, maxAnchors: 1_800 },
      length: [0.38, 0.62],
      width: [0.3, 0.5],
      outwardAngleDeg: 63,
      droop: 0.1,
      stiffness: 0.42
    }),
    lods: lods(3),
    shadow: { opacity: 0.8, preferredLod: "landscape" },
    limits: { maxBranches: 192, maxFoliageAnchors: 1_800, maxVerticesPerLod: 72_000 }
  },
  eucalyptus: {
    version: 1,
    name: "eucalyptus",
    height: 18,
    trunk: {
      segments: 15,
      radius: 0.56,
      tipRadiusRatio: 0.06,
      flare: 0.18,
      curveDeg: 10,
      curveNoiseDeg: 6,
      leanDeg: 5,
      barkRepeat: 2.45
    },
    branchLevels: [
      level(11, 6, 0.26, 0.9, [0.28, 0.48], [0.27, 0.43], 48, 10, -0.03, {
        rotateJitterDeg: 21
      }),
      level(4, 4, 0.3, 1, [0.38, 0.62], [0.28, 0.44], 45, 9, 0.02),
      level(2, 3, 0.42, 1, [0.34, 0.54], [0.25, 0.38], 50, 6, 0.04)
    ],
    foliage: foliage("leaf", {
      placement: { minBranchLevel: 2, anchorsPerMeter: 1.15, whorlSize: 2, maxAnchors: 1_100 },
      length: [0.5, 0.82],
      width: [0.16, 0.28],
      outwardAngleDeg: 44,
      droop: 0.16,
      stiffness: 0.36
    }),
    lods: lods(3),
    shadow: { opacity: 0.68, preferredLod: "landscape" },
    limits: { maxBranches: 192, maxFoliageAnchors: 1_100, maxVerticesPerLod: 64_000 }
  },
  "japanese-black-pine": {
    version: 1,
    name: "japanese-black-pine",
    height: 9.5,
    trunk: {
      segments: 11,
      radius: 0.42,
      tipRadiusRatio: 0.08,
      flare: 0.28,
      curveDeg: 17,
      curveNoiseDeg: 8,
      leanDeg: 8,
      barkRepeat: 1.25
    },
    branchLevels: [
      level(10, 6, 0.16, 0.92, [0.32, 0.56], [0.3, 0.46], 72, 18, 0.08, {
        rotateDeg: 137.5,
        rotateJitterDeg: 25,
        curveJitterDeg: 28
      }),
      level(4, 4, 0.3, 1, [0.38, 0.66], [0.27, 0.44], 55, 12, 0.04)
    ],
    foliage: foliage("needle", {
      placement: { minBranchLevel: 1, start: 0.45, anchorsPerMeter: 2.2, whorlSize: 3, maxAnchors: 1_500 },
      length: [0.75, 1.15],
      width: [0.42, 0.68],
      outwardAngleDeg: 35,
      droop: 0.035,
      stiffness: 0.72,
      needleBlades: 2
    }),
    lods: lods(2),
    shadow: { opacity: 0.78, preferredLod: "landscape" },
    limits: { maxBranches: 128, maxFoliageAnchors: 1_500, maxVerticesPerLod: 64_000 }
  },
  "japanese-maple": {
    version: 1,
    name: "japanese-maple",
    height: 7.2,
    trunk: {
      segments: 10,
      radius: 0.3,
      tipRadiusRatio: 0.08,
      flare: 0.2,
      curveDeg: 12,
      curveNoiseDeg: 7,
      leanDeg: 4,
      barkRepeat: 1.2
    },
    branchLevels: [
      level(8, 5, 0.18, 0.86, [0.42, 0.68], [0.32, 0.5], 52, 15, 0.04, {
        rotateJitterDeg: 30
      }),
      level(5, 4, 0.2, 1, [0.4, 0.68], [0.28, 0.44], 48, 14, 0.06),
      level(2, 3, 0.42, 1, [0.35, 0.58], [0.25, 0.39], 48, 8, 0.08)
    ],
    foliage: foliage("leaf", {
      placement: { minBranchLevel: 2, anchorsPerMeter: 2.35, whorlSize: 3, maxAnchors: 1_600 },
      length: [0.42, 0.68],
      width: [0.36, 0.62],
      outwardAngleDeg: 66,
      droop: 0.055,
      stiffness: 0.34
    }),
    lods: lods(3),
    shadow: { opacity: 0.7, preferredLod: "landscape" },
    limits: { maxBranches: 160, maxFoliageAnchors: 1_600, maxVerticesPerLod: 64_000 }
  },
  "flowering-cherry": {
    version: 1,
    name: "flowering-cherry",
    height: 7.8,
    trunk: {
      segments: 10,
      radius: 0.34,
      tipRadiusRatio: 0.09,
      flare: 0.22,
      curveDeg: 10,
      curveNoiseDeg: 6,
      leanDeg: 3,
      barkRepeat: 1.35
    },
    branchLevels: [
      level(9, 5, 0.2, 0.88, [0.4, 0.65], [0.32, 0.5], 50, 13, 0.035, {
        rotateJitterDeg: 27
      }),
      level(5, 4, 0.22, 1, [0.4, 0.66], [0.28, 0.44], 47, 14, 0.055),
      level(2, 3, 0.38, 1, [0.36, 0.58], [0.25, 0.38], 46, 8, 0.07)
    ],
    foliage: foliage("leaf", {
      placement: { minBranchLevel: 2, anchorsPerMeter: 2.25, whorlSize: 3, maxAnchors: 1_700 },
      length: [0.34, 0.54],
      width: [0.3, 0.5],
      outwardAngleDeg: 72,
      droop: 0.025,
      stiffness: 0.3
    }),
    lods: lods(3),
    shadow: { opacity: 0.7, preferredLod: "landscape" },
    limits: { maxBranches: 180, maxFoliageAnchors: 1_700, maxVerticesPerLod: 80_000 }
  },
  ginkgo: {
    version: 1,
    name: "ginkgo",
    height: 9,
    trunk: {
      segments: 11,
      radius: 0.34,
      tipRadiusRatio: 0.055,
      flare: 0.18,
      curveDeg: 4,
      curveNoiseDeg: 4,
      leanDeg: 2,
      barkRepeat: 1.5
    },
    branchLevels: [
      level(10, 5, 0.3, 0.92, [0.28, 0.49], [0.27, 0.43], 39, 5, -0.01, {
        rotateJitterDeg: 17
      }),
      level(4, 4, 0.32, 1, [0.38, 0.62], [0.27, 0.43], 44, 7, 0.02)
    ],
    foliage: foliage("leaf", {
      placement: { minBranchLevel: 1, anchorsPerMeter: 2.2, whorlSize: 3, maxAnchors: 1_300 },
      length: [0.46, 0.68],
      width: [0.42, 0.7],
      outwardAngleDeg: 68,
      droop: 0.05,
      stiffness: 0.44
    }),
    lods: lods(2),
    shadow: { opacity: 0.68, preferredLod: "landscape" },
    limits: { maxBranches: 128, maxFoliageAnchors: 1_300, maxVerticesPerLod: 56_000 }
  },
  magnolia: {
    version: 1,
    name: "magnolia",
    height: 9,
    trunk: {
      segments: 10,
      radius: 0.4,
      tipRadiusRatio: 0.1,
      flare: 0.26,
      curveDeg: 8,
      curveNoiseDeg: 5,
      leanDeg: 3,
      barkRepeat: 1.5
    },
    branchLevels: [
      level(9, 5, 0.2, 0.84, [0.42, 0.68], [0.32, 0.5], 50, 12, 0.05, {
        rotateJitterDeg: 24
      }),
      level(5, 4, 0.22, 1, [0.38, 0.64], [0.28, 0.43], 48, 12, 0.06),
      level(2, 3, 0.4, 1, [0.34, 0.56], [0.25, 0.38], 48, 7, 0.07)
    ],
    foliage: foliage("leaf", {
      placement: { minBranchLevel: 2, anchorsPerMeter: 1.75, whorlSize: 3, maxAnchors: 1_400 },
      length: [0.58, 0.86],
      width: [0.4, 0.64],
      outwardAngleDeg: 64,
      droop: 0.12,
      stiffness: 0.48
    }),
    lods: lods(3),
    shadow: { opacity: 0.75, preferredLod: "landscape" },
    limits: { maxBranches: 160, maxFoliageAnchors: 1_400, maxVerticesPerLod: 64_000 }
  },
  "chilean-palm": {
    version: 1,
    name: "chilean-palm",
    height: 14,
    trunk: {
      segments: 16,
      radius: 0.58,
      tipRadiusRatio: 0.82,
      flare: 0.18,
      curveDeg: 2,
      curveNoiseDeg: 1.5,
      leanDeg: 1.8,
      barkRepeat: 0.72
    },
    branchLevels: [],
    foliage: foliage("rosette", {
      placement: {
        minBranchLevel: 0,
        start: 0.94,
        end: 1,
        anchorsPerMeter: 2.3,
        tipBias: 2,
        whorlSize: 2,
        maxAnchors: 3
      },
      length: [3.8, 5.3],
      width: [0.5, 0.72],
      outwardAngleDeg: 78,
      droop: 0.24,
      stiffness: 0.58,
      rosettePetals: 13
    }),
    lods: lods(0),
    shadow: { opacity: 0.64, preferredLod: "landscape" },
    limits: { maxBranches: 4, maxFoliageAnchors: 3, maxVerticesPerLod: 12_000 }
  }
};

const STYLES: Record<NativeTreeSpecies, NativeTreeStyle> = {
  "coast-redwood": {
    foliageFamily: "conifer-needle",
    foliageColor: 0x365f39,
    foliageAccent: 0x789154,
    barkColor: 0x643d2b,
    barkAccent: 0x9a6440,
    windAmplitude: 0.58
  },
  "monterey-cypress": {
    foliageFamily: "conifer-needle",
    foliageColor: 0x2f5436,
    foliageAccent: 0x6d7c48,
    barkColor: 0x574034,
    barkAccent: 0x85624a,
    windAmplitude: 0.72
  },
  "coast-live-oak": {
    foliageFamily: "broadleaf",
    foliageColor: 0x3f6537,
    foliageAccent: 0x839653,
    barkColor: 0x5b4635,
    barkAccent: 0x806448,
    windAmplitude: 0.78
  },
  eucalyptus: {
    foliageFamily: "broadleaf",
    foliageColor: 0x56755b,
    foliageAccent: 0x9eaa78,
    barkColor: 0x8f8370,
    barkAccent: 0xc0b294,
    windAmplitude: 0.92
  },
  "japanese-black-pine": {
    foliageFamily: "conifer-needle",
    foliageColor: 0x315832,
    foliageAccent: 0x72854a,
    barkColor: 0x4b352a,
    barkAccent: 0x76513b,
    windAmplitude: 0.62
  },
  "japanese-maple": {
    foliageFamily: "fan-leaf",
    leafColorVariant: "autumn",
    foliageColor: 0x874a3c,
    foliageAccent: 0xc3774f,
    barkColor: 0x4e3b32,
    barkAccent: 0x76584a,
    windAmplitude: 0.9
  },
  "flowering-cherry": {
    foliageFamily: "blossom",
    leafColorVariant: "blossom",
    foliageColor: 0xb55f7c,
    foliageAccent: 0xf1b6c6,
    barkColor: 0x59413f,
    barkAccent: 0x865f59,
    windAmplitude: 0.95
  },
  ginkgo: {
    foliageFamily: "fan-leaf",
    leafColorVariant: "autumn",
    foliageColor: 0x8b9b48,
    foliageAccent: 0xd0bb54,
    barkColor: 0x5e4e3c,
    barkAccent: 0x8b704f,
    windAmplitude: 0.86
  },
  magnolia: {
    foliageFamily: "broadleaf",
    foliageColor: 0x3b6339,
    foliageAccent: 0x819254,
    barkColor: 0x62554a,
    barkAccent: 0x8e7861,
    windAmplitude: 0.76
  },
  "chilean-palm": {
    foliageFamily: "palm-frond",
    foliageColor: 0x4f7839,
    foliageAccent: 0x9ca552,
    barkColor: 0x7d6042,
    barkAccent: 0xad8558,
    windAmplitude: 1.05
  }
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createNativeTreeArchetype(
  species: NativeTreeSpecies,
  controls: NativeTreeControls = {}
): NativeTreeArchetype {
  const source = RECIPES[species];
  const sourceStyle = STYLES[species];
  const height = controls.height ?? source.height;
  const sizeRatio = height / source.height;
  const density = clamp(controls.crownDensity ?? 1, 0.45, 1.8);
  const width = clamp(controls.crownWidth ?? 1, 0.65, 1.45);
  const windResponse = clamp(controls.windResponse ?? 1, 0.35, 1.8);
  const recipe: TreeRecipe = {
    ...source,
    height,
    trunk: {
      ...source.trunk,
      radius: source.trunk.radius * Math.pow(sizeRatio, 0.82)
    },
    branchLevels: source.branchLevels.map((branch) => ({
      ...branch,
      lengthRatio: [branch.lengthRatio[0] * width, branch.lengthRatio[1] * width]
    })),
    foliage: {
      ...source.foliage,
      stiffness: clamp(source.foliage.stiffness / windResponse, 0, 4),
      placement: {
        ...source.foliage.placement,
        anchorsPerMeter: source.foliage.placement.anchorsPerMeter * density,
        maxAnchors: Math.max(1, Math.round(source.foliage.placement.maxAnchors * density))
      }
    },
    limits: {
      ...source.limits,
      maxFoliageAnchors: Math.max(1, Math.round((source.limits?.maxFoliageAnchors ?? 1_000) * density))
    }
  };
  return {
    species,
    recipe,
    style: {
      ...sourceStyle,
      leafColorVariant: controls.leafColorVariant === undefined
        ? sourceStyle.leafColorVariant
        : controls.leafColorVariant ?? undefined,
      foliageColor: controls.foliageColor ?? sourceStyle.foliageColor,
      foliageAccent: controls.foliageTint ?? sourceStyle.foliageAccent,
      barkColor: controls.barkColor ?? sourceStyle.barkColor,
      windAmplitude: sourceStyle.windAmplitude * windResponse
    }
  };
}

export const NATIVE_TREE_SPECIES = Object.freeze(Object.keys(RECIPES) as NativeTreeSpecies[]);
