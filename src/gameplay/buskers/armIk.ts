import * as THREE from "three/webgpu";

/**
 * Six-angle arm station used by the procedural busker rigs:
 * [upper x/y/z, forearm x/y/z]. Stations are solved once while a musician is
 * built, then only blended/damped at runtime.
 */
export type ArmPose = [number, number, number, number, number, number];

export type ArmSolveOptions = {
  /** +1 for the character's left arm, -1 for their right arm. */
  side: 1 | -1;
  /** Torso-local elbow distance from centre before it counts as outboard. */
  elbowClearance?: number;
  /** A tucked elbow is also safe when it is this far in front of the torso. */
  elbowFront?: number;
  regularize?: number;
};

const MIN: ArmPose = [-0.7, -1.35, -1.55, 0.02, -1.25, -1.85];
const MAX: ArmPose = [2.25, 1.35, 1.55, 2.75, 1.25, 1.85];

/** Build-time coordinate-descent IK. The marker and target must be expressed
 * in the same world (the busker builders solve before placing their wrapper,
 * so their current world space is stable and deterministic). */
export function solveArmPose(
  arm: THREE.Group,
  fore: THREE.Group,
  marker: THREE.Object3D,
  target: THREE.Vector3,
  seed: ArmPose,
  options: ArmSolveOptions
): ArmPose {
  const pose = seed.map((value, i) => THREE.MathUtils.clamp(value, MIN[i], MAX[i])) as ArmPose;
  const handWorld = new THREE.Vector3();
  const elbowLocal = new THREE.Vector3();
  const elbowClearance = options.elbowClearance ?? 0.255;
  const elbowFront = options.elbowFront ?? -0.16;
  const regularize = options.regularize ?? 0.000035;

  const score = () => {
    applyArmPose(arm, fore, pose);
    marker.getWorldPosition(handWorld);
    let error = handWorld.distanceToSquared(target);

    // A hand-only solve happily pulls the chunky upper arm through the torso.
    // Keep the elbow outboard unless it has already folded visibly in front of
    // the body, where an inward reach is anatomically and visually clear.
    fore.getWorldPosition(elbowLocal);
    arm.parent?.worldToLocal(elbowLocal);
    const inward = Math.max(0, elbowClearance - options.side * elbowLocal.x);
    const behindFrontPlane = Math.max(0, elbowLocal.z - elbowFront);
    if (inward > 0 && behindFrontPlane > 0) error += inward * inward * Math.min(1, behindFrontPlane / 0.16) * 8;

    for (let i = 0; i < pose.length; i++) {
      const delta = pose[i] - seed[i];
      error += delta * delta * regularize;
    }
    return error;
  };

  let best = score();
  let step = 0.58;
  let evaluations = 0;
  while (step > 0.004 && evaluations < 1600) {
    let improved = false;
    for (let i = 0; i < pose.length; i++) {
      const original = pose[i];
      let accepted = original;
      for (const direction of [1, -1] as const) {
        pose[i] = THREE.MathUtils.clamp(original + direction * step, MIN[i], MAX[i]);
        if (pose[i] === original) continue;
        evaluations++;
        const candidate = score();
        if (candidate < best - 1e-10) {
          best = candidate;
          accepted = pose[i];
          improved = true;
          break;
        }
      }
      pose[i] = accepted;
    }
    if (!improved) step *= 0.62;
  }
  applyArmPose(arm, fore, pose);
  return pose;
}

export function applyArmPose(arm: THREE.Group, fore: THREE.Group, pose: ArmPose): void {
  arm.rotation.set(pose[0], pose[1], pose[2]);
  fore.rotation.set(pose[3], pose[4], pose[5]);
}

export function dampArmPose(current: ArmPose, target: ArmPose, lambda: number, dt: number): ArmPose {
  for (let i = 0; i < current.length; i++) current[i] = THREE.MathUtils.damp(current[i], target[i], lambda, dt);
  return current;
}

export function mixArmPose(out: ArmPose, a: ArmPose, b: ArmPose, amount: number): ArmPose {
  for (let i = 0; i < out.length; i++) out[i] = THREE.MathUtils.lerp(a[i], b[i], amount);
  return out;
}
