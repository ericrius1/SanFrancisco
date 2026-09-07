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
export type TreeCullFocus = { x: number; y?: number; z: number };

export function copyTreeCullFocus(focus: TreeCullFocus): TreeCullFocus {
  return { x: focus.x, z: focus.z, ...(Number.isFinite(focus.y) ? { y: focus.y } : {}) };
}

/**
 * Yaw-stable tree streaming focus: exactly `ringFocus` (the player) while the
 * camera sits inside the chase tether, a point trailing the camera by the
 * tether once it truly departs. Continuous at the boundary. Use for every
 * NativeTreeForest driven per-frame from the chase camera.
 */
export function tetherTreeCullFocus(
  ringFocus: TreeCullFocus,
  cullFocus: TreeCullFocus
): TreeCullFocus {
  const dx = cullFocus.x - ringFocus.x;
  const dz = cullFocus.z - ringFocus.z;
  const ringY = Number.isFinite(ringFocus.y) ? ringFocus.y : undefined;
  const cameraY = Number.isFinite(cullFocus.y) ? cullFocus.y : undefined;
  const dy = ringY !== undefined && cameraY !== undefined ? cameraY - ringY : 0;
  const distance = Math.hypot(dx, dy, dz);
  if (distance <= TREE_CULL_TETHER) {
    return ringY === undefined && cameraY !== undefined ? { ...ringFocus, y: cameraY } : ringFocus;
  }
  const pull = (distance - TREE_CULL_TETHER) / distance;
  const y = ringY !== undefined && cameraY !== undefined ? ringY + dy * pull : ringY ?? cameraY;
  return { x: ringFocus.x + dx * pull, z: ringFocus.z + dz * pull, ...(y !== undefined ? { y } : {}) };
}
