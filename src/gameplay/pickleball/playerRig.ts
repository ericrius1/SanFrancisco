import * as THREE from "three/webgpu";
import { applyAvatarToRig, buildRig, type Rig } from "../../player/rig";
import { avatarFromSeed, type AvatarTraits } from "../../player/avatar";
import {
  attachToHand,
  buildPickleballPaddle,
  PADDLE_GRIP,
  type HeldItem
} from "../../player/held";
import { posePickleball, type PickleballRigPose } from "./poses";
import type { PickleballSide } from "./types";

export type { PickleballRigPose } from "./poses";

/**
 * Court athlete built from the CANONICAL avatar system: the same buildRig /
 * avatarFromSeed / attachToHand stack as the local player, remotes and every
 * NPC — so an athlete IS a person, outfit and all, and a local takeover can
 * swap the seat's look for the player's own traits (setAvatarTraits).
 *
 * Contract preserved from the old placeholder (game.ts drives it blind):
 * constructor(side), pose(state), readPaddlePose(courtRoot, outCenter,
 * outNormal), worldPosition(out), group, dispose().
 */

// The shared Rig's origin sits at standing hip height; feet reach ~0.905 m
// below it. game.ts parks the athlete group PLAYER_FOOT_LIFT (0.32) above the
// court, so this lift puts soles on the paint. The ready-stance crouch bends
// knees rather than sinking feet (poses.ts keeps shins flexed with the crouch).
const RIG_LIFT = 0.585;

const _worldPosition = new THREE.Vector3();
const _worldQuaternion = new THREE.Quaternion();
const _courtQuaternion = new THREE.Quaternion();

export class PickleballPlayerRig {
  readonly side: PickleballSide;
  readonly group = new THREE.Group();

  #rig: Rig;
  #held: HeldItem;
  #face: THREE.Object3D;
  #seedTraits: AvatarTraits;

  constructor(side: PickleballSide, seed: string | number = `pickleball:${side}`) {
    this.side = side;
    this.group.name = side === 0 ? "pickleball-player-near" : "pickleball-player-far";
    this.#seedTraits = avatarFromSeed(seed);
    this.#rig = buildRig(this.#seedTraits);
    // Rig front is local -Z. Side 0 lives at court -Z and must face +Z (the
    // net), so the whole figure yaws π; side 1 already faces -Z across.
    this.#rig.group.rotation.y = side === 0 ? Math.PI : 0;
    this.#rig.group.position.y = RIG_LIFT;
    this.group.add(this.#rig.group);

    this.#held = attachToHand(this.#rig, "R", buildPickleballPaddle(), PADDLE_GRIP);
    // face plate is the physical contact reference for the sweep sim
    this.#face = this.#held.object.getObjectByName("pickleball-paddle-face")!;
  }

  /** Swap the athlete's look (local takeover wears the player's own traits;
   *  null reverts to this seat's seeded outfit). Outfits rescale the hand
   *  groups, so the paddle re-attaches to bake the fresh inverse scale. */
  setAvatarTraits(traits: AvatarTraits | null): void {
    applyAvatarToRig(this.#rig, traits ?? this.#seedTraits);
    this.#held.release();
    this.#held = attachToHand(this.#rig, "R", this.#held.object, PADDLE_GRIP);
  }

  /** Apply the allocation-free procedural ready/shuffle/swing pose. */
  pose(state: PickleballRigPose): void {
    posePickleball(this.#rig, state);
  }

  /** Reads the animated paddle face (center + outward normal) in court-local
   *  coordinates for the swept-sphere hit sim. */
  readPaddlePose(courtRoot: THREE.Object3D, outCenter: THREE.Vector3, outNormal: THREE.Vector3): void {
    courtRoot.updateWorldMatrix(true, false);
    this.#face.updateWorldMatrix(true, false);
    this.#face.getWorldPosition(_worldPosition);
    outCenter.copy(_worldPosition);
    courtRoot.worldToLocal(outCenter);

    // The face plate is a Z-axis cylinder (held.ts) — its axis IS the face
    // normal. The wrist rolls the paddle through the swing, so resolve the
    // live axis, then keep the half that points across the net: side 0 hits
    // toward +Z, side 1 toward -Z. (The sim only uses the normal for a small
    // physical deflection; the sign flip keeps that deflection net-ward even
    // mid-backswing.)
    this.#face.getWorldQuaternion(_worldQuaternion);
    courtRoot.getWorldQuaternion(_courtQuaternion).invert();
    outNormal.set(0, 0, 1).applyQuaternion(_worldQuaternion).applyQuaternion(_courtQuaternion).normalize();
    const toward = this.side === 0 ? 1 : -1;
    if (outNormal.z * toward < 0) outNormal.multiplyScalar(-1);
  }

  worldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(true, false);
    return this.group.getWorldPosition(out);
  }

  dispose(): void {
    // buildRig geometry is a shared module cache (never dispose); the avatar
    // materials are per-rig. Paddle geometry/materials are held.ts statics.
    for (const material of Object.values(this.#rig.avatar.materials)) material.dispose();
    this.group.removeFromParent();
  }
}
