import * as THREE from "three/webgpu";
import { BodyType } from "box3d-wasm";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import type { PolicyDef } from "../../creatures/policy";
import { HORSE, type CreatureSpec, type Link } from "../../creatures/quadruped";
import { HorseTrainingGuide } from "../../ui/horseTrainingGuide";
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
// show-jumping course: a ring of gates the horses run at and hop
const GATE_COUNT = 5;
const GATE_RING_R = 46; // gates in a ring, well inside ROAM
const GATE_APPROACH_R = 20; // start seeking a gate within this range
const GATE_JUMP_DIST = 5.5; // hop the rail when this close
const DOWN_SECONDS = 10; // a fallen horse lies where it landed this long before getting back up
const GOAL_EASE = 0.45; // seconds — goal-direction smoothing time constant (gentler turns = fewer tip-overs)
const SCALE = 2.3; // horse-sized vs the ~1.7m human (real horses tower over people)
const BRAIN_SCALE = 1.9;
const BRAIN_LINE_GLOW = LIGHT_SCALE * 0.14;
const BRAIN_NODE_GLOW = LIGHT_SCALE * 0.34;
const BRAIN_NODE_RADIUS = 0.045;
const BRAIN_HALO_RADIUS = 0.11;
const BRAIN_LAYER_GAP = 0.72;
const BRAIN_LAYER_HEIGHT = 1.42;
const BRAIN_LAYER_DEPTH = 0.86;

const LAYER_COLORS = [0x12a8ff, 0x38d8ff, 0x8d67ff, 0xff8d2a] as const;

type Brain = {
  group: THREE.Group;
  line: THREE.LineSegments;
  nodes: THREE.InstancedMesh;
  halos: THREE.InstancedMesh;
  lineColors: Float32Array;
  lineAttr: THREE.BufferAttribute;
  lineLayer: Uint8Array; // which activation layer each line vertex belongs to
  lineNode: Uint16Array; // which node within that layer
  pointLayer: Uint8Array;
  pointNode: Uint16Array;
};
type HorseMeshes = { group: THREE.Group; parts: THREE.Mesh[]; brain: Brain };
type Horse = {
  rag: HorseRagdoll;
  m: HorseMeshes;
  anchor: { x: number; z: number };
  wanderYaw: number;
  wanderTimer: number;
  speedNonDim: number; // commanded gait speed (Froude): walk-biased while roaming
  gx: number; gz: number; // smoothed goal direction (eased toward target so turns are gradual)
  gateCd: number; // cooldown after hopping a gate, so it doesn't re-trigger mid-air
  downTimer: number; // >0 = lying where it fell, counting down before it gets back up
  wx: number; wy: number; wz: number;
  wq: [number, number, number, number];
};

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

function glowMaterial(color: number, intensity: number, opacity = 1): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    transparent: opacity < 1,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  mat.toneMapped = false;
  return mat;
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

type HorseHerdOptions = { onGuideToggle?: (open: boolean) => void };

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
  #riddenSpeed = 0.55; // rider's commanded gait (Froude): trot by default, ramps toward gallop
  #forceSpeed: number | null = null; // debug/verify: command every horse this gait speed
  #gates: { x: number; z: number }[] = []; // show-jumping course centers
  #camPos = new THREE.Vector3();
  #worker: Worker | null = null;
  #training = false;
  #onProgress: ((p: { gen: number; fitness: number; best: number }) => void) | null = null;
  #nodeColor = new THREE.Color();
  #haloColor = new THREE.Color();
  #guide: HorseTrainingGuide;

  constructor(physics: Physics, _map: WorldMap, scene: THREE.Scene, opts: HorseHerdOptions = {}) {
    this.#box3d = physics.box3d;
    this.#world = physics.world;
    this.#scene = scene;
    this.#guide = new HorseTrainingGuide(new THREE.Vector3(PARK.x, PLATFORM_Y + 9.5, PARK.z), opts.onGuideToggle);
    this.#buildPlatform();
    this.#buildGates();
    void this.#load();
  }

  get platformY(): number { return PLATFORM_Y; }
  /** Paddock centre in world space (for camera framing / headless verify). */
  get paddockCenter(): { x: number; y: number; z: number } { return { x: PARK.x, y: PLATFORM_Y, z: PARK.z }; }
  /** Ground-truth per-horse pose for headless verification (the ACTUAL in-world
   *  sim that drives the render — up.y, height fraction of standing, down timer). */
  debugStates(): { upY: number; tall: number; down: number; fallen: boolean; speed: number }[] {
    return this.#horses.map((h) => {
      const t = h.rag.torsoLink;
      const q = t.quat;
      const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
      return { upY, tall: t.pos[1] / h.rag.standY, down: h.downTimer, fallen: h.rag.fallen, speed: Math.hypot(t.vel[0], t.vel[2]) };
    });
  }
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
    const grass = new THREE.Mesh(
      new THREE.CircleGeometry(PLATFORM_R, 64),
      new THREE.MeshStandardMaterial({
        color: 0x7fae45,
        roughness: 0.88,
        emissive: 0x1d3812,
        emissiveIntensity: 0.04 * LIGHT_SCALE
      })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(PARK.x, PLATFORM_Y + 0.02, PARK.z);
    grass.receiveShadow = true;
    this.#scene.add(grass);
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(PLATFORM_R, PLATFORM_R * 0.98, 3, 64, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x526f2d, roughness: 0.95, emissive: 0x16220d, emissiveIntensity: 0.025 * LIGHT_SCALE })
    );
    rim.position.set(PARK.x, PLATFORM_Y - 1.5, PARK.z);
    this.#scene.add(rim);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(PLATFORM_R * 0.985, 0.2, 8, 128),
      glowMaterial(0xb5ff76, LIGHT_SCALE * 0.045, 0.58)
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(PARK.x, PLATFORM_Y + 0.12, PARK.z);
    this.#scene.add(ring);
  }

  /** A ring of show-jumping gates (two standards + striped rails) the horses run at and hop. */
  #buildGates(): void {
    for (let i = 0; i < GATE_COUNT; i++) {
      const th = (i / GATE_COUNT) * Math.PI * 2;
      const gx = PARK.x + Math.sin(th) * GATE_RING_R;
      const gz = PARK.z + Math.cos(th) * GATE_RING_R;
      const yaw = th + Math.PI / 2; // rail tangent to the ring
      const railTop = 0.6 + (i % 3) * 0.14; // varied heights: walk / trot / gallop sized
      this.#buildGate(gx, gz, yaw, railTop);
      this.#gates.push({ x: gx, z: gz });
    }
  }

  #buildGate(gx: number, gz: number, yaw: number, railTop: number): void {
    const ax = Math.cos(yaw); // rail axis in world X
    const az = Math.sin(yaw); // rail axis in world Z
    const halfW = 1.2;
    const postH = railTop + 0.4;
    const postMat = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.62, emissive: 0x30302a, emissiveIntensity: 0.045 * LIGHT_SCALE });
    const postGeo = new THREE.BoxGeometry(0.16, postH, 0.16);
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(postGeo, postMat);
      p.position.set(gx + ax * halfW * s, PLATFORM_Y + postH / 2, gz + az * halfW * s);
      p.castShadow = true;
      this.#scene.add(p);
    }
    // horizontal poles, classic red/white show-jump colours
    const railGeo = new THREE.BoxGeometry(halfW * 2 + 0.18, 0.12, 0.12);
    const rails = [
      { h: railTop, c: 0xf4f1e8 },
      { h: railTop - 0.3, c: 0xc0392b },
      { h: railTop - 0.6, c: 0xf4f1e8 }
    ];
    for (const r of rails) {
      if (r.h < 0.16) continue;
      const rail = new THREE.Mesh(railGeo, new THREE.MeshStandardMaterial({ color: r.c, roughness: 0.55, emissive: new THREE.Color(r.c).multiplyScalar(0.14), emissiveIntensity: 0.05 * LIGHT_SCALE }));
      rail.position.set(gx, PLATFORM_Y + r.h, gz);
      rail.rotation.y = -yaw;
      rail.castShadow = true;
      this.#scene.add(rail);
    }
    // loose collider so the PLAYER has to jump it too (horses live in private worlds, no collision)
    this.#world.createBox({
      type: BodyType.Static,
      position: [gx, PLATFORM_Y + railTop * 0.5, gz],
      halfExtents: [Math.abs(ax) * halfW + 0.2, railTop * 0.5 + 0.1, Math.abs(az) * halfW + 0.2],
      friction: 0.6
    });
  }

  /** Nearest gate that's within range AND roughly ahead of a heading (hx,hz). */
  #gateAhead(wx: number, wz: number, hx: number, hz: number): { x: number; z: number; d: number } | null {
    let best: { x: number; z: number; d: number } | null = null;
    let bd = GATE_APPROACH_R;
    for (const g of this.#gates) {
      const dx = g.x - wx;
      const dz = g.z - wz;
      const d = Math.hypot(dx, dz);
      if (d > GATE_APPROACH_R || d < 0.4) continue;
      if ((dx / d) * hx + (dz / d) * hz < 0.25) continue; // must be roughly ahead
      if (d < bd) {
        bd = d;
        best = { x: g.x, z: g.z, d };
      }
    }
    return best;
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
    const torso = partMesh(new THREE.BoxGeometry(s.torso.half[0] * 2, s.torso.half[1] * 1.9, s.torso.half[2] * 2), 0x9a6538, 0.68);
    torso.scale.setScalar(SCALE); // base geometry, scaled to horse size; children (neck/head/…) inherit
    parts.push(torso);
    // neck, head, ears, muzzle, mane, tail — children of the torso mesh so they
    // ride its RL pose. Local axes: x = right, y = up, z = forward (nose).
    const neck = partMesh(new THREE.CylinderGeometry(0.07, 0.12, 0.44, 8), 0x81512e, 0.72);
    neck.position.set(0, 0.24, 0.5); neck.rotation.x = -0.95; torso.add(neck);
    const head = partMesh(new THREE.BoxGeometry(0.13, 0.16, 0.3), 0x81512e, 0.72);
    head.position.set(0, 0.44, 0.74); head.rotation.x = -0.35; torso.add(head);
    const eyeMat = glowMaterial(0xfff2a4, LIGHT_SCALE * 0.18, 0.92);
    for (const sx of [-0.055, 0.055]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.017, 8, 6), eyeMat);
      eye.position.set(sx, 0.035, 0.13);
      head.add(eye);
    }
    const muzzle = partMesh(new THREE.BoxGeometry(0.1, 0.1, 0.14), 0x69442c, 0.78);
    muzzle.position.set(0, 0.4, 0.9); torso.add(muzzle);
    for (const sx of [-0.05, 0.05]) {
      const ear = partMesh(new THREE.ConeGeometry(0.035, 0.1, 6), 0x3b2716, 0.9);
      ear.position.set(sx, 0.56, 0.68); torso.add(ear);
    }
    const mane = partMesh(new THREE.BoxGeometry(0.04, 0.3, 0.42), 0x241408, 0.95);
    mane.position.set(0, 0.28, 0.52); mane.rotation.x = -0.95; torso.add(mane);
    const tail = partMesh(new THREE.CylinderGeometry(0.015, 0.06, 0.44, 6), 0x241408, 0.95);
    tail.position.set(0, 0.16, -0.56); tail.rotation.x = 0.7; torso.add(tail);
    const blanket = partMesh(new THREE.BoxGeometry(0.5, 0.035, 0.5), 0x15a6b0, 0.42);
    blanket.position.set(0, 0.17, -0.03);
    torso.add(blanket);
    const saddle = partMesh(new THREE.BoxGeometry(0.36, 0.045, 0.32), 0x2b1a12, 0.58);
    saddle.position.set(0, 0.205, -0.06);
    torso.add(saddle);
    for (const leg of s.legs) {
      const thigh = partMesh(new THREE.CapsuleGeometry(leg.thigh.radius, leg.thigh.halfHeight * 2, 4, 8), 0x754727, 0.76);
      thigh.scale.setScalar(SCALE);
      parts.push(thigh);
      const shank = partMesh(new THREE.CapsuleGeometry(leg.shank.radius, leg.shank.halfHeight * 2, 4, 8), 0x754727, 0.76);
      shank.scale.setScalar(SCALE);
      const sock = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.04, leg.shank.radius * 1.08, 0.15, 8), 0xf0dcc0, 0.64);
      sock.position.set(0, -leg.shank.halfHeight * 0.48, 0);
      shank.add(sock);
      const hoof = partMesh(new THREE.CylinderGeometry(leg.shank.radius * 1.15, leg.shank.radius * 0.9, 0.06, 8), 0x141010, 0.6);
      hoof.position.set(0, -leg.shank.halfHeight - 0.02, 0); shank.add(hoof);
      parts.push(shank);
    }
    return parts;
  }

  /**
   * The activation "brain": layers of nodes as curved 3D columns, joined by
   * soft additive lines. Fixed geometry; only per-vertex colour changes each frame.
   */
  #buildBrain(sizes: number[]): Brain {
    const nL = sizes.length;
    const layerX = (li: number) => (li - (nL - 1) / 2) * BRAIN_LAYER_GAP;
    const nodePos = (li: number, j: number, out: number[]) => {
      const n = sizes[li];
      const cols = li === 0 || li === nL - 1 ? 1 : 4;
      const rows = Math.ceil(n / cols);
      const col = j % cols;
      const row = Math.floor(j / cols);
      const dz = cols <= 1 ? 0 : (col / (cols - 1) - 0.5) * BRAIN_LAYER_DEPTH;
      const dy = rows <= 1 ? 0 : (0.5 - row / (rows - 1)) * BRAIN_LAYER_HEIGHT;
      const curve = Math.sin((row + 1) * 0.68 + li * 0.9) * 0.025;
      out.push(
        layerX(li),
        dy,
        dz + curve
      );
    };
    const linePos: number[] = [];
    const pointPos: number[] = [];
    const lineLayer: number[] = [];
    const lineNode: number[] = [];
    const pointLayer: number[] = [];
    const pointNode: number[] = [];
    const addVert = (li: number, j: number) => { nodePos(li, j, linePos); lineLayer.push(li); lineNode.push(j); };
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
      // In-layer lattice: vertical rails plus cross-depth rows make the layer read as a volume.
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
      // Adjacent layers get dense wiring like the reference. The policy is small
      // enough that full connections are still cheap here.
      if (li + 1 < nL) {
        const n = sizes[li], m = sizes[li + 1];
        for (let j = 0; j < n; j++) {
          for (let b = 0; b < m; b++) addEdge(li, j, li + 1, b);
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

    const nodeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      depthWrite: false
    });
    nodeMat.depthTest = false;
    nodeMat.toneMapped = false;
    const nodes = new THREE.InstancedMesh(new THREE.SphereGeometry(BRAIN_NODE_RADIUS, 10, 8), nodeMat, pointLayer.length);
    nodes.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    nodes.frustumCulled = false;
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    haloMat.depthTest = false;
    haloMat.toneMapped = false;
    const halos = new THREE.InstancedMesh(new THREE.SphereGeometry(BRAIN_HALO_RADIUS, 10, 8), haloMat, pointLayer.length);
    halos.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    halos.frustumCulled = false;
    const nodeM = new THREE.Matrix4();
    const nodePosV = new THREE.Vector3();
    const nodeQuat = new THREE.Quaternion();
    const nodeScale = new THREE.Vector3();
    const seedColor = new THREE.Color();
    for (let i = 0; i < pointLayer.length; i++) {
      const i3 = i * 3;
      nodePosV.set(pointPos[i3], pointPos[i3 + 1], pointPos[i3 + 2]);
      const layerBoost = pointLayer[i] === 0 || pointLayer[i] === nL - 1 ? 1.12 : 1;
      nodeM.compose(nodePosV, nodeQuat, nodeScale.setScalar(layerBoost));
      nodes.setMatrixAt(i, nodeM);
      halos.setMatrixAt(i, nodeM);
      seedColor.setRGB(0.35, 0.85, 1.1);
      nodes.setColorAt(i, seedColor);
      halos.setColorAt(i, seedColor);
    }
    nodes.instanceMatrix.needsUpdate = true;
    halos.instanceMatrix.needsUpdate = true;
    nodes.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    halos.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true;
    if (halos.instanceColor) halos.instanceColor.needsUpdate = true;

    const group = new THREE.Group();
    group.add(line, halos, nodes);
    group.scale.setScalar(BRAIN_SCALE);
    return {
      group,
      line,
      nodes,
      halos,
      lineColors: lineColArr,
      lineAttr,
      lineLayer: Uint8Array.from(lineLayer),
      lineNode: Uint16Array.from(lineNode),
      pointLayer: Uint8Array.from(pointLayer),
      pointNode: Uint16Array.from(pointNode)
    };
  }

  #buildMeshes(sizes: number[]): HorseMeshes {
    const group = new THREE.Group();
    const parts = this.#buildDressedHorse();
    for (const p of parts) group.add(p);
    const brain = this.#buildBrain(sizes);
    this.#scene.add(group);
    this.#scene.add(brain.group);
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
      this.#horses.push({ rag, m, anchor, wanderYaw: yaw, wanderTimer: 2 + Math.random() * 4, speedNonDim: 0.2 + Math.random() * 0.25, gx: Math.sin(yaw), gz: Math.cos(yaw), gateCd: 0, downTimer: 0, wx: anchor.x, wy: PLATFORM_Y, wz: anchor.z, wq: [0, 0, 0, 1] });
    }
  }

  prePhysics(dt: number): void {
    if (!this.#ready) return;
    for (let idx = 0; idx < this.#horses.length; idx++) {
      const h = this.#horses[idx];
      // Down: a fallen horse lies limp where it landed for DOWN_SECONDS, THEN
      // gets back up (rather than vanishing/snapping upright the instant it trips).
      if (h.downTimer > 0) {
        h.downTimer -= dt;
        h.rag.update(dt); // limp — no policy control while downed
        if (h.downTimer <= 0) { h.rag.setDowned(false); h.rag.reset(); }
        continue;
      }
      if (h.rag.fallen) {
        h.downTimer = DOWN_SECONDS;
        h.rag.setDowned(true);
        if (idx === this.#ridden) this.#ridden = -1; // throw the rider when the mount goes down
        continue;
      }
      // Pick this horse's TARGET heading (rider's steer, or wandering yaw) + gait speed...
      let tx: number, tz: number, spd: number;
      if (idx === this.#ridden) {
        tx = -Math.sin(this.#steerYaw);
        tz = -Math.cos(this.#steerYaw);
        spd = this.#riddenSpeed; // rider's throttle (walk..gallop)
      } else {
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
          // re-pick a roaming gait (REACHABLE Froude units): mostly a calm WALK,
          // sometimes a trot, occasionally a canter (body tops out ~0.85).
          const r = Math.random();
          h.speedNonDim = r < 0.7 ? 0.2 + Math.random() * 0.2 : r < 0.93 ? 0.45 + Math.random() * 0.15 : 0.7 + Math.random() * 0.15;
        }
        tx = Math.sin(h.wanderYaw);
        tz = Math.cos(h.wanderYaw);
        spd = h.speedNonDim;
        // show-jumping: if a gate is close and ahead, run straight at it and hop the rail
        if (h.gateCd > 0) h.gateCd -= dt;
        const ga = this.#gateAhead(wx, wz, tx, tz);
        if (ga && h.gateCd <= 0) {
          tx = (ga.x - wx) / ga.d;
          tz = (ga.z - wz) / ga.d;
          spd = 0.62; // committed canter to clear the rail
          if (ga.d < GATE_JUMP_DIST && h.rag.grounded) {
            h.rag.jump();
            h.gateCd = 4;
          }
        }
      }
      // ...then ease the actual goal toward it so heading changes are GRADUAL. A
      // hard instant goal snap makes the policy crank a sharp turn and tip over.
      const k = 1 - Math.exp(-dt / GOAL_EASE);
      h.gx += (tx - h.gx) * k;
      h.gz += (tz - h.gz) * k;
      h.rag.setGoal(h.gx, h.gz); // setGoal normalizes
      h.rag.setSpeed(this.#forceSpeed ?? spd);
      h.rag.update(dt);
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
  /** Rider throttle → commanded gait speed (Froude units: ~0.5 walk .. ~2.2 gallop). */
  setRiddenSpeed(nonDim: number): void { this.#riddenSpeed = Math.max(0, Math.min(0.9, nonDim)); }
  /** Verify/demo: force EVERY horse to one gait speed (null = back to per-horse roaming). */
  debugForceSpeed(nonDim: number | null): void { this.#forceSpeed = nonDim; }
  /** Make the ridden horse jump (rider pressed jump). */
  jumpRidden(): void { if (this.#ridden >= 0) this.#horses[this.#ridden].rag.jump(); }
  /** Verify/demo: every up horse hops at once. */
  debugJumpAll(): void { for (const h of this.#horses) if (h.downTimer <= 0) h.rag.jump(); }
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
    this.#guide.update(camera, this.#camPos);
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
    }
    for (const h of this.#horses) this.#updateBrain(h);
  }

  #updateBrain(h: Horse): void {
    const b = h.m.brain;
    const layers = h.rag.layers();
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
    // Float above the horse. The graph is angled for real depth and faces the camera.
    const yaw = Math.atan2(this.#camPos.x - h.wx, this.#camPos.z - h.wz);
    b.group.position.set(h.wx, h.wy + 1.92 * SCALE, h.wz);
    b.group.rotation.set(-0.18, yaw + 0.22, Math.sin(h.wx * 0.013 + h.wz * 0.017) * 0.035);
  }
}
