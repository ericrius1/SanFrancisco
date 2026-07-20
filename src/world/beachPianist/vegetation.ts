// Lazy Beach Pianist planting adapter for the shared vegetation runtime.
//
// The site owns only the coastal planting intent below. Tree compilation,
// instancing, wind, LOD and culling remain owned by the shared
// NativeTreeForest; flowers use the shared authored-flower renderer. main.ts
// reaches this module only through SiteFoliageStreamer on first approach.

import * as THREE from "three/webgpu";
import { FLOWER_TUNING } from "../../config";
import type { WorldMap } from "../heightmap";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  writeGrassMesh,
  type GrassEntry
} from "../groundcover/bladeGrass";
import { smoothstep, worleyClump } from "../groundcover/scatter";
import { createAuthoredFlowerPatch, type AuthoredFlowerPlacement } from "../vegetation/authoredFlowers";
import {
  createAuthoredTreePatch,
  type AuthoredTreeArchetype
} from "../vegetation/authoredTrees";
import { BEACH_PIANIST_SITE } from "./meta";
import {
  collectGroveTrees,
  groveDryRoot,
  groveHash,
  GROVE_TREE_HEIGHTS,
  GROVE_TREE_LIMIT
} from "./groveLayout";

export type BeachPianistFoliage = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }, force?: boolean): void;
  refresh(): void;
  dispose(): void;
  stats: { trees: number; flowerClumps: number; flowerHeads: number; grassClusters: number; grassBlades: number };
};

const TREE_ARCHETYPES: readonly AuthoredTreeArchetype[] = [
  {
    id: "pianist-cypress-elder",
    design: {
      species: "windswept-monterey-cypress",
      seed: 9251,
      controls: {
        height: GROVE_TREE_HEIGHTS["pianist-cypress-elder"],
        crownDensity: 0.96,
        crownWidth: 1.08,
        foliageColor: 0x36563c,
        foliageTint: 0x879467,
        windResponse: 0.58
      },
      sink: 0.3
    }
  },
  {
    id: "pianist-cypress-shelf",
    design: {
      species: "monterey-cypress",
      seed: 9252,
      controls: {
        height: GROVE_TREE_HEIGHTS["pianist-cypress-shelf"],
        crownDensity: 0.9,
        crownWidth: 1.16,
        foliageColor: 0x456846,
        foliageTint: 0x9ca36c,
        windResponse: 0.62
      },
      sink: 0.26
    }
  },
  {
    id: "pianist-pine",
    design: {
      species: "monterey-pine",
      seed: 9253,
      controls: {
        height: GROVE_TREE_HEIGHTS["pianist-pine"],
        crownDensity: 0.88,
        crownWidth: 1.04,
        foliageColor: 0x38543a,
        foliageTint: 0x879160,
        windResponse: 0.66
      },
      sink: 0.28
    }
  }
] as const;

const FLOWER_SPECIES = ["lupine", "poppy", "yarrow", "goldfield"] as const;
/** Designed meadow density at wildflower slider density=1 (3× the prior 520). */
const FLOWER_DESIGNED_COUNT = 1_560;
/** Match FLOWER_TUNING.density max so the slider can carpet the grove. */
const FLOWER_DENSITY_MAX = 2.5;
const FLOWER_CANDIDATE_COUNT = Math.ceil(FLOWER_DESIGNED_COUNT * FLOWER_DENSITY_MAX);
const FLOWER_ATTEMPT_BUDGET = FLOWER_CANDIDATE_COUNT * 5;
const FLOWER_CLUMP_SALT = 5171;
const FLOWER_PALETTES = {
  lupine: { a: 0x735fc7, b: 0xaa91e2 },
  poppy: { a: 0xf06c28, b: 0xffa13b },
  yarrow: { a: 0xf3e8c9, b: 0xf2ca64 },
  goldfield: { a: 0xf4c62d, b: 0xffdf58 }
} as const;
const TREE_LIMIT = GROVE_TREE_LIMIT;
const SITE_X = BEACH_PIANIST_SITE.x;
const SITE_Z = BEACH_PIANIST_SITE.z;
const SITE_COSINE = Math.cos(BEACH_PIANIST_SITE.yaw);
const SITE_SINE = Math.sin(BEACH_PIANIST_SITE.yaw);
// The former 4+ metre circular performance clearing read as a bare pad around
// the whole exhibit. Keep only roots that would visibly pierce the solid piano
// case out of the scatter; grass and flowers may otherwise grow right up to it.
// Bounds are in the stage-local frame documented by piano.ts.
const PIANO_ROOT_CLEARANCE = {
  minX: -0.9,
  maxX: 0.9,
  minZ: -2.42,
  maxZ: -0.14
} as const;
// Soft-mow the meadow around the piano + seated pianist so blade tips stay
// under the keybed (~0.72 m) instead of poking through the case and keys.
const PERFORMANCE_GRASS_TRIM = {
  minX: -1.4,
  maxX: 1.4,
  minZ: -2.75,
  maxZ: 0.9,
  falloff: 1.35,
  minScale: 0.4
} as const;

const hash = groveHash;

function toStageLocal(x: number, z: number): { localX: number; localZ: number } {
  const dx = x - SITE_X;
  const dz = z - SITE_Z;
  return {
    localX: SITE_COSINE * dx - SITE_SINE * dz,
    localZ: SITE_SINE * dx + SITE_COSINE * dz
  };
}

function rootIntersectsPiano(x: number, z: number, margin: number): boolean {
  const { localX, localZ } = toStageLocal(x, z);
  return localX >= PIANO_ROOT_CLEARANCE.minX - margin &&
    localX <= PIANO_ROOT_CLEARANCE.maxX + margin &&
    localZ >= PIANO_ROOT_CLEARANCE.minZ - margin &&
    localZ <= PIANO_ROOT_CLEARANCE.maxZ + margin;
}

/** 1 away from the stage, down to minScale inside the piano/pianist pad. */
function grassHeightScaleAt(x: number, z: number): number {
  const { localX, localZ } = toStageLocal(x, z);
  const { minX, maxX, minZ, maxZ, falloff, minScale } = PERFORMANCE_GRASS_TRIM;
  const ox = localX < minX ? minX - localX : localX > maxX ? localX - maxX : 0;
  const oz = localZ < minZ ? minZ - localZ : localZ > maxZ ? localZ - maxZ : 0;
  const dist = Math.hypot(ox, oz);
  if (dist >= falloff) return 1;
  const t = dist / falloff;
  const ease = t * t * (3 - 2 * t);
  return minScale + (1 - minScale) * ease;
}

const dryRoot = groveDryRoot;
const collectTrees = collectGroveTrees;

function collectFlowerCandidates(map: WorldMap): AuthoredFlowerPlacement[] {
  const placements: AuthoredFlowerPlacement[] = [];
  for (let i = 0; i < FLOWER_ATTEMPT_BUDGET && placements.length < FLOWER_CANDIDATE_COUNT; i++) {
    const x = SITE_X + (hash(i, 83) - 0.5) * 64;
    const z = SITE_Z + (hash(i, 89) - 0.5) * 64;
    if (rootIntersectsPiano(x, z, 0.3)) continue;
    const y = dryRoot(map, x, z, 0.38);
    if (y === null) continue;
    const speciesIndex = Math.floor(hash(i, 97) * FLOWER_SPECIES.length) % FLOWER_SPECIES.length;
    placements.push({
      x,
      y: y - 0.035,
      z,
      yaw: hash(i, 101) * Math.PI * 2,
      scale: 0.7 + hash(i, 103) * 0.72,
      species: FLOWER_SPECIES[speciesIndex],
      tint: hash(i, 107)
    });
  }
  return placements;
}

/** Filter the max-density candidate pool with the shared wildflower knobs. */
function flowersForTuning(candidates: readonly AuthoredFlowerPlacement[]): AuthoredFlowerPlacement[] {
  const density = Math.min(FLOWER_DENSITY_MAX, Math.max(0, Number(FLOWER_TUNING.values.density)));
  const clumpiness = Math.min(1, Math.max(0, Number(FLOWER_TUNING.values.clumpiness)));
  const clumpSize = Math.max(2, Number(FLOWER_TUNING.values.clumpSize));
  const target = Math.min(candidates.length, Math.round(FLOWER_DESIGNED_COUNT * density));
  if (target <= 0) return [];
  if (clumpiness <= 0.001) return candidates.slice(0, target);

  const ranked = candidates.map((placement, index) => {
    const wc = worleyClump(placement.x, placement.z, clumpSize * 1.7, FLOWER_CLUMP_SALT);
    const clumpField = smoothstep(clumpSize, 0, wc.d);
    const order = 1 - index / Math.max(1, candidates.length);
    const score = (1 - clumpiness) * order + clumpiness * (clumpField * 0.85 + hash(index, 23) * 0.15);
    return { placement, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, target).map((entry) => entry.placement);
}

const GRASS_COLORS = [
  new THREE.Color(0x526b32),
  new THREE.Color(0x66763a),
  new THREE.Color(0x7d7d43),
  new THREE.Color(0x45602f),
  new THREE.Color(0x8b854d)
] as const;
const GRASS_BLADES_PER_CLUSTER = 16;

function collectGrass(map: WorldMap): GrassEntry[] {
  const placements: GrassEntry[] = [];
  const normal = new THREE.Vector3();
  // This is a hero meadow seen from ground level on arrival. Keep neighbouring
  // cluster footprints overlapping even at their smallest authored spread so
  // the pale terrain never opens into random bald patches between blades.
  const spacing = 0.4;
  const halfExtent = 30;
  let index = 0;

  for (let dz = -halfExtent; dz <= halfExtent; dz += spacing) {
    for (let dx = -halfExtent; dx <= halfExtent; dx += spacing) {
      const i = index++;
      // Jittered cells avoid a planted grid while preserving continuous
      // coverage all the way to the water and onto the lower bluff.
      const x = SITE_X + dx + (hash(i, 127) - 0.5) * spacing * 0.12;
      const z = SITE_Z + dz + (hash(i, 131) - 0.5) * spacing * 0.12;
      if (rootIntersectsPiano(x, z, 0.12)) continue;
      const y = dryRoot(map, x, z, 0.32);
      if (y === null) continue;
      map.normal(x, z, normal, 0.65);
      if (normal.y < 0.52) continue;

      const heightScale = grassHeightScaleAt(x, z);
      placements.push({
        x,
        y: y - 0.025,
        z,
        yaw: hash(i, 139) * Math.PI * 2,
        height: (0.48 + hash(i, 149) * 0.62) * heightScale,
        spread: 0.95 + hash(i, 151) * 0.2,
        color: GRASS_COLORS[Math.floor(hash(i, 157) * GRASS_COLORS.length) % GRASS_COLORS.length],
        windAmp: 0.7 + hash(i, 163) * 0.46
      });
    }
  }
  return placements;
}

export function createBeachPianistFoliage(map: WorldMap): BeachPianistFoliage {
  const treePlacements = collectTrees(map);
  const flowerCandidates = collectFlowerCandidates(map);
  const grassPlacements = collectGrass(map);
  const group = new THREE.Group();
  group.name = "beachPianist.unified_foliage";

  const trees = createAuthoredTreePatch(TREE_ARCHETYPES, treePlacements, {
    name: "beach_pianist_cypress",
    chunkSize: 52,
    visibleDistance: 850,
    // This is a hero grove: the opaque landscape cards read as solid triangle
    // leaves well past 100 m, and the player approaches along open sightlines
    // (bluff trail above, shoreline, spawn aisle). Promote the whole grove to
    // textured close LODs from far enough out that the cards are never
    // discernible — the pool is only ever these 24 trees.
    nearRadius: 170,
    nearExitRadius: 200,
    // Every tree in this compact 30 m grove can be overhead at once. Letting
    // six of the 24 lose the close pool exposed the opaque landscape needle
    // cards as tan/blocky leaves when the camera looked upward beneath them.
    nearMax: TREE_LIMIT,
    // The god-ray raymarch samples its dedicated light's shadow map; without
    // the grove in that map there are no shafts through the canopy, only a
    // uniform veil. The sun's clipmap cameras never see these casters.
    conventionalShadowCasting: true
  });
  let flowers = createAuthoredFlowerPatch(flowersForTuning(flowerCandidates), {
    name: "beach_pianist_flowers",
    palettes: FLOWER_PALETTES
  });
  const grassSourceGeometry = createBladeClusterGeometry({
    blades: GRASS_BLADES_PER_CLUSTER,
    segments: 2,
    width: 0.095,
    radius: 0.4,
    curvature: 0.3
  });
  const grassMaterial = createGrassMaterial({ wind: "full", interactionSlots: 12 });
  grassMaterial.focus.set(SITE_X, SITE_Z);
  const grass = createGrassMesh(
    "beach_pianist_grass",
    grassPlacements.length,
    grassSourceGeometry,
    grassMaterial.material
  );
  grassSourceGeometry.dispose();
  writeGrassMesh(grass, grassPlacements, 78);
  group.add(grass, trees.group, flowers.group);
  group.userData.stats = {
    trees: treePlacements.length,
    flowers: flowers.stats.instances,
    grassClusters: grassPlacements.length
  };

  let disposed = false;
  const stats = {
    trees: treePlacements.length,
    flowerClumps: flowers.stats.instances,
    flowerHeads: flowers.stats.heads,
    grassClusters: grassPlacements.length,
    grassBlades: grassPlacements.length * GRASS_BLADES_PER_CLUSTER
  };

  return {
    group,
    ready: trees.ready,
    update(focus, force = false) {
      if (!disposed) trees.update(focus, force);
    },
    refresh() {
      if (disposed) return;
      flowers.dispose();
      flowers = createAuthoredFlowerPatch(flowersForTuning(flowerCandidates), {
        name: "beach_pianist_flowers",
        palettes: FLOWER_PALETTES
      });
      group.add(flowers.group);
      stats.flowerClumps = flowers.stats.instances;
      stats.flowerHeads = flowers.stats.heads;
      group.userData.stats = {
        trees: treePlacements.length,
        flowers: flowers.stats.instances,
        grassClusters: grassPlacements.length
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      trees.dispose();
      flowers.dispose();
      grass.geometry.dispose();
      grassMaterial.material.dispose();
      group.removeFromParent();
      group.clear();
    },
    stats
  };
}
