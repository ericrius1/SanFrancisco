import * as THREE from "three/webgpu";
import { buildRig, poseIdle, type Rig } from "../../player/rig";
import { avatarFromSeed } from "../../player/avatar";
import type { WorldMap } from "../../world/heightmap";
import { NPC_LAYOUT, REVERIE_TUNING } from "./layout";

type Npc = {
  id: string;
  name: string;
  hello: string;
  midway: string;
  done: string;
  rig: Rig;
  group: THREE.Group;
  homeX: number;
  homeZ: number;
};

const RIG_STAND_Y = 0.92;

export class ReverieNpcs {
  readonly group = new THREE.Group();
  #npcs: Npc[] = [];
  #t = 0;

  constructor(map: WorldMap) {
    this.group.name = "palace-reverie-npcs";
    for (const spec of NPC_LAYOUT) {
      const rig = buildRig(avatarFromSeed(spec.seed));
      const group = new THREE.Group();
      group.add(rig.group);
      const y = map.groundTop(spec.x, spec.z) + RIG_STAND_Y;
      group.position.set(spec.x, y, spec.z);
      group.rotation.y = spec.yaw;
      this.group.add(group);
      this.#npcs.push({
        id: spec.id,
        name: spec.name,
        hello: spec.hello,
        midway: spec.midway,
        done: spec.done,
        rig,
        group,
        homeX: spec.x,
        homeZ: spec.z
      });
    }
  }

  nearest(x: number, z: number, radius: number): Npc | null {
    let best: Npc | null = null;
    let bestD = radius;
    for (const npc of this.#npcs) {
      const d = Math.hypot(npc.homeX - x, npc.homeZ - z);
      if (d < bestD) {
        bestD = d;
        best = npc;
      }
    }
    return best;
  }

  promptLine(x: number, z: number, lit: number, total: number, complete: boolean): string | null {
    const npc = this.nearest(x, z, REVERIE_TUNING.promptRadius);
    if (!npc) return null;
    if (complete) return `E — listen to ${npc.name}`;
    if (lit === 0) return `E — talk to ${npc.name}`;
    return `E — check in with ${npc.name}`;
  }

  talk(x: number, z: number, lit: number, total: number, complete: boolean): string | null {
    const npc = this.nearest(x, z, REVERIE_TUNING.interactRadius + 1.2);
    if (!npc) return null;
    if (complete) return npc.done;
    if (lit === 0) return npc.hello;
    if (lit >= total) return npc.done;
    return npc.midway;
  }

  update(dt: number, playerX?: number, playerZ?: number) {
    this.#t += dt;
    for (const npc of this.#npcs) {
      poseIdle(npc.rig, this.#t);
      if (npc.id === "inez") {
        npc.rig.armR.rotation.x = -0.55 + Math.sin(this.#t * 1.2) * 0.08;
        npc.rig.foreR.rotation.x = 0.9;
        npc.rig.head.rotation.y = -0.35 + Math.sin(this.#t * 0.4) * 0.05;
      }
      if (npc.id === "rook") {
        npc.rig.head.rotation.y = Math.sin(this.#t * 0.35) * 0.45;
        npc.rig.armL.rotation.z = 0.25;
      }
      // Gently face the player when they're nearby
      if (playerX !== undefined && playerZ !== undefined) {
        const dx = playerX - npc.homeX;
        const dz = playerZ - npc.homeZ;
        const dist = Math.hypot(dx, dz);
        if (dist < 14) {
          const want = Math.atan2(-dx, -dz);
          let delta = want - npc.group.rotation.y;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          npc.group.rotation.y += delta * Math.min(1, dt * 2.2);
        }
      }
    }
  }

  /** Cinematic helper: world positions of NPCs. */
  forEach(fn: (npc: { id: string; x: number; y: number; z: number }) => void) {
    for (const npc of this.#npcs) {
      fn({ id: npc.id, x: npc.group.position.x, y: npc.group.position.y, z: npc.group.position.z });
    }
  }
}
