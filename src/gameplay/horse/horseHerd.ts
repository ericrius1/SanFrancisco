import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { Physics } from "../../core/physics";
import { BodyType } from "../../core/box3dWorld";
import type { WorldMap } from "../../world/heightmap";
import { GARDEN_MEADOW, gardenSurfaceHeight } from "../../world/garden/layout";
import { BrainOverlay } from "../aiCars/brainOverlay";
import type { InspectableBrain } from "../../ui/brainPanel/types";

type Gait = "walk" | "trot" | "gallop";
type PolicyDef = { sizes: number[]; weights: number[]; meta?: Record<string, unknown> };
type ObstacleKind = "cone" | "hurdle";
type Obstacle = { x: number; z: number; y: number; radius: number; height: number; kind: ObstacleKind; mesh: THREE.Object3D };
type LegRig = {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  knee: THREE.Mesh;
  hoof: THREE.Mesh;
  side: number;
  fore: number;
};
type HorseVariant = {
  scale: number;
  coat: number;
  mane: number;
  muzzle: number;
  blanket: number;
  harness: number;
  sockMask: number;
  blaze: boolean;
  patches: number;
};
type HorseState = {
  group: THREE.Group;
  body: THREE.Group;
  legs: LegRig[];
  mane: THREE.Mesh[];
  tail: THREE.Mesh[];
  variant: HorseVariant;
  phase: number;
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  vy: number;
  heading: number;
  roll: number;
  pitch: number;
  speed: number;
  targetSpeed: number;
  routeAngle: number;
  routeRadius: number;
  routeDir: number;
  gait: Gait;
  action: Float32Array;
  contacts: boolean[];
  jumpCooldown: number;
  jumpCount: number;
  maxAir: number;
  // Per-horse snapshots for the floating brain lattice: the shared #obs and
  // #policy.layerOut buffers are overwritten each horse in the sim loop, so we
  // copy this horse's activations here for the render-frame overlay to read.
  obsSnap: Float32Array;
  layerSnap: Float32Array[];
};

class RuntimePolicy {
  readonly sizes: number[];
  readonly layerOut: Float32Array[] = [];
  #weights: Float32Array[] = [];
  #biases: Float32Array[] = [];

  constructor(def: PolicyDef) {
    this.sizes = def.sizes.slice();
    let k = 0;
    for (let l = 0; l < this.sizes.length - 1; l++) {
      const ins = this.sizes[l];
      const outs = this.sizes[l + 1];
      const w = new Float32Array(ins * outs);
      for (let i = 0; i < w.length; i++) w[i] = def.weights[k++] ?? 0;
      const b = new Float32Array(outs);
      for (let i = 0; i < b.length; i++) b[i] = def.weights[k++] ?? 0;
      this.#weights.push(w);
      this.#biases.push(b);
      this.layerOut.push(new Float32Array(outs));
    }
  }

  forward(input: ArrayLike<number>): Float32Array {
    let x: ArrayLike<number> = input;
    for (let l = 0; l < this.#weights.length; l++) {
      const w = this.#weights[l];
      const b = this.#biases[l];
      const out = this.layerOut[l];
      const ins = this.sizes[l];
      const outs = this.sizes[l + 1];
      for (let o = 0; o < outs; o++) {
        let s = b[o];
        const row = o * ins;
        for (let i = 0; i < ins; i++) s += w[row + i] * x[i];
        out[o] = Math.tanh(s);
      }
      x = out;
    }
    return this.layerOut[this.layerOut.length - 1];
  }

  getParams(): Float32Array {
    let n = 0;
    for (let i = 0; i < this.#weights.length; i++) n += this.#weights[i].length + this.#biases[i].length;
    const out = new Float32Array(n);
    let k = 0;
    for (let i = 0; i < this.#weights.length; i++) {
      out.set(this.#weights[i], k);
      k += this.#weights[i].length;
      out.set(this.#biases[i], k);
      k += this.#biases[i].length;
    }
    return out;
  }
}

const CENTER = { x: GARDEN_MEADOW.x, z: GARDEN_MEADOW.z };
const ROAM_RX = 92;
const ROAM_RZ = 66;
const ROAM_R = 68;
const COUNT = 21;
const BODY_H = 1.5;
const OBS_DIM = 31;
const SIM_RANGE = 420;
// Herd MESH visibility gate. The horses (~40 meshes each) + course props sit at
// the meadow and otherwise render from across the city whenever the meadow falls
// in the frustum (like the garden's far trees) — waste past the fog. Hidden past
// ~600 m, comfortably outside SIM_RANGE so a horse is never frozen-yet-visible up
// close; ~100 m hysteresis so it doesn't flicker at the boundary.
const MESH_HIDE_RANGE = 600;
const MESH_SHOW_RANGE = 500;
const UP = new THREE.Vector3(0, 1, 0);

const WALK = [0.0, 0.5, 0.25, 0.75];
const TROT = [0.0, 0.5, 0.5, 0.0];
const GALLOP = [0.0, 0.12, 0.58, 0.7];
const GAIT_SPEEDS: Record<Gait, number> = {
  walk: 1.35,
  trot: 2.75,
  gallop: 4.55
};

const OVERLAY_RANGE = 140; // metres: horses within this get a live brain lattice
const OVERLAY_LIFT = 0.7; // metres above the head the lattice floats

// Human-readable names for the 31 observation inputs (see #observe order) and
// the 7 policy outputs (see #updateHorse action usage). Shown in the inspector.
const HORSE_INPUT_LABELS = [
  "tgt speed", "speed", "speed err", "sin Δhead", "cos Δhead",
  "height", "v vert", "roll", "pitch", "—", "—", "Δheading",
  "gait sin", "gait cos", "contact 0", "contact 1", "contact 2", "contact 3",
  "obs dist", "obs bearing", "obs height", "obs near", "obs lateral",
  "is walk", "is trot", "is gallop", "bias", "obs hurdle", "obs cone",
  "lane z", "arena r"
];
const HORSE_OUTPUT_LABELS = ["cadence", "stride", "lift", "steer", "jump", "roll", "pitch"];
const ACT_DIM = HORSE_OUTPUT_LABELS.length;

const COATS = [0x8d5a31, 0x4b2f20, 0xb47a43, 0xd2b78a, 0x2a211d, 0x9b6a4a, 0x6b4029, 0xc08a5a] as const;
const MANES = [0x21140d, 0x120f0c, 0x332016, 0xe8d4ab, 0x2a1b14] as const;
const BLANKETS = [0x1a8f96, 0xd85a2e, 0x2657b8, 0x8b2db7, 0xdfad1f, 0x2f9b57, 0xc73955] as const;
const HARNESSES = [0x2f1c13, 0x4a2a18, 0x1c2433, 0x3c2116, 0x101010] as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function wrapPi(v: number): number {
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}
function fract(v: number): number {
  return v - Math.floor(v);
}
function rand01(index: number, salt: number): number {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453123;
  return x - Math.floor(x);
}
function pick<T>(items: readonly T[], index: number, salt: number): T {
  return items[Math.floor(rand01(index, salt) * items.length) % items.length];
}
function mesh(geo: THREE.BufferGeometry, material: THREE.Material, cast = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
function mat(color: number, roughness = 0.72, emissive = 0.015): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness: 0.03,
    emissive: new THREE.Color(color).multiplyScalar(0.16),
    emissiveIntensity: emissive * LIGHT_SCALE
  });
}
function putCylinderBetween(cyl: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  const mid = cyl.position;
  mid.copy(a).add(b).multiplyScalar(0.5);
  const d = b.clone().sub(a);
  const len = Math.max(0.001, d.length());
  cyl.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / len));
  cyl.scale.y = len;
}

export class HorseHerd {
  #world = null as Physics["world"] | null;
  #map: WorldMap;
  #scene: THREE.Scene;
  #policy: RuntimePolicy | null = null;
  #overlay: BrainOverlay | null = null;
  #overlaysOn = true;
  #camera: THREE.Camera | null = null;
  #worldPos = new THREE.Vector3();
  #obs = new Float32Array(OBS_DIM);
  #horses: HorseState[] = [];
  #obstacles: Obstacle[] = [];
  #jumps: { x: number; z: number; y: number; height: number }[] = [];
  #tmpA = new THREE.Vector3();
  #tmpB = new THREE.Vector3();
  #tmpC = new THREE.Vector3();
  #forceSpeed: number | null = null;
  #ready = false;
  #active = false;
  #meshesShown = true;
  #inspectableCache: (InspectableBrain | null)[] = []; // one InspectableBrain per horse index, built once and reused
  #inspectableOut: InspectableBrain[] = []; // reused output array for inspectables() (length reset each call)

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    this.#world = physics.world;
    this.#map = map;
    this.#scene = scene;
    this.#buildCourse();
    this.#spawnHerd();
    this.#ready = true;
    void this.#loadPolicy();
  }

  get center(): { x: number; z: number } { return CENTER; }
  get count(): number { return this.#horses.length; }
  get active(): boolean { return this.#active; }
  get jumps(): { x: number; z: number; y: number; height: number }[] { return this.#jumps; }

  /**
   * This runs every frame the world cursor is live (main.ts pickBrain), so it
   * must not allocate: each horse's descriptor is built once (#buildInspectable)
   * and cached by index — horses are a fixed-size, never-recreated array whose
   * obsSnap/policy are mutated in place, so the cached closures always read live
   * state without needing to be rebuilt. The result is written into the reused
   * #inspectableOut array instead of a fresh array per call.
   */
  inspectables(): InspectableBrain[] {
    const overlay = this.#overlay;
    const policy = this.#policy;
    const out = this.#inspectableOut;
    out.length = 0;
    if (!overlay || !policy) return out;
    for (let i = 0; i < this.#horses.length; i++) {
      if (!overlay.isShown(i)) continue;
      let brain = this.#inspectableCache[i];
      if (!brain) {
        brain = this.#buildInspectable(i, this.#horses[i], policy);
        this.#inspectableCache[i] = brain;
      }
      out.push(brain);
    }
    return out;
  }

  /** Builds one horse's InspectableBrain descriptor ONCE (lazily, first time
   * it's shown). `h` is a stable per-index object for the whole app life; its
   * obsSnap is always mutated in place (never reassigned), so this closure
   * stays correct forever without rebuilding. */
  #buildInspectable(i: number, h: HorseState, policy: RuntimePolicy): InspectableBrain {
    return {
      id: `horse:${i}`,
      label: `RL Horse #${i}`,
      getWorldPos: (o) => this.#latticePos(h, o),
      pickRadius: 1.3,
      net: policy,
      liveObs: () => h.obsSnap,
      inputLabels: HORSE_INPUT_LABELS,
      outputLabels: HORSE_OUTPUT_LABELS
    };
  }

  debugStates(): {
    upY: number;
    tall: number;
    down: number;
    fallen: boolean;
    speed: number;
    wx: number;
    wz: number;
    wy: number;
    x: number;
    z: number;
    y: number;
    gait: Gait;
    targetSpeed: number;
    heading: number;
    vx: number;
    vz: number;
    forwardAlignment: number;
    jumps: number;
    maxAir: number;
    scale: number;
  }[] {
    return this.#horses.map((h) => {
      const wx = CENTER.x + h.x;
      const wz = CENTER.z + h.z;
      const groundY = this.#groundAt(h.x, h.z);
      const sp = Math.hypot(h.vx, h.vz);
      const forwardAlignment = sp > 0.001 ? (Math.cos(h.heading) * h.vx + Math.sin(h.heading) * h.vz) / sp : 1;
      return {
        upY: Math.max(0, 1 - Math.abs(h.roll) * 0.4 - Math.abs(h.pitch) * 0.3),
        tall: h.y / BODY_H,
        down: 0,
        fallen: false,
        speed: h.speed,
        wx,
        wz,
        wy: groundY + h.y,
        x: wx,
        z: wz,
        y: groundY + h.y,
        gait: h.gait,
        targetSpeed: h.targetSpeed,
        heading: h.heading,
        vx: h.vx,
        vz: h.vz,
        forwardAlignment,
        jumps: h.jumpCount,
        maxAir: h.maxAir,
        scale: h.variant.scale
      };
    });
  }

  debugJumpAll(): void {
    for (const h of this.#horses) this.#launchJump(h, 0.95);
  }

  debugForceSpeed(speed: number | null): void {
    this.#forceSpeed = speed;
  }

  debugStageJump(): { index: number; x: number; z: number; heading: number; hurdle: { x: number; z: number; height: number } | null } {
    const index = Math.max(0, this.#horses.findIndex((h) => h.gait === "gallop"));
    const h = this.#horses[index] ?? this.#horses[0];
    const hurdle = this.#obstacles.find((o) => o.kind === "hurdle") ?? null;
    if (!h) return { index: 0, x: CENTER.x, z: CENTER.z, heading: 0, hurdle: null };
    const routeRadius = hurdle ? Math.hypot(hurdle.x, hurdle.z) : 47;
    const hurdleAngle = hurdle ? Math.atan2(hurdle.z, hurdle.x) : 0.75;
    const angle = hurdleAngle - 0.08;
    h.routeRadius = routeRadius;
    h.routeDir = 1;
    h.x = Math.cos(angle) * h.routeRadius;
    h.z = Math.sin(angle) * h.routeRadius;
    h.y = BODY_H;
    h.vy = 0;
    h.heading = angle + Math.PI / 2;
    h.speed = GAIT_SPEEDS.gallop;
    h.targetSpeed = GAIT_SPEEDS.gallop;
    h.gait = "gallop";
    h.phase = 0.08;
    h.jumpCooldown = 0;
    h.jumpCount = 0;
    h.maxAir = 0;
    h.vx = Math.cos(h.heading) * h.speed;
    h.vz = Math.sin(h.heading) * h.speed;
    this.#poseHorse(h, 2.2, 1.02, h.action, this.#nearestObstacle(h));
    return {
      index,
      x: CENTER.x + h.x,
      z: CENTER.z + h.z,
      heading: h.heading,
      hurdle: hurdle ? { x: CENTER.x + hurdle.x, z: CENTER.z + hurdle.z, height: hurdle.height } : null
    };
  }

  async #loadPolicy(): Promise<void> {
    try {
      const def = (await (await fetch("/models/horse_rl_policy.json", { cache: "no-store" })).json()) as PolicyDef;
      if (def.sizes?.[0] === OBS_DIM && def.weights?.length) {
        const policy = new RuntimePolicy(def);
        this.#policy = policy;
        this.#buildOverlay(policy);
      } else console.warn("[horse] horse_rl_policy.json has an unexpected shape", def.sizes);
    } catch (e) {
      console.warn("[horse] Codex horse policy unavailable; using procedural fallback", e);
    }
  }

  /**
   * Give each horse its floating neural-net lattice (reusing the AI-car
   * BrainOverlay) and allocate the per-horse activation snapshot buffers now that
   * the policy — and thus the layer sizes — is known. On by default.
   */
  #buildOverlay(policy: RuntimePolicy): void {
    for (const h of this.#horses) h.layerSnap = policy.layerOut.map((l) => new Float32Array(l.length));
    const overlay = new BrainOverlay(this.#scene, policy.sizes, this.#horses.length, () => this.#camera as THREE.Camera);
    overlay.setEnabled(this.#overlaysOn);
    this.#overlay = overlay;
  }

  #groundAt(x: number, z: number): number {
    return gardenSurfaceHeight(this.#map, CENTER.x + x, CENTER.z + z);
  }

  #buildCourse(): void {
    const coneMat = mat(0xf36c37, 0.62, 0.012);
    const coneStripeMat = mat(0xf5d7a4, 0.6, 0.012);
    const hurdleMat = mat(0xddd08c, 0.6, 0.014);
    const postMat = mat(0x7a5736, 0.78, 0.01);
    const coneGeo = new THREE.ConeGeometry(0.65, 1.25, 16);
    const coneStripeGeo = new THREE.CylinderGeometry(0.5, 0.57, 0.08, 16, 1, true);
    const railGeo = new THREE.BoxGeometry(3.4, 0.14, 0.16);
    const postGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.86, 8);

    for (let i = 0; i < 7; i++) {
      const a = i * 0.9 + 0.35;
      const r = 25 + (i % 3) * 9;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.#groundAt(x, z);
      const obj = new THREE.Group();
      const cone = mesh(coneGeo, coneMat);
      cone.position.y = 0.62;
      const stripe = mesh(coneStripeGeo, coneStripeMat, false);
      stripe.position.y = 0.42;
      obj.add(cone, stripe);
      obj.position.set(CENTER.x + x, y + 0.02, CENTER.z + z);
      this.#scene.add(obj);
      this.#obstacles.push({ x, z, y, radius: 2.4, height: 1.25, kind: "cone", mesh: obj });
      this.#world?.createBox({
        type: BodyType.Static,
        position: [CENTER.x + x, y + 0.45, CENTER.z + z],
        halfExtents: [0.45, 0.45, 0.45],
        friction: 0.8
      });
    }

    for (let i = 0; i < 5; i++) {
      const a = i * 1.22 + 0.75;
      const r = 45 + (i % 2) * 5;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.#groundAt(x, z);
      const obj = new THREE.Group();
      const rail = mesh(railGeo, hurdleMat);
      rail.position.y = 0.9;
      const lowRail = mesh(railGeo, mat(i % 2 ? 0xc0392b : 0xf4f1e8, 0.55, 0.012));
      lowRail.position.y = 0.58;
      const p1 = mesh(postGeo, postMat);
      const p2 = mesh(postGeo, postMat);
      p1.position.set(-1.62, 0.43, 0);
      p2.position.set(1.62, 0.43, 0);
      obj.add(rail, lowRail, p1, p2);
      obj.position.set(CENTER.x + x, y + 0.02, CENTER.z + z);
      obj.rotation.y = -a + Math.PI / 2;
      this.#scene.add(obj);
      this.#obstacles.push({ x, z, y, radius: 2.9, height: 0.9, kind: "hurdle", mesh: obj });
      this.#jumps.push({ x: CENTER.x + x, z: CENTER.z + z, y, height: 0.9 });
      const ax = Math.cos(obj.rotation.y);
      const az = Math.sin(obj.rotation.y);
      this.#world?.createBox({
        type: BodyType.Static,
        position: [CENTER.x + x, y + 0.48, CENTER.z + z],
        halfExtents: [Math.abs(ax) * 1.85 + 0.22, 0.5, Math.abs(az) * 1.85 + 0.22],
        friction: 0.6
      });
    }
  }

  #spawnHerd(): void {
    const hurdleAngles = [0.75, 2.17, 3.59, 5.01];
    for (let i = 0; i < COUNT; i++) {
      const gait: Gait = i % 5 === 0 || i % 7 === 0 ? "gallop" : i % 3 === 0 ? "trot" : "walk";
      const targetSpeed = GAIT_SPEEDS[gait];
      const r = gait === "gallop" ? 46 + (i % 2) * 2.5 : gait === "trot" ? 35 + (i % 3) * 2.2 : 22 + (i % 4) * 2.6;
      const a = gait === "gallop" ? hurdleAngles[i % hurdleAngles.length] - 0.11 - (i % 2) * 0.04 : (i / COUNT) * Math.PI * 2;
      const variant = this.#variant(i);
      const group = this.#buildHorse(variant);
      const body = group.userData.body as THREE.Group;
      const h: HorseState = {
        group,
        body,
        legs: group.userData.legs as LegRig[],
        mane: group.userData.mane as THREE.Mesh[],
        tail: group.userData.tail as THREE.Mesh[],
        variant,
        phase: rand01(i, 11),
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        y: BODY_H,
        vx: 0,
        vz: 0,
        vy: 0,
        heading: a + Math.PI * 0.5,
        roll: 0,
        pitch: 0,
        speed: 0,
        targetSpeed,
        routeAngle: a,
        routeRadius: r,
        routeDir: rand01(i, 13) < 0.18 ? -1 : 1,
        gait,
        action: new Float32Array(ACT_DIM),
        contacts: [true, true, true, true],
        jumpCooldown: 0,
        jumpCount: 0,
        maxAir: 0,
        obsSnap: new Float32Array(OBS_DIM),
        layerSnap: []
      };
      this.#horses.push(h);
      this.#scene.add(group);
      this.#poseHorse(h, gait === "gallop" ? 2.1 : gait === "trot" ? 1.55 : 0.9, gait === "gallop" ? 1 : 0.65, h.action, null);
    }
  }

  #variant(i: number): HorseVariant {
    return {
      scale: 1.02 + rand01(i, 1) * 0.32,
      coat: pick(COATS, i, 2),
      mane: pick(MANES, i, 3),
      muzzle: rand01(i, 4) < 0.55 ? 0x6c4630 : 0x3b2a23,
      blanket: pick(BLANKETS, i, 5),
      harness: pick(HARNESSES, i, 6),
      sockMask: Math.floor(rand01(i, 7) * 16),
      blaze: rand01(i, 8) < 0.55,
      patches: Math.floor(rand01(i, 9) * 4)
    };
  }

  #buildHorse(variant: HorseVariant): THREE.Group {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const coat = mat(variant.coat, 0.74, 0.015);
    const dark = mat(variant.mane, 0.88, 0.01);
    const hoofMat = mat(0x11100e, 0.6, 0.006);
    const sockMat = mat(0xe6d1b7, 0.68, 0.01);
    const muzzleMat = mat(variant.muzzle, 0.78, 0.01);
    const tackMat = mat(variant.harness, 0.5, 0.008);
    const blanketMat = mat(variant.blanket, 0.45, 0.02);
    const blazeMat = mat(0xf2e3c4, 0.72, 0.01);

    const torso = mesh(new THREE.CapsuleGeometry(0.42, 1.65, 8, 14), coat);
    torso.rotation.z = Math.PI / 2;
    torso.scale.set(1.12, 1, 0.78);
    torso.position.y = 1.42;
    body.add(torso);

    const chest = mesh(new THREE.SphereGeometry(0.45, 16, 12), coat);
    chest.scale.set(0.82, 1.0, 0.8);
    chest.position.set(0.88, 1.43, 0);
    body.add(chest);

    const rump = mesh(new THREE.SphereGeometry(0.47, 16, 12), coat);
    rump.scale.set(0.9, 0.92, 0.82);
    rump.position.set(-1.0, 1.4, 0);
    body.add(rump);

    for (let i = 0; i < variant.patches; i++) {
      const patch = mesh(new THREE.SphereGeometry(0.18 + rand01(i, variant.coat) * 0.08, 10, 8), blazeMat);
      patch.scale.set(1.0, 0.12, 0.75);
      patch.position.set(-0.65 + i * 0.48, 1.55 + rand01(i, 20) * 0.12, (i % 2 ? -1 : 1) * 0.39);
      patch.rotation.x = Math.PI / 2;
      body.add(patch);
    }

    const neck = mesh(new THREE.CylinderGeometry(0.18, 0.26, 0.9, 12), coat);
    neck.position.set(1.18, 1.92, 0);
    neck.rotation.z = -0.62;
    body.add(neck);

    const head = mesh(new THREE.BoxGeometry(0.62, 0.34, 0.36), coat);
    head.position.set(1.72, 2.16, 0);
    head.rotation.z = -0.16;
    body.add(head);

    const muzzle = mesh(new THREE.BoxGeometry(0.3, 0.22, 0.31), muzzleMat);
    muzzle.position.set(2.05, 2.08, 0);
    body.add(muzzle);

    if (variant.blaze) {
      const blaze = mesh(new THREE.BoxGeometry(0.045, 0.24, 0.025), blazeMat, false);
      blaze.position.set(1.98, 2.22, 0);
      blaze.rotation.z = -0.12;
      body.add(blaze);
    }

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffefb0 });
    eyeMat.toneMapped = false;
    for (const z of [-0.19, 0.19]) {
      const eye = mesh(new THREE.SphereGeometry(0.035, 8, 6), eyeMat, false);
      eye.position.set(1.92, 2.22, z);
      body.add(eye);
      const nostril = mesh(new THREE.SphereGeometry(0.018, 6, 5), new THREE.MeshBasicMaterial({ color: 0x090807 }), false);
      nostril.position.set(2.18, 2.1, z * 0.52);
      body.add(nostril);
      const ear = mesh(new THREE.ConeGeometry(0.08, 0.24, 6), dark);
      ear.position.set(1.55, 2.43, z * 0.62);
      ear.rotation.z = -0.2;
      body.add(ear);
    }

    const mane: THREE.Mesh[] = [];
    for (let i = 0; i < 7; i++) {
      const m = mesh(new THREE.BoxGeometry(0.08, 0.22 + i * 0.01, 0.08), dark);
      m.position.set(1.13 - i * 0.12, 2.08 - i * 0.06, 0);
      m.rotation.z = -0.35;
      body.add(m);
      mane.push(m);
    }

    const tail: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) {
      const t = mesh(new THREE.CylinderGeometry(0.075 - i * 0.008, 0.095 - i * 0.009, 0.42, 8), dark);
      t.position.set(-1.5 - i * 0.08, 1.34 - i * 0.11, 0);
      t.rotation.z = 0.75 + i * 0.12;
      body.add(t);
      tail.push(t);
    }

    const blanket = mesh(new THREE.BoxGeometry(1.04, 0.08, 0.84), blanketMat);
    blanket.position.set(-0.1, 1.76, 0);
    body.add(blanket);
    const blanketTrim = mesh(new THREE.BoxGeometry(1.08, 0.09, 0.06), tackMat);
    blanketTrim.position.set(-0.1, 1.8, 0.45);
    body.add(blanketTrim.clone(), blanketTrim);
    blanketTrim.position.z = -0.45;
    const saddle = mesh(new THREE.BoxGeometry(0.82, 0.12, 0.68), tackMat);
    saddle.position.set(-0.1, 1.85, 0);
    body.add(saddle);
    const girth = mesh(new THREE.BoxGeometry(0.12, 0.12, 0.94), tackMat);
    girth.position.set(-0.02, 1.55, 0);
    body.add(girth);
    const breastCollar = mesh(new THREE.BoxGeometry(0.08, 0.08, 0.82), tackMat);
    breastCollar.position.set(0.72, 1.55, 0);
    body.add(breastCollar);
    const noseband = mesh(new THREE.BoxGeometry(0.05, 0.055, 0.42), tackMat);
    noseband.position.set(1.98, 2.13, 0);
    body.add(noseband);
    const browband = mesh(new THREE.BoxGeometry(0.07, 0.055, 0.46), tackMat);
    browband.position.set(1.68, 2.32, 0);
    body.add(browband);

    const legs: LegRig[] = [];
    const upperGeo = new THREE.CylinderGeometry(0.09, 0.105, 1, 10);
    const lowerGeo = new THREE.CylinderGeometry(0.07, 0.085, 1, 10);
    const jointGeo = new THREE.SphereGeometry(0.12, 10, 8);
    const hoofGeo = new THREE.BoxGeometry(0.24, 0.11, 0.17);
    const hips: [number, number][] = [[0.82, -0.32], [0.82, 0.32], [-0.78, -0.32], [-0.78, 0.32]];
    for (let i = 0; i < hips.length; i++) {
      const [x, z] = hips[i];
      const upper = mesh(upperGeo, coat);
      const lower = mesh(lowerGeo, (variant.sockMask & (1 << i)) ? sockMat : coat);
      const knee = mesh(jointGeo, coat);
      const hoof = mesh(hoofGeo, hoofMat);
      body.add(upper, lower, knee, hoof);
      legs.push({ upper, lower, knee, hoof, side: z < 0 ? -1 : 1, fore: x > 0 ? 1 : -1 });
    }

    root.userData.body = body;
    root.userData.legs = legs;
    root.userData.mane = mane;
    root.userData.tail = tail;
    root.scale.setScalar(variant.scale);
    return root;
  }

  prePhysics(dt: number, playerPosition: THREE.Vector3): void {
    if (!this.#ready) return;
    const dcx = playerPosition.x - CENTER.x;
    const dcz = playerPosition.z - CENTER.z;
    this.#active = dcx * dcx + dcz * dcz < SIM_RANGE * SIM_RANGE;
    if (!this.#active) return;
    const step = Math.min(dt, 0.05);
    for (let i = 0; i < this.#horses.length; i++) this.#updateHorse(this.#horses[i], step, i, playerPosition);
  }

  update(_dt: number, camera: THREE.Camera): void {
    // The Codex horse controller is stepped from prePhysics so it stays frozen
    // with the rest of the world while paused. Here we only billboard + repaint
    // each horse's floating neural-net lattice from its cached activations, so
    // the brains keep glowing (and stay inspectable) even while paused.
    this.#camera = camera;

    // Herd mesh visibility gate (see MESH_HIDE_RANGE). Toggle on threshold
    // crossings only. The brain overlays are already distance-gated below (all
    // hidden once the player is past SIM_RANGE, and per-horse past OVERLAY_RANGE),
    // so a hidden herd carries no stray lattices.
    const dcx = camera.position.x - CENTER.x;
    const dcz = camera.position.z - CENTER.z;
    const camDist2 = dcx * dcx + dcz * dcz;
    if (this.#meshesShown && camDist2 > MESH_HIDE_RANGE * MESH_HIDE_RANGE) this.#setHerdVisible(false);
    else if (!this.#meshesShown && camDist2 < MESH_SHOW_RANGE * MESH_SHOW_RANGE) this.#setHerdVisible(true);

    const overlay = this.#overlay;
    if (!overlay) return;
    if (!this.#active || !this.#overlaysOn) {
      for (let i = 0; i < this.#horses.length; i++) overlay.hide(i);
      return;
    }
    const range2 = OVERLAY_RANGE * OVERLAY_RANGE;
    for (let i = 0; i < this.#horses.length; i++) {
      const h = this.#horses[i];
      this.#latticePos(h, this.#worldPos);
      const dx = this.#worldPos.x - camera.position.x;
      const dz = this.#worldPos.z - camera.position.z;
      if (!h.layerSnap.length || dx * dx + dz * dz > range2) overlay.hide(i);
      else overlay.update(i, this.#worldPos, h.layerSnap, h.obsSnap);
    }
  }

  /** Show/hide every horse + course prop in one shot (distance mesh gate). */
  #setHerdVisible(visible: boolean): void {
    this.#meshesShown = visible;
    for (const h of this.#horses) h.group.visible = visible;
    for (const o of this.#obstacles) o.mesh.visible = visible;
  }

  /** World position of a horse's floating lattice: above its head. */
  #latticePos(h: HorseState, out: THREE.Vector3): void {
    out.set(h.group.position.x, h.group.position.y + 2.55 * h.variant.scale + OVERLAY_LIFT, h.group.position.z);
  }

  #updateHorse(h: HorseState, dt: number, index: number, playerPosition?: THREE.Vector3): void {
    if (this.#forceSpeed !== null) {
      const forced = this.#forceSpeed < 1.5 ? this.#forceSpeed * 5.5 : this.#forceSpeed;
      h.targetSpeed = clamp(forced, 0.4, 5.4);
      h.gait = h.targetSpeed > 3.4 ? "gallop" : h.targetSpeed > 1.9 ? "trot" : "walk";
    }
    const nearest = this.#nearestObstacle(h);
    const headingTarget = this.#targetHeading(h, index, nearest, playerPosition);
    this.#observe(h, headingTarget, nearest);
    const action = this.#policy?.forward(this.#obs) ?? h.action;
    if (!this.#policy) {
      action[0] = 0.1;
      action[1] = h.gait === "gallop" ? 0.55 : h.gait === "trot" ? 0.1 : -0.25;
      action[2] = h.gait === "gallop" ? 0.5 : 0.0;
      action[3] = clamp(wrapPi(headingTarget - h.heading), -1, 1);
      action[4] = nearest?.kind === "hurdle" && Math.hypot(nearest.x - h.x, nearest.z - h.z) < 8 ? 0.9 : 0;
    }
    h.action.set(action);
    if (this.#policy && h.layerSnap.length) {
      // capture this horse's activations before the next horse overwrites the
      // shared buffers, so the render-frame overlay draws the right brain.
      h.obsSnap.set(this.#obs);
      for (let l = 0; l < h.layerSnap.length; l++) h.layerSnap[l].set(this.#policy.layerOut[l]);
    }

    h.jumpCooldown = Math.max(0, h.jumpCooldown - dt);
    const turnError = wrapPi(headingTarget - h.heading);
    const cadence = clamp((h.gait === "walk" ? 0.92 : h.gait === "trot" ? 1.62 : 2.28) * (1 + action[0] * 0.12), 0.72, 2.85);
    const stride = clamp((h.gait === "walk" ? 0.55 : h.gait === "trot" ? 0.78 : 1.02) + action[1] * 0.08, 0.42, 1.18);
    const jumpApproach = this.#aheadObstacle(h, "hurdle", 14, 4.8);
    const coneApproach = this.#aheadObstacle(h, "cone", 8.5, 2.3);
    const avoidSteer = coneApproach ? -Math.sign(coneApproach.lateral || 1) * smoothstep(8.5, 1.2, coneApproach.ahead) * 0.58 : 0;
    const steer = clamp(turnError * 2.15 + action[3] * 0.16 + avoidSteer, -1.55, 1.55);
    h.phase = fract(h.phase + cadence * dt);
    h.heading = wrapPi(h.heading + steer * dt);

    const desiredSpeed = jumpApproach && jumpApproach.ahead < 5.5 ? Math.max(h.targetSpeed, 3.25) : h.targetSpeed;
    const forwardAcc = (desiredSpeed - h.speed) * 1.55 + stride * cadence * 0.08 - h.speed * 0.08;
    const cap = h.gait === "gallop" ? 5.2 : h.gait === "trot" ? 3.35 : 1.8;
    h.speed = clamp(h.speed + forwardAcc * dt, 0.2, cap);
    h.vx = Math.cos(h.heading) * h.speed;
    h.vz = Math.sin(h.heading) * h.speed;
    h.x += h.vx * dt;
    h.z += h.vz * dt;
    const ex = h.x / ROAM_RX;
    const ez = h.z / ROAM_RZ;
    if (ex * ex + ez * ez > 1) {
      const pull = Math.atan2(-h.z / ROAM_RZ, -h.x / ROAM_RX);
      h.heading = wrapPi(h.heading + wrapPi(pull - h.heading) * dt * 2.8);
      h.x *= 0.998;
      h.z *= 0.998;
    }

    const jumpIntent = jumpApproach ? Math.max(0.55, action[4] ?? 0) : Math.max(0, action[4] ?? 0);
    if (jumpApproach && jumpApproach.ahead < 3.55 && jumpApproach.ahead > 0.35 && h.jumpCooldown <= 0 && h.y < BODY_H + 0.08 && jumpIntent > 0.35) {
      this.#launchJump(h, jumpIntent);
    }
    if (h.y > BODY_H + 0.015 || h.vy > 0) h.vy -= 8.4 * dt;
    else h.vy = 0;
    h.y += h.vy * dt;
    if (h.y < BODY_H) {
      h.y = BODY_H;
      h.vy = 0;
    }
    h.maxAir = Math.max(h.maxAir, Math.max(0, h.y - BODY_H));
    h.roll += (-h.roll * 4.6 + avoidSteer * 0.06 + action[5] * 0.07) * dt;
    h.pitch += (-h.pitch * 4.2 + (h.speed - h.targetSpeed) * 0.018 + action[6] * 0.06 - Math.max(0, h.vy) * 0.018) * dt;
    this.#poseHorse(h, cadence, stride, action, nearest);
  }

  #launchJump(h: HorseState, intent: number): void {
    h.vy = Math.max(h.vy, 3.6 + h.speed * 0.25 + intent * 0.5);
    h.jumpCooldown = 1.15;
    h.jumpCount++;
  }

  #targetHeading(h: HorseState, _index: number, nearest: Obstacle | null, playerPosition?: THREE.Vector3): number {
    const angle = Math.atan2(h.z, h.x);
    h.routeAngle = angle;
    const dist = Math.max(0.001, Math.hypot(h.x, h.z));
    const radialError = dist - h.routeRadius;
    let dx = -Math.sin(angle) * h.routeDir - Math.cos(angle) * radialError * 0.055;
    let dz = Math.cos(angle) * h.routeDir - Math.sin(angle) * radialError * 0.055;
    if (nearest?.kind === "cone" && Math.hypot(nearest.x - h.x, nearest.z - h.z) < 10) {
      dx += -(nearest.z - h.z) * 1.2;
      dz += (nearest.x - h.x) * 1.2;
    }
    if (nearest?.kind === "hurdle") {
      const approach = this.#aheadObstacle(h, "hurdle", 14, 5);
      if (approach) {
        dx += (nearest.x - h.x) * 0.18;
        dz += (nearest.z - h.z) * 0.18;
      }
    }
    if (playerPosition) {
      const px = playerPosition.x - CENTER.x;
      const pz = playerPosition.z - CENTER.z;
      const d = Math.hypot(px - h.x, pz - h.z);
      if (d < 8) {
        dx -= (px - h.x) * 2.8;
        dz -= (pz - h.z) * 2.8;
      }
    }
    return Math.atan2(dz, dx);
  }

  #aheadObstacle(h: HorseState, kind: ObstacleKind, maxAhead: number, maxLateral: number): { obstacle: Obstacle; ahead: number; lateral: number } | null {
    const fx = Math.cos(h.heading);
    const fz = Math.sin(h.heading);
    const rx = -fz;
    const rz = fx;
    let best: { obstacle: Obstacle; ahead: number; lateral: number } | null = null;
    for (const obstacle of this.#obstacles) {
      if (obstacle.kind !== kind) continue;
      const dx = obstacle.x - h.x;
      const dz = obstacle.z - h.z;
      const ahead = dx * fx + dz * fz;
      const lateral = dx * rx + dz * rz;
      if (ahead <= 0 || ahead > maxAhead || Math.abs(lateral) > maxLateral) continue;
      if (!best || ahead < best.ahead) best = { obstacle, ahead, lateral };
    }
    return best;
  }

  #nearestObstacle(h: HorseState): Obstacle | null {
    let best: Obstacle | null = null;
    let bd = Infinity;
    for (const o of this.#obstacles) {
      const dx = o.x - h.x;
      const dz = o.z - h.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best && bd < 20 * 20 ? best : null;
  }

  #observe(h: HorseState, headingTarget: number, obstacle: Obstacle | null): void {
    const err = wrapPi(headingTarget - h.heading);
    let k = 0;
    this.#obs[k++] = h.targetSpeed / 6;
    this.#obs[k++] = h.speed / 6;
    this.#obs[k++] = (h.targetSpeed - h.speed) / 6;
    this.#obs[k++] = Math.sin(err);
    this.#obs[k++] = Math.cos(err);
    this.#obs[k++] = (h.y - BODY_H) / BODY_H;
    this.#obs[k++] = h.vy / 5;
    this.#obs[k++] = h.roll;
    this.#obs[k++] = h.pitch;
    this.#obs[k++] = 0;
    this.#obs[k++] = 0;
    this.#obs[k++] = err;
    this.#obs[k++] = Math.sin(h.phase * Math.PI * 2);
    this.#obs[k++] = Math.cos(h.phase * Math.PI * 2);
    for (let i = 0; i < 4; i++) this.#obs[k++] = h.contacts[i] ? 1 : 0;
    const dx = obstacle ? obstacle.x - h.x : 16;
    const dz = obstacle ? obstacle.z - h.z : 0;
    this.#obs[k++] = Math.min(16, Math.hypot(dx, dz)) / 16;
    this.#obs[k++] = obstacle ? wrapPi(Math.atan2(dz, dx) - h.heading) / Math.PI : 0;
    this.#obs[k++] = obstacle ? obstacle.height / 1.5 : 0;
    this.#obs[k++] = obstacle ? smoothstep(16, 0, Math.hypot(dx, dz)) : 0;
    this.#obs[k++] = obstacle ? dz / 4 : 0;
    this.#obs[k++] = h.gait === "walk" ? 1 : 0;
    this.#obs[k++] = h.gait === "trot" ? 1 : 0;
    this.#obs[k++] = h.gait === "gallop" ? 1 : 0;
    this.#obs[k++] = 1;
    this.#obs[k++] = obstacle?.kind === "hurdle" ? 1 : 0;
    this.#obs[k++] = obstacle?.kind === "cone" ? 1 : 0;
    this.#obs[k++] = clamp(h.z / ROAM_R, -1, 1);
    this.#obs[k++] = clamp(Math.hypot(h.x, h.z) / ROAM_R, 0, 1);
    this.#obs[k++] = 1;
  }

  #poseHorse(h: HorseState, cadence: number, stride: number, action: ArrayLike<number>, nearest: Obstacle | null): void {
    const root = h.group;
    root.position.set(CENTER.x + h.x, this.#groundAt(h.x, h.z) + h.y - BODY_H, CENTER.z + h.z);
    root.rotation.set(0, -h.heading, 0);
    const airborne = h.y > BODY_H + 0.08;
    const bobAmp = h.gait === "walk" ? 0.018 : h.gait === "trot" ? 0.045 : 0.07;
    h.body.position.y = Math.sin(h.phase * Math.PI * 2) * bobAmp + Math.max(0, h.y - BODY_H) * 0.1;
    h.body.rotation.set(h.pitch + (airborne ? -h.vy * 0.025 : 0), 0, h.roll);

    const offsets = h.gait === "walk" ? WALK : h.gait === "trot" ? TROT : GALLOP;
    const duty = h.gait === "walk" ? 0.72 : h.gait === "trot" ? 0.5 : 0.38;
    const lift = clamp((h.gait === "walk" ? 0.2 : h.gait === "trot" ? 0.32 : 0.48) + Math.max(0, action[2] ?? 0) * 0.08 + (nearest?.kind === "hurdle" ? 0.1 : 0), 0.18, 0.66);
    const poseStride = clamp(stride * (h.gait === "walk" ? 0.7 : h.gait === "trot" ? 0.82 : 1.0), 0.34, 1.08);
    for (let i = 0; i < h.legs.length; i++) {
      const leg = h.legs[i];
      const p = fract(h.phase + offsets[i]);
      const stance = p < duty && h.y < BODY_H + 0.2;
      h.contacts[i] = stance;
      const u = stance ? p / duty : (p - duty) / (1 - duty);
      const hip = this.#tmpA.set(leg.fore * 0.78, 1.28, leg.side * 0.3);
      let footForward = hip.x + (stance ? (0.5 - u) * poseStride * 0.78 : (-0.5 + u) * poseStride);
      const footSide = leg.side * (0.34 + Math.abs(h.roll) * 0.08);
      let footY = stance ? 0.06 : Math.sin(u * Math.PI) * lift + 0.1;
      if (airborne) {
        footForward = hip.x + (leg.fore > 0 ? 0.34 : -0.24) + Math.sin(u * Math.PI) * poseStride * 0.1;
        footY = leg.fore > 0 ? 0.62 : 0.5;
      }
      const foot = this.#tmpB.set(footForward, footY, footSide);
      const reachX = foot.x - hip.x;
      const reachY = foot.y - hip.y;
      const reachZ = foot.z - hip.z;
      const reach = Math.hypot(reachX, reachY, reachZ);
      if (reach > 1.38) {
        const scale = 1.38 / reach;
        foot.set(hip.x + reachX * scale, hip.y + reachY * scale, hip.z + reachZ * scale);
      }
      const kneeBend = leg.fore > 0 ? -0.16 : 0.18;
      const knee = this.#tmpC.set(
        (hip.x + foot.x) * 0.5 + kneeBend * (0.55 + Math.sin(u * Math.PI) * 0.45),
        Math.max(0.48, (hip.y + foot.y) * 0.5 + (stance ? -0.08 : 0.05)),
        (hip.z + foot.z) * 0.5
      );
      putCylinderBetween(leg.upper, hip, knee);
      putCylinderBetween(leg.lower, knee, foot);
      leg.knee.position.copy(knee);
      leg.hoof.position.copy(foot);
      leg.hoof.rotation.set(0, 0, stance ? -0.08 * leg.fore : 0.14 * leg.fore);
    }
    for (let i = 0; i < h.mane.length; i++) h.mane[i].rotation.y = Math.sin(h.phase * 8 + i) * (h.gait === "gallop" ? 0.09 : 0.04);
    for (let i = 0; i < h.tail.length; i++) h.tail[i].rotation.y = Math.sin(h.phase * 7 + i * 0.9) * (h.gait === "gallop" ? 0.24 : 0.16);
  }
}
