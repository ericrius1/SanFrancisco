import * as THREE from "three/webgpu";
import { wristTargetForGrip } from "./held";
import { setHandTarget } from "./handIK";
import { HAND_GRIP, setHandPose, type Rig } from "./rig";
import type { GardenRakeMotion, GardenRakeTool } from "./gardenRake";

const DEFAULT_ELEVATION = THREE.MathUtils.degToRad(55);
const CARRY_ELEVATION = THREE.MathUtils.degToRad(78);
const DEFAULT_BODY_LEAN = 0.34;

// Remote avatars are updated serially, so one allocation-free pose scratch can
// serve every visible rake without retaining any per-frame vectors per player.
const S = {
  localAcross: new THREE.Vector3(),
  localShaft: new THREE.Vector3(),
  localBinormal: new THREE.Vector3(),
  pull: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  across: new THREE.Vector3(),
  shaft: new THREE.Vector3(),
  binormal: new THREE.Vector3(),
  contact: new THREE.Vector3(),
  rootPosition: new THREE.Vector3(),
  offset: new THREE.Vector3(),
  gripPosition: new THREE.Vector3(),
  gripAim: new THREE.Quaternion(),
  wristTarget: new THREE.Vector3(),
  elbowPole: new THREE.Vector3(),
  worldQuaternion: new THREE.Quaternion(),
  localBasis: new THREE.Matrix4(),
  localBasisInverse: new THREE.Matrix4(),
  worldBasis: new THREE.Matrix4(),
  rotationMatrix: new THREE.Matrix4(),
  desiredWorld: new THREE.Matrix4(),
  parentInverse: new THREE.Matrix4(),
  localMatrix: new THREE.Matrix4(),
  rootInverse: new THREE.Matrix4(),
  unitScale: new THREE.Vector3(1, 1, 1),
  forwardLocal: new THREE.Vector3(0, 0, -1)
};

function disposeTool(tool: GardenRakeTool): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  tool.root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) materials.add(material);
  });
  tool.root.removeFromParent();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

/**
 * Tool-first rake pose for one remote avatar. The server sends the same exact
 * tine contact used by the shared sand stamp; this controller places the rake
 * there and solves both hands onto its authored grip anchors.
 */
export class GardenRakePoseController {
  readonly tool: GardenRakeTool;

  #parent: THREE.Group;
  #contactLocal = new THREE.Vector3();
  #rightGripLocal = new THREE.Vector3();
  #localAcross = new THREE.Vector3(1, 0, 0);
  #localShaft = new THREE.Vector3(0, 1.52, -0.5).normalize();
  #lastPull = new THREE.Vector3(0, 0, -1);

  constructor(tool: GardenRakeTool, parent: THREE.Group) {
    this.tool = tool;
    this.#parent = parent;

    tool.root.updateWorldMatrix(true, true);
    S.rootInverse.copy(tool.root.matrixWorld).invert();
    tool.contact.getWorldPosition(this.#contactLocal).applyMatrix4(S.rootInverse);
    tool.rightGrip.getWorldPosition(this.#rightGripLocal).applyMatrix4(S.rootInverse);

    const across = tool.localAcross ?? [1, 0, 0];
    const shaft = tool.localShaft ?? [0, 1.52, -0.5];
    this.#localAcross.set(across[0], across[1], across[2]);
    if (this.#localAcross.lengthSq() < 1e-6) this.#localAcross.set(1, 0, 0);
    this.#localAcross.normalize();
    this.#localShaft.set(shaft[0], shaft[1], shaft[2]);
    this.#localShaft.addScaledVector(
      this.#localAcross,
      -this.#localShaft.dot(this.#localAcross)
    );
    if (this.#localShaft.lengthSq() < 1e-6) this.#localShaft.set(0, 1, 0);
    this.#localShaft.normalize();

    tool.root.removeFromParent();
    tool.root.matrixAutoUpdate = true;
    tool.root.scale.setScalar(1);
    tool.root.visible = false;
    parent.add(tool.root);
  }

  #worldFrame(elevation: number): void {
    S.normal.normalize();
    S.pull.addScaledVector(S.normal, -S.pull.dot(S.normal));
    if (S.pull.lengthSq() < 1e-6) {
      S.pull.copy(this.#lastPull);
      S.pull.addScaledVector(S.normal, -S.pull.dot(S.normal));
    }
    if (S.pull.lengthSq() < 1e-6) S.pull.set(0, 0, -1);
    S.pull.normalize();
    this.#lastPull.copy(S.pull);

    S.localAcross.copy(this.#localAcross);
    S.localShaft.copy(this.#localShaft);
    S.localBinormal.crossVectors(S.localAcross, S.localShaft).normalize();
    S.localShaft.crossVectors(S.localBinormal, S.localAcross).normalize();

    S.across.crossVectors(S.normal, S.pull).normalize();
    const angle = THREE.MathUtils.clamp(
      elevation,
      THREE.MathUtils.degToRad(25),
      THREE.MathUtils.degToRad(84)
    );
    S.shaft
      .copy(S.pull)
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(S.normal, Math.sin(angle))
      .normalize();
    S.binormal.crossVectors(S.across, S.shaft).normalize();
    S.shaft.crossVectors(S.binormal, S.across).normalize();

    S.localBasis.makeBasis(S.localAcross, S.localShaft, S.localBinormal);
    S.localBasisInverse.copy(S.localBasis).invert();
    S.worldBasis.makeBasis(S.across, S.shaft, S.binormal);
    S.rotationMatrix.multiplyMatrices(S.worldBasis, S.localBasisInverse);
    S.worldQuaternion.setFromRotationMatrix(S.rotationMatrix);
  }

  #placeRoot(localAnchor: THREE.Vector3, worldTarget: THREE.Vector3): void {
    S.offset.copy(localAnchor).applyQuaternion(S.worldQuaternion);
    S.rootPosition.copy(worldTarget).sub(S.offset);
    S.desiredWorld.compose(S.rootPosition, S.worldQuaternion, S.unitScale);
    this.#parent.updateWorldMatrix(true, false);
    S.parentInverse.copy(this.#parent.matrixWorld).invert();
    S.localMatrix.multiplyMatrices(S.parentInverse, S.desiredWorld);
    S.localMatrix.decompose(this.tool.root.position, this.tool.root.quaternion, this.tool.root.scale);
    this.tool.root.updateMatrix();
    this.tool.root.updateWorldMatrix(false, true);
  }

  #targetHand(rig: Rig, side: "L" | "R", anchor: THREE.Object3D): void {
    anchor.getWorldPosition(S.gripPosition);
    anchor.getWorldQuaternion(S.gripAim);
    wristTargetForGrip(rig, side, S.gripPosition, S.gripAim, S.wristTarget);
    S.elbowPole.set(side === "R" ? -0.62 : 0.62, 0.2, -0.48);
    rig.torso.localToWorld(S.elbowPole);
    setHandTarget(rig, side, {
      pos: S.wristTarget,
      aim: S.gripAim,
      pole: S.elbowPole,
      hand: HAND_GRIP,
      reach: 0.99
    });
  }

  pose(
    rig: Rig,
    avatarPosition: THREE.Vector3,
    avatarQuaternion: THREE.Quaternion,
    motion: Readonly<GardenRakeMotion>,
    strideT: number
  ): void {
    this.tool.root.visible = true;
    if (motion.engaged) {
      S.normal.set(motion.normalX, motion.normalY, motion.normalZ);
      if (S.normal.lengthSq() < 1e-6) S.normal.set(0, 1, 0);
      S.pull.set(motion.pullX, 0, motion.pullZ);
      this.#worldFrame(motion.shaftElevation ?? DEFAULT_ELEVATION);
      S.contact.set(motion.contactX, motion.contactY, motion.contactZ);
      this.#placeRoot(this.#contactLocal, S.contact);

      const lean = THREE.MathUtils.clamp(motion.bodyLean ?? DEFAULT_BODY_LEAN, 0, 0.55);
      rig.torso.rotation.x -= lean;
      rig.hips.rotation.x -= lean * 0.28;
      rig.head.rotation.x += lean * 0.62;
      if (motion.dragging) {
        const workTwist = Math.sin(strideT) * 0.04;
        rig.torso.rotation.y += workTwist;
        rig.hips.rotation.y -= workTwist * 0.45;
      }
      rig.hips.position.y -= 0.075;
      rig.hips.position.z = 0.045;
      rig.legL.rotation.x += 0.08;
      rig.legR.rotation.x += 0.08;
      rig.shinL.rotation.x -= 0.18;
      rig.shinR.rotation.x -= 0.18;
      rig.group.updateWorldMatrix(true, true);
      this.tool.root.updateWorldMatrix(true, true);
      this.#targetHand(rig, "R", this.tool.rightGrip);
      this.#targetHand(rig, "L", this.tool.leftGrip);
      return;
    }

    rig.hips.position.z = 0;
    setHandPose(rig, "L", 0);
    S.normal.set(0, 1, 0);
    S.pull.copy(S.forwardLocal).applyQuaternion(avatarQuaternion).setY(0);
    if (S.pull.lengthSq() < 1e-6) S.pull.copy(this.#lastPull).setY(0);
    S.pull.normalize();
    this.#worldFrame(CARRY_ELEVATION);
    S.gripPosition
      .copy(avatarPosition)
      .addScaledVector(S.across, 0.34)
      .addScaledVector(S.normal, 0.65)
      .addScaledVector(S.pull, 0.03);
    this.#placeRoot(this.#rightGripLocal, S.gripPosition);
    rig.group.updateWorldMatrix(true, true);
    this.tool.root.updateWorldMatrix(true, true);
    this.#targetHand(rig, "R", this.tool.rightGrip);
  }

  hide(rig?: Rig | null): void {
    this.tool.root.visible = false;
    if (!rig) return;
    rig.hips.position.z = 0;
    rig.handL.rotation.set(0, 0, 0);
    rig.handR.rotation.set(0, 0, 0);
    setHandPose(rig, "L", 0);
    setHandPose(rig, "R", 0);
  }

  dispose(): void {
    disposeTool(this.tool);
  }
}
