import * as THREE from "three/webgpu";
import { float, hash, instanceIndex, positionLocal, sin, time, uniform, vec3 } from "three/tsl";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WorldMap } from "../world/heightmap";
import type { Cockpit, DriveSpec } from "../player/types";

type N = any;

/**
 * The Marin headlands forest: one InstancedMesh of stylized redwoods swaying in
 * the vertex shader, plus wildlife you can ride. Bears and raccoons amble the
 * hills kinematically (one InstancedMesh per species, legs animated in the
 * shader from the instance id — same trick as the gull flap), and walking up
 * to one with E mounts it: the herd instance is consumed and "drive" mode gets
 * the animal's mesh and handling, exactly like commandeering traffic. The
 * raccoon packs a gummy-bear launcher (instanced candy pool, CPU ballistics —
 * cosmetic only, no physics bodies anywhere in this file).
 */

export type AnimalKind = "bear" | "raccoon";

export const ANIMALS: Record<
  AnimalKind,
  { label: string; count: number; spec: DriveSpec; cockpit: Cockpit }
> = {
  bear: {
    label: "bear",
    count: 40,
    spec: { halfExtents: [0.58, 0.5, 1.05], rideHeight: 1.0, maxFactor: 0.55, accelFactor: 0.85, steerFactor: 1.2 },
    // group-local (mesh is dropped by rideHeight so feet meet the ground)
    cockpit: { seat: [0, 0.58, 0.3] }
  },
  raccoon: {
    label: "raccoon",
    count: 64,
    spec: { halfExtents: [0.45, 0.38, 0.85], rideHeight: 0.82, maxFactor: 0.42, accelFactor: 1.25, steerFactor: 1.55 },
    cockpit: { seat: [0, 0.48, 0.2] }
  }
};

// Marin: everything north of the Golden Gate's landfall at (-3150, -5100).
// (Trees here are now grown by the wildlands SeedThree layer; Forest only owns
// the rideable animals + gummy launcher.)
const FOREST = { minX: -6300, maxX: -2700, minZ: -7800, maxZ: -5000 };
const FOREST_CENTER = { x: -4400, z: -6300 };
const BRIDGE_LANDING = { x: -3150, z: -5100 };
const ANIMAL_RANGE = 1400; // matrix churn only near the camera
const MAX_PER_KIND = 80;

const GUMMY_MAX = 96;
const GUMMY_COLORS = [0xff4a5e, 0xff9c2e, 0xffe14a, 0x4ade6b, 0x4ab8ff, 0xff6ad5];
const GUMMY_LIFE = 7;

/** Deterministic layout — the forest grows the same every session. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type BoxSpec = { w: number; h: number; d: number; x: number; y: number; z: number; c: number };

function buildBoxes(boxes: BoxSpec[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d);
    g.translate(b.x, b.y, b.z);
    color.setHex(b.c);
    const n = g.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

// tree geometry lives in world/flora.ts now — the forest just plants the bank

// animal geometry is authored feet-at-y=0, nose toward -Z (drive-forward)
function bearBoxes(): BoxSpec[] {
  const fur = 0x6d4c33;
  const dark = 0x3f2d1f;
  const tan = 0xc9a97a;
  return [
    { w: 1.15, h: 0.95, d: 1.85, x: 0, y: 1.02, z: 0.1, c: fur },
    { w: 1.0, h: 0.5, d: 0.75, x: 0, y: 1.42, z: -0.45, c: fur }, // shoulder hump
    { w: 0.62, h: 0.56, d: 0.6, x: 0, y: 1.5, z: -1.2, c: fur },
    { w: 0.3, h: 0.24, d: 0.34, x: 0, y: 1.4, z: -1.58, c: tan },
    { w: 0.14, h: 0.1, d: 0.1, x: 0, y: 1.46, z: -1.76, c: dark },
    { w: 0.18, h: 0.2, d: 0.12, x: -0.24, y: 1.86, z: -1.1, c: dark },
    { w: 0.18, h: 0.2, d: 0.12, x: 0.24, y: 1.86, z: -1.1, c: dark },
    { w: 0.24, h: 0.2, d: 0.22, x: 0, y: 1.12, z: 1.06, c: dark }, // tail stub
    { w: 0.3, h: 0.62, d: 0.38, x: -0.42, y: 0.31, z: -0.6, c: dark },
    { w: 0.3, h: 0.62, d: 0.38, x: 0.42, y: 0.31, z: -0.6, c: dark },
    { w: 0.3, h: 0.62, d: 0.38, x: -0.42, y: 0.31, z: 0.72, c: dark },
    { w: 0.3, h: 0.62, d: 0.38, x: 0.42, y: 0.31, z: 0.72, c: dark }
  ];
}

// a raccoon of rideable ambition — half bear height, all attitude
function raccoonBoxes(): BoxSpec[] {
  const grey = 0x8a8d96;
  const dgrey = 0x55565e;
  const dark = 0x2b2c33;
  const cream = 0xd8d3c8;
  return [
    { w: 0.85, h: 0.72, d: 1.5, x: 0, y: 0.82, z: 0.05, c: grey },
    { w: 0.56, h: 0.46, d: 0.5, x: 0, y: 1.18, z: -0.95, c: grey },
    { w: 0.58, h: 0.16, d: 0.14, x: 0, y: 1.24, z: -1.16, c: dark }, // the mask
    { w: 0.24, h: 0.2, d: 0.26, x: 0, y: 1.08, z: -1.26, c: cream },
    { w: 0.1, h: 0.08, d: 0.08, x: 0, y: 1.13, z: -1.4, c: dark },
    { w: 0.16, h: 0.18, d: 0.1, x: -0.2, y: 1.48, z: -0.9, c: dgrey },
    { w: 0.16, h: 0.18, d: 0.1, x: 0.2, y: 1.48, z: -0.9, c: dgrey },
    // ringed tail, curling up behind
    { w: 0.26, h: 0.26, d: 0.36, x: 0, y: 0.92, z: 0.92, c: grey },
    { w: 0.24, h: 0.24, d: 0.3, x: 0, y: 1.08, z: 1.2, c: dark },
    { w: 0.2, h: 0.2, d: 0.26, x: 0, y: 1.22, z: 1.42, c: grey },
    { w: 0.2, h: 0.46, d: 0.24, x: -0.3, y: 0.23, z: -0.5, c: dark },
    { w: 0.2, h: 0.46, d: 0.24, x: 0.3, y: 0.23, z: -0.5, c: dark },
    { w: 0.2, h: 0.46, d: 0.24, x: -0.3, y: 0.23, z: 0.5, c: dark },
    { w: 0.2, h: 0.46, d: 0.24, x: 0.3, y: 0.23, z: 0.5, c: dark }
  ];
}

/** Chunky candy bear, origin at the belly so it tumbles nicely. */
function gummyGeometry(): THREE.BufferGeometry {
  const white = 0xffffff; // instanceColor supplies the flavor
  return buildBoxes([
    { w: 0.24, h: 0.3, d: 0.15, x: 0, y: 0, z: 0, c: white },
    { w: 0.19, h: 0.16, d: 0.14, x: 0, y: 0.22, z: 0, c: white },
    { w: 0.06, h: 0.06, d: 0.06, x: -0.08, y: 0.32, z: 0, c: white },
    { w: 0.06, h: 0.06, d: 0.06, x: 0.08, y: 0.32, z: 0, c: white },
    { w: 0.07, h: 0.16, d: 0.09, x: -0.15, y: 0.02, z: 0, c: white },
    { w: 0.07, h: 0.16, d: 0.09, x: 0.15, y: 0.02, z: 0, c: white },
    { w: 0.08, h: 0.15, d: 0.1, x: -0.08, y: -0.21, z: 0, c: white },
    { w: 0.08, h: 0.15, d: 0.1, x: 0.08, y: -0.21, z: 0, c: white }
  ]);
}

type GaitParams = { hipY: number; stride: number; freq: number; bob: number; tailZ: number };
const GAITS: Record<AnimalKind, GaitParams> = {
  bear: { hipY: 0.55, stride: 0.4, freq: 4.5, bob: 0.045, tailZ: 99 },
  raccoon: { hipY: 0.46, stride: 0.3, freq: 6.5, bob: 0.04, tailZ: 0.75 }
};

/**
 * Walk cycle in the vertex shader: everything below the hip shears fore/aft,
 * diagonal leg pairs (sign(x)·sign(z)) in anti-phase, plus a body bob and a
 * tail sway. `gait` scales it (herd walks at 1; the ridden copy follows the
 * player's speed) and `phase` de-syncs herd members. Pure mix-style math —
 * no If() branches (see the mx_noise branch-corruption hazard).
 */
function animalMaterial(p: GaitParams, gait: N, phase: N): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92 });
  const legW: N = (float(p.hipY) as N).sub(positionLocal.y).div(p.hipY).clamp(0, 1);
  const diag: N = (positionLocal.x.sign() as N).mul(positionLocal.z.sign());
  const swing: N = (sin(time.mul(p.freq).add(phase)) as N).mul(diag).mul(legW).mul(p.stride).mul(gait);
  const bob: N = (sin(time.mul(p.freq * 2).add(phase)) as N).mul(p.bob).mul(gait);
  const tailW: N = (positionLocal.z as N).sub(p.tailZ).max(0);
  const tailSway: N = (sin(time.mul(3.2).add(phase)) as N).mul(tailW).mul(0.35);
  mat.positionNode = (positionLocal as N).add(vec3(tailSway, bob, swing));
  return mat;
}

type Animal = {
  x: number;
  z: number;
  heading: number;
  desired: number;
  speed: number;
  turnT: number;
};

type Herd = {
  kind: AnimalKind;
  mesh: THREE.InstancedMesh;
  list: Animal[];
  geo: THREE.BufferGeometry;
};

export class Forest {
  #map: WorldMap;
  #herds: Record<AnimalKind, Herd>;
  #riddenGait = uniform(0);
  #riddenMats = new Map<AnimalKind, THREE.MeshStandardNodeMaterial>();

  // gummy pool: swap-remove slots, matrices rebuilt each frame
  #gummy: THREE.InstancedMesh;
  #gPos = new Float32Array(GUMMY_MAX * 3);
  #gVel = new Float32Array(GUMMY_MAX * 3);
  #gSpin = new Float32Array(GUMMY_MAX * 4); // axis xyz + rate
  #gAge = new Float32Array(GUMMY_MAX);
  #gAlive = 0;

  #mat4 = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #euler = new THREE.Euler();
  #axis = new THREE.Vector3();
  #color = new THREE.Color();

  constructor(map: WorldMap, scene: THREE.Scene) {
    this.#map = map;
    this.#herds = {
      bear: this.#buildHerd("bear", scene),
      raccoon: this.#buildHerd("raccoon", scene)
    };

    const gummyMat = new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.25,
      transparent: true,
      opacity: 0.85
    });
    this.#gummy = new THREE.InstancedMesh(gummyGeometry(), gummyMat, GUMMY_MAX);
    this.#gummy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#gummy.setColorAt(0, this.#color.set("#ffffff")); // attribute exists before first compile
    this.#gummy.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.#gummy.count = 0;
    this.#gummy.frustumCulled = false;
    this.#gummy.castShadow = false;
    this.#gummy.receiveShadow = false;
    scene.add(this.#gummy);
  }


  #buildHerd(kind: AnimalKind, scene: THREE.Scene): Herd {
    const geo = buildBoxes(kind === "bear" ? bearBoxes() : raccoonBoxes());
    const mat = animalMaterial(GAITS[kind], float(1) as N, (hash(instanceIndex) as N).mul(6.283));
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_PER_KIND);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // they roam; matrices park off-range members underground
    scene.add(mesh);

    const rnd = mulberry32(kind === "bear" ? 71 : 137);
    const list: Animal[] = [];
    // a welcoming committee near the bridge landing, the rest scattered over the
    // whole headlands so a minute of wandering anywhere in Marin bumps into one
    const nearLanding = kind === "bear" ? 5 : 8;
    for (let i = 0; i < ANIMALS[kind].count * 6 && list.length < ANIMALS[kind].count; i++) {
      let x: number;
      let z: number;
      if (list.length < nearLanding) {
        const a = rnd() * Math.PI * 2;
        const d = 80 + rnd() * 450;
        x = BRIDGE_LANDING.x - 250 + Math.cos(a) * d;
        z = BRIDGE_LANDING.z - 420 + Math.sin(a) * d;
      } else {
        x = FOREST.minX + rnd() * (FOREST.maxX - FOREST.minX);
        z = FOREST.minZ + rnd() * (FOREST.maxZ - FOREST.minZ);
      }
      if (this.#map.isWater(x, z) || this.#map.groundHeight(x, z) < 2) continue;
      list.push(this.#newAnimal(x, z, rnd() * Math.PI * 2, rnd));
    }
    return { kind, mesh, list, geo };
  }

  #newAnimal(x: number, z: number, heading: number, rnd: () => number = Math.random, speed?: number): Animal {
    return { x, z, heading, desired: heading, speed: speed ?? 0.8 + rnd() * 1.2, turnT: rnd() * 2 };
  }

  /** Nearest mountable animal within maxDist (walk-mode E prompt + mount). */
  nearest(pos: THREE.Vector3, maxDist = 5): { kind: AnimalKind; index: number; label: string } | null {
    let best: { kind: AnimalKind; index: number; label: string } | null = null;
    let bestD = maxDist;
    for (const kind of ["bear", "raccoon"] as AnimalKind[]) {
      const herd = this.#herds[kind];
      for (let i = 0; i < herd.list.length; i++) {
        const a = herd.list[i];
        const d = Math.hypot(a.x - pos.x, a.z - pos.z);
        if (d < bestD) {
          bestD = d;
          best = { kind, index: i, label: ANIMALS[kind].label };
        }
      }
    }
    return best;
  }

  /** Mount: pull the animal out of the herd, hand back its pose. */
  consume(pick: { kind: AnimalKind; index: number }): { kind: AnimalKind; x: number; z: number; heading: number } {
    const herd = this.#herds[pick.kind];
    const a = herd.list[pick.index];
    herd.list.splice(pick.index, 1);
    return { kind: pick.kind, x: a.x, z: a.z, heading: a.heading };
  }

  /** Dismount: the animal rejoins the world where the player got off. */
  dropAnimal(kind: AnimalKind, x: number, z: number, heading: number, motion: { speed?: number } = {}) {
    const herd = this.#herds[kind];
    if (herd.list.length >= MAX_PER_KIND) return; // pool full — it scampers off
    const speed =
      motion.speed !== undefined && Number.isFinite(motion.speed)
        ? THREE.MathUtils.clamp(motion.speed, 0, kind === "bear" ? 6 : 7)
        : undefined;
    const animal = this.#newAnimal(x, z, heading, Math.random, speed);
    if (speed !== undefined) {
      animal.desired = heading;
      animal.turnT = 1.3; // keep the released line briefly before wandering again
    }
    herd.list.push(animal);
  }

  /**
   * The player's copy: same geometry, gait driven by ride speed. Fresh group
   * per mount — setDriveStyle removes the old one from the scene on dismount.
   */
  buildRiddenMesh(kind: AnimalKind): THREE.Group {
    let mat = this.#riddenMats.get(kind);
    if (!mat) {
      mat = animalMaterial({ ...GAITS[kind], freq: GAITS[kind].freq * 1.35 }, this.#riddenGait as N, float(0) as N);
      this.#riddenMats.set(kind, mat);
    }
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(this.#herds[kind].geo, mat);
    mesh.position.y = -ANIMALS[kind].spec.rideHeight; // body centre → feet on the ground
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    group.userData.cockpit = ANIMALS[kind].cockpit;
    return group;
  }

  /** Drive the ridden gait from player speed (0 idle … full gallop). */
  setRiddenSpeed(speed: number) {
    this.#riddenGait.value = THREE.MathUtils.clamp(speed / 5, 0, 1.2);
  }

  /** Raccoon armament. Ballistic, bouncy, cosmetic. */
  fireGummy(origin: THREE.Vector3, dir: THREE.Vector3, inherit: THREE.Vector3) {
    if (this.#gAlive >= GUMMY_MAX) return;
    const i = this.#gAlive++;
    this.#gPos[i * 3] = origin.x + dir.x * 1.4;
    this.#gPos[i * 3 + 1] = origin.y + dir.y * 1.4;
    this.#gPos[i * 3 + 2] = origin.z + dir.z * 1.4;
    this.#gVel[i * 3] = dir.x * 30 + inherit.x * 0.6 + (Math.random() - 0.5) * 2.4;
    this.#gVel[i * 3 + 1] = dir.y * 30 + inherit.y * 0.6 + 1.5 + (Math.random() - 0.5) * 2.4;
    this.#gVel[i * 3 + 2] = dir.z * 30 + inherit.z * 0.6 + (Math.random() - 0.5) * 2.4;
    this.#axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.#gSpin[i * 4] = this.#axis.x;
    this.#gSpin[i * 4 + 1] = this.#axis.y;
    this.#gSpin[i * 4 + 2] = this.#axis.z;
    this.#gSpin[i * 4 + 3] = 4 + Math.random() * 8;
    this.#gAge[i] = 0;
    this.#gummy.setColorAt(i, this.#color.setHex(GUMMY_COLORS[Math.floor(Math.random() * GUMMY_COLORS.length)]));
    this.#gummy.instanceColor!.needsUpdate = true;
  }

  update(dt: number, viewPos: THREE.Vector3) {
    this.#updateHerds(dt, viewPos);
    this.#updateGummies(dt);
  }

  #updateHerds(dt: number, viewPos: THREE.Vector3) {
    for (const kind of ["bear", "raccoon"] as AnimalKind[]) {
      const herd = this.#herds[kind];
      herd.mesh.count = herd.list.length;
      if (herd.list.length === 0) continue;
      let any = false;
      for (let i = 0; i < herd.list.length; i++) {
        const a = herd.list[i];
        if (Math.hypot(a.x - viewPos.x, a.z - viewPos.z) > ANIMAL_RANGE) {
          // out of sight: park underground, freeze the brain (they keep their spot)
          this.#mat4.makeTranslation(a.x, -500, a.z);
          herd.mesh.setMatrixAt(i, this.#mat4);
          continue;
        }
        any = true;
        this.#wander(a, dt);
        const g = Math.max(this.#map.groundHeight(a.x, a.z), -0.4); // wades, never seafloor-walks
        // nose pitches with the slope it's climbing
        const e = 1.6;
        const fx = -Math.sin(a.heading);
        const fz = -Math.cos(a.heading);
        const dh = this.#map.groundHeight(a.x + fx * e, a.z + fz * e) - this.#map.groundHeight(a.x - fx * e, a.z - fz * e);
        this.#euler.set(THREE.MathUtils.clamp(Math.atan2(-dh, 2 * e), -0.5, 0.5), a.heading, 0, "YXZ");
        this.#quat.setFromEuler(this.#euler);
        this.#pos.set(a.x, g, a.z);
        this.#mat4.compose(this.#pos, this.#quat, this.#scale.setScalar(1));
        herd.mesh.setMatrixAt(i, this.#mat4);
      }
      if (any || herd.list.length > 0) herd.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Amble brain: drift, re-roll heading on a timer, steer home off water/beach. */
  #wander(a: Animal, dt: number) {
    a.turnT -= dt;
    if (a.turnT <= 0) {
      a.turnT = 2 + Math.random() * 3.5;
      a.desired = a.heading + (Math.random() - 0.5) * 1.8;
      a.speed = 0.7 + Math.random() * 1.5;
    }
    const fx = -Math.sin(a.heading);
    const fz = -Math.cos(a.heading);
    const ax = a.x + fx * 14;
    const az = a.z + fz * 14;
    // leash covers the full spawn scatter (corners sit ~2420 m out) — only
    // ridden-and-abandoned strays actually walk home from beyond it
    const home = Math.hypot(a.x - FOREST_CENTER.x, a.z - FOREST_CENTER.z) > 2600;
    if (home || this.#map.isWater(ax, az) || this.#map.groundHeight(ax, az) < 1.5) {
      a.desired = Math.atan2(-(FOREST_CENTER.x - a.x), -(FOREST_CENTER.z - a.z));
    }
    const dYaw = Math.atan2(Math.sin(a.desired - a.heading), Math.cos(a.desired - a.heading));
    a.heading += THREE.MathUtils.clamp(dYaw, -1.4 * dt, 1.4 * dt);
    a.x += -Math.sin(a.heading) * a.speed * dt;
    a.z += -Math.cos(a.heading) * a.speed * dt;
  }

  #updateGummies(dt: number) {
    let i = 0;
    while (i < this.#gAlive) {
      this.#gAge[i] += dt;
      if (this.#gAge[i] > GUMMY_LIFE) {
        this.#killGummy(i);
        continue;
      }
      const p = i * 3;
      this.#gVel[p + 1] -= 20 * dt;
      this.#gPos[p] += this.#gVel[p] * dt;
      this.#gPos[p + 1] += this.#gVel[p + 1] * dt;
      this.#gPos[p + 2] += this.#gVel[p + 2] * dt;
      const floor = this.#map.effectiveGround(this.#gPos[p], this.#gPos[p + 2]) + 0.16;
      if (this.#gPos[p + 1] < floor) {
        this.#gPos[p + 1] = floor;
        this.#gVel[p + 1] = Math.abs(this.#gVel[p + 1]) * 0.48;
        if (this.#gVel[p + 1] < 1.2) this.#gVel[p + 1] = 0; // settled — candy at rest
        this.#gVel[p] *= 0.7;
        this.#gVel[p + 2] *= 0.7;
        this.#gSpin[i * 4 + 3] *= 0.6;
      }
      i++;
    }
    this.#gummy.count = this.#gAlive;
    if (this.#gAlive === 0) return;
    for (let j = 0; j < this.#gAlive; j++) {
      const p = j * 3;
      const age = this.#gAge[j];
      // pop in fast, melt away over the last second
      const s = Math.min(1, age * 8) * Math.min(1, GUMMY_LIFE - age) * 1.15;
      this.#axis.set(this.#gSpin[j * 4], this.#gSpin[j * 4 + 1], this.#gSpin[j * 4 + 2]);
      this.#quat.setFromAxisAngle(this.#axis, age * this.#gSpin[j * 4 + 3]);
      this.#pos.set(this.#gPos[p], this.#gPos[p + 1], this.#gPos[p + 2]);
      this.#mat4.compose(this.#pos, this.#quat, this.#scale.setScalar(s));
      this.#gummy.setMatrixAt(j, this.#mat4);
    }
    this.#gummy.instanceMatrix.needsUpdate = true;
  }

  #killGummy(i: number) {
    const last = this.#gAlive - 1;
    if (i !== last) {
      this.#gPos.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.#gVel.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.#gSpin.copyWithin(i * 4, last * 4, last * 4 + 4);
      this.#gAge[i] = this.#gAge[last];
      this.#gummy.getColorAt(last, this.#color);
      this.#gummy.setColorAt(i, this.#color);
      this.#gummy.instanceColor!.needsUpdate = true;
    }
    this.#gAlive = last;
  }
}
