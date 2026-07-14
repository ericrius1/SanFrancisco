/**
 * Three-independent input and output contracts for the native tree compiler.
 *
 * Every mesh is emitted as one interleaved Float32Array plus an index array.
 * This keeps the eventual WebGPU/Three renderer well below vertex-buffer slot
 * limits while leaving the compiler usable in workers and offline build tools.
 */

export type Vec3Tuple = readonly [x: number, y: number, z: number];
export type NumberRange = readonly [min: number, max: number];

export type FoliageKind = "leaf" | "needle" | "rosette";

export type TreeTrunkRecipe = {
  /** Number of centerline spans. */
  segments: number;
  /** Radius at ground level in world units. */
  radius: number;
  /** Radius at the final centerline point, expressed as a base-radius ratio. */
  tipRadiusRatio: number;
  /** Extra base radius which fades over the lower trunk. */
  flare: number;
  /** Overall trunk bend. */
  curveDeg: number;
  /** Smooth deterministic variation around the primary bend. */
  curveNoiseDeg: number;
  leanDeg: number;
  leanAzimuthDeg?: number;
  /** Bark UV repeat length in world units. */
  barkRepeat: number;
};

export type TreeBranchLevelRecipe = {
  /** Children emitted by every branch at the preceding level. */
  count: number;
  segments: number;
  /** Normalized attachment range on the parent centerline. */
  start: number;
  /** Normalized attachment range on the parent centerline. */
  end: number;
  /** Child length as a ratio of parent length. */
  lengthRatio: NumberRange;
  /** Child base radius as a ratio of the parent's attachment radius. */
  radiusRatio: NumberRange;
  /** Angle away from the parent tangent. */
  downAngleDeg: number;
  downAngleJitterDeg: number;
  /** Azimuth step between children; defaults to the golden angle. */
  rotateDeg?: number;
  rotateJitterDeg: number;
  /** Signed bend over the whole child branch. */
  curveDeg: number;
  curveJitterDeg: number;
  /** Downward attraction applied along the branch. */
  gravity: number;
  /** 0 gives a cylinder, 1 reaches a near-zero tip. */
  taper: number;
};

export type FoliagePlacementRecipe = {
  /** Lowest branch level eligible for foliage; the trunk is level 0. */
  minBranchLevel: number;
  /** Placement range along each eligible branch. */
  start: number;
  end: number;
  /** Anchor count per world-unit of eligible branch. */
  anchorsPerMeter: number;
  /** Values > 1 bias anchors toward branch tips. */
  tipBias: number;
  /** Leaves or clusters per phyllotactic node. */
  whorlSize: number;
  phyllotaxisDeg?: number;
  azimuthJitterDeg: number;
  /** Hard deterministic safety cap. */
  maxAnchors: number;
};

export type TreeFoliageRecipe = {
  kind: FoliageKind;
  placement: FoliagePlacementRecipe;
  length: NumberRange;
  width: NumberRange;
  /** Angle away from the supporting branch tangent. */
  outwardAngleDeg: number;
  outwardAngleJitterDeg: number;
  /** Positive values pull foliage tips downward. */
  droop: number;
  /** Multiplies the per-vertex wind stiffness channel. */
  stiffness: number;
  /** Number of crossed blades in a needle cluster. */
  needleBlades?: number;
  /** Petal count for a rosette. */
  rosettePetals?: number;
};

export type TreeLodRecipe = {
  name: string;
  /** Stable subset of skeleton branches retained at this level. */
  branchRetention: number;
  /** Stable subset of foliage anchors retained at this level. */
  foliageRetention: number;
  /** Nominal structural depth; selected foliage may retain deeper support twigs. */
  maxBranchLevel: number;
  /** Tube sides. */
  radialSegments: number;
  /** Keep every Nth centerline point, always preserving both endpoints. */
  axialStride: number;
  /** Compensates for reduced density without changing anchor positions. */
  foliageScale: number;
};

export type TreeCompileLimits = {
  maxBranches?: number;
  maxFoliageAnchors?: number;
  maxVerticesPerLod?: number;
};

export type TreeShadowRecipe = {
  /** Density multiplier used by the future low-cost shadow renderer. */
  opacity?: number;
  /** Optional LOD name to use for geometry shadows. */
  preferredLod?: string;
};

export type TreeRecipe = {
  version: 1;
  name: string;
  /** Tree height in world units. */
  height: number;
  trunk: TreeTrunkRecipe;
  branchLevels: readonly TreeBranchLevelRecipe[];
  foliage: TreeFoliageRecipe;
  /** Ordered near to far. Every farther level must be a subset. */
  lods: readonly TreeLodRecipe[];
  shadow?: TreeShadowRecipe;
  limits?: TreeCompileLimits;
};

export type VertexAttributeSemantic =
  | "position"
  | "normal"
  | "uv"
  | "anchor"
  | "wind"
  | "material";

export type VertexAttributeLayout = {
  semantic: VertexAttributeSemantic;
  offsetFloats: number;
  components: 1 | 2 | 3 | 4;
};

export type TreeBounds = {
  min: Vec3Tuple;
  max: Vec3Tuple;
  sphereCenter: Vec3Tuple;
  sphereRadius: number;
};

export type CompiledTreeMesh = {
  /** One GPU vertex buffer; stride and offsets are expressed in floats. */
  vertices: Float32Array;
  vertexStrideFloats: number;
  attributes: readonly VertexAttributeLayout[];
  indices: Uint16Array | Uint32Array;
  bounds: TreeBounds;
};

export type CompiledTreeLodStats = {
  branches: number;
  foliageAnchors: number;
  branchVertices: number;
  foliageVertices: number;
  triangles: number;
  byteLength: number;
};

export type CompiledTreeLod = {
  name: string;
  branch: CompiledTreeMesh;
  foliage: CompiledTreeMesh;
  bounds: TreeBounds;
  stats: CompiledTreeLodStats;
};

/** Compact, renderer-independent proof that every LOD came from one skeleton. */
export type CompiledTreeSkeleton = {
  /** Branch i owns points in [pointOffsets[i], pointOffsets[i + 1]). */
  pointOffsets: Uint32Array;
  parents: Int32Array;
  levels: Uint8Array;
  /** xyz triples. */
  points: Float32Array;
  radii: Float32Array;
  /** Stable [0, 1] score used by every LOD's nested pruning. */
  keepScores: Float32Array;
  windPhases: Float32Array;
};

export type CompiledTreeShadowProfile = {
  trunkRadius: number;
  height: number;
  canopyCenter: Vec3Tuple;
  canopyRadii: Vec3Tuple;
  canopyDensity: number;
  opacity: number;
  preferredLod: string;
};

export type CompiledTreeStats = {
  skeletonBranches: number;
  skeletonPoints: number;
  foliageAnchors: number;
  lods: readonly CompiledTreeLodStats[];
  byteLength: number;
};

export type CompiledTreePrototype = {
  version: 1;
  recipeName: string;
  seed: number;
  /** FNV-1a fingerprint of quantized shared-skeleton data. */
  skeletonFingerprint: string;
  skeleton: CompiledTreeSkeleton;
  lods: readonly CompiledTreeLod[];
  bounds: TreeBounds;
  shadow: CompiledTreeShadowProfile;
  stats: CompiledTreeStats;
};

export class TreeRecipeError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TreeRecipeError";
    this.path = path;
  }
}

export class TreeCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeCompileError";
  }
}
