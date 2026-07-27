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
/** Reattach the root even if its compile never settles (see the watchdog note
 *  below). Long enough that a genuinely slow compile still gets its hidden
 *  window; short enough that a parked lane cannot swallow the content. */
const WARM_REATTACH_DEADLINE_MS = 10_000;

export async function warmHiddenRoot(
  renderer: THREE.WebGPURenderer,
  camera: THREE.Camera,
  scene: THREE.Scene,
  root: THREE.Object3D,
  compile: (o: THREE.Object3D, c: THREE.Camera, s: THREE.Scene) => Promise<unknown> = (o, c, s) =>
    renderer.compileAsync(o, c, s)
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
    // Watchdog. This helper's failure mode is silent and total: the root is
    // DETACHED for the duration of the compile, so a compile that never settles
    // removes the content from the world permanently — no error, no missing
    // texture, just absence. That is exactly what happened to the ocean, whose
    // warm sat on the normal compile lane behind an arrival blocker that never
    // cleared at heavy destinations (the four sheets stayed parentless and the
    // "sea" you saw was the bare terrain seabed).
    //
    // Callers on the priority lane cannot park, but nothing stops a future
    // caller from using the default lane, so reattach unconditionally after a
    // deadline and let the compile finish in the background. Reattaching early
    // only risks the synchronous first-draw stall this helper exists to avoid —
    // strictly better than losing the geometry.
    await Promise.race([
      compile(root, camera, scene),
      new Promise((resolve) => setTimeout(resolve, WARM_REATTACH_DEADLINE_MS))
    ]);
  } finally {
    for (const entry of state) {
      entry.object.visible = entry.visible;
      entry.object.frustumCulled = entry.frustumCulled;
    }
    parent?.add(root);
  }
}
