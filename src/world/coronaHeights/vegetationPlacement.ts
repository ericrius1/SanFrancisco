// Corona Heights owns WHERE plants grow, not how they render.  Keep the hill's
// deterministic scatter, trail/dog-park exclusions, and authored tree row here
// as plain placement data so every plant can use the shared vegetation renderers.

import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import { fitGroundY } from "../groundcover/grounding";
import type { NativeTreeDesignSpec } from "../nativeTreeForest";
import { CORONA_HEIGHTS_SUMMIT } from "./layout";
import { summitKeepOut } from "./summitCrags";

const HILL_RX = 118;
const HILL_RZ = 126;

export type CoronaPlacementRules = {
  hash(x: number, z: number, salt?: number): number;
  inDogPark(x: number, z: number): boolean;
  distanceToTrails(x: number, z: number): number;
};

export type CoronaGrassPlacement = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
  spread: number;
  color: number;
  hueJitter: number;
  lightnessJitter: number;
  windAmp: number;
};

export type CoronaFlowerSpecies = "poppy" | "lupine" | "yarrow" | "goldfield";

export type CoronaFlowerPlacement = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  species: CoronaFlowerSpecies;
  tint: number;
};

export type CoronaShrubPlacement = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  palette: number;
  profile: "natural";
};

export type CoronaTreeArchetype = {
  id: string;
  design: NativeTreeDesignSpec;
};

export type CoronaTreePlacement = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  archetype: string;
};

export type CoronaVegetationPlacements = {
  grass: CoronaGrassPlacement[];
  flowers: CoronaFlowerPlacement[];
  shrubs: CoronaShrubPlacement[];
  treeArchetypes: readonly CoronaTreeArchetype[];
  trees: CoronaTreePlacement[];
};

// A broad, low coast-live-oak design carries the summit's authored shelter-belt
// silhouette through the same tree pipeline used by the rest of the world.
const TREE_ARCHETYPES: readonly CoronaTreeArchetype[] = [
  {
    id: "corona_coast_live_oak",
    design: {
      species: "coast-live-oak",
      seed: 1933,
      controls: {
        height: 8,
        crownDensity: 0.95,
        crownWidth: 0.72,
        foliageColor: 0x526b38
      },
      sink: 0.24
    }
  }
] as const;

// Authored locations are a deliberate north/east shelter belt.  Heights remain
// the source of truth; the renderer receives them as scales relative to the
// eight-metre archetype rather than inventing a second local tree geometry.
const TREE_SPOTS: readonly [x: number, z: number, height: number][] = [
  [331, 2675, 5.4],
  [346, 2673, 6.6],
  [365, 2670, 7.1],
  [384, 2668, 6.2],
  [404, 2668, 7.6],
  [424, 2674, 5.8],
  [462, 2719, 5.1],
  [490, 2738, 6.4],
  [505, 2774, 5.3]
] as const;

function collectGrass(map: WorldMap, rules: CoronaPlacementRules): CoronaGrassPlacement[] {
  const entries: CoronaGrassPlacement[] = [];
  const normal = new THREE.Vector3();
  const sampleGroundTop = (x: number, z: number) => map.groundTop(x, z);
  for (let gz = -49; gz <= 49 && entries.length < 960; gz++) {
    for (let gx = -46; gx <= 46 && entries.length < 960; gx++) {
      const x = CORONA_HEIGHTS_SUMMIT.x + gx * 2.55 + (rules.hash(gx, gz, 3) - 0.5) * 2.1;
      const z = CORONA_HEIGHTS_SUMMIT.z + 8 + gz * 2.55 + (rules.hash(gx, gz, 5) - 0.5) * 2.1;
      const q = ((x - CORONA_HEIGHTS_SUMMIT.x) / HILL_RX) ** 2 + ((z - CORONA_HEIGHTS_SUMMIT.z - 8) / HILL_RZ) ** 2;
      if (q > 0.94 || rules.hash(gx, gz, 7) > 0.22) continue;
      if (rules.inDogPark(x, z) || rules.distanceToTrails(x, z) < 2.7) continue;
      if (summitKeepOut(x, z, 1)) continue;
      const centerY = map.groundTop(x, z);
      map.normal(x, z, normal, 2);
      if (normal.y < 0.86 || (centerY > 140 && rules.hash(gx, gz, 11) > 0.48)) continue;
      const s = 0.45 + rules.hash(gx, gz, 13) * 0.9;
      const scaleX = s * (0.72 + rules.hash(gx, gz, 19) * 0.5);
      const scaleZ = s * (0.72 + rules.hash(gx, gz, 23) * 0.5);
      const groundY = fitGroundY(sampleGroundTop, x, z, 0.5 * Math.max(scaleX, scaleZ), 0.85, 0.045);
      if (groundY === null) continue;
      entries.push({
        x,
        y: groundY,
        z,
        yaw: rules.hash(gx, gz, 17) * Math.PI * 2,
        height: s,
        spread: (scaleX + scaleZ) * 0.5,
        color: rules.hash(gx, gz, 29) > 0.45 ? 0x7c7d34 : 0x536f35,
        hueJitter: (rules.hash(gx, gz, 31) - 0.5) * 0.05,
        lightnessJitter: (rules.hash(gx, gz, 37) - 0.5) * 0.12,
        windAmp: 0.78 + s * 0.3
      });
    }
  }
  return entries;
}

function collectFlowers(map: WorldMap, rules: CoronaPlacementRules): CoronaFlowerPlacement[] {
  const entries: CoronaFlowerPlacement[] = [];
  const species: readonly CoronaFlowerSpecies[] = ["poppy", "lupine", "yarrow", "goldfield"];
  for (let i = 0; i < 1800 && entries.length < 220; i++) {
    const a = rules.hash(i, 1, 71) * Math.PI * 2;
    const r = Math.sqrt(rules.hash(i, 2, 73));
    const x = CORONA_HEIGHTS_SUMMIT.x + Math.cos(a) * HILL_RX * r;
    const z = CORONA_HEIGHTS_SUMMIT.z + 8 + Math.sin(a) * HILL_RZ * r;
    if (rules.hash(i, 3, 79) > 0.18 || rules.inDogPark(x, z) || rules.distanceToTrails(x, z) < 3.2) continue;
    const y = map.groundTop(x, z);
    if (y > 145 || summitKeepOut(x, z, 1.5)) continue;
    const palette = Math.floor(rules.hash(i, 17) * species.length) % species.length;
    entries.push({
      x,
      y: y - 0.03,
      z,
      yaw: rules.hash(i, 11) * Math.PI * 2,
      scale: 0.7 + rules.hash(i, 5, 83) * 0.55,
      species: species[palette],
      tint: rules.hash(i, 13)
    });
  }
  return entries;
}

function collectShrubs(map: WorldMap, rules: CoronaPlacementRules): CoronaShrubPlacement[] {
  const entries: CoronaShrubPlacement[] = [];
  for (let i = 0; i < 420 && entries.length < 72; i++) {
    const a = rules.hash(i, 2, 91) * Math.PI * 2;
    const r = 0.72 + rules.hash(i, 3, 97) * 0.28;
    const x = CORONA_HEIGHTS_SUMMIT.x + Math.cos(a) * HILL_RX * r;
    const z = CORONA_HEIGHTS_SUMMIT.z + 8 + Math.sin(a) * HILL_RZ * r;
    if (rules.hash(i, 5, 101) > 0.27 || rules.distanceToTrails(x, z) < 3 || rules.inDogPark(x, z)) continue;
    const scale = 0.7 + rules.hash(i, 7, 103) * 1.35;
    entries.push({
      x,
      y: map.groundTop(x, z),
      z,
      yaw: rules.hash(i, 11) * Math.PI * 2,
      scale,
      palette: rules.hash(i, 13) > 0.3 ? 0 : 1,
      profile: "natural"
    });
  }
  return entries;
}

function collectTrees(map: WorldMap, rules: CoronaPlacementRules): CoronaTreePlacement[] {
  return TREE_SPOTS.map(([x, z, height], i) => ({
    x,
    y: map.groundTop(x, z),
    z,
    yaw: rules.hash(i, 3, 107) * Math.PI * 2,
    scale: height / 8,
    archetype: TREE_ARCHETYPES[0].id
  }));
}

export function collectCoronaVegetationPlacements(
  map: WorldMap,
  rules: CoronaPlacementRules
): CoronaVegetationPlacements {
  return {
    grass: collectGrass(map, rules),
    flowers: collectFlowers(map, rules),
    shrubs: collectShrubs(map, rules),
    treeArchetypes: TREE_ARCHETYPES,
    trees: collectTrees(map, rules)
  };
}
