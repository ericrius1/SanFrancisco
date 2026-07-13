import {
  VEC3_UP,
  add,
  basisFromTangent,
  clamp,
  degToRad,
  multiplyAdd,
  normalize,
  polylineLength,
  rotateAroundAxis,
  samplePolyline,
  scale,
  type Vec3
} from "./math.ts";
import { createTreeRng, hash32, hashQuantizedNumbers, randomUnit, type TreeRng } from "./rng.ts";
import { TreeCompileError, type CompiledTreeSkeleton, type TreeRecipe } from "./types.ts";
import type { ResolvedCompileLimits } from "./validate.ts";

const GOLDEN_ANGLE_DEG = 137.50776405003785;

export type SkeletonBranch = {
  id: number;
  parent: number;
  level: number;
  points: Vec3[];
  radii: number[];
  length: number;
  keepScore: number;
  windPhase: number;
};

export type FoliageAnchor = {
  id: number;
  branchId: number;
  position: Vec3;
  direction: Vec3;
  radial: Vec3;
  length: number;
  width: number;
  keepScore: number;
  windPhase: number;
  stiffness: number;
  height01: number;
  palette: number;
};

export type GeneratedTreeSkeleton = {
  branches: SkeletonBranch[];
  foliageAnchors: FoliageAnchor[];
  compiled: CompiledTreeSkeleton;
  fingerprint: string;
};

function interpolateRadius(branch: SkeletonBranch, segmentIndex: number, segmentT: number): number {
  return branch.radii[segmentIndex] +
    (branch.radii[segmentIndex + 1] - branch.radii[segmentIndex]) * segmentT;
}

function range(rng: TreeRng, values: readonly [number, number]): number {
  return rng.range(values[0], values[1]);
}

function createTrunk(recipe: TreeRecipe, seed: number): SkeletonBranch {
  const rng = createTreeRng(hash32(seed, 0x7472756e));
  const leanAzimuth = degToRad(recipe.trunk.leanAzimuthDeg ?? rng.range(0, 360));
  const lean = degToRad(recipe.trunk.leanDeg);
  let direction = normalize({
    x: Math.sin(lean) * Math.cos(leanAzimuth),
    y: Math.cos(lean),
    z: Math.sin(lean) * Math.sin(leanAzimuth)
  });
  const primaryBendAxis = normalize({ x: -Math.sin(leanAzimuth), y: 0, z: Math.cos(leanAzimuth) });
  const sideBendAxis = normalize({ x: Math.cos(leanAzimuth), y: 0, z: Math.sin(leanAzimuth) });
  const curvePerSpan = degToRad(recipe.trunk.curveDeg) / recipe.trunk.segments;
  const noiseMagnitude = degToRad(recipe.trunk.curveNoiseDeg) / recipe.trunk.segments;
  const noisePhase = rng.range(0, Math.PI * 2);
  const spanLength = recipe.height / recipe.trunk.segments;
  const points: Vec3[] = [{ x: 0, y: 0, z: 0 }];
  const radii: number[] = [];

  for (let index = 0; index <= recipe.trunk.segments; index++) {
    const t = index / recipe.trunk.segments;
    const taper = 1 + (recipe.trunk.tipRadiusRatio - 1) * t;
    const flare = 1 + recipe.trunk.flare * Math.pow(1 - t, 4);
    radii.push(recipe.trunk.radius * taper * flare);
    if (index === recipe.trunk.segments) break;

    const smoothNoise = Math.sin(noisePhase + t * Math.PI * 2.35) * noiseMagnitude;
    direction = rotateAroundAxis(direction, primaryBendAxis, curvePerSpan);
    direction = rotateAroundAxis(direction, sideBendAxis, smoothNoise);
    points.push(multiplyAdd(points[points.length - 1], direction, spanLength));
  }

  return {
    id: 0,
    parent: -1,
    level: 0,
    points,
    radii,
    length: polylineLength(points),
    keepScore: 1,
    windPhase: rng.range(0, Math.PI * 2)
  };
}

function createChildBranch(
  recipe: TreeRecipe,
  seed: number,
  parent: SkeletonBranch,
  levelIndex: number,
  childIndex: number,
  id: number
): SkeletonBranch {
  const level = recipe.branchLevels[levelIndex];
  const rng = createTreeRng(hash32(seed, Math.imul(parent.id + 1, 257) ^ Math.imul(levelIndex + 1, 65_537) ^ childIndex));
  const evenlySpaced = (childIndex + 0.5) / level.count;
  const spacing = (level.end - level.start) / level.count;
  const attachT = clamp(
    level.start + (level.end - level.start) * evenlySpaced + rng.range(-0.24, 0.24) * spacing,
    level.start,
    level.end
  );
  const attachment = samplePolyline(parent.points, attachT);
  const attachmentRadius = interpolateRadius(parent, attachment.segmentIndex, attachment.segmentT);
  const frame = basisFromTangent(attachment.tangent);
  const rotateStep = level.rotateDeg ?? GOLDEN_ANGLE_DEG;
  const azimuth = degToRad(
    rotateStep * childIndex +
      randomUnit(seed, parent.id * 31 + levelIndex * 997) * 360 +
      rng.range(-level.rotateJitterDeg, level.rotateJitterDeg)
  );
  const radial = normalize(add(scale(frame.normal, Math.cos(azimuth)), scale(frame.binormal, Math.sin(azimuth))));
  const downAngle = degToRad(level.downAngleDeg + rng.range(-level.downAngleJitterDeg, level.downAngleJitterDeg));
  let direction = normalize(
    add(scale(attachment.tangent, Math.cos(downAngle)), scale(radial, Math.sin(downAngle)))
  );
  const branchLength = parent.length * range(rng, level.lengthRatio) * (1 - attachT * 0.18);
  const baseRadius = Math.min(
    attachmentRadius * 0.92,
    attachmentRadius * range(rng, level.radiusRatio)
  );
  const curve = degToRad(level.curveDeg + rng.range(-level.curveJitterDeg, level.curveJitterDeg));
  const curveAxis = normalize(
    {
      x: direction.y * radial.z - direction.z * radial.y,
      y: direction.z * radial.x - direction.x * radial.z,
      z: direction.x * radial.y - direction.y * radial.x
    },
    frame.binormal
  );
  const curvePerSpan = curve / level.segments;
  const spanLength = branchLength / level.segments;
  const points: Vec3[] = [{ ...attachment.position }];
  const radii: number[] = [];
  const flutterPhase = rng.range(0, Math.PI * 2);

  for (let index = 0; index <= level.segments; index++) {
    const t = index / level.segments;
    radii.push(baseRadius * Math.max(0.025, 1 - level.taper * t));
    if (index === level.segments) break;

    direction = rotateAroundAxis(direction, curveAxis, curvePerSpan);
    const sideways = Math.sin(flutterPhase + t * Math.PI * 2) * degToRad(1.5) / level.segments;
    direction = rotateAroundAxis(direction, attachment.tangent, sideways);
    direction = normalize(add(direction, scale(VEC3_UP, -level.gravity / level.segments)));
    points.push(multiplyAdd(points[points.length - 1], direction, spanLength));
  }

  const relativeThickness = Math.sqrt(clamp(baseRadius / recipe.trunk.radius, 0, 1));
  const relativeLength = clamp(branchLength / recipe.height, 0, 1);
  const structuralBias = 0.82 - (levelIndex + 1) * 0.11 + relativeThickness * 0.25 + relativeLength * 0.12;
  const keepScore = clamp(structuralBias + rng.range(-0.22, 0.22), 0.02, 0.999_999);

  return {
    id,
    parent: parent.id,
    level: levelIndex + 1,
    points,
    radii,
    length: polylineLength(points),
    keepScore,
    windPhase: rng.range(0, Math.PI * 2)
  };
}

function growBranches(recipe: TreeRecipe, seed: number, limits: ResolvedCompileLimits): SkeletonBranch[] {
  const branches: SkeletonBranch[] = [createTrunk(recipe, seed)];
  let parents = [branches[0]];

  for (let levelIndex = 0; levelIndex < recipe.branchLevels.length; levelIndex++) {
    const level = recipe.branchLevels[levelIndex];
    const children: SkeletonBranch[] = [];
    for (const parent of parents) {
      for (let childIndex = 0; childIndex < level.count; childIndex++) {
        if (branches.length >= limits.maxBranches) {
          throw new TreeCompileError(`Tree exceeded the ${limits.maxBranches} branch compile limit`);
        }
        const child = createChildBranch(recipe, seed, parent, levelIndex, childIndex, branches.length);
        branches.push(child);
        children.push(child);
      }
    }
    parents = children;
  }

  return branches;
}

function createFoliageAnchors(
  recipe: TreeRecipe,
  seed: number,
  branches: readonly SkeletonBranch[],
  limits: ResolvedCompileLimits
): FoliageAnchor[] {
  const placement = recipe.foliage.placement;
  const phyllotaxis = degToRad(placement.phyllotaxisDeg ?? GOLDEN_ANGLE_DEG);
  const eligible = branches
    .filter((branch) => branch.level >= placement.minBranchLevel)
    .sort((a, b) => b.level - a.level || a.id - b.id);
  const hardLimit = Math.min(placement.maxAnchors, limits.maxFoliageAnchors);
  const anchors: FoliageAnchor[] = [];

  outer: for (const branch of eligible) {
    const desiredAnchors = Math.max(1, Math.round(branch.length * placement.anchorsPerMeter));
    const nodeCount = Math.max(1, Math.ceil(desiredAnchors / placement.whorlSize));
    const branchRng = createTreeRng(hash32(seed, 0x6c656166 ^ branch.id));

    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
      const uniformT = (nodeIndex + 0.5) / nodeCount;
      const tipBiasedT = 1 - Math.pow(1 - uniformT, placement.tipBias);
      const nodeSpacing = (placement.end - placement.start) / nodeCount;
      const along = clamp(
        placement.start + (placement.end - placement.start) * tipBiasedT + branchRng.range(-0.2, 0.2) * nodeSpacing,
        placement.start,
        placement.end
      );
      const support = samplePolyline(branch.points, along);
      const supportRadius = interpolateRadius(branch, support.segmentIndex, support.segmentT);
      const frame = basisFromTangent(support.tangent);

      for (let whorlIndex = 0; whorlIndex < placement.whorlSize; whorlIndex++) {
        if (anchors.length >= hardLimit) break outer;
        const anchorRng = branchRng.fork(nodeIndex * 131 + whorlIndex * 17 + 1);
        const azimuth =
          phyllotaxis * nodeIndex +
          (Math.PI * 2 * whorlIndex) / placement.whorlSize +
          degToRad(anchorRng.range(-placement.azimuthJitterDeg, placement.azimuthJitterDeg));
        const radial = normalize(
          add(scale(frame.normal, Math.cos(azimuth)), scale(frame.binormal, Math.sin(azimuth)))
        );
        const outwardAngle = degToRad(
          recipe.foliage.outwardAngleDeg +
            anchorRng.range(-recipe.foliage.outwardAngleJitterDeg, recipe.foliage.outwardAngleJitterDeg)
        );
        const direction = normalize(
          add(scale(support.tangent, Math.cos(outwardAngle)), scale(radial, Math.sin(outwardAngle)))
        );
        const position = multiplyAdd(support.position, radial, supportRadius * 0.75);
        const keepScore = clamp(
          anchorRng.next() * 0.58 + branch.keepScore * 0.24 + along * 0.18,
          0.001,
          0.999_999
        );

        anchors.push({
          id: anchors.length,
          branchId: branch.id,
          position,
          direction,
          radial,
          length: range(anchorRng, recipe.foliage.length),
          width: range(anchorRng, recipe.foliage.width),
          keepScore,
          windPhase: anchorRng.range(0, Math.PI * 2),
          stiffness: recipe.foliage.stiffness * anchorRng.range(0.9, 1.1),
          height01: clamp(position.y / recipe.height, 0, 1),
          palette: anchorRng.next()
        });
      }
    }
  }

  return anchors;
}

function compileSkeleton(branches: readonly SkeletonBranch[]): CompiledTreeSkeleton {
  let pointCount = 0;
  for (const branch of branches) pointCount += branch.points.length;

  const pointOffsets = new Uint32Array(branches.length + 1);
  const parents = new Int32Array(branches.length);
  const levels = new Uint8Array(branches.length);
  const points = new Float32Array(pointCount * 3);
  const radii = new Float32Array(pointCount);
  const keepScores = new Float32Array(branches.length);
  const windPhases = new Float32Array(branches.length);
  let pointOffset = 0;

  for (const branch of branches) {
    pointOffsets[branch.id] = pointOffset;
    parents[branch.id] = branch.parent;
    levels[branch.id] = branch.level;
    keepScores[branch.id] = branch.keepScore;
    windPhases[branch.id] = branch.windPhase;
    for (let index = 0; index < branch.points.length; index++) {
      const point = branch.points[index];
      points[pointOffset * 3] = point.x;
      points[pointOffset * 3 + 1] = point.y;
      points[pointOffset * 3 + 2] = point.z;
      radii[pointOffset] = branch.radii[index];
      pointOffset++;
    }
  }
  pointOffsets[branches.length] = pointOffset;

  return { pointOffsets, parents, levels, points, radii, keepScores, windPhases };
}

function skeletonFingerprint(compiled: CompiledTreeSkeleton): string {
  function* values(): Generator<number> {
    yield* compiled.parents;
    yield* compiled.levels;
    yield* compiled.pointOffsets;
    yield* compiled.points;
    yield* compiled.radii;
    yield* compiled.keepScores;
  }
  return hashQuantizedNumbers(values());
}

export function generateTreeSkeleton(
  recipe: TreeRecipe,
  seed: number,
  limits: ResolvedCompileLimits
): GeneratedTreeSkeleton {
  const normalizedSeed = seed >>> 0;
  const branches = growBranches(recipe, normalizedSeed, limits);
  const foliageAnchors = createFoliageAnchors(recipe, normalizedSeed, branches, limits);
  const compiled = compileSkeleton(branches);
  return {
    branches,
    foliageAnchors,
    compiled,
    fingerprint: skeletonFingerprint(compiled)
  };
}
