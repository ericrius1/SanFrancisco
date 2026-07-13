// Grow-once SeedThree hero cache. Every consumer (wildlands regions, future
// city scatter) asks for a design; each distinct design grows exactly once per
// session no matter how many forests use it. createTree is CPU-heavy (hundreds
// of ms), so growth is serialized through one chain — parallel growth just
// thrashes the main thread.
//
// The botanical garden still grows its own heroes (different seeds/controls —
// no sharing win); unifying it onto this cache is a later cleanup.

import * as THREE from "three/webgpu";
import { createLegacySeedTree } from "../vegetation/legacySeedTree";

export type SeedTreeDesignSpec = {
  species: string;
  seed: number;
  controls?: Record<string, unknown>;
  /** sink the trunk base this far (× slot scale) into the ground */
  sink: number;
  /** false → never promote to a hero clone (rosette species: 16s clone stall) */
  nearClones?: boolean;
};

export type GrownTemplate = {
  design: SeedTreeDesignSpec;
  /** hero THREE.LOD (LOD0/1/2 baked in, shadows on, foliage shaded) */
  template: THREE.LOD;
  /** the LOD2 level — source for instanced far tiers */
  lod2: THREE.Object3D;
};

// Hero-clone LOD switch distances. lod2Dist is kept BELOW the seedForest near
// radius (see index.ts) on purpose: a hero clone is already showing LOD2 by the
// time it hands off to the instanced far tier (same LOD2 geometry), so the
// clone→far swap is seamless instead of popping full-geometry → flat cards.
const LOD_OPTS = { lod1Dist: 46, lod2Dist: 78 };
// Slightly lighter, greener target than the garden's original 0x4e623a — the
// wildlands sit on open sunny hills, and the darker tint read as brown at range.
const FOLIAGE_GRADE = { colorScale: 0.64, tint: 0x5c7440, tintMix: 0.34 };

const cache = new Map<string, Promise<GrownTemplate>>();
// Serialize all growth through one chain — never two createTree calls at once.
let growthChain: Promise<unknown> = Promise.resolve();

function designKey(d: SeedTreeDesignSpec): string {
  return `${d.species}:${d.seed}:${JSON.stringify(d.controls ?? {})}`;
}

export function growTemplate(design: SeedTreeDesignSpec): Promise<GrownTemplate> {
  const key = designKey(design);
  const hit = cache.get(key);
  if (hit) return hit;
  const grown = growthChain.then(async () => {
    const { template, lod2 } = await createLegacySeedTree({
      species: design.species,
      seed: design.seed,
      controls: design.controls ?? {},
      lod: LOD_OPTS,
      foliageGrade: FOLIAGE_GRADE
    });
    return { design, template, lod2 };
  });
  growthChain = grown.catch(() => undefined); // one failed species must not block the chain
  cache.set(key, grown);
  return grown;
}
