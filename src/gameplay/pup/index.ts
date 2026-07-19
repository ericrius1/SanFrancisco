import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import type { GameSite } from "../siteGate";
import { Policy, type PolicyDef } from "../../creatures/policy.ts";
import { DOG, obsDim, actDim, type Link } from "../../creatures/quadruped.ts";
import { CreatureRagdoll } from "./creatureRagdoll.ts";
import { PUP_CENTER, PUP_PEN_RADIUS, PUP_SITE_PADS } from "./meta";

/**
 * Biscuit — a little RL puppy growing up in a picket pen on Marina Green.
 *
 * The pup is a live box3d active-ragdoll (its own private flat-ground world)
 * driven every frame by whatever brain is in public/models/pup_policy.json.
 * An overnight Evolution-Strategies trainer (rl/train.ts --creature pup)
 * keeps improving that file, and the pen re-fetches it every couple of
 * minutes: the newborn that can barely wiggle at dusk is trotting laps by
 * sunrise — and physically GROWS a little with each generation milestone
 * (the policy is Froude-scale-invariant, so one brain fits every body size).
 *
 * The glowing lattice overhead is the pup's actual network: per-node colors
 * are the live layer activations of the very forward() call that is driving
 * its legs right now.
 */

const ROAM_R = PUP_PEN_RADIUS - 2.2; // wander inside the fence
const GOAL_EASE = 0.45; // s — smooth heading changes so it never cranks a tip-over turn
const DOWN_SECONDS = 5; // a tumbled pup lies where it fell, then gets back up
const POLL_MS = 90_000; // re-fetch the training checkpoint while the pen is awake
const NEWBORN_SCALE = 0.45;
const GROWN_SCALE = 0.85;
const GROW_GENS = 300; // fully grown after this many training generations

const BRAIN_SCALE = 0.55;
const BRAIN_LINE_GLOW = LIGHT_SCALE * 0.14;
const BRAIN_NODE_GLOW = LIGHT_SCALE * 0.34;
const LAYER_COLORS = [0x12a8ff, 0x38d8ff, 0x8d67ff, 0xff8d2a] as const;

type PupPolicyFile = PolicyDef & { meta?: { gen: number; robust: number; at: number } };

/** Body size for a training generation: newborn -> grown over GROW_GENS. */
function scaleForGen(gen: number): number {
  const t = Math.min(1, Math.max(0, gen / GROW_GENS));
  return NEWBORN_SCALE + (GROWN_SCALE - NEWBORN_SCALE) * t;
}

function statusForGen(gen: number): string {
  if (gen <= 0) return "newborn · just wiggling";
  if (gen < 30) return "finding its feet";
  if (gen < 90) return "learning to walk";
  if (gen < 200) return "walking!";
  return "trotting laps!";
}

function partMesh(geo: THREE.BufferGeometry, color: number, rough: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: 0.03,
    emissive: new THREE.Color(color).multiplyScalar(0.28),
    emissiveIntensity: 0.014 * LIGHT_SCALE
  });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function layerColor(layer: number): THREE.Color {
  return new THREE.Color(LAYER_COLORS[Math.min(LAYER_COLORS.length - 1, layer)]);
}

function writeActivationColor(out: Float32Array, i3: number, activation: number, layer: number, boost: number): void {
  const tt = activation < -1 ? 0 : activation > 1 ? 1 : (activation + 1) / 2;
  const base = layerColor(layer);
  const heat = 0.36 + tt * tt * 1.55;
  const white = tt > 0.72 ? (tt - 0.72) * 1.3 : 0;
  out[i3] = (base.r * (1 - white) + white) * heat * boost;
  out[i3 + 1] = (base.g * (1 - white) + white) * heat * boost;
  out[i3 + 2] = (base.b * (1 - white) + white) * heat * boost;
}

function setActivationColor(color: THREE.Color, activation: number, layer: number, boost: number): void {
  const tt = activation < -1 ? 0 : activation > 1 ? 1 : (activation + 1) / 2;
  const base = layerColor(layer);
  const heat = 0.54 + tt * tt * 1.7;
  const white = tt > 0.66 ? (tt - 0.66) * 1.55 : 0;
  color.setRGB(
    (base.r * (1 - white) + white) * heat * boost,
    (base.g * (1 - white) + white) * heat * boost,
    (base.b * (1 - white) + white) * heat * boost
  );
}

type Brain = {
  group: THREE.Group;
  lineColors: Float32Array;
  lineAttr: THREE.BufferAttribute;
  lineLayer: Uint8Array;
  lineNode: Uint16Array;
  pointLayer: Uint8Array;
  pointNode: Uint16Array;
  nodes: THREE.InstancedMesh;
  halos: THREE.InstancedMesh;
};

/** The activation lattice floating over the pup — same construction as the old
 *  horse herd's brain, one instance. Fixed geometry, per-frame colors only. */
function buildBrain(sizes: number[]): Brain {
  const nL = sizes.length;
  const GAP = 0.72;
  const HEIGHT = 1.42;
  const DEPTH = 0.86;
  const layerX = (li: number) => (li - (nL - 1) / 2) * GAP;
  const nodePos = (li: number, j: number, out: number[]) => {
    const n = sizes[li];
    const cols = li === 0 || li === nL - 1 ? 1 : 4;
    const rows = Math.ceil(n / cols);
    const col = j % cols;
    const row = Math.floor(j / cols);
    const dz = cols <= 1 ? 0 : (col / (cols - 1) - 0.5) * DEPTH;
    const dy = rows <= 1 ? 0 : (0.5 - row / (rows - 1)) * HEIGHT;
    const curve = Math.sin((row + 1) * 0.68 + li * 0.9) * 0.025;
    out.push(layerX(li), dy, dz + curve);
  };
  const linePos: number[] = [];
  const pointPos: number[] = [];
  const lineLayer: number[] = [];
  const lineNode: number[] = [];
  const pointLayer: number[] = [];
  const pointNode: number[] = [];
  const addVert = (li: number, j: number) => {
    nodePos(li, j, linePos);
    lineLayer.push(li);
    lineNode.push(j);
  };
  const addEdge = (aLi: number, aJ: number, bLi: number, bJ: number) => {
    addVert(aLi, aJ);
    addVert(bLi, bJ);
  };
  for (let li = 0; li < nL; li++) {
    const cols = li === 0 || li === nL - 1 ? 1 : 4;
    const rows = Math.ceil(sizes[li] / cols);
    for (let j = 0; j < sizes[li]; j++) {
      nodePos(li, j, pointPos);
      pointLayer.push(li);
      pointNode.push(j);
    }
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const j = row * cols + col;
        if (j >= sizes[li]) continue;
        const right = row * cols + col + 1;
        const down = (row + 1) * cols + col;
        if (col + 1 < cols && right < sizes[li]) addEdge(li, j, li, right);
        if (row + 1 < rows && down < sizes[li]) addEdge(li, j, li, down);
      }
    }
    if (li + 1 < nL) {
      for (let j = 0; j < sizes[li]; j++) {
        for (let b = 0; b < sizes[li + 1]; b++) addEdge(li, j, li + 1, b);
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  const linePosArr = new Float32Array(linePos);
  const lineColArr = new Float32Array(linePosArr.length);
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePosArr, 3));
  const lineAttr = new THREE.BufferAttribute(lineColArr, 3);
  lineAttr.setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute("color", lineAttr);
  const lineMat = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  lineMat.opacity = 0.46;
  lineMat.depthTest = false;
  lineMat.toneMapped = false;
  const line = new THREE.LineSegments(lineGeo, lineMat);
  line.frustumCulled = false;

  const mkInstanced = (radius: number, opacity: number): THREE.InstancedMesh => {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
      blending: opacity < 1 ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    mat.depthTest = false;
    mat.toneMapped = false;
    const im = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 10, 8), mat, pointLayer.length);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    im.frustumCulled = false;
    return im;
  };
  const nodes = mkInstanced(0.045, 1);
  const halos = mkInstanced(0.11, 0.32);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const seed = new THREE.Color(0.35, 0.85, 1.1);
  for (let i = 0; i < pointLayer.length; i++) {
    const i3 = i * 3;
    p.set(pointPos[i3], pointPos[i3 + 1], pointPos[i3 + 2]);
    const boost = pointLayer[i] === 0 || pointLayer[i] === nL - 1 ? 1.12 : 1;
    m.compose(p, q, s.setScalar(boost));
    nodes.setMatrixAt(i, m);
    halos.setMatrixAt(i, m);
    nodes.setColorAt(i, seed);
    halos.setColorAt(i, seed);
  }
  nodes.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  halos.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  const group = new THREE.Group();
  group.add(line, halos, nodes);
  group.scale.setScalar(BRAIN_SCALE);
  return {
    group,
    lineColors: lineColArr,
    lineAttr,
    lineLayer: Uint8Array.from(lineLayer),
    lineNode: Uint16Array.from(lineNode),
    pointLayer: Uint8Array.from(pointLayer),
    pointNode: Uint16Array.from(pointNode),
    nodes,
    halos
  };
}

export class PupPen {
  readonly root = new THREE.Group();
  #physics: Physics;
  #groundY: number;
  #awake = false;
  #rag: CreatureRagdoll | null = null;
  #parts: THREE.Mesh[] = [];
  #brain: Brain | null = null;
  #policy: PupPolicyFile | null = null;
  #gen = 0;
  #robust = 0;
  #scale = NEWBORN_SCALE;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #policyRequest: AbortController | null = null;
  #fetching = false;
  #disposed = false;
  #onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      this.#stopPolling();
      this.#policyRequest?.abort("page suspended");
      return;
    }
    void this.#loadPolicy(!this.#policy);
    this.#syncPolling();
  };
  // wander state
  #wanderYaw = Math.random() * Math.PI * 2;
  #wanderTimer = 2;
  #speedNonDim = 0.2;
  #gx = 0;
  #gz = 1;
  #downTimer = 0;
  // sign
  #signCanvas: HTMLCanvasElement;
  #signCtx: CanvasRenderingContext2D;
  #signTex: THREE.CanvasTexture;
  #camPos = new THREE.Vector3();
  #nodeColor = new THREE.Color();
  #haloColor = new THREE.Color();

  constructor(map: WorldMap, physics: Physics, scene: THREE.Scene) {
    this.#physics = physics;
    this.#groundY = map.groundTop(PUP_CENTER.x, PUP_CENTER.z);
    this.#signCanvas = document.createElement("canvas");
    this.#signCanvas.width = 512;
    this.#signCanvas.height = 288;
    this.#signCtx = this.#signCanvas.getContext("2d")!;
    this.#signTex = new THREE.CanvasTexture(this.#signCanvas);
    this.#signTex.colorSpace = THREE.SRGBColorSpace;
    this.#buildPen();
    this.root.visible = false;
    scene.add(this.root);
    document.addEventListener("visibilitychange", this.#onVisibilityChange);
    if (document.visibilityState === "visible") void this.#loadPolicy(true);
  }

  get center(): { x: number; z: number } {
    return PUP_CENTER;
  }

  /** Ground-truth pose + training progress for headless verification. */
  debugState(): { gen: number; robust: number; scale: number; upY: number; tall: number; speed: number; fallen: boolean; down: number; hasPolicy: boolean; wx: number; wy: number; wz: number } {
    if (!this.#rag) return { gen: this.#gen, robust: this.#robust, scale: this.#scale, upY: 0, tall: 0, speed: 0, fallen: false, down: 0, hasPolicy: !!this.#policy, wx: PUP_CENTER.x, wy: this.#groundY, wz: PUP_CENTER.z };
    const t = this.#rag.torsoLink;
    const q = t.quat;
    const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
    return {
      gen: this.#gen,
      robust: this.#robust,
      scale: this.#scale,
      upY,
      tall: t.pos[1] / this.#rag.standY,
      speed: Math.hypot(t.vel[0], t.vel[2]),
      fallen: this.#rag.fallen,
      down: this.#downTimer,
      hasPolicy: !!this.#policy,
      wx: PUP_CENTER.x + t.pos[0],
      wy: this.#groundY + 0.06 + t.pos[1],
      wz: PUP_CENTER.z + t.pos[2]
    };
  }

  siteHooks(): GameSite {
    return {
      id: "pup",
      contains: (x, z, pad) => {
        const dx = x - PUP_CENTER.x;
        const dz = z - PUP_CENTER.z;
        const r = PUP_PEN_RADIUS + pad;
        return dx * dx + dz * dz < r * r;
      },
      activatePad: PUP_SITE_PADS.activate,
      deactivatePad: PUP_SITE_PADS.deactivate,
      setAwake: (on) => this.#setAwake(on)
    };
  }

  /** Full teardown for a distance unload: the private box3d ragdoll world,
   * the checkpoint poll timer, and every locally built pen mesh go together. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopPolling();
    this.#policyRequest?.abort("pup disposed");
    document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    this.#rag?.dispose();
    this.#rag = null;
    this.#brain = null;
    this.#signTex.dispose();
    this.root.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.root.clear();
    this.#parts.length = 0;
  }

  #setAwake(on: boolean): void {
    if (this.#awake === on) return;
    this.#awake = on;
    this.root.visible = on;
    if (on && document.visibilityState === "visible") void this.#loadPolicy(false);
    this.#syncPolling();
  }

  #stopPolling(): void {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  #syncPolling(): void {
    if (!this.#awake || this.#disposed || document.visibilityState === "hidden") {
      this.#stopPolling();
      return;
    }
    if (!this.#pollTimer) {
      this.#pollTimer = setInterval(() => void this.#loadPolicy(false), POLL_MS);
    }
  }

  // ------------------------------------------------------------- pen visuals
  #buildPen(): void {
    const cx = PUP_CENTER.x;
    const cz = PUP_CENTER.z;
    const y = this.#groundY;
    // lawn pad — hides any slight terrain slope so the flat private sim reads true
    const lawn = new THREE.Mesh(
      new THREE.CircleGeometry(PUP_PEN_RADIUS + 1.6, 48),
      new THREE.MeshStandardMaterial({ color: 0x86b24c, roughness: 0.9, emissive: 0x1d3812, emissiveIntensity: 0.035 * LIGHT_SCALE })
    );
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(cx, y + 0.04, cz);
    lawn.receiveShadow = true;
    this.root.add(lawn);

    // white picket fence: instanced posts + two rail hoops
    const POSTS = 22;
    const postGeo = new THREE.BoxGeometry(0.09, 0.85, 0.06);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.6, emissive: 0x30302a, emissiveIntensity: 0.045 * LIGHT_SCALE });
    const posts = new THREE.InstancedMesh(postGeo, postMat, POSTS);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < POSTS; i++) {
      const a = (i / POSTS) * Math.PI * 2;
      p.set(cx + Math.sin(a) * PUP_PEN_RADIUS, y + 0.42, cz + Math.cos(a) * PUP_PEN_RADIUS);
      q.setFromAxisAngle(up, a);
      m.compose(p, q, s);
      posts.setMatrixAt(i, m);
    }
    posts.castShadow = true;
    this.root.add(posts);
    for (const railY of [0.32, 0.62]) {
      const rail = new THREE.Mesh(new THREE.TorusGeometry(PUP_PEN_RADIUS, 0.035, 6, 64), postMat);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(cx, y + railY, cz);
      this.root.add(rail);
    }

    // sign on a post by the fence
    const signPost = partMesh(new THREE.BoxGeometry(0.1, 1.5, 0.1), 0x7a5a38, 0.8);
    const sa = Math.PI * 0.78; // face the Marina Green spawn approach
    const sx = cx + Math.sin(sa) * (PUP_PEN_RADIUS + 0.9);
    const sz = cz + Math.cos(sa) * (PUP_PEN_RADIUS + 0.9);
    signPost.position.set(sx, y + 0.75, sz);
    this.root.add(signPost);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.9, 0.06),
      new THREE.MeshStandardMaterial({
        map: this.#signTex,
        emissive: 0xffffff,
        emissiveMap: this.#signTex,
        emissiveIntensity: 0.4,
        roughness: 0.7
      })
    );
    board.position.set(sx, y + 1.62, sz);
    board.rotation.y = sa; // board +z faces outward, toward the approach
    this.root.add(board);
    this.#drawSign();
  }

  #drawSign(): void {
    const ctx = this.#signCtx;
    const w = this.#signCanvas.width;
    const h = this.#signCanvas.height;
    ctx.fillStyle = "#2c2016";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#e8ddc4";
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.fillStyle = "#ffe9b8";
    ctx.font = "bold 74px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText("BISCUIT", w / 2, 96);
    ctx.font = "34px Georgia, serif";
    ctx.fillStyle = "#d9ecff";
    ctx.fillText(statusForGen(this.#gen), w / 2, 160);
    ctx.font = "30px Georgia, serif";
    ctx.fillStyle = "#a8c8a0";
    const fit = this.#robust > 0 ? `   ·   fitness ${Math.round(this.#robust)}` : "";
    ctx.fillText(`generation ${this.#gen}${fit}`, w / 2, 222);
    this.#signTex.needsUpdate = true;
  }

  // ------------------------------------------------------------- the pup
  /** Newborn brain: tiny random weights — it can barely wiggle. The trainer's
   *  first checkpoint replaces this within minutes of starting. */
  #newbornDef(): PupPolicyFile {
    let seed = 20260716;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const sizes = [obsDim(DOG), 32, 32, actDim(DOG)];
    return Policy.random(sizes, rng, "pup").toDef();
  }

  async #loadPolicy(allowNewborn: boolean): Promise<void> {
    if (this.#fetching || this.#disposed || document.visibilityState === "hidden") return;
    this.#fetching = true;
    const controller = new AbortController();
    this.#policyRequest = controller;
    try {
      const res = await fetch(`/models/pup_policy.json?t=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const def = (await res.json()) as PupPolicyFile;
      if (this.#disposed) return;
      const gen = def.meta?.gen ?? 0;
      if (this.#policy && gen === this.#gen) return; // unchanged checkpoint
      this.#policy = def;
      this.#gen = gen;
      this.#robust = def.meta?.robust ?? 0;
      this.#applyPolicy(def);
    } catch {
      if (allowNewborn && !this.#policy && document.visibilityState === "visible") {
        this.#policy = this.#newbornDef();
        this.#applyPolicy(this.#policy);
      }
    } finally {
      if (this.#policyRequest === controller) this.#policyRequest = null;
      this.#fetching = false;
      if (
        controller.signal.reason === "page suspended" &&
        !this.#disposed &&
        document.visibilityState === "visible"
      ) {
        void this.#loadPolicy(allowNewborn);
      }
    }
  }

  #applyPolicy(def: PupPolicyFile): void {
    const wanted = scaleForGen(this.#gen);
    if (!this.#rag || Math.abs(wanted - this.#scale) > 0.03) {
      this.#scale = wanted;
      this.#rebuildPup(def);
    } else {
      this.#rag.setPolicy(def);
    }
    this.#drawSign();
  }

  #rebuildPup(def: PupPolicyFile): void {
    this.#rag?.dispose();
    this.#rag = new CreatureRagdoll(this.#physics.box3d, DOG, def, this.#scale);
    if (this.#parts.length === 0) {
      this.#parts = this.#buildDressedPup();
      for (const part of this.#parts) this.root.add(part);
      this.#brain = buildBrain(this.#rag.layers().map((l) => l.length));
      this.root.add(this.#brain.group);
    }
    for (const part of this.#parts) part.scale.setScalar(this.#scale);
    this.#downTimer = 0;
  }

  /** Dress the capsule ragdoll as a golden pup: geometry at BASE spec dims,
   *  sized by a uniform scale so growth is just a scalar update. */
  #buildDressedPup(): THREE.Mesh[] {
    const s = DOG;
    const parts: THREE.Mesh[] = [];
    const COAT = 0xe0a95f;
    const COAT_DARK = 0xc08447;
    const torso = partMesh(new THREE.BoxGeometry(s.torso.half[0] * 2, s.torso.half[1] * 1.9, s.torso.half[2] * 2), COAT, 0.72);
    parts.push(torso);
    const neck = partMesh(new THREE.CylinderGeometry(0.06, 0.09, 0.22, 8), COAT_DARK, 0.74);
    neck.position.set(0, 0.14, 0.38);
    neck.rotation.x = -0.8;
    torso.add(neck);
    const head = partMesh(new THREE.BoxGeometry(0.16, 0.15, 0.19), COAT, 0.7);
    head.position.set(0, 0.25, 0.5);
    torso.add(head);
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2a4).multiplyScalar(LIGHT_SCALE * 0.18), transparent: true, opacity: 0.92, depthWrite: false, blending: THREE.AdditiveBlending });
    eyeMat.toneMapped = false;
    for (const ex of [-0.05, 0.05]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), eyeMat);
      eye.position.set(ex, 0.03, 0.1);
      head.add(eye);
    }
    const snout = partMesh(new THREE.BoxGeometry(0.08, 0.07, 0.1), COAT_DARK, 0.76);
    snout.position.set(0, -0.02, 0.14);
    head.add(snout);
    const nose = partMesh(new THREE.BoxGeometry(0.035, 0.03, 0.03), 0x241408, 0.5);
    nose.position.set(0, 0.005, 0.06);
    snout.add(nose);
    // floppy ears
    for (const ex of [-0.085, 0.085]) {
      const ear = partMesh(new THREE.BoxGeometry(0.05, 0.11, 0.03), COAT_DARK, 0.85);
      ear.position.set(ex, 0.05, -0.01);
      ear.rotation.z = ex > 0 ? -0.45 : 0.45;
      head.add(ear);
    }
    // wagging-height tail (static mesh; the ragdoll's bounce animates it plenty)
    const tail = partMesh(new THREE.CylinderGeometry(0.012, 0.035, 0.26, 6), COAT_DARK, 0.85);
    tail.position.set(0, 0.14, -0.44);
    tail.rotation.x = 0.85;
    torso.add(tail);
    // chest patch
    const patch = partMesh(new THREE.BoxGeometry(0.14, 0.1, 0.05), 0xf0e3c8, 0.8);
    patch.position.set(0, -0.05, 0.4);
    torso.add(patch);
    for (const leg of s.legs) {
      const thigh = partMesh(new THREE.CapsuleGeometry(leg.thigh.radius, leg.thigh.halfHeight * 2, 4, 8), COAT_DARK, 0.78);
      parts.push(thigh);
      const shank = partMesh(new THREE.CapsuleGeometry(leg.shank.radius, leg.shank.halfHeight * 2, 4, 8), COAT_DARK, 0.78);
      const paw = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.1, leg.shank.radius * 0.95, 0.06, 8), 0xf0e3c8, 0.7);
      paw.position.set(0, -leg.shank.halfHeight - 0.015, 0);
      shank.add(paw);
      parts.push(shank);
    }
    return parts;
  }

  #poseMesh(mesh: THREE.Mesh, link: Link, oy: number): void {
    mesh.position.set(PUP_CENTER.x + link.pos[0], oy + link.pos[1], PUP_CENTER.z + link.pos[2]);
    mesh.quaternion.set(link.quat[0], link.quat[1], link.quat[2], link.quat[3]);
  }

  // ------------------------------------------------------------- per frame
  update(dt: number, camera: THREE.Camera): void {
    if (!this.#awake || !this.#rag) return;
    const rag = this.#rag;

    // a tumbled pup lies limp for a moment, then pops back up and tries again
    if (this.#downTimer > 0) {
      this.#downTimer -= dt;
      rag.update(dt);
      if (this.#downTimer <= 0) {
        rag.setDowned(false);
        rag.reset();
      }
    } else if (rag.fallen) {
      this.#downTimer = DOWN_SECONDS;
      rag.setDowned(true);
    } else {
      // wander inside the pen: eased heading + walk-biased gait speeds
      this.#wanderTimer -= dt;
      const t = rag.torsoLink;
      if (Math.hypot(t.pos[0], t.pos[2]) > ROAM_R) {
        this.#wanderYaw = Math.atan2(-t.pos[0], -t.pos[2]);
        this.#wanderTimer = 2 + Math.random() * 2;
      } else if (this.#wanderTimer <= 0) {
        this.#wanderYaw += (Math.random() - 0.5) * 1.5;
        this.#wanderTimer = 3 + Math.random() * 4;
        const r = Math.random();
        this.#speedNonDim = r < 0.72 ? 0.16 + Math.random() * 0.18 : 0.4 + Math.random() * 0.2;
      }
      const tx = Math.sin(this.#wanderYaw);
      const tz = Math.cos(this.#wanderYaw);
      const k = 1 - Math.exp(-dt / GOAL_EASE);
      this.#gx += (tx - this.#gx) * k;
      this.#gz += (tz - this.#gz) * k;
      rag.setGoal(this.#gx, this.#gz);
      rag.setSpeed(this.#speedNonDim);
      rag.update(dt);
    }

    // track the meshes to the ragdoll
    const oy = this.#groundY + 0.06; // atop the lawn pad
    this.#poseMesh(this.#parts[0], rag.torsoLink, oy);
    const legs = rag.legLinks;
    for (let i = 0; i < legs.length; i++) {
      this.#poseMesh(this.#parts[1 + i * 2], legs[i].thigh, oy);
      this.#poseMesh(this.#parts[2 + i * 2], legs[i].shank, oy);
    }
    this.#updateBrain(camera);
  }

  #updateBrain(camera: THREE.Camera): void {
    const b = this.#brain;
    const rag = this.#rag;
    if (!b || !rag) return;
    const layers = rag.layers();
    for (let v = 0; v < b.lineLayer.length; v++) {
      writeActivationColor(b.lineColors, v * 3, layers[b.lineLayer[v]][b.lineNode[v]], b.lineLayer[v], BRAIN_LINE_GLOW);
    }
    for (let v = 0; v < b.pointLayer.length; v++) {
      const layer = b.pointLayer[v];
      setActivationColor(this.#nodeColor, layers[layer][b.pointNode[v]], layer, BRAIN_NODE_GLOW);
      b.nodes.setColorAt(v, this.#nodeColor);
      this.#haloColor.copy(this.#nodeColor).multiplyScalar(0.68);
      b.halos.setColorAt(v, this.#haloColor);
    }
    b.lineAttr.needsUpdate = true;
    if (b.nodes.instanceColor) b.nodes.instanceColor.needsUpdate = true;
    if (b.halos.instanceColor) b.halos.instanceColor.needsUpdate = true;
    camera.getWorldPosition(this.#camPos);
    const t = rag.torsoLink;
    const wx = PUP_CENTER.x + t.pos[0];
    const wy = this.#groundY + 0.06 + t.pos[1];
    const wz = PUP_CENTER.z + t.pos[2];
    const yaw = Math.atan2(this.#camPos.x - wx, this.#camPos.z - wz);
    b.group.position.set(wx, wy + 0.55 * this.#scale + 0.38, wz);
    b.group.rotation.set(-0.18, yaw + 0.22, 0);
  }
}

export function createPupPen(map: WorldMap, physics: Physics, scene: THREE.Scene): PupPen {
  return new PupPen(map, physics, scene);
}
