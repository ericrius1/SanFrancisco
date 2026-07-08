import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import type { Box3D } from "../../core/box3dWorld";
import type { PolicyDef } from "../../creatures/policy";
import { HORSE, type CreatureSpec, type Link } from "../../creatures/quadruped";
import { GARDEN_MEADOW, gardenSurfaceHeight } from "../../world/garden/layout";
import { HorseRagdoll } from "./horseRagdoll";
import type { InspectableBrain } from "../../ui/brainPanel/types";

// obs/action layout mirrors src/creatures/quadruped.ts observe()/decode().
function horseInputLabels(nLeg: number): string[] {
  const L = ["up.x", "up.y", "up.z", "goal.x", "goal.z", "vel.x", "vel.y", "vel.z", "angV.x", "angV.y", "angV.z", "height", "cpg.sin", "cpg.cos"];
  for (let i = 0; i < nLeg; i++) L.push(`thighPitch[${i}]`);
  for (let i = 0; i < nLeg; i++) L.push(`kneeAngle[${i}]`);
  L.push("targetSpeed");
  return L;
}
function horseOutputLabels(nLeg: number): string[] {
  const L = ["freqMod", "hipAmp", "kneeAmp"];
  for (let i = 0; i < nLeg; i++) L.push(`hipBias[${i}]`);
  for (let i = 0; i < nLeg; i++) L.push(`phase[${i}]`);
  L.push("turn", "pitch");
  return L;
}

/**
 * A small herd of RL horses grazing/walking the Botanical Garden meadow. Each is
 * a live box3d ragdoll (its own private, flat-ground world) running the trained
 * gait policy every frame, drawn as a dressed-up capsule horse that tracks the
 * ragdoll — so what you see is the neural net physically walking the body — and
 * wearing its live network activations as a glowing lattice of nodes overhead.
 *
 * Unlike the branch's floating show-jumping platform, this herd stands on the
 * REAL garden meadow (ground Y from the garden surface height) and wanders a
 * bounded ellipse inside the meadow so it never blunders into the trees. It's an
 * ambient, deterministic system: every client runs the same herd locally, so it
 * needs no net sync to look alive for everyone.
 */

const CENTER = { x: GARDEN_MEADOW.x, z: GARDEN_MEADOW.z };
const ROAM_RX = 90; // wander bounds inside the 130×95 meadow (leaves a tree margin)
const ROAM_RZ = 65;
const COUNT = 8;
const DOWN_SECONDS = 8; // a fallen horse lies where it landed this long before getting back up
const GOAL_EASE = 0.45; // seconds — goal-direction smoothing (gentler turns = fewer tip-overs)
const SCALE = 2.3; // horse-sized vs the ~1.7 m human (real horses tower over people)
// Only simulate the ragdolls + light the brains when a player is near the meadow;
// the herd is a long way from most of the map, so it costs nothing when nobody's
// around (physics frozen, meshes/brains left at their last pose).
const SIM_RANGE = 380;

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

// Cached palette: the brain overlay touches tens of thousands of line-vertices
// per frame across the herd — allocating a THREE.Color each time was the whole
// overlay cost. Precompute one Color per layer and reuse it.
const LAYER_COLOR_CACHE = LAYER_COLORS.map((c) => new THREE.Color(c));
function layerColor(layer: number): THREE.Color {
  return LAYER_COLOR_CACHE[Math.min(LAYER_COLOR_CACHE.length - 1, layer)];
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

export class HorseHerd {
  #box3d: Box3D;
  #scene: THREE.Scene;
  #map: WorldMap;
  #spec: CreatureSpec = HORSE;
  #policyDef: PolicyDef | null = null;
  #horses: Horse[] = [];
  #ready = false;
  #active = false; // is a player near enough to simulate?
  #camPos = new THREE.Vector3();
  #nodeColor = new THREE.Color();
  #haloColor = new THREE.Color();
  #frame = 0;

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    this.#box3d = physics.box3d;
    this.#map = map;
    this.#scene = scene;
    void this.#load();
  }

  get center(): { x: number; z: number } { return CENTER; }
  get count(): number { return this.#horses.length; }
  get active(): boolean { return this.#active; }

  /** Brains the player can click to inspect — only while the herd is simulated
   *  (near the player; otherwise the brains are frozen/hidden). */
  inspectables(): InspectableBrain[] {
    if (!this.#ready || !this.#active) return [];
    const out: InspectableBrain[] = [];
    for (let i = 0; i < this.#horses.length; i++) {
      const h = this.#horses[i];
      const nLeg = h.rag.spec.legs.length;
      const grp = h.m.brain.group;
      const rag = h.rag;
      out.push({
        id: `horse:${i}`,
        label: `RL Horse #${i}`,
        getWorldPos: (o) => o.copy(grp.position),
        pickRadius: 1.8,
        net: rag.brain,
        liveObs: () => rag.obs,
        inputLabels: horseInputLabels(nLeg),
        outputLabels: horseOutputLabels(nLeg)
      });
    }
    return out;
  }

  /** Ground-truth per-horse pose for headless verification (the ACTUAL in-world
   *  sim that drives the render — up.y, height fraction of standing, world XZ). */
  debugStates(): { upY: number; tall: number; down: number; fallen: boolean; speed: number; wx: number; wz: number; wy: number }[] {
    return this.#horses.map((h) => {
      const t = h.rag.torsoLink;
      const q = t.quat;
      const upY = 1 - 2 * (q[0] * q[0] + q[2] * q[2]);
      return {
        upY,
        tall: t.pos[1] / h.rag.standY,
        down: h.downTimer,
        fallen: h.rag.fallen,
        speed: Math.hypot(t.vel[0], t.vel[2]),
        wx: h.wx,
        wz: h.wz,
        wy: h.wy
      };
    });
  }

  async #load(): Promise<void> {
    // the ~0.9 m/s pretrained gait; fall back to the plain checkpoint if absent
    for (const url of ["/models/horse_policy.good.json", "/models/horse_policy.json"]) {
      try {
        this.#policyDef = (await (await fetch(url, { cache: "no-store" })).json()) as PolicyDef;
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (!this.#policyDef) {
      console.warn("[horse] no trained policy found (public/models/horse_policy.good.json)");
      return;
    }
    this.#spawn();
    this.#ready = true;
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
      // scatter within the meadow ellipse (sqrt keeps them area-uniform, not
      // clumped at the centre), staying well inside the tree line
      const a = (i / COUNT) * Math.PI * 2 + Math.random() * 0.8;
      const r = Math.sqrt(0.12 + Math.random() * 0.72);
      const anchor = { x: CENTER.x + Math.cos(a) * ROAM_RX * r, z: CENTER.z + Math.sin(a) * ROAM_RZ * r };
      const rag = new HorseRagdoll(this.#box3d, this.#spec, this.#policyDef!, SCALE);
      const yaw = Math.random() * Math.PI * 2;
      rag.setGoal(Math.sin(yaw), Math.cos(yaw));
      const m = this.#buildMeshes(rag.layers().map((l) => l.length));
      const wy = gardenSurfaceHeight(this.#map, anchor.x, anchor.z);
      this.#horses.push({
        rag, m, anchor, wanderYaw: yaw, wanderTimer: 2 + Math.random() * 4,
        speedNonDim: 0.2 + Math.random() * 0.25, gx: Math.sin(yaw), gz: Math.cos(yaw),
        downTimer: 0, wx: anchor.x, wy, wz: anchor.z, wq: [0, 0, 0, 1]
      });
    }
  }

  /** Fixed-step: run each ragdoll's private sim + steer its wander. Gated: only
   *  simulates when a player is within SIM_RANGE of the meadow (else frozen). */
  prePhysics(dt: number, playerPos: THREE.Vector3): void {
    if (!this.#ready) return;
    const dcx = playerPos.x - CENTER.x;
    const dcz = playerPos.z - CENTER.z;
    this.#active = dcx * dcx + dcz * dcz < SIM_RANGE * SIM_RANGE;
    if (!this.#active) return;
    for (const h of this.#horses) {
      // Down: a fallen horse lies limp where it landed for DOWN_SECONDS, THEN gets
      // back up (rather than snapping upright the instant it trips).
      if (h.downTimer > 0) {
        h.downTimer -= dt;
        h.rag.update(dt); // limp — no policy control while downed
        if (h.downTimer <= 0) { h.rag.setDowned(false); h.rag.reset(); }
        continue;
      }
      if (h.rag.fallen) {
        h.downTimer = DOWN_SECONDS;
        h.rag.setDowned(true);
        continue;
      }
      // wander: keep inside the meadow ellipse, else re-pick a calm walk-biased gait
      h.wanderTimer -= dt;
      const t = h.rag.torsoLink;
      const wx = h.anchor.x + t.pos[0];
      const wz = h.anchor.z + t.pos[2];
      const ex = (wx - CENTER.x) / ROAM_RX;
      const ez = (wz - CENTER.z) / ROAM_RZ;
      if (ex * ex + ez * ez > 1) {
        // steer back toward the meadow centre
        h.wanderYaw = Math.atan2(CENTER.x - wx, CENTER.z - wz);
        h.wanderTimer = 2 + Math.random() * 3;
      } else if (h.wanderTimer <= 0) {
        h.wanderYaw += (Math.random() - 0.5) * 1.6;
        h.wanderTimer = 3 + Math.random() * 5;
        // re-pick a roaming gait (REACHABLE Froude units): mostly a calm WALK,
        // sometimes a trot, occasionally a canter (body tops out ~0.85).
        const r = Math.random();
        h.speedNonDim = r < 0.7 ? 0.2 + Math.random() * 0.2 : r < 0.93 ? 0.45 + Math.random() * 0.15 : 0.7 + Math.random() * 0.15;
      }
      const tx = Math.sin(h.wanderYaw);
      const tz = Math.cos(h.wanderYaw);
      // ease the actual goal toward the target so heading changes are GRADUAL — a
      // hard snap makes the policy crank a sharp turn and tip over.
      const k = 1 - Math.exp(-dt / GOAL_EASE);
      h.gx += (tx - h.gx) * k;
      h.gz += (tz - h.gz) * k;
      h.rag.setGoal(h.gx, h.gz); // setGoal normalizes
      h.rag.setSpeed(h.speedNonDim);
      h.rag.update(dt);
    }
  }

  #poseMesh(mesh: THREE.Mesh, link: Link, ox: number, oy: number, oz: number): void {
    mesh.position.set(ox + link.pos[0], oy + link.pos[1], oz + link.pos[2]);
    mesh.quaternion.set(link.quat[0], link.quat[1], link.quat[2], link.quat[3]);
  }

  /** Per-frame: track the meshes to the ragdolls (on the meadow surface) + light
   *  up the brains. Skipped entirely when no player is near (see prePhysics gate). */
  update(_dt: number, camera: THREE.Camera): void {
    if (!this.#ready || !this.#active) return;
    this.#frame++;
    camera.getWorldPosition(this.#camPos);
    for (const h of this.#horses) {
      const t = h.rag.torsoLink;
      const ox = h.anchor.x;
      const oz = h.anchor.z;
      const wx = ox + t.pos[0];
      const wz = oz + t.pos[2];
      const oy = gardenSurfaceHeight(this.#map, wx, wz); // follow the meadow surface
      h.wx = wx; h.wy = oy + t.pos[1]; h.wz = wz;
      h.wq[0] = t.quat[0]; h.wq[1] = t.quat[1]; h.wq[2] = t.quat[2]; h.wq[3] = t.quat[3];
      this.#poseMesh(h.m.parts[0], t, ox, oy, oz);
      const legs = h.rag.legLinks;
      for (let i = 0; i < legs.length; i++) {
        this.#poseMesh(h.m.parts[1 + i * 2], legs[i].thigh, ox, oy, oz);
        this.#poseMesh(h.m.parts[2 + i * 2], legs[i].shank, ox, oy, oz);
      }
    }
    // The horse bodies track every frame (cheap); the brain LATTICE is a heavier
    // per-vertex recolour, so refresh it every other frame — the activations blur
    // imperceptibly at 30 Hz but the overlay cost halves.
    const recolour = (this.#frame & 1) === 0;
    for (const h of this.#horses) this.#updateBrain(h, recolour);
  }

  #updateBrain(h: Horse, recolour: boolean): void {
    const b = h.m.brain;
    if (recolour) {
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
    }
    // Float above the horse. The graph is angled for real depth and faces the camera.
    const yaw = Math.atan2(this.#camPos.x - h.wx, this.#camPos.z - h.wz);
    b.group.position.set(h.wx, h.wy + 1.92 * SCALE, h.wz);
    b.group.rotation.set(-0.18, yaw + 0.22, Math.sin(h.wx * 0.013 + h.wz * 0.017) * 0.035);
  }
}
