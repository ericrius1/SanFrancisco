import type * as THREE from "three/webgpu";

/** Hard shader/CPU budget for the close surface-lighting complement. */
export const MAX_PROJECTED_SURFACE_LIGHTS = 16;

/**
 * Allocation-free bridge between a world light system and the lazy render pass.
 * `normalAndWeight.w` is the close-range crossfade weight (0..1).
 */
export interface ProjectedSurfaceLightSource {
  readonly active: boolean;
  readonly count: number;
  readonly intensity: number;
  copyLight(
    index: number,
    positionAndRadius: THREE.Vector4,
    normalAndWeight: THREE.Vector4
  ): void;
  /** Keeps the cheap geometry fallback visible until the render graph is ready. */
  setProjectionReady(ready: boolean): void;
}
