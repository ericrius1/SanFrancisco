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
  lampWarmth: number;
  interiorWarmth: number;
};

export type SutroStaticAmbience = {
  group: THREE.Group;
  applyTuning(values: SutroStaticAmbienceTuning): void;
  /** 0 = ordinary daylight hall, 1 = deep in the out-of-time twilight. */
  setTwilight(depth: number): void;
  update(time: number, values?: SutroStaticAmbienceTuning): void;
  dispose(): void;
};

/**
 * Runtime-only lighting/material control for the Blender-authored static region.
 *
 * The hall's own lamps do the heavy lifting once the pocket twilight settles in.
 * They are EMISSIVE GEOMETRY, not scene lights — the renderer's light set is one
 * sun plus one pooled contextual light for the whole world, and growing it
 * recompiles every lit pipeline (player/lightPool.ts). So `setTwilight` lifts
 * the bulbs' emissive, warms the room's surfaces toward lamplight, and lets the
 * single pooled anchor near the visitor do the real shading.
 *
 * Every graded material is captured at its authored value the first time it is
 * seen and restored on dispose, so a region that streams out and back in never
 * accumulates the grade twice.
 */

/** The authored materials that should feel the lamps, and how strongly. */
const WARM_TARGETS: Readonly<Record<string, number>> = {
  sutro_terracotta: 1,
  sutro_cream_tile: 0.92,
  sutro_plaster: 0.85,
  sutro_plaster_shade: 0.85,
  sutro_white_tile: 0.7,
  sutro_timber: 0.8,
  sutro_timber_dark: 0.8,
  sutro_brass: 1.1,
  sutro_blue_tile: 0.45,
  sutro_deep_tile: 0.4,
  sutro_iron: 0.5,
  sutro_iron_light: 0.5,
  sutro_iron_dark: 0.45
};

const GLASS_NAMES = new Set(["sutro_roof_glass", "sutro_window_glass"]);
const LAMP_NAME = "sutro_lamp";

/** Lamplight, and the cool the room falls away to between the pools. */
const LAMP_TINT = new THREE.Color(0xffb469);
const LAMP_EMISSIVE = new THREE.Color(0xffc07a);
const GLASS_TINT = new THREE.Color(0xff9d5e);

type GradedMaterial = {
  material: THREE.MeshStandardMaterial;
  baseColor: THREE.Color;
  baseEmissive: THREE.Color;
  baseEmissiveIntensity: number;
  baseOpacity: number;
  warm: number;
};

export function createSutroStaticAmbience(regions?: AuthoredRegionStreamer): SutroStaticAmbience {
  const group = new THREE.Group();
  group.name = "sutro_baths_runtime_ambience";
  const lampSpecs: LightAnchorSpec[] = [];
  const unregisterLights: (() => void)[] = [];
  const graded = new Map<THREE.MeshStandardMaterial, GradedMaterial>();
  const glass = new Set<THREE.MeshStandardMaterial>();
  const lamps = new Set<THREE.MeshStandardMaterial>();
  let requestedLampIntensity = 4.6;
  let requestedGlassOpacity = 0.162;
  let lampWarmth = 1;
  let interiorWarmth = 0.9;
  let twilight = 0;

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

  const remember = (material: THREE.MeshStandardMaterial, warm: number): GradedMaterial => {
    let entry = graded.get(material);
    if (!entry) {
      entry = {
        material,
        baseColor: material.color.clone(),
        baseEmissive: material.emissive.clone(),
        baseEmissiveIntensity: material.emissiveIntensity,
        baseOpacity: material.opacity,
        warm
      };
      graded.set(material, entry);
    }
    return entry;
  };

  const collectMaterials = (root: THREE.Object3D) => {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const candidate of materials) {
        if (!(candidate instanceof THREE.MeshStandardMaterial)) continue;
        const name = candidate.name;
        if (GLASS_NAMES.has(name)) {
          remember(candidate, 0);
          glass.add(candidate);
          // Keep the huge roof airy and visually continuous. The shared,
          // correctly typed viewport-depth path in waterShadingTSL now removes
          // the actual refraction corruption without stippling every pane.
          candidate.transparent = true;
          candidate.depthWrite = false;
          candidate.alphaHash = false;
          candidate.opacity = requestedGlassOpacity;
          candidate.needsUpdate = true;
          continue;
        }
        if (name === LAMP_NAME) {
          remember(candidate, 0);
          lamps.add(candidate);
          continue;
        }
        const warm = WARM_TARGETS[name];
        if (warm !== undefined) remember(candidate, warm);
      }
    });
    applyGrade();
  };
  const clearMaterials = () => {
    glass.clear();
    lamps.clear();
    graded.clear();
  };
  const unwatch = regions?.watch("sutro-baths", collectMaterials, clearMaterials) ?? (() => {});

  /**
   * Push the current twilight depth into every captured material. This is only
   * uniform writes — three keeps the emissive term in the graph for any material
   * that owns an emissive Color, so a lamp coming up never recompiles a pipeline.
   */
  function applyGrade() {
    const lampLift = twilight * lampWarmth;
    for (const entry of graded.values()) {
      const material = entry.material;
      if (lamps.has(material)) {
        material.color.copy(entry.baseColor);
        material.emissive.copy(LAMP_EMISSIVE);
        material.emissiveIntensity = entry.baseEmissiveIntensity + lampLift * 2.8;
        continue;
      }
      if (glass.has(material)) {
        // A touch more body at dusk so the panes read as glass catching the
        // last light rather than vanishing into the ironwork.
        material.opacity = Math.min(0.72, requestedGlassOpacity + lampLift * 0.07);
        material.emissive.copy(GLASS_TINT);
        material.emissiveIntensity = lampLift * 0.22;
        continue;
      }
      // Everything else drifts toward lamplight as the room gets darker, with a
      // whisper of self-glow so twilight reads as warm rather than muddy.
      // The hall is enormous and the renderer carries one contextual light, so
      // the surfaces themselves have to carry the lamplight: a warm tint plus a
      // small self-glow keeps twilight golden instead of collapsing to mud.
      const warm = entry.warm * interiorWarmth * twilight;
      material.color.copy(entry.baseColor).lerp(LAMP_TINT, Math.min(0.6, warm * 0.6));
      material.emissive.copy(LAMP_EMISSIVE);
      // Candles do not throw a pool of light the way a globe lamp did, so the
      // surfaces carry a little more of it themselves now that the lamps are
      // gone from the middle of the hall.
      material.emissiveIntensity = warm * 0.37;
    }
  }

  const applyTuning = (values: SutroStaticAmbienceTuning) => {
    requestedLampIntensity = Math.max(0, values.lampIntensity);
    lampWarmth = Math.max(0, values.lampWarmth);
    interiorWarmth = Math.max(0, values.interiorWarmth);
    requestedGlassOpacity = THREE.MathUtils.clamp(values.glassOpacity * 1.35, 0.05, 0.64);
    applyGrade();
  };

  return {
    group,
    applyTuning,
    setTwilight(depth) {
      const next = THREE.MathUtils.clamp(depth, 0, 1);
      if (Math.abs(next - twilight) < 1e-3) return;
      twilight = next;
      applyGrade();
    },
    update(time, values) {
      if (values) applyTuning(values);
      // Off in daylight, blazing once the pocket settles — the single pooled
      // light must not wash out an afternoon the player can still see outside.
      const dim = 0.1 + 0.9 * twilight;
      for (let lightIndex = 0; lightIndex < lampSpecs.length; lightIndex++) {
        const drift = 0.975 + Math.sin(time * 2.1 + lightIndex * 2.71) * 0.025;
        lampSpecs[lightIndex].intensity = requestedLampIntensity * 11 * drift * dim;
      }
    },
    dispose() {
      unwatch();
      for (const entry of graded.values()) {
        entry.material.color.copy(entry.baseColor);
        entry.material.emissive.copy(entry.baseEmissive);
        entry.material.emissiveIntensity = entry.baseEmissiveIntensity;
        entry.material.opacity = entry.baseOpacity;
      }
      for (const unregister of unregisterLights) unregister();
      clearMaterials();
      group.clear();
      group.removeFromParent();
    }
  };
}
