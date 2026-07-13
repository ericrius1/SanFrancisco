import * as THREE from "three/webgpu";
import { setHandPose, type HandPose, type Rig } from "./rig";

/**
 * Runtime per-hand target controller — the system-wide "put this hand HERE,
 * facing THIS way, with the fingers curled like SO" primitive. Any avatar built
 * by buildRig (the local player, buskers, pickleball athletes, the tea master,
 * future training robots) can drive a hand to a moving world target every frame
 * with one call.
 *
 * Unlike the buskers' build-time coordinate-descent solveArmPose (~1600 evals,
 * position only), this is a closed-form 2-bone analytic IK: a handful of dot /
 * cross / acos per hand, allocation-free, fully deterministic (so it stays in
 * multiplayer parity), and cheap enough to run for every visible hand.
 *
 * It writes three things, layered AFTER the frame's base pose fn (which owns the
 * body): the shoulder group's quaternion (aim), the elbow's fold, the hand
 * group's orientation (wrist), and finally the finger pose. It must run after
 * the base pose so the shoulder frame it reads is current, and it fully OWNS the
 * arm+wrist for that hand this frame.
 */

export type HandTarget = {
  /** World-space target for the wrist (hand group origin). */
  pos: THREE.Vector3;
  /** World-space desired hand orientation. Omit to leave the wrist neutral
   *  (inherits the forearm) — right for held items whose GripSpec owns aim. */
  aim?: THREE.Quaternion;
  /** World-space point the elbow should bend toward. Omit for a natural
   *  down-and-outboard elbow. */
  pole?: THREE.Vector3;
  /** Finger closure this frame (scalar or HandPose). Omit to leave fingers as-is. */
  hand?: number | HandPose;
  /** 0..1 scale on the reach so a hand can relax just short of full extension
   *  (default 1). */
  reach?: number;
};

const X_AXIS = new THREE.Vector3(1, 0, 0);
const S = {
  target: new THREE.Vector3(),
  shoulder: new THREE.Vector3(),
  toTarget: new THREE.Vector3(),
  hLocal: new THREE.Vector3(),
  elbow: new THREE.Vector3(),
  poleDir: new THREE.Vector3(),
  axis: new THREE.Vector3(),
  eProj: new THREE.Vector3(),
  pProj: new THREE.Vector3(),
  cross: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  roll: new THREE.Quaternion(),
  foreQuat: new THREE.Quaternion()
};

const EPS = 1e-5;
const ELBOW_MIN = 0.02; // no backward hyperextension (matches armIk MIN)
const ELBOW_MAX = 2.75;

/**
 * Drive one hand to a world target. The caller must have the rig's world
 * matrices reasonably current for this frame (i.e. call after the base pose has
 * been applied and the rig group placed — the same contract as rigHandWorld).
 */
export function setHandTarget(rig: Rig, side: "L" | "R", t: HandTarget): void {
  const right = side === "R";
  const arm = right ? rig.armR : rig.armL;
  const fore = right ? rig.foreR : rig.foreL;
  const hand = right ? rig.handR : rig.handL;
  const torso = arm.parent;
  if (!torso) return;

  // Work in the shoulder's parent (torso) frame: the shoulder origin is fixed
  // there and the joint rotations we write are relative to it.
  torso.updateWorldMatrix(true, false);
  S.target.copy(t.pos);
  torso.worldToLocal(S.target); // → torso-local
  S.shoulder.copy(arm.position);
  S.toTarget.copy(S.target).sub(S.shoulder);

  const a = fore.position.length(); // upper-arm length (elbow offset)
  const b = hand.position.length(); // forearm length (wrist offset)
  const reach = a + b;
  const distTarget = S.toTarget.length();
  const reachScale = t.reach ?? 1;
  // Clamp inside the reachable annulus; a hair under full reach keeps the elbow
  // from locking dead-straight (reads stiff and makes the pole roll singular).
  const dist = THREE.MathUtils.clamp(distTarget, Math.abs(a - b) + 0.04, reach * reachScale - 0.01);

  // Elbow fold φ from the law of cosines: |wrist-shoulder|² = a²+b²+2ab·cosφ,
  // where φ=0 is a straight arm. Solve for φ and clamp to the joint limit.
  const cosPhi = THREE.MathUtils.clamp((dist * dist - a * a - b * b) / (2 * a * b), -1, 1);
  const phi = THREE.MathUtils.clamp(Math.acos(cosPhi), ELBOW_MIN, ELBOW_MAX);
  fore.rotation.set(phi, 0, 0);

  // With the elbow folded (and the shoulder still at identity) read the wrist's
  // actual arm-local offset. Rotating the whole shoulder by q maps this vector
  // onto the shoulder→target ray, landing the wrist on (or toward) the target.
  S.hLocal.copy(hand.position).applyAxisAngle(X_AXIS, phi).add(fore.position);
  const hLen = S.hLocal.length();
  if (hLen < EPS || distTarget < EPS) return;
  S.hLocal.multiplyScalar(1 / hLen);
  S.toTarget.multiplyScalar(1 / distTarget);
  S.quat.setFromUnitVectors(S.hLocal, S.toTarget);

  // Roll about the target axis so the elbow bends toward a pole (default: down,
  // outboard, and slightly back — a natural resting elbow). This is the one DOF
  // the position solve leaves free.
  S.axis.copy(S.toTarget); // already unit
  // Current elbow direction (shoulder→elbow) after the shortest-arc placement.
  S.elbow.set(0, -a, 0).applyQuaternion(S.quat);
  if (t.pole) {
    S.poleDir.copy(t.pole); // world point the elbow should bend toward
    torso.worldToLocal(S.poleDir);
    S.poleDir.sub(S.shoulder);
  } else {
    const sideSign = right ? -1 : 1;
    S.poleDir.set(sideSign * 0.5, -0.85, 0.28);
  }
  // Project both perpendicular to the axis, then roll one onto the other.
  const eDot = S.elbow.dot(S.axis);
  S.eProj.copy(S.elbow).addScaledVector(S.axis, -eDot);
  const pDot = S.poleDir.dot(S.axis);
  S.pProj.copy(S.poleDir).addScaledVector(S.axis, -pDot);
  const eLen = S.eProj.length();
  const pLen = S.pProj.length();
  if (eLen > EPS && pLen > EPS) {
    S.eProj.multiplyScalar(1 / eLen);
    S.pProj.multiplyScalar(1 / pLen);
    let cos = THREE.MathUtils.clamp(S.eProj.dot(S.pProj), -1, 1);
    let ang = Math.acos(cos);
    S.cross.copy(S.eProj).cross(S.pProj);
    if (S.cross.dot(S.axis) < 0) ang = -ang;
    S.roll.setFromAxisAngle(S.axis, ang);
    S.quat.premultiply(S.roll);
  }
  arm.quaternion.copy(S.quat);

  // Wrist orientation: make the hand world quaternion equal `aim`. hand.world =
  // fore.world * hand.local  ⇒  hand.local = fore.world⁻¹ * aim. Needs the arm
  // chain's world matrices current after the writes above.
  if (t.aim) {
    arm.updateWorldMatrix(false, true); // arm→fore→hand now that rotations are set
    fore.getWorldQuaternion(S.foreQuat);
    hand.quaternion.copy(S.foreQuat.invert()).multiply(t.aim);
  }

  if (t.hand !== undefined) setHandPose(rig, side, t.hand);
}
