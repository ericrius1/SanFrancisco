// Chase cameras orbit the player, so a 180° look-around swings camera.position
// by twice the boom (~13 m on foot, ~110 m for a zoomed-out speeding bird)
// without revealing any terrain the tree streaming distances don't already
// cover. Feeding that swing to a NativeTreeForest re-centres its LOD/near
// rings every turn, which storms instance re-uploads, near-detail rebins, and
// pipeline compiles — a multi-hundred-ms hitch class on slower GPUs (M1/M2
// laptops). Tether the tree focus to the player while the camera stays within
// any chase boom (worst is bird back 15 × zoom 2.6 × speed-stretch 1.38 ≈
// 54 m); beyond it (flyover, cinematic rails) the focus trails the camera
// continuously so detached shots still stream trees.
//
// Deliberately dependency-free: frameBody imports this from the boot chunk
// while the vegetation runtimes stay behind their dynamic imports.
const TREE_CULL_TETHER = 56;

/**
 * Yaw-stable tree streaming focus: exactly `ringFocus` (the player) while the
 * camera sits inside the chase tether, a point trailing the camera by the
 * tether once it truly departs. Continuous at the boundary. Use for every
 * NativeTreeForest driven per-frame from the chase camera.
 */
export function tetherTreeCullFocus(
  ringFocus: { x: number; z: number },
  cullFocus: { x: number; z: number }
): { x: number; z: number } {
  const dx = cullFocus.x - ringFocus.x;
  const dz = cullFocus.z - ringFocus.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= TREE_CULL_TETHER) return ringFocus;
  const pull = (distance - TREE_CULL_TETHER) / distance;
  return { x: ringFocus.x + dx * pull, z: ringFocus.z + dz * pull };
}
