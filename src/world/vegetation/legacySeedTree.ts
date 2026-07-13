// Transitional boundary around the vendored SeedThree tree builder.
//
// Runtime consumers own placement, caching, LOD policy, batching, and culling.
// This adapter owns the remaining vendor-specific construction details until
// the sandbox-native tree compiler replaces them.

import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { createTree } from "../../../vendor/SeedThree/src/api/seedthree.js";

export type LegacySeedTreeFoliageGrade = {
  colorScale: number;
  tint: number;
  tintMix: number;
};

export type LegacySeedTreeOptions = {
  species: string;
  seed: number;
  controls?: Record<string, unknown>;
  lod: Record<string, unknown>;
  foliageGrade: LegacySeedTreeFoliageGrade;
};

export type LegacySeedTreeResult = {
  template: THREE.LOD;
  lod2: THREE.Object3D;
};

const FOLIAGE_MESH_RE = /leaf|foliage|card|cluster|rosette|frond/i;

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

const textureLoader = new THREE.TextureLoader();

async function loadTexture(path: string, { srgb }: { srgb: boolean }): Promise<THREE.Texture | null> {
  const apply = (texture: THREE.Texture) => {
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    return texture;
  };

  // Prefer optimized WebP siblings, while retaining the source image fallback
  // for optional maps that have not been converted.
  const webp = path.replace(/\.(png|jpg)$/i, ".webp");
  if (webp !== path) {
    try {
      return apply(await textureLoader.loadAsync(`/${webp}`));
    } catch {
      // No WebP sibling; try the original path below.
    }
  }
  try {
    return apply(await textureLoader.loadAsync(`/${path}`));
  } catch {
    return null;
  }
}

function prepareTemplate(lodGroup: THREE.Object3D): THREE.LOD {
  const lod = lodGroup as THREE.LOD;
  // Headless growth has no baked billboard, but filter defensively and remove
  // any app-only preview level that slips through.
  if (lod.levels) {
    for (let i = lod.levels.length - 1; i >= 0; i--) {
      const object = lod.levels[i].object;
      if (object.userData?.isBillboard || object.userData?.appOnly) lod.levels.splice(i, 1);
    }
  }
  lod.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  return lod;
}

function gradeFoliage(root: THREE.Object3D, grade: LegacySeedTreeFoliageGrade) {
  const seen = new Set<THREE.Material>();
  const tint = new THREE.Color(grade.tint);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const foliageLike =
      FOLIAGE_MESH_RE.test(mesh.name) ||
      materials.some((raw) => {
        const material = raw as ShadeableFoliageMaterial;
        return (
          FOLIAGE_MESH_RE.test(material.name) ||
          Boolean(material.thicknessColorNode || material.userData?.gltfDiffuseTransmission)
        );
      });
    if (!foliageLike) return;

    for (const raw of materials) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      const material = raw as ShadeableFoliageMaterial;
      if (material.color?.isColor) {
        material.color.multiplyScalar(grade.colorScale).lerp(tint, grade.tintMix);
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

export async function createLegacySeedTree(options: LegacySeedTreeOptions): Promise<LegacySeedTreeResult> {
  const { group } = await createTree({
    species: options.species,
    seed: options.seed,
    controls: options.controls ?? {},
    lod: options.lod,
    loadTexture,
    assetsDir: "seedthree"
  });
  const template = prepareTemplate(group);
  gradeFoliage(template, options.foliageGrade);
  const lod2 =
    template.levels?.find((level) => level.object.userData?.lodName === "LOD2")?.object ??
    template.levels?.[template.levels.length - 1]?.object ??
    template;
  return { template, lod2 };
}
