import * as THREE from "three/webgpu";
import type { Rig } from "../../player/rig";
import { PICKLEBALL_TUNING as T } from "./constants";

/**
 * Pickleball poses for the shared avatar Rig (buildRig). One entry point,
 * posePickleball, drives the whole athlete every frame: an athletic ready
 * crouch, a speed-blended side-shuffle/run, head tracking on the ball, and a
 * snappy keyframed forehand layered on top while swingTime runs.
 *
 * Rig conventions (see rig.ts): front is local -Z, limbs hang -Y,
 * rotation.x > 0 swings a limb forward. armR (-X side) is the paddle arm; the
 * paddle is rigidly parented to handR (held.ts), so the WRIST keyframes are
 * what aim the face — same trick as poseGolf's GOLF_WRIST.
 */

export type PickleballRigPose = {
  /** Court-plane speed in m/s (drives the shuffle→run blend). */
  speed: number;
  /** Seconds into the active swing, or negative when idle. */
  swingTime: number;
  /** Match clock (animation phase source — deterministic across clients). */
  elapsed: number;
  /** Ball direction hints, -1..1 (court-local, already side-relative). */
  lookX: number;
  lookY: number;
};

/** Paddle-wrist keyframes (handR). r = ready carry, b = backswing coil,
 *  c = contact (face square to the net), f = high finish. Solved empirically
 *  against screenshots; DEV-sweepable via window.__pbTune (rx/ry/rz etc.). */
const WRIST = {
  rx: -1.1, ry: 0, rz: 0, // ready: face square to the net at waist height
  bx: -1.5, by: -0.7, bz: 0.45, // coil: paddle laid back behind the hip
  cx: -0.9, cy: 0.2, cz: -0.2, // contact: face driving across the net
  fx: -0.1, fy: 0.7, fz: -0.7 // finish: rolled over toward the off shoulder
};

type PickleballTune = Partial<typeof WRIST> & { crouch?: number };

function tune(): PickleballTune | undefined {
  if (import.meta.env.DEV) {
    return (globalThis as unknown as { __pbTune?: PickleballTune }).__pbTune;
  }
  return undefined;
}

function set(g: THREE.Group, x: number, y: number, z: number) {
  g.rotation.set(x, y, z);
}

export function posePickleball(r: Rig, state: PickleballRigPose): void {
  const t = tune();
  const run = THREE.MathUtils.clamp(state.speed / T.playerSpeed, 0, 1);
  const cycle = state.elapsed * (7.6 + run * 3.6);
  const stride = Math.sin(cycle) * (0.28 + 0.5 * run) * Math.max(0.18, run);
  const idle = Math.sin(state.elapsed * 2.1);
  const crouch = t?.crouch ?? 0.13;

  // -- athletic base: weight low, feet split, chest over the kitchen line ----
  r.hips.position.x = 0;
  r.hips.position.z = 0;
  r.hips.position.y = -crouch - Math.abs(Math.sin(cycle)) * 0.04 * run + idle * 0.004;
  set(r.hips, 0, 0, Math.sin(cycle * 0.5) * 0.03 * run);
  set(r.torso, 0.24 + run * 0.1, 0, -stride * 0.06);
  set(r.head, -0.16 + state.lookY * 0.34, state.lookX * 0.5, -idle * 0.012);

  // legs: a wide ready split that turns into a shuffle stride with speed.
  // Knees stay bent (negative shin x) so the crouch never floats the feet.
  set(r.legL, 0.34 + stride, 0, 0.18);
  set(r.legR, 0.34 - stride, 0, -0.18);
  set(r.shinL, -0.62 - Math.max(0, -stride) * 0.9, 0, 0);
  set(r.shinR, -0.62 - Math.max(0, stride) * 0.9, 0, 0);

  // off arm: forward for balance, pumping a touch with the stride
  set(r.armL, 0.4 - stride * 0.5, 0.12, 0.34);
  set(r.foreL, 0.75, 0, 0);

  // paddle arm carry: elbow bent, paddle up in front of the chest
  set(r.armR, 0.42 + stride * 0.3, -0.1, -0.3);
  set(r.foreR, 0.95, 0.1, -0.05);
  set(r.handR, t?.rx ?? WRIST.rx, t?.ry ?? WRIST.ry, t?.rz ?? WRIST.rz);
  set(r.handL, 0, 0, 0);

  // -- forehand overlay: coil, accelerate across the body, finish high -------
  if (state.swingTime >= 0 && state.swingTime <= T.swingDuration) {
    const p = THREE.MathUtils.clamp(state.swingTime / T.swingDuration, 0, 1);
    const wind = THREE.MathUtils.smoothstep(p, 0, 0.26);
    const drive = THREE.MathUtils.smoothstep(p, 0.24, 0.56);
    const settle = THREE.MathUtils.smoothstep(p, 0.62, 1);
    const stroke = drive - settle * 0.72; // whips through contact then relaxes

    // shoulders coil away from the net, then rotate hard through the ball;
    // hips lead by a fraction and the whole body rises out of the crouch
    r.torso.rotation.y = -0.55 * wind + 0.72 * stroke;
    r.torso.rotation.x += 0.1 * stroke;
    r.hips.rotation.y = -0.22 * wind + 0.4 * stroke;
    r.hips.position.y += 0.06 * drive - 0.02 * wind;

    // paddle arm + wrist run the same 4-key track: ready carry → coil (paddle
    // laid back behind the hip) → contact (arm extended at chest, face square)
    // → finish (arm released up-and-across). NOTE the shoulder's Y rotation
    // mostly TWISTS a hanging arm about its own axis — the visible arc comes
    // from the X (swing-forward) and Z (ab/adduct) keys plus the torso turn.
    const toContact = THREE.MathUtils.smoothstep(p, 0.24, 0.5); // coil → square
    const late = THREE.MathUtils.smoothstep(p, 0.5, 1); // contact → finish
    const k = (rd: number, bk: number, ct: number, fn: number) =>
      p < 0.5
        ? THREE.MathUtils.lerp(THREE.MathUtils.lerp(rd, bk, wind), ct, toContact)
        : THREE.MathUtils.lerp(ct, fn, late);
    r.armR.rotation.x = k(0.42, -0.35, 1.2, 1.45);
    r.armR.rotation.y = k(-0.1, -0.3, 0.25, 0.55);
    r.armR.rotation.z = k(-0.3, -0.55, 0.2, 0.5);
    r.foreR.rotation.x = k(0.95, 1.15, 0.15, 0.55);
    r.foreR.rotation.y = k(0.1, -0.15, 0.3, 0.45);
    r.handR.rotation.x = k(t?.rx ?? WRIST.rx, t?.bx ?? WRIST.bx, t?.cx ?? WRIST.cx, t?.fx ?? WRIST.fx);
    r.handR.rotation.y = k(t?.ry ?? WRIST.ry, t?.by ?? WRIST.by, t?.cy ?? WRIST.cy, t?.fy ?? WRIST.fy);
    r.handR.rotation.z = k(t?.rz ?? WRIST.rz, t?.bz ?? WRIST.bz, t?.cz ?? WRIST.cz, t?.fz ?? WRIST.fz);

    // two-hand-ish follow-through: the off arm sweeps with the stroke so the
    // finish reads like a real cross-body forehand, not a one-armed wave
    r.armL.rotation.x += 0.35 * stroke;
    r.armL.rotation.z += 0.3 * wind - 0.25 * stroke;
    r.foreL.rotation.x += 0.3 * drive;

    // eyes stay on the contact point then chase the shot
    r.head.rotation.y += -0.15 * wind + 0.3 * stroke;
  }
}
