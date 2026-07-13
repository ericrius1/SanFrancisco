import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { LIGHT_SCALE } from "../../config";
import { applyVehicleShadowPolicy } from "../shadows";
import { dressPhoenix } from "./feathers";
import type { BirdRig, BoneCtl } from "./mesh";

const PHOENIX_SCALE = 1.26; // 3× the original 0.42 — a proper mount, not a lap pet

export function loadBirdAssets(root: THREE.Group): Promise<void> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  return new Promise<void>((resolve, reject) => {
    loader.load(
      "/models/phoenix.glb",
      (gltf) => {
        try {
          const scene = gltf.scene;
          scene.updateMatrixWorld(true);

          const bones: Record<string, THREE.Bone> = {};
          const shadowCasters: THREE.Mesh[] = [];
          scene.traverse((object) => {
            if ((object as THREE.Bone).isBone) bones[object.name] = object as THREE.Bone;
            if (!(object as THREE.Mesh).isMesh) return;
            const mesh = object as THREE.Mesh;
            // The embodiment root is the sole visibility owner. Children stay
            // renderable if the asset resolves while another mode is active.
            mesh.visible = true;
            mesh.frustumCulled = false;
            shadowCasters.push(mesh);
            const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
            for (const material of materials) {
              if (!material.emissive || material.emissive.getHex() === 0) continue;
              material.emissiveIntensity *= material.name === "MatEye" ? LIGHT_SCALE : LIGHT_SCALE * 0.25;
            }
          });
          applyVehicleShadowPolicy(scene, shadowCasters);

          // Capture rig-space axes before the wrapper flip so controller poses
          // remain in the source rig's +Z-beak/+X-left-wing convention.
          const control = (bone: THREE.Bone | undefined, name: string): BoneCtl => {
            if (!bone?.parent) throw new Error(`phoenix rig is missing ${name}`);
            const inverseParent = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
            return {
              bone,
              rest: bone.quaternion.clone(),
              axX: new THREE.Vector3(1, 0, 0).applyQuaternion(inverseParent),
              axY: new THREE.Vector3(0, 1, 0).applyQuaternion(inverseParent),
              axZ: new THREE.Vector3(0, 0, 1).applyQuaternion(inverseParent)
            };
          };
          const rig: BirdRig = {
            wingL: control(bones.wing_arm_L, "wing_arm_L"),
            wingR: control(bones.wing_arm_R, "wing_arm_R"),
            elbowL: control(bones.wing_forearm_L, "wing_forearm_L"),
            elbowR: control(bones.wing_forearm_R, "wing_forearm_R"),
            handL: control(bones.wing_hand_L, "wing_hand_L"),
            handR: control(bones.wing_hand_R, "wing_hand_R"),
            chest: control(bones.chest, "chest"),
            neck: [
              control(bones.neck01, "neck01"),
              control(bones.neck02, "neck02"),
              control(bones.head, "head")
            ],
            tail: [
              control(bones.tail01, "tail01"),
              control(bones.tail02, "tail02"),
              control(bones.tail03, "tail03"),
              control(bones.tail04, "tail04"),
              control(bones.tail05, "tail05")
            ]
          };

          // Plumage placement uses rest-world quaternions and therefore runs
          // before the wrapper flip/scale.
          root.userData.trailPoints = dressPhoenix(bones, true);
          scene.rotation.y = Math.PI;
          scene.scale.setScalar(PHOENIX_SCALE);
          root.add(scene);
          root.userData.rig = rig;
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      reject
    );
  });
}
