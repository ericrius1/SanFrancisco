import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import { Policy, type PolicyDef } from "../../creatures/policy";
import { HORSE, qRot, type CreatureSpec, type Link } from "../../creatures/quadruped";
import { HorseRagdoll } from "./horseRagdoll";

/**
 * A little herd of RL horses roaming Golden Gate Park. Each is a live box3d
 * ragdoll (its own private world) running the trained policy every frame, drawn
 * as stylized capsules that track the ragdoll exactly — so what you see is the
 * neural net physically walking the body — and topped with a bubble that shows
 * its hidden activations firing, like the creature in the tweet.
 */

const PARK = { x: -3300, z: 1900 }; // a meadow in Golden Gate Park
const ROAM = 75; // metres they wander from the meadow centre
const COUNT = 5;

type HorseMeshes = { group: THREE.Group; parts: THREE.Mesh[]; bubble: THREE.Sprite; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture };
type Horse = {
  rag: HorseRagdoll;
  m: HorseMeshes;
  anchor: { x: number; z: number }; // world XZ the sim origin maps to
  wanderYaw: number;
  wanderTimer: number;
  wx: number; wy: number; wz: number; // last world torso position (for mount picking / seat)
  wq: [number, number, number, number]; // last world torso orientation
};

function partMesh(geo: THREE.BufferGeometry, color: number, rough: number): THREE.Mesh {
  const mat = new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: 0.02 });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

export class HorseHerd {
  #box3d: any;
  #map: WorldMap;
  #scene: THREE.Scene;
  #spec: CreatureSpec = HORSE;
  #policy: Policy | null = null;
  #horses: Horse[] = [];
  #ready = false;
  #nose: [number, number, number] = [0, 0, 0];
  #ridden = -1; // index of the horse the player is riding, or -1
  #steerYaw = 0; // camera yaw the rider is steering the mount toward

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    this.#box3d = physics.box3d;
    this.#map = map;
    this.#scene = scene;
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      const def = (await (await fetch("/models/horse_policy.json", { cache: "no-store" })).json()) as PolicyDef;
      this.#policy = new Policy(def);
      this.#spawn();
      this.#ready = true;
    } catch (e) {
      console.warn("[horse] no trained policy yet (public/models/horse_policy.json) —", e);
    }
  }

  #buildMeshes(): HorseMeshes {
    const s = this.#spec;
    const group = new THREE.Group();
    const parts: THREE.Mesh[] = [];
    // torso (index 0), then thigh+shank per leg (matching ragdoll link order)
    const torso = partMesh(new THREE.BoxGeometry(s.torso.half[0] * 2, s.torso.half[1] * 1.9, s.torso.half[2] * 2), 0x6a4a30, 0.8);
    group.add(torso);
    parts.push(torso);
    // dress the torso into a horse — neck, head, ears, muzzle, tail — as CHILDREN
    // of the torso mesh, so they ride its RL-driven pose for free. Local axes:
    // x = right, y = up, z = forward (nose).
    const neck = partMesh(new THREE.CylinderGeometry(0.07, 0.12, 0.44, 8), 0x5e4028, 0.85);
    neck.position.set(0, 0.24, 0.5);
    neck.rotation.x = -0.95;
    torso.add(neck);
    const head = partMesh(new THREE.BoxGeometry(0.13, 0.16, 0.3), 0x5e4028, 0.85);
    head.position.set(0, 0.44, 0.74);
    head.rotation.x = -0.35;
    torso.add(head);
    const muzzle = partMesh(new THREE.BoxGeometry(0.1, 0.1, 0.14), 0x4a3120, 0.85);
    muzzle.position.set(0, 0.4, 0.9);
    torso.add(muzzle);
    for (const sx of [-0.05, 0.05]) {
      const ear = partMesh(new THREE.ConeGeometry(0.035, 0.1, 6), 0x3b2716, 0.9);
      ear.position.set(sx, 0.56, 0.68);
      torso.add(ear);
    }
    const mane = partMesh(new THREE.BoxGeometry(0.04, 0.3, 0.42), 0x241408, 0.95);
    mane.position.set(0, 0.28, 0.52);
    mane.rotation.x = -0.95;
    torso.add(mane);
    const tail = partMesh(new THREE.CylinderGeometry(0.015, 0.06, 0.44, 6), 0x241408, 0.95);
    tail.position.set(0, 0.16, -0.56);
    tail.rotation.x = 0.7;
    torso.add(tail);
    // legs: thigh + shank capsules, with a dark hoof on each shank
    for (const leg of s.legs) {
      const thigh = partMesh(new THREE.CapsuleGeometry(leg.thigh.radius, leg.thigh.halfHeight * 2, 4, 8), 0x5a3d26, 0.85);
      group.add(thigh);
      parts.push(thigh);
      const shank = partMesh(new THREE.CapsuleGeometry(leg.shank.radius, leg.shank.halfHeight * 2, 4, 8), 0x5a3d26, 0.85);
      const hoof = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.15, leg.shank.radius * 0.9, 0.06, 8), 0x141010, 0.6);
      hoof.position.set(0, -leg.shank.halfHeight - 0.02, 0);
      shank.add(hoof);
      group.add(shank);
      parts.push(shank);
    }
    // NN activation bubble
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const tex = new THREE.CanvasTexture(canvas);
    const bmat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    bmat.colorNode = texture(tex);
    const bubble = new THREE.Sprite(bmat);
    bubble.scale.set(0.9, 0.9, 0.9);
    group.add(bubble);

    this.#scene.add(group);
    return { group, parts, bubble, canvas, tex };
  }

  #spawn(): void {
    for (let i = 0; i < COUNT; i++) {
      const a = (i / COUNT) * Math.PI * 2;
      const r = 20 + Math.random() * (ROAM - 25);
      const anchor = { x: PARK.x + Math.cos(a) * r, z: PARK.z + Math.sin(a) * r };
      const rag = new HorseRagdoll(this.#box3d, this.#spec, this.#policy!);
      const yaw = Math.random() * Math.PI * 2;
      rag.setGoal(Math.sin(yaw), Math.cos(yaw));
      this.#horses.push({ rag, m: this.#buildMeshes(), anchor, wanderYaw: yaw, wanderTimer: 2 + Math.random() * 4, wx: anchor.x, wy: 0, wz: anchor.z, wq: [0, 0, 0, 1] });
    }
  }

  /** Fixed-step: advance each ragdoll's private sim + steer it. */
  prePhysics(dt: number): void {
    if (!this.#ready) return;
    for (let idx = 0; idx < this.#horses.length; idx++) {
      const h = this.#horses[idx];
      // the ridden horse walks where the rider is looking; no autonomous wander
      if (idx === this.#ridden) {
        h.rag.setGoal(-Math.sin(this.#steerYaw), -Math.cos(this.#steerYaw));
        h.rag.update(dt);
        if (h.rag.fallen) h.rag.reset();
        continue;
      }
      // pick a new heading now and then; steer back toward the meadow if it strays
      h.wanderTimer -= dt;
      const t = h.rag.torsoLink;
      const wx = h.anchor.x + t.pos[0];
      const wz = h.anchor.z + t.pos[2];
      const toCx = PARK.x - wx;
      const toCz = PARK.z - wz;
      const distC = Math.hypot(toCx, toCz);
      if (distC > ROAM) {
        h.wanderYaw = Math.atan2(toCx, toCz); // head home
        h.wanderTimer = 2 + Math.random() * 3;
      } else if (h.wanderTimer <= 0) {
        h.wanderYaw += (Math.random() - 0.5) * 1.6;
        h.wanderTimer = 3 + Math.random() * 5;
      }
      h.rag.setGoal(Math.sin(h.wanderYaw), Math.cos(h.wanderYaw));
      h.rag.update(dt);
      if (h.rag.fallen) h.rag.reset();
    }
  }

  #poseMesh(mesh: THREE.Mesh, link: Link, ox: number, oy: number, oz: number): void {
    mesh.position.set(ox + link.pos[0], oy + link.pos[1], oz + link.pos[2]);
    mesh.quaternion.set(link.quat[0], link.quat[1], link.quat[2], link.quat[3]);
  }

  // ------------------------------------------------------------------ riding
  /** Nearest ridable horse within maxDist of a world XZ point, or -1. */
  nearest(px: number, pz: number, maxDist: number): number {
    if (!this.#ready) return -1;
    let best = -1;
    let bd = maxDist * maxDist;
    for (let i = 0; i < this.#horses.length; i++) {
      const h = this.#horses[i];
      const d = (h.wx - px) * (h.wx - px) + (h.wz - pz) * (h.wz - pz);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  mount(i: number): void { if (i >= 0 && i < this.#horses.length) this.#ridden = i; }
  dismount(): void { this.#ridden = -1; }
  get riddenIndex(): number { return this.#ridden; }
  /** Point the mount along the rider's view yaw. */
  steer(yaw: number): void { this.#steerYaw = yaw; }
  /** World seat pose of the ridden horse; false if nobody is mounted. */
  riddenSeat(outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    if (this.#ridden < 0) return false;
    const h = this.#horses[this.#ridden];
    outQuat.set(h.wq[0], h.wq[1], h.wq[2], h.wq[3]);
    outPos.set(h.wx, h.wy + 0.75, h.wz); // seated above the back
    return true;
  }

  /** Per-frame: track the meshes to the ragdoll, lift onto terrain, refresh bubbles. */
  update(_dt: number, camera: THREE.Camera): void {
    if (!this.#ready) return;
    for (const h of this.#horses) {
      const t = h.rag.torsoLink;
      const wx = h.anchor.x + t.pos[0];
      const wz = h.anchor.z + t.pos[2];
      const groundY = this.#map.effectiveGround(wx, wz);
      const ox = h.anchor.x;
      const oy = groundY;
      const oz = h.anchor.z;
      // remember world torso transform (mount picking + rider seat)
      h.wx = ox + t.pos[0]; h.wy = oy + t.pos[1]; h.wz = oz + t.pos[2];
      h.wq[0] = t.quat[0]; h.wq[1] = t.quat[1]; h.wq[2] = t.quat[2]; h.wq[3] = t.quat[3];
      // torso
      this.#poseMesh(h.m.parts[0], t, ox, oy, oz);
      // legs
      const legs = h.rag.legLinks;
      for (let i = 0; i < legs.length; i++) {
        this.#poseMesh(h.m.parts[1 + i * 2], legs[i].thigh, ox, oy, oz);
        this.#poseMesh(h.m.parts[2 + i * 2], legs[i].shank, ox, oy, oz);
      }
      // bubble above the head (nose is +z); a Sprite billboards automatically
      qRot(t.quat, [0, 0, 1], this.#nose);
      h.m.bubble.position.set(ox + t.pos[0] + this.#nose[0] * 0.3, oy + t.pos[1] + 0.9, oz + t.pos[2] + this.#nose[2] * 0.3);
      this.#drawBubble(h.m, h.rag.hidden);
    }
  }

  #drawBubble(m: HorseMeshes, acts: Float32Array): void {
    if (!acts.length) return;
    const g = m.canvas.getContext("2d")!;
    g.clearRect(0, 0, 96, 96);
    g.fillStyle = "rgba(10,14,22,0.55)";
    g.beginPath();
    g.arc(48, 48, 46, 0, 7);
    g.fill();
    const cols = Math.ceil(Math.sqrt(acts.length));
    const rows = Math.ceil(acts.length / cols);
    const cw = 72 / cols, ch = 72 / rows;
    for (let k = 0; k < acts.length; k++) {
      const v = (acts[k] + 1) / 2;
      g.fillStyle = `rgb(${40 + v * 70 | 0},${70 + v * 150 | 0},${100 + v * 150 | 0})`;
      g.fillRect(12 + (k % cols) * cw + 0.5, 12 + ((k / cols) | 0) * ch + 0.5, cw - 1, ch - 1);
    }
    m.tex.needsUpdate = true;
  }
}
