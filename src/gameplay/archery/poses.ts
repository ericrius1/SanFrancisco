import * as THREE from "three/webgpu";
import type { Rig } from "../../player/rig";
import type { GripSpec } from "../../player/held";

/**
 * Archer poses on the shared box Rig, golf's poseGolf discipline: the caller
 * aligns the whole avatar so the AIM runs along the rig's local +X (the LEFT
 * side — the bow arm), i.e. player.heading = aimYaw + π/2 / npc
 * group.rotation.y = aimYaw − π/2. Side-on stance, chest square to local -Z,
 * face turned down the arrow.
 *
 * `draw` domain (mirrors poseGolf's -1..1 trick):
 *   draw < 0  — nock flourish, |draw| 0..1: the string hand reaches over the
 *               shoulder to the quiver and comes back to the string (arms only)
 *   draw = 0  — addressed at the line, bow raised, string hand on the nock
 *   draw 0..1 — the draw: bow arm locks out, string hand pulls to the cheek,
 *               slight lean-back at full draw
 * `pitch` (radians, + = aiming up) tips the whole aim plane.
 */
export function poseArcher(r: Rig, draw: number, pitch = 0): void {
  const nock = Math.max(0, -draw); // 0..1 through the quiver-reach flourish
  const d = THREE.MathUtils.clamp(draw, 0, 1);
  const p = THREE.MathUtils.clamp(pitch, -0.7, 0.7);

  // planted side-on stance: lead (L, downrange) foot ahead, weight settling
  // back onto the trail foot as the draw loads
  r.hips.position.set(-d * 0.02, -0.06 - d * 0.02, 0);
  r.hips.rotation.set(0, -0.12, 0);
  // chest opens a touch toward the target, spine leans back at full draw
  r.torso.rotation.set(0.04, -0.38 - d * 0.1, -0.05 + d * 0.12);
  // face sights down the arrow (local +X) and follows the pitch
  r.head.rotation.set(-p * 0.55, -0.92 - d * 0.12, -0.1);

  // legs: feet spread along the aim line (x-splay via z-rotation)
  r.legL.rotation.set(0, 0, 0.2);
  r.legR.rotation.set(0, 0, -0.2);
  r.shinL.rotation.set(-0.08, 0, 0);
  r.shinR.rotation.set(-0.08, 0, 0);

  // BOW ARM (armL, +X): rises from a ready carry to a horizontal lockout as
  // the draw starts; z past π/2 = raised above horizontal, so pitch adds on
  const bowRaise = 1.05 + Math.min(1, d * 3 + nock * 0.4) * 0.42; // snaps up early in the draw
  r.armL.rotation.set(0, 0, bowRaise + p);
  r.foreL.rotation.set(0, 0, 0.06);
  // keep the bow wrist neutral: the grip solve (ARCHER_BOW_GRIP) owns the
  // riser orientation relative to the hand frame
  r.handL.rotation.set(0, 0, 0);

  if (nock > 0) {
    // quiver-reach flourish: string hand sweeps over the trail shoulder and
    // back to the string. Arms only — stance/torso hold the address above.
    const reach = Math.sin(Math.min(1, nock) * Math.PI); // up-and-back, then home
    r.armR.rotation.set(-0.5 - reach * 1.5, 0, -0.35 - reach * 0.5);
    r.foreR.rotation.set(0.9 + reach * 1.1, 0, 0);
    r.handR.rotation.set(0, 0, 0);
    return;
  }

  // STRING ARM (armR, -X): starts crossed to the nock beside the bow hand,
  // pulls straight back along the arrow line to the cheek anchor. The elbow
  // swings up and behind as the hand comes home.
  const k = d;
  r.armR.rotation.set(
    THREE.MathUtils.lerp(-0.2, -0.05, k) + p * 0.4,
    THREE.MathUtils.lerp(-0.85, -0.25, k),
    THREE.MathUtils.lerp(0.55, 1.35, k)
  );
  r.foreR.rotation.set(THREE.MathUtils.lerp(0.5, 0.12, k), THREE.MathUtils.lerp(-0.3, -0.1, k), THREE.MathUtils.lerp(0.4, 2.0, k));
  r.handR.rotation.set(0, 0, 0);
}

/** Bow lowered at the side between ends — a relaxed watch-the-lane idle for
 *  NPC archers (the local player keeps the normal walk/idle animator while
 *  merely carrying the bow). `t` = free-running seconds. */
export function poseArcherIdle(r: Rig, t: number): void {
  const breathe = Math.sin(t * 1.5);
  r.hips.position.set(0, 0, 0);
  r.hips.rotation.set(0, 0, 0);
  r.torso.rotation.set(0.03 + breathe * 0.015, Math.sin(t * 0.27) * 0.08, 0);
  r.head.rotation.set(0.02, -0.3 + Math.sin(t * 0.2) * 0.25, 0);
  r.legL.rotation.set(0.02, 0, 0.06);
  r.legR.rotation.set(-0.02, 0, -0.06);
  r.shinL.rotation.set(-0.05, 0, 0);
  r.shinR.rotation.set(-0.05, 0, 0);
  // bow arm hangs with the bow, string hand rests loose
  r.armL.rotation.set(0.1, 0, 0.22 + breathe * 0.02);
  r.foreL.rotation.set(0.1, 0, 0);
  r.handL.rotation.set(0, 0, 0);
  r.armR.rotation.set(-breathe * 0.03, 0, -0.1);
  r.foreR.rotation.set(0.2, 0, 0);
  r.handR.rotation.set(0, 0, 0);
}

/**
 * Bow-in-left-hand grip. BOW_GRIP (held.ts) leaves the string facing the
 * body side once the bow arm extends; the frame Y-spin here rolls the riser
 * about itself so the bow's back (-Z) points down the hand's -Y — which is
 * downrange once the arm is horizontal. Solved analytically from the hand
 * frame (arm z-rotation maps hand X→up, hand -Y→downrange), then verified
 * on screenshots. DEV-sweepable via window.__archeryTune (bx..brz).
 */
export const ARCHER_BOW_GRIP: GripSpec = {
  position: [0, 0, 0],
  rotation: [0, Math.PI / 2, Math.PI / 2]
};
