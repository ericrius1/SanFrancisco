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
  /** Fraction of drawing-buffer resolution used by the lazy projection pass. */
  readonly resolutionScale: number;
  /** Shared multiplier and curve keep the close pass matched to its fallback. */
  readonly strength: number;
  readonly falloffPower: number;
  /** Vertical rejection distance; keeps the ground light off roofs above it. */
  readonly heightReach: number;
  copyLight(
    index: number,
    positionAndRadius: THREE.Vector4,
    normalAndWeight: THREE.Vector4
  ): void;
  /** Updates camera-relative activation/crossfade without allocating light data. */
  setViewPosition(position: THREE.Vector3): void;
  /** Keeps the cheap geometry fallback visible until the render graph is ready. */
  setProjectionReady(ready: boolean): void;
}
