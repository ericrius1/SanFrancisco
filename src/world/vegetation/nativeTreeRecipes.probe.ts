/**
 * Production-archetype probe:
 *   node --experimental-strip-types src/world/vegetation/nativeTreeRecipes.probe.ts
 */

import { compileTree } from "../treeCompiler/index.ts";
import {
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
    const silhouetteFloor = archetype.recipe.foliage.kind === "rosette" ? Math.min(3, totalAnchors) : 1;
    const expected = Math.max(silhouetteFloor, Math.ceil(totalAnchors * recipeLod.foliageRetention));
    assert(lod.stats.foliageAnchors === expected, `${species}/${lod.name} retained ${lod.stats.foliageAnchors}, expected ${expected}`);
    assert(lod.foliage.vertices.length > 0, `${species}/${lod.name} crown geometry is empty`);
    assert(lod.bounds.sphereRadius > 0, `${species}/${lod.name} bounds are empty`);
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
    lods: prototype.lods.map((lod) => ({
      name: lod.name,
      foliage: lod.stats.foliageAnchors,
      branches: lod.stats.branches,
      orphanAnchors: 0,
      triangles: lod.stats.triangles
    }))
  });
}

console.log(JSON.stringify({ ok: true, species: report }, null, 2));
