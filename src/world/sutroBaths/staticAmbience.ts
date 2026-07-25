import * as THREE from "three/webgpu";
import {
  lightAnchor,
  registerAmbientLightAnchor,
  type LightAnchorSpec
} from "../../player/lightPool";
import type { AuthoredRegionStreamer } from "../authoredRegions";
import { SUTRO_BATHS, sutroLocalToWorld } from "./layout";

export type SutroStaticAmbienceTuning = {
  glassOpacity: number;
  lampIntensity: number;
};

export type SutroStaticAmbience = {
  group: THREE.Group;
  applyTuning(values: SutroStaticAmbienceTuning): void;
  update(time: number, values?: SutroStaticAmbienceTuning): void;
  dispose(): void;
};

/** Runtime-only lighting/material control for the Blender-authored static region. */
export function createSutroStaticAmbience(regions?: AuthoredRegionStreamer): SutroStaticAmbience {
  const group = new THREE.Group();
  group.name = "sutro_baths_runtime_ambience";
  const lampSpecs: LightAnchorSpec[] = [];
  const unregisterLights: (() => void)[] = [];
  const glass = new Set<THREE.MeshStandardMaterial>();
  let requestedLampIntensity = 4.6;
  let requestedGlassOpacity = 0.162;

  const lampY = SUTRO_BATHS.deckY + 9.95;
  let index = 0;
  for (const z of [-55, -37, -19, -1, 17, 35, 53]) {
    for (const x of [-18.4, 11.2]) {
      if (index % 3 === 0) {
        const world = sutroLocalToWorld(x, z);
        const spec: LightAnchorSpec = {
          color: 0xffd79a,
          intensity: requestedLampIntensity * 11,
          distance: 24,
          range: 50
        };
        const anchor = lightAnchor(spec, world.x, lampY, world.z);
        anchor.name = `sutro_baths_warm_lamp_${index}`;
        lampSpecs.push(spec);
        group.add(anchor);
        unregisterLights.push(registerAmbientLightAnchor(anchor));
      }
      index++;
    }
  }

  const collectMaterials = (root: THREE.Object3D) => {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const candidate of materials) {
        if (!(candidate instanceof THREE.MeshStandardMaterial)) continue;
        if (candidate.name === "sutro_roof_glass" || candidate.name === "sutro_window_glass") {
          glass.add(candidate);
          // Keep the huge roof airy and visually continuous. The shared,
          // correctly typed viewport-depth path in waterShadingTSL now removes
          // the actual refraction corruption without stippling every pane.
          candidate.transparent = true;
          candidate.depthWrite = false;
          candidate.alphaHash = false;
          candidate.opacity = requestedGlassOpacity;
          candidate.needsUpdate = true;
        }
      }
    });
  };
  const unwatch = regions?.watch("sutro-baths", collectMaterials, () => glass.clear()) ?? (() => {});

  const applyTuning = (values: SutroStaticAmbienceTuning) => {
    requestedLampIntensity = Math.max(0, values.lampIntensity);
    const opacity = THREE.MathUtils.clamp(values.glassOpacity * 1.35, 0.05, 0.64);
    if (Math.abs(opacity - requestedGlassOpacity) < 1e-4) return;
    requestedGlassOpacity = opacity;
    for (const material of glass) {
      material.opacity = opacity;
    }
  };

  return {
    group,
    applyTuning,
    update(time, values) {
      if (values) applyTuning(values);
      for (let lightIndex = 0; lightIndex < lampSpecs.length; lightIndex++) {
        const drift = 0.975 + Math.sin(time * 2.1 + lightIndex * 2.71) * 0.025;
        lampSpecs[lightIndex].intensity = requestedLampIntensity * 11 * drift;
      }
    },
    dispose() {
      unwatch();
      for (const unregister of unregisterLights) unregister();
      glass.clear();
      group.clear();
      group.removeFromParent();
    }
  };
}
