// Lazy city-park planting adapter for the shared vegetation runtime.
//
// Reached only through SiteFoliageStreamer on first approach to a park group.
// The groups own botanical intent (layout.ts); NativeTreeForest owns
// compilation, instancing, wind, LOD and chunk culling. Archetypes are shared
// by every group so the session prototype cache compiles each species once.

import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import {
  createAuthoredTreePatch,
  type AuthoredTreeArchetype,
  type AuthoredTreePlacement
} from "../vegetation/authoredTrees";
import { CITY_PARK_GROUPS, collectCityParkTrees, type CityTreeKind } from "./layout";

export type CityParkFoliage = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }, force?: boolean): void;
  dispose(): void;
  stats: { trees: number };
};

const ARCHETYPES: Record<CityTreeKind, AuthoredTreeArchetype> = {
  cypress: {
    id: "city-cypress",
    design: { species: "monterey-cypress", seed: 6101, controls: { height: 15, crownDensity: 0.95, crownWidth: 1.1, foliageColor: 0x3c5c40, windResponse: 0.55 }, sink: 0.3 }
  },
  windswept: {
    id: "city-windswept",
    design: { species: "windswept-monterey-cypress", seed: 6102, controls: { height: 12, crownDensity: 0.98, crownWidth: 1.12, foliageColor: 0x355338, windResponse: 0.5 }, sink: 0.3 }
  },
  pine: {
    id: "city-pine",
    design: { species: "monterey-pine", seed: 6103, controls: { height: 17, crownDensity: 0.92, foliageColor: 0x3f5f3a, windResponse: 0.6 }, sink: 0.3 }
  },
  oak: {
    id: "city-oak",
    design: { species: "coast-live-oak", seed: 6104, controls: { height: 10, crownDensity: 0.95, crownWidth: 1.12, foliageColor: 0x4a6a35, windResponse: 0.62 }, sink: 0.25 }
  },
  eucalyptus: {
    id: "city-eucalyptus",
    design: { species: "eucalyptus", seed: 6105, controls: { height: 22, crownDensity: 0.88, foliageColor: 0x6b8466, windResponse: 0.7 }, sink: 0.3 }
  },
  redwood: {
    id: "city-redwood",
    design: { species: "coast-redwood", seed: 6106, controls: { height: 26, crownDensity: 0.95, foliageColor: 0x2f4d2f, windResponse: 0.45 }, sink: 0.35 }
  },
  palm: {
    id: "city-palm",
    design: { species: "chilean-palm", seed: 6107, controls: { height: 12, windResponse: 1 }, sink: 0.2 }
  },
  magnolia: {
    id: "city-magnolia",
    design: { species: "magnolia", seed: 6108, controls: { height: 9, crownDensity: 0.95, windResponse: 0.6 }, sink: 0.2 }
  },
  cherry: {
    id: "city-cherry",
    design: { species: "flowering-cherry", seed: 6109, controls: { height: 7, crownDensity: 0.95, windResponse: 0.65 }, sink: 0.2 }
  }
};

export function createCityParkFoliage(map: WorldMap, groupId: string): CityParkFoliage {
  const parkGroup = CITY_PARK_GROUPS.find((g) => g.id === groupId);
  if (!parkGroup) throw new Error(`[city-parks] unknown group '${groupId}'`);
  const trees = collectCityParkTrees(map, parkGroup);
  const used = new Set(trees.map((t) => t.kind));
  const archetypes = [...used].map((kind) => ARCHETYPES[kind]);
  const placements: AuthoredTreePlacement[] = trees.map((tree) => ({
    x: tree.x,
    y: map.groundTop(tree.x, tree.z),
    z: tree.z,
    yaw: tree.yaw,
    scale: tree.scale,
    archetype: ARCHETYPES[tree.kind].id
  }));

  const group = new THREE.Group();
  group.name = `cityParks.${groupId}`;
  const patch = createAuthoredTreePatch(archetypes, placements, {
    name: groupId.replace(/-/g, "_"),
    chunkSize: parkGroup.visibleDistance > 1500 ? 176 : 96,
    visibleDistance: parkGroup.visibleDistance,
    nearRadius: 90,
    nearExitRadius: 110,
    nearMax: 48
  });
  group.add(patch.group);

  let disposed = false;
  return {
    group,
    ready: patch.ready,
    update(focus, force = false) {
      if (!disposed) patch.update(focus, force);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      patch.dispose();
      group.removeFromParent();
    },
    stats: { trees: placements.length }
  };
}
