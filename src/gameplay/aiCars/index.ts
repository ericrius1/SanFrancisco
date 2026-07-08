/**
 * AiCars — the single facade main.ts talks to.
 *
 * Owns the RoadGraph load, the Fleet (persistent kinematic sim), the Learner
 * (online continual-learning brains, localStorage-persisted), the procedural car
 * meshes, and the floating brain-lattice overlays. main.ts only calls:
 *   new AiCars(physics, map, scene, getCamera)
 *   await ready()                 — async init; app boot never blocks on it
 *   prePhysics(dt, anchors)       — in the fixed physics loop
 *   update(frameDt, playerPos, highUp) — per render frame (meshes/overlays)
 *   setOverlays(on) / netDebug()
 *   onWillRemoveBody = fn         — forwarded to the fleet (ropes/grab release)
 *
 * Every car is a PERSISTENT INDIVIDUAL: it keeps its id, body, paint, position,
 * and its own brain, and learns forever. There are no generations/genomes. In
 * multiplayer only the leader (lowest live id) runs the sim; everyone else
 * renders ghosts from 8 Hz pose snapshots and caches the leader's round-robin
 * `brain` broadcasts so a promotion can adopt every individual seamlessly.
 *
 * The fleet runs against an injected FleetWorld; this file is the browser
 * adapter mapping Physics (kinematic boxes + building sweeps) and WorldMap
 * (ground height + water) into it.
 */
import * as THREE from "three/webgpu";
import { BodyType } from "../../core/physics";
import type { Physics } from "../../core/physics";
import type { WorldMap } from "../../world/heightmap";
import type { AiCarsLife, CarLifeBlob } from "../../net/net";
import { RoadGraph } from "./roadGraph.ts";
import { Fleet, MAX_CARS, type FleetWorld, type FleetBlob, type CarBlob } from "./fleet.ts";
import { Learner, ACTOR_SIZES } from "./learner.ts";
import { BrainOverlay } from "./brainOverlay.ts";
import { buildCarMesh } from "./carMesh.ts";
import { StatsChip, type LifeStats } from "./statsChip.ts";
import { GhostStore, isLeader, serializeCars, HIDDEN } from "./netSync.ts";
import type { InspectableBrain } from "../../ui/brainPanel/types.ts";

// obs slots filled in fleet.ts (#obs): keep in sync with the sensor block there.
const CAR_INPUT_LABELS = [
  "speed",
  "lateral off",
  "sin(hdg err)",
  "cos(hdg err)",
  "curvature",
  "clear ahead",
  "clear left",
  "clear right",
  "bias"
];
const CAR_OUTPUT_LABELS = ["steer", "throttle"];

/** Minimal slice of the Net client AiCars talks to (see src/net/net.ts). */
export interface AiCarsNet {
  selfId: number;
  roster: Map<number, unknown>;
  aicarsLife: AiCarsLife | null;
  onCars: (id: number, rows: number[][]) => void;
  onBrain: (blob: CarLifeBlob) => void;
  sendCars(rows: number[][]): void;
  sendBrain(blob: CarLifeBlob): void;
}

const CARS_SEND_INTERVAL = 1 / 8; // s: leader → ghost pose-snapshot rate (8 Hz)
const BRAIN_INTERVAL = 1.5; // s: leader round-robins ONE car's brain this often
const REMOTE_ANCHOR_REFRESH = 200; // ms: how often the leader re-reads remotes
const SAVE_INTERVAL = 60; // s: localStorage autosave cadence (leader only)
const LS_KEY = "sf_aicars_life_v2"; // localStorage key for the persisted fleet
const TREND_WINDOW_S = 600; // s: HUD skill-trend baseline (10 min)
const TREND_EPS = 5; // reward/min dead-band for the trend arrow

const OVERLAY_RANGE = 130; // metres: cars within this get a live brain lattice
const OVERLAY_LIFT = 0.9; // metres above the car top the lattice floats
const CAR_TOP = 1.3; // ~ roof height above the wheel-contact origin
const WHEEL_RADIUS = 0.35; // nominal, for rolling-speed → spin rate
const MAX_STEER_ANGLE = 0.5; // rad, visual front-wheel turn at full steer
const STATS_INTERVAL = 1.0; // s between HUD chip refreshes

type CarMeshData = {
  wheels: THREE.Mesh[]; // all four, spun by speed
  front: THREE.Mesh[]; // fl + fr, steered by car.steer
  spin: number; // accumulated wheel roll angle
};

/** Median of a numeric list (0 for empty). */
function median(a: number[]): number {
  if (a.length === 0) return 0;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

/** Round every element to 4 dp (compact wire form for weight vectors). */
function round4(a: number[]): number[] {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(a[i] * 1e4) / 1e4;
  return out;
}

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export class AiCars {
  /** Forwarded to the fleet: fires just before a car body is destroyed. */
  onWillRemoveBody: (handle: number) => void = () => {};

  #physics: Physics;
  #map: WorldMap;
  #scene: THREE.Scene;
  #getCamera: () => THREE.Camera;

  #fleet: Fleet | null = null;
  #learner: Learner | null = null;
  #overlay: BrainOverlay | null = null;
  #chip: StatsChip | null = null;
  #ready = false;
  #overlaysOn = true;
  #statsTimer = 0;

  // --- multiplayer (netSync) ---
  #net: AiCarsNet | null = null;
  #remotePositions: (() => { x: number; z: number }[]) | null = null;
  #ghosts: GhostStore | null = null;
  #isLeader = true; // solo default: run the fleet locally
  #carsTimer = 0; // leader pose-snapshot pacing
  #brainTimer = 0; // leader round-robin brain pacing
  #brainCursor = 0; // next car id to broadcast a brain for
  #brainCache = new Map<number, CarLifeBlob>(); // received brains (non-leader)
  #cachedBorn = 0; // world born-epoch from the last life set we saw
  #adoptedLife: AiCarsLife | null = null; // welcome set already adopted as leader
  #seededLife: AiCarsLife | null = null; // welcome set already seeded into the cache
  #saveTimer = SAVE_INTERVAL; // localStorage autosave countdown
  #trendSamples: { t: number; skill: number }[] = []; // median-skill history (HUD trend)
  #pagehide: (() => void) | null = null;
  #anchorBuf: THREE.Vector3[] = []; // reused combined-anchor array
  #remotePool: THREE.Vector3[] = []; // reused remote-anchor vectors
  #remoteCount = 0;
  #remoteAt = 0;

  // reused scratch — no per-frame allocation in the hot paths
  #up = new THREE.Vector3(0, 1, 0);
  #nrm = new THREE.Vector3();
  #qYaw = new THREE.Quaternion();
  #qTilt = new THREE.Quaternion();
  #worldPos = new THREE.Vector3();
  #zeroObs = new Float32Array(ACTOR_SIZES[0]);
  #zeroOut = new Float32Array(ACTOR_SIZES[ACTOR_SIZES.length - 1]);
  #ghostLayerOut: Float32Array[] = []; // [hidden, output] handed to the overlay

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene, getCamera: () => THREE.Camera) {
    this.#physics = physics;
    this.#map = map;
    this.#scene = scene;
    this.#getCamera = getCamera;
  }

  /**
   * Async init: load the road graph, then build fleet/learner/overlay and
   * restore the persisted fleet from localStorage. Fire and forget from main.ts
   * — no cars exist until this resolves, and app boot never blocks on it.
   * Failures are logged and leave AiCars inert.
   */
  async ready(): Promise<void> {
    if (this.#ready) return;
    let roads: RoadGraph;
    try {
      roads = await RoadGraph.load();
    } catch (err) {
      console.warn("[aiCars] road graph load failed — AI cars disabled", err);
      return;
    }
    const learner = new Learner(MAX_CARS);
    const fleet = new Fleet(this.#buildWorld(), roads, learner);
    fleet.onWillRemoveBody = (h) => this.onWillRemoveBody(h);
    this.#learner = learner;
    this.#fleet = fleet;
    this.#restoreFromLocalStorage(); // localStorage < welcome (adopted later if newer)
    const overlay = new BrainOverlay(this.#scene, [...ACTOR_SIZES], this.#fleetSize(fleet), this.#getCamera);
    overlay.setEnabled(this.#overlaysOn);
    this.#overlay = overlay;
    this.#chip = new StatsChip();
    this.#ghosts = new GhostStore(this.#fleetSize(fleet));
    this.#ghostLayerOut = [new Float32Array(HIDDEN), this.#zeroOut];
    // flush the fleet to disk when the tab is backgrounded / closed
    if (typeof window !== "undefined") {
      this.#pagehide = () => this.#saveLife();
      window.addEventListener("pagehide", this.#pagehide);
    }
    this.#ready = true;
    // net may have attached before the road graph finished loading
    this.#syncRole();
  }

  /**
   * Wire up multiplayer. `remotePositions` returns the current remote players'
   * ground positions so the leader can anchor spawning around everyone, not just
   * the local player. Safe to call before `ready()` resolves.
   */
  attachNet(net: AiCarsNet, remotePositions?: () => { x: number; z: number }[]): void {
    this.#net = net;
    this.#remotePositions = remotePositions ?? null;
    net.onCars = (_id, rows) => this.#ghosts?.ingest(rows);
    net.onBrain = (blob) => this.#receiveBrain(blob);
    if (net.aicarsLife) this.#seedCacheFromLife(net.aicarsLife); // welcome carried a saved fleet
    this.#syncRole();
  }

  /** A brain arrived from the leader: cache it for the HUD + a future promotion. */
  #receiveBrain(blob: CarLifeBlob): void {
    this.#brainCache.set(blob.id, blob);
  }

  /** Seed the cache from a whole life set (relay welcome). */
  #seedCacheFromLife(life: AiCarsLife): void {
    this.#cachedBorn = life.born;
    for (const c of life.cars) this.#brainCache.set(c.id, c);
    this.#seededLife = life;
  }

  #fleetSize(fleet: Fleet): number {
    return fleet.cars.length;
  }

  // ------------------------------------------------------------ persistence

  /** Restore the fleet from localStorage (fresh init if absent/corrupt). */
  #restoreFromLocalStorage(): void {
    const fleet = this.#fleet;
    if (!fleet) return;
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const blob = JSON.parse(raw) as FleetBlob;
      if (fleet.importState(blob)) this.#cachedBorn = blob.born;
    } catch {
      /* private-mode / quota / malformed — just start fresh */
    }
  }

  /** Persist the whole fleet to localStorage (leader only; no-op off-browser). */
  #saveLife(): void {
    if (!this.#isLeader || !this.#fleet) return;
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(LS_KEY, JSON.stringify(this.#fleet.exportState()));
    } catch {
      /* private-mode / quota — training just won't persist */
    }
  }

  /** Sum of every car's age (the monotone "which fleet is further along" key). */
  #fleetAgeSum(): number {
    const l = this.#learner;
    const fleet = this.#fleet;
    if (!l || !fleet) return 0;
    let s = 0;
    for (const car of fleet.cars) s += l.age(car.id);
    return s;
  }

  /**
   * Adopt the relay's welcome set if it's further along (larger summed age) than
   * our current fleet. This is the "relay welcome > localStorage > fresh" step:
   * localStorage seeded us in ready(), and a fresh fleet has age-sum 0, so a
   * saved city always wins over a blank one, and a longer-lived local fleet is
   * never clobbered. Runs once per distinct welcome set.
   */
  #maybeAdoptLife(): void {
    const life = this.#net?.aicarsLife;
    const fleet = this.#fleet;
    if (!fleet || !life || life === this.#adoptedLife) return;
    this.#adoptedLife = life; // considered — don't re-evaluate this exact set
    let incoming = 0;
    for (const c of life.cars) incoming += c.ageS;
    if (incoming > this.#fleetAgeSum()) {
      fleet.importState({ v: 2, born: life.born, cars: life.cars as CarBlob[] });
      this.#cachedBorn = life.born;
    }
  }

  /** Browser adapter: Physics + WorldMap → the fleet's injected world. */
  #buildWorld(): FleetWorld {
    const physics = this.#physics;
    const map = this.#map;
    return {
      ground: (x, z) => map.effectiveGround(x, z),
      isWater: (x, z) => map.isWater(x, z),
      sweep: (p0, p1) => {
        const h = physics.sweepBuildings(p0, p1);
        if (!h) return null;
        return Math.hypot(h.x - p0[0], h.y - p0[1], h.z - p0[2]);
      },
      createBody: (x, y, z, hx, hy, hz, heading) => {
        const handle = physics.world.createBox({
          type: BodyType.Kinematic,
          position: [x, y, z],
          halfExtents: [hx, hy, hz],
          friction: 0.4,
          restitution: 0.1
        });
        physics.world.setBodyTransform(handle, [x, y, z], [0, Math.sin(heading / 2), 0, Math.cos(heading / 2)]);
        return handle;
      },
      moveBody: (handle, x, y, z, qx, qy, qz, qw) => {
        physics.world.setBodyTransform(handle, [x, y, z], [qx, qy, qz, qw]);
      },
      removeBody: (handle) => {
        physics.world.destroyBody(handle);
      }
    };
  }

  /** Fixed-step: advance roster + kinematic sim. Cheap (32 tiny MLPs). */
  prePhysics(dt: number, anchors: THREE.Vector3[]): void {
    if (!this.#ready || this.#fleet === null) return;
    this.#syncRole();
    if (!this.#isLeader) return; // ghosts run no sim
    this.#fleet.prePhysics(dt, this.#combineAnchors(anchors));
  }

  /** Recompute leadership; run promote/demote once on a transition. */
  #syncRole(): void {
    if (!this.#ready) return;
    const leader = isLeader(this.#net);
    if (leader !== this.#isLeader) {
      this.#isLeader = leader;
      if (leader) this.#promote();
      else this.#demote();
    }
    if (leader) {
      // pick up a relay welcome set that's ahead of our fleet (welcome > LS > fresh)
      this.#maybeAdoptLife();
    } else if (this.#net?.aicarsLife && this.#net.aicarsLife !== this.#seededLife) {
      // welcome can land after attachNet — seed the promotion cache when it does
      this.#seedCacheFromLife(this.#net.aicarsLife);
    }
  }

  /** Ghost → leader: adopt cached brains at their ghost positions, then reset. */
  #promote(): void {
    this.#adoptCachedBrains();
    this.#ghosts?.clear();
    this.#clearAllCarMeshes();
    this.#brainTimer = 0; // broadcast a brain promptly so ghosts stay warm
    this.#carsTimer = 0;
  }

  /**
   * On promotion, load every cached individual into the fleet, overriding each
   * car's stored position with the LIVE ghost pose for that slot so there's no
   * snap — the cars keep driving from exactly where the departing leader left
   * them. Cars we never received a brain for keep their prior (localStorage /
   * fresh) state.
   */
  #adoptCachedBrains(): void {
    const fleet = this.#fleet;
    if (!fleet || this.#brainCache.size === 0) return;
    const cars: CarBlob[] = [];
    for (const [id, blob] of this.#brainCache) {
      const g = this.#ghosts?.cars[id];
      const c: CarBlob = { ...blob };
      // Adopt the LIVE ghost pose if we saw it recently (~10 s), even if the
      // ghost already timed out to inactive — otherwise a promotion >1.5 s after
      // leader silence would snap cars back to blob positions up to 48 s stale.
      if (g && g.spawned && performance.now() - g.seen < 10000) {
        c.x = g.pos.x;
        c.z = g.pos.z;
        c.heading = g.heading;
      }
      cars.push(c);
    }
    fleet.importState({ v: 2, born: this.#cachedBorn || Date.now(), cars });
  }

  /** Leader → ghost: tear down the local fleet's bodies and go render-only. */
  #demote(): void {
    this.#fleet?.dispose(); // frees kinematic bodies (fires onWillRemoveBody)
    this.#clearAllCarMeshes();
  }

  /** Remove every car/ghost mesh from the scene and hide all overlays. */
  #clearAllCarMeshes(): void {
    const fleet = this.#fleet;
    if (fleet) {
      for (const car of fleet.cars) {
        if (car.mesh) {
          this.#scene.remove(car.mesh);
          car.mesh = undefined;
        }
      }
    }
    const ghosts = this.#ghosts;
    if (ghosts) {
      for (const g of ghosts.cars) {
        if (g.mesh) {
          this.#scene.remove(g.mesh);
          g.mesh = undefined;
        }
      }
    }
    const overlay = this.#overlay;
    if (overlay) for (let i = 0; i < (fleet?.cars.length ?? 0); i++) overlay.hide(i);
  }

  /** Combine the caller's anchors with cached remote-player positions. */
  #combineAnchors(anchors: THREE.Vector3[]): THREE.Vector3[] {
    const buf = this.#anchorBuf;
    buf.length = 0;
    for (const a of anchors) buf.push(a);
    this.#refreshRemoteAnchors();
    for (let i = 0; i < this.#remoteCount; i++) buf.push(this.#remotePool[i]);
    return buf;
  }

  /** Re-read remote positions at most every REMOTE_ANCHOR_REFRESH ms. */
  #refreshRemoteAnchors(): void {
    const get = this.#remotePositions;
    if (!get) {
      this.#remoteCount = 0;
      return;
    }
    const now = performance.now();
    if (now - this.#remoteAt < REMOTE_ANCHOR_REFRESH) return;
    this.#remoteAt = now;
    const list = get();
    while (this.#remotePool.length < list.length) this.#remotePool.push(new THREE.Vector3());
    for (let i = 0; i < list.length; i++) this.#remotePool[i].set(list[i].x, 0, list[i].z);
    this.#remoteCount = list.length;
  }

  /** Per render frame: attach/mirror meshes, spin wheels, drive overlays. */
  update(frameDt: number, playerPos: THREE.Vector3, highUp: boolean): void {
    const fleet = this.#fleet;
    const overlay = this.#overlay;
    if (!this.#ready || fleet === null || overlay === null) return;
    this.#syncRole();

    const overlaysActive = this.#overlaysOn && !highUp;
    const range2 = OVERLAY_RANGE * OVERLAY_RANGE;

    if (this.#isLeader) {
      for (const car of fleet.cars) {
        if (!car.alive) {
          if (car.mesh) {
            this.#scene.remove(car.mesh);
            car.mesh = undefined;
            overlay.hide(car.id);
          }
          continue;
        }
        this.#renderCar(car, car.id, car.bodyKind, car.paintHue, car.pos, car.heading, car.speed, car.steer, car.policy.layerOut, car.lastObs, frameDt, playerPos, overlaysActive, range2);
      }
      this.#broadcast(frameDt);
      // localStorage autosave (leader only)
      this.#saveTimer -= frameDt;
      if (this.#saveTimer <= 0) {
        this.#saveTimer = SAVE_INTERVAL;
        this.#saveLife();
      }
    } else {
      this.#updateGhosts(frameDt, playerPos, overlaysActive, range2);
    }

    // HUD stat chip ~1 Hz
    this.#statsTimer -= frameDt;
    if (this.#statsTimer <= 0) {
      this.#statsTimer = STATS_INTERVAL;
      const chip = this.#chip;
      if (chip) {
        const s = this.#lifeStats();
        if (s.count > 0) chip.set(s);
        else chip.hide();
      }
    }
  }

  /**
   * Brains the player can click to inspect: every visible (lattice-shown) leader
   * car, wrapped as an InspectableBrain for src/ui/brainPanel. Ghost cars have no
   * local Policy to forward, so only the leader's own fleet is inspectable.
   */
  inspectables(): InspectableBrain[] {
    const fleet = this.#fleet;
    const overlay = this.#overlay;
    if (!this.#ready || !fleet || !overlay || !this.#isLeader) return [];
    const out: InspectableBrain[] = [];
    for (const car of fleet.cars) {
      if (!car.alive || !car.mesh || !overlay.isShown(car.id)) continue;
      const pos = car.pos; // live Vector3, mutated in place each frame
      const policy = car.policy;
      const lastObs = car.lastObs;
      out.push({
        id: `car:${car.id}`,
        label: `AI Car #${car.id}`,
        getWorldPos: (o) => o.set(pos.x, pos.y + CAR_TOP + OVERLAY_LIFT, pos.z),
        pickRadius: 1.3,
        net: policy,
        liveObs: () => lastObs,
        inputLabels: CAR_INPUT_LABELS,
        outputLabels: CAR_OUTPUT_LABELS
      });
    }
    return out;
  }

  /** Interpolate + draw received ghost cars (non-leader path). */
  #updateGhosts(frameDt: number, playerPos: THREE.Vector3, overlaysActive: boolean, range2: number): void {
    const ghosts = this.#ghosts;
    const overlay = this.#overlay;
    if (!ghosts || !overlay) return;
    ghosts.advance(frameDt);
    for (const g of ghosts.cars) {
      if (!g.active) {
        if (g.mesh) {
          this.#scene.remove(g.mesh);
          g.mesh = undefined;
          overlay.hide(g.id);
        }
        continue;
      }
      // hidden acts drive the overlay; input/output columns stay dim (dim = zeros)
      this.#ghostLayerOut[0] = g.hidden;
      this.#ghostLayerOut[1] = this.#zeroOut;
      this.#renderCar(g, g.id, g.kind, g.hue, g.pos, g.heading, g.speed, 0, this.#ghostLayerOut, this.#zeroObs, frameDt, playerPos, overlaysActive, range2);
    }
  }

  /** Leader broadcast: 8 Hz pose snapshot + 1.5 s round-robin brain sync. */
  #broadcast(frameDt: number): void {
    const net = this.#net;
    const fleet = this.#fleet;
    const learner = this.#learner;
    if (!net || !fleet || !learner) return;
    this.#carsTimer -= frameDt;
    if (this.#carsTimer <= 0) {
      this.#carsTimer = CARS_SEND_INTERVAL;
      const rows = serializeCars(fleet.cars);
      if (rows.length) net.sendCars(rows);
    }
    this.#brainTimer -= frameDt;
    if (this.#brainTimer <= 0) {
      this.#brainTimer = BRAIN_INTERVAL;
      const i = this.#brainCursor % MAX_CARS;
      this.#brainCursor = (i + 1) % MAX_CARS;
      const blob = this.#carLifeBlob(i);
      if (blob) net.sendBrain(blob);
    }
  }

  /** Build one car's full brain+pose blob for the `brain` broadcast / cache. */
  #carLifeBlob(i: number): CarLifeBlob | null {
    const fleet = this.#fleet;
    const learner = this.#learner;
    if (!fleet || !learner) return null;
    const car = fleet.cars[i];
    if (!car) return null;
    const brain = learner.exportCar(i);
    return {
      v: 2,
      id: car.id,
      actor: round4(brain.actor),
      critic: round4(brain.critic),
      rhoBar: r4(brain.rhoBar),
      sigma: r4(brain.sigma),
      ageS: r4(brain.ageS),
      odoM: r4(brain.odoM),
      lessons: brain.lessons,
      bodyKind: car.bodyKind,
      paintHue: r4(car.paintHue),
      x: r4(car.pos.x),
      z: r4(car.pos.z),
      heading: r4(car.heading)
    };
  }

  /** Attach (if needed), mirror, spin, and overlay one car — fleet or ghost. */
  #renderCar(
    holder: { mesh?: THREE.Group },
    id: number,
    kind: number,
    hue: number,
    pos: THREE.Vector3,
    heading: number,
    speed: number,
    steer: number,
    layerOut: Float32Array[],
    obs: Float32Array,
    frameDt: number,
    playerPos: THREE.Vector3,
    overlaysActive: boolean,
    range2: number
  ): void {
    const overlay = this.#overlay;
    if (!overlay) return;
    let mesh = holder.mesh;
    if (!mesh) {
      mesh = buildCarMesh(kind, hue);
      this.#scene.add(mesh);
      holder.mesh = mesh;
      const wheels: THREE.Mesh[] = [];
      const front: THREE.Mesh[] = [];
      mesh.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.name.startsWith("wheel_")) {
          const w = o as THREE.Mesh;
          wheels.push(w);
          if (o.name === "wheel_fl" || o.name === "wheel_fr") front.push(w);
        }
      });
      (mesh.userData as { car?: CarMeshData }).car = { wheels, front, spin: 0 };
    }

    this.#mirror(pos, heading, mesh);

    const data = (mesh.userData as { car?: CarMeshData }).car;
    if (data) {
      data.spin -= (speed / WHEEL_RADIUS) * frameDt; // -x rolls forward (+z)
      const steerAngle = steer * MAX_STEER_ANGLE;
      for (const w of data.wheels) w.rotation.x = data.spin;
      for (const w of data.front) w.rotation.y = steerAngle;
    }

    if (overlaysActive) {
      const dx = pos.x - playerPos.x;
      const dz = pos.z - playerPos.z;
      if (dx * dx + dz * dz <= range2) {
        this.#worldPos.set(pos.x, pos.y + CAR_TOP + OVERLAY_LIFT, pos.z);
        overlay.update(id, this.#worldPos, layerOut, obs);
      } else {
        overlay.hide(id);
      }
    } else {
      overlay.hide(id);
    }
  }

  /** yaw + ground-normal tilt into the car mesh (matches the kinematic body). */
  #mirror(pos: THREE.Vector3, heading: number, mesh: THREE.Group): void {
    const e = 2.5;
    const x = pos.x;
    const z = pos.z;
    const g = this.#map;
    this.#nrm
      .set(g.effectiveGround(x - e, z) - g.effectiveGround(x + e, z), 2 * e, g.effectiveGround(x, z - e) - g.effectiveGround(x, z + e))
      .normalize();
    this.#qYaw.setFromAxisAngle(this.#up, heading);
    this.#qTilt.setFromUnitVectors(this.#up, this.#nrm).multiply(this.#qYaw);
    mesh.position.copy(pos);
    mesh.quaternion.copy(this.#qTilt);
  }

  /** Raw fleet stats (no HUD-trend side effects) — leader reads the live learner,
   *  a ghost derives from its brain cache. */
  #rawStats(): { count: number; medianSkill: number; totalKm: number; eldestAgeS: number; lessons: number } {
    if (this.#isLeader && this.#learner && this.#fleet) {
      const l = this.#learner;
      const skills: number[] = [];
      let totalM = 0;
      let eldest = 0;
      let lessons = 0;
      for (const car of this.#fleet.cars) {
        skills.push(l.skill(car.id));
        totalM += l.odometer(car.id);
        lessons += l.lessonCount(car.id);
        const a = l.age(car.id);
        if (a > eldest) eldest = a;
      }
      return { count: skills.length, medianSkill: median(skills), totalKm: totalM / 1000, eldestAgeS: eldest, lessons };
    }
    const blobs = [...this.#brainCache.values()];
    if (blobs.length === 0) return { count: 0, medianSkill: 0, totalKm: 0, eldestAgeS: 0, lessons: 0 };
    const skills: number[] = [];
    let totalM = 0;
    let eldest = 0;
    let lessons = 0;
    for (const b of blobs) {
      skills.push(b.rhoBar * 60); // skill ≈ reward-rate/min (rho and skill share units)
      totalM += b.odoM;
      lessons += b.lessons;
      if (b.ageS > eldest) eldest = b.ageS;
    }
    return { count: blobs.length, medianSkill: median(skills), totalKm: totalM / 1000, eldestAgeS: eldest, lessons };
  }

  /** HUD stats incl. the median-skill trend arrow (leader only; ≥10 min data). */
  #lifeStats(): LifeStats {
    const r = this.#rawStats();
    const trend = this.#isLeader && r.count > 0 ? this.#trend(r.medianSkill) : null;
    return { count: r.count, medianSkill: r.medianSkill, totalKm: r.totalKm, eldestAgeS: r.eldestAgeS, trend };
  }

  /** Median-skill trend vs ~10 min ago: 1/-1/0, or null until enough history. */
  #trend(current: number): number | null {
    const now = performance.now() / 1000;
    const s = this.#trendSamples;
    s.push({ t: now, skill: current });
    while (s.length && now - s[0].t > TREND_WINDOW_S * 2) s.shift();
    let base: { t: number; skill: number } | null = null;
    for (const sample of s) {
      if (now - sample.t >= TREND_WINDOW_S) base = sample;
      else break;
    }
    if (base === null) return null;
    const d = current - base.skill;
    return d > TREND_EPS ? 1 : d < -TREND_EPS ? -1 : 0;
  }

  /** Read-only verification snapshot: role + live counts + fleet stats. */
  netDebug(): {
    ready: boolean;
    leader: boolean;
    aliveCars: number;
    ghostCars: number;
    cacheSize: number;
    medianSkill: number;
    totalKm: number;
    eldestAgeS: number;
    lessons: number;
  } {
    let alive = 0;
    let ghost = 0;
    if (this.#fleet) for (const c of this.#fleet.cars) if (c.alive) alive++;
    if (this.#ghosts) for (const g of this.#ghosts.cars) if (g.active) ghost++;
    const r = this.#rawStats();
    return {
      ready: this.#ready,
      leader: this.#isLeader,
      aliveCars: alive,
      ghostCars: ghost,
      cacheSize: this.#brainCache.size,
      medianSkill: r.medianSkill,
      totalKm: r.totalKm,
      eldestAgeS: r.eldestAgeS,
      lessons: r.lessons
    };
  }

  /** Per-car mesh/pose snapshot for headless "no disappearing cars" checks. */
  debugCars(): { id: number; x: number; z: number; speed: number; hasMesh: boolean; visible: boolean }[] {
    const out: { id: number; x: number; z: number; speed: number; hasMesh: boolean; visible: boolean }[] = [];
    if (this.#isLeader && this.#fleet) {
      for (const c of this.#fleet.cars) out.push({ id: c.id, x: c.pos.x, z: c.pos.z, speed: c.speed, hasMesh: !!c.mesh, visible: !!c.mesh && c.mesh.visible });
    } else if (this.#ghosts) {
      for (const g of this.#ghosts.cars) if (g.active) out.push({ id: g.id, x: g.pos.x, z: g.pos.z, speed: g.speed, hasMesh: !!g.mesh, visible: !!g.mesh && g.mesh.visible });
    }
    return out;
  }

  setOverlays(on: boolean): void {
    this.#overlaysOn = on;
    this.#overlay?.setEnabled(on);
  }

  dispose(): void {
    this.#saveLife();
    if (this.#pagehide && typeof window !== "undefined") window.removeEventListener("pagehide", this.#pagehide);
    this.#pagehide = null;
    this.#fleet?.dispose();
    this.#overlay?.dispose();
    this.#chip?.dispose();
    this.#ready = false;
  }
}
