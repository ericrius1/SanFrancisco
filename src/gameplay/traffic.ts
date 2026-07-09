import * as THREE from "three/webgpu";
import { BodyType } from "../core/physics";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LIGHT_SCALE } from "../config";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";

/**
 * Ambient traffic: sedans, taxis, a muni bus and a cable car cruising the
 * streets around the player. Every one is a real dynamic body (explosions toss
 * them, you can ram them) and every one is enterable — walk up, press E, and
 * it's yours. There is no road-network data, so they navigate by probing the
 * building-collider field: drive straight, sweep ahead, steer toward open air.
 * It reads surprisingly like city traffic on the SF grid.
 */

import type { Cockpit } from "../player/types";

export type VehicleClass = "sedan" | "convertible" | "taxi" | "bus" | "cable";

export type DriveProfile = {
  cls: VehicleClass;
  label: string;
  halfExtents: [number, number, number];
  rideHeight: number;
  maxFactor: number; // multipliers on the drive tunables when the player takes over
  accelFactor: number;
  steerFactor: number;
};

export const DRIVE_PROFILES: Record<VehicleClass, DriveProfile> = {
  sedan: { cls: "sedan", label: "sedan", halfExtents: [1.05, 0.45, 2.2], rideHeight: 0.85, maxFactor: 0.92, accelFactor: 0.9, steerFactor: 1 },
  convertible: { cls: "convertible", label: "convertible", halfExtents: [1.05, 0.42, 2.2], rideHeight: 0.85, maxFactor: 1.05, accelFactor: 1.05, steerFactor: 1.1 },
  taxi: { cls: "taxi", label: "taxi", halfExtents: [1.05, 0.45, 2.2], rideHeight: 0.85, maxFactor: 1, accelFactor: 1, steerFactor: 1.08 },
  bus: { cls: "bus", label: "muni bus", halfExtents: [1.3, 0.75, 4.6], rideHeight: 1.15, maxFactor: 0.7, accelFactor: 0.55, steerFactor: 0.55 },
  cable: { cls: "cable", label: "cable car", halfExtents: [1.2, 0.7, 3.4], rideHeight: 1.05, maxFactor: 0.5, accelFactor: 0.5, steerFactor: 0.6 }
};

/** Driver-rig anchors per class; closed cabs hide the rig (see Player.#seatDriver). */
const COCKPITS: Record<VehicleClass, Cockpit> = {
  sedan: { seat: [0, 0, 0], hide: true },
  convertible: { seat: [-0.42, 0.52, 0.62], wheel: [-0.42, 0.64, 0.08] },
  taxi: { seat: [0, 0, 0], hide: true },
  bus: { seat: [0, 0, 0], hide: true },
  cable: { seat: [0, 0, 0], hide: true }
};

type VehicleState = "drive" | "wrecked";

export type Vehicle = {
  cls: VehicleClass;
  paint: number;
  handle: number;
  mesh: THREE.Group;
  heading: number;
  desiredHeading: number;
  cruise: number;
  state: VehicleState;
  probeTimer: number;
  blockedTime: number;
  wreckTimer: number;
  pos: THREE.Vector3;
};

export type VehicleReleaseMotion = {
  paint?: number;
  y?: number;
  linear?: readonly [number, number, number];
  angular?: readonly [number, number, number];
};

const SEDAN_PAINTS = [0x4f7dc0, 0x7d9c7a, 0xb0575a, 0x9a9ea6, 0x5a5f6a, 0xc7b98a];
// convertibles are the fun ones — sunnier paint jobs than the commuter sedans
const CONVERTIBLE_PAINTS = [0xe8563f, 0x54b0f0, 0xf0c040, 0x8f6fd0, 0x3fbf8f, 0xf07ab0];
const MAX_VEHICLES = 7;
const SPAWN_MIN = 90;
const SPAWN_MAX = 240;
const DESPAWN = 340;

type BoxSpec = { w: number; h: number; d: number; x: number; y: number; z: number; c: number; rx?: number };

function buildGeo(boxes: BoxSpec[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d);
    if (b.rx) g.rotateX(b.rx);
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

// front is local -Z, matching the player's drive forward
function sedanBoxes(paint: number): { body: BoxSpec[]; glow: BoxSpec[] } {
  const trim = 0x23262c;
  const glass = 0x11202c;
  return {
    body: [
      { w: 2.05, h: 0.52, d: 4.35, x: 0, y: 0, z: 0, c: paint },
      { w: 1.9, h: 0.28, d: 1.7, x: 0, y: 0.34, z: -1.2, c: paint },
      { w: 1.7, h: 0.5, d: 1.9, x: 0, y: 0.62, z: 0.45, c: glass },
      { w: 1.5, h: 0.1, d: 1.6, x: 0, y: 0.9, z: 0.45, c: paint },
      { w: 2.1, h: 0.24, d: 0.3, x: 0, y: -0.22, z: -2.1, c: trim },
      { w: 2.1, h: 0.24, d: 0.3, x: 0, y: -0.22, z: 2.1, c: trim },
      // wheels
      { w: 0.3, h: 0.72, d: 0.72, x: -1.0, y: -0.4, z: -1.45, c: trim },
      { w: 0.3, h: 0.72, d: 0.72, x: 1.0, y: -0.4, z: -1.45, c: trim },
      { w: 0.3, h: 0.72, d: 0.72, x: -1.0, y: -0.4, z: 1.45, c: trim },
      { w: 0.3, h: 0.72, d: 0.72, x: 1.0, y: -0.4, z: 1.45, c: trim }
    ],
    glow: [
      { w: 0.36, h: 0.14, d: 0.08, x: -0.66, y: 0.1, z: -2.2, c: 0xfff2c0 },
      { w: 0.36, h: 0.14, d: 0.08, x: 0.66, y: 0.1, z: -2.2, c: 0xfff2c0 },
      { w: 0.4, h: 0.12, d: 0.08, x: -0.62, y: 0.16, z: 2.2, c: 0xff2818 },
      { w: 0.4, h: 0.12, d: 0.08, x: 0.62, y: 0.16, z: 2.2, c: 0xff2818 }
    ]
  };
}

// Open-top roadster: windshield only, tan seats in a dark tub. AI ones carry a
// blocky driver (plus their own little wheel) baked into the merged geometry;
// the player's copy omits both — the animated rig sits there instead.
function convertibleBoxes(paint: number, withDriver: boolean): { body: BoxSpec[]; glow: BoxSpec[] } {
  const trim = 0x23262c;
  const glass = 0x18242e;
  const tub = 0x201c18;
  const seat = 0x8c4a32;
  const body: BoxSpec[] = [
    { w: 2.05, h: 0.5, d: 4.3, x: 0, y: 0, z: 0, c: paint },
    { w: 1.9, h: 0.26, d: 1.6, x: 0, y: 0.3, z: -1.25, c: paint },
    { w: 1.9, h: 0.28, d: 1.05, x: 0, y: 0.31, z: 1.65, c: paint },
    { w: 1.76, h: 0.42, d: 0.08, x: 0, y: 0.54, z: -0.72, c: glass, rx: 0.38 },
    { w: 1.66, h: 0.1, d: 1.85, x: 0, y: 0.28, z: 0.45, c: tub },
    { w: 1.7, h: 0.2, d: 0.34, x: 0, y: 0.42, z: -0.44, c: tub },
    { w: 0.56, h: 0.12, d: 0.5, x: -0.42, y: 0.37, z: 0.62, c: seat },
    { w: 0.56, h: 0.12, d: 0.5, x: 0.42, y: 0.37, z: 0.62, c: seat },
    { w: 0.56, h: 0.4, d: 0.12, x: -0.42, y: 0.52, z: 0.94, c: seat, rx: 0.12 },
    { w: 0.56, h: 0.4, d: 0.12, x: 0.42, y: 0.52, z: 0.94, c: seat, rx: 0.12 },
    { w: 2.1, h: 0.24, d: 0.3, x: 0, y: -0.22, z: -2.08, c: trim },
    { w: 2.1, h: 0.24, d: 0.3, x: 0, y: -0.22, z: 2.08, c: trim },
    // wheels
    { w: 0.3, h: 0.72, d: 0.72, x: -1.0, y: -0.4, z: -1.45, c: trim },
    { w: 0.3, h: 0.72, d: 0.72, x: 1.0, y: -0.4, z: -1.45, c: trim },
    { w: 0.3, h: 0.72, d: 0.72, x: -1.0, y: -0.4, z: 1.45, c: trim },
    { w: 0.3, h: 0.72, d: 0.72, x: 1.0, y: -0.4, z: 1.45, c: trim }
  ];
  if (withDriver) {
    body.push(
      { w: 0.34, h: 0.4, d: 0.2, x: -0.42, y: 0.64, z: 0.62, c: 0xc76b4a },
      { w: 0.2, h: 0.2, d: 0.2, x: -0.42, y: 0.95, z: 0.62, c: 0xe0b9a0 },
      { w: 0.22, h: 0.07, d: 0.22, x: -0.42, y: 1.07, z: 0.62, c: 0x33261e },
      { w: 0.08, h: 0.1, d: 0.4, x: -0.58, y: 0.6, z: 0.32, c: 0xc76b4a },
      { w: 0.08, h: 0.1, d: 0.4, x: -0.26, y: 0.6, z: 0.32, c: 0xc76b4a },
      { w: 0.3, h: 0.28, d: 0.05, x: -0.42, y: 0.58, z: 0.08, c: trim, rx: 0.45 }
    );
  }
  return {
    body,
    glow: [
      { w: 0.36, h: 0.14, d: 0.08, x: -0.66, y: 0.1, z: -2.18, c: 0xfff2c0 },
      { w: 0.36, h: 0.14, d: 0.08, x: 0.66, y: 0.1, z: -2.18, c: 0xfff2c0 },
      { w: 0.4, h: 0.12, d: 0.08, x: -0.62, y: 0.16, z: 2.18, c: 0xff2818 },
      { w: 0.4, h: 0.12, d: 0.08, x: 0.62, y: 0.16, z: 2.18, c: 0xff2818 }
    ]
  };
}

function taxiBoxes(): { body: BoxSpec[]; glow: BoxSpec[] } {
  const base = sedanBoxes(0xf0b429);
  base.body.push({ w: 0.7, h: 0.22, d: 0.34, x: 0, y: 1.06, z: 0.45, c: 0x1b1d22 }); // roof sign
  base.glow.push({ w: 0.6, h: 0.14, d: 0.26, x: 0, y: 1.06, z: 0.45, c: 0xfff7d8 });
  return base;
}

function busBoxes(): { body: BoxSpec[]; glow: BoxSpec[] } {
  const paint = 0xd8d4c8;
  const stripe = 0xc2493a;
  const glass = 0x14232f;
  const trim = 0x23262c;
  const body: BoxSpec[] = [
    { w: 2.5, h: 1.5, d: 9.0, x: 0, y: 0.45, z: 0, c: paint },
    { w: 2.54, h: 0.34, d: 9.02, x: 0, y: 0.28, z: 0, c: stripe },
    { w: 2.56, h: 0.5, d: 1.9, x: 0, y: 0.86, z: -3.4, c: glass }, // windshield band
    { w: 2.3, h: 0.3, d: 0.4, x: 0, y: -0.36, z: -4.35, c: trim },
    { w: 2.3, h: 0.3, d: 0.4, x: 0, y: -0.36, z: 4.35, c: trim }
  ];
  // window strip along both sides
  for (let i = 0; i < 5; i++) {
    body.push({ w: 2.52, h: 0.5, d: 1.1, x: 0, y: 0.86, z: -1.8 + i * 1.45, c: glass });
  }
  for (const [wx, wz] of [[-1.1, -2.9], [1.1, -2.9], [-1.1, 2.9], [1.1, 2.9]]) {
    body.push({ w: 0.34, h: 0.86, d: 0.86, x: wx, y: -0.55, z: wz, c: trim });
  }
  return {
    body,
    glow: [
      { w: 0.4, h: 0.18, d: 0.08, x: -0.9, y: 0.1, z: -4.55, c: 0xfff2c0 },
      { w: 0.4, h: 0.18, d: 0.08, x: 0.9, y: 0.1, z: -4.55, c: 0xfff2c0 },
      { w: 0.44, h: 0.16, d: 0.08, x: -0.86, y: 0.2, z: 4.55, c: 0xff2818 },
      { w: 0.44, h: 0.16, d: 0.08, x: 0.86, y: 0.2, z: 4.55, c: 0xff2818 }
    ]
  };
}

function cableBoxes(): { body: BoxSpec[]; glow: BoxSpec[] } {
  const maroon = 0x71262b;
  const cream = 0xe8ddc0;
  const roof = 0x9a3b2e;
  const trim = 0x2b2523;
  const body: BoxSpec[] = [
    { w: 2.2, h: 0.3, d: 6.6, x: 0, y: -0.5, z: 0, c: trim }, // chassis
    { w: 2.3, h: 1.0, d: 2.6, x: 0, y: 0.2, z: 0, c: maroon }, // centre cabin
    { w: 2.1, h: 0.9, d: 1.8, x: 0, y: 0.15, z: -2.3, c: cream }, // open front section
    { w: 2.1, h: 0.9, d: 1.8, x: 0, y: 0.15, z: 2.3, c: cream }, // open rear section
    { w: 2.5, h: 0.16, d: 7.0, x: 0, y: 0.95, z: 0, c: roof },
    { w: 0.16, h: 0.9, d: 0.16, x: -1.05, y: 0.35, z: -3.1, c: maroon },
    { w: 0.16, h: 0.9, d: 0.16, x: 1.05, y: 0.35, z: -3.1, c: maroon },
    { w: 0.16, h: 0.9, d: 0.16, x: -1.05, y: 0.35, z: 3.1, c: maroon },
    { w: 0.16, h: 0.9, d: 0.16, x: 1.05, y: 0.35, z: 3.1, c: maroon },
    // bench seats peeking out the open ends
    { w: 1.8, h: 0.18, d: 0.5, x: 0, y: -0.1, z: -2.6, c: trim },
    { w: 1.8, h: 0.18, d: 0.5, x: 0, y: -0.1, z: 2.6, c: trim }
  ];
  return {
    body,
    glow: [{ w: 0.5, h: 0.24, d: 0.08, x: 0, y: 0.45, z: -3.32, c: 0xffe9a8 }]
  };
}

export class Traffic {
  vehicles: Vehicle[] = [];
  /** Fires just BEFORE a vehicle body is destroyed (despawn/consume/wreck). */
  onWillRemoveBody: (handle: number) => void = () => {};

  #physics: Physics;
  #map: WorldMap;
  #scene: THREE.Scene;
  #spawnTimer = 1.5;
  #bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  #glowMat: THREE.MeshBasicMaterial;
  #geoCache = new Map<string, { body: THREE.BufferGeometry; glow: THREE.BufferGeometry }>();

  #v = new THREE.Vector3();
  #fwd = new THREE.Vector3();
  #right = new THREE.Vector3();
  #up = new THREE.Vector3(0, 1, 0);
  #qa = new THREE.Quaternion();
  #qb = new THREE.Quaternion();

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    this.#physics = physics;
    this.#map = map;
    this.#scene = scene;
    this.#glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.#glowMat.color.setScalar(LIGHT_SCALE); // unlit lamps into the photometric scale
  }

  #geometry(cls: VehicleClass, paint: number, withDriver: boolean): { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
    const painted = cls === "sedan" || cls === "convertible";
    const key = `${cls}${painted ? `_${paint}` : ""}${withDriver ? "_d" : ""}`;
    let geo = this.#geoCache.get(key);
    if (!geo) {
      const boxes =
        cls === "taxi"
          ? taxiBoxes()
          : cls === "bus"
            ? busBoxes()
            : cls === "cable"
              ? cableBoxes()
              : cls === "convertible"
                ? convertibleBoxes(paint, withDriver)
                : sedanBoxes(paint);
      geo = { body: buildGeo(boxes.body), glow: buildGeo(boxes.glow) };
      this.#geoCache.set(key, geo);
    }
    return geo;
  }

  /** `withDriver` bakes the blocky AI driver in — leave it off for player copies. */
  buildMesh(cls: VehicleClass, paint = SEDAN_PAINTS[0], withDriver = false): THREE.Group {
    const geo = this.#geometry(cls, paint, withDriver && cls === "convertible");
    const group = new THREE.Group();
    const body = new THREE.Mesh(geo.body, this.#bodyMat);
    body.castShadow = true;
    group.add(body);
    group.add(new THREE.Mesh(geo.glow, this.#glowMat));
    group.userData.cockpit = COCKPITS[cls];
    return group;
  }

  #createVehicle(
    cls: VehicleClass,
    x: number,
    z: number,
    heading: number,
    state: VehicleState,
    paintOverride?: number,
    withDriver = state === "drive",
    yOverride?: number
  ): Vehicle {
    const p = DRIVE_PROFILES[cls];
    const y = yOverride ?? this.#map.effectiveGround(x, z) + p.rideHeight;
    const handle = this.#physics.world.createBox({
      type: BodyType.Dynamic,
      position: [x, y, z],
      halfExtents: p.halfExtents,
      density: 120,
      friction: 0.4,
      restitution: 0.1
    });
    this.#physics.world.setBodyTransform(handle, [x, y, z], [0, Math.sin(heading / 2), 0, Math.cos(heading / 2)]);
    const paints = cls === "convertible" ? CONVERTIBLE_PAINTS : SEDAN_PAINTS;
    const paint = paintOverride ?? paints[Math.floor(Math.random() * paints.length)];
    // only cruising convertibles carry the baked driver
    const mesh = this.buildMesh(cls, paint, withDriver);
    mesh.position.set(x, y, z);
    this.#scene.add(mesh);
    const v: Vehicle = {
      cls,
      paint,
      handle,
      mesh,
      heading,
      desiredHeading: heading,
      cruise: cls === "cable" ? 4 : cls === "bus" ? 5 : cls === "convertible" ? 7 + Math.random() * 1.5 : 6 + Math.random() * 1.5,
      state,
      probeTimer: Math.random() * 0.3,
      blockedTime: 0,
      wreckTimer: 0,
      pos: new THREE.Vector3(x, y, z)
    };
    this.vehicles.push(v);
    return v;
  }

  #removeVehicle(v: Vehicle) {
    const i = this.vehicles.indexOf(v);
    if (i === -1) return;
    this.vehicles.splice(i, 1);
    this.onWillRemoveBody(v.handle);
    this.#physics.world.destroyBody(v.handle);
    this.#scene.remove(v.mesh); // geometry is shared via the cache — don't dispose
  }

  /** Nearest enterable vehicle within maxDist of pos. */
  nearest(pos: THREE.Vector3, maxDist = 5): Vehicle | null {
    let best: Vehicle | null = null;
    let bestD = maxDist;
    for (const v of this.vehicles) {
      const d = Math.hypot(v.pos.x - pos.x, v.pos.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  /** Player takes this vehicle: remove the AI one, hand back its identity. */
  consume(v: Vehicle): { cls: VehicleClass; paint: number; heading: number; x: number; z: number } {
    const out = { cls: v.cls, paint: v.paint, heading: v.heading, x: v.pos.x, z: v.pos.z };
    this.#removeVehicle(v);
    return out;
  }

  /** Release a commandeered vehicle back into traffic with the player's last motion. */
  releaseVehicle(cls: VehicleClass, x: number, z: number, heading: number, motion: VehicleReleaseMotion = {}) {
    const v = this.#createVehicle(cls, x, z, heading, "drive", motion.paint, false, motion.y);
    const linear = motion.linear;
    if (linear) {
      const angular = motion.angular ?? [0, 0, 0];
      this.#physics.world.setBodyVelocity(
        v.handle,
        [linear[0], linear[1], linear[2]],
        [angular[0], angular[1], angular[2]]
      );
      this.#physics.world.setBodyAwake(v.handle, true);
      const releasedSpeed = Math.hypot(linear[0], linear[2]);
      v.cruise = Math.max(v.cruise, THREE.MathUtils.clamp(releasedSpeed, 0, 22));
    }
  }

  /** Fixed-step AI control (velocity-driven, same contract as the player's car). */
  prePhysics(dt: number, playerPos: THREE.Vector3) {
    const w = this.#physics.world;
    for (const v of this.vehicles) {
      const t = w.getBodyTransform(v.handle);
      const vel = w.getBodyVelocity(v.handle);
      v.pos.set(t.position[0], t.position[1], t.position[2]);
      this.#qa.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
      const upY = 1 - 2 * (this.#qa.x * this.#qa.x + this.#qa.z * this.#qa.z);

      if (v.state === "wrecked") {
        v.wreckTimer -= dt;
        if (v.wreckTimer <= 0) {
          // self-right with a hop and get back to work
          w.setBodyTransform(v.handle, [v.pos.x, v.pos.y + 1.4, v.pos.z], [0, Math.sin(v.heading / 2), 0, Math.cos(v.heading / 2)]);
          w.setBodyVelocity(v.handle, [0, 0, 0], [0, 0, 0]);
          v.state = "drive";
        }
        continue;
      }

      if (upY < 0.35) {
        v.state = "wrecked";
        v.wreckTimer = 3.2;
        continue;
      }

      w.setBodyAwake(v.handle, true);
      const profile = DRIVE_PROFILES[v.cls];
      const ground = this.#groundAt(v.pos.x, v.pos.z, v.pos.y);
      const rideY = ground + profile.rideHeight;

      // --- steering brain: probe ahead, pick open air ---
      v.probeTimer -= dt;
      if (v.probeTimer <= 0) {
        v.probeTimer = 0.24 + Math.random() * 0.1;
        if (!this.#clearAhead(v, v.heading, 16)) {
          const options = [0.5, -0.5, 1.0, -1.0, 1.6, -1.6, Math.PI];
          let chosen: number | null = null;
          for (const off of options) {
            if (this.#clearAhead(v, v.heading + off, 14)) {
              chosen = v.heading + off;
              break;
            }
          }
          v.desiredHeading = chosen ?? v.heading + Math.PI;
          v.blockedTime += 0.25;
        } else {
          v.blockedTime = 0;
          // gentle wander so they don't all mow a perfectly straight line
          if (Math.random() < 0.06) v.desiredHeading = v.heading + (Math.random() - 0.5) * 0.5;
        }
      }

      let dYaw = v.desiredHeading - v.heading;
      dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
      const turning = Math.abs(dYaw) > 0.08;
      v.heading += THREE.MathUtils.clamp(dYaw, -1.4 * dt, 1.4 * dt);

      // brake for the player: don't mow down pedestrians (they can still mow us down)
      const toPlayer = Math.hypot(playerPos.x - v.pos.x, playerPos.z - v.pos.z);
      const playerAhead =
        toPlayer < 10 &&
        Math.cos(Math.atan2(-(playerPos.x - v.pos.x), -(playerPos.z - v.pos.z)) - v.heading) > 0.5;

      const fwd = this.#fwd.set(-Math.sin(v.heading), 0, -Math.cos(v.heading));
      const right = this.#right.set(-fwd.z, 0, fwd.x);
      const fwdSpeed = vel.linear[0] * fwd.x + vel.linear[2] * fwd.z;
      const latSpeed = vel.linear[0] * right.x + vel.linear[2] * right.z;
      const target = playerAhead || v.blockedTime > 1.5 ? 0 : turning ? v.cruise * 0.55 : v.cruise;
      const speed = fwdSpeed + THREE.MathUtils.clamp(target - fwdSpeed, -10 * dt, 6 * dt);

      // vertical: same ride spring + slope feedforward as the player's car
      let vy = vel.linear[1];
      if (v.pos.y > rideY + 0.5) {
        vy = Math.min(vy, 0);
      } else {
        const ahead = this.#groundAt(v.pos.x + fwd.x * speed * dt, v.pos.z + fwd.z * speed * dt, v.pos.y);
        const slopeRate = THREE.MathUtils.clamp((ahead + profile.rideHeight - rideY) / dt, -12, 26);
        vy = (rideY - v.pos.y) * 8 + slopeRate;
      }

      // attitude: yaw owned by the brain, pitch/roll chase the road plane
      const e = 2.5;
      const n = this.#v.set(
        this.#groundAt(v.pos.x - e, v.pos.z, v.pos.y) - this.#groundAt(v.pos.x + e, v.pos.z, v.pos.y),
        2 * e,
        this.#groundAt(v.pos.x, v.pos.z - e, v.pos.y) - this.#groundAt(v.pos.x, v.pos.z + e, v.pos.y)
      ).normalize();
      this.#qb.setFromAxisAngle(this.#up, v.heading);
      this.#qa.setFromUnitVectors(this.#up, n).multiply(this.#qb);
      const q = this.#qa;
      w.setBodyVelocity(
        v.handle,
        [fwd.x * speed + right.x * latSpeed * 0.1, vy, fwd.z * speed + right.z * latSpeed * 0.1],
        [0, 0, 0]
      );
      w.setBodyTransform(v.handle, [v.pos.x, v.pos.y, v.pos.z], [q.x, q.y, q.z, q.w]);
    }
  }

  #groundAt(x: number, z: number, vehicleY: number): number {
    const terrain = this.#map.groundHeight(x, z);
    const deck = this.#map.bridgeDeck(x, z);
    return deck > -Infinity && vehicleY > deck - 3 ? Math.max(terrain, deck) : terrain;
  }

  #clearAhead(v: Vehicle, heading: number, dist: number): boolean {
    const fx = -Math.sin(heading);
    const fz = -Math.cos(heading);
    const ax = v.pos.x + fx * dist;
    const az = v.pos.z + fz * dist;
    if (this.#map.isWater(ax, az)) return false;
    // steep drop or wall of terrain ahead reads as blocked too
    const dh = Math.abs(this.#map.effectiveGround(ax, az) - this.#map.effectiveGround(v.pos.x, v.pos.z));
    if (dh > dist * 0.45) return false;
    const y = v.pos.y + 0.4;
    return !this.#physics.sweepBuildings([v.pos.x + fx * 3, y, v.pos.z + fz * 3], [ax, y, az]);
  }

  /** Frame-rate work: spawn/despawn management + mesh mirroring. */
  update(playerPos: THREE.Vector3, dt: number) {
    // mirror bodies into meshes
    const w = this.#physics.world;
    for (const v of this.vehicles) {
      const t = w.getBodyTransform(v.handle);
      v.mesh.position.set(t.position[0], t.position[1], t.position[2]);
      v.mesh.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
    }

    this.#spawnTimer -= dt;
    if (this.#spawnTimer > 0) return;
    this.#spawnTimer = 1.2;

    for (const v of [...this.vehicles]) {
      if (Math.hypot(v.pos.x - playerPos.x, v.pos.z - playerPos.z) > DESPAWN) {
        this.#removeVehicle(v);
      }
    }

    if (this.vehicles.length >= MAX_VEHICLES) return;

    // one spawn attempt per beat: random ring position on land, outside buildings,
    // with at least one clear driving corridor
    const a = Math.random() * Math.PI * 2;
    const d = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const x = playerPos.x + Math.cos(a) * d;
    const z = playerPos.z + Math.sin(a) * d;
    if (this.#map.isWater(x, z)) return;
    if (this.#physics.pointInBuilding(x, this.#map.effectiveGround(x, z) + 1, z)) return;

    // convertible-heavy mix: they're the ones that show off the driver
    const roll = Math.random();
    const cls: VehicleClass =
      roll < 0.35 ? "convertible" : roll < 0.6 ? "sedan" : roll < 0.75 ? "taxi" : roll < 0.9 ? "bus" : "cable";
    const probe: Vehicle = {
      cls,
      paint: 0,
      handle: 0,
      mesh: null as never,
      heading: 0,
      desiredHeading: 0,
      cruise: 0,
      state: "drive",
      probeTimer: 0,
      blockedTime: 0,
      wreckTimer: 0,
      pos: new THREE.Vector3(x, this.#map.effectiveGround(x, z) + 1, z)
    };
    for (let i = 0; i < 6; i++) {
      const heading = Math.random() * Math.PI * 2;
      if (this.#clearAhead(probe, heading, 22)) {
        this.#createVehicle(cls, x, z, heading, "drive");
        return;
      }
    }
  }
}
