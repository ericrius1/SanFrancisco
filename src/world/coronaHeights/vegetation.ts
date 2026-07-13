// Lazy Corona Heights adapter for the shared vegetation runtime. This module is
// intentionally imported only when the player approaches the hill, keeping tree
// templates, flower geometry, and their optional textures out of a clean boot.

import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  writeGrassMesh,
  type GrassEntry
} from "../groundcover/bladeGrass";
import { createAuthoredFlowerPatch } from "../vegetation/authoredFlowers";
import { createAuthoredShrubPatch } from "../vegetation/authoredShrubs";
import { createAuthoredTreePatch } from "../vegetation/authoredTrees";
import { CORONA_HEIGHTS_SUMMIT } from "./layout";
import {
  collectCoronaVegetationPlacements,
  type CoronaPlacementRules
} from "./vegetationPlacement";

export type CoronaHeightsFoliage = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }): void;
  dispose(): void;
  stats: {
    grassClusters: number;
    flowerClumps: number;
    flowerHeads: number;
    shrubs: number;
    trees: number;
  };
};

export function createCoronaHeightsFoliage(
  map: WorldMap,
  rules: CoronaPlacementRules
): CoronaHeightsFoliage {
  const placements = collectCoronaVegetationPlacements(map, rules);
  const group = new THREE.Group();
  group.name = "corona_heights_unified_foliage";

  // Corona's static scatter owns placement only. Blade geometry, SSS lighting,
  // global wind, and trample response are the shared ground-cover implementation.
  const grassGeometry = createBladeClusterGeometry({
    blades: 5,
    segments: 3,
    width: 0.08,
    radius: 0.34,
    curvature: 0.3
  });
  const grassMaterial = createGrassMaterial();
  grassMaterial.focus.set(CORONA_HEIGHTS_SUMMIT.x, CORONA_HEIGHTS_SUMMIT.z + 8);
  const grass = createGrassMesh(
    "corona_heights_grass",
    placements.grass.length,
    grassGeometry,
    grassMaterial.material
  );
  // createGrassMesh clones the source geometry; release the temporary owner.
  grassGeometry.dispose();
  const grassEntries: GrassEntry[] = placements.grass.map((entry) => {
    const color = new THREE.Color(entry.color).offsetHSL(entry.hueJitter, 0, entry.lightnessJitter);
    return {
      x: entry.x,
      y: entry.y,
      z: entry.z,
      yaw: entry.yaw,
      height: entry.height,
      spread: entry.spread,
      color,
      windAmp: entry.windAmp
    };
  });
  // The owner already range-gates this compact static field. A generous radius
  // keeps the ring-edge shader fully open without inventing a Corona-only material.
  writeGrassMesh(grass, grassEntries, 1200);
  const grassGroup = new THREE.Group();
  grassGroup.name = "corona_heights_grass_patch";
  grassGroup.add(grass);

  const flowers = createAuthoredFlowerPatch(placements.flowers, {
    name: "corona_heights_flowers",
    palettes: {
      poppy: { a: 0xf0a134, b: 0xd9652f },
      lupine: { a: 0x6f67bd, b: 0x9282d8 },
      yarrow: { a: 0xf3ead2, b: 0xf1d15a },
      goldfield: { a: 0xf2d457, b: 0xffc31e }
    }
  });

  const shrubs = createAuthoredShrubPatch(placements.shrubs, {
    name: "corona_heights_shrubs",
    palettes: [
      { foliageA: 0x31592c, foliageB: 0x61763b },
      { foliageA: 0x58602f, foliageB: 0x80743a }
    ]
  });

  const trees = createAuthoredTreePatch(placements.treeArchetypes, placements.trees, {
    name: "corona_heights_trees",
    chunkSize: 144,
    visibleDistance: 900,
    nearRadius: 84,
    nearExitRadius: 98,
    nearMax: 12
  });

  group.add(grassGroup, flowers.group, shrubs.group, trees.group);
  let disposed = false;
  return {
    group,
    ready: trees.ready,
    update(focus) {
      trees.update(focus);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      trees.dispose();
      shrubs.dispose();
      flowers.dispose();
      grass.geometry.dispose();
      grassMaterial.material.dispose();
      group.removeFromParent();
      group.clear();
    },
    stats: {
      grassClusters: placements.grass.length,
      flowerClumps: flowers.stats.instances,
      flowerHeads: flowers.stats.heads,
      shrubs: shrubs.stats.instances,
      trees: placements.trees.length
    }
  };
}
