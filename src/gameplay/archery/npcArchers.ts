import * as THREE from "three/webgpu";
import { buildRig, type Rig } from "../../player/rig";
import { avatarFromSeed } from "../../player/avatar";
import { attachToHand, buildBow } from "../../player/held";
import { ARCHER_BOW_GRIP, poseArcher, poseArcherIdle } from "./poses";
import { ARCHERY_DIR, ARCHERY_YAW, laneLineXZ } from "./layout";
import type { ArcheryTarget } from "./site";

/**
 * Two ambient archers on the outer lanes during the day, buskers-style: shared
 * Rig + procedural poses, a real bow in the left mitt via the grip system, and
 * REAL arrows — their loose hands the shot to the game's shared flight sim, so
 * their arrows stick in their own targets exactly like yours.
 *
 * Zero work asleep: the game's update() early-return means this never ticks
 * while the site sleeps, and the group lives under the gated root so it never
 * renders either. Press E beside one to take over their lane — they step back
 * politely and resume when you hand the lane back.
 */

const RIG_STAND_Y = 0.92; // rig group origin = capsule centre above soles
const ANIM_RADIUS = 130; // beyond this the cycle keeps ticking but poses freeze
const LAUNCH_SPEED = 36;
const GRAVITY = 9.8;

type Phase = "idle" | "nock" | "draw" | "hold" | "loose";
const PHASE_LEN: Record<Phase, number> = { idle: 2.2, nock: 0.45, draw: 1.2, hold: 0.4, loose: 0.35 };

export type NpcLooseFn = (
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  speed: number,
  lane: number
) => void;

type Npc = {
  lane: number;
  rig: Rig;
  group: THREE.Group;
  phase: Phase;
  phaseT: number;
  idleWait: number;
  pitch: number;
  aim: THREE.Vector3; // solved launch direction for the queued shot
  takenOver: boolean;
  homeX: number;
  homeZ: number;
};

const V = { launch: new THREE.Vector3(), toTarget: new THREE.Vector3() };

export class NpcArchers {
  readonly group = new THREE.Group();
  #npcs: Npc[] = [];
  #targets: ArcheryTarget[];
  #loose: NpcLooseFn;
  #onDraw: (x: number, y: number, z: number) => void;
  #elapsed = 0;
  #shown = true;

  constructor(
    lanes: readonly number[],
    targets: ArcheryTarget[],
    ground: (x: number, z: number) => number,
    loose: NpcLooseFn,
    onDraw: (x: number, y: number, z: number) => void
  ) {
    this.group.name = "archery-npcs";
    this.#targets = targets;
    this.#loose = loose;
    this.#onDraw = onDraw;
    lanes.forEach((lane, i) => {
      const spot = laneLineXZ(lane);
      const rig = buildRig(avatarFromSeed(`archer-npc-${i + 1}`));
      const group = new THREE.Group();
      group.add(rig.group);
      group.position.set(spot.x, ground(spot.x, spot.z) + RIG_STAND_Y, spot.z);
      // aim runs along the rig's local +X (poseArcher's frame)
      group.rotation.y = ARCHERY_YAW - Math.PI / 2;
      this.group.add(group);
      const bow = buildBow();
      attachToHand(rig, "L", bow, ARCHER_BOW_GRIP);
      this.#npcs.push({
        lane,
        rig,
        group,
        phase: "idle",
        phaseT: i * 1.3, // stagger the loops so they never fire in sync
        idleWait: PHASE_LEN.idle + i * 1.7,
        pitch: 0,
        aim: new THREE.Vector3(ARCHERY_DIR.x, 0, ARCHERY_DIR.z),
        takenOver: false,
        homeX: spot.x,
        homeZ: spot.z
      });
    });
  }

  /** DEV/probe: current phase per NPC. */
  debugPhases(): string[] {
    return this.#npcs.map((n) => (n.takenOver ? "takenOver" : n.phase));
  }

  /** Daylight gate: hide + halt the ambient act at night. */
  setShown(on: boolean) {
    if (this.#shown === on) return;
    this.#shown = on;
    this.group.visible = on;
  }

  /** Index of a takeover-able NPC within `radius` of (x,z), else -1. */
  nearestLane(x: number, z: number, radius: number): number {
    let best = -1;
    let bestD = radius;
    this.#npcs.forEach((npc, i) => {
      if (npc.takenOver || !this.#shown) return;
      const d = Math.hypot(npc.group.position.x - x, npc.group.position.z - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  laneOf(idx: number): number {
    return this.#npcs[idx].lane;
  }

  /** Takeover: the archer steps back behind the line and idles; releasing the
   *  lane walks them back to their spot and the loop resumes. */
  setTakenOver(idx: number, on: boolean) {
    const npc = this.#npcs[idx];
    if (!npc || npc.takenOver === on) return;
    npc.takenOver = on;
    npc.phase = "idle";
    npc.phaseT = 0;
    npc.idleWait = PHASE_LEN.idle;
    const back = on ? 3.2 : 0;
    npc.group.position.x = npc.homeX - ARCHERY_DIR.x * back;
    npc.group.position.z = npc.homeZ - ARCHERY_DIR.z * back;
  }

  /** Solve a slightly-scattered ballistic launch dir for this NPC's target. */
  #solveAim(npc: Npc): void {
    const target = this.#targets.find((t) => t.lane === npc.lane);
    if (!target) return;
    const launch = V.launch.copy(npc.group.position);
    launch.y += 0.55; // chest anchor
    // aim point: target centre + a small scatter so rings vary shot to shot
    const scatter = 0.4;
    V.toTarget
      .copy(target.center)
      .addScaledVector(target.normal, 0.02)
      .sub(launch);
    V.toTarget.x += (Math.random() - 0.5) * scatter;
    V.toTarget.y += (Math.random() - 0.5) * scatter;
    V.toTarget.z += (Math.random() - 0.5) * scatter;
    const R = Math.hypot(V.toTarget.x, V.toTarget.z);
    const dh = V.toTarget.y;
    const v2 = LAUNCH_SPEED * LAUNCH_SPEED;
    // low-arc projectile solution; falls back to straight at solver edge
    const disc = v2 * v2 - GRAVITY * (GRAVITY * R * R + 2 * dh * v2);
    const theta = disc > 0 ? Math.atan((v2 - Math.sqrt(disc)) / (GRAVITY * R)) : Math.atan2(dh, R);
    npc.pitch = theta;
    npc.aim.set((V.toTarget.x / R) * Math.cos(theta), Math.sin(theta), (V.toTarget.z / R) * Math.cos(theta)).normalize();
  }

  #fire(npc: Npc) {
    const launch = V.launch.copy(npc.group.position);
    launch.y += 0.55;
    launch.addScaledVector(npc.aim, 0.6);
    this.#loose(launch, npc.aim, LAUNCH_SPEED, npc.lane);
  }

  /** Tick the loops; pose only within ANIM_RADIUS of the player. */
  update(dt: number, px: number, pz: number) {
    if (!this.#shown) return;
    this.#elapsed += dt;
    for (const npc of this.#npcs) {
      const near = Math.hypot(npc.group.position.x - px, npc.group.position.z - pz) < ANIM_RADIUS;
      if (npc.takenOver) {
        if (near) poseArcherIdle(npc.rig, this.#elapsed + npc.lane);
        continue;
      }
      npc.phaseT += dt;
      const len = npc.phase === "idle" ? npc.idleWait : PHASE_LEN[npc.phase];
      if (npc.phaseT >= len) {
        npc.phaseT = 0;
        switch (npc.phase) {
          case "idle":
            npc.phase = "nock";
            break;
          case "nock":
            npc.phase = "draw";
            this.#solveAim(npc);
            if (near) {
              const p = npc.group.position;
              this.#onDraw(p.x, p.y + 0.5, p.z);
            }
            break;
          case "draw":
            npc.phase = "hold";
            break;
          case "hold":
            npc.phase = "loose";
            if (near) this.#fire(npc); // unseen shots skip the flight sim entirely
            break;
          case "loose":
            npc.phase = "idle";
            npc.idleWait = 1.6 + Math.random() * 2.6;
            break;
        }
      }
      if (!near) continue;
      switch (npc.phase) {
        case "idle":
          poseArcherIdle(npc.rig, this.#elapsed + npc.lane * 2.1);
          break;
        case "nock":
          poseArcher(npc.rig, -(npc.phaseT / PHASE_LEN.nock), 0);
          break;
        case "draw":
          poseArcher(npc.rig, npc.phaseT / PHASE_LEN.draw, npc.pitch);
          break;
        case "hold":
          poseArcher(npc.rig, 1, npc.pitch);
          break;
        case "loose":
          poseArcher(npc.rig, Math.max(0, 1 - npc.phaseT / 0.22) * 0.2, npc.pitch);
          break;
      }
    }
  }
}
