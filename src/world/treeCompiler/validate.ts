import { TreeRecipeError, type NumberRange, type TreeRecipe } from "./types.ts";

export type ResolvedCompileLimits = {
  maxBranches: number;
  maxFoliageAnchors: number;
  maxVerticesPerLod: number;
};

const DEFAULT_LIMITS: ResolvedCompileLimits = {
  maxBranches: 8_192,
  maxFoliageAnchors: 100_000,
  maxVerticesPerLod: 4_000_000
};

function fail(path: string, message: string): never {
  throw new TreeRecipeError(path, message);
}

function finite(path: string, value: number): void {
  if (!Number.isFinite(value)) fail(path, "must be finite");
}

function numberIn(path: string, value: number, min: number, max: number): void {
  finite(path, value);
  if (value < min || value > max) fail(path, `must be in [${min}, ${max}]`);
}

function integerIn(path: string, value: number, min: number, max: number): void {
  numberIn(path, value, min, max);
  if (!Number.isInteger(value)) fail(path, "must be an integer");
}

function rangeIn(path: string, value: NumberRange, min: number, max: number): void {
  if (!Array.isArray(value) || value.length !== 2) fail(path, "must be a [min, max] tuple");
  numberIn(`${path}[0]`, value[0], min, max);
  numberIn(`${path}[1]`, value[1], min, max);
  if (value[0] > value[1]) fail(path, "minimum must not exceed maximum");
}

function optionalPositiveInteger(path: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  integerIn(path, value, 1, 100_000_000);
  return value;
}

export function validateTreeRecipe(recipe: TreeRecipe): ResolvedCompileLimits {
  if (recipe.version !== 1) fail("version", "only version 1 recipes are supported");
  if (typeof recipe.name !== "string" || recipe.name.trim().length === 0) fail("name", "must not be empty");
  numberIn("height", recipe.height, 0.5, 250);

  integerIn("trunk.segments", recipe.trunk.segments, 2, 128);
  numberIn("trunk.radius", recipe.trunk.radius, 0.005, recipe.height * 0.5);
  numberIn("trunk.tipRadiusRatio", recipe.trunk.tipRadiusRatio, 0.001, 1);
  numberIn("trunk.flare", recipe.trunk.flare, 0, 8);
  numberIn("trunk.curveDeg", recipe.trunk.curveDeg, -180, 180);
  numberIn("trunk.curveNoiseDeg", recipe.trunk.curveNoiseDeg, 0, 90);
  numberIn("trunk.leanDeg", recipe.trunk.leanDeg, 0, 80);
  if (recipe.trunk.leanAzimuthDeg !== undefined) finite("trunk.leanAzimuthDeg", recipe.trunk.leanAzimuthDeg);
  numberIn("trunk.barkRepeat", recipe.trunk.barkRepeat, 0.01, 100);

  if (!Array.isArray(recipe.branchLevels)) fail("branchLevels", "must be an array");
  if (recipe.branchLevels.length > 5) fail("branchLevels", "supports at most 5 recursive levels");

  recipe.branchLevels.forEach((level, index) => {
    const path = `branchLevels[${index}]`;
    integerIn(`${path}.count`, level.count, 1, 64);
    integerIn(`${path}.segments`, level.segments, 1, 64);
    numberIn(`${path}.start`, level.start, 0, 1);
    numberIn(`${path}.end`, level.end, 0, 1);
    if (level.start >= level.end) fail(path, "start must be less than end");
    rangeIn(`${path}.lengthRatio`, level.lengthRatio, 0.01, 1.5);
    rangeIn(`${path}.radiusRatio`, level.radiusRatio, 0.01, 1);
    numberIn(`${path}.downAngleDeg`, level.downAngleDeg, -20, 170);
    numberIn(`${path}.downAngleJitterDeg`, level.downAngleJitterDeg, 0, 90);
    if (level.rotateDeg !== undefined) finite(`${path}.rotateDeg`, level.rotateDeg);
    numberIn(`${path}.rotateJitterDeg`, level.rotateJitterDeg, 0, 180);
    numberIn(`${path}.curveDeg`, level.curveDeg, -360, 360);
    numberIn(`${path}.curveJitterDeg`, level.curveJitterDeg, 0, 180);
    numberIn(`${path}.gravity`, level.gravity, -2, 2);
    numberIn(`${path}.taper`, level.taper, 0, 1);
  });

  if (!(["leaf", "needle", "rosette"] as const).includes(recipe.foliage.kind)) {
    fail("foliage.kind", "must be leaf, needle, or rosette");
  }
  const placement = recipe.foliage.placement;
  integerIn("foliage.placement.minBranchLevel", placement.minBranchLevel, 0, recipe.branchLevels.length);
  numberIn("foliage.placement.start", placement.start, 0, 1);
  numberIn("foliage.placement.end", placement.end, 0, 1);
  if (placement.start >= placement.end) fail("foliage.placement", "start must be less than end");
  numberIn("foliage.placement.anchorsPerMeter", placement.anchorsPerMeter, 0.001, 10_000);
  numberIn("foliage.placement.tipBias", placement.tipBias, 0.1, 10);
  integerIn("foliage.placement.whorlSize", placement.whorlSize, 1, 32);
  if (placement.phyllotaxisDeg !== undefined) finite("foliage.placement.phyllotaxisDeg", placement.phyllotaxisDeg);
  numberIn("foliage.placement.azimuthJitterDeg", placement.azimuthJitterDeg, 0, 180);
  integerIn("foliage.placement.maxAnchors", placement.maxAnchors, 1, 100_000_000);
  rangeIn("foliage.length", recipe.foliage.length, 0.001, recipe.height);
  rangeIn("foliage.width", recipe.foliage.width, 0.001, recipe.height);
  numberIn("foliage.outwardAngleDeg", recipe.foliage.outwardAngleDeg, -20, 180);
  numberIn("foliage.outwardAngleJitterDeg", recipe.foliage.outwardAngleJitterDeg, 0, 180);
  numberIn("foliage.droop", recipe.foliage.droop, -2, 2);
  numberIn("foliage.stiffness", recipe.foliage.stiffness, 0, 4);
  if (recipe.foliage.needleBlades !== undefined) {
    integerIn("foliage.needleBlades", recipe.foliage.needleBlades, 1, 12);
  }
  if (recipe.foliage.rosettePetals !== undefined) {
    integerIn("foliage.rosettePetals", recipe.foliage.rosettePetals, 3, 32);
  }

  if (!Array.isArray(recipe.lods) || recipe.lods.length === 0) fail("lods", "needs at least one LOD");
  if (recipe.lods.length > 8) fail("lods", "supports at most 8 LODs");
  const names = new Set<string>();
  recipe.lods.forEach((lod, index) => {
    const path = `lods[${index}]`;
    if (typeof lod.name !== "string" || lod.name.trim().length === 0) fail(`${path}.name`, "must not be empty");
    if (names.has(lod.name)) fail(`${path}.name`, "must be unique");
    names.add(lod.name);
    numberIn(`${path}.branchRetention`, lod.branchRetention, 0, 1);
    numberIn(`${path}.foliageRetention`, lod.foliageRetention, 0, 1);
    integerIn(`${path}.maxBranchLevel`, lod.maxBranchLevel, 0, recipe.branchLevels.length);
    integerIn(`${path}.radialSegments`, lod.radialSegments, 3, 24);
    integerIn(`${path}.axialStride`, lod.axialStride, 1, 64);
    numberIn(`${path}.foliageScale`, lod.foliageScale, 0.1, 8);

    const previous = recipe.lods[index - 1];
    if (!previous) return;
    if (lod.branchRetention > previous.branchRetention) {
      fail(`${path}.branchRetention`, "farther LODs must retain no more branches");
    }
    if (lod.foliageRetention > previous.foliageRetention) {
      fail(`${path}.foliageRetention`, "farther LODs must retain no more foliage");
    }
    if (lod.maxBranchLevel > previous.maxBranchLevel) {
      fail(`${path}.maxBranchLevel`, "farther LODs must not restore branch levels");
    }
    if (lod.radialSegments > previous.radialSegments) {
      fail(`${path}.radialSegments`, "farther LODs must not add tube sides");
    }
    if (lod.axialStride < previous.axialStride) {
      fail(`${path}.axialStride`, "farther LODs must not add centerline samples");
    }
  });

  if (recipe.shadow?.opacity !== undefined) numberIn("shadow.opacity", recipe.shadow.opacity, 0, 1);
  if (recipe.shadow?.preferredLod !== undefined && !names.has(recipe.shadow.preferredLod)) {
    fail("shadow.preferredLod", "must name one of the compiled LODs");
  }

  const limits: ResolvedCompileLimits = {
    maxBranches: optionalPositiveInteger("limits.maxBranches", recipe.limits?.maxBranches, DEFAULT_LIMITS.maxBranches),
    maxFoliageAnchors: optionalPositiveInteger(
      "limits.maxFoliageAnchors",
      recipe.limits?.maxFoliageAnchors,
      DEFAULT_LIMITS.maxFoliageAnchors
    ),
    maxVerticesPerLod: optionalPositiveInteger(
      "limits.maxVerticesPerLod",
      recipe.limits?.maxVerticesPerLod,
      DEFAULT_LIMITS.maxVerticesPerLod
    )
  };

  let estimatedBranches = 1;
  let parentsAtLevel = 1;
  for (const level of recipe.branchLevels) {
    parentsAtLevel *= level.count;
    estimatedBranches += parentsAtLevel;
    if (estimatedBranches > limits.maxBranches) {
      fail("branchLevels", `can emit ${estimatedBranches} branches, over the ${limits.maxBranches} branch limit`);
    }
  }
  if (placement.maxAnchors > limits.maxFoliageAnchors) {
    fail(
      "foliage.placement.maxAnchors",
      `exceeds the ${limits.maxFoliageAnchors} compiler anchor limit`
    );
  }

  return limits;
}
