import type { TreeCullFocus } from "../vegetation/treeCullFocus";

/** A stationary XZ camera can still cross the close-detail boundary vertically. */
export function nativeTreeNearFocusMovementSquared(a: TreeCullFocus, b: TreeCullFocus): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  const dy = a.y !== undefined && b.y !== undefined ? a.y - b.y : a.y === b.y ? 0 : Infinity;
  return dx * dx + dy * dy + dz * dz;
}

/** Keep the authored horizontal radii at walking height. Above/below a tree,
 * add distance to its actual vertical extent, rather than to the ground anchor
 * (which would demote a camera beside the crown of a tall redwood). */
export function nativeTreeNearDistanceSquared(
  focus: TreeCullFocus,
  tree: { x: number; y: number; z: number; scale: number },
  bounds: { min: readonly number[]; max: readonly number[] } | undefined,
): number {
  const dx = tree.x - focus.x, dz = tree.z - focus.z;
  if (focus.y === undefined || !Number.isFinite(focus.y) || !bounds) return dx * dx + dz * dz;
  const low = tree.y + bounds.min[1] * tree.scale;
  const high = tree.y + bounds.max[1] * tree.scale;
  const dy = Math.max(low - focus.y, 0, focus.y - high);
  return dx * dx + dy * dy + dz * dz;
}
