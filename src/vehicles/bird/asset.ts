import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { applyVehicleShadowPolicy } from "../shadows";
import { attachKtx2Loader } from "../../render/textures";
import type { BirdRig, BoneCtl } from "./mesh";
import { applyPhoenixPlumage } from "./plumage";
import { installPhoenixSaddle } from "./saddle";

const PHOENIX_SCALE = 1.26;
const PHOENIX_URL = "/models/phoenix-hero.glb";
const LEFT = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(1, 0, 0);

function disposeUnclaimedScene(scene: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if ((value as THREE.Texture | undefined)?.isTexture) textures.add(value as THREE.Texture);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

export async function loadBirdAssets(root: THREE.Group): Promise<void> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  // Inert for the current JPEG phoenix; wires KTX2 (KHR_texture_basisu) so the
  // hero GLB can be converted with tools/optimize-glb-textures.mjs later.
  await attachKtx2Loader(loader);

  return new Promise<void>((resolve, reject) => {
    loader.load(
      PHOENIX_URL,
      (gltf) => {
        try {
          const scene = gltf.scene;
          if (root.userData.disposed) {
            disposeUnclaimedScene(scene);
            resolve();
            return;
          }
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
            applyPhoenixPlumage(mesh);
          });
          applyVehicleShadowPolicy(scene, shadowCasters);

          // Capture semantic rig axes before the wrapper yaw. This hero faces
          // +X, with its left wing along -Z; the controller can continue to
          // think in lateral/up/forward rotations regardless of bone roll.
          const control = (bone: THREE.Bone | undefined, name: string): BoneCtl => {
            if (!bone?.parent) throw new Error(`phoenix rig is missing ${name}`);
            const inverseParent = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
            return {
              bone,
              rest: bone.quaternion.clone(),
              axX: LEFT.clone().applyQuaternion(inverseParent),
              axY: UP.clone().applyQuaternion(inverseParent),
              axZ: FORWARD.clone().applyQuaternion(inverseParent)
            };
          };
          const rig: BirdRig = {
            wingL: control(bones.wing_arm_L, "wing_arm_L"),
            wingR: control(bones.wing_arm_R, "wing_arm_R"),
            elbowL: control(bones.wing_forearm_L, "wing_forearm_L"),
            elbowR: control(bones.wing_forearm_R, "wing_forearm_R"),
            handL: control(bones.wing_hand_L, "wing_hand_L"),
            handR: control(bones.wing_hand_R, "wing_hand_R"),
            spine: control(bones.spine01, "spine01"),
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

          const attachment = (name: string) => {
            const object = scene.getObjectByName(name);
            if (!object) throw new Error(`phoenix handoff is missing ${name}`);
            return object;
          };
          root.userData.trailPoints = [attachment("PHX_Gen_Trail_L"), attachment("PHX_Gen_Trail_R")];
          root.userData.fireCore = attachment("PHX_Gen_Fire_Core");
          root.userData.wingTips = [attachment("PHX_Gen_Wingtip_L"), attachment("PHX_Gen_Wingtip_R")];
          root.userData.phoenixAsset = { url: PHOENIX_URL, lod: 0, featherMode: "tsl-vertex" };

          // Asset +X becomes the game's local -Z forward convention.
          scene.rotation.y = Math.PI * 0.5;
          scene.scale.setScalar(PHOENIX_SCALE);
          root.add(scene);
          installPhoenixSaddle(root);
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
