// Authored-tree adapter for landmarks and compact parks.
//
// Parks own only botanical intent (archetype + rooted transform). The shared
// NativeTreeForest owns compilation, shared geometry, wind-shaded foliage, LOD,
// chunk culling, shadow proxies and the session-wide prototype cache.

import * as THREE from "three/webgpu";
import {
  createNativeTreeForest,
  type NativeTreeForestOptions,
  type NativeTreeSlot,
  type NativeTreeDesignSpec
} from "../nativeTreeForest";

export type AuthoredTreeArchetype = {
  id: string;
  design: NativeTreeDesignSpec;
};

export type AuthoredTreePlacement = {
  x: number;
  /** Root surface height. The archetype's sink is applied by NativeTreeForest. */
  y: number;
  z: number;
  yaw: number;
  scale: number;
  archetype: string;
  /** False keeps this individual in landscape LOD at every distance. */
  nearDetail?: boolean;
};

export type AuthoredTreePatchOptions = Omit<NativeTreeForestOptions, "name"> & {
  name: string;
};

export type AuthoredTreePatch = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }, force?: boolean): void;
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
  const designs: NativeTreeDesignSpec[] = [];
  for (const archetype of archetypes) {
    if (indexById.has(archetype.id)) {
      throw new Error(`[vegetation:${options.name}] duplicate tree archetype '${archetype.id}'`);
    }
    indexById.set(archetype.id, designs.length);
    designs.push(archetype.design);
  }

  const slots: NativeTreeSlot[] = placements.map((placement) => {
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
      nearDetail: placement.nearDetail
    };
  });

  const forest = createNativeTreeForest(designs, slots, options);
  let disposed = false;
  return {
    group: forest.group,
    ready: forest.ready,
    update: forest.update,
    dispose() {
      if (disposed) return;
      disposed = true;
      // Session-cached compiler prototypes remain bounded and shared.
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
