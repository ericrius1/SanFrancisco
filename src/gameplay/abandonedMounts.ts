import * as THREE from "three/webgpu";
import { BodyType } from "../core/physics";
import type { Physics } from "../core/physics";
import type { PlayerMode } from "../player/types";
import { DEFAULT_DRIVE_SPEC } from "../player/types";
import { waterHeight, type WorldMap } from "../world/heightmap";
import { buildCarMesh } from "../vehicles/car";
import { buildPlaneMesh, collectPlaneAnim, type PlaneAnim } from "../vehicles/plane";
import { buildBoatMesh, buildSpeedboatMesh } from "../vehicles/boat";
import { buildDroneMesh } from "../vehicles/drone";
import { buildBoardMesh, localBoardConfig } from "../vehicles/board";
import { buildBirdMesh, type BirdRig } from "../vehicles/bird";
import { buildSurfboardMesh } from "../vehicles/surf";
import { buildScooterMesh, localScooterConfig } from "../vehicles/scooter";
import { poseBone } from "../vehicles/bird/mesh";
import { setEmbodimentVisible } from "../player/embodimentVisibility";

type MountMode = Exclude<PlayerMode, "walk">;

type ReleasePose = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  linear: readonly [number, number, number];
  angular: readonly [number, number, number];
};

type MountSpec = {
  build: () => THREE.Group;
  halfExtents: [number, number, number];
  density: number;
  friction: number;
  restitution: number;
  gravityScale: number;
  linearDrag: number;
  angularDrag: number;
  maxSpeed: number;
};

type AbandonedMount = {
  mode: MountMode;
  spec: MountSpec;
  handle: number;
  mesh: THREE.Group;
  age: number;
  planeAnim?: PlaneAnim;
  rotors?: THREE.Group[];
  // bird: wanders the sky on its own — heading it steers toward, a countdown to
  // the next course change, its cruising altitude, and the wingbeat clocks
  wanderYaw?: number;
  wanderTimer?: number;
  targetY?: number;
  flapPhase?: number;
  animT?: number;
  // plane: flies straight for `glideTime`, then noses down; `crashed` freezes it
  glideTime?: number;
  crashed?: boolean;
  // scattered "come find me" mounts: exempt from distance-despawn and the
  // overflow eviction, so they wait at their bay spot however far you roam
  persistent?: boolean;
};

const MAX_MOUNTS = 12;
const DESPAWN_DISTANCE = 520;
// birds are their own creatures now — they get to roam much farther before we
// stop tracking them than a parked car does
const BIRD_DESPAWN_DISTANCE = 1400;

/** Short verb phrase for `formatInteractPrompt` ("E — board the car"). */
export const ABANDONED_MOUNT_PROMPT: Record<MountMode, string> = {
  drive: "board the car",
  scooter: "hop on the scooter",
  plane: "board the plane",
  boat: "board the boat",
  speedboat: "board the speedboat",
  drone: "board the drone",
  board: "hop on the hoverboard",
  surf: "hop on the surfboard",
  bird: "ride the phoenix"
};

const SPECS: Record<MountMode, MountSpec> = {
  drive: {
    build: buildCarMesh,
    halfExtents: [DEFAULT_DRIVE_SPEC.halfExtents[0], DEFAULT_DRIVE_SPEC.halfExtents[1], DEFAULT_DRIVE_SPEC.halfExtents[2]],
    density: 133,
    friction: 0.35,
    restitution: 0.1,
    gravityScale: 1,
    linearDrag: 0.18,
    angularDrag: 1.8,
    maxSpeed: 70
  },
  scooter: {
    build: () => buildScooterMesh(localScooterConfig()),
    halfExtents: [0.52, 0.42, 1.35],
    density: 72,
    friction: 0.4,
    restitution: 0.06,
    gravityScale: 1,
    linearDrag: 0.25,
    angularDrag: 2.2,
    maxSpeed: 58
  },
  plane: {
    build: buildPlaneMesh,
    halfExtents: [1.1, 0.5, 2.6],
    density: 70,
    friction: 0.3,
    restitution: 0.2,
    // flight is code-driven (glide then crash), so gravity stays off until the
    // crash dive supplies its own downward push
    gravityScale: 0,
    linearDrag: 0.035,
    angularDrag: 0.45,
    maxSpeed: 180
  },
  boat: {
    build: buildBoatMesh,
    halfExtents: [1.3, 0.75, 3.2],
    density: 40,
    friction: 0.2,
    restitution: 0.1,
    gravityScale: 0,
    linearDrag: 0.45,
    angularDrag: 1.2,
    maxSpeed: 45
  },
  speedboat: {
    build: buildSpeedboatMesh,
    halfExtents: [1.1, 0.6, 2.9],
    density: 45,
    friction: 0.2,
    restitution: 0.1,
    gravityScale: 0,
    linearDrag: 0.4,
    angularDrag: 1.1,
    maxSpeed: 55
  },
  drone: {
    build: buildDroneMesh,
    halfExtents: [1.0, 0.25, 1.0],
    density: 25,
    friction: 0.3,
    restitution: 0.25,
    gravityScale: 0.18,
    linearDrag: 0.5,
    angularDrag: 1.4,
    maxSpeed: 80
  },
  board: {
    // your abandoned board should look like YOUR board, not the default
    build: () => buildBoardMesh(localBoardConfig()),
    halfExtents: [0.55, 0.25, 1.15],
    density: 60,
    friction: 0.15,
    restitution: 0.1,
    gravityScale: 0,
    linearDrag: 0.55,
    angularDrag: 1.8,
    maxSpeed: 60
  },
  surf: {
    build: buildSurfboardMesh,
    halfExtents: [0.5, 0.16, 1.55],
    density: 48,
    friction: 0.08,
    restitution: 0.04,
    gravityScale: 0,
    linearDrag: 0.8,
    angularDrag: 2.1,
    maxSpeed: 42
  },
  bird: {
    build: buildBirdMesh,
    halfExtents: [1.86, 0.84, 1.86],
    density: 20,
    friction: 0.3,
    restitution: 0.2,
    // a released phoenix flies on forever under its own steer — no gravity, the
    // wander loop owns its whole velocity
    gravityScale: 0,
    linearDrag: 0.22,
    angularDrag: 0.8,
    maxSpeed: 120
  }
};

const V = {
  linear: new THREE.Vector3(),
  fwd: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  euler: new THREE.Euler(0, 0, 0, "YXZ")
};

function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) materials.add(m);
    } else if (material) {
      materials.add(material);
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
}

export class AbandonedMounts {
  #physics: Physics;
  #map: WorldMap;
  #scene: THREE.Scene;
  #items: AbandonedMount[] = [];
  #time = 0;

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    this.#physics = physics;
    this.#map = map;
    this.#scene = scene;
  }

  get count(): number {
    return this.#items.length;
  }

  /** Debug: live mount summary (headless scatter/float checks). */
  debugMounts() {
    return this.#items.map((it) => {
      const t = this.#physics.world.getBodyTransform(it.handle);
      return { mode: it.mode, x: +t.position[0].toFixed(1), y: +t.position[1].toFixed(2), z: +t.position[2].toFixed(1), persistent: !!it.persistent };
    });
  }

  /**
   * Peek at the nearest parked/roaming mount within `radius` (XZ) without
   * claiming it — used for the walk-up "E — board …" proximity nudge.
   */
  nearest(x: number, z: number, radius: number): { mode: MountMode } | null {
    const best = this.#findNearest(x, z, radius);
    return best ? { mode: best.mode } : null;
  }

  /**
   * Walk-up re-board: the nearest parked/roaming mount of ANY kind within
   * `radius`, removed from the world and handed back as a spawn pose so the
   * caller can `trySwitch` into it (same as hopping into a parked car).
   */
  boardNearest(
    x: number,
    z: number,
    radius: number
  ): { mode: MountMode; x: number; y: number; z: number; heading: number } | null {
    const best = this.#findNearest(x, z, radius);
    if (!best) return null;
    return this.#takePose(best);
  }

  #findNearest(x: number, z: number, radius: number): AbandonedMount | null {
    let best: AbandonedMount | null = null;
    let bestD = radius;
    for (const item of this.#items) {
      const t = this.#physics.world.getBodyTransform(item.handle);
      const d = Math.hypot(t.position[0] - x, t.position[2] - z);
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    return best;
  }

  #takePose(item: AbandonedMount): { mode: MountMode; x: number; y: number; z: number; heading: number } {
    const t = this.#physics.world.getBodyTransform(item.handle);
    V.fwd.set(0, 0, -1).applyQuaternion(
      V.quat.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3])
    );
    const heading = Math.atan2(-V.fwd.x, -V.fwd.z) + Math.PI;
    const mode = item.mode;
    this.#remove(this.#items.indexOf(item));
    return { mode, x: t.position[0], y: t.position[1], z: t.position[2], heading };
  }

  spawn(mode: MountMode, pose: ReleasePose, opts?: { persistent?: boolean }) {
    const spec = SPECS[mode];
    const mesh = spec.build();
    setEmbodimentVisible(mesh, true);
    mesh.position.copy(pose.position);
    mesh.quaternion.copy(pose.quaternion);
    this.#scene.add(mesh);

    const handle = this.#physics.world.createBox({
      type: BodyType.Dynamic,
      position: [pose.position.x, pose.position.y, pose.position.z],
      halfExtents: spec.halfExtents,
      density: spec.density,
      friction: spec.friction,
      restitution: spec.restitution
    });
    this.#physics.world.setBodyTransform(handle, [pose.position.x, pose.position.y, pose.position.z], [
      pose.quaternion.x,
      pose.quaternion.y,
      pose.quaternion.z,
      pose.quaternion.w
    ]);
    this.#physics.world.setBodyGravityScale(handle, spec.gravityScale);

    const linear = V.linear.set(pose.linear[0], pose.linear[1], pose.linear[2]);
    if (mode === "plane" && linear.length() < 12) {
      V.fwd.set(0, 0, -1).applyQuaternion(pose.quaternion).multiplyScalar(35);
      linear.copy(V.fwd);
    }
    if (linear.length() > spec.maxSpeed) linear.setLength(spec.maxSpeed);
    this.#physics.world.setBodyVelocity(handle, [linear.x, linear.y, linear.z], [
      pose.angular[0],
      pose.angular[1],
      pose.angular[2]
    ]);

    const item: AbandonedMount = { mode, spec, handle, mesh, age: 0, persistent: opts?.persistent };
    if (mode === "plane") {
      item.planeAnim = collectPlaneAnim(mesh);
      // cruise straight for a few seconds, then tip into the crash dive
      item.glideTime = 4 + Math.random() * 3;
      item.crashed = false;
    }
    if (mode === "drone") item.rotors = mesh.userData.rotors as THREE.Group[] | undefined;
    if (mode === "bird") {
      // steer off along whatever way it was facing when released
      V.fwd.set(0, 0, -1).applyQuaternion(pose.quaternion);
      item.wanderYaw = Math.atan2(-V.fwd.x, -V.fwd.z);
      item.wanderTimer = 2 + Math.random() * 3;
      item.targetY = Math.max(pose.position.y, this.#map.effectiveGround(pose.position.x, pose.position.z) + 45);
      item.flapPhase = 0;
      item.animT = 0;
    }
    if (mode === "boat" || mode === "speedboat") {
      // scattered bay boats sail themselves: seed a heading from the release
      // facing + a desynced bob clock (persistent ones actually wander)
      V.fwd.set(0, 0, -1).applyQuaternion(pose.quaternion);
      item.wanderYaw = Math.atan2(-V.fwd.x, -V.fwd.z);
      item.wanderTimer = 2 + Math.random() * 3;
      item.animT = Math.random() * 10;
    }
    this.#items.push(item);
    // cap only the transient mounts; scattered persistent boats never get evicted
    if (!item.persistent) {
      while (this.#items.filter((m) => !m.persistent).length > MAX_MOUNTS) {
        const idx = this.#items.findIndex((m) => !m.persistent);
        if (idx < 0) break;
        this.#remove(idx);
      }
    }
  }

  prePhysics(dt: number) {
    this.#time += dt;
    const w = this.#physics.world;
    for (const item of this.#items) {
      if (item.mode === "bird") {
        this.#flyBird(item, dt);
        continue;
      }
      if (item.mode === "plane") {
        this.#flyPlane(item, dt);
        continue;
      }
      const t = w.getBodyTransform(item.handle);
      const vel = w.getBodyVelocity(item.handle);
      w.setBodyAwake(item.handle, true);

      // scattered bay boats sail themselves around the water on their own
      if ((item.mode === "boat" || item.mode === "speedboat") && item.persistent) {
        this.#sailBoat(item, dt);
        continue;
      }

      const linearDamp = Math.exp(-item.spec.linearDrag * dt);
      const angularDamp = Math.exp(-item.spec.angularDrag * dt);
      let vx = vel.linear[0] * linearDamp;
      let vy = vel.linear[1];
      let vz = vel.linear[2] * linearDamp;

      if (item.mode === "boat" || item.mode === "speedboat") {
        const targetY = waterHeight(t.position[0], t.position[2], this.#time) + 0.15;
        vy = THREE.MathUtils.clamp((targetY - t.position[1]) * 6 + vy * 0.2, -7, 7);
      } else if (item.mode === "board") {
        const surf = Math.max(
          this.#map.rideGround(t.position[0], t.position[2], t.position[1]),
          waterHeight(t.position[0], t.position[2], this.#time)
        );
        const targetY = surf + 1.0;
        vy = t.position[1] < targetY + 4 ? THREE.MathUtils.clamp((targetY - t.position[1]) * 9 + vy * 0.18, -10, 14) : vy - 16 * dt;
      } else if (item.mode === "surf") {
        const targetY = waterHeight(t.position[0], t.position[2], this.#time) + 0.2;
        vy = THREE.MathUtils.clamp((targetY - t.position[1]) * 8 + vy * 0.15, -9, 12);
      }

      w.setBodyVelocity(
        item.handle,
        [vx, vy, vz],
        [vel.angular[0] * angularDamp, vel.angular[1] * angularDamp, vel.angular[2] * angularDamp]
      );
    }
  }

  /**
   * A released phoenix flies itself: it wanders a heading (re-picked every few
   * seconds), cruises at a steady clip, holds a roaming altitude that never
   * drops into the terrain or climbs out of the sky, and banks/pitches into
   * whatever it's doing. No gravity, no lifetime — its own creature now.
   */
  #flyBird(item: AbandonedMount, dt: number) {
    const w = this.#physics.world;
    const t = w.getBodyTransform(item.handle);
    w.setBodyAwake(item.handle, true);
    const x = t.position[0];
    const z = t.position[2];
    const y = t.position[1];

    item.wanderTimer = (item.wanderTimer ?? 0) - dt;
    if (item.wanderTimer <= 0) {
      item.wanderTimer = 3 + Math.random() * 4;
      // veer to a new heading and a new cruising height
      item.wanderYaw = (item.wanderYaw ?? 0) + (Math.random() - 0.5) * 2.0;
      const ground = this.#map.effectiveGround(x, z);
      item.targetY = ground + 35 + Math.random() * 90;
    }

    const yaw = item.wanderYaw ?? 0;
    const cruise = 24;
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);

    // altitude hold: never below a safe clearance over the terrain/water
    const ground = this.#map.effectiveGround(x, z);
    const floor = ground + 18;
    const want = Math.max(item.targetY ?? floor, floor);
    const vy = THREE.MathUtils.clamp((want - y) * 0.9, -9, 12);

    w.setBodyVelocity(item.handle, [fwdX * cruise, vy, fwdZ * cruise], [0, 0, 0]);

    // attitude: nose into the climb/descent, a gentle body roll for life
    const speed = Math.hypot(cruise, vy);
    const pitch = Math.asin(THREE.MathUtils.clamp(vy / Math.max(speed, 4), -1, 1)) * 0.8;
    const roll = Math.sin(this.#time * 0.5 + (item.animT ?? 0)) * 0.12;
    V.euler.set(pitch, yaw, roll);
    V.quat.setFromEuler(V.euler);
    w.setBodyTransform(item.handle, [x, y, z], [V.quat.x, V.quat.y, V.quat.z, V.quat.w]);
  }

  /**
   * A scattered bay boat sails itself: it holds a wander heading (re-picked
   * every few seconds), cruises at a lazy clip, rides the swell, and probes the
   * water ahead so it veers back to open bay before it runs aground or into a
   * bridge pier. Sailboats amble; speedboats run a touch quicker.
   */
  #sailBoat(item: AbandonedMount, dt: number) {
    const w = this.#physics.world;
    const t = w.getBodyTransform(item.handle);
    const x = t.position[0];
    const z = t.position[2];
    const y = t.position[1];

    const isSpeed = item.mode === "speedboat";
    const cruise = isSpeed ? 12 : 7;
    const lookahead = isSpeed ? 42 : 28;

    // occasional lazy course change
    item.wanderTimer = (item.wanderTimer ?? 0) - dt;
    if (item.wanderTimer <= 0) {
      item.wanderTimer = 4 + Math.random() * 5;
      item.wanderYaw = (item.wanderYaw ?? 0) + (Math.random() - 0.5) * 1.2;
    }

    let yaw = item.wanderYaw ?? 0;
    // stay on open water: is the spot `lookahead` metres ahead of this heading
    // clear bay (water, no bridge deck overhead / pier)?
    const open = (yw: number) => {
      const px = x - Math.sin(yw) * lookahead;
      const pz = z - Math.cos(yw) * lookahead;
      return this.#map.isWater(px, pz) && this.#map.bridgeDeck(px, pz) === -Infinity;
    };
    if (!open(yaw)) {
      // scan outward for the smallest turn that opens onto clear water
      let found = false;
      for (const d of [0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.2, -2.2, 2.8, -2.8]) {
        if (open(yaw + d)) {
          yaw += d;
          found = true;
          break;
        }
      }
      if (!found) yaw += Math.PI; // boxed in — come about
      item.wanderYaw = yaw;
      item.wanderTimer = 1.5 + Math.random() * 2;
    }

    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    // ride the swell: spring toward the wave surface, same as the float path
    const targetY = waterHeight(x, z, this.#time) + 0.15;
    const vel = w.getBodyVelocity(item.handle);
    const vy = THREE.MathUtils.clamp((targetY - y) * 6 + vel.linear[1] * 0.2, -7, 7);
    w.setBodyVelocity(item.handle, [fwdX * cruise, vy, fwdZ * cruise], [0, 0, 0]);

    // face the way it's sailing, with a gentle heel/pitch for life
    const roll = Math.sin(this.#time * 0.6 + (item.animT ?? 0)) * 0.05;
    const pitch = Math.sin(this.#time * 0.5 + (item.animT ?? 0) + 1.3) * 0.03;
    V.euler.set(pitch, yaw, roll);
    V.quat.setFromEuler(V.euler);
    w.setBodyTransform(item.handle, [x, y, z], [V.quat.x, V.quat.y, V.quat.z, V.quat.w]);
  }

  /**
   * An abandoned plane flies straight for `glideTime`, then noses over into a
   * gravity-fed dive. Once it touches the ground it's a wreck: velocity zeroed,
   * left to rest exactly where it fell.
   */
  #flyPlane(item: AbandonedMount, dt: number) {
    const w = this.#physics.world;
    const t = w.getBodyTransform(item.handle);
    const x = t.position[0];
    const z = t.position[2];
    const y = t.position[1];
    const ground = this.#map.effectiveGround(x, z);

    if (item.crashed || y <= ground + 1.6) {
      // down for good — stop steering it and let the solver settle the wreck
      item.crashed = true;
      w.setBodyVelocity(item.handle, [0, 0, 0], [0, 0, 0]);
      return;
    }

    w.setBodyAwake(item.handle, true);
    const vel = w.getBodyVelocity(item.handle);
    const damp = Math.exp(-item.spec.linearDrag * dt);
    let vx = vel.linear[0] * damp;
    let vy = vel.linear[1];
    let vz = vel.linear[2] * damp;

    if ((item.age ?? 0) < (item.glideTime ?? 0)) {
      vy += (-1 - vy) * Math.min(1, dt * 1.5); // hold a shallow, near-level glide
    } else {
      vy -= 22 * dt; // engine's dead — gravity takes the nose down
    }
    w.setBodyVelocity(item.handle, [vx, vy, vz], [vel.angular[0] * 0.9, vel.angular[1] * 0.9, vel.angular[2] * 0.9]);
  }

  update(dt: number, playerPos: THREE.Vector3) {
    const w = this.#physics.world;
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const item = this.#items[i];
      item.age += dt;
      const t = w.getBodyTransform(item.handle);
      item.mesh.position.set(t.position[0], t.position[1], t.position[2]);
      item.mesh.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
      this.#animate(item, dt);

      const dist = Math.hypot(t.position[0] - playerPos.x, t.position[2] - playerPos.z);
      const maxDist = item.mode === "bird" ? BIRD_DESPAWN_DISTANCE : DESPAWN_DISTANCE;
      if (t.position[1] < -100 || (!item.persistent && dist > maxDist)) this.#remove(i);
    }
  }

  #animate(item: AbandonedMount, dt: number) {
    if (item.planeAnim && !item.crashed) {
      const speed = this.#speed(item.handle);
      const spin = dt * (7 + speed * 0.55);
      for (const p of item.planeAnim.props) p.rotation.z += spin;
    }
    if (item.rotors) {
      for (const r of item.rotors) r.rotation.y += dt * 38 * (r.userData.dir ?? 1);
    }
    if (item.mode === "bird") this.#flapBird(item, dt);
  }

  /** Procedural wingbeat for a free-flying phoenix — a lighter echo of the
   *  playable bird's travelling-wave flap so an abandoned one still beats its
   *  wings and streams its tail as it roams. */
  #flapBird(item: AbandonedMount, dt: number) {
    const r = item.mesh.userData.rig as BirdRig | undefined;
    if (!r) return; // GLB still loading
    item.animT = (item.animT ?? 0) + dt;
    item.flapPhase = (item.flapPhase ?? 0) + dt * Math.PI * 2 * 2.3;
    const wingBeat = (ph: number) => {
      const wr = ph - 0.35 * Math.sin(ph);
      const s = Math.sin(wr) + 0.15 * Math.sin(2 * wr - 0.5);
      return s > 0 ? s : s * 0.4;
    };
    const drive = 0.5;
    const seg = 1.05;
    const wave = (i: number) => wingBeat((item.flapPhase ?? 0) - i * seg);
    const beat = wave(0) * drive * 0.85;
    const fore = wave(1) * drive;
    const tip = wave(2) * drive * 1.18;
    const up = 0.08 + beat;
    poseBone(r.wingL, 0, 0, up);
    poseBone(r.wingR, 0, 0, -up);
    poseBone(r.elbowL, 0, 0, fore);
    poseBone(r.elbowR, 0, 0, -fore);
    poseBone(r.handL, 0, 0, tip);
    poseBone(r.handR, 0, 0, -tip);
    for (let i = 0; i < r.tail.length; i++) {
      const wave2 = Math.sin(item.animT * 2.0 - i * 0.75) * 0.08 * (0.3 + i * 0.3);
      poseBone(r.tail[i], 0, wave2, 0);
    }
  }

  #speed(handle: number): number {
    const v = this.#physics.world.getBodyVelocity(handle).linear;
    return Math.hypot(v[0], v[1], v[2]);
  }

  #remove(index: number) {
    const item = this.#items[index];
    this.#items.splice(index, 1);
    this.#physics.world.destroyBody(item.handle);
    item.mesh.removeFromParent();
    disposeObject(item.mesh);
  }
}
