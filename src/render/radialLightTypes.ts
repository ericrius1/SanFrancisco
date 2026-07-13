import type * as THREE from "three/webgpu";

/** A lazily owned set of bright world-space surfaces that can seed light shafts. */
export interface RadialLightSource {
  readonly scene: THREE.Scene;
  readonly center: THREE.Vector2;
  update(camera: THREE.Camera): void;
}

/** Live uniforms/quality for the optional radial-light render graph. */
export interface RadialLightParams {
  intensity: number;
  weight: number;
  decay: number;
  sampleCount: number;
  exposure: number;
  resolutionScale: number;
}
