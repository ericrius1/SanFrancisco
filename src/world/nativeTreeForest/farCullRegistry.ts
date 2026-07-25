// Per-frame dispatch registry for NativeTreeForest GPU far tiers.
//
// Deliberately dependency-light (THREE types + the renderer accessor only) so the
// frame loop can drive every forest's far cull from ONE site without statically
// pulling the tree material / arena graph into the frame-body chunk. Each forest
// that owns far tiers self-registers a dispatch closure on build (gpuFarTiers.ts)
// and drops it on dispose; frameBody calls renderNativeTreeForestFarCulls(camera)
// exactly once per frame inside the master-foliage gate, so all forest consumers
// get GPU far culling automatically without threading a camera through their
// individual update() paths — the same "one site, once per frame" cadence grass
// drives its cull from.

import type * as THREE from "three/webgpu";
import { requireRenderer } from "../../app/rendererRegistry";

type ForestFarCullDriver = (renderer: THREE.WebGPURenderer, camera: THREE.Camera) => void;

const drivers = new Set<ForestFarCullDriver>();

/** Register a forest's per-frame far cull; returns an unregister function. */
export function registerForestFarCull(driver: ForestFarCullDriver): () => void {
  drivers.add(driver);
  return () => {
    drivers.delete(driver);
  };
}

/** Dispatch every registered forest's far cull against the render camera. Cheap
 *  no-op when no forest with far tiers is resident. */
export function renderNativeTreeForestFarCulls(camera: THREE.Camera): void {
  if (drivers.size === 0) return;
  const renderer = requireRenderer();
  for (const driver of drivers) driver(renderer, camera);
}
