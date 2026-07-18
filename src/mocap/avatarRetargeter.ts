import * as THREE from "three/webgpu";
import type { Rig } from "../player/rig";
import { LM, type PoseLandmark } from "./landmarks";

type JointName =
  | "hips"
  | "torso"
  | "head"
  | "armL"
  | "armR"
  | "foreL"
  | "foreR"
  | "legL"
  | "legR"
  | "shinL"
  | "shinR";

type JointTarget = { quaternion: THREE.Quaternion; visible: boolean; blend: number };

const JOINTS: JointName[] = [
  "hips", "torso", "head", "armL", "armR", "foreL", "foreR", "legL", "legR", "shinL", "shinR"
];
const DOWN = new THREE.Vector3(0, -1, 0);

/** Retargets BlazePose world landmarks onto the game's compact procedural rig. */
export class AvatarRetargeter {
  #points = Array.from({ length: 36 }, () => new THREE.Vector3());
  #landmarks: PoseLandmark[] | null = null;
  #fresh = false;
  #targets = Object.fromEntries(
    JOINTS.map((joint) => [joint, { quaternion: new THREE.Quaternion(), visible: false, blend: 0 }])
  ) as Record<JointName, JointTarget>;
  #x = new THREE.Vector3();
  #y = new THREE.Vector3();
  #z = new THREE.Vector3();
  #direction = new THREE.Vector3();
  #matrix = new THREE.Matrix4();
  #inverse = new THREE.Quaternion();
  #hipsWorld = new THREE.Quaternion();
  #chestWorld = new THREE.Quaternion();
  #parentWorld = new THREE.Quaternion();

  update(landmarks: PoseLandmark[], fresh: boolean): void {
    this.#landmarks = landmarks;
    this.#fresh = fresh;
    for (let index = 0; index < this.#points.length; index++) {
      const point = landmarks[index];
      // MediaPipe camera space -> avatar-local space: Y up, avatar front -Z.
      this.#points[index].set(point.x, -point.y, -point.z);
    }
    this.#solveTargets();
  }

  setFresh(fresh: boolean): void {
    this.#fresh = fresh;
  }

  apply(rig: Rig, dt: number): void {
    const response = 1 - Math.exp(-Math.max(0, dt) * 9);
    for (const joint of JOINTS) {
      const target = this.#targets[joint];
      const wanted = this.#fresh && target.visible ? 1 : 0;
      target.blend += (wanted - target.blend) * response;
      if (target.blend > 0.001) rig[joint].quaternion.slerp(target.quaternion, target.blend);
    }
  }

  reset(): void {
    this.#landmarks = null;
    this.#fresh = false;
    for (const target of Object.values(this.#targets)) {
      target.visible = false;
      target.blend = 0;
      target.quaternion.identity();
    }
  }

  #solveTargets(): void {
    const landmarks = this.#landmarks;
    if (!landmarks) return;

    const torsoVisible = this.#visible([
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
      LM.LEFT_SHOULDER,
      LM.RIGHT_SHOULDER
    ], 0.35);
    const hipsValid = torsoVisible && this.#basis(
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
      LM.HIP_CENTER,
      LM.NECK,
      this.#hipsWorld
    );
    this.#set("hips", this.#hipsWorld, hipsValid);

    const chestValid = torsoVisible && this.#basis(
      LM.LEFT_SHOULDER,
      LM.RIGHT_SHOULDER,
      LM.HIP_CENTER,
      LM.NECK,
      this.#chestWorld
    );
    if (hipsValid && chestValid) {
      this.#targets.torso.quaternion
        .copy(this.#inverse.copy(this.#hipsWorld).invert())
        .multiply(this.#chestWorld);
      this.#targets.torso.visible = true;
    } else {
      this.#targets.torso.visible = false;
    }

    const headVisible = chestValid && this.#visible([LM.LEFT_EAR, LM.RIGHT_EAR, LM.NECK], 0.3);
    if (headVisible && this.#basis(LM.LEFT_EAR, LM.RIGHT_EAR, LM.NECK, LM.HEAD_CENTER, this.#parentWorld)) {
      this.#targets.head.quaternion
        .copy(this.#inverse.copy(this.#chestWorld).invert())
        .multiply(this.#parentWorld);
      this.#targets.head.visible = true;
    } else {
      this.#targets.head.visible = false;
    }

    if (chestValid || hipsValid) {
      const armParent = chestValid ? this.#chestWorld : this.#hipsWorld;
      this.#solveChain("armL", "foreL", LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, armParent, 0.35);
      this.#solveChain("armR", "foreR", LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, armParent, 0.35);
    } else {
      this.#hideChain("armL", "foreL");
      this.#hideChain("armR", "foreR");
    }
    if (hipsValid) {
      this.#solveChain("legL", "shinL", LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE, this.#hipsWorld, 0.52);
      this.#solveChain("legR", "shinR", LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE, this.#hipsWorld, 0.52);
    } else {
      this.#hideChain("legL", "shinL");
      this.#hideChain("legR", "shinR");
    }
  }

  #solveChain(
    upper: JointName,
    lower: JointName,
    root: number,
    middle: number,
    end: number,
    parentWorld: THREE.Quaternion,
    visibilityThreshold: number
  ): void {
    const upperVisible = this.#visible([root, middle], visibilityThreshold);
    if (!upperVisible || !this.#directionFrom(root, middle, parentWorld, this.#targets[upper].quaternion, DOWN)) {
      this.#targets[upper].visible = false;
      this.#targets[lower].visible = false;
      return;
    }
    this.#targets[upper].visible = true;

    const lowerVisible = this.#visible([middle, end], visibilityThreshold);
    this.#parentWorld.copy(parentWorld).multiply(this.#targets[upper].quaternion);
    this.#targets[lower].visible =
      lowerVisible && this.#directionFrom(middle, end, this.#parentWorld, this.#targets[lower].quaternion, DOWN);
  }

  #hideChain(upper: JointName, lower: JointName): void {
    this.#targets[upper].visible = false;
    this.#targets[lower].visible = false;
  }

  #directionFrom(
    from: number,
    to: number,
    parentWorld: THREE.Quaternion,
    output: THREE.Quaternion,
    restDirection: THREE.Vector3
  ): boolean {
    this.#direction.copy(this.#points[to]).sub(this.#points[from]);
    if (this.#direction.lengthSq() < 1e-8) return false;
    this.#direction.normalize().applyQuaternion(this.#inverse.copy(parentWorld).invert());
    output.setFromUnitVectors(restDirection, this.#direction);
    return true;
  }

  #basis(left: number, right: number, bottom: number, top: number, output: THREE.Quaternion): boolean {
    this.#x.copy(this.#points[left]).sub(this.#points[right]);
    this.#y.copy(this.#points[top]).sub(this.#points[bottom]);
    if (this.#x.lengthSq() < 1e-8 || this.#y.lengthSq() < 1e-8) return false;
    this.#x.normalize();
    this.#y.normalize();
    this.#z.crossVectors(this.#x, this.#y);
    if (this.#z.lengthSq() < 1e-8) return false;
    this.#z.normalize();
    this.#x.crossVectors(this.#y, this.#z).normalize();
    output.setFromRotationMatrix(this.#matrix.makeBasis(this.#x, this.#y, this.#z));
    return true;
  }

  #visible(indices: number[], threshold: number): boolean {
    const landmarks = this.#landmarks!;
    return indices.every((index) => landmarks[index].visibility >= threshold);
  }

  #set(joint: JointName, quaternion: THREE.Quaternion, visible: boolean): void {
    this.#targets[joint].quaternion.copy(quaternion);
    this.#targets[joint].visible = visible;
  }
}
