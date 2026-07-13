import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { LIGHT_SCALE } from "../../config";
import { dressPhoenix } from "./feathers";
import { applyVehicleShadowPolicy } from "../shadows";

/**
 * Playable phoenix, loaded from /models/phoenix.glb. The GLB faces +Z so the
 * model hangs under a π-yawed wrapper to match the game convention (front is
 * local -Z). Its baked FlyCycle clip is never played — the controller poses
 * the skeleton procedurally from flight state instead.
 *
 * Each animated bone is wrapped in a BoneCtl snapshotting its rest quaternion
 * plus the rig-space axes expressed in the bone's parent frame. poseBone then
 * lets the controller think in bird terms ("raise wing" = spin about the body
 * axis) without caring how the skeleton's rest orientations twist; because an
 * axis is fixed in the parent's local frame it follows the parent as it
 * animates, which is exactly how a wing chain should stack.
 */

const PHOENIX_SCALE = 1.26; // 3× the original 0.42 — a proper mount, not a lap pet

export type BoneCtl = {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  axX: THREE.Vector3; // rig-space right/left axis (GLB left wing points +X)
  axY: THREE.Vector3; // rig-space up
  axZ: THREE.Vector3; // rig-space facing (+Z toward the beak, pre-flip)
};

export type BirdRig = {
  wingL: BoneCtl;
  wingR: BoneCtl;
  elbowL: BoneCtl;
  elbowR: BoneCtl;
  handL: BoneCtl;
  handR: BoneCtl;
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

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load("/models/phoenix.glb", (gltf) => {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    const bones: Record<string, THREE.Bone> = {};
    const shadowCasters: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone;
      if ((o as THREE.Mesh).isMesh) {
        const m = o as THREE.Mesh;
        // The embodiment root is the sole visibility owner. Children stay
        // renderable so a model that resolves while hidden can be shown later
        // without recursively rewriting authored child visibility.
        m.visible = true;
        // skinned bounds don't follow the flap; one mesh, skip culling
        m.frustumCulled = false;
        // The source GLB is one skinned mesh (four material groups), making it
        // the cheapest coherent animated caster for body, wings, and tail.
        shadowCasters.push(m);
        const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
        for (const mat of mats) {
          if (!mat.emissive || mat.emissive.getHex() === 0) continue;
          // scene exposure expects LIGHT_SCALE-boosted emissives; the eyes can
          // burn but full-bright plumage would read as a flying torch
          mat.emissiveIntensity *= mat.name === "MatEye" ? LIGHT_SCALE : LIGHT_SCALE * 0.25;
        }
      }
    });
    applyVehicleShadowPolicy(scene, shadowCasters);

    // capture rig-space axes before the wrapper flip so the controller's
    // frame stays the GLB's own (+Z beak, +X left wing)
    const ctl = (bone: THREE.Bone): BoneCtl => {
      const inv = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
      return {
        bone,
        rest: bone.quaternion.clone(),
        axX: new THREE.Vector3(1, 0, 0).applyQuaternion(inv),
        axY: new THREE.Vector3(0, 1, 0).applyQuaternion(inv),
        axZ: new THREE.Vector3(0, 0, 1).applyQuaternion(inv)
      };
    };
    const rig: BirdRig = {
      wingL: ctl(bones.wing_arm_L),
      wingR: ctl(bones.wing_arm_R),
      elbowL: ctl(bones.wing_forearm_L),
      elbowR: ctl(bones.wing_forearm_R),
      handL: ctl(bones.wing_hand_L),
      handR: ctl(bones.wing_hand_R),
      chest: ctl(bones.chest),
      neck: [ctl(bones.neck01), ctl(bones.neck02), ctl(bones.head)],
      tail: [ctl(bones.tail01), ctl(bones.tail02), ctl(bones.tail03), ctl(bones.tail04), ctl(bones.tail05)]
    };

    // plumage placement converts rig-space directions through rest world
    // quaternions, so it must run before the wrapper flip/scale below
    g.userData.trailPoints = dressPhoenix(bones, true);

    scene.rotation.y = Math.PI;
    scene.scale.setScalar(PHOENIX_SCALE);
    g.add(scene);
    g.userData.rig = rig;
  });

  return g;
}
