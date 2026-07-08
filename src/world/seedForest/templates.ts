// Grow-once SeedThree hero cache. Every consumer (wildlands regions, future
// city scatter) asks for a design; each distinct design grows exactly once per
// session no matter how many forests use it. createTree is CPU-heavy (hundreds
// of ms), so growth is serialized through one chain — parallel growth just
// thrashes the main thread.
//
// This is Phase-0 seed of feature-research/seedtrees-citywide-plan.md. The
// botanical garden still grows its own heroes (different seeds/controls — no
// sharing win); unifying it onto this cache is the plan's Phase 0 cleanup.

import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { createTree } from "../../../vendor/SeedThree/src/api/seedthree.js";

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

const FOLIAGE_MESH_RE = /leaf|foliage|card|cluster|rosette|frond/i;
// Slightly lighter, greener target than the garden's original 0x4e623a — the
// wildlands sit on open sunny hills, and the darker tint read as brown at range.
const FAR_CARD_TINT = new THREE.Color(0x5c7440);

type ShadeableFoliageMaterial = THREE.Material & {
  color?: THREE.Color;
  roughness?: number;
  metalness?: number;
  thicknessColorNode?: { mul?: (v: number) => unknown };
  thicknessDistortionNode?: unknown;
  thicknessAmbientNode?: unknown;
  thicknessPowerNode?: unknown;
  thicknessScaleNode?: unknown;
};

/** Deepen + de-saturate SeedThree foliage toward the city's palette and tame
 *  SSS so far cards don't glow (same recipe as the botanical garden). */
function shadeSeedTreeFoliage(root: THREE.Object3D) {
  const seen = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const foliageLike =
      FOLIAGE_MESH_RE.test(mesh.name) ||
      materials.some((material) => {
        const m = material as ShadeableFoliageMaterial;
        return FOLIAGE_MESH_RE.test(m.name) || Boolean(m.thicknessColorNode || m.userData?.gltfDiffuseTransmission);
      });
    if (!foliageLike) return;
    for (const raw of materials) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      const material = raw as ShadeableFoliageMaterial;
      if (material.color?.isColor) {
        material.color.multiplyScalar(0.64).lerp(FAR_CARD_TINT, 0.34);
      }
      if (typeof material.roughness === "number") material.roughness = Math.max(material.roughness, 0.96);
      if (typeof material.metalness === "number") material.metalness = 0;
      if (material.thicknessColorNode?.mul) {
        material.thicknessColorNode = material.thicknessColorNode.mul(0.3) as ShadeableFoliageMaterial["thicknessColorNode"];
      }
      if ("thicknessDistortionNode" in material) material.thicknessDistortionNode = uniform(0.18);
      if ("thicknessAmbientNode" in material) material.thicknessAmbientNode = uniform(0.025);
      if ("thicknessPowerNode" in material) material.thicknessPowerNode = uniform(8.5);
      if ("thicknessScaleNode" in material) material.thicknessScaleNode = uniform(0.75);
      material.needsUpdate = true;
    }
  });
}

const textureLoader = new THREE.TextureLoader();
async function loadTexture(path: string, { srgb }: { srgb: boolean }): Promise<THREE.Texture | null> {
  try {
    const t = await textureLoader.loadAsync(`/${path}`);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  } catch {
    return null; // optional maps 404 → SeedThree material factories fall back
  }
}

function prepareTemplate(lodGroup: THREE.Object3D): THREE.LOD {
  const lod = lodGroup as THREE.LOD;
  if (lod.levels) {
    for (let i = lod.levels.length - 1; i >= 0; i--) {
      const o = lod.levels[i].object;
      if (o.userData?.isBillboard || o.userData?.appOnly) lod.levels.splice(i, 1);
    }
  }
  lod.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return lod;
}

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
    const { group: lodGroup } = await createTree({
      species: design.species,
      seed: design.seed,
      controls: design.controls ?? {},
      lod: LOD_OPTS,
      loadTexture,
      assetsDir: "seedthree"
    });
    const template = prepareTemplate(lodGroup);
    shadeSeedTreeFoliage(template);
    const lod2 =
      template.levels?.find((l) => l.object.userData?.lodName === "LOD2")?.object ??
      template.levels?.[template.levels.length - 1]?.object ??
      template;
    return { design, template, lod2 };
  });
  growthChain = grown.catch(() => undefined); // one failed species must not block the chain
  cache.set(key, grown);
  return grown;
}
