// Lazy Beach Pianist planting adapter for the shared vegetation runtime.
//
// The site owns only the coastal planting intent below. Tree compilation,
// instancing, wind, LOD and culling remain owned by the shared
// NativeTreeForest; flowers use the shared authored-flower renderer. main.ts
// reaches this module only through SiteFoliageStreamer on first approach.

import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  writeGrassMesh,
  type GrassEntry
} from "../groundcover/bladeGrass";
import { createAuthoredFlowerPatch, type AuthoredFlowerPlacement } from "../vegetation/authoredFlowers";
import {
  createAuthoredTreePatch,
  type AuthoredTreeArchetype,
  type AuthoredTreePlacement
} from "../vegetation/authoredTrees";
import { BEACH_PIANIST_BRIDGE_AIM, BEACH_PIANIST_SITE } from "./meta";

export type BeachPianistFoliage = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }, force?: boolean): void;
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
        height: 11.5,
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
        height: 8.8,
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
        height: 10.2,
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
const TREE_LIMIT = 24;
const SITE_X = BEACH_PIANIST_SITE.x;
const SITE_Z = BEACH_PIANIST_SITE.z;
const BRIDGE_DX = BEACH_PIANIST_BRIDGE_AIM.x - SITE_X;
const BRIDGE_DZ = BEACH_PIANIST_BRIDGE_AIM.z - SITE_Z;
const BRIDGE_INV_LENGTH = 1 / Math.hypot(BRIDGE_DX, BRIDGE_DZ);
const SIGHT_X = BRIDGE_DX * BRIDGE_INV_LENGTH;
const SIGHT_Z = BRIDGE_DZ * BRIDGE_INV_LENGTH;
const SITE_COSINE = Math.cos(BEACH_PIANIST_SITE.yaw);
const SITE_SINE = Math.sin(BEACH_PIANIST_SITE.yaw);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
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

function hash(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function distanceFromBridgeSightline(x: number, z: number): number {
  const dx = x - SITE_X;
  const dz = z - SITE_Z;
  return Math.abs(dx * SIGHT_Z - dz * SIGHT_X);
}

function rootIntersectsPiano(x: number, z: number, margin: number): boolean {
  const dx = x - SITE_X;
  const dz = z - SITE_Z;
  const localX = SITE_COSINE * dx - SITE_SINE * dz;
  const localZ = SITE_SINE * dx + SITE_COSINE * dz;
  return localX >= PIANO_ROOT_CLEARANCE.minX - margin &&
    localX <= PIANO_ROOT_CLEARANCE.maxX + margin &&
    localZ >= PIANO_ROOT_CLEARANCE.minZ - margin &&
    localZ <= PIANO_ROOT_CLEARANCE.maxZ + margin;
}

function dryRoot(map: WorldMap, x: number, z: number, radius: number): number | null {
  if (map.isWater(x, z)) return null;
  const center = map.groundTop(x, z);
  let minY = center;
  let maxY = center;
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI * 0.25 + i * Math.PI * 0.5;
    const sx = x + Math.cos(angle) * radius;
    const sz = z + Math.sin(angle) * radius;
    if (map.isWater(sx, sz)) return null;
    const y = map.groundTop(sx, sz);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return maxY - minY <= Math.max(0.45, radius * 0.34) ? center : null;
}

function collectTrees(map: WorldMap): AuthoredTreePlacement[] {
  const placements: AuthoredTreePlacement[] = [];
  // Evenly inspect the whole ring, then nudge/radially retry each sector. The
  // shoreline naturally rejects seaward candidates while retaining a grove on
  // every dry side of the performance. A clear axial aisle preserves the
  // authored arrival shot from the player through the piano to the bridge.
  for (let sector = 0; sector < 38 && placements.length < TREE_LIMIT; sector++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const angle = sector * GOLDEN_ANGLE + (hash(sector, 17 + attempt) - 0.5) * 0.34;
      const radius = 9.5 + hash(sector, 31 + attempt) * 20.5 + attempt * 0.55;
      const x = SITE_X + Math.cos(angle) * radius;
      const z = SITE_Z + Math.sin(angle) * radius;
      if (distanceFromBridgeSightline(x, z) < 4.2 && radius < 24) continue;
      const y = dryRoot(map, x, z, 2);
      if (y === null) continue;
      const archetype = sector % 5 === 0
        ? "pianist-pine"
        : sector % 3 === 0
          ? "pianist-cypress-shelf"
          : "pianist-cypress-elder";
      placements.push({
        x,
        y,
        z,
        yaw: 0.88 + hash(sector, 53) * 0.8,
        scale: 0.78 + hash(sector, 71) * 0.34,
        archetype,
        nearDetail: true
      });
      break;
    }
  }
  return placements;
}

function collectFlowers(map: WorldMap): AuthoredFlowerPlacement[] {
  const placements: AuthoredFlowerPlacement[] = [];
  for (let i = 0; i < 2_200 && placements.length < 520; i++) {
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

const GRASS_COLORS = [
  new THREE.Color(0x526b32),
  new THREE.Color(0x66763a),
  new THREE.Color(0x7d7d43),
  new THREE.Color(0x45602f),
  new THREE.Color(0x8b854d)
] as const;

function collectGrass(map: WorldMap): GrassEntry[] {
  const placements: GrassEntry[] = [];
  const normal = new THREE.Vector3();
  const spacing = 0.82;
  const halfExtent = 30;
  let index = 0;

  for (let dz = -halfExtent; dz <= halfExtent; dz += spacing) {
    for (let dx = -halfExtent; dx <= halfExtent; dx += spacing) {
      const i = index++;
      // Jittered cells avoid a planted grid while preserving continuous
      // coverage all the way to the water and onto the lower bluff.
      const x = SITE_X + dx + (hash(i, 127) - 0.5) * spacing * 0.72;
      const z = SITE_Z + dz + (hash(i, 131) - 0.5) * spacing * 0.72;
      if (rootIntersectsPiano(x, z, 0.12) || hash(i, 137) < 0.08) continue;
      const y = dryRoot(map, x, z, 0.32);
      if (y === null) continue;
      map.normal(x, z, normal, 0.65);
      if (normal.y < 0.52) continue;

      placements.push({
        x,
        y: y - 0.025,
        z,
        yaw: hash(i, 139) * Math.PI * 2,
        height: 0.48 + hash(i, 149) * 0.62,
        spread: 0.72 + hash(i, 151) * 0.3,
        color: GRASS_COLORS[Math.floor(hash(i, 157) * GRASS_COLORS.length) % GRASS_COLORS.length],
        windAmp: 0.7 + hash(i, 163) * 0.46
      });
    }
  }
  return placements;
}

export function createBeachPianistFoliage(map: WorldMap): BeachPianistFoliage {
  const treePlacements = collectTrees(map);
  const flowerPlacements = collectFlowers(map);
  const grassPlacements = collectGrass(map);
  const group = new THREE.Group();
  group.name = "beachPianist.unified_foliage";

  const trees = createAuthoredTreePatch(TREE_ARCHETYPES, treePlacements, {
    name: "beach_pianist_cypress",
    chunkSize: 52,
    visibleDistance: 850,
    nearRadius: 76,
    nearExitRadius: 94,
    // Every tree in this compact 30 m grove can be overhead at once. Letting
    // six of the 24 lose the close pool exposed the opaque landscape needle
    // cards as tan/blocky leaves when the camera looked upward beneath them.
    nearMax: TREE_LIMIT,
    // The god-ray raymarch samples its dedicated light's shadow map; without
    // the grove in that map there are no shafts through the canopy, only a
    // uniform veil. The sun's clipmap cameras never see these casters.
    conventionalShadowCasting: true
  });
  const flowers = createAuthoredFlowerPatch(flowerPlacements, {
    name: "beach_pianist_flowers",
    palettes: {
      lupine: { a: 0x735fc7, b: 0xaa91e2 },
      poppy: { a: 0xf06c28, b: 0xffa13b },
      yarrow: { a: 0xf3e8c9, b: 0xf2ca64 },
      goldfield: { a: 0xf4c62d, b: 0xffdf58 }
    }
  });
  const grassSourceGeometry = createBladeClusterGeometry({
    blades: 7,
    segments: 3,
    width: 0.085,
    radius: 0.38,
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
  return {
    group,
    ready: trees.ready,
    update(focus, force = false) {
      if (!disposed) trees.update(focus, force);
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
    stats: {
      trees: treePlacements.length,
      flowerClumps: flowers.stats.instances,
      flowerHeads: flowers.stats.heads,
      grassClusters: grassPlacements.length,
      grassBlades: grassPlacements.length * 7
    }
  };
}
