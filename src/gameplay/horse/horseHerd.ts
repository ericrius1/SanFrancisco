import * as THREE from "three/webgpu";
import { BodyType } from "box3d-wasm";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import type { PolicyDef } from "../../creatures/policy";
import { HORSE, type CreatureSpec, type Link } from "../../creatures/quadruped";
import { HorseRagdoll } from "./horseRagdoll";

/**
 * A herd of RL horses roaming a raised grass platform in Golden Gate Park. Each
 * is a live box3d ragdoll (its own private world) running the trained policy
 * every frame, drawn as a dressed-up capsule horse that tracks the ragdoll — so
 * what you see is the neural net physically walking the body — and wearing its
 * live network activations as a glowing lattice of connected nodes overhead,
 * like the creature in the source reference.
 *
 * The terrain here is a steep, flora-choked hill you clip through, so instead of
 * fighting it we float a flat platform above it (visual disc + one static
 * collider) and let the horses AND the rider live on that.
 */

const PARK = { x: -5250, z: 2380 }; // west-end meadow in Golden Gate Park
const PLATFORM_Y = 35; // clears the ~34 m hilltop below
const PLATFORM_R = 85; // room for the whole herd to roam
const ROAM = 78;
const COUNT = 20;
const SCALE = 2.3; // horse-sized vs the ~1.7m human (real horses tower over people)

type Brain = {
  line: THREE.LineSegments;
  colors: Float32Array;
  attr: THREE.BufferAttribute;
  vLayer: Uint8Array; // which activation layer each vertex belongs to
  vNode: Uint16Array; // which node within that layer
};
type HorseMeshes = { group: THREE.Group; parts: THREE.Mesh[]; brain: Brain };
type Horse = {
  rag: HorseRagdoll;
  m: HorseMeshes;
  anchor: { x: number; z: number };
  wanderYaw: number;
  wanderTimer: number;
  wx: number; wy: number; wz: number;
  wq: [number, number, number, number];
};

function partMesh(geo: THREE.BufferGeometry, color: number, rough: number): THREE.Mesh {
  const mat = new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: 0.02 });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

export class HorseHerd {
  #box3d: any;
  #world: any;
  #scene: THREE.Scene;
  #spec: CreatureSpec = HORSE;
  #policyDef: PolicyDef | null = null;
  #horses: Horse[] = [];
  #ready = false;
  #ridden = -1;
  #steerYaw = 0;
  #camPos = new THREE.Vector3();
  #worker: Worker | null = null;
  #training = false;
  #onProgress: ((p: { gen: number; fitness: number; best: number }) => void) | null = null;

  constructor(physics: Physics, _map: WorldMap, scene: THREE.Scene) {
    this.#box3d = physics.box3d;
    this.#world = physics.world;
    this.#scene = scene;
    this.#buildPlatform();
    void this.#load();
  }

  get platformY(): number { return PLATFORM_Y; }
  get center(): { x: number; z: number } { return PARK; }
  /** Is (x,z) over the horse platform? (for placing the rider on it) */
  onPlatform(x: number, z: number): boolean {
    return (x - PARK.x) * (x - PARK.x) + (z - PARK.z) * (z - PARK.z) < PLATFORM_R * PLATFORM_R;
  }

  #buildPlatform(): void {
    // one static collider so the rider stands on the flat top
    this.#world.createBox({
      type: BodyType.Static,
      position: [PARK.x, PLATFORM_Y - 1.5, PARK.z],
      halfExtents: [PLATFORM_R, 1.5, PLATFORM_R],
      friction: 0.9
    });
    // grass disc + a soft darker rim so the mesa reads
    const grass = new THREE.Mesh(new THREE.CircleGeometry(PLATFORM_R, 64), new THREE.MeshStandardNodeMaterial({ color: 0x51702f, roughness: 0.95 }));
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(PARK.x, PLATFORM_Y + 0.02, PARK.z);
    grass.receiveShadow = true;
    this.#scene.add(grass);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(PLATFORM_R, PLATFORM_R * 0.98, 3, 64, 1, true), new THREE.MeshStandardNodeMaterial({ color: 0x3c5222, roughness: 1 }));
    rim.position.set(PARK.x, PLATFORM_Y - 1.5, PARK.z);
    this.#scene.add(rim);
  }

  async #load(): Promise<void> {
    try {
      this.#policyDef = (await (await fetch("/models/horse_policy.json", { cache: "no-store" })).json()) as PolicyDef;
      this.#spawn();
      this.#ready = true;
    } catch (e) {
      console.warn("[horse] no trained policy yet (public/models/horse_policy.json) —", e);
    }
  }

  #buildDressedHorse(): THREE.Mesh[] {
    const s = this.#spec;
    const parts: THREE.Mesh[] = [];
    const torso = partMesh(new THREE.BoxGeometry(s.torso.half[0] * 2, s.torso.half[1] * 1.9, s.torso.half[2] * 2), 0x6a4a30, 0.8);
    torso.scale.setScalar(SCALE); // base geometry, scaled to horse size; children (neck/head/…) inherit
    parts.push(torso);
    // neck, head, ears, muzzle, mane, tail — children of the torso mesh so they
    // ride its RL pose. Local axes: x = right, y = up, z = forward (nose).
    const neck = partMesh(new THREE.CylinderGeometry(0.07, 0.12, 0.44, 8), 0x5e4028, 0.85);
    neck.position.set(0, 0.24, 0.5); neck.rotation.x = -0.95; torso.add(neck);
    const head = partMesh(new THREE.BoxGeometry(0.13, 0.16, 0.3), 0x5e4028, 0.85);
    head.position.set(0, 0.44, 0.74); head.rotation.x = -0.35; torso.add(head);
    const muzzle = partMesh(new THREE.BoxGeometry(0.1, 0.1, 0.14), 0x4a3120, 0.85);
    muzzle.position.set(0, 0.4, 0.9); torso.add(muzzle);
    for (const sx of [-0.05, 0.05]) {
      const ear = partMesh(new THREE.ConeGeometry(0.035, 0.1, 6), 0x3b2716, 0.9);
      ear.position.set(sx, 0.56, 0.68); torso.add(ear);
    }
    const mane = partMesh(new THREE.BoxGeometry(0.04, 0.3, 0.42), 0x241408, 0.95);
    mane.position.set(0, 0.28, 0.52); mane.rotation.x = -0.95; torso.add(mane);
    const tail = partMesh(new THREE.CylinderGeometry(0.015, 0.06, 0.44, 6), 0x241408, 0.95);
    tail.position.set(0, 0.16, -0.56); tail.rotation.x = 0.7; torso.add(tail);
    for (const leg of s.legs) {
      const thigh = partMesh(new THREE.CapsuleGeometry(leg.thigh.radius, leg.thigh.halfHeight * 2, 4, 8), 0x5a3d26, 0.85);
      thigh.scale.setScalar(SCALE);
      parts.push(thigh);
      const shank = partMesh(new THREE.CapsuleGeometry(leg.shank.radius, leg.shank.halfHeight * 2, 4, 8), 0x5a3d26, 0.85);
      shank.scale.setScalar(SCALE);
      const hoof = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.15, leg.shank.radius * 0.9, 0.06, 8), 0x141010, 0.6);
      hoof.position.set(0, -leg.shank.halfHeight - 0.02, 0); shank.add(hoof);
      parts.push(shank);
    }
    return parts;
  }

  /**
   * The activation "brain": layers of nodes as vertical columns, joined by soft
   * additive lines (each node to its neighbours + a couple in the next layer),
   * so the live activations drape into glowing sheets like the reference. Fixed
   * geometry; only per-vertex colour changes each frame.
   */
  #buildBrain(sizes: number[]): Brain {
    const GAP = 0.42; // spacing between layer columns
    const HEIGHT = 1.05;
    const nL = sizes.length;
    const nodeY = (li: number, j: number) => (sizes[li] <= 1 ? 0 : (j / (sizes[li] - 1) - 0.5) * HEIGHT);
    const nodeX = (li: number) => (li - (nL - 1) / 2) * GAP;
    const pos: number[] = [];
    const vLayer: number[] = [];
    const vNode: number[] = [];
    const addVert = (li: number, j: number) => { pos.push(nodeX(li), nodeY(li, j), 0); vLayer.push(li); vNode.push(j); };
    for (let li = 0; li < nL; li++) {
      // vertical intra-layer lines (the "dotted sheet" texture)
      for (let j = 0; j + 1 < sizes[li]; j++) { addVert(li, j); addVert(li, j + 1); }
      // inter-layer connections: each node to two nodes in the next column
      if (li + 1 < nL) {
        const n = sizes[li], m = sizes[li + 1];
        for (let j = 0; j < n; j++) {
          const b = m <= 1 ? 0 : Math.round((j * (m - 1)) / Math.max(1, n - 1));
          addVert(li, j); addVert(li + 1, b);
          addVert(li, j); addVert(li + 1, Math.min(m - 1, b + 1));
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    const posArr = new Float32Array(pos);
    const colArr = new Float32Array(posArr.length);
    geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    const attr = new THREE.BufferAttribute(colArr, 3);
    geo.setAttribute("color", attr);
    const mat = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const line = new THREE.LineSegments(geo, mat);
    line.frustumCulled = false;
    line.scale.setScalar(SCALE); // brain lattice sized to the (scaled) horse
    return { line, colors: colArr, attr, vLayer: Uint8Array.from(vLayer), vNode: Uint16Array.from(vNode) };
  }

  #buildMeshes(sizes: number[]): HorseMeshes {
    const group = new THREE.Group();
    const parts = this.#buildDressedHorse();
    for (const p of parts) group.add(p);
    const brain = this.#buildBrain(sizes);
    this.#scene.add(group);
    this.#scene.add(brain.line);
    return { group, parts, brain };
  }

  #spawn(): void {
    for (let i = 0; i < COUNT; i++) {
      const a = (i / COUNT) * Math.PI * 2 + Math.random();
      const r = 6 + Math.random() * (ROAM - 8);
      const anchor = { x: PARK.x + Math.cos(a) * r, z: PARK.z + Math.sin(a) * r };
      const rag = new HorseRagdoll(this.#box3d, this.#spec, this.#policyDef!, SCALE);
      const yaw = Math.random() * Math.PI * 2;
      rag.setGoal(Math.sin(yaw), Math.cos(yaw));
      const m = this.#buildMeshes(rag.layers().map((l) => l.length));
      this.#horses.push({ rag, m, anchor, wanderYaw: yaw, wanderTimer: 2 + Math.random() * 4, wx: anchor.x, wy: PLATFORM_Y, wz: anchor.z, wq: [0, 0, 0, 1] });
    }
  }

  prePhysics(dt: number): void {
    if (!this.#ready) return;
    for (let idx = 0; idx < this.#horses.length; idx++) {
      const h = this.#horses[idx];
      if (idx === this.#ridden) {
        h.rag.setGoal(-Math.sin(this.#steerYaw), -Math.cos(this.#steerYaw));
        h.rag.update(dt);
        if (h.rag.fallen) h.rag.reset();
        continue;
      }
      h.wanderTimer -= dt;
      const t = h.rag.torsoLink;
      const wx = h.anchor.x + t.pos[0];
      const wz = h.anchor.z + t.pos[2];
      const toCx = PARK.x - wx;
      const toCz = PARK.z - wz;
      if (Math.hypot(toCx, toCz) > ROAM) {
        h.wanderYaw = Math.atan2(toCx, toCz);
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
  steer(yaw: number): void { this.#steerYaw = yaw; }
  riddenSeat(outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    if (this.#ridden < 0) return false;
    const h = this.#horses[this.#ridden];
    outQuat.set(h.wq[0], h.wq[1], h.wq[2], h.wq[3]);
    outPos.set(h.wx, h.wy + 0.75 * SCALE, h.wz);
    return true;
  }

  // -------------------------------------------------------------- live training
  get training(): boolean { return this.#training; }
  /** Kick off ES training in a worker; the herd hot-swaps to the improving policy live. */
  startTraining(onProgress: (p: { gen: number; fitness: number; best: number }) => void): void {
    if (this.#training) return;
    this.#training = true;
    this.#onProgress = onProgress;
    this.#worker = new Worker(new URL("./trainWorker.ts", import.meta.url), { type: "module" });
    this.#worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; gen: number; fitness: number; best: number; policy: PolicyDef };
      if (m?.type !== "progress") return;
      this.#applyPolicy(m.policy); // watch the horses change as the brain improves
      this.#onProgress?.({ gen: m.gen, fitness: m.fitness, best: m.best });
    };
    this.#worker.postMessage({ type: "start", creature: "horse", init: this.#policyDef ?? undefined });
  }
  stopTraining(): void {
    if (!this.#training) return;
    this.#training = false;
    this.#worker?.postMessage({ type: "stop" });
    this.#worker?.terminate();
    this.#worker = null;
  }
  #applyPolicy(def: PolicyDef): void {
    this.#policyDef = def;
    for (const h of this.#horses) h.rag.setPolicy(def);
  }

  /** Per-frame: track the meshes to the ragdolls (on the platform) + light up the brains. */
  update(_dt: number, camera: THREE.Camera): void {
    if (!this.#ready) return;
    camera.getWorldPosition(this.#camPos);
    for (const h of this.#horses) {
      const t = h.rag.torsoLink;
      const ox = h.anchor.x;
      const oy = PLATFORM_Y; // flat platform — no terrain query
      const oz = h.anchor.z;
      h.wx = ox + t.pos[0]; h.wy = oy + t.pos[1]; h.wz = oz + t.pos[2];
      h.wq[0] = t.quat[0]; h.wq[1] = t.quat[1]; h.wq[2] = t.quat[2]; h.wq[3] = t.quat[3];
      this.#poseMesh(h.m.parts[0], t, ox, oy, oz);
      const legs = h.rag.legLinks;
      for (let i = 0; i < legs.length; i++) {
        this.#poseMesh(h.m.parts[1 + i * 2], legs[i].thigh, ox, oy, oz);
        this.#poseMesh(h.m.parts[2 + i * 2], legs[i].shank, ox, oy, oz);
      }
      this.#updateBrain(h);
    }
  }

  #updateBrain(h: Horse): void {
    const b = h.m.brain;
    const layers = h.rag.layers();
    const c = b.colors;
    for (let v = 0; v < b.vLayer.length; v++) {
      const a = layers[b.vLayer[v]][b.vNode[v]];
      const tt = a < -1 ? 0 : a > 1 ? 1 : (a + 1) / 2; // tanh -> 0..1
      const k = 0.06 + tt * tt * 0.9; // dim resting units, bloom the firing ones
      const i3 = v * 3;
      c[i3] = (0.45 + tt * 0.45) * k;
      c[i3 + 1] = (0.12 + tt * 0.35) * k;
      c[i3 + 2] = (0.6 + tt * 0.4) * k;
    }
    b.attr.needsUpdate = true;
    // float above the horse, billboard to the camera on yaw
    const yaw = Math.atan2(this.#camPos.x - h.wx, this.#camPos.z - h.wz);
    b.line.position.set(h.wx, h.wy + 1.5 * SCALE, h.wz);
    b.line.rotation.set(0, yaw, 0);
  }
}
