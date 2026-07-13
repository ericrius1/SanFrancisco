// Authored-tree adapter for landmarks and compact parks.
//
// Parks own only botanical intent (archetype + rooted transform). The shared
// SeedForest renderer owns growth, wind-shaded foliage, near/far LOD, chunk
// culling, shadow proxies, warmup and the session-wide template cache.

import * as THREE from "three/webgpu";
import {
  createSeedForest,
  type SeedForestOptions,
  type SeedForestSlot,
  type SeedTreeDesignSpec
} from "../seedForest";

export type AuthoredTreeArchetype = {
  id: string;
  design: SeedTreeDesignSpec;
};

export type AuthoredTreePlacement = {
  x: number;
  /** Root surface height. The archetype's sink is applied by SeedForest. */
  y: number;
  z: number;
  yaw: number;
  scale: number;
  archetype: string;
  /** false keeps this individual in the instanced tier at every distance. */
  nearClone?: boolean;
};

export type AuthoredTreePatchOptions = Omit<SeedForestOptions, "name"> & {
  name: string;
};

export type AuthoredTreePatch = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }): void;
  dispose(): void;
  stats: {
    archetypes: number;
    placements: number;
    chunks(): number;
    nearActive(): number;
  };
};

export function createAuthoredTreePatch(
  archetypes: readonly AuthoredTreeArchetype[],
  placements: readonly AuthoredTreePlacement[],
  options: AuthoredTreePatchOptions
): AuthoredTreePatch {
  const indexById = new Map<string, number>();
  const designs: SeedTreeDesignSpec[] = [];
  for (const archetype of archetypes) {
    if (indexById.has(archetype.id)) {
      throw new Error(`[vegetation:${options.name}] duplicate tree archetype '${archetype.id}'`);
    }
    indexById.set(archetype.id, designs.length);
    designs.push(archetype.design);
  }

  const slots: SeedForestSlot[] = placements.map((placement) => {
    const design = indexById.get(placement.archetype);
    if (design === undefined) {
      throw new Error(
        `[vegetation:${options.name}] unknown tree archetype '${placement.archetype}' at ${placement.x},${placement.z}`
      );
    }
    return {
      x: placement.x,
      y: placement.y,
      z: placement.z,
      yaw: placement.yaw,
      scale: placement.scale,
      design,
      nearClone: placement.nearClone
    };
  });

  const forest = createSeedForest(designs, slots, options);
  let disposed = false;
  return {
    group: forest.group,
    ready: forest.ready,
    update: forest.update,
    dispose() {
      if (disposed) return;
      disposed = true;
      // SeedForest disposes only per-patch far geometry/proxies/driver state;
      // session-cached template geometry and materials remain shared.
      forest.dispose();
    },
    stats: {
      archetypes: archetypes.length,
      placements: placements.length,
      chunks: () => forest.stats.chunks,
      nearActive: forest.stats.nearActive
    }
  };
}
