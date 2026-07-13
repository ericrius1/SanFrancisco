import type * as THREE from "three/webgpu";

// Tiny dependency-injection boundary shared by lazy GPU features. Keeping the
// renderer reference here lets optional systems initialize renderer-dependent
// loaders after WebGPU feature detection without importing those systems into
// the clean-boot bundle.
let renderer: THREE.WebGPURenderer | null = null;

export function registerRenderer(value: THREE.WebGPURenderer): void {
  renderer = value;
}

export function requireRenderer(): THREE.WebGPURenderer {
  if (!renderer) throw new Error("The GPU renderer has not finished initializing");
  return renderer;
}

/**
 * Release a shared vertex/index attribute that is not owned by a renderable
 * BufferGeometry at eviction time. Three r185 keeps these GPU buffers in its
 * private attribute registry, so a plain geometry.dispose() cannot reach them.
 */
export function releaseRendererAttribute(attribute: unknown): void {
  if (!renderer) return;
  const internals = renderer as unknown as {
    _attributes?: { delete(value: unknown): unknown };
  };
  internals._attributes?.delete(attribute);
}
