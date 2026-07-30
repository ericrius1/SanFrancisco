import * as THREE from "three/webgpu";
import {
  cameraPosition,
  clamp,
  color,
  log2,
  mix,
  positionWorld,
  smoothstep,
  uniform
} from "three/tsl";
import type { ScenePass } from "./compileGate";

export type WireframeOverride = {
  readonly active: boolean;
  /** Swap the scene pass to/from the retained override + camera. */
  setWireframe(on: boolean): void;
  /** Blend the override from neutral grey to its logarithmic LOD ramp. */
  setLodGradient(on: boolean): void;
  /** Copy the live camera onto the retained clone. The frame driver calls this
   *  AFTER the TAA jitter offset is applied, so wireframe mode carries the
   *  jitter while keeping its own camera identity. */
  syncCamera(): void;
  /** Force a specific mode without touching `active` — warmup visits both. */
  applyOverride(on: boolean): void;
  dispose(): void;
};

/**
 * Wireframe debug: PassNode.overrideMaterial + a retained camera clone.
 * BundleGroups (tiles, citygen, traffic lights) key their WebGPU command
 * caches by camera identity. Mutating scene.overrideMaterial on the live
 * camera re-records those bundles as line lists and leaves them stuck after
 * the toggle clears. A separate camera keeps normal and wireframe caches
 * side by side so off restores solid materials instantly.
 */
export function createWireframeOverride(deps: {
  scenePass: ScenePass;
  camera: THREE.Camera;
}): WireframeOverride {
  const { scenePass, camera } = deps;

  const wireframeLodGradient = uniform(1);
  const wireframeMaterial = new THREE.MeshBasicNodeMaterial();
  wireframeMaterial.name = "debug-wireframe-override";
  wireframeMaterial.color.set(0xcccccc);
  // Clipmap spacing doubles at roughly 64/128/256/512/1024/2048/4096 m.
  // Mapping log2(distance / 64) onto 0..1 therefore turns those geometric LOD
  // bands into an unbroken perceptual ramp. The override is scene-wide, so the
  // same resolution story remains visible across terrain and buildings.
  const wireframeDistance = positionWorld.distance(cameraPosition).max(64);
  const wireframeLod = clamp(log2(wireframeDistance.div(64)).div(6), 0, 1);
  const nearColor = color(0x69f5c6);
  const middleColor = color(0x59a7ff);
  const coarseColor = color(0x8c72e8);
  const farColor = color(0xff789e);
  const nearRamp = mix(nearColor, middleColor, smoothstep(0, 0.46, wireframeLod));
  const farRamp = mix(coarseColor, farColor, smoothstep(0.52, 1, wireframeLod));
  const resolutionRamp = mix(nearRamp, farRamp, smoothstep(0.34, 0.7, wireframeLod));
  wireframeMaterial.colorNode = mix(color(0xcccccc), resolutionRamp, wireframeLodGradient);
  wireframeMaterial.wireframe = true;
  wireframeMaterial.toneMapped = false;
  const wireframeCamera = camera.clone();
  const syncWireframeCamera = () => wireframeCamera.copy(camera, false);
  let wireframeActive = false;
  const applyWireframeOverride = (on: boolean) => {
    scenePass.overrideMaterial = on ? wireframeMaterial : null;
    scenePass.camera = on ? wireframeCamera : camera;
  };

  return {
    get active() {
      return wireframeActive;
    },
    setWireframe(on: boolean) {
      if (wireframeActive === on) return;
      wireframeActive = on;
      if (on) syncWireframeCamera();
      applyWireframeOverride(on);
    },
    setLodGradient(on: boolean) {
      wireframeLodGradient.value = on ? 1 : 0;
    },
    syncCamera: syncWireframeCamera,
    applyOverride: applyWireframeOverride,
    dispose() {
      applyWireframeOverride(false);
      wireframeMaterial.dispose();
    }
  };
}
