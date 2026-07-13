import { clamp } from "./math.ts";
import {
  BRANCH_VERTEX_STRIDE_FLOATS,
  FOLIAGE_VERTEX_STRIDE_FLOATS,
  buildBranchMesh,
  buildFoliageMesh,
  unionTreeBounds
} from "./mesh.ts";
import { generateTreeSkeleton, type GeneratedTreeSkeleton } from "./skeleton.ts";
import {
  TreeCompileError,
  type CompiledTreeLod,
  type CompiledTreeLodStats,
  type CompiledTreePrototype,
  type CompiledTreeShadowProfile,
  type CompiledTreeStats,
  type TreeBounds,
  type TreeRecipe
} from "./types.ts";
import { validateTreeRecipe } from "./validate.ts";

function meshByteLength(lod: CompiledTreeLod): number {
  return (
    lod.branch.vertices.byteLength +
    lod.branch.indices.byteLength +
    lod.foliage.vertices.byteLength +
    lod.foliage.indices.byteLength
  );
}

function skeletonByteLength(skeleton: GeneratedTreeSkeleton["compiled"]): number {
  return (
    skeleton.pointOffsets.byteLength +
    skeleton.parents.byteLength +
    skeleton.levels.byteLength +
    skeleton.points.byteLength +
    skeleton.radii.byteLength +
    skeleton.keepScores.byteLength +
    skeleton.windPhases.byteLength
  );
}

function createShadowProfile(
  recipe: TreeRecipe,
  skeleton: GeneratedTreeSkeleton,
  lods: readonly CompiledTreeLod[],
  bounds: TreeBounds
): CompiledTreeShadowProfile {
  const foliageBounds = lods[0].foliage.vertices.length > 0 ? lods[0].foliage.bounds : bounds;
  const canopyRadii: [number, number, number] = [
    Math.max(0.01, (foliageBounds.max[0] - foliageBounds.min[0]) * 0.5),
    Math.max(0.01, (foliageBounds.max[1] - foliageBounds.min[1]) * 0.5),
    Math.max(0.01, (foliageBounds.max[2] - foliageBounds.min[2]) * 0.5)
  ];
  const canopyCenter: [number, number, number] = [
    (foliageBounds.min[0] + foliageBounds.max[0]) * 0.5,
    (foliageBounds.min[1] + foliageBounds.max[1]) * 0.5,
    (foliageBounds.min[2] + foliageBounds.max[2]) * 0.5
  ];
  const ellipsoidVolume = (4 / 3) * Math.PI * canopyRadii[0] * canopyRadii[1] * canopyRadii[2];
  const canopyDensity = clamp(skeleton.foliageAnchors.length / Math.max(1, ellipsoidVolume * 3), 0, 1);

  return {
    trunkRadius: recipe.trunk.radius * (1 + recipe.trunk.flare),
    height: bounds.max[1] - bounds.min[1],
    canopyCenter,
    canopyRadii,
    canopyDensity,
    opacity: recipe.shadow?.opacity ?? clamp(0.42 + canopyDensity * 0.42, 0.42, 0.86),
    preferredLod: recipe.shadow?.preferredLod ?? lods[Math.min(1, lods.length - 1)].name
  };
}

/**
 * Compiles a recipe into renderer-independent typed arrays. No global state,
 * DOM API, Three.js object, texture, or vendor module participates in growth.
 */
export function compileTree(recipe: TreeRecipe, seed: number): CompiledTreePrototype {
  if (!Number.isFinite(seed)) throw new TreeCompileError("Tree seed must be finite");
  const normalizedSeed = seed >>> 0;
  const limits = validateTreeRecipe(recipe);
  const skeleton = generateTreeSkeleton(recipe, normalizedSeed, limits);
  const lods: CompiledTreeLod[] = [];

  for (const lodRecipe of recipe.lods) {
    const branch = buildBranchMesh(recipe, skeleton.branches, lodRecipe, limits.maxVerticesPerLod);
    const foliage = buildFoliageMesh(
      recipe,
      skeleton.foliageAnchors,
      lodRecipe,
      limits.maxVerticesPerLod - branch.vertexCount
    );
    const bounds = foliage.vertexCount > 0
      ? unionTreeBounds(branch.mesh.bounds, foliage.mesh.bounds)
      : branch.mesh.bounds;
    const triangles = (branch.mesh.indices.length + foliage.mesh.indices.length) / 3;
    const stats: CompiledTreeLodStats = {
      branches: branch.branchCount,
      foliageAnchors: foliage.anchorCount,
      branchVertices: branch.mesh.vertices.length / BRANCH_VERTEX_STRIDE_FLOATS,
      foliageVertices: foliage.mesh.vertices.length / FOLIAGE_VERTEX_STRIDE_FLOATS,
      triangles,
      byteLength:
        branch.mesh.vertices.byteLength +
        branch.mesh.indices.byteLength +
        foliage.mesh.vertices.byteLength +
        foliage.mesh.indices.byteLength
    };
    lods.push({ name: lodRecipe.name, branch: branch.mesh, foliage: foliage.mesh, bounds, stats });
  }

  let bounds = lods[0].bounds;
  for (let index = 1; index < lods.length; index++) bounds = unionTreeBounds(bounds, lods[index].bounds);
  const skeletonBytes = skeletonByteLength(skeleton.compiled);
  const stats: CompiledTreeStats = {
    skeletonBranches: skeleton.branches.length,
    skeletonPoints: skeleton.compiled.radii.length,
    foliageAnchors: skeleton.foliageAnchors.length,
    lods: lods.map((lod) => lod.stats),
    byteLength: skeletonBytes + lods.reduce((sum, lod) => sum + meshByteLength(lod), 0)
  };

  return {
    version: 1,
    recipeName: recipe.name,
    seed: normalizedSeed,
    skeletonFingerprint: skeleton.fingerprint,
    skeleton: skeleton.compiled,
    lods,
    bounds,
    shadow: createShadowProfile(recipe, skeleton, lods, bounds),
    stats
  };
}

/** Identity helper which preserves literal recipe names and LOD names. */
export function defineTreeRecipe<const T extends TreeRecipe>(recipe: T): T {
  return recipe;
}

/** ArrayBuffers which can be transferred from a compiler worker without copies. */
export function treePrototypeTransferables(prototype: CompiledTreePrototype): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView) => buffers.add(view.buffer as ArrayBuffer);
  add(prototype.skeleton.pointOffsets);
  add(prototype.skeleton.parents);
  add(prototype.skeleton.levels);
  add(prototype.skeleton.points);
  add(prototype.skeleton.radii);
  add(prototype.skeleton.keepScores);
  add(prototype.skeleton.windPhases);
  for (const lod of prototype.lods) {
    add(lod.branch.vertices);
    add(lod.branch.indices);
    add(lod.foliage.vertices);
    add(lod.foliage.indices);
  }
  return [...buffers];
}
