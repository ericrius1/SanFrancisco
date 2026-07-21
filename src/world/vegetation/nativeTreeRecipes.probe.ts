/**
 * Production-archetype probe:
 *   node --experimental-strip-types src/world/vegetation/nativeTreeRecipes.probe.ts
 */

import { compileTree } from "../treeCompiler/index.ts";
import {
  FOLIAGE_VERTEX_STRIDE_FLOATS,
  collectFoliageSupportBranchIds,
  selectLodBranches,
  selectLodFoliageAnchors
} from "../treeCompiler/mesh.ts";
import { generateTreeSkeleton, type SkeletonBranch } from "../treeCompiler/skeleton.ts";
import { validateTreeRecipe } from "../treeCompiler/validate.ts";
import {
  NATIVE_TREE_SPECIES,
  createNativeTreeArchetype
} from "./nativeTreeRecipes.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Native tree archetype probe failed: ${message}`);
}

function assertNear(actual: number, expected: number, epsilon: number, message: string): void {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} != ${expected}`);
}

const DISTANT_FOLIAGE_CONTRACT = Object.freeze({
  landscape: Object.freeze({ retention: 0.53, coverage: 0.5 * 1.42 ** 2 }),
  horizon: Object.freeze({ retention: 0.35, coverage: 0.32 * 1.65 ** 2 })
});

const report = [];

for (let speciesIndex = 0; speciesIndex < NATIVE_TREE_SPECIES.length; speciesIndex++) {
  const species = NATIVE_TREE_SPECIES[speciesIndex];
  const archetype = createNativeTreeArchetype(species);
  const seed = 0x51f15e + speciesIndex * 977;
  const prototype = compileTree(archetype.recipe, seed);
  const skeleton = generateTreeSkeleton(
    archetype.recipe,
    seed,
    validateTreeRecipe(archetype.recipe)
  );
  const totalAnchors = prototype.stats.foliageAnchors;

  assert(totalAnchors > 0, `${species} generated no crown anchors`);
  assert(prototype.lods.length === archetype.recipe.lods.length, `${species} lost an LOD`);

  for (let lodIndex = 0; lodIndex < prototype.lods.length; lodIndex++) {
    const lod = prototype.lods[lodIndex];
    const recipeLod = archetype.recipe.lods[lodIndex];
    const distantContract = DISTANT_FOLIAGE_CONTRACT[
      recipeLod.name as keyof typeof DISTANT_FOLIAGE_CONTRACT
    ];
    if (distantContract) {
      assertNear(
        recipeLod.foliageRetention,
        distantContract.retention,
        Number.EPSILON,
        `${species}/${lod.name} foliage retention changed`
      );
      assertNear(
        recipeLod.foliageRetention * recipeLod.foliageScale ** 2,
        distantContract.coverage,
        1e-12,
        `${species}/${lod.name} projected crown coverage changed`
      );
    }
    const silhouetteFloor = archetype.recipe.foliage.kind === "rosette" ? Math.min(3, totalAnchors) : 1;
    const expected = Math.max(silhouetteFloor, Math.ceil(totalAnchors * recipeLod.foliageRetention));
    assert(lod.stats.foliageAnchors === expected, `${species}/${lod.name} retained ${lod.stats.foliageAnchors}, expected ${expected}`);
    assert(lod.foliage.vertices.length > 0, `${species}/${lod.name} crown geometry is empty`);
    assert(lod.bounds.sphereRadius > 0, `${species}/${lod.name} bounds are empty`);
    if (archetype.recipe.foliage.kind === "leaf") {
      const close = lodIndex <= 1;
      const leafletCount = lodIndex === 0 ? 8 : lodIndex === 1 ? 6 : 0;
      const verticesPerAnchor = close ? leafletCount * 4 : 8;
      const trianglesPerAnchor = close ? leafletCount * 2 : 6;
      assert(
        lod.foliage.vertices.length / FOLIAGE_VERTEX_STRIDE_FLOATS === expected * verticesPerAnchor,
        `${species}/${lod.name} broadleaf vertex budget changed`
      );
      assert(
        lod.foliage.indices.length / 3 === expected * trianglesPerAnchor,
        `${species}/${lod.name} broadleaf triangle budget changed`
      );
      if (close) {
        // Each close anchor is a set of distinct leaflets staggered along one tiny
        // implied twig rather than coincident cards forming one dark rosette.
        // The fixed stride makes this a deterministic compiler contract rather
        // than a screenshot-only assertion.
        const vertices = lod.foliage.vertices;
        const position = (vertex: number) => [
          vertices[vertex * FOLIAGE_VERTEX_STRIDE_FLOATS],
          vertices[vertex * FOLIAGE_VERTEX_STRIDE_FLOATS + 1],
          vertices[vertex * FOLIAGE_VERTEX_STRIDE_FLOATS + 2]
        ] as const;
        const leafletAnchor = (vertex: number) => [
          vertices[vertex * FOLIAGE_VERTEX_STRIDE_FLOATS + 8],
          vertices[vertex * FOLIAGE_VERTEX_STRIDE_FLOATS + 9],
          vertices[vertex * FOLIAGE_VERTEX_STRIDE_FLOATS + 10]
        ] as const;
        const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(
          a[0] - b[0],
          a[1] - b[1],
          a[2] - b[2]
        );
        const roots = Array.from({ length: leafletCount }, (_, index) => leafletAnchor(index * 4));
        const tips = Array.from({ length: leafletCount }, (_, index) => position(index * 4 + 2));
        assert(distance(roots[0], roots[1]) > 0.01 && distance(roots[0], roots[roots.length - 1]) < 0.4,
          `${species}/${lod.name} close leaflet roots lost their compact stagger`);
        assert(distance(tips[0], tips[1]) > 0.02 && distance(tips[tips.length - 2], tips[tips.length - 1]) > 0.02,
          `${species}/${lod.name} close leaflets collapsed into one card`);
      }
    }
    const selectedAnchors = selectLodFoliageAnchors(archetype.recipe, skeleton.foliageAnchors, recipeLod);
    const supports = collectFoliageSupportBranchIds(skeleton.branches, selectedAnchors);
    const selectedBranches = selectLodBranches(skeleton.branches, recipeLod, supports).selectedIds;
    for (const anchor of selectedAnchors) {
      let branch: SkeletonBranch | undefined = skeleton.branches[anchor.branchId];
      while (branch) {
        assert(
          selectedBranches.has(branch.id),
          `${species}/${lod.name} orphaned anchor ${anchor.id} from branch ${branch.id}`
        );
        branch = branch.parent >= 0 ? skeleton.branches[branch.parent] : undefined;
      }
    }
    if (lodIndex > 0) {
      const previous = prototype.lods[lodIndex - 1];
      assert(previous.stats.foliageAnchors >= lod.stats.foliageAnchors, `${species}/${lod.name} is not nested`);
      assert(previous.stats.triangles >= lod.stats.triangles, `${species}/${lod.name} exceeds the previous triangle budget`);
    }
  }

  if (archetype.recipe.foliage.kind === "rosette") {
    const near = prototype.lods[0].foliage.bounds;
    const horizon = prototype.lods.at(-1)?.foliage.bounds;
    assert(horizon, `${species} has no horizon foliage bounds`);
    const nearHorizontal = Math.min(near.max[0] - near.min[0], near.max[2] - near.min[2]);
    const horizonHorizontal = Math.min(horizon.max[0] - horizon.min[0], horizon.max[2] - horizon.min[2]);
    assert(horizonHorizontal >= nearHorizontal * 0.45, `${species} horizon rosette collapsed edge-on`);
  }

  report.push({
    species,
    anchors: totalAnchors,
    lods: prototype.lods.map((lod, lodIndex) => {
      const recipeLod = archetype.recipe.lods[lodIndex];
      return {
        name: lod.name,
        foliage: lod.stats.foliageAnchors,
        branches: lod.stats.branches,
        orphanAnchors: 0,
        triangles: lod.stats.triangles,
        projectedCoverage: recipeLod.foliageRetention * recipeLod.foliageScale ** 2
      };
    })
  });
}

console.log(JSON.stringify({ ok: true, species: report }, null, 2));
