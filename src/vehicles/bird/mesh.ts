import * as THREE from "three/webgpu";

/**
 * Playable phoenix, loaded lazily from /models/phoenix-hero.glb. The hero faces
 * +X and hangs under a quarter-turn wrapper to match the game convention
 * (front is local -Z). The controller poses its purpose-built skeleton from
 * flight state; baked feather masks drive GPU-only secondary plumage motion.
 *
 * Each animated bone is wrapped in a BoneCtl snapshotting its rest quaternion
 * plus the rig-space axes expressed in the bone's parent frame. poseBone then
 * lets the controller think in bird terms ("raise wing" = spin about the body
 * axis) without caring how the skeleton's rest orientations twist; because an
 * axis is fixed in the parent's local frame it follows the parent as it
 * animates, which is exactly how a wing chain should stack.
 */

export type BoneCtl = {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  axX: THREE.Vector3; // rig-space lateral axis (GLB left wing points -Z)
  axY: THREE.Vector3; // rig-space up
  axZ: THREE.Vector3; // rig-space facing (+X toward the beak, pre-wrapper)
};

export type BirdRig = {
  wingL: BoneCtl;
  wingR: BoneCtl;
  elbowL: BoneCtl;
  elbowR: BoneCtl;
  handL: BoneCtl;
  handR: BoneCtl;
  spine: BoneCtl;
  chest: BoneCtl;
  neck: BoneCtl[]; // neck01 → neck02 → head, for distributed look
  tail: BoneCtl[]; // tail01 → tail05, root to tip
};

const Q = new THREE.Quaternion();

/** Rest pose + premultiplied rig-axis rotations (x pitch, y yaw, z roll). */
export function poseBone(c: BoneCtl, x: number, y: number, z: number) {
  c.bone.quaternion.copy(c.rest);
  if (z) c.bone.quaternion.premultiply(Q.setFromAxisAngle(c.axZ, z));
  if (y) c.bone.quaternion.premultiply(Q.setFromAxisAngle(c.axY, y));
  if (x) c.bone.quaternion.premultiply(Q.setFromAxisAngle(c.axX, x));
}

export function buildBirdMesh(): THREE.Group {
  const g = new THREE.Group();
  g.userData.embodimentVisible = false;
  g.visible = false;
  return g;
}

const activations = new WeakMap<THREE.Group, Promise<void>>();

/**
 * First-use gate for the imported phoenix. The lightweight embodiment root is
 * present from boot so controllers/trails retain stable references, while the
 * loader, GPU plumage material and GLB stay in a separate chunk until bird mode is
 * actually selected.
 */
export function activateBirdAssets(root: THREE.Group): Promise<void> {
  if (root.userData.rig) return Promise.resolve();
  const existing = activations.get(root);
  if (existing) return existing;

  const pending = import("./asset")
    .then(({ loadBirdAssets }) => loadBirdAssets(root))
    .catch((error) => {
      activations.delete(root);
      console.warn("[bird] phoenix asset unavailable", error);
    });
  activations.set(root, pending);
  return pending;
}
