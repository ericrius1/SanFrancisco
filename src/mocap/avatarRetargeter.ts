import * as THREE from "three/webgpu";
import type { Rig } from "../player/rig";
import { LM, type PoseLandmark } from "./landmarks";

type JointName =
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

type JointTarget = {
  quaternion: THREE.Quaternion;
  smoothed: THREE.Quaternion;
  hasPose: boolean;
  visible: boolean;
  blend: number;
};

const JOINTS: JointName[] = [
  "torso", "head", "armL", "armR", "foreL", "foreR", "legL", "legR", "shinL", "shinR"
];
const DOWN = new THREE.Vector3(0, -1, 0);

/** Retargets BlazePose world landmarks onto the game's compact procedural rig. */
export class AvatarRetargeter {
  #points = Array.from({ length: 36 }, () => new THREE.Vector3());
  #landmarks: PoseLandmark[] | null = null;
  #fresh = false;
  #targets = Object.fromEntries(
    JOINTS.map((joint) => [
      joint,
      { quaternion: new THREE.Quaternion(), smoothed: new THREE.Quaternion(), hasPose: false, visible: false, blend: 0 }
    ])
  ) as Record<JointName, JointTarget>;
  #x = new THREE.Vector3();
  #y = new THREE.Vector3();
  #z = new THREE.Vector3();
  #direction = new THREE.Vector3();
  #upperDir = new THREE.Vector3();
  #lowerDir = new THREE.Vector3();
  #matrix = new THREE.Matrix4();
  #inverse = new THREE.Quaternion();
  #hipsWorld = new THREE.Quaternion();
  #chestWorld = new THREE.Quaternion();
  #parentWorld = new THREE.Quaternion();
  #hipsSeen = false;
  #chestSeen = false;

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
    // Targets step at webcam rate (~30 Hz); this trailing slerp hides the
    // stairstepping without under-shooting the pose the way a partial
    // base->target slerp would.
    const track = 1 - Math.exp(-Math.max(0, dt) * 24);
    for (const joint of JOINTS) {
      const target = this.#targets[joint];
      const wanted = this.#fresh && target.visible ? 1 : 0;
      target.blend += (wanted - target.blend) * response;
      if (target.blend > 0.001) {
        if (target.hasPose) target.smoothed.slerp(target.quaternion, track);
        else {
          target.smoothed.copy(target.quaternion);
          target.hasPose = true;
        }
        rig[joint].quaternion.slerp(target.smoothed, target.blend);
      } else {
        target.hasPose = false;
      }
    }
  }

  reset(): void {
    this.#landmarks = null;
    this.#fresh = false;
    this.#hipsSeen = false;
    this.#chestSeen = false;
    for (const target of Object.values(this.#targets)) {
      target.visible = false;
      target.blend = 0;
      target.hasPose = false;
      target.quaternion.identity();
    }
  }

  #solveTargets(): void {
    const landmarks = this.#landmarks;
    if (!landmarks) return;

    // Hysteresis everywhere: a joint that is already driving the rig keeps
    // doing so down to a lower visibility floor, so estimates that hover
    // around the threshold (hips just below the webcam frame, elbows near the
    // edge) fade instead of strobing between mocap and the idle animation.
    const shouldersVisible = this.#visible([LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER], 0.3, this.#chestSeen);
    // Anatomical sanity on top of the confidence gate: for waist-up webcam
    // framing BlazePose hallucinates hips near the chest with visibility AND
    // presence ~1.0, so scores alone cannot reject them. Real hips sit well
    // below the neck in world meters; phantom ones collapse the gap.
    const hipsPlausible =
      this.#points[LM.NECK].y - this.#points[LM.HIP_CENTER].y > 0.25;
    const hipsVisible = hipsPlausible && this.#visible([LM.LEFT_HIP, LM.RIGHT_HIP], 0.4, this.#hipsSeen);
    const hipsValid = shouldersVisible && hipsVisible && this.#basis(
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
      LM.HIP_CENTER,
      LM.NECK,
      this.#hipsWorld
    );
    this.#hipsSeen = hipsValid;
    // The pelvis basis belongs to webcam camera space. It is useful as the
    // normalization frame for every child joint, but applying it to rig.hips
    // also transfers camera roll (or a tilted/cropped estimate) to the whole
    // avatar and can lay the player on their side. Locomotion owns the root;
    // mocap drives the articulated pose relative to this stable upright frame.

    // The chest frame must not require the hips: a typical webcam frames the
    // player from the waist up, and losing every arm joint because the hip
    // estimate dipped below threshold was the visible "arms snap down" bug.
    // With hips in view the spine axis comes from hip->neck; without them the
    // camera-up axis stands in (webcams are level enough for arm retargeting).
    let chestValid = false;
    if (shouldersVisible) {
      if (hipsValid) {
        chestValid = this.#basis(LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.HIP_CENTER, LM.NECK, this.#chestWorld);
      }
      if (!chestValid) chestValid = this.#shoulderBasis(this.#chestWorld);
    }
    this.#chestSeen = chestValid;

    if (hipsValid && chestValid) {
      this.#targets.torso.quaternion
        .copy(this.#inverse.copy(this.#hipsWorld).invert())
        .multiply(this.#chestWorld);
      this.#targets.torso.visible = true;
    } else {
      this.#targets.torso.visible = false;
    }

    const headVisible = chestValid && this.#visible([LM.LEFT_EAR, LM.RIGHT_EAR, LM.NECK], 0.3, this.#targets.head.visible);
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
      this.#solveChain("armL", "foreL", LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, armParent, 0.35, 1);
      this.#solveChain("armR", "foreR", LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, armParent, 0.35, 1);
    } else {
      this.#hideChain("armL", "foreL");
      this.#hideChain("armR", "foreR");
    }
    if (hipsValid) {
      this.#solveChain("legL", "shinL", LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE, this.#hipsWorld, 0.52, -1);
      this.#solveChain("legR", "shinR", LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE, this.#hipsWorld, 0.52, -1);
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
    visibilityThreshold: number,
    hingeSign: 1 | -1
  ): void {
    const upperTarget = this.#targets[upper];
    const lowerTarget = this.#targets[lower];
    const upperVisible = this.#visible([root, middle], visibilityThreshold, upperTarget.visible);
    this.#upperDir.copy(this.#points[middle]).sub(this.#points[root]);
    if (!upperVisible || this.#upperDir.lengthSq() < 1e-8) {
      this.#hideChain(upper, lower);
      return;
    }
    this.#inverse.copy(parentWorld).invert();
    this.#upperDir.normalize().applyQuaternion(this.#inverse);
    this.#lowerDir.copy(this.#points[end]).sub(this.#points[middle]);
    const hasLower = this.#lowerDir.lengthSq() > 1e-8;
    if (hasLower) this.#lowerDir.normalize().applyQuaternion(this.#inverse);

    this.#limbBasis(this.#upperDir, hasLower ? this.#lowerDir : null, hingeSign, upperTarget.quaternion);
    upperTarget.visible = true;

    const lowerVisible = hasLower && this.#visible([middle, end], visibilityThreshold, lowerTarget.visible);
    this.#parentWorld.copy(parentWorld).multiply(upperTarget.quaternion);
    lowerTarget.visible =
      lowerVisible && this.#directionFrom(middle, end, this.#parentWorld, lowerTarget.quaternion, DOWN);
  }

  #hideChain(upper: JointName, lower: JointName): void {
    this.#targets[upper].visible = false;
    this.#targets[lower].visible = false;
  }

  /**
   * Full orientation for an upper limb segment. A bare swing rotation
   * (setFromUnitVectors from the rest direction) is singular when the limb
   * points opposite its rest pose — exactly the hands-overhead case — and it
   * leaves the elbow/knee hinge plane arbitrary. Instead build a basis whose
   * -Y is the limb direction and whose X (the hinge axis) comes from the
   * bend plane of the two segments, falling back to the rig's rest hinge
   * axis projected perpendicular to the limb when the joint is straight.
   */
  #limbBasis(
    upperDir: THREE.Vector3,
    lowerDir: THREE.Vector3 | null,
    hingeSign: 1 | -1,
    output: THREE.Quaternion
  ): void {
    this.#y.copy(upperDir).negate();

    let planeWeight = 0;
    if (lowerDir) {
      this.#z.crossVectors(upperDir, lowerDir).multiplyScalar(hingeSign);
      const sinBend = this.#z.length();
      // Trust the bend plane fully past ~15° of flex; below that it is noise.
      planeWeight = Math.min(1, sinBend / 0.25);
      if (sinBend > 1e-6) this.#z.multiplyScalar(1 / sinBend);
      else planeWeight = 0;
    }

    // Rest hinge axis (+X) made perpendicular to the limb; near-degenerate
    // when the limb points along ±X, where the avatar's forward axis steps in.
    this.#x.set(1, 0, 0).addScaledVector(upperDir, -upperDir.x);
    if (this.#x.lengthSq() < 0.04) this.#x.set(0, 0, -1).addScaledVector(upperDir, upperDir.z);
    this.#x.normalize();
    if (planeWeight > 0) {
      this.#x.lerp(this.#z, planeWeight);
      if (this.#x.lengthSq() < 1e-6) this.#x.copy(this.#z);
      else this.#x.normalize();
    }

    this.#z.crossVectors(this.#x, this.#y);
    if (this.#z.lengthSq() < 1e-8) {
      output.setFromUnitVectors(DOWN, upperDir);
      return;
    }
    this.#z.normalize();
    this.#x.crossVectors(this.#y, this.#z).normalize();
    output.setFromRotationMatrix(this.#matrix.makeBasis(this.#x, this.#y, this.#z));
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

  /** Chest frame from the shoulder line plus camera-up, for hips-out-of-frame webcams. */
  #shoulderBasis(output: THREE.Quaternion): boolean {
    this.#x.copy(this.#points[LM.LEFT_SHOULDER]).sub(this.#points[LM.RIGHT_SHOULDER]);
    if (this.#x.lengthSq() < 1e-8) return false;
    this.#x.normalize();
    this.#y.set(0, 1, 0);
    this.#z.crossVectors(this.#x, this.#y);
    if (this.#z.lengthSq() < 1e-8) return false;
    this.#z.normalize();
    this.#x.crossVectors(this.#y, this.#z).normalize();
    output.setFromRotationMatrix(this.#matrix.makeBasis(this.#x, this.#y, this.#z));
    return true;
  }

  #visible(indices: number[], threshold: number, wasVisible = false): boolean {
    const landmarks = this.#landmarks!;
    const floor = wasVisible ? threshold * 0.55 : threshold;
    return indices.every((index) => landmarks[index].visibility >= floor);
  }
}
