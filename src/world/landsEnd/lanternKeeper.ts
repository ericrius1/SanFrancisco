// The Lands End lantern-keeper — a hooded figure at the mouth of the labyrinth,
// a warm paper-lantern swinging from one hand. Walk up and press E and she
// gives you the labyrinth's one instruction. Cheap: a single shared Rig posed
// by poseIdle, a fake-emissive lantern (no PointLight — a light-count change is
// a scene-wide pipeline rebuild).

import * as THREE from "three/webgpu";
import { color } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { formatInteractPrompt } from "../../core/input";
import type { WorldMap } from "../heightmap";
import { avatarFromSeed } from "../../player/avatar";
import { buildRig, poseIdle, type Rig } from "../../player/rig";
import { attachToHand } from "../../player/held";
import { KEEPER, LABYRINTH } from "./layout";

const RIG_STAND_Y = 0.92;
const REACH = 5.5;

// one shared warm-glass lantern material (never per-build)
const LANTERN_GLASS = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0, transparent: true, opacity: 0.9 });
  m.colorNode = color(0x3a1e08);
  (m as unknown as { emissiveNode: unknown }).emissiveNode = color(0xffb457).mul(2.0 * LIGHT_SCALE);
  return m;
})();
const LANTERN_FRAME = new THREE.MeshStandardNodeMaterial({ color: 0x241a12, roughness: 0.7 });

/** A small paper lantern. Origin = the top bail (where the hand grips); the box
 *  body hangs down local -Y so attachToHand can roll it upright. */
function buildLantern(): THREE.Group {
  const g = new THREE.Group();
  g.name = "keeper-lantern";
  const bail = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 10), LANTERN_FRAME);
  bail.rotation.x = Math.PI / 2;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.05, 8), LANTERN_FRAME);
  cap.position.y = -0.11;
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.2, 8), LANTERN_GLASS);
  glass.position.y = -0.23;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.05, 8), LANTERN_FRAME);
  base.position.y = -0.35;
  for (const m of [bail, cap, glass, base]) g.add(m);
  return g;
}

export class LanternKeeper {
  readonly group = new THREE.Group();
  #rig: Rig;
  #promptShown = false;

  constructor(map: WorldMap) {
    this.group.name = "landsEnd.keeper";
    const rig = buildRig(avatarFromSeed("lands-end-keeper"));
    this.#rig = rig;
    const gy = map.groundTop(KEEPER.x, KEEPER.z);
    this.group.position.set(KEEPER.x, gy + RIG_STAND_Y, KEEPER.z);
    // face the labyrinth centre
    this.group.rotation.y = Math.atan2(LABYRINTH.x - KEEPER.x, LABYRINTH.z - KEEPER.z);
    this.group.add(rig.group);

    const lantern = buildLantern();
    attachToHand(rig, "R", lantern, { position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], curl: 0.9 });

    poseIdle(rig, 0);
  }

  update(_dt: number, elapsed: number) {
    poseIdle(this.#rig, elapsed);
    // gentle lantern-arm sway is already in poseIdle's breathing; keep it simple
  }

  /** E-to-talk. Returns true if it consumed the press. */
  tryInteract(player: { renderPosition: { x: number; z: number }; mode: string }, hud: { message(t: string, s?: number): void }): boolean {
    if (player.mode !== "walk") return false;
    const dx = player.renderPosition.x - KEEPER.x;
    const dz = player.renderPosition.z - KEEPER.z;
    if (dx * dx + dz * dz > REACH * REACH) return false;
    hud.message("Walk the spiral to its heart, and the light will follow you home.", 5);
    return true;
  }

  /** One-shot proximity prompt; call each frame with the player XZ. */
  updatePrompt(px: number, pz: number, hud: { message(t: string, s?: number): void }) {
    const dx = px - KEEPER.x;
    const dz = pz - KEEPER.z;
    const near = dx * dx + dz * dz < REACH * REACH;
    if (near && !this.#promptShown) {
      this.#promptShown = true;
      hud.message(formatInteractPrompt("speak with the lantern-keeper"), 2.2);
    } else if (!near && this.#promptShown) {
      this.#promptShown = false;
    }
  }
}
