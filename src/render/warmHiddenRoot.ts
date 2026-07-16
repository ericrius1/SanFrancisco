import type * as THREE from "three/webgpu";

/**
 * Warm every pipeline a hidden, distance-gated feature needs BEFORE its first
 * visible flip. WebGPU creates render pipelines synchronously on first draw,
 * so a proximity gate that flips `visible = true` on an uncompiled subtree
 * stalls that frame for the whole compile (measured ~70–110ms for the busker
 * trio mid-flyover; large sites are worse). This compiles the subtree
 * detached with all visibility forced on (compileAsync skips hidden roots),
 * then restores flags and reattaches — the pipeline cache keeps the result,
 * so the later flip renders without any synchronous compile.
 *
 * Contract for distance-gated exhibits/shows:
 *   - trigger this at a PRIME radius comfortably outside the show radius
 *     (fast flyovers must finish warming before they cross the show gate);
 *   - keep the subtree hidden until the returned promise resolves;
 *   - the subtree must contain NO scene lights — lights belong to the shared
 *     pool (player/lightPool.ts registerAmbientLightAnchor), because a light
 *     entering the visible set invalidates every lit pipeline scene-wide.
 */
export async function warmHiddenRoot(
  renderer: THREE.WebGPURenderer,
  camera: THREE.Camera,
  scene: THREE.Scene,
  root: THREE.Object3D
): Promise<void> {
  const parent = root.parent;
  const state: { object: THREE.Object3D; visible: boolean; frustumCulled: boolean }[] = [];
  root.removeFromParent();
  root.traverse((object) => {
    state.push({ object, visible: object.visible, frustumCulled: object.frustumCulled });
    object.visible = true;
    object.frustumCulled = false;
  });
  root.updateMatrixWorld(true);
  try {
    await renderer.compileAsync(root, camera, scene);
  } finally {
    for (const entry of state) {
      entry.object.visible = entry.visible;
      entry.object.frustumCulled = entry.frustumCulled;
    }
    parent?.add(root);
  }
}
