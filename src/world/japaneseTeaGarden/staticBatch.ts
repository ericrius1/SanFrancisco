import type * as THREE from "three/webgpu";
import { batchStaticSiblings } from "../staticBatch";

export type TeaStaticBatchStats = Readonly<{
  sourceMeshes: number;
  batchMeshes: number;
  removedMeshes: number;
}>;

/**
 * Collapse sibling-only static Tea Garden meshes by material/render state.
 *
 * The pass deliberately retains the authored group tree. Physics, light
 * anchors, landmark names, animated koi, instanced bridge pieces, and Hiro's
 * rig remain independent objects; only inert leaf meshes inside a shared
 * parent are merged in that parent's local space. Meshes flagged with
 * `userData.keepTeaGardenMesh` (and their subtree) are exempt.
 *
 * This is the shared {@link batchStaticSiblings} pass with the Tea Garden's
 * original keep-flag, batch names, and two-pass (sibling + landmark) behaviour.
 */
export function batchTeaGardenStatics(root: THREE.Object3D): TeaStaticBatchStats {
  const { sourceMeshes, batchMeshes, removedMeshes } = batchStaticSiblings(root, {
    keepKey: "keepTeaGardenMesh",
    siblingFallbackName: "tea_static",
    landmarkFallbackName: "tea_landmark",
    landmarkPass: true
  });
  return { sourceMeshes, batchMeshes, removedMeshes };
}
